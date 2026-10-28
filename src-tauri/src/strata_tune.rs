//! Strata 参数调优（`strata tune auto <config>`）的 GUI 驱动。
//!
//! 官方调优是一条独立的长任务（quick ≈ 20 分钟，thorough 最长约 2 小时）：
//! 它自己起引擎、加载模型、逐项试参数，最后把结论写进 status 文件的 `result.settings.args`。
//!
//! **GUI 让调优不写预设**（`--no-save`，用户 m02013：`E:\AI\strata` 不使用预设，只使用 config）：
//! 跑完由 [`apply_overlay`] 把 `result.settings.args` 合并进 config 的 `args` 并落盘，
//! 记录存 `<根>\tune-records\`，下次启动引擎直接读 config，不再依赖
//! `serve\server.py::apply_saved_tuning` 的预设叠加。
//!
//! GUI 这边只做四件事：
//! - `start`：以 `--status-file` + `--no-save` + `--output json` 起子进程，输出逐行进日志面板；
//! - `snapshot`：读 status 文件的进度（stage / message / eta，英文文案翻成中文），并判断进程是否还活着；
//! - `stop`：硬杀进程树（tune 自己会忽略不了这个，显存要立刻还回来）；
//! - `apply_overlay`：调优结束后把结果写进 config（`.json.bak` 备份 + 原子写，只动 `args`）。
//!
//! 调优要独占显存：GUI 在启动前拦住「Strata 正在跑」的情况，启动模型的路径也要拦
//! 「调优正在跑」的情况（见 `lib.rs::strata_tune_start` 与 `strata_start_engine`）。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use crate::logs::LogHub;

/// 调优子进程 + 它写进度的文件。
pub struct TuneJob {
    child: Child,
    status_path: PathBuf,
    /// 进度同步副本：`launch\<slug>.tune.json`（与 `strata launch` 通道同一处，用户 m02450）
    tune_copy: Option<PathBuf>,
    /// 最近若干行输出（进程早退、status 文件还没写出时，前端靠它说清失败原因）。
    log_tail: Arc<Mutex<Vec<String>>>,
}

/// 前端轮询用的进度快照。
#[derive(serde::Serialize)]
pub struct TuneSnapshot {
    /// 子进程是否还活着。
    pub running: bool,
    /// status 文件里的 `state`：`running` / `done`（进程退出但没写 = `exited`）。
    pub state: String,
    pub stage: String,
    pub message: String,
    pub text: String,
    pub eta_s: Option<f64>,
    pub minutes_left: Option<i64>,
    /// 完成时的完整结果（含 `outcome` / `gain_pct` / `preset` / `notes`）。
    pub result: Option<serde_json::Value>,
    pub log_tail: Vec<String>,
    /// 退出码（进程结束后才有值）
    pub exit_code: Option<i32>,
}

/// 每份 config 一个固定的进度文件名（同一模型重复调优时覆盖上一轮）。
fn status_path(config: &Path) -> PathBuf {
    let key = fnv1a(config.to_string_lossy().as_bytes());
    std::env::temp_dir().join(format!("llamacpp-strata-tune-{key:016x}.json"))
}

/// `args` 里 `--pack` 后面的值（同一模型在 install config 与 launch 配置里是同一个包）。
fn pack_of(value: &serde_json::Value) -> Option<String> {
    let args = value.get("args")?.as_array()?;
    let mut iter = args.iter().filter_map(|item| item.as_str());
    while let Some(arg) = iter.next() {
        if arg == "--pack" {
            return iter.next().map(|text| text.to_string());
        }
    }
    None
}

/// 调优进度要同步到的位置：`<根>\launch\<slug>.tune.json`。
///
/// `strata launch` 通道调优时会写这个文件（stage / speeds / result），GUI 走 `strata tune auto`
/// 不会，用户 m02450 要求补上。slug 取「同一 `--pack` 的那份 launch 配置」的名字；没有对应
/// launch 配置时退回 config 自己的名字（`strata-swift-iq2_xs` → `swift-iq2_xs`）。
fn tune_copy_path(config: &Path) -> Option<PathBuf> {
    let root = crate::strata::root()?;
    let launch = root.join("launch");
    let pack = std::fs::read_to_string(config)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| pack_of(&value));
    if launch.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&launch) {
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().map(|name| name.to_string_lossy().to_string()) else {
                    continue;
                };
                if !name.ends_with(".json")
                    || name.ends_with(".choices.json")
                    || name.ends_with(".tune.json")
                {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                if pack.is_some() && pack_of(&value) == pack {
                    return Some(launch.join(format!("{}.tune.json", name.trim_end_matches(".json"))));
                }
            }
        }
    }
    let stem = config.file_stem()?.to_string_lossy().to_string();
    let stem = stem.strip_prefix("strata-").unwrap_or(&stem).to_string();
    Some(launch.join(format!("{stem}.tune.json")))
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// `python` 可执行文件名（Windows 下带 `.exe`）。`strata.rs` 的回退命令也用它。
pub fn python_name() -> &'static str {
    if cfg!(windows) {
        "python.exe"
    } else {
        "python"
    }
}

/// 控制端目录：手动解压布局 `<根>\control\<版本>` 优先（设置页选中的 → `active.json` →
/// 版本最高），否则官方安装器的 `terminal\current` / `terminal\<版本>`。
///
/// 与 `strata.rs::fallback_command` 的候选顺序一致：`current` 是官方脚本维护的目录联结，
/// 升级换版本只换联结；手动解压的目录没有联结，靠选中的版本。
pub fn terminal_dir(root: &Path) -> Option<PathBuf> {
    let py_name = python_name();
    if let Some(dir) = crate::strata::preferred_controller(root) {
        if dir.join("python").join(py_name).is_file() {
            return Some(dir);
        }
    }
    let terminal = root.join("terminal");
    let current = terminal.join("current");
    if current.join("python").join(py_name).is_file() {
        return Some(current);
    }
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&terminal)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|dir| dir.join("python").join(py_name).is_file())
        .collect();
    dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
    dirs.into_iter().next()
}

impl TuneJob {
    /// 子进程是否还在跑。`try_wait` 顺带回收已退出的进程，不会留下僵尸。
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    source: &'static str,
    stream: R,
    hub: Arc<LogHub>,
    log_tail: Arc<Mutex<Vec<String>>>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let text = line.trim_end().to_string();
            if text.is_empty() {
                continue;
            }
            hub.push("strata-tune", text.clone());
            if let Ok(mut tail) = log_tail.lock() {
                tail.push(format!("[{source}] {text}"));
                let extra = tail.len().saturating_sub(60);
                tail.drain(..extra);
            }
        }
    });
}

/// 起一个调优进程。`mode` 只认 `quick` / `thorough`（其它一律当 quick）。
pub fn start(hub: Arc<LogHub>, config: &Path, mode: &str) -> Result<TuneJob, String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let terminal = terminal_dir(&root).ok_or_else(|| {
        "未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）".to_string()
    })?;
    let python = terminal.join("python").join(python_name());
    let script = terminal.join("strata.py");
    if !script.is_file() {
        return Err(format!("控制端缺少 strata.py：{}", script.display()));
    }
    let status = status_path(config);
    // 上一轮的进度文件清掉：不然本轮还没写、前端先读到旧的 done，会当成已完成。
    let _ = std::fs::remove_file(&status);
    // 同步副本也清掉，避免上一轮的成绩被当成本轮结果。
    let tune_copy = tune_copy_path(config);
    if let Some(copy) = &tune_copy {
        let _ = std::fs::remove_file(copy);
    }

    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("tune")
        .arg("auto")
        .arg(config)
        .arg("--mode")
        .arg(if mode == "thorough" { "thorough" } else { "quick" })
        .arg("--status-file")
        .arg(&status)
        // 用户要求（m02013）：E:\AI\strata 不用预设，只认 config。
        // `--no-save` 让 tuner 不写 `presets\`，调优结果只经由 apply 落到 config 的 args。
        .arg("--no-save")
        .arg("--output")
        .arg("json")
        .current_dir(&terminal)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::winfix::hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动调优进程失败：{err}"))?;
    let log_tail = Arc::new(Mutex::new(Vec::new()));
    if let Some(stdout) = child.stdout.take() {
        spawn_reader("out", stdout, hub.clone(), log_tail.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader("err", stderr, hub, log_tail.clone());
    }
    Ok(TuneJob {
        child,
        status_path: status,
        tune_copy,
        log_tail,
    })
}

/// 读一次进度。
pub fn snapshot(job: &mut TuneJob) -> TuneSnapshot {
    let mut snap = TuneSnapshot {
        running: true,
        state: "running".into(),
        stage: String::new(),
        message: String::new(),
        text: String::new(),
        eta_s: None,
        minutes_left: None,
        result: None,
        log_tail: Vec::new(),
        exit_code: None,
    };
    if let Ok(raw) = std::fs::read_to_string(&job.status_path) {
        // 同步副本：`strata launch` 通道调优会写 `launch\<slug>.tune.json`，GUI 这边补上同一份
        // 进度（用户 m02450），内容就是 tuner 自己写的 status JSON，原样搬运。
        if let Some(copy) = &job.tune_copy {
            let changed = std::fs::read_to_string(copy)
                .map(|old| old != raw)
                .unwrap_or(true);
            if changed {
                if let Some(parent) = copy.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(copy, &raw);
            }
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            let text = |key: &str| {
                value
                    .get(key)
                    .and_then(|item| item.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            let s = text("state");
            if !s.is_empty() {
                snap.state = s;
            }
            // 文案统一在这里中文化（用户 m01627）：tuner 写的是英文句子，界面直接显示。
            snap.stage = zh_stage(&text("stage"));
            snap.message = zh_message(&text("message"));
            snap.text = zh_message(&text("text"));
            snap.eta_s = value.get("eta_s").and_then(|item| item.as_f64());
            snap.minutes_left = value.get("minutes_left").and_then(|item| item.as_i64());
            snap.result = value.get("result").cloned().map(|mut result| {
                // 结论句（`+12% faster answers` / `Stopped…`）同样翻成中文。
                if let Some(obj) = result.as_object_mut() {
                    if let Some(message) = obj.get("message").and_then(|item| item.as_str()) {
                        let zh = zh_message(message);
                        obj.insert("message".into(), serde_json::Value::String(zh));
                    }
                }
                result
            });
        }
    }
    match job.child.try_wait() {
        Ok(Some(status)) => {
            snap.running = false;
            snap.exit_code = status.code();
            // 进程退出却没写 `done`：多半是 tuner 崩了或参数被拒，界面按失败展示。
            if snap.state == "running" {
                snap.state = "exited".into();
            }
        }
        Ok(None) => {}
        Err(_) => {}
    }
    if let Ok(tail) = job.log_tail.lock() {
        snap.log_tail = tail.clone();
    }
    snap
}

/// 硬杀调优进程**整棵树**（tune 会自己起 `strata.exe` 测速，只杀 python 会留下占着显存的引擎）。
pub fn stop(job: &mut TuneJob) {
    crate::logs::force_kill_tree(job.child.id(), &mut job.child);
    let _ = job.child.wait();
}

// ---------------------------------------------------------------------------
// 调优结果落盘（用户 m01543）

/// 一次「把调优参数写进 config」的结果，同时也是历史记录里的一条。
///
/// 用户要求：调优完成后把增加/删除的参数写进 config，并保留记录，下次打开调优面板
/// 能看到上一次改了什么。
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TuneRecord {
    /// 生成这条记录的毫秒时间戳
    pub at_ms: u64,
    /// 这次叠加来自哪条预设（名字）
    pub preset: Option<String>,
    /// 新增的参数（`--flag value` 形式，按 flag 排序）
    pub added: Vec<String>,
    /// 删除的参数（`--flag value` 形式）
    pub removed: Vec<String>,
    /// 是否真的改了 config
    pub applied: bool,
    /// 界面上直接显示的中文说明
    pub message: String,
}

/// 记录目录：`<Strata 根>\tune-records\`（用户 m01801：调优记录要专门放一个目录）。
///
/// 不塞进 `launch\`：那里是控制端 `strata launch` 的配置目录，多一份 `*.json` 会被它当成
/// 预设候选扫到；单独一层只给 GUI 写，也不影响控制端升级/校验。
pub fn records_dir() -> PathBuf {
    crate::strata::root()
        .map(|root| root.join("tune-records"))
        .unwrap_or_else(|| std::env::temp_dir().join("llama-strata-tune-records"))
}

/// 每份 config 一个记录文件：`tune-records\<slug>.json`，内容是最近若干条 [`TuneRecord`]。
fn record_path(config: &Path) -> PathBuf {
    let slug = match tune_copy_path(config) {
        Some(path) => path
            .file_stem()
            .map(|stem| stem.to_string_lossy().trim_end_matches(".tune").to_string())
            .unwrap_or_else(|| "tune".to_string()),
        None => {
            let stem = config.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default();
            stem.strip_prefix("strata-").unwrap_or(&stem).to_string()
        }
    };
    records_dir().join(format!("{slug}.json"))
}

/// 每份 config 最多留这么多条记录（够回看最近几次调优，又不会越攒越大）。
const RECORD_KEEP: usize = 20;

/// 上次调优写进 config 的记录（没有就是 `None`）。
pub fn last_record(config: &Path) -> Option<TuneRecord> {
    records(config).pop()
}

/// 这份 config 的全部调优记录（旧 → 新）。
pub fn records(config: &Path) -> Vec<TuneRecord> {
    let Ok(raw) = std::fs::read_to_string(record_path(config)) else {
        return Vec::new();
    };
    // 兼容最初写成的单个对象。
    if let Ok(list) = serde_json::from_str::<Vec<TuneRecord>>(&raw) {
        return list;
    }
    serde_json::from_str::<TuneRecord>(&raw).map(|one| vec![one]).unwrap_or_default()
}

fn save_record(config: &Path, record: &TuneRecord) {
    let path = record_path(config);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut list = records(config);
    list.push(record.clone());
    if list.len() > RECORD_KEEP {
        let drop = list.len() - RECORD_KEEP;
        list.drain(..drop);
    }
    if let Ok(raw) = serde_json::to_string_pretty(&list) {
        let _ = std::fs::write(path, raw);
    }
}

/// 内联脚本：取当前生效的调优叠加参数，算出把它并进 config 后的 argv。
///
/// 调优结果本身**不在 config 里**：控制端把推荐值写成一条预设，引擎启动时
/// `serve\server.py::apply_saved_tuning` 再把预设的 `args` 叠到 config 上（典型的 `--kv-grow`
/// 就只活在预设里）。用户要的是「调优完就直接写进 config」，所以这里先让控制端叠一次，
/// 拿它算出的最终 argv，再由 Rust 用 [`crate::strata::write_config_args`] 原地改写数组 ——
/// 不整份重排键序（键序是上游 `setup.py` 写的）。
const APPLY_SCRIPT: &str = r#"
import json, sys
from pathlib import Path
terminal, cfg_path = Path(sys.argv[1]), Path(sys.argv[2])
# 状态文件（TEMP 里那份）优先，其次是 launch 目录下的同步副本（GUI 重启后 TEMP 可能被清）。
candidates = [Path(item) for item in sys.argv[3:] if item]
sys.path.insert(0, str(terminal))
try:
    path = next((p for p in candidates if p.is_file()), None)
    if path is None:
        raise FileNotFoundError("没有找到这次调优的结果文件")
    from strata_control import tune_apply
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    status = json.loads(path.read_text(encoding="utf-8"))
    res = status.get("result") or {}
    settings = res.get("settings") or {}
    args = settings.get("args") or {}
    values = res.get("values") or {}
    out = {"outcome": res.get("outcome"), "message": res.get("message"),
           "preset": values.get("preset_name")}
    if args:
        argv = tune_apply.args_to_argv(args)
        out["flags"] = [str(x) for x in argv]
        out["before"] = [str(x) for x in (cfg.get("args") or [])]
        out["after"] = [str(x) for x in tune_apply.apply_args_to_config(cfg, argv).get("args") or []]
    print(json.dumps(out, ensure_ascii=False))
except FileNotFoundError:
    print(json.dumps({"error": "没有找到这次调优的结果文件（重新调优一次即可）"}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"error": type(exc).__name__ + ": " + str(exc)}, ensure_ascii=False))
"#;

/// 把这次调优给出的参数写进 `config`，返回这次的记录（同时落盘）。
///
/// **不走预设**（用户 m02013：`E:\AI\strata` 不用预设，只认 config）：参数取自调优状态文件里
/// `result.settings.args`（tuner 自己算出的 `--flag value` 字典），经 `tune_apply.args_to_argv`
/// 与 `tune_apply.apply_args_to_config` 合并进 `args`，再由 `strata::write_config_args` 落盘。
/// 耗时约 1 秒（起一次 python），调用方应在后台线程里跑。
pub fn apply_overlay(config: &Path) -> Result<TuneRecord, String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let terminal = terminal_dir(&root).ok_or_else(|| {
        "未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）".to_string()
    })?;
    let python = terminal.join("python").join(python_name());
    let mut cmd = Command::new(&python);
    let copy = tune_copy_path(config);
    cmd.arg("-c")
        .arg(APPLY_SCRIPT)
        .arg(&terminal)
        .arg(config)
        .arg(status_path(config))
        .arg(copy.as_deref().unwrap_or_else(|| Path::new("")))
        .current_dir(&terminal)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::winfix::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|err| format!("应用调优结果失败（{}）：{err}", python.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&out.stderr);
            format!(
                "调优结果应用没有输出（退出码 {:?}）：{}{}",
                out.status.code(),
                stdout.trim(),
                stderr.trim()
            )
        })?;
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|err| format!("解析调优结果失败：{err}：{}", line.trim()))?;
    if let Some(error) = value.get("error").and_then(|item| item.as_str()) {
        return Err(format!("调优结果应用失败：{error}"));
    }
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0);
    let preset = value
        .get("preset")
        .and_then(|item| item.as_str())
        .map(|text| text.to_string());
    let text_list = |key: &str| -> Vec<String> {
        value
            .get(key)
            .and_then(|item| item.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|text| text.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };
    // 没给出参数（调优被取消 / 没测到更好的设置 / 结果文件过期）：只记录原因，不碰 config。
    let before = text_list("before");
    let after = text_list("after");
    if after.is_empty() {
        let why = ["message", "outcome"]
            .iter()
            .filter_map(|key| value.get(*key).and_then(|item| item.as_str()))
            .find(|text| !text.trim().is_empty())
            .map(|text| zh_message(text))
            .unwrap_or_else(|| "这次调优没有给出可用的参数".to_string());
        let record = TuneRecord {
            at_ms,
            preset,
            added: Vec::new(),
            removed: Vec::new(),
            applied: false,
            message: format!("config 未改动：{why}"),
        };
        save_record(config, &record);
        return Ok(record);
    }
    let (added, removed) = args_diff(&before, &after);
    let record = if added.is_empty() && removed.is_empty() {
        TuneRecord {
            at_ms,
            preset,
            added,
            removed,
            applied: false,
            message: "config 已经包含这次调优的参数，无需改动。".to_string(),
        }
    } else {
        crate::strata::write_config_args(config, &after).map_err(|err| format!("写入 config 失败：{err:#}"))?;
        TuneRecord {
            at_ms,
            preset,
            message: format!(
                "已写入 config：新增 {} 项{}，删除 {} 项{}。",
                added.len(),
                if added.is_empty() { String::new() } else { format!("（{}）", added.join("、")) },
                removed.len(),
                if removed.is_empty() {
                    String::new()
                } else {
                    format!("（{}）", removed.join("、"))
                },
            ),
            added,
            removed,
            applied: true,
        }
    };
    save_record(config, &record);
    Ok(record)
}

/// `args` 按 flag 配对后求差（与上游 `tune_apply._diff` 同一口径：值变了既算新增也算删除）。
fn args_diff(before: &[String], after: &[String]) -> (Vec<String>, Vec<String>) {
    fn pairs(items: &[String]) -> std::collections::BTreeMap<String, String> {
        let mut out = std::collections::BTreeMap::new();
        let mut index = 0;
        while index < items.len() {
            let item = items[index].clone();
            if item.starts_with("--") && index + 1 < items.len() && !items[index + 1].starts_with("--")
            {
                out.insert(item, items[index + 1].clone());
                index += 2;
            } else {
                out.insert(item, String::new());
                index += 1;
            }
        }
        out
    }
    let join = |flag: &str, value: &str| {
        if value.is_empty() {
            flag.to_string()
        } else {
            format!("{flag} {value}")
        }
    };
    let b = pairs(before);
    let a = pairs(after);
    let added = a
        .iter()
        .filter(|(flag, value)| b.get(*flag) != Some(*value))
        .map(|(flag, value)| join(flag, value))
        .collect();
    let removed = b
        .iter()
        .filter(|(flag, value)| a.get(*flag) != Some(*value))
        .map(|(flag, value)| join(flag, value))
        .collect();
    (added, removed)
}

// ---------------------------------------------------------------------------
// 进度文案中文化（用户 m01627）
//
// 调优的 stage / message / text 全部由控制端的 tuner 用英文写进 status 文件
// （`strata_control\autotune.py` 的 `_say()` 与 `strata_cli\tune_commands.py:203/212/255`），
// 界面之前原样显示。这里在 `snapshot()` 出口统一翻成中文；没有命中的句子保留原文，
// 但 stage 一定给中文阶段名，所以界面不会整片英文。

fn zh_stage(stage: &str) -> String {
    match stage {
        "start" => "准备",
        "waiting" => "等待",
        "base" => "测基准",
        "plan" => "规划",
        "rounds" => "对比测试",
        "drift" => "漂移检查",
        "confirm" => "复核",
        "per_request" => "单请求测试",
        "recheck" => "复测",
        "done" => "完成",
        "exited" => "已退出",
        "" => "",
        other => other,
    }
    .to_string()
}

/// 把 tuner 的英文句子翻成中文。
///
/// 句子带动态值（轮次、预设名、显存数），所以按前缀切、保留参数再拼——
/// 不认识的句子原样返回，宁可显示英文也不猜。
fn zh_message(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }
    // 结论句（autotune.py:347/388/406/636/645/688）
    if text == "Stopped. Your settings were not changed." {
        return "已停止，设置未改动。".to_string();
    }
    if text == "The PC was too noisy to tell settings apart, so nothing was changed. Try again when it is idle."
    {
        return "电脑太吵，测不出差异，未做任何改动。空闲时再试。".to_string();
    }
    if text == "Your current settings are already the fastest we found. Nothing was changed." {
        return "当前设置已经是测到最快的，未做改动。".to_string();
    }
    if text == "slightly faster" {
        return "略快一点".to_string();
    }
    if let Some(rest) = text.strip_prefix('+') {
        if let Some((percent, _)) = rest.split_once("% faster answers") {
            return format!("回答速度 +{percent}%");
        }
    }
    if let Some(rest) = text.strip_prefix("Not tuned: ") {
        return format!("未完成调优：{}", zh_message(rest));
    }
    if let Some(rest) = text.strip_prefix("Your current settings could not be measured: ") {
        return format!("无法测量当前设置：{}", zh_message(rest));
    }
    if let Some(rest) = text.strip_prefix("Waiting for the PC to be quiet (") {
        return format!("等待电脑空闲（{}）", rest.trim_end_matches(')'));
    }
    if let Some(rest) = text.strip_prefix("Waiting for memory to be freed before trying ") {
        if let Some((label, tail)) = rest.split_once(" (") {
            return format!("等待显存释放后再试 {label}（{}）", tail.trim_end_matches(')'));
        }
    }
    if text == "Checking your PC before the first measurement" {
        return "第一次测量前先检查这台电脑".to_string();
    }
    if text == "Measuring your current settings" {
        return "正在测量当前设置".to_string();
    }
    if text == "Measured your current settings" {
        return "已测完当前设置".to_string();
    }
    if text == "No other setting is worth trying on this PC" {
        return "这台电脑上没有其它值得一试的设置".to_string();
    }
    if let Some(rest) = text.strip_prefix("Measuring your current settings again (round ") {
        if let Some((round, total)) = rest.trim_end_matches(')').split_once(" of ") {
            return format!("重新测量当前设置（第 {round}/{total} 轮）");
        }
    }
    if let Some(rest) = text.strip_prefix("Trying: ") {
        if let Some((label, tail)) = rest.split_once(" (round ") {
            if let Some((round, total)) = tail.trim_end_matches(')').split_once(" of ") {
                return format!("正在试 {label}（第 {round}/{total} 轮）");
            }
        }
    }
    if text == "Measuring your current settings once more to check the PC did not drift" {
        return "再测一次当前设置，确认电脑没有漂移".to_string();
    }
    if text == "Confirming the combined result against your current settings" {
        return "用当前设置复核组合结果".to_string();
    }
    if text == "Confirming the settings that need no restart" {
        return "复核不需要重启的设置".to_string();
    }
    if let Some(rest) = text.strip_prefix("Confirming (pair ") {
        if let Some((index, total)) = rest.trim_end_matches(')').split_once(" of ") {
            return format!("复核中（第 {index}/{total} 对）");
        }
    }
    if text == "Trying settings that need no restart" {
        return "正在试不需要重启的设置".to_string();
    }
    if text == "Done" {
        return "完成".to_string();
    }
    if let Some(rest) = text.strip_prefix("Finding the fastest settings for your PC…") {
        return format!("正在寻找这台电脑最快的设置…{}", zh_minutes(rest));
    }
    if text.starts_with("Waiting for") {
        return format!("等待中：{text}");
    }
    text.to_string()
}

/// `minutes_text()` 的输出（`"  about 3 min"` / `"  12 min left"`）里把 min 换成分钟。
fn zh_minutes(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return String::new();
    }
    let text = text.replace("about ", "约 ").replace("min left", "分钟").replace("min", "分钟");
    format!("（{text}）")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_paths_differ_per_config() {
        let a = status_path(Path::new(r"C:\x\strata-a.json"));
        let b = status_path(Path::new(r"C:\x\strata-b.json"));
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains("llamacpp-strata-tune-"));
    }

    #[test]
    fn pack_of_reads_the_flag_value() {
        let value = serde_json::json!({"args": ["--pack", "E:\\x\\packs\\a", "--native", "n.gguf"]});
        assert_eq!(pack_of(&value).as_deref(), Some("E:\\x\\packs\\a"));
        assert_eq!(pack_of(&serde_json::json!({"args": []})), None);
        assert_eq!(pack_of(&serde_json::json!({})), None);
    }

    /// 真实安装上：sc117 的 install config 应该映射到它那份 launch 配置的 tune.json 旁边。
    #[test]
    #[ignore = "要本机官方安装 + 对应的 launch 配置"]
    fn tune_copy_lands_next_to_the_launch_config() {
        let Some(root) = crate::strata::root() else {
            eprintln!("skip: 没有官方安装");
            return;
        };
        let config = root.join("install").join("strata-swift-iq2_xs.json");
        if !config.is_file() {
            eprintln!("skip: {}", config.display());
            return;
        }
        let copy = tune_copy_path(&config).expect("应该能推出 tune.json 路径");
        eprintln!("copy={}", copy.display());
        assert!(copy.to_string_lossy().ends_with(".tune.json"));
        assert!(
            copy.to_string_lossy().contains("sc117_swift-iq2_xs-256k"),
            "应该跟 launch\\sc117_swift-iq2_xs-256k.json 同名"
        );
    }

    #[test]
    fn args_diff_flags_value_changes() {
        let before: Vec<String> = ["--kv-grow", "--kv-resident", "32768", "--expert-profile", "a.bin"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        // `--kv-resident` 值变了（既算新增也算删除），`--kv-grow` 等值都在 → 不动。
        let after: Vec<String> = ["--kv-grow", "--kv-resident", "65536", "--expert-profile", "a.bin"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        let (added, removed) = args_diff(&before, &after);
        assert_eq!(added, vec!["--kv-resident 65536".to_string()]);
        assert_eq!(removed, vec!["--kv-resident 32768".to_string()]);

        // 删掉一个 flag：只出现在 removed。
        let after: Vec<String> = ["--kv-grow", "--kv-resident", "65536"]
            .iter()
            .map(|item| item.to_string())
            .collect();
        let (added, removed) = args_diff(&before, &after);
        assert_eq!(added, vec!["--kv-resident 65536".to_string()]);
        assert_eq!(removed.len(), 2);
        assert!(removed.contains(&"--expert-profile a.bin".to_string()));

        // 完全相同：两头都空。
        assert_eq!(args_diff(&before, &before), (Vec::new(), Vec::new()));
    }

    #[test]
    fn zh_message_translates_tuner_sentences() {
        assert_eq!(zh_message("Measuring your current settings"), "正在测量当前设置");
        assert_eq!(
            zh_message("Trying: 8-bit cache (round 2 of 5)"),
            "正在试 8-bit cache（第 2/5 轮）"
        );
        assert_eq!(zh_message("+12% faster answers"), "回答速度 +12%");
        assert_eq!(zh_message("Done"), "完成");
        assert_eq!(
            zh_message("Your current settings are already the fastest we found. Nothing was changed."),
            "当前设置已经是测到最快的，未做改动。"
        );
        // 不认识的句子原样返回（宁可英文，也不瞎猜）。
        assert_eq!(zh_message("some new tuner sentence"), "some new tuner sentence");
        assert_eq!(zh_stage("rounds"), "对比测试");
        assert_eq!(zh_stage(""), "");
        assert_eq!(zh_stage("unknown"), "unknown");
    }

    /// 记录文件放在 `<根>\tune-records\`（用户 m01801），不是 `launch\`。
    #[test]
    fn records_dir_is_a_dedicated_folder() {
        let Some(root) = crate::strata::root() else {
            eprintln!("skip: 没有 Strata 目录");
            return;
        };
        assert_eq!(records_dir(), root.join("tune-records"));
    }

    #[test]
    fn terminal_dir_finds_current_junction() {
        let root = std::env::temp_dir().join(format!("llamacpp-tune-{}", crate::logs::now_ms()));
        let python = root.join("terminal").join("current").join("python");
        std::fs::create_dir_all(&python).unwrap();
        std::fs::write(python.join(python_name()), b"").unwrap();
        let found = terminal_dir(&root).expect("current 目录应该被认出来");
        assert!(found.ends_with("current"));
        let _ = std::fs::remove_dir_all(&root);
    }

}
