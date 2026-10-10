# llama.cpp GUI — Tauri 2 重构方案（最终版）

> 基于 [llama.cpp-hub](https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub) 重构为 Tauri 2 桌面应用
> 核心思路：**把重逻辑交给 llama.cpp 原生 Router Mode，Tauri 只做"版本发现 + 进程管理 + 网关 + 日志 + 基准测试"**
>
> 本文档是可直接用于实现的详细设计：涵盖架构、三页 UI 的组件/字段/交互（照搬原项目）、
> 后端模块、API 契约、数据模型、开发计划与风险。

---

## 文档信息

| 项 | 内容 |
|----|------|
| 来源项目 | llama.cpp-hub（Java 21 + Netty + 原生 JS/PWA） |
| 目标 | Tauri 2 桌面应用（Rust 后端 + React/TS 前端） |
| 状态 | 方案已定稿，待进入 P1 脚手架实现 |
| 参考实现 | 原项目 `newui/*.js`（models.js / model-config.js / model-detail.js / logs.js / benchmark.js）、`win/AutoStartManager.java`（自启）、`win/WindowsTray.java`（托盘），留存在 `tmp/ref/` 供实现对照 |

---

## 一、背景与目标

### 1.1 源码现状（已核实）

| 层级 | 技术 |
|------|------|
| 后端 | Java 21 + Netty 4.1 + Maven（`pom.xml` + `lib/*.jar` system 依赖） |
| 前端 | `src/main/resources/web/` 原生 JS/CSS/HTML + PWA（无框架，`newui/app.js`） |
| 进程模型 | `LlamaCppProcess`/`LlamaServerManager`：**每个模型独立进程** |
| 启动器 | `launcher/launcher.c`（JNI 启动包装） |

源码功能面：模型管理、EasyChat、多协议 API(OpenAI/Anthropic/Ollama/LM Studio)、
Web 管理面板、远程节点、MCP、下载管理器、在线更新。

### 1.2 三项关键决策（已确认）

| 决策 | 结论 | 含义 |
|------|------|------|
| 进程/自动加载架构 | **只走 llama.cpp Router Mode** | 不写进程池/LRU/自动加载，全是原生；约束：必须 ≥ 2025-12 的 `llama-server` |
| 聊天范围 | **只暴露 API，不建聊天 UI** | 前端只做 3 个页面；聊天由外部客户端(dsh 等)调 `/v1/chat/completions` |
| llama.cpp 二进制来源 | **用户自带，启动时扫描指定目录** | 不捆绑大文件；自动发现版本并选择；`llama-bench` 从同版本目录取 |

### 1.3 功能取舍清单

| ✅ 保留 | ❌ 移除 |
|---------|---------|
| 模型管理（加载/卸载/GGUF 发现、per-model presets） | 便宜聊天(EasyChat) UI |
| 日志（实时查看） | 多协议 API（只保留 OpenAI 兼容） |
| 性能测试（llama-bench + API 压测） | 远程节点聚合 |
| 自动加载（交 llama.cpp 原生 autoload） | 下载管理器 |
| 多版本 llama.cpp 支持（用户自带 + 版本发现） | 在线更新 |
| 手动加载/卸载按钮（管理页内） | MCP 服务器 |
| dsh 兼容 API（`/v1/*` 网关代理） | 模型克隆 |
| 模型收藏（列表页） | 音视频输入、背景/头像、用量统计等花哨项 |
| 自启动 + 常驻后台（托盘） | 实时速度(t/s)显示 |

---

## 二、技术架构

### 2.1 整体架构（Tauri 统一网关）

```
┌──────────────────────────────────────────────────────────────┐
│                    Tauri 2 桌面应用 (React + Rust)             │
│  ┌─────────────────────── Rust 后端                         │
│  │  ┌───────────────────────────────────────────────────│    │
│  │  │  shared services（进程管理 / 版本发现 / bench / 压测 / 日志）│ │
│  │  └───────────────────────────────────────────────────│    │
│  │        │                              │                │
│  │   Tauri 命令(tauri.invoke)    axum HTTP 网关(对外端口) │    │
│  │        │                              │                │
│  └────────┼───────────────┬──────────────────────────────┘    │
│           │               │                                   │
│   前端 React(webview)     │   外部客户端(dsh / OpenAI SDK)     │
│   • 模型列表页            │   • /v1/models                   │
│   • 日志页                │   • /v1/chat/completions         │
│   • 性能测试页            │   • /api/* 管理接口              │
└───────────┼───────────────┼───────────────────────────────────┘
            │               │
            ▼               ▼
     ┌──────────────┐  ┌────────────────────────────────────┐
     │ llama-server │  │  Router Mode 进程（llama.cpp 原生）   │
     │  router 进程 │  │                                    │
     │              │  │  • 自动发现 --models-dir 里的 GGUF   │
     │  stdout/    │  │  • 按需加载 / LRU 淘汰 / autoload     │
     │  stderr     │  │  • per-model presets(INI)             │
     │  (被 Rust   │  │  • 按 model 字段路由请求              │
     │   采集)     │  │                                     │
     └──────────────┘  └────────────────────────────────────┘
            │
            ▼
     ┌──────────────┐
     │ 模型目录      │  models/<模型名>/<模型>.gguf
     │ (用户指定)   │  每个模型一个文件夹
     └──────────────┘
```

### 2.2 对外 API 入口（方案 A：Tauri 统一网关）

Tauri 后端启动一个 axum HTTP 服务（端口可配置，默认 8080），统一对外暴露：

- **`/v1/*`**：代理到内部 `llama-server` router（`/v1/models`、`/v1/chat/completions`、
  `/v1/completions`、`/v1/embeddings`），**流式 SSE 原样透传**。服务外部客户端(dsh / OpenAI SDK)。
- **`/api/*`**：管理接口，供前端调用（模型列表、日志、基准测试、版本、设置）。

前端(webview)走 **Tauri 命令**(`invoke`)，不直接打 axum；axum 主要服务外部客户端。
两者共同调用同一套 `shared services`，避免逻辑重复。

> 备选方案 B（未采用）：`llama-server` router 自己直接对外监听 `/v1/*`，dsh 直连；
> Tauri 只管 `/api/*` 和进程生命周期。入口有两个、Tauri 不掌控外部 API 面。

### 2.3 核心设计理念：利用 llama.cpp Router Mode

llama.cpp 于 2025-12 引入的**多模型管理功能**（官方博客 [ggml-org/model-management-in-llamacpp](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp)）：

- 一个 `llama-server` 进程作为路由器，自动发现和管理多个模型
- 每个模型运行在独立子进程中，崩溃不影响其他模型
- 按需加载、LRU 淘汰(`--models-max`)、per-model 预设(`--models-preset`)、autoload
- 原生实现，开箱即用；**Tauri 不重复实现这些逻辑**，只负责进程生命周期与网关

### 2.4 常驻后台与开机自启动

> 对应原项目 `win/WindowsTray.java`（托盘）与 `win/AutoStartManager.java`（自启），
> 但修复原项目自启不可靠的问题（见 §2.4.2）。

#### 2.4.1 常驻后台（Tauri 2 原生托盘）

> 常驻后台本就是 Tauri 2 原生能力，**无需照搬原 `WindowsTray.java`（Java AWT 托盘）**，
> 仅调用 Tauri 原生 API + 托盘菜单，行为对齐其语义即可。

- **托盘图标**：`tauri.conf.json` 配 `tray_icon_enabled: true`（或 `TrayIconBuilder`）
- **关闭不退出**：`onWindowEvent` 处理 `CloseRequested` → `window.hide()` + `event.prevent_close()`，
  点 × 隐藏到托盘而非退出
- **进程常驻**：托盘图标存在 + 阻止关闭 → 进程不退出，router 随应用常驻；窗口可随时隐藏/显示
- **托盘菜单**：`TrayIconBuilder` 菜单项 = **打开管理窗口**（默认动作 / 双击）、**退出**
- 原 `WindowsTray` 是 Java AWT 托盘，我们不复用其实现，仅对齐菜单语义（打开窗口 / 退出）

#### 2.4.2 开机自启动（可靠实现）

- **机制**：写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（用户级，无需管理员）
- **实现**：`auto-launch` crate（Windows 即写此键）或 `winreg` 手动写
- **注册路径**：当前 exe 的 canonicalize 绝对路径
- **开关**：设置项 `autostart: bool`，开启 → 写键；关闭 → 删键
- **自启动时一并自动启动 router**（见 §1.2 决策），开机后后台 API 立即可用
- **对比原项目（修复点）**：
  - 原 `AutoStartManager` 用 PowerShell `WScript.Shell` 在 Startup 目录建 `.lnk`，
    依赖 `APPDATA` 环境变量 / COM 对象 / PowerShell 执行策略，路径易算错、易被拦截、
    exe 路径一变即失效 → **实际无效**
  - 本项目用注册表 `Run` 键，资源管理器每次登录必读，失败点少、真正生效

---

## 三、前端详细设计

> 前端：React + TypeScript + Vite，三页布局（Sidebar + 内容区）。
> 三页 UI 均**照搬**原项目对应 `newui/*.js` 的结构与交互，仅剔除已移除功能。

### 3.1 总体目录结构

```
src/
├── main.tsx
├── App.tsx                       # 三页布局(Sidebar + 内容区)
├── index.css
├── components/
│   ├── Layout/                   # Sidebar / Header（版本选择、router 状态指示）
│   ├── ModelList/                # 模型列表页主体（照搬原 models.js）
│   │   ├── SearchBar.tsx         # 搜索 + 筛选chip + 排序 + 卡片/列表切换 + 密度档
│   │   ├── ModelCard.tsx         # 卡片（随密度缩放）
│   │   └── ModelList.tsx         # 分组渲染 + 空态/骨架 + 视图/密度切换
│   ├── ModelConfig/              # 独立配置面板（照搬原 ModelConfig.open，滑出 sheet）
│   │   ├── ConfigSheet.tsx       # 版本/GPU/参数/preset/VRAM/启动·保存
│   │   └── ParamFields.tsx       # 动态参数表单（映射 llama.cpp 原生参数）
│   ├── ModelDetail/              # 模型详情面板（轻量）
│   ├── Logs/                     # 日志页（照搬原 logs.js）
│   │   ├── LogSources.tsx
│   │   ├── LogView.tsx
│   │   └── LogStatus.tsx
│   └── Benchmark/                # 性能测试页（照搬原 benchmark.js，双模式 Tab）
│       ├── BenchModelList.tsx
│       ├── LlamaBenchPane.tsx
│       └── ApiStressPane.tsx
├── pages/
│   ├── ModelManager.tsx          # 模型管理（主力页 = 模型列表页）
│   ├── Logs.tsx                  # 日志
│   └── Benchmark.tsx             # 性能测试
├── hooks/
│   ├── useVersions.ts
│   ├── useModels.ts
│   ├── useLogs.ts
│   └── useBenchmark.ts
├── stores/
│   └── app.ts                    # 轻量全局状态(Zustand，可选)
├── types/
│   └── index.ts
└── utils/
    └── api.ts                    # Tauri invoke 封装 + /api/* 客户端
```

---

### 3.2 模型列表页（照搬原 `newui/models.js`）

一屏显示尽可能多的模型。四控件 + 双切换（视图/密度），`localStorage` 各自记忆。

#### 3.2.1 顶栏控件（`SearchBar.tsx`）

| 控件 | 原实现 | 本方案 |
|------|--------|--------|
| 搜索框 | `#modelSearch`（input → 按名称/ID 过滤） | 保留 |
| 筛选 chip | `#modelChips[data-filter]`：全部/已加载/收藏 | 保留全部/已加载/收藏 |
| 排序 chip | `#modelChips[data-sort]`：名称/大小（升/降） | 保留 |
| 卡片/列表切换 | `#modelViewToggle`（card ↔ list） | 保留 |
| **密度档**（新增） | — | 宽松 ↔ 紧凑，**默认紧凑** |

视图与密度持久化：`localStorage['modelListView']`（list/card）、
`localStorage['modelListDensity']`（compact/loose）。

#### 3.2.2 模型卡片（`ModelCard.tsx`）

照搬原 `.model-card` 结构，剔除克隆/速度，保留收藏：

```
.model-card
├─ .mc-head
│   ├─ 收藏按钮（★，toggle favourite）
│   ├─ 模型图标（20px，按架构取图标）
│   ├─ 名称（单行，过长截断 + tooltip）
│   ├─ 状态条（状态圆点/文字：已停止 / 已加载·端口 / 处理中）
│   └─ 节点标签（单节点隐藏）
├─ .mc-meta
│   ├─ 架构（如 llama/qwen2）
│   ├─ 量化（如 Q8_0）
│   └─ 体积（如 4.7 GB）
└─ .mc-foot
    ├─ 主按钮：启动(play) / 配置(sliders) / 停止(stop)
    ├─ 详情按钮（circle-info）→ 打开 ModelDetail
    └─ （快速启动 bolt / 克隆 clone：按需求保留或移除）
```

**密度影响**：紧凑档缩小卡片高度、内边距、图标尺寸、网格间距；宽松档恢复较大尺寸。

#### 3.2.3 列表渲染（`ModelList.tsx`）

- 数据源：`/api/models/list`（列表）+ `/api/models/loaded`（加载状态）
- 分组：单节点版不再按节点分组（原 `nodeHeader` 隐藏）
- 空态/骨架：无模型时显示空态；首次加载显示骨架屏
- 排序：已加载在前；按名称或大小升降序
- 局部状态更新：加载/停止事件后局部 `patch` 重渲染，不重拉全量

#### 3.2.4 交互流程

```
加载页面 → GET /api/models/list + /api/models/loaded → 渲染卡片
点击启动 → POST /api/models/{id}/load → WS/事件更新状态 → 重渲染
点击配置 → 打开 ConfigSheet（§3.3）
点击详情 → 打开 ModelDetail（§3.4）
点击收藏 → POST /api/models/favourite → toggle
切换视图/密度 → 写入 localStorage → 立即重渲染
```

---

### 3.3 配置面板（照搬原 `newui/model-config.js`，滑出 sheet）

从卡片"配置"按钮触发（原 `ModelConfig.open`），滑出面板 `#configSheet`。

#### 3.3.1 面板结构

```
#configSheet（滑出面板）
├─ #configTabs（Tab：基础 / 高级-命令行模式）
├─ 基础栏
│   ├─ 配置方案选择 #cfgSelect + 新增 #cfgAddBtn / 删除 #cfgDelBtn
│   ├─ 模型ID #cfgModelName（只读）
│   ├─ 别名 #cfgAlias + 保存 #aliasSaveBtn
│   ├─ llama.cpp 版本选择 #cfgLlama（→ 加载设备）
│   ├─ 主GPU #cfgMainGpu
│   ├─ #paramForm（动态参数表单，§3.3.2）
│   ├─ 额外参数 #cfgExtra
│   └─ VRAM 估算 #cfgVramBtn → #cfgVramResult
├─ 高级栏（命令行模式 #cmdField / #cfgCmd）
├─ 能力开关 #capGrid（视觉/音频等，可选）
└─ 底部按钮：保存配置 #cfgSaveBtn / 启动模型 #cfgStartBtn
```

#### 3.3.2 动态参数表单（`ParamFields.tsx`）

参数定义来自 `/api/models/param/server/list`，映射到 llama.cpp 原生参数：

| 表单字段 | 映射的 llama.cpp 参数 |
|----------|----------------------|
| GPU 层数 | `n-gpu-layers`（-1 = 全 CPU，正数 = GPU 层数） |
| 上下文 | `ctx-size` |
| 温度 | `temp` |
| top-p | `top-p` |
| top-k | `top-k` |
| min-p | `min-p` |
| 重复惩罚 | `repeat-penalty` |
| （命令行模式） | 用户直接编辑完整命令行 |

参数改动实时生成预览命令行（`#paramHint`）。

#### 3.3.3 配置方案（presets）

- 方案读写走 `/api/presets`（读写 `presets.ini`）
- 方案 = 一套参数集合，可新增/选择/删除
- 启动时选择当前方案；保存将当前参数写入所选方案

---

### 3.4 模型详情面板（轻量，原 `newui/model-detail.js`）

点开卡片"详情"触发，仅展示只读信息：

- 架构、量化、体积、加载状态
- 关联 preset 方案
- （可选）GGUF 头信息（量化/参数），如需更细需额外 GGUF 解析（后置）

---

### 3.5 日志页（照搬原 `newui/logs.js`）

#### 3.5.1 面板结构

```
日志页
├─ #logSources（日志源列表：全部日志 / 系统 / 各模型，已加载在前）
├─ #logSrcSelect（移动端下拉，与 #logSources 同步）
├─ #logPre（<pre> 实时流显示区，自动滚底）
└─ #logStatus（状态栏：过滤源 · 匹配行数 · 快照大小 · 更新时间）
```

#### 3.5.2 数据与交互

- **日志源过滤**：全部日志 / 系统 / 各模型（已加载模型在前，离线模型标"未加载"）
- **控制台快照**：`/api/sys/console`（纯文本），进入页面/切换源时取
- **模型历史日志**：`/api/sys/model-log?modelId=`（首次选某模型时取）
- **实时日志流**：`log::collector` 经 Tauri 事件 / `/api/logs` SSE 推送
- **自动滚底**：滚动在底部时跟随；往上翻则不自动滚
- **缓冲上限**：本地行缓冲上限（原 10000），超出修剪
- **单节点**：去掉节点分组（原 `#logNodes`）

#### 3.5.3 过滤逻辑

```
matchFilter(modelId):
  filter 为空 → 显示全部
  filter = 'system' → 仅系统行
  filter = modelId → 仅该模型行
实时行按 matchFilter 过滤后追加到快照，渲染 <pre>
```

---

### 3.6 性能测试页（照搬原 `newui/benchmark.js`，双模式 Tab）

#### 3.6.1 面板结构

```
性能测试页
├─ #benchModelList（模型选择列表：搜索；单节点去掉节点过滤）
├─ #benchModeChips（Tab：llama-bench / API 压测）
├─ llama-bench 面板
│   ├─ #benchLlamaBin（二进制选择，同版本目录）
│   ├─ #benchParamsBtn（参数）+ #bpResetBtn（重置）
│   ├─ #benchRunBtn（运行）
│   ├─ #benchCopyBtn（复制输出）+ #benchExportBtn（导出）
│   └─ 图表（tok/s 等结果可视化）
└─ API 压测面板
    ├─ #svPromptTokens（提示词长度）
    ├─ #svMaxTokens（输出长度）
    ├─ #svConcurrency（并发数）
    ├─ #svRunBtn（运行/取消）
    ├─ 导出：CSV #svExpCsv / JSON #svExpJson / MD #svExpMd
    └─ #svStatus（状态/吞吐）
```

#### 3.6.2 llama-bench 模式

- 选择模型 → 加载同版本 `llama-bench` 路径 → 设参数 → 运行
- 后端 `services/bench.rs` 构造参数、启动进程、采集输出、解析结果（tok/s、耗时、显存）
- 结果：复制 / 导出 / 图表

#### 3.6.3 API 压测模式

- 选择**已加载**模型（未加载禁用运行）
- 输入 promptTokens / maxTokens / 并发数
- 后端并发生成请求，打 router 的 `/v1/chat/completions`，统计吞吐（prompt/predict t/s）
- 结果：导出 CSV/JSON/MD；保留记录（本次可仅内存，不落盘）

> 这是唯一超出"纯 llama-bench"的后端工作量（并发请求生成器 + 吞吐统计），列为 P6b。

---

## 四、后端详细设计（Rust / Tauri 2）

### 4.1 目录结构

```
src-tauri/
├── Cargo.toml
├── src/
│   ├── main.rs                     # Tauri 应用入口(托盘/窗口可选)
│   ├── lib.rs                      # 命令 + 事件 + axum 注册
│   ├── app/
│   │   ├── state.rs                # 全局状态：选定版本、router 进程句柄、端口
│   │   └── version.rs              # 扫描用户目录、发现版本、检测 router mode 支持
│   ├── tray/
│   │   └── mod.rs                  # 托盘图标 + 菜单（打开窗口/退出）+ 窗口隐藏/显示
│   ├── autostart/
│   │   └── mod.rs                  # 注册表 HKCU Run 键读写（auto-launch/winreg）+ 开关
│   ├── router/
│   │   └── manager.rs              # llama-server router 进程生命周期（启动/停止/重启/状态/端口）
│   ├── services/
│   │   ├── mod.rs                  # 共享服务层(Tauri 命令与 axum 共用)
│   │   ├── models.rs               # 模型列表/状态(代理 router /models) + 手动加载/卸载
│   │   ├── bench.rs                # llama-bench 调用 + 结果解析
│   │   ├── stress.rs               # API 压测：并发请求生成 + 吞吐统计
│   │   └── settings.rs             # 配置读写(用户目录/端口/preset 路径)
│   ├── log/
│   │   └── collector.rs            # 采集 router stdout/stderr → Tauri event + SSE
│   └── api/
│       ├── openai.rs               # /v1/* 代理到 router(含 SSE 透传)
│       └── control.rs              # /api/* 管理接口(给前端)
└── capabilities / tauri.conf.json  # Tauri 2 权限配置
```

### 4.2 职责边界

- `router::manager`：只把 `llama-server` 当成黑盒进程启动/监控，不解析模型逻辑
- `services/*`：业务逻辑中枢，Tauri 命令和 axum handlers 都委托给它
- `api/*`：传输层，只做协议适配与代理
- `log::collector`：进程 stdout/stderr 流 → 前端实时日志

### 4.3 llama.cpp 集成

#### 4.3.1 Router Mode 启动

```bash
# 不指定 -m（进入 router 模式），指向用户模型目录
llama-server \
  --models-dir ./models \
  --models-max 4 \
  --models-preset ./config/presets.ini \
  --port 8080 --host 127.0.0.1
```

- 启动时**不传 `-m`**；靠 `--models-dir` 自动发现 GGUF，或依赖 cache 自动发现
- 通过 `--help` 输出检测 `--models-dir` 是否存在，判断所选版本是否支持 Router Mode
- 不支持则报错退出（不写回退路径，符合"只走 Router Mode"决策）

#### 4.3.2 多版本支持（用户自带）

```
llama-cpp-<版本>/          # 用户指定的安装目录
├── v2025.12/
│   ├── llama-server        ← 支持 router mode ✅
│   └── llama-bench
├── v2026.01/
│   ├── llama-server        ← 支持 router mode ✅
│   └── llama-bench
└── ...
```

实现策略：
1. Tauri 启动时扫描用户指定的 llama.cpp 安装目录
2. 识别各版本目录，检测其 `llama-server --help` 是否含 `--models-dir`
3. 在界面/配置里让用户选择版本；选中后以其 `llama-server`/`llama-bench` 为准
4. 版本信息持久化到应用配置（下次启动自动恢复选中项）

#### 4.3.3 Presets 配置（沿用 llama.cpp 原生 INI 格式）

> ⚠️ **不自创 INI 键**，直接照搬 llama.cpp 原生 preset 格式。

```ini
; config/presets.ini
[DEFAULT]                ; router 级默认，所有加载模型继承
port = 8080
n-gpu-layers = -1        ; -1 = 全部卸载到 CPU；正数 = GPU 层数
device = 0
flash-attn = on
chat-template = jinja
models-max = 4

[my-model]               ; 每个模型一段，模型名 = 段名或 model 字段
model = /abs/path/to/model.gguf
ctx-size = 65536
temp = 0.7
top-p = 0.95
top-k = 40
min-p = 0.05
repeat-penalty = 1.1
# 草稿模型(mmproj)也在这里指定
mmproj = /abs/path/to/mmproj.gguf
```

- `[DEFAULT]` 段定义 router 级参数（端口、GPU 卸载、设备、flash-attn、chat-template、models-max）
- 每个模型一段，`model` 字段指定 GGUF 路径；未指定时以段名/请求的 model 字段匹配
- mmproj（草稿/多模态模型）通过 presets.ini 按模型指定（官方确认支持）
- 完整可用键以 `llama-server --help` 与官方 preset 文档为准

#### 4.3.4 配置文件结构

```
<应用数据目录>/
├── settings.json                 # 用户 llama.cpp 目录、端口、选中版本、preset 路径
└── presets/
    └── presets.ini               # 交给 llama-router 的原生 preset
```

---

## 五、API 契约

### 5.1 对外兼容 API（网关代理到 router，OpenAI 格式）

| 端点 | 方法 | 用途 | 说明 |
|------|------|------|------|
| `/v1/models` | GET | 列出模型 | 代理 router `/models`，返回可用模型及状态 |
| `/v1/models/load` | POST | 触发加载 | 代理 router `/models/load` |
| `/v1/models/unload` | POST | 卸载模型 | 代理 router `/models/unload` |
| `/v1/chat/completions` | POST | 聊天补全 | 代理 router，**SSE 流式原样透传** |
| `/v1/completions` | POST | 文本补全 | 代理 router |
| `/v1/embeddings` | POST | 嵌入向量 | 代理 router |

> router 本身已实现原生 autoload：首次 `/v1/chat/completions` 会触发加载。
> 网关可在转发前加一层"确保已加载"的策略（可选），但非必需。

### 5.2 内部管理 API（供前端，`/api/*`）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/versions` | GET | 已发现的 llama.cpp 版本列表 + router mode 支持标记 |
| `/api/versions/select` | POST | 选择启动版本 |
| `/api/router/status` | GET | router 进程状态/端口/启动日志 |
| `/api/router/start` | POST | 启动 router |
| `/api/router/stop` | POST | 停止 router |
| `/api/models` | GET | 模型列表 + 状态 + 关联 preset |
| `/api/models/{name}/load` | POST | 手动加载 |
| `/api/models/{name}/unload` | POST | 手动卸载 |
| `/api/models/favourite` | POST | toggle 收藏 |
| `/api/presets` | GET/PUT | 读取/更新 presets.ini |
| `/api/logs` | GET(SSE) | 实时日志流 |
| `/api/benchmark` | POST | 启动 llama-bench；GET 取结果 |
| `/api/benchmark/stress` | POST | 启动 API 压测；GET 取结果 |
| `/api/settings` | GET/PUT | 应用设置 |

**典型响应格式**（`/api/models`）：

```json
{
  "success": true,
  "models": [
    {
      "id": "Qwen3.5-27B-Q8_0",
      "alias": "Qwen3.5-27B-Q8_0",
      "architecture": "qwen2",
      "quantization": "Q8_0",
      "size": 5037000000,
      "isLoaded": true,
      "status": "loaded",
      "port": 8081,
      "busy": false,
      "favourite": true,
      "preset": "default"
    }
  ]
}
```

### 5.3 Tauri 命令（前端 `invoke` 用）

前端主要走 Tauri 命令而非直接打 axum。命令集与 `/api/*` 一一对应，
例如 `router-start`、`router-stop`、`models-list`、`bench-run`、`logs-follow` 等；
`log::collector` 通过 Tauri 事件推送日志。

---

## 六、日志方案

- `router::manager` 启动 `llama-server` 时捕获其 stdout/stderr 流
- `log::collector` 读取流，做两件事：
  1. 通过 **Tauri 事件** 推给前端（`useLogs` 订阅）
  2. 通过 **`/api/logs` SSE** 暴露给需要的外部消费者
- 前端照搬 `logs.js`：日志源过滤(全部/系统/各模型) + 控制台快照 + 实时流 + 模型历史日志 + 状态栏 + 自动滚底 + 行缓冲上限
- 不实现复杂的日志聚合/落盘（非核心需求）

---

## 七、性能测试方案

- **llama-bench**：调用所选版本的 `llama-bench`（`router::manager` 同目录获取可执行文件）
  - `services/bench.rs`：构造 `llama-bench` 参数、启动进程、采集输出、解析结果（tok/s、耗时、显存）
  - 前端 `LlamaBenchPane.tsx`：选择模型/参数 → 运行 → 结果表格/图表/复制/导出
- **API 压测**：`services/stress.rs` 并发生成请求打 router `/v1/chat/completions`，统计吞吐
  - 前端 `ApiStressPane.tsx`：promptTokens/maxTokens/并发 → 吞吐/导出 CSV/JSON/MD
- 结果通过 Tauri 命令/SSE 回传；不持久化历史（非核心需求）

---

## 八、数据模型

### 8.1 模型（Model）

```rust
struct ModelInfo {
    id: String,            // 模型ID（= 文件夹名 / GGUF 标识）
    alias: String,         // 显示别名
    architecture: String,  // 架构（llama/qwen2/...）
    quantization: String,  // 量化（Q8_0/Q4_K_M/...）
    size: u64,             // 体积(字节)
    is_loaded: bool,       // 是否已加载
    status: String,        // loaded / stopped / loading
    port: Option<u16>,     // 加载后的推理端口
    busy: bool,            // 是否工作中
    favourite: bool,       // 是否收藏
    preset: String,        // 关联 preset 方案
}
```

### 8.2 版本（LlamaCppVersion）

```rust
struct LlamaCppVersion {
    name: String,          // 版本标识（目录名）
    path: PathBuf,         // 版本目录
    has_router_mode: bool, // 是否支持 Router Mode
    server_bin: PathBuf,   // llama-server 路径
    bench_bin: PathBuf,    // llama-bench 路径
}
```

### 8.3 日志行（LogLine）

```rust
struct LogLine {
    text: String,          // 日志文本
    model_id: String,      // system 或模型ID
    timestamp: u64,        // 毫秒时间戳
}
```

### 8.4 设置（Settings，持久化到 `settings.json`）

```rust
struct Settings {
    llama_cpp_dir: PathBuf,    // 用户指定的 llama.cpp 安装目录
    port: u16,                 // 网关/router 端口
    selected_version: Option<String>,  // 上次选中的版本
    preset_path: PathBuf,      // presets.ini 路径
    autostart: bool,           // 开机自启动开关（设置页可切换）
}
```
```

---

## 九、开发计划

| 阶段 | 任务 | 说明 | 优先级 |
|------|------|------|--------|
| **P1** | Tauri 2 项目初始化 | React+TS+Vite + Rust 骨架 + axum 网关骨架 + 依赖配置 | ⭐⭐⭐ |
| **P2** | 版本发现 + router 生命周期 | 扫描用户目录、检测 router mode、启动/停止 `llama-server` | ⭐⭐⭐ |
| **P2b** | 常驻后台 + 自启动 | 原生托盘 + 关闭隐藏到托盘 + `auto-launch` 写 `HKCU` 自启（设置开关，自启动时一并启动 router） | ⭐⭐ |
| **P3** | 模型管理 | 模型列表/状态(代理 `/models`)、手动加载/卸载、presets.ini 读写、收藏 | ⭐⭐⭐ |
| **P4** | 对外 `/v1/*` 网关 | 代理到 router，SSE 流式透传（dsh/OpenAI SDK 可用） | ⭐⭐⭐ |
| **P5** | 日志系统 | stdout/stderr 采集 → Tauri 事件 + `/api/logs` SSE；前端照搬 `logs.js` | ⭐⭐ |
| **P6** | 性能测试(llama-bench) | llama-bench 调用 + 结果解析 + 图表；前端照搬 `benchmark.js` llama-bench 模式 | ⭐⭐ |
| **P6b** | API 压测 | 后端并发请求生成器 + 吞吐统计（打 router `/v1/chat/completions`）；前端照搬压测模式 | ⭐ |
| **P7** | 设置与持久化 | settings.json、版本/端口/preset 路径记忆 | ⭐ |
| **P8** | 打包发布 | tauri builder 生成 installer | ⭐ |

---

## 十、关键依赖

- **Tauri 2**：https://v2.tauri.app
- **Rust**：`tokio`、`axum`、`tokio-util`(SSE)、`reqwest`(代理 router)、`serde`/`serde_json`、`anyhow`、`tracing`/`tracing-subscriber`
- **前端**：React + Vite + TypeScript；状态用 Zustand（可选，页面少也可用轻量方案）
- **llama.cpp（≥ 2025-12 构建）**：必须支持 Router Mode（`--models-dir`）
- 不依赖 Netty/gson/log4j（原 Java 依赖全部弃用）

---

## 十一、风险与依赖

1. **Router Mode 版本约束**：必须使用 ≥ 2025-12 的 `llama-server`。若用户只有旧二进制，
   需升级或按备选方案补自管理进程（本次不实现）。
2. **preset 键的精确语义**：以 `llama-server --help` 与官方 `tools/server/README.md` 为准，
   实现前需实测确认各键行为（尤其 `n-gpu-layers`、`flash-attn`、mmproj 字段名）。
3. **网关代理的流式透传**：SSE 通过 axum→reqwest 转发需保证 chunk 原样传递与连接生命周期正确。
4. **模型详情来源**：GGUF 量化/参数等详情依赖 router `/models` 返回；如需更细信息需额外 GGUF 解析（本次可选/后置）。
5. **自启动路径稳定性**：`auto-launch` 写入的是当前 exe 的绝对路径；应用被移动/重装后
   注册表项会指向旧路径而失效。建议：安装时（tauri builder）走稳定安装路径；或每次启动
   校验 exe 存在、不存在则更新/移除注册表项。

---

## 十二、参考链接

- [llama.cpp 模型管理博客（Router Mode 官方说明）](https://huggingface.co/blog/ggml-org/model-management-in-llamacpp)
- [llama.cpp tools/server README（router mode 参数与 API）](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama.app — Serving multiple models (router mode)](https://llama.app/docs/serve)
- [llama.cpp Router Mode 讨论 #18939](https://github.com/ggml-org/llama/discussions/18939)
- [llama.cpp-hub 源码（重构来源）](https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub)
- [Tauri 2 文档](https://v2.tauri.app)
