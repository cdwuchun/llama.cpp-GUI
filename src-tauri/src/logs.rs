//! 日志缓冲与批量推送、进程清理工具（原 `router` 模块）。
//!
//! 它以前管 `llama-server` 的 router mode：命令行组装、子进程环境注入、启动/停止、
//! 崩溃监测。router 退役（P1 前门落地）后这些全部删掉了，只剩两样被
//! scheduler / strata / state 复用的东西：
//! - `LogHub` / `LogLine`：子实例日志的环形缓冲与批量事件推送；
//! - `force_kill_tree` / `redact_args`：强杀进程树、启动参数打码。
//!
//! 两条实测结论仍然成立（方案 §4.5、§4.6）：
//! - **环境注入**：Windows 的 DLL 搜索不递归，共享 CUDA 目录必须【直接】在 `PATH` 上；
//!   注入由子进程逐级继承（现在由 scheduler / strata 各自组装）。
//! - **日志分流**：从前靠行首 `[<端口>]` 区分模型子实例（router 才能给出的信息）；
//!   前门化后改用 `model:<模型名>`，见 `scheduler.rs`。

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// 日志环形缓冲上限（与前端一致，见方案 §6.5）。
pub const LOG_BUFFER_CAP: usize = 10_000;
/// 批量推送阈值：行数。
const LOG_BATCH_LINES: usize = 50;
/// 批量推送阈值：时间。
const LOG_BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// 单个日志卷的大小上限：写满就换下一卷（`-2`、`-3`…）。
const LOG_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 日志目录里保留的文件数：超出的按文件名（即时间）从旧到新删。
const LOG_FILE_KEEP: usize = 12;

/// 全局日志句柄。
///
/// 前门（`strata_proxy`）和调度器里的诊断函数拿不到 `AppState`，却都必须能留下痕迹 ——
/// 这次排查「前门连得上但不回包」时最缺的就是它们内部的记录（用户 m05816）。
/// 启动时由 `lib.rs` 注册一次。
static GLOBAL: OnceLock<Arc<LogHub>> = OnceLock::new();

/// 注册全局句柄（重复调用只有第一次生效）。
pub fn register_global(hub: Arc<LogHub>) {
    let _ = GLOBAL.set(hub);
}

/// 取全局句柄；未注册（单元测试、极早期）时为 `None`。
pub fn global() -> Option<&'static Arc<LogHub>> {
    GLOBAL.get()
}

/// 毫秒时间戳 → 本地（东八区）可读时间 `YYYY-MM-DD HH:MM:SS.mmm`。
///
/// 标准库不带时区，`Cargo.toml` 里也没有 chrono / time（不为一个时间戳引依赖），
/// 所以这里固定按 +8 换算，并用 Howard Hinnant 的 `civil_from_days` 把天数还原成年月日。
fn local_stamp(ms: u64) -> String {
    let secs = (ms / 1000) as i64 + 8 * 3600;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    if mo <= 2 {
        y += 1;
    }
    let msec = ms % 1000;
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}.{msec:03}")
}

/// 文件名用的时间戳 `YYYYMMDD-HHMMSS`。
fn stamp_name(ms: u64) -> String {
    let full = local_stamp(ms);
    let (date, rest) = full.split_once(' ').unwrap_or(("0000-00-00", "00:00:00"));
    let d: String = date.chars().filter(|c| *c != '-').collect();
    let t: String = rest.chars().filter(|c| *c != ':').collect();
    let t = &t[..t.len().min(6)];
    format!("{d}-{t}")
}

/// 只留最近的 `keep` 个 `gui-*.log`（文件名里的时间戳就是排序键）。
fn prune_logs(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("gui-") && n.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    if names.len() <= keep {
        return;
    }
    names.sort();
    let drop_n = names.len() - keep;
    for path in names.into_iter().take(drop_n) {
        let _ = std::fs::remove_file(path);
    }
}

/// 日志落盘：一次运行一个文件 `<配置目录>\logs\gui-<启动时间>.log`，单卷写满就 `-2`、`-3` 续。
struct FileSink {
    file: File,
    dir: PathBuf,
    base: String,
    part: u32,
    size: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 一行日志。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogLine {
    pub seq: u64,
    /// `system`（router 自身）或 `model:<端口>`（模型子实例，P3 起映射为模型 id）。
    pub source: String,
    pub ts_ms: u64,
    pub text: String,
}

/// 日志中枢：环形缓冲 + 序列号 + 可选的落盘。
pub struct LogHub {
    buffer: Mutex<VecDeque<LogLine>>,
    seq: AtomicU64,
    /// 落盘句柄；`attach_file` 之前（含单元测试）为 `None`，只进内存。
    sink: Mutex<Option<FileSink>>,
}

impl Default for LogHub {
    fn default() -> Self {
        Self::new()
    }
}

impl LogHub {
    pub fn new() -> Self {
        Self {
            buffer: Mutex::new(VecDeque::with_capacity(256)),
            seq: AtomicU64::new(0),
            sink: Mutex::new(None),
        }
    }

    pub fn push(&self, source: &str, text: String) -> LogLine {
        let line = LogLine {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            source: source.to_string(),
            ts_ms: now_ms(),
            text,
        };
        {
            let mut buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
            if buf.len() >= LOG_BUFFER_CAP {
                buf.pop_front();
            }
            buf.push_back(line.clone());
        }
        // 落盘放在缓冲锁之外：磁盘慢的时候不能把读日志（快照）的调用一起拖住
        self.write_file(line.ts_ms, &line.source, &line.text);
        line
    }

    /// 只写文件、不进内存缓冲。
    ///
    /// 前门一次请求就有好几行细粒度诊断，全塞进面板会把它刷满（用户 m05885 要的是「能查」，
    /// 不是「刷屏」）；这些行留在文件里，需要时按时间找。
    pub fn push_file_only(&self, source: &str, text: &str) {
        self.write_file(now_ms(), source, text);
    }

    /// 把日志同时落盘到 `<dir>\gui-<本次启动时间>.log`，并清掉过旧的卷。
    ///
    /// 内存环形缓冲一关应用就没了，用户报的现场事后无从查起（用户 m05885）。一次运行一个文件：
    /// 排查「这一次运行里发生了什么」最直观，也天然按运行分片；只保留最近 `LOG_FILE_KEEP` 个。
    pub fn attach_file(&self, dir: PathBuf) {
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let base = format!("gui-{}", stamp_name(now_ms()));
        // 先腾位置：保留数里给即将创建的这一个留一位
        prune_logs(&dir, LOG_FILE_KEEP.saturating_sub(1));
        let path = dir.join(format!("{base}.log"));
        let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else {
            return;
        };
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        self.sink
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(FileSink {
                file,
                dir,
                base,
                part: 1,
                size,
            });
        self.push("system", format!("[日志] 本次运行的日志文件：{}", path.display()));
    }

    /// 当前日志文件的完整路径（日志页展示、打开目录都用它）。
    pub fn file_path(&self) -> Option<PathBuf> {
        let guard = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        let sink = guard.as_ref()?;
        Some(if sink.part > 1 {
            sink.dir.join(format!("{}-{}.log", sink.base, sink.part))
        } else {
            sink.dir.join(format!("{}.log", sink.base))
        })
    }

    /// 内存里现有的行数。
    pub fn len(&self) -> usize {
        self.buffer.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    fn write_file(&self, ts_ms: u64, source: &str, text: &str) {
        let mut guard = self.sink.lock().unwrap_or_else(|e| e.into_inner());
        let Some(sink) = guard.as_mut() else {
            return;
        };
        if sink.size >= LOG_FILE_MAX_BYTES {
            sink.part += 1;
            let path = sink.dir.join(format!("{}-{}.log", sink.base, sink.part));
            match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(file) => {
                    sink.file = file;
                    sink.size = 0;
                    prune_logs(&sink.dir, LOG_FILE_KEEP);
                }
                Err(_) => return,
            }
        }
        // 直接写、不额外 flush：数据交给系统页缓存，进程被强杀也不会丢；文件被缓冲（BufWriter）
        // 才会在崩溃时丢掉最后一段。每行 flush 又太慢。
        let line = format!("{} [{}] {}\n", local_stamp(ts_ms), source, text);
        if sink.file.write_all(line.as_bytes()).is_ok() {
            sink.size += line.len() as u64;
        }
    }

    pub fn snapshot(&self, limit: usize) -> Vec<LogLine> {
        let buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        let skip = buf.len().saturating_sub(limit);
        buf.iter().skip(skip).cloned().collect()
    }

    pub fn clear(&self) {
        self.buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}

pub(crate) fn spawn_pump(app: AppHandle, hub: Arc<LogHub>, rx: mpsc::Receiver<LogLine>) {
    thread::spawn(move || {
        let mut batch: Vec<LogLine> = Vec::with_capacity(LOG_BATCH_LINES);
        loop {
            match rx.recv_timeout(LOG_BATCH_INTERVAL) {
                Ok(line) => {
                    batch.push(line);
                    if batch.len() >= LOG_BATCH_LINES {
                        flush(&app, &mut batch);
                    }
                }
                Err(RecvTimeoutError::Timeout) => flush(&app, &mut batch),
                Err(RecvTimeoutError::Disconnected) => {
                    flush(&app, &mut batch);
                    break;
                }
            }
        }
        let _ = hub;
    });
}

fn flush(app: &AppHandle, batch: &mut Vec<LogLine>) {
    if batch.is_empty() {
        return;
    }
    let payload = std::mem::take(batch);
    let _ = app.emit("logs://lines", payload);
}

/// 强杀进程树（`taskkill /T /F`）。router 正常退出时会自己收掉模型子实例，
/// 卡住时只能靠它；也用于启动失败时清理还没登记的孤儿进程。
///
/// **不等待 `taskkill` 退出**：`/T` 要等整棵进程树死透，被杀的 llama-server 正在释放显存时
/// 可能几十秒不返回。两个调用点都在 scheduler 锁里（前门 `/models/unload`，以及
/// `ensure_ready` 的容量淘汰），等它就把 `/models` 一起挂住 —— 前门从此「能连上但不回包」，
/// 界面上的模型卡片状态再也不会更新（用户 m05816）。上面的 `child.kill()` 已经发了强杀，
/// 进程树清理让 `taskkill` 自己在后台跑完。
pub fn force_kill_tree(pid: u32, child: &mut std::process::Child) {
    let _ = child.kill();
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        crate::winfix::hide_console(&mut kill);
        let _ = kill.spawn();
    }
}

/// 日志里给密钥参数打码：启动参数会整条推送到前端日志页，明文密钥不该进去。
///
/// 认三种形态：`--api-key VALUE`（两段）、`--api-key=VALUE` / `--api_key=VALUE`
/// （单段），以及任何以 `sk-` 开头的 token 兜底（审查发现：原来只认两段式，
/// 写成等号形式时明文密钥会进日志页与 `gui-*.log`）。
pub(crate) fn redact_args(args: &[String]) -> Vec<String> {
    let mut out = args.to_vec();
    for index in 0..out.len() {
        let lower = out[index].to_ascii_lowercase();
        if lower == "--api-key" || lower == "--api_key" {
            if let Some(next) = out.get_mut(index + 1) {
                *next = "***".to_string();
            }
            continue;
        }
        if lower.starts_with("--api-key=") {
            out[index] = "--api-key=***".to_string();
            continue;
        }
        if lower.starts_with("--api_key=") {
            out[index] = "--api_key=***".to_string();
            continue;
        }
        if out[index].starts_with("sk-") {
            out[index] = "***".to_string();
        }
    }
    out
}

