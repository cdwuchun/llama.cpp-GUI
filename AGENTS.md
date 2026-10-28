# 仓库约定（llama.cpp GUI）

**所有回复与文档一律使用简体中文。**

## 先读什么

- 接手 / 改代码前：`HANDOVER.md` —— §2 是 llama.cpp 行为约束（每条都有实测依据）、§1.1 代码地图、§7 未决项；逐轮实现日志与历史决策在 `docs/archive/`。
- 用法与能力：`README.md`（七页功能、外部 llama.cpp / Strata 目录结构、构建步骤）；构建与环境坑在 `HANDOVER.md` §5。
- 第二条运行时通道（Strata，**已落地**）：方案与逐轮实现记录在 `docs/archive/STRATA_INTEGRATION_PLAN.md`，**约束**在 `HANDOVER.md` §2.11（config 校验+备份+原子写、WebUI 走系统浏览器、显存互斥、`no_throttle` 的脱离 Job 与失败回退）。
- 前门（统一入口 9090）与 llama.cpp 侧配置层：`docs/archive/PROXY_SCHEDULER_PLAN.md` —— **已落地**，决策结果在 §10，配置层规格在 §3.1（**一个模型一份 JSON**、`presets.ini` 退役），分阶段与安全网见 §8，必须先实测的清单见 §9。
- 聊天能力（原生聊天页 / 联网搜索 / MCP / 监控 / 压测）：`docs/archive/STRATA_MANAGER_PORT_ASSESSMENT.md`（P1–P8 的评估与决策）、`docs/archive/WEB_SEARCH_PLAN.md`（五引擎搜索，§11 决策）。
- 改前端样式前：`docs/archive/UI_STYLE_BASELINE.md` —— 全站统一到 Strata 色板/字体/图标的规格与实施分解（S1–S8，**均已落地**，S4 已回退保留 FontAwesome）；铁律 8 是它的摘要版，逐条细节（token 数值、色板映射、68 个图标映射表、设置页与运行环境页归组、断点迁移表、已知坑）在该文件里。新面板直接照它的 token 与断点规范走。
- **历史存档，不要按里面的行号回查**：`docs/archive/REFACTORING_PLAN.md`、`docs/archive/REFACTORING_REVIEW.md`（0.1.x 的 router + `presets.ini` 设计基线）、`docs/archive/CODE_REVIEW.md`（0.1.x 静态审查，多数已修）。

## 参考源码（本机，只在核对外部行为时才读）

改造已全部完成，这些源码不再是「照着做」的模板，而是**行为对不上时的证据来源**：

- **llama.cpp 实跑 b11671**：`E:\AI\llamacpp\llama-b11671-bin-win-cuda-13.4-x64`。参数语义以 `llama-server --help` 为准；服务端源码在线看 `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11671/tools/server/`（MCP 口径来自 `server-mcp.cpp`，`/metrics` 文本与 `/slots` 字段来自 `server.cpp` / `server-context.cpp`）。**router 主体 `server-models.cpp` 随 router mode 一起退役，不必再看**；`tmp\router-server-models.txt` 是更旧的 b11482 副本，只作历史参考。
- **Strata 引擎与服务**：引擎可执行文件在 `E:\AI\Strata\engine\<版本>-<平台>-<后端>\`（旧安装器用 `engine-bundle` 这个名字），控制端在 `E:\AI\Strata\control\` —— `serve\server.py` / `serve\frontend.py` / `serve\web\` 是运行侧，`strata_control\`（`engine_component.py` / `presets.py`）是安装与版本管理侧。引擎行为（`/status` 字段、参数校验、显存账）对不上时读它；`serve\web\tokens.css`、`serve\web\components.css` 是 `src/styles/tokens.css` 的上游真源。
- **上游 strata-manager**（Tauri 2 + React）：`E:\Code\strata-manager-main`。P1–P8 的移植已全部落地，只在追「上游当初怎么做的」时查；浮窗 `floating_monitor.rs`、监控托盘 `monitor_tray.rs` 属于已取消的 P6，不用管。
- 本机 vendored 副本 `E:\AI\Strata\third_party\llama.cpp\tools\server\` 是 Strata 自带、版本 `0.4.1-dev`、**不是 git 检出**，与实跑 b11671 未必同 commit。

## 铁律（违反即出 bug，不是"可能有问题"）

1. **不给子实例传 `--no-ui`** —— 它关掉的是 llama.cpp 自带聊天界面，而「开始聊天」打开的正是那个界面；配置里用 `no_webui` 字段表达（false = 开着）。
2. 前端请求模型要用 **config JSON 的 `name`**，不是扫描出来的目录 id。llama.cpp 侧配置是「一个模型一份 JSON」（`<exe 目录>\config\llamacpp-<id>.json`，规格见 `docs/archive/PROXY_SCHEDULER_PLAN.md` §3.1）：文件名主体是 id，`name` 是请求用的模型名（= 原 `presets.ini` 段名，迁移后两者一致）。
3. **「刷新模型」= 重扫磁盘 + 重读 `config\*.json`**：前端 `refreshModels(true)` → `ipc.modelsScan(true)`（`src/store.ts:1101`）；`force=false` 只读扫描缓存，会拿到旧结果。Strata 通道那个按钮是重扫 `strata-*.json`。
4. 配了 `--api-key` 后除 `/health` 全要鉴权，且只认请求头（`Authorization: Bearer` / `x-api-key`）；`?api_key=` 无效，SSE 不能用 `EventSource`。
5. config 的 `args` 里出现被上游淘汰的键（`models.rs::RETIRED_PRESET_KEYS`）会让**该模型子实例起不来**：升级 llama.cpp 后先查日志里的 `option '…' not recognized`。
6. 默认不传任何 GPU 参数 —— 多卡分配交给原生 `--fit`。
7. 组件文件只导出组件（工具函数放 `src/utils/`），否则 Fast Refresh 失效。
8. **样式只准取 `src/styles/tokens.css` 的 token** —— 禁止用内联 `style={{}}` 调尺寸/字号/颜色（S5 已清完，只剩 4 处运行时值：`MonitoringPage.tsx` 三条、`ServiceStatusPopover.tsx` 一条），CSS 里禁止写新 hex 字面值与字面 `font-size`/`border-radius`，禁止新增 `@font-face` 与新增 `#id` 选择器（`app.css` 里还有 20 处 hub 遗产的 `#id`、44 处字面 `font-size`、5 处 hex，只减不增）。**断点只准用 `640` / `900` 两个值**（`@media (max-width:640px)` / `(max-width:900px)`；仅桌面用 `min-width:901px`，与 900 成互补对）—— `@media` 条件不能用 `var()`，所以这条靠规范不靠 token，迁移表见 `docs/archive/UI_STYLE_BASELINE.md` §10.4。上游 CSS 只照搬结构与数值，**禁止整文件引入**（`tokens.css` 的 `html,body`、`button{}`、`input,textarea,select{}` 一律不入库）。

## 构建与验证（Windows）

```powershell
npm run cargo:proxy               # 另开终端保持运行（127.0.0.1:8787），cargo 必需
npx tsc --noEmit                  # 前端类型检查（仓库根）
cd src-tauri; cargo test --lib     # 后端单测（当前 172 passed / 17 ignored；ignore 里是联网与本机引擎相关用例）
npm test                           # 前端类型检查 + 后端单测（test:web + test:rs）
npm run test:smoke                 # 参数表单渲染冒烟测试（需 esbuild，受限沙箱要提权）
npm run tauri build               # 打包；沙箱内需要提权
```

- 受限沙箱禁用命名管道：esbuild 会报 `spawn EPERM`；**GUI 运行验证必须在沙箱外**（WebView2 起不来窗口，不是应用缺陷）。
- 提权被拒绝时**不要重试同一个命令**，换做法或先问用户。
- CI：`.github/workflows/ci.yml`（windows-latest）跑 `npm run build` + `npm run test:rs` + `npm run test:smoke`；流水线第一步就删掉 `.cargo/config.toml`（它指向本机 127.0.0.1:8787 代理，CI 上不存在）。
- 换图标后必须删 `src-tauri\target\release\build\llamacpp-gui-*` 与 `.fingerprint/llamacpp-gui-*` 再构建（`tauri-build` 不监听 `icons/*`）。

## 交互口味

文案简洁；用户明确否定过的方向不要重提；动手前先说清楚"要改什么"。
