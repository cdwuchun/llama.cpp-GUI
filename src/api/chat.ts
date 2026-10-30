/**
 * 聊天补全客户端（走前门 :9090）。
 *
 * 前门是统一入口：请求体里的 `model` 用配置 JSON 的 `name`（铁律 2），
 * 前门按它路由到对应通道与子实例，客户端不需要知道端口。
 *
 * SSE 只能自己读流：带 API key 时 `/v1/chat/completions` 也要鉴权，
 * 而 `EventSource` 无法自定义请求头（同 `api/router.ts` 的理由）。
 *
 * 目前的使用者是上下文档位压测（`utils/contextBenchmark.ts` + 设置里的基准页），
 * 原生聊天 UI 落地时也走这里。
 */

import { authHeaders, routerBase } from "./router";
import { SSEParser, decodeChatChunk, type ChatDelta } from "../utils/chat";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
}

/**
 * llama.cpp 自己报的分段计时（响应里的 `timings`）。
 *
 * 这是**权威值**：只算真实计算时间，不含连接、排队、前门转发与客户端解析。
 * 我们按到达时刻自己算的 prefill / decode 会被上述环节污染（用户 m11542 第 3 点
 * 「预填充和解码数据有问题」），所以有 `timings` 时一律以它为准。
 */
export interface ChatTimings {
  /** `prompt_n`：这次**实际计算**的输入 token 数（不含命中 prompt 缓存的部分） */
  promptN: number | null;
  promptMs: number | null;
  promptPerSecond: number | null;
  /** `predicted_n`：这次生成的 token 数 */
  predictedN: number | null;
  predictedMs: number | null;
  predictedPerSecond: number | null;
  /** `cache_n`：命中 prompt 缓存、没有重算的 token 数 */
  cacheN: number | null;
  /** `draft_n`：投机解码这轮尝试了多少 token */
  draftN: number | null;
  /** `draft_n_accepted`：其中被主模型接受的数量（命中率 = 接受 / 尝试） */
  draftNAccepted: number | null;
}

export interface ChatStreamResult {
  output: string;
  usage: ChatUsage;
  /** 收到响应头的时刻（连接建立 + 排队结束） */
  ttfbMs: number | null;
  /** 第一个可见增量 token 的时刻；没有 `timings` 时才用它估预填充速度 */
  firstTokenMs: number | null;
  wallMs: number;
  finishReason: string | null;
  /** llama.cpp 报的分段计时；拿不到就是 null（例如 Strata 通道） */
  timings: ChatTimings | null;
}

export interface ChatStreamOptions {
  port: number;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 采样等额外字段，原样并进请求体（例如压测的 `reasoning_effort`） */
  extra?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

/** 默认超时：上下文档位压测要预填充到 1M，短了会把正常请求掐断 */
const DEFAULT_TIMEOUT_MS = 600_000;

interface StreamChunk {
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  /** llama.cpp 的分段计时；流式下通常只在最后那个 chunk 里（与 usage 一起） */
  timings?: {
    prompt_n?: number;
    prompt_ms?: number;
    prompt_per_second?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
    cache_n?: number;
    draft_n?: number;
    draft_n_accepted?: number;
  };
  error?: { message?: string };
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * 发一次流式补全，返回完整输出与 usage。
 *
 * 超时用内部 `AbortController` 自己拼（`AbortSignal.any` 在旧 WebView2 上不保险），
 * 外部 signal 只做转发，两者都会中断读取。
 */
export async function streamChat(options: ChatStreamOptions): Promise<ChatStreamResult> {
  const { port, model, messages, maxTokens, temperature, extra, signal, onDelta } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = () => controller.abort();
  signal?.addEventListener("abort", forward, { once: true });

  let output = "";
  let ttfbMs: number | null = null;
  let firstTokenMs: number | null = null;
  let finishReason: string | null = null;
  const usage: ChatUsage = { promptTokens: null, completionTokens: null, cachedTokens: null };
  let timings: ChatTimings | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  try {
    const res = await fetch(`${routerBase(port)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders() },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
        ...(temperature != null ? { temperature } : {}),
        ...(extra ?? {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`聊天请求失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    if (!res.body) throw new Error("聊天响应没有可读的流");
    ttfbMs = performance.now() - started;

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE 事件之间用空行分隔（llama.cpp 是 \n\n，\r\n\r\n 也认）
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        for (const rawLine of block.split(/\r?\n/)) {
          const line = rawLine.trimStart();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === "[DONE]") {
            done = true;
            break;
          }
          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(payload) as StreamChunk;
          } catch {
            continue;
          }
          if (chunk.error?.message) throw new Error(chunk.error.message);
          const choice = chunk.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            if (firstTokenMs === null) firstTokenMs = performance.now() - started;
            output += delta;
            onDelta?.(delta);
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            usage.promptTokens = num(chunk.usage.prompt_tokens);
            usage.completionTokens = num(chunk.usage.completion_tokens);
            usage.cachedTokens = num(chunk.usage.prompt_tokens_details?.cached_tokens);
          }
          if (chunk.timings) {
            timings = {
              promptN: num(chunk.timings.prompt_n),
              promptMs: num(chunk.timings.prompt_ms),
              promptPerSecond: num(chunk.timings.prompt_per_second),
              predictedN: num(chunk.timings.predicted_n),
              predictedMs: num(chunk.timings.predicted_ms),
              predictedPerSecond: num(chunk.timings.predicted_per_second),
              cacheN: num(chunk.timings.cache_n),
              draftN: num(chunk.timings.draft_n),
              draftNAccepted: num(chunk.timings.draft_n_accepted),
            };
          }
        }
        if (done) break;
      }
    }
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    if (signal?.aborted) throw new Error("测试已取消");
    return { output, usage, ttfbMs, firstTokenMs, wallMs: performance.now() - started, finishReason, timings };
  } catch (err) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
    // 提前 return（[DONE] / 超时 / 报错）时流还没读完：取消掉，否则连接留在池里
    // 等 GC（审查发现）
    void reader?.cancel().catch(() => undefined);
  }
}

/**
 * 单模型信息的读取（压测跑到那一档时再拿 max_context 判定档位）。
 *
 * `total_slots` 是 `--parallel` 决定的并发槽数，并发阶梯用它决定压到第几级；
 * 老版本 llama.cpp 没有这个字段，取不到就是 null，由调用方兜底。
 */
export async function fetchChatModelProps(
  port: number,
  model: string,
): Promise<{ maxContext: number | null; totalSlots: number | null }> {
  const res = await fetch(`${routerBase(port)}/props?model=${encodeURIComponent(model)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GET /props 失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    default_generation_settings?: { n_ctx?: number };
    n_ctx?: number;
    total_slots?: number;
  };
  const raw = json.default_generation_settings?.n_ctx ?? json.n_ctx ?? null;
  return { maxContext: num(raw), totalSlots: num(json.total_slots) };
}

/**
 * 从模型列表里读该模型的上下文上限（`/v1/models` 的 `meta.n_ctx`）。
 *
 * 这个端点是**被动**的：前门只读 config 与调度器状态，不会把模型加载起来
 * （对比 `GET /props?model=…`，那个会顺手拉起模型 —— 用户 m11407）。压测页
 * 靠它在档位末尾补上「模型上限」那一档。取不到（例如没配 `--ctx-size`、
 * 或者 Strata 引擎没报）返回 null，由调用方当「未知」处理。
 */
export async function fetchModelContext(port: number, model: string): Promise<number | null> {
  const res = await fetch(`${routerBase(port)}/v1/models`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data?: { id?: string; meta?: { n_ctx?: number } }[] };
  const hit = json.data?.find((item) => item.id === model);
  const value = num(hit?.meta?.n_ctx);
  return value !== null && value > 0 ? value : null;
}

/**
 * 聊天页用的一次流式对话：把 SSE 的每种增量（正文 / 思考 / usage / 结束）都回调出去。
 *
 * 和压测用的 `streamChat` 分开：那个只回调拼好的文本，返回完整结果；
 * 聊天页要边收边把「思考内容」和「正文」分开渲染，还要随时能停。
 * 请求体由 `utils/chat.ts` 的 `buildChatRequest` 组装好后传进来。
 */
export async function streamChatTurn(
  port: number,
  body: Record<string, unknown>,
  onDelta: (delta: ChatDelta) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${routerBase(port)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(`聊天请求失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  if (!res.body) throw new Error("聊天响应没有可读的流");

  const parser = new SSEParser((data) => {
    for (const delta of decodeChatChunk(data)) {
      if (delta.done) return;
      onDelta(delta);
    }
  });
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.finish();
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
