/**
 * 并发阶梯的纯逻辑（不发请求、不碰 UI）。
 *
 * 照上游 `packages/core/src/concurrency-ladder.ts` 移植：按 1 → 2 → 4 … 逐级加压，
 * 每级固定时长，看**总吞吐**和**单个请求的吞吐**怎么变，最后给一句话结论。
 *
 * 与上游的差异：上游从 Strata 的 `/metrics`（`live.parallel`）读槽数，本工程走前门，
 * 槽数来自 llama.cpp `/props` 的 `total_slots`（拿不到就按 4 算）。
 */

/** 每一级压多久（上游 `CONCURRENCY_LADDER_STAGE_MS`） */
export const LADDER_STAGE_MS = 40_000;

/** 阶梯最高到多少（上游把上限压在引擎的 32 槽） */
export const LADDER_MAX_LEVEL = 32;

/** 一条并发请求的记录（比 `ScenarioSample` 精简，只留阶梯要用的字段） */
export interface LadderSample {
  /** 第几级（从 1 起） */
  stage: number;
  /** 这一级同时挂几个请求 */
  concurrency: number;
  state: "completed" | "failed" | "cancelled";
  startedAt: number;
  wallMs: number;
  ttftMs: number | null;
  completionTokens: number | null;
  /** llama.cpp 自己报的解码速度（纯计算时间，不含排队） */
  decodeTokS: number | null;
  error?: string;
}

/** 一级的汇总 */
export interface LadderRow {
  concurrency: number;
  completed: number;
  failed: number;
  /** 这一级所有请求合起来的输出速度（tok/s）——含并发收益 */
  totalTokS: number | null;
  /** 单个请求的平均解码速度（tok/s） */
  perRequestTokS: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
}

export type LadderVerdictCode = "ladder_gain" | "ladder_no_gain" | "ladder_empty";

export interface LadderConclusion {
  code: LadderVerdictCode;
  /** 总吞吐最高那一级的并发数（没有增益时按 1 算） */
  best: number;
  values: Record<string, number>;
}

/** 阶梯：1、2、4、8 … 直到 top（至少两级，一次一个的服务也能看出排队） */
export function ladderLevels(top: number): number[] {
  const cap = Math.max(2, Math.min(LADDER_MAX_LEVEL, Math.round(top) || 1));
  const levels = [1];
  while (levels[levels.length - 1] < cap) {
    levels.push(Math.min(cap, levels[levels.length - 1] * 2));
  }
  return levels;
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;

/** 线性插值分位数（与 `scenarioBench.summarizeOverall` 同一算法） */
const quantile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const known = (values: (number | null | undefined)[]): number[] =>
  values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);

/**
 * 由样本算出每一级的汇总。
 *
 * 总吞吐按「这一级第一条开始 → 最后一条结束」的窗口算：窗口里所有完成的输出 token
 * 除以窗口时长，才是这台机器在 N 个并发下的真实产出（上游同口径）。
 */
export function ladderRowsFromSamples(samples: LadderSample[]): LadderRow[] {
  const byStage = new Map<number, LadderSample[]>();
  for (const sample of samples) {
    const list = byStage.get(sample.stage);
    if (list) list.push(sample);
    else byStage.set(sample.stage, [sample]);
  }
  return [...byStage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => {
      const done = group.filter((s) => s.state === "completed");
      const start = Math.min(...group.map((s) => s.startedAt));
      const end = done.length > 0 ? Math.max(...done.map((s) => s.startedAt + s.wallMs)) : start;
      const tokens = known(done.map((s) => s.completionTokens));
      return {
        concurrency: group[0].concurrency,
        completed: done.length,
        failed: group.filter((s) => s.state === "failed").length,
        totalTokS:
          done.length > 0 && tokens.length === done.length && end > start
            ? (tokens.reduce((a, b) => a + b, 0) * 1000) / (end - start)
            : null,
        perRequestTokS: mean(known(done.map((s) => s.decodeTokS))),
        ttftP50Ms: quantile(known(done.map((s) => s.ttftMs)), 0.5),
        ttftP95Ms: quantile(known(done.map((s) => s.ttftMs)), 0.95),
      };
    });
}

/**
 * 一句话结论：总吞吐在哪一级见顶、单个请求为此付出了多少。
 *
 * 触发「有增益」的门槛是最高的总吞吐达到一次一个的 1.1 倍 —— 低于这个量级属于测量噪声，
 * 说明这台机器/这个模型并发并没有真收益（上游同门槛）。
 */
export function ladderConclusion(rows: LadderRow[]): LadderConclusion {
  const measured = rows.filter((row) => row.totalTokS !== null);
  if (measured.length === 0) return { code: "ladder_empty", best: 1, values: {} };
  const solo = measured.find((row) => row.concurrency === 1) ?? measured[0];
  const best = measured.reduce((a, b) => (b.totalTokS as number > (a.totalTokS as number) ? b : a));
  const soloTotal = Math.max(solo.totalTokS as number, 1e-9);
  const gain = (best.totalTokS as number) / soloTotal;
  const values = {
    best: best.concurrency,
    total: Math.round(best.totalTokS as number),
    gain: Math.round(gain * 10) / 10,
    solo: Math.round(solo.totalTokS as number),
    perRequest: Math.round(best.perRequestTokS ?? 0),
    drop:
      solo.perRequestTokS && best.perRequestTokS
        ? Math.round((1 - best.perRequestTokS / solo.perRequestTokS) * 100)
        : 0,
  };
  return best.concurrency > 1 && gain >= 1.1
    ? { code: "ladder_gain", best: best.concurrency, values }
    : { code: "ladder_no_gain", best: 1, values };
}

const VERDICT_MESSAGES: Record<LadderVerdictCode, string> = {
  ladder_gain:
    "{{best}} 个同时时总吞吐最高：{{total}} tok/s，是一次一个的 {{gain}} 倍；每个请求降到 {{perRequest}} tok/s（−{{drop}}%）。",
  ladder_no_gain: "并发没有提高总吞吐（一次一个 {{solo}} tok/s），这台机器建议一次一个。",
  ladder_empty: "没有完成的请求，无法得出结论。",
};

export function ladderMessage(conclusion: LadderConclusion): string {
  return VERDICT_MESSAGES[conclusion.code].replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    String(conclusion.values[key] ?? ""),
  );
}
