/**
 * MCP（Model Context Protocol）客户端：聊天页的工具来源之一。
 *
 * llama.cpp b11671 自带 `--mcp-servers-config`，但那套工具在 server 进程内部执行，
 * GUI 既看不到每次调用、也不能在聊天卡片上展示结果；本工程的联网搜索（`search.rs`）
 * 一直是「GUI 执行、结果回填」的链路，MCP 走同一条链路：
 *
 * 1. 用户在聊天设置里配好服务器（stdio 子进程：命令 + 参数 + 环境变量）；
 * 2. 勾选「MCP 工具」后，`mcp_tools_list` 启动各服务器、`tools/list` 拉工具，
 *    转成 OpenAI `tools` 数组的一部分发给模型；
 * 3. 模型要调用时前端调 `mcp_tool_call`，本模块走 `tools/call` 执行，结果作为
 *    `role:"tool"` 消息回填（与 `web_search` 完全同一条链路）。
 *
 * 协议按 MCP 2024-11-05（JSON-RPC over stdio，一行一条 NDJSON）；配置文件的形状
 * 与 Cursor 的 `mcpServers` 一致，参照物是 llama.cpp 的
 * `tools/server/server-mcp.cpp`（同一套 initialize / tools/list / tools/call 流程）。
 *
 * 服务器清单落在 `<配置目录>\mcp.json`：`{"servers":[{"name","command","args","env","enabled"}]}`。
 * env 里的密钥与 `search.json` 的 key 同口径：明文落盘、不发日志、不回显到界面输入框之外。
 */

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// MCP 协议版本。2024-11-05 是最初的稳定版，llama.cpp 与绝大多数服务器都用它；
/// 服务器更高版本时也接受（`initialize` 的回包里 server 会报自己支持的版本，这里不校验）。
const PROTOCOL_VERSION: &str = "2024-11-05";

/// `initialize` / `tools/list` 的超时：node / python 服务器的冷启动可能要几秒。
const INIT_TIMEOUT: Duration = Duration::from_secs(20);
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// 单次工具调用的超时。搜索类工具可能跑几十秒，给足。
const CALL_TIMEOUT: Duration = Duration::from_secs(180);

/// 工具名长度上限（OpenAI 的 function.name 要求 1..=64，且只允许字母数字与 `_-`）
const TOOL_KEY_MAX: usize = 64;

// ---------------------------------------------------------------- 配置

fn yes() -> bool {
    true
}

/// 一台 MCP 服务器（`mcp.json` 里的一项）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct McpServer {
    /// 服务器名：工具前缀与日志里都用它，必须唯一
    pub name: String,
    /// 启动命令（Windows 上 `npx` 这类脚本要写 `npx.cmd` 或完整路径）
    pub command: String,
    pub args: Vec<String>,
    /// 追加/覆盖的环境变量（父进程环境默认继承）
    pub env: HashMap<String, String>,
    /// 关掉即不启动、工具也不暴露
    #[serde(default = "yes")]
    pub enabled: bool,
}

impl Default for McpServer {
    fn default() -> Self {
        Self {
            name: String::new(),
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            enabled: true,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    pub servers: Vec<McpServer>,
}

fn config_path(config_dir: &PathBuf) -> PathBuf {
    config_dir.join("mcp.json")
}

/// 读配置。文件不存在或读坏了都退回空清单（不阻断聊天）。
pub fn load_config(config_dir: &PathBuf) -> McpConfig {
    match fs::read_to_string(config_path(config_dir)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => McpConfig::default(),
    }
}

/// 写配置（临时文件 + 改名，半截文件不会顶掉原配置）。
pub fn save_config(config_dir: &PathBuf, config: &McpConfig) -> Result<(), String> {
    let text = serde_json::to_string_pretty(config).map_err(|error| format!("序列化 mcp.json 失败：{error}"))?;
    let path = config_path(config_dir);
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, text).map_err(|error| format!("写 mcp.json 失败：{error}"))?;
    fs::rename(&temp, &path).map_err(|error| format!("替换 mcp.json 失败：{error}"))
}

// ---------------------------------------------------------------- 对外视图

/// 一个 MCP 工具。`key` 是发给模型的名字（`function.name`），必须满足 OpenAI 的字符与长度限制，
/// 所以由后端统一清洗并保证唯一 —— 前端只按 `key` 反查回 `server` + `name`。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpToolView {
    /// 发给模型的工具名：`mcp__<server>__<tool>`
    pub key: String,
    /// 服务器名（原始写法）
    pub server: String,
    /// 服务器里的工具名（原始写法，`tools/call` 要用它）
    pub name: String,
    pub description: String,
    /// 工具的 JSON Schema；服务器没给时是空对象 schema
    pub input_schema: Value,
}

/// 一台服务器的拉取结果（设置面板的「刷新」按钮逐台显示）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpServerView {
    pub name: String,
    pub ok: bool,
    /// 这台服务器提供了几个工具
    pub count: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolsView {
    pub tools: Vec<McpToolView>,
    /// 每台启用服务器的状态（失败的也列出来，带原因）
    pub servers: Vec<McpServerView>,
}

// ---------------------------------------------------------------- 子进程与 RPC

/// 一台已启动的服务器。`rx` 是读线程把 stdout 每行解析后投递过来的队列。
struct Proc {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Value>,
    next_id: u64,
    initialized: bool,
    tools: Vec<McpToolView>,
}

impl Proc {
    /// 子进程还活着吗（`try_wait` 拿不到退出码就是活着）
    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 进程表：每台服务器一把自己的锁。表锁只在取/放槽位时短暂持有 —— `tools/list`、
/// `tools/call` 这类要等服务器回包的 RPC 不能压着表锁（审查发现：以前一把全局锁跨 RPC）。
fn manager() -> &'static Mutex<HashMap<String, Arc<Mutex<Proc>>>> {
    static MANAGER: OnceLock<Mutex<HashMap<String, Arc<Mutex<Proc>>>>> = OnceLock::new();
    MANAGER.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Windows 的 `CreateProcess` 不认 `PATHEXT`：写 `npx` 会直接失败，必须 `npx.cmd`。
/// 用户多半照文档写 `npx` / `uvx`，所以这里补出候选，逐个试到能拉起来为止。
#[cfg(windows)]
fn command_candidates(raw: &str) -> Vec<String> {
    let mut out = vec![raw.to_string()];
    if std::path::Path::new(raw).extension().is_none() {
        for ext in [".cmd", ".exe", ".bat"] {
            out.push(format!("{raw}{ext}"));
        }
    }
    out
}

#[cfg(not(windows))]
fn command_candidates(raw: &str) -> Vec<String> {
    vec![raw.to_string()]
}

/// 启动一台服务器。`env` 是追加/覆盖，父进程环境照常继承（Python / node 都依赖 PATH）。
fn start(server: &McpServer) -> Result<Proc, String> {
    let raw = server.command.trim();
    if raw.is_empty() {
        return Err(format!("MCP 服务器「{}」没写启动命令", server.name));
    }

    let mut child = None;
    let mut last_error = String::new();
    let candidates = command_candidates(raw);
    for candidate in &candidates {
        let mut command = Command::new(candidate);
        command
            .args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // stderr 不接：子进程写满管道会卡住，接进 GUI 日志又会混进别人的调试输出。
            // 服务器自己的错误通过 JSON-RPC 的 error 回包反映。
            .stderr(Stdio::null());
        for (key, value) in &server.env {
            command.env(key, value);
        }
        // Windows 上不加这个，python / node 会带出一个黑色控制台窗口
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        match command.spawn() {
            Ok(process) => {
                child = Some(process);
                break;
            }
            Err(error) => last_error = format!("{candidate}：{error}"),
        }
    }
    let mut child = child.ok_or_else(|| {
        let tried = if candidates.len() > 1 {
            format!("（尝试了 {}）", candidates.join("、"))
        } else {
            String::new()
        };
        format!(
            "启动 MCP 服务器「{}」失败：{last_error}{tried}（参数：{}）",
            server.name,
            server.args.join(" ")
        )
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| format!("MCP 服务器「{}」没有 stdin", server.name))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("MCP 服务器「{}」没有 stdout", server.name))?;

    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        // 一行一条 JSON-RPC 消息。解析不了的行走（协议只允许 JSON），`tx` 断开即读线程结束。
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                if tx.send(value).is_err() {
                    break;
                }
            }
        }
    });

    Ok(Proc {
        child,
        stdin,
        rx,
        next_id: 1,
        initialized: false,
        tools: Vec::new(),
    })
}

fn send(proc: &mut Proc, payload: &Value) -> Result<(), String> {
    let mut text = serde_json::to_string(payload).map_err(|error| format!("序列化 MCP 请求失败：{error}"))?;
    text.push('\n');
    proc.stdin
        .write_all(text.as_bytes())
        .and_then(|_| proc.stdin.flush())
        .map_err(|error| format!("写 MCP 请求失败：{error}"))
}

/// 发一条带 id 的请求并等它的回包。期间到达的通知 / 陈旧回包直接丢掉
/// （延迟过久的回包我们早就不等了 —— id 单调递增，不会被未来的请求认领）。
fn request(proc: &mut Proc, method: &str, params: Option<Value>, timeout: Duration) -> Result<Value, String> {
    let id = proc.next_id;
    proc.next_id += 1;
    let mut payload = json!({ "jsonrpc": "2.0", "id": id, "method": method });
    if let Some(params) = params {
        payload["params"] = params;
    }
    send(proc, &payload)?;

    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!("MCP {method} 超时（{} 秒）", timeout.as_secs()));
        }
        match proc.rx.recv_timeout(left) {
            Ok(value) => {
                if value.get("id").and_then(Value::as_u64) != Some(id) {
                    continue; // 通知，或者别的请求的回包
                }
                if let Some(error) = value.get("error") {
                    return Err(rpc_error_text(error));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!("MCP {method} 超时（{} 秒）", timeout.as_secs()))
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err(format!("MCP 服务器已退出（{method} 没有回包）"))
            }
        }
    }
}

fn rpc_error_text(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("未知错误")
        .to_string();
    match error.get("code").and_then(Value::as_i64) {
        Some(code) => format!("{message}（code {code}）"),
        None => message,
    }
}

fn ensure_init(proc: &mut Proc) -> Result<(), String> {
    if proc.initialized {
        return Ok(());
    }
    let params = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "llama.cpp GUI", "version": env!("CARGO_PKG_VERSION") },
    });
    request(proc, "initialize", Some(params), INIT_TIMEOUT)?;
    // 通知：没有 id，服务器不回包
    send(proc, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
    proc.initialized = true;
    Ok(())
}

fn list_tools(proc: &mut Proc) -> Result<Vec<McpToolView>, String> {
    ensure_init(proc)?;
    let result = request(proc, "tools/list", None, LIST_TIMEOUT)?;
    let mut tools = Vec::new();
    if let Some(items) = result.get("tools").and_then(Value::as_array) {
        for item in items {
            let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if name.is_empty() {
                continue;
            }
            let description = item
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let input_schema = item
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            tools.push(McpToolView {
                key: String::new(), // 统一在 list_all_tools 里按服务器前缀编号
                server: String::new(),
                name,
                description,
                input_schema,
            });
        }
    }
    Ok(tools)
}

/// 把 `tools/call` 的 result 规整成给模型看的纯文本（照 llama.cpp 的 `mcp_result_to_response`）：
/// `content` 里 type=text 的段落按序拼接；`isError` 置位时前缀「错误」。
fn normalize_result(result: &Value) -> String {
    let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = result.get("content").and_then(Value::as_array) {
        for item in items {
            match item.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        parts.push(text.to_string());
                    }
                }
                Some("resource") => {
                    if let Some(text) = item
                        .get("resource")
                        .and_then(|value| value.get("text"))
                        .and_then(Value::as_str)
                    {
                        parts.push(text.to_string());
                    }
                }
                // 图片 / 音频等二进制内容没法直接喂给文本模型，给一句占位
                Some(other) => parts.push(format!("（MCP 返回了 {other} 类型的内容，已省略）")),
                None => {}
            }
        }
    }
    if parts.is_empty() {
        // 没有 content 时退回整段 JSON，至少不丢信息
        let text = serde_json::to_string(result).unwrap_or_else(|_| "{}".to_string());
        parts.push(text);
    }
    let body = parts.join("\n");
    if is_error {
        format!("错误：{body}")
    } else {
        body
    }
}

fn call_tool(proc: &mut Proc, tool: &str, arguments: &Value) -> Result<String, String> {
    ensure_init(proc)?;
    let params = json!({ "name": tool, "arguments": arguments });
    let result = request(proc, "tools/call", Some(params), CALL_TIMEOUT)?;
    Ok(normalize_result(&result))
}

/// 取一台服务器的进程：没有就启动；有但已经退出就重建（服务器崩过一次不该让工具永久失效）。
///
/// 返回的是槽位本身（`Arc<Mutex<Proc>>`），调用方拿表锁只到这一步，之后的 RPC 在
/// 自己的锁里做。
fn ensure_proc(
    map: &mut HashMap<String, Arc<Mutex<Proc>>>,
    server: &McpServer,
) -> Result<Arc<Mutex<Proc>>, String> {
    let dead = match map.get(server.name.as_str()) {
        Some(slot) => slot.lock().map(|mut proc| !proc.alive()).unwrap_or(true),
        None => false,
    };
    if dead {
        if let Some(dead_slot) = map.remove(server.name.as_str()) {
            if let Ok(mut proc) = dead_slot.lock() {
                proc.kill();
            }
        }
    }
    if let Some(slot) = map.get(server.name.as_str()) {
        return Ok(slot.clone());
    }
    let proc = start(server)?;
    let slot = Arc::new(Mutex::new(proc));
    map.insert(server.name.clone(), slot.clone());
    Ok(slot)
}

// ---------------------------------------------------------------- 工具名

/// 清洗成 `function.name` 允许的字符集（`[A-Za-z0-9_-]`），过长的截断。
fn slug(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

/// 给全部工具编 `key`：`mcp__<server>__<tool>`，超长截断后用序号保证唯一
/// （模型侧的 `function.name` 重复会让 llama.cpp 直接报错）。
fn assign_keys(tools: &mut [McpToolView]) {
    let mut used: HashMap<String, usize> = HashMap::new();
    for tool in tools.iter_mut() {
        let base = format!("mcp__{}__{}", slug(&tool.server), slug(&tool.name));
        let mut key = base.clone();
        if key.len() > TOOL_KEY_MAX {
            key.truncate(TOOL_KEY_MAX);
        }
        // 重名（不同服务器有同名工具、或者截断后撞车）加 `_2` / `_3`
        let count = used.entry(base.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            let suffix = format!("_{count}");
            if key.len() + suffix.len() > TOOL_KEY_MAX {
                key.truncate(TOOL_KEY_MAX - suffix.len());
            }
            key.push_str(&suffix);
        }
        tool.key = key;
    }
}

// ---------------------------------------------------------------- 命令

#[tauri::command]
pub fn mcp_servers_list(state: tauri::State<'_, crate::state::AppState>) -> Vec<McpServer> {
    load_config(&state.config_dir).servers
}

/// 保存服务器清单：校验名字唯一、命令非空，然后落盘并**停掉所有已启动的进程** ——
/// 命令 / 环境变量改了以后必须重连才生效，留着旧进程会让「改了没反应」再出现一次。
#[tauri::command]
pub fn mcp_servers_save(
    state: tauri::State<'_, crate::state::AppState>,
    servers: Vec<McpServer>,
) -> Result<Vec<McpServer>, String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut cleaned: Vec<McpServer> = Vec::with_capacity(servers.len());
    for server in servers {
        let name = server.name.trim().to_string();
        if name.is_empty() {
            return Err("MCP 服务器名不能为空".to_string());
        }
        if seen.insert(name.clone(), 1).is_some() {
            return Err(format!("MCP 服务器名重复：{name}"));
        }
        let command = server.command.trim().to_string();
        if command.is_empty() {
            return Err(format!("MCP 服务器「{name}」没写启动命令"));
        }
        cleaned.push(McpServer {
            name,
            command,
            args: server
                .args
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect(),
            env: server
                .env
                .into_iter()
                .filter(|(key, value)| !key.trim().is_empty() && !value.trim().is_empty())
                .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
                .collect(),
            enabled: server.enabled,
        });
    }
    let config = McpConfig { servers: cleaned.clone() };
    save_config(&state.config_dir, &config)?;
    stop_all();
    Ok(cleaned)
}

/// 拉取全部启用的服务器的工具。逐台启动 + `tools/list`，失败的服务器记下原因继续下一台 ——
/// 一台配错不该让整片工具消失。
#[tauri::command]
pub async fn mcp_tools_list(
    state: tauri::State<'_, crate::state::AppState>,
) -> Result<McpToolsView, String> {
    let config = load_config(&state.config_dir);
    tauri::async_runtime::spawn_blocking(move || {
        let mut view = McpToolsView::default();
        let mut map = manager().lock().map_err(|_| "MCP 进程表被占用".to_string())?;
        for server in config.servers.iter().filter(|server| server.enabled) {
            let slot = match ensure_proc(&mut map, server) {
                Ok(slot) => slot,
                Err(error) => {
                    view.servers.push(McpServerView {
                        name: server.name.clone(),
                        ok: false,
                        count: 0,
                        error: Some(error),
                    });
                    continue;
                }
            };
            // RPC 要等服务器回包（最长 LIST_TIMEOUT）：表锁放到这里，只压这台自己的锁
            drop(map);
            let outcome = (|| -> Result<Vec<McpToolView>, String> {
                let mut proc = slot.lock().map_err(|_| "MCP 进程被占用".to_string())?;
                let cached = proc.tools.clone();
                if !cached.is_empty() {
                    return Ok(cached);
                }
                let mut tools = list_tools(&mut proc)?;
                for tool in tools.iter_mut() {
                    tool.server = server.name.clone();
                }
                proc.tools = tools.clone();
                Ok(tools)
            })();
            map = manager().lock().map_err(|_| "MCP 进程表被占用".to_string())?;
            match outcome {
                Ok(tools) => {
                    view.servers.push(McpServerView {
                        name: server.name.clone(),
                        ok: true,
                        count: tools.len(),
                        error: None,
                    });
                    view.tools.extend(tools);
                }
                Err(error) => {
                    // 起不来就丢掉进程，下次刷新重新拉
                    if let Some(dead_slot) = map.remove(server.name.as_str()) {
                        if let Ok(mut proc) = dead_slot.lock() {
                            proc.kill();
                        }
                    }
                    view.servers.push(McpServerView {
                        name: server.name.clone(),
                        ok: false,
                        count: 0,
                        error: Some(error),
                    });
                }
            }
        }
        assign_keys(&mut view.tools);
        // 缓存进各自进程的工具没有 key（key 在全局编号后才算），这里补回去，避免下次
        // 命中缓存时 key 为空
        for tool in &view.tools {
            if let Some(slot) = map.get(tool.server.as_str()) {
                if let Ok(mut proc) = slot.lock() {
                    for cached in proc.tools.iter_mut() {
                        if cached.name == tool.name {
                            cached.key = tool.key.clone();
                        }
                    }
                }
            }
        }
        drop(map);
        Ok(view)
    })
    .await
    .map_err(|error| format!("拉取 MCP 工具失败：{error}"))?
}

/// 执行一次工具调用，返回给模型看的文本。
#[tauri::command]
pub async fn mcp_tool_call(
    state: tauri::State<'_, crate::state::AppState>,
    server: String,
    tool: String,
    arguments: Value,
) -> Result<String, String> {
    let config = load_config(&state.config_dir);
    let found = config
        .servers
        .into_iter()
        .find(|item| item.name == server && item.enabled)
        .ok_or_else(|| format!("MCP 服务器「{server}」不存在或已禁用"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let slot = {
            let mut map = manager().lock().map_err(|_| "MCP 进程表被占用".to_string())?;
            ensure_proc(&mut map, &found)?
        };
        // 只压这台服务器自己的锁：一次 tools/call 可能跑几十秒
        let mut proc = slot.lock().map_err(|_| "MCP 进程被占用".to_string())?;
        call_tool(&mut proc, &tool, &arguments)
    })
    .await
    .map_err(|error| format!("MCP 工具调用失败：{error}"))?
}

/// 停掉全部服务器进程（保存配置、退出 GUI 时调用）。
pub fn stop_all() {
    // 先摘空表再逐个杀：kill 要等进程退出，不该压着表锁
    let slots: Vec<Arc<Mutex<Proc>>> = match manager().lock() {
        Ok(mut map) => map.drain().map(|(_, slot)| slot).collect(),
        Err(_) => return,
    };
    for slot in slots {
        if let Ok(mut proc) = slot.lock() {
            proc.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_allowed_chars_and_replaces_others() {
        assert_eq!(slug("read_file"), "read_file");
        assert_eq!(slug("my.tool/v2"), "my_tool_v2");
        assert_eq!(slug("名字"), "__");
        assert_eq!(slug(""), "_");
    }

    #[test]
    fn assign_keys_prefixes_and_dedupes() {
        let mut tools = vec![
            McpToolView {
                key: String::new(),
                server: "files".into(),
                name: "read".into(),
                description: String::new(),
                input_schema: json!({}),
            },
            McpToolView {
                key: String::new(),
                server: "files".into(),
                name: "read".into(),
                description: String::new(),
                input_schema: json!({}),
            },
            McpToolView {
                key: String::new(),
                server: "web".into(),
                name: "read".into(),
                description: String::new(),
                input_schema: json!({}),
            },
        ];
        assign_keys(&mut tools);
        assert_eq!(tools[0].key, "mcp__files__read");
        assert_eq!(tools[1].key, "mcp__files__read_2");
        assert_eq!(tools[2].key, "mcp__web__read");
    }

    #[test]
    fn normalize_result_joins_text_parts() {
        let result = json!({
            "content": [{ "type": "text", "text": "第一段" }, { "type": "text", "text": "第二段" }]
        });
        assert_eq!(normalize_result(&result), "第一段\n第二段");
    }

    #[test]
    fn normalize_result_marks_errors() {
        let result = json!({ "isError": true, "content": [{ "type": "text", "text": "没权限" }] });
        assert_eq!(normalize_result(&result), "错误：没权限");
    }

    #[test]
    fn normalize_result_falls_back_to_json() {
        let result = json!({ "ok": true });
        assert!(normalize_result(&result).contains("\"ok\""));
    }

    #[test]
    fn rpc_error_text_includes_code() {
        let error = json!({ "code": -32602, "message": "Invalid params" });
        assert_eq!(rpc_error_text(&error), "Invalid params（code -32602）");
    }

    /// 端到端：真起一个 node 进程跑 `tmp/mcp-echo-server.mjs`，走完
    /// initialize → tools/list → tools/call。需要本机有 node，所以默认 ignore：
    ///
    /// ```powershell
    /// cargo test --lib mcp::echo -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要本机 node，手动跑：cargo test --lib mcp::echo -- --ignored --nocapture"]
    fn echo_server_roundtrip() {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tmp")
            .join("mcp-echo-server.mjs");
        if !script.exists() {
            eprintln!("跳过：{} 不存在", script.display());
            return;
        }
        let server = McpServer {
            name: "echo".to_string(),
            command: "node".to_string(),
            args: vec![script.to_string_lossy().into_owned()],
            env: HashMap::new(),
            enabled: true,
        };
        let mut proc = start(&server).expect("启动 echo 服务器失败");
        let tools = list_tools(&mut proc).expect("tools/list 失败");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert!(tools[0].description.contains("原样返回"));
        let text = call_tool(&mut proc, "echo", &json!({ "text": "你好" })).expect("tools/call 失败");
        assert_eq!(text, "echo: 你好");
        proc.kill();
    }
}
