/**
 * 并行任务（槽位）监控。
 *
 * 照搬上游 `E:\Code\strata-manager-main\apps\desktop\src\SlotMonitor.tsx`（54 行）
 * 与 `slot-monitor.css`；字段来源换成 llama.cpp 的 `/slots`（用户 m05241）。
 */
import { useEffect, useRef, useState } from "react";
import { fixed1, nextSlotHistory, sparkPaths, type SlotView } from "../utils/monitor";

/** 每条速度折线保留最近 30 个采样（上游 HISTORY = 30）。 */
const HISTORY = 30;

function Spark({ values }: { values: (number | null)[] }) {
  const { line, count } = sparkPaths(values.slice(-HISTORY));
  if (count < 2) {
    return <span className="slot-spark slot-spark--empty" aria-hidden="true" />;
  }
  return (
    <svg className="slot-spark" viewBox="0 0 60 18" role="img" aria-label="生成速度走势">
      {line && <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} />}
    </svg>
  );
}

export function SlotMonitor({
  slots,
  parallel,
  queued,
}: {
  slots: SlotView[];
  parallel: number;
  queued: number;
}) {
  const [history, setHistory] = useState<Record<number, (number | null)[]>>({});
  const previous = useRef<SlotView[]>([]);

  useEffect(() => {
    // 只在槽位集合真的变了才推一个采样点，避免同一秒被重复计入。
    const key = slots.map((slot) => `${slot.id}:${slot.speed ?? ""}:${slot.busy}`).join("|");
    const last = previous.current.map((slot) => `${slot.id}:${slot.speed ?? ""}:${slot.busy}`).join("|");
    if (key === last) return;
    previous.current = slots;
    setHistory((current) => nextSlotHistory(current, slots));
  }, [slots]);

  const busy = slots.filter((slot) => slot.busy).length;
  const totalSpeed = slots.reduce((sum, slot) => sum + (slot.busy ? (slot.speed ?? 0) : 0), 0);

  return (
    <section className="st-card runtime-slot-monitor" aria-label="并行任务">
      <header className="st-card__head runtime-operations-heading">
        <h3 className="st-card__title">并行任务</h3>
        <span className="st-hint">
          处理中 {busy} · 等待中 {queued} · 槽外请求 {Math.max(0, queued - busy)}
        </span>
      </header>
      <dl className="slot-monitor-summary">
        <div>
          <dt>生效槽数</dt>
          <dd>
            {parallel}
            <small>{busy} 个在用</small>
          </dd>
        </div>
        <div>
          <dt>合计速度</dt>
          <dd>
            {totalSpeed > 0 ? fixed1(totalSpeed) : "—"}
            <small>tok/s</small>
          </dd>
        </div>
        <div>
          <dt>排队</dt>
          <dd data-busy={queued > 0 ? "" : undefined}>{queued}</dd>
        </div>
      </dl>
      {slots.length === 0 ? (
        <p className="st-hint">引擎没有报告槽位（`/slots` 为空，或模型还没加载）。</p>
      ) : (
        <div className="table-wrap">
          <table className="st-table st-table--nowrap slot-monitor-table">
            <thead>
              <tr>
                <th>任务位</th>
                <th>状态</th>
                <th>输入词元</th>
                <th>输出词元</th>
                <th>保留历史词元</th>
                <th>生成速度</th>
                <th>速度走势</th>
                <th>对话容量占用</th>
              </tr>
            </thead>
            <tbody>
              {slots.map((slot) => {
                const used = (slot.promptTokens ?? 0) + (slot.outputTokens ?? 0);
                const ratio = slot.context && slot.context > 0 ? Math.min(100, (used / slot.context) * 100) : 0;
                return (
                  <tr key={slot.id} data-state={slot.busy ? "busy" : "idle"}>
                    <td>#{slot.id}</td>
                    <td>{slot.busy ? "处理中" : "空闲"}</td>
                    <td className="num">{slot.promptTokens ?? "—"}</td>
                    <td className="num">{slot.outputTokens ?? "—"}</td>
                    <td className="num">{slot.cacheTokens ?? "—"}</td>
                    <td className="num slot-monitor-speed">{slot.busy ? fixed1(slot.speed) : "—"}</td>
                    <td>
                      <Spark values={history[slot.id] ?? []} />
                    </td>
                    <td className="runtime-slot-context">
                      {used} / {slot.context ?? "—"}
                      <progress className="st-progress" value={ratio} max={100} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
