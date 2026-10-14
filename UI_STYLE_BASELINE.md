# UI 样式基座规格（全站统一到 Strata 设计系统）

> 定稿日期：2026-10-14。本轮只定规格，**未动任何代码**。
> 上游参照（实测存在）：`E:\AI\Strata\serve\web\tokens.css`（87 行）、`E:\AI\Strata\serve\web\sprite.svg`（28,577 B）、`E:\AI\Strata\serve\web\fonts\outfit-latin-wght.woff2` + `outfit-latin-ext-wght.woff2`。
> 决策原文记录在 `STRATA_MANAGER_PORT_ASSESSMENT.md` §5.1；本文件是实施与验收依据。

---

## 1. 九条定稿

| # | 决策 | 后果 |
|---|---|---|
| 1 | **全站统一到 Strata 色板与字体**，老页面一起换，不留双基线 | 明暗主题各一套色板重铺，视觉变化最大的一步 |
| 2 | **先全量清干净 130 处内联，再上新面板** | 聊天 / 监控 / 用量三个面板全部排在样式基座之后 |
| 3 | **不搬上游 CSS，只照搬结构按 token 重写** | 沿用 `src/styles/app.css:919` 与 `:1046` 已有惯例（"样式照搬 hub 新版 newui.css，变量换成 legacy 主题的"）；上游全局 reset 不入库 |
| 4 | **字体 + 图标全部更换** | Outfit + 中文子集；FontAwesome 退役 |
| 5 | **中文后备用 MiSans / HarmonyOS Sans SC 子集** | 一次性离线子集化产物入库，构建期零工具链（不新增 Node/Python 步骤） |
| 6 | **图标 = 上游 sprite 32 图 + lucide(ISC) 补缺，自建 sprite + `<Icon name>` 组件** | 不装 lucide-react；应用图标与托盘图标本轮不动 |
| 7 | **设置页照上游形态重构**（`src/components/SettingsPanel.tsx` 739 行、45 处内联 = 全站内联 35%）：tab 堆 → 左侧分组导航列表 + 右侧卡片分组 + `<details>` 折叠 + 行式开关 | 归组映射见 §10.5；45 处内联随整页重写消失（与 S5 合并 = **S7**） |
| 8 | **「运行环境」页并入设置页**（`src/App.tsx:15` 的 `Tab` 去掉 `"runtime"`、`:25` 顶栏项删除、`:321` 条件渲染删除 → **6 个 tab 变 5 个**） | **只并入版本表一块**（进「服务」组首卡，按钮改名「扫描 llama.cpp 版本」，CUDA 目录收进折叠）；**前门启停不进设置页** —— 启停的唯一手动入口是**侧栏左下角那颗胶囊**（`src/App.tsx:234-316`，前门化后现有两颗 `.router-pill` 合并为「前门 :9090」一颗，见 §10.8）；**推理设备表、多卡策略说明、路径信息一律退役**（用户 2026-10-14 决策），见 §10.7；`RuntimePanel.tsx` 262 行删除，`src/store.ts` 与后端探测逻辑全部保留（模型页/参数表单/压测仍在消费设备数据） |
| 9 | **断点体系统一到 640 / 900 两档**（主断点取 **900**，取代上游的 1000；老页面 6 处散档并入、2 处冗余删除，见 §10.4） | 全站只剩两个断点值 + `app.css:39/:295` 的 `min-width:901` 互补对；行为变化只在 **6 个具体位置**（HF 页两处风险最高）；新增 **S8**；`@media` 条件**不能用 `var()`**，只能靠规范约束（§7 第 10 条） |

排序约束（决策 2 的直接后果）：S1–S8 前置于 `STRATA_MANAGER_PORT_ASSESSMENT.md` §6 的 P3 / P5 / P7，也就是会话面板 M1–M7 里的 **M4 聊天、M6 监控 UI、M7 用量统计**；后端 M1–M3（前门调度、容量闸、Strata 并口）与样式基座零冲突，可并行。

---

## 2. 现状实测

### 2.1 样式层：4 个全局 CSS，串行级联，无组件级 CSS / 无预处理器 / 无 Tailwind

`src/main.tsx:7-10` 引入顺序即优先级（后引入者赢）：

| 文件 | 行数 | 内容 | 实测要点 |
|---|---|---|---|
| `src/styles/css/all.min.css` | 8 | Font Awesome 6 压缩版 | 10 个 `@font-face`、20 个 `url` → 指向 `src/styles/webfonts/` 4 个字体文件 |
| `src/styles/legacy/css2.css` | 171 | hub 自带 webfont 声明 | 19 个 `@font-face` 声明 Roboto Mono 12 段 + Press Start 2P 5 段 + Orbitron 2 段，**在 legacy 与 app.css 里引用数全为 0**；`url` 19 个中 **4 个指向缺失文件**（`legacy/woff2/e3t4euO8T-267oIAQAu6jDQyK3nRivN04w.woff2`、`…nWivN04w.woff2`、`…nbivN04w.woff2`、`v31/L0x5DF4xlVMF-BfR8bXMIjhGq3-OXg.woff2`）→ 白载 |
| `src/styles/legacy/index.css` | 4057 | hub **旧版默认首页**那套（`src/main.tsx:5-6` 注释明确："不是 index-new.html 的 newui.css，用户看的是前者"） | 473 处类名定义、**296 处 `#id` 选择器**（`#loadModelModal` 66、`#hfDetailPanel` 54、`#main-settings` 45、`#modelsList` 19、`#hfHitsList` 11）；`:root` 24 个变量 + `[data-theme="dark"]` 22 个变量（:1-51）；238 处硬编码 hex；`:192` 引用 `'Inter'` 但无 `@font-face`；`:2662` 与 `:2675` 声明 `'Font Awesome 5 Free'` 而仓库只有 FA6 → **这两处图标当前就是字体回落** |
| `src/styles/app.css` | 1309 | 本项目补充层（:1-2 注释"只补充 hub css/index.css 未覆盖的部分，任何重复定义都算偏差"） | 197 类 + 27 `#id`；38 处 hex；9 个分区（`:32` 加载弹窗、`:53` hub 未定义工具类含 `.panel` at `:55`、`:184` 侧栏尺寸配色对齐 hub 新版、`:306` 圆角统一、`:777` 新版页面公共类、`:919` 日志页照搬 newui.css、`:1046` 性能测试页同理、`:1504` 参数说明弹窗）；`:9-14` 把 hub 的 `body` 角色搬到 `#root`；`!important` 全站仅 7 处，覆盖靠"后写覆盖 + 同特异性"（`:36-38` 自己记过这个坑） |

**引入顺序决定胜负的实例**：`--radius` 现值 14px 来自 `src/styles/app.css:313` 覆盖 `src/styles/legacy/index.css:16` 的 `0.5rem` —— 新建 token 文件必须插到最前（第 1 个引入），否则兼容层被 legacy 的 `:root` 反压。

### 2.2 要迁走的三座山

| 维度 | 实测 | 目标 |
|---|---|---|
| 硬编码颜色 | CSS 里 **276 处 hex**（legacy 238 + app.css 38 + all.min.css 2）；已有 `var(--` 引用 705 处 | 逐处改 `var()`；新增代码禁写 hex |
| 字号 | **235 处 `font-size`、12 个离散值、rem/px 混用**：`0.75rem`(22)、`0.875rem`(20)、`0.85rem`(18)、`0.8rem`(17)、`0.82rem`(13)、`0.95rem`(10)、`13px`(9)、`1rem`(9)、`0.78rem`(9)、`14px`(6)、`0.72rem`(6)、`12px`(6) | 8 级阶梯 token |
| 内联样式 | **130 处 `style={{}}`**：`src/components/SettingsPanel.tsx` 45、`ModelSheets.tsx` 16、`StrataPanel.tsx` 15、`ParamForm.tsx` 13、`RuntimePanel.tsx` 12、`ModelListPanel.tsx` 9、`PresetEditor.tsx` 7、`BenchPanel.tsx` 5；TSX 内 hex 2 处；`className=` 659 处 | 全部迁成类名 + token，`style={{}}` 只留运行时动态值（目标 ≤5 处） |
| 图标 | **152 处 `fa-*`、68 个 unique、113 处 `<i>`，`<svg>` 现有 0 处**；分布 `StrataPanel.tsx` 37、`ModelListPanel.tsx` 34、`SettingsPanel.tsx` 20、`App.tsx` 15、`BenchPanel.tsx` 12、`RuntimePanel.tsx` 11、`ModelSheets.tsx` 9、`ParamForm.tsx` 8 | 自有 sprite + `<Icon name>`，FA 资源退役 |
| 字体 | 55 处 `font-family`：`Consolas, monospace` 7、`Consolas,"Cascadia Mono"` 3、`inherit` 3、`'SF Mono','Menlo',…` 2、`'Font Awesome 5 Free'` 2、`'Inter',…` 1 | 两个 token 收口 |
| 响应式 | `@media` 28 处：**max-width 900 共 15 处**（legacy 12 + `app.css` 3）、**768 共 5 处**、640 共 2 处、960 / 1000 / 1100 各 1 处，另 `prefers-reduced-motion` 1 处；`min-width:901` 2 处（`app.css:39`、`:295`，与 `app.css:19` 的 max-width:900 成互补对；`:295-299` 注释记录"固定 54px 会把窄屏下拉菜单整个裁掉"） | **统一为 640 / 900 两档**（决策 9，迁移表见 §10.4） |

---

## 3. token 规格（S1 建 `src/styles/tokens.css`，与上游同名）

数值全部取自上游 `tokens.css` 实测原值；主题机制**不改** —— 本项目已是 `document.documentElement.dataset.theme`（`src/store.ts:497-499`，`src/App.tsx:88-91` 保证首帧一致）+ `[data-theme="dark"]`（`legacy/index.css:28`），上游 `tokens.css:59` 同样挂 `[data-theme="dark"]`，天然共存。

**三条硬规定（2026-10-14 用户定稿）**：

1. **文件名与上游同名**：`src/styles/tokens.css`（上游 `E:\AI\Strata\serve\web\tokens.css` 的原名），**不另起名**（不叫 `strata-tokens.css` / `variables.css` 之类）。
2. **`--st-*` 是唯一真源**：上游 87 行**全量照抄** —— 字号 / 字重 / 行高 / 间距 / 圆角 / 阴影 / 动效 / 明暗两套色板 / `color-scheme` 一个不落，**不裁剪、不改名、不合并、不挑着抄**。本项目新增的非上游 token（`--st-r-btn 10` / `--st-r-field 12` / `--st-r-popover 18`）同样用 `--st-` 前缀并写在同一文件内。
3. **旧变量名只是兼容别名**：`--bg-color` / `--card-bg` / `--text-primary` 等定义在 token 文件末尾，只为让 **705 处存量引用零改动**继承新色板；**新写的 CSS 与 TSX 一律不准再用旧名**，存量随各页重构逐步换成 `--st-*` —— **旧别名只减不增**（与铁律 8「禁止新增 hex / 字面 font-size」同源）。

- **字号**：`--st-fs-xs 12px` / `sm 13` / `md 14` / `base 16` / `lg 18` / `xl 24` / `stat 32` / `display 40`
- **字重**：`--st-fw-regular 400` / `medium 500` / `bold 700` / `black 900`；**行高** `--st-lh-tight 1.1` / `--st-lh-body 1.55`
- **间距（4pt）**：`--st-s-1 4` `-2 8` `-3 12` `-4 16` `-5 20` `-6 24` `-8 32` `-10 40` `-12 48` `-16 64`
- **圆角**：`--st-r-sm 8` / `md 14` / `lg 20` / `xl 24` / `pill 9999`，另补本项目圆角映射所需的 `--st-r-btn 10` / `--st-r-field 12` / `--st-r-popover 18`（对应 `app.css:306` 已定的"容器 14 / 按钮与表单 10 / 搜索与下拉 12 / 小按钮 8 / 图标块 9 / 弹层 18 / 徽标 999"）
- **阴影**：`--st-sh-card` / `--st-sh-bar` / `--st-sh-pop` 三级，明暗各一份
- **动效**：`--st-ease cubic-bezier(.2,.7,.2,1)`、`--st-dur 160ms`
- **代码块底色**：`--st-code-bg #1b1f23` / `#0a0c0e`，**明暗都深底**（日志页与参数文本沿用）
- **color-scheme**：light 段 `light`、dark 段 `dark`（原生表单控件与滚动条随主题）
- 结构性 token **保留不动**：`--sidebar-w 232px`、`--hub-header-h 54px`（`app.css:189-190`）

**兼容层（关键：不做就要改 705 处引用）** —— token 文件里把旧变量名定义成别名，旧代码零改动继承新色板：

```css
--bg-color:var(--st-bg);          --card-bg:var(--st-surface);    --sidebar-bg:var(--st-surface);
--border-color:var(--st-line);    --text-primary:var(--st-ink);   --text-secondary:var(--st-ink-muted);
--input-bg:var(--st-surface);     --hover-bg:var(--st-surface-2); --active-bg:var(--st-line-soft);
--primary-soft:var(--st-line-soft);  --primary-color:var(--st-accent);  --accent-color:var(--st-accent);
--success-color:var(--st-accent);    --danger-color:var(--st-danger);   --warning-color:var(--st-warn);
--info-color:var(--st-info);         --shadow-sm:var(--st-sh-card);     --shadow-md:var(--st-sh-pop);
--radius:var(--st-r-md);             --transition-speed:var(--st-dur);
```

---

## 4. 色板映射（旧值 → 新值，light / dark）

| 用途 | 现值（legacy `:root` / `[data-theme="dark"]`） | 新 token（新值 light / dark） |
|---|---|---|
| 主强调色 | `--accent-color` `#6366f1` / `#818cf8`（indigo）；`--primary-color` light 是 **#000000** | `--st-accent` **#10b981 / #34d399**，hover `#0c8a60 / #4ade80`，ink `#ffffff / #052e20` |
| accent 底纹与文字 | 无 | `--st-accent-tint` `#ecfdf5 / rgba(52,211,153,.12)`；`--st-accent-text` `#0c8a60 / #4ade80` |
| 页面底 | `--bg-color` `#f5f5f5` / `#1e1e1e` | `--st-bg` **#f9fafb / #0e1113** |
| 卡片·输入·侧栏·弹窗底 | `#ffffff` / `#1e1e1e`（`--card-bg` `--input-bg` `--sidebar-bg` `--modal-content-bg` `--disabled-bg`） | `--st-surface` **#ffffff / #161a1d** |
| 次级底（hover、列表条） | `--hover-bg` `#f9fafb` / `rgba(255,255,255,.06)` | `--st-surface-2` `#f7f7f7 / #1d2226` |
| 选中 / 分隔 | `--active-bg` `#f0f0f0`；`--border-color` `#d9d9d9` / `#3a3a5c` | `--st-line-soft` `#eeeeee / #22272c`；`--st-line` **#dee5ee / #2a3036** |
| 正文 / 次文 / 弱文 | `#000000` / `#ffffff`；`#5f5f5f` / `#94a3b8` | `--st-ink` **#221e1f / #eef1f3**；`--st-ink-soft` `#303030 / #c7cdd3`；`--st-ink-muted` `#6f6f6f / #8e979f` |
| 图标色 | 无独立变量 | `--st-icon` `#2F384C / #c7cdd3` |
| info | `--info-color` light **#111111** / dark `#818cf8` | `--st-info` `#0f97ff / #3aa9ff`（tint `#e8f4ff / rgba(.12)`，text `#0668c2 / #7cc4ff`） |
| warn | `--warning-color` `#f59e0b` 双主题同值 | `--st-warn` `#e39b0b / #f5b53d`（text `#8a5a00 / #f8c96a`） |
| danger | `--danger-color` light **#1f1f1f** / dark `#ef4444` | `--st-danger` **#e0283f / #ff5a6e**（text `#b01a2e / #ff8a98`） |
| success | `--success-color` light **#111111** / dark `#10b981` | 复用 `--st-accent`（绿） |
| focus | 硬编码 `box-shadow:0 0 0 3px rgba(129,140,248,.25)`（`legacy/index.css:56-60`，indigo） | `--st-focus` **#405de6 / #7b93ff** |

> **light 主题现状是 hub 旧版的黑白极简**：`--primary-color #000000`、`--success-color #111111`、`--info-color #111111`、`--danger-color #1f1f1f`。换完色板这些位置**从近黑变彩色**（绿 / 蓝 / 红），是本轮观感跃迁最大的地方 → S2 验收必须逐页 + 明暗双主题截图。

**字号归一**（12 个离散值 → 4 级日常档）：`0.72/0.75/0.78rem` 与 `12px` → `--st-fs-xs`；`0.8/0.82/0.85rem` 与 `13px` → `--st-fs-sm`；`0.875rem` 与 `14px` → `--st-fs-md`；`0.95rem` 与 `1rem` → `--st-fs-base`；面板标题 → `lg`；指标大数字 → `stat`。

---

## 5. 字体规格（S3）

| 项 | 规格 |
|---|---|
| 拉丁 / 数字 | **Outfit 变量字体**（wght 100–900 单文件）。文件已在库外：`E:\AI\Strata\serve\web\fonts\outfit-latin-wght.woff2`、`outfit-latin-ext-wght.woff2`，许可 **SIL OFL 1.1**（可嵌入、可子集化）。搬到 `src/styles/fonts/`，`@font-face` 照上游 `tokens.css:6-7` 写法（两段 `unicode-range` + `font-display:swap`） |
| 中文 | **MiSans 子集**（首选）或 HarmonyOS Sans SC 子集，免费可商用，与 Outfit 几何气质接近。**字体文件本仓库没有，需一次性联网获取 + 离线子集化，产物 woff2 提交入库，构建期零工具链**（不给项目新增 Node/Python 构建步骤）。子集字表从 `src/**/*.tsx` 实际出现的汉字提取，避免漏字（漏字表现为逐字回落）。体积预估 +1.5–2MB |
| 栈 | `--st-font: "Outfit", "MiSans", system-ui, "Microsoft YaHei UI", "PingFang SC", sans-serif`（顺序即命中优先级）；`--st-font-mono: ui-monospace, "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace` |
| 硬约束 | 上游 `tokens.css:6-7` 的 `unicode-range` **只覆盖 latin + latin-ext，无 CJK** —— 上游是英文 UI 所以无感，本 GUI 全站中文，**中文必须靠后备字体**，这就是必须同时引入中文子集的原因 |
| 顺带清理 | 废弃 `src/styles/legacy/css2.css`（17 个死声明 + 4 个坏 `url`）；删 `legacy/index.css:2662` 与 `:2675` 的 `'Font Awesome 5 Free'`；`legacy/index.css:192` 的 `'Inter'` 改 `var(--st-font)`（库内无 Inter 字体，Windows 上一直是回落） |

---

## 6. 图标规格（S4）

**目标形态**（照上游机制，零运行时依赖）：

```tsx
// src/components/icons.tsx —— 只导出组件（AGENTS.md 铁律 7）
<Icon name="search" />             // 默认 20px
<Icon name="search" size="sm" />   // 16px
<Icon name="search" size="lg" />   // 24px
```
实现 = `<svg class="st-icon" aria-hidden="true"><use href={SPRITE + "#i-" + name}/></svg>`；样式照上游 `components.css:7-9`：`.st-icon{width:20px;height:20px;flex:none;color:inherit}`、`.st-icon--sm{width:16px}`、`.st-icon--lg{width:24px}`。资源 `src/styles/icons/sprite.svg`；Vite 打进 `dist`，`tauri.conf.json` 的 `frontendDist:"../dist"` 已覆盖，无需新增资源映射。

- 上游 sprite 32 个 symbol（`viewBox="0 0 24 24"`，描边风格，stroke 69 / fill 60）：`i-chat i-activity i-settings i-gpu i-cpu i-memory i-disk i-thermometer i-bolt i-link i-clock i-gauge i-layers i-experts i-send i-stop i-attach i-image i-copy i-check i-trash i-new-chat i-chevron i-thinking i-tool i-download i-warning i-error i-info i-refresh i-sun i-moon`
- 补缺来源：**lucide**（ISC，24×24 描边，同风格），逐图取 SVG path 合入自有 sprite，命名统一 `i-*`；**不装 lucide-react**。
- 退役：删 `src/styles/css/all.min.css`、`src/styles/webfonts/`（4 文件）、`legacy/index.css` 的 FA5 两段声明。

### 68 个 unique `fa-*` 全量映射（S4 工作量清单，来源 `S`=上游 sprite 直接语义对应，`L`=lucide 补缺，`→`=并入已有目标）

| fa 图标 | 次 | 目标 | 来 | | fa 图标 | 次 | 目标 | 来 |
|---|---|---|---|---|---|---|---|---|
| fa-play | 9 | `i-play` | L | | fa-circle-info | 2 | `i-info` | S |
| fa-save | 8 | `i-save` | L | | fa-sliders | 2 | `i-params` | L→ |
| fa-stop | 8 | `i-stop` | S | | fa-code | 2 | `i-code` | L |
| fa-spin | 7 | `i-spinner` | L | | fa-comments | 2 | `i-comments` | L |
| fa-check | 7 | `i-check` | S | | fa-plus | 1 | `i-plus` | L |
| fa-microchip | 6 | `i-chip` | L | | fa-terminal | 1 | `i-terminal` | L |
| fa-spinner | 5 | `i-spinner` | L→ | | fa-times | 1 | `i-close` | L |
| fa-folder-open | 4 | `i-folder-open` | L | | fa-radar | 1 | `i-scan` | L |
| fa-list | 4 | `i-list` | L | | fa-rotate | 1 | `i-refresh` | S |
| fa-check-circle | 3 | `i-check-circle` | L | | fa-sun | 1 | `i-sun` | S |
| fa-search | 3 | `i-search` | L | | fa-trash | 1 | `i-trash` | S |
| fa-star | 3 | `i-star` | L | | fa-question-circle | 1 | `i-help` | L |
| fa-brain | 3 | `i-thinking` | S | | fa-server | 1 | `i-server` | L |
| fa-hdd | 3 | `i-disk` | S | | fa-gauge-high | 1 | `i-gauge` | S |
| fa-layer-group | 3 | `i-layers` | S | | fa-heart-pulse | 1 | `i-activity` | S |
| fa-triangle-exclamation | 3 | `i-warning` | S | | fa-bars | 1 | `i-menu` | L |
| **fa-chevron-** | 3 | `i-chevron-down/up/left/right` | S+补 | | fa-calculator | 1 | `i-calculator` | L |
| fa-sync-alt | 3 | `i-refresh` | S | | fa-chart-column | 1 | `i-chart` | L |
| fa-info-circle | 2 | `i-info` | S | | fa-circle | 1 | `i-circle` | L |
| fa-rotate-right | 2 | `i-redo` | L | | fa-circle-question | 1 | `i-help` | L→ |
| fa-box-open | 2 | `i-package-open` | L | | fa-cog | 1 | `i-settings` | S |
| fa-filter | 2 | `i-filter` | L | | fa-door-closed | 1 | `i-conn-off` | L |
| fa-moon | 2 | `i-moon` | S | | fa-door-open | 1 | `i-conn-on` | L |
| fa-file-lines | 2 | `i-file-text` | L | | fa-download | 1 | `i-download` | S |
| fa-arrow-down-wide-short | 2 | `i-sort-desc` | L | | fa-lock | 1 | `i-lock` | L |
| fa-cubes | 2 | `i-models` | L | | fa-exclamation-circle | 1 | `i-error` | S |
| fa-sliders-h | 2 | `i-params` | L | | fa-external-link-alt | 1 | `i-external` | L |
| fa-network-wired | 2 | `i-network` | L | | fa-file-code | 1 | `i-file-code` | L |
| fa-eraser | 2 | `i-eraser` | L | | fa-file-csv | 1 | `i-file-csv` | L |
| fa-th-large | 2 | `i-grid` | L | | fa-file-import | 1 | `i-file-import` | L |
| fa-stop-circle | 2 | `i-stop-circle` | L | | fa-file-pen | 1 | `i-file-edit` | L |
| fa-exclamation-triangle | 1 | `i-warning` | S→ | | fa-flask | 1 | `i-bench` | L |
| fa-floppy-disk | 1 | `i-save` | L→ | | fa-folder-tree | 1 | `i-tree` | L |
| fa-upload | 1 | `i-upload` | L | | fa-window-restore | 1 | `i-window` | L |

**合计**：68 个 unique 中 **19 个直接对应上游 sprite**；需 lucide 补缺 ≈ **47 个新 symbol**（`save` / `spinner` / `params` / `refresh` / `info` / `warning` / `help` 各有 2 个 fa 名并入同一目标）。sprite 规模 = 32 + 47 ≈ **79 个 symbol**。使用点 152 处全替换，`<i>` 113 处 → `<Icon>`。

**实施坑（本轮实测发现）**：`fa-chevron-` 出现 3 次且名字带尾横线 —— 源码是**模板拼接图标名**（如 `fa-chevron-${open ? 'down' : 'right'}`）。迁移时 sprite 必须备齐 `chevron-down/up/left/right` 四个 symbol，并把拼接改成语义完整的 `name`，否则 `<use>` 指向不存在的 id（浏览器静默不显示，不报错）。上游 sprite 只有单个 `i-chevron`，需补 3 个方向。

---

## 7. 新增规范（同步进 `AGENTS.md` 铁律第 8 条）

1. 禁止用内联 `style={{}}` 调尺寸 / 字号 / 颜色 / 间距；尺寸颜色只能取 token 或既有类名。`style={{}}` 仅允许运行时动态值（例：`src/components/RuntimePanel.tsx:6` 的 `style={{ color }}` 由数据驱动）。
2. CSS 里禁止新写 hex 字面值与字面 `font-size` / `border-radius`，一律走 token。
3. 禁止新增 `@font-face`（全站只有 Outfit 两段 + 中文子集一段）。
4. 禁止新增 `#id` 选择器（296 处是 hub 遗产，**只减不增**）；新样式用类名 + 作用域容器。
5. 图标组件统一放 `src/components/icons.tsx`，组件文件只导出组件（既有铁律 7）。
6. 上游 CSS **只照搬结构与数值，禁止整文件引入** —— `tokens.css` 的 `*,*::before,*::after`、`html,body`、`button{}`、`input,textarea,select{}` 一律不入库（理由见 `STRATA_MANAGER_PORT_ASSESSMENT.md` §5 三条冲突）。
7. `var()` 兜底方向必须是「上游 token 在前、本项目 token 兜底」：写 `var(--st-line, var(--border-color))`。**反向写法会静默失效**（上游 `var(--st-line, var(--border))` 里的 `--border` 本项目不存在 → 整条声明不生效、不报错）。
8. 7 个无前缀撞名类 `.panel .notice .metric .badge .empty .field .chart`（`.panel` 在 `app.css:55`）移植时必须改名 `.st-*` 或用作用域容器包裹。
9. **新代码（CSS 与 TSX）只准用 `--st-*`**：`--bg-color` / `--card-bg` / `--text-primary` / `--border-color` 一类旧名只是给 705 处存量引用用的兼容别名，**新写的一律不准用**，旧别名只减不增（§3 三条硬规定）。
10. **断点只准用 `640` / `900` 两个值**（决策 9）：新写的 `@media` 一律 `max-width:640px` 或 `max-width:900px`；确需"仅桌面"时用 `min-width:901px`（与 900 构成互补对，**不重叠**）；不得再引入 768 / 960 / 1000 / 1100 一类新档位。**CSS 变量不能用作媒体查询条件**（`@media (max-width:var(--bp))` 无效，需 `@custom-media` + 构建插件，本项目无预处理器、不新增构建步骤）→ 这两个字面值靠本条规范约束，不靠 token。

---

## 8. 实施分解与验收（≈10–13.5 天，全程不动布局）

| 步 | 内容 | 预估 | 验收 |
|---|---|---|---|
| **S1** | 建 `src/styles/tokens.css`（§3 全量 + 兼容层别名）+ 插到 `main.tsx` 引入链最前 | 0.5 天 | **视觉零变化**（只加 token 与别名）→ `npx tsc --noEmit` 通过 + 页面截图与基线一致 |
| **S3** | 字体落地：Outfit + 中文子集入库、`--st-font`/`--st-font-mono` 收口、废弃 `css2.css` 与 FA5/Inter 声明 | 0.5–1 天 | 拉丁渲染 Outfit、中文渲染 MiSans；DevTools 无字体 404；界面全字表比对无回落 |
| **S4** | 图标迁移：sprite 入库 + lucide 补缺 + `<Icon>` 组件 + 152 处替换 + FA 资源退役 | 2–3 天 | `grep 'fa-' src/**` 命中 0；尺寸只有 16/20/24 三档；`<use>` 无失效 id |
| **S2** | 色板全站化：变量表 + 276 处 hex → `var()` | 2–3 天 | CSS 内 hex 只剩 `tokens.css`；**8 页面 + 3 弹窗 × 明暗双主题逐页截图确认**（light 语义色变彩色） |
| **S5** | 清 130 处内联，按文件顺序：~~SettingsPanel 45~~（改由 S7 整页重写消化）→ ModelSheets 16 → StrataPanel 15 → ParamForm 13 → RuntimePanel 12 → ModelListPanel 9 → PresetEditor 7 → BenchPanel 5 | 1.5–2 天 | `style={{}}` 仅剩数据驱动处（目标 ≤5） |
| **S7** | **设置页按上游形态重写 + 「运行环境」页并入**：14 个 tab → 左侧分组导航列表 + 右侧卡片分组 + `<details>` 折叠 + 行式开关（§10.5）；`RuntimePanel.tsx` 262 行**只并「运行时版本」卡**（含 CUDA 目录折叠），其余板块退役后删文件（§10.7）。**前门启停按钮不进设置页**（唯一手动入口是侧栏左下角胶囊，§10.8；本步只按 token 升级它的类名，不改启停逻辑） | 1.5–2 天 | 设置页零 `style={{}}`；导航列表 / 卡片分组 / 折叠三档齐备；顶栏 tab 由 6 减为 5 且旧 localStorage 值不白屏；明暗双主题逐组截图 |
| **S8** | **断点体系统一**（决策 9，§10.4）：6 处散档并入 900（`legacy/index.css:324`/`:835`/`:1190`/`:1976`/`:2919`/`:3200`）、删 2 处冗余（`:3068` 空块、`:3788` 与 `:3718` 重复）；上游面板的 `1000` 档写作 `900` | 0.5 天 | `grep -o 'max-width: *[0-9]*px' src/styles/**` 只剩 640 / 900；改判处逐条对照（表见 §10.4） |
| **S6** | 规范固化 + 全量回归 | 0.5 天 | `npx tsc --noEmit` + `cd src-tauri; cargo test --lib`（基线 93 passed / 5 ignored）+ `npm run test:smoke` + `npm run tauri build` 全绿；**断点矩阵复测**（§10.4 验收矩阵：1440 / 1100 / 1000 / 900 / 899 / 640 / 480 × 明暗两主题） |

布局结构全程不动：`#root` 的 flex 角色（`app.css:9-14`）、`--sidebar-w 232` / `--hub-header-h 54`、296 处 `#id` 骨架**全部保留** → 风险集中在**色板**与**图标**两块。**唯一的例外是断点**：决策 9（2026-10-14 用户定稿）把 28 处 `@media` 统一为 **640 / 900 两档**（S8，迁移表与行为变化清单见 §10.4）—— 这是本轮唯一**会改变既有页面行为**的动作，因此单列一步、配独立验收矩阵。

**开工前置**：因决策不留兼容基线，动工前先开分支打 tag 作为唯一回滚路径（同前门调度 M1 的处理）。

---

## 9. 与其他方案文件的排序

| 对象 | 与样式基座的关系 |
|---|---|
| M1 前门可用 + 前端单端点化、M2 多模型并存 + 容量闸、M3 Strata 并入 9090（`PROXY_SCHEDULER_PLAN.md` §10 决策） | **可并行**（后端与端点改动，不碰样式） |
| M4 原生聊天 UI、M6 监控 UI、M7 用量统计 + BenchPanel 合并 | **必须排在 S1–S8 之后**（决策 2 的硬约束） |
| M5 搜索 `src-tauri/src/search.rs`（`WEB_SEARCH_PLAN.md` §11 决策） | Rust 模块本身可提前；**接入设置页的界面部分排在 S 之后** |
| `STRATA_MANAGER_PORT_ASSESSMENT.md` §6 的 P1/P2 基准上下文档位与七场景 | P1 的图表/导出组件可先做（纯 TS + SVG）；**上面板 UI 排在 S 之后** |

---

## 10. 上游样式基座完整规格（追加决策 7 的落盘依据，2026-10-14 实测）

> 实测来源 `E:\AI\Strata\serve\web\`（`tokens.css` 87 / `components.css` 128 / `app.css` 198 / `index.html` 267 / `sprite.svg` 32 symbol / `app.js` 63,092 B / 字体 2 个 woff2）。**零 CDN、零第三方前端库**（`index.html`/`app.js`/`app.css`/`components.css` 查 `cdn|unpkg|jsdelivr|highlight|katex|mathjax|marked|dompurify|chart` 命中 0，已存档 `E:\tmp\strata_probe.txt`）。本节记的是**结构与数值**，决策 3「不整文件搬」不变。

### 10.1 上游是三层结构

| 层 | 文件 | 行数 | 职责（实测自其首行注释） | 本项目对应 |
|---|---|---|---|---|
| Token 层 | `tokens.css` | 87 | 全部 `--st-*`：字号 8 档、字重 4 档、行高 2、间距 16 档（4pt 基准 `--st-s-1=4px … --st-s-16=64px`）、圆角 5 档、动效 2、light/dark 双份色板、阴影 3 档、`color-scheme` | `src/styles/tokens.css`（§3 已定） |
| 组件层 | `components.css` | 128 | 首行自称 **「the Strata UI kit」；「only tokens, no hardcoded values, prefix `.st-`」** → 与本项目 473 处类名、296 处 `#id` **零撞名** | 新建 `src/styles/components.css`（同语义同名，重写不搬运） |
| 页面层 | `app.css` | 198 | 首行「Colours, type, radii and shadows come only from the kit's tokens」→ 只做布局：聊天排印、监控网格、服务列表、表单网格、抽屉、toast、窄屏 | 各页面布局追加进现有 `src/styles/app.css` |

**结论**：上游 CSS 总量 413 行（本项目 `legacy/index.css` 4057 + `app.css` 1309 = 5366 行）。照抄结构的重写量远小于想象——组件层 128 行是核心资产。

### 10.2 组件层类名清单（照抄结构，本项目同名采用）

| 类别 | 类名 | 关键数值（实测） |
|---|---|---|
| 按钮 | `.st-btn` `-primary` `-soft` `-ghost` `-danger` `-sm` `-icon` `-block` | min-height 36px；`--st-r-btn`；icon 按钮 28×28 内 icon 16；disabled 透明度 |
| 表单 | `.st-field` `.st-label` `.st-hint` `.st-input` `.st-select` `.st-textarea` `.st-check` `.st-input--mono` `.st-input--num` | input/select 统一 `focus` 环 + 高度；`--st-r-field` |
| 容器 | `.st-card` `.st-card__head/__title/__body/__foot/__item` `.st-divider` `.st-row` `.st-col` `.st-spacer` `.st-scroll` `.st-grid` `.st-sec-title` `.st-sub` `.st-num` | 卡片阴影 `--st-sh-card`；`__item` hover 底色 |
| 折叠 | `.st-collapse` `.st-collapse__head` `.st-collapse__body` `.st-collapse:not(.is-open) .st-collapse__body{display:none}` | 上游用原生 `<details>` 驱动 |
| 导航 | `.st-tabs` `.st-tab.is-active` `.st-seg` `.st-seg__btn.is-on` `.st-nav__row.is-active` `.st-nav__count` | 侧栏导航行 + 右侧计数徽标（**设置页新导航就用这两个**） |
| 弹层 | `.st-drawer` `.st-drawer__head/__title/__body` `.st-drawer.is-open` `#drawer-close` `.st-backdrop` | 抽屉滑入 260ms、`--st-r-popover` |
| 指示 | `.st-dot.is-on/off/busy/init` `.st-badge.is-ok/warn/err/accent/primary/stopped` `.st-kv` `.st-kvrow` `.st-skel` `.st-skel--row` `.st-toast` | 骨架屏 + toast 动画 `toast-in 180ms var(--st-ease)`，from `opacity:0;translateY(6px)` |
| 聊天专用 | `.st-msg.is-user/.is-assistant` `.st-bubble` `.st-code` `.st-collapse__body.thinking` `.cursor::after` `.msg-images` `.st-msg__meta` | 见 §10.3 |

### 10.3 聊天排印规格（照抄上游 `app.css:16-50`，M4 聊天 UI 的实现依据）

- 滚动容器 `.chat-scroll{flex:1;min-height:0;overflow-y:auto}`；内容 `.chat{max-width:860px;margin:0 auto;padding:var(--st-s-8) var(--st-s-6) var(--st-s-6);gap:var(--st-s-6)}`
- 空态 `.chat-empty{margin:12vh auto 0;text-align:center}`；标题 `font-weight:var(--st-fw-black)` + `font-size:var(--st-fs-display)` + `letter-spacing:-.02em`
- 消息方向 `.st-msg--assistant{align-self:flex-start}`；user 气泡 `white-space:pre-wrap;overflow-wrap:anywhere`
- 气泡内排印：`p/ul/ol{margin:0 0 var(--st-s-3)}`；`ul/ol{padding-left:var(--st-s-6)}`；`li+li{margin-top:var(--st-s-1)}`；`h3{font-size:var(--st-fs-lg);margin:var(--st-s-4) 0 var(--st-s-2)}`；`h4{font-size:var(--st-fs-base)}`；`blockquote{border-left:3px solid var(--st-line);color:var(--st-ink-muted)}`；`hr{border-top:1px solid var(--st-line)}`；`table{font-size:var(--st-fs-md)}` + `th,td{border:1px solid var(--st-line);padding:6px 10px}`
- 行内码 `.st-bubble code.inline{font:400 .9em var(--st-font-mono);background:var(--st-surface-2);border:1px solid var(--st-line-soft);border-radius:6px;padding:1px 5px}`
- 图片 `.msg-images img{max-width:220px;max-height:180px;border-radius:var(--st-r-md);border:1px solid var(--st-line)}`
- 思考折叠 `.st-collapse__body.thinking{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow-y:auto}`
- 流式光标 `.cursor::after{content:"";display:inline-block;width:8px;height:1.1em;margin-left:2px;vertical-align:-3px}`（上游该规则尾段未取全，实施时以 `--st-accent` 填 background 并配 2 帧动画）

### 10.4 断点体系统一（决策 9，2026-10-14 用户定稿）

> 本节原稿标题是「断点体系冲突」，处置是「老页面 29 处一律不动、新面板用上游 1000/640」。用户 2026-10-14 决定**统一档位**，故选型改写为迁移方案；原稿「本项目用 min-width 递增」的说法**不准确**（实测 28 处里 **25 处本来就是 `max-width`**：900×15 + 768×5 + 640×2 + 960/1000/1100 各 1，只有 `app.css:39` / `:295` 两处是 `min-width:901`，另 1 处 `prefers-reduced-motion` 不是断点）。

**实测现状（28 处 `@media`，逐块读出）**

| 档位 | 处数 | 位置 | 内容 | 处置 |
|---|---|---|---|---|
| max-width **900** | 15 | `legacy/index.css:2036`（HF 详情 gguf 项竖排）、`:3718`（`.settings-layout` padding + `.settings-field-row` 单列）、`:3993`（`.node-card` 单列）、`:4029`（移动端顶栏 `body{flex-direction:column}` + `.mobile-header`）、`:4185`（`.settings-tabs` 横滑 + `.modal-footer`）、`:4193`（隐藏 `#modelViewToggle` 与加载弹窗能力区）、`:4203`（`.load-model-mobile-tabs`）、`:4231`（加载弹窗底部按钮）、`:4248`（移动端字号收敛）、`:4257`（隐藏只剩标题的 `.top-bar`）、`:4262`（`#main-sysinfo` 长文本换行）、`:4267`（模型图标缩小）；`app.css:19`（`#root` 竖排）、`:1023`（`.page-fill` padding + 隐藏 `.log-sources`）、`:1268`（`.bench-split` 竖排） | 主力断点 | **不动** |
| max-width 768 | 5 | `legacy/index.css:324`（`.log-filter-select` padding）、`:835`（`#modelsList.grid-view` 单列）、`:1190`（模型详情弹窗全屏）、`:3068`（**空块**，注释写"由文件末尾统一实现"）、`:3788`（`.settings-field-row` 单列） | — | 3 处并入 900、2 处删 |
| max-width 640 | 2 | `legacy/index.css:3741`（设置页顶栏阴影 + `.settings-layout` padding）、`:4002`（`.node-card` padding） | — | **不动** |
| max-width 960 | 1 | `legacy/index.css:2919`（`#updateResultArea` 单列） | — | 并入 900 |
| max-width 1000 | 1 | `legacy/index.css:3200`（`.hf-panel-split` 单列） | — | 并入 900 |
| max-width 1100 | 1 | `legacy/index.css:1976`（`#main-hf .hf-split` 竖排 + 左栏 `flex:0 0 280px`） | — | 并入 900（**风险最高**） |
| min-width **901** | 2 | `app.css:39`（加载弹窗两列）、`:295`（`.top-bar` 高度 `--hub-header-h`） | 与 `app.css:19` 的 max-width:900 成**互补对**（≤900 移动 / ≥901 桌面，无重叠） | **不动** |
| `prefers-reduced-motion` | 1 | `legacy/index.css:3077`（`.fa-spin`） | 非断点 | 不动 |

**统一目标：两档 `640` / `900`，主断点取 900（取代上游的 1000）**

选 900 而不是 1000 的理由：900 档已承载 15 处既有适配，是事实上的主力；把主断点提到 1000 会让 **901–1000 区间从"桌面排版"变"移动排版"**，等于把这 15 处规则的效果全部改掉；而把**上游**的 1000 写成 900 是零成本的 —— 上游面板尚未移植，改了不影响任何既有页面。

**迁移表**

| 处置 | 处数 | 明细 |
|---|---|---|
| 不动 | 19 | 900 档 15 处 + 640 档 2 处 + `min-width:901` 2 处 |
| 改判为 900 | 6 | `:324`（768→900）、`:835`（768→900）、`:1190`（768→900）、`:2919`（960→900）、`:3200`（1000→900）、`:1976`（1100→900） |
| 删除 | 2 | `:3068` 空块；`:3788` 与 `:3718` **重复**（两处都是 `.settings-field-row{grid-template-columns:1fr}`，900 档那条更宽、已覆盖） |
| 非断点保留 | 1 | `:3077` |

**行为变化清单（改判 6 处各自会发生什么 —— 这是本轮唯一改既有页面行为的动作）**

| 位置 | 变化 | 幅度 |
|---|---|---|
| `:324` `.log-filter-select` padding | 768–900 区间提前变紧凑 | 无感 |
| `:835` `#modelsList.grid-view` 单列 | 768–900 区间提前单列 | 可见（更早单列，通常更好） |
| `:1190` 模型详情弹窗全屏 | 768–900 区间提前全屏 | 可见 |
| `:2919` `#updateResultArea` 单列 | 901–960 区间**恢复多列**（原本 ≤960 都单列） | 可见 |
| `:3200` `.hf-panel-split` 单列 | 901–1000 区间**恢复双列** | 可见，HF 页要目视 |
| `:1976` `#main-hf .hf-split` 竖排 | 901–1100 区间**恢复横排**（左栏固定 280px） | **风险最高**：HF 页在 901–1100 宽度下横排可能拥挤，验收重点 |

**约束与验收**

1. **`@media` 条件不能用 `var()`**：`@media (max-width:var(--bp))` 无效；要参数化必须 `@custom-media` + PostCSS 插件，而本项目无预处理器、不新增构建步骤 → 两个字面值靠 §7 第 10 条规范约束（与 `--st-*` 不同，断点无法 token 化）。
2. **验收矩阵**：`1440 / 1100 / 1000 / 900 / 899 / 640 / 480` 七档宽度 × 明暗两主题，逐页过 8 页面 + 3 弹窗；其中 `899` 与 `900`、`900` 与 `901` 是互补对的边界对，必须分别截图。
3. 命令核对：`grep -o 'max-width: *[0-9]*px' src/styles/legacy/index.css src/styles/app.css | sort -u` 应只剩 `640px` 与 `900px`。
4. **顺序**：S8 排在 S7 之后、S6 之前 —— 设置页重写会产生新的窄屏需求，先重写再统一可避免改两遍。
5. **与上游的关系**：后续照搬上游面板时，其 `@media (max-width:1000px)` 一律写作 `max-width:900px`，`@media (max-width:640px)` 原样保留（上游该节内容：`.metrics` 2 列、`.monitor-row`/`.cc-bars`/`.cfg-form` 单列、`.st-header` 收 padding、`.st-tabs{margin-left:0}`、`.st-tab{padding:0 10px}`）。
6. **HF 两处的处置已确认（2026-10-14 用户定稿）**：`#main-hf .hf-split`（`legacy/index.css:1976`，原 1100 档）与 `.hf-panel-split`（`:3200`，原 1000 档）**按 900 走**，即 **901–1100 宽度下 HF 页恢复左右分栏**（左栏固定 `flex:0 0 280px`）。验收矩阵中 HF 页在该区间**逐一目视**；**若确认拥挤再单独议** —— 届时只能给 HF 破例留一档，属对决策 9 的局部回退，需回到本文档改迁移表。

### 10.5 设置页结构映射（决策 7 的实施依据）

上游没有 tab。实测形态 = **左侧分组导航列表（`.st-nav__row.is-active` + `.st-nav__count`）+ 右侧卡片分组（`.st-card__head/__body/__item`）+ 折叠（`.st-collapse`）+ 行式开关（`.st-switch-row`）**。本项目 14 个 tab 的归并：

| 现状 tab | 归入上游分组 | 采用的上游结构 |
|---|---|---|
| 运行、模型 | **服务** | 服务列表 `.st-svc-row__name/__model/__status` + 详情网格 `.st-svc-detail__grid` |
| （来自「运行环境」页，决策 8） | **服务**（首卡） | 版本表用 `.st-table` + `.st-badge`，版本切换用 `.st-seg`，前门启停按钮放 `.st-card__head` —— 逐项见 §10.7 |
| 参数（`ParamForm.tsx` 766 行） | **服务 → 高级** | `.st-collapse` + 表单网格（上游 `cfg-form` 窄屏降 1 列） |
| 路径 | **通用** | 卡片分组 + `.st-input` |
| 代理 | **服务**（服务级设置） | `.st-collapse` + 表单网格 |
| 网络与更新 | **通用** | 卡片分组 + `.st-btn` |
| 界面、主题 | **通用** | `.st-switch-row` + `.st-seg__btn.is-on`（明 / 暗 / 随系统三段） |
| 预设（`PresetEditor.tsx` 679 行） | **服务** | 抽屉 `.st-drawer.is-open` + `.st-backdrop`（滑入 260ms） |
| HuggingFace | **搜索** | 上游无对应 → 用组件层同类新建一组（不新造视觉语言） |
| 联网搜索（M5 新增） | **搜索** | 同上 |
| 高级 | **高级** | `.st-collapse` + `.st-switch-row` |
| 用量、监控、基准 | **不进设置页导航** | 属独立视图（上游靠 `data-view` 切），与 M6 / M7 同批交付 |
| 说明 | **删除** | 上游无对应；内容已并入本仓库文档 |

同步收益：`SettingsPanel.tsx` 的 45 处内联随整页重写消失（该文件是内联最集中处，占全站 130 处的 35%）；tab 状态机换成导航项状态，`setTheme` 三段沿用现有 `document.documentElement.dataset.theme` 机制（`src/store.ts:497-499`）。

### 10.6 本轮实测坑（追加 5 条）

1. 上游全库仅两处**非 token 字面值**：`.st-bubble code.inline` 的 `border-radius:6px` 与 `.st-bubble th,td` 的 `padding:6px 10px` → 照搬时统一成 `--st-r-sm`（8px）或明确豁免这两处，验收阶段不要当违规追查。
2. 上游 `html,body{height:100%}` + `body{display:flex;flex-direction:column;overflow:hidden}` + `main{flex:1;min-height:0}` 是它整页滚动控制的前提；本项目同等角色由 `#root` 承担（`app.css:9-14`）→ **禁止引入上游这三条**，否则双重 flex 直接打乱现有布局（对应 `STRATA_MANAGER_PORT_ASSESSMENT.md` §5 冲突②）。
3. 上游靠 `[hidden]{display:none!important}` 切视图与折叠；本项目是条件渲染 → `<details>`/抽屉方案不依赖它，跳过不搬。
4. 上游唯一使用 `#id` 的样式是 `#drawer-close .st-icon{transform:rotate(-90deg)}` → 本项目规范禁止新增 `#id`，改写为 `.st-drawer__close .st-icon`。
5. 上游 `.st-header .st-tabs{margin-left:var(--st-s-4)}` 假定 header 与 tabs 同级；本项目 header 是 `.top-bar`（高度由 `--hub-header-h 54px` 固定）→ 搬 tabs 时挂进 `.top-bar` 内层，不要复制 header 规则。

### 10.7 「运行环境」页并入设置页的映射（决策 8，2026-10-14 实测）

现状：`src/components/RuntimePanel.tsx` **262 行**（实测），入口是 `src/App.tsx:25` 的 `{ id: "runtime", label: "运行环境", icon: "fas fa-microchip" }`。页面原本由四块组成，2026-10-14 用户定稿后**只并入两块**（版本表 + 前门启停），**推理设备表与路径信息直接退役**：

| 运行环境页现有板块 | 内容 | 处置 | 采用的上游结构（仅并入项） |
|---|---|---|---|
| 已发现的 llama.cpp 版本 | 表格**实测 6 列**（`RuntimePanel.tsx:118-168`）：① radio 选择（写 `settings.selected_version`）、② 版本名、③ router mode 支持性（`has_router_mode`：支持/不支持/未探测）、④ 纯 ASCII / 含非 ASCII（自动用链接目录）、⑤ **共享 CUDA 运行时目录**（`shared_lib_dirs`；空 → 「未匹配」+ title「未匹配到直接包含 `cudart64_`/`cublas64_` 的目录，GPU 将不可用」，非空 → 现平铺显示各目录名）、⑥ `fit_params_bin` 是否就绪（✓ / —） | **服务**组首卡「运行时版本」 | `.st-card` + `.st-table` + `.st-badge`；版本切换用 `.st-seg` 替代 radio；**⑤ 列改成 `<details>`/`.st-collapse` 折叠**（用户定稿：**不恢复推理设备表，只加这个折叠**）—— 默认只显示「已就绪（N 个目录）」或「未匹配」，展开列出探测到的目录**完整路径**，排查入口保留；**③ 列随 A1 前门化退役**（`has_router_mode` 探测的是 router mode，router 退役后该列无意义；`src/types.ts:24`/`:109` 字段与 `versions.rs` 的探测是否一并清理由后端简化另议） |
| 推理设备 | 表格：设备 / 型号 / 总显存 / 空闲显存 +「未枚举到设备」提示 + 多卡策略说明段（`--fit` 默认行为 + 设备 / fit on-off / GPU 层数三个 tag） | **不并入 —— 直接退役**（用户决策：这块不要了） | `.st-card` + `.st-table`（显存列 `.num`）+ `.st-progress`（空闲占比，`data-tone="warn\|danger"`）+ 说明段用 `.st-note` |
| 路径信息 | 配置目录 / `presets.ini`（交给 router 的原生预设）/ ASCII 链接目录 三行键值 | **不并入 —— 直接退役**（用户决策：不要了） | `.st-kv`（key 用 `--st-ink-muted`，value `tabular-nums`） |
| 四个动作按钮 | 扫描版本 / 重新枚举设备 / 停止 router / 启动 router | **只并入「扫描 llama.cpp 版本」一个**（放卡片头部，用户指定改名）；**「重新枚举设备」随设备表删除**；**前门（router）启停不进设置页**（用户 2026-10-14 决策 —— 前门由 GUI 托管，是否仍需手动启停按钮在 M1 一并确认，暂定留在服务/模型列表页顶部动作行） | `.st-btn--secondary` | `.st-btn--secondary` / `.st-btn--danger` + `.st-btn__spin` |
| 页头徽标 | 「运行环境」标题 +「N 个版本」徽标 | 服务组导航项计数 | `.st-nav__count` |

**退役不等于删数据链**（实测，别误删）：设备枚举结果仍被三处消费 —— `src/components/ModelSheets.tsx` 的 `:119`/`:185`/`:291`/`:362`/`:457`/`:460`/`:545`/`:561`/`:580`/`:593`（选主 GPU、fit 预览、下标校验、设备下拉）、`src/components/ParamForm.tsx:586`/`:590`（设备参数下拉）、`src/components/BenchPanel.tsx:38`/`:392`（压测参数里的设备串）；`src/store.ts` 的 `paths` 字段也仍被 `src/components/BenchPanel.tsx:36` 使用。所以 `src/store.ts` 的 `versions`/`devices`/`cudaReady`/`deviceError`/`paths`/`refreshVersions`/`refreshDevices` 与后端 `src-tauri/src/gpu.rs`（枚举设备 / 探测 `cudart64_`·`cublas64_` / 建 ASCII 链接目录）**一行不改**。

四条实施约束（开工时照此执行）：

1. **只动前端呈现层**：`src/App.tsx` 三处（`:15` Tab 联合类型、`:25` 顶栏项、`:321` 条件渲染）+ 设置页新增的「运行时版本」卡片；`src/store.ts` 与后端 `src-tauri/src/gpu.rs`（枚举设备 / 探测 `cudart64_`·`cublas64_` / 建 ASCII 链接目录）以及前门启停的 IPC **零改动**（注意：原稿写的 `src/hooks/useRuntime.ts` 并不存在，本项目没有 hooks 目录，数据一律来自 `src/store.ts`）。
2. `RuntimePanel.tsx` 的 **12 处内联随文件删除直接消失**（不是"迁成类名"），S5 清单里该行由 S7 消化（与 `SettingsPanel` 同样处理）。
3. `src/App.tsx:15` 的 `Tab` 联合类型去掉 `"runtime"`、`:25` 顶栏项删除、`:321` 条件渲染删除 → **tab 由 6 个减为 5 个**。**必须处理 localStorage 里已存的 `"runtime"` 值**（读出的 tab 不存在时回落 `"settings"`），否则老用户下次打开是空白页。
4. **与 M6 监控的边界**：并入后的设置页只剩**能力盘点与选择**（用哪个 llama.cpp 版本、共享 CUDA 运行时是否就绪）；**设备总览与运行时负载一律不在这里展示** —— 设备由模型页与参数表单按需消费（清单见上一段），温度曲线、显存占用、逐请求归 M6，不得重复实现。**排查入口靠 ⑤ 列的折叠保住**：展开即见探测到的 `cudart64_`/`cublas64_` 目录完整路径，未匹配时折叠内直接给出「GPU 将不可用」原文案（这样退役设备表不会让 GPU 排查变成盲区；S7 验收时确认展开内容可读）。

### 10.8 前门启停的唯一 UI 入口：侧栏左下角胶囊（决策 8 配套，2026-10-14 用户定稿）

用户定稿：**前门启停不进设置页**，入口就是导航栏（侧栏）左下角那颗胶囊。实测现状 —— `src/App.tsx:234-316` 的 `<div className="sidebar-footer">` 里现在有**两颗**同款胶囊（`.router-pill`）：

| 现有胶囊 | 行号 | 行为与文案 | 前门化后怎么处理 |
|---|---|---|---|
| Strata 胶囊 | `src/App.tsx:237-289` | 点击 = `startStrataProxy()` / `stopStrata()` / `stopStrataProxy()`；文案「Strata 代理 :{port}」/「Strata 引擎 :{port}」/「Strata 未运行」；图标 `fa-play`/`fa-stop`/`fa-lock`；非 GUI 启动的实例置灰（`strataStatus.external`）；下方一行 `sidebar-foot-note` 状态说明 | **与下一颗合并成一颗** —— A3「统一入口只留 9090」+ M3「Strata 通道并入 9090」之后，两者本来就是同一个前门进程，留两颗是重复入口 |
| router 胶囊 | `src/App.tsx:292-310` | 点击 = `startRouter()` / `stopRouter()`；文案「router 运行中 · :{port}」/「router 未运行」；`disabled={busy \|\| (!status.running && !settings?.llama_cpp_dir)}` | 改名「前门运行中 · :9090」/「前门未运行」，**仍是唯一的手动启停入口**（设置页与模型页都不再放按钮） |
| 版本小字 | `src/App.tsx:311-314` | `sidebar-foot-note` 显示 `status.version` | 保留（与 `App.tsx:123` 注释所述的共用字号约定一致） |

实现要点：

1. `.router-pill` / `.is-running` / `.is-stopped` / `.status-dot.online|offline` / `.router-pill-text` 是 hub 风格类名，S2/S7 阶段按 token 升级为上游 `.st-pill` + `.st-pill__dot` + `data-state`（结构照搬、数值取本项目 token），不整文件引上游 CSS。
2. 合并后 `disabled` 条件与 tooltip 文案要重写（现有「先到「设置」里指定 llama.cpp 目录」这条仍然有效）；**非 GUI 启动的实例仍置灰**（现有语义保留：我们停不了别人起的进程）。
3. 该胶囊在**明暗双主题**与**窄屏抽屉**（`body.mobile-nav-open`，`src/App.tsx:94-98`）下都必须可见，S7 验收时一并截图。
