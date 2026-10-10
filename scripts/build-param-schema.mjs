/**
 * 从 llama.cpp-hub 的部署目录抽取参数表单 schema。
 *
 * 输入（默认取本机 hub 部署目录，可用 --hub 覆盖）：
 *   <hub>/classes/server-params.json     模型启动参数（类型/默认值/取值域/分组/排序）
 *   <hub>/classes/web/i18n/zh-CN.json    中文名与详细说明（param.* 键）
 *
 * 输出：
 *   src/assets/params.json        模型配置弹窗用
 *
 * 用法：node scripts/build-param-schema.mjs [--hub E:\AI\llama.cpp-hub]
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const hubArg = args.indexOf("--hub");
const HUB = hubArg >= 0 ? args[hubArg + 1] : "E:\\AI\\llama.cpp-hub";

/** router 掌管的键写进 preset 会被移除或覆盖；--mlock 已被 --load-mode 取代。
 *  注意 `--no-webui` **不在**排除之列：它是"每个模型是否自带界面"的开关，
 *  router 模式下 router 自己的界面能列出全部模型，所以子实例可以各关各的（实测
 *  段里写 `no-webui = 1` 或 `webui = 0` 都会让该子实例带上 `--no-webui`）。 */
const EXCLUDE = new Set(["--port", "--model", "--mlock", "--host", "--api-key", "--alias", "--hf-repo"]);

const src = path.join(HUB, "classes", "server-params.json");
const i18nPath = path.join(HUB, "classes", "web", "i18n", "zh-CN.json");
for (const p of [src, i18nPath]) {
  if (!fs.existsSync(p)) {
    console.error(`缺少输入文件: ${p}`);
    process.exit(1);
  }
}

const params = JSON.parse(fs.readFileSync(src, "utf8"));
const i18n = JSON.parse(fs.readFileSync(i18nPath, "utf8"));

/**
 * `param.server.ctx_size.name` 形式：fullName 去掉 -- 并把 - 换成 _。
 *
 * 只作兜底 —— 少数参数的 i18n 前缀与 fullName 对不上（实测 3 个：
 * `--top-nsigma` → `top_n_sigma`、`--gpu-layers` → `ngl`、
 * `--checkpoint-min-step` → `checkpoint_every_nt`），直接用 fullName 重构
 * 会取不到中文名而回退显示 `--flag`，界面上就和 hub 不一致了。
 * 权威来源是参数自带的 `name` / `description` 字段（它们本身就是 i18n key）。
 */
function i18nStem(fullName) {
  return `param.server.${fullName.replace(/^--?/, "").replace(/-/g, "_")}`;
}

function lookup(key) {
  if (!key) return undefined;
  return Object.prototype.hasOwnProperty.call(i18n, key) ? i18n[key] : undefined;
}

/** 先按参数自带的 key 取，取不到再用 fullName 重构的 key 兜底。 */
function resolveText(ownKey, stem, suffix) {
  return lookup(ownKey) ?? lookup(`${stem}.${suffix}`);
}

/**
 * 归一化 `values`。
 *
 * 实测 hub 里存在两种形状：多数是字符串数组，个别（--samplers / --spec-type）是
 * `{ value, label }` 对象数组，且 label 可能是 i18n key。统一成 `{ value, label }`，
 * 否则前端会把对象直接渲染成 React child 而抛错。
 */
function normalizeValues(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    let value;
    let label;
    if (typeof item === "string") {
      value = item;
      label = item;
    } else if (item && typeof item === "object") {
      value = String(item.value ?? "");
      const rawLabel = String(item.label ?? "");
      label = rawLabel.startsWith("param.") || rawLabel.startsWith("page.")
        ? (i18n[rawLabel] ?? value)
        : (rawLabel || value);
    } else {
      continue;
    }
    if (!value) continue;
    out.push({ value, label });
  }
  return out;
}

const groups = new Map();
const out = [];
let missingLabel = 0;
let missingDesc = 0;

/** 把一份参数表（模型启动参数）转成前端 schema。 */
function buildSchema(list, exclude) {
  const groups = new Map();
  const items = [];
  let missLabel = 0;
  let missDesc = 0;

  for (const p of list) {
    if (exclude.has(p.fullName)) continue;
    const stem = i18nStem(p.fullName);
    // hub 的 renderParamField 用 `t(param.name, param.fullName || param.abbreviation)`：
    // 优先参数自带的 name key，缺失才回退到命令行名
    const label = resolveText(p.name, stem, "name") ?? p.fullName;
    const desc = resolveText(p.description, stem, "desc") ?? "";
    if (label === p.fullName) missLabel += 1;
    if (!desc) missDesc += 1;

    const groupId = p.group ?? "page.params.group.basic";
    if (!groups.has(groupId)) {
      groups.set(groupId, {
        id: groupId,
        label: i18n[groupId] ?? groupId,
        order: p.groupOrder ?? 999,
        collapsed: Boolean(p.groupCollapsed),
      });
    }

    items.push({
      /** preset 文件中的键名（= fullName 去掉前导 --） */
      key: p.fullName.replace(/^--?/, ""),
      flag: p.fullName,
      abbr: p.abbreviation ?? "",
      type: p.type,
      /** "ordered-multiselect" 表示该参数是**有序**多值（如 --samplers 的采样器链） */
      uiType: p.uiType ?? null,
      /** 多值分隔符（ordered-multiselect 专用） */
      delimiter: p.delimiter ?? null,
      /** 该键不单独写入 preset，而是并入 mergeInto 指向的键（逗号多值），见 ParamForm */
      ...(p.mergeInto ? { mergeInto: p.mergeInto, mergeValue: p.mergeValue } : {}),
      default: p.defaultValue ?? "",
      values: normalizeValues(p.values),
      label,
      desc,
      group: groupId,
      order: p.groupOrder ?? 999,
      sort: p.sort ?? 0,
      defaultEnabled: Boolean(p.defaultEnabled),
    });
  }

  items.sort((a, b) => a.order - b.order || a.sort - b.sort);
  const groupList = [...groups.values()].sort((a, b) => a.order - b.order);
  return { items, groupList, missLabel, missDesc };
}

function writeSchema(target, source, note, { items, groupList, missLabel, missDesc }) {
  const schema = {
    source,
    generatedAt: new Date().toISOString().slice(0, 10),
    note,
    groups: groupList,
    params: items,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

  const byType = items.reduce((acc, p) => ((acc[p.type] = (acc[p.type] ?? 0) + 1), acc), {});
  console.log(`已生成 ${target}`);
  console.log(`  参数: ${items.length}`);
  console.log(`  分组: ${groupList.length} -> ${groupList.map((g) => g.label).join(" / ")}`);
  console.log(`  类型: ${JSON.stringify(byType)}`);
  console.log(`  有取值域: ${items.filter((p) => p.values.length).length}`);
  console.log(`  缺中文名: ${missLabel}，缺说明: ${missDesc}`);
  console.log(`  文件大小: ${(fs.statSync(target).size / 1024).toFixed(1)} KB`);
}

// ---- 模型启动参数 ----
// hub 把「ngram-mod / ngram-map-k4v 投机解码」放在**各自的分组里当开关**，flag 写作
// `--spec-type_ngram-mod`。那不是 llama.cpp 的参数名（真参数是 `--spec-type`），
// 照搬会让 preset 里出现 `spec-type_ngram-mod = true`，llama-server 读 preset 时报
// "option not recognized"、`/models?reload=1` 返回 500。
//
// 而 `--spec-type` 是**逗号多值**参数（llama.cpp 内部 `string_split(value, ',')`，
// 压成位掩码、推测实现是数组），ngram 类必须能与草稿类型共存；多个草稿类型本身互斥
//（hub 的参数说明：草稿模型类型互斥，可配合 ngram-mod/ngram-map-k4v 使用）。
//
// 因此保持 hub 的界面形态：`--spec-type` 只列草稿类型（单选），两个 ngram 各自留在
// 自己分组里当开关；两者在**保存/读取时**合并与还原（见 ParamForm 的
// initParamState / paramStateToEntries），这两个键永远不会写进 preset。
const SPEC_TYPE_MERGE = { "--spec-type_ngram-mod": "ngram-mod", "--spec-type_ngram-map-k4v": "ngram-map-k4v" };
for (const p of params) {
  if (p.fullName === "--spec-type") {
    // 单选：只保留 none 与草稿类型（ngram 由各自的开关负责）
    const raw = Array.isArray(p.values) ? p.values : [];
    p.values = raw.filter((v) =>
      typeof v === "string" ? v === "none" || v.startsWith("draft-") : v?.value === "none" || v?.value?.startsWith("draft-"),
    );
    continue;
  }
  const merged = SPEC_TYPE_MERGE[p.fullName];
  if (merged) {
    // 界面仍是开关，但不作为独立键写入，而是并进 --spec-type 的逗号列表
    p.mergeInto = "spec-type";
    p.mergeValue = merged;
  }
}

const server = buildSchema(params, EXCLUDE);

// `--no-webui` 看着像"省一点静态资源"，但在 router 模式下它被 llama.cpp 的 WebUI
// 当成"这个模型不可聊天"的判据：WebUI 的聊天选择器是
//   getVisibleModels() = models.filter(m => props(m).ui !== false)
// 而 props.ui 就是子实例的 webui 开关。关掉后：模型管理列表里还在（那份数据不走这个过滤），
// 聊天页的模型选择器里却会消失，卡片上的「聊天」按钮也不可用。
// hub 有自己的聊天页，所以它默认关掉没影响；我们是直接用 llama.cpp 的界面，必须提醒。
for (const p of server.items) {
  if (p.key !== "no-webui") continue;
  p.desc = `${p.desc}\n\n⚠ 在 router 模式下不建议关闭：llama.cpp 自带界面用子实例的 props.ui 判断"能不能聊"，关掉后该模型会从聊天页的模型选择器里消失（模型管理列表里仍在），本应用的「开始聊天」按钮也会置灰。`;
}
missingLabel = server.missLabel;
missingDesc = server.missDesc;
out.push(...server.items);
console.log(`[模型启动参数] 源 ${params.length}，排除 ${params.length - server.items.length}`);
writeSchema(
  path.resolve("src/assets/params.json"),
  "llama.cpp-hub/classes/server-params.json + i18n/zh-CN.json",
  "router 掌管的键（port/host/api-key/alias/hf-repo）与已废弃的 mlock 已排除",
  server,
);

const groupList = server.groupList;
