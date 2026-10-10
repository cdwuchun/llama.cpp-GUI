/**
 * 参数表单的渲染冒烟测试。
 *
 * 背景：曾出现 `<option>{v}</option>` 渲染对象（hub 的 values 有的是 `{value,label}`）
 * 导致整棵 React 树卸载、窗口白屏。这里用真实 React 渲染 ParamForm，
 * 覆盖「空状态」与「含取值域参数」两条路径，确保不会再抛错。
 *
 * 用法（需要 esbuild 打包，故在受限沙箱中要提权）：
 *   node scripts/smoke-paramform.mjs
 *
 * 两处与"直觉写法"不同的地方，都是踩过的坑：
 * 1) 打包走 esbuild 的 JS API，而不是执行 `node_modules/.bin/esbuild.cmd` ——
 *    Node 20.12.2 / 22 起（CVE-2024-27980 的修复）不允许 execFile 直接跑 .cmd/.bat，
 *    会抛 `spawnSync … esbuild.cmd EINVAL`；CI（node 22）的冒烟步骤就死在这一句上
 *    （本机受限沙箱里先撞到 spawn EPERM，把真正的原因盖住了）。
 * 2) 打包产物在**本进程内** import，而不是起子进程 —— 因为要先在本进程补上 localStorage：
 *    产物会连带拉进 `src/store.ts`（ParamForm 依赖它），而它在模块加载时就调 localStorage
 *    做主题初始化，Node 下没有它就直接崩。抛错一样会让本进程非零退出，测试语义不变。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = process.cwd();
const entry = path.join(root, "scripts", "smoke-paramform.entry.tsx");
const out = path.join(root, "tmp", "smoke-paramform.mjs");

fs.mkdirSync(path.dirname(out), { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  jsx: "automatic",
  outfile: out,
  logLevel: "warning",
});

/** 够用的 localStorage 替身：`src/store.ts` 的 initialTheme() 只读一个键。 */
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: (key) => void memory.delete(key),
  clear: () => memory.clear(),
  key: (index) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
};

await import(pathToFileURL(out).href);
