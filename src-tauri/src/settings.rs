//! 应用设置：`settings.json` 的读写与默认值。
//!
//! 位置：`<app_config_dir>/settings.json`（Windows 为 `%APPDATA%\<identifier>\settings.json`）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

fn default_port() -> u16 {
    8080
}

fn default_models_max() -> u32 {
    4
}

/// 空闲释放模型的秒数：-1 = 关闭（与 llama.cpp 的 `--sleep-idle-seconds` 默认值一致）。
fn default_sleep_idle_seconds() -> i64 {
    -1
}

fn default_split_mode() -> String {
    // layer 是 llama.cpp 默认值，也是唯一能与 --fit 自动分配共存的多卡模式
    "layer".to_string()
}

fn default_fit() -> bool {
    true
}

fn default_minimize_to_tray() -> bool {
    // 常驻后台是这类服务型应用的正常用法：关窗即隐藏，托盘里右键退出
    true
}

fn default_auto_start_router() -> bool {
    // 打开程序就把服务拉起来（用户明确要求的行为）；不想自动启动可在设置里关掉
    true
}

fn default_true() -> bool {
    true
}

/// GPU / 多卡相关设置（见方案 §4.5）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GpuSettings {
    /// 空 = 不传 `--device`（使用全部可见设备，交给 `--fit` 自动分配）。
    /// 非空时为枚举到的设备名，例如 `["CUDA0", "CUDA1"]`。
    pub devices: Vec<String>,
    /// `layer` | `row` | `none` | `tensor`（`tensor` 与 `--fit` 不兼容）。
    pub split_mode: String,
    /// `None` = 交给 `--fit` 自动切分；`Some([3.0, 1.0])` = 显式比例。
    pub tensor_split: Option<Vec<f32>>,
    pub main_gpu: Option<i32>,
    /// 是否启用 `--fit`（默认开启）。
    pub fit: bool,
    /// 每设备安全余量（MiB）；`None` = 使用 llama.cpp 默认 1024。
    pub fit_target: Option<Vec<u32>>,
    /// 显式 GPU 层数；`None` = 不传 `-ngl`（保留 `--fit` 的自动层分配）。
    /// 一旦设置，`--fit` 会放弃层分配——这是多卡场景最常见的误配。
    pub n_gpu_layers: Option<String>,
}

impl Default for GpuSettings {
    fn default() -> Self {
        Self {
            devices: Vec::new(),
            split_mode: default_split_mode(),
            tensor_split: None,
            main_gpu: None,
            fit: default_fit(),
            fit_target: None,
            n_gpu_layers: None,
        }
    }
}

/// 界面偏好。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ViewSettings {
    pub mode: String,
    pub density: String,
}

impl Default for ViewSettings {
    fn default() -> Self {
        Self {
            mode: "card".into(),
            density: "compact".into(),
        }
    }
}

/// 主窗口的位置与尺寸（物理像素）。用户拖过窗口后记在这里，下次启动照原样打开。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct WindowSize {
    pub width: u32,
    pub height: u32,
    /// 窗口左上角。多显示器变过之后可能落在不存在的屏幕上，启动时会校验。
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// 上次是不是**最大化**状态。
    ///
    /// 必须单独记：最大化时窗口几何就是"屏幕大小 + 贴边负坐标"，单看尺寸与位置
    /// 分辨不出"用户把窗口拖到了这个位置"还是"他最大化了" —— 后者若按普通窗口还原，
    /// 看起来就是"位置没记住"。
    pub maximized: bool,
}

impl Default for WindowSize {
    fn default() -> Self {
        // 与 tauri.conf.json 里的窗口配置保持一致（位置交给系统决定）
        Self {
            width: 1280,
            height: 860,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

/// 单个 llama.cpp 版本的能力探测缓存（`--help` 冷启动约 1.5s，必须缓存）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct VersionProbe {
    pub has_router_mode: bool,
    pub probed_at_ms: u64,
}

impl Default for VersionProbe {
    fn default() -> Self {
        Self {
            has_router_mode: false,
            probed_at_ms: 0,
        }
    }
}

/// 应用设置。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Settings {
    /// 用户指定的 llama.cpp 安装目录（其下可含多个版本子目录，也可本身就是一个版本目录）。
    pub llama_cpp_dir: Option<PathBuf>,
    /// 模型根目录（可多个、任意层级；由应用递归扫描后生成模型配置）。
    pub model_roots: Vec<PathBuf>,
    /// 显式指定的共享 CUDA 运行时目录（必须【直接包含】cudart64_*/cublas64_*.dll）。
    pub shared_lib_dirs: Vec<PathBuf>,
    /// 上次选中的版本目录名。
    pub selected_version: Option<String>,
    /// router 监听端口。
    pub port: u16,
    /// 同时加载的模型上限（llama.cpp 默认 4）。
    pub models_max: u32,
    /// 空闲多少秒后释放模型与显存（router 启动参数 `--sleep-idle-seconds`，对所有模型生效）。
    ///
    /// llama.cpp 的行为是**连模型权重一起释放**（连 mmproj、草稿模型），
    /// 下一次请求到来时自动重新加载。`-1` = 关闭（llama.cpp 的默认值）。
    #[serde(default = "default_sleep_idle_seconds")]
    pub sleep_idle_seconds: i64,
    /// 可选的 `--api-key`。
    pub api_key: Option<String>,
    pub gpu: GpuSettings,
    pub autostart: bool,
    /// 关闭窗口时隐藏到托盘（而不是退出应用）。
    #[serde(default = "default_minimize_to_tray")]
    pub minimize_to_tray: bool,
    /// 应用启动后自动拉起 router。
    #[serde(default = "default_auto_start_router")]
    pub auto_start_router: bool,
    /// 收藏的模型 id。
    pub favourites: Vec<String>,
    /// 本地别名（**不写进 preset**，因为 router 会覆盖 alias 键）。
    pub aliases: HashMap<String, String>,
    pub view: ViewSettings,
    /// 上次关闭时的窗口尺寸（物理像素）
    pub window: WindowSize,
    /// 版本 → 能力探测结果缓存。
    pub version_cache: HashMap<String, VersionProbe>,
    /// Strata 根目录（控制器与引擎的位置）。
    ///
    /// **必须由用户指定，没有默认值**（用户 m00308）：官方安装器装在 `%LOCALAPPDATA%\Strata`，
    /// 用户也可能把安装包手动解压到别处（例如 `E:\AI\strata`：`control\<版本>` 放控制端、
    /// `engine\<版本>` 放引擎、`run-*.bat` / `strata-*.json` 直接放根下）。设置页
    /// 「通用 → Strata 目录」填的路径就是唯一来源，每次保存后由 `lib.rs` 同步给
    /// [`strata::configure_root`]；`None` = 还没指定（此时 Strata 相关界面按未配置处理）。
    #[serde(default)]
    pub strata_root: Option<PathBuf>,
    /// 设置页选中的 Strata 控制器版本目录名（`0.1.51`）。`None` = 跟着 `active.json` 走。
    ///
    /// 真值是各 `run-*.bat` 与 config 的 `cwd`；这里只记「用户选的是哪个」，供设置页
    /// 勾选、以及 run 脚本缺失时回退启动用。
    #[serde(default)]
    pub strata_controller: Option<String>,
    /// 「Strata 控制器版本」卡的**自动跟随最新版本**开关（用户 m00875 / m00920）。
    ///
    /// 开启时：没选过、或选中的版本已经不在 `<根>\control` 下，就自动落到版本最高的可用版本，
    /// 并顺手改写 `run-*.bat` / config。关闭后完全按 `strata_controller` 手动选择走，
    /// 旧版本被删也不改脚本 —— 由用户自己重新选。
    ///
    /// 默认开启：手动解压的安装里版本目录常有多个，不自动选一台等于「一个都没勾」。
    #[serde(default = "default_true")]
    pub strata_auto_controller: bool,
    /// 上次选中的 Strata config 文件名（如 `strata-swift-iq3_xxs.json`）。
    pub strata_selected_config: Option<String>,
    /// 应用启动后自动拉起 Strata（与 router 互斥，二者抢同一块显存）。
    /// 设置页已不再暴露这个开关（界面改造 m01301），字段保留以兼容旧 settings.json。
    #[serde(default)]
    pub auto_start_strata: bool,
    /// Strata 与 router **显存互斥**（用户 m03342）：开启后
    /// ① 启动 Strata 前自动卸载 router 里正在运行的模型；
    /// ② 加载 router 模型前自动停止 Strata。
    /// 默认关闭 —— 自动卸载会打断对方正在进行的会话，要用户主动开启。
    #[serde(default)]
    pub strata_router_mutex: bool,
    /// 设置页「服务」分组**上次写入的值**：监听地址。
    /// 真实来源是各 `strata-*.json` 顶层的 `host`（用户 m01623：保存时直接写进
    /// 所有 config，GUI 不追加命令行参数，启动命令完全照上游生成的 `run-<model>.bat`）。
    /// 这里只用于设置页灌值，避免每次都要重新扫 config。
    #[serde(default)]
    pub strata_host: Option<String>,
    /// 同上，端口。config 与 WebUI 都绑这个端口，上游不支持自动顺延，
    /// 所以占用冲突要显式提示。
    #[serde(default)]
    pub strata_port: Option<u16>,
    /// 同上，API Key（config 里为空表示无鉴权）。
    #[serde(default)]
    pub strata_api_key: Option<String>,
    /// 同上，**空闲卸载秒数**（config 顶层 `idle_unload_s`）。上游 `server.py:5357-5359`：
    /// 空闲这么多秒就把模型卸掉把显存还给别的程序，**下一个请求自动重新加载** ——
    /// 就是 router 的 sleep/wake。0 或缺失 = 关闭。
    #[serde(default)]
    pub strata_idle_unload_s: Option<i64>,
    /// 同上，**加载前要求的空闲显存**（config 顶层 `min_free_vram_mib`）。上游
    /// `server.py:2596-2604`：不够就等 15 秒，仍不够回 503 且模型保持卸载。0 或缺失 = 不检查。
    #[serde(default)]
    pub strata_min_free_vram_mib: Option<i64>,
    /// 同上，**加载模型前跑的命令**（config 顶层 `before_load`）。上游 `server.py:2589-2595`：
    /// `shell=True`、120 秒超时、失败只打印不阻断。可用来在 Strata 抢显存前先卸掉 router 的模型。
    #[serde(default)]
    pub strata_before_load: Option<String>,
    /// 全局选定的 Strata 引擎可执行文件（`components\engine\<版本>-…\strata.exe` 的绝对路径）。
    ///
    /// 引擎组件目录下可能多版本并存，设置页「通用 → Strata 引擎」列出来让用户选；
    /// 选中后由 `strata_apply_engine` 批量写进全部 `strata-*.json` 的 `exe`。
    /// 这里只是「用户选的是哪个」，各 config 自己的 `exe` 才是运行时的真值。
    #[serde(default)]
    pub strata_engine: Option<String>,
    /// 「Strata 引擎版本」卡的**自动跟随最新版本**开关（与控制器那个同一套语义）。
    ///
    /// 开启时：没选过、或选中的 exe 已经不存在，就落到版本最高的那台引擎，并把各
    /// `strata-*.json` 的 `exe` 一起对齐。关闭后完全按 `strata_engine` 走。
    #[serde(default = "default_true")]
    pub strata_auto_engine: bool,
    /// `settings.json` 里**本版本不认识的字段**，原样留着。
    ///
    /// 之前没有任何兜底：反序列化时 serde 默认把未知键**丢弃**，于是应用每次改设置都会
    /// 整份重写 `settings.json`（`persist` 是"覆盖写"），旧版本/未来版本或用户手写的字段
    /// 在一次「改端口」之后就永久消失 —— 降级回旧版本时那些设置全都没了。
    /// 这里 `#[serde(flatten)]` 把未知键收进 map 并跟着序列化写回去。
    ///
    /// 只加在 `Settings` 上（持久化形态）；`SettingsPatch` 是前端发来的热更新载荷，
    /// 故意**不**透传未知键 —— 否则前端多打一个字段名就会被写进用户的配置文件。
    ///
    /// `skip_serializing_if` 是为了不把 `"extra": {}` 塞进文件、也不破坏老文件的外观。
    #[serde(flatten, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            llama_cpp_dir: None,
            model_roots: Vec::new(),
            shared_lib_dirs: Vec::new(),
            selected_version: None,
            port: default_port(),
            models_max: default_models_max(),
            sleep_idle_seconds: default_sleep_idle_seconds(),
            api_key: None,
            gpu: GpuSettings::default(),
            autostart: false,
            minimize_to_tray: default_minimize_to_tray(),
            auto_start_router: default_auto_start_router(),
            favourites: Vec::new(),
            aliases: HashMap::new(),
            view: ViewSettings::default(),
            window: WindowSize::default(),
            version_cache: HashMap::new(),
            strata_root: None,
            strata_controller: None,
            strata_auto_controller: true,
            strata_selected_config: None,
            auto_start_strata: false,
            strata_router_mutex: false,
            strata_idle_unload_s: None,
            strata_min_free_vram_mib: None,
            strata_before_load: None,
            strata_engine: None,
            strata_auto_engine: true,
            strata_host: None,
            strata_port: None,
            strata_api_key: None,
            extra: HashMap::new(),
        }
    }
}

/// 可热更新的字段（来自前端的 patch）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SettingsPatch {
    pub llama_cpp_dir: Option<PathBuf>,
    pub model_roots: Option<Vec<PathBuf>>,
    pub shared_lib_dirs: Option<Vec<PathBuf>>,
    pub selected_version: Option<String>,
    pub port: Option<u16>,
    pub models_max: Option<u32>,
    pub sleep_idle_seconds: Option<i64>,
    pub api_key: Option<String>,
    pub gpu: Option<GpuSettings>,
    pub autostart: Option<bool>,
    pub minimize_to_tray: Option<bool>,
    pub auto_start_router: Option<bool>,
    pub favourites: Option<Vec<String>>,
    pub aliases: Option<HashMap<String, String>>,
    pub view: Option<ViewSettings>,
    pub strata_selected_config: Option<String>,
    pub auto_start_strata: Option<bool>,
    pub strata_router_mutex: Option<bool>,
    pub strata_idle_unload_s: Option<Option<i64>>,
    pub strata_min_free_vram_mib: Option<Option<i64>>,
    pub strata_before_load: Option<Option<String>>,
    /// 全局选定的 Strata 引擎 exe（`None` 的那层 = 清空 = 不指定）。
    pub strata_engine: Option<Option<String>>,
    /// Strata 根目录（控制器与引擎的位置）。`Some(None)` = 清空 = 回官方默认位置。
    pub strata_root: Option<Option<PathBuf>>,
    /// 设置页选中的 Strata 控制器版本目录名。`Some(None)` = 清空 = 跟着 `active.json`。
    pub strata_controller: Option<Option<String>>,
    /// 「自动跟随最新版本」开关（控制器 / 引擎各一），见 [`Settings`] 同名文档。
    pub strata_auto_controller: Option<bool>,
    pub strata_auto_engine: Option<bool>,
    pub strata_host: Option<String>,
    pub strata_port: Option<u16>,
    pub strata_api_key: Option<String>,
}

/// 加载 `settings.json` 时遇到的问题。
///
/// 以前这两种情况都是**完全静默**的：读不出来或内容坏了就当默认值继续跑，而随后
/// 任何一次写盘（拖动窗口、改端口、切主题）都会把默认值立刻覆盖回磁盘 —— 用户攒下来的
/// 整份设置就这么没了，并且没有任何提示。现在把问题记下来，并区分对待：
/// 读不出来 → 本次运行**禁止落盘**；内容坏了 → 先把原文件留档，再尽量从 `.bak` 恢复。
#[derive(Debug, Clone, PartialEq)]
pub enum LoadIssue {
    /// 文件在，但读不出来（被别的进程占用、权限不足、磁盘错误）。
    /// 本次运行用默认值且**不回写**，原文件保持原样等用户处理。
    Unreadable(String),
    /// 文件内容不是合法 JSON。
    Corrupt {
        /// 原文件的留档路径（改名失败时为 `None`）。
        quarantined: Option<PathBuf>,
        /// 是否成功从 `.bak` 恢复出上一次可用的设置。
        recovered_from_backup: bool,
        /// serde 的报错文本（含行列号）。
        error: String,
    },
}

/// 设置存储（内存 + 磁盘）。
pub struct SettingsStore {
    path: PathBuf,
    inner: Mutex<Settings>,
    /// 本次加载遇到的问题；`None` = 一切正常。
    issue: Option<LoadIssue>,
    /// 禁止落盘（只在「文件存在却读不出来」时置位，避免拿默认值覆盖用户的数据）。
    read_only: bool,
}

impl SettingsStore {
    /// 从磁盘加载。
    ///
    /// 三种结果：文件不存在（首次运行，正常可写）／读不出来（用默认值但禁止写回）／
    /// 内容不是合法 JSON（原文件留档 + 尝试 `.bak` 恢复，然后照常可写）。
    pub fn load(path: PathBuf) -> Self {
        match fs::read_to_string(&path) {
            // 首次运行：还没有文件，这是正常状态
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Self {
                path,
                inner: Mutex::new(Settings::default()),
                issue: None,
                read_only: false,
            },
            Err(err) => {
                eprintln!(
                    "[settings] 读取 {} 失败: {err}；本次运行使用默认设置且不写回（原文件保持原样）",
                    path.display()
                );
                Self {
                    path,
                    inner: Mutex::new(Settings::default()),
                    issue: Some(LoadIssue::Unreadable(err.to_string())),
                    read_only: true,
                }
            }
            Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
                Ok(settings) => Self {
                    path,
                    inner: Mutex::new(settings),
                    issue: None,
                    read_only: false,
                },
                Err(err) => {
                    // 内容坏了：先留档（绝不就地丢掉用户文件），再尽量从 .bak 恢复
                    let quarantined = quarantine(&path);
                    let recovered = read_backup(&path);
                    let recovered_from_backup = recovered.is_some();
                    eprintln!(
                        "[settings] 解析 {} 失败: {err}；原文件{}；{}",
                        path.display(),
                        match &quarantined {
                            Some(p) => format!("已留档为 {}", p.display()),
                            None => "改名留档失败".to_string(),
                        },
                        if recovered_from_backup {
                            "已从 settings.json.bak 恢复"
                        } else {
                            "已回退到默认设置"
                        }
                    );
                    Self {
                        path,
                        inner: Mutex::new(recovered.unwrap_or_default()),
                        issue: Some(LoadIssue::Corrupt {
                            quarantined,
                            recovered_from_backup,
                            error: err.to_string(),
                        }),
                        read_only: false,
                    }
                }
            },
        }
    }

    /// 给人看的一句话说明；没有问题时返回 `None`。
    ///
    /// 这是 `issue` / `read_only` 唯一的对外出口（`lib.rs` 启动时把它写进日志）；
    /// 测试以外没有再单独暴露访问器 —— 只给测试用的 getter 会在 release 构建里变成
    /// dead_code 警告（`cargo test` 带 `cfg(test)` 看不到，打包时才冒出来）。
    pub fn load_issue_message(&self) -> Option<String> {
        match self.issue.as_ref()? {
            LoadIssue::Unreadable(err) => Some(format!(
                "settings.json 读取失败（{err}）：本次运行使用默认设置，并且不会写回，原文件保持原样。\
                 请关掉占用它的程序、检查文件权限后重启，否则这次的改动不会被保存。"
            )),
            LoadIssue::Corrupt {
                quarantined,
                recovered_from_backup,
                error,
            } => Some(format!(
                "settings.json 内容损坏（{error}）：{}；{}",
                match quarantined {
                    Some(p) => format!("原文件已留档为 {}", p.display()),
                    None => "原文件改名留档失败".to_string(),
                },
                if *recovered_from_backup {
                    "已从 settings.json.bak 恢复上一次可用的设置。"
                } else {
                    "已回退到默认设置。"
                }
            )),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// 就地修改后立即落盘。
    ///
    /// **落盘在锁内**：之前是先克隆快照、释放锁、再写盘，于是两个线程各自 update 后，
    /// 持有较旧快照的那次 persist 可能晚于另一次落盘，把新改动从磁盘上抹掉
    /// （内存里还是新的，直到下次重启才暴露"设置回退了"）。
    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) -> Settings {
        let mut guard = self.lock();
        f(&mut guard);
        let snapshot = guard.clone();
        if let Err(err) = self.persist(&snapshot) {
            eprintln!("[settings] 写入失败 {}: {err}", self.path.display());
        }
        snapshot
    }

    /// 应用来自前端的 patch（`None` 字段保持不变）。
    ///
    /// 注意**清空**的语义：前端清空输入框时发的是空串（而不是 `null` —— JSON `null`
    /// 在 `Option<T>` 里和"字段缺省"无法区分，会被当成"不改"）。空串在这里统一映射成
    /// `None`，于是"清掉 API Key / 清掉目录"才能真正生效，而不是静默保留旧值。
    pub fn patch(&self, patch: SettingsPatch) -> Settings {
        self.update(|s| {
            if let Some(v) = patch.llama_cpp_dir {
                s.llama_cpp_dir = (!v.as_os_str().is_empty()).then_some(v);
            }
            if let Some(v) = patch.model_roots {
                s.model_roots = v;
            }
            if let Some(v) = patch.shared_lib_dirs {
                s.shared_lib_dirs = v;
            }
            if let Some(v) = patch.selected_version {
                let v = v.trim().to_string();
                s.selected_version = (!v.is_empty()).then_some(v);
            }
            if let Some(v) = patch.port {
                s.port = v;
            }
            if let Some(v) = patch.models_max {
                s.models_max = v;
            }
            if let Some(v) = patch.sleep_idle_seconds {
                s.sleep_idle_seconds = v;
            }
            if let Some(v) = patch.api_key {
                s.api_key = if v.is_empty() { None } else { Some(v) };
            }
            if let Some(v) = patch.gpu {
                s.gpu = v;
            }
            if let Some(v) = patch.autostart {
                s.autostart = v;
            }
            if let Some(v) = patch.minimize_to_tray {
                s.minimize_to_tray = v;
            }
            if let Some(v) = patch.auto_start_router {
                s.auto_start_router = v;
            }
            if let Some(v) = patch.favourites {
                s.favourites = v;
            }
            if let Some(v) = patch.aliases {
                s.aliases = v;
            }
            if let Some(v) = patch.view {
                s.view = v;
            }
            if let Some(v) = patch.strata_selected_config {
                let v = v.trim().to_string();
                s.strata_selected_config = (!v.is_empty()).then_some(v);
            }
            if let Some(v) = patch.auto_start_strata {
                s.auto_start_strata = v;
            }
            if let Some(v) = patch.strata_router_mutex {
                s.strata_router_mutex = v;
            }
            if let Some(v) = patch.strata_idle_unload_s {
                s.strata_idle_unload_s = v.filter(|n| *n > 0);
            }
            if let Some(v) = patch.strata_min_free_vram_mib {
                s.strata_min_free_vram_mib = v.filter(|n| *n > 0);
            }
            if let Some(v) = patch.strata_before_load {
                s.strata_before_load = v.filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string());
            }
            if let Some(v) = patch.strata_engine {
                s.strata_engine = v.filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string());
            }
            if let Some(v) = patch.strata_root {
                // 空路径 = 清空（没有兜底目录，清空后 Strata 相关界面按未配置处理）
                s.strata_root = v.filter(|dir| !dir.as_os_str().is_empty());
            }
            if let Some(v) = patch.strata_controller {
                s.strata_controller = v.filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_string());
            }
            if let Some(v) = patch.strata_auto_controller {
                s.strata_auto_controller = v;
            }
            if let Some(v) = patch.strata_auto_engine {
                s.strata_auto_engine = v;
            }
            if let Some(v) = patch.strata_host {
                let v = v.trim().to_string();
                s.strata_host = (!v.is_empty()).then_some(v);
            }
            if let Some(v) = patch.strata_port {
                // 0 = 清空覆盖，回到 config 自己的 port（0 不是合法端口）。
                s.strata_port = (v > 0).then_some(v);
            }
            if let Some(v) = patch.strata_api_key {
                let v = v.trim().to_string();
                s.strata_api_key = (!v.is_empty()).then_some(v);
            }
        })
    }

    fn persist(&self, settings: &Settings) -> std::io::Result<()> {
        // 原文件存在却读不出来时绝不动它：这时内存里是默认值，写回去等于把用户设置清零。
        if self.read_only {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "settings.json 本次启动读取失败，已跳过写入以免把默认值覆盖到原文件",
            ));
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        // 覆盖前把当前文件留一份 .bak：下次万一解析失败还能从这里恢复
        if self.path.is_file() {
            let _ = fs::copy(&self.path, backup_path(&self.path));
        }
        let json = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".into());
        // 先写临时文件再改名，避免半截文件。
        // 临时名带 pid + 序号：固定用 `settings.json.tmp` 时，两个并发写会互相截断，
        // 先改名的一方还会让另一方的 rename 直接失败。
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = self
            .path
            .with_extension(format!("json.{}.{seq}.tmp", std::process::id()));
        fs::write(&tmp, json)?;
        fs::rename(&tmp, &self.path)
    }
}

/// `settings.json` → `settings.json.bak`。
fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

/// 把读不动的 `settings.json` 改名留档（`settings.json.corrupt-<unix 秒>`），
/// 失败则返回 `None`（此时原文件还在原地，不会丢）。
fn quarantine(path: &Path) -> Option<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let target = path.with_extension(format!("json.corrupt-{stamp}"));
    fs::rename(path, &target).ok().map(|_| target)
}

/// 尝试从 `.bak` 读回上一次可用的设置。
fn read_backup(path: &Path) -> Option<Settings> {
    let raw = fs::read_to_string(backup_path(path)).ok()?;
    serde_json::from_str::<Settings>(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 模型别名（显示名）走 settings 的 aliases 字段：确认前端发来的 patch 形状能解析并生效
    #[test]
    fn aliases_patch_round_trips() {
        let patch: SettingsPatch =
            serde_json::from_str(r#"{"aliases":{"OpenBMB/MiniCPM5-2B":"小模型"}}"#).unwrap();
        let mut s = Settings::default();
        if let Some(v) = patch.aliases {
            s.aliases = v;
        }
        assert_eq!(
            s.aliases.get("OpenBMB/MiniCPM5-2B").map(String::as_str),
            Some("小模型")
        );
        // 别名不写进 preset：preset 只由段内容决定，这里只校验设置字段本身
        assert_eq!(s.aliases.len(), 1);
    }

    /// 清空 API Key：设置页清空后保存的是空串，必须真的把 key 清掉。
    ///
    /// 清不掉的后果很隐蔽：router 仍带 `--api-key` 启动，而界面按"没有 key"去请求，
    /// 所有端点都变成 401（模型列表读不出来、模型也加载不了）。
    /// 反过来，其它字段的 patch 也不能顺手把 key 抹掉。
    #[test]
    fn clearing_api_key_persists_as_none() {
        let dir = std::env::temp_dir().join("llamacpp-gui-api-key-clear-test");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");
        let store = SettingsStore::load(path.clone());

        store.patch(SettingsPatch {
            api_key: Some("sk-old".into()),
            ..Default::default()
        });
        assert_eq!(store.get().api_key.as_deref(), Some("sk-old"));

        // 空串 = 清空，并且要落盘（下次启动 router 读的就是它）
        store.patch(SettingsPatch {
            api_key: Some(String::new()),
            ..Default::default()
        });
        assert_eq!(store.get().api_key, None);
        assert_eq!(
            SettingsStore::load(path.clone()).get().api_key,
            None,
            "清空后落盘的 settings.json 里也不能再有 key"
        );

        // 只改别的字段时，key 不能被顺手抹掉
        store.patch(SettingsPatch {
            api_key: Some("sk-new".into()),
            ..Default::default()
        });
        store.patch(SettingsPatch {
            port: Some(9999),
            ..Default::default()
        });
        assert_eq!(store.get().api_key.as_deref(), Some("sk-new"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn defaults_are_multi_gpu_friendly() {
        let s = Settings::default();
        assert_eq!(s.port, 8080);
        assert_eq!(s.models_max, 4);
        // 默认必须让 --fit 生效：不限制设备、不写 -ngl、不写 tensor-split
        assert!(s.gpu.devices.is_empty());
        assert!(s.gpu.n_gpu_layers.is_none());
        assert!(s.gpu.tensor_split.is_none());
        assert!(s.gpu.fit);
        assert_eq!(s.gpu.split_mode, "layer");
    }

    #[test]
    fn roundtrip_and_unknown_fields() {
        let dir = std::env::temp_dir().join("llamacpp-gui-settings-test");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");
        let store = SettingsStore::load(path.clone());

        store.patch(SettingsPatch {
            port: Some(9100),
            model_roots: Some(vec![PathBuf::from("E:/AI/models")]),
            ..Default::default()
        });

        let reloaded = SettingsStore::load(path);
        let s = reloaded.get();
        assert_eq!(s.port, 9100);
        assert_eq!(s.model_roots, vec![PathBuf::from("E:/AI/models")]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// `settings.json` 里本版本不认识的字段**不能被写盘吃掉**。
    ///
    /// 这条覆盖 HANDOVER 里"未知字段会被保留"的说法：`patch()` 是"读全量 → 改几个字段 →
    /// 整份重写"，serde 默认丢未知键，所以以前只要用户动过一次设置，旧版本/手写的字段
    /// 就永久没了。现在 `Settings` 用 `#[serde(flatten)] extra` 收着它们。
    #[test]
    fn unknown_settings_fields_survive_a_patch() {
        let dir = std::env::temp_dir().join("llamacpp-gui-settings-extra-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        // 模拟"旧版本写的 / 用户手写的 / 未来版本的"字段
        fs::write(
            &path,
            r#"{"port":8080,"future_flag":true,"future_opts":{"a":[1,2],"b":null}}"#,
        )
        .unwrap();

        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get().port, 8080);

        // 改一个本版本认识的字段 → 整份重写
        store.patch(SettingsPatch {
            port: Some(9100),
            ..Default::default()
        });

        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["port"], 9100);
        assert_eq!(parsed["future_flag"], serde_json::Value::Bool(true));
        assert_eq!(parsed["future_opts"]["a"][1], 2);
        assert!(parsed["future_opts"]["b"].is_null());

        // 反过来再读一次也不能丢（extra 必须跟着 load → persist 走完整个来回）
        let again = SettingsStore::load(path).get();
        assert_eq!(again.port, 9100);
        assert_eq!(
            again.extra.get("future_flag"),
            Some(&serde_json::Value::Bool(true))
        );
        assert!(again.extra.contains_key("future_opts"));

        let _ = fs::remove_dir_all(&dir);
    }

    /// 老版本的 settings.json 没有 minimize_to_tray / auto_start_router / window 字段：
    /// 读出来必须是新默认行为（关窗进托盘、启动即拉起 router、默认窗口尺寸）
    #[test]
    fn legacy_settings_without_minimize_to_tray() {
        let raw = r#"{"port":8080,"autostart":false,"model_roots":["E:/AI/models"]}"#;
        let s: Settings = serde_json::from_str(raw).unwrap();
        assert!(s.minimize_to_tray);
        assert!(s.auto_start_router);
        assert_eq!(s.model_roots.len(), 1);
        assert_eq!(s.window.width, 1280);
        assert_eq!(s.window.height, 860);
    }

    /// 窗口尺寸能被记住并读回（下次启动按这个尺寸开窗）
    #[test]
    fn window_size_round_trips() {
        let dir = std::env::temp_dir().join("llamacpp-gui-window-size-test");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");
        let store = SettingsStore::load(path.clone());
        assert_eq!(store.get().window.width, 1280);

        store.update(|s| {
            s.window = WindowSize {
                width: 1512,
                height: 982,
                x: Some(-1200),
                y: Some(48),
                maximized: false,
            }
        });
        let reloaded = SettingsStore::load(path);
        assert_eq!(reloaded.get().window.width, 1512);
        assert_eq!(reloaded.get().window.height, 982);
        assert_eq!(reloaded.get().window.x, Some(-1200));
        assert_eq!(reloaded.get().window.y, Some(48));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {        let dir = std::env::temp_dir().join("llamacpp-gui-settings-corrupt");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        let store = SettingsStore::load(path);
        assert_eq!(store.get().port, 8080);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 内容坏掉时：原文件留档 + 尽量从 .bak 恢复，而不是静默丢掉用户设置
    #[test]
    fn corrupt_file_is_quarantined_and_recovered_from_backup() {
        let dir = std::env::temp_dir().join("llamacpp-gui-settings-quarantine");
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("settings.json");

        let store = SettingsStore::load(path.clone());
        store.patch(SettingsPatch {
            port: Some(9200),
            ..Default::default()
        });
        // 第二次写盘会先把「端口 9200」那一版复制成 settings.json.bak
        store.patch(SettingsPatch {
            api_key: Some("sk-x".into()),
            ..Default::default()
        });
        assert!(path.with_extension("json.bak").is_file(), "应留下 .bak");

        fs::write(&path, "{ 坏掉的 json").unwrap();
        let broken = SettingsStore::load(path.clone());
        match broken.issue.as_ref() {
            Some(LoadIssue::Corrupt {
                quarantined,
                recovered_from_backup,
                ..
            }) => {
                let quarantined = quarantined.as_ref().expect("原文件应被留档");
                assert!(quarantined.is_file(), "留档文件应存在: {quarantined:?}");
                assert!(*recovered_from_backup, "应能从 .bak 恢复");
            }
            other => panic!("应报 Corrupt，实际是 {other:?}"),
        }
        // 恢复出来的是 .bak 那一版（端口 9200，还没有 api_key）
        assert_eq!(broken.get().port, 9200);
        assert_eq!(broken.get().api_key, None);
        assert!(!broken.read_only, "内容损坏时应允许继续写盘");
        // 解析失败的原文件不能还留在原地（否则下次启动又读到坏的）
        assert!(fs::read_to_string(&path).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    /// 原文件存在却读不出来（这里是「settings.json 是个目录」）：只读运行，绝不写盘
    #[test]
    fn unreadable_file_makes_store_read_only() {
        let dir = std::env::temp_dir().join("llamacpp-gui-settings-unreadable");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("settings.json")).unwrap();

        let store = SettingsStore::load(dir.join("settings.json"));
        assert!(store.read_only, "读不出来时必须禁止落盘");
        assert!(matches!(store.issue.as_ref(), Some(LoadIssue::Unreadable(_))));
        assert!(store.load_issue_message().is_some());
        assert_eq!(store.get().port, 8080, "内存里仍是默认值");

        // update() 改内存但不落盘：目录里除了那个同名目录，不该多出任何文件
        store.update(|s| s.port = 7777);
        assert_eq!(store.get().port, 7777);
        let entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries.len(), 1, "不应写出任何文件: {entries:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
