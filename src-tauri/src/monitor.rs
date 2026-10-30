//! 监控采集层（P4）。
//!
//! 三路数据，全部**零新依赖**：
//! - CPU / 物理内存：`windows-sys`（`GetSystemTimes` / `GlobalMemoryStatusEx`），
//!   不引 `sysinfo` —— 本机 cargo 代理不稳定，且 release 开了 LTO + `opt-level="s"`，
//!   多一个采集库体积涨得不成比例（用户 m05070「按 A 开工」）。
//! - GPU：解析 `nvidia-smi --query-gpu=… --format=csv,noheader,nounits`。没有 N 卡
//!   就返回 `None`，界面显示「—」（上游 strata-manager 也是这么降级的）。
//! - 引擎指标：手写 HTTP/1.0 GET 打本机端口（`/metrics`、`/slots`）。本机回环不需要 TLS，
//!   所以不用 `curl.exe`（每次采样 fork 一个进程，开销比读一次 socket 大得多）。
//!
//! **形状照 Strata 的 `serve/telemetry.py`（用户 m05111「可以借鉴吗」）**：对外不是单点，
//! 而是 `{ now, static, history }` 三段 —— 卡片用 `now`/`static`，折线图用 `history`，
//! 一次调用全拿到。采集线程常驻（1 秒一次）并保留 60 点环形缓冲，所以前端切页/重渲染
//! 不会丢点，时间轴是连续的。
//!
//! **autoload 陷阱**：`/metrics?model=X` 会把没加载的模型拉起来。调用方必须先确认
//! 模型是 loaded 状态再采（见 `HANDOVER.md` 与 `STRATA_MANAGER_PORT_ASSESSMENT.md` §6 P4）。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;
// 隐藏子进程窗口：否则每次调 powershell / nvidia-smi 都会闪一下黑框（用户 m06469 第 1 点）。
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 环形缓冲保留多少点。1 秒一个点 ⇒ 一分钟，够画趋势也够压测反查峰值。
pub const HISTORY_POINTS: usize = 60;

// ------------------------------------------------------------------- 数据结构

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuSample {
    pub name: String,
    /// GPU 利用率百分比。
    pub utilization: Option<u32>,
    /// 已用显存（MiB）。
    pub mem_used_mib: Option<u64>,
    pub mem_total_mib: Option<u64>,
    /// 核心温度（摄氏度）。
    pub temperature: Option<u32>,
    /// 当前功耗（瓦）。
    pub power_w: Option<f64>,
    /// 功耗墙（瓦）。
    pub power_limit_w: Option<f64>,
    /// PCIe 下行/上行吞吐（MB/s）。NVML 给的是 KB/s，除 1024 后与 Strata 的
    /// `pcie_rx_mb` / `pcie_tx_mb` 同口径（`telemetry.py:104-107`）。
    pub pcie_rx_mb: Option<f64>,
    pub pcie_tx_mb: Option<f64>,
    /// 当前 PCIe 链路代数（Gen4 → 4）与宽度（x8 → 8）。
    pub pcie_link_gen: Option<u32>,
    pub pcie_link_width: Option<u32>,
}

/// 当前这一刻的读数。`gpu` 是多卡聚合后的值（显存/功耗求和、利用率平均、温度取最大），
/// `gpus` 是每张卡的明细 —— 聚合规则照 `telemetry.py:560-577`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorNow {
    pub cpu_percent: Option<f64>,
    pub mem_used: Option<u64>,
    pub mem_total: Option<u64>,
    pub gpu: Option<GpuSample>,
    pub gpus: Vec<GpuSample>,
    /// 磁盘读/写吞吐（MB/s），来自 PDH 的 `PhysicalDisk(_Total)`，口径同 Strata 的
    /// `disk_read_mb` / `disk_write_mb`（那边是 psutil 差分）。
    pub disk_read_mb: Option<f64>,
    pub disk_write_mb: Option<f64>,
    /// 采样时刻（Unix 毫秒）。压测用它把样本时间窗映射到 `history` 的区间。
    pub at: u64,
}

/// 不随时间变的部分（型号、总量），前端拿一次就不用再读。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatic {
    pub gpu_name: Option<String>,
    /// 物理核心数与逻辑处理器数（照上游 hardware_static.cores / threads，用户 m06197 第 5 点）。
    pub cores: Option<u32>,
    pub threads: Option<u32>,
    pub gpu_count: usize,
    pub mem_total: Option<u64>,
    pub has_gpu: bool,
}

/// 最近 `HISTORY_POINTS` 个点。`at` 与每个序列等长，用来按时间窗切片。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorHistory {
    pub at: Vec<u64>,
    /// 序列名 → 点（`None` = 那一刻没采到，画图断线）。
    pub series: BTreeMap<String, Vec<Option<f64>>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub now: MonitorNow,
    pub r#static: MonitorStatic,
    pub history: MonitorHistory,
}

/// 引擎实时指标（llama.cpp / Strata 前门都认这两个端点）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineMetrics {
    /// `/metrics` 的原文 JSON（解析失败时留在 `error` 里）。
    pub metrics: Option<serde_json::Value>,
    pub slots: Option<serde_json::Value>,
    pub error: Option<String>,
}

// ------------------------------------------------------------- 采集线程与缓冲

/// 画进历史的序列名。顺序即前端折线图的默认顺序。
const SERIES: [&str; 8] = [
    "cpu",
    "memUsed",
    "gpuUtil",
    "gpuMemUsed",
    "gpuTemp",
    "gpuPower",
    "pcieRx",
    "diskRead",
];

#[derive(Default)]
struct Store {
    now: MonitorNow,
    r#static: MonitorStatic,
    at: Vec<u64>,
    series: BTreeMap<String, Vec<Option<f64>>>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

/// 启动常驻采集线程（1 秒一次）。重复调用无副作用。
pub fn start_sampler() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(|| loop {
        sample_once();
        std::thread::sleep(Duration::from_secs(1));
    });
}

/// 物理核心数与逻辑处理器数。走一次 PowerShell CIM（`Win32_Processor`），结果由调用方缓存 ——
/// `GetLogicalProcessorInformationEx` 要手写一堆结构体，这里只为两个数字，不值得。
fn cpu_topology() -> (Option<u32>, Option<u32>) {
    let script = "Get-CimInstance Win32_Processor | ForEach-Object { $_.NumberOfCores; $_.NumberOfLogicalProcessors }";
    let mut cmd = Command::new("powershell");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    let Ok(output) = cmd.output() else {
        return (None, None);
    };
    if !output.status.success() {
        return (None, None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut numbers = text
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .filter(|value| *value > 0);
    (numbers.next(), numbers.next())
}

fn sample_once() {
    let cpu = cpu_percent();
    let memory = memory();
    let gpus = gpu();
    let disk = disk::read();
    let at = now_ms();

    let now = MonitorNow {
        cpu_percent: cpu,
        mem_used: memory.map(|(used, _)| used),
        mem_total: memory.map(|(_, total)| total),
        gpu: aggregate(&gpus),
        gpus: gpus.clone(),
        disk_read_mb: disk.map(|(read, _)| read),
        disk_write_mb: disk.map(|(_, write)| write),
        at,
    };

    let mut guard = match store().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if guard.at.is_empty() {
        // 核心数/线程数只在第一次采时问一次 PowerShell（用户 m06197 第 5 点：CPU 卡要显示核心数）
        let (cores, threads) = cpu_topology();
        guard.r#static.cores = cores;
        guard.r#static.threads = threads;
    }
    if guard.at.is_empty() && !gpus.is_empty() {
        guard.r#static.gpu_name = Some(gpus[0].name.clone());
        guard.r#static.gpu_count = gpus.len();
        guard.r#static.has_gpu = true;
    }
    if let Some((_, total)) = memory {
        guard.r#static.mem_total = Some(total);
    }
    if guard.series.is_empty() {
        for name in SERIES {
            guard.series.insert(name.to_string(), Vec::new());
        }
    }

    guard.at.push(at);
    let values = [
        cpu,
        now.mem_used.map(|used| used as f64),
        now.gpu.as_ref().and_then(|item| item.utilization).map(f64::from),
        now.gpu.as_ref().and_then(|item| item.mem_used_mib).map(|value| value as f64),
        now.gpu.as_ref().and_then(|item| item.temperature).map(f64::from),
        now.gpu.as_ref().and_then(|item| item.power_w),
        now.gpu.as_ref().and_then(|item| item.pcie_rx_mb),
        now.disk_read_mb,
    ];
    for (name, value) in SERIES.iter().zip(values) {
        let list = guard.series.entry((*name).to_string()).or_default();
        list.push(value);
        if list.len() > HISTORY_POINTS {
            let drop = list.len() - HISTORY_POINTS;
            list.drain(..drop);
        }
    }
    if guard.at.len() > HISTORY_POINTS {
        let drop = guard.at.len() - HISTORY_POINTS;
        guard.at.drain(..drop);
    }
    guard.now = now;
}

/// 多卡聚合：显存与功耗求和，利用率取平均，温度取最大（照 `telemetry.py`）。
pub fn aggregate(gpus: &[GpuSample]) -> Option<GpuSample> {
    let first = gpus.first()?;
    if gpus.len() == 1 {
        return Some(first.clone());
    }
    fn sum_u64(items: impl Iterator<Item = Option<u64>>) -> Option<u64> {
        let values: Vec<u64> = items.flatten().collect();
        if values.is_empty() {
            None
        } else {
            Some(values.iter().sum())
        }
    }
    fn sum_f64(items: impl Iterator<Item = Option<f64>>) -> Option<f64> {
        let values: Vec<f64> = items.flatten().collect();
        if values.is_empty() {
            None
        } else {
            Some(values.iter().sum())
        }
    }
    let utilization = {
        let values: Vec<u32> = gpus.iter().filter_map(|item| item.utilization).collect();
        if values.is_empty() {
            None
        } else {
            Some(values.iter().sum::<u32>() / values.len() as u32)
        }
    };
    let temperature = gpus.iter().filter_map(|item| item.temperature).max();
    Some(GpuSample {
        name: first.name.clone(),
        utilization,
        mem_used_mib: sum_u64(gpus.iter().map(|item| item.mem_used_mib)),
        mem_total_mib: sum_u64(gpus.iter().map(|item| item.mem_total_mib)),
        temperature,
        power_w: sum_f64(gpus.iter().map(|item| item.power_w)),
        power_limit_w: sum_f64(gpus.iter().map(|item| item.power_limit_w)),
        // 多卡聚合时 PCIe 吞吐求和（每张卡的链路是独立的，累加才是整机过卡流量）
        pcie_rx_mb: sum_f64(gpus.iter().map(|item| item.pcie_rx_mb)),
        pcie_tx_mb: sum_f64(gpus.iter().map(|item| item.pcie_tx_mb)),
        // 链路代数/宽度不求和（一相加就成了 Gen8 x16 这种不存在的值），取第一张卡的。
        pcie_link_gen: gpus.first().and_then(|item| item.pcie_link_gen),
        pcie_link_width: gpus.first().and_then(|item| item.pcie_link_width),
    })
}

// ---------------------------------------------------------------- CPU / 内存

/// 上一次 `GetSystemTimes` 的三段累计时间（100ns 单位），用来算两次采样之间的占用率。
static LAST_TIMES: Mutex<Option<(u64, u64, u64)>> = Mutex::new(None);

#[cfg(windows)]
fn filetime_ticks(time: &windows_sys::Win32::Foundation::FILETIME) -> u64 {
    ((time.dwHighDateTime as u64) << 32) | time.dwLowDateTime as u64
}

/// CPU 总占用率：`kernel` 时间**已经包含** idle，所以总量是 `kernel + user`，
/// 空闲量是 `idle`。第一次调用没有基线，返回 `None`（下一秒就有值）。
#[cfg(windows)]
fn cpu_percent() -> Option<f64> {
    use windows_sys::Win32::Foundation::FILETIME;
    // GetSystemTimes 在 Threading 模块（不是 SystemInformation），别看名字想当然
    use windows_sys::Win32::System::Threading::GetSystemTimes;

    let mut idle = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = idle;
    let mut user = idle;
    // SAFETY: 三个指针都指向本栈帧上的有效 FILETIME。
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if ok == 0 {
        return None;
    }
    let now = (
        filetime_ticks(&idle),
        filetime_ticks(&kernel),
        filetime_ticks(&user),
    );

    let mut guard = LAST_TIMES.lock().ok()?;
    let previous = *guard;
    *guard = Some(now);
    drop(guard);

    let (prev_idle, prev_kernel, prev_user) = previous?;
    let idle_delta = now.0.saturating_sub(prev_idle);
    let total_delta = now.1.saturating_sub(prev_kernel) + now.2.saturating_sub(prev_user);
    if total_delta == 0 {
        return None;
    }
    let busy = total_delta.saturating_sub(idle_delta);
    Some((busy as f64) * 100.0 / (total_delta as f64))
}

#[cfg(not(windows))]
fn cpu_percent() -> Option<f64> {
    None
}

/// 物理内存：(已用, 总量)，单位字节。
#[cfg(windows)]
fn memory() -> Option<(u64, u64)> {
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
    // SAFETY: dwLength 已按结构体大小填好，指针指向本栈帧上的有效结构。
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) };
    if ok == 0 || status.ullTotalPhys == 0 {
        return None;
    }
    let used = status.ullTotalPhys.saturating_sub(status.ullAvailPhys);
    Some((used, status.ullTotalPhys))
}

#[cfg(not(windows))]
fn memory() -> Option<(u64, u64)> {
    None
}

// ------------------------------------------------------------------------ GPU

const GPU_QUERY: &str = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit";

/// 解析 `nvidia-smi --query-gpu=… --format=csv,noheader,nounits` 的一行：
///
/// ```text
/// NVIDIA GeForce RTX 5070 Ti Laptop GPU, 37, 6214, 12227, 58, 42.31, 100.00
/// ```
///
/// `[N/A]` 表示这张卡没有该项（笔记本功耗墙常见），当成 `None`。
pub fn parse_gpu_line(line: &str) -> Option<GpuSample> {
    let parts: Vec<&str> = line.split(',').map(|item| item.trim()).collect();
    if parts.len() < 4 {
        return None;
    }
    let name = parts[0].to_string();
    if name.is_empty() {
        return None;
    }
    fn num(value: &str) -> Option<f64> {
        let text = value.trim();
        if text.is_empty() || text.eq_ignore_ascii_case("[N/A]") || text.eq_ignore_ascii_case("N/A")
        {
            return None;
        }
        text.parse::<f64>().ok()
    }
    Some(GpuSample {
        name,
        utilization: num(parts[1]).map(|value| value.round() as u32),
        mem_used_mib: num(parts[2]).map(|value| value.round() as u64),
        mem_total_mib: num(parts[3]).map(|value| value.round() as u64),
        temperature: parts
            .get(4)
            .and_then(|item| num(item))
            .map(|value| value.round() as u32),
        power_w: parts.get(5).and_then(|item| num(item)),
        power_limit_w: parts.get(6).and_then(|item| num(item)),
        pcie_rx_mb: None,
        pcie_tx_mb: None,
        pcie_link_gen: None,
        pcie_link_width: None,
    })
}

fn gpu() -> Vec<GpuSample> {
    // 顺序照 Strata 的 telemetry.py：先 NVML（驱动自带，零 fork、含功耗/温度），
    // 拿不到再退 nvidia-smi 子进程解析，最后 AMD 静态兜底（用户 m05188）。
    if let Some(samples) = nvml::read() {
        if !samples.is_empty() {
            return samples;
        }
    }
    let samples = nvidia_smi();
    if !samples.is_empty() {
        return samples;
    }
    amd_static()
}

/// `nvidia-smi` 这条退路：NVML 加载失败（老驱动 / 精减安装）时才用。
fn nvidia_smi() -> Vec<GpuSample> {
    let mut cmd = Command::new("nvidia-smi");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.args([
        format!("--query-gpu={GPU_QUERY}").as_str(),
        "--format=csv,noheader,nounits",
    ]);
    crate::winfix::hide_console(&mut cmd);
    let output = match cmd.output() {
        Ok(output) => output,
        // 没有 nvidia-smi（无 N 卡）就是空表，不是错误
        Err(_) => return Vec::new(),
    };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines().filter_map(parse_gpu_line).collect()
}

/// AMD / Intel 兜底：Windows 上拿不到实时利用率与温度（那要走 ADLX / DXGI），
/// 只能从 CIM 里拿静态型号与显存总量 —— 与 `telemetry.py` 在 Windows 上对 AMD 的
/// 处理一致（它的 `windows_display_adapters` 也只给 name / driver / vram_bytes）。
///
/// 只在前后两条 N 卡路径都空时才试，且结果缓存在 `AMD_STATIC`：`Get-CimInstance`
/// 要起 powershell，不能每秒跑一次。
fn amd_static() -> Vec<GpuSample> {
    static AMD_STATIC: OnceLock<Vec<GpuSample>> = OnceLock::new();
    AMD_STATIC
        .get_or_init(|| {
            let mut cmd = Command::new("powershell");
    cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'AMD|Radeon|Intel' } | Select-Object -First 1 -Property Name,AdapterRAM | ConvertTo-Json -Compress",
            ]);
            crate::winfix::hide_console(&mut cmd);
            let output = match cmd.output() {
                Ok(output) if output.status.success() => output,
                _ => return Vec::new(),
            };
            let text = String::from_utf8_lossy(&output.stdout);
            let value: serde_json::Value = match serde_json::from_str(text.trim()) {
                Ok(value) => value,
                Err(_) => return Vec::new(),
            };
            let name = value.get("Name").and_then(|item| item.as_str()).unwrap_or("");
            if name.is_empty() {
                return Vec::new();
            }
            // AdapterRAM 是 32 位字段，大于 4 GB 的卡会溢出成负值 —— 溢出了就当未知
            let total = value
                .get("AdapterRAM")
                .and_then(|item| item.as_i64())
                .filter(|bytes| *bytes > 0)
                .map(|bytes| (bytes as u64) / (1024 * 1024));
            vec![GpuSample {
                name: name.to_string(),
                utilization: None,
                mem_used_mib: None,
                mem_total_mib: total,
                temperature: None,
                power_w: None,
                power_limit_w: None,
                // nvidia-smi 的文字查询里也能要 pcie.link.gen 之类，但吞吐要额外的
                // `--query-gpu=pcie.link.gen.current` 之类字段且各驱动不一致，这里留空，
                // NVML 那一级才是主力。
                pcie_rx_mb: None,
                pcie_tx_mb: None,
                pcie_link_gen: None,
                pcie_link_width: None,
            }]
        })
        .clone()
}

/// 磁盘吞吐：PDH 的 `\PhysicalDisk(_Total)\Disk Read/Write Bytes/sec`。
///
/// 为什么用 PDH 而不是别的：Strata 那边靠 `psutil.disk_io_counters()` 做差分，
/// Windows 上没有 psutil 就得自己拿等价物；`DeviceIoControl(IOCTL_DISK_PERFORMANCE)`
/// 要逐盘开句柄且 SSD 上口径不一致，PDH 是系统自带的累计速率计数器，最接近 psutil。
/// **必须用 `PdhAddEnglishCounterW`** —— `PdhAddCounterW` 走本地化名，中文系统上
/// `PhysicalDisk(_Total)` 会变成 `PhysicalDisk(_Total)` 之外的译名而查不到。
mod disk {
    #[cfg(windows)]
    use windows_sys::Win32::System::Performance::{
        PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterValue, PdhOpenQueryW,
        PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    };

    /// 一个持久的 PDH 查询。速率计数器要两次采样才有值，所以句柄必须跨调用保留，
    /// 第一次 `read()` 返回 `None`、第二次起才是真实速率。
    pub struct Meter {
        #[cfg(windows)]
        query: PDH_HQUERY,
        #[cfg(windows)]
        read_counter: PDH_HCOUNTER,
        #[cfg(windows)]
        write_counter: PDH_HCOUNTER,
        primed: bool,
    }

    // PDH 句柄是进程级的，只要不并发采集就能跨线程用。采集线程只有一个，所以安全。
    unsafe impl Send for Meter {}

    impl Meter {
        fn open() -> Option<Self> {
            #[cfg(windows)]
            unsafe {
                let mut query: PDH_HQUERY = core::ptr::null_mut();
                if PdhOpenQueryW(core::ptr::null(), 0, &mut query) != 0 {
                    return None;
                }
                let mut read_counter: PDH_HCOUNTER = core::ptr::null_mut();
                let mut write_counter: PDH_HCOUNTER = core::ptr::null_mut();
                let read_path = wide(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec");
                let write_path = wide(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec");
                if PdhAddEnglishCounterW(query, read_path.as_ptr(), 0, &mut read_counter) != 0
                    || PdhAddEnglishCounterW(query, write_path.as_ptr(), 0, &mut write_counter) != 0
                {
                    return None;
                }
                // 首次 collect 建立基线
                PdhCollectQueryData(query);
                return Some(Self { query, read_counter, write_counter, primed: false });
            }
            #[cfg(not(windows))]
            {
                None
            }
        }

        fn sample(&mut self) -> Option<(f64, f64)> {
            #[cfg(windows)]
            unsafe {
                if !self.primed {
                    // 基线那次不算，下一次 collect 才给出速率
                    PdhCollectQueryData(self.query);
                    self.primed = true;
                    return None;
                }
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let read = counter_value(self.read_counter)?;
                let write = counter_value(self.write_counter)?;
                // 字节/秒 → MB/s（1024²，与 Strata 的 psutil 差分同口径）
                return Some((read / 1_048_576.0, write / 1_048_576.0));
            }
            #[cfg(not(windows))]
            {
                None
            }
        }
    }

    /// 读一次。**进程只用一个 Meter**（PDH 句柄不能并发采集），失败就永久返回 `None`。
    pub fn read() -> Option<(f64, f64)> {
        use std::sync::Mutex;
        use std::sync::OnceLock;
        static METER: OnceLock<Mutex<Option<Meter>>> = OnceLock::new();
        let lock = METER.get_or_init(|| Mutex::new(Meter::open()));
        let mut guard = match lock.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.as_mut()?.sample()
    }

    #[cfg(windows)]
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[cfg(windows)]
    unsafe fn counter_value(counter: PDH_HCOUNTER) -> Option<f64> {
        let mut value = PDH_FMT_COUNTERVALUE::default();
        let status = PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, core::ptr::null_mut(), &mut value);
        if status != 0 {
            return None;
        }
        let raw = value.Anonymous.doubleValue;
        raw.is_finite().then_some(raw.max(0.0))
    }
}

/// NVML 直连（`nvml.dll`，随驱动安装）。
///
/// 为什么值得写这么一段：`nvidia-smi` 每次采样要 fork 一个进程（约 30–80 ms，
/// 还会闪一下控制台窗口），而 NVML 是一次 DLL 调用（微秒级）。采样频率提到 1 秒
/// 甚至 5 Hz 时差别很明显，而且 NVML 直接给毫瓦级功耗、不需要解析文本。
mod nvml {
    use super::GpuSample;

    type Device = *mut core::ffi::c_void;
    const NVML_SUCCESS: i32 = 0;
    /// `NVML_TEMPERATURE_GPU`
    const TEMPERATURE_GPU: i32 = 0;
    const NAME_LEN: usize = 96;

    #[repr(C)]
    #[derive(Default)]
    struct Utilization {
        gpu: u32,
        memory: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct MemoryInfo {
        total: u64,
        free: u64,
        used: u64,
    }

    /// 一组函数指针。字段名与 NVML 导出名一致，方便对照官方头文件。
    struct Api {
        device_count: unsafe extern "C" fn(*mut u32) -> i32,
        handle_by_index: unsafe extern "C" fn(u32, *mut Device) -> i32,
        name: unsafe extern "C" fn(Device, *mut core::ffi::c_char, u32) -> i32,
        utilization: unsafe extern "C" fn(Device, *mut Utilization) -> i32,
        memory: unsafe extern "C" fn(Device, *mut MemoryInfo) -> i32,
        temperature: unsafe extern "C" fn(Device, i32, *mut u32) -> i32,
        power: unsafe extern "C" fn(Device, *mut u32) -> i32,
        power_limit: unsafe extern "C" fn(Device, *mut u32) -> i32,
        /// `nvmlDeviceGetPcieThroughput(device, counter, *mut kB/s)`。
        /// 老驱动/某些虚拟化环境没有这个符号，缺失不影响其它读数。
        pcie_throughput: Option<unsafe extern "C" fn(Device, u32, *mut u32) -> i32>,
        pcie_link_gen: Option<unsafe extern "C" fn(Device, *mut u32) -> i32>,
        pcie_link_width: Option<unsafe extern "C" fn(Device, *mut u32) -> i32>,
    }

    /// 取一个符号；缺失只是返回 `None`（不同驱动版本导出的名字不一样）。
    fn symbol(library: *mut core::ffi::c_void, name: &str) -> Option<usize> {
        use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
        let text = std::ffi::CString::new(name).ok()?;
        // SAFETY: library 是下面 LoadLibraryW 返回的有效句柄；name 是合法的 C 字符串。
        let address = unsafe { GetProcAddress(library, text.as_ptr() as *const u8) };
        // GetProcAddress 返回 FARPROC，非空才可用
        address.map(|item| item as usize)
    }

    /// 加载 nvml.dll 并取齐函数指针。任一步失败都返回 `None`，调用方退到 nvidia-smi。
    fn load() -> Option<Api> {
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;

        let path: Vec<u16> = "nvml.dll\0".encode_utf16().collect();
        // SAFETY: path 是以 NUL 结尾的宽字符串。
        let library = unsafe { LoadLibraryW(path.as_ptr()) };
        if library.is_null() {
            // nvml.dll 也可能在 System32 之外；LoadLibraryW 已按 PATH 搜索过，失败即没有
            return None;
        }

        // 优先 v2 导出（新版驱动都是它），老驱动退到 v1 名字
        let init_name = if symbol(library, "nvmlInit_v2").is_some() {
            "nvmlInit_v2"
        } else {
            "nvmlInit"
        };
        let count_name = if symbol(library, "nvmlDeviceGetCount_v2").is_some() {
            "nvmlDeviceGetCount_v2"
        } else {
            "nvmlDeviceGetCount"
        };
        let handle_name = if symbol(library, "nvmlDeviceGetHandleByIndex_v2").is_some() {
            "nvmlDeviceGetHandleByIndex_v2"
        } else {
            "nvmlDeviceGetHandleByIndex"
        };

        unsafe {
            let init: unsafe extern "C" fn() -> i32 =
                core::mem::transmute(symbol(library, init_name)?);
            if init() != NVML_SUCCESS {
                return None;
            }
            Some(Api {
                device_count: core::mem::transmute(symbol(library, count_name)?),
                handle_by_index: core::mem::transmute(symbol(library, handle_name)?),
                name: core::mem::transmute(symbol(library, "nvmlDeviceGetName")?),
                utilization: core::mem::transmute(symbol(library, "nvmlDeviceGetUtilizationRates")?),
                memory: core::mem::transmute(symbol(library, "nvmlDeviceGetMemoryInfo")?),
                temperature: core::mem::transmute(symbol(library, "nvmlDeviceGetTemperature")?),
                power: core::mem::transmute(symbol(library, "nvmlDeviceGetPowerUsage")?),
                power_limit: core::mem::transmute(symbol(library, "nvmlDeviceGetEnforcedPowerLimit")?),
                pcie_throughput: symbol(library, "nvmlDeviceGetPcieThroughput")
                    .or_else(|| symbol(library, "nvmlDeviceGetPcieThroughput_v2"))
                    .map(|address| core::mem::transmute(address)),
                pcie_link_gen: symbol(library, "nvmlDeviceGetCurrPcieLinkGeneration")
                    .map(|address| core::mem::transmute(address)),
                pcie_link_width: symbol(library, "nvmlDeviceGetCurrPcieLinkWidth")
                    .map(|address| core::mem::transmute(address)),
            })
        }
    }

    fn api() -> Option<&'static Api> {
        static API: std::sync::OnceLock<Option<Api>> = std::sync::OnceLock::new();
        API.get_or_init(load).as_ref()
    }

    /// 读所有 N 卡。返回 `None` 表示「NVML 用不了」，`Some(vec![])` 表示「能用但一张卡都没有」。
    pub fn read() -> Option<Vec<GpuSample>> {
        let api = api()?;
        unsafe {
            let mut count: u32 = 0;
            if (api.device_count)(&mut count) != NVML_SUCCESS {
                return None;
            }
            let mut out = Vec::with_capacity(count as usize);
            for index in 0..count {
                let mut device: Device = core::ptr::null_mut();
                if (api.handle_by_index)(index, &mut device) != NVML_SUCCESS {
                    continue;
                }

                let mut name = [0i8; NAME_LEN];
                let name = if (api.name)(device, name.as_mut_ptr(), NAME_LEN as u32) == NVML_SUCCESS {
                    let bytes: Vec<u8> = name
                        .iter()
                        .take_while(|byte| **byte != 0)
                        .map(|byte| *byte as u8)
                        .collect();
                    String::from_utf8_lossy(&bytes).to_string()
                } else {
                    format!("GPU {index}")
                };

                let mut utilization = Utilization::default();
                let has_util = (api.utilization)(device, &mut utilization) == NVML_SUCCESS;

                let mut memory = MemoryInfo::default();
                let has_memory = (api.memory)(device, &mut memory) == NVML_SUCCESS;

                let mut temperature: u32 = 0;
                let has_temp =
                    (api.temperature)(device, TEMPERATURE_GPU, &mut temperature) == NVML_SUCCESS;

                // NVML 的功耗单位是毫瓦
                let mut power: u32 = 0;
                let has_power = (api.power)(device, &mut power) == NVML_SUCCESS;
                let mut limit: u32 = 0;
                let has_limit = (api.power_limit)(device, &mut limit) == NVML_SUCCESS;

                // PCIe 吞吐：0 = TX，1 = RX，单位 KB/s（`telemetry.py:104-107` 同一套口径）。
                let pcie = |counter: u32| -> Option<f64> {
                    let read = api.pcie_throughput?;
                    let mut value: u32 = 0;
                    (read)(device, counter, &mut value)
                        .eq(&NVML_SUCCESS)
                        .then(|| f64::from(value) / 1024.0)
                };

                // 链路代数/宽度：同样缺符号就 None，不影响吞吐读数。
                let link = |read: &Option<unsafe extern "C" fn(Device, *mut u32) -> i32>| -> Option<u32> {
                    let call = read.as_ref()?;
                    let mut value: u32 = 0;
                    call(device, &mut value).eq(&NVML_SUCCESS).then_some(value)
                };

                out.push(GpuSample {
                    name,
                    utilization: has_util.then_some(utilization.gpu),
                    mem_used_mib: has_memory.then(|| memory.used / (1024 * 1024)),
                    mem_total_mib: has_memory.then(|| memory.total / (1024 * 1024)),
                    temperature: has_temp.then_some(temperature),
                    // 空闲时个别驱动会吐异常大的值（用户 m06061 第 1 点看到「1 万多」），
                    // 超过功耗上限两倍、或超过 5000 W，都当读不到 —— 宁可不显示，也不显示荒谬数字。
                    power_w: has_power
                        .then(|| f64::from(power) / 1000.0)
                        .filter(|watts| {
                            *watts >= 0.0
                                && *watts < 5000.0
                                && (!has_limit || *watts <= f64::from(limit) / 1000.0 * 2.0)
                        }),
                    power_limit_w: has_limit.then(|| f64::from(limit) / 1000.0),
                    pcie_rx_mb: pcie(1),
                    pcie_tx_mb: pcie(0),
                    pcie_link_gen: link(&api.pcie_link_gen),
                    pcie_link_width: link(&api.pcie_link_width),
                });
            }
            Some(out)
        }
    }
}

/// macOS 的 Metal 分支：Strata 用 IOKit 的 `working set` 估算当前进程显存。
/// 本工程只发 Windows 版，这里留空实现，免得把 IOKit 绑定拖进依赖。
#[cfg(target_os = "macos")]
fn metal_working_set() -> Option<GpuSample> {
    None
}

// ----------------------------------------------------------------- 引擎 HTTP

const HTTP_TIMEOUT: Duration = Duration::from_secs(2);
const HTTP_MAX_BYTES: usize = 4 * 1024 * 1024;

/// 手写 HTTP/1.0 GET，打到本机端口。
///
/// 用 HTTP/1.0 而不是 1.1：不需要处理 keep-alive 分块边界，服务端直接回完就关连接。
/// llama.cpp 的 `httplib` 对 1.0 请求会带 `Content-Length` 或 `Transfer-Encoding: chunked`，
/// 两种都在下面处理。
pub fn http_get(port: u16, path: &str, api_key: Option<&str>) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|err| format!("连不上 127.0.0.1:{port}：{err}"))?;
    stream
        .set_read_timeout(Some(HTTP_TIMEOUT))
        .map_err(|err| format!("设置读超时失败：{err}"))?;
    stream
        .set_write_timeout(Some(HTTP_TIMEOUT))
        .map_err(|err| format!("设置写超时失败：{err}"))?;

    let mut request = format!(
        "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\n"
    );
    if let Some(key) = api_key.map(str::trim).filter(|key| !key.is_empty()) {
        request.push_str(&format!("Authorization: Bearer {key}\r\n"));
    }
    request.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|err| format!("发送请求失败：{err}"))?;

    let mut raw = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                raw.extend_from_slice(&buffer[..read]);
                if raw.len() > HTTP_MAX_BYTES {
                    return Err("响应体过大".to_string());
                }
            }
            Err(err) => return Err(format!("读取响应失败：{err}")),
        }
    }

    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "响应没有头部结束标记".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let body = &raw[split + 4..];

    let status = head
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);
    if status != 200 {
        let tail = String::from_utf8_lossy(body);
        return Err(format!(
            "HTTP {status}：{}",
            tail.chars().take(160).collect::<String>()
        ));
    }

    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let text = if chunked {
        decode_chunked(body)?
    } else {
        body.to_vec()
    };
    Ok(String::from_utf8_lossy(&text).to_string())
}

/// 解 `Transfer-Encoding: chunked`：`<hex 长度>\r\n<数据>\r\n` 循环，`0\r\n` 结束。
fn decode_chunked(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut index = 0usize;
    loop {
        let line_end = body[index..]
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or_else(|| "分块长度行不完整".to_string())?
            + index;
        let header = String::from_utf8_lossy(&body[index..line_end]).to_string();
        let size_text = header.split(';').next().unwrap_or("").trim().to_string();
        if size_text.is_empty() {
            return Err("分块长度为空".to_string());
        }
        let size = usize::from_str_radix(&size_text, 16)
            .map_err(|_| format!("分块长度不是十六进制：{size_text}"))?;
        index = line_end + 2;
        if size == 0 {
            break;
        }
        if index + size > body.len() {
            return Err("分块数据被截断".to_string());
        }
        out.extend_from_slice(&body[index..index + size]);
        index += size + 2; // 跳过数据后的 \r\n
        if index > body.len() {
            break;
        }
    }
    Ok(out)
}

// --------------------------------------------------------------------- 命令

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|item| item.as_millis() as u64)
        .unwrap_or(0)
}

/// 读常驻采集线程的最新快照（`{ now, static, history }`）。不触发额外采样。
#[tauri::command]
pub fn monitor_sample() -> MonitorSnapshot {
    let guard = match store().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    MonitorSnapshot {
        now: guard.now.clone(),
        r#static: guard.r#static.clone(),
        history: MonitorHistory {
            at: guard.at.clone(),
            series: guard.series.clone(),
        },
    }
}

/// 立刻采一次（前端刚启动、采集线程还没跑满一秒时用）。
#[tauri::command]
pub fn monitor_sample_now() -> MonitorSnapshot {
    sample_once();
    monitor_sample()
}

/// 从 Strata 的模型配置里取引擎自己的 `api_key`。
///
/// 为什么不从前往传：密钥只在 Rust 侧，前端拿到的 `has_api_key` 只是个布尔
/// （见 `strata.rs` 的 `#[serde(skip_serializing)]`）。而前门按用户 m06545 的约定
/// **不代客户端补 key**，所以监控这一路必须自己把 key 读出来，否则直连引擎恒 401。
fn strata_api_key(config_path: &str) -> Option<String> {
    let raw = std::fs::read_to_string(config_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("api_key")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

/// 采引擎指标。调用方**必须先确认模型已加载**，否则 `/metrics?model=` 会把模型拉起来。
#[tauri::command]
pub async fn monitor_engine(
    port: u16,
    model: Option<String>,
    api_key: Option<String>,
    config_path: Option<String>,
) -> EngineMetrics {
    // Strata 模型：用配置里的 key 直连引擎自己的端口（用户 m06557）。
    let api_key = config_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .and_then(strata_api_key)
        .or(api_key);
    tauri::async_runtime::spawn_blocking(move || {
        let query = match model
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => format!("/metrics?model={}", url_encode(name)),
            None => "/metrics".to_string(),
        };
        let key = api_key.as_deref();
        let mut result = EngineMetrics::default();
        match http_get(port, &query, key) {
            Ok(text) => {
                // llama.cpp 的 /metrics 默认是 Prometheus 文本（`llamacpp:requests_processing 0`），
                // 个别版本/前门会回 JSON。两种都收，文本解析成结构化字段供监控页直接用。
                let trimmed = text.trim();
                if trimmed.starts_with('{') || trimmed.starts_with('[') {
                    match serde_json::from_str::<serde_json::Value>(trimmed) {
                        Ok(value) => result.metrics = Some(value),
                        Err(err) => result.error = Some(format!("/metrics 不是合法 JSON：{err}")),
                    }
                } else {
                    result.metrics = Some(parse_prometheus(trimmed));
                }
            }
            Err(err) => {
                result.error = Some(format!("/metrics 请求失败：{err}"));
                return result;
            }
        }
        let slots_path = match model
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => format!("/slots?model={}", url_encode(name)),
            None => "/slots".to_string(),
        };
        if let Ok(text) = http_get(port, &slots_path, key) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                result.slots = Some(value);
            }
        }
        result
    })
    .await
    .unwrap_or_default()
}

/// 把 Prometheus 文本解析成监控页直接可用的结构化 JSON。
///
/// llama.cpp 的指标名形如 `llamacpp:requests_processing 0`，冒号在 Prometheus 里是保留字符，
/// 这里原样保留进 `prometheus` 映射，同时把用得到的几个挑成驼峰字段（前端不必再拼名字）。
fn parse_prometheus(text: &str) -> serde_json::Value {
    let mut all = serde_json::Map::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, rest)) = line.rsplit_once(' ') else {
            continue;
        };
        // 带标签的样本形如 `name{a="b"} 1`，标签部分丢掉，只留名字主体。
        let clean = match name.split_once('{') {
            Some((head, _)) => head,
            None => name,
        };
        if let Ok(value) = rest.trim().parse::<f64>() {
            all.insert(clean.to_string(), serde_json::json!(value));
        }
    }
    let pick = |names: &[&str]| -> Option<f64> {
        names.iter().find_map(|name| {
            all.get(*name)
                .and_then(serde_json::Value::as_f64)
                .filter(|value| value.is_finite())
        })
    };
    serde_json::json!({
        "prometheus": all,
        "requestsProcessing": pick(&["llamacpp:requests_processing"]).unwrap_or(0.0),
        "requestsDeferred": pick(&["llamacpp:requests_deferred"]).unwrap_or(0.0),
        "tokensPredicted": pick(&["llamacpp:tokens_predicted_total"]),
        "tokensPredictedSeconds": pick(&["llamacpp:tokens_predicted_seconds_total"]),
        "promptTokens": pick(&["llamacpp:prompt_tokens_total"]),
        "promptSeconds": pick(&["llamacpp:prompt_seconds_total"]),
        // 引擎自报的实时速度（gauge，空闲时归 0）。压测与自带 WebUI 的请求不经过
        // GUI 的聊天 store，本地攒不出速度；但引擎自己知道，监控页拿它兜底。
        "predictedTokS": pick(&["llamacpp:predicted_tokens_seconds"]),
        "promptTokS": pick(&["llamacpp:prompt_tokens_seconds"]),
        "kvCacheTokens": pick(&["llamacpp:kv_cache_tokens", "llamacpp:kv_cache_tokens_total"]),
        "kvCacheUsage": pick(&["llamacpp:kv_cache_usage_ratio"]),
    })
}

/// RFC 3986 保留字符直出，其余 `%XX`。与 `search.rs` 的同名函数口径一致。
fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~' | b':' | b'/');
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒烟：真机上磁盘与 PCIe 到底采不采得到（`cargo test --lib -- --ignored --nocapture`）。
    /// 普通 `cargo test` 不会跑它 —— 它依赖本机有磁盘计数器和 N 卡。
    #[test]
    #[ignore]
    fn disk_and_pcie_probe() {
        let _ = disk::read();
        std::thread::sleep(std::time::Duration::from_millis(1200));
        println!("disk = {:?}", disk::read());
        let gpus = gpu();
        println!(
            "gpus = {:?}",
            gpus.iter()
                .map(|g| (g.name.clone(), g.pcie_rx_mb, g.pcie_tx_mb, g.pcie_link_gen, g.pcie_link_width))
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn prometheus_metrics_are_parsed() {
        let text = "# HELP llamacpp:requests_processing Number of requests processing
# TYPE llamacpp:requests_processing gauge
llamacpp:requests_processing 2
llamacpp:requests_deferred 1
llamacpp:tokens_predicted_total 1234
llamacpp:prompt_tokens_total 5678
llamacpp:kv_cache_usage_ratio 0.25
llamacpp:predicted_tokens_seconds 19.6849
llamacpp:prompt_tokens_seconds 70.6986
";
        let value = parse_prometheus(text);
        assert_eq!(value["requestsProcessing"].as_f64(), Some(2.0));
        assert_eq!(value["requestsDeferred"].as_f64(), Some(1.0));
        assert_eq!(value["tokensPredicted"].as_f64(), Some(1234.0));
        assert_eq!(value["promptTokens"].as_f64(), Some(5678.0));
        assert_eq!(value["kvCacheUsage"].as_f64(), Some(0.25));
        // 引擎自报的实时速度：b11671 实测的 gauge 名（HELP 是 Average ... throughput in tokens/s）
        assert_eq!(value["predictedTokS"].as_f64(), Some(19.6849));
        assert_eq!(value["promptTokS"].as_f64(), Some(70.6986));
    }

    /// 引擎空闲时两个吞吐 gauge 发 0：前端靠「> 0」过滤，所以 0 必须原样读出来，
    /// 不能被当成「这个指标不存在」。
    #[test]
    fn idle_throughput_gauge_keeps_zero() {
        let value = parse_prometheus(
            "llamacpp:predicted_tokens_seconds 0\nllamacpp:prompt_tokens_seconds 0\n",
        );
        assert_eq!(value["predictedTokS"].as_f64(), Some(0.0));
        assert_eq!(value["promptTokS"].as_f64(), Some(0.0));
    }

    /// 没开 `--metrics` 或旧版 llama.cpp 不发这两个 gauge 时，键必须是 null：
    /// 前端的回落链（引擎 gauge → 本地最近一次请求）靠它判断。
    #[test]
    fn missing_throughput_gauge_is_null() {
        let value = parse_prometheus("llamacpp:requests_processing 0\n");
        assert!(value["predictedTokS"].is_null());
        assert!(value["promptTokS"].is_null());
    }

    #[test]
    fn labelled_samples_keep_the_bare_name() {
        let value = parse_prometheus("llamacpp:requests_processing{model=\"a\"} 3\n");
        assert_eq!(value["requestsProcessing"].as_f64(), Some(3.0));
    }

    #[test]
    fn gpu_line_is_parsed() {
        let line = "NVIDIA GeForce RTX 5070 Ti Laptop GPU, 37, 6214, 12227, 58, 42.31, 100.00";
        let gpu = parse_gpu_line(line).expect("应当解析成功");
        assert_eq!(gpu.name, "NVIDIA GeForce RTX 5070 Ti Laptop GPU");
        assert_eq!(gpu.utilization, Some(37));
        assert_eq!(gpu.mem_used_mib, Some(6214));
        assert_eq!(gpu.mem_total_mib, Some(12227));
        assert_eq!(gpu.temperature, Some(58));
        assert_eq!(gpu.power_w, Some(42.31));
        assert_eq!(gpu.power_limit_w, Some(100.0));
    }

    #[test]
    fn gpu_line_keeps_na_as_none() {
        // 笔记本常见：功耗项是 [N/A]
        let line = "NVIDIA GeForce RTX 3050, 12, 1024, 8192, 45, [N/A], [N/A]";
        let gpu = parse_gpu_line(line).expect("应当解析成功");
        assert_eq!(gpu.power_w, None);
        assert_eq!(gpu.power_limit_w, None);
        assert_eq!(gpu.temperature, Some(45));
    }

    #[test]
    fn gpu_line_rejects_short_input() {
        assert!(parse_gpu_line("only-one-field").is_none());
        assert!(parse_gpu_line(", 1, 2, 3").is_none());
    }

    #[test]
    fn aggregate_sums_memory_and_averages_util() {
        let a = GpuSample {
            name: "A".into(),
            utilization: Some(10),
            mem_used_mib: Some(1000),
            mem_total_mib: Some(8000),
            temperature: Some(50),
            power_w: Some(30.0),
            power_limit_w: Some(100.0),
            pcie_rx_mb: Some(12.0),
            pcie_tx_mb: Some(3.0),
            pcie_link_gen: Some(4),
            pcie_link_width: Some(8),
        };
        let mut b = a.clone();
        b.name = "B".into();
        b.utilization = Some(30);
        b.mem_used_mib = Some(2000);
        b.temperature = Some(70);
        b.power_w = Some(50.0);
        let merged = aggregate(&[a, b]).expect("应当有聚合值");
        assert_eq!(merged.utilization, Some(20)); // 平均
        assert_eq!(merged.mem_used_mib, Some(3000)); // 求和
        assert_eq!(merged.temperature, Some(70)); // 取最大
        assert_eq!(merged.power_w, Some(80.0)); // 求和
        assert_eq!(merged.pcie_rx_mb, Some(24.0)); // PCIe 吞吐求和
    }

    #[test]
    fn aggregate_single_card_is_identity() {
        let one = GpuSample {
            name: "A".into(),
            utilization: Some(10),
            mem_used_mib: Some(1000),
            mem_total_mib: Some(8000),
            temperature: Some(50),
            power_w: Some(30.0),
            power_limit_w: Some(100.0),
            pcie_rx_mb: Some(12.0),
            pcie_tx_mb: Some(3.0),
            pcie_link_gen: Some(4),
            pcie_link_width: Some(8),
        };
        let merged = aggregate(&[one.clone()]).expect("应当有聚合值");
        assert_eq!(merged.utilization, one.utilization);
        assert_eq!(merged.mem_used_mib, one.mem_used_mib);
        assert!(aggregate(&[]).is_none());
    }

    #[test]
    fn chunked_body_is_decoded() {
        let body = b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(body).unwrap(), b"Wikipedia".to_vec());
    }

    #[test]
    fn chunked_body_handles_extension() {
        let body = b"3;foo=bar\r\nabc\r\n0\r\n";
        assert_eq!(decode_chunked(body).unwrap(), b"abc".to_vec());
    }

    #[test]
    fn url_encode_keeps_reserved_characters() {
        assert_eq!(url_encode("a b/c"), "a%20b/c");
        assert_eq!(url_encode("模型"), "%E6%A8%A1%E5%9E%8B");
    }

    #[test]
    fn history_is_capped() {
        // 采样 3 次后环形缓冲只增不减（未超上限），且序列等长
        for _ in 0..3 {
            sample_once();
        }
        let snapshot = monitor_sample();
        assert_eq!(snapshot.history.at.len(), snapshot.history.series.get("cpu").map_or(0, Vec::len));
        assert!(snapshot.history.at.len() <= HISTORY_POINTS);
    }

    #[test]
    fn gpu_reads_are_sane_when_a_card_exists() {
        // 没卡（CI / 集显机器）时只要求不 panic；有卡时检查基本自洽
        let gpus = gpu();
        println!("gpu 读数（--nocapture 可见）：{:?}", gpus);
        for card in &gpus {
            assert!(!card.name.is_empty(), "显卡名字不该为空");
            if let (Some(used), Some(total)) = (card.mem_used_mib, card.mem_total_mib) {
                assert!(total > 0, "显存总量应当大于 0");
                assert!(used <= total * 2, "显存占用明显超出总量，多半是单位错了");
            }
            if let Some(util) = card.utilization {
                assert!(util <= 100, "利用率不可能超过 100%");
            }
        }
    }

    #[test]
    fn memory_is_readable() {
        if cfg!(windows) {
            let (used, total) = memory().expect("读不到物理内存");
            assert!(total > 0);
            assert!(used <= total);
        }
    }
}
