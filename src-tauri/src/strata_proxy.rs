//! Strata 前门代理（用户 m00798：前门 9090，sc117 引擎 9091、iq3_xxs 引擎 9092）。
//!
//! **为什么需要它**：上游一个进程只服务一份 config —— `server.py` 对请求体里的 `model`
//! 做严格校验（与当前实例不符直接 404 `model not found`），`strata.rs` 也把「同端口再起
//! 一个实例」直接拒掉。于是 DSH 这类只认一个 `base_url` 的客户端没法在多个模型之间
//! 「选中哪个都能用」。这里在 GUI 进程里开一个只做转发的 HTTP 端口：
//!
//! - 请求体里的 `model` 决定转发目标；目标引擎没在跑就先停旧的、等端口释放、再起新的；
//! - `GET /v1/models` 合成**全部** config（当前引擎那份报 `loaded`，其余 `unloaded`）；
//! - 没有引擎时 `/health` 也能答（客户端靠它判活）；
//! - 命中引擎后按**字节流**双向透传（SSE / WebSocket 天然可用）。
//!
//! **它不是反向代理服务器**：只面向本机（默认 `127.0.0.1`），没有 TLS、没有连接池、
//! 没有路由表，唯一的路由依据就是「这个请求属于哪份 config」。也正因为如此，
//! **原样透传比解析改写更安全**：压缩、分块、SSE、流式 JSON 都不需要我们再实现一遍。

use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::AppState;
use crate::strata::{self, StrataModelEntry, StrataStatus};

/// 前门默认端口。固定 9090：DSH 等客户端不用改配置，引擎各用自己 config 里的端口。
pub const DEFAULT_PORT: u16 = 9090;

/// 请求头读取上限（防止客户端灌头灌爆内存）。
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// 请求体上限（视觉请求带 base64 图片，给足余量）。
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
/// 解析模型名时愿意读的请求体上限（超过就不解析，按当前引擎转发）。
const MAX_PARSE_BODY: usize = 4 * 1024 * 1024;
/// 等引擎端口释放的上限：`stop_strata` 只等 python 退出，它的引擎子进程还在收尾。
const PORT_FREE_TIMEOUT: Duration = Duration::from_secs(20);
/// 读上游响应的超时：加载模型 + 长生成都可能占用很久。
const UPSTREAM_READ_TIMEOUT: Duration = Duration::from_secs(3600);

/// 前门的一个监听实例。`ProxyHandle` 一 drop，监听端口随之释放。
pub struct ProxyHandle {
    pub port: u16,
    stop: Arc<AtomicBool>,
    /// 只为了让监听套接字活到 `stop()` 之后。
    _listener: Arc<TcpListener>,
}

/// 启动前门。`host` 为空时绑 `127.0.0.1`。
pub fn start(app: &AppHandle, host: &str, port: u16) -> Result<ProxyHandle, String> {
    let bind_host = if host.trim().is_empty() {
        "127.0.0.1"
    } else {
        host.trim()
    };
    let listener = TcpListener::bind((bind_host, port)).map_err(|err| {
        format!(
            "前门端口 :{port} 绑定失败：{err}。\
             若引擎正占着这个端口（旧布局里 Strata 引擎就写 9090），先停掉它再开前门"
        )
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|err| format!("前门 :{port} 设为非阻塞失败：{err}"))?;
    install_debug_hook();
    dbg(&format!("proxy start {bind_host}:{port}"));

    let listener = Arc::new(listener);
    let stop = Arc::new(AtomicBool::new(false));
    let accept_listener = Arc::clone(&listener);
    let accept_stop = Arc::clone(&stop);
    let accept_app = app.clone();
    thread::spawn(move || {
        // 非阻塞 accept + 30 ms 轮询：`stop()` 只需要置标志，不需要唤醒套接字。
        while !accept_stop.load(Ordering::SeqCst) {
            match accept_listener.accept() {
                Ok((stream, _peer)) => {
                    let app = accept_app.clone();
                    // 一个连接一条线程：调用方是本地单个客户端，连接数个位数，不值得上线程池。
                    thread::spawn(move || handle_connection(&app, stream));
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(30));
                }
                Err(err) => {
                    dbg(&format!("accept Err: {err}"));
                    thread::sleep(Duration::from_millis(200));
                }
            }
        }
        dbg("accept 线程退出");
    });

    Ok(ProxyHandle {
        port,
        stop,
        _listener: listener,
    })
}

/// 停前门：置停止标志并摘掉句柄。accept 线程最多 30 ms 后退出，端口随之释放。
pub fn stop(state: &AppState) -> Option<u16> {
    let handle = state
        .strata_proxy
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()?;
    handle.stop.store(true, Ordering::SeqCst);
    dbg(&format!("proxy stop :{}", handle.port));
    Some(handle.port)
}

/// 前门正在监听的端口（`None` = 没开）。
pub fn running_port(state: &AppState) -> Option<u16> {
    state
        .strata_proxy
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|handle| handle.port)
}

/// 把前门状态并进状态快照。
///
/// 与引擎状态放在同一个快照里：前端胶囊、设置页、托盘都只读一处，也不必多开一路轮询。
pub fn apply_to(state: &AppState, status: &mut StrataStatus) {
    match running_port(state) {
        Some(port) => {
            status.proxy = true;
            status.proxy_port = Some(port);
        }
        None => {
            status.proxy = false;
            status.proxy_port = None;
        }
    }
    status.proxy_serving = serving_file(state);
}

/// 前门当前正在服务的 config 文件名（栈为空 = `None`）。
fn serving_file(state: &AppState) -> Option<String> {
    state
        .strata_proxy_serving
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .last()
        .cloned()
}

/// 「前门正在服务这份 config」的登记项：`Drop` 时自动摘掉并广播一次状态。
///
/// 前端卡片据此把该 config 显示成「加载中」（用户 m01266 第 2 点）：DSH 的请求是**前门
/// 自己**去起引擎、自己去加载模型的，GUI 的 `strataStarting` 只覆盖"用户在本页点启动"
/// 那条路径，所以必须由前门登记、由前门广播。
struct Serving {
    app: AppHandle,
    file: String,
}

impl Serving {
    fn begin(app: &AppHandle, state: &AppState, file: &str) -> Self {
        state
            .strata_proxy_serving
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(file.to_string());
        let serving = Serving {
            app: app.clone(),
            file: file.to_string(),
        };
        serving.broadcast();
        serving
    }

    /// 推一次状态快照（前端订阅 `strata://status`；没人听就算了）。
    fn broadcast(&self) {
        if let Some(state) = self.app.try_state::<AppState>() {
            let snapshot = crate::strata_snapshot(&state);
            dbg(&format!("Serving 广播 proxy_serving={:?}", snapshot.proxy_serving));
            let _ = self.app.emit("strata://status", snapshot.clone());
        }
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        let Some(state) = self.app.try_state::<AppState>() else {
            return;
        };
        {
            let mut list = state
                .strata_proxy_serving
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(pos) = list.iter().rposition(|f| f == &self.file) {
                list.remove(pos);
            }
        }
        self.broadcast();
    }
}

/// 诊断日志（**默认关闭**）：设了环境变量 `STRATA_PROXY_DEBUG` 才写 `%TEMP%\strata-proxy-debug.log`。
///
/// 只在排查「客户端连不上前门 / 请求被提前取消」这类真机问题时开：记录每条连接的
/// 请求行与体长、`ensure_engine` 走的是哪个分支、转发写了多少字节、上游何时被半关。
/// 不设变量时每次调用只是一次 `var_os` 判断（这个函数本身几乎不进热路径）。
fn dbg(msg: &str) {
    if std::env::var_os("STRATA_PROXY_DEBUG").is_none() {
        return;
    }
    use std::io::Write as _;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join("strata-proxy-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "[{ms}] [{:?}] {msg}", thread::current().id());
    }
}

/// 临时：把 panic 信息也写进调试日志（同样只在 `STRATA_PROXY_DEBUG` 打开时生效）。
fn install_debug_hook() {
    if std::env::var_os("STRATA_PROXY_DEBUG").is_none() {
        return;
    }
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            dbg(&format!("PANIC: {info}"));
            prev(info);
        }));
        dbg("panic hook installed");
    });
}

fn handle_connection(app: &AppHandle, mut client: TcpStream) {
    // **必须显式转回阻塞**：Windows 上 `accept` 出来的套接字会**继承监听套接字的非阻塞标志**
    // （`start()` 给监听设了 `set_nonblocking(true)`），不转回来的话所有 `read` 都在没数据时
    // 直接返回 `WouldBlock`（WSAEWOULDBLOCK, os error 10035）——读头/读体会随机失败并丢掉连接
    // （客户端看到 RST），pump 线程更是会立刻半关上游、被引擎当成客户端挂断而取消请求。
    let _ = client.set_nonblocking(false);
    let _ = client.set_nodelay(true);
    // 读头阶段的超时：连上却不发请求的连接最多占一条线程 120 秒。
    let _ = client.set_read_timeout(Some(Duration::from_secs(120)));
    let _ = client.set_write_timeout(Some(Duration::from_secs(120)));
    // 客户端提前断开（curl 超时、客户端取消）是常态，不值得刷日志。
    let peer = client.peer_addr().map(|a| a.to_string()).unwrap_or_default();
    dbg(&format!("accept {peer}"));
    let r = serve(app, &mut client);
    match r {
        Ok(()) => dbg(&format!("serve ok {peer}")),
        Err(e) => dbg(&format!("serve Err {peer}: {e}")),
    }
}

fn serve(app: &AppHandle, client: &mut TcpStream) -> std::io::Result<()> {
    // 逐字节读，正好停在头尾的 `\r\n\r\n`：body 一个字节都不会被提前吞掉，
    // 也就不需要"多读出来的前缀缓存"（请求头几百字节，这点开销可忽略）。
    let head_raw = read_head(client)?;
    if head_raw.is_empty() {
        return Ok(());
    }
    let Some((method, target, headers)) = parse_head(&head_raw) else {
        dbg(&format!("parse_head 失败，原头：{:?}", String::from_utf8_lossy(&head_raw)));
        return send_json(
            client,
            400,
            "Bad Request",
            &json!({"error": {"message": "无法解析 HTTP 请求头"}}),
        );
    };
    dbg(&format!("{method} {target} 头字段 {} 个", headers.len()));

    // `Expect: 100-continue`：不先回 100，客户端（reqwest 传大 body 时）会一直等，
    // 两边一起卡死；回过 100 之后我们才读 body。
    if wants_continue(&headers) {
        client.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        client.flush()?;
    }
    let body = match read_body(client, &headers) {
        Ok(b) => b,
        Err(e) => {
            dbg(&format!("read_body 出错: {e}（Content-Length={:?}）", header_value(&headers, "content-length")));
            return Err(e);
        }
    };
    dbg(&format!("body {} 字节", body.len()));
    let path = target.split('?').next().unwrap_or(target.as_str()).to_string();

    let Some(state) = app.try_state::<AppState>() else {
        return send_json(
            client,
            503,
            "Service Unavailable",
            &json!({"error": {"message": "GUI 状态尚未就绪"}}),
        );
    };
    let state: &AppState = &state;

    // 模型列表：合成**全部** config。
    //
    // 上游未加载时给 `data: []`，客户端启动时拉一次就以为"没有模型"；这里始终列全，
    // 每份 config 自带 `unloaded` 状态（与上游 idle_unload 后的语义一致：listed, loads on use）。
    if method.eq_ignore_ascii_case("GET") && matches!(path.as_str(), "/v1/models" | "/models") {
        dbg("→ 合成 /v1/models");
        return send_json(client, 200, "OK", &models_payload(state));
    }

    // 目标模型：请求体里的 `model` 优先；`/v1/models/<id>` 这种路径式再退一步。
    let wanted = model_in_body(&body)
        .or_else(|| path.strip_prefix("/v1/models/").map(|s| s.to_string()));

    // 没引擎时 `/health` 也要能答：客户端（含 DSH）用它判活，答"端口无响应"就等于没人接。
    if method.eq_ignore_ascii_case("GET") && path == "/health" && live_engine(state).is_none() {
        return send_json(
            client,
            200,
            "OK",
            &json!({
                "status": "ok",
                "service": "strata",
                "loaded": false,
                "model": default_model_name(state),
                "proxy": true,
            }),
        );
    }

    let entry = match resolve_target(state, wanted.as_deref()) {
        Ok(entry) => entry,
        Err(TargetError::ModelNotFound(name)) => {
            // 与上游同款形状：客户端（DSH / OpenAI SDK）按 `error.message` 显示。
            dbg(&format!("404 model not found: {name}"));
            return send_json(
                client,
                404,
                "Not Found",
                &json!({
                    "error": {
                        "message": format!("model not found: {name}"),
                        "type": "invalid_request_error",
                    }
                }),
            );
        }
        Err(TargetError::NoConfig) => {
            return send_json(
                client,
                503,
                "Service Unavailable",
                &json!({"error": {"message": "Strata 目录里没有可用的 config（请在 GUI 里设置 Strata 目录）"}}),
            );
        }
    };

    // 前门开始为这份 config 服务：登记 + 广播（前端卡片显示「加载中」，用户 m01266 第 2 点）。
    // 守卫活到 `serve` 返回，所以转发结束/出错都会自动摘掉并再广播一次。
    let serving_file_name = entry
        .config_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let _serving = Serving::begin(app, state, &serving_file_name);

    if let Err(err) = ensure_engine(app, state, &entry) {
        dbg(&format!("ensure_engine 失败: {err}"));
        return send_json(
            client,
            503,
            "Service Unavailable",
            &json!({"error": {"message": err}}),
        );
    }

    dbg(&format!("→ forward {}:{}（{}）", connect_host(&entry.host), entry.port, entry.model_name));
    forward(client, &method, &target, &headers, &body, &entry)
}

/// 路由候选项不匹配时的两种失败。
enum TargetError {
    /// 请求点名了一个 config 里不存在的模型名。
    ModelNotFound(String),
    /// 没设 Strata 目录，或目录里没有 config。
    NoConfig,
}

/// 当前 GUI 手上的引擎 `(端口, config 路径)`。外部实例（用户自己跑的 .bat）不在槽里。
fn live_engine(state: &AppState) -> Option<(u16, PathBuf)> {
    state
        .strata_slot
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|process| (process.port, process.config_path.clone()))
}

fn config_entries(state: &AppState) -> Vec<StrataModelEntry> {
    state
        .settings
        .get()
        .strata_root
        .map(|root| state.strata_configs(&root))
        .unwrap_or_default()
}

/// 端口上真正在跑的模型名：GUI 槽位优先，其次逐个端口探测（外部实例只能靠探测）。
fn live_model_name(state: &AppState, entries: &[StrataModelEntry]) -> Option<String> {
    if let Some((_port, path)) = live_engine(state) {
        if let Some(entry) = entries.iter().find(|e| e.config_path == path) {
            return Some(entry.model_name.clone());
        }
    }
    for entry in entries {
        let probed = strata::probe(entry.port, entry.api_key.as_deref());
        if probed.running {
            return probed.model_name.or_else(|| Some(entry.model_name.clone()));
        }
    }
    None
}

/// 没点名模型时的兜底名（选中 config → 第一份 config）。
fn default_model_name(state: &AppState) -> String {
    let entries = config_entries(state);
    if let Some(file) = state.settings.get().strata_selected_config.as_deref() {
        if let Some(entry) = entries.iter().find(|e| {
            e.config_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n == file)
                .unwrap_or(false)
        }) {
            return entry.model_name.clone();
        }
    }
    entries
        .first()
        .map(|e| e.model_name.clone())
        .unwrap_or_else(|| "strata".to_string())
}

/// 解析这次请求该发给哪份 config。
///
/// - 点名的模型名必须**精确**匹配某份 config 的 `model_name`，否则 404（与上游一致：
///   名字对不上时上游也是 404，不能悄悄换成别的模型）；
/// - 没点名时按「当前引擎 → 选中 config → 第一份」兜底，这样 `/load`、`/status`
///   这类不带模型名的端点也能工作。
fn resolve_target(state: &AppState, wanted: Option<&str>) -> Result<StrataModelEntry, TargetError> {
    let entries = config_entries(state);
    if entries.is_empty() {
        return Err(TargetError::NoConfig);
    }
    if let Some(name) = wanted {
        return entries
            .iter()
            .find(|e| e.model_name == name)
            .cloned()
            .ok_or_else(|| TargetError::ModelNotFound(name.to_string()));
    }
    if let Some((_port, path)) = live_engine(state) {
        if let Some(entry) = entries.iter().find(|e| e.config_path == path) {
            return Ok(entry.clone());
        }
    }
    if let Some(file) = state.settings.get().strata_selected_config.as_deref() {
        if let Some(entry) = entries.iter().find(|e| {
            e.config_path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n == file)
                .unwrap_or(false)
        }) {
            return Ok(entry.clone());
        }
    }
    Ok(entries[0].clone())
}

/// 确保 `entry` 这份 config 的引擎在跑；需要换模型时先停旧的再起新的。
///
/// 全程持 `state.strata_switch`：两个并发请求要不同模型时，第二个必须等第一个切完 ——
/// 否则两次「停旧 + 起新」会互相踩（旧引擎还没退，新引擎就因为端口被占而启动失败）。
fn ensure_engine(app: &AppHandle, state: &AppState, entry: &StrataModelEntry) -> Result<(), String> {
    let _serial = state.strata_switch.lock().unwrap_or_else(|e| e.into_inner());
    dbg(&format!("ensure 进入: target={} 端口={} 槽位={:?}", entry.model_name, entry.port, live_engine(state)));

    // 1) 已经是这份 config 的引擎 → 直接转发（模型没加载时上游会按需加载）。
    if let Some((_port, path)) = live_engine(state) {
        if path == entry.config_path {
            dbg("ensure ①槽位同 config，直接转发");
            return Ok(());
        }
    }

    // 2) 端口上已经跑着**同一个模型**（用户自己跑的 .bat，或引擎先起、GUI 后开：
    //    那种情况槽是空的，但端口上有实例）→ 直接用，不再拉第二个。
    let probed = strata::probe(entry.port, entry.api_key.as_deref());
    dbg(&format!(
        "ensure probe :{} running={} model={:?}",
        entry.port, probed.running, probed.model_name
    ));
    if probed.running && probed.model_name.as_deref() == Some(entry.model_name.as_str()) {
        dbg("ensure ②端口上同模型，直接用");
        return Ok(());
    }

    // 3) 停掉 GUI 手上的引擎，并等端口真的释放 —— `stop_strata` 只等 python 退出，
    //    监听端口的引擎子进程可能还在收尾（连 `spawn_strata` 的 bind 都会因此失败）。
    if let Some((old_port, old_path)) = live_engine(state) {
        let old_name = old_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("?")
            .to_string();
        state.logs.push(
            "system",
            format!("[proxy] 切换模型：先停掉 {old_name}（端口 :{old_port}）"),
        );
        dbg(&format!("ensure ③停旧引擎 {old_name} :{old_port}"));
        strata::stop_strata(&state.strata_slot);
        let freed = strata::wait_port_free(old_port, PORT_FREE_TIMEOUT);
        dbg(&format!("ensure wait_port_free(:{old_port}) = {freed}"));
        if !freed {
            return Err(format!(
                "端口 :{old_port} 在 {} 秒内没有释放，无法切换到 {}",
                PORT_FREE_TIMEOUT.as_secs(),
                entry.model_name
            ));
        }
    }

    // 4) 起目标引擎：复用 GUI 卡片那条路径（真扫目录、防并发、spawn、挂崩溃监测、刷托盘），
    //    这样前门触发的启动在界面上和手点卡片完全一样。
    let file = entry
        .config_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("config 文件名无法解析：{}", entry.config_path.display()))?;
    dbg(&format!("ensure ④起新引擎 {file}"));
    let started = crate::strata_start_engine(app, state, Some(file));
    dbg(&format!("ensure ④起新引擎结果: {:?}", started.as_ref().map(|_| ()).map_err(|e| e.to_string())));
    started
        .map(|_| ())
        .map_err(|err| format!("启动 Strata 引擎失败：{err}"))
}

/// 把请求转发给引擎，并把响应字节流原样回给客户端。
fn forward(
    client: &mut TcpStream,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: &[u8],
    entry: &StrataModelEntry,
) -> std::io::Result<()> {
    let host = connect_host(&entry.host);
    let mut upstream = match TcpStream::connect((host.as_str(), entry.port)) {
        Ok(stream) => stream,
        Err(err) => {
            dbg(&format!("forward 连上游失败 {host}:{} {err}", entry.port));
            return send_json(
                client,
                502,
                "Bad Gateway",
                &json!({"error": {"message": format!("连接 Strata 引擎 {host}:{} 失败：{err}", entry.port)}}),
            );
        }
    };
    let _ = upstream.set_nodelay(true);
    let _ = upstream.set_read_timeout(Some(UPSTREAM_READ_TIMEOUT));
    let _ = upstream.set_write_timeout(Some(Duration::from_secs(60)));

    let mut request = format!("{method} {target} HTTP/1.1\r\n");
    for (name, value) in headers {
        match name.to_ascii_lowercase().as_str() {
            // Host 要指向引擎自己（上游 WebUI 的 Origin 判断用它）；
            // `Connection: close` 是上游 http.server 收尾的依据（不给 Content-Length 的响应靠关闭分隔）；
            // 去掉 `Accept-Encoding` 让上游发未压缩字节，我们不必解压；
            // `Expect` 已经在本机回过 100 了，再转给上游会让它再等一次。
            "host" | "connection" | "accept-encoding" | "expect" | "proxy-connection" => continue,
            _ => {}
        }
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    request.push_str(&format!("Host: {host}:{}\r\n", entry.port));
    request.push_str("Connection: close\r\n\r\n");
    upstream.write_all(request.as_bytes())?;
    if !body.is_empty() {
        upstream.write_all(body)?;
    }
    upstream.flush()?;
    dbg(&format!("forward 已写上游 {} 字节（头 {} + body {}）", request.len() + body.len(), request.len(), body.len()));

    // 只做「引擎 → 客户端」单向转发：请求体在上面已由 `read_body` 整段读完，上游又是
    // HTTP/1.0 + `Connection: close`，没有任何还需要转发的客户端字节。
    //
    // **不要再挂「客户端 → 引擎」的 pump 线程**（原来那版的 bug）：它跳出循环时会
    // `shutdown(上游, Write)`，而 `E:\AI\Strata\serve\server.py:4127-4150 _watch_client`
    // 把上游读到 EOF 当成「客户端挂断」，在该请求的提示读取分块边界取消整个请求 ——
    // 实测症状就是「小 prompt 侥幸成功、18859 token 的 prompt 读到第一个 8192 块边界
    // （约 5.7 s）时被取消」（`(cancelled)` + `0 generated`）。
    // 先清掉读超时：那个 120 秒是给"读请求头"用的，长响应的静默期不能被它打断。
    let _ = client.set_read_timeout(None);

    let copied = std::io::copy(&mut upstream, client);
    match &copied {
        Ok(n) => dbg(&format!("forward io::copy 结束，向客户端写 {n} 字节")),
        Err(e) => dbg(&format!("forward io::copy 出错: {e}")),
    }
    let _ = client.shutdown(Shutdown::Both);
    let _ = upstream.shutdown(Shutdown::Both);
    dbg("forward 收尾完成");
    copied.map(|_| ())
}

/// 合成 `/v1/models`：列出**全部** config，字段形状照抄上游 `server.py:4313-4323`。
fn models_payload(state: &AppState) -> Value {
    let entries = config_entries(state);
    let live = live_model_name(state, &entries);
    let data: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let loaded = live.as_deref() == Some(entry.model_name.as_str());
            json!({
                "id": entry.model_name,
                "object": "model",
                "status": { "value": if loaded { "loaded" } else { "unloaded" } },
                "meta": {
                    "n_ctx": entry
                        .max_context
                        .as_deref()
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or(0),
                },
                "architecture": {
                    "input_modalities": if entry.vision { json!(["text", "image"]) } else { json!(["text"]) },
                    "output_modalities": ["text"],
                },
            })
        })
        .collect();
    json!({ "object": "list", "data": data })
}

/// 连接引擎用的主机：config 里可能是 `0.0.0.0` / `::`（监听所有地址），连它没有意义。
fn connect_host(host: &str) -> String {
    let trimmed = host.trim().trim_start_matches('[').trim_end_matches(']');
    if trimmed.is_empty() || trimmed == "0.0.0.0" || trimmed == "::" {
        "127.0.0.1".to_string()
    } else {
        trimmed.to_string()
    }
}

fn read_head(client: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while buf.len() < MAX_HEAD_BYTES {
        if client.read(&mut byte)? == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    Ok(buf)
}

fn parse_head(raw: &[u8]) -> Option<(String, String, Vec<(String, String)>)> {
    let text = String::from_utf8_lossy(raw);
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_string();
    let target = first.next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    Some((method, target, headers))
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn wants_continue(headers: &[(String, String)]) -> bool {
    header_value(headers, "expect")
        .map(|v| v.to_ascii_lowercase().contains("100-continue"))
        .unwrap_or(false)
}

/// 读出请求体。
///
/// 分块传输时**连着分块框架一起**读成原始字节，转发时原样写回（请求头里的
/// `Transfer-Encoding` 也没被删掉），所以不需要重新分块。
fn read_body(client: &mut TcpStream, headers: &[(String, String)]) -> std::io::Result<Vec<u8>> {
    if header_value(headers, "transfer-encoding")
        .map(|v| v.to_ascii_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        return read_chunked(client);
    }
    let Some(len) = header_value(headers, "content-length").and_then(|v| v.trim().parse::<usize>().ok())
    else {
        return Ok(Vec::new());
    };
    if len == 0 {
        return Ok(Vec::new());
    }
    if len > MAX_BODY_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("请求体 {len} 字节超过 {MAX_BODY_BYTES} 上限"),
        ));
    }
    let mut body = vec![0u8; len];
    client.read_exact(&mut body)?;
    Ok(body)
}

fn read_chunked(client: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line = read_crlf_line(client)?;
        out.extend_from_slice(&line);
        if line.is_empty() {
            break;
        }
        let size_text = String::from_utf8_lossy(&line);
        let size = usize::from_str_radix(
            size_text.trim().split(';').next().unwrap_or("0").trim(),
            16,
        )
        .unwrap_or(0);
        if size == 0 {
            // 结束块之后只有一个空行（trailer 不转发了）。
            out.extend_from_slice(&read_crlf_line(client)?);
            break;
        }
        if out.len() + size + 2 > MAX_BODY_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("分块请求体超过 {MAX_BODY_BYTES} 上限"),
            ));
        }
        let mut chunk = vec![0u8; size + 2];
        client.read_exact(&mut chunk)?;
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn read_crlf_line(client: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    while out.len() < 8192 {
        if client.read(&mut byte)? == 0 {
            break;
        }
        out.push(byte[0]);
        if out.ends_with(b"\r\n") {
            break;
        }
    }
    Ok(out)
}

/// 只从 JSON 请求体里取模型名：**不解析、不改写**其余部分（请求体原字节转发）。
fn model_in_body(body: &[u8]) -> Option<String> {
    if body.is_empty() || body.len() > MAX_PARSE_BODY {
        return None;
    }
    let value: Value = serde_json::from_slice(body).ok()?;
    value
        .get("model")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn send_json(
    client: &mut TcpStream,
    status: u16,
    reason: &str,
    value: &Value,
) -> std::io::Result<()> {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(&body)?;
    client.flush()
}

/// 启动前门（端口取 GUI 设置里的 `strata_port`，缺省 9090）。
#[tauri::command]
pub async fn strata_proxy_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StrataStatus, String> {
    if let Some(port) = running_port(&state) {
        return Err(format!("Strata 前门已在 :{port} 运行"));
    }
    let settings = state.settings.get();
    let host = settings
        .strata_host
        .clone()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = settings.strata_port.unwrap_or(DEFAULT_PORT);
    let handle = start(&app, &host, port)?;
    *state
        .strata_proxy
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(handle);
    state.logs.push(
        "system",
        format!("[gui] Strata 前门已监听 {host}:{port}（按请求里的 model 自动切换引擎）"),
    );

    let snapshot = crate::strata_snapshot(&state);
    let _ = app.emit("strata://status", snapshot.clone());
    let router_running = state.status.lock().unwrap_or_else(|e| e.into_inner()).running;
    crate::tray::sync_menu_state(&app, router_running, true);
    Ok(snapshot)
}

/// 停前门。引擎不动（前门没了，引擎还可以被卡片直接管）。
#[tauri::command]
pub async fn strata_proxy_stop(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StrataStatus, String> {
    let Some(port) = stop(&state) else {
        return Err("Strata 前门没有在运行".to_string());
    };
    state
        .logs
        .push("system", format!("[gui] Strata 前门已停止（:{port}）"));

    let snapshot = crate::strata_snapshot(&state);
    let _ = app.emit("strata://status", snapshot.clone());
    let router_running = state.status.lock().unwrap_or_else(|e| e.into_inner()).running;
    crate::tray::sync_menu_state(&app, router_running, crate::strata_busy(&state));
    Ok(snapshot)
}

/// 退出时收干净：摘掉监听句柄，端口立刻释放（否则下次启动会"端口已被占用"）。
pub fn shutdown(state: &AppState) {
    if let Some(port) = stop(state) {
        state
            .logs
            .push("system", format!("[gui] 退出：已关闭 Strata 前门（:{port}）"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_parsing_reads_method_target_and_headers() {
        let raw = b"POST /v1/chat/completions?x=1 HTTP/1.1\r\nHost: 127.0.0.1:9090\r\nContent-Length: 2\r\n\r\n";
        let (method, target, headers) = parse_head(raw).expect("应当能解析");
        assert_eq!(method, "POST");
        assert_eq!(target, "/v1/chat/completions?x=1");
        assert_eq!(header_value(&headers, "host"), Some("127.0.0.1:9090"));
        assert_eq!(header_value(&headers, "content-length"), Some("2"));
        assert_eq!(header_value(&headers, "missing"), None);
    }

    #[test]
    fn model_name_comes_from_json_body() {
        assert_eq!(
            model_in_body(br#"{"model":"sc117-swift-iq2-xs","messages":[]}"#),
            Some("sc117-swift-iq2-xs".to_string())
        );
        // 没有 model 字段 / 不是 JSON / 空 body 都不该拦下来（按当前引擎转发）
        assert_eq!(model_in_body(br#"{"messages":[]}"#), None);
        assert_eq!(model_in_body(b"not json"), None);
        assert_eq!(model_in_body(b""), None);
    }

    #[test]
    fn expect_continue_is_detected_case_insensitively() {
        let headers = vec![("Expect".to_string(), "100-Continue".to_string())];
        assert!(wants_continue(&headers));
        assert!(!wants_continue(&[("Host".to_string(), "x".to_string())]));
    }

    #[test]
    fn connect_host_normalizes_wildcard_binds() {
        assert_eq!(connect_host(""), "127.0.0.1");
        assert_eq!(connect_host("0.0.0.0"), "127.0.0.1");
        assert_eq!(connect_host("::"), "127.0.0.1");
        assert_eq!(connect_host("[::1]"), "::1");
        assert_eq!(connect_host("127.0.0.1"), "127.0.0.1");
    }
}
