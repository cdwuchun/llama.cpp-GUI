//! 极简本机 HTTP 客户端：连上、发一个请求、读到 EOF。
//!
//! 目标是 127.0.0.1 上 router 的明文 HTTP，不需要 TLS / 连接池 / 重定向。
//! 压测（bench.rs）与空闲卸载（idle.rs）共用这一份实现。

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

/// 连接阶段的超时上限。
///
/// 调用方给的整体 deadline 可能很长（探测是 3 秒），但「连不上」和「连上了不答」是两码事：
/// 本机连一个没人监听的端口，被拒都要两秒（实测 127.0.0.1 约 2.0–2.2 秒），而
/// `TcpStream::connect` 不受读/写超时约束 —— 探一次就白等这么久。给连接单独一个短上限，
/// 本机正常连接是毫秒级（用户 m06134：卡片卡住，日志里每次读列表都耗时 6.1 秒）。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

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
    let sock = addr
        .to_socket_addrs()
        .map_err(|e| format!("解析 {addr} 失败：{e}"))?
        .next()
        .ok_or_else(|| format!("解析 {addr} 失败：没有可用地址"))?;
    let mut stream = TcpStream::connect_timeout(&sock, deadline.min(CONNECT_TIMEOUT))
        .map_err(|e| format!("连接 {addr} 失败：{e}"))?;
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

    // 响应头与体按字节切开：分块编码的长度行是**字节**数，先做 from_utf8_lossy 再按字符
    // 偏移切分，边界落在多字节字符中间就没法对齐（审查发现）
    let (head, body_bytes) = match raw.windows(4).position(|window| window == b"\r\n\r\n") {
        Some(pos) => (
            String::from_utf8_lossy(&raw[..pos]).into_owned(),
            &raw[pos + 4..],
        ),
        None => (String::from_utf8_lossy(&raw).into_owned(), &raw[raw.len()..]),
    };

    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(0);

    let lower = head.to_ascii_lowercase();
    let payload = if lower.contains("transfer-encoding: chunked") {
        String::from_utf8_lossy(&dechunk(body_bytes)).into_owned()
    } else {
        String::from_utf8_lossy(body_bytes).into_owned()
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
///
/// 按字节处理：分块长度是字节数，而响应体可能含多字节字符（UTF-8 的 `中` 是 3 字节）。
/// 以前把整份响应先 lossy 成 `&str` 再 `&tail[..size]` 切片，边界落在字符中间就 panic，
/// 读响应的线程直接打死（审查发现）。
fn dechunk(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(pos) = rest.windows(2).position(|window| window == b"\r\n") {
        let line = String::from_utf8_lossy(&rest[..pos]).into_owned();
        rest = &rest[pos + 2..];
        let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or("0").trim(), 16)
            .unwrap_or(0);
        if size == 0 {
            break;
        }
        if rest.len() < size {
            // 长度行说还有 size 字节，但连接已经结束：把剩下的原样收下
            out.extend_from_slice(rest);
            break;
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size..];
        if rest.starts_with(b"\r\n") {
            rest = &rest[2..];
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dechunk_decodes_chunked_body() {
        let body = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(dechunk(body), b"hello world");
    }

    #[test]
    fn dechunk_survives_a_boundary_inside_a_multibyte_char() {
        // 「中」是 3 字节，分块长度写 1：按字节切，不 panic、也不把后面的行当正文
        let body = b"1\r\n\xe4\xb8\xad\r\n0\r\n\r\n";
        assert_eq!(dechunk(body), b"\xe4");
    }

    #[test]
    fn dechunk_keeps_what_arrived_when_a_chunk_is_truncated() {
        // 长度行说 8 字节，实际只到了 3 字节：不能丢，也不能死等
        let body = b"8\r\nabc";
        assert_eq!(dechunk(body), b"abc");
    }
}
