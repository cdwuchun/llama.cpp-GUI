/**
 * 性能测试页的纯逻辑：格式化、统计口径、导出、命令拼装。
 *
 * 全部照搬 hub 新版 `js/newui/benchmark.js` 的对应实现（含阈值与格式），
 * 只是换成 TypeScript 的写法。
 */

import type { BenchRecord, BenchRow, BenchStats } from "../types";

/** 数字格式：≥1000 取整，否则保留 1 位小数并去掉多余的 .0 */
export function fmtNum(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n >= 1000 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "");
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** `YYYYMMDD_HHMMSS` → `YYYY-MM-DD HH:MM`，其它输入按日期解析 */
export function fmtTs(value: string | number): string {
  const text = String(value ?? "");
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const d = new Date(typeof value === "number" ? value : text);
  if (Number.isNaN(d.getTime())) return text || "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

/** 时间戳 → 用于文件名/记录的 `YYYYMMDD_HHMMSS` */
export function stamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes(),
  )}${pad(d.getSeconds())}`;
}

/** 速度分档：预填充 >200/>100，生成 >50/>20 */
export function speedClass(kind: "prefill" | "decode", value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (kind === "prefill") return value > 200 ? "sp-fast" : value > 100 ? "sp-mid" : "sp-slow";
  return value > 50 ? "sp-fast" : value > 20 ? "sp-mid" : "sp-slow";
}

export function isStats(row: BenchRow): row is BenchStats {
  return (row as BenchStats).isStats === true;
}

/** nearest-rank 分位数（与 hub 相同：`s[ceil(p/100*len)-1]`） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function describe(values: number[]) {
  const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return { avg: 0, min: 0, max: 0, p50: 0, p95: 0 };
  const sum = s.reduce((acc, v) => acc + v, 0);
  return {
    avg: sum / s.length,
    min: s[0],
    max: s[s.length - 1],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
  };
}

/** 并发压测的统计行 */
export function computeStats(rows: BenchRecord[]): BenchStats {
  const ok = rows.filter((r) => !r.error);
  return {
    isStats: true,
    count: ok.length,
    timestamp: new Date().toISOString(),
    prefill: describe(ok.map((r) => r.prompt_per_second)),
    decode: describe(ok.map((r) => r.predicted_per_second)),
    promptN: { avg: describe(ok.map((r) => r.prompt_tokens)).avg },
    predictedN: { avg: describe(ok.map((r) => r.predicted_tokens)).avg },
    draftN: { avg: describe(ok.map((r) => r.draft_accept ?? 0)).avg },
    draftAccepted: { avg: describe(ok.map((r) => r.draft_accept ?? 0)).avg },
  };
}

/** 统计行的中间两格文案（hub 原文案格式） */
export function statsCell(o: { avg: number; min: number; p50: number; p95: number; max: number }): string {
  const f = (v: number) => v.toFixed(1);
  return `${f(o.avg)}（min ${f(o.min)} · P50 ${f(o.p50)} · P95 ${f(o.p95)} · max ${f(o.max)}）`;
}

/** 投机解码列的显示值（没有 draft 统计就是空） */
export function draftText(r: BenchRecord): string {
  if (r.draft_accept == null) return "";
  return `接受率 ${(r.draft_accept * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

interface ExportRow {
  mode: string;
  timestamp: string;
  modelId: string;
  promptTokens: number;
  maxTokens: number;
  prefillSpeed: number;
  decodeSpeed: number;
  draftTokens: number;
  draftAccepted: number;
  cpu: string;
  ram: string;
  devices: string;
  cmd: string;
  llamaBinPath: string;
}

export function toExportRows(
  rows: BenchRecord[],
  hw: { cpu: string; ram_gb: number | null },
  devices: string[],
  cmd = "",
  llamaBinPath = "",
): ExportRow[] {
  const ok = rows.filter((r) => !r.error);
  return ok.map((r) => ({
    mode: "server",
    timestamp: stamp(r.ts_ms),
    modelId: r.model,
    promptTokens: r.prompt_tokens,
    maxTokens: r.predicted_tokens,
    prefillSpeed: Number(r.prompt_per_second.toFixed(2)),
    decodeSpeed: Number(r.predicted_per_second.toFixed(2)),
    draftTokens: r.draft_accept == null ? 0 : 1,
    draftAccepted: r.draft_accept ?? 0,
    cpu: hw.cpu,
    ram: hw.ram_gb == null ? "" : `${hw.ram_gb}GB`,
    devices: devices.join(" | "),
    cmd,
    llamaBinPath,
  }));
}

function csvCell(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}

export function toCsv(rows: ExportRow[]): string {
  const header = [
    "时间",
    "模型",
    "提示词长度",
    "预填充速度(token/s)",
    "输出长度",
    "输出速度(token/s)",
    "CPU/RAM",
    "GPU",
    "CMD",
    "路径",
  ];
  const lines = rows.map((r) =>
    [
      r.timestamp,
      r.modelId,
      r.promptTokens,
      r.prefillSpeed,
      r.maxTokens,
      r.decodeSpeed,
      `${r.cpu}${r.ram ? ` / ${r.ram}` : ""}`,
      r.devices,
      r.cmd,
      r.llamaBinPath,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.map(csvCell).join(","), ...lines].join("\n");
}

export function toJson(rows: ExportRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function toMarkdown(rows: ExportRow[]): string {
  const head =
    "# Benchmark 测试结果\n\n| 时间 | 模型 | 提示词长度 | 预填充速度 | 输出长度 | 输出速度 |\n" +
    "|------|------|-----------|-----------|---------|---------|\n";
  return (
    head +
    rows
      .map(
        (r) =>
          `| ${r.timestamp} | ${r.modelId} | ${r.promptTokens} | ${r.prefillSpeed} | ${r.maxTokens} | ${r.decodeSpeed} |`,
      )
      .join("\n")
  );
}
