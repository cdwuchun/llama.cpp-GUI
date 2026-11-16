import type {
  StrataCommunityFile,
  StrataCommunityModel,
  StrataCommunityQuant,
  StrataCommunitySetupRequest,
} from "../types";
import { weightsGBOf } from "./modelCatalog";

/**
 * 社区目录：内置条目 + 后端发现结果。
 *
 * 内置的三条照搬上游 `packages/core/src/community-catalog.ts` 的 `BUILTIN_COMMUNITY_MODELS`
 * ——它们在 Hugging Face 上长期存在，直接写进代码比每次搜一遍稳；后端发现（
 * `strata_community_discover`）只补充新出现的仓库，并排掉这三条避免重复。
 *
 * 下载方式（用户 m00001 报的 bug 就出在这里）：社区档**不能**只交 `family + quant` 给官方安装器。
 * `setup.py` 的 `FAMILIES[family]["hf"]` 是写死的官方 ISTA-DASLab 仓库、也没有 `--repo` 参数，
 * 只传 family+quant 下回来的必然是官方权重量化。所以每个内置量化都带上完整文件清单与
 * SHA-256（上游 `sc117()` / `alesha()` 的同一份数据），由 `strata_community_setup_start`
 * 按「仓库 + 固定提交」自己下，再走 `setup.py --gguf-dir` 准备。
 *
 * ORCA 那条 `family: "orca"` 官方安装器不认，面板里只给说明和官方文档链接（走 `strata_orca_start`）。
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
 * n-gram 表（`NGRAM`），只看第 1 片会少算近 30 GB。文件清单在这里是硬数据，体积直接由它算出来。
 * `ramGb` 走官方目录里的同量化参考占用（「显存 + 内存」，`weightsGBOf`），没有才退回「体积 + 10」。
 */
function quant(files: StrataCommunityFile[], ramGb: number): StrataCommunityQuant {
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  return { files, downloadGb: Math.round((bytes / 1e9) * 10) / 10, ramGb };
}

/** 官方目录 qwen 家族的参考占用（显存 + 内存，`docs/MODELS.md`「Pick by memory」）。 */
const QWEN_RAM: Record<string, number> = { Q2_0: 37.6, IQ2_XS: 39.2, IQ3_XXS: 47.0, IQ3_S: 54.8 };

/** 第 2 片（n-gram 表）在 GSQ-RCO 各档之间、以及与官方 ISTA-DASLab 的分片都是同一个文件。 */
const NGRAM: Omit<StrataCommunityFile, "path"> = {
  size: 28_800_138_432,
  sha256: "316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113",
};

/** SC117 消偏仓库的两片（上游 `sc117()`）。 */
function sc117(quant: string, size: number, sha256: string): StrataCommunityFile[] {
  return [
    {
      path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-${quant}-00001-of-00002.gguf`,
      size,
      sha256,
    },
    {
      path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-${quant}-00002-of-00002.gguf`,
      ...NGRAM,
    },
  ];
}

/** alesha 仓库的两片（官方同名分片，上游 `alesha()`）。 */
function alesha(quant: string, size: number, sha256: string): StrataCommunityFile[] {
  return [
    {
      path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-${quant}-00001-of-00002.gguf`,
      size,
      sha256,
    },
    {
      path: `${quant}/Qwen3.8-Flash-Next-GSQ-RCO-${quant}-00002-of-00002.gguf`,
      ...NGRAM,
    },
  ];
}

function builtin(
  base: Omit<StrataCommunityModel, "source" | "quantInfo" | "quants" | "mmproj"> & {
    /** 每个量化的完整文件清单（含 SHA-256），体积由它算出来 */
    quantFiles: Record<string, StrataCommunityFile[]>;
    ramSizes?: Record<string, number>;
    mmproj?: string | null;
  },
): StrataCommunityModel {
  const { quantFiles, ramSizes, mmproj, ...rest } = base;
  const quantInfo: Record<string, StrataCommunityQuant> = {};
  for (const [name, files] of Object.entries(quantFiles)) {
    const fallback = Math.ceil(files[0].size / 1e9 + 10);
    quantInfo[name] = quant(files, ramSizes?.[name] ?? QWEN_RAM[name] ?? fallback);
  }
  return {
    ...rest,
    quants: Object.keys(quantFiles),
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
    quantFiles: {
      Q2_0: sc117("Q2_0", 38_021_379_872, "1620faf21c845524cbe38dcbbaf850b8d155c2299df05d8b7bfb43b642c4647e"),
      IQ2_XS: sc117("IQ2_XS", 39_665_015_072, "4acc3ebb5050d20117bdc77fc39200e709dfe2b2367f3522c95b9112a30aff81"),
      IQ3_XXS: sc117("IQ3_XXS", 47_342_144_896, "03b11926b41a3d7f7a008882b1bc7a6330a3c9c43d3cad4598d31dc73042fdc5"),
      IQ3_S: sc117("IQ3_S", 55_063_448_064, "40f369eca301ec6ea318dbb671b3132c26a2f0b89aa5458a7051b33215ee296c"),
    },
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
    quantFiles: {
      Q2_0: alesha("Q2_0", 37_623_740_192, "69820c02ec7d0b45ef2ebb19d6620299db749fe2aded7f39f93c6b88b199b720"),
      IQ2_XS: alesha("IQ2_XS", 39_225_954_592, "92cee27ae5bbadcd732416a0f7a7f0acc092399dbbe8f5a5efa707c2ec0a49d7"),
      IQ3_XXS: alesha("IQ3_XXS", 47_039_860_096, "219ea929900dfa9ef091f3aa473fdba6874b65fcb36526d7d851ac9e95856d15"),
      IQ3_S: alesha("IQ3_S", 54_817_524_224, "4c1eb2ceb4915e1192f4f386021897bde56a97f40a0bb78bb86465e0f7d2aca3"),
    },
    // 上游只有这一条带去拒答向量；它随分片一起下、当 `--experimental-speed-projection` 的参数
    controlVector: {
      path: "Huihui-Qwen3.8-Flash-Next-refusal-direction-r.gguf",
      size: 483_520,
      sha256: "59f9ae8b4372107ae79044278a4406bdfe8f8861fe599aa5848515f0d072be38",
    },
    mmproj: "mmproj-Qwen3.8-Flash-Next-BF16.gguf",
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
    // ORCA 走自建下载器（`strata_orca_start`）：它自己的仓库、没有发布 SHA-256，
    // 所以这里只是两片体积的展示值，不参与社区安装请求
    quantFiles: {
      IQ3_XXS: [
        { path: "Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf", size: 44_637_691_008, sha256: null },
        { path: "Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00002-of-00002.gguf", size: 40_564_977_024, sha256: null },
      ],
    },
    ramSizes: { IQ3_XXS: 54 },
  }),
];

/**
 * 把「列表里选中的社区条目 + 量化」组装成后端要的安装请求（上游 `communitySetupRequest`）。
 *
 * - `files` 缺 SHA-256 或为空时返回 `null`：后端 `validate` 也会拒，但在这里就拦下，
 *   页面能给出「这条来源没有可校验的文件」而不是等后端报错。
 * - 上游这里**不带 mmproj**：图像投影器由官方安装器按 ISTA 的 SHA-256 自己准备。
 */
/**
 * 社区档除了分片还要写的 pack（安装器第 6 步）：
 * qwen 的 Q2_0 在 AVX-512 机器上会被重编码成约 40 GB 的 experts.bin，
 * 其余组合只写 `native_experts.txt` 与 `tokenizer/`（秒级），按 2 GB 兜底。
 * 与上游 `communityDiskEstimate` 的口径一致。
 */
export function communityPackGb(family: string, quant: string): number {
  return family === "qwen" && quant === "Q2_0" ? 40 : 2;
}

export function communitySetupRequest(
  model: StrataCommunityModel,
  quant: string,
): Omit<StrataCommunitySetupRequest, "context" | "images"> | null {
  const info = model.quantInfo[quant];
  if (!info || info.files.length === 0) {
    return null;
  }
  if (info.files.some((file) => !file.sha256)) {
    return null;
  }
  return {
    slug: model.slug,
    repo: model.repo,
    revision: model.revision,
    family: model.family,
    quant,
    files: info.files,
    controlVector: model.controlVector ?? null,
  };
}

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
