//! Strata `launch` 预设（`%APPDATA%\Strata\launch-presets\*.json`）。
//!
//! 官方有两条启动通道：
//! - 安装器：`install\strata-<tag>.json` + `run-<tag>.bat`（GUI 一直用这条）；
//! - `strata launch`：读 `launch-presets\<slug>.json` 的选择，用 `Runner.build_config`
//!   派生出 `launch\<slug>.json`（host / port / api_key / 卡 / context / kv / vision /
//!   extra env ... 都在这一层定），再起 serve。
//!
//! 用户要求 GUI 与 launch 行为一致（m02055）：启动前若这份模型有 launch 预设，就按它
//! 重新生成 `launch\<slug>.json`，用它的 `--config` 启动。生成逻辑不重写——直接调
//! 控制端的 `strata_cli.launch.runner`，与官方逐字节一致。

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::logs::LogHub;

/// 一份 launch 预设的摘要（列表与匹配用；真正的派生交给 python）。
#[derive(serde::Serialize, Clone)]
pub struct LaunchPreset {
    /// 文件名主体（slug），也是 `launch\<slug>.json` 的名字
    pub file: String,
    pub name: String,
    pub family: String,
    pub model: String,
    pub model_path: String,
    pub port: u16,
    pub context: Option<u64>,
    pub kv: Option<String>,
    pub vision: Option<String>,
    pub access: String,
    /// 上次用的日期（`last_used`）
    pub last_used: Option<String>,
}

/// 按预设生成出来的运行配置。
#[derive(serde::Serialize, Clone)]
pub struct LaunchSync {
    /// `launch\<slug>.json` 的绝对路径
    pub config: String,
    pub host: String,
    pub port: u16,
    /// 预设里的 key（`null` 表示不用 key）
    pub api_key: Option<String>,
    pub preset: String,
}

/// `%APPDATA%\Strata\launch-presets`（`store.preset_dir()` 同一处）。
pub fn presets_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|dir| PathBuf::from(dir).join("Strata").join("launch-presets"))
}

fn text(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|item| item.as_str()).map(|text| text.to_string())
}

fn number(value: &serde_json::Value, key: &str) -> Option<u64> {
    value
        .get(key)
        .and_then(|item| item.as_u64().or_else(|| item.as_str().and_then(|s| s.parse().ok())))
}

fn parse_preset(file: &Path) -> Option<LaunchPreset> {
    let raw = std::fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(LaunchPreset {
        file: file.file_stem()?.to_string_lossy().to_string(),
        name: text(&value, "name").unwrap_or_default(),
        family: text(&value, "family").unwrap_or_default(),
        model: text(&value, "model").unwrap_or_default(),
        model_path: text(&value, "model_path").unwrap_or_default(),
        port: number(&value, "port").unwrap_or(0) as u16,
        context: number(&value, "context"),
        kv: text(&value, "kv"),
        vision: text(&value, "vision"),
        access: text(&value, "access").unwrap_or_else(|| "local".into()),
        last_used: text(&value, "last_used"),
    })
}

/// 列出全部 launch 预设（按 `last_used` 倒序，没有的排后面）。
pub fn list() -> Vec<LaunchPreset> {
    let Some(dir) = presets_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut presets: Vec<LaunchPreset> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .filter_map(|path| parse_preset(&path))
        .collect();
    presets.sort_by(|a, b| b.last_used.cmp(&a.last_used).then_with(|| a.name.cmp(&b.name)));
    presets
}

fn same_folder(left: &str, right: &str) -> bool {
    fn norm(text: &str) -> String {
        text.replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    !left.is_empty() && norm(left) == norm(right)
}

/// 找服务这个模型目录的预设（`model_path` 相同；同一模型多个预设取最近用的那个）。
pub fn find_for(model_path: &str) -> Option<LaunchPreset> {
    list()
        .into_iter()
        .find(|preset| same_folder(&preset.model_path, model_path))
}

/// 用 launch 的 `Runner.build_config` 按预设生成 `launch\<slug>.json`，并把
/// `profiles\launch-<slug>.json`（host / port / parallel 覆盖）一起更新。
///
/// `base` 是安装器那份 config（`install\strata-<tag>.json`），派生以它为底。
pub fn sync(terminal: &Path, preset: &LaunchPreset, base: &Path) -> Result<LaunchSync, String> {
    const SCRIPT: &str = r#"
import json, sys
from pathlib import Path
terminal, preset, base = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
sys.path.insert(0, str(terminal))
try:
    from strata_cli.launch import store, runner as R, access as acc
    s = store.load(preset)
    r = R.Runner(s)
    out = r.build_config(base)
    try:
        r.ensure_profile(out)
    except Exception:
        pass
    print(json.dumps({"config": str(out), "host": acc.host_for(s.access),
                      "port": int(s.port), "api_key": s.api_key or "",
                      "preset": s.name or preset}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"error": type(exc).__name__ + ": " + str(exc)}, ensure_ascii=False))
"#;
    let python = terminal.join("python").join(if cfg!(windows) { "python.exe" } else { "python" });
    let mut cmd = Command::new(&python);
    cmd.arg("-c")
        .arg(SCRIPT)
        .arg(terminal)
        .arg(&preset.file)
        .arg(base)
        .current_dir(terminal)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::winfix::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|err| format!("生成 launch 配置失败（{}）：{err}", python.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&out.stderr);
            format!(
                "生成 launch 配置没有输出（退出码 {:?}）：{}{}",
                out.status.code(),
                stdout.trim(),
                stderr.trim()
            )
        })?;
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|err| format!("解析 launch 配置结果失败：{err}：{}", line.trim()))?;
    if let Some(error) = text(&value, "error") {
        return Err(error);
    }
    Ok(LaunchSync {
        config: text(&value, "config").ok_or_else(|| "生成结果里没有 config 路径".to_string())?,
        host: text(&value, "host").unwrap_or_else(|| "127.0.0.1".into()),
        port: number(&value, "port").unwrap_or(u64::from(preset.port)) as u16,
        api_key: text(&value, "api_key").filter(|key| !key.is_empty()),
        preset: text(&value, "preset").unwrap_or_else(|| preset.name.clone()),
    })
}

/// 启动前用一次：找到这份模型的 launch 预设并按它生成运行配置。
///
/// 失败只记日志、返回 `None`（缺 python / 预设文件坏了），启动继续走安装器那份 config。
pub fn sync_for_entry(
    hub: &LogHub,
    terminal: &Path,
    model_path: &str,
    base: &Path,
) -> Option<LaunchSync> {
    let preset = find_for(model_path)?;
    match sync(terminal, &preset, base) {
        Ok(sync) => {
            hub.push(
                "system",
                format!(
                    "[gui] 按 launch 预设『{}』生成了 {}（端口 {}），本次启动用它",
                    sync.preset, sync.config, sync.port
                ),
            );
            Some(sync)
        }
        Err(error) => {
            hub.push(
                "system",
                format!("[gui] launch 预设『{}』生成失败，改用安装器配置：{error}", preset.name),
            );
            None
        }
    }
}

/// 把 GUI 设置里的 API Key 写进**全部** launch 预设与已生成好的 launch 运行配置
/// （用户 m02313 / m02450：预设与 `launch\*.json` 里都要改到）。
///
/// 预设里的 `api_key` 就是 `build_config` 落进 `launch\<slug>.json` 的那把钥匙，所以不
/// 同步的话会出现「GUI 前门用 A、`strata launch` 用 B」；`launch\` 下已经生成过的配置也
/// 一起改，省得等下次启动重生成。排版照各自的写入方：预设 `indent=2 + sort_keys`、
/// launch 配置 `indent=1`（`runner.write_private`），其余字段与顺序原样保留。
///
/// `api_key` 传空表示清除：删掉 `api_key` 字段、`no_key` 回 false（不再有 key）。
pub fn sync_keys(terminal: &Path, api_key: &str) -> Result<usize, String> {
    const SCRIPT: &str = r#"
import glob, json, os, sys
key, presets, launch = sys.argv[1], sys.argv[2], sys.argv[3]
wanted = key or None
changed = 0


def write(path, doc, indent):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(doc, fh, indent=indent, ensure_ascii=False, sort_keys=(indent == 2))
        fh.write("\n")
    os.replace(tmp, path)


for path in sorted(glob.glob(os.path.join(presets, "*.json"))):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            doc = json.load(fh)
    except Exception:
        continue
    if not isinstance(doc, dict):
        continue
    if doc.get("api_key") == wanted and not doc.get("no_key"):
        continue
    if wanted is None:
        doc.pop("api_key", None)
    else:
        doc["api_key"] = wanted
    doc["no_key"] = False
    write(path, doc, 2)
    changed += 1

# launch\<slug>.json：只认真正的运行配置（有 args），跳过 .choices.json / .tune.json
for path in sorted(glob.glob(os.path.join(launch, "*.json"))):
    name = os.path.basename(path)
    if name.endswith(".choices.json") or name.endswith(".tune.json"):
        continue
    try:
        with open(path, encoding="utf-8-sig") as fh:
            doc = json.load(fh)
    except Exception:
        continue
    if not isinstance(doc, dict) or "args" not in doc:
        continue
    if doc.get("api_key") == wanted:
        continue
    if wanted is None:
        doc.pop("api_key", None)
    else:
        doc["api_key"] = wanted
    write(path, doc, 1)
    changed += 1
print(changed)
"#;
    let Some(dir) = presets_dir() else {
        return Ok(0);
    };
    let launch = match crate::strata::root() {
        Some(root) => root.join("launch"),
        None => return Ok(0),
    };
    let python = terminal.join("python").join(if cfg!(windows) { "python.exe" } else { "python" });
    let mut cmd = Command::new(&python);
    cmd.arg("-c")
        .arg(SCRIPT)
        .arg(api_key)
        .arg(&dir)
        .arg(&launch)
        .current_dir(terminal)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::winfix::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|err| format!("写入 launch 预设失败（{}）：{err}", python.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let count = stdout
        .lines()
        .rev()
        .find_map(|line| line.trim().parse::<usize>().ok())
        .ok_or_else(|| {
            format!(
                "写入 launch 预设没有输出（退出码 {:?}）：{}{}",
                out.status.code(),
                stdout.trim(),
                stderr.trim()
            )
        })?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_folder_ignores_slashes_and_case() {
        assert!(same_folder(r"E:\AI\Strata-data\models\sc117_swift-IQ2_XS", r"e:/ai/strata-data/models/sc117_swift-iq2_xs/"));
        assert!(!same_folder(r"E:\AI\Strata-data\models\a", r"E:\AI\Strata-data\models\b"));
        assert!(!same_folder("", ""));
    }

    #[test]
    fn parses_a_preset_file() {
        let dir = std::env::temp_dir().join(format!("llamacpp-launch-{}", crate::logs::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("iq3_xxs-256k.json");
        std::fs::write(
            &file,
            r#"{"schema":"strata.launch/1","name":"IQ3_XXS 256K","family":"swift","model":"IQ3_XXS",
                "model_path":"E:\\AI\\Strata-data\\models\\swift-IQ3_XXS","port":9091,"context":262144,
                "kv":"int8","vision":"cpu","access":"local","last_used":"2026-10-24 21:46:47"}"#,
        )
        .unwrap();
        let preset = parse_preset(&file).expect("应该能解析");
        assert_eq!(preset.file, "iq3_xxs-256k");
        assert_eq!(preset.port, 9091);
        assert_eq!(preset.context, Some(262144));
        assert_eq!(preset.kv.as_deref(), Some("int8"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
