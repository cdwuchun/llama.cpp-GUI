//! 模型递归扫描与 `presets.ini` 读写。
//!
//! 设计要点（方案 §1.2 / §4.3）：
//! - **不改动用户的模型目录结构**：递归扫描任意层级，把结果写成 router 原生的 preset 文件；
//!   不使用 `--models-dir`（实测它只扫描一层，用户的 `<作者>/<模型名>/*.gguf` 会得到 0 个模型）。
//! - 分组规则：同目录里文件名**含 `mmproj`** 的 gguf 是该目录模型的投影文件（不单独成模型）；
//!   同目录还有主模型时，文件名含 `draft` 的按外挂草稿模型处理；`*-000NN-of-000MM.gguf`
//!   视为一个多分片模型；其余主文件各自成为模型。
//! - preset 文件**保留用户手写内容**：更新某个段时只动它涉及的键，注释与未知键原样保留。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// 被清理段的归档
//
// 自动清理失效段时会先把段内容存到这里，而不是直接丢掉：用户过段时间又把同一个模型
// 下载回模型目录，扫描时就能把当初调好的参数（上下文、采样、GPU 相关键…）原样恢复，
// 只把 `model` 指向的路径换成新扫到的那个。恢复成功即从归档里移除。
// ---------------------------------------------------------------------------

static ARCHIVE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

const ARCHIVE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct ArchiveFile {
    version: u32,
    /// 段名 → 归档内容
    sections: BTreeMap<String, ArchiveEntry>,
}

#[derive(Serialize, Deserialize)]
struct ArchiveEntry {
    /// 删除时的段名。改过名的模型段名是别名，恢复时按它把名字还原回去。
    #[serde(default)]
    section: String,
    /// 删除时 `model` 指向的文件名（不含路径）。
    ///
    /// 用来防止"同目录换了另一个模型"被误恢复：扫描 id 是目录相对路径，同一目录里
    /// 把 A.gguf 换成 B.gguf 时 id 不变，但 A 的参数（`spec-draft-model`、`chat-template-file`
    /// 之类指向具体文件的键）套到 B 上是错的。文件名对不上就不恢复。
    #[serde(default)]
    model_file: String,
    removed_at_ms: u64,
    entries: Vec<(String, String)>,
}

impl Default for ArchiveFile {
    fn default() -> Self {
        Self {
            version: ARCHIVE_VERSION,
            sections: BTreeMap::new(),
        }
    }
}

/// preset / 归档文件的读-改-写锁。
///
/// Tauri 命令可能在多个线程上并发执行（`models_scan`、`preset_sync`、`preset_upsert`、
/// `preset_remove`、`preset_import_hub`…），各自的「读全量 → 改 → 写回」交错时会丢失
/// 更新（刚保存的参数被另一个持旧内容的写入覆盖）。所有涉及这两个文件的命令都要先拿它。
pub fn preset_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// 告诉 models 模块归档文件放哪（`None` = 不归档，清理掉的段就真没了）。
pub fn set_archive_path(path: Option<PathBuf>) {
    let _ = ARCHIVE_PATH.set(path);
}

/// 读归档。
///
/// **文件存在但读不出来**（JSON 损坏、版本不符）必须报错而不是当成"空归档"：
/// 后者会让下一次归档写入用空对象覆盖掉全部历史，用户所有被清理过的配置就真没了。
/// 只有"文件不存在"才算空归档。
fn read_archive() -> Result<ArchiveFile> {
    let Some(Some(file)) = ARCHIVE_PATH.get() else {
        return Ok(ArchiveFile::default());
    };
    if !file.exists() {
        return Ok(ArchiveFile::default());
    }
    let text = fs::read_to_string(file)
        .with_context(|| format!("读取归档失败: {}", file.display()))?;
    let archive: ArchiveFile = serde_json::from_str(&text)
        .with_context(|| format!("归档文件损坏: {}（为避免覆盖历史，本次不写入归档）", file.display()))?;
    if archive.version != ARCHIVE_VERSION {
        anyhow::bail!(
            "归档文件版本不符（{} != {}）: {}",
            archive.version,
            ARCHIVE_VERSION,
            file.display()
        );
    }
    Ok(archive)
}

fn write_archive(archive: &ArchiveFile) -> Result<()> {
    let Some(Some(file)) = ARCHIVE_PATH.get() else {
        return Ok(());
    };
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建归档目录失败: {}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(archive).context("序列化归档失败")?;
    // 临时名带 pid + 序号，理由同 `write_preset`：固定用 `json.tmp` 时，两个并发写
    // 会互相截断，先改名的一方还会让另一方的 `rename` 直接失败。
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = file.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    fs::write(&tmp, json).with_context(|| format!("写入归档失败: {}", tmp.display()))?;
    fs::rename(&tmp, file).with_context(|| format!("替换归档失败: {}", file.display()))
}

/// 归档若干被清理掉的段。key 用**扫描 id**（不是段名），恢复时只按扫描 id 查。
///
/// 返回 `Err` 表示没存住 —— 调用方**必须**据此放弃清理，否则段删了、归档也没写，
/// 用户看到的是"清理成功"但配置永久消失。
fn archive_sections(removed: &[(String, String, String, Vec<(String, String)>)]) -> Result<()> {
    if removed.is_empty() {
        return Ok(());
    }
    let mut archive = read_archive()?;
    let now = crate::router::now_ms();
    for (scanned_id, section, model_file, entries) in removed {
        archive.sections.insert(
            scanned_id.clone(),
            ArchiveEntry {
                section: section.clone(),
                model_file: model_file.clone(),
                removed_at_ms: now,
                entries: entries.clone(),
            },
        );
    }
    write_archive(&archive)
}

/// 消费归档条目。
///
/// 必须**在 preset 已经成功写盘之后**才调用：反过来（先删归档再写 preset）一旦
/// 写盘失败就是永久丢失。
fn consume_archived(scanned_id: &str) -> Result<()> {
    let mut archive = read_archive()?;
    if archive.sections.remove(scanned_id).is_none() {
        return Ok(());
    }
    write_archive(&archive)
}

/// 归档里有没有这个模型（按扫描 id 查；只读，供测试与后续扩展用）。
#[allow(dead_code)]
pub fn has_archived(scanned_id: &str) -> bool {
    read_archive()
        .map(|archive| archive.sections.contains_key(scanned_id))
        .unwrap_or(false)
}

/// 失效段清理的结果。
pub struct PruneResult {
    /// 清理后的 preset 文本（没清理时就是原文）。
    pub text: String,
    /// 被删掉的段名。
    pub removed: Vec<String>,
    /// 所有带 `model` 的段都失效 → 疑似模型盘没挂上，**跳过**了清理。
    pub skipped_all_missing: bool,
}

/// 清理「模型文件已经不存在」的 preset 段。
///
/// 判断依据只有一条：段里有 `model` 键、而它指向的 gguf 已经不在了。
/// 这样区分得开两种情况：
/// - 模型被删掉/移走 → 段自动清掉（用户不用手动去删）；
/// - 用户手写的段指向别处的真实文件 → 文件还在，段原样保留；
/// - 完全没有 `model` 键的段一律不碰（不是本应用生成的，可能是用户自己的写法）。
///
/// 被清掉的段会**先归档**（见 [`restore_archived_sections`]），模型重新下载回来时能恢复。
///
/// 两道"别把配置清空"的保护：
/// 1. 任何一个**模型根目录当前不存在**（移动盘没插、网络盘掉线、盘符变了）→ 整轮跳过；
/// 2. 所有段都失效且数量 ≥3 → 也跳过（可能是模型被整体搬走，而不是用户主动删除）。
///
/// 单个模型真的被删掉时（根目录还在、只有它没了）照常清理。
pub fn prune_missing_sections(
    text: &str,
    alias_reverse: &HashMap<String, String>,
    roots: &[PathBuf],
) -> PruneResult {
    let sections = list_sections(text);
    let mut with_model: Vec<(String, PathBuf)> = Vec::new();
    for section in &sections {
        let entries = section_entries(text, section);
        if let Some((_, value)) = entries.iter().find(|(key, _)| key == "model") {
            let value = value.trim();
            if !value.is_empty() {
                with_model.push((section.clone(), PathBuf::from(value)));
            }
        }
    }

    let missing: Vec<(String, PathBuf)> = with_model
        .iter()
        .filter(|(_, path)| !path.is_file())
        .cloned()
        .collect();

    if missing.is_empty() {
        return PruneResult {
            text: text.to_string(),
            removed: Vec::new(),
            skipped_all_missing: false,
        };
    }

    let root_gone = roots
        .iter()
        .any(|root| !root.as_os_str().is_empty() && !root.is_dir());
    let all_missing = missing.len() == with_model.len() && with_model.len() >= 3;
    if root_gone || all_missing {
        return PruneResult {
            text: text.to_string(),
            removed: Vec::new(),
            skipped_all_missing: true,
        };
    }

    let mut pruned = text.to_string();
    let mut removed = Vec::new();
    let mut archived: Vec<(String, String, String, Vec<(String, String)>)> = Vec::new();
    for (section, path) in missing {
        // 先按原文把段内容取出来归档，再删段。
        // 归档 key 用扫描 id：段名可能是用户改过的别名，反查一下，
        // 这样模型重新下载回来时只按扫描 id 就能查到。
        let scanned_id = alias_reverse
            .get(&section)
            .cloned()
            .unwrap_or_else(|| section.clone());
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        archived.push((
            scanned_id,
            section.clone(),
            file_name,
            section_entries(text, &section),
        ));
        pruned = remove_section(&pruned, &section);
        removed.push(section);
    }

    // 归档失败就**不要**清理：宁可留着失效段，也不能让配置凭空消失
    if let Err(err) = archive_sections(&archived) {
        eprintln!("[preset] 归档失败，已放弃本次清理: {err:#}");
        return PruneResult {
            text: text.to_string(),
            removed: Vec::new(),
            skipped_all_missing: false,
        };
    }

    PruneResult {
        text: pruned,
        removed,
        skipped_all_missing: false,
    }
}

/// 为新扫到的模型恢复归档里的段配置。
///
/// 只处理「preset 里还没有这个段、而归档里有记录」的模型 —— 模型重新下载回来后
/// 参数自动回来；从没配过的模型两条都命中不了，行为和以前一致（仍然等用户点
/// 「同步到 presets.ini」，不自动建段）。
/// `model` 键用新扫到的路径覆盖，其余键原样写回。
///
/// 归档条目**不在这里消费**：调用方把 preset 成功写盘后才调
/// [`consume_archived_section`]，否则写盘失败就等于把配置永久删了。
///
/// 性能上**不是**每个模型各扫一遍：早先这里是循环里 `list_sections(&out)` 重扫全文、
/// 每次 `peek_archived` 重读并解析整份归档 JSON，200 个模型就是 200 次全文扫描 +
/// 200 次 JSON 解析，而这段跑在 `preset_lock()` 里，会一直挡着所有 preset 写命令。
/// 现在段名收成一个集合（插入后增量更新）、归档在循环外一次读成内存表 —— 行为不变，
/// 只是把重复解析搬到循环外。
pub fn restore_archived_sections(
    text: &str,
    models: &[ScannedModel],
    aliases: &HashMap<String, String>,
) -> (String, Vec<String>) {
    let mut out = text.to_string();
    let mut restored = Vec::new();

    // 段名匹配一律大小写不敏感：用户手写 `[qwen3-4b]` 而扫描 id 是 `Qwen3-4B` 时，
    // 按原样比较会认不出这是同一个模型，于是又 append 一段 —— router 里就出现两个段
    // 指向同一个 gguf（一个带参数、一个是空段），用户手写的参数从此读不到。
    let mut existing: Vec<String> = list_sections(&out);

    // 归档只读一次：坏掉就整轮不恢复（文件留着等人工处理），绝不当成"空归档"
    // —— 那会让下面的逻辑把每条都当"没归档"跳过，看起来像配置丢了。
    let archive = match read_archive() {
        Ok(archive) => archive.sections,
        Err(err) => {
            eprintln!("[preset] 读取归档失败，本次不恢复任何段（归档文件保持原样）: {err:#}");
            return (out, restored);
        }
    };

    for model in models {
        // 已经有段（按扫描 id 或按别名算）就不用恢复
        let alias = aliases
            .get(&model.id)
            .map(String::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let taken = |existing: &[String], name: &str| {
            existing.iter().any(|s| s.eq_ignore_ascii_case(name))
        };
        if taken(&existing, &model.id) {
            continue;
        }
        if let Some(alias) = alias {
            if taken(&existing, alias) {
                continue;
            }
        }

        // 只按扫描 id 查归档（归档时已经把别名反查成扫描 id 了）
        let Some(entry) = archive.get(&model.id) else {
            continue;
        };

        // 同目录换了另一个模型文件 → 不恢复，避免把旧参数套到新模型上
        if !entry.model_file.is_empty() {
            let current = Path::new(&model.path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if current != entry.model_file {
                continue;
            }
        }

        // 段名：用户当前若还留着别名就用别名，否则用归档时记下的段名
        let section = alias
            .map(str::to_string)
            .or_else(|| (!entry.section.is_empty()).then_some(entry.section.clone()))
            .unwrap_or_else(|| model.id.clone());

        out = ensure_model_section(&out, model, &section);
        let rest: Vec<(String, String)> = entry
            .entries
            .iter()
            .filter(|(key, _)| !key.eq_ignore_ascii_case("model")) // 路径用新扫到的
            .cloned()
            .collect();
        out = upsert_entries(&out, &section, &rest);
        // 刚写进去的段名要立刻并进集合，否则同一个模型名再出现一次就会重复插入
        existing.push(section.clone());
        restored.push(section);
    }

    (out, restored)
}

/// 消费归档条目：**只能在 preset 已经成功写盘之后调用**。
pub fn consume_archived_section(scanned_id: &str) {
    if let Err(err) = consume_archived(scanned_id) {
        eprintln!("[preset] 清理归档条目失败（{scanned_id}）: {err:#}");
    }
}

/// 扫描得到的一个模型。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScannedModel {
    /// preset 段名，同时也是请求里 `model` 字段的取值。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 主 gguf 的绝对路径（正斜杠）。
    pub path: String,
    pub dir: String,
    /// 主文件 + 分片的总字节数。
    pub size_bytes: u64,
    pub quantization: Option<String>,
    /// GGUF 头部里的 `general.architecture`（如 `bert` / `qwen3moe` / `llama`）。
    /// 模型卡片第一项显示的就是它；读不到时为 None。
    pub architecture: Option<String>,
    /// 同目录下的多模态投影文件。
    pub mmproj: Option<String>,
    pub shards: usize,
    pub modified_ms: u64,
    /// 模型根目录名（UI 分组用）。
    pub group: String,
}

/// 扫描结果 + 当前 preset 状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelScanResult {
    pub models: Vec<ScannedModel>,
    /// 辅助文件（多模态投影 / 外挂草稿模型）：不作为模型展示，但参数里可以选。
    #[serde(default)]
    pub aux_files: Vec<AuxFile>,
    pub preset_path: String,
    pub preset_text: String,
    /// preset 中存在、但当前扫描不到的段（多为历史残留或用户手写）。
    pub orphan_sections: Vec<String>,
    /// 本次顺手清理掉的失效段（这些段的模型文件已经不在了）。
    #[serde(default)]
    pub removed_sections: Vec<String>,
    /// 本次从归档里恢复回来的段（模型重新下载回来、参数自动接上）。
    #[serde(default)]
    pub restored_sections: Vec<String>,
    /// 所有带 model 的段都失效 → 疑似模型盘/目录未就绪，本次跳过了清理。
    #[serde(default)]
    pub prune_skipped: bool,
}

/// 一个辅助 gguf 文件：多模态投影文件（mmproj）或外挂草稿模型（draft）。
///
/// 它们**不是**可以直接加载的对话模型，所以不进模型列表；但配置里的
/// 「多模态投影文件」「草稿模型路径」要能选到它们，所以扫描时单独收集。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuxFile {
    /// 绝对路径（正斜杠），也是参数里写入的值。
    pub path: String,
    pub name: String,
    pub dir: String,
    pub size_bytes: u64,
    /// 模型根目录名（UI 分组用）。
    pub group: String,
    /// `mmproj` 或 `draft`。
    pub kind: String,
}

/// 文件名是否是**多模态投影文件**。
///
/// 不能只认开头：两种命名在社区里都常见 ——
/// `mmproj-model-f16.gguf`（投影文件单独一个目录）与
/// `MiniCPM-V-2_6-mmproj-model-f16.gguf`（mmproj 夹在名字中间）。
/// 只认开头的话，后者会被当成一个"模型"列出来，点进去只会加载失败。
pub fn is_mmproj_name(name: &str) -> bool {
    name.to_ascii_lowercase().contains("mmproj")
}

/// 文件名是否是**外挂草稿模型**（推测解码用的小模型）。
pub fn is_draft_name(name: &str) -> bool {
    name.to_ascii_lowercase().contains("draft")
}

// ---------------------------------------------------------------------------
// 扫描结果的落盘缓存
//
// 元数据缓存（上面那套）解决的是"不重复读 GGUF 头"，但**目录遍历 + 逐个文件 stat**
// 仍然每次都要做一遍。这里把上一次的扫描结果整体存盘：
// 启动时直接拿它渲染列表（用户看到的是"秒开"），后端随后**自动重扫一遍**，
// 结果有变化才通知前端刷新 —— 也就是 stale-while-revalidate，用户无感知。
//
// 写入时机：每次完整扫描之后（用户点刷新、改模型目录、同步 preset 等都会走到）。
// ---------------------------------------------------------------------------

/// 扫描缓存文件路径（由 `lib.rs` 在启动时注入；未注入则不落盘）。
static SCAN_CACHE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

const SCAN_CACHE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct ScanCacheFile {
    version: u32,
    /// 生成缓存时的模型根目录（正斜杠）；与当前设置不一致时整个缓存作废。
    roots: Vec<String>,
    saved_at_ms: u64,
    models: Vec<ScannedModel>,
}

/// 告诉 models 模块把扫描结果缓存写到哪（`None` = 不落盘）。
pub fn set_scan_cache_path(path: Option<PathBuf>) {
    let _ = SCAN_CACHE_PATH.set(path);
}

/// 原子落盘：先写**唯一**临时文件，再改名到目标（拷自 `write_preset`）。
///
/// 这里放的是缓存文件，坏掉的代价比 presets.ini 小，但两件事同样会发生：
/// - 直接覆盖写（早先 `gguf-meta-cache.json` 的写法）在半途被杀时留下**半截 JSON**，
///   下次启动量化/架构信息就大面积缺失；
/// - 固定临时名（早先 `models-scan-cache.json` 的写法）在同一份文件被并发写入时
///   会互相截断，rename 也可能失败。
///
/// 加 pid + 序号后，即使两条命令同时写，最坏也只是「后写的赢」，不会写出半截文件。
/// 临时名用 `with_extension` 生成：`models-scan-cache.json` → `…json.<pid>.<seq>.tmp`。
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

/// 读落盘的扫描结果。
///
/// 根目录与请求不一致、**或文件读不动/是半截 JSON**（上次写入途中进程被杀、断电）
/// 都返回 `None` —— 缓存只是加速手段，坏了就当没有、重新扫一遍即可；
/// 这里若返回 `Err`，上层一次 `models_scan` 就会整个失败，模型列表反而出不来。
pub fn load_scan_cache(roots: &[PathBuf]) -> Option<Vec<ScannedModel>> {
    let Some(Some(file)) = SCAN_CACHE_PATH.get() else {
        return None;
    };
    let text = fs::read_to_string(file).ok()?;
    let parsed: ScanCacheFile = serde_json::from_str(&text).ok()?;
    if parsed.version != SCAN_CACHE_VERSION {
        return None;
    }
    let want: Vec<String> = roots.iter().map(|r| to_forward_slash(r)).collect();
    if parsed.roots != want {
        return None;
    }
    Some(parsed.models)
}

/// 把扫描结果落盘（先写临时文件再改名，避免半截文件）。
pub fn save_scan_cache(roots: &[PathBuf], models: &[ScannedModel]) {
    let Some(Some(file)) = SCAN_CACHE_PATH.get() else {
        return;
    };
    let payload = ScanCacheFile {
        version: SCAN_CACHE_VERSION,
        roots: roots.iter().map(|r| to_forward_slash(r)).collect(),
        saved_at_ms: crate::router::now_ms(),
        models: models.to_vec(),
    };
    let Ok(json) = serde_json::to_string(&payload) else {
        eprintln!("[models] 扫描缓存序列化失败（不影响本次扫描结果）");
        return;
    };
    if let Err(err) = write_atomic(file, &json) {
        eprintln!("[models] 扫描缓存写入失败（下次刷新重扫即可）: {err}");
    }
}

fn quant_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)((?:IQ|Q)\d+(?:_[A-Z0-9]+)*|BF16|F16|F32|FP8|NVFP4|MXFP4|MXFP6)")
            .expect("quant regex")
    })
}

fn shard_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?P<prefix>.+)-(?P<idx>\d{5})-of-(?P<total>\d{5})$").expect("shard regex"))
}

fn entry_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*([A-Za-z0-9_.\-]+)\s*=").expect("entry regex"))
}

fn to_forward_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 是否是模型文件（按扩展名判断：文件必须叫 `*.gguf`）。
fn is_gguf(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false)
}

/// 从文件名词干提取量化标识（如 `Q8_0` / `UD-Q6_K_XL` → `Q6_K_XL`）。
pub fn detect_quantization(stem: &str) -> Option<String> {
    quant_re().find(stem).map(|m| m.as_str().to_uppercase())
}

/// 分片文件名 → 所属模型的前缀；非分片返回 `None`。
pub fn shard_prefix(stem: &str) -> Option<String> {
    shard_re().captures(stem).map(|c| c["prefix"].to_string())
}

/// 递归收集目录下的所有 gguf（含子目录）。
///
/// 抽出来是因为模型扫描与辅助文件扫描要用同一套遍历规则：
/// `filter_entry` 对首个条目同样生效，所以深度 0（根目录本身）必须放行 ——
/// 否则根目录叫 `.models` 之类时整个扫描会得到 0 个模型。
fn collect_ggufs(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            !(e.file_type().is_dir() && (name.starts_with('.') || name == "node_modules"))
        })
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && is_gguf(e.path()))
        .map(|e| e.path().to_path_buf())
        .collect()
}

/// 收集辅助文件（多模态投影文件、外挂草稿模型），按路径排序去重。
///
/// 这些文件不列进模型列表，但配置里的「多模态投影文件」「草稿模型路径」要能选到，
/// 所以单独收集一份：连**被忽略的目录**里的也算 ——
/// 例如 `Ornith-ai/mmproj-Ornith-1.5-35B-BF16.gguf` 直接放在作者目录下，
/// 那里没有主模型、不构成模型目录，但它正是给作者目录下那些模型用的投影文件。
pub fn scan_aux_files(roots: &[PathBuf]) -> Vec<AuxFile> {
    let mut out: Vec<AuxFile> = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let group = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| to_forward_slash(root));
        for file in collect_ggufs(root) {
            let name = file
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let kind = if is_mmproj_name(&name) {
                "mmproj"
            } else if is_draft_name(&name) {
                "draft"
            } else {
                continue;
            };
            out.push(AuxFile {
                path: to_forward_slash(&file),
                name,
                dir: file.parent().map(to_forward_slash).unwrap_or_default(),
                size_bytes: file_size(&file),
                group: group.clone(),
                kind: kind.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out
}

/// 递归扫描模型根目录。
pub fn scan_models(roots: &[PathBuf]) -> Vec<ScannedModel> {
    let mut out: Vec<ScannedModel> = Vec::new();
    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let group = root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| to_forward_slash(root));

        // 按「目录 → 该目录下的 gguf」聚合
        let mut per_dir: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
        for file in collect_ggufs(root) {
            if let Some(parent) = file.parent() {
                per_dir.entry(parent.to_path_buf()).or_default().push(file);
            }
        }

        for (dir, files) in per_dir {
            build_models(root, &group, &dir, &files, &mut out);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    // 多个模型根目录下相对路径相同时会撞 id：保留先扫到的那个，但要说出来 ——
    // 静默丢掉会让模型在界面上凭空消失（它的 preset 段还在，router 里也还能看到）。
    let before = out.len();
    out.dedup_by(|a, b| a.id == b.id);
    if out.len() < before {
        eprintln!(
            "[models] 有 {} 个模型因 id 与其它根目录下的模型重名而被忽略（可在设置里调整模型根目录）",
            before - out.len()
        );
    }
    // 本次扫描若新解析了 GGUF 元数据，落盘一次（下次启动就不用再读那十几 MB）
    flush_meta_cache();
    out
}

fn build_models(
    root: &Path,
    group: &str,
    dir: &Path,
    files: &[PathBuf],
    out: &mut Vec<ScannedModel>,
) {
    let name_of = |p: &PathBuf| {
        p.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    // 同目录里只要还有一个"真正的主模型"，`*draft*.gguf` 这类外挂草稿文件就不算模型；
    // 目录里只剩草稿文件时仍按普通模型处理 —— 免得把一个孤立的小模型藏得找不着。
    let has_main = files
        .iter()
        .any(|f| !is_mmproj_name(&name_of(f)) && !is_draft_name(&name_of(f)));

    let mut mmproj: Option<PathBuf> = None;
    let mut mains: Vec<PathBuf> = Vec::new();
    for file in files {
        let name = name_of(file);
        if is_mmproj_name(&name) {
            // 同目录可能有多个 mmproj，取体量最大的（通常对应主模型）
            let better = mmproj
                .as_ref()
                .map(|cur| file_size(file) > file_size(cur))
                .unwrap_or(true);
            if better {
                mmproj = Some(file.clone());
            }
        } else if has_main && is_draft_name(&name) {
            continue; // 外挂草稿模型：进 aux 列表，不作为模型
        } else {
            mains.push(file.clone());
        }
    }
    if mains.is_empty() {
        return; // 只有 mmproj 的目录不构成模型
    }

    // 分片归组
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for file in mains {
        let stem = file
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let key = shard_prefix(&stem).unwrap_or_else(|| stem.clone());
        groups.entry(key).or_default().push(file);
    }

    let multiple = groups.len() > 1;
    let rel_dir = dir
        .strip_prefix(root)
        .unwrap_or(dir)
        .to_string_lossy()
        .replace('\\', "/");
    let rel_dir = rel_dir.trim_matches('/').to_string();

    for (key, mut group_files) in groups {
        group_files.sort();
        let Some(primary) = group_files.first().cloned() else {
            continue;
        };

        // 一次性取回大小与修改时间，避免同一文件 stat 两次
        let mut size_bytes: u64 = 0;
        let mut primary_modified_ms: u64 = 0;
        let mut primary_len: u64 = 0;
        for (index, file) in group_files.iter().enumerate() {
            let (len, modified) = file_meta(file);
            size_bytes += len;
            if index == 0 {
                primary_len = len;
                primary_modified_ms = modified;
            }
        }

        // GGUF 头部元数据（带缓存）：架构名与 file_type 派生的量化。
        // 量化以元数据为准（与 hub 一致，Unsloth 的 UD-Q4_K_XL 会被归一成 Q4_K_M），
        // 元数据缺失时才退回文件名推断。
        let meta = gguf_meta_cached(&primary, primary_len, primary_modified_ms);

        let id = if multiple {
            if rel_dir.is_empty() {
                key.clone()
            } else {
                format!("{rel_dir}/{key}")
            }
        } else if rel_dir.is_empty() {
            key.clone()
        } else {
            rel_dir.clone()
        };

        let name = if multiple {
            key.clone()
        } else if rel_dir.is_empty() {
            key.clone()
        } else {
            dir.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| key.clone())
        };

        out.push(ScannedModel {
            id,
            name,
            path: to_forward_slash(&primary),
            dir: to_forward_slash(dir),
            size_bytes,
            quantization: meta
                .quantization()
                .map(|s| s.to_string())
                .or_else(|| detect_quantization(&key)),
            architecture: meta.architecture.clone(),
            mmproj: mmproj.as_ref().map(|p| to_forward_slash(p)),
            shards: group_files.len(),
            modified_ms: primary_modified_ms,
            group: group.to_string(),
        });
    }
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

/// 一次系统调用同时取回文件大小与修改时间。
fn file_meta(path: &Path) -> (u64, u64) {
    match fs::metadata(path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (meta.len(), modified)
        }
        Err(_) => (0, 0),
    }
}

// ---------------------------------------------------------------------------
// GGUF 头部：读出 general.architecture 与 general.file_type
// ---------------------------------------------------------------------------

/// 最多读多少字节去找这两个键。
///
/// KV 区里最占地方的是 tokenizer 词表数组（实测单个模型最多约 11 MB），
/// `general.file_type` 排在它们之后。给 64 MB 上限是为了不在异常文件上
/// 一路读到文件尾（模型本体是几十 GB）。
const GGUF_META_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// GGUF 值类型：字符串（其余类型在 [`GgufStream::skip_value`] 里按字节宽度处理）。
const GGUF_TYPE_STRING: u32 = 8;

/// GGUF 值类型：UINT32（`general.file_type` 用这个）。
const GGUF_TYPE_U32: u32 = 4;

/// 从 GGUF 头部读到的元数据。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GgufMeta {
    /// `general.architecture`，如 `bert` / `qwen35moe` / `llama`
    pub architecture: Option<String>,
    /// `general.file_type`（llama.cpp `enum llama_ftype` 的取值）
    pub file_type: Option<u32>,
}

impl GgufMeta {
    /// `file_type` → 量化名（如 `Q4_K_M`）。
    ///
    /// `1024` 是 `LLAMA_FTYPE_GUESSED`（文件里没写明确类型），返回 None
    /// 让调用方回退到文件名推断。
    pub fn quantization(&self) -> Option<&'static str> {
        ftype_name(self.file_type?)
    }
}

/// llama.cpp `include/llama.h` 的 `enum llama_ftype` → 量化名。
///
/// 注意 4/5/6 与 33/34/35 是**历史空洞**（已删除的 Q4_2/Q4_3 与运行时重打包项），
/// 不能按下标顺推。
fn ftype_name(file_type: u32) -> Option<&'static str> {
    Some(match file_type {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        7 => "Q8_0",
        8 => "Q5_0",
        9 => "Q5_1",
        10 => "Q2_K",
        11 => "Q3_K_S",
        12 => "Q3_K_M",
        13 => "Q3_K_L",
        14 => "Q4_K_S",
        15 => "Q4_K_M",
        16 => "Q5_K_S",
        17 => "Q5_K_M",
        18 => "Q6_K",
        19 => "IQ2_XXS",
        20 => "IQ2_XS",
        21 => "Q2_K_S",
        22 => "IQ3_XS",
        23 => "IQ3_XXS",
        24 => "IQ1_S",
        25 => "IQ4_NL",
        26 => "IQ3_S",
        27 => "IQ3_M",
        28 => "IQ2_S",
        29 => "IQ2_M",
        30 => "IQ4_XS",
        31 => "IQ1_M",
        32 => "BF16",
        36 => "TQ1_0",
        37 => "TQ2_0",
        38 => "MXFP4_MOE",
        39 => "NVFP4",
        40 => "Q1_0",
        41 => "Q2_0",
        _ => return None,
    })
}

/// GGUF 头部结构：magic `GGUF` + 版本 + tensor 数 + KV 数，随后是若干 KV 对
/// （键是长度前缀字符串，值带类型标签）。
///
/// 解析是**严格顺序**的，所以直接用流式读取：需要跳过的大数组直接丢弃，
/// 不会为了读文件末尾的 `general.file_type` 而把整个 KV 区驻留内存。
pub fn read_gguf_meta(path: &Path) -> GgufMeta {
    let Ok(file) = fs::File::open(path) else {
        return GgufMeta::default();
    };
    let mut stream = GgufStream::new(BufReader::with_capacity(1 << 20, file));
    stream.scan().unwrap_or_default()
}

/// 带缓存的 [`read_gguf_meta`]。
///
/// 解析一个模型最多要顺序读十几 MB（tokenizer 词表挡在 `general.file_type` 前面），
/// 所以按「路径 + 大小 + 修改时间」缓存，重复刷新不再重读；文件一变键就变了，
/// 缓存自然失效。
pub fn gguf_meta_cached(path: &Path, size: u64, modified_ms: u64) -> GgufMeta {
    let key = (path.to_string_lossy().to_string(), size, modified_ms);
    if let Ok(cache) = gguf_cache().lock() {
        if let Some(hit) = cache.get(&key) {
            return hit.clone();
        }
    }

    let meta = read_gguf_meta(path);

    if let Ok(mut cache) = gguf_cache().lock() {
        // 超过上限就整体清空：模型列表通常几十个，不值得做 LRU
        if cache.len() > 4096 {
            cache.clear();
        }
        cache.insert(key, meta.clone());
        META_CACHE_DIRTY.store(true, Ordering::Relaxed);
    }
    meta
}

type GgufCacheKey = (String, u64, u64);

fn gguf_cache() -> &'static Mutex<HashMap<GgufCacheKey, GgufMeta>> {
    static CACHE: OnceLock<Mutex<HashMap<GgufCacheKey, GgufMeta>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// GGUF 元数据的落盘缓存
//
// 解析一个模型最多要顺序读十几 MB（tokenizer 词表挡在 `general.file_type` 前面），
// 17 个模型冷扫描约 0.7 秒。hub 同样把解析结果按模型缓存成 JSON，这里照做：
// 缓存文件只按「路径 + 大小 + 修改时间」命中，文件一变键就变，不会读到旧值。
// ---------------------------------------------------------------------------

/// 缓存文件路径（由 `lib.rs` 在启动时注入；未注入则不落盘，只走内存缓存）。
static META_CACHE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 内存缓存里是否有尚未落盘的条目。
static META_CACHE_DIRTY: AtomicBool = AtomicBool::new(false);

/// 缓存文件版本（不匹配就整份当没有，避免旧格式被当成有效缓存）。
pub const META_CACHE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct MetaCacheFile {
    version: u32,
    entries: Vec<MetaCacheEntry>,
}

#[derive(Serialize, Deserialize)]
struct MetaCacheEntry {
    path: String,
    size: u64,
    modified_ms: u64,
    #[serde(default)]
    architecture: Option<String>,
    #[serde(default)]
    file_type: Option<u32>,
}

/// 告诉 models 模块把元数据缓存写到哪（`None` = 不落盘）。
pub fn set_meta_cache_path(path: Option<PathBuf>) {
    let _ = META_CACHE_PATH.set(path);
    load_meta_cache();
}

/// 解析缓存文件内容；**坏了就返回 `None`**（当缓存不存在），绝不 panic、也不向上报错。
///
/// 抽成纯函数是为了能直接用「半截 JSON」测这条兜底路径：进程在写盘中途被杀会留下
/// 截断的文件，下一次启动必须照常可用（重算元数据），而不是让扫描整个失败。
fn parse_meta_cache(text: &str) -> Option<MetaCacheFile> {
    serde_json::from_str(text).ok()
}

/// 读缓存文件（只成功读一次）。
fn load_meta_cache() {
    let Some(Some(file)) = META_CACHE_PATH.get() else {
        return;
    };
    let loaded = read_meta_cache_file(file);
    let Ok(mut cache) = gguf_cache().lock() else {
        return;
    };
    for (key, meta) in loaded {
        cache.insert(key, meta);
    }
}

/// 把一个元数据缓存文件读成内存表；**任何读取/解析失败都返回空表**，不 panic、不报错。
///
/// 抽出来是为了能直接喂「半截 JSON」测兜底路径：进程在写盘中途被杀（关窗、托盘退出、
/// 任务管理器）会留下截断的文件，下一次启动必须照常可用（元数据重新探测），而不是让
/// 扫描整个失败。缓存只是加速手段，坏了等于没有缓存。
fn read_meta_cache_file(file: &Path) -> HashMap<GgufCacheKey, GgufMeta> {
    let mut loaded: HashMap<GgufCacheKey, GgufMeta> = HashMap::new();
    let Ok(text) = fs::read_to_string(file) else {
        return loaded;
    };
    let Some(parsed) = parse_meta_cache(&text) else {
        eprintln!(
            "[models] 元数据缓存损坏，本次忽略并重算（下次扫描会整份覆盖写回）: {}",
            file.display()
        );
        return loaded;
    };
    // 版本不符也当没有：旧格式的字段含义可能已经变了，宁可从零重算
    if parsed.version != META_CACHE_VERSION {
        eprintln!(
            "[models] 元数据缓存版本不符（{} != {}），已忽略: {}",
            parsed.version,
            META_CACHE_VERSION,
            file.display()
        );
        return loaded;
    }
    for entry in parsed.entries {
        loaded.insert(
            (entry.path, entry.size, entry.modified_ms),
            GgufMeta {
                architecture: entry.architecture,
                file_type: entry.file_type,
            },
        );
    }
    loaded
}

/// 有新增条目时把缓存写回磁盘（一次扫描结束调用一次即可）。
///
/// **原子替换**：早先这里是直接 `fs::write(file, …)` 覆盖写，进程在写盘中途被结束
/// （关窗/托盘退出/任务管理器）就会留下半截 JSON，下次启动量化与架构信息大面积缺失，
/// 直到重新探测。现在写唯一临时文件再 rename，半截内容永远不会成为正式文件。
pub fn flush_meta_cache() {
    if !META_CACHE_DIRTY.swap(false, Ordering::Relaxed) {
        return;
    }
    let Some(Some(file)) = META_CACHE_PATH.get() else {
        return;
    };
    let Ok(cache) = gguf_cache().lock() else {
        return;
    };
    let payload = MetaCacheFile {
        version: META_CACHE_VERSION,
        entries: cache
            .iter()
            .map(|((path, size, modified_ms), meta)| MetaCacheEntry {
                path: path.clone(),
                size: *size,
                modified_ms: *modified_ms,
                architecture: meta.architecture.clone(),
                file_type: meta.file_type,
            })
            .collect(),
    };
    drop(cache);

    let Ok(text) = serde_json::to_string(&payload) else {
        eprintln!("[models] 元数据缓存序列化失败（下次扫描重算即可）");
        return;
    };
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    // 写失败不影响功能（缓存只是加速手段，下次扫描还会重算元数据并再试一次），
    // 但**不要静默**：磁盘满、权限问题会一直复现，日志是唯一线索。
    if let Err(err) = write_atomic(file, &text) {
        eprintln!(
            "[models] 元数据缓存写入失败（本次丢弃，下次扫描重算）: {}: {err}",
            file.display()
        );
    }
}

/// 顺序读取 GGUF KV 区的小游标：读完或超预算即返回 `None`，不 panic。
///
/// 关键点：**跳过的字节不构造 `String`**。词表是十几万个字符串，早先的实现
/// 对每个元素都 `from_utf8_lossy` 生成一个 String，光分配和 UTF-8 校验就让
/// 17 个模型的冷扫描花掉 2.4 秒；只读长度前缀再按字节丢弃后降到百毫秒级。
struct GgufStream<R: Read> {
    reader: R,
    used: u64,
    /// 丢弃数据用的复用缓冲，避免每次跳过都分配
    scratch: Vec<u8>,
}

impl<R: Read> GgufStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            used: 0,
            scratch: vec![0u8; 64 * 1024],
        }
    }

    /// 精确读取 `len` 字节；同时累加预算。
    fn take(&mut self, len: u64) -> Option<Vec<u8>> {
        self.used = self.used.checked_add(len)?;
        if self.used > GGUF_META_MAX_BYTES {
            return None;
        }
        let mut buf = vec![0u8; usize::try_from(len).ok()?];
        self.reader.read_exact(&mut buf).ok()?;
        Some(buf)
    }

    /// 读 4 字节到栈上（不分配）。词表有几十万个元素，每个都要读一次定长字段，
    /// 这里的分配开销会被放大成秒级。
    fn u32(&mut self) -> Option<u32> {
        let mut buf = [0u8; 4];
        self.read_exact_budgeted(&mut buf)?;
        Some(u32::from_le_bytes(buf))
    }

    fn u64(&mut self) -> Option<u64> {
        let mut buf = [0u8; 8];
        self.read_exact_budgeted(&mut buf)?;
        Some(u64::from_le_bytes(buf))
    }

    fn read_exact_budgeted(&mut self, buf: &mut [u8]) -> Option<()> {
        self.used = self.used.checked_add(buf.len() as u64)?;
        if self.used > GGUF_META_MAX_BYTES {
            return None;
        }
        self.reader.read_exact(buf).ok()
    }

    /// 丢弃 `len` 字节：读进复用缓冲后丢掉，不分配。
    fn skip(&mut self, len: u64) -> Option<()> {
        self.used = self.used.checked_add(len)?;
        if self.used > GGUF_META_MAX_BYTES {
            return None;
        }
        let mut left = len;
        while left > 0 {
            let want = left.min(self.scratch.len() as u64) as usize;
            let read = self.reader.read(&mut self.scratch[..want]).ok()?;
            if read == 0 {
                return None; // 提前 EOF
            }
            left -= read as u64;
        }
        Some(())
    }

    fn string(&mut self) -> Option<String> {
        let len = self.u64()?;
        let raw = self.take(len)?;
        Some(String::from_utf8_lossy(&raw).into_owned())
    }

    /// 按类型标签跳过一个值；`depth` 防止嵌套数组造成无限递归。
    ///
    /// 字符串（含字符串数组的每个元素）只读 8 字节长度前缀，内容直接丢弃。
    fn skip_value(&mut self, value_type: u32, depth: u32) -> Option<()> {
        if depth > 4 {
            return None;
        }
        match value_type {
            0 | 1 | 7 => self.skip(1),
            2 | 3 => self.skip(2),
            4 | 5 | 6 => self.skip(4),
            10 | 11 | 12 => self.skip(8),
            8 => {
                let len = self.u64()?;
                self.skip(len)
            }
            9 => {
                let element_type = self.u32()?;
                let count = self.u64()?;
                match element_type {
                    // 字符串元素长度不固定，只能逐个读长度前缀再跳过
                    8 => {
                        for _ in 0..count {
                            self.skip_value(element_type, depth + 1)?;
                        }
                        Some(())
                    }
                    // 定长元素可以整块丢弃
                    _ => {
                        let width = match element_type {
                            0 | 1 | 7 => 1u64,
                            2 | 3 => 2,
                            4 | 5 | 6 => 4,
                            10 | 11 | 12 => 8,
                            _ => return None,
                        };
                        self.skip(width.checked_mul(count)?)
                    }
                }
            }
            _ => None,
        }
    }

    /// 扫 KV 区（凑齐两个目标键就提前结束）。
    fn scan(&mut self) -> Option<GgufMeta> {
        if self.take(4)? != *b"GGUF" {
            return None;
        }
        let version = self.u32()?;
        // v1 的计数是 u32，v2 起是 u64
        let (_tensor_count, kv_count) = if version == 1 {
            (self.u32()? as u64, self.u32()? as u64)
        } else {
            (self.u64()?, self.u64()?)
        };

        let mut meta = GgufMeta::default();
        for _ in 0..kv_count {
            let key = self.string()?;
            let value_type = self.u32()?;
            match key.as_str() {
                "general.architecture" if value_type == GGUF_TYPE_STRING => {
                    meta.architecture = self.string();
                }
                "general.file_type" if value_type == GGUF_TYPE_U32 => {
                    meta.file_type = self.u32();
                }
                _ => self.skip_value(value_type, 0)?,
            }
            if meta.architecture.is_some() && meta.file_type.is_some() {
                break;
            }
        }
        Some(meta)
    }
}

// ---------------------------------------------------------------------------
// presets.ini 读写（字符串级操作，尽可能保留用户手写内容）
// ---------------------------------------------------------------------------

/// 列出文件中的所有段名（不含 `[*]`）。
pub fn list_sections(text: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in text.lines() {
        if let Some(name) = section_header(line) {
            if name != "*" {
                names.push(name);
            }
        }
    }
    names
}

fn section_header(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with('[') {
        return None;
    }
    let end = trimmed.find(']')?;
    let name = trimmed[1..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// 找到段的起始行与结束行（`[start, end)`，以行索引计）。
///
/// **段名按大小写不敏感比较**（`list_sections` 返回的仍是磁盘上原始大小写）。
/// 用户手写 `[qwen3-4b]` 而扫描出的 id 是 `Qwen3-4B` 时，精确比较会认不出这是同一个
/// 模型，于是同步 preset 又 append 一段 —— router 里就出现两个段指向同一个 gguf
/// （一个带参数、一个是空段）。段名重复时只认**第一个**，与 router 的
/// 「同名段后者清空前者」并不一致，见 [`upsert_entries`] 里的说明。
fn section_bounds(lines: &[&str], section: &str) -> Option<(usize, usize)> {
    let start = lines
        .iter()
        .position(|l| section_header(l).map_or(false, |name| name.eq_ignore_ascii_case(section)))?;
    let end = lines
        .iter()
        .enumerate()
        .skip(start + 1)
        .find(|(_, l)| section_header(l).is_some())
        .map(|(i, _)| i)
        .unwrap_or(lines.len());
    Some((start, end))
}

/// **删除/归档专用**的行区间（`[start, end)`，以行索引计）。
///
/// 与 [`section_bounds`] 的唯一区别：尾部不吞「段尾的空行与写在下一个段头上方的注释」，
/// 收敛到段内**最后一个非空且非注释行**之后。
///
/// 为什么必须单独算：`section_bounds` 的 `end` 是下一个段头，于是 `[A]` 与 `[B]` 之间
/// 的空行、以及写在 `[B]` 上面的注释（用户手写、说明这一段的用途）都落在 A 的区间里。
/// 删/归档 A 时一起带走，而归档只保存 `键 = 值`（见 [`section_entries`]，它跳过空行与
/// `#`/`;` 注释）—— 用户的注释就此**永久丢失**，模型下回来恢复时也补不回来。
///
/// 区间收敛后，那些空行与注释归下一个段所有：`[B]` 头上方的注释仍在原地。
/// 段内全是空行/注释（没有任何键）时区间为空（`start == end`），此时只删段头那一行。
fn section_removal_bounds(lines: &[&str], section: &str) -> Option<(usize, usize)> {
    let (start, end) = section_bounds(lines, section)?;
    let last_content = lines[start + 1..end]
        .iter()
        .rposition(|l| !is_blank_or_comment(l))
        .map(|i| start + 1 + i);
    let end = match last_content {
        Some(last) => last + 1,
        // 段里除了段头什么都没有：只删段头，别把后面的空行/注释一起吃掉
        None => start + 1,
    };
    Some((start, end))
}

/// 空行，或 ini 注释行（`#` / `;` 开头）。
///
/// 只有这两种行算「可以留给下一个段」的尾部内容。不认识的行（比如用户写得不成样子的
/// `xxx`）不算：那可能是段内容的一部分，删段时一并带走更干净。
fn is_blank_or_comment(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';')
}

/// 读取某个段内的键值对。
pub fn section_entries(text: &str, section: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let Some((start, end)) = section_bounds(&lines, section) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in &lines[start + 1..end] {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        if let Some(caps) = entry_re().captures(line) {
            let key = caps[1].to_string();
            let value = line
                .split_once('=')
                .map(|(_, v)| v.trim().to_string())
                .unwrap_or_default();
            out.push((key, value));
        }
    }
    out
}

/// 写入/更新某个段内的键值对，保留该段中未被涉及的键与注释。
///
/// 段不存在时追加到文件末尾。
///
/// 三条来自 llama.cpp `common/preset.cpp` 的实测语义（改动前踩过的坑都在这）：
///
/// 1. **一个键在段内只能留一行**。router 把段存成 `std::map`，visitor 里是
///    `parsed[section][key] = value`，同名键**后出现的覆盖先出现的**。所以「保留旧行、
///    只把新值写进第一条」是错的：用户把 `temp` 从 0.5 改成 0.9，磁盘上成了
///    `temp = 0.9` 紧跟 `temp = 0.5`，router 读到的还是 0.5 —— 界面改了参数、模型行为
///    不变。这里把段内该键的**所有**旧行都吃掉，只留一条新行，位置用第一次出现的地方
///    （参数顺序不跳动，用户看到的还是原来的排列）。
/// 2. **键名统一写成小写**。router 的选项表里键名是长参数名（`temp`、`ctx-size`），
///    查表大小写敏感，`Temp = 0.9` 会走到 "option 'Temp' not recognized in preset"；
///    而 `*_ARG_*` 环境变量名（大写）既不是 ini 里该写的形态，也不是长参数名。
///    所以界面给的键与文件里已有的同名键都按小写比较、按小写写回 ——
///    同一个参数不会以两种写法存在两条。
/// 3. **同名段只认第一个**（[`section_bounds`] 取首个匹配）：用户手写了两段同名时，
///    GUI 只改第一段，而 router 侧是「后者把前者整个清空」（每遇到段头就
///    `parsed[current_section] = {}`）。两者行为不一致，但 GUI 侧重复建段本身就是错的，
///    这里选择不动用户没让改的那一段。
pub fn upsert_entries(text: &str, section: &str, entries: &[(String, String)]) -> String {
    let mut lines: Vec<String> = if text.is_empty() {
        vec!["version = 1".to_string(), String::new()]
    } else {
        text.lines().map(|l| l.to_string()).collect()
    };

    // 同一批 entries 里同名键也只写一行：后一个值胜出（与 router 的"后者覆盖"一致），
    // 位置取该键第一次出现的位置，不搬到段尾。
    let mut merged: Vec<(String, String)> = Vec::with_capacity(entries.len());
    for (k, v) in entries {
        let key = k.trim().to_ascii_lowercase();
        match merged.iter().position(|(mk, _)| *mk == key) {
            Some(pos) => merged[pos].1 = v.clone(),
            None => merged.push((key, v.clone())),
        }
    }

    let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
    match section_bounds(&refs, section) {
        Some((start, end)) => {
            // 每个键只换一次：None 表示"这个键还没处理过"，Some(pos) 表示新行已写在
            // `replaced[pos]`。`appended_key` 决定段内没出现过的键追加到哪里 —— 有替换过
            // 键时紧跟在最后一个被替换的键之后（保持原参数顺序），一个都没换时才落到段尾。
            let mut slot: Vec<Option<usize>> = vec![None; merged.len()];
            let mut appended_key: Option<usize> = None;
            let mut replaced: Vec<String> = Vec::with_capacity(end - start - 1);
            for line in &lines[start + 1..end] {
                let key = entry_re()
                    .captures(line)
                    .map(|c| c[1].to_ascii_lowercase());
                match key {
                    Some(key) => match merged.iter().position(|(k, _)| *k == key) {
                        Some(pos) => {
                            // 这个键的**每一行**旧内容都吃掉，包括后出现的重复键
                            if slot[pos].is_none() {
                                let (k, v) = &merged[pos];
                                if !v.trim().is_empty() {
                                    // 空值表示删除该键
                                    slot[pos] = Some(replaced.len());
                                    replaced.push(format!("{k} = {v}"));
                                }
                                // 删键时不占位：slot 仍是 None，但后面同一键的行照样被吃掉
                            }
                        }
                        None => replaced.push(line.clone()),
                    },
                    None => replaced.push(line.clone()),
                }
            }
            for (pos, (k, v)) in merged.iter().enumerate() {
                if slot[pos].is_none() && !v.trim().is_empty() {
                    let at = match appended_key {
                        Some(last) => {
                            appended_key = Some(last + 1);
                            last + 1
                        }
                        None => {
                            appended_key = Some(replaced.len());
                            replaced.len()
                        }
                    };
                    replaced.insert(at, format!("{k} = {v}"));
                }
            }

            let mut result: Vec<String> = Vec::with_capacity(lines.len() + 4);
            result.extend_from_slice(&lines[..=start]);
            // 丢掉段头后紧跟的空行，保持紧凑
            let mut body: Vec<String> = replaced;
            while body.first().map(|l| l.trim().is_empty()).unwrap_or(false) {
                body.remove(0);
            }
            while body.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
                body.pop();
            }
            result.extend(body);
            result.push(String::new());
            result.extend_from_slice(&lines[end..]);
            lines = result;
        }
        None => {
            if lines.last().map(|l| !l.trim().is_empty()).unwrap_or(false) {
                lines.push(String::new());
            }
            lines.push(format!("[{section}]"));
            for (k, v) in &merged {
                if !v.trim().is_empty() {
                    lines.push(format!("{k} = {v}"));
                }
            }
            lines.push(String::new());
        }
    }

    // 去掉文件末尾多余空行，保证以换行结束
    while lines.len() > 1 && lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// 删除一个段。
///
/// 用 [`section_removal_bounds`]（不是 `section_bounds`）：段尾的空行与写在下一个段头上方的
/// 注释归下一个段所有，删这一段不能顺手带走 —— 归档只存 `键 = 值`，注释丢了就找不回来。
pub fn remove_section(text: &str, section: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let Some((start, end)) = section_removal_bounds(&lines, section) else {
        return text.to_string();
    };
    let mut kept: Vec<String> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if i >= start && i < end {
            continue;
        }
        kept.push(line.to_string());
    }
    while kept.len() > 1 && kept.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// 确保某个模型在 preset 中有对应段（存在则只校正 `model` 路径）。
/// 确保该模型在 preset 里有一段。
///
/// `section` 是段名，默认传 `model.id`；用户改过别名时传别名 —— 否则"同步 preset"
/// 会按扫描 id 再建一段，改名后的模型就出现两个段。
pub fn ensure_model_section(text: &str, model: &ScannedModel, section: &str) -> String {
    let mut entries: Vec<(String, String)> = Vec::new();
    if let Some(mmproj) = &model.mmproj {
        // 多模态：目录内的 mmproj 会被 router 自动识别，这里仅在需要时显式声明
        let _ = mmproj;
    }
    entries.push(("model".to_string(), model.path.clone()));
    upsert_entries(text, section, &entries)
}

/// 读取 preset 文件（不存在则返回最小内容）。
pub fn read_preset(path: &Path) -> Result<String> {
    if !path.exists() {
        return Ok("version = 1\n".to_string());
    }
    fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))
}

/// 写入 preset 文件（自动创建父目录）。
///
/// **原子替换**：presets.ini 是用户配置的唯一载体，就地截断写一旦崩溃/断电就会留下
/// 半截文件，而 `read_preset` 只判 `exists()`，会把它当成"从没配过"，用户的调参就没了。
/// 所以先写临时文件、留一份 `.bak`、再改名。
pub fn write_preset(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建目录 {} 失败", parent.display()))?;
    }
    // 临时名带 pid + 序号：固定用 `presets.ini.tmp` 时，两个并发写会互相截断，
    // 先改名的一方还会让另一方的 rename 直接失败。加序号后，即使某条命令漏了
    // `preset_lock()`，最坏也只是"后写的赢"，不会把半截内容 rename 成正式文件。
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("ini.{}.{seq}.tmp", std::process::id()));
    fs::write(&tmp, content).with_context(|| format!("写入 {} 失败", tmp.display()))?;
    if path.exists() {
        // 留一版上一状态，人工误操作后还能救回来
        let _ = fs::copy(path, path.with_extension("ini.bak"));
    }
    fs::rename(&tmp, path).with_context(|| format!("替换 {} 失败", path.display()))
}

/// 已经被 llama.cpp 淘汰的 preset 键：写回时**直接丢掉**（不做等价转换）。
///
/// 留着的代价是**整个 router 起不来**，而不是只有那一段失效：
/// `failed to initialize router models: option 'X' not recognized in preset 'Y'`。
///
/// - `no-mmap`：新版用 `--load-mode` 取代（`none` = 不用 mmap）后移除了这个开关。
pub const RETIRED_PRESET_KEYS: &[&str] = &["no-mmap"];

/// 把 hub 风格（也是本应用历史遗留）的 `spec-type_X` 键并回 `spec-type`。
///
/// hub 的 UI 把 ngram-mod / ngram-map-k4v 做成独立勾选项、flag 写成 `--spec-type_ngram-mod`，
/// 我们的参数表一度照搬，于是 preset 里出现 `spec-type_ngram-mod = true`。
/// llama.cpp 读 preset 时这是**未知选项**，会让 `/models?reload=1` 直接返回 500
///（"option 'spec-type_ngram-mod' not recognized"），界面上报「读取 router 模型列表失败」，
/// 该段的子实例也起不来。
///
/// `--spec-type` 支持**逗号多值**（llama.cpp 的处理函数就是 `string_split(value, ',')`），
/// 且 ngram-mod 本来就要能和 draft-mtp 之类的草稿类型共存，所以合并时是**追加**而不是覆盖，
/// 并按顺序去重；伪键值为假时只是丢掉该键。
///
/// 顺带**删除已淘汰的参数名**：新版 llama.cpp 移除了 `--no-mmap`（改用 `--load-mode`），
/// 旧键留在 preset 里，新版会**直接拒绝启动 router**：
/// `failed to initialize router models: option 'no-mmap' not recognized in preset 'X'`
/// —— 一个模型段里的一个过期键，会让所有模型都用不了。这里直接丢掉，不做等价转换。
pub fn sanitize_preset_keys(text: &str) -> String {
    // None 表示这一行要删掉（占位回填用）
    let mut out: Vec<Option<String>> = Vec::new();
    let mut spec_pos: Option<usize> = None;
    let mut values: Vec<String> = Vec::new();
    // 当前段里已经出现过的键 → 该键那一行在 `out` 里的位置（换段清空）
    let mut kv_pos: HashMap<String, usize> = HashMap::new();

    let read_value = |line: &str| -> String {
        line.split_once('=')
            .map(|(_, v)| v.trim().to_string())
            .unwrap_or_default()
    };
    let push_value = |values: &mut Vec<String>, raw: &str| {
        for part in raw.split(',') {
            let part = part.trim();
            if !part.is_empty() && !values.iter().any(|v| v == part) {
                values.push(part.to_string());
            }
        }
    };

    let flush = |out: &mut Vec<Option<String>>, spec_pos: &mut Option<usize>, values: &mut Vec<String>| {
        match spec_pos.take() {
            Some(pos) => {
                if values.is_empty() {
                    out[pos] = None;
                } else {
                    out[pos] = Some(format!("spec-type = {}", values.join(",")));
                }
            }
            // 段里**只有**伪键、没有真的 `spec-type` 行时，`spec_pos` 是 None：合并出来的
            // 值必须在这里新建一行，否则 `flush` 什么都不做，值就随着 `values.clear()`
            // 一起消失 —— 用户勾上的 ngram-mod 在界面上是选中、写盘后却没写出去。
            // 追加在当前行号处：段内的参数顺序保持原样（新键落在段尾）。
            None => {
                if !values.is_empty() {
                    out.push(Some(format!("spec-type = {}", values.join(","))));
                }
            }
        }
        values.clear();
    };

    for line in text.lines() {
        let trimmed = line.trim();
        // 段边界：先把上一段合并结果落定
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            flush(&mut out, &mut spec_pos, &mut values);
            out.push(Some(line.to_string()));
            // 键名去重是按段算的：换段就把账清了
            kv_pos.clear();
            continue;
        }
        if let Some(caps) = entry_re().captures(line) {
            // 键名统一按小写比较、按小写回写：router 的选项表键名就是长参数名
            // （`temp` / `ctx-size`），查表**大小写敏感**，`Temp` 会被当成未知选项。
            // 见 [`upsert_entries`] 的说明。
            let key = caps[1].to_ascii_lowercase();
            if key == "spec-type" || key.starts_with("spec-type_") {
                // `spec-type_X` 是 hub 的伪键，`spec-type` 是真键，两者都要并成一条
                match key.strip_prefix("spec-type_") {
                    // 伪键：真值并进 `spec-type` 的值列表，原行一律不保留
                    Some(rest) => {
                        if is_truthy(&read_value(line)) {
                            push_value(&mut values, rest);
                        }
                    }
                    // 真键：值记进列表，位置留个占位行，等落段时回填
                    None => {
                        // 同一段里出现重复的 `spec-type` 时只留一条（router 取后者）。
                        // 上一次的占位行置空删掉 —— 不删就会留下一个空行，而且 `flush`
                        // 只回填最后那个占位。
                        if let Some(prev) = kv_pos.insert(key.clone(), out.len()) {
                            out[prev] = None;
                        }
                        spec_pos = Some(out.len());
                        out.push(Some(String::new()));
                        push_value(&mut values, &read_value(line));
                    }
                }
                continue;
            }
            // 已淘汰的参数：留着会让 router 起不来，直接丢掉整行
            if RETIRED_PRESET_KEYS.contains(&key.as_str()) {
                continue;
            }
            // `webui` 与 `no-webui` 是同一个开关的两种写法（llama.cpp 会把取值为假的
            // flag 换成它的否定别名）。参数表用的是 hub 的键名 `no-webui`，这里统一过去：
            //   webui = false/0  → no-webui = true（显式关闭）
            //   webui = true/1   → 删掉（等于默认：自带界面开）
            // 之前一版界面用的是 `webui` 键，用户勾过"关闭"的段会残留 `webui = false`，
            // 结果子实例没有界面、而配置里又找不到对应开关。
            if key == "webui" {
                if !is_truthy(&read_value(line)) {
                    out.push(Some("no-webui = true".to_string()));
                }
                continue;
            }
            // 其余键：键名统一成小写（router 查表大小写敏感），同一段内同名键只留最后一条。
            //
            // 只改键名那一段的字符，等号右边的值和用户写的空格原样保留 —— 用户的文件不该
            // 因为我们"顺手规范化"而整体重排。同名键保留**最后一条的值**、并放在最后一条的
            // 位置上：router 的解析是 `parsed[section][key] = value`（后写覆盖先写），
            // 这样文本里的先后 = router 的取值先后，不会出现"界面显示新值、实际跑旧值"。
            let canonical = lower_key(line, &caps);
            let at = out.len();
            if let Some(prev) = kv_pos.insert(key.clone(), at) {
                out[prev] = None;
            }
            out.push(Some(canonical));
            // 必须 `continue`：这一行的规范形态已经写进 `out`，再走一遍循环末尾的
            // `out.push(line)` 就会把原行**又追加一次**（`to_lowercase` 没改动的行看起来
            // 完全一样），结果是整个 preset 的每个键都写了两遍 —— 文件体积翻倍，而且
            // 重复键在 router 里是"后者覆盖"，语义上就靠"两行同值"侥幸不出错。
            continue;
        }
        out.push(Some(line.to_string()));
    }
    flush(&mut out, &mut spec_pos, &mut values);

    let mut joined = out
        .into_iter()
        .flatten()
        .collect::<Vec<String>>()
        .join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// preset 里表示"开"的值（llama.cpp 的 flag 类选项：真则输出 `--key`，假则整条不输出）。
fn is_truthy(value: &str) -> bool {
    !matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "" | "0" | "false" | "no" | "off"
    )
}

/// 只把 `键 = 值` 里**键名那一段**改成小写，等号右边的值、缩进与空格全部原样保留。
///
/// 不整行 `to_lowercase()`：值可能是路径（Windows 路径大小写不敏感，但用户写的形态
/// 不该被我们改），也可能是模板名之类的字符串。
fn lower_key(line: &str, caps: &Captures<'_>) -> String {
    let Some(m) = caps.get(1) else {
        return line.to_string();
    };
    let mut out = String::with_capacity(line.len());
    out.push_str(&line[..m.start()]);
    out.push_str(&m.as_str().to_ascii_lowercase());
    out.push_str(&line[m.end()..]);
    out
}

// ---------- 从 llama.cpp-hub 迁移模型启动参数 ----------
//
// hub 把每个模型的启动参数存在 `<hub>/config/launch_config.json` 里：
//   { "<模型名>": { "configs": { "<配置名>": { "cmd": "--ctx-size 4096 ...",
//                                            "extraParams": "--pooling cls" } },
//                   "selectedConfig": "<配置名>" } }
// 这里把它翻译成 presets.ini 段里的 `键 = 值`。hub 的 cmd 就是给 llama-server 的参数，
// 所以键名天然等于 llama.cpp 的选项名（去掉 `--`）。三点注意：
// 1. `--port` / `--host` / `--model` / `--no-webui` 等由 router 与应用自己管理，必须丢掉；
// 2. hub 对"可选值"参数用 `--spec-type_ngram-mod` 这种下划线写法（全库仅此一例），
//    要拆回 `spec-type = ngram-mod`；
// 3. 布尔开关写 `key = true` —— llama.cpp 的 preset 解析里 flag 类选项值为假则整条不输出、
//    为真则只输出 `--key`，所以 true 是正确写法（`webui = 0` 同理表示不输出）。
//
// 刻意不迁移 hub 的 `device` / `mg`（按模型绑定显卡）：本应用的显卡分配是全局设置，
// 迁过来会把模型钉死在单卡上，与"多卡都要能被模型使用"的要求冲突。

/// hub 的 `launch_config.json` 里单个配置。
#[derive(Debug, Default, Deserialize)]
struct HubConfig {
    #[serde(default)]
    cmd: String,
    #[serde(rename = "extraParams", default)]
    extra_params: String,
}

/// hub 里一个模型的全部配置。
#[derive(Debug, Default, Deserialize)]
struct HubEntry {
    #[serde(default)]
    configs: BTreeMap<String, HubConfig>,
    #[serde(rename = "selectedConfig", default)]
    selected_config: Option<String>,
}

/// 迁移结果，回给界面显示。
#[derive(Debug, Default, Serialize)]
pub struct HubImportReport {
    pub hub_path: String,
    /// presets.ini 里的段总数
    pub total: usize,
    /// 在 hub 里找到配置并写入的段数
    pub matched: usize,
    /// 写入的键值对条数
    pub entries: usize,
    /// hub 里没有对应配置的模型
    pub missing: Vec<String>,
}

/// 这些参数由 router（端口/模型路径/别名）或应用自身（自带 UI）管理，不能从 hub 带过来。
const HUB_DROPPED_ARGS: &[&str] = &[
    "--port",
    "--host",
    "--model",
    "--alias",
    "--api-key",
    "--no-webui",
    "--webui",
    "--no-ui",
    "--ui",
    "--models-max",
    "--models-preset",
    "--models-dir",
    "--log-file",
];

/// 按 shell 习惯切分参数串（支持双引号路径，如 `--chat-template-file "E:\..\a.jinja"`）。
fn tokenize_args(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in text.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// 把 llama-server 风格的参数列表翻成 preset 的键值对。
///
/// `--spec-type` 支持逗号多值，hub 又把它拆成 `--spec-type` + `--spec-type_ngram-mod`
/// 两种写法；这里统一合并成**一条** `spec-type = a,b`（顺序保留、去重），
/// 否则 preset 里会出现重复键（llama.cpp 的 preset 是 map，只会保留一个）。
fn entries_from_hub_args(args: &[String]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !arg.starts_with("--") {
            i += 1;
            continue;
        }
        let has_value = i + 1 < args.len() && !args[i + 1].starts_with("--");
        if HUB_DROPPED_ARGS.contains(&arg.as_str()) {
            i += if has_value { 2 } else { 1 };
            continue;
        }
        // `--spec-type_ngram-mod` → 并入 spec-type 的多值列表
        if let Some((flag, value)) = arg.split_once('_') {
            if flag == "--spec-type" {
                merge_spec_type(&mut out, value);
                i += 1;
                continue;
            }
        }
        let key = arg.trim_start_matches("--").to_string();
        if key == "spec-type" {
            let value = if has_value { args[i + 1].clone() } else { String::new() };
            for part in value.split(',') {
                merge_spec_type(&mut out, part.trim());
            }
            i += if has_value { 2 } else { 1 };
            continue;
        }
        if has_value {
            out.push((key, args[i + 1].clone()));
            i += 2;
        } else {
            // 布尔开关：值为 true 时 llama.cpp 只输出 `--key`
            out.push((key, "true".to_string()));
            i += 1;
        }
    }
    out
}

/// 把单个 spec-type 取值并入（必要时新建）`spec-type` 条目，顺序保留、去重。
fn merge_spec_type(out: &mut Vec<(String, String)>, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    match out.iter_mut().find(|(k, _)| k == "spec-type") {
        Some((_, existing)) => {
            if !existing.split(',').any(|v| v.trim() == value) {
                if !existing.is_empty() {
                    existing.push(',');
                }
                existing.push_str(value);
            }
        }
        None => out.push(("spec-type".to_string(), value.to_string())),
    }
}

/// 在 hub 里找某个模型（先全名，再忽略作者前缀的名字，均忽略大小写）的参数。
fn hub_entries_for(
    hub: &BTreeMap<String, HubEntry>,
    section: &str,
) -> Option<Vec<(String, String)>> {
    let base = section.rsplit('/').next().unwrap_or(section);
    let value = hub
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(section))
        .or_else(|| hub.iter().find(|(name, _)| name.eq_ignore_ascii_case(base)))
        .map(|(_, v)| v)?;
    let cfg = value
        .selected_config
        .as_ref()
        .and_then(|name| value.configs.get(name))
        .or_else(|| value.configs.values().next())?;
    let mut args = tokenize_args(&cfg.cmd);
    args.extend(tokenize_args(&cfg.extra_params));
    Some(entries_from_hub_args(&args))
}

/// 把 hub 的参数合并进 preset 文本。返回（新文本, 报告）。
pub fn import_hub_presets(preset: &str, hub_config: &Path) -> Result<(String, HubImportReport)> {
    let raw = fs::read_to_string(hub_config)
        .with_context(|| format!("读取 {} 失败", hub_config.display()))?;
    let hub: BTreeMap<String, HubEntry> = serde_json::from_str(&raw)
        .with_context(|| format!("解析 {} 失败", hub_config.display()))?;

    let mut text = preset.to_string();
    let mut report = HubImportReport {
        hub_path: hub_config.display().to_string(),
        ..Default::default()
    };
    for section in list_sections(preset) {
        report.total += 1;
        match hub_entries_for(&hub, &section) {
            Some(entries) if !entries.is_empty() => {
                report.matched += 1;
                report.entries += entries.len();
                text = upsert_entries(&text, &section, &entries);
            }
            _ => report.missing.push(section),
        }
    }
    Ok((text, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓存路径 / 归档路径都是**进程级**的 OnceLock，涉及它们的测试必须串行跑，
    /// 否则并行执行时会互相踩（归档文件被另一个测试改写）。
    static GLOBAL_STATE_LOCK: Mutex<()> = Mutex::new(());

    fn lock_global_state() -> std::sync::MutexGuard<'static, ()> {
        GLOBAL_STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sample_model(id: &str) -> ScannedModel {
        ScannedModel {
            id: id.to_string(),
            name: id.rsplit('/').next().unwrap_or(id).to_string(),
            path: format!("E:/AI/models/{id}/model.gguf"),
            dir: format!("E:/AI/models/{id}"),
            size_bytes: 1024,
            quantization: Some("Q8_0".into()),
            architecture: Some("llama".into()),
            mmproj: None,
            shards: 1,
            modified_ms: 1,
            group: "models".into(),
        }
    }

    /// 扫描结果落盘缓存：往返一致；根目录一变就作废（避免换了模型目录还拿旧列表）
    #[test]
    fn scan_cache_round_trip_and_roots_guard() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-scan-cache-test");
        let _ = fs::remove_dir_all(&dir);
        let root = dir.join("models");
        fs::create_dir_all(root.join("OpenBMB/MiniCPM5-2B")).unwrap();
        set_scan_cache_path(Some(dir.join("models-scan-cache.json")));

        let roots = vec![root.clone()];
        assert!(load_scan_cache(&roots).is_none(), "首次应无缓存");

        let models = vec![sample_model("OpenBMB/MiniCPM5-2B"), sample_model("Qwen/Qwen3-4B")];
        save_scan_cache(&roots, &models);
        assert_eq!(load_scan_cache(&roots).unwrap(), models);

        // 反斜杠写法要能命中（设置里存的是 Windows 原生分隔符）
        let backslash = vec![PathBuf::from(root.to_string_lossy().replace('/', "\\"))];
        assert_eq!(load_scan_cache(&backslash).unwrap().len(), 2);

        // 换了根目录 → 整个缓存作废
        assert!(load_scan_cache(&[dir.join("other")]).is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 失效段清理：模型文件没了 → 段删掉；文件还在 / 没有 model 键 → 原样保留
    #[test]
    fn prune_removes_sections_whose_model_is_gone() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-prune-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let alive = touch(&dir.join("alive.gguf"), 16);
        let gone = dir.join("gone.gguf"); // 故意不创建

        let text = format!(
            "version = 1\n\n[Alive]\nmodel = {}\n\n[Gone]\nmodel = {}\n\n[Handwritten]\ntemp = 0.7\n",
            alive.to_string_lossy().replace('\\', "/"),
            gone.to_string_lossy().replace('\\', "/"),
        );

        let result = prune_missing_sections(&text, &HashMap::new(), &[]);
        assert_eq!(result.removed, vec!["Gone".to_string()]);
        assert!(!result.skipped_all_missing);
        assert!(result.text.contains("[Alive]"), "文件还在的段不能删");
        assert!(!result.text.contains("[Gone]"), "文件没了的段应删掉");
        assert!(result.text.contains("[Handwritten]"), "没有 model 键的段一律不碰");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 全部段都失效时（多半是模型盘没挂上）跳过清理，避免把配置清空
    #[test]
    fn prune_skips_when_every_model_is_missing() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-prune-all-missing");
        let missing = dir.join("nope.gguf");
        let path = missing.to_string_lossy().replace('\\', "/");
        let text = format!(
            "version = 1\n\n[A]\nmodel = {path}\n\n[B]\nmodel = {path}\n\n[C]\nmodel = {path}\n"
        );

        let result = prune_missing_sections(&text, &HashMap::new(), &[]);
        assert!(result.removed.is_empty());
        assert!(result.skipped_all_missing);
        assert_eq!(result.text, text, "跳过时必须原文返回");
    }

    /// 归档 → 恢复：模型删了又下回来，段配置要能接上（且 model 路径用新扫到的）
    #[test]
    fn archived_section_restores_after_model_comes_back() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-archive-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        set_archive_path(Some(dir.join("removed-preset-sections.json")));

        // 扫描结果里的主文件路径（sample_model 用的是虚构路径，正好表示"文件不在"）
        let scanned = vec![sample_model("Unsloth/Qwen3-4B")];
        let path = scanned[0].path.clone();

        // 1) 用户配好了这个模型（段里的 model 指向同一个文件）
        let user_tuned =
            format!("version = 1\n\n[Unsloth/Qwen3-4B]\nmodel = {path}\nctx-size = 32768\ntemp = 0.6\n");

        // 2) 模型文件不在了 → 清理时归档
        let pruned = prune_missing_sections(&user_tuned, &HashMap::new(), &[]);
        assert_eq!(pruned.removed, vec!["Unsloth/Qwen3-4B".to_string()]);
        assert!(!pruned.text.contains("ctx-size"), "段已被清掉");
        assert!(has_archived("Unsloth/Qwen3-4B"), "清理掉的段必须进归档");

        // 3) 模型重新下载回来 → 扫描时恢复（新路径，旧参数）
        let (restored_text, restored) =
            restore_archived_sections(&pruned.text, &scanned, &HashMap::new());
        assert_eq!(restored, vec!["Unsloth/Qwen3-4B".to_string()]);
        assert!(restored_text.contains("[Unsloth/Qwen3-4B]"));
        assert!(restored_text.contains("ctx-size = 32768"), "旧参数要接回来");
        assert!(restored_text.contains("temp = 0.6"));
        assert!(
            restored_text.contains(&scanned[0].path),
            "model 键要用新扫到的路径覆盖：{restored_text}"
        );

        // 4) 恢复动作本身不消费归档（消费要等 preset 真的写盘成功）
        assert!(has_archived("Unsloth/Qwen3-4B"));
        consume_archived_section("Unsloth/Qwen3-4B");
        assert!(!has_archived("Unsloth/Qwen3-4B"), "写盘后才消费归档");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 同一目录换了另一个模型文件（扫描 id 相同）时**不能**恢复旧参数：
    /// 旧配置里可能含 `spec-draft-model` / `chat-template-file` 这种指向具体文件的键。
    #[test]
    fn archived_section_is_not_restored_for_a_different_file() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-archive-swap-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        set_archive_path(Some(dir.join("removed-preset-sections.json")));

        let old_path = dir.join("Old-Model-Q8_0.gguf");
        let tuned = format!(
            "version = 1\n\n[Unsloth/Qwen3-4B]\nmodel = {}\nctx-size = 32768\n",
            old_path.to_string_lossy().replace('\\', "/")
        );
        let pruned = prune_missing_sections(&tuned, &HashMap::new(), &[]);
        assert_eq!(pruned.removed.len(), 1);
        assert!(has_archived("Unsloth/Qwen3-4B"));

        // 同一目录里换成了另一个模型文件
        let mut swapped = sample_model("Unsloth/Qwen3-4B");
        swapped.path = dir
            .join("New-Model-Q4_K_M.gguf")
            .to_string_lossy()
            .replace('\\', "/");
        let (text, restored) = restore_archived_sections(&pruned.text, &[swapped], &HashMap::new());
        assert!(restored.is_empty(), "文件名对不上不该恢复: {text}");
        assert!(!text.contains("ctx-size"), "不该把旧参数套上来");
        assert!(has_archived("Unsloth/Qwen3-4B"), "归档要留着等原文件回来");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 改过名的模型：段名是别名，但归档 key 必须是扫描 id ——
    /// 这样模型重新下载回来（扫描 id 不变、别名也还在）时，只按扫描 id 就能查回来
    #[test]
    fn archived_section_uses_scanned_id_as_key() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-archive-alias-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        set_archive_path(Some(dir.join("removed-preset-sections.json")));

        let scanned_id = "Ornith-ai/Cyber-Tiel-Coder-35B-A3B-MTPv2-23G-ICE";
        let alias = "Ornith-ai/Cyber-Tiel-Coder-35B-A3B";
        let model_file = dir.join("model.gguf");
        let path = model_file.to_string_lossy().replace('\\', "/");

        // 用户改过名后，preset 里是别名段
        let tuned = format!("version = 1\n\n[{alias}]\nmodel = {path}\nctx-size = 65536\n");
        let mut aliases = HashMap::new();
        aliases.insert(scanned_id.to_string(), alias.to_string());
        let alias_reverse: HashMap<String, String> = aliases
            .iter()
            .map(|(k, v)| (v.clone(), k.clone()))
            .collect();

        // 模型被删 → 清理并归档（key 落到扫描 id 上）
        fs::remove_file(&model_file).ok();
        let pruned = prune_missing_sections(&tuned, &alias_reverse, &[]);
        assert_eq!(pruned.removed, vec![alias.to_string()]);
        assert!(has_archived(scanned_id), "归档 key 必须是扫描 id，而不是别名");

        // 模型重新下载 → 按扫描 id 命中，段名还原成别名
        touch(&model_file, 32);
        let scanned = vec![ScannedModel {
            id: scanned_id.to_string(),
            ..sample_model(scanned_id)
        }];
        let (restored_text, restored) = restore_archived_sections(&pruned.text, &scanned, &aliases);
        assert_eq!(restored, vec![alias.to_string()], "恢复出来的段名应是用户的别名");
        assert!(restored_text.contains(&format!("[{alias}]")));
        assert!(restored_text.contains("ctx-size = 65536"));

        let _ = fs::remove_dir_all(&dir);
    }

    fn touch(path: &Path, bytes: usize) -> PathBuf {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, vec![0u8; bytes]).unwrap();
        path.to_path_buf()
    }

    // ---- GGUF 头部解析 ----

    /// 按 GGUF 规则拼一个头部：magic/版本/计数 + 若干 KV。
    /// v1 的计数是 u32，v2 起是 u64（与解析端保持一致）。
    fn gguf_bytes(kvs: &[(&str, u32, &[u8])], version: u32) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"GGUF");
        out.extend_from_slice(&version.to_le_bytes());
        if version == 1 {
            out.extend_from_slice(&1u32.to_le_bytes()); // tensor 数
            out.extend_from_slice(&(kvs.len() as u32).to_le_bytes());
        } else {
            out.extend_from_slice(&1u64.to_le_bytes());
            out.extend_from_slice(&(kvs.len() as u64).to_le_bytes());
        }
        for (key, ty, value) in kvs {
            out.extend_from_slice(&(key.len() as u64).to_le_bytes());
            out.extend_from_slice(key.as_bytes());
            out.extend_from_slice(&ty.to_le_bytes());
            out.extend_from_slice(value);
        }
        out
    }

    fn gguf_string(value: &str) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&(value.len() as u64).to_le_bytes());
        out.extend_from_slice(value.as_bytes());
        out
    }

    fn write_gguf(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join("llamacpp-gui-gguf-test");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn gguf_architecture_is_read_from_first_kv() {
        let arch = gguf_string("qwen3moe");
        let path = write_gguf(
            "a.gguf",
            &gguf_bytes(&[("general.architecture", 8, &arch)], 3),
        );
        assert_eq!(
            read_gguf_meta(&path).architecture.as_deref(),
            Some("qwen3moe")
        );
    }

    #[test]
    fn gguf_architecture_survives_leading_values_and_arrays() {
        // 架构之前先放一个整数、一个字符串、一个字符串数组，验证跳过逻辑
        let mut arr = Vec::new();
        arr.extend_from_slice(&GGUF_TYPE_STRING.to_le_bytes()); // 元素类型
        arr.extend_from_slice(&2u64.to_le_bytes()); // 元素个数
        arr.extend_from_slice(&gguf_string("tokenizer.ggml.model"));
        arr.extend_from_slice(&gguf_string("llama"));

        let arch = gguf_string("bert");
        let path = write_gguf(
            "b.gguf",
            &gguf_bytes(
                &[
                    ("general.file_type", 4, &30u32.to_le_bytes()),
                    ("general.name", 8, &gguf_string("bge-m3")),
                    ("tokenizer.ggml.tokens", 9, &arr),
                    ("general.architecture", 8, &arch),
                ],
                3,
            ),
        );
        let meta = read_gguf_meta(&path);
        assert_eq!(meta.architecture.as_deref(), Some("bert"));
        assert_eq!(meta.file_type, Some(30));
    }

    #[test]
    fn gguf_file_type_behind_a_large_token_array_is_found() {
        // file_type 排在词表数组之后（真实文件的顺序），且数组远大于读缓冲
        let mut tokens = Vec::new();
        tokens.extend_from_slice(&GGUF_TYPE_STRING.to_le_bytes());
        tokens.extend_from_slice(&20_000u64.to_le_bytes());
        for i in 0..20_000 {
            tokens.extend_from_slice(&gguf_string(&format!("tok{i}")));
        }

        let path = write_gguf(
            "e.gguf",
            &gguf_bytes(
                &[
                    ("general.architecture", 8, &gguf_string("qwen35moe")),
                    ("tokenizer.ggml.tokens", 9, &tokens),
                    ("general.file_type", 4, &15u32.to_le_bytes()),
                ],
                3,
            ),
        );
        let meta = read_gguf_meta(&path);
        assert_eq!(meta.architecture.as_deref(), Some("qwen35moe"));
        assert_eq!(meta.quantization(), Some("Q4_K_M"));
    }

    #[test]
    fn gguf_meta_handles_v1_and_broken_files() {
        let arch = gguf_string("llama");
        let v1 = write_gguf(
            "v1.gguf",
            &gguf_bytes(&[("general.architecture", 8, &arch)], 1),
        );
        assert_eq!(read_gguf_meta(&v1).architecture.as_deref(), Some("llama"));

        // 不是 GGUF / 键不存在 / 类型不对 / 文件不存在，都返回空而不是报错
        let plain = write_gguf("plain.gguf", b"not a gguf file at all");
        assert_eq!(read_gguf_meta(&plain), GgufMeta::default());

        let missing = write_gguf(
            "c.gguf",
            &gguf_bytes(&[("general.name", 8, &gguf_string("x"))], 3),
        );
        assert_eq!(read_gguf_meta(&missing), GgufMeta::default());

        let wrong_type = write_gguf(
            "d.gguf",
            &gguf_bytes(&[("general.architecture", 4, &7u32.to_le_bytes())], 3),
        );
        assert_eq!(read_gguf_meta(&wrong_type).architecture, None);

        assert_eq!(
            read_gguf_meta(Path::new("Z:/definitely/missing.gguf")),
            GgufMeta::default()
        );
    }

    #[test]
    fn ftype_names_match_llama_cpp_enum() {
        // 抽查真机数据里出现过的取值 + 历史空洞不能顺推
        assert_eq!(ftype_name(1), Some("F16"));
        assert_eq!(ftype_name(7), Some("Q8_0"));
        assert_eq!(ftype_name(15), Some("Q4_K_M"));
        assert_eq!(ftype_name(17), Some("Q5_K_M"));
        assert_eq!(ftype_name(18), Some("Q6_K"));
        assert_eq!(ftype_name(39), Some("NVFP4"));
        assert_eq!(ftype_name(4), None); // 已删除的 Q4_1_SOME_F16
        assert_eq!(ftype_name(5), None); // 已删除的 Q4_2
        assert_eq!(ftype_name(1024), None); // LLAMA_FTYPE_GUESSED
        assert_eq!(ftype_name(9999), None);
    }

    #[test]
    fn gguf_meta_cache_returns_same_result() {
        let path = write_gguf(
            "cache.gguf",
            &gguf_bytes(
                &[
                    ("general.architecture", 8, &gguf_string("bert")),
                    ("general.file_type", 4, &7u32.to_le_bytes()),
                ],
                3,
            ),
        );
        let (size, modified) = file_meta(&path);
        let first = gguf_meta_cached(&path, size, modified);
        let second = gguf_meta_cached(&path, size, modified);
        assert_eq!(first, second);
        assert_eq!(first.quantization(), Some("Q8_0"));

        // 大小/时间变了就是新键（缓存失效），仍然能读出正确结果
        let changed = gguf_meta_cached(&path, size + 1, modified + 1);
        assert_eq!(changed.architecture.as_deref(), Some("bert"));
    }

    #[test]
    fn quantization_and_shard_parsing() {        assert_eq!(detect_quantization("MiniCPM5-2B-Q8_0").as_deref(), Some("Q8_0"));
        assert_eq!(
            detect_quantization("Hy-MT2-1.8B-UD-Q6_K_XL").as_deref(),
            Some("Q6_K_XL")
        );
        assert_eq!(detect_quantization("model-BF16").as_deref(), Some("BF16"));
        assert_eq!(detect_quantization("no-quant-here"), None);

        assert_eq!(
            shard_prefix("Kimi-K2-Thinking-UD-IQ1_S-00001-of-00006").as_deref(),
            Some("Kimi-K2-Thinking-UD-IQ1_S")
        );
        assert_eq!(shard_prefix("plain-model"), None);
    }

    #[test]
    fn scan_groups_multimodal_and_shards() {
        let root = std::env::temp_dir().join("llamacpp-gui-scan-test");
        let _ = fs::remove_dir_all(&root);

        // 单文件模型：<作者>/<模型名>/<文件>.gguf
        touch(&root.join("OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf"), 100);
        // 多模态：同目录含 mmproj
        touch(&root.join("OpenBMB/MiniCPM-V-4.6/MiniCPM-V-4_6-F16.gguf"), 200);
        touch(&root.join("OpenBMB/MiniCPM-V-4.6/mmproj-model-f16.gguf"), 50);
        // 多分片
        let shard_dir = root.join("Kimi/K2");
        touch(&shard_dir.join("K2-UD-IQ1_S-00001-of-00002.gguf"), 10);
        touch(&shard_dir.join("K2-UD-IQ1_S-00002-of-00002.gguf"), 20);
        // 同目录两个不同模型
        touch(&root.join("Unsloth/Hy-MT2/Hy-MT2-1.8B-UD-Q6_K_XL.gguf"), 30);
        touch(&root.join("Unsloth/Hy-MT2/Hy-MT2-7B-Q4_K_M.gguf"), 40);
        // 只有 mmproj 的目录应被忽略
        touch(&root.join("Orphan/mmproj-only.gguf"), 5);

        let models = scan_models(&[root.clone()]);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();

        assert!(ids.contains(&"OpenBMB/MiniCPM5-2B"), "ids={ids:?}");
        assert!(ids.contains(&"OpenBMB/MiniCPM-V-4.6"), "ids={ids:?}");
        assert!(ids.contains(&"Kimi/K2"), "ids={ids:?}");
        assert!(ids.contains(&"Unsloth/Hy-MT2/Hy-MT2-1.8B-UD-Q6_K_XL"), "ids={ids:?}");
        assert!(ids.contains(&"Unsloth/Hy-MT2/Hy-MT2-7B-Q4_K_M"), "ids={ids:?}");
        assert!(!ids.iter().any(|i| i.contains("Orphan")), "只有 mmproj 的目录应被忽略");

        let multimodal = models.iter().find(|m| m.id == "OpenBMB/MiniCPM-V-4.6").unwrap();
        assert!(multimodal.mmproj.is_some());
        assert_eq!(multimodal.shards, 1);

        let sharded = models.iter().find(|m| m.id == "Kimi/K2").unwrap();
        assert_eq!(sharded.shards, 2);
        assert_eq!(sharded.size_bytes, 30);
        assert_eq!(sharded.quantization.as_deref(), Some("IQ1_S"));

        let _ = fs::remove_dir_all(&root);
    }

    /// 投影文件与草稿模型的自动识别：
    /// - mmproj 夹在名字中间（`xxx-mmproj-f16.gguf`）也要认出来，不能当成一个"模型"；
    /// - 同目录有主模型时，`*draft*.gguf` 是外挂草稿模型，不列为主模型；
    /// - 目录里只剩草稿文件时仍按普通模型处理（否则一个孤立的小模型会被藏起来）；
    /// - 两类文件都要进 aux 列表，配置弹窗里才选得到（含"只有 mmproj 的目录"里的）。
    #[test]
    fn scan_recognizes_mmproj_and_draft_files() {
        let root = std::env::temp_dir().join("llamacpp-gui-scan-aux-test");
        let _ = fs::remove_dir_all(&root);

        touch(&root.join("AuthorA/VL-model/VL-model-F16.gguf"), 300);
        touch(&root.join("AuthorA/VL-model/VL-model-mmproj-f16.gguf"), 60);
        touch(&root.join("AuthorA/VL-model/VL-model-draft-Q4.gguf"), 40);
        // 只有 mmproj 的目录照样不构成模型，但投影文件要能被选到
        touch(&root.join("AuthorB/mmproj-Ornith-1.5-9B-BF16.gguf"), 70);
        // 孤立的草稿文件目录：仍按普通模型处理
        touch(&root.join("AuthorC/draft-only-small.gguf"), 80);

        let models = scan_models(&[root.clone()]);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"AuthorA/VL-model"), "ids={ids:?}");
        assert!(ids.contains(&"AuthorC"), "孤立草稿模型不该被藏起来：ids={ids:?}");
        assert!(!ids.iter().any(|i| i.contains("AuthorB")), "只有 mmproj 的目录不构成模型");
        assert_eq!(ids.len(), 2, "草稿文件不该额外变成一个模型：ids={ids:?}");

        let vl = models.iter().find(|m| m.id == "AuthorA/VL-model").unwrap();
        assert_eq!(
            vl.mmproj.as_deref().map(|p| p.rsplit('/').next().unwrap_or(p)),
            Some("VL-model-mmproj-f16.gguf"),
            "夹在名字中间的 mmproj 也要认出来"
        );

        let aux = scan_aux_files(&[root.clone()]);
        let kind_of = |name: &str| {
            aux.iter()
                .find(|a| a.name == name)
                .map(|a| a.kind.as_str())
                .unwrap_or("")
        };
        assert_eq!(kind_of("VL-model-mmproj-f16.gguf"), "mmproj");
        assert_eq!(kind_of("mmproj-Ornith-1.5-9B-BF16.gguf"), "mmproj", "被忽略目录里的也要收进来");
        assert_eq!(kind_of("VL-model-draft-Q4.gguf"), "draft");
        assert_eq!(kind_of("draft-only-small.gguf"), "draft");
        assert_eq!(kind_of("VL-model-F16.gguf"), "", "主模型不该进 aux 列表");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn mmproj_and_draft_name_detection() {        assert!(is_mmproj_name("mmproj-model-f16.gguf"));
        assert!(is_mmproj_name("MiniCPM-V-2_6-mmproj-model-f16.gguf"));
        assert!(is_mmproj_name("MMPROJ-F16.GGUF"));
        assert!(!is_mmproj_name("Qwen3-4B-Q8_0.gguf"));

        assert!(is_draft_name("Qwen3-0.6B-draft-Q8_0.gguf"));
        assert!(is_draft_name("Draft-Model.gguf"));
        // MTP 是模型自带的投机头，不是外挂草稿模型
        assert!(!is_draft_name("Ornith-1.5-9B-MTP-Q6_K.gguf"));
    }

    #[test]
    fn preset_roundtrip_keeps_user_content() {        let original = "\
version = 1

; 用户手写注释
[*]
ctx-size = 32768
n-gpu-layers = 99

[MiniCPM5-2B]
model = E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf
temp = 0.7
# 保留我自己的注释
my-custom-key = keep-me
";

        // 只更新 model 与 temp，其他键/注释必须保留
        let updated = upsert_entries(
            original,
            "MiniCPM5-2B",
            &[
                ("model".into(), "E:/new/path/model.gguf".into()),
                ("temp".into(), "0.9".into()),
            ],
        );

        assert!(updated.contains("ctx-size = 32768"));
        assert!(updated.contains("n-gpu-layers = 99"));
        assert!(updated.contains("; 用户手写注释"));
        assert!(updated.contains("# 保留我自己的注释"));
        assert!(updated.contains("my-custom-key = keep-me"));
        assert!(updated.contains("model = E:/new/path/model.gguf"));
        assert!(updated.contains("temp = 0.9"));
        assert!(!updated.contains("temp = 0.7"));
        assert_eq!(list_sections(&updated), vec!["MiniCPM5-2B"]);

        // 新增段
        let added = upsert_entries(&updated, "New-Model", &[("model".into(), "E:/x.gguf".into())]);
        assert!(added.contains("[New-Model]"));
        assert!(added.contains("model = E:/x.gguf"));
        assert_eq!(list_sections(&added), vec!["MiniCPM5-2B", "New-Model"]);

        // 读取段内容
        let entries = section_entries(&added, "New-Model");
        assert_eq!(entries, vec![("model".to_string(), "E:/x.gguf".to_string())]);

        // 删除段
        let removed = remove_section(&added, "New-Model");
        assert!(!removed.contains("[New-Model]"));
        assert!(removed.contains("[MiniCPM5-2B]"));
        assert_eq!(list_sections(&removed), vec!["MiniCPM5-2B"]);
    }

    /// 删段不能吃掉写在**下一个段头上方**的注释（M3）。
    ///
    /// `section_bounds` 的区间尾部是下一个段头，于是 `[A]` 与 `[B]` 之间的空行与注释都算在
    /// A 头上。删 A 时一起带走，而归档只存 `键 = 值`（`section_entries` 跳过 `#`/`;` 行），
    /// 用户的注释就此永久丢失。这里断言：删掉前一段后，后一段头上的注释仍在原地。
    #[test]
    fn remove_section_keeps_comments_above_next_section() {
        static INI: &str = "\
version = 1

[Alive]
model = E:/a.gguf

# [Gone] 的注释：说明这一段的用途
; 第二行注释
[Gone]
model = E:/gone.gguf

; [Handwritten] 的注释
[Handwritten]
temp = 0.7
";
        let out = remove_section(INI, "Gone");
        assert!(out.contains("# [Gone] 的注释：说明这一段的用途"), "{out}");
        assert!(out.contains("; 第二行注释"), "{out}");
        assert!(!out.contains("model = E:/gone.gguf"), "段内容要删掉：{out}");
        assert!(!out.contains("[Gone]\n"), "{out}");
        assert_eq!(list_sections(&out), vec!["Alive", "Handwritten"]);

        // 段内的注释（写在段头与键之间）不算尾部内容，应随段一起删掉
        let tuned = "\
[Alive]
model = E:/a.gguf

[Gone]
# 段内注释，属于这一段
model = E:/gone.gguf

[Handwritten]
temp = 0.7
";
        let out = remove_section(tuned, "Gone");
        assert!(out.contains("[Handwritten]"), "{out}");
        assert!(!out.contains("# 段内注释"), "{out}");
    }

    /// 归档路径同样不能吃掉下一个段头上方的注释（M3 的另一半）。
    #[test]
    fn prune_keeps_comments_above_next_section() {
        let _guard = lock_global_state();
        let dir = std::env::temp_dir().join("llamacpp-gui-prune-comment-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let alive = touch(&dir.join("alive.gguf"), 8);
        let gone = dir.join("gone.gguf"); // 故意不创建

        let text = format!(
            "version = 1\n\n[Alive]\nmodel = {}\n\n# 这一行注释是写给 [Handwritten] 的\n[Handwritten]\ntemp = 0.7\n\n[Gone]\nmodel = {}\n",
            alive.to_string_lossy().replace('\\', "/"),
            gone.to_string_lossy().replace('\\', "/"),
        );
        let result = prune_missing_sections(&text, &HashMap::new(), &[]);
        assert_eq!(result.removed, vec!["Gone".to_string()]);
        assert!(result.text.contains("[Handwritten]"), "{}", result.text);
        assert!(
            result.text.contains("# 这一行注释是写给 [Handwritten] 的"),
            "被清理段的尾部注释属于下一个段：{}",
            result.text
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// 段名匹配大小写不敏感（M10）。
    ///
    /// 用户手写 `[qwen3-4b]` 而扫描出来的 id 是 `Qwen3-4B` 时，精确比较会认不出这是同一个
    /// 模型，同步 preset 就再 append 一段 —— router 里两个段指向同一个 gguf。断言：各种写法
    /// 都被当作同一段（不新增第二段），而 `list_sections` 仍返回磁盘上的原始大小写。
    #[test]
    fn section_name_matching_is_case_insensitive() {
        let text = "version = 1\n\n[Qwen3-4B]\nmodel = E:/a.gguf\ntemp = 0.7\n";
        assert_eq!(
            section_entries(text, "qwen3-4b"),
            vec![
                ("model".to_string(), "E:/a.gguf".to_string()),
                ("temp".to_string(), "0.7".to_string())
            ]
        );

        // upsert 用另一种大小写 → 命中同一个段并更新，绝不新增段
        let out = upsert_entries(text, "QWEN3-4b", &[("temp".into(), "0.9".into())]);
        assert_eq!(list_sections(&out), vec!["Qwen3-4B"], "{out}");
        assert!(out.contains("temp = 0.9"), "{out}");
        assert_eq!(out.matches("[Qwen3-4B]").count(), 1, "{out}");

        // 大小写不同的段名只认第一个（router 侧同名段是"后者清空前者"，见函数注释）
        let two = "version = 1\n\n[Qwen3-4B]\ntemp = 0.7\n\n[qwen3-4b]\ntemp = 0.2\n";
        let out = upsert_entries(two, "qwen3-4b", &[("temp".into(), "0.9".into())]);
        assert_eq!(list_sections(&out).len(), 2, "{out}");
        assert_eq!(out.matches("temp = 0.9").count(), 1, "{out}");
        assert!(out.contains("temp = 0.2"), "第二段原样不动：{out}");
    }

    /// 段内重复键必须合并成一条（M9）。
    ///
    /// router 把段存成 `std::map`，同名键**后出现的覆盖先出现的**。早先 `upsert_entries`
    /// 每个键只消费一次，第二次出现的同名键落进 `else` 原样保留 → 界面把 `temp` 从 0.5 改成
    /// 0.9 后磁盘上是 `temp = 0.9` 紧跟 `temp = 0.5`，router 读到的还是 0.5：用户改了参数、
    /// 模型行为不变。断言：写完之后该键在段内**只剩一行**且是新值。
    ///
    /// 顺带覆盖键名规范化：router 的选项表键名是长参数名，查表大小写敏感，
    /// `Temp` 会走到 "option 'Temp' not recognized in preset"。
    #[test]
    fn upsert_merges_duplicate_keys_and_lowercases_key() {
        let text = "version = 1\n\n[A/B]\nmodel = E:/a.gguf\ntemp = 0.5\nctx-size = 4096\ntemp = 0.6\n";
        let out = upsert_entries(text, "A/B", &[("temp".into(), "0.9".into())]);
        assert_eq!(out.matches("temp =").count(), 1, "{out}");
        assert_eq!(out.matches("temp = 0.9").count(), 1, "{out}");
        assert!(!out.contains("temp = 0.5"), "{out}");
        assert!(!out.contains("temp = 0.6"), "{out}");
        // 写盘前的第二道（大小写也统一掉）跑完之后，仍然是"一条、新值"
        let cleaned = sanitize_preset_keys(&out);
        assert_eq!(cleaned.matches("temp =").count(), 1, "{cleaned}");
        assert!(cleaned.contains("temp = 0.9"), "{cleaned}");
        // 保留下来的那一条落在**第一次出现**的位置上：`upsert_entries` 只重写自己接到的键，
        // 重排整段会让用户的参数顺序跳来跳去；而"最后一条生效"的 router 语义由键名合并
        // 本身保证（段内只剩一条，值就是新值）。写盘前还有 `sanitize_preset_keys` 兜底。
        let body: Vec<&str> = out.lines().skip(3).collect();
        assert_eq!(
            body,
            vec!["model = E:/a.gguf", "temp = 0.9", "ctx-size = 4096"],
            "{out}"
        );

        // 文件里已有的键写成大写 → 同一个键认出来、并写回小写规范形式
        let upper = "version = 1\n\n[A/B]\nmodel = E:/a.gguf\nTemp = 0.5\n";
        let out = upsert_entries(upper, "A/B", &[("temp".into(), "0.9".into())]);
        assert_eq!(out.matches("temp =").count(), 1, "{out}");
        assert!(!out.contains("Temp"), "{out}");
        assert!(out.contains("temp = 0.9"), "{out}");

        // 同一批 entries 里重复的键也只写一行，最后一个值胜出（与 router 的后者覆盖一致）
        let out = upsert_entries(
            "version = 1\n\n[A/B]\nmodel = E:/a.gguf\n",
            "A/B",
            &[
                ("n-gpu-layers".into(), "10".into()),
                ("n-gpu-layers".into(), "99".into()),
            ],
        );
        assert_eq!(out.matches("n-gpu-layers =").count(), 1, "{out}");
        assert!(out.contains("n-gpu-layers = 99"));
        assert!(!out.contains("n-gpu-layers = 10"));

        // 规范化只动键名：等号右边的值（可能是区分大小写的路径）原样保留。
        // 注意 `upsert_entries` 只重写它接到的键，手写的 `Model = ...` 原样带走，
        // 真正统一大小写的是写盘前的 `sanitize_preset_keys`（这里两步一起验证）。
        let path_line = "version = 1\n\n[A/B]\nModel = E:/ai/Models/My-Path.gguf\n";
        let out = upsert_entries(path_line, "A/B", &[("temp".into(), "0.9".into())]);
        let out = sanitize_preset_keys(&out);
        assert!(out.contains("model = E:/ai/Models/My-Path.gguf"), "{out}");
        assert!(!out.contains("Model ="), "{out}");

        // 删键（空值）时该键的所有行都要消失
        let dup = "version = 1\n\n[A/B]\ntemp = 0.5\ntemp = 0.6\n";
        let out = upsert_entries(dup, "A/B", &[("temp".into(), String::new())]);
        assert!(!out.contains("temp"), "{out}");
    }

    /// 写回管线里的键名规范化与同名键合并（`sanitize_preset_keys` 是所有写盘路径的最后一道）。
    ///
    /// 注意分层：`upsert_entries` 只重写它接到的那些键，其余行**原样带走**（用户手写的
    /// `Temp = 0.5` 不会被"顺手"重排）；真正统一键名大小写的是每次写盘前都会跑的
    /// `sanitize_preset_keys`。这里断言第二道之后大小写重复键也只剩一条。
    #[test]
    fn sanitize_lowercases_keys_and_keeps_last_duplicate() {
        let fixed = sanitize_preset_keys("[A/B]\nModel = E:/a.gguf\nTemp = 0.5\nTemp = 0.9\n");
        assert!(fixed.contains("model = E:/a.gguf"), "{fixed}");
        assert!(fixed.contains("temp = 0.9"), "{fixed}");
        assert!(!fixed.contains("Temp = 0.5"), "{fixed}");
        assert_eq!(fixed.matches("temp").count(), 1, "{fixed}");
        // 值原样保留（不整行 to_lowercase）
        let out = sanitize_preset_keys("[A/B]\nMODEL = E:/ai/Models/My-Path.gguf\n");
        assert!(out.contains("model = E:/ai/Models/My-Path.gguf"), "{out}");
        // 清理淘汰键时同样忽略大小写（大写写法漏掉一样会让 router 起不来）
        assert!(!sanitize_preset_keys("[A/B]\nNo-Mmap = true\n").contains("mmap"));
    }

    /// 坏掉的元数据缓存**不能**让扫描炸掉，也不能 panic（M11）。
    ///
    /// 进程在写盘中途被杀会留下半截 JSON；缓存只是加速手段，坏了等于没有缓存。
    #[test]
    fn broken_meta_cache_is_treated_as_absent() {
        use std::fmt::Write as _;
        let dir = std::env::temp_dir().join("llamacpp-gui-meta-cache-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // 半截 JSON / 空文件 / 二进制垃圾 / 版本不符 → 都当没有缓存
        let cases: [(&str, &str); 4] = [
            (
                "truncated.json",
                "{\"version\":1,\"entries\":[{\"path\":\"E:/a.gguf\",",
            ),
            ("empty.json", ""),
            ("garbage.json", "\u{0}\u{1}\u{2}not json at all"),
            ("old-version.json", "{\"version\":99,\"entries\":[]}"),
        ];
        for (name, content) in cases {
            let file = dir.join(name);
            fs::write(&file, content).unwrap();
            assert!(
                read_meta_cache_file(&file).is_empty(),
                "{name} 应被当成空缓存"
            );
        }

        // 不存在的文件同样返回空表（首次启动就是这个路径）
        assert!(read_meta_cache_file(&dir.join("nope.json")).is_empty());

        // 正常内容要能读回来（兜底归兜底，别把好文件也丢了）
        let good = dir.join("good.json");
        let mut text = String::from("{\"version\":1,\"entries\":[");
        let _ = write!(
            text,
            "{{\"path\":\"E:/a.gguf\",\"size\":1,\"modified_ms\":2,\"architecture\":\"qwen3\",\"file_type\":15}}"
        );
        text.push_str("]}");
        fs::write(&good, text).unwrap();
        let loaded = read_meta_cache_file(&good);
        assert_eq!(loaded.len(), 1);
        let meta = loaded
            .get(&("E:/a.gguf".to_string(), 1, 2))
            .cloned()
            .unwrap_or_default();
        assert_eq!(meta.architecture.as_deref(), Some("qwen3"));
        assert_eq!(meta.file_type, Some(15));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_on_empty_text_creates_version_header() {
        let out = upsert_entries("", "m", &[("model".into(), "E:/a.gguf".into())]);
        assert!(out.starts_with("version = 1"));
        assert!(out.contains("[m]"));
        assert!(out.contains("model = E:/a.gguf"));
        assert!(out.ends_with('\n'));
    }

    /// 实机跑一遍扫描，核对架构/量化，并给出「冷缓存 vs 热缓存」的耗时。
    /// `cargo test --lib real_environment_scan_timing -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_environment_scan_timing() {
        let root = PathBuf::from("E:/AI/models");
        if !root.is_dir() {
            eprintln!("跳过：{} 不存在", root.display());
            return;
        }

        // 让本测试也走落盘缓存，这样分别跑两次就能看出冷/热启动差别
        let cache_file = std::env::temp_dir().join("llamacpp-gui-gguf-meta-cache.json");
        let had_cache = cache_file.is_file();
        set_meta_cache_path(Some(cache_file.clone()));
        println!(
            "落盘缓存 {}（{}）",
            if had_cache { "已存在" } else { "不存在" },
            cache_file.display()
        );

        let start = std::time::Instant::now();
        let cold = scan_models(std::slice::from_ref(&root));
        let cold_ms = start.elapsed().as_millis();

        let start = std::time::Instant::now();
        let warm = scan_models(std::slice::from_ref(&root));
        let warm_ms = start.elapsed().as_millis();

        println!("\n扫描 {} 个模型：冷缓存 {cold_ms} ms / 热缓存 {warm_ms} ms", cold.len());
        for m in &cold {
            println!(
                "  {:<28} {:<14} {:<8} {}",
                m.name,
                m.architecture.as_deref().unwrap_or("-"),
                m.quantization.as_deref().unwrap_or("-"),
                m.id
            );
        }
        assert_eq!(cold.len(), warm.len());
        assert!(
            cold.iter().any(|m| m.architecture.is_some()),
            "至少应有一个模型读出架构"
        );
    }

    /// 需要本机真实环境（默认忽略）：扫描真实模型库生成 preset 文件，供端到端验证
    #[test]
    #[ignore]
    fn real_environment_preset_generation() {
        let root = PathBuf::from("E:/AI/models");
        if !root.is_dir() {
            eprintln!("跳过：{} 不存在", root.display());
            return;
        }
        let models = scan_models(&[root]);
        let mut text = "version = 1\n\n[*]\nctx-size = 4096\n".to_string();
        for m in &models {
            text = ensure_model_section(&text, m, &m.id);
        }
        let out = std::env::temp_dir().join("llamacpp-gui-e2e-presets.ini");
        fs::write(&out, &text).unwrap();
        println!("已写出 preset: {}", out.display());
        println!("段数: {}（扫描到 {} 个模型）", list_sections(&text).len(), models.len());
        println!("----- 前 30 行 -----");
        for line in text.lines().take(30) {
            println!("{line}");
        }
        assert_eq!(list_sections(&text).len(), models.len());
    }

    /// 需要本机真实环境（默认忽略）：`cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_environment_model_scan() {
        let root = PathBuf::from("E:/AI/models");
        if !root.is_dir() {
            eprintln!("跳过：{} 不存在", root.display());
            return;
        }
        let models = scan_models(std::slice::from_ref(&root));
        println!("扫描到 {} 个模型:", models.len());
        for m in &models {
            println!(
                "  {:<52} quant={:<10} shards={} mmproj={} size={:>8.1} MB",
                m.id,
                m.quantization.clone().unwrap_or_else(|| "-".into()),
                m.shards,
                if m.mmproj.is_some() { "是" } else { "否" },
                m.size_bytes as f64 / 1_048_576.0
            );
        }
        assert!(!models.is_empty(), "应至少扫描到一个模型");
        // 辅助文件（投影文件 / 草稿模型）不该出现在上面，但必须能被配置弹窗选到
        let aux = scan_aux_files(&[root.clone()]);
        println!("辅助文件 {} 个:", aux.len());
        for a in &aux {
            println!(
                "  [{:<6}] {:<52} {:>8.1} MB",
                a.kind,
                a.path,
                a.size_bytes as f64 / 1_048_576.0
            );
        }
        assert!(
            !models.iter().any(|m| is_mmproj_name(&m.name) || is_draft_name(&m.name)),
            "投影文件 / 草稿模型不能出现在模型列表里"
        );
        // id 必须唯一（否则 preset 段名会冲突）
        let mut ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "模型 id 必须唯一");
    }

    #[test]
    fn preset_file_io() {
        let dir = std::env::temp_dir().join("llamacpp-gui-preset-io-test");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("presets").join("presets.ini");

        assert_eq!(read_preset(&path).unwrap().trim(), "version = 1");
        write_preset(&path, "version = 1\n[a]\nmodel = E:/a.gguf\n").unwrap();
        assert!(read_preset(&path).unwrap().contains("[a]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_model_section_sets_model_path() {
        let model = ScannedModel {
            id: "OpenBMB/MiniCPM5-2B".into(),
            name: "MiniCPM5-2B".into(),
            path: "E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf".into(),
            dir: "E:/AI/models/OpenBMB/MiniCPM5-2B".into(),
            size_bytes: 1,
            quantization: Some("Q8_0".into()),
            architecture: Some("minicpm".into()),
            mmproj: None,
            shards: 1,
            modified_ms: 0,
            group: "models".into(),
        };
        let out = ensure_model_section("version = 1\n", &model, &model.id);
        assert!(out.contains("[OpenBMB/MiniCPM5-2B]"));
        assert!(out.contains("model = E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf"));

        // 第二次调用不应产生重复段
        let again = ensure_model_section(&out, &model, &model.id);
        assert_eq!(list_sections(&again), vec!["OpenBMB/MiniCPM5-2B"]);
    }

    #[test]
    fn ensure_model_section_uses_given_section_name() {
        // 改过别名的模型：段名用别名，不能再按扫描 id 建段
        let model = ScannedModel {
            id: "OpenBMB/MiniCPM5-2B".into(),
            name: "MiniCPM5-2B".into(),
            path: "E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf".into(),
            dir: "E:/AI/models/OpenBMB/MiniCPM5-2B".into(),
            size_bytes: 1,
            quantization: Some("Q8_0".into()),
            architecture: Some("minicpm".into()),
            mmproj: None,
            shards: 1,
            modified_ms: 0,
            group: "models".into(),
        };
        let out = ensure_model_section("version = 1\n", &model, "小模型");
        assert_eq!(list_sections(&out), vec!["小模型"]);
        assert!(out.contains("model = E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf"));
        assert!(!out.contains("[OpenBMB/MiniCPM5-2B]"));
        // 幂等
        let again = ensure_model_section(&out, &model, "小模型");
        assert_eq!(list_sections(&again), vec!["小模型"]);
    }

    #[test]
    fn sanitize_merges_hub_style_spec_type_keys() {
        let broken = "version = 1\n\n[A/B]\nmodel = E:/a.gguf\nspec-type = draft-mtp\nspec-type_ngram-mod = true\nspec-type_ngram-map-k4v = 0\nctx-size = 4096\n";
        let fixed = sanitize_preset_keys(broken);
        // 追加而不是覆盖：ngram-mod 必须能和草稿类型共存
        assert!(fixed.contains("spec-type = draft-mtp,ngram-mod"), "{fixed}");
        // 假值不并入
        assert!(!fixed.contains("ngram-map-k4v"));
        assert!(!fixed.contains("spec-type_ngram"));
        assert!(fixed.contains("ctx-size = 4096"));
        assert!(fixed.ends_with('\n'));

        // 段内原本没有 spec-type 时新建，且只出现一次
        let only_pseudo = "[A/B]\nmodel = E:/a.gguf\nspec-type_ngram-mod = true\n";
        let fixed2 = sanitize_preset_keys(only_pseudo);
        assert!(fixed2.contains("spec-type = ngram-mod"));
        assert_eq!(fixed2.matches("spec-type").count(), 1, "{fixed2}");

        // 重复值去重
        let dup = "[A/B]\nspec-type = ngram-mod\nspec-type_ngram-mod = true\n";
        assert!(sanitize_preset_keys(dup).contains("spec-type = ngram-mod\n"));

        // 文件里本来就是重复键（历史遗留）：合并成一条
        let two_lines = "[A/B]\nspec-type = draft-mtp\nspec-type = ngram-mod\n";
        let fixed3 = sanitize_preset_keys(two_lines);
        assert!(fixed3.contains("spec-type = draft-mtp,ngram-mod"), "{fixed3}");
        assert_eq!(fixed3.matches("spec-type").count(), 1, "{fixed3}");
    }

    /// `webui` 是旧版界面写下的键名，参数表当前用的是 hub 的 `no-webui`：
    /// 规范化之后界面上的「禁用webui」开关才能反映真实状态。
    #[test]
    fn sanitize_normalizes_webui_key() {
        // 关闭 → 统一成 no-webui = true
        let off = "[A/B]\nmodel = E:/a.gguf\nwebui = false\nctx-size = 4096\n";
        let fixed = sanitize_preset_keys(off);
        assert!(fixed.contains("no-webui = true"), "{fixed}");
        assert!(!fixed.contains("webui = false"), "{fixed}");
        assert!(fixed.contains("ctx-size = 4096"));
        // 0 同样算关闭
        assert!(sanitize_preset_keys("[A/B]\nwebui = 0\n").contains("no-webui = true"));
        // 开启 → 删掉（等于默认）
        let on = sanitize_preset_keys("[A/B]\nwebui = true\n");
        assert!(!on.contains("webui"), "{on}");
        // 已经是 no-webui 的原样保留
        let already = sanitize_preset_keys("[A/B]\nno-webui = true\n");
        assert!(already.contains("no-webui = true"));
    }

    /// 淘汰的 preset 键要被删掉。
    ///
    /// 实测（b11065）：某段里残留 `no-mmap = true` 时 router **整个起不来** ——
    /// `failed to initialize router models: option 'no-mmap' not recognized in preset 'Unsloth/Hy-MT2-7B'`，
    /// 19 个模型一个都用不了。删掉那一行后立刻恢复正常。
    #[test]
    fn sanitize_removes_retired_keys() {
        let text = "[A/B]\nmodel = E:/a.gguf\nno-mmap = true\nload-mode = mmap+mlock\nctx-size = 8192\n";
        let fixed = sanitize_preset_keys(text);
        assert!(!fixed.contains("no-mmap"), "旧键要删掉：{fixed}");
        assert!(fixed.contains("load-mode = mmap+mlock"), "新键要原样保留：{fixed}");
        assert!(fixed.contains("ctx-size = 8192"), "{fixed}");

        // 取值为假、或段里只有它一个键，同样删掉
        let off = sanitize_preset_keys("[A/B]\nno-mmap = false\n");
        assert!(!off.contains("no-mmap"), "{off}");

        // 列表里的每个淘汰键都必须真的被清理
        for key in RETIRED_PRESET_KEYS {
            let text = format!("[A/B]\nmodel = E:/a.gguf\n{key} = true\n");
            let fixed = sanitize_preset_keys(&text);
            assert!(!fixed.contains(key), "{key} 没被清理：{fixed}");
        }
    }

    #[test]
    fn hub_args_tokenizer_handles_quotes() {
        let toks = tokenize_args(r#"--ctx-size 4096 --chat-template-file "E:\a b\c.jinja" --kv-unified"#);
        assert_eq!(
            toks,
            vec![
                "--ctx-size",
                "4096",
                "--chat-template-file",
                r"E:\a b\c.jinja",
                "--kv-unified"
            ]
        );
    }

    #[test]
    fn hub_args_drop_managed_flags_and_split_spec_type() {
        let args: Vec<String> = [
            "--port",
            "8081",
            "--host",
            "127.0.0.1",
            "--no-webui",
            "--ctx-size",
            "4096",
            "--flash-attn",
            "on",
            "--kv-unified",
            "--spec-type_ngram-mod",
            "--spec-draft-model",
            "E:/x.gguf",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let entries = entries_from_hub_args(&args);
        assert_eq!(
            entries,
            vec![
                ("ctx-size".to_string(), "4096".to_string()),
                ("flash-attn".to_string(), "on".to_string()),
                ("kv-unified".to_string(), "true".to_string()),
                ("spec-type".to_string(), "ngram-mod".to_string()),
                ("spec-draft-model".to_string(), "E:/x.gguf".to_string()),
            ]
        );
    }

    #[test]
    fn hub_import_writes_section_params_and_keeps_model_line() {
        let dir = std::env::temp_dir().join("llamacpp-gui-hub-import-test");
        fs::create_dir_all(&dir).unwrap();
        let hub_path = dir.join("launch_config.json");
        fs::write(
            &hub_path,
            r#"{
              "Hy-MT2-1.8B": {
                "configs": { "默认配置": {
                  "cmd": "--ctx-size 4096 --gpu-layers 99 --port 10000 --no-webui --spec-type_ngram-mod",
                  "extraParams": "--pooling cls"
                } },
                "selectedConfig": "默认配置"
              }
            }"#,
        )
        .unwrap();

        let preset = "version = 1\n\n[Unsloth/Hy-MT2-1.8B]\nmodel = E:/AI/models/Unsloth/Hy-MT2-1.8B/x.gguf\n\n[Other/Missing]\nmodel = E:/y.gguf\n";
        let (out, report) = import_hub_presets(preset, &hub_path).unwrap();

        assert_eq!(report.total, 2);
        assert_eq!(report.matched, 1);
        assert_eq!(report.missing, vec!["Other/Missing".to_string()]);
        assert!(out.contains("model = E:/AI/models/Unsloth/Hy-MT2-1.8B/x.gguf"));
        assert!(out.contains("ctx-size = 4096"));
        assert!(out.contains("gpu-layers = 99"));
        assert!(out.contains("spec-type = ngram-mod"));
        assert!(out.contains("pooling = cls"));
        // 被 router 管理的参数不能出现
        assert!(!out.contains("port = "));
        assert!(!out.contains("webui"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "读取本机 hub 配置与真实预设文件，做数据校验（不写盘）"]
    fn real_environment_hub_import() {
        let hub = Path::new("E:/AI/llama.cpp-hub/config/launch_config.json");
        if !hub.is_file() {
            eprintln!("跳过：本机没有 {hub:?}");
            return;
        }
        let appdata = std::env::var("APPDATA").expect("APPDATA");
        let preset_path = Path::new(&appdata).join("dev.llamacpp.gui/presets/presets.ini");
        let preset = fs::read_to_string(&preset_path).expect("读取预设");
        let (out, report) = import_hub_presets(&preset, hub).unwrap();
        // 应用里的写入路径还会跑一次规范化，这里照做以看清最终落盘内容
        let out = sanitize_preset_keys(&out);
        println!("hub: {}", report.hub_path);
        println!("段 {} / 命中 {} / 写入 {} 项", report.total, report.matched, report.entries);
        println!("未命中: {:?}", report.missing);
        for section in ["Unsloth/Hy-MT2-1.8B", "OpenBMB/MiniCPM5-2B", "MiniCPM-V-4.6"] {
            let target = list_sections(&out)
                .into_iter()
                .find(|s| s.ends_with(section))
                .or_else(|| Some(section.to_string()));
            if let Some(name) = target {
                println!("--- {name} ---");
                for (k, v) in section_entries(&out, &name) {
                    println!("  {k} = {v}");
                }
            }
        }
        assert!(report.matched > 0, "至少要命中一个模型");
        assert!(out.contains("ctx-size"), "迁移后应带上下文长度等参数");
    }
}
