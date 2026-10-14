# 交接说明（HANDOVER）

> 面向**接手这个仓库的新会话 / 新维护者**。`README.md` 讲**能力**（有哪些功能、怎么装怎么跑），
> 本文讲**怎么接手**：决定实现形态的 llama.cpp 行为约束、代码地图、配置与数据文件位置、
> 验证手段（含现成脚本）、踩过的坑、未决项。
>
> 最后更新：2026-10-11。最近一次完整验证：`cargo test --lib` **99 passed / 0 failed / 5 ignored**，`npx tsc --noEmit` 无输出（exit 0）。
> （上一份构建产物 `src-tauri\target\release\llamacpp-gui.exe`，9,328,640 B，SHA256 `04EBD9CA…EBE9` 是 2026-09-23 的；
> 其后做过一轮代码审查与修复，结论与逐条改动见 `CODE_REVIEW.md`，**exe 需要重新打包才能反映这些改动**。）
>
> 注意：README 的「当前进度」已补到 **P7**（Strata 第二运行时通道），但**每一轮 UI / llama.cpp
> 兼容性迭代的细节没有**逐条写进 README —— 那部分记在本文 §4、§5。

---

## 0. 三十秒定位

| 问题 | 去哪里看 |
|------|----------|
| 某功能的意图与做法 | `README.md`「当前进度」 |
| 整体方案与实测基线 | `REFACTORING_PLAN.md`（v2.1；§3 实测事实、§4 后端设计、附录 B 收尾偏差） |
| 方案为什么改成现在这样 | `REFACTORING_REVIEW.md`（真机实测审查，含 v1 被否掉的理由） |
| 某个 llama.cpp 行为到底怎样 | 本文 §2（每条都来自真机实测） |
| 要改参数表单 / 配置弹窗 | 本文 §5.2 + `src/assets/params.json` + `src/components/ParamForm.tsx` |
| 界面长得不对（与参照实现不一致） | 本文 §3.3（参照系是 hub 的**默认首页**那套，不是 newui） |
| 构建失败 / 跑不起来 | 本文 §6；`README.md`「构建与运行」 |
| 上次留下的尾巴 | 本文 §8 |

---

## 1. 架构一句话

**重逻辑全部交给 llama.cpp 原生 Router Mode**：这个应用只做「版本发现 + 进程管理 + 环境注入 + 扫描生成 `presets.ini` + 日志 + 性能测试 + 托盘」。

**另有第二条并列运行时**：Strata（引擎在 `E:\AI\Strata`，config 是 `strata-*.json`）通过一组独立的 `strata_*` 命令接入，与 router 互不依赖，共用同一套进程管理 / 端口顺延 / 日志采集 / 非 ASCII 修复 / 压测基础设施。它**不是** llama.cpp 的 router，两者不能混着做（见 §2.11）。

- 后端 Rust / Tauri 2：只提供**系统能力**（进程、文件、设置、注册表、子进程）。
- 前端 React 19 + TS + Vite：模型列表、加载/卸载、详情、聊天入口这些**管理数据由 webview 直连 router 的 HTTP + SSE**（没有自建网关，没有 `/api/*` 层）。
- 推论：**前端出现 401 / Failed to fetch，多半是鉴权或 router 没起来**，不是后端命令的问题。

### 1.1 代码地图

| 位置 | 职责 | 备注 |
|------|------|------|
| `src-tauri/src/lib.rs` | Tauri 命令与事件注册、后台扫描调度、preset 同步/清理/恢复编排 | 改了命令要同步 `src/ipc.ts` |
| `src-tauri/src/router.rs` | router 命令行组装、环境注入、启动/停止、崩溃监测、日志采集与分流 | §2.2/§2.3/§2.9 的约束都落在这里 |
| `src-tauri/src/settings.rs` | `settings.json` 读写；`Settings` / `SettingsPatch` / `SettingsStore` | 加字段要同时改这两个结构 |
| `src-tauri/src/versions.rs` | 版本扫描（两种目录布局）、`--help` 探测并缓存、共享 CUDA 目录匹配、`PATH` 合成 | |
| `src-tauri/src/models.rs` | 模型递归扫描、`presets.ini` 读写与清洗、hub 配置迁移、扫描缓存、失效段归档 | 3152 行，最重的文件 |
| `src-tauri/src/paths.rs` | 配置目录解析：便携目录（exe 同目录）/ 回退 `%APPDATA%`、webview 数据目录 | 只有发布版走便携；dev 恒用 `%APPDATA%`，见 §7 |
| `src-tauri/src/gpu.rs` | `--list-devices` 枚举与校验、GPU 参数组装、显存预估 | 默认全空 = 交给原生 `--fit` |
| `src-tauri/src/bench.rs` | API 压测（Rust 侧并发）+ 记录落盘 + 硬件信息 | 压测放后端是为绕开 webview 同主机 6 连接限制；llama-bench 面板已于 2026-09-21 移除 |
| `src-tauri/src/http.rs` | 极简本机 HTTP 客户端（裸 TcpStream，无第三方依赖） | bench 与 idle 共用；非 2xx 时把 JSON 里的 `error.message` 提成错误文本 |
| `src-tauri/src/idle.rs` | 轮询 `GET /models`（有模型在跑时 1s，全 unloaded 时 5s），把 `status.value == "sleeping"` 的模型 `POST /models/unload` | 只在 `sleep_idle_seconds > 0` 时随 router 启动；见 §2.3 |
| `src-tauri/src/winfix.rs` | 非 ASCII 路径的 `mklink /J` 链接、端口探测、`CREATE_NO_WINDOW`、`no_throttle`（子进程脱离宿主 Job Object） | 子进程一律走 `hide_console` |
| `src-tauri/src/strata.rs` | Strata 第二运行时通道：config 扫描 / 校验 / 原子写、引擎启停与崩溃监测、`/load`·`/unload` 转发 | 见 §2.11；方案与实现记录见 `STRATA_INTEGRATION_PLAN.md` |
| `src-tauri/src/strata_proxy.rs` | **前门代理**：一个端口挂全部 config，按请求体里的 `model` 停旧引擎 / 起新引擎并原样转发；`/v1/models` 与「没引擎时的 `/health`」由它合成；`StrataStatus.proxy_serving` 回传给卡片显示「加载中」 | 见 §2.11 末尾「前门的两条硬约束」（Windows accept 继承非阻塞、绝不能向上游发 FIN）；用户 m00752/m00798/m01266 |
| `src-tauri/src/state.rs` | `AppState`：进程槽、日志环形缓冲、扫描与元数据缓存、启动互斥、托盘可用标志 | 缓存的 TTL 若与前端轮询同周期，命中率≈0 |
| `src-tauri/src/tray.rs` / `tray_icon.rs` | 托盘菜单与 RGBA 图标常量（由 `scripts/make-icons.mjs` 生成） | 托盘不直接调后端，把命令转给前端 |
| `src/store.ts` | zustand 全局状态：设置、模型、preset、router 状态、通知 | 1224 行，业务编排几乎都在这里 |
| `src/api/router.ts` | 直连 router 的 HTTP + SSE 客户端（**唯一**带鉴权的地方） | §2.4 / §2.5 |
| `src/utils/models.ts` | 扫描结果 ↔ router 运行态合并、段名/别名规则、过滤排序（纯逻辑） | 组件文件只导出组件（Fast Refresh 规则） |
| `src/utils/paramSchema.ts` | 参数表 schema 与表单状态换算（纯数据） | |
| `src/components/ParamForm.tsx` | 参数表单控件（下拉、路径选择、JSON 编辑） | §5.2 |
| `src/components/StrataPanel.tsx` | Strata 页：卡片列表 + 配置 / 详情 Sheet | 1055 行；参数表单复用 `ParamForm` |
| `src/utils/strataParams.ts` | `strata-*.json` 的 `args` ↔ 表单状态换算与参数 schema（纯逻辑） | 与 `utils/paramSchema.ts` 并列 |
| `src/components/ModelSheets.tsx` | 模型配置弹窗 + 详情弹窗 | 含多模态开关 |
| `src/components/SettingsPanel.tsx` | 设置页（目录 / 服务 / 启动与托盘） | 端口/上限/空闲释放/API Key 改动都会触发「重启 router?」弹窗（§5.4） |
| `src/styles/legacy/index.css` | 参照实现默认首页的 CSS 原样引用 | 4276 行；改样式优先加在 `src/styles/app.css` |
| `src/styles/app.css` | 本应用补充样式 | 1533 行 |

---

## 2. llama.cpp 行为约束（**实测事实，不要凭直觉改代码**）

每一条都对应某次真实故障；违反它就是出 bug，不是"可能有问题"。

### 2.1 preset 段 = 模型 + 参数
`presets.ini` 的段名就是 router 的模型 id；段内的键就是该模型子实例的启动参数；router 会给子实例下发 `--alias <段名>`。
- 选项是**键值 map**：同一段里同名键写两遍会坍缩成一条。
- 改模型在 API 里的名字 → 改段名（界面上的「别名」就是改段名），别指望单独加 `--alias`。
- 前端发请求用的 id 必须是**段名**（`selected.section`），不是扫描出来的目录 id；两者靠 `settings.aliases` 关联。曾因此在 API 压测里报 `model '…-MTPv2-23G-ICE' not found`。

### 2.2 router 会把**自身**的 common 参数下发给每个子实例
好处：`--api-key` / `--sleep-idle-seconds` / `--models-max` 天然"对所有模型生效"。
坏处：**绝不能给 router 传 `--no-ui`** —— 它会被下发，把每个子实例的 llama.cpp 自带聊天界面一起关掉，而「开始聊天」打开的正是那个界面（`router.rs` 的 `default_args_do_not_touch_gpu` 测试守着这条）。

反过来说，**给单个模型的 preset 段写 `no-webui = true` 是有意的、受支持的用法**：只关掉那一个模型的子实例界面（等价写法 `webui = 0`，两种都认，见 `utils/models.ts::webuiDisabled`）。
此时该模型卡片上的「聊天」入口被禁用是**预期行为，不是 bug**；用户当前的 `presets.ini` 里就有 6 个模型是这样配置的（2026-09-21 确认）。

### 2.3 自动卸载模型：`--sleep-idle-seconds`（放掉的是模型本身）
空闲超过 N 秒，子实例调用 `destroy()`：**模型权重、context/KV、mmproj、草稿模型全放掉**（见 `server-context.cpp`），下个请求到来时自动重新加载。
- 默认 `-1`（关闭）；`0` 无意义。应用只在 `> 0` 时才把它拼进命令行。
- 这是原生能力，应用**不需要**轮询或自己数闲置时间。
- `--models-max`（默认 4）是 router 内部的 **LRU 淘汰**，只淘汰闲置模型；`last_used` 不经 HTTP 暴露，所以**做不了**"按最久未使用卸载"那种策略（hub 能做是因为它代理转发请求，我们不做代理）。
- **sleep ≠ 卸载**：原生 sleep 之后子进程与 CUDA context 还在。实机实测（610 MB 的 Q8 模型、单卡、`--sleep-idle-seconds 5`）：加载后 **10158 MB** → 休眠 **156 MB** → 卸载 **0 MB** —— 用户看到的"还剩 0.2 GB"就是这一段。
  因此 `sleep_idle_seconds > 0` 时应用会另起一个守护线程（`src-tauri/src/idle.rs`，轮询 `GET /models`：有模型在跑时 1s、全是 unloaded 时 5s），看到 `status.value == "sleeping"` 就 `POST /models/unload` 把实例彻底收掉，日志里记一行 `[gui] 模型 <id> 已休眠，卸载实例以释放显存`。
  - 轮询**不会**打断子实例的 idle 计时（实测：每秒轮询的同时，状态仍在第 5 秒如期切到 sleeping）。
  - 轮询间隔**自适应**（2026-09-23 按用户要求加）：响应里有 `loaded` / `loading` / `downloading` 的模型时用 1s（随时可能睡着），全是 `unloaded` 时放慢到 5s。一次 `GET /models` 的响应实测约 25 KB（19 个模型，`args` 占大头），降频省掉空闲期的回环流量；坏响应（解析失败）**保持**当前节奏，不会因为一次失败就放慢。
  - 前端"休眠"胶囊读的是同一个 `status.value`（`src/utils/models.ts:124`），所以日志里的卸载时机与界面显示一致。
  - 线程只监测自己启动时看到的那个 pid（与 `router::spawn_monitor` 同一套判断），router 重启后旧线程自动退出，不会随重启次数累积。

### 2.4 鉴权：配了 key 之后，除 `/health` 外全要鉴权
- 只认请求头：`Authorization: Bearer <key>` 或 `x-api-key: <key>`；**`?api_key=` 一律 401**。
- 因此 **`EventSource` 用不了**（无法自定义请求头）。`/models/sse` 必须用 `fetch` 流式读取（`src/api/router.ts`）。
- 清空 key 后命令行里必须**没有** `--api-key`，否则 router 仍要鉴权而界面按"没有 key"发请求 → 全 401，表现为"模型列表读不出来、模型也加载不了"（`cleared_api_key_leaves_no_flag` 测试守着）。
- CORS 实测：`OPTIONS` 预检返回 200 且 `access-control-allow-headers: *`，所以 webview 里带自定义 `authorization` 头是允许的。

### 2.5 `?reload=1` 才是真的重读 preset
router 把 preset 读进内存后，删掉 preset 段**不会**让模型从 `/models` 消失。
- 「刷新模型」= 重新扫描 + `GET /models?reload=1`。漏掉 `reload` 就是"已删除的模型刷新后还在"和"新模型刷新不出来"这两个老毛病。
- 保存单个模型配置后同样要 reload 才生效。

### 2.6 参数会被上游淘汰：`no-mmap` → `--load-mode`
llama.cpp **b11065 删掉了 `--no-mmap`**，替代品是 `--load-mode`（`auto|none|mmap|mlock|mmap+mlock|dio`）。
preset 里残留 `no-mmap = true` 的后果不是"这个参数失效"，而是 **router 整体启动失败**：
`failed to initialize router models: option 'no-mmap' not recognized in preset 'X'`。
- 应用的处理：`models.rs::RETIRED_PRESET_KEYS = ["no-mmap"]`，在 `sanitize_preset_keys` 里**逐行丢弃**（不迁移成 `load-mode`）；`ModelSheets.tsx::RETIRED_KEYS` 让淘汰键不出现在配置弹窗里。
- **升级 llama.cpp 后 router 起不来，第一件事是查日志里有没有 `option '…' not recognized in preset '…'`**，有就往 `RETIRED_PRESET_KEYS` 里加键。

### 2.7 共享 CUDA 运行时：Windows 的 DLL 搜索**不递归**
要让用户目录下不同版本的 llama.cpp 共用同一份 CUDA 运行时，必须把**直接包含** `cudart64_*.dll` / `cublas64_*.dll` 的那个目录注入子进程 `PATH`（指向它的父目录无效）。注入会被 router 与它 spawn 的模型子实例逐级继承。

### 2.8 非 ASCII 路径
llama.cpp 以 ANSI 语义传递自身路径，路径含中文会让模型子实例 spawn 失败。应用用 `mklink /J` 建纯 ASCII 链接目录再启动（`winfix::ensure_ascii_dir`），状态里的 `ascii_fixed_from` 用于告知界面。

### 2.9 日志分流靠 `[%5d]` 前缀
模型子实例的 stdout/stderr 合进 router 同一个流，行首是 `[<端口>]`；端口不足 5 位会渲染成 `[ 8081]`（带前导空格）。分流前必须 `trim()`，否则那类子实例的日志会整体被归到「系统」。

### 2.10 其它前端约束
- CSP 是 `connect-src … http://127.0.0.1:* http://localhost:*`：要连新域名得改 `src-tauri/tauri.conf.json`。
- webview 对同一主机的并发连接有上限（约 6），所以 API 压测的并发放在 Rust 侧。

### 2.11 Strata 不是 llama.cpp 的 router（第二条运行时通道）
Strata 的二进制不同名、没有 router mode、管理端点与 llama.cpp 完全不同，config 是 `strata-*.json`（数组形式的 `args`）而不是 `presets.ini`：
- **不能塞进 router 流水线**：`versions.rs::scan_versions` 只认 `llama-server.exe`；`GET /models`、`POST /models/load|unload`、`GET /props`、`/models/sse` 在 Strata 上都不存在。
- 所以它是**并列的独立通道**：后端 `strata_*` 命令 + `bench_strata`，前端 `StrataPanel.tsx`；router 那条线一行不改 —— 方案与逐轮实现见 `STRATA_INTEGRATION_PLAN.md`。
- **config 写回必须「校验 → 备份 → 原子写」**，临时文件名要唯一（`strata.rs::temp_config_path`），整段写路径持 `strata_lock()`；只在 rename 那一步加锁没用。
- **WebUI 用系统浏览器打开**（`ipc.openLocalUrl`），不内嵌 iframe —— 这样 Strata 自带界面升级时这个 GUI 不必跟着改 CSP。
- 两条运行时的模型**显存互斥**：启动一边的模型前先卸掉另一边的（`settings.strata_router_mutex` 可关）。
- **一个端口 = 一份 config = 一个引擎**：多份 config 写同一个端口时（本机两份都是 9090）它们天然互斥，切模型必须先 `/unload` 旧模型（上游顺手保存 learned expert profile、立刻放显存）再杀进程树，见 `store.ts::startStrataModel`（§22）。
- **端口上跑的是哪份 config，只认 `/health` 的 `model`**：按端口猜归属会把在跑的实例记到别的卡片上（同端口多 config 时必错）。`lib.rs::attribute_strata_hit` 负责反查（有单测），报错信息一律点名模型名。
- **卡片播放按钮 = 启动引擎 + `/load`**：只起引擎不 `/load` 的话 `/health.loaded=false`，卡片永远显示「已停止」（用户 m00001 的「模型都无法启动」就是这个）。只有侧栏「启动 Strata」胶囊是纯启引擎（强制 `lazy_load: true`）。
- **卡片徽标的「支持 MTP」以 `args` 里带 `--mtp` 为准**（`strata.rs::StrataModelEntry.mtp` 只暴露 bool，MTP 权重路径不下沉 WebView，与 `has_api_key` 同口径）：`--mtp` 是安装器写下的安装事实（`STRATA_INSTALL_FACT_FLAGS`，GUI 只读、写回原样保留），所以它表示"这套安装给这个模型装了自带的 MTP 草稿头"。**不要改用模型名正则** —— 模型列表页那条 `/mtp/i.test(name)` 认的是文件名里带 MTP 的外挂草稿场景，对 Strata 的 config 会漏判和误判。`--spec` 是 MTP 验证窗口，写 `0` 时徽标显示虚线压暗的「MTP 关」（权重在装、投机解码当前关闭）。
- **`sampling` 是顶层字段，不是 flag**：`temperature` / `top_p` / `top_k` / `min_p` 写在 config 顶层的 `sampling` 对象里（`strataParams.ts` 的哨兵 `--sampling-*` **永不进 `args`**）。语义是「请求自己没带采样字段时的默认值」，改完要重启引擎才生效。上游对坏值**直接拒绝启动**（`temperature` ≥ 0、`top_p` 0 < v ≤ 1、`min_p` 0 ≤ v ≤ 1、`top_k` 1..64 的整数），所以保存前必须过 `validateStrataSampling`；块里 GUI 不认识的键（上游实验开关键）要原样保留。
- 引擎与它 spawn 的子进程都加 `CREATE_BREAKAWAY_FROM_JOB`（`winfix::no_throttle`）：GUI 被后台化时，子进程若继承宿主 Job Object 会被 CPU 节流，推理速度掉到个位数 t/s；父 Job 未开 `BREAKAWAY_OK` 时必须去掉该 flag 重试（`strata.rs::spawn_strata` 里有回退）。
- **前门代理（B 方案，用户 m00752/m00798）**：`settings.strata_host` / `strata_port`（默认 `127.0.0.1:9090`）是 GUI **进程内**的代理监听（`strata_proxy.rs`），客户端只连它，它按请求体里的 `model` 停旧引擎、起新引擎 —— 切换全程持 `state.strata_switch` 串行化，并等旧端口释放（`strata::wait_port_free`，20 s）。**引擎端口来自各 config 的 `port`，但真正被绑定的是 `run-<模型>.bat` 里的 `--port`**（上游 `server.py:5339/5559` 用 CLI 值，config 的 `port` 它根本不读），两处不一致时 `spawn_strata` 直接 bail 并说明原因。设置页的前门地址/端口**只写 GUI 设置、不写 config**（写进去会把各模型的引擎端口覆盖成 9090）；`api_key` / `idle_unload_s` / `min_free_vram_mib` / `before_load` 仍逐份写 config。
- **前门是「一个端口挂全部 config」**：`GET /v1/models` 由前门合成（当前引擎那份 `loaded`、其余 `unloaded`，形状照抄上游 `server.py:4313-4323`），没有引擎时 `GET /health` 也由前门合成；点名未知 `model` 一律 404 `model not found: {name}`（与上游同形，上游是 `server.py:4404-4405` 拿请求 `model` 与**当前实例**比对）。`lib.rs::strata_busy` **只算引擎槽位**（不算前门：前门不占显存，算进来会让托盘的「启动服务」一开局就变灰）；`RunEvent::Exit` 与托盘 `quit` 都要关前门。
- **前门的两条硬约束（都是实测踩出来的，改 `strata_proxy.rs` 前先读）**：
  1. **每条连接必须显式 `set_nonblocking(false)`**。监听套接字在 `start()` 里是 `set_nonblocking(true)`（非阻塞 accept + 30 ms 轮询），而 **Windows 上 `accept()` 返回的套接字会继承这个非阻塞标志**：不转回来的话所有 `read` 在没数据时直接返回 `WouldBlock`（`os error 10035`），读头/读体（`read_exact`）会随机失败、连接在请求体未读走时关闭，客户端看到的是 RST（「你的主机中的软件中止了一个已建立的连接」）。
  2. **绝不能在引擎生成期间向上游发 FIN（半关）**。上游 `serve/server.py:4127-4150 _watch_client` 每 0.5 s `select` + `recv(1, MSG_PEEK) == b""` 就把「请求套接字读到 EOF」判成**客户端挂断**并 `cancel.set()`，而取消只在提示读取的**分块边界**生效（`server.py:317`，块大小 8192 token）：症状是「小 prompt 侥幸成功、18859 token 的 prompt 在读到第一个块边界（约 5.7 s）时被取消」，引擎日志打 `0 generated ... (cancelled)`。所以前门**不挂**「客户端 → 引擎」的转发线程（请求体已由 `read_body` 整段读完、上游是 HTTP/1.0 + `Connection: close`），只做单向 `io::copy(上游 → 客户端)`。
- **前门服务状态要回传给前端**：`StrataStatus.proxy_serving`（正在服务的 config 文件名，`state.strata_proxy_serving` 这个 LIFO 栈 + `Serving` 守卫在 `Drop` 时摘掉并广播 `strata://status`）。卡片据此在 **DSH 请求触发加载**时显示「加载中」（`strataStarting` 只覆盖"用户在本页点启动"那条路径，用户 m01266 第 2 点）。排查连接类问题时可设环境变量 `STRATA_PROXY_DEBUG=1` 让前门把逐连接轨迹写进 `%TEMP%\strata-proxy-debug.log`（默认关闭）。
- **归属信息（`config_path` / `model_name` / `pid` / `started_at_ms` / `port`）只能在「槽位为空」时清**（用户 m01031）：引擎从 spawn 到端口监听之间、以及 `/load` 期间（上游 HTTP 服务单线程，加载 68 GB 权重时 `/health` 会超时）探测都会判「所有端口无响应」，而**探测失败不等于引擎没了**；以前这条分支无条件清 `config_path`，清掉之后 `running` / `model_name` / `loaded` 都能靠后续探测刷新回来，**唯独 `config_path` 补不回来**（它只由「外部实例」那条路写）⇒ 卡片永远「已停止」、面板计数停在 `0/3`，而侧栏写着「引擎运行中」。现在三层都堵上了：`merge_strata_probe` 每次探测都用槽位信息覆盖归属（`lib.rs::apply_owned_status`，有单测）、「无响应」分支在 `slot_owned` 时不动归属、`spawn_monitor` 在进程退出时把归属一起清掉（否则卡片会一直转「加载中」）；前端 `StrataPanel.tsx::runningEntry` 在 `config_path` 缺失时退回按 `/health` 的模型名认，并把「槽位里有引擎、端口还没应答」显示成「加载中」。

---

## 3. 前端约定

### 3.1 状态与数据流
`store.ts` 是唯一编排点；组件只读 store、调 store 的动作。要点：
- **API key 必须同步给 HTTP 层**：`useApp.subscribe` 里调 `setRouterApiKey(settings?.api_key)`，漏掉就是"设置里有 key、请求却 401"。
- **模型列表是三方合并**：扫描结果（`models_scan`）+ router 运行态（`/models`）+ `presets.ini` 段文本，再叠加 `settings.aliases` 与收藏。合并规则在 `utils/models.ts::mergeModels`；对回模型用三条线索：别名表 → 同名 id → 段文本里的 `model = <路径>`。
- **启动即出列表**：先用落盘缓存 `models-scan-cache.json` 渲染，再后台重扫，只有结果真变了才发 `models://scanned`（stale-while-revalidate）。该事件同时带 `aux_files`，否则后台扫描跑完辅助文件就没了。
- **组件文件只导出组件**（工具函数抽到 `utils/`），否则 Fast Refresh 失效。

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
（胶囊 / 徽标 / chip）不显式写行高时，行框会远高于字形：侧栏的 router 胶囊原本是 12px 字号 + 19px 行框
+ 12px 内边距 = **31px 高，而字形只占 12px**；加 `line-height: 1` 并把内边距收到 `0.25rem` 后是 **22px**。

**② `.mono` 自带 `min-height: 38px`**（legacy/index.css:1642，hub 原本给日志行/代码块用的）。
本应用把 `.mono` 当作「等宽小字」用在提示行、表格单元格、侧栏版本号上，于是它们**统统被撑到 38px 高、
文字贴着顶部**。侧栏底部「router 胶囊下方一片白」就是这个：那行版本号盒子有 38px，字只占 13px，
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
- **preset 写入最小化**：`preset_upsert` 只动涉及的键；用户手写的注释、未知键、`[*]` 全局段原样保留；清空某项 = 从段里删掉该键。
- **失效段清理 + 归档恢复**：段里的 `model` 指向的文件不在了 → 删段并存入 `removed-preset-sections.json`；模型回来时按段名把参数接回去。判据只有"文件不在"，没有 `model` 键的段一律不碰；若所有段都失效（≥3）判定为"模型盘没挂上"，跳过清理只提示。
- **多模态开关**：llama.cpp 在有 mmproj 时**自动**启用视觉，想关只能显式 `--no-mmproj`；开关就是在"不写键"与 `no-mmproj = true` 之间切换（关掉时顺手清掉手填的投影文件）。
- **启动时序两个坑**（`router.rs` 内有注释）：
  1. 必须**先接上 stdout/stderr 读取、再等端口就绪**，否则管道缓冲（Windows 匿名管道约 4KB）写满会让子进程卡住、永远不监听端口。
  2. 任何启动失败分支都要**先杀掉子进程**，否则句柄没进 `router_slot`，界面再也停不掉它（孤儿进程占端口和显存）。
- **停止不能直接 `wait()`**：kill 失败时会无限阻塞、界面表现为"停不了"；改为限时轮询 + `taskkill /T /F` 兜底。
- **日志里给 `--api-key` 打码**（`redact_args`）。

---

## 5. 最近这一批迭代（README 未覆盖）

### 5.1 兼容性与正确性
| 问题现象 | 根因 | 落点 |
|---|---|---|
| 启动提示"无效的 api key，模型也无法加载" | 配了 `--api-key` 后 router 全端点要鉴权，前端一个头都没带 | `api/router.ts` 全部请求带 `authHeaders()`；store 订阅设置变化调 `setRouterApiKey` |
| 填了 key 后模型加载进度不再更新 | `EventSource` 无法带鉴权头 | `/models/sse` 改成 fetch 流解析 + 重连（鉴权失败 6 次放弃，网络失败 40 次 ≈60 秒，扛得住 router 重启） |
| 压测报 `model '…' not found` | 前端发了扫描 id 而不是 preset 段名，合并时又没带别名 | `BenchPanel` 用 `selected.section`；`mergeModels` 传入 `settings.aliases` |
| 新增模型刷新不出来 / 已删除的模型还在 | router 内存里的 preset 快照没重读 | 刷新改 `?reload=1`（两处调用点） |
| llama.cpp 换成 b11065 后 router 起不来 | preset 里残留 `no-mmap` | `RETIRED_PRESET_KEYS` 逐行丢弃 + 配置弹窗不显示淘汰键 |
| mmproj / 草稿文件被当成主模型，配置里又选不到它们 | 扫描只输出主模型 | `aux_files` 通道 + 路径选择控件接 `aux_files` |

### 5.2 参数表单（`ParamForm.tsx` + `assets/params.json`）
- 上下文窗口大小 `ctx-size` 是**下拉**（4K/8K/16K/32K/64K/128K/256K），不是纯数字输入。
- `mmproj-device` / `spec-draft-device` 是**设备下拉**，选项来自 `device_list`，另有"（未设置，用模型默认）"。
- 路径参数三类：`mmproj`（文件，只看 gguf）、`spec-draft-model`（文件，全部模型）、`video-ffmpeg-dir`（**目录**，走 `open({directory:true})`）。
- JSON 参数是只读输入 + 代码图标按钮 → 弹窗编辑，保存时 `JSON.parse` 校验并去掉换行。
- select 的当前值不在候选里时补一个占位选项，避免显示成空白（参照实现旧版的"下拉空白"就是这个原因）。
- LOGIC / BOOLEAN 参数按 `false` / `true` 下拉呈现。
- 参数说明（问号）**不用原生 `title`**：点问号开 `#paramDescModal`（对齐 hub 旧版），正文限宽换行 —— 见 §3.4 ③。

### 5.3 显存预估（llama-fit-params）
配置弹窗左栏、「设备」区下方有「估算显存」按钮，结果就地显示成一张逐卡小表（设备 / 模型 / 上下文 / 计算，单位 MiB）。
- 后端：`lib.rs::fit_preview` 命令 → `gpu::fit_preview` 跑 `llama-fit-params --model <gguf> -fitp on`（`-fitp` = `--fit-print`，默认 off），解析在 `gpu::parse_fit_preview`。
- 实测输出形如 `CUDA0 603 3584 298`，多卡每卡一行，另有 `Host` 行（= 留在系统内存的部分，界面显示成「Host（内存）」）。
- 依赖所选版本目录里带 `llama-fit-params.exe`（扫描时记为 `fit_params_bin`，版本表里有一列 ✓/—）；缺了会返回一句可读的提示，而不是失败在别处。
- **结果按模型各记一份**（`fitPreviewCache`，`utils/fitCache.ts`，最多 30 个模型、超出丢最旧的）。
  条目里记着模型路径、**参数指纹**、llama.cpp 版本与设备集合。重开弹窗（或重启应用后打开同一个模型）
  直接显示上次结果并标注「上次估算 HH:MM」；**参数动过只提示「结果可能要重算」，不自动跑**（一次要几秒，
  由用户点「重新估算」）。
  - 指纹**只含与显存相关的参数**（`NON_MEMORY_KEYS` 排掉采样/线程/结构化输出那些）——
    早期用全量 entries，改个温度也会提示重算，纯噪音；而 `kv-unified` / `mmproj` / `spec-*`
    虽然 fit-params 不认、却确实影响占用，必须留在指纹里。
  - 存储位置：WebView2 的 localStorage，落盘在 `<便携目录>\webview\EBWebView\Default\Local Storage\leveldb\`（回退到系统目录时在 `%LOCALAPPDATA%\dev.llamacpp.gui\` 下）。
    排查时可以直接读这个 leveldb 文件（字符串是明文，搜 `fitPreviewCache`）确认存了什么。
- **参数会一起传过去**（`gpu::build_fit_args`）：显存占用与右边那套参数强相关，不传就是白算。
  白名单是拿 `llama-fit-params --help` 的**选项定义行**与 `params.json` 的键求交集得来的
  （`tmp/fit-whitelist.mjs` 可随时重算，help 存于 `tmp/fit-params-help.txt`）。实测会改变预估的有：
  `-c`（默认 ctx 就是 32768，所以传相同的值看不出变化）、`-ctk/-ctv`（KV 量化，3584→1904）、
  `-b/-ub`（计算缓冲 298→1192）、`-ngl`、`-n-cpu-ffn`（603→565）、`-nkvo`（KV 转到 Host）、`-ts`、
  `-np`（并行槽位数，`--parallel 4` 把上下文占用抬上去）。
  **布尔键的取反**：只有 help 里成对出现的（`kv-offload`、`op-offload`）才允许 `为假 → --no-xxx`；
  `cpu-moe` / `swa-full` 没有 `--no-` 形式，传了直接 `error: invalid argument`（实测）。
- **筛选白名单别用关键词**：早期按 cpu/offload/moe 这类关键词筛，漏掉了 `parallel` 与 `lazy-mode`。
  用 `tmp/fit-whitelist.mjs` 跑**全量交集**再人工判断，才是可靠做法。
- **局限**：`llama-fit-params` 不认 `--mmproj` / `--model-draft` / `--kv-unified`（实测 invalid argument），
  所以多模态投影、草稿模型本体、投机解码（`spec-type`，含模型自带的 `draft-mtp` MTP 头）、`kv-unified`、
  `--mmproj-offload` 这些占用**算不进表里** —— 界面会在表下用黄色小字列出「未计入：…」。
  它也不建模 CUDA context / cuBLAS workspace 这类固定开销。按「全部可见设备 + 设置里选中的版本」计算，
  不套用弹窗里勾选的设备与主 GPU。
- **实例（35B-A3B MoE，2026-09-21 实测）**：preset 段 `ctx-size 131072 + cache-type-k/v q8_0 +
  ubatch-size 1024 + gpu-layers 99 + n-cpu-moe 26 + flash-attn on + load-mode mmap+mlock` 算出
  `CUDA0 8105 / 1422 / 994`（≈10.3 GiB）+ `Host 13187`。该模型另外开着 `spec-type = draft-mtp`
  与 `kv-unified = true`，这两项**不在数字里**，实际占用会更高。

### 5.4 服务卡片与重启询问
设置页「服务」卡＝端口 / 同时加载模型上限 / 空闲释放模型（秒）/ API Key + 保存。
端口 / 上限 / 空闲释放 / API Key 都是 router 的**启动参数**，改了必须重启才生效，所以保存时若发现变化就弹 `#restartRouterModal`：
标题「警告」，正文「服务参数发生了变化，需要重启 router 才能生效。」，按钮 **暂不重启 / 立即重启**；正文**不列**变更清单（用户明确要求简洁）。
空闲释放语义：`-1` / `0` / 空都表示关闭，只把 `> 0` 的值写进设置。

### 5.5 图标
- 应用图标（exe / 任务栏 / 窗口）＝ `icons/icon.ico` 的**第一项**（`tauri-codegen::CachedIcon::new_ico` 取 `entries()[0]`），所以第一项必须是 **64px 两层**图形；`bundle.icon` 里的 PNG 在 Windows 上不起作用。
- 安装包图标由 `bundle.windows.nsis.installerIcon` 决定（原先没设 → 安装包显示 NSIS 默认的绿色箭头图标）。
- **`tauri-build` 不监听 `icons/*`**：换图标后必须删掉它的产物再构建，否则 exe 里还是旧图标：

```powershell
Remove-Item -Recurse -Force src-tauri\target\release\build\llamacpp-gui-*, src-tauri\target\release\.fingerprint\llamacpp-gui-*
npm run tauri build
```

- **Windows 图标缓存按路径记**：覆盖同名 exe 后资源管理器仍显示旧图标（把 exe 复制成另一个名字就显示新图标，可用来证明二进制本身没问题）。刷新办法：`ie4uinit.exe -show`；顽固时删 `%LOCALAPPDATA%\IconCache.db` 与 `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache*` 再重启 explorer；任务栏固定项要取消固定再重新固定。
- 全部图标资产由 `node scripts/make-icons.mjs` 生成（解析式绘制 + Node zlib 自编码 PNG，不依赖图形库），同时输出窗口图标与 `tray_icon.rs` 里的托盘 RGBA 常量。约定：四周留白 8%；≤40px 用两层简化图形（三层加细闪电在小尺寸下会糊）。

---

## 6. 构建、测试、验证

```powershell
npm install                        # 受限沙箱里需要 --ignore-scripts
npm run cargo:proxy                # 另开终端保持运行：本机 crates 代理 http://127.0.0.1:8787
npx tsc --noEmit                   # 前端类型检查（在仓库根执行）
cd src-tauri; cargo test --lib      # 后端单元测试（当前 99 passed / 5 ignored）
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

### 6.1 `tmp/` 里的验证资产（非交付物，可直接复用）
| 脚本 | 用途 |
|---|---|
| `tmp/router-client.mjs` | 直连 router 的基本读写（列模型 / 加载 / 卸载） |
| `tmp/router-auth-check.mjs`、`auth-probe.mjs`、`webui-auth-probe.mjs` | 鉴权行为验证（无 key=401、`?api_key=` 无效、两种请求头可用） |
| `tmp/cors-probe.mjs` | 预检与 CORS 头验证 |
| `tmp/probe-sse.mjs`、`sse-restart-check.mjs` | SSE 订阅与 router 重启期间的断线重连 |
| `tmp/bench-model-check.mjs` | 压测模型 id / 别名合并断言（10 项） |
| `tmp/find-retired-params.mjs`、`find-blank-selects.mjs`、`dump-template-group.mjs` | 参数表体检（淘汰键、控件空白、分组内容） |
| `tmp/verify-preset-repair.mjs`、`verify-alias.mjs`、`router-reload-check.mjs` | preset 段修复、别名、`?reload=1` 行为 |
| `tmp/fit-cache-test.mjs` | 显存预估缓存逻辑（命中 / 版本失效 / 设备失效 / 上限裁剪 / 坏数据）10 项断言，`node tmp/fit-cache-test.mjs` |
| `tmp/help-b11065.txt` | b11065 的 `--help` 全文（查某参数是否还存在） |
| `tmp/preset-noNommap.ini` | 去掉 `no-mmap` 后的 preset 副本（复现"清理后能启动"） |
| `tmp/*-preview.html`、`*-now.png` | 界面 / 图标的一次性预览产物 |
| `tmp/nsis-hook-test.nsi` | 卸载钩子的语法校验：`& "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe" /INPUTCHARSET UTF8 tmp/nsis-hook-test.nsi`（Tauri 打包时会自动下载 NSIS） |
| `tmp/tauri-installer.nsi`、`tmp/tauri-nsis-mod.rs` | Tauri 2 的 NSIS 模板与打包器源码副本（查 `NSIS_HOOK_*` 的插入位置、makensis 参数） |

> `scripts/smoke-paramform.mjs` 是仓库内的正式冒烟测试：用真实 React 渲染 `ParamForm`，防止"下拉渲染对象导致白屏"复发。它需要 esbuild，受限沙箱里要提权。

---

## 7. 运行时数据文件

**便携目录 = exe 所在目录**（`src-tauri/src/paths.rs`）：发布版优先把配置写在 exe 旁边，
装到不可写位置（如 `C:\Program Files`）时自动退回 `%APPDATA%\dev.llamacpp.gui\`；
dev 构建（`tauri dev` / `cargo test`）**永远**用 `%APPDATA%` —— 否则真实配置会被搬进 `target/debug`。
便携目录会写进「系统日志」：`[gui] 便携模式：配置目录 …`。
**旧版本的 `%APPDATA%` 数据不再自动搬运**（2026-09-22 移除）：便携目录里没有配置就按全新安装处理，
需要重设 llama.cpp 目录、模型目录与 preset；`%APPDATA%\dev.llamacpp.gui\` 只作为不可写位置的回退目录。

下列文件都在便携目录下：

| 文件 | 内容 | 注意 |
|---|---|---|
| `settings.json` | 全部用户设置（见 §7.1） | 未知字段会被保留（`Settings.extra` 的 `#[serde(flatten)]`，测试 `unknown_settings_fields_survive_a_patch`）；读失败时本次启动只读，不写回默认值 |
| `presets/presets.ini` | 交给 router 的原生 preset，由应用维护 | 用户手写内容会保留；文件头是 `version = 1` |
| `models-scan-cache.json` | 上次扫描结果（启动先渲染它） | 按 `model_roots` 校验，换根目录即作废 |
| `gguf-meta-cache.json` | gguf 元数据（架构、量化）缓存 | |
| `removed-preset-sections.json` | 失效段的归档（模型回来时恢复参数） | |
| `runtime/` | 非 ASCII 路径的 `mklink /J` 链接目录 | |
| `bench/records.json` + `bench/*.txt` | API 压测记录与导出文本 | |
| `webview/EBWebView/` | WebView2 的数据：localStorage（§5.3 的显存预估缓存、参数分组折叠状态）+ 浏览器缓存 | 约 90 MB；删掉只是丢这些 UI 偏好 |

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

### 7.1 `settings.json` 字段（当前实现）
`llama_cpp_dir`、`model_roots[]`、`shared_lib_dirs[]`、`selected_version`、`port`(8080)、`models_max`(4)、`sleep_idle_seconds`(-1)、`api_key`、`gpu{devices[], split_mode, tensor_split, main_gpu, fit, fit_target, n_gpu_layers}`、`autostart`、`minimize_to_tray`(true)、`auto_start_router`(true)、`favourites[]`、`aliases{扫描 id → 段名}`、`view{mode, density}`、`window{width,height,x,y,maximized}`、`version_cache{版本名 → {has_router_mode, probed_at_ms}}`。

`SettingsPatch` 是命令入参的白名单：**加设置项要同时改 `Settings` 与 `SettingsPatch`**，否则前端保存后不落盘。

---

## 8. 未决项与已知遗留

1. **性能测试面板切换标签会丢状态**（压测参数与结果留在组件里，没有提升到 store）。
2. ~~**模型列表每张卡片重复解析 `presetText`**（大列表时的性能点）。~~ ✅ 已修：`ModelCard` 改为 `memo`，父组件用一次 `useMemo` 算出 `webuiDisabledSections(presetText)`（`CODE_REVIEW.md` §1.2 的 M24）。
3. **原路径 exe 的图标**：二进制已是新图标（复制成别的名字能正常显示），只是 Windows 按路径缓存；需要时按 §5.5 处理。
4. `tmp/` 有 100+ 个验证产物，可随时清理，但请保留 §6.1 列出的那些。
5. **Strata 引擎在显存耗尽后会卡死，不是 GUI 的 bug**（2026-10-11 实测，用户 m01266 排查副产品）：反复打大 prompt 之后 `/status` 长挂 `phase=reading the prompt`/`thinking`、`elapsed_s` 一直涨、`tokens_per_s` 掉到个位数，此后**所有**请求（连 `curl` **直连引擎端口**绕开前门也一样）要么空回复、要么只收到 236–428 B 就被断开。引擎日志自己给了原因与建议：`0 MiB of VRAM free with everything loaded - LOW: requests may stall; add --vram-reserve-mib 512 to the config's args (or lower --max-context)`（本机 12227 MiB 卡、权重约 40 GiB）。处置：杀掉 python 进程树后前门会在下一个请求冷启动新引擎；根治要在 config 的 `args` 里加 `--vram-reserve-mib`（按引擎自报值，GUI 不替用户写 args 类参数，需用户决定）。**2026-10-11 用户定稿：三份 config 统一 `--kv-resident 30720`，`--vram-reserve-mib` 两份 512、`swift-1.5-iq3_xxs` 不传（引擎默认 700 MiB）；实测 3909 / 3918 / 2770 槽，三份都不再报 LOW（IQ3_XXS 每槽约 2.2 MiB，明显大于 IQ2 系列的 1.376 MiB）。手改 config 删这个参数必须连值一起删 —— 只删 flag 会变成 `--vision 782`，引擎打印用法后直接退出（前门连试 3 次全失败）。完整显存账与杠杆见 `STRATA_INTEGRATION_PLAN.md` §22.10。**

6. **2026-10-14 三份新方案的决策全部定稿（13 项）**，落点见 `PROXY_SCHEDULER_PLAN.md` §10 决策结果、`WEB_SEARCH_PLAN.md` §11 决策结果、`STRATA_MANAGER_PORT_ASSESSMENT.md` §7 决策结果。要点：**① router 立刻退役**，不留兼容模式（统一入口只留 9090，8210 消失；`settings.json` 的 `port` 语义改为前门固定端口；前端四处显存互斥 `src/store.ts:881`/`:920`/`:1005`/`:1165` 与设置项 `strata_router_mutex` 在前门化后删除，`src/api/router.ts:240` 的 `chatTargets` 作废，`src/store.ts:750` 在用）；**② 容量策略 = 多模型驻留 + spawn 前 `fit` 预览 + 不够先卸最久未用，上限 `models_max` = 4**，端口号段不回收；**③ 联网搜索改 Rust 重写**，不引入 Node 运行时，只保留 5 个引擎（anysearch/keenable/tavily/exa/firecrawl），新模块 `src-tauri/src/search.rs` + `search.json` + Tauri command，TLS 用 reqwest 去默认 feature + `json` + `native-tls`（走系统 SChannel，不编 ring）；**④ 建原生聊天 UI —— 正式推翻 `REFACTORING_PLAN.md:63`，连带恢复 `:77` 用量统计与 `:78` 实时速度显示**；**⑤ 监控两通道都做硬件指标**（新增 `sysinfo` + NVML/`nvidia-smi` 解析，非 N 卡优雅降级）；**⑥ 用量统计做完整逐请求明细**（走 server 日志解析）；**⑦ BenchPanel 合并成一个多标签页，且 UI 样式必须统一**（按 `STRATA_MANAGER_PORT_ASSESSMENT.md` §5 的三条冲突处理）。

7. **UI 样式基座迁移已立项（2026-10-14），实施规格在 `UI_STYLE_BASELINE.md`，尚未动代码**。全站统一到 Strata 设计系统：色板（accent 由 indigo `#6366f1` → 绿 `#10b981`，深色 `#34d399`；浅色主题下 `--primary-color`/`--success-color`/`--info-color`/`--danger-color` 现在全是近黑 #000000/#111111/#111111/#1f1f1f，换完会变彩色，是本轮最大观感跃迁）、字体（Outfit 拉丁 + MiSans 中文子集；**Outfit 无 CJK 字形**）、图标（退役 FontAwesome，改自有 sprite + `<Icon name>`）。必须知道的实测数：**CSS 硬编码 hex 276 处**（`legacy/index.css` 238 + `app.css` 38）、**font-size 235 处 12 个离散值**、**内联 `style={{}}` 130 处**（`SettingsPanel.tsx` 独占 45）、**fa 图标 152 处 / 68 个 unique**、**`#id` 选择器 296 处**（hub 遗产，只减不增）。顺带要清的死资源：`legacy/css2.css` 19 个 `@font-face` 中 17 个无人引用且 4 个 `url` 指向缺失文件、`legacy/index.css:2662`/`:2675` 声明仓库里并不存在的 `'Font Awesome 5 Free'`、`legacy/index.css:192` 引用无字体的 `'Inter'`。**排序约束：S1–S8 基座（含清内联与断点统一）前置于聊天 / 监控 UI / 用量统计三个面板**，后端里程碑（前门调度、容量闸、Strata 并口）可与样式并行。**token 文件三条硬规定（2026-10-14 用户定稿）**：文件名与上游同名 `src/styles/tokens.css`；上游 `--st-*` 87 行**全量照抄**为唯一真源（不裁剪、不改名、不合并）；旧变量名（`--bg-color` / `--card-bg` / `--text-primary` 等）**只作兼容别名**给 705 处存量引用，**新代码一律不准用**（只减不增）。详见 `UI_STYLE_BASELINE.md` §3。
   **实施排序约束（由 ① 派生）**：GUI 现在靠 router 的 `status.args` 解析端口决定往哪发，router 一退役该链路即断 —— 前端单端点化必须与前门 P1 同批交付，不能排到最后。
   **待实现当天同步的约定**：本文 §2 的铁律 1（不给 router 传 `--no-ui`）、铁律 3（`GET /models?reload=1`）、以及 `AGENTS.md` 里与之同源的两条，在前门落地后失效（不再有 router 进程）；铁律 2 的 preset 段名请求与铁律 5 的淘汰键检查仍然有效。

8. **2026-10-14 样式基座追加两条结构决策（规格在 `UI_STYLE_BASELINE.md` §10.5 / §10.7）**：**⑦ 设置页照上游形态重构** —— `src/components/SettingsPanel.tsx` 739 行、45 处内联（全站内联的 35%）现在是 14 个 tab 的长页堆叠，改为「左侧分组导航列表 + 右侧 `.st-card` 分组 + `<details>` 折叠 + 行式开关」，原 S5 里「SettingsPanel 45」一项改由 S7 消化；**⑧「运行环境」页并入设置页** —— `src/App.tsx:15` 的 `Tab` 去掉 `"runtime"`、`:25` 顶栏项删除、`:321` 条件渲染删除（**顶栏 tab 6 → 5**），`src/components/RuntimePanel.tsx` **262 行删除**，其中**只并入版本表一块**（设置页「服务」组首卡，按钮改名「扫描 llama.cpp 版本」，共享 CUDA 运行时目录列改折叠）；**前门启停按钮不进设置页**（唯一手动入口 = 侧栏左下角 `.router-pill` 胶囊 `src/App.tsx:234-316`，前门化后两颗合并为「前门 :9090」一颗，见 `UI_STYLE_BASELINE.md` §10.8）；**推理设备表、多卡策略说明段、路径信息一律退役**（用户决策），但 **`src/store.ts` 与 `src-tauri/src/gpu.rs` 一行不改** —— 设备数据仍被 `src/components/ModelSheets.tsx`（`:119`/`:185`/`:291`/`:362`/`:457`/`:460`/`:545`/`:561`/`:580`/`:593`）、`src/components/ParamForm.tsx:586`/`:590`、`src/components/BenchPanel.tsx:38`/`:392` 消费。样式基座合计工时随之从 ≈7–10 天变为 **≈10–13.5 天（S1–S8）**。
9. **断点统一为 640 / 900 两档（决策 9，2026-10-14 用户定稿，规格在 `UI_STYLE_BASELINE.md` §10.4）**：全站 `@media` 由 **6 档**（900×15 / 768×5 / 640×2 / 960×1 / 1000×1 / 1100×1 + `min-width:901`×2 + `prefers-reduced-motion`×1）收敛为 **640 / 900 两档**，主断点取 900 —— **取代上游的 1000**（上游面板尚未移植，改写为零成本；反之把主断点提到 1000 会让 901–1000 区间从「桌面排版」变「移动排版」，等于改掉 15 处既有规则的效果）。迁移：**6 处改判为 900**（`legacy/index.css:324`、`:835`、`:1190` 由 768→900；`:2919` 960→900；`:3200` 1000→900；`:1976` 1100→900）、**2 处删除**（`:3068` 空块；`:3788` 与 `:3718` 重复，两处都是 `.settings-field-row{grid-template-columns:1fr}`）、**19 处不动**。**这是样式基座里唯一会改变既有页面行为的动作**：901–960 更新结果区恢复多列、901–1000 HF 面板恢复双列、**901–1100 HF 分栏恢复横排（风险最高，验收重点）**。新增 **S8**（0.5 天，排在 S7 之后、S6 之前）+ 独立验收矩阵（1440/1100/1000/900/899/640/480 × 明暗两主题）。硬约束：**`@media` 条件不能引用 CSS 变量**（`@media (max-width:var(--bp))` 无效，需 `@custom-media` + PostCSS 插件，本项目无预处理器、不新增构建步骤）→ 两个字面值靠 `AGENTS.md` 铁律 8 约束，不能 token 化。**HF 两处已确认按 900 走**（用户 2026-10-14 定稿）：`legacy/index.css:1976`（原 1100）与 `:3200`（原 1000）并入 900 后，901–1100 宽度下 HF 页恢复左右分栏，验收时逐一目视，**若拥挤再单独议**（届时只能局部破例加一档）。
10. **2026-10-14 用户追加决策：监控不做浮窗、托盘也不显示监控** —— `STRATA_MANAGER_PORT_ASSESSMENT.md` §7 决策结果 5，§6 的 **P6 已取消**（省 3–5 天）。即第 6 条的 ⑤「监控两通道都做硬件指标」**只落在主窗口内的监控页面上**：上游那套 Tauri 浮窗（`floating_monitor.rs` 481 行 + `FloatingTelemetryWindow.tsx` 202 行）、监控托盘（`monitor_tray.rs` 418 行：点阵速度数字图标 + 遥测 tooltip）、窗口级命令白名单（`invoke_policy.rs` 121 行）**整块不搬**。本工程托盘维持现状（`src-tauri/src/tray.rs` 199 行：菜单 + tooltip + 关窗隐藏 + `--minimized` 自启动），**不加遥测数字**；将来若要恢复，先读 §7 决策结果 5 记录的上游文件清单（已在 `E:\Code\strata-manager-main\apps\desktop` 实测）。
11. **2026-10-14 用户定稿：llama.cpp 侧配置层改为「一个模型一份 JSON」，`presets.ini` 彻底退役**（完整规格在 `PROXY_SCHEDULER_PLAN.md` §3.1，决策见该文 §10 决策结果 5）：
    - **目录**：`<exe 目录>\config\llamacpp-<id>.json`（便携目录 = exe 所在目录，见 `src-tauri/src/paths.rs:21-24`）。`config\` **只放模型 JSON**；`settings.json`、`models-scan-cache.json`、`gguf-meta-cache.json`、`removed-*`、`bench\`、`webview\` 位置**一律不动**。
    - **命名**：`llamacpp-` 前缀 + `<id>` = **原 preset 段名**（前端选中项、日志、请求 model 名全部不变）；非法文件名字符（`/ \ : * ? " < > |` 与首尾空格、点）统一替换为 `-`，重名追加 `-2` / `-3`；扫描 `llamacpp-*.json`，排除 `.bak*`。
    - **结构**：`args` 数组（直接是 `llama-server` 命令行参数，**不含** `--port` / `--host` / `--model` / `--mmproj`，这四个由顶层字段生成）+ 顶层契约字段 `name` / `model` / `mmproj` / `exe` / `port` / `host` / `api_key` / `no_webui` / `log` / `cwd` / `env`；未知字段原样保留；`--model` / `--mmproj` 在「刷新模型」时由 GUI 按扫描结果自动修正，其余用户手改参数原样保留；`RETIRED_PRESET_KEYS` 过滤（铁律 5）继续生效。
    - **缺配置**：扫描到模型但 `config\` 无同名 JSON → 自动补一份最小 JSON（与现在 `preset_sync` 行为等价）。
    - **存量迁移**：`<配置目录>\presets\presets.ini`（本机 14 段）**首次启动一次性迁移**为 14 份 JSON，ini 改名 `presets.ini.bak-<时间戳>` 保留；**迁移失败不删 ini 并明确提示**，全部成功才写迁移标记。
    - **连带改动 8 处**：`src-tauri/src/state.rs:307-309`（`preset_path()` → `config\` 目录）、`src-tauri/src/models.rs:1275-1600`（ini 字符串级读写 → JSON，原子写沿用 `models.rs:1561` 临时名 + pid）、`src-tauri/src/lib.rs:1213-1350`（8 个 preset 命令参数从「段」改「id」）、`src-tauri/src/lib.rs:1444`（归档从 `removed-preset-sections.json` 改为移入 `config\.orphan\`）、`src-tauri/src/models.rs:1939`（hub 导入写 JSON 的 `args`）、前端 `src/ipc.ts:86-97` + `src/store.ts:393`/`:556`/`:640`/`:686` + `src/types.ts:237`/`:273-274` + `src/components/RuntimePanel.tsx:249`（段名 + 整份 `presetText` → id + 单份 JSON）、**铁律 2**（「用 preset 段名」→「用 JSON 的 `name`」）、**`settings.aliases` 整表退役**（2026-10-14 用户定稿：模型身份改按 gguf 路径 ↔ JSON `model` 字段匹配，改名 = 改写 JSON 的 `name` 字段（文件名 id 不动），归档恢复按 id 查 `config\.orphan\`；这张表原先兼作「扫描 id → 段名」的桥与显示别名两用，退役动作与迁移处理见 `PROXY_SCHEDULER_PLAN.md` §3.1）。
    - **归属**：**与 M1 同批**（前门本来就要读配置来 spawn 子进程，拆开等于把配置层改两遍），约 **+2–3 天**，计入 M1，不新增里程碑。
    - **作废**：`PROXY_SCHEDULER_PLAN.md` §3 原稿「preset 段新增 `port`」写法、以及「兼容模式两条生成路径不能共用丢弃清单」这条约束，一并失效（已定「不留兼容模式」）。
12. **参考源码位置（2026-10-14 用户要求记录，摘要版在 `AGENTS.md` §「参考源码」）**：
    - **strata-manager**（上游参考实现，Tauri 2 桌面壳 + React 前端）：根 `E:\Code\strata-manager-main`；桌面壳 Rust `apps\desktop\src-tauri\src\`（21 个 `.rs`：`floating_monitor.rs` / `monitor_tray.rs` / `invoke_policy.rs` / `supervisor_client.rs` / `window_layout.rs` …）；桌面壳前端 `apps\desktop\src\`（`FloatingTelemetryWindow.tsx` / `serviceStatusTelemetry.ts` / `layouts\ServiceTelemetryStatusBar.tsx` …）；supervisor `apps\supervisor\src\main.rs`。**Strata 引擎与服务（Python）**在另一处：`E:\AI\Strata\serve\`（`server.py` / `frontend.py`）+ 网页面 `E:\AI\Strata\serve\web\`（`tokens.css` / `components.css` / `app.css` / `sprite.svg` / `fonts\` / `app.js`）。逐文件移植清单见 `STRATA_MANAGER_PORT_ASSESSMENT.md`。
    - **llama.cpp router 源码**：实跑二进制是 `E:\AI\llamacpp\llama-b11482-bin-win-cuda-13.4-x64`，对应在线源码 `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11482/tools/server/server-models.cpp`（router 主体 2,370 行，本工程已抓副本 `tmp\router-server-models.txt` / `tmp\router-server-models.raw.txt`）。本机另有一份 vendored 副本 `E:\AI\Strata\third_party\llama.cpp\tools\server\`（13 个 `.cpp`，`server-models.cpp` 99,962 B，`CMakeLists.txt` 版本 `0.4.1-dev`，**非 git 检出**）—— 它是 Strata 自带，与 b11482 **未必同一 commit**，核对 router 行为以 b11482 在线源码为准。上游仓库 `github.com/ggml-org/llama.cpp` 的 `tools/server/`。

---

## 9. 新会话怎么获得上下文

1. 先读本文件（§2 的约束、§8 的遗留），再按需要看 `README.md` / `REFACTORING_PLAN.md`。
2. 会话之间不会自动继承上下文：把结论写进仓库文档（推荐），或在新会话用 `@` 引用旧会话（只得到有界只读快照，会被截断）。
3. 改代码前后请遵守：先 `npx tsc --noEmit` + `cargo test --lib`；涉及 llama.cpp 行为的改动，先看 §2 有没有相反结论，再考虑补一个把该行为钉住的单元测试。
