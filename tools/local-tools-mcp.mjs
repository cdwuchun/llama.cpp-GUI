#!/usr/bin/env node
// GUI 的本地 MCP 服务器（stdio，MCP 2024-11-05）—— 通用本机工具，不绑定 llama.cpp。
//
// 为什么需要它：GUI 聊天原来只有 web_search / web_fetch 两个工具，问「这个可执行文件支持
// 哪些参数」「某个版本的帮助文本」「某段源码怎么写的」时模型只能上网搜或凭印象编。这台
// 服务器把本机读取与只读查询能力交给模型，让它先取本机事实，再考虑联网。
//
// 通用性约定：
// - `list_dir` 列用户指定的目录（path 必填，不许猜）。
// - `read_text_file` 读任意文本文件（任何编程语言源码、配置、日志、文档），不限扩展名。
// - `run_help` 查任意可执行文件的 --help / --version（不限 llama.cpp，python / node /
//   git / cargo / 任意 .exe 都行），支持按关键字过滤帮助文本。
// - `run_readonly` 执行只读参数（--help / -h / --version / -v / --list-* 等）；不经 shell，
//   所以 `>`、`|`、`;` 不会被解释。写文件、删文件、改配置一律拒绝。
//
// 行为约定：路径与程序名只从用户消息或对话上下文里取；用户没给就先问，不要拿默认目录或
// 随便挑一个程序去猜 —— 无参调用 list_dir 会直接报错。
//
// 边界：默认不写。`read_text_file` / `list_dir` 只读；`run_help` / `run_readonly` 只跑
// 只读参数。密钥打码与输出限长保留。
//
// 由 GUI 的聊天设置以 stdio 子进程拉起（mcp.json），不要脱离 GUI 单独用。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "local-tools";
const SERVER_VERSION = "3.1.0";

const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINES = 400;
const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_TIMEOUT_MS = 300_000;
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const OUTPUT_MAX_CHARS = 20_000;

/** 默认工作目录：服务器进程的启动目录（只作为执行程序的 cwd，不用来猜用户想看的目录）。 */
const DEFAULT_CWD = process.cwd();

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
  if (!program) return fail("缺少 program（要查的可执行文件完整路径或名字，例如 git、python、llama-server.exe）。");
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
      "查询任意可执行文件的 --help / --version（只读、通用，不限 llama.cpp）。program 传完整路径或名字（git、python、" +
      "node、cargo、llama-server.exe…），args 默认 [\"--help\"]。program 只能从用户问题里出现过的程序名或路径取 —— " +
      "用户没说查哪个程序时，先问，不要随便拿一个程序去查。回答「这个程序/版本支持哪些参数」「某版本加了什么开关」" +
      "之前先调这个拿事实，不要凭记忆或网上搜索编参数名；帮助文本很长时用 filter 只取相关行。",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "可执行文件完整路径，或 PATH 里的名字（git / python / node / cargo / llama-server.exe）" },
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
      let result;
      try {
        if (name === "list_dir") result = toolListDir(args);
        else if (name === "run_help") result = toolRunHelp(args);
        else if (name === "read_text_file") result = toolReadTextFile(args);
        else if (name === "run_readonly") result = toolRunReadonly(args);
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
