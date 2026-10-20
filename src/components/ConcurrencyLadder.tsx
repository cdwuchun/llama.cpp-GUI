import { useEffect, useState } from "react";
import { useApp } from "../store";
import {
  LADDER_STAGE_MS,
  ladderConclusion,
  ladderMessage,
  ladderRowsFromSamples,
  type LadderRow,
} from "../utils/concurrencyLadder";

/**
 * 并发阶梯卡片（照上游 `ConcurrencyLadder.tsx` + `ConcurrencyChart.tsx` 移植）。
 *
 * 上游这卡片是场景测试页里单独一段：按 1 → 2 → 4 … 逐级加压，每级固定时长，
 * 看总吞吐和单个请求的速度怎么变，最后给一句话结论。本工程的差别只有数据来源：
 * 槽数从 llama.cpp `/props` 的 `total_slots` 来（上游是 Strata 的 `/metrics.live.parallel`）。
 */

interface ChartItem {
  key: string;
  label: string;
  total: number | null;
  perRequest: number | null;
  highlight?: boolean;
  pending?: boolean;
}

const fmt = (value: number | null): string =>
  value === null ? "—" : value >= 100 ? value.toFixed(0) : value.toFixed(1);

const sec = (value: number | null): string => (value === null ? "—" : (value / 1000).toFixed(2));

/** 柱＝总吞吐、线＝单个请求：上游明确要求「不是堆叠也不是横条」 */
function ConcurrencyChart({ items, ariaLabel }: { items: ChartItem[]; ariaLabel: string }) {
  const width = 560;
  const height = 220;
  const top = 26;
  const bottom = 34;
  const left = 12;
  const right = 12;
  const plot = height - top - bottom;
  const max = Math.max(1, ...items.flatMap((item) => [item.total ?? 0, item.perRequest ?? 0])) * 1.08;
  const slot = (width - left - right) / Math.max(1, items.length);
  const bar = Math.min(64, slot * 0.46);
  const x = (i: number): number => left + slot * i + slot / 2;
  const y = (value: number): number => top + plot - (value / max) * plot;

  const points = items.map((item, i) =>
    item.perRequest === null ? null : ([x(i), y(item.perRequest)] as const),
  );
  const path = points.reduce((d, point, i) => {
    if (!point) return d;
    const prev = points[i - 1];
    return `${d}${d && prev ? "L" : "M"}${point[0].toFixed(1)},${point[1].toFixed(1)}`;
  }, "");

  return (
    <figure className="concurrency-chart" aria-label={ariaLabel}>
      <figcaption className="concurrency-chart-legend">
        <span data-series="total">总吞吐 tok/s</span>
        <span data-series="per">单个请求 tok/s</span>
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" preserveAspectRatio="xMidYMid meet">
        <line
          className="concurrency-chart-axis"
          x1={left}
          x2={width - right}
          y1={top + plot}
          y2={top + plot}
        />
        {items.map((item, i) => {
          const h = item.total === null ? 0 : (item.total / max) * plot;
          return (
            <g key={item.key} data-highlight={item.highlight || undefined} data-pending={item.pending || undefined}>
              {item.total === null ? (
                <rect
                  className="concurrency-chart-ghost"
                  x={x(i) - bar / 2}
                  y={top + plot - 24}
                  width={bar}
                  height={24}
                  rx={4}
                />
              ) : (
                <rect
                  className="concurrency-chart-bar"
                  x={x(i) - bar / 2}
                  y={top + plot - h}
                  width={bar}
                  height={Math.max(1, h)}
                  rx={4}
                />
              )}
              <text
                className="concurrency-chart-value"
                x={x(i)}
                y={(item.total === null ? top + plot - 24 : top + plot - h) - 6}
                textAnchor="middle"
              >
                {fmt(item.total)}
              </text>
              <text className="concurrency-chart-label" x={x(i)} y={height - 12} textAnchor="middle">
                {item.label}
              </text>
            </g>
          );
        })}
        {path && <path className="concurrency-chart-line" d={path} />}
        {points.map((point, i) =>
          point ? (
            <g key={`p-${items[i].key}`}>
              <circle className="concurrency-chart-dot" cx={point[0]} cy={point[1]} r={4} />
              {/* 数值放点下方：一次一个时总吞吐和单个请求相等，放上方会与柱顶数字压在一起 */}
              <text className="concurrency-chart-per" x={point[0]} y={point[1] + 17} textAnchor="middle">
                {fmt(items[i].perRequest)}
              </text>
            </g>
          ) : null,
        )}
      </svg>
    </figure>
  );
}

export function ConcurrencyLadder({ model }: { model: string }) {
  const ladder = useApp((s) => s.ladder);
  const runLadder = useApp((s) => s.runLadder);
  const cancelLadder = useApp((s) => s.cancelLadder);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!ladder.running) setStopping(false);
  }, [ladder.running]);

  useEffect(() => {
    if (!ladder.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [ladder.running]);

  // 运行中直接由样本算（随跑随出），跑完看存下来的那份
  const report = ladder.history.find((r) => r.id === ladder.selectedId) ?? ladder.history[0] ?? null;
  const rows: LadderRow[] = ladder.running ? ladderRowsFromSamples(ladder.samples) : report?.rows ?? [];
  const levels = ladder.running ? ladder.levels : report?.levels ?? ladder.levels;
  const conclusion = ladder.running || rows.length === 0 ? null : ladderConclusion(rows);
  const elapsedMs = ladder.startedAt ? Math.max(0, now - ladder.startedAt) : 0;

  const items: ChartItem[] = levels.map((level) => {
    const row = rows.find((item) => item.concurrency === level);
    const live = ladder.running && ladder.concurrency === level;
    return {
      key: String(level),
      label: `${level} 个同时`,
      total: live ? null : row?.totalTokS ?? null,
      perRequest: row?.perRequestTokS ?? null,
      highlight: conclusion !== null && conclusion.best === level && conclusion.code !== "ladder_empty",
      pending: live,
    };
  });

  return (
    <div className="panel">
      <div className="concurrency-ladder-head">
        <div>
          <h2 className="panel-title">并发阶梯</h2>
          <p className="st-hint">
            按 {levels.join(" → ")} 个同时请求逐级加压，每级约 {Math.round(LADDER_STAGE_MS / 1000)} 秒，
            看总吞吐和单个请求怎么变。
            {ladder.running && ladder.concurrency > 0 && (
              <b> 正在跑 {ladder.concurrency} 个同时。</b>
            )}
          </p>
        </div>
        {ladder.running ? (
          <div className="bench-run">
            <span className="bench-status" role="status">
              <i className="fas fa-spinner fa-spin" />
              第 {ladder.stage} / {levels.length} 级 · {(elapsedMs / 1000).toFixed(1)} s
            </span>
            <button
              type="button"
              className="st-btn st-btn--secondary bench-stop"
              disabled={stopping}
              onClick={() => {
                setStopping(true);
                cancelLadder();
              }}
            >
              <i className="fas fa-stop" />
              {stopping ? "正在停止" : "停止测试"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="st-btn st-btn--primary"
            disabled={!model}
            onClick={() => void runLadder(model)}
          >
            <i className="fas fa-play" />
            {report ? "重新跑阶梯" : "开始阶梯测试"}
          </button>
        )}
      </div>

      {ladder.slots === 1 && !ladder.running && (
        <p className="st-hint st-hint--warn">
          当前一次一个：多出的请求只会排队。在配置页开启并发（--parallel）后再测，才看得到并发的真实收益。
        </p>
      )}

      {ladder.running && (
        <ol className="concurrency-ladder-steps" aria-label="进度">
          {levels.map((level, i) => (
            <li
              key={level}
              data-state={
                i + 1 < ladder.stage ? "done" : i + 1 === ladder.stage ? "live" : "next"
              }
            >
              <strong>{level}</strong>
              <span>
                {i + 1 < ladder.stage ? (
                  "完成"
                ) : i + 1 === ladder.stage ? (
                  <>
                    <i className="fas fa-spinner fa-spin" />
                    进行中
                  </>
                ) : (
                  "等待"
                )}
              </span>
            </li>
          ))}
          <li className="concurrency-ladder-live">
            已完成 {ladder.completed} 个请求
            {ladder.failed > 0 && ` · 失败 ${ladder.failed}`} · {Math.round(elapsedMs / 1000)} s
          </li>
        </ol>
      )}

      {conclusion && (
        <p className="concurrency-ladder-verdict" data-code={conclusion.code}>
          {ladderMessage(conclusion)}
        </p>
      )}

      {(ladder.running || rows.length > 0) && (
        <div className="concurrency-ladder-body">
          <ConcurrencyChart items={items} ariaLabel="并发阶梯结果" />
          <table className="concurrency-ladder-table">
            <thead>
              <tr>
                <th>同时请求</th>
                <th>总吞吐</th>
                <th>单个请求</th>
                <th>TTFT P50</th>
                <th>TTFT P95</th>
                <th>完成 / 失败</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((level) => {
                const row = rows.find((item) => item.concurrency === level);
                const best =
                  conclusion?.code === "ladder_gain" && conclusion.best === level ? true : undefined;
                return (
                  <tr key={level} data-best={best}>
                    <td>{level}</td>
                    <td>
                      {fmt(row?.totalTokS ?? null)} <small>tok/s</small>
                    </td>
                    <td>
                      {fmt(row?.perRequestTokS ?? null)} <small>tok/s</small>
                    </td>
                    <td>
                      {sec(row?.ttftP50Ms ?? null)} <small>s</small>
                    </td>
                    <td>
                      {sec(row?.ttftP95Ms ?? null)} <small>s</small>
                    </td>
                    <td>{row ? `${row.completed} / ${row.failed}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!ladder.running && report && (
        <p className="st-hint">
          测于 {new Date(report.finishedAt).toLocaleString("zh-CN")} · {report.model} · 输出 256 token
          的持续生成请求；TTFT 包含排队。
        </p>
      )}

      {ladder.error && (
        <p className="st-hint st-hint--warn" role="alert">
          {ladder.error}
        </p>
      )}
    </div>
  );
}
