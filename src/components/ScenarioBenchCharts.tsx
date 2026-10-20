/**
 * 场景测试的两张图（照上游 `ScenarioBenchmarkCharts.tsx` 移植）：
 *
 * - {@link RequestDotPlot}：每次请求打一个点，看波动与离群值；
 * - {@link ScenarioColumns}：每个场景一根柱，横向比场景之间。
 *
 * 用 SVG 手画而不是引图表库：上游也是手画的，且导出 PNG 时要把
 * 表现属性内联进去，第三方库的 DOM 结构不好控制。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";

/** 容器宽度（SVG 用 viewBox 缩放，但坐标要按真实宽度算才不挤） */
function useWidth(initial: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}

/** Y 轴上限取整到好看的数字（上游同一算法：1.1 留白后按数量级取半档） */
function niceLimit(maximum: number): number {
  if (!Number.isFinite(maximum) || maximum <= 0) return 1;
  const scale = 10 ** Math.floor(Math.log10(maximum));
  return (Math.ceil(((maximum * 1.1) / scale) * 2) / 2) * scale;
}

const fmt = (value: number): string => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

export interface RequestPoint {
  /** 第几次请求（1 起） */
  order: number;
  /** X 轴标签：场景名 */
  label: string;
  /** 指标值，null 表示没测到 */
  value: number | null;
  failed: boolean;
  /** 是否最新一次（画大一点） */
  current?: boolean;
}

export function RequestDotPlot({
  points,
  title,
  unit,
  emptyText,
  mean,
  digits = 1,
}: {
  points: RequestPoint[];
  title: string;
  unit: string;
  emptyText: string;
  mean: number | null;
  digits?: number;
}) {
  const [ref, width] = useWidth(360);
  const titleId = useId();
  const height = 168;
  const left = 44;
  const right = Math.max(left + 60, width - 12);
  const top = 14;
  const bottom = height - 26;
  const values = points.map((p) => p.value).filter((v): v is number => v !== null && Number.isFinite(v));
  const limit = niceLimit(Math.max(0, ...values));
  const y = (value: number): number => bottom - (value / limit) * (bottom - top);
  const x = (index: number): number =>
    points.length < 2 ? (left + right) / 2 : left + (index / (points.length - 1)) * (right - left);
  const showMean = mean !== null && Number.isFinite(mean) && values.length > 1;

  return (
    <section className="scenario-plot">
      <h3 className="st-chart__title">
        {title}
        <span>{unit}</span>
      </h3>
      <div className="scenario-plot__box" ref={ref}>
        {points.length === 0 ? (
          <p className="st-chart__empty">{emptyText}</p>
        ) : (
          <svg className="scenario-plot__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
            <title id={titleId}>
              {`${title}：` +
                points.map((p) => `${p.label} ${p.value === null ? "—" : fmt(p.value)}`).join("；")}
            </title>
            {[0, 0.5, 1].map((ratio) => {
              const value = limit * ratio;
              return (
                <g key={ratio}>
                  <line
                    className="scenario-plot__grid"
                    x1={left}
                    x2={right}
                    y1={y(value)}
                    y2={y(value)}
                  />
                  <text
                    className="scenario-plot__axis"
                    x={left - 8}
                    y={y(value)}
                    textAnchor="end"
                    dominantBaseline="middle"
                  >
                    {fmt(value)}
                  </text>
                </g>
              );
            })}
            {showMean && (
              <line
                className="scenario-plot__mean"
                x1={left}
                x2={right}
                y1={y(mean as number)}
                y2={y(mean as number)}
              />
            )}
            {points.map((point, index) => {
              const px = x(index);
              if (point.value === null || point.failed) {
                return (
                  <path
                    key={point.order}
                    className="scenario-plot__failed"
                    d={`M${px - 3.5} ${bottom - 3.5}l7 7m0 -7l-7 7`}
                  />
                );
              }
              const py = y(point.value);
              return (
                <g key={point.order}>
                  <circle
                    className={`scenario-plot__dot${point.current ? " is-latest" : ""}`}
                    cx={px}
                    cy={py}
                    r={point.current ? 4.5 : 3.5}
                  />
                  <text
                    className="scenario-plot__value"
                    x={px}
                    y={py - 9}
                    // 首尾贴边对齐，避免数值标签压到 y 轴刻度或超出右边
                    textAnchor={
                      index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"
                    }
                  >
                    {point.value.toFixed(digits).replace(/\.0+$/, "")}
                  </text>
                </g>
              );
            })}
            {points.map((point, index) => (
              <text
                key={`label-${point.order}`}
                className="scenario-plot__tier"
                // 首尾两个标签往里贴，否则会伸到 y 轴刻度数字下面（第一点就在 left 上）
                x={index === 0 ? left : index === points.length - 1 ? right : x(index)}
                y={bottom + 17}
                textAnchor={
                  index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"
                }
              >
                {index === 0 || point.label !== points[index - 1].label ? point.label : ""}
              </text>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}

export interface ColumnRow {
  label: string;
  value: number | null;
  failed?: boolean;
}

/** 标签按字符宽度估，中文按一个半字宽算，用来决定要不要转角度 */
function labelWidth(label: string): number {
  let sum = 0;
  for (const ch of label) sum += ch.charCodeAt(0) > 255 ? 11.5 : 5.9;
  return sum;
}

export function ScenarioColumns({
  rows,
  title,
  unit,
  emptyText,
  digits = 1,
}: {
  rows: ColumnRow[];
  title: string;
  unit: string;
  emptyText: string;
  digits?: number;
}) {
  const [ref, width] = useWidth(360);
  const titleId = useId();
  const left = 8;
  const right = Math.max(left + 60, width - 8);
  const top = 22;
  const band = (right - left) / Math.max(1, rows.length);
  const bar = Math.min(44, band * 0.5);
  // 标签放不下时整体旋转，避免互相压住
  const rotate = rows.some((row) => labelWidth(row.label) + 6 > band);
  const labelSpace = rotate ? 62 : 26;
  const height = 156 + labelSpace;
  const values = rows.map((r) => r.value).filter((v): v is number => v !== null && Number.isFinite(v));
  const limit = niceLimit(Math.max(0, ...values));
  const base = height - labelSpace;
  const plot = useMemo(() => {
    return rows.map((row, index) => {
      const cx = left + band * index + band / 2;
      const value = row.value ?? 0;
      const barHeight = (value / limit) * (base - top);
      return { cx, row, barHeight };
    });
  }, [rows, band, left, limit, base, top]);

  return (
    <section className="scenario-plot">
      <h3 className="st-chart__title">
        {title}
        <span>{unit}</span>
      </h3>
      <div className="scenario-plot__box" ref={ref}>
        {rows.length === 0 ? (
          <p className="st-chart__empty">{emptyText}</p>
        ) : (
          <svg className="scenario-plot__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}>
            <title id={titleId}>
              {`${title}：` + rows.map((r) => `${r.label} ${r.value === null ? "—" : fmt(r.value)}`).join("；")}
            </title>
            <line className="scenario-plot__grid" x1={left} x2={right} y1={base} y2={base} />
            <line className="scenario-plot__grid" x1={left} x2={right} y1={top} y2={top} />
            <text className="scenario-plot__axis" x={left} y={top - 6}>
              {fmt(limit)}
            </text>
            {plot.map(({ cx, row, barHeight }) => (
              <g key={row.label}>
                <rect
                  className={`scenario-column${row.failed ? " is-failed" : ""}`}
                  x={cx - bar / 2}
                  y={base - Math.max(1, barHeight)}
                  width={bar}
                  height={Math.max(1, barHeight)}
                  rx="3"
                />
                <text
                  className="scenario-plot__value"
                  x={cx}
                  y={base - Math.max(1, barHeight) - 6}
                  textAnchor="middle"
                >
                  {row.value === null ? "—" : row.value.toFixed(digits).replace(/\.0+$/, "")}
                </text>
                <text
                  className="scenario-plot__tier"
                  x={cx}
                  y={base + 16}
                  textAnchor={rotate ? "end" : "middle"}
                  transform={rotate ? `rotate(-38 ${cx} ${base + 16})` : undefined}
                >
                  {row.label}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}
