//! 模型休眠后的彻底卸载。
//!
//! --sleep-idle-seconds 只是让子实例进入 sleep：权重与 KV 放掉，但子进程还在，
//! CUDA context 仍占着显存。实机实测（610 MB 的 Q8 模型、单卡、--sleep-idle-seconds 5）：
//! 加载完成 10158 MB → 休眠 156 MB → 卸载 0 MB —— 用户看到的"还剩 0.2 GB"就是这一段。
//!
//! 这里轮询 router 的 GET /models，看到哪个模型 status.value == "sleeping" 就
//! POST /models/unload 让 router 收掉子实例；下一次请求 router 会自动重新加载。
//! 轮询不会打断子实例的 idle 计时（实测：每秒轮询的同时，状态仍在第 5 秒如期切到 sleeping）。
//!
//! 轮询间隔**自适应**：有模型在跑（loaded / loading / downloading）时用 1s，那时随时可能睡着；
//! 全是 unloaded 时放慢到 5s —— 没有东西会进入休眠，查得再勤也没用。
//! 一次 GET /models 的响应实测约 25 KB（19 个模型，args 占大头），降频能省掉空闲期的绝大部分回环流量。

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::http;
use crate::router::{LogHub, RouterProcess};

/// 有模型在跑时的轮询间隔：睡得越早被发现，显存回来得越早。
const ACTIVE_POLL: Duration = Duration::from_secs(1);
/// 没有任何模型在跑时的间隔。
const IDLE_POLL: Duration = Duration::from_secs(5);
/// 本机请求的超时。
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// 一次 `GET /models` 里我们关心的两部分。
struct ModelsState {
    /// 已休眠、等着被卸载的模型名。
    sleeping: Vec<String>,
    /// 是否还有"在跑"的模型（loaded / loading / downloading）。
    active: bool,
}

/// 取一个模型条目的 status.value。
fn status_of(m: &Value) -> &str {
    m.get("status")
        .and_then(|s| s.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or_default()
}

/// 解析 `GET /models` 的响应。不是合法 JSON / 结构不对时返回 `None`，
/// 调用方据此**保持**当前节奏（不要因为一次坏响应就把轮询放慢）。
fn parse_models(body: &str) -> Option<ModelsState> {
    let v: Value = serde_json::from_str(body).ok()?;
    let items = v.get("data")?.as_array()?;

    let mut sleeping = Vec::new();
    let mut active = false;
    for m in items {
        match status_of(m) {
            "sleeping" => {
                if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                    sleeping.push(id.to_string());
                }
            }
            // sleeping 不算"在跑"：它马上就会被我们卸载掉，卸载完就是 unloaded。
            "loaded" | "loading" | "downloading" => active = true,
            _ => {}
        }
    }
    Some(ModelsState { sleeping, active })
}

/// 随 router 一起启动：定期把已休眠的模型卸载掉。
///
/// 只监测自己启动时看到的那个 pid（与 router::spawn_monitor 同一套判断）：
/// router 重启后旧线程看到 slot 里换了进程就直接退出，不会随重启次数累积。
pub fn spawn_idle_unloader(
    app: AppHandle,
    slot: Arc<Mutex<Option<RouterProcess>>>,
    hub: Arc<LogHub>,
    port: u16,
    api_key: Option<String>,
) {
    thread::spawn(move || {
        let mut watched_pid: Option<u32> = None;
        // 启动时多半还没有模型被加载，先从慢档起步。
        let mut interval = IDLE_POLL;
        loop {
            thread::sleep(interval);

            {
                let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
                let Some(process) = guard.as_ref() else {
                    return; // 已被 stop() 取走，守卫结束
                };
                let pid = process.child.id();
                match watched_pid {
                    None => watched_pid = Some(pid),
                    Some(known) if known == pid => {}
                    Some(_) => return,
                }
            }

            let key = api_key.as_deref();
            let Ok(list) =
                http::request("127.0.0.1", port, "GET", "/models", None, key, HTTP_TIMEOUT)
            else {
                continue; // router 正忙或刚重启，下一轮再看
            };
            let Some(state) = parse_models(&list) else {
                continue; // 响应看不懂：保持当前节奏
            };
            interval = if state.active { ACTIVE_POLL } else { IDLE_POLL };

            for model in state.sleeping {
                let payload = json!({ "model": model }).to_string();
                let text = match http::request(
                    "127.0.0.1",
                    port,
                    "POST",
                    "/models/unload",
                    Some(&payload),
                    key,
                    HTTP_TIMEOUT,
                ) {
                    Ok(_) => format!("[gui] 模型 {model} 已休眠，卸载实例以释放显存"),
                    Err(err) => format!("[gui] 卸载休眠模型 {model} 失败：{err}"),
                };
                let line = hub.push("system", text);
                let _ = app.emit("logs://lines", vec![line]);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_only_sleeping_models() {
        let body = r#"{"data":[
            {"id":"a","status":{"value":"loaded"}},
            {"id":"b","status":{"value":"sleeping"}},
            {"id":"c","status":{"value":"unloaded"}},
            {"id":"d","status":{"value":"sleeping"}}
        ]}"#;
        let state = parse_models(body).expect("应当是合法响应");
        assert_eq!(state.sleeping, vec!["b", "d"]);
        assert!(state.active, "有 loaded 的模型 ⇒ 用快档");
    }

    #[test]
    fn ignores_bodies_without_sleeping_models() {
        assert!(parse_models("not json").is_none());
        let empty = parse_models(r#"{"data":[]}"#).expect("空列表也是合法响应");
        assert!(empty.sleeping.is_empty());
        assert!(!empty.active, "没有模型 ⇒ 用慢档");

        let loading = parse_models(r#"{"data":[{"id":"a","status":{"value":"loading"}}]}"#)
            .expect("应当是合法响应");
        assert!(loading.sleeping.is_empty());
        assert!(loading.active, "loading 也会变成 loaded ⇒ 用快档");
    }

    #[test]
    fn sleeping_alone_does_not_count_as_active() {
        // 只剩一个没卸载掉的 sleeping：卸完就是 unloaded，不该一直占着快档。
        let body = r#"{"data":[{"id":"a","status":{"value":"sleeping"}}]}"#;
        let state = parse_models(body).expect("应当是合法响应");
        assert_eq!(state.sleeping, vec!["a"]);
        assert!(!state.active);
    }

    #[test]
    fn loading_downloading_and_loaded_are_active() {
        for value in ["loaded", "loading", "downloading"] {
            let body = format!(r#"{{"data":[{{"id":"a","status":{{"value":"{value}"}}}}]}}"#);
            let state = parse_models(&body).expect("应当是合法响应");
            assert!(state.active, "{value} 应当算在跑");
        }
    }
}
