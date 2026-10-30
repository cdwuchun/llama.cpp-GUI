//! GPU 设备枚举、校验，以及 GPU 相关命令行参数的组装。
//!
//! 关键实测结论（见方案 §4.5）：
//! - `--device` 在 **router 参数解析阶段就强校验**，无效设备名会让 router 直接启动失败；
//! - 设备名大小写不敏感（`cuda0` 可用）；
//! - `--n-gpu-layers` / `--tensor-split` 一旦显式设置，`--fit` 会放弃对应的自动分配。

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::versions::{compose_path_env, LlamaCppVersion};

/// 一个可用的推理设备。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DeviceInfo {
    /// 规范设备名，如 `CUDA0`。
    pub name: String,
    /// 设备描述，如 `NVIDIA GeForce RTX 5070 Ti Laptop GPU`。
    pub description: String,
    pub total_mib: Option<u64>,
    pub free_mib: Option<u64>,
}

/// `llama-fit-params -fitp on` 的单行结果：设备 / 模型 / 上下文 / 计算（MiB）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FitRow {
    pub device: String,
    pub model_mib: u64,
    pub context_mib: u64,
    pub compute_mib: u64,
}

/// 解析 `--list-devices` 输出：
///
/// ```text
/// Available devices:
///   CUDA0: NVIDIA GeForce RTX 5070 Ti Laptop GPU (12226 MiB, 11042 MiB free)
/// ```
///
/// 无可用设备时输出为 `(none)`，返回空列表。
pub fn parse_devices(output: &str) -> Vec<DeviceInfo> {
    let mut devices = Vec::new();
    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line.starts_with("Available devices")
            || line.starts_with('(')
            || line.starts_with("ggml_")
            || line.starts_with("load_backend")
        {
            continue;
        }
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        // 设备名形如 CUDA0 / Vulkan0 / RPC0 —— 不含空格
        if name.is_empty() || name.contains(char::is_whitespace) {
            continue;
        }

        // 用**最后一个**左括号配最后一个右括号：设备描述里本身可能带括号
        // （AMD 的 "Radeon(TM) Graphics"），取第一个会把描述截断、规格区间错位
        let spec_open = rest.rfind('(');
        let desc = match spec_open {
            Some(idx) => rest[..idx].trim().to_string(),
            None => rest.trim().to_string(),
        };

        let (mut total_mib, mut free_mib) = (None, None);
        if let (Some(l), Some(r)) = (spec_open, rest.rfind(')')) {
            if l < r {
                for part in rest[l + 1..r].split(',') {
                    let part = part.trim();
                    let num = part
                        .split_whitespace()
                        .next()
                        .and_then(|n| n.replace(',', "").parse::<u64>().ok());
                    if part.contains("free") {
                        free_mib = num;
                    } else if part.contains("MiB") {
                        total_mib = num;
                    }
                }
            }
        }

        devices.push(DeviceInfo {
            name: name.to_string(),
            description: desc,
            total_mib,
            free_mib,
        });
    }
    devices
}

/// 枚举可用设备（需要 CUDA 运行时在 PATH 上，否则只会返回空列表）。
pub fn list_devices(version: &LlamaCppVersion) -> Result<Vec<DeviceInfo>> {
    let mut cmd = Command::new(&version.server_bin);
    cmd.arg("--list-devices");
    cmd.current_dir(&version.dir);
    cmd.env("PATH", compose_path_env(version, std::env::var_os("PATH")));
    crate::winfix::hide_console(&mut cmd);
    // 外部 exe 必须带超时：被杀软拦 / 缺 DLL 时会一直等（审查发现）
    let Some(out) = crate::winfix::output_with_timeout(&mut cmd, std::time::Duration::from_secs(30))
    else {
        anyhow::bail!(
            "--list-devices 超过 30 秒没有结果，已放弃（检查共享 CUDA 运行时是否被杀软拦住）"
        );
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string()
        + &String::from_utf8_lossy(&out.stderr);
    // 命令失败时（缺 DLL、被拦截）不要拿错误文本去解析成"没有设备"：
    // 那会让界面显示「无可用设备」，而真正的原因（运行时缺失）被吃掉
    if !out.status.success() {
        let tail: String = text.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
        anyhow::bail!(
            "--list-devices 失败（退出码 {:?}）：{}",
            out.status.code(),
            if tail.is_empty() { "无输出".into() } else { tail }
        );
    }
    Ok(parse_devices(&text))
}

/// 透传给 `llama-fit-params` 的**带值**选项白名单。
///
/// 只放「会改变显存预估」且 fit-params 确实认得的键；其余一律丢掉 —— 实测它遇到
/// 不认识的参数会直接 `error: invalid argument: --xxx` 退出。
/// 注意 `mmproj` / `spec-draft-model` **不在**这里：fit-params 不支持它们
/// （多模态投影与草稿模型的占用算不进来，界面上另行提示）。
/// 名单是用 llama-fit-params --help 的**选项定义行**与 src/assets/params.json 的键求交集得来的，
/// 不是凭印象写的；加键之前请先确认它出现在 help 的选项行里，否则整条命令会直接失败。
const FIT_VALUE_ARGS: &[&str] = &[
    // 上下文与批处理：直接决定 KV cache 与计算缓冲
    "ctx-size",
    "batch-size",
    "ubatch-size",
    // 并行槽位数：KV cache 按槽位分配，实测 --parallel 4 会把上下文占用抬上去
    "parallel",
    // KV cache 量化（含草稿模型的，键名与参数表一致）
    "cache-type-k",
    "cache-type-v",
    "spec-draft-type-k",
    "spec-draft-type-v",
    // 卸载与切分
    "gpu-layers",
    "n-gpu-layers",
    "tensor-split",
    "main-gpu",
    "split-mode",
    "device",
    // 往 CPU 卸载（这几项实测都会改变预估）
    "n-cpu-moe",
    "n-cpu-ffn",
    "override-tensor",
    "flash-attn",
    "load-mode",
    // 按需读取某些张量（例如 per-layer embedding）：会压低峰值显存
    "lazy-mode",
    "fit",
    "fit-target",
    "fit-ctx",
];

/// 透传的**布尔**（开关）选项：不带值，拼成 --xxx 即可（help 里写成不带 N/TYPE 的那些）。
const FIT_FLAG_ARGS: &[&str] = &[
    "no-kv-offload",
    "kv-offload",
    "cpu-moe",
    "swa-full",
    "op-offload",
    "no-op-offload",
    "no-host",
];

/// 其中 help 里**成对出现**的开关（--xxx 与 --no-xxx 都列了）：为假时可以取反表达。
/// 不能取反的（cpu-moe / swa-full）实测传 --no-xxx 会直接 invalid argument，所以只为假时什么都不传。
const FIT_NEGATABLE_FLAGS: &[&str] = &["kv-offload", "op-offload"];

fn truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

fn falsey(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "0" | "false" | "off" | "no"
    )
}

/// preset 的键值对 → `llama-fit-params` 的参数（纯函数，便于测试）。
///
/// 空值表示「这个键没启用」（preset 用空值表示删除），一律跳过。
pub fn build_fit_args(params: &[(String, String)]) -> Vec<String> {
    let mut out = Vec::new();
    for (key, value) in params {
        let key = key.as_str();
        let value = value.trim();
        // 空值 = 这个键没启用（preset 用空值表示删除），一律不传
        if value.is_empty() {
            continue;
        }
        if FIT_FLAG_ARGS.contains(&key) {
            if truthy(value) {
                out.push(format!("--{key}"));
            } else if falsey(value) && FIT_NEGATABLE_FLAGS.contains(&key) {
                // 只有成对定义过的开关才能取反（kv-offload = false → --no-kv-offload）。
                // cpu-moe / swa-full 没有 --no- 形式，实测传了直接 invalid argument，
                // 为假时什么都不传即可。
                out.push(format!("--no-{key}"));
            }
            continue;
        }
        if FIT_VALUE_ARGS.contains(&key) {
            out.push(format!("--{key}"));
            out.push(value.to_string());
        }
    }
    out
}

/// 运行 `llama-fit-params --model <gguf> <参数…> -fitp on` 得到逐设备显存预估。
///
/// `params` 是当前配置面板里的那套键值对：显存占用与上下文长度、KV cache 量化、
/// ubatch、卸载层数、MoE 溢出等强相关，不把它们带上，算出来的数字没有意义。
pub fn fit_preview(
    version: &LlamaCppVersion,
    model_path: &Path,
    params: &[(String, String)],
) -> Result<Vec<FitRow>> {
    let bin = version
        .fit_params_bin
        .clone()
        .unwrap_or_else(|| version.dir.join(if cfg!(windows) { "llama-fit-params.exe" } else { "llama-fit-params" }));

    let mut cmd = Command::new(bin);
    cmd.arg("--model").arg(model_path);
    cmd.args(build_fit_args(params));
    cmd.arg("-fitp").arg("on");
    cmd.current_dir(&version.dir);
    cmd.env("PATH", compose_path_env(version, std::env::var_os("PATH")));
    crate::winfix::hide_console(&mut cmd);

    // 大模型的分解要算一会儿，但也不能无限等（审查发现）
    let Some(out) = crate::winfix::output_with_timeout(&mut cmd, std::time::Duration::from_secs(120))
    else {
        anyhow::bail!("llama-fit-params 超过 120 秒没有结果，已放弃");
    };
    let text = String::from_utf8_lossy(&out.stdout).to_string()
        + &String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let tail: String = text.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
        anyhow::bail!(
            "llama-fit-params 失败（退出码 {:?}）：{}",
            out.status.code(),
            if tail.is_empty() { "无输出".into() } else { tail }
        );
    }
    Ok(parse_fit_preview(&text))
}

/// 解析 `-fitp on` 输出：`<设备> <模型MiB> <上下文MiB> <计算MiB>`。
pub fn parse_fit_preview(output: &str) -> Vec<FitRow> {
    let mut rows = Vec::new();
    for raw in output.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 4 {
            continue;
        }
        let nums: Option<Vec<u64>> = cols[1..4].iter().map(|c| c.parse::<u64>().ok()).collect();
        let Some(nums) = nums else { continue };
        // 排除日志行（设备名不会是纯数字，且首列通常是大写字母开头）
        let device = cols[0];
        if device.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        rows.push(FitRow {
            device: device.to_string(),
            model_mib: nums[0],
            context_mib: nums[1],
            compute_mib: nums[2],
        });
    }
    rows
}

/// 便捷：推断设备是否可用（用于 UI 的「CUDA 运行时是否就绪」提示）。
pub fn cuda_ready(devices: &[DeviceInfo]) -> bool {
    devices
        .iter()
        .any(|d| d.name.to_ascii_uppercase().starts_with("CUDA"))
}

#[allow(dead_code)]
fn _silence_unused(_p: PathBuf) {}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 5070 Ti Laptop GPU, compute capability 12.0, VMM: yes\nAvailable devices:\n  CUDA0: NVIDIA GeForce RTX 5070 Ti Laptop GPU (12226 MiB, 11042 MiB free)\n";

    #[test]
    fn parse_real_sample() {
        let devices = parse_devices(SAMPLE);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].name, "CUDA0");
        assert_eq!(devices[0].total_mib, Some(12226));
        assert_eq!(devices[0].free_mib, Some(11042));
        assert!(devices[0].description.contains("RTX 5070 Ti"));
        assert!(cuda_ready(&devices));
    }

    #[test]
    fn parse_none_sample() {
        let devices = parse_devices("Available devices:\n  (none)\n");
        assert!(devices.is_empty());
        assert!(!cuda_ready(&devices));
    }

    /// 只有白名单里的键能进命令行；布尔键按 flag 处理；空值与未知键丢掉。
    #[test]
    fn fit_args_only_pass_whitelisted_memory_options() {
        let params: Vec<(String, String)> = [
            ("ctx-size", "65536"),
            ("parallel", "1"),
            ("cache-type-k", "q8_0"),
            ("ubatch-size", "2048"),
            ("no-kv-offload", "true"),
            ("kv-offload", "false"),               // 布尔取反：应变成 --no-kv-offload
            ("cpu-moe", "false"),                  // 没有 --no-cpu-moe 这种形式：为假就什么都不传
            ("n-cpu-ffn", "4"),                    // 往 CPU 卸载 dense FFN：能传
            ("spec-draft-type-k", "q8_0"),         // 草稿模型的 KV 类型：能传
            ("temp", "0.8"),                       // 采样参数：与显存无关，丢掉
            ("mmproj", "E:/m/mmproj.gguf"),        // fit-params 不支持，丢掉
            ("spec-draft-model", "E:/m/draft.gguf"), // 同上
            ("device", ""),                        // 空值 = 未启用，丢掉
            ("n-gpu-layers", "10"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

        let args = build_fit_args(&params);
        assert_eq!(
            args,
            vec![
                "--ctx-size",
                "65536",
                "--parallel",
                "1",
                "--cache-type-k",
                "q8_0",
                "--ubatch-size",
                "2048",
                "--no-kv-offload", // no-kv-offload = true
                "--no-kv-offload", // kv-offload = false → 取反
                "--n-cpu-ffn",     // 直接透传
                "4",
                "--spec-draft-type-k",
                "q8_0",
                "--n-gpu-layers",
                "10",
            ]
        );
    }

    #[test]
    fn parse_fit_preview_rows() {
        let sample = "0.00.098.047 I llama_fit_params: printing estimated memory in MiB to stdout (device, model, context, compute) ...\nCUDA0 2279 5376 259 \nHost 270 0 136\n";
        let rows = parse_fit_preview(sample);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].device, "CUDA0");
        assert_eq!(rows[0].context_mib, 5376);
        assert_eq!(rows[1].device, "Host");
    }
}
