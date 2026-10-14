# 仓库约定（llama.cpp GUI）

**所有回复与文档一律使用简体中文。**

## 先读什么

- 接手 / 改代码前：`HANDOVER.md` —— §2 是 llama.cpp 行为约束（每条都有实测依据）、§1.1 代码地图、§8 未决项。
- 能力清单与构建步骤：`README.md`；整体方案与实测基线：`REFACTORING_PLAN.md`、`REFACTORING_REVIEW.md`。
- 第二条运行时通道（Strata，**已落地**）：方案与逐轮实现记录在 `STRATA_INTEGRATION_PLAN.md`，**约束**在 `HANDOVER.md` §2.11（config 校验+备份+原子写、WebUI 走系统浏览器、显存互斥、`no_throttle` 的脱离 Job 与失败回退）。
- 第三条通道（kvmem，**未实施**）：`KVMEM_INTEGRATION_PLAN.md`；开工时复用 Strata 那套骨架。
- 前门（统一入口 9090）与 llama.cpp 侧配置层：`PROXY_SCHEDULER_PLAN.md` —— 决策结果在 §10，配置层规格在 §3.1（**一个模型一份 JSON**、`presets.ini` 退役），分阶段与安全网见 §8，必须先实测的清单见 §9。
- 改前端样式前：`UI_STYLE_BASELINE.md` —— 全站统一到 Strata 色板/字体/图标的规格与实施分解（S1–S8）；铁律 8 是它的摘要版，逐条细节（token 数值、色板映射、68 个图标映射表、设置页与运行环境页归组、断点迁移表、已知坑）在该文件里。**任何新面板都必须排在 S1–S8 之后**。

## 参考源码（本机，改造时的对照物）

改前门调度、配置层、监控或样式之前，直接读这两份源码，不要凭印象：

- **strata-manager**（上游参考实现：Tauri 2 桌面壳 + React 前端）：`E:\Code\strata-manager-main`
  - 桌面壳 Rust：`apps\desktop\src-tauri\src\`（21 个 `.rs`：浮窗 `floating_monitor.rs`、监控托盘 `monitor_tray.rs`、窗口级命令白名单 `invoke_policy.rs`、`supervisor_client.rs`、`window_layout.rs` 等）
  - 桌面壳前端：`apps\desktop\src\`（`FloatingTelemetryWindow.tsx`、`serviceStatusTelemetry.ts`、`layouts\ServiceTelemetryStatusBar.tsx` 等）
  - supervisor：`apps\supervisor\src\main.rs` + `apps\supervisor\tests\`
  - **Strata 引擎与服务（Python）**：`E:\AI\Strata\serve\`（`server.py`、`frontend.py`）+ 网页面 `E:\AI\Strata\serve\web\`（`tokens.css` / `components.css` / `app.css` / `sprite.svg` / `fonts\` / `app.js` / `index.html` / `monitor.*`）
  - 移植评估与逐文件清单见 `STRATA_MANAGER_PORT_ASSESSMENT.md`
- **llama.cpp router 源码**（要核对 router / 多模型模式行为时）：
  - 与实跑二进制一致的在线源码：`https://raw.githubusercontent.com/ggml-org/llama.cpp/b11482/tools/server/server-models.cpp`（router 主体，2,370 行；本工程已抓副本 `tmp\router-server-models.txt` 与 `tmp\router-server-models.raw.txt`）
  - 本机 vendored 副本：`E:\AI\Strata\third_party\llama.cpp\tools\server\`（13 个 `.cpp`，其中 router 主体 `server-models.cpp` 99,962 B；`CMakeLists.txt` 里版本 `0.4.1-dev`；**不是 git 检出**）
  - 上游仓库：`github.com/ggml-org/llama.cpp` 的 `tools/server/`（`server-models.cpp` = router，`server.cpp` / `server-context.cpp` / `server-http.cpp` / `server-queue.cpp` / `server-task.cpp` 等是公共实现）
  - 注意：vendored 那份是 Strata 自带、版本 `0.4.1-dev`，与实跑的 `b11482` **未必同一 commit**；核对 router 行为以 b11482 在线源码为准（GUI 实跑二进制在 `E:\AI\llamacpp\llama-b11482-bin-win-cuda-13.4-x64`）

## 铁律（违反即出 bug，不是"可能有问题"）

1. **不给（router / 子实例）传 `--no-ui`** —— 它会被下发给每个子实例，关掉 llama.cpp 自带聊天界面；llama.cpp 侧配置层用 `no_webui: false` 表达同一件事。
2. 前端请求模型要用 **config JSON 的 `name`**（= 原 preset 段名），不是扫描出来的目录 id。llama.cpp 侧配置已是「一个模型一份 JSON」（`<exe 目录>\config\llamacpp-<id>.json`，规格见 `PROXY_SCHEDULER_PLAN.md` §3.1）：文件名主体是 id，`name` 是请求用的模型名，迁移后两者一致。
3. 「刷新模型」必须 `GET /models?reload=1`，否则拿到的还是内存里的旧配置（前门落地后改为重扫 `config\*.json`）。
4. 配了 `--api-key` 后除 `/health` 全要鉴权，且只认请求头（`Authorization: Bearer` / `x-api-key`）；`?api_key=` 无效，SSE 不能用 `EventSource`。
5. 配置里出现被上游淘汰的键（`models.rs::RETIRED_PRESET_KEYS`）会让**进程整体启动失败**：升级 llama.cpp 后先查日志里的 `option '…' not recognized in preset`。
6. 默认不传任何 GPU 参数 —— 多卡分配交给原生 `--fit`。
7. 组件文件只导出组件（工具函数放 `src/utils/`），否则 Fast Refresh 失效。
8. **样式只准取 `src/styles/tokens.css` 的 token** —— 禁止用内联 `style={{}}` 调尺寸/字号/颜色（现存的 130 处按文件逐个清，见 `UI_STYLE_BASELINE.md` §5–§7），CSS 里禁止写新 hex 字面值与字面 `font-size`/`border-radius`，禁止新增 `@font-face` 与新增 `#id` 选择器（296 处是 hub 遗产，只减不增）。**断点只准用 `640` / `900` 两个值**（`@media (max-width:640px)` / `(max-width:900px)`；仅桌面用 `min-width:901px`，与 900 成互补对）—— `@media` 条件不能用 `var()`，所以这条靠规范不靠 token，迁移表见 `UI_STYLE_BASELINE.md` §10.4。上游 CSS 只照搬结构与数值，**禁止整文件引入**（`tokens.css` 的 `html,body`、`button{}`、`input,textarea,select{}` 一律不入库）。

## 构建与验证（Windows）

```powershell
npm run cargo:proxy               # 另开终端保持运行（127.0.0.1:8787），cargo 必需
npx tsc --noEmit                  # 前端类型检查（仓库根）
cd src-tauri; cargo test --lib     # 后端单测（当前 93 passed / 5 ignored）
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
