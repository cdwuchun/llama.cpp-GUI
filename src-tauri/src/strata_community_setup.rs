//! 社区档安装：把「下载页里选中的社区模型」按它自己的仓库 + 固定提交真下下来，再交给官方安装器准备。
//!
//! 逐段照搬上游 `strata-manager` 的 `crates/runtime-core/src/community_model.rs`（837 行）。为什么不能像
//! 官方档那样只调 `setup.py --family/--model`：`setup.py` 的 `FAMILIES[family]["hf"]` 是写死的
//! **官方**仓库（`setup.py:691` 的 `ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF`），它根本不接受
//! `--repo`，所以「社区」条目交给它，下回来的必然是官方权重量化 —— 这正是用户报的那个 bug（m00001）。
//!
//! 上游的做法分四步，本文件照搬：
//! 1. `fetch`：用 `setup.download`（续传 / HF 镜像 / ModelScope 回退）按 `repo@revision` 逐文件下载到
//!    `<data>/community/<slug>-<quant>/models/<QUANT>/`，逐个核对大小与 SHA-256；与官方分片字节相同的
//!    文件（`ISTA_FILES` 里同 (size, sha)）优先从本机官方下载**硬链接**复用，不重复占盘；
//! 2. `stash`：把官方安装器接下来要写的 `strata-<tag>.json` 先挪到一边（同量化的官方配置不能被覆盖），
//!    并在社区数据目录里先造一个空 pack 目录 —— setup 取数据目录优先，于是它会**从社区分片重新打包**，
//!    而不是复用官方 pack；
//! 3. `setup.py --gguf-dir`：与「使用已有模型」同一条入口，`--data-dir` 指向社区目录；
//! 4. `finish`：把 setup 写出的配置登记成 `strata-<slug>-<quant>.json`（`model_name`
//!    `<slug>-<quant>`；slug 自带来源，和官方 `strata-<tag>.json` 不会撞名，不再加前缀），
//!    把官方配置放回原位，并恢复 settings.json 里被 `--data-dir` 改掉的默认数据目录。
//!
//! 与上游的**必要偏离**（本工程目录布局不同）：
//! - 上游 runtime 根里就放着 `setup.py`，`home()` 与它同目录；本工程 `setup.py` 在
//!   `<根>\control\<版本>\`，配置写在 `<根>\`。所以 HELPER 多收一个 `control` 参数用于
//!   `sys.path.insert`，其余（`home / <配置名>`）仍然是 `setup.py` 的 `home()`。
//! - 不传 `--port`：与 `strata_download::start` 一致，端口留给 GUI 扫描时的 `ensure_ports` 分配。
//! - 磁盘预检只算字节（快照里给前端），不搬上游那套 `disk::Plan`（本工程已有 `strata_download::preflight`）。

use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::logs::LogHub;

/// 一个量化最多几个分片（上游 `MAX_FILES`）。
const MAX_FILES: usize = 8;
/// 去拒答向量（control vector）的大小上限（上游 `MAX_VECTOR_BYTES`）。
const MAX_VECTOR_BYTES: u64 = 64 * 1024 * 1024;
/// 社区模型所有分片加起来至少 1 GB —— 再小不可能是 Flash-Next 的一个量化。
const MIN_TOTAL_BYTES: u64 = 1_000_000_000;
const LOG_TAIL_CAP: usize = 240;

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/// 仓库里的一个文件。`sha256` 是**必填**的（安装前就拒绝无法校验的文件，与上游一致）。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFile {
    /// 仓库内路径（`Q2_0/Qwen3.8-…-Q2_0-00001-of-00002.gguf`）
    pub path: String,
    pub size: u64,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// 前端提交的社区安装请求（字段对齐上游 `CommunitySetupRequest`）。
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    pub slug: String,
    pub repo: String,
    pub revision: String,
    pub family: String,
    pub quant: String,
    #[serde(default)]
    pub files: Vec<SetupFile>,
    /// 去拒答向量，`setup.py --experimental-speed-projection`（仅 qwen 家族、仓库根目录）
    #[serde(default)]
    pub control_vector: Option<SetupFile>,
    #[serde(default)]
    pub context: u32,
    #[serde(default)]
    pub images: bool,
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub hf_endpoint: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub gpu: Option<String>,
    /// 「使用已有模型」：分片已经在这个目录里（文件名与社区仓库一致、逐个核对 SHA-256），
    /// 命中的文件硬链接进社区目录，找不到的才下载。空值 = 正常下载。
    #[serde(default)]
    pub local_dir: Option<String>,
}

/// `<slug>-<quant>`：登记进配置的 `model_name`（slug 里已有来源，与官方名天然不同）。
pub fn model_name(slug: &str, quant: &str) -> String {
    format!("{slug}-{}", quant.to_ascii_lowercase())
}

/// 社区配置的文件名：`strata-<slug>-<quant>.json`（不会与官方 `strata-<tag>.json` 撞名）。
pub fn config_file(slug: &str, quant: &str) -> String {
    format!("strata-{}.json", model_name(slug, quant))
}

/// `setup.py` 的 `FAMILIES[*]["tag"]` + 量化：官方安装器给这个组合用的 pack 与配置名。
fn setup_tag(family: &str, quant: &str) -> Option<String> {
    let prefix = match family {
        "qwen" => "",
        "swift" => "swift-",
        "coder" => "coder-",
        "unsloth" => "unsloth-",
        _ => return None,
    };
    Some(format!("{prefix}{quant}").to_ascii_lowercase())
}

fn is_slug(slug: &str) -> bool {
    (1..=64).contains(&slug.len())
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-')
}

fn is_repo_part(part: &str) -> bool {
    (1..=96).contains(&part.len())
        && part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && part.as_bytes()[0].is_ascii_alphanumeric()
        && !part.contains("..")
}

fn is_repo(repo: &str) -> bool {
    let mut parts = repo.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(owner), Some(name), None) if is_repo_part(owner) && is_repo_part(name))
}

fn is_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 仓库里的普通相对路径：不许 `..`、不许绝对路径或盘符、不许反斜杠，必须是 `.gguf`。
fn repo_file_name(path: &str) -> Result<String, String> {
    if path.is_empty() || path.len() > 300 || path.contains('\\') || path.contains(':') {
        return Err(format!("社区模型文件路径无效：{path}"));
    }
    let parsed = Path::new(path);
    if !parsed
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("社区模型文件路径无效：{path}"));
    }
    let name = parsed
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| format!("社区模型文件路径无效：{path}"))?;
    if !name.to_ascii_lowercase().ends_with(".gguf") || name.starts_with('.') {
        return Err(format!("社区模型文件必须是 .gguf：{path}"));
    }
    Ok(name)
}

/// `…-00001-of-00002.gguf` → `(stem, 1, 2)`；没有分片后缀返回 `None`。
fn shard_of(name: &str) -> Option<(String, u32, u32)> {
    let stem = name.strip_suffix(".gguf")?;
    let (head, total) = stem.rsplit_once("-of-")?;
    let (stem, index) = head.rsplit_once('-')?;
    if index.len() != 5 || total.len() != 5 {
        return None;
    }
    Some((stem.to_string(), index.parse().ok()?, total.parse().ok()?))
}

/// 下载之前先核对整份请求（上游 `validate` 逐行照搬）。
pub fn validate(request: &SetupRequest) -> Result<(), String> {
    if !is_slug(&request.slug) {
        return Err("社区模型标识无效".into());
    }
    if !is_repo(&request.repo) {
        return Err("Hugging Face 仓库名无效".into());
    }
    if !is_hex(&request.revision, 40) {
        return Err("社区模型必须固定到 40 位提交（revision）".into());
    }
    if setup_tag(&request.family, &request.quant).is_none()
        || !crate::strata_community::setup_supports(&request.family, &request.quant)
    {
        return Err(format!(
            "{} {} 不是官方安装器能准备的组合",
            request.family, request.quant
        ));
    }
    if request.files.is_empty() || request.files.len() > MAX_FILES {
        return Err("社区模型分片数量无效".into());
    }
    let mut stem: Option<String> = None;
    let mut total_bytes = 0_u64;
    for (index, file) in request.files.iter().enumerate() {
        let name = repo_file_name(&file.path)?;
        if !file.sha256.as_deref().is_some_and(|sha| is_hex(sha, 64)) {
            return Err(format!("{name} 缺少 SHA-256，下载了也无法校验"));
        }
        let (file_stem, number, total) = match shard_of(&name) {
            Some(shard) => shard,
            None => (name.trim_end_matches(".gguf").to_string(), 1, 1),
        };
        if number as usize != index + 1 || total as usize != request.files.len() {
            return Err(format!("{name} 不是完整分片组的第 {} 个分片", index + 1));
        }
        if stem.get_or_insert_with(|| file_stem.clone()) != &file_stem {
            return Err("社区模型分片不属于同一组文件".into());
        }
        if crate::strata_community::quant_of_stem(&file_stem).as_deref()
            != Some(request.quant.as_str())
        {
            return Err(format!("{name} 的文件名不是 {} 量化", request.quant));
        }
        if crate::strata_community::infer_family(&file_stem, &request.quant)
            != Some(request.family.as_str())
        {
            return Err(format!("{name} 的文件名对应的不是 {} 家族", request.family));
        }
        total_bytes = total_bytes.saturating_add(file.size);
    }
    if total_bytes < MIN_TOTAL_BYTES {
        return Err("社区模型文件大小异常".into());
    }
    if let Some(vector) = &request.control_vector {
        let name = repo_file_name(&vector.path)?;
        if vector.path.contains('/') || request.family != "qwen" {
            return Err(format!(
                "{name}：去拒答向量只支持仓库根目录、Qwen3.8-Flash-Next 家族"
            ));
        }
        if vector.size == 0 || vector.size > MAX_VECTOR_BYTES {
            return Err(format!("{name} 大小异常"));
        }
        if !vector.sha256.as_deref().is_some_and(|sha| is_hex(sha, 64)) {
            return Err(format!("{name} 缺少 SHA-256"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 目录与命令
// ---------------------------------------------------------------------------

/// 一次社区安装用到的全部路径与名字（`prepare` 只读磁盘、不建目录）。
pub struct Layout {
    /// `setup.py` 所在目录（HELPER 用它 `sys.path.insert`）
    pub control: PathBuf,
    pub python: PathBuf,
    /// 用户指定的 Strata 根（`setup.py` 的 `home()`，配置写在这里）
    pub root: PathBuf,
    /// `<data>/community/<slug>-<quant>`
    pub community: PathBuf,
    /// `<community>/models/<QUANT>`
    pub gguf_dir: PathBuf,
    /// `<community>/packs/<tag>`
    pub pack_dir: PathBuf,
    /// 官方安装器会写的配置：`<root>/strata-<tag>.json`
    pub setup_config: PathBuf,
    /// 改名后的社区配置：`<root>/strata-<slug>-<quant>.json`
    pub community_config: PathBuf,
    pub model_name: String,
    /// 还要下多少字节（扣掉已完整的文件与可复用的官方分片）
    pub download_bytes: u64,
    /// 本机已有、可直接复用/续传的字节
    pub reusable_bytes: u64,
}

/// 与官方分片同名同大小的那个文件（`<data>/models/<QUANT>/Qwen3.8-Flash-Next-GSQ-RCO-<QUANT>-0000i-of-0000N.gguf`）。
///
/// 社区仓库里的 `-00002-of-00002`（n-gram 表）与官方是**同一个文件**，先看它有没有已在本机。
fn official_counterpart(data: &Path, request: &SetupRequest, name: &str) -> Option<PathBuf> {
    if request.family != "qwen" {
        return None;
    }
    let at = name.rfind("-of-")?.checked_sub(6)?;
    let suffix = name.get(at..)?;
    if !suffix.starts_with("-0000") || !suffix.ends_with(".gguf") {
        return None;
    }
    let official = format!("Qwen3.8-Flash-Next-GSQ-RCO-{}{suffix}", request.quant);
    Some(data.join("models").join(&request.quant).join(official))
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

/// 算目录、名字与字节数；`validate` 通过才返回。
pub fn prepare(request: &SetupRequest) -> Result<Layout, String> {
    validate(request)?;
    if let Some(dir) = request
        .local_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
    {
        if !Path::new(dir).is_dir() {
            return Err(format!("本地 GGUF 目录不存在：{dir}"));
        }
    }
    let root = crate::strata::root()
        .filter(|root| root.is_dir())
        .ok_or_else(|| "未找到 Strata 目录（设置 → 通用 → Strata 目录 可指定）".to_string())?;
    let (python, _script, control) = crate::strata_download::locate()?;
    // 与官方下载同一个数据目录：settings.json 里记的那个，否则 `<根>\Strata-data`
    let data = request
        .data_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::strata_download::data_directory(&root));
    let quant = request.quant.to_ascii_lowercase();
    let community = data.join("community").join(format!("{}-{quant}", request.slug));
    let gguf_dir = community.join("models").join(&request.quant);
    let tag = setup_tag(&request.family, &request.quant).ok_or("未知的模型家族")?;
    let pack_dir = community.join("packs").join(&tag);

    let mut download_bytes = 0_u64;
    let mut reusable_bytes = 0_u64;
    // 「使用已有模型」：本地已命名正确的分片会被 fetch 硬链接过来（HELPER 里再核一遍 SHA-256），
    // 这里按同样的规则把它记成可复用，预检的「还要下多少」才准。
    let local = request
        .local_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    let mut files: Vec<&SetupFile> = request.files.iter().collect();
    files.extend(request.control_vector.iter());
    for file in files {
        let name = repo_file_name(&file.path)?;
        let have = file_len(&gguf_dir.join(&name));
        if have == file.size {
            reusable_bytes += have;
            continue;
        }
        if let Some(local) = local.as_deref() {
            let beside = local.join(&name);
            let nested = local.join(&file.path);
            let hit = if beside.is_file() {
                Some(beside)
            } else if nested.is_file() {
                Some(nested)
            } else {
                None
            };
            if let Some(hit) = hit {
                if file_len(&hit) == file.size {
                    reusable_bytes += file.size;
                    continue;
                }
            }
        }
        // 官方 ISTA-DASLab 的同名同大小分片已经在本机：fetch 步核对 SHA 后硬链接过来，不用重下
        if let Some(official) = official_counterpart(&data, request, &name) {
            if file_len(&official) == file.size {
                reusable_bytes += file.size;
                continue;
            }
        }
        let partial = file_len(&gguf_dir.join(format!("{name}.part"))).min(file.size);
        reusable_bytes += partial;
        download_bytes += file.size.saturating_sub(partial);
    }

    Ok(Layout {
        control,
        python,
        root: root.clone(),
        community,
        gguf_dir,
        pack_dir,
        setup_config: root.join(format!("strata-{tag}.json")),
        community_config: root.join(config_file(&request.slug, &request.quant)),
        model_name: model_name(&request.slug, &request.quant),
        download_bytes,
        reusable_bytes,
    })
}

// ---------------------------------------------------------------------------
// HELPER（Python，跑在控制端解释器里，用 setup.py 自己的下载与校验）
// ---------------------------------------------------------------------------

/// 与上游 `HELPER` 相同，只多收一个 `control`（`setup.py` 所在目录）用于 `sys.path`。
const HELPER: &str = r#"
import json, os, re, shutil, sys
from pathlib import Path
home, control, cmd, rest = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4:]
sys.path.insert(0, str(control))
import setup

# 「使用已有模型」时前端给的本地目录：分片在这里按清单里的文件名找，命中就硬链接进社区目录
LOCAL = os.environ.get("COMMUNITY_LOCAL_DIR", "").strip()

def settings_file():
    try:
        return Path(setup.settings_path())
    except Exception:
        return None

def write_json(path, value):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8")
    tmp.replace(path)

def official_roots():
    """setup 自己会从哪些数据目录找模型文件：记住的、默认的、别的安装、以及它们下面的 Strata-data。"""
    found = []
    try:
        found.append(Path(setup.data_folder_in_place()[0]))
    except Exception:
        pass
    try:
        settings = setup.load_settings()
        found += [Path(setup.home()), *[Path(p) for p in setup.other_installs(settings)]]
        if settings.get("data_dir"):
            found.append(Path(settings["data_dir"]))
    except Exception:
        pass
    found += [f / "Strata-data" for f in list(found)]
    return list(dict.fromkeys(found))

def file_sha256(path):
    import hashlib
    h, done, total = hashlib.sha256(), 0, path.stat().st_size
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(16 * 1024 * 1024), b""):
            h.update(chunk); done += len(chunk)
            if done % (4 * 1024 ** 3) < 16 * 1024 * 1024:
                print(f"  checking {path.name}: {done * 100 // max(total, 1)}%", flush=True)
    return h.hexdigest()

def reuse_official(dst, size, sha, community):
    """与官方分片字节完全相同（与 setup.ISTA_FILES 的 (size, sha) 一致）的社区文件，从本机已有官方下载里
    硬链接/复制过来：硬链接不占额外磁盘，setup 也从不原地改写校验过的分片。官方文件只读；候选文件必须自己
    的 SHA-256（setup 的 .done 标记或现算）对得上才用。"""
    names = [n for n, v in getattr(setup, "ISTA_FILES", {}).items() if tuple(v) == (size, sha)]
    if not names:
        return False
    for base in official_roots():
        for name in names:
            quant = name.split("-0000", 1)[0].rsplit("-", 1)[-1]
            for cand in (base / "models" / quant / name, base / "models" / quant.lower() / name, base / "models" / name):
                try:
                    if community in cand.resolve().parents or not cand.is_file() or cand.stat().st_size != size:
                        continue
                    mark = cand.with_name(cand.name + ".done")
                    marked = mark.exists() and f"sha256 {sha}" in mark.read_text(encoding="utf-8", errors="replace")
                    if not marked and file_sha256(cand) != sha:
                        print(f"  {cand} differs from the published file; not reused", flush=True)
                        continue
                    tmp = dst.with_name(dst.name + ".reuse")
                    if tmp.exists():
                        tmp.unlink()
                    try:
                        os.link(cand, tmp)
                        how = "hard link"
                    except OSError:
                        shutil.copyfile(cand, tmp)
                        how = "copy"
                        if file_sha256(tmp) != sha:
                            tmp.unlink()
                            print(f"  the copy of {cand} did not verify; downloading instead", flush=True)
                            return False
                    tmp.replace(dst)
                    dst.with_name(dst.name + ".done").write_text(f"sha256 {sha}\nreused {how} {cand}\n", encoding="utf-8")
                    print(f"  {dst.name}: reused the official file {cand} ({how}, SHA-256 matches)", flush=True)
                    return True
                except OSError as e:
                    print(f"  could not reuse {cand}: {e}", flush=True)
    return False

def find_local(name):
    """本地目录里的这个分片：先看目录本身，再递归（用户常把同一个仓库的几个量化分开放）。"""
    if not LOCAL:
        return None
    base = Path(LOCAL)
    direct = base / name
    if direct.is_file():
        return direct
    for p in sorted(base.rglob(name)):
        if p.is_file():
            return p
    return None

def reuse_local(dst, size, sha):
    """「使用已有模型」：本地文件必须与清单里的尺寸、SHA-256 都对得上才用，对不上直接报错
    （不悄悄改成下载：用户选本地就是要用本地文件，错了应该让他看见）。"""
    cand = find_local(dst.name)
    if cand is None:
        return False
    have = cand.stat().st_size
    if have != size:
        setup.fail(f"{cand} is {have:,} bytes, not {size:,}",
                   "this is not the pinned upload; rename or move it, or let the downloader fetch it")
    print(f"  checking {cand.name}: SHA-256", flush=True)
    if file_sha256(cand) != sha:
        setup.fail(f"{cand} does not match the published SHA-256",
                   "this file is not the pinned upload; delete it or move it out of the folder")
    tmp = dst.with_name(dst.name + ".local")
    if tmp.exists():
        tmp.unlink()
    try:
        os.link(cand, tmp)
        how = "hard link"
    except OSError:
        shutil.copyfile(cand, tmp)
        how = "copy"
    tmp.replace(dst)
    dst.with_name(dst.name + ".done").write_text(f"sha256 {sha}\nreused {how} {cand}\n", encoding="utf-8")
    print(f"  {dst.name}: reused the local file {cand} ({how}, SHA-256 matches)", flush=True)
    return True

if cmd == "fetch":
    dest, repo, rev, items = Path(rest[0]), rest[1], rest[2], rest[3:]
    dest.mkdir(parents=True, exist_ok=True)
    community = dest.resolve().parent.parent
    for item in items:
        remote, size, sha = item.rsplit("|", 2); size = int(size)
        dst = dest / remote.rsplit("/", 1)[-1]
        mark = dst.with_name(dst.name + ".done")
        if dst.exists() and dst.stat().st_size == size and mark.exists() and f"sha256 {sha}" in mark.read_text(encoding="utf-8", errors="replace"):
            print(f"{dst.name} already downloaded and verified", flush=True)
            continue
        if reuse_local(dst, size, sha):
            continue
        if reuse_official(dst, size, sha, community):
            continue
        setup.download(f"{setup.hf_endpoint()}/{repo}/resolve/{rev}/{remote}", dst, f"{repo.split('/')[-1]}: {dst.name}")
        if dst.stat().st_size != size:
            setup.fail(f"{dst.name} is {dst.stat().st_size:,} bytes, not {size:,}", "delete it and its .done mark, then download again")
        setup.verify_sha256(dst, size, sha)
        print(f"  {dst.name}: SHA-256 verified", flush=True)
    print("files ready", flush=True)
elif cmd == "stash":
    generic, pack = rest[0], Path(rest[1])
    cfg, stash, none = home / generic, home / (generic + ".stash"), home / (generic + ".none")
    for f in (stash, none):
        if f.exists():
            f.unlink()
    if cfg.exists():
        shutil.copy2(cfg, stash)
    else:
        none.write_text("", encoding="utf-8")
    sf = settings_file()
    snap = {"existed": bool(sf and sf.exists()), "data_dir": None}
    if snap["existed"]:
        try:
            snap["data_dir"] = json.loads(sf.read_text(encoding="utf-8")).get("data_dir")
        except (OSError, ValueError):
            pass
    write_json(home / (generic + ".stash-settings"), snap)
    pack.mkdir(parents=True, exist_ok=True)
    print(f"official config kept aside: {generic}", flush=True)
elif cmd == "finish":
    generic, target, name = rest[0], rest[1], rest[2]
    cfg, stash, none = home / generic, home / (generic + ".stash"), home / (generic + ".none")
    if not cfg.exists():
        setup.fail(f"setup wrote no {generic}", "see the log above")
    value = json.loads(cfg.read_text(encoding="utf-8-sig"))
    value["model_name"] = name
    value["log"] = str(home / (Path(target).stem + ".log"))
    write_json(home / target, value)
    # setup 写的 run-<tag> 启动脚本也改成社区名，并把 --config 指到社区配置；
    # 不按固定名找：上一次运行可能已经把它改成 run-<slug>-<量化>.bat 了，所以扫所有
    # 仍引用 generic 的脚本，逐个改到社区名。
    # 路径比较必须忽略大小写：setup.py 写 bat 时用的是它自己的 home()，大小写可能与
    # 我们传的 root 不同（现场出现过 E:\AI\strata 与 E:\AI\Strata 对不上，脚本没被改）。
    for ext in (".bat", ".sh"):
        script = home / f"run-{name}{ext}"
        pattern = re.compile(re.escape(str(home / generic)), re.I)
        for old in sorted(home.glob(f"run-*{ext}")):
            try:
                text = old.read_text(encoding="utf-8")
            except OSError:
                continue
            if not pattern.search(text):
                continue
            tag = old.stem[len("run-"):]
            fixed = pattern.sub(lambda _match: str(home / target), text)
            fixed = re.sub(rf"Strata\s+{re.escape(tag)}", f"Strata {name}", fixed, flags=re.I)
            script.write_text(fixed, encoding="utf-8")
            if old != script:
                old.unlink()
            print(f"start script registered: {script.name}", flush=True)
            break
    if stash.exists():
        stash.replace(cfg)
    elif none.exists():
        cfg.unlink()
        none.unlink()
    snapfile = home / (generic + ".stash-settings")
    sf = settings_file()
    if snapfile.exists() and sf and sf.exists():
        snap = json.loads(snapfile.read_text(encoding="utf-8"))
        try:
            now = json.loads(sf.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            now = None
        if isinstance(now, dict) and now.get("data_dir") != snap.get("data_dir"):
            if snap.get("data_dir"):
                now["data_dir"] = snap["data_dir"]
            else:
                now.pop("data_dir", None)
            write_json(sf, now)
            print("remembered data folder restored", flush=True)
    if snapfile.exists():
        snapfile.unlink()
    print(f"config registered: {target} ({name})", flush=True)
else:
    sys.exit(f"unknown command {cmd}")
"#;

// ---------------------------------------------------------------------------
// 快照与任务
// ---------------------------------------------------------------------------

/// 一次社区安装的进度快照（前端每秒轮询）。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSnapshot {
    pub running: bool,
    /// `download` / `stash` / `setup` / `config` / `done` / `failed` / `cancelled`
    pub phase: String,
    pub percent: f32,
    pub message: String,
    pub log_tail: Vec<String>,
    pub ok: Option<bool>,
    /// 条目 slug（任务面板里与量化一起显示）
    pub family: String,
    pub quant: String,
    pub model_name: String,
    pub data_directory: String,
    pub config_path: String,
    pub total_bytes: f64,
    pub done_bytes: f64,
}

impl Default for SetupSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            phase: String::new(),
            percent: 0.0,
            message: String::new(),
            log_tail: Vec::new(),
            ok: None,
            family: String::new(),
            quant: String::new(),
            model_name: String::new(),
            data_directory: String::new(),
            config_path: String::new(),
            total_bytes: 0.0,
            done_bytes: 0.0,
        }
    }
}

/// 一个在跑的社区安装任务。
pub struct SetupJob {
    snapshot: Arc<Mutex<SetupSnapshot>>,
    child: Arc<Mutex<Option<Child>>>,
    running: Arc<AtomicBool>,
}

impl SetupJob {
    pub fn snapshot(&self) -> SetupSnapshot {
        self.snapshot
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
}

/// 取消：先把 running 置 false（四步之间不再往下走），再硬杀整棵进程树
/// （setup.py 会起下载线程与打包子进程，只杀 python 会留半截文件）。
pub fn stop(job: &mut SetupJob) {
    job.running.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = job.child.lock() {
        if let Some(child) = guard.as_mut() {
            let pid = child.id();
            crate::logs::force_kill_tree(pid, child);
            let _ = child.wait();
        }
        *guard = None;
    }
    if let Ok(mut snap) = job.snapshot.lock() {
        snap.running = false;
        snap.phase = "cancelled".into();
        snap.message = "已取消社区安装（已下载的分片会保留，重新安装时接着下）".into();
        snap.ok = Some(false);
    }
}

type Tick = Arc<dyn Fn(&mut SetupSnapshot) + Send + Sync>;

/// 任务上下文：四步共用同一个快照、子进程槽与取消旗标。
#[derive(Clone)]
struct Ctx {
    snapshot: Arc<Mutex<SetupSnapshot>>,
    child: Arc<Mutex<Option<Child>>>,
    running: Arc<AtomicBool>,
    hub: Arc<LogHub>,
}

fn note(ctx: &Ctx, text: &str) {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return;
    }
    if let Ok(mut snapshot) = ctx.snapshot.lock() {
        snapshot.log_tail.push(trimmed.to_string());
        if snapshot.log_tail.len() > LOG_TAIL_CAP {
            let extra = snapshot.log_tail.len() - LOG_TAIL_CAP;
            snapshot.log_tail.drain(..extra);
        }
        snapshot.message = trimmed.to_string();
    }
    ctx.hub.push("strata-setup", trimmed.to_string());
}

fn set_phase(ctx: &Ctx, phase: &str, percent: f32, message: &str) {
    if let Ok(mut snapshot) = ctx.snapshot.lock() {
        snapshot.phase = phase.to_string();
        snapshot.percent = percent;
        snapshot.message = message.to_string();
    }
}

/// 子进程一行输出里带的百分比。`setup.py` 两种写法都认：
/// `Qwen3.8-…: 12.3 / 66.8 GB (18%)`（下载进度）与 `checking …: 40%`（校验进度）。
fn percent_of(line: &str) -> Option<f32> {
    if let Some(open) = line.rfind('(') {
        if let Some(rest) = line.get(open + 1..) {
            if let Some(pct) = rest.strip_suffix("%)") {
                if let Ok(value) = pct.trim().parse::<f32>() {
                    return Some(value);
                }
            }
        }
    }
    let trimmed = line.trim_end();
    let colon = trimmed.rfind(':')?;
    let pct = trimmed.get(colon + 1..)?.trim().strip_suffix('%')?;
    pct.trim().parse::<f32>().ok()
}

fn drain<R: Read>(reader: R, ctx: Arc<Ctx>, floor: f32, ceil: f32) {
    let mut buffer = BufReader::new(reader);
    let mut line = String::new();
    loop {
        line.clear();
        match buffer.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                note(&ctx, &line);
                if let Some(pct) = percent_of(&line) {
                    let mapped = floor + (ceil - floor) * (pct.clamp(0.0, 100.0) / 100.0);
                    if let Ok(mut snapshot) = ctx.snapshot.lock() {
                        snapshot.percent = snapshot.percent.max(mapped.min(ceil));
                    }
                }
            }
            Err(_) => break,
        }
    }
}

impl Ctx {
    /// 控制端解释器的一条命令：环境变量与官方下载那条链路完全一致。
    fn command(&self, layout: &Layout, request: &SetupRequest) -> Command {
        let mut cmd = Command::new(&layout.python);
        cmd.current_dir(&layout.control)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 应用模式：引擎交给 strata 组件管理（与 strata_download::start 同一条注释）
            .env("STRATA_CONTROL_INSTALL", "1")
            // 输出里有中文路径，管道下的 Python 会按 cp936 编码；`-u` 的等价物是 PYTHONUNBUFFERED
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .env("PYTHONUNBUFFERED", "1")
            // `home()` 在 CONTROL 模式下取 STRATA_INSTALL_DIR；`engine_component` 认 STRATA_COMPONENTS_DIR
            .env("STRATA_COMPONENTS_DIR", &layout.root)
            .env("STRATA_INSTALL_DIR", &layout.root);
        if let Some(endpoint) = request
            .hf_endpoint
            .as_deref()
            .map(str::trim)
            .filter(|endpoint| endpoint.starts_with("http"))
        {
            cmd.env("HF_ENDPOINT", endpoint);
        }
        // 「使用已有模型」：HELPER 的 fetch 先在这个目录里按清单文件名找分片（用环境变量传，不打乱参数结构）
        if let Some(dir) = request
            .local_dir
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty())
        {
            cmd.env("COMMUNITY_LOCAL_DIR", dir);
        }
        cmd
    }
}

/// 跑一步：接管 stdout/stderr 写日志，循环 `try_wait`，`tick` 每 700ms 更新一次进度。
fn run_step(
    ctx: &Ctx,
    mut cmd: Command,
    label: &str,
    floor: f32,
    ceil: f32,
    tick: Option<Tick>,
) -> Result<bool, String> {
    crate::winfix::hide_console(&mut cmd);
    let mut child = cmd.spawn().map_err(|err| format!("启动{label}失败：{err}"))?;
    let shared = Arc::new(ctx.clone());
    if let Some(stream) = child.stdout.take() {
        let stream_ctx = Arc::clone(&shared);
        std::thread::spawn(move || drain(stream, stream_ctx, floor, ceil));
    }
    if let Some(stream) = child.stderr.take() {
        let stream_ctx = Arc::clone(&shared);
        std::thread::spawn(move || drain(stream, stream_ctx, floor, ceil));
    }
    if let Ok(mut guard) = ctx.child.lock() {
        *guard = Some(child);
    }
    loop {
        if !ctx.running.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let status = {
            let mut guard = ctx.child.lock().unwrap_or_else(|err| err.into_inner());
            guard.as_mut().map(|child| child.try_wait())
        };
        match status {
            None => return Err("子进程丢了，请重试".into()),
            Some(Ok(Some(status))) => {
                if let Ok(mut guard) = ctx.child.lock() {
                    *guard = None;
                }
                if !status.success() {
                    return Err(format!("{label}失败（退出码 {:?}），看日志", status.code()));
                }
                return Ok(true);
            }
            Some(Ok(None)) => {}
            Some(Err(err)) => return Err(format!("等待{label}失败：{err}")),
        }
        if let Some(tick) = &tick {
            if let Ok(mut snapshot) = ctx.snapshot.lock() {
                tick(&mut snapshot);
            }
        }
        std::thread::sleep(Duration::from_millis(700));
    }
}

/// 四步流程。`Ok(true)` 走完，`Ok(false)` 用户取消。
fn run(ctx: &Ctx, layout: &Layout, request: &SetupRequest) -> Result<bool, String> {
    let tag =
        setup_tag(&request.family, &request.quant).ok_or_else(|| "未知的模型家族".to_string())?;
    let generic = format!("strata-{tag}.json");
    let mut files: Vec<&SetupFile> = request.files.iter().collect();
    files.extend(request.control_vector.iter());
    let total: u64 = files.iter().map(|file| file.size).sum();

    // ---- 1. 按固定提交下载社区分片（SHA-256 逐个校验）----
    set_phase(
        ctx,
        "download",
        1.0,
        &format!(
            "下载 {}（{}）：还要 {:.1} GB，已有 {:.1} GB 可复用",
            request.repo,
            request.quant,
            layout.download_bytes as f64 / 1e9,
            layout.reusable_bytes as f64 / 1e9
        ),
    );
    let mut fetch = ctx.command(layout, request);
    fetch
        .arg("-u")
        .arg("-c")
        .arg(HELPER)
        .arg(&layout.root)
        .arg(&layout.control)
        .arg("fetch")
        .arg(&layout.gguf_dir)
        .arg(&request.repo)
        .arg(&request.revision);
    for file in &files {
        fetch.arg(format!(
            "{}|{}|{}",
            file.path,
            file.size,
            file.sha256.clone().unwrap_or_default()
        ));
    }
    let watched: Arc<Vec<(PathBuf, u64)>> = Arc::new(
        files
            .iter()
            .map(|file| {
                let name = file
                    .path
                    .rsplit('/')
                    .next()
                    .unwrap_or(&file.path)
                    .to_string();
                (layout.gguf_dir.join(name), file.size)
            })
            .collect(),
    );
    let tick: Tick = Arc::new(move |snapshot: &mut SetupSnapshot| {
        let done: u64 = watched
            .iter()
            .map(|(path, _)| file_len(path))
            .sum::<u64>()
            .min(total);
        snapshot.done_bytes = done as f64;
        if total > 0 {
            snapshot.percent = snapshot.percent.max(1.0 + 63.0 * (done as f32 / total as f32));
        }
        snapshot.message = format!(
            "已就绪 {:.1} / {:.1} GB（含续传与官方分片复用）",
            done as f64 / 1e9,
            total as f64 / 1e9
        );
    });
    if !run_step(ctx, fetch, "下载社区分片", 1.0, 64.0, Some(tick))? {
        return Ok(false);
    }

    // ---- 2. 官方配置挪到一边 + 先造社区 pack 目录 ----
    set_phase(
        ctx,
        "stash",
        65.0,
        &format!("先让开官方配置：{}", layout.setup_config.display()),
    );
    let mut stash = ctx.command(layout, request);
    stash
        .arg("-u")
        .arg("-c")
        .arg(HELPER)
        .arg(&layout.root)
        .arg(&layout.control)
        .arg("stash")
        .arg(&generic)
        .arg(&layout.pack_dir);
    if !run_step(ctx, stash, "准备配置", 65.0, 66.0, None)? {
        return Ok(false);
    }

    // ---- 3. 官方安装器以 `--gguf-dir` 准备（与「使用已有模型」同一条入口）----
    set_phase(ctx, "setup", 66.0, "官方安装器正在准备社区分片");
    let mut setup = ctx.command(layout, request);
    setup
        .arg("-u")
        .arg("setup.py")
        .arg("--yes")
        .arg("--setup")
        .arg("--no-start")
        .arg("--no-browser")
        .arg("--family")
        .arg(&request.family)
        .arg("--model")
        .arg(&request.quant)
        .arg("--context")
        .arg(request.context.to_string())
        .arg("--vision")
        .arg(if request.images { "yes" } else { "no" })
        .arg("--data-dir")
        .arg(&layout.community);
    if let Some(source) = request
        .source
        .as_deref()
        .map(str::trim)
        .filter(|source| matches!(*source, "auto" | "modelscope" | "huggingface"))
    {
        setup.arg("--source").arg(source);
    }
    if let Some(backend) = request
        .backend
        .as_deref()
        .map(str::trim)
        .filter(|backend| matches!(*backend, "cuda" | "hip" | "sycl"))
    {
        setup.arg("--backend").arg(backend);
    }
    if let Some(gpu) = request
        .gpu
        .as_deref()
        .map(str::trim)
        .filter(|gpu| !gpu.is_empty())
    {
        setup.arg("--gpu").arg(gpu);
    }
    setup.arg("--gguf-dir").arg(&layout.gguf_dir);
    if let Some(vector) = &request.control_vector {
        let name = vector.path.rsplit('/').next().unwrap_or(&vector.path);
        setup
            .arg("--experimental-speed-projection")
            .arg(layout.gguf_dir.join(name));
    }
    if !run_step(ctx, setup, "安装器准备", 66.0, 94.0, None)? {
        return Ok(false);
    }

    // ---- 4. 登记成社区配置，把官方配置放回原位 ----
    set_phase(ctx, "config", 95.0, "登记社区配置（不覆盖官方配置）");
    let mut finish = ctx.command(layout, request);
    finish
        .arg("-u")
        .arg("-c")
        .arg(HELPER)
        .arg(&layout.root)
        .arg(&layout.control)
        .arg("finish")
        .arg(&generic)
        .arg(config_file(&request.slug, &request.quant))
        .arg(model_name(&request.slug, &request.quant));
    if !run_step(ctx, finish, "登记配置", 95.0, 98.0, None)? {
        return Ok(false);
    }
    note(
        ctx,
        &format!(
            "社区模型已登记：{}（到「模型」页点刷新即可看到）",
            layout.community_config.display()
        ),
    );
    Ok(true)
}

/// 起一次社区安装（后台线程跑四步，立刻返回任务供前端轮询）。
pub fn start(hub: Arc<LogHub>, request: SetupRequest) -> Result<(SetupJob, String), String> {
    let layout = prepare(&request)?;
    std::fs::create_dir_all(&layout.gguf_dir)
        .map_err(|err| format!("创建下载目录失败：{}（{err}）", layout.gguf_dir.display()))?;
    let total: u64 = request
        .files
        .iter()
        .chain(request.control_vector.iter())
        .map(|file| file.size)
        .sum();
    let snapshot = Arc::new(Mutex::new(SetupSnapshot {
        running: true,
        phase: "download".into(),
        percent: 0.0,
        message: format!("准备下载 {} · {}", request.slug, request.quant),
        family: request.slug.clone(),
        quant: request.quant.clone(),
        model_name: layout.model_name.clone(),
        data_directory: layout.community.display().to_string(),
        config_path: layout.community_config.display().to_string(),
        total_bytes: total as f64,
        done_bytes: layout.reusable_bytes as f64,
        ..Default::default()
    }));
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    let running = Arc::new(AtomicBool::new(true));
    let ctx = Ctx {
        snapshot: Arc::clone(&snapshot),
        child: Arc::clone(&child),
        running: Arc::clone(&running),
        hub: Arc::clone(&hub),
    };
    let message = format!(
        "社区模型 {}（{}）开始下载：{} @ {}",
        request.slug,
        request.quant,
        request.repo,
        &request.revision[..7.min(request.revision.len())]
    );
    hub.push("strata-setup", message.clone());

    // 线程里要带走快照与取消旗标，任务本身留一份（两个 Arc 各自 clone）
    let job_snapshot = Arc::clone(&snapshot);
    let job_running = Arc::clone(&running);
    std::thread::spawn(move || {
        let outcome = run(&ctx, &layout, &request);
        let mut guard = snapshot.lock().unwrap_or_else(|err| err.into_inner());
        guard.running = false;
        match outcome {
            Ok(true) => {
                guard.ok = Some(true);
                guard.phase = "done".into();
                guard.percent = 100.0;
                guard.message = "社区模型已就绪：到「模型」页点刷新即可看到".into();
            }
            Ok(false) => {
                // 被用户取消：`stop()` 已经写过 cancelled
            }
            Err(err) => {
                guard.ok = Some(false);
                guard.phase = "failed".into();
                guard.message = err;
            }
        }
        drop(guard);
        running.store(false, Ordering::SeqCst);
    });

    Ok((
        SetupJob {
            snapshot: job_snapshot,
            child,
            running: job_running,
        },
        message,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA: &str = "1620faf21c845524cbe38dcbbaf850b8d155c2299df05d8b7bfb43b642c4647e";

    fn sc117(quant: &str) -> SetupRequest {
        SetupRequest {
            slug: "sc117-abliterated".into(),
            repo: "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF".into(),
            revision: "eec4e10a2c29b440a2ae85591fa11569ce752963".into(),
            family: "qwen".into(),
            quant: quant.into(),
            files: (1..=2)
                .map(|i| SetupFile {
                    path: format!("{quant}/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-{quant}-0000{i}-of-00002.gguf"),
                    size: 30_000_000_000,
                    sha256: Some(SHA.into()),
                })
                .collect(),
            control_vector: None,
            ..Default::default()
        }
    }

    #[test]
    fn local_dir_comes_in_as_camel_case_and_defaults_to_none() {
        // 「使用已有模型」在社区档下走这条：前端传 `localDir`，不传就是正常下载
        let raw = format!(
            r#"{{"slug":"sc117-abliterated","repo":"SC117/x","revision":"{}",
                 "family":"qwen","quant":"IQ3_S","files":[],"localDir":"E:\\models"}}"#,
            "eec4e10a2c29b440a2ae85591fa11569ce752963"
        );
        let request: SetupRequest = serde_json::from_str(&raw).unwrap();
        assert_eq!(request.local_dir.as_deref(), Some(r"E:\models"));
        assert!(sc117("IQ3_S").local_dir.is_none());
    }

    #[test]
    fn accepts_the_pinned_sc117_shards() {
        for quant in ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S"] {
            validate(&sc117(quant)).unwrap();
        }
        assert_eq!(
            model_name("sc117-abliterated", "IQ3_S"),
            "sc117-abliterated-iq3_s"
        );
        assert_eq!(
            config_file("sc117-abliterated", "Q2_0"),
            "strata-sc117-abliterated-q2_0.json"
        );
        assert_eq!(
            setup_tag("qwen", "IQ3_S").as_deref(),
            Some("iq3_s"),
            "qwen 家族没有前缀"
        );
        assert_eq!(setup_tag("swift", "IQ3_S").as_deref(), Some("swift-iq3_s"));
    }

    #[test]
    fn refuses_unpinned_unsafe_or_mismatched_requests() {
        let mut r = sc117("Q2_0");
        r.revision = "main".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files[0].path =
            "../Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00001-of-00002.gguf".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files[0].path =
            "/etc/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-Q2_0-00001-of-00002.gguf".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files[1].sha256 = None;
        assert!(validate(&r).unwrap_err().contains("SHA-256"));
        let mut r = sc117("Q2_0");
        r.files.pop();
        assert!(validate(&r).is_err(), "分片不全");
        let mut r = sc117("Q2_0");
        r.quant = "IQ3_S".into();
        assert!(validate(&r).is_err(), "文件名写着 Q2_0");
        let mut r = sc117("Q2_0");
        r.family = "swift".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.repo = "a/b/c".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.slug = "../x".into();
        assert!(validate(&r).is_err());
        let mut r = sc117("Q2_0");
        r.files.iter_mut().for_each(|f| f.size = 1000);
        assert!(validate(&r).is_err());
    }

    #[test]
    fn control_vector_is_root_level_small_and_hashed() {
        let mut r = sc117("Q2_0");
        r.control_vector = Some(SetupFile {
            path: "Huihui-Qwen3.8-Flash-Next-refusal-direction-r.gguf".into(),
            size: 483_520,
            sha256: Some("59f9ae8b4372107ae79044278a4406bdfe8f8861fe599aa5848515f0d072be38".into()),
        });
        validate(&r).unwrap();
        r.control_vector.as_mut().unwrap().size = MAX_VECTOR_BYTES + 1;
        assert!(validate(&r).is_err());
    }

    #[test]
    fn official_counterpart_matches_the_official_shard_name() {
        let data = PathBuf::from("C:/strata-data");
        let request = sc117("IQ3_S");
        assert_eq!(
            official_counterpart(
                &data,
                &request,
                "Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_S-00002-of-00002.gguf"
            ),
            Some(data.join("models/IQ3_S/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00002-of-00002.gguf"))
        );
        assert_eq!(
            official_counterpart(&data, &request, "Huihui-refusal-direction-r.gguf"),
            None
        );
    }

    #[test]
    fn percent_of_reads_the_installer_progress_lines() {
        assert_eq!(
            percent_of("Qwen3.8-Flash-Next-GSQ-RCO: 12.3 / 66.8 GB (18%)"),
            Some(18.0)
        );
        assert_eq!(
            percent_of("  checking Qwen3.8-…-00001-of-00002.gguf: 40%"),
            Some(40.0)
        );
        assert_eq!(percent_of("files ready"), None);
    }

    /// HELPER 的 stash/finish 只有真 Python 才跑得起来：用一个最小 `setup.py` 替身验证
    /// 「官方配置被放回、社区配置被登记」这条最容易出错的路径。
    #[test]
    fn helper_registers_the_community_config_and_restores_the_official_one() {
        let Some(python) = python() else {
            eprintln!("本机没有 Python，跳过");
            return;
        };
        let temp = std::env::temp_dir().join(format!("llamacpp-gui-community-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let home = temp.join("root");
        let control = temp.join("control");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&control).unwrap();
        let settings = temp.join("settings.json");
        std::fs::write(
            control.join("setup.py"),
            format!(
                "from pathlib import Path\nISTA_FILES = {{}}\n\
                 def home(): return Path({home:?})\n\
                 def settings_path(): return Path({settings:?})\n\
                 def load_settings(): return {{}}\n\
                 def other_installs(s): return []\n\
                 def data_folder_in_place(): return Path({home:?}), []\n\
                 def hf_endpoint(): return 'https://example.invalid'\n\
                 def download(*a): raise SystemExit('download attempted')\n\
                 def fail(*a): raise SystemExit(str(a))\n\
                 def verify_sha256(*a): pass\n",
                home = home.to_string_lossy(),
                settings = settings.to_string_lossy()
            ),
        )
        .unwrap();
        std::fs::write(&settings, "{\"data_dir\": \"C:/official\"}\n").unwrap();
        std::fs::write(
            home.join("strata-iq3_s.json"),
            "{\"model_name\": \"official\", \"args\": []}\n",
        )
        .unwrap();
        let run = |args: &[&std::ffi::OsStr]| {
            let mut cmd = Command::new(&python);
            cmd.arg("-u").arg("-c").arg(HELPER).arg(&home).arg(&control);
            cmd.args(args);
            cmd.output().unwrap()
        };
        let pack = home.join("packs/iq3_s");
        let out = run(&[
            std::ffi::OsStr::new("stash"),
            std::ffi::OsStr::new("strata-iq3_s.json"),
            pack.as_os_str(),
        ]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(home.join("strata-iq3_s.json.stash").is_file());
        assert!(pack.is_dir(), "先造社区 pack 目录，setup 才不会复用官方 pack");
        // setup.py 写出同名配置与 run-<tag>.bat（这里手动模拟它的产出）
        std::fs::write(
            home.join("strata-iq3_s.json"),
            "{\"model_name\": \"official\", \"args\": [\"--x\"]}\n",
        )
        .unwrap();
        std::fs::write(
            home.join("run-iq3_s.bat"),
            format!(
                "@echo off\r\ntitle Strata IQ3_S\r\ncd /d \"C:\\control\"\r\n\"py\" serve --config \"{}\"\r\n",
                home.join("strata-iq3_s.json").display()
            ),
        )
        .unwrap();
        let out = run(&[
            std::ffi::OsStr::new("finish"),
            std::ffi::OsStr::new("strata-iq3_s.json"),
            std::ffi::OsStr::new("strata-sc117-abliterated-iq3_s.json"),
            std::ffi::OsStr::new("sc117-abliterated-iq3_s"),
        ]);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let official = std::fs::read_to_string(home.join("strata-iq3_s.json")).unwrap();
        assert!(official.contains("\"official\""), "官方配置被放回：{official}");
        assert!(
            !official.contains("--x"),
            "setup 写的那份不该留在官方名下：{official}"
        );
        let community =
            std::fs::read_to_string(home.join("strata-sc117-abliterated-iq3_s.json")).unwrap();
        assert!(community.contains("sc117-abliterated-iq3_s"));
        assert!(community.contains("--x"));
        // 启动脚本也改名并指向社区配置，否则它启动的会是放回后的官方配置
        let bat = std::fs::read_to_string(home.join("run-sc117-abliterated-iq3_s.bat")).unwrap();
        assert!(bat.contains("strata-sc117-abliterated-iq3_s.json"), "{bat}");
        assert!(bat.contains("Strata sc117-abliterated-iq3_s"), "{bat}");
        assert!(!home.join("run-iq3_s.bat").exists(), "旧的 run-iq3_s.bat 应被移除");
        assert!(!home.join("strata-iq3_s.json.stash-settings").exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    /// 上一轮已经把脚本改成 `run-<来源>-<量化>.bat`，但里面仍指向官方配置：这轮 setup
    /// 没再写同名脚本时，也要按内容把 `--config` 改到社区配置（现场就是这么错着的）。
    /// 脚本里的路径还用大写写，覆盖「setup.py 的 home() 与我们传的 root 大小写不同」这一坑。
    #[test]
    fn finish_fixes_a_start_script_that_was_renamed_earlier() {
        let Some(python) = python() else {
            eprintln!("本机没有 Python，跳过");
            return;
        };
        let temp = std::env::temp_dir().join(format!(
            "llamacpp-gui-community-bat-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&temp);
        let home = temp.join("root");
        let control = temp.join("control");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&control).unwrap();
        std::fs::write(
            control.join("setup.py"),
            format!(
                "from pathlib import Path\nISTA_FILES = {{}}\n\
                 def home(): return Path({home:?})\n\
                 def settings_path(): return Path({settings:?})\n\
                 def fail(*a): raise SystemExit(str(a))\n",
                home = home.to_string_lossy(),
                settings = temp.join("settings.json").to_string_lossy()
            ),
        )
        .unwrap();
        let official = home.join("strata-iq3_s.json");
        std::fs::write(
            &official,
            "{\"model_name\": \"official\", \"args\": [\"--x\"]}\n",
        )
        .unwrap();
        let script = home.join("run-sc117-abliterated-iq3_s.bat");
        std::fs::write(
            &script,
            format!(
                "@echo off\r\ntitle Strata IQ3_S\r\n\"py\" serve --config \"{}\"\r\n",
                official.display().to_string().to_uppercase()
            ),
        )
        .unwrap();
        let out = std::process::Command::new(&python)
            .arg("-u")
            .arg("-c")
            .arg(HELPER)
            .arg(&home)
            .arg(&control)
            .args([
                "finish",
                "strata-iq3_s.json",
                "strata-sc117-abliterated-iq3_s.json",
                "sc117-abliterated-iq3_s",
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let bat = std::fs::read_to_string(&script).unwrap();
        assert!(bat.contains("strata-sc117-abliterated-iq3_s.json"), "{bat}");
        assert!(!bat.contains("strata-iq3_s.json\""), "{bat}");
        let _ = std::fs::remove_dir_all(&temp);
    }

    fn python() -> Option<PathBuf> {
        if let Some(selected) = std::env::var_os("STRATA_MANAGER_TEST_PYTHON") {
            return Some(PathBuf::from(selected));
        }
        let out = std::process::Command::new(if cfg!(windows) { "py" } else { "python3" })
            .args(["-c", "import sys;print(sys.executable)"])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).trim()))
    }
}
