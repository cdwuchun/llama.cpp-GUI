//! Strata 的 DFlash2 草稿器（`strata.py drafting plan|fetch`）与显存弹性归还（`POST /v1/vram`）。
//!
//! 上游 0.2.13 起，config 顶层 `drafting: "dflash2"` 的模型在启动时要求草稿器文件
//! （`qwen3.8-flash-next-dflash2.strata1.*.pack`，约 0.34 GB）。控制端把「这台机器该不该下、
//! 下多大、下到哪」全封装在 `strata drafting` 里（`strata_cli/drafting_cmd.py`），
//! GUI 只调它、不自己拼下载地址，也不自己算 sha256：
//!
//! - `plan --config <cfg> --output json`：一行 JSON；`needed` 表示当前选择真的要下。
//!   其它字段（`gb` / `serves` / `support` / `choice` / `note` / `line`）都是给界面直接显示的。
//! - `fetch --config <cfg> --if-needed --output jsonl`：不需要时控制端直接回
//!   `{"event":"result","skipped":true}`；需要时先吐若干 progress 行，最后一行
//!   `{"event":"result","pack":"<路径>"}`。下载是阻塞的（几百 MB），给 1 小时。
//!
//! 「归还显存」是引擎端点（`serve/server.py` 的 `POST /v1/vram`，上游 #533）：只在 config 顶层
//! `vram_elastic: true` 的 NVIDIA 构建上有效，引擎把专家缓存的空闲分段还给别的程序。
//! 它不卸载模型，也不停引擎。

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{Context, Result};

/// 控制端目录 + python + strata.py（与 `strata.rs::run_components` 同一套定位）。
fn locate() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf)> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .context("未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）")?;
    let terminal = crate::strata_tune::terminal_dir(&root).context(
        "未找到 Strata 控制端（<根>\\control\\<版本> 或 <根>\\terminal\\<版本>，缺 python\\python.exe）",
    )?;
    let python = terminal
        .join("python")
        .join(crate::strata_tune::python_name());
    let script = terminal.join("strata.py");
    if !script.is_file() {
        anyhow::bail!("控制端缺少 strata.py：{}", script.display());
    }
    Ok((root, terminal, python, script))
}

fn run(config_file: &str, fetch: bool) -> Result<serde_json::Value> {
    let (root, terminal, python, script) = locate()?;
    // 前端只传 config 的文件名：必须按文件名回安装目录里找，相对路径会落在 GUI 进程的 cwd 上
    let config = crate::strata::config_entry(&root, config_file)
        .map_err(anyhow::Error::msg)?
        .config_path;
    let action = if fetch { "fetch" } else { "plan" };
    let mut cmd = Command::new(&python);
    cmd.arg(&script)
        .arg("drafting")
        .arg(action)
        .arg("--config")
        .arg(config)
        .arg("--output")
        .arg(if fetch { "jsonl" } else { "json" })
        .current_dir(&terminal)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if fetch {
        cmd.arg("--if-needed");
    }
    crate::winfix::hide_console(&mut cmd);
    // plan 只读磁盘（几秒）；fetch 要下 0.34 GB，给足时间
    let timeout = Duration::from_secs(if fetch { 3600 } else { 120 });
    let Some(out) = crate::winfix::output_with_timeout(&mut cmd, timeout) else {
        anyhow::bail!(
            "strata drafting {action} 超过 {} 秒没有结果，已放弃",
            timeout.as_secs()
        );
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // 控制端会先打几行人读日志；JSON 是最后一行以 `{` 开头的输出。
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .with_context(|| {
            format!(
                "strata drafting {action} 没有输出 JSON（退出码 {:?}）：{}",
                out.status.code(),
                stderr.trim()
            )
        })?;
    let value: serde_json::Value =
        serde_json::from_str(line.trim()).context("解析 strata drafting 输出失败")?;
    if value.get("ok").and_then(|item| item.as_bool()) == Some(false) {
        // 控制端的失败原因在 `error.message`（`{"code":"drafting_failed","message":…}`）
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|item| item.as_str())
            .or_else(|| value.get("error").and_then(|item| item.as_str()))
            .or_else(|| value.get("notice").and_then(|item| item.as_str()))
            .unwrap_or("控制端拒绝了这次操作");
        anyhow::bail!("{}", message);
    }
    Ok(value)
}

/// `strata drafting plan` 的原始报告：会不会下、下多大、这台机器跑不跑得动。
#[tauri::command]
pub async fn strata_drafting_plan(config_file: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(&config_file, false).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("草稿器检查失败：{e}"))?
}

/// `strata drafting fetch --if-needed`：需要才下载（已就绪时控制端直接回 skipped）。
#[tauri::command]
pub async fn strata_drafting_fetch(config_file: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || run(&config_file, true).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("草稿器下载失败：{e}"))?
}

/// 让运行中的 Strata 把专家缓存的空闲显存还给别的程序（`POST /v1/vram`，上游 #533）。
/// 只在 config 顶层 `vram_elastic: true` 的 NVIDIA 引擎上有意义；上游回 `VRAM <MiB>` 说明还了多少。
#[tauri::command]
pub async fn strata_release_vram(config_file: String) -> Result<String, String> {
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let (host, port, api_key) = crate::strata::service_target(&root, &config_file)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::http::request(
            &host,
            port,
            "POST",
            "/v1/vram",
            Some("{}"),
            api_key.as_deref(),
            std::time::Duration::from_secs(120),
        )
    })
    .await
    .map_err(|e| format!("归还显存失败：{e}"))?
}
