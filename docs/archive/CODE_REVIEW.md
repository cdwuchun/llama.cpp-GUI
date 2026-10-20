# llama.cpp-GUI 代码审查报告

> **状态：历史存档（0.1.x，审查日期 2026-10-11）** —— 0.1.2 → 0.2.0 的重构已经合并了本报告的大部分修复（router 废弃与 `router.rs` 改名 `logs.rs`、presets.ini 退役、`http.rs` 超时、`store.ts` 拆分等），文件中引用的行号与文件（如 `router.rs`）已不再对应当前代码。读它只为理解「当时为什么这么改」，**不要按行号回查**；现状以 `HANDOVER.md` 为准。

审查对象：`E:\Code\llama.cpp-GUI`（Tauri 2 + React 19 + Rust 后端，Windows 便携模式）
审查方式：全量静态阅读 + 跨层契约自动比对 + 实测（tsc / cargo test）+ 四个并行子审查
本报告只记录**已读过代码**的结论；标注「待确认」的条目缺少实测证据，已单独列出。

---

## 0. 审查范围与实测结果

### 实测命令与结果

| 检查 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `npx tsc --noEmit` | EXIT=0，无错误 |
| 后端单测 | `cd src-tauri && cargo test --lib --offline` | **93 passed / 0 failed / 5 ignored**（中危修复后实测；84 → H1–H6 后 86 → 中危后 93，共新增 9 条测试） |
| 前后端命令契约 | 脚本比对 `invoke(` 与 `generate_handler!` | **46 : 46，完全一致**，无缺失/无死命令 |
| 前后端事件契约 | 脚本比对 `app.emit(` 与 `listen(` | **5 : 5 一致**（`models://scanned`/`router://status`/`strata://status`/`tray://command`/`logs://lines`） |
| 参数表单 schema | `src/assets/params.json` | 82 参数 / 10 分组，无 router 专属键，`spec-type_ngram-*` 已正确改为 mergeInto |

### 规模（总行数，实测 · 中危修复完成后重新统计）

后端：`models.rs` 3152、`lib.rs` 1603、`strata.rs` 1014、`router.rs` 708、`settings.rs` 863、`gpu.rs` 551、`versions.rs` 442、`bench.rs` 404、`winfix.rs` 295、`idle.rs` 181、`paths.rs` 125、`tray.rs` 192、`http.rs` 121、`state.rs` 298。

前端：`styles/legacy/index.css` 4276、`styles/app.css` 1502、`store.ts` 1224、`StrataPanel.tsx` 972、`ModelSheets.tsx` 941、`ParamForm.tsx` 809、`SettingsPanel.tsx` 738、`BenchPanel.tsx` 652、`ModelListPanel.tsx` 608、`utils/strataParams.ts` 548、`types.ts` 396、`App.tsx` 314、`utils/models.ts` 340、`api/router.ts` 248、`utils/paramSchema.ts` 208。

### 健壮性统计（后端非测试段，实测）

- `.unwrap()`：**0 处**
- `.expect()`：**4 处**（`models.rs:557/563/568` 三处正则编译常量 + `lib.rs:1537` 建 Tauri 应用；其余都在 `#[cfg(test)]` 里）
- `.unwrap_or*`：115 处
- 锁中毒：**已全部统一**为 `unwrap_or_else(|e| e.into_inner())`（中危 M5 修掉了原先 `lib.rs:707-710/1279/1289` 几处不一致的写法）

### 环境事实

- **仓库没有 git（`.git` 不存在）** —— 无版本历史、无 diff/blame 可依据，回滚只能靠手工备份。
- node v25.2.1 / npm 11.6.2 / cargo 1.98.1 / rustc 1.98.1。
- 无 `.github/`（无 CI）。
- `package.json` 无 `test` 脚本；`build` = `tsc --noEmit && vite build`。

---

## 1. 结论摘要（按修复优先级）

> 下表是**审查当时**的问题清单与定级（行号为修复前位置）。目前全部条目都已修复：H1–H6 见 §1.1，M1–M25 见 §1.2；只剩 §7 第 13 项「仓库与文档卫生」未做。

| 级别 | 问题 | 位置 |
|---|---|---|
| **P0** | settings.json 读取失败静默回落默认值，随后任意写盘把全量设置覆盖 | `settings.rs:300-304` + `settings.rs:324-332`（触发点 `lib.rs:755`） |
| **P0** | router/strata 的「检查—启动—登记」非原子，并发可拉起第二个实例，先启动者成孤儿进程（占端口/显存，GUI 停不掉） | `lib.rs:187-192`→`288`、`lib.rs:500-505`→`532` |
| **P0** | 保存模型配置失败时调用方收不到信号，仍继续删掉旧段并启动 → 该模型的全部参数永久丢失 | `ModelSheets.tsx:371-386`、`store.ts:966-979` |
| **P0** | 模型根目录输入框的 React key 含被编辑的值 → 每敲一个字符就丢焦点，该字段实际无法手工编辑 | `SettingsPanel.tsx:356-368` |
| **P1** | preset 写入有两条路径未串行化 / 临时文件名固定：`preset_import_hub` 漏 `preset_lock`，`write_preset` 固定 `presets.ini.tmp`，并发时半截内容被 rename 成正式文件，且 `.bak` 被顶掉 | `lib.rs:1040-1060`、`models.rs:1390-1396` |
| **P1** | 托盘创建失败只写 stderr，而 `minimize_to_tray` 默认 true → 关窗即隐藏且无托盘可恢复（`--minimized` 自启动时用户完全看不到窗口） | `lib.rs:1231-1234`、`lib.rs:1250-1275` |
| **P1** | `strata_probe` 每 5 秒在 async 命令里做全量同步扫描（read_dir + 解析 config + 读 GGUF 头），无 `spawn_blocking`/无 TTL 缓存 | `lib.rs:373-397`、`strata.rs:707-744`、`store.ts:299-302,901` |
| **P2** | 删除/归档 preset 段时会连带删掉「下一段头上方的注释与空行」，而归档不保存注释 → 用户手写注释永久丢失 | `models.rs:1215-1227`、`models.rs:1335-1346` |
| **P1** | 安装包卸载钩子缺 `$UpdateMode` 守卫 + 文案未披露会删 `runtime/`（用户自下载的 llama.cpp 可达数十 GB）与 `%APPDATA%`，覆盖安装时会问「是否删除用户数据」 | `src-tauri/nsis/hooks.nsh:38-53`、`hooks.nsh:30,44-50` |
| **P2** | SSE 断线重连的失败计数在异常路径不重置，长时间稳定连接后一次断网就可能永久停订 | `src/api/router.ts:148-170` |
| **P2** | 前端 `init()` 失败后不可重试，且事件订阅可能整体未注册 → 实时状态/日志永久不更新 | `src/store.ts:216-309` |

---

## 1.1 本轮已修复（H1–H6）

修复后实测：`npx tsc --noEmit` EXIT=0；`cd src-tauri && cargo test --lib --offline` **86 passed / 0 failed / 5 ignored**（修前 84，新增 2 条针对 H1 的测试）。H4 无法用单测覆盖，改用 `makensis /INPUTCHARSET UTF8` 做了真实语法编译（EXIT=0）。

| 项 | 改动 | 位置 | 验证 |
|---|---|---|---|
| **H1** | 区分「文件不存在／读不出来／内容坏掉」三种情况：读不出来 → 本次运行**禁止落盘**（`read_only`，避免拿默认值覆盖用户文件）；内容坏掉 → 原文件改名留档为 `settings.json.corrupt-<unix 秒>` 并尝试从 `.bak` 恢复；`persist` 每次覆盖前先留 `.bak`；启动时把情况写进系统日志 | `src-tauri/src/settings.rs`（`LoadIssue` / `load` / `persist` / `load_issue_message`）、`src-tauri/src/lib.rs:1184` | 新增 `corrupt_file_is_quarantined_and_recovered_from_backup`、`unreadable_file_makes_store_read_only`；原 `corrupt_file_falls_back_to_default` 仍通过 |
| **H2** | `AppState` 新增 `starting: Arc<Mutex<HashSet<&'static str>>>` 与 RAII `StartGuard`（`Drop` 自动释放，避免某条 `?` 提前返回把占位永久卡住）；`router_start` / `strata_start` 在查空槽**之后、任何耗时动作之前**占位，拿不到就返回「正在启动中，请稍候」 | `src-tauri/src/state.rs:106`（`begin_start` + `StartGuard`）、`src-tauri/src/lib.rs:196`（router）、`src-tauri/src/lib.rs:514`（strata） | 编译 + 全量单测通过（未写单测：需要真实 `AppState` 与子进程） |
| **H3** | `write_preset` 的临时文件名改为 `presets.ini.<pid>.<seq>.tmp`（不再固定，两个并发写最多是「后写的赢」，不会把半截内容 rename 成正式文件）；`preset_import_hub` 补上 `preset_lock`（此前是唯一漏锁的 preset 写入者） | `src-tauri/src/models.rs` `write_preset`、`src-tauri/src/lib.rs` `preset_import_hub` | 编译 + 单测通过 |
| **H4** | 两个宏都加 `$UpdateMode = 1` 早退（覆盖安装时不再询问、更不删除）；递归删除前用 `${FileExists} "$INSTDIR\presets"` 等标记确认确实是本应用的安装目录（`$INSTDIR` 为空时不再退化成「盘根\runtime」）；**删掉**与模板重复的 `$APPDATA`/`$LOCALAPPDATA` 清理（模板那份已挂在「删除应用数据」复选框 + `$UpdateMode` 守卫上，重复删除等于绕过复选框）；弹窗文案补上 `runtime/`（用户自下载/编译的 llama.cpp，数十 GB） | `src-tauri/nsis/hooks.nsh`（整文件重写，54 → 约 100 行） | `makensis` 编译 EXIT=0 |
| **H5** | `saveModelSection` 改为返回 `Promise<boolean>`（照 `saveSettings` 的样式）；`ModelSheets.save()` 改成**先写 preset、失败立刻 `return null`**，成功后才改 `aliases`、删旧段、按新名字重载 | `src/store.ts:968`、`src/components/ModelSheets.tsx:368` | `npx tsc --noEmit` EXIT=0 |
| **H6** | 模型根目录行的 `key={`${root}-${i}`}` → `key={i}`（key 里不能放正在被编辑的值） | `src/components/SettingsPanel.tsx:361` | `npx tsc --noEmit` EXIT=0 |

修复过程中新发现的两条：

- **H4 的生效范围是「本版之后」**：升级时被调起来的是**旧版本自带的卸载器**（`installer.nsi:352` 以 `/UPDATE` 调它），所以从旧版升级到本版时，仍会遇到一次没有守卫的弹窗；本版之后的升级才安全。发布说明里值得提一句。
- **LogicLib 没有 `${DirExists}`**：写成 `${DirExists}` 不会报「未定义宏」，而是让 `_If` 的宏参数错位，最后以 `!insertmacro: macro "_If" requires 4 parameter(s), passed 3` 收场（本次由 makensis 校验抓出）。判断目录是否存在要用 `${FileExists}` —— `IfFileExists` 对目录同样为真。

---

## 1.2 中危 M1–M25 已修复（本轮）

修复后实测：`npx tsc --noEmit` **EXIT=0**；`cd src-tauri && cargo test --lib --offline` **93 passed / 0 failed / 5 ignored**（中危修复前基线 86，新增 7 条测试，全部落在 `models.rs` / `settings.rs`）。

> ⚠️ **本轮没有构建级验证**：`npx vite build` 在本次沙箱内起不了 esbuild 子进程（`Error: spawn EPERM` at `node_modules/esbuild/lib/main.js:2272`，`vite.config` 都没加载）。交付前请在本机正常环境补一次 `npm run build`。

后端分两路实现（`models.rs`/`settings.rs` 与 `lib.rs`/`tray.rs`/`state.rs`/`strata.rs`），前端组件层一路；三路都由审查者**逐条读回源码复核**，并在复核后自行追加修掉 8 处（下表以 ★ 标出）。

### 后端

| 项 | 改动 | 位置 |
|---|---|---|
| **M1** | 托盘创建结果写进 `AppState.tray_available`（默认 `true`：默认 `false` 会让「关窗回调比 `tray::init` 早跑一次」把默认行为弄丢）；关窗回调只在「托盘真的建起来」时才 `prevent_close + hide`。<br>★ 审查者补充：`--minimized` 自启动的 `hide()` 原本**没有**守卫 —— 托盘不可用时开机后既没有窗口、也没有托盘图标可点，现在这种情况不隐藏窗口 | `state.rs:51-56,205-212`、`lib.rs:1371-1385`、`lib.rs:1420-1443`、★`lib.rs:1413-1429` |
| **M2** | 端口探测（每端口最长 3 秒）挪进 `spawn_blocking`；config 扫描加 5 秒 TTL 缓存（键含 root）。<br>★ 审查者补充：**config 扫描本身仍在 async 上下文**（`strata_probe` 是每 5 秒一次的常驻轮询），现已把「取缓存 → 未命中则真扫 → 算探测目标」整体移进同一个阻塞线程；缓存未命中时才在闭包内 `try_state` 取 `AppState` | `state.rs:63-68,84-93,252-285`、★`lib.rs:398-462` |
| **M3** | 新增 `section_removal_bounds` + `is_blank_or_comment`：段尾只吃到「段内最后一个非空非注释行」，下一段头上方的注释与空行不再被连带删除 | `models.rs:1339,1357,1515` |
| **M4** | `restore_archived_sections` 把 `list_sections` 与 `read_archive` 提到循环外各做一次（原来每个模型都重读全文/重解析归档）；归档读失败时整轮不恢复而不是当空归档 | `models.rs:300-320` |
| **M5** | 锁中毒统一 `lock().unwrap_or_else(\|e\| e.into_inner())`，共 4 处（比报告多一处：setup 里初始化 `monitors` 缓存的那处「拿不到锁就静默跳过」） | `lib.rs:804,1321,1438,1447` |
| **M8** | `changed` 判定把 `aux_files` 一起比（此前只比模型数组 → 目录里只新增 mmproj/草稿模型时前端永远收不到更新）；payload 里带上 `aux_files`，与 `ipc.ts` 的 `{ models, aux_files? }` 对齐 | `state.rs:69-82,231-250`、`lib.rs:950-967` |
| **M9** | `upsert_entries`：同批 entries 先按小写键归并（后值胜），段内命中时**吃掉该键的所有旧行**（此前只改第一条，后续重复行留着 → router 取末值，界面改的值等于没改）；键名统一小写。<br>★ 顺带挖出并修掉两个**严重**缺陷：`sanitize_preset_keys` 的「其余键」分支漏 `continue`，**每个键被写两遍**；段里只有 `spec-type_X` 伪键、没有真的 `spec-type` 行时合并值随 `values.clear()` 消失（ngram-mod 勾了写不出去） | `models.rs:1407-1451,1608,1718-1723,1636-1663` |
| **M10** | 段名匹配改 `eq_ignore_ascii_case`（GUI 原本按字节精确比较，而 router 的 `std::map` 查找**大小写敏感**，`:tag` 还会被 `canonical_tag` 大写化 → 同一段被当成两个） | `models.rs:1313` |
| **M11** | 新增共用 `write_atomic`（tmp 名带 pid + 序号），`save_scan_cache` 与元数据缓存改用它，写失败不再静默；读侧坏文件打印一行后当空表处理。<br>★ 审查者补充：归档文件 `write_archive` 也是固定 `json.tmp`，同样改为唯一名 | `models.rs:505,535,1015,1038,1106-1116`、★`models.rs:112-124` |
| **M12** | `spawn_background_scan` 用 `compare_exchange` 做 in-flight 去重（在**起线程之前**认领）+ RAII 凭证（`panic` 展开也会释放，标志不会永久卡死） | `state.rs:57-62,125-135,213-224`、`lib.rs:925-943` |
| **M13** | 新增 `strata_lock()`（进程内互斥，覆盖「备份 → 修剪 → 写 tmp → rename」整段）与唯一 tmp 名；锁在 `write_config_raw` 内部取（标准 `Mutex` 不可重入，命令层再取一次会自锁死） | `strata.rs:770-792,820,860-862` |
| **M14** | 新增 `TrayMenu { start, stop }` 托管状态 + `sync_menu_state`，按进程槽 `set_enabled`（任一服务在跑 → 「启动服务」禁用）；建托盘时先置 `false` 避免可点但无效的首帧；Strata 崩溃监测发现进程消失时补刷一次 | `tray.rs:29-47,76-89,129-167`、`strata.rs:702-712` |
| **M15** | `quit()` 直接停 Strata（不能只靠 `RunEvent::Exit`：`request_exit` 失败时 tauri 会退化成 `std::process::exit` 跳过该事件）；`RunEvent::Exit` 保留为第二道防线，且先判「本来在跑吗」再报警，避免每次正常退出都刷假错误 | `tray.rs:169-191`、`lib.rs:1517-1544` |
| **未知字段** | `Settings` 增加 `#[serde(flatten, skip_serializing_if = "HashMap::is_empty")] pub extra: HashMap<String, Value>` —— 补齐 HANDOVER §7 声称、但实际不存在的「未知字段保留」（原报告 §6 第 3 条）。刻意**不给** `SettingsPatch` 加 flatten：前端载荷多打的字段名不该写进用户配置 | `settings.rs:237,240` |
| ★ **prune 写回** | `build_scan_result` 里 prune 后的写回是**唯一绕过命令层**的 preset 写盘路径（其余路径都在 `lib.rs` 显式调 `sanitize_preset_keys`）→ 从旧版升上来的配置里残留的 `no-mmap` 在「刷新模型」时不会被清掉，而它会让 router **整体**起不来。现在写回前统一过一遍，且只在内容真的变了时才写（幂等，不反复重写用户文件） | ★`lib.rs:892-911` |
| ★ **缓存刷新** | `find_strata_entry` 真扫后顺手 `store_strata_scan`：`strata_config_write` 刚写完 config 就用它回显，而 `strata_probe` 读的是缓存 —— 不刷新会让界面在一个 TTL 周期内弹回旧端口/旧模型名 | ★`lib.rs:348-357` |
| ★ **dead code** | 删除失去调用点的 `peek_archived`（`cargo test --lib` 的 `function is never used` 警告随之消失） | ★`models.rs:154` |

### 前端

| 项 | 改动 | 位置 |
|---|---|---|
| **M6** | SSE 断线重连的失败计数抽成 `noteAttempt(startedAt)`，正常收尾与异常断开**共用同一规则**（>`SSE_STABLE_MS = 3000` 即重置）；鉴权失败仍单独计数（key 不对不会因等得久变对）；新增 1 MiB 缓冲上限与积压丢弃 | `api/router.ts:104,112,160,173-176,193-203` |
| **M7** | `init()` 订阅**先注册**、关键快照失败即整体失败（`initialized` 保持 false）；监听槽按条去重 + 只重试失败项；`initInFlight` 防重入。<br>★ 审查者补齐：`App.tsx` 在 `initialized === false` 且有错误时给出「重试」按钮（此前用户除了重启应用无路可走），并加 `.toast-retry` 样式 | `store.ts:194,207-290,320-470,479-481`、★`App.tsx`、★`styles/app.css` |
| **M16** | 新增 `sanitizeSectionName`（只过滤 `[` `]` `\r` `\n` 并 trim，保留 `:` `_` `-` `.` 与空格）+ 输入框即时提示 —— 段名含 `]`/换行会让 preset 语法损坏甚至写坏整个 ini | `utils/models.ts:41,267`、`ModelSheets.tsx:446,505` |
| **M17** | 部分修（`--main-gpu` 在 llama.cpp 里只认设备索引，改存 UUID 不可行）：选项文案带索引、索引越界时补占位项 + 可见警告 | `ModelSheets.tsx:456,545,559` |
| **M18** | `Sheet` 新增 `confirmClose`，Esc / 点遮罩 / × 三条路径统一走 `requestClose`；ModelSheets 与 StrataPanel 各自用快照比对判脏值 | `Sheet.tsx:35-85`、`ModelSheets.tsx:201,232-239,432,756-757`、`StrataPanel.tsx:387,421` |
| **M19** | JSON 参数点「确定」时同时勾选该项（值填了却不写进 preset 的反直觉行为） | `ParamForm.tsx:536` |
| **M20** | 裸 flag 判据只认 `""`/`"true"`、`quoteIfNeeded` 加分号外转义、`tokenizeCommandLine` 解引号还原 —— `--threads 1` 不再被规范化成裸 `--threads`。★ 审查者补充：判据不能把**负数取值**当 flag（`--temp -1` 曾被读成 `temp = true` 而丢掉 `-1`） | `utils/extraParams.ts:60,73`、★`utils/extraParams.ts:isFlagToken` |
| **M21** | PresetEditor 用「打开时的快照」当 dirty 基线，后台刷新不再被误判成未保存修改；外部改动改为提示条 + 「载入最新内容」 | `PresetEditor.tsx:32` |
| **M22** | `isFlagToken` 的判据**统一到唯一实现**（原来 `strataParams.ts` 与 `StrataPanel.tsx` 各写一份、判据不同，正是「写回时吞掉 `--native`」的病根）。★ 审查者补充：判据改为 `token.startsWith("-") && Number.isNaN(Number(token))`（`-1` 是合法取值，不是 flag），并修掉 `extraParams.ts` 里同类遗漏 | `utils/extraParams.ts`、`utils/strataParams.ts:415,448`、`StrataPanel.tsx:441` |
| **M23** | BenchPanel 记录统计行归属哪个模型，压测中禁止切换模型、列表项置灰、切换时丢弃过期统计 | `BenchPanel.tsx:128,151,182,313,342,360,456` |
| **M24** | 模型卡片抽成 `memo(ModelCard)`，父组件用 `useMemo` 预计算「哪些段禁用了 webui」、`useCallback` 稳定回调 —— 不再每张卡片在渲染期解析整份 presets.ini | `ModelListPanel.tsx:57,459,462`、`utils/models.ts:80,95` |
| **M25** | 日志按 200 行切块 + `memo(LogChunk)` + 分块缓存。★ 审查者补充：缓存只能存**已封口**的块（未封口的尾块被当成已封口复用会让该段停在旧内容、后续块重复） | `LogPanel.tsx:39,132-136,167,184` |

### 两个说明

- **M2 的残留**：缓存 TTL 是 5 秒、前端轮询也是 5 秒 —— 缓存命中率接近 0，它的实际作用只是「限流」（每 5 秒最多真扫一次）。真正把开销从 async 运行时挪走的是 `spawn_blocking`；把 TTL 拉长会引入「外部改了 config 却长时间不刷新」的窗口，故未改。
- **`models.rs` 的 prune 路径**（★ 上表最后一栏旁边那条）值得单独记住：**新增任何 preset 写盘路径时，都要显式调用 `sanitize_preset_keys`** —— 淘汰键的后果是 router 整体起不来，而不是单段失效。

---

## 2. 高危

> **本节 6 条（H1–H6）已在 §1.1 全部修复**。下面保留原始问题描述与证据行号，作为问题记录与回归参照；行号是**修复前**的位置。

### H1 settings.json 读取失败 = 配置全量蒸发（P0）

`settings.rs:300-304`：

```rust
let settings = fs::read_to_string(&path)
    .ok()
    .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
    .unwrap_or_default();
```

任何读取/解析失败（外部编辑器写成非法 JSON、另存为 ANSI、杀毒或同步盘短暂锁文件）都静默变成默认值，不报错、不备份。此后**任意一次**设置写入都会把这套默认值整份持久化——最小触发动作是拖动一次窗口（`lib.rs:755` 写入窗口位置）。api_key、model_roots、aliases、favourites、strata_root、gpu 全部消失，且 `persist` 只写 `settings.json`，**不生成 `.bak`**（对比 `write_preset` 至少留 `presets.ini.bak`），用户无从恢复。

建议：读取失败时先尝试 `settings.json.bak`；把坏文件改名为 `settings.json.corrupt-<时间戳>` 保留；置「已降级」标志，禁止默认值直接进入可写状态。

### H2 启动路径的检查—登记非原子 → 孤儿 router/strata 进程（P0）

`lib.rs:186-192` 检查槽位为空即返回错误，随后 194–280 行是秒级工作（版本扫描、逐版本探测、设备枚举、spawn 并等端口就绪），进程句柄直到 `lib.rs:288` 才写入槽位：

```rust
188:        let guard = state.router_slot.lock().unwrap_or_else(|e| e.into_inner());
189:        if guard.is_some() {
190:            return Err("router 已在运行".into());
191:        }
...
288:    *state.router_slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(process);
```

两个并发调用都能通过 189 行的空槽检查；第二个不会因端口冲突失败——`router.rs:239-241` 在端口被占时会顺延到空闲端口。结果是两个 router 同时运行、共用同一份 `presets/presets.ini`，槽位只留后写入者，先启动的 `Child` 被覆盖后 drop（Windows 上 drop 不杀进程）成为孤儿。`strata_start` 同构（`lib.rs:500-505` → `lib.rs:532`）。

可达入口至少三条：界面按钮、托盘菜单（`tray.rs:81-84` → `App.tsx:59-62`）、`init()` 的自动启动（`store.ts:291-293`）。前端 `startRouter`（`store.ts:364-365`）只 `set({ busy: true })`，**不检查 busy**，无法在前端串行化。

建议：把「检查 + 启动 + 登记」收敛到一把贯穿全程的启动锁，或先以 `Starting` 占位槽位，第二方直接返回「正在启动」。

### H3 preset 并发写：漏锁 + 固定临时文件名（P1）

`write_preset`（`models.rs:1390-1396`）用固定 tmp 名：

```rust
let tmp = path.with_extension("ini.tmp");
fs::write(&tmp, content)...?;
if path.exists() { let _ = fs::copy(path, path.with_extension("ini.bak")); }
fs::rename(&tmp, path)...
```

`preset_lock()`（`models.rs:73-78`）的取用情况（已逐点核对）：`lib.rs:893`（`models_scan`，作用域覆盖到 927，含 `919 build_scan_result` → `800 write_preset`）、`933`、`977`、`991`、`1002` 都有锁；**唯独 `preset_import_hub`（`lib.rs:1040-1060`）直接 `read_preset → import_hub_presets → write_preset`（`lib.rs:1058`）没有取锁**。

两个写入者共用同一个 `presets.ini.tmp`：A 写完 tmp、B 截断重写，A 的 rename 会把 B 的半截内容改名成 `presets.ini`；随后 B 的 rename 因源文件已不在而报错，界面只显示一句「替换 … 失败」。`write_preset` 每次都用当前文件覆盖 `presets.ini.bak`，被半截内容覆盖那一次连上一版好文件也顶掉。

建议：临时名带 pid + 自增序号（`settings.rs:432-436` 已有 SEQ 写法可抄），`preset_import_hub` 补上 `preset_lock()`。

### H4 安装/卸载脚本：升级流程可能删除用户数据，且删除范围未如实披露（P1）

`src-tauri/nsis/hooks.nsh:38-53` 的 `NSIS_HOOK_POSTUNINSTALL` 只判断 `$LLAMACPP_PURGE_DATA == "1"`，**缺少 Tauri 模板自身有的 `$UpdateMode <> 1` 守卫**（对照 `installer.nsi:823-837`）。而 `installer.nsi:352` 在覆盖安装时会以 `/UPDATE` 调用旧卸载器 → 用户点「安装新版本」也会走到询问「是否删除用户数据」的分支，误点「是」即丢失 `settings.json`、`presets/presets.ini`、`bench/`、`runtime/`、`webview/`。

同一文件的两条披露问题：

- `hooks.nsh:30` 与 `:44-50` 的文案只说「设置 / presets / 记录 / WebView 缓存」，实际还会 `RMDir /r "$INSTDIR\runtime"`（用户自行下载或编译的 llama.cpp，可达数十 GB）以及**无条件**删除 `$APPDATA\dev.llamacpp.gui`、`$LOCALAPPDATA\dev.llamacpp.gui`。
- 递归删除完全依赖 `$INSTDIR` 且无空值校验；卸载器的 `$INSTDIR` 由 `_?=`（`installer.nsi:354`）或 exe 目录推断，为空时会退化成「当前盘根\runtime」。
- `hooks.nsh:49-50` 与 `installer.nsi:835-836` 删除同一批路径两遍，hooks 版绕过「删除应用数据」复选框与 `$UpdateMode` → 没勾复选框也可能丢 `$APPDATA` 数据。建议二选一。

建议：两个宏都加 `$UpdateMode` 判断；`runtime/` 单独询问或默认保留；删除前校验 `$INSTDIR` 非空并检查标记文件。

### H5 保存失败仍继续删旧段并启动 → 模型参数永久丢失（P0，前端）

`src/components/ModelSheets.tsx:371-386`：

```tsx
const sections = new Set(presetSections(useApp.getState().presetText));
await saveModelSection(target, entries);
// 段改名：旧段名还留着就删掉，否则 router 里会同时出现两个模型
if (renaming && sections.has(model.section)) {
  await removeModelSection(model.section);
}
```

`saveModelSection`（`src/store.ts:966-979`）返回 `Promise<void>`，写盘失败只在 `catch` 里 `set({ error })`、`finally` 里清 busy —— **调用方拿不到失败信号**。于是 `save()` 会继续执行 `removeModelSection(model.section)`（真的把旧段从 `presets.ini` 删掉），并把 `target` 返回给「保存并加载」（`src/components/ModelSheets.tsx:688-693`）继续 `startModel(target)`。

触发：把「模型名」改掉（触发 rename 路径）→ 点「保存并加载」→ 此时 `preset_upsert` 失败（`presets.ini` 被外部编辑器/同步盘占用）→ 新段没写进去、旧段已删除，该模型积累的手填参数、额外参数、环境变量全部蒸发。

修复：`saveModelSection` 返回成功标志或失败时抛出，`save()` 失败立即 `return null`，不删旧段、不启动。这是全仓最典型的「写操作没有失败传播」——`writePreset`/`writeStrataConfig` 同类。

### H6 模型根目录输入框每敲一个字符就丢焦点（P0，前端）

`src/components/SettingsPanel.tsx:356-368`：

```tsx
{roots.map((root, i) => (
  <div className="row" key={`${root}-${i}`}>
    ...
    value={root}
    onChange={(e) => setRoots(roots.map((r, j) => (j === i ? e.target.value : r)))}
```

key 里含被编辑的值 → 每输入一个字符 React 就卸载旧节点、挂载新节点 → 焦点丢失。实际效果：设置 → 目录 → 模型根目录，点进输入框敲一个字符光标即消失，必须重新点击才能继续，等于无法手工编辑（只能整段粘贴）。

修复：key 用稳定的行标识（`key={i}` 配不可变行对象，或生成 uuid）。

---

## 3. 中危

> **本节 25 条（M1–M25）已在 §1.2 全部修复**。下面保留原始问题描述与证据行号，作为问题记录与回归参照；行号是**修复前**的位置。

### M1 托盘失败与「关窗即隐藏」耦合，会产生无入口的隐藏窗口（P1）

`lib.rs:1232-1234` 托盘创建失败只 `eprintln!`（用户看不到）；`lib.rs:1262-1275` 在 `minimize_to_tray = true`（默认值）时 `prevent_close()` + `window.hide()`。若托盘没建起来，用户点 × 后窗口既不在任务栏也没有托盘图标。恢复路径是重启应用；但 `--minimized` 自启动（`lib.rs:1250-1257`）会把窗口直接 hide，此时用户完全看不到界面，只能任务管理器结束进程。

建议：托盘 init 失败时把 `minimize_to_tray` 视作 false（把失败状态记进 `AppState` 供 1263-1267 判断）。

### M2 `strata_probe` 每 5 秒全量同步扫描（P1）

`lib.rs:390-397` 在 `async fn` 里同步调用 `strata::scan_configs(root)`；`scan_configs` 对每个 config 读 `BUILD.json`（`strata.rs:300`）、`fs::metadata`（`strata.rs:174`）、分片聚合（`strata.rs:282-295`）、并打开 GGUF 读头部（`strata.rs:190-193`）。前端轮询是**常驻**的（`store.ts:299-302` 只要设了 `strata_root` 就启动，`:901` 每 5 秒一次），且 `strata_probe` 只有在「GUI 自己启的实例」才走短路径（`lib.rs:380-385`）——**未运行时反而最重**。

建议：移入 `tauri::async_runtime::spawn_blocking`，并给扫描结果加 TTL 缓存（`state.rs:77-88` 的 5 秒 scan 缓存已有先例）。

### M3 删除/归档段会吃掉下一段头上方的注释（P2）

`section_bounds`（`models.rs:1215-1227`）的 `end` 取「下一个段头所在行」，`remove_section`（`models.rs:1335-1346`）删除整个 `[start, end)`，因此 `[A]` 与 `[B]` 之间的空行、以及写在 `[B]` 上方的 `# 注释` 都在删除区间内。而归档走 `section_entries`（`models.rs:1230-1251`），它跳过空行与 `#`/`;` 行——**注释不进归档，restore 也补不回来**。

触发：模型文件被删/改名/换目录后刷新（prune 命中），或界面删除该段。

建议：删除区间收敛到段内最后一个非空非注释行，把尾部空行与注释留给下一段。

### M4 `restore_archived_sections` 的 O(模型数 × 全文) 重复解析（P2）

`models.rs:302-320` 循环内每个模型都调用 `list_sections(&out)` 重扫全文、`peek_archived(&id)` 重新读盘并完整解析归档 JSON、`upsert_entries` 又重建整份文本。200 模型 + 100KB preset 约等于 200 次全文扫描 + 200 次 JSON 解析，而这段运行在 `preset_lock`（`lib.rs:893`）内，会挡住所有 preset 写命令。

建议：循环外一次 `list_sections` 收成集合（随插入更新），归档一次性读成内存 Map。

### M5 锁中毒处理与全仓约定不一致（P2）

全仓统一 `unwrap_or_else(|e| e.into_inner())`，但 `lib.rs:707-710`：

```rust
708:    let Ok(monitors) = state.monitors.lock() else {
709:        return false;
710:    };
```

`monitors` 一旦中毒，`looks_maximized` 永远返回 false，「最大化状态记忆」从此静默失效；`lib.rs:1279/1289` 同类写法会丢事件。

### M6 SSE 重连的失败计数在异常路径不重置（P2）

`src/api/router.ts:113-170`：

```ts
148:      const startedAt = Date.now();
161:        if (Date.now() - startedAt > 3000) failures = 0;
162:        else failures += 1;
165:        failures += 1;           // ← catch 分支：不看连接持续了多久
169:        if (failures > limit) {
```

「稳定连接 3 秒以上就重置计数」只在流**正常结束**的路径（161-162）生效；`reader.read()` 抛错（网络中断、router 被外部杀掉）走 165 行无条件累加。于是累积到 `SSE_MAX_RETRY_NETWORK`（40）次异常中断后永久停订，界面模型状态不再刷新——而且这些中断可能分布在几小时里。

建议：catch 分支同样用 `Date.now() - startedAt > 3000` 判定重置。

### M7 `init()` 失败后不可重试，且订阅可能整体未注册（P2）

`src/store.ts:216-226`：

```ts
217:    if (get().initialized) return;
218:    set({ initialized: true });
219:    try {
220:      const [settings, paths, status, logs, strataStatus] = await Promise.all([...]);
```

`initialized` 在 await 前就置位；`Promise.all` 任一失败 → `catch`（306-308）只 `set({ error })`，`initialized` 已是 true，`init()` 再调用直接 return。更关键的是订阅（`:229-261` 的 `onRouterStatus/onLogLines/onStrataStatus/onModelsScanned`）都在这段 await **之后**，失败时一条都没注册 → 之后即使后端恢复，实时状态与日志也永久不更新，直到重启应用。

建议：订阅与初始快照分离（订阅失败也要注册或提供重试），或允许重置 `initialized`。

### M8 `models://scanned` 只在模型数组变化时发出（P2）

`lib.rs:835-847`：`changed` 只比较 `models`，注释明确写了 `aux_files`（mmproj/草稿模型）「不参与判断」。

```rust
835:        let changed = state.cached_scan(&roots).as_ref() != Some(&scanned);
837:        if changed { ... emit("models://scanned", json!({"models":…, "aux_files":…})) }
```

场景：模型文件本身没变，只在目录里新增了 `mmproj-*.gguf` 或草稿模型文件 → 不 emit → 前端的 `auxFiles` 一直陈旧，多模态/草稿选择项缺失，直到模型列表恰好变化。

建议：`changed` 里一并比较 aux 列表。

### M9 段内重复键不会被合并（P2）

`models.rs:1274-1285`：`remaining` 里每个键只被消费一次，第二次遇到同名键落进 `else` 原样保留。用户在界面把 `temp` 从 0.5 改成 0.9 后，磁盘上会变成 `temp = 0.9` 紧跟 `temp = 0.5`。

**已用 llama.cpp 源码取证（见 §9）**：解析器把每个段读成 `std::map<std::string, std::string>`，赋值语句就是 `parsed[current_section][current_key] = value;` → **同名键后出现者覆盖先出现者，即 router 取末**。所以「磁盘上第一条是新值 0.9、第二条仍是旧值 0.5」的结果是 **router 继续用 0.5**：用户改了参数、模型行为不变，而界面上显示的又是 0.9（GUI 按 `eq_ignore_ascii_case` 读第一条）。这不是展示不一致，是**功能静默失效**。

同类：`upsert_entries` 用 `eq_ignore_ascii_case` 匹配键名，`sanitize_preset_keys` 却大小写敏感。**而且键名必须是小写长参数名**：`common_preset_context::key_to_opt` 由各选项的 `get_env()`（大写，如 `LLAMA_ARG_TEMP`）与去掉前导 `--` 的长参数（小写，如 `temp`）填充，查找是大小写敏感的 `std::map::find`，而 `ignore_unknown_keys` 默认为 `false`（`common/preset.h`）→ 未知键直接 `throw std::runtime_error("option 'Temp' not recognized in preset 'xxx'")`。这与铁律 5（`RETIRED_PRESET_KEYS` 让 router 整体启动失败）是**同一个机制**：一个手写的大写键名 `Temp = 0.9` 足以让 router 起不来。

### M10 段名匹配大小写敏感（P2）

`models.rs:1215-1218` 用 `== Some(section)` 精确比较。用户手写 `[qwen3-4b]`（扫描 id 为 `Qwen3-4B`）且未设别名时，`preset_sync` 会再 append 一段 → router 看到两个段指向同一个 gguf（一个带参数、一个空段），原先手写的参数从此不被 GUI 读到。两个手写同名段时 `section_bounds` 只认第一个，第二个永不更新也不被删除。

**已用源码取证（见 §9）**：router 侧段名同样大小写敏感（`common_presets = std::map<std::string, common_preset>`），且解析器每遇到段头就先 `parsed[current_section] = {};` → **同名段第二次出现会把第一次的内容整个清空**。所以 GUI 的「同名段只认第一个」与 router 的「只认最后一个，且第一个被丢弃」并不一致，两个同名段在不同路径下看到的参数可能完全不同。另有 canonical 规则：`名字:tag` 中的 tag 会被 `canonical_tag` 大写化（正则 `[-.](([A-Z0-9_]+))$`，icase）—— `[qwen3-4b:q4_k_m]` 与 `[qwen3-4b:Q4_K_M]` 在 router 侧是**同一个段**，而 GUI 的精确比较会把它们当成两个段并再 append 一个。修复段名匹配时应把「忽略大小写」与「同样的 tag 大写规范化」一起做。

### M11 缓存文件写入非原子（P2）

`models.rs:506-509`（`models-scan-cache.json`）用固定 tmp 名且 `let _ = fs::rename(...)`；`models.rs:1024`（`gguf-meta-cache.json`）**直接覆盖写、连临时文件都没有**。`spawn_background_scan`（`lib.rs:827-849`）与前台扫描路径之间无互斥，两个线程可同时写同一个 tmp。进程在写 meta 缓存中途被结束（关窗/托盘退出/任务管理器）会留下半截 JSON，下次启动量化/架构信息大面积缺失直到重新探测。

### M12 `spawn_background_scan` 无 in-flight 去重（P3）

`lib.rs:827-849`：只要缓存过期且命中落盘缓存分支就新起一条线程，没有 in-flight 标记。前端在 `init`、`refreshModels`、`router_start` 之后都会调 `models_scan`（`store.ts:271,387,455`），快速重复刷新会叠加多条全量扫描线程、互相覆盖 `models-scan-cache.json`、多次 emit。

### M13 `strata_config_write` 无互斥（P3）

`lib.rs:603-613` 没有 `preset_lock()` 之类的串行化（preset 侧有），而 `strata.rs:813` 的临时名固定（`path.with_extension("json.tmp")`）。前端 `ensureStrataLazy`（`store.ts:721-732`）在启动流程里写 config，用户此刻点「保存参数」（`store.ts:872`）即构成并发写同一文件：同名 tmp 竞争 → rename 失败或后写覆盖先写；备份修剪（`strata.rs:782-810`）也会互删。

### M14 托盘菜单项恒为可用（P3）

`tray.rs:29-32` 两项都写死 `true`，`sync_tooltip`（`tray.rs:110-114`）只更新 tooltip。router 运行时点「启动服务」会直接踩 H2 的并发路径。

### M15 退出清理的两个缺口（P3）

`tray.rs:117-121` 的 `quit()` 只停 router：

```rust
118:    if let Some(state) = app.try_state::<AppState>() {
119:        let _ = crate::router::stop_router(&state.router_slot);
120:    }
121:    app.exit(0);
```

Strata（占显存的 python 进程）只能依赖 `RunEvent::Exit`（`lib.rs:1360-1367`）兜底，而那里的清理全部 `let _ =`，失败无任何可见痕迹（`app.exit(0)` 是否必然走到 `Exit` 分支未实测，见「待确认」）。

### M16 模型名（preset 段名）不过滤 `[]` 与换行（P2）

`src/components/ModelSheets.tsx:416-423` 的别名输入框原样接受任意文本，`src/utils/models.ts:198-200` 的 `composeSectionName` 只做 `trim()` 与「含 `/` 则整段用」的分支，不校验 `[`、`]`、`\r\n`。段名以 `[名字]` 写进 `presets.ini`，别名含 `]` 或换行时 ini 结构被破坏 → 后端解析出的段名与预期不符，失败时正好走 H5 的「删旧段」路径。

**已用源码取证（见 §9）**：段头的语法是 `header-line ::= "[" ws (section-name = [^]]*) ws "]" eol` —— 段名**不允许含 `]`**，且 `eol` 终止意味着**不允许含换行**。别名 `a]b` 会写出 `[a]b]`，被解析成段名 `a` 加一行无法解析的内容；含换行的别名会凭空多出一个段头。两者都不是「名字奇怪」，而是**结构性破坏**。反过来，合法字符比想象中宽（`:`、`_`、`-`、`.`、空格都合法），净化时只需去掉 `[`、`]`、`\r`、`\n` 并 trim，不要做成「只允许字母数字」的过度限制。

### M17 主 GPU 以设备数组下标持久化（P2）

`src/components/ModelSheets.tsx:458-465` 的 `<option value={String(index)}>`：`--main-gpu` 存的是下标，换驱动、插拔显卡或后端枚举顺序变化后，老配置会静默套到另一张卡（显存不足或性能骤降），界面显示与真实设备不再对应。建议落盘存设备名/UUID。

### M18 配置弹窗没有脏值判定，Esc / 点遮罩 / 取消静默丢弃全部改动（P2）

`src/components/ModelSheets.tsx:653-666` 把 `onClose` 直接交给 `Modal`；`src/components/Sheet.tsx:34-46` 的 `Escape` 处理与遮罩点击（`onMouseDown={(e) => e.target === e.currentTarget && onClose()}`）都不询问。改了几十个参数后一次误触即全丢。对比 `src/components/StrataPanel.tsx:659` 的 `disabled={busy || !text || text === original}` 是唯一做了脏值判定的弹窗 → 交互不一致。`src/components/StrataPanel.tsx:502-517` 同样缺判定。

### M19 JSON 参数「确定」不自动勾选，值填了却不写进 preset（P2）

`src/components/ParamForm.tsx:531-532`：

```tsx
const current = state[jsonEdit.key] ?? { enabled: false, value: "" };
setOne(jsonEdit.key, { ...current, value: raw.replace(/[\r\n]+/g, "") });
```

当前未勾选的 JSON 参数（grammar / json-schema / chat-template 类），粘贴内容点「确定」后输入框有值但 `enabled` 仍为 false → 保存后参数根本没提交，界面无任何提示。

### M20 额外参数往返丢值：`--threads 1` 被规范化成裸 `--threads`（P2）

`src/utils/extraParams.ts:49-57`：

```ts
.map(([key, value]) =>
  value === "" || value === "true" || value === "1" ? `--${key}` : `--${key} ${quoteIfNeeded(value)}`)
```

值为字面 `1` 的参数（`--threads 1`、`--batch-size 1`、`--n-gpu-layers 1`）存盘后重新打开弹窗回填成裸 `--threads`，任何一次保存都会写成 `threads = true`（`parseExtraParams` 把无值 flag 记为 `"true"`）→ 语义改变。同根因的引号不对称：`quoteIfNeeded`（`src/utils/extraParams.ts:44-46`）转义 `\"`，而 `tokenizeCommandLine` 的正则 `/"([^"]*)"|'([^']*)'|(\S+)/g` 不识别 `\"`，含双引号的值写回再读会被拆成多个 token。

### M21 presets.ini 编辑器把后台刷新误判为未保存修改（P2）

`src/components/PresetEditor.tsx:23-24`：

```tsx
const [text, setText] = useState(presetText);
const dirty = text !== presetText;
```

`text` 是打开时的快照，`presetText` 是实时值（`src/store.ts:375,459,505,526,970,985,1001` 都会更新）→ 弹窗开着时后台更新一次，「保存」按钮就由禁用转可用，点下去把打开时的旧全文覆盖回去，丢掉期间写入的段。触发：打开「编辑 presets.ini」→ 启动/停止一个模型 → 点「保存」。

### M22 Strata config 写回会吞掉「已知 flag 缺值」时紧随的未知 flag（P2）

`src/utils/strataParams.ts:392-394` 的 `argsToState` 不判断「下一个 token 是不是 flag」，`["--max-context","--native",…]` 会把 `--native` 当成 max-context 的值填进表单；而左栏 `argRows`（`src/components/StrataPanel.tsx:429-436`）用 `!next.startsWith("--")` 判定、显示为空值 —— 同一份 config 两处显示矛盾。用户把这个脏值改成正常数字写回时，`src/utils/strataParams.ts:419-425` 的 `i += 1` 把 `--native` 当作被替换的值跳过 → 上游安装器写入的开关从 config 中永久消失，下次启动可能失败。

### M23 BenchPanel：压测中切换模型，统计行落到另一个模型头上（P2）

`src/components/BenchPanel.tsx:171-175` 的 `selectModel` 在压测进行中仍可用（模型项无 `disabled`，`:429-434` 是 `div onClick`），压测返回后 `:318-322` 无条件 `setStats(computeStats(ok))`，而 `:144-147` 的 `rows = stats ? [stats, ...[...modelRecords].reverse()] : ...` 不校验 stats 属于哪个模型 → 「并发×N」统计行出现在新模型记录表顶部（该模型可能一条原始记录都没有）。

### M24 模型列表每张卡片在渲染期解析整份 presets.ini（P2）

`src/components/ModelListPanel.tsx:68-69`：

```tsx
const presetText = useApp((s) => s.presetText);
const chatDisabled = webuiDisabled(presetText, model.section);
```

每张卡片订阅整个 `presetText`，`webuiDisabled`→`presetValue`（`src/utils/models.ts:22-54`）会 `split(/\r?\n/)` 扫全文；卡片没有 `React.memo`，父组件每次渲染新建 `onConfigure`/`onDetail`（`:547-551`）→ 每次写 preset / 刷模型都全列表重算重渲染。HANDOVER §8 未决项 2 由此确认成立。

### M25 日志面板每来一批新行都重建整段文本（P3）

`src/components/LogPanel.tsx:108-111` 用 `shown.map(...).join("\n")` 生成全量文本，而日志上限 `LOG_LIMIT = 10_000`（`src/store.ts:34,246`）→ 满量时每批推送都是 O(10 000) 拼接 + 整个 `<pre>` 文本替换。

---

## 4. 低危与整洁性

- `lib.rs:1029-1032` `open_local_url` 用前缀判断「只允许本机地址」，`http://127.0.0.1:80@evil.com/` 能通过前缀检查而实际 host 是 `evil.com`。当前两个调用点（`store.ts:560,575`、`StrataPanel.tsx:910`）的 URL 都由应用自己拼接，**实际不可达**；建议改用 URL 解析后校验 scheme/host。
- `lib.rs:1319-1320` `strata_unload_model`/`strata_load_model` 信任前端传入的 `root`，与「Strata 根目录是 GUI 唯一需要用户提供的路径」的单一事实来源不一致；建议命令内改读 `settings.strata_root`。
- `bench.rs:226-235` `save_text_file` 可 `create_dir_all` 后写任意路径；`lib.rs:685` `frontend_log` 无长度/频率限制。单机应用风险有限，建议限定扩展名/目录与截断长度。
- `models.rs:547-549` 分片正则捕获了 `total` 却从未使用，归组只按 prefix（`models.rs:704`）：`X-00001-of-00002.gguf` 与 `X-00001-of-00003.gguf` 会被并成一个模型；只有第一片时也不提示「分片缺失」。
- `models.rs:560-566` 只跳过以 `.` 开头的**目录**，隐藏文件仍被收为模型：macOS 的 `._model.gguf`（AppleDouble，几 KB）会出现在列表里且点开必然失败。
- `models.rs:209-221` prune 直接用段内原始字符串当路径，`model = "E:/a.gguf"` 或行尾带 `# 注释` 的写法会被误判失效 → 段被删并归档（注释丢失）。
- ⚠️ **已确认后果（见 §9），严重度超出「低危」**：`models.rs:1462-1473` 的 sanitize 对键名大小写敏感，而 llama.cpp 的键名查找同样大小写敏感（`std::map::find`），未知键在 `ignore_unknown_keys = false`（默认）下**直接抛异常**。因此 `No-Mmap = true` 这类大小写变体既不会被 GUI 丢弃、也不会被转换，却能让 router **整体启动失败** —— 与铁律 5 是同一机制。建议并入 M9 修复：sanitize 时先把键名规范化（小写、去 `--`）再比较与写回。
- 值里含 `;` 或 `#` 会被 router 的 INI 解析器当成注释起点而**截断**（§9 语法：`comment ::= (";" | "#") (!newline .)*`）。GUI 的「额外参数」与自定义值输入都未限制这两个字符，于是会出现「界面里存下了、router 只读到前半段」的静默偏差。
- `models.rs:1392-1395` `presets.ini.bak` 每次写入都被覆盖，`fs::copy` 失败静默；连续两次异常写入会把损坏内容固化成唯一备份。
- `models.rs:269-276, 320-328` 归档文件损坏时 prune 与 restore 一起静默停用，GUI 无提示。
- `models.rs:911-917` 元数据缓存超限（4096）整体 `clear()`，一次清空丢掉全部量化/架构信息。
- `models.rs:1362-1367` `ensure_model_section` 里的 mmproj 是死代码（`let _ = mmproj;`）。
- `settings.rs:428` `serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".into())`：序列化失败会写空对象覆盖原文件，兜底方向反了。
- `idle.rs:89-99` `stop`→`start` 发生在守卫线程首次 sleep 结束前的竞态，可能残留一个用旧端口轮询的线程（重复 `POST /models/unload` 与重复日志）。
- `lib.rs:208-228` 版本探测循环内逐个 `settings.update(...)`，而 `SettingsStore::update` 在锁内 persist（`settings.rs:324-332`）→ 多版本时多次锁内写盘。
- `lib.rs:1276-1283` `Resized` 直接写入尺寸，无下限校验（`persist_window_size` 有 480×360 兜底）。
- `scripts/build-param-schema.mjs:94,96-97` 顶层 `const groups = new Map()`、`let missingLabel/missingDesc` 是死代码（`buildSchema` 内部重新声明，218-219 的赋值从未被读取）。
- `src/types.ts` 手写 serde 契约（无代码生成），Rust 侧加字段前端不会报错；且 `Settings.api_key` 明文回传 WebView（Strata 侧用 `has_api_key` 不下沉密钥），两套策略不一致。
- ~~`scripts/smoke-paramform.mjs` 未被任何 npm script 引用（只在 HANDOVER.md:305 提到手动跑），且直接依赖 `node_modules/.bin/esbuild` —— esbuild 是 vite 的传递依赖，未在 `devDependencies` 中声明。~~ ✅ 已修（2026-10-10）：`package.json` 补了 `test:smoke`（CI 会跑它），esbuild 升为显式 devDependency，打包改用 esbuild 的 JS API。
- **前端组件层低危**（子代理 b4449d7a）：
  - `src/App.tsx:110-113` 多行 `error` 的 toast 正文取 `toastLines.slice(1)`，最具体的第一行被丢（`notice` 的多行路径正确）。当前 store 的 `set({ error })` 均为单行，能否复现取决于后端 `Err(String)` 是否含换行 —— 见「待确认」。
  - `src/components/Sheet.tsx:62-67` 弹窗 footer 不在 `ErrorBoundary` 内：footer 按钮逻辑同步抛错时，最近的边界是应用级边界（`src/main.tsx:32-37`）→ 整页变错误界面而不是只关弹窗。
  - `src/components/StrataPanel.tsx:48-54` 的 `loadScrollTop` 没有 `> 0` 校验与 try/catch（对比 `src/components/ModelSheets.tsx:82-97` 的写法）：localStorage 不可用或配额满时会在滚动回调里反复抛异常并写进日志面板。
  - `src/App.tsx:58-67` 托盘订阅的 cleanup 是 `void pending.then((off) => off())`，`listen` reject 时无 catch —— 有全局 `unhandledrejection` 兜底上报，但监听器永不清理。
- **前端整洁性建议**：`src/components/ModelListPanel.tsx:459` 变量名 `totalMiB` 实为总字节数（`:559` 除以 `1024**3` 显示 GB）；`src/components/BenchPanel.tsx:43` 硬编码 `"\\bench"` 反斜杠与其它路径的正斜杠写法不一致；排序 locale 三处不统一（`src/components/BenchPanel.tsx:381-387` 用 `"zh-CN"`、`src/components/StrataPanel.tsx:759,765` 不传 locale、`src/utils/models.ts:240` 用 `"zh-Hans-CN"`）；`src/components/ParamForm.tsx:469-482` 折叠态初始化对每个分组各调一次 `loadCollapsed` → 一次挂载 N 次 localStorage 读 + JSON.parse；`src/components/ModelSheets.tsx:460-461`、`src/components/StrataPanel.tsx:790,798,799` 每次渲染多次 `find`（O(n)）；`src/components/SettingsPanel.tsx:232-234` 的 `if (host)`/`if (key)` 语义是「留空不动原值」，副作用是**通过 GUI 无法清除 config 里已有的 api_key**；`src/components/SettingsPanel.tsx:282-291` `toggleAutostart` 无 busy 保护（连点并发写注册表并重复 `saveSettings`）；`src/components/BenchPanel.tsx:178-256` 图表 effect 只依赖 `[chartData]`，窗口/侧栏尺寸变化不重绘（canvas 按 `parent.getBoundingClientRect()` 定尺寸）；`src/components/StrataPanel.tsx:503,646` 与 `src/components/ModelSheets.tsx:655` 共用 `domId="loadModelModal"` 与 `<form id="loadModelForm">`，目前靠「同页面只挂载一个」的隐含约定。
- **构建与安全面补充**（子代理 c50f90ad）：`.cargo/config.toml:12-16` 把 crates-io 全量换成明文 `sparse+http://127.0.0.1:8787` 代理，而 `scripts/cargo-proxy.mjs:120` 只绑 127.0.0.1、无鉴权与 Host 校验 → 本机任意进程可抢该端口冒充上游，index 与 crate 同源；`Cargo.lock` 的 checksum 只保护已锁定项，`cargo update` 或新增依赖时存在注入面（仅构建期，不影响运行时）。建议加 token 校验或该文件不入库。
- `scripts/make-icons.mjs` 与 `scripts/make-icons.ps1` 写同一批 `src-tauri/icons` 资产与 `icon.ico`，尺寸集/图形完全不同且无唯一入口 → 谁后跑谁赢，图标不可复现。
- `scripts/make-icons.mjs:20-21,239`、`scripts/smoke-paramform.mjs:17-19` 全用相对路径/`process.cwd()`，换目录调用即写错或失败；`app-logo.png` 的父目录未 `mkdir`。
- `src-tauri/tauri.conf.json:27` CSP 的 `connect-src` 放开 `127.0.0.1:*` 与 `localhost:*`，且未声明 `object-src`/`base-uri`/`frame-ancestors` → webview 一旦 XSS 可探测本机任意端口服务；建议补 `object-src 'none'; base-uri 'self'; frame-ancestors 'none'`。
- `tsconfig.json:23` 的 include 只含 `src` 与 `vite.config.ts`，`scripts/` 下的 `.mjs`/`.tsx` 不进 tsc → 冒烟入口的类型错误不报警。
- `src-tauri/Cargo.toml:7` `rust-version = "1.77"` 无验证（tauri 2.11.5 / wry 0.55.1 的实际 MSRV 可能更高），声明可能失真。

---

## 5. 已验证无问题的项（正面结论）

- 前后端命令契约 46:46、事件契约 5:5，无缺失/无死命令；参数名一律 camelCase（Tauri 2 默认），无 snake_case 误传。
- 后端非测试段 `.unwrap()` 为 0；`.expect()` 仅 4 处（正则常量）；锁中毒处理统一。
- 铁律 7（组件文件只导出组件）合规：`src/components/*.tsx` 共 13 处 export，全部是组件。
- 全局错误上报链路完整（`main.tsx:17-30` + `utils/frontendLog.ts:7`，`invoke(...).catch()` 防递归）。
- `params.json` 不含 router 专属键（models-max / sleep-idle-seconds / no-models-autoload / ui 等），`spec-type_ngram-*` 已改为 `mergeInto` 合并，避免了 `option not recognized` 导致 `/models?reload=1` 500。
- 淘汰键前后端一致：`models.rs:1405 RETIRED_PRESET_KEYS = ["no-mmap"]` 与 `ModelSheets.tsx:42 RETIRED_KEYS = ["no-mmap"]` 对齐。
- preset 读写对边界处理正确：BOM 保留、CRLF 规范化为 LF（内容不丢）、末行无换行按需补、`[*]` 段被识别且 `list_sections` 主动排除、`.GGUF` 大写扩展名可识别、非 UTF-8 的 `presets.ini` 会报错而不是被清空。
- `settings.rs:319-332` 刻意把落盘放进锁内并写明了理由（避免旧快照的 persist 抹掉新改动），与 `preset_lock`（`models.rs:68-78`）的设计意图一致。
- 写配置普遍采用 tmp+rename；prune 有两道保护（根本目录不在、全部失效且 ≥3 个）；归档失败宁可放弃清理。
- `ModelSheets.tsx:175-203` 用 ref 读取最新 preset 文本、只以段名为依赖，避免编辑中的表单被静默重置。
- 前端契约侧逐条核对通过（子代理 b4449d7a）：`src/ipc.ts` 全部包装与 `src-tauri/src/lib.rs:1297` 注册表一致（含 `fit_preview(model_path, params)`、`bench_server`、`bench_records*(bench_dir, ts_ms)`、`strata_config_read/write`），Tauri 默认接受 camelCase，无漏参、无未注册命令；`src/types.ts` 字段与 Rust 结构一致（无 `rename_all`）；`src/components/StrataPanel.tsx` 的注释明确「IPC 一律用文件名（Rust 侧按 file_name 匹配 config）」，故 `SettingsPanel.tsx:229` 的 basename 用法符合契约。`BenchRecord` 只有 `draft_accept`，`src/utils/bench.ts:88-89` 的 `draftN`/`draftAccepted` 因而恒等 —— 语义冗余但非 bug。
- `src/components/RuntimePanel.tsx` 全程未发现缺陷（版本/设备表 key 用 `v.name`/`d.name`，`settings?.gpu.n_gpu_layers ? … : "auto（不传 -ngl）"` 语义正确）；`src/components/ErrorBoundary.tsx` 的 `componentDidCatch` 上报 message/stack/componentStack 完整。
- 安全面已核对的项（子代理 c50f90ad）：`src-tauri/tauri.conf.json:26-28` 无 `dangerousDisableAssetCspModification`、无 assetProtocol scope、无 `withGlobalTauri`/devtools，窗口 `create:false` 由 `src-tauri/src/lib.rs:1111` 的 `from_config` 建且未注入 `additional_browser_args`；capabilities 只有 `default.json`（main 窗口的 core:default + dialog:default + opener:default），**无任何 `fs:*` 权限、无 `shell:allow-execute`**（Cargo.toml 未引 `tauri-plugin-shell`）；`opener:default` 只含 `allow-open-url` + `allow-default-urls` + `allow-reveal-item-in-dir`，不含 `open_path`；`Cargo.lock` 无 openssl/native-tls，`reqwest` 仅由 tauri 传递引入，应用代码未用，唯一 `unsafe` 是 `src-tauri/src/bench.rs:289-296` 的 kernel32 extern（带 SAFETY 注释）；`scripts/cargo-proxy.mjs:120` 绑 127.0.0.1、不读本地文件，实测 `/index/%2e%2e/…` 被 URL 规范化、`/index/..%2f..%2f` 只能改上游路径，host 恒为 rsproxy.cn → 无本地路径穿越、无任意主机 SSRF；`src-tauri/nsis/hooks.nsh:29-30` 静默卸载按「保留」处理且弹窗默认按钮为「否」（`MB_DEFBUTTON2`）。

---

## 6. 文档与仓库卫生

1. **测试数字过时**（✅ 已修）：`HANDOVER.md §6` 写 `cargo test --lib` 78 passed，`AGENTS.md` 写 70 passed，实测 **93 passed / 0 failed / 5 ignored**（中危修复后；84 → H1–H6 后 86 → 中危后 93）。两处文档已改为 93。
2. **行数过时**（✅ 已修）：HANDOVER 中 `store.ts` 665 行 → 实际 1224；`router.rs` 642 → 708；`models.rs` 2436 → 3152；`app.css` 1470 → 1502。§0 的规模行已按当前实测重算（口径确认为**总行数**）。
3. **HANDOVER §7 与实现/测试不一致**（✅ 已修）：文档称 settings.json 的「未知字段会被保留（roundtrip_and_unknown_fields 测试）」，但该测试（`settings.rs:520-538`）只断言 `port` 与 `model_roots` 往返，从未写入未知字段；`Settings` 也没有 `#[serde(flatten)]` 捕获，全量重写会丢弃未知键。现已加 `Settings.extra`（`#[serde(flatten)]`）并补 `unknown_settings_fields_survive_a_patch` 测试 —— 文档与实现现在一致了。
4. **无 git 仓库**（✅ 已修）：无法 diff/blame/回滚的问题已由 `git init` 解决（分支 `main`）。
5. **`.gitignore` 遗漏**（✅ 已修）：根目录实际存在 `.tmp/`、`.tmp-strata/`、`.dsh-vision-toolkit/`、`.strata-help.txt`，原先只忽略了 `tmp/`。现已补齐，并明确注释 `.cargo/config.toml` **不能**忽略（它是本机构建的必需项）。
6. **无 CI**（✅ 已修）：新增 `.github/workflows/ci.yml`（windows-latest：`npm ci` → `npm run build` → `npm run test:rs` → `npm run test:smoke`，且第一步删除 `.cargo/config.toml` 让它走官方 crates.io），并给 `package.json` 补了 `test` / `test:web` / `test:rs` / `test:smoke` 脚本。CI 首次全绿在第 4 次运行（head_sha `c28cc94`，run 38032807766）；前三次全红在「参数表单渲染冒烟测试」这一步，原因见下一条。
7. **参数表单冒烟测试从重构起就是坏的**（✅ 已修）：这个脚本从来没在 CI 里跑过（只在 HANDOVER 里写着"手动运行"），等真跑起来才逐层暴露三处失修 —— ① 入口仍从 `src/components/ParamForm` 导入 `initParamState` / `paramSchema` / `paramSchemaReady` / `paramStateToEntries`，而这四个函数按铁律 7 早已搬到 `src/utils/paramSchema.ts`（esbuild 报 `No matching export`）；② 打包用 `execFile` 执行 `node_modules/.bin/esbuild.cmd`，Node 20.12.2 / 22 起（CVE-2024-27980 的修复）不允许直接跑 `.cmd`/`.bat`，抛 `spawnSync … esbuild.cmd EINVAL`；③ 打包产物以子进程执行，而产物连带拉进的 `src/store.ts` 在**模块加载时**就调 `localStorage`（主题初始化），Node 下没有它 → `TypeError: localStorage.getItem is not a function`。三处均已修（`c28cc94`），本机与 CI 都通过。

---

## 7. 建议的修复顺序

> 第 1–12 项全部完成：H1–H6 见 §1.1，M1–M25 见 §1.2。只剩第 13 项。

1. ~~**H1**（settings 静默降级）~~ ✅ 已修 —— 唯一「一次意外即全部配置蒸发」的路径，改动小、收益最大。
2. ~~**H3**（preset 漏锁 + 固定 tmp 名）~~ ✅ 已修 —— 数据丢失面，两处小改动。
3. ~~**H5**（保存失败要中止后续删段/启动）~~ ✅ 已修 —— 前端最易真实踩到的数据丢失路径。
4. ~~**H2**（启动原子性）~~ ✅ 已修 —— 会留下 GUI 停不掉的孤儿进程。
5. ~~**H4**（NSIS `$UpdateMode` 守卫 + runtime 披露）~~ ✅ 已修 —— 影响所有覆盖安装的用户。
6. ~~**H6**（SettingsPanel 的 key）~~ ✅ 已修 —— 一行修复，直接恢复一个不可用的输入框。
7. ~~**M1**（托盘失败即视为不隐藏窗口）~~ ✅ 已修 —— 复核时补上了 `--minimized` 分支（托盘不可用时不隐藏窗口）。
8. ~~**M2**（strata_probe 挪进 spawn_blocking + TTL 缓存）~~ ✅ 已修 —— 复核时把 config 扫描也一并移出 async。
9. ~~**M18/M21**（弹窗脏值判定、PresetEditor 的 dirty 判定）~~ ✅ 已修 —— 消除「改了半天一按 Esc 全没了」和旧全文覆盖。
10. ~~**M4/M11**（归档一次性读、缓存写入原子化）~~ ✅ 已修 —— 复核时补上归档文件那处固定 tmp 名。
11. ~~**M6/M7**（SSE 计数重置、init 可重试）~~ ✅ 已修 —— 复核时补上初始化失败的重试入口。
12. ~~**M20/M22**（额外参数与 Strata 参数往返保真）~~ ✅ 已修 —— 复核时修掉两处「把负数取值当 flag」的回归。
13. ~~文档同步（测试数字、行数、未知字段说明）+ git init + 最小 CI + `.gitignore` 补漏~~ ✅ 已完成（2026-10-10）：`HANDOVER.md`（§1.1 行数、§6 测试数字、§7.1 未知字段、§8 已修项）与 `AGENTS.md`（测试数字、`npm test`、CI 说明）已同步；`.gitignore` 补齐 `.tmp/`、`.tmp-strata/`、`.dsh-vision-toolkit/`、`.strata-help.txt`；新增 `.github/workflows/ci.yml` 与 `package.json` 的 `test` 系列脚本。

---

## 8. 待确认（缺实测证据，勿直接当结论）

1. ~~router 对**同一段内重复键**取首还是取末~~ → **已确认取末**（`common/preset.cpp`，见 §9）。M9 因此从「展示不一致」升格为「界面改的值对 router 不生效」的静默功能失效，修复必须把重复键合并成恰好一条且值为新值。
2. ~~llama.cpp 对 **preset 键名大小写**是否敏感~~ → **已确认敏感，且只认 `get_env()` 的大写 env 名或去 `--` 的小写长参数名**；未知键在 `ignore_unknown_keys = false`（默认）下**直接抛异常**，即铁律 5 的机制（见 §9）。
3. ~~`tray::quit` 的 `app.exit(0)` 是否必然走到 `RunEvent::Exit`~~ → **正常路径必然走到**（`tauri-2.11.5/src/app.rs:573-574` 文档与实现）；但 `request_exit` 失败时会退化成 `cleanup_before_exit()` + `std::process::exit()`（`app.rs:575-579`），**跳过 `RunEvent::Exit`** —— 恰好在退出异常这种最需要清理的场景兜底失效。M15 因此要求 `quit()` 里**直接**停 Strata，不能只靠 `RunEvent::Exit`。
4. Tauri 2 命令参数名 camelCase 转换：本仓按框架默认传参、逐条比对无误，但未实机验证每条命令。
5. ~~后端 `preset_upsert` 是否自行校验 preset 段名~~ → **已确认不校验**：`lib.rs:1076-1088` 把入参 `section` 直接交给 `models::upsert_entries` 去拼 `[section]` 行，全程没有任何字符检查（`preset_remove`（`lib.rs:1091-1099`）与 `preset_section_entries`（`lib.rs:1103-1109`）同样）。因此 M16 的实际后果是「先写坏 ini，再按坏名字删旧段」，而不是「写坏即中止」。
6. ~~后端 `Err(String)` 的错误串是否可能含换行~~ → **已确认不会丢信息**：`err_chain`（`lib.rs:763-765`）是 `format!("{err:#}")`，anyhow 的 `{:#}` 用 `: ` 串接因果链、**不产生换行**；且即便某条消息自带换行，`src/App.tsx:112-113` 只是把首行当标题、其余当正文，两者都在 `:272-273` 渲染出来，不存在「只显示首行」。此项可关闭。
7. router（`tools/server/`）是否在某处把 `ignore_unknown_keys` 改成 `true`（本报告按默认 `false` 判断，与铁律 5 的既有实测现象一致，但未逐行确认）。
8. **`canonical_tag` 未对齐**：llama.cpp 会把 `名字:tag` 里的 tag 大写化（`qwen3-4b:q4_k_m` → `qwen3-4b:Q4_K_M`），GUI 只做「不区分大小写」的比较（M10），不做同样的规范化。当前不构成故障（两边都不区分大小写），但导出/对外展示段名时需要留意。
9. **值里含 `;` 或 `#` 会被 llama.cpp 当注释截断**（见 §9 的 PEG 语法），GUI 侧既不校验也不转义。用户手写这类值（例如路径里带 `#`）时，该值会被悄悄截断。
10. **M1/M14 已于 2026-10-10 在便携版上真机验证通过**：托盘右键菜单的灰显随服务状态正确切换（都停时「启动服务」可点、「停止服务」灰；任一在跑时反过来）、托盘可用时关窗隐藏进托盘且能从托盘唤回、关掉「关窗时最小化到托盘」后关窗进程真正退出、带 `--minimized` 启动窗口不出现且只驻留托盘（`--minimized` **不读** `minimize_to_tray`，二者独立 —— 关掉该设置后带 `--minimized` 启动时窗口仍不该出现，属预期）。**仍未实机验证**：M1 的「托盘创建失败」兜底分支（正常机器上复现不了，需临时开关强制跳过建托盘后重编译）、M2（`strata_probe` 移出 async）、M15（退出时 Strata 清理）。构建级验证已在 CI 完成（`.github/workflows/ci.yml` 会跑 `npm run build`，自 `c28cc94` 起多次全绿）—— 仅本机沙箱内 `npx vite build` 因 esbuild `spawn EPERM` 跑不起来。
11. **`models_scan` 里仍有同步磁盘操作**（`lib.rs:1023-1032`：`scan_models` + `save_scan_cache` 都在 async 命令里）。与 M2 同类，但只在「缓存缺失或用户点刷新」时才走，频率低得多，故未改。
12. **前门代理的两处真机缺陷已修**（2026-10-11，用户 m01266 / m01636 —— 前门是本次新增模块，不在原审查范围内，这里只记录实测结论）：① 「DSH 把模型加载了但连接不上」—— Windows 上 `accept()` 出来的套接字**继承**监听套接字的非阻塞标志，使 `strata_proxy.rs` 那条「客户端 → 引擎」转发线程首次 `read` 立刻 `WSAEWOULDBLOCK`（`os error 10035`）并向上游发 FIN；上游 `serve/server.py:4127-4150 _watch_client` 把 FIN 判成客户端挂断，而取消只在**提示读取的分块边界**生效（`server.py:317`），症状就是「小 prompt 侥幸成功、19k token 的 prompt 在约 5.7–11 s 被截断」（引擎日志 `0 generated ... (cancelled)`）。修法：每条连接 `set_nonblocking(false)` + 删掉那条转发线程（请求体已由 `read_body` 整段读完，只做单向 `io::copy`）。② 侧栏版本小字丢「Strata 」前缀（回落值取自 `engine/BUILD.json`，不带前缀）—— 现统一归一化，并优先用运行中引擎的 `/props.build_info`。真机验证（便携版 `E:\AI\llama.cpp-gui`，`curl` 参照客户端，都经 9090）：冷启动 78403 B prompt → 4835 B、18 个 chunk、含 `[DONE]`；重启引擎后热态 67900 B → 4635 B、`: keep-alive`×9、含 `[DONE]`；**修复前**同一请求 5561 ms 只收到 428 B。构建级：`cargo test --lib` 98 passed / 0 failed / 5 ignored、`npx tsc --noEmit` exit 0、`npm run tauri build` exit 0。

---

## 9. 附：llama.cpp preset 解析的确切语义（源码取证）

**取证来源**：`common/preset.cpp` 与 `common/preset.h`（llama.cpp master 分支），经 `cdn.jsdelivr.net/gh/ggml-org/llama.cpp@master/` 取得 —— `raw.githubusercontent.com` 在本机连接被重置（`read ECONNRESET`）。这是 M9 / M10 / M16 的定级与修复依据，同时也解释了铁律 5 的成因。

**PEG 语法**

```
header-line ::= "[" ws (section-name = [^]]*) ws "]" eol
kv-line     ::= ident ws "=" ws value eol
ident       ::= [a-zA-Z_] [a-zA-Z0-9_.-]*
value       ::= (!eol-start .)*
eol-start   ::= ws ((";" | "#") / newline / EOF)
newline     ::= "\r\n" / "\n" / "\r"
comment     ::= (";" | "#") (!newline .)*
```

- 段名**不能含 `]`**（语法是 `[^]]*`），也**不能含换行**；段头两侧空白被吃掉（建议 GUI 侧 trim）。
- 键名必须匹配 `ident`：不能以数字开头、不能含空格。
- **值里不能出现 `;` 或 `#`** —— 会被当成注释起始而截断。GUI 的「额外参数」若写出含这两个字符的值，router 侧会静默截断。

**结构与查找语义**

- `parse_ini_from_file` 返回 `std::map<std::string, std::map<std::string, std::string>>`，赋值即 `parsed[current_section][current_key] = value;` → **段内重复键取末**；遇到段头先执行 `parsed[current_section] = {};` → **同名段第二次出现会把第一次的内容整个清空**。
- `common_presets = std::map<std::string, common_preset>`：段名查找**大小写敏感**。
- `key_to_opt` 同时收录 `get_env()`（大写 env 名，如 `LLAMA_ARG_TEMP`）与 `rm_leading_dashes(get_args())`（小写长参数名，如 `temp`）；查找用大小写敏感的 `std::map::find`。
- `common_preset_context::ignore_unknown_keys` 默认 **`false`**（`common/preset.h`，其注释为「if true, options unknown to the current example are skipped instead of being an error」）。未知键走 `throw std::runtime_error("option '%s' not recognized in preset '%s'")` —— **这就是铁律 5 的机制**：preset 里留一个上游不认的键，router 直接启动失败（`no-mmap` 被淘汰后正是如此）。
- 键名 `version` 被无条件跳过（`if (key == "version") continue;`）。
- 段名规范化：`[*]` 是全局 preset（不作为模型段）；空段名回落 `COMMON_PRESET_DEFAULT_NAME = "default"`；`名字:tag` 中的 tag 会被 `canonical_tag` 大写化（正则 `[-.](([A-Z0-9_]+))$`，icase），例 `qwen3-4b:q4_k_m` → `qwen3-4b:Q4_K_M`。
- `common_preset::options` 是 `std::map<common_arg, std::string>` → **router 内部按参数重排，段内行的先后对 router 无意义**（GUI 保持顺序只为人类可读）。
- `to_ini()` 输出格式：`[名字]\n`，随后每行 `key = value\n`，段尾补一个空行。

**对本仓库的直接结论**

1. **M9 的真后果是「界面改的值对 router 不生效」**（取末）。修复必须把重复键**合并成恰好一条、且该条是新值** —— 只更新第一条而保留后面的重复行，等于没修，甚至更糟（界面显示新值、router 用旧值）。
2. **写回时键名应规范化为 llama.cpp 的长参数名**（小写、无 `--` 前缀）。保留用户手写的大写键名（如 `Temp`）可能让 router 整体启动失败。
3. **M10 除了大小写，还要考虑 `:tag` 的大写规范化**，以及「同名段 router 认最后一个并清空第一个，GUI 认第一个」这条两边不一致的行为。
4. **M16 对 `]` 与换行的过滤是结构性必需**，不是命名洁癖。

**未取证**：router（`tools/server/`）是否在某处把 `ignore_unknown_keys` 置为 `true`。本报告按默认值 `false` 判断（与铁律 5 的既有实测现象一致）。

---

## 附：本报告的取证方式

- 契约比对、行数统计、`.unwrap()` 统计均为本机脚本实测（PowerShell），非估算。
- 四路并行子审查分别覆盖：前端组件层、后端 `lib.rs`/`strata.rs`/`state.rs`/`tray.rs`、后端 `models.rs`/`settings.rs`、构建配置与安全面。
- 报告中标注为「已逐点核对」的关键结论（H1/H2/H3/M1/M3/M10、46:46 契约、`preset_lock` 覆盖点、`roundtrip_and_unknown_fields` 测试内容、`ensure_model_section` 死代码）由审查者本人回读源码复核。
- 复核过程中否掉的一个误报：`lib.rs:800` 的 prune 写回**在** `preset_lock` 作用域内（`lib.rs:893` 取锁，覆盖到 927 行的 `build_scan_result` 调用），不构成并发写。
- §9 的 llama.cpp preset 语义取自官方 `common/preset.cpp` / `common/preset.h`（master 分支，经 jsdelivr 取得，`raw.githubusercontent.com` 本机不可达）；Tauri 侧行为取自**本机实际编译**的 `tauri-2.11.5` 源码（`C:\Users\WuChun\.cargo\registry\src\127.0.0.1-2d8ad37583957fb8\tauri-2.11.5\src\app.rs:573-580`、`...\src\menu\normal.rs:105`）。
