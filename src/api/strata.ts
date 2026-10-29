/**
 * Strata 引擎的少量非 `/v1` 端点（官方 WebUI 从同一个 origin 调的那些）。
 *
 * 目前只用到共享采样：官方 `serve/web/app.js` 的 `loadShared` / `saveShared` 走
 * `GET|POST <engine>/settings`，`{defaults: {...}|null}` —— 服务端把这份默认值当作
 * 「其它应用（omp、API 客户端）的默认采样」。llama.cpp 通道没有这个概念。
 */

/** 引擎根地址（GUI 里 Strata 模型的请求也走这个端口，见 `strataStatus.port`） */
export function strataBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function errorText(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? `HTTP ${status}`;
  } catch {
    return body.slice(0, 200) || `HTTP ${status}`;
  }
}

/** 服务端当前是否把这份默认值共享给其它客户端 */
export async function readSharedSampling(port: number, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(`${strataBase(port)}/settings`, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(errorText(await res.text(), res.status));
  const body = (await res.json()) as { shared?: boolean };
  return body.shared === true;
}

/** 写入（`null` = 取消共享）。返回服务端确认后的状态 */
export async function saveSharedSampling(
  port: number,
  defaults: Record<string, unknown> | null,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetch(`${strataBase(port)}/settings`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ defaults }),
  });
  if (!res.ok) throw new Error(errorText(await res.text(), res.status));
  const body = (await res.json()) as { shared?: boolean };
  return body.shared === true;
}

export interface ImageRequest {
  prompt: string;
  /** "1024x1024" 这类；留空用引擎默认 */
  size?: string;
  n: number;
  steps: number;
  seed: number | null;
}

export interface GeneratedImage {
  /** b64_json 的 Data URL（`url` 形态极少见，直接放原值） */
  src: string;
  revisedPrompt?: string;
}

/**
 * 生图：引擎 `serve/images.py` 的 `POST /v1/images/generations`（OpenAI 形状 + `steps`/`seed`）。
 * 需要引擎运行配置里有 `images` 段（`setup --images` 装过 sd-cli），否则服务端报错。
 */
export async function generateImages(port: number, request: ImageRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
  const body: Record<string, unknown> = {
    prompt: request.prompt,
    n: request.n,
    steps: request.steps,
    response_format: "b64_json",
  };
  if (request.size) body.size = request.size;
  if (request.seed !== null) body.seed = request.seed;
  const res = await fetch(`${strataBase(port)}/v1/images/generations`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(errorText(await res.text(), res.status));
  const payload = (await res.json()) as { data?: { b64_json?: string; url?: string; revised_prompt?: string }[] };
  return (payload.data ?? []).flatMap((item) => {
    const src = item.b64_json ? `data:image/png;base64,${item.b64_json}` : (item.url ?? "");
    return src ? [{ src, revisedPrompt: item.revised_prompt }] : [];
  });
}

