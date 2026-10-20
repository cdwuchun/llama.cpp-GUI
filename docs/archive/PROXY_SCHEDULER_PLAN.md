# 统一前门调度方案（取代 router）

> 状态：**已落地（0.2.0，2026-10-20 更新）** —— 决策 2026-10-14 定稿（§10），前门由 `src-tauri/src/strata_proxy.rs` 实现：一个端口挂全部配置、按请求体 `model` 停旧起新并转发，`/v1/models` 与「无引擎时的 `/health`」由它合成；llama.cpp 侧配置层已按 §3.1 改成「一个模型一份 JSON」（`<exe 目录>\config\llamacpp-<id>.json`），`presets.ini` 退役（见 `HANDOVER.md` §8 第 14 条）。本文保留作设计依据与实测记录。
> 目标读者：本仓库维护者
> 相关文档：`HANDOVER.md`（§2 行为约束、§2.11 Strata 通道）、`STRATA_INTEGRATION_PLAN.md`（前门代理的既有实现）、`STRATA_MANAGER_PORT_ASSESSMENT.md`（聊天/监控/基准三块的移植评估）

---

## §0 目标

用**统一前门**取代 llama.cpp 的 router 模式，由前门统一调度 llama.cpp 与 Strata 两条通道的模型：

| # | 需求（用户 m00381 明确） | 含义 |
|---|---|---|
| 1 | **客户端触发加载**（autoload 要保留） | 请求里带 `model`，目标未运行就启动、等就绪、再转发 |
| 2 | **端口从配置读**：基础端口 + 递增，写回配置 | 每个模型一个固定端口，持久化在配置里 |
| 3 | **日志按模型区分** | GUI 生命周期内可能同时跑多个模型，日志要能分辨归属 |
| 4 | **多模型并存** | 不假设「同时只有一个模型」（其他用户可能需要） |

一句话：**把 router 做对的那部分（按需加载、多模型并存）自己实现，把它做拧的那部分（隐式 autoload 副作用、动态端口、preset 热重载）换成明确、可预期的行为。**

---

## §1 为什么不用 router

### 1.1 现状：能力用不到，副作用全付

用户实例的 `settings.json` 是 `models_max: 1` —— 从来没有让两个模型同时驻留。router 最复杂的那一半（多模型并存、LRU 淘汰、跨模型容量管理）没有被使用，但下面这些副作用一直在付：

| router 的行为 | 实测证据 | 自研后 |
|---|---|---|
| `/slots`·`/props`·`/metrics` 缺 `model` 一律 **400** | 实测 8210：`{"error":{"code":400,"message":"model name is missing from the request"}}` | 前门按当前模型转发，或直接问引擎（单模型无歧义） |
| **`?model=` 触发 autoload**（只读请求也会加载模型） | 实测：`GET /slots?model=Qwen/Qwen3-Embedding-0.6B` 调用前 `unloaded`、调用后 `loaded` | 加载时机由前门明确决定，不再有隐式副作用 |
| 子实例端口**每次加载都变**（router 现取一个空闲端口） | 源码 `server-models.cpp:989` `inst.meta.port = common_http_get_free_port();`（spawn 前才赋值）；未加载的模型在 `/v1/models` 的 `status.args` 里显示 `--port 0`（只在 `add_model` 时渲染过一次） | 端口写在配置里（基础端口 + 递增），前门与人都能预测 |
| 子实例日志经 router 转发，需按 `[port]` 前缀分流 | `router.rs` 现有分流实现；实测 `[62182] {"type":"log",…}` | 子实例由前门自己 spawn，归属天然已知 |
| preset 改动要靠 `GET /models?reload=1` 才生效 | 铁律 3 | 配置改了就该重启引擎，语义更直白 |

### 1.2 代价（必须承认）

丢掉 router 意味着这几件事要自己承担：

- **多模型并存的容量与显存管理**（需求 4 要求保留并存能力）
- 并发请求不同模型时的排队语义
- 上游演进（新端点、新能力）不再有人替我们适配
- 前端要从「依赖 router 特性」改成「依赖前门契约」

### 1.3 router 源码研读要点（b11482，实现时的直接参考）

**源码**：`tools/server/server-models.cpp`（本轮已抓取全文，重排成可 grep 的副本放在 `tmp/router-server-models.txt`，下表行号对应这份副本）、`tools/server/server.cpp`、`tools/server/server-models.h`、`common/preset.h`。

| 机制 | 源码位置 | 对我们的意义 |
|---|---|---|
| 端口在 **spawn 前**由 router 现取 | `:989` `inst.meta.port = common_http_get_free_port();`，`:1001` 再 `update_args()` 重新渲染 `--port` | 与需求 2 不同：它每次加载都换端口。我们改成「写回配置文件」 |
| `?autoload=false` 是**官方开关** | `is_autoload(params, req)`：查询参数非空时覆盖 `--models-autoload` | 保留 router 模式时，监控/状态轮询一律带 `?autoload=false`，从根上避开「只读请求把模型拉进显存」 |
| 子进程**双通道**：stdout = 命令，stderr = 日志 | `:1015` 注释「the child writes its commands to stdout and its logs to stderr」；`on_line()` | 不必复刻：状态用 `/props` 拿（实测字段极全），日志直接捕获 |
| `[port]` 前缀是 **router 打的** | `on_line()`：`LOG("[%5d] %s", c.port, line)` | 不走 router 后前缀消失，前门要自己给每行打标签（§5） |
| router **不下发** `--log-file` | 构造期 `base_preset.unset_option("LLAMA_ARG_LOG_FILE")` | 若用 `--log-file` 分模型，前门必须为每个模型注入**不同**文件名 |
| router 把自身 CLI 参数 `merge` 进每个模型 preset | `load_models()`：`preset.merge(base_preset)` | 就是铁律①的机制；自研后这条隐式行为消失，参数来源只剩配置文件 |
| 渲染前剔除保留参数 | `unset_reserved_args()`：不下发 API_KEY / API_KEY_FILE / MODELS_DIR / MODELS_MAX / MODELS_PRESET / MODELS_AUTOLOAD / SSL_* / MODEL / MMPROJ / ALIAS / HF_REPO，并强制 `--host 127.0.0.1` | 我们的 spawn 参数拼装要照抄这份黑名单与 host 覆盖 |
| 同模型的并发请求**共享一个队列条目** | `server_lru_sched::join()`：`n_waiters++`；`try_claim()` 要求「队首 + 有容量 + 未 loading」 | 一次加载解锁全部等待者，我们的调度器要照抄 |
| 等待是 **200 ms 条件变量轮询**，加载在队首请求的线程里同步跑 | `ensure_model_ready()` `:1317-1376`：`cv.wait_for(lk, 200ms)`、`lk.unlock(); load(name);` | 简单可靠，不需要额外线程池 |
| 忙碌模型**不会被淘汰** | `pick_victim()`：跳过 `req_count != 0`、非 ready_or_sleep、`stopping_models` | 淘汰策略的保护条件 |
| 请求结束触发 `tick()` | `proxy_request()` 的 `proxy->cleanup`：`req_count--`，归零时 `sched->tick(lk)` | 空闲淘汰的触发时机 |
| `load()` 里有**二次容量检查** | `:976-986`：`count_active >= models_max` → 抛 `model limit reached, try again later` | 防并发请求同时突破上限，我们也要在 spawn 前再查一次 |
| 停止子进程有**两条路** | `request_stop()` → 写 stdin `cmd_router_to_child:exit`，`stop_timeout` 到期再 `terminate()`（默认 10 s，`DEFAULT_STOP_TIMEOUT`）；LOADING 状态直接强杀 | 停机流程照抄：先温和、超时强杀 |

---

## §2 目标拓扑

```
                    客户端（DSH / 浏览器 WebUI / curl）
                              │
                              ▼
              统一前门  :9090   ← 沿用现有 Strata 前门端口
                    ┌─────────┴─────────┐
                    ▼                   ▼
        llama.cpp 通道            Strata 通道
        llama-server :8211        strata.exe :9092
        llama-server :8212        strata.exe :9093
                …                        …
        （端口写在 preset 段）    （端口写在 strata-*.json）
```

- 前门对外只暴露 **一个端口**：`/v1/models` 列出两通道全部模型，`/v1/chat/completions` 按 `model` 路由。
- 每个模型**仍有自己的固定端口**，可直接访问（WebUI、调试、给 DSH 单配 provider）。
- router（8210）退役；建议保留一个版本周期作为**兼容模式**（见 §10.4）。

---

## §3 配置层

### 3.1 llama.cpp 侧：一个模型一份 JSON（2026-10-14 用户定稿，取代 `presets.ini`）

**决策**：llama.cpp 通道与 Strata 通道统一为「一个模型一份 JSON 配置文件」，放在 **GUI exe 所在目录下的 `config\`**；`presets.ini` **彻底退役**（不保留兼容读取）。

理由：A1 已定 router 立刻退役，ini 的唯一消费者（router 的 `--models-preset`）随之消失；且 Strata 通道早就是一模型一份 JSON，两通道配置方式应当同构。

**目录与命名**：

```
<exe 目录>\                  ← 便携版根目录（paths.rs:21-24 exe_dir()；settings.json / webview\ 同层）
├── settings.json            ← 位置不动（config\ 只放模型 JSON）
├── config\                  ← 本轮新增
│   ├── llamacpp-<id>.json   ← 一个模型一份
│   └── ...
└── webview\
```

- 文件名 = `llamacpp-<id>.json`；`<id>` = **现有 preset 段名**（前端选中项、日志、请求 model 名全部不变），非法文件名字符（`/ \ : * ? " < > |` 与首尾空格、点）**统一替换为 `-`**，重名时追加 `-2` / `-3`。
- 扫描规则 `llamacpp-*.json`；排除 `.bak*`（对齐 Strata 的 `strata-*.json` 扫描规则，见 `STRATA_INTEGRATION_PLAN.md:360-376`）。
- 设置与缓存类文件（`settings.json`、`models-scan-cache.json`、`gguf-meta-cache.json`、`removed-*`、`bench\`、`webview\`）**位置一律不变**，不搬进 `config\`。

**JSON 结构**（`args` 数组 + 元数据，对齐 Strata config 形态）：

```json
{
  "name": "Hy-MT2-1.8B",             // 请求 model 名 / 前端选中项（原 preset 段名）
  "model": "D:\\models\\Hy-MT2-1.8B-Q4_K_M.gguf",
  "mmproj": null,                    // 视觉投影，有则写路径
  "exe": "E:\\AI\\llama.cpp\\b11482\\llama-server.exe",
  "port": 8211,                      // 固定端口：只增不减、不回收（决策 3）
  "host": "127.0.0.1",
  "api_key": "sk-…",
  "no_webui": false,                 // 铁律 1：默认 false，不关子实例自带 WebUI
  "log": "E:\\AI\\llama.cpp-gui\\logs\\llamacpp-Hy-MT2-1.8B.log",
  "cwd": null,                       // 可选，缺省用 exe 所在目录
  "env": {},                         // 可选
  "args": ["--ctx-size", "4096", "--n-gpu-layers", "999", "--flash-attn", "on"]
}
```

- `args` 直接是 `llama-server` 的命令行参数（同 Strata 风格），前门拼命令行即可；**不得**出现 `--port` / `--host` / `--model` / `--mmproj`（这四个由顶层字段生成），手写进 `args` 会被丢弃并在日志里提示。
- 顶层 `port` / `host` / `api_key` / `no_webui` 是**前门与 GUI 的契约字段**；未知字段原样保留（前向兼容，同 Strata「写回只碰顶层字段」策略）。
- **`--model` / `--mmproj` 的路径在「刷新模型」时由 GUI 按扫描结果自动修正**，其余 `args`（用户手改的参数）原样保留。
- `RETIRED_PRESET_KEYS` 过滤（铁律 5）在 JSON 读取路径上继续生效：命中即记日志并忽略该键，避免又出现「`option '…' not recognized in preset` 导致整体启动失败」。

**连带改动（8 处，不是只换文件格式）**：

| # | 位置 | 现状 | 改成 |
|---|---|---|---|
| 1 | `src-tauri/src/state.rs:307-309` | `preset_path()` = `<配置目录>\presets\presets.ini` | 模型配置目录 = `<exe 目录>\config`，按 id 取 `llamacpp-<id>.json` |
| 2 | `src-tauri/src/models.rs:1275-1600` | ini 字符串级读写（`list_sections` / `section_entries` / `upsert_entries` / `remove_section` / `ensure_model_section` / `read_preset` / `write_preset` / `sanitize_preset_keys`） | JSON 读写（serde，保留未知字段）；原子写沿用 `models.rs:1561` 的临时名 + pid + 序号方案 |
| 3 | `src-tauri/src/lib.rs:1213-1350` 的 8 个命令 | `preset_sync` / `preset_read` / `preset_write` / `preset_upsert` / `preset_remove` / `preset_section_entries` / `preset_import_hub` 按「段」操作 | 语义不变，参数从「段」改为「id」；`preset_read` / `preset_write`（整文件文本）改为按 id 读写单份 JSON |
| 4 | `src-tauri/src/lib.rs:1444` 归档 | `removed-preset-sections.json`（段名维度） | 模型消失时把 `llamacpp-<id>.json` 移入 `config\.orphan\`（保留文件本体便于找回） |
| 5 | `src-tauri/src/models.rs:1939` `import_hub_presets` | hub 参数表 → preset 段 | hub 参数表 → 每模型 JSON 的 `args` |
| 6 | 前端接口 | `src/ipc.ts:86-97`（7 个方法）、`src/store.ts:393` / `:556` / `:640` / `:686`、`src/types.ts:237` / `:273-274`、`src/components/RuntimePanel.tsx:249` 全按「段名 + 整份 `presetText`」 | 改为「id + 单份 JSON」；`presetText` / `presetPath` 语义变为「当前选中模型的 JSON 文本 / 路径」 |
| 7 | 铁律 2 | 「前端请求模型要用 **preset 段名**（`selected.section`）」 | 改为「用 **config JSON 的 `name`**（即原段名）」；`settings.aliases`（扫描 id → 段名）**整表退役**，替代机制见下 |
| 8 | 存量迁移（首次启动） | `presets\presets.ini`（本机 14 段） | 一次性转 14 份 `llamacpp-<id>.json`，ini 改名 `presets.ini.bak-<时间戳>` 保留；**迁移失败则不删 ini 并明确提示**，只有全部成功才写迁移标记（避免半途丢配置） |

**缺配置的模型**：扫描到模型但 `config\` 里没有同名 JSON 时，**自动补一份最小 JSON**（`name` + `model` + 空闲端口 + 默认参数），与现在 `preset_sync` 的行为等价。

**`settings.aliases` 退役（2026-10-14 用户定稿）**：这张表现在干两件事 —— ①「扫描目录 id → preset 段名」的桥（`src/utils/models.ts:143-155`；`src/components/ModelSheets.tsx:389` 注释写明「aliases 里记下"扫描 id → 段名"，下次扫描/合并时才能把 router 报回来的名字对回这个模型」），② 顺带当显示别名用（`src/components/ModelSheets.tsx:233`、`src/utils/models.ts:167-168`）。JSON 化后两件事都有更直接的载体，故**整表退役**：

- **模型身份**：JSON 顶层 `model`（gguf 绝对路径）就是身份。扫描结果按 **gguf 路径 ↔ JSON `model` 字段**匹配，不再经过名字；`id`（文件名主体）与 `name` 在迁移后一致。
- **改名**：前端「改别名」动作改为**改写 JSON 的 `name` 字段**（文件名 id 不动 —— 免得端口、日志、请求历史跟着变）。显示名 = `name`。
- **归档恢复**：模型重新出现时按 id 查 `config\.orphan\llamacpp-<id>.json` 移回，不再依赖 `restore_archived_sections` 的别名反查。
- **边界**：若两份 JSON 指向同一个 gguf（复制配置做参数对比），列表里按两条显示；默认选中 id 与扫描目录名一致的那条。

**退役动作（与 M1 同批）**：`src/types.ts:45` / `:85` 与 `src-tauri/src/settings.rs:178` / `:292` / `:504-505` 删除该字段（`Settings` 与 `SettingsPatch` 必须同时改，否则前端保存不落盘）；`src-tauri/src/lib.rs:1035-1039` / `:1179-1206` / `:1234-1248`、`src-tauri/src/models.rs:302` / `:324` 改为按 gguf 路径匹配；前端 `src/utils/models.ts:143-168`、`src/components/BenchPanel.tsx:52-55`、`src/components/ModelListPanel.tsx:474-476`、`src/components/ModelSheets.tsx:188-190` / `:233` / `:389-414` 去掉别名参数；测试 `src-tauri/src/settings.rs:602-616`（`aliases_patch_round_trips`）一并删除。

**迁移处理**：存量迁移时读一次旧 `aliases`，用于把扫描 id 对回段名（对不上就按扫描 id 建新 JSON，并在迁移报告里列出）；映射写进 JSON 后即丢弃。旧 `settings.json` 里的 `aliases` 键**读到即忽略**，不主动改写用户文件，下次保存自然消失。

**没变的部分**：参数丢弃规则本身、`RETIRED_PRESET_KEYS` 过滤、hub 参数翻译逻辑都保留，只是输出目标从「ini 段」改成「JSON 文件」；`--models-preset` 注入（`router.rs:610`）随 router 退役一起消失。

**归属与工时**：与 **M1 同批**（前门本来就要读配置来 spawn 子进程，拆开做等于把配置层改两遍），约 **+2–3 天**（后端 1.5–2 天 + 前端 0.5 天 + 迁移与回归 0.5 天），计入 M1，不新增里程碑。

**旧决策作废**：本节原稿「preset 段新增 `port`」的写法（生成器写 `port = <n>` 到 ini 段）随本节改写作废 —— 端口字段改由 JSON 顶层 `port` 承载，「两条生成路径不能共用丢弃清单」这条兼容约束也随「不留兼容模式」一并失效。

### 3.2 Strata 侧：`strata-*.json` 的 `port`（已有机制）

- `src-tauri/src/strata.rs:241-242` 从 config json 读 `port`。
- **关键陷阱**：`strata.rs:538-546` 注释明确 ——「run 脚本里的 `--port` 才是引擎真正绑定的端口：`server.py` 只认 CLI 参数（`cfg["port"]` 没有回退），config 里的 `port` 只是 GUI 用来找它的元数据」，两者不一致会直接报错：
  > 「config 里写的端口是 {port}，但 {file} 里的 --port 是 {script_port}」

  → **分配端口时必须同时改 config json 的 `port` 与 run 脚本的 `--port`（两处）**，否则启动前校验就拦下来。

### 3.3 端口分配算法

```
基础端口：llama.cpp base_port（建议 8211，避开退役的 8210）
          Strata      base_port（建议 9092，与现有 config 一致）
分配：收集两通道全部配置已声明的端口
      → 从 base_port 起，取第一个「未被任何配置占用」且「winfix::port_in_use() 为假」的号
      → 写回该模型的配置（llama.cpp 写 config\llamacpp-<id>.json 的 "port" / Strata 写 config + run 脚本）
```

- 占用检测复用 `crate::winfix::port_in_use`（`strata.rs:515` 已在用）。
- 等待端口释放复用 `strata.rs:690 wait_port_free(port, timeout)`。

### 3.4 冲突处理

`strata.rs:518-525` 的既有策略值得沿用：端口被占用时**不静默顺延**，而是报错并指出占用者（先用 `/health` 探测判断是不是自己的引擎）：

> 「端口 {port} 已被占用{who}。Strata 的 config 与 WebUI 都绑定这个端口，不能自动顺延，请先停止占用者。」

自研前门对 llama.cpp 侧采用同样策略：**新增模型时自动选号，运行期冲突则报错**（不悄悄换端口，否则客户端会连错地方）。

---

## §4 前门调度器

### 4.1 每模型状态机

```
idle ──start()──▶ starting ──就绪──▶ ready ──stop()──▶ stopping ──▶ idle
  ▲                  │                                              │
  └──────────────────┴──────── failed（启动失败/超时/OOM）──────────┘
```

- `starting`：spawn 引擎 → 轮询 `/health` 直到 200 → 超时失败。
  超时建议 **60 s**（实测 Strata 冷启 20–30 s，llama.cpp 大模型加载可能更久）。
- `ready`：可转发。
- `failed`：保留错误摘要（日志尾部），客户端收到 503 + 原因。

### 4.2 客户端触发加载（需求 1）

1. 收到 `POST /v1/chat/completions`（或任意带 `model` 的请求）。
2. 查配置表 → 该模型当前状态？
   - `ready` → 直接转发
   - `starting` → **挂在同一个 future 上等待**（绝不重复启动第二个进程）
   - `idle`/`failed` → 检查容量策略 → 启动 → 等就绪 → 转发
3. `/v1/models` **必须列出未加载的模型**（否则客户端不知道能请求什么），每项带 `loaded` 与 `port`。

### 4.3 并发与排队

| 情形 | 行为 |
|---|---|
| 同一模型并发 | 直接转发（llama.cpp 多槽 `--parallel`；Strata FIFO 单序列） |
| 不同模型并发 | **并存**（受容量策略约束）；容量不足时按策略处理 |
| 加载中又来请求 | 合并等待，不重复启动 |

### 4.4 容量策略（待决策，见 §10.1）

- **A 不限** —— 用户自己管显存（最省事，但 OOM 时体验差）
- **B 上限 N** —— 类 `models-max`，超出时卸载最久未用的
- **C 显存预算（建议）** —— 加载前用已有的 `llama-fit-params -fitp on` 预览（`src-tauri/src/gpu.rs` 的 `parse_fit_preview`、前端 `src/utils/fitCache.ts`）估算所需显存，与当前可用比较；不够则按「最久未用」卸载，仍不够就返回明确错误

### 4.5 客户端断连与取消（踩过的坑）

从 `strata_proxy.rs` 继承两条硬约束：

1. **每条连接必须显式 `set_nonblocking(false)`** —— Windows 上 `accept` 会继承监听套接字的非阻塞标志。
2. **绝不能向引擎发 FIN / 半关闭** —— Strata 上游 `serve/server.py:4127-4150 _watch_client` 把 EOF 判成「客户端挂断」。

llama.cpp 子实例在这两种情形下的行为**未实测**，列入 §9。

### 4.6 失败与回退

- 启动失败 → 状态 `failed` + 把日志尾部（最后 N 行）返回给客户端，便于定位。
- 端口被占用 → 报错并指出占用者（学 `strata.rs:518-525`）。
- 显存不足 → 明确报错，可选自动卸载（取决于容量策略）。

---

## §5 日志分模型（需求 3）

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A 前门捕获 stdout 打标签（建议主用）** | 前门用管道读每个子实例 stdout，行首加 `[<model>]` 或 `[<port>]` 后并入统一时间线 | UI 里一条时间线、按模型过滤；与现有 `router.rs` 的 `[port]` 分流思路同源 | 前门要转发全部日志（铁律：批量推送，避免 IPC 洪泛） |
| **B 每模型独立文件** | 给子实例传 `--log-file`（实测 b11482 支持，help:202）；Strata config 已有 `log` 字段（`E:\AI\Strata\strata-*.log`） | 原位排查方便、不占 IPC | UI 要按模型分别读文件 |

建议 **A 为主、B 为可选落盘**（两者不互斥）：前门统一时间线给 UI，`--log-file` 留给「进程已退出、前门没抓到」的场景。

前端 `LogPanel` 需要增加「按模型过滤」（现在按 `[port]` 前缀分流的展示逻辑要改成按模型）。

---

## §6 统一入口契约

### 6.1 总原则：**黑名单，不是白名单**

需求是「llama.cpp 支持的访问端点，前门都要支持」。因此转发策略定为 **默认全透传**：

- 不在排除表里的「路径 + 方法」一律转发给目标引擎；**未知路径也照转**，让引擎自己回 404 —— 前门不预设端点清单
- 只在下面 6.2 明确列出「必须拦截 / 必须改写 / 必须合成」的少数几类

理由：上游每个版本都在加端点（b11482 就有 `/v1/chat/completions/control`、`/v1/messages`、`/v1/systemone` 这些新面孔）。白名单会让前门变成升级路障，而且这份清单追不上上游。

### 6.2 必须特殊处理的端点（其余全部透传）

| 端点 | 前门行为 | 原因 |
|---|---|---|
| `GET /health`、`GET /v1/health` | 前门自答 | `strata_proxy.rs:325` 已有先例；没有引擎时也要能答 |
| `GET /v1/models`、`GET /models` | **合成**两通道模型列表（`channel` 字段区分） | 上游 `/v1/models` 只列一个引擎的模型 |
| `POST /models/load` | 映射为「启动该模型引擎 → 等就绪」 | 前门就是 router 的替身 |
| `POST /models/unload` | 映射为「停止该模型引擎」 | 同上 |
| `GET /models/sse` | 前门自己广播模型状态事件 | 事件源是前门调度器，不是引擎 |
| `POST /models`（下载）、`DELETE /models`（删缓存） | 明确报「不支持」 | 前门没有 HF cache 概念（模型来自 presets.ini / strata-*.json） |
| `GET /props`、`GET /slots`、`GET /metrics` | 剥掉 `?model=`，转发目标引擎 | 单实例下这些端点不需要 model（`?model=` 路由是 router 才有的，见 §1.1） |
| `POST /v1/chat/completions/control` | 按 body 的 `model` 路由 | b11482 新增；它自己也要求 router 模式下带 model |
| `POST /props` | 透传（需引擎侧 `--props`） | 全局属性修改 |
| `GET /tools` 及子路径 | **透传** | 内置 WebUI 的工具调用依赖它（`--tools` 开启时） |
| WebUI 静态资源（`/`、`/index.html`、`/assets/*`、`/favicon*`） | **透传** | 「开始聊天」仍走系统浏览器打开内置 WebUI（HANDOVER §2） |
| 响应头 `access-control-*` | **剥掉引擎的，由前门统一注入** | router 的做法（`should_strip_proxy_header`），避免重复头 |

### 6.3 llama.cpp 端点全清单（b11482，前门必须全部可达）

**原生（非 OAI）**
`GET /health` · `GET /v1/health` · `POST /completion` · `POST /tokenize` · `POST /detokenize` · `POST /apply-template` · `POST /embedding` · `POST /embeddings` · `POST /reranking`（别名 `/rerank`、`/v1/rerank`、`/v1/reranking`）· `POST /infill` · `GET /props` · `POST /props` · `GET /metrics` · `GET /slots`（`?fail_on_no_slot=1` → 503）· `POST /slots/{id_slot}?action=save\|restore\|erase` · `GET /lora-adapters` · `POST /lora-adapters`

**OpenAI 兼容**
`GET /v1/models` · `POST /v1/completions` · `POST /v1/chat/completions` · `POST /v1/chat/completions/control` · `POST /v1/responses` · `POST /v1/embeddings` · `POST /v1/responses/input_tokens` · `POST /v1/chat/completions/input_tokens`

**Anthropic 兼容**
`POST /v1/messages` · `POST /v1/messages/count_tokens`

**TypeSafe 兼容**
`POST /v1/systemone`（决策模型专用，非决策模型返回 501）

**WebUI / 工具 / 静态资源**
`GET /tools` 及子路径（官方标注「不要在下游应用使用」，但我们仍须透传，否则内置 WebUI 会坏）· SPA 路由与静态文件

**Router 模式专属 —— 由前门实现等价语义**
`GET /models[?reload=1]` · `POST /models/load` · `POST /models/unload` · `GET /models/sse` · `POST /models` · `DELETE /models` · `GET /v1/stream` · `DELETE /v1/stream` · `POST /v1/streams/lookup`（可恢复流，见 `tmp/router-server-models.txt`）

### 6.4 鉴权与 CORS

- 引擎侧 `--api-key`：前门转发时按通道填 `Authorization: Bearer <key>`（Strata 侧已如此），**不把引擎 key 外发给客户端**
- 前门自己也要校验外部请求（沿用 `settings.api_key` / `settings.strata_api_key`）
- `GET /health` 免鉴权，与 llama.cpp 一致
- CORS 由前门统一注入（实测 llama.cpp 默认回显 `Origin` 且允许凭据）

---

## §7 与现有代码的关系

### 复用
- `src-tauri/src/router.rs`：引擎启动参数拼装、PATH/共享 CUDA DLL 注入（铁律 7）、`stop_router` 的 kill 树（`:501-520`，`taskkill /PID <pid> /T /F`）
- `src-tauri/src/strata_proxy.rs`：路由骨架、503 兜底、`set_nonblocking(false)` 与「不发 FIN」两条约束、`/health` 自答（`:325`）
- `src-tauri/src/strata.rs`：config 读写、端口校验（`:515-546`）、`probe`（`:801-840`）、`wait_port_free`（`:690`）
- `src-tauri/src/gpu.rs` + 前端 `src/utils/fitCache.ts`：显存预览（容量策略 C）
- `src-tauri/src/idle.rs`：空闲卸载守护（改为前门内部定时器）

### 改造
- `src-tauri/src/models.rs`：preset 生成器写入 `port`（§3.1）
- `src-tauri/src/ipc.ts` / 前端 `src/api/router.ts`：单端点化
- 前端 `src/components/LogPanel.tsx`：按模型过滤

### 删除 / 降级
- `router.rs` 的 router 进程管理（退役为兼容模式）
- 前端 `src/store.ts` 的 4 处显存互斥编排（`:881`、`:920`、`:1005`、`:1165`）—— 前门统一调度后天然成立
- 前端 `src/api/router.ts` 的 `chatTargets()`（不再从 `status.args` 里解析 `--port`）

---

## §8 分阶段实施

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| **P0** | 配置层：`<exe 目录>\config\llamacpp-<id>.json` 读写 + `presets.ini` 存量迁移 + 端口分配算法（§3.1 / §3.3） | JSON 读写单测；迁移后 `presets.ini.bak-<时间戳>` 存在、14 份 JSON 都能被扫描到 |
| **P1** | 前门 llama.cpp 通道（单模型）：客户端触发加载 → 固定端口启动 → 转发 → 日志打标签 | 用 curl 打一次完整对话，观察启动与转发 |
| **P2** | 多模型并存 + 容量策略（§4.4） | 同时请求两个模型，观察显存与状态 |
| **P3** | Strata 通道纳入统一入口（config 端口分配 + 写回 run 脚本） | 两个通道的模型出现在同一个 `/v1/models` |
| **P4** | 统一 `/metrics` 形状（llama.cpp 指标 + Strata 硬件） | 与现有 9090 `/metrics` 输出对比 |
| **P5** | 前端单端点化 + 日志按模型过滤 | GUI 走一遍：选模型 → 聊天 → 监控 → 日志 |

> **排序约束（由 §10 决策结果 4 派生）**：router 立刻退役、不留兼容模式 → **本表原稿末句「每阶段结束都能停在 router 模式上」作废**，没有这条安全网，出问题只能 git 回滚，动工前先开分支、打 tag。**P5 必须与 P1 同批交付**：GUI 现在靠 router 的 `status.args` 解析端口决定往哪发（`src/store.ts:750` → `src/api/router.ts:240` 的 `chatTargets`），router 一退役该链路立刻断，P1–P4 期间应用连不上任何模型、只能用 curl 验收。原 **P6「（可选）退役 router」** 随决策 4 一并删除（已定立刻退役）。

---

## §9 必须实测的清单

1. **llama-server 单实例（`-m` + 参数）的启动/停止时序**与显存释放速度（router 模式下是子实例，行为可能不同）。
2. **客户端断连/取消时 llama-server 的行为** —— 是否继续生成、是否要显式取消（Strata 侧已有 `_watch_client` 的教训，llama.cpp 侧未知）。
3. **两个模型并存**时的显存占用、启动失败行为、以及 `--fit` 的相互作用（铁律 6：默认不传 GPU 参数）。
4. **固定端口被占用**时前门的报错路径。
5. **`/v1/models` 合成的客户端兼容性**（DSH、llama.cpp 自带 WebUI、常见客户端是否接受额外字段 `channel`/`loaded`/`port`）。
6. **固定端口子实例 + `--metrics`** 的输出（router 下已验证会下发；单实例直接加参即可，需实测确认无副作用）。
7. **Strata 侧 run 脚本 `--port` 与 config `port` 的一致性**处理（现有校验在 `strata.rs:544`）。

---

## §10 待决策项

| # | 问题 | 建议 |
|---|---|---|
| 1 | **容量策略**：不限 / 上限 N / 显存预算 | **C 显存预算 + 可配上限**（复用 `fit_preview`）；理由是 GPU 显存是硬约束，盲加载失败的体验最差 |
| 2 | **统一入口端口**：只留 9090 / 同时保留 8210 | **只留 9090**，8210 随 router 一起退役 |
| 3 | **端口号段回收**：删除模型后其 `port` 是否复用 | **不回收**（避免历史端口被复用后客户端连到新模型） |
| 4 | **是否保留 router 兼容模式** | **保留一个版本周期**（开关切换），回归稳定后再删 |

### §10 决策结果（2026-10-14 用户定稿）

| # | 决策 | 落实要点 |
|---|---|---|
| 1 | 容量策略 = **多模型驻留 + spawn 前 `fit` 预览 + 不够先卸最久未用，仍不够直接报错不启动**；上限 N = **4**（复用现有 `models_max`：`src-tauri/src/types.ts:34` 必填、`src/components/SettingsPanel.tsx:471` 已有输入框，默认 4） | 淘汰保护照抄 router：忙碌模型不被淘汰（`pick_victim` 跳过 `req_count != 0`、非 ready_or_sleep、不在 `stopping_models`）。预览用 `src-tauri/src/gpu.rs` 的 `parse_fit_preview` + `src/utils/fitCache.ts`，零新依赖 |
| 2 | 统一入口端口 = **只留 9090**，8210 随 router 退役消失 | `settings.json` 的 `port` 语义改为「前门固定端口」（现值 8210 要迁移）；所有客户端（dsh、自带 WebUI）连 9090 |
| 3 | 端口号段 = **不回收**，只增不减 | preset 段写入的 `port` 只写不删，新增模型永不复用已删除模型的端口 |
| 4 | router 兼容模式 = **立刻退役，不留兼容模式**（推翻本表建议的「保留一个版本周期」） | 无回归基线：§8「每阶段结束都能停在 router 模式」这条安全网失效，出问题只能 git 回滚。前端要同批删除：`src/store.ts:881`、`:920`、`:1005`、`:1165` 四处显存互斥编排与设置项 `strata_router_mutex`；`src/api/router.ts:240` 的 `chatTargets` 作废（`src/store.ts:750` 在用） |
| 5 | llama.cpp 侧配置层 = **一个模型一份 JSON**（`<exe 目录>\config\llamacpp-<id>.json`），`presets.ini` **彻底退役**（2026-10-14 追加） | 命名规则、JSON 结构、8 处连带改动、存量迁移全部见 §3.1。要点：`<id>` = 原 preset 段名，非法文件名字符统一换 `-`；`config\` 只放模型 JSON（设置与缓存文件原地不动）；`args` 数组 + 顶层契约字段（`name` / `model` / `mmproj` / `exe` / `port` / `host` / `api_key` / `no_webui` / `log`）；缺配置自动补一份最小 JSON；存量 14 段一次性迁移并备份 ini；**与 M1 同批，配置层替换约 +2–3 天**；`settings.aliases` **整表退役**（2026-10-14 用户定稿，替代机制见 §3.1） |

> **由决策 4 派生的窗口期（实施排序约束）**：GUI 现在是从 router 的 `status.args` 里解析端口决定往哪发（`src/store.ts:750` → `chatTargets`），router 一退役该链路立刻断 —— P1–P4 期间应用连不上任何模型，只能用 curl 验收。因此 **§8 的 P5（前端单端点化 + 删四处互斥）必须与 P1 同批交付，不能排在最后**。

---

## §11 风险

- **失去上游适配**：llama.cpp 新增端点/能力（例：PR #25330 的 router 指标聚合）不再自动获得。
- **双模式测试面翻倍**：P0–P5 期间两套路径都要能跑。
- **多模型并存的显存竞态**：两个模型同时启动时，`fit` 预览与实际占用可能不一致（预览是估算）。
- **前端改动面**：`store.ts` 的互斥编排、`api/router.ts` 的端口解析、模型加载/卸载入口都要改，属于「牵一发动全身」但不难。
- **`--no-ui` 铁律的语境变化**：以前是「别关掉子实例的 WebUI」；自己管引擎后，该参数由前门显式决定（默认应为「开」）。
