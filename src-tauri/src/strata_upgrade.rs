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
//!
//! **目录为空时的自举**：控制端自己不能从「没有控制端」开始（`strata.py` 还没解压出来），
//! 所以 `start()` 在定位失败时先按官方 feed 下载控制器包（windows-x86_64 zip）→ 校验
//! sha256 → 解压到 `<根>\control\<版本>` → 写 `active.json`；引擎仍交给控制端自己的
//! `update` 装。feed 的签名由控制端在 update 时校验，自举这一步只用 feed 里的 sha256
//! 保证下载到的包完整（用户 m00326：目录为空时点「更新」也要能装好）。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
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

// ---------------------------------------------------------------- 空目录自举

/// 官方更新 feed：控制器 / 引擎包都从这里读。
const FEED_URL: &str =
    "https://github.com/Niko1221/Strata/releases/latest/download/strata-feed.json";
/// feed 里的 `url` 都是文件名，下载根目录是 release 的 `latest/download`。
const RELEASE_BASE: &str =
    "https://github.com/Niko1221/Strata/releases/latest/download/";

/// 本机平台标识（与 feed 的 `platform` 字段一致）。本项目只发 Windows x64 构建。
fn platform_id() -> &'static str {
    "windows-x86_64"
}

fn curl_command() -> Command {
    let mut cmd = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    crate::winfix::hide_console(&mut cmd);
    cmd
}

/// feed 里控制器包的一条。
#[derive(Debug)]
struct ControlPackage {
    version: String,
    url: String,
    sha256: String,
}

/// 从 feed 里挑出本平台的控制器包。
fn control_package(feed: &serde_json::Value, platform: &str) -> Result<ControlPackage, String> {
    let packages = feed
        .get("control")
        .and_then(|value| value.get("packages"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "官方更新 feed 里没有 control.packages".to_string())?;
    let package = packages
        .iter()
        .find(|package| package.get("platform").and_then(|value| value.as_str()) == Some(platform))
        .ok_or_else(|| format!("官方更新 feed 里没有 {platform} 的控制器包"))?;
    let field = |key: &str| {
        package
            .get(key)
            .and_then(|value| value.as_str())
            .filter(|text| !text.trim().is_empty())
            .map(|text| text.to_string())
    };
    Ok(ControlPackage {
        version: field("version").ok_or_else(|| "控制器包缺 version".to_string())?,
        url: field("url").ok_or_else(|| "控制器包缺 url".to_string())?,
        sha256: field("sha256").ok_or_else(|| "控制器包缺 sha256".to_string())?,
    })
}

/// 读 feed（只取文本；feed 签名由控制端在 `update` 里校验）。
fn fetch_feed() -> Result<serde_json::Value, String> {
    let stamp = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    );
    let path = std::env::temp_dir().join(format!("strata-feed-{stamp}.json"));
    let output = curl_command()
        .args([
            "-sS",
            "-L",
            "--compressed",
            "--max-time",
            "30",
            "--connect-timeout",
            "8",
        ])
        .arg("-o")
        .arg(&path)
        .arg(FEED_URL)
        .output();
    let output = match output {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err("这台机器上没有 curl.exe，无法从官网下载控制器".into());
        }
        Err(err) => return Err(format!("起 curl 失败：{err}")),
    };
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    if !output.status.success() {
        return Err(format!(
            "读取官方更新 feed 失败（退出码 {:?}）：{}",
            output.status.code(),
            first_lines(&String::from_utf8_lossy(&output.stderr), 3)
        ));
    }
    serde_json::from_str(&text).map_err(|err| format!("官方更新 feed 不是合法 JSON：{err}"))
}

/// 用 curl 把 `url` 下到 `dest`（覆盖已存在的文件）。
fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建下载目录失败：{err}"))?;
    }
    let _ = std::fs::remove_file(dest);
    let output = curl_command()
        .args([
            "-L",
            "--fail",
            "-sS",
            "--connect-timeout",
            "15",
            "--max-time",
            "1800",
        ])
        .arg("-o")
        .arg(dest)
        .arg(url)
        .output();
    let output = match output {
        Ok(output) => output,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Err("这台机器上没有 curl.exe，无法从官网下载控制器".into());
        }
        Err(err) => return Err(format!("起 curl 失败：{err}")),
    };
    if !output.status.success() {
        let _ = std::fs::remove_file(dest);
        return Err(format!(
            "下载控制器失败（退出码 {:?}）：{}",
            output.status.code(),
            first_lines(&String::from_utf8_lossy(&output.stderr), 3)
        ));
    }
    Ok(())
}

/// 算文件的 sha256（走系统 certutil，不引 sha2 依赖）。
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut command = Command::new("certutil.exe");
    crate::winfix::hide_console(&mut command);
    let output = command
        .args(["-hashfile"])
        .arg(path)
        .arg("SHA256")
        .output()
        .map_err(|err| format!("起 certutil 失败：{err}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let line = line.trim();
        // certutil 把哈希按 2 字节分组、用空格隔开；只认「整行都是 hex 与空格」的那一行
        if line.len() >= 64 && line.chars().all(|ch| ch.is_ascii_hexdigit() || ch == ' ') {
            let hex: String = line.chars().filter(|ch| ch.is_ascii_hexdigit()).collect();
            if hex.len() == 64 {
                return Ok(hex.to_ascii_lowercase());
            }
        }
    }
    Err(format!(
        "读不出 sha256（certutil 退出码 {:?}）",
        output.status.code()
    ))
}

/// 解压 zip：优先系统自带的 `tar.exe`（Win10 1803+ 都有，zip 也能解），
/// 失败再退回 PowerShell 的 `Expand-Archive`。
fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|err| format!("创建解压目录失败：{err}"))?;
    let mut tar = Command::new("tar.exe");
    crate::winfix::hide_console(&mut tar);
    if let Ok(output) = tar.arg("-xf").arg(archive).arg("-C").arg(dest).output() {
        if output.status.success() {
            return Ok(());
        }
    }
    let script = format!(
        "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
        archive.display(),
        dest.display()
    );
    let mut powershell = Command::new("powershell.exe");
    crate::winfix::hide_console(&mut powershell);
    let output = powershell
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|err| format!("解压控制器包失败：{err}"))?;
    if !output.status.success() {
        return Err(format!(
            "解压控制器包失败（退出码 {:?}）：{}",
            output.status.code(),
            first_lines(&String::from_utf8_lossy(&output.stderr), 3)
        ));
    }
    Ok(())
}

fn write_active_control(root: &Path, package: &ControlPackage) -> Result<(), String> {
    let control = root.join("control");
    std::fs::create_dir_all(&control).map_err(|err| format!("创建 control 目录失败：{err}"))?;
    let pointer = control.join("active.json");
    let temp = control.join("active.json.tmp");
    let value = serde_json::json!({
        "version": package.version,
        "folder": package.version,
        "sha256": package.sha256,
    });
    let bytes = serde_json::to_vec(&value)
        .map_err(|err| format!("序列化 active.json 失败：{err}"))?;
    std::fs::write(&temp, bytes).map_err(|err| format!("写 active.json 失败：{err}"))?;
    std::fs::rename(&temp, &pointer).map_err(|err| format!("替换 active.json 失败：{err}"))
}

/// 目录为空时的自举：下载 + 校验 + 解压官方控制器包，写 `active.json`。
///
/// 只装控制器；引擎留给控制端自己的 `update`（它按显卡挑包、试启动、失败回滚）。
pub fn bootstrap_control(root: &Path, hub: &Arc<LogHub>) -> Result<PathBuf, String> {
    let platform = platform_id();
    hub.push(
        "strata-upgrade",
        "[gui] 未找到 Strata 控制端，开始从官网下载控制器…".to_string(),
    );
    let feed = fetch_feed()?;
    let package = control_package(&feed, platform)?;
    let final_dir = root.join("control").join(&package.version);
    let python = final_dir.join("python").join(crate::strata_tune::python_name());
    // 上次自举解压到一半（比如取消过）时，别再下一遍
    if final_dir.join("strata.py").is_file() && python.is_file() {
        hub.push(
            "strata-upgrade",
            format!("[gui] 复用已下载的控制器 {}", package.version),
        );
        write_active_control(root, &package)?;
        return Ok(final_dir);
    }
    let updates = root.join(".updates");
    std::fs::create_dir_all(&updates).map_err(|err| format!("创建 .updates 目录失败：{err}"))?;
    let archive = updates.join(format!("strata-control-{}.zip", package.version));
    hub.push(
        "strata-upgrade",
        format!("[gui] 下载控制器 {}（{}）…", package.version, package.url),
    );
    download_file(&format!("{RELEASE_BASE}{}", package.url), &archive)?;
    hub.push("strata-upgrade", "[gui] 校验控制器包…".to_string());
    let got = sha256_file(&archive)?;
    if !got.eq_ignore_ascii_case(&package.sha256) {
        let _ = std::fs::remove_file(&archive);
        return Err(format!(
            "控制器包 sha256 不匹配（feed {} / 实际 {}）",
            package.sha256, got
        ));
    }
    let staging = updates.join(format!("control-{}-staging", package.version));
    let _ = std::fs::remove_dir_all(&staging);
    hub.push("strata-upgrade", "[gui] 解压控制器…".to_string());
    extract_zip(&archive, &staging)?;
    // 官方包把内容直接放根；万一以后带顶层目录，这里兜一下
    let mut content = staging.clone();
    if !content.join("strata.py").is_file() {
        if let Some(dir) = std::fs::read_dir(&content).ok().and_then(|mut entries| {
            entries.find_map(|entry| {
                let path = entry.ok()?.path();
                (path.is_dir() && path.join("strata.py").is_file()).then_some(path)
            })
        }) {
            content = dir;
        }
    }
    let python = content.join("python").join(crate::strata_tune::python_name());
    if !content.join("strata.py").is_file() || !python.is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("控制器包不完整（缺 strata.py 或 python\\python.exe）".into());
    }
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建 control 目录失败：{err}"))?;
    }
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&content, &final_dir).map_err(|err| format!("移动控制器目录失败：{err}"))?;
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&archive);
    write_active_control(root, &package)?;
    hub.push(
        "strata-upgrade",
        format!("[gui] 控制器 {} 已就绪", package.version),
    );
    Ok(final_dir)
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
/// 目录为空时先 `bootstrap_control` 装控制器（否则连 `update` 都跑不了），引擎仍交给控制端。
///
/// 返回 `(是否有需要下载的东西, 一句话说明)`；`true` 时任务已挂上全局槽位、可以轮询进度。
pub fn start(
    hub: Arc<LogHub>,
    scope: Scope,
) -> Result<(Option<UpgradeJob>, String), String> {
    // 目录为空（或目录里还没有控制端）时先装控制器：`update` 本身跑在控制端里，
    // 引擎也必须由控制端按显卡挑包安装，所以这里只能先自举控制端，不能直接下载引擎。
    let configured = crate::strata::root()
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    if !configured.is_dir() {
        std::fs::create_dir_all(&configured)
            .map_err(|err| format!("创建 Strata 目录失败：{err}"))?;
    }
    if locate().is_err() {
        bootstrap_control(&configured, &hub)?;
    }
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

    /// feed 里按平台挑控制器包（不联网，纯解析）。
    #[test]
    fn control_package_picks_the_matching_platform() {
        let feed = serde_json::json!({
            "schema_version": 1,
            "sequence": 122,
            "control": {
                "version": "0.1.58",
                "packages": [
                    {"platform": "linux-x86_64", "version": "0.1.58",
                     "url": "strata-control-0.1.58-linux-x86_64.zip", "sha256": "abc"},
                    {"platform": "windows-x86_64", "version": "0.1.58",
                     "url": "strata-control-0.1.58-windows-x86_64.zip",
                     "sha256": "5a927d2b2ac61a9d6963fb17b46819f0bbd779875d1f9a6ba0e07834b350077b"}
                ]
            }
        });
        let package = control_package(&feed, "windows-x86_64").expect("应当挑到 Windows 包");
        assert_eq!(package.version, "0.1.58");
        assert_eq!(package.url, "strata-control-0.1.58-windows-x86_64.zip");
        assert_eq!(
            package.sha256,
            "5a927d2b2ac61a9d6963fb17b46819f0bbd779875d1f9a6ba0e07834b350077b"
        );
    }

    /// 没有本平台包时报错，而不是悄悄挑一个别的平台。
    #[test]
    fn control_package_rejects_a_missing_platform() {
        let feed = serde_json::json!({
            "control": {"packages": [
                {"platform": "linux-x86_64", "version": "0.1.58", "url": "x", "sha256": "y"}
            ]}
        });
        let err = control_package(&feed, "windows-x86_64").expect_err("缺 Windows 包应报错");
        assert!(err.contains("windows-x86_64"), "{err}");
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
