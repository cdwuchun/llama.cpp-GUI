//! llama.cpp 通道的模型调度器（统一前门内部使用）。
//!
//! 前门只对外暴露一个端口（默认 9090），客户端按请求里的 `model` 选模型；
//! 调度器负责回答「这个模型现在在不在跑」——不在就拉起对应的 `llama-server`
//! 子实例，在跑就直接转发。规格见 `PROXY_SCHEDULER_PLAN.md` §4。
//!
//! 本模块只放**纯状态与决策逻辑**（可单测）；真正 spawn 子进程、等就绪、代理转发
//! 放在后续的 `frontdoor` 里做（P1 后半）。决策规则与 router 同源，
//! 见 `PROXY_SCHEDULER_PLAN.md` §1（`pick_victim` 的忙碌保护、`load()` 的二次容量检查）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::AppHandle;

use crate::model_config::{self, ModelConfig};
use crate::logs::{self, LogHub};
use crate::state::AppState;
use crate::versions::LlamaCppVersion;

/// 单个模型的生命周期（`PROXY_SCHEDULER_PLAN.md` §4.1）。
///
/// ```text
/// idle ──start()──▶ starting ──就绪──▶ ready ──stop()──▶ stopping ──▶ idle
///   ▲                  │                                              │
///   └──────────────────┴──────── failed（启动失败/超时/OOM）──────────┘
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelState {
    /// 没在跑（也没有进程）。
    Idle,
    /// 已 spawn，正在等 `/health` 变 200。
    Starting,
    /// 就绪，可转发。
    Ready,
    /// 正在停（等进程退出；超时后强杀）。
    #[allow(dead_code)] // P2 预留：停模型当前走同步路径，没有中间态
    Stopping,
    /// 启动失败/超时，`error` 里留着原因与日志尾部。
    Failed,
}

impl ModelState {
    /// 给前端与日志用的短名。
    pub fn as_str(self) -> &'static str {
        match self {
            ModelState::Idle => "idle",
            ModelState::Starting => "starting",
            ModelState::Ready => "ready",
            ModelState::Stopping => "stopping",
            ModelState::Failed => "failed",
        }
    }

    /// 是否占着一个子进程（也就是占着显存）。
    ///
    /// `Failed` 不算：失败路径上进程已经杀掉了，留着它会让容量判断永远少一格。
    pub fn holds_process(self) -> bool {
        matches!(
            self,
            ModelState::Starting | ModelState::Ready | ModelState::Stopping
        )
    }
}

/// 一个模型的运行期记录。
#[derive(Debug, Clone)]
#[allow(dead_code)] // P2 预留：port/pid/error 供状态上报用，目前状态取自 config
pub struct ModelRuntime {
    /// 模型 id（= 配置文件名主体 = 请求里的 `model`）。
    pub id: String,
    /// 子实例端口（每模型固定，只增不回收，见 `PROXY_SCHEDULER_PLAN.md` §3.3）。
    pub port: u16,
    pub state: ModelState,
    /// 子进程 pid（`Idle`/`Failed` 时为 `None`）。
    pub pid: Option<u32>,
    /// 最近一次被请求的时间戳（毫秒）。LRU 淘汰的唯一依据。
    pub last_used_ms: u64,
    /// 启动失败原因（日志尾部），`Failed` 时给客户端看。
    pub error: Option<String>,
    /// 正在转发的请求数（`> 0` 时这个模型「在用」，容量不够时不能停它）。
    pub active: usize,
}

impl ModelRuntime {
    #[allow(dead_code)] // P2 预留：新建运行期记录的入口
    pub fn new(id: impl Into<String>, port: u16) -> Self {
        Self {
            id: id.into(),
            port,
            state: ModelState::Idle,
            pid: None,
            last_used_ms: 0,
            error: None,
            active: 0,
        }
    }

    /// 记一次使用（转发成功后调用）。
    pub fn touch(&mut self, now_ms: u64) {
        self.last_used_ms = now_ms;
    }

    /// 是否有请求正在转发：router 的 `pick_victim` 也不动 `req_count != 0` 的模型。
    pub fn is_busy(&self) -> bool {
        self.active > 0
    }
}

/// 全部模型的运行期表。键是模型 id。
#[derive(Debug, Default)]
pub struct ModelTable {
    items: HashMap<String, ModelRuntime>,
}

#[allow(dead_code)] // P2 预留：get/get_mut/ids/runtime/active_count 是容量策略要用的读接口
impl ModelTable {
    pub fn get(&self, id: &str) -> Option<&ModelRuntime> {
        self.items.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut ModelRuntime> {
        self.items.get_mut(id)
    }

    pub fn insert(&mut self, runtime: ModelRuntime) {
        self.items.insert(runtime.id.clone(), runtime);
    }

    pub fn remove(&mut self, id: &str) -> Option<ModelRuntime> {
        self.items.remove(id)
    }

    /// 全部 id，排序后返回（给 `/v1/models` 一个稳定顺序）。
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.items.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn runtime(&self, id: &str) -> Option<&ModelRuntime> {
        self.items.get(id)
    }

    /// 记一次使用（转发成功后调用）：淘汰时按这个时间挑最久未用的。
    pub fn touch(&mut self, id: &str, now_ms: u64) {
        if let Some(item) = self.items.get_mut(id) {
            item.touch(now_ms);
        }
    }

    pub fn state_of(&self, id: &str) -> ModelState {
        self.items
            .get(id)
            .map(|item| item.state)
            .unwrap_or(ModelState::Idle)
    }

    /// 开始一次转发（前门在转发前调用）：这个模型此时不能被淘汰。
    pub fn begin_request(&mut self, id: &str) {
        if let Some(item) = self.items.get_mut(id) {
            item.active += 1;
        }
    }

    /// 转发结束（正常/出错都要调，否则模型会永远被当成「在用」）。
    pub fn end_request(&mut self, id: &str) {
        if let Some(item) = self.items.get_mut(id) {
            item.active = item.active.saturating_sub(1);
        }
    }

    /// 有请求在转发的模型 id（容量淘汰时要避开）。
    pub fn busy_ids(&self) -> Vec<String> {
        self.items
            .values()
            .filter(|item| item.is_busy())
            .map(|item| item.id.clone())
            .collect()
    }

    /// 正在占进程的模型数（容量上限判定的分子）。
    pub fn active_count(&self) -> usize {
        self.items
            .values()
            .filter(|item| item.state.holds_process())
            .count()
    }

    /// 是否已达容量上限。
    ///
    /// `exclude` 是「本次要启动的那个模型」：它自己已经在表里时不该把自己算进去，
    /// 否则重复请求同一个模型会被误判成超限。
    pub fn at_capacity(&self, max: usize, exclude: &str) -> bool {
        self.items
            .values()
            .filter(|item| item.id != exclude)
            .filter(|item| item.state.holds_process())
            .count()
            >= max
    }

    /// 挑一个可以停掉的模型，给新模型腾显存：**最久未用**优先。
    ///
    /// 规则照抄 router 的 `pick_victim`（`PROXY_SCHEDULER_PLAN.md` §1）：
    /// 正在生成的（`busy` 为真）绝不动、正在启动/停止的不动、`exclude` 自己不动。
    /// 只淘汰 `Ready` —— `Idle`/`Failed` 本来就没进程，淘汰它们等于白停一次。
    pub fn pick_victim(&self, exclude: &str, busy: impl Fn(&str) -> bool) -> Option<String> {
        self.items
            .values()
            .filter(|item| item.id != exclude)
            .filter(|item| item.state == ModelState::Ready)
            .filter(|item| !busy(&item.id))
            .min_by_key(|item| item.last_used_ms)
            .map(|item| item.id.clone())
    }

    /// 空闲够久、且没有请求在转发的模型（按最久未用排序）。
    ///
    /// 空闲释放线程按这个挑人停：只挑 `Ready`（别的状态本来就没进程可停）、
    /// `active > 0` 的一律不动（正在生成的绝不能停），`last_used_ms` 落在 `idle_ms` 之前才算空闲。
    /// 单位都是毫秒（`last_used_ms` 由 `logs::now_ms()` 写）。
    pub fn idle_ids(&self, now_ms: u64, idle_ms: u64) -> Vec<String> {
        let mut idle: Vec<&ModelRuntime> = self
            .items
            .values()
            .filter(|item| item.state == ModelState::Ready)
            .filter(|item| !item.is_busy())
            .filter(|item| now_ms.saturating_sub(item.last_used_ms) >= idle_ms)
            .collect();
        idle.sort_by_key(|item| (item.last_used_ms, item.id.clone()));
        idle.into_iter().map(|item| item.id.clone()).collect()
    }
}

/// 启动超时（`PROXY_SCHEDULER_PLAN.md` §4.1；Strata 冷启实测 20–30 s，大模型更久）。
pub const START_TIMEOUT: Duration = Duration::from_secs(60);

/// 组装 `llama-server` 的命令行，返回 `(参数, 被剥掉的参数)`。
///
/// 顺序固定：`--model` / `--mmproj` → `--host` / `--port` → `--api-key` → `--no-webui`
/// → 配置里的 `args`。顶层字段生成的参数排在前面，配置里手写的
/// `--port` / `--host` / `--model` / `--mmproj` 一律剥掉并回报：重复参数 llama.cpp 取
/// **后**出现的那个，留着会让「配置里写的端口」与「实际绑定的端口」不一致
/// —— Strata 通道踩过这个坑（`src-tauri/src/strata.rs:538-546`）。
pub fn build_model_args(cfg: &ModelConfig, port: u16) -> (Vec<String>, Vec<String>) {
    let mut args: Vec<String> = Vec::new();
    if let Some(model) = non_empty(cfg.model.as_deref()) {
        args.push("--model".into());
        args.push(model);
    }
    if let Some(mmproj) = non_empty(cfg.mmproj.as_deref()) {
        args.push("--mmproj".into());
        args.push(mmproj);
    }
    args.push("--host".into());
    args.push(cfg.host.clone());
    args.push("--port".into());
    args.push(port.to_string());
    if let Some(key) = non_empty(cfg.api_key.as_deref()) {
        args.push("--api-key".into());
        args.push(key);
    }
    if cfg.no_webui {
        args.push("--no-webui".into());
    }
    let (kept, dropped) = model_config::strip_reserved_args(&cfg.args);
    args.extend(kept);
    // 监控页的引擎指标（请求数、KV 缓存占用、槽位速度）全靠 /metrics。llama-server 默认
    // 不开这个端点，未开时返回 501 "This server does not support metrics endpoint"
    // （用户 m05810 第 1 点）。它只是多挂一个只读端点，对推理没有影响，所以默认带上；
    // 配置里自己写了就不重复加。
    if !args.iter().any(|item| item == "--metrics") {
        args.push("--metrics".into());
    }
    (args, dropped)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// 「不选 = 自动检测同目录文件」（用户 m08378 第 3 点）
//
// 模型参数表里的「多模态投影文件」与「草稿模型路径」都允许留空。留空的意思不是
// "什么都没有"，而是"照同目录里的文件自己认"：
//   - mmproj：llama.cpp 自己就会找主模型同目录的投影文件，GUI 补一条同目录路径
//     与它的结果一致（GUI 扫描器认得比上游宽 —— 作者目录那种"投影文件与模型不同目录"
//     的情况它也能认出来）；
//   - 草稿模型：llama.cpp **不会**自动找同目录的草稿文件。开了投机解码
//     （`--spec-type` 既不是 none 也不是 draft-mtp）却没给路径时，不补的话
//     llama.cpp 只会静默按"没有草稿模型"处理 —— 用户勾了草稿却什么也没发生。
// 只认文件名（`is_mmproj_name` / `is_draft_name`）；拿另一个小模型当草稿的用法
// 名字上认不出来，仍然要在参数表里显式选。
// ---------------------------------------------------------------------------

/// 要自动检测的辅助文件种类。
#[derive(Clone, Copy)]
enum AuxKind {
    Mmproj,
    Draft,
}

/// 参数表留空时按同目录自动补 mmproj / 草稿模型。
///
/// 返回补好的配置（**副本**，不写盘：写盘是用户保存参数表的事）与给日志看的说明。
fn auto_aux(cfg: &ModelConfig) -> (ModelConfig, Vec<String>) {
    let mut out = cfg.clone();
    let mut notes: Vec<String> = Vec::new();
    let Some(model) = non_empty(cfg.model.as_deref()) else {
        return (out, notes);
    };
    let Some(dir) = Path::new(&model).parent() else {
        return (out, notes);
    };

    if non_empty(out.mmproj.as_deref()).is_none() && !has_arg(&out.args, "--no-mmproj") {
        if let Some(found) = pick_aux_gguf(dir, AuxKind::Mmproj) {
            notes.push(format!("{} 没指定多模态投影文件，按同目录自动检测：{}", cfg.name, found));
            out.mmproj = Some(found);
        }
    }

    if needs_external_draft(&out.args)
        && !has_arg(&out.args, "--spec-draft-model")
        && !has_arg(&out.args, "--model-draft")
    {
        if let Some(found) = pick_aux_gguf(dir, AuxKind::Draft) {
            notes.push(format!("{} 没指定草稿模型路径，按同目录自动检测：{}", cfg.name, found));
            out.args.push("--spec-draft-model".into());
            out.args.push(found);
        } else {
            notes.push(format!(
                "{} 开了投机解码但同目录没有草稿模型文件，也没手动指定 —— 本次按没有草稿模型启动",
                cfg.name
            ));
        }
    }

    (out, notes)
}

/// `args` 里有没有这个开关（同时认 `--flag` 与 `--flag=value`）。
fn has_arg(args: &[String], flag: &str) -> bool {
    args.iter()
        .any(|a| a == flag || a.starts_with(&format!("{flag}=")))
}

/// 投机解码用的草稿模型类型里，哪些**必须**配一个外部草稿模型文件。
///
/// `draft-mtp` 的草稿头长在主模型里（`models.rs` 的注释同一件事），留空才是对的。
fn needs_external_draft(args: &[String]) -> bool {
    let mut last: Option<&str> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--spec-type=") {
            last = Some(value);
        } else if arg == "--spec-type" {
            if let Some(value) = iter.next() {
                last = Some(value);
            }
        }
    }
    match last.map(str::trim).map(str::to_ascii_lowercase) {
        Some(value) => !value.is_empty() && value != "none" && value != "draft-mtp",
        None => false,
    }
}

/// 在 `dir` 里挑一个该种类的 gguf（多个时取最大的那个 —— 与扫描器挑 mmproj 同一策略）。
fn pick_aux_gguf(dir: &Path, kind: AuxKind) -> Option<String> {
    let mut best: Option<(u64, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_string();
        if !name.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        let matched = match kind {
            AuxKind::Mmproj => crate::models::is_mmproj_name(&name),
            AuxKind::Draft => crate::models::is_draft_name(&name),
        };
        if !matched {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|(b, _)| size > *b).unwrap_or(true) {
            best = Some((size, path));
        }
    }
    best.map(|(_, p)| p.to_string_lossy().to_string())
}

/// 探一次 `GET /health`：端口没开、或还在加载，都算「没就绪」。
///
/// 只看端口连通是不够的 —— llama.cpp 在加载模型期间照样监听，但回 503；
/// 那时候转发过去客户端拿到的是 503，而不是结果。
fn health_ready(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let req = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.1 200")
}

/// 一个已拉起的子实例。
#[derive(Debug)]
#[allow(dead_code)] // P2 预留：port/started_at_ms 供运行期统计用
pub struct ModelProcess {
    pub id: String,
    pub child: Child,
    pub pid: u32,
    pub port: u16,
    pub started_at_ms: u64,
}

/// 把一个子进程的输出流接进日志中心（source 记作 `model:<名称>`）。
///
/// 前端「日志按模型过滤」直接吃这个 source（`PROXY_SCHEDULER_PLAN.md` §5）。
fn spawn_model_reader<R: Read + Send + 'static>(
    stream: R,
    hub: Arc<LogHub>,
    tx: mpsc::Sender<logs::LogLine>,
    name: String,
) {
    std::thread::spawn(move || {
        let source = format!("model:{name}");
        let reader = BufReader::new(stream);
        for line in reader.split(b'\n') {
            let Ok(bytes) = line else { break };
            let text = String::from_utf8_lossy(&bytes)
                .trim_end_matches('\r')
                .to_string();
            if text.trim().is_empty() {
                continue;
            }
            let entry = hub.push(&source, text);
            if tx.send(entry).is_err() {
                break;
            }
        }
    });
}

/// 拉起一个模型的 `llama-server`，等它 `/health` 回 200 才返回。
///
/// 失败时**必须**先把子进程杀掉再返回（`std::process::Child` 的析构不杀进程，
/// 而这时候句柄还没进调度表，界面永远停不掉它 —— 残留进程会占着端口与显存）。
pub fn spawn_model(
    app: &AppHandle,
    hub: Arc<LogHub>,
    version: &LlamaCppVersion,
    cfg: &ModelConfig,
    port: u16,
    link_root: &Path,
) -> Result<ModelProcess, String> {
    // 非 ASCII 路径修复：与 router 同一条路（llama.cpp 在非 ASCII 目录下起不来）。
    let ascii_dir = crate::winfix::ensure_ascii_dir(&version.dir, link_root)
        .map_err(|err| format!("{err:#}"))?;
    let exe_name = version
        .server_bin
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_else(|| {
            std::ffi::OsString::from(if cfg!(windows) {
                "llama-server.exe"
            } else {
                "llama-server"
            })
        });
    let server_bin = ascii_dir.join(exe_name);

    // 「不选 = 自动检测同目录文件」：补出来的参数只作用于本次启动，不写回配置文件。
    let (cfg, aux_notes) = auto_aux(cfg);
    let cfg = &cfg;

    let (args, dropped) = build_model_args(cfg, port);
    if !dropped.is_empty() {
        eprintln!(
            "[scheduler] {} 的配置里手写了这些参数，已忽略（由顶层字段决定）：{}",
            cfg.name,
            dropped.join(" ")
        );
    }

    let mut cmd = Command::new(&server_bin);
    cmd.args(&args);
    cmd.current_dir(&ascii_dir);
    cmd.env(
        "PATH",
        crate::versions::compose_path_env(version, std::env::var_os("PATH")),
    );
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    crate::winfix::hide_console(&mut cmd);

    hub.push(
        "system",
        format!(
            "[gui] 启动模型 {}：{} {}",
            cfg.name,
            server_bin.display(),
            logs::redact_args(&args).join(" ")
        ),
    );
    for note in &aux_notes {
        hub.push("system", format!("[gui] {note}"));
    }

    let mut child = cmd
        .spawn()
        .map_err(|err| format!("启动 llama-server 失败: {err}"))?;
    let pid = child.id();
    let started_at_ms = logs::now_ms();

    // 顺序关键：读线程必须在「等就绪」之前挂上。Windows 匿名管道缓冲区只有几 KB，
    // 子进程启动期输出一多就堵在 write 上，永远不监听（实测 3 个模型的 stderr 就有 3.6KB）。
    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        spawn_model_reader(stdout, Arc::clone(&hub), tx.clone(), cfg.name.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_model_reader(stderr, Arc::clone(&hub), tx.clone(), cfg.name.clone());
    }
    drop(tx);
    logs::spawn_pump(app.clone(), Arc::clone(&hub), rx);

    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if health_ready(port) {
            hub.push(
                "system",
                format!("[gui] {} 已在 127.0.0.1:{port} 就绪", cfg.name),
            );
            return Ok(ModelProcess {
                id: cfg.name.clone(),
                child,
                pid,
                port,
                started_at_ms,
            });
        }
        match child.try_wait() {
            Ok(Some(exit)) => {
                // 能在这里 try_wait 到，说明句柄还没交给调度表 —— 失败分支杀进程的责任在本地。
                let msg = format!(
                    "{} 启动后立刻退出（退出码 {:?}）。常见原因：显存不够（上下文或 --fit 分配过大）、\
                     API Key 与前端不一致、参数已被当前 llama.cpp 淘汰（日志里搜 option … not recognized）；\
                     完整原因在「系统日志」页的该模型标签里。",
                    cfg.name,
                    exit.code()
                );
                hub.push("system", format!("[gui] {msg}"));
                return Err(msg);
            }
            Ok(None) => {}
            Err(err) => {
                logs::force_kill_tree(pid, &mut child);
                return Err(format!("等待 {} 启动失败: {err}", cfg.name));
            }
        }
        if Instant::now() >= deadline {
            let msg = format!(
                "{} 在 {} 秒内没有就绪（/health 未回 200），请看日志",
                cfg.name,
                START_TIMEOUT.as_secs()
            );
            hub.push("system", format!("[gui] {msg}"));
            logs::force_kill_tree(pid, &mut child);
            return Err(msg);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

/// 停止一个子实例（连它的进程树一起）。
pub fn stop_model(process: &mut ModelProcess, hub: &Arc<LogHub>) -> Option<u32> {
    let pid = process.pid;
    logs::force_kill_tree(pid, &mut process.child);
    hub.push("system", format!("[gui] 已停止模型 {}", process.id));
    Some(pid)
}

/// 等调度器锁超过这个时长就记一行（毫秒）。
const SLOW_LOCK_MS: u128 = 500;

/// 取调度器锁，并记录等待时长。
///
/// 用户 m05816 报的现场是「前门连得上但不回包、卡片状态不再更新」——起因是有人持着这把锁在等
/// taskkill 收尾。光看日志分不出卡在哪一段，所以凡是要这把锁都走这里：超过 `SLOW_LOCK_MS`
/// 就往日志面板（并落盘）写一行，带调用点，一眼看出是谁在等。
#[track_caller]
pub fn lock_sched(state: &AppState) -> std::sync::MutexGuard<'_, Scheduler> {
    let t0 = Instant::now();
    let guard = state.scheduler.lock().unwrap_or_else(|e| e.into_inner());
    let ms = t0.elapsed().as_millis();
    if ms >= SLOW_LOCK_MS {
        let loc = std::panic::Location::caller();
        state.logs.push(
            "system",
            format!("[慢] 等调度器锁 {ms} ms（{}:{}）", loc.file(), loc.line()),
        );
    }
    guard
}

// ---- 调度器状态：与前门共用的那一份 ----

/// 调度器：谁在跑、跑在哪个端口、要不要腾地方。
///
/// 状态表与进程句柄分开放：状态表按 id 频繁读（`/v1/models` 每次都查），
/// 句柄只在启动/停止时动，且不是 `Clone`。
#[derive(Debug, Default)]
pub struct Scheduler {
    table: ModelTable,
    processes: HashMap<String, ModelProcess>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self::default()
    }

    /// 运行期表（只读）：`/v1/models` 与界面用它看状态。
    pub fn table(&self) -> &ModelTable {
        &self.table
    }

    /// 运行期表（可写）：前门转发前后要记「这个模型在用」。
    pub fn table_mut(&mut self) -> &mut ModelTable {
        &mut self.table
    }

    /// 停掉一个模型：强杀进程树，状态回 `Idle`。返回是否真的杀掉了进程。
    pub fn stop(&mut self, id: &str, hub: &Arc<LogHub>) -> bool {
        self.table.remove(id);
        match self.processes.remove(id) {
            Some(mut process) => {
                stop_model(&mut process, hub);
                true
            }
            // 句柄不在手上（进程是外面起的，或者启动失败已经杀过）：只清状态。
            None => false,
        }
    }

    /// 退出程序时把所有子实例停掉，返回停过的 id。
    ///
    /// 必须显式做：`Child` 的析构不杀进程，GUI 一退这些 llama-server 会留着占显存。
    pub fn stop_all(&mut self, hub: &Arc<LogHub>) -> Vec<String> {
        let ids: Vec<String> = self.processes.keys().cloned().collect();
        for id in &ids {
            self.stop(id, hub);
        }
        ids
    }
}

/// 按当前设置里的上限立刻收敛一次：多出来的（最久未用的先）停掉，返回停过的 id。
///
/// 上限本来就在每次加载新模型时实时读（`ensure_ready` 的容量闸），但那是「下一条请求」才判定；
/// 用户把上限改小并保存后不会再加载别的模型，光等那一刻会显得设置没生效 —— 所以在保存当时收一次
/// （用户 m06652）。全都在用（`active > 0`）或都在启动中的一律不动，收不下去就停手。
pub fn enforce_capacity(state: &AppState) -> Vec<String> {
    let max = state.settings.get().models_max.max(1) as usize;
    let hub = Arc::clone(&state.logs);
    let mut stopped = Vec::new();
    loop {
        let victim = {
            let sched = lock_sched(state);
            if sched.table().active_count() <= max {
                break;
            }
            let busy: std::collections::HashSet<String> =
                sched.table().busy_ids().into_iter().collect();
            sched.table().pick_victim("", |id| busy.contains(id))
        };
        let Some(victim) = victim else { break };
        let mut sched = lock_sched(state);
        sched.stop(&victim, &hub);
        state.logs.push(
            "system",
            format!("[gui] 同时加载上限 {max}：已停掉最久未用的 {victim}"),
        );
        stopped.push(victim);
    }
    stopped
}

/// 确保某个模型可用：必要时拉起子实例，返回它监听的端口。
///
/// 状态流转都在锁内判定，避免两个请求同时走到 spawn。
pub fn ensure_ready(app: &AppHandle, state: &AppState, id: &str) -> Result<u16, String> {
    // 配置缺失 / 没端口时**自动补**，不再要求用户先去点一次「同步」（用户 m08378 第 2 点：
    // 那是被替换掉的 router 才需要的规矩）。
    let item = ensure_config_for(state, id)?;
    let port = item
        .config
        .port
        .ok_or_else(|| format!("模型 {} 未能分配端口", item.id))?;
    let hub = Arc::clone(&state.logs);

    // 版本解析放在插表项之前：解析失败时必须原样返回，不能先插一条 Starting 再 `?`
    // 早退 —— 那会让这个模型永久停在「正在启动」，后续请求全部 503（审查发现）。
    let settings = state.settings.get();
    let version = resolve_version(state, &settings)?;

    {
        let mut sched = lock_sched(state);
        match sched.table.state_of(&item.id) {
            ModelState::Ready => {
                sched.table.touch(&item.id, logs::now_ms());
                return Ok(port);
            }
            ModelState::Starting => {
                return Err(format!("模型 {} 正在启动，请稍后重试", item.id));
            }
            ModelState::Stopping => {
                return Err(format!("模型 {} 正在停止，请稍后重试", item.id));
            }
            ModelState::Idle | ModelState::Failed => {}
        }
        // 容量闸：到顶了先腾地方（挑最久未用的 ready 模型；正在转发请求的不能动）。
        let max = state.settings.get().models_max.max(1) as usize;
        if sched.table.at_capacity(max, &item.id) {
            let busy: std::collections::HashSet<String> =
                sched.table.busy_ids().into_iter().collect();
            match sched.table.pick_victim(&item.id, |id| busy.contains(id)) {
                Some(victim) => {
                    hub.push(
                        "system",
                        format!("[gui] 已满 {max} 个模型，先停掉最久未用的 {victim}"),
                    );
                    sched.stop(&victim, &hub);
                }
                None => {
                    return Err(format!(
                        "同时最多 {max} 个模型，当前没有可淘汰的空闲模型（都在用）"
                    ))
                }
            }
        }
        sched.table.insert(ModelRuntime {
            id: item.id.clone(),
            port,
            state: ModelState::Starting,
            pid: None,
            last_used_ms: logs::now_ms(),
            error: None,
            active: 0,
        });
    }

    let link_root = state.link_root();
    let spawned = spawn_model(
        app,
        Arc::clone(&hub),
        &version,
        &item.config,
        port,
        &link_root,
    );

    let mut sched = lock_sched(state);
    match spawned {
        Ok(process) => {
            let pid = process.pid;
            sched.processes.insert(item.id.clone(), process);
            sched.table.insert(ModelRuntime {
                id: item.id.clone(),
                port,
                state: ModelState::Ready,
                pid: Some(pid),
                last_used_ms: logs::now_ms(),
                error: None,
                active: 0,
            });
            Ok(port)
        }
        Err(err) => {
            sched.table.insert(ModelRuntime {
                id: item.id.clone(),
                port,
                state: ModelState::Failed,
                pid: None,
                last_used_ms: logs::now_ms(),
                error: Some(err.clone()),
                active: 0,
            });
            Err(err)
        }
    }
}

/// 按 id 从配置目录里找一份配置（id 允许写成未转义的原名）。
///
/// 找到后先在内存里过一遍 `sanitize_config`：淘汰键会让子实例起不来，裸写的取值型
/// 开关（`--flash-attn`）会让它以退出码 1 结束。磁盘上的同类毛病由扫描路径修，这里
/// 兜住「还没扫描就直接加载」的情况。
fn load_item(state: &AppState, id: &str) -> Result<model_config::DirConfig, String> {
    let dir = state.model_config_dir();
    let mut item = model_config::load_dir(&dir)
        .into_iter()
        .find(|item| model_config::same_id(&item.id, id))
        .ok_or_else(|| format!("model not found: {id}（配置目录里没有这个名字）"))?;
    model_config::sanitize_config(&mut item.config);
    Ok(item)
}

/// 取出模型配置；**缺失或没端口时按扫描结果补一份**再取。
///
/// 用户 m08378 第 2 点：「新增加的模型无法启用，还要求同步，这个是被替换的 router 要求的功能」。
/// router 时代的流程是「扫描 → 点同步写配置 → 才能启动」；配置层 JSON 化（第三刀）之后，
/// 补一份最小配置的成本只是一次写盘，没必要再让用户多点一下。
pub fn ensure_config_for(state: &AppState, id: &str) -> Result<model_config::DirConfig, String> {
    if let Ok(item) = load_item(state, id) {
        if item.config.port.is_some() {
            return Ok(item);
        }
        assign_port(state, &item.id)?;
        return load_item(state, id);
    }

    let settings = state.settings.get();
    let roots = settings.model_roots.clone();
    let scanned = match state.cached_scan(&roots) {
        Some(list) => list,
        None => {
            let list = crate::models::scan_models(&roots);
            state.store_scan(&roots, &list);
            list
        }
    };
    // 请求名可能是别名（`settings.aliases` 的值）—— 那是「已经有配置时」的名字，
    // 新模型还没配置，得先用别名反查出扫描 id 才找得到文件。
    let alias_key = settings
        .aliases
        .iter()
        .find(|(_, alias)| model_config::same_id(alias.as_str(), id))
        .map(|(key, _)| key.clone());
    // 老「同步」是按扫描 id 建配置的（`config_sync` 传的就是 `&model.id`），界面上的名字
    // 却是别名 —— 这种历史配置要复用，否则同一个 gguf 会多出第二份配置、白占一个端口。
    if let Some(key) = alias_key.as_ref() {
        if let Ok(item) = load_item(state, key) {
            let item_id = item.id.clone();
            if item.config.port.is_none() {
                assign_port(state, &item_id)?;
            }
            return load_item(state, &item_id);
        }
    }
    let found = scanned
        .iter()
        .find(|m| model_config::same_id(&m.id, id))
        .or_else(|| {
            alias_key
                .as_ref()
                .and_then(|key| scanned.iter().find(|m| model_config::same_id(&m.id, key)))
        });
    let Some(model) = found else {
        return Err(format!(
            "model not found: {id}（配置目录里没有这个名字，扫描结果里也没有 —— 先在界面上刷新一次模型列表）"
        ));
    };

    // 配置名用**请求名**：前端列表里的段名就是它（可能带别名），用它建配置之后
    // 「未配置」判定与后续请求都能对上（与改名流程一致）。
    let dir = state.model_config_dir();
    {
        let _guard = crate::models::preset_lock();
        model_config::ensure_config(
            &dir,
            id,
            &model.path,
            model.mmproj.as_deref(),
            crate::LLAMACPP_PORT_BASE,
        )
        .map_err(|err| format!("{err:#}"))?;
    }
    state.logs.push(
        "system",
        format!("[gui] 模型 {id} 还没有配置文件，已自动补一份（含端口分配）"),
    );
    load_item(state, id)
}

/// 给已有配置补一个端口（旧配置，或 `port` 被人手改空）。
fn assign_port(state: &AppState, id: &str) -> Result<(), String> {
    let dir = state.model_config_dir();
    let _guard = crate::models::preset_lock();
    let mut items = model_config::load_dir(&dir);
    let Some(item) = items
        .iter_mut()
        .find(|item| model_config::same_id(&item.id, id))
    else {
        return Err(format!("model not found: {id}"));
    };
    let port = model_config::allocate_port(&dir, crate::LLAMACPP_PORT_BASE);
    item.config.port = Some(port);
    model_config::write(&item.path, &item.config).map_err(|err| format!("{err:#}"))?;
    state
        .logs
        .push("system", format!("[gui] 模型 {id} 没有端口，已分配 {port}"));
    Ok(())
}

/// 用当前选中的版本；没有选中就用扫到的第一个。
fn resolve_version(
    state: &AppState,
    settings: &crate::settings::Settings,
) -> Result<LlamaCppVersion, String> {
    let versions = state
        .versions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    versions
        .iter()
        .find(|v| settings.selected_version.as_deref() == Some(v.name.as_str()))
        .or_else(|| versions.first())
        .cloned()
        .ok_or_else(|| "尚未扫描到可用版本".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(args: &[&str]) -> ModelConfig {
        let mut cfg = ModelConfig::new("demo", Some("E:/models/demo.gguf".into()));
        cfg.port = Some(8211);
        cfg.args = args.iter().map(|arg| arg.to_string()).collect();
        cfg
    }

    #[test]
    fn build_model_args_puts_container_fields_first_and_strips_reserved() {
        let cfg = config(&["--ctx-size", "4096", "--port", "9999", "--host=0.0.0.0"]);
        let (args, dropped) = build_model_args(&cfg, 8211);
        assert_eq!(
            args,
            [
                "--model",
                "E:/models/demo.gguf",
                "--host",
                "127.0.0.1",
                "--port",
                "8211",
                "--ctx-size",
                "4096",
                // 监控页的引擎指标要这个端点，默认带上（见 build_model_args 的注释）
                "--metrics",
            ]
        );
        assert_eq!(dropped, ["--port", "9999", "--host=0.0.0.0"]);
    }

    #[test]
    fn build_model_args_omits_empty_optional_fields() {
        let cfg = config(&[]);
        let (args, dropped) = build_model_args(&cfg, 8300);
        assert_eq!(
            args,
            ["--model", "E:/models/demo.gguf", "--host", "127.0.0.1", "--port", "8300", "--metrics"]
        );
        assert!(dropped.is_empty());
        // `no_webui` 默认 false = 开 WebUI（铁律 1：不给子实例传 --no-ui）
        assert!(!args.iter().any(|arg| arg == "--no-webui"));
    }

    #[test]
    fn build_model_args_appends_webui_switch_and_api_key() {
        let mut cfg = config(&[]);
        cfg.no_webui = true;
        cfg.api_key = Some("sk-test".into());
        cfg.mmproj = Some("E:/models/mmproj.gguf".into());
        let (args, _) = build_model_args(&cfg, 8212);
        assert_eq!(
            args,
            [
                "--model",
                "E:/models/demo.gguf",
                "--mmproj",
                "E:/models/mmproj.gguf",
                "--host",
                "127.0.0.1",
                "--port",
                "8212",
                "--api-key",
                "sk-test",
                "--no-webui",
                "--metrics",
            ]
        );
    }

    /// 顶层没有 `model` 时不该拼出半个 `--model`（模型文件由扫描结果决定，缺了就是配置没同步）。
    #[test]
    fn build_model_args_skips_blank_values() {
        let mut cfg = config(&[]);
        cfg.model = Some("   ".into());
        cfg.api_key = Some(String::new());
        let (args, _) = build_model_args(&cfg, 8213);
        assert_eq!(args, ["--host", "127.0.0.1", "--port", "8213", "--metrics"]);
    }

    fn ready(id: &str, used: u64) -> ModelRuntime {
        let mut item = ModelRuntime::new(id, 8211);
        item.state = ModelState::Ready;
        item.pid = Some(1000);
        item.last_used_ms = used;
        item
    }

    #[test]
    fn state_reports_process_ownership() {
        assert!(!ModelState::Idle.holds_process());
        assert!(!ModelState::Failed.holds_process());
        assert!(ModelState::Starting.holds_process());
        assert!(ModelState::Ready.holds_process());
        assert!(ModelState::Stopping.holds_process());
        assert_eq!(ModelState::Ready.as_str(), "ready");
    }

    #[test]
    fn insert_get_remove_round_trip() {
        let mut table = ModelTable::default();
        table.insert(ready("b-model", 10));
        table.insert(ready("a-model", 20));
        assert_eq!(table.state_of("b-model"), ModelState::Ready);
        assert_eq!(table.state_of("没这个模型"), ModelState::Idle);
        // id 排序稳定
        assert_eq!(table.ids(), vec!["a-model", "b-model"]);
        assert!(table.remove("a-model").is_some());
        assert!(table.remove("a-model").is_none());
        assert_eq!(table.ids(), vec!["b-model"]);
    }

    #[test]
    fn capacity_counts_only_models_holding_a_process() {
        let mut table = ModelTable::default();
        table.insert(ready("a", 1));
        table.insert(ready("b", 2));
        table.insert(ModelRuntime::new("c", 8213)); // idle：没进程
        assert_eq!(table.active_count(), 2);
        // 上限 2：新模型 d 会超限；但 a 自己再请求一次不算超限
        assert!(table.at_capacity(2, "d"));
        assert!(!table.at_capacity(2, "a"));
        assert!(!table.at_capacity(3, "d"));
    }

    #[test]
    fn victim_is_the_least_recently_used_ready_model() {
        let mut table = ModelTable::default();
        table.insert(ready("老", 100));
        table.insert(ready("中", 200));
        table.insert(ready("新", 300));
        assert_eq!(table.pick_victim("新模型", |_| false), Some("老".to_string()));
    }

    /// 正在转发的模型不能被淘汰（等价 router 的 `req_count != 0` 保护）。
    #[test]
    fn busy_models_are_not_evicted() {
        let mut table = ModelTable::default();
        let mut a = ModelRuntime::new("a", 8211);
        a.state = ModelState::Ready;
        a.last_used_ms = 100;
        let mut b = ModelRuntime::new("b", 8212);
        b.state = ModelState::Ready;
        b.last_used_ms = 200;
        table.insert(a);
        table.insert(b);

        // a 是最久未用的，本来会先被淘汰；但它有请求在转发 → 只能挑 b。
        table.begin_request("a");
        let busy: std::collections::HashSet<String> = table.busy_ids().into_iter().collect();
        assert_eq!(
            table.pick_victim("c", |id| busy.contains(id)),
            Some("b".to_string())
        );

        // 请求结束（包括出错）后必须重新可淘汰，否则模型永远腾不出位置。
        table.end_request("a");
        assert!(table.busy_ids().is_empty());
        assert_eq!(table.pick_victim("c", |_| false), Some("a".to_string()));

        // 多余的 end 不能把计数减成负数。
        table.end_request("a");
        assert_eq!(table.runtime("a").map(|item| item.active), Some(0));
    }

    #[test]
    fn victim_skips_busy_and_non_ready_and_self() {
        let mut table = ModelTable::default();
        table.insert(ready("在生成", 100)); // 最久未用，但正忙
        table.insert(ready("自己", 50));
        let mut starting = ModelRuntime::new("在启动", 8213);
        starting.state = ModelState::Starting;
        starting.last_used_ms = 10;
        table.insert(starting);
        // 在生成的被跳过、在启动的不算候选、自己也不动 → 无候选
        assert_eq!(
            table.pick_victim("自己", |id| id == "在生成"),
            None,
            "忙碌保护与状态过滤都要生效"
        );
        // 放开忙碌保护后应选到「在生成」
        assert_eq!(
            table.pick_victim("自己", |_| false),
            Some("在生成".to_string())
        );
    }

    #[test]
    fn empty_table_has_no_victim() {
        let table = ModelTable::default();
        assert_eq!(table.pick_victim("任何", |_| false), None);
        assert!(!table.at_capacity(1, "任何"));
    }

    #[test]
    fn idle_ids_picks_stale_ready_models_in_lru_order() {
        let mut table = ModelTable::default();
        table.insert(ready("空闲久了", 1_000));
        table.insert(ready("更久", 500));
        table.insert(ready("刚用过", 9_500));
        let mut starting = ModelRuntime::new("在启动", 8213);
        starting.state = ModelState::Starting;
        starting.last_used_ms = 100;
        table.insert(starting);
        table.insert(ready("在生成", 200));
        table.begin_request("在生成");

        // 门槛 5000 ms（now = 10_000）：够旧的 Ready 且不忙的入选，按最久未用排序
        assert_eq!(
            table.idle_ids(10_000, 5_000),
            vec!["更久".to_string(), "空闲久了".to_string()]
        );
        // 刚用过的（距 now 500 ms）不到点，也不能因为最久未用/空闲就被挑
        assert!(!table.idle_ids(10_000, 5_000).contains(&"刚用过".to_string()));
        // 门槛放宽到 500 ms：刚用过的也算空闲；「在生成」忙、「在启动」没进程，都不动
        assert_eq!(
            table.idle_ids(10_000, 500),
            vec![
                "更久".to_string(),
                "空闲久了".to_string(),
                "刚用过".to_string()
            ]
        );
        // 门槛 9600 ms：只剩 last_used ≤ 400 的才够旧 —— 表里没有（「在启动」够旧但状态不对）
        assert!(table.idle_ids(10_000, 9_600).is_empty());
    }
}
