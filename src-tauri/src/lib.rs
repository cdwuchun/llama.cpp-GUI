//! Tauri 命令与事件注册（P1 + P2：设置、版本发现、设备枚举、router 生命周期、日志；P6：托盘与自启动）。

mod bench;
mod gpu;
mod http;
mod idle;
mod model_config;
mod models;
mod monitor;
mod paths;
mod logs;
mod mcp;
mod scheduler;
mod search;
mod settings;
mod state;
mod strata;
mod strata_proxy;
mod tray;
mod tray_icon;
mod versions;
mod winfix;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::gpu::{DeviceInfo, FitRow};
use crate::logs::LogLine;
use crate::settings::{Settings, SettingsPatch, VersionProbe};
use crate::state::AppState;
use crate::versions::LlamaCppVersion;

/// 应用路径信息（前端用于展示配置位置）。
#[derive(Debug, Clone, Serialize)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    /// 第二刀起指向**模型配置目录**（`<配置目录>\config`）。前端仍在用这个字段
    /// 显示路径，第三刀改名成 `model_config_dir`。
    pub model_config_dir: PathBuf,
    pub link_root: PathBuf,
}

/// 设备枚举结果。
#[derive(Debug, Clone, Serialize)]
pub struct DeviceResult {
    pub devices: Vec<DeviceInfo>,
    pub cuda_ready: bool,
    pub shared_lib_dirs: Vec<PathBuf>,
    pub error: Option<String>,
}

#[tauri::command]
fn app_paths(state: State<'_, AppState>) -> AppPaths {
    AppPaths {
        config_dir: state.config_dir.clone(),
        model_config_dir: state.model_config_dir(),
        link_root: state.link_root(),
    }
}

#[tauri::command]
fn settings_get(state: State<'_, AppState>) -> Settings {
    state.settings.get()
}

#[tauri::command]
fn settings_set(state: State<'_, AppState>, patch: SettingsPatch) -> Settings {
    // 「同时加载模型上限」要**保存当时**就生效，不能等下一次加载新模型才判定（用户 m06652）。
    let cap_changed = patch.models_max.is_some();
    let next = state.settings.patch(patch);
    if cap_changed {
        crate::scheduler::enforce_capacity(&state);
    }
    next
}

/// 扫描 llama.cpp 版本。
///
/// `dir` 为空时使用设置里的 `llama_cpp_dir`；`probe` 为 true 时对未探测过的版本执行
/// `--help`（冷启动约 1.5s）并写入缓存。
#[tauri::command]
async fn versions_list(
    state: State<'_, AppState>,
    dir: Option<String>,
    probe: bool,
) -> Result<Vec<LlamaCppVersion>, String> {
    let settings = state.settings.get();
    let target: PathBuf = match dir.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(d) => PathBuf::from(d),
        None => settings
            .llama_cpp_dir
            .clone()
            .ok_or_else(|| "尚未设置 llama.cpp 目录".to_string())?,
    };
    if !target.exists() {
        return Err(format!("目录不存在: {}", target.display()));
    }

    let mut found = versions::scan_versions(&target, &settings.shared_lib_dirs, &settings.version_cache);

    if probe {
        for version in found.iter_mut() {
            if version.has_router_mode.is_some() {
                continue;
            }
            // 探测失败（返回 None）时**不写缓存**：否则缺 DLL / 被杀软拦这类环境问题
            // 会被永久记成"该版本不支持 router mode"，用户之后怎么修都翻不了身。
            let Some(has_router) = versions::probe_router_mode(&version.server_bin, &version.shared_lib_dirs)
            else {
                continue;
            };
            version.has_router_mode = Some(has_router);
            let name = version.name.clone();
            state.settings.update(|s| {
                s.version_cache.insert(
                    name,
                    VersionProbe {
                        has_router_mode: has_router,
                        probed_at_ms: logs::now_ms(),
                    },
                );
            });
        }
    }

    *state.versions.lock().unwrap_or_else(|e| e.into_inner()) = found.clone();
    Ok(found)
}

/// 枚举推理设备（需要共享 CUDA 运行时已就绪，否则返回空列表与说明）。
#[tauri::command]
async fn device_list(state: State<'_, AppState>) -> Result<DeviceResult, String> {
    let settings = state.settings.get();
    let versions = state
        .versions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let version = versions
        .iter()
        .find(|v| settings.selected_version.as_deref() == Some(v.name.as_str()))
        .or_else(|| versions.iter().find(|v| v.has_router_mode != Some(false)))
        .or_else(|| versions.first())
        .cloned();

    let Some(version) = version else {
        return Ok(DeviceResult {
            devices: Vec::new(),
            cuda_ready: false,
            shared_lib_dirs: Vec::new(),
            error: Some("尚未扫描到可用版本，请先设置 llama.cpp 目录".into()),
        });
    };

    let shared = version.shared_lib_dirs.clone();
    let shared_empty = shared.is_empty();
    match gpu::list_devices(&version) {
        Ok(devices) => {
            let cuda_ready = gpu::cuda_ready(&devices);
            *state.devices.lock().unwrap_or_else(|e| e.into_inner()) = devices.clone();
            Ok(DeviceResult {
                devices,
                cuda_ready,
                shared_lib_dirs: shared,
                error: if cuda_ready || !shared_empty || !cfg!(windows) {
                    None
                } else {
                    Some(
                        "未检测到 CUDA 设备，且未找到共享 CUDA 运行时目录（cudart64_*.dll）。\
                         请把 cudart-llama-bin-win-cuda-<X.Y>-x64 目录放在版本目录同级，或在设置中指定。"
                            .into(),
                    )
                },
            })
        }
        Err(err) => Ok(DeviceResult {
            devices: Vec::new(),
            cuda_ready: false,
            shared_lib_dirs: shared,
            error: Some(format!("执行 --list-devices 失败: {err}")),
        }),
    }
}

/// 按文件名在 Strata 根目录里定位一份 config（**R2：路径来自扫描结果，不硬编码**）。
///
/// **绕开 5 秒扫描缓存**（M2 的缓存是给 `strata_probe` 那种高频轮询用的）：
/// `strata_config_write` 刚落完盘就要用这里的返回值回给前端，走缓存会把 5 秒前的旧参数
/// 原样回显 —— 用户看到「改了但没生效」。参数编辑是低频操作，多扫一次目录没关系。
fn find_strata_entry(
    state: &AppState,
    config_file: &str,
) -> Result<strata::StrataModelEntry, String> {
    let root = state
        .settings
        .get()
        .strata_root
        .clone()
        .ok_or_else(|| "尚未设置 Strata 目录".to_string())?;
    let entries = strata::scan_configs(&root);
    // 这次真扫的结果顺手灌回缓存：`strata_config_write` 写完 config 立刻要用它的
    // 返回值回显，而 `strata_probe` 每 5 秒读的是缓存 —— 不刷新的话，用户改完参数
    // 后界面上会先弹回一个 TTL 周期内的旧端口/旧模型名。
    state.store_strata_scan(&root, &entries);
    entries
        .into_iter()
        .find(|e| {
            e.config_path
                .file_name()
                .map(|n| n.to_string_lossy() == config_file)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("在 {} 下未找到 config：{config_file}", root.display()))
}

/// 当前状态快照（含前门代理字段）。
///
/// `strata_status`、前门的启停命令共用：前门状态与引擎状态放在同一个快照里，
/// 前端胶囊、设置页、托盘都只读一处，也不用多开一路轮询。
pub(crate) fn strata_snapshot(state: &AppState) -> strata::StrataStatus {
    let mut snapshot = state
        .strata_status
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    strata_proxy::apply_to(state, &mut snapshot);
    snapshot
}

/// 判「Strata 引擎在跑」：引擎槽位里有进程。
///
/// 只看引擎槽位，**不含前门代理**：托盘那几个菜单项控制的是 router，而前门本身不占显存
/// （模型还没加载时它只是个转发器），把它算进来会让「启动服务」在前门开着时永远变灰
/// （用户 m00798 之后自启动默认就是拉起前门）。前门的启停走 GUI 里的胶囊 / 面板 / 设置页。
pub(crate) fn strata_busy(state: &AppState) -> bool {
    state
        .strata_slot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

#[tauri::command]
fn strata_status(state: State<'_, AppState>) -> strata::StrataStatus {
    strata_snapshot(&state)
}

/// 扫描 Strata 根目录下的全部 config（照抄上游 `setup.py` 的识别规则）。
///
/// 用户点「刷新」是显式要求一次真扫（和模型侧 `GET /models?reload=1` 同一个道理），
/// 所以这里**绕开 5 秒缓存**；扫完顺手把缓存覆盖成新结果，省掉下一次 `strata_probe`
/// 重复扫的冤枉开销。用户手速再快也不会每秒点刷新，这一次全量扫可以接受。
#[tauri::command]
async fn strata_scan(state: State<'_, AppState>) -> Result<Vec<strata::StrataModelEntry>, String> {
    let Some(root) = state.settings.get().strata_root.clone() else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Err(format!("Strata 目录不存在: {}", root.display()));
    }
    let entries = strata::scan_configs(&root);
    state.store_strata_scan(&root, &entries);
    Ok(entries)
}

/// 列出 `engine-bundle` 下所有可用的引擎组件（可能多版本并存），供面板选择。
#[tauri::command]
async fn strata_engines(root: String) -> Result<Vec<strata::EngineInfo>, String> {
    Ok(strata::list_engines(std::path::Path::new(&root)))
}

/// 把某份 config 的 `exe` 换成选定的那个引擎可执行文件。
#[tauri::command]
async fn strata_set_engine(root: String, config_file: String, exe: String) -> Result<(), String> {
    strata::set_engine(std::path::Path::new(&root), &config_file, &exe)
}

/// 把选定的引擎批量写进装配目录下的全部 config，返回被改过的文件名（设置页用）。
#[tauri::command]
async fn strata_apply_engine(
    state: State<'_, AppState>,
    exe: String,
) -> Result<Vec<String>, String> {
    let Some(root) = state.settings.get().strata_root.clone() else {
        return Err("还没设置 Strata 安装目录".into());
    };
    let changed = strata::apply_engine(&root, &exe)?;
    // 扫描缓存作废：卡片上的引擎版本要跟着变
    state.store_strata_scan(&root, &strata::scan_configs(&root));
    Ok(changed)
}

/// 探测运行时状态（生效上下文、版本、加载状态、token 占用）。
///
/// 前端每 5 秒调用一次；**所有阻塞工作**（config 扫描与端口探测）都放进同一段
/// `spawn_blocking` 里，别把磁盘 IO 和 HTTP 往返（单个超时就是
/// `strata::PROBE_TIMEOUT` = 3 秒）压在 async 运行时上。
#[tauri::command]
async fn strata_probe(app: AppHandle, state: State<'_, AppState>) -> Result<strata::StrataStatus, String> {
    let gui_owned = {
        let guard = state.strata_slot.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .as_ref()
            .map(|p| (p.port, p.api_key.clone()))
            .filter(|(port, _)| *port != 0)
    };

    // 要探哪些端口。
    //
    // GUI 自己启动的实例就探它自己的端口；不是 GUI 启动的（例如用户自己跑了
    // `run-<model>.bat`）按**全部 config 的端口**逐个探测，选中 config 优先 ——
    // 只看选中 config 的端口会把端口显示成没在跑的那个值。
    //
    // 缓存命中时在这里直接取走（一次内存读，微秒级）；未命中就把根目录交给阻塞
    // 线程去真扫 —— `scan_configs` 要对每份 config 读文件、取 metadata、聚合分片、
    // 开 GGUF 头，而这条命令是前端每 5 秒一次的常驻轮询，留在 async 上下文就是让
    // tokio 的 worker 线程周期性地替我们做本地磁盘 IO。
    let root = strata_probe_root(&state);
    let cached_entries = state.cached_strata_scan(&root);
    let selected = state.settings.get().strata_selected_config.clone();
    let app_for_scan = app.clone();
    let gui_owned_for_scan = gui_owned.clone();

    // 闭包只带走 owned 数据 —— 不借用 `state`，否则 `State<'_>` 会被要求
    // 跨 await 存活，而 Tauri 命令的 future 必须能跨线程。
    let (probed, selected_port) = tauri::async_runtime::spawn_blocking(move || {
        let (probe_targets, selected_port, entries_for_attr): (
            Vec<(u16, Option<String>, Option<PathBuf>, Option<String>)>,
            Option<u16>,
            Vec<strata::StrataModelEntry>,
        ) = match gui_owned_for_scan {
            Some((port, api_key)) => (vec![(port, api_key, None, None)], None, Vec::new()),
            None => {
                // 未命中缓存时才碰 AppState：`try_state` 拿到的 `State` 活不过 await，
                // 但在阻塞线程内部用一下是安全的（扫描本身不 await）。
                let entries = cached_entries.unwrap_or_else(|| {
                    app_for_scan
                        .try_state::<AppState>()
                        .map(|state| state.strata_configs(&root))
                        .unwrap_or_default()
                });
                let preferred = selected.as_deref().and_then(|f| {
                    entries.iter().find(|e| {
                        e.config_path
                            .file_name()
                            .map(|n| n.to_string_lossy() == f)
                            .unwrap_or(false)
                    })
                });
                // 未运行时端口要复位到「选中 config 的端口」，这里顺手记下来
                let selected_port = preferred
                    .map(|e| e.port)
                    .or_else(|| entries.first().map(|e| e.port));
                let mut seen: HashSet<u16> = HashSet::new();
                let targets = preferred
                    .into_iter()
                    .chain(entries.iter())
                    .filter(|e| e.port != 0 && seen.insert(e.port))
                    .map(|e| {
                        (
                            e.port,
                            e.api_key.clone(),
                            Some(e.config_path.clone()),
                            Some(e.model_name.clone()),
                        )
                    })
                    .collect();
                (targets, selected_port, entries)
            }
        };
        // 命中端口后要按 `/health` 报的模型名反查归属（见 `attribute_strata_hit`）：
        // 同端口多 config 时端口归属只是猜的，模型名才是事实。
        let pairs: Vec<(String, PathBuf)> = entries_for_attr
            .iter()
            .map(|e| (e.model_name.clone(), e.config_path.clone()))
            .collect();
        let probed = probe_strata_ports(&probe_targets).map(|(fresh, hit)| {
            let attributed = attribute_strata_hit(fresh.port, fresh.model_name.as_deref(), &pairs, hit);
            (fresh, attributed)
        });
        (probed, selected_port)
    })
    .await
    .map_err(|err| format!("Strata 状态探测失败: {err}"))?;

    // 探测本身不写日志，卡片一旦闪「已停止」就无从查证（用户 m13709 报过一次没修干净）。
    // 这里只在「上一轮还在跑、这一轮却退化」时补一行，带上引擎给不出状态的直接原因。
    if let Some((fresh, _)) = probed.as_ref() {
        let before = state
            .strata_status
            .lock()
            .map(|s| s.clone())
            .unwrap_or_else(|e| e.into_inner().clone());
        if before.running
            && before.loaded == Some(true)
            && (!fresh.running || fresh.loaded != Some(true))
        {
            let line = state.logs.push(
                "system",
                format!(
                    "[probe] Strata 探测退化：running={} loaded={:?} 原因={}",
                    fresh.running,
                    fresh.loaded,
                    fresh.last_error.as_deref().unwrap_or("引擎没给出原因")
                ),
            );
            let _ = app.emit("logs://lines", vec![line]);
        }
    }

    if let Some((fresh, external_hit)) = probed {
        // GUI 自己启动的那条路径不带端口归属信息（槽位里已经有了）
        let external_hit = if gui_owned.is_some() { None } else { external_hit };
        let mut merged = merge_strata_probe(&state, &fresh, external_hit, gui_owned.is_none());
        strata_proxy::apply_to(&state, &mut merged);
        let _ = app.emit("strata://status", merged.clone());
        return Ok(merged);
    }

    // 所有已知端口都无响应。GUI 没有启动这个实例，端口探测就是判断它是否在跑的
    // **唯一依据**，所以这里必须落回未运行：沿用状态快照会让用户在 Strata 控制台
    // 关掉模型之后，GUI 侧栏永远显示「运行中」。
    // 槽位里还握着进程（GUI 自己拉起的实例）时，只清「跑没跑、加载没加载」这类探测字段，
    // **绝不动归属信息**：引擎从启动到端口监听之间有一段空窗（68 GB 权重在加载，几分钟），
    // 这段空窗里只要清掉 config_path，卡片就再也认不出在跑的是哪份 config —— 实测面板
    // 计数停在 0/3、卡片全「已停止」，而侧栏明明写着「引擎运行中」（用户 m01031）。
    let slot_owned = state
        .strata_slot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some();
    let mut guard = state
        .strata_status
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    guard.running = false;
    guard.external = false;
    if !slot_owned {
        guard.pid = None;
        guard.config_path = None;
        guard.model_name = None;
        guard.started_at_ms = None;
    }
    guard.last_error = None;
    guard.version = None;
    guard.live_max_context = None;
    guard.loaded = None;
    guard.busy = None;
    guard.prompt_tokens = None;
    guard.max_tokens = None;
    guard.models_autoload = None;
    // 端口复位到选中 config 的端口（没在跑的时候，显示的就是配置里写的端口）
    if let Some(p) = selected_port {
        if p != 0 {
            guard.port = p;
        }
    }
    let snap = {
        let mut snapshot = guard.clone();
        strata_proxy::apply_to(&state, &mut snapshot);
        snapshot
    };
    let _ = app.emit("strata://status", snap.clone());
    Ok(snap)
}

/// `strata_probe` 用的根目录：没设或目录不存在时给一个空路径
/// （`scan_configs` 读不到目录就返回空表）。
fn strata_probe_root(state: &AppState) -> PathBuf {
    state
        .settings
        .get()
        .strata_root
        .clone()
        .filter(|r| r.is_dir())
        .unwrap_or_default()
}

/// 命中端口后按 `/health` 报的模型名反查归属，返回 `(端口, config 路径, 模型名)`。
///
/// **同一端口可以写多份 config**（用户 m00001：两个模型都写 9090），此时「这个端口上有
/// 东西在跑」只说明端口被占，**跑的是哪份 config** 只能看 `/health` 报出的模型名 ——
/// 按端口猜归属会把在跑的实例记到别的卡片上，用户就会去点错卡片（停不掉、又对错的
/// config 发 `/load`）。`configs` 是 `(模型名, config 路径)` 列表；模型名拿不到或对不上
/// 任何 config 时才退回 `fallback`（探测目标自带的端口归属）。
fn attribute_strata_hit(
    port: u16,
    live_model: Option<&str>,
    configs: &[(String, PathBuf)],
    fallback: Option<(u16, Option<PathBuf>, Option<String>)>,
) -> Option<(u16, Option<PathBuf>, Option<String>)> {
    let by_model = live_model
        .and_then(|name| configs.iter().find(|(model, _)| model == name))
        .map(|(model, path)| (port, Some(path.clone()), Some(model.clone())));
    by_model.or(fallback)
}

/// 按顺序探测各个端口，返回第一个在跑的实例。
///
/// `targets` 形如 `(端口, api_key, 归属 config 路径, 模型名)`；后两项只有
/// 「不是 GUI 启动的实例」才有值，用于修正端口显示。
/// 在阻塞线程里跑，返回 owned 数据。
fn probe_strata_ports(
    targets: &[(u16, Option<String>, Option<PathBuf>, Option<String>)],
) -> Option<(
    strata::StrataStatus,
    Option<(u16, Option<PathBuf>, Option<String>)>,
)> {
    for (port, api_key, config_path, model_name) in targets {
        let fresh = strata::probe(*port, api_key.as_deref());
        if fresh.running {
            let hit = match (config_path.clone(), model_name.clone()) {
                (Some(path), Some(name)) => Some((*port, Some(path), Some(name))),
                _ => None,
            };
            return Some((fresh, hit));
        }
    }
    None
}

/// 把「GUI 槽位里的实例」的归属信息写回状态快照（纯函数，便于单测）。
///
/// 槽位是「本进程起的引擎」的唯一权威记录：只要它在，快照里的 config 路径 / 模型名 /
/// 端口 / 启动时间就必须和它一致，否则卡片认不出在跑的是哪一份 config。探测只认端口，
/// 引擎启动期的空窗会把 `config_path` 清掉一次，之后再怎么探测也补不回来（用户 m01031）。
fn apply_owned_status(
    status: &mut strata::StrataStatus,
    owned: Option<(u16, PathBuf, String, u64)>,
) {
    let Some((port, config_path, model_name, started_at_ms)) = owned else {
        return;
    };
    status.port = port;
    status.config_path = Some(config_path);
    if !model_name.is_empty() {
        status.model_name = Some(model_name);
    }
    status.started_at_ms = Some(started_at_ms);
    status.external = false;
}

/// 把一次探测结果并入状态快照。
///
/// `external=true` 表示命中的实例不是 GUI 启动的（GUI 无法启停它）；
/// `external_hit` 携带探测到的端口与归属 config，用于修正端口显示。
fn merge_strata_probe(
    state: &State<'_, AppState>,
    fresh: &strata::StrataStatus,
    external_hit: Option<(u16, Option<PathBuf>, Option<String>)>,
    external: bool,
) -> strata::StrataStatus {
    // 槽位信息先取（顺序固定：先槽位、后状态，避免和 `strata_start_engine` 交叉持锁）
    let owned_from_slot = state
        .strata_slot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|p| (p.port, p.config_path.clone(), p.model_name.clone(), p.started_at_ms));
    let mut guard = state.strata_status.lock().unwrap_or_else(|e| e.into_inner());
    guard.running = fresh.running;
    guard.version = fresh.version.clone();
    guard.live_max_context = fresh.live_max_context;
    guard.loaded = fresh.loaded;
    guard.busy = fresh.busy;
    guard.prompt_tokens = fresh.prompt_tokens;
    guard.max_tokens = fresh.max_tokens;
    guard.models_autoload = fresh.models_autoload;
    guard.last_error = fresh.last_error.clone();
    guard.external = external;
    // `/health` 报出的模型名是端口上真实在跑的那份 config（同一端口可以有多份 config，
    // 用户 m00001 两个模型都写 9090），比快照里记的名字可信，一律以探测结果为准。
    if let Some(name) = fresh.model_name.clone() {
        guard.model_name = Some(name);
    }
    if let Some((port, config_path, model_name)) = external_hit {
        guard.port = port;
        if config_path.is_some() {
            guard.config_path = config_path;
        }
        if model_name.is_some() {
            guard.model_name = model_name;
        }
    }
    // GUI 自己拉起的实例：归属以槽位为准（自愈）。探测恢复后这一步就能把被清掉的
    // config_path 补回来，卡片随之回到「运行中」。
    apply_owned_status(&mut guard, owned_from_slot);
    guard.clone()
}

#[tauri::command]
async fn strata_start(
    app: AppHandle,
    state: State<'_, AppState>,
    config_file: Option<String>,
) -> Result<strata::StrataStatus, String> {
    strata_start_engine(&app, &state, config_file.as_deref())
}

/// 真正拉起一个 Strata 引擎 —— GUI 卡片、侧栏胶囊、**前门代理**都走这一条路径。
///
/// 抽成独立函数（而不是留在 `strata_start` 命令里）是为了让前门代理复用同一条启动路径：
/// 找条目、防并发、spawn、挂崩溃监测、刷托盘、记住选中 config、报错文案 —— 代理自己
/// 拼一套的话，两条路径的报错与状态刷新迟早会不一致。
pub(crate) fn strata_start_engine(
    app: &AppHandle,
    state: &AppState,
    config_file: Option<&str>,
) -> Result<strata::StrataStatus, String> {
    {
        let guard = state.strata_slot.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(p) = guard.as_ref() {
            // 同端口互斥（用户 m00001）：一个引擎只服务一份 config，报错必须点名
            // 是谁在跑 —— 两份 config 都写 9090 时，光说「已在运行」用户无从下手。
            let who = if p.model_name.is_empty() {
                format!("端口 :{}", p.port)
            } else {
                format!("{}，端口 :{}", p.model_name, p.port)
            };
            return Err(format!(
                "Strata 已在运行（{who}）。一个引擎只服务一份 config，先停止它再启动这个模型"
            ));
        }
    }
    // 并发的第二次启动必须在这里被挡住，否则两个进程只有一个能被记住
    let _start_guard = match state.begin_start("strata") {
        Some(guard) => guard,
        None => return Err("Strata 正在启动中，请稍候".into()),
    };

    let settings = state.settings.get();
    let wanted = config_file
        .or(settings.strata_selected_config.as_deref())
        .ok_or_else(|| "尚未选择 Strata 模型（也没有设置 strata_root）".to_string())?;
    let entry = find_strata_entry(state, wanted)?;

    // host / 端口 / 密钥全部来自 config（R2）：设置页「服务」分组是直接把这些值
    // 写进 strata-*.json，这里不追加命令行参数（用户 m01623）。
    let (process, status) = strata::spawn_strata(app, state.logs.clone(), &entry)
        .map_err(|err| format!("{err:#}"))?;

    *state.strata_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(process);
    *state.strata_status.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    strata::spawn_monitor(app.clone(), state.strata_slot.clone(), state.strata_status.clone());

    let file = entry
        .config_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string());
    state.settings.update(|s| s.strata_selected_config = file);

    // 前门可能开着：spawn 返回的快照里 proxy 恒为 false，直接 emit 会让侧栏胶囊闪一下
    // 「前门未运行」—— 按当前真实状态补上（用户 m00798）。
    let mut status = status;
    strata_proxy::apply_to(state, &mut status);

    let _ = app.emit("strata://status", status.clone());
    // Strata 不走前门那条 `sync_tooltip`，菜单可用性得在这里自己刷一次
    // （否则「启动服务」一直可点、「停止服务」一直是灰的）。
    // 第一参数是「前门在不在跑」：前门开着也算服务在跑，两者不能同时启。
    let service_running = strata_proxy::running_port(state).is_some();
    tray::sync_menu_state(app, service_running, true);
    Ok(status)
}

#[tauri::command]
async fn strata_stop(app: AppHandle, state: State<'_, AppState>) -> Result<strata::StrataStatus, String> {
    let stopped = strata::stop_strata(&state.strata_slot);
    // 槽里没有进程 = 这个实例不是 GUI 拉起来的（例如用户自己跑了 run-<model>.bat）。
    // 强杀别人的进程树不合适，直接说明情况，让状态由轮询去反映真实端口占用。
    let (snap_running, snap_port, snap_name) = {
        let st = state.strata_status.lock().unwrap_or_else(|e| e.into_inner());
        (st.running, st.port, st.model_name.clone())
    };
    if stopped.is_none() && snap_running {
        let who = snap_name
            .filter(|n| !n.is_empty())
            .map(|n| format!("（{n}）"))
            .unwrap_or_default();
        return Err(format!(
            "端口 :{snap_port} 上的 Strata{who}不是由本 GUI 启动的，请在它自己的控制台里停止"
        ));
    }
    if let Some(pid) = stopped {
        state
            .logs
            .push("system", format!("[gui] 已停止 Strata（pid {pid}）"));
    }
    let mut status = {
        let mut st = state.strata_status.lock().unwrap_or_else(|e| e.into_inner());
        st.running = false;
        st.pid = None;
        st.loaded = None;
        st.external = false;
        st.clone()
    };
    // 引擎停了不代表前门停了：按真实状态补 proxy / proxy_port（用户 m00798）
    strata_proxy::apply_to(&state, &mut status);
    let _ = app.emit("strata://status", status.clone());
    // 前门（服务）在不在跑由它自己那侧算：它退役不了，这里只补 Strata 的真实状态。
    let service_running = strata_proxy::running_port(&state).is_some();
    tray::sync_menu_state(&app, service_running, strata_busy(&state));
    Ok(status)
}

/// 记住 Strata 根目录（**GUI 侧唯一需要用户提供的路径**）。
#[tauri::command]
async fn strata_set_root(state: State<'_, AppState>, path: String) -> Result<settings::Settings, String> {
    let trimmed = path.trim().to_string();
    if !trimmed.is_empty() && !Path::new(&trimmed).is_dir() {
        return Err(format!("目录不存在: {trimmed}"));
    }
    Ok(state.settings.update(|s| {
        s.strata_root = (!trimmed.is_empty()).then(|| PathBuf::from(trimmed.clone()));
    }))
}

/// 只记住选中的模型，不启动（前端下拉/卡片选中时用）。
#[tauri::command]
async fn strata_pick(state: State<'_, AppState>, config_file: String) -> Result<settings::Settings, String> {
    Ok(state.settings.update(|s| s.strata_selected_config = Some(config_file)))
}

/// 读 config 原文（参数编辑 L2）。
#[tauri::command]
async fn strata_config_read(state: State<'_, AppState>, config_file: String) -> Result<String, String> {
    let entry = find_strata_entry(&state, &config_file)?;
    strata::read_config_raw(&entry.config_path).map_err(|err| format!("{err:#}"))
}

/// 写 config（参数编辑 L2；备份 + 校验 + 原子写在 `strata::write_config_raw` 里）。
#[tauri::command]
async fn strata_config_write(
    state: State<'_, AppState>,
    config_file: String,
    text: String,
) -> Result<strata::StrataModelEntry, String> {
    let entry = find_strata_entry(&state, &config_file)?;
    strata::write_config_raw(&entry.config_path, &text).map_err(|err| format!("{err:#}"))?;
    // 写回后重新解析，让前端立刻拿到新的生效值（含"需重启生效"对比所需字段）。
    find_strata_entry(&state, &config_file)
}

#[tauri::command]
fn logs_snapshot(state: State<'_, AppState>, limit: Option<usize>) -> Vec<LogLine> {
    state.logs.snapshot(limit.unwrap_or(logs::LOG_BUFFER_CAP))
}

#[tauri::command]
fn logs_clear(state: State<'_, AppState>) {
    state.logs.clear();
}

/// 日志文件信息：日志页显示路径、并据此打开目录。
#[derive(serde::Serialize)]
pub struct LogFileInfo {
    /// 日志目录（未落盘时为空串）。
    pub dir: String,
    /// 当前日志文件（未落盘时为 null）。
    pub file: Option<String>,
    /// 内存里现有的行数。
    pub lines: usize,
}

#[tauri::command]
fn logs_info(state: State<'_, AppState>) -> LogFileInfo {
    let file = state.logs.file_path();
    LogFileInfo {
        dir: file
            .as_deref()
            .and_then(|p| p.parent())
            .map(|d| d.to_string_lossy().to_string())
            .unwrap_or_default(),
        file: file.map(|p| p.to_string_lossy().to_string()),
        lines: state.logs.len(),
    }
}

/// 用系统文件管理器打开日志目录 —— 排查问题时用户要能把文件发出来（用户 m05885）。
#[tauri::command]
fn logs_open_dir(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let file = state
        .logs
        .file_path()
        .ok_or("日志文件还没建立（这一轮没有写日志）")?;
    let dir = file.parent().ok_or("日志路径异常")?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| format!("打开日志目录失败：{err}"))?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn port_in_use(port: u16) -> bool {
    winfix::port_in_use(port)
}

/// 为非 ASCII 的 llama.cpp 目录创建纯 ASCII 链接（junction），返回可用路径。
#[tauri::command]
async fn fix_ascii_path(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_dir() {
        return Err(format!("目录不存在: {}", target.display()));
    }
    winfix::ensure_ascii_dir(&target, &state.link_root())
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|err| format!("{err:#}"))
}

/// 显存预估：`llama-fit-params --model <gguf> -fitp on`。
#[tauri::command]
async fn fit_preview(
    state: State<'_, AppState>,
    model_path: String,
    // 当前配置面板里的键值对（preset 语义）：显存占用与它们强相关
    params: Option<Vec<(String, String)>>,
) -> Result<Vec<FitRow>, String> {
    let settings = state.settings.get();
    let versions = state
        .versions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let version = versions
        .iter()
        .find(|v| settings.selected_version.as_deref() == Some(v.name.as_str()))
        .or_else(|| versions.first())
        .cloned()
        .ok_or_else(|| "尚未扫描到可用版本".to_string())?;
    if version.fit_params_bin.is_none() {
        return Err(format!(
            "版本 {} 缺少 llama-fit-params，可改用 llama-server 的 --fit 自动分配",
            version.name
        ));
    }
    let path = Path::new(&model_path);
    if !path.is_file() {
        return Err(format!("模型文件不存在: {}", path.display()));
    }
    gpu::fit_preview(&version, path, &params.unwrap_or_default()).map_err(|err| format!("{err:#}"))
}

/// 快速自检：确认后端可用（前端启动时调用一次）。
#[tauri::command]
fn ping() -> &'static str {
    "pong"
}

/// 前端错误上报：写入日志缓冲（source = `frontend`）并打到后端 stderr。
///
/// 用途：Tauri 窗口没有便捷的 devtools 时，前端渲染异常可通过「日志」页直接看到。
#[tauri::command]
fn frontend_log(state: State<'_, AppState>, level: String, message: String) {
    state
        .logs
        .push("frontend", format!("[{level}] {message}"));
    eprintln!("[frontend/{level}] {message}");
}

fn err_chain(err: anyhow::Error) -> String {
    format!("{err:#}")
}

/// 这个几何看起来是不是"最大化"。
///
/// 两个条件**同时**成立才算：尺寸接近某块屏幕，**且**窗口左上角贴着那块屏幕的原点。
/// 只看尺寸会误判 —— 用户完全可能把窗口拖到接近全屏大小，那时左上角在屏幕中间；
/// 反之最大化时 Windows 会给窗口一个贴边（甚至 -8,-8）的位置。
///
/// 容差取得比较宽：最大化时的窗口高度是**工作区**高度，比整块屏幕少掉任务栏与边框
/// （150% 缩放下实测能差 120px 左右）。
///
/// 用启动时缓存的显示器几何做纯内存比较 —— 事件回调里不能调窗口 getter
/// （`is_maximized()` 要走消息往返，而回调本身就跑在事件循环线程上）。
fn looks_maximized(state: &AppState, x: i32, y: i32, width: u32, height: u32) -> bool {
    // 锁中毒也要接着用里面的数据（全仓统一写法）。这里若按"中毒就 return false"处理，
    // 后面每一次 `persist_window_size` 都会把窗口判定成"非最大化"，
    // 用户的「最大化状态记忆」从此静默失效，还查不出原因。
    let monitors = state.monitors.lock().unwrap_or_else(|e| e.into_inner());
    monitors.iter().any(|(mx, my, mw, mh)| {
        let size_close = width as i32 >= *mw as i32 - 60 && height as i32 >= *mh as i32 - 200;
        let near_origin = (x - mx).abs() <= 24 && (y - my).abs() <= 24;
        size_close && near_origin
    })
}
/// 坐标是否合理。
///
/// Windows 把**最小化**的窗口挪到 -32000 一带，若不拦下来，"记住位置"就变成
/// "下次开在屏幕外"（启动时还有一道屏幕校验兜底，但原位置偏好已经丢了）。
/// 注意多显示器的负坐标是合法的（左侧副屏常见 -1920,0），所以只挡极端值。
fn placement_is_sane(x: i32, y: i32) -> bool {
    const LIMIT: i32 = 30_000;
    x.abs() < LIMIT && y.abs() < LIMIT
}

/// 把内存里记着的窗口位置与尺寸写进设置（值没变就不写盘）。
fn persist_window_size(state: &AppState) {
    let mut placement = *state
        .window_size
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // 最小化/异常状态下可能拿到 0，别把窗口"存没了"
    if placement.width < 480 || placement.height < 360 {
        return;
    }
    // 位置异常时只更新尺寸，沿用设置里原来的位置
    if let (Some(x), Some(y)) = (placement.x, placement.y) {
        if !placement_is_sane(x, y) {
            let previous = state.settings.get().window;
            placement.x = previous.x;
            placement.y = previous.y;
        }
    }
    // 统一在这里判定"是不是最大化"，事件里只老实地记几何。
    // 判成最大化就只记这个状态：下次启动直接 maximize()，而不是摆一个屏幕大小的普通窗口
    // （那正是用户看到的"位置没记住"）。
    placement.maximized = match (placement.x, placement.y) {
        (Some(x), Some(y)) => looks_maximized(state, x, y, placement.width, placement.height),
        _ => false,
    };
    if state.settings.get().window == placement {
        return;
    }
    state.settings.update(|s| {
        s.window = placement;
    });
}

/// 这个坐标是否落在某块屏幕里（窗口左上角进得去就算）。
///
/// 用途：显示器拔了/换了以后，上次存的坐标可能已经不在任何屏幕上，
/// 直接照搬会把窗口开在看不见的地方。
fn position_on_some_monitor<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, x: i32, y: i32) -> bool {
    let Ok(monitors) = window.available_monitors() else {
        return true; // 拿不到显示器信息就别拦着
    };
    if monitors.is_empty() {
        return true;
    }
    monitors.iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        x >= position.x
            && y >= position.y
            && x < position.x + size.width as i32
            && y < position.y + size.height as i32
    })
}

/// llama.cpp 通道的端口起始值（只增不回收，见 `docs/archive/PROXY_SCHEDULER_PLAN.md` §3.3）。
pub(crate) const LLAMACPP_PORT_BASE: u16 = 8211;

/// 把 config 目录与扫描结果对齐。
///
/// 顺序很重要：先**归档**（模型文件已经不在的配置移进 `.orphan\`），再**还原**
/// （模型重新出现时从 `.orphan\` 接回上次的参数）—— 两边共用同一个目录。
/// `with_ensure` 为真时，给还没有配置的模型补一份最小 JSON：只有「同步」才传真，
/// 否则每次刷新模型都会往磁盘写文件。
///
/// 返回 `(配置项, 还原的段, 归档的段, 是否跳过了归档)`。
fn sync_model_configs(
    dir: &Path,
    models_list: &[models::ScannedModel],
    roots: &[PathBuf],
    with_ensure: bool,
) -> (Vec<model_config::DirConfig>, Vec<String>, Vec<String>, bool) {
    let mut items = model_config::load_dir(dir);
    let mut removed: Vec<String> = Vec::new();
    let mut restored: Vec<String> = Vec::new();

    // 保护（沿用 ini 时代的判断）：根目录整个不可用（换机、拔盘、路径写错），或
    // 「扫描结果为空但配置有一堆」，更可能是路径问题而不是用户真把模型删了 ——
    // 这种时候一律不动配置，宁可留着失效配置也不要一次清空。
    let root_gone = roots
        .iter()
        .any(|root| !root.as_os_str().is_empty() && !root.is_dir());
    let all_missing = models_list.is_empty() && items.len() >= 3;
    let skipped = root_gone || all_missing;

    if !skipped {
        let mut kept = Vec::with_capacity(items.len());
        for item in items {
            if models_list
                .iter()
                .any(|m| model_config::same_id(&m.id, &item.id))
            {
                kept.push(item);
                continue;
            }
            match model_config::move_to_orphan(dir, &item.id) {
                Ok(Some(_)) => removed.push(item.id),
                Ok(None) => {}
                Err(err) => eprintln!("[config] 归档 {} 失败: {err:#}", item.id),
            }
        }
        items = kept;
    }

    // 模型在、配置不在：先从 `.orphan\` 还原（保住用户上次的调参），否则补最小配置
    for model in models_list {
        if items
            .iter()
            .any(|item| model_config::same_id(&item.id, &model.id))
        {
            continue;
        }
        match model_config::restore_from_orphan(dir, &model.id, &model.path) {
            Ok(Some(_)) => {
                restored.push(model.id.clone());
                continue;
            }
            Ok(None) => {}
            Err(err) => eprintln!("[config] 还原 {} 失败: {err:#}", model.id),
        }
        if with_ensure {
            if let Err(err) = model_config::ensure_config(
                dir,
                &model.id,
                &model.path,
                model.mmproj.as_deref(),
                LLAMACPP_PORT_BASE,
            ) {
                eprintln!("[config] 为 {} 补配置失败: {err:#}", model.id);
            }
        }
    }

    // 淘汰键（`no-mmap` 之类）的后果是整个子实例起不来，加载后统一清掉（铁律 5）；
    // 只在真的改动过时写盘。
    items = model_config::load_dir(dir);
    for item in &mut items {
        let mut cfg = item.config.clone();
        if model_config::sanitize_config(&mut cfg) {
            match model_config::write(&item.path, &cfg) {
                Ok(()) => item.config = cfg,
                Err(err) => eprintln!("[config] 清理 {} 的淘汰键失败: {err:#}", item.id),
            }
        }
    }

    (items, restored, removed, skipped)
}

/// 组装扫描结果。
///
/// `configs` 是配置目录的原生视图：前端据此算「已配置」与 WebUI 开关，
/// 不再有 ini 文本投影（第三刀已完成）。
fn build_scan_result(
    models_list: Vec<models::ScannedModel>,
    items: &[model_config::DirConfig],
    restored: Vec<String>,
    removed: Vec<String>,
    skipped: bool,
    roots: &[PathBuf],
) -> models::ModelScanResult {
    models::ModelScanResult {
        models: models_list,
        // 投影文件 / 外挂草稿模型：不列进模型列表，但配置里要能选
        aux_files: models::scan_aux_files(roots),
        // 原生视图：前端不再解析 ini 文本（第三刀）
        configs: items
            .iter()
            .map(|dc| models::ConfigEntry {
                id: model_config::id_of(&dc.path).unwrap_or_else(|| dc.config.name.clone()),
                name: dc.config.name.clone(),
                no_webui: dc.config.no_webui,
                has_model: dc
                    .config
                    .model
                    .as_deref()
                    .map(|m| std::path::Path::new(m).is_file())
                    .unwrap_or(false),
max_context: models::context_limit(&dc.config),
            })
            .collect(),
        removed_sections: removed,
        restored_sections: restored,
        prune_skipped: skipped,
    }
}

/// 后台重扫：扫完落盘并更新内存缓存，只有结果变化时才通知前端。
///
/// 这就是「先显示缓存、再自动更新」里的后半段：用户已经看到列表了，这次扫描在
/// 后台慢慢做；先等一下再开始，免得和窗口/WebView 的启动抢磁盘。
///
/// 同一时刻只允许一条后台扫描：前端在 init、刷新模型、启动 router 之后都会调
/// `models_scan`，每次命中落盘缓存都会走到这里 —— 不拦一道，快速连点就会叠出
/// 好几条线程同时全量读盘、互相覆盖 `models-scan-cache.json`，还各自 emit 一次。
fn spawn_background_scan(app: AppHandle, roots: Vec<PathBuf>) {
    // 认领在**起线程之前**做（线程已经建出来再去重就没意义了）。
    //
    // 凭证拿到手就必须立刻从 `app.try_state()` 借出来的 `State` 上脱离：扫描线程是
    // `'static` 的，借用 `State`（它的生命周期挂在 `app` 上）过不了借用检查。
    // `BackgroundScanGuard` 内部持 `Arc<AtomicBool>`，所以下面可以把 `app` 移进线程。
    let inflight = {
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        let Some(guard) = state.begin_background_scan() else {
            return; // 已经有一条在跑，它会扫出同样的结果，不重复起
        };
        guard
    };
    std::thread::spawn(move || {
        // `inflight` 随线程体结束（含 panic 展开）自动释放；手工清除一旦漏掉，
        // 标志就永久为 true，之后所有后台重扫都被静默跳过
        let _inflight = inflight;
        std::thread::sleep(std::time::Duration::from_millis(400));
        let scanned = models::scan_models(&roots);
        models::save_scan_cache(&roots, &scanned);
        let Some(state) = app.try_state::<AppState>() else {
            return;
        };
        // 内存缓存里只存模型列表，所以「变没变」要连 aux 一起比：
        // 目录里只新增了 mmproj/草稿模型时，模型数组一模一样，但前端的 `auxFiles`
        // 必须跟着更新，否则多模态/草稿选择项一直缺失，直到模型列表恰好变化。
        let aux = models::scan_aux_files(&roots);
        let changed = state.cached_scan(&roots).as_ref() != Some(&scanned)
            || state.cached_aux(&roots).as_ref() != Some(&aux);
        state.store_scan(&roots, &scanned);
        state.store_aux(&roots, &aux);
        if changed {
            // 负载里带上辅助文件（mmproj / 草稿模型）：前端 `onModelsScanned` 靠它换掉 `auxFiles`
            let _ = app.emit(
                "models://scanned",
                serde_json::json!({
                    "models": scanned,
                    "aux_files": aux,
                }),
            );
        }
    });
}

/// 递归扫描模型根目录，并返回当前 preset 文件状态。
///
/// 三级缓存，命中越靠前越快：
/// 1. 内存缓存（5 秒内、根目录未变）；
/// 2. **落盘缓存**（上次刷新后写下的结果）—— 立刻返回把列表渲染出来，
///    同时后台自动重扫，扫完有变化才发 `models://scanned` 让前端更新；
/// 3. 完整扫描（只有缓存缺失或根目录变了时才阻塞等待）。
///
/// `refresh = true` 表示用户显式点了刷新：强制完整扫描并刷新落盘缓存。
#[tauri::command]
async fn models_scan(
    app: AppHandle,
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<models::ModelScanResult, String> {
    let settings = state.settings.get();
    let roots = settings.model_roots.clone();
    let config_dir = state.model_config_dir();
    let force = refresh.unwrap_or(false);

    let models_list = if !force {
        if let Some(cached) = state.cached_scan(&roots) {
            cached
        } else if let Some(from_disk) = models::load_scan_cache(&roots) {
            state.store_scan(&roots, &from_disk);
            // 先显示、后更新：用户无感知
            spawn_background_scan(app.clone(), roots.clone());
            from_disk
        } else {
            let scanned = models::scan_models(&roots);
            state.store_scan(&roots, &scanned);
            models::save_scan_cache(&roots, &scanned);
            scanned
        }
    } else {
        let scanned = models::scan_models(&roots);
        state.store_scan(&roots, &scanned);
        models::save_scan_cache(&roots, &scanned);
        scanned
    };

    // 配置目录的读-改-写要串行：这些命令可能在多个线程上并发执行
    let _guard = models::preset_lock();

    // 刷新模型只对齐配置（归档失效的、还原回来的），不主动补新配置：
    // 补配置会写盘，交给用户点「同步」时再做。
    let (items, restored, removed, skipped) =
        sync_model_configs(&config_dir, &models_list, &roots, false);
    Ok(build_scan_result(
        models_list,
        &items,
        restored,
        removed,
        skipped,
        &roots,
    ))
}

/// 扫描并为缺失的模型补齐配置（`<配置目录>\config\llamacpp-<id>.json`）。
#[tauri::command]
async fn config_sync(state: State<'_, AppState>) -> Result<models::ModelScanResult, String> {
    // 配置目录的读-改-写要串行（并发命令会互相覆盖）
    let _guard = models::preset_lock();
    let settings = state.settings.get();
    let roots = settings.model_roots.clone();
    let config_dir = state.model_config_dir();

    let models_list = match state.cached_scan(&roots) {
        Some(cached) => cached,
        None => {
            let scanned = models::scan_models(&roots);
            state.store_scan(&roots, &scanned);
            // 顺手刷新落盘缓存：下次启动可以直接用这份结果渲染
            models::save_scan_cache(&roots, &scanned);
            scanned
        }
    };

    // 「同步」才补配置：模型在、配置不在的，先看 `.orphan\` 有没有旧参数，没有才写最小 JSON
    let (items, restored, removed, skipped) =
        sync_model_configs(&config_dir, &models_list, &roots, true);
    Ok(build_scan_result(
        models_list,
        &items,
        restored,
        removed,
        skipped,
        &roots,
    ))
}

/// 读一份 config 的原文（JSON）。
///
/// 「模型详情」直接显示它：ini 视图退役后不再有文本投影（第三刀）。
#[tauri::command]
fn config_read(state: State<'_, AppState>, section: String) -> Result<String, String> {
    let dir = state.model_config_dir();
    for item in model_config::load_dir(&dir) {
        if model_config::same_id(&item.id, &section) {
            return std::fs::read_to_string(&item.path)
                .map_err(|err| format!("读取 {} 失败：{err:#}", item.path.display()));
        }
    }
    // 没有配置就返回空串：界面显示「还没有配置文件」
    Ok(String::new())
}

/// 写入某个模型的键值对（保留配置里未被涉及的键）。
#[tauri::command]
fn config_upsert(
    state: State<'_, AppState>,
    section: String,
    entries: Vec<(String, String)>,
) -> Result<(), String> {
    // 配置目录的读-改-写要串行（并发命令会互相覆盖）
    let _guard = models::preset_lock();
    let dir = state.model_config_dir();
    model_config::upsert_entries_in_dir(&dir, &section, &entries).map_err(err_chain)?;
    Ok(())
}

/// 删除某个模型的配置（用户点「删除」；模型消失是另一条路径，走归档）。
#[tauri::command]
fn config_remove(state: State<'_, AppState>, section: String) -> Result<(), String> {
    // 配置目录的读-改-写要串行（并发命令会互相覆盖）
    let _guard = models::preset_lock();
    let dir = state.model_config_dir();
    model_config::remove_config_file(&dir, &section).map_err(err_chain)?;
    Ok(())
}

/// 读取某个模型的键值对。
#[tauri::command]
fn config_entries(
    state: State<'_, AppState>,
    section: String,
) -> Result<Vec<(String, String)>, String> {
    let dir = state.model_config_dir();
    for item in model_config::load_dir(&dir) {
        if model_config::same_id(&item.id, &section) {
            return Ok(model_config::entries_from_config(&item.config));
        }
    }
    // 没有配置就返回空表：界面显示默认值，用户一保存就会生成
    Ok(Vec::new())
}

/// 把 API Key 写进**所有** llama.cpp 引擎配置（空串 = 清除，引擎就不带 `--api-key`）。
///
/// 用户 m06341：这个 Key 是给各引擎用的 —— 子实例按各自 config 里的 `api_key` 加 `--api-key`
/// （见 `scheduler::build_model_args`），只存进 GUI 设置等于没设。前门转发时会带上同一份 key。
/// 返回写入的 config 个数（0 = 还没有模型配置）。
#[tauri::command]
fn config_set_api_key(state: State<'_, AppState>, key: String) -> Result<usize, String> {
    // 配置目录的读-改-写要串行（并发命令会互相覆盖）
    let _guard = models::preset_lock();
    let dir = state.model_config_dir();
    let value = key.trim().to_string();
    let mut written = 0usize;
    for item in model_config::load_dir(&dir) {
        let mut cfg = item.config.clone();
        cfg.api_key = if value.is_empty() { None } else { Some(value.clone()) };
        model_config::write(&item.path, &cfg).map_err(err_chain)?;
        written += 1;
    }
    Ok(written)
}

/// 用系统默认程序打开一个本机 http 地址（用于「开始聊天」打开 llama.cpp 自带 WebUI）。
///
/// 只接受 127.0.0.1 / localhost，避免被当成任意协议或命令的跳板；实际打开走
/// `tauri-plugin-opener`，而不是 `cmd /c start` —— 后者会把 URL 里的 `& | ^ %`
/// 当命令行元字符解析（URL 里可能带模型 id，那是用户可控内容）。
#[tauri::command]
fn open_local_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let ok = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");
    if !ok {
        return Err(format!("只允许打开本机 http 地址: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("打开浏览器失败: {err}"))
}

/// 用系统默认浏览器打开外部链接（聊天里模型给出的网页地址，用户 m07200 第 2 点）。
///
/// 与 [`open_local_url`] 分开：那个只放行本机地址，这个只放行 http/https。
/// 不校验的话 `file://` / 自定义协议都能从这里穿出去 —— 链接来自模型输出，
/// 属于不可信内容。
#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let ok = url.starts_with("http://") || url.starts_with("https://");
    if !ok {
        return Err(format!("只允许打开 http/https 链接: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("打开浏览器失败: {err}"))
}
/// 把 hub 的模型启动参数迁移进模型配置（每个模型的应用参数一次性搬过来）。
/// hub 根目录由 `llama_cpp_dir` 推断：它通常形如 `<hub>/llamacpp`。
#[tauri::command]
fn config_import_hub(state: State<'_, AppState>) -> Result<models::HubImportReport, String> {
    let dir = state
        .settings
        .get()
        .llama_cpp_dir
        .ok_or_else(|| "尚未设置 llama.cpp 目录".to_string())?;
    let root = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone());
    let hub_config = root.join("config").join("launch_config.json");
    if !hub_config.is_file() {
        return Err(format!(
            "没找到 hub 的模型配置：{}（应用是按 llama.cpp 目录的上一级推断 hub 根目录的）",
            hub_config.display()
        ));
    }
    let config_dir = state.model_config_dir();
    // 配置目录的读-改-写要串行（并发命令会互相覆盖）。
    // 这条路径以前是唯一漏了锁的写入者：与 `preset_upsert` / `config_sync` 撞上时，
    // 后写的一方会拿着旧全文把对方的改动整段抹掉。
    let _guard = models::preset_lock();
    // 第三刀：hub 的参数现在直接写进 config JSON，不再渲染一份 ini 文本当中间层
    // （导入只增不减：配置目录里没有的段不动）。
    let report = models::import_hub_into_dir(&config_dir, &hub_config).map_err(err_chain)?;
    Ok(report)
}

/// 开关开机自启动（官方插件写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`）。
///
/// 每次开启都用**当前** exe 路径重写注册表项，因此应用被移动过也不会留下失效项。
#[tauri::command]
fn autostart_set(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled {
        manager.enable()
    } else {
        manager.disable()
    };
    result.map_err(|err| format!("{err}"))?;
    state.settings.update(|s| s.autostart = enabled);
    manager.is_enabled().map_err(|err| format!("{err}"))
}

/// 查询系统里真实的自启动状态（以注册表为准，可能与设置文件不一致）。
#[tauri::command]
fn autostart_get(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn favourite_toggle(state: State<'_, AppState>, model_id: String) -> Vec<String> {    let updated = state.settings.update(|s| {
        if let Some(pos) = s.favourites.iter().position(|f| f == &model_id) {
            s.favourites.remove(pos);
        } else {
            s.favourites.push(model_id.clone());
        }
    });
    updated.favourites
}

/// 前端首帧渲染完成后调用：这时才把窗口显示出来（用户 m03477）。
///
/// 窗口在 `tauri.conf.json` 里标了 `visible: false`。WebView2 从创建到画出第一帧有几百
/// 毫秒，这期间窗口只显示底色 —— 用户看到的正是「界面显示不全、一块一块是黑的」。
/// 等 React 把首屏挂上去再 show，第一眼就是完整界面。
///
/// `--minimized`（开机自启）不显示：那种情况窗口要驻留托盘，判断统一由后端做。
#[tauri::command]
fn app_boot_finished(window: tauri::WebviewWindow) {
    if BOOT_MINIMIZED.load(Ordering::SeqCst) {
        return;
    }
    let _ = window.show();
    if RESTORE_MAXIMIZED.swap(false, Ordering::SeqCst) {
        let _ = window.maximize();
    }
    let _ = window.set_focus();
}

/// 按 `tauri.conf.json` 里的窗口定义创建主窗口，可指定 webview 的数据目录。
///
/// 为什么要自己建：便携模式下 localStorage / 缓存要跟着 exe 走，
/// 而 Tauri 的自动创建会把 data directory 钉在 `%LOCALAPPDATA%`（见调用点注释）。
fn create_main_window(app: &AppHandle, webview_data_dir: Option<PathBuf>) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("tauri.conf.json 里缺少 label 为 main 的窗口定义")?;
    let mut builder =
        tauri::WebviewWindowBuilder::from_config(app, &config).map_err(|e| e.to_string())?;
    if let Some(dir) = webview_data_dir {
        builder = builder.data_directory(dir);
    }
    let window = builder.build().map_err(|e| e.to_string())?;
    strip_caption_chrome(&window);
    Ok(())
}

/// 去掉系统标题栏左边的图标与文字（用户 m10631 / m10727）。
///
/// 侧栏顶部已经有 logo 和「llama.cpp GUI」，标题栏再来一遍是重复的。
/// 文字那半在 `tauri.conf.json` 的窗口定义里已经改成空串（`index.html` 的
/// `<title>` 也一并清空 —— 网页的标题有可能反过来盖住窗口标题），这里只剩图标。
///
/// Windows 的窗口图标分大小两个：`ICON_BIG` 给任务栏和 Alt+Tab，`ICON_SMALL`
/// 给标题栏。**只动小的那个**，任务栏图标保持原样。
///
/// 只发 `WM_SETICON(ICON_SMALL, NULL)` 是不够的：窗口自己没有小图标时，系统会回退到
/// **窗口类**的小图标（`GCLP_HICONSM`，tao 注册窗口类时写进去的），也就是用户 m10727
/// 截图里那个还在的图标。所以两处一起清：
///   1. `SetClassLongPtrW(GCLP_HICONSM, 0)` 掐掉回退源；
///   2. `WM_SETICON(ICON_SMALL, …)` 换成一张 1×1 全透明图标 —— 比传 NULL 稳，
///      「NULL 是不画还是回退」在不同 Windows 版本上并不一致。
///
/// Tauri 自己的 `set_icon` 走不通：tao 只在 `Some(icon)` 时下发 `WM_SETICON`，传 `None`
/// 什么都不做，而给一张透明图又会把大小两个一起换掉（任务栏就空了）。
#[cfg(windows)]
fn strip_caption_chrome<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIcon, SendMessageW, SetClassLongPtrW, GCLP_HICONSM, ICON_SMALL, WM_SETICON,
    };

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as _;

    // 1×1 单色图标：AND 掩码全 1（该像素完全透明），XOR 掩码全 0。
    // 1bpp 位图的行要按 WORD 对齐，1 像素宽于是一行 2 字节。
    let and_bits: [u8; 2] = [0xFF, 0x00];
    let xor_bits: [u8; 2] = [0x00, 0x00];

    // SAFETY: hwnd 取自刚建好的窗口，句柄有效；`GCLP_HICONSM` 与
    // `WM_SETICON`/`ICON_SMALL` 都是「换掉标题栏图标」的常规用法。
    // 图标句柄刻意不 `DestroyIcon`：它要活到窗口销毁，进程退出时由系统回收。
    unsafe {
        SetClassLongPtrW(hwnd, GCLP_HICONSM, 0);
        let blank = CreateIcon(
            std::ptr::null_mut(),
            1,
            1,
            1,
            1,
            and_bits.as_ptr(),
            xor_bits.as_ptr(),
        );
        let icon = if blank.is_null() { 0 } else { blank as isize };
        SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, icon);
    }
}

#[cfg(not(windows))]
fn strip_caption_chrome<R: tauri::Runtime>(_window: &tauri::WebviewWindow<R>) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例插件必须是**第一个**注册的插件：它要在窗口/托盘创建之前就拦下第二次启动，
        // 否则用户双击多次会得到多个托盘图标、多个 router。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例收到通知：把主窗口叫到前台（窗口可能正收在托盘里）
            tray::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 自启动时带上 --minimized，让应用直接进托盘而不是弹窗打断开机
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            // 便携绿色版：配置放 exe 同目录；装到不可写位置（如 Program Files）时自动
            // 回退系统配置目录，行为与旧版一致 —— 见 paths.rs
            let system_dir = app
                .path()
                .app_config_dir()
                .map_err(|err| format!("无法确定配置目录: {err}"))?;
            let (config_dir, portable) = paths::resolve_config_dir(&system_dir);
            std::fs::create_dir_all(&config_dir)?;
            // 监控采集层（P4）：常驻线程 1 秒采一次，环形缓冲 60 点
            monitor::start_sampler();
            // webview 的数据（localStorage / 缓存）也跟着 exe 走。
            // 必须在建窗口之前定下来：WebView2 建立环境时就锁定了这个目录。
            let webview_data_dir = if portable {
                Some(paths::webview_dir(&config_dir))
            } else {
                None
            };
            let store = settings::SettingsStore::load(config_dir.join("settings.json"));
            // GGUF 元数据（架构/量化）的解析结果按模型缓存到这里，
            // 避免每次启动都去顺序读十几 MB 的词表区
            models::set_meta_cache_path(Some(config_dir.join("gguf-meta-cache.json")));
            // 扫描结果也落盘：启动时先用上次的结果秒开列表，后台再重扫
            models::set_scan_cache_path(Some(config_dir.join("models-scan-cache.json")));
            // 被自动清理掉的 preset 段归档在这里：模型重新下载回来时按段名接回配置
            // 模型消失时的参数归档现在走 `<配置目录>\config\.orphan\`（一个模型一份 JSON 之后，
            // 按段名维度的 `removed-preset-sections.json` 不再写了）。
            let autostart_wanted = store.get().autostart;
            let saved_window = store.get().window;
            let state = AppState::new(config_dir.clone(), store);
            // 日志同时落盘到 `<配置目录>\logs\gui-<启动时间>.log`，一次运行一个文件：
            // 内存环形缓冲一关应用就没了，用户报的现场事后无从查起（用户 m05885）。
            state.logs.attach_file(config_dir.join("logs"));
            // 前门与调度器里的诊断函数拿不到 AppState，靠这个全局句柄写日志（用户 m05816）
            logs::register_global(std::sync::Arc::clone(&state.logs));
            app.manage(state);

            // 一次性迁移：老的 `presets.ini` → `<配置目录>\config\llamacpp-<id>.json`。
            // 幂等（ini 不存在就直接跳过）；**全部段成功才**把 ini 改名成 `.bak-<时间戳>`，
            // 有失败段就原样留着，下次启动接着迁。
            {
                let state = app.state::<AppState>();
                let ini_path = state.preset_path();
                if ini_path.is_file() {
                    let config_dir = state.model_config_dir();
                    match model_config::migrate_from_ini(&ini_path, &config_dir, LLAMACPP_PORT_BASE)
                    {
                        Ok(outcome) if !outcome.is_noop() => {
                            let backup = outcome
                                .backup_path
                                .as_deref()
                                .map(|path| path.display().to_string())
                                .unwrap_or_else(|| "（有段没迁成功，ini 保留原样）".to_string());
                            let message = format!(
                                "[config] 已把 {} 个模型配置迁到 {}，备份 {}",
                                outcome.migrated.len(),
                                config_dir.display(),
                                backup
                            );
                            state.logs.push("system", message);
                        }
                        Ok(_) => {}
                        Err(err) => {
                            state
                                .logs
                                .push("system", format!("[config] 迁移 presets.ini 失败: {err:#}"));
                        }
                    }
                }
            }

            // settings.json 读不出来或内容坏了，必须让用户看见：
            // 以前这两种情况都是静默回落默认值，随后一次写盘就把用户的设置覆盖掉了，
            // 而界面上没有任何提示（用户只会觉得「设置自己丢了」）。
            {
                let state = app.state::<AppState>();
                if let Some(issue) = state.settings.load_issue_message() {
                    state.logs.push("system", format!("[gui] {issue}"));
                }
            }

            // 配置目录写进「系统日志」：用户能在界面上看见配置到底放在哪
            if portable {
                let state = app.state::<AppState>();
                state.logs.push(
                    "system",
                    format!("[gui] 便携模式：配置目录 {}", state.config_dir.display()),
                );
            }

            // 空闲释放线程常驻（用户 m06652）：每轮重新读设置，跟前门在不在无关 ——
            // 手动停掉前门也不该让已加载的模型一直占着显存。
            idle::spawn_idle_unloader(app.handle().clone());

            // 前门随程序启动（A3：对外只留一个端口）。两通道都靠它：
            // llama.cpp 子实例按配置目录里的 JSON 起，Strata 引擎按 config 起。
            {
                let state = app.state::<AppState>();
                if let Err(err) = strata_proxy::autostart(app.handle(), &state) {
                    state.logs.push(
                        "system",
                        format!("[gui] 前门没能自动启动：{err}（可在侧栏胶囊里手动启动）"),
                    );
                }
            }

            // 主窗口在这里手工创建：tauri.conf.json 里 main 标了 `"create": false`。
            // 只有代码创建才能指定 webview 的 data directory —— Windows 下 Tauri 发现它为空时
            // 会强制设成 `%LOCALAPPDATA%\<identifier>`，而配置项 dataDirectory 只支持相对
            // appDataDir 的路径，两者都做不到"跟着 exe 走"。
            create_main_window(app.handle(), webview_data_dir)?;

            // 上次的窗口几何（用户拖过就按原样打开，不再每次回到 1280x860）
            if let Some(window) = app.get_webview_window("main") {
                // 显示器几何先缓存下来：事件回调里没法调窗口 getter（会消息往返失败），
                // 判断"是否最大化"只能靠这份缓存做内存比较
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(monitors) = window.available_monitors() {
                        // 和窗口 Resized/Moved 回调用的是同一个 `monitors` 缓存，中毒处理
                        // 也统一成 `into_inner()`：这里若静默跳过，后面判断"是否最大化"
                        // 就会一直用空列表，用户拖到副屏后关窗尺寸会被写成错的。
                        let mut guard = state.monitors.lock().unwrap_or_else(|e| e.into_inner());
                        *guard = monitors
                            .iter()
                            .map(|m| {
                                let p = m.position();
                                let s = m.size();
                                (p.x, p.y, s.width, s.height)
                            })
                            .collect();
                    }
                }

                // 上次是最大化 —— 或者虽然没记这个标志、但几何本身就是"贴边 + 满屏"
                // （老版本写下的记录）：都直接 maximize()，否则会摆出一个屏幕大小的普通窗口。
                let restore_maximized = saved_window.maximized
                    || match (saved_window.x, saved_window.y) {
                        (Some(x), Some(y)) => app
                            .try_state::<AppState>()
                            .map(|state| {
                                looks_maximized(
                                    &state,
                                    x,
                                    y,
                                    saved_window.width,
                                    saved_window.height,
                                )
                            })
                            .unwrap_or(false),
                        _ => false,
                    };
                if restore_maximized {
                    // 窗口此刻还是隐藏的（`visible: false`）。tao 在 Windows 上把
                    // `maximize()` 实现成 `ShowWindow(SW_MAXIMIZE)`，直接调用会把隐藏窗口
                    // 顶出来、破坏「首帧后显示」。所以先记下意图，等 `app_boot_finished`
                    // 显示窗口之后再最大化。
                    RESTORE_MAXIMIZED.store(true, Ordering::SeqCst);
                } else {
                    let _ = window.set_size(tauri::PhysicalSize::new(
                        saved_window.width.max(640),
                        saved_window.height.max(480),
                    ));
                    // 位置要校验：显示器换了/拔了的话，老坐标会把窗口丢到看不见的地方
                    if let (Some(x), Some(y)) = (saved_window.x, saved_window.y) {
                        if position_on_some_monitor(&window, x, y) {
                            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                        }
                    }
                }
            }

            // 托盘是常驻入口：创建失败只记日志，不影响主窗口
            //
            // 但**必须**把失败记进 AppState：`minimize_to_tray` 默认 true，托盘没有图标时
            // 关窗再 prevent_close + hide 就等于把窗口藏进一个用户点不到的地方
            // （`--minimized` 自启动更糟：启动即 hide，托盘又没有图标，界面根本调不出来）。
            // 窗口关闭回调靠这个标志决定「隐藏」还是「真关」。
            match tray::init(app) {
                Ok(()) => {
                    if let Some(state) = app.try_state::<AppState>() {
                        state.set_tray_available(true);
                    }
                }
                Err(err) => {
                    eprintln!("[tray] 创建托盘图标失败: {err}");
                    if let Some(state) = app.try_state::<AppState>() {
                        state.set_tray_available(false);
                    }
                }
            }

            // 自启动：以注册表为准，顺带修掉「应用被移动过」留下的旧路径
            {
                use tauri_plugin_autostart::ManagerExt;
                let manager = app.autolaunch();
                let actual = manager.is_enabled().unwrap_or(false);
                if autostart_wanted {
                    if let Err(err) = manager.enable() {
                        eprintln!("[autostart] 写入注册表失败: {err}");
                    }
                } else if actual {
                    let _ = manager.disable();
                }
            }

            // 自启动（`--minimized`）拉起时直接驻留托盘；手动启动保持 Tauri 的默认显示行为。
            let minimized = std::env::args().any(|arg| arg == "--minimized");
            BOOT_MINIMIZED.store(minimized, Ordering::SeqCst);
            if minimized {
                // 只在托盘真的建起来时才藏窗口：`--minimized` 是开机自启专用，
                // 窗口藏起来之后用户唯一的入口就是托盘图标 —— 没有图标就是「开机后
                // 什么都没出现，任务管理器里却多了一个进程」。
                let tray_ok = app
                    .try_state::<AppState>()
                    .map(|state| state.tray_available())
                    .unwrap_or(true);
                if tray_ok {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                } else {
                    eprintln!("[tray] 托盘不可用，自启动时不隐藏主窗口（否则用户找不到它）");
                }
            }

            // 兜底：窗口现在是「隐藏创建、等前端 `app_boot_finished` 再显示」。前端脚本要是
            // 直接崩在首帧之前，窗口就永远不会出现 —— 4 秒后无条件显示，那时至少能看到
            // ErrorBoundary 的错误页，而不是「进程在跑、屏幕上什么都没有」。
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if BOOT_MINIMIZED.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Some(window) = handle.get_webview_window("main") {
                        if !window.is_visible().unwrap_or(false) {
                            let _ = window.show();
                        }
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭 → 隐藏到托盘（托盘菜单有「退出」）。设为 false 时按普通窗口关闭处理。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let minimize = window
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|state| state.settings.get().minimize_to_tray)
                    .unwrap_or(false);
                // 托盘不可用时「隐藏」等于把窗口藏没：`--minimized` 启动时窗口本来就
                // 是隐藏的，用户只能靠托盘图标把它叫回来；托盘建不出来就只剩一个
                // 在后台跑着、任务栏里没有、也关不掉的进程。这种时候让窗口正常关闭。
                let tray_ok = window
                    .app_handle()
                    .try_state::<AppState>()
                    .map(|state| state.tray_available())
                    .unwrap_or(false);
                // 顺手把窗口尺寸落盘：用户多半就是拖完大小后关窗的
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    persist_window_size(&state);
                }
                if minimize && tray_ok {
                    api.prevent_close();
                    let _ = window.hide();
                }
            } else if let tauri::WindowEvent::Resized(size) = event {
                // 拖动时这里会连续触发，所以只更新内存，落盘留给关窗/退出
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let mut guard = state.window_size.lock().unwrap_or_else(|e| e.into_inner());
                    guard.width = size.width;
                    guard.height = size.height;
                }
            } else if let tauri::WindowEvent::Moved(position) = event {
                // 同上：移动窗口也是连续事件。
                // 最小化时坐标会变成 -32000 那一带，这种值不能记。
                if placement_is_sane(position.x, position.y) {
                    if let Some(state) = window.app_handle().try_state::<AppState>() {
                        let mut guard = state.window_size.lock().unwrap_or_else(|e| e.into_inner());
                        guard.x = Some(position.x);
                        guard.y = Some(position.y);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ping,
            app_boot_finished,
            frontend_log,
            app_paths,
            settings_get,
            settings_set,
            autostart_set,
            autostart_get,
            versions_list,
            device_list,
            strata_status,
            strata_scan,
            strata_engines,
            strata_set_engine,
            strata_apply_engine,
            strata_probe,
            strata_start,
            strata_stop,
            strata_proxy::strata_proxy_start,
            strata_proxy::strata_proxy_stop,
            strata_set_root,
            strata_pick,
            strata_config_read,
            strata_config_write,
            strata::strata_unload_model,
            strata::strata_load_model,
            logs_snapshot,
            logs_clear,
            logs_info,
            logs_open_dir,
            port_in_use,
            fix_ascii_path,
            fit_preview,
            models_scan,
            config_sync,
            config_read,
            config_upsert,
            config_import_hub,
            open_local_url,
            open_external_url,
            monitor::monitor_sample,
        monitor::monitor_sample_now,
        monitor::monitor_engine,
        search::search_config,
            search::search_save_config,
            search::search_query,
            search::search_test_engine,
            search::web_fetch,
            mcp::mcp_servers_list,
            mcp::mcp_servers_save,
            mcp::mcp_tools_list,
            mcp::mcp_tool_call,
            config_remove,
            config_entries,
            config_set_api_key,
            favourite_toggle,
            bench::bench_server,
            bench::bench_strata,
            bench::bench_records,
            bench::bench_records_add,
            bench::bench_records_delete,
            bench::bench_records_clear,
            bench::bench_hardware,
            bench::save_text_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            // WebView2 初始化过程会把窗口可见性重置回配置值（配置里现在是 `visible: false`），
            // 所以这里**不再无条件 show**：显示统一由前端首帧后的 `app_boot_finished` 做
            // （用户 m03477：提前 show 会露出还没画完的界面，看起来一块一块黑）。
            // 只处理自启动驻留托盘：那种情况再显式 hide 一次，防止初始化把它翻成可见。
            tauri::RunEvent::Ready => {
                if let Some(window) = app_handle.get_webview_window("main") {
                    if BOOT_MINIMIZED.load(Ordering::SeqCst) {
                        let _ = window.hide();
                    }
                }
            }
            tauri::RunEvent::Exit => {
                // 退出时收干净：窗口尺寸落盘、停 router、停 Strata
                // （Strata 的引擎子进程占着显存，GUI 退出后不能留活口）
                if let Some(state) = app_handle.try_state::<AppState>() {
                    persist_window_size(&state);
                    // MCP 服务器是 stdio 子进程：GUI 退了不能留在后台
                    // （node / python 那些还会常驻，重开 GUI 时才重新拉起）。
                    mcp::stop_all();
                    // 前门先关：关掉它才不会在停引擎的过程中又有请求进来触发启动。
                    strata_proxy::shutdown(&state);
                    // 前门拉起的 llama.cpp 子实例同样占着显存，退出时一并停掉。
                    let stopped = state
                        .scheduler
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .stop_all(&state.logs);
                    if !stopped.is_empty() {
                        eprintln!("[exit] 已停止 llama.cpp 子实例：{}", stopped.join("、"));
                    }
                    // 这里只是第二道防线：`AppHandle::exit` 正常会走 `RunEvent::Exit`，
                    // 但 `request_exit` 失败时会退化成 `std::process::exit`（tauri 2.11.5
                    // src/app.rs:573）直接跳过本事件 —— 所以 tray::quit 自己也停一遍。
                    // 先判「本来在跑吗」再动手：没跑时 `stop_*` 返回 None 是正常情况，
                    // 不该刷日志；只有"在跑却停不掉"才是真问题。
                    let strata_was_running = state
                        .strata_slot
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .is_some();
                    if strata_was_running && strata::stop_strata(&state.strata_slot).is_none() {
                        eprintln!("[exit] Strata 停止失败：slot 已被清空但进程可能仍在");
                    }
                }
            }
            _ => {}
        });
}

/// 本次启动是否由自启动拉起（`--minimized`）：为真时启动后直接驻留托盘。
static BOOT_MINIMIZED: AtomicBool = AtomicBool::new(false);

/// 恢复窗口时要不要最大化。窗口是隐藏创建的，`maximize()` 在 Windows 上会把窗口顶出来
/// （tao 用 `ShowWindow(SW_MAXIMIZE)`），所以意图记在这里、等 `app_boot_finished` 显示后再用。
static RESTORE_MAXIMIZED: AtomicBool = AtomicBool::new(false);


#[cfg(test)]
mod tests {
    use super::*;

    /// 窗口位置记忆的两个边界：最小化坐标要挡掉，多显示器的负坐标要放行
    #[test]
    fn window_placement_sanity() {
        // Windows 最小化窗口在 -32000 一带
        assert!(!placement_is_sane(-32000, -32000));
        assert!(!placement_is_sane(0, -32000));
        assert!(!placement_is_sane(32000, 0));
        // 左侧副屏的负坐标是合法的
        assert!(placement_is_sane(-1920, 0));
        assert!(placement_is_sane(0, 0));
        assert!(placement_is_sane(2560, 140));
    }

    /// 同端口多 config（用户 m00001）：端口归属只是猜的，`/health` 报的模型名才是事实。
    #[test]
    fn strata_hit_follows_live_model_name_on_shared_port() {
        let configs = vec![
            (
                "sc117-swift-iq2-xs".to_string(),
                PathBuf::from(r"E:\AI\Strata\strata-sc117-swift-iq2-xs.json"),
            ),
            (
                "swift-iq3_xxs".to_string(),
                PathBuf::from(r"E:\AI\Strata\strata-swift-iq3_xxs.json"),
            ),
        ];
        // 探测目标是「选中的 config」（iq3_xxs），它和被猜到的那份是同一个
        let guessed = Some((
            9090u16,
            Some(configs[1].1.clone()),
            Some(configs[1].0.clone()),
        ));

        // /health 说跑的是 iq2-xs：归属要改成真正在跑的那份
        let fixed = attribute_strata_hit(9090, Some("sc117-swift-iq2-xs"), &configs, guessed.clone()).unwrap();
        assert_eq!(fixed.1.as_ref(), Some(&configs[0].1));
        assert_eq!(fixed.2.as_deref(), Some("sc117-swift-iq2-xs"));

        // 模型名对不上任何 config：退回端口归属，不要凭空清空
        let unknown = attribute_strata_hit(9090, Some("别的模型"), &configs, guessed.clone()).unwrap();
        assert_eq!(unknown.2.as_deref(), Some("swift-iq3_xxs"));

        // 拿不到 /health 的 model（老版本引擎）：同样退回
        let empty = attribute_strata_hit(9090, None, &configs, guessed).unwrap();
        assert_eq!(empty.2.as_deref(), Some("swift-iq3_xxs"));
        assert_eq!(empty.0, 9090);
    }

    /// 槽位里的实例必须把归属信息补回快照（用户 m01031：卡片认不出在跑的是哪个模型）。
    #[test]
    fn slot_owned_instance_restores_ownership_fields() {
        let mut st = strata::StrataStatus::default();
        st.running = true;
        st.port = 9090;
        st.model_name = Some("探测出来的名字".into());

        apply_owned_status(
            &mut st,
            Some((
                9091,
                PathBuf::from(r"E:\AI\Strata\strata-sc117-swift-iq2-xs.json"),
                "sc117-swift-iq2-xs".to_string(),
                1_700_000_000_000,
            )),
        );
        assert_eq!(st.port, 9091);
        assert_eq!(
            st.config_path,
            Some(PathBuf::from(r"E:\AI\Strata\strata-sc117-swift-iq2-xs.json"))
        );
        assert_eq!(st.model_name.as_deref(), Some("sc117-swift-iq2-xs"));
        assert_eq!(st.started_at_ms, Some(1_700_000_000_000));
        assert!(!st.external);

        // 槽位空着（外部实例 / 进程已退出）：一个字都不改，交给探测结果
        let before = st.clone();
        apply_owned_status(&mut st, None);
        assert_eq!(st.config_path, before.config_path);
        assert_eq!(st.port, before.port);
        assert_eq!(st.model_name, before.model_name);
    }
}
