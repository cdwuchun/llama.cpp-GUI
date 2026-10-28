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
  /** 全局选定的 Strata 引擎 exe（`components\engine\<版本>-…\strata.exe`）：设置页选完会写进全部 config */
  strata_engine: string | null;
  /** Strata 根目录（`control\` + `engine\` + config 所在处）：**必须由用户指定**，null = 还没指定（无兜底默认值） */
  strata_root: string | null;
  /** 设置页选中的控制器版本目录名（`0.1.51`）：null = 跟着 `control\active.json` */
  strata_controller: string | null;
  /** 「自动跟随最新版本」开关：开=没选过/选中的已失效时自动落到最新版本并改写脚本；关=完全按手动选择 */
  strata_auto_controller: boolean;
  /** 同上，引擎版本卡的开关 */
  strata_auto_engine: boolean;
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
  strata_selected_config?: string | null;
  auto_start_strata?: boolean;
  strata_router_mutex?: boolean;
  /** 写入 config 顶层 idle_unload_s：空闲多少秒后卸载模型，下一个请求自动重载（上游 server.py:5357-5359）。空=不启用 */
  strata_idle_unload_s?: number | null;
  /** 写入 config 顶层 min_free_vram_mib：空闲显存不足则 503 不加载（上游 server.py:2596-2604）。空=不启用 */
  strata_min_free_vram_mib?: number | null;
  /** 写入 config 顶层 before_load：加载模型前执行的命令（上游 server.py:2589-2595）。空=不启用 */
  strata_before_load?: string | null;
  /** 全局选定的 Strata 引擎 exe；改它会连带把全部 config 的 exe 写过去（由设置页先调 strata_apply_engine） */
  strata_engine?: string | null;
  /** Strata 根目录；null = 恢复默认官方安装目录 */
  strata_root?: string | null;
  /** 选中的控制器版本目录名；null = 跟着 `active.json` */
  strata_controller?: string | null;
  strata_auto_controller?: boolean;
  strata_auto_engine?: boolean;
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
  /** 共享 CUDA 运行时的版本（如 `13.4`），设置页「共享运行时版本」列 */
  runtime_version: string | null;
  /** 后端标签（cuda / cpu / vulkan …），设置页「后端」列 */
  backend: string | null;
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

export interface LogLine {
  seq: number;
  /** system / strata / model:<模型名>（前门化后按模型名分来源，router 时代是 model:<端口>） */
  source: string;
  ts_ms: number;
  text: string;
}

/** 日志落盘信息（`logs_info`）：面板显示路径、「打开日志目录」按钮用。 */
export interface LogFileInfo {
  /** 日志目录（这一轮还没落盘时为空串） */
  dir: string;
  /** 当前日志文件全路径（未落盘时为 null） */
  file: string | null;
  /** 内存里现有的行数 */
  lines: number;
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
  /** 上下文上限：Rust 侧是 `Option<String>`（config 里就是字符串），所以要用前先转数字 */
  max_context: string | number | null;
  /** 原样显示，不校验（上游只认 int8/q4_0，本机在用 k8v4） */
  kv: string | null;
  kv_resident: string | null;
  vram_reserve_mib: number | null;
  vision: boolean;
  gpu: string | null;
  prompt_cache: boolean;
  spec: string | null;
  /** args 里带 --mtp = 这套安装给该模型装了 MTP 草稿权重（安装事实类，GUI 只读） */
  mtp: boolean;
  modified_ms: number | null;
  /** 引擎文件是否存在（升级中途失败时会是 false） */
  engine_exists: boolean;
  /** 引擎版本，读引擎同目录 BUILD.json 的 version（运行时 /props.build_info 同源） */
  engine_version: string | null;
  /** 扫描时把 config 里的 exe 改成了当前安装的引擎（升级换了版本子目录） */
  engine_stale: boolean;
  /** 模型文件路径，来自 args 的 --native */
  model_path: string | null;
  /** 模型实际字节数：分片模型（-00001-of-00002.gguf）聚合全部分片求和 */
  model_size_bytes: number | null;
  /** 模型架构，读 GGUF 头部 general.architecture（卡片图标与模型列表页同语义） */
  architecture: string | null;
  /** 量化标识：优先 GGUF 头部 file_type 推导，取不到时从文件名 stem 兜底 */
  quantization: string | null;
}

/**
 * `components\engine\` 下的一份引擎组件（可能多版本并存，面板列出来让用户选）。
 *
 * 字段来自该版本目录的 `engine-component.json`；清单缺字段时后端回退到
 * 目录名与 `BUILD.json`，所以整组都可缺省。
 */
export interface StrataEngine {
  version: string | null;
  platform: string | null;
  backend: string | null;
  build: string | null;
  archs: string[];
  exe: string;
}

/**
 * `control\<版本>`（手动解压）或 `terminal\<版本>`（官方安装器）下的一个控制器版本。
 *
 * 设置页「Strata 控制器版本」表格的一行；选中后由 `strata_apply_controller`
 * 把全部 `run-*.bat` 与 `strata-*.json` 切到这个版本。
 */
export interface StrataController {
  /** 版本目录名，如 `0.1.51` */
  version: string;
  folder: string;
  /** 目录里有自带的解释器（`python\python.exe`） */
  python: boolean;
  /** 目录里有 `serve\server.py` */
  server: boolean;
  /** `control\active.json` 记的当前版本 */
  active: boolean;
  /** 能用：带解释器 + `serve\server.py` */
  usable: boolean;
}

/** 切换控制器版本的结果（`strata_apply_controller`）。 */
export interface ApplyControllerResult {
  version: string;
  folder: string;
  /** 重写过的 `run-*.bat` 文件名 */
  scripts: string[];
  /** 改过 `cwd` / `args` 的 config 文件名 */
  configs: string[];
}

/**
 * 一次 Strata 一键升级的进度快照（`strata_upgrade_status`，前端每秒轮询）。
 *
 * 升级本身由控制端跑（`strata.py update`：读签名 feed → 下载 → 校验 → 试启动 → 切换），
 * GUI 只翻译它的 jsonl 事件流。
 */
export interface StrataUpgradeSnapshot {
  /** 子进程还在跑 */
  running: boolean;
  /** 进程退出码（还在跑时为 null） */
  exitCode: number | null;
  /** 阶段：`feed` / `download` / `verify` / `switch` / `done` … */
  phase: string;
  /** 下载百分比 0–100（非下载阶段为 0） */
  percent: number;
  /** 一行状态，界面直接显示 */
  message: string;
  /** 正在下的包名 */
  label: string;
  doneBytes: number;
  totalBytes: number;
  /** 结束时控制端的最终报告（含 engine / control 的 installed、offered） */
  result: unknown;
  /** 控制端自报成功 */
  ok: boolean | null;
  /** 最近几十行输出（排错用） */
  logTail: string[];
}

/** `strata_upgrade_start` 的返回：`started=false` 时没有新版本可升。 */
export interface StrataUpgradeStart {
  started: boolean;
  message: string;
}

/**
 * 「模型下载」页发起的一次安装（后端 `strata_download::DownloadRequest`）。
 *
 * 全部字段一次给齐：后端拼成 `setup.py --family … --model … --context … --yes --no-start`
 * 的非交互调用，`source` / `backend` / `gpu` 是公共配置条那几项，`hfEndpoint` 走环境变量。
 */
export interface StrataDownloadRequest {
  family: string;
  quant: string;
  context: number;
  images: boolean;
  /** 「使用已有 GGUF」时的本地目录（`--gguf-dir`） */
  ggufDir?: string | null;
  /** 下载落地目录（`--data-dir`），空 = 控制端默认数据目录 */
  dataDir?: string | null;
  /** `auto` / `modelscope` / `huggingface` */
  source?: string | null;
  /** HF 镜像地址（`HF_ENDPOINT`） */
  hfEndpoint?: string | null;
  /** `cuda` / `hip` / `sycl` */
  backend?: string | null;
  /** 指定显卡编号 */
  gpu?: string | null;
}

/**
 * 下载进度快照（`strata_download_status`，前端每秒轮询一次）。
 *
 * 与升级快照同一形态：进度来自 `setup.py` 的 `\r` 进度行，`logTail` 是收尾排错用的尾巴。
 */
export interface StrataDownloadSnapshot {
  running: boolean;
  exitCode: number | null;
  /** `starting` / `check` / `download` / `pack` / `engine` / `config` / `done` / `failed` / `cancelled` */
  phase: string;
  /** 当前文件下载百分比 0–100 */
  percent: number;
  /** 一行状态，界面直接显示 */
  message: string;
  /** 正在下载的模型/文件 */
  label: string;
  doneBytes: number;
  totalBytes: number;
  logTail: string[];
  /** 结束时判定：成功为 true */
  ok: boolean | null;
  family: string;
  quant: string;
  context: number;
  images: boolean;
}

/** 下载前的磁盘预检（模型目录所在卷）。 */
export interface StrataDownloadDisk {
  /** 模型实际会落在哪个目录 */
  dataDirectory: string | null;
  /** 该目录所在的卷根（`D:\`） */
  volume: string | null;
  availableBytes: number | null;
  /** 这次要下的字节数（含打包余量，前端算好传进去） */
  needBytes: number;
  /** `ready` / `insufficient` / `unknown` */
  status: string;
}

/** 本机信息（「适合这台电脑」与内存档位判断用）。 */
export interface StrataHostInfo {
  /** 物理内存 GB（GiB） */
  memoryGb: number | null;
  /** 当前可用内存 GB —— 详情页「本机可用 RAM」用它 */
  availableMemoryGb: number | null;
  /** 最高一张卡的显存 GB（取不到为空） */
  vramGb: number | null;
  /** 显卡名（`nvidia-smi` 取不到就空） */
  gpus: string[];
  /** 已装引擎的 Strata 发布版本（`0.2.7` 这条线），读不到为 null */
  release: string | null;
  platform: string;
}

/** 一个本地 GGUF 文件组（同名分片合成一条）。 */
/** 「MTP 草稿层」目录：安装器只在 `<dataDirectory>\mtp\rt` 找 experts.bin */
export interface StrataMtpCheck {
  input: string;
  rtDirectory: string | null;
  dataDirectory: string | null;
  expertsBytes: number;
  problems: string[];
}

export interface StrataLocalGguf {
  /** 去掉分片后缀的显示名 */
  name: string;
  /** 第一分片的完整路径 */
  path: string;
  bytes: number;
  shards: number;
}

/**
 * ORCA 导入的前置探测结果（`strata_orca_probe`）。
 *
 * ORCA 这一条不走官方安装器：`setup.py` 里没有 orca 代码，导入要靠控制端自带的
 * `tools/iq_pack.py` 打包，所以面板要先确认「解释器 / iq_pack / 引擎」三样都在。
 */
export interface StrataOrcaProbe {
  /** 三条链路都具备 */
  available: boolean;
  /** 缺什么（空 = 都具备） */
  problems: string[];
  /** 分片下载目录 */
  ggufDir: string;
  /** pack 产物目录 */
  packDir: string;
  /** 会写出的配置路径 */
  configPath: string;
  /** 两个分片的总字节 */
  downloadBytes: number;
  /** 数据盘可用字节（读不到为 null） */
  availableBytes: number | null;
  /** pack 已存在（装过就不必再下） */
  packReady: boolean;
  /** 分片已齐 */
  shardsReady: boolean;
  /** 专家 arena 需要的系统内存（GiB） */
  arenaGib: number;
}

/** ORCA 导入的进度快照（`strata_orca_status`）。 */
export interface StrataOrcaSnapshot {
  running: boolean;
  /** `download` / `pack` / `config` / `done` / `failed` / `cancelled` */
  phase: string;
  percent: number;
  message: string;
  logTail: string[];
  ok: boolean | null;
  ggufDir: string;
  packDir: string;
  configPath: string;
  doneBytes: number;
  totalBytes: number;
}

/**
 * 社区目录里的一个 GGUF 文件（分片之一）。
 */
export interface StrataCommunityFile {
  path: string;
  size: number;
  sha256: string | null;
}

/** 社区模型的一个量化版本。 */
export interface StrataCommunityQuant {
  files: StrataCommunityFile[];
  /** 下载体积（GB，十进制） */
  downloadGb: number;
  /** 参考内存（GB） */
  ramGb: number;
}

/**
 * 社区 GGUF 条目：既可能是前端内置的三条（`source: "builtin"`），
 * 也可能是后端从 Hugging Face 发现的（`source: "discovered"`）。
 */
export interface StrataCommunityModel {
  id: string;
  slug: string;
  name: string;
  repo: string;
  revision: string;
  /**
   * `setup.py --family` 的取值：qwen / swift / coder / unsloth；
   * ORCA 那条是 `orca`（setup.py 不认，只能走官方安装器）。
   */
  family: string;
  /** `gsq-rco` / `control-vector` / `orca` */
  kind: string;
  images: boolean;
  quants: string[];
  quantInfo: Record<string, StrataCommunityQuant>;
  mmproj: string | null;
  risks: string[];
  source: "builtin" | "discovered";
  downloads: number | null;
  likes: number | null;
  updatedAt: string | null;
}

/** 社区发现结果；`state` 对应上游的 fresh / cached / stale / offline。 */
export interface StrataCommunityDiscovery {
  entries: StrataCommunityModel[];
  state: "fresh" | "cached" | "stale" | "offline";
  fetchedAt: number | null;
  error: string | null;
}

/**
 * 控制器跟踪的引擎版本（`strata components engine --output json` 的精简版）。
 * 引擎版本由 Strata 控制器决定（`components\control\<版本>` + `terminal\current`），
 * 设置页只读显示、只给「回退到上一版」一个动作（用户 m02756 第 2 条）。
 */
export interface StrataEngineState {
  /** 控制器当前会启动的引擎版本，如 `0.1.48` */
  version: string | null;
  /** Strata 发布版本，如 `0.2.7`（引擎元数据 notes 里那一条）；读不到为 null */
  release: string | null;
  /** 引擎目录名（`<版本>-<平台>-<后端>`） */
  folder: string | null;
  /** 上一版（上次更新留下的那份）；为空 = 没有可回退的版本 */
  previous: string | null;
  /** 被 pin 住的版本（回退之后出现，下次成功更新才清掉） */
  pinned: string | null;
  usable: boolean;
  update_notice: string | null;
}

/**
 * 「参数调优」的进度快照：镜像 `strata tune auto --status-file` 写出的 JSON。
 *
 * 调优只把结果存成 Strata 预设（preset），不改 config；下次启动时由
 * `serve\server.py` 的 `apply_saved_tuning` 叠加生效。
 */
export interface StrataTuneSnapshot {
  /** 子进程是否还在跑；变 false 后前端停止轮询 */
  running: boolean;
  /** running | done | exited（进程退出但没写完成 = exited，按失败展示） */
  state: string;
  /** CLI 自报的阶段（如 "measuring"），可能为空 */
  stage: string;
  /** CLI 自报的一句话进度 */
  message: string;
  /** CLI 输出的当前行动（比 message 更细，可能为空） */
  text: string;
  /** 预计剩余秒数（`strata tune` 自己的估算） */
  eta_s: number | null;
  /** 剩余分钟数（CLI 自己估算，可能为空） */
  minutes_left: number | null;
  /** 结束后的结果：outcome / gain_pct / preset / notes */
  result: Record<string, unknown> | null;
  /** 进程输出的最后几行（失败时给用户看原因） */
  log_tail: string[];
  /** 退出码（进程结束后才有值） */
  exit_code: number | null;
}

/**
 * 一次「把调优参数写进 config」的记录（后端 `strata_tune_apply` / `strata_tune_history`）。
 *
 * 用户 m01543：调优完成后把新增/删除的参数写进 config，并留一条记录，下次打开调优面板能回看。
 */
export interface StrataTuneApplyRecord {
  /** 生成时间（毫秒时间戳） */
  atMs: number;
  /** 这次叠加来自哪条预设（名字） */
  preset: string | null;
  /** 新增的参数（`--flag value` 形式） */
  added: string[];
  /** 删除的参数（`--flag value` 形式） */
  removed: string[];
  /** 是否真的改了 config */
  applied: boolean;
  /** 界面上直接显示的中文说明 */
  message: string;
}

/**
 * 一份 Strata `launch` 预设（`%APPDATA%\Strata\launch-presets\*.json`）。
 *
 * 启动时若这份模型有预设，GUI 会用控制端的 `Runner` 按它重新生成
 * `launch\<file>.json`（host / port / key / context / kv / 卡 / extra env 全按预设），
 * 再拿这份配置起 serve —— 与 `strata launch` 起出来的服务一致。
 */
export interface StrataLaunchPreset {
  /** 文件名主体，也是 `launch\<file>.json` 的名字 */
  file: string;
  name: string;
  family: string;
  model: string;
  model_path: string;
  port: number;
  context: number | null;
  kv: string | null;
  vision: string | null;
  access: string;
  last_used: string | null;
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
  /** 前门代理是否在监听（用户 m00798：前门 9090，DSH 连它，引擎按模型各用各的端口） */
  proxy: boolean;
  /** 前门端口 —— DSH 等客户端要连的就是它（引擎端口只给 GUI 自己用） */
  proxy_port: number | null;
  /** 前门当前正在服务的 config 文件名（null = 空闲/没开）；卡片据此显示「加载中」（用户 m01266） */
  proxy_serving: string | null;
}

export interface AppPaths {
  config_dir: string;
  /** 模型配置目录（`<配置目录>\config`，一个模型一份 JSON）；旧名 preset_path 已退役（第三刀） */
  model_config_dir: string;
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

/** 配置目录里的一份 config（`llamacpp-<id>.json`）—— 原生视图，前端不再解析 ini 文本 */
export interface ConfigEntry {
  /** config 文件名主体；请求里 `model` 用的也是它 */
  id: string;
  /** 配置里的 `name`（迁移后与 id 一致） */
  name: string;
  /** 关掉了自带 WebUI ⇒ 卡片上的「聊天」入口要禁用 */
  no_webui: boolean;
  /** 配置指向的模型文件还在不在（不在就是归档/失效） */
  has_model: boolean;
  /** args 里 `--ctx-size` 的值（0 或没写就是 null）—— 压测页挑档位用，不必问前门 */
  max_context?: number | null;
}

export interface ModelScanResult {
  models: ScannedModel[];
  /** 投影文件 / 外挂草稿模型：不列进模型列表，但配置里可以选 */
  aux_files?: AuxFile[];
  /** 配置目录里的 config 清单（「已配置」与 WebUI 开关的判据） */
  configs?: ConfigEntry[];
  /** preset 中存在但当前扫描不到的段 */
  orphan_sections: string[];
  /** 本次顺手清理掉的失效段（这些段的模型文件已经不在了） */
  removed_sections?: string[];
  /** 本次从归档里恢复回来的段（模型重新下载回来、参数自动接上） */
  restored_sections?: string[];
  /** 所有段都失效、疑似模型盘未就绪，本次跳过了清理 */
  prune_skipped?: boolean;
}

/** 联网搜索的一条结果（后端 `search_query` 的返回项） */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** 一次搜索的结果（`src-tauri/src/search.rs` 的 `SearchResponse`） */
export interface SearchResponse {
  /** 最后真正给出结果的引擎 */
  engine: string;
  hits: SearchHit[];
  /** 逐个引擎的尝试记录：失败的会带上分类与原因 */
  attempts: { engine: string; error: string | null }[];
  cached: boolean;
  timeRange: string | null;
  /** 已包好不可信边界的整段文本，直接拼进提示词 */
  block: string;
}

/** 一个搜索引擎的状态 */
export interface SearchEngineView {
  name: string;
  /** 不配 key 也能用 */
  keyless: boolean;
  hasKey: boolean;
  /** 刚失败过，正在冷却 */
  cooling: boolean;
}

/** 联网搜索的配置视图（不含任何 key 明文） */
export interface SearchConfigView {
  order: string[];
  blockedDomains: string[];
  timeRange: string | null;
  maxResults: number;
  engines: SearchEngineView[];
}

/** 保存联网搜索配置的入参；`keys` 里空串表示删除该 key */
export interface SearchConfigInput {
  order: string[];
  keys: Record<string, string>;
  blockedDomains: string[];
  timeRange: string | null;
  maxResults: number;
}

/** 设置页「测试」按钮的结果 */
export interface SearchTestResult {
  engine: string;
  ok: boolean;
  count: number;
  ms: number;
  message: string | null;
}

/** 抓一个网页的结果（后端 `web_fetch` 命令 = `search.rs::FetchPage`） */
export interface FetchPage {
  /** 模型给的原始地址 */
  url: string;
  /** 跟随重定向后的地址 */
  finalUrl: string;
  status: number;
  title: string;
  contentType: string;
  /** 清洗后的正文字符数 */
  chars: number;
  truncated: boolean;
  /** 已包好不可信边界的整段文本，直接当工具结果回填 */
  block: string;
  /** 抓取时的提示（如页面不是 UTF-8） */
  note: string | null;
}

/** 一台 MCP 服务器（落在 `<配置目录>\mcp.json`，形状同 Cursor 的 `mcpServers`） */
export interface McpServerConfig {
  name: string;
  /** 启动命令；Windows 上 `npx` 这类脚本要写 `npx.cmd` 或完整路径 */
  command: string;
  args: string[];
  /** 追加/覆盖的环境变量（父进程环境默认继承） */
  env: Record<string, string>;
  enabled: boolean;
}

/** 一个 MCP 工具。`key` 是发给模型的名字（`mcp__<服务器>__<工具>`） */
export interface McpToolView {
  key: string;
  /** 服务器名（原始写法，调用时回传给后端） */
  server: string;
  /** 服务器里的工具名（原始写法） */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 一台服务器拉取工具的结果 */
export interface McpServerView {
  name: string;
  ok: boolean;
  count: number;
  error: string | null;
}

/** 全部启用的 MCP 服务器的工具汇总 */
export interface McpToolsView {
  tools: McpToolView[];
  servers: McpServerView[];
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
  /** 通道来源（前门合成的列表里才有：`strata` / `llamacpp`） */
  channel?: string;
  /** 已加载时子实例监听的端口（前门直接给出，不用再从 `status.args` 里解析） */
  port?: number | null;
  /** 调度器细粒度状态（idle/starting/ready/stopping/failed），仅 llama.cpp 通道有 */
  state?: string;
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
  /** 通道来源：`llamacpp`（本地子实例）或 `strata`（Strata 引擎）。卡片用它显示引擎标识（用户 m02048 第 4 点）。 */
  channel?: string;
  /** strata 通道专用：配置文件全名（如 `strata-swift-iq3_xxs.json`）。strata 的启停走 Strata 接口，用的是它而不是 `section`。 */
  strataFile?: string;
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

// ---------------------------------------------------------------- 监控采集层

/** 单张显卡的瞬时读数（`nvidia-smi` 口径，显存单位 MiB）。 */
export interface MonitorGpuSample {
  name: string;
  utilization: number | null;
  memUsedMib: number | null;
  memTotalMib: number | null;
  temperature: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  /** PCIe 下行/上行吞吐（MB/s），来自 NVML 的 `nvmlDeviceGetPcieThroughput`。 */
  pcieRxMb: number | null;
  pcieTxMb: number | null;
  /** 当前 PCIe 链路代数与宽度（Gen4 x8 → 4 / 8）。 */
  pcieLinkGen: number | null;
  pcieLinkWidth: number | null;
}

/** 当前这一刻：`gpu` 是多卡聚合（显存/功耗求和、利用率平均、温度取最大），`gpus` 是明细。 */
export interface MonitorNow {
  cpuPercent: number | null;
  memUsed: number | null;
  memTotal: number | null;
  gpu: MonitorGpuSample | null;
  gpus: MonitorGpuSample[];
  /** 磁盘读/写吞吐（MB/s），PDH 的 `PhysicalDisk(_Total)`。 */
  diskReadMb: number | null;
  diskWriteMb: number | null;
  /** 采样时刻（Unix 毫秒）。 */
  at: number;
}

/** 不随时间变的部分。 */
export interface MonitorStaticInfo {
  gpuName: string | null;
  gpuCount: number;
  memTotal: number | null;
  hasGpu: boolean;
  /** 物理核心数 / 逻辑处理器数（照上游 hardware_static.cores / threads）。 */
  cores: number | null;
  threads: number | null;
}

/** 最近 60 个采样点（1 秒一个）：`at` 与每个序列等长。 */
export interface MonitorHistory {
  at: number[];
  series: Record<string, (number | null)[]>;
}

export interface MonitorSnapshot {
  now: MonitorNow;
  static: MonitorStaticInfo;
  history: MonitorHistory;
}

/** `/metrics` 与 `/slots` 的原始 JSON（结构随引擎版本变化，前端按需取）。 */
export interface MonitorEngine {
  metrics: unknown;
  slots: unknown;
  error: string | null;
}