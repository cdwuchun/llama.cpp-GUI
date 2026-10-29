import type { StrataCommunityModel, StrataCommunityQuant } from "../types";
import { weightsGBOf } from "./modelCatalog";

/**
 * 社区目录：内置条目 + 后端发现结果。
 *
 * 内置的三条照搬上游 `packages/core/src/community-catalog.ts` 的 `BUILTIN_COMMUNITY_MODELS`
 * ——它们在 Hugging Face 上长期存在，直接写进代码比每次搜一遍稳；后端发现（
 * `strata_community_discover`）只补充新出现的仓库，并排掉这三条避免重复。
 *
 * 下载方式：内置条目的家族（qwen / swift / coder / unsloth）都是 `setup.py --family F --model Q`
 * 认得的，所以点下载照样走官方安装器；ORCA 那条 `family: "orca"` 官方安装器不认，
 * 面板里只给说明和官方文档链接。
 */

/** `setup.py --family` 认得的家族。 */
const SETUP_FAMILIES = ["qwen", "swift", "coder", "unsloth"];

export function setupFamilyOf(family: string): boolean {
  return SETUP_FAMILIES.includes(family);
}

/**
 * 上游 `quantEntry` 的等价物。
 *
 * `downloadGb` 必须是**全部本分片之和**：GSQ-RCO 家族是两片布局，第 2 片是 28.8 GB 的
 * n-gram 表（上游 `NGRAM.size`），只看第 1 片会少算近 30 GB。
 * `ramGb` 走官方目录里的同量化参考占用（「显存 + 内存」，`weightsGBOf`），没有才退回「体积 + 10」。
 */
function quant(downloadGb: number, ramGb: number): StrataCommunityQuant {
  return { files: [], downloadGb, ramGb };
}

/** 官方目录 qwen 家族的参考占用（显存 + 内存，`docs/MODELS.md`「Pick by memory」）。 */
const QWEN_RAM: Record<string, number> = { Q2_0: 37.6, IQ2_XS: 39.2, IQ3_XXS: 47.0, IQ3_S: 54.8 };

function builtin(
  base: Omit<StrataCommunityModel, "source" | "quantInfo" | "quants" | "mmproj"> & {
    quantSizes: Record<string, number>;
    ramSizes?: Record<string, number>;
    mmproj?: string | null;
  },
): StrataCommunityModel {
  const { quantSizes, ramSizes, mmproj, ...rest } = base;
  const quantInfo: Record<string, StrataCommunityQuant> = {};
  for (const [name, size] of Object.entries(quantSizes)) {
    quantInfo[name] = quant(size, ramSizes?.[name] ?? QWEN_RAM[name] ?? Math.ceil(size + 10));
  }
  return {
    ...rest,
    quants: Object.keys(quantSizes),
    quantInfo,
    mmproj: mmproj ?? null,
    source: "builtin",
  };
}

/** 内置社区模型（顺序即列表顺序）。 */
export const BUILTIN_COMMUNITY_MODELS: StrataCommunityModel[] = [
  builtin({
    id: "sc117-abliterated",
    slug: "sc117-abliterated",
    name: "SC117 abliterated",
    repo: "SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF",
    revision: "eec4e10a2c29b440a2ae85591fa11569ce752963",
    family: "qwen",
    kind: "gsq-rco",
    images: true,
    risks: ["noGuardrails", "mtpNotAbliterated", "agentPersistence"],
    downloads: 1_950_149,
    likes: 332,
    updatedAt: "2026-10-19",
    quantSizes: { Q2_0: 66.8, IQ2_XS: 68.5, IQ3_XXS: 76.1, IQ3_S: 83.9 },
    mmproj: "mmproj-Qwen3.8-Flash-Next-BF16.gguf",
  }),
  builtin({
    id: "alesha-pro-cvec",
    slug: "alesha-pro-cvec",
    name: "alesha-pro refusal vector",
    repo: "alesha-pro/Qwen3.8-Flash-Next-abliterated-GSQ-RCO-Strata-GGUF",
    revision: "d4af3be5701549435e0770d625f79dd2def1358f",
    family: "qwen",
    kind: "control-vector",
    images: true,
    risks: ["noGuardrails", "controlVectorMac"],
    downloads: 207_818,
    likes: 164,
    updatedAt: "2026-10-19",
    quantSizes: { Q2_0: 66.4, IQ2_XS: 68, IQ3_XXS: 75.8, IQ3_S: 83.6 },
  }),
  builtin({
    id: "orcarouter-iq3xxs",
    slug: "orcarouter",
    name: "OrcaRouter Uncensored",
    repo: "orcarouter/Qwen3.8-Flash-Next-Uncensored-GGUF",
    revision: "d366e279688c1f2fd6e75e2f98475d38db534f1d",
    family: "orca",
    kind: "orca",
    images: false,
    risks: ["noGuardrails", "textOnly", "orcaRam"],
    downloads: 869_081,
    likes: 1_002,
    updatedAt: "2026-10-19",
    quantSizes: { IQ3_XXS: 85.2 }, // ORCA 两片之和
    ramSizes: { IQ3_XXS: 54 },
  }),
];

/**
 * 拿官方目录的内存参考覆盖发现条目的估计值。
 *
 * 上游 `quantEntry` 是 `officialRam(family, quant) ?? ceil(首片体积 + 10)`：同一个量化（比如
 * `IQ3_XXS`）不管出自哪个仓库，参考值都是官方那一份。后端只能看到文件体积，所以它给的
 * 「体积 + 10」是个兜底，这里用官方表校正（校正不到才保留后端值）。
 *
 * 取的是官网「Pick by memory」的**显存 + 内存合计**口径（`weightsGBOf`），与官方页同一列。
 */
function withOfficialRam(model: StrataCommunityModel): StrataCommunityModel {
  const quantInfo: Record<string, StrataCommunityQuant> = {};
  for (const [quant, info] of Object.entries(model.quantInfo)) {
    const official = weightsGBOf(model.family, quant);
    quantInfo[quant] = official > 0 ? { ...info, ramGb: official } : info;
  }
  return { ...model, quantInfo };
}

/**
 * 内置 + 发现的合并结果：内置在前，发现按下载量降序。
 *
 * 只排掉与内置条目同一个仓库的发现结果；**不能按仓库去重**——上游一个仓库会按家族
 * 产出多条（`SC117 · … · Swift` 与 `SC117 · … · Unsloth UD` 同 repo），去掉重复的
 * repo 会把 unsloth 那几条整片吞掉（列表只剩一半）。
 */
export function mergeCommunityModels(
  discovered: readonly StrataCommunityModel[],
): StrataCommunityModel[] {
  const builtin = new Set(BUILTIN_COMMUNITY_MODELS.map((model) => model.repo.toLowerCase()));
  const extra = [...discovered]
    .filter((model) => !builtin.has(model.repo.toLowerCase()))
    .map(withOfficialRam)
    .sort((left, right) => (right.downloads ?? 0) - (left.downloads ?? 0));
  // 内置条目也要过一遍：它们的 `builtin()` 只会填 qwen 的兜底值和 ORCA 的手填值
  return [...BUILTIN_COMMUNITY_MODELS.map(withOfficialRam), ...extra];
}

const RISK_LABELS: Record<string, string> = {
  mtpNotAbliterated: "MTP 草稿头未消偏",
  agentPersistence: "agent 配置会持久化",
  controlVectorMac: "控制向量仅 macOS",
  noGuardrails: "无安全对齐",
  unverified: "未经验证",
  textOnly: "仅文本",
  orcaRam: "需约 50GB 系统内存",
};

export function riskLabel(risk: string): string {
  return RISK_LABELS[risk] ?? risk;
}

const KIND_LABELS: Record<string, string> = {
  "gsq-rco": "GSQ-RCO",
  "control-vector": "控制向量",
  orca: "ORCA",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 社区模型的来源域名（面板里显示 hosted on ...）。 */
export function repoHost(model: StrataCommunityModel): string {
  if (model.kind === "orca") {
    return "OrcaRouter";
  }
  return "Hugging Face";
}
