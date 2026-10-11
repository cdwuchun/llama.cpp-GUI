/** 全局状态（Zustand）：设置、版本、设备、router 状态、模型列表与日志。 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";

import {
  fetchModels,
  fetchProps,
  loadModel as apiLoadModel,
  portFromArgs,
  setRouterApiKey,
  subscribeModelEvents,
  unloadModel as apiUnloadModel,
} from "./api/router";
import { errText, ipc, onLogLines, onModelsScanned, onRouterStatus, onStrataStatus } from "./ipc";
import { presetSections } from "./utils/models";
import { chatTargets } from "./api/router";
import type {
  AppPaths,
  AuxFile,
  DeviceInfo,
  LlamaCppVersion,
  LogLine,
  ModelProps,
  RouterModel,
  RouterStatus,
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
  status: RouterStatus;
  logs: LogLine[];
  logFilter: string;

  /** 递归扫描到的模型（来自 Tauri） */
  scanned: ScannedModel[];
  /** 扫描到的辅助文件：多模态投影（mmproj）/ 外挂草稿模型（draft），不列进模型列表 */
  auxFiles: AuxFile[];
  presetText: string;
  presetPath: string;
  orphanSections: string[];
  /** router 返回的模型状态 */
  routerModels: RouterModel[];
  /** 已拉取过的模型详情缓存 */
  modelProps: Record<string, ModelProps>;
  sseClose: (() => void) | null;

  /** Strata 运行状态（第二运行时通道） */
  strataStatus: StrataStatus;
  /** 扫描到的 Strata config（= 可选模型） */
  strataEntries: StrataModelEntry[];
  /** 正在启动中的 config 文件名（卡片显示「加载中」用；启动结束即清空） */
  strataStarting: string | null;

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
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;
  startRouter: () => Promise<void>;
  stopRouter: () => Promise<void>;
  restartRouter: () => Promise<void>;
  clearLogs: () => Promise<void>;
  fixAscii: (path: string) => Promise<string | null>;

  refreshModels: (force?: boolean, silent?: boolean) => Promise<void>;
  syncPreset: () => Promise<void>;
  importHubPresets: () => Promise<void>;
  /** 打开某个模型的 llama.cpp 自带聊天界面；多个在跑时不传 id 会返回 false 让界面去问用户 */
  openModelChat: (id?: string) => Promise<boolean>;
  refreshRouterModels: (reload?: boolean) => Promise<void>;
  startRouterWatch: (port: number) => void;
  stopRouterWatch: () => void;

  /** 重扫 Strata 根目录下的 config 列表 */
  refreshStrata: () => Promise<void>;
  startStrata: (configFile?: string | null) => Promise<void>;
  /** 启动前门代理：DSH 等客户端连的端口，按请求里的 model 自动切换引擎（用户 m00798） */
  startStrataProxy: () => Promise<void>;
  /** 停止前门代理（引擎进程不动） */
  stopStrataProxy: () => Promise<void>;
  /** 卡片「启动模型」：确保引擎在跑且跑的是这个 config，然后 POST /load */
  startStrataModel: (configFile?: string | null) => Promise<void>;
  /** 卡片「停止模型」：POST /unload 卸模型，引擎进程留着 */
  stopStrataModel: (configFile: string) => Promise<void>;
  /** 确保 config 顶层 lazy_load=true（胶囊只启引擎时用） */
  ensureStrataLazy: (configFile: string) => Promise<boolean>;
  stopStrata: () => Promise<void>;
  /** 显存互斥：卸掉 router 里占显存的模型，返回被卸的模型名（启动 Strata 前调用） */
  unloadRouterLoaded: () => Promise<string[]>;
  /** 拉一次运行时状态（生效上下文 / 加载状态 / token 占用） */
  probeStrata: () => Promise<void>;
  pickStrata: (configFile: string) => Promise<void>;
  setStrataRoot: (path: string) => Promise<boolean>;
  /** 参数编辑 L2：写 config 原文，成功后刷新该条目（用于"需重启生效"比对） */
  writeStrataConfig: (configFile: string, text: string) => Promise<boolean>;
  startStrataPolling: () => void;
  stopStrataPolling: () => void;

  startModel: (id: string) => Promise<void>;
  stopModel: (id: string) => Promise<void>;
  toggleFavourite: (id: string) => Promise<void>;
  // 返回值 = 是否真的写盘成功。调用方要靠它决定"要不要接着做下一步"
  // （保存失败还接着删旧段/启动模型，就会把用户原来的配置也弄丢）
  saveModelSection: (section: string, entries: [string, string][]) => Promise<boolean>;
  removeModelSection: (section: string) => Promise<void>;
  writePreset: (content: string) => Promise<void>;
  loadModelProps: (id: string) => Promise<ModelProps | null>;
}

const emptyStatus: RouterStatus = {
  running: false,
  port: 8080,
  pid: null,
  version: null,
  version_dir: null,
  started_at_ms: null,
  last_error: null,
  ascii_fixed_from: null,
};

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
  status: RouterStatus;
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
      const [settings, paths, status] = await Promise.all([
        ipc.settingsGet(),
        ipc.appPaths(),
        ipc.routerStatus(),
      ]);
      return { settings, paths, status };
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
  status: emptyStatus,
  logs: [],
  logFilter: "all",

  scanned: [],
  auxFiles: [],
  presetText: "",
  presetPath: "",
  orphanSections: [],
  routerModels: [],
  modelProps: {},
  sseClose: null,
  strataStatus: emptyStrataStatus,
  strataEntries: [],
  strataStarting: null,

  async init() {
    // 幂等：成功过就直接返回；正在初始化时复用同一次调用
    // （React 严格模式下 effect 会跑两遍，否则快照会被拉两遍、订阅也会注册两遍）。
    if (get().initialized) return;
    if (initInFlight) return initInFlight;
    const task = (async () => {
      // 本次初始化里「界面能用、但用户该知道」的问题，最后一次性报出来
      const problems: string[] = [];

      // 1) 订阅先注册、且只注册一次（见 ensureListener / registerListeners）。
      //    它和下面的快照是两件事：快照失败时订阅也该在跑 —— 后端一恢复，
      //    实时状态 / 日志 / 扫描结果就自己回来，不必重启应用。
      const subs: { name: string; start: () => Promise<UnlistenFn> }[] = [
        {
          name: "router 状态",
          start: () =>
            onRouterStatus((s) => {
              const prev = get().status;
              set({ status: s });
              if (s.running) {
                if (!prev.running || prev.port !== s.port) {
                  get().startRouterWatch(s.port);
                  void get().refreshRouterModels(false);
                }
              } else if (prev.running) {
                get().stopRouterWatch();
                set({ routerModels: [], modelProps: {} });
              }
            }),
        },
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
              if (get().status.running) void get().refreshRouterModels(true);
            }),
        },
      ];
      problems.push(...(await registerListeners(subs)));

      try {
        // 2) 关键快照：设置 / 路径 / router 状态缺了界面基本没法用，所以失败 = 这次 init 失败
        //    （内部已重试；仍失败时 initialized 保持 false，下次调用 init() 还能重来）。
        const { settings, paths, status } = await loadEssentialSnapshot();
        set({ settings, paths, status, presetPath: paths.preset_path });

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

        // 4) 快照到位之后的动作
        if (status.running) {
          get().startRouterWatch(status.port);
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

        // 打开程序就把服务拉起来（可在「设置 → 启动与托盘」关掉）。
        // 放在最后：启动 router 要读 preset，得等设置与模型列表先就位。
        if (settings.auto_start_router && !status.running && settings.llama_cpp_dir) {
          void get().startRouter();
        }

        // Strata：扫一次 config 列表（根目录没设置时后端直接返回空，不报错）。
        // 探测定时器**常驻**：Strata 可以由用户自己跑 run-<model>.bat 拉起来，
        // 那种实例不在 GUI 的进程槽里，只有按选中 config 的端口探测才能发现它；
        // 若只在 running=true 时才轮询，快照永远是未运行，就永远轮询不起来。
        if (settings.strata_root) {
          void get().refreshStrata();
          get().startStrataPolling();
        }
        // Strata 状态这次没读到就别做这个判断：那样会把「其实在运行」当成未运行，
        // 白白再启一次（探测轮询随后会把真实状态补上）。
        if (
          strataResult.status === "fulfilled" &&
          !strataStatus.proxy &&
          settings.auto_start_strata &&
          settings.strata_root
        ) {
          // 「打开程序就自动启动 strata」现在拉起的是**前门**（用户 m00798）：一个端口挂全部
          // config，DSH 里选中哪个模型都能直接用；引擎由前门在首次请求时按需起，所以不必
          // 先启引擎、也不用依赖某个选中的 config（也不再有写 config 的副作用）。
          void get().startStrataProxy();
        }

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

  async startRouter() {
    set({ busy: true, error: null, notice: null });
    try {
      // preset 里一个模型段都没有时，router 起来也是空列表（等于没法启动任何模型）。
      // 扫描到了模型就先把它们同步进去，省得用户先手动点一次「同步 preset」。
      const sections = presetSections(get().presetText);
      if (sections.size === 0 && get().scanned.length > 0) {
        const synced = await ipc.presetSync();
        set({
          scanned: synced.models,
          auxFiles: synced.aux_files ?? [],
          presetText: synced.preset_text,
          presetPath: synced.preset_path,
          orphanSections: synced.orphan_sections,
        });
        set({ notice: `presets.ini 原本没有模型，已自动同步 ${synced.models.length} 个模型段` });
      }

      const status = await ipc.routerStart();
      set({ status });
      const settings = await ipc.settingsGet();
      set({ settings });
      get().startRouterWatch(status.port);
      await get().refreshRouterModels(true);
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async stopRouter() {
    set({ busy: true, error: null });
    try {
      const status = await ipc.routerStop();
      get().stopRouterWatch();
      set({ status, routerModels: [], modelProps: {} });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  /**
   * 重启 router。
   *
   * 端口 / 同时加载上限 / API Key 都是 router 的**启动参数**：设置页改完只写盘，
   * 运行中的 router 还在用旧值，而界面已经按新值请求 —— 端口对不上就整个连不上，
   * key 对不上就全是 401。所以设置页会问用户要不要立刻重启。
   *
   * 没在跑的时候直接启动即可（语义上等价，调用方不必区分）。
   */
  async restartRouter() {
    if (!get().status.running) {
      await get().startRouter();
      return;
    }
    set({ notice: "正在重启 router…" });
    await get().stopRouter();
    // 停是强杀，同步返回；但监听套接字要一点时间才真正释放，
    // 立刻 bind 同一个端口偶发失败（那样 router 会顺延到别的端口）。
    await new Promise((resolve) => setTimeout(resolve, 500));
    await get().startRouter();
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
        presetText: result.preset_text,
        presetPath: result.preset_path,
        orphanSections: result.orphan_sections,
      });

      // 扫描时后端会顺手清掉「模型文件已经不在了」的 preset 段，这里如实告诉用户
      const removed = result.removed_sections ?? [];
      const restored = result.restored_sections ?? [];
      if (removed.length > 0) {
        set({
          notice: `已自动清理 ${removed.length} 个失效的 preset 段（模型文件已不存在，配置已存档）：${removed
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
          notice: "preset 里的模型文件全都不存在，可能是模型盘没挂上或目录未就绪，已跳过自动清理",
        });
      }

      if (get().status.running) {
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
      const result = await ipc.presetSync();
      set({
        scanned: result.models,
        auxFiles: result.aux_files ?? [],
        presetText: result.preset_text,
        presetPath: result.preset_path,
        orphanSections: result.orphan_sections,
        notice: `已同步 ${result.models.length} 个模型到 presets.ini`,
      });
      if (get().status.running) {
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
      const report = await ipc.presetImportHub();
      // 参数写进了 presets.ini，重新读一遍让界面拿到最新文本
      const text = await ipc.presetRead();
      set({ presetText: text });
      const missing = report.missing.length ? `，${report.missing.length} 个模型在 hub 里没有配置` : "";
      set({
        notice: `已从 hub 迁移 ${report.matched}/${report.total} 个模型的参数（共 ${report.entries} 项）${missing}`,
      });
      if (get().status.running) {
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
   * 两种入口，语义不同：
   * - **不指定模型**（侧栏「开始聊天」）→ 打开 **router 自己的** WebUI。
   *   llama.cpp 的 WebUI 内置了 router 支持（LIST=`/v1/models`、LOAD=`/models/load`、
   *   SSE=`/models/sse`），所以这一个界面里就能看到全部模型、按需加载并切换着聊。
   * - **指定模型**（模型卡片上的 💬）→ 打开该模型**子实例**的 WebUI，进去就是它，
   *   不用在列表里再选一次（代价是那个界面只服务这一个模型）。
   */
  async openModelChat(id) {
    const { status, routerModels } = get();
    if (!status.running) {
      set({ error: "router 未运行，请先在顶部启动" });
      return false;
    }
    const keyHint = chatKeyHint(get().settings?.api_key);
    if (!id) {
      try {
        await ipc.openLocalUrl(`http://127.0.0.1:${status.port}/`);
        set({ notice: `已在浏览器打开 llama.cpp 的聊天界面（在里面可以切换模型）${keyHint}` });
        return true;
      } catch (err) {
        set({ error: errText(err) });
        return false;
      }
    }

    const target = chatTargets(routerModels).find((t) => t.id === id);
    if (!target) {
      set({ error: `${id} 当前不在运行中，无法打开聊天界面` });
      return false;
    }
    try {
      await ipc.openLocalUrl(`http://127.0.0.1:${target.port}/`);
      set({ notice: `已在浏览器打开 ${id} 的聊天界面（该界面只服务这一个模型）${keyHint}` });
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    }
  },

  async refreshRouterModels(reload = false) {
    const { status, settings } = get();
    // router 带 --api-key 时所有端点都要鉴权，请求前先保证 key 是最新的
    setRouterApiKey(settings?.api_key);
    if (!status.running) {
      set({ routerModels: [] });
      return;
    }
    // 端口就绪后偶发的一次超时/抖动不该直接报错，重试几次再放弃
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const models = await fetchModels(status.port, reload);
        set({ routerModels: models });
        return;
      } catch (err) {
        lastErr = err;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    set({ error: `读取 router 模型列表失败：${errText(lastErr)}` });
  },

  startRouterWatch(port) {
    get().stopRouterWatch();
    const close = subscribeModelEvents(
      port,
      (evt) => {
        const { routerModels } = get();
        if (evt.event === "models_reload") {
          void get().refreshRouterModels(false);
          return;
        }
        if (evt.event === "model_remove") {
          set({ routerModels: routerModels.filter((m) => m.id !== evt.model) });
          return;
        }
        // status_change 携带 progress（stages/current/value），model_status 只有状态。
        // 之前只处理 model_status，界面上就一直是"加载中"没有百分比，看着像卡住。
        if (evt.event !== "model_status" && evt.event !== "status_change") return;

        if (!routerModels.some((m) => m.id === evt.model)) {
          void get().refreshRouterModels(false);
          return;
        }
        // 加载失败要有明确提示，否则界面上只看到"加载中"停住
        if (evt.data?.status === "failed") {
          set({
            error: `${evt.model} 加载失败。子实例的报错见「系统日志」页 →「模型子实例」来源。`,
          });
        }
        const before = routerModels.find((m) => m.id === evt.model)?.status.value;
        const after = evt.data?.status ?? before;
        const next = routerModels.map((m) =>
          m.id === evt.model
            ? {
                ...m,
                status: {
                  ...m.status,
                  value: evt.data?.status ?? m.status.value,
                  progress: evt.data?.progress ?? m.status.progress,
                  failed: evt.data?.status === "failed" ? true : m.status.failed,
                },
              }
            : m,
        );
        set({ routerModels: next });

        // 加载完成给一条提示：加载一个 20GB 的模型要等几十秒，这期间用户往往已经翻到别的页面，
        // 没有反馈就不知道什么时候能开始用。只在"变成 loaded"时提示，重复事件不会刷屏。
        if (after === "loaded" && before !== "loaded") {
          const short = evt.model.split("/").pop() || evt.model;
          set({ notice: `模型加载\n模型 ${short} 加载成功` });
        }
      },
      () => {
        /* 重连由 subscribeModelEvents 负责；真的放弃了才提示，
           否则"界面看着正常、加载进度却永远不动"这种静默失效很难查 */
        set({
          notice:
            "与 router 的状态订阅已断开，模型加载进度可能不再更新；重启 router 或刷新界面可恢复",
        });
      },
    );
    set({ sseClose: close });
  },

  stopRouterWatch() {
    const close = get().sseClose;
    if (close) {
      close();
      set({ sseClose: null });
    }
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
      // 显存互斥（用户 m03342）：前门会按需拉起引擎，先把 router 里占显存的模型卸掉
      let mutexNote = "";
      if (get().settings?.strata_router_mutex) {
        const unloaded = await get().unloadRouterLoaded();
        if (unloaded.length) mutexNote = `\n显存互斥：已卸载 router 的 ${unloaded.join("、")}`;
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
      // 显存互斥（用户 m03342）：先把 router 里占显存的模型卸掉，再启动 Strata。
      let mutexNote = "";
      if (get().settings?.strata_router_mutex) {
        const unloaded = await get().unloadRouterLoaded();
        if (unloaded.length) mutexNote = `\n显存互斥：已卸载 router 的 ${unloaded.join("、")}`;
      }
      // 胶囊只启引擎（用户 m03572）：强制 lazy_load=true，模型交给卡片或首次请求拉起
      if (startingFile) await get().ensureStrataLazy(startingFile);
      const status = await ipc.strataStart(configFile ?? null);
      set({ strataStatus: status });
      get().startStrataPolling();
      // 选中的 config 已落盘，把设置取回来保持一致
      set({ settings: await ipc.settingsGet() });
      const name = status.model_name || status.config_path || "";
      set({ notice: `Strata 引擎已启动\n${name} · :${status.port} · 模型按需加载${mutexNote}` });
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false, strataStarting: null });
    }
  },

  /** 确保 config 顶层有 lazy_load=true（上游 server.py:5403 `lazy = a.lazy or cfg.get("lazy_load") is True`）。
   *  这样「启动 Strata」胶囊只拉起引擎不加载模型，与 router 的「进程在、模型按需加载」一致。 */
  async ensureStrataLazy(configFile) {
    try {
      const cfg = JSON.parse(await ipc.strataConfigRead(configFile));
      if (cfg.lazy_load === true) return true;
      cfg.lazy_load = true;
      await ipc.strataConfigWrite(configFile, JSON.stringify(cfg, null, 1));
      return true;
    } catch (err) {
      set({ error: `设置 lazy_load 失败：${errText(err)}` });
      return false;
    }
  },

  /** 卸载运行中 Strata 的模型（引擎进程留着，显存释放） */
  async stopStrataModel(configFile) {
    const root = get().settings?.strata_root;
    if (!root) {
      set({ error: "请先在「设置」里指定 Strata 安装目录" });
      return;
    }
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
    set({ busy: true, error: null, notice: null });
    try {
      await ipc.strataUnloadModel(root, configFile);
      set({ notice: "已卸载 Strata 模型（引擎仍在运行，显存已释放）" });
      await get().probeStrata();
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  /** 卡片「启动模型」：确保引擎在跑这个 config，然后**真的把模型加载起来**。
   *
   *  Strata 一个引擎只服务一份 config、绑定一个端口（用户 m00001：两个模型都写 9090），
   *  所以模型之间天然互斥 —— 切模型必须先把旧引擎卸干净：先 POST /unload（旧模型优雅
   *  退出、上游顺手保存 learned expert profile、显存立刻释放），再杀进程树，然后起新引擎、
   *  最后 /load。只起引擎不 /load 的话模型停在未加载态，卡片看起来仍然是「已停止」。 */
  async startStrataModel(configFile) {
    const root = get().settings?.strata_root;
    if (!root) {
      set({ error: "请先在「设置」里指定 Strata 安装目录" });
      return;
    }
    const file = configFile ?? get().settings?.strata_selected_config ?? null;
    if (!file) {
      set({ error: "请先选择一个 Strata 模型" });
      return;
    }
    set({ busy: true, error: null, notice: null, strataStarting: file });
    try {
      // 显存互斥（用户 m03342）：先卸 router 里 loaded 的模型，再加载 Strata 模型
      let mutexNote = "";
      if (get().settings?.strata_router_mutex) {
        const unloaded = await get().unloadRouterLoaded();
        if (unloaded.length) mutexNote = `\n显存互斥：已卸载 router 的 ${unloaded.join("、")}`;
      }
      // 强制 lazy_load=true：引擎启动不会顺带把模型吃满显存
      await get().ensureStrataLazy(file);
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
            await ipc.strataUnloadModel(root, runningFile);
          } catch {
            /* 旧引擎忙或者已经退出：照旧走下面的进程树强杀 */
          }
        }
        await ipc.strataStop();
      }
      if (!st.running || runningFile !== file) {
        // 引擎没跑，或跑的是别的模型：重启引擎（一个引擎只服务一份 config）
        const status = await ipc.strataStart(file);
        set({ strataStatus: status });
        get().startStrataPolling();
        set({ settings: await ipc.settingsGet() });
      }
      // 卡片按钮的语义是「启动并加载这个模型」：两条分支都要走到 /load，
      // 否则引擎起来了模型还是没加载，卡片一直显示「已停止」= 看起来启动失败
      await ipc.strataLoadModel(root, file);
      const name = strataBaseName(file);
      set({
        notice: `${switching ? `已停止 ${runningName}（同端口互斥）\n` : ""}已加载 Strata 模型\n${name} · :${get().strataStatus.port}${mutexNote}`,
      });
      await get().probeStrata();
    } catch (err) {
      set({ error: errText(err) });
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
    try {
      set({ strataStatus: await ipc.strataProbe() });
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  async unloadRouterLoaded() {
    const { status, routerModels } = get();
    if (!status.running) return [];
    // 只卸占显存的 loaded：sleeping 的显存已被 router 释放，loading 中的卸不掉。
    const loaded = routerModels.filter((m) => m.status.value === "loaded");
    if (!loaded.length) return [];
    const unloaded: string[] = [];
    for (const m of loaded) {
      try {
        await apiUnloadModel(status.port, m.id);
        unloaded.push(m.id);
      } catch (err) {
        set({ error: `显存互斥：卸载 ${m.id} 失败：${errText(err)}` });
      }
    }
    if (unloaded.length) await get().refreshRouterModels(false);
    return unloaded;
  },

  async pickStrata(configFile) {
    try {
      set({ settings: await ipc.strataPick(configFile) });
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  async setStrataRoot(path) {
    set({ busy: true, error: null });
    try {
      set({ settings: await ipc.strataSetRoot(path) });
      await get().refreshStrata();
      return true;
    } catch (err) {
      set({ error: errText(err) });
      return false;
    } finally {
      set({ busy: false });
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
    const { status } = get();
    if (!status.running) {
      set({ error: "router 未运行，请先在顶部启动" });
      return;
    }
    set({ error: null });
    // 显存互斥（用户 m03342 / m03572）：加载 router 模型前先卸掉 Strata 的模型 ——
    // 只卸模型释放显存，引擎进程与 WebUI 留着（卸的是模型，不是停进程）。
    const st = get().strataStatus;
    const strataRoot = get().settings?.strata_root;
    if (get().settings?.strata_router_mutex && st.running && strataRoot && st.loaded) {
      const strataFile = st.config_path ? strataBaseName(st.config_path) : null;
      if (strataFile) {
        try {
          await ipc.strataUnloadModel(strataRoot, strataFile);
          set({ notice: "显存互斥：已卸载 Strata 的模型（引擎仍在运行，显存已释放）" });
          void get().probeStrata();
        } catch (err) {
          set({ error: `显存互斥未能卸载 Strata 模型：${errText(err)}` });
        }
      }
    }
    try {
      await apiLoadModel(status.port, id);
      await get().refreshRouterModels(false);
    } catch (err) {
      set({ error: errText(err) });
    }
  },

  async stopModel(id) {
    const { status } = get();
    if (!status.running) return;
    set({ error: null });
    try {
      await apiUnloadModel(status.port, id);
      await get().refreshRouterModels(false);
    } catch (err) {
      set({ error: errText(err) });
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
      const presetText = await ipc.presetUpsert(section, entries);
      set({ presetText, notice: `已保存 [${section}]` });
      if (get().status.running) {
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
    set({ busy: true, error: null, notice: null });
    try {
      const presetText = await ipc.presetRemove(section);
      set({ presetText, notice: `已删除 [${section}]` });
      if (get().status.running) {
        await get().refreshRouterModels(true);
      }
      await get().refreshModels();
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async writePreset(content) {
    set({ busy: true, error: null, notice: null });
    try {
      const saved = await ipc.presetWrite(content);
      set({ presetText: saved, notice: "presets.ini 已保存" });
      if (get().status.running) {
        await get().refreshRouterModels(true);
      }
    } catch (err) {
      set({ error: errText(err) });
    } finally {
      set({ busy: false });
    }
  },

  async loadModelProps(id) {
    const { status } = get();
    if (!status.running) return null;
    try {
      const props = await fetchProps(status.port, id);
      set({ modelProps: { ...get().modelProps, [id]: props } });
      return props;
    } catch (err) {
      set({ error: errText(err) });
      return null;
    }
  },
}));

/** router 状态 → 端口（用于卡片显示） */
export function modelPort(model: RouterModel): number | null {
  return portFromArgs(model.status.args);
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
