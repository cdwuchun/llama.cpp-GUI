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
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::model_config;
use crate::scheduler;
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

/// 前门诊断日志。
///
/// 两条去向：
/// 1. 始终写进日志文件（`<配置目录>\logs\gui-*.log`，来源标 `proxy`），**不进内存面板** ——
///    一次请求就有好几行细粒度诊断，塞进面板会把真正有用的行刷掉（用户 m05885 要的是事后能查）。
/// 2. 设了 `STRATA_PROXY_DEBUG` 时，额外照旧写 `%TEMP%\strata-proxy-debug.log`（老的排查脚本还在用）。
fn dbg(msg: &str) {
    if let Some(hub) = crate::logs::global() {
        hub.push_file_only("proxy", &format!("[{:?}] {msg}", thread::current().id()));
    }
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

/// 值得用户看见的前门事件（慢请求、错误）：进日志面板，也落盘。
///
/// 来源用 `system`：面板的「系统（GUI 与前门）」筛的就是它，不必再加一档（用户 m05885）。
fn proxy_event(msg: &str) {
    if let Some(hub) = crate::logs::global() {
        hub.push("system", format!("[前门] {msg}"));
    }
}

/// 连接耗时阈值：超过就记一行「慢」。前门「连得上但不回包」只能靠耗时定位到哪一段（用户 m05816）。
const SLOW_CONN_MS: u128 = 1000;

/// 连接计时（RAII）。
///
/// 收尾放在 `Drop` 里：`serve` 里有十来处提前 return，逐个加收尾必漏。正常收工也要计时，
/// 才分得清是「读头等太久」还是「请求处理慢」。
struct ConnTimer {
    t0: std::time::Instant,
    what: String,
}

impl ConnTimer {
    fn new(what: String) -> Self {
        Self {
            t0: std::time::Instant::now(),
            what,
        }
    }
}

impl Drop for ConnTimer {
    fn drop(&mut self) {
        let ms = self.t0.elapsed().as_millis();
        if ms >= SLOW_CONN_MS {
            proxy_event(&format!("{} 耗时 {ms} ms", self.what));
        }
    }
}

/// panic 信息也写进日志（真机排查最需要的就是这一条）。
fn install_debug_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let text = format!("PANIC: {info}");
            proxy_event(&text);
            dbg(&text);
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
    // 超时就记一行「慢」：真机上前门卡住时，日志里有没有这行、耗时多少是唯一的线索
    // （用户 m05816：连得上但不回包；用户 m05885：要能事后查）。
    let _timer = ConnTimer::new(format!("连接 {peer}"));
    let r = serve(app, &mut client);
    match r {
        Ok(()) => dbg(&format!("serve ok {peer}")),
        Err(e) => {
            dbg(&format!("serve Err {peer}: {e}"));
            proxy_event(&format!("连接 {peer} 处理失败：{e}"));
        }
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

    // 跨源预检：webview 直连本机端口算跨源，`POST` + `application/json` 会先发 `OPTIONS`。
    // 统一答 204 + CORS 头，不读 body（预检本来也没有 body）。
    if method.eq_ignore_ascii_case("OPTIONS") {
        return send_preflight(client);
    }

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

    // 显式加载/卸载：router 模式下客户端与前端都调这两个端点，前门作为它的替代品自己兑现
    // （不再把 `/models/load` 透传给某个引擎 —— 单实例没有"加载别人"的能力）。
    if method.eq_ignore_ascii_case("POST") && matches!(path.as_str(), "/models/load" | "/models/unload")
    {
        let name = model_in_body(&body).unwrap_or_default();
        // 新扫描到、配置还没生成的模型：显式加载时按名字（= 扫描 id）现补一份配置，
        // 不必让用户先去点一次「同步」（用户 m08378 第 2 点）。
        let found = find_llama_model(state, &name).or_else(|| {
            if path.ends_with("/load") {
                scheduler::ensure_config_for(state, &name).ok()
            } else {
                None
            }
        });
        let Some(item) = found else {
            dbg(&format!("404 {path} model not found: {name}"));
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
        };
        if path.ends_with("/load") {
            return match scheduler::ensure_ready(app, state, &item.id) {
                Ok(port) => send_json(
                    client,
                    200,
                    "OK",
                    &json!({"model": item.config.name, "port": port, "status": "loaded"}),
                ),
                Err(err) => {
                    dbg(&format!("/models/load 失败: {err}"));
                    send_json(
                        client,
                        503,
                        "Service Unavailable",
                        &json!({"error": {"message": err}}),
                    )
                }
            };
        }
        let stopped = {
            let mut sched = scheduler::lock_sched(state);
            sched.stop(&item.id, &state.logs)
        };
        dbg(&format!("/models/unload {} → 进程被杀: {stopped}", item.id));
        return send_json(
            client,
            200,
            "OK",
            &json!({"model": item.config.name, "status": "unloaded"}),
        );
    }

    // 目标模型：请求体里的 `model` 优先；`/v1/models/<id>` 路径式次之；再退一步认
    // query 里的 `?model=`（浏览器打开自带 WebUI 时靠它点名实例）。
    let wanted = model_in_body(&body)
        .or_else(|| path.strip_prefix("/v1/models/").map(|s| s.to_string()))
        .or_else(|| model_in_query(&target));

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

    // llama.cpp 通道（P1）：配置目录里点名的模型交给前门调度器 —— 它负责起子实例、
    // 等就绪、容量不够时先腾位置。Strata 那条路（下面）保持不变。
    if let Some(name) = wanted.as_deref() {
        if let Some(item) = find_llama_model(state, name) {
            // 浏览器打开自带 WebUI（卡片上的 💬、或侧栏「开始聊天」带 `?model=`）：**302 到实例端口**。
            // 不能把页面留在前门：WebUI 的模型列表走相对路径 `/v1/models`，那会回到前门拿到
            // 两通道的合成列表（含 Strata 的模型，点了 404、看起来「改不了」—— 用户 m02258 第 1 点）；
            // 落到实例端口后，WebUI 只跟那一个实例说话。
            if is_page_request(&method, &path) {
                return match scheduler::ensure_ready(app, state, &item.id) {
                    Ok(port) => {
                        dbg(&format!("→ WebUI 重定向到实例端口 {port}"));
                        send_redirect(client, &format!("http://127.0.0.1:{port}/"))
                    }
                    Err(err) => send_html(client, &webui_error_html(&item.config.name, &err)),
                };
            }
            return serve_llama(app, client, state, &method, &target, &headers, &body, &item);
        }
    }

    // 浏览器打开自带 WebUI（侧栏「开始聊天」不带模型）：**页面与它引用的 JS/CSS/图标**
    // 都挑一个已经就绪的实例转发 —— 静态文件哪个实例给的都是同一份。
    // 一个都没就绪时，页面本身回一张提示页（列出模型点一个就起），资源请求照旧落默认
    // 通道（此时页面没渲染，资源 404 无所谓）。
    if wanted.is_none() && is_webui_asset(&path) {
        if let Some(item) = first_ready_llama(state) {
            // 页面请求：302 到实例端口（理由同上）；静态资源请求：照旧直接转发。
            if is_page_request(&method, &path) {
                if let Some(port) = item.config.port {
                    dbg(&format!("→ 无点名，WebUI 重定向到已就绪实例 :{port}"));
                    return send_redirect(client, &format!("http://127.0.0.1:{port}/"));
                }
            }
            dbg("→ WebUI 静态资源交给已就绪的 llama.cpp 实例");
            return serve_llama(app, client, state, &method, &target, &headers, &body, &item);
        }
        if is_page_request(&method, &path) {
            dbg("→ 没有已就绪实例，给提示页");
            return send_html(client, &webui_hint_html(state));
        }
    }

    // llama.cpp 实例自带、但**不是** WebUI 静态资源的端点（`/tools`、`/build.json`、
    // `/cors-proxy`）：无点名时它们只可能是冲 llama.cpp 实例来的。
    // 漏掉这一段代价很大 —— `/tools` 与 `/build.json` 既不在 `is_webui_asset` 里，也不在
    // `is_passive_probe` 里，于是落进默认通道（Strata 的默认 config）：点一次「开始聊天」
    // 就把 40 GB 的 Strata 模型拉起来，而用户想聊的是已经在跑的 llama.cpp 模型
    // （用户 m08817 实测：日志里 `GET /tools` 紧跟一条 `ensure ④起新引擎`）。
    if wanted.is_none() && is_llama_endpoint(&path) {
        if let Some(item) = first_ready_llama(state) {
            dbg(&format!("→ {path} 交给已就绪的 llama.cpp 实例"));
            return serve_llama(app, client, state, &method, &target, &headers, &body, &item);
        }
        dbg(&format!("→ {path} 没有已就绪实例，回空壳（不启动 Strata 引擎）"));
        return match path.as_str() {
            "/tools" => send_json(client, 200, "OK", &json!([])),
            _ => send_json(client, 200, "OK", &json!({})),
        };
    }

    // 无 model 的被动探测端点（`/props`、`/slots`、`/metrics`、`/v1/health`）：**不要**顺手把
    // Strata 引擎拉起来（用户 m02258 第 2 点）—— 引擎只在该模型被点名时按需启动，
    // 模型卡点启动、或前门收到点名该模型的请求。这些端点只是读状态，没引擎就回空壳。
    if wanted.is_none() && is_passive_probe(&path) && live_engine(state).is_none() {
        dbg(&format!("→ {path} 没有引擎，回空壳（不启动引擎）"));
        return match path.as_str() {
            "/slots" => send_json(client, 200, "OK", &json!([])),
            _ => send_json(client, 200, "OK", &json!({})),
        };
    }

    // 显存互斥（用户 m03160 第 2 点 / m08817）：Strata 通道真要干活了，就先把 llama.cpp
    // 侧的实例停掉。互斥原先只在 GUI 前端做（store.startModel / startStrataModel），前门
    // 自己拉起的加载会绕过它 —— 于是出现「Strata 起来了、llama.cpp 的模型还占着显存」。
    // 只在真有实例在跑时才动，否则每个请求都要白拿一次调度锁。
    if state.settings.get().strata_router_mutex {
        let stopped = {
            let mut sched = scheduler::lock_sched(state);
            if sched.table().active_count() == 0 {
                Vec::new()
            } else {
                sched.stop_all(&state.logs)
            }
        };
        if !stopped.is_empty() {
            dbg(&format!("→ 显存互斥：已停掉 llama.cpp 实例 {stopped:?}"));
        }
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
    forward(
        client,
        &method,
        &target,
        &headers,
        &body,
        UpstreamTarget {
            host: &entry.host,
            port: entry.port,
            label: "Strata 引擎",
        },
    )
}

/// 在 llama.cpp 通道的配置目录里找请求点名的模型（文件名 id 与 `name` 字段都认）。
/// query 里的 `model=`（浏览器打开自带 WebUI 时用它点名实例）；`%2F` 这类编码要还原。
fn model_in_query(target: &str) -> Option<String> {
    let query = target.split_once('?')?.1;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "model" {
            let decoded = percent_decode(value);
            let trimmed = decoded.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 只解 `%XX` 与 `+`，够 query 参数用；模型名里的 `/` 会被浏览器编码成 `%2F`。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            match u8::from_str_radix(hex, 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                Err(_) => {}
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// WebUI 页面本体请求（只有这两个路径是页面，`/_app/...` 那些是资源）。
fn is_page_request(method: &str, path: &str) -> bool {
    method.eq_ignore_ascii_case("GET") && matches!(path, "/" | "/index.html")
}

/// 只读状态的探测端点：没有引擎时**不要**为它们把 Strata 引擎拉起来（用户 m02258 第 2 点）。
fn is_passive_probe(path: &str) -> bool {
    matches!(path, "/props" | "/slots" | "/metrics" | "/v1/health")
}

/// llama.cpp 实例自带、但**不是** WebUI 静态资源的端点。
///
/// `/tools`（MCP 工具列表）与 `/build.json`（构建信息）是自带 WebUI 每次打开都会要的，
/// 不带扩展名、也不在 `is_webui_asset` 名单里；`/cors-proxy` 是它取跨域图片用的。
/// 无点名时这些请求只可能是冲 llama.cpp 实例来的，绝不能落进 Strata 的默认通道
/// —— 否则一次页面加载就会把 Strata 引擎和它几十 GB 的模型拉起来（用户 m08817）。
fn is_llama_endpoint(path: &str) -> bool {
    matches!(path, "/tools" | "/build.json" | "/cors-proxy")
}

/// 302 到实例自己的端口：浏览器跟着跳过去之后，页面里那些相对路径的请求就只发给那个实例了。
fn send_redirect(client: &mut TcpStream, location: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\
         Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n"
    );
    client.write_all(head.as_bytes())?;
    client.flush()
}

/// WebUI 页面请求但实例起不来时给的错误页（端口被占、显存不够等）。
fn webui_error_html(model: &str, err: &str) -> String {
    format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\">\
         <title>启动失败 · {name}</title>\
         <body style=\"font:14px/1.6 system-ui;background:#0e1113;color:#eef1f3;padding:32px\">\
         <h1 style=\"font-size:18px\">模型「{name}」没能启动</h1>\
         <pre style=\"white-space:pre-wrap;background:#1b1f23;padding:12px;border-radius:8px\">{err}</pre>\
         <p><a style=\"color:#34d399\" href=\"/\">← 返回模型列表</a></p></body></html>",
        name = html_escape(model),
        err = html_escape(err),
    )
}

/// 自带 WebUI 的静态资源：页面、打包的 JS/CSS、图标 —— 任意实例给的都是同一份文件。
///
/// **必须连资源一起认出来**（用户 m02048 报「聊天界面是空白的」）：只认 `/` 的话，
/// `index.html` 取得到，它引用的 `/_app/immutable/bundle.*.js` 却会掉进默认通道
/// （Strata 引擎）拿到 `404 BaseHTTP`，浏览器里就是一个空白页 —— 实测前门取该
/// bundle 是 404、直连已就绪实例是 200（2.6 MB）。
fn is_webui_asset(path: &str) -> bool {
    matches!(path, "/" | "/index.html" | "/manifest.webmanifest")
        || path.starts_with("/_app/")
        || path.starts_with("/favicon")
        || path.starts_with("/apple-")
        || [
            ".js", ".mjs", ".css", ".svg", ".png", ".ico", ".webmanifest", ".woff2",
        ]
        .iter()
        .any(|ext| path.ends_with(ext))
}

/// 一段自制 HTML（只在"聊天页但没有任何已就绪实例"时用）：列出本地模型，点一个就起它。
fn webui_hint_html(state: &AppState) -> String {
    let dir = state.model_config_dir();
    let items = model_config::load_dir(&dir);
    let mut rows = String::new();
    {
        let sched = scheduler::lock_sched(state);
        for item in &items {
            let name = item.config.name.as_str();
            let state_now = sched.table().state_of(&item.id);
            let label = match state_now {
                scheduler::ModelState::Ready => "已加载",
                scheduler::ModelState::Starting => "启动中",
                scheduler::ModelState::Stopping => "停止中",
                scheduler::ModelState::Failed => "启动失败",
                scheduler::ModelState::Idle => "未加载",
            };
            rows.push_str(&format!(
                "<li><a href=\"/?model={}\">{}</a><span class=\"s\">{}</span></li>",
                url_encode(name),
                html_escape(name),
                label
            ));
        }
    }
    if rows.is_empty() {
        rows.push_str("<li class=\"empty\">配置目录里还没有模型</li>");
    }
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
<title>llama.cpp GUI · 前门</title>\
<style>\
body{{margin:0;padding:32px;background:#0e1113;color:#eef1f3;\
font:14px/1.6 system-ui,\"Microsoft YaHei UI\",sans-serif}}\
h1{{font-size:18px;margin:0 0 4px}}\
p{{color:#8e979f;margin:0 0 18px}}\
ul{{list-style:none;margin:0;padding:0;max-width:560px}}\
li{{display:flex;justify-content:space-between;gap:12px;padding:8px 12px;\
border:1px solid #2a3036;border-radius:10px;margin-bottom:6px;background:#161a1d}}\
li.empty{{color:#8e979f;justify-content:center}}\
a{{color:#34d399;text-decoration:none}}\
.s{{color:#8e979f}}\
</style></head><body>\
<h1>前门 :9090</h1>\
<p>还没有已加载的模型。点下面任意一个开始加载（首次要 20～60 秒），\
或者回到 GUI 的模型页加载。</p><ul>{rows}</ul></body></html>"
    )
}

/// 只做 percent-encode：模型名里可能有 `/`、中文、空格。
fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn send_html(client: &mut TcpStream, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
Content-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(body.as_bytes())?;
    client.flush()
}

/// 已经就绪的 llama.cpp 实例（按配置目录顺序取第一个）：给"没点名模型"的根路径用。
fn first_ready_llama(state: &AppState) -> Option<model_config::DirConfig> {
    let dir = state.model_config_dir();
    let items = model_config::load_dir(&dir);
    let sched = scheduler::lock_sched(state);
    items
        .into_iter()
        .find(|item| sched.table().state_of(&item.id) == scheduler::ModelState::Ready)
}

fn find_llama_model(state: &AppState, wanted: &str) -> Option<model_config::DirConfig> {
    let dir = state.model_config_dir();
    model_config::load_dir(&dir)
        .into_iter()
        .find(|item| model_config::same_id(&item.id, wanted) || item.config.name == wanted)
}

/// llama.cpp 通道的转发：先让调度器把子实例弄到就绪，再按字节流原样透传。
fn serve_llama(
    app: &AppHandle,
    client: &mut TcpStream,
    state: &AppState,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: &[u8],
    item: &model_config::DirConfig,
) -> std::io::Result<()> {
    // 这次请求打的是哪个模型，要能在默认日志里查到（用户 m01516）。以前只有开
    // STRATA_PROXY_DEBUG 才有细粒度诊断，聊天页「模型自己换了」这类现象只能靠猜。
    let was_ready = matches!(
        scheduler::lock_sched(state).table().state_of(&item.id),
        scheduler::ModelState::Ready
    );
    let port = match scheduler::ensure_ready(app, state, &item.id) {
        Ok(port) => port,
        Err(err) => {
            dbg(&format!("ensure_ready 失败: {err}"));
            return send_json(
                client,
                503,
                "Service Unavailable",
                &json!({"error": {"message": err}}),
            );
        }
    };
    // 监控页每 2 秒轮询 `/metrics?model=…`、`/slots?model=…` 也走这里，不能每轮都记；
    // 只记「这次要起引擎」和真正的 POST 请求，够定位「哪个模型被点名」。
    if !was_ready || method.eq_ignore_ascii_case("POST") {
        state.logs.push(
            "system",
            format!(
                "[前门] 请求模型 {} → {} :{port}",
                item.config.name,
                if was_ready { "已就绪实例" } else { "启动子实例" }
            ),
        );
    }
    dbg(&format!("→ forward 127.0.0.1:{port}（{}，llama.cpp）", item.id));
    // 转发期间记下「这个模型在用」：容量闸淘汰时挑不到它（与 router 的 pick_victim 同规则）。
    {
        let mut sched = scheduler::lock_sched(state);
        sched.table_mut().begin_request(&item.id);
    }
    let outcome = forward(
        client,
        method,
        target,
        headers,
        body,
        UpstreamTarget {
            host: item.config.host.as_str(),
            port,
            label: "llama.cpp 子实例",
        },
    );
    // 结束一定要记账，否则这个模型会被永远当成「在用」，再也不会被淘汰。
    {
        let mut sched = scheduler::lock_sched(state);
        sched.table_mut().end_request(&item.id);
        // 监控页每 2 秒的 `/metrics`、`/slots`、`/props`、`/v1/health` 不算「在用」：
        // 以前它们成功返回也会 touch，于是只要监控页开着，空闲卸载永远等不到
        // （审查发现）。请求数照记，只是不刷新 `last_used_ms`。
        let passive = is_passive_probe(target.split('?').next().unwrap_or(target));
        if outcome.is_ok() && !passive {
            let now = crate::logs::now_ms();
            sched.table_mut().touch(&item.id, now);
        }
    }
    outcome
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
    strata::root()
        .filter(|root| root.is_dir())
        .map(|root| state.strata_configs(&root))
        .unwrap_or_default()
}

/// 「哪个端口上跑着外部 Strata 实例」的探测结果缓存。
///
/// 合成模型列表时要挨个 config 探端口（外部实例只能靠探测发现），而列表是热路径：
/// 前端每 5 秒拉一次、失败还要重试 5 次。没人监听时每次探测都要白等一个连接超时，
/// 整个列表请求就被拖成好几秒 —— 前端等不到响应，卡片状态永远不更新（用户 m06134）。
/// 列表要的只是「有没有在跑」，晚几秒认出来外部实例没有实际影响。
static LIVE_PROBE_CACHE: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
/// 探测结果的新鲜期。
const LIVE_PROBE_TTL: Duration = Duration::from_secs(5);
/// 探测外部实例的短超时：本机正常响应是毫秒级，连不上要尽快放弃（实测被拒约 2 秒）。
const LIVE_PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// 端口上真正在跑的模型名：GUI 槽位优先，其次逐个端口探测（外部实例只能靠探测）。
fn live_model_name(state: &AppState, entries: &[StrataModelEntry]) -> Option<String> {
    if let Some((_port, path)) = live_engine(state) {
        if let Some(entry) = entries.iter().find(|e| e.config_path == path) {
            return Some(entry.model_name.clone());
        }
    }
    // 槽位为空才需要探测：先看缓存，免得每次列表请求都去挨个端口等连接超时。
    {
        let cache = LIVE_PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, name)) = cache.as_ref() {
            if at.elapsed() < LIVE_PROBE_TTL {
                return name.clone();
            }
        }
    }
    let mut found = None;
    for entry in entries {
        let probed =
            strata::probe_with_timeout(entry.port, entry.api_key.as_deref(), LIVE_PROBE_TIMEOUT);
        if probed.running {
            found = probed.model_name.or_else(|| Some(entry.model_name.clone()));
            break;
        }
    }
    *LIVE_PROBE_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), found.clone()));
    found
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

/// 转发目标：两个通道（Strata 引擎 / llama.cpp 子实例）共用同一条转发路径。
struct UpstreamTarget<'a> {
    host: &'a str,
    port: u16,
    /// 出错提示里用的通道名（「Strata 引擎」/「llama.cpp 子实例」）。
    label: &'a str,
}

/// 把请求转发给引擎，并把响应字节流原样回给客户端。
fn forward(
    client: &mut TcpStream,
    method: &str,
    target: &str,
    headers: &[(String, String)],
    body: &[u8],
    upstream_target: UpstreamTarget<'_>,
) -> std::io::Result<()> {
    let UpstreamTarget { host, port, label } = upstream_target;
    let host = connect_host(host);
    let mut upstream = match TcpStream::connect((host.as_str(), port)) {
        Ok(stream) => stream,
        Err(err) => {
            dbg(&format!("forward 连上游失败 {host}:{port} {err}"));
            return send_json(
                client,
                502,
                "Bad Gateway",
                &json!({"error": {"message": format!("连接 {label} {host}:{port} 失败：{err}")}}),
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
            // `Expect` 已经在本机回过 100 了，再转给上游会让它再等一次。
            //
            // **`Accept-Encoding` 必须原样转发**（原来在这里被丢掉）：llama.cpp 自带的 WebUI
            // 资源是 gzip 存的，引擎要看到 `Accept-Encoding: gzip` 才肯发；不给就整页回
            // 415 + `Error: gzip is not supported by this browser`（实测）。压缩响应不用我们
            // 解压：`Content-Encoding` 跟着上游头一起给客户端，由客户端自己解。
            "host" | "connection" | "expect" | "proxy-connection" => continue,
            _ => {}
        }
        request.push_str(name);
        request.push_str(": ");
        request.push_str(value);
        request.push_str("\r\n");
    }
    // 鉴权头原样透传，前门**不代客户端补 key**（用户 m06545：客户端必须自己带 key）。
    // 引擎按各自 config 的 `api_key` 加了 `--api-key` 之后，只带 key 的客户端才连得上。
    request.push_str(&format!("Host: {host}:{port}\r\n"));
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

    // 上游响应头先自己读出来，缺 CORS 头就补一条再转给客户端。
    //
    // Strata 引擎是 Python `http.server`，响应里**不带** `Access-Control-Allow-Origin`；
    // webview（`tauri://localhost`）直连本机端口算跨源，转发头原样给了它会被浏览器
    // 拦在响应到达 JS 之前 —— 前端只能看到 `TypeError: Failed to fetch`（用户 m12671
    // 压测 strata 模型就是这个），而不是任何 HTTP 状态码。
    // llama.cpp / router 自带 CORS，所以这条对那条通道没有影响（已有就不重复加）。
    // `read_head` 读到 `\r\n\r\n` 就停，不会把 body 一起吞掉。
    let mut head = read_head(&mut upstream)?;
    if !String::from_utf8_lossy(&head)
        .to_ascii_lowercase()
        .contains("access-control-allow-origin")
        && head.ends_with(b"\r\n\r\n")
    {
        head.truncate(head.len() - 4);
        head.extend_from_slice(b"\r\nAccess-Control-Allow-Origin: *\r\n\r\n");
    }
    client.write_all(&head)?;
    client.flush()?;

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
/// 启动时把「前门能点到哪些模型」打进日志（用户 m02352 第 2 点）。
///
/// 客户端是照着这个列表点名 `model` 的，日志里看不到就得去翻配置目录；两个通道各起一行，
/// 启动日志本身就说明前门当前认得哪些模型。
fn log_available_models(state: &AppState) {
    let payload = models_payload(state);
    let empty: Vec<Value> = Vec::new();
    let items = payload.get("data").and_then(|v| v.as_array()).unwrap_or(&empty);
    let mut llamacpp: Vec<&str> = Vec::new();
    let mut strata: Vec<&str> = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if item.get("channel").and_then(|v| v.as_str()) == Some("strata") {
            strata.push(id);
        } else {
            llamacpp.push(id);
        }
    }
    state.logs.push(
        "system",
        format!(
            "[gui] 前门可用模型 {} 个（llama.cpp {} / Strata {}）",
            items.len(),
            llamacpp.len(),
            strata.len()
        ),
    );
    if !llamacpp.is_empty() {
        state
            .logs
            .push("system", format!("[gui]   llama.cpp：{}", llamacpp.join("、")));
    }
    if !strata.is_empty() {
        state
            .logs
            .push("system", format!("[gui]   Strata：{}", strata.join("、")));
    }
}

fn models_payload(state: &AppState) -> Value {
    let entries = config_entries(state);
    let live = live_model_name(state, &entries);
    let mut data: Vec<Value> = entries
        .iter()
        .map(|entry| {
            let loaded = live.as_deref() == Some(entry.model_name.as_str());
            json!({
                "id": entry.model_name,
                "object": "model",
                "channel": "strata",
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
    // llama.cpp 通道（P1）：配置目录里每一份都列上；未加载的也列 —— 客户端要能点名触发加载。
    data.extend(llama_models_payload(state));
    json!({ "object": "list", "data": data })
}

/// llama.cpp 通道（P1）的模型列表：id 用配置里的 `name`（请求就按它点名），
/// 同时带 `channel` / `port` / 调度器状态，便于界面区分两个通道。
fn llama_models_payload(state: &AppState) -> Vec<Value> {
    let dir = state.model_config_dir();
    let items = model_config::load_dir(&dir);
    let sched = scheduler::lock_sched(state);
    items
        .iter()
        .map(|item| {
            let state_now = sched.table().state_of(&item.id);
            json!({
                "id": item.config.name,
                "object": "model",
                "channel": "llamacpp",
                // `status.value` 沿用 router 那套词汇（loaded/unloaded/loading）：前端卡片的
                // 状态判断不用改；细粒度状态另给 `state`（idle/starting/ready/…）。
                // 启动/停止中必须报 `loading` —— 否则前端整段时间都显示「未加载」，
                // 「加载中」永远不会出现（用户 m02048 第 2 点）。
                "status": {
                    "value": match state_now {
                        scheduler::ModelState::Ready => "loaded",
                        scheduler::ModelState::Starting | scheduler::ModelState::Stopping => "loading",
                        _ => "unloaded",
                    },
                },
                "state": state_now.as_str(),
                "loaded": state_now == scheduler::ModelState::Ready,
                "port": item.config.port,
"meta": { "n_ctx": crate::models::context_limit(&item.config).unwrap_or(0) },
                "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] },
            })
        })
        .collect()
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
    // 没有 Content-Length 才是「确实没有体」；有但解析不了是坏请求，转发一份截断的
    // 请求上游只会得到莫名其妙的 400，不如当场说清楚（审查发现）
    let Some(raw_len) = header_value(headers, "content-length") else {
        return Ok(Vec::new());
    };
    let len = raw_len.trim().parse::<usize>().map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("Content-Length 不是数字：{raw_len}"),
        )
    })?;
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
        // 解析不了就报错：以前 unwrap_or(0) 会把它当成结束块，请求体被静默截断（审查发现）
        let size = usize::from_str_radix(
            size_text.trim().split(';').next().unwrap_or("0").trim(),
            16,
        )
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("分块长度不是十六进制：{}", size_text.trim()),
            )
        })?;
        if size == 0 {
            // 结束块之后只有一个空行（trailer 不转发了）。
            out.extend_from_slice(&read_crlf_line(client)?);
            break;
        }
        // 长度来自客户端：加法溢出在上限判断之前就会 panic（debug 构建）
        let needed = size
            .checked_add(2)
            .and_then(|chunk_len| out.len().checked_add(chunk_len))
            .ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, "分块长度溢出")
            })?;
        if needed > MAX_BODY_BYTES {
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
    // CORS 头必须带：webview（`tauri://localhost`）直连本机端口算**跨源**请求，
    // router 自带 CORS 所以老路能work，前门自己合成的响应不带就会被浏览器拦掉
    // （症状：前端只能看到「读取前门模型列表失败」这种笼统的 fetch 失败）。
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: authorization, content-type, x-api-key\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    client.write_all(head.as_bytes())?;
    client.write_all(&body)?;
    client.flush()
}

/// 跨源预检（`OPTIONS`）的应答：CORS 头 + 204，无 body。
fn send_preflight(client: &mut TcpStream) -> std::io::Result<()> {
    let head = "HTTP/1.1 204 No Content\r\n\
                Content-Length: 0\r\n\
                Access-Control-Allow-Origin: *\r\n\
                Access-Control-Allow-Headers: authorization, content-type, x-api-key\r\n\
                Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                Connection: close\r\n\r\n";
    client.write_all(head.as_bytes())?;
    client.flush()
}

/// 随程序启动前门（用户 m00798 + A3：对外只留一个端口，llama.cpp 与 Strata 两通道都走它）。
///
/// 与 [`strata_proxy_start`] 的区别：不广播状态、不动托盘菜单（启动早期两者都还没就绪），
/// 失败由调用方记日志——端口被占时程序照常可用，用户在胶囊里改端口后再点启动即可。
pub fn autostart(app: &AppHandle, state: &AppState) -> Result<u16, String> {
    if let Some(port) = running_port(state) {
        return Ok(port);
    }
    let settings = state.settings.get();
    let host = settings
        .strata_host
        .clone()
        .filter(|h| !h.trim().is_empty())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = settings.strata_port.unwrap_or(DEFAULT_PORT);
    let handle = start(app, &host, port)?;
    *state
        .strata_proxy
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(handle);
    state.logs.push(
        "system",
        format!("[gui] 前门已监听 {host}:{port}（llama.cpp 子实例与 Strata 引擎都从这一个端口进）"),
    );
    log_available_models(state);
    // 空闲释放不在这里挂：它是常驻线程（`lib.rs` 的 setup 里挂一次），每轮实时读设置，
    // 跟前门起没起、是自动起还是手动起的都无关（用户 m06652）。
    Ok(port)
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
    log_available_models(state.inner());

    let snapshot = crate::strata_snapshot(&state);
    let _ = app.emit("strata://status", snapshot.clone());
    // 托盘提示与菜单可用性都跟着前门走：用户看到的「服务」就是它。
    crate::tray::sync_tooltip(&app, true, port);
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
    crate::tray::sync_tooltip(&app, false, port);
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
