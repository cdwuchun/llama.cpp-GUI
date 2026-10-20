import { useState } from "react";
import { ContextBenchPanel } from "./ContextBenchPanel";
import { ScenarioBenchPanel } from "./ScenarioBenchPanel";

/** 性能测试的两个标签（照模型列表页的 `.st-tabs` 实现，用户 m02216） */
type BenchTab = "context" | "scenario";

const BENCH_LABELS: Record<BenchTab, string> = {
  context: "上下文挡位",
  scenario: "场景测试",
};

/**
 * 性能测试页。
 *
 * 原来的「速度测试」已按用户 m10993 的要求删掉，后端的速度测试命令
 * （`bench_server` / `bench_strata` / `bench_records*`）暂时留着没删。
 * 现在两个内容都留着（上下文档位 + 场景测试），所以顶部用标签切换，和模型列表页一致。
 * 标签状态不持久化：和模型列表一样，切页面回来回到第一个。
 */
export function BenchPanel() {
  const [tab, setTab] = useState<BenchTab>("context");
  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">性能测试</h1>
        {/* 标签紧贴标题右侧（app.css 的 `.top-bar > .st-tabs` 用 margin-right:auto 推过来），
            放进 .top-actions 会被 space-between 顶到最右边（用户 m02461） */}
        <div className="st-tabs" role="tablist" aria-label="性能测试内容">
          {(Object.keys(BENCH_LABELS) as BenchTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`st-tab${tab === key ? " is-active" : ""}`}
              onClick={() => setTab(key)}
            >
              {BENCH_LABELS[key]}
            </button>
          ))}
        </div>
      </div>
      {tab === "context" ? <ContextBenchPanel /> : <ScenarioBenchPanel />}
    </main>
  );
}
