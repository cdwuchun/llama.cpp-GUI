/**
 * 速度 / 首字时间 / 内存需求的估算表 —— 照搬上游 strata-manager 的
 * `packages/core/src/model-performance.ts`（含全部实测数字与出处注释）。
 *
 * 每个数字都来自 Strata 文档公布的实测（下面的 `PERFORMANCE_SOURCES` 指向固定 commit），
 * 不是本仓库估出来的：界面必须标「估算」，并写明参考机型。
 *
 * - 规则与上游一致：Mac（Metal）看统一内存是否够驻留，不够就专家权重走 SSD（变慢但不失败）；
 *   PC 看 `MODELS.md` 的 RTX 5070 12 GB / RX 9070 XT 16 GB / R9700 32 GB / RTX 3060 12 GB 实测，
 *   「RAM ≥ experts + 10 GB」才给速度，否则落到低内存模式（没有公布数字）。
 * - 显存比参考机型少 → 数字是上限（≤），多 → 是下限（≥）。
 * - 首字时间 = 4096 token 的提示 / 实测提示速率。
 * - 社区的 GSQ-RCO 文件与官方张量布局相同，沿用同家族的实测数字。
 */

export const PERFORMANCE_DOCS_REVISION = "9de04cd44e927a9a3df6bbc0e94fc1be8b844ba4";

const doc = (file: string, anchor = ""): string =>
  `https://github.com/Niko1221/Strata/blob/${PERFORMANCE_DOCS_REVISION}/docs/${file}${anchor}`;

/** 每个数字的出处（面板「查看分项与依据」直接给链接） */
export const PERFORMANCE_SOURCES = {
  macM5Max: doc("MAC.md", "#measured-m5-max-128-gb-macos-272"),
  macStream: doc("MAC.md", "#m4-mac-mini-32-gb-experts-streamed-from-the-ssd"),
  macMemory: doc("MAC.md", "#what-you-need"),
  pcRtx5070: doc("MODELS.md", "#which-model-sizes-versions-and-what-fits"),
  pcFit: doc("MODELS.md", "#will-it-fit"),
  pcR9700: doc("MODELS.md", "#unsloths-files-ud-iq4_xs-to-q8_0"),
  qwen36: doc("MODELS.md", "#qwen36-35b-a3b"),
} as const;

export type PerformanceBasis =
  | "macM5Max"
  | "macStream"
  | "macStreamExtrapolated"
  | "pcRtx5070"
  | "pcRx9070xt"
  | "pcR9700"
  | "pcRtx3060"
  | "none";

export type PerformanceMode =
  | "macResident"
  | "macStreaming"
  | "macUnsupported"
  | "gpu"
  | "lowRam"
  | "tooSmall"
  | "unknown";

export interface Range {
  low: number;
  high: number;
}

/** 本机信息（`StrataHostInfo` 转换而来；字段都可空，取不到就按「未实测」处理） */
export interface PerformanceHardware {
  platform: "windows" | "macos" | "linux";
  memoryGB?: number | null;
  vramGB?: number | null;
  gpuVendor?: "nvidia" | "amd" | "other";
}

export interface PerformanceEstimate {
  mode: PerformanceMode;
  /** 生成速度（tok/s） */
  decode?: Range;
  /** 4096 token 提示后的首字时间（秒） */
  ttft4k?: Range;
  /** upper = 本机大概比参考机慢（显存/带宽更少）；lower = 更快 */
  bound?: "upper" | "lower";
  /** 需要的内存：Mac 是统一内存（驻留），PC 是系统内存（experts + 10 GB） */
  memoryGB?: number;
  /** Mac：从多少统一内存起能驻留 */
  residentFromGB?: number;
  /** 参考机型的显存（PC） */
  referenceVramGB?: number;
  basis: PerformanceBasis;
  extrapolated: boolean;
  source?: string;
}

const r = (low: number, high: number): Range => ({ low, high });

const ttft = (lowRate: number, highRate: number): Range => ({
  low: Math.round((4096 / highRate) * 10) / 10,
  high: Math.round((4096 / lowRate) * 10) / 10,
});

/** MAC.md「What you need」（needs / recommended from）；IQ2_XS 按 Q2_0 +8.4 GB 外推 */
const MAC_MEMORY: Record<string, { needs: number; residentFrom: number; extrapolated?: boolean }> = {
  Q2_0: { needs: 46, residentFrom: 64 },
  IQ2_XS: { needs: 48, residentFrom: 66, extrapolated: true },
  IQ3_XXS: { needs: 55, residentFrom: 74 },
  IQ3_S: { needs: 63, residentFrom: 96 },
  "UD-Q4_K_XL": { needs: 91, residentFrom: 128 },
};

/** MAC.md M5 Max 128 GB：decode（MTP，prompt1 / story）与 4K 提示速率 */
const MAC_RESIDENT: Record<string, { decode: Range; prompt: number }> = {
  Q2_0: { decode: r(108.2, 119.5), prompt: 1430 },
  IQ3_XXS: { decode: r(97.0, 108.9), prompt: 1260 },
  IQ3_S: { decode: r(94.1, 98.2), prompt: 1320 },
  "UD-Q4_K_XL": { decode: r(73.7, 94.0), prompt: 1150 },
};

/** MAC.md 流式：M1 Max 34 GB（7.9 tok/s，186 tok/s 提示）与 M4 32 GB 的表 */
const MAC_STREAM: Record<string, { decode: Range; prompt: Range; extrapolated?: boolean }> = {
  Q2_0: { decode: r(7.9, 14.1), prompt: r(80, 186) },
  IQ3_XXS: { decode: r(7.7, 10.0), prompt: r(62.5, 89) },
  IQ3_S: { decode: r(6.6, 8.6), prompt: r(54, 77), extrapolated: true },
};

/** MODELS.md「Will it fit?」：各尺寸的专家权重（GB）；内存需求 = experts + 10 */
const PC_RAM: Record<string, Record<string, number>> = {
  qwen: { Q2_0: 44, IQ2_XS: 45.5, IQ3_XXS: 53, IQ3_S: 60 },
  swift: { IQ2_XS: 45.5, IQ3_XXS: 53, IQ3_S: 60 },
  coder: { IQ1_M: 33 },
  unsloth: { "UD-IQ4_XS": 72, "UD-Q4_K_XL": 88, "UD-Q5_K_XL": 108, "UD-Q6_K_XL": 118, Q8_0: 136 },
  qwen36: { "UD-Q4_K_XL": 32, "UD-Q6_K_XL": 44, Q8_0: 52 },
};

interface PcRef {
  basis: PerformanceBasis;
  vram: number;
  decode: Range;
  prompt: Range;
}

/** MODELS.md RTX 5070 12 GB + 64 GB（短对话 / 128K 上下文；4K 提示 910–1580 tok/s） */
const RTX5070: Record<string, PcRef> = {
  Q2_0: { basis: "pcRtx5070", vram: 12, decode: r(76, 94), prompt: r(910, 1580) },
  IQ2_XS: { basis: "pcRtx5070", vram: 12, decode: r(63, 79), prompt: r(910, 1580) },
  IQ3_XXS: { basis: "pcRtx5070", vram: 12, decode: r(49, 62), prompt: r(910, 1580) },
  IQ3_S: { basis: "pcRtx5070", vram: 12, decode: r(46, 53), prompt: r(910, 1580) },
  IQ1_M: { basis: "pcRtx5070", vram: 12, decode: r(43, 55), prompt: r(910, 1580) },
};

/** MODELS.md RX 9070 XT 16 GB + 47 GB（32K 提示速率） */
const RX9070XT: Record<string, PcRef> = {
  Q2_0: { basis: "pcRx9070xt", vram: 16, decode: r(48, 60), prompt: r(1160, 1160) },
  IQ2_XS: { basis: "pcRx9070xt", vram: 16, decode: r(36, 52), prompt: r(1110, 1110) },
  IQ1_M: { basis: "pcRx9070xt", vram: 16, decode: r(33, 44), prompt: r(1420, 1420) },
};

/** MODELS.md Unsloth 表，AMD R9700 32 GB（story / code，32K 提示） */
const R9700: Record<string, PcRef> = {
  IQ3_S: { basis: "pcR9700", vram: 32, decode: r(75, 95), prompt: r(1110, 1320) },
  "UD-Q4_K_XL": { basis: "pcR9700", vram: 32, decode: r(63, 87), prompt: r(1110, 1320) },
  "UD-Q5_K_XL": { basis: "pcR9700", vram: 32, decode: r(57, 82), prompt: r(810, 1260) },
  "UD-Q6_K_XL": { basis: "pcR9700", vram: 32, decode: r(54, 76), prompt: r(1020, 1020) },
  Q8_0: { basis: "pcR9700", vram: 32, decode: r(53, 74), prompt: r(1230, 1300) },
};

/** MODELS.md / QWEN36.md：Qwen3.6 UD-Q4_K_XL 在 R9700 117.8（pp4096 6223）、RTX 3060 59.7（pp2048 2022） */
const QWEN36: Record<"amd" | "nvidia", PcRef> = {
  amd: { basis: "pcR9700", vram: 32, decode: r(117.8, 117.8), prompt: r(6223, 6223) },
  nvidia: { basis: "pcRtx3060", vram: 12, decode: r(59.7, 59.7), prompt: r(2022, 2022) },
};

function pcReference(
  family: string,
  quant: string,
  vendor: PerformanceHardware["gpuVendor"],
  vram: number | undefined,
): PcRef | undefined {
  if (family === "qwen36") {
    return quant === "UD-Q4_K_XL" ? QWEN36[vendor === "amd" ? "amd" : "nvidia"] : undefined;
  }
  if (family === "unsloth") return R9700[quant];
  if (family === "qwen" || family === "swift" || family === "coder") {
    if (vendor === "amd") {
      return (vram ?? 0) >= 24 && R9700[quant] ? R9700[quant] : (RX9070XT[quant] ?? RTX5070[quant]);
    }
    return RTX5070[quant];
  }
  return undefined;
}

/** 一个家族 + 量化的估算（社区条目传它所属的安装家族）。 */
export function estimatePerformance(
  family: string,
  quant: string,
  hardware: PerformanceHardware,
): PerformanceEstimate {
  if (hardware.platform === "macos") {
    if (family !== "qwen" && family !== "unsloth") {
      return { mode: "macUnsupported", basis: "none", extrapolated: false };
    }
    const memory = MAC_MEMORY[quant];
    if (!memory) return { mode: "unknown", basis: "none", extrapolated: false };
    const base = { memoryGB: memory.needs, residentFromGB: memory.residentFrom };
    const total = hardware.memoryGB ?? undefined;
    if (total !== undefined && total < 16) {
      return { mode: "tooSmall", ...base, basis: "none", extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macMemory };
    }
    if (total === undefined || total >= memory.residentFrom) {
      const resident = MAC_RESIDENT[quant];
      if (!resident) {
        return { mode: "macResident", ...base, basis: "none", extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macMemory };
      }
      return {
        mode: "macResident",
        ...base,
        decode: resident.decode,
        ttft4k: ttft(resident.prompt, resident.prompt),
        bound: total !== undefined && total < 128 ? "upper" : undefined,
        basis: "macM5Max",
        extrapolated: !!memory.extrapolated,
        source: PERFORMANCE_SOURCES.macM5Max,
      };
    }
    const stream = MAC_STREAM[quant];
    if (!stream) {
      return { mode: "macStreaming", ...base, basis: "none", extrapolated: !!memory.extrapolated, source: PERFORMANCE_SOURCES.macMemory };
    }
    return {
      mode: "macStreaming",
      ...base,
      decode: stream.decode,
      ttft4k: ttft(stream.prompt.low, stream.prompt.high),
      basis: stream.extrapolated ? "macStreamExtrapolated" : "macStream",
      extrapolated: !!stream.extrapolated || !!memory.extrapolated,
      source: PERFORMANCE_SOURCES.macStream,
    };
  }

  const ram = PC_RAM[family]?.[quant];
  if (ram === undefined) return { mode: "unknown", basis: "none", extrapolated: false };
  if (hardware.memoryGB !== undefined && hardware.memoryGB !== null && hardware.memoryGB < ram) {
    return { mode: "lowRam", memoryGB: ram, basis: "none", extrapolated: false, source: PERFORMANCE_SOURCES.pcFit };
  }
  const ref = pcReference(family, quant, hardware.gpuVendor, hardware.vramGB ?? undefined);
  if (!ref) {
    return { mode: "gpu", memoryGB: ram, basis: "none", extrapolated: false, source: PERFORMANCE_SOURCES.pcFit };
  }
  const vram = hardware.vramGB ?? undefined;
  const bound =
    vram === undefined ? undefined : vram < ref.vram - 1 ? "upper" : vram > ref.vram + 1 ? "lower" : undefined;
  const source =
    ref.basis === "pcR9700"
      ? family === "qwen36"
        ? PERFORMANCE_SOURCES.qwen36
        : PERFORMANCE_SOURCES.pcR9700
      : ref.basis === "pcRtx3060"
        ? PERFORMANCE_SOURCES.qwen36
        : PERFORMANCE_SOURCES.pcRtx5070;
  return {
    mode: "gpu",
    memoryGB: ram,
    decode: ref.decode,
    ttft4k: ttft(ref.prompt.low, ref.prompt.high),
    bound,
    referenceVramGB: ref.vram,
    basis: ref.basis,
    extrapolated: false,
    source,
  };
}

/** 「≈ 8–14」/「≤ 120」/「≥ 60」（取整，不装精确） */
export function formatRange(
  range: Range | undefined,
  bound?: "upper" | "lower",
  digits = 0,
): string | undefined {
  if (!range) return undefined;
  const fmt = (value: number): string =>
    value >= 10 || digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
  if (bound === "upper") return `≤ ${fmt(range.high)}`;
  if (bound === "lower") return `≥ ${fmt(range.low)}`;
  return fmt(range.low) === fmt(range.high) ? `≈ ${fmt(range.low)}` : `${fmt(range.low)}–${fmt(range.high)}`;
}

/** 参考机型的说明（表下脚注与「依据」那一行）。 */
export function basisLabel(basis: PerformanceBasis): string {
  switch (basis) {
    case "pcRtx5070":
      return "RTX 5070 12 GB + 64 GB 内存实测（MODELS.md，短对话 / 128K 上下文）";
    case "pcRx9070xt":
      return "RX 9070 XT 16 GB + 47 GB 内存实测（MODELS.md，32K 提示）";
    case "pcR9700":
      return "AMD R9700 32 GB 实测（MODELS.md，32K 提示）";
    case "pcRtx3060":
      return "RTX 3060 12 GB 实测（QWEN36.md，pp2048）";
    case "macM5Max":
      return "M5 Max 128 GB 驻留实测（MAC.md）";
    case "macStream":
      return "M1 Max 34 GB / M4 32 GB 专家流式实测（MAC.md）";
    case "macStreamExtrapolated":
      return "M4 32 GB 专家流式实测外推（MAC.md）";
    default:
      return "没有对应的实测机型";
  }
}

/** 估算用的本机画像：把 `StrataHostInfo` 翻成上游 `PerformanceHardware`。 */
export function hardwareOf(host: {
  platform: string;
  memoryGb: number | null;
  vramGb: number | null;
  gpus: string[];
} | null): PerformanceHardware {
  const platform: PerformanceHardware["platform"] =
    host?.platform === "macos" ? "macos" : host?.platform === "linux" ? "linux" : "windows";
  return {
    platform,
    memoryGB: host?.memoryGb ?? undefined,
    vramGB: host?.vramGb ?? undefined,
    gpuVendor: vendorOf(host?.gpus ?? []),
  };
}

/** 显卡厂商：与上游 `catalogHardware` 的正则一致（AMD 排在前面，RX/Radeon 先命中） */
export function vendorOf(gpus: readonly string[] | null | undefined): "nvidia" | "amd" | "other" {
  const text = (gpus ?? []).join(" ");
  if (/radeon|amd|\brx\s?\d/i.test(text)) return "amd";
  if (/nvidia|geforce|rtx|quadro|tesla/i.test(text)) return "nvidia";
  return "other";
}
