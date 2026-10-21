# 交接说明（HANDOVER）

> 面向**接手这个仓库的新会话 / 新维护者**。`README.md` 讲**能力**（有哪些功能、怎么装怎么跑），本文讲**怎么接手**：
> llama.cpp 行为约束（§2）、代码地图（§1.1）、前端约定（§3）、后端要点（§4）、构建与验证（§5）、
> 运行时数据文件（§6）、未决项（§7）。
>
> **逐轮实现日志与历史决策已归档**，本文只留现行结论：
> - `docs/archive/ITERATION_LOG.md` —— 0.1.x → 0.2.0 每次改动的起因、实测证据、踩过的坑（按原编号，行号已过时）
> - `docs/archive/DECISIONS-2026-10.md` —— 2026-10 的关键决策与落地结果
> - `docs/archive/` 里还有已落地的设计文档：`docs/archive/PROXY_SCHEDULER_PLAN.md`（前门与配置层规格）、`docs/archive/STRATA_INTEGRATION_PLAN.md`（Strata 通道）、`docs/archive/STRATA_MANAGER_PORT_ASSESSMENT.md`（聊天/监控/压测移植评估）、`docs/archive/WEB_SEARCH_PLAN.md`（五引擎搜索）、`docs/archive/UI_STYLE_BASELINE.md`（样式基座 S1–S8），以及 0.1.x 的历史存档（`docs/archive/REFACTORING_PLAN.md` / `docs/archive/REFACTORING_REVIEW.md` / `docs/archive/CODE_REVIEW.md`）
>
> 最后更新：2026-10-21（**Strata 参数表新增「并发」组 + 并发参数的依赖校验**）。验证基线：`cargo test --lib` **135 passed / 0 failed / 10 ignored**，`npx tsc --noEmit` exit 0，`npm run tauri build` 成功（`src-tauri\target\build149.log`）。
> 已部署 exe：`E:\AI\llama.cpp-gui\llamacpp-gui.exe`，10,503,168 B / 2026-10-21 17:31:38 / SHA256 前 16 `D6E9D79369544804`（build149：`--batch`/`--batch-mtp`/`--batch-groups`/`--conversation-cache-mib`/`--conversation-cache-slots` 收进「并发」组、默认全不配置、勾选时按引擎依赖拒绝并提示；上版 build148 备份为 `.bak-before-concurrency`）。
> 0.2.1 构建（2026-10-21 15:28）：`src-tauri\target\release\llamacpp-gui.exe`，10,502,656 B / SHA256 前 16 `4ABBE77E19D9989F`；安装包 `bundle\nsis\llama.cpp GUI_0.2.1_x64-setup.exe`（3,248,691 B）。这一版含聊天模型下拉改造（列全部模型 / 已加载绿色 / 未加载发送时自动拉起 / 三级默认值）与聊天历史默认收起。
> 版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` / `Cargo.lock` 统一为 **0.2.1**。

---

## 0. 三十秒定位

| 问题 | 去哪里看 |
|------|----------|
| 某功能的意图与做法 | `README.md`「当前进度」 |
| 前门调度与配置层规格 | `docs/archive/PROXY_SCHEDULER_PLAN.md` §10 决策、§3.1 配置规格 |
| Strata 通道的细节 | `docs/archive/STRATA_INTEGRATION_PLAN.md`（§22 起是逐轮实现记录） |
| 聊天 / 监控 / 压测的设计与取舍 | `docs/archive/STRATA_MANAGER_PORT_ASSESSMENT.md`、`docs/archive/WEB_SEARCH_PLAN.md` |
| 样式 token / 断点 / 图标映射 | `docs/archive/UI_STYLE_BASELINE.md`（铁律 8 是摘要） |
| 某次改动为什么这么改 | `docs/archive/ITERATION_LOG.md`（按编号或 build 号找） |
| 某个 llama.cpp 行为到底怎样 | 本文 §2（每条都来自真机实测） |
| 要改参数表单 / 模型配置弹窗 | 本文 §4 + `src/assets/params.json` + `src/components/ParamForm.tsx` / `ModelSheets.tsx` |
| 界面长得不对（与参照实现不一致） | 本文 §3.3（参照系是 hub 的**默认首页**那套，不是 newui） |
| 构建失败 / 跑不起来 | 本文 §5 |
| 未决项与已知边界 | 本文 §7 |

---

## 1. 架构一句话

**推理全部交给 llama.cpp 的 llama-server**：GUI 不实现进程池 / LRU / 自动加载，只做「版本发现 + 模型扫描 +
配置编辑 + 进程调度 + 日志 + 观测 + 聊天前端」。

**统一入口是「前门」**（`src-tauri/src/strata_proxy.rs`，默认 `127.0.0.1:9090`）：一个端口挂全部模型 config，
按请求体里的 `model` 停旧起新并转发；`/v1/models` 与「没有引擎时的 `/health`」由它合成。
llama.cpp 的 router mode 已于 2026-10-15 退役（`router.rs` → `logs.rs`），`presets.ini` 已由**一个模型一份 JSON**取代。

**另有第二条并列运行时 Strata**：引擎在 `E:\AI\Strata`，config 是 `strata-*.json`，通过一组 `strata_*` 命令接入，
与前门共用同一套进程管理 / 端口顺延 / 日志采集 / 非 ASCII 修复 / 压测基础设施；它**不是** llama.cpp 的 router（见 §2.11）。

- 后端 Rust / Tauri 2：只提供**系统能力**（进程、文件、设置、注册表、子进程）。
- 前端 React 19 + TS + Vite：模型列表、加载/卸载、详情、聊天、监控都由 webview **直连前门 / 各引擎的 HTTP + SSE**（没有自建网关，没有 `/api/*` 层）。
- 推论：**前端出现 401 / Failed to fetch，多半是鉴权或前门没起来**，不是后端命令的问题。

### 1.1 代码地图

| 位置 | 职责 | 备注 |
|------|------|------|
| `src-tauri/src/lib.rs` | Tauri 命令与事件注册、后台扫描调度、配置命令编排、退出清理 | 改了命令要同步 `src/ipc.ts`（1945 行） |
| `src-tauri/src/logs.rs` | 日志环形缓冲 `LogHub`/`LogLine`、批推 `spawn_pump`、落盘（一次运行一个文件）、进程工具 `force_kill_tree`/`redact_args` | **原 `router.rs`**（2026-10-15 改名，router 退役） |
| `src-tauri/src/settings.rs` | `settings.json` 读写；`Settings` / `SettingsPatch` / `SettingsStore` | 加字段要同时改这两个结构（见 §6.1） |
| `src-tauri/src/versions.rs` | 版本扫描（两种目录布局）、`--help` 探测并缓存、共享 CUDA 目录匹配、`PATH` 合成 | |
| `src-tauri/src/models.rs` | 模型递归扫描、GGUF 元数据缓存、hub 配置迁移、辅助文件（mmproj / 草稿）识别 | 1928 行 |
| `src-tauri/src/model_config.rs` | **一个模型一份 JSON**（`config\llamacpp-<id>.json`）：读写、原子写、ini 一次性迁移、失效配置归档 | 1406 行；规格见 `docs/archive/PROXY_SCHEDULER_PLAN.md` §3.1 |
| `src-tauri/src/scheduler.rs` | 进程表 + 容量闸（`models_max`）、`build_model_args`（`--model`/`--host`/`--port`/`--api-key` 等容器字段拼在 config `args` 前面，并默认补 `--metrics`） | 1176 行 |
| `src-tauri/src/paths.rs` | 配置目录解析：便携目录（exe 同目录）/ 回退 `%APPDATA%`、webview 数据目录 | 只有发布版走便携；dev 恒用 `%APPDATA%`，见 §6 |
| `src-tauri/src/gpu.rs` | `--list-devices` 枚举与校验、显存预估 | 默认全空 = 交给原生 `--fit` |
| `src-tauri/src/bench.rs` | API 压测（Rust 侧并发）+ 记录落盘 + 硬件信息 | 压测放后端是为绕开 webview 同主机 6 连接限制 |
| `src-tauri/src/http.rs` | 极简本机 HTTP 客户端（裸 TcpStream，无第三方依赖） | bench 与 idle 共用；非 2xx 时把 JSON 里的 `error.message` 提成错误文本 |
| `src-tauri/src/idle.rs` | 常驻线程（2 s 一轮，随程序启动挂一次）：把调度器表里「`Ready` + 没有请求在转发 + 空闲超过 `sleep_idle_seconds`」的模型 `Scheduler::stop` 掉 | 每轮实时读设置，保存即生效；见 §2.3 |
| `src-tauri/src/winfix.rs` | 非 ASCII 路径的 `mklink /J` 链接、端口探测、`CREATE_NO_WINDOW`、`no_throttle`（子进程脱离宿主 Job Object） | 子进程一律走 `hide_console` |
| `src-tauri/src/strata.rs` | Strata 第二运行时通道：config 扫描 / 校验 / 原子写、引擎启停与崩溃监测、`/load`·`/unload` 转发、`engine-bundle` 组件解析与多版本选择（`list_engines` / `set_engine`） | 见 §2.11；实现记录见 `docs/archive/STRATA_INTEGRATION_PLAN.md` |
| `src-tauri/src/strata_proxy.rs` | **前门代理**：一个端口挂全部 config，按请求体里的 `model` 停旧引擎 / 起新引擎并原样转发；`/v1/models` 与「没引擎时的 `/health`」由它合成；`StrataStatus.proxy_serving` 回传给卡片显示「加载中」 | 见 §2.11 末尾「前门的两条硬约束」（Windows accept 继承非阻塞、绝不能向上游发 FIN） |
| `src-tauri/src/monitor.rs` | 硬件与引擎指标采集：sysinfo + NVML（显存 / PCIe）+ PDH（磁盘）+ 引擎 `/metrics` 文本解析 | 1300 行；逐轮细节见 `docs/archive/ITERATION_LOG.md` §77 及监控各轮 |
| `src-tauri/src/search.rs` | 联网搜索五引擎（anysearch / tavily / firecrawl / keenable / exa）+ `search.json` + `web_fetch` 正文抓取（含 AnySearch `/v1/extract` 兜底）；HTTP 走系统 `curl.exe`（本机 schannel 不可用，不引 reqwest） | 2073 行；设计见 `docs/archive/WEB_SEARCH_PLAN.md` |
| `src-tauri/src/mcp.rs` | **MCP 客户端**：`mcp.json` 里的服务器清单，stdio + NDJSON 拉起子进程、`initialize` / `tools/list` / `tools/call`，工具名 `mcp__<服务器>__<工具>`，结果归一成文本 | 进程表全局缓存，保存配置或退出时 `stop_all()` |
| `src-tauri/src/state.rs` | `AppState`：配置目录、调度器表、日志环形缓冲、扫描与元数据缓存、启动互斥、托盘可用标志 | 缓存的 TTL 若与前端轮询同周期，命中率≈0 |
| `src-tauri/src/tray.rs` / `tray_icon.rs` | 托盘菜单与 RGBA 图标常量（由 `scripts/make-icons.mjs` 生成） | 托盘不直接调后端，把命令转给前端 |
| `src/store.ts` | zustand 全局状态：设置、模型、前门状态、聊天与工具编排、通知 | 2981 行，业务编排几乎都在这里 |
| `src/api/router.ts` | 前门 / 各引擎的 HTTP + SSE 客户端（**唯一**带鉴权的地方） | 见 §2.4 |
| `src/api/chat.ts` | 聊天 SSE 流（`streamChatTurn`），走前门 `/v1/chat/completions` | |
| `src/utils/models.ts` | 扫描结果 ↔ 运行态合并、过滤排序（纯逻辑） | 组件文件只导出组件（Fast Refresh 规则） |
| `src/utils/paramSchema.ts` | 参数表 schema 与表单状态换算（纯数据） | |
| `src/utils/strataParams.ts` | `strata-*.json` 的 `args` ↔ 表单状态换算与参数 schema（纯逻辑） | 新增参数的唯一落点 |
| `src/utils/tools.ts` | 聊天工具定义：`web_search` / `web_fetch` / `mcp__*`，以及工具调用片段合并与文案 | 执行在 `store.ts::sendChat` 的 `runTool` |
| `src/components/ParamForm.tsx` | 参数表单控件（下拉、路径选择、JSON 编辑） | |
| `src/components/ModelSheets.tsx` | 模型配置 / 详情弹窗；llama.cpp 侧左栏是「模型别名 + 模型 id」，Strata 侧左栏是 config 原文（可编辑，双向映射右栏参数） | 878 行 |
| `src/components/StrataPanel.tsx` | Strata 页：卡片列表 + 配置 / 详情 Sheet | 854 行 |
| `src/components/SettingsPanel.tsx` | 设置页（「服务 / 通用」两组） | 「服务」组共用一个「保存」 |
| `src/components/ChatPanel.tsx` 等 | 聊天页：消息区、输入框、工具卡片、采样设置、搜索与 MCP 设置 | |
| `src/components/MonitoringPage.tsx` 等 | 监控页：指标卡 + 上下文环 + 最近请求 | 897 行 |
| `src/styles/tokens.css` | **样式真源**：上游 `--st-*` token 全量照抄 + 旧变量兼容别名层 | 138 行；新样式只准用 `--st-*`，旧别名只减不增 |
| `src/styles/legacy/index.css` | 参照实现默认首页的 CSS 原样引用 | 4240 行；改样式优先加在 `src/styles/app.css` |
| `src/styles/app.css` | 本应用补充样式（含监控页、聊天页） | 1610 行 |
| `src/styles/css/all.min.css` | Font Awesome 6.4.0（图标真源，`src/main.tsx` 引入）+ `src/styles/webfonts/` 4 个字体文件 | 102,025 B + 353,556 B；**S4 曾退役、2026-10-15 已按用户否决恢复** |

---

## 2. llama.cpp 行为约束（**实测事实，不要凭直觉改代码**）

每一条都对应某次真实故障；违反它就是出 bug，不是"可能有问题"。

### 2.1 一个模型一份 JSON = 模型 + 参数
`<exe 目录>\config\llamacpp-<id>.json`（便携配置时是 `<配置目录>\config\`）：
- 顶层 `name` 是**请求用的模型名**（`/v1/chat/completions` 的 `model` 字段、`/v1/models` 里报的名字），`id` 是文件名主体。
- `args` 是该子实例的启动参数，**不含** `--port` / `--host` / `--model` / `--mmproj` —— 这些由 `scheduler::build_model_args` 按容器字段拼在最前面。
- `args` 里同一个键写两遍没有意义（llama.cpp 取第一个），界面写回时保留原写法不重复追加。
- 前端发请求用的 id 必须是 config 的 `name`，不是扫描出来的目录 id；迁移后两者一致。

### 2.2 容器字段由调度器统一拼，**绝不给子实例传 `--no-ui`**
- `--model` / `--mmproj` / `--host` / `--port` / `--api-key` / `--no-webui` 由 `scheduler::build_model_args` 按 config 字段拼在 `args` 之前；config 的 `args` 里不要再写这些（写了会被前面那份覆盖）。
- `build_model_args` 还会在缺 `--metrics` 时补上 —— 监控页的请求数 / KV 占用 / 槽位速度全靠这个只读端点，未开时引擎返回 501 `This server does not support metrics endpoint`。对推理无影响，默认带上。
- **绝不能传 `--no-ui`** —— 它关掉的是该模型的 llama.cpp 自带聊天界面，而「开始聊天」打开的正是那个界面。
- 反过来，单个 config 里 `no_webui: true` 是**有意用法**：只关掉这一个模型的界面；此时该模型卡片上的「聊天」入口被禁用是**预期行为，不是 bug**。

### 2.3 自动卸载模型：由前门（`idle.rs`）自己计时，不靠 `--sleep-idle-seconds`
原生 `--sleep-idle-seconds` 的行为是：空闲超过 N 秒子实例调用 `destroy()`，**模型权重、context/KV、mmproj、草稿模型全放掉**（见 `server-context.cpp`），下个请求到来时自动重新加载；但子进程与 CUDA context 还在，实机实测（610 MB 的 Q8 模型、单卡、`--sleep-idle-seconds 5`）：加载后 **10158 MB** → 休眠 **156 MB** → 卸载 **0 MB** —— 用户看到的"还剩 0.2 GB"就是这一段。
- **本应用不用这个参数**（2026-10-15 改）：`settings.sleep_idle_seconds` 由 `src-tauri/src/idle.rs` 的常驻线程执行（2 s 一轮，强杀进程树、显存归零）；见下面几条。
- 容量上限 `settings.models_max`（默认 4）由 `scheduler` 的容量闸执行：新模型要起、已满时**先卸最久未用的那个**（`ModelRuntime::last_used_ms`），不是 router 的内部 LRU。
- **sleep ≠ 卸载**：原生 sleep 之后子进程与 CUDA context 还在。实机实测（610 MB 的 Q8 模型、单卡、`--sleep-idle-seconds 5`）：加载后 **10158 MB** → 休眠 **156 MB** → 卸载 **0 MB** —— 用户看到的"还剩 0.2 GB"就是这一段。
- **所以本应用不靠 `--sleep-idle-seconds`**（2026-10-15 改，用户 m06652 / m06664）。旧实现要三件事同时成立才有效：子实例命令行带 `--sleep-idle-seconds`、前门把子实例的休眠状态报成 `status.value == "sleeping"`、卸载线程被挂上；实际三件都没做（`scheduler::build_model_args` 从不拼这个参数、`models_payload` 只报 loaded/loading/unloaded、线程只在 `autostart` 里挂），于是这一项从来没有生效过。现在的做法是前门自己计时：
  - `src-tauri/src/idle.rs` 是**常驻线程**（在 `lib.rs` 的 setup 里挂一次，与前门在不在、是自动起还是手动起都无关；2 s 一轮）：每轮重新读 `settings.sleep_idle_seconds`，`> 0` 时挑「调度器表里状态是 `Ready`、`active == 0`（没有请求正在转发）、且 `now - last_used_ms >= 门槛`」的模型，直接 `Scheduler::stop`（强杀进程树，显存归零），写一行 `[gui] 模型 <id> 空闲超过 <n> 秒，已卸载实例释放显存`。
  - 判定用调度器自己的 `ModelRuntime::last_used_ms`（前门每次转发成功时 `touch`），不去查 llama.cpp 的休眠状态；下一次请求由 `scheduler::ensure_ready` 按需重新拉起（iq3 冷启约 69 s）。
  - 线程常驻**且每轮重读设置** ⇒ 改完保存即生效，不用重启前门也不用重启程序。
  - 正在生成的（`active > 0`）绝不打断；`Starting` / `Stopping` 也不动。
  - 前门合成的 `/models` 仍不报 `sleeping`，所以前端「休眠」胶囊在 llama.cpp 通道不会出现（`src/utils/models.ts:124` 的映射留着不动，Strata 通道的 `sleeping` 是引擎自己报的）。

### 2.4 鉴权：配了 key 之后，除 `/health` 外全要鉴权
- 只认请求头：`Authorization: Bearer <key>` 或 `x-api-key: <key>`；**`?api_key=` 一律 401**。
- 因此 **`EventSource` 用不了**（无法自定义请求头），SSE 一律用 `fetch` 流式读取（`src/api/router.ts`）—— 聊天流就是这么走前门的。
- 清空 key 后各 config 的 `args` 与容器字段里必须**没有** `--api-key`，否则子实例仍要鉴权而界面按"没有 key"发请求 → 全 401，表现为"模型列表读不出来、模型也加载不了"（`cleared_api_key_leaves_no_flag` 测试守着）。前门**不代补 key**，客户端必须自己带（用户 m06545）。
- CORS 实测：`OPTIONS` 预检返回 200 且 `access-control-allow-headers: *`，所以 webview 里带自定义 `authorization` 头是允许的。

### 2.5 「刷新模型」= 重扫 `config\*.json`
前门与界面都从 `<exe 目录>\config\llamacpp-*.json` 读模型清单：新增 / 删除 / 改名一份 JSON 后，界面要重新扫描才看得到。
- 「刷新模型」= 后端重扫 config 目录（`models_scan`）+ 前端拿 `models://scanned`。漏掉重扫就是"已删除的模型刷新后还在"和"新模型刷新不出来"这两个老毛病。
- 保存单个模型配置后同样要重扫（或直接读返回值）才生效。

### 2.6 参数会被上游淘汰：`no-mmap` → `--load-mode`
llama.cpp **b11065 删掉了 `--no-mmap`**，替代品是 `--load-mode`（`auto|none|mmap|mlock|mmap+mlock|dio`）。
config 的 `args` 里残留 `--no-mmap` 的后果不是"这个参数失效"，而是**该模型子实例起不来**：
`option 'no-mmap' not recognized`。
- 应用的处理：`models.rs:1085 RETIRED_PRESET_KEYS = ["no-mmap"]`，`model_config::sanitize_config` 在加载 config 目录时**逐条丢弃**（独立形式 `--key value` 连值一起吃掉，不迁移成 `--load-mode`），只在真改过时才写盘（`lib.rs:1007-1018`）；`ModelSheets.tsx::RETIRED_KEYS` 让淘汰键不出现在配置弹窗里。
- **升级 llama.cpp 后模型起不来，第一件事是查日志里有没有 `option '…' not recognized`**，有就往 `RETIRED_PRESET_KEYS` 里加键。

### 2.7 共享 CUDA 运行时：Windows 的 DLL 搜索**不递归**
要让用户目录下不同版本的 llama.cpp 共用同一份 CUDA 运行时，必须把**直接包含** `cudart64_*.dll` / `cublas64_*.dll` 的那个目录注入子进程 `PATH`（指向它的父目录无效）。注入由调度器拉起的子实例逐级继承。

### 2.8 非 ASCII 路径
llama.cpp 以 ANSI 语义传递自身路径，路径含中文会让模型子实例 spawn 失败。应用用 `mklink /J` 建纯 ASCII 链接目录再启动（`winfix::ensure_ascii_dir`），状态里的 `ascii_fixed_from` 用于告知界面。

### 2.9 日志分流靠 `[%5d]` 前缀
模型子实例的 stdout/stderr 合进同一条日志流，行首是 `[<端口>]`；端口不足 5 位会渲染成 `[ 8081]`（带前导空格）。分流前必须 `trim()`，否则那类子实例的日志会整体被归到「系统」。

### 2.10 其它前端约束
- CSP 是 `connect-src … http://127.0.0.1:* http://localhost:*`：要连新域名得改 `src-tauri/tauri.conf.json`。
- webview 对同一主机的并发连接有上限（约 6），所以 API 压测的并发放在 Rust 侧。

### 2.11 Strata 不是 llama.cpp 的 router（第二条运行时通道）
Strata 的二进制不同名、没有 router mode、管理端点与 llama.cpp 完全不同，config 是 `strata-*.json`（数组形式的 `args`）而不是 `presets.ini`：
- **不能塞进 router 流水线**：`versions.rs::scan_versions` 只认 `llama-server.exe`；`GET /models`、`POST /models/load|unload`、`GET /props`、`/models/sse` 在 Strata 上都不存在。
- 所以它是**并列的独立通道**：后端 `strata_*` 命令 + `bench_strata`，前端 `StrataPanel.tsx`；llama.cpp 那条通道一行不改 —— 方案与逐轮实现见 `docs/archive/STRATA_INTEGRATION_PLAN.md`。
- **config 写回必须「校验 → 备份 → 原子写」**，临时文件名要唯一（`strata.rs::temp_config_path`），整段写路径持 `strata_lock()`；只在 rename 那一步加锁没用。
- **备份只留一份固定名 `<config>.json.bak`**，每次写覆盖（用户 m03392：不要堆积带时间戳的多份）。与 `model_config::write_config`、`settings` 的 `.json.bak` 策略一致；`.bak` 也被 `is_config_file` 排除，不会被当成 config 扫进列表。
- **`--vram-reserve-mib` 只认命令行，顶层 `vram_reserve_mib` 对引擎无效**：`control\serve\server.py:7075` 是 `reserve = int(args[...]) if "--vram-reserve-mib" in args else 700`，全文不读 config 顶层那个键（0 命中）。顶层 `vram_reserve_mib` 是**安装器 `setup.py` 的记忆字段**（`:7563/:7569/:7578` 写入、`:7523-7524` 重装时继承，注释 `#493`；`strata_control\presets.py:103` 读它填预设 UI）。实测（sc117 iq2-xs，0.1.46）：每槽 ≈1.437 MiB，`700→512` 少 188 MiB 正好多 131 槽（3770 → 3901）；缺 `--kv-resident 30720` 时 KV 全驻显存，槽位会从 3901 掉到 2432。
- **WebUI 用系统浏览器打开**（`ipc.openLocalUrl`），不内嵌 iframe —— 这样 Strata 自带界面升级时这个 GUI 不必跟着改 CSP。
- 两条运行时的模型**显存互斥**：启动一边的模型前先卸掉另一边的（`settings.strata_router_mutex` 可关）。
- **一个端口 = 一份 config = 一个引擎**：多份 config 写同一个端口时（本机两份都是 9090）它们天然互斥，切模型必须先 `/unload` 旧模型（上游顺手保存 learned expert profile、立刻放显存）再杀进程树，见 `store.ts::startStrataModel`（细节见 `docs/archive/STRATA_INTEGRATION_PLAN.md` §22）。
- **端口上跑的是哪份 config，只认 `/health` 的 `model`**：按端口猜归属会把在跑的实例记到别的卡片上（同端口多 config 时必错）。`lib.rs::attribute_strata_hit` 负责反查（有单测），报错信息一律点名模型名。
- **卡片播放按钮 = 启动引擎 + `/load`**：只起引擎不 `/load` 的话 `/health.loaded=false`，卡片永远显示「已停止」（用户 m00001 的「模型都无法启动」就是这个）。只有侧栏「启动 Strata」胶囊是纯启引擎（强制 `lazy_load: true`）。
- **卡片徽标的「支持 MTP」以 `args` 里带 `--mtp` 为准**（`strata.rs::StrataModelEntry.mtp` 只暴露 bool，MTP 权重路径不下沉 WebView，与 `has_api_key` 同口径）：`--mtp` 是安装器写下的安装事实（`src/utils/strataParams.ts` 的 `STRATA_INSTALL_FACT_FLAGS`，GUI 只读、写回原样保留），所以它表示"这套安装给这个模型装了自带的 MTP 草稿头"。**不要改用模型名正则** —— 模型列表页那条 `/mtp/i.test(name)` 认的是文件名里带 MTP 的外挂草稿场景，对 Strata 的 config 会漏判和误判。`--spec` 是推测解码窗口，写 `0` 时徽标显示虚线压暗的「MTP 关」（权重在装、投机解码当前关闭）。
- **`sampling` 是顶层字段，不是 flag**：`temperature` / `top_p` / `top_k` / `min_p` 写在 config 顶层的 `sampling` 对象里（`strataParams.ts` 的哨兵 `--sampling-*` **永不进 `args`**）。语义是「请求自己没带采样字段时的默认值」，改完要重启引擎才生效。上游对坏值**直接拒绝启动**（`temperature` ≥ 0、`top_p` 0 < v ≤ 1、`min_p` 0 ≤ v ≤ 1、`top_k` 1..64 的整数），所以保存前必须过 `validateStrataSampling`；块里 GUI 不认识的键（上游实验开关键）要原样保留。
- **并发参数集中在参数表的「并发」组，默认全部不配置，且有依赖校验**（用户 m03848）：组内是 `--batch`（别名 `--slots`，2..8，不写 = 单槽串行）、`--batch-mtp`、`--batch-groups`（默认 64，0 = off）、`--conversation-cache-mib`（默认 0 = 关闭会话停放）、`--conversation-cache-slots`（默认 4）。规则来自 `strata.exe --help`（0.1.46）与 `control\serve\server.py`：`--batch-mtp` 需要 `--batch` + `--mtp` + `--spec` 且不能与 `--batch-groups` 同开；`--batch-groups` 需要 `--batch`；`--conversation-cache-slots` 需要预算 > 0 才有意义。`strataParams.ts::checkStrataParamEnable` 负责逐项判定，`validateStrataParams` 在写盘前整组兜底（左栏 config 原文可以直接改，绕过右栏勾选）；`ParamForm` 为此新增可选的 `onBeforeToggle`（不传 = 全放行，llama.cpp 侧参数表不受影响），拒绝时开关不切换、分组上方就地显示原因。
- 引擎与它 spawn 的子进程都加 `CREATE_BREAKAWAY_FROM_JOB`（`winfix::no_throttle`）：GUI 被后台化时，子进程若继承宿主 Job Object 会被 CPU 节流，推理速度掉到个位数 t/s；父 Job 未开 `BREAKAWAY_OK` 时必须去掉该 flag 重试（`strata.rs::spawn_strata` 里有回退）。
- **前门代理（B 方案，用户 m00752/m00798）**：`settings.strata_host` / `strata_port`（默认 `127.0.0.1:9090`）是 GUI **进程内**的代理监听（`strata_proxy.rs`），客户端只连它，它按请求体里的 `model` 停旧引擎、起新引擎 —— 切换全程持 `state.strata_switch` 串行化，并等旧端口释放（`strata::wait_port_free`，20 s）。**引擎端口来自各 config 的 `port`，但真正被绑定的是 `run-<模型>.bat` 里的 `--port`**（上游 `server.py:5339/5559` 用 CLI 值，config 的 `port` 它根本不读），两处不一致时 `spawn_strata` 直接 bail 并说明原因。设置页的前门地址/端口**只写 GUI 设置、不写 config**（写进去会把各模型的引擎端口覆盖成 9090）；`api_key` / `idle_unload_s` / `min_free_vram_mib` / `before_load` 仍逐份写 config。
- **前门是「一个端口挂全部 config」**：`GET /v1/models` 由前门合成（当前引擎那份 `loaded`、其余 `unloaded`，形状照抄上游 `server.py:4313-4323`），没有引擎时 `GET /health` 也由前门合成；点名未知 `model` 一律 404 `model not found: {name}`（与上游同形，上游是 `server.py:4404-4405` 拿请求 `model` 与**当前实例**比对）。`lib.rs::strata_busy` **只算引擎槽位**（不算前门：前门不占显存，算进来会让托盘的「启动服务」一开局就变灰）；`RunEvent::Exit` 与托盘 `quit` 都要关前门。
- **前门的两条硬约束（都是实测踩出来的，改 `strata_proxy.rs` 前先读）**：
  1. **每条连接必须显式 `set_nonblocking(false)`**。监听套接字在 `start()` 里是 `set_nonblocking(true)`（非阻塞 accept + 30 ms 轮询），而 **Windows 上 `accept()` 返回的套接字会继承这个非阻塞标志**：不转回来的话所有 `read` 在没数据时直接返回 `WouldBlock`（`os error 10035`），读头/读体（`read_exact`）会随机失败、连接在请求体未读走时关闭，客户端看到的是 RST（「你的主机中的软件中止了一个已建立的连接」）。
  2. **绝不能在引擎生成期间向上游发 FIN（半关）**。上游 `serve/server.py:4127-4150 _watch_client` 每 0.5 s `select` + `recv(1, MSG_PEEK) == b""` 就把「请求套接字读到 EOF」判成**客户端挂断**并 `cancel.set()`，而取消只在提示读取的**分块边界**生效（`server.py:317`，块大小 8192 token）：症状是「小 prompt 侥幸成功、18859 token 的 prompt 在读到第一个块边界（约 5.7 s）时被取消」，引擎日志打 `0 generated ... (cancelled)`。所以前门**不挂**「客户端 → 引擎」的转发线程（请求体已由 `read_body` 整段读完、上游是 HTTP/1.0 + `Connection: close`），只做单向 `io::copy(上游 → 客户端)`。
- **前门服务状态要回传给前端**：`StrataStatus.proxy_serving`（正在服务的 config 文件名，`state.strata_proxy_serving` 这个 LIFO 栈 + `Serving` 守卫在 `Drop` 时摘掉并广播 `strata://status`）。卡片据此在 **DSH 请求触发加载**时显示「加载中」（`strataStarting` 只覆盖"用户在本页点启动"那条路径，用户 m01266 第 2 点）。排查连接类问题时可设环境变量 `STRATA_PROXY_DEBUG=1` 让前门把逐连接轨迹写进 `%TEMP%\strata-proxy-debug.log`（默认关闭）。
- **归属信息（`config_path` / `model_name` / `pid` / `started_at_ms` / `port`）只能在「槽位为空」时清**（用户 m01031）：引擎从 spawn 到端口监听之间、以及 `/load` 期间（上游 HTTP 服务单线程，加载 68 GB 权重时 `/health` 会超时）探测都会判「所有端口无响应」，而**探测失败不等于引擎没了**；以前这条分支无条件清 `config_path`，清掉之后 `running` / `model_name` / `loaded` 都能靠后续探测刷新回来，**唯独 `config_path` 补不回来**（它只由「外部实例」那条路写）⇒ 卡片永远「已停止」、面板计数停在 `0/3`，而侧栏写着「引擎运行中」。现在三层都堵上了：`merge_strata_probe` 每次探测都用槽位信息覆盖归属（`lib.rs::apply_owned_status`，有单测）、「无响应」分支在 `slot_owned` 时不动归属、`spawn_monitor` 在进程退出时把归属一起清掉（否则卡片会一直转「加载中」）；前端 `StrataPanel.tsx::runningEntry` 在 `config_path` 缺失时退回按 `/health` 的模型名认，并把「槽位里有引擎、端口还没应答」显示成「加载中」。
- **引擎在 `<安装目录>\engine-bundle\<版本>-<平台>-<后端>\`，config 直接写 `strata.exe` 的真实路径**（用户 m02686 / m02795）：0.2.x 起引擎从 `serve\` + `.venv` 换成组件包（`strata.exe` + `engine-component.json` + `BUILD.json`），启动器是 `control\python\python.exe` + `control\serve\server.py`（`strata.rs::fallback_command` 优先这套，0.1.x 布局仍兜底）。**`engine-bundle` 下可能多版本并存**（升级不一定删旧的）：**设置页「通用」里的「Strata 引擎」卡片**把它们列成表格让人选（`strata_engines` 列版本 / 后端 / 架构 / 路径，`strata_apply_engine` 把选中的批量写进**全部** `strata-*.json` 的 `exe`，用户 m03103），全局选择记在 `settings.strata_engine`；**模型卡参数弹层不再提供引擎选择**（用户 m03137，那里只留 config 原文与参数）。扫描只在**声明的路径已经不存在**时才自动跟到现有版本（`engine_stale`），路径还在就尊重用户的选择 —— 否则会把那次选择覆盖掉。
- **Strata 卡片按钮管的是「模型」，不是「引擎进程」**：卸载（`/unload`）只放掉权重，引擎进程与 `config_path` 都还在，所以 `running=true / loaded=false` 是正常态。按钮的切换判据必须带上 `loaded`（`StrataPanel.tsx::toggleOne`：`runningFile === file && status.loaded !== false` → 卸载，否则启动）；只看 `runningFile` 会把「卸载后再点启动」当成又卸载一次，卡片永远停在「已停止」（用户 m03241 实测踩到，build145 修）。探测不明（`loaded === null`）时仍按卸载走，那是 m04917 的场景。

---

## 3. 前端约定

### 3.1 状态与数据流
`store.ts` 是唯一编排点；组件只读 store、调 store 的动作。要点：
- **API key 必须同步给 HTTP 层**：`useApp.subscribe` 里调 `setRouterApiKey(settings?.api_key)`，漏掉就是"设置里有 key、请求却 401"。
- **模型列表是三方合并**：扫描结果（`models_scan`）+ config 目录（`config\llamacpp-*.json` 的 `name` / `args`）+ 运行态（调度器表 / 前门 `/v1/models`），再叠加收藏与 Strata 通道的条目。规则在 `utils/models.ts::mergeModels`；对回模型用两条线索：同名 id → config 里的 `model` 路径。`settings.aliases` 是 router 时代的残留（只减不增）。
- **启动即出列表**：先用落盘缓存 `models-scan-cache.json` 渲染，再后台重扫，只有结果真变了才发 `models://scanned`（stale-while-revalidate）。该事件同时带 `aux_files`，否则后台扫描跑完辅助文件就没了。
- **组件文件只导出组件**（工具函数抽到 `utils/`），否则 Fast Refresh 失效。
- **监控页的「并行任务」卡只在真开了多槽位时出现**：判据是 `normalizeSlots(engine.slots).length > 1`（即引擎的 `--slots` / `--batch`），单槽时那张卡只有一行「空闲」，纯占地方（用户 m03711）。组件 `components/SlotMonitor.tsx` 与样式都保留，只是渲染条件收窄。
- **聊天页输入框右侧的模型下拉**（`ChatPanel.tsx`）：列出**全部**模型，顺序同 `mergeModels`（已加载的不排最前）；已加载的模型名用绿色文字（`components.css` 的 `.composer-model__item.is-loaded`，取 `--st-accent-text`，不额外加圆点/标记）。当前模型取值顺序为「记住的选择 → 已加载里 id 排序第一个 → 上次聊天的模型（最近一份会话的 `conversation.model`）→ 空（显示「请选择模型」）」；`sendChat` 用同一套顺序（用户 m01516），选中的模型未加载时发送前先自动拉起，执行状态卡片显示「拉起中…」。**聊天历史默认收起**（用户 m00547：`historyOpen` 初值 `false`，工具栏的「展开聊天历史」按钮展开）。
- **主窗口是「隐藏创建、首帧后显示」**：`tauri.conf.json` 的 main 窗口 `visible: false`，`src/main.tsx` 在两帧后调 `ipc.appBootFinished()`（后端 `app_boot_finished`）才 `show()`。原因：WebView2 从创建到画出第一帧有几百毫秒，直接显示用户看到的是「界面显示不全、一块一块黑」（用户 m03477/m03541）。配套两条：①`--minimized` 自启动时后端忽略该调用，窗口留在托盘；②上次是最大化时不能在建窗阶段调 `window.maximize()`（tao 在 Windows 用 `ShowWindow(SW_MAXIMIZE)`，会把隐藏窗口顶出来），意图记进 `RESTORE_MAXIMIZED`、等显示后再应用。后端还有 4 秒兜底：前端崩在首帧之前也会把窗口显示出来。`RunEvent::Ready` 里那条旧的「无条件 `show()`」已经删掉 —— 它会抢在前端就绪之前把窗口推出来（只在 `--minimized` 时显式 `hide()`）。

### 3.2 通知与弹窗形态
- 通知走 `store.notice`，`App.tsx` 渲染成参照实现的 toast 结构：`.toast-icon` + `.toast-content`(`.toast-title` + `.toast-message`) + `.toast-close`；图标 `fa-check-circle` / `fa-exclamation-circle`。多行文本时标题取第一行、正文取其余（例如「模型加载 / 模型 X 加载成功」）。
- 通用弹窗是 `components/Sheet.tsx::Modal`（可选 `iconClass`、`domId`）；参照实现里按 id 作用域的样式（如 `#restartRouterModal`）靠传 `domId` 命中。

### 3.3 UI 参照系（重要）
参照实现有两套界面：
- 默认首页 `index.html` + `css/index.css`（用户实际看到的那一套）→ **我们照搬的是这套**：`src/styles/legacy/index.css` 是它的原样引用，React 侧沿用它的类名（`.sidebar/.nav-item/.top-bar/.model-item/.modal/.param-group/.form-control` …）。
- `index-new.html` + `css/newui.css`（需手动访问）→ 只有**性能测试**与**系统日志**两页参考它。

改界面前先确认参照哪一套；早期按 newui 复刻，导致长期与用户看到的界面不一致。

### 3.4 三处「hub 遗留样式 / 原生控件」的坑

**① 小字号控件要自己压平行高。** legacy 的 `body { line-height: 1.6 }` 会传给所有子元素，小字号控件
（胶囊 / 徽标 / chip）不显式写行高时，行框会远高于字形：侧栏的前门胶囊（`.router-pill`）原本是 12px 字号 + 19px 行框
+ 12px 内边距 = **31px 高，而字形只占 12px**；加 `line-height: 1` 并把内边距收到 `0.25rem` 后是 **22px**。

**② `.mono` 自带 `min-height: 38px`**（legacy/index.css:1642，hub 原本给日志行/代码块用的）。
本应用把 `.mono` 当作「等宽小字」用在提示行、表格单元格、侧栏版本号上，于是它们**统统被撑到 38px 高、
文字贴着顶部**。侧栏底部「前门胶囊下方一片白」就是这个：那行版本号盒子有 38px，字只占 13px，
下面白拖 25px。修法是给 app.css 的 `.mono` 补 `min-height: 0`（已做）——往这类小元素上叠 `.mono` 时留意高度。

**③ 原生 `title` 不换行、不限宽。** 参数说明是整段中文，写成 `title={desc}` 时 WebView2 的原生提示按内容撑宽，
直接横出配置弹窗（600px）。hub 旧版的做法是**点问号开一个说明弹窗**（`#paramDescModal`，限宽 560px、
正文 `pre-wrap` + `break-word`），本仓库照搬：`ParamForm.tsx` 的问号只挂 `onClick`，弹窗复用 `Sheet.tsx::Modal`，
样式在 app.css —— hub 把这几条写在 `index.html` 的内联 `<style>` 里，`legacy/index.css` 里没有。

### 3.5 文案与交互口味
简体中文、简洁；用户明确否定过的方向不要重提（例如"统一两栏样式""再大一点"）；改动前先说清楚"要改什么"。

---

## 4. 后端要点

- **扫描分组**：同目录内 `mmproj*` 归入该模型（多模态）；`*-000NN-of-000MM.gguf` 视为一个多分片模型；同目录多个主文件各自成模型；只有 mmproj 的目录不是模型。
- **辅助文件单独出表**：`scan_aux_files` 返回 `aux_files`（mmproj / 草稿模型），供配置弹窗的「多模态投影文件」「草稿模型路径」直接选，避免它们被当成主模型。
  - `is_gguf` **只看扩展名**（曾加过 magic-byte 兜底，用户要求还原：没有扩展名的文件本来就不该被当模型）。
  - 文件名含 `draft` 的文件只有在同目录存在真实主模型时才按草稿处理。
- **config 写入最小化**：`model_config::upsert_entries_in_dir` / `entries_from_config` / `apply_entries` 只动涉及的键；用户手写的未知键、`args` 里不认识的 flag 原样保留；清空某项 = 从 config 里去掉该键（回到 `ModelConfig::default`）。
- **失效配置归档 + 恢复**：config 的 `model` 指向的文件不在了 → 移入 `config\.orphan\`（`move_to_orphan`）；模型回来时按 id 把配置接回去（`restore_from_orphan`）。判据只有"文件不在"，没有 `model` 字段的 config 一律不碰；所有配置都失效（≥3）时判定为"模型盘没挂上"，跳过清理只提示。
- **多模态开关**：config 有顶层 `mmproj` 字段（`scheduler` 拼成 `--mmproj`）；留空 = 不用视觉。关掉时顺手清掉手填的投影路径。
- **启动时序两个坑**（`scheduler.rs::spawn_model` 附近的注释）：
  1. 必须**先接上 stdout/stderr 读取、再等端口就绪**，否则管道缓冲（Windows 匿名管道约 4KB）写满会让子进程卡住、永远不监听端口。
  2. 任何启动失败分支都要**先杀掉子进程**，否则句柄没进调度器表，界面再也停不掉它（孤儿进程占端口和显存）。
- **停止不能直接 `wait()`**：kill 失败时会无限阻塞、界面表现为"停不了"；改为限时轮询 + `taskkill /T /F` 兜底。
- **日志里给 `--api-key` 打码**（`redact_args`）。

---

## 5. 构建、测试、验证

```powershell
npm install                        # 受限沙箱里需要 --ignore-scripts
npm run cargo:proxy                # 另开终端保持运行：本机 crates 代理 http://127.0.0.1:8787
npx tsc --noEmit                   # 前端类型检查（在仓库根执行）
cd src-tauri; cargo test --lib      # 后端单元测试（当前 135 passed / 10 ignored）
npm test                           # 等价于上面两条（test:web + test:rs）
npm run tauri build                # 打包（产出 exe + NSIS 安装包）
node scripts/make-icons.mjs        # 重新生成全部图标资产
```

- **cargo 要走本机代理**：本机 Windows 原生 TLS（schannel）不可用（`SEC_E_NO_CREDENTIALS`），Node 的 OpenSSL 可以出站，`.cargo/config.toml` 已把 `crates-io` 指向 `127.0.0.1:8787`。没开代理就会 `Could not connect to server`。
- **沙箱限制**：命名管道被禁 → esbuild（Vite / TSX）报 `spawn EPERM`，`npm run tauri build` 需要更宽权限；**GUI 运行验证必须在沙箱外**（WebView2 渲染进程走命名管道，沙箱内起不来窗口，这不是应用缺陷）。
- **提权构建还要把 `TEMP`/`TMP` 指进工作区**：只提权不够 —— esbuild 起来后会把转译结果写进 `%TEMP%\esbuild-<hash>` 再删除，提权进程对工作区外的临时目录没有写权，症状是前端 `88 modules transformed` 之后 `[vite:esbuild-transpile] remove C:\Users\…\AppData\Local\Temp\esbuild-<hash>: Access is denied.`。可用写法（2026-10-12 实测一次通过）：

  ```powershell
  $env:TEMP='E:\Code\llama.cpp-GUI\.tmpbuild'; $env:TMP=$env:TEMP; npm run tauri build
  ```
- **提权被拒绝就不要重试同一个命令**，换做法或先问用户。
- **换图标后必须删 `src-tauri\target\release\build\llamacpp-gui-*` 与 `.fingerprint/llamacpp-gui-*` 再构建**（`tauri-build` 不监听 `icons/*`）。不删的话 exe 在**原路径**上仍是旧图标 —— Windows 按路径缓存图标，二进制本身已是新图标（复制成别的名字能正常显示）。
- 只想看真实扫描结果：`cargo test --lib real_environment_model_scan -- --ignored --nocapture`（打印当前模型库的模型与辅助文件）。
- **磁盘占用**：`target/` 是唯一的膨胀源（`src-tauri/src` 本身不到 1 MB）。全量构建曾经是 **debug 8.2 GB + release 2.9 GB**，
  已做三项控制（都在 `src-tauri/Cargo.toml`）：① `[lib] crate-type = ["rlib"]` —— 去掉只有移动端才用的
  staticlib / cdylib（debug 下的 `.lib` 直接从 784 MB 变 0）；② `[profile.dev] debug = "line-tables-only"`
  加 `[profile.dev.package."*"] debug = false` —— PDB 从 1.55 GB 压到 292 MB；③ release 侧原有的
  `lto + opt-level="s" + strip` 不动。实测同一台机器全量重编：`debug/` **8,224.8 MB → 1,474.2 MB**（-82%）；
  release 侧只有历史残留的 staticlib / cdylib 产物（顶层 `.lib` 209 MB + `deps` 里 214 MB 等，共 426 MB），
  已清掉且改动后不再生成；`release/` 剩下的 3.1 GB 是依赖的 `.rlib` 与 build script 产物，属正常增量编译开销。
  临时腾空间直接删 `src-tauri/target/debug`：只影响 dev/test 的首次重编，release 增量不动。
- **别把缓存放进仓库**：`$env:CARGO_HOME=<仓库>\.cargo-home` 这种用法会让一次完整构建在仓库内堆 ~780 MB 的
  registry 缓存（本仓库曾留下这样一份死缓存，已清掉）。默认 `~/.cargo` 就够。

### 5.1 `tmp/` 里的验证资产（非交付物，可直接复用）
| 脚本 / 目录 | 用途 |
|---|---|
| `tmp/mcp-echo-server.mjs` | 最小 MCP stdio 服务器（echo 工具）：`cargo test --lib echo_server_roundtrip -- --ignored --nocapture` 用它跑端到端 |
| `tmp/smoke-paramform.mjs` | 参数表单的旧冒烟副本；正式冒烟是仓库内的 `scripts/smoke-paramform.mjs`（真实 React 渲染 `ParamForm`，防"下拉渲染对象导致白屏"复发，需要 esbuild） |
| `tmp/temp/` | 构建时把 `TEMP`/`TMP` 指到这里（见上面的 esbuild 权限坑） |
| `tmp/as/` | AnySearch 官方文档与 `/v1/extract` 响应样本（`web_fetch` 兜底的依据） |

> `tmp/` 有 100+ 个历史产物，可随时清理；`scripts/` 下的才是仓库内正式测试。联网相关的三个端到端用例都是 `#[ignore]`，要联网时手动跑。

---

## 6. 运行时数据文件

**便携目录 = exe 所在目录**（`src-tauri/src/paths.rs`）：发布版优先把配置写在 exe 旁边，
装到不可写位置（如 `C:\Program Files`）时自动退回 `%APPDATA%\dev.llamacpp.gui\`；
dev 构建（`tauri dev` / `cargo test`）**永远**用 `%APPDATA%` —— 否则真实配置会被搬进 `target/debug`。
便携目录会写进「系统日志」：`[gui] 便携模式：配置目录 …`。
**旧版本的 `%APPDATA%` 数据不再自动搬运**（2026-09-22 移除）：便携目录里没有配置就按全新安装处理，
需要重设 llama.cpp 目录、模型目录与 preset；`%APPDATA%\dev.llamacpp.gui\` 只作为不可写位置的回退目录。

下列文件都在便携目录下：

| 文件 | 内容 | 注意 |
|---|---|---|
| `settings.json` | 全部用户设置（见 §6.1） | 未知字段会被保留（`Settings.extra` 的 `#[serde(flatten)]`，测试 `unknown_settings_fields_survive_a_patch`）；读失败时本次启动只读，不写回默认值 |
| `config/llamacpp-<id>.json` | **一个模型一份配置**（见 §2.1），前门与调度器都从这里读 | 文件名主体是 id；失效的配置移到 `config/.orphan/` |
| `mcp.json` | MCP 服务器清单（`{"servers":[…]}`，`command`/`args`/`env`/`enabled`） | 保存即重启全部 MCP 子进程 |
| `search.json` | 联网搜索：`keys`（引擎 → key）/ `order` / `blockedDomains` / `timeRange` / `maxResults` | `order` 就是启用清单；非 keyless 引擎没 key 会被路由跳过 |
| `models-scan-cache.json` | 上次扫描结果（启动先渲染它） | 按 `model_roots` 校验，换根目录即作废 |
| `gguf-meta-cache.json` | gguf 元数据（架构、量化）缓存 | 版本不符自动忽略 |
| `config/.orphan/` | 模型文件消失后归档的 config（模型回来时恢复参数） | 见 §4 |
| `logs/` | 每次运行一个 `gui-<启动时间>.log` | 超 8 MB 分卷，只留最近 12 个 |
| `runtime/` | 非 ASCII 路径的 `mklink /J` 链接目录 | |
| `bench/records.json` + `bench/*.txt` | API 压测记录与导出文本 | |
| `webview/EBWebView/` | WebView2 的数据：localStorage（显存预估缓存、参数分组折叠状态、会话历史）+ 浏览器缓存 | 约 90 MB；删掉只是丢这些 UI 偏好 |

> **webview 数据也在便携目录**：Windows 下 Tauri 默认把 webview 的 data directory 钉在
> `%LOCALAPPDATA%\<identifier>`（`tauri/src/manager/webview.rs`：`data_directory.is_none()` 时
> 强制写入），而配置项 `app.windows[].dataDirectory` 只支持"相对 appDataDir"的路径 —— 两条路都
> 做不到"跟着 exe 走"。所以 main 窗口在 `tauri.conf.json` 里标了 `"create": false`，改由
> `lib.rs::create_main_window` 建，并调 `WebviewWindowBuilder::data_directory()` 指到 `webview/`。
> 参数必须在建窗**之前**定下来 —— WebView2 一旦把环境建在某个目录上就改不动了。

> **卸载时问一句**：`src-tauri/nsis/hooks.nsh` 在 `NSIS_HOOK_PREUNINSTALL` 里弹窗问
> "是否同时删除用户数据"，真正删除放在 `POSTUNINSTALL` —— 模板在那之后才
> `CheckIfAppIsRunning` 并等应用退出，先删会有一堆文件被 `EBWebView` 占着删不掉。
> Tauri 的卸载段本身只 `Delete` 它装进去的文件、再 `RMDir`（仅删空目录），所以选"否"
> 数据会原样留在安装目录，重装到同一目录即可继续用。

> 真机实测（2026-09-22）：手工建窗后窗口正常，窗口几何还原、托盘、单实例也都正常；
> 配置与 webview 数据（94 MB / 1757 个文件）都在 exe 目录下，
> 「系统日志」里能看到 `[gui] 便携模式：配置目录 …`。

### 6.1 `settings.json` 字段（当前实现）
llama.cpp 侧：`llama_cpp_dir`、`model_roots[]`、`shared_lib_dirs[]`、`selected_version`、`port`(8080，**前门端口**)、`models_max`(4)、`sleep_idle_seconds`(-1)、`api_key`、`gpu{devices[], split_mode, tensor_split, main_gpu, fit, fit_target, n_gpu_layers}`、`autostart`、`minimize_to_tray`(true)、`auto_start_router`(true)、`favourites[]`、`aliases{扫描 id → 段名}`（router 时代残留，只减不增）、`view{mode, density}`、`window{width,height,x,y,maximized}`、`version_cache{版本名 → {has_router_mode, probed_at_ms}}`。
Strata 侧：`strata_root`、`strata_selected_config`、`auto_start_strata`、`strata_router_mutex`、`strata_host`、`strata_port`、`strata_api_key`、`strata_idle_unload_s`、`strata_min_free_vram_mib`、`strata_before_load`。

`SettingsPatch` 是命令入参的白名单：**加设置项要同时改 `Settings` 与 `SettingsPatch`**，否则前端保存后不落盘。

---

## 7. 未决项与已知边界

**未决项**（想改可以接着改的）：

1. **Strata 引擎在显存耗尽后会卡死，不是 GUI 的 bug**：反复打大 prompt 之后 `/status` 长挂 `phase=reading the prompt`/`thinking`、`elapsed_s` 一直涨、`tokens_per_s` 掉到个位数，此后**所有**请求（连 `curl` 直连引擎端口绕开前门也一样）要么空回复、要么只收到 236–428 B 就被断开；引擎日志报 `0 MiB of VRAM free with everything loaded - LOW: requests may stall; add --vram-reserve-mib 512 …`。处置：杀掉 python 进程树，前门会在下一个请求冷启动新引擎。**本机 2026-10-11 已按引擎自报值定稿**：三份 config 统一 `--kv-resident 30720`，`--vram-reserve-mib` 两份 512、`swift-1.5-iq3_xxs` 不传（引擎默认 700 MiB），三份都不再报 LOW。手改 config 删这个参数**必须连值一起删** —— 只删 flag 会变成 `--vision 782`，引擎打印用法后直接退出。显存账见 `docs/archive/STRATA_INTEGRATION_PLAN.md` §22.10。

**已知边界**（现状如此，不是缺陷）：

2. **纯前端渲染的页面 `web_fetch` 抓不到正文**：自写提取不跑 JS、AnySearch `/v1/extract` 也不渲染，SPA 站点（实测 `lobehub.com/docs/usage/start`）只能拿到几百字符占位，模型只能吃搜索引擎给的摘要。
3. **聊天历史受 localStorage 配额限制**：`CHAT_CONVERSATION_LIMIT = 30`、`CHAT_MESSAGE_LIMIT = 200`、`TOOL_RESULT_KEEP = 2_000`（`src/store.ts:309-312`）。`web_fetch` 单页最多 1.2 万字符，落盘时按 `TOOL_RESULT_KEEP` 截断 —— 不截断会把约 5 MB 配额写满，设置与主题随后静默存不进去。
4. **`models_max = 1` 时每次换模型都要停旧起新**：默认容量下切模型有 3–6 秒冷启动（日志实测连接耗时 3637 / 6406 ms），不是卡住；要并行驻留就调大 `models_max`（上限 4）。聊天页的模型下拉**列出全部模型**（不再「只列运行中的」）；选中未加载的模型后发送会自动拉起（`store.ts::sendChat` 里 `chatAutoLoad`），首次请求因此要等这段冷启动。

## 8. 新会话怎么获得上下文

1. 先读本文件（§2 的约束、§7 的未决项与已知边界），再按需要看 `README.md`；逐轮实现细节与历史决策在 `docs/archive/`（`ITERATION_LOG.md`、`DECISIONS-2026-10.md` 及四份设计文档）。
2. 会话之间不会自动继承上下文：把结论写进仓库文档（推荐），或在新会话用 `@` 引用旧会话（只得到有界只读快照，会被截断）。
3. 改代码前后请遵守：先 `npx tsc --noEmit` + `cargo test --lib`；涉及 llama.cpp 行为的改动，先看 §2 有没有相反结论，再考虑补一个把该行为钉住的单元测试。
