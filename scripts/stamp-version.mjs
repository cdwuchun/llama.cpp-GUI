#!/usr/bin/env node
/**
 * 手动改版本号用的小工具（**不自动跑**：版本号只在明确要求时才改）。
 *
 * 用日历版本（CalVer）`YYYY.MMDD.HHMM`，例如 `2026.1026.1632`：
 *
 * - 仍是合法 semver（三段数字），Tauri 的配置校验与 Windows 的文件版本资源都吃得下
 *   （每段都在 0..65535 内：2026 / 1026 / 1632）；
 * - 安装包文件名、exe 属性、界面「关于」、MCP 的 clientInfo 一眼能看出是哪次打包。
 *
 * 三处必须同步，否则界面显示（tauri.conf.json）、npm 元数据（package.json）、
 * MCP 的 `env!("CARGO_PKG_VERSION")`（Cargo.toml）会各说各话。
 *
 * 用法（要改才跑）：
 *   npm run stamp:version                 # 写进三处
 *   node scripts/stamp-version.mjs --dry  # 只打印，不改文件
 *
 * 刻意**没有**接进 `npm run tauri build` / `beforeBuildCommand`：
 * 打包不再自动改版本号，避免每次构建都把源码树弄脏。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry");

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const version = `${now.getFullYear()}.${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;

/**
 * 只替换第一处匹配，并把前缀/后缀原样拼回去 —— 直接用 `replace(pattern, version)`
 * 会把 `"version": "` 前缀一起吃掉，文件就坏了。
 *
 * pattern 必须带三组：前缀 / 旧版本 / 后缀。
 */
function stamp(relPath, pattern, label) {
  const abs = path.join(repoRoot, relPath);
  const before = fs.readFileSync(abs, "utf8");
  const m = before.match(pattern);
  if (!m) {
    console.log(`[version] ${label} 里没找到版本字段，跳过`);
    return;
  }
  const prev = m[2];
  if (prev === version) {
    console.log(`[version] ${label} 已是 ${version}，未改动`);
    return;
  }
  const after = before.replace(pattern, (_all, head, _old, tail) => `${head}${version}${tail}`);
  console.log(`[version] ${label} ${prev} → ${version}`);
  if (!dry) fs.writeFileSync(abs, after, "utf8");
}

stamp("package.json", /("version":\s*")([^"]+)(")/, "package.json");
stamp("src-tauri/tauri.conf.json", /("version":\s*")([^"]+)(")/, "src-tauri/tauri.conf.json");
// Cargo.toml 里 [package] 段的 version：锚定行首，不会碰到依赖里的 `version = "2"`
stamp("src-tauri/Cargo.toml", /^(version = ")([^"]+)(")/m, "src-tauri/Cargo.toml");

if (dry) console.log("[version] --dry：没有写盘");
