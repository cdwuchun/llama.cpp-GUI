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
use regex::Regex;
use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

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

/// 配置目录里的一份 config（`llamacpp-<id>.json`）。
///
/// 第三刀（`presets.ini` 退役）：前端原来靠解析 ini 文本拿「有哪些模型」「哪个关了
/// WebUI」，现在直接读这个原生视图，不再经过 `render_ini_view` 的文本投影。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConfigEntry {
    /// config 文件名主体；请求里 `model` 用的也是它（AGENTS.md 铁律 2）。
    pub id: String,
    /// 配置里的 `name`（迁移后与 id 一致）。
    pub name: String,
    /// 关掉了自带 WebUI ⇒ 卡片上的「聊天」入口要禁用（铁律 1）。
    pub no_webui: bool,
    /// 配置指向的模型文件还在不在（不在就是归档/失效）。
    pub has_model: bool,
    /// `--ctx-size` 解析出来的上下文上限；没配或配 0（= 用模型训练上限）时为 None。
    /// 压测页据此挑档位，不必去问前门（用户 m11542 第 2 点 / m11820）。
    #[serde(default)]
    pub max_context: Option<u64>,
}

/// 扫描结果 + 当前配置目录状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelScanResult {
    pub models: Vec<ScannedModel>,
    /// 辅助文件（多模态投影 / 外挂草稿模型）：不作为模型展示，但参数里可以选。
    #[serde(default)]
    pub aux_files: Vec<AuxFile>,
    /// 配置目录里的 config 清单（原生视图，前端据此算「已配置」与 WebUI 开关）。
    #[serde(default)]
    pub configs: Vec<ConfigEntry>,
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

/// 文件名里出现这些片段就是**外挂草稿模型**。
///
/// `dspark`：用户实测目录里有 `*-dspark.gguf`（对应 `--spec-type draft-dspark`，
/// 见 `src/assets/params.json` 里的 spec-type 选项）。只认 `draft` 的话它会被当成
/// 主模型列出来，点进去只会加载失败 —— 与 mmproj 是同一类问题。
/// 以后再有新的草稿类型名，往这里加一项即可。
const DRAFT_MARKERS: &[&str] = &["draft", "dspark"];

/// 文件名是否是**外挂草稿模型**（推测解码用的小模型）。
pub fn is_draft_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    DRAFT_MARKERS.iter().any(|marker| lower.contains(marker))
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
        saved_at_ms: crate::logs::now_ms(),
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

/// GGUF 值类型：UINT64（`general.context_length` 在部分文件里用这个）。
const GGUF_TYPE_U64: u32 = 10;

/// 从 GGUF 头部读到的元数据。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GgufMeta {
    /// `general.architecture`，如 `bert` / `qwen35moe` / `llama`
    pub architecture: Option<String>,
    /// `general.file_type`（llama.cpp `enum llama_ftype` 的取值）
    pub file_type: Option<u32>,
    /// `general.context_length`：模型训练时的上下文长度。
    /// 配置里 `--ctx-size 0`（= 用模型自带值）时靠它给出上限（用户 m11934）。
    pub context_length: Option<u64>,
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

/// 配置里实际可用的上下文上限：优先 `--ctx-size`，为 0 或没写时用模型 GGUF 的
/// `general.context_length` 兜底。
///
/// 用户 m11934：`--ctx-size 0`（llama.cpp 语义是「用模型自带值」）的模型拿不到上限，
/// 压测页只能退回默认档位（默认勾到 256K），而这个模型其实只有 128K。
/// 配置里没写不等于没有上限 —— GGUF 里写着。
pub fn context_limit(config: &crate::model_config::ModelConfig) -> Option<u64> {
    if let Some(value) = crate::model_config::ctx_size(config) {
        return Some(value);
    }
    let path = Path::new(config.model.as_deref()?);
    let (size, modified_ms) = file_meta(path);
    if size == 0 {
        return None;
    }
    gguf_meta_cached(path, size, modified_ms).context_length
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
///
/// v2：多存 `context_length`。旧缓存没有这个字段，命中后不会重读文件，
/// 模型上限就永远未知 —— 直接升版本让旧缓存整份作废（用户 m11934）。
///
/// v3：上下文长度改按 `<架构名>.context_length` 读（GGUF 的标准写法，见 user m12106）。
/// v2 的缓存是把 `general.context_length` 读空之后写下的 `None`，
/// 而键名改了它也不会重读文件 —— 同样必须整份作废。
pub const META_CACHE_VERSION: u32 = 3;

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
    #[serde(default)]
    context_length: Option<u64>,
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
                context_length: entry.context_length,
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
                context_length: meta.context_length,
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
                // 上下文长度：标准写法是 `<arch>.context_length`（例如 `llama.context_length`），
                // `general.context_length` 只是部分转换器的写法，两种都要认 ——
                // 只认后者会读不到上限（用户 m12106：Sharp-MiniCPM5-2B 文件里是 llama.context_length）。
                _ if key.ends_with(".context_length")
                    && (key.starts_with("general.")
                        || meta
                            .architecture
                            .as_deref()
                            .is_some_and(|arch| key == format!("{arch}.context_length"))) =>
                {
                    match value_type {
                        GGUF_TYPE_U32 => meta.context_length = Some(u64::from(self.u32()?)),
                        GGUF_TYPE_U64 => meta.context_length = self.u64(),
                        _ => self.skip_value(value_type, 0)?,
                    }
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

/// 已经被 llama.cpp 淘汰的 preset 键：写回时**直接丢掉**（不做等价转换）。
///
/// 留着的代价是**整个 router 起不来**，而不是只有那一段失效：
/// `failed to initialize router models: option 'X' not recognized in preset 'Y'`。
///
/// - `no-mmap`：新版用 `--load-mode` 取代（`none` = 不用 mmap）后移除了这个开关。
pub const RETIRED_PRESET_KEYS: &[&str] = &["no-mmap"];

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

/// 把 hub 的参数合并进**配置目录**（第三刀：不再经过 ini 文本中间层）。返回报告。
///
/// 导入只增不减：只遍历配置目录里已有的段，hub 里没有对应配置的段照旧记进 `missing`。
pub fn import_hub_into_dir(dir: &Path, hub_config: &Path) -> Result<HubImportReport> {
    let raw = fs::read_to_string(hub_config)
        .with_context(|| format!("读取 {} 失败", hub_config.display()))?;
    let hub: BTreeMap<String, HubEntry> = serde_json::from_str(&raw)
        .with_context(|| format!("解析 {} 失败", hub_config.display()))?;

    let mut report = HubImportReport {
        hub_path: hub_config.display().to_string(),
        ..Default::default()
    };
    for item in crate::model_config::load_dir(dir) {
        let section = item.config.name.clone();
        report.total += 1;
        match hub_entries_for(&hub, &section) {
            Some(entries) if !entries.is_empty() => {
                report.matched += 1;
                report.entries += entries.len();
                crate::model_config::upsert_entries_in_dir(dir, &section, &entries)?;
            }
            _ => report.missing.push(section),
        }
    }
    Ok(report)
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
    fn gguf_context_length_is_read_from_arch_prefix() {
        // 真实 GGUF 用的是 `<arch>.context_length`（如 llama.context_length），
        // 只认 general.context_length 会读不到上限（用户 m12106）。
        let arch = gguf_string("llama");
        let context = 131072u32.to_le_bytes();
        let path = write_gguf(
            "ctx.gguf",
            &gguf_bytes(
                &[
                    ("general.architecture", 8, &arch),
                    ("llama.context_length", 4, &context),
                ],
                3,
            ),
        );
        assert_eq!(read_gguf_meta(&path).context_length, Some(131072));
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
    fn mmproj_and_draft_name_detection() {
        assert!(is_mmproj_name("mmproj-model-f16.gguf"));
        assert!(is_mmproj_name("MiniCPM-V-2_6-mmproj-model-f16.gguf"));
        assert!(is_mmproj_name("MMPROJ-F16.GGUF"));
        assert!(!is_mmproj_name("Qwen3-4B-Q8_0.gguf"));

        assert!(is_draft_name("Qwen3-0.6B-draft-Q8_0.gguf"));
        assert!(is_draft_name("Draft-Model.gguf"));
        // dspark 草稿（--spec-type draft-dspark）：名字里没有 draft 三个字母，单独认
        assert!(is_draft_name("Qwen3-4B-dspark-Q8_0.gguf"));
        assert!(is_draft_name("QWEN3-4B-DSPARK.gguf"));
        // MTP 是模型自带的投机头，不是外挂草稿模型
        assert!(!is_draft_name("Ornith-1.5-9B-MTP-Q6_K.gguf"));
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

        // 正常内容要能读回来（兜底归兜底，别把好文件也丢了）。版本号必须写当前值，
        // 否则会被当成旧版缓存丢掉（META_CACHE_VERSION 涨了这里要跟着走）。
        let good = dir.join("good.json");
        let mut text = format!("{{\"version\":{META_CACHE_VERSION},\"entries\":[");
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
        let _ = fs::remove_dir_all(&dir);
        let cfg_dir = crate::model_config::config_dir(&dir);
        fs::create_dir_all(&cfg_dir).unwrap();
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

        // 两份配置：一份在 hub 里有参数，一份没有（导入要报 missing）
        for (id, model) in [
            ("Unsloth/Hy-MT2-1.8B", "E:/AI/models/Unsloth/Hy-MT2-1.8B/x.gguf"),
            ("Other/Missing", "E:/y.gguf"),
        ] {
            let cfg = crate::model_config::ModelConfig::new(id, Some(model.to_string()));
            crate::model_config::write(&crate::model_config::path_for_id(&cfg_dir, id), &cfg).unwrap();
        }

        let report = import_hub_into_dir(&cfg_dir, &hub_path).unwrap();

        assert_eq!(report.total, 2);
        assert_eq!(report.matched, 1);
        assert_eq!(report.missing, vec!["Other/Missing".to_string()]);

        // 参数落进 config 的 args，模型行保持不变
        let cfg =
            crate::model_config::load(&crate::model_config::path_for_id(&cfg_dir, "Unsloth/Hy-MT2-1.8B"))
                .unwrap()
                .config;
        let args = cfg.args.join(" ");
        assert_eq!(cfg.model.as_deref(), Some("E:/AI/models/Unsloth/Hy-MT2-1.8B/x.gguf"));
        assert!(args.contains("--ctx-size 4096"));
        assert!(args.contains("--gpu-layers 99"));
        assert!(args.contains("--spec-type ngram-mod"));
        assert!(args.contains("--pooling cls"));
        // 被前门管理的参数不能出现
        assert!(!args.contains("--port"));
        assert!(!args.contains("--webui"));
        let _ = fs::remove_dir_all(&dir);
    }

}
