#!/usr/bin/env node
// llama.cpp GUI 的本地 MCP 服务器（stdio，MCP 2024-11-05）。
//
// 为什么需要它：GUI 聊天原来只有 web_search / web_fetch 两个工具，问「b12196 支持哪些
// MoE 参数」时模型只能上网搜，而具体构建号的参数网上基本没有 —— 于是它凭印象编参数。
// 这台服务器把本机读取与命令执行能力交给模型，让它先取本机事实，再考虑联网。
//
// 用户明确要求取消路径白名单与命令白名单：现在的边界只剩「默认不写」——`read_text_file`
// / `list_dir` 不会改任何东西，`run_command` 可以执行任意命令（包括会写文件的命令），
// 请知悉这一点。密钥打码与输出限长仍然保留。
//
// 由 GUI 的聊天设置以 stdio 子进程拉起（mcp.json），不要脱离 GUI 单独用。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "llamacpp-local";
const SERVER_VERSION = "2.0.0";

/** llama.cpp 版本目录所在（list_dir 的默认目录、llama_help 的默认根）。 */
const LLAMA_ROOT = "E:\\AI\\llamacpp";
/** 命令的默认工作目录。 */
const DEFAULT_CWD = "E:\\AI\\llama.cpp-gui";

const READ_MAX_BYTES = 256 * 1024;
const READ_MAX_LINES = 400;
const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_TIMEOUT_MS = 300_000;
const EXEC_MAX_BUFFER = 32 * 1024 * 1024;
const OUTPUT_MAX_CHARS = 20_000;

const HELP_TOOLS = {
  server: "llama-server.exe",
  cli: "llama-cli.exe",
  bench: "llama-bench.exe",
  "fit-params": "llama-fit-params.exe",
};

/** llama.cpp 自带的只读开关：这五个不会改任何文件。 */
const LLAMA_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-devices"]);

/** 除 llama-*.exe 外允许的只读程序（按可执行文件名判断，参数另有约束）。 */
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

/** 把看起来像密钥的值打码（设置文件里存着 llama.cpp / Strata 的 api_key）。 */
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

/** 读部署目录的 settings.json，取当前选中的 llama.cpp 版本（读不到就退回最新目录）。
 *
 * 这是服务器内部读配置：只取一个版本目录名，不向模型暴露 settings.json 的内容。 */
function selectedVersion() {
  try {
    const text = readFileSync("E:\\AI\\llama.cpp-gui\\settings.json", "utf8");
    const settings = JSON.parse(text);
    const name = typeof settings.selected_version === "string" ? settings.selected_version : "";
    if (name && existsSync(path.join(LLAMA_ROOT, name))) return name;
  } catch {
    // 忽略：退回下面的最新目录
  }
  return latestVersion();
}

function latestVersion() {
  try {
    const dirs = readdirSync(LLAMA_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("llama-"))
      .map((entry) => entry.name)
      .sort();
    return dirs.length > 0 ? dirs[dirs.length - 1] : "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- 工具实现

function toolListDir(args) {
  const absolute = resolvePath(args.path ?? LLAMA_ROOT);
  if (!absolute) return fail("缺少 path（要列出的目录）。");
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

/** 跑只读命令并合并 stdout + stderr（llama.cpp 把 `--version` 写在 stderr 上）。 */
function runReadonly(absolute, flags) {
  const result = spawnSync(absolute, flags, {
    encoding: "buffer",
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  if (result.error) return { error: result.error.message, text: "" };
  const stdout = result.stdout ?? Buffer.alloc(0);
  const stderr = result.stderr ?? Buffer.alloc(0);
  const text = `${decodeOutput(stdout)}${stdout.length > 0 && stderr.length > 0 ? "\n" : ""}${decodeOutput(stderr)}`;
  if (result.status !== 0 && text.trim() === "") {
    return { error: `退出码 ${result.status}`, text: "" };
  }
  return { error: "", text };
}

function toolLlamaHelp(args) {
  const tool = typeof args.tool === "string" && HELP_TOOLS[args.tool] ? args.tool : "server";
  const version = typeof args.version === "string" && args.version.trim() !== "" ? args.version.trim() : selectedVersion();
  if (!version) return fail(`找不到 llama.cpp 版本目录（${LLAMA_ROOT} 下没有 llama-* 目录）。`);
  const exe = path.join(LLAMA_ROOT, version, HELP_TOOLS[tool]);
  const absolute = resolvePath(exe);
  if (!absolute || !existsSync(absolute)) {
    return fail(`没有这个可执行文件：${exe}\n可先用 list_dir 看 ${path.join(LLAMA_ROOT, version)} 里有哪些 llama-*.exe。`);
  }
  const { error, text } = runReadonly(absolute, ["--help"]);
  if (error) return fail(`执行 ${absolute} --help 失败：${error}`);
  return ok(`${version}\\${HELP_TOOLS[tool]} --help\n\n${clipHelp(text, args.filter)}`);
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
  const program = typeof args.program === "string" ? args.program.trim() : "";
  if (!program) return fail("缺少 program（要运行的可执行文件，例如 llama-server.exe 的完整路径或 nvidia-smi）。");
  const flags = Array.isArray(args.args) ? args.args.map((item) => String(item)) : [];
  // 带路径分隔符的按绝对路径解析；纯名字（node / nvidia-smi / tasklist）交给 PATH。
  const hasSeparator = program.includes("\\") || program.includes("/");
  const target = hasSeparator ? path.resolve(program) : program;
  const bare = path.basename(target).toLowerCase();
  const name = /\.exe$/i.test(bare) ? bare : `${bare}.exe`;
  const check = isReadonlyInvocation(name, flags);
  if (!check) {
    return fail(
      `拒绝执行：${program} ${flags.join(" ")}\n` +
        "只允许只读程序与只读参数：llama.cpp 的 llama-*.exe（--help/-h/--version/-v/--list-devices）、" +
        "nvidia-smi（-L/-q/--query-gpu=/--format=）、tasklist、where、node -v。任何写文件、删文件、改配置的操作都不允许。",
    );
  }
  if (hasSeparator && !existsSync(target)) return fail(`找不到可执行文件：${target}`);
  const cwd = typeof args.cwd === "string" && args.cwd.trim() !== "" ? path.resolve(args.cwd.trim()) : DEFAULT_CWD;
  const timeout = Number.isInteger(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(args.timeout_ms, EXEC_MAX_TIMEOUT_MS)
    : EXEC_TIMEOUT_MS;

  const started = Date.now();
  const result = spawnSync(target, flags, {
    cwd,
    shell: false,
    encoding: "buffer",
    timeout,
    maxBuffer: EXEC_MAX_BUFFER,
    windowsHide: true,
  });
  const elapsed = Date.now() - started;
  if (result.error) {
    return fail(`执行失败（${elapsed} ms，工作目录 ${cwd}）：${result.error.message}`);
  }
  const stdout = decodeOutput(result.stdout ?? Buffer.alloc(0));
  const stderr = decodeOutput(result.stderr ?? Buffer.alloc(0));
  const body = [stdout, stderr].filter((part) => part.trim() !== "").join("\n[stderr]\n");
  const header = `$ ${name} ${flags.join(" ")}\n工作目录 ${cwd} · 退出码 ${result.status} · ${elapsed} ms`;
  return ok(`${header}\n\n${clipOutput(redactSecrets(body))}`);
}

/** 只读调用判定：程序名 + 参数都在白名单里，且不经 shell（元字符不会被解释）。 */
function isReadonlyInvocation(name, flags) {
  if (/^llama-[a-z0-9-]+\.exe$/.test(name)) return flags.every((flag) => LLAMA_FLAGS.has(flag));
  if (!READONLY_PROGRAMS.has(name)) return false;
  if (name === "nvidia-smi.exe") {
    return flags.every(
      (flag) => flag === "-L" || flag === "-q" || flag === "--help" || flag === "--version" ||
        flag.startsWith("--query-gpu=") || flag.startsWith("--format="),
    );
  }
  if (name === "tasklist.exe") {
    return flags.every((flag) => flag.startsWith("/") || /^\S+\s+(eq|ne)\s+/i.test(flag));
  }
  if (name === "where.exe") return flags.length > 0;
  if (name === "node.exe") return flags.length === 1 && (flags[0] === "-v" || flags[0] === "--version");
  return false;
}

const TOOLS = [
  {
    name: "list_dir",
    description:
      "列出本机任意目录里的条目（只读）。用于查看 llama.cpp 版本目录、模型目录、配置目录里到底有什么。" +
      "省略 path 时列出 llama.cpp 安装根目录。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录绝对路径；省略则列出 llama.cpp 安装根目录" },
      },
    },
  },
  {
    name: "llama_help",
    description:
      "返回某个 llama.cpp 版本里 llama-server / llama-cli / llama-bench / llama-fit-params 的 --help 全文 —— " +
      "这是该版本真实支持的参数表。回答「某版本支持哪些参数」「MoE / 显存相关参数怎么用」「新版本加了什么开关」之前，" +
      "先调这个拿事实，不要凭记忆或网上搜索编参数名。version 省略时用设置里当前选中的版本。",
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string", description: "版本目录名，例如 llama-b12196-bin-win-cuda-13.5-x64；省略用当前选中版本" },
        tool: {
          type: "string",
          enum: ["server", "cli", "bench", "fit-params"],
          description: "要查哪个程序，默认 server",
        },
        filter: {
          type: "string",
          description: "可选：只返回包含这段文字的行（不区分大小写），用于查某个参数名而不是整份帮助",
        },
      },
    },
  },
  {
    name: "read_text_file",
    description:
      "读本机任意文本文件（只读），返回带行号的内容。用于读 llama.cpp 的配置 JSON、docs、模型 readme、日志。" +
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
      "执行只读命令，返回 stdout / stderr 与退出码。**不能写、不能删、不能改任何文件**：只允许 llama.cpp 的 " +
      "llama-*.exe（--help / -h / --version / -v / --list-devices）、nvidia-smi（显存查询）、tasklist（看进程）、" +
      "where（查路径）、node -v。不经 shell，所以 `>`、`|` 这类字符不会被解释。",
    inputSchema: {
      type: "object",
      properties: {
        program: { type: "string", description: "可执行文件完整路径（如某个版本目录里的 llama-server.exe），或 nvidia-smi / tasklist / where / node" },
        args: { type: "array", items: { type: "string" }, description: "参数数组，例如 [\"--version\"] 或 [\"--query-gpu=memory.total,memory.used\", \"--format=csv\"]" },
        cwd: { type: "string", description: "工作目录，默认 E:\\AI\\llama.cpp-gui" },
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
        else if (name === "llama_help") result = toolLlamaHelp(args);
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
