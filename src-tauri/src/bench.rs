//! 性能测试后端：API 压测。
//!
//! 压测刻意放在 Rust 侧：webview 对同一主机只有 6 条 HTTP/1.1 连接，并发数一上去
//! 测的就是浏览器而不是模型；这里用线程 + 原生 socket 直连 router。
//!
//! 压测记录落盘在配置目录的 `bench/` 下（对应 hub 把记录存在服务端的做法）。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// 单次压测的耗时上限：模型可能要先加载，给足时间。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(900);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// API 压测
// ---------------------------------------------------------------------------

/// 一次压测的记录（字段名与前端表格列一一对应）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchRecord {
    pub ts_ms: u64,
    pub model: String,
    /// 服务端实际处理的提示词 token 数
    pub prompt_tokens: u32,
    pub prompt_per_second: f64,
    pub predicted_tokens: u32,
    pub predicted_per_second: f64,
    /// 投机解码接受率（llama.cpp 部分构建才会返回 draft 统计）
    #[serde(default)]
    pub draft_accept: Option<f64>,
    /// 端到端墙钟耗时
    pub total_ms: u64,
    /// 失败的记录也保留，前端照常展示原因
    #[serde(default)]
    pub error: Option<String>,
}

impl BenchRecord {
    fn failed(model: &str, total_ms: u64, error: String) -> Self {
        Self {
            ts_ms: now_ms(),
            model: model.to_string(),
            prompt_tokens: 0,
            prompt_per_second: 0.0,
            predicted_tokens: 0,
            predicted_per_second: 0.0,
            draft_accept: None,
            total_ms,
            error: Some(error),
        }
    }
}

/// 生成一段大致有 `tokens` 个 token 的填充文本。
///
/// 不引入 tokenizer：英文按约 4 字符 1 token 估算，服务端会在 `timings.prompt_n`
/// 里回报真实值，记录以真实值为准。
fn filler_prompt(tokens: u32) -> String {
    const SENTENCE: &str = "The quick brown fox jumps over the lazy dog while the curious cat watches silently. ";
    let target = (tokens.max(1) as usize).saturating_mul(4).max(16);
    let mut out = String::with_capacity(target + SENTENCE.len());
    // 长度写进首句，避免不同长度请求得到完全相同的缓存命中
    out.push_str(&format!("Token budget {}: ", tokens));
    while out.len() < target {
        out.push_str(SENTENCE);
    }
    out
}

/// 从响应 JSON 里取出 `timings` 并换算成记录。
fn record_from_response(model: &str, body: &str, total_ms: u64) -> BenchRecord {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(err) => return BenchRecord::failed(model, total_ms, format!("响应不是 JSON：{err}")),
    };
    let t = match parsed.get("timings") {
        Some(t) => t,
        None => {
            return BenchRecord::failed(model, total_ms, "响应里没有 timings 字段".into());
        }
    };
    let num = |key: &str| t.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);

    // 投机解码：不同构建的字段名不完全一致，取到才显示
    let draft_n = num("draft_n");
    let draft_accepted = num("draft_n_accepted");
    let draft_accept = if draft_n > 0.0 {
        Some(draft_accepted / draft_n)
    } else {
        None
    };

    BenchRecord {
        ts_ms: now_ms(),
        model: model.to_string(),
        prompt_tokens: num("prompt_n") as u32,
        prompt_per_second: num("prompt_per_second"),
        predicted_tokens: num("predicted_n") as u32,
        predicted_per_second: num("predicted_per_second"),
        draft_accept,
        total_ms,
        error: None,
    }
}

/// 跑一次压测请求（含计时）。
fn run_once(
    host: &str,
    port: u16,
    model: &str,
    prompt_tokens: u32,
    max_tokens: u32,
    api_key: Option<&str>,
) -> BenchRecord {
    let body = serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": filler_prompt(prompt_tokens) }],
        "max_tokens": max_tokens,
        "stream": false,
        "temperature": 0.0,
    })
    .to_string();

    let started = Instant::now();
    match crate::http::request(host, port, "POST", "/v1/chat/completions", Some(&body), api_key, REQUEST_TIMEOUT) {
        Ok(text) => record_from_response(model, &text, started.elapsed().as_millis() as u64),
        Err(err) => BenchRecord::failed(model, started.elapsed().as_millis() as u64, err),
    }
}

/// API 压测入口：先热身一次（必要时触发模型加载，不计入记录），再并发跑 `concurrency` 次。
#[tauri::command]
pub async fn bench_server(
    host: String,
    port: u16,
    api_key: Option<String>,
    model: String,
    prompt_tokens: u32,
    max_tokens: u32,
    concurrency: u32,
) -> Result<Vec<BenchRecord>, String> {
    let workers = concurrency.clamp(1, 64);
    tauri::async_runtime::spawn_blocking(move || {
        // 热身：router 会在首个请求时加载模型，这一步可能耗时几十秒
        let warm = run_once(&host, port, &model, 8, 1, api_key.as_deref());
        if let Some(err) = warm.error {
            return Err(format!("模型预热失败：{err}"));
        }

        let records = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..workers)
                .map(|_| {
                    let host = host.clone();
                    let model = model.clone();
                    let key = api_key.clone();
                    scope.spawn(move || {
                        run_once(&host, port, &model, prompt_tokens, max_tokens, key.as_deref())
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .collect::<Vec<_>>()
        });
        Ok(records)
    })
    .await
    .map_err(|e| format!("压测任务失败：{e}"))?
}

/// Strata 通道的压测入口。
///
/// 复用同一个 [`bench_server`]：Strata 的 `/v1/chat/completions` 返回与 llama.cpp
/// 兼容的 `timings` 字段（`cache_n / prompt_n / prompt_per_second / predicted_n /
/// predicted_per_second / draft_n / draft_n_accepted`），记录口径完全一致。
///
/// 端口、模型名、api key 一律从 config 读（解耦规则 R2：GUI 零硬编码）。
/// 密钥不下发给前端 —— `StrataModelEntry::api_key` 带 `skip_serializing`，
/// 所以压测必须由 Rust 侧发起。
#[tauri::command]
pub async fn bench_strata(
    root: String,
    config_file: String,
    prompt_tokens: u32,
    max_tokens: u32,
    concurrency: u32,
) -> Result<Vec<BenchRecord>, String> {
    // 压测只需要端口与密钥，引擎版本不参与；传 None 保持 config 原样（不改写 exe）
    let entry = crate::strata::scan_configs(std::path::Path::new(&root), None)
        .into_iter()
        .find(|e| {
            e.config_path
                .file_name()
                .map(|n| n.to_string_lossy() == config_file)
                .unwrap_or(false)
        })
        .ok_or_else(|| format!("找不到 config：{config_file}"))?;
    bench_server(
        crate::strata::loopback_host(&entry.host),
        entry.port,
        entry.api_key,
        entry.model_name,
        prompt_tokens,
        max_tokens,
        concurrency,
    )
    .await
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/// 把导出内容写到用户在保存对话框里选定的路径。
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<String, String> {
    if let Some(dir) = Path::new(&path).parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
        }
    }
    fs::write(&path, content).map_err(|e| format!("写入失败：{e}"))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// 硬件信息（记录里要显示「CPU / RAM / GPU」，与 hub 的记录字段对齐）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
pub struct Hardware {
    pub cpu: String,
    /// 物理内存（GB）
    pub ram_gb: Option<f64>,
}

/// 取 CPU 型号与物理内存（只取一次，压测记录里反复要用）。
#[tauri::command]
pub fn bench_hardware() -> Hardware {
    static CACHE: std::sync::OnceLock<Hardware> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| Hardware {
            cpu: cpu_name().unwrap_or_default(),
            ram_gb: total_ram_gb(),
        })
        .clone()
}

/// 处理器商品名。注册表里的 `ProcessorNameString` 才有「AMD Ryzen 9 8945HX」这类
/// 名称，环境变量 `PROCESSOR_IDENTIFIER` 只有「Intel64 Family 6 Model …」。
#[cfg(windows)]
fn cpu_name() -> Option<String> {
    let mut cmd = Command::new("reg");
    cmd.args([
        "query",
        r"HKLM\HARDWARE\DESCRIPTION\System\CentralProcessor\0",
        "/v",
        "ProcessorNameString",
    ]);
    crate::winfix::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.contains("ProcessorNameString"))
        .and_then(|l| l.split("REG_SZ").nth(1))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(not(windows))]
fn cpu_name() -> Option<String> {
    std::env::var("PROCESSOR_IDENTIFIER").ok()
}

/// 物理内存总量（GB）：直接调 kernel32，省一个依赖。
#[cfg(windows)]
fn total_ram_gb() -> Option<f64> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetPhysicallyInstalledSystemMemory(kilobytes: *mut u64) -> i32;
    }
    let mut kb: u64 = 0;
    // SAFETY: 传入本函数栈上的有效指针，接口只写这一个 u64
    let ok = unsafe { GetPhysicallyInstalledSystemMemory(&mut kb) };
    (ok != 0 && kb > 0).then(|| ((kb as f64 / 1024.0 / 1024.0) * 10.0).round() / 10.0)
}

#[cfg(not(windows))]
fn total_ram_gb() -> Option<f64> {
    None
}

// ---------------------------------------------------------------------------
// API 压测记录（落盘）
// ---------------------------------------------------------------------------

const RECORDS_CAP: usize = 200;

/// 记录文件是整份读改写：并发压测同时追加时，两个线程各自「读 → 合并 → 写」会互相覆盖。
static RECORDS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn records_path(bench_dir: &str) -> PathBuf {
    PathBuf::from(bench_dir).join("records.json")
}

fn read_records(path: &std::path::Path) -> Vec<BenchRecord> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<BenchRecord>>(&text).ok())
        .unwrap_or_default()
}

fn write_records(path: &std::path::Path, all: &[BenchRecord]) -> Result<(), String> {
    let text = serde_json::to_string(all).map_err(|e| format!("序列化失败：{e}"))?;
    // 先写 .tmp 再改名：写到一半崩溃不会把旧记录截断
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("写入失败：{e}"))?;
    Ok(())
}

/// 读取记录（最新的在前）。
#[tauri::command]
pub fn bench_records(bench_dir: String) -> Vec<BenchRecord> {
    read_records(&records_path(&bench_dir))
}

/// 追加一批记录（并发压测会一次来多条）。
#[tauri::command]
pub fn bench_records_add(bench_dir: String, items: Vec<BenchRecord>) -> Result<Vec<BenchRecord>, String> {
    let _guard = RECORDS_LOCK.lock().map_err(|_| "压测记录被占用".to_string())?;
    let dir = PathBuf::from(&bench_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    let path = records_path(&bench_dir);

    let mut all = read_records(&path);
    all.extend(items);
    if all.len() > RECORDS_CAP {
        all.drain(0..all.len() - RECORDS_CAP);
    }
    write_records(&path, &all)?;
    Ok(all)
}

/// 按时间戳删除一条记录。
#[tauri::command]
pub fn bench_records_delete(bench_dir: String, ts_ms: u64) -> Result<Vec<BenchRecord>, String> {
    let _guard = RECORDS_LOCK.lock().map_err(|_| "压测记录被占用".to_string())?;
    let path = records_path(&bench_dir);
    let mut all = read_records(&path);
    all.retain(|r| r.ts_ms != ts_ms);
    write_records(&path, &all)?;
    Ok(all)
}

/// 清空全部记录。
#[tauri::command]
pub fn bench_records_clear(bench_dir: String) -> Result<(), String> {
    let _guard = RECORDS_LOCK.lock().map_err(|_| "压测记录被占用".to_string())?;
    let _ = fs::remove_file(records_path(&bench_dir));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_parses_timings() {
        let body = r#"{"choices":[],"timings":{"prompt_n":18,"prompt_per_second":160.3,
            "predicted_n":64,"predicted_per_second":18.44}}"#;
        let rec = record_from_response("m", body, 1234);
        assert_eq!(rec.prompt_tokens, 18);
        assert_eq!(rec.predicted_tokens, 64);
        assert!((rec.predicted_per_second - 18.44).abs() < 1e-6);
        assert_eq!(rec.total_ms, 1234);
        assert!(rec.error.is_none());
    }

    #[test]
    fn record_reports_missing_timings() {
        let rec = record_from_response("m", r#"{"choices":[]}"#, 10);
        assert!(rec.error.unwrap().contains("timings"));
        let rec = record_from_response("m", "not json", 10);
        assert!(rec.error.unwrap().contains("JSON"));
    }

    #[test]
    fn draft_accept_only_when_present() {
        let body = r#"{"timings":{"prompt_n":1,"predicted_n":2,"draft_n":10,"draft_n_accepted":4}}"#;
        let rec = record_from_response("m", body, 1);
        assert_eq!(rec.draft_accept, Some(0.4));

        let body = r#"{"timings":{"prompt_n":1,"predicted_n":2}}"#;
        assert_eq!(record_from_response("m", body, 1).draft_accept, None);
    }

    #[test]
    fn filler_prompt_scales_with_tokens() {
        let small = filler_prompt(64).len();
        let big = filler_prompt(4096).len();
        assert!(big > small * 10, "填充长度应随 token 数增长：{small} -> {big}");
    }
}
