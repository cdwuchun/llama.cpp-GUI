# dsh 双端插件最小可行骨架调研报告

调研对象：`E:\Code\dsh-vision-toolkit`（已安装可运行的 dsh 双端插件，包名 `@anionex/dsh-vision-toolkit`，v1.6.0）
对照资料：dsh 安装体 `E:\Software\DeepSeek Harness\resources\app.asar` 内的官方作者指南与运行时代码（下文「asar 行号」即该归档按行切片后的行号）
本次调研未修改任何文件。

---

## 0. 结论速览：什么算「双端插件」

一个 dsh 插件 = 一个 npm 包 + 一个 Loader patch 行。所谓「双端」，是指同一个包同时提供：

| 半侧 | 运行位置 | 入口由什么决定 | 产物 |
| --- | --- | --- | --- |
| host（Node） | dsh 宿主进程，cordis 插件 | `exports["."]`（默认 `main`） | `lib/index.js` |
| client（浏览器） | dsh Web 前端，React + cordis | **`exports["./client"]`** | `lib/client.js` |

三条硬约束（后面每条都有原文出处）：

1. host 半侧入口必须是 cordis 插件（`export function apply(ctx, config)`，可配 `export const inject` / `export const Config`）。
2. client 半侧入口必须是一个 `window.__ModuleLoader__.load({ id, factory })` 脚本，`factory` 的返回值（或 `exports`）同样是一个 cordis 插件（`{ inject, apply }`）。
3. **`dsh.client` 里不给路径**：浏览器入口路径只由 `exports["./client"]` 决定；`dsh.client` 只声明 `platform` / `inject` / `external` / `immediately`。

最小可行骨架（纯 JS，4 个文件，零构建）来自 dsh 自带的官方模板 `templates/decoration/`（skill `cordis-plugin-development`）：

```
my-plugin/
  package.json         # 声明 dsh.bundle.patch + dsh.client + exports["./client"]
  cordis.patch.yml     # 把插件行插进 profile 的组合
  index.js             # host 半侧：export function apply() {}
  client.js            # 浏览器半侧：window.__ModuleLoader__.load({...})
```

---

## 1. `package.json` 的 `dsh` 字段

### 1.1 官方最小写法（原文，`asar:dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/package.json`）

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

### 1.2 生产级写法（`E:\Code\dsh-vision-toolkit\package.json:36-120`）

```json
"exports": {                                                    // L36
  ".": {                                                        // L37
    "types": "./lib/types/index.d.ts",                          // L38
    "default": "./lib/index.js"                                 // L39
  },
  "./client": {                                                 // L41
    "types": "./lib/types/client/index.d.ts",                   // L42
    "default": "./lib/client.js"                                // L43
  },
  "./cordis.patch.yml": "./cordis.patch.yml",                   // L45
  "./package.json": "./package.json"                             // L46
},
...
"dsh": {                                                        // L75
  "bundle": {                                                   // L76
    "patch": "./cordis.patch.yml"                               // L77
  },
  "client": {                                                   // L79
    "inject": [ ...9 个包名... ],                                // L80-90
    "platform": "web"                                           // L91
  },
  "visionToolkit": { ...私有元数据，与 dsh 机制无关... },          // L93-98
  "compatibility": {                                            // L99
    "dsh": ">=0.1.0-rc.8 <0.2.0",                               // L100
    "dshReleases": { "0.1.0-rc.8": "compatible", ... },          // L101-114
    "profiles": ["web", "headless"]                             // L115-118
  }
}
```

### 1.3 各部分含义

**`dsh.bundle.patch`** —— 把这个包标记为 bundle，并指定它携带的 Loader patch 文件，值可以是单个路径字符串，也可以是有序路径数组（数组按顺序拼接应用）。asar 原文（`asar:359011-359021`）：

```js
/**
 * The patch files a bundle declares, as written: one file for a string
 * `patch`, the listed files in order for an array.
 */
function bundlePatchFiles(bundle) {
	const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
	if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
	return declared;
}
```

路径是**包内相对路径**，由 `bundlePatchPaths(packageDir, bundle)` 解析成绝对路径（`asar:359030-359032`）。

**`dsh.client.platform`** —— 必填且必须是字符串，缺失即报错。asar 原文，`parseDshClient`（`asar:379144-379158`）：

```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return { platform: decl.platform, ... };
}
```

即 `dsh.client` 合法键只有四个：`platform`（必填 string）、`inject`（可选 string[]）、`external`（可选 string[]）、`immediately`（可选 boolean）。`platform` 的值是应用面（本机 Web 面为 `"web"`；dsh 官方文档里 profile 名另有 web/headless/acp/sdk 等）。

**`dsh.client.inject`** —— **只决定浏览器半侧的激活顺序 / 依赖等待**，不是 import 白名单，也不打包任何东西。官方指南原文（`asar:295011`）：

> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`).

**`exports["./client"]`** —— 浏览器半侧入口的**唯一**来源。asar 原文（`asar:380679-380689`）：

```js
const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
...
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
...
clientPath: join(dirname(pkgPath), clientRel),
```

即：**声明了 `dsh.client` 却没有 `exports["./client"]`，会在组合期直接抛错**。反过来，`./client` 子路径也常被其他包当作模块名引用，Loader 会把 `<包名>/client` 与裸包名归一到同一行（`asar:379173-379183`）：

```js
function stripClientSuffix(spec) {
	return spec.endsWith("/client") ? spec.slice(0, -7) : spec;
}
```

**`dsh.compatibility`** —— 本机 dsh 运行时代码里**没有**这个字段的消费者（在 app.asar 内检索 `dshReleases`、`dsh?.compatibility` 均无命中）。它属于第三方作者的自我声明（哪些 dsh 版本被自己验证过、支持哪些 profile），由插件管理器/UI 或作者自己的脚本读取展示。真正被 dsh 强制执行的兼容性检查是另一套 —— asar 原文（`asar:358135`）：

> Before a profile imports a plugin, DSH checks its `peerDependencies` on `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` against the single runtime version returned by `getDshRuntimeVersion()`. Every declared range must match; prereleases participate in range matching. ... Missing DSH peers impose no constraint; invalid ranges are incompatible. These checks use peer declarations, not `engines.dsh`, and are not a sandbox against malicious package code.

**结论：想让插件真的能被装进当前 dsh，靠的是 `peerDependencies` 里的版本区间，不是 `dsh.compatibility`。** 本插件的区间写法见 `package.json:127-150`，例如统一使用：

```
">=0.1.0-rc.8 <0.2.0 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1"
```

另有精确版本豁免机制：profile 自己的 `compatibility.json`（本机为 `C:\Users\WuChun\.dsh\profiles\desktop\compatibility.json`），把 `包名@版本` 映射到允许的 dsh 运行时版本列表（`asar:358139`）。

---

## 2. `cordis.patch.yml`：完整内容与作用

### 2.1 本插件的 patch（`E:\Code\dsh-vision-toolkit\cordis.patch.yml` 全文 6 行）

```yaml
# dsh-vision-toolkit bundle patch: mounts the plugin into a profile layer stack.
# Runtime defaults live at the plugin's config boundary. Users override them in
# their profile patch row with the same id.
- insert:
    - id: vision-toolkit
      name: '@anionex/dsh-vision-toolkit'
```

要点：patch 是一个 **YAML 顶层数组**，每项是一个 patch 条目；这里只有一个 `insert` 条目，它的值是**要插入的行列表**。行最少只需 `id` + `name`；`name` 是 Loader 的模块说明符（包名、绝对路径、`file:` URL、`./`/`../` 相对路径都行，见 `asar:358148`）。

官方模板的 patch 更短（`asar:.../templates/decoration/cordis.patch.yml`）：

```yaml
- insert:
    - id: my-decoration
      name: '@local/my-decoration'
```

### 2.2 它怎么被 profile 加载

profile 是 dsh 的一套应用面组合，位于 `$DSH_HOME/profiles/<name>`（本机 `C:\Users\WuChun\.dsh\profiles\desktop`、`...\profiles\web`）。profile 的 `package.json` 用 `dsh.profile.bundles` 列出启用的 bundle（本机原文 `C:\Users\WuChun\.dsh\profiles\desktop\package.json:13-28`）：

```json
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@anysearch/anysearch-dsh",
      "billion-context",
      "dsh-cost-meter",
      "dsh-rewind-plugin",
      "@anionex/dsh-vision-toolkit",
      "@duke-dsh-plugins/dsh-archive-manager",
      "@deepseek-ai/dsh-experimental-auto-review",
      "@local/dsh-zh-presets"
    ]
  }
}
```

加载顺序与叠加规则（asar 原文 `asar:358133`）：

> A bundle's `dsh.bundle.patch` names one patch file or an ordered list of files; `bundlePatchFiles` validates the declaration and `bundlePatchPaths` resolves it to absolute paths; the layer concatenates their patch lists in that order.

以及用户层的覆盖（`asar:358144`）：

> `cordis.patch.yml` — your tweak layer, applied after every bundle layer (per-profile first, then the home-level file, which therefore outranks it): replace one entry's whole config (restating the fields you keep), insert new entries, or interpolate `!!js` expressions at boot. A patch naming an entry that does not exist prints a stderr warning; an empty or comments-only file fails boot — disable the layer with `[]` instead.

**最重要的语义**：同一 `id` 的后续 patch 会**整体替换 config**（不是深合并），所以用户想改一个字段必须把要保留的字段全部重述。本机真实例子 `C:\Users\WuChun\.dsh\profiles\desktop\cordis.patch.yml:5-25` 就是这么写的（重述 provider 全字段 + 其余字段），并配 `disabled: false`：

```yaml
- id: vision-toolkit
  disabled: false
  config:
    provider:
      baseUrl: https://open.bigmodel.cn/api/paas/v4
      credential: ANIONEX_FREE_VISION
      model: glm-4.6v-flash
      protocol: openai
      anthropicThinking: omit
      userAgent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36
    language: zh
    timeoutMs: 30000
    ...
```

同一文件里还有 `- id: llm-deepseek` + `disabled: true`（L57-58）演示「只禁用不配置」，以及 `- id: ui-chat` / `name: "@deepseek-ai/dsh-client-ui-chat"` 这类「按 id + name 覆盖某个既有行的 config」写法（L36-40）。

### 2.3 `insert` 语法与 `!!js` 表达式

- `insert` 的值是**行列表**（数组），每行 `{ id, name, config?, disabled? }`；也可以写嵌套组（native group / `cordis:include`）。
- `!!js` 是 Loader YAML 的表达式标签，在 boot 时求值，适合引用环境变量/凭据而不落明文（`asar:358144` 与 `asar:295017` 附近文档）。**本插件的 patch 没有用 `!!js`**，也没有 config 段 —— 这是「默认值写在插件自身 Config schema 里，用户按需覆盖」的推荐形态。
- patch 加载时会把绝对路径与相对 patch 的 `./`/`../` 路径转成 `file:` URL（**仅限 `insert` 行及其嵌套组**），既有的 `name` 断言与替换的 `config` 值保持字面量（`asar:358148`）。
- 预览有效组合：`dsh --dump-config`；它会把 `!!js` 原样打印，并标注每条 patch 来自哪个文件（`asar:358156`）。

---

## 3. host 侧入口：`ctx` 约定与生命周期

以 `E:\Code\dsh-vision-toolkit\src\index.ts`（277 行）为例。

### 3.1 四个导出约定

```ts
export const name = '@anionex/dsh-vision-toolkit'   // index.ts:47

export { Config }                                    // index.ts:49

export const inject = ['tools', 'credentials', 'skills', 'subprocess', 'settings', 'agents', 'sessions']
                                                     // index.ts:51

export async function apply(ctx: Context, config: VisionToolkitConfig = {}): Promise<() => void>
                                                     // index.ts:124
```

- `name`：**可选**，dsh 的 apply 约定里并没有 `NS` 这个导出（本仓库不存在 `export const NS`）。`index.ts:47` 的 `name` 只是把包名写成常量供自身使用；真正「命名空间」的概念有两个：Loader 行的 `id`（在 `cordis.patch.yml` 里，本插件为 `vision-toolkit`），以及 Settings 命名空间常量 `VISION_TOOLKIT_SETTINGS_NAMESPACE`（`src\config.ts:37`）。**注意两者是不同东西：行 id 是 `vision-toolkit`，而 config.ts 里那个常量值也是 `'vision-toolkit'`，属于作者刻意对齐。**
- `inject`：本插件**必需**的服务名单；缺任一服务时插件不激活（而不是抛错）。框架侧原文（`asar:.../references/practices.md`，`asar:606`）：
  > Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin stays inactive in profiles without them instead of throwing.
- `Config`：schemastery/`z` schema；声明后 Loader 行里的 `config` 会在激活时被校验（框架原文 `asar:572-575`：`export function apply(ctx, config) {}` with optional `export const inject = ['tools']` and `export const Config`）。
- `apply`：**可以 async**，并且**可以返回一个清理函数**（本插件就返回 `Promise<() => void>`）。

另外，host 侧也可以不用 `apply`，而用**默认导出一个 service class**（框架文档给出的两种形态之一）。本插件用的是函数形态。

### 3.2 注册服务 / 工具 / 事件

```ts
activationTool = ctx.tools.register(exposure.activationTool)   // index.ts:172
skill = ctx.skills.register(VISION_SKILLS_SKILL)               // index.ts:173
exposureDisposer = exposure.install()                          // index.ts:174
```

三个 `register(...)` 都**返回一个 disposer**，作者把它们收进 `operationalDisposers` 统一逆序释放（`index.ts:175`、`267-276`）。

可选服务的注册用 `ctx.inject([...], cb)`，而不是顶层 `inject` —— web 路由就是这么挂的，`src\web.ts:596-634`：

```ts
ctx.inject(['webServer'], (webCtx) => {
  webCtx.effect(() => {
    const disposeArtifact = webCtx.webServer.register({ kind: 'prefix', path: ARTIFACT_ROUTE_PREFIX, handler: (req, res) => artifacts.handle(req, res) })
    const disposeSettings = webCtx.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: (req, res) => backend.handle(req, res) })
    ...
    return () => {
      disposeDisplayConfig()
      disposePastePolicy()
      disposePasteImages()
      disposeSettings()
      disposeArtifact()
    }
  }, 'dsh-vision-toolkit: Web routes')
})
```

服务名与路由常量同文件：`export const SETTINGS_ROUTE = '/_dsh/vision-toolkit/settings'`（`src\web.ts:49`）、`export const DISPLAY_CONFIG_ROUTE = '/_dsh/vision-toolkit/display-config'`（`src\web.ts:52`）；服务类型需要靠 side-effect import 引入：`import type {} from '@deepseek-ai/dsh-host-webserver'`（`src\web.ts:14`）。

事件订阅：`src\index.ts:103-104` 在适配层里订阅宿主事件，并用 `interface Events` 做就近的类型增强（因为事件在 dsh 0.1.7 里由 `dsh-app-boot` 发布，而该包不是本插件的依赖）：

```ts
declare module '@deepseek-ai/cordis' {     // index.ts:41-45
  interface Events {
    'app-boot/config-reload'(): void
  }
}
```

### 3.3 生命周期管理

本插件用的是**手工收集 disposer + 返回清理函数**，而不是 `ctx.effect`（host 半侧）：

```ts
export async function apply(ctx, config = {}): Promise<() => void> {   // index.ts:124
  const lifecycle = new AbortController()                              // index.ts:132
  const disposers: Array<() => void> = []                              // index.ts:133
  disposers.push(() => { storageHistory.dispose() })                   // index.ts:135
  ...
  return () => {                                                        // index.ts:267
    lifecycle.abort()                                                   // index.ts:268
    if (operationalDisposers !== undefined) {                           // index.ts:269
      operationalDisposers.exposure()
      operationalDisposers.activationTool()
      operationalDisposers.skill()
      operationalDisposers = undefined
    }
    for (const dispose of disposers.reverse()) dispose()                // index.ts:275
  }
}
```

`AbortController` 的 signal 被透传给工具创建（`index.ts:163-167`），用于取消在途异步工作。日志统一走 `ctx.logger`，printf 风格占位符：

```ts
ctx.logger.warn('dsh-vision-toolkit: %s', error.message)                                       // index.ts:149
ctx.logger.error('dsh-vision-toolkit: keeping the previous runtime after a refused Settings generation. %s', message)  // index.ts:263
ctx.logger.info('dsh-vision-toolkit %s ready (upstream %s @ %s, checkout %s)', ...)            // index.ts:177-179
```

**失败降级**：初始化失败时不抛出（否则整行插件崩掉），而是记 error 并保留 Settings 可修（`index.ts:196-208` 的 catch 分支，错误文案示例 `'runtime not ready; … Settings remain available for repair. %s'`）。

`ctx.effect(fn, label)` 是**首选**写法（自动随 fiber 释放）——host 半侧本插件只在 web 注入里用了一次；浏览器半侧则大量使用（见第 4 节）。

---

## 4. client 侧入口：`src/client/index.tsx`

文件 1623 行，是浏览器半侧的全部内容（另有同目录 `paste-images.tsx`、`model-variants-hider.ts`、`display-config.ts`）。

### 4.1 `apply(ctx)` 做什么（`src\client\index.tsx:1548-1623`）

```ts
export const inject = ['slots', 'locale', 'remote', 'conversation', 'sessions']   // L1549
export function apply(ctx: ClientContext): void {                                 // L1552
  ctx.effect(installStyles, 'dsh-vision-toolkit: styles')                          // L1553
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-vision-toolkit: locale')  // L1554
  installPasteImages(ctx)                                                          // L1555
  ctx.effect(installModelVariantsHider, '…: model-selector transparent routing')    // L1556
  const t = ctx.locale.bind(NS)                                                    // L1557
  ...
}
```

要点：**注册样式、locale、各类监听全部包在 `ctx.effect(...)` 里**，返回的清理函数由 cordis 在该 fiber 释放时调用；`apply` 本身同步返回 `void`。官方指南同款要求（`asar:637`）：

> Keep factories free of side effects. Register styles, timers, listeners and other resources inside `apply` with `ctx.effect`/`ctx.on` and return their cleanup functions.

样式用 `<style data-plugin-css="…">` 幂等注入（`src\client\index.tsx:1536-1546`：先查 `style[data-plugin-css="@anionex/dsh-vision-toolkit/client"]`，存在就返回空清理函数）。

### 4.2 slot 注册：`ctx.slots.inject(...)` + `ctx.slots.register(...)`

工具卡片（每类工具一个视图，用 generator 逐个 yield 注册句柄），`src\client\index.tsx:1558-1574`：

```ts
const injected = () => ({ t })                                    // L1558
...
ctx.slots.inject('tool.call.toolview', function* () {              // L1570
  for (const [key, component] of entries) {                        // L1571
    yield ctx.slots.register({ name: 'tool.call.toolview', key, inject: injected }, component)  // L1572
  }                                                                 // L1573
})                                                                  // L1574
```

Settings 面板（带 `id` / `order` / `label`），`src\client\index.tsx:1616-1622`：

```ts
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'vision-toolkit', order: 30, label: () => t('nav'), inject: () => ({ controller, t }),
}, SettingsSection))
```

官方最小形态（`asar:.../templates/decoration/client.js`）更直观：

```js
ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
  name: 'conversation.composer.dock', id: 'my-decoration', order: 5,
}, Decoration));
```

语义（`asar:622`）：`inject` 的回调所注册的一切，会在**声明者塌缩时被释放、回来时重新装载**；`inject` 提供的对象会成为组件的 props。

### 4.3 locale 字典：`ctx.locale.register` / `ctx.locale.bind`

`src\client\index.tsx:53-241` 用英文表当 key 源，再用 `keyof typeof en` 约束中文表，**漏译直接编译失败**：

```ts
const en = { nav: 'Vision', settingsTitle: 'Vision Toolkit', … }   // L53-241
type LocaleKey = keyof typeof en                                    // L242
const zh: Record<LocaleKey, string> = { … }                         // L244
```

注册与取翻译函数（`src\client\index.tsx:1554`、`1557`）：

```ts
ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-vision-toolkit: locale')
const t = ctx.locale.bind(NS)
```

`NS = 'vision-toolkit'`（`src\client\index.tsx:38`）。翻译函数类型（`src\client\index.tsx:433`）：

```ts
type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string
```

组件通过 props 拿到 `t`，并**给默认值兜底**以免单测/独立渲染时崩：`function GroundView({ block, openFile, t = key => en[key] }: ViewProps)`（`src\client\index.tsx:804`，`ViewProps = ToolCallViewProps & { t?: Translate }` 在 L802）。

### 4.4 React 组件写法

- 组件就是普通函数组件，`import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'`（`src\client\index.tsx:6-11`）。
- 需要跨组件共享的状态用 `class` + `useSyncExternalStore`：`export class VisionSettingsController`（`src\client\index.tsx:942`）配合 `function SettingsSection({ controller, t }: SettingsProps)`（`src\client\index.tsx:1220`）。
- **只允许用主题 token**：官方指南要求只用 `--dsw-alias-*`；禁止 `require('@deepseek-ai/dsh-client-ui-primitives')`（`asar:621`），也禁止用 iframe 承载宿主页面（`asar:619`）：
  > Render plugin pages as React components in a slot. Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`.
- 本插件**故意违反**了该建议：`src\client\index.tsx:12` 有 `import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'`（编译产物 `lib/client.js:78` 对应 `require("@deepseek-ai/dsh-client-ui-primitives")`）。它之所以能跑，是因为该包恰好在浏览器基座模块表里（见第 7 节）。这是一个可用但**不受支持**的做法。

兼容旧/新事件的踩坑（`src\client\index.tsx:1577-1615`）：同时兼容 `ctx.remote.$on('settings/document-updated'|'credentials/reference-updated', …)` 与 `ctx.on('settings/changed'|'credentials/changed', …)`、`ctx.on('connection/reset', …)`，并在返回时逐个 dispose。源码注释指出 DSH 转发的是 `credentials/reference-updated`，**从不发 `credentials/updated`**，而 `$on` 对未知名字静默接受，所以写错名字表现为「死订阅」而不是报错。

---

## 5. 构建流程

### 5.1 三个 tsconfig 的分工

| 文件 | 作用 | 输入 → 输出 |
| --- | --- | --- |
| `tsconfig.json`（32 行） | host 半侧编译 | `src` → `lib/`（声明落 `lib/types`），**exclude `src/client`** |
| `tsconfig.client.json`（43 行） | 浏览器半侧编译（先出中间 CJS） | `src/client` → `.client-build/`（声明落 `lib/types/client`） |
| `tsconfig.client.public.json`（9 行） | 发布态类型校验，**`noEmit: true`** | extends client，去掉 `paths` |

关键差异：host 用 `module: esnext` + `moduleResolution: bundler`；client 用 **`module: commonjs` + `moduleResolution: node`**（因为下一步的 bundle 打包器就是包 `require`），并且 `paths` 里手写了 9 条映射，把 `@deepseek-ai/<pkg>/client` 指到 `./node_modules/<pkg>/lib/types/client/index.d.ts`（依赖包不接受 TS 6 的裸子路径解析）。`tsconfig.client.public.json` 则把这些 `paths` 清空（`paths: {}`），用来验证「在公共解析规则下也编译得过」——**它不生产任何产物**。

host 侧另有两点：`allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true`（所以源码里写 `import ... from './web.ts'`），以及严格的 `noUnusedLocals` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`。

### 5.2 `scripts/build-client.mjs`（67 行）

把 `.client-build/*.js` 逐个包成惰性工厂，产出单文件 `lib/client.js`：

- 读 `.client-build` 下所有 `.js`（按 `localeCompare` 排序）。
- 每个文件包成 `__modules["./<file>"] = function(module, exports, require, __load_) {…}`。
- 字符串改写两处：删掉 `//# sourceMappingURL=` 行；把**相对路径的 `require(`** 改写成 `__load_(`。脚本内注释原文（`scripts\build-client.mjs:28-30`）：
  > Keep host package imports on `require`, but route compiler-emitted local CommonJS imports through the private module table. `__load_` has the same width as `require`, so the sectioned source maps remain aligned.
- 文件头/尾与运行时（`scripts\build-client.mjs:20-21`、`40-57`）：

```js
push('window.__ModuleLoader__.load({ id: "@anionex/dsh-vision-toolkit", factory: (require) => {')
...
var __modules = Object.create(null); var __cache = Object.create(null);
...
function __load(id) {
  if (__modules[id] === undefined) return require(id);   // 未知 id 交给宿主模块表
  ...
}
return __load("./index.js"); } });
```

- 产物：`lib/client.js`（144206 B / 2156 行）+ `lib/client.js.map`（95401 B，`{version:3, file:'client.js', sections}` 分片 source map），随后 `rm(.client-build)`。

### 5.3 构建命令与顺序

`package.json:64` 原文：

```
node scripts/python-bootstrap.mjs && node scripts/upstream-manifest.mjs && node scripts/verify-skill.mjs && node scripts/clean-build.mjs && tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsc -p tsconfig.client.public.json && node scripts/build-client.mjs
```

**顺序要求**（不可换）：
1. `clean-build.mjs` 清掉 `lib/` 与 `.client-build/`；
2. `tsc -p tsconfig.json` 出 host 的 `lib/**`；
3. `tsc -p tsconfig.client.json` 出 `.client-build/**`（中间 CJS）；
4. `tsc -p tsconfig.client.public.json` 只做类型校验（`noEmit`），可放在第 3 步之后任意位置；
5. `build-client.mjs` **必须最后**，它依赖 `.client-build/*.js` 并生成 `lib/client.js`，同时删除 `.client-build`。

### 5.4 产物落点（实测）

```
lib/index.js            10828 B     host 入口
lib/config.js / web.js / tools.js / runtime.js / …              host 其余模块 + .js.map
lib/client.js          144206 B     浏览器单文件 bundle（2156 行）
lib/client.js.map       95401 B
lib/types/*.d.ts                    host 类型
lib/types/client/*.d.ts             浏览器半侧类型
```

`lib/client.js:1` 实测：`window.__ModuleLoader__.load({ id: "@anionex/dsh-vision-toolkit", factory: (require) => {`；`lib/client.js:66-78` 是 `__modules["./index.js"]` 段，其中 `const paste_images_tsx_1 = __load_("./paste-images.js");`（本地模块走内部表），`require("react")` / `require("@deepseek-ai/dsh-client-ui-primitives")`（宿主模块走 `require`）。`lib/client.js:71` 确认 `exports.apply = apply;`、`lib/client.js:1200` 为 `exports.inject = ['slots', 'locale', 'remote', 'conversation', 'sessions'];`。

**没有构建步骤的替代方案**：官方 `templates/decoration/` 四个文件全是手写 JS，`client.js` 直接手写 `window.__ModuleLoader__.load({ id, factory(require) { … return { inject: ['slots'], apply(ctx) {…} } } })`。想要最小骨架就先走这条路。

---

## 6. 定时器 / 后台任务

### 6.1 本插件的实际写法：裸 `setInterval` + 在 dispose 里 `clearInterval`

`src\image-input-variants.ts:1101-1117`：

```ts
if (typeof ctx.on === 'function') {
  ctx.on('llm/adapters-updated', () => { sweep() })
}
sweep()
// Self-heal safety net: re-verify periodically so a wrapper dropped by an
// unobserved cause (registry rebuild without an event we can see) is restored
// within one interval.
const timer = setInterval(() => { sweep() }, VARIANT_SWEEP_INTERVAL_MS)   // L1108
return {
  dispose: () => {
    disposed = true
    clearInterval(timer)                                                  // L1112
    releaseAll()
    evidenceStore.dispose()
  },
  reconcile: () => { sweep() },
}
```

`src\runtime-install.ts:714-722` 是常驻心跳 + `unref()`（不阻止进程退出）+ `finally` 清理：

```ts
const heartbeat = setInterval(() => {
  const now = new Date()
  void utimes(lockPath, now, now).catch(() => {})
}, LOCK_HEARTBEAT_MS)
heartbeat.unref()
try {
  return await fn()
} finally {
  clearInterval(heartbeat)
  ...
}
```

（另一处同类代码在 `src\runtime-install.ts:1137` / `:1250`。）

**本仓库没有任何 `ctx.setInterval` / `ctx.timeout` 用法，也没有 import `@deepseek-ai/cordis-plugin-timer`。**

### 6.2 框架提供的写法：`@deepseek-ai/cordis-plugin-timer`

该包**确实存在于本机 dsh 安装体内**（v1.1.6，路径 `node_modules/@deepseek-ai/cordis-plugin-timer`，原包名 `@cordisjs/plugin-timer`；多个内置组合依赖写作 `"@deepseek-ai/cordis-plugin-timer": "~1.1.6"`）。README 原文（`asar:276667-276702`）：

```
# @cordisjs/plugin-timer

Disposal-aware timer service for Cordis.

## Usage

import { Context } from 'cordis'
import Timer from '@cordisjs/plugin-timer'

const root = new Context()
await root.plugin(Timer)

const dispose = root.timeout(() => {
  root.logger.info('done')
}, 1000)

dispose()

Timer handles are registered on the current fiber, so they are cleared
automatically when the plugin that created them is disposed.

## API

| API | Description |
| `ctx.timeout(callback, delay)` | Run once and return a disposer. |
| `ctx.timeout(delay)` | Return a promise that resolves after `delay`. |
| `ctx.interval(callback, delay)` | Run repeatedly and return a disposer. |
| `ctx.interval(delay)` | Return an async iterator that yields on each interval. |
| `ctx.throttle(callback, delay, noTrailing?)` | Return a throttled function with `.dispose()`. |
| `ctx.debounce(callback, delay)` | Return a debounced function with `.dispose()`. |

`ctx.setTimeout()` and `ctx.setInterval()` are kept as deprecated aliases for
`ctx.timeout()` and `ctx.interval()`.
```

实现原文（`asar:276706-276756`，摘关键行）：

```js
var TimerService = class extends Service {
	constructor(ctx) {
		super(ctx, "timer");
		ctx.mixin("timer", ["timeout", "interval", "throttle", "debounce", "setTimeout", "setInterval"]);
	}
	/** @deprecated use `ctx.timeout()` instead */
	setTimeout(callback, delay) { return this.timeout(callback, delay); }
	/** @deprecated use `ctx.interval()` instead */
	setInterval(callback, delay) { return this.interval(callback, delay); }
	timeout(...args) {
		const callback = typeof args[0] === "function" ? args.shift() : void 0;
		const delay = args[0];
		if (callback) {
			const dispose = this.ctx.effect(() => {
				const timer = setTimeout(() => { dispose(); callback(); }, delay);
				return () => clearTimeout(timer);
			}, "ctx.timeout()");
			return dispose;
		} else { /* Promise.withResolvers() 版本，dispose 时 reject 'Context has been disposed' */ }
	}
	interval(...args) {
		if (callback) return this.ctx.effect(() => {
			const timer = setInterval(callback, delay);
			return () => clearInterval(timer);
		}, "ctx.interval()");
		else { /* 返回 async iterator，dispose 时 reject 'Context has been disposed' */ }
	}
```

**怎么用**：把 `timer` 加进 `inject`（或 `ctx.inject(['timer'], …)`）后用 `ctx.interval(cb, ms)`；返回值本身就是 disposer，且挂当前 fiber，插件卸载自动清。若不想加依赖，就照本插件那样用 `setInterval` + 自己在 dispose 里 `clearInterval`，或把裸定时器写进 `ctx.effect(() => { const id = setInterval(...); return () => clearInterval(id) }, 'label')`。

后台任务相关的另外两条框架建议（`asar:615`、`asar:612`）：定时器若要唤起 agent，用 `agent.followup()`（`agent.inject()` 不会唤醒）；会话态不要订阅 `session/event` 后全量重扫，用 `ctx.sessionProjections` 投影单元。

---

## 7. 浏览器半侧可 import 什么、依赖是否打包

### 7.1 基座模块表（`PLATFORM_MODULES`）

浏览器的静态模块表原文（`asar:1020038`）：

```js
function WS(){return{react:yf,"react/jsx-runtime":jf,"react-dom":Lf,"react-dom/client":Tf,"@deepseek-ai/cordis":Jd,"@deepseek-ai/dsh-client-store":th,"@deepseek-ai/dsh-client-ui-slots":lh,"@deepseek-ai/dsh-client-ui-primitives":qb,"@deepseek-ai/dsh-client-ui-dockkit":FS}}
```

即可直接被 `require` 的种子模块共 9 个：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

### 7.2 `dsh.client.inject` 与 `dsh.client.external` 的区别

- `inject`：**只排序激活、只声明依赖**，不含模块解析含义（`asar:295011` 原文见 §1.3）。本插件列了 9 个包（`package.json:80-90`），其中 `@deepseek-ai/dsh-client-ui-renderer`、`dsh-client-locale`、`dsh-api-gateway`、`dsh-client-ui-conversation`、`dsh-api-session-controller`、`dsh-client-ui-settings-general`、`dsh-client-ui-tool`、`dsh-api-remotes`、`dsh-client-ui-input-trigger`。
- `external`：**声明「基座之外我还需要这些精确模块请求」**。相关原文（`asar:378841`/`asar:715053` 语义）：

  > Module Loader 包（`factory(require)`）可隐式 require `@deepseek-ai/dsh-client-ui-primitives`，不要把它列为运行时依赖也不要打包副本；`cordis-client-runner` 闭包则什么都不能 import。动态 bundle 的 externals 只能解析到基座键或某个动态包 row；组合期拒绝畸形请求 / 缺失提供方 / 自请求 / 同步环。

  并且不允许自请求（`asar:380394`）：

  > `client-modules: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`

### 7.3 运行时依赖是打包还是宿主提供

**由宿主外部提供（外置），不打包。** 证据链：

1. `scripts/build-client.mjs` **没有任何 externals / bundler 配置**——它只是把 tsc 产出的 CJS 逐文件包进 `__modules` 表，并把相对 `require` 改写成 `__load_`。宿主包 import 原样保留为 `require(...)`。
2. 生成的运行时对未知 id 直接回落宿主模块表（`lib/client.js` 末尾）：

```js
function __load(id) {
  if (__modules[id] === undefined) return require(id);
  ...
}
```

3. 解析失败时的报错把这条契约说得很清楚（`asar:379788`）：

   > `client-modules: require("${spec}") missed the module table — not a platform seed word, not a materialized module, and no registered package factory (a build-time externals drift, or a dynamic dependency that did not arrive)`

4. 框架要求 React 等基础依赖走基座：`asar:633`

   > The browser artifact registers a lazy factory whose id equals the package name. React comes from the browser module table; no duplicate React installation, CDN script, or UMD search is needed. For compiled sources, use the deployment's Client build tooling to emit this format; declare non-baseline runtime imports in `dsh.client.external`.

**实践建议**：
- React 用 `require('react')` / `require('react/jsx-runtime')`（tsc 的 `jsx: react-jsx` 会自动产出后者）。
- 想 100% 安全：**不 import 任何 `@deepseek-ai/dsh-client-*` 运行时包**，自己复制需要的控件样式（只引用 `--dsw-alias-*` token），UI 通过 slot 的 props 与 `ctx` 服务获取数据。
- 想用基座里的 `@deepseek-ai/dsh-client-ui-primitives`（本插件的选择）：可行，但官方明确不背书（`asar:295011`/`621`），且组件抛错会让整个 slot 条目白屏（console: `slot entry crashed in '<slot>'`）。

### 7.4 官方建议的验证清单

`asar:497`（安装后的验收标准）：

> ... its `application` and `warnings` fields decide whether the change is live, not server logs... For a page or panel, also verify design consistency: styles use only theme tokens, the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`, the console shows no slot entry crash, and the view reads correctly in light and dark themes beside a comparable host page.

---

## 8. 踩坑点汇总

**清单/声明面**

1. `dsh.client` 声明了但缺 `exports["./client"]` → 组合期抛 `client-modules: <pkg> declares dsh.client but exports no "./client" bundle`。**浏览器入口路径只认 exports，不认 `dsh.client` 里的任何字段**。
2. `dsh.client.platform` 必须存在且为 string；`inject`/`external` 必须是 string[]；`immediately` 必须是 boolean —— 否则报 `client-modules: <pkg> dsh.client.platform must be a string` 等。
3. `dsh.bundle.patch` 只能写相对包目录的路径或路径数组，绝对值/其它类型报 `dsh.bundle.patch must be a file path or a list of file paths`。
4. 兼容性由 `peerDependencies` 的区间强校验（`getDshRuntimeVersion()`），**不是 `engines.dsh`、也不是 `dsh.compatibility`**；本机 dsh 代码里根本没有 `dsh.compatibility` 的消费者。
5. 缺 DSH peers 不构成约束；区间非法则直接判为不兼容。

**patch 与配置面**

6. 同 `id` 的补丁是**整体替换 config**，不是深合并 → 用户覆盖时必须重述所有要保留的字段（本机 `profiles\desktop\cordis.patch.yml:5-25` 就是这么写的）。
7. patch 指向不存在的行：只在 stderr 警告；**空文件或只有注释会 boot 失败**——要禁用该层用 `[]`。
8. 本插件 Config 里**几乎所有字段都带 `.volatile()`**：解析结果是 cosmokit handle 而非普通值，每个消费者必须用 `unwrapVolatile()` 解包（`src\config.ts:140-144`、`:230`、`:255`）。若 Config 没有任何 volatile 字段，`/_dsh/vision-toolkit/settings` 会回答 `'vision-toolkit Settings namespace is not registered'`。
9. Settings 命名空间合法性有断言：`SETTINGS_NAMESPACE_PATTERN.test(...)` 失败直接 `throw new TypeError`（`src\config.ts:37-40`）。
10. dsh 0.1.7 移除了 `settings.register()`（issue #677）；命名空间改为从插件自身 Config schema 派生，读用 `ctx.settings.describe()`、写用 `ctx.settings.update(ns, patch)`。旧调用抛出的 TypeError 会被 cordis 吞掉，表现为**整行插件静默不挂载**（`src\index.ts:63-67` 注释原文）。

**host 半侧面**

11. 可选服务不要塞进顶层 `inject`（否则该 profile 缺此服务时插件整体不激活），用 `ctx.inject(['webServer'], cb)`（`src\web.ts:596`）。
12. 事件类型增强要就近 `declare module '@deepseek-ai/cordis' { interface Events {…} }`（宿主事件可能来自非本包依赖的模块，如 `dsh-app-boot`）。
13. `apply` 失败时不要抛出，改为 `ctx.logger.error` + 保留可修复状态（`src\index.ts:196-208`），否则整行插件崩。
14. 所有 `register()` 返回 disposer，必须在返回的清理函数里逆序释放（`src\index.ts:267-276`）。
15. 日志用 printf 风格 `ctx.logger.warn('… %s …', args)`。

**client 半侧面**

16. 浏览器 bundle 只**注册 factory**，不立即执行；一切副作用（含 CSS 注入）必须在 `apply` 里用 `ctx.effect` 注册并返回清理。
17. `ctx.slots.inject(ownerKey, cb)` 的注册随所有者塌缩而释放、回来时重装；不要在组件外写 DOM 或往 `document.body` 追加节点。
18. 别用 iframe 承载宿主页面（拿不到 theme token、明暗切换、`ctx.locale`）；非要用宿主控件就复制其标记与样式，只保留 `--dsw-alias-*` token。
19. `dsh.client.inject` 里的名字**只是激活顺序**，写错不会报错，但写错的 `$on('credentials/updated')` 这类订阅名会静默变成死订阅（DSH 实际发 `credentials/reference-updated`）。
20. 一个抛错的组件会让整个 slot 条目白屏（console: `slot entry crashed in '<slot>'`），所以视图层要对 props 缺失做兜底（本插件给翻译函数默认值）。
21. `@deepseek-ai/dsh-client-ui-primitives` 虽在基座模块表里而可直接 require，但官方明确不背书；列为运行时依赖或打包副本同样错误。
22. 动态 bundle 的 externals 只能解析到基座键或某个动态包 row；自请求（把本包列进自己的 `dsh.client.external`）与同步环都会在组合期被拒。

**构建面**

23. 中间产物 `.client-build` 与 `lib` 必须先清（`scripts/clean-build.mjs`），且 `build-client.mjs` 必须在两次 tsc 之后运行，否则打不出 `lib/client.js`。
24. client 侧必须先编成 **CJS**（`module: commonjs`）才能被这个打包器封装；所以源码里对依赖包的 import 必须能解析到 `lib/types/client/index.d.ts` —— 靠 `tsconfig.client.json` 手写 `paths`（9 条）兜住 TS 6 对裸子路径解析的收紧。
25. `tsconfig.client.public.json` 是发布态校验（`noEmit` + 清空 `paths`），**不要指望它产出任何东西**。
26. host 侧源码用 `.ts` 后缀 import（`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`），改成无后缀会在 tsc 报错。
27. `lib/client.js.map` 是手写的 sectioned source map，靠「`__load_` 与 `require` 等宽」保持列对齐；改动打包脚本里的替换逻辑时要维持这个等宽约束，否则调试映射错位。

---

## 9. 最小骨架 Checklist（直接抄这里）

```
my-plugin/
├─ package.json
├─ cordis.patch.yml
├─ index.js            # host：export function apply() {}
└─ client.js           # browser：window.__ModuleLoader__.load({...})
```

`package.json`：

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-conversation"] }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
```

`index.js`：

```js
export function apply() {}
```

`client.js`：

```js
window.__ModuleLoader__.load({
  id: '@local/my-plugin',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function View() { return h('div', null, 'hello') }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
          { name: 'conversation.composer.dock', id: 'my-plugin', order: 5 }, View))
      },
    }
  },
})
```

安装：用 dsh 的 `plugin_manager`（`action: install_bundle`，`target` 指向该目录），**不要**手改 profile 的 `package.json` / `cordis.patch.yml`、也不要手工跑 `pnpm`（`asar:294874-294880`、`294969`）。装完用 `list_bundles` / `list_plugins` 确认行状态，再用页面实测外观与控制台。
