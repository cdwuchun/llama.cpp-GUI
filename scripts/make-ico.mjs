/**
 * 把若干 PNG 打包成 ICO（PNG 内嵌格式，Windows Vista+ 支持）。
 *
 * 用法：
 *   node scripts/make-ico.mjs <输出.ico> <输入1.png> <输入2.png> ...
 *
 * 尺寸从每个 PNG 的 IHDR 里读，不需要额外传参；256×256 在目录项里按规范写 0。
 */

import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const [outPath, ...pngPaths] = process.argv.slice(2);
if (!outPath || pngPaths.length === 0) {
  console.error("用法: node scripts/make-ico.mjs <输出.ico> <输入1.png> [输入2.png ...]");
  process.exit(1);
}

const pngs = pngPaths.map((path) => ({ path, data: readFileSync(path) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = 6 + pngs.length * 16;

for (const { path, data } of pngs) {
  if (data.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${path} 不是 PNG`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);

  const entry = Buffer.alloc(16);
  entry.writeUInt8(width >= 256 ? 0 : width, 0);
  entry.writeUInt8(height >= 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2); // 调色板数量（32 位真彩写 0）
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;

  entries.push(entry);
  console.log(`  + ${width}x${height}  ${path}`);
}

writeFileSync(outPath, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
console.log(`写出 ${outPath}（${pngs.length} 个尺寸，${(offset / 1024).toFixed(1)} KB）`);
