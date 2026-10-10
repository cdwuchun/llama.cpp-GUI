# llama.cpp GUI

> **本项目 fork 自 [llama.cpp-hub](https://github.com/IIIIIllllIIIIIlllll/llama.cpp-hub)**（作者 Mark）。
> 上游是给 llama.cpp 套 Web 壳的图形化工具（PWA，Java 后端 + Web 前端），本项目把它做成 Windows 桌面应用
> （Tauri 2 + Rust + React），并保留对其 `config/launch_config.json` 的迁移支持。
> 上游以 **MIT** 许可发布，本项目的版权与许可声明见 [`LICENSE`](./LICENSE)。

Tauri 2 桌面外壳，用 **llama.cpp 原生 router mode** 管理多个模型：不重复实现进程池 / LRU / 自动加载，
只做「版本发现 + 进程管理 + 环境注入 + 日志 + 性能测试 + 托盘」。

设计文档：

- `REFACTORING_PLAN.md` —— 实施方案（v2.1，含 GPU 多卡与共享 CUDA 运行时）
- `REFACTORING_REVIEW.md` —— 真机实测审查报告（含全部实测证据）
- `REFACTORING_PLAN.v1-original.md` —— 最初的方案（历史留存）
- `HANDOVER.md` —— **交接说明**：llama.cpp 行为约束、代码地图、验证手段、坑与未决项（接手先读这份）

---

## 当前进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1** | 工程骨架、设置持久化、目录选择 | ✅ |
| **P2** | 版本发现（含共享 CUDA 匹配）、设备枚举、router 生命周期与环境注入、日志采集、Runtime/Settings/Logs 三页 UI | ✅ |
| **P3** | 模型递归扫描 + `presets.ini` 生成 + 模型列表页 + 配置面板 | ✅ |
| **P4** | 日志页增强（模型 id 映射、源过滤联动） | ✅ |
| **P5** | API 压测（原 `llama-bench` 面板已移除，见下方说明） | ✅ |
| **P6** | 托盘常驻 + 开机自启 + 打包 | ✅ |

P2 已实现的能力：

- **版本发现**：扫描 `<dir>/<版本>/llama-server.exe` 或 `<dir>/llama-server.exe` 两种布局；
  `--help` 探测 `--models-dir`（router mode 支持）并**缓存**（冷启动约 1.5s，热约 150ms）。
- **共享 CUDA 运行时匹配**：按版本目录名里的 `cuda-<X.Y>` 标签，在同级目录中寻找**直接包含**
  `cudart64_*` / `cublas64_*` 的目录；也支持在设置里手工指定。
- **环境注入**：启动 router 时把共享 CUDA 目录注入子进程 `PATH`（Windows DLL 搜索**不递归**，
  注入父目录无效），并设置工作目录；注入会被 router 与它 spawn 的模型子实例逐级继承。
- **非 ASCII 路径修复**：路径含中文时，自动用 `mklink /J` 建一个纯 ASCII 链接目录再启动
  （llama.cpp 以 ANSI 语义传递自身路径，中文目录会导致模型子实例 spawn 失败）。
- **GPU / 多卡**：默认**不传** `--device` / `-ngl` / `-ts`，把显存分配交给原生 `--fit`
  （它会测量每张卡空闲显存、自动分层并生成 `--tensor-split`）。设备列表由 `--list-devices`
  实时枚举驱动，启动前校验（无效设备名会让 router 直接启动失败）。
- **日志**：采集 router 的 stdout/stderr，按 `[端口]` 前缀区分「系统」与「模型子实例」，
  环形缓冲 10000 行 + 100ms/50 行批量推送到前端。
- **进程生命周期**：端口占用自动顺延、崩溃监测（退出码上报）、退出时停止 router
  （实测强杀父进程后模型子实例会自行退出，不残留显存占用）。

P3 已实现的能力：

- **模型递归扫描**：任意层级扫描模型根目录，自动处理分组——同目录内以 `mmproj` 开头的文件归入该模型
  （多模态）、`*-000NN-of-000MM.gguf` 视为一个多分片模型、同目录多个主文件各自成模型；
  只有 mmproj 的目录会被忽略；量化从文件名推断。
- **presets.ini 生成与维护**：为每个模型写入 `[<相对路径 id>]` 段与 `model = <绝对路径>`；
  **更新时只动涉及的键，用户手写的注释、未知键、`[*]` 全局段原样保留**；支持整文件原始编辑。
- **模型列表页**：搜索、筛选（全部/已加载/收藏/未同步）、排序（名称/大小）、卡片与列表两种视图、
  紧凑/宽松两档密度（均记忆在 localStorage）、收藏、启动/停止（直连 router）。
- **状态实时同步**：订阅 router 的 `/models/sse`（`model_status` 带加载阶段与百分比、
  `model_remove`、`models_reload`），列表局部更新，不轮询。
- **配置面板**：7 个核心参数（`n-gpu-layers`/`ctx-size`/`temp`/`top-p`/`top-k`/`min-p`/`repeat-penalty`）
  写入该模型的 preset 段；**清空某项即从 preset 中删除该键**；另有"高级（原始 INI）"整文件编辑。
- **详情面板**：已加载模型读取 `/props`（量化、上下文、槽位、模态、构建号），未加载则展示扫描信息与 preset 段内容。
- **从 hub 迁移**：一键导入 `llama.cpp-hub` 的 `config/launch_config.json`，把每个模型的 `cmd` /
  `extraParams` 转成 preset 段的键值对（丢弃 router 掌管的 `--port`/`--alias`/`--no-webui` 等，
  合并 hub 那种 `--spec-type_ngram-mod` 的伪参数）。

P4–P6 已实现的能力：

- **日志页**：来源列表（全部 / 系统 / 前端 / 各模型实例，按当前端口映射成模型名）、匹配行数、
  自动滚底（仅在滚动条贴底时跟随）、缓冲上限与环形修剪。
- **性能测试页**：只有 **API 压测**（并发在 **Rust 侧**发起，绕开 webview 对同一主机 6 条连接的限制；
  统计 avg/min/max/P50/P95，记录可导出 CSV/JSON/MD）。
  > 原先还有一个 `llama-bench` 面板（版本下拉、参数弹层、历史输出浏览），已整体移除：命令行基准
  > 交给 `llama-bench.exe` 本身，应用内只保留「对着运行中的 router 打请求」这一种测法。
- **托盘常驻**：左键显示窗口，右键菜单「显示主窗口 / 启动服务 / 停止服务 / 退出」，
  悬停提示显示 router 运行状态与端口；关闭窗口默认隐藏到托盘而不是退出。
- **单实例**：重复双击 exe 不会再起第二份程序（也就不会出现多个托盘图标、多个 router），
  第二次启动只是把已有实例的窗口叫到前台（官方 `tauri-plugin-single-instance`）。
- **不闪黑窗**：版本探测（`llama-server --help`）、设备枚举（`--list-devices`）、`taskkill`、
  `mklink`、`reg query` 等所有子进程都带 `CREATE_NO_WINDOW`（主程序是 GUI 子系统并不够 ——
  GUI 进程 spawn 控制台程序时照样会新开一个控制台窗口）。
- **启动即出列表（先显示、后更新）**：扫描结果落盘缓存（`models-scan-cache.json`）。
  启动时直接读「上次刷新后的结果」把列表渲染出来，后端随后**自动重扫一遍**，
  只有结果真的变了才发事件让前端更新 —— 也就是 stale-while-revalidate，用户无感知。
  另外 `device_list`（要起一个 `llama-server --list-devices`，1~3 秒）不再排在模型扫描前面、
  也不再阻塞启动流程。
- **失效段自动清理 + 归档恢复**：模型被删掉/移走后，扫描时会自动把对应的 preset 段清掉
  （判据只有一个：段里的 `model` 指向的 gguf 不在了；没有 `model` 键的段一律不碰）。
  清掉的段**先存进归档** `removed-preset-sections.json`，所以过段时间把同一个模型重新下载
  回模型目录、扫描时会**按段名把当初调好的参数接回来**（`model` 换成新扫到的路径，其余键原样），
  恢复后从归档里移除。若所有段都失效（≥3 个）则判定为「模型盘没挂上」，跳过清理只做提示。
- **开机自启**：官方 `tauri-plugin-autostart`（写 `HKCU\...\Run`），自启动时带 `--minimized`
  直接驻留托盘；每次开启都用当前 exe 路径重写注册表项，移动安装目录后不会失效。
- **NSIS 安装包**：`npm run tauri build` 产出 `llama.cpp GUI_<version>_x64-setup.exe`
  （当前用户安装，免管理员）。

界面细节（按实机反馈调整过）：

- **侧栏**：`模型列表 / 性能测试 / 开始聊天 / 运行环境 / 系统日志 / 设置`；底部把 router 状态与
  启停合成**一颗胶囊**（左边状态点、中间「router 运行中 · :8080」、右边启动/停止图标，
  配色沿用 hub 模型卡的状态胶囊），点一下即启停。
- **模型列表顶栏只留五件事**：搜索、刷新、排序（名称 ↑↓ / 大小 ↑↓ / **运行中优先**）、
  筛选（全部 / 运行中 / 收藏 / 未同步 preset）、视图切换；`同步到 presets.ini` 与
  `编辑 preset 文件` 收进一个 **preset 下拉**。
- **设置页**：顶栏是深浅色主题按钮；llama.cpp 目录保存后自动重扫版本与设备；模型根目录
  「保存」即自动重新扫描（不再需要单独的「保存并扫描模型」）；GPU / 多卡分组已移除 ——
  默认不限制设备就是多卡最优解，需要 per-model 覆盖时在模型配置面板里改。
- **配置弹窗**：参数分组的折叠状态与左右两栏的滚动位置都会记住（按模型分开记，
  下次打开同一模型接着上次的位置）；底部按钮统一宽度；「估算显存」「删除配置」两个按钮已移除
  （段由扫描自动维护）。
- **窗口尺寸记忆**：拖动过窗口后按原尺寸打开，见 `settings.json` 的 `window` 字段。
- **图标**：应用图标是「层叠 + 闪电」的靛蓝方图，托盘另有一版**小尺寸专用**图形（两层 + 粗闪电）——
  主图三层加细闪电缩到托盘 24px 会糊成一片。

> **换图标要注意**：`tauri-build` **不监听** `icons/*` 的变化（它只跟 `tauri.conf.json` 和 resources），
> 直接替换 `src-tauri/icons/icon.ico` 后重新构建，exe 里嵌的仍是旧图标。正确做法是先清它的产物：
>
> ```powershell
> Remove-Item -Recurse -Force src-tauri\target\release\build\llamacpp-gui-*, src-tauri\target\release\.fingerprint\llamacpp-gui-*
> npm run tauri build
> ```
>
> 另外 Windows 有图标缓存：覆盖 exe 后若仍显示旧图标，把新 exe 换个名字/目录运行，或刷新缓存
> （`ie4uinit.exe -show`；顽固时删 `%LOCALAPPDATA%\IconCache.db` 后重启 explorer；任务栏固定项要取消固定再重新固定）。
>
> 图标资产全部由 `node scripts/make-icons.mjs` 生成（**解析式绘制 + Node zlib 自编码 PNG**，不依赖任何图形库）：
> `src-tauri/icons/*.png` 与 `icon.ico`（exe/安装包/任务栏）、`window-icon.png`（窗口与 Alt+Tab）、
> 以及 `src-tauri/src/tray_icon.rs` 里的托盘 RGBA 常量。两个要点：**四周留白 8%**（内容铺满画布在任务栏里会显得发满、像被切）；
> **≤40px 用两层简化图形**（三层加细闪电在小尺寸下必然糊）。

---

## 环境要求

- Windows 10/11（WebView2 随系统）
- Rust 1.77+（实测 1.98.1）
- Node.js 20+（实测 25.2.1）
- llama.cpp ≥ 2025-12 构建（支持 `--models-dir`），并准备共享 CUDA 运行时包
  `cudart-llama-bin-win-cuda-<X.Y>-x64`（与版本目录同级放置即可被自动匹配）

---

## 构建与运行

### 1) 先启动 cargo 依赖代理（本机必需）

本机 Windows 原生 TLS（schannel）不可用：cargo / curl 访问任何 HTTPS 源都会报
`SSL connect error (schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS)`，
而 Node 自带 OpenSSL 可以正常出站。因此仓库自带一个**纯 HTTP** 的 crates 代理，
让 cargo 只与本机 `127.0.0.1` 通信：

```powershell
# 终端 A（保持运行）
npm run cargo:proxy          # 默认 http://127.0.0.1:8787

# 终端 B
cd src-tauri
cargo build
```

`.cargo/config.toml` 已经把 `crates-io` 指向该代理（上游 rsproxy.cn，回退 static.crates.io）。
如果你的环境能直连 crates.io，把该文件里的 `replace-with` 注释掉即可。

> 别把 `CARGO_HOME` 指到仓库里：一次完整构建会在仓库内堆下约 780 MB 的 registry 缓存。
> 用默认的 `~/.cargo` 就行（本机一直用的就是它）。

### 2) 开发与构建

```powershell
npm install                  # 若在受限沙箱中需加 --ignore-scripts
npm run tauri dev            # 开发（需要 src-tauri 能编译）
npm run build                # 仅构建前端到 dist/
npm run tauri build          # 打包 NSIS 安装包
```

打包首次需要 NSIS 工具链（Tauri 会自动下载到 `%LOCALAPPDATA%\tauri\NSIS`）。
本机直连 GitHub 不通时，给构建命令带上代理即可：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7897"   # 本机 Clash 的混合端口
$env:HTTP_PROXY  = "http://127.0.0.1:7897"
$env:NO_PROXY    = "127.0.0.1,localhost"     # 别让 cargo 的本地代理走代理
npm run tauri build
```

产物：

- `src-tauri/target/release/llamacpp-gui.exe`（免安装，可直接运行）
- `src-tauri/target/release/bundle/nsis/llama.cpp GUI_<版本>_x64-setup.exe`（当前用户安装，免管理员）

### 3) 测试

后端包含针对纯逻辑的单元测试（命令行组装、设备解析、共享库匹配、ASCII 链接、设置读写等）：

```powershell
cd src-tauri
cargo test
```

### 4) 在 dsh 沙箱里构建的注意事项

受限沙箱禁止命名管道，而 **esbuild（Vite 配置与 TSX 转换）** 和部分构建工具依赖管道通信，
会报 `spawn EPERM`。在这类环境下需要用更宽的权限执行构建命令（本项目的前端构建即如此完成）。

同理，**GUI 的运行时验证必须在沙箱外**：WebView2 的渲染进程与宿主之间走命名管道，
沙箱内启动应用时 WebView2 起不来，窗口不会正常显示 —— 这不是应用本身的缺陷。
打包产物请在资源管理器里双击运行验证。

---

## 目录结构

```
├── index.html / vite.config.ts / tsconfig.json
├── package.json
├── .cargo/config.toml            # 指向本地 cargo 代理
├── scripts/
│   ├── cargo-proxy.mjs           # 本机 crates 代理（Node/OpenSSL）
│   ├── make-icons.mjs            # 生成全部图标资产（解析式绘制 + 自编码 PNG/ICO）
│   └── make-ico.mjs              # 把若干 PNG 打成 ICO（独立小工具）
├── src/                          # React 19 + TS 前端
│   ├── App.tsx / store.ts / ipc.ts / types.ts
│   ├── api/router.ts             # 直连 router 的 HTTP + SSE 客户端
│   ├── utils/
│   │   ├── models.ts             # 扫描结果 ↔ router 模型合并、段名/别名规则
│   │   ├── paramSchema.ts        # 参数表 schema + 表单状态换算（纯数据，无组件）
│   │   ├── presetText.ts         # preset 文本分段解析
│   │   ├── extraParams.ts        # 额外参数行解析
│   │   ├── frontendLog.ts        # 前端错误上报
│   │   ├── bench.ts / modelIcon.ts
│   └── components/
│       ├── ModelListPanel.tsx    # 模型管理（主力页）
│       ├── ModelSheets.tsx       # 配置面板 + 详情面板
│       ├── ParamForm.tsx         # 参数表单（含有序多选）
│       ├── BenchPanel.tsx        # 性能测试（API 压测；模型选择 + 图表 + 记录）
│       ├── RuntimePanel.tsx      # 版本/设备/多卡策略
│       ├── SettingsPanel.tsx     # 目录/服务/GPU/启动与托盘
│       ├── LogPanel.tsx          # 日志
│       └── ErrorBoundary.tsx     # 渲染错误边界
└── src-tauri/
    ├── tauri.conf.json / capabilities/default.json / icons/
    ├── nsis/hooks.nsh          # 卸载时询问是否删除用户数据
    └── src/
        ├── lib.rs                # Tauri 命令与事件注册
        ├── state.rs              # 共享状态
        ├── settings.rs           # settings.json 持久化
        ├── versions.rs           # 版本扫描 + --help 探测 + 共享 CUDA 匹配
        ├── models.rs             # 模型递归扫描 + presets.ini 读写 + hub 配置迁移
        ├── gpu.rs                # 设备枚举/校验 + GPU 参数组装 + 显存预估
        ├── bench.rs              # API 压测（Rust 侧并发）+ 记录落盘 + 硬件信息
        ├── http.rs               # 极简本机 HTTP 客户端（压测与空闲卸载共用）
        ├── idle.rs               # 模型休眠后自动卸载实例，放掉残留显存
        ├── tray.rs               # 托盘图标/菜单/关闭隐藏
        ├── winfix.rs             # ASCII 链接、端口检测
        ├── paths.rs              # 配置目录解析（便携绿色版 / 回退 %APPDATA%）
        └── router.rs             # router 生命周期 + 环境注入 + 日志采集
```

配置文件放在 **exe 同目录**（便携绿色版）：

```
settings.json                 # 用户设置
presets/presets.ini           # 交给 router 的原生 preset（P3 起由应用生成）
runtime/                      # 非 ASCII 路径的链接目录
webview/                      # WebView2 数据（localStorage / 缓存）
bench/records.json            # API 压测记录
gguf-meta-cache.json          # gguf 元数据（架构/量化）缓存
models-scan-cache.json        # 模型扫描缓存
removed-preset-sections.json  # 失效 preset 段的归档
```

> - 从把数据放在 `%APPDATA%\dev.llamacpp.gui\` 的旧版本升级上来**不会自动搬配置**（按全新安装处理，需要重设 llama.cpp 目录、模型目录与 preset）。
> - 装在 `C:\Program Files` 这类不可写位置时，自动退回 `%APPDATA%\dev.llamacpp.gui\`。
> - 开发模式（`npm run tauri dev`）始终用 `%APPDATA%`，不会把配置写进 `target/debug`。
> - 安装版同样走便携；**卸载时会询问是否同时删除这些用户数据**（默认"否"= 保留，重装到同一目录即可继续用）。

---

## 首次使用流程

1. **设置 → llama.cpp 目录**：填 `E:\AI\llama.cpp-hub\llamacpp`，点「保存并扫描」
   → 版本表会显示每个版本是否支持 router mode、是否匹配到共享 CUDA 运行时、路径是否纯 ASCII；设备表列出可用 GPU。
2. **设置 → 模型根目录**：填 `E:\AI\models`，点「保存并扫描模型」→ 递归扫描出所有模型（含多模态与分片分组）。
3. **模型管理 → 同步到 presets.ini**：把扫描到的模型写入 `presets.ini`（每个模型一段 `model = <绝对路径>`）。
4. **顶部「启动」**：拉起 llama-server（router mode）。状态条会显示实际端口与 `http://127.0.0.1:<port>/v1`。
5. **模型管理**：对任意模型点「启动/停止」；点「配置」调整该模型参数（保存后自动 `?reload=1` 生效）；
   「详情」查看运行态量化/上下文/模态。

> 实测确认：本机 17 个模型扫描 → 生成 preset → router 全部识别（段名含 `/` 与 `.` 均合法），
> 并可直接用 `OpenBMB/MiniCPM5-2B` 这样的 id 发起 `/v1/chat/completions` 请求。

---

## 给 dsh 等客户端使用

router 启动后直接提供 OpenAI 兼容端点（状态条会显示实际端口）：

```
base_url = http://127.0.0.1:<port>/v1
api_key  = 任意（除非在设置里配置了 --api-key）
```

`GET /v1/models` 会列出全部模型（含未加载的），首次请求会自动加载对应模型。
