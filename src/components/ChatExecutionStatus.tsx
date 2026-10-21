import { useEffect, useState } from "react";

import type { ChatExecution } from "../utils/chat";

/**
 * 一次请求的执行状态条（照上游 `ChatExecutionStatus.tsx`）。
 *
 * 只有状态、耗时、首正文三项 —— 用户 m07760 第 3 点要求去掉「请求标识」那组
 * 本地操作 id / 响应 id：llama.cpp 只回一个 `chatcmpl-…`，对账时也没处查。
 */
export function ChatExecutionStatus({
  execution,
  streaming,
}: {
  execution: ChatExecution;
  streaming: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  const labels: Record<ChatExecution["phase"], string> = {
    waiting: "等待响应",
    reasoning: "正在思考",
    tools: "工具调用",
    generating: "正在回答",
    completed: "已完成",
    cancelled: "已停止",
    failed: "失败",
  };
  const seconds = (value?: number) =>
    value === undefined ? "—" : `${(Math.max(0, value) / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} s`;
  // 等待期可以有自定义文案（自动拉起模型时的「正在加载模型 xxx…」，见 ChatExecution.hint）
  const label =
    execution.phase === "waiting" && execution.hint
      ? execution.hint
      : (labels[execution.phase] ?? execution.phase);

  return (
    <div className="chat-execution" aria-label="本次请求状态">
      <span aria-live="polite">{label}</span>
      <span>{seconds((execution.finishedAt ?? now) - execution.startedAt)}</span>
      {execution.firstTokenMs !== undefined && (
        <span>首正文 {seconds(execution.firstVisibleMs ?? execution.firstTokenMs)}</span>
      )}
    </div>
  );
}
