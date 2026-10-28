//! Strata 自身的一键升级（引擎 / 控制器）。
//!
//! **不自己实现下载协议**。控制端已经带了完整的官方升级路径：
//!
//! ```text
//! python strata.py update [--check] [--no-engine|--no-control] \
//!        --components-dir <Strata 根> --output json|jsonl
//! ```
//!
//! 它读 `https://github.com/Niko1221/Strata/releases/latest/download/strata-feed.json`
//! （签名 feed，内置公钥校验）→ 按本机显卡挑包 → 下载 → 校验 sha256 → **试启动** →
//! 通过了才切换，失败保留旧版本；`--check` 只读 feed、不下载。
//!
//! 自己重写这套东西必然踩坑（签名、per-card 包、试启动、旧版保留），所以这里只做三件事：
//! 定位解释器与 `strata.py`、把 `--output jsonl` 的事件流翻译成进度、进程退出时收尾。
//!
//! **目录布局**：`--components-dir <Strata 根>`，于是引擎装进 `<根>\engine\<版本>-<平台>-<后端>`
//! 、控制器装进 `<根>\control\<版本>` —— 与手动解压的安装目录完全一致（用户 m00001）。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::logs::LogHub;

/// 升级范围：与官方 CLI 的开关一一对应。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    /// 引擎 + 控制器（`strata update`）。
    All,
    /// 只升引擎（`--no-control`）。
    Engine,
    /// 只升控制器（`--no-engine`）。
    Control,
}

impl Scope {
    pub fn parse(text: &str) -> Scope {
        match text.trim().to_ascii_lowercase().as_str() {
            "engine" => Scope::Engine,
            "control" => Scope::Control,
            _ => Scope::All,
        }
    }

    fn switches(self) -> &'static [&'static str] {
        match self {
            Scope::All => &[],
            Scope::Engine => &["--no-control"],
            Scope::Control => &["--no-engine"],
        }
    }

    /// 这个范围是否关心某一侧（`--check` 报告里筛掉不管的那一侧）。
    pub fn wants_engine(self) -> bool {
        self != Scope::Control
    }

    pub fn wants_control(self) -> bool {
        self != Scope::Engine
    }
}

/// 一次升级任务的进度快照（前端 1 秒轮询一次）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeSnapshot {
    /// 子进程还在跑
    pub running: bool,
    /// 进程退出码（还在跑时为 None）
    pub exit_code: Option<i32>,
    /// 目前处于哪一阶段（`feed` / `download` / `verify` / `test-start` / `switch` …）
    pub phase: String,
    /// 下载百分比 0–100（非下载阶段保留上一个值）
    pub percent: f32,
    /// 一行状态（给界面直接显示）
    pub message: String,
    /// 正在下载的包名
    pub label: String,
    /// 已下载 / 总字节
    pub done_bytes: u64,
    pub total_bytes: u64,
    /// 结束时控制端给的最终 JSON（含 engine / control 的 installed/offered）
    pub result: Option<serde_json::Value>,
    /// 控制端自报成功（`ok`）
    pub ok: Option<bool>,
    /// 最近几十行输出（排错用）
    pub log_tail: Vec<String>,
}

impl Default for UpgradeSnapshot {
    fn default() -> Self {
        Self {
            running: true,
            exit_code: None,
            phase: "starting".into(),
            percent: 0.0,
            message: "正在启动升级…".into(),
            label: String::new(),
            done_bytes: 0,
            total_bytes: 0,
            result: None,
            ok: None,
            log_tail: Vec::new(),
        }
    }
}

/// 一个在跑的升级任务。
pub struct UpgradeJob {
    child: Child,
    snapshot: Arc<Mutex<UpgradeSnapshot>>,
}

impl UpgradeJob {
    /// 子进程是否还在跑；`try_wait` 顺带回收退出的进程，并把退出码写进快照。
    pub fn running(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                if let Ok(mut snap) = self.snapshot.lock() {
                    snap.running = false;
                    snap.exit_code = status.code();
                    if snap.ok.is_none() {
                        snap.ok = Some(status.success());
                    }
                    if snap.message.is_empty() || status.success() {
                        snap.message = if status.success() {
                            "升级完成".into()
                        } else {
                            format!("升级失败（退出码 {:?}）", status.code())
                        };
                    }
                }
                false
            }
            Ok(None) => true,
            Err(_) => true,
        }
    }

    pub fn snapshot(&mut self) -> UpgradeSnapshot {
        let _ = self.running();
        let mut snap = self
            .snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        if self.snapshot.lock().map(|g| g.running).unwrap_or(false) {
            snap.running = self.child.try_wait().map(|s| s.is_none()).unwrap_or(true);
        }
        snap
    }
}

/// 硬杀整棵进程树（升级会起解压 / 校验子进程，只杀 python 可能留下半截文件）。
pub fn stop(job: &mut UpgradeJob) {
    crate::logs::force_kill_tree(job.child.id(), &mut job.child);
    let _ = job.child.wait();
    if let Ok(mut snap) = job.snapshot.lock() {
        snap.running = false;
        snap.message = "已取消升级".into();
        snap.ok = Some(false);
    }
}

/// 控制端解释器与 `strata.py` 的位置。
fn locate() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let terminal = crate::strata_tune::terminal_dir(&root).ok_or_else(|| {
        "未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）"
            .to_string()
    })?;
    let python = terminal.join("python").join(crate::strata_tune::python_name());
    let script = terminal.join("strata.py");
    if !script.is_file() {
        return Err(format!("控制端缺少 strata.py：{}", script.display()));
    }
    Ok((root, python, script))
}

fn base_command(python: &PathBuf, script: &PathBuf, terminal_cwd: &PathBuf) -> Command {
    let mut cmd = Command::new(python);
    cmd.arg(script)
        .current_dir(terminal_cwd)
        .stdin(Stdio::null());
    crate::winfix::hide_console(&mut cmd);
    cmd
}

/// `strata update --check` 的报告（只读 feed，不下载）。
pub fn check() -> Result<serde_json::Value, String> {
    let (root, python, script) = locate()?;
    let cwd = script
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let output = base_command(&python, &script, &cwd)
        .arg("update")
        .arg("--check")
        .arg("--components-dir")
        .arg(&root)
        .arg("--output")
        .arg("json")
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .output()
        .map_err(|err| format!("启动升级检查失败：{err}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    // 控制端把结果写成一行 JSON；前面可能有提示行，取最后一个 `{` 开头的行。
    let value = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<serde_json::Value>(line.trim()).ok())
        .ok_or_else(|| {
            format!(
                "升级检查没有返回结果（退出码 {:?}）：{}",
                output.status.code(),
                first_lines(&stderr, 6)
            )
        })?;
    if value.get("ok").and_then(|v| v.as_bool()) == Some(false) {
        // 顶层 ok=false 时，原因散在各侧的 `problem` 里（引擎装坏了、feed 验签失败…）
        let mut bits: Vec<String> = Vec::new();
        for side in ["feed", "engine", "control", "app"] {
            if let Some(problem) = value
                .get(side)
                .and_then(|v| v.get("problem"))
                .and_then(|v| v.as_str())
            {
                if !problem.trim().is_empty() {
                    bits.push(format!("{side}: {problem}"));
                }
            }
        }
        if bits.is_empty() {
            let tail = first_lines(&stdout, 4);
            let err = first_lines(&stderr, 4);
            bits.push(format!("{tail} {err}").trim().to_string());
        }
        return Err(format!("升级检查失败：{}", bits.join(" / ")));
    }
    Ok(value)
}

fn first_lines(text: &str, limit: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).take(limit).collect();
    if lines.is_empty() {
        "（没有输出）".into()
    } else {
        lines.join(" / ")
    }
}

/// `--check` 报告里这一侧是否需要升级（`status` 不是 `current`）。
fn side_outdated(report: &serde_json::Value, side: &str) -> bool {
    let status = report
        .get(side)
        .and_then(|v| v.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    !matches!(status, "current" | "not-in-feed")
}

/// 检查报告压成一句话，给界面直接显示。
pub fn describe(report: &serde_json::Value, scope: Scope) -> String {
    let installed = |side: &str| -> String {
        let value = match report.get(side) {
            Some(value) => value,
            None => return "—".to_string(),
        };
        match side {
            "control" => value
                .get("installed")
                .and_then(|v| v.as_str())
                .unwrap_or("—")
                .to_string(),
            _ => value
                .get("installed")
                .and_then(|v| v.get("version"))
                .and_then(|v| v.as_str())
                .unwrap_or("—")
                .to_string(),
        }
    };
    let offered = |side: &str| {
        report
            .get(side)
            .and_then(|v| v.get("offered"))
            .and_then(|v| match side {
                "control" => v.as_str().map(|s| s.to_string()),
                _ => v.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()),
            })
            .unwrap_or_else(|| "—".into())
    };
    let engine_out = scope.wants_engine() && side_outdated(report, "engine");
    let control_out = scope.wants_control() && side_outdated(report, "control");
    let parts: Vec<String> = match (engine_out, control_out) {
        (false, false) => {
            let mut parts = Vec::new();
            if scope.wants_engine() {
                parts.push(format!("引擎 {}", installed("engine")));
            }
            if scope.wants_control() {
                parts.push(format!("控制器 {}", installed("control")));
            }
            return format!("已是最新（{}）", parts.join(" / "));
        }
        (true, false) => vec![format!("引擎 {} → {}", installed("engine"), offered("engine"))],
        (false, true) => vec![format!("控制器 {} → {}", installed("control"), offered("control"))],
        (true, true) => vec![
            format!("引擎 {} → {}", installed("engine"), offered("engine")),
            format!("控制器 {} → {}", installed("control"), offered("control")),
        ],
    };
    parts.join(" / ")
}

/// 起一个升级进程。**先跑一次 `--check`**：没有新版本就不下载（几百 MB 的包不该白拉）。
///
/// 返回 `(是否有需要下载的东西, 一句话说明)`；`true` 时任务已挂上全局槽位、可以轮询进度。
pub fn start(
    hub: Arc<LogHub>,
    scope: Scope,
) -> Result<(Option<UpgradeJob>, String), String> {
    let report = check()?;
    let engine_out = scope.wants_engine() && side_outdated(&report, "engine");
    let control_out = scope.wants_control() && side_outdated(&report, "control");
    let summary = describe(&report, scope);
    if !engine_out && !control_out {
        return Ok((None, summary));
    }
    let (root, python, script) = locate()?;
    let cwd = script
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let mut cmd = base_command(&python, &script, &cwd);
    cmd.arg("update")
        .arg("--components-dir")
        .arg(&root)
        .arg("--output")
        .arg("jsonl");
    for flag in scope.switches() {
        cmd.arg(flag);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|err| format!("启动升级失败：{err}"))?;
    let snapshot = Arc::new(Mutex::new(UpgradeSnapshot {
        message: summary.clone(),
        ..Default::default()
    }));
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(stdout, hub.clone(), snapshot.clone(), true);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(stderr, hub, snapshot.clone(), false);
    }
    Ok((Some(UpgradeJob { child, snapshot }), summary))
}

/// 读子进程输出。stdout 是 `--output jsonl` 的事件流，逐行解析成进度。
fn spawn_reader<R: std::io::Read + Send + 'static>(
    stream: R,
    hub: Arc<LogHub>,
    snapshot: Arc<Mutex<UpgradeSnapshot>>,
    parse_events: bool,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let text = line.trim_end().to_string();
            if text.is_empty() {
                continue;
            }
            hub.push("strata-upgrade", text.clone());
            if let Ok(mut snap) = snapshot.lock() {
                snap.log_tail.push(text.clone());
                let extra = snap.log_tail.len().saturating_sub(60);
                snap.log_tail.drain(..extra);
            }
            if parse_events {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Ok(mut snap) = snapshot.lock() {
                        apply_event(&mut snap, &value);
                    }
                }
            }
        }
    });
}

/// 把控制端的一个 jsonl 事件合进快照。
///
/// 事件形态（`strata_cli/update_cmd.py::_emit_factory` 与 `strata_control/updater.py`）：
/// `{"event":"progress","label":…,"percent":…,"done":…,"total":…}` /
/// `{"event":"phase","phase":…,"message":…}` / `{"event":"waiting","message":…}`，
/// 最后一行是没有 `event` 字段的最终报告（带 `ok`）。
fn apply_event(snap: &mut UpgradeSnapshot, value: &serde_json::Value) {
    match value.get("event").and_then(|v| v.as_str()) {
        Some("progress") => {
            snap.phase = "download".into();
            snap.percent = value
                .get("percent")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0) as f32;
            snap.label = value
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            snap.done_bytes = value
                .get("done")
                .and_then(|v| v.as_u64())
                .unwrap_or_default();
            snap.total_bytes = value
                .get("total")
                .and_then(|v| v.as_u64())
                .unwrap_or_default();
            let name = if snap.label.is_empty() {
                "安装包".to_string()
            } else {
                snap.label.clone()
            };
            snap.message = format!("正在下载 {name}：{:.0}%", snap.percent);
        }
        Some("phase") => {
            snap.phase = value
                .get("phase")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
                snap.message = message.to_string();
            }
            // 换阶段时进度条归零，免得停在 100% 像是下载完了
            if snap.phase != "download" {
                snap.percent = 0.0;
            }
        }
        Some("waiting") => {
            if let Some(message) = value.get("message").and_then(|v| v.as_str()) {
                snap.message = message.to_string();
            }
        }
        _ => {
            if value.get("ok").is_some() {
                snap.ok = value.get("ok").and_then(|v| v.as_bool());
                snap.result = Some(value.clone());
                snap.phase = "done".into();
                snap.percent = 100.0;
                let engine = value
                    .get("engine")
                    .and_then(|v| v.get("installed"))
                    .and_then(|v| v.get("version"))
                    .and_then(|v| v.as_str());
                let control = value
                    .get("control")
                    .and_then(|v| v.get("installed"))
                    .and_then(|v| v.as_str());
                let mut parts = Vec::new();
                if let Some(version) = engine {
                    parts.push(format!("引擎 {version}"));
                }
                if let Some(version) = control {
                    parts.push(format!("控制器 {version}"));
                }
                let tail = if parts.is_empty() {
                    String::new()
                } else {
                    format!("：{}", parts.join(" / "))
                };
                snap.message = match snap.ok {
                    Some(false) => format!("升级失败{tail}"),
                    _ => format!("升级完成{tail}"),
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parse_and_switches() {
        assert_eq!(Scope::parse("engine"), Scope::Engine);
        assert_eq!(Scope::parse("CONTROL"), Scope::Control);
        assert_eq!(Scope::parse(""), Scope::All);
        assert_eq!(Scope::parse("随便"), Scope::All);
        assert_eq!(Scope::Engine.switches(), &["--no-control"]);
        assert_eq!(Scope::Control.switches(), &["--no-engine"]);
        assert_eq!(Scope::All.switches(), &[] as &[&str]);
        // 范围决定 `--check` 报告里该看哪一侧
        assert!(Scope::Engine.wants_engine() && !Scope::Engine.wants_control());
        assert!(Scope::Control.wants_control() && !Scope::Control.wants_engine());
    }

    #[test]
    fn describe_reads_check_report() {
        let report = serde_json::json!({
            "ok": true,
            "engine": {"installed": {"version": "0.1.50"}, "offered": {"version": "0.1.51"}, "status": "available"},
            "control": {"installed": "0.1.51", "offered": "0.1.51", "status": "current"}
        });
        assert!(side_outdated(&report, "engine"));
        assert!(!side_outdated(&report, "control"));
        let text = describe(&report, Scope::All);
        assert!(text.contains("0.1.50 → 0.1.51"), "实际：{text}");
        // 只升控制器时，报告里引擎那一侧不该出现在描述里
        let text = describe(&report, Scope::Control);
        assert!(text.starts_with("已是最新"), "实际：{text}");
        assert!(text.contains("控制器 0.1.51"), "实际：{text}");
    }

    #[test]
    fn apply_event_tracks_progress_and_result() {
        let mut snap = UpgradeSnapshot::default();
        apply_event(
            &mut snap,
            &serde_json::json!({"event": "phase", "phase": "feed", "message": "Reading the signed update feed"}),
        );
        assert_eq!(snap.phase, "feed");
        assert_eq!(snap.message, "Reading the signed update feed");
        apply_event(
            &mut snap,
            &serde_json::json!({"event": "progress", "label": "strata-engine.tar.gz", "percent": 42.0,
                                "done": 42_000_000u64, "total": 100_000_000u64}),
        );
        assert_eq!(snap.percent, 42.0);
        assert_eq!(snap.done_bytes, 42_000_000);
        assert!(snap.message.contains("42%"), "实际：{}", snap.message);
        // 换阶段要清掉百分比，别让进度条停在 100%
        apply_event(
            &mut snap,
            &serde_json::json!({"event": "phase", "phase": "switch", "message": "Switching"}),
        );
        assert_eq!(snap.percent, 0.0);
        apply_event(
            &mut snap,
            &serde_json::json!({"ok": true,
                                "engine": {"installed": {"version": "0.1.51"}},
                                "control": {"installed": "0.1.52"}}),
        );
        assert_eq!(snap.ok, Some(true));
        assert_eq!(snap.phase, "done");
        assert!(snap.message.contains("引擎 0.1.51"), "实际：{}", snap.message);
        assert!(snap.message.contains("控制器 0.1.52"), "实际：{}", snap.message);
    }

    /// 真实 `--check` 报告（2026-10-26 实测，剪掉与显示无关的字段）：两侧都最新。
    ///
    /// 断言的是「已是最新」分支：旧版实现会在这里报「可升级」并白拉 580 MB。
    #[test]
    fn describe_real_report_says_up_to_date() {
        let report = serde_json::json!({
            "schema_version": 1, "ok": true,
            "feed": {"sequence": 114, "channel": "stable"},
            "engine": {
                "installed": {"version": "0.1.50", "folder": "0.1.50-windows-x86_64-cuda-cuda13"},
                "offered": {"version": "0.1.50", "size": 581368579},
                "status": "current", "download_bytes": 581368579, "problem": null
            },
            "control": {"installed": "0.1.51", "offered": "0.1.51", "status": "current", "download_bytes": 72528752},
            "app": {"installed": null, "offered": "0.2.6", "status": "unknown-installed"}
        });
        assert_eq!(describe(&report, Scope::All), "已是最新（引擎 0.1.50 / 控制器 0.1.51）");
        assert_eq!(describe(&report, Scope::Engine), "已是最新（引擎 0.1.50）");
        assert_eq!(describe(&report, Scope::Control), "已是最新（控制器 0.1.51）");
        // `app`（Strata 桌面应用）不归这个按钮管
        assert!(!side_outdated(&report, "engine"));
    }

    /// 真实安装实测（联网）：定位解释器、跑 `--check`、翻译成一句话。
    ///
    /// `STRATA_PROBE_ROOT=E:\AI\strata cargo test --lib probe_upgrade_check -- --ignored --nocapture`
    ///
    /// 沙箱内跑时控制端打不开 `<根>\.updates\update.lock`（errno 13，沙箱不允许写工作区外），
    /// 属环境限制，不是这条路径的缺陷 —— 判据是错误文本里带出控制端自己给的中文提示。
    #[test]
    #[ignore]
    fn probe_upgrade_check() {
        let root = std::env::var("STRATA_PROBE_ROOT").unwrap_or_else(|_| r"E:\AI\strata".into());
        crate::strata::configure_root(Some(PathBuf::from(&root)));
        let report = check().expect("--check 失败");
        println!(
            "feed = {}",
            serde_json::to_string(&report.get("feed")).unwrap_or_default()
        );
        println!("engine.status = {:?}", report.get("engine").and_then(|v| v.get("status")));
        println!("control.status = {:?}", report.get("control").and_then(|v| v.get("status")));
        println!("describe(all)    = {}", describe(&report, Scope::All));
        println!("describe(engine) = {}", describe(&report, Scope::Engine));
        println!("describe(control)= {}", describe(&report, Scope::Control));
    }
}
