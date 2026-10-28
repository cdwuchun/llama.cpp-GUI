/**
 * Strata 启动参数的表单层。
 *
 * 与 `paramSchema.ts` 的关系：复用它的类型（`ParamSchema` / `ParamDef` / `ParamState`）
 * 与 `ParamForm` 组件，但**不复用它的换算函数** —— `initParamState` 与
 * `paramStateToEntries` 内部硬编码全局 `paramSchema`（来自 llama.cpp 的
 * `src/assets/params.json`），不接受 schema 参数。Strata 的参数是 CLI flag 数组
 * 而不是 preset 的键值对，语义不同，换算必须自己写。
 *
 * 三条硬约束（对应 docs/archive/STRATA_INTEGRATION_PLAN.md §8.6 的 W 规则）：
 * - 写回只动表单认识的 flag，其余 token **原样保留**（安装事实类参数是上游
 *   安装器写下的，GUI 改了就装不上模型）
 * - 保留原 args 的顺序，新启用的 flag 追加到末尾（上游 `upgrade_config` 按
 *   flag 名迁移，顺序变了不影响，但保持顺序让 diff 可读）
 * - 不新增上游不认识的键
 */

import type { ParamDef, ParamSchema, ParamState } from "./paramSchema";
import { isFlagToken } from "./extraParams";

/**
 * 视觉编码器（CPU 解码）的线程数，规则抄自上游 `setup.py` 的 `vision_threads()`：
 * `max(1, min(逻辑线程数 // 2, VISION_THREADS_CAP))`，`VISION_THREADS_CAP = 16`。
 * 浏览器里拿不到「物理核」，`navigator.hardwareConcurrency` 给的是逻辑线程数，与上游 `os.cpu_count()` 同义。
 */
function visionThreads(): number {
  const logical =
    typeof navigator !== "undefined" && Number(navigator.hardwareConcurrency) > 0
      ? Number(navigator.hardwareConcurrency)
      : 8;
  return Math.max(1, Math.min(Math.floor(logical / 2), 16));
}

// 转发给界面层：表单状态类型与 llama.cpp 侧同名，避免组件里两处 import
export type { ParamState };

/** 无值开关：出现即真，不消费下一个 token */
const FLAG_ONLY = new Set([
  "vision",
  "kv-grow",
  "prompt-cache-tail",
  "no-ple",
  "batch-mtp",
  "resident-experts",
  "expert-cache-per-layer",
]);

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
  // 并发与上面两组是同一层级的启动事实：--batch / --batch-mtp / --batch-groups
  // 是引擎的并发批次开关，--conversation-cache-* 是配套的会话停放预算（用户 m03848）
  { id: "parallel", label: "并发", order: 3, collapsed: false },
  { id: "sampling", label: "采样", order: 4, collapsed: false },
  { id: "vision", label: "多模态", order: 5, collapsed: false },
  { id: "serve", label: "其它", order: 6, collapsed: true },
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
    label: "动态增长 KV",
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
    label: "推测解码窗口",
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
    label: "草稿最小概率",
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
    label: "提示词检查点数",
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
    label: "提示词尾部检查点",
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
    label: "Prefill 分块（token）",
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
    label: "显存专家缓存槽数",
    desc: "在显存里驻留 N 个专家 blob，用 moe_hit_grouped_s2 在 GPU 上算它们的行。引擎默认 0。",
    group: "speed",
    order: 7,
    sort: 7,
    defaultEnabled: true,
  },
  {
    key: "resident-experts",
    flag: "--resident-experts",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "低内存模式",
    desc: "低内存机器的常驻模式（setup 用）：等价于 --mmap-experts --resident-cpu-experts —— 显存缓存装不下的专家常驻在内存里，副本能页锁定就页锁定，保留 4 GiB 余量，装不下时退回纯 mmap。同一个 placement 下答案与 --mmap-experts 相同。",
    group: "speed",
    order: 8,
    sort: 8,
    defaultEnabled: false,
  },
  {
    key: "adapt-async",
    flag: "--adapt-async",
    type: "INTEGER",
    uiType: null,
    default: "1",
    values: [],
    label: "异步适应",
    desc: "专家交换在 verify 窗口之间推进，不等一整轮验证结束（单卡 + CUDA，走专家 arena 或低内存常驻模式时才有意义）。代价是不可复现：同一个 prompt 两次运行，即使 temperature 0 也可能出现个别不同的 token —— 评测、回归、A/B 对比时不要开。0 = 关闭，引擎默认就是 0。",
    group: "speed",
    order: 9,
    sort: 9,
    defaultEnabled: false,
  },
  {
    key: "expert-cache-per-layer",
    flag: "--expert-cache-per-layer",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "逐层分配缓存",
    desc: "给每一层自己的专家槽位，而不是让先到的位置把槽位吃光（引擎默认按到达顺序共用一个计数器，256 槽时几乎全给了第 0 位置的 26 层，命中率只有 2.97%）。引擎实测：同样的路由，8 槽/层命中 21.4%、64 槽/层 70.4%；4096 槽与它一起用时命中 54.4%、CPU 池排水 19.1 → 10.3 ms/token。小显存卡收益最大，建议实测对比。",
    group: "speed",
    order: 10,
    sort: 10,
    defaultEnabled: false,
  },
  {
    key: "host-core",
    flag: "--host-core",
    type: "STRING",
    uiType: "dropdown",
    default: "first",
    values: [
      { value: "first", label: "first（默认，第一个物理核）" },
      { value: "last", label: "last（最后一个物理核）" },
      { value: "sibling", label: "sibling（第一个核的 SMT 兄弟）" },
    ],
    label: "宿主线程核",
    desc: "宿主（调度）线程钉在哪个核：Windows 把 GPU 中断都发给第一个逻辑处理器，而每次专家拷贝落地都会抬一次中断，宿主在同一个核上自旋时会等它。sibling = 宿主挪到第一个核的另一个硬件线程，workers 仍吃满所有核（混合核 CPU 上也能用）。只挪线程，不改结果。",
    group: "speed",
    order: 11,
    sort: 11,
    defaultEnabled: false,
  },
  {
    key: "pin-by-need",
    flag: "",
    type: "LOGIC",
    uiType: null,
    default: "true",
    values: [],
    label: "优先锁定所需专家",
    desc: "写进 config 的 env 块（STRATA_PIN_BY_NEED=1），不是命令行参数。Windows 一次只能给显卡锁定约一半内存，开了它先锁显卡真正要用的那些专家（不再按文件顺序锁）。官方在 RTX 5070 上测得 prompt 读取 +4.4%；副作用是启动时的锁页顺序变了。",
    group: "speed",
    order: 12,
    sort: 12,
    defaultEnabled: false,
    env: "STRATA_PIN_BY_NEED",
  },
  {
    key: "batch",
    flag: "--batch",
    type: "INTEGER",
    uiType: "dropdown",
    default: "2",
    values: [
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "6", label: "6" },
      { value: "8", label: "8" },
    ],
    label: "并发槽位",
    desc: "--batch N（与 --slots N 等价）：最多 N 个请求同时解码，每个槽位有自己的 session 并占用与主 session 相当的显存（通常 2..8，引擎批次窗口最多 8 行）。不写 = 单请求串行。改完要重启引擎才生效。",
    group: "parallel",
    order: 1,
    sort: 1,
    defaultEnabled: false,
  },
  {
    key: "batch-mtp",
    flag: "--batch-mtp",
    type: "LOGIC",
    uiType: null,
    default: "false",
    values: [],
    label: "MTP 并发验证",
    desc: "--batch-mtp：开并发时每个槽位每轮多验证一个 MTP 草稿（多行窗口一次过）。引擎要求同时有 --batch、--mtp（MTP 草稿模型）与 --spec；不能与 --batch-groups 同开；每槽额外占显存。改完要重启引擎才生效。",
    group: "parallel",
    order: 2,
    sort: 2,
    defaultEnabled: false,
  },
  {
    key: "batch-groups",
    flag: "--batch-groups",
    type: "INTEGER",
    uiType: "dropdown",
    default: "64",
    values: [
      { value: "0", label: "0（关闭）" },
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "8", label: "8" },
      { value: "64", label: "64（引擎默认）" },
    ],
    label: "并发分组",
    desc: "--batch-groups G：多卡分层（layer split）运行时把并发槽位分成 G 组流水线过 GPU。只在多卡分层时有意义，单卡不用开；引擎默认 64，0 = 关闭。需要先有 --batch。改完要重启引擎才生效。",
    group: "parallel",
    order: 3,
    sort: 3,
    defaultEnabled: false,
  },
  {
    key: "conversation-cache-mib",
    flag: "--conversation-cache-mib",
    type: "INTEGER",
    uiType: "dropdown",
    default: "1024",
    values: [
      { value: "0", label: "0（关闭）" },
      { value: "512", label: "512" },
      { value: "1024", label: "1024" },
      { value: "2048", label: "2048" },
      { value: "4096", label: "4096" },
    ],
    label: "会话缓存预算（MiB）",
    desc: "--serve：停放（park）会话占用的物理内存预算（MiB）。默认 0 表示关闭会话停放。停放后再次请求可直接恢复，省掉重新 prefill；预算用完时按先后顺序丢弃最旧的会话。改完要重启引擎才生效。",
    group: "parallel",
    order: 4,
    sort: 4,
    defaultEnabled: false,
  },
  {
    key: "conversation-cache-slots",
    flag: "--conversation-cache-slots",
    type: "INTEGER",
    uiType: "dropdown",
    default: "4",
    values: [
      { value: "1", label: "1" },
      { value: "2", label: "2" },
      { value: "4", label: "4（引擎默认）" },
      { value: "8", label: "8" },
      { value: "16", label: "16" },
    ],
    label: "会话缓存槽数",
    desc: "--serve：最多同时停放的会话数（默认 4）。每个停放会话的实际内存占用仍受「会话缓存预算」约束；槽数给得比预算能装下的多时，超出部分的会话会被丢弃。改完要重启引擎才生效。",
    group: "parallel",
    order: 5,
    sort: 5,
    defaultEnabled: false,
  },
  {
    key: "vram-reserve-mib",
    flag: "--vram-reserve-mib",
    type: "INTEGER",
    uiType: null,
    default: "700",
    values: [],
    label: "显存预留（MiB）",
    desc: "启动时给系统留出的显存。上游安装器会把它写回 config，这是官方认可的持久化通道；引擎自己在不传这个参数时的默认就是 700 MiB（0.1.41 实测），所以表单也按 700 起 —— 填 0 等于把它全让给专家缓存，引擎随后会报 `0 MiB of VRAM free … LOW` 并可能卡住。",
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
    label: "PCIe 专家比例",
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
    desc: "视觉投影模型（config 顶层 vision.mmproj）：让视觉编码器把图像嵌入成模型能读的向量，勾选「多模态（视觉）」后必填。保存时 GUI 会把 vision.exe 补成引擎组件目录里的 strata-vision.exe（`components\\engine\\<版本>-<平台>-<后端>`），把 vision.model 同步成启动参数里的 --model。",
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
  {
    // 哨兵 flag：config 顶层 sampling.temperature（不是 CLI flag）
    key: "sampling-temperature",
    flag: "--sampling-temperature",
    type: "FLOAT",
    uiType: null,
    default: "1.0",
    values: [],
    label: "温度",
    desc: "采样默认值（config 顶层 sampling.temperature）：请求自己没带 temperature 时用它，0 = greedy。请求自带的字段永远优先；整块 sampling 缺失时，不带采样字段的请求按 greedy 解码。上游只接受 ≥ 0 的数字，坏值会让服务器拒绝启动。清空 = 删掉该键（回引擎默认）。改完要重启引擎才生效。",
    group: "sampling",
    order: 1,
    sort: 1,
    defaultEnabled: false,
  },
  {
    // 哨兵 flag：config 顶层 sampling.top_p
    key: "sampling-top-p",
    flag: "--sampling-top-p",
    type: "FLOAT",
    uiType: null,
    default: "0.95",
    values: [],
    label: "top_p",
    desc: "核采样阈值（config 顶层 sampling.top_p）：只从前 top_p 概率质量里采样。上游只接受 0 < top_p ≤ 1，坏值会让服务器拒绝启动。请求自带的字段优先，清空 = 删掉该键。改完要重启引擎才生效。",
    group: "sampling",
    order: 2,
    sort: 2,
    defaultEnabled: false,
  },
  {
    // 哨兵 flag：config 顶层 sampling.top_k
    key: "sampling-top-k",
    flag: "--sampling-top-k",
    type: "INTEGER",
    uiType: null,
    default: "20",
    values: [],
    label: "top_k",
    desc: "每步只保留概率最高的 k 个候选（config 顶层 sampling.top_k）。上游只接受 1..64 的整数，超出范围会直接拒绝启动。与「加速与缓存」里的 --spec-min-p 无关（那个管推测解码的草稿阈值）。请求自带的字段优先，清空 = 删掉该键。改完要重启引擎才生效。",
    group: "sampling",
    order: 3,
    sort: 3,
    defaultEnabled: false,
  },
  {
    // 哨兵 flag：config 顶层 sampling.min_p
    key: "sampling-min-p",
    flag: "--sampling-min-p",
    type: "FLOAT",
    uiType: null,
    default: "0.0",
    values: [],
    label: "min_p",
    desc: "最小概率阈值（config 顶层 sampling.min_p）：相对最高概率低于该比例的候选直接丢掉，0 = 不启用。上游只接受 0 ≤ min_p ≤ 1，坏值会让服务器拒绝启动。请求自带的字段优先，清空 = 删掉该键。改完要重启引擎才生效。",
    group: "sampling",
    order: 4,
    sort: 4,
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

/**
 * 同义 flag：上游 `--slots N` 与 `--batch N` 是同一个开关（见 `strata --help`，
 * `--batch N / --slots N` 写在一行）。表单以 `--batch` 为规范写法，但读 config 时
 * 两种写法都要认 —— 否则 `--slots` 会作为「表单不认识的 flag」被原样留下，
 * 用户再勾选「并发槽位」就会写出两个开关。
 */
const FLAG_ALIASES: [alias: string, key: string][] = [["--slots", "batch"]];
for (const [alias, key] of FLAG_ALIASES) FLAG_TO_KEY.set(alias, key);

/** key → 该 key 在 args 里可能出现的所有写法（规范写法在前） */
const KEY_FLAGS = new Map<string, string[]>();
for (const [flag, key] of FLAG_TO_KEY) {
  KEY_FLAGS.set(key, [...(KEY_FLAGS.get(key) ?? []), flag]);
}

/** 路径的父目录（同时认 `\` 与 `/`）；没有分隔符时返回空串。 */
function parentDir(path: string): string {
  const at = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return at > 0 ? path.slice(0, at) : "";
}

/** 表单认识的 flag 集合（写回时的白名单，含同义写法） */
export const STRATA_KNOWN_FLAGS = new Set(FLAG_TO_KEY.keys());

/**
 * 顶层字段类参数：它们不是 CLI flag，值存在 config 顶层（`vision.*` / `open_browser` /
 * `sampling.*`），进 schema 只是为了复用 `ParamForm` 的分组渲染。**写回时绝不进 args** ——
 * 上游引擎不认识这些 flag，塞进去会让引擎启动失败。
 */
const TOP_LEVEL_KEYS = new Set([
  "vision-mmproj",
  "vision-gpu",
  "vision-max-tokens",
  "open-browser",
  "sampling-temperature",
  "sampling-top-p",
  "sampling-top-k",
  "sampling-min-p",
]);

/** 表单 key → config 顶层 `sampling` 里的键名，以及上游 `server.py` 的取值域 */
const SAMPLING_KEYS: {
  key: string;
  cfgKey: string;
  label: string;
  /** 整数型：写回时 Math.trunc */
  int?: boolean;
  /** 取值域的中文说法（直接进报错文案） */
  range: string;
  check: (n: number) => boolean;
}[] = [
  {
    key: "sampling-temperature",
    cfgKey: "temperature",
    label: "温度",
    range: "数字且 ≥ 0（0 = greedy）",
    check: (n) => n >= 0,
  },
  {
    key: "sampling-top-p",
    cfgKey: "top_p",
    label: "top_p",
    range: "0 < top_p ≤ 1",
    check: (n) => n > 0 && n <= 1,
  },
  {
    key: "sampling-top-k",
    cfgKey: "top_k",
    label: "top_k",
    int: true,
    range: "1..64 的整数",
    check: (n) => Number.isInteger(n) && n >= 1 && n <= 64,
  },
  {
    key: "sampling-min-p",
    cfgKey: "min_p",
    label: "min_p",
    range: "0 ≤ min_p ≤ 1",
    check: (n) => n >= 0 && n <= 1,
  },
];

/**
 * 采样值在参数表里的显示文本。
 *
 * config 里存的是 JSON 数字，`String(1.0)` 得到 `"1"`、`String(0)` 得到 `"0"` ——
 * 直接显示会让人以为小数点后的 0 被抹掉了。浮点键补足一位小数（1 → `1.0`、0 → `0.0`），
 * 整数键（top_k）按整数显示。**只影响显示**：写回时仍是 JSON 数字。
 */
function samplingText(s: (typeof SAMPLING_KEYS)[number], v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (s.int) return String(Math.trunc(n));
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

const PARAM_DEFAULT = new Map(strataParamSchema.params.map((p) => [p.key, p.default]));

/**
 * 采样默认值的保存前校验。
 *
 * 上游 `server.py::sampling_defaults_from_config` 对 `sampling` 块的坏值是**直接退出服务器**
 * （`expected a number >= 0 (0 = greedy)` / `the sampled path takes an integer 1..64`）,
 * 所以这里必须在写盘之前拦住 —— 否则用户能靠一个数字把引擎变成起不来的状态。
 *
 * 返回错误文案；`null` = 通过。清空不算错误：那是上游 WebUI 的「空字段 = 删掉该键、回默认」。
 */
export function validateStrataSampling(state: Record<string, ParamState>): string | null {
  for (const s of SAMPLING_KEYS) {
    const st = state[s.key];
    if (!st?.enabled) continue;
    const raw = st.value.trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || !s.check(n)) {
      return `采样参数「${s.label}」的取值 "${raw}" 不合法：上游要求 ${s.range}，否则 Strata 启动时会直接退出`;
    }
  }
  return null;
}

/** 并发组里的参数 key（依赖校验只针对这一组） */
const PARALLEL_KEYS = [
  "batch",
  "batch-mtp",
  "batch-groups",
  "conversation-cache-mib",
  "conversation-cache-slots",
];

function hasArgFlag(args: unknown[], flag: string): boolean {
  return args.some((token) => typeof token === "string" && token === flag);
}

/**
 * 并发类参数的「能不能开」检查（用户 m03848）。
 *
 * 规则全部来自 `strata.exe --help`（0.1.46）与 `control/serve/server.py`：
 * - `--batch-mtp` 需要 `--batch` + `--mtp` + `--spec`，且不能与 `--batch-groups` 同开
 * - `--batch-groups` 需要 `--batch`（只在多卡分层时有意义）
 * - `--batch` 取值 2..8（引擎批次窗口最多 8 行；`--batch-mtp` 靠多行窗口一次过更多）
 * - `--conversation-cache-slots` 需要会话缓存预算 > 0，否则引擎关闭会话停放、槽数不生效
 *
 * 返回错误文案；`null` = 可以开启。关闭操作永远放行（调用方只在 enabled=true 时问）。
 */
export function checkStrataParamEnable(
  key: string,
  state: Record<string, ParamState>,
  args: unknown[],
): string | null {
  const on = (k: string) => !!state[k]?.enabled;
  const value = (k: string) => (state[k]?.value ?? "").trim();
  // `--mtp` 是安装事实类参数（不在表单 schema 里），只能从 args 判断
  const hasMtp = hasArgFlag(args, "--mtp");

  if (key === "batch") {
    const raw = value("batch");
    const n = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 2 || n > 8) {
      return `「并发槽位」的取值 "${raw || "空"}" 不合法：引擎要求 2..8（批次窗口最多 8 行）`;
    }
    return null;
  }

  if (key === "batch-mtp") {
    if (!on("batch")) {
      return "「MTP 并发验证」不能单独开：引擎要求同时有 --batch，请先勾「并发槽位」";
    }
    if (!hasMtp) {
      return "「MTP 并发验证」需要 --mtp：当前 config 没有 MTP 草稿模型，引擎要求 --batch-mtp 与 --mtp、--spec 同时存在";
    }
    if (!on("spec")) {
      return "「MTP 并发验证」需要 --spec：请先在「加速与缓存」里勾「推测解码」";
    }
    if (on("batch-groups")) {
      return "「MTP 并发验证」与「并发分组」不能同时开：引擎不支持两者共用";
    }
    return null;
  }

  if (key === "batch-groups") {
    if (!on("batch")) {
      return "「并发分组」需要先有 --batch：请先勾「并发槽位」，引擎只在并发批次里分组流水线";
    }
    if (on("batch-mtp")) {
      return "「并发分组」与「MTP 并发验证」不能同时开：引擎不支持两者共用";
    }
    return null;
  }

  if (key === "conversation-cache-slots") {
    if (!on("conversation-cache-mib") || value("conversation-cache-mib") === "0") {
      return "「会话缓存槽数」需要先把「会话缓存预算」开到大于 0：预算为 0 或未开时引擎关闭会话停放，槽数不会生效";
    }
    return null;
  }

  return null;
}

/** 写盘前的整组校验：把已启用的并发参数逐个过一遍 `checkStrataParamEnable` */
export function validateStrataParams(
  state: Record<string, ParamState>,
  args: unknown[],
): string | null {
  for (const key of PARALLEL_KEYS) {
    if (!state[key]?.enabled) continue;
    const error = checkStrataParamEnable(key, state, args);
    if (error) return error;
  }
  // --host-core 只认引擎列的这三个值，手输别的值会让引擎启动失败
  const hostCore = state["host-core"];
  if (hostCore?.enabled) {
    const v = hostCore.value.trim();
    if (v !== "first" && v !== "last" && v !== "sibling") {
      return `宿主线程核只能是 first、last 或 sibling（现在是「${v || "空"}」）。`;
    }
  }
  return null;
}

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
    // 走 env 块的参数不在 args 里，由 configToState 从 `env` 读
    if (def.env) {
      state[def.key] = { enabled: false, value: def.default };
      continue;
    }
    // 同义写法（--slots = --batch）都算「这个参数在 args 里出现过」
    const at = args.findIndex(
      (t) => typeof t === "string" && FLAG_TO_KEY.get(t) === def.key,
    );
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
    if (!entry?.enabled) {
      // 取消勾选要连它的值 token 一起删：`--kv-resident 32768` 只删 flag 会留下裸的
      // `32768`，引擎按「未知参数」直接启动失败（与 argsToState 的取值判据保持一致）。
      const next = args[i + 1];
      if (!FLAG_ONLY.has(key) && next != null && !isFlagToken(String(next))) i += 1;
      continue;
    }
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
    if (def.env) continue; // env 变量写 config 的 env 块，见 stateToConfig
    // 保留原 args 里的写法（--slots 仍是 --slots，顺序也不动）；只有完全没有时
    // 才追加规范写法 --batch。
    if (KEY_FLAGS.get(def.key)?.some((flag) => args.includes(flag))) continue;
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
 * config → 表单状态：args 走 `argsToState`，再灌入顶层字段（`vision.*` / `open_browser` / `sampling.*`）。
 *
 * 弹窗展示的是「这个 config 的完整启动配置」，顶层字段与 args 一样是启动事实。
 */
export function configToState(cfg: Record<string, unknown>): Record<string, ParamState> {
  const state = argsToState(Array.isArray(cfg.args) ? (cfg.args as unknown[]) : []);
  // env 块：只有表单认识的变量（`ParamDef.env`）进状态，其余键由 stateToConfig 原样保留
  const env =
    cfg.env && typeof cfg.env === "object" ? (cfg.env as Record<string, unknown>) : undefined;
  for (const def of strataParamSchema.params) {
    if (!def.env) continue;
    const v = env?.[def.env];
    state[def.key] = {
      enabled: v != null && String(v).trim() !== "",
      value: def.default,
    };
  }
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
  // 采样默认值：整块缺省 = 没写；某个键缺省 = 未启用，界面显示 schema 里的默认值当占位
  const sampling =
    cfg.sampling && typeof cfg.sampling === "object"
      ? (cfg.sampling as Record<string, unknown>)
      : undefined;
  for (const s of SAMPLING_KEYS) {
    const v = sampling?.[s.cfgKey];
    state[s.key] = {
      enabled: v != null,
      value: v != null ? samplingText(s, v) : (PARAM_DEFAULT.get(s.key) ?? ""),
    };
  }
  return state;
}

/**
 * 表单状态 → 整个 config。
 *
 * args 走 `stateToArgs`（只动认识的 flag、保顺序、顶层字段永不进 args）；
 * 顶层只写表单认识的键 —— `vision.mmproj` / `vision.model` / `vision.exe` /
 * `vision.gpu` / `vision.max_tokens` / `open_browser` / `sampling.{temperature,top_p,top_k,min_p}`，
 * 其余键原样保留（`sampling` 块里 GUI 不认识的键也不动）。
 *
 * `vision.model` 是主模型，不由用户在这里选：GUI 从启动参数里的 `--model` 同步过来
 * （上游 `server.py` 把 exe/mmproj/model 三键都当必需键）。
 *
 * `engineExe` = 后端解析出的**真实引擎可执行文件**
 * （官方布局 `<根>\components\engine\<版本>-<平台>-<后端>\strata.exe`）。
 *
 * **`exe` 只在原值是绝对路径时才跟着 engineExe 走**：原值是 `component:strata-engine`
 * 引用时保持引用（设置页「自动使用最新版本」就是它，展开成绝对路径会让引擎升级换代后
 * 指向已删掉的旧版本目录）。`vision.exe` 则必须写真实路径，用 engineExe 的父目录拼。
 */
export function stateToConfig(
  cfg: Record<string, unknown>,
  state: Record<string, ParamState>,
  engineExe?: string | null,
): Record<string, unknown> {
  const args = Array.isArray(cfg.args) ? (cfg.args as unknown[]) : [];
  const next: Record<string, unknown> = { ...cfg, args: stateToArgs(args, state) };
  if (engineExe) {
    const prevExe = typeof cfg.exe === "string" ? cfg.exe : "";
    // 引用形态（`component:strata-engine`）保持不动；绝对路径才同步成当前解析结果
    if (!prevExe.startsWith("component:")) next.exe = engineExe;
  }

  // 采样默认值：写回 config 顶层 sampling 块。GUI 不认识的键原样保留
  // （上游 0.1.39+ 往里放过实验开关键，例如 experimental_speed_projection）；
  // 四个已知键按表单勾选增删 —— 未勾选或清空 = 删掉该键（上游 WebUI 的「空 = 回默认」）。
  const prevSampling =
    cfg.sampling && typeof cfg.sampling === "object"
      ? { ...(cfg.sampling as Record<string, unknown>) }
      : {};
  const sampling: Record<string, unknown> = { ...prevSampling };
  for (const s of SAMPLING_KEYS) {
    const st = state[s.key];
    const raw = st?.enabled ? st.value.trim() : "";
    const n = raw === "" ? NaN : Number(raw);
    // 坏值由 validateStrataSampling 在保存前拦下，这里只保证不写出坏值
    if (raw !== "" && Number.isFinite(n) && s.check(n)) {
      sampling[s.cfgKey] = s.int ? Math.trunc(n) : n;
    } else {
      delete sampling[s.cfgKey];
    }
  }
  if (Object.keys(sampling).length > 0) next.sampling = sampling;
  else delete next.sampling;

  const prevVision =
    cfg.vision && typeof cfg.vision === "object"
      ? { ...(cfg.vision as Record<string, unknown>) }
      : undefined;
  // 「多模态（视觉）」勾选 = args 里带 --vision
  const visionOn = !!state["vision"]?.enabled;
  const mmproj = (state["vision-mmproj"]?.value || "").trim();
  // vision.model 是主模型：从启动参数里的模型路径同步，用户不在这里选。
  // Strata 的 config 把主模型写成 `--native <gguf>`（另有一份 `--ple-gguf` 同路径），
  // 老版本/llama.cpp 风格的才是 `--model` —— 两个都认，`--native` 优先。
  const argList = next.args as unknown[];
  const firstArgAfter = (flag: string): string => {
    const i = argList.indexOf(flag);
    return i >= 0 && i + 1 < argList.length ? String(argList[i + 1]) : "";
  };
  const mainModel = firstArgAfter("--native") || firstArgAfter("--model") || "";
  if (visionOn || prevVision) {
    const v: Record<string, unknown> = prevVision ?? {};
    if (mmproj) v.mmproj = mmproj;
    // 三键（exe / mmproj / model）是上游 server.py 的必需键：拿不到新值就保留原值
    if (mainModel) v.model = mainModel;
    // vision.exe 必须指向这一次安装的引擎组件（官方布局是 `components\engine\<版本>-…`）。
    // 旧版 config 里可能是已不存在的 `<安装目录>\engine\strata-vision.exe`，
    // 所以只要拿到引擎路径就覆盖，而不是「没有才补」。
    const engineDir = engineExe ? parentDir(engineExe) : "";
    if (engineDir) {
      const sep = engineDir.includes("\\") ? "\\" : "/";
      v.exe = `${engineDir}${sep}strata-vision.exe`;
    }
    // 拿不到引擎 exe 时不猜路径：官方布局的组件目录带 `<版本>-<平台>-<后端>` 后缀，
    // 拼出来的 `…\components\engine\strata-vision.exe` 一定不存在，写进去只会让视觉启动失败。
    // 值与 vision.gpu 一致：value 是权威（ParamForm 的 LOGIC 控件以 value 为准）
    const gpu = (state["vision-gpu"]?.value ?? "true") !== "false";
    v.gpu = gpu;
    // CPU 解码（gpu = false）时上游还写 `threads`：视觉编码器的线程数，
    // `setup.py` 的 vision_threads() = max(1, min(逻辑线程数 // 2, 16))（VISION_THREADS_CAP = 16）。
    // GPU 解码不写这个键（上游只有 `--vision cpu` 分支才写），所以切到 GPU 时删掉。
    if (gpu) {
      delete v.threads;
    } else {
      const prev = Number(v.threads);
      v.threads = Number.isFinite(prev) && prev > 0 ? Math.trunc(prev) : visionThreads();
    }
    const mt = state["vision-max-tokens"];
    const n = mt?.enabled ? Number(mt.value) : NaN;
    if (Number.isFinite(n) && n > 0) v.max_tokens = Math.trunc(n);
    else delete v.max_tokens;
    next.vision = v;
  }

  if (state["open-browser"]?.enabled) next.open_browser = true;
  else if ("open_browser" in cfg) next.open_browser = false;

  // env 块：勾选的写 "1"，取消的删掉；GUI 不认识的其他变量原样保留
  const prevEnv =
    cfg.env && typeof cfg.env === "object" ? { ...(cfg.env as Record<string, unknown>) } : {};
  const env: Record<string, unknown> = { ...prevEnv };
  for (const def of strataParamSchema.params) {
    if (!def.env) continue;
    if (state[def.key]?.enabled) env[def.env] = "1";
    else delete env[def.env];
  }
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}
