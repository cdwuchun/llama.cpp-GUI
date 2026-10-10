//! router（`llama-server` 的 router mode）进程生命周期：命令行组装、子进程环境注入、
//! 启动/停止、崩溃监测、日志采集。
//!
//! 两条实测结论直接决定了这里的实现（方案 §4.5、§4.6）：
//! - **环境注入**：Windows 的 DLL 搜索不递归，共享 CUDA 目录必须【直接】在 `PATH` 上；
//!   注入会被 router 与它 spawn 的模型子实例逐级继承。
//! - **日志分流**：模型子实例的 stdout/stderr 会合并进 router 的同一个流，行首带 `[<端口>]`。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::gpu;
use crate::settings::Settings;
use crate::versions::{compose_path_env, LlamaCppVersion};
use crate::winfix;

/// 日志环形缓冲上限（与前端一致，见方案 §6.5）。
pub const LOG_BUFFER_CAP: usize = 10_000;
/// 批量推送阈值：行数。
const LOG_BATCH_LINES: usize = 50;
/// 批量推送阈值：时间。
const LOG_BATCH_INTERVAL: Duration = Duration::from_millis(100);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// router 状态（前端状态条的数据源）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterStatus {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
    pub version: Option<String>,
    pub version_dir: Option<PathBuf>,
    pub started_at_ms: Option<u64>,
    pub last_error: Option<String>,
    /// 因原目录含非 ASCII 字符而改用 ASCII 链接目录时的原始路径。
    pub ascii_fixed_from: Option<PathBuf>,
}

impl Default for RouterStatus {
    fn default() -> Self {
        Self {
            running: false,
            port: 8080,
            pid: None,
            version: None,
            version_dir: None,
            started_at_ms: None,
            last_error: None,
            ascii_fixed_from: None,
        }
    }
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

/// 日志中枢：环形缓冲 + 序列号。
pub struct LogHub {
    buffer: Mutex<VecDeque<LogLine>>,
    seq: AtomicU64,
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
        }
    }

    pub fn push(&self, source: &str, text: String) -> LogLine {
        let line = LogLine {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            source: source.to_string(),
            ts_ms: now_ms(),
            text,
        };
        let mut buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        if buf.len() >= LOG_BUFFER_CAP {
            buf.pop_front();
        }
        buf.push_back(line.clone());
        line
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

/// 正在运行的 router 进程。
///
/// 部分字段当前只用于诊断（对外状态由 [`RouterStatus`] 承载），保留以便后续阶段使用。
#[allow(dead_code)]
pub struct RouterProcess {
    pub child: Child,
    pub port: u16,
    pub version_name: String,
    pub version_dir: PathBuf,
    pub started_at_ms: u64,
    pub ascii_fixed_from: Option<PathBuf>,
}

/// 组装 router 的命令行参数。
///
/// 组装 router 命令行。
///
/// `port` 必须由调用方传入**实际要用的端口**（可能已因占用而顺延），不要再从
/// `settings.port` 取 —— 之前这里读 settings，导致顺延只改了状态、命令行仍绑旧端口。
///
/// 注意：**GPU 参数默认不传**（`devices` 为空、`gpu` 为默认值时），把多卡分配交给原生 `--fit`。
pub fn build_router_args(
    settings: &Settings,
    preset_path: &Path,
    resolved_devices: &[String],
    port: u16,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--models-preset".into(),
        preset_path.to_string_lossy().to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string(),
        // 刻意**不传** --no-ui：router 会把自身的参数下发给子实例，
        // 传了它，每个模型的 llama.cpp 自带聊天界面也会被一起关掉，
        // 而「开始聊天」要打开的正是那个界面（http://127.0.0.1:<子实例端口>/）。
    ];

    // 4 是 llama.cpp 的默认值，非默认时才显式传
    if settings.models_max != 4 {
        args.push("--models-max".into());
        args.push(settings.models_max.to_string());
    }

    // 空闲释放模型。这是 common 参数，router 会给**每个子实例**都带上 ——
    // 正好就是"对所有模型生效的空闲超时"。llama.cpp 的语义是连模型权重一起释放
    // （server-context.cpp 的 destroy()：模型、context、mmproj、草稿模型全放掉），
    // 下一次请求到来时自动重新加载。
    if settings.sleep_idle_seconds > 0 {
        args.push("--sleep-idle-seconds".into());
        args.push(settings.sleep_idle_seconds.to_string());
    }

    if let Some(key) = settings.api_key.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        args.push("--api-key".into());
        args.push(key.to_string());
    }

    args.extend(gpu::build_gpu_args(&settings.gpu, resolved_devices));
    args
}

/// 确保 preset 文件存在（P3 起由模型扫描填充内容）。
pub fn ensure_preset_file(path: &Path) -> Result<()> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("创建配置目录失败: {}", parent.display()))?;
        }
        std::fs::write(path, "version = 1\n").context("写入初始 presets.ini 失败")?;
    }
    Ok(())
}

/// 判断某一行日志属于 router 自身还是某个模型子实例。
///
/// 上游转发子实例日志用的是 `LOG("[%5d] %s", port, …)`（`%5d` 右对齐），
/// 端口不足 5 位时会渲染成 `[ 8081]` —— 所以这里必须先 `trim()` 再判数字，
/// 否则那类子实例的日志会整体被归到「系统」。
pub fn classify_log_source(line: &str) -> String {
    if let Some(rest) = line.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let port = rest[..end].trim();
            if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
                return format!("model:{port}");
            }
        }
    }
    "system".to_string()
}

/// 启动 router。返回进程句柄与状态。
pub fn spawn_router(
    app: &AppHandle,
    hub: Arc<LogHub>,
    settings: &Settings,
    version: &LlamaCppVersion,
    preset_path: &Path,
    link_root: &Path,
    resolved_devices: &[String],
) -> Result<(RouterProcess, RouterStatus)> {
    ensure_preset_file(preset_path)?;

    // 1) 非 ASCII 路径修复（否则 router 无法 spawn 模型子实例）
    let ascii_dir = winfix::ensure_ascii_dir(&version.dir, link_root)?;
    let ascii_fixed_from = (ascii_dir != version.dir).then(|| version.dir.clone());

    // 2) 端口：被占用时自动顺延，实际端口写回状态（前端显示真实端口）
    let port = if winfix::port_in_use(settings.port) {
        winfix::find_free_port(settings.port)
            .with_context(|| format!("端口 {} 已被占用，且附近未找到可用端口", settings.port))?
    } else {
        settings.port
    };

    // 3) 命令行与环境（版本目录换成 ASCII 链接目录，但共享库目录不变）
    let args = build_router_args(settings, preset_path, resolved_devices, port);
    let env_version = LlamaCppVersion {
        dir: ascii_dir.clone(),
        ..version.clone()
    };

    let server_bin = ascii_dir.join(if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    });

    let mut cmd = Command::new(&server_bin);
    cmd.args(&args);
    cmd.current_dir(&ascii_dir);
    cmd.env("PATH", compose_path_env(&env_version, std::env::var_os("PATH")));
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    crate::winfix::hide_console(&mut cmd);

    hub.push(
        "system",
        format!(
            "[gui] 启动 {} 参数: {}",
            server_bin.display(),
            redact_args(&args).join(" ")
        ),
    );
    if let Some(original) = &ascii_fixed_from {
        hub.push(
            "system",
            format!(
                "[gui] 原路径含非 ASCII 字符（{}），已改用 ASCII 链接目录: {}",
                original.display(),
                ascii_dir.display()
            ),
        );
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("启动 llama-server 失败: {}", server_bin.display()))?;

    let pid = child.id();
    let started_at_ms = now_ms();

    // 3.5) **先接上日志读取，再等端口就绪**。
    //
    // 顺序很关键：stdout/stderr 是 piped 的，管道缓冲只有几 KB（Windows 匿名管道约 4KB），
    // 若等在就绪轮询之后才去读，启动阶段输出一多子进程就会阻塞在 write 上、永远不监听端口，
    // 最终只能超时失败（实测 3 个模型的 stderr 就有 3.6KB）。
    let (tx, rx) = mpsc::channel::<LogLine>();
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(stdout, Arc::clone(&hub), tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(stderr, Arc::clone(&hub), tx.clone());
    }
    drop(tx);
    spawn_pump(app.clone(), Arc::clone(&hub), rx);

    // 3.6) 等端口真正可连接再返回。
    // 之前这里立刻返回 running，前端紧接着 fetch /models 时 router 的 HTTP 监听
    // 可能还没绑上，表现为「读取 router 模型列表失败」（Failed to fetch）。
    // 同时用 try_wait 看进程有没有秒退，把原因报给界面。
    // 任何失败分支都必须**先杀掉子进程**：std 的 Child 析构不会杀进程，而此刻句柄
    // 还没进 router_slot，界面将再也停不掉它（孤儿 llama-server 会一直占端口和显存）。
    let ready_deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            break;
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                let msg = format!(
                    "router 启动后立刻退出（退出码 {:?}），请看日志（若端口被占用，日志里会有 bind 失败）",
                    exit.code()
                );
                hub.push("system", format!("[gui] {msg}"));
                anyhow::bail!(msg);
            }
            Ok(None) => {}
            Err(err) => {
                force_kill_tree(pid, &mut child);
                anyhow::bail!("等待 router 启动失败: {err}");
            }
        }
        if std::time::Instant::now() >= ready_deadline {
            let msg = format!("router 在 20 秒内没有监听 {port} 端口，请看日志");
            hub.push("system", format!("[gui] {msg}"));
            force_kill_tree(pid, &mut child);
            anyhow::bail!(msg);
        }
        thread::sleep(Duration::from_millis(120));
    }
    hub.push("system", format!("[gui] router 已在 127.0.0.1:{port} 就绪"));

    let status = RouterStatus {
        running: true,
        port,
        pid: Some(pid),
        version: Some(version.name.clone()),
        version_dir: Some(ascii_dir.clone()),
        started_at_ms: Some(started_at_ms),
        last_error: None,
        ascii_fixed_from: ascii_fixed_from.clone(),
    };

    let process = RouterProcess {
        child,
        port,
        version_name: version.name.clone(),
        version_dir: ascii_dir,
        started_at_ms,
        ascii_fixed_from,
    };

    Ok((process, status))
}

pub(crate) fn spawn_reader<R: Read + Send + 'static>(stream: R, hub: Arc<LogHub>, tx: Sender<LogLine>) {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.split(b'\n') {
            let Ok(bytes) = line else { break };
            let text = String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_string();
            if text.is_empty() {
                continue;
            }
            let source = classify_log_source(&text);
            let entry = hub.push(&source, text);
            if tx.send(entry).is_err() {
                break;
            }
        }
    });
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

/// 监测 router 是否退出；退出时更新状态并推送事件。
///
/// 只监测**自己启动时看到的那个 pid**：stop→start 间隔很短时，旧的监测线程会看到
/// slot 里换了新进程，这时必须直接退出，否则线程会随重启次数累积，还可能把新进程
/// 当成"已退出"处理掉。
pub fn spawn_monitor(
    app: AppHandle,
    slot: Arc<Mutex<Option<RouterProcess>>>,
    status: Arc<Mutex<RouterStatus>>,
) {
    thread::spawn(move || {
        let mut watched_pid: Option<u32> = None;
        loop {
            thread::sleep(Duration::from_millis(500));

            let exited = {
                let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                let Some(process) = guard.as_mut() else {
                    return; // 已被 stop() 取走，监测结束
                };
                let pid = process.child.id();
                match watched_pid {
                    None => watched_pid = Some(pid),
                    Some(known) if known == pid => {}
                    // slot 里已经是另一个进程（重启过），本线程功成身退
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
                    st.last_error = Some(match code {
                        Some(c) => format!("router 已退出（退出码 {c}）"),
                        None => "router 已退出".to_string(),
                    });
                    st.clone()
                };
                let _ = app.emit("router://status", snapshot.clone());
                crate::tray::sync_tooltip(&app, false, snapshot.port);
                return;
            }
        }
    });
}

/// 强杀进程树（`taskkill /T /F`）。router 正常退出时会自己收掉模型子实例，
/// 卡住时只能靠它；也用于启动失败时清理还没登记的孤儿进程。
pub fn force_kill_tree(pid: u32, child: &mut std::process::Child) {
    let _ = child.kill();
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = crate::winfix::hide_console(&mut kill).status();
    }
}

/// 日志里给 `--api-key` 打码：启动参数会整条推送到前端日志页，明文密钥不该进去。
pub(crate) fn redact_args(args: &[String]) -> Vec<String> {
    let mut out = args.to_vec();
    if let Some(pos) = out.iter().position(|a| a == "--api-key") {
        if pos + 1 < out.len() {
            out[pos + 1] = "***".to_string();
        }
    }
    out
}

/// 停止 router。实测确认：强杀父进程后，模型子实例会随之自动退出（不会残留占显存）。
pub fn stop_router(slot: &Arc<Mutex<Option<RouterProcess>>>) -> Option<u32> {
    let mut process = slot.lock().unwrap_or_else(|e| e.into_inner()).take()?;
    let pid = process.child.id();
    let _ = process.child.kill();

    // 不能直接 wait()：kill 若失败（权限等），wait() 会无限阻塞，
    // 界面上就表现为"router 停不了"、一直转圈。这里改为限时轮询。
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match process.child.try_wait() {
            Ok(Some(_)) => return Some(pid),
            Ok(None) if std::time::Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(100));
            }
            // 超时或出错 → 走兜底强杀
            _ => break,
        }
    }

    force_kill_tree(pid, &mut process.child);
    // 这里**不再** wait()：万一强杀也没成功，wait() 又会把界面挂住。
    // 弃掉 Child 句柄即可（Windows 上 drop 不会阻塞，也不会误杀）。
    Some(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{Settings, SettingsPatch};
    use std::fs;

    /// 端口顺延后命令行必须跟着变：之前这里读 settings.port，导致「自动顺延」从未生效
    #[test]
    fn forwarded_port_wins_over_settings_port() {
        let mut settings = Settings::default();
        settings.port = 8080; // 用户配置的端口已被占用，调用方顺延到了 8081

        let args = build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], 8081);
        let joined = args.join(" ");
        assert!(joined.contains("--port 8081"), "应使用实际端口: {joined}");
        assert!(!joined.contains("--port 8080"), "不能再用配置里的旧端口: {joined}");
    }

    /// API Key 明文不能进日志
    #[test]
    fn api_key_is_redacted_in_logged_args() {
        let mut settings = Settings::default();
        settings.api_key = Some("sk-secret-value".into());
        let args = build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], 8080);

        assert!(args.join(" ").contains("sk-secret-value"), "命令行本身要带 key");
        let redacted = redact_args(&args).join(" ");
        assert!(redacted.contains("--api-key ***"), "{redacted}");
        assert!(!redacted.contains("sk-secret-value"), "日志里不能出现明文: {redacted}");
    }

    /// 清空 API Key 后命令行里就不能再有 `--api-key`。
    ///
    /// 漏掉的话后果很隐蔽：router 仍要求鉴权，而界面按"没有 key"去请求，
    /// 所有端点都变成 401 —— 表现成"模型列表读不出来、模型也加载不了"。
    /// 设置页清空后保存的是空串，老配置里也可能是只剩空格的脏值。
    #[test]
    fn cleared_api_key_leaves_no_flag() {
        for key in [None, Some(String::new()), Some("   ".to_string())] {
            let mut settings = Settings::default();
            settings.api_key = key.clone();
            let joined =
                build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], 8080).join(" ");
            assert!(
                !joined.contains("--api-key"),
                "api_key={key:?} 不该产生 --api-key：{joined}"
            );
        }
    }

    /// 空闲释放模型：只有 > 0 才传 `--sleep-idle-seconds`。
    ///
    /// llama.cpp 的默认就是 -1（不释放），传 0 也没有意义，两者都不该出现在命令行里。
    #[test]
    fn sleep_idle_seconds_only_when_enabled() {
        let mut settings = Settings::default();
        assert_eq!(settings.sleep_idle_seconds, -1, "默认必须是关闭");

        let off = build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], 8080).join(" ");
        assert!(!off.contains("--sleep-idle-seconds"), "{off}");

        settings.sleep_idle_seconds = 0;
        let zero = build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], 8080).join(" ");
        assert!(!zero.contains("--sleep-idle-seconds"), "{zero}");

        settings.sleep_idle_seconds = 300;
        let on = build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], 8080).join(" ");
        assert!(on.contains("--sleep-idle-seconds 300"), "{on}");
    }

    /// 子实例日志前缀是 `[%5d]`，4 位端口会带前导空格，分流不能因此失效
    #[test]
    fn log_source_handles_padded_ports() {
        assert_eq!(classify_log_source("[ 8081] model loaded"), "model:8081");
        assert_eq!(classify_log_source("[62910] model loaded"), "model:62910");
        assert_eq!(classify_log_source("[gui] starting"), "system");
        assert_eq!(classify_log_source("no prefix here"), "system");
    }

    #[test]
    fn default_args_do_not_touch_gpu() {
        let settings = Settings::default();
        let args = build_router_args(&settings, Path::new("C:/app/presets.ini"), &[], settings.port);
        let joined = args.join(" ");
        assert!(joined.contains("--models-preset C:/app/presets.ini"));
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--port 8080"));
        // 不能传 --no-ui：会连带关掉子实例的 llama.cpp 自带聊天界面
        assert!(!joined.contains("--no-ui"));
        // 默认不得出现任何 GPU 参数，否则多卡自动分配会被关掉
        for flag in [
            "--device",
            "--split-mode",
            "--tensor-split",
            "--main-gpu",
            "--fit",
            "--n-gpu-layers",
        ] {
            assert!(!joined.contains(flag), "unexpected {flag} in: {joined}");
        }
        // models-max 默认 4 不显式传
        assert!(!joined.contains("--models-max"));
    }

    #[test]
    fn explicit_multi_gpu_args_are_forwarded() {
        let mut settings = Settings::default();
        settings.port = 9100;
        settings.models_max = 2;
        settings.api_key = Some("sk-test".into());
        settings.gpu.devices = vec!["CUDA0".into(), "CUDA1".into()];
        settings.gpu.n_gpu_layers = Some("all".into());

        let args = build_router_args(&settings, Path::new("C:/app/presets.ini"), &["CUDA0".into(), "CUDA1".into()], settings.port);
        let joined = args.join(" ");
        assert!(joined.contains("--port 9100"));
        assert!(joined.contains("--models-max 2"));
        assert!(joined.contains("--api-key sk-test"));
        assert!(joined.contains("--device CUDA0,CUDA1"));
        assert!(joined.contains("--n-gpu-layers all"));
    }

    #[test]
    fn log_source_classification() {
        // 实测：模型子实例的行带 [端口] 前缀，router 自身的行没有
        assert_eq!(
            classify_log_source("[63893] 0.00.867.786 I srv load_model: loading model 'x.gguf'"),
            "model:63893"
        );
        assert_eq!(
            classify_log_source("0.00.532.398 I srv llama_server: listening on http://127.0.0.1:18081"),
            "system"
        );
        assert_eq!(classify_log_source("[not-a-port] hello"), "system");
    }

    #[test]
    fn log_hub_ring_buffer_and_snapshot() {
        let hub = LogHub::new();
        for i in 0..20 {
            hub.push("system", format!("line {i}"));
        }
        let snap = hub.snapshot(5);
        assert_eq!(snap.len(), 5);
        assert_eq!(snap[4].text, "line 19");
        assert_eq!(snap[4].seq, 19);
        hub.clear();
        assert!(hub.snapshot(10).is_empty());
    }

    #[test]
    fn preset_file_is_created_minimal() {
        let dir = std::env::temp_dir().join("llamacpp-gui-preset-test");
        let _ = fs::remove_dir_all(&dir);
        let preset = dir.join("presets.ini");
        ensure_preset_file(&preset).unwrap();
        assert_eq!(fs::read_to_string(&preset).unwrap().trim(), "version = 1");
        // 已存在时不覆盖
        fs::write(&preset, "version = 1\n[model-a]\nmodel = x.gguf\n").unwrap();
        ensure_preset_file(&preset).unwrap();
        assert!(fs::read_to_string(&preset).unwrap().contains("[model-a]"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stop_without_process_is_noop() {
        let slot: Arc<Mutex<Option<RouterProcess>>> = Arc::new(Mutex::new(None));
        assert!(stop_router(&slot).is_none());
    }

    #[test]
    fn settings_patch_used_by_commands_roundtrips() {
        let dir = std::env::temp_dir().join("llamacpp-gui-router-settings-test");
        let _ = fs::remove_dir_all(&dir);
        let store = crate::settings::SettingsStore::load(dir.join("settings.json"));
        let updated = store.patch(SettingsPatch {
            port: Some(8123),
            ..Default::default()
        });
        assert_eq!(updated.port, 8123);
        let _ = fs::remove_dir_all(&dir);
    }
}
