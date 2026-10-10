/**
 * 生成应用的全部图标资产：`src-tauri/icons/*.png`、`icon.ico`，以及
 * `src-tauri/src/tray_icon.rs`（托盘用的裸 RGBA 常量）。
 *
 * 为什么自己画而不走 SVG 渲染：
 * 1. 位图渲染链路（HTML/SVG → 截图）会带出基线间隙之类的偏差，实测把图形顶出了画布上半部，
 *    结果任务栏里看到的图标"上边被切了一块"；
 * 2. 图标需要**四周留白**（Windows 规范 ~8~12%），内容铺满画布会显得发满、发虚；
 * 3. 小尺寸下三层 + 细闪电必然糊成一片，所以 ≤40px 用**两层简化版**（与托盘同一套图形），
 *    大尺寸才用完整的三层版。
 *
 * PNG 由 Node 自带的 zlib 编码，不需要任何图形库；ICO 直接内嵌这些 PNG。
 *
 * 用法：node scripts/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const ICON_DIR = "src-tauri/icons";
const TRAY_RS = "src-tauri/src/tray_icon.rs";

const SIZE = 64; // 设计稿坐标
const SS = 4; // 每个像素的超采样倍数
const PAD = 0.08; // 四周留白比例（内容占 84%）
const INNER = 1 - PAD * 2;

const INDIGO = { r: 0x4f, g: 0x46, b: 0xe5 };
const WHITE = { r: 255, g: 255, b: 255 };
const BOLT = { r: 0xe0, g: 0xe7, b: 0xff };

/** 三层版：小尺寸下会糊，只用于 ≥48px */
const LIGHTNING_FULL = [
  [49, 17],
  [39, 33],
  [46, 33],
  [44, 47],
  [54, 30],
  [47, 30],
];

/** 两层版的闪电：更粗更短，24px 下仍成形 */
const LIGHTNING_SMALL = [
  [52, 12],
  [37, 35],
  [46, 35],
  [42, 53],
  [57, 29],
  [48, 29],
];

function inRoundedRect(x, y, rx, ry, w, h, r) {
  const dx = Math.max(rx + r - x, 0, x - (rx + w - r));
  const dy = Math.max(ry + r - y, 0, y - (ry + h - r));
  return dx * dx + dy * dy <= r * r;
}

function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function over(base, top, alpha) {
  return {
    r: top.r * alpha + base.r * (1 - alpha),
    g: top.g * alpha + base.g * (1 - alpha),
    b: top.b * alpha + base.b * (1 - alpha),
  };
}

/** 在设计稿坐标上取色；`small` 为真时用两层简化图形 */
function sampleDesign(x, y, small) {
  if (!inRoundedRect(x, y, 0, 0, SIZE, SIZE, 15)) return null;
  let color = { ...INDIGO };
  if (small) {
    if (inRoundedRect(x, y, 11, 18, 30, 12, 6)) color = over(color, WHITE, 1);
    if (inRoundedRect(x, y, 11, 35, 30, 12, 6)) color = over(color, WHITE, 0.82);
    if (inPolygon(x, y, LIGHTNING_SMALL)) color = over(color, BOLT, 1);
  } else {
    if (inRoundedRect(x, y, 13, 41, 30, 9, 4.5)) color = over(color, WHITE, 0.55);
    if (inRoundedRect(x, y, 13, 30, 30, 9, 4.5)) color = over(color, WHITE, 0.8);
    if (inRoundedRect(x, y, 13, 19, 30, 9, 4.5)) color = over(color, WHITE, 1);
    if (inPolygon(x, y, LIGHTNING_FULL)) color = over(color, BOLT, 1);
  }
  return color;
}

/** 渲染一个尺寸，返回 RGBA（非预乘） */
function render(size, small) {
  const rgba = Buffer.alloc(size * size * 4);
  let opaque = 0;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          // 画布坐标 → 去掉留白后的设计稿坐标
          const cx = ((px + (sx + 0.5) / SS) / size) * SIZE;
          const cy = ((py + (sy + 0.5) / SS) / size) * SIZE;
          const x = (cx - SIZE * PAD) / INNER;
          const y = (cy - SIZE * PAD) / INNER;
          const color = sampleDesign(x, y, small);
          if (!color) continue;
          rSum += color.r;
          gSum += color.g;
          bSum += color.b;
          covered += 1;
        }
      }
      const i = (py * size + px) * 4;
      const total = SS * SS;
      rgba[i] = covered ? Math.round(rSum / covered) : 0;
      rgba[i + 1] = covered ? Math.round(gSum / covered) : 0;
      rgba[i + 2] = covered ? Math.round(bSum / covered) : 0;
      rgba[i + 3] = Math.round((covered / total) * 255);
      if (covered === total) opaque += 1;
    }
  }
  return { rgba, opaque };
}

// ---- 最小 PNG 编码器（RGBA8，无依赖） ----

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // 10..12 = compression/filter/interlace = 0

  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO（内嵌 PNG） ----

function encodeICO(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

// ---- 出图 ----

mkdirSync(ICON_DIR, { recursive: true });

// ≤64px 用两层简化版，≥72px 用完整三层版。
//
// 分界为什么定在 64：`tauri-codegen` 的 `new_ico` 固定取 ICO 的**第一个条目**作为
// 窗口图标（Windows 目标下 `default_window_icon` 只认 .ico，配置里的 PNG 会被忽略），
// 而窗口图标会被 Windows 缩放到任务栏/标题栏实际需要的物理像素（150% DPI 下是 36/24px）。
// 所以首项必须是「足够大的、且缩下去还看得清的」图形 —— 64px 两层版正合适：
// 图形简单，缩到 36px 依然干净；三层版缩下去细闪电会糊。
// 用户要求「所有地方用同一个图标」，所以这里放宽到覆盖全部尺寸 —— 一律用两层简化版。
// 三层版的几何（LIGHTNING_FULL 与 sampleDesign 里的三分支）保留着，日后若想在大尺寸上
// 换回更细的三层图形，把这里改回 64 即可。
const SMALL_MAX = 512;
// 第一个是给窗口图标用的（顺序有语义），其余是 exe 图标资源各 DPI 的备用尺寸
const ICO_SIZES = [64, 16, 20, 24, 32, 36, 40, 48, 72, 128, 256];
const pngs = ICO_SIZES.map((size) => {
  const small = size <= SMALL_MAX;
  const { rgba, opaque } = render(size, small);
  const data = encodePNG(size, rgba);
  console.log(
    `  ${String(size).padStart(3)}px  ${small ? "两层" : "三层"}  ${(data.length / 1024).toFixed(1)} KB  实心像素 ${opaque}/${size * size}`,
  );
  return { size, data };
});

// 单独存几个尺寸给 tauri.conf.json / 侧栏 logo 用
const pngOf = (size) => pngs.find((p) => p.size === size).data;
writeFileSync(`${ICON_DIR}/32x32.png`, pngOf(32));
writeFileSync(`${ICON_DIR}/128x128.png`, pngOf(128));
writeFileSync(`${ICON_DIR}/256x256.png`, pngOf(256));
// 非 Windows 平台用的窗口图标（Windows 走 ICO 首项）；与 ICO 首项保持一致
const windowIcon = render(64, true);
writeFileSync(`${ICON_DIR}/window-icon.png`, encodePNG(64, windowIcon.rgba));
// 侧栏 logo：和 exe/标题栏同一个图形，一并生成，省得手工复制
writeFileSync("src/assets/icons/app-logo.png", encodePNG(128, render(128, true).rgba));
writeFileSync(`${ICON_DIR}/512x512.png`, encodePNG(512, render(512, false).rgba));
writeFileSync(`${ICON_DIR}/icon.ico`, encodeICO(pngs));
console.log(`icon.ico 已写出（${ICO_SIZES.length} 个尺寸）`);

// 托盘常量：32px 两层版，直接给 RGBA，运行时不用解码 PNG
const tray = render(32, true);
const rows = [];
for (let i = 0; i < tray.rgba.length; i += 32 * 4) {
  rows.push("    " + Array.from(tray.rgba.subarray(i, i + 32 * 4)).join(", ") + ",");
}
writeFileSync(
  TRAY_RS,
  `//! 托盘专用图标：原始 RGBA 数据（32×32），由 \`scripts/make-icons.mjs\` 生成，勿手改。
//!
//! 为什么要单独一份：托盘图标显示尺寸只有 16~24px，完整的三层版在这个尺寸下必然糊成一片，
//! 所以托盘用的是**两层简化版**（间隙更大、闪电更粗）。
//!
//! 用裸 RGBA 常量而不是 \`include_bytes!\` + 运行时解码，是为了不给 tauri 加 \`image-png\` 依赖。

/// 托盘图标边长（像素）
pub const TRAY_ICON_SIZE: u32 = 32;

/// RGBA8（非预乘），行优先
pub const TRAY_ICON_RGBA: [u8; ${32 * 32 * 4}] = [
${rows.join("\n")}
];
`,
);
console.log("托盘 RGBA 常量已写出");
