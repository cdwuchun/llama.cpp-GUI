/**
 * 场景测试的纯逻辑（不发请求、不碰 UI）。
 *
 * 照上游 `E:\Code\strata-manager-main\packages\core\src\benchmark-suite.ts` 的
 * 场景定义与选项语义移植，只留 suite（一次性串行套件）模式，去掉 stress 模式
 * （并发阶梯、时限压测那套本工程用不上）。
 *
 * 上游靠引擎的 `POST /v1/messages/count_tokens` 精确数 token，llama.cpp 没有
 * 这个端点，所以长输入场景按字符估算，实际 token 以响应的 usage 为准。
 */
import type { ChatMessage } from "../api/chat";

/** 七个场景，id 与上游一致（上游 benchmark-suite.ts:8-16） */
export type ScenarioId =
  | "short"
  | "code"
  | "long"
  | "decode"
  | "cache"
  | "conversation"
  | "custom";

export interface ScenarioInfo {
  id: ScenarioId;
  name: string;
  hint: string;
}

export const SCENARIOS: ScenarioInfo[] = [
  {
    id: "short",
    name: "短问答",
    hint: "短问题短回答，看首 token 延迟和整条请求耗时",
  },
  {
    id: "code",
    name: "代码审查",
    hint: "给一段 TypeScript 代码要求审查，看中长上下文的理解与输出",
  },
  {
    id: "long",
    name: "长输入",
    hint: "按字符数拼一段长材料再提问，看长提示词的预填充能力",
  },
  {
    id: "decode",
    name: "长输出",
    hint: "要求写较长内容，看解码速度以及会不会被输出上限截断",
  },
  {
    id: "cache",
    name: "缓存复用",
    hint: "重复同一份提示词，看前缀缓存命中率（不重启引擎才算数）",
  },
  {
    id: "conversation",
    name: "多轮对话",
    hint: "带着前面的问答继续追问，每轮算一次请求",
  },
  {
    id: "custom",
    name: "自定义",
    hint: "用下面自己写的提示词",
  },
];

export function scenarioLabel(id: ScenarioId): string {
  return SCENARIOS.find((s) => s.id === id)?.name ?? id;
}

export interface ScenarioBenchOptions {
  /** 勾选的场景，顺序即执行顺序 */
  scenarios: ScenarioId[];
  /** 自定义场景用的提示词 */
  prompt: string;
  /** 每个场景跑几轮 */
  rounds: number;
  /** 每次请求的输出上限 */
  maxTokens: number;
  /** 长输入场景的字符数 */
  inputChars: number;
  /** 多轮对话场景的轮数 */
  conversationTurns: number;
  /** 单条请求超时（毫秒） */
  timeoutMs: number;
  /** 输入模式：变化 / 重复（重复才测得出前缀缓存） */
  mode: "unique" | "repeat";
  /** 每个场景先热身一次，热身不计入汇总 */
  warmup: boolean;
  /** 出错即停 */
  stopOnError: boolean;
}

/** 上游默认值（benchmark-suite.ts:18-23），只保留 suite 相关字段 */
const ALL_SCENARIOS: ScenarioId[] = [
  "short",
  "code",
  "long",
  "decode",
  "cache",
  "conversation",
];

export const DEFAULT_SCENARIO_BENCH_OPTIONS: ScenarioBenchOptions = {
  scenarios: ALL_SCENARIOS,
  prompt: "",
  rounds: 1,
  maxTokens: 256,
  inputChars: 8192,
  conversationTurns: 3,
  timeoutMs: 120_000,
  mode: "unique",
  warmup: false,
  stopOnError: false,
};

export const MAX_SCENARIOS = SCENARIOS.length;

export function validateScenarioBenchOptions(options: ScenarioBenchOptions): void {
  const bad = (message: string): never => {
    throw new Error(message);
  };
  if (!Array.isArray(options.scenarios)) bad("场景列表格式不对");
  if (options.scenarios.length === 0) bad("请至少勾选一个场景");
  const seen = new Set<string>();
  for (const id of options.scenarios) {
    if (!SCENARIOS.some((s) => s.id === id)) bad(`不认识的场景：${String(id)}`);
    if (seen.has(id)) bad("场景不能重复勾选");
    seen.add(id);
  }
  const range = (value: number, min: number, max: number, label: string): void => {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      bad(`${label}必须是 ${min}–${max} 的整数`);
    }
  };
  range(options.rounds, 1, 20, "每场景轮数");
  range(options.maxTokens, 16, 4096, "最大输出 token");
  range(options.inputChars, 1024, 131_072, "长输入字符数");
  range(options.conversationTurns, 2, 10, "对话轮数");
  range(options.timeoutMs, 1000, 600_000, "每次超时（毫秒）");
  if (options.mode !== "unique" && options.mode !== "repeat") bad("输入模式只能是变化或重复");
  if (typeof options.warmup !== "boolean") bad("预热选项必须是布尔值");
  if (typeof options.stopOnError !== "boolean") bad("遇错停止必须是布尔值");
  if (options.scenarios.includes("custom")) {
    if (typeof options.prompt !== "string" || !options.prompt.trim()) bad("自定义场景要填提示词");
    if (options.prompt.length > 131_072) bad("提示词最多 131,072 个字符");
  }
}

/** 某个场景要发多少条请求（上游 plannedPerScenario） */
export function plannedPerScenario(options: ScenarioBenchOptions, id: ScenarioId): number {
  return options.rounds * (id === "conversation" ? options.conversationTurns : 1);
}

/** 总共要发多少条请求（不含热身），界面上的「N 条请求」用它 */
export function estimateScenarioRequests(options: ScenarioBenchOptions): number {
  return options.scenarios.reduce((sum, id) => sum + plannedPerScenario(options, id), 0);
}

/* -------------------------------------------------------------------------
 * 提示词：上游 BENCHMARK_PROMPTS 的同一批题型，改成中文自述的版本
 * ---------------------------------------------------------------------- */

const SHORT_PROMPT =
  "请用中文解释 Promise 的 resolve、reject 与 finally 的用途，给出一个会失败但仍执行清理的 TypeScript 示例。";

const CODE_MATERIAL = `下面这段 TypeScript 想做一个带并发上限的任务队列，请审查它的问题并给出修正后的完整实现：

\`\`\`ts
export class Queue {
  private running = 0;
  private tasks: Array<() => Promise<void>> = [];
  constructor(private readonly limit: number) {}

  push(task: () => Promise<void>) {
    this.tasks.push(task);
    this.pump();
  }

  private pump() {
    while (this.running < this.limit && this.tasks.length > 0) {
      const task = this.tasks.shift()!;
      this.running++;
      task().then(() => {
        this.running--;
        this.pump();
      });
    }
  }
}
\`\`\`

关注：并发上限是否真的守住、任务抛错时会怎样、内存与顺序是否合理。`;

const DECODE_PROMPT = `请写一篇面向中级开发者的 TypeScript 异步编程教程，要求：
1. 从事件循环与微任务讲起，说明为什么 setTimeout 的顺序会和 Promise 不同；
2. 讲解 async/await 的等价写法与常见误区（for 循环里 await、并行改串行）；
3. 给出至少三个可直接运行的例子，每个例子都写上预期输出；
4. 最后总结一份排查异步问题的清单。
篇幅尽量长，用中文分小节写，代码用 TypeScript。`;

const CONVERSATION_FIRST =
  "我们要设计一个跑在单机上的任务队列服务，要求支持优先级、失败重试和优雅停机。先给出整体架构与关键数据结构，不需要写代码。";

const CONVERSATION_FOLLOWUPS = [
  "接着上一轮：把失败重试的退避策略写出来，说明怎么避免重试风暴。",
  "接着上一轮：优雅停机时队列里还有任务在跑，具体该怎么收尾？给出停机流程。",
  "接着上一轮：如果要加一个任务超时强制取消，你会改哪几处？给出改动点。",
  "接着上一轮：最后把这些整理成一份可以直接照着做的实施清单。",
];

/** 长输入场景的填充块（内容无所谓，只求稳定可重复） */
const LONG_BLOCK = `材料：下面是一段待审查的 TypeScript 代码，它把多个异步请求串起来做聚合。

\`\`\`ts
export async function loadAll(ids: string[]) {
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const res = await fetch(\`/api/item/\${id}\`);
    out[id] = await res.json();
  }
  return out;
}
\`\`\`

问题：串行请求、没有超时、没有错误隔离、结果类型是 any。`;

/** 长输入场景：按字符数拼出一段长材料（上游 promptFor 的同一做法） */
export function longInputPrompt(inputChars: number): string {
  const header = "请阅读下面的材料，然后指出其中的性能问题并给出改写方案。\n\n";
  const footer = "\n\n请综合上面的全部材料，给出一份统一的实现与测试说明，用中文作答。";
  const size = Math.max(0, inputChars - header.length - footer.length);
  if (size === 0) return header + footer;
  const repeat = Math.ceil(size / (LONG_BLOCK.length + 2));
  return header + Array.from({ length: repeat }, () => LONG_BLOCK).join("\n\n").slice(0, size) + footer;
}

/**
 * 某个场景在某一轮要发的内容。
 *
 * @param scenario 场景
 * @param options 选项
 * @param round 第几轮（1 起）
 * @param turn 多轮对话的第几轮对话（1 起）
 */
export function scenarioPrompt(
  scenario: ScenarioId,
  options: ScenarioBenchOptions,
  round: number,
  turn: number,
): string {
  // 重复模式：每条请求都用同一份输入，才看得出前缀缓存是否命中
  const repeated = options.mode === "repeat";
  switch (scenario) {
    case "short":
      return repeated ? SHORT_PROMPT : `${SHORT_PROMPT}\n\n（第 ${round} 轮）`;
    case "code":
      return repeated ? CODE_MATERIAL : `${CODE_MATERIAL}\n\n（第 ${round} 轮）`;
    case "long":
      return longInputPrompt(options.inputChars);
    case "decode":
      return DECODE_PROMPT;
    case "cache":
      return CODE_MATERIAL;
    case "conversation":
      if (turn === 1) return CONVERSATION_FIRST;
      return CONVERSATION_FOLLOWUPS[Math.min(turn - 2, CONVERSATION_FOLLOWUPS.length - 1)];
    case "custom":
      return repeated ? options.prompt : `${options.prompt}\n\n（第 ${round} 轮）`;
    default:
      return SHORT_PROMPT;
  }
}

/** 把场景的一轮请求拼成消息数组（多轮对话要把之前的问答带上） */
export function scenarioMessages(
  scenario: ScenarioId,
  options: ScenarioBenchOptions,
  round: number,
  turn: number,
  history: ChatMessage[] = [],
): ChatMessage[] {
  if (scenario === "conversation") {
    return [...history, { role: "user", content: scenarioPrompt(scenario, options, round, turn) }];
  }
  return [{ role: "user", content: scenarioPrompt(scenario, options, round, turn) }];
}

/* -------------------------------------------------------------------------
 * 采样与汇总
 * ---------------------------------------------------------------------- */

export type ScenarioSampleState = "completed" | "failed" | "cancelled";

/** 一条请求的记录（对齐上游 sample 字段，本工程拿不到的置 null） */
export interface ScenarioSample {
  /** 全局序号，0 起，表格顺序 */
  index: number;
  scenario: ScenarioId;
  warmup: boolean;
  /** 多轮对话里的第几轮（非对话场景恒为 1） */
  turn: number;
  state: ScenarioSampleState;
  startedAt: number;
  ttftMs: number | null;
  wallMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
  prefillTokS: number | null;
  decodeTokS: number | null;
  finishReason: string | null;
  output: string;
  /** 失败原因；正常为 undefined */
  error?: string;
}

export interface ScenarioBenchReport {
  schemaVersion: 1;
  id: string;
  model: string;
  options: ScenarioBenchOptions;
  samples: ScenarioSample[];
  state: "completed" | "failed" | "cancelled";
  stopReason: "completed" | "cancelled" | "error";
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
}

/** 一个场景的汇总（只算成功请求、不算热身） */
export interface ScenarioSummary {
  scenario: ScenarioId;
  completed: number;
  failed: number;
  cancelled: number;
  ttftMs: number | null;
  wallMs: number | null;
  prefillTokS: number | null;
  decodeTokS: number | null;
  /** 前缀缓存命中率 0–1 */
  cacheHitRate: number | null;
  /** 实际输出 token 均值 */
  outputTokens: number | null;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 只取有效数字（null/NaN 剔掉） */
function numbers(list: (number | null)[]): number[] {
  return list.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * 按场景汇总。热身样本与失败样本都不进均值 —— 上游同一口径
 * （summarizeBenchmarkSuite 只在 state === 'completed' 上取均值）。
 */
export function summarizeByScenario(samples: ScenarioSample[]): ScenarioSummary[] {
  const order = new Map<ScenarioId, number>();
  SCENARIOS.forEach((s, i) => order.set(s.id, i));
  const groups = new Map<ScenarioId, ScenarioSample[]>();
  for (const sample of samples) {
    if (sample.warmup) continue;
    const list = groups.get(sample.scenario);
    if (list) list.push(sample);
    else groups.set(sample.scenario, [sample]);
  }
  return [...groups.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99))
    .map(([scenario, list]) => {
      const done = list.filter((s) => s.state === "completed");
      const cacheHits = done
        .filter(
          (s) =>
            typeof s.cachedTokens === "number" &&
            typeof s.promptTokens === "number" &&
            s.promptTokens > 0 &&
            s.cachedTokens <= s.promptTokens,
        )
        .map((s) => (s.cachedTokens as number) / (s.promptTokens as number));
      return {
        scenario,
        completed: done.length,
        failed: list.filter((s) => s.state === "failed").length,
        cancelled: list.filter((s) => s.state === "cancelled").length,
        ttftMs: mean(numbers(done.map((s) => s.ttftMs))),
        wallMs: mean(numbers(done.map((s) => s.wallMs))),
        prefillTokS: mean(numbers(done.map((s) => s.prefillTokS))),
        decodeTokS: mean(numbers(done.map((s) => s.decodeTokS))),
        cacheHitRate: mean(cacheHits),
        outputTokens: mean(numbers(done.map((s) => s.completionTokens))),
      };
    });
}

/** 整份报告的汇总（顶部那排大数字） */
export interface ScenarioOverall {
  completed: number;
  failed: number;
  cancelled: number;
  /** 首 token 延迟的均值与分位（秒） */
  ttftMs: number | null;
  ttftP95: number | null;
  /** 解码速度均值 tok/s */
  decodeTokS: number | null;
  /** 预填充速度均值 tok/s */
  prefillTokS: number | null;
  /** 整条请求耗时均值（秒） */
  wallMs: number | null;
  wallP95: number | null;
  cacheHitRate: number | null;
  /** 被输出上限截断的请求数 */
  truncated: number;
}

/** 线性插值分位（上游 summarizeBenchmarkSuite 的同一算法） */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (pos - low);
}

export function summarizeOverall(samples: ScenarioSample[]): ScenarioOverall {
  const done = samples.filter((s) => !s.warmup && s.state === "completed");
  const ttfts = numbers(done.map((s) => s.ttftMs)).sort((a, b) => a - b);
  const walls = numbers(done.map((s) => s.wallMs)).sort((a, b) => a - b);
  const cacheHits = done
    .filter(
      (s) =>
        typeof s.cachedTokens === "number" &&
        typeof s.promptTokens === "number" &&
        s.promptTokens > 0 &&
        s.cachedTokens <= s.promptTokens,
    )
    .map((s) => (s.cachedTokens as number) / (s.promptTokens as number));
  return {
    completed: done.length,
    failed: samples.filter((s) => !s.warmup && s.state === "failed").length,
    cancelled: samples.filter((s) => !s.warmup && s.state === "cancelled").length,
    ttftMs: mean(ttfts),
    ttftP95: percentile(ttfts, 0.95),
    decodeTokS: mean(numbers(done.map((s) => s.decodeTokS))),
    prefillTokS: mean(numbers(done.map((s) => s.prefillTokS))),
    wallMs: mean(walls),
    wallP95: percentile(walls, 0.95),
    cacheHitRate: mean(cacheHits),
    truncated: done.filter((s) => s.finishReason === "length").length,
  };
}

/* -------------------------------------------------------------------------
 * A/B 对比（取代上游的「历史与升级对照」）
 * ---------------------------------------------------------------------- */

export interface ScenarioCompareRow {
  scenario: ScenarioId;
  /** A 侧（当前这份） */
  left: ScenarioSummary | null;
  /** B 侧（下面选的那份） */
  right: ScenarioSummary | null;
}

/**
 * 两份报告按场景并排。跨模型也能比（用户 m14163 的要求），
 * 某侧没跑过这个场景就给 null，界面显示「—」。
 */
export function compareScenarioReports(
  left: ScenarioBenchReport,
  right: ScenarioBenchReport,
): ScenarioCompareRow[] {
  const a = new Map(summarizeByScenario(left.samples).map((s) => [s.scenario, s]));
  const b = new Map(summarizeByScenario(right.samples).map((s) => [s.scenario, s]));
  const order = new Map<ScenarioId, number>();
  SCENARIOS.forEach((s, i) => order.set(s.id, i));
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort((x, y) => (order.get(x) ?? 99) - (order.get(y) ?? 99))
    .map((scenario) => ({
      scenario,
      left: a.get(scenario) ?? null,
      right: b.get(scenario) ?? null,
    }));
}

/* -------------------------------------------------------------------------
 * 导出
 * ---------------------------------------------------------------------- */

const CSV_COLUMNS = [
  "index",
  "scenario",
  "turn",
  "warmup",
  "state",
  "started_at",
  "ttft_ms",
  "wall_ms",
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
  "prefill_tok_s",
  "decode_tok_s",
  "finish_reason",
  "error",
  "output",
] as const;

/** CSV 单元格：含 =+-@ 开头的先加制表符，防 Excel 当公式执行（上游同一做法） */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `\t${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * 导出 CSV。`includeContent` 为假时不写 output 列的内容，
 * 免得把几千字的模型输出也塞进表格（上游的同名开关）。
 */
export function scenarioCsv(report: ScenarioBenchReport, includeContent: boolean): string {
  const head = CSV_COLUMNS.join(",");
  const rows = report.samples.map((s) =>
    [
      s.index,
      s.scenario,
      s.turn,
      s.warmup ? 1 : 0,
      s.state,
      new Date(s.startedAt).toISOString(),
      s.ttftMs,
      s.wallMs,
      s.promptTokens,
      s.completionTokens,
      s.cachedTokens,
      s.prefillTokS,
      s.decodeTokS,
      s.finishReason,
      s.error ?? "",
      includeContent ? s.output : "",
    ]
      .map(csvCell)
      .join(","),
  );
  return `\uFEFF${[head, ...rows].join("\r\n")}\r\n`;
}

/** 导出 JSON：报告本体 + 汇总，方便贴到别处 */
export function scenarioJson(report: ScenarioBenchReport, includeContent: boolean): string {
  const samples = includeContent
    ? report.samples
    : report.samples.map((s) => ({ ...s, output: "" }));
  return JSON.stringify(
    {
      ...report,
      samples,
      overall: summarizeOverall(report.samples),
      byScenario: summarizeByScenario(report.samples),
    },
    null,
    2,
  );
}

/** 把毫秒写成人看得懂的时长（上游 formatDuration） */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}
