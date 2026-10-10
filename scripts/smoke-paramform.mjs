/**
 * 参数表单的渲染冒烟测试。
 *
 * 背景：曾出现 `<option>{v}</option>` 渲染对象（hub 的 values 有的是 `{value,label}`）
 * 导致整棵 React 树卸载、窗口白屏。这里用真实 React 渲染 ParamForm，
 * 覆盖「空状态」与「含取值域参数」两条路径，确保不会再抛错。
 *
 * 用法（需要 esbuild 打包，故在受限沙箱中要提权）：
 *   node scripts/smoke-paramform.mjs
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const entry = path.join(root, "scripts", "smoke-paramform.entry.tsx");
const out = path.join(root, "tmp", "smoke-paramform.mjs");

fs.mkdirSync(path.dirname(out), { recursive: true });

const esbuild = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");

execFileSync(
  esbuild,
  [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--packages=external",
    "--jsx=automatic",
    `--outfile=${out}`,
    "--log-level=warning",
  ],
  { stdio: "inherit" },
);

execFileSync(process.execPath, [out], { stdio: "inherit" });
