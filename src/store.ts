/** 全局状态（Zustand）：设置、版本、设备、前门代理状态、模型列表与日志。 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  fetchModels,
  fetchProps,
  loadModel as apiLoadModel,
  setRouterApiKey,
  unloadModel as apiUnloadModel,
} from "./api/router";
import { errText, ipc, monitorSample, monitorSampleNow, onLogLines, onModelsScanned, onStrataStatus } from "./ipc";
import type { MonitorSnapshot } from "./types";
import { RECENT_TURN_LIMIT, type LastTurn, type RecentTurn } from "./utils/telemetry";
import { reportFrontendError } from "./utils/frontendLog";
import {
  adjustRecordLines,
  contextBenchmarkMessages,
  DEFAULT_CONTEXT_BENCHMARK_OPTIONS,
  estimateRecordLines,
  ESTIMATED_RECORD_TOKENS,
  getContextBenchmarkTiers,
  measureTokensPerLine,
  needsAdjustment,
  planContextBenchmarkTiers,
  validateContextBenchmarkOptions,
  type ContextBenchmarkOptions,
  type ContextBenchmarkReport,
  type ContextBenchmarkSample,
  type ContextBenchmarkSkippedTier,
} from "./utils/contextBenchmark";
import { fetchChatModelProps, streamChat, streamChatTurn, type ChatMessage, type ChatStreamResult } from "./api/chat";
import {
  advanceChatExecution,
  buildChatRequest,
  conversationTitle,
  finishChatExecution,
  newChatExecution,
  newId,
  normalizeChatOptions,
  type ChatAttachment,
  type ChatDelta,
  type ChatOptions,
  type ChatTurn,
  type Conversation,
  type ToolCall,
} from "./utils/chat";
import { buildToolSpecs, isMcpTool, mergeToolCallFragments, parseToolArguments, searchQueriesFromArgs } from "./utils/tools";
import {
  branchConversation,
  draftOfTurn,
  editAnswerPlan,
  regeneratePlan,
  rewindPlan,
  type ChatUndo,
} from "./utils/chatHistory";
import { mergeModels } from "./utils/models";
import {
  DEFAULT_SCENARIO_BENCH_OPTIONS,
  estimateScenarioRequests,
  plannedPerScenario,
  scenarioMessages,
  validateScenarioBenchOptions,
  type ScenarioBenchOptions,
  type ScenarioBenchReport,
  type ScenarioSample,
} from "./utils/scenarioBench";
import {
  LADDER_STAGE_MS,
  ladderConclusion,
  ladderLevels,
  ladderRowsFromSamples,
  type LadderConclusion,
  type LadderRow,
  type LadderSample,
} from "./utils/concurrencyLadder";
import type {
  AppPaths,
  AuxFile,
  ConfigEntry,
  DeviceInfo,
  LlamaCppVersion,
  LogLine,
  McpServerConfig,
  McpToolsView,
  McpToolView,
  ModelProps,
  RouterModel,
  ScannedModel,
  Settings,
  SettingsPatch,
  StrataModelEntry,
  StrataStatus,
} from "./types";

/** 前端日志缓冲上限（与后端一致） */
const LOG_LIMIT = 10_000;

/**
 * 自带聊天界面的 API Key 提示只弹一次。
 *
 * router 用 `--api-key` 启动时，参数会下发给每个子实例（自带 WebUI 也一样要鉴权）：
 * 它自己的设置里有一项 API Key（`Set the API Key if you are using --api-key option`），
 * 填一次就存在浏览器里。每个子实例端口不同、localStorage 各存一份，所以这句提示按需给一次即可。
 */
let chatKeyHintShown = false;

/**
 * 监控采集失败只在上报一次同类原因：`refreshMonitor` 每秒一轮，
 * 采集端点坏掉时会把同一句错误刷进系统日志（审查发现）。
 */
let monitorWarned = "";
function chatKeyHint(apiKey: string | null | undefined): string {
  if (!apiKey?.trim() || chatKeyHintShown) return "";
  chatKeyHintShown = true;
  return "。该界面自己也要鉴权，若提示 API Key，填设置里同一个";
}

/** 主题：浅色 / 深色（按钮放在设置页顶栏） */
export type Theme = "light" | "dark";

function initialTheme(): Theme {
  // 用独立的 key：早期版本把 "dark" 写进过 "theme"，避免沿用旧值
  return localStorage.getItem("llamacpp-gui-theme") === "dark" ? "dark" : "light";
}

/**
 * 压测历史存在 localStorage 里（用户 m11934：重启 GUI 后上一轮的结果还能带出来）。
 *
 * 存之前把每条样本的输出文本清空：表格与图表都不用它，留着白占几 MB 配额。
 * 每个模型各留 {@link BENCH_HISTORY_PER_MODEL} 份（用户 m13867：全局共用 20 条时，
 * 跑得多的模型会把别的模型的记录挤掉）。
 */
const BENCH_HISTORY_KEY = "llamacpp-gui-bench-history";

/** 每个模型各留几份（用户 m13867：全局 20 条会让多模型互相挤占） */
const BENCH_HISTORY_PER_MODEL = 5;

function trimBenchReport(report: ContextBenchmarkReport): ContextBenchmarkReport {
  return { ...report, samples: report.samples.map((s) => ({ ...s, output: "" })) };
}

/**
 * 按模型分组裁剪：每个模型只留最近的几份，合并后仍按开始时间新→旧。
 *
 * 不按模型分组的话，一个跑得多的模型会把别的模型的记录全挤掉（用户 m13867）。
 */
function pruneBenchHistory(history: ContextBenchmarkReport[]): ContextBenchmarkReport[] {
  const byModel = new Map<string, ContextBenchmarkReport[]>();
  for (const report of [...history].sort((a, b) => b.startedAt - a.startedAt)) {
    const kept = byModel.get(report.model) ?? [];
    if (kept.length >= BENCH_HISTORY_PER_MODEL) continue;
    kept.push(report);
    byModel.set(report.model, kept);
  }
  return Array.from(byModel.values())
    .flat()
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** 压测样本时间窗内的硬件峰值（监控采集层的 1 秒环形缓冲，按 `at` 切片）。 */
async function sampleRange(from: number, to: number): Promise<{
  peakGpuMemory: number | null;
  peakRam: number | null;
  minGpuMemoryFree: number | null;
  count: number;
}> {
  const empty = { peakGpuMemory: null, peakRam: null, minGpuMemoryFree: null, count: 0 };
  try {
    const snapshot = await monitorSample();
    const times = snapshot.history.at;
    if (times.length === 0) return empty;
    const keep: number[] = [];
    for (let index = 0; index < times.length; index += 1) {
      const at = times[index];
      if (at >= from && at <= to) keep.push(index);
    }
    if (keep.length === 0) return empty;
    const maxOf = (name: string): number | null => {
      const list = snapshot.history.series[name] ?? [];
      let max: number | null = null;
      for (const index of keep) {
        const value = list[index];
        if (typeof value === "number" && (max === null || value > max)) max = value;
      }
      return max;
    };
    const gpuUsedMib = maxOf("gpuMemUsed");
    const ramUsed = maxOf("memUsed");
    const totalMib = snapshot.now.gpu?.memTotalMib ?? null;
    return {
      peakGpuMemory: gpuUsedMib === null ? null : Math.round(gpuUsedMib * 1024 * 1024),
      peakRam: ramUsed === null ? null : Math.round(ramUsed),
      minGpuMemoryFree:
        gpuUsedMib === null || totalMib === null
          ? null
          : Math.round((totalMib - gpuUsedMib) * 1024 * 1024),
      count: keep.length,
    };
  } catch {
    return empty;
  }
}
function loadBenchHistory(): ContextBenchmarkReport[] {
  try {
    const raw = localStorage.getItem(BENCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? pruneBenchHistory(parsed as ContextBenchmarkReport[]) : [];
  } catch {
    return [];
  }
}

/** 写进去并把留下的那份返回，调用处可以直接当 state 用 */
function saveBenchHistory(history: ContextBenchmarkReport[]): ContextBenchmarkReport[] {
  const kept = pruneBenchHistory(history);
  try {
    localStorage.setItem(BENCH_HISTORY_KEY, JSON.stringify(kept.map(trimBenchReport)));
  } catch {
    // 配额满 / 隐私模式下写不进去：历史只是便利功能，不打扰用户
  }
  return kept;
}

/* -------------------------------------------------------------------------
 * 场景测试的历史：和上下文档位那套同一个思路，但存单独的 key
 * （两边的样本结构不同，混在一起没法反序列化）
 * ---------------------------------------------------------------------- */

const SCENARIO_HISTORY_KEY = "llamacpp-gui-scenario-bench-history";

/** 每个模型各留几份，理由同 BENCH_HISTORY_PER_MODEL */
const SCENARIO_HISTORY_PER_MODEL = 5;

/** 落盘前把模型输出清掉：表格不用它，几十条上千字的输出会撑爆配额 */
function trimScenarioReport(report: ScenarioBenchReport): ScenarioBenchReport {
  return { ...report, samples: report.samples.map((s) => ({ ...s, output: "" })) };
}

function pruneScenarioHistory(history: ScenarioBenchReport[]): ScenarioBenchReport[] {
  const byModel = new Map<string, ScenarioBenchReport[]>();
  for (const report of [...history].sort((a, b) => b.startedAt - a.startedAt)) {
    const kept = byModel.get(report.model) ?? [];
    if (kept.length >= SCENARIO_HISTORY_PER_MODEL) continue;
    kept.push(report);
    byModel.set(report.model, kept);
  }
  return Array.from(byModel.values())
    .flat()
    .sort((a, b) => b.startedAt - a.startedAt);
}

function loadScenarioHistory(): ScenarioBenchReport[] {
  try {
    const raw = localStorage.getItem(SCENARIO_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? pruneScenarioHistory(parsed as ScenarioBenchReport[]) : [];
  } catch {
    return [];
  }
}

function saveScenarioHistory(history: ScenarioBenchReport[]): ScenarioBenchReport[] {
  const kept = pruneScenarioHistory(history);
  try {
    localStorage.setItem(SCENARIO_HISTORY_KEY, JSON.stringify(kept.map(trimScenarioReport)));
  } catch {
    // 配额满 / 隐私模式：历史只是便利功能，不打扰用户
  }
  return kept;
}

/* ----------------------------------------------------------------------
 * 并发阶梯的历史：上游 `concurrencyLadderV1` 保留最近 5 份（全局，不分模型）
 * ---------------------------------------------------------------------- */

const LADDER_HISTORY_KEY = "llamacpp-gui-concurrency-ladder";

/** 上游 `KEEP = 5` */
const LADDER_HISTORY_KEEP = 5;

/** 落盘前清掉逐条样本：图表和结论只用 rows，几百条样本会撑爆配额 */
function trimLadderRun(run: LadderRun): LadderRun {
  return { ...run, samples: [] };
}

function loadLadderHistory(): LadderRun[] {
  try {
    const raw = localStorage.getItem(LADDER_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LadderRun[]).slice(0, LADDER_HISTORY_KEEP) : [];
  } catch {
    return [];
  }
}

function saveLadderHistory(history: LadderRun[]): LadderRun[] {
  const kept = history.slice(0, LADDER_HISTORY_KEEP);
  try {
    localStorage.setItem(LADDER_HISTORY_KEY, JSON.stringify(kept.map(trimLadderRun)));
  } catch {
    // 配额满 / 隐私模式：历史只是便利功能，不打扰用户
  }
  return kept;
}

/* ----------------------------------------------------------------------
 * 原生聊天页：会话落盘 + 采样选项落盘
 *
 * 上游用 SQLite（`kv` / `attachments` / `attachment_refs` 三张表），本工程没有数据库，
 * 只能用 localStorage。附件内容（尤其图片的 base64）动辄几百 KB，直接存会撑爆 5 MB 配额，
 * 所以**写盘前把每条附件的 `content` 清空**，只留名字与类型：重新打开历史会话时图片
 * 位置留空（消息文本照常显示），不影响继续对话。
 * ---------------------------------------------------------------------- */

const CHAT_CONVERSATIONS_KEY = "llamacpp-gui-chat-conversations";
const CHAT_OPTIONS_KEY = "llamacpp-gui-chat-options";

/** 会话条数上限与单会话消息上限：聊天记录是便利功能，不能让 localStorage 无限涨 */
const CHAT_CONVERSATION_LIMIT = 30;
const CHAT_MESSAGE_LIMIT = 200;
/** 工具结果落盘时保留的字符数：模型已经拿到全文，历史里留一份完整副本只会把 5 MB 配额吃光 */
const TOOL_RESULT_KEEP = 2_000;

function trimConversation(item: Conversation): Conversation {
  const messages = item.messages.slice(-CHAT_MESSAGE_LIMIT).map((message) => ({
    ...message,
    // 附件正文（图片 base64 / 文本原文）不落盘
    attachments: message.attachments?.map((file) => ({ ...file, content: "" })),
    // 工具结果（读网页动辄上万字符）落盘只留开头：写满配额会让设置、主题一起存不进去
    tools: message.tools?.map((tool) =>
      typeof tool.result === "string" && tool.result.length > TOOL_RESULT_KEEP
        ? {
            ...tool,
            result: `${tool.result.slice(0, TOOL_RESULT_KEEP)}\n…（历史记录只保留前 ${TOOL_RESULT_KEEP} 字符，完整内容当时已交给模型）`,
          }
        : tool,
    ),
  }));
  return { ...item, messages };
}

function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CHAT_CONVERSATIONS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Conversation[]).slice(0, CHAT_CONVERSATION_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveConversations(conversations: Conversation[]): Conversation[] {
  const kept = [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, CHAT_CONVERSATION_LIMIT)
    .map(trimConversation);
  try {
    localStorage.setItem(CHAT_CONVERSATIONS_KEY, JSON.stringify(kept));
  } catch {
    // 配额满 / 隐私模式：不打扰用户
  }
  return kept;
}

function loadChatOptions(): ChatOptions {
  try {
    const raw = localStorage.getItem(CHAT_OPTIONS_KEY);
    return normalizeChatOptions(raw ? (JSON.parse(raw) as unknown) : null);
  } catch {
    return normalizeChatOptions(null);
  }
}

function saveChatOptions(options: ChatOptions): void {
  try {
    localStorage.setItem(CHAT_OPTIONS_KEY, JSON.stringify(options));
  } catch {
    // 同上
  }
}

/** 聊天页的界面状态 */
export interface ChatState {
  conversations: Conversation[];
  /** 当前会话 id；null = 还没选（聊天页显示空态） */
  activeId: string | null;
  draft: string;
  attachments: ChatAttachment[];
  streaming: boolean;
  options: ChatOptions;
  error: string | null;
  /** 上一次「编辑回退」的撤销快照（有值时界面显示撤销条） */
  undo: ChatUndo | null;
  /** 生成中排队的下一问（busyMode = "queue"/"interrupt" 时挂在这里） */
  pending: { text: string; attachments: ChatAttachment[] } | null;
}

/** 上下文档位压测的界面状态（放 store：切页面不丢，见 HANDOVER §8 第 1 项） */
export interface ContextBenchState {
  running: boolean;
  /** 正在跑的档位（进度显示用） */
  currentTier: number | null;
  /** 已完成 / 失败 / 被停止的请求数，总数是 total */
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
  /** 本次开跑的时刻（epoch 毫秒），进度里的用时按它算 */
  startedAt: number | null;
  /** 逐条结果，随跑随追加（不必等全部结束才看得到） */
  samples: ContextBenchmarkSample[];
  /** 跑过的报告，最新的在最前（上游最多留 20 份） */
  history: ContextBenchmarkReport[];
  /** 结果面板正在看哪一份报告（null = 看最新跑完的那份） */
  selectedId: string | null;
  error: string | null;
}


/** 场景测试的界面状态（与 contextBench 同一套思路：切页面不丢） */
export interface ScenarioBenchState {
  running: boolean;
  /** 正在跑的「场景 / 第几轮」，进度显示用 */
  current: { scenario: string; round: number; total: number } | null;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
  /** 本次开跑的时刻（epoch 毫秒） */
  startedAt: number | null;
  /** 逐条结果，随跑随追加 */
  samples: ScenarioSample[];
  /** 跑过的报告，最新的在最前 */
  history: ScenarioBenchReport[];
  /** 结果面板正在看哪一份（null = 最新） */
  selectedId: string | null;
  error: string | null;
}


/** 并发阶梯的一次完整结果 */
export interface LadderRun {
  id: string;
  model: string;
  /** 跑的时候读到的槽数（拿不到就是 null，按 4 级压） */
  slots: number | null;
  /** 走过的级别：1、2、4 … */
  levels: number[];
  rows: LadderRow[];
  /** 逐条样本（落盘前清掉，只留内存）；用来在图上标出待跑的级别 */
  samples: LadderSample[];
  conclusion: LadderConclusion;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
}

/** 并发阶梯的界面状态（与另两个压测同一套思路：切页面不丢） */
export interface LadderState {
  running: boolean;
  /** 压到第几级（从 1 起）与这一级同时挂几个请求 */
  stage: number;
  concurrency: number;
  levels: number[];
  slots: number | null;
  completed: number;
  failed: number;
  startedAt: number | null;
  /** 本次的逐条样本，随跑随追加 */
  samples: LadderSample[];
  history: LadderRun[];
  selectedId: string | null;
  error: string | null;
}

interface AppStore {
  initialized: boolean;
  error: string | null;
  notice: string | null;
  busy: boolean;

  settings: Settings | null;
  paths: AppPaths | null;
  versions: LlamaCppVersion[];
  devices: DeviceInfo[];
  cudaReady: boolean;
  deviceError: string | null;
  logs: LogLine[];
  logFilter: string;

  /** 递归扫描到的模型（来自 Tauri） */
  scanned: ScannedModel[];
  /** 扫描到的辅助文件：多模态投影（mmproj）/ 外挂草稿模型（draft），不列进模型列表 */
  auxFiles: AuxFile[];
  /** 配置目录里的 config 清单（原生视图：「已配置」与 WebUI 开关的判据） */
  configs: ConfigEntry[];
  /** 前门合成的模型状态（llama.cpp 与 Strata 两通道） */
  routerModels: RouterModel[];
  /** 已拉取过的模型详情缓存 */
  modelProps: Record<string, ModelProps>;

  /** Strata 运行状态（第二运行时通道） */
  strataStatus: StrataStatus;
  /** 扫描到的 Strata config（= 可选模型） */
  strataEntries: StrataModelEntry[];
  /** 正在启动中的 config 文件名（卡片显示「加载中」用；启动结束即清空） */
  strataStarting: string | null;
  /** 正在卸载中的 config 文件名（卡片显示「卸载中」用；卸载结束即清空，用户 m04854） */
  strataStopping: string | null;
  /**
   * 正在启停的 llama.cpp 模型（卡片立刻给反馈用，用户 m03482 第 3 点）。
   *
   * 前门那侧的 `/models/load` 要等子实例 `/health` 就绪（几十秒）才返回，
   * 光靠轮询的话点下去这一两秒里卡片毫无变化，比 Strata 那边（有 `strataStarting`）
   * 显得迟钝。这里在发请求前先记下 id，卡片据此马上显示「加载中」。
   */
  modelPending: { id: string; stop: boolean } | null;

  init: () => Promise<void>;
  /** 允许重新走一遍 init（初始化失败后重试用；订阅不会因此重复注册） */
  resetInit: () => void;
  setError: (msg: string | null) => void;
  setNotice: (msg: string | null) => void;
  setLogFilter: (filter: string) => void;
  /** 当前主题（设置页顶栏的深浅色按钮用它） */
  theme: Theme;
  setTheme: (theme: Theme) => void;

  refreshVersions: (probe?: boolean) => Promise<void>;
  refreshDevices: () => Promise<void>;
  /**
   * 重读 settings。
   *
   * 有些命令会在后端**顺手改设置**（`strata_engines` / `strata_controllers` 在「自动跟随最新
   * 版本」开着时会写入选中的版本），前端读到的 settings 还是旧的，得再拉一次才勾得对。
   */
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  clearLogs: () => Promise<void>;
  fixAscii: (path: string) => Promise<string | null>;

  refreshModels: (force?: boolean, silent?: boolean) => Promise<void>;
  syncPreset: () => Promise<void>;
  importHubPresets: () => Promise<void>;
  /** 打开某个模型的 llama.cpp 自带聊天界面；多个在跑时不传 id 会返回 false 让界面去问用户 */
  openModelChat: (id?: string) => Promise<boolean>;
  refreshRouterModels: (reload?: boolean) => Promise<void>;

  /** 重扫 Strata 根目录下的 config 列表 */
  refreshStrata: () => Promise<void>;
  startStrata: (configFile?: string | null) => Promise<void>;
  /** 启动前门代理：DSH 等客户端连的端口，按请求里的 model 自动切换引擎（用户 m00798） */
  startStrataProxy: () => Promise<void>;
  /** 停止前门代理（引擎进程不动） */
  stopStrataProxy: () => Promise<void>;
  /** 卡片「启动模型」：确保引擎在跑且跑的是这个 config，然后 POST /load */
  startStrataModel: (configFile?: string | null) => Promise<boolean>;
  /** 卡片「停止模型」：POST /unload 卸模型，再把 GUI 起的那份引擎收掉（与 llama.cpp 侧一致） */
  stopStrataModel: (configFile: string) => Promise<void>;
  stopStrata: () => Promise<void>;
  /** 显存互斥（用户 m03160 第 2 点）：卸掉 llama.cpp 侧（前门）已加载的模型，返回被卸的模型名 */
  unloadRouterLoaded: () => Promise<string[]>;
  /** 拉一次运行时状态（生效上下文 / 加载状态 / token 占用） */
  probeStrata: () => Promise<void>;
  pickStrata: (configFile: string) => Promise<void>;
  /** 参数编辑 L2：写 config 原文，成功后刷新该条目（用于"需重启生效"比对） */
  writeStrataConfig: (configFile: string, text: string) => Promise<boolean>;
  startStrataPolling: () => void;
  stopStrataPolling: () => void;

  startModel: (id: string) => Promise<boolean>;
  stopModel: (id: string) => Promise<void>;
  toggleFavourite: (id: string) => Promise<void>;
  // 返回值 = 是否真的写盘成功。调用方要靠它决定"要不要接着做下一步"
  // （保存失败还接着删旧段/启动模型，就会把用户原来的配置也弄丢）
  saveModelSection: (section: string, entries: [string, string][]) => Promise<boolean>;
  removeModelSection: (section: string) => Promise<void>;
  loadModelProps: (id: string) => Promise<ModelProps | null>;
  /** 上下文档位压测（移植上下文基准）：跑哪个模型、结果如何都记在这里 */
  contextBench: ContextBenchState;
  runContextBench: (
    model: string,
    options?: Partial<ContextBenchmarkOptions>,
    knownMaxContext?: number | null,
  ) => Promise<void>;
  cancelContextBench: () => void;
  /** 结果面板切换要看的报告（null = 回到最新那一份） */
  selectContextBench: (id: string | null) => void;
  /** 场景测试（照上游 suite 模式）：一次跑多个场景 */
  scenarioBench: ScenarioBenchState;
  runScenarioBench: (
    model: string,
    options?: Partial<ScenarioBenchOptions>,
  ) => Promise<void>;
  cancelScenarioBench: () => void;
  /** 结果面板切换要看的报告（null = 回到最新那一份） */
  selectScenarioBench: (id: string | null) => void;
  /** 删掉某个模型的全部压测记录（上下文 + 场景各一份）：模型删掉后清残留（用户 m03137） */
  forgetBenchModel: (model: string) => void;
  /** 删掉某类压测里的指定几条记录（按报告 id；用户 m03319 第 3 条） */
  forgetBenchRecords: (kind: "context" | "scenario", ids: string[]) => void;
  /** 并发阶梯（照上游 stress 的 ramp 模式）：1 → 2 → 4 逐级加压 */
  ladder: LadderState;
  runLadder: (model: string, slots?: number | null) => Promise<void>;
  cancelLadder: () => void;
  /** 删掉指定记录（不传 id 只清当前显示），剩下最近的自动接手 */
  clearLadder: (id?: string) => void;
  /** 切换要看的记录（null = 回到最新那一份） */
  selectLadder: (id: string | null) => void;
  /** 原生聊天页（照上游 ChatPage 搬）：会话列表、草稿、采样选项、流式状态 */
  chat: ChatState;
  /** 发一轮对话：把草稿变成用户消息 + 流式生成助手消息 */
  sendChat: () => Promise<void>;
  /** 停掉正在生成的那一轮（保留已生成的内容） */
  stopChat: () => void;
  /** 新建空会话并切过去 */
  newConversation: () => void;
  selectConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  setChatDraft: (value: string) => void;
  addChatAttachments: (files: File[]) => Promise<void>;
  removeChatAttachment: (id: string) => void;
  setChatOptions: (patch: Partial<ChatOptions>) => void;
  /** 清掉聊天页的错误条 */
  dismissChatError: () => void;
  /** 重新生成第 index 条消息所在的那一轮回答（上游 regenerate） */
  regenerateReply: (index: number) => void;
  /** 改写第 index 条助手回答的正文，后面的消息隐藏（上游 editAnswer） */
  editAnswerText: (index: number, text: string) => void;
  /** 回到第 index 条消息：用户消息回填输入框 / 助手消息保留，后面的隐藏；branch = 从这里开分支 */
  rewindChat: (index: number, branch: boolean) => void;
  /** 撤销上一次编辑回退（撤销条上的按钮） */
  undoChatHistory: () => void;
  /** 只关掉撤销条、不撤销（用户自己点掉的提示） */
  dismissChatUndo: () => void;
  /** 取消生成中排队的那一问 */
  clearPendingChat: () => void;
  /** 监控采集层的最新快照（底部状态栏 / 弹层用） */
  monitor: MonitorSnapshot | null;
  /** 快照时刻（Unix 毫秒） */
  monitorAt: number;
  /** 速度折线的前端兜底序列（Llama 引擎不带 history，只能自己累积；Strata 走 /metrics.history）。 */
  speedSeries: { tokS: (number | null)[]; prefillTokS: (number | null)[] };
  /** 最近一次完成的请求（速度与上下文占用） */
  lastTurn: LastTurn | null;
  /** 最近若干次请求（监控页「最近请求」表，上游 req-card 的 9 列）。 */
  recentTurns: RecentTurn[];
  refreshMonitor: () => Promise<void>;
  /** MCP 服务器清单（聊天设置里编辑，后端落在 `mcp.json`） */
  mcpServers: McpServerConfig[];
  /** 已拉到的 MCP 工具；聊天设置里打开「MCP 工具」时才走 `mcp_tools_list` */
  mcpTools: McpToolView[];
  /** 拉取工具时的问题（逐台服务器的失败原因拼成一段） */
  mcpError: string | null;
  /** 重新读服务器清单（打开设置面板时） */
  refreshMcpServers: () => Promise<McpServerConfig[]>;
  /** 保存清单；后端会停掉已启动的进程，所以保存后要重新 `refreshMcpTools` */
  saveMcpServers: (next: McpServerConfig[]) => Promise<void>;
  /** 启动启用的服务器并拉工具，返回逐台状态（设置面板的「重新检测」用） */
  refreshMcpTools: () => Promise<McpToolsView | null>;
}

const emptyStrataStatus: StrataStatus = {
  running: false,
  port: 9090,
  pid: null,
  config_path: null,
  model_name: null,
  started_at_ms: null,
  last_error: null,
  version: null,
  live_max_context: null,
  loaded: null,
  busy: null,
  prompt_tokens: null,
  max_tokens: null,
  models_autoload: null,
  external: false,
  proxy: false,
  proxy_port: null,
  proxy_serving: null,
};

/** 运行时状态轮询句柄（Strata 没有 SSE，用定时探测代替） */
let strataTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 上一次 Strata 探测还在路上的标志。
 *
 * 一次探测最长要走两个超时（首探 3 秒 + 复探 3 秒），比 5 秒轮询周期还长，
 * 放任并发就会出现「旧的慢探测晚返回、把更新的好结果覆盖成已停止」——
 * 卡片于是「运行中 → 已停止 → 运行中」闪一下（用户 m13709）。所以撞上就跳过这一轮。
 */
let strataProbing = false;

/**
 * 模型列表轮询句柄。
 *
 * router 时代这个 5 秒轮询挂在「router 状态变成 running」上（`startRouterWatch`）；前门化
 * 之后前门随程序常开，没有那个状态变化可挂，于是改成 init 里无条件起一个（幂等，只起一次）——
 * 否则别人（DSH 等客户端）通过前门加载模型时，GUI 卡片的状态不会跟着变。
 */
let modelsTimer: ReturnType<typeof setInterval> | null = null;
/** 已经弹过「加载成功」的模型 id：同一次加载只提示一次（用户 m05033 第 1 点） */
const notifiedLoaded = new Set<string>();
/**
 * 「读前门列表」的请求序号。
 *
 * 1.5 秒的加载轮询、5 秒的常驻轮询、加载/卸载后的即时刷新是并发的，先发的请求可能后返回。
 * 只让最新一次的结果落到 store —— 否则一份「加载中」的旧快照会把已经拿到的「运行中」盖回去，
 * 卡片就停在「加载中」，要等下一次轮询才纠正（用户 m05562）。
 */
let modelsSeq = 0;
/**
 * 「读前门列表」是否已经记过一次失败日志。
 *
 * 前门不回包时这个循环每 5 秒（不成功还带 5 次重试）就跑一遍，每次都往日志里写会刷屏。
 * 只在「开始失败」和「恢复正常」两个瞬间各记一行，事后翻日志能看出故障区间（用户 m05885）。
 */
let modelsFailLogged = false;

/** config 路径 → 文件名（store 里比对「运行的是哪个 config」用） */
function strataBaseName(path: string): string {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || String(path);
}

/** 初始化进行中的那一次调用（init 的幂等用，见 `init`） */
let initInFlight: Promise<void> | null = null;

/**
 * 事件订阅的注册槽位（模块级，跨 init 调用存活）。
 *
 * 1. 订阅要**尽早注册**：它和「拉初始快照」是两件事，快照失败时订阅也该在跑 ——
 *    后端一恢复，实时状态 / 日志 / 扫描结果就自己回来，不必重启应用。
 *    （旧实现把四个订阅放在快照 await **之后**，init 一失败就一条都没注册，
 *    界面从此不再更新实时状态与日志。）
 * 2. 订阅只能**注册一次**：Tauri 的 `listen` 每调一次就多一份监听，重复注册会让
 *    同一个事件被处理多次（日志翻倍、模型状态来回抖）。槽位里存的是注册 Promise，
 *    已经注册过的槽位直接复用；某一条失败时只清空它自己，下次 init 只重试这一条。
 */
const listenerSlots: (Promise<void> | null)[] = [null, null, null, null];

/** 注册一条事件订阅（幂等；不主动注销 —— 订阅与应用同生命周期）。 */
async function ensureListener(slot: number, start: () => Promise<UnlistenFn>): Promise<void> {
  const pending = listenerSlots[slot];
  if (pending) {
    await pending;
    return;
  }
  const task = start().then(() => undefined);
  listenerSlots[slot] = task;
  try {
    await task;
  } catch (err) {
    listenerSlots[slot] = null; // 允许下次 init 重试这一条；已成功的槽位不受影响
    throw err;
  }
}

/** 订阅注册失败的额外重试（listen 失败多半也是启动瞬间后端没就绪，与快照失败同源） */
const LISTENER_RETRY_ROUNDS = 1;
const LISTENER_RETRY_DELAY_MS = 500;

/**
 * 注册全部事件订阅，返回失败项的描述（空数组 = 都成功）。
 *
 * 重试只针对**失败的那几条**（`ensureListener` 的槽位去重保证已成功的不会重复注册）。
 */
async function registerListeners(
  subs: { name: string; start: () => Promise<UnlistenFn> }[],
): Promise<string[]> {
  const problems: string[] = [];
  for (let round = 0; round <= LISTENER_RETRY_ROUNDS; round += 1) {
    const results = await Promise.allSettled(subs.map((sub, i) => ensureListener(i, sub.start)));
    problems.length = 0;
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        problems.push(`${subs[i].name}订阅失败：${errText(result.reason)}`);
      }
    });
    if (problems.length === 0 || round === LISTENER_RETRY_ROUNDS) break;
    await new Promise((resolve) => setTimeout(resolve, LISTENER_RETRY_DELAY_MS));
  }
  return problems;
}

/** 「缺了它界面就没法用」的那部分初始快照 */
interface EssentialSnapshot {
  settings: Settings;
  paths: AppPaths;
}

/** 关键快照的重试次数与间隔（启动瞬间 IPC 还没就绪是最常见的瞬时失败原因） */
const INIT_SNAPSHOT_ATTEMPTS = 3;
const INIT_SNAPSHOT_RETRY_DELAY_MS = 800;

/**
 * 拉关键快照（设置 / 应用路径 / router 状态），失败在内部重试几次再放弃。
 *
 * 原来整次 init 就一个 `Promise.all`，任何一项失败（哪怕只是日志快照）都会让
 * `initialized` 停在 true，init 再也进不来，只能重启应用。现在日志 / Strata 状态
 * 这类可选项不再参与这里（见 `init` 里的 allSettled），只有真正缺不了的三项失败
 * 才让这次 init 失败 —— 而且失败后 `initialized` 保持 false，下次调用还能重来。
 */
async function loadEssentialSnapshot(): Promise<EssentialSnapshot> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= INIT_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      const [settings, paths] = await Promise.all([ipc.settingsGet(), ipc.appPaths()]);
      return { settings, paths };
    } catch (err) {
      lastErr = err;
      if (attempt < INIT_SNAPSHOT_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, INIT_SNAPSHOT_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

export const useApp = create<AppStore>((set, get) => ({
  initialized: false,
  error: null,
  notice: null,
  busy: false,

  settings: null,
  paths: null,
  versions: [],
  devices: [],
  cudaReady: false,
  deviceError: null,
  logs: [],
  logFilter: "all",

  scanned: [],
  auxFiles: [],
  configs: [],
  routerModels: [],
  modelProps: {},
  strataStatus: emptyStrataStatus,
  strataEntries: [],
  strataStarting: null,
  strataStopping: null,
  modelPending: null,
  contextBench: {
    running: false,
    currentTier: null,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
    startedAt: null,
        samples: [],
        history: loadBenchHistory(),
        selectedId: null,
    error: null,
  },
  scenarioBench: {
    running: false,
    current: null,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
    startedAt: null,
    samples: [],
    history: loadScenarioHistory(),
    selectedId: null,
    error: null,
  },
  ladder: {
    running: false,
    stage: 0,
    concurrency: 0,
    levels: ladderLevels(4),
    slots: null,
    completed: 0,
    failed: 0,
    startedAt: null,
    samples: [],
    history: loadLadderHistory(),
    selectedId: null,
    error: null,
  },
  chat: {
    conversations: loadConversations(),
    activeId: null,
    draft: "",
    attachments: [],
    streaming: false,
    options: loadChatOptions(),
    error: null,
    undo: null,
    pending: null,
  },
  monitor: null,
  monitorAt: 0,
  speedSeries: { tokS: [], prefillTokS: [] },
  lastTurn: null,
  recentTurns: [],
  mcpServers: [],
  mcpTools: [],
  mcpError: null,

  async init() {
    // 幂等：成功过就直接返回；正在初始化时复用同一次调用
    // （React 严格模式下 effect 会跑两遍，否则快照会被拉两遍、订阅也会注册两遍）。
    if (get().initialized) return;
    if (initInFlight) return initInFlight;
    const task = (async () => {
      // 本次初始化里「界面能用、但用户该知道」的问题，最后一次性报出来
      const problems: string[] = [];

      // 模型列表的状态轮询：前门随程序常开，没有「router 起来了」这个事件可挂，所以无条件起一个。
      // 幂等（模块级句柄判空），resetInit 之后重跑 init 也不会叠加定时器。
      // 放在 init 最前面而不是尾部：后面任何一步抛错都不该让状态轮询失效 —— 少了它，
      // 卡片会停在最后一次刷新的状态上（用户 m05562：加载完仍显示「加载中」）。
      if (modelsTimer === null) {
        modelsTimer = window.setInterval(() => void get().refreshRouterModels(false), 5000);
      }

      // 1) 订阅先注册、且只注册一次（见 ensureListener / registerListeners）。
      //    它和下面的快照是两件事：快照失败时订阅也该在跑 —— 后端一恢复，
      //    实时状态 / 日志 / 扫描结果就自己回来，不必重启应用。
      const subs: { name: string; start: () => Promise<UnlistenFn> }[] = [
        {
          name: "日志",
          start: () =>
            onLogLines((lines) =>
              set((state) => {
                const merged = state.logs.concat(lines);
                return { logs: merged.length > LOG_LIMIT ? merged.slice(-LOG_LIMIT) : merged };
              }),
            ),
        },
        {
          name: "Strata 状态",
          // Strata 状态变化（启动成功 / 进程退出 / 探测刷新）。
          // 轮询是常驻的（见 init 尾部），这里只落状态，不再按 running 开关定时器。
          start: () =>
            onStrataStatus((s) => {
              set({ strataStatus: s });
            }),
        },
        {
          name: "模型扫描",
          // 启动时列表先来自落盘缓存，后端重扫完若确实有增删再刷新一次
          start: () =>
            onModelsScanned(({ models, aux_files }) => {
              set({ scanned: models, auxFiles: aux_files ?? [] });
              // 后台重扫也可能清理了失效段（模型被删掉时），同样要让 router 重读 preset
              if (get().strataStatus.proxy) void get().refreshRouterModels(true);
            }),
        },
      ];
      problems.push(...(await registerListeners(subs)));

      try {
        // 2) 关键快照：设置 / 路径缺了界面基本没法用，所以失败 = 这次 init 失败
        //    （内部已重试；仍失败时 initialized 保持 false，下次调用 init() 还能重来）。
        const { settings, paths } = await loadEssentialSnapshot();
        set({ settings, paths });

        // 3) 可选项各自独立：日志 / Strata 状态读失败只记一笔，不拖垮整次初始化。
        //    读不到就不覆盖 —— 别用默认值盖掉订阅已经推过来的实时数据。
        const [logsResult, strataResult] = await Promise.allSettled([
          ipc.logsSnapshot(),
          ipc.strataStatus(),
        ]);
        if (logsResult.status === "fulfilled") set({ logs: logsResult.value });
        else problems.push(`日志快照读取失败：${errText(logsResult.reason)}`);
        const strataStatus =
          strataResult.status === "fulfilled" ? strataResult.value : get().strataStatus;
        if (strataResult.status === "fulfilled") set({ strataStatus });
        else problems.push(`Strata 状态读取失败：${errText(strataResult.reason)}`);
        if (problems.length > 0) set({ error: problems.join("；") });

        // 4) 快照到位之后的动作：前门在跑就先拉一次模型状态
        //    （router 那个 status 字段已随退役删除，判据换成前门代理在不在监听）。
        if (strataStatus.proxy) {
          void get().refreshRouterModels(false);
        }

        // 模型列表最先发起：它的等待时间直接决定用户看到列表的早晚。
        // 这里用 silent：已经有落盘缓存，取回来是毫秒级的，不该让整个界面闪一下忙碌态。
        if (settings.model_roots.length > 0) {
          void get().refreshModels(false, true);
        }

        // 版本扫描与设备枚举放在后面，且**不阻塞** init：
        // `device_list` 要起一个 `llama-server --list-devices`（1~3 秒），
        // 早先把它 await 在模型扫描之前，等于让模型列白等这几秒。
        if (settings.llama_cpp_dir) {
          void (async () => {
            try {
              const versions = await ipc.versionsList(settings.llama_cpp_dir, false);
              set({ versions });
              void get().refreshDevices();
            } catch (err) {
              set({ error: errText(err) });
            }
          })();
        }

        // 打开程序不再自动启动 router（用户 m02352）：统一入口是前门（:9090），router 正在
        // 退役 —— 它自启会让日志里混进 router 自己的「Available models」段落，还可能和
        // llama.cpp 子实例抢显存。模型改由前门调度器按需拉起（容量上限仍是 `models_max`）。

        // Strata：扫一次 config 列表（根目录没设置时后端直接返回空，不报错）。
        // 探测定时器**常驻**：Strata 可以由用户自己跑 run-<model>.bat 拉起来，
        // 那种实例不在 GUI 的进程槽里，只有按选中 config 的端口探测才能发现它；
        // 若只在 running=true 时才轮询，快照永远是未运行，就永远轮询不起来。
        // 根目录只认用户在设置页填的那个（没有 `%LOCALAPPDATA%\Strata` 兜底，用户 m00308），
        // 没填时后端直接返回空列表，不报错：扫不到 config 时后端返回空列表，探测定时器照样常驻 ——
        // 用户可能自己跑 `run-<model>.bat` 把引擎拉起来，只有轮询才认得出那种实例。
        void get().refreshStrata();
        get().startStrataPolling();
        // Strata 状态这次没读到就别做这个判断：那样会把「其实在运行」当成未运行，
        // 白白再启一次（探测轮询随后会把真实状态补上）。
        // 前门随程序常开（后端 setup 里已经 autostart 过一次），这里只是兜底：那次若失败
        // （比如端口被占），前端初始化后再补一次。前门不加载模型、不占显存 —— 模型由客户端
        // 的第一个请求或卡片上的「加载」按需拉起（用户 m02258 第 2 点：引擎不再默认启动）。
        if (strataResult.status === "fulfilled" && !strataStatus.proxy) {
          void get().startStrataProxy();
        }

        // 模型列表的状态轮询：前门常开，没有「router 起来了」这个事件可挂，所以无条件起一个。
        // 幂等（模块级句柄判空），resetInit 之后重跑 init 也不会叠加定时器。
        // 5) 全部就位才算初始化成功：失败时 initialized 保持 false，下次调用 init() 能重来
        //    （订阅不会重复注册，见 ensureListener）。
        set({ initialized: true });
      } catch (err) {
        // 订阅失败的原因一并报出来，否则「初始化失败」会把真正的起因盖掉
        set({ error: [...problems, `初始化失败：${errText(err)}`].join("；") });
      }
    })();
    initInFlight = task;
    try {
      await task;
    } finally {
      // 无论成败都放开：失败时 initialized 还是 false，下次 init() 可以完整重来
      initInFlight = null;
    }
  },

  /**
   * 重新走一遍 init。
   *
   * 失败时 `initialized` 本来就没置位（只有整次初始化成功才置位），所以直接再调 init()
   * 即可；这个方法给界面上的「重试」用，也用于成功后想强制重来。订阅有模块级槽位去重，
   * 重复调用不会让同一份事件被处理多次。
   */
  resetInit() {
    set({ initialized: false });
  },

  setError: (msg) => set({ error: msg }),
  setNotice: (msg) => set({ notice: msg }),
  setLogFilter: (filter) => set({ logFilter: filter }),

  theme: initialTheme(),
  setTheme(theme) {
    localStorage.setItem("llamacpp-gui-theme", theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },

  async refreshVersions(probe = true) {
    set({ busy: true, error: null });
    try {
      const settings = get().settings;
      const versions = await ipc.versionsList(settings?.llama_cpp_dir ?? null, probe);
      set({ versions });
      const fresh = await ipc.settingsGet();
      set({ settings: fresh });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async refreshSettings() {
    try {
      set({ settings: await ipc.settingsGet() });
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  async refreshDevices() {
    try {
      const result = await ipc.deviceList();
      set({
        devices: result.devices,
        cudaReady: result.cuda_ready,
        deviceError: result.error,
      });
    } catch (err) {
      set({ deviceError: errText(err) });
    }
  },

  async saveSettings(patch) {
    set({ busy: true, error: null });
    try {
      const settings = await ipc.settingsSet(patch);
      set({ settings, notice: "设置已保存" });
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async clearLogs() {
    await ipc.logsClear();
    set({ logs: [] });
  },

  async fixAscii(path) {
    try {
      const fixed = await ipc.fixAsciiPath(path);
      set({ notice: `已创建 ASCII 链接: ${fixed}` });
      return fixed;
    } catch (err) {
      set({ error: errText(err) });
      return null;
    }
  },

  /**
   * 刷新模型列表。
   *
   * `silent` 用于启动路径：那时已经有落盘缓存，取回来是毫秒级的，
   * 不该把整个界面切进「忙碌」态（按钮全部变灰会闪一下）。
   */
  async refreshModels(force = true, silent = false) {
    if (!silent) set({ busy: true, error: null });
    try {
      const result = await ipc.modelsScan(force);
      set({
        scanned: result.models,
        auxFiles: result.aux_files ?? [],
        configs: result.configs ?? [],
      });

      // 扫描时后端会顺手清掉「模型文件已经不在了」的 preset 段，这里如实告诉用户
      const removed = result.removed_sections ?? [];
      const restored = result.restored_sections ?? [];
      if (removed.length > 0) {
        set({
          notice: `已自动清理 ${removed.length} 个失效的模型配置（模型文件已不存在，配置已存档）：${removed
            .slice(0, 5)
            .join("、")}${removed.length > 5 ? " …" : ""}`,
        });
      } else if (restored.length > 0) {
        set({
          notice: `已恢复 ${restored.length} 个模型的配置（模型重新出现，参数从存档接回）：${restored
            .slice(0, 5)
            .join("、")}${restored.length > 5 ? " …" : ""}`,
        });
      } else if (result.prune_skipped && !silent) {
        set({
          notice: "配置里的模型文件全都不存在，可能是模型盘没挂上或目录未就绪，已跳过自动清理",
        });

      }
      if (get().strataStatus.proxy) {
        // 必须带 reload：扫描时会顺手清理"模型文件已不存在"的 preset 段，
        // 而 router 的 preset 是启动时读进内存的 —— 不重读的话，删掉的模型会被它继续报回来，
        // 列表里就留着一个点不动也用不了的幽灵条目。
        await get().refreshRouterModels(true);
      }
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      if (!silent) set({ busy: false });
    }
  },

  async syncPreset() {
    set({ busy: true, error: null, notice: null });
    try {
      const result = await ipc.configSync();
      set({
        scanned: result.models,
        auxFiles: result.aux_files ?? [],
        configs: result.configs ?? [],
        notice: `已同步 ${result.models.length} 个模型的配置文件`,
      });
      if (get().strataStatus.proxy) {
        await get().refreshRouterModels(true);
      }
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async importHubPresets() {
    set({ busy: true, error: null, notice: null });
    try {
      const report = await ipc.configImportHub();
      // 参数已写进 config JSON（第三刀），重扫一遍让界面拿到最新的配置清单
      await get().refreshModels(false);
      const missing = report.missing.length ? `，${report.missing.length} 个模型在 hub 里没有配置` : "";
      set({
        notice: `已从 hub 迁移 ${report.matched}/${report.total} 个模型的参数（共 ${report.entries} 项）${missing}`,
      });
      if (get().strataStatus.proxy) {
        await get().refreshRouterModels(true);
      }
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  /**
   * 打开 llama.cpp 自带的聊天界面。
   *
   * 前门化（P1）之后两个入口都指向前门 —— 统一入口只留 :9090，router 即将退役：
   * - **不指定模型**（侧栏「开始聊天」）→ 打开前门根路径。界面里的模型列表来自前门
   *   合成的 `/v1/models`（两通道都有），在里面换模型后请求仍回到前门，由它按 `model` 路由。
   * - **指定模型**（模型卡片上的 💬）→ 带上 `?model=<id>`，前门把根路径转给那个子实例，
   *   进去就是它（代价是那个界面只服务这一个模型）。
   */
  async openModelChat(id) {
    const { strataStatus, routerModels } = get();
    if (!strataStatus.proxy) {
      set({ error: "前门未运行，请先在侧栏左下角启动前门" });
      return false;
    }
    const port = strataStatus.proxy_port ?? 9090;
    const keyHint = chatKeyHint(get().settings?.api_key);
    // 判「这个模型在不在跑」直接看前门给的合成列表：router 时代那套靠 `status.args`
    // 解析端口的 chatTargets 在前门化之后拿不到 args，恒为空，会让 💬 永远报「不在运行中」。
    if (
      id &&
      !routerModels.some((m) => m.id === id && (m.status?.value ?? "unloaded") === "loaded")
    ) {
      set({ error: `${id} 当前不在运行中，无法打开聊天界面（先在卡片上点「加载」）` });
      return false;
    }
    const url = id
      ? `http://127.0.0.1:${port}/?model=${encodeURIComponent(id)}`
      : `http://127.0.0.1:${port}/`;
    try {
      await ipc.openLocalUrl(url);
      set({
        notice: id
          ? `已在浏览器打开 ${id} 的聊天界面（该界面只服务这一个模型）${keyHint}`
          : `已在浏览器打开 llama.cpp 的聊天界面（在里面可以切换模型）${keyHint}`,
      });
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    }
  },

  async refreshRouterModels(reload = false) {
    const { settings, strataStatus } = get();
    // 本次刷新的序号：晚到的旧响应要靠它认出来并丢掉（见 modelsSeq）
    const seq = (modelsSeq += 1);
    // 前门带 --api-key 时所有端点都要鉴权，请求前先保证 key 是最新的
    setRouterApiKey(settings?.api_key);
    // 数据源是**前门**：它合成的 `/v1/models` 同时列 llama.cpp 与 Strata 两通道
    if (!strataStatus.proxy) {
      set({ routerModels: [] });
      return;
    }
    const port = strataStatus.proxy_port ?? 9090;
    // 端口就绪后偶发的一次超时/抖动不该直接报错，重试几次再放弃
    let lastErr: unknown = null;
    // 「加载成功」的提示以前由 router 的 SSE（`model_status` / `status_change`）推；
    // 前门化成轮询后没有事件了，靠两次快照对比补回来（用户 m02048 第 3 点）。
    const before = get().routerModels;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const models = await fetchModels(port, reload);
        // 这一次 await 期间可能已有更新的刷新跑完并落了状态，别拿旧快照盖回去（用户 m05562）
        if (seq !== modelsSeq) return;
        set({ routerModels: models });
        if (before.length > 0) {
          const wasLoaded = new Set(
            before.filter((m) => (m.status?.value ?? "unloaded") === "loaded").map((m) => m.id),
          );
          // 只报 llama.cpp 通道：Strata 的加载完成提示由 startStrataModel 自己给，
          // 这里再报一次就成了同一次加载弹两条（用户 m03482 第 4 点）。
          const freshIds = models
            .filter(
              (m) =>
                m.channel !== "strata" &&
                (m.status?.value ?? "unloaded") === "loaded" &&
                !wasLoaded.has(m.id) &&
                !notifiedLoaded.has(m.id),
            )
            .map((m) => m.id);
          // 同一个模型只提示一次：加载期间「1.5 秒的加载轮询」和「5 秒的常驻轮询」是并发的，
          // 两次调用可能都基于同一份旧快照算出「刚加载」，于是同一次加载弹好几条
          // （用户 m05033 第 1 点：一张卡弹了 4 次）。
          for (const id of freshIds) notifiedLoaded.add(id);
          const fresh = freshIds.map((id) => id.split("/").pop() || id);
          if (fresh.length > 0) set({ notice: `模型加载\n模型 ${fresh.join("、")} 加载成功` });
        }
        // 回到未加载就把名字放开，下次加载还会提示
        for (const m of models) {
          if ((m.status?.value ?? "unloaded") !== "loaded") notifiedLoaded.delete(m.id);
        }
        if (modelsFailLogged) {
          modelsFailLogged = false;
          reportFrontendError("info", "前门模型列表恢复正常");
        }
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    // 失败同样要认序号：这次重试用完 5 次时，可能已有更新的刷新成功并落了表，
    // 旧请求的失败不该再报一遍错（审查发现）
    if (seq !== modelsSeq) return;
    if (!modelsFailLogged) {
      modelsFailLogged = true;
      reportFrontendError("error", `读取前门模型列表失败：${errText(lastErr)}`);
    }
    set({ error: `读取前门模型列表失败：${errText(lastErr)}` });
  },

  // ---- Strata（第二运行时通道）----

  async refreshStrata() {
    try {
      const entries = await ipc.strataScan();
      set({ strataEntries: entries });
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  /** 启动前门代理（用户 m00798）：**DSH 等客户端连的端口**。
   *
   *  前门是"一个端口挂全部 config"：按请求里的 model 自动停旧引擎、起新引擎，
   *  所以 DSH 里选中哪个模型都能直接用；引擎端口（各 config 的 port）只给 GUI 自己用。
   *  只起前门不预加载模型：首次请求时才起引擎、加载模型（实测约 20–30 s，客户端超时 ≥60 s）。 */
  async startStrataProxy() {
    set({ busy: true, error: null, notice: null });
    try {
      // 显存互斥（用户 m03160 第 2 点）：前门会按需拉起引擎，先把 llama.cpp 侧占显存的模型卸掉
      let mutexNote = "";
      if (get().settings?.strata_router_mutex) {
        const unloaded = await get().unloadRouterLoaded();
        if (unloaded.length) mutexNote = `\n显存互斥：已卸载 llama.cpp 的 ${unloaded.join("、")}`;
      }
      const status = await ipc.strataProxyStart();
      set({ strataStatus: status });
      get().startStrataPolling();
      const port = status.proxy_port ?? status.port;
      set({
        notice: `Strata 代理已启动\nDSH 等客户端连 127.0.0.1:${port}（按请求里的 model 自动切换引擎）${mutexNote}`,
      });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  /** 停止前门代理：引擎进程与已加载的模型都不动（下次还能接着用）。 */
  async stopStrataProxy() {
    set({ busy: true, error: null, notice: null });
    try {
      set({ strataStatus: await ipc.strataProxyStop() });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async startStrata(configFile) {
    // 「加载中」胶囊的判据：ipc.strataStart 是 Rust 侧等端口就绪才返回，
    // 这段调用期间就是加载窗口。记下正在启动的 config 文件名，
    // 比全局 busy 精确（router 侧操作不该让 Strata 卡片转圈）。
    const startingFile = configFile ?? get().settings?.strata_selected_config ?? null;
    set({ busy: true, error: null, notice: null, strataStarting: startingFile });
    try {
      // 显存互斥（用户 m03160 第 2 点）：先把 llama.cpp 侧占显存的模型卸掉，再启动 Strata。
      // 卸载结果不在这里播报（用户 m03482 第 4 点）：这一步只是把引擎拉起来，模型还没加载，
      // 弹提示会被当成「启动成功」，紧接着加载完又弹一条，同一次启动两条提示。
      if (get().settings?.strata_router_mutex) {
        await get().unloadRouterLoaded();
      }
      const status = await ipc.strataStart(configFile ?? null);
      set({ strataStatus: status });
      get().startStrataPolling();
      // 选中的 config 已落盘，把设置取回来保持一致
      set({ settings: await ipc.settingsGet() });
      // 引擎起来不弹提示（用户 m03482 第 4 点）：这一步模型还没加载，
      // 提示「引擎已启动」看起来就是「启动成功」，随后加载完还会再弹一条。
      // 启动结果只由真正加载完（startStrataModel）的那一处报。
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false, strataStarting: null });

    }
  },

  /** 停止运行中的 Strata 模型：先 `/unload` 卸模型，再把 GUI 自己起的引擎收掉。
   *
   *  llama.cpp 侧「停止模型」就是前门 `/models/unload` → `scheduler::stop`，子实例进程一起退出；
   *  Strata 侧原先只 `/unload`、引擎留在端口上，用户看到引擎还在就以为没卸干净（用户 m00373）。
   *  这里对齐两边：卸完模型顺手停引擎。外部实例（用户自己跑的 run-<model>.bat）不动 ——
   *  它不归本 GUI 管，`strata_stop` 会点名报错。 */
  async stopStrataModel(configFile) {
    const st = get().strataStatus;
    if (!st.running) {
      set({ notice: "Strata 未运行" });
      return;
    }
    const runningFile = st.config_path ? strataBaseName(st.config_path) : null;
    if (runningFile && runningFile !== configFile) {
      set({ error: "当前运行的是其他模型，请先停止它" });
      return;
    }
    set({ busy: true, error: null, notice: null, strataStopping: configFile });
    try {
      await ipc.strataUnloadModel(configFile);
      // 卸载后再停引擎：`/unload` 让上游优雅退出、保存 learned expert profile、显存立刻释放，
      // 然后才杀进程树（顺序与 startStrataModel 的切换分支一致）。
      // 引擎状态取卸载后的最新快照（卸载期间引擎可能已自行退出；外部实例另算）。
      let after = get().strataStatus;
      let engineNote = "";
      if (after.running && !after.external) {
        try {
          after = await ipc.strataStop();
          set({ strataStatus: after });
        } catch (err) {
          // 这里只会接住「本 GUI 起的引擎没停下来」（超时、杀进程失败等）；
          // 外部实例在上一行的 `!after.external` 就挡掉了，别把两种情况说成同一种。
          engineNote = `\n已卸载模型，但引擎没有停下来：${errText(err)}`;
        }
      }
      // 文案必须与真实结果一致：外部实例压根没停，不能写「引擎已退出」（用户 m00373）
      const stopped = !after.running;
      const notice = stopped
        ? "已停止 Strata 模型（引擎已退出，显存已释放）"
        : after.external
          ? `已卸载 Strata 模型；引擎是外部启动的，仍在 ${after.port ? `:${after.port} ` : ""}运行（在它自己的控制台里停止）`
          : "已卸载 Strata 模型（引擎仍在运行，显存已释放）";
      set({ notice: `${notice}${engineNote}` });
      await get().probeStrata();
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      // 「卸载中」只在**真的还在卸**的时候挂着（用户 m04998）：Rust 侧 /unload 超时只有 60 秒，
      // 大模型卸载慢过它时会先报错，而引擎其实还在卸 —— 探测仍读到 loaded 就继续显示，
      // 最多再等 15 秒（免得引擎卡死时按钮永远点不动）。卸载快时这里一轮都不进，徽标立刻变「已停止」。
      const deadline = Date.now() + 15_000;
      while (get().strataStatus.loaded && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        await get().probeStrata();
      }
      set({ busy: false, strataStopping: null });
    }
  },

  /** 卡片「启动模型」：确保引擎在跑这个 config，然后**真的把模型加载起来**。
   *
   *  Strata 一个引擎只服务一份 config、绑定一个端口（用户 m00001：两个模型都写 9090），
   *  所以模型之间天然互斥 —— 切模型必须先把旧引擎卸干净：先 POST /unload（旧模型优雅
   *  退出、上游顺手保存 learned expert profile、显存立刻释放），再杀进程树，然后起新引擎、
   *  最后 /load。只起引擎不 /load 的话模型停在未加载态，卡片看起来仍然是「已停止」。 */
  async startStrataModel(configFile) {
    const file = configFile ?? get().settings?.strata_selected_config ?? null;
    if (!file) {
      set({ error: "请先选择一个 Strata 模型" });
      return false;
    }
    set({ busy: true, error: null, notice: null, strataStarting: file });
    try {
      // 显存互斥（用户 m03160 第 2 点）：先卸 llama.cpp 侧 loaded 的模型，再加载 Strata 模型
      let mutexNote = "";
      if (get().settings?.strata_router_mutex) {
        const unloaded = await get().unloadRouterLoaded();
        if (unloaded.length) mutexNote = `\n显存互斥：已卸载 llama.cpp 的 ${unloaded.join("、")}`;
      }
      const st = get().strataStatus;
      const runningFile = st.config_path ? strataBaseName(st.config_path) : null;
      const runningName = st.model_name || runningFile || "另一个模型";
      const switching = st.running && runningFile !== file;
      if (switching) {
        // Strata 互斥（用户 m00001）：先把旧模型卸掉再停引擎，别让两份权重同时占显存。
        // 只对 GUI 自己起的实例做 —— 外部实例（用户自己跑的 run-<model>.bat）的模型不归
        // 本 GUI 管，卸它没道理，停它会在下面的 strataStop 里拿到点名报错。
        if (st.loaded && !st.external && runningFile) {
          try {
            await ipc.strataUnloadModel(runningFile);
          } catch {
            /* 旧引擎忙或者已经退出：照旧走下面的进程树强杀 */
          }
        }
        await ipc.strataStop();
      }
      if (!st.running || runningFile !== file) {
        // 引擎没跑，或跑的是别的模型：重启引擎（一个引擎只服务一份 config）
        // 首次启动要等 python 起来（实测几十秒，里面还要初始化 CUDA），这段时间必须给一句
        // 阶段提示，否则用户只看到「加载中」却不知道在等什么（用户 m05033 第 2 点）。
        set({ notice: `正在启动 Strata 引擎…\n${strataBaseName(file)}` });
        const status = await ipc.strataStart(file);
        set({ strataStatus: status });
        get().startStrataPolling();
        set({ settings: await ipc.settingsGet() });
      }
      // 卡片按钮的语义是「启动并加载这个模型」：两条分支都要走到 /load，
      // 否则引擎起来了模型还是没加载，卡片一直显示「已停止」= 看起来启动失败
      set({ notice: `引擎已就绪，正在加载模型…\n${strataBaseName(file)}` });
      await ipc.strataLoadModel(file);
      const name = strataBaseName(file);
      set({
        notice: `${switching ? `已停止 ${runningName}（同端口互斥）\n` : ""}已加载 Strata 模型\n${name} · :${get().strataStatus.port}${mutexNote}`,
      });
      await get().probeStrata();
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    } finally {
      set({ busy: false, strataStarting: null });
    }
  },

  async stopStrata() {
    set({ busy: true, error: null });
    try {
      const status = await ipc.strataStop();
      // 停止后继续探测：端口上可能还跑着 GUI 之外的 Strata 实例
      get().startStrataPolling();
      set({ strataStatus: status });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async probeStrata() {
    // 无守卫：未运行时也要探测（后端对「没有选中 config / 端口为 0」直接回快照，不发请求），
    // 这样外部启动的实例能被轮询发现。
    // 唯一例外是「上一轮还没回来」：见 strataProbing 的注释，并发会让慢的旧结果盖掉新结果。
    if (strataProbing) return;
    strataProbing = true;
    try {
      // 单轮探测不应答不再由前端去抖：Rust 的 `strata::probe` 自己会在退化时复探一次，
      // 单轮抖动被复探吸收，而真停立刻反映 —— 本机关闭端口是即时 RST，复探几乎不花时间
      // （用户 m12735 要抖动消失，m13216 第 2 点要求真停不能延迟显示）。
      set({ strataStatus: await ipc.strataProbe() });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      strataProbing = false;
    }
  },

  /** 显存互斥（用户 m03160 第 2 点）：加载 Strata 模型前先卸掉 llama.cpp 侧已加载的模型。
   *
   *  router 退役前这里判的是 `status.running`（router 在不在跑），前门化后那个字段恒为 false，
   *  于是整段静默返回空数组 —— 互斥等于没开。现在改判前门在不在跑，卸载请求也发给前门
   *  （`POST /models/unload` 按 model 路由到对应子实例）。 */
  async unloadRouterLoaded() {
    const { strataStatus, routerModels } = get();
    if (!strataStatus.proxy) return [];
    // 只卸 llama.cpp 侧占显存的 loaded：strata 那档的 loaded 是引擎自己的状态，
    // 发给前门只会 404（前门只认配置目录里的模型）；sleeping 的显存已释放，loading 中的卸不掉。
    const loaded = routerModels.filter(
      (m) => m.channel !== "strata" && m.status?.value === "loaded",
    );
    if (!loaded.length) return [];
    const port = strataStatus.proxy_port ?? 9090;
    const unloaded: string[] = [];
    for (const m of loaded) {
      try {
        // 挂待停标记：卸载期间卡片显示「卸载中」。前门把 stopping 也报成 loading，光看状态分不出
        // 方向，会被渲染成「加载中」（用户 m05592）。
        set({ modelPending: { id: m.id, stop: true } });
        await apiUnloadModel(port, m.id);
        unloaded.push(m.id);
      } catch (err) {
        set({ error: `显存互斥：卸载 ${m.id} 失败：${errText(err)}` });
      }
    }
    if (unloaded.length) {
      // 前门返回时子实例可能刚收到停止信号，状态还是 stopping（前端映射为 loading），而常驻轮询
      // 5 秒才拍一次 —— 卡片会多停好几拍，显存其实早就放掉了（用户 m05592：卸载很快，显示明显滞后）。
      // 这里短轮询到前门报 unloaded 为止，8 秒兜底。
      const ids = new Set(unloaded);
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await get().refreshRouterModels(false);
        const still = get().routerModels.some(
          (m) => ids.has(m.id) && (m.status?.value ?? "unloaded") !== "unloaded",
        );
        if (!still) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    set({ modelPending: null });
    return unloaded;
  },

  async pickStrata(configFile) {
    try {
      set({ settings: await ipc.strataPick(configFile) });
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  async writeStrataConfig(configFile, text) {
    set({ busy: true, error: null });
    try {
      const entry = await ipc.strataConfigWrite(configFile, text);
      set((state) => ({
        strataEntries: state.strataEntries.map((e) =>
          e.config_path === entry.config_path ? entry : e,
        ),
      }));
      set({ notice: "参数已写入 config\n重启 Strata 后生效" });
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  /**
   * 运行时状态轮询。
   *
   * Strata 没有 router 的 `/models/sse`，生效上下文与 token 占用只能定时取。
   * 5 秒一次：加载一个 20GB 模型期间 `/health.loaded` 一直是 false，
   * 太快会把探测变成刷屏，太慢则用户看不到"加载好了"。
   */
  startStrataPolling() {
    get().stopStrataPolling();
    void get().probeStrata();
    strataTimer = setInterval(() => void get().probeStrata(), 5000);
  },

  stopStrataPolling() {
    if (strataTimer) {
      clearInterval(strataTimer);
      strataTimer = null;
    }
  },

  async startModel(id) {
    const { strataStatus } = get();
    if (!strataStatus.proxy) {
      set({ error: "前门未运行，请先在侧栏左下角启动前门" });
      return false;
    }
    // 先给卡片一个立刻的反馈（用户 m03482 第 3 点）：前门的 `/models/load` 要等子实例
    // `/health` 就绪才返回，只靠下面那 1.5 秒的轮询，点下去这一两秒里按钮毫无变化，
    // 比 Strata 那边（前端有 `strataStarting`）显得迟钝。
    set({ error: null, modelPending: { id, stop: false } });
    // 显存互斥（用户 m03342 / m03572）：加载模型前先卸掉 Strata 的模型 ——
    // 只卸模型释放显存，引擎进程与 WebUI 留着（卸的是模型，不是停进程）。
    // 注意与卡片上的「停止」不同：那是用户明说要停，会连引擎一起收（`stopStrataModel`）；
    // 这里是自动互斥，别把用户可能正在用的 WebUI 停掉。
    // 反方向（先加载 Strata 模型 → 卸 llama.cpp 侧的模型）在 unloadRouterLoaded 里，
    // 两向合起来才是用户 m03160 第 2 点要的「Strata 与 llama.cpp 显存互斥」。
    const st = get().strataStatus;
    if (get().settings?.strata_router_mutex && st.running && st.loaded) {
      const strataFile = st.config_path ? strataBaseName(st.config_path) : null;
      if (strataFile) {
        try {
          await ipc.strataUnloadModel(strataFile);
          set({ notice: "显存互斥：已卸载 Strata 的模型（引擎仍在运行，显存已释放）" });
          void get().probeStrata();
        } catch (err) {
          set({ error: `显存互斥未能卸载 Strata 模型：${errText(err)}` });
        }
      }
    }
      // 加载/卸载都走**前门**：它按 `model` 路由，命中 llama.cpp 通道时由调度器起子实例
      // （`POST /models/load` 会等到 `/health` 就绪才返回）。
      // 「加载中」徽标（用户 m03333 第 3 点）：上面这个 await 要等子实例 /health 就绪
      // （实测几十秒）才返回，期间一次都不刷新状态的话，卡片整段都停在「已停止」。
      // 所以起个短轮询，把前门报的 `state=starting`（前端映射成 loading）拉回来。
    try {
      const tick = window.setInterval(() => void get().refreshRouterModels(false), 1500);
      try {
        await apiLoadModel(strataStatus.proxy_port ?? 9090, id);
      } finally {
        window.clearInterval(tick);
      }
      // 「加载成功」的提示在这里给：上面这个 await 返回就意味着子实例 `/health` 已就绪，
      // 这一行是「确已加载完成」的时刻。不再只靠轮询两次快照对比 —— GUI 刚起来时首帧
      // 快照还是空的（`refreshRouterModels` 里 `before.length > 0` 那条守卫会跳过对比），
      // 于是本次会话里**第一个**加载的模型没有提示，第二个才正常（用户 m05562）。
      // 先登记再提示：轮询那边同一 id 就不会再报一次。
      notifiedLoaded.add(id);
      set({ notice: `模型加载\n模型 ${id.split("/").pop() || id} 加载成功` });
      await get().refreshRouterModels(false);
      // 上面这次刷新之后卡片就该是「运行中」。可并发轮询里更早发出的请求可能这会儿才回来，
      // 拿「加载中」的旧快照把状态盖回去（用户 m05562：提示弹了、卡片还是加载中）。像
      // stopModel 那样盯到前门报 loaded 再收工，8 秒兜底 —— 前门确实已就绪时第一轮检查就过，
      // 不额外等（用户 m04998：不做人为拖延）。
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const m = get().routerModels.find((x) => x.id === id);
        if (m && (m.status?.value ?? "unloaded") === "loaded") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await get().refreshRouterModels(false);
      }
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    } finally {
      set({ modelPending: null });
    }
  },

  async stopModel(id) {
    const { strataStatus } = get();
    if (!strataStatus.proxy) return;
    // 「卸载中」只在**真的还在卸**的时候显示（用户 m04998）：卸载快就直接变「已停止」，
    // 不人为拖时间；卸载慢（前门要等子实例退出）时这段窗口自然看得见。
    set({ error: null, modelPending: { id, stop: true } });
    try {
      // 卸载同样有一段「卸载中」窗口（前门要等子实例退出），一并轮询
      const tick = window.setInterval(() => void get().refreshRouterModels(false), 1500);
      try {
        await apiUnloadModel(strataStatus.proxy_port ?? 9090, id);
      } finally {
        window.clearInterval(tick);
      }
      await get().refreshRouterModels(false);
      // 前门返回时状态可能还是 stopping（前端映射为 loading），而常驻轮询 5 秒才拍一次 —— 立刻清掉
      // 待停标记会让卡片先闪回「加载中」再变「已停止」（用户 m05592）。等前门报 unloaded 再放手，
      // 8 秒兜底；卸载失败会走 catch，不在这里白等。
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const m = get().routerModels.find((x) => x.id === id);
        if (!m || (m.status?.value ?? "unloaded") === "unloaded") break;
        await new Promise((resolve) => setTimeout(resolve, 500));
        await get().refreshRouterModels(false);
      }
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ modelPending: null });
    }
  },

  async toggleFavourite(id) {
    try {
      const favourites = await ipc.favouriteToggle(id);
      const settings = get().settings;
      if (settings) {
        set({ settings: { ...settings, favourites } });
      }
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  async saveModelSection(section, entries) {
    set({ busy: true, error: null, notice: null });
    try {
      await ipc.configUpsert(section, entries);
      set({ notice: `已保存配置「${section}」` });
      if (get().strataStatus.proxy) {
        await get().refreshRouterModels(true);
      }
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    } finally {
      set({ busy: false });
    }
  },

  async removeModelSection(section) {
    // 删之前记下模型名：压测历史按名字存（`report.model`），删完就查不到了（用户 m03137）
    const removedName = get().configs.find((c) => c.id === section)?.name ?? section;
    set({ busy: true, error: null, notice: null });
    try {
      await ipc.configRemove(section);
      set({ notice: `已删除配置「${section}」` });
      if (removedName) get().forgetBenchModel(removedName);
      if (get().strataStatus.proxy) {
        await get().refreshRouterModels(true);
      }
      await get().refreshModels();
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async loadModelProps(id) {
    const { strataStatus } = get();
    // 前门化后端点在前门上（router 那个 status 字段已随退役删除）
    if (!strataStatus.proxy) return null;
    try {
      const props = await fetchProps(strataStatus.proxy_port ?? 9090, id);
      set({ modelProps: { ...get().modelProps, [id]: props } });
      return props;
    } catch (err) {
      set({ error: errText(err) });
      return null;
    }
  },
  /**
   * 上下文档位压测（移植 strata-manager 的 context benchmark）。
   * 与上游唯一的差别在分词：llama.cpp 没有 `/v1/messages/count_tokens`，
   * 所以输入长度先按「每行约 28 token」估算，再用第一趟 usage 里的真实
   * prompt_tokens 修正一次行数（见 docs/archive/STRATA_MANAGER_PORT_ASSESSMENT.md §6 P1）。
   * 取消走模块级的 `benchAbort`：点「停止」中断当前请求，跑完的档位留在 samples 里。
   */
  async runContextBench(model, options, knownMaxContext) {
    if (get().contextBench.running) return;
    const port = get().strataStatus.proxy_port ?? 9090;
    const opts: ContextBenchmarkOptions = { ...DEFAULT_CONTEXT_BENCHMARK_OPTIONS, ...options };
    const controller = new AbortController();
    benchAbort = controller;
    const samples: ContextBenchmarkSample[] = [];
    const startedAt = Date.now();
    set({
      contextBench: {
        ...get().contextBench,
        running: true,
        currentTier: null,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
        startedAt,
        samples: [],
        error: null,
      },
    });
    // 每跑完一条就同步一次：不必等全部结束才看得到结果（HANDOVER §8 第 1 项）
    const sync = () =>
      set({
        contextBench: {
          ...get().contextBench,
          samples: [...samples],
          completed: samples.filter((s) => s.state === "completed").length,
          failed: samples.filter((s) => s.state === "failed").length,
          cancelled: samples.filter((s) => s.state === "cancelled").length,
        },
      });
    let maxContext: number | null = null;
    let skipped: ContextBenchmarkSkippedTier[] = [];
    let stopReason: ContextBenchmarkReport["stopReason"] = "completed";
    try {
      validateContextBenchmarkOptions(opts);
      // 组件已经从模型配置里读到了上限就直接用：Strata 引擎没有 /props 端点
      // （返回网页，JSON 解析失败会把整个压测打断），llama.cpp 那边发了还会把模型拉起来
      // （用户 m11407）。只有拿不到时才退回问前门（用户 m12533 第 2 点）。
      maxContext = knownMaxContext ?? null;
      if (maxContext === null) {
        ({ maxContext } = await fetchChatModelProps(port, model));
      }
      const wanted = opts.tiers.length > 0 ? opts.tiers : getContextBenchmarkTiers(maxContext);
      const plan = planContextBenchmarkTiers(wanted, maxContext, opts.maxTokens);
      skipped = plan.skipped;
      if (plan.supported.length === 0) {
        throw new Error(plan.skipped[0]?.reason ?? "没有可跑的档位");
      }
      set({ contextBench: { ...get().contextBench, total: plan.supported.length * opts.rounds } });
      let stop = false;
      // 这个模型「每行合成记录到底多少 token」。首档用常量估，量出来之后立刻换成实测值，
      // 后面几档首发就够准、不必再校正重发（用户 m13507 第 4 点）。
      let tokensPerLine = ESTIMATED_RECORD_TOKENS;
      for (const tier of plan.supported) {
        for (let round = 1; round <= opts.rounds; round += 1) {
          if (controller.signal.aborted) {
            stopReason = "cancelled";
            stop = true;
            break;
          }
          set({ contextBench: { ...get().contextBench, currentTier: tier } });
          const nonceBase = `${Date.now()}-${tier}-${round}`;
          let lines = estimateRecordLines(tier, tokensPerLine);
          let method: ContextBenchmarkSample["tokenCountMethod"] = "estimated";
          let reason = `没有分词计数端点，按每行约 ${tokensPerLine.toFixed(1)} token 估算`;
          let result: ChatStreamResult | null = null;
          let failure: string | undefined;
          const sampleStart = Date.now();
          // 先手动采一次硬件（采集线程 1 秒一次，极短的档位可能覆盖不到窗口）
          await monitorSampleNow();
          try {
            for (let attempt = 0; attempt < 2; attempt += 1) {
              result = await streamChat({
                port,
                model,
                messages: contextBenchmarkMessages(lines, `${nonceBase}-${attempt}`),
                maxTokens: opts.maxTokens,
                temperature: 0,
                timeoutMs: opts.timeoutMs,
                signal: controller.signal,
              });
              const promptTokens = result.usage.promptTokens;
              // 先把这个模型真实的「每行多少 token」记下来，供后面几档首发用
              if (promptTokens && promptTokens > 0) {
                tokensPerLine = measureTokensPerLine(lines, promptTokens);
              }
              if (attempt === 0 && needsAdjustment(tier, promptTokens)) {
                const next = adjustRecordLines(tier, lines, promptTokens ?? 0);
                if (next !== lines) {
                  lines = next;
                  method = "adjusted";
                  reason = `按实际 usage 校正到约 ${promptTokens} token 后重发`;
                  continue;
                }
              }
              break;
            }
          } catch (err) {
            failure = errText(err);
          }
          const cancelled = controller.signal.aborted;
          const promptTokens = result?.usage.promptTokens ?? null;
          const completion = result?.usage.completionTokens ?? null;
          // 没有 TTFT（失败，或流式没收到首 token）时按整段墙钟算解码时间。
          // 旧写法 `?? result.wallMs` 让差值恒为 0、被 clamp 成 1ms，兜底速度会放大 1000 倍。
          const decodeMs = result ? Math.max(1, result.wallMs - (result.firstTokenMs ?? 0)) : 0;
          // 速度优先用 llama.cpp 自己报的 timings：那是纯计算时间，不含排队、前门转发
          // 与客户端解析；按到达时刻自己估会被这些环节污染（用户 m11542 第 3 点）。
          const timings = result?.timings ?? null;
          const draftN = timings?.draftN ?? null;
          const draftHits = timings?.draftNAccepted ?? null;
          const usage = await sampleRange(sampleStart, Date.now());
          samples.push({
            index: samples.length,
            tier,
            round,
            targetTokens: tier,
            lines,
            model,
            state: failure ? (cancelled ? "cancelled" : "failed") : "completed",
            startedAt: sampleStart,
            tokenCountMethod: method,
            calibrationReason: reason,
            promptTokens,
            completionTokens: completion,
            cachedTokens: result?.usage.cachedTokens ?? null,
            prefillTokS:
              timings?.promptPerSecond ??
              (result?.firstTokenMs && promptTokens
                ? promptTokens / (result.firstTokenMs / 1000)
                : null),
            decodeTokS:
              timings?.predictedPerSecond ?? (completion ? completion / (decodeMs / 1000) : null),
            ttftMs: result?.ttfbMs ?? null,
            wallMs: result ? Math.round(result.wallMs) : Date.now() - sampleStart,
            finishReason: result?.finishReason ?? null,
            output: result?.output.slice(0, 2000) ?? "",
            peakGpuMemory: usage.peakGpuMemory,
            peakRam: usage.peakRam,
            minGpuMemoryFree: usage.minGpuMemoryFree,
            resourceSamples: usage.count,
            draftAccept:
              draftN !== null && draftN > 0 && draftHits !== null ? draftHits / draftN : null,
            error: failure,
          });
          sync();
          // 监控页的「最近请求」与速度卡只认 GUI 聊天页的请求（sendChat 收尾里写），
          // 压测走的是 streamChat，原先一条都不写 —— 于是压测期间监控页整块是空的（用户 m00279）。
          // 现在每条样本也记一行（场景压测只写 lastTurn，不占这张表）。
          // 失败/中止的样本不带尝试中残留的数据：attempt0 成功、attempt1 抛错时 `result`
          // 仍是第一次的值，原样写进去会出现「标着失败却 tokens 齐全」的行。
          const row: RecentTurn = {
            id: newId(),
            model,
            at: Date.now(),
            promptTokens: failure ? null : promptTokens,
            outputTokens: failure ? null : completion,
            decodeTokS: failure
              ? null
              : (timings?.predictedPerSecond ??
                (completion ? completion / (decodeMs / 1000) : null)),
            prefillTokS: failure
              ? null
              : (timings?.promptPerSecond ??
                (result?.firstTokenMs && promptTokens
                  ? promptTokens / (result.firstTokenMs / 1000)
                  : null)),
            cacheTokens: failure ? null : (result?.usage.cachedTokens ?? null),
            elapsedMs: result ? Math.round(result.wallMs) : Date.now() - sampleStart,
            ok: !failure,
            error: failure,
          };
          set((state) => ({
            recentTurns: [row, ...state.recentTurns].slice(0, RECENT_TURN_LIMIT),
            // 速度卡与状态栏读 lastTurn，压测过的条目也要能撑起「最近一次」读数
            lastTurn: {
              at: row.at,
              promptTokens: row.promptTokens,
              outputTokens: row.outputTokens,
              decodeTokS: row.decodeTokS,
              prefillTokS: row.prefillTokS,
              cacheTokens: row.cacheTokens,
              elapsedMs: row.elapsedMs,
            },
          }));
          if (cancelled) {
            stopReason = "cancelled";
            stop = true;
            break;
          }
          if (failure && opts.stopOnError) {
            stopReason = "error";
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      const finishedAt = Date.now();
      const failed = samples.some((s) => s.state === "failed");
      const report: ContextBenchmarkReport = {
        schemaVersion: 3,
        id: `${finishedAt.toString(36)}-${samples.length}`,
        model,
        maxContext,
        options: opts,
        samples,
        skipped,
        state: stopReason === "cancelled" ? "cancelled" : failed ? "failed" : "completed",
        stopReason,
        startedAt,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
      };
      set({
        contextBench: {
          ...get().contextBench,
          running: false,
          currentTier: null,
          // 上游最多留 20 份报告
          history: saveBenchHistory([report, ...get().contextBench.history]),
          selectedId: report.id,
        },
      });
    } catch (err) {
      const message = errText(err);
      const cancelled = controller.signal.aborted;
      set({
        contextBench: {
          ...get().contextBench,
          running: false,
          currentTier: null,
          error: cancelled ? null : message,
        },
      });
      // 用户自己点的取消不算错误，不弹提示
      if (!cancelled) set({ error: `上下文档位压测失败：${message}` });
    } finally {
      benchAbort = null;
    }
  },


  cancelContextBench() {
    benchAbort?.abort();
  },

  selectContextBench(id) {
    set({ contextBench: { ...get().contextBench, selectedId: id } });
  },

  async runScenarioBench(model, options) {
    if (get().scenarioBench.running) return;
    const port = get().strataStatus.proxy_port ?? 9090;
    const opts: ScenarioBenchOptions = { ...DEFAULT_SCENARIO_BENCH_OPTIONS, ...options };
    const controller = new AbortController();
    scenarioAbort = controller;

    const samples: ScenarioSample[] = [];
    const startedAt = Date.now();
    // 每跑完一条就同步一次，不必等全部结束才看得到结果
    const sync = (patch?: Partial<ScenarioBenchState>): void => {
      let completed = 0;
      let failed = 0;
      let cancelled = 0;
      for (const s of samples) {
        if (s.warmup) continue;
        if (s.state === "completed") completed += 1;
        else if (s.state === "failed") failed += 1;
        else cancelled += 1;
      }
      set({ scenarioBench: { ...get().scenarioBench, completed, failed, cancelled, ...patch } });
    };

    set({
      scenarioBench: {
        ...get().scenarioBench,
        running: true,
        current: null,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
        startedAt,
        samples: [],
        error: null,
      },
    });

    let stopReason: ScenarioBenchReport["stopReason"] = "completed";

    try {
      validateScenarioBenchOptions(opts);
      const total = estimateScenarioRequests(opts);
      set({ scenarioBench: { ...get().scenarioBench, total } });

      // 多轮对话要把之前每轮的问答带上（上游 conversation 场景的同一做法）
      const conversation: ChatMessage[] = [];
      let stop = false;
      // 重复模式：整轮都用第一轮的输入，才测得出前缀缓存
      const fixedRound = 1;

      for (const scenario of opts.scenarios) {
        if (stop) break;
        const rounds = opts.rounds;
        const turns = scenario === "conversation" ? opts.conversationTurns : 1;
        // 热身：每个场景先空跑一次，不进汇总
        const passes = opts.warmup ? 2 : 1;
        for (let pass = 0; pass < passes && !stop; pass += 1) {
          const warmup = opts.warmup && pass === 0;
          for (let round = 1; round <= rounds && !stop; round += 1) {
            const useRound = opts.mode === "repeat" ? fixedRound : round;
            for (let turn = 1; turn <= turns; turn += 1) {
              if (controller.signal.aborted) {
                stopReason = "cancelled";
                stop = true;
                break;
              }
              set({
                scenarioBench: {
                  ...get().scenarioBench,
                  current: {
                    scenario,
                    round: useRound,
                    total: plannedPerScenario(opts, scenario),
                  },
                },
              });
              const messages = scenarioMessages(scenario, opts, useRound, turn, conversation);
              const sampleStart = Date.now();
              let result: ChatStreamResult | null = null;
              let failure: string | undefined;
              try {
                result = await streamChat({
                  port,
                  model,
                  messages,
                  maxTokens: opts.maxTokens,
                  temperature: 0,
                  timeoutMs: opts.timeoutMs,
                  signal: controller.signal,
                });
              } catch (err) {
                failure = errText(err);
              }
              const cancelled = controller.signal.aborted;
              const sample: ScenarioSample = {
                index: samples.length,
                scenario,
                warmup,
                turn,
                state: failure ? (cancelled ? "cancelled" : "failed") : "completed",
                startedAt: sampleStart,
                ttftMs: result?.ttfbMs ?? null,
                wallMs: result?.wallMs ?? Math.max(0, Date.now() - sampleStart),
                promptTokens: result?.usage.promptTokens ?? null,
                completionTokens: result?.usage.completionTokens ?? null,
                cachedTokens: result?.usage.cachedTokens ?? null,
                // 速度一律用 llama.cpp 自己报的 timings（纯计算时间，不含排队与转发）
                prefillTokS: result?.timings?.promptPerSecond ?? null,
                decodeTokS: result?.timings?.predictedPerSecond ?? null,
                finishReason: result?.finishReason ?? null,
                output: result?.output.slice(0, 2000) ?? "",
                error: failure,
              };
              samples.push(sample);
              // 监控页的速度卡与状态栏读 lastTurn：场景压测也撑起「最近一次」读数
              //（不写 recentTurns —— 那张表只记聊天页与上下文压测，免得几十条样本把它冲空）。
              set({
                lastTurn: {
                  at: sampleStart,
                  promptTokens: sample.promptTokens,
                  outputTokens: sample.completionTokens,
                  decodeTokS: sample.decodeTokS,
                  prefillTokS: sample.prefillTokS,
                  cacheTokens: sample.cachedTokens,
                  elapsedMs: sample.wallMs,
                },
              });
              // 多轮对话：把本轮的问答接进去，下一轮才有上下文
              if (scenario === "conversation" && result && !failure) {
                conversation.push(...messages);
                conversation.push({ role: "assistant", content: result.output });
              }
              sync();
              if (cancelled) {
                stopReason = "cancelled";
                stop = true;
                break;
              }
              if (failure && !warmup && opts.stopOnError) {
                stopReason = "error";
                stop = true;
                break;
              }
            }
          }
        }
      }

      const finishedAt = Date.now();
      const failed = samples.some((s) => s.state === "failed");
      const report: ScenarioBenchReport = {
        schemaVersion: 1,
        id: `${finishedAt.toString(36)}-${samples.length}`,
        model,
        options: opts,
        samples,
        state: stopReason === "cancelled" ? "cancelled" : failed ? "failed" : "completed",
        stopReason,
        startedAt,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
      };
      set({
        scenarioBench: {
          ...get().scenarioBench,
          running: false,
          current: null,
          samples,
          history: saveScenarioHistory([report, ...get().scenarioBench.history]),
          selectedId: report.id,
        },
      });
    } catch (err) {
      const message = errText(err);
      const cancelled = controller.signal.aborted;
      set({
        scenarioBench: {
          ...get().scenarioBench,
          running: false,
          current: null,
          samples,
          // 用户自己点的取消不算错误，不弹提示
          error: cancelled ? null : `场景测试失败：${message}`,
        },
      });
    } finally {
      scenarioAbort = null;
    }
  },

  cancelScenarioBench() {
    scenarioAbort?.abort();
  },

  selectScenarioBench(id) {
    set({ scenarioBench: { ...get().scenarioBench, selectedId: id } });
  },

  /**
   * 删掉某个模型的全部压测记录（用户 m03137）。
   *
   * 两类记录都按**模型名**存（`report.model` 来自下拉里的 name），所以模型删掉之后
   * 面板里再也选不到它，记录就变成了没人能清的残留 —— 这里按名字一把清掉。
   */
  forgetBenchModel(model) {
    const contextHistory = saveBenchHistory(get().contextBench.history.filter((r) => r.model !== model));
    const scenarioHistory = saveScenarioHistory(get().scenarioBench.history.filter((r) => r.model !== model));
    set({
      contextBench: { ...get().contextBench, history: contextHistory, selectedId: null },
      scenarioBench: { ...get().scenarioBench, history: scenarioHistory, selectedId: null },
    });
  },

  forgetBenchRecords(kind, ids) {
    if (ids.length === 0) return;
    const drop = new Set(ids);
    if (kind === "context") {
      const history = saveBenchHistory(get().contextBench.history.filter((r) => !drop.has(r.id)));
      set({ contextBench: { ...get().contextBench, history, selectedId: null } });
      return;
    }
    const history = saveScenarioHistory(get().scenarioBench.history.filter((r) => !drop.has(r.id)));
    set({ scenarioBench: { ...get().scenarioBench, history, selectedId: null } });
  },

  async runLadder(model, slots) {
    if (get().ladder.running) return;
    const port = get().strataStatus.proxy_port ?? 9090;

    // 槽数决定压到第几级：llama.cpp `/props` 的 `total_slots`（`--parallel` 决定的）。
    // 这是「点开始」时才问的 —— 它会把模型拉起来，但那本来就是要跑的（用户 m11407 只禁「选模型就加载」）。
    let slotCount = slots ?? null;
    if (slotCount === null) {
      try {
        slotCount = (await fetchChatModelProps(port, model)).totalSlots;
      } catch {
        slotCount = null;
      }
    }
    const levels = ladderLevels(slotCount ?? 4);

    const controller = new AbortController();
    ladderAbort = controller;
    const samples: LadderSample[] = [];
    const startedAt = Date.now();

    const sync = (): void => {
      let completed = 0;
      let failed = 0;
      for (const s of samples) {
        if (s.state === "completed") completed += 1;
        else if (s.state === "failed") failed += 1;
      }
      set({ ladder: { ...get().ladder, completed, failed } });
    };

    set({
      ladder: {
        ...get().ladder,
        running: true,
        stage: 0,
        concurrency: 0,
        levels,
        slots: slotCount,
        completed: 0,
        failed: 0,
        startedAt,
        samples: [],
        error: null,
      },
    });

    // 阶梯的每题都用「长输出」场景：256 token 的持续生成最能反映并发下的产出
    const ladderOptions: ScenarioBenchOptions = {
      ...DEFAULT_SCENARIO_BENCH_OPTIONS,
      scenarios: ["decode"],
      mode: "unique",
    };
    let seq = 0;

    const runOne = async (stage: number, concurrency: number): Promise<void> => {
      const round = (seq += 1);
      const sampleStart = Date.now();
      let result: ChatStreamResult | null = null;
      let failure: string | undefined;
      try {
        result = await streamChat({
          port,
          model,
          messages: scenarioMessages("decode", ladderOptions, round, 1, []),
          maxTokens: 256,
          temperature: 0,
          timeoutMs: 180_000,
          signal: controller.signal,
        });
      } catch (err) {
        failure = errText(err);
      }
      const cancelled = controller.signal.aborted;
      samples.push({
        stage,
        concurrency,
        state: failure ? (cancelled ? "cancelled" : "failed") : "completed",
        startedAt: sampleStart,
        wallMs: result?.wallMs ?? Math.max(0, Date.now() - sampleStart),
        ttftMs: result?.ttfbMs ?? null,
        completionTokens: result?.usage.completionTokens ?? null,
        decodeTokS: result?.timings?.predictedPerSecond ?? null,
        error: failure,
      });
      sync();
      set({ ladder: { ...get().ladder, samples: [...samples] } });
    };

    try {
      for (let i = 0; i < levels.length; i += 1) {
        if (controller.signal.aborted) break;
        const stage = i + 1;
        const concurrency = levels[i];
        set({ ladder: { ...get().ladder, stage, concurrency } });
        const stageEnd = Date.now() + LADDER_STAGE_MS;
        const inflight = new Set<Promise<void>>();
        const spawn = (): void => {
          const task = runOne(stage, concurrency).finally(() => inflight.delete(task));
          inflight.add(task);
        };
        // 固定时长内一直保持 N 个在飞：完成一个立刻补一个
        while (Date.now() < stageEnd && !controller.signal.aborted) {
          while (inflight.size < concurrency) spawn();
          if (inflight.size === 0) break;
          await Promise.race(inflight);
        }
        // 到点了：这一批还挂着的请求属于本级，等它们收尾再进下一级
        await Promise.all(inflight);
      }

      const finishedAt = Date.now();
      const rows = ladderRowsFromSamples(samples);
      const conclusion = ladderConclusion(rows);
      const run: LadderRun = {
        id: `${finishedAt.toString(36)}-${samples.length}`,
        model,
        slots: slotCount,
        levels,
        rows,
        samples,
        conclusion,
        startedAt,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
      };
      set({
        ladder: {
          ...get().ladder,
          running: false,
          stage: 0,
          concurrency: 0,
          samples,
          history: saveLadderHistory([run, ...get().ladder.history]),
          selectedId: run.id,
        },
      });
    } catch (err) {
      const cancelled = controller.signal.aborted;
      set({
        ladder: {
          ...get().ladder,
          running: false,
          stage: 0,
          concurrency: 0,
          samples,
          // 用户自己点的停止不算错误
          error: cancelled ? null : `并发阶梯失败：${errText(err)}`,
        },
      });
    } finally {
      ladderAbort = null;
    }
  },

  cancelLadder() {
    ladderAbort?.abort();
  },

  clearLadder(id) {
    const state = get().ladder;
    const history =
      id === undefined ? state.history : saveLadderHistory(state.history.filter((r) => r.id !== id));
    set({
      ladder: {
        running: state.running,
        stage: 0,
        concurrency: 0,
        levels: state.levels,
        slots: state.slots,
        completed: 0,
        failed: 0,
        startedAt: null,
        samples: [],
        history,
        selectedId: null,
        error: null,
      },
    });
  },

  selectLadder(id) {
    set({ ladder: { ...get().ladder, selectedId: id } });
  },

  async sendChat() {
    const state = get().chat;
    // 生成中又点发送（用户 m00232 的 A2）：等待 = 忽略；排队 = 挂到 pending，这一轮收尾后自动发；
    // 打断 = 先停掉当前这轮，收尾后把新问题发出去（上游 `s-busy` 三态，Wait / Send after / Interrupt）
    if (state.streaming) {
      const queued = state.draft.trim();
      if (!queued && state.attachments.length === 0) return;
      if (state.options.busyMode === "queue" || state.options.busyMode === "interrupt") {
        set({
          chat: {
            ...state,
            pending: { text: state.draft, attachments: [...state.attachments] },
            draft: "",
            attachments: [],
          },
        });
        if (state.options.busyMode === "interrupt") chatAbort?.abort();
      }
      return;
    }
    const draft = state.draft.trim();
    if (!draft && state.attachments.length === 0) return;

    // 模型（用户 m00082 第 2、3 点 + m00370 第 3 点 + m00437）：下拉里可以选**任何**模型，不只是
    // 已加载的。记住的选择只要还在列表里就用它（未加载的会在下面自动拉起）；否则退回「已加载里按 id
    // 排序的第一个」；一个都没加载时退回「上次聊天的模型」（最近一份会话绑定的模型）；再没有才报
    // 「请选择模型」——不能悄悄拿列表第一个未加载的模型顶上。
    // 判据要与输入框的显示（ChatPanel 的 activeModel）完全一致（用户 m01516）。
    const snapshot = get();
    const merged = mergeModels(
      snapshot.scanned,
      snapshot.routerModels,
      snapshot.settings?.favourites ?? [],
      new Set(snapshot.configs.map((c) => c.name)),
      snapshot.settings?.aliases ?? {},
      snapshot.strataEntries,
    );
    const remembered = state.options.model.trim();
    /** 上次聊天的模型（用户 m00437）：最近一份会话绑定的模型，仍在列表里就可用 */
    const lastChat = [...state.conversations]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => merged.find((m) => m.section === c.model || m.id === c.model))
      .find(Boolean);
    const target =
      merged.find((m) => m.section === remembered || m.id === remembered) ??
      merged
        .filter((m) => m.status === "loaded")
        .sort((a, b) => a.id.localeCompare(b.id))[0] ??
      lastChat;
    /** 请求体里的 `model` 用段名（config 的 `name`），前门按它路由 */
    const model = target?.section ?? "";

    if (!model) {
      set({ chat: { ...state, error: "请先在下面的模型下拉里选一个模型" } });
      return;
    }

    // 会话：没有就新建一份，标题取首句前 42 字
    const now = Date.now();
    const existing = state.conversations.find((c) => c.id === state.activeId);
    const conversationId = existing?.id ?? newId();
    const user: ChatTurn = {
      id: newId(),
      role: "user",
      content: draft,
      attachments: state.attachments.length ? [...state.attachments] : undefined,
      createdAt: now,
    };
    const assistant: ChatTurn = {
      id: newId(),
      role: "assistant",
      content: "",
      createdAt: now,
      execution: newChatExecution(newId()),
    };
    const previous = existing?.messages ?? [];

    const base: Conversation = existing ?? {
      id: conversationId,
      model,
      title: conversationTitle(draft, state.attachments[0]?.name),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    const withTurn: Conversation = {
      ...base,
      model,
      messages: [...previous, user, assistant],
      updatedAt: now,
    };
    set({
      chat: {
        ...state,
        conversations: saveConversations([
          withTurn,
          ...state.conversations.filter((c) => c.id !== conversationId),
        ]),
        activeId: conversationId,
        draft: "",
        attachments: [],
        streaming: true,
        options: { ...state.options, model },
        error: null,
      },
    });

    const controller = new AbortController();
    chatAbort = controller;
    const started = performance.now();
    let firstTokenMs: number | undefined;
    let reasoningStartedAt: number | undefined;
    let reasoningMs: number | undefined;


    /** 只改这一条助手消息（其余会话原样） */
    const patchAssistant = (patch: (message: ChatTurn) => ChatTurn) => {
      const current = get().chat;
      const list = current.conversations.map((item) =>
        item.id === conversationId
          ? {
              ...item,
              updatedAt: Date.now(),
              messages: item.messages.map((m) => (m.id === assistant.id ? patch(m) : m)),
            }
          : item,
      );
      set({ chat: { ...current, conversations: list } });
    };

    /** 跑一次工具调用，把结果整理成喂回模型的文本 */
    const runTool = async (
      call: ToolCall,
    ): Promise<{ text: string; ok: boolean; note?: string }> => {
      const args = parseToolArguments(call.arguments);
      if (call.name === "web_search") {
        // 参数形态照 DSH 核心（dsh-tool-web）：queries 1–4 条，去重、并发、合并
        const queries = searchQueriesFromArgs(args);
        if (queries.length === 0) return { text: "搜索词是空的", ok: false };
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        try {
          // 每条查询并发打后端（`search_query` 是异步命令，后端互不排队），
          // 任一查询失败整批中止 —— 与 DSH web_search 的融合信号语义一致
          // （Promise.all 的第一个 reject 就是我们要回传的失败）。
          // 走后端的多引擎搜索（`src-tauri/src/search.rs`）：拿回来的是已经包好
          // 「不可信网页内容」边界的整段文本
          const results = await Promise.all(queries.map((query) => ipc.searchQuery(query, limit)));
          // 卡片上写清实际用的引擎、以及哪些引擎被跳过（失败原因），
          // 否则用户只看到「用了 Tavily」，没法知道排前面的 AnySearch 为什么没上
          const note =
            results
              .map((result) => {
                const skipped = result.attempts
                  .filter((item) => item.engine !== result.engine)
                  .map((item) => `${item.engine}（${item.error ?? "跳过"}）`)
                  .join("、");
                return skipped
                  ? `${result.engine} · 跳过 ${skipped}`
                  : `${result.engine}${result.cached ? " · 缓存" : ""}`;
              })
              .join("；");
          const usable = results.filter((result) => result.hits.length > 0);
          if (usable.length === 0) return { text: "没有搜到结果", ok: false, note };
          const text =
            queries.length === 1
              ? usable[0].block
              : results
                  .map((result, index) => `### ${queries[index]}\n${result.hits.length > 0 ? result.block : "没有搜到结果"}`)
                  .join("\n\n");
          return { text, ok: true, note };
        } catch (error) {
          return { text: errText(error), ok: false };
        }
      }
      if (call.name === "web_fetch") {
        const url = typeof args.url === "string" ? args.url.trim() : "";
        if (!url) return { text: "url 是空的", ok: false };
        const maxChars = typeof args.maxChars === "number" ? args.maxChars : undefined;
        try {
          // 后端用系统 curl 抓回来、抽成正文并包好「不可信网页内容」边界
          const page = await ipc.webFetch(url, maxChars);
          const host = page.finalUrl.replace(/^https?:\/\//, "").split("/")[0];
          const tail = page.truncated ? " · 已截断" : "";
          const note = `${host} · ${page.chars} 字符${tail}${page.note ? ` · ${page.note}` : ""}`;
          return { text: page.block, ok: true, note };
        } catch (error) {
          return { text: errText(error), ok: false };
        }
      }
      if (isMcpTool(call.name)) {
        // 工具名只能反查回「哪台服务器的哪个工具」—— 服务器列表改过之后旧名字就失效了
        const target = get().mcpTools.find((item) => item.key === call.name);
        if (!target) {
          return { text: `找不到工具 ${call.name}，MCP 服务器可能改过了，请在聊天设置里重新检测`, ok: false };
        }
        try {
          const text = await ipc.mcpCallTool(target.server, target.name, args);
          return { text, ok: true, note: `${target.server} · ${target.name}` };
        } catch (error) {
          return { text: errText(error), ok: false, note: `${target.server} · ${target.name}` };
        }
      }
      return { text: `未知工具：${call.name}`, ok: false };
    };

    try {
      // 选中的模型没加载就先拉起（用户 m00082 第 3 点）：Strata 走引擎接口，
      // llama.cpp 通道走前门 `/models/load`（前门会等子实例 `/health` 就绪才返回，实测几十秒）。
      // 状态条这段时间显示「正在加载模型 xxx…」，否则用户只看到「等待响应」，
      // 几十秒没动静像是卡住了（文案由 ChatMessageView 的状态条读 `hint`，用户 m00220）。
      if (target && target.status !== "loaded") {
        if (target.channel === "strata" && !target.strataFile) {
          patchAssistant((message) => ({
            ...message,
            error: `找不到 Strata 模型 ${target.name} 的配置文件（刷新一次模型列表再试）`,
          }));
          return;
        }
        patchAssistant((message) => ({
          ...message,
          execution: {
            ...(message.execution ?? assistant.execution!),
            hint: `正在加载模型 ${target.name}…`,
          },
        }));
        if (target.channel === "strata" && target.strataFile) {
          const ok = await get().startStrataModel(target.strataFile);
          if (!ok) {
            patchAssistant((message) => ({
              ...message,
              error: get().error ?? `Strata 模型 ${target.name} 启动失败`,
            }));
            return;
          }
        } else {
          const ok = await get().startModel(model);
          if (!ok) {
            patchAssistant((message) => ({
              ...message,
              error: get().error ?? `模型 ${target.name} 启动失败`,
            }));
            return;
          }
        }
      }
      // MCP 工具要现拉：首次打开开关、或刚保存过服务器配置时，store 里还是空的
      let mcpTools = get().mcpTools;
      if (state.options.mcpTools && mcpTools.length === 0) {
        const view = await get().refreshMcpTools();
        mcpTools = view?.tools ?? [];
      }
      const tools = buildToolSpecs(state.options.webSearch, mcpTools);
      // 模型可以连续要工具：每要一次就执行、回填，再要一次，最多 5 轮（防死循环）
      let history = [...previous.filter((m) => !m.error), user];
      let calls: ToolCall[] = [];
      /** 本轮回答的正文（含工具轮之间的过渡文字），用来判断要不要收尾 */
      let answer = "";
      /** 本次发送里已经搜过的关键词，用来挡掉重复搜索 */
      const searched = new Set<string>();
      /** 本次发送里已经读过的网页，用来挡掉重复抓取 */
      const fetched = new Set<string>();
      const onDelta = (delta: ChatDelta) => {
        if (delta.reasoning && reasoningStartedAt === undefined) reasoningStartedAt = performance.now();
        if (delta.content) {
          answer += delta.content;
          if (firstTokenMs === undefined) {
            firstTokenMs = performance.now() - started;
            if (reasoningStartedAt !== undefined) reasoningMs = performance.now() - reasoningStartedAt;
          }
        }
        if (delta.toolCalls) calls = mergeToolCallFragments(calls, delta.toolCalls);
        patchAssistant((message) => {
          const next: ChatTurn = {
            ...message,
            content: message.content + (delta.content ?? ""),
            reasoning: (message.reasoning ?? "") + (delta.reasoning ?? ""),
            execution: advanceChatExecution(message.execution ?? assistant.execution!, delta),
          };
          if (delta.usage) next.usage = { ...message.usage, ...delta.usage };
          if (delta.timings) {
            next.speed = { ...message.speed, ...delta.timings };
            // 底部状态栏的速度/上下文取自最近一次请求（用户 m05241 照搬上游的口径）。
            set({
              lastTurn: {
                at: Date.now(),
                promptTokens: next.usage?.prompt_tokens ?? null,
                outputTokens: next.usage?.completion_tokens ?? null,
                decodeTokS: next.speed?.decodeTokS ?? null,
                prefillTokS: next.speed?.prefillTokS ?? null,
              },
            });

          }
          if (delta.error) next.error = delta.error;
          return next;
        });
      };
      const port = get().strataStatus.proxy_port ?? 9090;
      for (let round = 0; round < 5; round += 1) {
        if (controller.signal.aborted) break;
        calls = [];
        await streamChatTurn(
          port,
          buildChatRequest(history, { ...state.options, model }, false, tools, target.channel === "strata"),
          onDelta,
          controller.signal,
        );
        // 没有工具调用就结束了
        if (calls.length === 0 || controller.signal.aborted) break;

        // 先把「要调用什么」画出来（状态 running），再一个个执行
        for (const call of calls) {
          const args = parseToolArguments(call.arguments);
          patchAssistant((message) => ({
            ...message,
            tools: [
              ...(message.tools ?? []),
              {
                id: call.id,
                name: call.name,
                status: "running",
                arguments: args,
                result: null,
                // 卡片插在这一轮正文之后（`at` 是字符下标，见 ChatMessageView）
                at: message.content.length,
              },
            ],
          }));
        }

        const results: ChatTurn[] = [];
        for (const call of calls) {
          // 按查询去重（照 DSH 的口径：完全相同的查询只执行一次）。
          // 模型换词重搜要放行；已搜过的词只跑新词，全搜过就整张卡跳过
          // （用户 m07347 截图里 5 张卡片同一个 query）
          const callArgs = parseToolArguments(call.arguments);
          const asked = call.name === "web_search" ? searchQueriesFromArgs(callArgs) : [];
          const fresh = asked.filter((item) => !searched.has(item));
          const target = typeof callArgs.url === "string" ? callArgs.url.trim() : "";
          const repeated =
            (call.name === "web_search" && asked.length > 0 && fresh.length === 0) ||
            (call.name === "web_fetch" && target !== "" && fetched.has(target));
          const outcome = repeated
            ? {
                text:
                  call.name === "web_fetch"
                    ? `已经读过 ${target}，正文就在上面的工具结果里。请直接基于已有资料回答，不要再重复抓取。`
                    : `已经搜过「${asked.join("，")}」，结果就在上面的工具结果里。请直接基于已有资料回答，不要再重复搜索。`,
                ok: true,
                note: "重复调用已跳过",
              }
            : await runTool(
                // 部分查询搜过、部分是新的：参数里摘掉旧词，只跑新词
                call.name === "web_search" && fresh.length > 0 && fresh.length < asked.length
                  ? { ...call, arguments: JSON.stringify({ ...callArgs, queries: fresh }) }
                  : call,
              );
          if (call.name === "web_search" && !repeated) {
            for (const item of fresh) searched.add(item);
          }
          if (call.name === "web_fetch" && target !== "" && !repeated) fetched.add(target);
          patchAssistant((message) => ({
            ...message,
            tools: (message.tools ?? []).map((item) =>
              item.id === call.id
                ? {
                    ...item,
                    status: outcome.ok ? "done" : "error",
                    result: outcome.text,
                    ok: outcome.ok,
                    note: outcome.note,
                  }
                : item,
            ),
          }));
          results.push({
            id: newId(),
            role: "tool",
            content: outcome.text,
            createdAt: Date.now(),
            toolCallId: call.id,
          });
        }

        // 模型需要看到自己刚发出的工具调用，才能把结果对上去
        history = [
          ...history,
          { id: newId(), role: "assistant", content: "", createdAt: Date.now(), toolCalls: calls },
          ...results,
        ];
      }

      // 轮次用尽还在要工具时，正文是空的 —— 再发一次「不许再调工具」的收尾请求，
      // 否则界面上只有一串工具卡片、没有答案（用户 m07347「没有回答」）
      if (!controller.signal.aborted && answer.trim() === "") {
        calls = [];
        await streamChatTurn(
          port,
          buildChatRequest(
            [
              ...history,
              {
                id: newId(),
                role: "user",
                content: "工具调用次数已经用完了。请直接根据上面拿到的资料回答问题，不要再调用任何工具。",
                createdAt: Date.now(),
              },
            ],
            { ...state.options, model },
            false,
            [],
            target.channel === "strata",
          ),
          onDelta,
          controller.signal,
        );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        // 开了联网搜索 / MCP 工具却报 tools 相关错误，多半是模型的 chat template 不认工具调用
        const hint =
          state.options.webSearch || state.options.mcpTools
            ? "\n（提示：如果上面说 tools 不受支持，是这个模型的 chat template 不支持工具调用 —— 关掉「联网搜索」和「MCP 工具」，或在模型参数里加 --jinja）"
            : "";
        patchAssistant((message) => ({ ...message, error: errText(error) + hint }));
      }
    } finally {
      patchAssistant((message) => ({
        ...message,
        execution: finishChatExecution(
          message.execution ?? assistant.execution!,
          controller.signal.aborted,
          Boolean(message.error),
        ),
        elapsedMs: performance.now() - started,
        firstTokenMs,
        reasoningMs: reasoningMs ?? (reasoningStartedAt === undefined ? undefined : performance.now() - reasoningStartedAt),
        stopped: controller.signal.aborted,
      }));
      // 只清自己持有的那个：排队/快速重发时新一轮可能已经接管 chatAbort，
      // 这里无条件置空会让新轮的「停止」按钮失效（审查发现）
      if (chatAbort === controller) chatAbort = null;
      const after = get().chat;
      // 追加一行「最近请求」（监控页 req-card）。失败也记 —— 上游那列有「失败」状态。
      const elapsedMs = performance.now() - started;
      // 数据从这条助手消息本身读（闭包里攒的变量在收尾处会被 TS 收窄成 null）。
      const finished = after.conversations
        .find((item) => item.id === conversationId)
        ?.messages.at(-1);
      const failed = Boolean(finished?.error);
      const row: RecentTurn = {
        id: newId(),
        model,
        at: Date.now(),
        promptTokens: finished?.usage?.prompt_tokens ?? null,
        outputTokens: finished?.usage?.completion_tokens ?? null,
        decodeTokS: finished?.speed?.decodeTokS ?? null,
        prefillTokS: finished?.speed?.prefillTokS ?? null,
        cacheTokens: finished?.speed?.cacheTokens ?? null,
        elapsedMs: controller.signal.aborted ? null : elapsedMs,
        ok: !failed,
        error: failed ? finished?.error ?? "请求失败" : null,
      };
      set({
        chat: {
          ...after,
          streaming: false,
          conversations: saveConversations(after.conversations),
        },
        recentTurns: [row, ...get().recentTurns].slice(0, RECENT_TURN_LIMIT),
      });

      // 排队的那一问：这一轮收尾后接着发（上游「Send after」）。失败 / 被打断也照发，
      // 用户点的是「之后发送」，不是「成功才发送」。
      const queued = get().chat.pending;
      if (queued) {
        set({
          chat: { ...get().chat, pending: null, draft: queued.text, attachments: queued.attachments },
        });
        void get().sendChat();
      }
    }
  },

  stopChat() {
    chatAbort?.abort();
  },

  newConversation() {
    const state = get().chat;
    set({ chat: { ...state, activeId: null, draft: "", attachments: [], error: null } });
  },

  selectConversation(id) {
    const state = get().chat;
    set({ chat: { ...state, activeId: id, draft: "", attachments: [], error: null } });
  },

  renameConversation(id, title) {
    const state = get().chat;
    const clean = title.trim();
    if (!clean) return;
    set({
      chat: {
        ...state,
        conversations: saveConversations(
          state.conversations.map((item) =>
            item.id === id ? { ...item, title: clean, updatedAt: Date.now() } : item,
          ),
        ),
      },
    });
  },

  deleteConversation(id) {
    const state = get().chat;
    set({
      chat: {
        ...state,
        conversations: saveConversations(state.conversations.filter((item) => item.id !== id)),
        activeId: state.activeId === id ? null : state.activeId,
      },
    });
  },

  setChatDraft(value) {
    set({ chat: { ...get().chat, draft: value } });
  },

  async addChatAttachments(files) {
    const added: ChatAttachment[] = [];
    const problems: string[] = [];
    for (const file of files) {
      if (file.size > 20e6) {
        problems.push(`${file.name}: 单个附件不能超过 20 MB`);
        continue;
      }
      if (/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) {
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error(`${file.name} 读取失败`));
          reader.readAsDataURL(file);
        });
        added.push({ id: newId(), name: file.name, type: "image", mimeType: file.type, content });
      } else if (
        file.type.startsWith("text/") ||
        /\.(txt|md|json|csv|tsv|xml|yaml|yml|py|js|ts|tsx|jsx|html|css|log|sql|sh|ps1|c|cpp|h|rs)$/i.test(file.name)
      ) {
        if (file.size > 512 * 1024) {
          problems.push(`${file.name}: 文本附件不能超过 512 KB`);
          continue;
        }
        added.push({
          id: newId(),
          name: file.name,
          type: "text",
          mimeType: file.type || "text/plain",
          content: await file.text(),
        });
      } else {
        problems.push(`${file.name}: 只支持文本文件和 png/jpeg/webp/gif 图片`);
      }
    }
    const state = get().chat;
    set({
      chat: {
        ...state,
        attachments: [...state.attachments, ...added],
        // 这次全加成功了就把红字清掉：留着上一次的「附件失败」会让用户以为刚加的还是坏的（审查发现）
        error: problems.length ? problems.join("；") : null,
      },
    });
  },

  removeChatAttachment(id) {
    const state = get().chat;
    set({ chat: { ...state, attachments: state.attachments.filter((file) => file.id !== id) } });
  },

  setChatOptions(patch) {
    const state = get().chat;
    const options = normalizeChatOptions({ ...state.options, ...patch });
    saveChatOptions(options);
    set({ chat: { ...state, options } });
  },

  dismissChatError() {
    set({ chat: { ...get().chat, error: null } });
  },

  /**
   * 重新生成（用户 m00232 的 A1，照上游 `regenerate`）：从 index 往前找到那条用户消息，
   * 把它的正文与附件回填输入框、消息列表退回到它之前，然后按正常发送流程重跑一轮。
   * 原来的消息整份塞进撤销条，点「撤销」就放回去。
   */
  regenerateReply(index) {
    const state = get().chat;
    if (state.streaming) return;
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    if (!conversation) return;
    const plan = regeneratePlan(conversation.messages, index);
    if (!plan) return;
    const user = plan.keep.at(-1);
    if (!user || user.role !== "user") return;
    // 历史会话的附件只留了名字（落盘时清空 content）——重新发会丢掉图片/文本，直接拦下来
    const draft = draftOfTurn(user);
    if (draft.lost > 0) {
      set({
        chat: {
          ...state,
          error: `这条消息还有 ${draft.lost} 个附件只保留了文件名（历史会话不保存附件内容）。请新建会话重新添加附件后再试。`,
        },
      });
      return;
    }
    if (!draft.text && draft.attachments.length === 0) return;
    // 模型沿用这份会话绑定的那个（不用当前下拉里的，否则会把旧会话接到别的模型上）
    const trimmed: Conversation = {
      ...conversation,
      messages: plan.keep.slice(0, -1),
      updatedAt: Date.now(),
    };
    set({
      chat: {
        ...state,
        conversations: saveConversations([
          trimmed,
          ...state.conversations.filter((item) => item.id !== trimmed.id),
        ]),
        options: { ...state.options, model: conversation.model },
        draft: draft.text,
        attachments: draft.attachments,
        undo: { messages: conversation.messages, text: "已重新生成本轮回答" },
        error: null,
      },
    });
    void get().sendChat();
  },

  /** 改写回答（照上游 `editAnswer`）：只替换正文并打「已编辑」，思考/工具/用量丢弃，后面消息隐藏 */
  editAnswerText(index, text) {
    const state = get().chat;
    if (state.streaming) return;
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    if (!conversation) return;
    const clean = text.trim();
    if (!clean) {
      set({ chat: { ...state, error: "回答内容不能为空" } });
      return;
    }
    const plan = editAnswerPlan(conversation.messages, index, clean);
    if (!plan) return;
    const changed: Conversation = { ...conversation, messages: plan.keep, updatedAt: Date.now() };
    set({
      chat: {
        ...state,
        conversations: saveConversations([
          changed,
          ...state.conversations.filter((item) => item.id !== changed.id),
        ]),
        undo: {
          messages: conversation.messages,
          text: plan.hidden > 0 ? `已改写这条回答，后面 ${plan.hidden} 条消息已隐藏` : "已改写这条回答",
        },
        error: null,
      },
    });
  },

  /**
   * 回到某条消息（照上游 `rewind`）：用户消息 → 回填输入框并从列表里拿掉；助手消息 → 保留，后面的拿掉。
   * `branch` = 从这里开分支：新会话带一份副本，原会话原样不动。
   */
  rewindChat(index, branch) {
    const state = get().chat;
    if (state.streaming) return;
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    if (!conversation) return;
    const plan = rewindPlan(conversation.messages, index);
    if (!plan) return;
    const lost = plan.draft && plan.draft.lost > 0
      ? `（有 ${plan.draft.lost} 个附件只保留了文件名，回填时已略过，需要重新添加）`
      : "";
    if (branch) {
      const next = branchConversation(conversation, plan.keep, conversationTitle(`${conversation.title}（分支）`));
      set({
        chat: {
          ...state,
          conversations: saveConversations([
            next,
            ...state.conversations.filter((item) => item.id !== next.id),
          ]),
          activeId: next.id,
          draft: plan.draft?.text ?? "",
          attachments: plan.draft?.attachments ?? [],
          undo: null,
          error: lost || null,
        },
      });
      return;
    }
    const changed: Conversation = { ...conversation, messages: plan.keep, updatedAt: Date.now() };
    const keepComposer = plan.draft === null;
    set({
      chat: {
        ...state,
        conversations: saveConversations([
          changed,
          ...state.conversations.filter((item) => item.id !== changed.id),
        ]),
        draft: keepComposer ? state.draft : plan.draft!.text,
        attachments: keepComposer ? state.attachments : plan.draft!.attachments,
        undo: {
          messages: conversation.messages,
          text: plan.hidden > 0 ? `已回到这条消息，后面 ${plan.hidden} 条消息已隐藏` : "已回到这条消息",
          ...(keepComposer
            ? {}
            : {
                inserted: plan.draft!.text,
                draftBefore: { text: state.draft, attachments: state.attachments },
              }),
        },
        error: lost || null,
      },
    });
  },

  /** 撤销条上的按钮：把动作之前的整份消息列表放回去，并还原被动作换掉的草稿 */
  undoChatHistory() {
    const state = get().chat;
    const undo = state.undo;
    if (!undo || state.streaming) return;
    const conversation = state.conversations.find((item) => item.id === state.activeId);
    if (!conversation) return;
    const restored: Conversation = { ...conversation, messages: undo.messages, updatedAt: Date.now() };
    let draft = state.draft;
    let attachments = state.attachments;
    // 只在草稿仍是动作放进去的那段、且没动过时才还原（用户改过就别覆盖他的输入）
    if (undo.draftBefore && undo.inserted !== undefined && draft.trim() === undo.inserted.trim()) {
      draft = undo.draftBefore.text;
      attachments = undo.draftBefore.attachments;
    }
    set({
      chat: {
        ...state,
        conversations: saveConversations([
          restored,
          ...state.conversations.filter((item) => item.id !== restored.id),
        ]),
        draft,
        attachments,
        undo: null,
        error: null,
      },
    });
  },

  clearPendingChat() {
    const state = get().chat;
    if (!state.pending) return;
    set({ chat: { ...state, pending: null } });
  },

  dismissChatUndo() {
    set({ chat: { ...get().chat, undo: null } });
  },

  /** 抓一次采集快照；状态栏 1 秒调一次，失败就把 metric 置空（界面显示「监控不可用」）。 */
  async refreshMonitor() {
    try {
      const snapshot = await monitorSample();
      // 每秒推一个速度点，给监控页的速度折线兜底（只在生成时有值，与上游 history.tok_s 语义一致）。
      // 压测（上下文 / 场景）同样会往 lastTurn 写速度，运行期间折线不能断（用户 m00279）；
      // decode 与 prefill 两条线用同一个门控 —— 原先 prefill 无门控，空闲期每秒重复推最近值，
      // 折线走成一条假水平线。
      const turn = get().lastTurn;
      const running =
        get().chat.streaming || get().contextBench.running || get().scenarioBench.running;
      const prev = get().speedSeries;
      const push = (list: (number | null)[], value: number | null) => [...list, value].slice(-60);
      set({
        monitor: snapshot,
        monitorAt: snapshot.now.at,
        speedSeries: {
          tokS: push(prev.tokS, running ? (turn?.decodeTokS ?? null) : null),
          prefillTokS: push(prev.prefillTokS, running ? (turn?.prefillTokS ?? null) : null),
        },
      });
      monitorWarned = "";
    } catch (error) {
      const text = errText(error);
      if (text !== monitorWarned) {
        monitorWarned = text;
        reportFrontendError("warn", `刷新监控失败：${text}`);
      }
      set({ monitor: null, monitorAt: 0 });
    }
  },

  async refreshMcpServers() {
    try {
      const servers = await ipc.mcpServers();
      set({ mcpServers: servers });
      return servers;
    } catch (error) {
      reportFrontendError("warn", `读取 MCP 配置失败：${errText(error)}`);
      throw error;
    }
  },

  async saveMcpServers(next) {
    // 后端会停掉所有已启动的进程（命令改了必须重连才生效），所以这里顺手把工具清空，
    // 免得聊天页还拿着一批已经走不通的工具名
    const servers = await ipc.mcpSaveServers(next);
    set({ mcpServers: servers, mcpTools: [], mcpError: null });
  },

  async refreshMcpTools() {
    try {
      const view = await ipc.mcpTools();
      // 失败的服务器单独拼成一句：面板上要能看到「哪台起不来、为什么」
      const failed = view.servers.filter((item) => !item.ok);
      set({
        mcpTools: view.tools,
        mcpError: failed.length
          ? failed.map((item) => `${item.name}：${item.error ?? "未知原因"}`).join("；")
          : null,
      });
      return view;
    } catch (error) {
      reportFrontendError("warn", `拉取 MCP 工具失败：${errText(error)}`);
      set({ mcpTools: [], mcpError: errText(error) });
      return null;
    }
  },
}));

/** 聊天页的取消句柄 */
let chatAbort: AbortController | null = null;

/** 压测的取消句柄：点「停止」时中断当前请求 */
let benchAbort: AbortController | null = null;

/** 场景测试的取消句柄 */
let scenarioAbort: AbortController | null = null;

/** 并发阶梯的取消句柄 */
let ladderAbort: AbortController | null = null;

/** 模型端口（卡片显示用）。前门合成的列表直接带 `port`，不再从 `status.args` 里解析。 */
export function modelPort(model: RouterModel): number | null {
  return model.port ?? null;
}

/** 单行摘要：用于列表页标题栏 */
export function summarize(scanned: ScannedModel[], routerModels: RouterModel[]): string {
  const loaded = routerModels.filter((m) => m.status.value === "loaded").length;
  return `${scanned.length} 个模型 · ${loaded} 个已加载`;
}

/**
 * 设置一变就把 API key 同步给 router 客户端。
 *
 * router 带 `--api-key` 启动后，**除 `/health` 外所有端点都要鉴权**，漏掉任何一条请求路径
 * 都会表现成 401（"Invalid API Key"，界面上的现象就是模型列表读不出来、模型也加载不了）。
 * 放在这里统一同步，比在每个调用点手动传 key 更不容易漏。
 */
let syncedApiKey: string | null = null;
useApp.subscribe((state) => {
  const key = state.settings?.api_key?.trim() || null;
  if (key === syncedApiKey) return;
  syncedApiKey = key;
  setRouterApiKey(key);
});
