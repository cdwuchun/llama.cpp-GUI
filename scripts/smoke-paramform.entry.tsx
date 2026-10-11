/**
 * 渲染冒烟测试的入口（由 scripts/smoke-paramform.mjs 打包后执行）。
 *
 * 只做一件事：用真实 React 把参数表单渲染成静态标记，任何抛错都会让进程非零退出。
 */

import { renderToStaticMarkup } from "react-dom/server";

import { ParamForm } from "../src/components/ParamForm";
// 这几个是 schema 与状态换算的函数，按仓库铁律 7 放在 src/utils/ 下
// （组件文件只导出组件，否则 Fast Refresh 失效）—— 别再从 ParamForm 里导入它们。
import {
  initParamState,
  paramSchema,
  paramSchemaReady,
  paramStateToEntries,
} from "../src/utils/paramSchema";
import {
  configToState,
  stateToConfig,
  strataParamSchema,
  validateStrataSampling,
} from "../src/utils/strataParams";

function render(label: string, current: Record<string, string>): void {
  const state = initParamState(current);
  const html = renderToStaticMarkup(<ParamForm state={state} onChange={() => {}} />);
  if (html.length < 100) {
    throw new Error(`${label}: 渲染结果过短（${html.length}），可能未渲染任何参数`);
  }
  console.log(`  ${label}: OK（${html.length} 字符）`);
}

console.log("参数 schema:");
console.log(`  参数数=${paramSchema.params.length} 分组数=${paramSchema.groups.length} 可用=${paramSchemaReady}`);

const withOptions = paramSchema.params.filter((p) => p.values.length > 0);
console.log(`  含取值域的参数量=${withOptions.length}`);
for (const p of withOptions.slice(0, 5)) {
  const first = p.values[0];
  if (typeof first?.value !== "string" || typeof first?.label !== "string") {
    throw new Error(`${p.key}: 取值域元素不是 {value,label} 字符串对: ${JSON.stringify(first)}`);
  }
}

console.log("渲染测试:");
render("空状态", {});
render("含取值域参数已启用", {
  samplers: "penalties;dry",
  "spec-type": "draft-mtp",
  "load-mode": "mmap+mlock",
  "ctx-size": "8192",
  "flash-attn": "on",
});

// 表单状态 → preset 键值对：启用项写值，未启用项写空串（后端会删除该键）
const entries = paramStateToEntries(initParamState({ "ctx-size": "4096" }));
const ctx = entries.find(([k]) => k === "ctx-size");
const others = entries.filter(([k, v]) => k !== "ctx-size" && v === "");
if (ctx?.[1] !== "4096") throw new Error(`ctx-size 未按预期回填: ${JSON.stringify(ctx)}`);
console.log(`  表单→preset: 启用 1 项，其余 ${others.length} 项为空（将被删除）`);

/**
 * Strata 参数表（第二运行时通道）：顶层字段的读写往返。
 *
 * 这里盯的是三件容易写坏的事：哨兵 flag 绝不能混进 `args`（引擎不认识就起不来）、
 * `sampling` 块里 GUI 不认识的键要原样保留、坏值必须在写盘前被拦下
 * （上游 `server.py` 遇到坏值直接退出服务器）。
 */
console.log("Strata 参数表:");
{
  const cfg = {
    exe: "E:\\AI\\Strata\\engine\\strata.exe",
    args: ["--model", "m.gguf", "--max-context", "204800"],
    sampling: {
      temperature: 1.0,
      top_p: 0.95,
      top_k: 20,
      min_p: 0,
      experimental_speed_projection: false,
    },
  };
  const state = configToState(cfg);
  const html = renderToStaticMarkup(
    <ParamForm state={state} onChange={() => {}} schema={strataParamSchema} />,
  );
  for (const label of ["采样", "温度", "top_p", "top_k", "min_p"]) {
    if (!html.includes(label)) throw new Error(`strata 参数表未渲染「${label}」`);
  }
  if (state["sampling-top-k"]?.value !== "20") {
    throw new Error(`top_k 未回填: ${JSON.stringify(state["sampling-top-k"])}`);
  }
  // JSON 数字会丢掉小数点后的 0（1.0 → 1、0 → 0），参数表必须补回来，否则用户以为精度被改了
  if (state["sampling-temperature"]?.value !== "1.0" || state["sampling-top-p"]?.value !== "0.95") {
    throw new Error(
      `浮点采样值应保留小数点: ${JSON.stringify([
        state["sampling-temperature"],
        state["sampling-top-p"],
      ])}`,
    );
  }
  if (!state["sampling-min-p"]?.enabled || state["sampling-min-p"]?.value !== "0.0") {
    throw new Error(
      `min_p=0 是有效值，应视为已启用并显示为 0.0: ${JSON.stringify(state["sampling-min-p"])}`,
    );
  }
  // 参数表里真正显示出来的文本（input 的 value 属性，SSR 会写进 HTML）
  for (const shown of ['value="1.0"', 'value="0.95"', 'value="0.0"']) {
    if (!html.includes(shown)) throw new Error(`参数表里没有显示出 ${shown}`);
  }

  const nextState = {
    ...state,
    "sampling-temperature": { enabled: true, value: "0.3" },
    "sampling-top-p": { enabled: true, value: "0.5" },
    "sampling-top-k": { enabled: false, value: "20" },
  };
  const next = stateToConfig(cfg, nextState);
  const sampling = next.sampling as Record<string, unknown>;
  if (sampling.temperature !== 0.3 || sampling.top_p !== 0.5) {
    throw new Error(`采样写回不对: ${JSON.stringify(sampling)}`);
  }
  if ("top_k" in sampling) throw new Error("取消勾选后 top_k 应被删掉");
  if (sampling.min_p !== 0) throw new Error(`min_p 应保持数字 0: ${JSON.stringify(sampling.min_p)}`);
  if (sampling.experimental_speed_projection !== false) {
    throw new Error("sampling 块里 GUI 不认识的键应原样保留");
  }
  const args = next.args as unknown[];
  if (args.some((t) => String(t).startsWith("--sampling"))) {
    throw new Error(`采样哨兵 flag 混进了 args: ${JSON.stringify(args)}`);
  }
  if (args.join(" ") !== cfg.args.join(" ")) throw new Error("args 不应被采样参数改动");

  // 坏值必须在写盘前拦住，否则用户能靠一个数字把引擎变成起不来的状态
  const badK = validateStrataSampling({ ...state, "sampling-top-k": { enabled: true, value: "100" } });
  if (!badK) throw new Error("top_k=100 应被拦下");
  const badP = validateStrataSampling({ ...state, "sampling-top-p": { enabled: true, value: "1.5" } });
  if (!badP) throw new Error("top_p=1.5 应被拦下");
  const empty = validateStrataSampling({ ...state, "sampling-top-p": { enabled: true, value: "" } });
  if (empty) throw new Error(`清空应该是合法的（= 删掉该键、回默认）: ${empty}`);
  console.log(`  采样往返 OK（坏值拦截: ${badK.slice(0, 24)}…）`);
}

console.log("全部通过 ✅");
