# llama.cpp GUI — Tauri 2 重构方案（最小化实现版 v2）

> 基于 [llama.cpp-hub](https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub) 重构为 Tauri 2 桌面应用
> 核心思路：**把重逻辑交给 llama.cpp 原生 Router Mode，Tauri 只做「版本发现 + 进程管理 + 日志 + 基准测试 + 托盘」**
>
> **v2 修订要点**：v1 经本机真机实测（llama.cpp b10621/b10809 + 真实模型库）校正了三处硬伤与一处整体冗余，
> 删除 Tauri 自建网关与 `/api/*` 层（前端直连 router），改为「应用递归扫描 → 生成 `presets.ini` → router 加载」。
> 详见 `REFACTORING_REVIEW.md` 与本文 §3 实测基线。v1 的原始方案已从仓库移除（它被本文 v2.1 取代，v1 被否掉的理由记在 `REFACTORING_REVIEW.md` 里）；要原文时从 git 历史取：`git show 660204d:REFACTORING_PLAN.v1-original.md`。
>
> **v2.1 补充（GPU 多卡 + 共享 CUDA 运行时）**：按真实环境实测补齐两项硬需求——
> ① **多块显卡全部参与推理**：原生 `--fit`（默认开）会自动测量各设备空闲显存、用试位法分配每卡层数并自动生成 `--tensor-split`；
> ② **用户指定的 llama.cpp 目录下，不同版本共享同一份 CUDA 运行时**：Windows DLL 搜索**不递归**，
> 必须把「直接包含 `cudart64_*/cublas64_*` 的目录」精确注入子进程 `PATH`（注入父目录无效）。
> 见 §4.5、§4.6 与 §3 实测 13–18。

---

## 文档信息

| 项 | 内容 |
|----|------|
| 来源项目 | llama.cpp-hub（Java 21 + Netty + 原生 JS/PWA） |
| 目标 | Tauri 2 桌面应用（Rust 后端 + **React 19 + TypeScript + Vite** 前端） |
| 状态 | **P1–P6 全部实现完成**；P6（托盘 / 自启动 / NSIS 打包）的实现细节与偏差见文末「附录 B」 |
| 参考实现 | 原项目**默认首页** `index.html` + `css/index.css` + `js/model-list.js` / `js/model-action-modal.js`（用户实际看到的那一套）、`win/AutoStartManager.java`、`win/WindowsTray.java`，留存在 `tmp/ref/` 供对照 |
| 目标环境 | Windows（本次实测平台），需 llama.cpp ≥ 2025-12 构建（支持 Router Mode） |

> **UI 参照系（重要，2026-09 修正）**：hub 的 Web 资源里有两套界面 —— 默认首页
> `index.html`（`css/index.css`，用户打开 `http://localhost:9999` 看到的就是它）与
> `index-new.html`（`css/newui.css`，需要手动访问）。前端最初按 `newui` 复刻，导致
> 与用户看到的界面长期不一致（`环境变量`、紧凑视图等只存在于旧版）。现已改为
> **照搬 `index.html` 那一套**：`src/styles/legacy/index.css` 原样引用，React 侧沿用
> 它的类名（`.sidebar/.nav-item/.top-bar/.model-item/.modal/.param-group/.form-control` …），
> 需要 hub 的 id 作用域样式时把同样的 id 放到对应元素上（如弹窗用 `id="loadModelModal"`）。

---

## 一、背景与目标

### 1.1 源码现状（已核实）

| 层级 | 技术 |
|------|------|
| 后端 | Java 21 + Netty 4.1 + Maven |
| 前端 | `src/main/resources/web/` 原生 JS/CSS/HTML + PWA |
| 进程模型 | `LlamaCppProcess`/`LlamaServerManager`：**每个模型独立进程**，自研 LRU/自动加载/日志分流 |
| 启动器 | `launcher/launcher.c` |

源码功能面：模型管理、EasyChat、多协议 API、Web 管理面板、远程节点、MCP、下载管理器、在线更新。

参考实现规模（行数实测统计）：`models.js` 308、`model-config.js` 746、`model-detail.js` 385、`logs.js` 234、`benchmark.js` 818，合计 **2491 行**；图表为 canvas 手绘，无图表库依赖。

### 1.2 关键决策

| 决策 | 结论 | 含义 |
|------|------|------|
| 进程/自动加载架构 | **只走 llama.cpp Router Mode** | 不写进程池/LRU/自动加载，全是原生；约束：`llama-server` 必须 ≥ 2025-12 |
| 对外 API 入口 | **router 直接对外，Tauri 不做网关**（v2 修订） | `/v1/*` 由 router 提供，dsh/OpenAI SDK 直连其端口；删除 axum/reqwest 代理与 `/api/*` 层 |
| 模型来源 | **应用递归扫描 → 生成 `presets.ini` → `--models-preset` 启动**（v2 修订） | 不改动用户既有目录结构；`--models-dir` 仅作可选补充来源 |
| 前端取数 | **webview 直连 router HTTP + SSE**（v2 修订） | router 的 CORS 默认放开；前端自研 HTTP 层为 0，Tauri 命令只留给系统能力 |
| 多卡策略 | **默认不限制设备，交给原生 `--fit`**（v2.1） | 不传 `--device`/`-ngl`/`-ts` 时，`--fit` 自动把模型铺满所有可见设备并生成张量切分；per-model 可用 preset 段覆盖设备组合 |
| 共享 CUDA 库 | **子进程环境注入 `PATH`，不改系统 PATH**（v2.1） | 版本目录通常不带 `cudart64_*/cublas64_*`；按版本名中的 `cuda-<X.Y>` 匹配同根目录的 `cudart-*` 目录并注入 |
| 聊天范围 | **只暴露 API，不建聊天 UI** | 前端只做 3 个页面；聊天由外部客户端（dsh 等）调 `/v1/chat/completions` |
| 二进制来源 | **用户自带，启动时扫描指定目录** | 不捆绑大文件；`llama-bench` 从同版本目录取 |
| 前端技术栈 | React 19 + TS + Vite（v2 确认） | 组件化，便于后续扩展；页数少，状态用轻量 hooks + 少量 Zustand |

### 1.3 功能取舍清单

| ✅ 保留 | ❌ 移除 |
|---------|---------|
| 模型管理（加载/卸载/GGUF 发现/per-model presets） | 便宜聊天(EasyChat) UI |
| 日志（实时查看、按源过滤） | 多协议 API（只保留 OpenAI 兼容，由 router 提供） |
| 性能测试（llama-bench + API 压测） | 远程节点聚合 |
| 自动加载（llama.cpp 原生 autoload） | 在线更新 |
| 多版本 llama.cpp 支持 | MCP 服务器（原生 `--tools`/`--mcp-servers-*` 已具备，本应用不做 UI） |
| 手动加载/卸载按钮 | 模型克隆 |
| dsh 兼容 API（`/v1/*`，router 直连） | 音视频输入、背景/头像、用量统计等花哨项 |
| 模型收藏（列表页） | 实时速度(t/s)显示 |
| 自启动 + 常驻后台（托盘） | VRAM 估算、能力位开关、采样配置库、聊天模板编辑（无原生来源，自研成本高） |

> **v2 新增（近乎零成本，原生已具备）**：从 HF 仓库下载模型（`POST /models`）、删除缓存模型（`DELETE /models`）、
> 模型状态实时进度（`/models/sse` 的 loading stages）、空闲休眠（`--sleep-idle-seconds`）。
> 是否开放下载 UI 由 P3 决定（一个输入框 + 一个进度条即可）。

---

## 二、技术架构

### 2.1 整体架构（v2：无网关，直连）

```
┌──────────────────────────── Tauri 2 桌面应用 ────────────────────────────┐
│  Rust 后端（薄壳，约 1450 行）              React 前端（webview）          │
│  ┌────────────────────────────────┐      ┌───────────────────────────┐  │
│  │ router.rs   进程生命周期/端口    │      │ 模型列表页（主力）          │  │
│  │ versions.rs 版本扫描+能力探测    │      │ 日志页                    │  │
│  │ models.rs   递归扫描+preset 读写 │      │ 性能测试页                 │  │
│  │ logbuf.rs   stdout→环形缓冲→事件 │      │ 配置 Sheet / 详情 Sheet    │  │
│  │ bench.rs    llama-bench 子进程   │      └────────────┬──────────────┘  │
│  │ stress.rs   API 压测并发         │                   │                 │
│  │ settings.rs 配置/收藏持久化      │   Tauri 命令(12)   │  HTTP + SSE     │
│  │ tray.rs     托盘/自启动          │◄──────────────────┤  直连 127.0.0.1 │
│  └───────────────┬────────────────┘                   │                 │
└──────────────────┼────────────────────────────────────┼─────────────────┘
                   │ spawn/kill                          │
                   ▼                                     ▼
        ┌───────────────────────────────────────────────────────────────┐
        │  llama-server（router mode，用户自带二进制，应用拉起）           │
        │  --models-preset <appdata>/presets.ini --port 8080 --host 127.0.0.1 │
        │                                                               │
        │  /v1/*            → dsh / OpenAI SDK 直连（无中间层）           │
        │  /models          → 模型列表 + 状态                             │
        │  /models/load|unload  /models/sse  /props?model=               │
        │  POST /models（下载）  DELETE /models（删除缓存）                │
        └───────────────────────────┬───────────────────────────────────┘
                                    │ 原生 autoload / LRU / sleep
                                    ▼
                     模型实例（随机端口，日志带 [port] 前缀回到 router stdout）
                                    │
                                    ▼
                     模型目录（用户既有结构，如 E:\AI\models\<作者>\<模型>\*.gguf）
```

**关键点**：外部客户端与前端都直连 router 的同一个端口；Tauri 不代理任何推理流量，因此没有 SSE 透传、没有双通道状态一致性问题、没有多余一跳。

### 2.2 为什么删掉 v1 的「统一网关」

| v1 做法 | 实测结论 |
|---------|---------|
| Tauri 起 axum 反代 router 的 `/v1/*`（含 SSE 透传） | router 本身就是代理（日志：`proxying request to model X on port N`），再加一层是纯损耗；v1 自己在风险里承认 SSE 透传需保证 chunk 与连接生命周期，属自找风险 |
| Tauri 提供 `/api/*` 15 个管理端点给前端 | 与 router 原生 `/models*` 完全重复；前端直连即可 |
| 前端走 Tauri 命令、外部走 axum、共用 shared services | 每个功能写两遍入口 + IPC 序列化开销；实测 CORS 默认 `*`，webview 可直连 localhost |

代价：外部客户端需要知道 router 端口（由应用显示并可配置），仅此一项。

### 2.3 Router Mode 的真实能力（实测确立）

官方能力（`tmp/server-README.md`，实测于 b10809）：

- 不带 `-m` 启动即进入 router mode；模型来源三选：cache（`LLAMA_CACHE`）、`--models-dir`、`--models-preset`。
- 按需加载、LRU 淘汰（`--models-max`，**默认 4**，0 = 不限）、autoload（默认开，`--no-models-autoload` 关闭，也可用 `?autoload=false` 按请求控制）。
- 路由规则：POST 用 body 的 `model` 字段；GET 用 `?model=` 查询参数。
- 每个模型一个子进程（崩溃互不影响），子实例端口随机分配。
- 预设专属键：`load-on-startup`、`stop-timeout`、`dedup-cache-models`。
- 空闲休眠：`--sleep-idle-seconds`（默认 -1 关闭）。

### 2.4 目录结构约定（v2 修正：不改用户目录）

**实测：`--models-dir` 只扫描一层**——顶层 `*.gguf` 视为单文件模型；顶层子目录内的 gguf 组成一个模型（多模态/多分片）；**更深层完全不扫描**。用户既有目录 `E:\AI\models\<作者>\<模型名>\*.gguf`（两层）会得到 **0 个模型**。

因此：

```
应用数据目录/
├── settings.json          # 用户配置（模型根目录、llama.cpp 目录、端口、收藏…）
└── presets.ini            # 应用生成/维护，交给 router（原生 INI 格式）

用户已有的模型目录（保持原样，不被改写）：
E:\AI\models\              ← 用户在设置中选择「模型根目录」（可多个、可任意层级）
├── OpenBMB\
│   ├── MiniCPM5-2B\MiniCPM5-2B-Q8_0.gguf
│   └── MiniCPM-V-4.6\{MiniCPM-V-4_6-F16.gguf, mmproj-model-f16.gguf}   ← mmproj 同目录 = 多模态模型
└── TokenRhythm\NeoHorse-1-9B-Q5_K_M\NeoHorse-1-9B-Q5_K_M.gguf
```

`presets.ini` 示例（键 = 命令行参数去掉前导横线；全局段是 `[*]` **不是** `[DEFAULT]`；`version = 1` 必需）：

```ini
version = 1

[*]
ctx-size = 32768
n-gpu-layers = 99
flash-attn = auto

[OpenBMB/MiniCPM5-2B-Q8_0]
model = E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf
temp = 0.7
top-p = 0.95
top-k = 40
min-p = 0.05
repeat-penalty = 1.1
load-on-startup = false

[OpenBMB/MiniCPM-V-4.6-F16]
model = E:/AI/models/OpenBMB/MiniCPM-V-4.6/MiniCPM-V-4_6-F16.gguf
; mmproj 不需要写键：同目录下文件名以 mmproj 开头的 gguf 会被自动识别
```

**禁止**在 preset 里写 `port`/`host`/`api-key`/`alias`/`hf-repo` —— 这些由 router 掌管，会被移除或覆盖（官方 README 明示）。

---

## 三、实测基线（v2 的事实依据）

> 完整证据与命令留痕见 `REFACTORING_REVIEW.md`。以下每条都已在本机复现。

| # | 结论 | 对设计的影响 |
|---|------|-------------|
| 1 | b10621 与 b10809 均支持 `--models-dir/--models-preset/--models-max/--models-autoload/--sleep-idle-seconds`；`--help` 输出 57–59KB，冷启 1575ms / 热 152ms | 能力探测必须缓存到 `settings.json`，不要每次启动都跑 |
| 2 | preset 生效链路完整：`version=1` + `[*]` + 段名=模型 id；`GET /models` 回显 `status.preset` 与渲染后的 `status.args`；`load-on-startup` 生效 | preset 生成器是唯一必须写对的配置件 |
| 3 | 改 ini 后 `GET /models?reload=1` **立即生效**（新模型出现为 unloaded，已加载模型保持） | 保存配置无需重启 router |
| 4 | `POST /v1/chat/completions`（body 带 `model`）触发 autoload → 子实例 3.6s 完成加载并推理 | 网关的"确保已加载"策略不需要 |
| 5 | `GET /v1/models` **列出未加载模型** | dsh 可直接发现全部模型，无需网关补齐 |
| 6 | 子实例日志合并进 router stdout，行首带 `[<随机端口>]`；router 自身行无前缀 | 日志页只需采集一个进程，按前缀分流即可实现"系统/各模型"过滤 |
| 7 | 强杀 router 后子实例全部自动退出（实测残留 0） | 无需自研子进程回收；`router_stop` 直接 kill 父进程 |
| 8 | **中文路径下 router 无法 spawn 子实例**（`failed to spawn server instance`，自身路径乱码）；换 ASCII 路径 junction 后同一 preset 成功 | 必须做 ASCII 路径校验与一键修复（§5.2） |
| 9 | `--models-dir` 只扫一层；两层结构 → 0 个模型 | 采用「递归扫描 + preset」为主路径 |
| 10 | `GET /models` 无 `size`/`quantization` 字段；`GET /props?model=` 有 `model_ftype`（如 `Q8_0`）、`modalities`、`n_ctx`、`total_slots`、`chat_template`、`build_info`、`is_sleeping` | 详情页已加载模型用 `/props`；未加载模型用扫描结果 + 文件 stat + 文件名正则 |
| 11 | `llama-bench -o <csv\|json\|jsonl\|md\|sql>`（默认 md），支持 `--list-devices`、`--progress` | 结果解析 = 解析 JSON，无需文本解析器 |
| 12 | router 启动即告警「CORS 允许所有来源且无 API key」 | webview 可直连 localhost；若需鉴权用 `--api-key` |
| 13 | 多卡默认行为：`--split-mode` 默认 `layer`、`--n-gpu-layers` 默认 `auto`、`--fit` **默认 `on`**；`--fit` 会自动分配每卡层数并生成 `--tensor-split` | 「多卡都要用上」默认即满足；**不要**预填 `-ngl`/`-ts` |
| 14 | `--fit` 的**中止条件**：用户显式设置 `-ngl`、`-ts` 或 `-c` 时跳过对应调整；`-sm tensor` 完全不支持（`not implemented for SPLIT_MODE_TENSOR`），`-sm row` 无法调整权重分配 | UI 的「GPU 层数」默认应为**空**（不传），否则等于关掉多卡自动分配（hub 的 153 条配置里 125 条正是这么关掉的） |
| 15 | `--device` 在 **router 参数解析阶段强校验**：`--device CUDA0,CUDA1` 中 `CUDA1` 不存在 → `invalid device: CUDA1`，**router 直接启动失败** | 设备列表必须由实时枚举驱动，不能直接用用户配置里的历史设备名 |
| 16 | 设备名**大小写不敏感**：`--device cuda0` 被接受并原样渲染 | 可兼容 hub 既有的小写 `cuda0` 配置 |
| 17 | 多卡参数通路（实测）：router CLI 传 `--device CUDA0,CUDA0` → 子实例 args 原样保留；**preset 段**写 `device = CUDA0,CUDA0`/`tensor-split = 3,1`/`split-mode = layer`/`main-gpu = 0` 也**完整渲染**；优先级 CLI > 模型段 > `[*]` 段（CLI 会覆盖段值） | 全局组合放 router CLI，**per-model 组合放 preset 段**（两者都可行） |
| 18 | `llama-fit-params -fitp on` 输出逐设备显存预估：`CUDA0 2279 5376 259` = `设备 模型MiB 上下文MiB 计算MiB`（多卡时每卡一行） | 原生替代「VRAM 估算」，多卡显存可见性零自研 |
| 19 | Windows DLL 搜索**不递归**：把父目录放进 `PATH` 或只设 CWD 无效/有效规则为——只有「直接包含 DLL 的目录」在 `PATH` 里、或该目录为 CWD 时才能加载 | 共享 CUDA 库必须精确指向 `cudart-*` 目录本身 |
| 20 | 注入的 `PATH` 被 router 与模型子实例**逐级继承**（实测：版本目录不含 cudart，仅靠注入的 PATH，子实例仍成功用 CUDA 加载并推理 144.7 t/s） | 只需在 Tauri spawn router 时注入一次，全部模型实例自动生效 |

---

## 四、后端详细设计（Rust / Tauri 2）

### 4.1 目录结构

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json               # CSP 需允许 connect-src http://127.0.0.1:* http://localhost:*
├── capabilities/default.json
└── src/
    ├── main.rs                   # 入口（单实例、托盘、窗口隐藏）
    ├── lib.rs                    # 命令注册 + 插件注册 + 事件
    ├── state.rs                  # AppState：设置、router 句柄、日志缓冲、bench/stress 任务表
    ├── router.rs                 # ★ router 生命周期：spawn/kill/重启/状态/端口检测/退出清理
    ├── versions.rs               # ★ 版本扫描 + --help 能力探测与缓存 + 共享 CUDA 目录匹配
    ├── gpu.rs                    # ★ 设备枚举与校验、--fit 参数组装、fitp 显存预估解析
    ├── models.rs                 # ★ 递归扫描 gguf、分组（mmproj/多分片）、presets.ini 读写、收藏
    ├── logbuf.rs                 # ★ stdout/stderr 采集、按 [port] 分流、环形缓冲、批量事件
    ├── bench.rs                  # ★ llama-bench 子进程（-o json）+ 结果落盘/列表/删除
    ├── stress.rs                 # ★ reqwest 并发压测 + 吞吐统计
    ├── settings.rs               # settings.json 读写（含默认值、迁移）
    ├── winfix.rs                 # ★ ASCII 路径校验、junction 创建、端口占用检测
    └── tray.rs                   # 托盘图标与菜单、关闭隐藏
```

（★ = 与应用逻辑强相关的模块；`api/`、`services/` 目录在 v2 中**不存在**。）

### 4.2 模块职责与估算

| 模块 | 职责要点 | 估算行数 |
|------|---------|---------|
| `router.rs` | 组装命令行（`--models-preset`/`--port`/`--host`/`--models-max`/GPU 参数/可选 `--api-key`）；**构造子进程环境**（共享 CUDA 目录 → `PATH`）；`tokio::process` spawn；stdout/stderr 交给 `logbuf`；健康探测（`GET /health`）；kill/重启；崩溃检测与事件；退出时确保不残留 | ~220 |
| `versions.rs` | 扫描用户指定目录（支持 `<dir>/<版本子目录>/llama-server.exe` 与 `<dir>/llama-server.exe` 两种布局）；对候选执行 `--help` 探测 `--models-dir`，结果缓存（版本名+mtime+结论）；**按版本名中的 `cuda-<X.Y>` 匹配同根 `cudart-*` 目录**；返回 server/bench/fit-params 绝对路径 | ~120 |
| `gpu.rs` | `--list-devices` 枚举与解析（名称/显存/空闲）；设备名校验与纠正（大小写不敏感、剔除失效设备）；`--fit`/`--fit-target`/`--split-mode`/`--tensor-split`/`--main-gpu` 的组装与互斥规则；`llama-fit-params -fitp on` 显存预估解析 | ~110 |
| `models.rs` | 递归扫描模型根目录 → 分组规则（见 §4.3）；生成/更新 `presets.ini`（保留用户手写段）；id 归一化（唯一、可用于请求 `model` 字段）；收藏列表读写；扫描结果缓存（mtime） | ~180 |
| `logbuf.rs` | 后台任务读 router stdout（UTF-8 容错，`from_utf8_lossy`）；ring buffer（上限 10000 行）；`^\[(\d+)\]\s` 分流并映射 port→model（映射由 `/models` 与 SSE 维护）；每 100ms 或 50 行批量发事件 | ~120 |
| `bench.rs` | 拼参数（`-m/-p/-n/-ngl/-dev/-r/-o json`）；spawn `llama-bench`；解析 JSON 行；写结果文件（`<appdata>/benchmarks/<时间戳>.json`）；进度事件；取消 | ~150 |
| `stress.rs` | reqwest `Client` 连接池；N 并发循环打 `/v1/chat/completions`（非流式，读 `timings`）；统计 avg/min/max/p50/p95、prompt/predict t/s；进度事件；取消 | ~160 |
| `settings.rs` | `settings.json`（§8.4）；默认值；原子写；收藏并入 | ~100 |
| `winfix.rs` | exe 路径 ASCII 校验；`cmd /c mklink /J` 创建 ASCII 链接（不需管理员）；端口占用检测（TcpListener bind 探测） | ~70 |
| `tray.rs` | `TrayIconBuilder`：打开窗口 / 启动停止 router / 退出；`CloseRequested` → hide | ~60 |
| 自启动 | 官方 `tauri-plugin-autostart`（写 `HKCU\...\Run`）+ 设置开关 + 启动时校验 exe 存在 | ~15 |
| `lib.rs`/`state.rs`/命令胶水 | 12 个命令（§5.1）+ 4 类事件（§5.2） | ~130 |
| **合计** | | **~1445** |

对比 v1（axum 网关 + `/api/*` + 双通道 services）约 3370 行，**减少约 62%**，且删掉的正是风险最高部分。

### 4.3 模型扫描与分组规则（`models.rs` 核心算法）

```
scan(root):
  遍历 root 下所有 *.gguf（递归，跳过隐藏目录与 *.part/*.tmp）
  对每个含 gguf 的目录 D：
    files = D 下所有 gguf
    主文件 = files 中非 mmproj 开头、非分片编号的
    若 主文件 数量 == 1:
        若 存在分片兄弟（*-000NN-of-000MM.gguf 同一前缀）→ 一个多分片模型
        否则 → 单文件模型
    若 主文件 数量 > 1: 每个主文件各成一个模型（同目录多模型是常见布局）
    mmproj 文件（文件名以 mmproj 开头）→ 归属同目录的模型；若目录内只有 mmproj 则忽略该目录
  id 生成（唯一、稳定、对用户可读）:
    优先「相对 root 的目录名」；两处同名则加父级或短哈希后缀
    id 同时写入 preset 段名，前端与 dsh 都用它作为 "model" 值
  输出: ScannedModel { id, path, dir, size, quant(文件名正则), mmproj: Option<PathBuf>, shards: usize, mtime }
```

量化正则候选：`(IQ\d+_[A-Z0-9_]+|Q\d+_[A-Z0-9_]+|Q\d+_\d+|BF16|F16|F32|FP8|NVFP4|MXFP4)`。

### 4.4 router 启动命令行（v2）

```powershell
<llama-dir>\llama-server.exe `
  --models-preset <appdata>\presets.ini `
  --port <settings.port> --host 127.0.0.1 `
  --models-max <settings.models_max> `        # 默认 4（原生默认），仅在用户修改时传
  [--api-key <settings.api_key>] `            # 可选
  [--sleep-idle-seconds <n>] `
  [--no-models-autoload]                      # 可选，默认保持原生开启
```

规则：
- **始终用 `--models-preset`**（不用 `--models-dir`；如需支持用户自维护的 models-dir，作为可选第二来源追加 `--models-dir`，但要在 UI 提示"该目录只支持一层"）。
- 启动前：①校验 exe 路径纯 ASCII（否则走 §5.2 修复流程）；②检测端口占用。
- 启动后：轮询 `GET /health`（≤15s）判定成功；记录实际 pid 与端口。
- 停止：kill 父进程即可（实测子实例自动退出）。
- 崩溃：`tokio::process::Child::wait` 返回即发 `router://status` 事件，托盘可提供重启。

---

### 4.5 GPU 与多卡（v2.1 新增）

**原则：默认不限制设备，把显存分配交给原生 `--fit`。** 实测确认 llama.cpp 的默认行为已经满足「多块显卡都能被模型使用」：
`--split-mode` 默认 `layer`（分层流水，跨卡切分权重与 KV）、`--n-gpu-layers` 默认 `auto`、`--fit` **默认 `on`**——
启动时测量每张卡的空闲显存，用试位法（regula falsi）从后向前计算每卡能容纳多少层，并自动生成 `--tensor-split`；
MoE 模型还会把专家张量溢出到系统内存（`common/fit.cpp`）。

| 参数 | 默认 | 说明 | 与 `--fit` 的关系 |
|------|------|------|------------------|
| `--device` | 不传（= 全部可见设备） | 逗号分隔（`CUDA0,CUDA1`），**大小写不敏感**（`cuda0` 可用） | 限制参与分配的设备 |
| `--split-mode` | `layer` | `layer` 分层流水（多卡推荐）/ `row` 按行并行 / `none` 单卡 / `tensor` 实验性 | `tensor` 与 `--fit` **不兼容**（直接中止）；`row` 下 `--fit` 无法调整权重分配 |
| `--tensor-split` | 不传（由 fit 生成） | 各卡分片比例，如 `3,1` | 显式设置会**中止** fit 的自动切分 |
| `--n-gpu-layers` | `auto` | 默认自动 | **显式设置会中止 fit 的层分配** ★ 关键陷阱 |
| `--main-gpu` | `0` | `split-mode=none` 时选卡；`row` 时决定 KV 位置 | 无关 |
| `--fit-target` | `1024` MiB | 每设备安全余量，多卡可 `2048,512`（异构显存） | — |
| `--fit-ctx` | `4096` | fit 允许缩减到的最小上下文 | — |
| `--n-cpu-moe` / `--cpu-moe` | 关 | 把 MoE 专家权重留在 CPU（单卡跑 35B-A3B 依赖它；hub 的 153 条配置里 53 条用到） | fit 的第 4 步也会做 MoE 溢出 |

**三层配置模型**（优先级实测为 CLI > preset 模型段 > preset `[*]` 段）：

| 层 | 落在哪 | 适用场景 |
|----|--------|---------|
| 全局默认 | `settings.gpu` → router 命令行 | 「所有模型统一用全部卡」 |
| per-model | preset 模型段（`device`/`split-mode`/`tensor-split`/`main-gpu`） | 「大模型用 2 卡、小模型用 1 卡」——实测这些键在段内**完整渲染**进子实例命令行 |
| 临时 | UI 覆盖一次 | 调试 |

> ⚠️ 因为 CLI 优先级最高，**若把 GPU 参数写进 router 命令行，preset 段就无法覆盖它**。因此本方案默认
> **不在 router 命令行传 GPU 参数**，而是写进 preset 的 `[*]` 全局段（可被模型段覆盖），仅在用户明确选择
> 「所有模型强制使用同一组卡」时才提升到命令行。

**设备枚举与校验（必须实现）**：

- `gpu.rs` 解析 `llama-server --list-devices`，格式实测为
  `CUDA0: NVIDIA GeForce RTX 5070 Ti Laptop GPU (12226 MiB, 11042 MiB free)`。
- `--device` 在 **router 参数解析阶段就强校验**：`--device CUDA0,CUDA1` 中若 `CUDA1` 不存在 →
  `error while handling argument "--device": invalid device: CUDA1` → **router 直接启动失败**。
  因此 UI 的设备项**必须是枚举结果驱动的多选**（不给自由文本），且启动前要用最新枚举结果过滤用户配置。
- **兼容 hub 既有配置**：hub 的 `launch_config.json` 里 `device` 取值只有 `cuda0`（94 条）与 `All`（7 条）——
  `All` 应映射为「不传 `--device`」；`cuda0` 经校验存在后原样传（大小写不敏感）。
- **`CUDA_VISIBLE_DEVICES`**：可作为进程级总开关（可选支持），但**不适合做 per-model 机制**——
  preset 只接受命令行参数名与 `LLAMA_ARG_*` 形式的环境变量键，无法表达任意自定义环境变量。

**显存可见性与预估（零自研）**：

```bash
llama-fit-params --model <gguf> -fitp on
# 输出：<设备> <模型MiB> <上下文MiB> <计算MiB>
CUDA0 2279 5376 259
Host  270  0    136
```

多卡时每张卡一行 → 直接实现配置面板的「显存预估」按钮，替代原方案里被砍掉的 VRAM 估算。
`llama-fit-params` 也可输出可直接复用的 CLI 参数（`-c/-ngl/-ts/-ot`），用于「算一次、固定下来写回 preset」的工作流。

---

### 4.6 共享 CUDA 运行时库（v2.1 新增）

**背景**：llama.cpp 的 Windows 发行包**不含** CUDA 运行时；官方另发 `cudart-llama-bin-win-cuda-<X.Y>-x64`
包（内容为 `cudart64_*`、`cublas64_*`、`cublasLt64_*`，约 490–550 MB）。用户的目录形态（实测）：

```
E:\AI\llama.cpp-hub\llamacpp\
├── cudart-llama-bin-win-cuda-12.4-x64\     ← 共享 CUDA 运行时（3 个 DLL，~546 MB）
├── cudart-llama-bin-win-cuda-13.3-x64\     ← 共享 CUDA 运行时（3 个 DLL，~489 MB）
└── llama-b10831-bin-win-cuda-13.3-x64\     ← 版本目录（30 个 DLL + llama-server.exe，**不含 cudart**）
```

需求是：**一份 CUDA 运行时被同目录下不同版本的 llama.cpp 共用**，而不是每个版本各存一份。

**Windows DLL 搜索顺序实测**（本次实测，直接决定实现方式）：

| 场景 | `PATH` | 工作目录 | `--list-devices` 结果 |
|------|--------|---------|---------------------|
| 1 | 不含 CUDA 目录 | 版本目录 | ❌ `(none)` |
| 2 | **直接包含 DLL 的目录** | 版本目录 | ✅ `CUDA0: ...` |
| 3 | **父目录**（DLL 在其子目录中） | 版本目录 | ❌ `(none)` |
| 4 | 不含 CUDA 目录 | **直接包含 DLL 的目录** | ✅ `CUDA0: ...` |

**结论：DLL 搜索不递归。** 必须把「直接包含 `cudart64_*` 的目录」加进 `PATH`（或把它设为工作目录）。
只把 `llamacpp\` 根目录加进 PATH 是**无效**的——这是本需求最容易踩的坑。

**实现**（在 `router.rs` 里为子进程构造环境，只影响本应用启动的进程，**不修改系统 PATH**）：

```
PATH = <共享 CUDA 目录 1>;<共享 CUDA 目录 2>;…;<版本目录>;<原有 PATH>
CWD  = <版本目录>
```

**共享目录的发现规则**（`versions.rs`，按优先级）：

1. `settings.shared_lib_dirs`（用户显式指定，最高优先）；
2. **按版本名匹配**：从 `llama-b10831-bin-win-cuda-13.3-x64` 提取 `cuda-13.3`，在同一父目录下查找名称含相同
   `cuda-13.3` 且直接包含 `cudart64_*.dll` 的目录（即 `cudart-llama-bin-win-cuda-13.3-x64`）；
3. 兜底：扫描 llama.cpp 根目录下一层内所有 `cudart-*` 目录；
4. **注入后回读校验**：`--list-devices` 若无 CUDA 设备，在 UI 明确报「CUDA 运行时未找到/版本不匹配」，
   而不是静默退回 CPU 推理（静默退回是这类问题最难排查的形态）。

**继承链实测**：Tauri 注入的 `PATH` → router → 模型子实例**逐级继承**。实测在版本目录完全不含 cudart、
系统 PATH 中的 cudart 项被剔除、仅靠注入的环境下，子实例仍成功用 CUDA 加载并推理（144.7 t/s）。
因此只需在 `router_start` 时注入一次。

**注意与限制**：

- 不同 CUDA 大版本的运行时**不通用**（`cudart64_12.dll` vs `cudart64_13.dll`），故按 `cuda-<X.Y>` 精确匹配；
  多个 cuart 目录可同时注入 `PATH`，由 DLL 名区分，互不冲突。
- CUDA 版本需与显卡驱动兼容（本机驱动 610.47 / RTX 5070 Ti，CUDA 13.x 可用）。
- 若某个版本目录**自带** cudart（部分第三方打包），exe 目录优先级最高，行为仍正确。
- 现状中 `llamacpp\` 下的两个 cudart 目录已被手工加入**系统 PATH**，hub 依赖这一点；本方案不应依赖，
  但应在注入时把系统 PATH 保留在后面（避免破坏用户其它工具）。
- 中文路径与 CUDA 无关，但仍受 §3 实测 8 的约束（llama.cpp 自身路径必须纯 ASCII）。

---

## 五、接口契约

### 5.1 Tauri 命令（前端 `invoke`）

| 命令 | 入参 | 返回 | 用途 |
|------|------|------|------|
| `router_status` | — | `RouterStatus {running, port, pid, version, uptime_s, last_error}` | 前端拿到 base_url 与状态条 |
| `router_start` | — | `RouterStatus` | 启动（含 ASCII/端口校验，失败返回结构化错误码） |
| `router_stop` | — | `RouterStatus` | 停止 |
| `router_restart` | — | `RouterStatus` | 重启 |
| `versions_list` | `{refresh: bool}` | `Vec<LlamaCppVersion>` | 版本列表 + 能力标记（缓存） |
| `versions_probe` | `{dir: String}` | `Vec<LlamaCppVersion>` | 用户新增/更换目录后探测 |
| `models_scan` | `{refresh: bool}` | `Vec<ScannedModel>` | 扫描模型根目录（结果给配置页用；列表页用 router 的 `/models`） |
| `preset_read` | `{model_id: Option<String>}` | `String` / `PresetSection` | 读取 preset（文本模式用全文） |
| `preset_write` | `{section, values}` 或 `{content}` | `()`（内部随后调 `reload=1`） | 保存配置 |
| `bench_run` / `bench_cancel` / `bench_list` / `bench_get` | — | 任务 id / 结果 | llama-bench |
| `stress_run` / `stress_cancel` | — | 结果 | API 压测 |
| `settings_get` / `settings_set` | patch | `Settings` | 设置与收藏 |
| `device_list` | `{refresh?}` | `Vec<DeviceInfo>` | `--list-devices` 枚举（名称/显存/空闲），供设备多选与有效性校验 |
| `fit_preview` | `{model_id, values}` | `Vec<FitRow>` | `llama-fit-params -fitp on` 逐设备显存预估（设备/模型/上下文/计算 MiB） |
| `fix_ascii_path` | `{path}` | `String`（新 ASCII 路径） | 一键 junction 修复 |
| `logs_snapshot` | `{source?, limit?}` | `Vec<LogLine>` | 进日志页先拉快照 |
| `open_path` | `{path}` | — | 打开目录（`tauri-plugin-opener`） |

### 5.2 事件

| 事件 | 载荷 | 频率 |
|------|------|------|
| `router://status` | `RouterStatus` | 状态变化时 |
| `logs://lines` | `Vec<LogLine>`（批量） | 100ms / 50 行合并 |
| `bench://progress` | `{id, line?, percent?}` | 运行中 |
| `stress://progress` | `{id, done, total, tps}` | 运行中 |

### 5.3 前端直连 router 的原生端点（`base = http://127.0.0.1:<port>`）

| 端点 | 方法 | 用途 | 关键字段 |
|------|------|------|---------|
| `/models` | GET | 模型列表 + 状态（列表页数据源） | `id, status.value, status.args, status.preset, architecture.input_modalities, source, can_remove` |
| `/models?reload=1` | GET | 保存 preset 后刷新 | 同上 |
| `/models/load` | POST | 手动加载 | body `{model}` |
| `/models/unload` | POST | 手动卸载 | body `{model}` |
| `/models/sse` | GET | 状态实时推送（列表页订阅） | `model_status` / `download_progress` / `model_remove` / `models_reload` |
| `/props?model=` | GET | 详情（已加载） | `model_ftype, modalities, n_ctx, total_slots, chat_template, build_info, is_sleeping, default_generation_settings` |
| `/health` | GET | 健康探测 | — |
| `/v1/models` | GET | dsh/外部客户端发现模型 | 含未加载模型 |
| `/v1/chat/completions` | POST | 推理（外部客户端 + 压测） | 响应含 `timings.*_per_second` |
| `/models` | POST | 下载 HF 模型（可选功能） | body `{model: "user/repo:quant"}` |
| `/models?model=` | DELETE | 删除缓存模型（`can_remove=true` 的） | preset 模型不可删 |

> dsh 接入：`base_url = http://127.0.0.1:<port>/v1`，`api_key` 任意（除非设置了 `--api-key`）。

---

## 六、前端详细设计（React 19 + TS + Vite）

### 6.1 目录结构

```
src/
├── main.tsx
├── App.tsx                     # 布局：Sidebar + 内容区 + 顶部状态条（router 状态/端口/启停）
├── styles/
│   ├── css/all.min.css         # FontAwesome（原样引用）
│   ├── legacy/index.css        # hub 默认首页的样式，**原样引用**（不自造令牌）
│   ├── legacy/css2.css + woff2 # 其字体依赖
│   └── app.css                 # 只补 hub 没有的少量工具类（.panel/.notice/.data-table/.log-view…）
├── ipc.ts                      # invoke 封装（12 个命令，带类型）
├── api/
│   ├── client.ts               # 直连 router 的 fetch 封装（base_url 由 router_status 提供）
│   └── sse.ts                  # /models/sse 的 EventSource 封装（重连/解析）
├── hooks/
│   ├── useRouterStatus.ts      # 状态条 + 全局可用性
│   ├── useModels.ts            # /models + SSE 增量更新（局部 patch，不全量重拉）
│   ├── useVersions.ts
│   ├── useLogs.ts              # logs_snapshot + logs://lines 批量订阅 + 环形缓冲
│   ├── useBenchmark.ts
│   └── useLocalStorage.ts      # 视图/密度/筛选记忆
├── stores/
│   └── app.ts                  # Zustand：设置、收藏、当前页
├── components/
│   ├── Layout/{Sidebar.tsx, StatusBar.tsx, Sheet.tsx}
│   ├── ModelList/{SearchBar.tsx, FilterChips.tsx, ModelCard.tsx, ModelGrid.tsx, EmptyState.tsx}
│   ├── ModelConfig/{ConfigSheet.tsx, PresetPicker.tsx, ParamFields.tsx, CommandPreview.tsx, RawIniEditor.tsx}
│   │   └── GpuSection/{DevicePicker.tsx, FitPreview.tsx}      # 设备多选（枚举驱动）+ 显存预估
│   ├── ModelDetail/ModelDetailSheet.tsx
│   ├── Logs/{LogSources.tsx, LogView.tsx, LogStatus.tsx}
│   └── Benchmark/{BenchModelList.tsx, LlamaBenchPane.tsx, ApiStressPane.tsx, ResultsTable.tsx, TpsChart.tsx}
├── pages/{ModelManager.tsx, Logs.tsx, Benchmark.tsx}
├── types/index.ts              # RouterModel / ScannedModel / LlamaCppVersion / LogLine / Settings / BenchResult
└── utils/{format.ts, quant.ts, storage.ts}
```

### 6.2 模型列表页（主力页，照搬 `models.js` 的交互）

- **顶栏控件**：搜索框（名称/id 过滤）、筛选 chip（全部/已加载/收藏）、排序 chip（名称/大小，升降）、视图切换（卡片/列表）、密度档（宽松/紧凑，**默认紧凑**）；视图与密度写 `localStorage`（`modelListView`/`modelListDensity`）。
- **数据来源**：`GET /models`（状态、来源、模态） + `models_scan`（体积、量化、mmproj、分片数）按 `id` 合并；订阅 `/models/sse` 做局部状态 patch。
- **卡片结构**（照搬原 `.model-card`，剔除克隆/速度）：
  - `.mc-head`：收藏 ★、模型图标（按架构）、名称（截断 + tooltip）、状态条（已停止/加载中·进度/已加载·端口/休眠/失败）、来源标签（preset/cache/自维护目录）
  - `.mc-meta`：架构、量化、体积
  - `.mc-foot`：主按钮（启动/配置/停止）、详情按钮
- **空态/骨架**：无模型 → 引导去设置里选「模型根目录」；首次加载 → 骨架屏。
- **错误处理**：加载失败展示 `status.failed` + `exit_code`（router 原生提供）。
- 单节点版不分组（去 `nodeHeader`）。

### 6.3 配置面板（照搬 `model-config.js` 的 `ModelConfig.open`，滑出 Sheet）

| 区块 | 内容 | 数据来源 |
|------|------|---------|
| 模型 ID | 只读，显示 preset 段名 | `/models` 的 `id` |
| 别名/备注 | **本地收藏表**，不写 preset（会被 router 覆盖） | `settings.json` |
| preset 段 | 选择/新增/删除模型段 | `preset_read` / `preset_write` |
| 参数表单（7 项） | GPU 层数(`n-gpu-layers`)、上下文(`ctx-size`)、温度(`temp`)、`top-p`、`top-k`、`min-p`、`repeat-penalty` | 硬编码 schema（**不解析 `--help`**，省 ~120 行；后续可扩展） |
| **GPU / 多卡** | 设备多选（默认「全部设备」= 不传 `--device`）、`--split-mode`、`--tensor-split`、`--main-gpu`、`--fit` 与 `--fit-target`；设备下拉项来自 `device_list`（**不提供自由文本**，避免无效设备导致 router 启动失败） | preset 模型段（可 per-model 覆盖） |
| **显存预估** | 按钮触发 `llama-fit-params -fitp on`，逐设备显示「模型/上下文/计算 MiB」 | 原生工具，零自研 |
| 额外参数 | 自由文本，追加到该段 | preset |
| 全局默认段 `[*]` | 全局 `ctx-size`/`n-gpu-layers`/`flash-attn` 等 | preset |
| 命令行预览 | 参数改动实时生成预览（可写回预设的键值对形式） | 前端本地计算 |
| 原始 INI 编辑 | 文本模式直接编辑段内容（保留用户手写段） | `preset_read/write` |
| 底部按钮 | 保存配置（写 preset + 调 `reload=1`）、启动模型（`/models/load`） | — |

> **不做**：VRAM 估算、能力位开关、主 GPU 联动、设备列表下拉（可后置；`device_list` 命令已预留）。

### 6.4 模型详情（轻量 Sheet）

已加载：`/props?model=` → 量化 `model_ftype`、上下文、slots、模态、build_info、是否休眠、默认采样参数。
未加载：扫描结果（体积、量化、分片数、mmproj 有无）+ preset 段内容。
（不做模板编辑/`chat_template_kwargs`/采样覆盖三块，共约 247 行参考实现。）

### 6.5 日志页（照搬 `logs.js`）

```
├─ 日志源列表（全部 / 系统(router 自身) / 各模型，已加载在前，未加载置灰）
├─ 日志显示区（<pre>，自动滚底；用户上翻时不跟随）
└─ 状态栏（当前源 · 匹配行数 · 缓冲上限 · 最近更新时间）
```

- 数据：`logs_snapshot`（进入页面/切换源）+ `logs://lines`（批量增量）；本地二次过滤 + 环形缓冲（上限 10000，超出修剪）。
- 过滤：`filter=null` → 全部；`filter='system'` → 无 `[port]` 前缀的行；`filter=<modelId>` → 该模型子实例端口前缀的行。
- 自动滚底：仅当滚动条在底部时跟随。
- 不做节点分组、不做落盘、不做外部 SSE（v2 删除 `/api/logs`）。

### 6.6 性能测试页（照搬 `benchmark.js` 的双模式 Tab）

**llama-bench 模式**
- 选择模型（列表页同源数据）→ 参数（`-p` 提示长度、`-n` 生成长度、`-ngl`、`-r` 重复次数、`-dev`）→ 运行。
- 后端：`llama-bench -m <gguf> ... -o json` → 解析 JSON → 结果表（模型/规模/后端/t/s 等）+ 图表。
- **显存提示**：llama-bench 会重新加载模型；若该模型已被 router 加载，运行前提示"将额外占用显存"，并提供"先卸载该模型"按钮。
- 结果：内存中保留本次结果 + 落盘历史列表（`bench_list`/`bench_get`）；导出 CSV/JSON 由前端从结果对象生成（可选）。

**API 压测模式**
- 选择**已加载**模型（未加载禁用运行）。
- 参数：promptTokens / maxTokens / 并发数 / 轮数。
- 后端 `stress.rs`：reqwest 并发打 router `/v1/chat/completions`（非流式），读 `timings.prompt_per_second` / `predicted_per_second`，统计 avg/min/max/p50/p95。
- **必须在 Rust 侧**：webview 对同一 origin 的 HTTP/1.1 连接数上限约 6，前端并发会把 32 并发排队成 6，吞吐严重失真。
- 结果：表格 + 图表；不做历史文件管理（可后置）。

---

## 七、数据模型

### 7.1 模型视图模型（前端合并后的结构）

```ts
interface ModelView {
  id: string;               // preset 段名 / router 返回的 id（请求时用）
  alias?: string;           // 本地别名（settings）
  architecture?: string;    // 由扫描结果的 GGUF 文件名/目录名启发式，或 /props 补充
  quantization?: string;    // 已加载: /props.model_ftype；未加载: 文件名正则
  size?: number;            // 扫描 stat
  status: 'unloaded'|'loading'|'loaded'|'sleeping'|'downloading'|'failed';
  port?: number;            // 从 status.args 的 --port 提取
  loadProgress?: number;    // SSE loading 事件的 progress.value
  source: 'preset'|'cache'|'models_dir';
  canRemove: boolean;
  favourite: boolean;
  mmproj?: string;
  shards?: number;
  error?: string;           // failed + exit_code
}
```

### 7.2 llama.cpp 版本

```rust
struct LlamaCppVersion {
    name: String,            // 目录名或 "default"
    dir: PathBuf,
    server_bin: PathBuf,
    bench_bin: Option<PathBuf>,
    has_router_mode: bool,   // --help 含 --models-dir
    devices: Vec<String>,    // --list-devices（懒加载）
    probed_at: u64,          // 缓存时间戳
}
```

### 7.3 日志行

```rust
struct LogLine { seq: u64, ts_ms: u64, text: String, model_id: String }  // model_id = "system" | 模型 id
```

### 7.4 设置（`<appdata>/settings.json`）

```jsonc
{
  "llama_cpp_dir": "E:/AI/LLM服务工具",        // 用户指定；多版本时下面存放各版本子目录
  "model_roots": ["E:/AI/models"],             // 模型根目录，可多个、任意层级
  "selected_version": "llama-b10809-bin-win-cuda-13.3-x64",
  "port": 8080,
  "models_max": 4,
  "gpu": {
    "devices": [],              // []=全部设备（不传 --device）；否则为枚举到的设备名，如 ["CUDA0","CUDA1"]
    "split_mode": "layer",      // layer(默认,与 --fit 兼容) | row | none | tensor(与 --fit 不兼容)
    "tensor_split": null,       // null=交给 --fit 自动分配；如 [3,1]
    "main_gpu": null,
    "fit": true,                // 默认 on
    "fit_target": null          // 每设备余量 MiB，null=默认 1024；多设备可 [2048,512]
  },
  "shared_lib_dirs": [          // 显式指定的共享 CUDA 运行时目录（直接含 cudart64_*/cublas64_*.dll）
    "E:/AI/llama.cpp-hub/llamacpp/cudart-llama-bin-win-cuda-13.3-x64"
  ],
  "api_key": null,
  "sleep_idle_seconds": -1,
  "autostart": false,
  "minimize_to_tray": true,
  "favourites": ["OpenBMB/MiniCPM5-2B-Q8_0"],
  "aliases": { "OpenBMB/MiniCPM5-2B-Q8_0": "小模型" },
  "view": { "mode": "card", "density": "compact" },
  "version_cache": { "<dir>": { "has_router_mode": true, "probed_at": 0 } }
}
```

---

### 7.5 从 llama.cpp-hub 迁移既有配置（`config/launch_config.json`）

hub 的真实配置结构（实测 153 个模型条目，每模型可有多套配置方案）：

```jsonc
{
  "MiniCPM-V-4.6": {
    "configs": {
      "默认配置": {
        "mode": "form",                    // form=表单模式 | cmd=命令行模式
        "envVars": "",                     // 自定义环境变量
        "enableVision": true,
        "extraParams": "",                 // 追加参数（常放 --jinja --chat-template-file ...）
        "cmd": "--ctx-size 16384 --flash-attn on --load-mode mmap+mlock --fit off --gpu-layers 99 ... --port 9100 --no-webui",
        "llamaBinPathSelect": "E:\\AI\\llama.cpp-hub\\llamacpp\\llama-b10831-bin-win-cuda-13.3-x64",
        "device": ["cuda0"],
        "mg": -1.0
      }
    },
    "selectedConfig": "默认配置"
  }
}
```

字段迁移对照：

| hub 字段 | 新方案落点 | 说明 |
|---------|-----------|------|
| `llamaBinPathSelect` | 模型 → 版本绑定 | hub 记录里出现过 **10 个不同版本目录**（b9864→b10831），而磁盘上只剩 1 个 → 应用必须容忍「配置指向的版本已不存在」并降级到默认版本 + 提示 |
| `cmd` | preset 模型段的键值对 | `--k v` → 一行 `k = v`；`--flag` → `flag = true` |
| `device: ["cuda0"]` | preset 段 `device = CUDA0` | 大小写不敏感；`["All"]` → 不写该键（= 全部设备） |
| `mg` | preset 段 `main-gpu` | hub 用 `-1` 表示「不指定」→ 新方案 `null` |
| `configs`（多套） | 多套配置 = 同一模型的多个 preset 段（或独立 ini） | 对应原方案的「配置方案选择」 |
| `mode: form/cmd` | 参数表单 / 原始 INI 编辑 | 两种编辑模式 |
| `extraParams` | 并入同一段 | — |
| `enableVision` | 由 `mmproj` 自动识别替代 | 目录内 `mmproj*.gguf` 即多模态 |
| `envVars` | ⚠️ 只能部分迁移 | 仅 `LLAMA_ARG_*` 形式的键可写进 preset；任意自定义环境变量无法 per-model 表达 |
| `--port 9100` | **删除** | router 为子实例分配随机端口，用户不需要固定端口 |

> 迁移建议：hub 的 153 条 `cmd` 里 **125 条显式写了 `--gpu-layers`、48 条写了 `--fit off`**——这两项在多卡场景下
> 会关掉原生自动分配，迁移时**建议丢弃**；仅当需要固定复现时才保留 `-ngl`。
> 另外 `--load-mode mmap+mlock` 在 hub 配置里出现 125 次，属于可保留的调优项。

---

## 八、关键实现要点（易错项）

1. **preset 生成器**（唯一必须"写对格式"的地方）
   - `version = 1` 首行；全局段 `[*]`；键 = 命令行参数去横线；布尔用 `true/false`。
   - 路径用正斜杠（`E:/AI/models/...`），避免反斜杠转义歧义。
   - **绝不写** `port`/`host`/`api-key`/`alias`/`hf-repo`。
   - 读-改-写：保留应用不认识的段与键（用户手写内容不能被吞）；写后通知前端并调 `/models?reload=1`。
   - 段名 = 模型 id，必须唯一且与前端/dsh 请求的 `model` 值一致。
2. **ASCII 路径处理**（中文路径会让模型全部加载失败）
   - `router_start` 前校验 `server_bin` 是否纯 ASCII；否则返回错误码 `NON_ASCII_PATH`，前端弹窗提示并提供「一键创建 ASCII 链接」。
   - 修复实现：`cmd /c mklink /J "<appdata>/runtime/<hash>" "<原目录>"`（junction 无需管理员权限），用链接路径启动 router。
   - 文档与设置页同时提示"建议将 llama.cpp 放在纯 ASCII 路径"。
3. **GPU 与共享 CUDA 库（v2.1）**
   - 设备列表**只能**来自 `--list-devices` 枚举；所有 `--device` 值必须先校验（无效设备会让 router 直接启动失败）。
   - 「GPU 层数」字段默认**留空**（不传 `-ngl`）——显式设置会中止 `--fit` 的自动层分配，等于放弃多卡自动适配。
   - 共享 CUDA 目录必须**精确**注入到子进程 `PATH`（父目录无效，实测）；注入后回读 `--list-devices` 校验，缺失即显式报错。
   - 注入只作用于本应用启动的进程，**不修改系统 PATH**（与 hub 并存时互不影响）。
   - `-sm tensor` 与 `--fit` 不兼容，UI 选择 tensor 时必须提示「需手动指定 ctx/tensor-split」。
4. **端口与残留**
   - 启动前 `TcpListener::bind` 探测端口占用；占用时提示改端口。
   - 停止 = kill 父进程（实测子实例自动退出）；应用退出（含托盘退出、任务管理器结束）时也应 kill，避免残留 router。
4. **日志**
   - 子实例行正则以 `^\[(\d+)\]\s` 识别；`port → model_id` 映射由 `/models`（`status.args` 中的 `--port`）与 SSE 事件维护，缺映射时归 "system" 并标记 `[port]`。
   - 环形缓冲 10000 行 + 批量事件（100ms / 50 行）；前端同样保留上限并修剪。
   - 编码：子进程输出可能夹杂非 UTF-8 字节，使用 `from_utf8_lossy`。
5. **前端直连配置**
   - `tauri.conf.json` 的 CSP：`connect-src 'self' http://127.0.0.1:* http://localhost:*`。
   - 不需要 `tauri-plugin-http`（CORS 已放开）；`EventSource` 需处理 router 重启后的重连（带退避）。
6. **能力探测缓存**：`--help` 冷启约 1.5s，只在首次或目录变更时探测，结果写 `version_cache`。
7. **`/models?reload=1` 的调用时机**：仅在保存 preset、用户点"刷新模型"时调用；不要轮询（会重扫并可能卸载被改动的运行中模型）。
8. **`--models-max` 默认就是 4**，不要无条件传参；仅在用户显式修改时追加。

---

## 九、开发计划

| 阶段 | 任务 | 关键产出 | 优先级 |
|------|------|---------|--------|
| **P1** | 脚手架 + 设置 | Tauri 2 + React 19 + Vite + TS 工程；`settings.rs`/`settings_get|set`；目录选择（`tauri-plugin-dialog`）；CSP 配置 | ⭐⭐⭐ |
| **P2** | 版本发现 + router 生命周期 + 运行环境 | `versions.rs`（探测+缓存+共享 CUDA 目录匹配）、`gpu.rs`（设备枚举/校验/预算）、`winfix.rs`（ASCII 校验/junction/端口检测）、`router.rs`（**子进程环境注入** + spawn/健康探测/停止/崩溃事件）；顶部状态条 | ⭐⭐⭐ |
| **P2b** | GPU 配置 UI | 设备多选、split-mode/tensor-split/main-gpu、`--fit` 与余量、显存预估（`fit_preview`） | ⭐⭐ |
| **P3** | 模型管理（主力页） | `models.rs`（递归扫描 + preset 生成/热重载 + 收藏）、`/models` + `/models/sse` 对接、列表页（搜索/筛选/排序/卡片列表/密度/收藏）、配置 Sheet、详情 Sheet | ⭐⭐⭐ |
| **P4** | 日志 | `logbuf.rs`（采集/分流/环形缓冲/批量事件）、日志页（源过滤/自动滚底/状态栏） | ⭐⭐ |
| **P5** | 性能测试 | `bench.rs`（`-o json` + 结果表/图表 + 显存提示）、`stress.rs`（并发压测 + 统计） | ⭐⭐ |
| **P6** | 托盘 + 自启动 + 打包 | `tray.rs`、`tauri-plugin-autostart`、关闭隐藏、`tauri build` installer | ⭐⭐ |

> **执行结果**：P1–P6 全部落地（P6 收尾记录见「附录 B」）。

> v1 的「P4 对外 `/v1/*` 网关」整阶段删除：router 直连即完成，dsh 只需把 base_url 指向 router 端口。

---

## 十、关键依赖

- **Tauri 2**（https://v2.tauri.app）：`tauri`、`tauri-build`、`tauri-plugin-dialog`、`tauri-plugin-opener`、`tauri-plugin-autostart`
- **Rust**：`tokio`（process/io/time/sync）、`reqwest`（压测，启用 `json`、`rustls-tls` 或系统 TLS）、`serde`/`serde_json`、`anyhow`、`tracing`/`tracing-subscriber`、`regex`（日志分流/量化提取）、`walkdir`（递归扫描）
- **不引入**：`axum`、`tokio-util`(SSE)、`tauri-plugin-http`、`auto-launch`/`winreg`（由官方插件替代）
- **前端**：React 19 + TypeScript + Vite；Zustand（轻量全局）；图表用 canvas 手绘（对齐原实现，不引图表库）；图标可用 `lucide-react` 或直接内联 SVG
- **llama.cpp（≥ 2025-12 构建）**：必须支持 Router Mode（`--models-dir`）；`llama-bench` 需支持 `-o json`；建议同时提供 `llama-fit-params`（显存预估）与 `ggml-rpc-server`（可选）
- **CUDA 运行时（Windows）**：单独下载 `cudart-llama-bin-win-cuda-<X.Y>-x64`，按 `cuda-<X.Y>` 与版本目录匹配后注入子进程 `PATH`（见 §4.6）

---

## 十一、风险与规避

| 风险 | 等级 | 规避 |
|------|------|------|
| **中文/非 ASCII 路径导致模型无法加载** | 高 | 启动前校验 + 一键 junction 修复 + UI 提示（实测复现，必须实现） |
| **共享 CUDA 目录找不到/版本不匹配 → 静默退回 CPU 推理** | 中 | 注入后回读 `--list-devices` 校验；缺失即显式报错；按 `cuda-<X.Y>` 匹配 + 允许手工指定 `shared_lib_dirs` |
| **无效设备名导致 router 无法启动** | 中 | 设备项由枚举驱动的多选（不给自由文本）；启动前用最新枚举结果过滤历史配置 |
| **多卡显存分配不符合预期** | 中 | 默认交给 `--fit`；不要预填 `-ngl`/`-ts`；提供 `fit_preview` 显存预估；异构显存用 `--fit-target 2048,512` |
| **用户既有目录层级与 `--models-dir` 不兼容** | 高 | 采用「递归扫描 + preset」主路径（`--models-dir` 仅作可选，并在 UI 标注只支持一层） |
| Router Mode 版本约束 | 中 | 探测 `--help` 的 `--models-dir`，不支持则明确报错；在版本列表里标红 |
| preset 键语义变化（llama.cpp 迭代快） | 中 | 只用实测确认的键；对应版本 `--help` 作为最终依据；配置页提供"原始 INI 编辑"兜底 |
| 模型量化/体积字段缺失 | 低 | 已加载用 `/props.model_ftype`；未加载用文件名正则 + stat；GGUF 头解析后置 |
| llama-bench 与已加载模型争显存 | 中 | 运行前提示 + "先卸载"按钮 |
| 端口冲突 / router 残留 | 低 | 启动前探测端口；退出时 kill 父进程（子实例自动跟随退出，实测 0 残留） |
| 自启动路径失效（应用被移动） | 低 | 用官方插件；启动时校验 exe 存在，不存在则更新注册表项 |
| 日志高频导致 IPC 洪泛 | 低 | 环形缓冲 + 批量推送 + 前端修剪 |
| 前端直连依赖 router 存活 | 低 | 状态条显式提示；router 崩溃时禁用列表操作并提供重启 |

---

## 十二、参考链接

- [llama.cpp 模型管理博客（Router Mode 官方说明）](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp)
- [llama.cpp tools/server README（router mode 参数与 API）](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama.app — Serving multiple models (router mode)](https://llama.app/docs/serve)
- [llama.cpp Router Mode 讨论 #18939](https://github.com/ggml-org/llama/discussions/18939)
- [llama.cpp-hub 源码（重构来源）](https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub)
- [Tauri 2 文档](https://v2.tauri.app) ｜ [tauri-plugin-autostart](https://v2.tauri.app/plugin/autostart/)

---

## 附：本机实测留痕（可复现的关键命令）

```powershell
# 能力探测（冷 1575ms / 热 152ms，需缓存）
& "<bin>\llama-server.exe" --help | Select-String "models-dir|models-preset|models-max|models-autoload"

# 启动 router（preset 方式；注意 exe 路径必须纯 ASCII）
& "<ascii-path>\llama-server.exe" --models-preset "<appdata>\presets.ini" --port 8080 --host 127.0.0.1

# 列表 / 热重载 / 加载 / 卸载 / 详情 / 事件
Invoke-RestMethod http://127.0.0.1:8080/models
Invoke-RestMethod "http://127.0.0.1:8080/models?reload=1"
Invoke-RestMethod http://127.0.0.1:8080/models/load   -Method Post -Body (@{model="<id>"}|ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:8080/models/unload -Method Post -Body (@{model="<id>"}|ConvertTo-Json)
Invoke-RestMethod "http://127.0.0.1:8080/props?model=<id>"

# GPU 与共享 CUDA 库（v2.1）
& "<bin>\llama-server.exe" --list-devices                    # 设备枚举（须先注入共享库 PATH，否则返回 (none)）
& "<bin>\llama-fit-params.exe" --model <gguf> -fitp on       # 显存预估：<设备> <模型MiB> <上下文MiB> <计算MiB>
# 注意：DLL 搜索不递归——注入的 PATH 必须【直接包含】cudart64_*/cublas64_*.dll（指向父目录无效）

# 基准（结构化输出，无需文本解析）
& "<bin>\llama-bench.exe" -m <gguf> -p 512 -n 128 -o json
```

---

## 附录 B：P6 收尾记录与实现偏差

### B.1 托盘（`src-tauri/src/tray.rs`，约 130 行）

- 图标复用**窗口图标**（`app.default_window_icon()`），因此不需要 `image-png` 之类的图片解码 feature，
  也不用再往仓库里塞一份托盘 png。
- 菜单：`显示主窗口 / 启动服务 / 停止服务 / 退出`；主菜单只在**右键**弹出
  （`show_menu_on_left_click(false)`），左键单击直接显示窗口 —— 与 hub 的 Windows 托盘行为一致。
- 悬停提示跟随 router 状态：`llama.cpp GUI — router 运行中（127.0.0.1:<port>）` / `未运行`，
  在启动成功、主动停止、崩溃监测三处更新。

**为什么不直接在托盘里调 `router_start`/`router_stop`**（与方案的唯一实质偏差）：

这两条命令需要 `State<'_, AppState>`；在托盘回调里 `tauri::async_runtime::spawn` 出来的 async 任务中，
`State` 借用 `AppHandle`，而任务又要**按值**持有 `AppHandle` —— 这构成自引用借用，Rust 直接拒绝编译
（`AppState` 的字段除非全部改成 `Arc`，否则无法在 await 之间跨越借用）。

于是托盘改为**把命令以事件发给前端**（`tray://command`，载荷 `start-router` / `stop-router`），
由前端 store 里已有的 `startRouter`/`stopRouter` 执行。窗口是 `hide` 而不是销毁，webview 始终存活，
所以托盘按钮与界面按钮走的是**完全相同的代码路径**（含 preset 自动同步、端口占用处理、
错误提示 toast、状态刷新）。代价是托盘依赖 webview 存活，对本应用（常驻 + 隐藏窗口）不构成限制。

### B.2 关闭隐藏与开机自启

- 关闭窗口：`on_window_event` 里 `CloseRequested` → `api.prevent_close()` + `window.hide()`，
  受 `settings.minimize_to_tray`（默认 `true`）控制；托盘菜单的「退出」才是真正退出
  （先 `stop_router` 再 `app.exit(0)`，`RunEvent::Exit` 还有一道兜底清理）。
- 自启动：官方 `tauri-plugin-autostart` → `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`。
  - 启用时带参数 `--minimized`；应用在 `setup` 与 `RunEvent::Ready` 两处各隐藏一次主窗口
    （WebView2 挂载过程会重置窗口可见性，只做一次会被它翻回来）。
  - 设置页每次「开启」都用**当前 exe 路径**重写注册表项，因此移动安装目录后旧项会被自动修正；
    设置文件里的 `autostart` 与注册表不一致时，以注册表为准并在启动时反向同步。
  - 前端不引入 `@tauri-apps/plugin-autostart` npm 包：改用后端命令
    `autostart_get` / `autostart_set` 包一层，少一个前端依赖。

> **验证边界（重要）**：本项目的开发环境是 dsh 沙箱，而沙箱禁止命名管道 —— WebView2 的
> 渲染进程恰恰依赖命名管道，因此在沙箱内启动应用时窗口不会正常显示（表现为「闪一下就消失」）。
> 托盘、关闭隐藏、自启动这些**与窗口可见性有关**的行为，需要在沙箱外（资源管理器里双击 exe）
> 验证；沙箱内可靠的部分是编译、单元测试、以及 router 的 HTTP 行为。

### B.3 打包

`tauri.conf.json`：

| 配置 | 值 | 原因 |
|------|----|------|
| `mainBinaryName` | `llamacpp-gui` | `productName` 带空格与点号，exe 名保持 ASCII 无空格更省事 |
| `bundle.targets` | `["nsis"]` | 当前用户安装、免管理员 |
| `bundle.windows.nsis.installMode` | `currentUser` | 同上（写 `%LOCALAPPDATA%`，不触发 UAC） |
| `bundle.windows.nsis.languages` | `SimpChinese` + `English` | 安装界面中英双语 |

首次打包需要 NSIS 工具链（Tauri 自动下载到 `%LOCALAPPDATA%\tauri\NSIS`）。
本机直连 GitHub 不通，用本机代理即可（见 README「构建与运行」）。

### B.4 首次实机运行暴露的问题（已修）

| 现象 | 原因 | 修复 |
|------|------|------|
| 启动时弹出一个命令行窗口，随即消失 | 主程序是 GUI 子系统（`windows_subsystem = "windows"`）**并不能**让它的子进程不弹控制台：GUI 进程 spawn **控制台程序**时照样新开一个控制台窗口。启动时的版本能力探测（`llama-server --help`）与设备枚举（`--list-devices`）走了没有 `CREATE_NO_WINDOW` 的分支 | 新增 `winfix::hide_console(&mut Command)` 统一封装该标志，并给**所有** spawn 点接上：`versions::probe_router_mode`、`gpu::list_devices`、`gpu::fit_preview`、`router`（spawn / taskkill）、`bench`（llama-bench / reg）、`winfix`（mklink / rmdir）、`open_local_url`。删掉了各模块里重复的 `CREATE_NO_WINDOW` 常量 |
| 多次双击 exe 会起多份程序，托盘出现多个图标 | 没有做单实例约束；每份进程各有托盘图标与 router | 加官方 `tauri-plugin-single-instance`，并**注册为第一个插件**（必须在窗口/托盘创建之前拦下第二次启动）。第二个进程会把已有实例的窗口叫到前台后自行退出 |
| 启动后要等一会儿模型列表才出来 | ① `store.init` 把 `await refreshDevices()`（起一个 `llama-server --list-devices`，1~3 秒）排在模型扫描**之前**，模型列表白等这几秒；② 扫描结果只在内存里缓存（5 秒 TTL），进程一重启就没了，每次启动都要重新遍历目录 + stat 每个文件 | ① 模型扫描提到最前，版本扫描/设备枚举改为不阻塞 init；② 扫描结果落盘 (`models-scan-cache.json`)，启动直接读缓存渲染，后端随后自动重扫，**结果有变化才**发 `models://scanned` 让前端更新（stale-while-revalidate）；启动路径用 silent 刷新，不把界面切进忙碌态 |

> 「先显示、后更新」而不是「启动不扫」：缓存只是用来**先把列表画出来**，
> 真正的扫描照样每次都跑，只是挪到后台，用户看不到等待。

### B.5 交互细节（按实机使用反馈调整）

| 反馈 | 处理 |
|------|------|
| router 启停按钮要放到导航栏下方、用图标 | 移到侧栏底部，并与状态文字合成**一颗胶囊**（状态点 + 「router 运行中 · :8080」 + 启停图标），配色沿用 hub 的 `.status-running` / `.status-stopped`；点击即启停 |
| 打开程序就自动启动 router | 新增设置 `auto_start_router`（默认 **true**），`store.init` 末尾在「已设 llama.cpp 目录 且 router 未运行」时自动 `startRouter()`；开关放在「设置 → 启动与托盘」 |
| 顶栏按钮太多，组合一下 | 顶栏只留：搜索、刷新、排序、筛选、视图切换。原先三个「只看 X」图标按钮合并成一个**筛选下拉**（全部 / 运行中 / 收藏 / 未同步 preset）；「运行中优先」并入**排序下拉**（它是排序，不是叠加在排序之上的开关）；`同步到 presets.ini` + `编辑 preset 文件` 合并成一个 **preset 下拉** |
| 取消「导入 hub 预设」按钮 | 按钮从顶栏移除（后端命令 `preset_import_hub` 与 `store.importHubPresets` 保留，需要时可再挂入口） |
| 「开始聊天」移到性能测试下面 | 侧栏顺序改为：模型列表 / 性能测试 / 开始聊天 / 运行环境 / 系统日志 / 设置 |
| 设置页 llama.cpp 目录的「浏览 / 保存」变形 | 原因是 `.row` 是 flex 容器、按钮默认 `flex-shrink: 1` 被压扁。在 `app.css` 加 `.form-group .row > .btn { flex: 0 0 auto; white-space: nowrap; }`，并给这几个按钮加同样的内联样式 |
| 设置页删除 GPU / 多卡分组 | 整块删除。多卡默认就是「什么都不设」（交给原生 `--fit`），需要 per-model 覆盖时去模型配置面板；`settings.gpu` 字段保留，`RuntimePanel` 仍展示设备 |
| 取消「保存并扫描模型」，保存即扫描 | 模型根目录只留「添加目录 + 保存」，保存后自动 `refreshModels(true)`；llama.cpp 目录的「保存」也顺带重扫版本与设备 |
| 配置弹窗：记住参数分组的折叠状态；取消「估算显存」按钮；「删除段」→「删除配置」；按钮统一宽度 | 折叠状态写 localStorage（模型参数与 llama-bench 参数各一份键），动过就记；「估算显存」按钮与其 `fitPreview` 调用一并删除（后端命令保留）；配置弹窗底部按钮统一 124px（`.modal-footer .btn-uniform`），设置页那组仍是 104px |
| 配置弹窗：还要记住滚动条位置 | 左栏 / 右栏是两个独立滚动容器，各记一份，按模型段名区分（`configScroll:<段名>:basic|detail`）；滚动防抖 200ms 写盘，打开时在下一帧恢复（等折叠状态与参数行渲染完，`scrollHeight` 才对） |
| 窗口大小要记忆 | `settings.json` 新增 `window: { width, height }`（物理像素）。`Resized` 只更新内存（拖动会连发上百个事件），关窗与退出时各落盘一次；启动时按记录尺寸开窗，小于 480×360 的异常值不记 |
| **取消「删除配置」按钮**：模型还在时不会删段；模型删了应该在扫描时自动同步 | 按钮删除（`removeModelSection` 仍被「改名后删旧段」使用，后端命令保留）。扫描时自动清理失效段：判据是段里的 `model` 指向的 gguf 已不存在；没有 `model` 键的段一律不碰；所有段都失效（≥3）时判定为模型盘未就绪，跳过清理只提示 |
| **删掉的段要能找回来**：用户删了模型、过阵子又下载回来，配置不该丢 | 清理前先把段内容**归档**到 `removed-preset-sections.json`；扫描时若发现「归档里有同名段、preset 里没有该段」的新模型，就把配置接回来（`model` 用新路径覆盖，其余键原样），恢复后从归档移除。匹配用段名（改过名的模型走别名） |

### B.6 代码审查后的修复（一次全量 review 的产物）

对前端与后端做了一轮完整审查（五路并行：router/版本/GPU、`models.rs`、命令层与系统集成、压测+前端状态层、前端组件与样式），
下面按块列出**已修**的部分。审查里有三条是两份报告独立命中的（router 端口顺延、能力探测固化、归档链路），可信度最高。

**router 启动三连（最影响日常使用）**

| 问题 | 修复 |
|------|------|
| 「端口占用自动顺延」从未生效：顺延只改了状态与就绪探测，`--port` 仍写 `settings.port` | `build_router_args` 增加 `port` 形参，`--port`/就绪探测/`RouterStatus.port` 三者同源；加单测 `forwarded_port_wins_over_settings_port` |
| 就绪等待的 20 秒里不读管道：Windows 管道缓冲约 4KB，启动输出一多子进程就阻塞在 write 上、永远不监听 | spawn 成功后**立即** take stdout/stderr 并起读取线程，再进就绪轮询 |
| 超时/出错 bail 前不杀子进程 → 孤儿 llama-server 占端口显存，且界面停不掉 | 新增 `force_kill_tree`（kill + `taskkill /T /F`），所有失败分支与 `stop_router` 共用；`spawn_monitor` 同时加上 pid 校验（重启后旧监测线程自动退出） |
| API Key 明文进日志 | 新增 `redact_args`，日志里 `--api-key ***` |
| 子实例日志前缀是 `[%5d]`，4 位端口带前导空格导致分流失败 | `classify_log_source` 先 `trim()` |

**preset 与归档的数据安全**

| 问题 | 修复 |
|------|------|
| `write_preset` 就地截断写（全模块唯一非原子写） | tmp + `.bak` + rename 原子替换 |
| 归档文件损坏被当成"空归档"，下一次写入直接覆盖掉全部历史 | `read_archive` 区分「不存在」与「读不出来」，后者报错并**放弃写盘** |
| 归档写失败被吞，段却已经删了 → 用户以为"清理成功" | `archive_sections` 返回 `Result`，失败则**放弃本次清理** |
| `take_archived` 先删归档、后写 preset，写盘失败即永久丢失 | 拆成 `peek_archived` + `consume_archived_section`，**写盘成功后**才消费 |
| 归档 key 只有扫描 id，同目录换模型文件会误恢复 | 归档记 `model_file`，文件名对不上就不恢复（旧参数可能含 `spec-draft-model` 这类指向具体文件的键） |
| 恢复的内容不过 `sanitize_preset_keys`，老伪键会复活 | 写盘前统一 sanitize |
| preset/归档的读-改-写无锁（并发命令丢更新） | 新增 `models::preset_lock()`，五个写命令与 `models_scan` 都持锁 |
| `filter_entry` 对根目录也生效（根名叫 `.x` 或 `node_modules` 时扫出 0 个模型） | 深度 0 直接放行 |
| 多根目录 id 冲突时静默丢模型 | 保留先扫到的，但 `eprintln!` 说明数量 |
| "全部失效即跳过"的门限让单模型用户永远清不掉孤儿段 | 改成：**任一模型根目录不存在**→跳过；或全失效且 ≥3 →跳过；否则照常清理 |

**设置与探测**

- `settings_set` 的 `null` 语义：前端改发**空串**，后端把空串映射成 `None` —— 之前清空 API Key / 目录会被当成"此字段不改"，静默保留旧值，界面还提示"已保存"。
- `SettingsStore::persist` 挪进锁内，临时文件名带 pid + 序号：之前落盘在锁外、共用同一个 `settings.json.tmp`，并发时会丢更新甚至互相截断。
- 能力探测三态化：`probe_router_mode` 返回 `Option<bool>`，**探测失败不落缓存**；缓存加 7 天 TTL（`probed_at_ms` 终于被读了）—— 之前一次失败（缺 DLL、被杀软拦）会永久固化成"该版本不支持 router mode"，把用户引向"请升级 llama.cpp"。
- 版本排序改成按名字里的数字段比较（`b9999` 不再排在 `b10831` 前面）；`join_paths` 失败时回退原 PATH，而不是把子进程 PATH 置空。

**系统集成**

- `open_local_url` 改用 `tauri-plugin-opener`：`cmd /c start "" <url>` 只校验前缀，URL 里的 `& | ^ %` 会被 cmd 当元字符（URL 可能带模型 id）。
- `winfix`：`mklink`/`rmdir` 改走 `raw_arg` 自拼命令（路径里的 `&`/`%` 不再被拆解）；删除旧链接改成**无条件尝试**（`rmdir` 命令对悬空 junction 无效，`fs::remove_dir` 才行）—— 目标被删/改名后 junction 悬空会让 `router` 再也起不来，这条加了专门的回归测试。
- `RunEvent::Exit` 补上 `bench::kill_running`：托盘退出后不再留 llama-bench 子进程。

**前端**

- API 压测的「取消」按钮是假的（点了 `runServer` 直接 return）：改成运行中禁用 + 文案「压测中…」，不再给兑现不了的语义。
- 配置弹窗「保存并加载」在改过别名后用**已被删除的旧段名**启动：`save()` 返回新段名，调用方用它启动。
- 移动端布局三条：`#root` 补 `flex-direction: column`；`#loadModelModal .load-model-layout` 的两列规则关进 `min-width: 901px`（否则同特异性且更晚，会把 hub 的窄屏单列按回去）；`.top-bar` 固定高度同样只对桌面生效（窄屏下它会把下拉菜单裁掉）。
- 表单草稿被静默重置：配置弹窗改成只在**切换模型**时初始化（用 ref 读最新 preset 文本），设置页只在首次拿到 settings 时灌值。
- `ErrorBoundary` 的 fallback 用了两个不存在的类名（`banner error` / `hint`），换成已有的 `.notice error` / `.form-text`。
- llama-bench「主 GPU」传的是候选列表位置而非设备索引，会指到被排除的卡。
- 深色主题补 `.btn-icon.soft` 与 `.model-status-badge` 的状态色（同文件 `.router-pill` 早已这么做过）。

**明确未做（附原因）**

- bench 面板切页丢会话：要把 `runId`、输出缓冲与事件订阅提到 store 并做生命周期管理，改动面较大且容易引入新 bug，收益是"切页不丢进度"，评估后留待后续。
- 模型列表的 `presetText` 重复解析（每卡两遍全文扫描）：17 个模型时开销可忽略，几百个模型才明显，且真正的解法是列表虚拟化，属另一个改动。

### B.7 其它实现偏差（全量）
| 方案 | 实际实现 | 原因 |
|------|---------|------|
| 独立的 `stress.rs` | 并入 `bench.rs` | 压测与 llama-bench 共用结果落盘、进度事件与记录表，拆开只会重复一遍 |
| 独立的 `logbuf.rs` | `router.rs` 内的 `LogHub` | 日志采集与 router 的 stdout 生命周期强绑定，随进程一起创建/销毁最自然 |
| 7 项核心参数表单 | 由 `scripts/build-param-schema.mjs` 从 hub 的 `classes/server-params.json` 抽取**完整参数表**（81 项，含分组、取值域、帮助文本） | 迁移 hub 配置需要完整键名对照；顺带得到与 hub 一致的参数界面 |
| `--spec-type` 单值下拉 | 草稿类型单选 + ngram 附加项可叠加（`mergeInto: "spec-type"`） | llama.cpp 的 `--spec-type` 是**逗号多值**：`ngram-mod` 类附加项与草稿类型可以共存，而 hub 把它写成了伪参数 `--spec-type_ngram-mod` |
| 未做：`[*]` 全局段专用编辑器 | 由「preset 文件」整文编辑覆盖 | 全局段就是 INI 的一部分，单独做一套控件没有增量价值 |
| 未做：命令行预览 | 配置面板的「额外参数」+「preset 文件」整文编辑覆盖手写参数；参数表的键名就是 preset 键名 | 前端本地拼出的"预览"与 router 实际装配结果必然有偏差（真值是子实例的 `status.args`，由 router 渲染），显示它只会误导 |
| 前端组件文件里混着工具函数 | 拆到 `utils/paramSchema.ts`、`utils/presetText.ts`、`utils/frontendLog.ts`，弹窗外壳提取为 `components/Sheet.tsx` | React Fast Refresh 要求模块要么只导出组件、要么不导出组件，混在一起会让热更新退化成整页刷新 |
