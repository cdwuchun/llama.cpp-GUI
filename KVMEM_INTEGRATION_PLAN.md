# kvmem-llama.cpp 整合方案

> **状态：方案，未实施**（截至 2026-10）。本文只做了调研与设计 —— 代码里没有 `kvmem.rs`、没有 `KvmemPanel.tsx`、也没有 `kvmem_*` 命令；要落地就从 §7 落地顺序的 P0 开始。
>
> **与 Strata 通道的关系**：两份方案**结构同构**（都是「第二运行时通道」），而 Strata 那条通道**已经落地**（见 `STRATA_INTEGRATION_PLAN.md`）。真正开工时应当**先读它**：进程槽、端口顺延、日志采集、非 ASCII 修复、config 原子写与备份、显存互斥、托盘菜单灰显、崩溃监测这些基础设施，照着 `src-tauri/src/strata.rs` + `src-tauri/src/state.rs` 做比重新设计省事得多；`HANDOVER.md` §2.11 是那条通道踩出来的约束。

> 调研对象：<https://github.com/kvmem/kvmem-llama.cpp>
> 本文所有 GUI 侧结论都来自本仓库代码实测（文件:行号），kvmem 侧结论来自其 README.md、docs/architecture.md 与 GitHub release 资产。

---

## 0. 结论先行

**kvmem 不能塞进现有的 router 流水线，只能作为「第二运行时通道」并列接入。**

三条硬事实决定了这一点：

1. **二进制不同名**：kvmem 的产物是 `llama-kvmem-server` / `llama-kvmem-cli`，不是 `llama-server`。`src-tauri/src/versions.rs:276 scan_versions` 只认 `llama-server.exe`，现在扫到 kvmem 包会**直接忽略**。
2. **没有 router mode**：kvmem 不接受 `--models-preset` / `--models-dir`。README 原文：*"This is an independent server with one lane by default, so it does not yet accept every `llama-server` option."* `--parallel 2..4` 是**同一模型**的 P 个 lane 共享权重，不是多模型路由。
3. **管理端点不存在**：前端 `src/api/router.ts` 依赖的 `GET /models`、`POST /models/load`、`POST /models/unload`、`GET /props?model=`、`GET /models/sse` 在 kvmem 上**全部 404**。kvmem 只有 `/health`、`/v1/models`、`/v1/chat/completions`、`/v1/responses`。

所以整合的正确形态是：**新增一条独立的 kvmem 实例生命周期通道**，复用 GUI 已有的进程管理、端口、日志、非 ASCII 修复、压测、模型目录扫描等基础设施，router 那条线**一行不改**。

**好消息**：`src-tauri/src/bench.rs:136` 压测打的是 `POST /v1/chat/completions`，kvmem 也有这个端点 —— 压测可以零改动复用。

---

## 1. 两边能力对照

| 维度 | GUI 现有（llama.cpp router mode） | kvmem-llama.cpp |
|---|---|---|
| 二进制 | `llama-server.exe` | `llama-kvmem-server.exe` |
| 运行形态 | 1 个 router + N 个子实例，按需加载/卸载 | 单进程单模型，`--parallel` 同模型多 lane |
| 模型来源 | `presets.ini` 段名 = 模型 id | `--model <gguf>` 单文件 |
| 模型支持 | 任意 GGUF | **仅 Qwen3.8-27B**（含 IQ3/IQ4） |
| 管理端点 | `/models` `/models/load` `/models/unload` `/props` `/models/sse` | 无 |
| 推理端点 | `/v1/chat/completions` `/v1/responses` | 同 |
| 自带 WebUI | 有（router 版可切模型） | 有（含 KVMem 面板，`--ui-dir` 随包） |
| 显存策略 | 原生 `--fit`（GUI 默认不传 GPU 参数） | **强制 `--fit off`** + `--mlock` + `--flash-attn` + `--n-gpu-layers 99` |
| CUDA 运行时 | 需外部 `cudart-llama-bin-win-cuda-*` 共享包，GUI 注入 PATH | **包内自带**，无需外部包 |
| 空闲回收 | `src-tauri/src/idle.rs` 轮询 `/models` 卸 sleeping | 不适用（无该端点） |
| 平台 | Windows / Linux / macOS | Windows + Linux（CUDA），ROCm 实验性，**无 Metal** |
| 路径约束 | 非 ASCII 走 `winfix` mklink /J | 包内 README 明文要求**全路径不含中文** |

---

## 2. 三条路线与取舍

| 路线 | 做法 | 评价 |
|---|---|---|
| **A 独立通道**（推荐） | kvmem 作为第二类运行时，独立启停/日志/参数/聊天入口 | 侵入最小，router 零改动，可分阶段落地 |
| B 并入模型列表 | kvmem 模型与 router 模型在同一个列表里并列 | 前端每个用到 `routerModels` 的地方都要分叉（`store.ts` 723 行、`ModelListPanel.tsx`、`idle` 轮询、SSE 面板），改动面大且语义混乱：kvmem 没有「加载/卸载」概念 |
| C 给 fork 加 router mode | 改 `patches/llama-kvmem-current.patch` 让 kvmem 支持 `--models-preset` | **不做**。超出本仓库范围，且 kvmem 的 KV 预算是全局独占的（GPU 块槽池 + host store + NVMe 文件），多模型共享显存与它的预算模型冲突 |

**选 A**。B 里唯一值得要的东西（「一个界面里同时看到两类运行时」）用 A 的「运行时切换器」也能达到，成本低得多。

---

## 3. 目标形态

```
┌ GUI ──────────────────────────────────────────────┐
│  运行时选择： [ llama.cpp router ] [ KVMem 实例 ]  │
└───────────────────────────────────────────────────┘
      │                        │
      │ router.rs（不动）       │ kvmem.rs（新增）
      ▼                        ▼
 llama-server.exe          llama-kvmem-server.exe
 --models-preset ...       --kvmem --model <gguf> --fit off ...
 :8080 (router)            :8180 (单实例)
      │                        │
 前端 src/api/router.ts    前端 src/api/kvmem.ts
 /models /props /sse        /health + /v1/*
```

两条通道**互斥启动**（同一块显存不能同时喂两个 27B），GUI 顶部做互斥提示。

---

## 4. 后端设计

### 4.1 新增 `src-tauri/src/kvmem.rs`

照 `src-tauri/src/router.rs` 的骨架写，复用它的私有工具（`compose_path_env` 逻辑、日志管道读取），**不要**复用 `build_router_args`（参数集完全不同）。

```rust
pub struct KvmemInstance {
    pub process: Option<Child>,
    pub port: u16,
    pub log_source: String,   // 固定 "kvmem"，见 §4.5
    pub binary: PathBuf,
    pub model: PathBuf,
}

/// 组装参数：强制项写死，用户项从设置里取。
pub fn build_kvmem_args(cfg: &KvmemConfig, port: u16) -> Vec<String> {
    // 强制项（README 明文，不可关闭）：
    //   --fit off --mlock --flash-attn --mamba-sdpa=false --n-gpu-layers 99
    // 产品默认：--kv-dtype q8_0
    // 必带：--model <gguf> --host 127.0.0.1 --port <port>
    // 可选：--ctx-size --parallel --kvmem-* --api-key --spec-type draft-mtp ...
}
```

`spawn_kvmem` 直接照搬 `src-tauri/src/router.rs:223 spawn_router` 的五个要点：

1. `winfix::ensure_ascii_dir` 非 ASCII 路径修复（kvmem 对中文路径更敏感，包内 README 明文禁止）；
2. `winfix::port_in_use` / `find_free_port` 端口顺延；
3. spawn + `winfix::hide_console`；
4. **先接 stdout/stderr 再等端口就绪**（Windows 匿名管道仅 ~4KB，顺序错了子进程写满管道阻塞、父进程等端口超时 → 死锁）；
5. 20s deadline，失败分支必须 `kill` + `wait` 收掉子进程，避免孤儿进程占显存。

kvmem 包自带 CUDA 运行时，**不需要** `compose_path_env` 注入共享 CUDA 目录 —— 这条链路对 kvmem 跳过。

### 4.2 扩展 `src-tauri/src/versions.rs`

- `scan_versions`（`:276`）增加对 `llama-kvmem-server.exe` 的识别，`LlamaCppVersion` 加字段 `is_kvmem: bool`（或 `bin_kind: BinKind`）。
- **不要**对 kvmem 二进制跑 `llama-server --help` 式的 router mode 探测（`:175`）—— kvmem 恒不支持 router，探测无意义且浪费一次进程启动。给 kvmem 走独立的探测：跑 `--help` 抓 `--kvmem` 是否出现，作为「参数集版本」的缓存判据，复用 `cached_probe`（`:248`）的 TTL 缓存结构。
- 扫描目录布局：kvmem 包解压后是 `kvmem-<ver>-win-x86_64-cuda*/`，与现有 `<root>/<版本子目录>/` 布局兼容，`scan_versions` 的两级查找逻辑可直接复用。

### 4.3 设置与类型

`src-tauri/src/types.rs` 新增 `KvmemConfig`：

```rust
pub struct KvmemConfig {
    pub enabled: bool,
    pub binary_dir: Option<PathBuf>,
    pub model_path: Option<PathBuf>,
    pub port: Option<u16>,
    pub ctx_size: Option<u32>,        // 默认 4096，产品目标 256K
    pub parallel: Option<u8>,         // 1..4
    pub gpu_tokens: Option<u32>,      // --kvmem-gpu-tokens
    pub retrieval_tokens: Option<u32>,
    pub gen_reserve: Option<u32>,
    pub block_tokens: Option<u32>,
    pub recent_blocks: Option<u32>,
    pub retrieval: Option<f64>,
    pub recency: Option<f64>,
    pub host_tiers: Option<String>,   // "host" | "host,nvme"
    pub cpu_gb: Option<f64>,
    pub nvme_path: Option<PathBuf>,
    pub nvme_gb: Option<f64>,
    pub conversations: Option<u32>,
    pub mtp: bool,                    // --spec-type draft-mtp
    pub extra_args: Option<String>,
}
```

`SettingsPatch`（`src-tauri/src/lib.rs:62 settings_set`）加 `kvmem: Option<KvmemConfigPatch>`。

### 4.4 命令注册（`src-tauri/src/lib.rs`，同步 `src/ipc.ts`）

```
kvmem_status()      -> KvmemStatus { running, port, binary, model }
kvmem_start()       -> Result<KvmemStatus>
kvmem_stop()        -> ()
kvmem_scan()        -> Vec<KvmemVersion>     // 复用 versions.rs
kvmem_pick_model()  -> Option<PathBuf>       // 复用 models::scan_models 的目录扫描
kvmem_diag()        -> String                // 读 --kvmem-diag 输出（日志尾部）
```

`run()` 的 `generate_handler![...]` 里追加；`src/ipc.ts` 加同名 wrapper。

### 4.5 日志

`router.rs:44 classify_log_source` 靠行首 `[<端口>]` 识别子实例，是 router 专用。kvmem 是单进程，日志源固定标 `kvmem`，直接进现有 `logs_snapshot`（`lib.rs:326`）缓冲区，日志页加一个来源筛选。

---

## 5. 前端设计

### 5.1 新增 `src/api/kvmem.ts`

kvmem 没有 router 管理端点，客户端极薄：

```ts
export async function kvmemHealth(port: number): Promise<boolean>   // GET /health
export async function kvmemModels(port: number, key?: string)       // GET /v1/models
export function kvmemChatUrl(port: number): string                  // http://127.0.0.1:<port>/
```

鉴权沿用 `authorization: Bearer <key>`（kvmem 同源 llama.cpp，`--api-key` 行为一致，**需实测确认**）。SSE 同理不能用 `EventSource`。

### 5.2 `src/store.ts` 扩展

新增独立状态片，**不改动** router 相关 action：

```ts
kvmemStatus: KvmemStatus
kvmemConfig: KvmemConfig
startKvmem() / stopKvmem() / saveKvmemConfig()
openKvmemChat()   // open_local_url(`http://127.0.0.1:${port}/`)
```

`openKvmemChat` 复用 `lib.rs:736 open_local_url`，与 `store.ts:472 openModelChat` 同一条出口。

**互斥检查**：`startKvmem` 前若 `status.running` 为真，提示「router 正在运行，KVMem 需要独占显存，是否先停止 router？」；反向同理。

### 5.3 页面

- 侧栏加一项「KVMem 实例」，新组件 `src/components/KvmemPanel.tsx`（遵守铁律 7：**只导出组件**，工具函数进 `src/utils/kvmem.ts`）。
- 面板内容：二进制选择 / 模型选择（复用模型目录扫描）/ 端口 / 启停按钮 / KVMem 参数表单 / 打开聊天 / 诊断输出。
- 顶部状态条在 kvmem 运行时显示 `KVMem :8180`，与 router 状态并列。

### 5.4 参数面板

**不要**把 `--kvmem-*` 塞进 `src/assets/params.json`：那张表是 hub 参数表，有 `import_hub_params`（`models.rs:244`）覆盖机制和 `RETIRED_PRESET_KEYS` 校验，混入专有参数会污染 hub 导入与 preset 校验。

新建 `src/assets/kvmem-params.json`，独立渲染。表单分两组：

- **强制项**（只读展示，说明「kvmem 要求，不可关闭」）：`--fit off`、`--mlock`、`--flash-attn`、`--mamba-sdpa=false`、`--n-gpu-layers 99`、`--kv-dtype q8_0`
- **可调项**：`--ctx-size`、`--parallel`、全部 `--kvmem-*`、MTP 组

---

## 6. 分阶段实施

### P0 — 跑通（后端为主，前端最小）

| # | 改动 | 文件 |
|---|---|---|
| 1 | 识别 `llama-kvmem-server.exe` | `src-tauri/src/versions.rs:276` |
| 2 | `KvmemConfig` + 设置持久化 | `src-tauri/src/types.rs`、`lib.rs:62` |
| 3 | `build_kvmem_args` + `spawn_kvmem` + `stop_kvmem` | 新建 `src-tauri/src/kvmem.rs` |
| 4 | 6 个命令 + `ipc.ts` wrapper | `src-tauri/src/lib.rs`、`src/ipc.ts` |
| 5 | 侧栏入口 + 启停 + 打开聊天 | `src/App.tsx`、新建 `KvmemPanel.tsx`、`src/store.ts` |

**验收**：Windows + RTX 50 系，加载 Qwen3.8-27B IQ4，`ctx-size 256K`，GUI 里点启动 → 端口就绪 → 点「打开聊天」进 kvmem 自带 UI 能对话；点停止进程干净退出、无孤儿。
`npx tsc --noEmit` 通过；`cd src-tauri; cargo test --lib` 通过（为 `build_kvmem_args` 加单测，锁死强制参数不可被 `extra_args` 覆盖）。

### P1 — 可用

- `src/assets/kvmem-params.json` + 参数表单；
- 日志来源筛选加 `kvmem`；
- 压测复用：`bench.rs` 的目标端口从「router 端口」改为「当前活动运行时端口」（`bench.rs:136` 端点不变）；
- router / kvmem 互斥提示与一键切换；
- `--kvmem-diag` 输出面板（GPU 槽池占用、host store、检索命中）。

### P2 — 融合

- 模型管理页把 Qwen3.8-27B 标为「KVMem 可用」徽标；
- 显存预算联动：kvmem 启动前用 `nvidia-smi` 查空闲显存，对 `gpu_tokens × ctx_size` 给预估与告警（kvmem 强制 `--fit off`，GUI 现有的 `fit_preview`（`lib.rs:352` `llama-fit-params`）对它无效，需要自建估算）；
- 更新检查：`updates.rs` 增加对 `kvmem/kvmem-llama.cpp` releases 的跟踪（注意 release 线分 llama.cpp 后端 / NInfer 后端两条，只跟前者）。

---

## 7. 风险与硬约束

| 风险 | 说明 | 应对 |
|---|---|---|
| **只支持一个模型** | 仅 Qwen3.8-27B（含 IQ3/IQ4）。用户装完发现「跑不了我的模型」 | 面板顶部固定说明；模型选择器只列 Qwen3.8-27B 系 |
| **强制 `--fit off`** | GUI 铁律 6「默认不传 GPU 参数，交给原生 `--fit`」在 kvmem 上**失效**，显存超发风险由 kvmem 自己承担 | 参数面板把强制项设为只读并说明原因；P2 自建显存预估 |
| **中文路径** | kvmem 包内 README 明文禁止全路径含中文（比 GUI 的 `winfix` 更严） | 启动前校验，命中直接给中文报错，不静默走 mklink |
| **包体量大** | 单个 CUDA 预编译包约 964 MB，自带 cuBLAS | 更新页显示体积；不自动下载 |
| **release 线分裂** | `v0.16.0-rc3`（llama.cpp CUDA 预编译）/ `v0.17.0`（仅源码）/ `v0.18.0-ninfer-rc2`（**NInfer 后端，模型格式不同**） | 只跟 llama.cpp 后端线；NInfer 资产在 UI 里明确标注为不兼容 |
| **上游已知缺陷** | issue：v0.17.0 "prefix reuse collapses to full recompute when the trailing user message is rewritten each turn"（2026-10-06） | 版本面板显示上游 issue 摘要，避免用户归因给 GUI |
| **无 macOS** | kvmem 无 Metal 支持 | macOS 侧隐藏该入口 |
| **鉴权行为未实测** | `--api-key` 在 kvmem 上的 401 语义、CORS 是否放开，均未验证 | P0 第一件事就是实测；若 CORS 收紧，聊天入口继续走 `open_local_url` 外部浏览器（现有做法），不受影响 |
| **显存互斥** | router 与 kvmem 都要吃满显存 | 启动前互斥检查，禁止并行 |

---

## 8. 明确不做

- 不改 `patches/llama-kvmem-current.patch`，不 fork kvmem；
- 不给 kvmem 造 router mode；
- 不把 kvmem 模型混进 `presets.ini`（`models.rs` 生成的 preset 文件只服务 router，混入会让 kvmem 专有键触发 `RETIRED_PRESET_KEYS` 类校验风险，且 router 整体启动会因未知键失败）；
- 不把 kvmem 纳入 `idle.rs` 的空闲回收（无对应端点）；
- 不在 GUI 内做模型转换（kvmem 的 `.ninfer` / Q8 转换属于上游）。

---

## 9. 动手前需要实测确认的 5 件事

1. Windows CUDA 预编译包的**资产命名**与解压后的目录布局（决定 `scan_versions` 的识别规则）；
2. `llama-kvmem-server.exe --help` 的完整参数输出（校准 `kvmem-params.json`，并作为探测判据）；
3. `--api-key` 的鉴权覆盖面与 CORS 默认值（决定前端能否直连 `/v1/*`）；
4. 端口被占用时 kvmem 是否自动顺延（包内 README 说会顺延 —— 若真顺延，GUI 传入的 `--port` 与实际监听端口可能不一致，必须从日志里解析真实端口，同 `router.rs` 的做法）；
5. `--kvmem-diag` 的输出格式（决定诊断面板怎么解析）。

---

## 10. 一句话总结

**把 kvmem 当成「第二个 llama-server」而不是「router 的一种新模型」**：后端加一条 `kvmem.rs` 通道、前端加一个面板，router 那条线一行不动。P0 大约 5 个改动点就能跑通对话，P1 补齐参数与压测，P2 才做显存与模型层的融合。
