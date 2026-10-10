/**
 * 参数表 schema 与表单状态换算（由 `scripts/build-param-schema.mjs` 从 llama.cpp-hub 抽取）。
 *
 * 纯数据 + 纯函数，不含组件：React Fast Refresh 要求一个模块要么只导出组件、
 * 要么不导出组件，混在一起会让热更新退化成整页刷新。
 */

import rawParams from "../assets/params.json";
import { reportFrontendError } from "./frontendLog";

export interface ParamOption {
  value: string;
  label: string;
}

export interface ParamDef {
  /** preset 文件中的键名 */
  key: string;
  flag: string;
  abbr: string;
  type: "INTEGER" | "FLOAT" | "STRING" | "LOGIC" | "JSON" | string;
  /**
   * 控件形态：`"ordered-multiselect"` = 有序多值（如 `--samplers` 的采样器链）；
   * `"dropdown"` = 常用档位下拉 + 可手输（如 `--ctx-size` 的上下文长度）。
   */
  uiType: string | null;
  /** 有序多值的分隔符 */
  delimiter: string | null;
  /**
   * 该键不单独写入 preset，而是并进 `mergeInto` 指向的键（逗号多值）。
   *
   * 用于 hub 那种"把某个多值参数的一个取值做成开关"的参数：
   * `--spec-type_ngram-mod` 其实不是 llama.cpp 的参数，它表达的是
   * `--spec-type` 列表里多出一个 `ngram-mod`（llama.cpp 的 preset 是 map，
   * 重复键只会保留一个，所以必须合并成逗号列表）。界面保持 hub 的形态
   * （开关留在各自分组里），合并与还原只在读写时做。
   */
  mergeInto?: string;
  /** 合并进目标键时使用的取值 */
  mergeValue?: string;
  default: string;
  values: ParamOption[];
  label: string;
  desc: string;
  group: string;
  order: number;
  sort: number;
  defaultEnabled: boolean;
}

export interface ParamGroupDef {
  id: string;
  label: string;
  order: number;
  collapsed: boolean;
}

export interface ParamSchema {
  groups: ParamGroupDef[];
  params: ParamDef[];
}

/** 单个参数的编辑状态 */
export interface ParamState {
  enabled: boolean;
  value: string;
}

const splitList = (value: string) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** 目标键 → 负责合并进它的那些开关 */
function mergeMap(): Map<string, ParamDef[]> {
  const map = new Map<string, ParamDef[]>();
  for (const p of paramSchema.params) {
    if (!p.mergeInto) continue;
    map.set(p.mergeInto, [...(map.get(p.mergeInto) ?? []), p]);
  }
  return map;
}

/**
 * 运行时归一化取值域。
 *
 * 即使拿到旧格式（字符串数组、或 `{value,label}` 对象数组混用），也统一成
 * `{value,label}`——否则 `<option>{v}</option>` 会尝试渲染对象而抛错，
 * 进而让整棵 React 树卸载（表现为白屏且按钮全部失效）。
 */
function normalizeOptions(raw: unknown): ParamOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ParamOption[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item) out.push({ value: item, label: item });
    } else if (item && typeof item === "object") {
      const obj = item as { value?: unknown; label?: unknown };
      const value = String(obj.value ?? "");
      if (value) {
        const label = String(obj.label ?? "");
        out.push({ value, label: label || value });
      }
    }
  }
  return out;
}

/**
 * 归一化参数定义。
 *
 * 防御性处理：若 JSON 模块被包装成 `{ default: ... }` 或结构不符，直接返回空 schema，
 * 让界面显示"参数定义缺失"而不是 `for...of undefined` 抛错把整窗打白。
 */
function normalizeSchema(input: unknown): ParamSchema {
  const candidate = (input as { default?: unknown } | null)?.default ?? input;
  const obj = candidate as Partial<ParamSchema> | undefined;
  if (!obj || !Array.isArray(obj.params) || !Array.isArray(obj.groups)) {
    const keys = obj ? Object.keys(obj).slice(0, 8).join(",") : String(obj);
    reportFrontendError("schema", `参数定义形状异常，keys=[${keys}]`);
    return { groups: [], params: [] };
  }
  const params = obj.params.map((p) => ({ ...p, values: normalizeOptions(p.values) }));
  return { groups: obj.groups, params };
}

/** 参数表单 schema */
export const paramSchema: ParamSchema = normalizeSchema(rawParams);

/** schema 是否可用（为 false 时界面给出提示而不是空白） */
export const paramSchemaReady = paramSchema.params.length > 0;

/** 把逻辑型参数的取值归一化为 `true` / `false`（hub 的默认值写作 0 / 1）。 */
export function boolText(raw: string): string {
  const s = raw.trim().toLowerCase();
  return ["1", "true", "on", "yes", "enabled"].includes(s) ? "true" : "false";
}

/**
 * 根据 preset 段现有内容初始化表单状态。
 *
 * 注意：这里**不**按 `defaultEnabled` 预勾选 —— preset 是"只写覆盖项"的机制，
 * 若把 `--gpu-layers -1` 之类的默认值全部写进去，反而会让 llama.cpp 的 `--fit`
 * 放弃自动分层（实测：显式设置 -ngl 会中止 fit 的层分配）。
 */
export function initParamState(current: Record<string, string>): Record<string, ParamState> {
  const state: Record<string, ParamState> = {};
  const merges = mergeMap();
  for (const p of paramSchema.params) {
    const existing = current[p.key];
    // 逻辑型参数的默认值在 hub 里写作 0 / 1，界面上统一显示 true / false
    const fallback = p.type === "LOGIC" ? boolText(p.default) : p.default;

    // 合并型开关（如 --spec-type_ngram-mod）：状态来自目标键的逗号列表
    if (p.mergeInto) {
      const owner = current[p.mergeInto];
      const on = splitList(owner ?? "").includes(p.mergeValue ?? "");
      state[p.key] = { enabled: on && owner !== undefined, value: "true" };
      continue;
    }

    // 目标键（如 --spec-type）：把自己那部分留下，被开关接管的取值摘出去
    let value = existing !== undefined ? existing : fallback;
    let enabled = existing !== undefined;
    const owned = merges.get(p.key);
    if (enabled && owned) {
      const taken = new Set(owned.map((m) => m.mergeValue ?? ""));
      const rest = splitList(existing ?? "").filter((v) => !taken.has(v));
      if (rest.length === 0) {
        // 列表里只剩被开关接管的取值：本参数视为未启用，交给开关表达
        enabled = false;
        value = fallback;
      } else {
        value = rest.join(",");
      }
    }
    state[p.key] = { enabled, value };
  }
  return state;
}

/** 表单状态 → preset 键值对（未启用的项以空值提交，后端会删除对应键） */
export function paramStateToEntries(state: Record<string, ParamState>): [string, string][] {
  const merges = mergeMap();
  const out: [string, string][] = [];
  for (const p of paramSchema.params) {
    // 合并型开关不单独占键，稍后并进目标键
    if (p.mergeInto) continue;
    const s = state[p.key];
    let value = !s || !s.enabled ? "" : p.type === "LOGIC" ? boolText(s.value) : s.value.trim();

    const owned = merges.get(p.key);
    if (owned) {
      const extra = owned
        .filter((m) => state[m.key]?.enabled)
        .map((m) => m.mergeValue ?? "")
        .filter(Boolean);
      if (extra.length) {
        // `none` 只是"不启用"的占位，和实际类型并列时要去掉
        const base = splitList(value).filter((v) => v !== "none");
        value = [...base, ...extra.filter((v) => !base.includes(v))].join(",");
      }
    }
    out.push([p.key, value]);
  }
  return out;
}
