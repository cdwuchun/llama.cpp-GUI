//! 「模型下载」页（导航栏 → 模型下载）的后端。
//!
//! **不自己实现下载协议**。官方安装器 `setup.py` 已经带完整流程（选源 → 下载 GGUF →
//! 打包 → 生成配置），而且支持完全非交互的参数：
//!
//! ```text
//! python setup.py --family <家族> --model <量化> --context <N> --vision yes|no --yes --no-start
//! ```
//!
//! `setup.py:863` 的 `ask()` 在 `yes=True` 时直接返回默认值，所以 `--yes` 就把整条
//! 问答链钉死成推荐值，不会卡在 `input()` 上。GUI 只做三件事：定位解释器与
//! `setup.py`、把它的输出流翻译成进度快照、进程退出时收尾。
//!
//! **进度从 stdout 的 `\r` 行里读**（`setup.py:2652` / `:2863`）：
//!
//! ```text
//!   Qwen3.8-Flash-Next-IQ3_XXS:  42.10 / 75.80 GB (56%)
//! ```
//!
//! 所以读取端不能按行（`BufRead::lines`）读 —— 那行永远等不到 `\n`。这里按字节
//! 收，遇到 `\r` 或 `\n` 都切一行。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use regex::Regex;
use serde::Serialize;

use crate::logs::LogHub;

/// 日志尾部保留的行数（排错只看这一截）。
const LOG_TAIL_CAP: usize = 240;

/// 一段输出最多保留的字节数（防止某个不带换行的进度流把缓冲撑爆）。
const LINE_CAP: usize = 4096;

/// 下载进度行。
///
/// 贪婪匹配 `label` 到冒号，再从三个数字里取 have / total / 百分比 ——
/// 标签里可能带冒号（`DeepSeek-V4.1-Flash: IST-DAS-2.00bpw`），所以用 `[^:]+`
/// 会在第一个冒号处截断。这里反过来：只认「后面紧跟 `a / b GB (n%)` 的那一段」，
/// 让它自己回溯到正确位置。
fn progress_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?P<label>.+?):\s*(?P<have>\d+(?:\.\d+)?)\s*/\s*(?P<total>\d+(?:\.\d+)?)\s*GB\s*\((?P<pct>\d+(?:\.\d+)?)%\)")
            .expect("进度行正则")
    })
}

/// 一次下载任务的进度快照（前端 1 秒轮询一次）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    /// 子进程还在跑
    pub running: bool,
    /// 进程退出码（还在跑时为 None）
    pub exit_code: Option<i32>,
    /// 阶段：`starting` / `check` / `download` / `pack` / `engine` / `config` / `done` / `failed` / `cancelled`
    pub phase: String,
    /// 当前文件的下载百分比 0–100
    pub percent: f32,
    /// 一行状态（界面直接显示）
    pub message: String,
    /// 正在下载的模型/文件名
    pub label: String,
    /// 已下载 / 总字节（只有下载阶段有意义）
    pub done_bytes: f64,
    pub total_bytes: f64,
    /// 最近几百行输出（排错用）
    pub log_tail: Vec<String>,
    /// 结束时判定：成功为 Some(true)
    pub ok: Option<bool>,
    /// 这次任务的目标（前端刷新页面后仍知道下的是什么）
    pub family: String,
    pub quant: String,
    pub context: u32,
    pub images: bool,
}

impl Default for DownloadSnapshot {
    fn default() -> Self {
        Self {
            running: true,
            exit_code: None,
            phase: "starting".into(),
            percent: 0.0,
            message: "正在启动安装器…".into(),
            label: String::new(),
            done_bytes: 0.0,
            total_bytes: 0.0,
            log_tail: Vec::new(),
            ok: None,
            family: String::new(),
            quant: String::new(),
            context: 0,
            images: false,
        }
    }
}

/// 一个在跑的下载任务。
pub struct DownloadJob {
    child: Child,
    snapshot: Arc<Mutex<DownloadSnapshot>>,
}

impl DownloadJob {
    /// 子进程是否还在跑；`try_wait` 顺带回收退出的进程并写回退出码。
    pub fn running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                if let Ok(mut snap) = self.snapshot.lock() {
                    snap.running = false;
                    snap.exit_code = status.code();
                    if snap.ok.is_none() {
                        snap.ok = Some(status.success());
                    }
                    if status.success() {
                        snap.phase = "done".into();
                        snap.percent = 100.0;
                        snap.message = "下载并准备完成：到「模型」页点刷新即可看到新模型".into();
                    } else {
                        snap.phase = "failed".into();
                        snap.message = format!("安装器退出（退出码 {:?}），最后几行输出见下方日志", status.code());
                    }
                }
                false
            }
            Ok(None) => true,
            Err(_) => true,
        }
    }

    pub fn snapshot(&mut self) -> DownloadSnapshot {
        let _ = self.running();
        self.snapshot.lock().map(|guard| guard.clone()).unwrap_or_default()
    }
}

/// 硬杀整棵进程树（`setup.py` 会起下载线程与打包子进程，只杀 python 会留半截文件）。
pub fn stop(job: &mut DownloadJob) {
    crate::logs::force_kill_tree(job.child.id(), &mut job.child);
    let _ = job.child.wait();
    if let Ok(mut snap) = job.snapshot.lock() {
        snap.running = false;
        snap.phase = "cancelled".into();
        snap.message = "已取消下载（已下载的分片会保留，重新下载时接着下）".into();
        snap.ok = Some(false);
    }
}

/// 控制端解释器、`setup.py` 与控制端目录。
///
/// `setup.py` **必须在它自己的目录里跑**：它靠 `Path(__file__).resolve().parent`
/// 推 `ROOT`（`setup.py:76`），换个 cwd 就会把引擎装到别处。
fn locate() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let terminal = crate::strata_tune::terminal_dir(&root).ok_or_else(|| {
        "未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）".to_string()
    })?;
    let python = terminal.join("python").join(crate::strata_tune::python_name());
    let script = terminal.join("setup.py");
    if !script.is_file() {
        return Err(format!("控制端缺少 setup.py：{}", script.display()));
    }
    if !python.is_file() {
        return Err(format!("控制端缺少解释器：{}", python.display()));
    }
    Ok((python, script, terminal))
}

/// 起一次非交互安装的全部参数（前端「下载并准备」时一次性给齐）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DownloadRequest {
    /// 官方目录的家族（`--family`）
    pub family: String,
    /// 量化版本（`--model`）
    pub quant: String,
    /// 启动上下文（`--context`）
    pub context: u32,
    /// 是否带视觉（`--vision yes|no` + `--images qwen-image|no`）
    pub images: bool,
    /// 「使用已有 GGUF」时的本地目录（`--gguf-dir`）
    pub gguf_dir: Option<String>,
    /// 下载落地目录（`--data-dir`）：GGUF / pack / 日志都落在它下面，空 = 用控制端的默认数据目录
    pub data_dir: Option<String>,
    /// `auto` / `modelscope` / `huggingface`（`--source`）
    pub source: Option<String>,
    /// Hugging Face 镜像（走环境变量 `HF_ENDPOINT`，没有对应命令行参数）
    pub hf_endpoint: Option<String>,
    /// `cuda` / `hip` / `sycl`（`--backend`）
    pub backend: Option<String>,
    /// 指定显卡（`--gpu`，nvidia-smi 的编号）
    pub gpu: Option<String>,
}

/// 起一次非交互安装。返回 `(任务, 一句状态)`；已有任务在跑时返回 `(None, 原因)`。
pub fn start(hub: Arc<LogHub>, req: DownloadRequest) -> Result<(Option<DownloadJob>, String), String> {
    let family = req.family.trim();
    let quant = req.quant.trim();
    let context = req.context;
    let images = req.images;
    if family.is_empty() || quant.is_empty() {
        return Err("缺少模型家族或量化版本".into());
    }
    if !(512..=1_048_576).contains(&context) {
        return Err(format!("上下文长度 {context} 超出范围（512–1048576）"));
    }
    let (python, script, cwd) = locate()?;

    let mut snapshot = DownloadSnapshot {
        running: true,
        family: family.to_string(),
        quant: quant.to_string(),
        context,
        images,
        message: format!("正在启动安装器：{family} · {quant}"),
        ..Default::default()
    };
    snapshot.phase = "starting".into();

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("--family")
        .arg(family)
        .arg("--model")
        .arg(quant)
        .arg("--context")
        .arg(context.to_string())
        .arg("--vision")
        .arg(if images { "yes" } else { "no" })
        .arg("--images")
        .arg(if images { "qwen-image" } else { "no" })
        // `--yes` 把整条问答链钉成推荐值（`setup.py:863` 的 ask()）
        .arg("--yes")
        // 只安装不启动：装完由用户在「模型」页手动启用（与上游文案一致）
        .arg("--no-start")
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // 输出里有中文路径，管道下的 Python 会按 locale(cp936) 编码 → 显式钉成 UTF-8；
        // `-u` 的等价物是 PYTHONUNBUFFERED，否则管道缓冲会把进度憋成一坨。
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1");
    if let Some(dir) = req
        .data_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        cmd.arg("--data-dir").arg(dir);
    }
    if let Some(dir) = req
        .gguf_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        cmd.arg("--gguf-dir").arg(dir);
    }
    // 公共配置条（源 / 后端 / 显卡）：值域与 setup.py 的 argparse choices 对齐，
    // 前端传了别的值就当没传，别让安装器整个起不来。
    if let Some(source) = req
        .source
        .as_deref()
        .map(str::trim)
        .filter(|source| matches!(*source, "auto" | "modelscope" | "huggingface"))
    {
        cmd.arg("--source").arg(source);
    }
    if let Some(backend) = req
        .backend
        .as_deref()
        .map(str::trim)
        .filter(|backend| matches!(*backend, "cuda" | "hip" | "sycl"))
    {
        cmd.arg("--backend").arg(backend);
    }
    if let Some(gpu) = req.gpu.as_deref().map(str::trim).filter(|gpu| !gpu.is_empty()) {
        cmd.arg("--gpu").arg(gpu);
    }
    // HF 镜像没有命令行参数，走 `setup.py:111 hf_endpoint()` 读的 HF_ENDPOINT
    if let Some(endpoint) = req
        .hf_endpoint
        .as_deref()
        .map(str::trim)
        .filter(|endpoint| endpoint.starts_with("http"))
    {
        cmd.env("HF_ENDPOINT", endpoint);
    }
    crate::winfix::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|err| format!("启动安装器失败：{err}"))?;
    let snapshot = Arc::new(Mutex::new(snapshot));
    if let Some(stdout) = child.stdout.take() {
        let snap = Arc::clone(&snapshot);
        let hub = Arc::clone(&hub);
        std::thread::spawn(move || drain(stdout, snap, hub));
    }
    if let Some(stderr) = child.stderr.take() {
        let snap = Arc::clone(&snapshot);
        let hub = Arc::clone(&hub);
        std::thread::spawn(move || drain(stderr, snap, hub));
    }
    hub.push(
        "strata-setup",
        format!("开始下载模型：--family {family} --model {quant} --context {context} --vision {}", if images { "yes" } else { "no" }),
    );
    Ok((
        Some(DownloadJob { child, snapshot }),
        format!("已开始下载 {family} · {quant}"),
    ))
}

/// 读一条流，按 `\r` / `\n` 切行喂给快照。
fn drain<R: Read>(mut reader: R, snapshot: Arc<Mutex<DownloadSnapshot>>, hub: Arc<LogHub>) {
    let mut buf = [0u8; 8192];
    let mut line: Vec<u8> = Vec::with_capacity(256);
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                for &byte in &buf[..n] {
                    if byte == b'\n' || byte == b'\r' {
                        if !line.is_empty() {
                            let text = String::from_utf8_lossy(&line).trim().to_string();
                            line.clear();
                            if !text.is_empty() {
                                consume(&snapshot, &hub, &text);
                            }
                        }
                    } else if line.len() < LINE_CAP {
                        line.push(byte);
                    }
                }
            }
            Err(_) => break,
        }
    }
    if !line.is_empty() {
        let text = String::from_utf8_lossy(&line).trim().to_string();
        if !text.is_empty() {
            consume(&snapshot, &hub, &text);
        }
    }
}

/// 一行输出 → 进度 / 阶段 / 尾部日志。
fn consume(snapshot: &Arc<Mutex<DownloadSnapshot>>, hub: &Arc<LogHub>, text: &str) {
    let Ok(mut snap) = snapshot.lock() else { return };
    let mut progressed = false;
    if let Some(caps) = progress_re().captures(text) {
        if let (Ok(have), Ok(total), Ok(pct)) = (
            caps["have"].parse::<f64>(),
            caps["total"].parse::<f64>(),
            caps["pct"].parse::<f32>(),
        ) {
            snap.label = caps["label"].trim().to_string();
            snap.done_bytes = have * 1e9;
            snap.total_bytes = total * 1e9;
            snap.percent = pct;
            snap.phase = "download".into();
            snap.message = format!("正在下载 {} · {have:.1} / {total:.1} GB（{}%）", snap.label, pct.round() as i64);
            progressed = true;
        }
    }
    if !progressed {
        let lower = text.to_ascii_lowercase();
        // 阶段：只认几个稳定的标题行，其余当普通日志。
        if lower.contains("checking your pc") {
            snap.phase = "check".into();
            snap.message = "正在检查本机（显卡 / 内存 / 磁盘）…".into();
        } else if lower.contains("downloading") || lower.contains("download ") {
            if snap.phase != "download" {
                snap.phase = "download".into();
                snap.message = text.trim().to_string();
            }
        } else if lower.contains("pack") && lower.contains("shard") {
            snap.phase = "pack".into();
            snap.message = "正在打包权重…".into();
        } else if lower.contains("engine") && (lower.contains("install") || lower.contains("build")) {
            snap.phase = "engine".into();
            snap.message = text.trim().to_string();
        } else if lower.contains("strata-") && lower.contains(".json") {
            snap.phase = "config".into();
            snap.message = "正在生成模型配置…".into();
        }
        if snap.phase != "download" {
            snap.message = text.trim().to_string();
        }
    }
    snap.log_tail.push(text.to_string());
    while snap.log_tail.len() > LOG_TAIL_CAP {
        snap.log_tail.remove(0);
    }
    drop(snap);
    // 进度行每 2 秒一条，进 GUI 日志会刷屏：只有非进度行才记。
    if !progressed {
        hub.push("strata-setup", text.to_string());
    }
}

// ---------------------------------------------------------------------------
// 磁盘预检
// ---------------------------------------------------------------------------

/// 一次磁盘预检的结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskPreflight {
    /// 模型实际会落在哪个目录
    pub data_directory: Option<String>,
    /// 该目录所在的卷根（`D:\`）
    pub volume: Option<String>,
    /// 卷剩余可用字节
    pub available_bytes: Option<u64>,
    /// 这次要下载的字节数（含打包余量，前端按目录数据算好传进来）
    pub need_bytes: u64,
    /// `ready` / `insufficient` / `unknown`
    pub status: String,
}

/// 模型数据目录：优先读 Strata 自己的 `settings.json.data_dir`，否则 `<Strata 根>\Strata-data`。
///
/// `setup.py:6238` 用同一来源（`settings_path()` → `%APPDATA%\Strata\settings.json`），
/// 只是它自己还带 `--move-data` 之类的迁移逻辑，这里只读不动。
pub(crate) fn data_directory(root: &Path) -> PathBuf {
    let settings = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|dir| dir.join("Strata").join("settings.json"));
    if let Some(path) = settings.filter(|path| path.is_file()) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(dir) = value.get("data_dir").and_then(|dir| dir.as_str()) {
                    let dir = PathBuf::from(dir.trim());
                    if dir.is_dir() {
                        return dir;
                    }
                }
            }
        }
    }
    root.join("Strata-data")
}

/// 取出一个路径所在的卷根（`E:\AI\Strata` → `E:\`）；路径还不存在时向上找最近的祖先。
pub(crate) fn volume_root(path: &Path) -> Option<PathBuf> {
    let mut probe = path;
    while !probe.exists() {
        probe = probe.parent()?;
    }
    let mut comps = probe.components();
    match comps.next() {
        Some(std::path::Component::Prefix(prefix)) => {
            let mut root = PathBuf::from(prefix.as_os_str());
            root.push(std::path::MAIN_SEPARATOR.to_string());
            Some(root)
        }
        _ => probe.ancestors().last().map(Path::to_path_buf),
    }
}

#[cfg(windows)]
pub(crate) fn free_bytes(volume: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = volume
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    // SAFETY: 传进去的是 NUL 结尾的宽字符串，三个指针都指向本函数的局部变量。
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    (ok != 0 && free > 0).then_some(free)
}

#[cfg(not(windows))]
pub(crate) fn free_bytes(_volume: &Path) -> Option<u64> {
    None
}

/// 检查模型目录所在的卷够不够（`need_bytes` 由前端按目录里的 downloadGB 算）。
///
/// `data_dir` 是用户在「下载配置」里指定的落地目录；空则用控制端的默认数据目录。
pub fn preflight(need_bytes: u64, data_dir: Option<&str>) -> DiskPreflight {
    let Some(root) = crate::strata::root().filter(|root| root.is_dir()) else {
        return DiskPreflight {
            data_directory: None,
            volume: None,
            available_bytes: None,
            need_bytes,
            status: "unknown".into(),
        };
    };
    let dir = data_dir
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| data_directory(&root));
    let volume = volume_root(&dir);
    let available = volume.as_deref().and_then(free_bytes);
    let status = match available {
        Some(free) if free >= need_bytes => "ready",
        Some(_) => "insufficient",
        None => "unknown",
    };
    DiskPreflight {
        data_directory: Some(dir.display().to_string()),
        volume: volume.map(|path| path.display().to_string()),
        available_bytes: available,
        need_bytes,
        status: status.into(),
    }
}

// ---------------------------------------------------------------------------
// 本机信息（内存 / 显卡）与本地 GGUF 扫描
// ---------------------------------------------------------------------------

/// 本机信息：「适合这台电脑」那一行与适配判断都用它。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// 物理内存 GB（GiB，与上游 `machineMemoryGB` 同口径）
    pub memory_gb: Option<f64>,
    /// 当前可用内存 GB —— 详情页「本机可用 RAM」那一栏用它（与上游 ResourceAssessmentPanel 同口径）
    pub available_memory_gb: Option<f64>,
    /// 最高一张卡的显存 GB（`nvidia-smi` 的 MiB / 1024，取不到就空）
    pub vram_gb: Option<f64>,
    /// 显卡名（nvidia-smi 取不到就空）
    pub gpus: Vec<String>,
    /// 已装引擎的 Strata 发布版本（`0.2.7` 这条线）。
    ///
    /// 目录名与引擎组件号都走 `0.1.x`，而官方目录的家族门禁（deepseek41 要 `0.2.5`）
    /// 用发布版本线；直接拿组件号比会把 0.1.52 误判成「太旧」（用户 m01630）。
    pub release: Option<String>,
    pub platform: String,
}

#[cfg(windows)]
fn total_memory() -> Option<u64> {
    memory_status().map(|(total, _)| total)
}

#[cfg(windows)]
fn available_memory() -> Option<u64> {
    memory_status().map(|(_, available)| available)
}

#[cfg(not(windows))]
fn available_memory() -> Option<u64> {
    None
}

#[cfg(windows)]
fn memory_status() -> Option<(u64, u64)> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        dwMemoryLoad: 0,
        ullTotalPhys: 0,
        ullAvailPhys: 0,
        ullTotalPageFile: 0,
        ullAvailPageFile: 0,
        ullTotalVirtual: 0,
        ullAvailVirtual: 0,
        ullAvailExtendedVirtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    (ok != 0 && status.ullTotalPhys > 0).then_some((status.ullTotalPhys, status.ullAvailPhys))
}

#[cfg(not(windows))]
fn total_memory() -> Option<u64> {
    None
}

/// 显卡名。`nvidia-smi` 在 PATH 里（装了 NVIDIA 驱动就有）；
/// 取不到就当没有独显 —— 与上游「未检测到显卡」的判定一致。
fn gpu_names() -> Vec<String> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=name", "--format=csv,noheader"])
        .stdin(Stdio::null())
        .creation_flags_hidden()
        .output();
    let Ok(output) = output else { return Vec::new() };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// `Command` 的隐藏窗口开关（`hide_console` 只吃 `&mut Command`，这里是链式临时变量）。
trait CreationFlagsHidden {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}

impl CreationFlagsHidden for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x0800_0000);
        }
        self
    }
}

/// 最高一张卡的显存 GB（MiB / 1024）。速度估算要拿它和参考机型比（上游 `referenceVramGB`）。
fn gpu_vram() -> Option<f64> {
    let output = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .stdin(Stdio::null())
        .creation_flags_hidden()
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let best = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<f64>().ok())
        .fold(0.0_f64, f64::max);
    (best > 0.0).then(|| (best / 1024.0 * 10.0).round() / 10.0)
}

pub fn host_info() -> HostInfo {
    HostInfo {
        memory_gb: total_memory().map(|bytes| bytes as f64 / 1024.0 / 1024.0 / 1024.0),
        available_memory_gb: available_memory().map(|bytes| bytes as f64 / 1024.0 / 1024.0 / 1024.0),
        vram_gb: gpu_vram(),
        gpus: gpu_names(),
        release: engine_release(),
        platform: if cfg!(windows) { "windows".into() } else { "other".into() },
    }
}

/// 已装引擎的 Strata 发布版本：扫 `<根>/engine/<目录>/engine-component.json`
/// 的 `notes` 开头（`"0.2.7 NVIDIA cuda13 engine …"`），取组件号最大的那份。
///
/// 这条线不能从 `strata components engine` 拿 —— 控制端的组件目录（`%LOCALAPPDATA%`）
/// 与 `setup.py` 装的 `<根>/engine` 是两个地方，前者在本机恒为空。
fn engine_release() -> Option<String> {
    let root = crate::strata::root()?;
    let entries = std::fs::read_dir(root.join("engine")).ok()?;
    let mut best: Option<(String, String)> = None;
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("engine-component.json")) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let version = value
            .get("version")
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        let head = value
            .get("notes")
            .and_then(|item| item.as_str())
            .and_then(|notes| notes.split_whitespace().next())
            .unwrap_or_default();
        if head.is_empty() || !head.chars().next().map_or(false, |first| first.is_ascii_digit()) {
            continue;
        }
        let better = match &best {
            Some((known, _)) => version > *known,
            None => true,
        };
        if better {
            best = Some((version, head.to_string()));
        }
    }
    best.map(|(_, release)| release)
}

/// 一个本地 GGUF 文件组（同名多分片合成一条）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalGguf {
    /// 去掉分片后缀的显示名
    pub name: String,
    /// 第一分片的完整路径（`--gguf-dir` 用的是目录，这里给界面看）
    pub path: String,
    /// 全部分片的字节数
    pub bytes: u64,
    /// 分片数
    pub shards: usize,
}

/// 扫描一个目录下的 GGUF 文件（只看这一层，与官方安装器 `--gguf-dir` 的口径一致：
/// 同一目录里放齐所有分片，不要混别的量化）。
pub fn scan_gguf(dir: &str) -> Result<Vec<LocalGguf>, String> {
    let dir = Path::new(dir.trim());
    if !dir.is_dir() {
        return Err(format!("目录不存在：{}", dir.display()));
    }
    let mut groups: Vec<(String, u64, Vec<PathBuf>)> = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|err| format!("读取目录失败：{err}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_gguf = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("gguf"));
        if !is_gguf {
            continue;
        }
        let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
        // `-00001-of-00003.gguf` → 去掉分片后缀做分组键
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default();
        let base = shard_base(stem);
        match groups.iter_mut().find(|(name, ..)| *name == base) {
            Some((_, total, files)) => {
                *total += bytes;
                files.push(path);
            }
            None => groups.push((base, bytes, vec![path])),
        }
    }
    let mut result: Vec<LocalGguf> = groups
        .into_iter()
        .map(|(name, bytes, mut files)| {
            files.sort();
            let shards = files.len();
            LocalGguf {
                name,
                path: files.first().map(|path| path.display().to_string()).unwrap_or_default(),
                bytes,
                shards,
            }
        })
        .collect();
    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(result)
}

/// 「MTP 草稿层」目录的检查结果。
///
/// 上游 `setup.py` 没有 `--mtp` 参数：它只在 `<数据目录>\mtp\rt\experts.bin` 找草稿层
/// （`setup.py:9553` 的 `find_in(roots, "mtp/rt/experts.bin")`）。所以用户选的目录要先认成
/// 「哪一级是数据目录」，再把它当 `--data-dir` 传给安装器（与上游 `local_model.rs::check_mtp` 同一套判定）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtpCheck {
    /// 用户选的那个目录
    pub input: String,
    /// 真正含 `experts.bin` 的 `rt` 目录，引擎的 `--mtp` 用
    pub rt_directory: Option<String>,
    /// 供安装器 `--data-dir` 用的数据目录（`rt` 的上一级叫 `mtp` 时取其上一级）
    pub data_directory: Option<String>,
    /// `experts.bin` 的字节数
    pub experts_bytes: u64,
    /// 不能用时的原因（中文，直接展示）
    pub problems: Vec<String>,
}

/// 认 MTP 草稿层目录：`<x>`、`<x>\rt`、`<x>\mtp\rt` 三种写法都接受。
pub fn check_mtp(dir: &str) -> MtpCheck {
    let input = PathBuf::from(dir.trim());
    let candidates = [
        input.clone(),
        input.join("rt"),
        input.join("mtp").join("rt"),
    ];
    let found = candidates.iter().find(|candidate| {
        std::fs::metadata(candidate.join("experts.bin"))
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
    });
    let mut problems = Vec::new();
    let (rt, data) = match found {
        Some(rt) => {
            let parent = rt.parent().map(Path::to_path_buf);
            let data = parent
                .as_ref()
                .filter(|path| {
                    path.file_name()
                        .map(|name| name.to_string_lossy().eq_ignore_ascii_case("mtp"))
                        .unwrap_or(false)
                })
                .and_then(|path| path.parent())
                .map(Path::to_path_buf);
            (Some(rt.clone()), data)
        }
        None => {
            problems.push(format!(
                "{} 里没有 MTP 草稿层（需要 rt\\experts.bin，例如 Strata-data\\mtp\\rt）",
                input.display()
            ));
            (None, None)
        }
    };
    let experts_bytes = rt
        .as_ref()
        .and_then(|rt| std::fs::metadata(rt.join("experts.bin")).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);
    MtpCheck {
        input: input.display().to_string(),
        rt_directory: rt.map(|rt| rt.display().to_string()),
        data_directory: data.map(|data| data.display().to_string()),
        experts_bytes,
        problems,
    }
}

/// `Qwen3.8-...-IQ3_XXS-00001-of-00003` → `Qwen3.8-...-IQ3_XXS`。
fn shard_base(stem: &str) -> String {
    fn is_shard_number(text: &str) -> bool {
        text.len() == 5 && text.bytes().all(|byte| byte.is_ascii_digit())
    }

    let mut base = stem;
    // 先去掉 `-of-00003`，再去掉 `-00001`
    if let Some((head, tail)) = base.rsplit_once("-of-") {
        if is_shard_number(tail) {
            base = head;
        }
    }
    if let Some((head, tail)) = base.rsplit_once('-') {
        if is_shard_number(tail) {
            base = head;
        }
    }
    base.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_line_is_parsed() {
        let caps = progress_re()
            .captures("  Qwen3.8-Flash-Next-IQ3_XXS:  42.10 / 75.80 GB (56%)   ")
            .expect("匹配进度行");
        assert_eq!(caps["label"].trim(), "Qwen3.8-Flash-Next-IQ3_XXS");
        assert_eq!(caps["have"].parse::<f64>().unwrap(), 42.10);
        assert_eq!(caps["pct"].parse::<f32>().unwrap(), 56.0);
    }

    #[test]
    fn progress_line_keeps_labels_with_colons() {
        let caps = progress_re()
            .captures("  DeepSeek-V4.1-Flash: IST-DAS-2.00bpw: 12.00 / 257.00 GB (5%)")
            .expect("匹配进度行");
        assert_eq!(
            caps["label"].trim(),
            "DeepSeek-V4.1-Flash: IST-DAS-2.00bpw"
        );
    }

    #[test]
    fn shard_suffix_is_stripped() {
        assert_eq!(shard_base("Qwen3.8-IQ3_XXS-00001-of-00003"), "Qwen3.8-IQ3_XXS");
        assert_eq!(shard_base("plain-name"), "plain-name");
    }
}
