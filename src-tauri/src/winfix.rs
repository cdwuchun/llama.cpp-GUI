//! Windows 环境修复：非 ASCII 路径、端口占用检测。
//!
//! 实测背景（方案 §3 实测 8）：`llama-server` 在 router 模式下用**自身 exe 路径**再 spawn
//! 模型子实例，而该路径在 Windows 上以 ANSI 语义传递 —— 路径含中文时子实例创建失败：
//! `failed to spawn server instance`。规避方式是给该目录建一个纯 ASCII 的 junction 再启动。

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::versions::is_ascii_path;

/// 把任意字符串收敛为 ASCII 安全的目录名片段。
pub fn sanitize_component(name: &str) -> String {
    let mut out: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if out.is_empty() {
        out = "llama".to_string();
    }
    if out.len() > 32 {
        out.truncate(32);
    }
    out
}

/// 为 ASCII 修复链接生成稳定的目录名（同一目标路径始终得到同一名字）。
pub fn ascii_link_name(target: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    target.to_string_lossy().to_lowercase().hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let base = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    format!("{}-{}", sanitize_component(&base), &hash[..8])
}

/// 在 `link_root` 下为 `target` 创建一个纯 ASCII 的 junction，返回链接路径。
///
/// 使用 `cmd /c mklink /J`（junction 不需要管理员权限，也不需要开发者模式）。
/// 若目标路径本身已是 ASCII，则直接返回原路径。
pub fn ensure_ascii_dir(target: &Path, link_root: &Path) -> Result<PathBuf> {
    if is_ascii_path(target) {
        return Ok(target.to_path_buf());
    }
    if !target.is_dir() {
        bail!("目标目录不存在: {}", target.display());
    }

    fs::create_dir_all(link_root)
        .with_context(|| format!("创建链接根目录失败: {}", link_root.display()))?;
    let link = link_root.join(ascii_link_name(target));

    // 先无条件清掉可能存在的旧链接（rmdir 只删链接本身，不动目标内容）。
    //
    // 不要用 `link.exists()` 或 `symlink_metadata().is_ok()` 来判断"是否已存在"：
    // 目标被删/改名后 junction 变成悬空链接，这两个判断在 Windows 上都会漏掉它，
    // 于是跳过清理、紧接着 mklink 报"文件已存在"，router 就再也起不来了
    // （同名目录重装是很常见的操作）。
    remove_junction(&link)?;

    let status = create_junction(&link, target)?;

    if !status.success() || !link.is_dir() {
        bail!(
            "创建 ASCII 链接失败（mklink /J {} {}）",
            link.display(),
            target.display()
        );
    }
    if !is_ascii_path(&link) {
        bail!("链接路径仍包含非 ASCII 字符: {}", link.display());
    }
    Ok(link)
}

/// 用 `mklink /J` 建 junction。
///
/// 走 `raw_arg` 自己拼整条命令：`cmd` 会把参数里的 `&` `^` `%` 当元字符，
/// 而 `Command::arg` 只在含空格时才加引号 —— 用户的路径里出现这些字符时，
/// 命令会被拆成两条或把 `%TEMP%` 展开，链接就指错了地方。
fn create_junction(link: &Path, target: &Path) -> Result<std::process::ExitStatus> {
    let command = format!(
        "mklink /J \"{}\" \"{}\"",
        cmd_path(link)?,
        cmd_path(target)?
    );
    let mut cmd = Command::new("cmd");
    cmd.arg("/C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(command);
    }
    #[cfg(not(windows))]
    {
        cmd.arg(command);
    }
    let output = hide_console(&mut cmd).output().context("执行 mklink 失败")?;
    if !output.status.success() {
        // 失败原因（"已存在"、"拒绝访问"…）留在 stderr 里，吞掉的话只能看到一句笼统的提示
        eprintln!(
            "[winfix] mklink /J 失败（{:?}）: {} {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).trim(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(output.status)
}

/// 删除 junction（只删链接本身，不会删目标内容）。
///
/// 用 `fs::remove_dir`（底层是 `RemoveDirectoryW`）而不是 `cmd /C rmdir`：
/// 后者对**悬空**的 junction 会失败（报"文件已存在"的就是下一步的 mklink），
/// 而 `RemoveDirectoryW` 只是删掉这个目录项，目标在不在都能删。
fn remove_junction(link: &Path) -> Result<()> {
    if let Err(err) = fs::remove_dir(link) {
        // 不存在是正常情况（第一次创建），其它错误留给下面的命令兜底
        if err.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[winfix] remove_dir({}) 失败: {err}", link.display());
        }
    } else {
        return Ok(());
    }
    let command = format!("rmdir \"{}\"", cmd_path(link)?);
    let mut cmd = Command::new("cmd");
    cmd.arg("/C");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(command);
    }
    #[cfg(not(windows))]
    {
        cmd.arg(command);
    }
    let _ = hide_console(&mut cmd).status();
    Ok(())
}

/// 路径转成能安全塞进 `cmd` 命令串的形式（转义过的反斜杠路径，不含引号）。
pub(crate) fn cmd_path(path: &Path) -> Result<String> {    let text = path.to_string_lossy().to_string();
    if text.contains('"') {
        bail!("路径含引号，无法安全传给 cmd: {text}");
    }
    // cmd 的元字符：`%` 即使在引号里也会展开变量，`&` `|` `^` `<` `>` 能截断命令串。
    // 正常安装路径不会出现（Windows 文件名本就禁用 <>|&^），遇到就拒绝，别把命令拆两半执行
    //（审查发现：以前只挡双引号）。
    if let Some(bad) = text
        .chars()
        .find(|c| matches!(c, '%' | '&' | '|' | '^' | '<' | '>'))
    {
        bail!("路径含 cmd 元字符 {bad:?}，无法安全传给 cmd: {text}");
    }
    Ok(text)
}

/// 让子进程不弹出控制台窗口（Windows 的 `CREATE_NO_WINDOW`；其它平台为空操作）。///
/// 主程序本身是 GUI 子系统（不会自带控制台），但它 spawn 的**控制台程序**
/// —— `llama-server --help` / `--list-devices`、`cmd`、`taskkill`、`reg` —— 默认会
/// 新开一个控制台窗口，于是启动时的版本探测与设备枚举会在屏幕上闪一下黑窗。
/// **每一处 spawn 都要显式调用它**，不能只靠"主程序是 GUI 子系统"。
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 跑一个子进程并把输出收回来，最多等 `timeout`；超时就杀掉、返回 `None`。
///
/// 用在这些「探测外部 exe」的地方：`llama-server --help`、`--list-devices`、
/// `llama-fit-params`。被杀软拦住 / 缺 DLL / 参数让它卡住时，`Command::output()`
/// 会**无限期等下去**，而调用方是同步命令 —— 一次就把界面卡死（审查发现）。
pub fn output_with_timeout(cmd: &mut Command, timeout: Duration) -> Option<Output> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
    // 子进程已经退出：这里只是把管道里剩下的读完，不会卡住
    child.wait_with_output().ok()
}

/// 让子进程脱离父 Job Object（Windows 的 `CREATE_BREAKAWAY_FROM_JOB`）。
///
/// GUI 自身若运行在 Job Object 里（被任务管理器/沙箱/父进程托管），
/// spawn 出来的子进程默认**继承同一个 Job**，于是跟着一起被 Job 的
/// 完成端口与 CPU 节流限制：窗口被遮挡或后台化时，推理速度会掉到
/// 个位数 t/s。给推理进程加这个 flag 让它脱离 Job，不受宿主节流。
///
/// **必须与回退配套使用**：父 Job 未开启 `BREAKAWAY_OK` 时
/// `CreateProcess` 直接失败，所以调用方要能在失败后去掉 flag 重试
/// （见 `strata.rs::spawn_strata`）。
pub fn no_throttle(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0400_0000;
        // `creation_flags` 是覆盖写入，而读回当前 flags 的 `get_creation_flags`
        // 在当前工具链里尚未稳定，所以这里显式写入完整组合：
        // **必须在 `hide_console` 之后调用**（本仓库所有调用点都满足）。
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
    cmd
}

/// 端口是否已被占用。
pub fn port_in_use(port: u16) -> bool {    TcpListener::bind(("127.0.0.1", port)).is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_non_ascii() {
        // ASCII 片段保留，纯非 ASCII 才回退到默认名
        assert_eq!(sanitize_component("LLM服务工具"), "LLM");
        assert_eq!(sanitize_component("服务工具"), "llama");
        assert_eq!(sanitize_component("llama-b10831-bin"), "llama-b10831-bin");
    }

    #[test]
    fn link_name_is_stable_and_ascii() {
        let a = ascii_link_name(Path::new("E:/AI/LLM服务工具/llama-b10831"));
        let b = ascii_link_name(Path::new("E:/AI/LLM服务工具/llama-b10831"));
        assert_eq!(a, b);
        assert!(a.is_ascii(), "not ascii: {a}");
    }

    #[test]
    fn ascii_target_is_returned_as_is() {
        let dir = std::env::temp_dir();
        let out = ensure_ascii_dir(&dir, &dir.join("links")).unwrap();
        assert_eq!(out, dir);
    }

    /// 悬空 junction 必须能被替换：目标被删/改名后 `exists()` 返回 false（它跟随目标），
    /// 旧实现因此跳过清理、mklink 报"已存在"直接失败 —— 同名目录重装就会踩到。
    #[test]
    fn dangling_junction_is_recreated() {
        let root = std::env::temp_dir().join("llamacpp-gui-junction-dangling");
        let _ = fs::remove_dir_all(&root);
        let target = root.join("LLM服务工具");
        fs::create_dir_all(&target).unwrap();
        let links = root.join("links");

        let link = ensure_ascii_dir(&target, &links).unwrap();
        assert!(link.is_dir());

        fs::remove_dir_all(&target).unwrap();
        assert!(!link.exists(), "悬空 junction 的 exists() 应为 false");

        fs::create_dir_all(&target).unwrap();
        let again = ensure_ascii_dir(&target, &links).unwrap();
        assert_eq!(link, again);
        assert!(again.is_dir());

        let _ = remove_junction(&again);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn creates_ascii_junction_for_non_ascii_dir() {
        let root = std::env::temp_dir().join("llamacpp-gui-junction-test");
        let _ = fs::remove_dir_all(&root);
        let target = root.join("LLM服务工具");
        fs::create_dir_all(&target).unwrap();
        let link_root = root.join("links");

        let link = ensure_ascii_dir(&target, &link_root).unwrap();
        assert!(link.is_dir());
        assert!(is_ascii_path(&link));
        assert!(link.join(".").exists());

        // 清理时先删链接本身（rmdir 不会删除目标内容）
        let _ = remove_junction(&link);
        assert!(target.is_dir(), "目标目录不应被删除");
        let _ = fs::remove_dir_all(&root);
    }
}
