/**
 * 直连 llama-server（router mode）的 HTTP 客户端。
 *
 * 方案决定：管理数据由前端直接访问 router，Tauri 只负责系统能力（进程、文件、设置）。
 * router 默认 CORS 放开（启动时会有告警），因此 webview 可直接 fetch。
 *
 * **API key**：只要设置里填了 key，router 就带 `--api-key` 启动，此后**除 `/health` 外
 * 所有端点都要求鉴权**（实测 b10831：`/models`、`/models/load`、`/props`、`/models/sse`
 * 无 key 一律 401 "Invalid API Key"）。llama.cpp 只认请求头
 * （`Authorization: Bearer <key>` 或 `x-api-key: <key>`），**不支持 `?api_key=` 查询参数**，
 * 所以这里不能用 `EventSource`（它无法自定义请求头），SSE 改为 fetch 流式读取。
 */

import type { ModelProps, RouterModel, RouterModelsResponse, RouterSseEvent } from "../types";

/** 当前 API key（空字符串/null 视为未设置）。由 store 在设置变化时同步过来。 */
let apiKey: string | null = null;

/** 同步 API key：设置里改了 key 之后必须调用，否则所有请求都会 401。 */
export function setRouterApiKey(key: string | null | undefined): void {
  apiKey = key?.trim() ? key.trim() : null;
}

/** 当前 key 对应的鉴权请求头（未设置时为空对象）。 */
function authHeaders(): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export function routerBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } };
      return json.error?.message ?? text.slice(0, 300);
    } catch {
      return text.slice(0, 300);
    }
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** 列出模型（`reload=true` 会让 router 重新读取 preset 文件）。 */
export async function fetchModels(port: number, reload = false): Promise<RouterModel[]> {
  const url = `${routerBase(port)}/models${reload ? "?reload=1" : ""}`;
  const res = await fetch(url, { method: "GET", headers: authHeaders() });
  if (!res.ok) {
    throw new Error(`GET /models 失败：${await readError(res)}`);
  }
  const json = (await res.json()) as RouterModelsResponse;
  return json.data ?? [];
}

export async function loadModel(port: number, id: string): Promise<void> {
  const res = await fetch(`${routerBase(port)}/models/load`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ model: id }),
  });
  if (!res.ok) {
    throw new Error(`加载 ${id} 失败：${await readError(res)}`);
  }
}

export async function unloadModel(port: number, id: string): Promise<void> {
  const res = await fetch(`${routerBase(port)}/models/unload`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ model: id }),
  });
  if (!res.ok) {
    throw new Error(`卸载 ${id} 失败：${await readError(res)}`);
  }
}

/** 运行态详情（仅已加载模型可用）。 */
export async function fetchProps(port: number, id: string): Promise<ModelProps> {
  const res = await fetch(`${routerBase(port)}/props?model=${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`GET /props 失败：${await readError(res)}`);
  }
  return (await res.json()) as ModelProps;
}

/** SSE 断线重连间隔 */
const SSE_RETRY_DELAY_MS = 1500;
/** 鉴权类的连续失败重试多少次后放弃（key 不对，重试再多次也没用） */
const SSE_MAX_RETRY_AUTH = 6;
/** 网络类的连续失败重试多少次后放弃（≈60 秒，要扛得住 router 重启 + 版本探测） */
const SSE_MAX_RETRY_NETWORK = 40;
/**
 * 「这条连接算真的连上了」的时长门槛。
 *
 * 连接活过这个时长就认为确实连上过（之后的断开只是偶发），连续失败计数清零；
 * 没活到就累加 —— 「连上即断」若一直清零会转成死循环，若一直累加又会让几小时里
 * 分散发生的偶发中断把重试额度耗光。
 */
const SSE_STABLE_MS = 3000;
/**
 * 攒着还没成块的缓冲上限（事件之间靠空行分隔，见 `consume`）。
 *
 * llama.cpp 的事件都是几十~几百字节的 JSON，1 MiB 是异常兜底：服务端一旦持续发
 * 不含空行的数据，原来这个字符串会无限涨下去，把 WebView 的内存吃光。
 * 到上限只能把积压丢掉 —— 后面再拼出来的块也已经是残缺的 JSON，解析必然失败。
 */
const SSE_MAX_BUFFER_CHARS = 1024 * 1024;

/** 带"这是鉴权失败"标记的错误，用来区分重试策略。 */
type SseError = Error & { auth?: boolean };

/**
 * 订阅模型状态事件（`/models/sse`）。返回关闭函数。
 *
 * 用 `fetch` 流而不是 `EventSource`：后者无法带鉴权请求头，而 router 配了 API key 时
 * `/models/sse` 同样要 401。断线会自动重连（原来的 `EventSource` 也自带重连）。
 */
export function subscribeModelEvents(
  port: number,
  onEvent: (event: RouterSseEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  let closed = false;
  let failures = 0;
  const controller = new AbortController();

  const consume = async (res: Response) => {
    if (!res.body) throw new Error("SSE 响应没有可读的流");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // 事件块之间是空行（llama.cpp 用 \n\n，稳妥起见也认 \r\n\r\n）
      let sep = /\r?\n\r?\n/.exec(buffer);
      while (sep) {
        const block = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        for (const raw of block.split(/\r?\n/)) {
          const line = raw.trimStart();
          if (!line.startsWith("data:")) continue; // 其余是 event:/id:/注释行
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            onEvent(JSON.parse(payload) as RouterSseEvent);
          } catch {
            /* 忽略无法解析的事件 */
          }
        }
        sep = /\r?\n\r?\n/.exec(buffer);
      }
      // 一直没有分隔符（服务端不正常）：别让 buffer 无限涨，丢掉积压
      if (buffer.length > SSE_MAX_BUFFER_CHARS) buffer = "";
    }
  };

  /**
   * 记一次「这条连接结束了」（正常收尾与异常断开都要走这里）。
   *
   * 原先只在流正常结束那条路径判断 `Date.now() - startedAt > 3000`，
   * 而 `reader.read()` 抛错（网络中断、router 被外部杀掉）走 catch 时是无条件
   * `failures += 1`：40 次异常中断（可能分散在几小时里）之后订阅就永久停掉，
   * 界面上的模型状态与加载进度再也不刷新。现在两条路径共用同一条规则：
   * 只看「连接活了多久」，与「怎么结束的」无关。
   */
  const noteAttempt = (startedAt: number): void => {
    if (Date.now() - startedAt > SSE_STABLE_MS) failures = 0;
    else failures += 1;
  };

  const run = async () => {
    while (!closed) {
      const startedAt = Date.now();
      try {
        const res = await fetch(`${routerBase(port)}/models/sse`, {
          headers: { accept: "text/event-stream", ...authHeaders() },
          signal: controller.signal,
        });
        if (!res.ok) {
          const err: SseError = new Error(`GET /models/sse 失败：${await readError(res)}`);
          if (res.status === 401 || res.status === 403) err.auth = true;
          throw err;
        }
        await consume(res);
        // 服务端正常关闭流（router 被停掉、重启）：连够 3 秒就当偶发断开，计数清零后继续等它回来
        noteAttempt(startedAt);
      } catch (err) {
        if (closed) return;
        // 鉴权失败不看连接时长：key 不对不会因为等得久就变对，仍按原样累加
        // （否则会退化成每 1.5 秒一次的永久 401 重试，白白刷日志）。
        if ((err as SseError)?.auth) failures += 1;
        else noteAttempt(startedAt);
        // 鉴权失败重试无意义；网络失败多半是 router 正在重启（停止→启动之间，
        // 或者换了端口），这里必须多撑一会儿，否则订阅会永久失效、加载进度再也不更新。
        const limit = (err as SseError)?.auth ? SSE_MAX_RETRY_AUTH : SSE_MAX_RETRY_NETWORK;
        if (failures > limit) {
          onError?.(err);
          return;
        }
      }
      if (closed) return;
      await new Promise((resolve) => setTimeout(resolve, SSE_RETRY_DELAY_MS));
    }
  };

  void run().catch((err) => {
    if (!closed) onError?.(err);
  });

  return () => {
    closed = true;
    controller.abort();
  };
}

/** 解析 router 返回的子实例命令行里的端口。 */
export function portFromArgs(args: string[] | undefined): number | null {
  if (!args) return null;
  const idx = args.findIndex((a) => a === "--port");
  if (idx >= 0 && idx + 1 < args.length) {
    const port = Number(args[idx + 1]);
    if (Number.isFinite(port) && port > 0) return port;
  }
  return null;
}

/**
 * 可以打开 llama.cpp 自带聊天界面的模型：运行中、且拿到了子实例端口。
 *
 * 每个模型是**独立**的 llama-server 子实例（各自端口、各自 WebUI），
 * 所以同时跑多个模型时是**可选的**，不能想当然地打开第一个。
 */
export function chatTargets(models: RouterModel[]): { id: string; port: number }[] {
  const out: { id: string; port: number }[] = [];
  for (const m of models) {
    if (m.status?.value !== "loaded") continue;
    const port = portFromArgs(m.status?.args);
    if (port != null) out.push({ id: m.id, port });
  }
  return out;
}
