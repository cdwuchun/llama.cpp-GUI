/**
 * 原生聊天页的纯逻辑：消息/会话类型、请求体构造、SSE 组帧与解码、能力判定。
 *
 * 照上游 `packages/core/src/chat.ts` 移植，**去掉 Strata 专有的三样**：
 * - `strata_mcp`（换成 GUI 自己当 MCP 客户端的 `mcpTools`，见 `src-tauri/src/mcp.rs`）
 * - `strata_prefix`（固定文档前缀缓存，上游靠引擎侧实现）
 * - `experimental_speed_projection`（依赖 `/metrics` 的 `engine.cvec`）
 *
 * 保留的通用部分：共享默认值（`buildSharedDefaults`）、请求体组装
 * （`buildChatRequest`）、SSE 解析（`SSEParser`）、增量解码（`decodeChatChunk`）。
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/**
 * 提供给模型的工具（OpenAI `tools` 数组里的一项）。
 * llama.cpp 自己既没有联网也没有 MCP 客户端接进本工程；工具由 GUI 执行后把结果喂回去
 * （联网搜索与网页正文抓取见 `src-tauri/src/search.rs`，MCP 见 `src-tauri/src/mcp.rs`）。
 */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 模型发起的一次工具调用（流式分片累积完成后的形态） */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** 流里 `delta.tool_calls` 的一片（同一次调用会分多条到达，按 `index` 拼） */
export interface ToolCallFragment {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/** 附件：文本内联成围栏代码块，图片走 `image_url` Data URL */
export interface ChatAttachment {
  id: string;
  name: string;
  type: "text" | "image";
  mimeType: string;
  /** 文本附件是原文；图片是 `data:image/png;base64,...` */
  content: string;
}

/** 工具调用（本工程暂不产生，保留渲染结构以备将来） */
export interface ChatToolEvent {
  id?: string;
  name: string;
  status: string;
  arguments?: unknown;
  result?: string | null;
  /** 卡片头上的一句补充说明（如联网搜索「走的是哪个引擎、跳过了哪些」） */
  note?: string;
  at?: number;
  ok?: boolean;
  skipped?: boolean;
  raw?: Record<string, unknown>;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  [key: string]: unknown;
}

/**
 * llama.cpp 在流末尾连 `usage` 一起报的 `timings`（纯计算时间，权威口径）。
 * 压测页一直用这套数，聊天页的「预填充 / 解码 / 草稿命中率」也取自这里（用户 m06312 第 1 点）。
 */
export interface ChatSpeed {
  /** 预填充速度 tok/s（`timings.prompt_per_second`） */
  prefillTokS?: number;
  /** 解码速度 tok/s（`timings.predicted_per_second`） */
  decodeTokS?: number;
  /** 草稿命中率 0–1（`draft_n_accepted / draft_n`）；没开投机解码就是 null */
  draftAccept?: number | null;
  /** 提示词缓存命中的 token 数（`timings.cache_n`），算「缓存命中率」用 */
  cacheTokens?: number | null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 解析 `chunk.timings`；一个字段都没读到时返回 null，免得把空对象挂到消息上 */
export function parseChatSpeed(value: unknown): ChatSpeed | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const draftN = num(raw.draft_n);
  const draftHits = num(raw.draft_n_accepted);
  const speed: ChatSpeed = {
    prefillTokS: num(raw.prompt_per_second),
    decodeTokS: num(raw.predicted_per_second),
    draftAccept: draftN && draftN > 0 && draftHits !== undefined ? draftHits / draftN : null,
    cacheTokens: num(raw.cache_n) ?? null,
  };
  if (
    speed.prefillTokS === undefined &&
    speed.decodeTokS === undefined &&
    speed.draftAccept == null &&
    speed.cacheTokens == null
  )
    return null;
  return speed;
}

/** 一次请求的生命周期（照上游 `ChatExecution`，去掉服务请求标识） */
export interface ChatExecution {
  phase: "waiting" | "reasoning" | "tools" | "generating" | "completed" | "cancelled" | "failed";
  startedAt: number;
  requestStartedAt?: number;
  finishedAt?: number;
  firstTokenMs?: number;
  firstVisibleMs?: number;
  /** 本地生成的这次操作 id，用于日志对账 */
  operationId: string;
  /** 服务回传的响应 id（llama.cpp 是 chatcmpl-…） */
  responseId?: string;
  /**
   * 等待期间的自定义状态文案（用户 m00082 第 3 点）：选中的模型没加载时，发送会先自动拉起，
   * 这段几十秒里状态条显示「正在加载模型 xxx…」，而不是干等「等待响应」。
   * 只在 `phase === "waiting"` 时生效 —— 加载完开始生成后由常规标签接管，不必清字段。
   */
  hint?: string;
}

/** 会话里的一条消息 */
export interface ChatTurn {
  id: string;
  role: ChatRole;
  content: string;
  reasoning?: string;
  createdAt: number;
  usage?: ChatUsage;
  /** 流末尾报的预填充 / 解码 / 草稿命中率 */
  speed?: ChatSpeed;
  attachments?: ChatAttachment[];
  tools?: ChatToolEvent[];
  /** 助手这一轮要求调用的工具（下一轮作为 `tool_calls` 原样发回去） */
  toolCalls?: ToolCall[];
  /** `role: "tool"` 时对应哪一次调用 */
  toolCallId?: string;
  error?: string;
  stopped?: boolean;
  execution?: ChatExecution;
  elapsedMs?: number;
  firstTokenMs?: number;
  reasoningMs?: number;
  /** 界面小标记：改写过的回答带「已编辑」（上游 `m.meta`） */
  meta?: string;
}

export interface Conversation {
  id: string;
  /** 这份会话绑定的模型名（config 里的 name） */
  model: string;
  title: string;
  messages: ChatTurn[];
  createdAt: number;
  updatedAt: number;
  /** 分支会话记着从哪来（上游 `chat.parent`），界面上给一条「打开原会话」的提示 */
  parent?: { id: string; title: string };
}

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export type ChatResponseFormat = "text" | "json_object" | "json_schema";

/** 上游「回答设置」那一组高级字段（`ChatAdvancedOptions`）；只有 Strata 通道的模型才发送 */
export interface ChatAdvanced {
  responseFormat: ChatResponseFormat;
  schemaName: string;
  schemaText: string;
  logitBiasText: string;
  /** 停止串，最多 4 条非空 */
  stop: string[];
  minP: number | null;
  repetitionPenalty: number | null;
  presencePenalty: number | null;
  frequencyPenalty: number | null;
  penaltyLastN: number | null;
}

/** 已开启的固定前缀（上游 `options.fixedPrefix`） */
export interface ChatFixedPrefix {
  messageId: string;
  chars?: number;
}

const DEFAULT_SCHEMA_TEXT = `{
  "type": "object",
  "properties": { "answer": { "type": "string" } },
  "required": ["answer"],
  "additionalProperties": false
}`;

export interface ChatOptions {
  model: string;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  seed: number | null;
  systemPrompt: string;
  showReasoning: boolean;
  /** 允许模型调用内置联网搜索（工具由 GUI 执行，llama.cpp 自己不联网） */
  webSearch: boolean;
  /** 允许模型调用用户在聊天设置里配的 MCP 工具（同样由 GUI 执行，见 `src-tauri/src/mcp.rs`） */
  mcpTools: boolean;
  /** Enter 直接发送（否则 Enter 换行、Ctrl+Enter 发送）；用户 m07816 第 3 点 */
  enterSends: boolean;
  /** 允许「回到历史点 / 改写回答 / 重新生成」（上游 `edit-and-rewind` 开关） */
  chatEdit: boolean;
  /** 聊天页左侧的会话列表是否显示（上游 `saved chats list` 开关） */
  chatList: boolean;
  /** 生成中又点发送时怎么办：等待（忽略）/ 排队 / 打断当前这轮 */
  busyMode: "wait" | "queue" | "interrupt";
  /** 渲染 KaTeX 数学公式（离线，字体随包里带） */
  showMath: boolean;
  /** 高级回答设置（输出格式 / token 偏好 / 停止串 / 生成参数）；只对 Strata 通道发送 */
  advanced: ChatAdvanced;
  /** 固定的长文复用（上游 `strata_prefix`）；只对 Strata 通道发送 */
  fixedPrefix: ChatFixedPrefix | null;
  /** 速度预测（上游 `experimental_speed_projection`） */
  esp: boolean;
  /** MCP 工具交给 Strata 引擎执行（上游 `strata_mcp`）；只有 Strata 通道认 */
  mcpServer: boolean;
}

/** 上游 `DEFAULT_COMMON_CHAT_DEFAULTS` 的同一组值（mcp 字段本工程没有） */
export const DEFAULT_CHAT_OPTIONS: Readonly<ChatOptions> = Object.freeze({
  model: "",
  reasoningEffort: "high",
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  maxTokens: 0,
  seed: null,
  systemPrompt: "",
  showReasoning: true,
  webSearch: false,
  mcpTools: false,
  enterSends: true,
  chatEdit: true,
  chatList: true,
  busyMode: "wait",
  showMath: true,
  advanced: {
    responseFormat: "text" as ChatResponseFormat,
    schemaName: "answer",
    schemaText: DEFAULT_SCHEMA_TEXT,
    logitBiasText: "",
    stop: [],
    minP: null,
    repetitionPenalty: null,
    presencePenalty: null,
    frequencyPenalty: null,
    penaltyLastN: null,
  },
  fixedPrefix: null,
  esp: true,
  mcpServer: false,
});

function finiteOrNull(value: unknown, min: number, max = Number.POSITIVE_INFINITY, openMin = false): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    (openMin ? value > min : value >= min) &&
    value <= max
    ? value
    : null;
}

function normalizeAdvanced(value: unknown): ChatAdvanced {
  const base = DEFAULT_CHAT_OPTIONS.advanced;
  const stored = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const stop = Array.isArray(stored.stop)
    ? stored.stop.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 4)
    : [];
  return {
    responseFormat:
      typeof stored.responseFormat === "string" &&
      ["text", "json_object", "json_schema"].includes(stored.responseFormat)
        ? (stored.responseFormat as ChatResponseFormat)
        : base.responseFormat,
    schemaName: typeof stored.schemaName === "string" ? stored.schemaName : base.schemaName,
    schemaText: typeof stored.schemaText === "string" ? stored.schemaText : base.schemaText,
    logitBiasText: typeof stored.logitBiasText === "string" ? stored.logitBiasText : base.logitBiasText,
    stop,
    minP: finiteOrNull(stored.minP, 0, 1),
    repetitionPenalty: finiteOrNull(stored.repetitionPenalty, 0, Number.POSITIVE_INFINITY, true),
    presencePenalty: finiteOrNull(stored.presencePenalty, 0),
    frequencyPenalty: finiteOrNull(stored.frequencyPenalty, 0),
    penaltyLastN:
      typeof stored.penaltyLastN === "number" && Number.isSafeInteger(stored.penaltyLastN) && stored.penaltyLastN >= 0
        ? stored.penaltyLastN
        : null,
  };
}

function normalizeFixedPrefix(value: unknown): ChatFixedPrefix | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (typeof stored.messageId !== "string" || !stored.messageId) return null;
  const chars =
    typeof stored.chars === "number" && Number.isSafeInteger(stored.chars) && stored.chars > 0
      ? stored.chars
      : undefined;
  return chars === undefined ? { messageId: stored.messageId } : { messageId: stored.messageId, chars };
}

export function normalizeChatOptions(value: unknown): ChatOptions {
  const stored =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const inRange = (input: unknown, min: number, max: number, openMin = false): input is number =>
    typeof input === "number" &&
    Number.isFinite(input) &&
    (openMin ? input > min : input >= min) &&
    input <= max;
  return {
    model: typeof stored.model === "string" ? stored.model : DEFAULT_CHAT_OPTIONS.model,
    reasoningEffort:
      typeof stored.reasoningEffort === "string" &&
      ["off", "low", "medium", "high"].includes(stored.reasoningEffort)
        ? (stored.reasoningEffort as ReasoningEffort)
        : DEFAULT_CHAT_OPTIONS.reasoningEffort,
    temperature: inRange(stored.temperature, 0, 2)
      ? stored.temperature
      : DEFAULT_CHAT_OPTIONS.temperature,
    topP: inRange(stored.topP, 0, 1, true) ? stored.topP : DEFAULT_CHAT_OPTIONS.topP,
    topK:
      typeof stored.topK === "number" && Number.isInteger(stored.topK) && stored.topK >= 1 && stored.topK <= 64
        ? stored.topK
        : DEFAULT_CHAT_OPTIONS.topK,
    maxTokens:
      typeof stored.maxTokens === "number" &&
      Number.isSafeInteger(stored.maxTokens) &&
      stored.maxTokens >= 0
        ? stored.maxTokens
        : DEFAULT_CHAT_OPTIONS.maxTokens,
    seed:
      typeof stored.seed === "number" && Number.isSafeInteger(stored.seed) && stored.seed > 0
        ? stored.seed
        : DEFAULT_CHAT_OPTIONS.seed,
    systemPrompt:
      typeof stored.systemPrompt === "string" ? stored.systemPrompt : DEFAULT_CHAT_OPTIONS.systemPrompt,
    showReasoning:
      typeof stored.showReasoning === "boolean" ? stored.showReasoning : DEFAULT_CHAT_OPTIONS.showReasoning,
    webSearch: typeof stored.webSearch === "boolean" ? stored.webSearch : DEFAULT_CHAT_OPTIONS.webSearch,
    mcpTools: typeof stored.mcpTools === "boolean" ? stored.mcpTools : DEFAULT_CHAT_OPTIONS.mcpTools,
    enterSends: typeof stored.enterSends === "boolean" ? stored.enterSends : DEFAULT_CHAT_OPTIONS.enterSends,
    chatEdit: typeof stored.chatEdit === "boolean" ? stored.chatEdit : DEFAULT_CHAT_OPTIONS.chatEdit,
    chatList: typeof stored.chatList === "boolean" ? stored.chatList : DEFAULT_CHAT_OPTIONS.chatList,
    busyMode:
      typeof stored.busyMode === "string" && ["wait", "queue", "interrupt"].includes(stored.busyMode)
        ? (stored.busyMode as ChatOptions["busyMode"])
        : DEFAULT_CHAT_OPTIONS.busyMode,
    showMath: typeof stored.showMath === "boolean" ? stored.showMath : DEFAULT_CHAT_OPTIONS.showMath,
    advanced: normalizeAdvanced(stored.advanced),
    fixedPrefix: normalizeFixedPrefix(stored.fixedPrefix),
    esp: typeof stored.esp === "boolean" ? stored.esp : DEFAULT_CHAT_OPTIONS.esp,
    mcpServer:
      typeof stored.mcpServer === "boolean" ? stored.mcpServer : DEFAULT_CHAT_OPTIONS.mcpServer,
  };
}

/** 上游 `parseChatLogitBias`：接受 `{"<id>": bias}` 或 `[[id, bias]]` */
export function parseChatLogitBias(text: string): Record<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("logit_bias 不是有效 JSON");
  }
  const entries: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];
  if (!Array.isArray(value) && (!value || typeof value !== "object")) {
    throw new Error("logit_bias 需为对象或 [token_id, bias] 列表");
  }
  const pairs = Array.isArray(value);
  const out: Record<string, number> = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("logit_bias 每项需包含 token ID 与偏置");
    const [id, raw] = entry;
    if ((typeof id !== "number" && typeof id !== "string") || !/^\d+$/.test(String(id))) {
      throw new Error("logit_bias token ID 需为非负整数");
    }
    const token = Number(id);
    if (!Number.isSafeInteger(token) || token > 2147483647) throw new Error("logit_bias token ID 超出词表范围");
    if (Object.hasOwn(out, String(token))) throw new Error("logit_bias 包含重复 token ID");
    const bias = pairs && raw === false ? -100 : raw;
    if (typeof bias !== "number" || !Number.isFinite(bias) || bias < -100 || bias > 100) {
      throw new Error("logit_bias 偏置需在 -100 到 100");
    }
    out[String(token)] = bias;
  }
  return out;
}

function parseChatSchema(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("JSON Schema 不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON Schema 根节点需为对象");
  if ((value as Record<string, unknown>).type !== "object") throw new Error("JSON Schema 根类型必须只接受对象");
  return value as Record<string, unknown>;
}

/** 上游 `buildAdvancedChatFields`：生成参数 / 停止串 / token 偏好 / 输出格式 / 固定前缀 */
export function buildAdvancedChatFields(options: ChatOptions): Record<string, unknown> {
  const advanced = options.advanced;
  const out: Record<string, unknown> = {};
  if (advanced.minP !== null) out.min_p = advanced.minP;
  if (advanced.repetitionPenalty !== null) out.repetition_penalty = advanced.repetitionPenalty;
  if (advanced.presencePenalty !== null) out.presence_penalty = advanced.presencePenalty;
  if (advanced.frequencyPenalty !== null) out.frequency_penalty = advanced.frequencyPenalty;
  if (advanced.penaltyLastN !== null) out.penalty_last_n = advanced.penaltyLastN;
  if (advanced.stop.length > 0) out.stop = advanced.stop;
  if (advanced.logitBiasText.trim()) {
    const bias = parseChatLogitBias(advanced.logitBiasText);
    if (Object.keys(bias).length > 0) out.logit_bias = bias;
  }
  if (advanced.responseFormat === "json_object") out.response_format = { type: "json_object" };
  if (advanced.responseFormat === "json_schema") {
    const name = advanced.schemaName.trim();
    if (!name || name.length > 64 || !/^[\w-]+$/.test(name)) {
      throw new Error("格式名称需为 1–64 位英文字母、数字、下划线或连字符");
    }
    out.response_format = {
      type: "json_schema",
      json_schema: { name, strict: true, schema: parseChatSchema(advanced.schemaText) },
    };
  }
  return out;
}


export function buildSharedDefaults(options: ChatOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (options.reasoningEffort) {
    out.reasoning_effort = options.reasoningEffort === "off" ? "none" : options.reasoningEffort;
  }
  // temperature 为 0 时 top_p/top_k 无意义，别发（上游同）
  if (options.temperature > 0) {
    out.top_p = options.topP;
    out.top_k = options.topK ?? 20;
  }
  out.temperature = options.temperature;
  if (options.maxTokens > 0) out.max_tokens = options.maxTokens;
  if (options.seed !== null) out.seed = options.seed;
  return out;
}

/**
 * 文本附件 → 围栏代码块。围栏长度按内容里最长反引号串加一，
 * 否则附件里带 ``` 会把代码块提前截断（上游同）。
 */
export function attachmentText(file: ChatAttachment): string {
  if (file.content.includes("\0")) throw new Error(`${file.name} 包含二进制内容，请使用文本文件`);
  if (new TextEncoder().encode(file.content).length > 512 * 1024) {
    throw new Error(`${file.name} 超出 512 KB 文本附件限制`);
  }
  const longest = Math.max(0, ...(file.content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(2, longest + 1));
  return `File: ${file.name}\n${fence}\n${file.content}\n${fence}`;
}

const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/i;

function apiMessage(message: ChatTurn, supportsImages: boolean): Record<string, unknown> {
  // 工具结果原样回填：llama.cpp 靠 tool_call_id 把结果对回那次调用
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId ?? "", content: message.content };
  }
  const attachments = message.attachments ?? [];
  const texts: string[] = [];
  if (message.content) texts.push(message.content);
  for (const file of attachments) {
    if (file.type === "text") texts.push(attachmentText(file));
    else if (file.type !== "image") throw new Error("仅支持文本文件和图片附件");
  }
  const content = texts.filter(Boolean).join("\n\n");
  const calls = message.toolCalls ?? [];
  const extra =
    calls.length > 0
      ? {
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {};
  const images = attachments.filter((file) => file.type === "image");
  if (images.length === 0) return { role: message.role, content, ...extra };
  if (!supportsImages) throw new Error("当前模型未确认支持图片，请换视觉模型");
  const parts: Record<string, unknown>[] = [{ type: "text", text: content }];
  for (const image of images) {
    if (!IMAGE_MIME.test(image.mimeType)) throw new Error(`${image.name} 图片格式不受支持`);
    parts.push({ type: "image_url", image_url: { url: image.content } });
  }
  return { role: message.role, content: parts, ...extra };
}

/** 组装 `/v1/chat/completions` 的请求体（上游 `buildChatRequest` 的本工程版） */
export function buildChatRequest(
  messages: ChatTurn[],
  options: ChatOptions,
  supportsImages = false,
  tools: ToolSpec[] = [],
  /** 模型走 Strata 通道时才发高级字段（llama.cpp 没有这些端点） */
  strata = false,
): Record<string, unknown> {
  if (!options.model.trim()) throw new Error("请先选择模型");
  const api: Record<string, unknown>[] = [];
  if (options.systemPrompt.trim()) api.push({ role: "system", content: options.systemPrompt.trim() });
  const advanced: Record<string, unknown> = strata ? buildAdvancedChatFields(options) : {};
  if (strata && options.advanced.responseFormat !== "text" && tools.length > 0) {
    throw new Error("JSON 输出与工具调用互斥，请先关闭联网搜索 / MCP");
  }
  let prefixIndex = -1;
  for (const message of messages) {
    // 出错/被停掉的那条不参与下一轮上下文（上游同）
    if (message.error) continue;
    if (options.fixedPrefix && message.id === options.fixedPrefix.messageId) {
      if (prefixIndex !== -1) throw new Error("固定前缀消息 ID 重复");
      if (message.role !== "user") throw new Error("固定前缀必须选择用户文档消息");
      prefixIndex = api.length;
    }
    api.push(apiMessage(message, supportsImages));
  }
  if (strata && options.fixedPrefix) {
    if (prefixIndex < 0) throw new Error("固定前缀消息不在当前会话，请重新选择");
    if (messages.some((message) => message.attachments?.some((file) => file.type === "image"))) {
      throw new Error("固定前缀不支持包含图片的请求");
    }
    const text = api[prefixIndex]?.content;
    if (typeof text !== "string" || !text.length) throw new Error("固定前缀需非空文本");
    const chars = options.fixedPrefix.chars;
    const length = Array.from(text).length;
    if (
      chars !== undefined &&
      (chars > length || (prefixIndex === api.length - 1 && chars >= length))
    ) {
      throw new Error("固定前缀字符边界需在文档内，并给问题保留内容");
    }
    if (chars === undefined && prefixIndex === api.length - 1) {
      throw new Error("固定文档之后需要一条提问；或设置文档内的字符边界");
    }
    const offset = advanced.response_format && api[0]?.role !== "system" ? 1 : 0;
    advanced.strata_prefix =
      chars === undefined ? { messages: prefixIndex + 1 + offset } : { message: prefixIndex + offset, chars };
  }
  if (strata && options.esp) advanced.experimental_speed_projection = true;
  if (strata && options.mcpServer) {
    if (tools.length > 0) throw new Error("MCP 交给引擎执行时不要同时带本地工具，请关掉「MCP 工具」");
    advanced.strata_mcp = true;
  }
  return {
    model: options.model,
    messages: api,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
    ...buildSharedDefaults(options),
    ...advanced,
  };
}

/**
 * SSE 组帧：任意切块都要能拼回完整事件（CR/LF、多行 data、UTF-8 边界）。
 * `push` 喂原始字节或字符串，`finish` 收尾把残留行吐出去。
 */
export class SSEParser {
  /** 单个事件的最大缓冲：上游发疯（或没按 SSE 格式回）时不能无限吃内存（审查发现） */
  private static readonly MAX_BUFFER = 1_048_576;

  private buffer = "";
  private data: string[] = [];
  private readonly decoder = new TextDecoder();

  constructor(private readonly onData: (data: string) => void) {}

  push(chunk: string | Uint8Array): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.drain(false);
    if (this.buffer.length > SSEParser.MAX_BUFFER) {
      this.buffer = "";
      this.data = [];
      throw new Error("SSE 数据块超过 1 MiB，已中断");
    }
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.dispatch();
  }

  private dispatch(): void {
    if (this.data.length === 0) return;
    const payload = this.data.join("\n");
    this.data = [];
    this.onData(payload);
  }

  private drain(final: boolean): void {
    for (;;) {
      const match = /[\r\n]/.exec(this.buffer);
      if (!match) break;
      const index = match.index;
      // 末尾孤零零一个 \r：可能是 \r\n 的前半，等下一块
      if (!final && this.buffer[index] === "\r" && index === this.buffer.length - 1) break;
      const count = this.buffer[index] === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + count);
      this.line(line);
    }
    if (final && this.buffer) {
      const line = this.buffer;
      this.buffer = "";
      this.line(line);
    }
  }

  private line(raw: string): void {
    // 空行 = 一个事件结束
    if (raw === "") {
      this.dispatch();
      return;
    }
    // 冒号开头是注释（llama.cpp 的心跳就是 `:`）
    if (raw.startsWith(":")) return;
    const colon = raw.indexOf(":");
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? "" : raw.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
  }
}

/** 一条 SSE `data:` 载荷解码后的增量 */
export interface ChatDelta {
  content?: string;
  reasoning?: string;
  usage?: ChatUsage;
  timings?: ChatSpeed;
  finishReason?: string;
  responseId?: string;
  done?: boolean;
  /** 流里到达的工具调用分片，按 `index` 累积 */
  toolCalls?: ToolCallFragment[];
  error?: string;
}

/** 解码一条 `data:` 载荷（上游 `decodeChatChunk` 的本工程版） */
export function decodeChatChunk(data: string): ChatDelta[] {
  if (data.trim() === "[DONE]") return [{ done: true }];
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw new Error("服务返回了无效的 SSE JSON");
  }
  const out: ChatDelta[] = [];
  const error = chunk.error as { message?: unknown } | string | undefined;
  if (error) {
    out.push({ error: typeof error === "string" ? error : String((error as { message?: unknown }).message ?? error) });
    return out;
  }
  if (typeof chunk.id === "string") out.push({ responseId: chunk.id });
  if (chunk.usage && typeof chunk.usage === "object") out.push({ usage: chunk.usage as ChatUsage });
  const timings = parseChatSpeed(chunk.timings);
  if (timings) out.push({ timings });
  const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as
    | {
        delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
        finish_reason?: unknown;
      }
    | undefined;
  if (choice?.finish_reason != null) out.push({ finishReason: String(choice.finish_reason) });
  const rawCalls = choice?.delta?.tool_calls;
  if (Array.isArray(rawCalls)) {
    const fragments: ToolCallFragment[] = [];
    for (const item of rawCalls) {
      if (!item || typeof item !== "object") continue;
      const call = item as {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      };
      fragments.push({
        index: typeof call.index === "number" ? call.index : 0,
        ...(typeof call.id === "string" ? { id: call.id } : {}),
        ...(typeof call.function?.name === "string" ? { name: call.function.name } : {}),
        ...(typeof call.function?.arguments === "string" ? { arguments: call.function.arguments } : {}),
      });
    }
    if (fragments.length > 0) out.push({ toolCalls: fragments });
  }
  const content = choice?.delta?.content;
  const reasoning = choice?.delta?.reasoning_content;
  if (typeof content === "string" || typeof reasoning === "string") {
    out.push({
      ...(typeof content === "string" ? { content } : {}),
      ...(typeof reasoning === "string" ? { reasoning } : {}),
    });
  }
  return out;
}

/** 一次请求的执行状态机（照上游 `newChatExecution` / `advanceChatExecution` / `finishChatExecution`） */
export function newChatExecution(operationId: string): ChatExecution {
  return { phase: "waiting", startedAt: Date.now(), operationId };
}

export function advanceChatExecution(execution: ChatExecution, delta: ChatDelta): ChatExecution {
  const next: ChatExecution = { ...execution };
  if (!next.requestStartedAt) next.requestStartedAt = Date.now();
  if (delta.responseId && !next.responseId) next.responseId = delta.responseId;
  if (delta.reasoning && next.phase === "waiting") next.phase = "reasoning";
  if (delta.content) {
    if (next.firstTokenMs === undefined) next.firstTokenMs = Date.now() - next.startedAt;
    next.phase = "generating";
  }
  return next;
}

export function finishChatExecution(
  execution: ChatExecution,
  cancelled: boolean,
  failed: boolean,
): ChatExecution {
  return {
    ...execution,
    phase: failed ? "failed" : cancelled ? "cancelled" : "completed",
    finishedAt: Date.now(),
    firstVisibleMs: execution.firstTokenMs,
  };
}

/** 会话标题：取首句前 42 个字符（上游同） */
export function conversationTitle(content: string, fallbackName?: string): string {
  const trimmed = content.trim();
  if (trimmed) return trimmed.slice(0, 42);
  return fallbackName ?? "未命名会话";
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
