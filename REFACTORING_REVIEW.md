# llama.cpp GUI 重构方案 — 审查报告与最小化实现路线

> 审查对象：`REFACTORING_PLAN.md`（Tauri 2 重构方案 最终版）
> 审查方式：**以本机真实二进制与真实模型库实测**为主，官方文档/源码核对为辅，不做纯纸面评审
> 审查日期：本机实测（llama.cpp b10621 / b10809，Windows x86_64 CUDA）

---

## 0. 结论速览

**方向正确**：把重逻辑交给 llama.cpp 原生 Router Mode 是成立的，本机实测走通了「preset 声明模型 → autoload 加载 → OpenAI 格式推理 → 状态事件 → 日志采集」全链路。

**但有 3 处硬伤会让方案在你的机器上跑不起来或静默失效，另有 1 处整体性冗余使 Rust 代码量约为必要量的 3 倍。**

| 判定 | 问题 | 证据 |
|------|------|------|
| 🔴 硬伤 1 | 方案假设 `--models-dir ./models` 自动发现 `models/<模型名>/<模型>.gguf`。**实测：`--models-dir` 只扫描一层**；你的 `E:\AI\models\<作者>\<模型名>\*.gguf` 两层结构得到 **0 个模型** | 实测 A |
| 🔴 硬伤 2 | 你的 llama.cpp 位于中文目录 `E:\AI\LLM服务工具\`。**实测：router 无法 spawn 子实例**（`failed to spawn server instance`）；同一 preset 换成 ASCII 路径 junction 后立刻成功 | 实测 B |
| 🔴 硬伤 3 | preset 语法写错（`[DEFAULT]` 应为 `[*]`、缺 `version = 1`、`port` 等键会被 router 覆盖、`mmproj` 不是 preset 键），照写会静默不生效 | 实测 C |
| 🟠 冗余 | 方案 A（Tauri axum 网关 + `/api/*` + Tauri 命令 = 三份接口）**不需要**：router 原生已提供 `/v1/*`、`/models`、`/models/load|unload`、`/models/sse`，CORS 默认放开，前端与 dsh 都能直连 | 实测 D |
| 🟢 显著省力点 | 方案里多处"必须自研"的东西其实是原生的：**状态实时推送**（`/models/sse`）、**下载/删除模型**（`POST /models`、`DELETE /models`）、**llama-bench 结果解析**（`-o json`）、**自启动**（官方插件）、**子进程清理**（router 强杀后子实例自动退出，实测 0 残留） | 实测 E |
| 🟢 功能缺口 | 方案 §8.1 的 `size` / `quantization` 字段 router **不提供**；已加载模型可用 `/props` 的 `model_ftype` 补，未加载模型需自研（建议降级为文件名正则 + 文件 stat） | 实测 F |
| 🟢 需求补充（v2.1） | ①**多卡**：`--fit` 默认开启即可自动把模型铺满所有设备并生成 `--tensor-split`，但 hub 的 153 条配置里 **125 条写了 `--gpu-layers`（等于关掉它）**；②**共享 CUDA 库**：Windows DLL 搜索**不递归**，必须精确注入「直接含 `cudart64_*` 的目录」（注入父目录无效），且注入会被 router 与子实例逐级继承 | 实测 G |

**最小化结论**：Rust 侧从方案隐含的 ~3300 行降到 ~1445 行（−57%）；前端按已确认的 React 19 + TS 重写约 2500 行（相对全功能照搬 ~2800 行略减）；总量约 **3950 行 vs 6200 行（−36%）**，且删掉的正是风险最高的部分（SSE 透传、双通道状态一致性）。

---

## 1. 实测环境与方法

| 项 | 值 |
|----|----|
| llama.cpp 版本 1 | `E:\AI\LLM服务工具\llama-b10621-bin-win-cuda-13.3-x64` |
| llama.cpp 版本 2 | `E:\AI\LLM服务工具\llama-b10809-bin-win-cuda-13.3-x64`（`version: 0.4.0-dev (build 10809)`） |
| 模型库 | `E:\AI\models`（真实使用中，10 个作者目录 / 23 个 gguf，**只读扫描，未改动**） |
| 测试模型 | MiniCPM5-2B-Q8_0（2B，本地加载 3.6s 完成一轮 chat） |
| 使用端口 | 18080-18084（临时，已全部关闭，无残留进程） |

实测手段：真实启动 `llama-server` router 实例 + 真实 HTTP 调用 + 真实 kill 进程观测；官方 README 与 `server-models.cpp` / `subproc.cpp` 源码交叉核对。

---

## 2. 实测证据明细

### 实测 A：`--models-dir` 只扫描一层（对方案 §2.1/§4.3 是致命的）

| 被扫描目录 | 结构 | `GET /models` 结果 |
|-----------|------|-------------------|
| `E:\AI\models`（你的真实目录） | `<作者>/<模型名>/*.gguf`，顶层 10 个子目录、0 个直接 gguf | **0 个模型** |
| `E:\AI\models\Unsloth` | `<模型名>/*.gguf`，顶层 3 个含 gguf 的子目录 | **3 个模型**（id = 子目录名，`source=models_dir`） |

结论：`--models-dir` 只认「顶层 `*.gguf` 单文件模型」与「顶层子目录内的一组 gguf（多模态/多分片）」两种形态，**不递归**。方案画的 `models/<模型名>/<模型>.gguf` 恰好比实际能力深一层，照做会得到空列表。

**修正**：不要依赖 `--models-dir` 发现你的模型库。改为**应用递归扫描 → 生成 `presets.ini` → router 用 `--models-preset` 启动**（实测 C 已验证该路径完整可用，且不动你的目录结构）。

### 实测 B：中文路径导致 router 无法创建子实例

```
# 用中文路径的 llama-server 启动 router，再触发一次 chat：
0.18.844.296 I srv  load: spawning server instance with name=minicpm on port 64281
0.18.844.323 I srv  load:   E:\AI\LLM���񹤾�\llama-b10809-bin-win-cuda-13.3-x64\llama-server.exe   ← 自身路径已乱码
0.18.846.573 W srv  operator(): got exception: {"error":{"code":500,"message":"failed to spawn server instance"}}

# 同一 preset、同一模型，llama-server 换成 ASCII 路径（junction）后：
OK 耗时 3.6s   →  正常返回 chat.completion
```

router 用**自身 exe 路径**再 spawn 模型实例，而该路径在 Windows 上以 ANSI 语义传递（`common/subproc.cpp` → `sheredom/subprocess.h`），遇到非 ASCII 路径即损坏 → 找不到可执行文件。

这直接命中你的环境：`E:\AI\LLM服务工具\` 是中文目录，**照现方案实现，所有模型都会加载失败**。

**修正（三选一，建议同时做 1+2）**：
1. 启动 router 前检测所选版本 `llama-server.exe` 路径是否纯 ASCII，非 ASCII 就直接给出明确错误提示（而不是让用户看到 500）；
2. 应用提供「创建 ASCII 链接」一键修复：用 `cmd /c mklink /J`（junction 不需要管理员权限）在工作区建一个纯 ASCII 链接目录，用该路径启动 router —— 本次实测就是用这个方法跑通全部用例的；
3. 文档层面建议用户把 llama.cpp 放到纯 ASCII 路径。

### 实测 C：preset 真实语法与能力（方案 §4.3.3 需重写）

实测有效的 `presets.ini`：

```ini
version = 1          ; ← 必须有；方案里缺
[*]                  ; ← 全局段是 [*]，不是方案写的 [DEFAULT]
ctx-size = 4096
n-gpu-layers = 99

[minicpm]            ; ← 段名 = 模型 id = 请求里的 "model" 字段
model = E:/AI/models/OpenBMB/MiniCPM5-2B/MiniCPM5-2B-Q8_0.gguf
load-on-startup = false
```

实测结果：

| 行为 | 结果 |
|------|------|
| `GET /models` | 2 个条目，`id` = 段名，`source: "preset"` |
| `status.preset` | **回显该段生效内容**（router 会注入 `webui = 0`，并剔除被 router 掌管的键） |
| `status.args` | **渲染后的完整子实例命令行**（含 `--model` 绝对路径、`--port`、`--alias`） |
| autoload | 调用 `/v1/chat/completions`（`model: "minicpm"`）→ 自动 spawn 子实例（随机端口 63893）→ 3.6s 完成 |
| 热重载 | 改 ini 后 `GET /models?reload=1` → 新模型立即出现（`unloaded`），已加载模型保持 `loaded` ✅ |
| 预设专属键 | `load-on-startup`（启动即加载）、`stop-timeout`、`dedup-cache-models` |

**必须修正的 preset 事实**：

| 方案原文 | 实际 |
|---------|------|
| `[DEFAULT]` 全局段 | `[*]` |
| `port = 8080` 放在 preset | **无效**：host/port/api-key/hf-repo/alias 由 router 掌管，会被移除或覆盖（官方 README 明示） |
| `models-max = 4` 放在 preset | 应作为 router 命令行参数（且默认值本来就是 4，**方案里传 `--models-max 4` 是冗余**） |
| `chat-template = jinja` | 键名可用但要写对（`jinja = true` 或 `chat-template = <模板名>`）；`--jinja` 现已默认启用 |
| `mmproj = /path/mmproj.gguf`（"草稿模型"） | **概念混淆**：多模态 mmproj 靠**同目录文件名以 `mmproj` 开头**自动识别，不是 preset 键；草稿模型键是 `model-draft` |

### 实测 D：router 原生接口面足够，网关是自找的复杂度

| 能力 | 原生 | 实测 |
|------|------|------|
| 列模型（含未加载） | `GET /models` | ✅ `status.value: unloaded/loading/loaded/sleeping/downloading/failed`、`args`、`architecture.input_modalities`、`source`、`can_remove` |
| OpenAI 模型发现 | `GET /v1/models` | ✅ **未加载模型也会列出**（dsh 能直接发现全部模型，无需网关补） |
| 加载 / 卸载 | `POST /models/load` / `POST /models/unload` | ✅（方案 §5.1 写的 `/v1/models/load`、`/v1/models/unload` **不存在**） |
| 状态实时推送 | `GET /models/sse` | ✅ `model_status` / `download_progress` / `model_remove` / `models_reload`，loading 带 stages 进度 |
| 下载 / 删除模型 | `POST /models` / `DELETE /models?model=` | ✅（按 HF repo 下载；preset 中的模型不可删，符合"删配置不删文件"） |
| 刷新模型列表 | `GET /models?reload=1` | ✅ 实测热重载生效 |
| 运行态详情 | `GET /props?model=` | ✅ `model_ftype`（Q8_0）、`modalities`、`n_ctx`、`total_slots`、`chat_template`、`build_info`、`is_sleeping`、默认采样参数 |
| 跨源访问 | CORS 默认 `*` | ✅ router 启动时主动告警"CORS is set to allow all origins and no API key is set" → **webview 原生 `fetch`/`EventSource` 可直连 127.0.0.1**，不需要 `tauri-plugin-http` |

因此：`/v1/*` 由 router 直接对 dsh 提供（实测已用 OpenAI 格式调用成功，还附带 `timings.predicted_per_second` 等字段）；管理数据由前端直连 router。**Tauri 侧不需要 axum、不需要 reqwest 代理、不需要 `/api/*`、不需要把 Tauri 命令与 `/api/*` 做成一一对应的双份实现。**

### 实测 E：几处"以为要自研"其实是原生

| 项 | 实测 |
|----|------|
| 子实例日志 | router 以 `subprocess_option_combined_stdout_stderr` 启动子实例，**子实例日志合并进 router stdout，行首带 `[<端口>]` 前缀**；router 自身日志无前缀 → 按前缀分流的"系统/各模型"日志页**可以只采集一个进程** |
| 进程清理 | 强杀 router（`Stop-Process -Force`）后等待 5s：**子实例全部随之退出，残留 0** → 无需自研子进程回收 |
| llama-bench 解析 | `llama-bench -o <csv\|json\|jsonl\|md\|sql>`（默认 md）→ **拿 JSON 即可，不需要写文本解析器**（原 Java 项目解析文本是因为当年没这选项） |
| 设备探测 | `llama-server --list-devices` / `llama-bench --list-devices` |
| 自启动 | 官方 `tauri-plugin-autostart` 存在（crates.io 可查），比手写注册表省 ~75 行 |

### 实测 F：router 不提供的字段（功能缺口）

`GET /models` 条目**没有** `size`（体积）与 `quantization`（量化）字段。方案 §8.1 的 `ModelInfo` 需要它们。

| 场景 | 最小实现 |
|------|---------|
| 已加载模型 | `GET /props?model=X` → `model_ftype` = `"Q8_0"` ✅ |
| 未加载模型 | 用 `status.args` 里的 `--model` 路径（preset 来源）或扫描结果 → 文件 `stat` 得体积；量化从文件名正则提取（`Q8_0`/`Q4_K_M`/`IQ1_S`…）。**不建议**为此写 GGUF 头解析器（原 Java 有 `GGUFMetaDataReader`，数百行，收益低） |

---

### 实测 G（v2.1 追加）：GPU 多卡与共享 CUDA 运行时

**G1. 多卡默认行为**：`--split-mode` 默认 `layer`、`--n-gpu-layers` 默认 `auto`、`--fit` **默认 `on`**。`--fit` 启动时测量每张卡空闲显存，用试位法从后向前分配每卡层数并自动生成 `--tensor-split` → 「多块显卡都要被模型使用」**默认即满足**。

**G2. `--fit` 的中止条件**（`docs/auto-fit-ZH.md`，来自 hub 文档）：用户显式设置 `-ngl`/`-ts` 时跳过对应自动分配；`-sm tensor` 完全不支持（`not implemented for SPLIT_MODE_TENSOR`），`-sm row` 无法调整权重分配。
→ hub 的 **153 条真实配置中 125 条写了 `--gpu-layers`、48 条写了 `--fit off`**，等于关掉了多卡自动分配；迁移时应丢弃这两项。

**G3. 设备参数通路（本机实测）**：

- `--device` 在 **router 参数解析阶段强校验**：`--device CUDA0,CUDA1` 中 CUDA1 不存在 → `invalid device: CUDA1` → **router 直接退出**（应用必须先枚举再传值）。
- 设备名**大小写不敏感**：`--device cuda0` 被接受 → 可兼容 hub 既有的 `device: ["cuda0"]` 写法。
- router 命令行 `--device CUDA0,CUDA0` → 子实例 args **原样保留**。
- preset 段写 `device = CUDA0,CUDA0`、`tensor-split = 3,1`、`split-mode = layer`、`main-gpu = 0` → **全部完整渲染**进子实例命令行。
- 优先级实测为 **CLI > 模型段 > `[*]` 段**（CLI 的 `--split-mode none` 覆盖了段内的 `row`）。
- 结论：**全局组合放 router CLI；per-model 组合放 preset 段**（一旦放进 CLI，段就无法覆盖）。

**G4. 原生显存预估**：`llama-fit-params --model <gguf> -fitp on` → 逐设备输出 `设备 模型MiB 上下文MiB 计算MiB`（实测 `CUDA0 2279 5376 259`，多卡时每卡一行）→ 零自研替代「VRAM 估算」。

**G5. 共享 CUDA 运行时的 DLL 搜索规则（关键实测）**：

| 场景 | PATH | 工作目录 | `--list-devices` |
|------|------|---------|-----------------|
| 1 | 不含 CUDA 目录 | 版本目录 | ❌ `(none)` |
| 2 | **直接含 DLL 的目录** | 版本目录 | ✅ `CUDA0` |
| 3 | **父目录**（DLL 在其子目录） | 版本目录 | ❌ `(none)` |
| 4 | 不含 CUDA 目录 | **直接含 DLL 的目录** | ✅ `CUDA0` |

**搜索不递归**：必须把「直接包含 `cudart64_*` 的目录」加入 PATH（或设为工作目录）；只把 `llamacpp\` 根目录加进 PATH **无效**。

**G6. 继承链**：Tauri 注入的 PATH → router → 模型子实例**逐级继承**。实测在版本目录完全不含 cudart、系统 PATH 中的 cudart 项被剔除、仅靠注入的条件下，子实例仍成功用 CUDA 加载并推理（144.7 t/s）→ 只需在 `router_start` 注入一次。

**G7. 用户既有资产（hub 部署目录）**：`E:\AI\llama.cpp-hub\llamacpp\` = 两个共享 CUDA 目录（`cuda-12.4` / `cuda-13.3`，各 3 个 DLL、约 490–550 MB）+ 版本目录（30 个 DLL，**不含 cudart**）；两个 cudart 目录已被手工加入**系统 PATH**（hub 依赖这一点，新方案改为子进程注入，不依赖它）。
`config/launch_config.json` 记录了 **10 个不同版本目录**的使用历史（b9864→b10831），而磁盘上只剩 1 个 → 版本绑定必须容错（指向已删除版本时降级 + 提示）。
另注：`E:\AI\llama.cpp-hub` 是**部署目录**（317 个 `.class`、0 个 `.java`），Java 源码在 GitHub 仓库，其 `classes/server-params.json`（33 KB）是可直接复用的参数表单 schema。

---

## 3. 方案功能可实现性逐项核对（§1.3 保留清单）

| 方案要求保留 | 能否实现 | 实现方式 | 自研成本 |
|-------------|---------|---------|---------|
| 模型管理（加载/卸载/GGUF 发现/per-model presets） | ✅ | 递归扫描 + 生成 preset + `POST /models/load\|unload` | 中（preset 生成器） |
| 日志（实时查看） | ✅ | 采集 router 一个进程 stdout，按 `[port]` 前缀分流 | 低 |
| 性能测试（llama-bench + API 压测） | ✅ | `llama-bench -o json` 子进程；压测在 **Rust 侧**（见 §4.3） | 中 |
| 自动加载 | ✅ | 原生 autoload（默认开启），无需任何代码 | 零 |
| 多版本 llama.cpp 支持 | ✅ | 扫描版本目录 + `--help` 探测（**首次探测 1575ms，热 152ms → 必须缓存结果**） | 低 |
| 手动加载/卸载按钮 | ✅ | 原生接口 | 零 |
| dsh 兼容 API（`/v1/*`） | ✅ | router 直连，无需网关 | 零 |
| 模型收藏 | ✅ | 本地 `settings.json` 存 id 列表 | 低 |
| 自启动 + 常驻后台（托盘） | ✅ | `tauri-plugin-autostart` + Tauri 原生托盘 | 低 |

以下方案字段/接口在新架构**无来源**，必须替换或砍掉：

| 方案引用 | 问题 | 建议 |
|---------|------|------|
| `/api/models/param/server/list`（§3.3.2 参数表单数据源） | 原 Java 接口，新架构不存在 | 硬编码方案自己列的 7 个参数（`n-gpu-layers`/`ctx-size`/`temp`/`top-p`/`top-k`/`min-p`/`repeat-penalty`）+ 额外参数文本框；全参数覆盖留作后续（解析 `--help` ~120 行） |
| `#cfgVramBtn` VRAM 估算（§3.3.1） | 无原生来源，自研需读 GGUF 头 | 砍（后续可加） |
| `#capGrid` 能力开关（§3.3.1） | 无原生来源 | 砍（`/props` 的 `modalities` 只读展示即可） |
| `#cfgMainGpu` 主 GPU / 设备列表 | 原生支持（v2.1 更正） | `--list-devices` 枚举；`--main-gpu`/`--split-mode`/`--tensor-split` 均可写 preset 段（实测完整渲染）；显存预估用 `llama-fit-params -fitp on` |
| `#cfgCmd` 命令行模式 | — | 保留（就是 preset 段的文本视图，0 额外成本） |
| `/api/models/favourite`（§5.2） | 无原生 | 本地 JSON |
| `/api/logs`（SSE，§5.2/§六） | 无原生；且外部消费者实际不需要日志 | 砍（日志只进桌面 UI） |
| `/api/sys/console`、`/api/sys/model-log` | 原 Java 接口 | 本地环形缓冲替代 |
| §5.2 全表 13 个 `/api/*` | 与原生接口重复 | 全部删除 |

---

## 4. 执行效率审查

### 4.1 网关代理：纯损耗

方案 A 的链路是 `dsh → axum → reqwest → router → 子实例`，而 router 本身**已经是**一个反向代理（实测日志：`proxying request to model minicpm on port 63893`）。多一跳的代价：

- 每个请求多一次本机 TCP + 一次完整 body 缓冲/转发；SSE 场景下多一层流式状态机；
- 方案自己在风险 §11.3 承认「SSE 通过 axum→reqwest 转发需保证 chunk 原样传递与连接生命周期正确」——这是**自找的风险**，删掉方案 A 即消失；
- 首 token 延迟与吞吐都会受影响，而这个应用的核心价值就是给 dsh 提供推理 API。

方案 B（router 直接对外，Tauri 只管进程与 UI）在效率与代码量上同时占优。唯一"损失"是外部端口由 router 决定，但对 dsh 而言只是 base_url 不同。

### 4.2 双通道状态一致性

方案 §2.2「前端走 Tauri 命令，axum 服务外部客户端，两者共用 shared services」意味着**每个功能写两遍入口**（Tauri 命令 + axum handler），且前端拿数据要经 IPC 序列化。前端直连 router HTTP 后：一份接口、零 IPC、浏览器原生 `EventSource` 处理推送。

### 4.3 API 压测**必须**在 Rust 侧（方案这点是对的）

原项目 `benchmark.js` 的并发是前端 `Promise.allSettled`，但 webview 对同一 origin 的 HTTP/1.1 连接数有限（Chromium 约 6 条），`llama-server` 也不支持 HTTP/2 → **并发 32 会被浏览器排队成 6，测出的吞吐严重失真**。方案 §3.6.3 把压测放后端是正确的，应保留（reqwest 可开任意连接数）。这是审查中唯一"方案对、子代理建议错"的点，特此标注。

### 4.4 日志推送策略

`-lv 3` 下每条请求都会产生多行（slot 分配、prompt eval、eval、release）。逐行发 Tauri event 会造成 IPC 洪泛。建议：Rust 侧环形缓冲（上限 10000 行）+ **批量推送（~100ms 或 50 行合并一次）**；进入日志页时先拉一次全量快照再订阅增量。

### 4.5 其它效率点

| 点 | 建议 |
|----|------|
| 版本探测 `--help` | 实测冷 1575ms / 热 152ms（59KB 输出）→ 只在用户新增/首次扫描时探测，结果写入 `settings.json` 缓存 |
| 模型列表刷新 | 用 `/models/sse` 事件驱动；`?reload=1` 仅在保存 preset 后调用（reload 会重扫并可能卸载被改动模型，禁止轮询调用） |
| llama-bench 显存冲突 | llama-bench 会**重新加载模型**，若该模型已被 router 加载则吃双份显存 → 运行前提示，并提供"先卸载该模型"选项（方案未提） |
| 端口冲突 | 启动前检测 8080 占用（方案未提） |
| 子实例端口 | 随机分配（实测 63893/64281），UI 不要假设固定端口 |

---

## 5. 最小化实现方案（推荐落地形态）

### 5.1 架构修订

```
┌──────────────────────────── Tauri 2 应用 ────────────────────────────┐
│  Rust（薄壳 ~1450 行）                    React 19 + TS（前端）         │
│  • router 生命周期（spawn/kill/状态/端口）  • 直接 fetch http://127.0.0.1:PORT/models     │
│  • 日志采集（stdout → 环形缓冲 → 事件）     • EventSource /models/sse（状态实时刷新）      │
│  • 版本扫描 + --help 能力探测（缓存）       • llama-bench / 压测 结果展示                  │
│  • 模型递归扫描 + presets.ini 读写          • 收藏、搜索、排序、密度等纯前端状态            │
│  • llama-bench 子进程（-o json）                                        │
│  • API 压测（reqwest 并发）                                             │
│  • 设置/收藏持久化、托盘、自启动                                          │
└───────────┬──────────────────────────────────┬───────────────────────┘
            │ Tauri 命令（约 8 个）              │ HTTP（CORS 已放开）
            ▼                                  ▼
     ┌──────────────────────────────────────────────────┐
     │  llama-server（router mode，应用启动时拉起）        │
     │  --models-preset <应用数据目录>/presets.ini        │
     │  --port <用户配置，默认 8080> --host 127.0.0.1     │
     │                                                  │
     │  /v1/*  → dsh 与其它 OpenAI 客户端直连（无网关）     │
     │  /models、/models/load|unload、/models/sse → 前端   │
     └──────────────────┬───────────────────────────────┘
                        │ 按需 spawn（原生 autoload/LRU）
                        ▼
              模型实例（随机端口）→ 你的 E:\AI\models\**\*.gguf（不改动）
```

关键差异（相对原方案）：**没有 axum、没有 `/api/*`、没有 reqwest 代理、没有第二份接口**。

### 5.2 后端模块清单（Rust）

| 模块 | 职责 | 估算行数 | 相对原方案 |
|------|------|---------|-----------|
| `router.rs` | spawn/kill/重启 router、端口检测、状态、ASCII 路径校验与 junction 修复 | ~200 | 保留 |
| `logbuf.rs` | stdout 采集、按 `[port]` 分流、环形缓冲、批量事件 | ~120 | 保留（简化） |
| `versions.rs` | 扫描版本目录、`--help` 能力探测与缓存、取 server/bench 路径 | ~90 | 保留（简化） |
| `models.rs` | 递归扫描 gguf、分组（mmproj/多分片）、preset 读写、id 归一 | ~180 | 保留（简化） |
| `bench.rs` | llama-bench 子进程 + `-o json` 解析 + 结果落盘/列表 | ~150 | 保留（**解析简化**） |
| `stress.rs` | reqwest 并发打 `/v1/chat/completions`、吞吐统计 | ~160 | 保留 |
| `settings.rs` | settings.json（目录/端口/版本/preset 路径/自启动/收藏） | ~100 | 保留（简化） |
| `tray.rs` | 托盘菜单、关闭隐藏、退出 | ~60 | 保留 |
| `autostart` | `tauri-plugin-autostart` 配置 + 开关 | ~15 | **原 ~90 行** |
| `commands.rs` | Tauri 命令胶水（约 8 个：router-start/stop/status、versions、models-scan、preset-save、bench-run、stress-run、settings-get/set、logs-snapshot） | ~120 | **原 ~350 行 + axum 双份** |
| ~~`api/openai.rs`~~ | ~~`/v1/*` 代理 + SSE 透传~~ | **0** | **原 ~250 行** |
| ~~`api/control.rs`~~ | ~~13 个 `/api/*` 端点~~ | **0** | **原 ~600 行** |
| ~~`services/*` 双通道适配~~ | — | **0** | **原 ~250 行** |
| **合计** | | **~1445** | **原 ~3370（−57%）** |

### 5.3 前端策略（已确认采用 A：React 19 + TS）

> **已决策**：采用方案 A。下表保留三种方案的对比，用于记录该决策的代价——相对原生 TS 方案预计多约 1000 行
> （组件化 + 状态管理 + 类型定义），换来长期可维护性。

| 方案 | 说明 | 估算行数 | 评价 |
|------|------|---------|------|
| B. Vite + 原生 TS，无框架 | 参考实现 `newui/*.js` 本来就是原生 JS：`logs.js` 的过滤/自动滚底、`models.js` 的搜索/排序/卡片渲染、`benchmark.js` 的 `computeStats` 与 canvas 图表都可**近逐行迁移**，主要改动是接口名与数据形状 | ~1400 + HTML/CSS ~300 | 改动最小、最快落地；与原项目结构一致 |
| **A. React + TS 重写（已采用）** | 组件化更易维护，但"照搬原生 JS"与"React 重写"互相矛盾，等于全部重写 + 引入状态管理/类型定义 | ~2800 + 构建配置 | **已决策采用**（长期可维护性优先）。原注：不适合"最小化开发" |
| C（极限最小）Tauri 外壳 + `llama-server --ui` | router 自带 Web UI 已能管模型（列表/加载/卸载/下载/presets），Tauri 只做托盘 + 启动 + 打开窗口 | UI ≈ 0（日志页/基准页仍需自研 ~500） | 与"三页照搬"的要求不符，仅作备选 |

按方案 B，原参考实现 2491 行的可砍清单：克隆体、多节点/远程、多运行库管理、VRAM 估算、能力位、per-model 自动加载策略、别名（改存本地）、聊天模板编辑、`chat_template_kwargs`、采样配置库（192 行）、设备/主 GPU 联动（108 行）、CSV/JSON/MD 导出、历史文件管理、详情页 3 个 Tab。

### 5.4 几个必须写对的关键实现点

1. **preset 生成器**（核心自研件）
   - 扫描：递归 `<模型根目录>`；含 `mmproj*.gguf` 的目录 → 一个多模态模型；`*-000NN-of-000MM.gguf` → 一个多分片模型；单独 `*.gguf` → 一个模型；`mmproj*` 不单独成模型。
   - id 规则：优先目录名/文件名词干，保证与请求的 `model` 字段一致。
   - 写 ini：`version = 1` + `[*]` 全局 + 每模型一段；**路径用正斜杠或转义后的绝对路径**；不要写 `port`/`alias`/`api-key`（会被 router 覆盖）。
   - 保留用户手写段：读-改-写时对应用不认识的段原样保留（或提供"文本模式"编辑）。
   - 保存后调 `GET /models?reload=1` 生效（实测通过）。
2. **ASCII 路径处理**：见实测 B 的三条修正（校验 + junction 一键修复 + 文档提示）。
3. **日志分流**：`^\[(\d+)\]\s` → 子实例（按 port 映射到模型，映射表由 `/models` 的 `status.args` 与 SSE 事件维护）；其余 → 系统。子实例端口是随机的，不要硬编码。
4. **前端直连**：`tauri.conf.json` 的 CSP 需允许 `connect-src http://127.0.0.1:* http://localhost:*`；不需要 `tauri-plugin-http`。
5. **`/models/sse` 订阅**：模型状态变化 → 局部刷新列表（不要全量轮询）。
6. **模型详情**：已加载用 `/props?model=`（含 `model_ftype`）；未加载用扫描结果 + 文件 stat。
7. **GPU 设备**：只能来自 `--list-devices` 枚举（无效设备名会让 router 直接启动失败）；「GPU 层数」默认留空，否则等于关掉多卡自动分配。
8. **共享 CUDA 库**：把「直接含 `cudart64_*` 的目录」精确注入子进程 `PATH`（父目录无效）；注入后回读 `--list-devices` 校验，缺失即显式报错，不要静默退回 CPU。

### 5.5 代码量对比（估算）

| 部分 | 原方案路径 | 最小方案 | 变化 |
|------|-----------|---------|------|
| Rust 后端 | ~3370 | ~1445 | **−57%** |
| 前端 | ~2800（React 重写三页全功能） | ~2500（React 19 + TS，按可砍清单裁剪） | **−11%** |
| **合计** | **~6170** | **~3950** | **−36%** |

（行数为估算；参考实现实测 2491 行，子代理已按模块给出可砍比例。）

### 5.6 修订后的开发计划

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P1** | 脚手架：Tauri 2 + Vite + TS；设置持久化；目录选择（`tauri-plugin-dialog`） | — |
| **P2** | 版本扫描 + ASCII 路径校验/修复 + router 生命周期（含端口检测、强杀无残留） | P1 |
| **P3** | 模型递归扫描 + preset 生成/热重载 + 前端模型列表页（搜索/筛选/排序/收藏/加载卸载）+ `/models/sse` 状态联动 | P2 |
| **P4** | 日志采集（环形缓冲 + 批量事件）+ 日志页（源过滤/自动滚底） | P2 |
| **P5** | llama-bench（`-o json`）+ API 压测 + 结果页 | P3 |
| **P6** | 托盘常驻 + 自启动 + 打包 | P2 |

原方案的 P4（对外 `/v1/*` 网关）**整阶段删除**——router 直连即完成，dsh 只需要把 base_url 指向 router 端口。

---

## 6. 修订后的风险清单

| 风险 | 状态 |
|------|------|
| Router Mode 版本约束（≥2025-12） | 保留；已实测 b10621/b10809 均支持 `--models-dir/--models-preset/--models-max/--models-autoload` |
| **中文路径导致无法加载模型** | **新增（高）**：实测复现，必须处理，否则功能不可用 |
| **用户既有目录层级与 `--models-dir` 不兼容** | **新增（高）**：改为应用扫描 + preset（已实测可行） |
| SSE 透传正确性 | **已消除**（删除网关层） |
| preset 键语义 | 已实测校正（§3 实测 C） |
| 模型详情（量化/体积）来源 | 降级方案：`/props` + 文件名正则 + stat；GGUF 解析后置 |
| llama-bench 与已加载模型争显存 | 新增（中）：运行前提示/可先卸载 |
| 自启动路径失效 | 保留；用官方插件 + 启动时校验 exe 存在 |
| 端口冲突 | 新增（低）：启动前检测 |

---

## 7. 待决策事项

1. ~~**前端形态**~~ **已定**：采用 **React 19 + TS 重写**（约 2500 行，按可砍清单裁剪），非原生 TS 迁移。
2. **是否删除网关卡**：确认采用「dsh 直连 router 端口」，则方案 §2.2/§4.1 的 `api/`、`services/` 双层结构与 §5.2 的 `/api/*` 全表作废。
3. **`--models-dir` 是否保留**：最小方案用「应用扫描 + preset」；若还想支持"用户自己维护 models-dir"，可作为附加来源（成本低，但要注意一层限制）。
4. **是否要把这三页 UI 的"密度档/卡片列表切换/图表"等装饰性功能砍掉**（方案 §3.2.1 的密度档、§3.6 的图表导出等）。

---

## 附：本次实测命令留痕（可复现）

```powershell
# 版本能力探测
& "<bin>\llama-server.exe" --help | Select-String "models-dir|models-preset|models-max|models-autoload"

# router 启动（preset 方式，实测可用）
& "<ascii-path>\llama-server.exe" --models-preset "<app>\presets.ini" --models-max 2 --port 18081 --host 127.0.0.1 --no-ui

# 列表 / 热重载 / 加载 / 卸载 / 事件
Invoke-RestMethod http://127.0.0.1:18081/models
Invoke-RestMethod "http://127.0.0.1:18081/models?reload=1"
Invoke-RestMethod http://127.0.0.1:18081/models/load -Method Post -Body (@{model="minicpm"}|ConvertTo-Json)
Invoke-RestMethod http://127.0.0.1:18081/models/unload -Method Post -Body (@{model="minicpm"}|ConvertTo-Json)

# 详情 / 推理
Invoke-RestMethod "http://127.0.0.1:18081/props?model=minicpm"
Invoke-RestMethod http://127.0.0.1:18081/v1/chat/completions -Method Post -ContentType application/json -Body $chatBody

# 基准
& "<bin>\llama-bench.exe" -m <gguf> -p 512 -n 128 -o json
```

本次实测产生的证据文件：`tmp/server-README.md`、`tmp/help-b10621.txt`、`tmp/help-b10809.txt`、`tmp/help-bench.txt`、`tmp/server-models.cpp`、`tmp/subproc.cpp`、`tmp/live/presets.ini`、`tmp/live/router18084.log`。
（`E:\AI\models` 与 `E:\AI\LLM服务工具` 全程只读，测试用 junction 已移除，无残留进程。）
