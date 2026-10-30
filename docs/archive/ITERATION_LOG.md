# 迭代记录（0.1.x → 0.2.0 逐轮实现日志）

> 从 `HANDOVER.md` 拆出（2026-10-20，用户要求精简交接文件）。这里按轮次记录每一次改动的**原因、实测证据、踩过的坑**，
> 行号与文件路径都已过时，只作历史参考；现行约束与代码地图看 `HANDOVER.md`。
> 编号保持原样（原 §5、§8 的 14–79 号、以及各 build 记录），引用形如「见 ITERATION_LOG §21」。

---
## 5. 最近这一批迭代（README 未覆盖）

### 5.1 兼容性与正确性
| 问题现象 | 根因 | 落点 |
|---|---|---|
| 启动提示"无效的 api key，模型也无法加载" | 配了 `--api-key` 后 router 全端点要鉴权，前端一个头都没带 | `api/router.ts` 全部请求带 `authHeaders()`；store 订阅设置变化调 `setRouterApiKey` |
| 填了 key 后模型加载进度不再更新 | `EventSource` 无法带鉴权头 | `/models/sse` 改成 fetch 流解析 + 重连（鉴权失败 6 次放弃，网络失败 40 次 ≈60 秒，扛得住 router 重启） |
| 压测报 `model '…' not found` | 前端发了扫描 id 而不是 preset 段名，合并时又没带别名 | `BenchPanel` 用 `selected.section`；`mergeModels` 传入 `settings.aliases` |
| 新增模型刷新不出来 / 已删除的模型还在 | router 内存里的 preset 快照没重读 | 刷新改 `?reload=1`（两处调用点） |
| llama.cpp 换成 b11065 后 router 起不来 | preset 里残留 `no-mmap` | `RETIRED_PRESET_KEYS` 逐行丢弃 + 配置弹窗不显示淘汰键 |
| mmproj / 草稿文件被当成主模型，配置里又选不到它们 | 扫描只输出主模型 | `aux_files` 通道 + 路径选择控件接 `aux_files` |

### 5.2 参数表单（`ParamForm.tsx` + `assets/params.json`）
- 上下文窗口大小 `ctx-size` 是**下拉**（4K/8K/16K/32K/64K/128K/256K），不是纯数字输入。
- `mmproj-device` / `spec-draft-device` 是**设备下拉**，选项来自 `device_list`，另有"（未设置，用模型默认）"。
- 路径参数三类：`mmproj`（文件，只看 gguf）、`spec-draft-model`（文件，全部模型）、`video-ffmpeg-dir`（**目录**，走 `open({directory:true})`）。
- JSON 参数是只读输入 + 代码图标按钮 → 弹窗编辑，保存时 `JSON.parse` 校验并去掉换行。
- select 的当前值不在候选里时补一个占位选项，避免显示成空白（参照实现旧版的"下拉空白"就是这个原因）。
- LOGIC / BOOLEAN 参数按 `false` / `true` 下拉呈现。
- 参数说明（问号）**不用原生 `title`**：点问号开 `#paramDescModal`（对齐 hub 旧版），正文限宽换行 —— 见 §3.4 ③。

### 5.3 显存预估（llama-fit-params）
配置弹窗左栏、「设备」区下方有「估算显存」按钮，结果就地显示成一张逐卡小表（设备 / 模型 / 上下文 / 计算，单位 MiB）。
- 后端：`lib.rs::fit_preview` 命令 → `gpu::fit_preview` 跑 `llama-fit-params --model <gguf> -fitp on`（`-fitp` = `--fit-print`，默认 off），解析在 `gpu::parse_fit_preview`。
- 实测输出形如 `CUDA0 603 3584 298`，多卡每卡一行，另有 `Host` 行（= 留在系统内存的部分，界面显示成「Host（内存）」）。
- 依赖所选版本目录里带 `llama-fit-params.exe`（扫描时记为 `fit_params_bin`，版本表里有一列 ✓/—）；缺了会返回一句可读的提示，而不是失败在别处。
- **结果按模型各记一份**（`fitPreviewCache`，`utils/fitCache.ts`，最多 30 个模型、超出丢最旧的）。
  条目里记着模型路径、**参数指纹**、llama.cpp 版本与设备集合。重开弹窗（或重启应用后打开同一个模型）
  直接显示上次结果并标注「上次估算 HH:MM」；**参数动过只提示「结果可能要重算」，不自动跑**（一次要几秒，
  由用户点「重新估算」）。
  - 指纹**只含与显存相关的参数**（`NON_MEMORY_KEYS` 排掉采样/线程/结构化输出那些）——
    早期用全量 entries，改个温度也会提示重算，纯噪音；而 `kv-unified` / `mmproj` / `spec-*`
    虽然 fit-params 不认、却确实影响占用，必须留在指纹里。
  - 存储位置：WebView2 的 localStorage，落盘在 `<便携目录>\webview\EBWebView\Default\Local Storage\leveldb\`（回退到系统目录时在 `%LOCALAPPDATA%\dev.llamacpp.gui\` 下）。
    排查时可以直接读这个 leveldb 文件（字符串是明文，搜 `fitPreviewCache`）确认存了什么。
- **参数会一起传过去**（`gpu::build_fit_args`）：显存占用与右边那套参数强相关，不传就是白算。
  白名单是拿 `llama-fit-params --help` 的**选项定义行**与 `params.json` 的键求交集得来的
  （`tmp/fit-whitelist.mjs` 可随时重算，help 存于 `tmp/fit-params-help.txt`）。实测会改变预估的有：
  `-c`（默认 ctx 就是 32768，所以传相同的值看不出变化）、`-ctk/-ctv`（KV 量化，3584→1904）、
  `-b/-ub`（计算缓冲 298→1192）、`-ngl`、`-n-cpu-ffn`（603→565）、`-nkvo`（KV 转到 Host）、`-ts`、
  `-np`（并行槽位数，`--parallel 4` 把上下文占用抬上去）。
  **布尔键的取反**：只有 help 里成对出现的（`kv-offload`、`op-offload`）才允许 `为假 → --no-xxx`；
  `cpu-moe` / `swa-full` 没有 `--no-` 形式，传了直接 `error: invalid argument`（实测）。
- **筛选白名单别用关键词**：早期按 cpu/offload/moe 这类关键词筛，漏掉了 `parallel` 与 `lazy-mode`。
  用 `tmp/fit-whitelist.mjs` 跑**全量交集**再人工判断，才是可靠做法。
- **局限**：`llama-fit-params` 不认 `--mmproj` / `--model-draft` / `--kv-unified`（实测 invalid argument），
  所以多模态投影、草稿模型本体、投机解码（`spec-type`，含模型自带的 `draft-mtp` MTP 头）、`kv-unified`、
  `--mmproj-offload` 这些占用**算不进表里** —— 界面会在表下用黄色小字列出「未计入：…」。
  它也不建模 CUDA context / cuBLAS workspace 这类固定开销。按「全部可见设备 + 设置里选中的版本」计算，
  不套用弹窗里勾选的设备与主 GPU。
- **实例（35B-A3B MoE，2026-09-21 实测）**：preset 段 `ctx-size 131072 + cache-type-k/v q8_0 +
  ubatch-size 1024 + gpu-layers 99 + n-cpu-moe 26 + flash-attn on + load-mode mmap+mlock` 算出
  `CUDA0 8105 / 1422 / 994`（≈10.3 GiB）+ `Host 13187`。该模型另外开着 `spec-type = draft-mtp`
  与 `kv-unified = true`，这两项**不在数字里**，实际占用会更高。

### 5.4 服务卡片：一处保存（2026-10-15 重构，用户 m06341）
设置页「服务」组＝前门监听地址 / 前门端口 / 同时加载模型上限 / 空闲释放模型（秒）/ API Key，
再往下是 Strata 的引擎空闲卸载（秒）/ 显存门槛（MiB）/ 加载前命令 —— **只有一处「保存」**（`SettingsPanel.tsx::saveService`）。
保存链路：`saveSettings({ llama_cpp_dir, strata_host, strata_port, models_max, sleep_idle_seconds, api_key })`
→ `ipc.configSetApiKey(key)` 写进**所有** `llamacpp-*.json`（空串 = 清掉 `api_key`，子实例就不带 `--api-key`）
→ 逐份 `strata-*.json` 写顶层 `api_key` / `idle_unload_s` / `min_free_vram_mib` / `before_load`（留空 = 不改原值，indent=1）
→ **前门端口或监听地址变了且前门在跑 → 自动 `stopStrataProxy()` + `startStrataProxy()`**（不再弹询问窗，`#restartRouterModal` 与 `commitCore` 已删）。
配套：前门**不代客户端补 key**（用户 m06545 明确要求）—— 客户端带的 `Authorization` / `x-api-key` 原样透传给引擎，没带就由引擎自己 401；地址/端口只进 GUI 设置，**不写 config**（写进去会把各模型引擎端口覆盖成 9090）。
空闲释放语义：`-1` / `0` / 空都表示关闭，只把 `> 0` 的值写进设置。settings.json 的 `port`（默认 8080）是 router 时代的**死字段**：Rust 只写不读，UI 已不暴露（字段保留只为兼容旧文件）。

### 5.5 图标
- 应用图标（exe / 任务栏 / 窗口）＝ `icons/icon.ico` 的**第一项**（`tauri-codegen::CachedIcon::new_ico` 取 `entries()[0]`），所以第一项必须是 **64px 两层**图形；`bundle.icon` 里的 PNG 在 Windows 上不起作用。
- 安装包图标由 `bundle.windows.nsis.installerIcon` 决定（原先没设 → 安装包显示 NSIS 默认的绿色箭头图标）。
- **`tauri-build` 不监听 `icons/*`**：换图标后必须删掉它的产物再构建，否则 exe 里还是旧图标：

```powershell
Remove-Item -Recurse -Force src-tauri\target\release\build\llamacpp-gui-*, src-tauri\target\release\.fingerprint\llamacpp-gui-*
npm run tauri build
```

- **Windows 图标缓存按路径记**：覆盖同名 exe 后资源管理器仍显示旧图标（把 exe 复制成另一个名字就显示新图标，可用来证明二进制本身没问题）。刷新办法：`ie4uinit.exe -show`；顽固时删 `%LOCALAPPDATA%\IconCache.db` 与 `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache*` 再重启 explorer；任务栏固定项要取消固定再重新固定。
- 全部图标资产由 `node scripts/make-icons.mjs` 生成（解析式绘制 + Node zlib 自编码 PNG，不依赖图形库），同时输出窗口图标与 `tray_icon.rs` 里的托盘 RGBA 常量。约定：四周留白 8%；≤40px 用两层简化图形（三层加细闪电在小尺寸下会糊）。

---


### 14. presets.ini 文本投影退役（第三刀）已落地（2026-10-15）

router 退役后 ini 文本层成了纯死代码，这一刀把它切掉：真源只有 `<配置目录>\config\llamacpp-<id>.json`，界面不再解析任何 ini 文本。

**后端**

- 命令改名：`preset_sync` → `config_sync`；`preset_section_entries` → `config_entries`；`preset_upsert` → `config_upsert`（返回 `()`）；`preset_remove` → `config_remove`（返回 `()`）；`preset_import_hub` → `config_import_hub`；`preset_read` → `config_read(section) -> String`（读单份 JSON 原文，没有则空串）；`preset_write` **删除**（不再有整文件文本写入口）。
- `models::ModelScanResult` 增 `configs: Vec<ConfigEntry>`（`id` / `name` / `no_webui` / `has_model`），删 `preset_path` / `preset_text` / `orphan_sections`；`AppPaths.preset_path` → `model_config_dir`（它本来就是 `config\` 目录）。
- `model_config::render_ini_view`、`model_config::list_orphan_ids` 删除；`build_scan_result` 去掉 `config_dir` 参数。
- `models::import_hub_presets`（吃 ini 文本、吐 ini 文本）→ `import_hub_into_dir(dir, hub_config)`：直接按 config 目录里的 name 匹配 hub 条目并写回 JSON，**导入只增不减**的语义保留。
- `state.preset_path()` **保留**：只剩一次性迁移器读老 `presets\presets.ini`（迁移完成后改名 `.bak-<时间戳>`）。
- 仍必须保留：`models::list_sections` / `models::section_entries` —— 迁移器读老 ini 要用。

**前端**

- store 删 `presetText` / `presetPath` / `orphanSections` / `writePreset`，改持 `configs: ConfigEntry[]`；`sections`（「已配置」）与 `webuiOff`（关掉自带 WebUI 的模型）都从 `configs` 推导，不再解析文本。
- `saveModelSection` / `removeModelSection` 走 `configUpsert` / `configRemove`；`syncPreset` 内部走 `configSync`；`importHubPresets` 走 `configImportHub` 后重扫（配置清单刷新）。
- `ModelSheets` 的「配置」表单初值改异步 `ipc.configEntries(section)`；「模型详情」里原来的「presets.ini 中的该段」改成显示 `ipc.configRead(section)` 的 JSON 原文。
- `PresetEditor.tsx` 移出源码树（`target\bak-PresetEditor.tsx`）；`utils/presetText.ts` 只剩 `parseEnvVars` 在用；`RuntimePanel` 那一行改成显示「模型配置目录」。

**验证**：`cargo test --lib` 111 passed / 0 failed / 7 ignored；`npx tsc --noEmit` exit 0；exe 9,852,928 B / 2026-10-15 13:35:25，备份 `llamacpp-gui.exe.bak-before-configcut`，构建日志 `target\build17.log`。

**清债（2026-10-15 已完成）**：`models.rs` 的 ini 函数族与归档系列整族已删（`read_preset` / `write_preset` / `remove_section` / `ensure_model_section` / `upsert_entries` / `sanitize_preset_keys` / `is_truthy` / `lower_key` / `section_removal_bounds` / `is_blank_or_comment` / `set_archive_path` / `read_archive` / `write_archive` / `archive_sections` / `consume_archived` / `has_archived` / `PruneResult` / `prune_missing_sections` / `restore_archived_sections` / `consume_archived_section`，连同 `ARCHIVE_PATH` / `ARCHIVE_VERSION` / `ArchiveFile` / `ArchiveEntry`），`models.rs` 3155 → 1846 行，连带删掉 19 个 ini 时代的测试（`cargo test --lib` 从 111 passed / 7 ignored 变成 93 passed / 6 ignored）。

- `model_config.rs` 的 `LoadedConfig.path` 字段删除（无人读）；`removed_args` **保留**并加 `#[allow(dead_code)]` —— 它是 `load` 的契约之一（剥掉保留键要给回执），当前只有测试读。
- `scheduler.rs` 的 P2 预留 API（`Stopping` 变体、`ModelRuntime` 的 `port`/`pid`/`error`、`ModelProcess` 的 `port`/`started_at_ms`、`new` / `get` / `get_mut` / `ids` / `runtime` / `active_count`）**故意保留**，逐处加 `#[allow(dead_code)]` + 「P2 预留」注释，警告不再出现。
- **必须保留**（一次性 ini 迁移器仍要用）：`list_sections` / `section_entries` / `section_bounds` / `section_header` / `entry_re` / `RETIRED_PRESET_KEYS`。
- 结果：`cargo check --lib` 警告 24 → 0。删代码用 pwsh 按行切片（备份 `target\bak-models-before-inicut.rs`、`target\bak-models-before-testcut.rs`）；删测试不能按「下一个 fn 起点 − 1」取范围（会吃掉下一个测试的 `#[test]` 属性）。

### 15. 日志功能 + 前门 `/models` 白等 6 秒的修复（2026-10-15）

**日志落盘（用户 m05885「给 gui 添加日志功能，方便排查问题」）**

- 一次运行一个文件：`<配置目录>\logs\gui-<启动时间>.log`（`LogHub::attach_file(config_dir.join("logs"))`，在 `app.manage(state)` 之前挂，顺便 `logs::register_global`）。超 8 MB（`LOG_FILE_MAX_BYTES`）分卷成 `gui-<stamp>-<part>.log`，目录按文件名排序只留最近 12 个（`LOG_FILE_KEEP`）；`prune_logs` 只删 `gui-*.log`，不碰别的文件。
- 行用 `write_all` 直写、**不 flush**：进程被强杀也不丢（BufWriter 会丢尾段、逐行 flush 太慢）。文件 IO 放在 buffer 锁**之外**（显式 `{}` 块收紧 `MutexGuard` 作用域 —— NLL 不会提前 drop 它）。
- 新增命令 `logs_info`（`LogFileInfo { dir, file, lines }`）与 `logs_open_dir`；日志页加了「日志目录」按钮，底部状态行显示当前文件名。
- 前门的逐连接/逐请求细粒度行**只进文件不进面板**（`dbg()` → `push_file_only("proxy", …)`，避免刷掉有用行）；慢连接（≥1 s，`SLOW_CONN_MS`）与错误走 `proxy_event` 进面板，source `system`、前缀 `[前门]`。panic hook 现在**常装**，不再看环境变量。
- 调度器：新增 `scheduler::lock_sched(state)`（`#[track_caller]`），替换全部 8 处 `state.scheduler.lock().unwrap_or_else(...)`；等锁 ≥500 ms（`SLOW_LOCK_MS`）就往日志推一行 `[慢] 等调度器锁 …ms（文件:行号）`。**注意 `#[derive(...)]` 必须紧贴 struct**：把 helper 插在 `#[derive(Debug, Default)]` 与 `pub struct Scheduler {` 之间会直接编译失败（E0774 + `Scheduler::default()` 找不到）。
- `STRATA_PROXY_DEBUG=1` 仍可让前门另写 `%TEMP%\strata-proxy-debug.log`（迁移期保留）。

**`GET /models` 恒定 6 秒（用户 m06134「卡了」）**

- 现象：一次 235 秒的运行里 `GET /models` 216 次，只有 4 次成功；失败耗时高度一致 6091–6183 ms；前端 5 秒轮询 + 5×300 ms 重试永远拿不到结果 → 卡片状态不再更新。
- 根因：`strata_proxy::live_model_name` 在 GUI 槽位为空时，对**每一份** strata config 调 `strata::probe(entry.port, …)`；无人监听时本机「连接被拒绝」要等约 2 秒（实测 2168 / 2056 / 2034 / 2039 ms），三份 ≈ 6.1 秒。`http.rs` 用的是 `TcpStream::connect`，**连接阶段不受 deadline 约束**，所以每次都要白等。
- 修法：`http.rs` 改 `to_socket_addrs()` + `TcpStream::connect_timeout(deadline.min(CONNECT_TIMEOUT = 1 s))`（全局保险，bench / 空闲卸载同受益）；新增 `strata::probe_with_timeout(port, api_key, timeout)`（`probe` 转调它，默认仍是 `PROBE_TIMEOUT = 3 s`）；`live_model_name` 用 `LIVE_PROBE_TIMEOUT = 300 ms` + `LIVE_PROBE_CACHE`（`LIVE_PROBE_TTL = 5 s` 缓存，槽位命中不走缓存）。列表只关心「有没有外部实例在跑」，晚几秒认出没有影响。
- 前端：`refreshRouterModels` 失败与恢复**各写一行**日志（模块级 `modelsFailLogged` 边沿触发，source `frontend`），不再每 5 秒刷屏；`src/api/router.ts` 四个请求加超时（`AbortSignal.timeout`：GET 10 s / 卸载 120 s / 加载 300 s）。
- 同一轮还改了 `logs.rs::force_kill_tree`：`taskkill` 由 `.status()`（等待）改成 `kill.spawn()`（不等），因为两个调用点都在调度器锁内。**但它不是这次「卡了」的原因** —— 新日志里 `[慢]` 一行都没有，别再往那个方向找。
- 验证：`cargo test --lib` 93 passed / 0 failed / 6 ignored；`npx tsc --noEmit` exit 0；exe 9,876,480 B / 2026-10-15 17:50:26（SHA256 前 16 `8EB5364C0FA6F17D`），备份 `llamacpp-gui.exe.bak-before-modelsfix`，构建日志 `target\build29.log`。用户复验：卡片与显存一致、切换不卡。

### 16. 设置页「服务」组归一 + API Key 写进各引擎 config（2026-10-15，用户 m06341）
- 用户四点（原话要点）：API Key 是**要写到各个引擎的配置文件中去的**；把「服务」分组里 Strata 与 router 的选项归一；修改后都要**保存后才生效**；如果改的是前门端口，前门要**自动重启**。
- Rust：`lib.rs` 新增命令 `config_set_api_key(key)`（取 `models::preset_lock()`，遍历 `model_config::load_dir` 的 `DirConfig`，空串写 `None`，返回写入份数），在 `config_entries,` 之后注册；前端经 `src/ipc.ts::configSetApiKey` 调用。（本轮曾让 `strata_proxy.rs::forward` 在缺鉴权头时替客户端补 `Authorization: Bearer`，按用户 **m06545「客户端必须带 key，前门不能自动补」已全部回退**：`UpstreamTarget` 不加 `api_key`，鉴权头只原样透传。）
- 前端：删掉死字段输入「router 端口」（`settings.port`）、删 `restartAsk` 弹窗 / `commitCore` / `coreChanges` / `saveCore` / `saveStrataService`，合并为 `saveService`；原 Strata 组里的「代理监听地址 / 代理端口 / API Key / 保存」重复项删除，前门地址/端口上移到服务组首行；状态行改成「前门运行中 · :9090 / 未运行」+「启动前门 / 停止前门」；说明文案里 `lazy_load` 承诺一并删除（该键已不再由 GUI 补写）。
- 副作用提示：key 写进 config 后引擎会带 `--api-key`（除 `/health` 全要鉴权）；**客户端必须自己带 key**（前门不代补，用户 m06545）—— DSH 等客户端要把 key 配进请求头，否则 401。
- 验证：`cargo check --lib` exit 0（`target\check-apikey.log`）；`cargo test --lib` 93 passed / 0 failed / 6 ignored；`npx tsc --noEmit` exit 0；exe 9,881,088 B / 2026-10-15 18:26:41（SHA256 前 16 `6A487FBB739871EB`），备份 `llamacpp-gui.exe.bak-before-serviceui`（上一版 9,876,480 B / `8EB5364C0FA6F17D`），构建日志 `target\build32.log`。
- 回退「前门代补 key」后复验（用户 m06545）：`npx tsc --noEmit` exit 0、`cargo check --lib` exit 0；exe 9,880,064 B / 2026-10-15 18:32:38（`9CBB49611B22873D`），备份 `llamacpp-gui.exe.bak-before-nokeyinject`（上一版 9,881,088 B / `6A487FBB739871EB`），构建日志 `target\build33.log`。

### 17. 空闲释放接通 + 「同时加载模型上限」保存即生效（2026-10-15，用户 m06652 / m06664）
- 用户两条诉求（原话要点）：「空闲释放模型功能没有生效」；「同时加载模型上限 保存就生效」。
- **空闲释放为什么一直没生效（三处断链，都可 grep 验证）**：① `scheduler::build_model_args`（`src-tauri/src/scheduler.rs`）从来没把 `sleep_idle_seconds` 拼成 `--sleep-idle-seconds`，子实例永远不进入 sleep；② 前门合成 `/models` 的 `models_payload` / `llama_models_payload`（`src-tauri/src/strata_proxy.rs`）只报 `loaded` / `loading` / `unloaded`，永不出现 `sleeping`，而旧 `idle.rs` 只认 `sleeping`；③ 旧卸载线程只在 `strata_proxy::autostart` 里挂，手动点「启动前门」（`strata_proxy_start`）根本不挂。⇒ **重启前门也没用**，它本来就没接上。
- 改法（**不再依赖 `--sleep-idle-seconds`**，见 §2.3）：`idle.rs` 整文件重写（旧的自适应 `/models` 轮询、`parse_models` 与那 4 个单测一起删）——常驻线程、2 s 一轮、每轮 `app.state::<AppState>()` 现读 `sleep_idle_seconds`；`scheduler.rs` 新增 `ModelTable::idle_ids(now_ms, idle_ms)`（只挑 `Ready` + 非 busy + `last_used_ms` 够旧，按最久未用排序；单测 `idle_ids_picks_stale_ready_models_in_lru_order`）与 `pub fn enforce_capacity(state) -> Vec<String>`；挂载点移到 `lib.rs` 的 setup（`app.manage(state)` 之后、前门 autostart 之前）：`idle::spawn_idle_unloader(app.handle().clone())`。
- 上限保存即生效：`lib.rs::settings_set` 里 patch 带 `models_max` 时，保存后立刻 `scheduler::enforce_capacity(&state)` —— 超出上限就按最久未用顺序停到不超为止（都在用/都在启动中就停手，日志 `[gui] 同时加载上限 {max}：已停掉最久未用的 {victim}`）。上限本身在 `ensure_ready` 的容量闸里一直是**实时读**的（`scheduler.rs`：`state.settings.get().models_max.max(1)`），原来只是要等下一条请求才判定。
- 前端文案（`src/components/SettingsPanel.tsx`）：把「上限与空闲释放在下一次起停引擎时生效」改成「同时加载模型上限与空闲释放保存后立即生效（上限改小会立刻停掉最久未用的那个模型）」，并把「原生 sleep / 界面检测到休眠再卸载」那句换成前门自己计时卸载的说法。
- 验证：`cargo check --lib` exit 0；`cargo test --lib` 90 passed / 0 failed / 6 ignored（上一版 93：删掉 `idle.rs` 的 4 个旧测试、新增 1 个）；`npx tsc --noEmit` exit 0；exe 9,897,472 B / 2026-10-15 18:45:55（SHA256 前 16 `00A650B7C6437930`），备份 `llamacpp-gui.exe.bak-before-idlefix`（上一版 9,880,064 B / `9CBB49611B22873D`），构建日志 `target\build34.log`。

### 18. 样式基座 S1：`src/styles/tokens.css` 落地（2026-10-15）
- 位置：按 `UI_STYLE_BASELINE.md` §8 的排序，S1–S8 是 M4 聊天 UI / M6 监控 UI / M7 用量统计三个面板的**硬前置**，所以样式基座先动。S1 = 建 token 文件 + 挂到引入链最前，**只加定义、不改任何使用点**。
- 新增 `src/styles/tokens.css`（91 行）：上游 `E:\AI\Strata\serve\web\tokens.css` 的 87 行**全量照抄**（字号 / 字重 / 行高 / 间距 / 圆角 / 阴影 / 动效 / 明暗两套色板 / `color-scheme`，不裁剪不改名）；本项目补三档圆角 `--st-r-btn:10px` / `--st-r-field:12px` / `--st-r-popover:18px`（对应 `app.css:306` 已定的档位）；末尾是**兼容别名层**（`--bg-color:var(--st-bg)` 等 20 条），供存量 705 处引用零改动继承新色板 —— 别名只减不增，新代码一律用 `--st-*`。
- `src/main.tsx`：在 `./styles/css/all.min.css` 之前加 `import "./styles/tokens.css";`（引入链现在共 5 条，token 排最前）。
- **为什么本步视觉零变化**：`legacy/index.css` 与 `app.css` 的旧 `:root` 定义在本文件之后加载，`--bg-color` 等旧名仍被那边的字面值覆盖 → 别名层此刻不生效。已逐条核对：别名表里 20 个旧变量**全部**在 legacy（19 个）或 `app.css`（`--primary-soft`、`--radius`）里有定义。
- **唯一可见差异**：`color-scheme:light` / `[data-theme="dark"]{color-scheme:dark}`（现状这两个文件里 0 处）→ 深色主题下**原生滚动条与表单控件**跟随主题变深。规格 §3 要求「一个不落」故照抄；不想要就删这两行。
- 上游原文还有两条 `@font-face`（Outfit 拉丁 / 拉丁扩展，`url("../fonts/outfit-*-wght.woff2")`）：字体文件尚未入库，现在写会 404，按 §8 归 **S3**（字体落地）一起加；`--st-font` 变量已照抄，无人引用 → 无影响。
- 验证：`npx tsc --noEmit` exit 0；Vite CSS 产物 `index-*.css` 由 206.53 kB → 209.60 kB（即 token 文件已进包）；exe 9,898,496 B / 2026-10-15 21:41:00（SHA256 前 16 `6E0F0B5C66EA7091`），备份 `llamacpp-gui.exe.bak-before-s1`（上一版 9,897,472 B / `00A650B7C6437930`），构建日志 `target\build35.log`。
- 下一步：**S3 字体落地**（Outfit + 中文子集入库、清 `css2.css` 的 19 个 `@font-face` 死声明与 FA5/Inter），随后 S4 图标 → S2 色板 → S5 内联 → S7 设置页重写 → S8 断点 → S6 回归。
- 用户同时明确（2026-10-15）：**Strata 三项（引擎空闲卸载 / 显存门槛 / 加载前命令）保存时写进 `strata-*.json`、下次启动引擎生效的逻辑保持不动**，不做「保存即生效」的自动重启引擎。

### 19. 样式基座 S3：字体落地（Outfit；中文不打包，跟随上游，2026-10-15）
- 规格来源 `UI_STYLE_BASELINE.md` §5（本轮已按实际落地改写该节）。目标：拉丁用 Outfit、中文用自带子集 —— 上游 `tokens.css:6-7` 的 `unicode-range` 只覆盖 latin/latin-ext，本 GUI 全站中文，**中文必须靠后备字体**。
- **中文字体换人：MiSans → Noto Sans SC**。MiSans 许可第 2 条禁止「对 MiSans 字体或其任何单独组件进行改编或二次开发」、第 3 条禁止「进一步分发字体软件或其任何副本」，而这一步要做的正是**子集化 + 提交入库**，两条都踩；HarmonyOS Sans SC 有同类条款，同样存疑。Noto Sans SC 与思源黑体（Source Han Sans）同源，**SIL OFL 1.1** 明确允许修改 / 子集化 / 再分发（保留 OFL 文本即可），故改用 —— 这是合规判断，不是观感偏好。
- 产物（`src/styles/fonts/`，共 5 文件）：`outfit-latin-wght.woff2`（32,292 B）、`outfit-latin-ext-wght.woff2`（14,808 B）、`Outfit-OFL.txt`、`noto-sans-sc-subset.woff2`（**1,942,264 B / 1.85 MB**）、`NotoSansSC-OFL.txt`。
- 子集怎么做的（一次性、离线，**不给项目加构建步骤**）：源文件 `target\NotoSansSC-VF.ttf`（17,772,300 B，取自 Google Fonts `ofl/notosanssc/NotoSansSC[wght].ttf`）；字表 = 扫 `src/**/*.{ts,tsx,css,html,json}` + `src-tauri/src/**/*.rs` 的汉字（**1119** 个 —— 只扫 tsx 会漏掉 Rust 侧的日志与报错文案、`src/assets/params.json`、CSS `content:`）**∪ GB2312 全集 6763 字**；命令 `python -m fontTools.subset target\NotoSansSC-VF.ttf --text-file=target\hanzi-full.txt --unicodes=U+0020-007E,U+00A0-00FF,U+2100-214F,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+2600-26FF,U+3000-303F,U+FE10-FE1F,U+FF00-FFEF --flavor=woff2 --layout-features='*' --no-hinting --output-file=src\styles\fonts\noto-sans-sc-subset.woff2`（Python 3.14 + fontTools 4.67.0 + brotli 1.2.0）。保留 VF 的 wght 轴，strip hinting。参照：913 字版 353 KB、3500 常用字约 1.2 MB、全 CJK 基本区 20902 字约 3–5 MB。
- `src/styles/tokens.css`：加两条 Outfit `@font-face`（照上游，只把 url 改成 `./fonts/…`）+ 一条 `@font-face{font-family:"Noto Sans SC";src:url("./fonts/noto-sans-sc-subset.woff2") format("woff2-variations");font-weight:100 900;font-display:swap}`（**故意不写 `unicode-range`**：Outfit 自己的 range 已吃掉 latin/latin-ext，子集里也带拉丁与常用标点做兜底）；`--st-font` 栈改为 `"Outfit","Noto Sans SC",system-ui,-apple-system,"Segoe UI",Roboto,"Microsoft YaHei UI","PingFang SC",sans-serif`，`--st-font-mono` 改为 `ui-monospace,"Cascadia Mono",Consolas,"Microsoft YaHei UI",monospace`。
- 清理（§5 的「顺带清理」项全部做完）：删 `src/styles/legacy/css2.css`（19 条 `@font-face`：Orbitron / Press Start 2P / Roboto Mono，全站零引用，其中 4 条 `url` 指向不存在的文件）与随之孤立的 `src/styles/legacy/woff2/`（8 个字体文件），`src/main.tsx` 去掉该 import 并更新注释；`legacy/index.css:2668`/`:2681` 的 `'Font Awesome 5 Free'` → `"Font Awesome 6 Free"`（仓库里只有 FA6 字体，码位 `\f06a`/`\f00c` 在 FA6 同值 —— **不能只删 font-family，否则那两个 `::before` 会变豆腐块**）；`legacy/index.css:192` 的 `'Inter'` → `var(--st-font)`（库内无 Inter 字体，Windows 上一直是回落）；**18 处 font-family 收口**（`legacy/index.css` 11 处 + `app.css` 7 处）到 `var(--st-font)` / `var(--st-font-mono)`，`font-family:inherit` 的 3 处保留。`src/styles/css/all.min.css`（FontAwesome 6）留给 **S4 图标迁移**一并退役。
- 验证（代码侧）：`npx tsc --noEmit` exit 0；`index.html` 无任何字体引用；全站 `font-family` 复核后只剩 `var(--st-font)` / `var(--st-font-mono)` / `inherit` / FA6 两条，外加 `tokens.css` 的三条 `@font-face`。
- 观感变化属预期：中文由系统「Microsoft YaHei UI」变为 Noto Sans SC，拉丁/数字由默认无衬线变为 Outfit。
- 构建与部署：`npm run tauri build` exit 0（日志 `target\build36.log`）；Vite 产物里已见 `noto-sans-sc-subset-*.woff2`（1,942.26 kB）与两个 Outfit woff2，CSS 产物 204.67 kB（gzip 41.40 kB），Rust release 1m 55s；exe **11,721,216 B** / 2026-10-15 21:50:10（SHA256 前 16 `B41A7ED856DA1D7D`）已部署，备份 `llamacpp-gui.exe.bak-before-s3fonts`（上一版 9,898,496 B / `6E0F0B5C66EA7091`）。
- **同日改回：跟随上游，不打包中文（用户定稿「跟着上游改」）**。上游 strata-manager `apps/desktop/src/official/tokens.css` 只带 Outfit 两条 `@font-face`、`--st-font` 里没有任何中文字体名，中文一贯交给系统（Windows = Microsoft YaHei UI / macOS = PingFang SC / Linux = 发行版默认）——上面那套 Noto 子集因此整套撤掉：
  - 删 `src/styles/fonts/noto-sans-sc-subset.woff2`（1,942,264 B）与 `NotoSansSC-OFL.txt`；`src/styles/fonts/` 只剩 `outfit-latin-wght.woff2`（32,292 B）、`outfit-latin-ext-wght.woff2`（14,808 B）、`Outfit-OFL.txt`。
  - `src/styles/tokens.css`：删掉那条 Noto `@font-face` 与其注释（**改注释时小心别让 `*/` 提前闭合**，第一次就踩了这个坑，已修）；`--st-font` → `"Outfit",system-ui,-apple-system,"Segoe UI",Roboto,"Microsoft YaHei UI","PingFang SC",sans-serif`（比上游多末尾两个**显式**中文字体名，不依赖 WebView2 的隐式回落）；`--st-font-mono` 未动（它本来就没有 Noto）。
  - `target\NotoSansSC-VF.ttf`（17,772,300 B）留在 `target\` 下没删 —— 不进包体，将来若重新打包中文可直接复用，子集化命令见上一条。
  - 验证：`npx tsc --noEmit` exit 0；`Noto|noto-sans` 在 `src/**` 与 `index.html` 里 0 命中；Vite 产物里已无 `noto-sans-sc-subset-*.woff2`（只剩两个 Outfit + 三条 FA6）。
  - 构建与部署：`npm run tauri build` exit 0（日志 `target\build37.log`）；CSS 产物 204.51 kB（gzip 41.35 kB），JS 456.78 kB；Rust release 2m 14s；exe **9,778,688 B** / 2026-10-15 22:00:30（SHA256 前 16 `43168190CCB08195`）已部署，备份 `llamacpp-gui.exe.bak-before-upstreamfont`（上一版 11,721,216 B / `B41A7ED856DA1D7D`）—— 比带字体的那版小 **1,942,528 B**，与删掉的子集体积吻合。
  - 代价（要认）：字形随机器/系统走。上游 `official/tokens.css` 源自 Gainsty 设计系统，本就是拉丁-only，系统 CJK 是有意为之，不是遗漏。
  - **再修：把显式中文字体名也去掉（用户 m07070「中文字体还没原来好看」）**。根因：S1 之前的 body 栈 `'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif` **没有任何中文字体名**，中文由 WebView2 默认回落；而 S3 我显式写了 `"Microsoft YaHei UI"` —— 那是 Windows 的 **UI 变体**（字距更紧、笔画更细、小字号更糊），中文观感因此变差。现 `--st-font` 就是上游原文 `"Outfit",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif`，`--st-font-mono` 也去掉 `"Microsoft YaHei UI"` → **中文回落条件与 S1 之前逐字相同**。教训已写进 `src/styles/tokens.css` 头部注释：要动中文字体先问用户。exe 9,778,688 B / 2026-10-15 22:08:49（SHA256 前 16 `089114DBE5AA7B61`）已部署，备份 `llamacpp-gui.exe.bak-before-sysfont`（上一版同大小 / `43168190CCB08195`），构建日志 `target\build38.log`。
  - **再修：真凶是 `system-ui`（用户 m07107 第二次反馈「还是不一样」后定位）**。上一次只去掉了中文字体名，`system-ui` 还留在栈里，观感自然没变。Windows 上 `system-ui` 解析成 Segoe UI，中文由它转交给 **YaHei 的 UI 变体**，与 S1 之前的默认回落不是同一张字形。取证方式：headless Edge（与 WebView2 同为 Blink 内核）在 canvas 上逐像素对拍，拿 S1 之前的旧栈当基准 —— 含 `system-ui` 的栈中文 16px 差 **3572** 像素、32px 差 **11221**；把 `system-ui` 换成 `BlinkMacSystemFont` 后差 **0 / 0**；同时 `pre-s1 ≡ Segoe UI`（0 / 0），证明旧栈里的 `'Inter'` 在本机也一直解析成 Segoe UI。**关键教训：中文全角字形恒为 1em，量宽度测不出字体差异** —— 9 种候选栈的 `measureText`、DOM 宽度、`fonts.check` 结果**全部一模一样**，全部无用，只能比像素。现栈 = `"Outfit",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif`（除 `'Inter'`→`"Outfit"` 外与 S1 之前逐字相同，比上游原文少了 `system-ui`）；`--st-font-mono` 未动（S1 之前的 `.mono` 本来就以 `ui-monospace` 开头，非回归）。exe 9,778,688 B / 2026-10-15 22:34:47（`DB88BE2FB12078CD`）已部署，备份 `llamacpp-gui.exe.bak-before-nosystemui`（上一版同大小 / `089114DBE5AA7B61`），构建日志 `target\build39.log`。用户 m07201 确认「中文可以了」，此项闭环。
### 20. 样式基座 S4：图标迁移（FontAwesome → 自建 sprite，2026-10-15）—— **已整体回退，见 §21**

- 规格 `UI_STYLE_BASELINE.md` §6。自建 sprite `src/styles/icons/sprite.svg`（83 行 / 36,255 B / **81 个 symbol**）：前 32 个**原样**取自上游 `E:\AI\Strata\serve\web\sprite.svg`（只剥离其中约 22 KB 的 C2PA `<metadata>`，28,577 B → 20,803 B），其余 49 个（含 `i-star-filled`）用 **lucide（ISC）** 补缺 —— 源码包 `lucide-static@1.57.0`（解包在 `E:\tmp\lucide\package\icons`，2,154 个 svg），生成脚本 `E:\tmp\gen_sprite.py`。lucide 的 `stroke-width="2"` 统一改写成 **1.5**，与上游描边风格一致；lucide 补的图标一律不加 `opacity="0.12"` 的填充底（上游 32 个里描边 69 / 填充 60，混着）。
- 为什么 `i-star-filled` 要单独做一个 symbol：FA 用 `fas`/`far` 区分实心与空心，而 `<symbol fill="none">` 是**表现属性**（压过 CSS 的 `fill`），且 CSS 选择器进不了 `<use>` 的影子树 —— 只能多一个 symbol（lucide `star` 的 path 加 `fill="currentColor"`），用 `<Icon name={fav ? "star-filled" : "star"} />` 表达。
- 组件 `src/components/icons.tsx`（161 行）：`<Icon name size spin className style onClick {...data-*} />`，`IconName` 是这 81 个名字的联合类型。
  - sprite 用 `?raw` 内联进 bundle，**不做外部文件引用**（跨文档 `<use href="file.svg#id">` 各内核放行策略不一致，同文档 `#id` 引用才可靠）；注入点在**模块顶层** `ensureSprite()` → `document.documentElement`（放 `useEffect` 会晚一帧，首屏图标会缺），幂等 + `typeof document === "undefined"` 守卫。
  - 尺寸默认 20px，`size="sm"` 16px、`size="lg"` 24px —— **比上游多覆盖 height**：上游 `components.css` 的 `.st-icon--sm/--lg` 只写 width，会留下 20px 的 height 把图标拉变形。`spin` 走 `app.css` 的 `.st-icon--spin` + `@keyframes st-icon-spin`，取代 FA 的 `fa-spin`。
  - `style` / `onClick` / `data-*` 是**过渡用** prop（从 `<i>` 搬过来的既有内联样式、「?」说明触发器、冒烟测试定位），新代码不要传 —— 尺寸 / 颜色 / 间距一律走 class（铁律 8）。
- 迁移量：**实测 107 处**（`grep -E 'fa-' src/**/*.tsx` 口径），不是立项时估的 152 处。分两批：72 处纯字面量 `<i className="fas fa-x" />` 由 `E:\tmp\fa_replace.py` 机械替换（dry-run 与 apply 均为 `replace=72 skip=0`，零误伤）；其余 35 处动态 / 数据表 / 多行由 `E:\tmp\fa_manual.py`（33 处）+ 手工（`Sheet.tsx` 的 `iconClass` 类型与 import、`ModelListPanel.tsx` 的 `IconName` import）收尾。
- 三个坑（都踩过，别再踩）：
  1. **脚本 dry-run 计数被换行符污染**：初版按 `src.split('\r\n')` 切行，而仓库文件是 **LF** → 整份文件成为 1 个元素，每个被改文件只计 1 行，总数假报 23。按文件探测 EOL 后再切分才是真实的 72。
  2. **`statusOf` 的 `icon` 字段被 widening 成 `string`**：`const status = pendingVisible ? { icon: "spinner", … } : statusOf(model)` 里的对象字面量没有上下文类型 → 必须给 `status` 显式标注 `StatusBadge`（`{ cls: string; icon: IconName; text: string; spin?: boolean }`）才过。
  3. **拼接出来的图标名**：`fa-chevron-${open ? "up" : "down"}` 这类模板拼接名，sprite 必须备齐 `chevron-down/up/left/right` 四个 symbol，迁移后要写成完整的 `name` —— `<use>` 指向不存在的 id 时浏览器**静默不显示、不报错**，极难查。
- 退役（一并做完）：删 `src/styles/css/`（`all.min.css` 102,025 B，Font Awesome 6.4.0）与 `src/styles/webfonts/`（4 个字体文件共 353,556 B）；`src/main.tsx` 去掉 `all.min.css` 的 import 并改注释；`legacy/index.css` 删掉 `.update-status-badge.update-available::before` 与 `.update-up-to-date::before` 两条用 FA 字体渲染的 `content: '\f06a'` / `'\f00c'`（全站无 JSX 引用的遗产），以及那条「无视 `prefers-reduced-motion` 强制 `fa-spin`」的 `@media`；`app.css` 新增 `.st-icon` / `--sm` / `--lg` / `--spin` + `@keyframes`、`.dropdown-item .st-icon`（原 `.dropdown-item i` 的 14px 槽）、`.dropdown-check`（固定 14px 槽，勾出现/消失时行不抖动，内含 13px 图标 —— `Icon` 默认 20px 会撑破这个槽）、`.sort-chevron`（取代原来那处内联 `style`）。
- 验收：`grep -E 'fa-[a-z]|"fas|"far' src/**` → **0 命中**；图标尺寸只剩 16 / 20 / 24 三档；`npx tsc --noEmit` exit 0。
- 构建与部署：`npm run tauri build` exit 0（首建 `target\build40.log`，注释收尾后重建 `target\build41.log`）；**Vite CSS 产物 206.53 kB → 106.45 kB（gzip 18.72 kB）**，JS 456.78 → 492.31 kB（sprite 内联进了 JS，两下相抵净省约 60 kB）；exe **9,451,520 B / 2026-10-15 23:12:37（SHA256 前 16 `6499679F4DE70D51`）** 已部署，备份 `llamacpp-gui.exe.bak-before-s4icons`（上一版 9,778,688 B / `DB88BE2FB12078CD`）。
- 下一步：**S2 色板 → S5 内联 → S7 设置页重写 → S8 断点 → S6 回归**。

---

### 21. S4 图标迁移整体回退（FontAwesome 回来，2026-10-15）

- 触发：用户 m07970「图标还有换回原来的」→ 澄清后确认是「**新图标不好看**」，要求换回 FontAwesome。S4 那套自建 sprite / lucide 描边图标观感不如 FA 实心图标，属**审美否决**，不是缺陷。**不要再提第二遍自建 sprite 方案。**
- 已部署 exe 先回退：把 `E:\AI\llama.cpp-gui\llamacpp-gui.exe` 换回 S4 之前的 FA 版（**9,778,688 B / 2026-10-15 22:34:47 / SHA256 前 16 `DB88BE2FB12078CD`**），S4 产物留档 `llamacpp-gui.exe.bak-before-farevert`（9,451,520 B / `6499679F4DE70D51`）。回退脚本等 GUI 进程退出后替换（`Get-Process llamacpp-gui` 轮询 240×5s）。
- 源码回退（120 处行级替换，脚本 `E:\tmp\fa_revert.py`，10 个文件 `ops=applied` 全匹配，dry-run → `--apply` 两步走）：
  - `<Icon name="x" />` → `<i className="fas fa-x" />`；动态条件一律还原成 HEAD 的**原形**，而不是套一层三元渲染两个元素：
    - `className={"fas " + (svRunning ? "fa-spinner fa-spin" : "fa-play")}`（`BenchPanel.tsx` / `ModelSheets.tsx`）
    - 模板串 `` className={`fas ${cond ? "fa-stop" : "fa-play"}`} ``（`App.tsx` / `SettingsPanel.tsx` / `StrataPanel.tsx` / `ModelSheets.tsx`）
    - 星标极性**两处相反，别抄错**：`ModelListPanel.tsx` = `` className={`${model.favourite ? "fas" : "far"} fa-star`} ``、`StrataPanel.tsx` = `className={isFavourite ? "fas fa-star" : "far fa-star"}`
    - `fa-sync-alt ${busy ? "fa-spin" : ""}`（`ModelListPanel.tsx`）、`fas fa-chevron-${open ? "up" : "down"}`（两处）、`fas ${grid ? "fa-list" : "fa-th-large"}`、`<i className={sortKey === key ? "fas fa-check" : ""} /> `（`.dropdown-check` 槽位 span 一并去掉，占位改由 `.dropdown-item i` 的 `width:14px` 承担）
  - 类型回退：`ModelListPanel.tsx` 的 `StatusBadge` 由 `{ cls; icon: IconName; text; spin? }` 回到 `{ cls: string; icon: string; text: string }`（`icon: "fa-spinner fa-spin"` 直接带旋转类）；`pendingVisible` 分支的对象字面量同样改回；`Sheet.tsx` 的 `iconClass?: IconName` → `iconClass?: string`（值改回 FA 类名，`ParamForm.tsx` 的 `iconClass="help"/"code"` → `"fa-circle-question"/"fa-code"`）；`App.tsx` 的 `TABS` 由 `icon: IconName` 回到 `icon: string`，值 `"fas fa-cubes"/"fas fa-gauge-high"/"fas fa-microchip"/"fas fa-terminal"/"fas fa-cog"`（**注意当前 TABS 只有 5 项，HEAD 是 6 项含 strata —— 保留现状，别照抄 HEAD**）。
  - CSS：`app.css` 的 `.dropdown-item .st-icon` → `.dropdown-item i { width:14px; color:var(--text-secondary); text-align:center }`；删 `.dropdown-check` 与其 `.st-icon` 两条；`.sort-chevron` 补 `font-size:0.7rem`（FA 图标尺寸由 **font-size** 决定，不是 svg 的 width/height —— 少这一条箭头会大到撑行）；删 `.st-icon` / `--sm` / `--lg` / `--spin` + `@keyframes st-icon-spin`（换成一段说明注释）。
  - `legacy/index.css`：恢复 `.update-status-badge.update-available::before`（`content:'\f06a'`）与 `.update-up-to-date::before`（`'\f00c'`，`font-family:"Font Awesome 6 Free"`），以及那条「无视 `prefers-reduced-motion` 强制 `fa-spin`」的 `@media`。
  - 文件：`git checkout HEAD -- src/styles/css src/styles/webfonts`（FA6 CSS + 4 个字体文件）；`src/main.tsx` 在 `tokens.css` 之后、`legacy/index.css` 之前恢复 `import "./styles/css/all.min.css";`；删 `src/components/icons.tsx`（161 行）与 `src/styles/icons/sprite.svg`（36,255 B）及空目录 `src/styles/icons/`。
- 验收：`npx tsc --noEmit` exit 0；残留扫描 `<Icon|IconName|components/icons|sprite.svg|st-icon` 只剩无关的 `.toast-icon` 与 `tokens.css` 里同名的颜色 token `--st-icon`；各文件 `fa-[a-z]` 命中 App 9 / BenchPanel 10 / LogPanel 2 / ModelListPanel 26 / ModelSheets 7 / ParamForm 8 / RuntimePanel 9 / SettingsPanel 13 / Sheet 2 / StrataPanel 20。
- 构建与部署：`npm run tauri build` exit 0（日志 `target\build42.log`），Vite CSS 产物 **106.45 kB → 204.51 kB（gzip 41.35 kB）**（FA6 样式表回来）、JS 492.31 → 456.79 kB；exe **9,778,688 B / 2026-10-16 08:39:16（SHA256 前 16 `508C646BCB3D08C2`）** 已部署，备份 `llamacpp-gui.exe.bak-before-farevert-src`。
- 下一步：**S2 色板 → S5 内联 → S7 设置页重写 → S8 断点 → S6 回归**（原样，S4 不再重做）。

### 22. 样式基座 S2：色板全站化（2026-10-16，用户 m08149「下一步」）

- 触发：按 §21 末尾路线图开工 S2。范围＝把全站硬编码色收敛到 `--st-*`，**验收口径「CSS 内 hex 只剩 `tokens.css`」**；全程不动布局（`#root` 的 flex、`--sidebar-w:232px` / `--hub-header-h:54px`、296 处 `#id` 骨架全保留）。
- **第一刀：删 `legacy/index.css` 顶部的 `:root`（原 1–26 行）与 `[data-theme="dark"]`（原 28–51 行）两份变量定义块**（替换为中文说明注释）。`legacy/index.css` 在 `tokens.css` **之后**加载，旧定义一直覆盖新色板 —— 删掉后 `tokens.css` 的兼容别名层接管 705 处存量 `var(--xxx)`，**这一步就是观感跃迁本身**。缺的 6 个名字已在别名层补齐：`--primary-hover` / `--bg-secondary`（原来**根本没定义过**，只靠 `var(…, fallback)` 活着）/ `--sidebar-footer-bg` / `--topbar-bg` / `--disabled-bg` / `--modal-content-bg`。
- **第二刀：hex 清零**（脚本 `E:\tmp\s2_hex.py`，dry-run 默认、`--apply` 才写）：行级 + 按 `;` 拆「声明段」，`color:` 走 TEXT 表、其余属性（`background*` / `border*` / `box-shadow` / `outline` / `fill` / `stroke`）走 BG 表；逐文件探测 EOL 原样保留；注释用状态机跳过。结果 **229 处替换**（`index.css` 178 行 / `app.css` 34 行），**未映射 0**，复跑 **0 处**（幂等）。`app.css` 的 `--primary-soft`（`#ececf1` / `#262b36`）两条定义手工删除，交给别名层 → `--st-line-soft`（观感一致，只留一处真源）。
- **第三刀：语义色半透明底归一**（脚本 `E:\tmp\s2_rgba.py`）：色板里没有紫色，散落的 indigo/violet/绿/红/黄 `rgba()` 一律改写为 `rgb(var(--st-*-rgb) / α)`（**α 原样保留**，色相交给主题），**57 行改动、复跑 0（幂等）**。同一脚本顺带把 3 处 `color: white`（`index.css:643` `.btn-icon.primary`、`:1499` `.btn-primary`、`:1506` `.btn-danger`）→ `var(--st-accent-ink)`，`index.css:3386` 的 `rgba(255,244,204,0.45)` → `var(--st-warn-tint)`。
- **`tokens.css` 新增派生 token（均带 `(derived)` 注释，浅 / 深两套）**：`--st-topbar` `rgba(255,255,255,.9)` / `rgba(22,26,29,.9)`；`--st-focus-ring` `rgba(64,93,230,.25)` / `rgba(123,147,255,.25)`；通道 token `--st-accent-rgb` `16 185 129` / `52 211 153`、`--st-info-rgb` `15 151 255` / `58 169 255`、`--st-warn-rgb` `227 155 11` / `245 181 61`、`--st-danger-rgb` `224 40 63` / `255 90 110`。语法 `rgb(R G B / α)` 属 CSS Color 4，Chromium 65+ 支持，WebView2 远高于此。
- **结果审计**（脚本 `E:\tmp\rgba_after.py`，剥离注释后统计）：`legacy/index.css` 代码区 **hex 0 处 / `color:white` 0 处 / 彩色 rgba 0 处**；剩 rgba 68 处**全是灰阶**（`0,0,0`×49、`255,255,255`×15、`15,23,42`×2、`148,163,184`×1、`17,17,17`×1）。`app.css` 同样 hex 0 / white 0 / 彩色 0，剩 rgba 7 处（`255,255,255`×4、`0,0,0`、`15,23,42`、`128,128,128` 各 1）。**灰阶一律不动** —— 它们是有意的阴影/遮罩/深色提亮玻璃，换成主题色会破坏阴影的自然感。
- **决策与坑（下次照做）**：
  1. **同文件连续 `edit` 必须一次发一个**（第二次可能报 file changed）；`tokens.css` 的浅色行与深色行因此分两次提交。
  2. **替换脚本计数别用 `re.subn` 的返回值**：命中正则但 `repl` 返回原串（三元组不在映射表）也算一次「替换」，会把灰阶行算进改动行数 → 改成「替换前后文本是否相同」判断。
  3. **多行注释要状态机**：注释中间行既无 `/*` 也无 `*/`，不跟踪状态就会被当代码处理（首轮 dry-run 报的 5 个未映射里有 4 个是注释正文里的 hex）。
  4. **白字与白底必须两张表**：`color: #ffffff` / `white` → `--st-accent-ink`（17 处逐条核过，全在实心按钮/深底上）；背景与边框的 `#ffffff` → `--st-surface`。`#000000` / `#111111` 在底/边位置 → `--st-accent`，但**选择器含 `:hover` / `:active` 时要走 `--st-accent-hover`**，否则 hover 从绿到绿、没有反馈。滑块圆点（3 处）也用 `--st-surface`：深色下变深点仍看得见，而 `--st-accent-ink` 深色值是墨绿、压在绿轨道上几乎不可见。
  5. **不用 `color-mix()`**（WebView2 版本不确定，失败会让顶栏变透明）→ 加显式 `--st-topbar`。
  6. `.model-clone`（克隆徽标）原紫底归一 accent 系 —— 它的 `border-left` 本来就已是 `--st-accent`，紫底配绿边本就不协调。
  7. `border-color` 也要按 **BG 表**走（属性名不等于 `color`）。
- 构建与部署：`npx tsc --noEmit` exit 0 → `npm run tauri build` exit 0（日志 `target\build43.log`，Vite `built in 900ms`），dist CSS `index-BxsW3_6N.css` **207,442 B**；exe **9,778,176 B / 2026-10-16 08:54:55 / SHA256 前 16 `6946717DFD1B903C`** 已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`，备份 `llamacpp-gui.exe.bak-before-s2rgba`（上一版 9,778,688 B / `508C646BCB3D08C2`）。
- 验收现状：机器侧全部达标（hex 只剩 `tokens.css`，代码区 0）；**观感需用户明暗双主题逐页复验** —— 浅色主题的 `--primary-color` / `--success-color` / `--info-color` / `--danger-color` 从近黑（`#000000` / `#111111` / `#111111` / `#1f1f1f`）换成绿/蓝/红，是本轮最大跃迁，按钮、徽标、链接、状态点全受影响。
- 遗留（**属于后续步骤，别在 S2 里顺手做**）：`font-size` 235 处 12 个离散值归一到 `--st-fs-*`（S5 之后）、130 处内联 `style={{}}`（S5）、28 处 `@media` 断点统一（S8）、`legacy/index.css:3074` 那个 `@media (max-width: 768px)` 空块（S8 一并删）。
- 下一步：**S5 内联 → S7 设置页重写 → S8 断点 → S6 回归**。

### 23. 三个遗留问题一起修：dspark 草稿 / 启用不再要求「同步」/ 辅助文件自动检测（2026-10-16，用户 m08378）

触发：用户 m08378 在「模型列表 - llama.cpp 引擎」下报三点。三条都已落地。

**1）`dspark` 是外置草稿模型，不该出现在模型列表里**
- `src-tauri/src/models.rs:130` 新增 `const DRAFT_MARKERS: &[&str] = &["draft", "dspark"];`，`is_draft_name` 改成 `DRAFT_MARKERS.iter().any(|marker| lower.contains(marker))`。**`dspark` 里没有 `draft` 三个字母**，只能并列，不能靠子串覆盖。
- 依据：`src/assets/params.json` 的 `spec-type` 选项里有 `draft-dspark`；`*-dspark.gguf` 之前被当主模型列出来，点进去只会加载失败 —— 与 mmproj 同一类问题。
- 归类自动跟上：`scan_aux_files` 走同一个 `is_draft_name`，所以它同时会进参数表「选择草稿模型」的候选。
- 测试：`models.rs` 的 `mmproj_and_draft_name_detection` 增两条断言（`Qwen3-4B-dspark-Q8_0.gguf`、`QWEN3-4B-DSPARK.gguf`），MTP 的否定断言（`Ornith-1.5-9B-MTP-Q6_K.gguf` 不是草稿）保留。
- 未变：目录里**只有**草稿文件时仍按普通模型列出（`has_main=false`），免得把独立小模型藏起来。

**2）新模型直接启用，不再要求先点「同步」**
- 用户原话：「新增加的模型无法启用，还要求同步，这个是被替换的 router 要求的功能，应该修改」。router 时代是「扫描 → 点同步写配置 → 才能启动」，配置层 JSON 化（第三刀）之后补一份最小配置只是一次写盘。
- `src-tauri/src/scheduler.rs`：`ensure_ready` 开头由 `load_item(state, id)?` 换成 `ensure_config_for(state, id)?`；新增 `ensure_config_for`（缺配置 → 用 `state.cached_scan` / `models::scan_models` 找 `same_id` → `preset_lock()` 内 `model_config::ensure_config`，日志「模型 X 还没有配置文件，已自动补一份（含端口分配）」）与 `assign_port`（配置在但 `port` 为空 → `allocate_port` + `write`）。
- **配置名用请求名**：前端 `section = alias || 扫描 id`（`src/utils/models.ts`），而 `load_item` / `same_id` 比的是文件名 id；若按扫描 id 落地，别名请求会永远失配、反复走「补配置」。
- **别名反查 + 复用历史配置**：`settings.aliases`（键 = 扫描 id，值 = 界面名）反查；老 `config_sync` 用的是 `&model.id`，所以历史配置可能以扫描 id 命名 —— 命中就直接用那一份并补端口，否则同一个 gguf 会多出第二份配置、白占一个端口。
- `src-tauri/src/lib.rs:902` 的 `LLAMACPP_PORT_BASE` 改 `pub(crate)`（scheduler 要用）。
- 前门 `src-tauri/src/strata_proxy.rs` 的 `/models/load`：`find_llama_model` 失败时回退 `scheduler::ensure_config_for(state, &name).ok()`。**只对 `/load`，`/unload` 不回退**（不该为了卸载去建配置）。
- 前端：`src/components/ModelListPanel.tsx` 去掉 `!active && !model.inPreset` 禁用、去掉「未同步」徽标（含 `hasBadges` 里的那一项）与「请先在「配置」里保存」的 title；`src/components/BenchPanel.tsx` 删掉 `!selected.inPreset` 门槛（压测本来就打前门，前门会自补配置）；`src/components/ModelSheets.tsx`（启动按钮 title）与 `src/components/SettingsPanel.tsx`（模型根目录标签）里的 presets.ini 措辞改成「配置文件」。
- 保留：`inPreset` 字段没删，列表内部仍在用；`src/utils/models.ts` 的 `missing` 分支是条没有 UI 入口的死路，这次没动。

**3）「多模态投影文件 / 草稿模型路径」留空 = 自动检测同目录文件**
- `src-tauri/src/scheduler.rs` 新增 `enum AuxKind { Mmproj, Draft }`、`auto_aux(cfg) -> (ModelConfig, Vec<String>)`、`has_arg`、`needs_external_draft`、`pick_aux_gguf`；`spawn_model` 在 `build_model_args` **之前**调用，补出来的参数**只作用于本次启动，不写回配置文件**（写盘属于用户保存参数表）。
- mmproj：`cfg.mmproj` 为空且 args 里没有 `--no-mmproj` 时，补主模型同目录里**最大**的 mmproj（与 `models.rs::build_models` 的选择策略一致）。llama.cpp 自己也会找同目录投影文件，结果一致。
- 草稿：仅当 `--spec-type` 是**外部**草稿类型（非空、非 `none`、非 `draft-mtp`）且 args 里没写 `--spec-draft-model` / `--model-draft` 时，补同目录最大的草稿文件。`draft-mtp` 的草稿头在主模型内，不需要外部文件，所以排除；草稿找不到时日志写「开了投机解码但同目录没有草稿模型文件，也没手动指定 —— 本次按没有草稿模型启动」。
- `needs_external_draft` 取**最后一个** `--spec-type`（重复参数 llama.cpp 取后者），同时认 `--flag value` 与 `--flag=value` 两种写法。
- 已知限制：只按文件名认（`is_mmproj_name` / `is_draft_name`）。「拿另一个小模型当草稿」这种用法名字上看不出来，仍必须在参数表里显式选。
- 文案：`src/assets/params.json` 的 `spec-draft-model` 描述补一句「其它草稿类型留空则由 GUI 自动检测主模型同目录下的草稿模型文件（文件名含 draft / dspark）」；`src/components/ParamForm.tsx` 的输入框 placeholder 本来就是「留空 = 自动检测同目录文件」，前后端语义自此一致。

- 门禁与部署：`npx tsc --noEmit` exit 0；`cargo test --lib` **90 passed / 0 failed / 6 ignored**；`npm run tauri build` exit 0（日志 `target\build44.log`，Vite `built in 936ms`；exe **9,792,000 B / 2026-10-16 10:48:14 / SHA256 前 16 `DDDF368EA70B8971`** 已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`，备份 `llamacpp-gui.exe.bak-before-auxauto`（上一版 9,778,176 B / `6946717DFD1B903C`）。
- 顺手修掉：`src-tauri/src/models.rs` 里上一轮编辑留下的行内接排（`fn …() {        assert!(…)` 同一行）与 7 个连续空行。
- 下一步：仍按样式路线图 **S5 内联 → S7 设置页重写 → S8 断点 → S6 回归**。

### 24. 前门端点白名单漏洞：点「开始聊天」把 40 GB 的 Strata 拉起来 / 显存互斥下沉到前门（2026-10-16，用户 m08817）

- 现象（用户 m08817）：互斥开着，先在「模型列表-llama.cpp」启一个模型，再点侧栏「开始聊天」—— Strata 的模型被自动加载，而 llama.cpp 那个模型不卸载。
- 根因（日志实证）：llama.cpp 自带的 WebUI 每次打开都会要 `GET /tools`（MCP 工具列表）与 `GET /build.json`（构建信息）。前门那两个名单都不收它们 ——
  `is_webui_asset` 只认静态资源（`/`、`/index.html`、`/_app/`、`/favicon*`、`/apple-*` 与各类扩展名；**名单里没有 `.json`**），
  `is_passive_probe` 只认 `/props` `/slots` `/metrics` `/v1/health`。于是这两个路径落进 §6 的 `resolve_target(state, None)`
  → 默认通道 = `strata_selected_config`（`strata-swift-iq3_xxs.json`）→ 前门 `ensure` 起引擎、lazy 加载 39.97 GiB。
  - `E:\AI\llama.cpp-gui\logs\gui-20261016-105048.log`：`10:56:09.222 GET /tools`（ThreadId 212）→ `Serving 广播 proxy_serving=Some("strata-swift-iq3_xxs.json")` → `10:56:10.225 [proxy] ensure ④起新引擎 strata-swift-iq3_xxs.json` → `10:56:14 loading the model ...`。紧随的 `/build.json`（ThreadId 213）同样命中；`/props`（ThreadId 214）因为属于被动探测才回的空壳。
  - 互斥为什么没生效：互斥原先只写在 GUI 前端（`store.startModel` 正向、`unloadRouterLoaded` 反向），**前门自己发起的加载根本不经过前端**。
  - 对照（前门正常时）：同一份日志 `10:54:52` / `11:41:41` / `11:46:08` 都有 `→ 无点名，WebUI 重定向到已就绪实例 :8224 / :8214`，那时没有 Strata 参与 —— 问题只出在「有就绪实例、但请求没被认出来」这条缝上。
- 改动（`src-tauri/src/strata_proxy.rs`，3 处）：
  1. 新增 `fn is_llama_endpoint(path: &str) -> bool`，名单 `/tools` `/build.json` `/cors-proxy`（注释：llama.cpp 实例自带、但**不是** WebUI 静态资源的端点）。没有把端点塞进 `is_webui_asset` —— 语义不对，那些不是资源。
  2. 在 §4（静态资源）与 §5（被动探测）之间加分支：`wanted.is_none() && is_llama_endpoint(&path)` 时，有就绪实例就 `serve_llama` 转发（日志 `→ {path} 交给已就绪的 llama.cpp 实例`），没有就回空壳（`/tools` → `[]`，其余 → `{}`），**绝不起 Strata**。
  3. 在 §6 `resolve_target` 之前加互斥：`state.settings.get().strata_router_mutex` 为真时，若 `scheduler::lock_sched(state).table().active_count() != 0` 则 `stop_all(&state.logs)`，日志 `→ 显存互斥：已停掉 llama.cpp 实例 [...]`。先判空再拿锁，避免每个 Strata 请求都白拿一次调度锁；`stop_all` 只停 llama.cpp 子实例（Strata 引擎不进调度表）。
  - 未采用（留档）：把「无点名的默认通道」从 Strata 改成 llama.cpp —— 改动面更大，且无点名的 `/v1/chat/completions` 本来也不合法（DSH / OpenAI SDK / 提示页链接都会点名）。
- 未查明：`/tools`、`/build.json` 的发起方（日志不带 User-Agent；可能是停在 9090 的浏览器页，也可能是 DSH）。修复与发起方无关，故未阻塞。
- 门禁与部署：`npx tsc --noEmit` exit 0；`cargo test --lib` **90 passed / 0 failed / 6 ignored**；`npm run tauri build` exit 0（日志 `target\build47.log`）。exe **9,794,560 B / 2026-10-16 12:23:08 / SHA256 前 16 `D12B276985A74017`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-llamaendpoint`（上一版 9,792,000 B / `40FAFC9B8168BF56`）。
- 同批（12:14:10 那一版 exe）：设置页三个布尔项（显存互斥 / 开机自启动 / 关闭窗口时最小化到托盘）由复选框改成开关组件 —— `src/components/SettingsPanel.tsx` 的 `className="form-check-input"` → `"switch-input"`（3 处），样式 `.switch-input` 追加在 `src/styles/app.css` 尾部；关 = 灰轨道，开 = accent 色；深色主题的圆点用 `--st-ink-soft`（用 `--st-surface` 会比轨道还暗、看不出边界）。另外勾选框/单选框的选中填充由绿色 `--primary-color` 改成中性 `--st-ink`（用户 m08706 截图反馈）。
- 待用户复验：重启后重复「启 llama.cpp 模型 → 点开始聊天」，Strata 不应再被拉起。
- 下一步：仍按样式路线图 **S5 内联 → S7 设置页重写 → S8 断点 → S6 回归**。

### 25. 样式基座 S5：清内联 `style={{}}`（2026-10-16，用户 m08917「按照规划继续下一步开发」）

- 触发：S2 色板用户看过没有问题（m08917），按路线图推进到 S5。目标见 `UI_STYLE_BASELINE.md` §8：把 JSX 里的内联尺寸/颜色/间距收进类名与 token，只留运行时动态值。
- 立项普查 130 处，实测 **103 处**（`PresetEditor.tsx` 已删，其 7 处随之消失；`SettingsPanel.tsx` 从 45 降到 39）。
- 逐文件结果（剩余 `style={{` 计数）：
  - `src/components/ModelSheets.tsx` 16 → 0
  - `src/components/StrataPanel.tsx` 6 → 1（`opacity: row.fact ? 0.66 : 1`，运行时值，规范允许保留）
  - `src/components/ParamForm.tsx` 13 → 0
  - `src/components/RuntimePanel.tsx` 12 → 1（`<span className="tag" style={{ color }}>`，颜色由 `ok/warn` 数据驱动；顺手把它的取值从 `var(--text-primary)` / `var(--warning-color)` / `var(--text-secondary)` 归到 `--st-ink` / `--st-warn-text` / `--st-ink-muted`）
  - `src/components/ModelListPanel.tsx` 6 → 0
  - `src/components/BenchPanel.tsx` 5 → 0
  - `src/App.tsx` 2 → 0、`src/components/ErrorBoundary.tsx` 2 → 0、`src/components/LogPanel.tsx` 1 → 0、`src/components/Sheet.tsx` 1 → 0
  - `src/components/SettingsPanel.tsx` 39 处**不动** —— 按 §8 由 S7 整页重写消化。
- 结论：S5 之后全站只剩 41 处（39 在 `SettingsPanel.tsx` + 2 处合法的运行时值）；「仅剩数据驱动处（≤5）」这条验收口径要等 S7 做完才成立。
- 落点：`src/styles/app.css` 尾部新增「组件样式（S5，2026-10-16）」段 —— 语义色（`.text-warn` / `.text-danger`，取 `*-text` 档）、间距与字号工具类（`.mt-*` / `.mb-*` / `.ml-2` / `.fs-xs` / `.fs-sm`），以及按用途命名的组件类（`.device-checklist` / `.device-row` / `.device-row-text` / `.btn-xs` / `.btn-compact` / `.param-grid` / `.param-grid--single` / `.param-field` / `.param-label-row` / `.param-enable-toggle` / `.param-desc-trigger` / `.json-edit-textarea` / `.arg-row` / `.arg-flag` / `.arg-value` / `.scroll-x` / `.col-select` / `.row-tight` / `.break-all` / `.notice-icon` / `.no-shrink` / `.nowrap` / `.search-box--fixed` / `.filter-select` / `.btn-icon--lg` / `.search-wrap--wide` / `.channel-tag` / `.status-line` / `.sheet-icon`）。脚本：`E:\tmp\s5_sheets.py`、`E:\tmp\s5_strata.py`、`E:\tmp\s5_param.py`、`E:\tmp\s5_runtime.py`、`E:\tmp\s5_rest.py`。
- 有意为之的观感变化（已告知用户）：警告/错误文字由 `--st-warn`（#e39b0b）/ `--st-danger`（#e0283f）改用文字档 `--st-warn-text`（#8a5a00）/ `--st-danger-text`（#b01a2e）—— 色板按 base/tint/text 分三档，浅色主题下 base 当文字用时对比度不够；另有若干 px 取整（0.78rem→12px、0.9rem→14px、15px→14px、0.72rem→12px、6px→4px、0.2rem→4px），差值 ≤2px。
- 门禁：`npx tsc --noEmit` exit 0。
- 教训：
  1. **别信 dump 的行内拼接**：早前三处 `className="…" style={{…}}` 看着在同一行，实际 `style` 各占一行（pwsh 输出把两行挤到一起了）。动脚本前用 Python `repr()` 复核真实文本，否则该 op 命中 0、整个脚本不写盘。
  2. 新建类名先 grep：`.btn-sm` 已被 legacy 的两个媒体查询占着，新的小按钮档位只好叫 `.btn-xs` / `.btn-compact`（在 `app.css` 里重定义 `.btn-sm` 会把窄屏样式一起顶掉）。
  3. 提取多行 JSX 属性要把 `<span` 到 `>` 整段一起换，只删 `style` 会留下难看的折行。

### 26. 样式基座 S7：设置页重写 + 「运行环境」并入设置页（2026-10-16，用户 m09126「继续」）

- 触发：S5 完成后按路线图推进 S7（用户 m09126「继续」）。目标见 `UI_STYLE_BASELINE.md` §8 / §10.5 / §10.7 / §10.8：设置页由「面板平铺」改成上游形态的「左侧分组导航 + 右侧卡片分组 + `<details>` 折叠 + 行式开关」，并把「运行环境」页的有用部分并进来。
- **新文件 `src/styles/components.css`（组件层，498 行）**：类名与语义照搬上游 `E:\AI\Strata\serve\web\components.css`（128 行，"the Strata UI kit"），**数值全部换成本项目 `tokens.css` 的 token**（铁律 8：只搬结构数值，禁止整文件引入）。
  - 上游的全局层**故意不搬**：`*{box-sizing:border-box}`、`html,body{…}`、`main{flex:1;min-height:0}`（本项目 `#root` 已经担任这个角色，见 `app.css:9-14`，搬进来会双重 flex）、`:focus-visible{outline:2px solid var(--st-focus)}`（会改全站焦点圈）、`[hidden]{display:none!important}`（上游用它切视图，本项目是条件渲染）、`#drawer-close .st-icon`（本项目禁止新增 `#id` 选择器，铁律 4）。
  - 引入顺序：`tokens` → `all.min` → `legacy` → **`components.css`** → `app.css`（`src/main.tsx`）。排在 legacy 之后、app.css 之前：`.st-*` 与 473 个 hub 旧类名零冲突，页面级覆盖仍最后生效。
  - 已落地的类：`.st-card`（+`__head`/`__title`/`__body`/`__foot`）、`.st-divider`、`.st-row`/`.st-col`/`.st-spacer`/`.st-grid`/`.st-sec-title`/`.st-sub`/`.st-scroll`、`.st-settings`（两栏 `196px minmax(0,1fr)`）、`.st-nav__row`（+`.is-active`）/`.st-nav__count`、`.st-collapse`（原生 `<details>`）/`.st-chev`、`.st-field`/`.st-label`/`.st-input`（+`--mono`）/`.st-hint`、`.st-switch-row`（+`__text`/`__label`/`__hint`）、`.st-btn`（+`--primary`/`--secondary`/`--danger`/`--sm`/`--icon`）、`.st-badge`（+`--ok`/`--warn`/`--err`）、`.st-table`（+`.num`）。
  - 开关本体复用 S7 之前那次改的 `.switch-input`（定义在 `app.css`），没再写第二套；`.st-switch-row .switch-input { margin: 0; }` 只把它推到右边。上游的 `.st-toggle`（button + `aria-checked`）没用。
- **`src/components/SettingsPanel.tsx` 整页重写**：三个分组 —— **服务**（运行时版本 / 前门与服务 / Strata 引擎，导航项带「N 个版本」计数）、**通用**（llama.cpp 安装目录 / 模型根目录 / Strata 安装目录）、**启动与托盘**（自动启动说明 / 开机自启动 / 关闭窗口最小化到托盘）。逻辑一行没改：`saveService()` 的 API Key 校验与落盘、`primed` ref 只填一次表单（防止 settings 对象变化冲掉未保存的编辑）、`configSetApiKey` + 逐份 `strata-*.json` 写 `indent=1`、前端地址/端口变更后自动重启前门 —— 全部原样保留。
- **「运行环境」页并入**（§10.7）：只并「运行时版本」卡（版本表 + 共享 CUDA 运行时折叠 + fit-params 列 + 「扫描版本」按钮）；**设备表与路径信息按用户定稿退役**。`src/components/RuntimePanel.tsx` 已删除；`src/App.tsx` 去掉 `runtime` tab（`type Tab` 与 `TABS`）、去掉条件渲染，tab 由 5 个减为 **4 个**（models / bench / logs / settings）。`store.ts` 的 `versions`/`devices`/`cudaReady`/`deviceError`/`paths`/`refreshVersions`/`refreshDevices` 与后端 `gpu.rs` **一行不改**（设备枚举仍被 `ModelSheets.tsx`、`ParamForm.tsx`、`BenchPanel.tsx` 消费）。
- 三处有意偏差（已在文档记明）：
  1. **版本选择仍用原生 radio**，没有按 §10.7 改成 `.st-seg` 分段控件 —— 版本名形如 `llama-b11671-bin-win-cuda-13.4-x64`，分段按钮里必然折行溢出。
  2. **侧栏左下角胶囊没改成 `.st-pill`**（§10.8 说 S2/S7 阶段升级类名）：`.router-pill` 在 S2 已经吃过 token（色值不再是 hex 硬编码），改名属于纯类名统一，收益低、要同步 CSS 与 TSX 多处，本轮收缩范围不做。
  3. **「前门随程序自动启动」保持纯说明文字**：设置里那个 `auto_start_router` 没有任何代码消费，不趁重写之机造一个开关出来。
- 顺带修掉：`.st-settings` 的左右内边距改 0 —— 真实界面里这段缩进由 `.content-scrollable` 的 `padding: 0 2rem 2rem`（`legacy/index.css:320`）提供，两层叠加会多出 32px。
- 门禁与部署：`npx tsc --noEmit` exit 0（中途报过一次 `SettingsPanel.tsx(145,54): error TS18047: 'settings' is possibly 'null'` —— 组件顶部的 `if (!settings)` 收窄进不了嵌套 async 闭包，在闭包里补一次判空即可）；`npm run tauri build` exit 0（日志 `target\build49.log`）。exe **9,794,560 B / 2026-10-16 13:28:53 / SHA256 前 16 `38B741126826FE6F`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-s7settings`（上一版 9,794,560 B / `91453EBFC0D34835`）。
- 遗留：`src/types.ts` 的 `has_router_mode` 等字段仍留着（后端简化另议）；`app.css:1758` 的「运行环境页（RuntimePanel）」注释段可以留着当历史。
- 下一步：按路线图做 **S8 断点统一** → **S6 规范固化 + 全量回归**。

### 27. 设置页改版迭代：左侧导航换成顶部标签（2026-10-16，用户 m09315）—— 标签的分法当日又被 m09462 纠正，见 §28

用户对 S7 结果的五点反馈（m09315 逐字）：「1、服务/通用 这两个个按照模型列表的llama.cpp和strata标签修改；2、说明性的文字都不要显示；3、停止前门的按钮取消；4、通用中的浏览和保存按钮，文字不要换行，且三个保存按钮都要右对齐；5、启动与托盘放在服务标签中」——逐条落地如下。

- **左导航 → 顶部标签**：三个分组（服务 / 通用 / 启动与托盘）改成两个引擎标签，标签名与模型列表的引擎标签一致（取自 `src/components/ModelListPanel.tsx` 的 `CHANNEL_LABELS`：`llama.cpp` / `Strata`），标签上**不带数量**（用户 m02992）。新类 `.st-tabs` / `.st-tab`（`src/styles/components.css`），视觉与 `.mc-channel-tabs` 同构但走 `--st-*` token；页面级定位写在 `src/styles/app.css`：`.top-bar > .st-tabs { margin: 0 auto 0 var(--st-s-3); }`（`.top-bar` 是 space-between，靠 `margin-right:auto` 把标签压到标题右侧）。深色主题只需一条覆盖 `[data-theme="dark"] .st-tab.is-active { background: var(--st-line-soft); }` —— 深色下 `--st-surface`（#161a1d）比容器 `--st-surface-2`（#1d2226）**暗**，直接用浅色那套会看不出层级。
- **分组归位**：`llama.cpp` 标签 = 运行时版本 / 前门与服务 / llama.cpp 安装目录 / 模型根目录 / 启动与托盘（第 5 点）；`Strata` 标签 = Strata 引擎 / Strata 安装目录。**「前门与服务」归 llama.cpp**：接口本身两通道共用，但「同时加载模型上限」与「空闲释放模型」只对 llama.cpp 通道有效，放一起才不会被误读成对 Strata 也管用。
- **说明性文字全删**：所有 `.st-hint` 与 `.st-switch-row__hint` 删除（含原来那一大段「前门是唯一入口 / 客户端必须自带 Key / 空闲释放的语义」等）。**保留三处非说明性文字**：两处空状态提示（「未发现版本，请先指定下面的 llama.cpp 安装目录。」「还没有添加模型目录。」）与前门状态行（`运行中 · :9090（当前引擎 :8214）`）—— 它们是状态反馈，不是解释。
- **「停止前门」按钮删除**：与 §10.8 一致 —— 前门启停的唯一手动入口是侧栏左下角胶囊，设置页不该再放一颗。随按钮删掉 `startProxy` / `stopProxy` 两个局部函数。
- **按钮不换行 + 保存按钮右对齐**：根因是窄行里 `.st-btn--sm` 的 `padding: 0 12px` 被 flex 压缩，文字被挤成两行；`.st-btn` 补 `white-space: nowrap; flex: 0 0 auto;`（`src/styles/components.css`）。保存按钮行改 `.st-row--end`（`justify-content: flex-end`）。用户说「三个保存按钮」，实际是**五处**（前门与服务 / Strata 引擎 / llama.cpp 安装目录 / 模型根目录 / Strata 安装目录），统一右对齐。
- **死类删除**：`.st-nav` / `.st-nav__row` / `.st-nav__count` / `.st-settings__body` 随左导航一起删（铁律 9 旧别名只减不增）；`.st-settings` 由两栏 grid 改成 `flex column`，窄屏媒体查询同步精简。
- **实施方式**：用 `E:\tmp\s7_tabs.py` 做**行区间替换**（每段首尾行断言、倒序应用避免行号漂移），先 dry-run 后 `--apply`；`SettingsPanel.tsx` 775 行 → 656 行。逻辑一行没改（`saveService` 的校验与落盘、`primed` ref、`configSetApiKey`、逐份 `strata-*.json` 写 `indent=1`、地址/端口变更自动重启前门，全部原样）。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build50.log`）。exe **9,793,024 B / 2026-10-16 14:00:26 / SHA256 前 16 `7A79069913E3F289`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-s7tabs`（上一版 9,794,560 B / `38B741126826FE6F`）。
- 遗留：模型列表的 `.mc-channel-tabs` 与新 `.st-tabs` 是同一种标签的两套实现，S6 阶段统一到 `.st-tabs`。

### 28. 设置页再迭代：顶部标签改回分组（服务 / 通用）+ 目录卡单行（2026-10-16，用户 m09462 / m09481）

- **用户 m09462 逐字**：「你顶上的标签咋是按引擎分类？不是应该是服务和通用两个标签吗？」—— §27 把顶部标签理解成引擎通道（`llama.cpp` / `Strata`）是错的。用户要的是**分组**标签，样式仍照模型列表那套标签；`启动与托盘`（m09315 第 5 点）落到「服务」里。
- **最终归组**：`服务` = 运行时版本 / 前门与服务 / Strata 引擎 / 启动与托盘；`通用` = llama.cpp 安装目录 / 模型根目录 / Strata 安装目录。Strata 的两张卡按内容性质拆开：引擎参数进「服务」，安装目录进「通用」。
- 代码：`type Tab = "service" | "paths"`（原 `"llamacpp" | "strata"`），默认 `service`；`aria-label="引擎"` → `"分组"`；空状态文案改为「未发现版本，请先在「通用」里指定 llama.cpp 安装目录。」。
- **用户 m09481 逐字**：「还有文件浏览按钮咋没有图标了，这个按钮和保存还有左侧的文本框应该是一行的」—— 两个安装目录卡（llama.cpp / Strata）改成**单行**：`输入框 + 浏览 + 保存`；`浏览` 补回 `fa-folder-open` 图标（保存按钮本来就有 `fa-floppy-disk`）。改前是「第一行输入框+浏览、第二行保存」，且浏览按钮 S7 重写时把图标弄丢了。
- CSS 补一条：`.st-row > .st-input { flex: 1 1 auto; min-width: 0; }` —— `.st-input` 是 `width: 100%`，放进 flex 行里会把后面的按钮挤出可视区；这条让输入框吃掉剩余宽度、按钮维持定宽。`.st-row--end` 继续服务于「只有保存按钮」的行（前门与服务 / Strata 引擎 / 模型根目录）以保持右对齐。
- **实施方式**：`E:\tmp\s7_tabs2.py` 做整块行区间**搬移**（卡片按行号切片后重排，块内容一字未改），每段首尾行断言、倒序应用避免行号漂移；先 dry-run 后 `--apply`。教训：断言字符串一律用 `.strip()` 比较 —— 手写缩进极易错（`content-scrollable` 实际 6 个空格，首次误写成 8 个，dry-run 直接中止），新行缩进也应从原行取前缀。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build51.log`）。exe **9,793,024 B / 2026-10-16 14:10:40 / SHA256 前 16 `71673F91BD191389`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-s7tabs2`。
- 下一步不变：**S8 断点统一** → **S6 规范固化 + 全量回归**。

### 29. 设置页三迭代：运行时版本移到「通用」+ 服务组卡片并排（2026-10-16，用户 m09585）

- **用户 m09585 逐字**：「运行时版本移动到通用标签，设置页服务标签下剩余的三个分组太宽了，能并排放置吗」—— 两件事：卡片的归属按「这一卡管什么」再分一次，以及卡片的**排布**从「一列到底」改成「能并排就并排」。
- **归组调整**：`服务` = 前门与服务（宽卡）/ Strata 引擎 / 启动与托盘；`通用` = 运行时版本（宽卡）/ llama.cpp 安装目录 / Strata 安装目录 / 模型根目录（宽卡）。运行时版本属于「选哪个引擎版本」，与目录同类，因此移到「通用」。
- **并排实现**：`src/styles/components.css` 新增 `.st-cards`（`display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--st-s-5)`）与 `.st-cards > .st-card--wide { grid-column: 1 / -1; }`；窄屏（≤900px）媒体查询里 `.st-cards` 降成 1 列。**为什么不复用 `.st-grid`**：`.st-grid` 是**字段**网格（间距 `--st-s-3`、两列等宽、不能跨列），卡片容器需要 `--st-s-5` 间距与跨列能力，两者语义不同。
- **实施方式**：`E:\tmp\s7_cards.py` 行区间替换 + 首尾行断言，先 dry-run 后 `--apply`；`SettingsPanel.tsx` 687 行 → 691 行（多出两个 `.st-cards` 包裹层）。
- **事故与恢复（本条必读）**：`s7_cards.py` 里写的是 `out = eol.join(new)` —— 用它探测到的 EOL 当**连接符**，而该文件探测结果是 `''`（LF 文件首行不以 `\r` 结尾），于是整份文件被拼成**一行**（29235 B / 1 行）；文件里 4 处 `//` 行注释把其后所有代码吞掉，`tsc` 报
  `src/components/SettingsPanel.tsx(2,1): error TS1005: '}' expected.`。
  恢复路径：① Python 在 4 处 `//` 注释末尾补 `\n`（注释是中文、紧随的代码是 ASCII，可安全定位）→ `E:\tmp\sp_fixed.tsx`；② Node 加载项目 `typescript`，`ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(sf)` 重排 —— `parseDiagnostics = 0`（AST 完整）、与原文去空白比较只差 printer 补的一个 `;` → `E:\tmp\sp_pretty.tsx`（151 行）；③ `E:\tmp\polish.py` 还原 JSDoc 内部换行、把 printer 的 4 空格缩进减半 → `E:\tmp\sp_final.tsx`（165 行 / 24708 B），拷回项目；④ `npx tsc --noEmit` exit 0。坏版本留档 `E:\tmp\SettingsPanel.broken.tsx`。
- **教训（硬）**：读文件用 `newline=''` 保留原始字节是对的，但**拼回时连接符只能是 `'\n'`** —— CRLF 行自带 `\r`，用探测到的 `eol` 当连接符会在 LF 文件上把全文拼成一行。dry-run 打印出来的 `EOL=''` 就是要出事的信号，别放过。另外 printer 重排会**丢注释内部换行、把 JSX 挤成长行**：`SettingsPanel.tsx` 现在是「功能等价、格式一般」的状态（162–164 行是几个超长行），后续要大改它之前建议先整理格式。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build53.log`；build52 那次即上述事故失败）。exe **9,793,536 B / 2026-10-16 14:27:46 / SHA256 前 16 `5289DC58FCA30C12`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-s7cards`。
- 下一步不变：**S8 断点统一** → **S6 规范固化 + 全量回归**。

### 30. 样式基座 S8：断点体系统一（2026-10-16，用户 m09695「继续开发」）

- **目标**（`UI_STYLE_BASELINE.md` §10.4 决策 9）：全站 `@media` 只留 `640` / `900` 两档（桌面档用 `min-width: 901px`，与 900 成互补对）。`@media` 条件不能用 `var()`，要参数化就得引 `@custom-media` + PostCSS —— 项目无预处理器、不加构建步骤，所以这两个字面值靠 §7 的规范条款约束，**不做 token 化**。
- **开工前实测（28 处 `@media`）**：`900` 档 15 处（`legacy/index.css` 12 + `app.css` 3）、`768` 档 5 处、`640` 档 2 处、`960` / `1000` / `1100` 各 1 处、`min-width: 901px` 2 处（`app.css:46` / `app.css:299`，与 `app.css:19` 的 `max-width: 900px` 配对）、`prefers-reduced-motion` 1 处（非断点，保留）。**文档立项时写「6 处散档」，实测是 8 处**（768 五处 + 960 / 1000 / 1100 各一处）；按实测处理。
- **本次改动**（只动 `E:\Code\llama.cpp-GUI\src\styles\legacy\index.css`，脚本 `E:\tmp\s8_bp.py`：8 组精确子串替换，逐组断言「命中数 == 1」，先 dry-run 后 `--apply`；文件 141873 → 141613 字节）：
  - 改判为 `900`（6 处）：`:282` `.log-filter-select` 内边距（原 768）、`:799` `#modelsList.grid-view` 单列（原 768）、`:1154` `.modal-content.model-detail` 全屏（原 768）、`:1943` `#main-hf .hf-split` 竖排（原 1100）、`:2886` `#updateResultArea` 单列（原 960）、`:3167` `.hf-panel-split` 单列（原 1000）。
  - 删除 2 处：`:3035` 的 768 空块（块内只有一条注释，注释自己写着「由文件末尾的统一移动端媒体查询实现」）、`:3755` 的 768 `.settings-field-row { grid-template-columns: 1fr; }`（与 `:3689` 的 900 档同名同值，900 档那条还带 `gap: 0.75rem`，已完全覆盖）。
- **行为变化（本轮唯一改既有页面渲染的动作，验收重点）**：
  - `768 → 900` 三处：`.log-filter-select` 内边距、`#modelsList.grid-view` 单列、模型详情弹窗全屏 —— 在 **768–900px 区间提前生效**（更早变紧凑 / 单列，一般更好）。
  - `960 / 1000 / 1100 → 900` 三处：`#updateResultArea`、`.hf-panel-split`、`#main-hf .hf-split` 在 **901–1100px 区间恢复多列 / 横排**。其中 **`#main-hf .hf-split`（HF 页左右分栏，左栏固定 `flex: 0 0 280px`）风险最高** —— 这是 2026-10-14 用户定稿的取舍：接受 901–1100 走横排，若实测拥挤再单独议（那将是对决策 9 的局部回退，要回到 §10.4 改迁移表）。
- **验收**：全站 `@media` 只剩 `900` ×23、`640` ×2、`min-width: 901px` ×2、`prefers-reduced-motion` ×1（共 27 处）；`768` / `960` / `1000` / `1100` 命中 **0**。**别用 `grep 'max-width: *[0-9]*px'` 当验收命令** —— 它会把容器属性一起算进来（`.modal-content.model-detail { max-width: 1000px }`、`.slots-modal { max-width: 1200px }` 等 9 处，那些是元素宽度不是断点）。
- **未做（本轮范围外）**：断点视觉矩阵（1440 / 1100 / 1000 / 900 / 899 / 640 / 480 × 明暗两主题 × 8 页面 + 3 弹窗）需要真机 WebView2，沙箱起不来窗口，**留给 S6 与用户一起过**；HF 页 901–1100 区间是必看项。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build54.log`）。exe **9,793,536 B / 2026-10-16 16:41:12 / SHA256 前 16 `0DFA2D645AA3C6BC`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-s8bp`（与上一版同尺寸，仅 CSS 文本变化）。
- 下一步：**S6 规范固化 + 全量回归**。

### 31. 样式基座 S6：规范固化 + 全量回归（2026-10-16，用户 m09695「继续开发」）

S8 落地后按路线图做最后一步：跑满四道门禁，并把 S7 留下的重复实现收掉。

- **门禁（四项全绿）**：
  - `npx tsc --noEmit` exit 0。
  - `cd src-tauri; cargo test --lib` → **90 passed / 0 failed / 6 ignored**。与 `UI_STYLE_BASELINE.md` §8 记的基线（93 passed / 5 ignored）有差（−3 passed / +1 ignored）：差在 `router.rs` 退役删掉的那些用例上，**不是本次回归**；基线口径按实测改为 **90 passed / 6 ignored**。
  - `npm run test:smoke` → `全部通过 ✅`（参数 schema：参数数 82 / 分组数 10 / 含取值域 17；渲染：空状态、含取值域参数已启用、表单→preset；Strata 参数表：采样往返含坏值拦截、显存预留初值 700 MiB）。
  - `npm run tauri build` exit 0（日志 `target\build55.log`）。
- **规范固化：通道标签统一到 `.st-tabs`**（§27 记的遗留项）。模型列表原来是自己一套 `.mc-channel-tabs` / `.mc-channel-tab`，与设置页的 `.st-tabs` / `.st-tab`（`components.css`）是同一种东西的两套实现：
  - `src/components/ModelListPanel.tsx:567` `mc-channel-tabs` → `st-tabs`；`:574` `mc-channel-tab` → `st-tab`（DOM 与 `role`/`aria-selected` 一字未动）。
  - `src/styles/app.css` 删掉 6 条规则（`.mc-channel-tabs`、`.mc-channel-tab`、`:hover`、`.is-active`，加两条深色覆盖），留一段说明注释；位置改由顶栏那段 `.top-bar > .st-tabs { margin: 0 auto 0 var(--st-s-3); }` 提供（模型列表的标签与设置页的标签都在 `.top-bar` 里，同一条规则管两处）。
  - 等价性逐条核过：容器 `gap` 4px / `padding` 3px / `border` `--st-line` / 圆角 10px（`--st-r-btn`）/ 底 `--st-surface-2`；标签高 28px / `padding` 0 12px / 圆角 8px（`--st-r-sm`）/ 色 `--st-ink-muted` / 字 12px（`--st-fs-xs`）/ `tabular-nums` / `nowrap`；选中块 `--st-surface` + 700 + `--st-sh-card`；深色下选中块 `--st-line-soft`。**观感不变**。
  - 验收：`grep mc-channel-tab src` 只剩注释里那句历史说明，实现零残留。
- **未做（需真机）**：断点视觉矩阵（1440 / 1100 / 1000 / 900 / 899 / 640 / 480 × 明暗两主题 × 8 页面 + 3 弹窗）—— 沙箱起不来 WebView2 窗口，**与用户一起过**；HF 页 901–1100 区间恢复横排是必看项（§30）。
- 门禁与部署：exe **9,793,024 B / 2026-10-16 16:45:19 / SHA256 前 16 `F2E7542AAD6D8FB0`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-s6tabs`（上一版 9,793,536 B / `0DFA2D645AA3C6BC`，本次少 512 B —— 删掉的 6 条 CSS 规则）。
- 下一步：S1–S8 全部走完（S4 为用户否决后整体回退）。后续大块工作按 `UI_STYLE_BASELINE.md` §9 排序 —— M1 前门可用与前端单端点化 / M2 多模型并存与容量闸 / M3 Strata 并入 9090（可与样式并行），以及 **M4 原生聊天 UI、M6 监控 UI、M7 用量统计 + BenchPanel 合并**（决策 2 硬约束：必须排在 S1–S8 之后，现已解锁）。

### 32. 系统日志页改版（2026-10-16，用户 m09910）

用户原话：「系统日志页把日志下的文字：系统（GUI 与前门） · 行 6/6 · 快照 625 B · 更新于 17:01:51 · 日志 gui-20261016-170150.log 删除，日志卡片改成白底黑字并和左侧的模型选择高度对齐；左侧的模型选择中取消全部日志，而且模型选择可以收起为日志让出空间」。

- **日志下方的状态行整条删除**：`LogPanel.tsx` 的 `status` 字符串（`activeItem.name · 行 N/M · 快照 X · 更新于 T · 日志 foo.log`）与 `<div className="log-status">` 一并去掉；只服务它的 `bytes`（快照字节数）、`activeItem`、`logName` 随之成为死变量，`fmtSize()` 也只剩它一个调用方，全部删除（`noUnusedLocals` 会直接报 TS6133）。`lastTs` 保留 —— 自动滚底 effect 要用；`logInfo` 保留 —— 「日志目录」按钮的 `title` 还要显示路径（用户 m05885：排障时要能看到日志落在哪个文件）。
- **日志卡片白底黑字 + 与左侧等高**：`src/styles/app.css` 的 `.log-view` 由 `background: var(--st-ink); color: var(--st-line)`（深底浅字）改为 `background: var(--st-surface); color: var(--st-ink)`，并补 `border: 1px solid var(--border-color)`。描边必须一起补：`.log-sources` 本来就有 `1px solid var(--border-color)`，只改底色的话两张卡看起来会差一截。等高不用写额外 CSS —— 状态行删掉后 `.log-main` 里只剩 `.log-view`，`flex: 1` 自然撑满 `.logs-wrap`，而 `.logs-wrap` 默认 `align-items: stretch`，两列本来就等高。深色主题下 `--st-surface` 是 `#161a1d`，卡片随之变深底浅字，跟主题一致。
- **取消「全部日志」**：`items` 里删掉 `{ filter: "all", name: "全部日志", fixed: true }`，第一项改为「系统（GUI 与前门）」（`fixed: true` 无条件入列，所以 `items[0]` 恒存在）。过滤项失效时的回退从硬编码 `"all"` 改成 `items[0]?.filter ?? "all"` —— 兜底字符串留着无害，`shown` 里 `active === "all"` 那条分支也随之变成死路（store 里 `logFilter` 的初值仍可能是 `"all"`，首次进页面会立刻被 effect 纠正到第一个来源）。
- **来源列表可收起**：`LogPanel.tsx` 新增 `const [srcOpen, setSrcOpen] = useState(true);`，顶栏 `.top-actions` 最前面加一个按钮（`fa-chevron-left` / `fa-list`，文案「收起」/「来源」），收起时不渲染整列 —— 改用类名 `.log-sources.is-hidden { display: none; }` 而不是条件渲染，因为 `<div className="log-sources">` 是单行、脚本好锚；收起后 200px 让给日志。窄屏（≤900px）本来就隐藏 `.log-sources`、改用 `.log-src-select` 下拉，所以收起按钮在小屏上是无害的空操作。
- **实施**：`E:\tmp\logpanel.py` —— 行级 op 模型（`del` / `set` / `ins`），每个锚点要求唯一命中（`assert` 失败即整脚本不写盘），按索引降序执行避免行号漂移，dry-run 默认、`--apply` 才写。`LogPanel.tsx` 337 行 → 335 行（删 15 行、改 3 行、插 13 行）。
- **教训（新）**：同一锚点要插多行时，必须把多行合成一个 `ins` 一次性插入 —— 分多次 `insert(idx+1, ...)` 会让顺序整体颠倒（后插的排在上面）。第一版脚本就踩了这个坑，改成 payload 列表后 `lines[idx+1:idx+1] = [...]` 才对。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build57.log`）；exe **9,793,024 B / 2026-10-16 17:15:35 / SHA256 前 16 `E26A2DC38E5B7949`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-logpage`（上一版 9,793,024 B / `1C0BB9F2D47F5C9C`，尺寸相同 —— 只改了 CSS 与几行 JSX）。
- 遗留：状态行去掉后，运行中的引擎状态（`引擎运行中 xxx · :9092 · 版本`）在日志页不再可见 —— 已告知用户，需要时再补；日志文件路径仍可从「日志目录」按钮的悬停提示看到。
- 下一步：仍按 §31 —— M1 前门可用与前端单端点化 / M2 多模型并存与容量闸 / M3 Strata 并入 9090，以及 M4 / M6 / M7。

### 33. 深色主题下选中的标签用绿色文字（2026-10-16，用户 m10489）

用户原话：「深色主题，模型列表和设置页 选择的标签用绿色文字」。

- **改一处即两处**：S6（§31）已把模型列表的通道标签从自有的 `.mc-channel-tabs` 统一到 `.st-tabs`，所以模型列表的「llama.cpp / Strata」和设置页的「服务 / 通用」是同一套 DOM 与 CSS —— 只需改 `src/styles/components.css` 的深色覆盖。
- **改动**：`[data-theme="dark"] .st-tab.is-active` 增加一行 `color: var(--st-accent-text);`（深色下该 token = `#4ade80`；它的语义就是「accent 当文字用」，浅色下是 `#0c8a60`，而本规则只在深色下命中，所以浅色主题完全不受影响，仍走 `.st-tab.is-active { color: var(--st-ink) }`）。选择器权重 (0,3,0) 高于基础的 (0,2,0) 且加载在后，稳定生效。
- 顺手修正 `components.css` 标签组那段过时注释：「设置页按引擎分档」→「设置页按分组分档 —— 服务 / 通用」（§28 已把标签从引擎通道改成服务/通用分组）。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build58.log`）；exe **9,793,024 B / 2026-10-16 17:27:21 / SHA256 前 16 `F3CF30DDCFC121EC`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-darktab`（上一版 9,793,024 B / `E26A2DC38E5B7949`）。
- 预览：`E:\tmp\preview-tabs-dark.html`（`<html data-theme="dark">`，链真实样式）→ 截图 `E:\tmp\preview-tabs-dark.png`，同时展示模型列表与设置页两处顶栏的选中态。

### 34. 窗口外观：标题栏去掉图标与应用名、跟随界面主题；标签字号放大（2026-10-16，用户 m10549 / m10631）

用户原话（m10549）：「1、标签的字体要再大一些；2、可以像 strata-manager 一样没有窗口标题吗」。隔一轮又说（m10631）：「采用B方案，但是我要求去掉标题栏左边的图标和应用名称，因为重复了」。

先把三条路摆给用户选（A 完全无边框 / B 只把系统标题栏变暗 / C 不动），并写清代价：**A 会连带失去贴边吸附与 Win+方向键平铺，双击最大化要自己写**。用户选 **B**：保留系统标题栏，只让它跟随明暗，同时去掉标题栏左侧的图标与文字。

- **改动 1（字号）**：`src/styles/components.css:144` 的 `.st-tab` 字号 `--st-fs-xs`(12px) → `--st-fs-md`(14px)。高度仍是 28px（用户没要求改高度）。模型列表的通道标签与设置页的分组标签共用这一条，一处生效两处。
- **改动 2（标题）**：`src-tauri/tauri.conf.json` 窗口定义 `"title": "llama.cpp GUI"` → `""`；同时把 `index.html` 的 `<title>` 也清空 —— 双保险，因为网页标题有时会反过来盖住窗口自带的标题。空标题下 Windows 不画文字（不会回退成 exe 名）。
- **改动 3（图标）**：`src-tauri/Cargo.toml` 新增 `[target.'cfg(windows)'.dependencies] windows-sys = { version = "0.60", features = ["Win32_Foundation", "Win32_UI_WindowsAndMessaging"] }`（`Cargo.lock` 里本就有 windows-sys 0.60.2 作为 tauri/tao 的传递依赖，提成直接依赖不产生新下载）；`src-tauri/src/lib.rs` 的 `create_main_window` 不再丢弃 `builder.build()` 的返回值，接住窗口后调 `strip_caption_chrome(&window)`，该函数 `#[cfg(windows)]` 下用 `SendMessageW(hwnd, WM_SETICON, ICON_SMALL, 0)` 清掉标题栏那个小图标（旧版 Chrome 也是这个用法），非 Windows 分支是空实现。
  - **为什么不用 Tauri 的 `set_icon`**：tao 的实现只在 `Some(icon)` 时下发 `WM_SETICON`，传 `None` 什么都不做；而给一张透明图会把大小两个图标一起换掉（任务栏变成空白方块）。只清 `ICON_SMALL`、不动 `ICON_BIG`，任务栏与 Alt+Tab 的图标保持原样。
- **改动 4（标题栏跟随主题）**：`src-tauri/capabilities/default.json` 加 `core:window:allow-set-theme`；`src/App.tsx` 的主题 effect 里同步调 `getCurrentWindow().setTheme("dark" | "light")`（失败静默 —— 在浏览器里跑 `npm run dev` 时会抛）。Tauri 在 Windows 上走 DWM 的 immersive dark mode，只影响标题栏与原生滚动条。**全项目没有 `prefers-color-scheme` 媒体查询**（配色走 `[data-theme]`），所以不会互相打架。
  - 没走 `tauri.conf.json` 的 `"theme": "Dark"`，一是静态深色在用户切浅色界面时不协调，二是 `Theme` 枚举的 serde 大小写没在本地 schema 里核实过（本地 `gen/schemas/desktop-schema.json` 是 capabilities schema，不含窗口字段）。
- **已知副作用（已告知用户）**：窗口标题为空 → **Alt+Tab 列表里是空白条目**；任务栏悬停提示回落到 exe 名。
- **待实机确认**：① 标题栏图标是否真的消失（若系统把 NULL 的 `ICON_SMALL` 回退到 `ICON_BIG`，图标会还在，那就得改用 1×1 透明 ICO + `LoadImageW`）；② 标题栏跟随主题有没有首帧闪烁（窗口初始是系统主题，App 挂载后才 `setTheme`，约 100ms）。
- 门禁与部署：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0（约 40 秒）；`npm run tauri build` exit 0（日志 `target\build59.log`）；exe **9,797,120 B / 2026-10-16 17:43:09 / SHA256 前 16 `46B449ECDD1AF563`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-titlebar`（上一版 9,793,024 B / `F3CF30DDCFC121EC`，本次 +4,096 B = 新增的 windows-sys 调用路径）。
- 预览：`E:\tmp\preview-tabs-font.html` → `E:\tmp\preview-tabs-font.png`（标签 12px / 14px 在模型列表与设置页两处的对比）。标题栏是系统绘制的，静态预览做不出来，只能实机看。

### 35. P1 上文档位压测（context-benchmark 移植）（2026-10-16，用户 m10775「继续下一步」）

- **依据**：`STRATA_MANAGER_PORT_ASSESSMENT.md` §6 实施顺序 P1「Benchmark 上文档位」（3–5 天），上位依据是 §7 决策 4「BenchPanel 合并成一个多标签页，且 UI 样式必须统一」。§6 明确「不建议先监控后基准」——监控采集层要引新依赖（`sysinfo`、`nvidia-smi`），基准与聊天几乎零新依赖，先做能快速验证移植这条路走得通。
- **新增文件**：
  - `src/utils/contextBenchmark.ts` —— 纯逻辑（不碰网络、不碰 UI）。档位表 `[8,32,64,128,256,384,512,768,1024]×1024`、`HEADROOM 64`、`MAX_CONTEXT_TOKENS`、串行双层循环语义照抄上游 `E:\Code\strata-manager-main\packages\core\src\context-benchmark.ts`；导出 `getContextBenchmarkTiers` / `validateContextBenchmarkOptions` / `planContextBenchmarkTiers` / `contextBenchmarkMessages` / `estimateRecordLines` / `estimatePromptTokens` / `adjustRecordLines` / `needsAdjustment` / `summarizeByTier`。
  - `src/api/chat.ts` —— 项目里第一个聊天请求客户端：`streamChat()` 打前门 `:9090` 的 `POST /v1/chat/completions`（`stream: true` + `stream_options.include_usage`），手工解 SSE 帧（`EventSource` 发不了鉴权头，与 `src/api/router.ts` 订阅状态同一原因），回收 prompt/completion/cached tokens、首 token 延迟、首字节延迟、wall 时间、finish_reason；另有 `fetchChatModelProps()` 取 `n_ctx` 判档位。请求体 `model` 用 config JSON 的 `name`（铁律 2）。M4 原生聊天 UI 会复用它。
- **改动文件**：
  - `src/api/router.ts` —— `authHeaders()` 由私有改为导出，`chat.ts` 复用，避免第二套 key 逻辑。
  - `src/store.ts` —— 新增 `export interface ContextBenchState`（`running/tier/done/total/stats/report/error`）与三个动作 `runContextBench` / `cancelContextBench` / `clearContextBench`；取消句柄是模块级 `let benchAbort: AbortController | null`。**状态放 store 不放组件**，理由见 §8 第 1 项（性能测试面板切换标签丢状态）。1247 → 1425 行。
  - `src/components/ContextBenchPanel.tsx`（新）—— 选模型（`configs.filter(c => c.has_model)`，用 `name` 当模型名）→ 输出上限 / 重复次数 → 跑 / 停止 → 结果表（档位、输入 tokens、输出 tokens、预填充 t/s、输出 t/s、首 token、说明列「N 次中位」）+ 跳过的档位与原因。第一版**只做 llama.cpp 通道**，Strata 通道留后续。
  - `src/components/BenchPanel.tsx` —— 顶栏加「速度测试 / 上下文档位」两个标签（`.st-tabs` 同一套），原内容包进第一个标签，第二个标签渲染 `<ContextBenchPanel />`；标签状态 `benchTab` 用组件 state（切页会回到「速度测试」，但**结果数据在 store 不丢**）。646 → 672 行。
  - `src/styles/components.css` —— 新增 `.panel-title`、`.st-input--num`（`flex: 0 0 96px`，否则 `.st-row > .st-input` 把数字框拉成路径框那么宽）、`.st-hint--warn`。
- **与上游的关键差异（必读）**：**llama.cpp 没有 `/v1/messages/count_tokens`**，上游靠它迭代 6 次校准输入长度 —— 这里降级（§6 已预告）：第 0 趟按「每行约 28 token」(`ESTIMATED_RECORD_TOKENS`) 估算发出去，拿到 `usage.prompt_tokens` 后若相对偏差 >5%（`needsAdjustment`）则按比例 `adjustRecordLines` 改行数重发一趟，样本上记 `tokenCountMethod: "estimated" | "adjusted"` 与 `calibrationReason`。资源字段（peakGpuMemoryMiB 等）本版仍是 null，等 P4 监控采集层。
- **事故与教训（两处，都是脚本/类型层面）**：
  1. 注入 `store.ts` 的脚本 `E:\tmp\bench_store.py` 把 `ContextBenchState` 类型块插到了锚点 `interface AppStore {` **之后**（脚本统一用了 `lines[idx+1:idx+1] =`），于是类型块插进了接口体内 → `tsc` 报 20 个语法错（`store.ts(74,1) TS1131`、一串 TS1011/TS1109、`(189,1) TS1128`）。**教训：插入方向要和锚点语义对上，before 与 after 不能一套到底**。修法是 `E:\tmp\fix_type.py`：整块按内容精确匹配定位后删除，再插到 `interface AppStore {` 之前（不在原地的块未回滚，只搬这一块）。
  2. 接着 `tsc` 报 `store.ts(1308,15) TS2322`：`contextBenchmarkMessages` 返回 `{ role: string; content: string }[]`，与 `ChatMessage[]` 的 `role` 联合类型不兼容。没有改 `chat.ts`（那会让 utils 反向依赖 api），而是把返回类型收窄成 `{ role: "user"; content: string }[]`。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build61.log`）。exe **9,801,216 B / 2026-10-16 19:17:51 / SHA256 前 16 `5C02409477EC3A66`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-contextbench`（上一版 9,797,632 B / `F769FDD454604ECC`，本次 +3,584 B）。
- **未做（下一步）**：① 结果图表（上游有，这里第一版只有表 —— 内联 `style` 画柱子违反铁律 8，需要先定新 CSS 类）；② Strata 通道纳入压测；③ P2 七场景套件 + 结果历史（可直接复用现成的 `bench_records*` 命令与 `bench/records.json`）；④ 把老压测面板的状态提升到 store（§8 第 1 项的另一半，合并多标签时一起做）。

### 36. 性能测试页改版：删掉速度测试、上下文档位对齐上游（2026-10-16，用户 m10976 / m10993）

- 用户要求：上下文档位测试页面**和上游一样**，只把「测试配置名称」换成「模型名称」（m10976）；同时**把原有的速度测试页面删掉**（m10993）。
- **删掉速度测试页**：`src/components/BenchPanel.tsx` 从 671 行缩成 20 行的页面壳（`main.main-area` + 顶栏「性能测试」+ `<ContextBenchPanel />`）；顶栏原来的「速度测试 / 上下文档位」两个标签一并去掉 —— 只剩一块内容就不需要标签。`src/App.tsx` 不动（仍是 `<BenchPanel />`）。
- **后端与死代码暂留**：Rust 侧 `bench_server` / `bench_strata` / `bench_records*` / `bench_hardware` 命令保留；`src/ipc.ts` 的对应封装、`src/types.ts` 的 `BenchRecord` / `BenchStats` / `Hardware`、`src/utils/bench.ts` 里的 `computeStats` / `draftText` / `isStats` / 导出函数都没删（导出符号不会触发 TS6133）。要不要连后端一起删，等用户定。
- **上下文档位页对齐上游**（`src/components/ContextBenchPanel.tsx` 重写，403 行）：
  - 结构照上游 `apps/desktop/src/pages/ContextBenchmarkPage.tsx` 的三块：**测试计划 / 进度 / 结果**。
  - 测试计划：模型名称（下拉，取代上游的「测试配置名称」文本框，语义同上游默认取 `profile.name`）→ 档位多选复选框（按 `maxTokens + CONTEXT_BENCHMARK_HEADROOM` 与模型 `max_context` 双向禁用，两种禁用各有 title 说明）→ 输出 token 上限（16–4096）/ 重复次数（1–10）/ 请求超时秒（1–600）→ 遇错停止开关 → 底部「N 档 · N 次请求」与开始/停止按钮。
  - 进度：只在跑动中出现，`<progress class="st-progress">` + 「正在跑 X · 第 i / n 次请求 · 用时 N 秒」+「完成/失败/停止/百分比」；用时按 500 ms 心跳累加（与上游同频）。
  - 结果：状态徽章 + 历史报告下拉（`history.length > 1` 才出现，选项 `时间 · 模型 · 状态`）+ 三张折线图（预填充 tok/s、解码 tok/s、请求耗时 s；按档位对 `state === "completed"` 的样本取平均，缺数据处断线）+ 11 列表格（模型名称 / 档位 / 实际输入 / 实际输出 / 预填充 / 解码 / 整卡显存峰值 / 最低空闲显存 / RAM 峰值 / 总耗时 / 状态）+ 跳过档位与中断原因提示。
  - 图表 `src/components/ContextBenchCharts.tsx`（218 行）从上游 `ContextBenchmarkCharts.tsx` 移植：纯 SVG、`ResizeObserver` 自适应宽度、数值直接标在点上（多候选偏移避让，不靠 hover）、密集档位（>6 个）标签旋转 −55°/−70°。**没有移植上游的「复制图片」按钮**（上游 `contextBenchmarkImage.ts` 用 canvas 生成 PNG，183 行），也没有 A/B 对比面板。
- **与上游的唯一实现差异**（此前已记录，不变）：llama.cpp 没有 `/v1/messages/count_tokens`，输入长度先按每行约 28 token 估算，再用第一趟 `usage.prompt_tokens` 校正一次并重发；样本里 `tokenCountMethod` 记 `estimated` / `adjusted`。
- **store 改动**（`src/store.ts`，1424 → 1521 行）：`ContextBenchState` 改成 `{ running, currentTier, completed, failed, cancelled, total, startedAt, samples, history, selectedId, error }`；`runContextBench` 重写 —— 支持 `tiers` 多选 / `timeoutMs` / `stopOnError`，每跑完一条就同步 `samples` 与三个计数（不必等整轮结束才看得到），结束时把报告插到 `history` 头部并 `selectedId = report.id`，`history` 最多留 20 份；被取消的样本记 `state: "cancelled"` 而不是 `failed`；新增 `selectContextBench(id)`；`clearContextBench` 只清当前结果、保留历史。
- **CSS**（`src/styles/components.css`）：新增 `.st-checks` / `.st-check`（档位勾选）、`.st-progress`（`appearance: none` + `::-webkit-progress-bar` / `::-webkit-progress-value`，这样进度条不写内联宽度、不违反铁律 8）、`.st-charts` / `.st-chart__*`（三列 grid，≤900px 降一列）；`.st-chart__svg { color: var(--st-accent) }` 让 SVG 里的 `currentColor` 生效。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build62.log`）。exe **9,799,680 B / 2026-10-16 19:39:52 / SHA256 前 16 位 `14271405EBDA9409`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchpage`。
- 预览：`E:\tmp\preview-bench.html` → `E:\tmp\preview-bench.png`（数据为示意）。
- **未做**：① 复制图片（上游 `contextBenchmarkImage.ts`）；② A/B 对比面板（上游 `compareContextBenchmarkReports`）；③ 显存/内存峰值三列现在恒为「—」，要等 P4 监控采集层。

### 37. 性能测试页版面修正：数字框被撑成 96px 高 + page-fill 压扁卡片（2026-10-16，用户 m11180 / m11192）

§36 交付的上下文档位页在真机上「完全变形」，本节记根因与修法。**§36 里「ContextBenchPanel 403 行」等描述已被本节取代**。

- **根因 1：数字输入框被撑成 96px 高**。`src/styles/components.css` 原有一条 `.st-input--num { flex: 0 0 96px; }`（本意是让「输出上限 / 重复次数」在 `.st-row` 里定宽），但新页面把输入框放进了 `.st-field`（`display:flex; flex-direction:column`）——flex 主轴变成纵向，`flex-basis: 96px` 就变成了**高度**。修法：规则限定为 `.st-row > .st-input--num`，只在行式布局里生效。
- **根因 2：多张 `.panel` 被压扁并裁切**。`src/styles/app.css:956` 的 `.page-fill { flex:1; min-height:0; display:flex; flex-direction:column; overflow:hidden }` 是个**裁剪型 flex 列**：页内三张卡片默认 `flex-shrink:1`，总高超过一屏时被压缩，而 `.panel` 自己又是 `overflow:hidden`，于是内容被切（真机截图里「开始」按钮只露出一半、表格只剩一行）。修法：新增 `.page-fill--scroll { display:block; overflow-y:auto }`，只有本页根节点用它；**不动 `.page-fill` 本身**（日志页等依赖它的内部滚动）。
- **定位手段（可复用）**：不再靠猜，写离线复现页 `E:\tmp\repro-bench.html` —— link 真实样式 + **还原真实父级链**（`#root > main.main-area > div.page-fill`），页面内联脚本读 `getBoundingClientRect()` 与 `getComputedStyle()`，把宽高/display/flex/padding/box-sizing 打到顶部覆盖层，headless Edge 截图读数。首次复现就量到 `#cb-max 数字框 322×96 | flex=0 0 96px`、`panel1 335.656px`（小数即被压缩）。**教训**：只 link CSS 而用 `#root{display:block}` 绕过 flex 父链，复现不出问题——早先的 `preview-bench.html` 正是因此漏掉了这两个 bug。
- **版面按上游重排**（用户 m10976「和上游一样」），三块：
  - 「测试计划」：标题行（模型名 + 空闲/跑着徽章）→「当前模型上限 XK」大字 + 右侧「开始测试」按钮 → 档位胶囊（选中绿底绿边 + 勾，超上限/余量不足为虚线灰且禁用，title 说明原因）→ 一行四个字段（模型名称 / 每档轮数 / 最大输出 token / 每次超时（秒））→「出错即停」开关 + 右下「N 个档位 · N 个请求」。
  - 「各上下文档位实测」：三张卡片式折线图（预填充 tok/s、解码 tok/s、请求耗时 s）。
  - 「逐次测量」：11 列表格，**两行表头**（第二行是单位）。
  - 「进度」面板仍保留（仅运行中出现），上游没有这块。
- **CSS 增删**（`src/styles/components.css`）：新增 `.page-fill--scroll`、`.bench-head` / `.bench-head__right` / `.bench-model` / `.bench-top` / `.bench-limit`、`.st-tiers` / `.st-tier`（含 `.is-on`、`:has(input:disabled)`、`__box`）、`.bench-fields`（4 列，≤900px 降 2 列）、`.bench-foot`、`.st-input--history`、`.st-table__units th`、`.st-table--nowrap td`，并给 `.st-chart` 补上卡片样式（边框 / 圆角 / 内边距 / 底色）；删掉改版后不再引用的 `.st-checks` / `.st-check`。
- **两处表格细节**：`.st-table th` 加 `white-space: nowrap`（11 列表头在窄窗口里会把「实际输入」折成两行）；单元格不折行则用**本页专用**的 `.st-table--nowrap`——`.st-table` 是共享类，设置页那张运行环境表里有长路径，全局 nowrap 会平白逼出横向滚动。单位行的 `tok/s` 需要 `text-transform: none` 覆盖 `.st-table th` 的 `uppercase`。
- **仍未做**（与上游的差）：上游「各上下文档位实测」标题右侧的「复制图片」按钮（`contextBenchmarkImage.ts` 用 canvas 生成 PNG，183 行）未移植；A/B 对比面板也未做。
- 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build63.log`）。exe **9,800,192 B / 2026-10-16 19:56:08 / SHA256 前 16 位 `54BA84B1A068E7AF`**；已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchlayout`（上一版 9,799,680 B / `14271405EBDA9409`）。

### 38. 性能测试页变形（第二次）：CSS 加载顺序把 `.page-fill--scroll` 盖掉 + 图表 path 缺 fill（2026-10-16，用户 m11345「还是变形」）

§37 的两处修正里，数字框那条生效了（真机档位胶囊、四列字段都对），但 `.page-fill--scroll` **在真机上完全没生效**：测试计划卡片底部「出错即停」整行被裁、逐次测量表只剩一行。

- **根因三（覆盖失效）**：`.page-fill--scroll { display:block; overflow-y:auto }` 写在 `src/styles/components.css`，而本项目 CSS 加载顺序是 `tokens.css → css/all.min.css → legacy/index.css → components.css → app.css`（见 `src/main.tsx`）——**app.css 最后加载**，里面的 `.page-fill { display:flex; flex-direction:column; overflow:hidden }`（`app.css:956`）与我们的规则**特异性相同 (0,1,0)**，后加载者胜 ⇒ 单类写法被盖掉。
  - **修法**：写成 `.page-fill.page-fill--scroll`（(0,2,0)），与加载顺序无关。这条经验对整个项目都成立：**要覆盖 app.css 里的规则，只能提高特异性，不能指望"我写在后面"**（components.css 比 app.css 早）。
  - **验证**：离线复现页 `E:\tmp\repro-bench2.html` 的探针从 `disp=flex` 变成 `disp=block`，且 `page-fill 可视高=951 内容高=986 溢出=35px`，卡片不再被压扁。
- **根因四（SVG 默认黑色填充）**：`src/components/ContextBenchCharts.tsx` 的 area / line 两条 `<path>` 只写了 `className`，**没写 `fill`**。SVG 里 `fill` 的初始值是**黑色**（不是 `currentColor`），所以面积与折线都被填成黑色实心 —— 真机截图里三张图各有一大块黑三角。CSS 里的 `.st-chart__area { color: var(--st-accent) }` 只给 `currentColor` 供值，救不了没写 `fill` 的元素。
  - **修法**（照上游属性）：area 加 `fill="currentColor" opacity=".12"`；line 加 `fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"`；数据点 `<circle>` 补 `fill="currentColor"`（上游也是 currentColor，原来默认黑点）。
  - 注：CSS 的 `.st-chart__line { stroke: var(--st-accent) }` 优先级高于表现属性，所以线色仍由 token 决定、属性只是兜底。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build64.log`）。exe **9,800,192 B / 2026-10-16 20:37:38 / SHA256 前 16 位 `CB08DA4882D284A0`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchlayout2`（上一版 `54BA84B1A068E7AF`）。
- **仍未做**（与上游的差，同 §37）：上游「各上下文档位实测」标题右侧的「复制图片」按钮（canvas 导 PNG，上游 183 行）没有移植；上游的 A/B 对比面板没有做；「进度」面板是我们独有的（上游没有独占的进度卡）。

### 39. 性能测试页三处修正：卡片内边距 / 两张卡合成一张 / 选择模型不再启动模型（2026-10-16，用户 m11407）

- **用户三点**（m11407，附上游截图 m11409）：①「你的卡片内容上下左右都没有边距」；②「各上下文档位实测和下面的逐次测量是一张卡片」；③「选择模型不应该启动模型」。
- **认知更正**：②不是「拆成两张」，而是「上游本来就是一张」。上游截图里「各上下文档位实测」的标题行（含「复制图片」按钮）、三张图表、以及「逐次测量」的标题行与表格，**全在同一张白卡片内**；我们做成了两张独立卡片（§37 的版面重排按三块各给了一个 `.panel`）。
- **修 1（内边距）**：`src/styles/components.css` 新增 `.page-fill--scroll > .panel { padding: var(--st-s-5); margin-bottom: var(--st-s-5); }`。`.panel` 自身只有底色/边框/圆角/阴影，**没有内边距**（`src/styles/app.css:62`），所以内容贴边；间距从 `1rem` 拉到 `--st-s-5`（20px）让两张卡清楚分开。
- **修 2（合并卡片）**：`src/components/ContextBenchPanel.tsx` 删掉图表 panel 的 `</div>` 与逐次测量 panel 的 `<div className="panel">`，并把第二段的 `<div className="bench-head">` 改成 `<div className="bench-head bench-head--sec">`；CSS 加 `.bench-head--sec { margin-top: var(--st-s-5); }` 作为同卡内两段之间的间距。选这个改法（而不是包一层 `.bench-sec`）是为了零结构改动、不必补闭合标签。
- **修 3（选择模型不再启动模型）**：删掉组件里进入页面 / 切换模型时调用的 `fetchChatModelProps(port, model)`（`GET /props?model=…` 会让前门顺手把该模型加载起来）。连带删除：`maxContext` 这个 state、`maxTokensRef`、`port`、`available` 的 useMemo（改为常量 `CONTEXT_BENCHMARK_TIERS`）、`blocked` 里两条上限分支、档位禁用的 `tooBig`。
  - 上限改成「开始时才读」：`runContextBench` 内部本来就会读上限并按 `planContextBenchmarkTiers` 跳过超上限的档位，理由写在结果里。跑过一次之后，「当前模型上限」显示那次实测到的值（取自 `selected.maxContext`，要求 `selected.model === model`）；没跑过时显示「开始测试时读取」而不是数字。
  - 默认勾选改为 `CONTEXT_BENCHMARK_TIERS.slice(0, 5)`（8K…256K）。
  - **代价（已告知用户）**：跑之前不显示模型上限，超上限的档位要到开始时才被跳过；上游能显示静态上限（200K）并提前禁用超限档位，是因为它从 profile 拿得到。我们的前端 `ConfigEntry` 只有 `id` / `name` / `no_webui` / `has_model`，**没有 `max_context`**，拿不到静态值。
- **实施脚本**：`E:\tmp\bench_fix.py`（15 个 op：逐行精确匹配 + 每处断言唯一命中 + 倒序应用避免行号漂移；dry-run 后 `--apply`）。`ContextBenchPanel.tsx` 429 → 387 行；`npx tsc --noEmit` exit 0。
- **复现页同步**：`E:\tmp\repro-bench2.html` 改成合并后的结构（删掉两 panel 之间的 `</div>` 与 `<div class="panel">`，第二段加 `bench-head--sec`），截图 `E:\tmp\repro-bench8.png` 验证：panel 内边距 20px、图表与逐次测量同卡、档位一行放下。
- **repro 的假象（教训）**：repro 里档位手写了 10 个（含 200K），会 9+1 换行；真实组件只有 `CONTEXT_BENCHMARK_TIERS` 的 9 个，一行放得下。之前怀疑的「胶囊太宽导致换行」是复现页多写一个档位造成的假象 —— **复现页的数据也要跟真实数据一致，否则会追错问题**。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build65.log`）。exe **9,800,192 B / 2026-10-16 20:59:04 / SHA256 前 16 位 `DF2F7DBC21EBD320`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchfix3`（上一版 `CB08DA4882D284A0`）。
- **仍未做**（与上游的差，同 §37 / §38）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 40. 压测数据改用 llama.cpp 的 timings + 档位上限被动读取 + 本页排版照上游（2026-10-16，用户 m11542）

- **用户三点**（m11542，附上游截图 m11409）：①「仔细看一下上游的排版：文字大小、上下的间距、出错即停开关的位置、图表单位的位置」；②「根据模型的上下文大小在挡位中插入可以测试的最后一个挡位」；③「你的测试得到的预填充和解码数据有问题」。
- **第 3 点（数据，根因）**：原来用**客户端到达时刻**自己估速度 —— `prefill = promptTokens / firstTokenMs`（`firstTokenMs` 含连接建立、排队、前门转发、SSE 解析），`decode = completionTokens / (wallMs - firstTokenMs)`，两头都被非计算开销污染。而 llama.cpp 响应里本来就带 **`timings`**（`prompt_n` / `prompt_ms` / `prompt_per_second` / `predicted_n` / `predicted_ms` / `predicted_per_second` / `cache_n`），只统计纯计算时间；老的速度测试页（`src-tauri/src/bench.rs:87`）一直就是用它取数的。
  - 改法：`src/api/chat.ts` 新增 `ChatTimings` 类型与 `StreamChunk.timings` 解析（哪个 chunk 带就记哪个，后面的覆盖前面的），`ChatStreamResult` 加 `timings` 字段；`src/store.ts` 的 sample 里 `prefillTokS = timings.promptPerSecond ?? 估算`、`decodeTokS = timings.predictedPerSecond ?? 估算`，**缺 timings 才回退**到按时间戳估算。
  - **口径差异要记住**：表格「实际输入」列显示的是 `usage.prompt_tokens`（**含** prompt 缓存命中），而 `timings.prompt_n` 是本次**实际计算**的 token 数（不含命中）。两个数字不一致是正常的，不要拿它们互相对账。
- **第 2 点（档位上限）**：既不能选模型时读 `/props?model=…`（会把模型加载起来，用户 m11407），也不能用 `/v1/models` 现有的 `meta.n_ctx`（llama.cpp 通道那份**硬编码 0**）。
  - 后端：`src-tauri/src/strata_proxy.rs` 的 `llama_models_payload` 里 `"meta": { "n_ctx": 0 }` → `"meta": { "n_ctx": ctx_size(&item.config) }`，新增 `fn ctx_size(config: &model_config::ModelConfig) -> u64` 扫 args 的 `--ctx-size` / `-c` / `--ctx-size=`；`--ctx-size 0`（llama.cpp 语义：用模型训练时的上限）返回 0，前端当「未知」处理。
  - 前端：`src/api/chat.ts` 新增 `fetchModelContext(port, model)` —— `GET /v1/models`（**被动端点**：前门只读 config + 调度状态，不加载模型）取该模型条目的 `meta.n_ctx`。
  - `ContextBenchPanel`：进页面 / 换模型时调 `fetchModelContext` 存进 `maxContext`；`available` = `CONTEXT_BENCHMARK_TIERS` ∪ `{maxContext}` 排序 —— **最后一档就是模型上限**（若它不在标准档表里，例如 200K / 16K）；`tooBig` 恢复：超过上限的档位禁用并给悬停提示「超过模型的上下文上限」（与上游一致）；「当前模型上限」显示被动读到的值，读不到才回退到上次实测值 / 「开始测试时读取」。
- **第 1 点（排版，`src/styles/components.css`）**：
  - 卡片标题放大：`.bench-head .panel-title { font-size: var(--st-fs-lg) }`（18px，上游「测试计划」约 18–20px）。
  - 段间距：`.bench-top` / `.st-tiers` / `.bench-fields` 的间距从 `--st-s-3`（12px）提到 `--st-s-4`（16px）。
  - 「出错即停」：新增 `.bench-switch-row` + `.bench-switch` —— 开关**紧跟文字**排左边，右侧放「N 个档位 · N 个请求」（原来是 `.st-switch-row` 的两端对齐，把开关甩到最右）。`.st-switch-row` 的 CSS 保留不动（设置页还在用）。
  - 图表单位：`.st-chart__title { justify-content: space-between }` → 标题靠左、单位靠右（上游就是这样）。
  - 表格单元格 `.st-table--nowrap td { padding: 13px 10px }`（照上游的 13px）。
- **顺带查清的假象（教训）**：一直看到「10 个档位 9+1 换行」，一度以为是胶囊太宽。实际是**复现页的诊断覆盖层 `<pre id="diag">` 造成的**：`body` 是 flex 容器（legacy 默认），`#root` 与那个长文本 `<pre>` 成了并排的 flex item，`#root` 被压到 750px，档位当然换行。**教训：诊断覆盖层绝不能作为 `#root` 的兄弟节点躺在文档流里**（要么 `position: fixed`，要么放到 `#root` 内部的绝对定位层）。干净页面（去掉 diag）里 10 个档位一行放得下。
- **实施脚本**：`E:\tmp\bench_ctx.py`（`ContextBenchPanel.tsx` 9 处替换：import / port / maxContext / effect / available / tooBig / measuredLimit / switch 行 / 删提示）、`E:\tmp\bench_css.py`（CSS 7 处替换）。踩过的坑：脚本里两个相邻字符串字面量会被 Python 自动拼接（`'...\n'` 后跟 `"\n",` → 变成 3 行的锚点），导致「0 处命中」；改成只留一个 `\n` 即可。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0（`strata_proxy.rs` 有改动）；`npm run tauri build` exit 0（日志 `target\build66.log`）。exe **9,799,680 B / 2026-10-16 21:25:27 / SHA256 前 16 位 `2A4C3CF2767DD027`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchdata`（上一版 `DF2F7DBC21EBD320`）。
- **仍未做**（与上游的差，同 §37 / §38 / §39）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 41. 压测页六点：默认选运行中的模型 / 自动勾选不超上限 / 历史按模型 / 表头不画线（2026-10-16，用户 m11748）

用户六点，其中 1 / 2 / 3 / 6 是本轮改动，4 / 5 是解释（不是 bug）。

- **① 模型名称默认选正在运行的模型**（多个取 id 靠前的）：新增 `routerModels` 选择器；`defaultModel` = `routerModels.filter(m => m.status.value === "loaded").map(m => m.id).sort(localeCompare)[0] ?? ""`；`model = picked || defaultModel || models[0]?.name || ""`。运行状态取自前门合成的 `/v1/models`（只读、不加载模型），`status.value === "loaded"` 与 store 里既有判定（`store.ts:719`、`store.ts:1508`）一致。store 每 5 秒刷新一次，用户没手动选时会跟着跑动状态走。
- **② 自动勾选的档位不超过模型上限**：读上限的 effect 里拿到值后重算勾选：`min = maxTokens + CONTEXT_BENCHMARK_HEADROOM`，候选 = `CONTEXT_BENCHMARK_TIERS` 再补上 `maxContext` 本身（不在标准档位表里时），过滤 `tier > min && tier <= maxContext` 后排序。为此把 `maxTokensRef` 加回来（effect 只依赖 `[port, model]`，不能因为改输出上限而重发请求）。
- **③ 列头与单位行之间不画线**：`.st-table th` 有 `border-bottom`，第一行列头与 `.st-table__units` 行之间因此多一条线；给第一行加 `className="st-table__head"`，CSS 加 `.st-table__head th { border-bottom: 0; }`（同特异性、写在后面所以生效）。单位行下面那条线保留 —— 上游就是只有这一条。
- **⑥ 历史按模型隔离**：新增 `modelHistory = bench.history.filter(r => r.model === model)`；`selected` 的回退改为 `modelHistory.find(id) ?? modelHistory[0] ?? null`（原来回退到全局 `history[0]`，切模型后显示的是别的模型的结果）；历史下拉的条件与选项都改成 `modelHistory`。
- **④ 有草稿模型时实际输出没到最大输出** —— 正常，不是 bug：`max_tokens` 是**上限**不是目标，模型吐完 EOS（或命中停止串）就结束。压测提示词最后一句是 “Summarize the records above in one short sentence.”，一句话即停（实测 264 < 512）。投机解码（`--spec-draft-n-max 3` / MTP 草稿）只是加速，不改变停止判定。想跑满就得改提示词要求更长输出，但那会让测量偏向解码阶段。
- **⑤ 预填充/解码速度逐档下降** —— 物理特性，不是测量错误：预填充的注意力是 O(n²)，上下文翻倍则每 token 计算量翻倍、tok/s 大致减半（档位 8K→16K 正好是翻倍，看着就像腰斩）；解码每生成一个 token 都要把整个 KV cache 读一遍，是显存带宽瓶颈，上下文越长每 token 读得越多，速度随之下降，q8_0 KV 还有反量化开销；另外 `n_batch/ubatch` 固定（默认 2048），长 prompt 要切更多批，批间固定开销也会拉低效率。现在数值直接取 llama.cpp 的 `timings`，它只算纯计算时间，趋势与官方 `llama-bench` 一致。
- **实施脚本**：`E:\tmp\bench_ctx2.py`（TSX 9 处 + CSS 1 处，逐行精确匹配 + 每处断言唯一命中 + 倒序应用；dry-run 后 `--apply`）。`ContextBenchPanel.tsx` 413 → 440 行；`components.css` 816 → 821 行；`npx tsc --noEmit` exit 0。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build67.log`）。exe **9,800,192 B / 2026-10-16 21:51:02 / SHA256 前 16 位 `6F707C40E09DE14D`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchhist`（上一版 `2A4C3CF2767DD027`）。
- **仍未做**（与上游的差，同 §37–§40）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 42. 压测页上限不再依赖前门：从本地 config 的 --ctx-size 取 + 徽章改显示模型状态（2026-10-16，用户 m11820）

- **用户反馈**（m11820）：「当前模型上限开始测试时读取」，所以选择了运行中模型，没有上下文出来，测试档也没有重算，右上角的模型状态还是「空闲」。
- **根因**：上一版上限**只**从 `GET /v1/models` 的 `meta.n_ctx` 读。实测 `http://127.0.0.1:9090` 连接被拒 —— 前门没在跑（模型可能是 `run-<模型>.bat` 直接起的，前门只有 GUI 里点启动或第一次请求才会起）。前门没起 ⇒ `fetchModelContext` 失败 ⇒ `maxContext = null` ⇒ 上限显示「开始测试时读取」、档位不重算。
  - 顺带：模型下拉的候选来自 `configs`（配置目录扫描，不需要前门），而「正在运行」来自 `routerModels`（前门合成，需要前门）。前门没起时 `routerModels` 是空的 ⇒ `defaultModel` 为空 ⇒ 回落到 `models[0]`，用户以为选中的是运行中的模型。
- **修 1（Rust：上限随模型列表下发）**：`src-tauri/src/model_config.rs` 新增 `pub fn ctx_size(config: &ModelConfig) -> Option<u64>`（解析 `--ctx-size` / `-c` / `--ctx-size=`；值为 0 —— 即「用模型训练上限」—— 与没写一样返回 `None`）；`src-tauri/src/models.rs` 的 `ConfigEntry` 加 `#[serde(default)] pub max_context: Option<u64>`；`src-tauri/src/lib.rs` 构造 `ConfigEntry` 时填 `model_config::ctx_size(&dc.config)`；`src-tauri/src/strata_proxy.rs` 删掉本地那份重复的 `ctx_size`，`/v1/models` 的 `meta.n_ctx` 改为 `model_config::ctx_size(&item.config).unwrap_or(0)`（n_ctx 要 u64）。
- **修 2（前端：本地优先，前门只兜底）**：`src/types.ts` 的 `ConfigEntry` 加 `max_context?: number | null`；`src/components/ContextBenchPanel.tsx` 里 `maxContext = models.find((c) => c.name === model)?.max_context ?? remoteContext`，只有当本地为 `null`（老配置没写 `--ctx-size`）时才去请求前门。档位重算拆成独立 effect（依赖 `[maxContext]`）：拿到上限就重算勾选、并在末尾补上上限那一档。**这样前门没起也能显示上限、重算档位。**
- **修 3（徽章改成模型状态）**：右上角徽章原来显示的是「压测是否在跑」（跑着 / 空闲），用户当成模型状态看了。改成模型运行状态 —— 已就绪（绿）/ 加载中 / 未启动 / 已休眠 / 下载中 / 加载失败，取不到（前门没起）显示「前门未运行」；正在压测时另加一个「压测中」徽章。上游徽章也是模型状态。
- **教训 1（脚本删函数别用括号匹配）**：`while lines[end].strip() != "}"` 会在**第一个**内层 `}` 停下 —— 上次删 `strata_proxy.rs` 的 `ctx_size` 只删了 16 行，留下残块，`cargo check` 报 `error: unexpected closing delimiter: '}'`（`strata_proxy.rs:1221`）。改成按内容锚点整块删除才可靠。
- **教训 2（隐性依赖前门）**：能从本地配置算出来的值就别走 HTTP —— 前端「读前门」看着无害，实际上把功能绑死在「前门必须在跑」上，而前门只有 GUI 启动那一条路。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0；`npm run tauri build` exit 0（日志 `target\build68.log`）。exe **9,801,216 B / 2026-10-16 22:04:08 / SHA256 前 16 位 `9BC86C0E75ADF7FD`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-ctxlocal`（上一版 `6F707C40E09DE14D`）。
- **仍未做**（与上游的差，同 §37–§41）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 43. 压测页：上限兜底到 GGUF / 历史落盘 / 下拉运行标记（2026-10-16，用户 m11934 / m12044）

- **用户反馈**：m11934 —— 「OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL 的上下文只要 127k，但是自动选择的测试有 256k，而且这个模型我上一轮测试过，没有带出历史」；m12044 —— 「在选择模型的下拉列表中，运行了的模型应该有个标志，方便区分」。
- **上限读不到（m11934 前半）**：上一版（§42）上限有两个来源 —— 配置的 `--ctx-size`、前门 `/v1/models`。Sharp-MiniCPM5-2B 的 config 写的是 `--ctx-size 0`，llama.cpp 里这是「**用模型自带的上限**」而不是「没有上限」，于是 `ctx_size()` 返回 `None`、前门没起也拿不到值 → `maxContext === null` → 档位保持初值 `CONTEXT_BENCHMARK_TIERS.slice(0, 5)`（正好到 256K）→ 用户看到的就是这个。
  - Rust：`src-tauri/src/models.rs` 的 `GgufMeta` 增 `context_length: Option<u64>`，扫描时读 GGUF 的 `general.context_length`（`GGUF_TYPE_U32` 与 `GGUF_TYPE_U64` 都认）；新增 `models::context_limit(config)`：先试 `model_config::ctx_size(config)`，为 `None` 再落到 GGUF。`src-tauri/src/lib.rs` 的 `max_context: model_config::ctx_size(&dc.config)` 改为 `models::context_limit(&dc.config)`；`src-tauri/src/strata_proxy.rs` 的 `/v1/models` 里 `n_ctx` 同样改走 `crate::models::context_limit(&item.config)`。
  - **缓存要整体失效**：`META_CACHE_VERSION` 1 → 2（`MetaCacheEntry` 加 `context_length` 并同步读/写缓存文件）。旧缓存条目没有这个字段，而缓存命中时不会重读模型文件 —— 不 bump 的话那些模型的上限会永远是 `None`。
  - 前端：`ContextBenchPanel` 初值 `tiers` 由 `CONTEXT_BENCHMARK_TIERS.slice(0, 5)` 改为 `[]`；上限为 `null` 时 `setTiers([])` 并给一行提示「读不到这个模型的上下文上限（配置里是 --ctx-size 0，模型文件里也没读到），档位请自己勾」。
- **历史丢失（m11934 后半）**：`bench.history` 原来只存在 store 内存里，重启即空（上一版刚让用户重启过 GUI，所以上轮结果必然不见）。`src/store.ts` 新增 `BENCH_HISTORY_KEY = "llamacpp-gui-bench-history"` 与 `trimBenchReport` / `loadBenchHistory` / `saveBenchHistory`：跑完把报告插到队头、截到 20 份后落盘；**落盘前把每条样本的 `output` 清成空串**（表格与图表都不用这 2000 字符，不清的话几轮下来几 MB，配额容易爆）。`contextBench.history` 初值改为 `loadBenchHistory()`。
- **下拉运行标记（m12044）**：`ContextBenchPanel` 的模型 `<option>` 前按状态加前缀 —— `loaded` → `● `、`loading` → `◌ `，其余不加；下拉的 `title` 补一句说明。`<option>` 里上不了颜色，所以用符号前缀；数据来自前门合成的模型列表，前门没起就没标记。
- **教训**：`--ctx-size 0` 是「用模型自带上限」而不是「无上限」，凡是从 args 取值的地方都要为 0 准备回落路径；缓存结构变化必须 bump 版本号，否则旧条目永远缺新字段。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0；`npm run tauri build` exit 0（日志 `target\build70.log`）。exe **9,799,680 B / 2026-10-16 22:34:23 / SHA256 前 16 位 `1212F2BFF27AD3E0`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-ctxgguf`（上一版 `9BC86C0E75ADF7FD`）。
- **仍未做**（与上游的差，同 §37–§42）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 44. 压测页：GGUF 上限按架构前缀读 + 模型下拉自绘（运行中绿色）（2026-10-16，用户 m12106）

- **用户两点**（m12106）：① 压测页提示「读不到这个模型的上下文上限（配置里是 --ctx-size 0，模型文件里也没读到）」，但模型日志里明明有 `load_model: initializing, n_slots = 2, n_ctx_slot = 131072, kv_unified = 'true'`；② 运行中的模型，下拉里名字要变绿。
- **修 1 · 上限读不到的真因**：GGUF 里**没有** `general.context_length` 这个键。标准写法是 **`<arch>.context_length`**，架构名取自 `general.architecture`——这个模型的 `general.architecture` 是 `llama`，所以键是 `llama.context_length = 131072`（UINT32）。上一版 §43 只匹配字面量 `"general.context_length"`，于是永远读不到。
  - **诊断手段**：`E:\tmp\ggufdiag\kv.py` —— 直接读 GGUF 头部前 16 MiB，列出键名/类型/值，标出 `general.*` 与含 `context` 的键。实测该文件 v3、381 张量、70 个 KV，`general.architecture` 是第 0 个，`llama.context_length` 是第 40 个。**脚本必须放在子目录里**：`E:\tmp` 下有个 `struct.py`，Python 把脚本所在目录放在 `sys.path[0]`，会遮蔽标准库 `struct`（报 `AttributeError: module 'struct' has no attribute 'unpack_from'`）。
  - **修法**（`src-tauri/src/models.rs`）：match 分支由两个字面量分支改成一个守卫分支，两种写法都认，U32/U64 都认，其他类型走 `skip_value` 保证后续 KV 不错位：
    ```rust
    _ if key.ends_with(".context_length")
        && (key.starts_with("general.")
            || meta.architecture.as_deref().is_some_and(|arch| key == format!("{arch}.context_length"))) =>
    ```
    `general.context_length` 是部分转换器的老写法，保留兼容。
  - **没动 break 条件**：`if meta.architecture.is_some() && meta.file_type.is_some() { break; }` 保持原样 —— `context_length` 本就在 `general.file_type` 之前（实测第 40 个 vs 词表之后），加进去没有意义。
  - **补了单测** `gguf_context_length_is_read_from_arch_prefix`：合成一个 `general.architecture = "llama"` + `llama.context_length = 131072` 的 GGUF，断言 `read_gguf_meta(&path).context_length == Some(131072)`。`cargo test --lib gguf` → **7 passed**（含原有 6 个）。
  - **为什么显示 128K 是对的**：`--parallel 2` 时 llama.cpp 的 `--ctx-size` 是**总上下文**，每槽 = 总量 ÷ 并行数；日志里的 `n_ctx_slot = 131072` 就是每槽值，压测档位受每槽上限约束，所以按 131072（128K）显示与勾选。
- **修 2 · 下拉里运行中的模型名绿色**：原生 `<select>` 的 `<option>` 由系统菜单绘制，CSS 上不了色（WebView2 下 `option { color }` 无效），所以自绘一个下拉：
  - `src/components/ContextBenchPanel.tsx`：`<select id="cb-model">` 换成 `div.bench-picker`（`button.st-input.bench-picker__button` + `div.bench-picker__menu`），选中运行中的模型时按钮文字也变绿；菜单项 `is-running` 绿色 + 右侧状态字（已就绪 / 加载中）。展开时铺一层 `position: fixed; inset: 0` 的透明遮罩，点空白处收起；菜单 `z-index: 21` 高于遮罩。
  - `src/styles/components.css`：新增 `.bench-picker*` 一组规则，绿色取 `--st-accent-text`（浅色 `#0c8a60` / 深色 `#4ade80`）。
  - **顺带修的坑**：`.panel` 默认 `overflow: hidden`，把展开的菜单裁得只剩一行；`.page-fill--scroll > .panel` 补 `overflow: visible`。本页卡片内容都有内边距，不会溢出圆角，所以放开裁剪没有副作用。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0；`cargo test --lib gguf` **7 passed**；`npm run tauri build` exit 0（日志 `target\build71.log`）。exe **9,800,192 B / 2026-10-16 22:54:38 / SHA256 前 16 位 `F90C05FEA7743D45`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-ctxarch`（上一版 `1212F2BFF27AD3E0`）。
- **仍未做**（与上游的差，同 §37–§43）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 45. 压测页：GGUF 缓存版本升 3（上限仍读不到的真正原因）+ 下拉去状态字 / 加宽（2026-10-16，用户 m12206）

- **用户三点**（m12206）：①「在模型选择下拉列表中不要显示『已就绪』」；②「OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL 模型还是没有读取到上下文」；③「模型选择列表需要再加宽 1.8 倍（有些模型名称很长）」。
- **第 2 点的真因（上一节 §44 的疏漏）**：§44 把读取键名从 `general.context_length` 改成 `<架构名>.context_length`，但**没升缓存版本**。GGUF 元数据缓存（`<配置目录>\gguf-meta-cache.json`）是 §43 加进来的：命中就**不再读模型文件**，而缓存条目是旧逻辑读空之后写下的 `context_length: None`。
  - 实测缓存（`E:\AI\llama.cpp-gui\gguf-meta-cache.json`，2864 字节，version=2，15 条）：该模型条目 `architecture=llama file_type=18 context_length=`（空），size/modified_ms 与真实文件完全一致 → 必然命中。
  - 修法：`src-tauri/src/models.rs` 的 `META_CACHE_VERSION` **2 → 3**，旧缓存整份作废，下次启动重读模型文件（这次能读到 `llama.context_length = 131072`）。
  - **教训（记牢）**：只要改的是「读 GGUF 的哪个键 / 读出来的字段含义」，就必须同步升 `META_CACHE_VERSION`；只加字段要升（§43），改键名同样要升（本节）。缓存命中时旧结论会被无限沿用。
- **第 1 点**：删掉菜单项里的状态字（`.bench-picker__state` 的 JSX 与 CSS 一并删除）。同一次改动里状态字本来就多余 —— 绿色已经表达「运行中」，文字只占宽度。
- **第 3 点**：`src/styles/components.css` 的 `.bench-picker__menu` 由 `left:0; right:0`（宽度=选择框宽）改为 `left:0; right:auto; min-width:180%` —— 展开的列表比选择框宽 1.8 倍，`OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL` 这类长名能整行显示。
- **验证**：`E:\tmp\preview-bench-fix8.png`（离线复现页，link 真实样式）—— 列表加宽后长名完整、运行中的模型名绿色、无状态字。复现页来自 `E:\tmp\repro-bench2.html`（用 pwsh 正则去掉 `pre#diag` 与 `<script>`）。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo test --lib gguf` 7 passed；`npm run tauri build` exit 0（日志 `target\build72.log`）。exe **9,800,192 B / 2026-10-16 23:08:15 / SHA256 前 16 位 `749E53410C41D673`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-ctxcache3`（上一版 `F90C05FEA7743D45`）。
- **仍未做**（与上游的差，同 §37–§44）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 46. 压测页：模型名称列 1.6 倍宽、下拉与文本框等宽（2026-10-16，用户 m12274）

- **用户要求**（m12274，逐字）：「模型选择的下拉列表不只是下拉，上面的文本框要一样宽，刚才的1.8倍太宽了，1.6倍吧，剩下的宽度，由3个文本框平分」。
- 上一节（§45）只把**展开的列表**加宽到 180%，选择框本身仍是 1fr —— 用户要的是**字段本身变宽**，列表跟着字段走。
- 改法（`src/styles/components.css`）：
  - `.bench-fields` 的 `grid-template-columns: repeat(4, minmax(0,1fr))` → `minmax(0, 1.6fr) repeat(3, minmax(0, 1fr))`：模型名称列 1.6 份，其余 3 个文本框平分剩下 3 份（即用户说的「剩下的宽度由 3 个文本框平分」）。
  - 窄屏（`@media (max-width:900px)`）同步从 `repeat(2, minmax(0,1fr))` → `minmax(0, 1.6fr) minmax(0, 1fr)`，保持同一比例。
  - `.bench-picker__menu` 删掉 `min-width: 180%`（`right` 回到 `0`）：列表宽度回到「等于字段宽」，与上面文本框严格对齐；字段本身已有 1.6 倍，长模型名照样放得下。
- **验证**：`E:\tmp\preview-bench-fix9.png` —— 模型名称文本框明显比其他三个宽，展开列表与它同宽，`OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL` 仍能整行显示。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build73.log`）。exe **9,800,192 B / 2026-10-16 23:15:27 / SHA256 前 16 位 `4EB0F1EA15942068`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-pickerwidth`（上一版 `749E53410C41D673`）。
- **仍未做**（与上游的差，同 §37–§45）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 47. 压测页六点：Strata 模型入下拉 / 表格改列加草稿命中率 / 列头加大 / 空表提示（2026-10-16，用户 m12318）

- **用户六点**（m12318）：① 模型选择列表里没有 Strata 的模型；② 删掉「从 8K 到模型上限逐档灌满输入，量预填充与解码速度。每档都要真跑一次生成，很慢。」这句；③ 逐次测量表删「模型名称」列、加「草稿命中率」列；④ 逐次测量表列头字体再大些；⑤ 空表时居中显示「选择档位并开始测试，结果会按此表逐项记录」；⑥ 表格最后一行不画下横线。
- **①** 原来 `models` 只来自 `configs.filter((c) => c.has_model)`（llama.cpp 的配置），Strata 常驻模型不在里面。改成 `useMemo`：llama.cpp 的 config 映射成 `{ id, name, maxContext }`，再把 `strataEntries`（`model_name` 非空）追加进去（`id` 用 `config_path`、上限用 `entry.max_context`）。两边的 id 都出现在前门合成的 `/v1/models` 里，所以运行状态标记（绿色）对 Strata 模型同样有效。
  - 注意：`configContext` 的取值从 `?.max_context` 改成 `?.maxContext`（字段被这个 useMemo 改了名）。
- **②** 删掉那一行 `<p className="st-hint">`（说明性文字，与「说明文字一律不显示」的口径一致）。
- **③** 表格列数不变（11 → 11）：删「模型名称」，在「实际输出」后插入「草稿命中率」。数据来自 llama.cpp `timings` 的 `draft_n` / `draft_n_accepted`（投机解码尝试数与接受数），命中率 = 接受 / 尝试；没开草稿或本轮没报就是 `null`，显示「—」。为此：
  - `src/api/chat.ts`：`ChatTimings` 加 `draftN` / `draftNAccepted`，`StreamChunk.timings` 加 `draft_n` / `draft_n_accepted`，解析处一并取值。
  - `src/utils/contextBenchmark.ts`：`ContextBenchmarkSample` 加 `draftAccept: number | null`。
  - `src/store.ts`：样本写入 `draftAccept = draftN > 0 && draftHits !== null ? draftHits / draftN : null`（避免除零）。
  - 单位行加 `草稿命中率: "%"`，数值按 `(value * 100).toFixed(1) + "%"` 显示。
- **④** `.st-table--nowrap th { font-size: var(--st-fs-sm); }`（全局 `.st-table th` 是 `--st-fs-xs` 12px，本页列头升到 13px）。用本页专用类，避免影响设置页那张表。
- **⑤** 空表行加 `className="st-table__empty"`，文案改「选择档位并开始测试，结果会按此表逐项记录」；CSS `.st-table__empty { padding: var(--st-s-5) 10px; text-align: center; color: var(--st-ink-muted); }`。
- **⑥** `.st-table--nowrap tr:last-child td { border-bottom: 0; }`（空表那一行也是 `last-child`，同样不画线）。
- **实施脚本**：`E:\tmp\bench_m12318.py`（5 个文件、16 处替换：逐行精确匹配 + 每处断言唯一命中 + 倒序应用；dry-run 后 `--apply`）。行数变化：`chat.ts` 238→246、`contextBenchmark.ts` 258→260、`store.ts` 1559→1563、`ContextBenchPanel.tsx` 504→520、`components.css` 901→918。
- **验证图**：`E:\tmp\preview-bench-fix11.png`（离线复现页，link 真实样式）：下拉里出现 `swift-1.5-iq3_xxs`（Strata）、说明句已消失、表格列头更大、数据行有「78.4% / 71.2%」、最后一行无横线。
- **门禁与部署**：`npx tsc --noEmit` exit 0（构建前单独跑过一次）；`npm run tauri build` exit 0（日志 `target\build74.log`）。exe **9,800,192 B / 2026-10-17 08:34:50 / SHA256 前 16 位 `3927D0ED45B43584`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-bench6`（上一版 `4EB0F1EA15942068`）。
- **仍未做**（与上游的差，同 §37–§46）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 48. 压测页：逐次测量去掉摘要行 + 单元格全部右对齐（2026-10-16，用户 m12430）

- **用户两点**（m12430）：① 取消逐次测量上方那段「OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL · 上限 128K · 2 次请求」；② 逐次测量的单元格全部右对齐。
- **①** 删掉 `ContextBenchPanel.tsx` 里那个 `<p className="st-hint">`（三目：`selected` → `模型 · 上限 · N 次请求`；没跑过 → `还没跑过 · 模型`；没选模型 → `先选一个模型`）。删掉后 `contextTierLabel` / `resultSamples` / `selected` 都还有别的用处，不会触发 `noUnusedLocals`。
- **②** `src/styles/components.css`：`.st-table--nowrap td` 加 `text-align: right`，`.st-table--nowrap th` 也加 `text-align: right`（列头跟着右对齐，否则列头与内容错开）。原来数字列专用的 `.st-table .num { text-align: right }` 保留，现在与整表一致。
  - **坑**：`.st-table--nowrap td`（0,1,1）特异性高于 `.st-table__empty`（0,1,0），会让第 5 点的空表提示（用户 m12318）从居中变右对齐。故把空表规则改成 `.st-table--nowrap td.st-table__empty`（0,2,1），保住居中。
- **验证图**：`E:\tmp\preview-bench-fix12.png`（离线复现页，link 真实样式）：摘要行消失、列头与数据行全部右对齐、最后一行仍无横线。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build75.log`）。exe **9,800,192 B / 2026-10-17 08:46:29 / SHA256 前 16 位 `2D3B22065D3A77ED`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-bench7`（上一版 `3927D0ED45B43584`）。
- **仍未做**（与上游的差，同 §37–§47）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 49. 压测页：草稿命中率列挪到「解码」后面（2026-10-16，用户 m12486）

- **用户要求**（m12486）：「草稿命中率要放在解码后面」。
- **改法**（`src/components/ContextBenchPanel.tsx` 三处，列数不变，仍是 11 列）：
  - 表头行：`草稿命中率` 从「实际输出」后移到「解码」后 → 顺序变成 档位 / 实际输入 / 实际输出 / 预填充 / 解码 / 草稿命中率 / 整卡显存峰值 / 最低空闲显存 / RAM 峰值 / 总耗时 / 状态。
  - 单位行数组：`["实际输入", "实际输出", "预填充", "解码", "草稿命中率", …]`（草稿命中率对应的单位仍是 `%`）。
  - 数据行：草稿命中率那个 `<td>` 从 `completionTokens` 之后移到 `decodeTokS` 之后。
- **验证图**：`E:\tmp\preview-bench-fix13.png`。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build76.log`）。exe **9,800,192 B / 2026-10-17 08:52:13 / SHA256 前 16 位 `A5EBD4CA75AFB239`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-bench8`（上一版 `2D3B22065D3A77ED`）。
- **仍未做**（与上游的差，同 §37–§48）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 50. 压测页：清空按钮看着无效 + strata 模型压测失败（2026-10-17，用户 m12533）

- **用户两点**（m12533）：① 「逐次测量表清空按钮无效」；② 「strata 模型 测试失败」。

- **修 1 · 清空看着无效**：`clearContextBench` 只把 `selectedId` 置 `null`，而组件里
  `const selected = modelHistory.find((r) => r.id === bench.selectedId) ?? modelHistory[0] ?? null;`
  —— `null` 会**回落到最近一份历史报告**，于是点完清空表格立刻又填满，看起来像按钮坏了。
  改法：`clearContextBench` 把 `selectedId` 置为**空串哨兵 `""`**，组件里判断
  `bench.selectedId === ""` 时直接 `selected = null`（不回落历史）；换模型时用一个 effect
  `select(null)` 把哨兵清掉，否则切到别的模型也是空表（会破坏用户 m11748 第 6 点「切模型显示该模型最近一次结果」）。
  语义确认：清空只清当前视图，历史报告仍在下拉里可重新选回来。

- **修 2 · strata 模型压测失败**：`runContextBench` 一进来就
  `({ maxContext } = await fetchChatModelProps(port, model));`，即 `GET /props?model=…`。
  llama.cpp 通道有这个端点（但发了会把模型拉起来，用户 m11407 反对）；**Strata 引擎没有这个端点**，
  前门把请求转给 9091 后拿到的是网页（日志里那次 `/props` 回包 10031 字节），JSON 解析失败 →
  `runContextBench` 直接抛错 → 整个压测失败，用户看到的就是「strata 模型测试失败」。
  改法：组件里已经从模型配置读到上限（`maxContext`），把它作为第三个参数
  `runContextBench(model, options, knownMaxContext)` 传下去；store 里
  `maxContext = knownMaxContext ?? null; if (maxContext === null) { 再问前门 }`。
  这样两类通道都不再发 `/props`。

- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build77.log`）。exe **9,800,192 B / 2026-10-17 09:03:23 / SHA256 前 16 位 `4B37739BEA611E4A`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`；备份 `llamacpp-gui.exe.bak-before-benchclear`（上一版 `A5EBD4CA75AFB239`）。
- **仍未做**（与上游的差，同 §37–§49）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 51. 压测页：strata 模型压测失败的真因 —— config 里的上限是字符串（2026-10-17，用户 m12533 / m12605）

- **现象**：上一轮（§50）把「启动时先发 `GET /props?model=…` 读上限」去掉、改从模型配置拿上限之后，strata 模型（`sc117-swift-iq2-xs`）压测仍然失败，报 `模型没报告有效的 max_context，无法核验安全的输入与输出预算`；而界面左上角「当前模型上限」正常显示 **200K**。
- **根因**：Strata 那边的上限是**字符串**。`StrataModelEntry.max_context` 的 Rust 类型是 `Option<String>`（`src-tauri/src/strata.rs:62`），config 里写的就是 `"204800"`。§50 把它原样塞进 `runContextBench` 的 `knownMaxContext`，而 `src/utils/contextBenchmark.ts` 的 `planContextBenchmarkTiers` 用 `Number.isSafeInteger(maxContext)` 校验 —— 字符串一律判无效，于是整批档位被 skip、抛第一条 reason。
  - **为什么界面看起来正常**：`contextTierLabel` 走的是算术（`tokens % 1024 === 0`、`tokens / 1024`），JS 会把 `"204800"` 隐式转成数字 → 显示 200K。于是出现「显示有上限、压测说没上限」的怪象。
- **证据链**（三条互相印证，缺一不可）：
  1. 用户重启后的日志 `E:\AI\llama.cpp-gui\logs\gui-20261017-090431.log` 里**没有 `/props` 请求** —— 说明已知上限确实传下去了，§50 的改动生效。
  2. 界面显示 200K —— 说明取到的值本身是 204800。
  3. 报错文本恰好是 `planContextBenchmarkTiers` 里 maxContext 无效那一支。
- **修法**：
  - `src/components/ContextBenchPanel.tsx` 新增**模块级非导出**函数 `toLimit(value: unknown): number | null`（`Number(...)` + `Number.isFinite(num) && num > 0`），llama.cpp 与 Strata 两条通道的上限都过它再进 `models`。非导出函数不影响 Fast Refresh（铁律 7 管的是「只导出组件」）。
  - `src/types.ts`：`StrataModelEntry.max_context` 由 `number | null` 改成 `string | number | null` —— 先前的声明与 Rust 的 `Option<String>` 不符，正是这个谎让类型检查没能拦住本 bug。
  - `src/components/StrataPanel.tsx`：`ctxMismatch` 的比较补 `Number(entry.max_context)`，否则字符串与运行时的数字永远不相等，会一直误报「上下文与运行时不一致，改了参数要重启才生效」。
- **教训**：跨语言边界的「数字」不可信 —— Rust 的 `Option<String>` 到了 TS 声明里被写成 `number | null`，编译器就再也帮不上忙；凡是要参与数值判断的字段，进前端后先归一化成数字。界面能显示不代表数据能算：显示路径走了隐式转换，判定路径没有。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build78.log`）。exe **9,800,192 B / 2026-10-17 09:11:12 / SHA256 前 16 位 `CE6F3E36729190F0`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-stratalimit`（上一版 `4B37739BEA611E4A`）。
- **仍未做**（与上游的差，同 §37–§50）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 52. 压测页：strata 通道 `Failed to fetch` —— 前门转发上游响应时没补 CORS 头（2026-10-17，用户 m12671）

- **现象**：§51 修好上限类型后重启，压测 strata 模型（`sc117-swift-iq2-xs`）仍然失败，这次表格里一行记录的报错是 `失败：Failed to fetch`，实际输入 / 输出 / 预填充 / 解码 / 总耗时全是 0，下面一行「遇到错误提前结束了」。
- **关键判据**：`Failed to fetch` 是浏览器的 `TypeError`，**不是任何 HTTP 状态码** —— 说明响应根本没到达 JS，是被浏览器拦掉的，而不是服务端返回了错误。
- **真因**：前门转发上游响应时是 `std::io::copy(&mut upstream, client)` **整段原样转**，不补任何头。llama.cpp / router 自己带 `Access-Control-Allow-Origin`，所以那条通道一直正常；**Strata 引擎是 Python `http.server`，响应里没有 CORS 头**。webview（`tauri://localhost`）直连 `127.0.0.1:9090` 算跨源，响应缺 CORS 头就被浏览器拦在响应到达 JS 之前 → 前端只看到 `Failed to fetch`。
- **实测证据**（`E:\tmp\probe_strata.py`，Python `urllib` 直发同一路径）：`POST http://127.0.0.1:9090/v1/chat/completions` → `status = 200`，`Content-Type: text/event-stream`，42 行 SSE，1.1 秒跑完，**响应头里确实没有 `Access-Control-Allow-Origin`**。`urllib` 不走 CORS，所以同一条请求在 Python 里成功、在 GUI 里失败 —— 这条差异就是定位的入口。
- **诊断顺序**（可复用）：① 先看错误字符串是 HTTP 错误还是浏览器 `TypeError`；② 用不走 CORS 的客户端（`urllib` / `curl`）直发同一 URL 复现，成功即说明是浏览器侧；③ 对比响应头里有不有 CORS 相关头；④ 再看这条通道是不是"上游自带 CORS"的那一类。
- **修法**（`src-tauri/src/strata_proxy.rs` 的 `forward`）：原来直接 `io::copy`，现在**先把上游响应头读出来**（复用现成的 `read_head`，它读到 `\r\n\r\n` 就停，不会把 body 一起吞掉），若头里没有 `access-control-allow-origin` 就插一条 `Access-Control-Allow-Origin: *` 再写给客户端，然后才 `io::copy` 剩下的 body。上游已带 CORS 头（llama.cpp）时不重复加。
- **教训**：前门是**手写的转发器**，它转发的不只是字节，还包括"浏览器能不能读"这件事。凡是靠上游自带头（CORS 就在这里）的路径，换一个上游（llama.cpp → Strata 引擎）就会静默失效，且症状是浏览器层的 `Failed to fetch`，服务端日志里一切正常 —— 排查时不要只看服务端。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0；`npm run tauri build` exit 0（日志 `target\build79.log`）。exe **9,801,728 B / 2026-10-17 09:19:11 / SHA256 前 16 位 `F1D1C3DF0C4E55A1`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-proxycors`（上一版 `CE6F3E36729190F0`）。
- **仍未做**（与上游的差，同 §37–§51）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 53. Strata 卡片状态抖动：加载成功后「运行中 → 已停止 → 运行中」闪一下（2026-10-17，用户 m12735）

- **现象**（用户原话）：「strata模型加载时，弹出模型加载成功后，模型卡显示运行中，然后会短暂的转到已停止状态，大概1秒后又变成运行中」。
- **卡片状态的来源**：`src/components/StrataPanel.tsx:837` `isRunning={runningFile === fileOf(e) && !!status.loaded}`，`runningFile` 由 `runningEntry`（`StrataPanel.tsx:733-742`）按 `status.config_path` 或 `/health` 报的 `model_name` 反查；`已停止` 是 `isRunning` 与 `busyState` 都为假时的兜底文案（`StrataPanel.tsx:202`）。所以抖动只可能来自 `strataStatus` 这一份快照。
- **为什么会有单轮坏数据**：`probeStrata()`（`src/store.ts`）每 5 秒无条件探测一次，`src-tauri/src/strata.rs` 的 `probe_with_timeout` 一旦 `/health` 请求失败就直接 `st.running = false; st.last_error = Some("端口无响应")` 提前返回 —— 引擎刚加载完模型那一两秒里偶有一轮不应答（或还回着 `loaded: false` 的旧状态），这一轮快照被整份 `set` 进去，卡片就闪成「已停止」，下一轮轮询又恢复。用户看到的「大概 1 秒」正是两次探测之间的空隙。
- **修法**（只在前端 `src/store.ts` 的 `probeStrata` 里去抖，不动 Rust 探测）：模块级加 `let strataMisses = 0;`，探测结果若在「本来在跑」的前提下退化（`!next.running` 或 `prev.loaded === true && next.loaded !== true`），先把 `strataMisses` 加一并在**第一轮直接 return**（保留旧快照），连续两轮都这样就采信新快照。用户主动停止走 `stopStrata()`（直接用 `ipc.strataStop()` 的返回值，不经过 `probe`），所以点停止依旧是立即变「已停止」。
- **代价**：外部启动的实例真挂了、或引擎自己 `model unloaded`（日志里 09:29:16 就有一次），卡片会晚一个轮询周期（5 秒）才显示「已停止」。权衡后接受：闪一下比重启后立刻显示更烦人。
- **为什么不改 Rust**：去抖需要跨轮次记住"上一轮说了什么"，那是 `probe` 这个无状态函数之外的进程级可变状态；放在 store 里天然有 `prev` 可取，改动面最小。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build80.log`）。exe **9,801,728 B / 2026-10-17 09:33:53 / SHA256 前 16 位 `A4EC5A6B3DC337EA`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-strataflicker`（上一版 `F1D1C3DF0C4E55A1`）。
- **仍未做**（与上游的差，同 §37–§52）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 54. 压测页四点：strata 曲线不腰斩（解释）+ 真停不延迟 + 清空=删记录 + 请求数翻倍（2026-10-17，用户 m13507）

用户四点，前一点是疑问、后三点要改：

1. **「strata 的不同档上下文，预填充和解码都没有和 llama.cpp 模型逐档腰斩」** —— 不是 bug，是两种引擎的物理不同，不改代码。
   - 数字确实来自引擎自报的 `timings`（`E:\AI\Strata\serve\server.py:4560 def request_timings(...)`，字段名照抄 llama.cpp：`prompt_per_second` / `predicted_per_second` / `draft_n` …），不是客户端按到达时刻估的，所以曲线是实测。
   - llama.cpp 稠密模型每个 token 都要把整份 KV cache 读一遍 → 显存带宽受限 → 吞吐 ∝ 1/上下文，翻倍就腰斩。
   - Strata 这边是 MoE 稀疏激活 + 专家缓存：33 GiB 专家驻内存、每步只走激活的少数专家（`--gpu-layers` 那 3905 个专家 / 5.26 GiB 显存），KV 分页；瓶颈是专家换入换出的 PCIe 开销（日志里 `+1.3% ~ +2.2% of the routed experts over PCIe`），与上下文长度基本无关。
   - 实测：prompt 8k→32k，解码稳定 82–94 tok/s；预填充约 1.5–1.6k tok/s（8k≈5 s、32k≈20 s，正好线性）。

2. **「实例真挂了、或引擎自己卸载模型，卡片晚 5 秒才显示已停止这个不行」** —— 撤掉 §53 的前端去抖，改在 Rust 探测里「立刻复探」：
   - `src/store.ts` 删掉 `let strataMisses = 0;` 与 `probeStrata` 里的连击判断，恢复 `set({ strataStatus: await ipc.strataProbe() });`。
   - `src-tauri/src/strata.rs` 新增 `const PROBE_RETRY_TIMEOUT: Duration = Duration::from_millis(800);`，`pub fn probe(port, api_key)` 改为：先 `probe_with_timeout(port, api_key, PROBE_TIMEOUT)`；`is_healthy(&first)`（`running && loaded == Some(true)`）为真直接返回；否则立刻用 `PROBE_RETRY_TIMEOUT` 再探一次并**无条件采信第二次**（它更晚，更接近真相）。
   - 为什么不等待下一轮：等 5 秒正是用户否定的行为；本机端口关闭是即时 RST，复探几乎不花时间，只有"进程僵住"才付第二个超时（800 ms）。
   - `loaded == None`（`/health` 答了但没这字段）也当不健康去复探 —— 引擎正在切换时就是这个样子。
   - 热路径安全性已核：`strata_proxy.rs:1007` 的 `strata::probe` 只针对当前要路由的那一个 `entry`，不是遍历全部 config，最多多探一次；`strata.rs:518` 的启动等待循环慢一点点无所谓。**前门合成 `/models` 走的 `probe_with_timeout` 没动**，不受影响（§3.1 的 6.1 秒教训仍成立）。

3. **「点击清空按钮后，逐次测量内容消失，但是按钮左侧的下拉列表中对应记录没有消失，应该是删除对应记录，然后自动显示剩下最近的记录」**：
   - `src/store.ts:232` 类型改为 `clearContextBench: (id?: string) => void;`；实现体（`clearContextBench(id)`）按 id `filter` 掉那条报告、`saveBenchHistory(history)` 落盘、`selectedId: null`，其余进度字段照旧归零。不传 id 时只清当前显示、不动历史。
   - `src/components/ContextBenchPanel.tsx` 按钮改 `onClick={() => clear(selected?.id)}`；同时删掉 §50 留下的 `selectedId === ""` 空串哨兵判断（store 不再写它，成了死代码）。
   - 删完 `selectedId` 为 `null` → 组件自然回落到 `modelHistory[0]`（这个模型剩下最近的一份），没有剩的就显示空表。

4. **「压测明明只跑了 2 个请求，为啥日志中是 4 个」** —— 是"每档最多发两次"的校准机制：
   - 首发送前按常量 `ESTIMATED_RECORD_TOKENS = 28`（`src/utils/contextBenchmark.ts:174`）估行数；拿到 `usage.prompt_tokens` 后若偏差 >5%（`needsAdjustment`），按比例改行数**再发一次**。2 档 × 2 次 = 4 次，其中每对里的第一次不产生表格行，所以监控里看着像 2 次。
   - 实证（`E:\AI\llama.cpp-gui\logs\gui-20261017-094039.log`）：09:44:29 首发 body 30536 字节 → 引擎报 `reading the prompt: 6,719 of 6,724 tokens`，比 8192 少 18% → 09:44:40 完成后重发 → 8,166 左右，两发各 11 秒，日志里正好两条 `done:`。
   - 改法：把这个模型实测的"每行多少 token"跨档传递。`estimateRecordLines(targetTokens, tokensPerLine)` 增加可选第二参；新增 `measureTokensPerLine(lines, actualPromptTokens)` 从实测 usage 反推；`src/store.ts` 的 `runContextBench` 里 `let tokensPerLine = ESTIMATED_RECORD_TOKENS;` 放在档位循环外，每次收到 `promptTokens` 就更新。首档仍可能校正一次，后面几档首发就够准，不再重发。
   - 顺带把界面右下角「N 个档位 · N 个请求」改成只写「N 个档位」——请求数本来就不由档位数决定，写死了等于骗人。
- **教训**：界面上承诺的数字（请求数）必须来自真实计划，不能由别的量（档位数 × 轮数）推算；估算常量只是首屏锚点，一旦有了实测就该传给下一次。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0；`npm run tauri build` exit 0（日志 `target\build81.log`）。exe **9,801,728 B / 2026-10-17 10:03:07 / SHA256 前 16 位 `888732CC63B51545`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-strataprobe2`（上一版 `A4EC5A6B3DC337EA`）。
- **仍未做**（同 §37–§53）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

### 55. Strata 卡片抖动（第二次）：慢探测晚返回盖掉新结果（2026-10-17，用户 m13709）

- **用户原话（m13709）**：「现在strata模型启动后模型卡还是有 运行中-已停止-运行中的 状态变化过程」——§53 的前端去抖、§54 的 Rust 复探都没修掉。
- **为什么前两次没修掉**：两次都只当成"一次探测说没跑"来处理（去抖一次 / 复探一次）。真正的机制是**时序错乱**：
  - `src/store.ts` 的 `probeStrata()` 由 `setInterval(…, 5000)` 驱动；而一次探测在引擎忙时要走 **首探 3 秒 + 复探 3 秒 = 6 秒**，比轮询周期还长。
  - 于是第 N 轮还没返回，第 N+1 轮已经发出。两者并发，各自 `set({ strataStatus })`。
  - 慢的旧探测（失败，`running=false`、`loaded=None`）**晚返回**，把快的成功结果覆盖掉 → 卡片 `!!status.loaded` 为假、`isLoading` 也不成立 → 「已停止」；下一次轮询又恢复「运行中」。用户看到的"约 1 秒"就是两次 set 之间的空隙。
- **另一处放大因素**：§54 把复探超时设成 `PROBE_RETRY_TIMEOUT = 800ms`，等于让复探在同一个忙窗口里再失败一次（首探已证明引擎 3 秒不应答，0.8 秒更不可能应答）。
- **改法（三处）**：
  - `src/store.ts`：新增模块级 `let strataProbing = false;`，`probeStrata()` 开头 `if (strataProbing) return;`，`finally` 里复位 —— 撞上就跳过这一轮，**永不并发**，从根上消除乱序覆盖。
  - `src-tauri/src/strata.rs`：复探改用与首探相同的 `PROBE_TIMEOUT`（3 秒），删除 `PROBE_RETRY_TIMEOUT`。真挂的实例是即时 RST，复探不花时间；只有半死状态才把两个超时用满。
  - `src-tauri/src/lib.rs` 的 `strata_probe`：探测本身不写日志，闪了也无从查证。新增"上一轮还在跑、这一轮退化"时向 GUI 日志补一行
    `[probe] Strata 探测退化：running=… loaded=… 原因=…`（`state.logs.push("system", …)` + `app.emit("logs://lines", …)`，与 `idle.rs:62` 同一套写法）。下次再闪，日志里就有引擎给不出的直接原因。
- **权衡**：跳过一轮意味着状态最多晚 5 秒刷新；用户主动停止走 `stopStrata`（直接用 `ipc.strataStop()` 的返回值），不经过探测，仍然立刻显示「已停止」（§55 仍满足 m13216 第 2 点）。
- **教训**：把"探测要多久"和"多久探一次"当成两个独立数字是错的 —— **探测耗时超过轮询周期就会并发**，而并发写同一个状态字段必然出现"旧结果覆盖新结果"。任何"定时 + 异步 + 单一状态槽"的组合都要先问一句：上一轮回来了吗。
- **门禁与部署**：`cargo check --release` exit 0；`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build82.log`）。exe **9,803,264 B / 2026-10-17 10:20:13 / SHA256 前 16 位 `0BD126B9EC8EB3D8`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-probeonce`（上一版 `888732CC63B51545`）。
- **仍未做**（同 §37–§54）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

---

### 56. 压测历史：从「全局 20 条」改成「每个模型各留 5 份」（2026-10-17，用户 m13838 / m13867）

- **用户先问存在哪**（m13838）：逐次测量的记录保存在前端 `localStorage`，键 `llamacpp-gui-bench-history`，物理上落在 WebView2 数据目录 `E:\AI\llama.cpp-gui\webview\EBWebView\Default\Local Storage\leveldb\`（跟着**部署目录**走，不是 `%LOCALAPPDATA%`）。没有列表文件、不经后端。`trimBenchReport` 存前清空每条样本的 `output`（表格/图表都不用，留着白占配额）。
- **发现的问题**：`loadBenchHistory` / `saveBenchHistory` 都是 `history.slice(0, 20)` —— **全局 20 条，不分模型**。跑得多的模型会把别的模型的记录挤掉（3 个模型各跑 7 轮＝21 条，最早的先没）。
- **用户选择**：每个模型各留 3~5 条（选 5）。
- **改法**（`src/store.ts`）：新增 `const BENCH_HISTORY_PER_MODEL = 5;` 与 `pruneBenchHistory(history)` —— 按 `startedAt` 新→旧排序，用 `Map<model, report[]>` 分组，每组满 5 条就跳过该条，最后 `Array.from(byModel.values()).flat()` 再按时间新→旧排一次。读入（`loadBenchHistory`）和写入（`saveBenchHistory`）都过它，所以**旧数据重新加载时会按新规则裁一遍**：某个模型攒了十几份会被削到 5 份，别的模型的不受影响。
- **显示侧未改**：`ContextBenchPanel.tsx` 的 `modelHistory = bench.history.filter((r) => r.model === model)` 本来就是按当前模型筛，裁剪后只是下拉里最多 5 项。
- **清空路径不受影响**：`clearContextBench(id)` 删掉一条后照样走 `saveBenchHistory`，该模型剩下的条数原样保留。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build83.log`）。exe **9,803,264 B / 2026-10-17 10:38:12 / SHA256 前 16 位 `7AC34F75C8881E2F`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-benchpermodel`（上一版 `0BD126B9EC8EB3D8`）。
- **仍未做**（同 §37–§55）：「复制图片」按钮（canvas 导 PNG）、A/B 对比面板。

---

### 57. 压测页补齐上游两个缺口：「复制图片」与 A/B 对照（2026-10-17，用户「继续下一步」）

上游 `strata-manager` 的 `ContextBenchmarkPage` 比本工程多两块：图表导出成图片、两份报告并排对照。本轮补齐。**这是 §37–§56 一路记下来的「仍未做」两条的最后收尾。**

- **复制图片**（新文件 `src/utils/benchImage.ts`，391 行，移植上游 `contextBenchmarkImage.ts`）
  - `createBenchImage(report, root): Promise<Blob>`：抓 `root` 里的三个 `.st-chart`，把每个 SVG 的 computed style 逐条内联（`SVG_STYLES` 25 个表现属性）、去掉 `class`、强制换成系统字体（SVG 塞进 `<img>` 后读不到页面 CSS 与 web font），序列化 → Blob URL → `Image`（15 秒超时）→ 画到 canvas → `toBlob` 出 PNG。
  - **快照必须在第一个 `await` 之前抓**（`captureCharts(root)` 在函数最开头同步调用），否则用户在导出过程中切页，会画出一半的图。
  - 版面：宽 1600，标题「llama.cpp GUI · 上下文档位实测」+ 4 行元信息（模型 / 配置 / 时间·状态·用时 / 上限·输出上限·轮数·超时）+ 三张图表 + 表格（档位 / 轮次（`rounds > 1` 才出）/ 实际输入 / 实际输出 / 预填充 / 解码 / 草稿命中率 / 整卡显存峰值 / 最低空闲显存 / RAM 峰值 / 总耗时 / 状态，列宽按权重分配）+ 脚注（含 `report.skipped` 的跳过原因）。失败行标红、已停止标黄，`sample.error` 折行画在行内下方。
  - 缩放 `scale = Math.min(2, MAX_EDGE/width, MAX_EDGE/height, √(MAX_PIXELS/(width*height)))`，`MAX_EDGE = 8192`、`MAX_PIXELS = 32M` 是浏览器 canvas 上限，超了会**静默出白图**，所以 `scale < 1` 直接抛「结果太大，单张图片放不下」。中文按字符宽度折行（`wrap`），不能用空格断词。
  - 主题色从 `root.closest(".page-fill")` 读 CSS 变量（`--st-bg` / `--st-surface` / `--st-surface-2` / `--st-ink` / `--st-ink-muted` / `--st-line` / `--st-danger-text` / `--st-warn-text`），带浅色兜底 —— 满足铁律 8（不写 hex 字面值在 CSS 里；canvas 读变量不算）。
  - 按钮在「各上下文档位实测」标题行右侧；`disabled` 条件＝压测中 / 生成中 / 没选中报告 / 该报告没有样本。点了先试 `navigator.clipboard.write([new ClipboardItem({'image/png': blob})])`，成功 `setNotice("图片已复制到剪贴板")`；WebView2 不给权限或不是安全上下文时**退回全屏预览**（`.bench-image` 遮罩 + `<img>`，右键另存），按钮承诺的是「图能拿走」，不是「一定进了剪贴板」。
- **A/B 对照**（新文件 `src/utils/benchCompare.ts` + 面板 UI）
  - `compareBenchReports(left, right): CompareRow[]`：两边 `targetTokens` 取并集升序，每个档位各出一份 `ComparableTier`（`samples` 成功次数 / `promptTokens` / `prefillTokS` / `decodeTokS` / `wallMs` / `draftAccept` 的**成功请求均值**，全失败或没跑过则 `null`）。缺失值一律 `—`。
  - **没有「谁更快」的结论**：上游会先核验测量身份（同一台机器 / 同一模型文件 / 同一参数）再下判断，本工程的 P4 监控采集层还没落地，报告里没有身份字段，所以只并列展示数字，脚注写的是方法而非「条件匹配」。
  - **对照是跨模型的**（用户 m14163「A/B对比应该对比不同模型」）：`compareReport` 从 `bench.history` 找而不是 `modelHistory`，下拉选项也来自全部历史；只有 `compareId === selected.id` 时视为没选（避免自己比自己），换模型后对照依然有效。上一版把它限成「同一模型的其他记录」，方向就错了 —— 同一模型的两次结果差的是噪声，不同模型之间才看得出该选谁。
  - UI：「逐次测量」标题行多一个 `#cb-compare` 下拉（只在「不压测 + 选中了报告 + 全部历史多于一份」时出现，选项排除当前这份，默认「不对照」）；选项文案是 `模型 · 时间 · 状态`，**模型名放最前**——下拉宽度有限，模型名放到后面会被截断到只剩半个，等于没说。选中后在逐次测量表下面多一张对照表：档位（`rowSpan={2}`）/ 模型（`A · sc117-swift-iq2-xs`、`B · OpenBMB/MiniCPM-V-4.7-1B`）/ 实际输入 / 预填充 / 解码 / 草稿命中率 / 总耗时 / 成功次数；对照表标题也带对照那份的模型名。
- **顺手修的**：`ContextBenchPanel.tsx` 里 `const start = () => {` 曾被一次编辑把行尾 `\n` 吃掉、和下一行粘成一行；改回。教训同 §2 的补丁惯例：`old_string` / `new_string` 要保留同样的行尾换行。
- **验证方式**（这个工具只在运行时跑，`tsc` 证明不了）：把 `benchImage.ts` + `contextBenchmark.ts` 拷到 `E:\tmp\benchimg\`，写 `entry.ts` 造一份两档假报告（8K 成功 / 32K 失败 + 一条 skipped）、自建三个 `.st-chart`，用 esbuild 打成 IIFE bundle，套一个 link 真实 `tokens.css` + `components.css` 的 HTML，Edge headless 截图 —— 导出的 PNG 排版、颜色、折行、红色失败行、脚注全部正确。A/B 对照表用 `E:\tmp\repro-bench2.html` 静态复现验证版面。
- **门禁与部署**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build84.log`）。exe **9,806,848 B / 2026-10-17 10:51:24 / SHA256 前 16 位 `EC7C14851D1D96CD`**，已部署 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（src 与 dst 一致）；备份 `llamacpp-gui.exe.bak-before-benchimage`（上一版 `7AC34F75C8881E2F`）。
- **跨模型对照（build85，同日随用户 m14163 追改）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build85.log`）。exe **9,807,360 B / 2026-10-17 11:10:30 / SHA256 前 16 位 `D17D91724219CA16`**，已部署；备份 `llamacpp-gui.exe.bak-before-comparecrossmodel`（上一版 `EC7C14851D1D96CD`）。
- **对照下拉改成自绘（build86，用户 m14248）**：原生 `<select>` 的展开列表由系统画，`text-align` / 展开方向都改不了，所以对照下拉换成自绘的 `.bench-picker`（复用模型下拉那套），菜单加 `.bench-picker__menu--right`：`left: auto; right: 0; width: max-content; min-width: 100%; max-width: 420px` —— 右边沿贴住按钮、向左扩。**向右扩会顶出面板**，选项里带模型名比 260px 的按钮宽得多。同一轮把对照表「模型」列改成列头居中、内容左对齐（`.st-table--compare th:nth-child(2)` 居中、`td:nth-child(2)` 左对齐，特异性 (0,2,1) 压过 `.st-table--nowrap td` 的 (0,1,1)）；整表其余列仍是右对齐（m12430）。
- **门禁与部署（build86）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build86.log`）。exe **9,806,848 B / 2026-10-17 11:20:04 / SHA256 前 16 位 `DBB4ADC525E26731`**，已部署；备份 `llamacpp-gui.exe.bak-before-comparealign`（上一版 `D17D91724219CA16`）。
- **「清空」与下拉拉开间距（build87，用户 m14323）**：清空按钮是删记录，紧贴下拉容易误点，给按钮加 `.bench-clear { margin-left: var(--st-s-4) }`，与左侧下拉的总间距从 8px 变成 24px。门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build87.log`）。exe **9,806,848 B / 2026-10-17 11:24:23 / SHA256 前 16 位 `5B908A70693456F3`**，已部署；备份 `llamacpp-gui.exe.bak-before-cleargap`（上一版 `DBB4ADC525E26731`）。
- **对照表模型列对齐砸错格子（build88，用户 m14377）**：A 行有「档位」格（`rowSpan={2}`），B 行没有，于是 B 行的模型格是 `nth-child(1)`、后面各格全体前移一格 —— 原来那条 `td:nth-child(2) { text-align: left }` 落到 B 行的「实际输入」上，模型名反而按整表默认右对齐，看上去 B 整行错位。改成给单元格挂类 `.bench-compare__model`，CSS 用 `.st-table--compare .bench-compare__model { text-align: left }`，与 DOM 序号彻底解耦。**教训：`nth-child` 只适合「每行列数一致」的表；一旦有 `rowSpan`/`colSpan`，按序号选列必然错位，必须挂类或 `data-` 属性。** 门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build88.log`）。exe **9,806,848 B / 2026-10-17 11:32:02 / SHA256 前 16 位 `CBF1D12EDBB1F18E`**，已部署；备份 `llamacpp-gui.exe.bak-before-comparemodel`（上一版 `5B908A70693456F3`）。
- **两个下拉统一成自绘（build89，用户 m14447）**：「逐次测量」那一行有历史下拉（原生 `<select id="cb-history">`）和对照下拉（自绘 `.bench-picker`），并排时箭头一个是系统三角、一个是 FA chevron，展开列表也是一个系统默认、一个向右扩。把历史下拉也换成 `.bench-picker`：状态加 `historyOpen`，按钮内 `<i className="fas fa-chevron-down" />`，菜单用 `.bench-picker__menu--right`（与对照下拉同一条规则），选项加 `is-on` 表示当前选中 —— 箭头、选中态、展开方向三样统一。历史上原本塞在选项里的模型名去掉了（`modelHistory` 本来就只含同一个模型，重复显示还会把文字挤到截断）。`#cb-history` 这个 id 全仓已无引用。门禁与部署：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build89.log`）。exe **9,807,360 B / 2026-10-17 11:44:15 / SHA256 前 16 位 `B780969A7A4DAF58`**，已部署；备份 `llamacpp-gui.exe.bak-before-pickerunify`（上一版 `CBF1D12EDBB1F18E`）。
- **仍未做**：上游那张「一个白卡里装标题行 + 图表 + 逐次测量 + 表格」的整体卡片（本工程拆成两张 `.panel`，见 §37）；显存/内存峰值三列仍可能是 `—`（等 P4 采集层）。

### 58. 压测页照上游重做三处：运行态按钮 / 实时测试进度 / A/B 独立卡（2026-10-18，用户 m01745）

用户说「参照上游」提了三点。上游文件是 `E:\Code\strata-manager-main\apps\desktop\src\pages\ContextBenchmarkPage.tsx`（配套 `benchmark.css`）。

- **①「开始测试」启动后的形态（上游 :121）**：运行时按钮整个换掉 —— 左边 `role="status"` 的转圈图标 + 已用秒数（`(elapsedMs/1000).toFixed(1) s`，`font-variant-numeric: tabular-nums` 防抖位），右边「停止测试」按钮用危险色（`--st-danger-text`），点下去文案先变「正在停止」并 disabled，等本次请求收尾后 `useEffect(() => { if (!bench.running) setStopping(false); }, [bench.running])` 复位。图标沿用工程里已在用的 `fa-spinner fa-spin`（`.fa-spin` 定义在 `src/styles/legacy/index.css:3040`）与 `fa-stop`，没有引入 lucide。
- **②进度卡（上游 :140）**：标题从「进度」改成「实时测试进度」；内容从三行 hint 改成一行 —— `strong` 大字显示当前档位（`bench.currentTier === null` 时显示「正在核验服务与输入」），后面跟「完成 N / total」「失败 N」「已停止 N」三个计数；下面一条细进度条 `<progress class="st-progress">`。**删掉了百分比和「第 n / M 次请求」**：上游没有这两个，用时也挪到按钮旁边了。`pct` 变量随之删除。
- **③A/B 对比拆成独立卡（上游 :152）**：原来对照下拉挤在「逐次测量」标题行里、对照表挂在那张卡的表格下方。现在整块移出，独立成 `A/B 对比` 卡片，卡内两栏下拉：
  - **对照模型**（用户要求的「第一个选模型」）：候选来自 `historyModels`（`bench.history` 里去重后的模型名，新→旧）。
  - **对照记录**（「第二个选该模型的测试记录，默认最近一份」）：候选来自 `compareCandidates`，即该模型的历史记录里排除当前这份 A；默认取第一条 = 最近一份（`history` 新的在前），所以不需要额外 state 记住「默认选哪个」。
  - 派生：`compareReport = compareCandidates.find(r => r.id === compareId) ?? compareCandidates[0] ?? null`。因此 `compareId` 为空串时自动落到该模型最近一份，旧 UI 里那个「不对照」选项随之取消（语义已变，留着会自相矛盾）。
  - 防退化：`compareCandidates` 在「该模型只有 A 一条记录」时会回退整张 list，此时 B 与 A 是同一份，表格上下两行完全一样且没有意义 —— 卡片渲染条件里加了 `compareReport.id !== selected.id` 把它挡掉。
  - 换模型时 `setCompareId("")` 一并清掉：不清的话旧记录 id 在新模型下悬空。
  - 跨模型默认（沿用用户 m14163）：`compareModelName = compareModel || historyModels.find(m => m !== model) || model` —— 默认选「第一个不是当前模型的」有记录的模型，只有单模型历史时才退回自己。
- **样式（`src/styles/components.css`）**：新增 `.bench-run`（转圈 + 停止按钮一行）、`.bench-status`（灰字 + tabular-nums）、`.bench-stop`（危险色，必须写在 `.st-btn--secondary` 之后才盖得过它的 `color`）、`.bench-live`（大字档位 + 计数，`gap: var(--st-s-2) var(--st-s-5)`）、`.bench-fields--compare`（两列等宽、`max-width:720px`，不占满整行）。全部取 token，无字面量。
- **门禁与部署（build90）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build90.log`）。exe **9,807,360 B / 2026-10-18 13:29:26 / SHA256 前 16 位 `D57C30229024FF0C`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-benchcards`（上一版 `B780969A7A4DAF58`）。
- **仍未做**（同 §37–§57）：上游那张「标题行 + 图表 + 逐次测量 + 表格装进一个白卡」的整体卡片；显存/内存峰值三列仍可能是 `—`（等 P4 采集层）。

### 59. 压测页收尾：控件并到标题行 / A/B 提示删除 / 三张图照上游分色（2026-10-18，用户 m01993 / m02036）

用户三点（m01993）加一句图表的（m02036：「预填充、解码速度、请求耗时的绘制都要参考上游修改」）。

- **① 控件并进「各上下文档位实测」标题行**：上游把这两个控件挂在 Panel 的 `action` 槽（`ContextBenchmarkPage.tsx:141`），顺序是**先「复制图片」再历史下拉**；「逐次测量」在上游只是个 `h3` + `span`（`:148`），没有任何控件。本工程照此把历史下拉从「逐次测量」行挪到「各上下文档位实测」行右侧，顺序为「复制图片 / 历史下拉 / 清除记录」，逐次测量行只剩「图表：成功请求的档位均值」这句 hint。两个按钮去掉 `st-btn--sm`，回到标准 `.st-btn`（上游 `official/components.css:105` 的标准按钮高 42px、`padding: 0 18px`；本地 `.st-btn` 是 40px、小号 32px —— 去掉小号就够贴近上游体量，没必要为一个页面改全局 token）。「清空」改名「清除记录」。
- **② 删掉 A/B 卡的说明句**：`A＝当前这份 · B＝下面选的那份 · 都取成功请求的档位均值` 整行移除，标题行只剩「A/B 对比」。
- **③ 对照模型下拉宽度 = 模型名称下拉宽度**：删掉 `.bench-fields--compare`（两列等宽 + `max-width:720px`），A/B 卡两个字段直接复用 `.bench-fields`（`minmax(0, 1.6fr) repeat(3, minmax(0, 1fr))`）—— 第一列同样是 1.6fr，宽度与「测试计划」里的模型名称一模一样，且没有新增任何 CSS。
- **④ 三张图照上游 `ContextBenchmarkCharts.tsx` 对齐**（差异都在 `src/components/ContextBenchCharts.tsx` 与 `components.css` 的 `.st-chart*` 段）：
  - **三张图分色**（上游 `benchmark.css:137-139`）：预填充 `color-mix(in srgb, var(--st-accent) 65%, black)`、解码 `--st-accent`、请求耗时 `--st-info`。做法：`section` 加 `st-chart--${metric.key}` 修饰类，`.st-chart__svg` 的 `color` 由修饰类决定；`.st-chart__line` 改成 `stroke: currentColor`、删掉原来写死 `--st-accent` 的 `.st-chart__area` —— 否则 `currentColor` 永远被那两条规则压掉，加了类也不变色。
  - **空态不标刻度数字**：上游 `:60` 的刻度 `<text>` 带 `rows.length > 0` 条件，本工程原来无条件渲染，空态图上会挂 0 / 0.3 / 0.7 / 1 这种没意义的数字。
  - **数值格式**：上游 `:24` 用 `value.toLocaleString(language, { maximumFractionDigits: 1 })`，本工程是 `toFixed(1).replace(/\.0$/, "")` —— 少千分位（`6313` 该显示 `6,313`）。改成 `toLocaleString("zh-CN", { maximumFractionDigits: 1 })`，`labelWidth` 与轴标签跟着对上。
  - **线宽不随缩放变粗**：折线补 `vectorEffect="non-scaling-stroke"`，网格线补 `vector-effect: non-scaling-stroke`；SVG 补 `overflow: visible`（上游 `benchmark.css:140`）。
  - **字号**：标题 13→14px（上游 15px，本地 token 无 15）、单位 12→13px、数值 12→13px 且 `font-weight: 500`、档位标签 12→13px（上游 `benchmark.css:142-144`）。卡片内边距照上游 `18px 16px 6px` 改成上/左右 16px、下 8px（档位标签自带 58px 空隙，底部不需要那么多留白）。
- **验证**：`E:\tmp\benchchart\` 用 esbuild 把**真实组件** `ContextBenchCharts` 打包渲染假数据（8K/32K/64K/128K），Edge headless 截图 —— 三张图分别呈现深绿 / 绿 / 蓝，刻度数字、档位标签、数值标签正常（`E:\tmp\preview-charts.png`）。版面另用 `E:\tmp\repro-bench2.html` 静态复现（`E:\tmp\preview-bench-fix24.png`）。
- **门禁与部署（build91）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build91.log`）。exe **9,807,360 B / 2026-10-18 21:25:58 / SHA256 前 16 位 `03A6CDE14B3B2D22`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-benchheadrow`（上一版 `D57C30229024FF0C`）。
- **仍未做**（同 §37–§58）：上游那张「标题行 + 图表 + 逐次测量 + 表格装进一个白卡」的整体卡片；显存/内存峰值三列仍可能是 `—`（等 P4 采集层）。

### 60. 新增「场景测试」页 + 性能测试页双标签（2026-10-18，用户 m02216 及其后三点）

用户要求：性能测试页工具栏参照「模型列表」页做标签切换（「上下文挡位测试」/「场景测试」）；场景测试页照上游 `ScenarioBenchmarkPage.tsx` 移植，卡内加模型下拉，把上游的「历史与升级对照」换成本工程自己的 A/B 对比。

- **标签切换（`src/components/BenchPanel.tsx`）**：`type BenchTab = "context" | "scenario"`，`useState<BenchTab>("context")`（不持久化，与模型列表页一致）。`.top-actions` 里放 `.st-tabs[role=tablist]`，按钮 `.st-tab` / `.is-active`，`role="tab"` + `aria-selected`；内容 `{tab === "context" ? <ContextBenchPanel/> : <ScenarioBenchPanel/>}`。两个子面板各自保留 `page-fill page-fill--scroll` 根，不新增包裹层（否则 `.page-fill--scroll > .panel` 的 padding/margin 失配）。
- **纯逻辑（新文件 `src/utils/scenarioBench.ts`）**：照上游 `packages/core/src/benchmark-suite.ts` 移植，**只保留 suite（一次性串行套件）模式，删掉 stress 模式**。导出 `ScenarioId` / `SCENARIOS`（短问答、代码审查、长输入、长输出、缓存复用、多轮对话、自定义）/ `scenarioLabel` / `ScenarioBenchOptions` / `DEFAULT_SCENARIO_BENCH_OPTIONS`（对齐上游 `:18-23`：rounds 1、maxTokens 256、inputChars 8192、conversationTurns 3、timeoutMs 120_000、mode unique、warmup false、stopOnError false）/ `validateScenarioBenchOptions`（rounds 1–20、maxTokens 16–4096、inputChars 1024–131_072、conversationTurns 2–10、timeoutMs 1000–600_000）/ `plannedPerScenario` / `estimateScenarioRequests` / `longInputPrompt` / `scenarioPrompt` / `scenarioMessages` / `summarizeByScenario` / `summarizeOverall`（p95 线性插值，与上游同算法）/ `compareScenarioReports` / `scenarioCsv` / `scenarioJson` / `formatDuration`。
  - **已知降级**：上游用 `POST /v1/messages/count_tokens` 精确数 token，llama.cpp 没这个端点 → 长输入按字符估算，真实 token 以响应 `usage` 为准（与 `utils/contextBenchmark.ts` 同一套办法）。
  - `mode === "repeat"` 时每轮发完全相同的输入，才测得出前缀缓存；`unique` 追加「（第 N 轮）」。
- **store（`src/store.ts`）**：新增 `ScenarioBenchState`（`running / current{scenario,round,total} / completed / failed / cancelled / total / startedAt / samples / history / selectedId / error`）与 `runScenarioBench` / `cancelScenarioBench` / `clearScenarioBench` / `selectScenarioBench`；`scenarioAbort` 与 `benchAbort` 分开。历史落 localStorage key `llamacpp-gui-scenario-bench-history`，`SCENARIO_HISTORY_PER_MODEL = 5`（与上下文档位压测同口径，用户 m13867），落盘前用 `trimScenarioReport` 清掉每条的 `output` 免爆配额。
  - 执行顺序：场景 → 轮 → 对话轮；`passes = warmup ? 2 : 1`，pass 0 为热身且不计入汇总；每跑完一条就 `sync()` 更新计数，界面实时出结果。
  - 速度一律取 llama.cpp 回传的 `timings`（`promptPerSecond` / `predictedPerSecond`），纯计算时间、不含排队与转发；`ttftMs` 用 `ttfbMs`。
  - 用户取消不弹错误（`error: cancelled ? null : ...`）。
- **图表（新文件 `src/components/ScenarioBenchCharts.tsx`）**：`RequestDotPlot`（逐次请求点图，含均值虚线、失败画红 X、当前点红点 r=4.5）与 `ScenarioColumns`（按场景柱图）。手写 SVG 而非引图表库——上游就是手写，且导出 PNG 需要表现属性内联。首尾标签与首尾数值标签都改成 `textAnchor` 起点/终点对齐，否则会压到 y 轴刻度（截图亲见 `60` 与 `52.4` 重叠）。
- **面板（新文件 `src/components/ScenarioBenchPanel.tsx`）四张卡**：① 测试计划（7 个场景勾选 + **卡内模型下拉**（用户第 2 点；上游靠外部选中的 profile，本工程没有这个概念）+ 每场景轮数 / 最大输出 token / 输入字符数 / 多轮对话轮数 / 每次超时 / 输入模式 + 先热身一次 / 出错即停 + 「N 条请求」）；② 实时测试进度（当前场景 + 第 N 轮 + 完成/失败/已停止 + `<progress>`）；③ 测试结果（导出 CSV / 导出 JSON / 历史下拉 / 清除记录 + 5 个大数字 + 4 张图 + 按场景表 + 逐条请求表（限高滚动、表头吸顶、只显示最近 100 条，导出带全部）+ 条件表）；④ **A/B 对比（取代上游「历史与升级对照」，用户第 3 点）**：对照模型 / 对照记录两个自绘下拉 + 8 列对照表，跨模型比较（沿用用户 m14163）。
- **样式（`components.css` 末尾 +213 行）**：全部 `.scenario-*` 新类，全取 token。注意 `.bench-fields.scenario-fields` 是 `repeat(auto-fit, minmax(150px, 1fr))` —— 7 个字段挤四列太窄，改用上游 `scenario-settings` 的自适应列。**踩坑**：柱子本身带 `.scenario-column` 类，CSS 若写成 `.scenario-column rect` 就永远不匹配、SVG 默认 `fill` 变全黑；正确写法是 `rect.scenario-column`。
- **验证**：`E:\tmp\scenariorepro\index.html` 用真实 CSS + esbuild 打包真实图表组件（`target/scenario-entry.tsx` 临时入口，构建前删除）静态复现整页，Edge headless 截图 —— 标签栏、勾选块、三卡、柱图/点图配色与失败标记、按场景表、逐条请求表均正常（`E:\tmp\preview-scenario4.png`）。
- **门禁与部署（build92）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build92.log`）。exe **9,815,552 B / 2026-10-18 21:47:25 / SHA256 前 16 位 `06D8F4DB013E00BD`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-scenario`（上一版 `03A6CDE14B3B2D22`）。
- **仍未做**（同 §37–§59）：上游那张「标题行 + 图表 + 逐次测量 + 表格装进一个白卡」的整体卡片；显存/内存峰值三列仍可能是 `—`（等 P4 采集层）；上游 stress（并发阶梯）模式与 `ConcurrencyLadder` 未移植。

### 61. 场景测试页收尾：测试计划卡照上游、模型下拉上标题行、性能测试标签跟着页标题（2026-10-18，用户 m02426 / m02461 / m02495）

用户三点（m02426）：① 场景测试第一张卡「测试计划」参照上游样式；②「测试计划」右边给一个选模型的下拉文本框；③ 这个下拉与上下文挡位测试页统一样式。另两点：性能测试的两个标签要跟着「性能测试」标题（m02461，之前被 `.top-actions` 的 space-between 顶到最右），以及标签文案「上下文挡位测试」改成「上下文挡位」（m02495）。

- **标签位置（`src/components/BenchPanel.tsx`）**：`.st-tabs` 从 `.top-actions` 里移出来，改成 `.top-bar` 的直接子元素 —— `src/styles/app.css` 里已有 `.top-bar > .st-tabs { margin: 0 auto 0 var(--st-s-3); }`（设置页引擎标签就是用这条贴着标题推左），放进 `.top-actions` 才会被 space-between 推到最右。
- **模型下拉挪到标题行**：从 `.bench-fields` 第一格移到 `.bench-head__right`，复用上下文挡位测试那套 `.bench-picker`（`.bench-picker__button` + `.bench-picker__name` + `fa-chevron-down` + `.bench-picker__mask` / `.bench-picker__menu--right`，选项 `is-on` / `is-running`），右侧再跟一个状态徽章（`.st-badge`，`loaded` 时加 `.st-badge--ok`），文案走文件内 `MODEL_STATE_TEXT`（已就绪/加载中/未启动/已休眠/下载中/加载失败，前门没起则「前门未运行」）——和上下文挡位测试同一个口径（用户第 3 点）。
- **卡内重排（照上游 `ScenarioBenchmarkPage.tsx`）**：新增「测试场景」小标题行 + 右侧 `{N} / {MAX_SCENARIOS} 已选`；场景胶囊改成自绘勾选框（原生 `input` 隐藏，`span.scenario-scenario__check` 画方块，勾用 `::after` 两条 border 旋转 45° 画，选中态 `:has(input:checked)` 转 accent）——不用图标字体，避免 FA 版本差异；字段改名照上游用词：测试轮数 / 每轮最大输出 token / 长输入字符数 / 连续对话轮数 / 每轮超时（秒）/ 输入模式（变化输入 · 重复输入 · 测前缀缓存）。
- **页脚重排**：左边 `.scenario-plan-hints`（两个开关「每个场景先预热一次」「发生错误后停止」+ 灰字「超时或模型变化总会停止整组测试」+ 模型没就绪时「请先启用服务并等待模型就绪」），右边 `.scenario-start`（`strong.scenario-budget` 显示「N 个测量请求」+ 主按钮「开始测试」；运行中换成转圈 + 已用秒数 + 「停止测试」）。`.scenario-plan-footer` 的 `align-items` 由 `center` 改 `flex-end`，让预算与按钮跟开关块底对齐。
- **不因模型没就绪禁用开始测试**：上游是 `!online || disabled || !loaded || !!validation`，但本工程走前门按需加载（`/v1/chat/completions` 带模型名即路由并加载），且上下文挡位测试也只 gate `bench.running || tooSmall || tooBig`；这里定成 `disabled={!model}` + 未就绪提示，两页口径一致（这是与上游的有意差异）。
- **验证**：`E:\tmp\scenariorepro\index.html` 重写（上一版被 `Set-Content -NoNewline` 拼成单行、且 splicing 时 `.panel` 套了两层，导致卡片贴在一起、锚点全部失配——教训：多行内容别用 `-NoNewline` 写，按行拼接要断言不重叠），用真实 CSS 静态复现整页，Edge headless 截图确认：标签紧跟「性能测试」右侧、三卡 20px 间距正常、模型下拉与状态徽章在标题行、场景胶囊与「5 / 7 已选」、六字段、页脚开关与右侧预算+按钮均到位（`E:\tmp\preview-scenario6.png`）。`npx tsc --noEmit` exit 0。
- **门禁与部署（build93）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build93.log`，GUI 未占用 exe，构建完直接部署）。exe **9,816,064 B / 2026-10-18 22:27:10 / SHA256 前 16 位 `6F4318A342F6B283`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-scenario2`（上一版 build92 `06D8F4DB013E00BD`）。
- **仍未做**（同 §37–§60）：上游整张白卡；显存/内存峰值三列仍可能是 `—`；上游 stress（并发阶梯）模式与 `ConcurrencyLadder` 未移植。

### 62. 场景测试两处对齐：模型下拉与上下文挡位等宽、两个勾选框改开关（2026-10-18，用户 m02593）

用户两点：① 场景测试的模型下拉要和上下文挡位的「模型名称」下拉一样长；②「每个场景先预热一次」「发生错误后停止」用开关，不要用勾选框。

- **等宽（`components.css` 新增 `.bench-field-model`）**：不再用 `.st-input--history` 的固定 `width: 260px`（那是「逐次测量」历史下拉的宽度，放标题行必然与字段网格不等宽），改成按 `.bench-fields` 的列宽反算：`width: calc((100% - 3 * var(--st-s-4)) * 1.6 / 4.6)`（四列 `1.6fr + 3×1fr`、三个 `--st-s-4` 间隔，模型列占 `1.6/4.6`），配 `margin-left: auto` 贴右。`%` 在 flex 项上按容器内容宽解析，而 `.bench-head` 与 `.bench-fields` 同处一个 `.panel` 的内容区，所以两者算式完全一致。
  - 结构随之调整（`ScenarioBenchPanel.tsx`）：模型下拉从 `.bench-head__right` 里拿出来，成为 `.bench-head` 的直接子元素（包一层 `.bench-field-model`），状态徽章也直接挂在 `.bench-head` 下 —— 否则两个 `margin-left: auto` 会平分剩余空间，下拉会被推到行中间。
  - 实测（`E:\tmp\scenariorepro\index.html` 内临时插一个四列 `.bench-fields` 标尺 + 一段 `getBoundingClientRect` 脚本，用截图读数字）：`picker=469.86 / fields-1.6fr=469.87 / diff=-0.01`，等宽成立（验证用的标尺与脚本已删）。
- **开关（`ScenarioBenchPanel.tsx` + `components.css` 新增 `.scenario-plan-toggles`）**：两个 `<input type="checkbox">` 补 `className="switch-input"` —— 开关外观全部来自 `app.css` 的 `.switch-input`（`:1593` 起，用户 m08750 定的组件），`.bench-switch` 只是个文字+间距的 label，没类名就还是原生方框。容器 `bench-switch-row` → `.scenario-plan-toggles`：前者是 `justify-content: space-between`，两个开关会被顶到行两端；后者 `display:flex; align-items:center; flex-wrap:wrap; gap: var(--st-s-2) var(--st-s-5)`，两个开关并排贴近（照上游）。
- **验证**：`npx tsc --noEmit` exit 0；复现页截图为 `E:\tmp\preview-scenario11.png`（开关已渲染成拨动样式、模型下拉与标题行右对齐）。
- **门禁与部署（build94）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build94.log`，GUI 未占用 exe，构建完直接部署）。exe **9,816,064 B / 2026-10-18 22:43:25 / SHA256 前 16 位 `40C3C57C7B42B342`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-scenariowidth`（上一版 build93 `6F4318A342F6B283`）。
- **仍未做**（同 §37–§61）：上游整张白卡；显存/内存峰值三列仍可能是 `—`。
- 上游 stress（并发阶梯）模式已在本节补上（见 §63）。

### 63. 移植上游「并发阶梯」卡片（2026-10-18，用户 m02608）

用户问「上游场景测试中的并发阶梯卡片呢？」—— 这是 §60 移植场景测试页时明确砍掉的 stress 模式，本节补回。

- **上游结构**（`E:\Code\strata-manager-main\apps\desktop\src\pages\ConcurrencyLadder.tsx`，112 行；纯逻辑在 `packages\core\src\concurrency-ladder.ts`，124 行；图表 `ConcurrencyChart.tsx`）：按 `1 → 2 → 4 …` 逐级加压，每级固定 `CONCURRENCY_LADDER_STAGE_MS = 40_000`，每级发 `concurrency` 个并发的 256-token 持续生成请求，统计该级总吞吐、单请求吞吐、TTFT P50/P95、完成/失败，最后给一句结论（提升 ≥ 1.1 倍才算 `ladder_gain`，否则「并发没有提高总吞吐」）。历史存 5 份。
- **新增 `src/utils/concurrencyLadder.ts`**（纯逻辑，无请求无 UI）：`LADDER_STAGE_MS = 40_000`、`LADDER_MAX_LEVEL = 32`、`LadderSample`/`LadderRow`/`LadderConclusion`、`ladderLevels(top)`（从 1 起每级翻倍到 top）、`ladderRowsFromSamples`、`ladderConclusion`、`ladderMessage`。总吞吐用「本级第一个请求开始 → 最后一个完成」的真实时间窗算（不是各请求速度相加），与上游同口径。
- **槽数来源改了**（唯一与上游不同的地方）：上游从 Strata 的 `/metrics` 读 `live.parallel`，那是 Strata 私有字段；本工程的 llama.cpp `/metrics` 是 Prometheus 文本，给不出槽数。改读 `/props` 的 `total_slots`（`src/api/chat.ts` 的 `fetchChatModelProps` 返回值从 `{ maxContext }` 扩成 `{ maxContext, totalSlots }`），拿不到（老版本 llama.cpp 没这个字段）就回退 4 个同时。代价是会加载模型，但用户点的是「开始阶梯测试」本身就要用这个模型，不违反 §2.7 那条「选择模型不应该启动模型」。
- **`src/store.ts`**：新增 `LadderState`（`running/stage/concurrency/levels/slots/completed/failed/startedAt/samples/history/selectedId/error`）与 `runLadder(model, slots?)` / `cancelLadder()` / `clearLadder(id?)` / `selectLadder(id)`，独立 `ladderAbort`。执行：外层逐级（`stageEnd = Date.now() + LADDER_STAGE_MS`），内层维持 `concurrency` 个在途请求（`inflight` Set + `Promise.race`），到点后 `await Promise.all` 收尾再进下一级。每个请求用 `scenarioMessages("decode", …)` 且轮次自增，保证输入各不相同（否则前缀缓存会让后面几级虚高）。历史键 `llamacpp-gui-concurrency-ladder`，留 5 份，**落盘前把 `samples` 清空**（几百条会爆 localStorage 配额，图表/表格只需要 `rows`）。
- **新增 `src/components/ConcurrencyLadder.tsx`**（约 307 行，含内部 `ConcurrencyChart`，不导出）：标题「并发阶梯」+ 一行说明（`按 1 → 2 → 4 个同时请求逐级加压，每级约 40 秒…`）；运行中右上 `bench-run`（spinner + `第 N / M 级 · X s` + 危险色「停止测试」）；进度条 `ol.concurrency-ladder-steps` 三态胶囊（完成 / 进行中 / 等待）+ 行尾实时计数；结论 `p.concurrency-ladder-verdict`；正文 = 柱线图（柱=总吞吐、线=单请求）+ 6 列表；跑完底部一行「测于 … · 模型 · 输出 256 token 的持续生成请求；TTFT 包含排队」。挂载在 `ScenarioBenchPanel.tsx` 的 A/B 卡之后（面板最后一张卡）。
- **标签重叠修复**：单并发时「总吞吐」与「单个请求」数值必然相等，上游把两个数字都放点的上方会叠成一个「46.2 46.2」。改成单个请求的数字放点的**下方**（`y = point + 17`），并给 `.concurrency-chart-per` 加 `paint-order: stroke; stroke: var(--st-surface); stroke-width: 3px`（数字压在柱子上，描一圈底色才看得清）。
- **样式**：`components.css` 追加 `.concurrency-ladder-head/-steps/-live/-verdict/-body/-table` 与 `.concurrency-chart*`（柱 `color-mix(in srgb, var(--st-accent) 45%, transparent)`、最佳档 `var(--st-accent)`、未测档虚线 ghost + 1.4 s 脉冲、`prefers-reduced-motion` 下关掉动画）。900px 断点下正文改单列。
- **验证**：`npx tsc --noEmit` exit 0；静态复现 `E:\tmp\scenariorepro\ladder.html`（跑完态）与 `ladder-running.html`（运行中态），截图 `E:\tmp\preview-ladder5.png` / `preview-ladder6.png`。
- **门禁与部署（build95）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build95.log`，GUI 未占用 exe，构建完直接部署）。exe **9,819,648 B / 2026-10-18 22:55:51 / SHA256 前 16 位 `00420B1C8CBB7D18`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-ladder`（上一版 build94 `40C3C57C7B42B342`）。
- **仍未做**：上游 stress 模式里的「自定义并发列表」与 `concurrencyComparisonCandidates`（多版本并发配置对比）未移植；上游整张白卡、显存/内存峰值三列（等 P4 采集层）仍同 §37–§62。

### 64. 移植上游原生聊天页（P3，2026-10-19，用户 m05982「聊天界面要把上游的原封原样的搬过来」）

- **依赖**：新增 `react-markdown`（10.1.0）+ `remark-gfm`（`npm i react-markdown remark-gfm --save`，98 个包）。前端 bundle 486 kB → **727 kB（gzip 230 kB）**，换掉「自己写 Markdown 渲染器」这条路，与上游同源。上游另用的 `lucide-react` / `react-i18next` **没装**：图标统一用 FontAwesome（本工程既有），文案直接中文。
- **新增 `src/utils/chat.ts`**（纯逻辑，照上游 `packages/core/src/chat.ts` 搬）：`ChatAttachment`/`ChatToolEvent`/`ChatUsage`/`ChatExecution`/`ChatTurn`/`Conversation`、`ChatOptions` + `DEFAULT_CHAT_OPTIONS`（`reasoningEffort "high"`、`temperature 0.6`、`topP 0.95`、`topK 20`、`maxTokens 0`、`seed null`、`showReasoning true`）、`normalizeChatOptions`、`buildSharedDefaults`（`'off'`→`'none'`；`temperature > 0` 才带 `top_p`/`top_k`）、`attachmentText`（围栏长度 `Math.max(2, 最长反引号串 + 1)`，>512 KB 抛错）、`apiMessage`、`buildChatRequest`、`class SSEParser`（处理 CR/LF、多行 `data`、UTF-8 跨包、`:` 心跳）、`decodeChatChunk`（`[DONE]`/`error`/`content`/`reasoning_content`/`finish_reason`/`usage`/`id`）、`newChatExecution`/`advanceChatExecution`/`finishChatExecution`、`conversationTitle`、`newId`。**有意去掉**上游的三个 Strata 专有字段：`strata_mcp`（MCP）、`strata_prefix`（固定文档前缀缓存）、`experimental_speed_projection`。
- **`src/api/chat.ts`**：新增 `streamChatTurn(port, body, onDelta, signal)`，用 `routerBase(port)` + `authHeaders()` POST `/v1/chat/completions`，`SSEParser` 喂原始 `Uint8Array`，`decodeChatChunk` 分流后回调。**没有复用压测用的 `streamChat`**：那个只回拼好的整段文本，聊天页要「思考/正文分流 + 随时能停」，硬塞进去会把压测路径改脏。依赖单向（`utils/chat.ts` 不 import `api/chat.ts`），无循环。
- **`src/store.ts`**：新增 `ChatState`（`conversations`/`activeId`/`draft`/`attachments`/`streaming`/`options`/`error`）与 `sendChat`/`stopChat`/`newConversation`/`selectConversation`/`renameConversation`/`deleteConversation`/`setChatDraft`/`addChatAttachments`/`removeChatAttachment`/`setChatOptions`/`dismissChatError`，独立 `chatAbort`。`sendChat` 的模型选择顺序＝`options.model` → 当前已加载的第一个 → 都没有就报错（**不主动加载模型**，沿用 §2.7）。会话没有就新建，标题取首句前 42 字。
- **持久化**：`localStorage` 键 `llamacpp-gui-chat-conversations`（最多 30 个会话、每会话 200 条消息）与 `llamacpp-gui-chat-options`。**写盘前把每条附件的 `content` 清空** —— 图片 base64 动辄几百 KB，不剥就撑爆 5 MB 配额；代价是重开历史会话时图片位置留空（上游用 SQLite 的 `attachments` 表，本工程没有数据库，这是唯一可行解）。
- **新增组件**（照上游同名文件搬）：`ChatPanel.tsx`（= 上游 `pages/ChatPage.tsx`：左侧历史栏 248px + 搜索 + 按今天/昨天/最近 7 天/更早分组 + 行内重命名 + 二次确认删除；中间 `.chat-scroll`；底部 composer：附件、新建、导出 Markdown、采样设置、停止、发送；Enter 发送 / Shift+Enter 换行 / 粘贴文件 / 拖放文件 / 贴近底部 120 px 才自动滚）、`ChatMessageView.tsx`（`react-markdown` + `remarkGfm`；代码块带语言名与复制按钮；思考 `<details>` 自动开合且用户点过就不再托管；工具调用按 `tool.at` **字符下标**插入正文）、`ChatExecutionStatus.tsx`（等待响应/正在思考/工具调用/正在回答/已完成/已停止/失败 + 耗时 + 首正文 + 请求标识）、`ChatSamplingSheet.tsx`（模型、思考强度、temperature、top-p、top-k、输出上限、随机种子、显示思考、系统提示）。
- **`src/App.tsx`**：`Tab` 加 `"chat"`，`TABS` 在「模型列表」之后加「对话」（`fas fa-comments`），渲染 `<ChatPanel />`。
- **样式**：`components.css` 追加约 700 行，分七组（历史栏 / 主区 / 消息 / 代码块 / 思考与工具 / 执行状态 / composer + 采样弹层）。数值取上游 `official/components.css` 与 `official-pages.css` 的同名规则，但颜色/字号/圆角全部走本工程 token（铁律 8）；上游的 `.official-surface` 作用域类本工程没有，全部挂在 `.chat-workspace` / `.main-area.chat-page` 下。页容器是 `display:flex; overflow:hidden` —— **页面自身不滚，滚动只交给 `.chat-scroll`**，否则 composer 会被顶出视口。
- **复现验证**：`E:\tmp\repro-chat.html`（link 真实 tokens/components/app 三份 CSS，含用户消息、助手消息、思考块、Markdown 表格、代码块、执行状态条、附件条），截图 `E:\tmp\preview-chat1.png` / `preview-chat2.png`。
- **与上游的三处差异**（都是环境差异）：① 上游会话按「服务 profile」分，本工程只有模型 → 会话与模型绑定，历史栏列全部会话；② 上游重命名/删除走 Dialog，本工程用行内编辑与「再点一次确认」；③ 图标用 FontAwesome。**采样设置入口用齿轮 `fa-gear`**（用户 m06243：`fa-sliders` 看着不像设置）。
- **门禁与部署（build97）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build97.log`）。exe **9,873,408 B / 2026-10-19 09:14:14 / SHA256 前 16 位 `606DF05FF44D3625`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（与构建产物同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-chat`（上一版 build95 `00420B1C8CBB7D18`）。构建时 GUI 正开着，`tauri build` 出的产物先落地、部署由后台脚本盯 `llamacpp-gui` 进程、等它退出（本次等 250 秒）后再复制 —— 这是本工程既有规律：**exe 被运行中的 GUI 独占，覆盖必然失败**。
- **仍未做**：上游的 MCP 工具链、`/v1/messages`（Anthropic 协议）、`RequestViewer`、固定文档前缀、速度预测、高级选项（JSON Schema / logit_bias）—— 全部依赖 Strata 引擎能力，llama.cpp 没有对应端点；附件落盘（上游 SQLite）；历史栏「搜索本服务的聊天」按 profile 过滤。上游整张白卡、显存/内存峰值三列（等 P4 采集层）仍同 §37–§63。

---

### 65. 聊天页五点收尾：速度指标 / 光标 / 上游图标 / 右侧抽屉（2026-10-19，用户 m06312「提示块要显示预填充、解码、草稿命中率」「正在写答案一个字一行」「输入框图标照搬上游」「设置不要弹窗」）

- **① 提示块显示速度**：`timings` 是 llama.cpp 在**最后一个 SSE 分块**里连同 `usage` 一起给的（`prompt_per_second` / `predicted_per_second` / `draft_n` / `draft_n_accepted`）。`src/utils/chat.ts` 新增 `ChatSpeed`（`prefillTokS` / `decodeTokS` / `draftAccept`）+ `parseChatSpeed`，`ChatDelta` 与 `ChatTurn` 各加一个 `speed?`，`decodeChatChunk` 里 `if (timings) out.push({ timings })`；`src/store.ts` 的 `onDelta` 与 `usage` 一样就地合并（`next.speed = { ...message.speed, ...delta.timings }`）。`ChatMessageView` 的 meta 改成**分段拼接**：`N token · 预填充 X tok/s · 解码 Y tok/s · 草稿命中 Z% · 已停止 · N 次工具调用`，缺哪项就不显示那一项。草稿命中率为 `null`（没开投机解码）时整项省略 —— 不能显示成 0%，那是假的。旧的「token ÷ 耗时」估算只在**完全没有 speed 且不是新消息**时兜底，避免两种口径混在一起。注意命名：`api/chat.ts` 已有压测用的 `ChatTimings`，这里必须叫 `ChatSpeed`。
- **② 「正在写答案…」一字一行**：真因是 `.cursor` 这个类**自带 `width:7px`**（本来是画方块光标的），而它同时被挂在「正在写答案…」这段文字上 → 文字容器被压到 7px，每字换行。更糟的是 `.st-bubble.cursor`（流式中整条气泡也挂这个类）会把**整条消息**压成 7px 宽。修法是把光标改成伪元素：`.cursor::after { content:""; width:2px; height:1em; margin-left:2px; … }`，宿主元素不再被限宽 —— 一处修好两个症状，不用改 JSX。
- **③ 输入框图标照搬上游**：新建 `src/components/ChatIcons.tsx`，把上游 `official/sprite.svg` 里 `attach` / `new-chat` / `download` / `settings` / `stop` / `send` 六条路径**原样内联**成 `<ChatIcon name=… size=… />`（统一 `stroke-width:1.5`、`opacity:0.12` 填充层保留）。只替换 composer 工具条这一处，其余界面继续用 FontAwesome —— 用户只要求「输入框图标照搬上游」，两套图标混在同一个控件里才会乱。用 SVG 属性写尺寸（不是内联 `style`），不违反铁律 8。CSS 只加一条 `.chat-icon { display:block; flex:none; color:inherit }`。
- **④ 设置改成右侧抽屉**：新建 `src/components/Drawer.tsx`（`.st-drawer` 360px 从右滑入、`data-open` 驱动 `transform`、Esc 与点遮罩关闭、`ErrorBoundary` 兜住崩溃），`ChatSamplingSheet` 由 `Modal` 换成 `Drawer`。要点：**滑入需要两帧** —— 初次渲染 `data-open=false` 让 `translateX(100%)` 先落地，`requestAnimationFrame` 里再置 true，否则没有过渡；关闭回调存 ref，调用方几乎都传内联箭头函数，直接进 `useEffect` 依赖会每帧重绑监听。样式取上游 `.dialog.drawer`：遮罩 `rgba(15,23,42,.18)` 的等价写法 `color-mix(in srgb, var(--st-ink) 18%, transparent)`、底部按钮**两列等宽 grid**、分段控件照 `.official-segmented`（`--st-surface-2` 底 + 选中项白底 + `--st-sh-card` 阴影）。上游字面 `border-radius:10px` 换成 `var(--st-r-sm)`（铁律 8）。
- **⑤ 导航词**：「对话」→「聊天」（用户 m06535），`src/App.tsx` 的 `TABS` 与 `ChatPanel` 的 `page-title` 同步改。
- **已知瑕疵**：`ChatExecutionStatus` 里「首 token」与「首正文」在 llama.cpp 上是同一个时刻（`firstTokenMs` 就是首个**正文** token 的时间戳），因此合并成一项「首正文」，不再重复显示两个相同数字。
- **复现验证**：`E:\tmp\repro-chat.html` 同步加了速度 meta、上游 SVG 图标、抽屉展开态，截图 `E:\tmp\preview-chat4.png` ~ `preview-chat5.png`。
- **门禁与部署（build98）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build98.log`）。exe **9,874,432 B / 2026-10-19 10:27:58 / SHA256 前 16 位 `1D3A141342544ECA`**，已部署（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-chat4`（上一版 build97 `606DF05FF44D3625`）。

---

### 66. 聊天联网搜索：按 `WEB_SEARCH_PLAN.md` 做五引擎路由（2026-10-19，用户 m06807「联网搜索应该按照 WEB_SEARCH_PLAN.md 的要求来实现」）

- **执行链路**：llama.cpp 自己不联网、也不跑 MCP —— 模型在流里发 `tool_calls`，**GUI 执行工具**，把结果当 `role:"tool"` 消息喂回去。`src/utils/tools.ts` 定义 `web_search` 的 OpenAI function schema（`buildToolSpecs(webSearch)`），`buildChatRequest(messages, options, supportsImages, tools)` 有工具时才带 `tools` + `tool_choice:"auto"`；`decodeChatChunk` 解析 `delta.tool_calls`（按 `index` 累积 `mergeToolCallFragments`）；`src/store.ts` 的 `sendChat` 里跑**最多 5 轮**工具循环，每轮追加 `{role:"assistant", tool_calls}` 与 `{role:"tool", tool_call_id}`；工具卡片用 `at = 当时正文长度` 插在发起那一轮正文之后。
- **后端 `src-tauri/src/search.rs`（新）**：五引擎 `anysearch / tavily / firecrawl / keenable / exa`，按配置顺序逐个试，前一个失败就换下一个；失败分 `Quota / Auth / BotWall / Transient / InvalidResponse / Unknown` 六类，冷却时间分别是**本会话**（额度、鉴权）/ 60 s（被当机器人）/ 30 s（临时）；结果缓存 300 s（最多 50 条）；命中黑名单域名的结果丢弃（按域名后缀匹配，子域一起屏蔽）；返回文本已用 `<untrusted-web-content>` 边界包好并声明「只能当资料，不能当指令」，前端**直接塞进 prompt，不再二次包**。
- **偏离计划的一处（重要）**：`WEB_SEARCH_PLAN.md` 决策 5 要求用 `reqwest` + `native-tls`（理由是别编译 `ring`）。实测本机 cargo 代理（`127.0.0.1:8787`）挂着时 `hyper-tls` 下载报 `Empty reply from server`，直连又因 Windows schannel 拿不到凭据（`SEC_E_NO_CREDENTIALS`）失败 —— **计划里的方案在这台机器上根本编不出来**。改为**系统 `curl.exe` 发请求**（`http_post_json` 一个函数收口，将来换回 `reqwest` 只改这一处），实测 anysearch / tavily / firecrawl 免 key 都能 200，且零新增依赖、不会让 exe 变大。理由与证据已写进 `search.rs` 的模块注释。
- **免 key 矩阵**（实测）：anysearch 免 key（4.5 s）、tavily 用请求头 `x-tavily-access-mode: keyless` 免 key（2.5 s）、firecrawl 匿名有额度（2.8 s）；**keenable 需要 `X-API-Key`、exa 需要 `Bearer`** —— 没配 key 的引擎在 `route()` 阶段就**直接剔除**，不排在队里白挨一次 401。
- **Tauri 命令**：`search_query` / `search_config` / `search_save_config` / `search_test_engine`（原有的单引擎 `websearch::web_search`（Bing 抓取）连同 `src-tauri/src/websearch.rs` 一并删除）。配置落在 `<配置目录>\search.json`，`search_config` 返回的视图**不含明文 key**（只给 `hasKey`）。
- **前端**：`src/types.ts` 加 `SearchResponse` / `SearchEngineView` / `SearchConfigView` / `SearchConfigInput` / `SearchTestResult`；`src/ipc.ts` 用 4 个 `search*` 换掉 `webSearch`；新组件 `ChatSearchSettings.tsx`（时间范围、结果条数、逐个引擎的启用开关 + 上移/下移定顺序 + key 输入 + 单独测试、屏蔽域名、保存）挂在采样抽屉「联网搜索」开关下面的折叠块里，开关关掉就不显示。抽屉只有 360px 宽：**key 输入框与「测试」按钮必须同一行**，`↑ ↓` 与徽章在上一行，否则会换行把抽屉撑破（第一版就是这样，徽章文字也从「已配 key / 缺 key / 冷却中」缩成「免key / 冷却」）。
- **兼容性坑**：`tools` 只在开关打开时才发，但**模型 chat template 不认工具调用时整轮会报错**。`sendChat` 的 catch 里加了提示：开了联网搜索且报错时追加「这个模型的 chat template 不支持工具调用 —— 关掉「联网搜索」，或在模型参数里加 `--jinja`」。实测 14 个配置里只有 `Unsloth-Qwen3.5-2B-Q8_0` 同时带 `--jinja` 与 `--chat-template`。
- **测试**：`cargo test --lib search` → **8 passed**（`host_is_extracted`、`blocked_matches_suffix_only`、`dedupe_keeps_first_and_ignores_trailing_slash`、`route_drops_engines_without_key`、`route_respects_configured_order`、`untrusted_block_strips_forged_boundaries`、`civil_date_roundtrips`、`failure_class_from_status`）。
- **仍未做**：`web_fetch`（P6，按计划暂缓）、MCP 工具服务（下一阶段）、引擎级并发探测。
- **门禁与部署（build100）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build100.log`）。exe **10,032,128 B / 2026-10-19 10:56:30 / SHA256 前 16 位 `B8D6AFEABEE46300`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-searchplan`（上一版 build98 `1D3A141342544ECA`）。

### 67. 联网搜索三处修复 + 聊天宽屏布局（2026-10-19，用户 m07055「keenable 加了 key 还提示没有 apikey」「上下移动按钮无效」「anysearch 排第一却用的是 Tavily」；用户 m07087「输入框和内容显示区域要随窗口扩展」）

- **① 上下移动 / 启用开关无效 → 两个独立 bug 叠在一起**：
  - 后端 `search.rs` 的 `route()` 先按 `self.order` 挑，末尾又无条件 `for name in ENGINES { push(...) }` 把没提到的引擎补回来 —— 于是 `order` **根本不是允许清单**，关掉的引擎照样跑。改成：只有 `picked.is_empty() && self.order.is_empty()`（从没保存过配置）才回退全量；`order` 非空时它就是最终清单。测试 `route_respects_configured_order` 的旧断言（「配置里没提到的补在后面」）随之改掉，并新增 `empty_order_falls_back_to_all_engines`。
  - 前端 `ChatSearchSettings` 用 `config.engines.map(...)` 渲染，而后端 `engines` 是固定 `ENGINES` 顺序 —— `move()` 改的是 `order`，界面却按固定顺序画，**点了按钮看不出变化**。改成渲染前按 `order.indexOf(name)` 排序，未启用的排到后面。
- **② keenable 加了 key 仍提示没配 key**：`search_test_engine` 读的是**后端磁盘配置**（`search.json`），而 key 只在点「保存搜索配置」时才落盘。用户粘贴 key 直接点「测试」= 测的是旧配置。改成 `test(name)` 发现 `keys[name]` 非空时先 `searchSaveConfig` 再测。
- **③ anysearch 排第一却用 Tavily**：`SearchResponse.attempts` 早已记录每个引擎的失败原因，但 `runTool` 只把 `block` 喂给模型，界面看不到。现在 `runTool` 返回 `note`（实际引擎 + 被跳过的引擎及其原因），`ChatToolEvent` 新增 `note?` 字段，`ToolCall` 展开后第一行显示它 —— **用可观测性换定位手段**：下次再出现「用 Tavily」时，卡片上会直接写 AnySearch 是被额度、鉴权还是超时挡掉的。
- **④ 聊天宽屏**：`.chat` / `.st-composer` 原本 `max-width: 860px; margin: 0 auto`，`.st-msg` 720px —— 大屏上全挤在中间一条。改为 `width: 100%`、去 `margin: auto`，气泡 `max-width: 100%`，跟着窗口走。
- **测试**：`cargo test --lib search` → **9 passed**；`npx tsc --noEmit` exit 0。
- **门禁与部署（build101）**：`npm run tauri build` exit 0（日志 `target\build101.log`）。exe **10,032,128 B / 2026-10-19 11:27:00 / SHA256 前 16 位 `D450709A6CDBEB49`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-searchfix`（上一版 build100 `B8D6AFEABEE46300`）。

### 68. 聊天页三处手感修正：左右留白 / 外链走系统浏览器 / 删会话不确认（2026-10-19，用户 m07200）

用户三点：「输入框和内容显示区域左右要留出足够的区域，现在太挤了」「点联网搜索给的网页链接不要在 GUI 内打开，应该调系统浏览器」「删除聊天会话，不要确认操作」。

- **① 左右留白**：上一版（§67 ④）为了让内容跟窗口伸缩，把 `.chat` / `.st-composer` 的 `max-width: 860px` 直接删了，结果宽屏下文字贴到窗口边缘。改成 `.chat { padding: var(--st-s-5) var(--st-s-12) }`、`.composer-wrap { padding: var(--st-s-3) var(--st-s-12) var(--st-s-4) }` —— **留白和「随窗口伸缩」不冲突**，要的是 padding 不是 max-width。窄屏（`max-width: 900px`）那段原来给 12px，一并提到 `var(--st-s-5)`。
- **② 链接走系统浏览器**：`ChatMessageView` 的 `Markdown` 里覆写 `a`：`onClick` 里 `preventDefault()` 后调 `ipc.openExternal(href)`。道理解释：WebView2 里 `<a href>` 是真导航 —— 整页被替换成目标网页且没有后退入口，用户只能重启窗口。
  - 新增 Rust 命令 `open_external_url`（`src-tauri/src/lib.rs`，紧挨 `open_local_url`）**只放行 `http://` / `https://`**，然后交给 `tauri-plugin-opener`。与 `open_local_url`（只放行 `127.0.0.1` / `localhost`）分开写而不是加个参数：链接来自模型输出，属于不可信内容，两种白名单混在一起容易放宽。
  - 前端 `ipc.ts` 加 `openExternal`。
- **③ 删会话不确认**：`ChatPanel` 的 `HistoryItem` 原本是「点一次变对勾（3 秒超时复原），再点才删」。去掉 `confirming` 状态、`setTimeout` 复原 effect、`is-confirming` 样式类，删除按钮一次点击直接 `onDelete()`。代价：误点即丢，但会话本来就只有 30 条上限、且删错了顶多丢一段对话。
- **复现图**：`E:\tmp\repro-chat.html` 同步了 48px 留白，截图 `E:\tmp\preview-chat12.png`（1680×1100，抽屉同时展开）。
- **门禁与部署（build102）**：`npx tsc --noEmit` exit 0；`cargo check --release` exit 0；`npm run tauri build` exit 0（日志 `target\build102.log`）。exe **10,034,176 B / 2026-10-19 11:41:23 / SHA256 前 16 位 `A3A029BD2A5CF909`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-chatpolish`（上一版 build101 `D450709A6CDBEB49`）。

### 69. 聊天内容区居中 + 宽度可拖拽；工具循环修「没回答」和重复搜索（2026-10-19，用户 m07332「左右留白还是不够」、m07390「聊天内容和输入框还是居中显示，且用户可以调整宽度」、m07347「没有回答」）

留白这事折腾了三轮，最后结论是**留白不是答案，可调宽度才是**：

- **① 留白三轮都没对**：§67 删 `max-width` 让内容随窗口拉伸 → 文字贴边；§68 补 48px padding → 用户仍说不够；再改成 `clamp(var(--st-s-12), 6vw, 160px)`（1680 宽约 100px）→ 用户直接要「居中 + 可调宽度」。教训：宽屏阅读宽度的问题没有普适解，让用户自己定。
- **② 居中定宽 + 拖拽**：`.chat` / `.st-composer` 都改成 `width: var(--chat-width, 900px); max-width: 100%; margin: 0 auto`，`.composer-wrap` 的左右 padding 归零（两者共用同一个宽度变量才左右对齐）。
  - `ChatPanel` 里 `CHAT_WIDTH_KEY = "llamacpp-gui-chat-width"`、`CHAT_WIDTH_DEFAULT = 900`、`CHAT_WIDTH_MIN = 520`、`CHAT_WIDTH_MAX = 1600`；初值从 localStorage 读，非法值回落默认。
  - 变量通过 `mainRef.current?.style.setProperty("--chat-width", ...)` 写在 `.chat-main` 上 —— **不用 JSX 内联 style**（铁律 8）也不会触发 React 重渲染。
  - 手柄 `.chat-resize` 绝对定位在 `.chat-main`（要 `position: relative`）里、贴着内容右边缘垂直居中，`cursor: col-resize`；拖动时 `clientX` 的差值 **×2**（内容居中，右边缘移 1px = 宽度变 2px）；双击恢复 900；`max-width: 900px` 断点下隐藏手柄。
  - 手柄默认色用 `color-mix(in srgb, var(--st-ink) 16%, transparent)` 而不是 `--st-line`：后者在浅色主题下几乎看不见，用户根本不知道能拖。
  - 试过但否掉：CSS 原生 `resize: horizontal`（要求 `overflow` 非 visible，会多出滚动条，且把手在右下角）；工具栏放数字输入框 / 预设宽度按钮（不直观，也更不像"拖动"）。
- **③ 「没有回答」的真因**：工具循环上限 5 轮，模型每轮都还要调工具 → 循环正常结束但 `answer` 是空的，界面只剩一叠工具卡片。修法：循环后用**不带 tools 的请求**补一次收尾，附一句 `工具调用次数已经用完了。请直接根据上面拿到的资料回答问题，不要再调用任何工具。`
- **④ 同一句反复搜**：模型把同一句 `web_search` 连发 5 次，每轮结果都塞进上下文。循环里加 `searched` 集合（每次发送新建，不跨会话）：重复查询直接返回「已经搜过「X」…请直接基于已有资料回答」，不再打后端（后端虽有 300s 缓存，但返回的是同一段文本，模型照旧重试）。
- **⑤ 工具卡片摘要**：原来 `preview = tool.result ?? …`，结果正文以 `<untrusted-web-content>` 开头，摘要行等于把边界标签怼到脸上。改成**优先显示参数**（搜的是什么），结果只放展开里。
- **复现图**：`E:\tmp\repro-chat.html`（抽屉展开版）+ `E:\tmp\repro-chat-nodrawer.html`（手柄可见版），截图 `E:\tmp\preview-chat18.png` / `preview-chat19.png`。
- **门禁与部署（build103）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build103.log`）。exe **10,034,688 B / 2026-10-19 11:56:43 / SHA256 前 16 位 `D45B50D23F95FF66`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-chatwidth`（上一版 build102 `A3A029BD2A5CF909`）。

### 70. 聊天区宽度回到上游 860 + 拖拽条改成悬停才显形（2026-10-19，用户 m07518）

用户两点：
1. 「把文本框和内容显示区域回复到上游的尺寸（保证屏幕窄的时候还是有足够的留白）」—— §69 把默认宽度定成 900 且窄屏只靠 `max-width: 100%` 兜，贴着窗口边。
2. 「拖拽条平时要隐藏，只要在鼠标移动到拖拽条那一列的时候才显示，这个时候按住鼠标左键拖拽」。

- **宽度**：`ChatPanel.tsx` 的 `CHAT_WIDTH_DEFAULT` 900 → **860**（= 上游 `max-width: 860px`）；`.chat` / `.st-composer` 的宽度从 `width: var(--chat-width); max-width: 100%` 改成
  `width: min(var(--chat-width, 860px), calc(100% - 2 * var(--st-s-5)));`
  —— 宽屏就是 860 居中，窗口窄下去自动缩成「窗口 − 40px」，两边永远留 20px。**窄屏断点里原来那条 `padding-left/right` 一并清零**，否则留白会叠成 40px（`min()` 已经把边距算进去了）。
- **拖拽条**：`.chat-resize` 从「6px 淡灰常显」改成 **20px 宽的透明感应区 + `::after` 画的 4px 细条**，`opacity: 0` → `:hover` 时 `opacity: 1`，细条在 hover 时变 `--st-accent`。整条 20px 都能命中 hover，不用瞄准细条；窗口 < 900px 时仍然 `display: none`（那时内容区已经贴满，没有可调的余地）。
  `right` 也跟着 860 改：`calc(50% - var(--chat-width, 860px) / 2 - 10px)`。
- **复现图**：`E:\tmp\repro-chat-idle.html`（手柄隐藏）/ `E:\tmp\repro-chat-hover.html`（加 `opacity: 1 !important` 模拟 hover），截图 `E:\tmp\preview-chat-idle.png` / `preview-chat-hover.png`。
- **教训**：`opacity: 0` 的元素照样能命中 `:hover`，所以「平时看不见、移上去才出现」不需要额外包一层触发器；但用 `min()` 算宽度时，断点里残留的 padding 会变成双倍留白，改宽度就得同步清 padding。
- **门禁与部署（build104）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build104.log`）。exe **10,034,688 B / 2026-10-19 12:09:21 / SHA256 前 16 位 `4079C9279F1DAB5F`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-chathover`（上一版 build103 `D45B50D23F95FF66`）。

### 71. 聊天区：历史栏展开 / 窗口变窄时左右留白 40px（2026-10-19，用户 m07582）

用户：「打开聊天历史的时候，输入框和内容显示区域与左右边界也要有足够的留白」。

- **真因**：§70 的宽度公式是 `min(var(--chat-width, 860px), calc(100% - 2 * var(--st-s-5)))`，`100%` 相对 `.chat-main`。历史栏一展开，`.chat-main` 变窄，`min()` 就切到后面那支 —— 只剩 20px 留白，看起来像贴边；宽屏（860 生效）时又很宽松，两边手感不一致。
- **改法**：两支 gutter 从 `--st-s-5`(20px) 提到 `--st-s-10`(**40px**)，`.chat` 与 `.st-composer` 同步改（第 1839 / 2164 行）。
- **连带修**：`.chat-resize` 的定位原本写死 `calc(50% - var(--chat-width) / 2 - 10px)`，按 860 算；内容被 `min()` 压窄时手柄会飘到内容外面。改成
  `calc(50% - min(calc(var(--chat-width, 860px) / 2), 50% - var(--st-s-10)) - 10px)` —— 取「变量半宽」与「容器半宽减 gutter」的较小者，手柄永远贴实际右边缘。
- **复现图**：`E:\tmp\repro-chat-narrow.html`（1150 宽 + 历史栏展开 + 手柄强制显形），截图 `E:\tmp\preview-chat-narrow.png`：内容区左右各留约 40px，手柄贴在内容右缘。
- **教训**：居中内容用 `min(固定宽, 100% - 2*gutter)` 时，凡是按固定宽算出来的绝对定位（比如拖拽条），都必须跟着改成同一个 `min()` 表达式，否则一旦切到窄的那一支就错位。
- **门禁与部署（build105）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build105.log`）。exe **10,034,688 B / 2026-10-19 12:19:04 / SHA256 前 16 位 `797399E0AAC3B0BE`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-chatgutter`（上一版 build104 `4079C9279F1DAB5F`）。

---

### 72. 聊天内容显示照 DSH 改版：无卡片流式排版 + 线性图标（2026-10-19，用户 m07609「参考 dsh 的内容显示格式和图标」）

- **为什么照 DSH 而不是继续照上游**：上游（strata-manager）的助手消息是「白卡片 + 边框」的气泡，长回答里卡中卡（代码块、表格都在卡片里）层次糊；用户要的是 DeepSeek Harness 那种「助手回答直接铺在页面流里」的排版。
- **DSH 的数值哪来的**：直接读 DSH 打包后的样式表 —— `C:\Users\WuChun\.dsh\patches\read-asar.mjs` 从 `E:\Software\DeepSeek Harness\resources\app.asar` 里抽出
  `dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BxpfOGf3.css`（77,343 B）到 `E:\tmp\dsh-web.css`，从里面逐条抄数字。**没有直接看 DSH 的界面**（`http://127.0.0.1:59345` 需要鉴权，headless 打开只有一行 `dsh web: authentication required`），所以只抄了能量化的部分（间距/边距/字号），没抄颜色体系。
- **助手消息去掉卡片**：`.st-msg--assistant .st-bubble { padding: 0; border: 0; background: transparent; }` —— 这是整轮改动里观感变化最大的一处。用户气泡（右侧绿底）保持不变。
- **排版间距对齐 DSH**（`src/styles/components.css`）：
  - 段落/列表/代码块上下 16px（原来是 12px）；`li + li` 6px；
  - 列表左缩进 18px；`hr` 高度 0.5px、上下 32px；
  - 引用左侧 2px 竖线 + 14px 内边距（原 3px / 12px）；
  - 行内代码 `.875em`、`0 5px`、inline-flex；
  - 标题 `h3` 上 32px / 下 16px（`h4` 16px/16px），首个标题上边距归零。
  - **表格去掉竖线**：`th/td` 只保留下边 `.5px` 细线、`padding: 10px 16px`、`text-align: start`、`min-width: 100px` / `max-width: 320px`；`border-collapse: collapse`。这是 DSH 表格和本项目原来「全边框」最明显的区别。
- **代码块头部**：`padding: 10px 18px 8px 22px`、`font: 400 var(--st-fs-xs)/18px`、语言名靠左用正文字体、右侧复制按钮 24×24；代码区 `padding: 14px 22px`。深色底沿用本工程 token（DSH 用的是它自己的 markdown-code-block 变量，两者主题不同，没有硬换）。
- **思考块 / 工具卡**：单行折叠头（图标 + 名称 + 摘要 + 状态 + 右端 chevron，`--st-fs-sm`、次要色，hover 转主色）；展开的思考正文左侧 2px 竖线、`line-height: 1.6`；工具参数/结果 `font: 400 var(--st-fs-xs)/16px var(--st-font-mono)`（DSH 是 12px/16px）。两块在消息流里各有 12px 上下间距。
- **图标换成线性 SVG**（`src/components/ChatIcons.tsx`）：新增 `copy` / `chevron` / `think` / `tool` / `check` 五个，统一 `stroke-width: 1.5`、`viewBox="0 0 24 24"`、`fill="none"`、`currentColor`；`ChatIcon` 加了可选 `className`（折叠箭头要 `st-chev` 才能跟着 `[open]` 旋转）。`ChatMessageView` 里 7 处 FontAwesome（`fa-copy`×2、`fa-chevron-down`×2、`fa-brain`、`fa-screwdriver-wrench`、`fa-paperclip`）全部换掉。
  - 取舍：**只换消息区**，输入框工具条（§65 已换）与页面其它地方继续用 FontAwesome。理由：整站图标一起换是另一项工作，混用只出现在「消息区 vs 工具栏」两处，视觉上分得开。
- **没有抄的部分（明确记录，避免被误以为漏做）**：DSH 的 shiki 代码高亮、KaTeX 公式、`md-table-wide` 横向滚动容器、JSON 树查看器（那是 DSH 的 devtools 组件，不是聊天卡片）、思考过程的中文状态词。这些要么依赖 DSH 独有依赖，要么与 llama.cpp 的能力无关。
- **预览**：`E:\tmp\repro-chat-dsh.html`（关掉抽屉、图标已替换）+ 截图 `E:\tmp\preview-chat-dsh2.png`。
- **门禁与部署（build106）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build106.log`）。exe **10,035,200 B / 2026-10-19 13:11:34 / SHA256 前 16 位 `23412F0150DD862A`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-dshstyle`（上一版 build105 `797399E0AAC3B0BE`）。

---

### 73. 聊天消息区去掉折叠框 + 折叠方式与图标照 DSH（2026-10-19，用户 m07760）

用户四点：「思考、联网搜索等工具调用都不要框起来」「折叠和展开都使用 dsh 的方式」「不要显示请求标识」「思考、工具调用要使用 dsh 的图标」。

- **去框**：`.st-collapse` 本身带 `border + background + radius`（设置页的「搜索引擎与 key」折叠块也在用），所以只在消息区去掉：
  `.st-msg .st-collapse, .st-bubble .st-collapse { border: 0; border-radius: 0; background: transparent; }`，并把 `> summary` 的内边距压到 `4px 0`、`__body` 的 `padding` 归零。设置页折叠块保持原样。
- **折叠方式**：箭头改为默认朝右（`M9.5 6L15.5 12L9.5 18`），`.st-collapse[open] .st-chev { transform: rotate(90deg) }` —— 原来用的是朝下箭头再转 180°，展开时变朝上，跟 DSH「右→下」的方向相反。
- **请求标识**：`ChatExecutionStatus` 里那组 `<details><summary>请求标识</summary>` 整块删除（本地操作 id / 服务响应 id）。llama.cpp 只回一个 `chatcmpl-…`，对账也没处查；执行条只剩「状态 · 耗时 · 首正文」。
- **图标**：`ChatIcons.tsx` 里把 `think` 从灯泡换成四角星（`M12 4L13.6 10.4L20 12L13.6 13.6L12 20L10.4 13.6L4 12L10.4 10.4L12 4Z`），`tool` 从扳手换成终端窗口（外框 + `M7.5 10.5L10 13L7.5 15.5M12.5 15.5H16.5`）。仍是 1.5 描边、24 viewBox、`currentColor`。
- **预览**：`E:\tmp\repro-chat-dsh.html`（关抽屉），截图 `E:\tmp\preview-chat-dsh4.png`。
- **教训**：`.st-collapse` 是跨页面共用的类（设置页也用它），改样式必须按作用域收窄（`.st-msg` / `.st-bubble` 前缀），否则会把设置页的折叠块一起改掉。
- **门禁与部署（build107）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build107.log`）。exe **10,035,200 B / 2026-10-19 13:22:06 / SHA256 前 16 位 `95076AFDD041E2D6`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-dshframe`（上一版 build106 `23412F0150DD862A`）。

---
### 74. 聊天输入框内置模型选择 + 去掉顶部模型徽章 + 发送键可配（2026-10-19，用户 m07816）

用户三点（原文：「1、我刚才想到了一个问题，如果我运行了几个模型，在聊天界面的输入框中应该有一个模型选择的地方和显示当前模型的地方，请参考 dsh 添加输入框的模型选择和显示；2、聊天界面顶上的模型显示取消；3、'Shift+Enter 换行' 文本取消，移动到设置中，可以由用户这种换行快捷键」）：

- **① 输入框里选模型**：`ChatPanel` 的 `.st-composer__bar` 最左侧新增 `.composer-model`（自绘下拉：`button.composer-model__btn` 显示当前模型名 + chevron，菜单 `bottom: calc(100% + 6px)` 往上展开 —— 它在输入框底部，往下会顶出视口）。候选来自 `configs.filter(c => c.has_model).map(c => c.name)`；**已加载的模型前面打绿点**（`loadedSet` 由 `routerModels` 里 `status.value === "loaded"` 得出），跑着好几个模型时一眼看出哪些是热的。选中即 `setChatOptions({ ...chat.options, model })`，复用既有 localStorage 持久化。压测中（`streaming`）禁用。
  - 为什么自绘：原生 `<select>` 在 WebView2 里由系统绘制，白底黑字跟输入框不搭；输入框那条位置很挤，自绘才能控制宽度和展开方向。
- **② 去掉顶部模型徽章**：`.chat-toolbar` 里那枚 `st-badge--ok` 删除 —— 模型已在输入框里常显，顶上再放一遍是重复。空会话时的「当前模型 X · 走前门 :9090」保留（那是没有消息时的引导文案）。
- **③ 发送键改成可配**：`ChatOptions` 新增 `enterSends: boolean`（默认 `true`），`DEFAULT_CHAT_OPTIONS` 与 `normalizeChatOptions` 一并补（读回来不是布尔就落回默认）。
  - `true`：Enter 发送、Shift+Enter 换行（原行为）；`false`：Ctrl+Enter 发送、Enter 换行。
  - 输入框 `onKeyDown` 按开关分流，仍保留 `event.nativeEvent.isComposing` 判断（中文输入法选词时按 Enter 不能发出去）；`placeholder` 跟着切换文案。
  - 配置项放进采样抽屉（`ChatSamplingSheet`，`select#chat-s-enter`，两项文案「Enter 发送，Shift+Enter 换行」/「Ctrl+Enter 发送，Enter 换行」）；输入框上那行 `composer-hint` 删除。
- 样式：`components.css` 追加 `.composer-model*`（按钮 `max-width: 220px` 省略号、菜单 `min-width: 220px / max-width: 360px / max-height: 300px` 可滚、mask z-index 30 / 菜单 31、绿点 6px 圆点用 `--st-accent`）。
- 复现：`E:\tmp\repro-chat-dsh.html`，截图 `E:\tmp\preview-chat-model.png`（下拉展开态，含两个已加载绿点项）。
- 门禁与部署（build108）：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build108.log`）。exe **10,035,712 B / 2026-10-19 13:34:38 / SHA256 前 16 位 `8EE5D89C6CC4FF1E`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-composermodel`（上一版 build107 `95076AFDD041E2D6`）。
- 教训：发送快捷键这种「一行文案」的提示不该常驻界面占地方 —— 它的价值是配置，不是显示。

---
### 75. 模型下拉挪到发送键左边 / 全名显示 / 只列运行中的（2026-10-19，用户 m07929）

用户三点：① 模型名称要放在发送按钮左边；② 模型名称要显示完整；③ 点击模型后的上拉菜单中只显示运行中的模型。

- **挪位置**：`.composer-model` 从 `.st-composer__bar` 最左移到 `<span className="spacer" />` 之后、停止/发送按钮之前 —— 右侧是"这次对话用谁"的自然位置，也不再挤占左侧图标组。
- **全名**：`.composer-model__btn` 去掉 `max-width: 220px`，`.composer-model__name` 去掉 `text-overflow: ellipsis`，改 `white-space: nowrap` —— 名字长就把按钮撑宽，不再省略号；菜单 `right: 0; width: max-content; min-width: 100%; max-width: 420px`，右对齐并向上展开（按钮已在右下角，向右下都会出界）。
- **只列运行中**：新增 `runningModels` memo（`routerModels` 里 `status.value === "loaded"` 的 id，按名字排序），菜单渲染它而不是全部 `configs`。空态文案「当前没有正在运行的模型」。
  - 连带删除 `loadedSet` —— 只列运行中之后，绿点已无意义（全部都是热的），留着反而是死代码（`tsc` 会报 TS6133）。
  - 取舍：当前选中的模型如果刚好被卸载，按钮仍显示它的名字（那是真实状态），但菜单里没有它，要换一个才能发。
- **门禁与部署（build109）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build109.log`，单次前台执行，日志用 `*>>` 追加）。exe **10,035,712 B / 2026-10-19 13:44:30 / SHA256 前 16 位 `23CE855B04592F4E`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-modelright`（上一版 build108 `8EE5D89C6CC4FF1E`）。
- **预览**：`E:\tmp\repro-chat-dsh.html` + 截图 `E:\tmp\preview-chat-model2.png`（下拉贴输入框右边缘、向上展开，两项均为运行中模型）。
- **教训**：一条规则（"只列运行中"）落实后，配套的视觉线索（绿点）要一并删除 —— 否则既误导又是未使用变量；`tsc` 的 `noUnusedLocals` 恰好能兜住这类残留。
### 76. 联网搜索结果条数上限 10 → 50（2026-10-19，用户 m07982「结果调数最大才10，这个远远不够啊」）

- **放宽上限**：`max_results` 三处 clamp 全部 `1..=10` → `1..=50`（`SearchConfig::max_results()`、`search_query` 的 limit、`search_save_config` 的写入）。前端结果条数输入框 `max={10}` → `max={50}`，`Math.min(10, …)` 同步改 50。
- **模型侧的说明也要改**：`src/utils/tools.ts` 里 `web_search` 的 `limit` 参数描述原写「1–10，默认 6」——模型只按描述办事，不改正则它永远只会要 10 条以内。现改为「1–50，默认 6；问题复杂时给 15–30」。
- **每条结果的字数**：`SNIPPET_MAX` 300 → 800。条数上去而每条形同标题，等于没搜到内容。
- **新增总长预算 `BLOCK_MAX = 24_000` 字符**：条数 × 字数可以轻松把上下文吃满（50 × 800 ≈ 40K 字符），所以在 `wrap_untrusted_block` 里逐条累加，超预算的结果不再列出，末尾补一行「另有 N 条结果因为超出本次长度预算没有列出」——宁可少列也不能把上下文顶爆。
- **各引擎自身的上限仍在**：Tavily 官方 `max_results` 上限 20（代码 `limit.min(20)` 保留）；Firecrawl 的 `limit` 放宽到 `clamp(1, 30)`；AnySearch 直接透传。也就是说引擎给不满 50 条是正常的，路由会按返回数量照收。
- **门禁与部署（build110）**：`cargo test --lib search` **9 passed**；`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build110.log`）。exe **10,036,736 B / 2026-10-19 13:53:23 / SHA256 前 16 位 `4894597B7A7C20E0`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-searchmore`（上一版 build109 `23CE855B04592F4E`）。
- **教训**：一个「上限」往往散落在四处（后端两处 clamp、前端输入框、给模型看的参数描述）。只改一侧，用户看到的现象不会变 —— 尤其参数描述，它是模型的唯一信息来源。
### 77. P4 监控采集层（2026-10-19，用户 m05070「按 A 开工」+ m05111「可以借鉴吗」+ m05188「NVML 直连、AMD/Metal 适配还是应该抄」）

零新依赖（`sysinfo` 不引），新文件 `src-tauri/src/monitor.rs`：

- **CPU / 内存**：`windows-sys`。`GetSystemTimes` 在 `Win32::System::Threading`（**不是 SystemInformation，别看名字想当然**），`GlobalMemoryStatusEx` 在 `Win32::System_SystemInformation`。CPU 用两次采样差值：kernel 时间已含 idle，所以总量是 `kernel + user`、空闲是 `idle`，`busy = total - idle`。第一次没有基线返回 `None`。
- **GPU 三级降级**（照 `serve/telemetry.py` 的顺序）：
  1. **NVML 直连**（`nvml.dll`，`LoadLibraryW` + `GetProcAddress` 动态取符号）。用 v2 导出（`nvmlInit_v2` / `nvmlDeviceGetCount_v2` / `nvmlDeviceGetHandleByIndex_v2`），老驱动退 v1 名字。功耗单位是**毫瓦**，要除 1000。函数指针全靠 `transmute` 还原，因此每个 `symbol()` 都要 `?`，缺一个就整体退到下一级 —— 不同驱动导出的名字不一样，硬要求全会崩。
  2. `nvidia-smi --query-gpu=… --format=csv,noheader,nounits` 文本解析（`parse_gpu_line`），`[N/A]` 当 `None`（笔记本功耗墙常见）。
  3. **AMD / Intel 静态兜底**：`powershell Get-CimInstance Win32_VideoController` 拿型号与 `AdapterRAM`，结果缓存在 `OnceLock`（起 powershell 太贵，不能每秒跑）。`AdapterRAM` 是 32 位字段，大于 4 GB 会溢出成负值 —— 溢出就当未知。
  - Metal 分支留了 `#[cfg(target_os = "macos")] fn metal_working_set()` 空实现：本工程只发 Windows 版，不把 IOKit 绑定拖进依赖。
- **实测读数**（本机 RTX 5070 Ti Laptop，`cargo test -- --nocapture`）：`utilization Some(0), mem_used_mib Some(283), mem_total_mib Some(12227), temperature Some(54), power_w Some(19.28), power_limit_w Some(123.757)` —— NVML 这条通了，`nvidia-smi` 是退路。
- **对外三段式**（照 `telemetry.py` 的 `/metrics` 形状）：`MonitorSnapshot { now, static, history }`。`now` 是当前聚合值 + `gpus` 每卡明细；`static` 是型号/总量/卡数；`history` 是 60 点环形缓冲（1 秒一个点，`at` 与每个序列等长，按时间窗切片用）。
- **多卡聚合规则**（照 telemetry）：显存/功耗/功耗墙**求和**，利用率**取平均**，温度**取最大**。
- **常驻采集线程**：`monitor::start_sampler()` 在 `lib.rs` 的 `.setup()` 里启动（`OnceLock` 防重复）。前端不再自己攒点，切页/重渲染不丢数据。
- **命令**：`monitor_sample()`（读快照，不额外采样）、`monitor_sample_now()`（立刻采一次，极短档位用）、`monitor_engine(port, model?, api_key?)`（手写 HTTP/1.0 GET 打 `/metrics` 与 `/slots`，支持 chunked 解码；**调用前必须确认模型已加载，否则会把模型拉起来**）。
- **压测页三列回填**：`store.ts` 新增 `sampleRange(from, to)`，按 `history.at` 落在样本时间窗内的点取峰值 —— `peakGpuMemory` = `gpuMemUsed` 最大值 ×1 MiB、`peakRam` = `memUsed` 最大值、`minGpuMemoryFree` = 显存总量 − 峰值、`resourceSamples` = 命中点数。每个样本请求前 `await monitorSampleNow()`，保证极短档位也至少有一个点。
- **门禁与部署（build111）**：`cargo test --lib monitor` **11 passed**；`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（日志 `target\build111.log`）。exe **10,132,480 B / 2026-10-19 14:35:53 / SHA256 前 16 位 `CAA8121BAAF7DBA5`**，已部署到 `E:\AI\llama.cpp-gui\llamacpp-gui.exe`（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-monitor`（上一版 build110 `4894597B7A7C20E0`）。
- **教训**：
  1. `windows-sys` 的模块划分跟 Win32 文档的分组不一致，找函数要直接搜注册表源码（`%USERPROFILE%\.cargo\registry\src\*\windows-sys-0.60.2\src\Windows\Win32\**`），别按 MSDN 猜。
  2. 动态加载 DLL 时，`HMODULE` 是 `*mut c_void` 不是 `isize`，判空用 `is_null()`。
  3. 采集层必须**三级降级**：NVML 缺失（老驱动）→ 命令行 → 静态信息。任何一级硬性要求都会在某些机器上直接空白。
- **未做**：P5 监控 UI（状态栏胶囊 + 弹层 + 折线图）尚未开始，`monitor_sample` / `monitor_engine` 目前只有压测页在用。
## 78. P5 监控 UI：底部状态栏 + 服务状态弹层（build113，2026-10-19）

用户 m05241「监控 UI 也要原封原样的照搬上游」。上游对应三件：`layouts\ServiceTelemetryStatusBar.tsx`（胶囊）、`ServiceStatusPopover.tsx`（弹层）、`layouts\service-telemetry-statusbar.css` + `service-status-popover.css`（样式）。按 §7 决策 5，浮窗与托盘三条（`FloatingTelemetryWindow` / `FloatingMonitorContent` / `FloatingMonitorSettings`）不搬。

- **新增 `src/utils/telemetry.ts`**：照搬上游 `serviceStatusTelemetry.ts` 的三件事 —— `telemetryPoint`（空闲态不记速度，因为引擎自报的是上一次请求的残留）、`appendTelemetry`（3 分钟窗 / 最多 60 点，identity 变了重开）、`telemetrySparkline`（缺采样处断开折线，按真实时间间距铺 x 轴）。另加本地口径的 `LiveMetric` 与 `buildLiveMetric()`，把采集快照 + 本地活动状态拼成上游 `MetricSnapshot` 的形状。
- **新增 `src/components/ServiceTelemetryStatusBar.tsx`**：底栏。顺序照上游：状态点 + 胶囊 + 「生成/读取/最近生成 速度 · 运行 · 排队 · GPU · CPU · 温度 · 功耗」。无数字时一律 `–`。断点 900 隐藏功耗、640 隐藏温度（上游是 740/560）。
- **新增 `src/components/ServiceStatusPopover.tsx`**：点胶囊展开。`createPortal` 到 body，`position: fixed` 贴在胶囊上方（`top: rect.top - 10` + `translateY(-100%)`），宽 `min(408, innerWidth - 24)`，Esc/外部点击关闭，`resize` 重算位置 —— 这些都是上游的算法。面板内容照上游顺序：标题（模型名）+ 刷新/关闭 → 「API 在线」chip + 模型状态 + 前门端口 → endpoint → 两条迷你折线（速度 / GPU，viewBox `0 0 160 48`，基线 `M4 44H156`）→ 显存 / 内存 / 最近请求上下文三个 meter（≥90% 转 warn 色）→ 「近 3 分钟采样 + 时间」→ 快捷跳转（监控 / 模型管理 / 任务与日志）。
- **样式**：`components.css` 追加约 340 行，含 `.st-pill` 全套（照上游 `official\components.css:17-27`）、7 个 `st-pill-*` keyframes、`.workspace-statusbar` 与 `.service-status-*` 全组。与上游的差异只有两处：字面 `font-size` / `border-radius` 换成 token（铁律 8），断点改成 900/640。
- **布局接入**：本工程没有上游「main 里再分 header/footer」的骨架，底栏用 `position: fixed` 贴视口底部（`z-index: 60`），并给 `.sidebar` / `.main-area` 各加 `padding-bottom: 34px` 让出位置。
- **数据**：`store.ts` 新增 `monitor` / `monitorAt` / `lastTurn` + `refreshMonitor()`；`App.tsx` 里 1 秒轮询 `monitor_sample`（`document.visibilityState !== "visible"` 时跳过，省电）。速度与上下文取自 `lastTurn`，在聊天流式的 `delta.timings` 处写入。
- **门禁与部署（build113）**：`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（`target\build113.log`）。exe **10,137,088 B / 2026-10-19 14:46:31 / SHA256 前 16 位 `B35BA6108884040C`**，已部署（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-monitorui`（上一版 build111 `CAA8121BAAF7DBA5`）。
- **未做**：上游的「监控」整页（`OfficialMonitoring.tsx`：状态卡 + 8 张 spark 卡片 + 上下文环形表 + `SlotMonitor`）尚未搬；弹层里的「最近请求上下文」条目前要等一次请求后才有值（`lastTurn` 为空时不显示）；「运行/排队」用的是本地活动状态，没有解析 `/metrics` 的 `llamacpp:requests_*`。
## 79. P5 监控 UI 第二步：监控整页 + 并行任务（build114，2026-10-19）

用户 m05462「直接开工」（承接 m05241「监控 UI 也要原封原样的照搬上游」）。上游对应 `OfficialMonitoring.tsx`（180 行）、`SlotMonitor.tsx`（54 行）、`official\app.css:81-120` 与 `slot-monitor.css`。

- **后端：`/metrics` 改成两种格式都收**。`monitor_engine` 原来按 JSON 解析，而 llama.cpp 默认返回 Prometheus 文本（`llamacpp:requests_processing 0`），于是恒报「不是合法 JSON」。现在先看首字符：`{`/`[` 走 JSON，否则走新增的 `parse_prometheus()` —— 逐行 `name value`，跳过 `#` 注释，带标签的样本（`name{a="b"} 1`）只留名字主体；解析结果塞进 `{ prometheus, requestsProcessing, requestsDeferred, tokensPredicted, tokensPredictedSeconds, promptTokens, promptSeconds, kvCacheTokens, kvCacheUsage }`，监控页直接取驼峰字段，不必再拼名字。
- **新增 `src/utils/monitor.ts`**：照搬上游 `sparkPaths`（viewBox `0 0 100 32`，缺采样断开成多段、面积闭合到基线、末点补实心圆）、`kfmt` / `ctxfmt` / `bytesfmt`，以及 `/slots` 的归一化 `normalizeSlots()` 与 `nextSlotHistory()`（每槽 30 点，空闲记 null 让折线断档）。
- **新增 `src/components/SlotMonitor.tsx`**：标题行「并行任务 + 处理中 N · 等待中 M · 槽外请求 K」，三格汇总（生效槽数 / 合计速度 / 排队），表格 8 列（任务位 / 状态 / 输入词元 / 输出词元 / 保留历史词元 / 生成速度 / 速度走势 / 对话容量占用），走势是 60×18 的迷你 SVG，空闲槽位整行转灰。
- **新增 `src/components/MonitoringPage.tsx`**：状态卡（5 个 badge 只有当前态 `.on`、处理中/等待中、生效槽数、读取中显示进度条）→ `SlotMonitor` → 8 张指标卡（速度 / GPU 负载 / 显存 / GPU 温度 / 功耗 / PCIe / CPU / 磁盘，折线封顶值 100 或 90，温度走 warn 色、PCIe 与磁盘走 info 色）→ 上下文环（`st-gauge` r=50、`strokeDasharray` 235.6 弧长、`rotate(135)`）+ 系统内存 / KV 缓存两条 meter → 最近请求表。
- **接入**：`App.tsx` 加 `monitor` tab（`fas fa-chart-line`，排在「性能测试」前）。引擎指标**只在监控页且模型 `loaded` 时**每 2 秒轮询 `monitor_engine` —— 对未加载模型调 `/metrics?model=` 会被前门把模型拉起来，这条约束在 `monitor.rs` 文件头就写着。`buildLiveMetric` 的 `maxContext` 改取 `configs` 里的 `max_context`（`--ctx-size 0` 时后端已回退到 GGUF），上下文环与弹层 meter 都因此有值。
- **与上游的四处差异**（数据不可得，版面保留）：
  1. ~~PCIe、磁盘两块 llama.cpp 不提供~~ —— **已改**，见 §79 末尾「PCIe 与磁盘吞吐」：这两项本来就不是引擎指标，而是本机硬件读数（NVML 的链路吞吐、PDH 的物理磁盘计数器），P4 采集层自己就能采，不该留 `—`。用户 m05606 当场指出这点。
  2. 「近期请求」只显示最近一次完成的请求（`lastTurn`），没有逐请求列表 —— llama.cpp 没有对应接口。
  3. 上游的「会话缓存」卡换成 KV 缓存两条 meter（`kvCacheUsage` / `kvCacheTokens`）。
  4. 上游的 MCP 服务卡没有对应数据，未搬。
- **门禁与部署（build114）**：`cargo test --lib monitor` **13 passed**（新增 `prometheus_metrics_are_parsed`、`labelled_samples_keep_the_bare_name`）；`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（`target\build114.log`）。exe **10,149,376 B / 2026-10-19 14:56:27 / SHA256 前 16 位 `99CA5D8942F55FAD`**，已部署（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-monitorpage`（上一版 build113 `B35BA6108884040C`）。
- **未验证**：本轮跑的是静态复现页 `E:\tmp\repro-monitor.html`（链接真实 CSS），真机上 `/metrics` 与 `/slots` 的字段名还需实测一轮 —— `normalizeSlots` 已按候选名兜底（`n_past` / `n_prompt_tokens` / `n_decoded` 等），但不同 b 版本可能仍有出入。

### PCIe 与磁盘吞吐（用户 m05606，build115）

用户原话：「PCIe 和磁盘这两张卡在 llama.cpp 值是「—」，但是在 strata 应该是有数据的」。这条纠正了一个判断错误：**它们不是引擎指标，而是本机硬件读数**，llamacpp 引擎采不到不等于采不到。口径对齐 `E:\AI\Strata\serve\telemetry.py`：

- **PCIe**：NVML 的 `nvmlDeviceGetPcieThroughput`，参数 `NVML_PCI_UTIL_TX_BYTES = 0` / `NVML_PCI_UTIL_RX_BYTES = 1`。该函数返回 **KB/s**，除 1024 得 MB/s（`nvmlDeviceGetPcieThroughput_v2` 直接返回 B/s，若取到 v2 就不再除）。多卡聚合按求和 —— 每张卡的链路独立，累加才是整机过卡流量。取不到时 `None`，卡片显示 `—`。
- **磁盘**：PDH 的 `PhysicalDisk(_Total)` 两个计数器 `Disk Read Bytes/sec` / `Disk Write Bytes/sec`。三个坑：① `PdhAddCounterW` 加完要先 `PdhCollectQueryData` 一次拿基线，**下一次**才有速率，所以第一次采集返回 `None`（`Meter.primed` 标志）；② 计数器句柄是 `*mut c_void`，初值必须 `core::ptr::null_mut()` 而不是 `0`；③ `Meter` 里有裸指针，默认不是 `Send`，要 `unsafe impl Send for Meter {}` —— 采集线程只有一个，只要不并发就是安全的。
- **真机实测**（`cargo test --lib monitor::tests::disk_and_pcie_probe -- --ignored --nocapture`）：`disk = Some((0.0, 5.623338303531306))`、`pcie = (Some(0.0107421875), Some(3.7138671875))` —— 读 0 MB/s、写 5.6 MB/s；PCIe 下行 0.01 MB/s、上行 3.71 MB/s（空闲态，所以值很小是正常的）。
- **前端**：`MonitorGpuSample` 加 `pcieRxMb` / `pcieTxMb`，`MonitorNow` 加 `diskReadMb` / `diskWriteMb`；`LiveMetric` 加 `pcieRx` / `diskRead` / `diskWrite`，8 张卡里 PCIe 卡显示下行、磁盘卡显示读并附「读 x / 写 y」副标题。
- **门禁与部署（build115）**：`cargo test --lib monitor` **13 passed**；`npx tsc --noEmit` exit 0；`npm run tauri build` exit 0（`target\build115.log`）。exe **10,156,032 B / 2026-10-19 15:08:00 / SHA256 前 16 位 `C76C47D1E3ED8B0A`**，已部署（源与目标同大小/同时间/同哈希）；备份 `llamacpp-gui.exe.bak-before-pciedisk`（上一版 build114 `99CA5D8942F55FAD`）。
- **遗留**：磁盘只采 `_Total`，没有按盘分列；PCIe 只显示下行（上行在 `pcieTxMb` 里，界面未展示）。

### 监控跟随「正在运行」的模型（用户 m05740，build116）

监控页原先固定盯 `OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL`——因为它取的是 `chat.options.model || 第一个 loaded`，
聊天里选谁就盯谁，而且只取了一个。用户指出「我启动的可能是其它的模型，也可能启动几个模型」。

现在：

- `App.tsx` 用 `loadedModels`（`routerModels` 里 `status === "loaded"` 的全部，按 id 排序）替代单个 `loadedModel`；
  新增 `monitorModel` 状态，`activeModel = loadedModels.includes(monitorModel) ? monitorModel : loadedModels[0] ?? ""`
  —— 选中的模型被卸载后自动退回列表第一个，不会指向一个不存在的目标。
- **状态栏、状态弹层、监控页现在都跟 `activeModel` 走**，聊天选哪个模型不影响监控（聊天可以选没加载的模型，
  盯它会盯错对象）。聊天页自己的模型选择仍用 `chat.options.model`。
- 监控页顶栏：`loadedModels.length > 1` 时出一个 `.monitor-model` 下拉（宽 200–320px）让用户切；
  只有 1 个时显示绿色徽章；0 个时提示「还没有运行中的模型」，引擎指标与状态卡留空，硬件指标照常显示。
- 引擎指标（`/metrics`、`/slots`）的轮询条件不变：只在监控页 + `modelState === "loaded"` 时拉，
  **绝不对未加载的模型调 `/metrics?model=`**（前门会把它拉起来）。

### 监控页第二轮修正（用户 m05810，build117）

五条一起改：

1. **`/metrics` 501** —— llama-server 默认不开这个端点，返回
   `{"error":{"code":501,"message":"This server does not support metrics endpoint. Start it with `--metrics`"}}`。
   两处修：`scheduler.rs` 的 `build_model_args` 现在**默认追加 `--metrics`**（配置里自己写了就不重复加），
   它只是多挂一个只读端点，不影响推理；前端把 501 识别成「配置状态」而非故障 —— 不再点亮状态卡的
   「错误」badge，改为一行灰字「这个实例没开 --metrics，引擎指标不可用；重启模型后新实例会默认带上」。
   旧的、已经在跑的实例仍然有效到重启为止。
2. **状态卡 / 上下文卡 / 最近请求表按上游重排**：
   - 状态卡详情行改成「N 个请求处理中 · M 个排队」，右侧仍是「生效槽数」。
   - 上下文卡从「环形 + 系统内存 + KV 缓存」改成上游的**环形 + 三条 bar**：GPU 显存（上游第一条是
     「显存中的专家」，llama.cpp 没有 MoE 驻留指标，用最接近的显存顶替）/ 系统内存 / GPU 温度。
     内存与显存 > 92% 转 `data-tone="danger"`、温度 > 80 °C 转 `warn`，与上游同口径。
     KV 缓存占用挪到最近请求卡底部一行。
   - 最近请求表从 5 列单行改成**多行 8 列**：时间 / 状态 / 提示词 / 输出 / 输入处理 / 生成 / 缓存命中 / 耗时。
     数据由 GUI 自己记录（llama.cpp 没有逐请求接口）：`store.recentTurns` 最多 12 条，
     在 `sendChat` 的 `finally` 里从这条助手消息读 `usage`/`speed` 追加一行，失败也记（状态列显示「失败」）。
     缓存命中率 = `timings.cache_n / (prompt_tokens + timings.cache_n)`。
3. **状态栏胶囊去边框、去掉重复的绿点** —— 胶囊原来继承 `.st-pill` 的边框与底色，改成
   `border: 0; background: transparent`；重复的绿点是因为 `ServiceTelemetryStatusBar` 在 `trigger`
   之外又画了一个 `service-telemetry-dot`，现在有 `trigger` 时不再渲染状态点与文案。
4. **八张指标卡补图标** —— `MetricCard` 加 `icon` 字段（`fa-gauge-high` / `fa-microchip` / `fa-memory` /
   `fa-temperature-half` / `fa-bolt` / `fa-network-wired` / `fa-server` / `fa-hard-drive`），
   标题行改成 `<span class="st-metric__title">` 包「图标 + 名称」，单位仍在右端。
5. **聊天自动选模型** —— 记住的 `chat.options.model` 必须仍在**运行中**才用，否则退回运行中按 id 排序
   的第一个（`runningModels`）。之前上次选过、后来卸载的模型会一直被当成当前模型，消息发出去才报错。

### 监控页照上游源码逐项对齐（用户 m05986 → m06061「你仔细看一下上游的源码」）

读完 `E:\Code\strata-manager-main\apps\desktop\src\OfficialMonitoring.tsx`（180 行）后改的地方：

- **指标卡结构**：上游是 `st-metric__label`（图标+名）→ `st-metric__value`（数字 + `<small>单位</small>`）→ `st-metric__sub`（副标题）→ `st-metric__spark`（`viewBox 0 0 100 32`、`preserveAspectRatio="none"`）。原来我把单位挪到卡片右上角、spark 夹在数字与副标题之间，现在顺序与位置都按上游改回，spark 用 `margin-top: auto` 贴卡片底部。
- **速度卡**：上游是 `div.speed-values` 两列，每列各含 value + sub（`最近生成` / `最近输入处理`）。
- **显存卡**：`/ 12 GB` 是**数字右边的小字单位**（`unit`），副标题留给「N 个专家已缓存」；llama.cpp 没有 MoE 专家指标，副标题换成 KV 缓存 token 数。
- **PCIe 卡**：上游把链路规格拆成 `value = "Gen4"` + `unit = "x8"`，吞吐退成副标题「传至 GPU N MB/s」。为此在 NVML 里补了 `pcieLinkGen`（`nvmlDeviceGetCurrPcieLinkGeneration`）与 `pcieLinkWidth`（`nvmlDeviceGetCurrPcieLinkWidth`），真机实测 `Some(4) / Some(8)`。
- **spark 上限**：GPU 温度 90（不是 100）、显存 = 显存总量、功耗 = 功耗上限。
- **近期请求**：补「复用」列（`timings.cache_n`），共 10 列；状态 badge 前加圆点。
- **CPU 卡副标题**：上游是「16 核心 · 32 线程」，核心数拿不到，改用 `navigator.hardwareConcurrency` 报线程数。
- **磁盘卡**：标题「磁盘读取」，副标题「写入 N MB/s」。
- **会话缓存卡**：照上游四行事实（最近请求 / 启动以来复用 / 停放恢复 / 最近切换）。llama.cpp 只有 `cache_n`，所以只保留前两行 + 脚注。

build118：10,158,592 B · 2026-10-19 16:08:15 · SHA256 前 16 位 `63DAD313F0E75FA1`。
### 监控页五点修正（用户 m06106）

1. **功耗飙到一万多** —— 空闲时个别驱动对 `nvmlDeviceGetPowerUsage` 会吐异常大的值。现在两级都加了范围校验：NVML 与 nvidia-smi 两条路径上，超过功耗上限两倍、或超过 5000 W 一律当读不到（显示「—」），宁可不显示也不显示荒谬数字。
2. **显存命中率不许用缓存命中顶替** —— 上游那一列是 `request.hit_rate`，语义是「生成回答时查的专家里，已在显存中的份额」（MoE 指标），跟提示词复用完全是两件事（复用有自己的「复用」列）。llama.cpp 没有专家命中指标，所以这一列恒为「—」。
3. **显存卡副标题「N 个专家已缓存」** —— 上游取自 `engine.expert_slots`：Strata 的 `/metrics` 会报，llama.cpp 不报。现在有值就显示，没值就留空，不再拿 KV 缓存去顶这个位置。
4. **状态徽章要彩色** —— 照上游 `official/components.css:62-67` 重写：`--reading` 用 info tint、`--generating` 用 accent tint、`--queued` 用 warn tint、`--error` 用 danger tint，边框透明，并且 `::before` 用 `currentColor` 画 6px 圆点。原先三种状态都套 `--st-surface-2` 灰底，所以只有深浅变化、没有颜色。
5. **会话缓存卡** —— 改成「有数据才显示」（`cacheTokens > 0` 才渲染整张卡），结构照上游：`req-head` 标题 + 右侧「N 个请求/M 个请求复用了部分提示词」+ `dl.facts` 两列事实 + `cc-note` 脚注；配套补了 `.facts`（`minmax(140px,max-content) 1fr`、`gap: 10px var(--st-s-6)`）、`.req-head`、`.card-title`、`.cc-note` 四组样式。

build119：见部署记录。
### 引擎差异的显示原则（用户 m06168）

> 上游就是管理 strata 引擎的，我们 GUI 有两种引擎，strata 和 llama.cpp，我让你照搬上游，保证 strata 引擎的显示，llama.cpp 引擎没有的参数不显示就行了。

即：**列/行按引擎存在与否渲染，不是渲染成「—」**。

- 判定：`isStrata = Array.isArray(metrics.requests)`。Strata 的 `/metrics` 带 `requests` 数组与 `engine.expert_slots`，llama.cpp 的 Prometheus 指标里都没有。
- **显存命中率列**（`request.hit_rate`，生成时专家命中显存内的份额）：仅 Strata 渲染整列（表头 + 单元格 + `colSpan`），llama.cpp 不出现这一列。Strata 下按请求时间就近匹配 `hit_rate`。
- **会话缓存卡的「停放 / 恢复」行**：仅 Strata 的 `conversation_cache.enabled === true` 时渲染，带 `evictions` 时补「· N 已淘汰」；llama.cpp 只有前缀复用两行。
- **显存卡副标题「N 个专家已缓存」**：仅当 `expert_slots` 有值时出现，否则整个副标题留空（不占位、不显示「—」）。
- 会话缓存整卡仍然只在 `cacheTokens > 0` 时出现。

build120：见部署记录。
### Strata 引擎下六点修正（用户 m06197）

1. **「3,901 个专家已缓存」不显示** —— 上游是 `eng.expert_slots`（`raw.engine` 下的对象），我原先读根级 `metrics.expert_slots`，层级错所以恒空。现在优先 `metrics.engine.expert_slots`，退根级。
2. **显存命中率缺「+1.3% PCIe」** —— 补 `request.pcie_share`：命中的那条请求若 `pcie_share > 0`，在同一格追加 `<span class="muted"> +X.X% PCIe</span>`，与上游一致。
3. **状态徽章没颜色** —— 根因是 JSX 里只给了 `on`，没给状态色类。现在四个徽章分别带 `st-badge--reading` / `--generating` / `--queued` / `--error`，配合上一轮补的 tint 配色。
4. **速度卡「最近输入处理」为空** —— `buildLiveMetric` 原来只在 `reading` 态给 `prefillTokS`，生成中与空闲都是 null。上游是「读取中＝当前 / 生成中＝本次 / 其余＝最近一次」，改成始终取 `lastTurn.prefillTokS`；`decodeTokS` 同理简化为 `lastTurn.decodeTokS`。
5. **CPU 缺核心数** —— `MonitorStatic` 新增 `cores` / `threads`，由 Rust 在首次采样时跑一次
   `Get-CimInstance Win32_Processor | ForEach-Object { $_.NumberOfCores; $_.NumberOfLogicalProcessors }` 拿到并缓存（`cpu_topology()`）。前端副标题改成「N 核心 · M 线程」。`creation_flags` 在 `std::process::Command` 上不存在，去掉即可（采集线程自己不是控制台程序）。
6. **会话缓存卡不出现** —— 显示条件从「本地 `cacheTokens > 0`」改成「Strata：`metrics.conversation_cache` 存在即显示；llama.cpp：仍看 `cacheTokens > 0`」。

build121：见部署记录。
### 「最近输入 / 最近生成」的口径（用户 m06282）

上游 `packages\core\src\metrics.ts:40-49` 是唯一依据：

```ts
let prefillTokS = number(live.prefill_tok_s_mean);
if (state === 'idle') {
  const ms = number(last?.prompt_ms), tokens = number(last?.prompt_tokens), reused = number(last?.reused);
  prefillTokS = ms !== null && ms > 0 && tokens !== null ? Math.max(0, tokens - (reused ?? 0)) / (ms / 1000) : null;
}
decodeTokS: state === 'generating' ? number(live.tok_s) : number(last?.decode_tok_s),
```

落到本工程（`src\utils\telemetry.ts` 的 `buildLiveMetric`）：

- **读取中**：优先引擎实时均值 `live.prefill_tok_s_mean`（只有 Strata 的 `/metrics` 有），拿不到就退最近一次。
- **生成中**：本次值（`lastTurn.prefillTokS` 在 `delta.timings` 到达时已写入）。
- **其余**：最近一次。
- `reading` 的判定改成真实状态：`chat.streaming && 最后一条助手消息 execution.phase === "waiting"`（原先硬编码 `reading: false`）。
- `decodeTokS` 同步简化成「总是 `lastTurn.decodeTokS`」——生成中它就是本次，其余就是最近一次，与上游 `state === 'generating' ? live.tok_s : last.decode_tok_s` 等价。

build122：10,162,688 B / 2026-10-19 16:51:52 / `33B42A83BF2C4465`，备份 `llamacpp-gui.exe.bak-before-prefill`（上一版 build121 `82A9B48F21EEFDF1`）。
### 指标卡折线对齐上游源码（用户 m06326 / m06333 / m06339 / m06368）

上一轮我把面积填充删了，这是错的 —— 上游 `OfficialMonitoring.tsx:52-54` 的 `SparkPaths` 明确同时画两条 path：

```tsx
<path className="area" fill="currentColor" opacity=".12" d={paths.area} />
<path className="line" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"
      strokeLinecap="round" vectorEffect="non-scaling-stroke" d={paths.line} />
```

读 `OfficialMonitoring.tsx:31-51` 后修正的三处真实差异：

| 项 | 上游 | 我原来的 | 现在 |
| --- | --- | --- | --- |
| y 轴上限 | `Math.max(fixedMax ?? 0, ...finite, 1e-9)` —— 给定上限时只往上扩 | `fixedMax ?? Math.max(1, ...valid)` —— 给定时忽略实际值，超出就被 `Math.min(1, ...)` 截断到顶 | 已改上游公式 |
| 单点段 | `if (points.length < 2) continue` | 单点也画（只出一个 M，无可见线） | 已丢弃 |
| 面积 | `line + L 末点,32 L 首点,32 Z`，多段 `join('')` | 起点先 `M x,32` 再 `M x,y`，字符串结构不同 | 已按上游拼 |

**速度卡原本是假的**：`values: (series.gpuUtil ?? []).map(() => live?.decodeTokS ?? null)` —— 用一个常量把整条时间轴拉平，所以永远是一条直线。上游用的是 `history.tok_s`（引擎每秒一点）。现在：

- Strata：`engine.metrics.history.tok_s` / `history.prefill_tok_s_mean`（与上游同一来源）。
- llama.cpp：`/metrics` 不报 history，改由前端 `store.speedSeries` 每秒推一个点（60 点，只在生成时记非空值，与上游 `history.tok_s` 的语义一致）。

速度卡同时叠第二条线（上游 `<g className="speed-prefill">` 那段）：`altValues` → `.speed-prefill`。

顺带：显存卡副标题的专家数从 `kfmt`（3.9k）改成 `toLocaleString`，用户 m06326 第 1 点要个位数。

`sparkPaths` 的返回值从「数组」改成「拼号后的字符串」（`line` / `area`），`SlotMonitor` 的 `Spark` 同步改成单条 path。

build124：10,162,688 B / 2026-10-19 17:07:53 / `06D12FEBFEE01E94`，备份 `llamacpp-gui.exe.bak-before-spark`。
### 监控直连 Strata 引擎：前门不代补 key，走前门必然 401（build126）

用户 m06557：「上游是直连 strata 引擎，你是通过前门连接的」；m06623：「现在 gui 是启动的，你可以探测一下」。

**探测结论（真机）**

| 探测 | 结果 |
| --- | --- |
| 直连 `:9091/metrics`（不带 key） | `401 {"error":{"type":"authentication_error","message":"missing or wrong API key"}}` |
| 走前门 `:9090/metrics?model=sc117-swift-iq2-xs` | 同上 401 |
| `:9080/metrics` | 空响应（那里没有引擎） |
| 直连 `:9091/metrics` + 配置里的 `api_key` | 完整 JSON：`engine,live,requests,conversation_cache,requests_kept,totals,hardware,hardware_static,history,time` |

原因在 `src-tauri\src\strata_proxy.rs:1111-1112`：**鉴权头原样透传，前门不代客户端补 key**（用户 m06545 定的规则）。前端只有 `settings.api_key`（前门自己的），拿不到引擎的 key —— `strata.rs` 的 `StrataModelEntry.api_key` 是 `#[serde(skip_serializing)]`。于是**两条路都 401**，监控页的「近期请求」一直用本地 `recentTurns` 兜底，这正是它少一条「已断开」、时间偏晚的根因。

**修法**

- `src-tauri\src\monitor.rs`：`monitor_engine` 增加 `config_path: Option<String>`；新增 `strata_api_key(config_path)` 直接读 Strata 配置 JSON 的顶层 `api_key`（key 仍不进 WebView，前端只传路径）。
- `src\ipc.ts`：`monitorEngine(port, model, apiKey, configPath)`。
- `src\App.tsx`：Strata 模型直连 `strataEntry.port` 且 `model` 传 `null`（不带 `?model=`）；任何错误再回退走前门。
- `src\components\MonitoringPage.tsx`：近期请求改用引擎 `requests`（含 `finish=disconnect`），时间取 `request.time × 1000`。

**`request.time` 是请求开始时刻**（用户 m06514 提醒）。带 key 直连拿到的三条与上游截图逐条一致：

```
1792402199.22  finish=disconnect  p=516  o=10065  dur=104.5
1792402144.65  finish=stop        p=810  o=4817   dur=54.5
1792402007.06  finish=stop        p=374  o=478    dur=7.4
```

**同批另两项（用户 m06469）**

- 服务状态卡照上游 `OfficialMonitoring.tsx:73-84` 合成**一行**：左「等待请求 / 处理输入 / 生成回答」，右灰色详情（idle 且有 last → 「最近：N tokens 速度 X tok/s」；reading → 「N tokens」；generating → 「N tokens · X tok/s」），下面一条 `st-progress`。
- 启动弹黑窗：`monitor.rs` 的 `powershell`（`:159` CPU 拓扑、`:467` CIM 兜底）与 `nvidia-smi`（`:439`）三处都加 `creation_flags(CREATE_NO_WINDOW = 0x0800_0000)`。

build126：10,166,272 B / 2026-10-19 17:44:07 / `B8E94F00199F80CD`，备份 `llamacpp-gui.exe.bak-before-directmetrics`（上版 build124 `06D12FEBFEE01E94`）。

### 监控数据源改正：状态卡与会话缓存改用引擎 /metrics（build127）

用户 m06736：「不是页面不对，是从模型获取的数据不对」。此前这两个卡的数据都来自 GUI 本地推导（`buildLiveMetric` + `recentTurns`），页面对但数字不对。

**服务状态卡**

| 位置 | 改前 | 改后（照上游 `OfficialMonitoring.tsx:73-84 / 134-138`） |
| --- | --- | --- |
| 采样行 | 无 | `上次成功采样：<本地化时间>`，出错时换 `notice warning` 并补一句「下方数值为上次采样」 |
| 标题 | 「服务状态」 | 「模型状态」+ 5 个 badge 同处 `state-card__head` |
| state | 本地活动状态 | `metrics.live.state`（reading / generating / idle / unloaded）优先 |
| reading 详情 | 本地 token 数 | `prompt_read / prompt_total tokens · N%` |
| generating 详情 | 本地 output | `generated tokens · tok_s tok/s` |
| 进度条 | 上下文占比 | reading 用 `prompt_read/prompt_total`，generating 用 `generated/max_tokens` |
| 速度卡数值 | 本地 lastTurn | `live.tok_s` / `live.prefill_tok_s_mean` 优先，缺了才回落 |

**会话缓存卡**（`OfficialMonitoring.tsx:109-118 / 168`）

- 整卡数据改为引擎 `metrics.conversation_cache`：`requests` / `requests_reused` / `reused_tokens` / `prompt_tokens` / `last_reused` / `last_prompt` / `parks` / `restores` / `evictions` / `last_event` / `last_tokens` / `last_at` / `budget_mib` / `slots` / `parked` / `bytes`。
- 显示条件照上游 `hidden={Object.keys(cache).length === 0}`：llama.cpp 的 `/metrics` 没有这个键，只有 `cache_n > 0` 时才退化成本地两行。
- `enabled === true` 才多出「停放会话 `parked / slots`」「会话内存（RAM）`bytes / budget`」两条 bar 与「停放 / 恢复」「最近切换」两行；否则脚注改回「在运行配置的 args 中加入 `--conversation-cache-mib`, "8192"」。

**顺带修掉的代码事故**：上一轮编辑把注释 `// 进度条：…` 与下一行 `const cacheTokens = …` 拼成了一行，后半行被注释掉，导致 `cacheTokens` 报「找不到」。现两行已分开。

build127：10,167,296 B / 2026-10-19 17:59:47 / `9B2A1BF807F9FD9D`，备份 `llamacpp-gui.exe.bak-before-enginedata`（上版 build126 `B8E94F00199F80CD`）。
## 监控页：状态词按 live.phase 细分（用户 m06846 / m06864，build129）

用户先提两点（m06846）：tokens 数字不要缩写成 `3.9k`、进度条上方的文字与状态照上游；随后澄清（m06864）：「进度条状态是指：生成回答、思考、调用XX工具啊等」。

**1. tokens 一律个位数 + 千分位。** 照上游 `OfficialMonitoring.tsx:60` 的 `fmt()`：`toLocaleString(language, { maximumFractionDigits: digits, minimumFractionDigits: digits })`，`digits` 默认 0。新增 `num0()`（`src\components\MonitoringPage.tsx`），状态行与会话缓存卡里的 13 处 `kfmt(` 换成 `num0(`。上下文环的 `kfmt`（26.1k / 128K）保留 —— 上游那里确实用 `kfmt`。

**2. 进度条本体照上游 `official\components.css:45-49`。** 之前 `.st-progress` 只给原生 `<progress>` 写（`::-webkit-progress-*`），监控页用的却是 `<div class="st-progress"><div class="st-progress__bar"/></div>`，所以 `__bar` 完全没有样式 —— 进度条是空的。现在两种写法都支持：`height: 8px`、`border: 1px solid var(--st-line-soft)`、`border-radius: var(--st-r-pill)`、`background: var(--st-surface-2)`、`overflow: hidden`，`__bar` 继承圆角并用 `--st-accent`，`[data-tone=info|warn|danger]` 分别换 `--st-info` / `--st-warn` / `--st-danger`。

**3. 状态词按 `live.phase` 细分。** Strata 的 `E:\AI\Strata\serve\server.py:4145-4153` 写的是：

```python
if ev.kind == "reasoning":   s["phase"] = "thinking"
elif ev.kind == "content":   s["phase"] = "answering"
elif ev.kind == "tool_start": s["phase"], s["tool"] = f"writing a tool call: {ev.call.name}", ev.call.name
elif ev.kind == "tool_call": s["phase"] = "tool call complete"
```

而上游 `OfficialMonitoring.tsx:81` 连的引擎写的是 `reasoning` / `content`，**两套取值都要认**。`MonitoringPage.tsx` 里加 `phaseLabel`：`reasoning|thinking → 思考`、`content|answering → 生成回答`、`reading the prompt → 读取提示词`、`saving the session → 保存会话`、`tool call complete → 工具调用完成`、`writing a tool call: <名字> → 调用 <名字> 工具`，认不出就原样显示。`stateLabel` 在 `generating` 分支优先用它，读不到 phase 才回落到「生成回答」。

build129：`10,167,296 B / 2026-10-19 18:21:05 / A6EC9988F2DF9654`，备份 `llamacpp-gui.exe.bak-before-phase`。
## 会话缓存卡说明行间距（用户 m06919，build130）

`.cc-note` 原先是 `margin: 0`，紧贴上面 `dl.facts` 的最后一行。改成 `margin: var(--st-s-4) 0 0`（16px），并把颜色降到 `var(--st-ink-muted)` —— 上游那句是辅助说明，不该跟正文同色。

build130：`10,167,296 B / 2026-10-19 18:30:48 / 1F74EDBC0F3FCC50`，备份 `llamacpp-gui.exe.bak-before-ccnote`。
## 最近请求按模型隔离（用户 m06949，build131）

现象：换一个模型启动后，监控页「最近请求」里还留着上一个模型的记录。

两个来源都要掐：

1. `recentTurns` 是 store 里的全局累加（llama.cpp 侧没有 `/metrics.requests`，只能由 GUI 本地记账），原来不分模型。`RecentTurn` 加 `model: string`，`sendChat` 落行时写入本次请求的 `model`；`MonitoringPage.tsx` 开头把 props 解构成 `allTurns`，再 `useMemo` 过滤出 `turn.model === model` 的行 —— 组件内部后续所有 `recentTurns` 引用自动只看到当前模型的。
2. `App.tsx` 的 `engine` state 在 `activeModel` 变化时没有清空，新模型第一次轮询返回前（最多 2 秒）仍在渲染旧模型的 `live` / `slots` / requests。加一个 `useEffect([activeModel])` 把 `engine` / `engineError` / `engineNote` 一起重置。

build131：`10,167,296 B / 2026-10-19 18:43:30 / 27966867FCBAEDFC`，备份 `llamacpp-gui.exe.bak-before-modelturns`。
## 导航与模型卡片清理（用户 m07007，build132）

三条：
1. 侧栏「模型列表」→「模型」（`src\App.tsx` 的 `TABS`）。
2. 删掉挂在「性能测试」下面的「开始聊天」外链项。它是 `openModelChat()`（打开前门根路径的 llama.cpp 自带 WebUI）的入口；连同 `openChat` 包装函数与 `openModelChat` 的 store 绑定一起删掉，不留死代码。原生聊天页（`ChatPanel`）不受影响。
3. `ModelListPanel` 的模型卡片去掉运行态那个 💬 按钮（原来 `active && chatPort != null` 才显示）。连带清掉只被它使用的 `chatPort` / `chatDisabled` / `webuiOff`（`webuiOff` 是整张卡片的 prop，连声明、外层 useMemo 与传参一起删）。

build132：`10,167,296 B / 2026-10-19 18:53:53 / 24F2F3A70C7B7D0F`，备份 `llamacpp-gui.exe.bak-before-nav`。
## 模型页工具条标题（用户 m07074，build133）

上一轮只改了侧栏标签，模型页工具条上的标题还是「模型列表」（`ModelListPanel.tsx:529`）。改成「模型」；刷新按钮的 title 也顺手改成「刷新模型（重新扫描磁盘）」，免得同一处两个叫法。其余文件里出现「模型列表」的地方都是注释，不是界面文案。

build133：`10,167,296 B / 2026-10-19 18:59:21 / 51D4204E3F516AA9`，备份 `llamacpp-gui.exe.bak-before-toolbartitle`。
## Strata 参数表单：新增三个参数 + 标签校准（build134，2026-10-20 上午）

本轮只动 Strata 参数表（`src\utils\strataParams.ts` 为主，连带 `src\assets\params.json`、`ParamForm.tsx`、`ModelSheets.tsx`、`store.ts`），HANDOVER 当时漏记，这里补上。

**新增三个参数**（都在「速度」组，`defaultEnabled: false`，即默认不写进 args）：

| 参数 | 值 | 说明 |
| --- | --- | --- |
| `--batch`（key `batch`，标签「并发槽位」） | 2 / 4 / 6 / 8，默认 2 | 与 `--slots N` 完全等价；最多 N 个请求同时解码，每槽位有自己的 session、占与主 session 相当的显存。不写 = 单请求 |
| `--conversation-cache-mib`（「会话缓存预算（MiB）」） | 0 / 512 / 1024 / 2048 / 4096，默认 1024 | `--serve` 停放会话占用的物理内存预算；0 = 关闭停放 |
| `--conversation-cache-slots`（「会话缓存槽数」） | 1 / 2 / 4 / 8 / 16，默认 4 | 最多同时停放几个会话，实际占用仍受预算约束 |

**同义 flag 机制**：`FLAG_ALIASES: [alias, key][] = [["--slots", "batch"]]` 追加进 `FLAG_TO_KEY`，再由它反推 `KEY_FLAGS`（key → 所有写法）。`argsToState` 改成「`FLAG_TO_KEY.get(t) === def.key`」判定出现，`stateToArgs` 改成「任何一种写法已在 args 里就不重复追加」。目的：老配置里的 `--slots 4` 不会被当成表单不认识的 flag 原样保留、也不会因为勾选「并发槽位」而写出两个开关。

**标签校准**（只改 `label`，`flag`/`key`/`desc` 不动）：KV 按需增长 → 动态增长 KV、MTP 验证窗口 → 推测解码窗口、草稿续窗概率门槛 → 草稿最小概率、会话检查点数量 → 提示词检查点数、尾部检查点 → 提示词尾部检查点、prefill 分块 → Prefill 分块（token）、专家缓存槽位 → 显存专家缓存槽数、PCIe 带宽份额 → PCIe 专家比例。

build134：`10,167,808 B / 2026-10-20 09:37:42`（该次只重建了 `dist\`，exe 由 `tauri build` 产出；备份见部署脚本）。
## MCP 工具接入：GUI 当 MCP 客户端（用户 m07074 之后的「按规划继续」，build135）

起点：用户 m00001「取消 api 使用统计，按照规划继续执行」→ 澄清「老的性能测试页面（压测）已经整体删除，现在还差的是 mcp 工具接入」→ 形态选定「GUI 当 MCP 客户端」（用户 m00199 进一步把范围收到聊天：MCP 与 web_search 都属聊天功能，所以入口在聊天设置弹层，不进设置页）。

**为什么不用 llama.cpp 自带的 `--mcp-servers-config`**：b11671 原生那套工具在 `llama-server` 进程**内部**执行（`server-mcp.cpp` 把 MCP 工具包成 `server_tool`，由引擎自己的 agent loop 调用），GUI 看不到每次调用，既画不了工具卡片、也没法在 GUI 里管服务器清单。所以 GUI 自己当 MCP 客户端，把工具并进 `tools` 数组，模型给出 `tool_calls` 后由 GUI 执行并回填 —— 与联网搜索完全同一条链路。

**后端：新建 `src-tauri/src/mcp.rs`（748 行，无新依赖，用 `std::process` + 命名管道）**

- 传输：stdio + NDJSON（一行一条 JSON-RPC 2.0），协议版本 `2024-11-05`（`PROTOCOL_VERSION`，`:36`）。Windows 下 `CreateProcess` + 两条匿名管道（`start`，`:193`；非 Windows 走 `command_candidates` 的 `Command`）。
- 配置：`<配置目录>\mcp.json`，形状照 Cursor 的 `{"mcpServers":{"<名字>":{"command","args","env"}}}`（`McpConfig`，`:83`；`load_config` `:92` / `save_config` `:100`）。GUI 里多一个 `enabled`。
- 超时：初始化 20s、`tools/list` 30s、`tools/call` 180s（`:39-42`）；长工具由前端自己控制轮次上限。
- 工具名：`mcp__<服务器>__<工具>`，服务器名与工具名都过 `slug()`（`:454`，非 `[A-Za-z0-9_-]` 换成 `_`），整体超 64 字符（`TOOL_KEY_MAX`）截断，重名由 `assign_keys`（`:471`）加 `_2`/`_3` 后缀。
- 结果归一化 `normalize_result`（`:383`）：`content` 里所有 `type:"text"` 的 `text` 用空行拼接；`isError:true` 加「工具执行出错：」前缀；没有 text 部分就把整段 JSON 当文本（`normalize_result_falls_back_to_json` 有测）。
- 进程表 `manager()`（`:169`）是全局 `Mutex<HashMap<name, Proc>>`，按需启动并缓存 `tools`；`mcp_servers_save` 与退出（`lib.rs:1824`）都调 `stop_all()`（`:637`）—— 改了命令/环境变量必须重连才生效，留着旧进程会重演「改了没反应」。
- 4 个命令（注册在 `lib.rs:12` 的 `mod mcp;` 与 `:1785-1788`）：`mcp_servers_list`（`:496`）、`mcp_servers_save`（`:503`，校验名字唯一/命令非空并清理空 args 与空 env）、`mcp_tools_list`（`:548`，逐台启动、失败只记在 `servers[].error` 不拖垮整片）、`mcp_tool_call`（`:615`）。

**前端**

| 文件 | 改动 |
| --- | --- |
| `src\types.ts` | `McpServerConfig` / `McpToolView`（含 `key`/`server`/`name`/`description`/`inputSchema`）/ `McpToolsView`（`:357`、`:368`） |
| `src\ipc.ts` | `mcpServers` / `mcpSaveServers` / `mcpTools` / `mcpCallTool`（`:156-161`） |
| `src\utils\tools.ts` | `MCP_PREFIX`、`isMcpTool()`、`buildToolSpecs(webSearch, mcpTools = [])`（描述前加 `[服务器名]`）、`describeToolCall` 拆 `mcp__a__b` 显示为 `a · b` |
| `src\utils\chat.ts` | `ChatOptions.mcpTools: boolean`（`:180`，默认 false，`normalizeChatOptions` `:241` 兼容老存档） |
| `src\store.ts` | state `mcpServers` / `mcpTools` / `mcpError`（`:608-613`）；`sendChat` 里 `runTool` 认 `isMcpTool(name)` → 按 `key` 找 `target` → `ipc.mcpCallTool(target.server, target.name, args)`（`:2521-2526`）；开关打开但工具还没拉时先 `mcp_tools_list`（`:2538-2540`）；`buildToolSpecs(state.options.webSearch, mcpTools)`（`:2542`）；`loadMcpServers` / `saveMcpServers` / `refreshMcpTools`（`:2866-2896`） |
| `src\components\ChatMcpSettings.tsx` | 新组件（262 行）：服务器清单编辑（名字 / 命令 / 参数**每行一个** / 环境变量 `KEY=VALUE` 每行一条（只按第一个 `=` 切，值里带 `=` 不截断）/ 启用勾选 / 删除），保存后重新拉工具并显示每台的失败原因 |
| `src\components\ChatSamplingSheet.tsx` | 「MCP 工具」开关（`:237-256`，打开时立刻 `refreshMcpTools()`）；开着才显示「MCP 服务器」折叠区（`:258-269`） |

**测试与验证**

- `mcp.rs` 单测 6 个（slug / assign_keys / normalize 三态 / rpc_error_text）+ 1 个 `#[ignore]` 端到端 `echo_server_roundtrip`：真起 node 跑 `tmp\mcp-echo-server.mjs`（`initialize → tools/list → tools/call`）。手动跑：`cargo test --lib echo_server_roundtrip -- --ignored --nocapture`。
- **顺带修好 5 个既有失败测试**（不是本轮引入，是前面几轮改完没同步期望）：`scheduler::tests` 四个 `build_model_args_*` 补上 `--metrics`（`build_model_args` 现在默认追加，见那处注释）；`models::tests::broken_meta_cache_is_treated_as_absent` 里写死的 `"version":1` 改成 `META_CACHE_VERSION`（缓存版本已升到 3）。
- 验证结果：`cargo test --lib` **119 passed / 8 ignored**；`npx tsc --noEmit` 干净；`npm run build` 与 `npm run tauri build` 均成功。
- 构建环境坑（记一次，省下回查）：受限沙箱下 vite/esbuild 直接 `spawn EPERM`，必须提权跑；提权后 esbuild 在 `%TEMP%` 里删临时文件仍报 `Access is denied` —— 把 `TEMP`/`TMP` 指到工作区内（`E:\Code\llama.cpp-GUI\tmp\temp`）后正常。所以构建命令前面带 `$env:TEMP=...; $env:TMP=...` 更稳。
- **同一个 TEMP 坑会让后端单测成片假失败**：`npm test`（= 根目录跑 `cargo test --lib --manifest-path src-tauri/Cargo.toml`）在沙箱跑过之后会报 24 个失败，全是 `[settings] 写入失败 …: 拒绝访问 (os error 5)` 连带断言读回默认值 —— 是 `%TEMP%\llamacpp-gui-*-test` 被沙箱写了限制性 ACL，**不是代码问题**。同样用 `$env:TEMP=...\tmp\temp` 跑即 119 passed / 8 ignored。README §4 已记。

**版本更正**：实跑的 llama.cpp 已经是 **b11671**（`E:\AI\llamacpp\llama-b11671-bin-win-cuda-13.4-x64\llama-server.exe`，2026-10-16 09:31）。`AGENTS.md` 与本文里先前写的 b11482 及其目录都已不存在，凡涉及参数/行为核对都以 b11671 为准（`--mcp-servers-config` / `--tools` / `--ui-mcp-proxy` 都是 b11671 才有的）。

build135：`10,329,088 B / 2026-10-20 12:50:49 / 4CCF5848829A4AC3`，备份 `llamacpp-gui.exe.bak-before-mcp`（上版 build134 `10,167,808 B`）。

## 联网搜索取全文 + 新增 web_fetch 工具（用户 m00766，build136）

起点：用户 m00766「但是我在聊天中测试联网搜索，感觉联网搜索获取是网页内容不全是啥原因」→ 实测诊断 → 用户 m00819 选定「引擎全文 + 新增 `web_fetch` 深读」。

**根因（三重折叠叠加，不是模型的问题）**

1. 每条结果只用引擎给的 `description` / `snippet`（一两句话），且 `SNIPPET_MAX` 写死 800 字符；
2. `clip()` 把换行全压平成一行，段落结构丢失；
3. 没有「读整页」这条路 —— 模型想看正文也没工具可用。

实测（curl 直打各引擎）：tavily 的 `raw_content` 是整页 markdown（单条 18,246 字符）、firecrawl v2 `data.web[].markdown` 34k 字符、anysearch `snippet` 仅 125–434 字符（另有略长的 `content`）、keenable `snippet` 可达 2,503 字符。

**后端 `src-tauri/src/search.rs`（1288 → 1803 行，无新依赖）**

- 常量：`SNIPPET_MAX` 800 → **4_000**（`:40`）；`BLOCK_MAX` 24_000 改成按**字符**计数（原先 `entry.len()` 按字节，中文被算 3 倍）；新增 `FETCH_MAX` 12_000（`:44`）、`FETCH_MAX_BYTES` 8_000_000（`:46`）、`FETCH_UA`（`:48`）。
- `clean_body`（`:451`）替代 `clip`：保留段落换行（连续空行压成一个、行内空白折叠），并按字符截断。`link_only`（`:438`）把「除了 markdown 链接没别的字」的行整行丢掉 —— 引擎给的整页 markdown 开头常有几百行站点导航，不清掉的话 4 千字符全被菜单吃掉（实测 GitHub 页前 800 字符全是 Navigation/登录链接）。
- 各引擎改成优先要正文：anysearch 取 `snippet` 与 `content` 里较长的；tavily body 加 `include_raw_content: true`、取 `raw_content` 回退 `content`；firecrawl body 加 `scrapeOptions: { formats: ["markdown"] }`、取 `markdown` 回退 `description`；keenable 的 `snippet` 走 `clean_body`；exa body 加 `contents.text.maxCharacters = SNIPPET_MAX`、取 `text` 回退 `highlights`。
- 新 section「网页正文抓取（web_fetch）」（`:1270-1620`）：
  - `http_get`（`:1450`）：系统 `curl.exe`，`-sS -L --compressed --max-time 30 --connect-timeout 8 --max-filesize 8MB -D 头文件 -o 体文件 -w "%{http_code} %{url_effective}"`；**先自己 `fs::write` 建两个临时文件**再交给 curl —— 否则 curl 只回一个 `(23) Failed writing received data`，分不清「目录不可写」和「参数错」。
  - `HtmlRules`（`:1293`）/`decode_entities`（`:1342`，常见命名实体 + 十进制/十六进制实体）/`extract_title`（`:1394`）/`html_to_text`（`:1404`）：删 comment/script/style/svg/noscript/template/head → 整块删 nav/header/footer/aside → **有 `<article>`/`<main>` 就只取它**（内部 >500 字符才认）→ 块级标签转换行 → 其余标签换**空格**（换成空串会让 `Sign in` 与下一个链接粘成一个词）→ 实体解码。
  - `fetch_page`（`:1542`）：scheme 只认 http/https，`>=400` 报错、空体报错、非 UTF-8 走 lossy 并附 note（GBK 老站点仍是乱码）、按 `max_chars`（默认/上限 12k）截断、结果包 `<untrusted-web-content>` 边界后放进 `block`。
  - 命令 `web_fetch`（`:1611`，`spawn_blocking`），注册在 `lib.rs:1785`。
- 端到端实测（`cargo test --lib fetch_page_roundtrip -- --ignored --nocapture`）：`raw.githubusercontent.com/.../b11671/docs/build.md` → 200 / 3009 字符 / 正文从 `# Build llama.cpp locally` 开始；`github.com/ggml-org/llama.cpp` → 标题正确 / 3009 字符 / 正文从 `llama.cpp / LLM inference in C/C++ / Quick start` 开始（导航全清掉）。

**前端**

| 文件 | 改动 |
| --- | --- |
| `src\types.ts` | `FetchPage`（`SearchTestResult` 之后）：`url`/`finalUrl`/`status`/`title`/`contentType`/`chars`/`truncated`/`block`/`note` |
| `src\ipc.ts` | `webFetch(url, maxChars?)`（`:155`，invoke 参数名 `maxChars`） |
| `src\utils\tools.ts` | `WEB_FETCH_TOOL`（`:45`，参数 `url` / `maxChars` 1000–12000）；`buildToolSpecs(webSearch, mcpTools = [], webFetch = webSearch)`（`:72`，跟随联网搜索开关）；`TOOL_LABEL.web_fetch = "读网页"`（`:129`）；`describeToolCall` 对 web_fetch 显示 URL；`web_search` 描述补「最相关那条被截断时再用 web_fetch」 |
| `src\store.ts` | `runTool` 加 `web_fetch` 分支（`:2519`）→ `ipc.webFetch`，note = `域名 · N 字符 · 已截断`；同一次发送重复抓同一 URL 由 `fetched` 集合挡掉（`:2566`、`:2640`、`:2652`）；`trimConversation` 落盘时工具结果只留前 2000 字符（`TOOL_RESULT_KEEP`，`:311`） |
| `src\components\ChatMessageView.tsx` | 无需改：卡片标题走 `toolTitle()`、副标题走 `describeToolCall()`，`web_fetch` 自动显示「读网页 + URL」 |

**为什么工具结果落盘要截断**：会话存 localStorage（30 条 × 200 消息，配额 5 MB），一条 `web_fetch` 就是 12k 字符。不截断的话几轮下来配额写满，`localStorage.setItem` 抛的 `QuotaExceededError` 被 `catch` 吞掉，连设置、主题都会静默存不进去。历史里的工具结果是给人看的展示副本，模型当时已经拿到全文。

**测试**：新增 8 个单测（`clean_body_drops_link_only_lines`、`clean_body_keeps_line_breaks_and_truncates`、`html_to_text_drops_scripts_and_keeps_text`、`html_to_text_prefers_article_and_drops_nav`、`entities_are_decoded`、`fetch_page_rejects_non_http_scheme`、`dedupe_prefers_the_longer_body`、`rich_enough_rejects_short_snippets`）+ 1 个 `#[ignore]` 端到端 `fetch_page_roundtrip`。`cargo test --lib` **127 passed / 0 failed / 9 ignored**；`npx tsc --noEmit` 干净。

**环境坑（新，重要）**：`cargo test` 里 `std::env::temp_dir()` + `fs::write` 在 DSH 沙箱下报 `拒绝访问。 (os error 5)` —— 不是代码问题，跑测试前把临时目录指到工作区：`$env:TEMP='E:\Code\llama.cpp-GUI\tmp'; $env:TMP=$env:TEMP`。另外 `en.wikipedia.org` 直连会被重置（`curl: (35) Recv failure`），端到端测试改用 `github.com/ggml-org/llama.cpp`；`raw.githubusercontent.com` 偶发同样重置，重跑即可。

**为什么默认配置下只能拿到短摘要（补记，build137）**：默认 `order` 里 `anysearch` 排第一，而它无论要多少条都只给 10 条、每条摘要一两百字符。原来 `dedupe()` 只留**第一条**同 URL 结果，`search()` 又只按「条数凑满 `limit`」判断收工 —— anysearch 一个引擎就能装满 `limit=10`，后面 tavily/firecrawl 的整页正文永远轮不到。用户 m00766 的「内容不全」在默认配置下主要是这一条，不只是 800 字符截断。改了两处：

- `dedupe()`（`:915`）同 URL 改成留**正文更长**的那条（顺序仍按第一次出现）；
- 新增 `rich_enough()`（`:943`，`RICH_ENOUGH = 800` 平均字符，`:44`）：条数凑满之外还要求这批结果平均每条有实质正文，不够就继续叠下一个引擎；缓存命中也要过这道判据，旧缓存里的短摘要会被当成未命中重新去搜。

代价：默认配置下每次搜索会多打一个引擎（anysearch 之后必然再试 tavily 或 keenable），延迟多 1–2 秒。

**已知边界**：`web_fetch` 只吃正文页（登录墙/反爬站点会拿到 403 或错误页正文）；GBK 页面只有 lossy 文本 + note；搜索结果的 HTTP 缓存现在存的是含正文的 hits（内存，未设字节上限）。

build136：`10,404,352 B / 2026-10-20 13:18:49 / AAFCBF7513181EB2`，备份 `llamacpp-gui.exe.bak-before-webfetch`（上版 build135 `10,329,088 B`）。

build137（dedupe 留长正文 + `rich_enough` 叠加判据）：`10,409,984 B / 2026-10-20 13:24:53 / 8B14EA8442C403F2`，备份 `llamacpp-gui.exe.bak-before-dedupe`（上版 build136 `10,404,352 B`）。

### build138：`web_fetch` 的 AnySearch `/v1/extract` 兜底

用户指出 AnySearch 官网声称能提取网页正文（m01231）。**对，但那是独立端点，不是搜索参数**：

- `POST https://api.anysearch.com/v1/extract`，body 严格是 `{"url": "..."}`（只一个非空字符串字段，不许未知字段、上限 16 KiB），回 `data.title` + `data.content`（markdown 或纯文本）。错误：400 URL 无效、401 凭据错、402 额度用完、403 key 过期/禁用、422 提取不到、429 限流。
- `/v1/search` 没有取正文的参数（`query`/`max_results`/`tag`/`zone`/`language`/`params`/`format`），它回的 `content` 就是「清洗过的结果片段」（实测 100–400 字符），`format: "markdown"` 只改格式不改体量。所以搜索接口拿不到整页正文这件事没变。

实测（`curl` 直打，脚本产物在 `tmp\as\`）：

| URL | 结果 |
| --- | --- |
| `github.com/ggml-org/llama.cpp` | 26,877 字符 markdown，含 «Skip to content / You signed in…» 导航噪声 |
| `raw.githubusercontent.com/.../b11671/docs/build.md` | 44,370 字符，正文完整 |
| `tauri.app/start` | 4,987 字符 markdown，少量导航噪声 |
| `lobehub.com/docs/usage/start` | **206 字符**（React Router 占位）—— **不做 JS 渲染** |
| `example.com`（不带 key） | 156 字符，**匿名可用**（按 IP 限额，与带 key 结果一致） |

结论与实现：不替换自写提取（`<article>` 优先更干净、快、不烧额度、GitHub 页我们 3009 字符全是正文而 extract 要夹着导航），改成**兜底** —— `fetch_own`（`:1594`）抛错、或洗出来的正文短于 `FETCH_MIN_USEFUL = 400`（`:56`）时调 `anysearch_extract`（`:1641`，带 key 优先、401/403 退回匿名），取正文更长的那份，`note` 标「正文由 AnySearch 提取」（前端工具卡片副标题已经会显示 `page.note`）。判定函数 `should_fallback`（`:1696`）单独可测。

测试：新增 `should_fallback_when_missing_or_short` + `#[ignore]` 端到端 `anysearch_extract_roundtrip`（匿名打 `example.com`，实测 title `Example Domain` / 156 字符 / 0.85 s）；`fetch_page_roundtrip` 顺带加了 `lobehub` 的 SPA 场景。`cargo test --lib` **128 passed / 0 failed / 10 ignored**。

build138：`10,419,200 B / 2026-10-20 13:34:48 / F49B3B91F7BBE0A7`，备份 `llamacpp-gui.exe.bak-before-extract`（上版 build137 `10,409,984 B`）。

## 聊天「第一次对话自动换模型」：发送与显示判据对齐 + 前门请求日志（用户 m01516，build139）

用户报「聊天界面第一次对话为啥自动更换了模型」，查日志（`logs\gui-20261020-133846.log`）得到时间线：

- 13:39:35 手动启动 `OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL`（:8222），13:39:39 就绪；
- 13:39:58.573 `POST /v1/chat/completions`；
- **13:39:58.575**（2 ms 后）`[gui] 已满 1 个模型，先停掉最久未用的 OpenBMB-Sharp-MiniCPM5-2B-Q6_K_XL` → 停 Sharp、起 `prism-ml/Ternary-Bonsai-2-9B`（:8220）。

即：模型不是自己换的，是**第一条聊天请求里 `model` 就是 Ternary-Bonsai**。根因是两处判据不一致：

- 输入框显示（`src/components/ChatPanel.tsx:143`）：`chat.options.model && runningModels.includes(...)` 才用，否则退回 `runningModels[0]`；
- 发送（`src/store.ts:2422`，原）：`state.options.model.trim() || loaded[0]` —— 只认持久化的记住值，不校验它是否还在运行。

于是跨会话残留的模型名（用户之前在采样设置里选过 Ternary-Bonsai 并落盘）在输入框显示 Sharp 的同时被发进请求，前门按请求体点名 `ensure_ready` → `models_max=1` 触发容量闸停旧起新，观感就是「模型自己换了」。

修法：`sendChat` 改成与显示同一判据 —— `remembered && loaded.includes(remembered) ? remembered : loaded[0] || ""`。连同采样面板一起对齐：`ChatSamplingSheet` 的模型下拉原来列的是**全部候选 config**，选了没加载的模型会存进 `options.model` 却在发送时被新判据忽略（静默不生效），现在改成 `models={runningModels}` 并加一行提示「只列正在运行的模型；要换模型先去模型页加载」。

另外补了**前门默认日志**（`src-tauri/src/strata_proxy.rs::serve_llama`）：`[前门] 请求模型 <name> → 已就绪实例 / 启动子实例 :<port>`。以前这类信息只有 `STRATA_PROXY_DEBUG` 下的 `dbg()` 才有，日志里查不到「这次请求打的是哪个模型」。为避免监控页每 2 秒的 `/metrics?model=…`、`/slots?model=…` 轮询刷屏，只记「本次要起引擎（`!was_ready`）」和 POST 请求。

排查附带两条经验：

- **日志文件在资源管理器里可能显示 0 字节**：GUI 进程一直持着句柄，NTFS 元数据滞后；用共享句柄读（`[System.IO.File]::Open($p,'Open','Read','ReadWrite')`）能读到真实内容（当时实际 81,190 B / 959 行）。
- `models_max=1` 会放大切换代价：任何「显示一个、请求另一个」的不一致都会变成一次冷启动（实测前门连接耗时 1–6.4 s）。

验证：`cargo test --lib` **128 passed / 0 failed / 10 ignored**，`npx tsc --noEmit` 无输出。

build139：`10,418,688 B / 2026-10-20 14:00:30 / A5880DB0D7B86CB7`，备份 `llamacpp-gui.exe.bak-before-modelpick`（上版 build138 `10,419,200 B`）。

## 模型卡左栏改造：精简 + config 原文可编辑（用户 m01644 / m01689，build140）

两个通道的模型卡弹层各改一处，只动前端（`src/components/ModelSheets.tsx`、`src/components/StrataPanel.tsx`、`src/styles/components.css` 各一段），后端零改动。

**llama.cpp 通道 `ConfigSheet`**：
- 字段改名（用户 m01644 第 1、2 点）：「模型名（同时作为 router 模型名）」→「**模型别名**」，「配置名（router 模型名）」→「**模型id**」。
- 左栏说明文本全部删除（第 3 点）：模型名下方的「改这里会同时改掉配置文件里的模型名…」、`alias !== cleanedAlias` 的净化警告小字、多模态开关的状态说明、主 GPU 的「写进配置的是设备下标…」、设备勾选的「不勾选 = 使用全部显卡…」、显存预估的单位与 stale 说明（`fitHint`）。
- 保留的都不是说明而是状态/数据：模型文件路径（`form-text mono`）、`staleMainGpu` 的告警（下标对不上设备时）、显存表里的「未计入：…」与「没有解析到结果」。
- 连带删掉只服务这些文案的变量：`cleanedAlias`、`fitStale`、`fitEnvStale`、`fitHint`，以及 `sanitizeSectionName` 的 import（`noUnusedLocals: true` 会把它们报成 TS6133）。

**Strata 通道 `StrataConfigSheet`**（用户 m01644 第 4 点）：
- 左栏原来画「这个 config（只读）」三张 InfoCard（引擎版本 / config 文件 / run 脚本）+「启动参数现状」逐行 arg 列表，**整块删掉**，换成一份 **config 原文 textarea**（`#strataRawConfig`，类 `.strata-raw`，撑满左栏高度、`white-space: pre`、等宽）。
- 双向映射：右栏 `ParamForm` 的 `onChange` 改走 `onFormChange` —— 每次改参数就用 `stateToConfig(formConfig, nextState, strataRoot)` 重算整份 config 并序列化进左栏，所以左栏看到的**就是「写回 config」将要写的内容**；反过来直接改左栏文本走 `onRawChange`，`JSON.parse` 成功就 `setFormConfig` + `setFormState(configToState(obj))`（右栏随即跟着变），解析失败只在下方显示错误、**不动表单**。
- 语法错误保护：`save()` 开头检查 `rawError`，非空就拒绝写回并提示「config 原文有语法错误，修正后再写回」——否则会用上一次解析成功的表单覆盖用户刚打的文本，看着像「改了没生效」。
- 移动端两个切换按钮文案「这个 config」→「config 原文」。
- 新增 CSS（`src/styles/components.css`，全 token）：`.strata-raw-pane`（flex 列、`height:100%`、`min-height:0`）+ `.strata-raw`（`flex:1`、`min-height:320px`、`resize:none`、`white-space:pre`、`tab-size:2`、`--st-font-mono`、`--st-fs-sm`、`text-align:left`）。

**Strata 通道 `StrataDetailSheet`**（用户 m01689）：config 原文改 **只读**（`readOnly`，无 `onChange`），删掉「写回 config」按钮、`save()`、`original` 状态与关闭前的未保存询问；说明文案改成「只读展示。要改参数请点这张卡片的「配置」」。`busy` 与 `writeStrataConfig` 在这条路径上不再使用。

验证：`npx tsc --noEmit` 无输出（exit 0）。后端未动，未重跑 `cargo test`。

build140：`10,417,664 B / 2026-10-20 17:59:19 / 47325BE3AC265880`，备份 `llamacpp-gui.exe.bak-before-modelcards`（上版 build139 `10,418,688 B`）。

## 压测期间监控页速度/最近请求为空 + Strata「停止」连引擎一起收（用户 m00001 / m00279 / m00373，0.3.4，未打包）

现象（用户 m00001，m00279 补充场景）：性能测试 → **上下文压测**跑起来后，监控页「解码速度」「预填充速度」两张卡都没有数，「最近请求」表只有空态文案。

根因三条：
- 速度卡只认 `lastTurn`（`utils/telemetry.ts::buildLiveMetric`）。压测走 `store.runContextBench` → `api/chat.ts::streamChat`，结果只写 `contextBench.samples` 与历史，**从不写 `lastTurn` / `recentTurns`**。而 llama.cpp 的 `/metrics` 早就把实时速度作为 gauge 报出来（`llamacpp:predicted_tokens_seconds` / `llamacpp:prompt_tokens_seconds`，HELP 写明 "tokens/s"），后端 `monitor.rs::parse_prometheus` 却**没有解析这两个字段**，前端没有引擎侧数值可回落。
- 「最近请求」表只由 `sendChat` 收尾写入，压测请求根本不进表；空态文案还只写「还没有请求」，看不出「这里只记本应用发出的请求」。
- `refreshMonitor` 的 `tokS` 门控只看 `chat.streaming`，压测期间每秒推 `null`，折线断掉。

修法（`src-tauri/src/monitor.rs`、`src/store.ts`、`src/components/MonitoringPage.tsx`）：
- `parse_prometheus` 新增 `predictedTokS` / `promptTokS`；单测 `prometheus_metrics_are_parsed` 追加两行样例并断言 `19.6849` / `70.6986`。
- 速度卡回落顺序改为「引擎 gauge（>0 才用）→ 本地 `lastTurn`」：`rawLive?.tok_s ?? enginePredictedTokS ?? live?.decodeTokS`，输入处理同理；`cards` 的 useMemo 依赖补 `metrics`。
- `runContextBench` 每条样本写一行 `RecentTurn`（复用 `RECENT_TURN_LIMIT`、顺带更新 `lastTurn`）；`refreshMonitor` 的 `tokS` 门控带上 `contextBench.running` / `scenarioBench.running`。
- 空态文案区分通道：llama.cpp 侧说清「只记本应用聊天页与压测；自带 WebUI / 其它客户端不进来，速度看上方的卡」。

Strata 侧（用户 m00373：「strata模型卸载后引擎还在，不像 llama.cpp 模型卸载后引擎也卸了」）：`stopStrataModel` 原来只 `POST /unload`，进程留着。改成 `/unload` 之后再对 `running && !external` 的实例调 `strata_stop` 收进程树；外部启动的实例不动（`lib.rs::strata_stop` 在槽位为空时报「不是由本 GUI 启动的，请在它自己的控制台里停止」）。`startModel` 的**自动显存互斥**保持只 `/unload` —— 那是系统替用户腾地方，不能顺手关掉用户正开着的 WebUI，注释已钉住。卡片文案与 tooltip 改「停止（卸载后引擎一并退出）」，`HANDOVER.md` §2.11 原「按钮管模型不管进程」条目按此改写。

验证：`npx tsc --noEmit` 无输出；`cd src-tauri; cargo test --lib` **173 passed / 18 ignored**（与 0.3.3 基线一致）。用户明确要求**不打安装包**，所以本轮只到源码 + 文档，没有 build 号。版本升 0.3.4（`package.json` / `Cargo.toml` / `tauri.conf.json` / `Cargo.lock` / `README.md` / `HANDOVER.md` / `ENGINE-INSTALL-AND-UPGRADE.md`）。

## 0.3.4 审查后的修补（用户 m00585「对当前版本的代码进行审查」）

自查 + 独立复核跑出来、这次一并修掉的：

- `runContextBench` 的 `decodeMs` 写成 `result.wallMs - (result.firstTokenMs ?? result.wallMs)`：没有 TTFT 时差值为 0、被 `Math.max(1, …)` 压成 1ms，兜底速度变成 `completion × 1000`。改成 `?? 0`。同时失败/中止的样本行不再带尝试中残留的数据 —— attempt0 成功、attempt1 抛错时 `result` 仍是第一次的值，原样写进「最近请求」会出现「标着失败却 tokens 与速度齐全」的行，和 `sendChat` 的失败行口径不一致。
- `runScenarioBench` 每条样本也写 `lastTurn`（不写 `recentTurns`，免得几十条样本把 12 行的表冲空）；`prefillTokS` 折线补上与 `tokS` 相同的门控（原先空闲期每秒重复推最近值，折线走成一条假水平线）。
- `stopStrataModel` 的文案按真实结果分支：外部实例不再谎称「引擎已退出」；`strataStop` 失败的 catch 改成「已卸载模型，但引擎没有停下来」（原来一律说成「引擎是外部启动的」，而外部实例在上一行就被 `!external` 挡掉了）。引擎状态取卸载后的最新快照，不再用 await 前的快照判断。
- `MonitorEngine.metrics` 从 `unknown` 收窄成 `EngineMetrics`（带索引签名），`predictedTokS` 之类的键名拼错 tsc 会报；`monitor.rs` 补两条单测钉住前端回落依赖的两个契约：空闲时 gauge 为 `0` 要读出 `Some(0.0)`、键缺失要读出 `null`。
- 监控页的通道判定改用 `channel` prop（`App.tsx` 由 `strataEntries` 匹配推出），不再从 `metrics.requests` 反推：引擎指标拿不到时（`metrics` 为 null）原先会掉回 llama.cpp 分支，Strata 页显示成 llama.cpp 的专属空态文案。
- 顺手：`MonitoringPage.tsx` 里多余的 `as Record<string, unknown>` 断言与错位缩进、`StrataPanel.tsx` / `ModelListPanel.tsx` 里仍叫「卸载中」的注释。

验证：`npx tsc --noEmit` 无输出；`cd src-tauri; cargo test --lib` **175 passed / 18 ignored**（比上一轮多 2 条新单测）。仍未打包。
