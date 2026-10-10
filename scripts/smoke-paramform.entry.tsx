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

console.log("全部通过 ✅");
