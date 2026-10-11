# Strata 整合方案与实现记录

> **状态：已全部落地并投入使用（2026-10 更新）。** 前 10 节是最初的调研与方案 —— 保留当时的实测结论与取舍依据（「为什么这样做」），不再逐条维护；**§11 起是逐轮实现记录**，每节对应一轮需求与落地结果，最新为 §21。
>
> 当前落点：后端 `src-tauri/src/strata.rs` + `src-tauri/src/lib.rs` 注册的 11 个命令（`strata_status` / `strata_scan` / `strata_probe` / `strata_start` / `strata_stop` / `strata_set_root` / `strata_pick` / `strata_config_read` / `strata_config_write` / `strata_unload_model` / `strata_load_model`）与压测命令 `bench_strata`；前端 `src/components/StrataPanel.tsx`、`src/utils/strataParams.ts`、`src/ipc.ts` 的包装与 `strata://status` 订阅。
>
> **仍未做的两处**（见 §11.2）：R7「升级前主动让路」、R8「回滚入口」—— GUI 里没有 Strata 自我升级的入口，用户自己跑 `UPDATE.bat`。另外 §9 的 iframe 内嵌最终没有采用，WebUI 用系统浏览器打开（`ipc.openLocalUrl`）。

> 调研对象：<https://github.com/Niko1221/Strata>
> 本机已安装：引擎 `E:\AI\Strata`，数据与模型 `E:\AI\Strata-data`（用户 m00192 / m00193）。
> 本文所有 Strata 侧结论来自**本机安装实测**（文件:行号），GUI 侧结论来自本仓库代码实测。远程仓库内容仅作补充。

---

## 0. 结论先行

**Strata 可以整合，而且比 kvmem 好整合得多 —— 它天生就是一个 OpenAI 兼容的 HTTP 服务，GUI 现有的前端与压测几乎可以直接对接。但它不是「多模型 router」，它是「一个 config 一个常驻模型」，所以整合形态仍然是「第二运行时通道」，与 kvmem 方案同构。**

四条实测依据：

1. **启动方式明确且简单**（`E:\AI\Strata\run-swift-iq3_xxs.bat:4`，本机实测）：
   ```
   E:\AI\Strata\.venv\Scripts\python.exe E:\AI\Strata\serve\server.py \
     --engine strata --config E:\AI\Strata\strata-swift-iq3_xxs.json --port 9090 --open
   ```
   一个 Python 进程 + 一份 JSON config。GUI 只要会 spawn 这一个进程就完成 80% 整合。

2. **管理端点齐全，且刻意做了 llama.cpp 兼容**（`E:\AI\Strata\serve\server.py:6-7` 模块 docstring 原文）：
   > `Endpoints: POST /v1/chat/completions (OpenAI, stream and non-stream), POST /v1/messages (Anthropic, stream and non-stream), GET /v1/models, GET /models, GET /props, GET /slots, GET /health, GET /mcp. One sequence at a time behind a FIFO (plan: one resident sequence).`

   实测端点全集见 §1 表。GUI 的 `src/api/router.ts` 依赖的 `GET /models`、`GET /props` **存在**；`POST /models/load`、`POST /models/unload` 对应 Strata 的 `POST /load`、`POST /unload`（路径不同，语义相同）。

3. **鉴权与 Origin 防护对 GUI 的 Rust 侧天然放行**（`E:\AI\Strata\serve\server.py:4601-4608`）：
   > `_foreign_origin`: *"no Origin is a client that is no browser."*

   本仓库 `src-tauri/src/http.rs:30-39` 手写 HTTP/1.1，**不发 `Origin` 头**，POST 时自动带 `Content-Type: application/json`（`http.rs:32`），鉴权写 `Authorization: Bearer`（`http.rs:36`）。这三条正好满足 Strata `_own_page()` 的全部要求（`server.py:4552-4562`）。
   → **`http.rs` 零改动即可调用 Strata 的 `/load` `/unload` `/config` `/settings` `/v1/vram`。** 前端 `fetch` 直连反而会被 403（浏览器必带 Origin）。

4. **进程树管理比 GUI 现有方案更稳**（`E:\AI\Strata\serve\winjob.py:1-8`）：Strata server 自己把 `strata.exe`、`strata-vision.exe`、MCP 子进程放进 Windows Job Object（`KILL_ON_JOB_CLOSE`，`winjob.py:41,54`）。
   → GUI 只需杀掉 `python.exe`，引擎级联自动死亡。`src-tauri/src/router.rs` 的 `force_kill_tree` 逻辑对 Strata 只需针对单进程。

**与 kvmem 方案的关系**：两份方案结构同构（都是「第二运行时通道」），实现层可共用。建议先落 Strata（本机已装、可立即验证），kvmem 复用同一套通道骨架。

---

## 1. 两边能力对照（实测）

| 维度 | GUI 现有（llama.cpp router mode） | Strata（本机 0.1.40.3 实测） |
|---|---|---|
| 进程模型 | 1 个 `llama-server.exe` + N 个子实例 | `python.exe serve/server.py` + **1 个常驻 `engine\strata.exe`**（stdin/stdout 通信，`server.py:18-19`） |
| 二进制 | `llama-server.exe` | `engine\strata.exe` 159 MB + `engine\strata-vision.exe` 108 MB |
| 模型来源 | `presets.ini` 多段 | **一份 JSON config = 一个模型**（`strata-swift-iq3_xxs.json`） |
| 模型列表 | N 个模型 | `/v1/models` 返回 **1 个** + `aliases` 别名各列一条（`server.py:4320-4322`） |
| 并发 | `--parallel N` 多 slot | **单序列 FIFO**（`server.py:7` "One sequence at a time behind a FIFO"）；`--batch` 时 `/slots` 才多条目（`server.py:4336-4341`） |
| 加载/卸载 | `POST /models/load` `/models/unload` | `POST /load` `/unload`（`server.py:4378-4392`）+ `POST /v1/load` `/v1/unload`（`server.py:4401-4423`，busy 时 409/`ModelBusy`） |
| 显存协调 | 原生 `--fit`（GUI 默认不传 GPU 参数） | **`POST /v1/vram {"reserve_mib": N}`** 运行时让出/取回显存（`server.py:4425`，issue #533）+ `--before-load <cmd>`（`server.py:5364`，加载前先跑一条命令，用于卸载别的程序） |
| 空闲卸载 | `--sleep-idle-seconds` + `src-tauri/src/idle.rs` 轮询 | `--idle-unload SECONDS`（`server.py:5357`）/ config `idle_unload_s`（`runconfig.py:32`）；卸载后 `/v1/models` 里 `status.value="unloaded"`，注释明说 *"like llama-server's router: listed, loads on use"*（`server.py:4317-4318`） |
| 状态端点 | `/models` `/props` `/models/sse` | `/health`（**无鉴权**，`server.py:4292-4295`）、`/status`（鉴权，含 `tokens_per_s`/`tokens_per_s_mean`/`elapsed_s`，`server.py:4296-4309`）、`/props`、`/slots`、`/v1/status`、`/metrics`（**Prometheus 文本，vLLM 命名**，`serve/prometheus.py`）、`/api/requests`（需 `--api-monitor`） |
| 推理端点 | `/v1/chat/completions` `/v1/responses` | 同 + **`/v1/messages`（Anthropic 兼容）** + `/v1/messages/count_tokens` |
| 鉴权 | `--api-key` 后除 `/health` 全鉴权，只认请求头 | `--api-key` **只保护 `/v1/*`**（`server.py:5349`），`Authorization: Bearer` 或 `x-api-key`（`server.py:4206-4207`）；非 `/v1` 端点靠 **Origin 防护**（`_own_page`） |
| CORS | 同源（WebUI 内置） | 默认**关闭**，需 config `cors_origins` 且仅对 `/v1/*` 生效（`server.py:4159-4177`）；控制端点白名单是 config `trusted_origins`（`server.py:4559-4608`） |
| 自带 WebUI | 有（router 版可切模型） | 有：`GET /` → `serve/web/index.html` 聊天页，`GET /api-monitor` → `monitor.html`（`server.py:4285-4291`） |
| 日志 | 子进程 stdout，行首 `[端口]` 前缀 | **写文件** `E:\AI\Strata\strata-<model>.log`（本机已 151 KB）+ server stdout |
| 安装 | 下载 release zip 解压 | `START-HERE.bat` → `setup.py`：**长跑 1 小时+、可续传、模型 70–120 GB**（`docs/AI_SETUP.md`） |
| 平台 | Win / Linux / macOS | Win / Linux；后端 `--backend cuda\|hip\|sycl`（`setup.py:4548`）；本机引擎 CUDA 13.0，archs 75/86/89/120（`engine\BUILD.json`） |
| 路径约束 | 非 ASCII 走 `winfix` mklink /J | 本机安装路径 `E:\AI\Strata` 全 ASCII；config 内路径也是绝对 ASCII |

**本机 config 实测内容**（`E:\AI\Strata\strata-swift-iq3_xxs.json`，62 行）关键字段：

```json
{ "exe": "E:\\AI\\Strata\\engine\\strata.exe",
  "args": ["--pack","E:\\AI\\Strata-data\\packs\\swift-iq3_xxs",
           "--native","...Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf",
           "--ple-gguf","<同上>", "--expert-profile","E:\\AI\\Strata\\data\\expert-profile.bin",
           "--expert-cache","auto", "--prefill","auto", "--spec","4",
           "--mtp","E:\\AI\\Strata-data\\mtp\\rt", "--max-context","131072",
           "--kv","k8v4", "--kv-resident","20480", "--prompt-cache","24",
           "--prompt-cache-tail", "--vision", "--vram-reserve-mib","0",
           "--pcie-frac","0.20", "--spec-min-p","0.70",
           "--expert-profile-save","...expert-profile-learned.bin",
           "--expert-profile-save-every","5"],
  "cwd": "E:\\AI\\Strata",
  "tokenizer": "E:\\AI\\Strata-data\\packs\\swift-iq3_xxs\\tokenizer",
  "model_name": "swift-1.5-iq3_xxs",
  "log": "E:\\AI\\Strata\\strata-swift-iq3_xxs.log",
  "lib_dirs": ["E:\\AI\\Strata\\.venv\\Lib\\site-packages\\nvidia\\cu13\\bin\\x86_64"],
  "port": 9090, "gpu": 0, "gpus_asked": true,
  "host": "127.0.0.1", "api_key": "sk-1234567809!QAZ",
  "vision": { "exe": "...strata-vision.exe", "mmproj": "...mmproj-Swift-Qwen3.8-Flash-Next-BF16.gguf",
              "model": "<同上 gguf>", "gpu": false, "max_tokens": 768 },
  "fit_max_tokens": true, "open_browser": false }
```

注意 `model_name` = `swift-1.5-iq3_xxs` —— **驱动本次 DSH 会话的模型就是这台 Strata**（端口 9090，key 见上）。用户 m00158 说的「当前模型只支持单路并发」正是 `server.py:7` 的单序列 FIFO。

---

## 2. 三条路线与取舍

| 路线 | 做法 | 评价 |
|---|---|---|
| **A 独立通道**（推荐） | Strata 作为第二类运行时：GUI 负责**检测安装 → 启停进程 → 读状态 → 打开聊天页 → 协调显存**，安装/下载留给 Strata 自己的 `START-HERE.bat` | 侵入最小，router 零改动；`http.rs` 与 `bench.rs` 零改动复用；本机已装可当天验证 |
| B 并入模型列表 | Strata 模型与 router 模型在同一列表并列，共用 `presets.ini` 与 `/models/load` | **否决**。Strata 的 `/v1/models` 只列 1 个模型（`server.py:4310-4323`），换模型要换 config 文件并重启进程；`presets.ini` 段名语义与 Strata config 完全不同；且 `models.rs::RETIRED_PRESET_KEYS` 校验（AGENTS.md 铁律⑤）不容纳外来键 |
| C GUI 接管安装 | GUI 里跑 `setup.py`，做安装向导 | **否决**。`setup.py` 328 KB、41 个 CLI 参数、交互式问答、1 小时+ 长跑、70–120 GB 下载、可续传语义（重跑同一命令接断点）与 GUI 的 start/stop 模型完全不匹配；`docs/AI_SETUP.md` 明确「静默期间不要 kill」。GUI 应只做「检测到未安装 → 引导用户跑 `START-HERE.bat`」 |

**选 A。**

---

## 3. 目标形态

侧栏 `TABS`（`src/App.tsx:141`）新增一项 `strata`；`sidebar-footer` 的运行时胶囊（`src/App.tsx:178`）从「单 router 开关」扩成**运行时切换器**：

```
[ router 运行中 · :8080 ]   ← 现有
[ strata 运行中 · :9090 · swift-1.5-iq3_xxs ]  ← 新增
```

两者**互斥启动**（显存争用），切换时提示并自动 `/unload` 对方。

Strata 页内容：
- **模型选择器**：扫 `<root>\strata-*.json` 列出已安装模型卡片（规则见 §8.2），选一个启动；换模型 = 停旧起新
- 实例卡：引擎版本（运行时 `/props.build_info`）、模型名、端口、PID、`/health` 状态、`loaded` 状态
- 启停按钮 + **内嵌 Strata 聊天页**（iframe，见 §9）+「在浏览器打开」兜底（`open_local_url` → `http://127.0.0.1:<port>/`）
- **参数在 GUI 里编辑**（L1 常用表单 + L2 原始 JSON 兜底，见 §8.6）+「打开 Strata 设置页」引导按钮
- 实时指标：`/status` 轮询 `tokens_per_s` / `tokens_per_s_mean` / `elapsed_s`；`/slots` 显示 `n_prompt_tokens / n_ctx` 上下文占用
- 日志面板：tail `strata-<model>.log` + 捕获 server stdout
- 显存条：`vram_reserve_mib` 当前值 + 一键让出（`POST /v1/vram`）
- 升级入口：「升级 Strata」（先停实例再打开 `UPDATE.bat`，见 §7 R7）+「回滚引擎」（见 §7 R8）

---

## 4. 具体改动点

### P0 — 跑通启停与聊天（6 处）

1. **`src-tauri/src/settings.rs`** 新增（对齐 `Settings:146` 现有字段风格，并在 `SettingsPatch:213` 加对应 `Option`）：
   ```rust
   #[derive(Default, Serialize, Deserialize, Clone)]
   pub struct StrataConfig {
       pub enabled: bool,
       pub root: String,          // E:\AI\Strata
       pub config_path: String,   // E:\AI\Strata\strata-swift-iq3_xxs.json
       pub port: u16,             // 9090
       pub api_key: String,
       pub open_chat: bool,
   }
   ```
   `Settings:146` 加字段 `pub strata: StrataConfig`。

2. **新建 `src-tauri/src/strata.rs`**：
   - `build_strata_args(cfg) -> Vec<String>`：
     `["serve/server.py", "--engine", "strata", "--config", <config_path>, "--port", <port>]`
     program = `<root>\.venv\Scripts\python.exe`，`current_dir` = `<root>`。
     **不传 `--open`**（GUI 自己用 `open_local_url` 开，避免弹系统浏览器）。
     **不传 `--api-key`**：key 在 config 里（本机 config 第 52 行），命令行传会覆盖且落进日志。
   - `spawn_strata(app, hub, cfg)`：照搬 `src-tauri/src/router.rs:223 spawn_router` 的五个要点 ——
     ① `winfix::port_in_use` → `find_free_port`，**把顺延后的端口传给 args**（`router.rs:151` 注释里的早期 bug：读 settings 导致命令行绑旧端口）；
     ② `winfix::hide_console`；
     ③ **先接 stdout/stderr 再等端口**（`router.rs:293` 注释：Windows 匿名管道约 4 KB，顺序错则子进程阻塞在 write、永不监听）；
     ④ 20 s deadline 轮询 `TcpStream::connect_timeout` + `child.try_wait()` 检测秒退；
     ⑤ **任何失败分支 `force_kill_tree(pid, &mut child)`**（Strata 侧有 Job Object 级联，杀 `python.exe` 即带走 `strata.exe`）。
     日志分类器：Strata 无 `[端口]` 前缀 → 直接归 `system`（`classify_log_source` 的 fallback 分支已如此处理，`router.rs:210`）。
   - `strata_health(port)`：`http::request("127.0.0.1", port, "GET", "/health", None, None, deadline)` → 解析 `{status, max_context, model, images, api_key, loaded, service}`（`server.py:4293-4295`）。`/health` 无鉴权，探测最省事。
   - `strata_load(port, key)` / `strata_unload(port, key)`：`POST /load` / `POST /unload`，body `{}`。`/unload` busy 返回 409（`server.py:4384`），GUI 侧要当「稍后重试」不是错误。
   - `strata_vram(port, key, reserve_mib)`：`POST /v1/vram {"reserve_mib": N}`（`server.py:4425`）。
   - `tail_strata_log(path, app, hub)`：`tokio::fs` + 偏移增量读，推 `system` 通道。

3. **`src-tauri/src/lib.rs`** 加 `mod strata;` + 命令 `strata_status` / `strata_start` / `strata_stop` / `strata_scan_configs` / `strata_pick_config` / `strata_load` / `strata_unload` / `strata_vram` / `strata_read_config` / `strata_write_config`。

4. **`src/ipc.ts`** 同步上述命令签名（AGENTS.md 要求）。

5. **新建 `src/api/strata.ts`**：`health(port)`、`status(port, key)`、`props(port, key)`、`slots(port, key)`、`models(port, key)`、`configGet/configPost(port, key)`、`metrics(port, key)`。
   **关键约束**：`/status` `/props` `/slots` `/load` `/unload` `/config` 必须**经 Rust 侧代发**（浏览器 `fetch` 带 Origin → `_foreign_origin()` 判 foreign → 403，`server.py:4558-4561`）。只有 `/health` 与 `/v1/*` 可前端直连（`/v1/*` 还需 config `cors_origins` 放行）。
   → 前端一律走 `ipc` 命令，`src/api/strata.ts` 内部调 `invoke`，**不发 fetch**。这样也顺带解决 `api_key` 落前端的问题。

6. **新建 `src/components/StrataPanel.tsx`** + `src/App.tsx` 接入（`TABS` 加项 `:141`，footer 胶囊扩成切换器 `:178`）。
   遵守 AGENTS.md 铁律⑦：组件文件只导出组件，工具函数进 `src/utils/strata.ts`。

### P1 — 参数、显存协调、压测

7. **显存互斥（最重要）**：
   - 启动 Strata 前：若 router 在跑，先 `POST /unload`（router 侧走 `src/api/router.ts` 的 `unloadModel`），并在 UI 提示「Strata 需要独占显存」。
   - 启动 router 前：若 Strata 在跑，调 `strata_unload`（`POST /unload`），busy 时 409 → 提示「有请求在跑，先停当前对话」。
   - 长期共存：把 Strata 的 `vram_reserve_mib` 从本机 `0` 调到与 router 需求匹配的值（`POST /v1/vram`，运行时生效；持久化走 `POST /config` 的 `vram_reserve_mib`，`runconfig.py:37-38`，**下次启动才生效**，`runconfig.py:7-8` 明说）。
   - 更彻底的方案：给 Strata config 加 `before_load`（`server.py:5364` `--before-load`，"a command run before the model is loaded again (e.g. to unload another ...)"）—— 上游就是为这个场景设计的。

8. **参数：在 GUI 里编辑**（用户 m00455 反转了 m00321 的只读结论：「我现在是直接修改模型的 json 文件改参数…感觉不太方便，还是在 gui 直接改比较方便」）。**完整设计见 §8.6**，要点：
   - 展示：`GET /config` 的 15 项白名单（`runconfig.py:19-39`）+ config 的 `args` 数组 + `settings_summary` 风格一行摘要（上游 `setup.py:3915-3937` #564：引擎选项一行、路径略去、末尾 `server host:port, api key set`）。GUI 照抄这个摘要格式。
   - 编辑：**L1 常用参数表单**（12–16 项，复用 `ParamForm`，它已支持 `schema` prop）+ **L2 原始 JSON textarea** 兜底。取值域从 `engine\strata.exe --help`（实测 225 行）解析，**GUI 不硬编码参数表**。
   - 写回：直接写 config 文件（**不调 `POST /config`**，除 `vram_reserve_mib` 外上游白名单不含引擎参数），必须满足 §8.6 的 W1–W8（只改已存在的 flag、保留未知键、自动 `.bak`、原子写、写前校验、路径类参数只读、运行中改动提示需重启）。
   - `vram_reserve-mib` 例外：运行时用 `POST /v1/vram`（即时），持久化走 `POST /config {"set":{"vram_reserve_mib":N}}`（上游白名单内，`runconfig.py:37-38`，自动 `.bak`）—— 这是上游官方通道，优先用它而不是 GUI 写文件。
   - 表单旁必须显示**运行时生效值**（`/health.max_context`），并在 `config 值 != 运行值` 时高亮「需重启生效」：本机实测改 `--max-context 204800` 后未重启时 `/health` 仍报 `131072`，重启后三处（`/health`、`/props.n_ctx`、`/slots.n_ctx`）一致为 `204800`。

9. **压测复用**：`src-tauri/src/bench.rs:136` 打的是 `POST /v1/chat/completions`，Strata 有该端点 → 零改动复用。注意 `server.py:14` 的硬约束：*"Requests whose prompt plus max tokens exceed the engine's context are REJECTED with 400, never truncated."* 压测脚本要按 `/health.max_context` 生成 prompt，否则 400。本机 config `fit_max_tokens: true` 已把「超上下文」从 400 改成自动缩短（`runconfig.py:26`）。

10. **空闲卸载联动**：读 config `idle_unload_s`，GUI 显示「N 秒无请求后卸载」；`/v1/models` 里 `status.value=="unloaded"` 时卡片显示「已卸载，用时自动加载」（`server.py:4317-4318`）。**不要**把 Strata 纳入 `src-tauri/src/idle.rs`（那是 router 专用轮询）。

11. **监控面板**：`GET /metrics` 带 `Accept: text/plain` 走 Prometheus 文本（vLLM 命名，`serve/prometheus.py`）；不带则返回 JSON（最近 12 请求，`?requests=all` 全量，`server.py:4248-4262`）。GUI 用 JSON 分支即可。`/api/requests` 需启动带 `--api-monitor`。

### P2 — 打磨

12. **引擎版本徽标**：读 `E:\AI\Strata\engine\BUILD.json` → `{version, source, archs, ptx, cuda, vision, portable}`（本机 `0.1.40.3` / `cuda 13.0` / `archs [75,86,89,120]`）。
13. **更新跟踪**：`UPDATE.bat`（3812 B）/ `update.sh`；GUI 只提示「有新版本」+ 一键打开更新脚本，不代跑。
14. **移植 `no_throttle` 到 `src-tauri/src/winfix.rs`**（**建议对所有子进程生效，不只 Strata**）：
    `E:\AI\Strata\serve\winjob.py:67-75` 的 `SetProcessInformation(ProcessPowerThrottling)`。上游实测（issue #691，i9-13980HX）：Windows 11 把控制台窗口最小化的进程当后台工作、在 hybrid CPU 上迁到 E-core，**生成速度掉约 20%**（36.6 → 43.2 tok/s）。
    本仓库 `src-tauri/src/winfix.rs:163 hide_console` 正是让窗口不出现 → **GUI 启动的所有子进程都在这个风险里，现在 `winfix.rs` 里没有对应实现**（实测 grep 只有 `sanitize_component:19`、`ascii_link_name:34`、`ensure_ascii_dir:49`、`hide_console:163`、`port_in_use:174`、`find_free_port:178`）。这是一条独立于整合的既有改进。
15. **多 config 切换器**：扫 `<root>\strata-*.json`（排除 `.bak`），下拉选择启动哪个。本机现有 1 个 pack（`E:\AI\Strata-data\packs\swift-iq3_xxs`）。
16. **未安装引导**：`<root>\.venv\Scripts\python.exe` 不存在 → 面板显示「请先运行 `START-HERE.bat`」+ 一键打开所在目录。

---

## 5. 风险清单

| # | 风险 | 依据 | 应对 |
|---|---|---|---|
| 1 | **单路并发**：Strata 是单序列 FIFO，GUI「多模型并行」心智不适用 | `server.py:7` | UI 明确标注「单请求串行」；排队时 `/status` 有 `queued`；`/v1/load` busy 抛 `ModelBusy`（`server.py:4410-4417`） |
| 2 | 端口冲突：Strata 默认 8080（新装）/ 8095（`server.py:5339`），本机 9090；GUI router 默认端口需避让 | 本机 config `port: 9090` | 启动前 `port_in_use` 顺延；GUI 设置页把两个端口分开展示 |
| 3 | **鉴权语义与 router 不同**：Strata 的 `api_key` 只保护 `/v1/*`，非 `/v1` 端点靠 Origin 防护 | `server.py:5349`、`4601-4608` | 前端**不发 fetch**，全部经 Rust 侧（见 §4 第 5 条） |
| 4 | 控制端点要求 `Content-Type: application/json` + 非 foreign Origin | `server.py:4552-4562` | `http.rs:32` 已满足；若将来要前端直连，需往 config 加 `trusted_origins`（`server.py:5478`，精确匹配、不支持 `*`） |
| 5 | 安装不可自动化：1 小时+、70–120 GB、交互式、可续传 | `docs/AI_SETUP.md` | GUI 不接管安装（路线 C 否决） |
| 6 | 引擎 CUDA 版本敏感：上游 issue #892（open，2026-10-05）Linux + RTX 50 sm_120 用 CUDA 13.2 编译的引擎输出乱码（IQ1_S/IQ2_S/IQ3_S miscompile），CUDA 13.0 正常 | 本机 `BUILD.json` 是 **CUDA 13.0** | GUI 展示 `BUILD.json.cuda`；升级引擎前提示该 issue |
| 7 | 上游迭代极快、388 open issues；README 性能表基于引擎 0.1.26/0.1.36，本机已 0.1.40.3 | GitHub API + `BUILD.json` | GUI 只做「版本展示 + 更新提示」，不锁版本行为 |
| 8 | 显存争用：本机 config `vram-reserve-mib 0`（全占），与 router 共存必冲突 | 本机 config 第 30-31 行 | §4 第 7 条的互斥 + `/v1/vram` |
| 9 | 日志是文件不是 stdout（本机已 151 KB），且 server 会写大量启动噪声 | 本机 `strata-swift-iq3_xxs.log` | tail 增量读 + 只推新增字节；GUI 日志面板加「打开日志文件」 |
| 10 | `.venv` 缺失 / Python 版本不符（需 3.10+ 64-bit） | `START-HERE.bat:47-51` | 启动前检查 `.venv\Scripts\python.exe` 存在，缺失给引导而非直接报错 |
| 11 | EcoQoS 性能陷阱：`hide_console` 让进程被判后台 | `winjob.py:67-75`（#691 实测 -20%） | §4 第 14 条移植 `no_throttle` |
| 12 | 磁盘占用：模型 70–120 GB 在 `E:\AI\Strata-data` | `docs/AI_SETUP.md` | 面板显示数据目录占用 |
| 13 | `/config` 改动**下次启动才生效** | `runconfig.py:7-8` | UI 标注「重启 Strata 后生效」；`vram_reserve_mib` 走 `/v1/vram` 即时生效 |
| 14 | 本机 config 里 `api_key` 明文（第 52 行） | 本机实测 | GUI 侧沿用 `redact_args`（`router.rs`）脱敏；日志与前端不回显 key |
| 15 | Strata 与 router 都占 8080 系端口时，`open_local_url` 打开的聊天页可能连错服务 | 默认端口重叠 | 状态胶囊上明确显示端口；打开前用 `/health` 的 `service: "strata"` 字段确认（`server.py:4295`） |

---

## 6. 明确不做

- **不在 GUI 里跑 `setup.py` 安装/下载**（路线 C 否决，理由见 §2）。
- **不改 Strata 源码**。它是独立上游（388 open issues、引擎 0.1.40.3 迭代飞快），GUI 只消费公开接口。
- **不把 Strata 模型写进 `presets.ini`**（AGENTS.md 铁律⑤：`models.rs::RETIRED_PRESET_KEYS` 校验不容纳外来键）。
- **不给 Strata 造多模型 router**。它一个 config 一个常驻模型，多模型 = 多份 config + 重启。
- **不接管 Strata 的 WebUI**：`GET /` 是它自己的聊天页，GUI 用 `open_local_url` 打开即可（与铁律①「不给 router 传 `--no-ui`」同理）。
- **不把 Strata 纳入 `src-tauri/src/idle.rs`** 的 router 空闲回收（Strata 有自己的 `idle_unload_s`）。
- **不传 `--api-key` 到命令行**（config 已有，命令行传会落进日志）。
- ~~不在 GUI 编辑 Strata 的启动参数~~ —— **已由用户 m00455 撤销**（「我现在是直接修改模型的 json 文件改参数…感觉不太方便，还是在 gui 直接改比较方便」）。改为 GUI 内编辑，边界见 §8.6。
- **不编辑安装事实类字段**：config 顶层的 `exe`/`cwd`/`tokenizer`/`lib_dirs`/`log`，以及 `args` 里的路径类参数（`--pack`/`--native`/`--ple-gguf`/`--mtp`/`--expert-profile*`）一律只读。这些由 `setup.py` 按安装布局生成，GUI 改了会与安装状态打架，升级时也会被 `upgrade_config` 覆盖。
- **不写上游不认识的自定义键**（§8.6 W1/W2）：GUI 写进去的东西必须能被 `upgrade_config` 认得，否则升级时打架。
- **不在运行中自动重启来应用参数**（§8.6 W6）：引擎参数全是加载期参数，自动重启会打断正在跑的会话。
- **不给 Strata 实现多模型并行常驻**（单序列 FIFO + 单 config 常驻 + 显存不允许）。GUI 的「多模型」是**选择一份 config 去启动**，见 §8。

---

## 7. 升级解耦（Strata 单独升级，GUI 零改动）

> 用户 m00285 追加的硬约束：**Strata 能自己升级，GUI 不跟着改。**
> 本节所有依据来自本机 `E:\AI\Strata\UPDATE.bat` 与 `setup.py` 实测。

### 7.1 上游的升级机制（实测）

| 机制 | 位置 | 事实 |
|---|---|---|
| `UPDATE.bat` | `UPDATE.bat:2-5` | = `git pull --ff-only`（若是 git clone）+ `START-HERE.bat --update`；**不碰模型文件**，不启动模型 |
| 非 git 拷贝的升级 | `UPDATE.bat:70-74` | 下载 `main.zip` **解压到任意新目录**，`START-HERE.bat` 会「finds the model files in Strata-data and sets itself up the same way - nothing big is downloaded again」→ **代码目录可整体换新，数据在 `Strata-data` 独立存活** |
| `setup.py --update` | `setup.py:3886-3912`（#475） | 装 Python 包 + 需要时换引擎（比 `MIN_ENGINE`）+ **逐份 config 跑 `upgrade_config` 迁移** + 刷新 draft 子集；不问任何问题 |
| 引擎原子替换 | `setup.py:2641-2668 install_unpacked`（#670） | 旧引擎整体移到 `engine\.previous`（约 **210 MiB**）；中途失败**整体回滚**，不留新旧混合 |
| 引擎回滚 | `setup.py:2671-2692 rollback_engine` | `setup.py --rollback-engine`：`.previous` 变回当前引擎，被替换的那个留在原位（**再跑一次即回到新版**） |
| 运行中不替换 | `setup.py:2788-2790 update_installed_engine` | 明说：无网 / **模型还在跑** / 无对应预编译 → 保留已装引擎照旧启动 |
| 最低引擎版本 | `setup.py:194 MIN_ENGINE = (0, 1, 40, 2)` | 本机引擎 `0.1.40.3` 满足；该常量带完整版本变更史（issue 号对应特性） |
| 历史重写坑 | `UPDATE.bat:21-25`（#1276） | 仓库历史于 **2026-10-06** 清理，之前的 clone 与 `origin/main` **无共同 commit**，`git pull` 必失败，需 `git checkout -B main origin/main` |

### 7.2 GUI 侧的十条解耦规则

**R1 启动命令从 `run-<model>.bat` 读，不自己拼。**
`setup.py:4373-4386 write_run_script` 是启动命令的**权威生成者**，格式：
`<python> <root>\serve\server.py --engine strata --config <json> --port <port> [--open]`
GUI 解析该脚本（跳过 `@echo off` / `title` / `cd /d` / `if errorlevel 1 pause`，取命令行），**剔除 `--open`**。
→ 上游改参数、加参数、换入口，GUI 自动跟随。脚本缺失时才退回 §4 第 2 条的默认拼法。
本机对应文件：`E:\AI\Strata\run-swift-iq3_xxs.bat`（258 B，第 4 行即命令）。

**R2 路径全部运行时从 config 读，零硬编码。**
引擎路径读 config 的 `exe`，视觉引擎读 `vision.exe`，日志读 `log`，端口读 `port`，模型名读 `model_name`，CUDA DLL 目录读 `lib_dirs`。GUI 设置里**只存 `root`**（+ 可选 `config_path`），不存任何子路径 —— 因为升级可能整体换到新目录（`UPDATE.bat:72-73`）。

**R3 版本从运行时端点读，不读文件、不缓存。**
`/props` 返回 `build_info: "Strata <version>"`（`server.py:4512-4514`）；`/metrics` 返回 `engine.version`（`server.py:2916`）。`engine\BUILD.json` 只用于**未运行时**的静态展示。GUI 不做版本比较、不做版本门控逻辑。

**R4 能力探测，不假设端点存在。**
上游自己就在暴露能力位：`/props` 里有 `models_autoload: hasattr(svc.engine,"restart")`（`server.py:4508`）、`is_sleeping`（`:4509`）、`total_slots`（`:4505`）、`modalities.vision`（`:4508`）。GUI 按这些位渲染控件；未知端点 404 → 隐藏对应卡片，**不报错**。

**R5 参数表单不硬编码（用户 m00455 反转了 m00321 的只读方向后，本节最重要的解耦）。**
GUI **要**编辑 Strata 参数（§8.6），但**不硬编码参数表**：表单的取值域与语义从 `engine\strata.exe --help`（实测 225 行）运行时解析生成，GUI 只固定「哪些进 L1 常用面板」这一份短名单。
→ 上游加参数、改枚举、改下限（如 `--kv-resident` 的 20480），GUI **零改动**。
代价是表单要跟随 `kind` 语义（`bool`/`int>=0`/`enum`/`names`/`sampling`/`arg`）—— 上游一改语义 GUI 就得跟。缓解：解析失败或字段缺失时**降级为 L2 原始 JSON 编辑**，不让表单崩掉。

**R6 GUI 写 `args` 必须走受控写入（原「永不写」已由 m00455 撤销）。**
`upgrade_config` 在 `start()`（`setup.py:3944`）和 `update_install()`（`:3902`）都会跑，**config 的向后兼容由上游负责**。GUI 写 `args` 的合法性边界 = **只写上游认识的 flag 名与取值域内的值，且绝不新增自定义键**（§8.6 W1/W2/W5）。满足这条，GUI 写过的 config 在 `upgrade_config` 眼里与用户手改的没有区别，不打架。
`vram_reserve_mib` 优先走上游官方通道（`setup.py:3949-3957`，#493：start 时传 `--vram-reserve-mib` 会写回 config 的 args），运行时用 `/v1/vram`，持久化用 `/config`（白名单内，`runconfig.py:37-38`，上游 `save()` 自动 `.bak`，`runconfig.py:167`）—— 上游有通道的就用上游的。

**R7 升级前 GUI 主动让路（必须实现）。**
Windows 上运行中的 exe 无法被 `shutil.move` → `install_unpacked`（`setup.py:2649-2665`）会 `OSError` 并整体回滚，升级失败。
→ GUI 的「升级」按钮语义 = **先 `strata_stop`（杀 `python.exe`，Job Object 级联带走 `strata.exe`，`winjob.py:41,54`）→ 再打开 `UPDATE.bat`**。停不下来（有请求在跑）就提示，不硬升级。
GUI **不代跑** `UPDATE.bat`（理由同 §2 路线 C：长跑、要网、要编译）。

**R8 提供回滚入口。**
读 `engine\.previous\BUILD.json` 判断有无上一代引擎（`setup.py:2631 PREVIOUS_ENGINE = ".previous"`）。有则显示「可回滚到 <版本>」+ 一键打开回滚命令 `setup.py --rollback-engine`。注意 swap 语义（`setup.py:2673`）：**再跑一次回到新版**，UI 要说清，别让用户以为回滚是单向的。

**R9 设置里不存任何会过期的东西。**
存：`root`、`config_path`、`port`、`api_key`、`open_chat`。
**不存**：引擎版本、端点清单、参数 schema、模型名、并发度、上下文上限。
探测结果**不长期缓存**（对比 `versions.rs:175` 的 `has_router_mode` + `PROBE_TTL_MS` 先例：Strata 侧进程一重启就重探，GUI 重启也重探）。

**R10 兼容性降级路径。**
GUI 认一个最小契约：`/health` 返回里有 `service: "strata"`（`server.py:4295`）即视为兼容。
契约不满足（上游改名/改结构）→ 面板降级为「仅启停 + 打开 Strata 自己的 WebUI」，**不崩、不刷红字**，把详情留给日志。
→ 这条保证最坏情况下 GUI 也只是「功能变少」，不是「坏掉」。

### 7.3 升级后 GUI 的自愈流程

```
GUI 启动/刷新 Strata 页
  ├─ 读 <root>\strata-*.json（排除 .bak）→ config 列表
  ├─ 读 run-<model>.bat → 权威启动命令
  ├─ 进程在跑？ → GET /health（无鉴权）
  │     ├─ 有 service:"strata" → 拉 /props（build_info / total_slots / is_sleeping / modalities）
  │     │                        拉 /config（15 项 schema）→ 动态渲染表单
  │     └─ 无 → 降级模式（仅启停 + 开 WebUI）
  └─ 进程没跑 → 读 engine\BUILD.json + engine\.previous\BUILD.json 做静态展示
```
**全程无版本常量、无端点假设** —— 升级后 GUI 自动适配，失败也只是少显示。

### 7.4 明确会随升级变化的东西（GUI 必须不依赖）

- `MIN_ENGINE` 与引擎版本号（`setup.py:194`，本机 0.1.40.3）
- `/config` 白名单项数与枚举取值（`runconfig.py:19-39`，15 项是当前值）
- 端点集合（`server.py:4285-4425`；上游已多次新增：`/v1/vram` #533、`/api-monitor`、Responses API #451）
- `setup.py` 的 41 个 CLI 参数（`setup.py:4455-4552`）
- `run-<model>.bat` 的具体命令行（`setup.py:4375-4376`）
- 引擎体积（本机 `strata.exe` 159 MB + `strata-vision.exe` 108 MB + `.previous` 210 MB）
- 上游 issue 状态（388 open，含 #892 CUDA 13.2 乱码）

---

## 8. 多模型选择与启动

> 用户 m00321：「以后希望 strata 可以支持多个模型，选择模型启动」。

### 8.1 现状（实测，决定了 GUI 该做什么）

- **一个 server 进程 = 一份 config = 一个模型**。`--config` 是单数参数（`server.py:5331`），无多 config 入口。
- `/v1/models` 返回 **1 个模型 + 其 aliases 各列一条**（`server.py:4310-4323`）；`aliases` 是同一模型的别名，**不是多模型**。
- `/props` 的 `models_autoload: hasattr(svc.engine,"restart")`（`server.py:4508`）—— `restart()`（`server.py:820-824`）是「**the same command**」重启同一个引擎，即卸载后重载**同一个**模型，不是切换模型。
- 上游正在往 router 语义靠：`/v1/models` 里未加载时 `status.value="unloaded"`，注释原文 *"like llama-server's router: listed, loads on use"*（`server.py:4317-4318`）。
- **结论：现阶段「多模型」= 多份 `strata-<model>.json`，GUI 选择一份去启动。GUI 要做的是「模型选择器 + 互斥启动」，不是「多模型并行」。**

### 8.2 模型列表的权威来源（GUI 照抄，零硬编码）

上游已有现成实现，GUI 在 Rust 侧复刻同一套规则即可，上游加模型 GUI 自动出现：

```python
# setup.py:3656-3659  #346
def model_config_files(folder):
    return [p for p in folder.glob("strata-*.json")
            if not p.name.endswith(".shared-settings.json")]

# setup.py:3707-3720  #549
def model_config(path):      # JSON object 且有 "exe" 且 "args" 是 list 才算模型 config
    ...

# setup.py:3723-3725
def installed_configs():
    return [p for p in sorted(model_config_files(ROOT),
                              key=lambda p: p.stat().st_mtime, reverse=True)
            if model_config(p)]
```

三条规则必须照抄：
1. `glob("strata-*.json")`；
2. **排除 `.shared-settings.json` 后缀** —— server 把 Chat 设置存在 `strata-<model>.shared-settings.json`，**匹配模式但不是 config**（#346 原文）；
3. 校验 `exe` 存在且 `args` 是 list（#549：用户自己放的 JSON、截断的 JSON 都要跳过，**不能报错**）。
排序按 `mtime` 倒序（最近用过的在前）。

### 8.3 卡片元信息：照抄 `choices_from_config`

`setup.py:3673-3695` 从 config 反解出 setup 时的选择，GUI 直接复刻这套解析，**不要自己发明解析规则**：

| 卡片字段 | 取法 |
|---|---|
| 模型名 | config 的 `model_name`（本机 `swift-1.5-iq3_xxs`），缺失则 `config_path.stem` 去 `strata-` 前缀 |
| 上下文 | `args` 里 `--max-context` 的值（本机 131072） |
| KV | `args` 里 `--kv` 的值，仅当 ∈ `int8`/`q4_0`（本机是 `k8v4`，上游这里不列 —— GUI 可放宽为原样显示） |
| 图像 | `vision` 子对象存在 → `gpu`/`cpu`，缺失 → `none` |
| 端口 / host / GPU / 层切分 | config 的 `port` / `host` / `gpu` / `layer_split` |
| CUDA 代 | `config_toolkit(cfg)` → 12 则标 CUDA 12 |
| 显存预留 | `args` 里 `--vram-reserve-mib`（本机 0） |
| 引擎版本 | 运行时 `/props.build_info`；未运行时读 `exe` 同目录 `BUILD.json` |

`args` 解析注意上游的取值约定（`setup.py:3682`）：`val(k) = a[a.index(k)+1] if k in a and a.index(k)+1 < len(a) else None`。

### 8.4 GUI 侧改动

1. **`src-tauri/src/strata.rs` 加 `scan_configs(root) -> Vec<StrataModelEntry>`**：实现 §8.2 三条规则 + §8.3 解析。返回 `{config_path, model_name, max_context, kv, vision, port, host, gpu, layer_split, cuda, vram_reserve_mib, mtime}`。
2. **命令 `strata_scan` / `strata_pick(config_path)`**：`pick` 写入 `Settings.strata.config_path`；`start` 用当前 pick 的 config。
3. **互斥启动（换模型 = 停旧起新）**：
   - 已跑 A，要启动 B → 先 `strata_unload`（busy 时 409 → 提示「有请求在跑」）→ `strata_stop` → 用 B 的 config `strata_start`。
   - 端口：两份 config 可能同端口（本机 config 里 `port: 9090`），启动前 `winfix::port_in_use` 顺延，**顺延后的端口传给 args**（`router.rs:151` 注释的早期 bug）。
4. **前端 `StrataPanel.tsx` 的模型区**：复用 `src/components/ModelListPanel.tsx` 的卡片风格（`src/components/ModelListPanel.tsx`），每张卡显示 §8.3 字段 + 「启动」「打开其页面」；当前运行实例高亮。
   遵守 AGENTS.md 铁律⑦：解析函数进 `src/utils/strata.ts`（前端侧展示格式化），组件文件只导出组件。
5. **顶部计数徽标**：`{configs.length} 个模型`，与 `RuntimePanel.tsx:39` 的 `{versions.length} 个版本` 同风格。

### 8.5 为上游原生多模型预留（关键设计）

上游一旦支持一个 server 多模型，GUI 应**只换数据源、不换 UI**。做法是加一层适配：

```
listStrataModels():
  1. 进程在跑 → GET /v1/models（鉴权，经 Rust 侧）
       条目 > 1 且 status.value 有 unloaded → 用端点数据（上游原生多模型）
  2. 否则 → strata_scan(root) 扫文件（现状）
```
判定用现成的能力位：`/props.models_autoload`（`server.py:4508`）+ `/v1/models[].status.value`（`server.py:4317-4318`）。
→ 上游加多模型那天，GUI 零改动获得多模型列表；UI、卡片、启动流程都不动。

**不做**：GUI 不实现「多模型并行常驻」（Strata 单序列 FIFO + 单 config 常驻，显存也不允许）；GUI 不给 Strata 造 router（§2 路线 B 已否决）。

### 8.6 在 GUI 里编辑启动参数（约束反转，用户 m00455）

> 用户 m00321 定的是「参数不在 GUI 改」；m00455 反转：「我现在是直接修改模型的 json 文件改参数，比如 strata-swift-iq3_xxs.json 感觉不太方便，还是在 gui 直接改比较方便」。**本节取代 §4 第 8 条与 §7 R5/R6 的只读结论。**

**痛点有实物证据**：`E:\AI\Strata\` 下躺着 `strata-swift-iq3_xxs.json.bak`、`.bak-before-save`、`.bak-kv-int8` 三份手工备份 —— 用户现在改一次参数要自己复制备份、手打 JSON、改完重启，改坏了还没有退路。**GUI 该做的正是把「备份 + 校验 + 写回 + 重启」这条链自动化。**

**参数权威来源是运行时，不是 GUI 常量**（实测）：`engine\strata.exe --help` 输出 **225 行**完整参数表，含每个参数的取值域与语义，例如：
- `--kv fp16|int8` / `--kv q4_0` / `--kv k8v4`（k8v4 = INT8 K + 旋转 Q4_0 V，816 B/cell，对比 int8 的 1056 B/cell）
- `--kv-resident N`（每层 QSA 在 VRAM 保留 N 个 cell，**下限 20480**；0 = 全进 VRAM）
- `--ple-io direct|mmap|ram`、`--ple-row-cache N`（默认 1048576）、`--ple-inflight N`（默认 256）
- `--kv-grow`、`--resident-experts`、`--adapt-async 0|1`

→ GUI 表单的取值域**从 `--help` 解析生成**，不写死在 GUI 里。上游加参数、改取值域，GUI 自动跟随（延续 §7 R1-R10 的精神，只把「不碰参数」换成「不硬编码参数」）。

**分两层，不做全量表单**：225 行参数里大半是 `experimental` / `diagnostic` / `A/B arm`（`--native-*` 十几项、`--ple-delay-us` 故障注入、`--check-logits`），全塞进表单既危险又没人用。

| 层 | 内容 | 实现 |
|---|---|---|
| **L1 常用参数表单** | 12–16 个高价值项（下表） | 复用现成的 `ParamForm` |
| **L2 原始 JSON 编辑** | 整份 config 的 textarea | 只做 JSON 校验 + 格式化，不解释语义 |

L1 建议项（本机 config 实际在用的那批）：

`--max-context` · `--kv`（枚举 fp16/int8/q4_0/k8v4）· `--kv-resident` · `--kv-grow` · `--spec` · `--spec-min-p` · `--prompt-cache` · `--prompt-cache-tail` · `--prefill` · `--expert-cache` · `--pcie-frac` · `--vram-reserve-mib` · `--ple-io` · `--ple-row-cache` · `--ple-inflight` · `--adapt-async`

顶层字段（不在 `args` 里，单独一组）：`port` · `host` · `api_key` · `open_browser` · `vision.gpu` · `vision.max_tokens`。

**复用成本几乎为零**：[src/components/ParamForm.tsx:441](src/components/ParamForm.tsx#L441) 已经是 `schema = paramSchema` 的**默认参数**，props 里有 `schema?: ParamSchema`（`:448`）与 `persistKey`（`:443`，分组折叠状态分开记）。所以只要提供一份 Strata 的 `ParamSchema`（`groups` + `params`），`<ParamForm schema={strataSchema} persistKey="strataParams" ... />` 直接就能用 —— 自绘下拉、路径选择、JSON 弹窗、说明弹窗、折叠记忆全都在。

**换算层**（新增，唯一的新逻辑）：Strata 的 `args` 是 `["--max-context","204800"]` 数组，`ParamForm` 吃的是 `Record<string, ParamState>`。需要双向换算：
- 读：`argsToState(args)` —— 按 `key = flag.slice(2)`（`ParamDef.key` 不带 `--`，见 `ParamForm.tsx:11` 的 `DEVICE_PARAMS` 与 `PATH_PARAMS` 命名）配对取值。
- 写：`stateToArgs(state, originalArgs)` —— 启用的项输出 `[flag, value]`，**未启用的项从数组里删除**（与 `paramStateToEntries` 的「空值=删除」语义一致，[src/utils/paramSchema.ts:183-208](src/utils/paramSchema.ts#L183-L208)）。
- 顺序敏感项要保序：按 `originalArgs` 里的原位置回写，新启用的追加到尾部。

**写回安全规则（必须全做，这是 GUI 接管编辑的代价）**

| # | 规则 | 理由 |
|---|---|---|
| W1 | **只改 `args` 里已存在的 flag 值，不新增/删除顶层字段** | 顶层 `exe`/`cwd`/`tokenizer`/`lib_dirs`/`log` 是 `setup.py` 生成的安装事实，GUI 改了就与安装状态打架；`upgrade_config` 也不认 GUI 的改动 |
| W2 | **读-改-写整份 JSON，未触及的键原样保留**（含未知键） | 上游以后加的字段 GUI 不认识也必须留住，否则升级后配置被 GUI 写瘦 |
| W3 | **写前自动备份** `<config>.bak-<时间戳>`，每份 config 保留最近 2 份（用户 m03283 把原定的 5 份下调） | 用户现在手工做这件事（`.bak-kv-int8` 就是证据），GUI 接管后这是底线 |
| W4 | **原子写**：写 `<config>.tmp` → `fs::rename` 替换 | 避免半截 JSON 让下次启动直接失败 |
| W5 | **写前校验**：JSON 可解析 + `exe` 存在 + `args` 是数组 + 数值项在 `--help` 声明的取值域内（`--kv-resident` 必须 ≥20480 或 0） | 上游 `model_config()`（`setup.py:3707-3720` #549）认「object 且有 `exe` 且 `args` 是 list」，不满足的 config 会被**跳过并 warn** → GUI 写坏等于把模型从列表里弄丢 |
| W6 | **运行中改参数 → 提示「需重启生效」，不自动重启** | 这些参数全是加载期参数（显存分配、KV 布局），运行时改无意义；自动重启会打断正在跑的会话 |
| W7 | **GUI 永不写 `args` 里的路径类参数**（`--pack`/`--native`/`--ple-gguf`/`--mtp`/`--expert-profile*`） | 路径由 `setup.py` 按安装布局生成，且 §7 R2 已定「路径全从 config 读」；GUI 只做只读展示 |
| W8 | `--vram-reserve-mib` 走**上游官方通道**，不走 GUI 写文件 | `setup.py:3949-3957`（#493）start 时传这个参数会**写回 config 的 args** —— 这是上游认可的持久化路径，GUI 用它是跟随上游而不是绕过 |

**生效值回显（实测确认的必备功能）**：本机曾出现 config 写 `--max-context 204800` 而 `/health` 报 `131072` 的情况，**原因是改了 config 但引擎未重启**（用户 m00539 重启后实测 `/health.max_context`、`/props.default_generation_settings.n_ctx`、`/slots[0].n_ctx` 三处一致为 `204800`）。引擎参数全是加载期参数，**config 值 ≠ 运行值**是常态而非例外。所以表单旁必须显示运行时生效值，并且当 `config 值 != 运行值` 时**高亮提示「需重启生效」** —— 这是 GUI 接管参数编辑后最有价值的一块 UI：用户改完立刻看得出有没有生效，不必自己记住「要不要重启」。

**与升级解耦的兼容**（取代 R5/R6 的表述）：
- GUI 写的是**上游认识的 flag 名和取值**，`upgrade_config` 迁移时认得它们 → 不打架。
- GUI **不写**上游不认识的自定义键（W1/W2 保证）。
- 表单取值域来自 `--help` 解析，**GUI 不硬编码参数表** → 上游改参数 GUI 零改动。
- 升级前 GUI 主动 stop（§7 R7）→ 文件不被占用，`shutil.move` 不会失败。

---

## 9. 独立 WebUI 的整合

> 用户 m00358：「Strata 有独立的 webui，可以考虑整合进来」。

### 9.1 WebUI 实测构成（`E:\AI\Strata\serve\web\`）

| 文件 | 大小 | 说明 |
|---|---|---|
| `index.html` | 15295 B | 单页，三 tab：**Chat / Monitor / About**（`:23-28`） |
| `app.js` | 59326 B | 全部逻辑，**原生 JS，无框架无构建** |
| `app.css` / `components.css` / `tokens.css` | 13322 / 10548 / 3991 B | `tokens.css` 是设计变量层 |
| `monitor.html` / `monitor.js` | 9493 / 8410 B | 独立监控页（= `server.py:4285-4291` 的 `/api-monitor`） |
| `sprite.svg` | 28544 B | 图标集 `<use href="web/sprite.svg#i-chat">` |
| `fonts/` | ~51 KB | Outfit 可变字体 woff2 |

形态要点（实测）：
- **资源与请求全是相对路径**：`href="web/tokens.css"`（`index.html:7-9`）、`fetch("health")`（`app.js:102`）→ 页面**必须从 server 根 `/` 加载**，且所有请求天然同源。
- **主题**：`localStorage["strata.theme"]`，无保存值时跟随系统 `prefers-color-scheme`（`index.html:11-17`）。
- **鉴权**：`app.js:89-97`，key 存 `localStorage["strata.apikey"]`，页面内有 `#api-key` 输入框，提示「Kept in this browser only」。
- **无 CSP、无 X-Frame-Options、无 frame-ancestors**（`server.py` 全文 grep 无匹配）→ **可被 iframe 内嵌**。

### 9.2 四条路线取舍

| 路线 | 判定 |
|---|---|
| **W1 iframe 内嵌进 GUI 页** | ✅ **推荐**。GUI 只依赖一个 URL，上游 UI 怎么改 GUI 零改动，完全符合 §7 升级解耦。 |
| **W2 Tauri 独立 WebviewWindow** | ⚪ 可选增强。体验优于 iframe（全屏、无嵌套滚动），但要管窗口生命周期；建议 W1 之后按需加。 |
| **W3 `open_local_url` 开系统浏览器** | ✅ **保留为逃生口**（§3 已有）。零开发量，iframe 出问题时兜底。 |
| **W4 移植成 React 组件** | ❌ **否决**。59 KB `app.js` + 28 KB CSS 全量重写，且要**永久跟随上游 UI 变化**，直接违反 §7 R1-R10。 |

**W1 的额外收益（重要）**：Strata 页面是**同源**请求，`_own_page` 的 Origin 检查通过 → 页面自己能调 `/load` `/unload` `/config` `/slots` `/v1/vram` 这些受保护端点。**这是 GUI 前端 fetch 永远做不到的**（§1 的 Origin 障碍）。内嵌后这些高级控制直接可用，不必全部经 Rust 侧代发。

### 9.3 W1 的四个技术前提

**① GUI 的 CSP 必须放行 frame（当前会拦，实测）**

`src-tauri/tauri.conf.json:27`：
```
default-src 'self'; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:
```
**没有 `frame-src`** → 回落到 `default-src 'self'` → iframe 加载 `http://127.0.0.1:9090` **会被 CSP 阻止**。

改法（一行）：加 `frame-src http://127.0.0.1:*`。端口会顺延（§4 第 2 条），所以必须通配；要收紧可由 GUI 启动 Strata 后按窗口动态注入带端口的 CSP。

**② iframe src 必须带尾斜杠**：`http://127.0.0.1:<port>/`。相对路径资源依赖它解析成 `/web/tokens.css`。

**③ API key 要在 GUI 内填一次**
localStorage 按 origin 隔离，GUI 无法代写 `http://127.0.0.1:9090` 那份。本机 config 有 `api_key` → 内嵌页面首次要填一次（存进 WebView2 的 localStorage；Tauri 的 user data folder 固定 → 持久，只填一次）。
更省事：**GUI 启动 Strata 时不传 `--api-key`**（§4 第 2 条已定），此时 `/v1/*` 无鉴权、页面免填；代价是本机端口裸奔，与 GUI 现有 router 不传 key 时同等，可接受。

**④ 主题同步是软限制**
GUI 切主题**无法**写 iframe 的 localStorage（跨 origin）。现状可用：`index.html:11-17` 无保存值时跟随系统主题 → GUI 主题跟系统走即自动一致。
**不要**为此加 postMessage 桥：Strata 页面不监听 `message`，要改上游，违反解耦。

### 9.4 单路并发下的会话共存（必须提示）

Strata 是**单序列 FIFO**（`server.py:7`）。内嵌后 GUI 里存在**两个聊天入口**：DSH 自己的会话 + iframe 里的 Strata 会话，两者共用同一条序列 → 互相排队。

- iframe 区域明示：「Strata 单序列，与其他会话共用同一模型，请求排队」。
- 用 `/status` 的 `busy` / `queued` 做实时提示（实测返回 `{"busy":false,"queued":0,"phase":"tool call complete","prompt_tokens":47876,"generated":344,"max_tokens":16000}`）；`queued > 0` 显示「排队中」。
- **不做会话合并**（把 Strata 会话读进 DSH 会话）：Strata 会话存在其浏览器 localStorage，GUI 拿不到，也不该拿。

### 9.5 为什么 W1 最符合升级解耦

iframe 只依赖两样东西：**一个 URL** 和 **`/health` 可达**。上游改 UI 布局、改 CSS、加 tab、换字体、重写 `app.js` 内部 —— GUI 全部零改动。唯一要跟随的是 §9.3 ① 的 CSP（配置项，不随 UI 变）。

### 9.6 GUI 改动点

1. `src-tauri/tauri.conf.json:27` 的 CSP 加 `frame-src http://127.0.0.1:*`。
2. `src/components/StrataPanel.tsx` 加聊天区：`<iframe src={"http://127.0.0.1:" + port + "/"} />`，`sandbox="allow-scripts allow-same-origin allow-forms allow-popups"`（同源与脚本必需；**不给 `allow-top-navigation`**，防它把 GUI 窗口导航走）。
3. iframe 上方一条状态条：复用 `/status` 的 `busy` / `queued` / `tokens_per_s`（§4 第 4 条），右侧「在浏览器打开」按钮走 `open_local_url`（W3 兜底）。
4. 未运行时 iframe 区域显示占位 + 「启动」按钮，不留空白。
5. 高度用 `flex:1` 撑满页面剩余空间，避免嵌套滚动条（接 `RuntimePanel.tsx` 的 `top-bar` + 内容区骨架）。

**不做**：不移植 UI（W4）；不做 postMessage 主题桥；不把 Strata 会话并入 DSH 会话；不给 iframe `allow-top-navigation`。

---

## 10. 落地顺序建议

> **完成情况（2026-10）**：下面 7 步已全部走完，逐条标了落点。第 4 步最终换了做法（见该条）。

1. **先做 §4 第 14 条（`no_throttle`）** —— 独立于整合的既有性能修复，`cargo test --lib` 可覆盖，收益对所有子进程。**✅ 已落地**：`src-tauri/src/winfix.rs:183`，由 `src-tauri/src/strata.rs:534` 调用。
2. 再做 P0 的 1–4（Rust 侧启停 + `ipc.ts`），用本机已装的 9090 实例直接验证 `strata_status`。**✅ 已落地**：`strata_status` / `strata_start` / `strata_stop` / `strata_set_root` 等命令注册在 `src-tauri/src/lib.rs` 的 `generate_handler!` 里，前端包装见 `src/ipc.ts`。
3. 然后 P0 的 5–6（前端面板），跑通「GUI 启停 Strata → 打开聊天页 → 出 token」。**✅ 已落地**：`src/components/StrataPanel.tsx`（972 行）。
4. **§9 的 WebUI 内嵌**（CSP 一行 + iframe）—— 放在面板之后做，因为它只依赖端口，且能立刻把「GUI 只能启停」升级成「GUI 里直接聊天」，是投入产出比最高的一步。**⚠️ 做法与当初设想不同：没有采用 iframe 内嵌**，最终按 §6 的结论用系统浏览器打开（`src/components/StrataPanel.tsx` 的 `onWebui={() => void ipc.openLocalUrl(webuiUrl)}`），因此 CSP 也不需要放宽。
5. §8 的模型选择器（扫 `strata-*.json` + 互斥启动）。**✅ 已落地**：`strata_scan` / `strata_pick` + 面板里的 `ConfigCard`（`src/components/StrataPanel.tsx:148`）。
6. **§8.6 的参数编辑**：先做 L2（读 config → JSON textarea → 校验 → 备份 → 原子写），它最小且立刻解决用户 m00455 的痛点；再做 L1 表单（`argsToState`/`stateToArgs` 换算层 + `ParamForm schema={strataSchema}`）。写回路径必须先有 W3 备份 + W5 校验，才允许 GUI 落盘。**✅ 已落地（L2 与 L1 都做了）**：`strata_config_read` / `strata_config_write` + `src/utils/strataParams.ts` 的 `argsToState` / `stateToArgs` + `ParamForm schema={strataParamSchema}`。
7. 最后 P1 显存互斥（第 7 条）—— 这是双运行时共存的核心，需要 router 侧配合改动，单独一个 PR。**✅ 已落地**（见 §20）。

每步验证：`npx tsc --noEmit`（根）+ `cd src-tauri; cargo test --lib`（当时的基线是 78 passed / 5 ignored；当前为 93 passed / 0 failed / 5 ignored）。GUI 运行验证必须在沙箱外（esbuild `spawn EPERM`，AGENTS.md）。

## 11. 实现进度（本轮代码落地，用户 m00552「现在开始代码开发」）

### 11.1 新增文件

| 文件 | 内容 |
| --- | --- |
| `src-tauri/src/strata.rs` | 约 600 行，含 4 个单测。扫描 / 解析 / 启停 / 探测 / 读写 config |
| `src/components/StrataPanel.tsx` | 约 400 行，只导出 `StrataPanel()` |

`strata.rs` 公开 API：

```rust
pub struct StrataModelEntry { config_path, model_name, port, host, has_api_key,
    api_key /* #[serde(skip_serializing)] */, engine, cwd, run_script, max_context,
    kv, kv_resident, vram_reserve_mib, vision, gpu, prompt_cache, spec,
    modified_ms, engine_exists }
pub struct StrataStatus { running, port, pid, config_path, model_name, started_at_ms,
    last_error, version, live_max_context, loaded, busy, prompt_tokens, max_tokens,
    models_autoload }
pub struct StrataProcess { child, port, config_path, model_name, started_at_ms, api_key }
pub fn scan_configs(root: &Path) -> Vec<StrataModelEntry>
pub fn parse_run_script(bat: &Path) -> Option<(PathBuf, Vec<String>)>
pub fn spawn_strata(app: &AppHandle, hub: Arc<LogHub>, entry: &StrataModelEntry)
    -> Result<(StrataProcess, StrataStatus), String>
pub fn stop_strata(slot: &Arc<Mutex<Option<StrataProcess>>>) -> Option<u32>
pub fn spawn_monitor(app: AppHandle, slot: Arc<Mutex<Option<StrataProcess>>>,
    status: Arc<Mutex<StrataStatus>>)   // emit "strata://status"
pub fn probe(port: u16, api_key: Option<&str>) -> StrataStatus
pub fn read_config_raw(path: &Path) -> Result<String, String>
pub fn write_config_raw(path: &Path, text: &str) -> Result<(), String>
```

单测：`config_file_filter_excludes_shared_settings`、`quote_tokens_extracts_executable_and_args`、`arg_value_follows_upstream_val_semantics`、`write_config_rejects_upstream_invisible_shapes`。

### 11.2 与 §7 规则的落地偏差（重要，后续接手者必须知道）

| 规则 | 落地情况 |
| --- | --- |
| R1 启动命令从 `run-<model>.bat` 读 | ✅ `parse_run_script` 取含 `server.py` 的行按双引号切 token，**剔除 `--open`**（GUI 内嵌 iframe，不弹浏览器）；无脚本时 `fallback_command` 用 config 的 `exe` + `args` + `--port` |
| R2 路径全从 config 读 | ✅ GUI 只存 `strata_root`，`find_strata_entry` 每次现扫现找 |
| R3 版本从运行时读 | ✅ `probe` 从 `/props.build_info` 取，不缓存 |
| R4 能力探测不假设端点存在 | ✅ 运行时字段全 `Option` |
| R5 参数表单不硬编码 | ✅ `src/utils/strataParams.ts` 的取值域摘自 `strata.exe --help`，表单以 config 的 `args` 为主体（`--vram-reserve-mib` / `--pcie-frac` 不在 `--help` 里，它们是 `serve/server.py` 层参数 —— 纯靠 `--help` 解析会漏） |
| R6 受控写入 args | ✅ L1 表单只写 `STRATA_KNOWN_FLAGS` 白名单内的 flag，**其余 token 原样保留**、保持原顺序、新启用的追加末尾；安装事实类（`--pack`/`--native`/`--ple-gguf`/`--mtp`/`--expert-profile`/`--expert-profile-save`）不进表单并在界面上只读列出。L2 原文编辑仍可用（写回前 W3 备份 + W5 上游可见性校验） |
| R7 升级前主动让路 | ❌ 未做（升级入口按钮未实现，用户自己跑 `UPDATE.bat`） |
| R8 回滚入口 | ❌ 未做（未读 `engine\.previous\BUILD.json`） |
| R10 兼容降级 | ✅ `probe` 以 `/health.service == "strata"` 为识别判据，不匹配写 `last_error` 早退 |

`spawn_strata` 相对 `spawn_router` 的三处**刻意不同**（都有理由）：

1. **不做 junction 非 ASCII 修复** —— venv 的 `pyvenv.cfg` 里 home 是绝对路径，换目录会让 venv 失效。
2. **不注入共享 CUDA 目录** —— 上游自带 CUDA（config 的 `lib_dirs`）。
3. **端口被占用直接拒绝，不顺延** —— Strata 的 config 与 WebUI 都记着这个端口，顺延后 config 与实际端口对不上。

就绪判定：只等 TCP 端口，不等模型加载（Python 启动快，模型加载在 server 内部进行，期间 `/health.loaded=false`），`READY_TIMEOUT = 90s`。任何失败分支先 `force_kill_tree`（std `Child` 析构不杀进程，句柄没进 slot 界面就再也停不掉）。

### 11.3 既有文件的改动点

- `src-tauri/src/router.rs`：`spawn_reader`（:372）、`spawn_pump`（:390）、`redact_args`（:490）改 `pub(crate)`，供 `strata.rs` 复用日志管道。
- `src-tauri/src/winfix.rs`：新增 `pub fn no_throttle(cmd: &mut Command) -> &mut Command`（`hide_console` 之后）。用 `CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB` 一次写全 —— `CommandExt::get_creation_flags` 在当前工具链未稳定（`error[E0599]`），所以不能读回现有 flags 叠加，**调用方必须在 `hide_console` 之后调用**。父 Job 未开 `BREAKAWAY_OK` 时 CreateProcess 会直接失败，`spawn_strata` 已实现「带 flag 失败 → 去掉 flag 重试」并写日志。
- `src-tauri/src/state.rs`：加 `strata_slot: Arc<Mutex<Option<StrataProcess>>>`、`strata_status: Arc<Mutex<StrataStatus>>`。
- `src-tauri/src/settings.rs`：`Settings` 加 `strata_root: Option<PathBuf>`、`strata_selected_config: Option<String>`、`auto_start_strata: bool`；`SettingsPatch` 同步；`patch()` 里空串→`None`。
- `src-tauri/src/lib.rs`：`mod strata;`（:12）；9 个命令 `strata_status / strata_scan / strata_probe / strata_start / strata_stop / strata_set_root / strata_pick / strata_config_read / strata_config_write` 注册进 `generate_handler!`（:1189 起）；`RunEvent::Exit`（:1240 起）加 `stop_strata`。`strata_start` 在 router 也在跑时**不硬禁止**，只往日志写一句共用显存警告（双卡用户可共存，GUI 无法准确判断显存够不够）。
- `src/types.ts`：加 `StrataModelEntry`、`StrataStatus`，`Settings`/`SettingsPatch` 加三个字段。
- `src/ipc.ts`：9 个签名 + `onStrataStatus`（订阅 `"strata://status"`）。Tauri 命令参数在 JS 侧用 camelCase（Rust `config_file` → `configFile`）。
- `src/store.ts`：`strataStatus`/`strataEntries` 状态 + `refreshStrata / startStrata / stopStrata / probeStrata / pickStrata / setStrataRoot / writeStrataConfig / startStrataPolling / stopStrataPolling`；`init()` 里接 `strataStatus()`、`onStrataStatus` 订阅（running 翻转时起停轮询）、`auto_start_strata` 自动启动。轮询 **5 秒**一次 `probe`（Strata 没有 router 的 `/models/sse`；5 秒是加载 20GB 模型期间既不刷屏又能看到 `loaded` 的折中）。
- `src/App.tsx`：`Tab` 加 `"strata"`，`TABS` 加 `{ id: "strata", label: "Strata", icon: "fas fa-brain" }`，渲染区加 `{tab === "strata" && <StrataPanel />}`。
- `src-tauri/tauri.conf.json:27`：CSP 加 `frame-src http://127.0.0.1:*;`（缺 `frame-src` 时 iframe 回落 `default-src 'self'` 被拦；只放行本机回环）。
- `src/components/SettingsPanel.tsx`：新增「Strata（第二运行时通道）」panel —— 安装目录 input + 浏览 + 保存、`auto_start_strata` 复选框。
- `src/utils/strataParams.ts`（新增）：Strata 自己的 `ParamSchema` + `argsToState` / `stateToArgs` / `installFactFlags` / `STRATA_KNOWN_FLAGS` / `FLAG_ONLY`。`ParamDef.key` 不带 `--`（`key = flag.slice(2)`），与 `src/components/ParamForm.tsx:11` 的 `DEVICE_PARAMS` 约定一致。

`StrataPanel.tsx` 面板组成：根目录 → 运行状态（版本 / pid / 生效上下文 vs config 值 / 加载状态 / prompt 与输出上限 / busy）→ `ctxMismatch` 高亮「已修改，需重启生效」→ router 共存显存警告 → 模型选择表（radio + 上下文/KV/端口/视觉/编辑）→ L2 参数编辑（JSON 语法闸门 + 备份说明）→ 内嵌 WebUI `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups">`（不给 `allow-top-navigation`）。

编辑面板记住 `editorFile`：编辑期间用户点了别的 radio，保存仍写回正在编辑的那份。

### 11.4 验证结果

- `npx tsc --noEmit` → 通过。
- `cd src-tauri; cargo test --lib` → **82 passed / 0 failed / 5 ignored**（基线 78 + 4 个 strata 测试）。
- `npm run build`（vite）→ 通过，需在沙箱外执行（esbuild `spawn EPERM`，AGENTS.md 已知限制；`workspace-write` 提权后同样 EPERM，必须 `danger-full-access`）。
- `npm run tauri build` → **exit 0**，`Finished release profile [optimized] target(s) in 3m 51s`；产物 `src-tauri\target\release\llamacpp-gui.exe` 与 `src-tauri\target\release\bundle\nsis\llama.cpp GUI_0.1.0_x64-setup.exe`。
- **release 便携版 GUI 启动验证**（实测）：`src-tauri\target\release\llamacpp-gui.exe` 启动后进程稳定存活，`webview\` 目录生成在 exe 同目录（证明便携模式生效，见 `src-tauri/src/paths.rs:44-67`：`looks_like_config_dir` 命中 `settings.json`/`presets` 即沿用便携目录，否则靠写探测）。首次运行**不写** `settings.json`（只有保存设置时才写），所以要在 `src-tauri\target\release\settings.json` 预置 `{"strata_root":"E:\\AI\\Strata","strata_selected_config":"strata-swift-iq3_xxs.json"}` 才会出现 Strata 侧栏胶囊（渲染条件 `settings?.strata_root`）。注意 `settings.port` 是 **router 端口**，Strata 端口从 config 的 `port` 读（R2），两者互不占用。
- **`npm run tauri dev` 在沙箱内起不来**（实测）：dev 构建 `cfg!(debug_assertions)=true` → `paths::resolve_config_dir` 走系统配置目录 `%APPDATA%\dev.llamacpp.gui`（见 `src-tauri/src/paths.rs:6-7`、`:50`），沙箱内该路径不可写 → setup hook 的 `std::fs::create_dir_all` 直接失败 → `panicked at tauri-2.11.5\src\app.rs:1425: Failed to setup app: error encountered during setup hook: 拒绝访问。 (os error 5)`。**验证 GUI 请跑 release 便携版**（`src-tauri\target\release\llamacpp-gui.exe`，配置目录 = exe 同目录，在工作区内可写）。
- **`cargo test --lib` 在提权（`danger-full-access`）下会大面积失败**（实测 24 failed）：测试用 `std::env::temp_dir()` 建临时目录，提权进程写 `C:\Users\WuChun\AppData\Local\Temp` 被拒 → `called `Result::unwrap()` on an `Err` value: 创建目录 C:\Users\WuChun\AppData\Local\Temp\llamacpp-gui-preset-io-test\presets 失败 / 拒绝访问。 (os error 5)`（`src\models.rs:2427`）。**跑测试先把 `TMP`/`TEMP` 指到工作区**：`$env:TMP=$env:TEMP="E:\Code\llama.cpp-GUI\.tmp"` → 82 passed / 0 failed / 5 ignored。
- **前端接线曾静默丢失**（实测教训）：`src/App.tsx` 的 `StrataPanel` import + tab + 渲染一度不在文件里，vite 因此把整个组件 tree-shake 掉 —— 产物 hash 与体积和「加表单之前」完全相同（`dist/assets/index-CzG6ERXe.js` 413.61 kB），界面不会有任何报错。补回接线后产物变为 `index-CV4o3U3d.js` 435.36 kB。**验证方式**：在 `dist/assets/index-*.js` 里 grep 组件独有的字符串（`kv-resident`、`写回 config`、`生效上下文`），命中才算进包；产物 hash 不变＝前端代码没进去。

### 11.5 尚未实现（下一步）

1. **R7 升级入口 / R8 回滚入口**（读 `engine\.previous\BUILD.json`，UI 要说清 swap 语义）。
2. **P1 显存互斥的 router 侧配合**（§4 第 7 条）—— 目前只有提示，没有真正的互斥。
3. **压测复用**：`src-tauri/src/bench.rs` 目前只打 router。
4. **运行验证**：GUI 起来后实测「GUI 启停 Strata → 内嵌 WebUI 聊天 → 出 token」，以及 config 改动后重启的「需重启生效」提示、L1 表单写回后 `args` 顺序与安装事实类未被破坏。
5. **（非 Strata 的遗留项）`llama_cuda_dir` / `llama_device_map` 未实现**：`src-tauri/src/settings.rs` 里没有这两个字段，前端 `Settings` 类型也没有，因此设置页无法显式指定共享 CUDA 目录与「设备=目录」映射。现状由 `src-tauri/src/versions.rs:85 find_shared_cuda_dirs` 自动匹配同级 `cudart-*-cuda-<X.Y>-*` 目录 + `:160 compose_path_env` 注入 PATH（`router.rs:262`、`gpu.rs:107`/`:341` 使用），设置项只有 `shared_lib_dirs`。要做的话需要：Rust 侧加字段 + 前端类型 + 设置页控件三处一起补。

## 12. 界面改造（用户 m01301，本轮）

需求原文拆成 5 条：设置页 ①Strata 安装目录移进「目录」分组 ②取消「打开程序就自动启动 Strata」 ③「服务」分组加 Strata 的 host / 端口 / api key + 单独保存按钮；Strata 页 ④取消安装目录分组 ⑤整页照搬模型列表页布局（含参数配置，顶栏用 config 替代 preset）。追加：⑥顶栏的 config 按钮取消（m01510）。

### 12.1 设置页（`src/components/SettingsPanel.tsx`）

- 「目录」分组末尾新增「Strata 安装目录」form-group（input + 浏览 + 保存 `setStrataRoot`），文案强调「GUI 只记这一个路径，其余全部从 `strata-*.json` 与 `run-<模型>.bat` 现读」。
- 原「Strata（第二运行时通道）」整个 panel 删除，连带 `auto_start_strata` 勾选。`src-tauri/src/settings.rs` 里的 `auto_start_strata` 字段**保留**以兼容旧 `settings.json`（注释已标注界面不再暴露）。
- 「服务」分组末尾新增「Strata 服务（填了才写，留空的项保留各 config 原值）」form-group：监听地址 / 端口 / API Key + 独立按钮「写入所有 config」（`saveStrataService()`，见 §12.2）。

### 12.2 host / 端口 / api key 的实现方式（用户 m01623 定稿：直接写 json）

> 首版实现是「在启动命令末尾追加 `--host/--port/--api-key`」（依据 argparse 重复 flag 取最后一个）。
> 用户否决：「服务项的实现方式就是直接改 json 文件，而且是修改所有 strata 模型的 json 文件」。
> 现方案 = 保存时把填了的项写进**每个 `strata-*.json` 的顶层字段**，GUI 侧不追加任何命令行参数。

- 写入目标：config **顶层** `host` / `port` / `api_key`（实测 `E:\AI\Strata\strata-swift-iq3_xxs.json`：`port` 在 :48、`gpu` :49、`gpus_asked` :50、`host` :51、`api_key` :52、`vision` 子对象 :53-59、`open_browser` :60）。**不碰 `args`** → 不违反 R6；启动命令仍逐字照上游 `run-<model>.bat` → 保持 R1。
- 序列化格式必须与上游一致：上游用 `json.dumps(cfg, indent=1)`（`E:\AI\Strata\setup.py:3527`，shared-settings 同 `:3375`）→ 前端写回用 `JSON.stringify(cfg, null, 1)`。Rust 的 `serde_json::to_string_pretty` 是 2 空格，**不能用**，所以写回路径放在前端（走已有的 `strata_config_write`）。
- 两项用户决策：① 端口**全部写同一个值**（一次只跑一个模型，无冲突；以后要并行需自行分端口，UI 已写明）；② **留空的项跳过**，保留各 config 原值 —— 三项全空时直接报错不写。
- `src/components/SettingsPanel.tsx` 的 `saveStrataService()`：ASCII 校验 key → `ipc.strataScan()` 枚举全部 config → 逐个 `strataConfigRead` + `JSON.parse` → 只改填了值的顶层字段 → `writeStrataConfig(file, JSON.stringify(cfg, null, 1))` → 汇总成功/失败 → 有写入才把值记进 settings（仅供灌值）。按钮文案「写入所有 config」，`strataSaving` 期间转圈。
- `src-tauri/src/settings.rs` 的 `strata_host` / `strata_port` / `strata_api_key` 三字段**降级为灌值缓存**（注释已改），不再是启动参数来源；`src-tauri/src/strata.rs` 的 `StrataOverrides` 与追加 flag 块**已删除**，`spawn_strata` 回到三参数签名，host/port/api_key 一律取 `entry`（即 config）。`probe_addr(host, port)` 保留（`0.0.0.0`/`::`/`*`/`localhost`/空 → 按 `127.0.0.1` 连）。
- `src-tauri/src/lib.rs`：`strata_probe` 在 slot 为空（GUI 外启动的实例）时用「选中 config 的 `port` + `api_key`」兜底探测，不再直接返回快照。

### 12.3 Strata 页重写（`src/components/StrataPanel.tsx`，596 → 约 700 行）

布局与模型列表页一一对应（样式全部复用 hub 的 `#loadModelModal` / `.model-item` / `.grid-view`）：

| 模型列表页 | Strata 页 |
| --- | --- |
| preset 段 | `strata-*.json` |
| `ModelCard` | `ConfigCard`（星标=选中 config；徽标 运行中/引擎缺失/KV 常驻；meta 用 `fa-layer-group` 上下文、`fa-microchip` KV、`fa-hdd` 引擎名、`fa-network-wired` 端口、`fa-eye` 视觉） |
| 顶栏 PresetMenu | **已取消**（m01510）；顶栏 = 搜索 + 刷新 + SortMenu + 筛选 + 视图切换 + 刷新运行状态 |
| `ConfigSheet` | `StrataConfigSheet`（双栏 + 滚动记忆 + 写回 config 的 `args`） |
| `DetailSheet` | `StrataDetailSheet`（运行状态卡 + config 原文 textarea 编辑） |
| 聊天入口 | 运行中给 `fa-comments` → `StrataWebuiSheet` 内嵌 iframe |

- 排序键换成 Strata 语义：`name_asc/name_desc/ctx_desc/ctx_asc`；筛选 `all/running/selected/missing`；置顶开关只有「运行中优先」（Strata 无收藏）；偏好存 `localStorage` 的 `strataView`/`strataPinned`。
- 空态三套：未设目录（`fa-brain`）/ 目录下无 `strata-*.json`（`fa-box-open`）/ 筛选无结果（`fa-filter`）。
- 安装目录 panel 与运行状态 panel 全部删除；运行状态改由顶栏 `fa-heart-pulse` 探测 + 卡片徽标 + 底部统计行承载。
- 滚动记忆键 `strataConfig:<file>:<pane>`；表单初始化只依赖 `file`（`useEffect([file])` + `cancelled` 标志），照搬 `ModelSheets.tsx:175-188` 的防回灌写法。
- 写回 footer：取消 / 写回 config（`fa-save`）/ 运行中→「停止 Strata」、未运行→「写回并启动」（先 `save()` 成功再 `startStrata(file)`）。

### 12.4 验证结果

- `npx tsc --noEmit` → 通过（首轮 30 处类型错，根因是按摘要记忆猜字段名；真实签名见下）。
- `cd src-tauri; cargo test --lib`（`TMP`/`TEMP` 指工作区）→ **82 passed / 0 failed / 5 ignored**。
- `npm run build`（`danger-full-access`）→ 通过，产物 `dist/assets/index-CdvFnLSF.js` 441.85 kB（上一版 435.36 kB）。
- 产物字符串计数（进包验证）：`写回 config`=7、`安装事实`=4、`生效上下文`=2、`args 现状`=1、`没有匹配的 config`=1、`Strata 安装目录`=2、`运行中优先`=2、`config 文件操作`=**0**（ConfigMenu 确已删除）；`打开程序就自动启动`=1 是 **router** 的自动启动勾选（`SettingsPanel.tsx:497`），Strata 的那个已删除。
- `npm run tauri build` → `Finished release profile [optimized] in 2m 06s`，产物 `src-tauri\target\release\llamacpp-gui.exe` + `bundle\nsis\llama.cpp GUI_0.1.0_x64-setup.exe`；启动新包 PID 26468 窗口正常。
- **服务项改为写 config 之后复验**：`npx tsc --noEmit` 通过；`cd src-tauri; cargo test --lib` → **82 passed / 0 failed / 5 ignored**（含 `strata::tests::write_config_rejects_upstream_invisible_shapes`）。
- 待做：release 构建 + GUI 目视验证「写入所有 config」实跑（看 `strata-*.json` 顶层字段真的变了、`args` 与缩进未乱）。

### 12.5 照搬组件前必须核对的真实签名（本轮踩坑，教训）

首版照搬时按记忆猜字段导致 30 处类型错。真实定义：

- `src/types.ts:156-178` `StrataModelEntry`：`config_path`（**没有 `file_name`**，文件名要 `basename(config_path)`）、`model_name`、`port`、`host`、`has_api_key`、`engine`（引擎**路径**，无 `engine_version`/`engine_dir`）、`cwd`、`run_script`、`max_context`、`kv`、`kv_resident`、`vram_reserve_mib`、`vision: **boolean**`（不是 string）、`gpu`、`prompt_cache`、`spec`、`modified_ms`、`engine_exists`。
- `src/ipc.ts:46-59`：`strataConfigRead(configFile): Promise<string>`（失败 throw，不是 `{text,error}`）；`strataConfigWrite(configFile, text): StrataModelEntry`；所有 `configFile` 参数一律传**文件名**。
- `src/store.ts:733-750` `writeStrataConfig(configFile, text): Promise<boolean>`（成功 true；失败已 `set({error})`）。
- `argsToState`/`stateToArgs` 在 **`src/utils/strataParams.ts`:326/:352**（不在 `utils/extraParams.ts`）；`stateToArgs` 第一参是 `unknown[]`，从 `JSON.parse` 结果取 `args` 时要 `Array.isArray(...) ? ... : []`。
- `src/utils/modelIcon.ts:59` `getModelIcon(...hints): string | null` → 给 `<img src>` 要 `?? undefined`。
- `src/components/ParamForm.tsx:438-452` `ParamForm({ state, onChange, persistKey? })`。

## 13. 界面改造第二轮（用户 m01771）

需求原文要点：设置页「strata 保存按钮内的文字就是"保存"」；Strata 页 ①「模型卡片的存储图标后应该是模型的实际大小（从 E:\AI\Strata-data\models 目录下获取）」②「顶部的筛选按钮应该把文字 config 改为模型」③「参数配置右侧的参数内容不是 strata 的，左侧只显示引擎版本、config 文件、run 脚本和写回规则」。

### 13.1 数据侧（`src-tauri/src/strata.rs`）

`StrataModelEntry` 在 `engine_exists` 后新增 3 字段（`src/types.ts:156` 同步）：

| 字段 | 来源 |
|---|---|
| `engine_version: Option<String>` | 引擎同目录 `BUILD.json` 的 `version`（本机 `0.1.41`；运行时 `/props.build_info` 早前是 `Strata 0.1.40.3`，说明引擎已升级过 → 印证 R3「版本从运行时读、不长期缓存」，GUI 只在扫描时读一次） |
| `model_path: Option<PathBuf>` | `args` 里 `--native` 的值 |
| `model_size_bytes: Option<u64>` | 分片聚合，见下 |

三个新函数：

- `fn shard_info(name: &str) -> Option<(String, u32, u32)>` — 解析 `<base>-00001-of-00002.gguf` → `(base, index, total)`；`strip_suffix(".gguf")` → `rsplit_once("-of-")` 取 total → `rsplit_once('-')` 取 index；`base.is_empty() || total == 0` → `None`。
- `fn model_size_bytes(path: &Path) -> Option<u64>` — 非分片命名走 `fs::metadata().len()`；分片则按 `{base}-{i:05}-of-{total:05}.gguf` 枚举 `1..=total` 累加**存在**的分片（`saturating_add`），`(sum > 0).then_some(sum)`。`.done` 校验附属文件不在枚举命名内，天然排除。
- `fn engine_version(exe: &Path) -> Option<String>` — `exe.parent()/BUILD.json` → `serde_json` → `.get("version").as_str()`。

`parse_config` 内接线：`engine_version(&engine_path)`、`arg_value(&args, "--native").map(PathBuf::from)`、`model_size_bytes(...)`。

### 13.2 前端（`src/components/StrataPanel.tsx` / `SettingsPanel.tsx`）

- 卡片 meta 行：`fa-hdd` 后从「引擎文件名」改为 `fmtSize(entry.model_size_bytes)`（`src/utils/models.ts:211`，与模型列表卡片同一函数），`title` 悬停显示 `model_path`。
- 顶栏筛选 `<select>`：`全部 config` → **`全部模型`**（其余三项不变）。
- 设置页 Strata 服务分组按钮：`写入所有 config` → **`保存`**（`SettingsPanel.tsx:513`；`strataSaving` 局部 state 与 spinner 图标不变）。
- **右栏参数不是 Strata 的根因**：`ParamForm` 的 `schema` prop 默认取 hub 的 `paramSchema`（llama.cpp `src/assets/params.json`），Strata 页调用时没传 → 渲染成 llama.cpp 参数表。修法 = `schema={strataParamSchema}`（`src/utils/strataParams.ts:304` 的 Strata 专属 schema **早已存在**，分组 `ctx 上下文与KV / speed 加速与缓存 / serve 服务与显存`，取值域摘自 `strata.exe --help`）。
- 左栏精简为用户要求的 4 项：「这个 config（只读）」= 引擎版本 / config 文件 / run 脚本；「写回规则」= 只替换 `args`、顺序不变、顶层字段不写、上游 `setup.py --update` 迁移过的不会被改乱 + 上下文不一致提示 + 安装事实类参数列表。**删掉**原「安装事实」6 卡（引擎/引擎存在/工作目录/服务）与「生效上下文」整组（含 `fit_max_tokens` 说明）。
- 顺带修掉一处硬编码 bug：左栏的安装事实 flag 名此前写死成 llama.cpp 的 `--model/--pack/--draft/--mmproj`，现改为调用 `src/utils/strataParams.ts:384 installFactFlags(args)`（`STRATA_INSTALL_FACT_FLAGS = pack/native/ple-gguf/mtp/expert-profile/expert-profile-save`）。

### 13.3 验证

- `npx tsc --noEmit` → 通过。
- `cd src-tauri; cargo test --lib`（`TMP`/`TEMP` 指工作区）→ **84 passed / 0 failed / 5 ignored**（新增 `shard_info_parses_gguf_shard_names`、`model_size_sums_shards_and_skips_sidecars`）。
- 模型大小实算（`.verify-size.mjs` 复刻 Rust 算法 + `fmtSize`）：`--native` = `Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf`，目录内 4 个文件（2 分片 + 2 个 `.done`）→ `bytes = 75966073120` → 卡片显示 **`70.75 GB`**。
- 教训：新测试首版 FAILED（`left: None, right: Some(8)`）——断言拿 `m-00001-of-00003.gguf.done` 当「非分片模型」，但写入的是 `m-00003-...done`，文件不存在。改用 `plain.gguf` 覆盖非分片分支。
- 构建教训：`workspace-write` 沙箱下 `npm run tauri build` 仍 `spawn EPERM`（esbuild 需要命名管道），必须 `danger-full-access`。
- `npm run tauri build`（`danger-full-access`）→ exit 0，`release` 2m 14s；前端产物 `dist\assets\index-DTuUcawl.js` 442,565 B（上一版 `index-DTq-bkQu.js` 443,020 B，左栏精简后变小）。
- 进包字符串计数：`全部模型`=3、`全部 config`=**0**、`引擎版本`=2、`写回规则`=1、`model_size_bytes`=1、`安装事实类`=2、`写入所有 config`=**0**、`引擎缺失`=3、`这个 config（只读）`=1、`生效上下文`=1（仅剩写回规则里的上下文不一致提示）。
- 新包已启动（PID 4412，窗口正常）。待做：GUI 目视验证四项 + 上一轮「保存」写 config 实跑。

## 14. 界面改造第三轮（用户 m01984）

需求原文（m01984）：「1、模型卡片图标显示的内容与模型列表页一致；2、参数配置页左侧显示当前启动参数，右侧显示参数编辑；3、上下文与 KV 池分组改为上下文与 KV；4、KV 常驻 cell 数改为 KV 池大小；5、增加多模态分组，将多模态相关参数放入；6、增加 webui 参数，对应 open_browser 参数」。

### 14.1 六项实现

| 需求 | 实现 | 位置 |
|---|---|---|
| 1 卡片图标与模型列表页一致 | 行 = 架构（`fa-layer-group`）+ **量化（`fa-microchip`）** + 尺寸 + 端口 + 视觉；ctx/KV 移出卡片 | `StrataPanel.tsx` 的 `metaEl` |
| 2 左=当前启动参数，右=参数编辑 | 左栏新增「启动参数现状」分组（args 逐行 `flag` + 取值，安装事实行半透明 + `*`）；右栏只留 `ParamForm`；「写回规则」说明删除；mobile tab 右栏改名「参数表单」 | 同上 `StrataConfigSheet` |
| 3 分组更名 | `上下文与 KV 池` → **`上下文与 KV`** | `strataParams.ts` 的 `GROUPS` |
| 4 参数更名 | `KV 常驻 cell 数` → **`KV池大小`** | `strataParams.ts` 的 `kv-resident` |
| 5 多模态分组 | 新组 `vision`「多模态」（order 3）：`--vision`（多模态（视觉））+ 三个顶层字段参数 | 同上 |
| 6 webui 参数 | `--open-browser` 复选框「webui」，写 config 顶层 `open_browser`，归「其它」组 | 同上 |

卡片要显示架构/量化，Rust 侧必须给：`StrataModelEntry` 新增 `architecture` / `quantization`，`parse_config` 用 `models::read_gguf_meta(model_path)` 读 GGUF 头部（与模型列表页同一函数，语义一致），量化取不到时 `models::detect_quantization(文件名 stem)` 兜底。前端镜像类型在 `src/types.ts:156`（不是 `ipc.ts`）——只改 Rust 会报 `TS2339: Property 'architecture' does not exist`。

### 14.2 关键设计：参数写回扩展到 config 顶层

`--vision-exe` / `--vision-gpu` / `--vision-max-tokens` / `--open-browser` 这四个值**不在 args 里**，而在 config 顶层（`vision.exe` / `vision.gpu` / `vision.max_tokens` / `open_browser`）。为了让 ParamForm 复用同一套控件，给它们分配**哨兵 flag 名**，并用 `TOP_LEVEL_KEYS` 集合把写回分流：

- `configToState(cfg)` = `argsToState(cfg.args)` + 顶层灌值；`stateToConfig(cfg, state)` = `{...cfg, args: stateToArgs(...)}` + 顶层写回。
- `stateToArgs` 的「新启用 flag 追加到末尾」循环里 `if (TOP_LEVEL_KEYS.has(def.key)) continue;` —— 哨兵 flag **永不进 args**（第一个循环遍历 args token，args 里不含哨兵 flag，安全）。
- 语义约定：`vision-gpu` 勾选 = **卸载** = `vision.gpu = false`（ParamForm 的 LOGIC 控件 value 是权威，enabled 只表示参数是否写入，见 `ParamForm.tsx:320-325`）。
- `vision.exe` 被清空时只 `delete` exe/gpu/max_tokens，**保留 `vision.mmproj` / `vision.model`** 等安装事实键。
- `open_browser`：启用写 `true`；未启用且 cfg 已有该键写 `false`；cfg 没有该键**不新增**（不给上游 config 添它本来没有的字段）。

对 §7 R6「GUI 永不写 config 顶层字段」的修订：R6 的动机是「上游迁移过的 config 不被 GUI 改乱」，被改乱的真正风险是**安装事实类键**（`native`/`mmproj`/`model` 等路径）。本轮把写回范围限定为「运行期可调的服务项」，安装事实类保持只读：`STRATA_INSTALL_FACT_FLAGS = [native, mmproj, model, model-draft, path, lora, vision-exe, vision-model, vision-mmproj]`，UI 里带 `*` 半透明展示，左栏说明「由上游安装器写下，GUI 原样保留」。

### 14.3 事实依据（`serve/server.py`，本机 0.1.40.3，grep 实测）

> **更正**：本节初稿写的 `--vision-exe` / `--vision-gpu` / `--vision-max-tokens` / `--open-browser` argparse 定义（`:494-497`、`:500`、`:1146-1148`、`:1164`、`:5144-5145`）在本机 0.1.40.3 里**不存在** —— `grep "vision_gpu|vision-gpu" E:\AI\Strata\serve\server.py` = No matches found。真实机制是 config 顶层 `vision` 子对象直接喂给 `Vision` 类，没有对应的命令行参数。

- `:5404` `if cfg.get("vision"):` → config 有 `vision` 就加载图像编码器；`:5410` `for k, v in cfg["vision"].items()` 构造 vcfg。
- `:1725` `args = [absolute(cfg["exe"]), "--mmproj", absolute(cfg["mmproj"]), "--model", absolute(cfg["model"])]` —— `vision.exe` / `vision.mmproj` / `vision.model` 是必需键，缺失即 KeyError。
- **`:1726-1727` `if cfg.get("gpu"): args.append("--gpu")`** —— `vision.gpu = true` ⇒ 给 `strata-vision` 加 `--gpu` ⇒ 视觉编码器跑在 **GPU**；false 或缺失 ⇒ 跑在 **CPU**。
- `:1728-1733` `threads` → `--threads`；`max_tokens` → `--max-tokens`；`min_tokens` → `--min-tokens`（#767 mtmd `image_min_tokens`，手工编辑键）。
- `:2205-2209` `vision_env()` 读 `cfg["vision"]["cuda_device"]`。
- `:2563-2564` `_vision_down()`；`:2606-2612` 重启时先起视觉编码器（GPU 编码器要在引擎算 KV 缓存前占好显存）；`:2624-2625` `self.vision.unload()`。
- `:5581` `if a.open and cfg.get("open_browser") is not False:` —— 自动开浏览器需要**启动命令带 `--open`** 且 config 顶层 `open_browser` 不为 false；**没有 `--open-browser` 参数**，所以 GUI 的哨兵 flag 名 `--open-browser` 只是 UI 标识、永不进 args。
- 本机 config 实况：`vision = {exe, gpu: true, max_tokens: 768, model, mmproj}`，顶层无 `open_browser`。

### 14.4 验证

- `npx tsc --noEmit` → 通过。
- `cd src-tauri; cargo test --lib`（`TMP`/`TEMP` 指工作区 + 沙箱外）→ **84 passed / 0 failed / 5 ignored**。
- `npm run tauri build`（`danger-full-access`）→ exit 0，`release` 2m 23s；前端产物 `dist\assets\index-Bs0uEWp7.js` 434.09 kB。进包计数：`KV池大小`=1、`多模态（视觉）`=3、`多模态卸载`=1、`图片最大 token 数`=1、`启动参数现状`=1、`参数表单`=1、`上下文与 KV`=1；`写回规则`=**0**、`KV 常驻 cell 数`=**0**、`默认生成长度`=**0**（三项均已删除/改名）；`接收图像`=1 是 `--vision` 的说明文字，非标签残留。新包已启动（PID 20820，窗口正常）。
- 待做：GUI 目视验证（卡片架构+量化、左栏参数现状、右栏四组含「多模态」、KV池大小文案、webui 勾选写回 `open_browser`）+ 前两轮遗留的「保存」写 config 实跑。

## 15. 状态识别修复与「多模态GPU卸载」（用户 m02176）

需求原文（m02176）：「左下角 strata 引擎的状态不对，现在我运行的就是 strata 引擎加载的模型，gui 应用没有正确识别；Strata 页修改：多模态分组中"多模态卸载"更名为"多模态GPU卸载"，其值应该与 vision.gpu 的值相同」。

### 15.1 状态识别的根因是轮询自锁

`strata_status` 命令只返回**快照**，快照仅在 GUI 自己启动/停止时写入；探测靠 `strata_probe`，而轮询的启动条件是「快照 running=true」（`store.ts` 的 `onStrataStatus` 里 `if (s.running && !prev.running) startStrataPolling()`，且 `probeStrata()` 开头 `if (!running) return`）。于是：用户自己跑 `run-<model>.bat` 起的实例 → 快照永远 false → 轮询永远不启动 → 胶囊永远显示「未运行」。Rust 侧其实早就支持探测外部实例（`lib.rs:373 strata_probe` 的 `None` 分支按选中 config 的端口探测），是前端不让它跑。

修法（`src/store.ts`）：

- 轮询**常驻**：init 里 `if (settings.strata_root) { refreshStrata(); startStrataPolling(); }`，不再以 running 为条件。
- `probeStrata()` 去掉 `if (!running) return` 守卫 —— 后端对「无选中 config / 端口 0」直接回快照不发请求，空转成本为零。
- `onStrataStatus` 只落状态，不再按 running 开关定时器；`stopStrata()` 由 `stopStrataPolling()` 改为 `startStrataPolling()`（停止后端口上可能还跑着外部实例）。

配套（`src-tauri/src/lib.rs:466 strata_stop`）：槽里没有进程 = 实例不是 GUI 拉起来的，**不强杀别人的进程树**，改为返回「端口 :N 上的 Strata 不是由本 GUI 启动的，请在它自己的控制台里停止」；状态交给轮询反映真实端口占用。

### 15.2 「多模态GPU卸载」取值 = `vision.gpu`

`src/utils/strataParams.ts` 的 `vision-gpu`：label 改「多模态GPU卸载」，`default: "true"`，`defaultEnabled: true`；`configToState` 灌 `value = vision?.gpu === false ? "false" : "true"`（`enabled = vision 子对象存在`）；`stateToConfig` 写 `v.gpu = (state["vision-gpu"]?.value ?? "true") !== "false"` —— **value 是权威**（`ParamForm.tsx:320-325` 的 LOGIC 控件以 value 为准，enabled 只表示参数是否写入）。

### 15.3 语义措辞按用户 m02263 定稿

User said (m02263):「你的理解不对，多模态GPU卸载 默认是true（即GPU卸载），勾选是改为cpu卸载」。与 `server.py:1726-1727` 实测一致（`vision.gpu=true` ⇒ 给 `strata-vision` 加 `--gpu` ⇒ 视觉编码器跑 GPU），所以**值映射无需改动，只改说明文字**：

- 旧 desc 里那句「上游命令行 `--vision-gpu` 的语义是卸载，与本处取值相反」**删除** —— 本机 0.1.40.3 没有这个命令行参数（见 §14.3 更正）。
- 新 desc：「取值就是 config 顶层 `vision.gpu`：true = 视觉引擎卸载到 GPU（上游据此给 `strata-vision` 加 `--gpu`，视觉塔常驻显存，带图请求快）；false = 卸载到 CPU（省显存，带图请求变慢）。GUI 写的是 config 字段，不改启动命令。」
- 顺带修正 `open-browser` 的 desc：上游判定是「启动命令带 `--open` 且该字段不为 false」（`server.py:5581`），初稿写的「上游命令行 `--open-browser`」不存在。

### 15.4 验证

- `npx tsc --noEmit` → 通过。
- `cd src-tauri; cargo test --lib`（`TMP`/`TEMP` 指工作区，**默认沙箱即可，无需提权**）→ **84 passed / 0 failed / 5 ignored**。
- `npm run tauri build` 需沙箱外权限（esbuild 命名管道），本轮未获批准 → **新包未产出**，现有 release 包不含本轮改动；需用户自行执行 `npm run tauri build` 后再目视验证。

## 16. 界面改造第四轮：多模态模型选择（用户 m02308）

User said (m02308):「多模态分组中：多模态引擎应该改为多模态模型，可以由用户选择模型文件；在用户选择了多模态（视觉）为真以后，必须模型不能为空，且"exe"和"model"参数自动添加到config」

### 16.1 实现

| 项 | 改动 |
| --- | --- |
| 参数改名 + 换控件 | `src/utils/strataParams.ts`：哨兵 flag `vision-exe`（label「多模态引擎」，写 `vision.exe`）**删除**，替换为 `vision-model`（flag `--vision-model` 仅作 UI 标识、`TOP_LEVEL_KEYS` 拦截永不进 args，label「多模态模型」，group `vision` order 2，写 `vision.model`） |
| 文件选择器 | `src/components/ParamForm.tsx`：`PATH_PARAMS` 新增 `"vision-model"`（`title: "选择多模态模型"`、`modelsToo: true`、`placeholder: "勾选「多模态（视觉）」后必填"`），于是走 `PathControl` —— 可手输、可从扫描结果下拉、可「浏览…」开系统 GGUF 对话框（`ParamForm.tsx:130-147`，路径统一正斜杠）；`PATH_PARAMS` 类型新增可选 `placeholder` 字段，`PathControl` 优先用它 |
| 候选来源 | `ParamForm.tsx:538-557` 的 `pathOptions` 新增 `vision-model` 列表 = 扫描到的全部模型（`scanned` 每项 `m.path`，label 用 `m.name`），与 `spec-draft-model` 同源 |
| 必填校验 | `src/components/StrataPanel.tsx` 的 `save()`：`formState["vision"]?.enabled`（= args 带 `--vision`）时，`vision-model` 为空 → `setFormError("已勾选「多模态（视觉）」，必须选择多模态模型文件")` 并**拒绝写回**；`vision.mmproj` 缺失同样拒绝（上游必需键，缺了带图请求必失败） |
| `exe` / `model` 自动补齐 | `stateToConfig(cfg, state, root?)` 新增第三参数 = 设置里的 `strata_root`（`src/types.ts:49`，`StrataPanel` 用 `useApp((s) => s.settings?.strata_root ?? null)` 传入）：`visionOn || prevVision` 时写 `vision.model = 用户所选`；`vision.exe` **已有值原样保留**（安装事实），缺失时按 `<root>\engine\strata-vision.exe` 补（分隔符跟随 root 风格）；`vision.gpu` / `vision.max_tokens` 照 §15.2；`vision.mmproj` 等其余键原样保留 |
| 读取侧 | `configToState` 灌 `state["vision-model"] = { enabled: model !== "", value: vision?.model }`；`vision.exe` 不再进表单（改由 GUI 自动维护，用户不再手填引擎路径） |

### 16.2 上游事实依据（本机 0.1.40.3 实测）

- `serve/server.py:1725` `args = [absolute(cfg["exe"]), "--mmproj", absolute(cfg["mmproj"]), "--model", absolute(cfg["model"])]` —— `exe` / `mmproj` / `model` 三个键**必需**，缺一个 `Vision.__init__` 直接 KeyError，编码器起不来。
- `serve/server.py:5404` `if cfg.get("vision"):` → 有 `vision` 子对象才加载图像编码器；`:5410` `for k, v in cfg["vision"].items()` 构造 vcfg。
- 本机 `E:\AI\Strata\strata-swift-iq3_xxs.json` 实况：`vision.exe = E:\AI\Strata\engine\strata-vision.exe`（即 `<安装目录>\engine\strata-vision.exe`，GUI 补路径照此）、`vision.mmproj = E:\AI\Strata-data\models\mmproj-Swift-Qwen3.8-Flash-Next-BF16.gguf`、`vision.model` = 主模型 GGUF（与 args 里 `--native` 同一文件）、`vision.gpu = false`、`vision.max_tokens = 768`。
- 结论：`exe` 是安装事实（上游安装器写下，GUI 只在缺失时按安装目录补），`model` 是用户可换的模型文件 —— 与用户要求「exe 和 model 自动添加到 config」一致。

### 16.3 验证

- `npx tsc --noEmit` → 通过。
- `cd src-tauri; cargo test --lib`（`TMP`/`TEMP` 指工作区，默认沙箱）→ **84 passed / 0 failed / 5 ignored**（本轮无 Rust 改动）。
- 待做：沙箱外 `npm run tauri build` 后目视验证 —— 多模态分组应显示「多模态模型」文件选择器（下拉候选 + 浏览按钮），勾选多模态但模型为空时点「写回 config」应被拒绝并提示，保存后 config 顶层 `vision.model` 为所选路径且 `vision.exe` 存在。

### 16.4 构建与进包（用户 m02420「构建」，提权获准）

- 构建前先 `Stop-Process` 停掉运行中的 GUI（Windows 下运行中的 exe 无法被 cargo 覆盖）。
- `npm run tauri build`（`danger-full-access`，job pwsh-106）exit 0：`release` 1m 53s；NSIS 包 `src-tauri\target\release\bundle\nsis\llama.cpp GUI_0.1.0_x64-setup.exe` 产出。
- 前端产物 `dist\assets\index-BGn8TBPd.js` 434.78 kB（gzip 148.36 kB）。进包字符串计数：`多模态模型`=6、`选择多模态模型`=2、`勾选「多模态（视觉）」后必填`=2、`必须选择多模态模型文件`=1、`vision-model`=8、`strata-vision.exe`=2；`多模态引擎`=**0**（确已删除）；上轮项 `多模态GPU卸载`=1、`KV池大小`=1、`启动参数现状`=1 仍在。
- 新包已启动 PID 25144（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。

## 17. 纠正：「多模态模型」对应的是 `mmproj`（用户 m02447 + m02484）

User said (m02447):「你的多模态模型对应的参数错了，应该是"mmproj"参数」
User said (m02484):「而且模型筛选也要增加模型名字包含"mmproj"」

§16 把用户选的文件写进 `vision.model` 是错的：`vision.model` 是**主模型**（与启动参数 `--model` 同一个文件，不是用户在这里该选的东西），用户要选的视觉投影模型是 `vision.mmproj`。

### 17.1 改动

| 项 | 改动 |
| --- | --- |
| 目标键换掉 | `src/utils/strataParams.ts`：哨兵参数 key `vision-model`/flag `--vision-model` → **`vision-mmproj`/`--vision-mmproj`**（label 仍「多模态模型」，group `vision` order 2）；`TOP_LEVEL_KEYS` 同步改名；`configToState` 读 `vision.mmproj` 灌表单；`stateToConfig` 写 `v.mmproj = 用户所选` |
| `vision.model` 改为自动同步 | 不再由用户选：`stateToConfig` 从**写回后的 args** 里取 `--model` 的值写进 `vision.model`（`modelIdx = argList.indexOf("--model")`）。上游 `server.py:1725` 把 exe/mmproj/model 三键都当必需键，所以 GUI 必须保证 model 有值且与启动参数一致 |
| 候选筛选 | `src/components/ParamForm.tsx`：`PATH_PARAMS` 注册键改 `"vision-mmproj"`（`kinds: ["mmproj"]`、`modelsToo: true`）；`pathOptions` 的候选 = **扫描识别出的投影文件**（`auxFiles` 里 `kind==="mmproj"` + `scanned[].mmproj`）**加上文件名含 `mmproj` 的模型**：`scanned.filter(m => /mmproj/i.test(m.name) \|\| /mmproj/i.test(m.path))`，label 带「（模型）」后缀。理由：扫描器按「文件名以 mmproj 开头」识别投影文件，`xxx-mmproj-xxx.gguf` 这种命名不在识别范围，但它确实是投影模型 |
| 校验 | `src/components/StrataPanel.tsx` 的 `save()`：勾选多模态后，表单值与 config 原值都为空 → 拒绝写回，提示「已勾选「多模态（视觉）」，必须选择多模态模型（vision.mmproj）文件」。原来那条「config 没有 vision.mmproj」的独立报错已并入此校验 |

### 17.2 实跑验证（用本机真实 config，esbuild 打包 `strataParams.ts` 后 node 跑）

- 读取：`vision-mmproj = E:\AI\Strata-data\models\mmproj-Swift-Qwen3.8-Flash-Next-BF16.gguf` ✓
- 模拟改选 `mmproj-CUSTOM-BF16.gguf` 后写回：`vision = { exe: E:\AI\Strata\engine\strata-vision.exe（保留）, mmproj: 新值, model: 主模型 GGUF（从 --model 同步）, gpu: false, max_tokens: 768 }` ✓
- `args identical: true`（args 一字未动）；顶层键集合不变；`open_browser` 保持 false
- **幂等性**：不改任何东西直接写回 → 与原文件逐字节相同（`no-op write identical: true`）

### 17.3 验证

- `npx tsc --noEmit` → 通过；`grep vision-model|vision_model` → 无残留。
- `npm run tauri build`（job pwsh-111，沙箱外，先停 GUI 进程）exit 0：`release` 2m 06s，NSIS 包产出；前端产物 `dist\assets\index-8p4a4-vu.js` 434.97 kB（gzip 148.47 kB）。
- 进包字符串计数：`vision-mmproj`=8、`必须选择多模态模型（vision.mmproj）文件`=1、`选择多模态模型`=2、`（模型）`=2；`vision-model`=**0**（旧键彻底消失）。
- 新包已启动 PID 19624（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。


---

## 18. 本轮界面改造第五轮（用户 m02541）

### 18.1 四项需求与实现

| 需求 | 实现 | 说明 |
|---|---|---|
| ① 胶囊下显示版本 | `src/App.tsx` 胶囊下方新增 `<div className="muted">` 显示 `strataStatus.version`（来自 `/props.build_info`，R3 不缓存） | 原胶囊只有「Strata 运行中 · :端口」 |
| ② 外部实例端口错 + 提示 | Rust 侧新增 `StrataStatus.external`；`strata_probe` 在 slot 无进程时**遍历全部 config 的端口**（选中优先、去重）探测，命中即回填真实端口并置 `external=true`；前端胶囊在 `external` 时显示「非本 GUI 启动，无法启/停」并把启停按钮置灰 | 旧实现只探选中 config 的端口，端口显示的是没在跑的那个值 |
| ③ 五角星 = 默认 config | 现状已实现（单选 + 侧栏启动选中 config），本轮只把 title 改为「默认 config：点击导航左下角的 Strata 胶囊就会启动它；多个模型只能有一个默认」 | 卡片 `StrataPanel.tsx:174-183` |
| ④ 对话图标改为直接打开 WebUI | 对话图标 onClick 改为 `ipc.openLocalUrl(webuiUrl)`（系统浏览器）；删除内嵌 `StrataWebuiSheet` 与 `webuiOpen` state | 内嵌 iframe 在 Tauri 里被 llama.cpp WebUI 拒绝渲染（实测空白） |

### 18.2 上游/运行时事实依据

- `src-tauri/src/strata.rs:663 probe(port, api_key)` 只探单端口；`/health` 无 `service:"strata"` 时置 `last_error="端口上运行的不是 Strata（/health 无 service:strata）"` → 多 config 多端口时**必须逐个探**才能找到真实实例。
- 本机实测：`E:\AI\Strata\strata-swift-iq3_xxs.json` 的 `port=9090`（实测在跑），`strata-swift-1.5-iq3_xxs.json` 的 `port=9091`（未跑）→ 选中后者时旧逻辑显示 9091，与实际运行的 9090 不符。
- `strata_stop` 早已有「端口 :N 上的 Strata 不是由本 GUI 启动的，请在它自己的控制台里停止」分支 → 前端置灰按钮与该行为一致。
- llama.cpp 内置 WebUI 在 Tauri iframe 内不渲染（上一轮实测），故本轮直接放弃内嵌方案。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18 appended"

### 18.3 前端落盘细节

- `src/types.ts` 的 `interface StrataStatus` 加 `external: boolean`；`src/store.ts:151 emptyStrataStatus` 加 `external: false`（漏了会 TS2741「Property 'external' is missing」）。
- `src/App.tsx` 胶囊：`disabled={busy || (strataStatus.running && strataStatus.external)}`；图标三态 —— 运行且可控 `fa-stop`、运行但外部 `fa-lock`、未运行 `fa-play`；胶囊下方新增 muted 小字行（仅运行中渲染）：`[external ? "非本 GUI 启动，无法启/停" : null, version ?? "版本未知"].join(" · ")`。
- `src/components/StrataPanel.tsx`：五角星 title 改为「默认 config：点侧栏的 Strata 胶囊就会启动它（多个模型只能有一个默认）」；对话图标换成 `fa-external-link-alt` + title「在浏览器里打开这个模型的 WebUI」，`onWebui={() => void ipc.openLocalUrl(webuiUrl)}`；删除 `StrataWebuiSheet` 组件、`webuiOpen` state 与末尾渲染行（`Modal` import 保留，`:479`/`:622` 两个 sheet 仍在用）。卡片 `isRunning={runningFile === fileOf(e)}` 保证只有真实运行那个 config 的卡片显示 WebUI 图标，`webuiUrl` 用探测回填的 `status.port`。

### 18.4 Rust 编译错误教训（本轮踩到的四个）

- `PathBuf::as_ref()` 有歧义（`AsRef<Path>` 与 `AsRef<[u8]>` 都实现）→ E0282「type annotations needed」；直接 `.file_name()` 即可（PathBuf deref 到 Path）。
- `StrataModelEntry.config_path` 是 `PathBuf`、`model_name` 是 `String`（**不是** Option），传给 `Option` 形参处要 `Some(...)` → 两处 E0308。
- `strata.rs` 里 `probe`/`spawn_strata` 用**结构体字面量**构造 `StrataStatus`，新增字段必须逐处补 `external: false` → E0063。
- `let preferred: Option<&strata::StrataModelEntry> = ...` 需要显式标注（`Option::into_iter().chain(vec.iter())` 的 Item 推断）。
- 验证：`npx tsc --noEmit` → **TSC OK**；`cargo test --lib`（TMP/TEMP 指 `E:\Code\llama.cpp-GUI\.tmp`）→ **84 passed; 0 failed; 5 ignored**。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.3/18.4 appended"

### 18.5 构建与进包（用户 m02622 触发的构建）

- `npm run tauri build`（`danger-full-access`，job pwsh-120）exit 0；前端产物 `dist\assets\index-D1f75Bic.js` 434.6 kB。
- 进包字符串计数：`非本 GUI 启动，无法启/停`=1、`默认 config：点侧栏`=2（网格 + 列表两处卡片）、`在浏览器里打开这个模型的 WebUI`=1、`fa-lock`=1、`fa-external-link-alt`=1、`版本未知`=1、`StrataWebuiSheet`=**0**（内嵌 sheet 确已删除）。
- 新包启动 PID 29320（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.5 appended"

### 18.6 胶囊下方小字与 router 对齐（用户 m02748 + m02775）

- 用户要求「左下角 strata 胶囊文本字体要和 router 胶囊下的字体及大小一致」+「版本要显示在前面」。
- 实现：`src/App.tsx` 的 Strata 胶囊下方由 `className="muted"` + `0.72rem` + 居中 `div` 改为与 router 版本行**逐项相同**的 `span`：`className="mono"`、`display:"block"`、`marginTop:"0.45rem"`、`fontSize:"0.68rem"`、`color:"var(--text-secondary)"`、`overflow:"hidden"`、`textOverflow:"ellipsis"`、`whiteSpace:"nowrap"`、`title={strataFootText}`（router 的对应代码在 `src/App.tsx:243-258`，样式来源即此）。
- 文案顺序改为**版本在前**：`strataFootText = [version ?? "版本未知", external ? "非本 GUI 启动，无法启/停" : null].filter(Boolean).join(" · ")`，抽成变量供正文与 title 共用（`src/App.tsx:104-110`）。
- 验证：`npx tsc --noEmit` → TSC OK。构建见 §18.7。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.6 appended"

### 18.7 构建与进包（用户批准构建）

- `npm run tauri build`（`danger-full-access`，job pwsh-126）exit 0；主产物 `dist\assets\index-tBMH5EE5.js` 434.71 kB（同批还有一个 1.22 kB 的小 chunk `index-LRsjWP-1.js` —— **按 LastWriteTime 取「最新产物」会抓到它，验证必须按 Length 取最大的那个**）。
- 进包计数：`0.68rem`=2（router 与 Strata 两处样式已一致）、`0.72rem`=**0**（旧样式确已移除）、`非本 GUI 启动，无法启/停`=1、`版本未知`=1。
- 新包启动 PID 20476（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.7 appended"

### 18.8 胶囊小字第二轮修正：共用 CSS 规则（用户 m02805）

用户反馈：字号仍不一致、Strata 文字显示不完、离 router 胶囊太近。

- 根因：两处都用 inline style 各写一遍，且都带 `whiteSpace:"nowrap"` + `overflow:"hidden"` + `textOverflow:"ellipsis"` —— 侧栏窄，长文案被裁成半句；Strata 那行下面还压着 router 胶囊，而 router 胶囊自身没有上边距，所以贴在一起。
- 修法：新增共用规则 `src/styles/app.css` 的 `.sidebar-foot-note`（`display:block`、`margin-top:0.45rem`、`font-family: Consolas/Cascadia Mono`、`font-size:0.68rem`、`line-height:1.35`、`color:var(--text-secondary)`、`text-align:center`、`overflow-wrap:break-word`，**不用 nowrap/ellipsis**）。`src/App.tsx` 两处小字都改成这个类：router 的 version 行去掉全部 inline style；Strata 行只保留 `style={{ marginBottom: "0.7rem" }}`（因为它下面还有 router 胶囊）。
- 相关既有规则：`.mono` 在 `src/styles/app.css:138` 把 legacy 的 `min-height:38px` 压成 0（`src/styles/legacy/index.css:1644` 仍是 38px），`.sidebar-footer` 只有 `padding:12px 10px`（`src/styles/app.css:250`）—— 字号从来不是 CSS 给的，所以必须靠共用类锁定。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.8 appended"

### 18.9 构建与进包（共用 CSS 类）

- `npm run tauri build`（job pwsh-131）exit 0；主 js `dist\assets\index-DinHoAGM.js` 434.46 kB，主 css `dist\assets\index-c_m7i_mK.css` 200.16 kB。
- 进包验证：js 里 `sidebar-foot-note`=2（两处 className）、css 里=1（规则本体）。压缩后规则原文：`.sidebar-foot-note{display:block;margin-top:.45rem;font-family:Consolas,Cascadia Mono,monospace;font-size:.68rem;line-height:1.35;color:var(--text-secondary);text-align:center;overflow-wrap:break-word}`。**注意**：css 压缩器把 `0.68rem` 写成 `.68rem`，按 `0.68rem` 计数会得到 0 —— 验证 CSS 要按压缩后的字面量查，或直接读规则原文。
- 新包启动 PID 21144（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.9 appended"

### 18.10 胶囊小字第三轮：只留版本号（用户 m02847）

- 用户反馈「换行了不好看，取消『非本 GUI 启动，无法启/停』这些内容」。
- 实现：`src/App.tsx` 的 `strataFootText` 简化为 `strataStatus.version ?? "版本未知"`（单行，不再拼接附加文案）；外部实例的说明移入 `strataFootTitle`（悬停显示 `<版本> · 非本 GUI 启动，无法启/停`）。外部状态的可控表达保留在**图标 `fa-lock` + 按钮置灰 + 胶囊 title** 三处，不占小字行。
- `.sidebar-foot-note` 的 `overflow-wrap: break-word` 保留（版本号过长时仍会换行，但正常情况单行）。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.10 appended"

### 18.11 构建与进包（小字只留版本号）

- `npm run tauri build`（job pwsh-136）exit 0；主 js `dist\assets\index-DoFD13--.js` 434.45 kB。
- 进包计数：`非本 GUI 启动，无法启/停`=1（只剩 `strataFootTitle` 拼接那一处，胶囊 title 用的是另一串「外部实例：端口…」）、`sidebar-foot-note`=2、`版本未知`=1。
- 新包启动 PID 14788（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.11 appended"

### 18.12 胶囊小字第四轮：左对齐 + 上下等距（用户 m02874 截图）

- 用户反馈：文字要左对齐；Strata 的小字离上下两颗胶囊的距离要一致。
- 实现：`.sidebar-foot-note` 的 `text-align` 由 `center` 改 **`left`**（与胶囊左边缘对齐，两者同在 `.sidebar-footer` 的 `padding:12px 10px` 内容区里）；`src/App.tsx` 里 Strata 那行的 `marginBottom` 由 `0.7rem` 改 **`0.45rem`**，与 CSS 的 `margin-top:0.45rem` 相等 → 上下等距。router 那行是最后一行，只有 `margin-top`，下方由 footer 的 padding 兜底。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.12 appended"

### 18.13 构建与进包（左对齐 + 等距）

- `npm run tauri build`（job pwsh-140）exit 0；主 js `dist\assets\index-BWfrUf8e.js` 434.45 kB，主 css `index-CZsxD9tr.css` 200.16 kB。
- 压缩后 CSS 规则原文核对：`.sidebar-foot-note{display:block;margin-top:.45rem;font-family:Consolas,Cascadia Mono,monospace;font-size:.68rem;line-height:1.35;color:var(--text-secondary);text-align:left;overflow-wrap:break-word}`
- 新包启动 PID 30200（`Responding=True`，窗口 `dev.llamacpp.gui-siw`）。
EOF
$c + $append | Set-Content $p -Encoding UTF8; "§18.13 appended"

## §19 本轮三问题修复（用户 m02900）

用户报告：①GUI 启动时 Strata 已在跑，在 Strata 控制台关掉模型后 GUI 仍显示「运行中」；②GUI 启动 Strata 后系统日志页看不到 Strata 的模型日志；③性能测试页没有 Strata 模型，无法压测。

### 19.1 状态粘住（问题 ①）

- 根因：`src-tauri/src/lib.rs` 的 `strata_probe` 在「slot 为空（外部实例）且全部 config 端口探测无响应」时直接返回 `state.strata_status` 快照，快照里 `running` 仍是 true。
- 修复：探测全失败即落回未运行 —— `running=false`、`external=false`，清 `pid/config_path/model_name/started_at_ms/last_error/version/live_max_context/loaded/busy/prompt_tokens/max_tokens/models_autoload`，端口复位到选中 config 的 `port`（没在跑时显示的就是配置端口），再 emit `strata://status`。
- 依据：GUI 没启动这个实例时，端口探测是判断它是否在跑的**唯一依据**，快照不能当事实用。

### 19.2 日志分流（问题 ②）

- 根因两条叠加：
  1. `src-tauri/src/router.rs:372 spawn_reader` 用 `classify_log_source`（`router.rs:210`，只认行首 `[端口]` → `model:<端口>`，否则 `"system"`），Strata 输出没有该前缀 → 全塞进 router 的 `"system"` 源；前端源列表（`src/components/LogPanel.tsx:56-83`）只有「全部日志 / 系统（router 自身）/ 前端 / model:<端口>」，没有 Strata 项。
  2. Python 的 stdout 接到管道时全缓冲，日志攒在进程里不 flush。
- 修复：
  - `src-tauri/src/strata.rs` 新增 `fn spawn_strata_reader<R: Read + Send + 'static>(stream: R, hub: Arc<LogHub>, tx: mpsc::Sender<LogLine>)`，整条流固定 `hub.push("strata", text)`；`spawn_strata` 的 stdout/stderr 两路改用它（不再用 `spawn_reader`）。
  - `spawn_strata` 两处 `Command`（首次 + 去 BREAKAWAY flag 的重试）都加 `cmd.env("PYTHONUNBUFFERED", "1")`。
  - `src-tauri/src/strata.rs` 新增 `pub fn loopback_host(host: &str) -> String`（`"" | 0.0.0.0 | :: | * | localhost` → `127.0.0.1`）。
  - `src/components/LogPanel.tsx`：订阅 `strataStatus`；`items` 里检测 `line.source === "strata"` 后加固定项 `{filter:"strata", name:"Strata · <model_name>", fixed:true}`；`useMemo` deps 加 `strataStatus.model_name`。
- 注意：`spawn_strata_reader` 需要 `use std::io::BufRead;`（`BufReader::split` 是 trait 方法，漏了会 E0599）。

### 19.3 压测支持 Strata（问题 ③）

- 前提实测：Strata 的 `/v1/chat/completions` 响应含
  `timings = {cache_n, prompt_n, prompt_ms, prompt_per_token_ms, prompt_per_second, predicted_n, predicted_ms, predicted_per_token_ms, predicted_per_second, draft_n, draft_n_accepted}`，
  与 `src-tauri/src/bench.rs:82 record_from_response` 需要的字段完全兼容 → 记录口径一致，压测核心零改动。
- 关键约束：`StrataModelEntry::api_key` 带 `#[serde(skip_serializing)]`，密钥不下发 WebView → 压测必须由 Rust 侧发起。
- 新增 `src-tauri/src/bench.rs`：`#[tauri::command] pub async fn bench_strata(root: String, config_file: String, prompt_tokens: u32, max_tokens: u32, concurrency: u32)` —— `scan_configs(root)` 按 config 文件名匹配出 entry，再转调 `bench_server(loopback_host(&entry.host), entry.port, entry.api_key, entry.model_name, ...)`（解耦规则 R2：端口 / 模型名 / 密钥全从 config 读）。
- `src-tauri/src/lib.rs` 注册 `bench::bench_strata`；`src/ipc.ts` 加 `benchStrata({ root, configFile, promptTokens, maxTokens, concurrency })`。
- `src/components/BenchPanel.tsx`：
  - 订阅 `strataEntries` / `strataStatus`；`strataViews = strataEntries.map(...)` 造 `ModelView`（`id = "strata:<config 文件名>"`、`section/name = model_name`、`group = "strata"`、`inPreset = true` 以跳过 router 专属校验、`status = "loaded"` 仅当「Strata 在跑且跑的就是这份 config」）。
  - `allModels = [...models, ...strataViews]`，`filteredModels` / `selected` 改用它；`isStrata = selected.id.startsWith("strata:")`。
  - `runServer`：`inPreset` 校验加 `!isStrata` 前置；运行校验分支 —— Strata 用 `strataStatus.running/port`，并校验 `strataStatus.model_name === selected.section`（跑的不是它时提示先去「Strata」页启动）；调用分支 `isStrata ? ipc.benchStrata(...) : ipc.benchServer(...)`。
  - 顶栏状态文字随选中项切换（选中 Strata 显示 `Strata :<port>`）；左栏卡片对 `group === "strata"` 加「Strata」来源标记。
  - 按钮 disabled 沿用 `selected.status !== "loaded"`（Strata 条目的 status 已按运行态算）。

### 19.4 验证

- `npx tsc --noEmit` exit 0；`cargo check --lib` exit 0（无 warning）；`cargo test --lib`（TMP/TEMP 指工作区 `.tmp`）**84 passed / 0 failed / 5 ignored**。
- `npm run tauri build` 成功；主 js `dist\assets\index-DZgxPyaV.js` 435.87 kB，`src-tauri\target\release\llamacpp-gui.exe` 9.14 MB（15:23:01）。进包字符串计数：`bench_strata`=1、`strata:`=3、`Strata 未运行`=4、`Strata 当前运行的是`=1。
- 新包启动 PID 28028（`Responding=True`）。


### 19.5 Strata 卡片对齐模型列表（用户 m03130）

四项改造，全部照搬 `src/components/ModelListPanel.tsx` 的卡片口径：

1. **名字旁去掉「运行中」**：`ConfigCard` 的 `badges` 原本含 `{isRunning && <span>运行中</span>}`，与卡片底部状态胶囊重复 → 删除。`hasBadges` 条件同步改为 `entry.vision || !entry.engine_exists || !!entry.kv_resident`。
2. **「视觉」移到名字右边、纯文字**：从 `metaEl` 里删掉 `{entry.vision && <span><i className="fas fa-eye" /> 视觉</span>}`，改为 `badges` 里的 `{entry.vision && <span>视觉</span>}`（无图标）。与模型列表 `ModelListPanel.tsx:119-125` 的 `{model.hasMmproj && <span>视觉</span>}` 一致——徽标 inline 跟在模型名后面（`nameEl` 结构 `ModelListPanel.tsx:128-133`）。
3. **状态胶囊三态**：`badge` 由两态改三态，与 `ModelListPanel.tsx:25-41` 的 `statusOf` 同口径：
   ```tsx
   <div className={`model-status-badge ${isRunning ? "status-loaded" : isLoading ? "status-loading" : "status-stopped"}`}>
     <i className={`fas ${isRunning ? "fa-check-circle" : isLoading ? "fa-spinner fa-spin" : "fa-stop-circle"}`} />
     {isRunning ? "运行中" : isLoading ? "加载中" : "已停止"}
   </div>
   ```
   「加载中」的判据：`src/store.ts` 新增状态 `strataStarting: string | null`（类型声明在 `strataEntries` 之后，初始值 `null`）。`startStrata` 开头 `set({ ..., strataStarting: startingFile })`，其中 `startingFile = configFile ?? get().settings?.strata_selected_config ?? null`；`finally` 里 `set({ busy: false, strataStarting: null })`。理由：`ipc.strataStart` 是 Rust 侧 `spawn_strata` 等端口就绪才返回，这段调用期间就是加载窗口；用 config 文件名而不是全局 `busy`，避免 router 侧操作让 Strata 卡片转圈。`ConfigCard` 新增 prop `isLoading`，卡片调用点传 `isLoading={starting === fileOf(e)}`（`starting = useApp((s) => s.strataStarting)`）。CSS 类 `.model-status-badge.status-loading` 已存在（`src/styles/app.css:688`，暗色 `:717`）。
4. **图标兜底 qwen**：`const icon = getModelIcon(name, file, entry.engine ?? undefined) ?? getModelIcon("qwen") ?? undefined;`。`src/utils/modelIcon.ts` 的 `ICON_MAP` 首位就是 `["qwen","qwen"]`，所以第二次调用取到 qwen 图标；不改 `modelIcon.ts`（模型列表的兜底行为保持原样）。

**踩坑**：给 `ConfigCard` 加 prop 时只在类型注解 `}: { ... }` 里加了 `isLoading: boolean;`，忘了加参数解构里的 `isLoading,` → `npx tsc --noEmit` 报 3 处 `error TS2304: Cannot find name 'isLoading'`（`StrataPanel.tsx:247/252/255`）。TS 组件的 props 类型注解和解构列表是两处，必须同时改。

## §20 Strata 与 router 显存互斥（用户 m03342）

### 20.1 需求

User said (m03342): "建议在设置的服务选项卡增加一个选项，两种引擎的"。追问澄清（m03342 答复）：

> "llama.cpp的router和strata两种引擎加载的模型没有实现互斥，增加的选项就是实现这个功能，选中后实现，加载strata模型的时候先自动卸载router下正在运行的模型，或者加载router下模型的时候先自动卸载正在运行的strata模型"

作用范围选择：**全局开关，影响启动入口和界面显示**。

（注：`serve/server.py:5330` 的 `--engine` 只有 `["mock","strata"]` 两个取值，`mock` 是 `MockEngine`（`server.py:244`）无 GPU 脚本替身 —— 用户说的「两种引擎」不是这个，而是 router 与 Strata 两个运行时。）

### 20.2 实现

| 层 | 改动 |
|---|---|
| `src-tauri/src/settings.rs` | `Settings` 加 `#[serde(default)] pub strata_router_mutex: bool`（紧跟 `auto_start_strata`）；`Default` 里 `strata_router_mutex: false`；`SettingsPatch` 加 `pub strata_router_mutex: Option<bool>`；`apply` 里加 `if let Some(v) = patch.strata_router_mutex { s.strata_router_mutex = v; }` |
| `src/types.ts` | `Settings` 加 `strata_router_mutex: boolean`；`SettingsPatch` 加 `strata_router_mutex?: boolean` |
| `src/store.ts` | 新 action `unloadRouterLoaded(): Promise<string[]>` —— 遍历 `routerModels` 里 `status.value === "loaded"` 的逐个 `apiUnloadModel(status.port, m.id)`，然后 `refreshRouterModels(false)`，返回被卸的 id 列表 |
| `src/store.ts` `startStrata` | 互斥开启时先 `unloadRouterLoaded()`，把结果拼进启动成功的 notice：`Strata 已启动\n模型 X · :9090\n显存互斥：已卸载 router 的 A、B`（合并进同一条 notice，避免被后面的 `set({notice})` 覆盖） |
| `src/store.ts` `startModel` | 互斥开启且 `strataStatus.running` 时先 `await get().stopStrata()`，`set({ notice: "显存互斥：已停止 Strata" })` |
| `src/components/SettingsPanel.tsx` | 「服务」分组 Strata 块末尾加 checkbox「Strata 与 router 显存互斥」，`onChange` 直接 `saveSettings({ strata_router_mutex })`（与「打开程序就自动启动 router」同款即时保存） |
| `src/components/StrataPanel.tsx` | `ConfigCard` 加 `mutex: boolean` prop（类型 + 解构 + 调用点 `mutex={!!settings?.strata_router_mutex}`），启动按钮 title 变「启动这个 config（显存互斥已开：会先卸载 router 正在运行的模型）」 |
| `src/components/ModelListPanel.tsx` | `ModelCard` 内订阅 `mutex = s.settings?.strata_router_mutex ?? false` 与 `strataRunning = s.strataStatus.running`，启动按钮 title 变「启动（显存互斥已开：会先停止 Strata）」 |

### 20.3 设计决定

- **默认关闭**：自动卸载会打断对方正在进行的会话（router 模型被卸 = 该模型的对话上下文丢失），属于侵入性操作，要用户主动开启。
- **只卸 `status.value === "loaded"` 的 router 模型**：`sleeping` 的显存已被 router 自己释放（`sleep_idle_seconds` 机制），卸了没收益；`loading` 中的模型卸不掉。
- **卸载失败不阻断启动**：单个模型卸载失败只 `set({error})`，继续启动 Strata —— 显存够用时不该因为一个 router 模型卡住 Strata 启动。
- **互斥是单向对称**：启动 Strata → 卸 router loaded；加载 router 模型 → 停 Strata。router 侧用「停止 Strata」而不是「卸 Strata 模型」，因为 Strata 一个进程只跑一个模型，停进程就是卸模型。
- 与既有的 `auto_start_strata`（注释「与 router 互斥，二者抢同一块显存」，设置页已隐藏）无关，那个是开机自启开关。


## §21 引擎 / 模型分层（用户 m03526、m03572）

### 21.1 需求

- User said (m03526): "就像router一样自动启动模型"。追问后明确 (m03572)："不加，左侧导航栏下面的strata胶囊开关现在只负责启停引擎，不拉起模型（和router一样），strata页中的模型卡片负责启停模型（操作逻辑和模型列表一样）"。
- 已确认的两条决定（m03585）：**强制 `lazy_load=true`**；**显存互斥粒度从「停进程」改为「卸模型」**。
- 已确认的实现范围（m03543）：开机自动拉起引擎开关 + 空闲卸载秒数 + 显存门槛 + 加载前命令，四项全做；空闲卸载默认关闭。
- 放弃的路线：GUI 做 HTTP 网关拦截 DSH 请求（GUI 不在 DSH→Strata 的链路上，DSH 直连 9090，Strata 没跑时 TCP connection refused）。改用上游原生机制。

### 21.2 上游机制（`E:\AI\Strata\serve\server.py` 实测行号）

| 机制 | 命令行 | config 顶层键 | 行为 |
| --- | --- | --- | --- |
| 懒启动 | `--lazy`（`:5353`） | `lazy_load: true`（`:5403` `lazy = a.lazy or cfg.get("lazy_load") is True`） | API 先起来，引擎与 vision encoder 等第一个请求 |
| 空闲卸载 | `--idle-unload SECONDS`（`:5357-5359`） | `idle_unload_s`（`:5495`，0/缺失=关闭） | 空闲 N 秒卸模型让显存，**下一个请求自动加载回来** |
| 显存门槛 | `--min-free-vram`（`:5361-5362`） | `min_free_vram_mib`（`:5496-5497`） | 空闲显存不足不加载，回 503 |
| 加载前命令 | `--before-load`（`:5364`） | `before_load`（`:5498`） | 每次把模型加载回显存前先跑这条命令 |
| 按需拉起 | — | — | `ensure_started`（`:2674`）："POST /load and **every generation request**: start the engine now if it is unloaded" |
| 模型列表 | — | — | `/v1/models`（`:4317-4318`）未加载时 `status.value="unloaded"`，注释 "like llama-server's router: listed, loads on use" |

`ensure_loaded`（`:2584-2615`）顺序：跑 `before_load`（`subprocess.run(cmd, shell=isinstance(cmd,str), timeout=120, stdin=DEVNULL)`，失败只打印 `[strata] the before_load command failed (...); loading anyway`，不阻断）→ 查 `min_free_vram_mib`（不够每 0.5s 轮询最多 15 秒，仍不够 `raise GpuBusy`）→ 起 vision encoder → 起引擎。

模型启停端点：`POST /unload`（`:4378-4385`，200 `{"status":"unloaded"}`；busy→409；EngineStuck→503；`svc.unload` 在 `:2695-2715` 返回 `"unloaded"|"not loaded"|"busy"|"unsupported"` 并连带 `vision.unload()`）；`POST /load`（`:4386-4392`，200 `{"status":"loaded"}`；GpuBusy→503）。
Origin 防护：`_foreign_origin()`（`:4601-4608`）= `bool(origin) and origin.split("://",1)[-1] != Host and origin not in svc.trusted_origins` → **不带 Origin 头即放行**（注释 "no Origin is a client that is no browser"）；`_own_page()`（`:4552-4562`）要求 `Content-Type` 以 `application/json` 开头否则 415。GUI 的 `src-tauri/src/http.rs:14` 正好带这个头。

### 21.3 实现

**Rust 侧**

- `src-tauri/src/settings.rs`：`Settings` 新增 `strata_idle_unload_s: Option<i64>` / `strata_min_free_vram_mib: Option<i64>` / `strata_before_load: Option<String>`（`#[serde(default)]`）；`Default` 三个 `None`；`SettingsPatch` 三个 `Option<Option<..>>`；`apply` 三段，非正值/空白串一律落成 `None`（`v.filter(|n| *n > 0)`、`v.filter(|t| !t.trim().is_empty())`）。
- `src-tauri/src/strata.rs` 尾部新增 `fn service_target(root, config_file) -> Result<(String, u16, Option<String>), String>`（host/port/api_key 全取 config 顶层，host 空兜底 `127.0.0.1`）+ 两个命令：
  - `#[tauri::command] pub async fn strata_unload_model(root, config_file) -> Result<String, String>` → `POST /unload`，超时 60s
  - `#[tauri::command] pub async fn strata_load_model(root, config_file) -> Result<String, String>` → `POST /load`，超时 300s
  - 都走 `tauri::async_runtime::spawn_blocking` + `crate::http::request(host, port, "POST", path, Some("{}"), api_key, deadline)`；`http::request` 已把非 2xx 连原因转成 `Err("HTTP {status}：{msg}")`，所以 409/503 直接成为前端可见错误。
  - 为什么必须 Rust 侧发起：`StrataModelEntry::api_key` 是 `#[serde(skip_serializing)]`，密钥不下发 WebView。
- `src-tauri/src/lib.rs`：`invoke_handler` 注册 `strata::strata_unload_model` / `strata::strata_load_model`。

**前端**

- `src/types.ts`：`Settings` 加三个必填字段（`number | null` / `string | null`），`SettingsPatch` 加三个可选。
- `src/ipc.ts`：`strataUnloadModel(root, configFile)` / `strataLoadModel(root, configFile)`。
- `src/store.ts`：新增 `strataBaseName(path)` 模块级辅助；新增四个 action —— `ensureStrataLazy(configFile)`（读 config，`lazy_load !== true` 就写 `true` 并 `strataConfigWrite`，indent=1）、`stopStrataModel(configFile)`（`POST /unload`，引擎留着）、`startStrataModel(configFile)`（互斥卸 router → `ensureStrataLazy` → 引擎没跑或跑的是别的 config 就重启引擎，否则 `POST /load`）、类型声明同步。
- `src/store.ts` 的 `startStrata`（胶囊用）：启动前 `ensureStrataLazy`，notice 改为「Strata 引擎已启动 … 模型按需加载」。
- `src/store.ts` 的 `startModel`（router 加载模型）：显存互斥从 `stopStrata()` 改为 `ipc.strataUnloadModel(root, 运行中的 config)`，只在 `st.loaded` 为真时卸，notice「显存互斥：已卸载 Strata 的模型（引擎仍在运行，显存已释放）」，卸完 `probeStrata()`。
- `src/components/StrataPanel.tsx`：`ConfigCard` 新增 `engineHere: boolean` prop；状态胶囊四态 —— `isRunning`→`status-loaded`/`fa-check-circle`/运行中，`isLoading`→`status-loading`/`fa-spinner fa-spin`/加载中，`engineHere`→`status-stopped`/`fa-moon`/**已卸载**，否则 `status-stopped`/`fa-stop-circle`/已停止；启动按钮 title 按四态改写（卸载 / 加载 / 启动引擎并加载）。卡片调用点 `isRunning={runningFile === fileOf(e) && !!status.loaded}`、`engineHere={runningFile === fileOf(e) && !status.loaded}`。`toggleOne` 改为「本 config 模型已加载 → `stopStrataModel`，否则 → `startStrataModel`」，不再调 `stopStrata`。
- `src/components/SettingsPanel.tsx`：Strata 服务分组第二行新增「空闲卸载（秒）」「显存门槛（MiB）」「加载模型前执行的命令」+「开机自动启动 Strata」checkbox（即时 `saveSettings({auto_start_strata})`）；`saveStrataService()` 把填了的项写进所有 `strata-*.json` 顶层（`idle_unload_s` / `min_free_vram_mib` / `before_load`，留空不动原值），并 `saveSettings` 记录上次值；`fields` 汇总文案与说明文字同步。
- `src/App.tsx`：侧栏小字 `strataFootText` = 版本号 + 引擎在跑但模型未加载时追加「 · 模型已卸载」。

### 21.4 验证

- `npx tsc --noEmit` OK；`cargo check --lib` Finished 无 warning；`cargo test --lib` 84 passed / 0 failed / 5 ignored（`$env:TMP/$env:TEMP = "E:\Code\llama.cpp-GUI\.tmp"`）。
- 编译教训：`crate::http::request` 返回 `Result<String, String>`（非 2xx 已转 Err），**没有** `.status`/`.body` 结构体字段；`body` 参数是 `Option<&str>` 不是 `serde_json::Value`；`scan_configs` 返回 `Vec<StrataModelEntry>` 不是 `Result`；`spawn_blocking` 要用 `tauri::async_runtime::spawn_blocking`（`tokio` 不在依赖里）。
- 上一轮误写的 `crate::settings::strata_host_override()` / `strata_port_override()` 不存在（服务项覆盖机制在 b58 那轮已删除，改为直接写 config），已改为直接读 `entry.host` / `entry.port`。


### 21.5 本轮微调（用户 m03855）

- User said (m03855): "1、侧栏胶囊启动 Strata → 引擎起来、显存不占，小字只显示引擎版本；2、卡片点启动 → 胶囊从「已停止」转「加载中」再变「运行中」；再点 → 卸模型回到「已停止」，WebUI 仍可用；3、设置页把"开机自动启动 Strata"移动到启动与托盘分组的"打开程序就自动启动 router"下面并更名为"打开程序就自动启动 strata"；4、把设置-服务分组新加的几个strata参数与原strata参数放在一行中；5、统一设置-服务分组中所有文本框的长度，只有api-key的长度最小容纳24个字符并可以自动根据页面调整"
- `src/App.tsx`：`strataFootText` 回退为 `strataStatus.version ?? "版本未知"`（去掉「 · 模型已卸载」后缀）。
- `src/components/StrataPanel.tsx`：状态胶囊回到三态（运行中 / 加载中 / 已停止），去掉 `fa-moon`「已卸载」态 —— 卡片管的是模型，引擎在跑而模型已卸载时同样显示「已停止」。`engineHere` prop 保留，只用于启动按钮 title 区分「加载这个模型」与「启动引擎并加载这个模型」。
- `src/components/SettingsPanel.tsx`：
  - 「打开程序就自动启动 strata」checkbox 移到「启动与托盘」分组，紧跟「打开程序就自动启动 router」的 form-group 之后，沿用该分组的 `form-check` / `form-check-input` / `form-check-label` 结构，`onChange` 即时 `saveSettings({ auto_start_strata })`；说明文字写明「只拉起引擎（强制 `lazy_load: true`），不加载模型、不占显存」。服务分组里原来的 `checkbox-label` 版本已删除。
  - Strata 服务分组的六个输入项合并进同一个 `.row`（`flexWrap: "wrap"`）：监听地址 / 端口 / 空闲卸载（秒）/ 显存门槛（MiB）/ 加载前命令 / API Key / 保存按钮。
  - 宽度统一：前五项外层 `div` 与 `input` 都是 `width: 130`；API Key 是唯一弹性项，外层 `div` = `flex: 1, minWidth: "24ch"`，`input` = `minWidth: "24ch"`（容纳 24 个字符且随页面宽度伸缩）。
- 验证：`npx tsc --noEmit` OK。

## §22 同端口互斥 + 「卡片点了不加载」（用户 m00001）

### 22.1 需求

- User said (m00001): "我现在在strata中增加了一个模型，都是9090端口，在gui的strata页模型卡片中模型都无法启动，应该增加strata模型的互斥加载"。
- 实机：新 config `E:\AI\Strata\strata-sc117-swift-iq2-xs.json` 与旧 config `E:\AI\Strata\strata-swift-iq3_xxs.json` 顶层 `port` **都是 9090**（host/api_key 也相同）。

### 22.2 根因（两处，都在 GUI 侧）

1. **卡片播放按钮只起引擎、不 `/load`**（§21.3 的实现漏洞）：`startStrataModel` 的「引擎没跑 / 跑的是别的 config」分支只调 `ipc.strataStart(file)` 就结束，只有 else 分支（引擎已在跑**同一个** config）才 `strataLoadModel`。于是点一次播放 = 引擎起来但 `/health.loaded` 仍是 false → 胶囊停在「已停止」= 用户看到的「模型无法启动」；**再点一次**才走 else 分支把模型加载起来。实测日志正是这个节奏：22:34:56 python 起 → 22:35:07 `engine started` → 22:35:23 `session is up (engine 0.1.41)`。
2. **同端口归属靠猜**：`strata::probe` 丢弃了 `/health` 的 `model` 字段，`probe_strata_ports` 的归属取自「探测目标元组」，而目标里把**选中的 config** 排在第一个 —— 两份 config 写同一个 9090 时，在跑的实例永远被记到选中 config 的卡片上。后果：点真正在跑的那张 → `strataStop()` → 槽里没有进程 → 报「不是由本 GUI 启动的」；点被误判为运行的那张 → 对**错误的 config** 发 `/load`。
3. 附带：切 config 时直接 `force_kill_tree` 强杀旧引擎，既不先 `POST /unload`（上游会顺手保存 learned expert profile、立刻释放显存），也不区分「GUI 起的实例」与「用户自己跑 `run-<model>.bat` 的实例」。

排除的假设：`TIME_WAIT` **不会**让 `winfix::port_in_use` 误报（实测：9095 上起 `python -m http.server` 再强杀，netstat 仍有该端口的 TIME_WAIT，Rust `TcpListener::bind` 立刻 `BIND_OK`；有监听者时 `BIND_FAIL` os error 10048）→「端口已被占用」不是 TIME_WAIT 造成的。

### 22.3 实现

**Rust**

- `strata.rs::probe`：把 `/health` 的 `model` 写进 `st.model_name`（非空才写）—— 端口上到底跑的是哪份 config，这是唯一权威判据。
- `lib.rs::attribute_strata_hit`（新增）：按模型名反查 `(模型名, config 路径)` 列表修正归属；拿不到模型名或对不上任何 config 时才退回端口归属。
- `lib.rs::merge_strata_probe`：以 `fresh.model_name` 为准。
- `lib.rs::spawn_strata`：`port_in_use` 命中时先 `probe(port, api_key)`，把占用者写进报错 —— `端口 9090 已被占用（sc117-swift-iq2-xs）。…`。
- `lib.rs::strata_start`：槽里已有进程时报 `Strata 已在运行（<模型>，端口 :9090）。一个引擎只服务一份 config，先停止它再启动这个模型`（原来是干巴巴的「Strata 已在运行」，同端口两 config 时用户无从下手）。
- `lib.rs::strata_stop`：外部实例的报错带上快照里的模型名 —— `端口 :9090 上的 Strata（sc117-swift-iq2-xs）不是由本 GUI 启动的…`。

**前端**

- `store.ts::startStrataModel` 重写：切换模型时先 `POST /unload`（**仅 GUI 自己起的实例**：`st.loaded && !st.external`，失败不阻断）再 `strataStop()`；之后**两条分支统一走到 `ipc.strataLoadModel`**，成功 notice 写明「已停止 X（同端口互斥）→ 已加载 Y」。
- `StrataPanel.tsx`：`ConfigCard` 新增 `runningElsewhere: string | null` prop（同端口在跑的是别的模型时填模型名），播放按钮 title 变成「启动并加载这个模型（Strata 互斥：会先停止正在运行的 X）」；底部提示行在有多份 config 共用同一端口时补一句「多份 config 共用同一端口，同时只能跑一个（启动会先停掉正在跑的那个）」。

### 22.4 验证

- `npx tsc --noEmit` OK；`cargo test --lib --offline` **94 passed / 0 failed / 5 ignored**（基线 93 + 新增 `strata_hit_follows_live_model_name_on_shared_port`：同端口两份 config、`/health` 报的是另一份 → 归属必须纠正；模型名对不上 / `model` 缺失 → 退回端口归属）。
- 待用户在真机 GUI 上确认：点卡片 → 胶囊「加载中」→「运行中」；点另一张卡片 → 先停掉前一个再加载（9090 上同时只有一个实例）。

### 22.5 两个模型的 expert profile 分开（用户 m00386）

- User said (m00386): "两个模型的--expert-profile应该指向不同的文件"。
- 起因：两份 config 原来都读**出厂** profile `E:\AI\Strata\data\expert-profile.bin`。这不是 bug —— `setup.py:5226` 写的是 `fam.get("profile", "expert-profile.bin")`，即按**模型家族**给默认值，Swift 家族的 iq3_xxs 与 IQ2_XS 因此同名。
- 上游的正解就在 config 里：`serve/server.py:2105 learned_profile_args()`（#477，引擎 0.1.36+）认顶层键 `expert_profile_save`，让「下次启动从 learned 文件开始，而不是 config 的 `--expert-profile`」；判定只用 `profile_shape()`（读 STRP 头部的 层数 × 专家数），命中时 `server.py:2124 args[i] = save` —— 引擎最终拿到的就是 `--expert-profile <learned> --expert-profile-save <learned>`，**同一文件自读自写是上游的稳态**（`serve/test_server.py:1925` 正是这么断言的）。但 `server.py:2112` 在 args 里已含 `--expert-profile-save` 时整条逻辑直接 return；GUI 这两份 config 都是显式 args 形态，所以自动切换从来不发生。
- 实测 STRP 头（读前 24 B，`<5I` = 版本,nl,ne,n,?）：`expert-profile.bin` / `expert-profile-learned.bin` / `expert-profile-learned-iq2abl.bin` 全是 `nl=48 ne=512 n=24576`、196632 B（= 24 + 8×24576）；`expert-profile-coder.bin` 是 `48×256 / 12288 / 98328 B`。形状按家族区分，引擎的 shape 校验有效。
- 改动（2026/10/10 22:47，**直接改文件**，不是 GUI 写入，符合 §7 R6「GUI 永不写 `args` 里的路径类参数」）：`strata-sc117-swift-iq2-xs.json` 的 `--expert-profile` → `E:\AI\Strata\data\expert-profile-learned-iq2abl.bin`；`strata-swift-iq3_xxs.json` 的 `--expert-profile` → `E:\AI\Strata\data\expert-profile-learned.bin`。两者都等于各自已有的 `--expert-profile-save`（自读自写），出厂 profile 不再被任何 config 使用。备份在 config 同目录：`.bak-20261010-224726`（两份）。改后 JSON 解析通过、其余字段逐字未动（sc117 1838→1853 B，iq3_xxs 1724→1732 B）。
- 不会被冲掉：`setup.py:3578`（#775 `keep_user_profile`）在重生成 config 时会**保留**用户手接的 `--expert-profile`（条件：是另一个仍然存在的文件）与 `--expert-profile-save`。
- GUI 侧无需改动：`--expert-profile*` 属安装事实类 flag，在参数表单里只读列出（`src/utils/strataParams.ts:32-38` 的 `STRATA_INSTALL_FACT_FLAGS`，`strataParams.ts:468` 把它们归进 installFacts），L2 原文编辑才能改。
- 未决（未改）：`--vram-reserve-mib 0` + `--max-context 204800` 同时加载完时报 `0 MiB of VRAM free with everything loaded - LOW: requests may stall; add --vram-reserve-mib 512 to the config's args (or lower --max-context)`。

### 22.6 参数表加「采样」分组（用户 m00454）

- User said (m00454): "strata的模型参数表中加上采样分组： "temperature"、 "top_p"、 "top_k"、"min_p" 参数选项"。
- 上游语义（`serve/server.py:5270 sampling_defaults_from_config(cfg)` 与 `docs/DETAILS.md:1060-1067`）：config 顶层可选 `sampling` 块 = **请求自己没带采样字段时的默认值**；请求自带的字段永远优先（显式 `temperature: 0` 仍是 greedy）；**整块缺失**时，不带采样字段的请求按 greedy 解码。上游认的键还有 `presence_penalty` / `repetition_penalty` / `frequency_penalty` / `penalty_last_n` / `seed`，块里也放过实验开关键（`docs/DETAILS.md:1427` 的 `experimental_speed_projection`）。`docs/DETAILS.md:821-828`（#564）说明上游 WebUI 的 Model settings 卡片改的就是这四个键，语义是「**空字段 = 删掉该键**（回默认）」。
- **坏值 = 引擎起不来**：`server.py:5282-5297` 逐键校验并 `raise SystemExit` —— `temperature` 需 ≥ 0、`top_p` 需 `0 < v ≤ 1`、`min_p` 需 `0 ≤ v ≤ 1`、`top_k` 需 `1..64` 的整数（上游文案 `the sampled path takes an integer 1..64`）。所以表单不能只做透传。
- 实现（都在前端，Rust 一行未改）：
  - `src/utils/strataParams.ts`：新分组 `{ id: "sampling", label: "采样", order: 3, collapsed: false }`，插在「加速与缓存」与「多模态」之间（`ParamForm` 按 `schema.groups` 的**数组顺序**渲染，`order` 只是记录；vision/serve 的 order 顺延为 4/5）。
  - 4 个参数走**哨兵 flag** 模式（与既有的 `--vision-mmproj` 同款）：表单 key `sampling-temperature` / `sampling-top-p` / `sampling-top-k` / `sampling-min-p`，`flag` 只是占位（`--sampling-*`），并进 `TOP_LEVEL_KEYS` → `stateToArgs` 跳过它们，**永不进 `args`**（引擎不认这些 flag，塞进去会启动失败）。类型 FLOAT/FLOAT/INTEGER/FLOAT，`uiType: null` + `values: []` → `ParamForm` 渲染成数字输入框（FLOAT 带 `step=0.01`）。
  - `SAMPLING_KEYS` 一张表驱动三处：`configToState`（读 `cfg.sampling.*`，键缺失 = 未启用 + schema 默认值当占位）、`stateToConfig`（勾选且取值合法 → 写**数字**，`top_k` 走 `Math.trunc`；未勾选或清空 → `delete` 该键；块里 GUI 不认识的键原样保留；四个键都没了且块内无其它键 → 整块删掉）、导出的 `validateStrataSampling`。
  - `src/components/StrataPanel.tsx::save()` 在 `stateToConfig` 之前调 `validateStrataSampling(formState)`，报错如 `采样参数「top_k」的取值 "100" 不合法：上游要求 1..64 的整数，否则 Strata 启动时会直接退出`（清空不算错，那是「回默认」）；`StrataPanel.tsx` 顶部注释与 `stateToConfig` 的两处 R6 注释同步补上 `sampling.*`。
  - 没动 Rust 侧：`strata.rs::write_config_raw` 的 W5 校验只要求顶层有 `exe`、`args` 是数组，多一个 `sampling` 块自然通过；`StrataModelEntry` 也不解析它。
- 验证：`npx tsc --noEmit` OK；`scripts/smoke-paramform.entry.tsx` 新增 Strata 段落（用 `strataParamSchema` 渲染 + 读写往返 + 坏值拦截断言），实测输出 `采样往返 OK（坏值拦截: 采样参数「top_k」的取值 "100" 不合法…）`、`全部通过 ✅`（82 参数 / 10 分组）；断言覆盖「取消勾选后 `top_k` 被删」「`min_p` 保持数字 0」「`experimental_speed_projection` 原样保留」「args 一个 token 都没变」「清空合法」。
- **受限沙箱下 `npm run test:smoke` 必失败**（esbuild 由 Node `child_process.spawn` 以 `stdio:'pipe'` 拉起 → 命名管道被禁 → `Error: spawn EPERM`，`errno -4048`）。绕法：PowerShell 里直接跑 `node_modules\@esbuild\win32-x64\esbuild.exe scripts\smoke-paramform.entry.tsx --bundle --platform=node --format=esm --packages=external --jsx=automatic --outfile=tmp\smoke-paramform.mjs`，再用一个补了 `localStorage` 替身的小 .mjs `import` 产物（与 `scripts/smoke-paramform.mjs` 的两步等价）。
- 显示修正（用户 m00645）：config 里的 `sampling` 值是 JSON 数字，`String(1.0)` 得到 `"1"`、`String(0)` 得到 `"0"`，参数表看起来像被抹掉了小数位。`strataParams.ts` 新增 `samplingText(s, v)`：浮点键补足一位小数（`1` → `1.0`、`0` → `0.0`，`0.95` 不变），整数键 `top_k` 原样（`20`），非数字回落 `String(v)`；`configToState` 用它回填，`min_p` 的 schema 默认值同步由 `"0"` 改成 `"0.0"`。**只影响显示**，写回仍是 JSON 数字（`stateToConfig` 一行未改，所以「0.90 → 0.9」这类超过一位的尾零仍会随 JSON 归一化丢失）。
- 待用户在真机确认：配置弹窗里出现「采样」分组、四个值按现有 config 回填（`1.0 / 0.95 / 20 / 0.0`）、保存后 config 顶层 `sampling` 被更新且未知键仍在。冒烟测试已断言 state 与渲染 HTML 里都是这几个字符串（`value="1.0"` / `value="0.95"` / `value="0.0"`）。

### 22.7 前门代理（B 方案，用户 m00752 / m00773 / m00798）

- 需求演进：m00645 问「strata 的模型现在支持 dsh 客户端拉起吗」→ m00743「在 gui 已经运行的情况下，strata 下有两个模型，dsh 都能实现选中任意模型都可以直接用吗」→ 实测**不能** → m00752「我选B方案，但是左下角的胶囊显示的端口和设置页 strata 服务的端口都是代理的端口」→ m00773「这样的话，strata 引擎，每个模型的端口不同也可以吧」→ **m00798「我的建议是前面的端口是9090，两个模型分别是9091和9092」**。
- 为什么必须要代理（上游事实，全部有出处）：`server.py:4404-4405`（按 id 的端点在 `:4492-4493`）拿请求里的 `model` 与**当前实例**的 `svc.model` 比对，不符直接 `404 {"error":{"message":"model not found"}}`；`server.py:4310-4323` `/v1/models` 只列当前实例的模型（未加载时 `data: []`）；绑定端口的是 `server.py:5339 ap.add_argument("--port", type=int, default=8095)` 与 `:5559 httpd = serve(svc, host=a.host, port=a.port)`，**config 的 `port` 上游不读**（只有 `--host`/`--gpu` 的帮助文本写 "also … in the config"）。
- 端口布局（本机实机已改，改前逐份备份 `<文件名>.bak-20261011-165150-engineport`）：前门 `127.0.0.1:9090`（GUI 设置 `strata_host` / `strata_port`）；`strata-sc117-swift-iq2-xs.json` → `9091`、`strata-swift-iq3_xxs.json` → `9092`，两个 `run-*.bat` 的 `--port` 同步改（`Select-String '9090'` 改后 0 命中）。
- 后端新增 `src-tauri/src/strata_proxy.rs`（约 700 行，不引入任何依赖，手写 HTTP）：
  - `pub fn start(app, host, port) -> Result<ProxyHandle, String>`：非阻塞 `accept` + 30 ms 轮询 + 每连接一线程；`ProxyHandle{port, stop: Arc<AtomicBool>, _listener}`；绑定失败文案提示「引擎可能正占着这个端口（旧布局里引擎就写 9090）」。
  - `serve` 主流程：读头（限 64 KiB，逐字节读到 `\r\n\r\n`）→ `Expect: 100-continue` 先回 100 → 读体（chunked 也支持，限 64 MiB）→ `GET /v1/models|/models` 走 `models_payload` 合成全部 config → 从请求体（限 4 MiB 解析）或 `/v1/models/<id>` 路径取 `model` → 没有引擎时的 `GET /health` 由前门合成（`{"status":"ok","service":"strata","loaded":false,…,"proxy":true}`）→ `resolve_target` → `ensure_engine` → `forward`。
  - `resolve_target`：点名必须精确等于某份 config 的 `model_name`，否则 404 `model not found: {name}`；未点名按 当前引擎 → 选中 config → 第一份。
  - `ensure_engine`（持 `state.strata_switch`）：①已经是这份 config 的引擎 → 直接转发；②端口上探测到的 `model_name` 与目标相同 → 直接用（用户自己跑的 `.bat` 也算）；③有 GUI 引擎 → 停它 + `strata::wait_port_free(old_port, 20s)`，失败报「端口 :N 在 20 秒内没有释放，无法切换到 X」；④`crate::strata_start_engine(app, state, Some(file))`（与卡片、胶囊**同一条启动路径**，报错文案一致）。
  - `forward`：跳掉 `host` / `connection` / `accept-encoding` / `expect` / `proxy-connection`，补 `Host: {host}:{port}` 与 `Connection: close`，**清掉客户端读超时**（流式响应之间的静默期不能被打断），引擎→客户端用本线程 `io::copy`、客户端→引擎用一个 pump 线程，收尾双向 `shutdown(Both)` + `pump.join()`。
  - 命令 `strata_proxy_start` / `strata_proxy_stop`（端口取 `settings.strata_host`/`strata_port`，缺省 `127.0.0.1:9090`），`shutdown(&state)` 给退出用；`apply_to(&state, &mut StrataStatus)` 把 `proxy` / `proxy_port` 写进每一份对外快照。4 个单测（读头、body 取 model、100-continue 大小写、`0.0.0.0` → `127.0.0.1`）。
- 接线：`state.rs` 加 `strata_proxy: Arc<Mutex<Option<ProxyHandle>>>` 与 `strata_switch: Mutex<()>`；`strata.rs` 的 `StrataStatus` 加 `proxy: bool` / `proxy_port: Option<u16>`（`#[serde(default)]`），新增 `wait_port_free`，`spawn_strata` 校验 run 脚本 `--port` 与 config `port` 一致；`lib.rs` 抽出 `strata_start_engine`（命令只转调它）、新增 `strata_snapshot`（快照 + `apply_to`）/`strata_busy`、`strata_start_engine` 与 `strata_stop` 都 `apply_to` 后再 emit（否则前门开着时前端会闪一下「前门未运行」）、注册两个命令、退出关前门；`tray.rs` 的 `strata_slot_busy` 改用 `crate::strata_busy`、`quit` 里关前门。
- 前端：`StrataStatus` 加 `proxy` / `proxy_port`；`ipc.strataProxyStart/Stop`；`store.startStrataProxy/stopStrataProxy`（启动前照旧走显存互斥卸 router 的 loaded 模型）；**「打开程序就自动启动 strata」改为拉起前门**（不再要求选中 config、不再写 config 的 `lazy_load`）；侧栏胶囊前门优先（`Strata 前门 · :9090`，只有前门没开时才显示 `Strata 引擎 · :9091`，点击 = 前门开则停前门、否则引擎在跑停引擎、都没有就起前门）；设置页「服务」分组改名「Strata 前门 / 服务项」，加前门状态与启停按钮，前门地址/端口**不再写 config**、只存 GUI 设置；Strata 面板工具栏加前门按钮、底部文案显示前门端口与引擎状态。
- 验证：`cargo check --lib` exit 0（15 s，无警告）；`cargo test --lib` **98 passed / 0 failed / 5 ignored**（其中 `strata_proxy::tests::*` 4 个全过）；`npx tsc --noEmit` exit 0。⚠️ **沙箱里 `cargo test --lib` 会报 30 个 `拒绝访问。 (os error 5)`**（会话 TEMP 目录不可写，与 §22.6 的 esbuild 那条同源，跟本轮改动无关），必须先把 `$env:TEMP` / `$env:TMP` 指到 `E:\Code\llama.cpp-GUI\tmp` 再跑；用管道接 cargo 时 `$LASTEXITCODE` 是 `Select-String` 的，判成败只能看输出文本。
- 已知限制 / 待真机确认：切换引擎 + 首次加载约 20–30 s，客户端超时要 ≥60 s；前门对其它路径（含 `/v1/chat/completions` 与引擎自带 WebUI）原样透传；前门开着但引擎没起时，`strata_probe` 的 `running` 仍是 false（前门只在 `proxy` 字段里体现），所以面板的「刷新状态」按钮此时是灰的。
- 术语与胶囊文案（用户 **m01151 / m01218**）：用户拍板 **①各个模型端口保持不同**（不做"全部 config 并到同一端口"的简化）；②侧栏胶囊文案是「**Strata 代理 :9090**」（不用"前门"这个词、端口前不放 `·`，只有代理没开时才显示 `Strata 引擎 :9091`）；③胶囊下方那行**始终显示引擎版本**（用户原话「依然显示 Strata 引擎的版本」）—— `strataStatus.version`（`/props` 的 build_info）优先，引擎没起时回落到扫描到的 `strataEntries[0].engine_version`（`BUILD.json`，同一套引擎安装各 config 相同），都没有才是「版本未知」；代理端口改放在胶囊 title 与面板/设置页文案里。GUI 里用户可见的「前门」字样统一改成「代理」（`App.tsx` / `StrataPanel.tsx` / `SettingsPanel.tsx`），代码标识符与本文档仍叫 `proxy` / 前门。




### 22.8 代理「DSH 连不上 / 请求被提前取消」的两个根因（用户 m01266）

用户原话（m01266）："1、代理工作有问题，dsh是把模型加载了，但是连接不上；2、由dsh请求导致的strata模型加载在模型卡片没有显示加载中，而是在加载后直接显示运行中"。

**定位手段**：给前门加逐跳诊断日志（**默认关闭**，设 `STRATA_PROXY_DEBUG` 才写 `%TEMP%\strata-proxy-debug.log`，panic 也写进去）。注意用户跑的是**装好的便携版** `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（配置在同目录 `settings.json`），复现必须把新构建覆盖到那里再启动。

**根因一（连接被 RST / 请求被取消）**：`start()` 对**监听**套接字调 `listener.set_nonblocking(true)`（非阻塞 accept + 30 ms 轮询），而 **Windows 上 `accept()` 返回的套接字会继承这个非阻塞标志**：

- 「客户端 → 引擎」的 pump 线程第一次 `read` 立刻拿到 `WouldBlock`，日志原文 `pump: 客户端读 Err(无法立即完成一个非阻止性套接字操作。 (os error 10035)) → shutdown(上游 Write)`，跳出循环并 `shutdown(上游, Write)`；
- 上游 `serve/server.py:4127-4150 _watch_client` 每 0.5 s `select` + `recv(1, socket.MSG_PEEK) == b""` 就把「读到 EOF」判成客户端挂断并 `cancel.set()`，而取消只在**提示读取的分块边界**生效（`server.py:317`，块 8192 token）⇒ 症状是「小 prompt（<0.5 s 读完）侥幸成功、18859 token 的 prompt 在第一个块边界（约 5.7 s）被截断」，引擎日志打 `0 generated ... (cancelled)`；
- 同一非阻塞状态还让 `read_head` / `read_body`（`read_exact`）在时序不利时 `WouldBlock` → `serve` 返回 Err 并在请求体未读走时关连接 ⇒ 客户端 RST（「你的主机中的软件中止了一个已建立的连接」）。

**修复**（`src-tauri/src/strata_proxy.rs`）：① `handle_connection` 第一件事 `let _ = client.set_nonblocking(false);`；② `forward` **删掉**客户端→上游的 pump 线程（请求体已由 `read_body` 整段读完、上游是 HTTP/1.0 + `Connection: close`，没有需要转发的客户端字节），只做单向 `io::copy(上游 → 客户端)`。

**根因二（卡片不显示「加载中」）**：DSH 请求触发的引擎启动/模型加载是**前门**发起的，前端 `strataStarting` 只覆盖「用户在本页点启动」，所以卡片从「已停止」直接跳到「运行中」。修复：`state.strata_proxy_serving`（LIFO 栈）+ `Serving` 守卫（`Serving::begin` push 并广播 `strata://status`，`Drop` 时摘掉再广播一次）→ `StrataStatus.proxy_serving`（config 文件名）→ `StrataPanel.tsx` 的 `isLoading = starting === fileOf(e) || (status.proxy_serving === fileOf(e) && !status.loaded)`。**不能用引擎 `/status` 的 `busy`**：实测 `loaded=true`、请求结束后仍连续 40 s 报 `busy=true`。

**真机验证（2026-10-11，冷启动整链路）**：`POST http://127.0.0.1:9090/v1/chat/completions`（唯一 prompt 78403 B ≈ 19k token，`stream:true`）→ 日志 `ensure ④起新引擎 strata-swift-iq3_xxs.json` → `Ok(())`、`forward 已写上游 78578 字节（头 175 + body 78403）`、`io::copy 结束，向客户端写 4835 字节`；客户端首字节 22.9 s、总 65.9 s、4835 B、18 个 chunk、含 `[DONE]`、`predicted_n: 16`（完整 SSE，引擎的 `: keep-alive` 心跳也完整穿过）。**修复前**同一请求 5561 ms 只收到 428 B 且无 `[DONE]`。随后 `cargo test --lib` 98 passed / 0 failed / 5 ignored、`npx tsc --noEmit` exit 0、`npm run tauri build` exit 0。

**给下一位的提醒**：改前门转发（`forward` / `handle_connection`）后必须用 **>8k token 的未缓存 prompt** 经 9090 复测完整 SSE（小请求会掩盖这个 bug）；排查时开 `STRATA_PROXY_DEBUG=1`。
