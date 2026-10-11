//! 应用共享状态。

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::gpu::DeviceInfo;
use crate::models::{AuxFile, ScannedModel};
use crate::router::{LogHub, RouterProcess, RouterStatus};
use crate::settings::SettingsStore;
use crate::strata::{StrataModelEntry, StrataProcess, StrataStatus};
use crate::versions::LlamaCppVersion;

pub struct AppState {
    pub settings: SettingsStore,
    pub logs: Arc<LogHub>,
    /// 最近一次版本扫描结果。
    pub versions: Mutex<Vec<LlamaCppVersion>>,
    /// 最近一次设备枚举结果。
    pub devices: Mutex<Vec<DeviceInfo>>,
    /// 运行中的 router 进程（`None` = 未运行）。
    pub router_slot: Arc<Mutex<Option<RouterProcess>>>,
    /// router 状态快照（供 `router_status` 直接返回）。
    pub status: Arc<Mutex<RouterStatus>>,
    /// 运行中的 Strata 进程（`None` = 未运行）。与 router 互斥使用显存。
    pub strata_slot: Arc<Mutex<Option<StrataProcess>>>,
    /// Strata 状态快照（供 `strata_status` 直接返回）。
    pub strata_status: Arc<Mutex<StrataStatus>>,
    /// Strata **前门代理**监听句柄（`None` = 没开；用户 m00798）。
    ///
    /// 一个端口（默认 9090）后面挂全部 config，按请求里的 `model` 决定转发给哪个引擎。
    /// 句柄一 drop，监听端口随之释放，所以它必须活到进程退出。
    pub strata_proxy: Arc<Mutex<Option<crate::strata_proxy::ProxyHandle>>>,
    /// 引擎切换互斥：并发请求要不同模型时串行化「停旧 + 起新」。
    ///
    /// 不加这把锁，两个请求会同时走「停掉旧引擎 → 等端口释放 → 起新引擎」，
    /// 第二个会因为端口还没让出来而启动失败（`spawn_strata` 的占用检查）。
    pub strata_switch: Mutex<()>,
    /// 前门**正在服务**的 config 文件名（LIFO 栈，空 = 空闲）。
    ///
    /// 用户 m01266 第 2 点：DSH 请求触发引擎启动/加载时，卡片要显示「加载中」而不是
    /// 「已停止 → 直接跳到运行中」。前门自己在服务谁，它是唯一知情者，所以在这里登记。
    pub strata_proxy_serving: Arc<Mutex<Vec<String>>>,
    /// 应用配置目录。
    pub config_dir: PathBuf,
    /// 模型扫描结果缓存（磁盘遍历较慢，避免每次刷新都重扫）。
    pub scan_cache: Mutex<Option<ScanCache>>,
    /// 主窗口最近一次已知的位置与尺寸。拖动窗口时只更新这里，
    /// 关窗/退出时再落盘，避免 resize/move 事件把 settings.json 写爆。
    pub window_size: Mutex<crate::settings::WindowSize>,
    /// 启动时缓存下来的显示器几何 `(x, y, 宽, 高)`。
    ///
    /// 事件回调（`Moved`/`Resized`）里**不能**调窗口 getter（那需要消息往返，
    /// 而当前就在事件循环线程上，会失败），所以判断"这个几何是不是最大化"只能靠
    /// 事先缓存好的屏幕尺寸做纯内存比较。
    pub monitors: Mutex<Vec<(i32, i32, u32, u32)>>,
    /// 正在进行「启动」流程的进程名（`"router"` / `"strata"`）。
    ///
    /// 启动是「查槽位为空 → 探测版本/端口 → spawn → 写槽位」的多步流程，槽位要到**最后
    /// 一步**才有值。中间这几百毫秒里槽位一直是空的，于是两个并发的启动请求（比如自动启动
    /// 和用户点的按钮，或两次快速点击）都能通过第一步的检查，各拉起一个进程，而槽位只记得住
    /// 后一个 —— 先启动的那个变成没人管的孤儿进程，继续占着端口和显存。
    /// 这里在流程一开始就占位，谁先占谁启动。
    pub starting: Arc<Mutex<HashSet<&'static str>>>,
    /// 托盘是否建起来了。
    ///
    /// 默认 `true`：托盘创建失败只可能发生在 `tray::init` 里，那之后才置 `false`。
    /// 反过来默认 `false` 的话，「窗口关闭」回调只要比 `tray::init` 早跑一次（或 AppState
    /// 还没注册好），用户点 × 就直接退出 —— 把「关窗即隐藏」这条默认行为弄丢了。
    pub tray_available: AtomicBool,
    /// 是否已有后台全量扫描在跑（`spawn_background_scan` 的 in-flight 去重）。
    ///
    /// 前端在 init、刷新、启动 router 之后都会调 `models_scan`，落盘缓存分支每次都会
    /// 起一条线程；不拦一道，快速连点会叠出好几条全量扫描线程同时在读盘、互相覆盖
    /// `models-scan-cache.json`，还会各自 emit 一次 `models://scanned`。
    pub background_scan: Arc<AtomicBool>,
    /// Strata config 扫描缓存（键含 root，换目录必须失效）。
    ///
    /// `scan_configs` 对每份 config 都要读文件、取 metadata、聚合分片、开 GGUF 头，
    /// 而 `strata_probe` 是前端每 5 秒一次的常驻轮询 —— 没有缓存时最重的那条路径
    /// （Strata 没运行，只能扫出全部 config 再逐端口探测）反而跑得最勤。
    pub strata_scan_cache: Mutex<Option<StrataScanCache>>,
    /// 最近一次向上游报告过的辅助文件列表（mmproj / 草稿模型）。
    ///
    /// `scan_cache` 只存模型列表，而 `models://scanned` 的"变没变"要连辅助文件一起判，
    /// 所以这里另存一份（同样是内存缓存 + 5 秒 TTL 的写法）。
    pub aux_cache: Mutex<Option<AuxCache>>,
}

/// 辅助文件列表的缓存。
#[derive(Debug, Clone)]
pub struct AuxCache {
    pub roots: Vec<PathBuf>,
    pub aux: Vec<AuxFile>,
    pub at_ms: u64,
}

/// 一次 Strata config 扫描的结果缓存。
///
/// TTL 与模型侧的 `scan_cache` 同为 5 秒：前端轮询间隔就是 5 秒，
/// 配置目录也不会比这更频繁地变。
#[derive(Debug, Clone)]
pub struct StrataScanCache {
    pub root: PathBuf,
    pub entries: Vec<StrataModelEntry>,
    pub at_ms: u64,
}

/// 「正在启动」的占位凭证，`Drop` 时自动释放。
///
/// 用 RAII 而不是手工清理：启动中间有好几条 `?` 提前返回（找不到版本、spawn 失败……），
/// 手工清理漏掉一条就会把占位永久卡住 —— 进程已经没在启动，却再也启不起来。
pub struct StartGuard {
    starting: Arc<Mutex<HashSet<&'static str>>>,
    key: &'static str,
}

impl Drop for StartGuard {
    fn drop(&mut self) {
        if let Ok(mut set) = self.starting.lock() {
            set.remove(self.key);
        }
    }
}

/// 一次模型扫描的结果缓存。
#[derive(Debug, Clone)]
pub struct ScanCache {
    pub roots: Vec<PathBuf>,
    pub models: Vec<ScannedModel>,
    pub at_ms: u64,
}

/// 「后台扫描正在进行」的凭证，`Drop` 时自动清除标志。
///
/// 用 RAII 而不是在扫描线程末尾手工清除：扫描中间有 `return`（拿不到 AppState），
/// `scan_models` 内部也可能 panic；漏一条清除路径，标志就永久为 true ——
/// 之后所有后台重扫都被静默跳过，"先显示缓存、再自动更新"从此再也不更新。
///
/// 持有 `Arc` 而不是 `&'a AtomicBool`：凭证要被 `std::thread::spawn` 移进扫描线程，
/// 借用版本过不了 `'static` 检查（`app.try_state()` 借来的 `State` 活不过线程）。
pub struct BackgroundScanGuard {
    flag: Arc<AtomicBool>,
}

impl Drop for BackgroundScanGuard {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::SeqCst);
    }
}

impl AppState {
    pub fn new(config_dir: PathBuf, settings: SettingsStore) -> Self {
        let initial = settings.get();
        let initial_port = initial.port;
        let initial_window = initial.window;
        Self {
            settings,
            logs: Arc::new(LogHub::new()),
            versions: Mutex::new(Vec::new()),
            devices: Mutex::new(Vec::new()),
            router_slot: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(RouterStatus {
                port: initial_port,
                ..Default::default()
            })),
            strata_slot: Arc::new(Mutex::new(None)),
            strata_status: Arc::new(Mutex::new(StrataStatus::default())),
            strata_proxy: Arc::new(Mutex::new(None)),
            strata_switch: Mutex::new(()),
            strata_proxy_serving: Arc::new(Mutex::new(Vec::new())),
            config_dir,
            scan_cache: Mutex::new(None),
            window_size: Mutex::new(initial_window),
            monitors: Mutex::new(Vec::new()),
            starting: Arc::new(Mutex::new(HashSet::new())),
            tray_available: AtomicBool::new(true),
            background_scan: Arc::new(AtomicBool::new(false)),
            strata_scan_cache: Mutex::new(None),
            aux_cache: Mutex::new(None),
        }
    }

    /// 声明「这次由我来启动 `key`」。已有一次启动在进行中时返回 `None`。
    ///
    /// 必须在**检查槽位之后、任何耗时动作（版本探测、端口分配、spawn）之前**调用，
    /// 否则空槽检查与占位之间仍有窗口，双实例照样能溜进去。
    pub fn begin_start(&self, key: &'static str) -> Option<StartGuard> {
        let mut set = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(key) {
            return None;
        }
        Some(StartGuard {
            starting: Arc::clone(&self.starting),
            key,
        })
    }

    /// 命中扫描缓存时返回模型列表（要求根目录未变且未过期）。
    pub fn cached_scan(&self, roots: &[PathBuf]) -> Option<Vec<ScannedModel>> {
        let guard = self.scan_cache.lock().ok()?;
        let cache = guard.as_ref()?;
        let fresh = crate::router::now_ms().saturating_sub(cache.at_ms) < 5_000;
        if fresh && cache.roots == roots {
            Some(cache.models.clone())
        } else {
            None
        }
    }

    pub fn store_scan(&self, roots: &[PathBuf], models: &[ScannedModel]) {
        if let Ok(mut guard) = self.scan_cache.lock() {
            *guard = Some(ScanCache {
                roots: roots.to_vec(),
                models: models.to_vec(),
                at_ms: crate::router::now_ms(),
            });
        }
    }

    /// 托盘能不能用。false 时「关窗即隐藏」必须失效（否则窗口无处可寻）。
    pub fn tray_available(&self) -> bool {
        self.tray_available.load(Ordering::SeqCst)
    }

    /// 记录托盘创建结果（`tray::init` 失败时传 false）。
    pub fn set_tray_available(&self, available: bool) {
        self.tray_available.store(available, Ordering::SeqCst);
    }

    /// 认领一次后台全量扫描；已有扫描在跑时返回 `None`（调用方直接放弃本次）。
    ///
    /// 必须在**准备起线程的那一侧**调用（`spawn_background_scan` 里），
    /// 交给新线程自己认领就晚了 —— 线程已经建出来了，去重也就没意义了。
    pub fn begin_background_scan(&self) -> Option<BackgroundScanGuard> {
        self.background_scan
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(BackgroundScanGuard {
            flag: Arc::clone(&self.background_scan),
        })
    }

    /// 命中辅助文件（mmproj / 草稿模型）缓存时返回列表。
    ///
    /// 必须单独缓存一份：`models` 数组不含辅助文件，只比模型列表的话，
    /// 目录里只新增 `mmproj-*.gguf` 会被判成「没变化」，前端 `auxFiles` 永远陈旧。
    pub fn cached_aux(&self, roots: &[PathBuf]) -> Option<Vec<AuxFile>> {
        let guard = self.aux_cache.lock().ok()?;
        let cache = guard.as_ref()?;
        let fresh = crate::router::now_ms().saturating_sub(cache.at_ms) < 5_000;
        if fresh && cache.roots == roots {
            Some(cache.aux.clone())
        } else {
            None
        }
    }

    pub fn store_aux(&self, roots: &[PathBuf], aux: &[AuxFile]) {
        if let Ok(mut guard) = self.aux_cache.lock() {
            *guard = Some(AuxCache {
                roots: roots.to_vec(),
                aux: aux.to_vec(),
                at_ms: crate::router::now_ms(),
            });
        }
    }

    /// 命中 Strata config 扫描缓存时返回结果（要求根目录未变且未过期）。
    pub fn cached_strata_scan(&self, root: &PathBuf) -> Option<Vec<StrataModelEntry>> {
        let guard = self.strata_scan_cache.lock().ok()?;
        let cache = guard.as_ref()?;
        let fresh = crate::router::now_ms().saturating_sub(cache.at_ms) < 5_000;
        if fresh && &cache.root == root {
            Some(cache.entries.clone())
        } else {
            None
        }
    }

    pub fn store_strata_scan(&self, root: &PathBuf, entries: &[StrataModelEntry]) {
        if let Ok(mut guard) = self.strata_scan_cache.lock() {
            *guard = Some(StrataScanCache {
                root: root.clone(),
                entries: entries.to_vec(),
                at_ms: crate::router::now_ms(),
            });
        }
    }

    /// 扫 Strata config：先查 5 秒缓存，未命中才真的扫。
    ///
    /// 只有 `strata_probe`（前端每 5 秒一次的常驻轮询）走缓存；`strata_scan` 与
    /// `find_strata_entry` 都直接调 `strata::scan_configs` —— 前者是用户手点的
    /// 「刷新」，后者要给「刚写完 config」回显最新值，吃缓存就等于刷新无效。
    /// 两者扫完都会 `store_strata_scan` 把缓存覆盖成新结果。
    pub fn strata_configs(&self, root: &PathBuf) -> Vec<StrataModelEntry> {
        if let Some(cached) = self.cached_strata_scan(root) {
            return cached;
        }
        let entries = crate::strata::scan_configs(root);
        self.store_strata_scan(root, &entries);
        entries
    }

    /// `presets.ini` 路径（交给 router 的原生 preset 文件）。
    pub fn preset_path(&self) -> PathBuf {
        self.config_dir.join("presets").join("presets.ini")
    }

    /// 非 ASCII 路径修复用的链接根目录。
    pub fn link_root(&self) -> PathBuf {
        self.config_dir.join("runtime")
    }
}
