/** Tauri 命令与事件的薄封装层。 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppPaths,
  AuxFile,
  BenchRecord,
  DeviceResult,
  FetchPage,
  FitRow,
  HubImportReport,
  MonitorEngine,
  MonitorSnapshot,
  Hardware,
  LlamaCppVersion,
  LogFileInfo,
  LogLine,
  McpServerConfig,
  McpToolsView,
  ModelScanResult,
  ScannedModel,
  SearchConfigInput,
  SearchConfigView,
  SearchResponse,
  SearchTestResult,
  Settings,
  SettingsPatch,
  StrataModelEntry,
  StrataStatus,
} from "./types";

export const ipc = {
  ping: () => invoke<string>("ping"),
  appPaths: () => invoke<AppPaths>("app_paths"),

  settingsGet: () => invoke<Settings>("settings_get"),
  settingsSet: (patch: SettingsPatch) => invoke<Settings>("settings_set", { patch }),

  /** 开关开机自启动，返回注册表里的真实状态 */
  autostartSet: (enabled: boolean) => invoke<boolean>("autostart_set", { enabled }),
  autostartGet: () => invoke<boolean>("autostart_get"),

  versionsList: (dir?: string | null, probe = false) =>
    invoke<LlamaCppVersion[]>("versions_list", { dir: dir ?? null, probe }),

  deviceList: () => invoke<DeviceResult>("device_list"),

  // ---- Strata 第二运行时通道 ----
  strataStatus: () => invoke<StrataStatus>("strata_status"),
  /** 扫描 Strata 根目录下的全部 config（照抄上游识别规则） */
  strataScan: () => invoke<StrataModelEntry[]>("strata_scan"),
  /** 探测运行时状态（生效上下文 / 版本 / 加载状态 / token 占用） */
  strataProbe: () => invoke<StrataStatus>("strata_probe"),
  strataStart: (configFile?: string | null) => invoke<StrataStatus>("strata_start", { configFile: configFile ?? null }),
  strataStop: () => invoke<StrataStatus>("strata_stop"),
  /** 启动前门代理（默认 :9090）：一个端口挂全部 config，按请求里的 model 自动切换引擎 */
  strataProxyStart: () => invoke<StrataStatus>("strata_proxy_start"),
  /** 停止前门代理（引擎进程不动） */
  strataProxyStop: () => invoke<StrataStatus>("strata_proxy_stop"),
  strataSetRoot: (path: string) => invoke<Settings>("strata_set_root", { path }),
  strataPick: (configFile: string) => invoke<Settings>("strata_pick", { configFile }),
  /** 参数编辑 L2：读 config 原文 */
  strataConfigRead: (configFile: string) => invoke<string>("strata_config_read", { configFile }),
  /** 参数编辑 L2：写 config（后端负责备份 + 校验 + 原子写），返回刷新后的条目 */
  strataConfigWrite: (configFile: string, text: string) =>
    invoke<StrataModelEntry>("strata_config_write", { configFile, text }),
  /** 卸载运行中 Strata 的模型（POST /unload）：进程留着、显存释放 */
  strataUnloadModel: (root: string, configFile: string) =>
    invoke<string>("strata_unload_model", { root, configFile }),
  /** 加载运行中 Strata 的模型（POST /load）：上游会跑 before_load 并检查显存门槛 */
  strataLoadModel: (root: string, configFile: string) =>
    invoke<string>("strata_load_model", { root, configFile }),

  logsSnapshot: (limit?: number) => invoke<LogLine[]>("logs_snapshot", { limit: limit ?? null }),
  logsClear: () => invoke<void>("logs_clear"),
  /** 这一轮的日志文件落在哪（面板显示路径、按钮打开目录用） */
  logsInfo: () => invoke<LogFileInfo>("logs_info"),
  /** 用系统文件管理器打开日志目录，返回目录路径 */
  logsOpenDir: () => invoke<string>("logs_open_dir"),

  portInUse: (port: number) => invoke<boolean>("port_in_use", { port }),
  fixAsciiPath: (path: string) => invoke<string>("fix_ascii_path", { path }),
  /**
   * 显存预估（llama-fit-params）。
   *
   * params 是当前配置面板里的键值对（preset 语义）：显存占用与上下文长度、KV cache
   * 量化、ubatch、卸载层数这些强相关，后端只透传它认得的键（白名单在 gpu.rs）。
   */
  fitPreview: (modelPath: string, params: [string, string][]) =>
    invoke<FitRow[]>("fit_preview", { modelPath, params }),

  modelsScan: (refresh = false) => invoke<ModelScanResult>("models_scan", { refresh }),
  configSync: () => invoke<ModelScanResult>("config_sync"),
  /** 读一份 config 的原文（JSON）。「模型详情」直接显示它（第三刀） */
  configRead: (section: string) => invoke<string>("config_read", { section }),
  configUpsert: (section: string, entries: [string, string][]) =>
    invoke<void>("config_upsert", { section, entries }),
  configRemove: (section: string) => invoke<void>("config_remove", { section }),
  /** 把 API Key 写进所有 llama.cpp 引擎 config（空串 = 清除）；返回写入份数（用户 m06341） */
  configSetApiKey: (key: string) => invoke<number>("config_set_api_key", { key }),
  /** 从 llama.cpp-hub 的 launch_config.json 迁移模型启动参数 */
  configImportHub: () => invoke<HubImportReport>("config_import_hub"),
  /** 用系统默认浏览器打开本机 http 地址（llama.cpp 自带聊天界面） */
  openLocalUrl: (url: string) => invoke<void>("open_local_url", { url }),
  /** 用系统默认浏览器打开外部 http(s) 链接（聊天里的网页链接） */
  openExternal: (url: string) => invoke<void>("open_external_url", { url }),
  configEntries: (section: string) => invoke<[string, string][]>("config_entries", { section }),
  favouriteToggle: (modelId: string) => invoke<string[]>("favourite_toggle", { modelId }),

  // ---- 性能测试 ----
  benchServer: (args: {
    host: string;
    port: number;
    apiKey?: string | null;
    model: string;
    promptTokens: number;
    maxTokens: number;
    concurrency: number;
  }) => invoke<BenchRecord[]>("bench_server", args),

  /** Strata 通道压测：端口 / 模型名 / api key 都由 Rust 侧从 config 读（密钥不下发前端） */
  benchStrata: (args: {
    root: string;
    configFile: string;
    promptTokens: number;
    maxTokens: number;
    concurrency: number;
  }) => invoke<BenchRecord[]>("bench_strata", args),

  benchRecords: (benchDir: string) => invoke<BenchRecord[]>("bench_records", { benchDir }),
  benchRecordsAdd: (benchDir: string, items: BenchRecord[]) =>
    invoke<BenchRecord[]>("bench_records_add", { benchDir, items }),
  benchRecordsDelete: (benchDir: string, tsMs: number) =>
    invoke<BenchRecord[]>("bench_records_delete", { benchDir, tsMs }),
  benchRecordsClear: (benchDir: string) => invoke<void>("bench_records_clear", { benchDir }),

  benchHardware: () => invoke<Hardware>("bench_hardware"),
  saveTextFile: (path: string, content: string) =>
    invoke<string>("save_text_file", { path, content }),

  /** 联网搜索：多引擎 + fallback + 冷却 + 缓存（见 `src-tauri/src/search.rs`） */
  searchQuery: (query: string, limit?: number, timeRange?: string | null) =>
    invoke<SearchResponse>("search_query", {
      query,
      limit: limit ?? null,
      timeRange: timeRange ?? null,
    }),
  searchConfig: () => invoke<SearchConfigView>("search_config"),
  searchSaveConfig: (input: SearchConfigInput) =>
    invoke<SearchConfigView>("search_save_config", { input }),
  searchTestEngine: (engine: string) =>
    invoke<SearchTestResult>("search_test_engine", { engine }),
  /** 抓网页正文（聊天工具 `web_fetch` 走这里） */
  webFetch: (url: string, maxChars?: number) =>
    invoke<FetchPage>("web_fetch", { url, maxChars: maxChars ?? null }),

  /** MCP 工具：GUI 自己当客户端起 stdio 子进程（见 `src-tauri/src/mcp.rs`） */
  mcpServers: () => invoke<McpServerConfig[]>("mcp_servers_list"),
  mcpSaveServers: (servers: McpServerConfig[]) =>
    invoke<McpServerConfig[]>("mcp_servers_save", { servers }),
  mcpTools: () => invoke<McpToolsView>("mcp_tools_list"),
  mcpCallTool: (server: string, tool: string, args: Record<string, unknown>) =>
    invoke<string>("mcp_tool_call", { server, tool, arguments: args }),
};

/**
 * 订阅「后台重扫完成」。
 *
 * 启动时前端先拿落盘缓存把列表画出来，后端同时重扫；只有结果真的变了才会发这个事件。
 * 负载里同时带上辅助文件（mmproj / 草稿模型），否则后台扫描跑完它们就没了。
 */
export function onModelsScanned(
  cb: (payload: { models: ScannedModel[]; aux_files?: AuxFile[] }) => void,
): Promise<UnlistenFn> {
  return listen<{ models: ScannedModel[]; aux_files?: AuxFile[] }>("models://scanned", (event) =>
    cb(event.payload),
  );
}

/** 订阅 Strata 状态变化（启动、退出、探测刷新）。 */
export function onStrataStatus(cb: (status: StrataStatus) => void): Promise<UnlistenFn> {
  return listen<StrataStatus>("strata://status", (event) => cb(event.payload));
}

/**
 * 订阅托盘菜单发来的命令（`start-service` / `stop-service`）。
 *
 * 托盘不自己调后端命令，而是把命令转给前端 —— 这样托盘按钮和界面按钮
 * 复用同一套启动流程（前门/引擎状态、错误提示、状态刷新）。
 */
export function onTrayCommand(cb: (command: string) => void): Promise<UnlistenFn> {
  return listen<string>("tray://command", (event) => cb(event.payload));
}

/** 订阅批量日志。 */
export function onLogLines(cb: (lines: LogLine[]) => void): Promise<UnlistenFn> {
  return listen<LogLine[]>("logs://lines", (event) => cb(event.payload));
}

/** 把后端错误统一转成可展示的字符串。 */
export function errText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

/** 读监控采集层的最新快照（不触发额外采样）。 */
export function monitorSample(): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_sample");
}

/** 立刻采一次硬件再返回快照（刚启动或极短的压测档位用）。 */
export function monitorSampleNow(): Promise<MonitorSnapshot> {
  return invoke<MonitorSnapshot>("monitor_sample_now");
}

/** 采引擎的 `/metrics` 与 `/slots`。调用前必须确认模型已加载，否则会把模型拉起来。 */
export function monitorEngine(
  port: number,
  model?: string | null,
  apiKey?: string | null,
  configPath?: string | null,
): Promise<MonitorEngine> {
  return invoke<MonitorEngine>("monitor_engine", {
    port,
    model: model ?? null,
    apiKey: apiKey ?? null,
    // Strata 模型传配置路径：引擎自己的 api_key 只在 Rust 侧，由它读出来再用
    configPath: configPath ?? null,
  });
}