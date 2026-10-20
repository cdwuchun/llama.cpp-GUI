/**
 * 上下文档位压测的纯逻辑（不发请求、不碰 UI）。
 *
 * 档位与双循环语义照搬上游 `packages/core/src/context-benchmark.ts`
 * （移植依据：STRATA_MANAGER_PORT_ASSESSMENT.md §6 的 P1「Benchmark 上文档位」）。
 *
 * 与上游的差别只有一处，且是文档已记录的降级：上游用 POST /v1/messages/count_tokens
 * 反复迭代校准输入量，llama.cpp 没有这个端点，这里改成按字符估算、再用第一轮的
 * usage.prompt_tokens 回修行数（用户 m10775）。
 */

/** 档位表（上游 CONTEXT_BENCHMARK_TIERS），单位 token */
export const CONTEXT_BENCHMARK_TIERS: number[] = [8, 32, 64, 128, 256, 384, 512, 768, 1024].map((k) => k * 1024);

/** 每档要给输出与模板留的余量（上游 HEADROOM） */
export const CONTEXT_BENCHMARK_HEADROOM = 64;

/** 上下文上限的合法区间上界（上游 MAX_CONTEXT_TOKENS） */
export const MAX_CONTEXT_TOKENS = 2_147_483_647;

/** 单档提示词最多重复多少行，防止档位被填成天文数字时把内存撑爆 */
export const MAX_RECORD_LINES = 100_000;

export interface ContextBenchmarkOptions {
  /** 空数组 = 跑该模型支持的全部档位 */
  tiers: number[];
  maxTokens: number;
  timeoutMs: number;
  rounds: number;
  stopOnError: boolean;
  configurationLabel?: string;
}

export const DEFAULT_CONTEXT_BENCHMARK_OPTIONS: ContextBenchmarkOptions = {
  tiers: [],
  maxTokens: 512,
  timeoutMs: 600_000,
  rounds: 1,
  stopOnError: true,
};

export interface ContextBenchmarkSkippedTier {
  tier: number;
  reason: string;
}

export interface ContextBenchmarkSample {
  /** 全局序号（从 0 起），表格按它排列 */
  index: number;
  tier: number;
  round: number;
  /** 这一档的目标输入量 */
  targetTokens: number;
  /** 实际发出去的行数 */
  lines: number;
  /** 压测的模型（config JSON 的 name，铁律 2） */
  model: string;
  /** 这一档的结局 */
  state: "completed" | "failed" | "cancelled";
  /** 样本开始的 epoch 毫秒 */
  startedAt: number;
  /** 输入量是估的还是按上一轮 usage 修正过的 */
  tokenCountMethod: "estimated" | "adjusted";
  calibrationReason: string;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  prefillTokS: number | null;
  decodeTokS: number | null;
  ttftMs: number | null;
  wallMs: number;
  finishReason: string | null;
  output: string;
  /** 显存/内存峰值，单位字节，跨整机采样（P4 采集层落地前恒为 null；跟上游同名字段对齐） */
  peakGpuMemory: number | null;
  peakRam: number | null;
  minGpuMemoryFree: number | null;
  resourceSamples: number;
  /** 投机解码命中率 0–1；没开草稿或这次没报就是 null（用户 m12318 第 3 点） */
  draftAccept: number | null;
  error?: string;
}

export interface ContextBenchmarkReport {
  schemaVersion: 3;
  /** 每份报告的唯一 id（历史列表与 A/B 对比用） */
  id: string;
  model: string;
  maxContext: number | null;
  options: ContextBenchmarkOptions;
  samples: ContextBenchmarkSample[];
  skipped: ContextBenchmarkSkippedTier[];
  state: "completed" | "failed" | "cancelled";
  stopReason: "completed" | "cancelled" | "modelChanged" | "error";
  /** epoch 毫秒 */
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
}

/** 档位标签：8K / 384K / 1M（与上游 contextTierLabel 同规则） */
export function contextTierLabel(tokens: number): string {
  if (tokens >= 1024 * 1024 && tokens % (1024 * 1024) === 0) return `${tokens / (1024 * 1024)}M`;
  if (tokens % 1024 === 0) return `${tokens / 1024}K`;
  return tokens.toLocaleString();
}

/** 某个模型的 max_context 能跑哪些档位；末档总是模型自己的上限（上游同此） */
export function getContextBenchmarkTiers(maxContext: number | null): number[] {
  if (maxContext === null || !Number.isSafeInteger(maxContext) || maxContext <= 0 || maxContext > MAX_CONTEXT_TOKENS) {
    return [];
  }
  const tiers = CONTEXT_BENCHMARK_TIERS.filter((tier) => tier <= maxContext);
  return [...new Set([...tiers, maxContext])].sort((a, b) => a - b);
}

export function validateContextBenchmarkOptions(options: ContextBenchmarkOptions): void {
  const tiers = options.tiers;
  if (!Array.isArray(tiers)) throw new Error("档位列表格式不对");
  if (tiers.length > 0) {
    if (new Set(tiers).size !== tiers.length) throw new Error("请选择至少一个有效且不重复的上下文档位");
    for (const tier of tiers) {
      if (!Number.isSafeInteger(tier) || tier <= 0 || tier > MAX_CONTEXT_TOKENS) {
        throw new Error("请选择至少一个有效且不重复的上下文档位");
      }
    }
  }
  const ranges: [number, number, number, string][] = [
    [options.rounds, 1, 10, "重复次数"],
    [options.maxTokens, 16, 4096, "输出 token 上限"],
    [options.timeoutMs, 1000, 600_000, "请求超时（毫秒）"],
  ];
  for (const [value, min, max, label] of ranges) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`${label}必须是 ${min}–${max} 的整数`);
    }
  }
  if (typeof options.stopOnError !== "boolean") throw new Error("遇错停止必须是布尔值");
  if (options.configurationLabel != null && options.configurationLabel.length > 120) {
    throw new Error("测试配置名称最多为 120 个字符");
  }
}

/** 逐档判定能不能跑，并给出不能跑的原因（上游 planContextBenchmarkTiers） */
export function planContextBenchmarkTiers(
  tiers: number[],
  maxContext: number | null,
  maxTokens: number,
): { supported: number[]; skipped: ContextBenchmarkSkippedTier[] } {
  const supported: number[] = [];
  const skipped: ContextBenchmarkSkippedTier[] = [];
  for (const tier of [...tiers].sort((a, b) => a - b)) {
    if (maxContext === null || !Number.isSafeInteger(maxContext) || maxContext <= 0) {
      skipped.push({ tier, reason: "模型没报告有效的 max_context，无法核验安全的输入与输出预算" });
      continue;
    }
    if (tier > maxContext) {
      skipped.push({ tier, reason: `档位 ${tier} token 超过模型 max_context ${maxContext} token` });
      continue;
    }
    if (tier <= maxTokens + CONTEXT_BENCHMARK_HEADROOM) {
      skipped.push({ tier, reason: "此档位无法为输出与模板保留足够余量" });
      continue;
    }
    supported.push(tier);
  }
  return { supported, skipped };
}

/** 合成记录：保持英文，估算用的 28 token/行 就是照它标的 */
const RECORD = "record alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron value complete.\n";

/** 每行合成记录的估算 token 数（上游 ESTIMATED_RECORD_TOKENS） */
export const ESTIMATED_RECORD_TOKENS = 28;

/** 模板 + nonce 部分的粗估 token 数（上游初始行数公式里的 128） */
const TEMPLATE_TOKENS = 128;

export function contextBenchmarkMessages(
  lines: number,
  nonce: string,
): { role: "user"; content: string }[] {
  return [
    {
      role: "user",
      content:
        `${nonce}\nSynthetic records follow. Read all of them, then summarize.\n` +
        RECORD.repeat(lines) +
        "\nSummarize the records above in one short sentence.",
    },
  ];
}

/**
 * 按目标输入量估行数（上游的初始值，只是估，不再迭代校准）。
 *
 * `tokensPerLine` 允许外部传入：同一个模型连着跑好几档时，前面档位量出来的
 * 真实「每行多少 token」比常量准得多，用上它后面几档首发就够准、不必再校正重发
 * （用户 m13507 第 4 点：界面上写 2 个请求，日志里却是 4 次）。
 */
export function estimateRecordLines(
  targetTokens: number,
  tokensPerLine: number = ESTIMATED_RECORD_TOKENS,
): number {
  const perLine = tokensPerLine > 0 ? tokensPerLine : ESTIMATED_RECORD_TOKENS;
  const lines = Math.floor((targetTokens - TEMPLATE_TOKENS) / perLine);
  return Math.min(Math.max(lines, 1), MAX_RECORD_LINES);
}

/** 估出来的输入量，用于第一轮之前显示与判定 */
export function estimatePromptTokens(lines: number): number {
  return TEMPLATE_TOKENS + lines * ESTIMATED_RECORD_TOKENS;
}

/**
 * 拿第一轮的真实 usage 回修行数：估得偏小就加行，偏大就减行。
 * 上游靠 count_tokens 端点做这件事，这里只能一轮一轮逼近。
 */
export function adjustRecordLines(targetTokens: number, lines: number, actualPromptTokens: number): number {
  if (!Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0) return lines;
  const next = Math.round((lines * targetTokens) / actualPromptTokens);
  return Math.min(Math.max(next, 1), MAX_RECORD_LINES);
}

/**
 * 从一档的实测 usage 反推「每行多少 token」，供后面几档首发直接用。
 *
 * 不同模型的分词器差别不小（同一段合成记录，有的 22 token/行、有的 28），
 * 常量只能保证大概，实测值才是这个模型自己的答案。
 */
export function measureTokensPerLine(lines: number, actualPromptTokens: number): number {
  if (!Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0 || lines <= 0) {
    return ESTIMATED_RECORD_TOKENS;
  }
  const perLine = (actualPromptTokens - TEMPLATE_TOKENS) / lines;
  return perLine > 0 ? perLine : ESTIMATED_RECORD_TOKENS;
}

/** 输入量与目标的偏差超过 5% 才值得再修一轮 */
export function needsAdjustment(targetTokens: number, actualPromptTokens: number | null): boolean {
  if (actualPromptTokens === null || !Number.isFinite(actualPromptTokens) || actualPromptTokens <= 0) return false;
  return Math.abs(actualPromptTokens - targetTokens) / targetTokens > 0.05;
}

export interface ContextBenchmarkStats {
  tier: number;
  count: number;
  prefillTokS: number | null;
  decodeTokS: number | null;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/** 同档位多轮结果取中位数汇总，供表格与图表用 */
export function summarizeByTier(samples: ContextBenchmarkSample[]): ContextBenchmarkStats[] {
  const byTier = new Map<number, ContextBenchmarkSample[]>();
  for (const sample of samples) {
    if (sample.error) continue;
    const list = byTier.get(sample.tier);
    if (list) list.push(sample);
    else byTier.set(sample.tier, [sample]);
  }
  const median = (values: number[]): number | null => {
    const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (nums.length === 0) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };
  const pick = (list: ContextBenchmarkSample[], get: (s: ContextBenchmarkSample) => number | null): number | null =>
    median(list.map(get).filter((v): v is number => v !== null));
  return [...byTier.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tier, list]) => ({
      tier,
      count: list.length,
      prefillTokS: pick(list, (s) => s.prefillTokS),
      decodeTokS: pick(list, (s) => s.decodeTokS),
      ttftMs: pick(list, (s) => s.ttftMs),
      promptTokens: pick(list, (s) => s.promptTokens),
      completionTokens: pick(list, (s) => s.completionTokens),
    }));
}
