# llama.cpp GUI

> **本项目 fork 自 [llama.cpp-hub](https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub)**（作者 Mark）。
> 上游是给 llama.cpp 套 Web 壳的图形化工具（PWA，Java 后端 + Web 前端），本项目把它做成 Windows 桌面应用
> （Tauri 2 + Rust + React），并保留对其 `config/launch_config.json` 的迁移支持。
> 上游以 **MIT** 许可发布，本项目的版权与许可声明见 [`LICENSE`](./LICENSE)。

Tauri 2 桌面外壳，管理本机全部 llama.cpp 模型：统一入口（前门 ≥9090 一个端点）、模型扫描与配置（一个模型一份 JSON）、
多模型驻留与容量闸、日志、原生聊天（联网搜索 / 读网页正文 / MCP 工具）、监控、性能测试、托盘。推理本身全部交给
llama-server，GUI 只做进程管理、配置与观测。

设计文档：

- `HANDOVER.md` —— **交接说明**：llama.cpp 行为约束、代码地图、验证手段、坑与未决项（接手先读这份）
- `docs/archive/ITERATION_LOG.md` —— 0.1.x → 0.2.0 的逐轮实现日志：每次改动的起因、实测证据、踩过的坑
- `docs/archive/DECISIONS-2026-10.md` —— 2026-10 的关键决策与落地结果
- `docs/archive/PROXY_SCHEDULER_PLAN.md` —— **前门调度与配置层**：统一入口、按请求停旧起新、容量策略、`config\llamacpp-<id>.json` 规格（已落地）
- `docs/archive/STRATA_INTEGRATION_PLAN.md` —— **Strata 第二运行时通道**：调研、方案与逐轮实现记录（已全部落地，§11 起是实现记录）
- `docs/archive/STRATA_MANAGER_PORT_ASSESSMENT.md` —— 上游 strata-manager 的能力移植评估（聊天 / 监控 / 压测，含 P1–P8 与决策记录）
- `docs/archive/WEB_SEARCH_PLAN.md` —— 联网搜索方案：五引擎测速与选型、Rust 重写决策、`search.json` 规格
- `docs/archive/UI_STYLE_BASELINE.md` —— 样式基座：Strata 色板 / 字体 / 图标与 S1–S8 实施分解（已落地，S4 已回退保留 FontAwesome）
- 历史存档（**不要按里面的行号回查**）：`docs/archive/REFACTORING_PLAN.md`、`docs/archive/REFACTORING_REVIEW.md`（0.1.x 的 router + `presets.ini` 设计基线）、`docs/archive/CODE_REVIEW.md`（0.1.x 静态审查，多数已修）

---

## 当前进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1** | 工程骨架、设置持久化、目录选择 | ✅ |
| **P2** | 版本发现（含共享 CUDA 匹配）、设备枚举、router 生命周期与环境注入、日志采集、Runtime/Settings/Logs 三页 UI | ✅ |
| **P3** | 模型递归扫描 + `presets.ini` 生成 + 模型列表页 + 配置面板 | ✅ |
| **P4** | 日志页增强（模型 id 映射、源过滤联动） | ✅ |
| **P5** | API 压测（原 `llama-bench` 面板已移除，见下方说明） | ✅ |
| **P6** | 托盘常驻 + 开机自启 + 打包 | ✅ |
| **P7** | Strata 第二运行时通道（引擎启停、模型选择、参数编辑、显存互斥、压测） | ✅ |
| **P8** | 原生聊天（SSE + 联网搜索 + 读网页正文）与 MCP 工具接入（GUI 当 MCP 客户端） | ✅ |

> 下面「P2 / P3 已实现的能力」是 0.1.x 时期的实现描述：**router mode 与 `presets.ini` 已在 0.2.0 退役**
> （换成前门调度 + `config\llamacpp-<id>.json`，一个模型一份 JSON），扫模型、日志、进程生命周期这些能力仍在，
> 只是配置载体变了。0.2.0 的现状以 `HANDOVER.md` 为准。

P2 已实现的能力：

- **版本发现**：扫描 `<dir>/<版本>/llama-server.exe` 或 `<dir>/llama-server.exe` 两种布局；
  `--help` 探测 `--models-dir`（router mode 支持）并**缓存**（冷启动约 1.5s，热约 150ms）。
- **共享 CUDA 运行时匹配**：按版本目录名里的 `cuda-<X.Y>` 标签，在同级目录中寻找**直接包含**
  `cudart64_*` / `cublas64_*` 的目录；也支持在设置里手工指定。
- **环境注入**：启动 router 时把共享 CUDA 目录注入子进程 `PATH`（Windows DLL 搜索**不递归**，
  注入父目录无效），并设置工作目录；注入会被 router 与它 spawn 的模型子实例逐级继承。
- **非 ASCII 路径修复**：路径含中文时，自动用 `mklink /J` 建一个纯 ASCII 链接目录再启动
  （llama.cpp 以 ANSI 语义传递自身路径，中文目录会导致模型子实例 spawn 失败）。
- **GPU / 多卡**：默认**不传** `--device` / `-ngl` / `-ts`，把显存分配交给原生 `--fit`
  （它会测量每张卡空闲显存、自动分层并生成 `--tensor-split`）。设备列表由 `--list-devices`
  实时枚举驱动，启动前校验（无效设备名会让 router 直接启动失败）。
- **日志**：采集 router 的 stdout/stderr，按 `[端口]` 前缀区分「系统」与「模型子实例」，
  环形缓冲 10000 行 + 100ms/50 行批量推送到前端。
- **进程生命周期**：端口占用自动顺延、崩溃监测（退出码上报）、退出时停止 router
  （实测强杀父进程后模型子实例会自行退出，不残留显存占用）。

P3 已实现的能力：

- **模型递归扫描**：任意层级扫描模型根目录，自动处理分组——同目录内以 `mmproj` 开头的文件归入该模型
  （多模态）、`*-000NN-of-000MM.gguf` 视为一个多分片模型、同目录多个主文件各自成模型；
  只有 mmproj 的目录会被忽略；量化从文件名推断。
- **presets.ini 生成与维护**：为每个模型写入 `[<相对路径 id>]` 段与 `model = <绝对路径>`；
  **更新时只动涉及的键，用户手写的注释、未知键、`[*]` 全局段原样保留**；支持整文件原始编辑。
- **模型列表页**：搜索、筛选（全部/已加载/收藏/未同步）、排序（名称/大小）、卡片与列表两种视图、
  紧凑/宽松两档密度（均记忆在 localStorage）、收藏、启动/停止（直连 router）。
- **状态实时同步**：订阅 router 的 `/models/sse`（`model_status` 带加载阶段与百分比、
  `model_remove`、`models_reload`），列表局部更新，不轮询。
- **配置面板**：7 个核心参数（`n-gpu-layers`/`ctx-size`/`temp`/`top-p`/`top-k`/`min-p`/`repeat-penalty`）
  写入该模型的 preset 段；**清空某项即从 preset 中删除该键**；另有"高级（原始 INI）"整文件编辑。
- **详情面板**：已加载模型读取 `/props`（量化、上下文、槽位、模态、构建号），未加载则展示扫描信息与 preset 段内容。
- **从 hub 迁移**：一键导入 `llama.cpp-hub` 的 `config/launch_config.json`，把每个模型的 `cmd` /
  `extraParams` 转成 preset 段的键值对（丢弃 router 掌管的 `--port`/`--alias`/`--no-webui` 等，
  合并 hub 那种 `--spec-type_ngram-mod` 的伪参数）。

P4–P6 已实现的能力：

- **日志页**：来源列表（全部 / 系统 / 前端 / 各模型实例，按当前端口映射成模型名）、匹配行数、
  自动滚底（仅在滚动条贴底时跟随）、缓冲上限与环形修剪。
- **性能测试页**：只有 **API 压测**（并发在 **Rust 侧**发起，绕开 webview 对同一主机 6 条连接的限制；
  统计 avg/min/max/P50/P95，记录可导出 CSV/JSON/MD）。
  > 原先还有一个 `llama-bench` 面板（版本下拉、参数弹层、历史输出浏览），已整体移除：命令行基准
  > 交给 `llama-bench.exe` 本身，应用内只保留「对着运行中的 router 打请求」这一种测法。
- **托盘常驻**：左键显示窗口，右键菜单「显示主窗口 / 启动服务 / 停止服务 / 退出」，
  悬停提示显示 router 运行状态与端口；关闭窗口默认隐藏到托盘而不是退出。
- **单实例**：重复双击 exe 不会再起第二份程序（也就不会出现多个托盘图标、多个 router），
  第二次启动只是把已有实例的窗口叫到前台（官方 `tauri-plugin-single-instance`）。
- **不闪黑窗**：版本探测（`llama-server --help`）、设备枚举（`--list-devices`）、`taskkill`、
  `mklink`、`reg query` 等所有子进程都带 `CREATE_NO_WINDOW`（主程序是 GUI 子系统并不够 ——
  GUI 进程 spawn 控制台程序时照样会新开一个控制台窗口）。
- **启动即出列表（先显示、后更新）**：扫描结果落盘缓存（`models-scan-cache.json`）。
  启动时直接读「上次刷新后的结果」把列表渲染出来，后端随后**自动重扫一遍**，
  只有结果真的变了才发事件让前端更新 —— 也就是 stale-while-revalidate，用户无感知。
  另外 `device_list`（要起一个 `llama-server --list-devices`，1~3 秒）不再排在模型扫描前面、
  也不再阻塞启动流程。
- **失效段自动清理 + 归档恢复**：模型被删掉/移走后，扫描时会自动把对应的 preset 段清掉
  （判据只有一个：段里的 `model` 指向的 gguf 不在了；没有 `model` 键的段一律不碰）。
  清掉的段**先存进归档** `removed-preset-sections.json`，所以过段时间把同一个模型重新下载
  回模型目录、扫描时会**按段名把当初调好的参数接回来**（`model` 换成新扫到的路径，其余键原样），
  恢复后从归档里移除。若所有段都失效（≥3 个）则判定为「模型盘没挂上」，跳过清理只做提示。
- **开机自启**：官方 `tauri-plugin-autostart`（写 `HKCU\...\Run`），自启动时带 `--minimized`
  直接驻留托盘；每次开启都用当前 exe 路径重写注册表项，移动安装目录后不会失效。
- **NSIS 安装包**：`npm run tauri build` 产出 `llama.cpp GUI_<version>_x64-setup.exe`
  （当前用户安装，免管理员）。

P7 已实现的能力（Strata 第二运行时通道）：

- **并列接入，而不是塞进 router 流水线**：Strata（<https://github.com/Niko1221/Strata>）的二进制、
  管理端点、config 格式都与 llama.cpp router 不同，所以它作为**独立通道**与其并存，router 那条线不改。
  后端注册了 13 个命令（`strata_status` / `strata_scan` / `strata_probe` / `strata_start` /
  `strata_stop` / `strata_set_root` / `strata_pick` / `strata_config_read` / `strata_config_write` /
  `strata_unload_model` / `strata_load_model` / `strata_proxy_start` / `strata_proxy_stop`），
  外加压测命令 `bench_strata`。
- **前门代理：客户端只连一个端口**（`src-tauri/src/strata_proxy.rs`；默认 `127.0.0.1:9090`，
  设置页里叫「代理监听地址 / 代理端口」）。DSH 等 OpenAI 兼容客户端只连它，它按请求体里的 `model`
  挑 config，必要时**停旧引擎、起新引擎**（切换全程串行化；首次请求要等建引擎 + 加载模型，约 20–60 s）。
  `GET /v1/models` 由它合成**全部** config（当前引擎那份 `loaded`、其余 `unloaded`），没有引擎时
  `GET /health` 也由它合成，点名不存在的 `model` 回与上游同形的 404 —— 于是客户端里选中哪个模型都能直接用。
  各模型的**引擎端口仍留在自己的 `strata-*.json` 与 `run-<模型>.bat`** 里（两处必须一致，不一致时启动直接报错），
  代理地址 / 端口**只写 GUI 设置、不写 config**。侧栏胶囊显示「Strata 代理 :9090」、下面一行是引擎版本；
  由 DSH 请求触发的加载会在对应卡片上显示「加载中」。排查连接类问题可设 `STRATA_PROXY_DEBUG=1` 启动，
  代理会把逐连接轨迹写进 `%TEMP%\strata-proxy-debug.log`（默认关闭）。
- **Strata 页**：卡片列表 + 搜索/刷新/排序/筛选/视图切换；「配置」Sheet 左栏是 config 原文（可直接编辑，
  右栏改参数时同步重算回写）、右栏是参数表单（`strata-*.json` 里的 `args` ↔ 表单状态的换算在
  `src/utils/strataParams.ts`）；写回走「校验 → 备份 → 原子写」，非法内容不会落盘。
  参数分六组：上下文与 KV / 加速与缓存 / **并发** / 采样 / 多模态 / 其它。并发组里的
  `--batch`（并发槽位，2..8）、`--batch-mtp`、`--batch-groups`、`--conversation-cache-mib`、
  `--conversation-cache-slots` **默认都不配置**（不写 = 引擎单槽串行、会话停放关闭），
  并且勾选时按引擎的依赖关系校验：`--batch-mtp` 要求 `--batch` + `--mtp` + `--spec` 且不能与
  `--batch-groups` 同开、`--batch-groups` 要求 `--batch`、`--conversation-cache-slots` 要求预算 > 0；
  不满足就拒绝勾选并就地说明原因，写盘前还会再校验一次（防止从 config 原文绕过）。
  引擎版本**不在模型卡里选**：设置页「通用 → Strata 引擎」列出 `engine-bundle` 下的全部版本（版本 / 后端 /
  架构 / 路径），选中即写进**全部** config 的 `exe`，重启引擎后生效。
  卡片名后的徽标是四项：**视觉 / MTP / 引擎缺失 / KV 池**。「支持 MTP」的判据是这份 config 的
  `args` 里带 `--mtp`（安装器写下的安装事实，路径 GUI 只读），不是按模型名猜；`--spec=0` 时
  徽标显示成虚线压暗的 **「MTP 关」**（权重已装、当前未启用投机解码），悬停给出验证窗口 `--spec=N`。
- **WebUI 交给系统浏览器**：用 `ipc.openLocalUrl` 打开，不接管、也不内嵌 iframe —— CSP 不必放宽，
  Strata 之后升级自带的 WebUI 也不会牵动这个 GUI。
- **显存互斥**：启动 router 模型前先卸掉 Strata 正在跑的模型，反之亦然（设置里可关 `strata_router_mutex`）；
  另有空闲自动卸载（`strata_idle_unload_s`）与加载前的显存门槛（`strata_min_free_vram_mib`）。
- **状态实时同步**：订阅 `strata://status`；`strata_probe` 负责端口探测（带缓存），
  崩溃由监测线程发现后立刻刷新托盘菜单的可用性。
- **托盘与自启**：托盘悬停显示两条运行时的状态，菜单项「启动服务 / 停止服务」按进程槽实时灰显；
  `auto_start_strata` 可在开机时一并拉起 Strata。
- **压测**：`bench_strata` 的端口、模型名、API Key 都在 Rust 侧从 config 读取，密钥不下发前端。
- **脱离宿主节流**：拉起 Strata 引擎时给它加 `CREATE_BREAKAWAY_FROM_JOB`（`winfix::no_throttle`，
  见 `src-tauri/src/winfix.rs:183`），避免 GUI 被后台化时推理进程跟着被 Job Object 限速；
  父 Job 没开 `BREAKAWAY_OK` 时去掉该 flag 重试。
- **MCP 工具接入**（2026-10-20，build135）：聊天设置里的「MCP 工具」开关打开后，GUI 按
  `<配置目录>\mcp.json` 的清单以 **stdio 子进程**拉起 MCP 服务器，把它们的工具
  （`mcp__<服务器>__<工具>`）与联网搜索一起放进 `tools` 数组；模型请求调用时由 GUI 执行
  `tools/call`，再把文本结果作为 `role:"tool"` 消息喂回去。服务器清单在聊天设置弹层里编辑
  （命令 / 参数 / 环境变量 / 启用），文件形状与 Cursor 的 `mcpServers` 一致。实现见
  `src-tauri/src/mcp.rs`；不用 llama.cpp 自带的 `--mcp-servers-config`，因为那套工具在
  `llama-server` 进程内部执行、GUI 看不到调用也管不了清单。
- **网页正文抓取与全文搜索**（2026-10-20，build136）：联网搜索不再只给一两句摘要 ——
  tavily / firecrawl / exa 都改成要整页正文（`include_raw_content` / `scrapeOptions.markdown` /
  `contents.text`），单条上限 800 → 4 千字符、整轮预算 2.4 万字符；另新增聊天工具
  `web_fetch(url)`，模型可以挑最相关的一条链接再读整页（`search.rs::fetch_page`：系统 curl 取
  HTML → 去脚本/导航 → 优先只取 `<article>`/`<main>` → 纯文本，单页上限 1.2 万字符，同样包
  `<untrusted-web-content>` 边界）。两者都跟着聊天设置里的「联网搜索」开关一起出现。
  build137 又修了一层：「条数凑满」不再等于「够了」—— 默认排第一的 anysearch 只给 10 条、
  每条一两百字符，以前它一装满 `limit` 就收工，后面能返回整页正文的引擎永远轮不到；现在
  同 URL 留**正文更长**的那条，且平均每条的正文不到 800 字符就继续叠下一个引擎
  （`search.rs::rich_enough`）。代价是每次搜索多打一个引擎，延迟多 1–2 秒。

- **AnySearch 提取兜底**（2026-10-20，build138）：AnySearch 确实能提取网页正文，但那是
  **独立端点** `POST /v1/extract`（`{"url": ...}` → markdown），`/v1/search` 没有取正文的参数
  （它回的 `content` 仍是清洗过的片段）。现在 `web_fetch` 在自己用 curl 抓失败、或洗出来的
  正文短于 400 字符时，会再请它提取一次，取正文更长的那份并在工具卡片上标「正文由 AnySearch
  提取」。匿名可用（按 IP 限额）；它不做 JS 渲染，纯 SPA 也只给占位文本。

界面细节（按实机反馈调整过；**侧栏已改为 模型 / 聊天 / 监控 / 性能测试 / 系统日志 / 设置 六页**，
下列个别描述早于这次改版）：

- **侧栏**：`模型列表 / 性能测试 / 运行环境 / Strata / 系统日志 / 设置` 六个页面，外加一个
  「开始聊天」按钮（不是页面，直接打开 llama.cpp 自带聊天界面）；底部把 router 状态与
  启停合成**一颗胶囊**（左边状态点、中间「router 运行中 · :8080」、右边启动/停止图标，
  配色沿用 hub 模型卡的状态胶囊），点一下即启停。
- **模型列表顶栏只留五件事**：搜索、刷新、排序（名称 ↑↓ / 大小 ↑↓ / **运行中优先**）、
  筛选（全部 / 运行中 / 收藏 / 未同步 preset）、视图切换；`同步到 presets.ini` 与
  `编辑 preset 文件` 收进一个 **preset 下拉**。
- **聊天页的模型下拉**（输入框右侧）：列出**全部**模型（不把已加载的排到最前），已加载的模型名显示为绿色；默认模型依次取「上次的选择 → 已加载里 id 排序第一个 → 上次聊天的模型」，都没有时显示「请选择模型」。选中的模型**未加载时发送会自动拉起**（执行状态卡片提示「拉起中…」），下次请求照常走前门。**聊天历史默认收起**，需要时点工具栏的展开按钮。
- **设置页**：顶栏是深浅色主题按钮；llama.cpp 目录保存后自动重扫版本与设备；模型根目录
  「保存」即自动重新扫描（不再需要单独的「保存并扫描模型」）；GPU / 多卡分组已移除 ——
  默认不限制设备就是多卡最优解，需要 per-model 覆盖时在模型配置面板里改。
- **配置弹窗**：参数分组的折叠状态与左右两栏的滚动位置都会记住（按模型分开记，
  下次打开同一模型接着上次的位置）；底部按钮统一宽度；「估算显存」「删除配置」两个按钮已移除
  （段由扫描自动维护）。
- **窗口尺寸记忆**：拖动过窗口后按原尺寸打开，见 `settings.json` 的 `window` 字段。
- **图标**：应用图标是「层叠 + 闪电」的靛蓝方图，托盘另有一版**小尺寸专用**图形（两层 + 粗闪电）——
  主图三层加细闪电缩到托盘 24px 会糊成一片。

> **换图标要注意**：`tauri-build` **不监听** `icons/*` 的变化（它只跟 `tauri.conf.json` 和 resources），
> 直接替换 `src-tauri/icons/icon.ico` 后重新构建，exe 里嵌的仍是旧图标。正确做法是先清它的产物：
>
> ```powershell
> Remove-Item -Recurse -Force src-tauri\target\release\build\llamacpp-gui-*, src-tauri\target\release\.fingerprint\llamacpp-gui-*
> npm run tauri build
> ```
>
> 另外 Windows 有图标缓存：覆盖 exe 后若仍显示旧图标，把新 exe 换个名字/目录运行，或刷新缓存
> （`ie4uinit.exe -show`；顽固时删 `%LOCALAPPDATA%\IconCache.db` 后重启 explorer；任务栏固定项要取消固定再重新固定）。
>
> 图标资产全部由 `node scripts/make-icons.mjs` 生成（**解析式绘制 + Node zlib 自编码 PNG**，不依赖任何图形库）：
> `src-tauri/icons/*.png` 与 `icon.ico`（exe/安装包/任务栏）、`window-icon.png`（窗口与 Alt+Tab）、
> 以及 `src-tauri/src/tray_icon.rs` 里的托盘 RGBA 常量。两个要点：**四周留白 8%**（内容铺满画布在任务栏里会显得发满、像被切）；
> **≤40px 用两层简化图形**（三层加细闪电在小尺寸下必然糊）。

---

## 环境要求

- Windows 10/11（WebView2 随系统）
- Rust 1.77+（实测 1.98.1）
- Node.js 20+（实测 25.2.1）
- llama.cpp ≥ 2025-12 构建（支持 `--models-dir`），并准备共享 CUDA 运行时包
  `cudart-llama-bin-win-cuda-<X.Y>-x64`（与版本目录同级放置即可被自动匹配）

---

## 构建与运行

### 1) 先启动 cargo 依赖代理（本机必需）

本机 Windows 原生 TLS（schannel）不可用：cargo / curl 访问任何 HTTPS 源都会报
`SSL connect error (schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS)`，
而 Node 自带 OpenSSL 可以正常出站。因此仓库自带一个**纯 HTTP** 的 crates 代理，
让 cargo 只与本机 `127.0.0.1` 通信：

```powershell
# 终端 A（保持运行）
npm run cargo:proxy          # 默认 http://127.0.0.1:8787

# 终端 B
cd src-tauri
cargo build
```

`.cargo/config.toml` 已经把 `crates-io` 指向该代理（上游 rsproxy.cn，回退 static.crates.io）。
如果你的环境能直连 crates.io，把该文件里的 `replace-with` 注释掉即可。

> 别把 `CARGO_HOME` 指到仓库里：一次完整构建会在仓库内堆下约 780 MB 的 registry 缓存。
> 用默认的 `~/.cargo` 就行（本机一直用的就是它）。

### 2) 开发与构建

```powershell
npm install                  # 若在受限沙箱中需加 --ignore-scripts
npm run tauri dev            # 开发（需要 src-tauri 能编译）
npm run build                # 仅构建前端到 dist/
npm run tauri build          # 打包 NSIS 安装包
```

打包首次需要 NSIS 工具链（Tauri 会自动下载到 `%LOCALAPPDATA%\tauri\NSIS`）。
本机直连 GitHub 不通时，给构建命令带上代理即可：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897"   # 本机 Clash 的混合端口
$env:HTTP_PROXY  = "http://127.0.0.1:7897"
$env:NO_PROXY    = "127.0.0.1,localhost"     # 别让 cargo 的本地代理走代理
npm run tauri build
```

产物：

- `src-tauri/target/release/llamacpp-gui.exe`（免安装，可直接运行）
- `src-tauri/target/release/bundle/nsis/llama.cpp GUI_<版本>_x64-setup.exe`（当前用户安装，免管理员）

### 3) 测试

后端包含针对纯逻辑的单元测试（命令行组装、设备解析、共享库匹配、ASCII 链接、设置读写等）：

```powershell
cd src-tauri
cargo test
```

### 4) 在 dsh 沙箱里构建的注意事项

受限沙箱禁止命名管道，而 **esbuild（Vite 配置与 TSX 转换）** 和部分构建工具依赖管道通信，
会报 `spawn EPERM`。在这类环境下需要用更宽的权限执行构建命令（本项目的前端构建即如此完成）。

同理，**GUI 的运行时验证必须在沙箱外**：WebView2 的渲染进程与宿主之间走命名管道，
沙箱内启动应用时 WebView2 起不来，窗口不会正常显示 —— 这不是应用本身的缺陷。
打包产物请在资源管理器里双击运行验证。

还有一处容易误判成「测试坏了」：沙箱会给 `%TEMP%` 下的目录写限制性 ACL / 低完整性标签，
后端单测里有 20 来个用例要往 `%TEMP%\llamacpp-gui-*-test` 写文件，这时会成片报
`拒绝访问 (os error 5)` 并连带断言失败（数值读回默认值）。**把 TEMP 指到工作区内再跑**即可，
不需要改测试：

```powershell
$env:TEMP='E:\Code\llama.cpp-GUI\tmp\temp'; $env:TMP=$env:TEMP
npm test          # 期望 119 passed / 8 ignored
```

---

## 目录结构

```
├── index.html / vite.config.ts / tsconfig.json
├── package.json
├── .cargo/config.toml            # 指向本地 cargo 代理
├── scripts/
│   ├── cargo-proxy.mjs           # 本机 crates 代理（Node/OpenSSL）
│   ├── make-icons.mjs            # 生成全部图标资产（解析式绘制 + 自编码 PNG/ICO）
│   └── make-ico.mjs              # 把若干 PNG 打成 ICO（独立小工具）
├── src/                          # React 19 + TS 前端
│   ├── App.tsx / store.ts / ipc.ts / types.ts
│   ├── api/router.ts             # 直连 router 的 HTTP + SSE 客户端
│   ├── utils/
│   │   ├── models.ts             # 扫描结果 ↔ router 模型合并、段名/别名规则
│   │   ├── paramSchema.ts        # 参数表 schema + 表单状态换算（纯数据，无组件）
│   │   ├── presetText.ts         # preset 文本分段解析
│   │   ├── extraParams.ts        # 额外参数行解析
│   │   ├── frontendLog.ts        # 前端错误上报
│   │   ├── bench.ts / modelIcon.ts
│   └── components/
│       ├── ModelListPanel.tsx    # 模型管理（主力页）
│       ├── ModelSheets.tsx       # 配置面板 + 详情面板
│       ├── ParamForm.tsx         # 参数表单（含有序多选）
│       ├── BenchPanel.tsx        # 性能测试（API 压测；模型选择 + 图表 + 记录）
│       ├── RuntimePanel.tsx      # 版本/设备/多卡策略
│       ├── SettingsPanel.tsx     # 目录/服务/GPU/启动与托盘
│       ├── LogPanel.tsx          # 日志
│       └── ErrorBoundary.tsx     # 渲染错误边界
└── src-tauri/
    ├── tauri.conf.json / capabilities/default.json / icons/
    ├── nsis/hooks.nsh          # 卸载时询问是否删除用户数据
    └── src/
        ├── lib.rs                # Tauri 命令与事件注册
        ├── state.rs              # 共享状态
        ├── settings.rs           # settings.json 持久化
        ├── versions.rs           # 版本扫描 + --help 探测 + 共享 CUDA 匹配
        ├── models.rs             # 模型递归扫描 + GGUF 元数据缓存 + hub 配置迁移
        ├── model_config.rs       # 一个模型一份 JSON：读写/最小化写入/失效归档与恢复
        ├── scheduler.rs          # 多模型驻留：容量闸、端口分配、启动参数组装、空闲卸载
        ├── strata_proxy.rs       # 前门：一个端口挂全部 config，按请求体 model 停旧起新并转发
        ├── strata.rs             # Strata 第二通道：引擎启停、/status 探测、显存互斥
        ├── monitor.rs            # 硬件与引擎指标采集（sysinfo / NVML / PDH / Prometheus 文本）
        ├── search.rs             # 联网搜索五引擎 + 网页正文抓取（web_fetch，AnySearch 兜底）
        ├── mcp.rs                # MCP 客户端（stdio/NDJSON）：服务器管理、工具列表与调用
        ├── gpu.rs                # 设备枚举/校验 + GPU 参数组装 + 显存预估
        ├── bench.rs              # API 压测（Rust 侧并发）+ 记录落盘 + 硬件信息
        ├── http.rs               # 极简本机 HTTP 客户端（压测与空闲卸载共用）
        ├── idle.rs               # 模型休眠后自动卸载实例，放掉残留显存
        ├── tray.rs               # 托盘图标/菜单/关闭隐藏
        ├── winfix.rs             # ASCII 链接、端口检测
        ├── paths.rs              # 配置目录解析（便携绿色版 / 回退 %APPDATA%）
        └── logs.rs               # 日志环形缓冲 + 批推 + 落盘 + 进程树强杀
```

配置文件放在 **exe 同目录**（便携绿色版）：

```
settings.json                 # 用户设置
config/llamacpp-<id>.json     # 一个模型一份配置（name/model/args/port/api_key…）
config/.orphan/               # 模型文件消失后归档的 config（模型回来时恢复参数）
logs/gui-<启动时间>.log       # 运行日志（超 8 MB 分卷，只留最近 12 个）
runtime/                      # 非 ASCII 路径的链接目录
webview/                      # WebView2 数据（localStorage / 缓存）
bench/records.json            # API 压测记录（导出文本也在 bench/）
mcp.json                      # MCP 服务器清单
search.json                   # 联网搜索：引擎 key / order / 屏蔽域名 / 条数
gguf-meta-cache.json          # gguf 元数据（架构/量化）缓存
models-scan-cache.json        # 模型扫描缓存
```

> - 从把数据放在 `%APPDATA%\dev.llamacpp.gui\` 的旧版本升级上来**不会自动搬配置**（按全新安装处理，需要重设 llama.cpp 目录、模型目录与模型配置）。
> - 装在 `C:\Program Files` 这类不可写位置时，自动退回 `%APPDATA%\dev.llamacpp.gui\`。
> - 开发模式（`npm run tauri dev`）始终用 `%APPDATA%`，不会把配置写进 `target/debug`。
> - 安装版同样走便携；**卸载时会询问是否同时删除这些用户数据**（默认"否"= 保留，重装到同一目录即可继续用）。

---

## 首次使用流程

1. **设置 → llama.cpp 目录**：填版本目录的根（如 `E:\AI\llamacpp`，下面是一层 `llama-bNNNNN-…`），点「保存并扫描」
   → 版本表显示每个版本、共享 CUDA 匹配情况、路径是否纯 ASCII；设备表列出可用 GPU。
2. **设置 → 模型根目录**：填模型所在目录，点「保存并扫描模型」→ 递归扫描（含多模态与分片分组），GGUF 元数据进缓存。
3. **模型页 → 配置**：每张卡点「配置」写一份 `config\llamacpp-<id>.json`（一个模型一份；`name` 就是请求用的模型名）。
4. **模型页 → 启动**：起该模型的子实例，端口由调度器从号段分配；容量闸按 `models_max`（默认 4）执行，满了先卸最久未用的。
5. **前门**（侧栏左下的胶囊）是统一入口：默认 9090 一个端口挂全部 config，请求体里的 `model` 决定用哪个。

> 聊天、监控、性能测试、日志各页按需用；聊天设置里可开「联网搜索」与「MCP 工具」，工具一律由 GUI 执行（llama.cpp 自己不联网）。

---

## 给 dsh 等客户端使用

前门起来后就是一个 OpenAI 兼容端点：

```
base_url = http://127.0.0.1:9090/v1     # 端口看侧栏前门胶囊 / 设置里的「前门端口」
api_key  = 配置里设的 key（没设就不带）
```

`GET /v1/models` 列出全部 config 的 `name`（含未加载的），首次请求会自动拉起对应模型（冷启动约 3–6 秒）。
配了 key 时除 `/health` 全要鉴权，且**只认请求头**（`Authorization: Bearer` / `x-api-key`），SSE 不能用 `EventSource`。
