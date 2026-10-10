# 仓库约定（llama.cpp GUI）

**所有回复与文档一律使用简体中文。**

## 先读什么

- 接手 / 改代码前：`HANDOVER.md` —— §2 是 llama.cpp 行为约束（每条都有实测依据）、§1.1 代码地图、§8 未决项。
- 能力清单与构建步骤：`README.md`；整体方案与实测基线：`REFACTORING_PLAN.md`、`REFACTORING_REVIEW.md`。

## 铁律（违反即出 bug，不是"可能有问题"）

1. **不给 router 传 `--no-ui`** —— 它会被下发给每个子实例，关掉 llama.cpp 自带聊天界面。
2. 前端请求模型要用 **preset 段名**（`selected.section`），不是扫描出来的目录 id（`settings.aliases` 是两者的桥）。
3. 「刷新模型」必须 `GET /models?reload=1`，否则 router 用的还是内存里的旧 preset。
4. 配了 `--api-key` 后除 `/health` 全要鉴权，且只认请求头（`Authorization: Bearer` / `x-api-key`）；`?api_key=` 无效，SSE 不能用 `EventSource`。
5. preset 里出现被上游淘汰的键（`models.rs::RETIRED_PRESET_KEYS`）会让 **router 整体启动失败**：升级 llama.cpp 后先查日志里的 `option '…' not recognized in preset`。
6. 默认不传任何 GPU 参数 —— 多卡分配交给原生 `--fit`。
7. 组件文件只导出组件（工具函数放 `src/utils/`），否则 Fast Refresh 失效。

## 构建与验证（Windows）

```powershell
npm run cargo:proxy               # 另开终端保持运行（127.0.0.1:8787），cargo 必需
npx tsc --noEmit                  # 前端类型检查（仓库根）
cd src-tauri; cargo test --lib     # 后端单测（当前 93 passed / 5 ignored）
npm test                           # 前端类型检查 + 后端单测（test:web + test:rs）
npm run test:smoke                 # 参数表单渲染冒烟测试（需 esbuild，受限沙箱要提权）
npm run tauri build               # 打包；沙箱内需要提权
```

- 受限沙箱禁用命名管道：esbuild 会报 `spawn EPERM`；**GUI 运行验证必须在沙箱外**（WebView2 起不来窗口，不是应用缺陷）。
- 提权被拒绝时**不要重试同一个命令**，换做法或先问用户。
- CI：`.github/workflows/ci.yml`（windows-latest）跑 `npm run build` + `npm run test:rs` + `npm run test:smoke`；流水线第一步就删掉 `.cargo/config.toml`（它指向本机 127.0.0.1:8787 代理，CI 上不存在）。
- 换图标后必须删 `src-tauri\target\release\build\llamacpp-gui-*` 与 `.fingerprint/llamacpp-gui-*` 再构建（`tauri-build` 不监听 `icons/*`）。

## 交互口味

文案简洁；用户明确否定过的方向不要重提；动手前先说清楚"要改什么"。
