import { useEffect, useId, useMemo, useRef, useState } from "react";
import { contextTierLabel, type ContextBenchmarkSample } from "../utils/contextBenchmark";

/** 图上数值的显示格式：照上游用 toLocaleString，数千以上带千分位（8139 → 8,139）。 */
const fmtValue = (value: number): string => value.toLocaleString("zh-CN", { maximumFractionDigits: 1 });

interface ChartRow {
  tier: number;
  prefill: number | null;
  decode: number | null;
  wall: number | null;
}

interface ChartMetric {
  key: "prefill" | "decode" | "wall";
  title: string;
  unit: string;
}

interface Point {
  x: number;
  y: number;
}

/** 单张折线图：轴线、面积、折线与逐点数值（照上游 ContextMetricChart 的几何）。 */
function ContextMetricChart({ rows, metric }: { rows: ChartRow[]; metric: ChartMetric }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  const titleId = useId();

  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const dense = rows.length > 6;
  const left = 48;
  const right = width - 32;
  const top = 38;
  const bottom = 180;
  const height = dense ? 264 : 238;

  const maximum = Math.max(0, ...rows.map((row) => row[metric.key] ?? 0));
  const scale = maximum > 0 ? 10 ** Math.floor(Math.log10(maximum)) : 1;
  const limit = maximum > 0 ? (Math.ceil(((maximum * 1.12) / scale) * 2) / 2) * scale : 1;
  const at = (index: number): number =>
    rows.length < 2 ? (left + right) / 2 : left + (index / (rows.length - 1)) * (right - left);
  const y = (value: number): number => bottom - (value / limit) * (bottom - top);

  // 数值缺失处断开，不连线
  const segments: Point[][] = [];
  let current: Point[] = [];
  rows.forEach((row, index) => {
    const value = row[metric.key];
    if (value === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    current.push({ x: at(index), y: y(value) });
  });
  if (current.length > 0) segments.push(current);

  const path = (points: Point[]): string =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const lines = segments.map(path);
  const areas = segments
    .filter((points) => points.length > 1)
    .map((points) => {
      const head = points[0];
      const tail = points[points.length - 1];
      return `${path(points)}L${tail.x.toFixed(2)},${bottom}L${head.x.toFixed(2)},${bottom}Z`;
    });
  const axisText = (value: number): string => (value >= 1000 ? `${fmtValue(value / 1000)}k` : fmtValue(value));

  // 每个实测值直接标在图上（不靠 hover），密集档位用候选偏移避让
  const labels: { x: number; y: number; text: string; width: number }[] = [];
  rows.forEach((row, index) => {
    const value = row[metric.key];
    const px = at(index);
    const py = value === null ? bottom : y(value);
    const text = value === null ? "—" : fmtValue(value);
    const labelWidth = Math.max(1, text.length) * 8;
    const labelX = Math.min(Math.max(px, left + labelWidth / 2), right - labelWidth / 2);
    const candidates = [-12, -34, -56, 24, 46, 68]
      .map((offset) => py + offset)
      .filter((position) => position >= 14 && position < bottom - 5);
    let labelY = candidates[0] ?? 14;
    for (const position of candidates) {
      const clash = labels.some(
        (label) =>
          Math.abs(labelX - label.x) < (labelWidth + label.width) / 2 + 4 && Math.abs(position - label.y) < 21,
      );
      if (!clash) {
        labelY = position;
        break;
      }
    }
    labels.push({ x: labelX, y: labelY, text, width: labelWidth });
  });

  const summary = rows
    .map((row) => {
      const value = row[metric.key];
      return `${contextTierLabel(row.tier)}：${value === null ? "—" : fmtValue(value)}`;
    })
    .join("，");

  return (
    <section className={`st-chart st-chart--${metric.key}`} aria-label={metric.title}>
      <h3 className="st-chart__title">
        {metric.title}
        <span>{metric.unit}</span>
      </h3>
      <div className="st-chart__box" ref={box}>
        <svg
          className="st-chart__svg"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-labelledby={titleId}
        >
          <title id={titleId}>{`${metric.title}（${metric.unit}）· ${summary}`}</title>
          {[0, 1, 2, 3].map((tick) => {
            const position = y((limit * tick) / 3);
            return (
              <g key={tick}>
                <line className="st-chart__grid" x1={left} x2={right} y1={position} y2={position} />
                {/* 没有数据时不标刻度数字，只剩网格线（照上游） */}
                {rows.length > 0 ? (
                  <text className="st-chart__axis" x={left - 9} y={position + 4} textAnchor="end">
                    {axisText((limit * tick) / 3)}
                  </text>
                ) : null}
              </g>
            );
          })}
          {areas.map((d, index) => (
            <path key={`area-${index}`} className="st-chart__area" d={d} fill="currentColor" opacity=".12" />
          ))}
          {lines.map((d, index) => (
            <path
              key={`line-${index}`}
              className="st-chart__line"
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {rows.map((row, index) => {
            const label = labels[index];
            if (!label) return null;
            const px = at(index);
            const value = row[metric.key];
            return (
              <g key={row.tier} className="st-chart__point">
                {value === null ? null : <circle cx={px} cy={y(value)} r={3.5} fill="currentColor" />}
                <text className="st-chart__value" x={label.x} y={label.y} textAnchor="middle">
                  {label.text}
                </text>
                <text
                  className="st-chart__axis st-chart__tier"
                  x={px}
                  y={bottom + 23}
                  textAnchor={dense ? "end" : "middle"}
                  transform={dense ? `rotate(${width < 360 ? -70 : -55} ${px} ${bottom + 23})` : undefined}
                >
                  {contextTierLabel(row.tier)}
                </text>
              </g>
            );
          })}
          {rows.length === 0 ? (
            <text className="st-chart__empty" x={(left + right) / 2} y={(top + bottom) / 2} textAnchor="middle">
              完成首个档位后显示
            </text>
          ) : null}
        </svg>
      </div>
    </section>
  );
}

/** 三张图：预填充 / 解码 / 耗时，按档位取已完成样本的平均值（上游 ContextBenchmarkCharts）。 */
export function ContextBenchCharts({ samples }: { samples: ContextBenchmarkSample[] }) {
  const rows = useMemo<ChartRow[]>(() => {
    const tiers = [...new Set(samples.map((sample) => sample.targetTokens))].sort((a, b) => a - b);
    return tiers.map((tier) => {
      const group = samples.filter((sample) => sample.targetTokens === tier && sample.state === "completed");
      const pick = (read: (sample: ContextBenchmarkSample) => number | null): number | null => {
        const values = group
          .map(read)
          .filter((value): value is number => value !== null && Number.isFinite(value));
        if (values.length === 0) return null;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      };
      return {
        tier,
        prefill: pick((sample) => sample.prefillTokS),
        decode: pick((sample) => sample.decodeTokS),
        wall: pick((sample) => sample.wallMs / 1000),
      };
    });
  }, [samples]);

  const metrics: ChartMetric[] = [
    { key: "prefill", title: "预填充速度", unit: "tok/s" },
    { key: "decode", title: "解码速度", unit: "tok/s" },
    { key: "wall", title: "请求耗时", unit: "s" },
  ];

  return (
    <div className="st-charts">
      {metrics.map((metric) => (
        <ContextMetricChart key={metric.key} rows={rows} metric={metric} />
      ))}
    </div>
  );
}
