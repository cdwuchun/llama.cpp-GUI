# 引擎安装目录与升级方法（Strata / llama.cpp）

> 本机 GUI 同时管理两套推理引擎：**Strata 引擎**（由 Strata 控制器安装与升级，`strata update`）和
> **llama.cpp 引擎**（`llama-server`，GUI 自己扫描与启动）。两者的目录布局、版本发现、升级方式完全不同，
> 本文分别记录，并给出对照表。实测基线：Strata 0.1.47（`E:\AI\Strata`），llama.cpp-GUI 0.2.2。
>
> 相关：`repair-engine-link.ps1`（本目录副本）用于重建 Strata 组件目录的目录联结；
> `HANDOVER.md` 是接手说明，`README.md` 讲功能。

---

## 1. Strata 引擎

### 1.1 目录结构

组件根目录（引擎与控制端都装在这里）：

- 默认：`%LOCALAPPDATA%\Strata\components`
- 可用环境变量 `STRATA_COMPONENTS_DIR` 覆盖（`strata_control/engine_component.py:176` `components_dir()`）

目录布局：

```
<components>\
  engine\
    0.1.47-windows-x86_64-cuda-cuda13\      ← 一个版本一个目录：<版本>-<平台>-<后端>-<变体>
      engine-component.json                 ← manifest：版本/平台/后端/架构/min_driver/build_id/文件清单/签名
      BUILD.json
      strata.exe                            ← 引擎主程序（entrypoint）
      strata-vision.exe                     ← 视觉/多模态（部分配置用到）
      strata_kq.dll
      cublas64_13.dll
      cublasLt64_13.dll
  control\
    0.1.47\                                 ← 一个版本一个目录：strata.py、strata_control、serve、python、bin…
    active.json                             ← {"version": "0.1.47", "folder": "0.1.47", "sha256": "…"}
  .updates\                                 ← 更新器的 staging 与状态
```

本机实际布局（`E:\AI\Strata`）：

```
E:\AI\Strata\
  engine\0.1.47-windows-x86_64-cuda-cuda13\
  control\0.1.47\  + control\active.json
  strata-gyro-gyro-m.json …                ← 三份运行配置（exe 写 component:strata-engine）
  run-*.bat
  repair-engine-link.ps1
E:\AI\Strata-data\                          ← 数据目录（models / packs / profiles）
```

`%LOCALAPPDATA%\Strata\components\engine` 与 `components\control` 都是**目录联结**，分别指向
`E:\AI\Strata\engine` 和 `E:\AI\Strata\control`。这样 `strata update` 往默认组件目录写时，文件实际落在
`E:\AI\Strata` 下。联结丢了就跑一遍 `repair-engine-link.ps1` 重建。

### 1.2 版本发现与校验

- `engine_dir()` = `<components>\engine`（`engine_component.py:189`）。
- `scan()` 遍历其子目录读 `engine-component.json`（`:727`）；`resolve()` 按平台/后端/架构/min_driver 过滤候选，
  同维度取版本号最大者；配置里的 `pinned_folder` 可以钉住特定版本（`:806`）。
- 校验：manifest 中每个文件的 SHA-256、清单签名（ed25519）；失败抛 `EngineIntegrityError`，
  找不到可用引擎抛 `EngineMissing`（CLI exit 5）。
- 运行配置里 `exe` 写 **`component:strata-engine`**（引用前缀见 `engine_component.py:897`）；控制器解析引用时
  自动选当前最优版本（`expand()`，`:904`）并补齐 DLL 目录。写绝对路径的配置**不会**跟随版本变化。
- 视觉 exe：`serve/server.py:7888` 的 `with_current_reader()` 只在 `exe` 是引用时把指向旧版本目录的
  `vision.exe` 修正为当前包里的同名文件——所以推荐统一写引用，别写绝对路径。

### 1.3 升级方法

命令入口：`strata update`（`strata_cli/update_cmd.py`）。

- 目标根目录：`--components-dir`，否则 `ec.components_dir()`（默认 `%LOCALAPPDATA%\Strata\components`，
  `update_cmd.py:167`）。
- control：下载到 staging，用 staging 自带的 python 跑一次 `--version` 验证，通过后才移动到
  `<components>\control\<版本>\`，写 `active.json`（`updater.py:1018-1029`）；只保留“当前版 + 上一版”，
  更早的目录删除（`:1030-1033`）。
- engine：staging → 测试启动（真实加载一个模型跑一个 token）→ 通过后移动进 `engine\`（`updater.py` 模块文档
  §1-§8）；旧版本保留，可用 `strata components rollback` 回滚。
- 生效：`strata.py` 入口的 `maybe_hand_over()` 读 `<components>\control\active.json`，若发现更新且完整
  （自带 python、`strata.py`、`strata_control`）就用新 control 重跑当前命令（`strata_cli/handover.py:70-114`）。
  `STRATA_NO_HANDOVER=1` 关闭交接。
- 只更新 control 不动引擎：`strata update --no-engine`。

本机：因为两个组件目录都是联结，`strata update` 实际写进 `E:\AI\Strata\engine` 与 `E:\AI\Strata\control`，
新增 `0.1.48\` 之类的版本目录并切 `active.json`，和现有版本并列。

---

## 2. llama.cpp 引擎

### 2.1 目录结构

根目录：设置项 `llama_cpp_dir`（`src-tauri/src/settings.rs:148`；GUI 由它推断 hub 根，
`lib.rs:1414-1420`，通常形如 `<hub>\llamacpp`）。

```
<llama_cpp_dir>\
  llama-b10831-bin-win-cuda-13.3-x64\       ← 一个版本一个目录
    llama-server.exe                        ← 版本发现只看这个文件
    ggml-cuda.dll / ggml.dll / …
  llama-b11671-bin-win-cuda-13.4-x64\
  cudart-llama-bin-win-cuda-13.3-x64\       ← 共享 CUDA 运行时（可选，与版本目录同级）
    cudart64_13.dll / cublas64_13.dll / cublasLt64_13.dll
```

GUI 只认 `llama-server.exe` 所在的目录，不读 manifest、不看目录名里除了版本比较以外的字段。

### 2.2 版本发现

- `scan_versions()`（`src-tauri/src/versions.rs:284-300`）支持两种布局：
  `<root>\llama-server.exe`（根目录本身就是一个版本）或 `<root>\<版本子目录>\llama-server.exe`。
- 版本号按名字里的数字段排序（`b10831 > b9999`，`compare_version_names`，`:260`）。
- 每个版本启动 `llama-server --help` 探测是否含 `--models-dir`（router mode 支持），结果缓存 7 天
  （`PROBE_TTL_MS`，`versions.rs:250`）；探测失败（缺 DLL、被杀软拦等）返回 `None`，**不缓存**，避免误判。
- 共享 CUDA 运行时匹配（`find_shared_cuda_dirs`，`:93`）：设置里显式 `shared_lib_dirs` → 按版本目录名里的
  `cuda-<X.Y>` 标签找同级目录 → 兜底任何同级 `cudart*` 目录；只接受**直接包含** `cudart64_*` / `cublas64_*` /
  `cublasLt64_*` 的目录（`dir_has_cuda_runtime`，`:74`）。
- Windows 的 DLL 搜索**不递归**：启动 router 时把共享目录注入子进程 `PATH` 最前
  （`compose_path_env`，`:168`），注入父目录无效。
- 非 ASCII 路径：路径含中文时 GUI 自动 `mklink /J` 建一个纯 ASCII 链接目录再启动
  （llama.cpp 以 ANSI 语义传自身路径，中文目录会让模型子实例 spawn 失败）。

### 2.3 升级方法

llama.cpp 的“升级”就是**多放一个版本目录**，没有安装器、没有版本指针：

1. 下载 llama.cpp release（如 `llama-bXXXXX-bin-win-cuda-X.Y-x64.zip`）；
2. 解压到 `<llama_cpp_dir>\llama-bXXXXX-bin-win-cuda-X.Y-x64\`（保留旧版本目录即可并存）；
3. GUI 扫描后新版本自动出现在版本列表里，在设置/运行时页选中即可；
4. 若 CUDA 标签升级（如 13.3 → 13.4），把配套的 `cudart-llama-bin-win-cuda-13.4-x64` 放在同级目录，
   GUI 会自动匹配；也可在设置里手工指定共享运行时目录；
5. 回滚 = 选回旧版本目录；旧目录可删可留，GUI 不清理。

注意：`strata::engine_folders` 那套“只认含 `engine-component.json` / `strata.exe` 的目录”是 **Strata** 侧的规则，
llama.cpp 扫描不适用——两边名字容易混，别把 llama.cpp 版本目录指给 Strata 控制器，反之亦然。

---

## 3. 对照表

| 维度 | Strata 引擎 | llama.cpp 引擎 |
|------|-------------|-----------------|
| 根目录 | `%LOCALAPPDATA%\Strata\components`（`STRATA_COMPONENTS_DIR` 可覆盖） | 设置页 `llama_cpp_dir` |
| 版本目录命名 | `<版本>-<平台>-<后端>-<变体>` | `llama-b<构建号>-bin-win-<后端>-<CUDA标签>-x64` |
| 版本指针 | `components\control\active.json` | 无指针，扫描目录 + 设置选择 |
| 完整性校验 | manifest SHA-256 + ed25519 签名 | 无（zip 解压，运行时 DLL 靠 PATH） |
| 升级入口 | `strata update`（staging → 测试启动 → 切换） | 手动下载解压新版本目录 |
| 回滚 | `strata components rollback` | 选回旧版本目录 |
| 运行时依赖 | 引擎包自带 DLL（cublas64_13.dll 等） | 需单独 `cudart-*` 共享目录并注入 PATH |
| 控制端交接 | `handover.py` 自动切到新 control | 无 |

## 4. 本机现状速查

- Strata：`E:\AI\Strata\engine`、`E:\AI\Strata\control\0.1.47`（+ `active.json`），数据 `E:\AI\Strata-data`；
  组件联结在 `%LOCALAPPDATA%\Strata\components\{engine,control}`。
- Strata 换版本：`strata update` 即可，运行配置里的 `component:strata-engine` 不用改；写死绝对路径的配置要手动改。
- Strata 联结坏了：跑本目录的 `repair-engine-link.ps1`（幂等，会同时维护 engine、control 两个联结并登记
  `%APPDATA%\Strata\settings.json` 的 `data_dir` / `installs`）。
- llama.cpp 换版本：解压新目录 → 设置页选新版本。
- 两套引擎互不干扰：Strata 的升级不碰 `llama_cpp_dir`，llama.cpp 的版本目录也不会被 `strata update` 读取。

## 5. 参考

- GUI 侧：`src-tauri/src/versions.rs`（版本发现 / 共享 CUDA 匹配 / PATH 注入）、`src-tauri/src/settings.rs`（`llama_cpp_dir`）、
  `src-tauri/src/strata.rs`（Strata 引擎查找）。
- Strata 侧：`E:\AI\Strata\control\0.1.47\strata_control\engine_component.py`（`components_dir` / `engine_dir` / `scan` / `resolve` / `expand`）、
  `strata_control\updater.py`（control/engine 更新）、`strata_cli\handover.py`（提交控制权）、`strata_cli\update_cmd.py`（`strata update`）。
- 设计文档：`docs/archive/STRATA_INTEGRATION_PLAN.md`。
