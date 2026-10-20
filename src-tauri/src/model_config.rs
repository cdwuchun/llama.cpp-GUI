//! llama.cpp 侧配置层：「一个模型一份 JSON」。
//!
//! 依据 `PROXY_SCHEDULER_PLAN.md` §3.1（2026-10-14 用户定稿）：模型配置从
//! `presets\presets.ini`（单文件多段）改为 `<配置目录>\config\llamacpp-<id>.json`
//! （一个模型一份），与 Strata 通道的 `strata-<model>.json` 同构。
//!
//! 契约要点：
//! - `<id>` = 原 preset 段名；非法文件名字符（`/ \ : * ? " < > |` 与首尾空格、点）
//!   统一替换为 `-`；重名追加 `-2` / `-3`。
//! - `args` 是 `llama-server` 的命令行参数数组，**不含** `--port` / `--host` /
//!   `--model` / `--mmproj` —— 这四个由顶层字段生成；用户手写进 `args` 时读入即
//!   剥掉并回报（见 [`LoadedConfig::removed_args`]），避免和顶层字段打架。
//! - 未知字段**原样保留**（`extra`）：用户手写 JSON 时加的自定义键不丢。
//! - 写盘走「临时名 + `.bak` + rename」，与 [`crate::models::write_preset`] 同一策略。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 文件名前缀 / 后缀：扫描规则是 `llamacpp-*.json`。
pub const FILE_PREFIX: &str = "llamacpp-";
pub const FILE_SUFFIX: &str = ".json";
/// 模型配置子目录名（`config\` 只放模型 JSON）。
pub const CONFIG_SUBDIR: &str = "config";
/// 模型消失后配置的归档子目录（`config\.orphan\`）。
pub const ORPHAN_SUBDIR: &str = ".orphan";
/// 由顶层字段生成、**不允许**出现在 `args` 里的参数。
pub const RESERVED_ARGS: &[&str] = &["--port", "--host", "--model", "--mmproj"];

fn default_host() -> String {
    "127.0.0.1".to_string()
}

/// 一份模型配置。
///
/// 字段顺序即写盘顺序；`extra` 用 `#[serde(flatten)]` 兜住所有未知键。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelConfig {
    /// 请求里用的模型名（= 原 preset 段名）。
    pub name: String,
    /// 主模型 gguf 的绝对路径。
    #[serde(default)]
    pub model: Option<String>,
    /// 视觉投影文件（mmproj）路径。
    #[serde(default)]
    pub mmproj: Option<String>,
    /// `llama-server.exe` 路径（缺省时用当前选中版本）。
    #[serde(default)]
    pub exe: Option<String>,
    /// 固定端口（只增不回收）。
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default = "default_host")]
    pub host: String,
    /// 该模型实例的 API key（缺省用全局设置）。
    #[serde(default)]
    pub api_key: Option<String>,
    /// 是否关掉 llama.cpp 自带 WebUI（默认 false = 开着，见 AGENTS.md 铁律 1）。
    #[serde(default)]
    pub no_webui: bool,
    /// 日志文件路径。
    #[serde(default)]
    pub log: Option<String>,
    /// 子实例工作目录。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 额外环境变量。
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// `llama-server` 参数（不含 [`RESERVED_ARGS`]）。
    #[serde(default)]
    pub args: Vec<String>,
    /// 未知字段，原样保留。
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ModelConfig {
    /// 最小可用配置：一个名字 + 主模型路径。
    pub fn new(name: impl Into<String>, model: Option<String>) -> Self {
        Self {
            name: name.into(),
            model,
            mmproj: None,
            exe: None,
            port: None,
            host: default_host(),
            api_key: None,
            no_webui: false,
            log: None,
            cwd: None,
            env: BTreeMap::new(),
            args: Vec::new(),
            extra: Map::new(),
        }
    }

    /// 写盘前规范化：把 `args` 里的保留参数剥掉，其余不动。
    pub fn normalized(mut self) -> (Self, Vec<String>) {
        let (args, removed) = strip_reserved_args(&self.args);
        self.args = args;
        (self, removed)
    }
}

/// 剥掉 `args` 里的 [`RESERVED_ARGS`]（含 `--flag=value` 形式），返回（清理后的
/// 参数、被剥掉的原文片段）。
///
/// 保留参数由顶层字段生成：留在 `args` 里会拼出两个 `--port`，llama.cpp 取后者，
/// 于是「JSON 里写的端口」和「实际绑定的端口」不一致 —— 正是 Strata 通道踩过的坑
/// （`strata.rs:538-546`）。
pub fn strip_reserved_args(args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut kept = Vec::new();
    let mut removed = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let flag = arg.split('=').next().unwrap_or(arg);
        if RESERVED_ARGS.contains(&flag) {
            removed.push(arg.clone());
            // 独立形式 `--port 8211`：值跟在后面，一起丢掉
            if !arg.contains('=') {
                if let Some(value) = args.get(i + 1) {
                    if !value.starts_with("--") {
                        removed.push(value.clone());
                        i += 1;
                    }
                }
            }
            i += 1;
            continue;
        }
        kept.push(arg.clone());
        i += 1;
    }
    (kept, removed)
}

/// `<id>` → 合法文件名主体。
///
/// 非法字符（`/ \ : * ? " < > |`）、控制字符、以及**首尾**的空格与点统一替换为
/// `-`；名字中间的点（`iq3_xxs`、`Hy-MT2-1.8B`）原样保留。
pub fn sanitize_id(id: &str) -> String {
    const BAD: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
    let chars: Vec<char> = id.trim().chars().collect();
    let last = chars.len().saturating_sub(1);
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        let edge = i == 0 || i == last;
        if BAD.contains(c) || c.is_control() || (edge && *c == '.') {
            out.push('-');
        } else {
            out.push(*c);
        }
    }
    if out.is_empty() {
        out.push('-');
    }
    out
}

/// `config\` 目录（与 `settings.json`、`presets\` 同级）。
pub fn config_dir(base: &Path) -> PathBuf {
    base.join(CONFIG_SUBDIR)
}

/// `config\.orphan\`（模型消失后配置的归档目录）。
pub fn orphan_dir(base: &Path) -> PathBuf {
    config_dir(base).join(ORPHAN_SUBDIR)
}

/// id → 该配置的文件名。
pub fn file_name_for(id: &str) -> String {
    format!("{FILE_PREFIX}{}{FILE_SUFFIX}", sanitize_id(id))
}

/// id → 该配置的完整路径。
pub fn path_for_id(dir: &Path, id: &str) -> PathBuf {
    dir.join(file_name_for(id))
}

/// 是否是本层认识的模型配置文件（`llamacpp-*.json`，排除 `.bak*`）。
pub fn is_config_file(name: &str) -> bool {
    name.starts_with(FILE_PREFIX) && name.ends_with(FILE_SUFFIX) && !name.contains(".bak")
}

/// 从 config 的 args 里取 `--ctx-size`（上下文长度，单位 token）。
///
/// 压测页要按模型上限挑档位，而**不能**去读 `GET /props?model=…` —— 那个会让前门
/// 顺手把模型加载起来（用户 m11407）。`--ctx-size 0` 是「用模型自己的训练上限」，
/// 这里当未配置处理（返回 `None`，前端显示「未知」）。用户 m11820：不依赖前门。
pub fn ctx_size(config: &ModelConfig) -> Option<u64> {
    let mut index = 0;
    while index < config.args.len() {
        let arg = config.args[index].as_str();
        if arg == "--ctx-size" || arg == "-c" {
            return config
                .args
                .get(index + 1)
                .and_then(|value| value.parse::<u64>().ok())
                .filter(|value| *value > 0);
        }
        if let Some(value) = arg.strip_prefix("--ctx-size=") {
            return value.parse::<u64>().ok().filter(|value| *value > 0);
        }
        index += 1;
    }
    None
}

/// 文件名 → id（不认识的文件返回 `None`）。
pub fn id_of(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if !is_config_file(name) {
        return None;
    }
    Some(name[FILE_PREFIX.len()..name.len() - FILE_SUFFIX.len()].to_string())
}

/// 目录里已有的模型配置文件（按文件名排序，跳过 `.bak` 与其它文件）。
pub fn list_paths(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(is_config_file)
                .unwrap_or(false)
        })
        .collect();
    paths.sort();
    paths
}

/// 给一个新 id 找不冲突的路径（重名追加 `-2` / `-3`…）。
///
/// 只在**新建**时调用：已存在的模型（按 id 命中）直接复用原文件，不要改它的名字。
pub fn unique_path(dir: &Path, id: &str) -> PathBuf {
    let base = sanitize_id(id);
    let mut candidate = path_for_id(dir, &base);
    let mut n = 2;
    while candidate.exists() {
        candidate = path_for_id(dir, &format!("{base}-{n}"));
        n += 1;
    }
    candidate
}

/// 读入结果：配置本体 + 读入时被剥掉的保留参数。
#[derive(Debug, Clone)]
pub struct LoadedConfig {
    pub config: ModelConfig,
    /// 被剥掉的保留键（`--port` / `--model` 之类）。
    ///
    /// 目前只有测试读它：lib 目标下没有消费者，但「剥掉了要有回执」是 `load` 的契约。
    #[allow(dead_code)]
    pub removed_args: Vec<String>,
}

/// 读一份配置。
///
/// 解析失败**不静默吞掉**（对比 `settings.json` 的已知缺陷：读失败变成默认值，
/// 下一次写盘把默认值固化成唯一副本）—— 这里直接把错误抛给调用方。
pub fn load(path: &Path) -> Result<LoadedConfig> {
    let text = fs::read_to_string(path).with_context(|| format!("读取 {} 失败", path.display()))?;
    let config: ModelConfig = serde_json::from_str(&text)
        .with_context(|| format!("解析 {} 失败（不是合法 JSON 或字段类型不对）", path.display()))?;
    let (config, removed_args) = config.normalized();
    Ok(LoadedConfig {
        config,
        removed_args,
    })
}

/// 写一份配置（原子替换 + 留 `.bak`）。
///
/// 与 `models::write_preset` 的取舍相同：配置文件是用户调参的唯一载体，就地截断写
/// 一旦崩溃/断电就留下半截文件。临时名带 pid + 序号，避免两个并发写互相截断。
pub fn write(path: &Path, config: &ModelConfig) -> Result<()> {
    let (config, removed) = config.clone().normalized();
    if !removed.is_empty() {
        eprintln!(
            "[config] {} 的 args 里出现由顶层字段生成的参数，已忽略：{}",
            path.display(),
            removed.join(" ")
        );
    }
    let body = serde_json::to_string_pretty(&config).context("序列化模型配置失败")?;
    write_text(path, &body)
}

/// 按文本写盘（迁移与「保留用户排版」的路径用）。
pub fn write_text(path: &Path, body: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("创建目录 {} 失败", parent.display()))?;
    }
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
    fs::write(&tmp, body).with_context(|| format!("写入 {} 失败", tmp.display()))?;
    if path.exists() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(path, &bak);
    }
    fs::rename(&tmp, path).with_context(|| format!("替换 {} 失败", path.display()))
}

// ---------------------------------------------------------------------------
// 存量迁移：presets.ini → 一个模型一份 JSON
// ---------------------------------------------------------------------------

/// preset 里的「真」：转成不带值的命令行开关。
const TRUE_WORDS: &[&str] = &["true", "on", "yes"];
/// preset 里的「假」：命令行上省略即等价，直接丢弃该键。
const FALSE_WORDS: &[&str] = &["false", "off", "no"];

/// CLI 上**必须显式给值**的布尔参数（help 里是 `[on|off|auto]` 形态）。
///
/// 这几个不能简写成裸开关：裸写时后面紧跟的参数会被当成它的值。b11482 实测
/// （`--flash-attn` 后面是 `--load-mode`）：
///
/// ```text
/// error while handling argument "--flash-attn": error: unknown value for --flash-attn: '--load-mode'
/// ```
///
/// 子实例随即以退出码 1 结束。其余布尔开关（`--embedding`/`--jinja`/`--rerank`/
/// `--kv-unified`/`--context-shift`…）都有 `--no-xxx` 形式，裸开关才是对的。
const VALUED_BOOL_KEYS: &[&str] = &["flash-attn", "fit", "log-colors", "reasoning"];

/// 这个键是否需要把 `on` / `off` 显式写出来。
fn needs_explicit_value(key: &str) -> bool {
    let key = key.trim();
    VALUED_BOOL_KEYS
        .iter()
        .any(|known| known.eq_ignore_ascii_case(key))
}

/// 一个 ini 段 → 一份模型配置。
///
/// ini 里的键是 llama.cpp preset 的短名（`ctx-size`、`flash-attn`…），而 `args` 存的是
/// 真正的命令行参数（`--ctx-size 0`、`--flash-attn`）—— 前门拿到就能拼命令行。
/// `model` / `mmproj` 进顶层字段，`no-webui` 进 `no_webui`（AGENTS.md 铁律 1 的开关）。
pub fn config_from_section(name: &str, entries: &[(String, String)]) -> ModelConfig {
    let mut cfg = ModelConfig::new(name, None);
    for (key, value) in entries {
        let key = key.trim();
        let value = value.trim();
        match key.to_ascii_lowercase().as_str() {
            "model" => {
                cfg.model = Some(value.to_string());
                continue;
            }
            "mmproj" => {
                cfg.mmproj = Some(value.to_string());
                continue;
            }
            "no-webui" | "no_webui" => {
                cfg.no_webui = TRUE_WORDS.contains(&value.to_ascii_lowercase().as_str());
                continue;
            }
            _ => {}
        }
        let lower = value.to_ascii_lowercase();
        if needs_explicit_value(key) {
            // 取值型（`flash-attn`）：`on` 与 `off` 都要写出来 —— 不写是 auto，跟 off 不等价
            if TRUE_WORDS.contains(&lower.as_str()) || FALSE_WORDS.contains(&lower.as_str()) {
                cfg.args.push(format!("--{key}"));
                cfg.args.push(lower);
            } else if !value.is_empty() {
                cfg.args.push(format!("--{key}"));
                cfg.args.push(value.to_string());
            }
        } else if TRUE_WORDS.contains(&lower.as_str()) {
            cfg.args.push(format!("--{key}"));
        } else if FALSE_WORDS.contains(&lower.as_str()) {
            // 关闭语义：命令行上不写这个参数就是关的
        } else if !value.is_empty() {
            cfg.args.push(format!("--{key}"));
            cfg.args.push(value.to_string());
        }
    }
    cfg
}

/// 给一份新配置挑端口：从 `port_base` 起取第一个既没被别的配置声明、也没被系统占用的
/// （`PROXY_SCHEDULER_PLAN.md` §3.3；端口只增不回收）。
pub fn allocate_port(config_dir: &Path, port_base: u16) -> u16 {
    let declared: Vec<u16> = list_paths(config_dir)
        .iter()
        .filter_map(|p| load(p).ok())
        .filter_map(|c| c.config.port)
        .collect();
    let limit = port_base.saturating_add(200);
    let mut port = port_base;
    while port < limit {
        if !declared.contains(&port) && !crate::winfix::port_in_use(port) {
            return port;
        }
        port += 1;
    }
    port_base
}

/// 迁移报告。
#[derive(Debug, Clone, Serialize)]
pub struct MigrationOutcome {
    pub ini_path: PathBuf,
    pub config_dir: PathBuf,
    /// 原 ini 改名后的路径。**只有全部段都成功才改名**；没改名说明还有段要处理。
    pub backup_path: Option<PathBuf>,
    /// 新写出的配置：(id, 路径, 端口)。
    pub migrated: Vec<(String, PathBuf, u16)>,
    /// 已经有配置、本次跳过（不是失败）。
    pub existing: Vec<String>,
    /// 失败的段：(段名, 原因)。有任何一项就不动 ini，用户改完再启动会接着迁。
    pub failed: Vec<(String, String)>,
}

impl MigrationOutcome {
    /// 本次是否什么都没做（没有 ini 或已迁完）。
    pub fn is_noop(&self) -> bool {
        self.migrated.is_empty() && self.failed.is_empty()
    }
}

fn timestamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 把存量 `presets.ini` 迁移成 `config\llamacpp-<id>.json`。
///
/// 取舍（`PROXY_SCHEDULER_PLAN.md` §3.1）：
/// - **幂等**：目标 JSON 已存在就跳过，不覆盖用户后来改过的参数。
/// - **不删原件**：只有每个段都成功才把 ini 改名成 `presets.ini.bak-<时间戳>`；
///   只要有一段失败就原样留着，下次启动接着迁（已迁的段会被跳过）。
pub fn migrate_from_ini(
    ini_path: &Path,
    config_dir: &Path,
    port_base: u16,
) -> Result<MigrationOutcome> {
    let mut outcome = MigrationOutcome {
        ini_path: ini_path.to_path_buf(),
        config_dir: config_dir.to_path_buf(),
        backup_path: None,
        migrated: Vec::new(),
        existing: Vec::new(),
        failed: Vec::new(),
    };
    if !ini_path.exists() {
        return Ok(outcome);
    }
    let text = fs::read_to_string(ini_path)
        .with_context(|| format!("读取 {} 失败", ini_path.display()))?;
    let retired: Vec<String> = crate::models::RETIRED_PRESET_KEYS
        .iter()
        .map(|k| format!("--{k}"))
        .collect();

    for section in crate::models::list_sections(&text) {
        if path_for_id(config_dir, &section).exists() {
            outcome.existing.push(section);
            continue;
        }
        let entries = crate::models::section_entries(&text, &section);
        let mut cfg = config_from_section(&section, &entries);
        match cfg.model.as_deref().map(str::trim) {
            Some(path) if !path.is_empty() => {}
            _ => {
                outcome
                    .failed
                    .push((section, "段里没有可用的 model 键".to_string()));
                continue;
            }
        }
        // 淘汰键（铁律 5）不进命令行：`--no-mmap` 之类会让进程起不来
        cfg.args.retain(|arg| !retired.contains(arg));
        let port = allocate_port(config_dir, port_base);
        cfg.port = Some(port);
        let path = unique_path(config_dir, &section);
        match write(&path, &cfg) {
            Ok(()) => outcome.migrated.push((section, path, port)),
            Err(err) => outcome.failed.push((section, format!("{err:#}"))),
        }
    }

    if outcome.failed.is_empty() && !outcome.migrated.is_empty() {
        let backup = ini_path.with_extension(format!("ini.bak-{}", timestamp()));
        fs::rename(ini_path, &backup)
            .with_context(|| format!("备份 {} 失败", ini_path.display()))?;
        outcome.backup_path = Some(backup);
    }
    Ok(outcome)
}

// --------------------------------------------------------------- 键值视图
//
// 前端参数表单读的是 ini 风格的「键 = 值」。JSON 是真源，但为了让后端切换这一刀
// 不必同时改前端，这里提供一层双向转换：`entries_from_config` 把配置摊成键值，
// `apply_entries` 把键值合并回去，`render_ini_view` 把整个 config 目录渲染成
// 一份 ini 文本视图（只读投影，供模型卡片、参数弹窗沿用原有解析器）。

/// 配置 → ini 风格键值对（顺序：`model` / `mmproj` / `no-webui` / `args` 原序）。
///
/// `args` 里存的是真正的命令行参数（`--ctx-size 4096`），这里翻回 `ctx-size = 4096`；
/// 无值开关（`--flash-attn`）翻成 `on` —— 与 ini 时代一致，前端 `truthyValue` 认它。
pub fn entries_from_config(cfg: &ModelConfig) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    if let Some(model) = cfg.model.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push(("model".to_string(), model.to_string()));
    }
    if let Some(mmproj) = cfg.mmproj.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push(("mmproj".to_string(), mmproj.to_string()));
    }
    if cfg.no_webui {
        out.push(("no-webui".to_string(), "true".to_string()));
    }
    let mut index = 0usize;
    while index < cfg.args.len() {
        let arg = &cfg.args[index];
        let Some(rest) = arg.strip_prefix("--") else {
            index += 1; // 位置参数不进表单
            continue;
        };
        if let Some((key, value)) = rest.split_once('=') {
            out.push((key.to_string(), value.to_string()));
            index += 1;
            continue;
        }
        match cfg.args.get(index + 1) {
            Some(value) if !value.starts_with("--") => {
                out.push((rest.to_string(), value.clone()));
                index += 2;
            }
            _ => {
                out.push((rest.to_string(), "on".to_string()));
                index += 1;
            }
        }
    }
    out
}

fn is_retired_key(key: &str) -> bool {
    crate::models::RETIRED_PRESET_KEYS
        .iter()
        .any(|retired| retired.eq_ignore_ascii_case(key.trim()))
}

fn arg_matches(arg: &str, key: &str) -> bool {
    match arg.strip_prefix("--") {
        Some(rest) => rest
            .split('=')
            .next()
            .map(|name| name.eq_ignore_ascii_case(key))
            .unwrap_or(false),
        None => false,
    }
}

/// 在 `args` 里替换（或追加）一个键。空值 = 删掉这个键（ini 时代的语义）。
fn set_arg(cfg: &mut ModelConfig, key: &str, value: &str) {
    if is_retired_key(key) {
        // 淘汰键写回去会让整个前门起不来（铁律 5），丢掉即可
        return;
    }
    let mut kept: Vec<String> = Vec::with_capacity(cfg.args.len() + 2);
    let mut insert_at: Option<usize> = None;
    let mut index = 0usize;
    while index < cfg.args.len() {
        let arg = &cfg.args[index];
        if arg_matches(arg, key) {
            if insert_at.is_none() {
                insert_at = Some(kept.len());
            }
            // `--key value` 两段一起吃掉
            if !arg.contains('=') && matches!(cfg.args.get(index + 1), Some(v) if !v.starts_with("--"))
            {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        kept.push(arg.clone());
        index += 1;
    }
    let value = value.trim();
    let replacement: Vec<String> = if value.is_empty() {
        // 空值 = 删键（ini 时代的语义）
        Vec::new()
    } else if needs_explicit_value(key) {
        // 取值型布尔（`flash-attn`）：`on` / `off` 都要写值，裸开关会把下一个参数吃掉
        vec![format!("--{key}"), value.to_ascii_lowercase()]
    } else if FALSE_WORDS
        .iter()
        .any(|word| word.eq_ignore_ascii_case(value))
    {
        // `off` / `false` / `no` 也算「关」—— 与 ini 迁移路径（`config_from_section`）
        // 同一规则：命令行里省略这个开关就是关。
        Vec::new()
    } else if value.eq_ignore_ascii_case("on") || value.eq_ignore_ascii_case("true") {
        vec![format!("--{key}")]
    } else {
        vec![format!("--{key}"), value.to_string()]
    };
    let at = insert_at.unwrap_or(kept.len());
    for (offset, item) in replacement.into_iter().enumerate() {
        kept.insert(at + offset, item);
    }
    cfg.args = kept;
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// 键值对合并进配置：同名覆盖、其余保留、空值删除该键。
///
/// 顶层字段（`model` / `mmproj` / `no-webui`）走结构体，其余进 `args`。
pub fn apply_entries(cfg: &mut ModelConfig, entries: &[(String, String)]) {
    for (key, value) in entries {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let lower = key.to_ascii_lowercase();
        match lower.as_str() {
            "model" => {
                cfg.model = non_empty(value);
                continue;
            }
            "mmproj" => {
                cfg.mmproj = non_empty(value);
                continue;
            }
            "no-webui" | "no_webui" | "webui" => {
                let on = TRUE_WORDS
                    .iter()
                    .any(|word| word.eq_ignore_ascii_case(value.trim()));
                cfg.no_webui = if lower == "webui" { !on } else { on };
                continue;
            }
            _ => {}
        }
        set_arg(cfg, key, value);
    }
}

/// 加载后过一遍 `args`：剥掉淘汰键（`RETIRED_PRESET_KEYS`），并给裸写的取值型布尔
/// 补上 `on`。返回是否改动。
///
/// 留着淘汰键的后果不是「那一段用不了」，而是**整个子实例/前门起不来**
/// （`option '…' not recognized in preset`），所以加载后统一过一遍（铁律 5）。
/// 裸 `--flash-attn` 则是子实例启动即以退出码 1 结束（见 `VALUED_BOOL_KEYS`）——
/// 早期迁移写出来的那些配置靠这一步自愈。
pub fn sanitize_config(cfg: &mut ModelConfig) -> bool {
    let before = cfg.args.clone();
    let mut kept: Vec<String> = Vec::with_capacity(before.len());
    let mut i = 0;
    while i < cfg.args.len() {
        let arg = cfg.args[i].clone();
        let key = arg
            .strip_prefix("--")
            .map(|rest| rest.split('=').next().unwrap_or(rest))
            .unwrap_or("");
        if !key.is_empty() && is_retired_key(key) {
            // 独立形式（`--key value`）要把值一起吃掉
            if !arg.contains('=') && i + 1 < cfg.args.len() && !cfg.args[i + 1].starts_with("--") {
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        kept.push(arg);
        i += 1;
    }
    let mut fixed: Vec<String> = Vec::with_capacity(kept.len() + 2);
    let mut i = 0;
    while i < kept.len() {
        let arg = kept[i].clone();
        let key = arg
            .strip_prefix("--")
            .map(|rest| rest.split('=').next().unwrap_or(rest))
            .unwrap_or("");
        let has_value = arg.contains('=')
            || matches!(kept.get(i + 1), Some(next) if !next.starts_with("--"));
        if !key.is_empty() && needs_explicit_value(key) && !has_value {
            fixed.push(arg);
            fixed.push("on".to_string());
        } else {
            fixed.push(arg);
        }
        i += 1;
    }
    if fixed == before {
        return false;
    }
    cfg.args = fixed;
    true
}

/// 两个 id 是否指向同一份配置（文件名会替换非法字符，比较前先归一）。
pub fn same_id(a: &str, b: &str) -> bool {
    sanitize_id(a).eq_ignore_ascii_case(&sanitize_id(b))
}

// ------------------------------------------------------------- 目录级操作

/// config 目录里的一份模型配置（id = 文件名主体）。
#[derive(Debug, Clone)]
pub struct DirConfig {
    pub id: String,
    pub path: PathBuf,
    pub config: ModelConfig,
}

/// 读整个 config 目录。坏文件跳过（打日志），不让一份手写坏的 JSON 挡住全部模型。
pub fn load_dir(dir: &Path) -> Vec<DirConfig> {
    let mut out: Vec<DirConfig> = Vec::new();
    for path in list_paths(dir) {
        let Some(id) = id_of(&path) else { continue };
        match load(&path) {
            Ok(loaded) => out.push(DirConfig {
                id,
                path,
                config: loaded.config,
            }),
            Err(err) => eprintln!("[config] 跳过无法解析的配置 {}: {err:#}", path.display()),
        }
    }
    out
}

/// 按 id 读-改-写（调用方需持有 preset 锁）。
pub fn upsert_entries_in_dir(dir: &Path, id: &str, entries: &[(String, String)]) -> Result<ModelConfig> {
    let path = path_for_id(dir, id);
    let mut cfg = if path.exists() {
        load(&path)?.config
    } else {
        ModelConfig::new(id, None)
    };
    apply_entries(&mut cfg, entries);
    write(&path, &cfg)?;
    Ok(cfg)
}

/// 永久删除一份配置（用户点「删除」；归档是模型消失时的另一条路径）。
pub fn remove_config_file(dir: &Path, id: &str) -> Result<bool> {
    let path = path_for_id(dir, id);
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path)
        .with_context(|| format!("删除 {} 失败", path.display()))?;
    Ok(true)
}

/// 模型消失：把配置移进 `config\.orphan\`（下次它回来还能还原）。
pub fn move_to_orphan(dir: &Path, id: &str) -> Result<Option<PathBuf>> {
    let path = path_for_id(dir, id);
    if !path.exists() {
        return Ok(None);
    }
    let orphan = orphan_dir(dir);
    fs::create_dir_all(&orphan).with_context(|| format!("创建 {} 失败", orphan.display()))?;
    let target = unique_path(&orphan, id);
    fs::rename(&path, &target)
        .with_context(|| format!("归档 {} 失败", path.display()))?;
    Ok(Some(target))
}

/// 归档还原：模型重新出现时把 `.orphan` 里的配置移回来。
///
/// 换过文件（同目录同 id 但 gguf 文件名不同）时不还原 —— 与 ini 时代
/// `restore_archived_sections` 的判断一致，避免把旧参数套到另一个模型上。
pub fn restore_from_orphan(dir: &Path, id: &str, model_path: &str) -> Result<Option<PathBuf>> {
    let orphan = orphan_dir(dir);
    let source = path_for_id(&orphan, id);
    if !source.exists() {
        return Ok(None);
    }
    let target = path_for_id(dir, id);
    if target.exists() {
        return Ok(None);
    }
    let mut cfg = load(&source)?.config;
    let same_file = match cfg.model.as_deref() {
        Some(old) => {
            let old = Path::new(old)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase());
            let new = Path::new(model_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase());
            old.is_some() && old == new
        }
        None => true,
    };
    if !same_file {
        return Ok(None);
    }
    cfg.model = Some(model_path.to_string());
    write(&target, &cfg)?;
    let _ = fs::remove_file(&source);
    Ok(Some(target))
}

/// 给扫描到但还没有配置的模型补一份最小的 JSON。
///
/// 返回值第二项表示「这次是新建的」（前端据此提示同步了几个模型）。
pub fn ensure_config(
    dir: &Path,
    name: &str,
    model_path: &str,
    mmproj: Option<&str>,
    port_base: u16,
) -> Result<(PathBuf, bool)> {
    let path = path_for_id(dir, name);
    if path.exists() {
        return Ok((path, false));
    }
    let mut cfg = ModelConfig::new(name, Some(model_path.to_string()));
    cfg.mmproj = mmproj.map(str::to_string);
    cfg.port = Some(allocate_port(dir, port_base));
    write(&path, &cfg)?;
    Ok((path, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp").join(format!(
            "llamacpp-gui-model-config-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 干跑：拿真实 `presets.ini` 只做转换、不写盘，用来看 14 段转出来长什么样。
    ///
    /// `$env:LLAMACPP_GUI_REAL_INI='E:\AI\llama.cpp-gui\presets\presets.ini'` 后跑
    /// `cargo test --lib dry_run_real_ini -- --ignored --nocapture`。
    #[test]
    #[ignore = "手工跑：把真实 presets.ini 迁移到临时目录再渲染视图，逐段核对键值有没有丢"]
    fn dry_run_migrate_and_render() {
        let Ok(path) = std::env::var("LLAMACPP_GUI_REAL_INI") else {
            return;
        };
        let source = fs::read_to_string(&path).expect("读真实 ini");
        let dir = temp_dir("dry-migrate");
        let cfg_dir = config_dir(&dir);
        let _ = fs::remove_dir_all(&cfg_dir);
        let ini = dir.join("presets.ini");
        fs::write(&ini, &source).unwrap();

        let outcome = migrate_from_ini(&ini, &cfg_dir, 18211).unwrap();
        let items = load_dir(&cfg_dir);

        let mut lost = 0usize;
        for section in crate::models::list_sections(&source) {
            let before = crate::models::section_entries(&source, &section);
            // 第三刀：没有 ini 文本视图了，直接比配置里的表单条目
            let after = items
                .iter()
                .find(|item| same_id(&item.config.name, &section))
                .map(|item| entries_from_config(&item.config))
                .unwrap_or_default();
            println!("[{section}] 迁移前 {} 键 / 视图 {} 键", before.len(), after.len());
            for (key, value) in &before {
                match after
                    .iter()
                    .find(|(candidate, _)| candidate.eq_ignore_ascii_case(key))
                {
                    Some((_, got)) if got == value => {}
                    Some((_, got)) => println!("  变值: {key} = {value} → {got}"),
                    None => {
                        lost += 1;
                        println!("  丢了: {key} = {value}");
                    }
                }
            }
        }
        println!(
            "迁移 {} 段，失败 {:?}，视图丢键 {lost} 处",
            outcome.migrated.len(),
            outcome.failed
        );
    }

    #[test]
    #[ignore = "手工跑：读真实 presets.ini 做干跑转换检查"]
    fn dry_run_real_ini() {
        let Some(path) = std::env::var_os("LLAMACPP_GUI_REAL_INI") else {
            return;
        };
        let text = fs::read_to_string(PathBuf::from(path)).unwrap();
        for section in crate::models::list_sections(&text) {
            let entries = crate::models::section_entries(&text, &section);
            let cfg = config_from_section(&section, &entries);
            println!(
                "[{section}] no_webui={} mmproj={} args={}",
                cfg.no_webui,
                cfg.mmproj.is_some(),
                cfg.args.join(" ")
            );
        }
    }

    /// 一段真实形态的 presets.ini（键是 llama.cpp preset 的短名）。
    const SAMPLE_INI: &str = r#"version = 1

[BAAI/bge-m3]
model = E:/AI/models/BAAI/bge-m3/bge-m3-q8_0.gguf

ctx-size = 0
flash-attn = on
load-mode = mmap+mlock
gpu-layers = 99

no-webui = true

[Unsloth/Hy-MT2-1.8B]
model = E:/AI/models/Unsloth/Hy-MT2-1.8B/Hy-MT2-1.8B-Q4_K_M.gguf
mmproj = E:/AI/models/Unsloth/Hy-MT2-1.8B/mmproj-F16.gguf
spec-type = draft-mtp
spec-draft-n-max = 2
no-mmap = true
reserve = off
"#;

    #[test]
    fn section_to_config_maps_booleans_and_reserved_keys() {
        let entries: Vec<(String, String)> = [
            ("model", "E:/m/a.gguf"),
            ("mmproj", "E:/m/mmproj.gguf"),
            ("no-webui", "true"),
            ("ctx-size", "4096"),
            ("flash-attn", "on"),
            ("reserve", "off"),
            ("spec-type", "draft-mtp"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let cfg = config_from_section("Hy-MT2-1.8B", &entries);
        assert_eq!(cfg.name, "Hy-MT2-1.8B");
        assert_eq!(cfg.model.as_deref(), Some("E:/m/a.gguf"));
        assert_eq!(cfg.mmproj.as_deref(), Some("E:/m/mmproj.gguf"));
        assert!(cfg.no_webui);
        // `on` → 取值型键带值（`flash-attn on`）、普通开关不带值；`off` → 丢弃；其余键值成对
        assert_eq!(
            cfg.args,
            vec!["--ctx-size", "4096", "--flash-attn", "on", "--spec-type", "draft-mtp"]
        );
    }

    #[test]
    fn migrate_ini_writes_one_json_per_section_and_backs_up_ini() {
        let dir = temp_dir("migrate");
        let ini = dir.join("presets.ini");
        fs::write(&ini, SAMPLE_INI).unwrap();
        let cfg_dir = config_dir(&dir);
        // 用高位端口，避免撞上本机正在跑的服务
        let base = 18211;

        let first = migrate_from_ini(&ini, &cfg_dir, base).unwrap();
        assert_eq!(first.migrated.len(), 2, "{first:?}");
        assert!(first.failed.is_empty(), "不该有失败段：{:?}", first.failed);
        assert!(!ini.exists(), "全部成功才应把 ini 改名");
        let backup = first.backup_path.clone().unwrap();
        assert!(backup.exists());
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("presets.ini.bak-"));

        // 文件名：`/` → `-`；`name` 字段保留原段名
        let m3 = load(&path_for_id(&cfg_dir, "BAAI/bge-m3")).unwrap();
        assert_eq!(m3.config.name, "BAAI/bge-m3");
        assert!(m3.config.no_webui);
        assert_eq!(m3.config.port, Some(base));
        assert!(m3.config.args.contains(&"--load-mode".to_string()));

        let hy = load(&path_for_id(&cfg_dir, "Unsloth/Hy-MT2-1.8B")).unwrap();
        assert_eq!(hy.config.name, "Unsloth/Hy-MT2-1.8B");
        assert_eq!(hy.config.port, Some(base + 1));
        assert_eq!(
            hy.config.mmproj.as_deref(),
            Some("E:/AI/models/Unsloth/Hy-MT2-1.8B/mmproj-F16.gguf")
        );
        // 淘汰键不能进命令行（铁律 5）
        assert!(!hy.config.args.iter().any(|a| a == "--no-mmap"));

        // 幂等：ini 已经不存在 → 什么都不做
        let again = migrate_from_ini(&ini, &cfg_dir, base).unwrap();
        assert!(again.is_noop());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_leaves_ini_alone_when_a_section_fails() {
        let dir = temp_dir("migrate-fail");
        let ini = dir.join("presets.ini");
        fs::write(&ini, "version = 1\n\n[good]\nmodel = E:/m/a.gguf\n\n[broken]\nctx-size = 4096\n")
            .unwrap();
        let cfg_dir = config_dir(&dir);

        let out = migrate_from_ini(&ini, &cfg_dir, 18251).unwrap();
        assert_eq!(out.migrated.len(), 1);
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.failed[0].0, "broken");
        assert!(ini.exists(), "有失败段就不能动 ini");
        assert!(out.backup_path.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_round_trip_through_apply_entries() {
        let mut cfg = ModelConfig::new("Unsloth/Hy-MT2-1.8B", Some("E:/models/a.gguf".into()));
        cfg.mmproj = Some("E:/models/mmproj.gguf".into());
        cfg.no_webui = true;
        cfg.args = vec![
            "--ctx-size".into(),
            "4096".into(),
            // 取值型布尔在命令行上必须带值（`--flash-attn on`），往返才一致
            "--flash-attn".into(),
            "on".into(),
            "--cache-type-k".into(),
            "q8_0".into(),
        ];
        let entries = entries_from_config(&cfg);
        assert_eq!(
            entries,
            vec![
                ("model".to_string(), "E:/models/a.gguf".to_string()),
                ("mmproj".to_string(), "E:/models/mmproj.gguf".to_string()),
                ("no-webui".to_string(), "true".to_string()),
                ("ctx-size".to_string(), "4096".to_string()),
                ("flash-attn".to_string(), "on".to_string()),
                ("cache-type-k".to_string(), "q8_0".to_string()),
            ]
        );

        // 摊平再合并回去，配置应完全一致（开关、路径、参数顺序都不丢）
        let mut rebuilt = ModelConfig::new("Unsloth/Hy-MT2-1.8B", None);
        apply_entries(&mut rebuilt, &entries);
        assert_eq!(rebuilt.model, cfg.model);
        assert_eq!(rebuilt.mmproj, cfg.mmproj);
        assert_eq!(rebuilt.no_webui, cfg.no_webui);
        assert_eq!(rebuilt.args, cfg.args);
    }

    #[test]
    fn apply_entries_covers_webui_form_and_retired_keys() {
        let mut cfg = ModelConfig::new("m", None);
        apply_entries(
            &mut cfg,
            &[
                ("ctx-size".to_string(), "8192".to_string()),
                ("flash-attn".to_string(), "off".to_string()),
                ("no-mmap".to_string(), "true".to_string()),
            ],
        );
        assert_eq!(
            cfg.args,
            vec![
                "--ctx-size".to_string(),
                "8192".to_string(),
                // 取值型布尔：`off` 也要写出来（不写是 auto，跟 off 不等价）
                "--flash-attn".to_string(),
                "off".to_string()
            ]
        );
        assert!(!cfg.no_webui);

        // `webui = off` 等价 `no-webui = on`；空值删键（删 ctx-size，`flash-attn off` 留着）
        apply_entries(
            &mut cfg,
            &[
                ("webui".to_string(), "off".to_string()),
                ("ctx-size".to_string(), String::new()),
            ],
        );
        assert!(cfg.no_webui);
        assert_eq!(cfg.args, vec!["--flash-attn".to_string(), "off".to_string()]);

        // 手写 `--key=value` 形式也要能被覆盖掉（不能留两份）
        let mut cfg = ModelConfig::new("m", None);
        cfg.args = vec!["--temp=0.7".into()];
        apply_entries(&mut cfg, &[("temp".to_string(), "1.0".to_string())]);
        assert_eq!(cfg.args, vec!["--temp".to_string(), "1.0".to_string()]);
    }

    #[test]
    fn ensure_orphan_and_restore_round_trip() {
        let dir = temp_dir("orphan");
        let (path, created) = ensure_config(
            &dir,
            "Unsloth/Hy-MT2-1.8B",
            "E:/models/hy.gguf",
            Some("E:/models/mmproj.gguf"),
            18221,
        )
        .unwrap();
        assert!(created);
        let loaded = load(&path).unwrap().config;
        assert_eq!(loaded.port, Some(18221));
        assert_eq!(loaded.mmproj.as_deref(), Some("E:/models/mmproj.gguf"));

        // 已存在 → 不覆盖（幂等）
        let (_, created_again) =
            ensure_config(&dir, "Unsloth/Hy-MT2-1.8B", "E:/models/other.gguf", None, 18221).unwrap();
        assert!(!created_again);
        assert_eq!(
            load(&path).unwrap().config.model.as_deref(),
            Some("E:/models/hy.gguf")
        );

        // 归档 → 还原
        let moved = move_to_orphan(&dir, "Unsloth/Hy-MT2-1.8B").unwrap();
        assert!(moved.is_some());
        assert!(!path.exists());
        let restored = restore_from_orphan(&dir, "Unsloth/Hy-MT2-1.8B", "E:/models/hy.gguf").unwrap();
        assert!(restored.is_some());
        assert!(path.exists());

        // 归档里的配置指向另一个 gguf 时不还原（旧参数不能套到别的模型上）
        move_to_orphan(&dir, "Unsloth/Hy-MT2-1.8B").unwrap();
        let skipped =
            restore_from_orphan(&dir, "Unsloth/Hy-MT2-1.8B", "E:/models/别的模型.gguf").unwrap();
        assert!(skipped.is_none());
        assert!(!path.exists());
    }

    #[test]
    fn upsert_entries_in_dir_creates_then_merges() {
        let dir = temp_dir("upsert-dir");
        let cfg = upsert_entries_in_dir(
            &dir,
            "New/Model",
            &[
                ("model".to_string(), "E:/models/new.gguf".to_string()),
                ("ctx-size".to_string(), "4096".to_string()),
            ],
        )
        .unwrap();
        assert_eq!(cfg.name, "New/Model");
        assert_eq!(cfg.args, vec!["--ctx-size".to_string(), "4096".to_string()]);

        // 第二次只改一个键，另一个键与顶层字段都要留着
        let cfg = upsert_entries_in_dir(
            &dir,
            "New/Model",
            &[("ctx-size".to_string(), "8192".to_string())],
        )
        .unwrap();
        assert_eq!(cfg.model.as_deref(), Some("E:/models/new.gguf"));
        assert_eq!(cfg.args, vec!["--ctx-size".to_string(), "8192".to_string()]);

        assert!(remove_config_file(&dir, "New/Model").unwrap());
        assert!(!remove_config_file(&dir, "New/Model").unwrap());
    }

    #[test]
    #[ignore = "手工跑：把真实 config 目录里裸写的取值型开关补上值（一次性修数）"]
    fn repair_real_configs() {
        let Ok(dir) = std::env::var("LLAMACPP_GUI_CONFIG_DIR") else {
            println!("没有 LLAMACPP_GUI_CONFIG_DIR，跳过");
            return;
        };
        let dir = PathBuf::from(dir);
        let mut fixed = 0;
        for item in load_dir(&dir) {
            let mut cfg = item.config.clone();
            if sanitize_config(&mut cfg) {
                write(&item.path, &cfg).expect("写回配置");
                println!("修好 {} → {:?}", item.path.display(), cfg.args);
                fixed += 1;
            }
        }
        println!("共修 {fixed} 份");
    }

    #[test]
    fn valued_bool_keys_keep_an_explicit_value() {
        // `flash-attn = on` 必须写成 `--flash-attn on`：裸写会把下一个参数当成它的值，
        // 子实例直接以退出码 1 结束（b11482 实测）。
        let cfg = config_from_section(
            "m",
            &[
                ("model".to_string(), "x.gguf".to_string()),
                ("flash-attn".to_string(), "on".to_string()),
                ("kv-unified".to_string(), "true".to_string()),
            ],
        );
        assert_eq!(cfg.args, vec!["--flash-attn", "on", "--kv-unified"]);
    }

    #[test]
    fn apply_entries_keeps_value_for_valued_switch() {
        let mut cfg = ModelConfig::new("m", None);
        apply_entries(&mut cfg, &[("flash-attn".to_string(), "off".to_string())]);
        assert_eq!(cfg.args, vec!["--flash-attn", "off"]);
    }

    #[test]
    fn sanitize_repairs_bare_valued_switch() {
        let mut cfg = ModelConfig::new("m", None);
        cfg.args = vec![
            "--flash-attn".to_string(),
            "--load-mode".to_string(),
            "mmap+mlock".to_string(),
        ];
        assert!(sanitize_config(&mut cfg));
        assert_eq!(
            cfg.args,
            vec!["--flash-attn", "on", "--load-mode", "mmap+mlock"]
        );
        // 已经带值的不再动
        assert!(!sanitize_config(&mut cfg));
    }

    #[test]
    fn sanitize_id_replaces_illegal_chars_and_edges() {
        // 作者前缀里的 `/` 是常见形态：Unsloth/Hy-MT2-1.8B
        assert_eq!(sanitize_id("Unsloth/Hy-MT2-1.8B"), "Unsloth-Hy-MT2-1.8B");
        // 名字中间的点与下划线保留
        assert_eq!(sanitize_id("swift-1.5-iq3_xxs"), "swift-1.5-iq3_xxs");
        // 首尾空格与点 → `-`；中间空格保留
        assert_eq!(sanitize_id(" My Model "), "My Model");
        assert_eq!(sanitize_id(".hidden"), "-hidden");
        // Windows 上不可写的字符全都要换掉
        assert_eq!(sanitize_id("a:b*c?d\"e<f>g|h\\i"), "a-b-c-d-e-f-g-h-i");
        // 空名字兜底
        assert_eq!(sanitize_id("   "), "-");
    }

    #[test]
    fn file_name_and_id_round_trip() {
        let name = file_name_for("Unsloth/Hy-MT2-1.8B");
        assert_eq!(name, "llamacpp-Unsloth-Hy-MT2-1.8B.json");
        assert_eq!(
            id_of(Path::new(&name)).as_deref(),
            Some("Unsloth-Hy-MT2-1.8B")
        );
        // `.bak` / 其它 json 不是模型配置
        assert!(!is_config_file("llamacpp-a.json.bak"));
        assert!(!is_config_file("settings.json"));
        assert!(!is_config_file("strata-swift.json"));
    }

    #[test]
    fn unique_path_appends_counter_on_conflict() {
        let dir = temp_dir("unique");
        let first = unique_path(&dir, "Hy-MT2-1.8B");
        assert_eq!(first.file_name().unwrap(), "llamacpp-Hy-MT2-1.8B.json");
        fs::write(&first, "{}").unwrap();
        let second = unique_path(&dir, "Hy-MT2-1.8B");
        assert_eq!(second.file_name().unwrap(), "llamacpp-Hy-MT2-1.8B-2.json");
        fs::write(&second, "{}").unwrap();
        let third = unique_path(&dir, "Hy-MT2-1.8B");
        assert_eq!(third.file_name().unwrap(), "llamacpp-Hy-MT2-1.8B-3.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn strip_reserved_args_handles_both_forms() {
        let args: Vec<String> = [
            "--ctx-size",
            "4096",
            "--port",
            "8211",
            "--model",
            "E:\\m\\a.gguf",
            "--host=0.0.0.0",
            "--n-gpu-layers",
            "auto",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let (kept, removed) = strip_reserved_args(&args);
        assert_eq!(kept, vec!["--ctx-size", "4096", "--n-gpu-layers", "auto"]);
        assert_eq!(
            removed,
            vec!["--port", "8211", "--model", "E:\\m\\a.gguf", "--host=0.0.0.0"]
        );
    }

    #[test]
    fn write_then_load_keeps_unknown_fields_and_drops_reserved_args() {
        let dir = temp_dir("roundtrip");
        let path = path_for_id(&dir, "Hy-MT2-1.8B");
        let mut cfg = ModelConfig::new("Hy-MT2-1.8B", Some("E:\\m\\a.gguf".into()));
        cfg.port = Some(8211);
        cfg.args = vec!["--ctx-size".into(), "4096".into()];
        // 手写进 args 的保留参数：读入时应被剥掉
        cfg.args.push("--port".into());
        cfg.args.push("9999".into());
        cfg.extra
            .insert("my_note".into(), Value::String("手写字段".into()));
        write(&path, &cfg).unwrap();

        let loaded = load(&path).unwrap();
        assert_eq!(loaded.config.name, "Hy-MT2-1.8B");
        assert_eq!(loaded.config.port, Some(8211));
        assert_eq!(loaded.config.host, "127.0.0.1");
        // 写盘时就剥掉了保留参数：磁盘上不该出现第二个 `--port`
        assert_eq!(loaded.config.args, vec!["--ctx-size", "4096"]);
        assert!(loaded.removed_args.is_empty());
        let raw = fs::read_to_string(&path).unwrap();
        assert!(!raw.contains("--port"), "写盘内容不得带保留参数：{raw}");
        // 未知字段活下来
        assert_eq!(
            loaded.config.extra.get("my_note"),
            Some(&Value::String("手写字段".into()))
        );

        // 用户手写进 args 的保留参数：读入时剥掉并回报
        fs::write(
            &path,
            r#"{"name":"Hy-MT2-1.8B","model":"E:\\m\\a.gguf","port":8211,"args":["--ctx-size","4096","--port","9999","--host=0.0.0.0"]}"#,
        )
        .unwrap();
        let handwritten = load(&path).unwrap();
        assert_eq!(handwritten.config.args, vec!["--ctx-size", "4096"]);
        assert_eq!(
            handwritten.removed_args,
            vec!["--port", "9999", "--host=0.0.0.0"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_keeps_one_previous_copy_in_bak() {
        let dir = temp_dir("bak");
        let path = path_for_id(&dir, "m");
        let mut first = ModelConfig::new("m", Some("E:\\m\\a.gguf".into()));
        first.port = Some(8211);
        write(&path, &first).unwrap();
        let mut second = ModelConfig::new("m", Some("E:\\m\\a.gguf".into()));
        second.port = Some(8212);
        write(&path, &second).unwrap();

        let bak = path.with_extension("json.bak");
        assert!(bak.exists(), "应留下一份上一状态的副本");
        let old: ModelConfig = serde_json::from_str(&fs::read_to_string(&bak).unwrap()).unwrap();
        assert_eq!(old.port, Some(8211));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_paths_skips_bak_and_foreign_files() {
        let dir = temp_dir("list");
        fs::create_dir_all(&dir).unwrap();
        write(&path_for_id(&dir, "b-model"), &ModelConfig::new("b-model", None)).unwrap();
        write(&path_for_id(&dir, "a-model"), &ModelConfig::new("a-model", None)).unwrap();
        fs::write(dir.join("settings.json"), "{}").unwrap();
        fs::write(dir.join("llamacpp-x.json.bak"), "{}").unwrap();
        fs::create_dir_all(dir.join(ORPHAN_SUBDIR)).unwrap();

        let names: Vec<String> = list_paths(&dir)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec!["llamacpp-a-model.json", "llamacpp-b-model.json"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_reports_broken_json_instead_of_defaulting() {
        let dir = temp_dir("broken");
        let path = path_for_id(&dir, "broken");
        fs::write(&path, "{ not json").unwrap();
        let err = load(&path).unwrap_err().to_string();
        assert!(err.contains("解析"), "错误里要能看出是解析失败：{err}");
        let _ = fs::remove_dir_all(&dir);
    }
}
