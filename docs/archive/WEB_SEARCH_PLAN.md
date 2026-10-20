# 联网搜索功能方案（复用 dsh-free-search）

> 目标读者：接手实现的人。本文所有结论都来自本机实测，实测命令与原始输出留在 `tmp/fs-*.log`。
> 撰写日期：2026-10-13。上游插件版本：**dsh-free-search 0.8.8**。
> **2026-10-14 路线变更：决策已定稿 —— 不引入 Node 运行时，搜索改在 Rust 里重写，只保留 5 个引擎。先读 §11 决策结果：§2.1 / §2.2 / §2.3 / §3 复用清单 / §5 sidecar 契约 / §8 进程生命周期 / §9 的 P5 均已作废**（下文保留作为实测依据与行为参考，实测数据仍然有效）。
> **实施状态（0.2.0，2026-10-20 复核）**：已落地 —— 后端 `src-tauri/src/search.rs`（五引擎 anysearch / tavily / firecrawl / keenable / exa，HTTP 走系统 `curl.exe`，配置 `search.json`），前端聊天设置里的「联网搜索」开关与 `web_search` 工具；0.2.0 又补了「取全文 + `web_fetch` 读网页正文 + AnySearch `/v1/extract` 兜底」（见 `HANDOVER.md` 末尾两节）。`web_fetch` 原本在 §11 被列为「本轮不做」，现已实现。

---

## §0 目标与范围

给 GUI 的原生聊天界面加联网搜索。用户已明确范围：

| 项 | 决定 |
|---|---|
| 零配置引擎 | **只保留 anysearch**（免密钥、实测可用） |
| 可选填 key 的引擎 | **keenable / tavily / exa / firecrawl**（四家都有免费额度，域名国内直连可达） |
| 不做的引擎 | bing、ddg、ddg-lite、searxng、jina、perplexity 以及其余 17 个引擎 —— **代码保留，设置里不提供入口** |
| 实现路线 | 复用插件本体（Node sidecar），不重写成 Rust |
| 搜索之外 | `web_fetch`（网页抓取，供模型读原文）**列为可选阶段**；`research` 多轮检索、`vertical` 垂直源、`weather`、`platform_search` 本轮不做 |

---

## §1 实测依据（2026-10-13，本机 Node v25.2.1，**无代理**）

环境：已确认无 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` 等环境变量。

### 1.1 引擎实测（直接调用插件导出的引擎函数）

| 引擎 | 调用 | 耗时 | 结果 |
|---|---|---|---|
| **anysearch** | `searchAnysearch(q, 5, signal)` | 4212ms（中文）/ 4532ms（英文） | ✅ 各 5 条 |
| bing | `searchBing(q, 5, opts, signal)` | 1077ms / 374ms | ✅ 5 条（**用户已决定不用**） |
| ddg | `searchDdgHtml(...)` | 31626ms | ❌ `TypeError: fetch failed` |
| ddg-lite | `searchDdgLite(...)` | 31870ms | ❌ `TypeError: fetch failed` |
| searxng | `searchSearxng(...)` | 36022ms | ❌ `all SearXNG instances failed`（6 个公共实例全挂） |

anysearch 的中英文结果质量都明显好于 bing 的 HTML 抓取：

- 中文「llama.cpp 本地推理」→ 首条 `llama.cpp - Qwen - Read the Docs`
- 英文「llama.cpp release notes」→ 首条 `Releases · ggml-org/llama.cpp`

原始输出：`tmp/fs-engines-probe2.log`

> **踩过的坑**：引擎函数返回的是 `{ sources: [...], truncated: false }`，**不是数组**。第一版探针按数组解析，把 bing / anysearch 误判成「0 结果」。写 sidecar 时务必按这个形状取。

### 1.2 各服务域名连通性（18 个目标，直连 8s 超时）

| 域名 | 结果 | 判定 |
|---|---|---|
| `api.anysearch.com` | HTTP 404（GET 不支持，POST 可用） | ✅ 可达 |
| `api.keenable.ai` | HTTP 401 | ✅ 可达 |
| `api.tavily.com` | HTTP 401 | ✅ 可达 |
| `api.exa.ai` | HTTP 404 | ✅ 可达 |
| `api.firecrawl.dev` | HTTP 405 | ✅ 可达 |
| `mcp.exa.ai` | HTTP 405 | ✅ 可达 |
| `api.serply.io` / `api.parallel.ai` | HTTP 401 | ✅ 可达（本轮不用） |
| `api.deepseek.com` / `dashscope.aliyuncs.com` / `api.moonshot.cn` / `ark.cn-beijing.volces.com` | HTTP 401 | ✅ 可达（模型内置搜索，本轮不用） |
| `html.duckduckgo.com` / `lite.duckduckgo.com` | 8s 超时 | ❌ 需代理 |
| `s.jina.ai` | 8s 超时 | ❌ 需代理 |
| `api.perplexity.ai` | 8s 超时 | ❌ 需代理 |
| 6 个公共 SearXNG 实例 | 全超时 | ❌ 需代理 |

原始输出：`tmp/fs-conn-probe.log`

### 1.3 四家可选引擎的免费额度（外部资料，需注册时复核）

| 引擎 | 免费额度 | 来源 |
|---|---|---|
| **keenable** | **10 万次请求/月**（额度最大） | [keenable.ai/pricing](https://keenable.ai/pricing) |
| tavily | 1000 credits/月 | [docs.tavily.com](https://docs.tavily.com/documentation/api-credits) |
| exa | 每月 $10 额度（约 2500 次 Instant 搜索） | [exa.ai/pricing](https://exa.ai/pricing?tab=api) |
| firecrawl | 1000 credits/月 + 1000 搜索 credits | [firecrawl 评测](https://thunderbit.com/blog/firecrawl-review-and-alternatives) |

**默认回退顺序建议**：`anysearch → keenable → tavily → exa`（anysearch 零配置先兜底，keenable 额度最大排第二）。

### 1.4 插件本体事实

路径（当前机器）：`C:\Users\WuChun\.dsh\profiles\desktop\node_modules\dsh-free-search`
规模：15 个文件 / 573 KB。核心代码行数：

| 文件 | 行数 | 作用 | 是否要用 |
|---|---|---|---|
| `lib/index.js` | 4567 | 全部引擎实现 + 路由 + 回退 + 缓存 + 工具注册 | ✅ 复用 |
| `lib/research.js` | 1275 | 多轮检索 + brief | ❌ 本轮不做 |
| `lib/vertical.js` | 589 | 45+ 垂直数据源 | ❌ 本轮不做 |
| `lib/fetch_provider.js` | 231 | `web_fetch` 质量链（T1 直连→T2 exa→T3 firecrawl→T4 crawl4ai） | ⚠️ 可选阶段 |
| `lib/mcp_adapter.js` | 182 | zhihu 等 MCP 引擎 | ❌ 不做（GUI 无 MCP） |
| `lib/weather.js` | 171 | 天气 | ❌ 不做 |
| `lib/fetch_upstream.js` | 97 | exa / firecrawl / crawl4ai 抓取封装 | ⚠️ 随 fetch 阶段 |
| `lib/domain_filter.js` | 94 | 域名黑名单 | ✅ 复用 |
| `lib/rerank.js` | 85 | 结果重排 | ⚠️ 可选 |
| `lib/cache.js` | 44 | 结果缓存 | ✅ 复用 |
| `lib/client.js` | 1795 | **DSH 的 React 设置界面** | ❌ 不搬（技术栈不同，重写） |

**导出（`lib/index.js:4684` 的 `export {}` 块，共 84 个符号）**，对本方案有用的：

- 常量：`ALL_ENGINES`(:91，27 个)、`FREE_ENGINES`(:90，5 个)、`EXPLICIT_ONLY_ENGINES`(:94)、`TIME_ENGINES`(:167)、`TIME_RANGES`、`PLATFORMS`、`SEARXNG_INSTANCES`(:639)、各 URL 常量(:37-50)
- 纯函数：`routeEngines(query, opts)`(:218)、`parseTimeRange`、`approximateTimeRange`、`normalizeDisabledEngines`、`normalizeFallbackOrder`、`normalizeFallbackOn`、`classifyFailure`、`FAILURE_CLASSES`、`engineCooldowns`、`COOLDOWN_SESSION_MS`、`DEFAULT_FALLBACK_ON`、`DEFAULT_FALLBACK_ORDER`、`Config`(schemastery schema)、`wrapUntrustedBlock`, `stripBoundaryTags`、`buildCacheKey`(:365)
- 引擎函数（40+ 个）：`searchAnysearch(query, maxResults, signal, apiKey)`(:706)、`searchKeenable`、`searchTavily`、`searchExa`、`searchFirecrawl`、`searchBing`(:596)、`searchDdgHtml`(:494)、`searchDdgLite`(:525)、`searchSearxng`(:641)…

**签名注意**：多数引擎是 `(query, maxResults, options, signal)`，但 **`searchAnysearch` 是 `(query, maxResults, signal, apiKey)`** —— 第 3 个参数就是 signal，容易写错。

**对 DSH 运行时的依赖面**（`lib/index.js` 内 `ctx.*` 出现次数）：
`ctx.web` 14、`ctx.effect` 9、`ctx.inject` 9、`ctx.tools` 6、`ctx.settings` 3，另有 `ctx.fiber`/`ctx.get`/`ctx.logger`/`ctx.on`/`ctx.systemPrompt`/`ctx.webServer` 各 1 —— **合计约 50 处，且全部集中在 `apply(ctx, config)`（:3252）外壳里**。

实测验证（`tmp/fs-probe.mjs`）：直接 `import` 该模块成功（84 个导出符号），`routeEngines("北京今天天气", {timeRange:"week"})` 返回把 baidu/doubao/zhihu 排在前的语言池顺序，`routeEngines("latest llama.cpp release", {})` 返回把 bing/exa/tavily 排前的顺序 —— **搜索核心确实能脱离 DSH 运行**。

---

## §2 架构选择

### 2.1 为什么复用插件而不是 Rust 重写

three 个理由，按重要性排：

1. **引擎函数的耦合度极低**：40+ 个引擎都是模块级 `async function`，已经被 `export` 出来，输入输出都是纯数据（query + options → `{sources, truncated}`）。不需要理解插件的 `apply()`。
2. **上游会持续更新**（插件已到 0.8.8，含失败分类、冷却、sticky key 失效、时间过滤映射等成熟逻辑）。重写成 Rust 意味着这些都要自己维护，且每加一个引擎都要写 Rust。
3. **CSP 不构成障碍**：现有 `connect-src http://127.0.0.1:* http://localhost:*` 允许前端直连本地 sidecar，不需要把搜索流量塞进 Rust 再转发一次。

### 2.2 进程拓扑

```
┌─────────────────────────────────────────────┐
│ Tauri GUI (Rust)                            │
│  ├─ 进程管理：拉起/回收 sidecar（见 §8）      │
│  └─ 转发？不需要 —— 前端直连 sidecar          │
├─────────────────────────────────────────────┤
│ 前端 (React + WebView)                       │
│  └─ fetch → http://127.0.0.1:<随机端口>/search│
├─────────────────────────────────────────────┤
│ search-sidecar (Node ≥20)                    │
│  ├─ HTTP 服务（§5 契约）                      │
│  ├─ shim：假 ctx（web/tools/settings/logger） │
│  ├─ dsh-free-search/lib/*.js（原样打包）      │
│  └─ 配置读取：<数据目录>/search.json          │
└─────────────────────────────────────────────┘
```

与现有三条通道（router / Strata / 前门代理）并列，成为**第四个子进程**，必须纳入同一套进程管理（日志、托盘、退出清理、失败降级）。

### 2.3 Node 运行时的三种选择（**待用户决策**）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| a | 随应用附带 `node.exe`（约 80 MB） | 用户零依赖 | 安装包变大；要跟 Node 安全更新 |
| b | 复用本机 Node（`node --version` ≥20 则启用） | 开发期最省事、包体不变 | 普通用户机器上多半没有 Node → 功能自动隐藏 |
| c | 用 Node SEA / 打包成单 exe | 对外只有一个可执行文件 | 打包与调试成本最高，体积与 a 接近 |

**开发阶段建议 b**，发布前再评估 a 或 c。

---

## §3 复用什么 / 改什么 / 不做什么

### 复用（原样打包，不改一行为好）
- `lib/index.js` 的**引擎函数与纯工具函数**（见 §1.4 清单）
- `lib/domain_filter.js`（域名黑名单）、`lib/cache.js`（结果缓存）
- 可选：`lib/fetch_provider.js` + `lib/fetch_upstream.js`（`web_fetch` 质量链）
- 插件自带的失败分类 / 冷却 / 回退逻辑（`classifyFailure`、`engineCooldowns`、`normalizeFallbackOrder`）

### 要新写（sidecar 侧，约 400–600 行）
- **shim**：假 `ctx`（`web.registerSearchProvider` 捕获 provider、`tools.register` 丢弃、`settings`/`effect`/`inject`/`logger` 最小实现），让 `apply()` 能跑完并交出 provider
- **配置层**：`search.json` 读写（启用引擎、key、回退顺序、超时、缓存开关、代理）
- **HTTP 服务**：§5 的端点 + token 校验 + 并发上限
- **引擎过滤**：把 `disabledEngines` 固定为「除 anysearch/keenable/tavily/exa/firecrawl 以外的 22 个」

### 不搬
- `lib/client.js`（DSH 的 React 设置界面，1795 行，依赖 `@deepseek-ai/dsh-client-ui-renderer`）→ 设置界面在 GUI 前端重写
- `lib/mcp_adapter.js`（GUI 没有 MCP 客户端）
- `lib/research.js`、`lib/vertical.js`、`lib/weather.js`（本轮范围外）

---

## §4 引擎策略

### 4.1 启用集合

本轮只暴露 5 个引擎。实现方式：调用插件时把其余 22 个塞进 `disabledEngines`（`ALL_ENGINES` 减去这 5 个），这样 `routeEngines()` 的语言池排序也只在这 5 个里生效。

```js
const EXPOSED = ["anysearch", "keenable", "tavily", "exa", "firecrawl"];
const disabledEngines = ALL_ENGINES.filter(e => !EXPOSED.includes(e)); // 22 个
```

### 4.2 可用性规则

| 引擎 | 何时可用 |
|---|---|
| anysearch | **始终可用**（零配置） |
| keenable / tavily / exa / firecrawl | 只在用户填了对应 key 后进入可用集 |

未填 key 的引擎**从 `disabledEngines` 之外单独排除**（不要仅靠「请求失败再回退」，否则每次搜索都要白等一次 401）。

### 4.3 回退与冷却

直接沿用插件的机制：
- `fallbackOn` 决定哪些失败类型触发换引擎（`DEFAULT_FALLBACK_ON`）
- `classifyFailure` 把失败分类（配额/鉴权/瞬态/网络）
- `engineCooldowns` + `COOLDOWN_SESSION_MS`：配额或鉴权失败后会话期内不再尝试该引擎
- 失败提示要透给前端（插件已有「回退提示」文案），让用户知道「这次结果来自 keenable 而不是 anysearch」

### 4.4 时间过滤

`TIME_ENGINES`(:167) 里的引擎支持时间过滤。本轮 5 个引擎中 **anysearch、keenable、tavily、exa、firecrawl 都在 TIME_ENGINES 里**（待逐项复核 `parseTimeRange` 的映射），聊天界面可以提供「最近一天/一周/一月/一年」选项。

---

## §5 sidecar 接口契约（HTTP，127.0.0.1 + 随机端口）

| 端点 | 请求 | 响应 |
|---|---|---|
| `GET /health` | — | `{"ok":true,"engines":["anysearch", ...]}` |
| `POST /search` | `{query, engine?, maxResults?, timeRange?, safeSearch?}` | `{sources:[{url,title,snippet}], engineUsed, fallbackFrom?[], truncated}` |
| `POST /fetch` | `{url}` | `{url, statusCode, body:{kind:"html"\|"text", content}, truncated}`（可选阶段） |
| `GET /engines` | — | 每个引擎的 `{id, enabled, hasKey, cooldownUntil?}`，供设置页显示状态 |

约束：
- **必须校验 token**（`Authorization: Bearer <启动时随机生成>`）：`127.0.0.1` 上的端口对本机任何程序开放，不校验等于给本机其他进程一个免费搜索代理
- 并发上限（建议 4），超出的请求排队而不是并发打向同一个引擎（免费额度经不起突发）
- 请求超时（建议 20s）+ 结果缓存复用插件的 `buildCacheKey` / `cache.js`
- **key 绝不回显**：`GET /engines` 只返回 `hasKey: true/false`

---

## §6 与聊天界面的集成（**待用户决策**）

两种触发方式，建议都做：

| 模式 | 机制 | 依赖 | 适用 |
|---|---|---|---|
| **工具调用** | 把 `web_search` 作为 function 定义传给 `/v1/chat/completions`，解析模型返回的 `tool_calls` → 调 sidecar → 以 `role:"tool"` 回灌 → 继续生成 | 模型必须支持 tool calling（`/props` 的 `chat_template_caps.supports_tool_calls`，llama.cpp 子实例直接返回该字段） | 大模型、工具模板完整的 GGUF |
| **显式检索**（兜底） | 用户点「联网」→ 生成/确认查询词 → 搜索 → 把结果作为上下文注入首条 system/user 消息 → 正常生成 | 无（任何模型可用） | 小模型、无工具模板的模型 |

实现要点：
- 工具模式下要**限制轮数**（建议最多 3 轮搜索），并在 UI 上标出「正在搜索」状态
- 结果注入时用插件已有的 `wrapUntrustedBlock` / `stripBoundaryTags`，把网页内容包成不可信块，降低提示注入风险
- 引用展示：每条来源显示域名 + 标题，可点击用系统浏览器打开；`snippet` 折叠显示
- **搜索历史**：会话内保留（谁搜了什么、用了哪个引擎、命中几条），落盘沿用聊天会话的存储

---

## §7 设置 UI 与 key 管理

设置页要有的项（前端重写，不复用 `client.js`）：

- 引擎开关（5 个，anysearch 强制开启）
- 每个引擎的 key 输入框 + 「测试」按钮（点了就发一次真实搜索，返回条数与耗时）
- 回退顺序拖拽排序
- 时间过滤默认档
- 域名黑名单（`blockedDomains`）
- 每引擎冷却状态显示（`cooldownUntil`）
- 代理设置（HTTP/SOCKS）—— 本轮 5 个引擎都不需要代理，但保留入口，便于用户自行加回 ddg/searxng

**key 存储**：与现有 `settings.json` 同级放 `search.json`（明文，与 `api_key`/`strata_api_key` 的现状一致）。至少做到：不进日志、不在 `GET /engines` 回显、错误信息里脱敏。

---

## §8 进程与生命周期

- **懒启动**：用户第一次触发搜索时拉起 sidecar（不占用常驻内存），启动失败就禁用搜索入口并在界面上说明原因
- **端口**：随机空闲端口（参考 `strata.rs:515-525` 的「不静默顺延，报错并指出占用者」策略），端口与 token 通过命令行参数传给 sidecar
- **日志**：sidecar 的 stdout/stderr 纳入现有日志分流（`router.rs` 的 `[port]` 前缀机制不适用，需要新的来源标签，例如 `[search]`），默认只记启动、引擎切换、失败分类，**不记 query 与结果正文**（隐私）
- **退出清理**：与现有 `stop_router`（`router.rs:501-520`，`taskkill /PID <pid> /T /F`）同款，GUI 退出时必须杀干净
- **崩溃恢复**：sidecar 挂了 → 前端标记不可用，下次触发搜索时重启；连续失败 3 次则本次会话不再自动重启

---

## §9 分阶段实施

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| **P0** | sidecar 骨架：shim + HTTP + `search.json` + token 校验，先用 anysearch 打通 | 命令行能搜出结果 | 2–3 天 |
| **P1** | 4 个可选引擎接入 + key 管理 + 引擎过滤（22 个禁用） | `POST /search` 支持 5 引擎与回退 | 2–3 天 |
| **P2** | 前端设置页（引擎开关、key、测试按钮、回退顺序、黑名单） | 设置可用 | 3–5 天 |
| **P3** | 聊天界面「显式检索」模式 + 引用展示 | 不依赖模型能力即可用 | 4–6 天 |
| **P4** | 聊天界面「工具调用」模式（tool_calls 循环 + 轮数限制） | 模型自主搜索 | 4–6 天 |
| **P5** | Node 运行时打包方案落地 + 安装/升级验证 | 可发布 | 2–3 天 |
| P6（可选） | `web_fetch` 质量链（T1 直连 + exa/firecrawl 兜底；**排除 crawl4ai**，它需要本地服务） | 模型能读原文 | 3–4 天 |

合计 **3–4 周**（不含 P6）。

**依赖关系**：P3/P4 依赖聊天界面本身（见 `STRATA_MANAGER_PORT_ASSESSMENT.md` §2 的聊天模块移植），**搜索功能应该排在聊天界面之后或并行**。

---

## §10 未确认项

1. **keenable / tavily / exa / firecrawl 带 key 后的真实可用性**：本轮只验证到域名可达（401/405），没有 key 无法跑真实搜索。拿到任一免费 key 后应立即复测。
2. **anysearch 的免费策略**：当前无需 key 即可用，但插件源码里有 `ignoredAnysearchKey` + 「401/403 后重试无 key」逻辑，说明它是按需 key 设计的 —— 服务方随时可能改成强制 key。**要有降级预案**（届时提示用户配置 keenable）。
3. **插件的代理配置机制**：README 有「代理说明（国内用户）」章节，未细读；本轮 5 个引擎都不需要，但若将来要放开 ddg/searxng 就要读懂它。
4. **sidecar 的资源占用**：Node 进程常驻内存（实测 import 时出现 `node:sqlite` 实验性警告，说明模块顶层会初始化 SQLite），需要实测内存与启动耗时。
5. **crawl4ai 是否需要本地服务**：`fetch_provider.js:8-13` 用 `child_process.spawn` 调它，P6 阶段要么排除，要么确认调用方式。
6. **llama.cpp 侧 tool calling 的实测**：`/props` 的 `chat_template_caps.supports_tool_calls` 只是声明，需在真实模型上验证 tool_calls 的返回格式与流式行为（`tools` + `stream:true` 时 tool_calls 如何分块）。

---

## §11 待决策

1. **Node 运行时**：内嵌打包（+80MB）/ 复用本机 Node / 单 exe（§2.3）
2. **聊天侧触发方式**：只做显式检索 / 只做工具调用 / 两者都做（§6，建议两者）
3. **是否把 `web_fetch` 纳入本轮**（P6）
4. **key 存储形式**：明文 `search.json`（现状一致）还是接系统凭据管理

### §11 决策结果（2026-10-14 用户定稿）

> **路线变更 —— 推翻本文 §2.1 与 §3：不用 Node 运行时，搜索在 Rust 里重写。** 只保留 5 个引擎（anysearch / keenable / tavily / exa / firecrawl）的实现，其余 22 个引擎的代码不进 Rust。上游插件 `dsh-free-search 0.8.8` 降级为**行为参考**（API 形状、回退与冷却语义、时间过滤映射），不再是运行期依赖。

| # | 决策 | 说明 |
|---|---|---|
| 1 | Node 运行时 = **不引入，Rust 重写** | §2.3 三选一作废；§9 的 P5（Node 打包 2–3 天）整段取消 |
| 2 | 聊天侧触发 = **两者都做** | 显式检索 + `tool_calls` 回灌循环（轮数上限 3）；宿主是原生聊天 UI（`STRATA_MANAGER_PORT_ASSESSMENT.md` §7 决策 1 已定「建」） |
| 3 | `web_fetch`（P6）= **延后** | 本轮不做，`crawl4ai` 已排除 |
| 4 | key 存储 = **明文 `search.json`** | 与 `api_key`/`strata_api_key` 现状一致；不进日志、设置接口只回 `hasKey` |
| 5 | TLS 后端 = **reqwest 去默认 feature + `json` + `native-tls`**（Windows 走系统 SChannel，不编 ring） | `reqwest 0.13.5` 已在依赖树里（被 tauri 依赖，`src-tauri/Cargo.lock:2849`），`tokio` 也在；但 lock 里没有任何 TLS 后端 crate（rustls/ring/native-tls/schannel/webpki-roots 全无），发 https 必须显式启用一个 |

**作废章节**：§2.1（为什么复用插件）、§2.2（进程拓扑）、§2.3（Node 三选一）、§3 复用清单、§5（sidecar HTTP 契约 + 随机端口 + token 校验）、§8（懒启动 / `[search]` 日志标签 / taskkill 清理 / 崩溃重启）、§9 的 P5。§12 风险里「Node 运行时缺失」「本机其他程序盗用 sidecar 额度」「上游升级破坏导出签名」三条随之消失。

**新写**：`src-tauri/src/search.rs`（5 个引擎的 REST 客户端 + 回退与冷却 `classifyFailure`/`engineCooldowns` 等价物 + 缓存 `buildCacheKey` 等价物 + 域名黑名单 + `wrapUntrustedBlock`/`stripBoundaryTags` 等价物 + 时间过滤）+ `search.json` 读写 + 给前端的 Tauri command。搜索由子进程变为**进程内模块**，且不受 `src-tauri/tauri.conf.json:27` 的 CSP `connect-src` 白名单约束（那条只管 webview），因此无需放宽 CSP。

**代价（要实测重建）**：5 个引擎的请求体与响应形状要在 Rust 里逐个重新实测对齐 —— 注意插件的引擎函数返回的是 `{ sources: [...], truncated: false }` 而**不是数组**；各家错误码、分页与超时语义重新踩一遍。上游以后新增引擎、改 API 参数、修 bug 都不再有红利，只能自己跟。

---

## §12 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| anysearch 转为强制 key 或下线 | 零配置能力消失 | 保留 keenable 引导；把「未配置任何 key」的提示做清楚 |
| 免费额度耗尽 | 搜索静默降级 | 冷却机制 + 前端显示 `cooldownUntil` 与「本月额度可能用尽」提示 |
| 搜索结果含提示注入 | 模型被网页内容劫持 | 用 `wrapUntrustedBlock` 包裹 + 系统提示里声明「网页内容不可信」 |
| Node 运行时缺失 | 功能不可用 | 启动时检测并在设置页给出明确指引 |
| 上游插件升级破坏导出签名 | sidecar 编译期/运行期报错 | 锁定版本号（0.8.8），升级前跑一遍 `tmp/fs-engines-probe2.mjs` 回归 |
| 本机其他程序盗用 sidecar | 免费额度被消耗 | token 校验 + 仅监听 127.0.0.1 |

---

## 附录 A：本轮实测脚本与日志

| 文件 | 内容 |
|---|---|
| `tmp/fs-probe.mjs` | 验证插件能否脱离 DSH 加载 + `routeEngines` 语言池 |
| `tmp/fs-engines-probe.mjs` / `.log` | 第一版引擎探针（**返回值解析有 bug，仅作留档**） |
| `tmp/fs-engines-probe2.mjs` / `.log` | 修正后的 5 引擎实测（本方案 §1.1 的数据来源） |
| `tmp/fs-conn-probe.mjs` / `.log` | 18 个域名的直连连通性矩阵（§1.2） |
| `tmp/fs-bing-probe.mjs` / `fs-bing-probe2.mjs` | bing HTML 结构诊断（结论：解析正常，是探针取值错） |

## 附录 B：本轮确定的引擎白名单

```
零配置：anysearch
需 key：keenable / tavily / exa / firecrawl
默认回退顺序：anysearch → keenable → tavily → exa → firecrawl
禁用（代码保留、设置不暴露）：ddg、ddg-lite、bing、searxng、parallel、perplexity、
  serpbase、serply、deepseek-official、you、baidu、kimi、aliyun、doubao、tinyfish、
  jina、zhihu_global、zhihu_site、openai、gemini、claude（共 22 个）
```
