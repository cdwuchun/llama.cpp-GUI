//! 极简本机 HTTP 客户端：连上、发一个请求、读到 EOF。
//!
//! 目标是 127.0.0.1 上 router 的明文 HTTP，不需要 TLS / 连接池 / 重定向。
//! 压测（bench.rs）与空闲卸载（idle.rs）共用这一份实现。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 发一个请求并返回响应体。
///
/// body 为 None 时不带请求体（GET）。响应不是 2xx 时，尽量把 llama.cpp
/// JSON 错误体里的 error.message 提出来当错误文本。
pub fn request(
    host: &str,
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    api_key: Option<&str>,
    deadline: Duration,
) -> Result<String, String> {
    let addr = format!("{host}:{port}");
    let mut stream = TcpStream::connect(&addr).map_err(|e| format!("连接 {addr} 失败：{e}"))?;
    stream.set_read_timeout(Some(deadline)).ok();
    stream.set_write_timeout(Some(deadline)).ok();
    stream.set_nodelay(true).ok();

    let payload = body.unwrap_or("");
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
    if !payload.is_empty() {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", payload.as_bytes().len()));
    }
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        req.push_str(&format!("Authorization: Bearer {key}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(payload);

    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送请求失败：{e}"))?;
    stream.flush().ok();

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if raw.is_empty() {
        return Err("响应为空".into());
    }

    let text = String::from_utf8_lossy(&raw).into_owned();
    let (head, body_text) = match text.split_once("\r\n\r\n") {
        Some((h, b)) => (h.to_string(), b.to_string()),
        None => (text.clone(), String::new()),
    };

    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    let lower = head.to_ascii_lowercase();
    let payload = if lower.contains("transfer-encoding: chunked") {
        dechunk(&body_text)
    } else {
        body_text
    };

    if !(200..300).contains(&status) {
        let msg = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| payload.chars().take(200).collect());
        return Err(format!("HTTP {status}：{msg}"));
    }
    Ok(payload)
}

/// 去掉 chunked 编码的分块长度行。
fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some((len_line, tail)) = rest.split_once("\r\n") else {
            break;
        };
        let size = usize::from_str_radix(len_line.trim().split(';').next().unwrap_or("0"), 16)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        if tail.len() < size {
            out.push_str(tail);
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].strip_prefix("\r\n").unwrap_or(&tail[size..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dechunk_decodes_chunked_body() {
        let body = "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(dechunk(body), "hello world");
    }
}
