//! llama.cpp 版本发现，以及共享 CUDA 运行时目录的匹配。
//!
//! 关键实测结论（见方案 §4.6）：
//! - llama.cpp 的 Windows 发行包**不含** CUDA 运行时，需要另外的 `cudart-llama-bin-win-cuda-<X.Y>-x64` 包；
//! - Windows 的 DLL 搜索**不递归**：必须把「直接包含 `cudart64_*` 的目录」注入 `PATH`，注入父目录无效。

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::settings::VersionProbe;

/// llama.cpp 版本目录中的一个可用版本。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LlamaCppVersion {
    /// 版本标识（一般为目录名）。
    pub name: String,
    pub dir: PathBuf,
    pub server_bin: PathBuf,
    pub fit_params_bin: Option<PathBuf>,
    /// `None` = 尚未探测；`false` = 该版本不支持 router mode。
    pub has_router_mode: Option<bool>,
    /// 匹配到的共享 CUDA 运行时目录（直接包含 DLL 的那些目录）。
    pub shared_lib_dirs: Vec<PathBuf>,
    /// 路径是否纯 ASCII —— router 在非 ASCII 路径下无法 spawn 子实例（实测）。
    pub ascii_safe: bool,
}

fn exe(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// 判断路径是否纯 ASCII（llama.cpp 以 ANSI 语义传递自身路径，非 ASCII 会导致子实例 spawn 失败）。
pub fn is_ascii_path(path: &Path) -> bool {
    path.to_string_lossy().is_ascii()
}

/// 从版本目录名中提取 CUDA 版本标签，例如
/// `llama-b10831-bin-win-cuda-13.3-x64` → `cuda-13.3`。
pub fn cuda_tag(dir_name: &str) -> Option<String> {
    let idx = dir_name.find("cuda-")?;
    let rest = &dir_name[idx + "cuda-".len()..];
    let mut digits = String::new();
    for ch in rest.chars() {
        if ch.is_ascii_digit() || (ch == '.' && !digits.is_empty() && !digits.ends_with('.')) {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() || digits.ends_with('.') {
        return None;
    }
    Some(format!("cuda-{digits}"))
}

/// 目录是否直接包含 CUDA 运行时 DLL（cudart / cublas / cublasLt）。
pub fn dir_has_cuda_runtime(dir: &Path) -> bool {
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with("cudart64_") || name.starts_with("cublas64_") || name.starts_with("cublaslt64_") {
            return true;
        }
    }
    false
}

/// 匹配该版本可用的共享 CUDA 运行时目录。
///
/// 优先级：
/// 1. 用户显式配置的 `shared_lib_dirs`；
/// 2. 与版本目录名中 `cuda-<X.Y>` 标签一致、且直接含 DLL 的同级目录；
/// 3. 同级目录下任何直接含 DLL 的 `cudart-*` 目录（兜底）。
pub fn find_shared_cuda_dirs(
    version_dir: &Path,
    explicit: &[PathBuf],
    llama_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let push_unique = |dir: PathBuf, found: &mut Vec<PathBuf>| {
        if dir_has_cuda_runtime(&dir) && !found.contains(&dir) {
            found.push(dir);
        }
    };

    // 1) 显式配置
    for dir in explicit {
        push_unique(dir.clone(), &mut found);
    }

    let tag = version_dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(cuda_tag);

    // 收集候选父目录：版本目录的父级 + 用户指定的 llama.cpp 根目录
    let mut parents: Vec<PathBuf> = Vec::new();
    if let Some(parent) = version_dir.parent() {
        parents.push(parent.to_path_buf());
    }
    if let Some(root) = llama_root {
        if !parents.contains(&root.to_path_buf()) {
            parents.push(root.to_path_buf());
        }
    }

    // 2) 标签精确匹配
    if let Some(tag) = &tag {
        for parent in &parents {
            let Ok(entries) = fs::read_dir(parent) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.contains(tag.as_str()) {
                    push_unique(path, &mut found);
                }
            }
        }
    }

    // 3) 兜底：同级任何含 CUDA 运行时的目录
    if found.is_empty() {
        for parent in &parents {
            let Ok(entries) = fs::read_dir(parent) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                if name.starts_with("cudart") {
                    push_unique(path, &mut found);
                }
            }
        }
    }

    found
}

/// 构造子进程的 `PATH`：共享 CUDA 目录在最前（DLL 搜索必须命中它们），随后是版本目录，最后是原有 PATH。
pub fn compose_path_env(
    version: &LlamaCppVersion,
    base_path: Option<OsString>,
) -> OsString {
    let mut parts: Vec<OsString> = Vec::new();
    for dir in &version.shared_lib_dirs {
        parts.push(dir.clone().into_os_string());
    }
    parts.push(version.dir.clone().into_os_string());
    if let Some(base) = base_path {
        parts.push(base);
    }
    std::env::join_paths(parts).unwrap_or_else(|_| OsString::new())
}

/// 运行 `llama-server --help` 判断该版本是否支持 router mode（`--models-dir`）。
///
/// `--help` 冷启动约 1.5s / 热约 150ms，调用方必须缓存结果。
/// 返回 `None` 表示**探测本身失败**（缺 DLL、被杀软拦截、权限问题…）—— 这种情况
/// 绝不能当成"不支持 router mode"缓存起来，否则用户会被永久误导去升级 llama.cpp。
pub fn probe_router_mode(server_bin: &Path, shared_lib_dirs: &[PathBuf]) -> Option<bool> {
    let mut cmd = Command::new(server_bin);
    cmd.arg("--help");
    // 探测同样需要 CUDA 运行时在 PATH 上，否则后端加载告警会污染输出
    let mut dirs: Vec<PathBuf> = shared_lib_dirs.to_vec();
    if let Some(parent) = server_bin.parent() {
        dirs.push(parent.to_path_buf());
    }
    let base = std::env::var_os("PATH");
    let os_parts: Vec<OsString> = dirs.iter().map(|d| d.clone().into_os_string()).collect();
    let joined = if let Some(base) = base {
        let mut all = os_parts;
        all.push(base);
        std::env::join_paths(all)
    } else {
        std::env::join_paths(os_parts)
    };
    match joined {
        Ok(path) => {
            cmd.env("PATH", path);
        }
        Err(err) => {
            // join_paths 只在某条路径含分隔符时失败；不能因此把子进程 PATH 置空
            // （那会连带影响它加载运行库），回退到原 PATH 并留个记录
            eprintln!("[versions] 组装 PATH 失败（{err}），改用原 PATH");
            if let Some(base) = std::env::var_os("PATH") {
                cmd.env("PATH", base);
            }
        }
    }
    if let Some(parent) = server_bin.parent() {
        cmd.current_dir(parent);
    }
    // 不加这个的话，每次冷启动探测都会在屏幕上闪一个黑窗
    crate::winfix::hide_console(&mut cmd);

    match cmd.output() {
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout).to_string()
                + &String::from_utf8_lossy(&out.stderr);
            let has_help = text.contains("--help") || text.contains("usage:");
            if !has_help {
                // 拿不到像样的 --help 输出（多半是启动就失败了），这次不算数
                eprintln!(
                    "[versions] {} --help 输出异常，本次不缓存探测结果",
                    server_bin.display()
                );
                return None;
            }
            Some(text.contains("--models-dir"))
        }
        Err(err) => {
            eprintln!("[versions] 执行 {} --help 失败: {err}", server_bin.display());
            None
        }
    }
}

/// 能力探测结果的保鲜期：过期就重探。
///
/// 需要 TTL 的原因：探测可能在环境不完整时失败过（共享 CUDA 目录还没配好、被杀软拦了），
/// 若把当时的结论永久固化，用户之后怎么修都不会重新判定。
const PROBE_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// 从缓存里取探测结果（过期的当作没有）。
fn cached_probe(name: &str, cache: &HashMap<String, VersionProbe>) -> Option<bool> {
    let probe = cache.get(name)?;
    let age = crate::logs::now_ms().saturating_sub(probe.probed_at_ms);
    (age < PROBE_TTL_MS).then_some(probe.has_router_mode)
}

/// 按名字里的数字段比较版本（b10831 > b10809 > b9999）。
fn compare_version_names(a: &str, b: &str) -> std::cmp::Ordering {
    fn digits(s: &str) -> Vec<u64> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse::<u64>().ok())
            .collect()
    }
    let (da, db) = (digits(a), digits(b));
    if !da.is_empty() && !db.is_empty() {
        for (x, y) in da.iter().zip(db.iter()) {
            match x.cmp(y) {
                std::cmp::Ordering::Equal => continue,
                other => return other,
            }
        }
        return da.len().cmp(&db.len());
    }
    a.cmp(b)
}
/// 扫描 llama.cpp 安装目录，识别其中的版本。
///
/// 支持两种布局：
/// - `<root>/llama-server.exe`（root 本身就是一个版本目录）；
/// - `<root>/<版本子目录>/llama-server.exe`。
pub fn scan_versions(
    root: &Path,
    explicit_libs: &[PathBuf],
    cache: &HashMap<String, VersionProbe>,
) -> Vec<LlamaCppVersion> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if root.join(exe("llama-server")).is_file() {
        dirs.push(root.to_path_buf());
    } else if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join(exe("llama-server")).is_file() {
                dirs.push(path);
            }
        }
    }

    let mut versions: Vec<LlamaCppVersion> = dirs
        .into_iter()
        .map(|dir| build_version(&dir, root, explicit_libs, cache))
        .collect();
    // 版本号大者在前：按名字里的数字段比较（纯字符串比较会把 b9999 排在 b10831 前面）
    versions.sort_by(|a, b| compare_version_names(&b.name, &a.name));
    versions
}

fn build_version(
    dir: &Path,
    llama_root: &Path,
    explicit_libs: &[PathBuf],
    cache: &HashMap<String, VersionProbe>,
) -> LlamaCppVersion {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string_lossy().to_string());

    let server_bin = dir.join(exe("llama-server"));
    let fit_params = dir.join(exe("llama-fit-params"));

    let shared_lib_dirs = find_shared_cuda_dirs(dir, explicit_libs, Some(llama_root));
    let has_router_mode = cached_probe(&name, cache);

    LlamaCppVersion {
        name,
        dir: dir.to_path_buf(),
        server_bin,
        fit_params_bin: fit_params.is_file().then_some(fit_params),
        has_router_mode,
        shared_lib_dirs,
        ascii_safe: is_ascii_path(dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        File::create(path).unwrap();
    }

    #[test]
    fn cuda_tag_parsing() {
        assert_eq!(
            cuda_tag("llama-b10831-bin-win-cuda-13.3-x64").as_deref(),
            Some("cuda-13.3")
        );
        assert_eq!(
            cuda_tag("cudart-llama-bin-win-cuda-12.4-x64").as_deref(),
            Some("cuda-12.4")
        );
        assert_eq!(cuda_tag("llama-b10831-bin-win-cpu-x64"), None);
    }

    #[test]
    fn ascii_check() {
        assert!(is_ascii_path(Path::new("E:/AI/llama.cpp-hub/llamacpp")));
        assert!(!is_ascii_path(Path::new("E:/AI/LLM服务工具")));
    }

    #[test]
    fn scan_and_match_shared_cuda() {
        let root = std::env::temp_dir().join("llamacpp-gui-versions-test");
        let _ = fs::remove_dir_all(&root);

        // 两个版本目录（不含 cudart）+ 一个共享 CUDA 目录
        let v1 = root.join("llama-b10831-bin-win-cuda-13.3-x64");
        let v2 = root.join("llama-b9999-bin-win-cuda-12.4-x64");
        let lib = root.join("cudart-llama-bin-win-cuda-13.3-x64");
        touch(&v1.join("llama-server.exe"));
        touch(&v1.join("llama-fit-params.exe"));
        touch(&v2.join("llama-server.exe"));
        touch(&lib.join("cudart64_13.dll"));
        touch(&lib.join("cublas64_13.dll"));

        let versions = scan_versions(&root, &[], &HashMap::new());
        assert_eq!(versions.len(), 2);

        let b10831 = versions.iter().find(|v| v.name.contains("10831")).unwrap();
        assert_eq!(b10831.shared_lib_dirs, vec![lib.clone()]);
        assert!(b10831.fit_params_bin.is_some());
        assert!(b10831.ascii_safe);

        // cuda-12.4 的版本不应匹配到 cuda-13.3 的目录（且兜底只认 cudart-* 前缀目录）
        let b9999 = versions.iter().find(|v| v.name.contains("9999")).unwrap();
        assert!(b9999.shared_lib_dirs.is_empty() || b9999.shared_lib_dirs == vec![lib.clone()]);

        // PATH 组装：共享库目录必须在最前
        let path = compose_path_env(b10831, Some(OsString::from("C:/Windows")));
        let text = path.to_string_lossy().to_string();
        let lib_idx = text.find("cudart-llama").unwrap();
        let win_idx = text.find("C:/Windows").unwrap();
        assert!(lib_idx < win_idx);

        let _ = fs::remove_dir_all(&root);
    }

    /// 需要本机真实环境（默认忽略）：`cargo test -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_environment_scan() {
        let root = std::path::Path::new("E:/AI/llama.cpp-hub/llamacpp");
        if !root.is_dir() {
            eprintln!("跳过：{} 不存在", root.display());
            return;
        }
        let versions = scan_versions(root, &[], &HashMap::new());
        println!("发现 {} 个版本:", versions.len());
        for v in &versions {
            let libs: Vec<String> = v
                .shared_lib_dirs
                .iter()
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                .collect();
            println!(
                "  {} router_mode={:?} ascii={} fit_params={} 共享库={:?}",
                v.name,
                v.has_router_mode,
                v.ascii_safe,
                v.fit_params_bin.is_some(),
                libs
            );
        }
        assert!(!versions.is_empty(), "应至少发现一个版本");
        assert!(
            versions.iter().any(|v| !v.shared_lib_dirs.is_empty()),
            "应至少为一个版本匹配到共享 CUDA 运行时目录"
        );
    }

    #[test]
    fn root_itself_is_a_version() {
        let root = std::env::temp_dir().join("llamacpp-gui-single-version-test");
        let _ = fs::remove_dir_all(&root);
        touch(&root.join("llama-server.exe"));
        let versions = scan_versions(&root, &[], &HashMap::new());
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].dir, root);
        let _ = fs::remove_dir_all(&root);
    }
}
