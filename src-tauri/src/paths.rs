//! 配置目录解析：便携绿色版把数据放在 **exe 同目录**，装到不可写位置时回退系统目录。
//!
//! 为什么是 exe 目录而不是 cwd：双击、快捷方式（可能带起始位置）、从别处 `start` 调用，
//! cwd 都可能不同；只有 exe 自己的位置是稳定的。
//!
//! dev 构建（`tauri dev` / `cargo test`）**始终**用系统配置目录 —— 那时 exe 在
//! `target/debug`，把真实配置放进去既没意义，又容易让人以为配置丢了。
//!
//! 安装版（NSIS 装到 `%LOCALAPPDATA%\Programs\...`）同样走便携：数据就在安装目录里，
//! 卸载时由安装包（`nsis/hooks.nsh`）问一句"是否同时删除用户数据" ——
//! Tauri 的卸载脚本本来只删它自己装的文件，所以选"否"数据会原样留着，重装即恢复。
//!
//! 旧版本把数据放在 `%APPDATA%\dev.llamacpp.gui`（webview 数据在 `%LOCALAPPDATA%\`
//! 的同名目录）。**从旧版升级不再自动搬运**：便携目录里没有配置就按全新安装处理 ——
//! llama.cpp 目录、模型目录、preset 都要重设一遍。

use std::fs;
use std::path::{Path, PathBuf};

/// exe 所在目录（便携目录的候选）。
pub fn exe_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.to_path_buf())
}

/// 目录是否可写：写一个探针文件再删掉。
///
/// 装在 `C:\Program Files` 这类位置时这里会失败，于是回退系统配置目录，
/// 行为与旧版一致（不会因为"绿色版"而启动不起来）。
fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".llamacpp-gui-write-probe-{}", std::process::id()));
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 这个目录看起来已经是配置目录（上一次就是便携模式跑的）。
///
/// 命中时跳过写探测：省掉每次启动的一次建/删文件。
pub fn looks_like_config_dir(dir: &Path) -> bool {
    dir.join("settings.json").is_file() || dir.join("presets").is_dir()
}

/// 解析配置目录，返回 `(目录, 是否便携)`。
pub fn resolve_config_dir(fallback: &Path) -> (PathBuf, bool) {
    resolve_with(!cfg!(debug_assertions), fallback)
}

/// `resolve_config_dir` 的可测内核：`portable_allowed` 对应"非 dev 构建"。
fn resolve_with(portable_allowed: bool, fallback: &Path) -> (PathBuf, bool) {
    if !portable_allowed {
        return (fallback.to_path_buf(), false);
    }
    let Some(dir) = exe_dir() else {
        return (fallback.to_path_buf(), false);
    };
    // 已经在那儿放着配置（上次就是便携跑的）就继续用，免得配置"突然找不到"；
    // 否则要求目录可写
    if looks_like_config_dir(&dir) || writable(&dir) {
        (dir, true)
    } else {
        (fallback.to_path_buf(), false)
    }
}

/// 便携模式下 webview 数据目录：`<便携目录>/webview`。
///
/// 不直接摊在便携目录根上，是为了让 `EBWebView`（WebView2 自己建的子目录，一千多个文件）
/// 跟 settings / presets 这些配置分开 —— 用户一眼能看出哪个是能删的缓存。
pub fn webview_dir(portable_root: &Path) -> PathBuf {
    portable_root.join("webview")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("llamacpp-gui-paths-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn dev_always_uses_fallback() {
        let fallback = PathBuf::from("C:/fallback/config");
        let (dir, portable) = resolve_with(false, &fallback);
        assert_eq!(dir, fallback);
        assert!(!portable);
    }

    #[test]
    fn release_prefers_exe_dir() {
        // 测试二进制所在目录一定可写，等价于"绿色版放在可写目录"
        let fallback = PathBuf::from("C:/fallback/config");
        let (dir, portable) = resolve_with(true, &fallback);
        assert!(portable);
        assert_eq!(dir, exe_dir().unwrap());
    }

    #[test]
    fn existing_config_marks_portable_dir() {
        let dir = temp("looks-like");
        fs::write(dir.join("settings.json"), b"{}").unwrap();
        assert!(looks_like_config_dir(&dir));
        let dir2 = temp("looks-like-presets");
        fs::create_dir_all(dir2.join("presets")).unwrap();
        assert!(looks_like_config_dir(&dir2));
        let dir3 = temp("looks-like-empty");
        assert!(!looks_like_config_dir(&dir3));
    }

    #[test]
    fn webview_dir_sits_under_portable_root() {
        assert_eq!(
            webview_dir(Path::new("E:/app")),
            PathBuf::from("E:/app").join("webview")
        );
    }
}
