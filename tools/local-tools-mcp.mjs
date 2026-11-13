#!/usr/bin/env node
// GUI 的本地 MCP 服务器（stdio，MCP 2024-11-05）—— 通用本机工具，不绑定任何具体软件。
//
// 为什么需要它：GUI 聊天原来只有 web_search / web_fetch 两个工具，问「这个可执行文件支持
// 哪些参数」「某个版本的帮助文本」「某段源码怎么写的」时模型只能上网搜或凭印象编。这台
// 服务器把本机读取、只读查询，以及一个受控的写工作区交给模型。
//
// 通用性约定：
// - `list_dir` 列用户指定的目录（path 必填，不许猜）。
// - `read_text_file` 读任意文本文件（任何编程语言源码、配置、日志、文档），不限扩展名。
// - `run_help` 查任意可执行文件的 --help / --version（不限某个程序，python / node /
//   git / cargo / 任意 .exe 都行），支持按关键字过滤帮助文本。
// - `run_readonly` 执行只读参数（--help / -h / --version / -v / --list-* 等）；不经 shell，
//   所以 `>`、`|`、`;` 不会被解释。
//
// 写工作区（按会话隔离的沙箱）：
// - 沙箱根固定为 `<GUI 目录>/tmp`（可用环境变量 LOCAL_TOOLS_ROOT 覆盖 GUI 目录），第一次
//   写入时自动创建；每个会话再落到 `tmp/<会话 id>/`（会话 id 由 GUI 在 tools/call 的
//   `_meta.sessionId` 里传入，删会话时 GUI 把该子目录一起删掉）。
// - `write_file` / `edit_file` / `delete_file` / `run_file` 的 path 都相对当前会话目录解析；
//   绝对路径必须落在里面，`..` 越界、符号链接逃出、删会话目录本身一律拒绝。
// - 读文件（read_text_file）不受沙箱限制，保持「读全盘源码」的能力；写与执行只在会话目录内。
// - 执行脚本时再套一层运行时约束，尽量让「脚本本身」也改不了会话目录外的东西：
//   · .js/.mjs/.cjs 用 Node 权限模型（--permission + --allow-fs-write=<会话目录>，读不限）；
//   · .py 注入 sitecustomize 守卫，拦截会话目录外的 open(w)/os.remove/os.rename/shutil.rmtree；
//   · .ps1 执行前静态扫描写/删命令，命中就拒绝（PowerShell 没有等价的运行时钩子）；
//   · .exe 是原生程序，应用层无法限制它的文件访问 —— 只建议执行自己编译/可信的程序，
//     输出里会带一行提醒。
//
// 行为约定：路径与程序名只从用户消息或对话上下文里取；用户没给就先问，不要拿默认目录或
// 随便挑一个程序去猜 —— 无参调用 list_dir 会直接报错。
//
// 由 GUI 的聊天设置以 stdio 子进程拉起（mcp.json），不要脱离 GUI 单独用。

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "local-tools";
const SERVER_VERSION = "3.5.0";

const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINES = 400;
const WRITE_MAX_CHARS = 1_000_000;
const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_TIMEOUT_MS = 300_000;
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const OUTPUT_MAX_CHARS = 20_000;
/** 会话目录兜底保留天数：异常退出没删掉的 tmp/<会话 id> 超过这么久没动过就清掉。 */
const TMP_RETENTION_DAYS = 30;

/** 默认工作目录：服务器进程的启动目录（只作为执行程序的 cwd，不用来猜用户想看的目录）。 */
const DEFAULT_CWD = process.cwd();

/** 沙箱：GUI 目录下的 tmp 子目录（用户要求「允许在 gui 目录下创建 tmp 文件夹」）。 */
const WORKSPACE_ROOT = process.env.LOCAL_TOOLS_ROOT || process.cwd();
const SANDBOX_ROOT = path.resolve(WORKSPACE_ROOT, "tmp");

/**
 * 当前会话 id —— GUI 在每次 tools/call 的 `params._meta.sessionId` 里传入。
 * 每个会话在 tmp 下有独立子目录（tmp/<会话 id>），删会话时由 GUI 一起删掉。
 */
let activeSession = null;

/** 会话 id 只接受字母数字与 - _（它要当目录名用，别放路径片段进来）。 */
function sessionName(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** 工具实际操作目录：tmp/<会话 id>；没有会话信息时退到 tmp/_shared（不阻断只读/脚本执行）。 */
function sandboxRoot() {
  return path.join(SANDBOX_ROOT, activeSession ?? "_shared");
}

/** 通用的「只读」参数：查帮助、查版本、列设备/列表。 */
const READONLY_FLAGS = new Set([
  "--help",
  "-h",
  "-help",
  "--version",
  "-v",
  "-V",
  "-version",
  "--list-devices",
  "/?",
  "-?",
]);

/** 专用只读程序（按可执行文件名判断，参数另有约束）。 */
const READONLY_PROGRAMS = new Set(["nvidia-smi.exe", "tasklist.exe", "where.exe", "node.exe"]);

// ---------------------------------------------------------------- 路径与文本

/** 把用户给的路径规范化成绝对路径（不设白名单，仅统一分隔符与 . / ..）。 */
function resolvePath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return path.resolve(raw.trim());
}

function fail(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function ok(text) {
  return { content: [{ type: "text", text }] };
}

function isBinary(buffer) {
  const sample = buffer.subarray(0, 4096);
  for (const byte of sample) if (byte === 0) return true;
  return false;
}

function humanSize(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

/** 把看起来像密钥的值打码（设置文件里存着各服务的 api_key）。 */
function redactSecrets(text) {
  return text
    .replace(/("(?:api[_-]?key|token|secret|password|authorization|key)"\s*:\s*")([^"]{4,})(")/gi, "$1***$3")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-***");
}

function clipOutput(text, limit = OUTPUT_MAX_CHARS) {
  const trimmed = text.trimEnd();
  return trimmed.length > limit
    ? `${trimmed.slice(0, limit)}\n…（输出共 ${trimmed.length} 字符，已截断）`
    : trimmed;
}

/** 控制台程序在中文 Windows 上常按 GBK 输出；UTF-8 解出替换字符时回退到 GBK。 */
function decodeOutput(buffer) {
  const utf8 = buffer.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return utf8;
  }
}

// ---------------------------------------------------------------- 沙箱（只允许 <GUI 目录>/tmp）

function withinSandbox(absolute) {
  const root = path.resolve(sandboxRoot());
  const target = path.resolve(absolute);
  const same = process.platform === "win32" ? root.toLowerCase() === target.toLowerCase() : root === target;
  if (same) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return process.platform === "win32"
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

function ensureSandbox() {
  const root = sandboxRoot();
  mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 启动时清理 tmp 里的临时文件（用户：临时文件应该清理）。
 * - 每次清：`__pycache__` 目录与 `.pyc`（Python 缓存，删了下次自动重建）；
 * - 会话目录兜底：超过 TMP_RETENTION_DAYS 天没动过的 `tmp/<会话 id>` 整目录删掉
 *   （正常删会话时 GUI 会调 MCP 之外的命令立刻删，这里只收拾异常退出留下的）。
 * 会话目录里的“临时测试代码”随会话目录一起消失；最近用过的不动。
 */
function cleanSandbox() {
  if (!existsSync(SANDBOX_ROOT)) return 0;
  const cutoff = Date.now() - TMP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  const purgeCache = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          if (entry.name === "__pycache__") {
            rmSync(full, { recursive: true, force: true });
            removed += 1;
            continue;
          }
          purgeCache(full);
          continue;
        }
        if (entry.name.endsWith(".pyc")) {
          unlinkSync(full);
          removed += 1;
        }
      } catch {
        // 单个文件删不掉（被占用/权限）就跳过，不影响启动
      }
    }
  };
  purgeCache(SANDBOX_ROOT);
  let sessions;
  try {
    sessions = readdirSync(SANDBOX_ROOT, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of sessions) {
    if (!entry.isDirectory() || !sessionName(entry.name)) continue;
    const full = path.join(SANDBOX_ROOT, entry.name);
    try {
      if (statSync(full).mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // 被占用就跳过
    }
  }
  return removed;
}

/**
 * 校验沙箱内的路径：相对路径按沙箱根解析，绝对路径必须在沙箱内。
 * 已存在的路径（或其父目录）再用 realpath 复核一次，防符号链接逃出。
 */
function resolveSandboxPath(raw, { allowRoot = false } = {}) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: "缺少 path（相对沙箱根或沙箱内的绝对路径）。" };
  }
  const root = path.resolve(sandboxRoot());
  const absolute = path.resolve(root, raw.trim());
  if (!allowRoot && absolute === root) {
    return { error: `path 必须指向沙箱内的文件或子目录：${root}` };
  }
  if (!withinSandbox(absolute)) {
    return {
      error: `拒绝访问：${absolute} 不在沙箱目录 ${root} 内 —— 只允许创建、编辑、删除、执行这个 tmp 目录里的文件。`,
    };
  }
  // 目标已存在：解析真实路径，挡住指向沙箱外的符号链接/目录联接。
  if (existsSync(absolute)) {
    try {
      const real = realpathSync(absolute);
      if (!withinSandbox(real)) {
        return { error: `拒绝访问：${absolute} 实际指向 ${real}，在沙箱目录外。` };
      }
    } catch {
      // realpath 失败就交给后面的读写操作报错
    }
  }
  return { path: absolute };
}

// ---------------------------------------------------------------- 脚本运行时守卫

/** Node 权限模型参数：读不限，写只允许沙箱；顺带禁掉 child_process（不让脚本再起进程绕过）。 */
function nodePermissionArgs() {
  const major = Number(process.versions.node.split(".")[0]) || 0;
  const flag = major >= 22 ? "--permission" : "--experimental-permission";
  return [flag, "--allow-fs-read=*", `--allow-fs-write=${sandboxRoot()}`];
}

/** Python 守卫目录与源码（sitecustomize 由解释器自动导入）。 */
const PYTHON_GUARD_DIR = path.join(SANDBOX_ROOT, "_guard");

const PYTHON_GUARD_SOURCE = `# 由 local-tools-mcp 生成：只允许写/删沙箱目录内的文件。
import builtins
import io
import os
import shutil

_SANDBOX = os.environ.get("LOCAL_TOOLS_SANDBOX") or ""


def _inside(path):
    if not _SANDBOX:
        return True
    try:
        real = os.path.realpath(os.fspath(path))
        root = os.path.realpath(_SANDBOX)
        return os.path.commonpath([root, real]) == root
    except (TypeError, ValueError):
        return False


def _deny(action, path):
    raise PermissionError(
        "沙箱拒绝：" + action + " 只能操作 " + _SANDBOX + " 内的文件，当前路径 " + str(path)
    )


_real_open = builtins.open


def _guard_open(file, mode="r", *args, **kwargs):
    if isinstance(mode, str) and any(ch in mode for ch in "wax+") and not _inside(file):
        _deny("open(写)", file)
    return _real_open(file, mode, *args, **kwargs)


builtins.open = _guard_open
io.open = _guard_open

for _name in ("remove", "unlink", "rmdir", "removedirs"):
    _real = getattr(os, _name, None)
    if _real is None:
        continue

    def _make(action, func):
        def _guard(path, *args, **kwargs):
            if not _inside(path):
                _deny(action, path)
            return func(path, *args, **kwargs)
        return _guard

    setattr(os, _name, _make("os." + _name, _real))

_real_rename = os.rename


def _guard_rename(src, dst, *args, **kwargs):
    if not _inside(src) or not _inside(dst):
        _deny("os.rename", src if not _inside(src) else dst)
    return _real_rename(src, dst, *args, **kwargs)


os.rename = _guard_rename
_real_replace = os.replace


def _guard_replace(src, dst, *args, **kwargs):
    if not _inside(src) or not _inside(dst):
        _deny("os.replace", src if not _inside(src) else dst)
    return _real_replace(src, dst, *args, **kwargs)


os.replace = _guard_replace
_real_mkdir = os.mkdir


def _guard_mkdir(path, *args, **kwargs):
    if not _inside(path):
        _deny("os.mkdir", path)
    return _real_mkdir(path, *args, **kwargs)


os.mkdir = _guard_mkdir
_real_makedirs = os.makedirs


def _guard_makedirs(path, *args, **kwargs):
    if not _inside(path):
        _deny("os.makedirs", path)
    return _real_makedirs(path, *args, **kwargs)


os.makedirs = _guard_makedirs
_real_rmtree = shutil.rmtree


def _guard_rmtree(path, *args, **kwargs):
    if not _inside(path):
        _deny("shutil.rmtree", path)
    return _real_rmtree(path, *args, **kwargs)


shutil.rmtree = _guard_rmtree
`;

function ensurePythonGuard() {
  mkdirSync(PYTHON_GUARD_DIR, { recursive: true });
  const file = path.join(PYTHON_GUARD_DIR, "sitecustomize.py");
  const wanted = PYTHON_GUARD_SOURCE;
  let current = "";
  try {
    current = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch {
    current = "";
  }
  if (current !== wanted) writeFileSync(file, wanted, "utf8");
  return PYTHON_GUARD_DIR;
}

/** PowerShell 写/删/移动命令：PowerShell 没有运行时可钩的 API，只能靠静态扫描拦住。 */
const POWERSHELL_WRITE_RE =
  /(?:\bRemove-Item\b|\bRemove-ItemProperty\b|\bClear-Content\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bNew-Item\b|\bMove-Item\b|\bRename-Item\b|\bSet-ItemProperty\b|\bCopy-Item\b|\bExpand-Archive\b|\bCompress-Archive\b|(?:^|[\s;|&(])(?:del|erase|rmdir|rd)\s)/i;

function checkPowerShell(absolute) {
  let source;
  try {
    source = readFileSync(absolute).toString("utf8");
  } catch (error) {
    return `读不了脚本 ${absolute}：${error.message}`;
  }
  if (POWERSHELL_WRITE_RE.test(source)) {
    return (
      "拒绝执行：PowerShell 脚本里出现了写 / 删 / 移动命令（Remove-Item、Set-Content、Out-File、Move-Item、New-Item 等）。" +
      "PowerShell 没有可注入的运行时守卫，无法保证它只改沙箱内的文件。要写文件请用 write_file / edit_file，" +
      "或把逻辑改写成 .js / .py（这两种有运行时守卫，只能写沙箱）。"
    );
  }
  return null;
}

// ---------------------------------------------------------------- 工具实现

function toolListDir(args) {
  const absolute = resolvePath(args.path);
  if (!absolute) {
    return fail("缺少 path：请先问用户要列出哪个目录（比如项目根目录或具体路径），不要猜目录、也不要用默认目录。");
  }
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    return fail(`打不开目录 ${absolute}：${error.message}`);
  }
  const rows = entries.slice(0, 300).map((entry) => {
    const full = path.join(absolute, entry.name);
    if (entry.isDirectory()) return `[目录] ${entry.name}`;
    try {
      const stat = statSync(full);
      return `${humanSize(stat.size).padStart(10)}  ${stat.mtime.toISOString().slice(0, 16).replace("T", " ")}  ${entry.name}`;
    } catch {
      return `            ${entry.name}`;
    }
  });
  const more = entries.length > rows.length ? `\n（另有 ${entries.length - rows.length} 项未列出）` : "";
  return ok(`${absolute}（${entries.length} 项）\n${rows.join("\n")}${more}`);
}

/** `--help` 太长时按 filter 过滤或截断；filter 命中行连同前后各一行一起返回。 */
function clipHelp(out, filter) {
  const text = out.trimEnd();
  if (typeof filter === "string" && filter.trim() !== "") {
    const needle = filter.trim().toLowerCase();
    const lines = text.split(/\r?\n/);
    const hits = [];
    lines.forEach((line, index) => {
      if (!line.toLowerCase().includes(needle)) return;
      for (let i = Math.max(0, index - 1); i < Math.min(lines.length, index + 2); i += 1) {
        if (!hits.includes(i)) hits.push(i);
      }
    });
    hits.sort((a, b) => a - b);
    if (hits.length === 0) return `没有包含「${filter}」的行。`;
    const body = hits.map((i) => `${String(i + 1).padStart(5)}  ${lines[i]}`).join("\n");
    return `（按「${filter}」过滤，命中 ${hits.length} 行）\n${body}`;
  }
  if (text.length > OUTPUT_MAX_CHARS) {
    return `${text.slice(0, OUTPUT_MAX_CHARS)}\n…（帮助文本共 ${text.length} 字符，已截断；可以传 filter 只取相关行）`;
  }
  return text;
}

/** 解析 program：带路径分隔符按绝对路径；纯名字交给 PATH 查找。 */
function resolveProgram(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const program = raw.trim();
  const hasSeparator = program.includes("\\") || program.includes("/");
  if (hasSeparator) {
    const absolute = path.resolve(program);
    return existsSync(absolute) ? absolute : null;
  }
  // 纯名字：Windows 上补 .exe 再交给 PATH（spawnSync 自己解析）。
  return program;
}

/** 跑只读命令并合并 stdout + stderr（不少程序把 --version 写在 stderr 上）。 */
function runReadonly(absolute, flags, cwd = DEFAULT_CWD, timeout = EXEC_TIMEOUT_MS) {
  const started = Date.now();
  const result = spawnSync(absolute, flags, {
    cwd,
    shell: false,
    encoding: "buffer",
    timeout,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  const elapsed = Date.now() - started;
  if (result.error) return { error: result.error.message, text: "", elapsed, status: null };
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  const text = `${decodeOutput(stdout)}${stdout.length > 0 && stderr.length > 0 ? "\n" : ""}${decodeOutput(stderr)}`;
  if (result.status !== 0 && text.trim() === "") {
    return { error: `退出码 ${result.status}`, text: "", elapsed, status: result.status };
  }
  return { error: "", text, elapsed, status: result.status };
}

/** 通用的帮助/版本查询：任意程序 + 只读参数。 */
function toolRunHelp(args) {
  const program = resolveProgram(args.program);
  if (!program) return fail("缺少 program（要查的可执行文件完整路径或名字，例如 git、python、node）。");
  const flags = Array.isArray(args.args) && args.args.length > 0
    ? args.args.map((item) => String(item))
    : ["--help"];
  if (!isReadonlyInvocation(program, flags)) {
    return fail(
      `拒绝执行：${program} ${flags.join(" ")}\n` +
        "只允许只读参数：--help / -h / --version / -v / -V / --list-* 等。查具体参数请先跑 --help，再传 filter 过滤。",
    );
  }
  if (!existsSyncProgram(program)) return fail(`找不到可执行文件：${program}`);
  const cwd = typeof args.cwd === "string" && args.cwd.trim() !== "" ? path.resolve(args.cwd.trim()) : DEFAULT_CWD;
  const timeout = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(args.timeout_ms, EXEC_MAX_TIMEOUT_MS)
    : EXEC_TIMEOUT_MS;
  const { error, text, status } = runReadonly(program, flags, cwd, timeout);
  if (error && text.trim() === "") {
    return fail(`${program} ${flags.join(" ")} 执行失败：${error}`);
  }
  return ok(`${path.basename(program)} ${flags.join(" ")}（工作目录 ${cwd} · 退出码 ${status}）\n\n${clipHelp(text, args.filter)}`);
}

/** 有路径分隔符但不存在时，spawnSync 才会报错；纯名字交给 PATH。 */
function existsSyncProgram(program) {
  return program.includes("\\") || program.includes("/") ? existsSync(program) : true;
}

function toolReadTextFile(args) {
  const absolute = resolvePath(args.path);
  if (!absolute) return fail("缺少 path（要读的文件）。");
  let buffer;
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return fail(`${absolute} 不是文件。`);
    buffer = readFileSync(absolute);
  } catch (error) {
    return fail(`读不了 ${absolute}：${error.message}`);
  }
  if (isBinary(buffer)) return fail(`${absolute} 看起来是二进制文件（${humanSize(buffer.length)}），不读。`);
  const truncated = buffer.length > READ_MAX_BYTES;
  const bytes = truncated ? buffer.subarray(0, READ_MAX_BYTES) : buffer;
  const all = bytes.toString("utf8").split(/\r?\n/);
  const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, READ_MAX_LINES) : READ_MAX_LINES;
  const slice = all.slice(offset - 1, offset - 1 + limit);
  const numbered = slice.map((line, index) => `${String(offset + index).padStart(5)}  ${line}`).join("\n");
  const notes = [];
  if (offset + slice.length - 1 < all.length) notes.push(`还有 ${all.length - (offset + slice.length - 1)} 行，传 offset=${offset + slice.length} 继续`);
  if (truncated) notes.push(`文件超过 ${humanSize(READ_MAX_BYTES)}，只读了前 ${humanSize(READ_MAX_BYTES)}`);
  return ok(`${absolute}（共 ${all.length} 行${truncated ? "，已截断" : ""}）\n${redactSecrets(numbered)}${notes.length ? `\n\n（${notes.join("；")}）` : ""}`);
}

function toolRunReadonly(args) {
  const raw = typeof args.program === "string" ? args.program.trim() : "";
  if (!raw) return fail("缺少 program（可执行文件完整路径，或 nvidia-smi / tasklist / where / node 这类名字）。");
  const program = resolveProgram(raw);
  if (!program) return fail(`找不到可执行文件：${raw}`);
  const flags = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
  if (!existsSyncProgram(program)) return fail(`找不到可执行文件：${program}`);
  if (!isReadonlyInvocation(program, flags)) {
    return fail(
      `拒绝执行：${program} ${flags.join(" ")}\n` +
        "只允许只读参数：--help / -h / --version / -v / -V / --list-*，以及 nvidia-smi（显存查询）、" +
        "tasklist（看进程）、where（查路径）、node -v。任何写文件、删文件、改配置的操作都不允许。",
    );
  }
  const cwd = typeof args.cwd === "string" && args.cwd.trim() !== "" ? path.resolve(args.cwd.trim()) : DEFAULT_CWD;
  const timeout = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(args.timeout_ms, EXEC_MAX_TIMEOUT_MS)
    : EXEC_TIMEOUT_MS;

  const started = Date.now();
  const result = spawnSync(program, flags, {
    cwd,
    shell: false,
    encoding: "buffer",
    timeout,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  const elapsed = Date.now() - started;
  const name = path.basename(program);
  if (result.error) {
    return fail(`执行失败（${elapsed} ms，工作目录 ${cwd}）：${result.error.message}`);
  }
  const stdout = decodeOutput(result.stdout ?? Buffer.alloc(0));
  const stderr = decodeOutput(result.stderr ?? Buffer.alloc(0));
  const body = [stdout, stderr].filter((part) => part.trim() !== "").join("\n[stderr]\n");
  const header = `$ ${name} ${flags.join(" ")}\n工作目录 ${cwd} · 退出码 ${result.status} · ${elapsed} ms`;
  return ok(`${header}\n\n${clipOutput(redactSecrets(body))}`);
}

/** 只读调用判定：任意程序 + 只读参数；专用只读程序另有参数约束；不经 shell。 */
function isReadonlyInvocation(program, flags) {
  const name = path.basename(program).toLowerCase();
  const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
  if (flags.length === 0) return false;
  // 通用：任意程序，参数全在通用只读集合（或 --list-* 形式）。
  if (flags.every((flag) => READONLY_FLAGS.has(flag) || flag.startsWith("--list-"))) return true;
  if (!READONLY_PROGRAMS.has(exe)) return false;
  if (exe === "nvidia-smi.exe") {
    return flags.every(
      (flag) => flag === "-L" || flag === "-q" || flag === "--help" || flag === "--version" ||
        flag.startsWith("--query-gpu=") || flag.startsWith("--format="),
    );
  }
  if (exe === "tasklist.exe") {
    return flags.every((flag) => flag.startsWith("/") || /^\S+\s+(eq|ne)\s+/i.test(flag));
  }
  if (exe === "where.exe") return flags.length > 0;
  if (exe === "node.exe") return flags.length === 1 && (flags[0] === "-v" || flags[0] === "--version");
  return false;
}

// ---------------------------------------------------------------- 沙箱内的写 / 改 / 删 / 执行

function toolWriteFile(args) {
  const target = resolveSandboxPath(args.path);
  if (target.error) return fail(target.error);
  if (typeof args.content !== "string") return fail("缺少 content（要写入的文本；空文件传空串）。");
  if (args.content.length > WRITE_MAX_CHARS) {
    return fail(`内容太长（${args.content.length} 字符），单次最多 ${WRITE_MAX_CHARS} 字符。`);
  }
  ensureSandbox();
  const dir = path.dirname(target.path);
  try {
    mkdirSync(dir, { recursive: true });
    const realDir = realpathSync(dir);
    if (!withinSandbox(realDir)) return fail(`拒绝访问：${dir} 实际指向 ${realDir}，在沙箱外。`);
    if (args.append === true) appendFileSync(target.path, args.content, "utf8");
    else writeFileSync(target.path, args.content, "utf8");
  } catch (error) {
    return fail(`写不了 ${target.path}：${error.message}`);
  }
  const stat = statSync(target.path);
  return ok(`${args.append === true ? "已追加" : "已写入"} ${target.path}（${humanSize(stat.size)}）。`);
}

function toolEditFile(args) {
  const target = resolveSandboxPath(args.path);
  if (target.error) return fail(target.error);
  if (typeof args.old !== "string" || args.old === "") return fail("缺少 old（要替换的原文，不能为空）。");
  if (typeof args.new !== "string") return fail("缺少 new（替换后的文本；删除这段就传空串）。");
  let buffer;
  try {
    buffer = readFileSync(target.path);
  } catch (error) {
    return fail(`读不了 ${target.path}：${error.message}`);
  }
  if (isBinary(buffer)) return fail(`${target.path} 是二进制文件，不能按文本编辑。`);
  const text = buffer.toString("utf8");
  const occurrences = args.all === true ? text.split(args.old).length - 1 : text.includes(args.old) ? 1 : 0;
  if (occurrences === 0) {
    return fail(`没有找到要替换的原文：${args.old.slice(0, 120)}（${args.old.length} 字符）。`);
  }
  const next = args.all === true ? text.split(args.old).join(args.new) : text.replace(args.old, args.new);
  try {
    writeFileSync(target.path, next, "utf8");
  } catch (error) {
    return fail(`写不了 ${target.path}：${error.message}`);
  }
  return ok(`已替换 ${occurrences} 处：${target.path}（现在 ${next.length} 字符）。`);
}

function toolDeleteFile(args) {
  const target = resolveSandboxPath(args.path, { allowRoot: true });
  if (target.error) return fail(target.error);
  const absolute = target.path;
  if (path.resolve(absolute) === path.resolve(sandboxRoot())) {
    return fail("不能删除当前会话的沙箱根目录本身。");
  }
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return fail(`不存在：${absolute}`);
  }
  try {
    if (stat.isDirectory()) {
      if (args.recursive === true) rmSync(absolute, { recursive: true, force: true });
      else rmdirSync(absolute);
    } else {
      unlinkSync(absolute);
    }
  } catch (error) {
    return fail(`删不了 ${absolute}：${error.message}`);
  }
  return ok(`已删除 ${absolute}（${stat.isDirectory() ? "目录" : humanSize(stat.size)}）。`);
}

function toolRunFile(args) {
  const target = resolveSandboxPath(args.path);
  if (target.error) return fail(target.error);
  const absolute = target.path;
  if (!existsSync(absolute)) return fail(`找不到文件：${absolute}`);
  let stat;
  try {
    stat = statSync(absolute);
  } catch (error) {
    return fail(`看不了 ${absolute}：${error.message}`);
  }
  if (!stat.isFile()) return fail(`${absolute} 不是文件。`);

  const extraArgs = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
  const cwd = typeof args.cwd === "string" && args.cwd.trim() !== ""
    ? path.resolve(sandboxRoot(), args.cwd.trim())
    : sandboxRoot();
  if (!withinSandbox(cwd)) {
    return fail(`cwd 必须在当前会话的 tmp 目录内：${sandboxRoot()}`);
  }
  const ext = path.extname(absolute).toLowerCase();
  const childEnv = { ...process.env, LOCAL_TOOLS_SANDBOX: sandboxRoot() };
  let command = absolute;
  let commandArgs = extraArgs;
  /** 输出里额外带的提醒（.exe 这类应用层管不住文件访问的程序）。 */
  let notice = "";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    // Node 权限模型：读写都受控，child_process 默认被禁。
    command = process.execPath;
    commandArgs = [...nodePermissionArgs(), absolute, ...extraArgs];
  } else if (ext === ".py") {
    command = process.platform === "win32" ? "python" : "python3";
    const guard = ensurePythonGuard();
    childEnv.PYTHONPATH = `${guard}${path.delimiter}${process.env.PYTHONPATH ?? ""}`;
    commandArgs = [absolute, ...extraArgs];
  } else if (ext === ".ps1") {
    const problem = checkPowerShell(absolute);
    if (problem) return fail(problem);
    command = "powershell";
    commandArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", absolute, ...extraArgs];
  } else if (ext === ".bat" || ext === ".cmd" || ext === ".sh") {
    return fail("不执行 .bat / .cmd / .sh（需要 shell，容易被注入）；要跑脚本请写成 .js / .py / .ps1 或编译成 .exe。");
  } else {
    notice = "\n（提醒：这是原生程序，应用层无法限制它的文件访问；只执行你自己编译或可信的程序。）";
  }

  const timeout = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(args.timeout_ms, EXEC_MAX_TIMEOUT_MS)
    : EXEC_TIMEOUT_MS;
  ensureSandbox();
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd,
    shell: false,
    encoding: "buffer",
    timeout,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
    env: childEnv,
  });
  const elapsed = Date.now() - started;
  const shown = `${path.relative(sandboxRoot(), absolute) || path.basename(absolute)} ${extraArgs.join(" ")}`.trim();
  if (result.error) {
    return fail(`执行失败（${elapsed} ms，工作目录 ${cwd}）：${result.error.message}\n命令：${command} ${commandArgs.join(" ")}`);
  }
  const stdout = decodeOutput(result.stdout ?? Buffer.alloc(0));
  const stderr = decodeOutput(result.stderr ?? Buffer.alloc(0));
  const body = [stdout, stderr].filter((part) => part.trim() !== "").join("\n[stderr]\n");
  const header = `$ ${shown}\n工作目录 ${cwd} · 退出码 ${result.status} · ${elapsed} ms · 沙箱 ${sandboxRoot()}`;
  return ok(`${header}\n\n${clipOutput(redactSecrets(body))}${notice}`);
}

const TOOLS = [
  {
    name: "list_dir",
    description:
      "列出用户指定目录里的条目（只读）。path 必填，且只能填用户消息或当前对话里明确出现过的目录 —— " +
      "不要猜路径、不要用默认目录。用户没说要看哪个目录时，先问清楚再调。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "用户给出的目录绝对路径（必填）" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_help",
    description:
      "通用本机工具（与当前应用无关）：查询任意可执行文件的 --help / --version（只读）。program 传完整路径或名字（git、python、" +
      "node、cargo、任意 .exe），args 默认 [\"--help\"]。program 只能从用户问题里出现过的程序名或路径取 —— " +
      "用户没说查哪个程序时，先问，不要随便拿一个程序去查。问题只涉及编程概念、算法、语言本身时不要调用本工具，" +
      "更不要把回答引向某个具体软件（比如某个命令行程序的参数）。帮助文本很长时用 filter 只取相关行。",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "可执行文件完整路径，或 PATH 里的名字（git / python / node / cargo / 任意程序名）" },
        args: { type: "array", items: { type: "string" }, description: "参数数组，默认 [\"--help\"]；只允许 --help / -h / --version / -v / -V / --list-* 这类只读参数" },
        filter: { type: "string", description: "可选：只返回包含这段文字的行（不区分大小写），用于查某个参数名而不是整份帮助" },
        cwd: { type: "string", description: "工作目录，默认服务器进程的当前目录" },
        timeout_ms: { type: "number", description: "超时毫秒，默认 60000，上限 300000" },
      },
      required: ["program"],
    },
  },
  {
    name: "read_text_file",
    description:
      "读本机任意文本文件（只读），返回带行号的内容 —— 任何编程语言的源代码（.py/.rs/.ts/.go/.java/.c/.cpp…）、配置、日志、" +
      "文档都可以，不限扩展名。path 必填，且只能读用户消息或当前对话里出现过的文件；用户没给路径时先问，不要猜。" +
      "文件超过 256 KB 只读前 256 KB，长文件靠 offset / limit 分段。二进制文件会被拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径" },
        offset: { type: "number", description: "从第几行开始（1 起），默认 1" },
        limit: { type: "number", description: "最多返回多少行，默认 400、上限 400" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_readonly",
    description:
      "执行只读命令，返回 stdout / stderr 与退出码。**不能写、不能删、不能改任何文件**：程序可以是任意可执行文件，" +
      "但参数只允许 --help / -h / --version / -v / -V / --list-* 这类只读参数；另外 nvidia-smi（显存查询）、" +
      "tasklist（看进程）、where（查路径）、node -v 可以带各自的特有参数。program 只从用户问题里出现过的名字取，" +
      "用户没指定就先问。不经 shell，所以 `>`、`|` 这类字符不会被解释。",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "可执行文件完整路径，或 nvidia-smi / tasklist / where / node 这类名字" },
        args: { type: "array", items: { type: "string" }, description: "参数数组，例如 [\"--version\"] 或 [\"--query-gpu=memory.total,memory.used\", \"--format=csv\"]" },
        cwd: { type: "string", description: "工作目录，默认服务器进程的当前目录" },
        timeout_ms: { type: "number", description: "超时毫秒，默认 60000，上限 300000" },
      },
      required: ["program"],
    },
  },
  {
    name: "write_file",
    description:
      "在本会话的 tmp 子目录（`<GUI 目录>/tmp/<会话 id>`，path 相对它解析）里创建或覆盖文本文件。" +
      "父目录会自动创建；append=true 时追加。这是模型唯一被允许写文件的地方 —— 会话目录外的路径一律拒绝。" +
      "用户要你生成/保存文件时用它；写之前先想清楚路径，不要写到会话目录外面。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "会话目录内的相对路径（如 notes/todo.md）或其中的绝对路径" },
        content: { type: "string", description: "要写入的文本内容（单次最多 1000000 字符）" },
        append: { type: "boolean", description: "true 时追加到文件末尾，默认覆盖" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "在本会话的 tmp 子目录里按原文替换编辑文本文件。old 必须能在文件里找到（找不到会报错并提示），" +
      "all=true 时替换全部出现处，否则只替换第一处。适合改自己刚写的代码/脚本、修正配置；会话目录外路径拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "会话目录内的文件路径" },
        old: { type: "string", description: "要替换的原文（必须精确匹配，不能为空）" },
        new: { type: "string", description: "替换后的文本；删除这段就传空串" },
        all: { type: "boolean", description: "true 时替换所有出现处，默认只替换第一处" },
      },
      required: ["path", "old", "new"],
    },
  },
  {
    name: "delete_file",
    description:
      "删除本会话 tmp 子目录里的文件或子目录（递归删除传 recursive=true，否则只删空目录）。" +
      "会话目录本身不能删，会话目录外路径拒绝。删除不可恢复，删之前确认路径。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "沙箱内要删除的文件或子目录" },
        recursive: { type: "boolean", description: "true 时递归删除目录及其内容，默认只删空目录" },
      },
      required: ["path"],
    },
  },
  {
    name: "run_file",
    description:
      "执行本会话 tmp 子目录里的文件并返回输出（.exe 直接跑；.js/.mjs 用 node、.py 用 python、.ps1 用 powershell 跑）。" +
      "cwd 也必须在会话目录内，默认会话目录。不经 shell，args 按数组传。执行时再套运行时约束：.js 用 Node 权限模型只能写会话目录、" +
      ".py 注入 sitecustomize 守卫只能写会话目录、.ps1 含写/删命令会被拒绝；.exe 应用层管不住文件访问，只建议跑自己编译的程序。" +
      "适合「写个脚本/小程序跑一下看结果」的流程；执行超时默认 60 秒、上限 300 秒。会话目录外文件拒绝执行。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "会话目录内要执行的文件" },
        args: { type: "array", items: { type: "string" }, description: "传给程序的参数数组" },
        cwd: { type: "string", description: "工作目录（会话目录内），默认会话目录" },
        timeout_ms: { type: "number", description: "超时毫秒，默认 60000，上限 300000" },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------- JSON-RPC

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function handle(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && typeof params.name === "string" ? params.name : "";
      const args = params && params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      // GUI 把当前会话 id 放在 _meta 里，工具据此落 tmp/<会话 id>/（删会话时目录一起删）。
      const meta = params && params._meta && typeof params._meta === "object" ? params._meta : {};
      activeSession = sessionName(meta.sessionId);
      let result;
      try {
        if (name === "list_dir") result = toolListDir(args);
        else if (name === "run_help") result = toolRunHelp(args);
        else if (name === "read_text_file") result = toolReadTextFile(args);
        else if (name === "run_readonly") result = toolRunReadonly(args);
        else if (name === "write_file") result = toolWriteFile(args);
        else if (name === "edit_file") result = toolEditFile(args);
        else if (name === "delete_file") result = toolDeleteFile(args);
        else if (name === "run_file") result = toolRunFile(args);
        else result = fail(`没有这个工具：${name}`);
      } catch (error) {
        result = fail(`工具 ${name} 执行失败：${error.message}`);
      }
      reply(id, result);
      return;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `未实现的方法：${method}`);
  }
}

// 启动时清一遍 tmp 里的临时文件：__pycache__ / .pyc 每次清；30 天没动过的会话目录整目录清掉。
// 会话目录里的临时测试代码随会话目录一起消失；正常删会话时 GUI 会立刻删该目录，这里是兜底。
try {
  ensureSandbox();
  cleanSandbox();
} catch {
  // 清理失败不影响工具服务；下次启动再试
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return; // 不是合法 JSON 的行直接丢（协议只允许 JSON）
  }
  handle(message);
});
rl.on("close", () => process.exit(0));
