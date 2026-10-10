/**
 * Strata 启动参数的表单层。
 *
 * 与 `paramSchema.ts` 的关系：复用它的类型（`ParamSchema` / `ParamDef` / `ParamState`）
 * 与 `ParamForm` 组件，但**不复用它的换算函数** —— `initParamState` 与
 * `paramStateToEntries` 内部硬编码全局 `paramSchema`（来自 llama.cpp 的
 * `src/assets/params.json`），不接受 schema 参数。Strata 的参数是 CLI flag 数组
 * 而不是 preset 的键值对，语义不同，换算必须自己写。
 *
 * 三条硬约束（对应 STRATA_INTEGRATION_PLAN.md §8.6 的 W 规则）：
 * - 写回只动表单认识的 flag，其余 token **原样保留**（安装事实类参数是上游
 *   安装器写下的，GUI 改了就装不上模型）
 * - 保留原 args 的顺序，新启用的 flag 追加到末尾（上游 `upgrade_config` 按
 *   flag 名迁移，顺序变了不影响，但保持顺序让 diff 可读）
 * - 不新增上游不认识的键
 */

import type { ParamDef, ParamSchema, ParamState } from "./paramSchema";
import { isFlagToken } from "./extraParams";

// 转发给界面层：表单状态类型与 llama.cpp 侧同名，避免组件里两处 import
export type { ParamState };

/** 无值开关：出现即真，不消费下一个 token */
const FLAG_ONLY = new Set(["vision", "kv-grow", "prompt-cache-tail", "no-ple"]);

/**
 * 安装事实类参数：由 Strata 的安装器（`START-HERE.bat` / `setup.py`）写下，
 * 指向 pack / 权重分片 / PLE 表 / MTP / profile 的具体路径。GUI 只读展示，
 * 要改请走上游的安装流程 —— 这些路径与 `Strata-data` 的目录布局是绑定的。
 */
export const STRATA_INSTALL_FACT_FLAGS = [
  "pack",
  "native",
  "ple-gguf",
  "mtp",
  "expert-profile",
  "expert-profile-save",
];

const GROUPS = [
  { id: "ctx", label: "上下文与 KV", order: 1, collapsed: false },
  { id: "speed", label: "加速与缓存", order: 2, collapsed: false },
  { id: "vision", label: "多模态", order: 3, collapsed: false },
  { id: "serve", label: "其它", order: 4, collapsed: true },
];

/** 表单认识的参数（取值域摘自 `strata.exe --help`） */
const PARAM_META: Omit<ParamDef, "abbr" | "delimiter" | "mergeInto" | "mergeValue">[] = [
  {
    key: "max-context",
    flag: "--max-context",
    type: "INTEGER",
    uiType: "dropdown",
    default: "4096",
    values: [
      { value: "32768", label: "32K" },
      { value: "65536", label: "64K" },
      { value: "131072", label: "128K" },
      { value: "204800", label: "200K" },
      { value: "262144", label: "256K" },
    ],
    label: "上下文容量",
    desc: "KV/state 容量（token 数）。引擎按启动时的值一次性分配显存，改完必须重启引擎才生效。",
    group: "ctx",
    order: 1,
    sort: 1,
    defaultEnabled: true,
  },
  {
    key: "kv",
    flag: "--kv",
    type: "STRING",
    uiType: "dropdown",
    default: "fp16",
    values: [
      { value: "fp16", label: "fp16（引擎默认）" },
      { value: "int8", label: "int8（省一半显存）" },
      { value: "q4_0", label: "q4_0（int8 的一半）" },
      { value: "k8v4", label: "k8v4（INT8 K + 旋转 Q4_0 V）" },
    ],
    label: "KV 量化",
    desc: "fp16 是引擎默认；int8 每 64 个值带一个 fp16 scale，显存减半；q4_0 是 Hadamard 旋转后的 4-bit，显存是 int8 的一半、精度略低；k8v4 用 INT8 存 K（注意力分数精确）+ 旋转 Q4_0 存 V，816 B/cell（int8 是 1,056），并且能与 --kv-resident 一起流式。",
    group: "ctx",
    order: 2,
    sort: 2,
    defaultEnabled: true,
  },
  {
    key: "kv-resident",
    flag: "--kv-resident",
    type: "INTEGER",
    uiType: "dropdown",
    default: "0",
    values: [
      { value: "0", label: "0（全在显存）" },
      { value: "20480", label: "20480（下限）" },
      { value: "32768", label: "32768" },
      { value: "65536", label: "65536" },
    ],
    label: "KV池大小",
    desc: "KV 流式：每层 QSA 在显存里保留 N 个 cell，其余 K/V 放固定内存，腾出的显存给专家槽。最小有效值 20480；0 表示全部在显存。上下文不超过 N 时不流式。",
    group: "ctx",
    order: 3,
    sort: 3,
    defaultEnabled: true,
  },
  {
    key: "kv-grow",
    flag: "--kv-grow",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "KV 按需增长",
    desc: "K/V 只为请求真正到达的 cell 占显存，其余交给专家缓存，随上下文增长把槽位还回来。单卡、需配合 --expert-profile。默认启动时就把整个 --max-context 分配掉。",
    group: "ctx",
    order: 4,
    sort: 4,
    defaultEnabled: false,
  },
  {
    key: "spec",
    flag: "--spec",
    type: "INTEGER",
    uiType: "dropdown",
    default: "4",
    values: [
      { value: "0", label: "0（关闭投机解码）" },
      { value: "2", label: "2" },
      { value: "4", label: "4（安装器写入值）" },
      { value: "6", label: "6" },
      { value: "8", label: "8" },
    ],
    label: "MTP 验证窗口",
    desc: "MTP 草稿器每次校验提议多少 token。安装器写 4；配合 --suffix-draft 可在重复概率高的位置每次加 2，最多到 8。",
    group: "speed",
    order: 1,
    sort: 1,
    defaultEnabled: true,
  },
  {
    key: "spec-min-p",
    flag: "--spec-min-p",
    type: "FLOAT",
    uiType: null,
    default: "0.5",
    values: [],
    label: "草稿续窗概率门槛",
    desc: "草稿层要有把握到多少概率才把验证窗口再延长一次。安装器写 0.5；--calibrate 会在这台机器上实测。",
    group: "speed",
    order: 2,
    sort: 2,
    defaultEnabled: true,
  },
  {
    key: "prompt-cache",
    flag: "--prompt-cache",
    type: "INTEGER",
    uiType: "dropdown",
    default: "6",
    values: [
      { value: "0", label: "0（每个 prompt 从头算）" },
      { value: "6", label: "6（引擎默认）" },
      { value: "12", label: "12" },
      { value: "24", label: "24" },
    ],
    label: "会话检查点数量",
    desc: "serve 模式：跨请求保留 N 个会话检查点，每个约 118 MB 内存。0 表示每个 prompt 都从头 prefill。",
    group: "speed",
    order: 3,
    sort: 3,
    defaultEnabled: true,
  },
  {
    key: "prompt-cache-every",
    flag: "--prompt-cache-every",
    type: "INTEGER",
    uiType: "dropdown",
    default: "16384",
    values: [
      { value: "0", label: "0（关闭）" },
      { value: "8192", label: "8192" },
      { value: "16384", label: "16384（默认）" },
      { value: "32768", label: "32768" },
    ],
    label: "检查点间隔",
    desc: "serve 模式：每 N 个新 prompt token 也存一个检查点（默认 16384，0 = 关闭）。",
    group: "speed",
    order: 4,
    sort: 4,
    defaultEnabled: false,
  },
  {
    key: "prompt-cache-tail",
    flag: "--prompt-cache-tail",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "尾部检查点",
    desc: "serve 模式、单卡：在靠近 prompt 结尾处（已有的 chunk 边界）多存一个检查点。需要 --prompt-cache 与 --prompt-cache-every > 0。",
    group: "speed",
    order: 5,
    sort: 5,
    defaultEnabled: false,
  },
  {
    key: "prefill",
    flag: "--prefill",
    type: "STRING",
    uiType: "dropdown",
    default: "auto",
    values: [
      { value: "auto", label: "auto（≤8192 的最大块）" },
      { value: "auto:16384", label: "auto:16384" },
      { value: "auto:32768", label: "auto:32768" },
      { value: "8192", label: "8192" },
    ],
    label: "prefill 分块",
    desc: "分批处理 prompt，每块 CHUNK 个 token（需要 --native）。auto = 专家缓存能借出缓冲区的、不超过 8192 的最大块；auto:16384 / auto:32768 允许更大的块。",
    group: "speed",
    order: 6,
    sort: 6,
    defaultEnabled: true,
  },
  {
    key: "expert-cache",
    flag: "--expert-cache",
    type: "STRING",
    uiType: "dropdown",
    default: "auto",
    values: [
      { value: "auto", label: "auto（能装多少装多少）" },
      { value: "0", label: "0（不驻留）" },
      { value: "256", label: "256" },
      { value: "512", label: "512" },
      { value: "1024", label: "1024" },
    ],
    label: "专家缓存槽位",
    desc: "在显存里驻留 N 个专家 blob，用 moe_hit_grouped_s2 在 GPU 上算它们的行。引擎默认 0。",
    group: "speed",
    order: 7,
    sort: 7,
    defaultEnabled: true,
  },
  {
    key: "vram-reserve-mib",
    flag: "--vram-reserve-mib",
    type: "INTEGER",
    uiType: null,
    default: "0",
    values: [],
    label: "显存预留（MiB）",
    desc: "启动时给系统留出的显存。上游安装器会把它写回 config，这是官方认可的持久化通道。",
    group: "serve",
    order: 1,
    sort: 1,
    defaultEnabled: false,
  },
  {
    key: "pcie-frac",
    flag: "--pcie-frac",
    type: "FLOAT",
    uiType: null,
    default: "0.20",
    values: [],
    label: "PCIe 带宽份额",
    desc: "CPU/SSD 与 GPU 交换数据时允许占用的 PCIe 带宽比例。",
    group: "serve",
    order: 2,
    sort: 2,
    defaultEnabled: false,
  },
  {
    key: "vision",
    flag: "--vision",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "多模态（视觉）",
    desc: "serve 模式同时接收图像（GENI 请求，嵌入由 strata-vision 产生）。关闭后带图的请求会被拒。",
    group: "vision",
    order: 1,
    sort: 1,
    defaultEnabled: false,
  },
  {
    // 哨兵 flag：config 顶层 vision.mmproj，写回走顶层，args 里绝不出现
    key: "vision-mmproj",
    flag: "--vision-mmproj",
    type: "STRING",
    uiType: null,
    default: "",
    values: [],
    label: "多模态模型",
    desc: "视觉投影模型（config 顶层 vision.mmproj）：让视觉编码器把图像嵌入成模型能读的向量，勾选「多模态（视觉）」后必填。保存时 GUI 会同时把 vision.exe 补成 <安装目录>\\engine\\strata-vision.exe、把 vision.model 同步成启动参数里的 --model。",
    group: "vision",
    order: 2,
    sort: 2,
    defaultEnabled: false,
  },
  {
    // 哨兵 flag：config 顶层 vision.gpu，取值与该字段一致（true = 卸载到 GPU）
    key: "vision-gpu",
    flag: "--vision-gpu",
    type: "LOGIC",
    uiType: null,
    default: "true",
    values: [],
    label: "多模态GPU卸载",
    desc: "取值就是 config 顶层 vision.gpu：true = 视觉引擎卸载到 GPU（上游据此给 strata-vision 加 --gpu，视觉塔常驻显存，带图请求快）；false = 卸载到 CPU（省显存，带图请求变慢）。GUI 写的是 config 字段，不改启动命令。",
    group: "vision",
    order: 3,
    sort: 3,
    defaultEnabled: true,
  },
  {
    // 哨兵 flag：config 顶层 vision.max_tokens
    key: "vision-max-tokens",
    flag: "--vision-max-tokens",
    type: "INTEGER",
    uiType: null,
    default: "768",
    values: [],
    label: "图片最大 token 数",
    desc: "单张图展开成多少个视觉 token（config 顶层 vision.max_tokens）。越大越细、越占上下文。",
    group: "vision",
    order: 4,
    sort: 4,
    defaultEnabled: false,
  },
  {
    // 哨兵 flag：config 顶层 open_browser（上游判定 = 启动命令带 --open 且该字段不为 false）
    key: "open-browser",
    flag: "--open-browser",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "webui",
    desc: "启动后自动打开浏览器进入 Strata 自带 WebUI（config 顶层 open_browser）。上游判定是「启动命令带 --open 且该字段不为 false」。GUI 内嵌 WebUI 时不需要勾选。",
    group: "serve",
    order: 3,
    sort: 3,
    defaultEnabled: false,
  },
];

/** 表单 schema（供 `ParamForm` 的 `schema` prop 使用） */
export const strataParamSchema: ParamSchema = {
  groups: GROUPS,
  params: PARAM_META.map((p) => ({
    ...p,
    abbr: "",
    delimiter: null,
    uiType: p.uiType ?? null,
  })),
};

const FLAG_TO_KEY = new Map<string, string>(
  strataParamSchema.params.map((p) => [p.flag, p.key]),
);

/** 表单认识的 flag 集合（写回时的白名单） */
export const STRATA_KNOWN_FLAGS = new Set(FLAG_TO_KEY.keys());

/**
 * 顶层字段类参数：它们不是 CLI flag，值存在 config 顶层（`vision.*` / `open_browser`），
 * 进 schema 只是为了复用 `ParamForm` 的分组渲染。**写回时绝不进 args** ——
 * 上游引擎不认识这些 flag，塞进去会让引擎启动失败。
 */
const TOP_LEVEL_KEYS = new Set(["vision-mmproj", "vision-gpu", "vision-max-tokens", "open-browser"]);

/**
 * token 是不是一个 flag（而不是某个 flag 的取值）—— 实现在 `utils/extraParams.ts`。
 *
 * 这里只做转出，保持调用方（本模块与 `StrataPanel`）引用同一个实现。
 * 判据取「以 `-` 开头且不是数字」，而**不是**「认识这个 flag」：上游安装器往 config 的
 * args 里写的开关（例如 `--native`）不在本表单的 schema 里，用 `FLAG_TO_KEY` 判断就会
 * 把它当成前一个 flag 的取值 —— 读的时候把 `--native` 显示成 `--max-context` 的值，
 * 写回时又把它当「被替换掉的旧值」消费掉，上游写的开关就这么没了。
 * 也不能只看首字符：负数取值（`--n-gpu-layers -1`）会被当成 flag 而从表单里显示成
 * 「无值」，用户一改这个参数，写回就多出一个孤立的 `-1`。
 * 左栏的 args 展开（StrataPanel 的 argRows）必须用同一个判据，两处不一致就还是会错。
 */
export { isFlagToken };

/**
 * args → 表单状态。
 *
 * 表单没覆盖的 token 不在状态里出现，写回时按原样保留，因此不会丢。
 */
export function argsToState(args: unknown[]): Record<string, ParamState> {
  const state: Record<string, ParamState> = {};
  for (const def of strataParamSchema.params) {
    const at = args.findIndex((t) => t === def.flag);
    if (at < 0) {
      state[def.key] = { enabled: false, value: def.default };
      continue;
    }
    if (FLAG_ONLY.has(def.key)) {
      state[def.key] = { enabled: true, value: "true" };
      continue;
    }
    const raw = args[at + 1];
    // 下一个 token 是 flag（也包括本表单不认识的未知 flag）时，当前 flag 视为**无值**。
    // 旧写法无条件取 at+1：`["--max-context","--native",...]` 里 `--native` 会被当成
    // max-context 的取值，表单里就显示成「上下文 = --native」。
    const value =
      raw == null || isFlagToken(String(raw))
        ? ""
        : typeof raw === "string"
          ? raw
          : String(raw as number | boolean);
    state[def.key] = { enabled: true, value };
  }
  return state;
}

/**
 * 表单状态 → args。
 *
 * 遍历原 args：表单认识的 flag 按状态决定留/删（连同它的值 token），
 * 其余 token 原样保留；原 args 里没有、这次新启用的 flag 追加到末尾。
 */
export function stateToArgs(args: unknown[], state: Record<string, ParamState>): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const key = typeof token === "string" ? FLAG_TO_KEY.get(token) : undefined;
    if (!key) {
      out.push(token);
      continue;
    }
    const entry = state[key];
    if (!entry?.enabled) continue;
    out.push(token);
    if (FLAG_ONLY.has(key)) continue;
    const next = args[i + 1];
    // 判据与 argsToState / argRows 保持一致：只有「下一个不是 flag」时才消费那个值 token。
    // 旧写法是 `!FLAG_TO_KEY.has(...)`（只认表单认识的 flag），位置上的未知开关
    // （上游安装器写的 `--native` 之类）会被当成值 token 一起跳过 —— 一次保存就把它删了。
    if (next != null && !isFlagToken(String(next))) i += 1;
    // 空值代表"这个 flag 本来就没有取值"（见 argsToState），不能塞空串进 args：
    // 引擎会收到一个空参数，比不写还糟。
    if (entry.value !== "") out.push(entry.value);
  }
  for (const def of strataParamSchema.params) {
    const entry = state[def.key];
    if (!entry?.enabled) continue;
    if (TOP_LEVEL_KEYS.has(def.key)) continue; // 顶层字段永不进 args
    if (args.includes(def.flag)) continue;
    out.push(def.flag);
    if (!FLAG_ONLY.has(def.key) && entry.value !== "") out.push(entry.value);
  }
  return out;
}

/** 表单没覆盖的 flag（安装事实类），用于界面上的只读说明 */
export function installFactFlags(args: unknown[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== "string" || !token.startsWith("--")) continue;
    const name = token.slice(2);
    if (STRATA_INSTALL_FACT_FLAGS.includes(name)) out.push(name);
  }
  return out;
}

/**
 * config → 表单状态：args 走 `argsToState`，再灌入顶层字段（`vision.*` / `open_browser`）。
 *
 * 弹窗展示的是「这个 config 的完整启动配置」，顶层字段与 args 一样是启动事实。
 */
export function configToState(cfg: Record<string, unknown>): Record<string, ParamState> {
  const state = argsToState(Array.isArray(cfg.args) ? (cfg.args as unknown[]) : []);
  const vision =
    cfg.vision && typeof cfg.vision === "object" ? (cfg.vision as Record<string, unknown>) : undefined;
  const mmproj = vision?.mmproj != null ? String(vision.mmproj) : "";
  state["vision-mmproj"] = { enabled: mmproj !== "", value: mmproj };
  // 取值直接对应 vision.gpu（true = 视觉引擎常驻 GPU）
  state["vision-gpu"] = {
    enabled: vision !== undefined,
    value: vision?.gpu === false ? "false" : "true",
  };
  const mt = vision?.max_tokens;
  state["vision-max-tokens"] = { enabled: mt != null, value: mt != null ? String(mt) : "768" };
  state["open-browser"] = { enabled: !!cfg.open_browser, value: cfg.open_browser ? "true" : "false" };
  return state;
}

/**
 * 表单状态 → 整个 config。
 *
 * args 走 `stateToArgs`（只动认识的 flag、保顺序、顶层字段永不进 args）；
 * 顶层只写表单认识的键 —— `vision.mmproj` / `vision.model` / `vision.exe` /
 * `vision.gpu` / `vision.max_tokens` / `open_browser`，其余键原样保留。
 *
 * `vision.model` 是主模型，不由用户在这里选：GUI 从启动参数里的 `--model` 同步过来
 * （上游 `server.py` 把 exe/mmproj/model 三键都当必需键）。
 *
 * `root` = 设置里的 Strata 安装目录：`vision.exe` 是上游必需键（`server.py` 用它起
 * 视觉编码器），config 里已有就原样保留，缺失时按 `<root>/engine/strata-vision.exe` 补上。
 */
export function stateToConfig(
  cfg: Record<string, unknown>,
  state: Record<string, ParamState>,
  root?: string | null,
): Record<string, unknown> {
  const args = Array.isArray(cfg.args) ? (cfg.args as unknown[]) : [];
  const next: Record<string, unknown> = { ...cfg, args: stateToArgs(args, state) };

  const prevVision =
    cfg.vision && typeof cfg.vision === "object"
      ? { ...(cfg.vision as Record<string, unknown>) }
      : undefined;
  // 「多模态（视觉）」勾选 = args 里带 --vision
  const visionOn = !!state["vision"]?.enabled;
  const mmproj = (state["vision-mmproj"]?.value || "").trim();
  // vision.model 是主模型：从启动参数里的 --model 同步，用户不在这里选
  const argList = next.args as unknown[];
  const modelIdx = argList.indexOf("--model");
  const mainModel =
    modelIdx >= 0 && modelIdx + 1 < argList.length ? String(argList[modelIdx + 1]) : "";
  if (visionOn || prevVision) {
    const v: Record<string, unknown> = prevVision ?? {};
    if (mmproj) v.mmproj = mmproj;
    if (mainModel) v.model = mainModel;
    if (!v.exe && root) {
      const sep = root.includes("\\") ? "\\" : "/";
      v.exe = `${root}${sep}engine${sep}strata-vision.exe`;
    }
    // 值与 vision.gpu 一致：value 是权威（ParamForm 的 LOGIC 控件以 value 为准）
    v.gpu = (state["vision-gpu"]?.value ?? "true") !== "false";
    const mt = state["vision-max-tokens"];
    const n = mt?.enabled ? Number(mt.value) : NaN;
    if (Number.isFinite(n) && n > 0) v.max_tokens = Math.trunc(n);
    else delete v.max_tokens;
    next.vision = v;
  }

  if (state["open-browser"]?.enabled) next.open_browser = true;
  else if ("open_browser" in cfg) next.open_browser = false;
  return next;
}
