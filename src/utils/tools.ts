/**
 * 聊天页可以交给模型调用的工具。
 *
 * 工具一律由 GUI 执行：模型在流里给出 `tool_calls`，前端跑完把结果作为 `role:"tool"`
 * 消息喂回去。来源有三种 —— 内置的联网搜索（`web_search`）、内置的网页正文抓取
 * （`web_fetch`），都走 `search.rs`；以及用户在聊天设置里配的 MCP 服务器
 * （`mcp__<服务器>__<工具>`，走 `mcp.rs`）。
 * llama.cpp b11671 虽然自带 `--mcp-servers-config`，但那套工具在 server 进程内部执行、
 * GUI 看不到每次调用，所以没有采用。
 *
 * 这里只放工具定义与分片累积，执行在 `src/store.ts`。
 */

import type { McpToolView } from "../types";
import type { ToolCall, ToolCallFragment, ToolSpec } from "./chat";

/** MCP 工具名统一前缀（后端 `mcp.rs::assign_keys` 生成的 `mcp__<服务器>__<工具>`） */
export const MCP_PREFIX = "mcp__";

/** 是不是 MCP 工具（由用户在聊天设置里配的服务器提供） */
export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/** 一次 web_search 最多几条查询（照 dsh-tool-web 的 searchMaxQueries=4） */
export const MAX_SEARCH_QUERIES = 4;

/**
 * 内置联网搜索：后端 `search_query` 命令（多引擎 fallback，见 `search.rs`）。
 * 查询形态照 DSH 核心（dsh-tool-web）：`queries` 1–4 条并发搜、合并返回。
 */
export const WEB_SEARCH_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "联网搜索。一次给 1–4 条查询（queries 数组），并行搜索后合并返回。当问题涉及最新消息、你不确定的事实、或用户明确要求查资料时调用；" +
      "需要多角度覆盖时把每个角度写成一条查询，完全相同的查询只执行一次。返回若干条标题、链接与正文节选，按查询分节。" +
      "如果某条结果最相关但内容被截断，再用 web_fetch 读它的完整正文。",
    parameters: {
      type: "object",
      properties: {
        queries: {
          type: "array",
          items: { type: "string" },
          description: "1–4 条搜索词，每条尽量简短并包含关键实体；完全相同的查询只执行一次",
        },
        limit: { type: "integer", description: "每条查询的返回条数，1–50，默认 6；问题复杂时给 15–30" },
      },
      required: ["queries"],
    },
  },
};

/**
 * 从 web_search 参数里取查询：去空、去完全重复、最多 4 条（DSH 的 searchMaxQueries 口径）。
 * 兼容旧版单串 `query` 形态 —— 模型按旧 schema 写出的调用也要接得住。
 */
export function searchQueriesFromArgs(args: Record<string, unknown>): string[] {
  const raw = Array.isArray(args.queries)
    ? (args.queries as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const list =
    raw.length > 0
      ? raw
      : typeof args.query === "string"
        ? [args.query]
        : [];
  const picked: string[] = [];
  for (const item of list) {
    const value = item.trim();
    if (!value || picked.includes(value)) continue;
    picked.push(value);
  }
  return picked.slice(0, MAX_SEARCH_QUERIES);
}

/** 内置网页正文抓取：后端 `web_fetch` 命令（curl 抓 HTML → 抽正文） */
export const WEB_FETCH_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "web_fetch",
    description:
      "读取一个网页的正文（纯文本）。当搜索结果里的链接最相关、但摘要不够回答问题时，用它打开那一页。" +
      "只支持 http/https 的正文页，抓不到登录后内容。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "要读的网页地址，一般直接取 web_search 结果里的链接" },
        maxChars: {
          type: "integer",
          description: "最多要多少字符，1000–12000，默认 12000；只要某一段时给小一点",
        },
      },
      required: ["url"],
    },
  },
};

/**
 * 这次请求要带哪些工具。
 * - `webSearch`：设置里的「联网搜索」开关
 * - `mcpTools`：已拉到的 MCP 工具（`mcp_tools_list` 的结果，设置里打开「MCP 工具」才会有）
 * - `webFetch`：网页正文抓取，默认跟着联网搜索开关一起出现（有网才谈得上读页）
 */
export function buildToolSpecs(
  webSearch: boolean,
  mcpTools: McpToolView[] = [],
  webFetch = webSearch,
): ToolSpec[] {
  const specs: ToolSpec[] = [];
  if (webSearch) specs.push(WEB_SEARCH_TOOL);
  if (webFetch) specs.push(WEB_FETCH_TOOL);
  for (const tool of mcpTools) {
    specs.push({
      type: "function",
      function: {
        name: tool.key,
        // 描述前加服务器名：模型据此知道该走哪个工具，卡片上也更好认
        description: tool.description.trim()
          ? `[${tool.server}] ${tool.description.trim()}`
          : `[${tool.server}] ${tool.name}`,
        parameters: tool.inputSchema,
      },
    });
  }
  return specs;
}

/**
 * 把流式分片累积成完整调用。
 * 同一次调用分多条到达：`id` / `name` 只来一次，`arguments` 是逐段拼的 JSON 字符串。
 */
export function mergeToolCallFragments(previous: ToolCall[], fragments: ToolCallFragment[]): ToolCall[] {
  const merged = previous.map((call) => ({ ...call }));
  for (const fragment of fragments) {
    while (merged.length <= fragment.index) merged.push({ id: "", name: "", arguments: "" });
    const target = merged[fragment.index];
    if (fragment.id) target.id = fragment.id;
    if (fragment.name) target.name = fragment.name;
    if (fragment.arguments) target.arguments += fragment.arguments;
  }
  return merged.filter((call) => call.name);
}

/** 解析工具参数；坏 JSON 当成空对象（模型偶尔会写出残缺的 JSON） */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 工具名 → 界面上显示的中文名 */
export const TOOL_LABEL: Record<string, string> = {
  web_search: "联网搜索",
  web_fetch: "读网页",
};

/** 工具名 → 卡片标题。MCP 工具名是 `mcp__<服务器>__<工具>`，拆出来显示。 */
export function toolTitle(name: string): string {
  const known = TOOL_LABEL[name];
  if (known) return known;
  if (isMcpTool(name)) {
    const rest = name.slice(MCP_PREFIX.length);
    const at = rest.indexOf("__");
    if (at > 0) return `MCP · ${rest.slice(0, at)} · ${rest.slice(at + 2)}`;
    return `MCP · ${rest}`;
  }
  return name;
}

/** 一次调用的参数摘要，给工具卡片当副标题 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "web_search") {
    const queries = searchQueriesFromArgs(args);
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return limit ? `${queries.join("，")}（每条 ${limit} 条）` : queries.join("，");
  }
  if (name === "web_fetch") {
    return typeof args.url === "string" ? args.url : "";
  }
  if (isMcpTool(name)) {
    // MCP 工具的参数各家不同（`query` / `path` / `command`…），取第一个字符串值当摘要
    const first = Object.values(args).find((value) => typeof value === "string");
    if (typeof first === "string") return first;
    const keys = Object.keys(args);
    return keys.length > 0 ? JSON.stringify(args) : "";
  }
  const keys = Object.keys(args);
  return keys.length > 0 ? keys.join(", ") : "";
}
