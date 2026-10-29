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
  StrataEngine,
  StrataController,
  ApplyControllerResult,
  StrataEngineState,
  StrataUpgradeSnapshot,
  StrataUpgradeStart,
  StrataDownloadRequest,
  StrataDownloadSnapshot,
  StrataDownloadDisk,
  StrataHostInfo,
  StrataCatalogSnapshot,
  StrataLocalGguf,
  StrataMtpCheck,
  StrataCommunityDiscovery,
  StrataOrcaProbe,
  StrataOrcaSnapshot,
  StrataLaunchPreset,
  StrataStatus,
  StrataTuneSnapshot,
  StrataTuneApplyRecord,
} from "./types";

export const ipc = {
  ping: () => invoke<string>("ping"),
  /** 首屏渲染完成后调用：后端此时才把主窗口显示出来（避免 WebView2 首帧前露底色）。 */
  appBootFinished: () => invoke<void>("app_boot_finished"),
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
  strataPick: (configFile: string) => invoke<Settings>("strata_pick", { configFile }),
  /** 列出 Strata 根目录下并存的控制器版本（`control\<版本>` 或 `terminal\<版本>`） */
  strataControllers: () => invoke<StrataController[]>("strata_controllers"),
  /** 切换控制器版本：重写全部 `run-*.bat` 与 `strata-*.json` 的控制器相关参数 */
  strataApplyController: (version: string) =>
    invoke<ApplyControllerResult>("strata_apply_controller", { version }),
  /** 打开官方安装向导（`setup.py --setup`）：加模型走它，返回控制器目录 */
  strataOpenSetup: () => invoke<string>("strata_open_setup"),
  /** 参数编辑 L2：读 config 原文 */
  strataConfigRead: (configFile: string) => invoke<string>("strata_config_read", { configFile }),
  /** 参数编辑 L2：写 config（后端负责备份 + 校验 + 原子写），返回刷新后的条目 */
  strataConfigWrite: (configFile: string, text: string) =>
    invoke<StrataModelEntry>("strata_config_write", { configFile, text }),
  /** 参数调优：对这份 config 跑官方 `strata tune auto`（quick / thorough） */
  strataTuneStart: (configFile: string, mode: string) =>
    invoke<void>("strata_tune_start", { configFile, mode }),
  /** 参数调优：读进度（前端每 1.5 秒轮询，直到 `running` 为 false） */
  strataTuneStatus: (configFile: string) =>
    invoke<StrataTuneSnapshot>("strata_tune_status", { configFile }),
  /** 参数调优：停止（模型与配置都不会被改动） */
  strataTuneStop: (configFile: string) => invoke<void>("strata_tune_stop", { configFile }),
  /** 把这次调优生效的参数写进 config，返回这次的记录（用户 m01543） */
  strataTuneApply: (configFile: string) =>
    invoke<StrataTuneApplyRecord>("strata_tune_apply", { configFile }),
  /** 上一次调优写进 config 的记录（没有就是 null） */
  strataTuneHistory: (configFile: string) =>
    invoke<StrataTuneApplyRecord | null>("strata_tune_history", { configFile }),
  /** 把设置页「服务」里的 API Key 写进全部 Strata config；空串 = 清掉（用户 m01543） */
  strataSetApiKey: (apiKey: string) =>
    invoke<{ written: string[]; failed: string[] }>("strata_set_api_key", { apiKey }),
  /** 列 Strata 的 launch 预设（只读 `%APPDATA%\Strata\launch-presets`，不起进程） */
  strataLaunchPresets: () => invoke<StrataLaunchPreset[]>("strata_launch_presets"),
  /** 把设置页的 API Key 写进全部 launch 预设；返回改动的预设份数（用户 m02313） */
  strataSyncLaunchKeys: (apiKey: string) => invoke<number>("strata_sync_launch_keys", { apiKey }),
  /** 卸载运行中 Strata 的模型（POST /unload）：进程留着、显存释放 */
  strataUnloadModel: (configFile: string) => invoke<string>("strata_unload_model", { configFile }),
  /** 加载运行中 Strata 的模型（POST /load）：上游会跑 before_load 并检查显存门槛 */
  strataLoadModel: (configFile: string) => invoke<string>("strata_load_model", { configFile }),
  /** 列出官方安装目录下所有可用的引擎版本（可能多份并存） */
  strataEngines: () => invoke<StrataEngine[]>("strata_engines"),
  /** 把某份 config 的 exe 换成选定的引擎可执行文件 */
  strataSetEngine: (configFile: string, exe: string) =>
    invoke<void>("strata_set_engine", { configFile, exe }),
  /** 把选定的引擎批量写进全部 config，返回被改过的文件名 */
  strataApplyEngine: (exe: string) => invoke<string[]>("strata_apply_engine", { exe }),
  /** 控制器跟踪的引擎版本（`strata components engine`）：设置页只读显示 + 回退按钮 */
  strataEngineState: () => invoke<StrataEngineState>("strata_engine_state"),
  /** 回退到上一版引擎（`strata components rollback`），返回给用户看的一句结果 */
  strataEngineRollback: () => invoke<string>("strata_engine_rollback"),
  /** 检查官网 feed 有没有新版本（只读，不下载），返回控制端的原始报告 */
  strataUpgradeCheck: () => invoke<unknown>("strata_upgrade_check"),
  /** 起一次升级：`scope` = all / engine / control；`started=false` 表示已是最新 */
  strataUpgradeStart: (scope: "all" | "engine" | "control") =>
    invoke<StrataUpgradeStart>("strata_upgrade_start", { scope }),
  /** 升级进度（每秒轮询） */
  strataUpgradeStatus: () => invoke<StrataUpgradeSnapshot>("strata_upgrade_status"),
  /** 取消升级（连同解压 / 校验的子进程一起杀） */
  strataUpgradeStop: () => invoke<void>("strata_upgrade_stop"),

  /** 模型下载页：起一次非交互安装（官方 `setup.py --yes --no-start`） */
  strataDownloadStart: (request: StrataDownloadRequest) =>
    invoke<StrataUpgradeStart>("strata_download_start", { request }),
  /** 下载进度（每秒轮询） */
  strataDownloadStatus: () => invoke<StrataDownloadSnapshot>("strata_download_status"),
  /** 取消下载（整棵进程树一起杀） */
  strataDownloadStop: () => invoke<void>("strata_download_stop"),
  /** 磁盘预检：模型目录所在卷够不够这次下载 */
  strataDownloadPreflight: (needBytes: number, dataDir?: string | null) =>
    invoke<StrataDownloadDisk>("strata_download_preflight", { needBytes, dataDir: dataDir ?? null }),
  /** 本机内存 / 显卡（「适合这台电脑」与内存档位） */
  strataDownloadHost: () => invoke<StrataHostInfo>("strata_download_host"),
  /**
   * 控制端 `setup.py` 里的目录参考值（参考 RAM / 体积）。
   *
   * `force=false`（默认）时只有控制端版本变了才真的跑一次解释器，其余情况返回缓存
   * （用户 m01170：升级控制器后同步一次即可）。`force=true` 用在「重新同步」这类手动操作上。
   */
  strataControlCatalog: (force = false) =>
    invoke<StrataCatalogSnapshot>("strata_control_catalog", { force }),
  /** 扫一个目录里的本地 GGUF（「使用已有模型」区块） */
  strataDownloadScanGguf: (dir: string) =>
    invoke<StrataLocalGguf[]>("strata_download_scan_gguf", { dir }),
  /** 认「MTP 草稿层」目录（`<x>`、`<x>\rt`、`<x>\mtp\rt` 都接受） */
  strataDownloadCheckMtp: (dir: string) =>
    invoke<StrataMtpCheck>("strata_download_check_mtp", { dir }),
  /** 社区目录发现（Hugging Face 镜像 API，缓存 24 小时） */
  strataCommunityDiscover: (force: boolean, endpoint?: string | null) =>
    invoke<StrataCommunityDiscovery>("strata_community_discover", {
      force,
      endpoint: endpoint ?? null,
    }),
  /** ORCA 导入前置探测（解释器 / iq_pack.py / 引擎 是否齐） */
  strataOrcaProbe: () => invoke<StrataOrcaProbe>("strata_orca_probe"),
  /** 开始 ORCA 导入（下载分片 → iq_pack 打包 → 写配置） */
  strataOrcaStart: () => invoke<StrataUpgradeStart>("strata_orca_start"),
  /** ORCA 导入进度（每秒轮询） */
  strataOrcaStatus: () => invoke<StrataOrcaSnapshot>("strata_orca_status"),
  /** 取消 ORCA 导入 */
  strataOrcaStop: () => invoke<void>("strata_orca_stop"),

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