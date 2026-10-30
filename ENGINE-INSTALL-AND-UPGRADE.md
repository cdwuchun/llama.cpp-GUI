# 引擎安装目录与升级方法（Strata / llama.cpp）

> GUI 管两套引擎：**Strata**（由 Strata 控制器安装升级，`strata update`）与 **llama.cpp**（`llama-server`，GUI 自己扫描启动）。
> 两者的目录布局、版本发现、升级方式完全不同。实测基线：Strata 组件 **0.1.52**（发布 0.2.7，根 `E:\AI\Strata`）、llama.cpp **b11671**、GUI **0.3.4**。
> 接手见 `HANDOVER.md`（§2.11 是 Strata 约束），用法见 `README.md`。

## 1. Strata 引擎

### 1.1 目录结构

根由设置页「通用 → Strata 目录」（`settings.strata_root`）决定：

```
<根>\
  engine\0.1.52-windows-x86_64-cuda-cuda13\   ← 一个版本一个目录：<组件号>-<平台>-<后端>-<变体>
    engine-component.json                      ← manifest：version / notes / 平台 / 后端 / build_id / 文件清单 / 签名
    strata.exe  strata-vision.exe  cublas64_13.dll …
  control\0.1.52\                              ← 控制器：strata.py、strata_control、serve、tools、python、bin
  control\active.json                          ← {"version","folder","sha256"}
  strata-<模型>.json [+ .bak]  run-<模型>.bat   ← 运行配置与启动脚本，直接放根下
  .updates\                                    ← 更新器 staging 与状态
```

官方安装器布局把 config/bat 放 `<根>\install`、引擎放 `<根>\components\engine\…`、控制器放 `<根>\terminal\<版本>`（`terminal\current` 是联结）。

**组件根目录只与 `strata update` 有关**：默认 `%LOCALAPPDATA%\Strata\components`（`STRATA_COMPONENTS_DIR` 可覆盖）。GUI 不用它定位引擎 —— 见 §1.2，所以手动解压到任意盘都能用。

### 1.2 版本发现与校验

- 引擎：`strata.rs::engine_folders` 从 `<根>` 自身、一级子目录及其直接子目录里找**含 `engine-component.json` 或 `strata.exe`** 的目录，**目录名不参与判断**；再补控制器组件根，按 `canonicalize` 去重。
- 控制器：`strata.rs::list_controllers` 同时认 `<根>\control\<版本>` 与 `<根>\terminal\<版本>`；`usable` = 有 `serve\server.py` 且有 `python\python.exe`；`active` 取 `control\active.json` 的 `folder`。
- 完整性：manifest 里每个文件的 SHA-256 + 清单 ed25519 签名，失败抛 `EngineIntegrityError`，无可用引擎抛 `EngineMissing`（CLI exit 5）。
- config 的 `exe` 两种形态：绝对路径，或 `component:strata-engine`（自动最新）。GUI **只解析不改写**；切版本时 `vision.exe` 一起指向新目录。
- **版本号两条线**：组件号 `0.1.x`（目录名、`version`），Strata 发布版本在同文件 `notes` 首词（本机 `0.2.7 NVIDIA cuda13 engine …`）。GUI 的模型目录闸门（`catalogReleaseGate`，如 DeepSeek 要 `0.2.5+`）读的是**发布版本**，拿 `0.1.52` 去比会误报「版本不符合」。

### 1.3 升级方法

入口 `strata update`（`strata_cli/update_cmd.py`），GUI 的「升级」按钮就驱动它：

- 目标根：`--components-dir`，否则 `ec.components_dir()`；GUI 固定传 `<根>`。
- control：下载到 staging → 用 staging 自带 python 跑 `--version` 验证 → 移到 `control\<版本>\` 并写 `active.json`，只留「当前 + 上一版」。
- engine：staging → 真加载一个模型跑一个 token 的测试启动 → 通过才移进 `engine\`；旧版保留，`strata components rollback` 回滚。
- 生效：`strata.py` 入口 `maybe_hand_over()` 读 `active.json`，更新且完整就换新 control 重跑当前命令（`STRATA_NO_HANDOVER=1` 关闭）。
- 只更新控制器：`strata update --no-engine`。
- **不要自己实现下载协议**（签名 feed、按显卡选包、sha256、试启动、失败留旧版）。GUI 只做「定位解释器 → 跑命令 → 把 jsonl 事件翻成进度」；升级前先 `--check`。控制器要可写 `<根>\.updates\`（建 `update.lock`），所以真下载只能在 GUI 里跑。

## 2. llama.cpp 引擎

### 2.1 目录结构

根由设置项 `llama_cpp_dir` 决定：

```
<llama_cpp_dir>\
  llama-b11671-bin-win-cuda-13.4-x64\   ← 一个版本一个目录，版本发现只看 llama-server.exe
    llama-server.exe  ggml-cuda.dll  ggml.dll …
  cudart-llama-bin-win-cuda-13.4-x64\   ← 共享 CUDA 运行时（与版本目录同级，可选）
    cudart64_13.dll  cublas64_13.dll  cublasLt64_13.dll
```

本机：`E:\AI\llamacpp\llama-b11671-bin-win-cuda-13.4-x64`，同级三个 `cudart-llama-bin-win-cuda-{12.4,13.3,13.4}-x64`。

### 2.2 版本发现

- `scan_versions()`（`versions.rs`）认两种布局：`<root>\llama-server.exe`（根本身是一个版本）或 `<root>\<版本子目录>\llama-server.exe`；版本按名字里的数字段比较（`b10831 > b9999`）。
- 共享 CUDA 匹配：显式 `shared_lib_dirs` → 按版本目录名的 `cuda-<X.Y>` 标签找同级目录 → 兜底任何同级 `cudart*`；只认**直接包含** `cudart64_*` / `cublas64_*` / `cublasLt64_*` 的目录。
- Windows DLL 搜索**不递归**：启动子实例时把共享目录注入 `PATH` 最前（`compose_path_env`），注入父目录无效。
- 非 ASCII 路径：自动 `mklink /J` 建纯 ASCII 链接再启动（llama.cpp 以 ANSI 语义传自身路径）。

### 2.3 升级方法

「升级」= **多放一个版本目录**，没有安装器、没有版本指针：下载 release zip → 解压到 `<llama_cpp_dir>\llama-bXXXXX-bin-win-cuda-X.Y-x64\`（旧目录留着可并存）→ GUI 扫描后出现在版本表 → 选中即生效；CUDA 标签升级时把配套 `cudart-llama-bin-win-cuda-X.Y-x64` 放同级，GUI 自动匹配；回滚 = 选回旧目录。

注意 §1.2 那套「只认含 manifest/`strata.exe` 的目录」是 **Strata** 的规则，别把两边的目录互相指错。

## 3. 对照表

| 维度 | Strata 引擎 | llama.cpp 引擎 |
|------|-------------|-----------------|
| 根目录 | 设置页 `strata_root`（空 = `%LOCALAPPDATA%\Strata`） | 设置页 `llama_cpp_dir` |
| 版本目录 | `<组件号>-<平台>-<后端>-<变体>` | `llama-b<构建号>-bin-win-<后端>-<CUDA标签>-x64` |
| 版本指针 | 手动布局看 `control\active.json`；选中项记在 `settings.strata_controller` / `strata_engine` | 无指针，扫描 + 设置选择 |
| 完整性 | manifest SHA-256 + ed25519 | 无（zip 解压，DLL 靠 PATH） |
| 升级入口 | `strata update`（staging → 试启动 → 切换） | 手动下载解压新目录 |
| 回滚 | `strata components rollback` 或版本表勾回旧版 | 选回旧目录 |
| 运行时依赖 | 引擎包自带 DLL | 需单独 `cudart-*` 并注入 PATH |
| 版本号含义 | 组件号 `0.1.x`，发布版本在 manifest `notes` 首词 | `b<构建号>` |

## 4. 本机现状速查

- Strata 根 `E:\AI\Strata`（手动解压布局）：引擎 `engine\0.1.50-windows-x86_64-cuda-cuda13` 与 `engine\0.1.52-windows-x86_64-cuda-cuda13`（后者发布 0.2.7）并存；控制器 `control\0.1.51`、`control\0.1.52`，`active.json` 指向在用版本；4 份 config（`strata-gyro-gyro-s`、`strata-swift-iq2_xs`、`strata-swift-iq3_s`、`strata-swift-iq3_xxs`）与 `run-*.bat` 在根下，各带 `.json.bak`。
- `%LOCALAPPDATA%\Strata\components` 在本机是空目录（没有安装器建的联结），不影响 GUI；只有直接跑 `strata.py components …` 时才需要 `--components-dir <根>`。
- 换 Strata 版本：设置页两张表（控制器 / 引擎）点选，即改写 `run-*.bat` 与 config 的 `cwd`、`--expert-profile`、`exe`、`vision.exe`。换 llama.cpp 版本：解压新目录后选中。
- 两套互不干扰：`strata update` 不碰 `llama_cpp_dir`，反之亦然。

## 5. 参考

GUI 侧：`versions.rs`（发现 / 共享 CUDA / PATH 注入）、`settings.rs`（`llama_cpp_dir`、`strata_*`）、`strata.rs`（引擎与控制器查找、`component:` 解析）、`strata_upgrade.rs`（驱动 `strata update`）。
Strata 侧：`<根>\control\<版本>\strata_control\{engine_component,updater}.py`、`strata_cli\{handover,update_cmd}.py`、`tools\iq_pack.py`（ORCA 打包）。设计文档：`docs/archive/STRATA_INTEGRATION_PLAN.md`。
