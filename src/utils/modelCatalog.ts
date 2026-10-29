/**
 * 官方安装器目录的静态快照（照搬上游 strata-manager `packages/core/src/catalog.ts`）。
 *
 * 数据来自 Strata 官方 `setup.py` 的 `MODELS` / `FAMILIES` / `OWN_PATH_FAMILIES`
 * （上游核对于 Niko1221/Strata v0.1.45，DeepSeek 一路核对于 v0.2.6）。安装器本身会
 * 随版本变化，所以这里只做「界面上的选择与门禁」，实际能装什么以所选控制端为准 ——
 * 页脚那句「目录来自官方安装器快照」就是这意思。
 *
 * 这里是工具模块，不导出组件（铁律 7）。
 */

export const UPSTREAM_REVISION = "477ac13cbe8e582c20484871ce459d20d82df09d";

export type CatalogFamily =
  | "qwen"
  | "swift"
  | "coder"
  | "unsloth"
  | "qwen36"
  | "gyro"
  | "nvfp4"
  | "deepseek41";

export interface CatalogQuantInfo {
  /** 官方给的下载量 GB（10^9 字节） */
  downloadGB: number;
  /**
   * 官网 `docs/MODELS.md`「Pick by memory」给的参考占用 GB：**模型权重占的 RAM + VRAM**。
   *
   * 用户 m01417：参考值本来就该按「显存 + 内存」读，所以界面上显示的是它。
   * 与 `ramGB`（安装器 `setup.py` 的 `ram_gb`，装得下所需的内存门槛，含系统余量）口径不同 ——
   * qwen Q2_0 权重 37.6 GB，门槛 48 GB。
   */
  weightsGB?: number;
  /** 官方给的参考内存 GB（低于它就要 SSD 流式读，慢但允许） */
  ramGB: number;
  experimental?: boolean;
  nvidiaOnly?: boolean;
  visionUntested?: boolean;
  /** 这个量化要求的最低引擎版本（semver），来自 setup.py MODELS[*].engine */
  minEngine?: string;
  /** 永远不会被自动推荐（dsv41_fit.recommend 不返回它），界面上标「仅手动选择」 */
  manualOnly?: boolean;
  /** 相对完整模型的质量损失（dsv41_fit ISTA_SETS[*].ppl），标成质量列 */
  qualityLoss?: string;
  /** 专家权重占的 GB（dsv41_fit ISTA_SETS[*].experts_gb） */
  expertsGB?: number;
  /**
   * ramGB 表示的是「显存 + 内存合计」（setup.py MODELS[*].mem_total），不是单看内存 —— Gyro 家族是这样，
   * 界面上要标成「含显存」而不是「参考 RAM」。
   */
  memTotal?: boolean;
}

export interface CatalogModel {
  id: string;
  family: CatalogFamily;
  name: string;
  quants: string[];
  images: boolean;
  source: string;
  snapshotDate: string;
  /** 能装/能跑这个家族的最低 Strata 引擎版本 */
  minEngine?: string;
  /** 带上这个家族安装器的最低 Strata 版本（setup.py PRODUCT_VERSION，不是引擎构建号） */
  minRelease?: string;
  /** 固定启动上下文（安装器不接受别的值），此时页面不显示上下文输入 */
  fixedContext?: number;
  quantInfo: Record<string, CatalogQuantInfo>;
}

const source = `https://github.com/Niko1221/Strata/blob/${UPSTREAM_REVISION}/setup.py`;
const DEEPSEEK41_SOURCE = "https://github.com/Niko1221/Strata/blob/v0.2.6/setup.py";
const snapshotDate = "2026-10-19";

export const MODEL_CATALOG: CatalogModel[] = [
  {
    id: "qwen",
    family: "qwen",
    name: "Qwen3.8-Flash-Next",
    quants: ["Q2_0", "IQ2_XS", "IQ3_XXS", "IQ3_S"],
    images: true,
    source,
    snapshotDate,
    quantInfo: {
      Q2_0: { downloadGB: 66.4, ramGB: 48, weightsGB: 37.6 },
      IQ2_XS: { downloadGB: 68, ramGB: 48, weightsGB: 39.2 },
      IQ3_XXS: { downloadGB: 75.8, ramGB: 60, weightsGB: 47.0 },
      IQ3_S: { downloadGB: 83.6, ramGB: 62, weightsGB: 54.8 },
    },
  },
  {
    id: "swift",
    family: "swift",
    name: "Swift 1.5",
    quants: ["IQ2_XS", "IQ3_XXS", "IQ3_S"],
    images: true,
    source,
    snapshotDate,
    quantInfo: {
      // Swift 1.5 与同尺寸原版「Speed per token and RAM match」（MODELS.md）
      IQ2_XS: { downloadGB: 68, ramGB: 48, weightsGB: 39.2 },
      IQ3_XXS: { downloadGB: 75.8, ramGB: 60, weightsGB: 47.0 },
      IQ3_S: { downloadGB: 83.6, ramGB: 62, weightsGB: 54.8 },
    },
  },
  {
    id: "coder",
    family: "coder",
    name: "Qwen3.8-Flash-Next Coder",
    quants: ["IQ1_M"],
    images: true,
    source,
    snapshotDate,
    // MODELS.md：Coder 的 shard 1 是 29.6 GB，「runs around 32 GB of RAM」
    quantInfo: { IQ1_M: { downloadGB: 58.4, ramGB: 32, weightsGB: 32 } },
  },
  {
    id: "unsloth",
    family: "unsloth",
    name: "Qwen3.8-Flash-Next (Unsloth)",
    quants: ["UD-IQ4_XS", "UD-Q4_K_XL", "UD-Q5_K_XL", "UD-Q6_K_XL", "Q8_0"],
    images: true,
    source,
    snapshotDate,
    quantInfo: {
      "UD-IQ4_XS": { downloadGB: 93.7, ramGB: 48, weightsGB: 72 },
      "UD-Q4_K_XL": { downloadGB: 111.3, ramGB: 48, weightsGB: 88, experimental: true, nvidiaOnly: true, visionUntested: true },
      "UD-Q5_K_XL": { downloadGB: 158.3, ramGB: 108, weightsGB: 108, minEngine: "0.1.44" },
      "UD-Q6_K_XL": { downloadGB: 169.2, ramGB: 118, weightsGB: 118, minEngine: "0.1.44" },
      Q8_0: { downloadGB: 188.2, ramGB: 136, weightsGB: 136, minEngine: "0.1.38" },
    },
  },
  {
    id: "qwen36",
    family: "qwen36",
    name: "Qwen3.6-35B-A3B",
    quants: ["UD-Q4_K_XL", "UD-Q6_K_XL", "Q8_0"],
    images: true,
    source,
    snapshotDate,
    minEngine: "0.1.45",
    quantInfo: {
      // MODELS.md 的「RAM setup plans for」：32 / 44 / 52 GB
      "UD-Q4_K_XL": { downloadGB: 22.9, ramGB: 32, weightsGB: 32 },
      "UD-Q6_K_XL": { downloadGB: 32.6, ramGB: 44, weightsGB: 44 },
      Q8_0: { downloadGB: 37.8, ramGB: 52, weightsGB: 52 },
    },
  },
  {
    id: "deepseek41",
    family: "deepseek41",
    name: "DeepSeek-V4.1-Flash",
    quants: ["IST-DAS-2.00bpw", "IST-DAS-1.75bpw", "IST-DAS-2.25bpw"],
    images: false,
    source: DEEPSEEK41_SOURCE,
    snapshotDate: "2026-10-26",
    minRelease: "0.2.5",
    fixedContext: 8192,
    quantInfo: {
      "IST-DAS-2.00bpw": { downloadGB: 256.8, ramGB: 40, expertsGB: 132.07, qualityLoss: "+15.5%" },
      "IST-DAS-1.75bpw": { downloadGB: 239.3, ramGB: 34, expertsGB: 114.56, qualityLoss: "+21%" },
      "IST-DAS-2.25bpw": { downloadGB: 273.8, ramGB: 44, expertsGB: 149.06, qualityLoss: "+7.3%", manualOnly: true },
    },
  },
  {
    // setup.py:339-348 / 462-474 / 606-615：Gyro 是 agentionai 的量化版（trellis-coded、Hadamard 旋转的专家权重），
    // 需要引擎 0.1.45.1（GYRO_ENGINE）才能读、打包时要 --compat-bf16；ram_gb 是「显存 + 内存合计」，不是单看内存。
    id: "gyro",
    family: "gyro",
    name: "Qwen3.8-Flash-Next (Gyro)",
    quants: ["Gyro-S", "Gyro-M"],
    images: true,
    source: "https://github.com/Niko1221/Strata/blob/v0.2.6/setup.py",
    snapshotDate: "2026-10-28",
    minEngine: "0.1.45.1",
    quantInfo: {
      // MODELS.md「Memory (VRAM + RAM)」：27.6 / 35 GB
      "Gyro-S": { downloadGB: 58.5, ramGB: 27.6, weightsGB: 27.6, memTotal: true },
      "Gyro-M": { downloadGB: 92.0, ramGB: 35.0, weightsGB: 35.0, memTotal: true },
    },
  },
  {
    // setup.py:475-495：sergqwer 的 NVFP4 打包版（`ready_repo`，没有 GGUF 可打包，直接落盘即可跑）。
    // 仅 NVIDIA；ram_gb 是「每张卡常驻专家权重」80 GB；NVFP4-QAD 还要约 110 GB 临时空间做一次转换。
    id: "nvfp4",
    family: "nvfp4",
    name: "Qwen3.8-Flash-Next (NVFP4)",
    quants: ["NVFP4", "NVFP4-NVIDIA", "NVFP4-QAD"],
    images: true,
    source,
    snapshotDate,
    quantInfo: {
      // MODELS.md：「All three need about 80 GB of RAM to keep every expert in RAM」
      NVFP4: { downloadGB: 128.0, ramGB: 80, weightsGB: 80, nvidiaOnly: true, minEngine: "0.1.44" },
      "NVFP4-NVIDIA": { downloadGB: 128.0, ramGB: 80, weightsGB: 80, nvidiaOnly: true, minEngine: "0.1.44" },
      "NVFP4-QAD": { downloadGB: 102.2, ramGB: 80, weightsGB: 80, nvidiaOnly: true, minEngine: "0.1.45" },
    },
  },
];

/** 官方 setup.py 的 DISK_HEADROOM_GB（deepseek41）：低于 下载量 + 6 GB 安装器会警告 */
export const DEEPSEEK41_DISK_HEADROOM_GB = 6;

/** 比较两个点分版本号：`have` 是否至少 `want`（缺失或解析不了都算不够）。 */
export function versionAtLeast(have: string | null | undefined, want: string): boolean {
  if (!have) return false;
  const parts = (value: string) => value.trim().replace(/^v/i, "").split(/[.\-+_]/).filter(Boolean);
  const left = parts(have);
  const right = parts(want);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return false;
    if (y === undefined) return true;
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx > ny;
      continue;
    }
    if (x !== y) return x > y;
  }
  return true;
}

/** 家族的 Strata 版本门禁（minRelease）：null = 无要求；ok=false = 版本未知或太旧。 */
export function catalogReleaseGate(
  family: string,
  releaseVersion?: string | null,
): { minRelease: string; ok: boolean } | null {
  const model = MODEL_CATALOG.find((entry) => entry.family === family);
  if (!model?.minRelease) return null;
  return { minRelease: model.minRelease, ok: versionAtLeast(releaseVersion, model.minRelease) };
}

/** 完整下完一套 deepseek41 需要的磁盘（下载量 + 余量），盘上一个字节都还没有时用。 */
export function deepseek41DiskNeedGB(quant: string): number | null {
  const info = MODEL_CATALOG.find((entry) => entry.family === "deepseek41")?.quantInfo[quant];
  return info ? Math.round((info.downloadGB + DEEPSEEK41_DISK_HEADROOM_GB) * 10) / 10 : null;
}

/** dsv41_fit.recommend()：内存 < 40 GiB 或盘只够 1.75 时给 1.75，否则 2.00；2.25 永不自动。 */
export function recommendDeepseek41(ramGB?: number | null, diskFreeGB?: number | null): string {
  const need = (quant: string) => deepseek41DiskNeedGB(quant) ?? 0;
  if (ramGB != null && ramGB < 40) return "IST-DAS-1.75bpw";
  if (
    diskFreeGB != null &&
    diskFreeGB < need("IST-DAS-2.00bpw") &&
    diskFreeGB >= need("IST-DAS-1.75bpw")
  ) {
    return "IST-DAS-1.75bpw";
  }
  return "IST-DAS-2.00bpw";
}

/**
 * dsv41_fit 的内存档位。
 *
 * fits = 专家权重全进内存（+9 GiB 缓存）；tight = 常用专家进内存，其余读文件；
 * spills = 大部分专家从 SSD 读，慢但允许。ramGB 是 GiB，与 setup.py 的 ram_gb() 同口径。
 */
export function deepseek41MemoryClass(
  quant: string,
  ramGB?: number | null,
): "fits" | "tight" | "spills" | "unknown" {
  const info = MODEL_CATALOG.find((entry) => entry.family === "deepseek41")?.quantInfo[quant];
  if (!info?.expertsGB || ramGB == null || !Number.isFinite(ramGB)) return "unknown";
  if (ramGB >= info.expertsGB + 9) return "fits";
  return ramGB >= info.ramGB ? "tight" : "spills";
}

/** dsv41_fit no_card：显卡名单里没有 NVIDIA / AMD（名单未知时返回 null）。 */
export function deepseek41HasCard(gpus?: readonly string[] | null): boolean | null {
  if (!gpus?.length) return null;
  return gpus.some((line) => /nvidia|geforce|rtx|quadro|tesla|radeon|amd/i.test(line));
}

/** 家族+量化是否在核对过的目录里。 */
export function isCatalogCombination(family: string, quant: string): boolean {
  const model = MODEL_CATALOG.find((entry) => entry.family === family);
  return !!model?.quants.includes(quant);
}

/** 家族的引擎门禁：null = 无要求；ok=false = 没选运行环境或版本太旧。 */
export function catalogEngineGate(
  family: string,
  runtimeVersion?: string | null,
): { minEngine: string; ok: boolean } | null {
  const model = MODEL_CATALOG.find((entry) => entry.family === family);
  if (!model?.minEngine) return null;
  if (!runtimeVersion) return { minEngine: model.minEngine, ok: false };
  return { minEngine: model.minEngine, ok: versionAtLeast(runtimeVersion, model.minEngine) };
}

/** 单个量化的引擎门禁：null = 无要求；ok=false = 没选运行环境或版本太旧。 */
export function catalogQuantEngineGate(
  family: string,
  quant: string,
  runtimeVersion?: string | null,
): { minEngine: string; ok: boolean } | null {
  const model = MODEL_CATALOG.find((entry) => entry.family === family);
  const minEngine = model?.quantInfo[quant]?.minEngine;
  if (!minEngine) return null;
  if (!runtimeVersion) return { minEngine, ok: false };
  return { minEngine, ok: versionAtLeast(runtimeVersion, minEngine) };
}

// ---------------------------------------------------------------------------
// 页面用的常量与文案（照搬上游 ModelDownloadPage 的取值）
// ---------------------------------------------------------------------------

/** 上下文快捷档位 */
export const DOWNLOAD_CONTEXT_PRESETS = [32768, 131072, 262144, 393216, 524288, 1048576];

/** 上下文合法区间（与 setup.py 的校验、上游 snapshotModelDownloadRequest 一致） */
export const CONTEXT_MIN = 512;
export const CONTEXT_MAX = 1048576;

/** 每个家族的一句说明（照搬上游 familyDescription） */
export function familyDescription(family: string): string {
  switch (family) {
    case "qwen":
      return "通用对话与长文，官方首选";
    case "swift":
      return "官方系列模型";
    case "coder":
      return "代码任务专用";
    case "unsloth":
      return "Unsloth 量化分发版本";
    case "qwen36":
      return "读图与多请求并发（引擎 0.1.45+）";
    case "gyro":
      return "agentionai 的 Gyro 量化：小内存首选（显存 + 内存合计 27.6 GB 起，引擎 0.1.45.1+）";
    case "nvfp4":
      return "NVFP4 4 位权重打包版：仅 NVIDIA 显卡（引擎 0.1.44+）";
    case "deepseek41":
      return "284B 大模型，专家权重放内存或读盘，独立引擎（Strata 0.2.5+，仅文本 8K）";
    default:
      return "";
  }
}

/** 选中的量化一次要下多少 GB（页脚「下载并准备 · N GB」用这个）。 */
export function downloadGBOf(family: string, quant: string): number {
  return MODEL_CATALOG.find((entry) => entry.family === family)?.quantInfo[quant]?.downloadGB ?? 0;
}

/** 参考内存 GB */
export function ramGBOf(family: string, quant: string): number {
  return MODEL_CATALOG.find((entry) => entry.family === family)?.quantInfo[quant]?.ramGB ?? 0;
}

/**
 * 官网参考占用 GB（**显存 + 内存合计**）—— 用户 m01417：参考 RAM 本身就该按这个口径读。
 *
 * 取 `docs/MODELS.md`「Pick by memory」的数值；没录入官网值的家族（deepseek41 用的是
 * `dsv41_fit` 的专家内存模型）回退到安装器的 `ram_gb`。
 */
export function weightsGBOf(family: string, quant: string): number {
  const info = MODEL_CATALOG.find((entry) => entry.family === family)?.quantInfo[quant];
  return info?.weightsGB ?? info?.ramGB ?? 0;
}

/**
 * 磁盘需求（字节）：下载量 + 打包余量。
 *
 * 安装器把分片下载到 `Strata-data` 后再打包成最终文件，峰值大约是「分片 + 成品」，
 * 再留 6 GB。这个数只用于**预检拦截**，宁可保守（拦错了用户清一下盘再点一次即可；
 * 放过去了会下到一半失败，几百 GB 白下）。
 */
export function diskNeedBytes(family: string, quant: string): number {
  const gb = downloadGBOf(family, quant);
  if (gb <= 0) return 0;
  return Math.ceil((gb * 2 + 6) * 1e9);
}

/** `32768` → `32K`，`131072` → `128K`（上游 formatContextTokens 的口径） */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}K`;
  return String(tokens);
}

/**
 * 本机内存够不够这个量化的参考内存 —— 照搬上游 `d2Estimates.fitState`：
 * - 参考值 ≤ 本机 80% → 适配；
 * - ≤ 本机 100% → 偏紧；
 * - 再多算上显存卸载（`VRAM − 5 GiB` 的可用部分）仍够 → 偏紧（GPU 卸载不该显示成硬性「不足」）；
 * - 否则不足。界面仍允许启用，这里只做提示。
 */
export function fitOf(
  ramGB: number,
  memoryGB?: number | null,
  vramGB?: number | null,
): "fits" | "tight" | "over" | "unknown" {
  if (ramGB <= 0 || memoryGB == null || !Number.isFinite(memoryGB) || memoryGB <= 0) return "unknown";
  if (ramGB <= memoryGB * 0.8) return "fits";
  if (ramGB <= memoryGB) return "tight";
  const offload = vramGB != null && vramGB > 0 ? Math.max(0, vramGB - 5) : 0;
  if (offload > 0 && ramGB <= memoryGB + offload) return "tight";
  return "over";
}

/** 本机可用于承载模型的预算（内存 + 显存卸载余量），刻度尺的最大值用它。 */
export function usableMemoryGb(
  memoryGB?: number | null,
  vramGB?: number | null,
): number | undefined {
  if (memoryGB == null || !Number.isFinite(memoryGB) || memoryGB <= 0) return undefined;
  const offload = vramGB != null && vramGB > 0 ? Math.max(0, vramGB - 5) : 0;
  return Math.round((memoryGB + offload) * 10) / 10;
}

/** 超过 256K 的上下文在安装器里是实验档（界面标「实验性」）。 */
export function isExtendedContext(context: number): boolean {
  return context > 262144;
}

/** 量化名（与 `strata_community::is_quant_name` 同一套规则）。 */
function isQuantName(text: string): boolean {
  if (/^(BF16|F16|F32)$/i.test(text)) return true;
  return /^(I?Q)\d+(_[A-Za-z0-9]+)*$/i.test(text);
}

/**
 * 从 GGUF 文件名里认出量化版本（`…-00001-of-00002.gguf` 与 `UD-` 前缀都处理）。
 * 「使用已有模型」用它判断这个文件是哪个量化，认不出就没法复用。
 */
export function quantOfName(name: string): string | null {
  const stem = name
    .replace(/\.gguf$/i, "")
    .replace(/-\d{5}-of-\d{5}$/i, "");
  // Gyro 家族的文件名是 `<模型>-Gyro-S-TQ1_0.gguf`：安装器认 `--model Gyro-S`，
  // 末尾的 `TQ1_0` 只是打包格式，不能当作量化名（用户 m02766）。
  const gyro = /-(gyro-[sm])(?:-tq1_0)?$/i.exec(stem);
  if (gyro) return `Gyro-${gyro[1].slice(-1).toUpperCase()}`;
  const parts = stem.split("-");
  const last = parts[parts.length - 1] ?? "";
  if (!isQuantName(last)) return null;
  const previous = parts[parts.length - 2] ?? "";
  return previous.toLowerCase() === "ud" ? `UD-${last.toUpperCase()}` : last.toUpperCase();
}

/** 从 GGUF 文件名里认出安装器家族（规则同 `strata_community::infer_family`）。 */
export function familyOfName(name: string, quant: string): CatalogFamily | null {
  const stem = name.toLowerCase();
  if (quant.startsWith("Gyro-") || stem.includes("gyro")) return "gyro";
  if (stem.includes("qwen3.6")) return "qwen36";
  if (stem.includes("swift")) return "swift";
  if (quant === "IQ1_M") return "coder";
  if (quant.startsWith("UD-") || quant === "Q8_0") return "unsloth";
  if (!stem.includes("flash-next")) return null;
  return "qwen";
}

/**
 * 用控制端 `setup.py` 里读到的值覆盖上面这份快照。
 *
 * 用户 m00985：「参考 RAM」（以及体积）要跟着控制端走，别再靠手抄的快照对不上。
 * 用户 m01170：控制端升级后才读一次 —— 读什么、什么时候读由后端（`strata_control_catalog`）
 * 决定，这里只负责把结果套进 `MODEL_CATALOG`。
 *
 * 只覆盖**两边都认识**的档位：控制端新增家族（本地还没定义）时忽略，
 * 本地多出来的家族（快照独有）保持原值 —— 覆盖率靠 `result.missing` 提示。
 */
export function applyControlCatalog(snapshot: {
  version: string;
  quants: readonly { family: string; quant: string; ramGb: number; downloadGb: number | null; memTotal: boolean }[];
}): { version: string; applied: number; missing: string[] } {
  const missing: string[] = [];
  let applied = 0;
  for (const row of snapshot.quants) {
    const entry = MODEL_CATALOG.find((model) => model.family === row.family);
    const info = entry?.quantInfo[row.quant];
    if (!info) {
      missing.push(`${row.family} · ${row.quant}`);
      continue;
    }
    if (Number.isFinite(row.ramGb) && row.ramGb > 0) info.ramGB = row.ramGb;
    if (row.downloadGb != null && row.downloadGb > 0) info.downloadGB = row.downloadGb;
    if (row.memTotal) info.memTotal = true;
    applied += 1;
  }
  return { version: snapshot.version, applied, missing };
}
