//! Strata 运行时通道：config 扫描、启停、状态探测、参数读写。
//!
//! 设计约束（见 `docs/archive/STRATA_INTEGRATION_PLAN.md` §7 升级解耦规则）：
//! - **R1 启动命令不自己拼**：从上游生成的 `run-<model>.bat` 解析，上游改了格式这里跟着变。
//! - **R2 零硬编码 + 零兜底**：根目录**只认用户在设置页指定的那个**（[`root`]），
//!   config / 引擎 / run 脚本都从它派生。不再猜 `%LOCALAPPDATA%\Strata` 之类的官方默认位置
//!   （用户 m00308）：Strata 装在哪只有用户知道，猜错只会读到一份不该读的目录。
//! - **R3 版本从运行时读**：`/props.build_info`，不缓存、不解析文件名。
//! - **R4 能力探测**：所有运行时字段都是 `Option`，端点缺失时降级而不是报错。
//! - **R6 受控写入 args**：只改已存在的 flag 值，绝不新增上游不认识的键。
//!
//! 与 router 通道的关键差异：
//! - 启动的是控制端的 `python.exe serve/server.py`，不是模型引擎；CUDA 由上游自带（config 的
//!   `lib_dirs`），**不做共享 CUDA 注入**，也**不做 junction 非 ASCII 修复**
//!   （venv 的 `pyvenv.cfg` 里 home 是绝对路径，换目录会让 venv 失效）。
//! - 官方安装布局（`setup.py` 产出，用户把根指到 `%LOCALAPPDATA%\Strata` 时）：
//!   `install\` 放 config 与 `run-*.bat`、`components\engine\<版本>-<平台>-<后端>\` 放引擎、
//!   `terminal\` 放控制端；config 的 `exe` 写 `component:strata-engine`（见 [`resolve_component`]）。
//!   数据目录不在这里，由 `%APPDATA%\Strata\settings.json` 的 `data_dir` 指定（[`data_dir`]）。
//! - 受保护端点有 `_own_page` Origin 防护，前端 fetch 必被 403，
//!   所以状态探测一律走 Rust 侧 [`crate::http`]。

use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::str::FromStr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
// `Manager` 是为了 `AppHandle::try_state`（崩溃监测里读 router 进程槽刷托盘菜单）。
use tauri::{AppHandle, Emitter, Manager};

use crate::http;
use crate::logs::{now_ms, spawn_pump, LogHub, LogLine};
use crate::winfix;

/// 端口就绪等待上限。Strata 的 HTTP 监听在模型加载前就绑好（Python 启动快，
/// 模型加载在 server 内部进行，期间 `/health` 返回 `loaded:false`），
/// 因此这里只等端口，不等模型。
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// 运行时探测的 HTTP 超时。
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

/// Strata 模型的端口基准：自动分配从 9091 起（用户 m05322）。
///
/// 与 llama.cpp 侧同一套规则（`model_config::allocate_port`，`PROXY_SCHEDULER_PLAN.md` §3.3）：
/// 从基准往上找第一个「没被别的 config 声明、也没被系统占用」的端口，找到上限就回退基准。
pub const STRATA_PORT_BASE: u16 = 9091;

/// 引擎/安装器给的默认端口（未定制）。用户 m05516：新建的 config 默认就是 8080，
/// 这种「没定制过」的端口也必须走自动分配 —— 否则三份新模型会全挤在 8080 上互相顶掉。
pub const STRATA_PORT_DEFAULT: u16 = 8080;

/// 一份 `strata-<model>.json` 的 GUI 视图。
///
/// 字段全部来自 config 文件本身（照抄上游 `setup.py:3673-3695 choices_from_config`），
/// 上游新增字段不影响这里：解析只取认识的键。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrataModelEntry {
    pub config_path: PathBuf,
    pub model_name: String,
    pub port: u16,
    pub host: String,
    /// 只暴露「有没有」，密钥原文不外泄给前端。
    pub has_api_key: bool,
    /// 顶层 `api_key`，供 Rust 侧探测时带鉴权头。
    #[serde(skip_serializing)]
    pub api_key: Option<String>,
    /// 引擎可执行文件的绝对路径。config 里写的是 `component:strata-engine` 时，
    /// 已由 [`resolve_component`] 展开成组件目录里的真实文件。
    pub engine: PathBuf,
    pub cwd: PathBuf,
    pub run_script: Option<PathBuf>,
    pub max_context: Option<String>,
    pub kv: Option<String>,
    pub kv_resident: Option<String>,
    pub vram_reserve_mib: Option<String>,
    pub vision: bool,
    pub gpu: Option<String>,
    pub prompt_cache: Option<String>,
    pub spec: Option<String>,
    /// args 里带 `--mtp <路径>` = 这套安装给这个模型装了 MTP 草稿权重（安装事实类，GUI 只读）。
    /// 只暴露「有没有」，路径原文不下沉给 WebView（与 `has_api_key` 同口径）。
    pub mtp: bool,
    /// config 文件的 mtime（毫秒），列表按它倒序（照抄 `setup.py:3723-3725`）。
    pub modified_ms: u64,
    /// `exe` 指向的引擎是否真的在：0.2.x 的组件引用要能解析出组件目录里的可执行文件，
    /// 0.1.x 的绝对路径要存在（升级中途失败时会是 false）。
    pub engine_exists: bool,
    /// 引擎版本：优先组件清单 `engine-component.json` 的 `version`，其次引擎同目录
    /// `BUILD.json` 的 `version`。运行时 `/props.build_info` 读的是同一个文件，
    /// 两处口径一致（R3：不长期缓存）。
    pub engine_version: Option<String>,
    /// 扫描时发现 config 里的 `exe` 不是当前安装的引擎（例如升级后换了版本子目录），
    /// 并已把它改写成新路径。false = 与当前组件一致，无需改动。
    pub engine_stale: bool,
    /// 模型文件路径，来自 args 的 `--native`。
    pub model_path: Option<PathBuf>,
    /// 模型实际字节数：分片模型（`-00001-of-00002.gguf`）聚合全部分片求和。
    pub model_size_bytes: Option<u64>,
    /// 模型架构，读 GGUF 头部的 `general.architecture`（`models::read_gguf_meta`）。
    /// 卡片图标要与模型列表页同语义，所以取架构而不是 ctx。
    pub architecture: Option<String>,
    /// 量化标识：优先 GGUF 头部 `file_type` 推导，取不到时从文件名 stem 兜底。
    pub quantization: Option<String>,
}

/// Strata 通道状态（前端状态条数据源）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrataStatus {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub config_path: Option<PathBuf>,
    pub model_name: Option<String>,
    pub started_at_ms: Option<u64>,
    pub last_error: Option<String>,
    /// 运行时版本，来自 `/props.build_info`（形如 `Strata 0.1.40.3`）。
    pub version: Option<String>,
    /// 运行时生效上下文，来自 `/health.max_context`。
    ///
    /// 与 config 里的 `--max-context` 不一致是常态（改了没重启），
    /// 前端要据此高亮「需重启生效」。
    pub live_max_context: Option<u64>,
    /// 模型是否已加载进显存（`/health.loaded`）。
    pub loaded: Option<bool>,
    pub busy: Option<bool>,
    pub prompt_tokens: Option<u64>,
    pub max_tokens: Option<u64>,
    /// 引擎是否支持重启式换模型（`/props.models_autoload`）。
    pub models_autoload: Option<bool>,
    /// 运行中的实例**不是本 GUI 启动的**（用户自己跑了 `run-<model>.bat` 等）。
    /// GUI 无法启停它，前端要据此禁用启停按钮并给出说明。
    pub external: bool,
    /// 前门代理是否在监听（用户 m00798）。
    ///
    /// 前门与引擎放在同一个快照里：前端胶囊、设置页、托盘都只读一处，也不用多开一路轮询。
    #[serde(default)]
    pub proxy: bool,
    /// 前门端口 —— **DSH 等客户端该连的就是它**（引擎端口只给 GUI 自己用）。
    #[serde(default)]
    pub proxy_port: Option<u16>,
    /// 前门当前正在服务的 config 文件名（`None` = 前门空闲或没开；用户 m01266 第 2 点）。
    ///
    /// 卡片据此显示「加载中」：请求是 DSH 发来的，GUI 的 `strataStarting` 只覆盖
    /// 「用户在本页点了启动」那条路径，所以必须由前门自己登记。
    #[serde(default)]
    pub proxy_serving: Option<String>,
}

impl Default for StrataStatus {
    fn default() -> Self {
        Self {
            running: false,
            port: 0,
            pid: None,
            config_path: None,
            model_name: None,
            started_at_ms: None,
            last_error: None,
            version: None,
            live_max_context: None,
            loaded: None,
            busy: None,
            prompt_tokens: None,
            max_tokens: None,
            models_autoload: None,
            external: false,
            proxy: false,
            proxy_port: None,
            proxy_serving: None,
        }
    }
}

/// 运行中的 Strata 进程。
#[allow(dead_code)]
pub struct StrataProcess {
    pub child: Child,
    pub port: u16,
    pub config_path: PathBuf,
    pub model_name: String,
    pub started_at_ms: u64,
    /// 运行时探测要带鉴权头，密钥只留在 Rust 侧。
    pub api_key: Option<String>,
}

/// 从 args 数组里取 `--flag <value>` 的值（照抄 `setup.py:3682` 的 `val()`）。
fn arg_value(args: &[serde_json::Value], flag: &str) -> Option<String> {
    let idx = args.iter().position(|a| a.as_str() == Some(flag))?;
    args.get(idx + 1)?.as_str().map(|s| s.to_string())
}

/// 上游 `setup.py:3656-3659 model_config_files` 的等价实现：
/// `strata-*.json` 且**排除 `.shared-settings.json` 后缀**。
///
/// 上游把 Chat 设置存进 `strata-<model>.shared-settings.json`，它匹配
/// `strata-*.json` 但不是 config，必须排除，否则列表里会出现假模型。
fn is_config_file(name: &str) -> bool {
    name.starts_with("strata-") && name.ends_with(".json") && !name.ends_with(".shared-settings.json")
}

/// 解析单份 config。照抄 `setup.py:3707-3720 model_config`（#549）的宽容语义：
/// 不是 JSON object、缺 `exe`、`args` 不是数组 → 返回 `None` 跳过，不报错。
///
/// `preferred` 是设置页「Strata 引擎版本」选定的那个可执行文件（用户 m04069：
/// **引擎由设置页决定**）。它存在时就是权威 —— 不管 config 里写的是什么，都用它，
/// 并把 config 的 `exe` 改回一致（否则引擎启动时读到的还是旧路径）。
fn parse_config(path: &Path, preferred: Option<&Path>) -> Option<StrataModelEntry> {
    let raw = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let obj = value.as_object()?;
    let engine = obj.get("exe")?.as_str()?.to_string();
    let args = obj.get("args")?.as_array()?.clone();

    let modified_ms = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let file_stem = path.file_stem()?.to_string_lossy().to_string();
    let slug = file_stem.strip_prefix("strata-").unwrap_or(&file_stem).to_string();
    let root = path.parent()?.to_path_buf();
    // 引擎路径（用户 m02686 / m02748 / m02795 / m04069 / m04888 / m00460）：
    // - **落盘一律写绝对路径**（用户 m04888：原本写 `component:strata-engine` 的也改成绝对路径）。
    //   引用仍然认：config 里若还是 `component:strata-engine`（旧的，或手工写的），扫描时在
    //   **同一个 Strata 根目录**下找版本最高的引擎解析成真实 exe，并**顺手把 config 改写成绝对路径**
    //   （用户 m00460：不再看控制器组件目录 `%LOCALAPPDATA%\Strata\components\engine`）。
    // - 绝对路径的优先级：设置页选定的引擎（`settings.strata_engine`）存在就用它并把 config 改回
    //   一致；没选过就尊重 config 里的路径；那个路径没了（升级删了旧版本目录）才跟到当前版本并写回。
    let reference = engine.starts_with("component:");
    let declared = PathBuf::from(&engine);
    let engine_path = if reference {
        resolve_component(&root, ENGINE_COMPONENT_ID)
            .map(|c| c.exe)
            .unwrap_or_else(|| declared.clone())
    } else {
        match preferred.filter(|p| p.is_file()) {
            Some(chosen) => chosen.to_path_buf(),
            None => {
                if declared.is_file() {
                    declared.clone()
                } else {
                    resolve_component(&root, ENGINE_COMPONENT_ID)
                        .map(|c| c.exe)
                        .unwrap_or_else(|| declared.clone())
                }
            }
        }
    };
    let engine_exists = engine_path.is_file();
    let engine_version =
        component_version_at(&engine_path).or_else(|| engine_version(&engine_path));
    // 引用是**合法形态**（现在的 config 都写 `component:strata-engine`；设置页 2026-10-25 起不再让用户选引擎），写的就是
    // `component:strata-engine`，由控制器的组件目录决定实际版本），所以只解析、不改写；
    // 只有绝对路径才按「设置页选定 / 声明仍在 / 跟当前版本」的规则改写。
    let engine_stale = !reference && engine_path != declared;
    if engine_stale {
        // 只改 `exe` 与 `vision.exe` 的值，其余键原样保留；写失败时保留原值（下次扫描再试）。
        // vision 一起同步：引擎包是「一个版本一个目录」，视觉跑旧目录会加载旧 DLL。
        let next_exe = engine_path.to_string_lossy().to_string();
        let edits = engine_edits(&value, &engine, &next_exe, &engine_path);
        if !edits.is_empty() {
            let refs: Vec<(&str, &str)> = edits.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            let _ = rewrite_config_strings(path, &refs);
        }
    }
    let model_path = arg_value(&args, "--native").map(PathBuf::from);
    let model_size_bytes = model_path.as_ref().and_then(|p| model_size_bytes(p));
    // 架构与量化：只读 GGUF 头部（`read_gguf_meta` 凑齐 architecture + file_type 就停），
    // 对 75 GB 的分片模型也是常数级开销。卡片图标要与模型列表页同语义。
    let gguf_meta = model_path
        .as_ref()
        .filter(|p| p.exists())
        .map(|p| crate::models::read_gguf_meta(p));
    let architecture = gguf_meta
        .as_ref()
        .and_then(|m| m.architecture.clone());
    let quantization = gguf_meta
        .as_ref()
        .and_then(|m| m.quantization().map(str::to_owned))
        .or_else(|| {
            model_path
                .as_ref()
                .and_then(|p| p.file_stem())
                .and_then(|s| crate::models::detect_quantization(&s.to_string_lossy()))
        });

    let vision = obj
        .get("vision")
        .and_then(|v| v.as_object())
        .map(|v| !v.is_empty())
        .unwrap_or(false);

    Some(StrataModelEntry {
        config_path: path.to_path_buf(),
        model_name: obj
            .get("model_name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| slug.clone()),
        port: obj
            .get("port")
            .and_then(|v| v.as_u64())
            .and_then(|v| u16::try_from(v).ok())
            // 0 = 还没分配（用户 m05322：端口由 GUI 自动分配，启动时补）
            .unwrap_or(0),
        host: obj
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1")
            .to_string(),
        has_api_key: obj
            .get("api_key")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        api_key: obj.get("api_key").and_then(|v| v.as_str()).map(|s| s.to_string()),
        engine: engine_path,
        cwd: obj
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| root.clone()),
        run_script: find_run_script(&root, &slug),
        max_context: arg_value(&args, "--max-context"),
        kv: arg_value(&args, "--kv"),
        kv_resident: arg_value(&args, "--kv-resident"),
        vram_reserve_mib: arg_value(&args, "--vram-reserve-mib"),
        vision,
        gpu: obj.get("gpu").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| {
            obj.get("gpu")
                .and_then(|v| v.as_i64())
                .map(|v| v.to_string())
        }),
        prompt_cache: arg_value(&args, "--prompt-cache"),
        spec: arg_value(&args, "--spec"),
        mtp: arg_value(&args, "--mtp").is_some(),
        modified_ms,
        engine_exists,
        engine_version,
        engine_stale,
        model_path,
        model_size_bytes,
        architecture,
        quantization,
    })
}

/// 解析 GGUF 分片命名 `<base>-00001-of-00002.gguf`，返回 (base, 序号, 总分片数)。
/// 非分片命名返回 `None`（单文件模型）。
fn shard_info(name: &str) -> Option<(String, u32, u32)> {
    let core = name.strip_suffix(".gguf")?;
    let (head, total_s) = core.rsplit_once("-of-")?;
    let total: u32 = total_s.parse().ok()?;
    let (base, idx_s) = head.rsplit_once('-')?;
    let index: u32 = idx_s.parse().ok()?;
    if base.is_empty() || total == 0 {
        return None;
    }
    Some((base.to_string(), index, total))
}

/// 模型实际占用字节数。分片模型按 `-NNNNN-of-NNNNN.gguf` 枚举全部分片求和
/// （`.done` 这类校验附属文件不在枚举里，不计入）；分片缺失时只累加存在的分片，
/// 一个都不存在则返回 `None`。
fn model_size_bytes(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let Some((base, _index, total)) = shard_info(&name) else {
        return fs::metadata(path).ok().map(|m| m.len());
    };
    let dir = path.parent()?;
    let mut sum = 0u64;
    for i in 1..=total {
        let p = dir.join(format!("{base}-{i:05}-of-{total:05}.gguf"));
        if let Ok(m) = fs::metadata(&p) {
            sum = sum.saturating_add(m.len());
        }
    }
    (sum > 0).then_some(sum)
}

/// 本机平台标识，与组件清单里的 `platform` 同格式（`windows-x86_64`）。
fn host_platform() -> String {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "unknown"
    };
    format!("{os}-{arch}")
}

/// 组件版本号的可排序键：`0.1.46` → `[0, 1, 46]`（非数字段按 0，与上游
/// `engine_component._version_key` 同口径）。
fn version_key(value: &str) -> Vec<u64> {
    value
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect()
}

/// 在安装目录下找引擎（**不认目录名**），并补上 Strata 控制器自己的组件目录。
///
/// 0.2.x（control 0.1.46 起）把引擎拆成**独立组件**：可执行文件在某个目录下的
/// `<version>-<platform>-<backend>/` 里，文件名由 `engine-component.json` 的 `entrypoint`
/// 指名。官方安装器把它放在 `components\engine\` 下，但目录名不硬编码（用户 m04258
/// 「不要硬编码，就在根目录下查找」）：从安装目录自身、它的一级子目录、以及这些子目录的
/// 直接子目录里找**引擎文件**（`engine-component.json` 或 `strata.exe`），有就算一个引擎目录。
/// 一个根目录下所有引擎版本目录（版本目录里得有 `engine-component.json` / `strata.exe`）。
///
/// **只看给定的根目录**（用户 m00460：不考虑控制器组件目录 `STRATA_COMPONENTS_DIR` /
/// `%LOCALAPPDATA%\Strata\components\engine`）—— 用户手动解压的根 `E:\AI\strata` 下
/// 已有 `engine\<版本>-…`，再把官方组件目录并进来只会让设置页出现指向别处的重复行。
/// 官方布局的 `<根>\components\engine\<版本>` 本来就会被下面的两层子目录扫描命中。
fn engine_folders(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if is_engine_dir(root) {
        out.push(root.to_path_buf());
        seen.insert(root.to_path_buf());
    } else {
        for first in subdirs(root) {
            if is_engine_dir(&first) {
                if seen.insert(first.clone()) {
                    out.push(first);
                }
                continue;
            }
            for second in subdirs(&first) {
                if is_engine_dir(&second) && seen.insert(second.clone()) {
                    out.push(second);
                }
            }
        }
    }
    out
}

/// 用户指定的根目录（`settings.json` 的 `strata_root`）；`None` = 还没指定。
///
/// **没有默认值、没有兜底**（用户 m00308）：Strata 装在哪由用户说了算，不去猜
/// `%LOCALAPPDATA%\Strata` 之类的官方安装位置 —— 猜错时界面会读到一份本不该读的目录，
/// 比「提示用户去设置」更糟。没指定时 [`root`] 返回 `None`，调用方一律按
/// 「尚未设置 Strata 目录」处理。
///
/// 放全局而不是塞进 `AppState`：`strata.rs` / `strata_tune.rs` / `strata_proxy.rs` 里有
/// 四十多处「就地推导根目录」的调用，它们都拿不到 `AppState`。
static ROOT_OVERRIDE: std::sync::OnceLock<std::sync::RwLock<Option<PathBuf>>> =
    std::sync::OnceLock::new();

fn root_override() -> &'static std::sync::RwLock<Option<PathBuf>> {
    ROOT_OVERRIDE.get_or_init(|| std::sync::RwLock::new(None))
}

/// 设置自定义根目录（空路径 / `None` = 清空，于是 [`root`] 返回 `None`）。
///
/// 调用方负责让扫描缓存失效：缓存里带着扫描时的 `root`，换根之后自然对不上。
pub fn configure_root(root: Option<PathBuf>) {
    let mut guard = root_override()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    *guard = root.filter(|dir| !dir.as_os_str().is_empty());
}

/// 当前生效的 Strata 根目录：**只有用户在设置页指定的那一个**，没指定就是 `None`。
pub fn root() -> Option<PathBuf> {
    root_override()
        .read()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
}

/// config 与 `run-*.bat` 所在目录。
///
/// - **用户指定了 Strata 目录时，就是那个目录本身**（用户 m00717：手动解压的
///   `E:\AI\strata` 把 `run-*.bat` / `strata-*.json` 直接放在根下；此时不再去猜
///   `<根>\install`，免得用户目录里恰好有个 `install` 就被当成配置目录）。
/// - 只有单测/诊断显式传 `configured=false` 时才看 `<根>\install`。
pub fn configs_dir(root: &Path) -> PathBuf {
    configs_dir_with(root, root_is_configured())
}

/// 用户是否指定过 Strata 目录（现在只剩「指定过」和「没指定」两种，`root()` 有值就是指定过）。
fn root_is_configured() -> bool {
    ROOT_OVERRIDE
        .get()
        .map(|slot| {
            slot.read()
                .unwrap_or_else(|err| err.into_inner())
                .is_some()
        })
        .unwrap_or(false)
}

/// [`configs_dir`] 的实现体：`configured` 由调用方给，单测才能不碰全局静态。
fn configs_dir_with(root: &Path, configured: bool) -> PathBuf {
    if configured {
        return root.to_path_buf();
    }
    let install = root.join("install");
    if install.is_dir() {
        install
    } else {
        root.to_path_buf()
    }
}

/// 用户在设置页选中的控制器版本目录名（`settings.json` 的 `strata_controller`）。
///
/// 与 [`ROOT_OVERRIDE`] 同一个道理：回退启动路径（[`fallback_command`]）与
/// [`crate::strata_tune::terminal_dir`] 都拿不到 `AppState`。
static CONTROLLER_OVERRIDE: std::sync::OnceLock<std::sync::RwLock<Option<String>>> =
    std::sync::OnceLock::new();

fn controller_override() -> &'static std::sync::RwLock<Option<String>> {
    CONTROLLER_OVERRIDE.get_or_init(|| std::sync::RwLock::new(None))
}

/// 记住用户选中的控制器版本（`None` / 空串 = 跟着 `active.json` 走）。
pub fn configure_controller(version: Option<String>) {
    let mut guard = controller_override()
        .write()
        .unwrap_or_else(|err| err.into_inner());
    *guard = version.filter(|v| !v.trim().is_empty());
}

/// 用户选中的控制器版本目录名。
pub fn controller_preference() -> Option<String> {
    controller_override()
        .read()
        .unwrap_or_else(|err| err.into_inner())
        .clone()
}

/// 控制器版本目录的父目录：手动解压布局是 `<根>\control`，官方安装器是 `<根>\terminal`。
///
/// 两种布局可能同时存在（官方安装 + 手动解压到同一根），优先 `control`（用户手动解的
/// 那一份才是他要求 GUI 用的）。
pub fn controllers_dir(root: &Path) -> PathBuf {
    let control = root.join("control");
    if control.is_dir() {
        return control;
    }
    root.join("terminal")
}

/// 一个目录是不是控制器版本目录：带 `serve\server.py` 或 `strata.py` 即算。
fn is_controller_dir(dir: &Path) -> bool {
    dir.join("serve").join("server.py").is_file() || dir.join("strata.py").is_file()
}

/// 设置页「Strata 控制器版本」列表的一行。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerInfo {
    /// 版本目录名（`0.1.51`）。
    pub version: String,
    pub folder: PathBuf,
    /// 目录里有自带的解释器（`python\python.exe`）。
    pub python: bool,
    /// 目录里有 `serve\server.py`。
    pub server: bool,
    /// `active.json` 记的当前版本。
    pub active: bool,
    /// 能用：带解释器 + `serve\server.py`。
    pub usable: bool,
}

/// 列出根目录下并存的控制器版本，新的在前。
pub fn list_controllers(root: &Path) -> Vec<ControllerInfo> {
    let base = controllers_dir(root);
    let active = active_control_folder(&base);
    let py_name = crate::strata_tune::python_name();
    let mut out: Vec<ControllerInfo> = subdirs(&base)
        .into_iter()
        .filter(|dir| is_controller_dir(dir))
        .filter_map(|dir| {
            let version = dir.file_name()?.to_string_lossy().to_string();
            let python = dir.join("python").join(py_name).is_file();
            let server = dir.join("serve").join("server.py").is_file();
            Some(ControllerInfo {
                active: active.as_deref() == Some(version.as_str()),
                version,
                python,
                server,
                usable: python && server,
                folder: dir,
            })
        })
        .collect();
    out.sort_by(|a, b| version_key(&b.version).cmp(&version_key(&a.version)));
    out
}

/// 定位某个控制器版本目录（`control\<版本>` 或 `terminal\<版本>`）。
pub fn controller_dir(root: &Path, version: &str) -> Option<PathBuf> {
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    let dir = controllers_dir(root).join(version);
    is_controller_dir(&dir).then_some(dir)
}

/// 当前该用哪个控制器：用户选的 → 最高版本（能用的优先）→ `active.json`。
///
/// 顺序是用户 m00875 定的：**默认用最新的控制器**，只有用户手动选过别的版本才用它。
/// `active.json` 只作最后的兜底 —— 手动解压的目录里它不会自动更新，拿它当首选会用回旧版本。
pub fn preferred_controller(root: &Path) -> Option<PathBuf> {
    if let Some(version) = controller_preference() {
        if let Some(dir) = controller_dir(root, &version) {
            return Some(dir);
        }
    }
    if let Some(newest) = list_controllers(root).into_iter().find(|info| info.usable) {
        return Some(newest.folder);
    }
    let base = controllers_dir(root);
    active_control_folder(&base).and_then(|folder| {
        let dir = base.join(&folder);
        is_controller_dir(&dir).then_some(dir)
    })
}

/// 选中控制器版本后重写 bat 与 config 的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyControllerResult {
    pub version: String,
    pub folder: PathBuf,
    /// 重写过的 `run-*.bat` 文件名。
    pub scripts: Vec<String>,
    /// 改过 `cwd` / `args` 的 config 文件名。
    pub configs: Vec<String>,
}

/// 把根目录下所有 `run-*.bat` 与 `strata-*.json` 切到指定控制器版本。
///
/// 改两处：
/// - `run-*.bat`：启动行的解释器与 `serve\server.py` 换成新版本目录里的，
///   `cd /d` 切到新版本目录；非 serve 侧参数（引擎自己的 `--expert-profile` 等）留在 config 里。
/// - `strata-*.json`：顶层 `cwd` 指向新版本目录，`args` 里 `--expert-profile` 若位于
///   其它版本目录的 `data\` 下就跟着换到新目录（同名文件）。
///
/// 任何一份写失败都整批报错（与 [`apply_engine`] 同口径）：切一半的安装比不切更难查。
pub fn apply_controller(
    root: &Path,
    version: &str,
) -> std::result::Result<ApplyControllerResult, String> {
    let dir = controller_dir(root, version)
        .ok_or_else(|| format!("控制器版本 {version} 不存在（缺 serve/server.py）"))?;
    let py_name = crate::strata_tune::python_name();
    let python = dir.join("python").join(py_name);
    if !python.is_file() {
        return Err(format!(
            "控制器 {} 缺少自带的解释器：{}",
            version,
            python.display()
        ));
    }
    let configs = configs_dir(root);
    // 整批回滚用：每份即将被改写的文件先留一份内存快照，任何一步失败就全部恢复。
    // 以前切一半就返回错误：run-*.bat 已经指向新目录、部分 config 还指着旧的，引擎直接起不来，
    // 而用户只看到一句错误（审查发现）。
    let mut backups: Vec<(PathBuf, String)> = Vec::new();
    let mut scripts = Vec::new();
    for name in run_script_names(&configs) {
        let path = configs.join(&name);
        let original = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => return Err(format!("{name}: {err}")),
        };
        if let Err(err) = rewrite_run_script(&path, &dir, &configs) {
            restore_files(&backups);
            return Err(format!("{name}: {err}"));
        }
        backups.push((path, original));
        scripts.push(name);
    }
    let mut changed = Vec::new();
    for path in config_files(&configs) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let raw = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(err) => {
                restore_files(&backups);
                return Err(format!("读 {name} 失败: {err}"));
            }
        };
        let json: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(err) => {
                restore_files(&backups);
                return Err(format!("{name} 不是合法 JSON: {err}"));
            }
        };
        let target = dir.to_string_lossy().to_string();
        let mut edits: Vec<(String, String)> = Vec::new();
        if let Some(old) = json.get("cwd").and_then(|value| value.as_str()) {
            if old != target {
                edits.push((old.to_string(), target.clone()));
            }
        }
        if let Some(old) = controller_data_arg(&json) {
            if let Some(file) = controller_data_file_name(Path::new(&old)) {
                let next = dir.join("data").join(file);
                let next_text = next.to_string_lossy().to_string();
                // 新版本目录里没有同名文件就别改：改指过去只会让引擎起不来
                if next.is_file() && next_text != old {
                    edits.push((old, next_text));
                }
            }
        }
        if edits.is_empty() {
            continue;
        }
        // 走文本替换（[`rewrite_config_strings`]）：config 的键序与 1 空格缩进是上游
        // `setup.py` 写的，序列化回写会把整份文件重排。
        let pairs: Vec<(&str, &str)> = edits
            .iter()
            .map(|(old, next)| (old.as_str(), next.as_str()))
            .collect();
        if let Err(err) = rewrite_config_strings(&path, &pairs) {
            restore_files(&backups);
            return Err(format!("{name}: {err:#}"));
        }
        backups.push((path, raw));
        changed.push(name);
    }
    Ok(ApplyControllerResult {
        version: version.trim().to_string(),
        folder: dir,
        scripts,
        configs: changed,
    })
}

/// 把 `apply_controller` 已经改过的文件按内存快照写回去。
///
/// 回滚本身再失败只记日志 —— 主错误已经往上抛了，这里再抛会把真正的原因盖掉。
fn restore_files(backups: &[(PathBuf, String)]) {
    for (path, text) in backups {
        if let Err(err) = write_text_atomic(path, text) {
            eprintln!("[strata] 回滚 {} 失败: {err:#}", path.display());
        }
    }
}

/// 打开控制端自带的安装向导（`setup.py --setup`）。
///
/// 上游加模型只有这一条路：向导自己让用户选模型、选卡、写 `strata-<id>.json` 与 `run-<id>.bat`，
/// 还带试启动。它是交互式 TUI，塞不进 GUI，所以这里开一个新的控制台窗口跑，工作目录设成控制器目录
/// （`setup.py` 靠自己的位置推 ROOT，换目录就装错地方）。
///
/// 返回控制器目录（前端拿来提示用户）。
pub fn open_setup() -> std::result::Result<String, String> {
    let root = root().ok_or_else(|| "还没指定 Strata 目录：先到设置页填好再添加模型".to_string())?;
    let dir = preferred_controller(&root)
        .ok_or_else(|| format!("{} 下没有可用的控制器版本", root.display()))?;
    let script = dir.join("setup.py");
    if !script.is_file() {
        return Err(format!("控制器缺少 setup.py：{}", script.display()));
    }
    let python = dir.join("python").join(crate::strata_tune::python_name());
    if !python.is_file() {
        return Err(format!(
            "控制器缺少自带的解释器：{}",
            python.display()
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_CONSOLE：向导要真终端（问选项、画进度），不能继承本进程隐藏的控制台
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        // 路径直接拼进 `cmd /k` 命令串：含引号或 cmd 元字符（% & | ^ < >）会把命令拆坏，
        // 复用 winfix::cmd_path 的同一套判断（审查发现）
        let python_arg = crate::winfix::cmd_path(&python)
            .map_err(|err| format!("打开安装向导失败：{err}"))?;
        let script_arg = crate::winfix::cmd_path(&script)
            .map_err(|err| format!("打开安装向导失败：{err}"))?;
        std::process::Command::new("cmd.exe")
            .current_dir(&dir)
            .arg("/k")
            .arg(format!("\"{python_arg}\" \"{script_arg}\" --setup"))
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|err| format!("打开安装向导失败：{err}"))?;
        Ok(dir.display().to_string())
    }
    #[cfg(not(windows))]
    {
        Err("当前系统不支持在 GUI 里打开安装向导".to_string())
    }
}

/// `configs_dir` 下的 `run-*.bat` / `run-*.sh`。
fn run_script_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_ascii_lowercase();
            (lower.starts_with("run-") && (lower.ends_with(".bat") || lower.ends_with(".sh")))
                .then_some(name)
        })
        .collect();
    out.sort();
    out
}

/// `configs_dir` 下的 `strata-*.json`。
fn config_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .map(|n| is_config_file(&n.to_string_lossy()))
                    .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

/// `args` 里指向控制器数据目录的路径参数（目前只有 `--expert-profile`）。
///
/// 上游 `setup.py:9542` 把它写成 `<根>\control\<版本>\data\expert-profile.bin`，
/// 换控制器版本时这个路径得跟着换。
fn controller_data_arg(json: &serde_json::Value) -> Option<String> {
    let args = json.get("args")?.as_array()?;
    let pos = args
        .iter()
        .position(|value| value.as_str() == Some("--expert-profile"))?;
    args.get(pos + 1)?.as_str().map(|value| value.to_string())
}

/// `<…>\control\<版本>\data\<文件>` / `<…>\terminal\<版本>\data\<文件>` → `Some("<文件>")`。
fn controller_data_file_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let parent = path.parent()?;
    if parent.file_name()?.to_string_lossy().to_ascii_lowercase() != "data" {
        return None;
    }
    let version_dir = parent.parent()?;
    let base = version_dir.parent()?;
    let base_name = base.file_name()?.to_string_lossy().to_ascii_lowercase();
    (base_name == "control" || base_name == "terminal").then_some(name)
}

/// 重写一份 `run-*.bat`：解释器、`server.py`、工作目录与 `--config` 都指向新位置。
///
/// 按子串替换而不是重排整行：脚本里的其它参数（`--open` / `--host` …）与行首前缀
/// （`start "" /b` 一类）原样保留 —— 整行重建等于把脚本改回上游模板，用户自己加的
/// 东西会静默消失。行尾风格沿用原文件（上游写的是 CRLF）。
fn rewrite_run_script(
    path: &Path,
    dir: &Path,
    configs_dir: &Path,
) -> std::result::Result<(), String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("读 {} 失败: {err}", path.display()))?;
    let crlf = raw.contains("\r\n");
    let py_name = crate::strata_tune::python_name();
    let python = dir.join("python").join(py_name);
    let server_py = dir.join("serve").join("server.py");
    // 脚本同名 config（`run-<slug>.bat` → `strata-<slug>.json`）：启动行里的 `--config`
    // 若还指着官方安装目录，只换控制器版本跑起来读的还是旧 config，所以一并换掉。
    let own_config = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .and_then(|stem| stem.strip_prefix("run-").map(|slug| slug.to_string()))
        .map(|slug| configs_dir.join(format!("strata-{slug}.json")))
        .filter(|candidate| candidate.is_file());
    let mut out = String::new();
    let mut rewrote = false;
    for line in raw.split_inclusive('\n') {
        let body = line.trim_end_matches(['\r', '\n']).to_string();
        let trimmed = body.trim();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("cd ") || lower.starts_with("cd/") {
            let next = match cd_path(trimmed) {
                Some(old) => replace_first(&body, &old, &dir.to_string_lossy()),
                None => format!("cd /d \"{}\"", dir.display()),
            };
            out.push_str(&next);
            if crlf {
                out.push('\r');
            }
            out.push('\n');
            continue;
        }
        if !trimmed.is_empty() && lower.contains("server.py") && !rewrote {
            let tokens = quote_tokens(trimmed);
            let Some(server_idx) = tokens
                .iter()
                .position(|t| t.to_ascii_lowercase().ends_with("server.py"))
            else {
                out.push_str(line);
                continue;
            };
            let mut next = body.clone();
            next = replace_first(&next, &tokens[server_idx], &server_py.to_string_lossy());
            // 解释器：`server.py` 之前最近的一个「像解释器」的 token
            if let Some(interp) = tokens[..server_idx]
                .iter()
                .rev()
                .find(|t| looks_like_python(t))
            {
                next = replace_first(&next, interp, &python.to_string_lossy());
            }
            if let Some(pos) = tokens.iter().position(|t| t == "--config") {
                if let (Some(old), Some(cfg)) = (tokens.get(pos + 1), own_config.as_ref()) {
                    next = replace_first(&next, old, &cfg.to_string_lossy());
                }
            }
            out.push_str(&next);
            if crlf {
                out.push('\r');
            }
            out.push('\n');
            rewrote = true;
            continue;
        }
        out.push_str(line);
    }
    if !rewrote {
        return Err("脚本里没有 server.py 启动行".to_string());
    }
    // 内容没变就不写：设置页每次进来都会对齐最新版本，无谓的写会刷 mtime、惊动别的监听者。
    if out == raw {
        return Ok(());
    }
    // 原子替换 + 备份：原来直接 `fs::write`，写一半失败（磁盘满/被杀毒锁住）脚本就残了，
    // 模型再也起不来，还没有备份可恢复（审查发现）。
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let backup = path.with_file_name(format!("{name}.bak"));
    if let Err(err) = fs::copy(path, &backup) {
        return Err(format!("备份 {} 失败: {err}", backup.display()));
    }
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    if let Err(err) = fs::write(&tmp, &out) {
        return Err(format!("写临时文件 {} 失败: {err}", tmp.display()));
    }
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("替换 {} 失败: {err}", path.display()));
    }
    Ok(())
}

/// 一个 `cd` 行指向的路径（带引号取引号内，否则取最后一个空白之后）。
fn cd_path(line: &str) -> Option<String> {
    if let Some(start) = line.find('"') {
        let rest = &line[start + 1..];
        return rest.find('"').map(|end| rest[..end].to_string());
    }
    line.split_whitespace().last().map(|token| token.to_string())
}

/// 这个 token 看起来是 python 解释器（`python.exe` / `…\python`）。
fn looks_like_python(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.ends_with("python.exe") || lower.ends_with("\\python") || lower.ends_with("/python")
}

/// 只替换第一处出现；新旧相同或找不到时原样返回。
fn replace_first(text: &str, old: &str, new: &str) -> String {
    if old.is_empty() || old == new {
        return text.to_string();
    }
    match text.find(old) {
        Some(pos) => {
            let mut out = text.to_string();
            out.replace_range(pos..pos + old.len(), new);
            out
        }
        None => text.to_string(),
    }
}

/// 目录下的直接子目录（按名字排序，结果稳定）。
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = read_dir
        .flatten()
        .map(|item| item.path())
        .filter(|path| path.is_dir())
        .collect();
    out.sort();
    out
}

/// 去重用的路径键：能解析符号链接 / 目录联结就解析，否则用原路径。
///
/// `%LOCALAPPDATA%\Strata\components\engine` 是指向 `E:\AI\Strata\engine` 的目录联结
/// （用户 2026-10-22 的会话建的），不解析的话同一个引擎会在列表里出现两次。
fn canonical_key(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// 这个目录是不是一个引擎目录（组件清单或引擎可执行文件在里面）。
fn is_engine_dir(dir: &Path) -> bool {
    dir.join("engine-component.json").is_file()
        || dir.join("strata.exe").is_file()
        || dir.join("strata").is_file()
}

/// 解析出来的引擎组件。
pub struct EngineComponent {
    /// 可执行文件（清单 `entrypoint` 指向的那个，绝对路径）。
    pub exe: PathBuf,
}

/// Strata 引擎组件的 id（`component:strata-engine` 里那一段）。
const ENGINE_COMPONENT_ID: &str = "strata-engine";

/// 把 config 里的 `component:<id>` 解析成真正的引擎可执行文件。
///
/// 选包规则照上游 `engine_component.resolve()` 的要点：清单里的 `id` 要对得上、
/// `platform` 要是本机、版本取最高；同版本多后端时优先 `cuda` 目录（本机是 N 卡）。
/// 没有清单的目录按 0.1.x 的单目录布局处理（直接找 `strata.exe`），这样旧安装不会
/// 因为升级到新 GUI 而失效。
fn resolve_component(root: &Path, id: &str) -> Option<EngineComponent> {
    resolve_component_in(&engine_folders(root), id)
}

/// [`resolve_component`] 的实现体：候选目录由调用方给，单测才能不碰真实安装。
fn resolve_component_in(dirs: &[PathBuf], id: &str) -> Option<EngineComponent> {
    let entry_name = if cfg!(windows) { "strata.exe" } else { "strata" };
    let platform = host_platform();
    let mut best: Option<(Vec<u64>, bool, EngineComponent)> = None;
    for folder in dirs {
        let manifest = fs::read_to_string(folder.join("engine-component.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let (exe_name, version) = match &manifest {
            Some(m) => {
                // schema 2 带 id；schema 1 没有，就不按 id 过滤
                if let Some(found) = m.get("id").and_then(|v| v.as_str()) {
                    if found != id {
                        continue;
                    }
                }
                // 平台字段存在时必须匹配本机，别把 Linux 包当成能跑的
                if let Some(found) = m.get("platform").and_then(|v| v.as_str()) {
                    if found != platform {
                        continue;
                    }
                }
                (
                    m.get("entrypoint")
                        .and_then(|v| v.as_str())
                        .unwrap_or(entry_name)
                        .to_string(),
                    m.get("version")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                )
            }
            None => (entry_name.to_string(), None),
        };
        let exe = folder.join(&exe_name);
        if !exe.is_file() {
            continue;
        }
        let version = version.or_else(|| engine_version(&exe));
        let cuda = folder.to_string_lossy().contains("cuda");
        let key = version_key(version.as_deref().unwrap_or("0"));
        let better = match &best {
            None => true,
            Some((best_key, best_cuda, _)) => (&key, cuda) > (best_key, *best_cuda),
        };
        if better {
            best = Some((key, cuda, EngineComponent { exe }));
        }
    }
    best.map(|(_, _, component)| component)
}

/// 引擎组件清单（引擎同目录的 `engine-component.json`）里的版本。
fn component_version_at(exe: &Path) -> Option<String> {
    let raw = fs::read_to_string(exe.parent()?.join("engine-component.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("version")?.as_str().map(|s| s.to_string())
}

/// 一份可选引擎（`components\engine\` 下的一个版本目录），供前端列出让用户挑选。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub version: Option<String>,
    pub platform: Option<String>,
    pub backend: Option<String>,
    pub build: Option<String>,
    pub archs: Vec<String>,
    pub exe: PathBuf,
}

/// 列出安装目录下所有可用的引擎组件，版本倒序。
///
/// 升级会把新版本目录加进来、旧的不一定删，所以这里可能有多份；前端让用户选，
/// 选中的写进 config 的 `exe`（`strata_set_engine`）。候选目录与解析用的是同一套
/// [`engine_folders`]（按引擎文件找，不认目录名；官方布局在 `components\engine\` 下）。
pub fn list_engines(root: &Path) -> Vec<EngineInfo> {
    list_engines_with(root)
}

fn list_engines_with(root: &Path) -> Vec<EngineInfo> {
    let entry_name = if cfg!(windows) { "strata.exe" } else { "strata" };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for folder in engine_folders(root) {
        let manifest = fs::read_to_string(folder.join("engine-component.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
        let exe_name = manifest
            .as_ref()
            .and_then(|m| m.get("entrypoint").and_then(|v| v.as_str()))
            .unwrap_or(entry_name);
        let exe = folder.join(exe_name);
        if !exe.is_file() {
            continue;
        }
        if !seen.insert(canonical_key(&exe)) {
            continue;
        }
        let text = |key: &str| {
            manifest
                .as_ref()
                .and_then(|m| m.get(key).and_then(|v| v.as_str()))
                .map(|s| s.to_string())
        };
        out.push(EngineInfo {
            version: text("version").or_else(|| engine_version(&exe)),
            platform: text("platform"),
            backend: text("backend"),
            build: text("build_id"),
            archs: manifest
                .as_ref()
                .and_then(|m| m.get("archs").and_then(|v| v.as_array()))
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            exe,
        });
    }
    out.sort_by(|a, b| {
        version_key(b.version.as_deref().unwrap_or("0"))
            .cmp(&version_key(a.version.as_deref().unwrap_or("0")))
    });
    out
}

/// 引擎版本：优先组件清单的 `version`（由 [`resolve_component`] 填），
/// 其次引擎同目录 `BUILD.json` 的 `version`（形如 `0.1.41`）。
fn engine_version(exe: &Path) -> Option<String> {
    let raw = fs::read_to_string(exe.parent()?.join("BUILD.json")).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()?
        .get("version")?
        .as_str()
        .map(|s| s.to_string())
}

/// 找上游生成的启动脚本（`setup.py:4373-4386 write_run_script`）。
///
/// 脚本跟 config 放在一起（官方布局 `<根>\install\run-<slug>.bat`），所以这里也走
/// [`configs_dir`]，和 config 扫描用同一个目录。
fn find_run_script(root: &Path, slug: &str) -> Option<PathBuf> {
    let dir = configs_dir(root);
    let bat = dir.join(format!("run-{slug}.bat"));
    if bat.exists() {
        return Some(bat);
    }
    let sh = dir.join(format!("run-{slug}.sh"));
    if sh.exists() {
        return Some(sh);
    }
    None
}

/// `strata-<model>.json` → `(根目录, 文件名, slug)`。
fn split_config_path(path: &Path) -> Option<(PathBuf, String, String)> {
    let root = path.parent()?.to_path_buf();
    let name = path.file_name()?.to_string_lossy().to_string();
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let slug = stem.strip_prefix("strata-").unwrap_or(&stem).to_string();
    Some((root, name, slug))
}

/// 给一份 strata config 挑端口（用户 m05322：从 [`STRATA_PORT_BASE`] 起，逻辑同 llama.cpp）。
///
/// 跳过两类端口：别的 config 已经声明过的、系统已被占用的。`config_file` 自身要排除，
/// 否则它自己声明的那个端口会被当成「别人占着」。
pub fn allocate_port(root: &Path, config_file: &str) -> u16 {
    let declared: Vec<u16> = scan_configs(root, None)
        .iter()
        .filter(|e| !e.config_path.ends_with(config_file))
        .map(|e| e.port)
        .filter(|p| *p != 0)
        .collect();
    let limit = STRATA_PORT_BASE.saturating_add(200);
    let mut port = STRATA_PORT_BASE;
    while port < limit {
        if !declared.contains(&port) && !winfix::port_in_use(port) {
            return port;
        }
        port += 1;
    }
    STRATA_PORT_BASE
}

/// 把 `run-<slug>.bat` 里的 `--port` 改成新值（找不到脚本就跳过）。
///
/// 不改 `--port` 前面的引号与空白格式：只替换数字本身，其余字节原样。
fn sync_run_script(root: &Path, slug: &str, port: u16) -> Result<()> {
    let Some(script) = find_run_script(root, slug) else {
        return Ok(());
    };
    let raw = fs::read_to_string(&script)
        .with_context(|| format!("读 {} 失败", script.display()))?;
    let Some(pos) = raw.find("--port") else {
        return Ok(());
    };
    // 跳过 `--port` 这六个字节本身：后面只允许「引号/空白 + 数字」，
    // 否则命中的是 `--port-mib` 这类同前缀参数
    let tail = &raw[pos + 6..];
    let Some(offset) = tail.find(|c: char| c.is_ascii_digit()) else {
        return Ok(());
    };
    if !tail[..offset]
        .chars()
        .all(|c| c == '"' || c == '\'' || c.is_whitespace())
    {
        return Ok(());
    }
    let first = offset;
    let len = tail[first..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .count();
    let start = pos + 6 + first;
    let mut next = String::with_capacity(raw.len());
    next.push_str(&raw[..start]);
    next.push_str(&port.to_string());
    next.push_str(&raw[start + len..]);
    if next != raw {
        // 写失败必须报上去：端口改了、脚本没改，下次启动会在 `--port` 校验处
        // 以「config 里写的端口是…」失败，而用户看到的是启动失败而非写脚本失败（审查发现）。
        write_text_atomic(&script, &next)
            .with_context(|| format!("同步 {} 的 --port 失败", script.display()))?;
    }
    Ok(())
}

/// 文本文件原子替换 + 固定名 `.bak` 备份：先写同目录临时文件再 rename。
///
/// run 脚本被截断时模型会直接起不来，所以这里的写盘不能用裸 `fs::write`
/// （写一半失败/被杀毒锁住 → 脚本残半，且没有备份可恢复）。
fn write_text_atomic(path: &Path, text: &str) -> Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let backup = path.with_file_name(format!("{name}.bak"));
    fs::copy(path, &backup).with_context(|| format!("备份 {} 失败", backup.display()))?;
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    fs::write(&tmp, text).with_context(|| format!("写临时文件 {} 失败", tmp.display()))?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("替换 {} 失败", path.display()));
    }
    Ok(())
}

/// 把端口写进 config 顶层 `port`，并同步 `run-<slug>.bat` 的 `--port`（用户 m05322）。
///
/// 两处必须一致：引擎真正绑定的是 run 脚本里的 `--port`，config 的 `port` 只是 GUI
/// 用来连它的元数据（见 [`spawn_strata`] 的校验）。写盘走 [`write_config_raw`]：
/// 先备份固定名 `.json.bak`、原子替换、JSON 合法性自检。
pub fn set_port(root: &Path, config_file: &str, port: u16) -> Result<()> {
    let path = configs_dir(root).join(config_file);
    update_config(&path, |raw| {
        Ok(match replace_json_port(raw, port) {
            Some(text) => text,
            // 没有 `"port"` 键：插到对象开头。单行 config 补一个换行+两空格，
            // 已经是多行格式的（`{` 后紧跟换行）就不再加空行。
            None => match raw.strip_prefix('{') {
                Some(rest) => {
                    let sep = if rest.starts_with('\n') { "" } else { "\n  " };
                    format!("{{\n  \"port\": {port},{sep}{rest}")
                }
                None => raw.to_string(),
            },
        })
    })?;
    let slug = split_config_path(&path)
        .map(|(_, _, slug)| slug)
        .unwrap_or_default();
    if !slug.is_empty() {
        sync_run_script(root, &slug, port)?;
    }
    Ok(())
}

/// 把 `"port": <数字>` 的值换成 `port`；找不到这个键就返回 `None`。
///
/// 只替换数字本身，`"port"` 之后允许空白（`"port":9091` / `"port": 9091` 都认）。
fn replace_json_port(raw: &str, port: u16) -> Option<String> {
    let key = raw.find("\"port\"")?;
    let rest = &raw[key + 6..];
    let colon = rest.find(':')?;
    // `"port"` 与 `:` 之间只允许空白，否则命中的是别的键（如 `"port_foo"`）
    if !rest[..colon].chars().all(|c| c.is_whitespace()) {
        return None;
    }
    let after = &rest[colon + 1..];
    let skip = after.find(|c: char| c.is_ascii_digit())?;
    if !after[..skip].chars().all(|c| c.is_whitespace()) {
        return None;
    }
    let len = after[skip..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .count();
    let start = key + 6 + colon + 1 + skip;
    let mut next = String::with_capacity(raw.len());
    next.push_str(&raw[..start]);
    next.push_str(&port.to_string());
    next.push_str(&raw[start + len..]);
    Some(next)
}

/// 给还没有端口的 config 逐个分配（用户 m05322）。返回补了几份。
///
/// 只在 `port` 缺失 / 为 0 时动手：已经写着端口的 config 不动（那份端口是用户或上游定的，
/// 冲突时在 [`spawn_strata`] 启动阶段才换）。
pub fn ensure_ports(root: &Path) -> usize {
    let mut fixed = 0;
    // 0 = config 里没有 port 键；8080 = 引擎/安装器给的默认值。两种都算「没定制过」，
    // 都要自动分配（用户 m05516：新建 config 默认就是 8080）。
    for entry in scan_configs(root, None)
        .iter()
        .filter(|e| e.port == 0 || e.port == STRATA_PORT_DEFAULT)
    {
        let Some((_, config_file, _)) = split_config_path(&entry.config_path) else {
            continue;
        };
        let port = allocate_port(root, &config_file);
        if set_port(root, &config_file, port).is_ok() {
            fixed += 1;
        }
    }
    fixed
}

/// 设置页「Strata 引擎版本」选定的可执行文件（`settings.strata_engine`）。
///
/// 只在文件真的存在时返回 —— 选过的版本被删掉/升级移走时当作没选，回退到
/// config 声明或引擎组件目录里的最高版本，而不是把所有 config 都指到空路径。
pub fn preferred_engine(engine: Option<&str>) -> Option<PathBuf> {
    engine
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

/// 扫描 config 目录下的全部 config，按 mtime 倒序（照抄 `setup.py:3723-3725`）。
///
/// `root` 可以是官方安装根（此时扫 `<根>\install`），也可以直接是 config 目录。
/// `preferred` 见 [`parse_config`]：设置页选定的引擎版本，存在时对每份 config 都生效。
pub fn scan_configs(root: &Path, preferred: Option<&Path>) -> Vec<StrataModelEntry> {
    let mut out = Vec::new();
    let Ok(read_dir) = fs::read_dir(configs_dir(root)) else {
        return out;
    };
    for item in read_dir.flatten() {
        let path = item.path();
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if !is_config_file(&name) {
            continue;
        }
        if let Some(entry) = parse_config(&path, preferred) {
            out.push(entry);
        }
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    out
}

/// 从 `run-<model>.bat` 里解析出启动命令（**R1：不自己拼命令**）。
///
/// 上游生成的脚本形如：
/// ```text
/// @echo off
/// title Strata swift-IQ3_XXS
/// cd /d "E:\AI\Strata"
/// "E:\AI\Strata\.venv\Scripts\python.exe" "E:\AI\Strata\serve\server.py" "--engine" "strata" ...
/// if errorlevel 1 pause
/// ```
/// 取含 `server.py` 的那一行，按双引号切出 token：第一个是可执行文件，其余是参数。
/// 解析失败返回 `None`，调用方回退到默认布局。
/// 解析 `run-<模型>.bat` 的启动命令：返回 `(可执行文件, 参数, cwd)`。
///
/// control 0.1.47 起脚本不再写死路径，而是
/// `set "ROOT=…\control"` + `for /f … active.json … .folder` + `cd /d "%ROOT%\%VER%"`，
/// 命令行里的 `%ROOT%` / `%VER%` 由这里自己展开（GUI 不能执行 bat，用户 m05626）。
/// 读 `<control>\active.json` 的 `folder`（control 0.1.47 起控制端落在 `control\<版本>\`）。
fn active_control_folder(control_dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(control_dir.join("active.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let folder = ["folder", "version"]
        .iter()
        .find_map(|k| json.get(*k).and_then(|v| v.as_str()))
        .map(|s| s.trim().to_string())?;
    if folder.is_empty() || !control_dir.join(&folder).is_dir() {
        return None;
    }
    Some(folder)
}

/// `set "NAME=VALUE"` → `(NAME, VALUE)`。
fn set_statement(line: &str) -> Option<(String, String)> {
    if !line.to_ascii_lowercase().starts_with("set ") {
        return None;
    }
    let rest = line[4..].trim().strip_prefix('"')?;
    let end = rest.rfind('"')?;
    let (name, value) = rest[..end].split_once('=')?;
    if name.trim().is_empty() {
        return None;
    }
    Some((name.trim().to_string(), value.trim().to_string()))
}

/// 展开 `%NAME%`（大小写不敏感），认不出的原样保留。
fn expand_bat_vars(text: &str, vars: &HashMap<String, String>) -> String {
    if !text.contains('%') {
        return text.to_string();
    }
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '%' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < chars.len() && chars[j] != '%' {
            j += 1;
        }
        if j >= chars.len() {
            out.extend(&chars[i..]);
            break;
        }
        let name: String = chars[i + 1..j].iter().collect();
        match vars.get(&name.to_ascii_uppercase()) {
            Some(v) => out.push_str(v),
            None => out.extend(&chars[i..=j]),
        }
        i = j + 1;
    }
    out
}

/// 收集 run 脚本里的 `set` 变量（含 `for /f … active.json … .folder` 那种取版本号的）。
fn bat_vars(raw: &str, control_dir: &Path) -> HashMap<String, String> {
    let mut vars: HashMap<String, String> = HashMap::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.to_ascii_lowercase().starts_with("for ") {
            // `for /f … active.json … .folder … do set "VER=%%v"`：版本号由 active.json 决定
            if t.contains("active.json") && t.contains(".folder") {
                if let Some(pos) = t.find("do set ") {
                    if let Some((name, _)) = set_statement(&t[pos + 3..]) {
                        if let Some(folder) = active_control_folder(control_dir) {
                            vars.insert(name.to_ascii_uppercase(), folder);
                        }
                    }
                }
            }
            continue;
        }
        if let Some((name, value)) = set_statement(t) {
            if value.contains("%%") {
                continue;
            }
            let expanded = expand_bat_vars(&value, &vars);
            vars.insert(name.to_ascii_uppercase(), expanded);
        }
    }
    vars
}

pub fn parse_run_script(bat: &Path) -> Option<(PathBuf, Vec<String>, Option<PathBuf>)> {
    let raw = fs::read_to_string(bat).ok()?;
    let parent = bat.parent()?;
    let control_dir = [Some(parent.join("control")), parent.parent().map(|p| p.join("control"))]
        .into_iter()
        .flatten()
        .find(|d| d.join("active.json").is_file())
        .unwrap_or_else(|| parent.join("control"));
    let vars = bat_vars(&raw, &control_dir);
    // 新脚本用 `cd /d "%ROOT%\%VER%"` 切到 control\<版本>，GUI 也要以它为工作目录
    let cwd = raw
        .lines()
        .filter(|l| l.trim().to_ascii_lowercase().starts_with("cd "))
        .find_map(|l| {
            let token = quote_tokens(l).into_iter().next()?;
            let path = PathBuf::from(expand_bat_vars(&token, &vars));
            path.is_dir().then_some(path)
        });
    let line = raw.lines().find(|l| l.contains("server.py"))?;
    let expanded = expand_bat_vars(line, &vars);
    let tokens = quote_tokens(&expanded);
    if tokens.len() < 2 {
        return None;
    }
    let exe = PathBuf::from(&tokens[0]);
    if !exe.exists() {
        return None;
    }
    let args: Vec<String> = tokens[1..]
        .iter()
        .filter(|t| t.as_str() != "--open")
        .cloned()
        .collect();
    Some((exe, args, cwd))
}

/// 切出双引号包裹的 token。
fn quote_tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '"' {
            let mut token = String::new();
            i += 1;
            while i < bytes.len() && bytes[i] != '"' {
                token.push(bytes[i]);
                i += 1;
            }
            i += 1;
            out.push(token);
        } else {
            i += 1;
        }
    }
    out
}

/// 回退启动命令（run 脚本缺失/解析失败时）：照官方安装器的目录布局找控制端。
///
/// 官方布局（用户 m00732：只认这一套）：
/// `<根>\terminal\<版本>\python\python.exe` + `<根>\terminal\<版本>\serve\server.py`，
/// `<根>\terminal\current` 是指向当前版本的目录联结 —— 升级换版本只换联结，旧版本目录留着可回退。
///
/// 旧布局（`control\` 自带解释器 / 安装根下的 `.venv`）作为兜底保留：`root` 可能被指到
/// 引擎子目录（`<根>\components\engine\<版本>-…`），父目录也进候选（用户 m04254）。
fn fallback_command(
    root: &Path,
    config_path: &Path,
    port: u16,
) -> (PathBuf, Vec<String>, Option<PathBuf>) {
    let py_name = if cfg!(windows) { "python.exe" } else { "python" };
    let mut candidates: Vec<(PathBuf, PathBuf, Option<PathBuf>)> = Vec::new();
    for base in std::iter::once(root).chain(root.parent()) {
        // ⓪ 设置页「Strata 控制器版本」选中的那一份：用户显式选的排在最前
        if let Some(version) = controller_preference() {
            if let Some(dir) = controller_dir(base, &version) {
                candidates.push((
                    dir.join("python").join(py_name),
                    dir.join("serve").join("server.py"),
                    Some(dir),
                ));
            }
        }
        // ① 官方脚本布局：`terminal\current` 优先，其余版本目录按名字排（新版本在前）
        let terminal = base.join("terminal");
        let mut term_dirs: Vec<PathBuf> = Vec::new();
        let current = terminal.join("current");
        if current.join("python").join(py_name).is_file() {
            term_dirs.push(current);
        }
        for dir in subdirs(&terminal) {
            if !dir.join("python").join(py_name).is_file() {
                continue;
            }
            // `current` 也是 `terminal` 的一个入口（目录联结），按真实路径去重
            if term_dirs
                .iter()
                .any(|known| canonical_key(known) == canonical_key(&dir))
            {
                continue;
            }
            term_dirs.push(dir);
        }
        for dir in term_dirs {
            candidates.push((
                dir.join("python").join(py_name),
                dir.join("serve").join("server.py"),
                Some(dir),
            ));
        }
        // ② 手动解压 / 旧布局：`control\<版本>\`（控制端自带解释器）
        //    `active.json` 记的版本优先，其次按版本号从高到低
        let control = base.join("control");
        let mut control_dirs: Vec<PathBuf> = Vec::new();
        if let Some(folder) = active_control_folder(&control) {
            control_dirs.push(control.join(&folder));
        }
        let mut local = subdirs(&control);
        local.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        for dir in local {
            if is_controller_dir(&dir)
                && !control_dirs
                    .iter()
                    .any(|known| canonical_key(known) == canonical_key(&dir))
            {
                control_dirs.push(dir);
            }
        }
        for dir in control_dirs {
            candidates.push((
                dir.join("python").join(py_name),
                dir.join("serve").join("server.py"),
                Some(dir),
            ));
        }
        candidates.push((
            control.join("python").join(py_name),
            control.join("serve").join("server.py"),
            Some(control),
        ));
        // ③ 更早期的 `.venv` + `serve`：手动解包安装才会出现
        let venv_py = if cfg!(windows) {
            base.join(".venv").join("Scripts").join(py_name)
        } else {
            base.join(".venv").join("bin").join(py_name)
        };
        candidates.push((venv_py, base.join("serve").join("server.py"), None));
    }
    let (exe, server, cwd) = candidates
        .iter()
        .find(|(exe, server, _)| exe.is_file() && server.is_file())
        .cloned()
        .unwrap_or_else(|| {
            (
                root.join("control").join("python").join(py_name),
                root.join("control").join("serve").join("server.py"),
                Some(root.join("control")),
            )
        });
    (
        exe,
        vec![
            server.to_string_lossy().to_string(),
            "--engine".to_string(),
            "strata".to_string(),
            "--config".to_string(),
            config_path.to_string_lossy().to_string(),
            "--port".to_string(),
            port.to_string(),
        ],
        cwd,
    )
}

/// Strata 引擎日志的来源名：带上这次引擎加载的模型名。
///
/// 以前整条流固定是 `"strata"`，于是换过几个模型之后，所有模型的输出都挤在同一个
/// 来源里（用户 m00545）。前端按 `strata:<模型名>` 拆标签；没有模型名时退回 `"strata"`。
fn strata_log_source(model_name: &str) -> String {
    let name = model_name.trim();
    if name.is_empty() {
        "strata".to_string()
    } else {
        format!("strata:{name}")
    }
}

/// Strata 自己的日志读取器：整个引擎进程的输出归到同一个来源（见 [`strata_log_source`]）。
///
/// 不能复用 [`crate::logs::spawn_reader`] —— 它按行首 `[端口]` 把日志分成
/// `model:<端口>` / `system`，Strata 的输出没有那个前缀，全部会被塞进 `"system"`
/// （也就是 router 自己的那一路），前端就没法把 Strata 的模型日志单独挑出来看。
fn spawn_strata_reader<R: std::io::Read + Send + 'static>(
    stream: R,
    hub: Arc<LogHub>,
    tx: mpsc::Sender<LogLine>,
    source: String,
) {
    thread::spawn(move || {
        let reader = std::io::BufReader::new(stream);
        for line in reader.split(b'\n') {
            let Ok(bytes) = line else { break };
            let text = String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_string();
            if text.is_empty() {
                continue;
            }
            let entry = hub.push(&source, text);
            if tx.send(entry).is_err() {
                break;
            }
        }
    });
}

/// 连接用的主机名：`0.0.0.0` / `::` 这类通配监听在本地按 loopback 连。
pub fn loopback_host(host: &str) -> String {
    match host.trim() {
        "" | "0.0.0.0" | "::" | "*" | "localhost" => "127.0.0.1".to_string(),
        other => other.to_string(),
    }
}

/// 把 `args` 里 `flag` 后面那个值换成 `value`；没有这个 flag 就补一对。
fn replace_flag(args: &[String], flag: &str, value: &str) -> Vec<String> {
    let mut out = args.to_vec();
    if let Some(index) = out.iter().position(|arg| arg == flag) {
        if index + 1 < out.len() && !out[index + 1].starts_with("--") {
            out[index + 1] = value.to_string();
        } else {
            out.insert(index + 1, value.to_string());
        }
    } else {
        out.push(flag.to_string());
        out.push(value.to_string());
    }
    out
}

/// 按这份模型的 launch 预设生成运行配置（没有预设、或生成失败则 `None`）。
fn launch_sync(
    hub: &Arc<LogHub>,
    entry: &StrataModelEntry,
) -> Option<crate::strata_launch::LaunchSync> {
    let terminal = crate::strata::root()
        .and_then(|root| crate::strata_tune::terminal_dir(&root))?;
    let folder = entry.model_path.as_ref()?;
    crate::strata_launch::sync_for_entry(
        hub,
        &terminal,
        &folder.to_string_lossy(),
        &entry.config_path,
    )
}

/// 就绪探测用的地址：`0.0.0.0` / `::` 这类通配监听在本地按 loopback 连。
fn probe_addr(host: &str, port: u16) -> std::net::SocketAddr {
    let h = match host.trim() {
        "" | "0.0.0.0" | "::" | "*" | "localhost" => "127.0.0.1",
        other => other,
    };
    std::net::SocketAddr::from_str(&format!("{h}:{port}"))
        .unwrap_or_else(|_| std::net::SocketAddr::from(([127, 0, 0, 1], port)))
}

/// 启动 Strata。
///
/// 复用 router 通道验证过的五个要点：先接日志再等就绪（管道仅 ~4KB，
/// 顺序错了子进程会阻塞在 write 上永不监听端口）、端口占用顺延、
/// 隐藏控制台、失败分支必须杀子进程、就绪后返回真实端口。
///
/// host / 端口 / 密钥**一律取 config 里的值**（R2）：设置页「服务」分组是把这些
/// 值直接写进 `strata-*.json` 的顶层字段（用户 m01623），GUI 不追加命令行参数，
/// 启动命令完全照上游生成的 `run-<model>.bat`（R1）。
pub fn spawn_strata(
    app: &AppHandle,
    hub: Arc<LogHub>,
    entry: &StrataModelEntry,
) -> Result<(StrataProcess, StrataStatus)> {
    let root = entry
        .config_path
        .parent()
        .context("config 路径异常")?
        .to_path_buf();

    let mut host = entry.host.clone();
    let mut port = entry.port;
    let mut api_key = entry.api_key.clone();
    // 这份模型有没有 launch 预设：有的话端口 / config 都由预设决定，安装器那份不动
    // （否则自动分配端口会把 `install\strata-<tag>.json` 改掉，而启动根本不用它）。
    let model_folder = entry
        .model_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default();
    let has_launch = crate::strata_launch::find_for(&model_folder).is_some();

    // 端口自动分配（用户 m05322）：config 里没写端口、写的是安装器默认 8080（用户 m05516）、
    // 或写的端口已被占用（别的模型先起来了），就从 9091 起挑一个空闲的（逻辑同 llama.cpp 侧），
    // 写回 config 与 `run-<slug>.bat` 再启动。
    // 以前这里是「占用就报错、不顺延」—— 用户要求自己挑，所以改成自动分配。
    let unconfigured = port == 0 || port == STRATA_PORT_DEFAULT;
    if !has_launch && (unconfigured || winfix::port_in_use(port)) {
        let (_, config_file, _) = split_config_path(&entry.config_path).context("config 路径异常")?;
        let next = allocate_port(&root, &config_file);
        if next != port {
            set_port(&root, &config_file, next).with_context(|| {
                format!("端口 {port} 不可用，自动分配到 {next} 后写回 config 失败")
            })?;
            hub.push(
                "system",
                format!(
                    "[gui] {} 的端口 {}，已自动分配到 {next}（config 与 run 脚本一起改）",
                    entry.model_name,
                    if port == 0 {
                        "未配置".to_string()
                    } else if port == STRATA_PORT_DEFAULT {
                        format!("{port}（安装器默认）")
                    } else {
                        format!("{port} 被占用")
                    },
                ),
            );
            port = next;
        }
    }

    let (exe, mut args, script_cwd) = match entry
        .run_script
        .as_ref()
        .and_then(|p| parse_run_script(p))
    {
        Some(cmd) => cmd,
        None => fallback_command(&root, &entry.config_path, port),
    };
    // 脚本里的 `cd /d` 目标优先：control 0.1.47 起引擎要以 `control\<版本>` 为工作目录
    let cwd = script_cwd.unwrap_or_else(|| entry.cwd.clone());

    // launch 预设优先（用户 m02055）：在预设里就按它重新生成 `launch\<slug>.json`，把命令里的
    // --config / --port 换掉，host 与 key 也换成预设的 —— 与 `strata launch` 起出来的服务一致
    // （context / kv / vision / 卡 / extra env 全在生成出来的配置里）。
    if has_launch {
        if let Some(sync) = launch_sync(&hub, entry) {
            args = replace_flag(&args, "--config", &sync.config);
            args = replace_flag(&args, "--port", &sync.port.to_string());
            host = sync.host;
            port = sync.port;
            api_key = sync.api_key;
        }
    }

    // run 脚本里的 `--port` 才是引擎真正绑定的端口：`server.py` 只认 CLI 参数
    // （`cfg["port"]` 没有回退），config 里的 `port` 只是 GUI 用来找它的元数据。
    // 两处不一致时 GUI 会一直等错端口（表现为"启动失败"并把刚起的进程杀掉），
    // 所以在这里提前拦下，把要改的两个地方直接写进报错（用户 m00798 那种改端口只改了一处）。
    // 用 launch 配置启动时这条不成立（端口来自预设，脚本里的是安装器端口）。
    if !has_launch {
        if let Some(script) = entry.run_script.as_ref() {
            if let Some(script_port) = arg_flag_value(&args, "--port") {
                if script_port != port {
                    anyhow::bail!(
                        "config 里写的端口是 {port}，但 {} 里的 --port 是 {script_port}。\
                         引擎实际绑定的是 run 脚本里的端口，请把两处改成一致（GUI 按 config 的端口去连它）。",
                        script.display()
                    );
                }
            }
        }
    }

    if !entry.engine_exists {
        anyhow::bail!(
            "引擎文件不存在：{}（可能升级中途失败，请在 Strata 目录跑 setup.py --rollback-engine）",
            entry.engine.display()
        );
    }

    hub.push(
        "system",
        format!(
            "[gui] 启动 Strata {} 参数: {}",
            exe.display(),
            crate::logs::redact_args(&args).join(" ")
        ),
    );

    let mut cmd = Command::new(&exe);
    cmd.args(&args);
    cmd.current_dir(&cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // Python 的 stdout 接到管道时是全缓冲的：不关掉缓冲，模型日志会一直攒在
    // 进程里，GUI 的日志页等于看不到 Strata 的输出。
    cmd.env("PYTHONUNBUFFERED", "1");
    crate::winfix::hide_console(&mut cmd);
    crate::winfix::no_throttle(&mut cmd);

    // 带 BREAKAWAY_FROM_JOB 的 CreateProcess 在父 Job 未开启 BREAKAWAY_OK 时会直接失败，
    // 所以必须去掉 flag 重试一次（见 winfix::no_throttle 的注释）。
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(first) => {
            hub.push(
                "system",
                format!("[gui] 脱离 Job Object 不被允许（{first}），按普通方式启动"),
            );
            let mut retry = Command::new(&exe);
            retry.args(&args);
            retry.current_dir(&cwd);
            retry.stdout(Stdio::piped());
            retry.stderr(Stdio::piped());
            retry.env("PYTHONUNBUFFERED", "1");
            crate::winfix::hide_console(&mut retry);
            retry
                .spawn()
                .with_context(|| format!("启动 Strata 失败: {}", exe.display()))?
        }
    };

    let pid = child.id();
    let started_at_ms = now_ms();

    // 先接日志再等就绪（顺序不可调换，见 router.rs 同位置注释）。
    let (tx, rx) = mpsc::channel();
    let source = strata_log_source(&entry.model_name);
    if let Some(stdout) = child.stdout.take() {
        spawn_strata_reader(stdout, Arc::clone(&hub), tx.clone(), source.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_strata_reader(stderr, Arc::clone(&hub), tx.clone(), source);
    }
    drop(tx);
    spawn_pump(app.clone(), Arc::clone(&hub), rx);

    let deadline = Instant::now() + READY_TIMEOUT;
    let probe = probe_addr(&host, port);
    loop {
        if std::net::TcpStream::connect_timeout(&probe, Duration::from_millis(200)).is_ok() {
            break;
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                let msg = format!(
                    "Strata 启动后立刻退出（退出码 {:?}）。常见原因：显存/内存不够（上下文太大、专家缓存放不下）、\
                     模型或引擎文件缺失；完整原因在「系统日志」页的该模型标签里。",
                    exit.code()
                );
                hub.push("system", format!("[gui] {msg}"));
                crate::logs::force_kill_tree(pid, &mut child);
                anyhow::bail!(msg);
            }
            Ok(None) => {}
            Err(err) => {
                crate::logs::force_kill_tree(pid, &mut child);
                anyhow::bail!("等待 Strata 启动失败: {err}");
            }
        }
        if Instant::now() >= deadline {
            let msg = format!("Strata 在 {} 秒内没有监听 {probe} 端口，请看日志", READY_TIMEOUT.as_secs());
            hub.push("system", format!("[gui] {msg}"));
            crate::logs::force_kill_tree(pid, &mut child);
            anyhow::bail!(msg);
        }
        thread::sleep(Duration::from_millis(150));
    }

    hub.push(
        "system",
        format!("[gui] Strata 已在 {probe} 就绪（模型加载可能仍在进行）",),
    );

    let process = StrataProcess {
        child,
        port,
        config_path: entry.config_path.clone(),
        model_name: entry.model_name.clone(),
        started_at_ms,
        api_key,
    };
    let status = StrataStatus {
        running: true,
        external: false,
        port,
        pid: Some(pid),
        config_path: Some(entry.config_path.clone()),
        model_name: Some(entry.model_name.clone()),
        started_at_ms: Some(started_at_ms),
        last_error: None,
        version: None,
        live_max_context: None,
        loaded: None,
        busy: None,
        prompt_tokens: None,
        max_tokens: None,
        models_autoload: None,
        // 前门状态由 `strata_proxy::apply_to` 在返回给前端前统一并进来
        proxy: false,
        proxy_port: None,
        proxy_serving: None,
    };
    Ok((process, status))
}

/// 等端口真的可以再绑定。
///
/// `stop_strata` 只等**直接子进程**（python）退出，而监听端口的是它拉起的引擎子进程：
/// 引擎还在关闭连接、释放显存时，`spawn_strata` 的 bind 仍会失败（"端口已被占用"）。
/// 前门切换模型时必须先过这一关，否则第二次切换必然报错。
pub fn wait_port_free(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !crate::winfix::port_in_use(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(200));
    }
}

/// 取 `--flag value` 形式的参数值（用于校验 run 脚本里的 `--port`）。
fn arg_flag_value(args: &[String], flag: &str) -> Option<u16> {
    let index = args.iter().position(|a| a == flag)?;
    args.get(index + 1).and_then(|v| v.trim().parse::<u16>().ok())
}

/// 停止 Strata。Strata 是单进程（引擎子进程由 server.py 管理），
/// 用进程树强杀保证引擎不残留占显存。
pub fn stop_strata(slot: &Arc<Mutex<Option<StrataProcess>>>) -> Option<u32> {
    let mut process = slot.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    let pid = process.child.id();
    let _ = process.child.kill();
    crate::logs::force_kill_tree(pid, &mut process.child);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => return Some(pid),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
            _ => return Some(pid),
        }
    }
}

/// 崩溃监测：slot 里的进程退出后把状态置为未运行并推送前端。
pub fn spawn_monitor(
    app: AppHandle,
    slot: Arc<Mutex<Option<StrataProcess>>>,
    status: Arc<Mutex<StrataStatus>>,
) {
    thread::spawn(move || {
        let mut watched_pid: Option<u32> = None;
        loop {
            thread::sleep(Duration::from_millis(500));
            let exited = {
                let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                let Some(process) = guard.as_mut() else {
                    return;
                };
                let pid = process.child.id();
                match watched_pid {
                    None => watched_pid = Some(pid),
                    Some(known) if known == pid => {}
                    Some(_) => return,
                }
                match process.child.try_wait() {
                    Ok(Some(exit)) => Some(exit.code()),
                    Ok(None) => None,
                    Err(_) => Some(None),
                }
            };
            if let Some(code) = exited {
                {
                    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                    guard.take();
                }
                let snapshot = {
                    let mut st = status.lock().unwrap_or_else(|e| e.into_inner());
                    st.running = false;
                    st.pid = None;
                    st.loaded = None;
                    // 归属信息一并清掉：槽位空了，「这份 config 的引擎正在起」这个判断
                    // （卡片据此显示「加载中」）必须跟着失效，否则进程死了卡片还在转圈。
                    st.config_path = None;
                    st.model_name = None;
                    st.started_at_ms = None;
                    st.last_error = Some(match code {
                        Some(c) => format!("Strata 已退出（退出码 {c}）"),
                        None => "Strata 已退出".to_string(),
                    });
                    st.clone()
                };
                let _ = app.emit("strata://status", snapshot);
                // Strata 是**不由前端 store 驱动**的进程槽（`strata_start` 之后状态只在
                // 后端变），崩溃监测是唯一能发现「它自己没了」的地方。这里顺手刷一次托盘
                // 菜单可用性，否则「启动服务」会一直禁用着，用户以为托盘坏了。
                // 只动菜单、不动 tooltip：tooltip 还要带前门的端口，这里没那个上下文。
                let service_running = app
                    .try_state::<crate::state::AppState>()
                    .map(|state| crate::strata_proxy::running_port(&state).is_some())
                    .unwrap_or(false);
                crate::tray::sync_menu_state(&app, service_running, false);
                return;
            }
        }
    });
}

/// 运行时探测：读 `/health`、`/props`、`/status`，把结果并入状态。
///
/// 全部字段可选（**R4**）：端点缺失或字段缺失时保持 `None`，
/// 老版本 Strata 缺端点只会让界面少显示几项，不会报错。
///
/// 探测到「退化」时复探一次再采信：引擎切换/加载模型的那一两秒里，偶尔有一轮
/// `/health` 不应答或还回着旧的 `loaded: false`，单轮采信会让卡片
/// 「运行中 → 已停止 → 运行中」闪一下（用户 m12735）。但也不能为了不闪就把判断推后 ——
/// 实例真挂了必须马上显示（用户 m13216 第 2 点），所以做法是「立刻复探」而不是「等下一轮」：
/// 本机关闭端口是即时 RST，复探几乎不花时间；真卡住时才会再等一个超时。
pub fn probe(port: u16, api_key: Option<&str>) -> StrataStatus {
    let first = probe_with_timeout(port, api_key, PROBE_TIMEOUT);
    if is_healthy(&first) {
        return first;
    }
    // 复探用和首探一样的超时：这一轮的来历就是「引擎正好忙、3 秒没应答」，
    // 只给 0.8 秒等于让它再失败一次（用户 m13709 报的抖动就是这样复现的）。
    // 真挂的实例连不上是即时 RST，复探不花时间；只有半死状态才会把两个超时都用满。
    let again = probe_with_timeout(port, api_key, PROBE_TIMEOUT);
    // 复探结果更晚，无认健康与否都采信它：真挂了立刻显示「已停止」，
    // 单轮抖动则被这次复探吸收掉。
    again
}

/// 探测结果是否「健康」：端口应答且明确说已加载模型。
///
/// `loaded == None` 也算不健康 —— 那说明这一轮 `/health` 读到了但字段缺失，
/// 多半是引擎正处于切换状态，值得复探一次。
fn is_healthy(st: &StrataStatus) -> bool {
    st.running && st.loaded == Some(true)
}


/// 同 [`probe`]，但超时由调用方定。
///
/// 前门合成 `/models` 时要挨个 config 探一遍「有没有外部实例在跑」，那是列表热路径：
/// 3 秒的探测超时会让一次列表请求拖上好几秒（用户 m06134：每次读列表耗时 6.1 秒
/// = 3 份 config × 每份约 2 秒的「连不上」）。本机正常响应是毫秒级，这类场景用短超时。
pub fn probe_with_timeout(port: u16, api_key: Option<&str>, timeout: Duration) -> StrataStatus {
    let mut st = StrataStatus {
        running: true,
        port,
        ..Default::default()
    };
    st.running = true;

    if let Ok(body) = http::request("127.0.0.1", port, "GET", "/health", None, api_key, timeout) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            st.loaded = v.get("loaded").and_then(|x| x.as_bool());
            st.live_max_context = v.get("max_context").and_then(|x| x.as_u64());
            // `/health` 报的 model 是「这个端口上到底在跑哪份 config」的权威判据。
            // 多份 config 可以写同一个端口（用户 m00001：两个模型都写 9090），
            // 只按端口猜归属会把实例记到错的卡片上，必须用这里报出的模型名反查。
            st.model_name = v
                .get("model")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            // service 字段是「这确实是 Strata」的识别标志（R10 兼容降级判据）。
            if v.get("service").and_then(|x| x.as_str()) != Some("strata") {
                st.last_error = Some("端口上运行的不是 Strata（/health 无 service:strata）".to_string());
                return st;
            }
        }
    } else {
        st.running = false;
        st.last_error = Some("端口无响应".to_string());
        return st;
    }

    if let Ok(body) = http::request("127.0.0.1", port, "GET", "/props", None, api_key, timeout) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            st.version = v.get("build_info").and_then(|x| x.as_str()).map(|s| s.to_string());
            st.models_autoload = v.get("models_autoload").and_then(|x| x.as_bool());
        }
    }

    if let Ok(body) = http::request("127.0.0.1", port, "GET", "/status", None, api_key, timeout) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            st.busy = v.get("busy").and_then(|x| x.as_bool());
            st.prompt_tokens = v.get("prompt_tokens").and_then(|x| x.as_u64());
            st.max_tokens = v.get("max_tokens").and_then(|x| x.as_u64());
        }
    }

    st
}

/// 读 config 原文（参数编辑 L2 用）。
pub fn read_config_raw(path: &Path) -> Result<String> {
    fs::read_to_string(path).with_context(|| format!("读取 config 失败: {}", path.display()))
}

/// config 写入的进程内互斥（M13）。
///
/// 前端 `ensureStrataLazy` 与「参数编辑」面板会同时往同一份 config 落盘。没有这把锁时
/// 两条写入线程会互相踩：备份修剪各读一份目录快照，于是互相删掉对方刚写的备份；
/// `fs::rename` 在 Windows 上也会撞上「目标已被另一个 rename 换掉」。
///
/// 和 `models::preset_lock()` 同款：`OnceLock<Mutex<()>>`，**进程内**有效即可 ——
/// 所有写入路径都在本进程（IPC 命令 + 后端自动写），不存在跨进程写 config 的场景。
pub fn strata_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 唯一的临时文件名：`strata-x.json` → `strata-x.json.<pid>.<seq>.tmp`。
///
/// 固定用 `path.with_extension("json.tmp")` 时，并发写的两条线程会写同一个临时文件：
/// A 写完 tmp → B 又写一遍 tmp → A 再 rename，结果 A 的内容被 B 覆盖（用户的编辑静默丢失）。
/// 加 pid + 自增序号后每个写入者各写各的临时文件，谁先 rename 谁生效，不再互相覆盖。
/// 照抄 `settings.rs:570-576` 的既有做法。
fn temp_config_path(path: &Path) -> PathBuf {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    path.with_extension(format!("json.{}.{seq}.tmp", std::process::id()))
}


/// 把 config 里旧的引擎路径（组件引用，或上一个版本目录）替换成当前引擎路径。
///
/// 用户 m02748：引擎升级后组件目录换了版本子目录，config 不能一直指着旧的那个。
/// 只替换那一个字符串字面量，其余内容原样保留；写入走 [`write_config_raw`]
/// （备份 + 原子写 + 校验）。找不到旧值就返回（config 已被别处改过）。
/// 按「旧值 → 新值」替换 config 里的若干字符串字面量，其余字节原样保留。
///
/// 走文本替换而不是 `serde_json` 重排：config 的键顺序、缩进、转义都是上游
/// `setup.py` 写的（用户在左栏直接看/改原文），序列化回写会把键按字母序打乱、
/// 把 `\/` 变成 `/`，等于每次切引擎都重写整份文件。
///
/// 匹配的是**加引号后的 JSON 字面量**（`serde_json::to_string` 的转义与文件里写入时一致），
/// 每个旧值只替换第一次出现的位置。
fn rewrite_config_strings(path: &Path, edits: &[(&str, &str)]) -> Result<()> {
    let mut text = fs::read_to_string(path)?;
    let mut changed = false;
    for (old, new) in edits {
        let quoted_old = serde_json::to_string(old)?;
        let Some(pos) = text.find(&quoted_old) else {
            continue;
        };
        let quoted_new = serde_json::to_string(new)?;
        text.replace_range(pos..pos + quoted_old.len(), &quoted_new);
        changed = true;
    }
    if !changed {
        return Ok(());
    }
    write_config_raw(path, &text)
}

/// 所选引擎同目录下的视觉可执行文件（存在才返回）。
///
/// 引擎包是「一个版本一个目录」（`strata.exe` + `strata-vision.exe` + DLL），
/// 换引擎时 `vision.exe` 必须跟着换目录，否则视觉仍跑旧版本的 exe/依赖。
fn vision_sibling(engine_exe: &Path) -> Option<PathBuf> {
    let dir = engine_exe.parent()?;
    let name = if cfg!(windows) {
        "strata-vision.exe"
    } else {
        "strata-vision"
    };
    let path = dir.join(name);
    path.is_file().then_some(path)
}

/// 组装「改 `exe`」＋「同步 `vision.exe`」的文本替换对（用户 m04769）。
///
/// - `exe`：值变了才替换。
/// - `vision.exe`：只在**新引擎同目录下真有 `strata-vision.exe`** 且当前值是绝对路径时才替换；
///   写 `component:` 引用的不动（引用由控制器解析），值已经一致也不动。
fn engine_edits(
    value: &serde_json::Value,
    old_exe: &str,
    new_exe: &str,
    target: &Path,
) -> Vec<(String, String)> {
    let mut edits = Vec::new();
    if old_exe != new_exe {
        edits.push((old_exe.to_string(), new_exe.to_string()));
    }
    if let Some(vision) = value
        .get("vision")
        .and_then(|v| v.get("exe"))
        .and_then(|v| v.as_str())
    {
        // `component:` 引用也一并展开：server.py 同样解析不了它，视觉组件会跟着起不来
        // （用户 m04159 那份 config 的 `vision.exe` 就是引用形态）。
        if let Some(sibling) = vision_sibling(target) {
            let next = sibling.to_string_lossy().to_string();
            if vision != next {
                edits.push((vision.to_string(), next));
            }
        }
    }
    edits
}

/// 把某份 config 的 `exe` 换成用户选定的那个引擎可执行文件。
///
/// 引擎目录里可能同时存在多个版本（升级不一定删旧的），面板把 [`list_engines`]
/// 列出来让用户挑。改的是 `exe` 与 `vision.exe` 两个字符串（用户 m04769：
/// 引擎包一个版本一个目录，视觉必须跟着换），其余键与字节顺序原样保留，
/// 走 [`rewrite_config_strings`] 的备份 + 原子写。
///
/// **一律写绝对路径**（用户 m04888）：config 里原本写 `component:strata-engine` 的，
/// 选版本后也换成真实 exe 路径；组件引用只在扫描时被解析（并顺手改写成绝对路径），
/// 不再是磁盘上的长期形态。
pub fn set_engine(root: &Path, config_file: &str, exe: &str) -> std::result::Result<(), String> {
    let path = configs_dir(root).join(config_file);
    if !path.is_file() {
        return Err(format!("config 不存在：{}", path.display()));
    }
    // 传进来的可能是 `component:strata-engine` 引用，不是文件路径。
    let reference = exe.starts_with("component:");
    let target = PathBuf::from(exe);
    if !reference && !target.is_file() {
        return Err(format!("引擎文件不存在：{}", target.display()));
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读 config 失败：{e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("config 不是合法 JSON：{e}"))?;
    let old = value
        .get("exe")
        .and_then(|v| v.as_str())
        .ok_or("config 里没有 exe 字段")?
        .to_string();
    let next = if reference {
        exe.to_string()
    } else {
        target.to_string_lossy().to_string()
    };
    // vision 永远是绝对路径：引用形态下按同一个 Strata 根目录解析出真实引擎再去同步。
    let vision_base = if reference {
        resolve_component(root, ENGINE_COMPONENT_ID)
            .map(|c| c.exe)
            .unwrap_or_else(|| target.clone())
    } else {
        target.clone()
    };
    let edits = engine_edits(&value, &old, &next, &vision_base);
    if edits.is_empty() {
        return Ok(());
    }
    let refs: Vec<(&str, &str)> = edits.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    rewrite_config_strings(&path, &refs).map_err(|e| format!("写 config 失败：{e}"))
}

/// 把选定的引擎批量写进 `root` 下的全部 config（设置页「Strata 引擎」卡片用，用户 m03103）。
///
/// 返回被写过的文件名列表；任何一份失败就整批报错（已写成功的留在原地，不尝试回滚 ——
/// 回滚要重写配置，失败概率只增不减，报错里已经点明哪些文件出问题）。
pub fn apply_engine(root: &Path, exe: &str) -> std::result::Result<Vec<String>, String> {
    // 传进来的可能是 `component:strata-engine` 引用，不是文件路径（用户 m04934）。
    let reference = exe.starts_with("component:");
    let target = PathBuf::from(exe);
    if !reference && !target.is_file() {
        return Err(format!("引擎文件不存在：{}", target.display()));
    }
    let read_dir =
        fs::read_dir(configs_dir(root)).map_err(|e| format!("读不到目录 {}：{e}", root.display()))?;
    let mut changed = Vec::new();
    let mut failed = Vec::new();
    for item in read_dir.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_config_file(name) {
            continue;
        }
        match set_engine(root, name, exe) {
            Ok(()) => changed.push(name.to_string()),
            Err(e) => failed.push(format!("{name}：{e}")),
        }
    }
    if !failed.is_empty() {
        return Err(failed.join("；"));
    }
    Ok(changed)
}

/// 把 config 里的 `component:<id>` 引用展开成本机真实引擎路径。
///
/// 为什么必须展开：引用形态是交给 **`serve/server.py` 自己解析**的（上游
/// `engine_component.expand()`），它只认 `STRATA_COMPONENTS_DIR` 或
/// `%LOCALAPPDATA%\Strata\components`；而这里的 [`resolve_component`] 扫的是
/// `<Strata 根>\engine\<版本>`。手动解压的布局里官方组件目录是空的，server.py 会直接
/// 报「No engine for this PC was found」并拒绝启动（用户 m04159）。
///
/// 幂等：没有引用时什么都不做；返回被改写的 config 个数。
pub fn settle_engine(root: &Path) -> usize {
    let Some(component) = resolve_component(root, ENGINE_COMPONENT_ID) else {
        return 0;
    };
    let target = component.exe.to_string_lossy().to_string();
    let Ok(read_dir) = fs::read_dir(configs_dir(root)) else {
        return 0;
    };
    let mut fixed = 0;
    for item in read_dir.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_config_file(name) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let referenced = |target: &serde_json::Value| {
            target
                .as_str()
                .map(|text| text.starts_with("component:"))
                .unwrap_or(false)
        };
        let has_reference = referenced(value.get("exe").unwrap_or(&serde_json::Value::Null))
            || value
                .get("vision")
                .and_then(|vision| vision.get("exe"))
                .map(referenced)
                .unwrap_or(false);
        if !has_reference {
            continue;
        }
        if set_engine(root, name, &target).is_ok() {
            // `rewrite_config_strings` 每条替换只改**首个**命中，而 `exe` 与 `vision.exe`
            // 可能写着同一个引用（切换模型前先看过 config 的都会这么写）。所以再跑一次：
            // 第一次已把 `exe` 换成路径，第二遍剩下的引用就轮到 `vision.exe` 了。
            let _ = set_engine(root, name, &target);
            fixed += 1;
        }
    }
    fixed
}

/// 写 config（参数编辑 L2 用），落实 §8.6 的 W1-W8 安全规则。
///
/// - **W3 备份**：写前复制 `<config>.json.bak`，只留这一个，每次覆盖（不带时间戳）。
/// - **W5 校验**：JSON 可解析、顶层有 `exe`、`args` 是数组 —— 上游
///   `setup.py:3707-3720`（#549）认「object 且有 exe 且 args 是 list」，
///   不满足会被跳过并 warn，等于把模型从列表里弄丢。
/// - **W4 原子写**：先写 `.tmp` 再 rename。
///
/// - **M13**：整个函数体在 `strata_lock()` 里跑。锁只保护「备份 → 修剪 → 写 tmp →
///   rename」这一段，JSON 解析放在锁外（纯计算，占着锁没意义）。
pub fn write_config_raw(path: &Path, text: &str) -> Result<()> {
    // 组件引用原样落盘（用户 2026-10-22 的会话：三份 config 统一用 `component:strata-engine`，
    // 由控制器的组件目录决定实际版本）。不再在写盘时展开成绝对路径。
    validate_config_text(text)?;

    // 校验过了才拿锁：解析失败时连锁都不用碰。
    // 中毒不走 `let Ok(..) = ...lock() else`（那会静默跳过整段写入），统一 `into_inner()`。
    let _guard = strata_lock().lock().unwrap_or_else(|e| e.into_inner());
    write_config_raw_locked(path, text)
}

/// 上游认的 config 形状：JSON 可解析、顶层有 `exe`、`args` 是数组。
///
/// 抽出来是为了让「读-改-写」的调用者能在**同一把锁内**先校验再落盘
/// （`write_config_raw` 的校验仍在锁外，纯计算不占锁）。
fn validate_config_text(text: &str) -> Result<()> {
    let value: serde_json::Value =
        serde_json::from_str(text).context("JSON 解析失败，已取消写入（未改动原文件）")?;
    let obj = value
        .as_object()
        .context("config 顶层必须是 JSON 对象，已取消写入")?;
    if obj.get("exe").and_then(|v| v.as_str()).is_none() {
        anyhow::bail!("config 缺少顶层 exe 字段，已取消写入（上游会跳过这份 config）");
    }
    if obj.get("args").and_then(|v| v.as_array()).is_none() {
        anyhow::bail!("config 的 args 必须是数组，已取消写入（上游会跳过这份 config）");
    }
    Ok(())
}

/// 读-改-写在 `strata_lock()` 内一气呵成。
///
/// 审查发现：`set_port` / `set_config_api_key` / `write_config_args` 原来是「锁外读、
/// 锁内写」，两个写者并发（保存 Key 与保存参数/端口）时后者整份覆盖前者，表现为
/// 「改的东西自己变回去」。读文本这一步必须和写进同一把锁。
fn update_config<F>(path: &Path, build: F) -> Result<()>
where
    F: FnOnce(&str) -> Result<String>,
{
    let _guard = strata_lock().lock().unwrap_or_else(|e| e.into_inner());
    let text = fs::read_to_string(path).with_context(|| format!("读 config 失败: {}", path.display()))?;
    let next = build(&text)?;
    validate_config_text(&next)?;
    write_config_raw_locked(path, &next)
}

/// 已持锁时的落盘：备份 → 写临时文件 → rename。
fn write_config_raw_locked(path: &Path, text: &str) -> Result<()> {
    // W3：备份固定一份 `<config>.json.bak`，每次覆盖（用户 m03392：不要堆积带时间戳的多份，
    // 与 `model_config::write_config` / `settings` 的备份策略一致）。
    //
    // 备份失败就取消写入：这层备份是「改坏了能回滚」的唯一凭据，静默吞掉等于在磁盘满 /
    // 文件被占用时直接毁掉原 config（审查发现，原实现是 `let _ = fs::copy(..)`）。
    let backup = path.with_extension("json.bak");
    if let Err(err) = fs::copy(path, &backup) {
        anyhow::bail!("备份 {} 失败，已取消写入: {err}", backup.display());
    }

    // W4：原子写（临时文件名唯一，见 `temp_config_path`）。rename 失败时清掉临时文件，
    // 别在 config 目录里留半份垃圾。
    let tmp = temp_config_path(path);
    fs::write(&tmp, &text).with_context(|| format!("写入临时文件失败: {}", tmp.display()))?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err).with_context(|| format!("替换 config 失败: {}", path.display()));
    }
    Ok(())
}

/// 顶层 JSON 键 → (值起点, 值终点) 的字节范围。
///
/// 为什么不用 `serde_json` 读改写：`serde_json` 没开 `preserve_order`，`Value` 的对象是
/// `BTreeMap`，序列化回写会把键按字母序打乱、把 `\/` 变 `/`，等于每次改一个字段就重写整份
/// 文件。config 的键序与缩进是上游 `setup.py` 写的（用户在左栏直接看原文），不能动。
/// 所以只在**原文的字节区间**上做替换，思路同 [`rewrite_config_strings`]。
///
/// 只认顶层（深度 1）的键：`args` 里的字符串、嵌套对象里的同名键都不碰。
fn top_level_values(text: &str) -> Vec<(String, usize, usize)> {
    let bytes = text.as_bytes();
    let mut out: Vec<(String, usize, usize)> = Vec::new();
    let mut i = 0usize;
    let mut depth = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let Some(end) = scan_json_string(bytes, i) else { break };
                if depth == 1 {
                    let key = String::from_utf8_lossy(&bytes[i + 1..end - 1]).to_string();
                    let colon = skip_json_ws(bytes, end);
                    if bytes.get(colon) == Some(&b':') {
                        let start = skip_json_ws(bytes, colon + 1);
                        if let Some(stop) = scan_json_value(bytes, start) {
                            out.push((key, start, stop));
                        }
                    }
                }
                i = end;
            }
            b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            _ => i += 1,
        }
    }
    out
}

fn skip_json_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    i
}

/// `i` 指向开引号，返回闭引号之后的位置。
fn scan_json_string(bytes: &[u8], mut i: usize) -> Option<usize> {
    if bytes.get(i) != Some(&b'"') {
        return None;
    }
    i += 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// `i` 指向值的首字节，返回值结束后的位置（不含尾随空白与逗号）。
fn scan_json_value(bytes: &[u8], i: usize) -> Option<usize> {
    match *bytes.get(i)? {
        b'"' => scan_json_string(bytes, i),
        b'[' | b'{' => {
            let mut depth = 0usize;
            let mut j = i;
            while j < bytes.len() {
                match bytes[j] {
                    b'"' => {
                        j = scan_json_string(bytes, j)?;
                        continue;
                    }
                    b'[' | b'{' => depth += 1,
                    b']' | b'}' => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            return Some(j + 1);
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            None
        }
        _ => {
            let mut j = i;
            while j < bytes.len() && !matches!(bytes[j], b',' | b'}' | b']' | b'\n' | b'\r') {
                j += 1;
            }
            let mut end = j;
            while end > i && bytes[end - 1].is_ascii_whitespace() {
                end -= 1;
            }
            Some(end)
        }
    }
}

/// 把 config 顶层的 `api_key` 设成 `key`（`None` = 写 `null`，引擎就不再要求鉴权）。
///
/// 用户 m01543：设置页「服务」里的 API Key 必须落进每个引擎的 config ——
/// llama.cpp 侧由 `configSetApiKey` 写各自 config，Strata 侧读顶层 `api_key`，就在这里写。
/// 值写 `null` 而不是删键：删键要处理前后逗号（键序是上游写的，不能重排），
/// 而 `null` 在上游等价于「没有 key」（`cfg.get("api_key")` 取不到字符串）。
pub fn set_config_api_key(path: &Path, key: Option<&str>) -> Result<()> {
    let rendered = match key {
        Some(value) => serde_json::to_string(value).context("编码 API Key 失败")?,
        None => "null".to_string(),
    };
    update_config(path, |text| {
        Ok(
            match top_level_values(text).into_iter().find(|(name, ..)| name == "api_key") {
                Some((_, start, end)) => format!("{}{}{}", &text[..start], rendered, &text[end..]),
                None => {
                    // 没有这个键：插在开头的 `{` 之后，缩进对齐顶层其它键（1 空格）。
                    let brace = text.find('{').context("config 原文不是 JSON 对象")?;
                    format!("{}\n \"api_key\": {},{}", &text[..=brace], rendered, &text[brace + 1..])
                }
            },
        )
    })
}

/// 把 API Key 写进全部 Strata config（`<根>\strata-*.json`），返回（已写, 失败）。
///
/// 用户在设置页点保存时调用（用户 m01543 第 1 条）：GUI 里的 Key 必须和 config 里的一致，
/// 否则 GUI 以为要鉴权、引擎却不认。空字符串按「清掉」处理（写 `null`）。
pub fn set_api_key_all(root: &Path, key: Option<&str>) -> (Vec<String>, Vec<String>) {
    let mut written = Vec::new();
    let mut failed = Vec::new();
    let dir = configs_dir(root);
    let Ok(entries) = fs::read_dir(&dir) else {
        return (written, failed);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if !is_config_file(&name) {
            continue;
        }
        match set_config_api_key(&path, key) {
            Ok(()) => written.push(name),
            Err(_) => failed.push(name),
        }
    }
    (written, failed)
}

/// 把 config 顶层的 `args` 整体换成 `args`（调优结果落盘用，用户 m01544）。
///
/// 只换数组中括号那一段，其余字节原样保留（同 [`top_level_values`] 的理由）。
pub fn write_config_args(path: &Path, args: &[String]) -> Result<()> {
    update_config(path, |text| {
        let (start, end) = top_level_values(text)
            .into_iter()
            .find(|(name, ..)| name == "args")
            .map(|(_, start, end)| (start, end))
            .context("config 缺少顶层 args 数组，已取消写入")?;
        let mut rendered = String::from("[");
        if args.is_empty() {
            rendered.push_str("\n ]");
        } else {
            for (index, item) in args.iter().enumerate() {
                // 与上游 `json.dumps(cfg, indent=1)` 一致：数组元素缩进 2 空格、闭合括号 1 空格。
                rendered.push_str(if index == 0 { "\n  " } else { ",\n  " });
                rendered.push_str(&serde_json::to_string(item)?);
            }
            rendered.push_str("\n ]");
        }
        Ok(format!("{}{}{}", &text[..start], rendered, &text[end..]))
    })
}

// ---------------------------------------------------------------------------
// 控制器跟踪的引擎版本与回退（用户 m02756）
// ---------------------------------------------------------------------------

/// 引擎版本状态：**由 Strata 控制器决定，不让用户选**（用户 m02756 第 2 条）。
///
/// 数据源是控制端自己的判断（`strata components engine`），不是 GUI 扫目录猜的：
/// 控制器知道 pin、上一版、能不能用，这几样目录里看不出来。
#[derive(Debug, Clone, Serialize)]
pub struct StrataEngineState {
    /// 控制器当前会启动的引擎版本，如 `0.1.48`
    pub version: Option<String>,
    /// Strata 的发布版本，如 `0.2.7`（取自 `engine-component.json` 的 notes 开头）。
    ///
    /// 控制端目录名与引擎组件号都走 `0.1.x` 那条线，而 `catalog.ts` 的家族门禁（deepseek41
    /// 要 `0.2.5`）用的是发布版本线 —— 两者不能直接比，否则 0.1.52 会被误判成「太旧」。
    pub release: Option<String>,
    /// 引擎目录名（`<版本>-<平台>-<后端>`），如 `0.1.48-windows-x86_64-cuda-cuda13`
    pub folder: Option<String>,
    /// 上一版（上次更新留下的那份）；为空 = 没有可回退的版本
    pub previous: Option<String>,
    /// 被 pin 住的版本（回退之后出现，下次更新成功才清掉）
    pub pinned: Option<String>,
    pub usable: bool,
    pub update_notice: Option<String>,
}

/// 起一次控制端 python 跑 `strata.py components …`，返回解析后的 JSON。
///
/// `ok=false` 当成失败往上抛，错误消息原样带出控制端的说法（例如
/// "there is no previous engine to return to …"），前端直接展示。
fn run_components(args: &[&str], timeout: Duration) -> Result<serde_json::Value> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .context("未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）")?;
    let terminal = crate::strata_tune::terminal_dir(&root)
        .context("未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）")?;
    let python = terminal.join("python").join(crate::strata_tune::python_name());
    let script = terminal.join("strata.py");
    if !script.is_file() {
        anyhow::bail!("控制端缺少 strata.py：{}", script.display());
    }
    // `components` 默认去 `%LOCALAPPDATA%\Strata\components` 找组件包，那跟「Strata 目录」是两回事
    // （用户 m00194：设置页报「读取 Strata 引擎版本失败：控制端拒绝了这次操作」—— 控制端根本
    // 没看 `<根>\engine`）。`engine` / `rollback` 都支持 `--components-dir`（`verify` / `plan` /
    // `backends` 不支持，别乱加），显式指到根目录，与控制端 `update --components-dir` 的口径一致。
    let root_text = root.to_string_lossy().to_string();
    let wants_dir = matches!(args.first().copied(), Some("engine") | Some("rollback"));
    let mut full: Vec<&str> = args.to_vec();
    if wants_dir {
        full.push("--components-dir");
        full.push(root_text.as_str());
    }
    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("components")
        .args(&full)
        .current_dir(&terminal)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    winfix::hide_console(&mut cmd);
    // 控制端 python 也是外部进程：卡住（缺组件、等待输入）时不能无限期等着把界面拖死（审查发现）
    let Some(out) = winfix::output_with_timeout(&mut cmd, timeout) else {
        anyhow::bail!(
            "strata components {} 超过 {} 秒没有结果，已放弃",
            args.first().copied().unwrap_or(""),
            timeout.as_secs()
        );
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    // 控制端会先打几行人读日志；JSON 是最后一行以 `{` 开头的输出。
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .with_context(|| {
            format!(
                "strata components {} 没有输出 JSON（退出码 {:?}）：{}",
                args.first().copied().unwrap_or(""),
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            )
        })?;
    let value: serde_json::Value =
        serde_json::from_str(line.trim()).context("解析 strata components 输出失败")?;
    if value.get("ok").and_then(|item| item.as_bool()) == Some(false) {
        // 旧版控制端把原因写在 `error.message`；新版（0.1.52 起）实测放在顶层 `notice`
        // （"No engine for this PC was found in …"），只看 `error` 会退化成一句没头没尾的
        // 「控制端拒绝了这次操作」（用户 m00194 就是这么撞上的）。
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|item| item.as_str())
            .or_else(|| value.get("error").and_then(|item| item.as_str()))
            .or_else(|| value.get("notice").and_then(|item| item.as_str()))
            .unwrap_or("控制端拒绝了这次操作");
        anyhow::bail!("{}", message);
    }
    Ok(value)
}

/// 读控制器眼里的引擎状态（`strata components engine --output json`）。
pub fn engine_state() -> Result<StrataEngineState> {
    let value = run_components(&["engine", "--output", "json"], Duration::from_secs(120))?;
    let text = |source: Option<&serde_json::Value>, key: &str| {
        source
            .and_then(|item| item.get(key))
            .and_then(|item| item.as_str())
            .map(|text| text.to_string())
    };
    let engine = value.get("engine");
    let root = text(engine, "root");
    let version = text(engine, "version");
    let release = release_version(root.as_deref());
    let folder = root
        .as_deref()
        .and_then(|root| Path::new(root).file_name().map(|name| name.to_string_lossy().to_string()));
    Ok(StrataEngineState {
        version,
        release,
        folder,
        previous: text(Some(&value), "previous"),
        pinned: text(Some(&value), "pinned"),
        usable: value.get("usable").and_then(|item| item.as_bool()).unwrap_or(false),
        update_notice: text(Some(&value), "update_notice"),
    })
}

/// 从引擎目录的 `engine-component.json` 里读出 Strata 发布版本。
///
/// 这份元数据的 `version` 是组件号（`0.1.52`），发布版本写在 `notes` 开头：
/// `"0.2.7 NVIDIA cuda13 engine with the CUDA picture reader (strata-vision)"`。
/// 读不到（旧引擎没这份文件）就返回 None —— 界面据此放弃发布级门禁，
/// 不再拿组件号硬比（用户 m01630：控制端 0.1.52 = Strata 0.2.7，不该被拦）。
fn release_version(root: Option<&str>) -> Option<String> {
    let root = root?;
    let text = fs::read_to_string(Path::new(root).join("engine-component.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let notes = value.get("notes")?.as_str()?;
    let head = notes.split_whitespace().next()?;
    let mut parts = head.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: u32 = parts.next()?.parse().ok()?;
    Some(match parts.next() {
        Some(patch) => format!("{major}.{minor}.{}", patch.parse::<u32>().unwrap_or(0)),
        None => format!("{major}.{minor}"),
    })
}

/// 回退到上一版引擎（`strata components rollback --output json`），返回给用户看的一句结果。
///
/// 回退只是把上一版 pin 住、把「当前」挪过去，引擎文件不动；下次成功更新会清掉 pin。
pub fn rollback_engine() -> Result<String> {
    // 回退要下载 / 解包组件包，给足时间（但仍有上限）
    let value = run_components(&["rollback", "--output", "json"], Duration::from_secs(900))?;
    // 成功时 CLI 包成 `{ok: true, result: {...}}`（也有版本直接平铺），两种都认。
    let result = value.get("result").unwrap_or(&value);
    let to = result
        .get("to")
        .and_then(|item| item.as_str())
        .unwrap_or("上一版");
    let from = result.get("from").and_then(|item| item.as_str());
    Ok(match from {
        Some(from) if from != to => format!("已把引擎回退到 {to}（从 {from}）"),
        _ => format!("引擎已回退到 {to}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ports_are_allocated_from_9091_and_written_to_config_and_run_script() {
        // 用户 m05322：strata 模型端口自动分配，从 9091 起，逻辑同 llama.cpp；
        // 真正生效的是 run-<slug>.bat 的 --port，所以两处要一起改。
        let root = std::env::temp_dir().join(format!("strata-port-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        for (file, port) in [("strata-a.json", 9091u16), ("strata-b.json", 9092)] {
            let body = serde_json::json!({
                "exe": "strata-engine",
                "args": [],
                "model_name": file,
                "port": port,
            });
            fs::write(root.join(file), body.to_string()).unwrap();
        }
        // 缺端口的那份 + 它的 run 脚本（脚本里是旧端口）
        let body = serde_json::json!({"exe": "strata-engine", "args": [], "model_name": "c"});
        fs::write(root.join("strata-c.json"), body.to_string()).unwrap();
        fs::write(
            root.join("run-c.bat"),
            "@echo off\r\n\"python.exe\" \"server.py\" \"--engine\" \"strata\" \"--port\" \"8080\"\r\n",
        )
        .unwrap();

        // c 缺端口 → parse_config 记 0
        let c = scan_configs(&root, None)
            .into_iter()
            .find(|e| e.model_name == "c")
            .unwrap();
        assert_eq!(c.port, 0);

        let port = allocate_port(&root, "strata-c.json");
        assert_eq!(port, 9093, "9091/9092 已被别的 config 声明，应跳过");
        set_port(&root, "strata-c.json", port).unwrap();

        let raw = fs::read_to_string(root.join("strata-c.json")).unwrap();
        assert!(raw.contains("\"port\": 9093"), "config 没写上新端口：{raw}");
        let bat = fs::read_to_string(root.join("run-c.bat")).unwrap();
        assert!(
            bat.contains("\"--port\" \"9093\""),
            "run 脚本要跟着改成同一个端口：{bat}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 官方布局里 config 与 `run-*.bat` 在 `<根>\install`；没建 install 时退回根本身
    /// （手动解包安装、以及大量老测试都直接往根里放 config）。
    #[test]
    fn configs_live_in_the_install_subfolder_after_official_install() {
        let root = std::env::temp_dir().join(format!("strata-configs-dir-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert_eq!(configs_dir(&root), root, "没有 install 子目录时根就是 config 目录");

        let install = root.join("install");
        fs::create_dir_all(&install).unwrap();
        assert_eq!(configs_dir(&root), install, "官方安装后 config 在 install 下");

        // 扫描、写端口、找 run 脚本三条路径都要落在 install 里
        let body = serde_json::json!({"exe": "strata-engine", "args": [], "model_name": "a", "port": 9091});
        fs::write(install.join("strata-a.json"), body.to_string()).unwrap();
        fs::write(
            install.join("run-a.bat"),
            "@echo off\r\n\"python.exe\" \"server.py\" \"--engine\" \"strata\" \"--port\" \"9091\"\r\n",
        )
        .unwrap();
        let entries = scan_configs(&root, None);
        assert_eq!(entries.len(), 1, "config 在 install 下也要被扫到");
        assert_eq!(entries[0].model_name, "a");
        assert!(
            find_run_script(&root, "a").is_some(),
            "run 脚本也要在 install 下找"
        );
        let _ = fs::remove_dir_all(&root);
    }

    /// 诊断：对真实安装目录跑一遍（`cargo test --lib probe_ensure_ports -- --ignored --nocapture`）。
    ///
    /// 注意：`cargo test` 进程在本机被沙箱限制成只能写工作区，所以这里的 `ensure_ports`
    /// 在真实目录上一定写失败（`os error 5`），只能看分配出来的端口号对不对。
    #[test]
    #[ignore]
    fn probe_ensure_ports() {
        let Some(root) = std::env::var_os("STRATA_PROBE_ROOT")
            .map(PathBuf::from)
            .or_else(|| crate::strata::root())
        else {
            println!("未指定 Strata 目录（没有兜底默认值，先用 STRATA_PROBE_ROOT 或设置里指定），跳过");
            return;
        };
        configure_root(Some(root.clone()));
        for e in scan_configs(&root, None) {
            println!("entry {} port={}", e.model_name, e.port);
        }
        println!("allocate={}", allocate_port(&root, "strata-zz-autoport-test.json"));
    }

    #[test]
    fn ensure_ports_fills_missing_ports_only() {
        let root = std::env::temp_dir().join(format!("strata-ensure-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let with_port = serde_json::json!({
            "exe": "strata-engine", "args": [], "model_name": "a", "port": 9095u16
        });
        fs::write(root.join("strata-a.json"), with_port.to_string()).unwrap();
        let without = serde_json::json!({"exe": "strata-engine", "args": [], "model_name": "b"});
        fs::write(root.join("strata-b.json"), without.to_string()).unwrap();
        // 安装器默认端口（用户 m05516）：也要当「没定制过」重新分配
        let default_port = serde_json::json!({
            "exe": "strata-engine", "args": [], "model_name": "c", "port": 8080u16
        });
        fs::write(root.join("strata-c.json"), default_port.to_string()).unwrap();

        assert_eq!(ensure_ports(&root), 2, "缺端口的和默认 8080 的都要被补");
        // 端口不写死：本机真实环境里 9091 可能正被引擎占着，`allocate_port` 会顺延。
        let port_of = |file: &str| {
            let raw = fs::read_to_string(root.join(file)).unwrap();
            serde_json::from_str::<serde_json::Value>(&raw).unwrap()["port"]
                .as_u64()
                .unwrap()
        };
        let (b, c) = (port_of("strata-b.json"), port_of("strata-c.json"));
        assert!(b >= STRATA_PORT_BASE as u64, "从 9091 起分配：{b}");
        assert!(c >= STRATA_PORT_BASE as u64, "8080 的那份也要分配：{c}");
        assert_ne!(b, c, "两份不能落到同一个端口");
        assert_eq!(ensure_ports(&root), 0, "第二次不该再动");
        let _ = fs::remove_dir_all(&root);
    }

    /// 用户 m04159：`component:strata-engine` 由 server.py 自己解析，手动解压的布局里
    /// 官方组件目录是空的，于是「启动模型」直接报 No engine for this PC。扫描时落成绝对路径。
    #[test]
    fn settle_engine_expands_component_reference() {
        let root = std::env::temp_dir().join(format!("strata-settle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let engines = root.join("engine");
        fs::create_dir_all(&engines).unwrap();
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&engines, "0.1.54", &host_platform(), exe);
        // `vision_sibling()` 要求同目录真有视觉可执行文件，否则不会动 `vision.exe`。
        let vision = if cfg!(windows) { "strata-vision.exe" } else { "strata-vision" };
        fs::write(
            engines
                .join(format!("0.1.54-{}-cuda", host_platform()))
                .join(vision),
            b"",
        )
        .unwrap();

        let configs = configs_dir(&root);
        fs::create_dir_all(&configs).unwrap();
        fs::write(
            configs.join("strata-demo.json"),
            serde_json::json!({
                "exe": "component:strata-engine",
                "args": [],
                "model_name": "demo",
                "vision": { "exe": "component:strata-engine", "mmproj": "m.gguf" }
            })
            .to_string(),
        )
        .unwrap();

        assert_eq!(settle_engine(&root), 1, "引用应被展开");
        let expected = resolve_component(&root, "strata-engine").unwrap().exe;
        let raw = fs::read_to_string(configs.join("strata-demo.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["exe"].as_str().unwrap(), expected.to_string_lossy());
        assert_eq!(
            value["vision"]["exe"].as_str().unwrap(),
            expected
                .parent()
                .unwrap()
                .join(vision)
                .to_string_lossy(),
            "vision 也要一起落成路径（同目录的视觉可执行文件）"
        );
        assert_eq!(settle_engine(&root), 0, "第二次不该再动");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn config_file_filter_excludes_shared_settings() {
        assert!(is_config_file("strata-swift-iq3_xxs.json"));
        assert!(!is_config_file("strata-swift-iq3_xxs.shared-settings.json"));
        assert!(!is_config_file("config.json"));
        assert!(!is_config_file("strata-x.txt"));
    }

    #[test]
    fn shard_info_parses_gguf_shard_names() {
        let (base, index, total) = shard_info("Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf").unwrap();
        assert_eq!(base, "Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS");
        assert_eq!((index, total), (1, 2));
        assert!(shard_info("model.gguf").is_none());
        assert!(shard_info("model-00001-of-00002.bin").is_none());
        assert!(shard_info("-00001-of-00002.gguf").is_none());
        assert!(shard_info("m-00001-of-00000.gguf").is_none());
    }

    #[test]
    fn model_size_sums_shards_and_skips_sidecars() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-strata-size-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("m-00001-of-00003.gguf"), vec![7u8; 100]).unwrap();
        fs::write(dir.join("m-00002-of-00003.gguf"), vec![7u8; 50]).unwrap();
        // 校验附属文件不在枚举里，绝不能算进模型大小
        fs::write(dir.join("m-00003-of-00003.gguf.done"), b"checksum").unwrap();
        fs::write(dir.join("plain.gguf"), vec![7u8; 8]).unwrap();
        let total = model_size_bytes(&dir.join("m-00001-of-00003.gguf"));
        let single = model_size_bytes(&dir.join("plain.gguf"));
        let _ = fs::remove_dir_all(&dir);
        // 第 3 片缺失（只有 .done 附属文件）：只累加存在的分片
        assert_eq!(total, Some(150));
        // 非分片命名：取该文件自身大小
        assert_eq!(single, Some(8));
    }

    #[test]
    fn quote_tokens_extracts_executable_and_args() {
        let line = r#""E:\AI\Strata\.venv\Scripts\python.exe" "E:\AI\Strata\serve\server.py" "--engine" "strata" "--port" "9090" "--open""#;
        let tokens = quote_tokens(line);
        assert_eq!(tokens[0], r"E:\AI\Strata\.venv\Scripts\python.exe");
        assert_eq!(tokens[1], r"E:\AI\Strata\serve\server.py");
        assert_eq!(tokens.last().unwrap(), "--open");
    }

    #[test]
    fn arg_value_follows_upstream_val_semantics() {
        let args: Vec<serde_json::Value> = serde_json::from_str(
            r#"["--pack","p","--max-context","204800","--kv","k8v4","--native"]"#,
        )
        .unwrap();
        assert_eq!(arg_value(&args, "--max-context").as_deref(), Some("204800"));
        assert_eq!(arg_value(&args, "--kv").as_deref(), Some("k8v4"));
        // 布尔 flag 后面没有值时不能把下一个 flag 当值吃掉越界取。
        assert_eq!(arg_value(&args, "--native"), None);
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn write_config_rejects_upstream_invisible_shapes() {
        let dir = std::env::temp_dir().join(format!("dsh-strata-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("strata-test.json");
        fs::write(&path, r#"{"exe":"a.exe","args":["--x"]}"#).unwrap();

        // args 不是数组 → 上游会跳过这份 config，必须拒绝。
        let err = write_config_raw(&path, r#"{"exe":"a.exe","args":{}}"#).unwrap_err();
        assert!(err.to_string().contains("args"));
        // 原文件未被改动。
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"exe":"a.exe","args":["--x"]}"#);

        // 合法写入成功，并留下唯一一份固定名备份（不带时间戳）。
        write_config_raw(&path, r#"{"exe":"a.exe","args":["--x","1"]}"#).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"exe":"a.exe","args":["--x","1"]}"#);
        assert_eq!(
            fs::read_to_string(dir.join("strata-test.json.bak")).unwrap(),
            r#"{"exe":"a.exe","args":["--x"]}"#,
            "备份应是上一次写入前的内容"
        );
        let backups = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".bak"))
            .count();
        assert_eq!(backups, 1, "只该留一份备份");

        // 再写一次：备份被覆盖，仍然只有一份。
        write_config_raw(&path, r#"{"exe":"a.exe","args":["--x","2"]}"#).unwrap();
        let backups = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".bak"))
            .count();
        assert_eq!(backups, 1, "第二次写入仍只该有一份备份");

        let _ = fs::remove_dir_all(&dir);
    }

    /// 用户显式指定 Strata 目录（手动解压布局）时，bat / config 就在那个目录本身，
    /// **不再去探测 `<根>\install`**（用户 m00717）。
    #[test]
    fn configs_dir_uses_the_chosen_root_even_when_it_has_an_install_subdir() {
        let dir = std::env::temp_dir().join(format!("dsh-strata-root-{}", now_ms()));
        fs::create_dir_all(dir.join("install")).unwrap();
        assert_eq!(configs_dir_with(&dir, true), dir, "指定了目录就该用目录本身");
        assert_eq!(configs_dir_with(&dir, false), dir.join("install"), "默认官方布局仍看 install");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 没有 `install` 子目录时（官方布局也一样）落到根目录本身。
    #[test]
    fn configs_dir_falls_back_to_the_root_without_install() {
        let dir = std::env::temp_dir().join(format!("dsh-strata-noinstall-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(configs_dir_with(&dir, false), dir);
        assert_eq!(configs_dir_with(&dir, true), dir);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 造一个 `engine-component.json` + entrypoint 文件的组件目录（0.2.x 布局）。
    fn put_component(dir: &Path, version: &str, platform: &str, exe: &str) {        let folder = dir.join(format!("{version}-{platform}-cuda"));
        fs::create_dir_all(&folder).unwrap();
        let manifest = format!(
            r#"{{"schema_version":2,"id":"strata-engine","version":"{version}","platform":"{platform}","entrypoint":"{exe}"}}"#
        );
        fs::write(folder.join("engine-component.json"), manifest).unwrap();
        fs::write(folder.join(exe), b"").unwrap();
    }

    #[test]
    fn list_engines_returns_every_bundled_version_newest_first() {
        let root = std::env::temp_dir().join(format!("llamacpp-gui-engines-{}", now_ms()));
        let _ = fs::remove_dir_all(&root);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let bundle = root.join("engine-bundle");
        put_component(&bundle, "0.1.40", "windows-x86_64", exe);
        put_component(&bundle, "0.1.46", "windows-x86_64", exe);

        let list = list_engines_with(&root);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version.as_deref(), Some("0.1.46"));
        assert_eq!(list[1].version.as_deref(), Some("0.1.40"));
        assert_eq!(list[0].platform.as_deref(), Some("windows-x86_64"));
        assert!(list[0].exe.is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn list_engines_accepts_renamed_engine_directory() {
        // 用户 m04254：安装器把 `engine-bundle` 改名成了 `engine`
        let root = std::env::temp_dir().join(format!("llamacpp-gui-engines-renamed-{}", now_ms()));
        let _ = fs::remove_dir_all(&root);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&root.join("engine"), "0.1.47", &host_platform(), exe);

        let list = list_engines_with(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version.as_deref(), Some("0.1.47"));
        // 解析链路也要走同一个候选集合，否则列出了却选不中
        let found = resolve_component(&root, ENGINE_COMPONENT_ID).unwrap();
        assert_eq!(found.exe, list[0].exe);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn engines_are_found_when_the_root_is_the_engine_folder() {
        // 安装目录被直接指到引擎目录（`E:\AI\Strata\engine`）
        let root = std::env::temp_dir().join(format!("llamacpp-gui-engines-as-root-{}", now_ms()));
        let _ = fs::remove_dir_all(&root);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&root, "0.1.47", &host_platform(), exe);

        let list = list_engines_with(&root);
        assert_eq!(list.len(), 1);
        assert!(list[0].exe.is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn engines_are_found_under_any_folder_name() {
        // 目录名不参与判断（用户 m04258：不要硬编码，就在根目录下找引擎文件）
        let root = std::env::temp_dir().join(format!("llamacpp-gui-engines-anyname-{}", now_ms()));
        let _ = fs::remove_dir_all(&root);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&root.join("whatever"), "0.1.47", &host_platform(), exe);
        put_component(&root, "0.1.48", &host_platform(), exe);

        let list = list_engines_with(&root);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version.as_deref(), Some("0.1.48"));
        assert_eq!(list[1].version.as_deref(), Some("0.1.47"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn set_engine_switches_config_to_the_chosen_version() {
        let root = std::env::temp_dir().join(format!("llamacpp-gui-setengine-{}", now_ms()));
        let _ = fs::remove_dir_all(&root);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let bundle = root.join("engine-bundle");
        put_component(&bundle, "0.1.40", "windows-x86_64", exe);
        put_component(&bundle, "0.1.46", "windows-x86_64", exe);
        let list = list_engines_with(&root);
        let old = list[1].exe.to_string_lossy().to_string();
        let new = list[0].exe.to_string_lossy().to_string();
        let path = root.join("strata-demo.json");
        let config = serde_json::json!({"exe": old, "args": ["--port", "9091"]});
        fs::write(&path, serde_json::to_string_pretty(&config).unwrap()).unwrap();

        set_engine(&root, "strata-demo.json", &new).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value.get("exe").and_then(|v| v.as_str()), Some(new.as_str()));
        // 其余键原样保留
        assert_eq!(
            value.get("args").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(2)
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn component_reference_resolves_newest_matching_engine() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-components-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&dir, "0.1.45", &host_platform(), exe);
        put_component(&dir, "0.1.46", &host_platform(), exe);
        // 别的平台、别的组件 id 都不能被选中
        put_component(&dir, "0.9.99", "linux-x86_64", exe);
        let other = dir.join("0.9.98-windows-x86_64-cuda");
        fs::create_dir_all(&other).unwrap();
        fs::write(
            other.join("engine-component.json"),
            r#"{"schema_version":2,"id":"strata-vision","version":"0.9.98","entrypoint":"v.exe"}"#,
        )
        .unwrap();
        fs::write(other.join("v.exe"), b"").unwrap();

        let found = resolve_component(&dir, "strata-engine").unwrap();
        assert_eq!(component_version_at(&found.exe).as_deref(), Some("0.1.46"));
        assert_eq!(
            found.exe.parent().unwrap().file_name().unwrap().to_string_lossy(),
            format!("0.1.46-{}-cuda", host_platform())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// control 0.1.47 起 run 脚本靠 `active.json` 选版本子目录（用户 m05626）。
    #[test]
    fn run_script_resolves_control_version_folder() {
        let root = std::env::temp_dir().join(format!("strata-bat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let py = if cfg!(windows) { "python.exe" } else { "python" };
        let control = root.join("control");
        let ver = control.join("0.1.47");
        fs::create_dir_all(ver.join("python")).unwrap();
        fs::create_dir_all(ver.join("serve")).unwrap();
        fs::write(ver.join("python").join(py), b"").unwrap();
        fs::write(ver.join("serve").join("server.py"), b"").unwrap();
        fs::write(
            control.join("active.json"),
            r#"{"version":"0.1.47","folder":"0.1.47"}"#,
        )
        .unwrap();
        let bat = root.join("run-demo.bat");
        let script = format!(
            "@echo off\n\
             set \"ROOT={control}\"\n\
             for /f \"usebackq delims=\" %%v in (`powershell -NoProfile -Command \"(Get-Content -LiteralPath '%ROOT%\\active.json' -Raw | ConvertFrom-Json).folder\"`) do set \"VER=%%v\"\n\
             cd /d \"%ROOT%\\%VER%\"\n\
             \"%ROOT%\\%VER%\\python\\{py}\" \"%ROOT%\\%VER%\\serve\\server.py\" \"--engine\" \"strata\" \"--config\" \"E:\\x.json\" \"--port\" \"9092\"\n",
            control = control.display(),
            py = py,
        );
        fs::write(&bat, script).unwrap();

        let (exe, args, cwd) = parse_run_script(&bat).expect("应当能展开 %ROOT% / %VER%");
        assert_eq!(exe, ver.join("python").join(py));
        assert_eq!(cwd.as_deref(), Some(ver.as_path()), "cwd 取 cd /d 的目标");
        assert_eq!(args[0], ver.join("serve").join("server.py").to_string_lossy());
        assert_eq!(args.last().unwrap(), "9092");
        let _ = fs::remove_dir_all(&root);
    }

    /// 诊断：真实安装目录下三份 run 脚本的解析结果（`cargo test --lib probe_run_scripts -- --ignored --nocapture`）。
    #[test]
    #[ignore]
    fn probe_run_scripts() {
        let root = Path::new("E:/AI/Strata");
        for name in [
            "run-sc117-swift-iq2-xs.bat",
            "run-swift-iq3_xxs.bat",
            "run-gyro-gyro-m.bat",
        ] {
            let bat = root.join(name);
            match parse_run_script(&bat) {
                Some((exe, args, cwd)) => println!(
                    "{name}: exe={} cwd={:?} args={:?}",
                    exe.display(),
                    cwd,
                    args
                ),
                None => println!("{name}: 解析失败"),
            }
        }
    }

    #[test]
    fn fallback_command_prefers_control_layout() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-fallback-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let py = if cfg!(windows) { "python.exe" } else { "python" };
        let config = dir.join("strata-x.json");

        // 只有 0.1.x 布局（.venv + serve）时用旧的那套
        let venv = dir.join(".venv").join(if cfg!(windows) { "Scripts" } else { "bin" });
        fs::create_dir_all(&venv).unwrap();
        fs::write(venv.join(py), b"").unwrap();
        fs::create_dir_all(dir.join("serve")).unwrap();
        fs::write(dir.join("serve").join("server.py"), b"").unwrap();
        let (exe, args, _) = fallback_command(&dir, &config, 9091);
        assert!(exe.ends_with(venv.join(py)));
        assert_eq!(
            args[0],
            dir.join("serve").join("server.py").to_string_lossy()
        );

        // control 0.1.46 布局出现后优先 control（自带解释器）
        fs::create_dir_all(dir.join("control").join("python")).unwrap();
        fs::write(dir.join("control").join("python").join(py), b"").unwrap();
        fs::create_dir_all(dir.join("control").join("serve")).unwrap();
        fs::write(dir.join("control").join("serve").join("server.py"), b"").unwrap();
        let (exe, args, _) = fallback_command(&dir, &config, 9091);
        assert!(exe.ends_with(dir.join("control").join("python").join(py)));
        assert_eq!(
            args[0],
            dir.join("control").join("serve").join("server.py").to_string_lossy()
        );
        assert_eq!(args.last().unwrap(), "9091");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn preferred_engine_overrides_config_declaration() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-engine-pref-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let bundle = dir.join("engine-bundle");
        fs::create_dir_all(&bundle).unwrap();
        put_component(&bundle, "0.1.46", &host_platform(), exe);
        put_component(&bundle, "0.1.47", &host_platform(), exe);
        let older = bundle
            .join(format!("0.1.46-{}-cuda", host_platform()))
            .join(exe);
        let chosen = bundle
            .join(format!("0.1.47-{}-cuda", host_platform()))
            .join(exe);
        let config = dir.join("strata-x.json");
        // config 声明的是旧版本，而且那个文件还在（不会被「升级删目录」的逻辑触发）
        let text = serde_json::json!({ "exe": older.to_string_lossy(), "args": [] }).to_string();
        fs::write(&config, &text).unwrap();

        // 设置里没选过：尊重 config 的声明
        let entry = parse_config(&config, None).unwrap();
        assert_eq!(entry.engine, older);
        assert!(!entry.engine_stale);

        // 设置页选了 0.1.47：它才是权威，config 跟着改回来（用户 m04069）
        let entry = parse_config(&config, Some(&chosen)).unwrap();
        assert_eq!(entry.engine, chosen);
        assert_eq!(entry.engine_version.as_deref(), Some("0.1.47"));
        assert!(entry.engine_stale);
        let saved = fs::read_to_string(&config).unwrap();
        assert!(saved.contains("0.1.47"));
        assert!(!saved.contains("0.1.46"));
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    #[ignore = "读本机真实的 Strata 目录（需先在设置里指定，或给 STRATA_PROBE_ROOT），只在诊断引擎状态时手动跑"]
    fn probe_engine_state() {
        // 设置页的「Strata 引擎版本」卡走这里（用户 m02756）。
        // 没有兜底目录（用户 m00308）：`STRATA_PROBE_ROOT=E:\AI\Strata cargo test --lib probe_engine_state -- --ignored --nocapture`
        let Some(root) = std::env::var_os("STRATA_PROBE_ROOT")
            .map(PathBuf::from)
            .or_else(|| crate::strata::root())
        else {
            println!("未指定 Strata 目录，跳过");
            return;
        };
        configure_root(Some(root));
        let state = engine_state().expect("读控制器的引擎状态");
        println!("引擎状态 = {state:?}");
        // 回退要写 `<根>\components\.updates\update.lock`；DSH 沙箱里的 cargo test 以 Low
        // 完整性运行，写 Medium 文件必被拒（Errno 13），所以这里只打印结果，真正的回退
        // 验证走命令行 `strata components rollback`。
        match rollback_engine() {
            Ok(text) => println!("回退成功 = {text}"),
            Err(err) => println!("回退被拒绝 = {err:#}"),
        }
    }

    #[test]
    #[ignore = "读本机真实 Strata 目录（没有兜底默认值，必须用 STRATA_PROBE_ROOT 或先在设置里指定），只在诊断引擎解析时手动跑"]
    fn probe_real_install() {
        // 诊断手动解压的目录：`STRATA_PROBE_ROOT=E:\AI\strata cargo test --lib probe_real_install -- --ignored --nocapture`
        let root = std::env::var_os("STRATA_PROBE_ROOT")
            .map(PathBuf::from)
            .or_else(|| crate::strata::root());
        let Some(root) = root else {
            println!("未指定根目录，跳过");
            return;
        };
        println!("root = {}", root.display());
        println!("configs_dir = {}", configs_dir(&root).display());
        for controller in list_controllers(&root) {
            println!(
                "controller {:<10} active={} python={} server={} usable={} {}",
                controller.version,
                controller.active,
                controller.python,
                controller.server,
                controller.usable,
                controller.folder.display()
            );
        }
        let list = list_engines(&root);
        println!("engines = {list:?}");
        for entry in scan_configs(&root, None) {
            println!(
                "{} → exe={} exists={} version={:?} stale={} cwd={:?}",
                entry.config_path.display(),
                entry.engine.display(),
                entry.engine_exists,
                entry.engine_version,
                entry.engine_stale,
                entry.cwd
            );
        }
        for name in run_script_names(&configs_dir(&root)) {
            match parse_run_script(&configs_dir(&root).join(&name)) {
                Some((exe, args, cwd)) => {
                    println!("{name}: exe={} cwd={:?} args={args:?}", exe.display(), cwd)
                }
                None => println!("{name}: 解析失败"),
            }
        }
    }

    #[test]
    #[ignore = "会改写目录里的 run-*.bat 与 config，只在显式给 STRATA_PROBE_ROOT（建议指副本）时手动跑"]
    fn probe_apply_controller() {
        // `STRATA_PROBE_ROOT=E:\Code\llama.cpp-GUI\tmp\strata-copy STRATA_APPLY_VERSION=0.1.50 cargo test --lib probe_apply_controller -- --ignored --nocapture`
        let Some(root) = std::env::var_os("STRATA_PROBE_ROOT").map(PathBuf::from) else {
            println!("未指定 STRATA_PROBE_ROOT，跳过");
            return;
        };
        let version = std::env::var("STRATA_APPLY_VERSION").unwrap_or_else(|_| "0.1.50".to_string());
        let dir = configs_dir(&root);
        let before: Vec<(String, String)> = run_script_names(&dir)
            .iter()
            .map(|name| (name.clone(), fs::read_to_string(dir.join(name)).unwrap_or_default()))
            .collect();
        let result = apply_controller(&root, &version).unwrap();
        println!(
            "切到控制器 {}（{}）：脚本 {:?} / config {:?}",
            result.version,
            result.folder.display(),
            result.scripts,
            result.configs
        );
        for (name, old) in before {
            let new = fs::read_to_string(dir.join(&name)).unwrap_or_default();
            if old != new {
                println!("--- {name} ---\n{new}");
            }
        }
        for entry in scan_configs(&root, None) {
            println!(
                "{} cwd={:?} exe={} exists={}",
                entry.config_path.display(),
                entry.cwd,
                entry.engine.display(),
                entry.engine_exists
            );
        }
        for name in run_script_names(&dir) {
            match parse_run_script(&dir.join(&name)) {
                Some((exe, args, cwd)) => {
                    println!("{name}: exe={} cwd={:?} args={args:?}", exe.display(), cwd)
                }
                None => println!("{name}: 解析失败"),
            }
        }
    }

    #[test]
    fn component_reference_is_resolved_but_left_untouched() {
        // 用户 m04934：`component:strata-engine` 引用是合法形态（设置页已不再提供版本选择）。
        // 扫描只把它解析成真实 exe 给界面/启动用，不把 config 改写成绝对路径。
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-component-ref-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&dir.join("engine"), "0.1.47", &host_platform(), exe);
        let text = r#"{"exe":"component:strata-engine","args":[]}"#;
        let config = dir.join("strata-x.json");
        fs::write(&config, text).unwrap();

        let entry = parse_config(&config, None).unwrap();
        assert!(entry.engine_exists);
        assert!(!entry.engine_stale, "引用不触发改写");
        assert_eq!(entry.engine_version.as_deref(), Some("0.1.47"));
        assert_eq!(fs::read_to_string(&config).unwrap(), text, "config 一个字节都不变");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_engine_replaces_component_reference_with_absolute_path() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-set-ref-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&dir.join("engine"), "0.1.47", &host_platform(), exe);
        let target = dir
            .join("engine")
            .join(format!("0.1.47-{}-cuda", host_platform()))
            .join(exe);
        let text = r#"{"exe":"component:strata-engine","args":[]}"#;
        fs::write(dir.join("strata-x.json"), text).unwrap();

        set_engine(&dir, "strata-x.json", &target.to_string_lossy()).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("strata-x.json")).unwrap()).unwrap();
        assert_eq!(
            saved["exe"].as_str(),
            Some(target.to_string_lossy().as_ref()),
            "选版本后写绝对路径，不再是引用"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_engine_can_write_the_auto_reference() {
        // 传入的就是 `component:strata-engine` 引用（用户 m04934 的「自动」那一项，现在唯一形态）。
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-set-auto-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&dir.join("engine"), "0.1.47", &host_platform(), exe);
        let target = dir
            .join("engine")
            .join(format!("0.1.47-{}-cuda", host_platform()))
            .join(exe);
        let value = serde_json::json!({ "exe": target.to_string_lossy(), "args": [] });
        fs::write(
            dir.join("strata-x.json"),
            serde_json::to_string(&value).unwrap(),
        )
        .unwrap();

        set_engine(&dir, "strata-x.json", "component:strata-engine").unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("strata-x.json")).unwrap()).unwrap();
        assert_eq!(
            saved["exe"].as_str(),
            Some("component:strata-engine"),
            "写回组件引用时只解析成真实引擎、不改写文件"
        );
        // 引用也要能解析出真实引擎，否则设置页会显示成不存在
        let entry = parse_config(&dir.join("strata-x.json"), None).unwrap();
        assert!(entry.engine_exists);
        assert_eq!(entry.engine_version.as_deref(), Some("0.1.47"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_engine_syncs_vision_exe_to_the_new_version() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-set-vision-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let vision = if cfg!(windows) {
            "strata-vision.exe"
        } else {
            "strata-vision"
        };
        put_component(&dir.join("engine"), "0.1.46", &host_platform(), exe);
        put_component(&dir.join("engine"), "0.1.47", &host_platform(), exe);
        for version in ["0.1.46", "0.1.47"] {
            let folder = dir
                .join("engine")
                .join(format!("{version}-{}-cuda", host_platform()));
            fs::write(folder.join(vision), b"").unwrap();
        }
        let old_dir = dir
            .join("engine")
            .join(format!("0.1.46-{}-cuda", host_platform()));
        let new_dir = dir
            .join("engine")
            .join(format!("0.1.47-{}-cuda", host_platform()));
        let old_exe = old_dir.join(exe).to_string_lossy().to_string();
        let old_vision = old_dir.join(vision).to_string_lossy().to_string();
        let text = serde_json::json!({
            "exe": old_exe,
            "args": ["--port", "9091"],
            "vision": { "gpu": false, "exe": old_vision },
        })
        .to_string();
        fs::write(dir.join("strata-x.json"), &text).unwrap();

        set_engine(&dir, "strata-x.json", &new_dir.join(exe).to_string_lossy()).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("strata-x.json")).unwrap()).unwrap();
        assert_eq!(
            saved["exe"].as_str(),
            Some(new_dir.join(exe).to_string_lossy().as_ref())
        );
        assert_eq!(
            saved["vision"]["exe"].as_str(),
            Some(new_dir.join(vision).to_string_lossy().as_ref()),
            "vision 要一起换到新版本目录"
        );
        // 其余键原样保留
        assert_eq!(saved["vision"]["gpu"], serde_json::json!(false));
        assert_eq!(saved["args"], serde_json::json!(["--port", "9091"]));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn set_engine_keeps_vision_when_new_version_has_none() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-set-novision-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let vision = if cfg!(windows) {
            "strata-vision.exe"
        } else {
            "strata-vision"
        };
        put_component(&dir.join("engine"), "0.1.46", &host_platform(), exe);
        put_component(&dir.join("engine"), "0.1.47", &host_platform(), exe);
        let old_dir = dir
            .join("engine")
            .join(format!("0.1.46-{}-cuda", host_platform()));
        let new_dir = dir
            .join("engine")
            .join(format!("0.1.47-{}-cuda", host_platform()));
        let old_vision = old_dir.join(vision).to_string_lossy().to_string();
        fs::write(old_dir.join(vision), b"").unwrap();
        let text = serde_json::json!({
            "exe": old_dir.join(exe).to_string_lossy().to_string(),
            "args": [],
            "vision": { "exe": old_vision },
        })
        .to_string();
        fs::write(dir.join("strata-x.json"), &text).unwrap();

        set_engine(&dir, "strata-x.json", &new_dir.join(exe).to_string_lossy()).unwrap();
        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.join("strata-x.json")).unwrap()).unwrap();
        assert_eq!(
            saved["exe"].as_str(),
            Some(new_dir.join(exe).to_string_lossy().as_ref())
        );
        assert_eq!(
            saved["vision"]["exe"].as_str(),
            Some(old_vision.as_str()),
            "新版本没有视觉可执行文件时保持原值"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn engine_path_follows_new_component_version_when_old_is_gone() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-engine-follow-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let bundle = dir.join("engine-bundle");
        fs::create_dir_all(&bundle).unwrap();
        let old_folder = bundle.join(format!("0.1.46-{}-cuda", host_platform()));
        put_component(&bundle, "0.1.46", &host_platform(), exe);
        put_component(&bundle, "0.1.47", &host_platform(), exe);
        let old = old_folder.join(exe);
        let config = dir.join("strata-x.json");
        let text = serde_json::json!({ "exe": old.to_string_lossy(), "args": [] }).to_string();
        fs::write(&config, &text).unwrap();
        // 升级把旧版本目录删掉了 —— 这时才跟到现有版本
        fs::remove_dir_all(&old_folder).unwrap();

        let entry = parse_config(&config, None).unwrap();
        assert!(entry.engine_stale);
        assert_eq!(
            entry
                .engine
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy(),
            format!("0.1.47-{}-cuda", host_platform())
        );
        assert_eq!(entry.engine_version.as_deref(), Some("0.1.47"));
        // config 跟着改成新版本目录（只动 exe 的值）
        let saved = fs::read_to_string(&config).unwrap();
        assert!(saved.contains("0.1.47"));
        assert!(!saved.contains("0.1.46"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn current_engine_path_is_left_untouched() {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-engine-same-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        let bundle = dir.join("engine-bundle");
        fs::create_dir_all(&bundle).unwrap();
        put_component(&bundle, "0.1.46", &host_platform(), exe);
        let current = bundle
            .join(format!("0.1.46-{}-cuda", host_platform()))
            .join(exe);
        let config = dir.join("strata-x.json");
        let text = serde_json::json!({ "exe": current.to_string_lossy(), "args": [] }).to_string();
        fs::write(&config, &text).unwrap();

        let entry = parse_config(&config, None).unwrap();
        assert!(!entry.engine_stale);
        assert!(entry.engine_exists);
        // 已经是当前组件：一个字节都不改（也不产生备份文件）
        assert_eq!(fs::read_to_string(&config).unwrap(), text);
        assert!(!fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".bak")));
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 服务地址 + 密钥：全部来自 config 顶层（服务项保存时已写进去）。
/// api_key 只从 config 读，不下发前端（`StrataModelEntry::api_key` 是 skip_serializing），
/// 所以启停模型必须由 Rust 侧发起。
fn service_target(root: &Path, config_file: &str) -> Result<(String, u16, Option<String>), String> {
    let entry = scan_configs(root, None)
        .into_iter()
        .find(|e| e.config_path.file_name().and_then(|s| s.to_str()) == Some(config_file))
        .ok_or_else(|| format!("找不到 Strata 配置：{config_file}"))?;
    let host = if entry.host.trim().is_empty() {
        "127.0.0.1".to_string()
    } else {
        entry.host.clone()
    };
    Ok((host, entry.port, entry.api_key))
}

/// 让运行中的 Strata **卸载模型**（`POST /unload`，上游 server.py:4378）。
/// 引擎进程与 WebUI 保持运行，只释放显存 —— 显存互斥用这个，不再停整个进程。
/// 上游回 409 表示模型正忙；`http::request` 会把非 2xx 和原因一起变成 Err。
#[tauri::command]
pub async fn strata_unload_model(config_file: String) -> Result<String, String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let (host, port, api_key) = service_target(&root, &config_file)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::http::request(
            &host,
            port,
            "POST",
            "/unload",
            Some("{}"),
            api_key.as_deref(),
            std::time::Duration::from_secs(60),
        )
    })
    .await
    .map_err(|e| format!("卸载任务失败：{e}"))?
}

/// 让运行中的 Strata **加载模型**（`POST /load`，上游 server.py:4386）。
/// 上游会先跑 `before_load` 命令，再按 `min_free_vram_mib` 检查空闲显存，
/// 不够就回 503（上游 GpuBusy），模型保持卸载。大模型加载慢，超时给到 300 秒。
#[tauri::command]
pub async fn strata_load_model(config_file: String) -> Result<String, String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let (host, port, api_key) = service_target(&root, &config_file)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::http::request(
            &host,
            port,
            "POST",
            "/load",
            Some("{}"),
            api_key.as_deref(),
            std::time::Duration::from_secs(300),
        )
    })
    .await
    .map_err(|e| format!("加载任务失败：{e}"))?
}


