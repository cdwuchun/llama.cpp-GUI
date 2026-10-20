/**
 * 监控页的取数与格式化工具。
 *
 * 折线与数值格式照搬上游 `E:\Code\strata-manager-main\apps\desktop\src\OfficialMonitoring.tsx`
 * （用户 m05241「监控 UI 原封原样照搬上游」）：`sparkPaths` 的 viewBox 是 `0 0 100 32`，
 * 缺采样处断开成多段、末点补一个实心圆、面积闭合到基线；`kfmt` / `ctxfmt` 的口径也一样。
 */

/** 一条序列拆出来的折线（照上游 OfficialMonitoring.tsx:31-51，多段直接拼成一串）。 */
export interface SparkPaths {
  line: string;
  area: string;
  count: number;
  last: { x: number; y: number } | null;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * 照搬上游的几何：`top = max(fixedMax, ...值, 1e-9)`（给定量纲上限时也只往上扩，不截断），
 * 缺采样断开、单点段丢弃、面积从段尾落到底再回到段首闭合。
 */
export function sparkPaths(values: (number | null)[], fixedMax?: number | null): SparkPaths {
  const samples = values.map(finite);
  const known = samples.filter((value): value is number => value !== null);
  if (samples.length < 2 || known.length < 2) return { line: "", area: "", count: known.length, last: null };
  const top = Math.max(fixedMax ?? 0, ...known, 1e-9);
  const segments: { x: number; y: number }[][] = [];
  let segment: { x: number; y: number }[] = [];
  samples.forEach((value, index) => {
    if (value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ x: (index / (samples.length - 1)) * 100, y: 30 - (value / top) * 26 });
  });
  if (segment.length) segments.push(segment);
  const lines: string[] = [];
  const areas: string[] = [];
  let last: { x: number; y: number } | null = null;
  for (const points of segments) {
    if (points.length < 2) continue;
    const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join("");
    lines.push(line);
    const tail = points[points.length - 1];
    areas.push(`${line}L${tail.x.toFixed(2)},32L${points[0].x.toFixed(2)},32Z`);
    last = tail;
  }
  return { line: lines.join(""), area: areas.join(""), count: known.length, last };
}
/** 12_300 → `12.3k`，1_200_000 → `1.2M`；空值 → `—`。 */
export function kfmt(value: number | null | undefined, digits = 1): string {
  const num = finite(value);
  if (num === null) return "—";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(digits)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(digits)}k`;
  return num.toFixed(0);
}

/** 上下文长度口径：131072 → `128K`，1000000 → `1M`。 */
export function ctxfmt(value: number | null | undefined): string {
  const num = finite(value);
  if (num === null) return "—";
  if (num >= 1_048_576) return `${(num / 1_048_576).toFixed(1)}M`;
  if (num >= 1024) return `${Math.round(num / 1024)}K`;
  return String(Math.round(num));
}

/** 字节 → `5.4 GB`。 */
export function bytesfmt(value: number | null | undefined): string {
  const num = finite(value);
  if (num === null) return "—";
  const gb = num / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(num / (1024 * 1024))} MB`;
}

/** 保留一位小数；空值 `—`。 */
export function fixed1(value: number | null | undefined): string {
  const num = finite(value);
  return num === null ? "—" : num.toFixed(1);
}

/** 一个并行槽位在某一刻的样子（字段名各版本不一致，全部容错）。 */
export interface SlotView {
  id: number;
  busy: boolean;
  context: number | null;
  promptTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  speed: number | null;
  elapsedMs: number | null;
}

const pickNumber = (source: Record<string, unknown>, names: string[]): number | null => {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

/**
 * `/slots` 归一化。llama.cpp 各版本字段名有出入（`n_past` / `n_prompt_tokens` /
 * `n_decoded` 最稳），所以按候选名依次兜底，取不到就当空。
 */
export function normalizeSlots(value: unknown): SlotView[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, index) => {
      const nested =
        typeof item.next_token === "object" && item.next_token !== null
          ? (item.next_token as Record<string, unknown>)
          : undefined;
      const pick = (names: string[]) => pickNumber(item, names) ?? (nested ? pickNumber(nested, names) : null);
      const context = pick(["n_ctx"]);
      const promptTokens = pick(["prompt_tokens", "n_prompt_tokens"]);
      const outputTokens = pick(["n_decoded", "n_decoded_total"]);
      const past = pick(["n_past", "n_past_total"]);
      return {
        id: typeof item.id === "number" ? item.id : index,
        busy: item.is_processing === true,
        context,
        promptTokens,
        outputTokens,
        cacheTokens: past !== null && promptTokens !== null ? Math.max(0, past - promptTokens) : null,
        speed: pick(["predicted_per_second", "decode_tok_s"]),
        elapsedMs: pick(["elapsed_ms", "t_start"]),
      };
    });
}

/** 每个槽位保留最近 30 个速度采样；空闲记 null，让折线断开（照搬上游）。 */
export function nextSlotHistory(
  previous: Record<number, (number | null)[]>,
  slots: SlotView[],
): Record<number, (number | null)[]> {
  const next: Record<number, (number | null)[]> = {};
  for (const slot of slots) {
    const past = previous[slot.id] ?? [];
    next[slot.id] = [...past, slot.busy ? slot.speed : null].slice(-30);
  }
  return next;
}
