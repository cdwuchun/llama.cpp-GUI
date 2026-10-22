//! Strata 运行时通道：config 扫描、启停、状态探测、参数读写。
//!
//! 设计约束（见 `docs/archive/STRATA_INTEGRATION_PLAN.md` §7 升级解耦规则）：
//! - **R1 启动命令不自己拼**：从上游生成的 `run-<model>.bat` 解析，上游改了格式这里跟着变。
//! - **R2 零硬编码**：所有路径来自 config 与 run 脚本，GUI 只存 Strata 根目录。
//! - **R3 版本从运行时读**：`/props.build_info`，不缓存、不解析文件名。
//! - **R4 能力探测**：所有运行时字段都是 `Option`，端点缺失时降级而不是报错。
//! - **R6 受控写入 args**：只改已存在的 flag 值，绝不新增上游不认识的键。
//!
//! 与 router 通道的关键差异：
//! - 启动的是控制端的 `python.exe serve/server.py`，不是模型引擎；CUDA 由上游自带（config 的
//!   `lib_dirs`），**不做共享 CUDA 注入**，也**不做 junction 非 ASCII 修复**
//!   （venv 的 `pyvenv.cfg` 里 home 是绝对路径，换目录会让 venv 失效）。
//! - 0.2.x（control 0.1.46 起）目录重排：控制端在 `<安装目录>\control\`，引擎是独立组件
//!   放在 `<安装目录>\engine-bundle\<版本>-<平台>-<后端>\`，config 的 `exe` 写
//!   `component:strata-engine`（见 [`resolve_component`]）；0.1.x 的 `.venv` + `engine\`
//!   布局仍然兼容。
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
fn parse_config(path: &Path, preferred: Option<&Path>, extra: &[PathBuf]) -> Option<StrataModelEntry> {
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
    // 引擎路径（用户 m02686 / m02748 / m02795 / m04069 / m04888）：
    // - **落盘一律写绝对路径**（用户 m04888：原本写 `component:strata-engine` 的也改成绝对路径）。
    //   引用仍然认：config 里若还是 `component:strata-engine`（旧的，或手工写的），扫描时按控制器
    //   组件目录（`STRATA_COMPONENTS_DIR` / `%LOCALAPPDATA%\Strata\components\engine`，常是指向
    //   `E:\AI\Strata\engine` 的目录联结）解析成真实 exe，并**顺手把 config 改写成绝对路径**。
    // - 绝对路径的优先级：设置页选定的引擎（`settings.strata_engine`）存在就用它并把 config 改回
    //   一致；没选过就尊重 config 里的路径；那个路径没了（升级删了旧版本目录）才跟到当前版本并写回。
    let reference = engine.starts_with("component:");
    let declared = PathBuf::from(&engine);
    let engine_path = if reference {
        resolve_component(&root, ENGINE_COMPONENT_ID, extra)
            .map(|c| c.exe)
            .unwrap_or_else(|| declared.clone())
    } else {
        match preferred.filter(|p| p.is_file()) {
            Some(chosen) => chosen.to_path_buf(),
            None => {
                if declared.is_file() {
                    declared.clone()
                } else {
                    resolve_component(&root, ENGINE_COMPONENT_ID, extra)
                        .map(|c| c.exe)
                        .unwrap_or_else(|| declared.clone())
                }
            }
        }
    };
    let engine_exists = engine_path.is_file();
    let engine_version =
        component_version_at(&engine_path).or_else(|| engine_version(&engine_path));
    // 引用是**合法形态**（用户 m04934：设置页保留「自动使用最新版本」一项，写的就是
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
/// 指名。那个「某个目录」前后被安装器叫过 `engine-bundle`（0.1.46）和 `engine`（0.1.47），
/// 以后还可能再改，所以不硬编码名字（用户 m04258「不要硬编码，就在根目录下查找」）：
/// 从安装目录自身、它的一级子目录、以及这些子目录的直接子目录里找**引擎文件**
/// （`engine-component.json` 或 `strata.exe`），有就算一个引擎目录。0.1.x 的
/// `engine\strata.exe` 目录、以及「安装目录」被直接指到引擎目录的情况都覆盖。
fn engine_folders(root: &Path, extra: &[PathBuf]) -> Vec<PathBuf> {
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
    // 再按 **Strata 控制器自己的组件目录**找一遍（`engine_component.py:176 components_dir()`：
    // `STRATA_COMPONENTS_DIR` 优先，否则 `%LOCALAPPDATA%\Strata\components`，其下 `engine/`
    // 才是版本目录）。用户 2026-10-22 的会话把 `%LOCALAPPDATA%\Strata\components\engine` 做成了
    // 指向 `E:\AI\Strata\engine` 的目录联结，控制器就是从那儿看见引擎的；GUI 也认这一条，
    // 两边才不会一边找得到、一边说没引擎。与上面的扫描结果按路径去重。
    for components in extra {
        let dirs = if is_engine_dir(components) {
            vec![components.clone()]
        } else {
            subdirs(components)
        };
        for dir in dirs {
            if is_engine_dir(&dir) && seen.insert(dir.clone()) {
                out.push(dir);
            }
        }
    }
    out
}

/// Strata 控制器找引擎组件的根（`<组件根>/engine`）。
///
/// 顺序照抄 `E:\AI\Strata\control\strata_control\engine_component.py:176`：
/// `STRATA_COMPONENTS_DIR` → `%LOCALAPPDATA%\Strata\components`。不存在就返回空。
fn controller_component_dirs() -> Vec<PathBuf> {
    let base = std::env::var_os("STRATA_COMPONENTS_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(|dir| PathBuf::from(dir).join("Strata").join("components"))
        });
    let Some(base) = base else {
        return Vec::new();
    };
    let engine = base.join("engine");
    if engine.is_dir() {
        vec![engine]
    } else {
        Vec::new()
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
fn resolve_component(root: &Path, id: &str, extra: &[PathBuf]) -> Option<EngineComponent> {
    resolve_component_in(&engine_folders(root, extra), id)
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

/// 一份可选引擎（`engine-bundle` 下的一个版本目录），供前端列出让用户挑选。
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
/// [`engine_folders`]（按引擎文件找，不认 `engine-bundle` / `engine` 这些名字）。
pub fn list_engines(root: &Path) -> Vec<EngineInfo> {
    list_engines_with(root, &controller_component_dirs())
}

fn list_engines_with(root: &Path, extra: &[PathBuf]) -> Vec<EngineInfo> {
    let entry_name = if cfg!(windows) { "strata.exe" } else { "strata" };
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for folder in engine_folders(root, extra) {
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
fn find_run_script(root: &Path, slug: &str) -> Option<PathBuf> {
    let bat = root.join(format!("run-{slug}.bat"));
    if bat.exists() {
        return Some(bat);
    }
    let sh = root.join(format!("run-{slug}.sh"));
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
fn sync_run_script(root: &Path, slug: &str, port: u16) {
    let Some(script) = find_run_script(root, slug) else {
        return;
    };
    let Ok(raw) = fs::read_to_string(&script) else {
        return;
    };
    let Some(pos) = raw.find("--port") else {
        return;
    };
    // 跳过 `--port` 这六个字节本身：后面只允许「引号/空白 + 数字」，
    // 否则命中的是 `--port-mib` 这类同前缀参数
    let tail = &raw[pos + 6..];
    let Some(offset) = tail.find(|c: char| c.is_ascii_digit()) else {
        return;
    };
    if !tail[..offset]
        .chars()
        .all(|c| c == '"' || c == '\'' || c.is_whitespace())
    {
        return;
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
        let _ = fs::write(&script, next);
    }
}

/// 把端口写进 config 顶层 `port`，并同步 `run-<slug>.bat` 的 `--port`（用户 m05322）。
///
/// 两处必须一致：引擎真正绑定的是 run 脚本里的 `--port`，config 的 `port` 只是 GUI
/// 用来连它的元数据（见 [`spawn_strata`] 的校验）。写盘走 [`write_config_raw`]：
/// 先备份固定名 `.json.bak`、原子替换、JSON 合法性自检。
pub fn set_port(root: &Path, config_file: &str, port: u16) -> Result<()> {
    let path = root.join(config_file);
    let raw = fs::read_to_string(&path).with_context(|| format!("读不到 {}", path.display()))?;
    let next = match replace_json_port(&raw, port) {
        Some(text) => text,
        // 没有 `"port"` 键：插到对象开头。单行 config 补一个换行+两空格，
        // 已经是多行格式的（`{` 后紧跟换行）就不再加空行。
        None => match raw.strip_prefix('{') {
            Some(rest) => {
                let sep = if rest.starts_with('\n') { "" } else { "\n  " };
                format!("{{\n  \"port\": {port},{sep}{rest}")
            }
            None => raw.clone(),
        },
    };
    write_config_raw(&path, &next)?;
    let slug = split_config_path(&path)
        .map(|(_, _, slug)| slug)
        .unwrap_or_default();
    if !slug.is_empty() {
        sync_run_script(root, &slug, port);
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
/// config 声明或 `engine-bundle` 里的最高版本，而不是把所有 config 都指到空路径。
pub fn preferred_engine(engine: Option<&str>) -> Option<PathBuf> {
    engine
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

/// 扫描 Strata 根目录下的全部 config，按 mtime 倒序（照抄 `setup.py:3723-3725`）。
///
/// `preferred` 见 [`parse_config`]：设置页选定的引擎版本，存在时对每份 config 都生效。
pub fn scan_configs(root: &Path, preferred: Option<&Path>) -> Vec<StrataModelEntry> {
    let mut out = Vec::new();
    let extra = controller_component_dirs();
    let Ok(read_dir) = fs::read_dir(root) else {
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
        if let Some(entry) = parse_config(&path, preferred, &extra) {
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

/// 回退启动命令（run 脚本缺失/解析失败时）：照抄上游默认布局。
///
/// control 0.1.46 起控制端自带解释器：`<安装目录>\control\python\python.exe` +
/// `<安装目录>\control\serve\server.py`；0.1.x 是 `<安装目录>\.venv\Scripts\python.exe`
/// + `<安装目录>\serve\server.py`。两套都试，先看哪套的文件真的在。
/// 安装目录若被指到引擎子目录（如 `E:\AI\Strata\engine`），control 在上一级，
/// 所以父目录也进候选（用户 m04254）。
fn fallback_command(
    root: &Path,
    config_path: &Path,
    port: u16,
) -> (PathBuf, Vec<String>, Option<PathBuf>) {
    let py_name = if cfg!(windows) { "python.exe" } else { "python" };
    let mut candidates: Vec<(PathBuf, PathBuf, Option<PathBuf>)> = Vec::new();
    for base in std::iter::once(root).chain(root.parent()) {
        let control = base.join("control");
        // control 0.1.47 起控制端在 `control\<版本>\`，版本号记在 `active.json`（用户 m05626）
        if let Some(folder) = active_control_folder(&control) {
            let dir = control.join(&folder);
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

/// Strata 自己的日志读取器：整条流固定归到 `"strata"` 源。
///
/// 不能复用 [`crate::logs::spawn_reader`] —— 它按行首 `[端口]` 把日志分成
/// `model:<端口>` / `system`，Strata 的输出没有那个前缀，全部会被塞进 `"system"`
/// （也就是 router 自己的那一路），前端就没法把 Strata 的模型日志单独挑出来看。
fn spawn_strata_reader<R: std::io::Read + Send + 'static>(
    stream: R,
    hub: Arc<LogHub>,
    tx: mpsc::Sender<LogLine>,
) {
    thread::spawn(move || {
        let reader = std::io::BufReader::new(stream);
        for line in reader.split(b'\n') {
            let Ok(bytes) = line else { break };
            let text = String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_string();
            if text.is_empty() {
                continue;
            }
            let entry = hub.push("strata", text);
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

    let host = entry.host.clone();
    let mut port = entry.port;
    let api_key = entry.api_key.clone();

    // 端口自动分配（用户 m05322）：config 里没写端口、写的是安装器默认 8080（用户 m05516）、
    // 或写的端口已被占用（别的模型先起来了），就从 9091 起挑一个空闲的（逻辑同 llama.cpp 侧），
    // 写回 config 与 `run-<slug>.bat` 再启动。
    // 以前这里是「占用就报错、不顺延」—— 用户要求自己挑，所以改成自动分配。
    let unconfigured = port == 0 || port == STRATA_PORT_DEFAULT;
    if unconfigured || winfix::port_in_use(port) {
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

    let (exe, args, script_cwd) = match entry
        .run_script
        .as_ref()
        .and_then(|p| parse_run_script(p))
    {
        Some(cmd) => cmd,
        None => fallback_command(&root, &entry.config_path, port),
    };
    // 脚本里的 `cd /d` 目标优先：control 0.1.47 起引擎要以 `control\<版本>` 为工作目录
    let cwd = script_cwd.unwrap_or_else(|| entry.cwd.clone());

    // run 脚本里的 `--port` 才是引擎真正绑定的端口：`server.py` 只认 CLI 参数
    // （`cfg["port"]` 没有回退），config 里的 `port` 只是 GUI 用来找它的元数据。
    // 两处不一致时 GUI 会一直等错端口（表现为"启动失败"并把刚起的进程杀掉），
    // 所以在这里提前拦下，把要改的两个地方直接写进报错（用户 m00798 那种改端口只改了一处）。
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
    if let Some(stdout) = child.stdout.take() {
        spawn_strata_reader(stdout, Arc::clone(&hub), tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_strata_reader(stderr, Arc::clone(&hub), tx.clone());
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
                    "Strata 启动后立刻退出（退出码 {:?}），请看日志",
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
        if !vision.starts_with("component:") {
            if let Some(sibling) = vision_sibling(target) {
                let next = sibling.to_string_lossy().to_string();
                if vision != next {
                    edits.push((vision.to_string(), next));
                }
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
    let path = root.join(config_file);
    if !path.is_file() {
        return Err(format!("config 不存在：{}", path.display()));
    }
    // 「自动使用最新版本」那一项传进来的就是 `component:strata-engine`，不是文件路径。
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
    // vision 永远是绝对路径：引用形态下按控制器组件目录解析出当前真实引擎再去同步。
    let vision_base = if reference {
        resolve_component(root, ENGINE_COMPONENT_ID, &controller_component_dirs())
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
    // 「自动使用最新版本」那一项传进来的是 `component:strata-engine`，不是文件路径（用户 m04934）。
    let reference = exe.starts_with("component:");
    let target = PathBuf::from(exe);
    if !reference && !target.is_file() {
        return Err(format!("引擎文件不存在：{}", target.display()));
    }
    let read_dir = fs::read_dir(root).map_err(|e| format!("读不到目录 {}：{e}", root.display()))?;
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
    let value: serde_json::Value =
        serde_json::from_str(&text).context("JSON 解析失败，已取消写入（未改动原文件）")?;
    let obj = value
        .as_object()
        .context("config 顶层必须是 JSON 对象，已取消写入")?;
    if obj.get("exe").and_then(|v| v.as_str()).is_none() {
        anyhow::bail!("config 缺少顶层 exe 字段，已取消写入（上游会跳过这份 config）");
    }
    if !obj.get("args").and_then(|v| v.as_array()).is_some() {
        anyhow::bail!("config 的 args 必须是数组，已取消写入（上游会跳过这份 config）");
    }

    // 校验过了才拿锁：解析失败时连锁都不用碰。
    // 中毒不走 `let Ok(..) = ...lock() else`（那会静默跳过整段写入），统一 `into_inner()`。
    let _guard = strata_lock().lock().unwrap_or_else(|e| e.into_inner());

    // W3：备份固定一份 `<config>.json.bak`，每次覆盖（用户 m03392：不要堆积带时间戳的多份，
    // 与 `model_config::write_config` / `settings` 的备份策略一致）。
    let backup = path.with_extension("json.bak");
    let _ = fs::copy(path, &backup);

    // W4：原子写（临时文件名唯一，见 `temp_config_path`）。
    let tmp = temp_config_path(path);
    fs::write(&tmp, &text).with_context(|| format!("写入临时文件失败: {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("替换 config 失败: {}", path.display()))?;
    Ok(())
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

    /// 诊断：对真实安装目录跑一遍（`cargo test --lib probe_ensure_ports -- --ignored --nocapture`）。
    ///
    /// 注意：`cargo test` 进程在本机被沙箱限制成只能写工作区，所以这里的 `ensure_ports`
    /// 在真实目录上一定写失败（`os error 5`），只能看分配出来的端口号对不对。
    #[test]
    #[ignore]
    fn probe_ensure_ports() {
        let root = Path::new("E:/AI/Strata");
        for e in scan_configs(root, None) {
            println!("entry {} port={}", e.model_name, e.port);
        }
        println!("allocate={}", allocate_port(root, "strata-zz-autoport-test.json"));
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

    /// 造一个 `engine-component.json` + entrypoint 文件的组件目录（0.2.x 布局）。
    fn put_component(dir: &Path, version: &str, platform: &str, exe: &str) {
        let folder = dir.join(format!("{version}-{platform}-cuda"));
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

        let list = list_engines_with(&root, &[]);
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

        let list = list_engines_with(&root, &[]);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version.as_deref(), Some("0.1.47"));
        // 解析链路也要走同一个候选集合，否则列出了却选不中
        let found = resolve_component(&root, ENGINE_COMPONENT_ID, &[]).unwrap();
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

        let list = list_engines_with(&root, &[]);
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

        let list = list_engines_with(&root, &[]);
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
        let list = list_engines_with(&root, &[]);
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

        let found = resolve_component(&dir, "strata-engine", &[]).unwrap();
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
        let entry = parse_config(&config, None, &[]).unwrap();
        assert_eq!(entry.engine, older);
        assert!(!entry.engine_stale);

        // 设置页选了 0.1.47：它才是权威，config 跟着改回来（用户 m04069）
        let entry = parse_config(&config, Some(&chosen), &[]).unwrap();
        assert_eq!(entry.engine, chosen);
        assert_eq!(entry.engine_version.as_deref(), Some("0.1.47"));
        assert!(entry.engine_stale);
        let saved = fs::read_to_string(&config).unwrap();
        assert!(saved.contains("0.1.47"));
        assert!(!saved.contains("0.1.46"));
        let _ = fs::remove_dir_all(&dir);
    }


    #[test]
    #[ignore = "读本机真实安装目录（E:\\AI\\Strata），只在诊断引擎解析时手动跑"]
    fn probe_real_install() {
        let root = std::path::Path::new("E:\\AI\\Strata");
        let list = list_engines(root);
        println!("engines = {list:?}");
        for entry in scan_configs(root, None) {
            println!(
                "{} → exe={} exists={} version={:?} stale={}",
                entry.config_path.display(),
                entry.engine.display(),
                entry.engine_exists,
                entry.engine_version,
                entry.engine_stale
            );
        }
    }

    #[test]
    fn component_reference_is_resolved_but_left_untouched() {
        // 用户 m04934：`component:strata-engine` 是「自动使用最新版本」那一项，是合法形态。
        // 扫描只把它解析成真实 exe 给界面/启动用，不把 config 改写成绝对路径。
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-component-ref-{}", now_ms()));
        let _ = fs::remove_dir_all(&dir);
        let exe = if cfg!(windows) { "strata.exe" } else { "strata" };
        put_component(&dir.join("engine"), "0.1.47", &host_platform(), exe);
        let text = r#"{"exe":"component:strata-engine","args":[]}"#;
        let config = dir.join("strata-x.json");
        fs::write(&config, text).unwrap();

        let entry = parse_config(&config, None, &[]).unwrap();
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
        // 设置页「自动使用最新版本」那一项传的就是 `component:strata-engine`（用户 m04934）。
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
            "选「自动使用最新版本」时写回组件引用"
        );
        // 引用也要能解析出真实引擎，否则设置页会显示成不存在
        let entry = parse_config(&dir.join("strata-x.json"), None, &[]).unwrap();
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

        let entry = parse_config(&config, None, &[]).unwrap();
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

        let entry = parse_config(&config, None, &[]).unwrap();
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
pub async fn strata_unload_model(root: String, config_file: String) -> Result<String, String> {
    let (host, port, api_key) = service_target(Path::new(&root), &config_file)?;
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
pub async fn strata_load_model(root: String, config_file: String) -> Result<String, String> {
    let (host, port, api_key) = service_target(Path::new(&root), &config_file)?;
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

