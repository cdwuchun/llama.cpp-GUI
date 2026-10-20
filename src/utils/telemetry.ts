/**
 * 状态栏胶囊与弹层的采样累积 + 迷你折线。
 *
 * 照搬上游 `E:\Code\strata-manager-main\apps\desktop\src\serviceStatusTelemetry.ts`
 * （用户 m05241：监控 UI 原封原样照搬上游）—— 保留「缺采样处断开折线」和
 * 「按真实时间间隔铺 x 轴」这两个行为，否则空闲期的断档会被画成一条直线。
 */
import type { MonitorSnapshot } from "../types";

export interface TelemetryPoint {
  at: number;
  decode: number | null;
  prefill: number | null;
  gpu: number | null;
}

export interface TelemetryHistory {
  identity: string;
  points: TelemetryPoint[];
}

export type TelemetrySeries = "decode" | "prefill" | "gpu";

/** 非负有限数才算有效采样，其余（null / NaN / 负数）一律当缺失。 */
export const telemetryNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** 状态栏口径的一刻读数：只有真的在生成/预填充时才记速度。 */
export function telemetryPoint(
  at: number,
  metric?: { state: string; decodeTokS: number | null; prefillTokS: number | null; gpuUtil: number | null },
  loaded?: boolean,
): TelemetryPoint {
  return {
    at,
    // 空闲时引擎自报的 decode 速率是上一次请求的残留，不是新采样。
    decode: loaded === true && metric?.state === "generating" ? telemetryNumber(metric.decodeTokS) : null,
    prefill:
      loaded === true && ["reading", "prefill"].includes(metric?.state ?? "")
        ? telemetryNumber(metric?.prefillTokS ?? null)
        : null,
    gpu: telemetryNumber(metric?.gpuUtil),
  };
}

/** 只保留 3 分钟内的点、最多 60 个；instance 变了（换模型/换端口）就重新开始。 */
export function appendTelemetry(previous: TelemetryHistory, identity: string, point: TelemetryPoint): TelemetryHistory {
  const points = previous.identity === identity ? previous.points : [];
  if (!Number.isFinite(point.at) || point.at <= 0 || (points.at(-1)?.at ?? 0) >= point.at) {
    return previous.identity === identity ? previous : { identity, points: [] };
  }
  return { identity, points: [...points, point].filter((sample) => point.at - sample.at <= 180_000).slice(-60) };
}

/** 生成 viewBox 0 0 160 48 的折线路径；缺失点断开成多段。 */
export function telemetrySparkline(points: TelemetryPoint[], series: TelemetrySeries, ceiling?: number) {
  const valid = points.filter((point) => telemetryNumber(point[series]) !== null);
  const max = ceiling ?? Math.max(1, ...valid.map((point) => point[series]!));
  const from = points[0]?.at ?? 0;
  const to = points.at(-1)?.at ?? from;
  const paths: string[] = [];
  let path = "";
  let last: { x: number; y: number } | undefined;
  for (const point of points) {
    const value = telemetryNumber(point[series]);
    if (value === null) {
      if (path) paths.push(path);
      path = "";
      continue;
    }
    const x = to > from ? 4 + ((point.at - from) / (to - from)) * 152 : 80;
    const y = 44 - Math.min(1, value / max) * 38;
    path += `${path ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    last = { x, y };
  }
  if (path) paths.push(path);
  return { paths, last, count: valid.length };
}

/** 状态栏与弹层共用的这一刻读数（上游是 Rust 侧 normalize 成 MetricSnapshot，我们在前端拼）。 */
export interface LiveMetric {
  state: "waiting" | "idle" | "reading" | "generating" | "queued" | "loading";
  running: number | null;
  queued: number | null;
  decodeTokS: number | null;
  prefillTokS: number | null;
  gpuUtil: number | null;
  cpuUtil: number | null;
  gpuTemperature: number | null;
  gpuPower: number | null;
  /** 字节。 */
  gpuMemoryUsed: number | null;
  gpuMemoryTotal: number | null;
  ramUsed: number | null;
  ramTotal: number | null;
  maxContext: number | null;
  /** PCIe 下行吞吐（MB/s）。 */
  pcieRx: number | null;
  /** 磁盘读/写吞吐（MB/s）。 */
  diskRead: number | null;
  diskWrite: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  at: number;
}

/** 最近一次完成的请求（速度与上下文占用都取自它）。 */
export interface LastTurn {
  at: number;
  promptTokens: number | null;
  outputTokens: number | null;
  decodeTokS: number | null;
  prefillTokS: number | null;
  /** 提示词缓存复用的 token 数（`timings.cache_n`），拿它算「命中率」。 */
  cacheTokens?: number | null;
  /** 端到端耗时（毫秒），状态栏与「最近请求」表都要。 */
  elapsedMs?: number | null;
}

/** 「最近请求」表的一行（上游 req-card 的 9 列，字段按 llama.cpp 口径）。 */
export interface RecentTurn extends LastTurn {
  id: string;
  /** 这次请求发给哪个模型 —— 换模型后「最近请求」只显示当前模型的（用户 m06949）。 */
  model: string;
  /** 成功 / 失败。失败只有耗时与错误，没有速度。 */
  ok: boolean;
  error?: string | null;
}

/** 保留最近多少条请求（上游表格最多 12 行）。 */
export const RECENT_TURN_LIMIT = 12;

const toNumber = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * 把采集快照 + 本地活动状态拼成状态栏口径的读数。
 * `busy` 为真有请求在跑，`reading` 表示还在预填充阶段。
 */
export function buildLiveMetric(input: {
  snapshot: MonitorSnapshot | null;
  busy: boolean;
  reading: boolean;
  queued: number;
  lastTurn: LastTurn | null;
  maxContext: number | null;
  /** 引擎自报的实时输入速度（Strata 的 /metrics → live.prefill_tok_s_mean）；llama.cpp 没有。 */
  livePrefillTokS?: number | null;
}): LiveMetric | null {
  const { snapshot, busy, reading, queued, lastTurn, maxContext, livePrefillTokS } = input;
  if (!snapshot) return null;
  const now = snapshot.now;
  const gpu = now.gpu;
  const state: LiveMetric["state"] = busy ? (reading ? "reading" : "generating") : queued > 0 ? "queued" : "idle";
  const mib = 1024 * 1024;
  // 「最近输入」照上游 metrics.ts:49 的口径（用户 m06282）：
  //   读取中 = 当前（引擎实时均值，拿不到就退最近一次）、生成中 = 本次、其余 = 最近一次。
  // 「最近生成」同理：生成中取本次，其余取最近一次（两者都落在 lastTurn 上）。
  const prefillTokS =
    reading && livePrefillTokS != null ? livePrefillTokS : (lastTurn?.prefillTokS ?? null);
  return {
    state,
    running: busy ? Math.max(1, 1) : 0,
    queued,
    decodeTokS: lastTurn?.decodeTokS ?? null,
    prefillTokS,
    gpuUtil: toNumber(gpu?.utilization),
    cpuUtil: toNumber(now.cpuPercent),
    gpuTemperature: toNumber(gpu?.temperature),
    gpuPower: toNumber(gpu?.powerW),
    gpuMemoryUsed: gpu?.memUsedMib == null ? null : gpu.memUsedMib * mib,
    gpuMemoryTotal: gpu?.memTotalMib == null ? null : gpu.memTotalMib * mib,
    ramUsed: toNumber(now.memUsed),
    ramTotal: toNumber(now.memTotal),
    maxContext,
    pcieRx: toNumber(gpu?.pcieRxMb ?? null),
    diskRead: toNumber(now.diskReadMb),
    diskWrite: toNumber(now.diskWriteMb),
    promptTokens: lastTurn?.promptTokens ?? null,
    outputTokens: lastTurn?.outputTokens ?? null,
    at: now.at,
  };
}
