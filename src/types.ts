/** 与 Rust 侧 `serde` 结构对应的类型定义。 */

export interface GpuSettings {
  /** 空数组 = 不传 --device（使用全部可见设备，交给 --fit 自动分配） */
  devices: string[];
  /** layer | row | none | tensor（tensor 与 --fit 不兼容） */
  split_mode: string;
  /** null = 由 --fit 自动生成 */
  tensor_split: number[] | null;
  main_gpu: number | null;
  /** 默认 true：交给原生 --fit 自动分配显存 */
  fit: boolean;
  fit_target: number[] | null;
  /** null = 不传 -ngl（保留 --fit 的自动层分配） */
  n_gpu_layers: string | null;
}

export interface ViewSettings {
  mode: string;
  density: string;
}

export interface VersionProbe {
  has_router_mode: boolean;
  probed_at_ms: number;
}

export interface Settings {
  llama_cpp_dir: string | null;
  model_roots: string[];
  shared_lib_dirs: string[];
  selected_version: string | null;
  port: number;
  models_max: number;
  /** 空闲多少秒后释放模型与显存（对所有模型生效）；-1 = 关闭 */
  sleep_idle_seconds: number;
  api_key: string | null;
  gpu: GpuSettings;
  autostart: boolean;
  /** 关闭窗口时隐藏到托盘（托盘菜单里退出） */
  minimize_to_tray: boolean;
  /** 应用启动后自动拉起 router */
  auto_start_router: boolean;
  favourites: string[];
  aliases: Record<string, string>;
  view: ViewSettings;
  version_cache: Record<string, VersionProbe>;
  /** Strata 安装根目录（GUI 侧唯一需要用户提供的 Strata 路径，R2） */
  strata_root: string | null;
  /** 上次选中的 Strata config 文件名 */
  strata_selected_config: string | null;
  /** 应用启动后自动拉起 Strata（设置页已不再暴露，保留兼容旧配置） */
  auto_start_strata: boolean;
  /** Strata 与 router 显存互斥：启动 Strata 前卸掉 router 运行中的模型，加载 router 模型前停掉 Strata */
  strata_router_mutex: boolean;
  /** 写入 config 顶层 idle_unload_s：空闲多少秒后卸载模型，下一个请求自动重载（上游 server.py:5357-5359）。null=不启用 */
  strata_idle_unload_s: number | null;
  /** 写入 config 顶层 min_free_vram_mib：空闲显存不足则 503 不加载（上游 server.py:2596-2604）。null=不启用 */
  strata_min_free_vram_mib: number | null;
  /** 写入 config 顶层 before_load：加载模型前执行的命令（上游 server.py:2589-2595）。null=不启用 */
  strata_before_load: string | null;
  /** 设置页「服务」分组上次写入的监听地址（真实来源是各 strata-*.json 的 host） */
  strata_host: string | null;
  /** 设置页「服务」分组上次写入的端口（真实来源是各 strata-*.json 的 port） */
  strata_port: number | null;
  /** 设置页「服务」分组上次写入的 API Key（真实来源是各 strata-*.json 的 api_key） */
  strata_api_key: string | null;
}

/** 设置补丁：仅提供需要修改的字段。 */
export interface SettingsPatch {
  llama_cpp_dir?: string | null;
  model_roots?: string[];
  shared_lib_dirs?: string[];
  selected_version?: string | null;
  port?: number;
  models_max?: number;
  sleep_idle_seconds?: number;
  api_key?: string | null;
  gpu?: GpuSettings;
  autostart?: boolean;
  minimize_to_tray?: boolean;
  auto_start_router?: boolean;
  favourites?: string[];
  aliases?: Record<string, string>;
  view?: ViewSettings;
  strata_root?: string | null;
  strata_selected_config?: string | null;
  auto_start_strata?: boolean;
  strata_router_mutex?: boolean;
  /** 写入 config 顶层 idle_unload_s：空闲多少秒后卸载模型，下一个请求自动重载（上游 server.py:5357-5359）。空=不启用 */
  strata_idle_unload_s?: number | null;
  /** 写入 config 顶层 min_free_vram_mib：空闲显存不足则 503 不加载（上游 server.py:2596-2604）。空=不启用 */
  strata_min_free_vram_mib?: number | null;
  /** 写入 config 顶层 before_load：加载模型前执行的命令（上游 server.py:2589-2595）。空=不启用 */
  strata_before_load?: string | null;
  strata_host?: string | null;
  /** 仅记录「服务」分组写入过的端口；null = 本次没填，保留旧记录 */
  strata_port?: number | null;
  strata_api_key?: string | null;
}

export interface LlamaCppVersion {
  name: string;
  dir: string;
  server_bin: string;
  fit_params_bin: string | null;
  /** null = 尚未探测 */
  has_router_mode: boolean | null;
  /** 直接包含 cudart64_ 与 cublas64_ 系列 DLL 的共享运行时目录 */
  shared_lib_dirs: string[];
  /** 路径是否纯 ASCII（router 在非 ASCII 路径下无法创建模型子实例） */
  ascii_safe: boolean;
}

export interface DeviceInfo {
  name: string;
  description: string;
  total_mib: number | null;
  free_mib: number | null;
}

export interface DeviceResult {
  devices: DeviceInfo[];
  cuda_ready: boolean;
  shared_lib_dirs: string[];
  error: string | null;
}

export interface FitRow {
  device: string;
  model_mib: number;
  context_mib: number;
  compute_mib: number;
}

/** 从 llama.cpp-hub 迁移模型启动参数的结果 */
export interface HubImportReport {
  hub_path: string;
  total: number;
  matched: number;
  entries: number;
  missing: string[];
}

export interface RouterStatus {
  running: boolean;
  port: number;
  pid: number | null;
  version: string | null;
  version_dir: string | null;
  started_at_ms: number | null;
  last_error: string | null;
  ascii_fixed_from: string | null;
}

export interface LogLine {
  seq: number;
  /** system 或 model:<端口> */
  source: string;
  ts_ms: number;
  text: string;
}

/**
 * 一份 Strata config（= 一个常驻模型）的扫描结果。
 *
 * 字段全部来自 config 原文，语义照抄上游 `setup.py` 的 `choices_from_config`；
 * 上游字段会增减，所以除 `config_path` 外都是可缺省的。
 */
export interface StrataModelEntry {
  config_path: string;
  model_name: string | null;
  port: number | null;
  host: string | null;
  /** 只告诉前端"有没有设密钥"，密钥本身不下沉到 WebView */
  has_api_key: boolean;
  engine: string | null;
  cwd: string | null;
  run_script: string | null;
  max_context: number | null;
  /** 原样显示，不校验（上游只认 int8/q4_0，本机在用 k8v4） */
  kv: string | null;
  kv_resident: string | null;
  vram_reserve_mib: number | null;
  vision: boolean;
  gpu: string | null;
  prompt_cache: boolean;
  spec: string | null;
  modified_ms: number | null;
  /** 引擎文件是否存在（升级中途失败时会是 false） */
  engine_exists: boolean;
  /** 引擎版本，读引擎同目录 BUILD.json 的 version（运行时 /props.build_info 同源） */
  engine_version: string | null;
  /** 模型文件路径，来自 args 的 --native */
  model_path: string | null;
  /** 模型实际字节数：分片模型（-00001-of-00002.gguf）聚合全部分片求和 */
  model_size_bytes: number | null;
  /** 模型架构，读 GGUF 头部 general.architecture（卡片图标与模型列表页同语义） */
  architecture: string | null;
  /** 量化标识：优先 GGUF 头部 file_type 推导，取不到时从文件名 stem 兜底 */
  quantization: string | null;
}

/** Strata 运行状态：进程事实 + 运行时探测（生效上下文、加载状态、token 占用）。 */
export interface StrataStatus {
  running: boolean;
  port: number;
  pid: number | null;
  config_path: string | null;
  model_name: string | null;
  started_at_ms: number | null;
  last_error: string | null;
  /** 来自 `/props.build_info`，不缓存（R3） */
  version: string | null;
  /** 来自 `/health.max_context` —— 与 config 里的值比对，用于"需重启生效"提示 */
  live_max_context: number | null;
  loaded: boolean | null;
  busy: boolean | null;
  prompt_tokens: number | null;
  max_tokens: number | null;
  models_autoload: boolean | null;
  /** 运行中的实例不是本 GUI 启动的（GUI 无法启停它） */
  external: boolean;
}

export interface AppPaths {
  config_dir: string;
  preset_path: string;
  link_root: string;
}

/** 递归扫描得到的模型（后端 models.rs） */
export interface ScannedModel {
  /** preset 段名，同时是请求里 `model` 字段的取值 */
  id: string;
  name: string;
  path: string;
  dir: string;
  size_bytes: number;
  quantization: string | null;
  /** GGUF 头部里的 `general.architecture`（如 `bert` / `qwen35moe` / `llama`） */
  architecture: string | null;
  mmproj: string | null;
  shards: number;
  modified_ms: number;
  group: string;
}

/** 辅助 gguf：多模态投影文件（mmproj）或外挂草稿模型（draft），不作为模型展示 */
export interface AuxFile {
  /** 绝对路径（正斜杠），也是写进 preset 的值 */
  path: string;
  name: string;
  dir: string;
  size_bytes: number;
  group: string;
  kind: "mmproj" | "draft" | string;
}

export interface ModelScanResult {
  models: ScannedModel[];
  /** 投影文件 / 外挂草稿模型：不列进模型列表，但配置里可以选 */
  aux_files?: AuxFile[];
  preset_path: string;
  preset_text: string;
  /** preset 中存在但当前扫描不到的段 */
  orphan_sections: string[];
  /** 本次顺手清理掉的失效段（这些段的模型文件已经不在了） */
  removed_sections?: string[];
  /** 本次从归档里恢复回来的段（模型重新下载回来、参数自动接上） */
  restored_sections?: string[];
  /** 所有段都失效、疑似模型盘未就绪，本次跳过了清理 */
  prune_skipped?: boolean;
}

/** router `GET /models` 的状态对象 */
export interface RouterModelStatus {
  value: string;
  args?: string[];
  preset?: string;
  failed?: boolean;
  exit_code?: number;
  progress?: {
    stages?: string[];
    current?: string;
    value?: number;
  };
}

export interface RouterModel {
  id: string;
  status: RouterModelStatus;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  source?: string;
  can_remove?: boolean;
  aliases?: string[];
}

export interface RouterModelsResponse {
  data?: RouterModel[];
}

/** router `/models/sse` 事件 */
export interface RouterSseEvent {
  model: string;
  event: string;
  data?: {
    status?: string;
    progress?: { stages?: string[]; current?: string; value?: number };
    info?: unknown;
  };
}

/** 列表页使用的合并视图 */
export interface ModelView {
  id: string;
  /**
   * preset 段名，也就是 router 里的模型名（`/models`、`/v1/models`、API 的 model 字段都用它）。
   *
   * 默认等于 id；用户在配置里改了别名后，段名跟着改（router 会给子实例下发
   * `--alias <段名>`，所以改名在 router 侧立即体现）。启动/停止/聊天这些要跟 router
   * 打交道的操作一律用它，**不要用 id**。
   */
  section: string;
  /** 界面显示名（= 段名；没有段时回退到扫描出来的名字） */
  name: string;
  quantization: string | null;
  sizeBytes: number | null;
  shards: number;
  hasMmproj: boolean;
  group: string;
  /** unloaded | loading | loaded | sleeping | downloading | failed */
  status: string;
  port: number | null;
  loadProgress: number | null;
  loadingStage: string | null;
  source: string;
  failed: boolean;
  exitCode: number | null;
  favourite: boolean;
  inPreset: boolean;
  scanned: ScannedModel | null;
}

/** 性能测试：一次 API 压测的记录（来自 bench_server） */
export interface BenchRecord {
  ts_ms: number;
  model: string;
  prompt_tokens: number;
  prompt_per_second: number;
  predicted_tokens: number;
  predicted_per_second: number;
  draft_accept: number | null;
  total_ms: number;
  error: string | null;
}

/** 并发压测的统计行（与 hub 的 computeStats 口径一致：avg/min/max/P50/P95） */
export interface BenchStats {
  isStats: true;
  count: number;
  timestamp: string;
  prefill: { avg: number; min: number; max: number; p50: number; p95: number };
  decode: { avg: number; min: number; max: number; p50: number; p95: number };
  promptN: { avg: number };
  predictedN: { avg: number };
  draftN: { avg: number };
  draftAccepted: { avg: number };
}

/** 表格里的一行：普通记录或统计行 */
export type BenchRow = BenchRecord | BenchStats;

/** 本机硬件（写进压测记录） */
export interface Hardware {
  cpu: string;
  ram_gb: number | null;
}

/** router `GET /props?model=` 的常用字段 */export interface ModelProps {
  model_path?: string;
  model_alias?: string;
  model_ftype?: string;
  total_slots?: number;
  is_sleeping?: boolean;
  build_info?: string;
  modalities?: { vision?: boolean; video?: boolean; audio?: boolean };
  default_generation_settings?: {
    n_ctx?: number;
    params?: Record<string, unknown>;
  };
}
