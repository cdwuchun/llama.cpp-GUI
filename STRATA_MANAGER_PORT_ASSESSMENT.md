# strata-manager → llama.cpp-GUI 功能移植评估

> 评估对象：`E:\Code\strata-manager-main`（Strata Manager 0.1.6，Tauri 2 + React 19 + Rust，pnpm workspace）
> 目标工程：`E:\Code\llama.cpp-GUI`（Tauri 2 + React 19 + Rust，llama.cpp Router Mode 管理壳）
> 评估范围：**聊天 / 监控 / Benchmark 测试**三块
> 评估方式：只读源码调研（三个子代理，逐条带 `文件:行号`）+ 在本机**运行中**的用户实例上实测端点
> 结论日期：2026-10-13

---

## 0. 结论速览

| 模块 | 能不能复制 | 复制的是什么 | 主要障碍 | 估算工作量 |
|---|---|---|---|---|
| **聊天** | ✅ **能，主体可搬** | 消息/设置/高级选项/共享默认值/SSE 组帧（约 600 行） | 3 个 Strata 专有请求字段必须删；发送编排与持久化要重写；能力门控数据源换 `GET /props?model=` | **2–4 天** |
| **监控（遥测；~~浮窗/托盘~~ 已取消，见 §7 决策结果 5）** | ⚠️ **UI 能搬；数据源按通道分开**——Strata 通道**现成**，llama.cpp 通道要自采 | 趋势算法/手写 SVG（~~浮窗整套 Tauri 能力/托盘点阵图标，约 1100 行~~ **整块不搬**） | **llama.cpp 没有 GPU/显存/温度/功耗/RAM 指标**（实测 15 个 Prometheus 指标里一个都没有）→ 该通道自采是新增开发；**Strata 通道的硬件指标由引擎 `/metrics` 现成提供**（§3.6），采集层为 0 | **1.5–2.5 周**，其中 P6（浮窗+托盘）已取消，省 3–5 天 |
| **监控（API 用量统计）** | ⚠️ **不能照搬上游，但有替代实现** | 聚合查询与页面可借鉴；**数据源改用 server 日志解析**（§3.5 实测） | 上游靠 Python 进程内注入（不可移植）；llama.cpp 无 per-request 端点，但日志里有每次请求的完整计时 | **3–5 天** |
| **Benchmark 测试** | ✅ **大部分可搬** | 上下文档位、七场景套件、统计口径、报告图片、导出（约 1100 行） | `count_tokens` 校准要降级；资源采样换源；`/health` 身份校验要改 | **4–7 天** |

**一句话**：聊天和 Benchmark 是「接口同源，搬过来改名字」；监控是「UI 同形，**数据分两条通道**」——~~浮窗那套窗口能力可以整套搬~~ **浮窗与托盘已取消（见 §7 决策结果 5），监控只做主窗口内的页面**，**Strata 通道的数据源与上游同构（几乎直接可用），llama.cpp 通道才需要自采硬件**（它只给吞吐和请求计数）。

> **修正说明（同日实测后）**：本节初稿把「API 用量统计」判为完全不可移植，**这个结论过强**。上游的实现方式确实不可搬，但 llama.cpp 的 server 日志里带着每次请求的完整 token 数与计时（见 §3.5，已实测三组样本），逐请求明细可以重建。用量统计应从「不建议做」上调为「可做，工作量 3–5 天」。
>
> **修正说明 2（回答「两个引擎都考虑了吗」）**：初稿只按 llama.cpp 通道推演监控，**漏掉了 Strata 通道**。Strata 引擎的 Python 服务层 `E:\AI\Strata\serve\telemetry.py`（438 行）自己用 NVML + psutil 每秒采样硬件，由 `server.py:3443-3445` 拼进 `GET /metrics` 的 `hardware` / `hardware_static` / `history` 字段（详见 §3.6）。所以「监控采集要从零写」**只对 llama.cpp 通道成立**；**Strata 通道是 A 类直接可移植**（数据源与 strata-manager 完全同构）。

**总工作量估算**：聊天 + Benchmark + 监控（含用量统计）≈ **4–6 周**（单人，含样式适配与自测）。

---

## 1. 本机实测证据（用户运行实例，127.0.0.1:8210，llama.cpp b11482）

用户已启动的实例：`llamacpp-gui` PID 28216（监听 9090 = Strata 前门代理）、router = `llama-server` PID 17488（**监听 8210**）。数据目录实测为 `E:\AI\llama.cpp-gui\`（`settings.json` + `presets\presets.ini` 258 行 / 14 个模型段）。

配置要点（`E:\AI\llama.cpp-gui\settings.json`）：`port: 8210`、**`models_max: 1`**、`api_key: "sk-1234567809!QAZ"`（已设 → 除 `/health` 全需鉴权）、`sleep_idle_seconds: -1`、`strata_router_mutex: true`。presets 中 **6 个段带 `no-webui = true`**（bge-m3、bge-reranker-v2-m3、Qwen3-Embedding-0.6B、Qwen3-reranker-0.6B、Hy-MT2-1.8B、Hy-MT2-7B），**全部 14 段都没有 `metrics` 键**。

### 1.1 端点能力实测

| 端点 | 结果 | 对移植的意义 |
|---|---|---|
| `GET /health` | 200 `{"status":"ok"}`（唯一免鉴权） | 与 HANDOVER 铁律 4 一致 |
| `GET /props`（router 自身） | `{"role":"router","max_instances":1,"models_autoload":true,"model_path":"none","build_info":"b11482-b86d2f075",...}` | router 元信息，`build_info` 可做版本探测 |
| `GET /metrics`（不带 model） | **400** `model name is missing from the request` | 必须按模型取 |
| `GET /slots`（不带 model） | **400**（同一条） | **`/slots` 也按模型路由**（此前未记录） |
| `GET /v1/models` | 14 个模型，每个含 `status.value`(loaded/unloaded)、`status.args`、`status.preset`、**`architecture.input_modalities`**（`["text"]` / `["text","image"]`） | 判「是否已加载」与「是否多模态」的权威来源 |
| `GET /props?model=X` | **200，字段极全** | 见下 1.2——**这是聊天能力门控的理想数据源** |
| `GET /slots?model=X` | `[{"id":0,"n_ctx":4096,"speculative":false,"is_processing":false},...]` | **只有 4 个字段**，没有旧版 `state`/`prompt`/`n_past` |
| `GET /metrics?model=X` | 200 Prometheus 文本，**15 个指标**（见 1.3） | 吞吐/请求计数有，硬件全无 |
| `POST /v1/chat/completions`（stream） | OpenAI 兼容 chunk，末块带 `timings` | 字段名与 strata-manager 基准**完全相同** |
| `POST /v1/chat/completions`（`stream_options:{include_usage:true}`） | finish_reason 块后**多一个独立 chunk**，`choices: []` + `usage` + `timings`，然后 `[DONE]` | **基准的 token 统计可零改造** |
| CORS（`Origin: http://localhost:1420`） | OPTIONS 200 + 回显 Origin + `Allow-Credentials: true` + `Allow-Headers: *` | **前端 webview 直连无障碍**，无需 Rust 中转 |

### 1.2 `GET /props?model=X` 的关键字段（聊天/监控的能力门控来源）

- `chat_template`（完整 Jinja 全文）
- **`chat_template_caps`**：`supports_object_arguments` / `supports_parallel_tool_calls` / `supports_preserve_reasoning` / `supports_reasoning_effort` / `supports_string_content` / `supports_system_role` / `supports_tool_calls` / `supports_tools` / `supports_typed_content` → **直接替代 strata-manager 里 `parseChatCapabilities()` 对 `/v1/status` 的依赖**
- **`modalities: {vision, video, audio}`** + `media_marker`
- `default_generation_settings.params`：`seed/temperature/top_k/top_p/min_p/top_n_sigma/xtc_*/typical_p/repeat_last_n/repeat_penalty/presence_penalty/frequency_penalty/dry_*/mirostat*/max_tokens/n_predict/ignore_eos/samplers[]/speculative.types/timings_per_token/chat_format/reasoning_format/reasoning_in_content`
- `n_ctx`、`total_slots`、`model_alias`、`model_ftype`（实测 `Q6_K`）、`model_path`、`is_sleeping`
- **`endpoint_slots` / `endpoint_props` / `endpoint_metrics`** → 直接暴露子实例启用了哪些端点

### 1.3 `GET /metrics?model=X` 的 15 个指标（全部 `llamacpp:` 前缀）

`prompt_tokens_total`、`prompt_tokens_cached_total`、`prompt_seconds_total`、`tokens_predicted_total`、`tokens_predicted_seconds_total`、`n_decode_total`、`n_tokens_max`、`spec_decode_num_draft_tokens_total`、`spec_decode_num_accepted_tokens_total`、`spec_decode_num_drafts_total`、`prompt_tokens_seconds`（gauge）、`predicted_tokens_seconds`（gauge）、`requests_processing`、`requests_deferred`、`n_busy_slots_per_decode`

→ **grep 确认：没有任何 `kv_cache` / `hardware` / `gpu` / `vram` / `ram` / `cpu` 字样**。
→ **监控移植的最大成本就在这里**：速度与请求计数够用，硬件与显存占用必须自采。

### 1.4 两个关键机制（都靠实测确认，不看文档推不出来）

1. **`--metrics` 会下发到子实例**：带 `--metrics` 的 router 实例（临时起在 8299，已关闭）对同一模型返回 `endpoint_slots=true / endpoint_props=false / endpoint_metrics=true`；不带时用户实例为 `endpoint_metrics=false`。启动日志含 `srv load: --metrics` 与子实例 `[58433] listening on http://127.0.0.1:58433`。
   → **只需给 router 加一个开关，全部子实例就暴露 metrics，不需要改 preset 生成逻辑**（与铁律①「router 把自身 common 参数下发给每个子实例」同源，方向相反）。

2. **`?model=` 会触发按需加载（autoload）—— 监控的致命陷阱**：
   干净对照实测：`GET /slots?model=Qwen/Qwen3-Embedding-0.6B` 调用前 `status.value = unloaded`，**调用后 = `loaded`**。此前 `GET /props?model=Unsloth/Hy-MT2-1.8B` 也把该模型从 unloaded 变 loaded。
   → **监控绝不能对未加载模型轮询 `/slots|/props|/metrics?model=`**，否则会与 `src-tauri/src/idle.rs` 的卸载守护（对 `status.value == "sleeping"` 的模型 `POST /models/unload`）形成「监控加载 → 守护卸载 → 再加载」的拉锯，并破坏 `settings.strata_router_mutex` 的显存互斥。
   → 正确做法：**先 `GET /v1/models` 判 `status.value`，只对 `loaded` 的模型轮询**。

### 1.5 流式响应契约（与 strata-manager 的差异）

llama.cpp 末块：

```json
"timings": {"cache_n":4,"prompt_n":1,"prompt_ms":116.012,"prompt_per_token_ms":116.012,
            "prompt_per_second":8.62,"predicted_n":2,"predicted_ms":96.22,
            "predicted_per_token_ms":96.22,"predicted_per_second":10.39}
```

- strata-manager 基准读的正是 `delta.timings.prompt_per_second` / `predicted_per_second`（`packages/core/src/benchmark.ts:167-170`）→ **字段同名**。
- 差异：**llama.cpp 只在末块给一次 `timings`**；Strata 每块都给。
- 非流式响应含 `usage.prompt_tokens_details.cached_tokens`（实测 `cached_tokens: 4`）→ 正是 `benchmark.ts:161-166` 读的缓存命名字段。

---

## 2. 聊天模块

### 2.1 上游实现定性（子代理调研结论）

前端直连 OpenAI 兼容 `/v1/chat/completions`（`packages/core/src/bridge.ts:173`，Rust 白名单 `apps/desktop/src-tauri/src/http.rs:72`），**流式走 Tauri Channel 而非 webview 直连**（`http.rs:156-183 strata_stream`）。传输格式 90% 通用。

**请求体**（`packages/core/src/chat.ts:224-244 buildChatRequest`）：

```
{ model, messages: api, stream: true, ...sampling, ...advanced, ...(options.mcp ? { strata_mcp: true } : {}) }
```

**Strata 专有字段只有 3 个**：
- `strata_mcp: true`（`chat.ts:243`）
- `strata_prefix: {messages:n}|{message:i,chars}`（`chat.ts:241`，固定前缀/文档缓存）
- `experimental_speed_projection`（`chat.ts:221`，依赖 `/metrics` 的 `engine.cvec`）

**能力门控是必须重写的部分**：`parseChatCapabilities()`（`chat.ts:54`）的判定式是
`const official = s.service === 'strata' && Array.isArray(s.dialects) && s.dialects.includes('/v1/chat/completions')`（`chat.ts:57`）——**硬绑 `service === 'strata'`**，数据来自 Strata 的 `/v1/status`。
→ 在 llama.cpp 侧应改为：**`GET /props?model=X` 的 `chat_template_caps` + `modalities` + `/v1/models` 的 `architecture.input_modalities` + `default_generation_settings.params`**（实测字段齐全，见 1.2）。

**可直搬的通用件**：
- `SSEParser`（`chat.ts:247-280`，处理 CR/LF、多行 data、UTF-8 边界、忽略 `:` 心跳行）
- `decodeChatChunk`（`chat.ts:282-311`，读 `delta.content` / `delta.reasoning_content` / `usage` / `timings` / `finish_reason` / `[DONE]`）
- 附件处理：文本内联 fenced 块（`chat.ts:160-166`），图片走 `{type:'image_url', image_url:{url}}`（`chat.ts:184`，需 `/health` 报 `images:true` → 在 llama.cpp 侧改用 `modalities.vision` 或 `architecture.input_modalities` 含 `"image"`）
- 结构化输出 `json_object` / `json_schema`（`chat.ts:139-146`）——注意 llama.cpp 侧 `json_schema` 与 `grammar` 是同一字段的别名，最终走 GBNF，**且受 chat template 影响**（上游 issue #11988 / PR #21537），必须逐模型实测
- 共享默认值体系：`packages/core/src/shared-chat-settings.ts:7-10`（`reasoningEffort:'high', temperature:.6, topP:.95, topK:20, maxTokens:0, seed:null, mcp:true`）、`usesCommonChatDefaults()`（:37-39）、`resolveCommonChatOptions()`（:41-53）、`prepareModelChatOptionsForSave()`（:56-75）——**这套「新模型继承公共生成参数、显式值优先」是当前 GUI 完全没有的增量价值**

**不能搬**：MCP（`strata_mcp` 字段 + SSE 事件 `chunk.strata_mcp`（`chat.ts:291-299`）+ `/mcp` 列表 + 历史重放 `assistantMessages()`（`chat.ts:190-208`））、`strata_prefix`（含 `crates/runtime-core/src/chat_runtime.rs:337` 的进程归属核验）、`experimental_speed_projection`、端点 `/v1/messages`、`/v1/messages/count_tokens`、`/api/requests`、`RequestViewer`（121 行）。

**上游也没做的**：多轮上下文自动裁剪（`App.tsx:603` 全量发出）、重新生成、编辑消息/分支、会话搜索。

### 2.2 要重写的三处

1. **发送编排**：上游在 `App.tsx:575-640`（约 65 行）里做发送/附件/持久化；本工程应放进 `src/store.ts`（zustand，当前唯一编排点）+ 新增 `src/api/chat.ts`，用已有的 fetch 流读取（`src/api/router.ts` 的 SSE 读法），**不需要 Rust 中转**。
2. **持久化**：上游走 SQLite（`crates/runtime-core/src/store.rs:6` 建 `kv`/`attachments`/`attachment_refs` 三表，Supervisor 通道）。本工程无 SQLite → 建议 **localStorage**（会话量小）+ 大对象单独键，或复用 `save_text_file` 命令落 `runtime/chat/*.json`。附件拆表与 GC 逻辑不需要。
3. **能力门控**：如上，改数据源。

### 2.3 与铁律的冲突点（必须在实现时处理）

- **模型名要用 preset 段名**（铁律 2）：`selected.section`，不是扫描 id。
- **配了 `--api-key` 后 `/v1/chat/completions` 也要鉴权**，且只认请求头（`Authorization: Bearer` / `x-api-key`）→ 前端 fetch 加头即可；**SSE 不能用 `EventSource`**（铁律 4）→ 用 fetch 流（`src/api/router.ts` 已是这个做法）。
- **6 个 `no-webui = true` 的模型**：现在这些卡片的「聊天」入口被禁用是预期的（HANDOVER §2 第②条）。**若改为原生聊天 UI，这条禁用逻辑的语义要重新定义**——原生聊天走 `/v1/chat/completions`，不依赖子实例 WebUI，所以这些模型**也能聊天**（如 bge-m3 这类嵌入模型虽然技术上能回，但没意义；应改按 `architecture.input_modalities` / 模型类型判断，而不是按 `no-webui`）。
- **绝不能内嵌 llama.cpp WebUI**：已在上一轮实测被否决（Tauri iframe 内不渲染，见 `STRATA_INTEGRATION_PLAN.md:931`、`:938`）。原生聊天 UI 是唯一可行方向。
- 这同时**改变了历史决策** `REFACTORING_PLAN.md:63`「聊天范围 = **只暴露 API，不建聊天 UI**」，以及 `:78` ❌移除「实时速度(t/s)显示」、`:77` ❌移除「用量统计」——需要用户确认。

### 2.4 代码量

可搬 ≈ **600 行**（ChatMessageView 34、ChatSettings 54、ChatAdvancedOptions 44、CommonChatSettingsPanel 76、ChatPage 62、`chat.ts` 大部分 311、`shared-chat-settings.ts` 75）；
需重写 ≈ **150–250 行**（编排 + 持久化 + 门控 + 样式适配）；
上游 `packages/core/src/chat.ts` 全文 311 行、`shared-chat-settings.ts` 75 行，**纯逻辑无 DOM 依赖，可直接放进 `src/utils/`**（注意项目约定：组件文件只导出组件，工具函数放 `src/utils/`）。

---

## 3. 监控模块

### 3.1 上游实现定性（含 Strata 引擎侧的真相）

**监控不自己采硬件 —— 因为硬件是上游引擎送的**：前端所有数值（GPU/CPU/显存/温度/功耗/磁盘/PCIe/tok-s 与 history 曲线）都是引擎 `GET /metrics` 一个 JSON 的转手展示（`apps/desktop/src/App.tsx:275`，采样周期 = `settings.pollInterval`）。Rust 侧只采进程/内存/磁盘/网络（`sysinfo = "0.38"`，`crates/runtime-core/Cargo.toml:16`），**没有任何 nvml/PDH GPU 采样**。

**那个 JSON 里的硬件是谁采的？——Strata 引擎自己的 Python 服务层**（本轮实测补充，见 §3.6）：`E:\AI\Strata\serve\telemetry.py`（438 行）起一个后台线程，**每秒采样一次**，GPU 走 **NVML**（`ctypes` 直接加载 `nvml.dll` / `libnvidia-ml.so.1`，随驱动安装，**不需要 pip 包**），CPU/RAM/disk 走 **psutil**（`requirements.txt:15 psutil==7.2.2`），读不到的字段一律 `None`（注释明确「anything that cannot be read is None; nothing here can stop the server」）；`HISTORY = 60` 保留最近 60 点（1 分钟）给 sparkline。

**可搬的三层**：

1. **趋势算法**（`apps/desktop/src/serviceStatusTelemetry.ts`，44 行，纯函数）：
   - `telemetryPoint(at, metric?, loaded?)`：`decode` 仅当 `loaded===true && state==='generating'`；`prefill` 仅当 `state ∈ {reading,prefill}`；其余写 **null**
   - `appendTelemetry(previous, identity, point)`：identity（`profile.id|baseUrl|pid|creationTime`）变化即清空；**保留窗口 = 180 秒 / 最多 60 点**
   - `telemetrySparkline()`：`x = 4 + (at-from)/(to-from)*152`、`y = 44 - min(1,value/max)*38`（viewBox `0 0 160 48`）；**遇 null 就断线 → 保留真实时间间距缺口**
   - 配套测试 `serviceStatusTelemetry.test.mjs`（72 行）——**只依赖一个类型，可直接搬**
2. **手写 SVG 图表**（零图表库）：`OfficialMonitoring.tsx:30-54 sparkPaths`、`components.tsx:24-40 Chart`（600×132，网格 `M0 34H600M0 78H600M0 124H600`）、`OfficialMonitoring.tsx:151` 状态环（`strokeDasharray="235.6 314.2"` + `rotate(135 60 60)`）
   → **本工程全仓 `<svg>`/`viewBox` 0 命中，搬过来即是全新能力**
3. ~~**悬浮窗与托盘整套 Tauri 能力**（与 Strata 无关，纯 Tauri 2）~~ —— **本轮不搬（2026-10-14 用户定稿：不要浮窗，托盘也不显示监控；见 §7 决策结果 5）**。以下记录保留，供将来若改主意时当入口：
   - `apps/desktop/src-tauri/src/floating_monitor.rs`（481 行）：`LABEL = "service-monitor"`、无边框 40px 高置顶窗、右下角定位（`work_area()` + `(area.width - (width+16)*scale).max(0)`）、**已存在则 `emit("monitor-restored")` 复用**（保留用户位置与置顶偏好）、静态 `Mutex` 防并发
   - `FloatingTelemetryWindow.tsx`（202 行）：**手写拖拽**（`Math.hypot < 4` 阈值后 `startDragging()`）、**原生 Tauri 菜单**（`Menu.new` + `popup`，十项 action + pause/pin 的 `checked`）、`pollingInterval` clamp **1000..30000**（缺省 2000）、`stale = now - sampledAt > max(15000, interval*3)`
   - `monitor_tray.rs`（418 行）：**手写 32×32 RGBA 点阵数字字体**图标（0-9 与 'k'，≥1000 显示 `Nk`，上限 99k；测试覆盖 999.4→"999"、999.5→"1k"）、`showInTray` 默认关、节拍 `clamp(1000, 60_000)`
   - `invoke_policy.rs`（121 行）：**窗口级命令白名单**（`("service-monitor","service-monitor")` 只放行 3 个命令），这是一个值得学的安全模式
   - `open_monitor_window` / `monitor_snapshot` / `show_main_from_monitor` / `minimize_monitor_to_tray` 四个命令，以及「浮条只读、绝不触发后端自愈」的语义（`floating_monitor.rs:130-170` 端点白名单：只允许 GET `/health` 与 `/metrics`）

### 3.2 必须新写的：数据采集层

**llama.cpp 侧的指标来源映射表**（这是本评估最有实操价值的部分）：

| strata-manager 字段 | llama.cpp 侧来源 | 备注 |
|---|---|---|
| `state`（idle/reading/generating） | `/slots?model=` 的 `is_processing` + 自身请求活动 | **只能近似**，llama.cpp 没有等价状态机 |
| `decodeTokS`（生成中） | `/metrics?model=` 的 `llamacpp:predicted_tokens_seconds`（或 `tokens_predicted_total / tokens_predicted_seconds_total` 自算） | 字段存在 |
| `decodeTokS`（空闲，标签「最近生成」） | **自行记录最近一次请求的 `timings.predicted_per_second`** | 上游靠 `metrics.ts:41` 读 `requests[0].decode_tok_s`；llama.cpp 无此字段 |
| `prefillTokS` | `llamacpp:prompt_tokens_seconds` / `prompt_seconds_total` | 字段存在 |
| `queued` / `running` | `llamacpp:requests_processing` / `requests_deferred`，或 `/slots` 里 `is_processing` 的计数 | 字段存在 |
| `cacheHitRate` | `prompt_tokens_details.cached_tokens / prompt_tokens`（从聊天/基准的 usage 自算），或 `prompt_tokens_cached_total / prompt_tokens_total` | 字段存在 |
| `gpuUtil` / `gpuMemoryUsed/Total` / `gpuTemperature` / `gpuPower` | **❌ 无 → 必须自采**：`nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits` | 本工程当前**无任何 GPU 遥测代码** |
| `cpuUtil` / `ramUsed/Total` | **❌ 无 → 必须自采**：新增 `sysinfo` 依赖（本工程当前无此依赖） | |
| 上下文占用 | `/props?model=` 的 `n_ctx` + 最近一次请求的 `usage.prompt_tokens` | 可算 |
| 槽位表（`SlotMonitor.tsx` 23 行） | `/slots?model=`（只有 `id/n_ctx/speculative/is_processing`） | **上游那个「保留历史词元/对话容量占用」无对应物** |
| `history` 曲线 | **自建环形缓冲**（上游直接用 `/metrics` 自带的 `history` 数组） | |
| `conversation_cache`（parked/slots/bytes/parks/restores/evictions）、`engine.expert_cache_*`、`totals`、`mcp`、`projection` | ❌ 无对应物 | 放弃这些卡片 |

**结论**：监控移植的实际工作是「**把 strata-manager 的监控 UI 接到一套你要自己写的采集层上**」。若只做「速度 + 请求计数 + 槽位」，采集层几乎为零（直接读 `/metrics` + `/slots`）；**若要 GPU/显存/温度/功耗/CPU/RAM，就要引入 `sysinfo` + `nvidia-smi` 解析**（可选择性地只在 Windows + NVIDIA 下启用，无 GPU 时降级隐藏这几个字段）。

### 3.3 上游的用量统计是怎么实现的（**实现方式不可照搬**）

**采集方式不是代理中间件，也不是引擎自带的端点，而是注入引擎进程的 Python 观察器**——`crates/runtime-core/src/observer.rs:7` 把 `apps/supervisor/resources/strata_observer.py`（886 行）写进 `data_dir/observer-v1/`，靠 `sitecustomize.py` 在引擎进程里 `sys.meta_path.insert(0, _Finder())`，`_Finder.find_spec` 只拦截 `serve.server`，再用 ast 在 `if __name__ == "__main__"` 前注入钩子（`strata_observer.py:834-869`）。版本核验只认 3~4 个 `serve/server.py` 源码哈希（`request_capture.rs:14-18`）。
llama.cpp 是 C++ 二进制：**既不能注入 sitecustomize，也没有 `/v1/messages` 等 4 条被观测路由** → C 类。Rust 侧 `analytics.rs`（1849 行）的 journal→SQLite 消费管线同理作废。
**替代方案**：见 §3.5 —— llama.cpp 的 server 日志里带着每次请求的完整计时与 token 数，可直接重建逐请求明细；`/metrics` 的累计计数器（`prompt_tokens_total` 等）可用于总量与速率。**上游的「引擎不提供逐请求历史」这一点，llama.cpp 同样成立**；差别在于 llama.cpp 有可解析的结构化日志，而上游选择了进程内注入。

### 3.4 代码量

可搬 ≈ **1100 行**（前端 15 个文件约 1.5K 行里去掉 `ApiUsagePage`(330) 与 `OverviewUsage`(21)；Rust 浮窗+托盘+白名单 1020 行 —— **这三个 Rust 文件已随 P6 取消而不搬，见 §7 决策结果 5**）；
需新写：
- **llama.cpp 通道 ≈ 400–600 行**（硬件采集 + 指标聚合 + 命令）；
- **Strata 通道 ≈ 0 行采集**（引擎 `/metrics` 已给全，只需一个取数适配，见 §3.6）；两通道**共用同一套 UI 与趋势算法**；
上游监控总量约 8.7K 行（含 Python 886 与大量测试、45 个 CSS 文件）。

### 3.5 用量统计的替代实现：server 日志解析（**本轮实测新增**）

上游那套（进程内注入）不可移植，但 **llama.cpp 的 server 日志里带着每次请求的完整用量**。实测（b11482，**默认 verbosity 3**，日志留存于 `tmp/usage-probe-jsonl.log`）：

```
srv  proxy_reques: proxying request to model Unsloth/Hy-MT2-1.8B on port 62182      ← router 侧：模型名 + 子实例端口
slot launch_slot_: id  1 | task 0 | processing task, is_child = 0                   ← 请求开始
slot print_timing: id  1 | task 0 | prompt eval time =  44.62 ms /  5 tokens ( 8.92 ms per token, 112.06 tokens per second)
slot print_timing: id  1 | task 0 |        eval time =  37.47 ms /  2 tokens (37.47 ms per token,  26.69 tokens per second)
slot print_timing: id  1 | task 0 |       total time =  82.09 ms /  7 tokens
slot      release: id  1 | task 0 | stop processing: n_tokens = 6, truncated = 0    ← 请求结束
```

**可重建的字段**（三组样本 + 一次缓存命中样本验证一致）：

| 字段 | 来源 | 校验 |
|---|---|---|
| 模型 | router 行 `proxying request to model X on port N` | 与请求的 `model` 一致 |
| `completion_tokens` | `eval time = … / N tokens` 的 N | 与 `usage.completion_tokens` 一致 |
| `prompt_n`（未缓存 prompt 数） | `prompt eval time = … / N tokens` 的 N | 与 `timings.prompt_n` 一致 |
| `prompt_tokens + completion_tokens` | `release: n_tokens = M` → `M + 1` | 5+2=7↔6、16+6=22↔21 两组吻合 |
| `cached_tokens` | `(M + 1) − completion_tokens − prompt_n` | 缓存命中样本算出 15，与 `usage.prompt_tokens_details.cached_tokens = 15` 吻合 |
| prefill 时长 / 速率 | `prompt eval time = X ms / N tokens (… Y tokens per second)` | 与 `timings.prompt_ms / prompt_per_second` 一致 |
| decode 时长 / 速率 | `eval time = …` | 与 `timings.predicted_ms / predicted_per_second` 一致 |
| slot id、task id | 各行的 `id N \| task M` | task id 用来配对同一次请求的多行 |

**四个加分项**：

1. **不需要提高日志级别**（默认 verbosity 3 就打印），**也不需要改 router 启动参数**；
2. **`--log-jsonl` 让每行都是 JSON**（`{"type":"log","time":…,"level":…,"msg":…}`），且实测**该参数会下发给子实例**；子实例日志经 router 转发后形如 `[62182] {…}`，即**先剥 `[port] ` 前缀再解析第二层 JSON** —— 与本工程 `router.rs` 既有的行首 `[%5d]` 分流逻辑同源，基础设施已有；
3. **`--log-file FNAME` 可直接写文件**，且 router 会捕获并转发子实例 stdout（日志里的 `child server monitoring thread started, waiting for EOF on stdin...`），所以**只需给 router 一个参数**就能拿到全部子实例的日志；
4. 顺带发现一条结构化事件 `fit_memory_breakdown`：`{"type":"fit_memory_breakdown","data":{"unit":"MiB","rows":[{"kind":"host","name":"Host","self":1759,"model":1563,"context":136,"compute":60}]}}` —— 模型 / 上下文 / 计算的 MiB 分解（启动时一次，非实时，可作为显存占用的近似）。

**缺口（如实列出）**：

- **没有 client_id / 身份**：`--api-key` 场景下无法区分是哪个客户端发的（上游靠进程内钩子拿 `client_id`）；
- **没有 TTFT**：只能用 `prompt eval time` 近似；严格 TTFT 需要本 GUI 自己发请求时前端计时（聊天与基准场景可精确，第三方客户端只能近似）；
- **没有 outcome / HTTP 状态 / 错误分类**：失败或被取消的请求可能没有 `release` 行，需要额外推断；
- **日志会持续增长**：长期统计要做轮转 + 增量解析 + 落盘，不能全留在内存（本工程日志环形缓冲上限 10000 行）；
- **公式只用 3 组样本验证**：截断（`truncated = 1`）、提前 stop、多模态、embedding / rerank 请求的日志形状尚未验证。

**结论**：用量统计**不是「不可做」，而是「换一条数据通路做」**——`/metrics` 计数器做总量与速率，日志解析做逐请求明细。上游的聚合查询与页面（`ApiUsagePage` 330 行）可借鉴，但采集层与持久层要重写。

### 3.6 双通道：Strata 通道的监控数据是**现成的**（本轮实测补充）

本 GUI 有两条引擎通道，报告初稿只按 llama.cpp 通道推演，漏掉了一半 —— 而漏掉的那一半是好消息。

| | **llama.cpp router 通道** | **Strata 通道** |
|---|---|---|
| 硬件指标（GPU 利用率/显存/温度/功耗/PCIe/磁盘） | ❌ 完全没有（`/metrics?model=` 的 15 个指标全是引擎内部计数器） | ✅ **现成**：`hardware` 字段（NVML + psutil，每秒采样，多卡时有 `gpus` 数组） |
| 趋势历史 | ❌ 无，需自建环形缓冲 | ✅ **现成**：`history` 数组，每序列 60 点（1 分钟） |
| 引擎状态机 | ⚠️ 只能近似（`/slots?model=` 的 `is_processing`） | ✅ `live.state` = `reading` / `generating` / `unloaded` / `idle`（`server.py:3404-3411`） |
| 当前 tok/s（生成中 + 均值） | ⚠️ 从 `/metrics` 计数器自算 | ✅ `live.tok_s` / `tok_s_mean` / `prefill_tok_s_mean`（引擎侧已算好，`server.py:3417-3419`） |
| 最近请求明细 | ⚠️ 只能解析 server 日志（§3.5） | ✅ `requests` 数组（含 `input`/`output`/`reasoning`，`?requests=all` 取全量）+ `totals` |
| 槽位 | `/slots?model=`（4 字段精简版） | ✅ `live.slots` / `parallel` / `running` / `outside_slots` / `waiting` / `admitting` |
| 会话缓存 | ❌ 无对应物 | ✅ `conversation_cache`（parked / slots / bytes / parks / restores / evictions） |
| 端到端可达性 | 前端直连 `127.0.0.1:<port>` | **`127.0.0.1:9090` 前门代理是透明转发**（`strata_proxy.rs` 无端点白名单，只对 `/v1/models`、`/health`、模型解析做特殊处理）→ `/metrics` 直接可取 |

**这意味着**：

1. **监控面板应做成双通道**：Strata 通道下，`serviceStatusTelemetry.ts`（44 行，纯函数）与 `normalizeMetrics`（`packages/core/src/metrics.ts`）几乎**原样可用** —— 数据源与上游同构，这才是真正的「A 类直接可移植」；初稿把监控整体判为「采集要从零写」，对 Strata 通道是错的。
2. **只有 llama.cpp 通道**需要自建硬件采集（§3.2 那座映射表里标 ❌ 的几行）。
3. **显存互斥已存在**（`settings.strata_router_mutex`），但监控面板必须明示「当前读数来自哪条通道」，不要让一条通道显示另一条的数值。
4. **实现可以直接照着抄**：`E:\AI\Strata\serve\telemetry.py`（438 行）就是一份「NVML via ctypes + psutil + 每秒采样 + 60 点环形缓冲」的参考实现，移到 Rust 侧对应 `nvml-wrapper`（或 `nvidia-smi` 子进程）+ `sysinfo`，结构与字段名都可对齐。
5. **附带发现**：Strata 还有 `GET /metrics/prometheus`（`server.py:3447`），**主动用 llama.cpp 的指标名 `llamacpp:*` 输出**（`server.py:3456-3464`：`llamacpp:prompt_tokens_total`、`llamacpp:tokens_predicted_total` …），只把 drafts / requests 放进 `strata:*`，注释写明「so its dashboards work unchanged」—— 上游自己就在对齐两套命名，说明「双通道统一指标口径」有先例、可行。
6. **GUI 目前完全没用这个数据源**：全仓对 Strata 侧只用了 `/health` 与 `/props.build_info`（`strata.rs:6`、`:833`；`lib.rs:493/576/668`），`/metrics` 一次都没调用过 —— 这是零成本的现成能力，且**不需要启动引擎就能先用起来**（引擎在跑时即可取到）。

---

## 4. Benchmark 测试模块

### 4.1 上游四套基准（UI 上只活两套）

| 套件 | 文件 | 内容 | 可移植性 |
|---|---|---|---|
| **上下文档位** | `packages/core/src/context-benchmark.ts`（273 行） | `CONTEXT_BENCHMARK_TIERS = [8,32,64,128,256,384,512,768,1024].map(k => k*1024)`、`HEADROOM = 64`、默认 `{maxTokens:512, timeoutMs:600_000, rounds:1, stopOnError:true}`、串行双循环、用 `POST /v1/messages/count_tokens` **迭代 6 次**校准输入量 | **校准要降级** → 走 `estimated` 分支（llama.cpp 无 count_tokens 端点；可用 `usage.prompt_tokens` 反馈式校准替代） |
| **七项场景** | `packages/core/src/benchmark-suite.ts`（320 行） | `BENCHMARK_SCENARIOS` = short/code/long/decode/cache/conversation/custom，默认 6 项、`rounds:2, maxTokens:256, inputChars:8192, conversationTurns:3` | **可搬**（prompt 内容需按 llama.cpp 调整） |
| 串行基准 | `packages/core/src/benchmark.ts`（272 行） | **已无 UI 入口**（全仓无组件调用 `core.runBenchmark`） | 可作为统计口径的参考实现 |
| Rust 调优负载 | `crates/runtime-core/src/tuning_workloads.rs`（1115 行）七项 | **唯一带正确性判定**：`require_answer` 严格 JSON 全等 + `strict_object` 拒绝多余键（`tuning_quality.rs` 是自写 Python 子集有限解释器 + 46 固定用例） | **不可移植**（耦合 Strata 调优体系与维护门 `X-Strata-Manager-Tuning-Id`） |

### 4.2 指标口径（**这是最值得抄的部分**）

- **TTFT 自己计时**：`benchmark.ts:158` 用 `performance.now()`，条件是首个 `content` 或 `reasoning` 非空
- **prefill/decode 速率直接读引擎给的字段，不自算**：`benchmark.ts:167-170` 读 `delta.timings.prompt_per_second` / `predicted_per_second`
  → **llama.cpp 末块的 `timings` 字段名完全同名（1.5 节实测）** → **零改造**
- **token 数读流式 `usage`**（`benchmark.ts:154-155`、`benchmark-suite.ts:117`、`context-benchmark.ts:176` 三处都发 `stream_options: {include_usage: true}`）
  → **实测 llama.cpp 支持**（1.1 节）→ **零改造**；注意 `choices` 为空数组，解析器要容忍
- **缓存命中率** = `mean(cachedTokens / promptTokens)`（`benchmark.ts:270`）；`cached_tokens` 实测存在
- **统计**：自写百分位（mean/p50/p95，套件加 p99）；**warmup 轮永远排除**（`benchmark.ts:265`）
- **TS 三套没有正确性/质量判定**（只看是否收到 `[DONE]`，否则抛 `STREAM_INCOMPLETE`），样本状态只有 completed/failed/cancelled

### 4.3 需要改造的部分

1. **资源采样**：上游每 2000ms（`benchmark-suite.ts:232`）或每 1000ms（`context-benchmark.ts:175`）读 Strata `/metrics` 的 `hardware.*` → 换成本工程自采（同 3.2）
2. **`/health` 身份校验**：上游 `verifyHealth` 要求 `service === 'strata'` → llama.cpp 的 `/health` 只返回 `{"status":"ok"}`
3. **互斥**：上游是 JS 层锁（`benchmark.ts:86-94 acquireBenchmarkEndpoint`，键 = 端口；`benchmark-suite.ts:71-76 isBusy`）+ 文档自认「不保证其他 API 客户端无并发负载」
   → 本工程应**复用已有的 `src-tauri/src/bench.rs`**（Rust 侧发压，`bench.rs:136` 打 `POST /v1/chat/completions`，跨 router / Strata / kvmem 三条通道统一），互斥放在 Rust 侧更可靠
4. **报告图片**（`pages/contextBenchmarkImage.ts` 187 行）：**不是 html2canvas**——克隆活体 SVG + `getComputedStyle` 内联 25 个属性（`SVG_STYLES`）→ `XMLSerializer` → Blob → 画到 1600px canvas（`scale = Math.min(2, MAX_EDGE/width)`，`if (scale < 1) throw`）→ `toBlob(png)`。**纯前端、无依赖，可直接搬**
5. **导出**：JSON/CSV 纯浏览器 Blob；CSV 加 `\uFEFF` + CRLF + **防注入 `if (/^[=+\-@]/.test(text)) text = '\t' + text`**（值得抄）
6. **持久化**：上游是 `store_set` + `STORE_KEY='contextBenchmarkReportsV1'` / `'benchmarkReportsV1'`、保留前 20 组且累计 ≤16MiB（`HISTORY_BYTES = 16*1024*1024`）→ 本工程已有 `bench_records*` 命令与 `bench/records.json`，可复用
7. **`--st-*` token 层与鉴权头**

### 4.4 与现有 `BenchPanel` 的关系

本工程已有 `src/components/BenchPanel.tsx`（616 行）+ `src/utils/bench.ts`（186）+ `src-tauri/src/bench.rs`（404）≈ **1206 行**，做的是「并发 API 压测」。

建议：**新老并存但共用后端** —— 现有 API 压测保留；新增「上下文档位」与「场景套件」两个面板，Rust 侧复用 `bench.rs` 的请求发送与并发框架（并发的正确做法本工程已有）。
上游三套共约 3100 行（含测试与 Playwright 验收脚本 `apps/desktop/tests/optimization/verify-benchmark.mjs` 464 行，它用**合成 SSE** 做验收——这个方法值得学）。

---

## 5. 样式移植策略

| 项 | 现状 |
|---|---|
| 本工程 CSS | 只有 4 个全局文件（`src/main.tsx:7-10` 引入）：FontAwesome `styles/css/all.min.css`、`legacy/css2.css`、`legacy/index.css`(4276 行)、`app.css`(1532 行)。**没有任何按组件引入的 CSS** |
| 上游 CSS | 45 个文件、`^\.[a-z]` 类名定义 **2022 处**；两套体系：自有「无前缀类名」（`.panel/.metric/.badge/.notice/.empty/.field/.chart/.sidebar`）+ 搬来的 Strata UI 设计系统（`.st-*` + `--st-*` 变量，`official/tokens.css` 87 行） |

**三个真实冲突（必须处理，否则静默坏样式）**：

1. **撞名类**：`.panel`（本工程自定义在 `src/styles/app.css:55`，配套 `.panel-head/.panel-body`；上游 `Panel` 输出 `section.panel > header.panel-header`）、`.notice`（本工程有 `.notice`/`.notice.warn`，上游 `.notice.error/.warning`）、`.sidebar`（`legacy/index.css:201`）、`.badge`（本工程仅 `#hfHitsList .badge`，风险低）
   → `.panel/.notice/.metric/.badge/.empty/.field/.chart` **这 7 个无前缀类必须重命名或做作用域包裹**
2. **全局元素选择器（最危险）**：上游 `apps/desktop/src/styles.css:3` 定义裸 `button{}`、`input,textarea,select{}`；`official/components.css:2-5` 定义 `*,*::before,*::after{box-sizing}`、`html,body{}`、`a{}`、`:focus-visible{}`；`official-pages.css:14` 是 `html,body,#root{height:100%;min-height:0}body{overflow:hidden}`
   → 本工程 legacy CSS 依赖 `body{display:flex}`（`app.css:9-23` 把角色搬到 `#root`），**直接并入会改掉整个壳布局**
3. **CSS 变量回退陷阱**：上游多处 `var(--st-line, var(--border))`；本工程变量名是 `--border-color/--bg-color/--card-bg/--accent-color`（`legacy/index.css:1-25`），**没有 `--border/--surface/--text`** → 回退解析为空、**声明整条静默失效（不报错）**
   → 必须搬 `official/tokens.css` 的变量表，或把回退名改成本工程的变量名

**结论**：带前缀的 `.st-*` / `.official-*` / `.service-*` / `.floating-*` / `.api-usage-*` / `.overview-*` **可直接搬**；上面 7 个无前缀类与三条全局 reset **必须处理**。建议整体套一个作用域容器（如 `.strata-*` 前缀或 `.official-surface` 式包裹），**不要**把上游的 `tokens.css` 全局 reset 直接塞进 `main.tsx`。

### §5.1 样式基座决策结果（2026-10-14 用户定稿，实施规格见 `UI_STYLE_BASELINE.md`）

本节初稿建议的是「移植时怎么处理冲突」，用户定稿把范围放大了：**借这次移植把全站视觉基座换掉，且基座先于任何新面板完成**。九条定稿：

1. **全站统一到 Strata 色板与字体** —— 老页面一起换，不做「新面板 Strata 绿 + 老页面 hub 黑白」的双基线并置。基线源就是 `E:\AI\Strata\serve\web\tokens.css`（87 行）。
2. **先全量清干净 130 处内联 `style={{}}`，再上新面板** —— 内联大头是 `src/components/SettingsPanel.tsx` 45 处。
3. **不搬上游 CSS，只照搬结构与数值、按本项目 token 重写** —— 延续既有惯例（`src/styles/app.css:919` 与 `:1046` 都写着「样式照搬 hub 新版 newui.css，变量换成 legacy 主题的」）；上游的 `*,*::before,*::after`、`html,body`、`button{}`、`input,textarea,select{}` 全部不入库。上面 7 个无前缀撞名类改名 `.st-*`。
4. **字体与图标都换** —— 拉丁用 Outfit（`E:\AI\Strata\serve\web\fonts`，SIL OFL 1.1）；因 Outfit 无 CJK 字形（`tokens.css:6-7` 的 `unicode-range` 只到 latin/latin-ext），中文用 **MiSans / HarmonyOS Sans SC 子集**，子集产物一次性入库、构建期零工具链。图标全站退役 FontAwesome，改自有 SVG sprite + 自建 `<Icon name>` 组件。
5. **图标来源 = 上游 sprite 32 图 + lucide 补缺** —— 上游 `sprite.svg`（28,577B、32 个 symbol、`viewBox 0 0 24 24`、描边风格）直接入库；本项目现有 68 个 unique `fa-*` 中 19 个语义直接对应，约 41 个从 lucide（ISC）补缺；**不装 lucide-react**。
6. **应用图标与托盘图标本轮不动** —— 只换界面图标，不触发「换图标后删 `src-tauri\target\release\build\llamacpp-gui-*` 与 `.fingerprint/llamacpp-gui-*`」那条构建铁律。
7. **设置页照上游形态重构（2026-10-14 追加）** —— `src/components/SettingsPanel.tsx` 739 行、45 处内联（全站内联的 35%）现在是 14 个 tab 的长页堆叠；改为上游的「左侧分组导航列表 + 右侧 `.st-card` 分组 + `<details>` 折叠 + 行式开关」。归组映射表见 `UI_STYLE_BASELINE.md` §10.5；45 处内联随整页重写消失，故原 S5 里「SettingsPanel 45」一项改由 S7 消化。
8. **「运行环境」页并入设置页（2026-10-14 追加，同日按用户反馈收窄）** —— `src/App.tsx:15` 的 `Tab` 联合类型去掉 `"runtime"`、`:25` 顶栏项删除、`:321` 条件渲染删除（**顶栏 tab 由 6 个减为 5 个**）；`src/components/RuntimePanel.tsx` **262 行删除**，其中**只并入版本表一块**（设置页「服务」组首卡，按钮改名「扫描 llama.cpp 版本」，共享 CUDA 运行时目录列改成折叠）；**前门启停按钮不进设置页**（唯一手动入口 = 侧栏左下角 `.router-pill` 胶囊 `src/App.tsx:234-316`；前门化后现有两颗合并为「前门 :9090」一颗，见 `UI_STYLE_BASELINE.md` §10.8）；**推理设备表、多卡策略说明段、路径信息一律退役**（用户决策）。映射与四条约束见 `UI_STYLE_BASELINE.md` §10.7。只动前端呈现层：`src/store.ts` 与 `src-tauri/src/gpu.rs` 零改动（设备数据仍被模型页 / 参数表单 / 压测消费，见 §10.7）；**localStorage 里已存的 `"runtime"` 值必须回落到 `"settings"`**，否则老用户下次打开是空白页。

9. **断点体系统一到 640 / 900 两档（2026-10-14 追加）** —— 全站 `@media` 由 6 档收敛为 **640 / 900**，主断点取 **900**（取代上游的 1000）；`app.css:39`/`:295` 的 `min-width:901` 保留，与 `app.css:19` 的 `max-width:900` 成互补对。迁移：6 处散档改判为 900（`legacy/index.css:324`、`:835`、`:1190` 由 768→900；`:2919` 960→900；`:3200` 1000→900；`:1976` 1100→900），2 处删除（`:3068` 空块、`:3788` 与 `:3718` 重复），19 处不动。**这是本轮唯一会改变既有页面行为的动作**（901–960 更新结果区恢复多列、901–1000 HF 面板恢复双列、901–1100 HF 分栏恢复横排）。新增 **S8**（0.5 天，排在 S7 后、S6 前）+ 验收矩阵 1440/1100/1000/900/899/640/480 × 明暗。`@media` 条件**不能引用 CSS 变量**（无预处理器），只能靠 `AGENTS.md` 铁律 8 约束。迁移表与行为变化清单见 `UI_STYLE_BASELINE.md` §10.4。

对 §6 实施顺序的影响：**新增 S1–S8 样式基座阶段（≈10–13.5 天），P3 聊天 / P5 监控 UI / P7 用量统计全部后移到 S 之后**；P4 采集层与 P1/P2 的纯 TS+SVG 部分可与 S 并行。数字与逐表映射见 `UI_STYLE_BASELINE.md` §2 与 §6。

---

## 6. 建议实施顺序

| 阶段 | 内容 | 依赖 | 估算 |
|---|---|---|---|
| **P0** | 决策确认（见 §7）；把本报告归档进仓库 | — | — |
| **P1** | **Benchmark 上文档位**：搬 `context-benchmark.ts` + 图表 + 报告图片 + 导出；Rust 侧复用 `bench.rs`；`count_tokens` 校准降级为 `estimated` | 无（不依赖监控） | 3–5 天 |
| **P2** | **Benchmark 七场景套件** + 结果历史（复用 `bench_records*`） | P1 的图表/导出组件 | 2–3 天 |
| **P3** | **聊天**：`src/utils/chat.ts`（搬 SSE 组帧/请求构造/共享默认值）+ `src/api/chat.ts` + 新 `ChatPanel`；能力门控接 `/props?model=`；localStorage 持久化 | 无 | 2–4 天 |
| **P4** | **监控采集层**：Rust 新增 `sysinfo`（CPU/RAM）+ `nvidia-smi` 解析（GPU/显存/温度/功耗）+ `/metrics?model=` 与 `/slots?model=` 聚合命令；**先 `GET /v1/models` 判 loaded 再轮询**（autoload 陷阱） | 无 | 3–5 天 |
| **P5** | **监控 UI**：状态栏胶囊 + 弹层（趋势/缺口）+ 手写 SVG | P4 | 3–4 天 |
| ~~**P6**~~ | ~~**悬浮窗 + 托盘**：搬 `floating_monitor.rs` / `monitor_tray.rs` / `invoke_policy.rs` 模式 + `FloatingTelemetryWindow`~~ **已取消**（2026-10-14 用户定稿：不要浮窗，托盘也不显示监控。见 §7 决策结果 5） | — | ~~3–5 天~~ **0**（省下） |
| **P7** | 用量统计（**基于 server 日志解析**，见 §3.5）：不依赖新依赖，复用现有日志采集与分流 | 无（可与 P4 并行） | 3–5 天 |

**不建议按「先监控后基准」的顺序**：监控的自采层是唯一需要引入新依赖（`sysinfo`、`nvidia-smi` 解析）的部分，风险最高；Benchmark 与聊天几乎零新依赖，先做能快速验证「移植这条路走得通」。

---

## 7. 需要你决策的四点

1. **是否改变历史决策** —— `REFACTORING_PLAN.md:63` 原文：`| 聊天范围 | **只暴露 API，不建聊天 UI** | 前端只做 3 个页面；聊天由外部客户端（dsh 等）调 /v1/chat/completions |`。做原生聊天 UI 即推翻此条（同时推翻 `:78` ❌移除「实时速度(t/s)显示」、`:77` ❌移除「用量统计」的部分）。
2. **监控要不要硬件指标** —— 分通道看：**Strata 通道现成**（引擎 `/metrics` 已给 NVML + psutil 全套，1 秒采样 / 60 点历史，见 §3.6）；**llama.cpp 通道**只要「速度/请求/槽位」采集层几乎为零（读 `/metrics` + `/slots`），要 GPU/显存/温度/功耗/CPU/RAM 就得新增 `sysinfo` 依赖 + NVML（或 `nvidia-smi` 子进程）采集，并且**在无 NVIDIA 的机器上要优雅降级**。折中方案：硬件卡片只在 Strata 通道显示，llama.cpp 通道只显示引擎侧可见项（这也是两通道数据源的真实差异，见 §3.6 对比表）。
3. **用量统计怎么做** —— 上游那套（进程内 Python 注入）**不可移植**，但日志解析路径可行（§3.5，已实测）；可选：只做 `/metrics` 计数器的总量与速率（几乎零成本），或做完整的逐请求明细（3–5 天）。
4. **现有 `BenchPanel`（API 压测）如何处置** —— 保留并与新面板共存（共用 Rust 后端），还是合并成一个多标签页（注意 `HANDOVER.md` §8 未决项①：现有性能测试面板**切标签会丢状态**，合并前应先把它提升到 store）。

### §7 决策结果（2026-10-14 用户定稿）

1. **建原生聊天 UI** —— 正式推翻 `REFACTORING_PLAN.md:63`「只暴露 API，不建聊天 UI」，并连带恢复 `:77`「用量统计」与 `:78`「实时速度(t/s)显示」两条已否决项。§2 的移植按此执行；`no-webui` 语义按 §8 风险条目改为按 `architecture.input_modalities`/模型类型判断。
2. **监控两通道都做硬件指标**（不采用折中方案）—— llama.cpp 通道新增 `sysinfo`（CPU/RAM）+ NVML 或 `nvidia-smi` 子进程解析（GPU/显存/温度/功耗），**无 NVIDIA 的机器要优雅降级**；Strata 通道用引擎 `/metrics` 现成数据（1 秒采样 / 60 点历史）。§6 的 P4 采集层按全量做，工期 +3–5 天。
3. **API 用量统计做完整逐请求明细** —— 走 §3.5 的 server 日志解析路径，3–5 天，不引入新依赖；§9 的边界情形（`truncated = 1`、提前 stop、请求失败/取消、多模态与 embedding/rerank 的日志形状、`n_tokens` 换算）必须在实现期逐项实测后才可上线。
4. **BenchPanel 合并成一个多标签页**，与新的上下文档位 / 七场景基准共用 `bench.rs`；合并前先把压测状态提升到 store（`HANDOVER.md` §8 未决项①：切标签丢状态）。
   **追加要求（用户原话「UI 样式要统一」）：合并后的面板样式必须统一，按 §5 三条冲突逐条处理** —— `.panel/.notice/.metric/.badge/.empty/.field/.chart` 这 7 个无前缀类改名或做作用域包裹；上游裸 `button{}`、`input,textarea,select{}`、`*,*::before,*::after{box-sizing}`、`html,body,#root{...}` 等全局 reset **不得直接并入**（本工程 `app.css:9-23` 把布局角色放在 `#root`）；`var(--st-line, var(--border))` 这类回退变量名要改成本工程的 `--border-color/--bg-color/--card-bg/--accent-color`，或整体搬 `official/tokens.css` 的变量表。移植后**必须用真实 webview 目视验证**（沙箱内起不来窗口）。
5. **不做浮窗、托盘也不显示监控**（2026-10-14 用户原话：「不要浮窗，托盘也不显示监控」）—— §3.1 第 3 条那套 Tauri 能力（`floating_monitor.rs` 481 行 + `monitor_tray.rs` 418 行 + `invoke_policy.rs` 121 行 + `FloatingTelemetryWindow.tsx` 202 行 ≈ 1100 行可搬代码）**整块不搬**；§6 的 P6 取消（省 3–5 天）。本工程托盘保持现状（`src-tauri/src/tray.rs` 199 行：菜单「显示主窗口 / 启动服务 / 停止服务 / 退出」+ tooltip 显示 router 状态与端口 + 关窗隐藏 + 自启动 `--minimized` 直驻托盘），**不加点阵速度数字图标、不加遥测 tooltip、不新增第二个托盘图标**。§9 第 5 条「悬浮窗鼠标穿透未确认」随之作废。监控只做页面（P4 采集层 + P5 页面），读数一律在主窗口内看 —— 上游「浮窗与托盘共享同一只读快照」那条设计约束因此不引入。

---

## 8. 风险清单

| 风险 | 说明 | 缓解 |
|---|---|---|
| **autoload 陷阱** | 对未加载模型的 `/slots|/props|/metrics?model=` 会把它拉进显存，与 `idle.rs` 卸载守护拉锯 | 先 `GET /v1/models` 判 `status.value`，只轮询 `loaded` |
| **`--metrics` 需改启动参数** | 用户实例当前 `endpoint_metrics = false`（presets 里无 `metrics` 键） | 在 router 启动参数里加 `--metrics`（实测会下发给子实例）；**注意不要写进 preset 段**（会与铁律⑤的「被淘汰键」风险混淆，且需验证 `metrics` 是否为合法 preset 键） |
| **样式静默失效** | `--st-*` 变量缺失导致整条声明失效，不报错 | 按 §5 处理；移植后**必须用真实 webview 目视验证**（沙箱内起不来窗口） |
| **`json_schema` 静默无约束** | llama.cpp 侧受 chat template 影响（上游 issue #11988 / PR #21537），可能忽略 schema 生成自由文本 | 逐模型实测；把它当作「尽力而为」而非保证 |
| **`no-webui` 语义变化** | 6 个当前禁用聊天的模型，改成原生 UI 后语义变了 | 改按 `architecture.input_modalities` / 模型类型判断 |
| **上下文溢出** | 上游没有自动裁剪（全量发出，靠服务端 400） | 若要移植聊天，必须自己做窗口裁剪或明确提示用户 |
| **`/slots` 字段太少** | 只有 `id/n_ctx/speculative/is_processing`，没有 `state`/`prompt`/`n_past` | 槽位面板要做「降级版」；状态机只能近似 |

---

## 9. 未确认项（需要进一步实测/查证）

1. **`metrics` 能否写进 preset 段**（而不是只作为 router 启动参数）——本机 presets 里一个都没有；若可写，则「按模型开 metrics」成为可能。
2. **`/metrics` 在 router 模式下多模型同时加载时如何聚合**——是否需要按模型分别拉取再合并（`?model=` 是按模型路由的，推测需要逐模型拉，但未实测多加载场景）。
3. **`/slots?model=` 的 `is_processing` 是否足以推断 `generating`/`reading`**——需要实际跑一次长生成观察字段变化。
4. **strata-manager 的 `ChatMessageView.tsx` markdown 渲染细节**（34 行的轻量自研渲染，未逐行核对）。
5. ~~**悬浮窗鼠标穿透**：上游全仓无 `set_ignore_cursor_events` → 未确认是否存在该能力（按窗口属性看就是普通置顶无边框窗）。~~ **作废**（2026-10-14 用户定稿不做浮窗，见 §7 决策结果 5）。
6. ~~Strata `/metrics` 的 history 数组长度与服务端采样周期~~ —— **已确认（本轮读到引擎源码）**：`E:\AI\Strata\serve\telemetry.py:21 HISTORY = 60`、`:424-433 _loop()` 每秒一次（`self._stop.wait(1.0)`）→ **1 秒采样、每序列保留 60 点（1 分钟）**；`snapshot()` 返回 `{"now": …, "history": {k: [...]}, "static": …}`，与 `server.py:3443-3445` 的 `/metrics` 字段一一对应。
10. **Strata `/metrics` 经 GUI 9090 前门代理的实际转发结果未实测** —— 代码上 `strata_proxy.rs` 无端点白名单（透明转发），但**引擎当前没有运行**（`E:\AI\Strata\strata-swift-iq3_xxs.json` 的 `port: 9092`，当前无监听；9080/9090 分别是另外两个进程），因此没有实取样例。启动引擎后应实测 `GET http://127.0.0.1:9090/metrics` 的返回与 `hardware` 字段。
11. **`hardware_static` 与会话缓存（`conversation_cache`）的完整字段**未逐项核对（只从 `server.py:3441-3445` 的拼接处确认了字段名与来源）。
7. **日志解析公式的边界情形**（§3.5）：`truncated = 1`、提前 stop、请求失败/取消、多模态与 embedding / rerank 请求的日志形状均未验证；`n_tokens` 与 token 数的换算关系只用了 3 组样本。
8. **`--log-file` 与 GUI 现有日志采集的关系**：本工程现在从 router 的 stdout 抓日志（`logs://lines`）；若改用 `--log-file`，需确认两者是否会重复采集、以及日志文件的位置与轮转策略（未验证）。
9. **`fit_memory_breakdown` 事件的适用范围**：只在启用 `--fit`（用户设置 `gpu.fit: true`）时出现，且只有 `kind: "host"` 一行；GPU 显存分解是否会出现、频率如何，未验证。

---

## 附录 A：上游三个模块的代码量明细

- **聊天**：ChatPage.tsx 62、ChatMessageView.tsx 34、ChatSettings.tsx 54、ChatAdvancedOptions.tsx 44、CommonChatSettingsPanel.tsx 76、RequestViewer.tsx 121、`packages/core/src/chat.ts` 311、`shared-chat-settings.ts` 75、`crates/runtime-core/src/chat_runtime.rs` 337、`apps/desktop/src-tauri/src/http.rs` 440（聊天核心约 70 行）
- **监控**：前端 15 文件 ≈ 1.5K（OfficialMonitoring 179、MonitoringDetails 130、SlotMonitor 23、ServiceStatusPopover 119、serviceStatusTelemetry 44、ServiceTelemetryStatusBar 57、FloatingTelemetryWindow 202、floatingMonitor 50、FloatingMonitorSettings 28、ApiUsagePage 330、ApiUsageStrings 114、OverviewPage 117、OverviewUsage 21、components 41）；Rust 核心 ≈ 5.0K（floating_monitor 481、monitor_tray 418、invoke_policy 121、http 440、supervisor_client 1649、health_watch 1476、analytics 1849、request_capture 331、observer 57）；Python 886；CSS 1.3K → **≈ 8.7K 行**
- **Benchmark**：core 5 文件 1056、前端 6 文件 789、`pages/benchmark.css` 214、测试 5 文件 1157 → **≈ 3100 行**

## 附录 B：本工程现状对照

- 前端 `src`：27 文件 9362 行（最大 `styles/legacy/index.css` 4057、`styles/app.css` 1309、`store.ts` 1205、`components/StrataPanel.tsx` 1014、`ModelSheets.tsx` 873、`ParamForm.tsx` 766、`SettingsPanel.tsx` 739、`utils/strataParams.ts` 711、`BenchPanel.tsx` 616、`ModelListPanel.tsx` 572）
- 后端 `src-tauri/src`：17 文件 10364 行（最大 `models.rs` 2884、`lib.rs` 1706、`strata.rs` 1028、`strata_proxy.rs` 863、`settings.rs` 798、`router.rs` 642、`gpu.rs` 506、`versions.rs` 402、`bench.rs` 365、`state.rs` 292）
- 无聊天页、无监控页、无指标采集；`bench.rs` 是唯一测试类后端；前端直连 router 的 HTTP+SSE（`src/api/router.ts`）
