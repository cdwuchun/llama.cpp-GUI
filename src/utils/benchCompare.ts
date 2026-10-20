/**
 * 两份压测报告按档位对齐后的对照数据（上游 `core.compareContextBenchmarkReports` 的简化版）。
 *
 * 上游还会核验「测量身份」与生效条件，只在条件一致时才给出快慢结论；本工程还没有采集
 * 测量身份（P4 监控采集层未落地），所以这里只做并列展示，不输出谁更快的判断。
 */

import type { ContextBenchmarkReport, ContextBenchmarkSample } from "./contextBenchmark";

export interface ComparableTier {
  /** 该档位成功请求的条数 */
  samples: number;
  /** 实际输入 token 的均值（能看出两份记录灌的输入量是否真的同一个档位） */
  promptTokens: number | null;
  prefillTokS: number | null;
  decodeTokS: number | null;
  wallMs: number | null;
  draftAccept: number | null;
}

export interface CompareRow {
  tier: number;
  left: ComparableTier | null;
  right: ComparableTier | null;
}

/** 同一档位只统计成功的样本；全失败或没跑过就返回 null，表格里显示「—」 */
function summarize(samples: ContextBenchmarkSample[]): ComparableTier | null {
  const done = samples.filter((s) => s.state === "completed");
  if (done.length === 0) return null;

  const mean = (read: (sample: ContextBenchmarkSample) => number | null): number | null => {
    const values = done.map(read).filter((value): value is number => value !== null && Number.isFinite(value));
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  };

  return {
    samples: done.length,
    promptTokens: mean((s) => s.promptTokens),
    prefillTokS: mean((s) => s.prefillTokS),
    decodeTokS: mean((s) => s.decodeTokS),
    wallMs: mean((s) => s.wallMs),
    draftAccept: mean((s) => s.draftAccept),
  };
}

/** 两侧档位的并集，按 token 数升序 */
export function compareBenchReports(left: ContextBenchmarkReport, right: ContextBenchmarkReport): CompareRow[] {
  const tiers = new Set<number>();
  for (const sample of left.samples) tiers.add(sample.targetTokens);
  for (const sample of right.samples) tiers.add(sample.targetTokens);

  return Array.from(tiers)
    .sort((a, b) => a - b)
    .map((tier) => ({
      tier,
      left: summarize(left.samples.filter((s) => s.targetTokens === tier)),
      right: summarize(right.samples.filter((s) => s.targetTokens === tier)),
    }));
}
