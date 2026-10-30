# 交接说明（HANDOVER）

> 面向**接手这个仓库的新会话 / 新维护者**。`README.md` 讲能力与用法，本文讲**怎么接手**：架构与代码地图（§1）、
> llama.cpp 行为约束（§2）、前端约定（§3）、后端要点（§4）、构建与验证（§5）、运行时数据文件（§6）、未决项（§7）。
>
> **现行版本 0.3.4（2026-10-30）**。逐轮实现日志与历史决策不写在这里，去 `docs/archive/`：
> `ITERATION_LOG.md`（0.1.x → 0.2.0 的起因、实测证据与坑）、`DECISIONS-2026-10.md`（2026-10 关键决策）；
> 已落地的设计文档：`PROXY_SCHEDULER_PLAN.md`（前门与配置层规格）、`STRATA_INTEGRATION_PLAN.md`（Strata 通道）、
> `STRATA_MANAGER_PORT_ASSESSMENT.md`（聊天/监控/压测移植）、`WEB_SEARCH_PLAN.md`（五引擎搜索）、
> `UI_STYLE_BASELINE.md`（样式基座 S1–S8）；0.1.x 存档：`REFACTORING_PLAN.md`、`REFACTORING_REVIEW.md`、`CODE_REVIEW.md`。

---

## 0. 三十秒定位

| 问题 | 去哪里看 |
|------|----------|
| 功能有哪些、怎么用 | `README.md` |
| 某个 llama.cpp 行为到底怎样 | 本文 §2（每条都来自真机实测） |
| 要改参数表单 / 模型配置弹窗 | 本文 §4 + `src/assets/params.json` + `src/components/ParamForm.tsx` / `ModelSheets.tsx` |
| 界面长得不对（与参照实现不一致） | 本文 §3.3（参照系是 hub 的**默认首页**那套，不是 newui） |
| 样式 token / 断点 / 图标映射 | `docs/archive/UI_STYLE_BASELINE.md`（`AGENTS.md` 铁律 8 是摘要） |
| 前门调度与配置层规格 | `docs/archive/PROXY_SCHEDULER_PLAN.md` §10 决策、§3.1 配置规格 |
| Strata 通道的细节 | `docs/archive/STRATA_INTEGRATION_PLAN.md` |
| 某次改动为什么这么改 | `docs/archive/ITERATION_LOG.md` + git 历史 |
| 构建失败 / 跑不起来 | 本文 §5 |
| 未决项与已知边界 | 本文 §7 |

---

## 1. 架构一句话

**推理全部交给 llama.cpp 的 llama-server**：GUI 不实现进程池 / LRU / 自动加载，只做「版本发现 + 模型扫描 +
配置编辑 + 进程调度 + 日志 + 观测 + 聊天前端」。

**统一入口是「前门」**（`src-tauri/src/strata_proxy.rs`，默认 `127.0.0.1:9090`）：一个端口挂全部模型 config，
按请求体里的 `model` 停旧起新并转发；`/v1/models` 与「没有引擎时的 `/health`」由它合成。
llama.cpp 的 router mode 已于 2026-10-15 退役（`router.rs` → `logs.rs`），`presets.ini` 由**一个模型一份 JSON**取代。

**另有第二条并列运行时 Strata**：引擎在 `E:\AI\Strata`，config 是 `strata-*.json`，通过一组 `strata_*` 命令接入，
与前门共用同一套进程管理 / 端口顺延 / 日志采集 / 非 ASCII 修复 / 压测基础设施；它**不是** llama.cpp 的 router（见 §2.11）。

- 后端 Rust / Tauri 2：只提供**系统能力**（进程、文件、设置、注册表、子进程）。
- 前端 React 19 + TS + Vite：模型列表、加载/卸载、详情、聊天、监控都由 webview **直连前门 / 各引擎的 HTTP + SSE**（没有自建网关，没有 `/api/*` 层）。
- 推论：**前端出现 401 / Failed to fetch，多半是鉴权或前门没起来**，不是后端命令的问题。

### 1.1 代码地图

| 位置 | 职责 | 备注 |
|------|------|------|
| `src-tauri/src/lib.rs` | Tauri 命令与事件注册、后台扫描调度、配置命令编排、退出清理 | 改了命令要同步 `src/ipc.ts` |
| `src-tauri/src/logs.rs` | 日志环形缓冲 `LogHub`/`LogLine`、批推 `spawn_pump`、落盘（一次运行一个文件）、进程工具 `force_kill_tree`/`redact_args` | 原 `router.rs`（2026-10-15 改名） |
| `src-tauri/src/settings.rs` | `settings.json` 读写；`Settings` / `SettingsPatch` / `SettingsStore` | 加字段两个结构都要改（§6.1） |
| `src-tauri/src/versions.rs` | 版本扫描（两种目录布局）、`--help` 探测并缓存、共享 CUDA 目录匹配、`PATH` 合成 | |
| `src-tauri/src/models.rs` | 模型递归扫描、GGUF 元数据缓存、辅助文件（mmproj / 草稿）识别 | |
| `src-tauri/src/model_config.rs` | **一个模型一份 JSON**（`config\llamacpp-<id>.json`）：读写、原子写、失效配置归档 | 规格见 `PROXY_SCHEDULER_PLAN.md` §3.1 |
| `src-tauri/src/scheduler.rs` | 进程表 + 容量闸（`models_max`）、`build_model_args`（容器字段拼在参数前面，并默认补 `--metrics`） | |
| `src-tauri/src/paths.rs` | 配置目录解析：便携目录（exe 同目录）/ 回退 `%APPDATA%`、webview 数据目录 | dev 恒用 `%APPDATA%`（§6） |
| `src-tauri/src/gpu.rs` | `--list-devices` 枚举与校验、显存预估 | 默认全空 = 交给原生 `--fit` |
| `src-tauri/src/bench.rs` | API 压测（Rust 侧并发）+ 记录落盘 + 硬件信息 | webview 同主机约 6 连接上限 |
| `src-tauri/src/http.rs` | 极简本机 HTTP 客户端（裸 TcpStream，无第三方依赖） | 非 2xx 时把 JSON 的 `error.message` 提成错误文本 |
| `src-tauri/src/idle.rs` | 常驻线程（2 s 一轮）：把「`Ready` + 无请求在转发 + 空闲超阈值」的模型 `stop` 掉 | 每轮实时读设置；§2.3 |
| `src-tauri/src/winfix.rs` | 非 ASCII 路径的 `mklink /J`、端口探测、`CREATE_NO_WINDOW`、`no_throttle`（子进程脱离宿主 Job Object） | 子进程一律走 `hide_console` |
| `src-tauri/src/strata.rs` | Strata 通道：config 扫描 / 校验 / 原子写、引擎启停与崩溃监测、`/load`·`/unload` 转发、根目录与控制器/引擎版本解析与切换 | §2.11 |
| `src-tauri/src/strata_proxy.rs` | **前门代理**：一端口挂全部 config，按 `model` 停旧起新并转发；合成 `/v1/models` 与 `/health` | §2.11「前门的两条硬约束」 |
| `src-tauri/src/strata_tune.rs` | **参数调优**：`strata.py tune auto` 长任务 + `--status-file` 进度 + 中文翻译；`apply_overlay` 把结果写进 config 的 `args`，记录落 `<根>\tune-records\<slug>.json` | §2.11 |
| `src-tauri/src/strata_upgrade.rs` | **升级控制器/引擎**：只驱动 `strata.py update`，把 jsonl 事件翻成进度；`--check` 先问「已是最新」 | §2.11 |
| `src-tauri/src/strata_launch.rs` | **launch 预设对齐**：读 `%APPDATA%\Strata\launch-presets\*.json`，启动前用控制端 `Runner.build_config` 重生成 `launch\<slug>.json` | §2.11 |
| `src-tauri/src/strata_download.rs` | **模型下载**：起 `setup.py --family/--model/--context/--vision/--images/--yes/--no-start`，按 `\r` 切行解析进度、磁盘预检（`GetDiskFreeSpaceExW`）、`HostInfo`、`scan_gguf`、`check_mtp` | 单槽 `AppState.strata_download` |
| `src-tauri/src/strata_community.rs` | **社区目录**：`curl.exe` 拉 HF 镜像 `/api/models?search=` + `/tree/<sha>`，按分片名还原量化与家族，24 h 缓存 `%APPDATA%\llamacpp-gui\community-cache.json` | 默认镜像 `https://hf-mirror.com`；CSP 不含外部域，必须走后端 |
| `src-tauri/src/strata_orca.rs` | **ORCA 导入**：两分片（85.2 GB）`curl -C -` → `tools/iq_pack.py --gguf <shard1> --out <pack> --compat-bf16` → 写 `strata-orca-iq3_xxs.json` | 与 `strata_download` 分开槽位 |
| `src-tauri/src/monitor.rs` | 硬件与引擎指标采集：sysinfo + NVML（显存 / PCIe）+ PDH（磁盘）+ 引擎 `/metrics` 解析 | |
| `src-tauri/src/search.rs` | 联网搜索五引擎（anysearch / tavily / firecrawl / keenable / exa）+ `search.json` + `web_fetch` 正文抓取；HTTP 走系统 `curl.exe`（本机 schannel 不可用，不引 reqwest） | `WEB_SEARCH_PLAN.md` |
| `src-tauri/src/mcp.rs` | **MCP 客户端**：`mcp.json` 清单，stdio + NDJSON 拉子进程，`initialize` / `tools/list` / `tools/call`，工具名 `mcp__<服务器>__<工具>` | 保存配置或退出时 `stop_all()` |
| `src-tauri/src/state.rs` | `AppState`：配置目录、调度器表、日志环形缓冲、扫描与元数据缓存、启动互斥、托盘标志、`strata_download` / `strata_orca` 槽位 | 缓存 TTL 与前端轮询同周期时命中率≈0 |
| `src-tauri/src/tray.rs` / `tray_icon.rs` | 托盘菜单与 RGBA 图标常量（`scripts/make-icons.mjs` 生成） | 托盘不直接调后端，把命令转给前端 |
| `src/store.ts` | zustand 全局状态：设置、模型、前门状态、聊天与工具编排、通知 | 业务编排几乎都在这里 |
| `src/api/router.ts` | 前门 / 各引擎的 HTTP + SSE 客户端（**唯一**带鉴权的地方） | §2.4 |
| `src/api/chat.ts` | 聊天 SSE 流（`streamChatTurn`），走前门 `/v1/chat/completions` | |
| `src/utils/models.ts` | 扫描结果 ↔ 运行态合并、过滤排序（纯逻辑） | 组件文件只导出组件 |
| `src/utils/paramSchema.ts` | 参数表 schema 与表单状态换算（纯数据） | |
| `src/utils/strataParams.ts` | `strata-*.json` 的 `args` ↔ 表单状态换算与参数 schema | 新增参数的唯一落点 |
| `src/utils/modelCatalog.ts` | 官方模型目录快照（`MODEL_CATALOG` 七族）+ 版本闸门 + 上下文预设 | 照搬上游 `packages/core/src/catalog.ts` |
| `src/utils/modelPerformance.ts` | 速度 / 首字延迟估算表（上游 `model-performance.ts` 的实测数据） | 按家族 + 量化 + 硬件查表 |
| `src/utils/communityCatalog.ts` | 社区内置三条 + `mergeCommunityModels` + 风险与类型中文标签 | 发现结果来自 `strata_community_discover` |
| `src/utils/tools.ts` | 聊天工具定义（`web_search` / `web_fetch` / `mcp__*`）与工具调用片段合并 | 执行在 `store.ts::sendChat` |
| `src/components/ParamForm.tsx` | 参数表单控件（下拉、路径选择、JSON 编辑） | 下拉菜单用 portal |
| `src/components/ModelSheets.tsx` | 模型配置 / 详情弹窗；Strata 侧左栏是 config 原文（可编辑） | |
| `src/components/ModelDownloadPage.tsx` | **模型下载页**：官方 / 社区两档 + 本地 GGUF + ORCA 面板，四个弹窗 | 照搬上游同名页面结构与文案 |
| `src/components/StrataPanel.tsx` | Strata 页：卡片列表 + 配置 / 详情 Sheet | |
| `src/components/Sheet.tsx` | **唯一的通用弹窗** `Modal`（Esc / 遮罩 / × 都走 `confirmClose`） | 新弹窗一律复用 |
| `src/styles/tokens.css` | **样式真源**：`--st-*` token + 旧变量兼容别名 | 新样式只准用 `--st-*` |
| `src/styles/app.css` / `legacy/index.css` | 本应用补充样式 / 参照实现默认首页的 CSS 原样引用 | 改样式优先加在 `app.css` |
| `src/styles/css/all.min.css` | Font Awesome 6.4.0（图标真源）+ `src/styles/webfonts/` | 2026-10-15 按用户否决恢复 |

---

## 2. llama.cpp 行为约束（**实测事实，不要凭直觉改代码**）

每一条都对应某次真实故障；违反它就是出 bug，不是"可能有问题"。

### 2.1 一个模型一份 JSON = 模型 + 参数
`<配置目录>\config\llamacpp-<id>.json`：
- 顶层 `name` 是**请求用的模型名**（`/v1/chat/completions` 的 `model`、`/v1/models` 报的名字），`id` 是文件名主体。
- **参数以 llama.cpp 的参数名当顶层键写**（`"ctx-size": 4096`、`"flash-attn": "on"`、`"jinja": true`），不带 `--`；裸开关写 `true`，需要显式值的写字符串。旧格式的 `"args"` 数组**只读兼容**，写盘时自动升级成参数键（`model_config::args_to_params` / `params_to_args`）。
- 内存里仍是命令行数组（`ModelConfig.args`，`#[serde(skip)]`）：读入时由顶层参数键编译，写盘前再反编译（`ModelConfig::normalized` → `write`）。
- `args` / 参数键里**不含** `--port` / `--host` / `--model` / `--mmproj` —— 由 `scheduler::build_model_args` 拼在最前面；写盘时 `strip_reserved_args` 剥掉并打警告。
- 同一个键写两遍没有意义（llama.cpp 取第一个）。

### 2.2 容器字段由调度器统一拼，**绝不给子实例传 `--no-ui`**
- `--model` / `--mmproj` / `--host` / `--port` / `--api-key` / `--no-webui` 由 `scheduler::build_model_args` 拼在参数前面；参数键里再写会被覆盖、写盘时被剥掉。
- 缺 `--metrics` 时自动补 —— 监控页的请求数 / KV 占用 / 槽位速度全靠这个只读端点，未开时引擎返回 501 `This server does not support metrics endpoint`。
- **绝不能传 `--no-ui`** —— 它关掉的是该模型的 llama.cpp 自带聊天界面，而「开始聊天」打开的正是那个界面。反过来单个 config 里 `no_webui: true` 是**有意用法**，此时该卡片「聊天」入口被禁用是**预期行为**。

### 2.3 自动卸载模型：由前门（`idle.rs`）自己计时，不靠 `--sleep-idle-seconds`
- 原生 `--sleep-idle-seconds` 只 `destroy()` 权重 / context/KV / mmproj / 草稿，**子进程与 CUDA context 还在**。实机实测（610 MB Q8、单卡、`--sleep-idle-seconds 5`）：加载后 10158 MB → 休眠 156 MB → 卸载 0 MB —— 用户看到的「还剩 0.2 GB」就是这一段。**本应用不用这个参数**。
- `src-tauri/src/idle.rs` 是**常驻线程**（`lib.rs` setup 里挂一次，2 s 一轮）：每轮重读 `settings.sleep_idle_seconds`，`> 0` 时挑「`Ready` + `active == 0` + `now - last_used_ms >= 门槛`」的模型 `Scheduler::stop`（强杀进程树，显存归零），日志写 `[gui] 模型 <id> 空闲超过 <n> 秒，已卸载实例释放显存`。
- 判定用调度器自己的 `ModelRuntime::last_used_ms`（前门每次转发成功时 `touch`），不查引擎的休眠状态；下一次请求由 `scheduler::ensure_ready` 按需重拉（iq3 冷启约 69 s）。
- **被动探测不刷新「最后使用时间」**：`/props`、`/slots`、`/metrics`、`/v1/health` 转发成功也**不** `touch`（`strata_proxy.rs::serve_llama` 里按 `is_passive_probe` 判断）。否则监控页每 2 秒轮询一次，空闲卸载永远等不到 —— 请求数照记，只是不算「在用」。
- 线程常驻且每轮重读设置 ⇒ 改完保存即生效，不用重启前门或程序。正在生成（`active > 0`）不打断，`Starting` / `Stopping` 不动。
- 容量上限 `settings.models_max`（默认 4）由 scheduler 的容量闸执行：满了先卸最久未用的（`last_used_ms`）。
- 前门合成的 `/models` 不报 `sleeping`，所以 llama.cpp 通道不会出现「休眠」胶囊（Strata 通道的 `sleeping` 是引擎自己报的）。

### 2.4 鉴权：配了 key 之后，除 `/health` 外全要鉴权
- 只认请求头：`Authorization: Bearer <key>` 或 `x-api-key: <key>`；**`?api_key=` 一律 401**。
- 因此 **`EventSource` 用不了**，SSE 一律 `fetch` 流式读取（`src/api/router.ts`）。
- 清空 key 后各 config 里必须**没有** `--api-key`，否则子实例仍要鉴权而界面按"没有 key"发请求 → 全 401（`cleared_api_key_leaves_no_flag` 测试守着）。前门**不代补 key**。
- CORS 实测：`OPTIONS` 预检 200 且 `access-control-allow-headers: *`，webview 里带自定义 `authorization` 头是允许的。

### 2.5 「刷新模型」= 重扫 `config\*.json`
前门与界面都从 `config\llamacpp-*.json` 读模型清单；新增 / 删除 / 改名后必须重扫（`models_scan` + 前端 `models://scanned`），否则就是"已删除的模型还在""新模型刷不出来"。保存单个模型配置后同样要重扫。

### 2.6 参数会被上游淘汰：`no-mmap` → `--load-mode`
llama.cpp **b11065 删掉了 `--no-mmap`**（替代品 `--load-mode`）。config 里残留的后果不是"参数失效"，而是**该模型子实例起不来**：`option 'no-mmap' not recognized`。
- 处理：`models.rs::RETIRED_PRESET_KEYS = ["no-mmap"]`，`model_config::sanitize_config` 加载时逐条丢弃（独立形式连值一起吃掉，不迁移），只在真改过时才写盘；`ModelSheets.tsx::RETIRED_KEYS` 让淘汰键不出现在弹窗里。
- **升级 llama.cpp 后模型起不来，第一件事查日志里有没有 `option '…' not recognized`**。

### 2.7 共享 CUDA 运行时：Windows 的 DLL 搜索**不递归**
必须把**直接包含** `cudart64_*.dll` / `cublas64_*.dll` 的目录注入子进程 `PATH`（指向父目录无效），由调度器拉起的子实例逐级继承。

### 2.8 非 ASCII 路径
llama.cpp 以 ANSI 语义传自身路径，含中文会让子实例 spawn 失败。应用用 `mklink /J` 建纯 ASCII 链接目录再启动（`winfix::ensure_ascii_dir`），状态里的 `ascii_fixed_from` 告知界面。

### 2.9 日志分流靠 `[%5d]` 前缀
子实例 stdout/stderr 合进同一条流，行首是 `[<端口>]`；不足 5 位渲染成 `[ 8081]`。分流前必须 `trim()`。

### 2.10 其它前端约束
- CSP 是 `connect-src … http://127.0.0.1:* http://localhost:*`：要连新域名得改 `src-tauri/tauri.conf.json`。
- webview 对同一主机的并发连接有上限（约 6），所以 API 压测的并发放在 Rust 侧。

### 2.11 Strata 不是 llama.cpp 的 router（第二条运行时通道）
Strata 的二进制不同名、没有 router mode，config 是 `strata-*.json`（数组形式的 `args`）。`versions.rs::scan_versions` 只认 `llama-server.exe`，`GET /models`、`POST /models/load|unload`、`GET /props`、`/models/sse` 在 Strata 上都不存在 —— 所以它是**并列的独立通道**（后端 `strata_*` 命令 + 前端 `StrataPanel.tsx`），llama.cpp 那条通道一行不改。

**配置写入**
- **校验 → 备份 → 原子写**，临时文件名唯一（`strata.rs::temp_config_path`），整段写路径持 `strata_lock()`；只在 rename 那一步加锁没用。
- **备份只留一份固定名 `<config>.json.bak`**（不要在名字里堆时间戳），与 `model_config::write_config`、`settings` 的 `.json.bak` 策略一致；`.bak` 被 `is_config_file` 排除。
- **`--vram-reserve-mib` 只认命令行**：`control\serve\server.py` 是 `reserve = int(args[...]) if "--vram-reserve-mib" in args else 700`，全文不读 config 顶层的 `vram_reserve_mib`（那是**安装器 `setup.py` 的记忆字段**，只有预置 UI 读它）。实测（sc117 iq2-xs、0.1.46）：每槽 ≈1.437 MiB，`700→512` 多 131 槽（3770 → 3901）；缺 `--kv-resident 30720` 时 KV 全驻显存，槽位掉到 2432。**手删这个参数必须连值一起删**，只删 flag 会变成 `--vision 782`，引擎打印用法后退出。
- **`sampling` 是顶层字段，不是 flag**：`temperature` / `top_p` / `top_k` / `min_p` 写在顶层 `sampling` 对象（`strataParams.ts` 的哨兵 `--sampling-*` **永不进 args**）。语义是「请求没带采样字段时的默认值」，改完要重启引擎。上游对坏值**直接拒绝启动**，所以保存前过 `validateStrataSampling`；块里不认识的键原样保留。

**启动与端口**
- **一个端口 = 一份 config = 一个引擎**：多份 config 写同一端口天然互斥，切模型必须先 `/unload` 旧模型（上游顺手保存 learned expert profile、立刻放显存）再杀进程树（`store.ts::startStrataModel`）。
- **端口上跑的是哪份 config，只认 `/health` 的 `model`**：按端口猜归属会把在跑的实例记到别的卡片上。`lib.rs::attribute_strata_hit` 反查（有单测），报错一律点名模型名。
- **卡片播放按钮 = 启动引擎 + `/load`**：只起引擎不 `/load` 的话 `/health.loaded=false`，卡片永远显示「已停止」。只有侧栏「启动 Strata」胶囊是纯启引擎（强制 `lazy_load: true`）。
- **卡片「停止」= 卸模型 + 停引擎（0.3.4 起，与 llama.cpp 档对齐）**：`store.ts::stopStrataModel` 先 `POST /unload`（上游优雅退出、保存 learned expert profile、立刻放显存），再对**本 GUI 启动的**（`running && !external`）实例调 `strata_stop` 收进程树；用户自己用 `run-<model>.bat` 起的实例不动 —— `lib.rs::strata_stop` 在槽位为空且快照 running 时报「……不是由本 GUI 启动的，请在它自己的控制台里停止」。**自动显存互斥是另一回事**：`startModel` 里腾地方时只 `/unload` 不停引擎（别把用户正开着的 WebUI 停掉），注释已钉住。`/unload` 与进程退出之间有窗口（`running=true / loaded=false`），按钮判据必须带 `loaded`（`StrataPanel.tsx::toggleOne`），只看 `runningFile` 会把「停止后再启动」当成又停止一次。
- **端口从 9091 起自动分配**：真正被绑定的是 `run-<slug>.bat` 的 `--port`，config 顶层 `port` 只是 GUI 连它用的元数据，不一致时 `spawn_strata` 直接 bail。`allocate_port` 找第一个「别的 config 没声明、系统也没占用」的端口（`STRATA_PORT_BASE = 9091`）；`set_port` **同时**写 config 与 bat（先 `.json.bak` 再原子写）；`strata_scan` 开头 `ensure_ports` 给「没定制过」的补端口（`port == 0` 与安装器默认的 `8080` 都算没定制）；`spawn_strata` 在「没配置」或「端口被占用」时现场重分配。`parse_config` 缺 `port` 返回 **0**（0 = 未分配），前端只在 `port > 0` 时显示。
- **归属信息（`config_path` / `model_name` / `pid` / `started_at_ms` / `port`）只能在「槽位为空」时清**：spawn 到端口监听之间、以及 `/load` 期间探测都会判「端口无响应」，而**探测失败不等于引擎没了**；曾无条件清 `config_path` ⇒ 卡片永远「已停止」而侧栏写着「引擎运行中」。三层堵法：`merge_strata_probe` 每次用槽位信息覆盖归属（`apply_owned_status`，有单测）、「无响应」分支在 `slot_owned` 时不动归属、`spawn_monitor` 在进程退出时把归属一起清掉；前端 `runningEntry` 在 `config_path` 缺失时退回按 `/health` 的模型名认。

**引擎与控制器**
- **引擎按文件找 + 认控制器组件目录；`exe` 支持 `component:strata-engine` 引用**：`engine_folders(root, extra)` 从安装目录自身及其一、二级子目录里找含 `engine-component.json` 或 `strata.exe` 的目录（官方放在 `components\engine\<版本>-…`，目录名不参与判断），再补控制器组件根（`STRATA_COMPONENTS_DIR`），按 `canonicalize` 去重。`parse_config` 对引用**只解析、绝不改写**；对绝对路径沿用「`settings.strata_engine` 权威 → 声明路径还在就尊重 → 没了才跟当前版本并写回」。`write_config_raw` **不**把引用展开成绝对路径。落盘形态由设置页选中项决定：选具体版本写绝对路径，选「自动使用最新版本」写 `component:strata-engine`。
- **`vision.exe` 一起同步**：改 `exe` 时把 `vision.exe` 也指到新版本目录的 `strata-vision.exe`（新目录没有就保留原值；写引用的不动），两处都走文本替换、其余字节不变。
- **列表只有一个版本时它必须是选中项**（只更新 settings、不动 config）；`StrataScanCache` 把设置里记的原始值记进缓存键（引用字符串也参与比较，否则「选自动」与「没选」都是 `None` 分不出来），换选择立刻重扫。
- **设置页选控制器 = 重写 bat 与 config 的控制器侧，绝不碰引擎**：`apply_controller(root, version)` 只动每份 `run-*.bat` 的「控制器侧」——解释器路径、`serve\server.py` 路径、`cd /d` 工作目录、`--config` 指向的 config 绝对路径，以及 config 顶层 `cwd` 与 `args` 里 `--expert-profile` 指向旧控制器 `data\` 的那条路径；引擎参数（`exe` / `vision.exe`）由「引擎版本」卡负责，反向亦然。为什么必须这样切：`serve\server.py` 的 argparse **没有**这类引擎参数且用 `parse_args`（未知参数直接退出），所以 bat 里只能出现 serve 侧参数。切换成功后记 `settings.strata_controller`、调 `configure_controller()`、重扫 config。`list_controllers` 同时认 `<根>\control\<版本>` 与 `<根>\terminal\<版本>`。
- **control 0.1.47 起控制端多一层版本子目录，`run-*.bat` 改成变量拼路径**：布局是 `control\active.json`（`{"version","folder"}`）+ `control\<folder>\{python,serve,setup.py,…}`，bat 里 `set "ROOT=…\control"` → `for /f` 读 `active.json` 的 `.folder` → `cd /d "%ROOT%\%VER%"`。GUI 不能执行 bat，所以 `strata::parse_run_script` 自己展开：`bat_vars` 收 `set "NAME=VALUE"`，`expand_bat_vars` 替换 `%NAME%`（大小写不敏感，认不出原样保留）；**cwd 取 `cd /d` 的目标**。`fallback_command` 依次试 `terminal\current` → `control\<active 的 folder>` → `control\` → `.venv`。
- **升级走控制端官方路径**：设置页两张版本卡各有一个「升级」，后端只做三件事 —— 定位解释器与 `strata.py`、执行 `strata.py update [--no-engine|--no-control] --components-dir <根> --output jsonl`、把事件翻成进度。**不要自己实现下载协议**：feed 是签名 JSON（内置公钥）、按显卡挑包、sha256 校验、试启动通过才切换、失败保留旧版。升级前先 `--check`，两侧都 `current` 就提示「已是最新」不下载。控制端需要可写 `<根>\.updates\`（它建 `update.lock`），所以真下载只能在 GUI 里跑。

**前门代理**
- `settings.strata_host` / `strata_port`（默认 `127.0.0.1:9090`）是 GUI **进程内**的代理监听。客户端只连它，它按请求体里的 `model` 停旧引擎、起新引擎 —— 切换全程持 `state.strata_switch` 串行化，并等旧端口释放（`strata::wait_port_free`，20 s）。设置页的前门地址/端口**只写 GUI 设置、不写 config**（写进去会把各模型的引擎端口覆盖成 9090）；`api_key` / `idle_unload_s` / `min_free_vram_mib` / `before_load` 仍逐份写 config。
- `GET /v1/models` 由前门合成（当前引擎那份 `loaded`、其余 `unloaded`，形状照抄上游）；没有引擎时 `GET /health` 也由前门合成；点名未知 `model` 一律 404 `model not found: {name}`。`lib.rs::strata_busy` **只算引擎槽位**（前门不占显存，算进来会让托盘的「启动服务」一开局就变灰）；`RunEvent::Exit` 与托盘 `quit` 都要关前门。
- **两条硬约束（改 `strata_proxy.rs` 前先读）**：
  1. **每条连接必须显式 `set_nonblocking(false)`**。监听套接字是非阻塞 accept + 30 ms 轮询，而 **Windows 上 `accept()` 返回的套接字会继承这个标志**：不转回来的话所有 `read` 在没数据时返回 `WouldBlock`（`os error 10035`），读头/读体会随机失败，客户端看到 RST。
  2. **绝不能在引擎生成期间向上游发 FIN（半关）**。上游 `_watch_client` 每 0.5 s `recv(1, MSG_PEEK) == b""` 就把「读到 EOF」判成**客户端挂断**并 `cancel.set()`，而取消只在提示读取的**分块边界**生效（块 8192 token）：症状是「小 prompt 侥幸成功、18859 token 的 prompt 在约 5.7 s 被取消」，日志 `0 generated ... (cancelled)`。所以前门**不挂**「客户端 → 引擎」的转发线程（请求体已由 `read_body` 整段读完、上游是 HTTP/1.0 + `Connection: close`），只做单向 `io::copy(上游 → 客户端)`。
- **前门服务状态回传给前端**：`StrataStatus.proxy_serving`（`state.strata_proxy_serving` 的 LIFO 栈 + `Serving` 守卫在 `Drop` 时摘掉并广播 `strata://status`），卡片据此在 **外部请求触发加载**时显示「加载中」。排查连接问题设 `STRATA_PROXY_DEBUG=1` 把逐连接轨迹写进 `%TEMP%\strata-proxy-debug.log`（默认关闭）。
- **两条运行时显存互斥**：启动一边的模型前先卸掉另一边（`settings.strata_router_mutex` 可关）。
- **WebUI 用系统浏览器打开**（`ipc.openLocalUrl`），不内嵌 iframe —— Strata 自带界面升级时不必跟着改 CSP。

**参数表与徽标**
- **卡片徽标的「支持 MTP」以 `args` 里带 `--mtp` 为准**（`StrataModelEntry.mtp` 只暴露 bool，路径不下沉 WebView，与 `has_api_key` 同口径）：`--mtp` 是安装器写下的安装事实（`STRATA_INSTALL_FACT_FLAGS`，GUI 只读、写回原样保留）。**不要改用模型名正则** —— 模型列表页那条 `/mtp/i.test(name)` 认的是文件名里带 MTP 的外挂草稿场景。`--spec` 是推测解码窗口，写 `0` 时徽标显示虚线压暗的「MTP 关」。
- **并发参数集中在「并发」组，默认全不配，且有依赖校验**：`--batch`（别名 `--slots`，2..8）、`--batch-mtp`、`--batch-groups`（默认 64，0 = off）、`--conversation-cache-mib`（默认 0）、`--conversation-cache-slots`（默认 4）。规则：`--batch-mtp` 需 `--batch` + `--mtp` + `--spec` 且不能与 `--batch-groups` 同开；`--batch-groups` 需 `--batch`；`--conversation-cache-slots` 需预算 > 0。`strataParams.ts::checkStrataParamEnable` 逐项判定，`validateStrataParams` 写盘前整组兜底（左栏 config 原文可绕过勾选）；`ParamForm` 的 `onBeforeToggle` 拒绝时开关不切换并就地显示原因。
- **引擎与它 spawn 的子进程都加 `CREATE_BREAKAWAY_FROM_JOB`**（`winfix::no_throttle`）：GUI 被后台化时子进程若继承宿主 Job Object 会被 CPU 节流，推理掉到个位数 t/s；父 Job 未开 `BREAKAWAY_OK` 时去掉该 flag 重试。

**参数调优**
- 「调优」是独立的长任务子进程：`python <终端>\strata.py tune auto <config> --mode quick|thorough --status-file <temp> --output json`，`quick ≈ 6 轮 15 分钟`、`thorough` 最长约 2 小时，进度从 `--status-file` 读（前端 1.5 s 轮询 `strata_tune_status`），stdout 另走日志（source `strata-tune`）。三条硬约束：① 调优期间 `strata_start_engine` 直接拒绝（两个引擎抢显存必崩）；② 取消/退出连进程树一起杀（`logs::force_kill_tree`），`RunEvent::Exit` 与托盘 `quit` 都要遍历停掉；③ **调优结果写进 config，不走预设**（`--no-save`）：跑完自动 `strata_tune_apply` → `apply_overlay` 读 `result.settings.args`，经 `args_to_argv` + `apply_args_to_config` 只替换这些 flag，由 `write_config_args` 做「校验 → `.json.bak` → 原子写」。
- 进度另同步一份到 `launch\<slug>.tune.json`（与 `strata launch` 同名同格式）；每次写入 config 的结果落 `<根>\tune-records\<slug>.json`，`strata_tune_history` 回读显示。控制端写的是英文，`zh_message` / `zh_stage` 在 Rust 侧翻译，认不出的原样透出。
- **预设叠加不再在 GUI 里出现**：`strata_preset_overlay` / `preset_detail` 与那张折叠卡全部删除，GUI 不读也不依赖 `presets\`。注意 `serve\server.py::apply_saved_tuning` 启动时仍会叠加**用户手工建过的**预设，GUI 不干预。

**launch 预设**
- 官方另有 `strata launch` 通道：读 `%APPDATA%\Strata\launch-presets\<slug>.json`（context / kv / vision / 卡 / extra 环境变量 / 端口 / key），用 `strata_cli.launch.runner.Runner.build_config` 派生 `launch\<slug>.json`。GUI 与它对齐：`strata_launch.rs` 按 `model_path` 认领（路径忽略大小写/斜杠），`spawn_strata` 里若有预设就**调控制端同一套 Python 代码**生成（不重写逻辑），把 `--config` / `--port` 换成 launch 配置的值，host / api_key 也取预设的。**生成结果与 `strata launch` 逐字节一致**（本机实测 `Compare-Object` 无差异）。有预设时**跳过**端口自动分配与 bat 端口一致性校验；生成失败只记日志、回退安装器配置。卡片加「launch 预设」徽标，参数弹窗顶部提示「端口/context/kv/视觉会被预设覆盖」。
- 保存 API Key 时一并写进全部 config 的顶层 `api_key`（`set_api_key_all`，字节级替换那一行、其余排版不动，清空写 `null`）、全部 launch 预设与已生成的 `launch\*.json`（`strata_launch::sync_keys`），否则 GUI 前门用 A、`strata launch` 用 B。

**模型下载 / 社区目录 / ORCA**
- 官方下载走 `setup.py`：非交互靠 `--yes`（`ask()` 直接返回默认值），进度行是 `label: x / y GB (n%)` 原地刷新（`\r`），必须按 `\r` 与 `\n` 切行解析。
- 社区目录与 ORCA 的下载都走系统 `curl.exe`（本机 schannel 不可用，不引 reqwest）；默认镜像 `https://hf-mirror.com`（本机直连 `huggingface.co` 实测 21 s 超时）。CSP 的 `connect-src` 不含外部域，所以发现与下载必须在后端。
- HF tree 接口的 `lfs.oid` 是**裸 64 位十六进制**（没有 `sha256:` 前缀），且 `mtp*` 文件与量化名同形 —— 分片/量化/家族的还原规则与上游 `community-catalog.ts` 完全一致，别"优化"。
- ORCA 打包用 `tools/iq_pack.py --gguf <shard1> --out <pack> --compat-bf16`（`--compat-bf16` 与 `--base` 互斥；它自己调 `strata_tokenizer.py` 导出 `tokenizer/`），成功后写 `strata-orca-iq3_xxs.json`。
- MTP 草稿层没有安装器参数：安装器只认 `<数据目录>\mtp\rt\experts.bin`，所以「选 MTP 目录」等价于把所选目录的父级当 `--data-dir` 传下去（`check_mtp` 的 `data_directory`）。

### 2.12 `/metrics` 自带实时吞吐 gauge，速度别只靠本地实测
- `--metrics` 下有两支 gauge：`llamacpp:predicted_tokens_seconds`（HELP "Average generation throughput in tokens/s"）与 `llamacpp:prompt_tokens_seconds`（"Average prompt throughput in tokens/s"）。实测 b11671 一次 24 token 的请求后分别是 `19.6849` / `70.6986`，**空闲时归 0** —— 是瞬时均值，不是累计值，别做差分。
- 想算区间均值再用累计对：`llamacpp:tokens_predicted_seconds_total` / `prompt_seconds_total` 与 `tokens_predicted_total` / `prompt_tokens_total`。
- GUI 起的实例由 `scheduler.rs` 自动补 `--metrics`；用户自己起的实例没开时 `/metrics` 返回 501（`This server does not support metrics endpoint`），前端显示「这个实例没开 --metrics」提示而不是报错。
- **压测、模型自带 WebUI、其它 OpenAI 客户端的请求不经过 GUI 的 store**，本地 `lastTurn` 攒不出速度；只看 `lastTurn` 就会在压测期间显示空（0.3.4 前的 bug）。速度卡固定按「引擎 gauge → 本地实测」回落。
- `/slots` **没有速度字段**（只有 `n_ctx` / `is_processing` / `n_prompt_tokens` 这些），`normalizeSlots` 的 `speed` 对 llama.cpp 永远是 null，不要指望它。

---

## 3. 前端约定

### 3.1 状态与数据流
`store.ts` 是唯一编排点；组件只读 store、调 store 的动作。
- **API key 必须同步给 HTTP 层**：`useApp.subscribe` 里调 `setRouterApiKey(settings?.api_key)`，漏掉就是"设置里有 key、请求却 401"。
- **模型列表是三方合并**：扫描结果（`models_scan`）+ config 目录（`name` / `args`）+ 运行态（调度器表 / 前门 `/v1/models`），再叠加收藏与 Strata 条目；规则在 `utils/models.ts::mergeModels`。`settings.aliases` 是 router 时代残留（只减不增）。
- **启动即出列表**：先用 `models-scan-cache.json` 渲染，再后台重扫，只有结果真变了才发 `models://scanned`（stale-while-revalidate），该事件同时带 `aux_files`。
- **组件文件只导出组件**（工具函数抽到 `utils/`），否则 Fast Refresh 失效。
- **主窗口是「隐藏创建、首帧后显示」**：`tauri.conf.json` 的 main 窗口 `visible: false`，`src/main.tsx` 两帧后调 `ipc.appBootFinished()` 才 `show()`（WebView2 首帧前显示会「一块一块黑」）。配套：`--minimized` 自启动时后端忽略该调用、窗口留在托盘；上次最大化时不能在建窗阶段 `window.maximize()`（会把隐藏窗口顶出来），意图记进 `RESTORE_MAXIMIZED` 等显示后再应用。后端还有 4 秒兜底：前端崩在首帧前也会显示窗口。
- **监控页「上下文占用」的分母是上下文窗口**，不是 `/status.max_tokens`（那是本次请求的输出上限）。分母取 `normalizeSlots(engine.slots)[0].context`（= `/slots[].n_ctx`），没有槽位时退回 config 的 `max_context`；分子按状态取 `live.prompt_read` / `live.prompt_total + generated` / 最近一次请求的 `promptTokens`。
- **监控页「并行任务」卡只在真开了多槽位时出现**（`normalizeSlots(engine.slots).length > 1`）。
- **速度卡有两条来源，别只认 `lastTurn`**：① 引擎 `/metrics` 自报的 gauge（`llamacpp:predicted_tokens_seconds` / `prompt_tokens_seconds`，`monitor.rs::parse_prometheus` 挑成 `predictedTokS` / `promptTokS`，空闲时归 0，前端只在 `> 0` 时用）；② 本地 `lastTurn`（`buildLiveMetric`）。**压测、模型自带 WebUI、其它 OpenAI 客户端的请求不经过 GUI 的 store，只有 ① 能看到它们** —— 0.3.4 前只读 ②，于是压测期间两张速度卡全空（用户实测报告）。
- **「最近请求」表由两处写入**：`sendChat` 收尾与 `runContextBench` 的每条样本都写一行 `RecentTurn`（后者顺带更新 `lastTurn`）。`runScenarioBench` 只写 `lastTurn`（样本几十条，不占这张 12 行的表）。`refreshMonitor` 的 `tokS` / `prefillTokS` 两条线用同一个门控，要带 `contextBench.running` / `scenarioBench.running`，否则压测期间折线断在 `null`；空闲期不推值（否则折线是一条假水平线）。走自带 WebUI / 其它客户端的请求本来就不进这张表，空态文案已写明。
- **聊天页输入框右侧的模型下拉**列出**全部**模型，已加载的用绿色文字（`.composer-model__item.is-loaded`）。当前模型取值顺序：记住的选择 → 已加载里 id 排序第一个 → 上次聊天的模型 → 空（显示「请选择模型」）；`sendChat` 用同一套顺序，未加载时发送前先自动拉起。聊天历史默认收起。
- **编辑回退是纯前端改写历史**（照 Strata 0.1.52 `history.js`）：`utils/chatHistory.ts` 的 `rewindPlan` / `regeneratePlan` / `editAnswerPlan` / `branchConversation` 算「保留到哪条 + 回填什么草稿」，`store.rewindChat` / `regenerateReply` / `editAnswerText` 落盘，`undo` 存整份旧消息供撤销条还原。改完助手消息会打 `meta: "已编辑"` 并丢掉 `reasoning` / `tools` / `usage`。三个开关都在采样抽屉：`chatEdit`（整排操作按钮显隐）、`chatList`（左侧历史栏显隐）、`busyMode`。
- **生成中的发送三态（`busyMode`）**：`wait` 直接忽略、`queue` 把草稿挂进 `chat.pending`、`interrupt` 先 `chatAbort?.abort()` 再挂。排队的那一问在 `sendChat` 的 `finally` 里（`streaming:false` 之后）自动续发；失败或被打断也照发。
- **KaTeX 是自托管的懒加载脚本**：`public/vendor/katex/`（来自官方 0.1.52 的 `vendor/katex/dist`，含 20 个 woff2），由 `utils/katex.ts` 首次渲染公式时插 `<link>` + `<script>`。**不要改成 npm 包** —— katex 的 CSS 自带 `@font-face`，与样式规范冲突；渲染失败一律退回 `$…$` 原文，正文不能因此空掉。
- **html / svg 围栏预览是空 sandbox 的 iframe**（`utils/chatPreview.ts`）：`sandbox=""` + 文档内 CSP `default-src 'none'`，脚本、外链一律不放开，官方那套「一次性允许脚本」没有沿用。
- **高级回答字段只对 Strata 通道发**（`ChatAdvancedOptions.tsx` → `buildChatRequest` 的第 5 个参数 `strata`）：`response_format` / `logit_bias` / `stop` / `min_p` 一族 / `strata_prefix` / `experimental_speed_projection` / `strata_mcp` 都是 Strata 的扩展，llama.cpp 的 `/v1/chat/completions` 没有。开关在采样抽屉的「高级回答设置」折叠区，UI 照常显示但会按通道判断发不发。
- **`strata_prefix` 是服务端索引**：`{messages: n}` = 前 n 条消息当固定前缀；`{message: i, chars}` = 第 i 条消息的前 chars 个字符。索引按**实际发出去的 messages** 算（系统提示占 0 号位、出错/停掉的消息不发送），且文档之后必须还有一条提问。
- **共享采样走引擎自己的 `/settings`**（`api/strata.ts`）：`GET` 读 `shared`、`POST {defaults: {...}|null}` 写/取消。只有 Strata 通道且引擎在跑时可用（`strataStatus.port`）；老服务端没有这个端点就静默保持关着。
- **`strata_mcp` 与本地工具互斥**：交给引擎执行 MCP 时不能再带 `tools`，否则 `buildChatRequest` 直接报错（引擎会按它自己的 MCP 配置调工具）。
- **图片生成页（`ImagesPage.tsx`）只连 Strata 引擎**：`POST /v1/images/generations`（`serve/images.py`），一次请求引擎拉起一个 `sd-cli` 进程；需要运行配置里有 `images` 段（`setup --images`），否则服务端报「needs "images" section」。llama.cpp 没有这个端点，所以没加载 Strata 模型时页面只给提示。

### 3.2 通知与弹窗形态
- 通知走 `store.notice`，`App.tsx` 渲染成 toast：`.toast-icon` + `.toast-content`(`.toast-title` + `.toast-message`) + `.toast-close`；图标 `fa-check-circle` / `fa-exclamation-circle`。多行文本时标题取第一行、正文取其余。
- 通用弹窗是 `components/Sheet.tsx::Modal`（可选 `iconClass`、`domId`）；参照实现里按 id 作用域的样式靠 `domId` 命中。

### 3.3 UI 参照系（重要）
参照实现有两套：默认首页 `index.html` + `css/index.css`（用户实际看到的那套，**我们照搬这套**，`src/styles/legacy/index.css` 是原样引用），以及 `index-new.html` + `css/newui.css`（只有**性能测试**页参考它；**系统日志**页的日志卡片版式改照上游 strata-manager「任务与日志」页，来源过滤是标签、搜索在工具栏）。改界面前先确认参照哪一套；早期按 newui 复刻导致长期与用户看到的界面不一致。

### 3.4 三处「hub 遗留样式 / 原生控件」的坑
**① 小字号控件要自己压平行高。** legacy 的 `body { line-height: 1.6 }` 传给所有子元素，小字号控件不显式写行高时行框远高于字形（侧栏前门胶囊 12px 字号 + 19px 行框 + 内边距 = 31px 高，字形只占 12px；加 `line-height: 1` 并收窄内边距后 22px）。
**② `.mono` 自带 `min-height: 38px`**（hub 给日志行用的）。本应用把它当「等宽小字」用在提示行、表格单元格、侧栏版本号上，于是全被撑到 38px、文字贴顶 —— 侧栏「前门胶囊下方一片白」就是这个。已在 `app.css` 给 `.mono` 补 `min-height: 0`。
**③ 原生 `title` 不换行、不限宽。** 参数说明是整段中文，`title={desc}` 会横出 600px 的弹窗；照搬 hub 的做法：问号只挂 `onClick`，开一个说明弹窗（复用 `Sheet.tsx::Modal`，`pre-wrap` + `break-word`）。

### 3.5 文案与交互口味
简体中文、简洁；用户明确否定过的方向不要重提；改动前先说清楚"要改什么"。

---

## 4. 后端要点

- **扫描分组**：同目录内 `mmproj*` 归入该模型（多模态）；`*-000NN-of-000MM.gguf` 视为一个多分片模型；同目录多个主文件各自成模型；只有 mmproj 的目录不是模型。
- **辅助文件单独出表**：`scan_aux_files` 返回 `aux_files`（mmproj / 草稿模型），供配置弹窗直接选。`is_gguf` **只看扩展名**（没有扩展名的文件本就不该被当模型）；文件名含 `draft` 的文件只有在同目录存在真实主模型时才按草稿处理。
- **config 写入最小化**：`upsert_entries_in_dir` / `entries_from_config` / `apply_entries` 只动涉及的键；用户手写的未知键、`args` 里不认识的 flag 原样保留；清空某项 = 去掉该键。
- **失效配置归档 + 恢复**：config 的 `model` 指向的文件不在了 → 移入 `config\.orphan\`（`move_to_orphan`）；模型回来时按 id 接回（`restore_from_orphan`）。判据只有"文件不在"；所有配置都失效（≥3）时判为"模型盘没挂上"，跳过清理只提示。
- **多模态开关**：config 顶层 `mmproj` 字段（拼成 `--mmproj`）；留空 = 不用视觉，关掉时顺手清掉手填的投影路径。
- **启动时序两个坑**：① 必须**先接上 stdout/stderr 读取、再等端口就绪**（Windows 匿名管道约 4KB，写满会卡住子进程、永远不监听）；② 任何启动失败分支都要**先杀掉子进程**，否则句柄没进调度器表，界面再也停不掉它。
- **停止不能直接 `wait()`**：kill 失败时会无限阻塞；改为限时轮询 + `taskkill /T /F` 兜底。
- **日志里给 `--api-key` 打码**（`redact_args`）。

---

## 5. 构建、测试、验证

```powershell
npm install                        # 受限沙箱里需要 --ignore-scripts
npm run cargo:proxy                # 另开终端保持运行：本机 crates 代理 http://127.0.0.1:8787
npx tsc --noEmit                   # 前端类型检查（仓库根）
cd src-tauri; cargo test --lib      # 后端单测（0.3.4 基线 175 passed / 18 ignored）
npm test                           # test:web + test:rs
npm run tauri build                # 打包（exe + NSIS 安装包）
node scripts/make-icons.mjs        # 重新生成全部图标资产
```

- **cargo 要走本机代理**：本机 Windows 原生 TLS（schannel）不可用（`SEC_E_NO_CREDENTIALS`），`.cargo/config.toml` 已把 `crates-io` 指向 `127.0.0.1:8787`；没开代理就是 `Could not connect to server`。
- **沙箱限制**：命名管道被禁 → esbuild 报 `spawn EPERM`，打包需要更宽权限；**GUI 运行验证必须在沙箱外**（WebView2 渲染进程走命名管道）。
- **构建/测试都要把 `TEMP`/`TMP` 指进工作区**（只提权不够）：

  ```powershell
  $env:TEMP='E:\Code\llama.cpp-GUI\.tmp-build'; $env:TMP=$env:TEMP; npm run tauri build
  ```

  否则前端 `88 modules transformed` 之后报 `[vite:esbuild-transpile] remove C:\Users\…\Temp\esbuild-<hash>: Access is denied.`，cargo 测试里大量写临时文件的用例会以 `Os { code: 5, kind: PermissionDenied }` 失败（**那是环境问题，不是代码缺陷**，本仓库曾因此误判 48 个失败用例）。
- **提权被拒绝就不要重试同一个命令**，换做法或先问用户。
- **CI 与发布门禁**：`.github/workflows/ci.yml` 跑 `npm run build`（含 tsc）+ `test:rs` + `test:smoke`；`release.yml` 打 tag 时校验 **tag 与 `tauri.conf.json` / `package.json` / `Cargo.toml` / `Cargo.lock` 四处版本一致**（0.3.4 起；以前只比 `tauri.conf.json`，其余三处漂了也照样发版）。CI 目前**不跑** `cargo fmt --check` / `clippy` —— 存量 42 条 clippy 警告，清完再加这一道。
- **换图标后必须删 `src-tauri\target\release\build\llamacpp-gui-*` 与 `.fingerprint/llamacpp-gui-*` 再构建**（`tauri-build` 不监听 `icons/*`；不删的话 exe 在原路径上仍是旧图标）。
- 只想看真实扫描结果：`cargo test --lib real_environment_model_scan -- --ignored --nocapture`。
- **磁盘占用**：`target/` 是唯一膨胀源。`Cargo.toml` 已做三项控制：`[lib] crate-type = ["rlib"]`、`[profile.dev] debug = "line-tables-only"` + `[profile.dev.package."*"] debug = false`、release 的 `lto + opt-level="s" + strip`。腾空间直接删 `src-tauri/target/debug`。
- **别把缓存放进仓库**：`$env:CARGO_HOME=<仓库>\.cargo-home` 会让一次完整构建在仓库内堆 ~780 MB。

### 5.1 `tmp/` 里的验证资产（非交付物）
| 脚本 / 目录 | 用途 |
|---|---|
| `tmp/mcp-echo-server.mjs` | 最小 MCP stdio 服务器：`cargo test --lib echo_server_roundtrip -- --ignored --nocapture` 用它跑端到端 |
| `scripts/smoke-paramform.mjs` | 参数表单冒烟（真实 React 渲染 `ParamForm`，需 esbuild） |
| `tmp/temp/` | 构建时把 `TEMP`/`TMP` 指到这里 |
| `tmp/as/` | AnySearch 官方文档与 `/v1/extract` 响应样本 |

联网相关的端到端用例都是 `#[ignore]`，要联网时手动跑。

---

## 6. 运行时数据文件

**便携目录 = exe 所在目录**（`src-tauri/src/paths.rs`）：发布版优先把配置写在 exe 旁边，装到不可写位置时自动退回 `%APPDATA%\dev.llamacpp.gui\`；dev 构建（`tauri dev` / `cargo test`）**永远**用 `%APPDATA%`。便携目录会写进「系统日志」：`[gui] 便携模式：配置目录 …`。旧版本的 `%APPDATA%` 数据**不再自动搬运**（2026-09-22 移除）。

| 文件 | 内容 | 注意 |
|---|---|---|
| `settings.json` | 全部用户设置（§6.1） | 未知字段保留（`Settings.extra`）；读失败时本次启动只读 |
| `config/llamacpp-<id>.json` | **一个模型一份配置**（§2.1） | 失效的移到 `config/.orphan/` |
| `mcp.json` | MCP 服务器清单（`command`/`args`/`env`/`enabled`） | 保存即重启全部 MCP 子进程 |
| `search.json` | 联网搜索 `keys` / `order` / `blockedDomains` / `timeRange` / `maxResults` | `order` 就是启用清单 |
| `models-scan-cache.json` | 上次扫描结果（启动先渲染） | 按 `model_roots` 校验，换根目录即作废 |
| `gguf-meta-cache.json` | gguf 元数据缓存 | 版本不符自动忽略 |
| `logs/` | 每次运行一个 `gui-<启动时间>.log` | 超 8 MB 分卷，只留最近 12 个 |
| `runtime/` | 非 ASCII 路径的 `mklink /J` 链接目录 | |
| `bench/records.json` + `bench/*.txt` | 压测记录与导出文本 | |
| `webview/EBWebView/` | WebView2 数据（localStorage 偏好 + 浏览器缓存） | 删掉只丢 UI 偏好 |

> **webview 数据也在便携目录**：Windows 下 Tauri 默认把 webview 的 data directory 钉在 `%LOCALAPPDATA%\<identifier>`，而配置项 `app.windows[].dataDirectory` 只支持"相对 appDataDir" 的路径。所以 main 窗口在 `tauri.conf.json` 里 `"create": false`，由 `lib.rs::create_main_window` 建并调 `data_directory()` 指到 `webview/` —— 参数必须在建窗**之前**定下来（WebView2 一旦把环境建在某个目录就改不动）。
>
> **卸载时问一句**：`src-tauri/nsis/hooks.nsh` 在 `PREUNINSTALL` 弹窗问"是否同时删除用户数据"，真正删除放在 `POSTUNINSTALL`（模板在那之后才 `CheckIfAppIsRunning`，先删会有一堆文件被 `EBWebView` 占着删不掉）。选"否"数据原样留在安装目录，重装同目录即可继续用。

### 6.1 `settings.json` 字段（当前实现）
llama.cpp 侧：`llama_cpp_dir`、`model_roots[]`、`shared_lib_dirs[]`、`selected_version`、`port`(8080，**前门端口**)、`models_max`(4)、`sleep_idle_seconds`(-1)、`api_key`、`gpu{devices[], split_mode, tensor_split, main_gpu, fit, fit_target, n_gpu_layers}`、`autostart`、`minimize_to_tray`(true)、`auto_start_router`(true)、`favourites[]`、`aliases{}`（router 残留，只减不增）、`view{mode, density}`、`window{width,height,x,y,maximized}`、`version_cache{}`。
Strata 侧：`strata_root`、`strata_controller`、`strata_auto_controller`(true)、`strata_auto_engine`(true)、`strata_selected_config`、`auto_start_strata`、`strata_router_mutex`、`strata_host`、`strata_port`、`strata_api_key`、`strata_idle_unload_s`、`strata_min_free_vram_mib`、`strata_before_load`、`strata_engine`。

- **Strata 根目录是设置项**：`strata::root()` 返回它（空则推导 `%LOCALAPPDATA%\Strata`），所有模块都用 `root()`；`configure_root()` / `configure_controller()` 维护全局值，`settings_set` 应用 patch 后立即刷新。手动解压布局是 `<根>\control\<版本>` + `<根>\engine\<版本>-<平台>-<后端>`，config 与 `run-*.bat` 直接在根下；官方布局是 `<根>\install` + `terminal\<版本>` + `components\engine\<版本>-<平台>-<后端>`，两种都认。
- 数据目录（模型 / packs / profiles / mtp）**不由 GUI 读写**：`%APPDATA%\Strata\settings.json` 的 `data_dir` 是安装器的事（模型下载页的「下载目录」例外，它作为 `--data-dir` 传给 `setup.py`）。
- `SettingsPatch` 是命令入参的白名单：**加设置项要同时改 `Settings` 与 `SettingsPatch`**，否则保存后不落盘。

---

## 7. 未决项与已知边界

**未决项**：
0. **模型下载页的四条链路只验证到「能起、能解析、能生成配置」，没跑过真流量**：官方 `setup.py` 下载、社区分片下载、ORCA 的 `iq_pack.py --compat-bf16` 打包（85.2 GB 输入、十几分钟）、本地 GGUF 打包，都需要在 GUI 里实际点一次并盯日志。两个外部依赖：社区目录默认打 `https://hf-mirror.com`（本机直连 huggingface.co 21 s 超时），ORCA 分片也走同一镜像；换源在页面「下载配置」里填 HF 镜像。ORCA 打包失败先看 `iq_pack.py` 退出码，再核对 `tools/iq_pack.py` 是否支持 `--compat-bf16`（0.1.52 支持）。
1. **Strata 引擎在显存耗尽后会卡死，不是 GUI 的 bug**：反复打大 prompt 后 `/status` 长挂 `phase=reading the prompt`/`thinking`、`elapsed_s` 一直涨、`tokens_per_s` 掉到个位数，此后**所有**请求（连 `curl` 直连引擎端口）要么空回复、要么只收到 236–428 B 就被断开，日志报 `0 MiB of VRAM free with everything loaded - LOW …`。处置：杀掉 python 进程树，前门会在下一个请求冷启动新引擎。本机 2026-10-11 按引擎自报值定稿：三份 config 统一 `--kv-resident 30720`，`--vram-reserve-mib` 两份 512、`swift-1.5-iq3_xxs` 不传（引擎默认 700 MiB）。显存账见 `STRATA_INTEGRATION_PLAN.md` §22.10。

**已知边界**（现状如此，不是缺陷）：
2. **纯前端渲染的页面 `web_fetch` 抓不到正文**：不跑 JS，SPA 站点只能拿到几百字符占位，模型只能吃搜索摘要。
3. **聊天历史受 localStorage 配额限制**：`CHAT_CONVERSATION_LIMIT = 30`、`CHAT_MESSAGE_LIMIT = 200`、`TOOL_RESULT_KEEP = 2_000`（`src/store.ts`）。`web_fetch` 单页最多 1.2 万字符，落盘时按 `TOOL_RESULT_KEEP` 截断 —— 不截断会把约 5 MB 配额写满，设置与主题随后静默存不进去。
4. **`models_max = 1` 时每次换模型都要停旧起新**：切模型有 3–6 秒冷启动，不是卡住；要并行驻留就调大 `models_max`。

---

## 8. 新会话怎么获得上下文

1. 先读本文件（§2 的约束、§7 的未决项），再按需要看 `README.md`；逐轮实现细节与历史决策在 `docs/archive/`。
2. 会话之间不会自动继承上下文：把结论写进仓库文档（推荐），或在新会话用 `@` 引用旧会话（只得到有界只读快照）。
3. 改代码前后请遵守：先 `npx tsc --noEmit` + `cargo test --lib`；涉及 llama.cpp 行为的改动，先看 §2 有没有相反结论，再考虑补一个把该行为钉住的单元测试。
