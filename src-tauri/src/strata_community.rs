//! 社区模型目录：从 Hugging Face 上发现「能用 setup.py 装」的第三方 GGUF。
//!
//! 为什么放在后端：GUI 的 CSP（`connect-src 'self' ipc: http://127.0.0.1:* http://localhost:*`）
//! 只放行本机，前端 fetch 不到外网；HTTP 走系统 `curl.exe`，理由和 `src/search.rs` 一样
//! ——本机 schannel 不可用，引 reqwest 反而连不上 https。
//!
//! 规则逐条照搬上游 `packages/core/src/community-catalog.ts`：
//! - 只认「同一目录、分片齐全（`-00001-of-0000N`）、每片带 sha256、总量 ≥1GB」的 GGUF 组；
//! - `mmproj*.gguf` 只算视觉投影，不进量化列表；
//! - 路径里带 `reap|prun|distill` 的仓库直接跳过（剪枝版和引擎对不上）；
//! - 家族靠文件名推断，再用 `SETUP_FAMILY_QUANTS` 过滤，保证选中的组合
//!   `setup.py --family F --model Q` 一定认；认不出的整条丢弃。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 上游的搜索词：这两串能捞出目前社区里「真机验证过」的那批 GSQ-RCO 仓库。
const SEARCHES: [&str; 2] = ["GSQ-RCO", "Qwen3.8-Flash-Next"];
/// 最多收多少个候选仓库：每个候选要再打两次 API（info + tree），多了前端等太久。
const MAX_CANDIDATES: usize = 12;

    /// 上游是 12；这里放到 16 —— 镜像上的下载量排名会随时间漂移，12 个候选今天
    /// 只解析出 5 条（上游截图里是 6 条）。再往上就是 mradermacher 那类只发
    /// K-quant 的仓库，本来就认不出量化，只会白等两次 API。
/// 发现结果的缓存时长，和上游一致。
const CACHE_TTL_MS: u64 = 24 * 60 * 60 * 1000;
/// 内置条目的仓库（`packages/core/src/community-catalog.ts` 的 `BUILTIN_COMMUNITY_MODELS`）。
/// 发现结果里必须排掉它们，否则前端合并时出现重复卡片。
const KNOWN_REPOS: [&str; 3] = [
    "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF",
    "alesha-pro/Qwen3.8-Flash-Next-abliterated-GSQ-RCO-Strata-GGUF",
    "orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF",
];
/// 官方仓库的 owner，出现在搜索里一律当噪声。
const OFFICIAL_OWNERS: [&str; 6] = ["ISTA-DASLab", "ukisai", "unsloth", "Qwen", "nvidia", "agentionai"];
const FETCH_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) llamacpp-gui";

/// 仓库里一个 GGUF 文件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityFile {
    pub path: String,
    pub size: u64,
    pub sha256: Option<String>,
}

/// 一个量化版本：分片清单 + 由此算出的下载量与内存参考。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityQuant {
    pub files: Vec<CommunityFile>,
    pub download_gb: f64,
    pub ram_gb: u32,
}

/// 发现到的社区模型。字段与前端 `src/utils/communityCatalog.ts` 一一对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityModel {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub repo: String,
    pub revision: String,
    /// `qwen` / `swift` / `coder` / `unsloth`（发现条目不可能是 qwen36，上游主动排除）。
    pub family: String,
    pub kind: String,
    pub images: bool,
    pub quants: Vec<String>,
    pub quant_info: BTreeMap<String, CommunityQuant>,
    pub mmproj: Option<String>,
    pub risks: Vec<String>,
    pub source: String,
    pub downloads: Option<u64>,
    pub likes: Option<u64>,
    pub updated_at: Option<String>,
}

/// 发现结果。`state` 的取值照搬上游：fresh / cached / stale / offline。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub entries: Vec<CommunityModel>,
    pub state: String,
    pub fetched_at: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cache {
    /// 缓存对应的接口站点：换了镜像（比如从 hf-mirror 换成直连）就重拉
    #[serde(default)]
    base: String,
    fetched_at: u64,
    entries: Vec<Value>,
}

fn cache_slot() -> &'static Mutex<Option<Cache>> {
    static SLOT: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// `setup.py` 每个家族接受的量化名。
fn family_quants(family: &str) -> &'static [&'static str] {
    match family {
        "qwen" => &["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S"],
        "swift" => &["IQ2_XS", "IQ3_XXS", "IQ3_S"],
        "coder" => &["IQ1_M"],
        "unsloth" => &["UD-IQ4_XS", "UD-Q4_K_XL", "UD-Q5_K_XL", "UD-Q6_K_XL", "Q8_0"],
        _ => &[],
    }
}

fn setup_supports(family: &str, quant: &str) -> bool {
    family_quants(family).iter().any(|known| *known == quant)
}

/// 文件名的量化段：`...-IQ3_XXS-00001-of-00002.gguf` → `IQ3_XXS`；`...-UD-Q4_K_XL.gguf` → `UD-Q4_K_XL`。
fn quant_of_stem(stem: &str) -> Option<String> {
    let parts: Vec<&str> = stem.split('-').collect();
    let last = parts.last()?;
    if !is_quant_name(last) {
        return None;
    }
    // UD 前缀是 unsloth 的标记，BPE 分词把它切成两段（UD / Q4_K_XL）
    let quant = if parts.len() >= 2 && parts[parts.len() - 2].eq_ignore_ascii_case("ud") {
        format!("UD-{}", last.to_uppercase())
    } else {
        last.to_uppercase()
    };
    Some(quant)
}

fn is_quant_name(text: &str) -> bool {
    let upper = text.to_uppercase();
    if matches!(upper.as_str(), "BF16" | "F16" | "F32") {
        return true;
    }
    let Some(rest) = upper.strip_prefix('Q').or_else(|| upper.strip_prefix("IQ")) else {
        return false;
    };
    // 头部之后必须是数字，后面只能跟 `_大写` 片段（0 个或多个）
    let mut chars = rest.chars();
    let mut digit_seen = false;
    let mut tail = String::new();
    for ch in chars.by_ref() {
        if ch.is_ascii_digit() {
            digit_seen = true;
            continue;
        }
        tail.push(ch);
        break;
    }
    if !digit_seen {
        return false;
    }
    if tail.is_empty() {
        return true;
    }
    tail.chars().next().is_some_and(|ch| ch == '_')
        && tail[1..].chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// 上游 `inferFamily`（`community-catalog.ts:226`）逐行照搬：`qwen3.6` → `swift` → `IQ1_M`
/// → `UD-`/`Q8_0` → 回退 `qwen`。注意 `swift` 排在 `UD-` 之前：`SC117/Swift-1.5-…` 的
/// `Swift-1.5-…-IQ3_XXS` 归 swift，而同一个仓库里不带 swift 字样的 `UD-*` 才归 unsloth ——
/// 上游列表里「· Swift」「· Unsloth UD」两条就是这么拆出来的。
fn infer_family(stem: &str, quant: &str) -> Option<&'static str> {
    let lower = stem.to_lowercase();
    let family = if lower.contains("qwen3.6") {
        "qwen36"
    } else if lower.contains("swift") {
        "swift"
    } else if quant == "IQ1_M" {
        "coder"
    } else if quant.starts_with("UD-") || quant == "Q8_0" {
        "unsloth"
    } else {
        "qwen"
    };
    if !setup_supports(family, quant) {
        return None;
    }
    match family {
        // 前四个家族的 setup 分支是按「GSQ-RCO + Flash-Next」写的，别的仓库装不起来
        "qwen" | "swift" | "coder" => lower.contains("gsq-rco"),
        "qwen36" => lower.contains("35b-a3b"),
        _ => lower.contains("flash-next"),
    }
    .then_some(family)
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&text[prefix.len()..])
    } else {
        None
    }
}

/// 上游 `displayName`：`owner · rest`，先摘 `^(Huihui-)?Qwen3.8-Flash-Next-?`，再摘 `[-_]?GGUF$`。
fn display_name(repo: &str) -> String {
    let mut parts = repo.splitn(2, '/');
    let owner = parts.next().unwrap_or(repo);
    let name = parts.next().unwrap_or("");
    let rest = strip_prefix_ci(name, "Huihui-Qwen3.8-Flash-Next-")
        .or_else(|| strip_prefix_ci(name, "Qwen3.8-Flash-Next-"))
        .or_else(|| strip_prefix_ci(name, "Qwen3.8-Flash-Next"))
        .unwrap_or(name);
    let rest = ["-GGUF", "_GGUF", "GGUF"]
        .iter()
        .find_map(|suffix| {
            if rest.len() >= suffix.len() && rest[rest.len() - suffix.len()..].eq_ignore_ascii_case(suffix) {
                Some(&rest[..rest.len() - suffix.len()])
            } else {
                None
            }
        })
        .unwrap_or(rest);
    let short = rest.trim_matches('-');
    if short.is_empty() {
        name.to_string()
    } else {
        format!("{owner} · {short}")
    }
}

/// 上游 `slugOf`：小写、非字母数字折叠成 `-`、去首尾 `-`、截 48、再去尾 `-`、空则 `model`。
fn slug_of(repo: &str) -> String {
    let mut out = String::with_capacity(repo.len());
    let mut last_dash = true;
    for ch in repo.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let mut out = out.trim_matches('-').to_string();
    out.truncate(48);
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "model".to_string()
    } else {
        out
    }
}

fn owner_of(repo: &str) -> &str {
    repo.split('/').next().unwrap_or(repo)
}

/// 分片名尾部 `-00001-of-00002`（调用方已去掉 `.gguf`）。
fn shard_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"-(\d{5})-of-(\d{5})$").expect("分片正则"))
}

fn is_known_repo(repo: &str) -> bool {
    let lower = repo.to_lowercase();
    if KNOWN_REPOS.iter().any(|known| known.to_lowercase() == lower) {
        return true;
    }
    OFFICIAL_OWNERS
        .iter()
        .any(|owner| owner.to_lowercase() == owner_of(repo).to_lowercase())
}

/// 一个树节点：只保留我们要的三个字段。
struct TreeFile {
    path: String,
    size: u64,
    sha256: Option<String>,
}

fn tree_files(value: &Value) -> Vec<TreeFile> {
    let Some(rows) = value.as_array() else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            // 目录节点没有 size/lfs，直接跳过（`type` 字段只有目录与文件两种）
            if row.get("type").and_then(Value::as_str) == Some("directory") {
                return None;
            }
            let path = row.get("path")?.as_str()?.to_string();
            // 上游：只收 `.gguf`，且路径里不能出现 `.` / `..` 段
            if !path.to_lowercase().ends_with(".gguf") {
                return None;
            }
            if path.split('/').any(|part| part == ".." || part == ".") {
                return None;
            }
            // 上游取值顺序：`lfs.size` → `size` → 0
            let size = row
                .get("lfs")
                .and_then(|lfs| lfs.get("size"))
                .and_then(Value::as_u64)
                .or_else(|| row.get("size").and_then(Value::as_u64))
                .unwrap_or(0);
            // 官方 API 给 `sha256:<hex>`，hf-mirror 给裸 64 位 hex —— 两种都要认，
            // 否则镜像下所有分片都被当成「没有校验和」丢掉（社区列表直接空掉）。
            let sha256 = row
                .get("lfs")
                .and_then(|lfs| lfs.get("oid"))
                .and_then(|oid| oid.as_str())
                .map(|oid| oid.strip_prefix("sha256:").unwrap_or(oid))
                .filter(|oid| oid.len() == 64 && oid.chars().all(|ch| ch.is_ascii_hexdigit()))
                .map(|oid| oid.to_string());
            Some(TreeFile { path, size, sha256 })
        })
        .collect()
}

/// 同一目录、同名（去掉分片后缀）的一组 GGUF。
struct ShardGroup {
    stem: String,
    /// 文件名里声明的分片总数（单个文件没有后缀时为 None）
    total: Option<usize>,
    files: Vec<TreeFile>,
}

/// 社区条目的家族顺序（与 `setup.py --family` 的常见顺序一致）。
const FAMILY_ORDER: [&str; 4] = ["qwen", "swift", "coder", "unsloth"];

/// 上游 `SUPPORTED_QUANTS`（`community-catalog.ts:37`）：setup 认的量化名，别的名字一律不进列表。
const SUPPORTED_QUANTS: [&str; 10] = [
    "Q2_0",
    "IQ2_XS",
    "IQ3_XXS",
    "IQ3_S",
    "IQ1_M",
    "UD-IQ4_XS",
    "UD-Q4_K_XL",
    "UD-Q5_K_XL",
    "UD-Q6_K_XL",
    "Q8_0",
];

/// 上游 `ALTERED`：剪枝/蒸馏版换掉了专家结构，引擎认不出。
const ALTERED: [&str; 3] = ["reap", "prun", "distill"];

/// 把 commit 的树解析成社区模型（上游 `communityFromTree` 的移植）：一个仓库按 family
/// 拆成多条，每条只保留「分片齐全、带 sha256、总字节 ≥ 1 GB」的量化。
fn community_from_tree(info: &Value, tree: &Value) -> Vec<CommunityModel> {
    let Some(repo) = info.get("id").and_then(Value::as_str).map(str::to_string) else {
        return Vec::new();
    };
    if !is_repo_id(&repo) {
        return Vec::new();
    }
    let Some(revision) = info.get("sha").and_then(Value::as_str).map(str::to_string) else {
        return Vec::new();
    };
    if !is_revision(&revision) {
        return Vec::new();
    }
    // 剪枝/蒸馏版换掉了专家结构，引擎认不出（上游对仓库名与文件路径各过一遍）
    if ALTERED.iter().any(|word| repo.to_lowercase().contains(word)) {
        return Vec::new();
    }
    let files = tree_files(tree);
    if files.is_empty() {
        return Vec::new();
    }

    let mut vision = false;
    let mut mmproj: Option<String> = None;
    // 目录前缀 + 去分片后缀的 stem → 分片组
    let mut groups: HashMap<String, ShardGroup> = HashMap::new();
    for file in files {
        let name = file.path.rsplit('/').next().unwrap_or("").to_string();
        if name.to_lowercase().starts_with("mmproj") {
            vision = true;
            if mmproj.is_none() {
                mmproj = Some(file.path.clone());
            }
            continue;
        }
        if ALTERED.iter().any(|word| file.path.to_lowercase().contains(word)) {
            continue;
        }
        let prefix = match file.path.rfind('/') {
            Some(index) => file.path[..index].to_string(),
            None => String::new(),
        };
        let full = trim_gguf(&name).to_string();
        // `-00001-of-00003` 后缀告诉我们要几个分片，去掉后才是真正的 stem
        let (stem, total) = match shard_regex().captures(&full) {
            Some(caps) => {
                let matched = caps.get(0).map(|found| found.start()).unwrap_or(full.len());
                let total = caps.get(2).and_then(|value| value.as_str().parse::<usize>().ok());
                (full[..matched].to_string(), total)
            }
            None => (full.clone(), None),
        };
        // 上游在分组前就要求量化在白名单里、且推得出家族
        let Some(quant) = quant_of_stem(&stem) else {
            continue;
        };
        if !SUPPORTED_QUANTS.contains(&quant.as_str()) {
            continue;
        }
        let Some(family) = infer_family(&stem, &quant) else {
            continue;
        };
        // Qwen3.6 的消偏版不走 Strata 的布局，上游直接跳过
        if family == "qwen36" {
            continue;
        }
        let entry = groups
            .entry(format!("{prefix}\u{0}{stem}"))
            .or_insert_with(|| ShardGroup {
                stem,
                total,
                files: Vec::new(),
            });
        if entry.total.is_none() {
            entry.total = total;
        }
        entry.files.push(file);
    }

    // 同一个仓库常常同时提供 qwen / swift / unsloth 三套版本，上游把每条家族都当成
    // 独立条目（列表里能看到「· Swift」「· Unsloth UD」），所以这里按家族分桶。
    let mut by_family: BTreeMap<&'static str, BTreeMap<String, CommunityQuant>> = BTreeMap::new();
    for group in groups.into_values() {
        // 分片必须齐：声明了 N 片就要正好 N 个文件（缺片没法下）
        match group.total {
            Some(total) => {
                if group.files.len() != total || total > 8 {
                    continue;
                }
            }
            None => {
                if group.files.len() != 1 {
                    continue;
                }
            }
        }
        let mut shards = group.files;
        // 按分片序号排（`-00001` 在前），上游用 shard[1] 排序
        shards.sort_by_key(|file| shard_index(&file.path));
        if shards.iter().any(|file| file.sha256.is_none()) {
            continue;
        }
        let bytes: u64 = shards.iter().map(|file| file.size).sum();
        // Unsloth 的首片只是个 ~10 MB 的头部，所以按整组字节数判 1 GB 门槛
        if bytes < 1_000_000_000 {
            continue;
        }
        let Some(quant) = quant_of_stem(&group.stem) else {
            continue;
        };
        let Some(family) = infer_family(&group.stem, &quant) else {
            continue;
        };
        let slot = by_family.entry(family).or_default();
        // 同一个量化的第一套完整分片胜出
        if slot.contains_key(&quant) {
            continue;
        }
        slot.insert(
            quant,
            CommunityQuant {
                download_gb: round1(bytes as f64 / 1e9),
                // 兜底值：上游优先用官方目录里同一量化的内存参考，前端合并时会覆盖这个数
                ram_gb: (bytes / 1_000_000_000 + 10) as u32,
                files: shards
                    .into_iter()
                    .map(|file| CommunityFile {
                        path: file.path,
                        size: file.size,
                        sha256: file.sha256,
                    })
                    .collect(),
            },
        );
    }

    let mut models = Vec::new();
    for family in FAMILY_ORDER {
        let Some(quant_info) = by_family.remove(family) else {
            continue;
        };
        // 量化顺序按 setup 白名单，与上游 `SETUP_FAMILY_QUANTS[family].filter(…)` 一致
        let quants: Vec<String> = family_quants(family)
            .iter()
            .filter(|quant| quant_info.contains_key(**quant))
            .map(|quant| (*quant).to_string())
            .collect();
        if quants.is_empty() {
            continue;
        }
        let suffix = if family == "qwen" {
            String::new()
        } else {
            format!("-{family}")
        };
        let mut base = slug_of(&repo);
        base.truncate(48usize.saturating_sub(suffix.len()));
        while base.ends_with('-') {
            base.pop();
        }
        let slug = format!("{base}{suffix}");
        let label = if family == "qwen" {
            String::new()
        } else if family == "unsloth" {
            " · Unsloth UD".to_string()
        } else {
            format!(" · {}", capital(family))
        };
        models.push(CommunityModel {
            id: format!("hf:{repo}@{family}"),
            slug,
            name: format!("{}{label}", display_name(&repo)),
            repo: repo.clone(),
            revision: revision.clone(),
            family: family.to_string(),
            kind: "gsq-rco".to_string(),
            // 上游：有 mmproj 才算能看图，coder 家族不算
            images: vision && family != "coder",
            quants,
            quant_info,
            mmproj: mmproj.clone(),
            risks: vec!["unverified".into(), "noGuardrails".into()],
            source: "discovered".into(),
            downloads: info.get("downloads").and_then(Value::as_u64),
            likes: info.get("likes").and_then(Value::as_u64),
            updated_at: info
                .get("lastModified")
                .and_then(Value::as_str)
                .map(str::to_string),
        });
    }
    models
}

/// 文件名里的分片序号（`…-00002-of-00003.gguf` → 2），没有后缀算 1。
fn shard_index(path: &str) -> usize {
    let name = path.rsplit('/').next().unwrap_or(path);
    shard_regex()
        .captures(name)
        .and_then(|caps| caps.get(1))
        .and_then(|value| value.as_str().parse::<usize>().ok())
        .unwrap_or(1)
}

/// 去掉文件名结尾的 `.gguf`（大小写不敏感）。
fn trim_gguf(name: &str) -> &str {
    if name.len() >= 5 && name[name.len() - 5..].eq_ignore_ascii_case(".gguf") {
        &name[..name.len() - 5]
    } else {
        name
    }
}

/// 上游 `isRepoId`：`owner/name` 两段，各段首字符是字母数字，后面只允许 `.` `_` `-`。
fn is_repo_id(repo: &str) -> bool {
    if repo.contains("..") {
        return false;
    }
    let mut parts = repo.split('/');
    let (Some(owner), Some(name)) = (parts.next(), parts.next()) else {
        return false;
    };
    if parts.next().is_some() {
        return false;
    }
    [owner, name].iter().all(|part| {
        !part.is_empty()
            && part.len() <= 96
            && part.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric())
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    })
}

/// 上游 `isRevision`：40 位小写十六进制。
fn is_revision(revision: &str) -> bool {
    revision.len() == 40 && revision.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn curl_command() -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("curl.exe");
        command.creation_flags(0x0800_0000);
        command
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("curl")
    }
}

/// GET 一个 JSON。请求体/响应体都走临时文件（Windows 命令行长度与代码页都不友好）。
fn fetch_json(url: &str) -> Result<Value, String> {
    let dir = std::env::temp_dir();
    let stamp = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    );
    let body_path = dir.join(format!("llamacpp-hf-{stamp}.json"));
    if let Err(error) = fs::write(&body_path, b"") {
        return Err(format!("建临时文件失败（{}）：{error}", body_path.display()));
    }
    let output = curl_command()
        .args([
            "-sS",
            "-L",
            "--compressed",
            "--max-time",
            "40",
            "--connect-timeout",
            "10",
            "-A",
            FETCH_UA,
            "-H",
            "accept: application/json",
            "-o",
        ])
        .arg(&body_path)
        .args(["-w", "%{http_code}", url])
        .output();
    let result = match output {
        Ok(output) => {
            let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if status.starts_with('2') {
                let text = fs::read_to_string(&body_path).unwrap_or_default();
                serde_json::from_str(&text).map_err(|error| format!("解析 {url} 的 JSON 失败：{error}"))
            } else {
                let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
                Err(format!("请求 {url} 失败（HTTP {status}）{detail}"))
            }
        }
        Err(error) => Err(format!("启动 curl 失败：{error}")),
    };
    let _ = fs::remove_file(&body_path);
    result
}

fn api(base: &str, path: &str) -> String {
    format!("{}/api/{path}", base.trim_end_matches('/'))
}

/// 默认的接口站点：本机直连 `huggingface.co` 会超时（实测 curl 28），
/// `hf-mirror.com` 可正常返回同名 API；用户在下载配置里填了镜像就用用户的。
const DEFAULT_BASE: &str = "https://hf-mirror.com";

/// 拉一次发现结果（不做缓存判断）。
fn discover(base: &str) -> Result<Vec<CommunityModel>, String> {
    let mut seen: Vec<String> = Vec::new();
    let mut candidates: Vec<Value> = Vec::new();
    let mut failures = 0;
    for term in SEARCHES {
        let url = api(
            base,
            &format!("models?search={term}&filter=gguf&sort=downloads&direction=-1&limit=40"),
        );
        match fetch_json(&url) {
            Ok(value) => {
                let rows = value.as_array().cloned().unwrap_or_default();
                for row in rows {
                    let Some(id) = row.get("id").and_then(Value::as_str) else {
                        continue;
                    };
                    if !is_repo_id(id) || is_known_repo(id) || seen.iter().any(|known| known == id) {
                        continue;
                    }
                    seen.push(id.to_string());
                    candidates.push(row);
                }
            }
            Err(error) => {
                failures += 1;
                if failures == SEARCHES.len() {
                    return Err(error);
                }
            }
        }
    }
    candidates.sort_by(|left, right| {
        let a = left.get("downloads").and_then(Value::as_u64).unwrap_or(0);
        let b = right.get("downloads").and_then(Value::as_u64).unwrap_or(0);
        b.cmp(&a)
    });
    candidates.truncate(MAX_CANDIDATES);

    let mut entries = Vec::new();
    for candidate in candidates {
        let Some(id) = candidate.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Ok(info) = fetch_json(&api(base, &format!("models/{id}"))) else {
            continue;
        };
        let Some(sha) = info.get("sha").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        if !is_revision(&sha) {
            continue;
        }
        // 上游要求详情里的 id 与候选一致（镜像可能重定向到别的仓库）
        if info.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        let Ok(tree) = fetch_json(&api(base, &format!("models/{id}/tree/{sha}?recursive=true")))
        else {
            continue;
        };
        let mut merged = info.clone();
        // info 里的 downloads/likes 比搜索结果可靠，缺了才回填
        if merged.get("downloads").is_none() {
            if let Some(value) = candidate.get("downloads") {
                merged["downloads"] = value.clone();
            }
        }
        if merged.get("likes").is_none() {
            if let Some(value) = candidate.get("likes") {
                merged["likes"] = value.clone();
            }
        }
        entries.extend(community_from_tree(&merged, &tree));
    }
    Ok(entries)
}

fn cache_path() -> Option<std::path::PathBuf> {
    let base = std::env::var("APPDATA").ok()?;
    let dir = std::path::PathBuf::from(base).join("llamacpp-gui");
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("community-cache.json"))
}

fn read_disk_cache() -> Option<Cache> {
    let path = cache_path()?;
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_disk_cache(cache: &Cache) {
    let Some(path) = cache_path() else {
        return;
    };
    let Ok(text) = serde_json::to_string(cache) else {
        return;
    };
    if let Ok(mut file) = fs::File::create(path) {
        let _ = file.write_all(text.as_bytes());
    }
}

fn cache_to_entries(cache: &Cache) -> Vec<CommunityModel> {
    cache
        .entries
        .iter()
        .filter_map(|value| serde_json::from_value::<CommunityModel>(value.clone()).ok())
        .collect()
}

fn entries_to_values(entries: &[CommunityModel]) -> Vec<Value> {
    entries
        .iter()
        .filter_map(|entry| serde_json::to_value(entry).ok())
        .collect()
}

/// 前端切到「社区」时调用。`force` = 用户点了刷新；`endpoint` = 下载配置里的 HF 镜像。
pub fn discover_community(force: bool, endpoint: Option<String>) -> Discovery {
    let fresh_enough = |at: u64| now_ms().saturating_sub(at) < CACHE_TTL_MS;
    let base = endpoint
        .as_deref()
        .map(str::trim)
        .filter(|value| value.starts_with("http"))
        .unwrap_or(DEFAULT_BASE)
        .trim_end_matches('/')
        .to_string();

    if !force {
        if let Ok(slot) = cache_slot().lock() {
            if let Some(cache) = slot.as_ref() {
                if cache.base == base && fresh_enough(cache.fetched_at) {
                    return Discovery {
                        entries: cache_to_entries(cache),
                        state: "cached".into(),
                        fetched_at: Some(cache.fetched_at),
                        error: None,
                    };
                }
            }
        }
        if let Some(cache) = read_disk_cache() {
            // 空缓存不算数：早期版本解析不出分片校验和时会把空结果存进去，
            // 24 小时内都不再请求，界面就一直是空的。
            if cache.base == base && fresh_enough(cache.fetched_at) && !cache.entries.is_empty() {
                let entries = cache_to_entries(&cache);
                if let Ok(mut slot) = cache_slot().lock() {
                    *slot = Some(cache.clone());
                }
                return Discovery {
                    entries,
                    state: "cached".into(),
                    fetched_at: Some(cache.fetched_at),
                    error: None,
                };
            }
        }
    }

    match discover(&base) {
        Ok(entries) => {
            let cache = Cache {
                base: base.clone(),
                fetched_at: now_ms(),
                entries: entries_to_values(&entries),
            };
            if let Ok(mut slot) = cache_slot().lock() {
                *slot = Some(cache.clone());
            }
            write_disk_cache(&cache);
            Discovery {
                entries,
                state: "fresh".into(),
                fetched_at: Some(cache.fetched_at),
                error: None,
            }
        }
        Err(error) => {
            // 失败时退回旧缓存，前端据此显示「缓存数据」而不是空列表
            let stale = cache_slot()
                .lock()
                .ok()
                .and_then(|slot| slot.clone())
                .or_else(read_disk_cache);
            match stale {
                Some(cache) => Discovery {
                    entries: cache_to_entries(&cache),
                    state: "stale".into(),
                    fetched_at: Some(cache.fetched_at),
                    error: Some(error),
                },
                None => Discovery {
                    entries: Vec::new(),
                    state: "offline".into(),
                    fetched_at: None,
                    error: Some(error),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tree(rows: Value) -> Value {
        rows
    }

    #[test]
    fn mixed_family_repo_splits_into_entries() {
        // 同一个仓库同时挂 qwen / swift / unsloth 三套权重时，上游列表里是三条独立条目
        let info = json!({
            "id": "huihui-ai/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF",
            "sha": "eec4e10a2c29b440a2ae85591fa11569ce752963",
            "downloads": 100
        });
        let tree = tree(json!([
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS.gguf",
             "size": 47000000000u64, "lfs": {"oid": "sha256:eec4e10a2c29b440a2ae85591fa11569ce752963000000000000000000000000"}},
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-Swift-1.5-IQ3_XXS.gguf",
             "size": 46000000000u64, "lfs": {"oid": "sha256:d4af3be5701549435e0770d625f79dd2def1358f000000000000000000000000"}},
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-Unsloth-UD-Q4_K_XL.gguf",
             "size": 93000000000u64, "lfs": {"oid": "sha256:34252ecfc8a553ec89b29cf98193f158e97af2ab000000000000000000000000"}}
        ]));
        let models = community_from_tree(&info, &tree);
        assert_eq!(models.len(), 3, "三个家族该拆成三条：{models:?}");
        let families: Vec<&str> = models.iter().map(|model| model.family.as_str()).collect();
        assert!(families.contains(&"qwen"));
        assert!(families.contains(&"swift"));
        assert!(families.contains(&"unsloth"));
        let swift = models.iter().find(|model| model.family == "swift").expect("swift");
        assert_eq!(swift.quants, vec!["IQ3_XXS".to_string()]);
        assert!(swift.slug.ends_with("-swift"), "slug 要能区分同仓库的不同家族：{}", swift.slug);
        let unsloth = models.iter().find(|model| model.family == "unsloth").expect("unsloth");
        assert_eq!(unsloth.quants, vec!["UD-Q4_K_XL".to_string()]);
        assert!(unsloth.name.ends_with("Unsloth UD"), "{}", unsloth.name);
    }

    #[test]
    fn quant_names_follow_setup_spelling() {
        assert_eq!(quant_of_stem("qwen3.8-iq3_xxs").as_deref(), Some("IQ3_XXS"));
        assert_eq!(quant_of_stem("qwen3.8-ud-q4_k_xl").as_deref(), Some("UD-Q4_K_XL"));
        assert_eq!(quant_of_stem("qwen3.8-q2_0").as_deref(), Some("Q2_0"));
        assert_eq!(quant_of_stem("qwen3.8-f16").as_deref(), Some("F16"));
        assert_eq!(quant_of_stem("tokenizer"), None);
    }

    #[test]
    fn sharded_community_repo_is_parsed() {
        let info = json!({
            "id": "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF",
            "sha": "eec4e10a2c29b440a2ae85591fa11569ce752963",
            "downloads": 1950149,
            "likes": 332
        });
        let tree = tree(json!([
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf",
             "size": 40000000000u64, "lfs": {"oid": "sha256:eec4e10a2c29b440a2ae85591fa11569ce752963000000000000000000000000"}},
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00002-of-00002.gguf",
             "size": 10000000000u64, "lfs": {"oid": "sha256:d4af3be5701549435e0770d625f79dd2def1358f000000000000000000000000"}},
            {"path": "mmproj-Qwen3.8-Flash-Next-BF16.gguf", "size": 900000000u64,
             "lfs": {"oid": "sha256:34252ecfc8a553ec89b29cf98193f158e97af2ab000000000000000000000000"}}
        ]));
        let models = community_from_tree(&info, &tree);
        assert_eq!(models.len(), 1, "单一家族只该拆出一条");
        let model = &models[0];
        assert_eq!(model.family, "qwen");
        assert_eq!(model.quants, vec!["IQ3_XXS".to_string()]);
        let quant = model.quant_info.get("IQ3_XXS").expect("IQ3_XXS");
        assert_eq!(quant.files.len(), 2);
        assert_eq!(quant.download_gb, 50.0);
        assert!(model.images, "有 mmproj 就算支持图像");
    }

    #[test]
    fn missing_shard_drops_the_quant() {
        let info = json!({
            "id": "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF",
            "sha": "eec4e10a2c29b440a2ae85591fa11569ce752963"
        });
        let tree = tree(json!([
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-abliterated-IQ3_XXS-00001-of-00002.gguf",
             "size": 40000000000u64, "lfs": {"oid": "sha256:eec4e10a2c29b440a2ae85591fa11569ce752963000000000000000000000000"}}
        ]));
        assert!(community_from_tree(&info, &tree).is_empty());
    }

    #[test]
    fn pruned_repos_are_skipped() {
        let info = json!({
            "id": "someone/Qwen3.8-Flash-Next-GSQ-RCO-reap-GGUF",
            "sha": "eec4e10a2c29b440a2ae85591fa11569ce752963"
        });
        let tree = tree(json!([
            {"path": "Qwen3.8-Flash-Next-GSQ-RCO-reap-IQ3_XXS.gguf", "size": 47000000000u64,
             "lfs": {"oid": "sha256:eec4e10a2c29b440a2ae85591fa11569ce752963000000000000000000000000"}}
        ]));
        assert!(community_from_tree(&info, &tree).is_empty());
    }

    #[test]
    #[ignore = "联网：需要能访问 HF 镜像"]
    fn live_discovery_reports_entries() {
        let entries = discover(super::DEFAULT_BASE).expect("应当能发现社区模型");
        println!("共 {} 条：", entries.len());
        for entry in &entries {
            println!("  {} | {} | {} | {:?}", entry.family, entry.name, entry.slug, entry.quants);
        }
        assert!(!entries.is_empty());
    }

    #[test]
    fn official_owners_are_not_community() {
        assert!(is_known_repo("ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF"));
        assert!(is_known_repo("orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF"));
        // SC117 是内置条目本身，所以它算「已知」，不该重复出现在发现结果里
        assert!(is_known_repo("SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF"));
        assert!(!is_known_repo("acme/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF"));
    }
}
