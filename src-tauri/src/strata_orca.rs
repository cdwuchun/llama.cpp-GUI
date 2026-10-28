//! ORCA 导入（社区目录里 `family == "orca"` 的那一条）。
//!
//! 为什么这条路不能复用 `strata_download`：官方安装器 `setup.py` 里**完全没有** orca
//! 相关代码（对 `E:\AI\Strata\control\<版本>` 全目录搜 `orca` 零命中），它的下载路径是
//! 「按 `--family/--model` 拼出官方仓库名」。ORCA 是社区仓库 + 安装器自带的 `tools/iq_pack.py`
//! 打包，所以 GUI 自己在后端做三步：
//!
//! 1. 用系统 `curl.exe` 下两个分片（`-C -` 续传，进度靠轮询文件大小）；
//! 2. 跑 `<控制端>/python/python.exe -u tools/iq_pack.py --gguf <分片1> --out <pack> --compat-bf16`
//!    （`iq_pack.py:706` 会自己调 `strata_tokenizer.py` 导出 tokenizer/，并读同目录其余分片）；
//! 3. 照本机 `strata-*.json` 的同一套字段写 `<configs>/strata-orca-iq3_xxs.json`。
//!
//! 常量与上游 `packages/core/src/orca-import.ts`、`crates/runtime-core/src/orca_import.rs` 对齐
//! （上游 pack 相对路径 `packs/orca-iq3_xxs` 记在 `orca_import.rs:22`）。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::logs::LogHub;

/// 上游 `ORCA_REPOSITORY`
pub const REPO: &str = "orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF";
/// 上游 `ORCA_REVISION`（下载 URL 里的 revision，锁版本而不是 `main`）
pub const REVISION: &str = "d366e279688c1f2fd6e75e2f98475d38db534f1d";
/// 上游 `ORCA_SHARDS`
pub const SHARDS: [(&str, u64); 2] = [
    (
        "Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf",
        44_637_691_008,
    ),
    (
        "Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf",
        40_564_977_024,
    ),
];
/// 上游 `ORCA_QUANT`
pub const QUANT: &str = "IQ3_XXS";
/// 上游 `ORCA_CONTEXT`
pub const CONTEXT: u32 = 32_768;
/// 上游 `ORCA_MODEL_NAME`
pub const MODEL_NAME: &str = "orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs";
/// 上游 `ORCA_CONFIG_FILE`
pub const CONFIG_FILE: &str = "strata-orca-iq3_xxs.json";
/// 上游 `ORCA_ARENA_GIB`（专家 arena 需要的系统内存）
pub const ARENA_GIB: f64 = 49.8;

const DOWNLOAD_HOST: &str = "https://hf-mirror.com";

/// 分片总字节。
pub fn total_bytes() -> u64 {
    SHARDS.iter().map(|(_, bytes)| *bytes).sum()
}

// ---------------------------------------------------------------------------
// 快照 / 任务
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaSnapshot {
    pub running: bool,
    pub phase: String,
    pub percent: f64,
    pub message: String,
    pub log_tail: Vec<String>,
    pub ok: Option<bool>,
    /// 下载目录（分片放这里，打包也从这里读）
    pub gguf_dir: String,
    /// pack 产物目录
    pub pack_dir: String,
    /// 生成的配置路径
    pub config_path: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
}

impl Default for OrcaSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            phase: String::new(),
            percent: 0.0,
            message: String::new(),
            log_tail: Vec::new(),
            ok: None,
            gguf_dir: String::new(),
            pack_dir: String::new(),
            config_path: String::new(),
            done_bytes: 0,
            total_bytes: total_bytes(),
        }
    }
}

pub struct OrcaJob {
    snapshot: Arc<Mutex<OrcaSnapshot>>,
    child: Arc<Mutex<Option<Child>>>,
    running: Arc<AtomicBool>,
}

impl OrcaJob {
    pub fn running(&mut self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn snapshot(&self) -> OrcaSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_default()
    }
}

/// 取消：置停止位并杀掉当前阶段的子进程（`curl` 与 `iq_pack.py` 都可能带子进程）。
pub fn stop(job: &mut OrcaJob) {
    job.running.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = job.child.lock() {
        if let Some(child) = slot.as_mut() {
            crate::logs::force_kill_tree(child.id(), child);
            let _ = child.wait();
        }
    }
    if let Ok(mut snapshot) = job.snapshot.lock() {
        snapshot.running = false;
        snapshot.ok = Some(false);
        snapshot.phase = "cancelled".into();
        snapshot.message = "已取消".into();
    }
}

// ---------------------------------------------------------------------------
// 前置探测
// ---------------------------------------------------------------------------

/// 前端「ORCA 面板」用：三条链路齐不齐、目录在哪、盘够不够。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaProbe {
    /// 三条链路（下载 / 打包 / 写配置）是否都具备
    pub available: bool,
    pub problems: Vec<String>,
    pub gguf_dir: String,
    pub pack_dir: String,
    pub config_path: String,
    pub download_bytes: u64,
    pub available_bytes: Option<u64>,
    /// pack 是否已经存在（装过就不用再下）
    pub pack_ready: bool,
    /// 分片是否已经齐（齐了可跳过下载）
    pub shards_ready: bool,
    pub arena_gib: f64,
}

struct Layout {
    control: PathBuf,
    python: PathBuf,
    data: PathBuf,
    configs: PathBuf,
    gguf_dir: PathBuf,
    pack_dir: PathBuf,
}

fn layout() -> Result<Layout, String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let control = crate::strata_tune::terminal_dir(&root).ok_or_else(|| {
        "未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）"
            .to_string()
    })?;
    let python = control.join("python").join(crate::strata_tune::python_name());
    let data = crate::strata_download::data_directory(&root);
    let configs = crate::strata::configs_dir(&root);
    Ok(Layout {
        python,
        gguf_dir: data.join("gguf").join("orca"),
        pack_dir: data.join("packs").join("orca-iq3_xxs"),
        data,
        configs,
        control,
    })
}

/// 当前引擎的可执行文件：先按控制端报的目录名找，找不到就挑最新修改的一个。
fn engine_exe() -> Option<PathBuf> {
    let root = crate::strata::root().filter(|root| root.is_dir())?;
    let engines = root.join("engine");
    let name = if cfg!(windows) { "strata.exe" } else { "strata" };
    if let Ok(state) = crate::strata::engine_state() {
        if let Some(folder) = state.folder {
            let candidate = engines.join(folder).join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&engines).ok()? {
        let path = entry.ok()?.path();
        let exe = path.join(name);
        if !exe.is_file() {
            continue;
        }
        let stamp = exe
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().map(|(old, _)| stamp > *old).unwrap_or(true) {
            best = Some((stamp, exe));
        }
    }
    best.map(|(_, exe)| exe)
}

pub fn probe() -> OrcaProbe {
    let mut report = OrcaProbe {
        arena_gib: ARENA_GIB,
        download_bytes: total_bytes(),
        ..Default::default()
    };
    let layout = match layout() {
        Ok(layout) => layout,
        Err(err) => {
            report.problems.push(err);
            return report;
        }
    };
    report.gguf_dir = layout.gguf_dir.display().to_string();
    report.pack_dir = layout.pack_dir.display().to_string();
    report.config_path = layout.configs.join(CONFIG_FILE).display().to_string();

    if !layout.python.is_file() {
        report
            .problems
            .push(format!("控制端缺少解释器：{}", layout.python.display()));
    }
    let packer = layout.control.join("tools").join("iq_pack.py");
    if !packer.is_file() {
        report
            .problems
            .push(format!("控制端缺少 tools/iq_pack.py：{}", packer.display()));
    }
    if engine_exe().is_none() {
        report
            .problems
            .push("未找到 Strata 引擎（先装一个引擎再导入 ORCA）".to_string());
    }
    report.available_bytes = crate::strata_download::volume_root(&layout.data)
        .and_then(|volume| crate::strata_download::free_bytes(&volume));
    report.pack_ready = layout.pack_dir.join("tokenizer").join("vocab.json").is_file();
    report.shards_ready = SHARDS.iter().all(|(name, bytes)| {
        layout
            .gguf_dir
            .join(name)
            .metadata()
            .map(|meta| meta.len() == *bytes)
            .unwrap_or(false)
    });
    report.available = report.problems.is_empty();
    report
}

// ---------------------------------------------------------------------------
// 任务执行
// ---------------------------------------------------------------------------

fn note(snapshot: &Arc<Mutex<OrcaSnapshot>>, hub: &Arc<LogHub>, text: &str) {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut snapshot) = snapshot.lock() {
        snapshot.log_tail.push(trimmed.to_string());
        if snapshot.log_tail.len() > 240 {
            let extra = snapshot.log_tail.len() - 240;
            snapshot.log_tail.drain(..extra);
        }
        snapshot.message = trimmed.to_string();
    }
    hub.push("strata", trimmed.to_string());
}

fn set_phase(snapshot: &Arc<Mutex<OrcaSnapshot>>, phase: &str, percent: f64, message: &str) {
    if let Ok(mut snapshot) = snapshot.lock() {
        snapshot.phase = phase.to_string();
        snapshot.percent = percent;
        snapshot.message = message.to_string();
    }
}

fn drain<R: Read>(reader: R, snapshot: Arc<Mutex<OrcaSnapshot>>, hub: Arc<LogHub>) {
    let mut buffer = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match buffer.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => note(&snapshot, &hub, &line),
            Err(_) => break,
        }
    }
}

/// 起一次 ORCA 导入（后台线程跑三步，立刻返回任务供前端轮询）。
pub fn start(hub: Arc<LogHub>) -> Result<(Option<OrcaJob>, String), String> {
    let layout = layout()?;
    if !layout.python.is_file() {
        return Err(format!("控制端缺少解释器：{}", layout.python.display()));
    }
    let packer = layout.control.join("tools").join("iq_pack.py");
    if !packer.is_file() {
        return Err(format!("控制端缺少 tools/iq_pack.py：{}", packer.display()));
    }
    let exe = engine_exe().ok_or_else(|| "未找到 Strata 引擎，先装一个引擎再导入 ORCA".to_string())?;
    if let Some(parent) = layout.gguf_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::create_dir_all(&layout.gguf_dir).map_err(|err| format!("创建下载目录失败：{err}"))?;

    let snapshot = Arc::new(Mutex::new(OrcaSnapshot {
        running: true,
        phase: "download".into(),
        message: "准备下载 ORCA 分片".into(),
        gguf_dir: layout.gguf_dir.display().to_string(),
        pack_dir: layout.pack_dir.display().to_string(),
        config_path: layout.configs.join(CONFIG_FILE).display().to_string(),
        total_bytes: total_bytes(),
        ..Default::default()
    }));
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let running = Arc::new(AtomicBool::new(true));

    {
        let snapshot = Arc::clone(&snapshot);
        let slot = Arc::clone(&child_slot);
        let running = Arc::clone(&running);
        std::thread::spawn(move || {
            let outcome = flow(&snapshot, &slot, &running, &hub, &layout, &exe);
            let mut guard = snapshot.lock().unwrap_or_else(|err| err.into_inner());
            guard.running = false;
            match outcome {
                Ok(true) => {
                    guard.ok = Some(true);
                    guard.phase = "done".into();
                    guard.percent = 100.0;
                }
                Ok(false) => {
                    // 被用户取消：`stop()` 已经把快照写成 cancelled
                }
                Err(err) => {
                    guard.ok = Some(false);
                    guard.phase = "failed".into();
                    guard.message = err;
                }
            }
            drop(guard);
            running.store(false, Ordering::SeqCst);
        });
    }

    Ok((
        Some(OrcaJob {
            snapshot,
            child: child_slot,
            running,
        }),
        format!(
            "ORCA（{QUANT}）导入已开始：先下 {} GB 分片，再打包，最后写配置",
            (total_bytes() as f64 / 1e9).round()
        ),
    ))
}

/// 三步流程。返回 `Ok(true)` 表示走完，`Ok(false)` 表示用户取消。
fn flow(
    snapshot: &Arc<Mutex<OrcaSnapshot>>,
    slot: &Arc<Mutex<Option<Child>>>,
    running: &Arc<AtomicBool>,
    hub: &Arc<LogHub>,
    layout: &Layout,
    exe: &Path,
) -> Result<bool, String> {
    let total = total_bytes();
    // ---- 1. 下载两个分片 ----
    for (index, (name, expected)) in SHARDS.iter().enumerate() {
        let path = layout.gguf_dir.join(name);
        let have = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        if have == *expected {
            note(
                snapshot,
                hub,
                &format!("分片 {} 已完整，跳过下载（{}）", index + 1, path.display()),
            );
            continue;
        }
        let url = format!("{}/{}/resolve/{}/{}", DOWNLOAD_HOST, REPO, REVISION, name);
        set_phase(
            snapshot,
            "download",
            if index == 0 { 0.0 } else { 35.0 },
            &format!("正在下载分片 {}/2：{}", index + 1, name),
        );
        let mut cmd = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
        cmd.arg("-L")
            .arg("-C")
            .arg("-")
            .arg("--fail")
            .arg("--retry")
            .arg("2")
            .arg("--connect-timeout")
            .arg("15")
            .arg("-o")
            .arg(&path)
            .arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::winfix::hide_console(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|err| format!("启动 curl 失败：{err}"))?;
        if let Some(stream) = child.stderr.take() {
            let snapshot = Arc::clone(snapshot);
            let hub = Arc::clone(hub);
            std::thread::spawn(move || drain(stream, snapshot, hub));
        }
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(child);
        }
        let began = Instant::now();
        loop {
            if !running.load(Ordering::SeqCst) {
                return Ok(false);
            }
            let status = {
                let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
                guard.as_mut().map(|child| child.try_wait())
            };
            match status {
                None => return Err("子进程丢了，请重试".into()),
                Some(Ok(Some(status))) => {
                    if !status.success() {
                        return Err(format!(
                            "下载分片 {} 失败（curl 退出码 {:?}）",
                            index + 1,
                            status.code()
                        ));
                    }
                    break;
                }
                Some(Ok(None)) => {}
                Some(Err(err)) => return Err(format!("等待 curl 失败：{err}")),
            }
            let done: u64 = SHARDS
                .iter()
                .map(|(name, _)| {
                    std::fs::metadata(layout.gguf_dir.join(name))
                        .map(|meta| meta.len())
                        .unwrap_or(0)
                })
                .sum();
            if let Ok(mut guard) = snapshot.lock() {
                guard.done_bytes = done;
                guard.percent = (done.min(total) as f64 / total as f64) * 70.0;
                guard.message = format!(
                    "正在下载分片 {}/2：{:.1} / {:.1} GB（{} 秒）",
                    index + 1,
                    done as f64 / 1e9,
                    total as f64 / 1e9,
                    began.elapsed().as_secs()
                );
            }
            std::thread::sleep(Duration::from_millis(700));
        }
        if let Ok(mut guard) = slot.lock() {
            *guard = None;
        }
    }

    // ---- 2. 打包（iq_pack.py 自己读其余分片并导出 tokenizer/）----
    set_phase(
        snapshot,
        "pack",
        70.0,
        "正在打包（iq_pack，85 GB 输入，通常十几分钟）",
    );
    let shard1 = layout.gguf_dir.join(SHARDS[0].0);
    let mut cmd = Command::new(&layout.python);
    cmd.current_dir(&layout.control)
        .arg("-u")
        .arg("tools/iq_pack.py")
        .arg("--gguf")
        .arg(&shard1)
        .arg("--out")
        .arg(&layout.pack_dir)
        .arg("--compat-bf16")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::winfix::hide_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动 iq_pack.py 失败：{err}"))?;
    if let Some(stream) = child.stdout.take() {
        let snapshot = Arc::clone(snapshot);
        let hub = Arc::clone(hub);
        std::thread::spawn(move || drain(stream, snapshot, hub));
    }
    if let Some(stream) = child.stderr.take() {
        let snapshot = Arc::clone(snapshot);
        let hub = Arc::clone(hub);
        std::thread::spawn(move || drain(stream, snapshot, hub));
    }
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(child);
    }
    loop {
        if !running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let status = {
            let mut guard = slot.lock().unwrap_or_else(|err| err.into_inner());
            guard.as_mut().map(|child| child.try_wait())
        };
        match status {
            None => return Err("子进程丢了，请重试".into()),
            Some(Ok(Some(status))) => {
                if !status.success() {
                    return Err(format!(
                        "打包失败（iq_pack.py 退出码 {:?}），看日志",
                        status.code()
                    ));
                }
                break;
            }
            Some(Ok(None)) => {}
            Some(Err(err)) => return Err(format!("等待 iq_pack.py 失败：{err}")),
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if let Ok(mut guard) = slot.lock() {
        *guard = None;
    }

    // ---- 3. 写配置 ----
    set_phase(snapshot, "config", 96.0, "正在生成配置");
    let config = config_json(layout, &shard1, exe)?;
    std::fs::create_dir_all(&layout.configs).map_err(|err| format!("创建配置目录失败：{err}"))?;
    let path = layout.configs.join(CONFIG_FILE);
    let text =
        serde_json::to_string_pretty(&config).map_err(|err| format!("序列化配置失败：{err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("写配置失败：{err}"))?;
    note(
        snapshot,
        hub,
        &format!("已生成配置：{}", path.display()),
    );
    Ok(true)
}

/// 生成 `<configs>\strata-orca-iq3_xxs.json`。
///
/// 字段来源：本机 `E:\AI\strata\strata-gyro-gyro-s.json`（同一套 `StrataConfig`），
/// 关键键（`--pack` / `--native` / `--max-context` / `--kv int8` / `tokenizer`）来自
/// 上游 `crates/runtime-core/src/orca_import.rs:482-523`。
fn config_json(layout: &Layout, shard1: &Path, exe: &Path) -> Result<serde_json::Value, String> {
    use serde_json::json;

    let pack = layout.pack_dir.display().to_string();
    let tokenizer = layout.pack_dir.join("tokenizer").display().to_string();
    let _ = std::fs::create_dir_all(layout.data.join("logs"));
    let log = layout.data.join("logs").join("orca.log").display().to_string();
    Ok(json!({
        "exe": exe.display().to_string(),
        "args": [
            "--pack", pack,
            "--native", shard1.display().to_string(),
            "--max-context", CONTEXT.to_string(),
            "--kv", "int8",
            "--vram-reserve-mib", "256"
        ],
        "cwd": layout.gguf_dir.display().to_string(),
        "tokenizer": tokenizer,
        "model_name": MODEL_NAME,
        "log": log,
        "port": free_port(layout),
        "gpu": 0,
        "gpus_asked": true,
        "sampling": {
            "temperature": 1.0,
            "top_p": 0.95,
            "top_k": 20,
            "min_p": 0.05
        }
    }))
}

/// 挑一个没被现有 `strata-*.json` 占用的端口（9094 起）。
fn free_port(layout: &Layout) -> u16 {
    let mut used = std::collections::BTreeSet::new();
    if let Ok(entries) = std::fs::read_dir(&layout.configs) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(port) = value.get("port").and_then(|port| port.as_u64()) {
                        used.insert(port as u16);
                    }
                }
            }
        }
    }
    (9094u16..9200)
        .find(|port| !used.contains(port))
        .unwrap_or(9199)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_layout() -> Layout {
        Layout {
            control: PathBuf::from("C:/strata/control/0.1.52"),
            python: PathBuf::from("C:/strata/control/0.1.52/python/python.exe"),
            data: PathBuf::from("C:/strata-data"),
            configs: PathBuf::from("C:/strata-data/configs"),
            gguf_dir: PathBuf::from("C:/strata-data/gguf/orca"),
            pack_dir: PathBuf::from("C:/strata-data/packs/orca-iq3_xxs"),
        }
    }

    #[test]
    fn shard_total_matches_upstream() {
        assert_eq!(total_bytes(), 85_202_668_032);
    }

    #[test]
    fn config_carries_pack_context_and_tokenizer() {
        let layout = sample_layout();
        let config = config_json(
            &layout,
            Path::new("C:/strata-data/gguf/orca/shard1.gguf"),
            Path::new("C:/strata/engine/0.1.52/strata.exe"),
        )
        .expect("配置应能生成");
        let text = config.to_string();
        assert!(text.contains("--pack"), "缺 --pack：{text}");
        assert!(text.contains("--max-context"), "缺 --max-context：{text}");
        assert!(text.contains("tokenizer"), "缺 tokenizer：{text}");
        assert_eq!(
            config.get("model_name").and_then(|item| item.as_str()),
            Some(MODEL_NAME)
        );
        assert_eq!(
            config
                .get("args")
                .and_then(|args| args.as_array())
                .map(|args| args.len()),
            Some(10)
        );
    }

    #[test]
    fn port_is_picked_above_used_ones() {
        let layout = sample_layout();
        let port = free_port(&layout);
        assert!((9094..9200).contains(&port));
    }

    /// 本机核对用：`cargo test --lib strata_orca -- --ignored --nocapture`
    #[test]
    #[ignore = "需要本机装好 Strata 控制端与引擎"]
    fn probe_reports_layout_on_this_machine() {
        // 命令行测试进程里没有 GUI 设置页存的 Strata 根，手工指一次再探测。
        crate::strata::configure_root(Some(PathBuf::from("E:\\AI\\Strata")));
        let report = super::probe();
        println!("{report:?}");
        assert!(report.available, "本机应可用：{:?}", report.problems);
    }
}
