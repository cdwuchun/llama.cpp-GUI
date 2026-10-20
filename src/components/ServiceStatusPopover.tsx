/**
 * 服务状态弹层：点状态栏左侧的胶囊展开。
 *
 * 照搬上游 `E:\Code\strata-manager-main\apps\desktop\src\ServiceStatusPopover.tsx`
 * 的结构（trigger → portal 面板：标题 / 摘要 / endpoint / 两条迷你折线 /
 * 显存·内存·上下文进度条 / 采样说明 / 快捷跳转），用户 m05241 要求原封原样。
 * 上游的 profile / process / 启停操作本工程没有（服务由前门接管），对应区块删掉。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { LiveMetric, TelemetryPoint, TelemetrySeries } from "../utils/telemetry";
import { appendTelemetry, telemetryNumber, telemetryPoint, telemetrySparkline, type TelemetryHistory } from "../utils/telemetry";

export type MonitorPage = "models" | "chat" | "bench" | "logs";

export interface ServiceStatusPopoverProps {
  hasModel: boolean;
  model: string;
  proxy: boolean;
  proxyPort: number;
  modelState: "loaded" | "loading" | "unloaded" | "unknown";
  metric: LiveMetric | null;
  metricAt: number;
  onRefresh: () => void;
  onNavigate: (page: MonitorPage) => void;
}

function Sparkline({ points, series, label, waiting }: { points: TelemetryPoint[]; series: TelemetrySeries; label: string; waiting: string }) {
  const graph = telemetrySparkline(points, series, series === "gpu" ? 100 : undefined);
  if (!graph.count) return <div className="service-status-chart-empty">{waiting}</div>;
  return (
    <svg className="service-status-sparkline" viewBox="0 0 160 48" preserveAspectRatio="none" role="img" aria-label={label} data-samples={graph.count}>
      <path d="M4 44H156" className="service-status-chart-baseline" />
      {graph.paths.map((path, index) => (
        <path key={index} d={path} className="service-status-chart-line" />
      ))}
      {graph.last && <circle cx={graph.last.x} cy={graph.last.y} r={2.3} />}
    </svg>
  );
}

function ResourceMeter({ label, value, percent }: { label: string; value: string; percent: number | null }) {
  const bounded = percent === null ? undefined : Math.max(0, Math.min(100, percent));
  return (
    <div className="service-status-resource">
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div
        className="service-status-meter"
        role={bounded === undefined ? undefined : "meter"}
        aria-label={bounded === undefined ? undefined : label}
        aria-valuemin={bounded === undefined ? undefined : 0}
        aria-valuemax={bounded === undefined ? undefined : 100}
        aria-valuenow={bounded}
        aria-valuetext={bounded === undefined ? undefined : value}
        data-tone={percent !== null && percent >= 90 ? "warning" : undefined}
      >
        <span style={{ width: `${bounded ?? 0}%` }} />
      </div>
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  none: "选择模型",
  stopped: "服务未启动",
  disconnected: "服务已离线",
  unavailable: "监控不可用",
  waiting: "正在获取监控",
  loading: "正在载入模型",
  unloading: "正在释放模型",
  reading: "读取中",
  prefill: "读取中",
  generating: "生成中",
  queued: "排队中",
  idle: "空闲",
};

export function ServiceStatusPopover({
  hasModel,
  model,
  proxy,
  proxyPort,
  modelState,
  metric,
  metricAt,
  onRefresh,
  onNavigate,
}: ServiceStatusPopoverProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const [history, setHistory] = useState<TelemetryHistory>({ identity: "", points: [] });

  const identity = `${model}|${proxyPort}`;
  const liveMetrics = hasModel && proxy && modelState === "loaded" && metric !== null;
  const points = history.identity === identity ? history.points : [];
  const state = !hasModel
    ? "none"
    : !proxy
      ? "stopped"
      : modelState === "loading"
        ? "loading"
        : modelState === "unloaded"
          ? "unloading"
          : metric === null
            ? "unavailable"
            : metric.state;

  useEffect(() => {
    setHistory((previous) =>
      appendTelemetry(previous, identity, telemetryPoint(liveMetrics ? metricAt || Date.now() : Date.now(), liveMetrics ? metric : undefined, liveMetrics)),
    );
  }, [identity, liveMetrics, metric, metricAt]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(408, window.innerWidth - 24);
      setPosition({
        width,
        left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)),
        top: rect.top - 10,
        maxHeight: Math.max(100, rect.top - 22),
        transform: "translateY(-100%)",
      });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        anchor.current?.focus({ preventScroll: true });
      }
    };
    place();
    panel.current?.focus({ preventScroll: true });
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keys);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keys);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const format = (value: unknown, digits = 0) =>
    telemetryNumber(value) === null ? "–" : (value as number).toLocaleString("zh-CN", { maximumFractionDigits: digits });
  const memory = (used: number | null | undefined, total: number | null | undefined) => {
    const validUsed = liveMetrics ? telemetryNumber(used) : null;
    const validTotal = liveMetrics ? telemetryNumber(total) : null;
    return {
      value: validUsed === null || !validTotal ? "–" : `${format(validUsed / 1024 ** 3, 1)} / ${format(validTotal / 1024 ** 3, 1)} GB`,
      percent: validUsed === null || !validTotal ? null : (validUsed / validTotal) * 100,
    };
  };
  const vram = memory(metric?.gpuMemoryUsed, metric?.gpuMemoryTotal);
  const ram = memory(metric?.ramUsed, metric?.ramTotal);
  const reading = state === "reading";
  const speedSeries: TelemetrySeries = reading ? "prefill" : "decode";
  const speedTrend = reading ? "输入速度趋势" : "生成速度趋势";
  const contextUsed =
    metric?.promptTokens === null || metric?.outputTokens === null
      ? null
      : (metric?.promptTokens ?? 0) + (metric?.outputTokens ?? 0);
  const contextTotal = metric?.maxContext ?? null;
  const modelStateText = !hasModel
    ? "尚未选择"
    : !proxy
      ? "服务未启动"
      : modelState === "loading"
        ? "正在载入模型"
        : modelState === "unloaded"
          ? "未加载"
          : modelState === "loaded"
            ? "已就绪"
            : "未知";

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="st-pill service-status-trigger"
        data-state={state}
        aria-label="服务状态与快捷操作"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="st-pill__dot" aria-hidden="true" />
        <span className="service-status-trigger__text" role="status" aria-live="polite">
          {STATE_TEXT[state] ?? state}
        </span>
        <i className="fas fa-chevron-down service-status-trigger__chev" aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            className="service-status-popover"
            ref={panel}
            role="dialog"
            aria-modal="false"
            tabIndex={-1}
            style={position}
            data-state={state}
          >
            <header>
              <div className="service-status-heading">
                <span>服务状态</span>
                <strong className="service-status-model">{model || "选择一个模型开始"}</strong>
              </div>
              <div className="service-status-header-actions">
                <button type="button" className="icon-button" aria-label="刷新状态" onClick={onRefresh}>
                  <i className="fas fa-rotate" />
                </button>
                <button type="button" className="icon-button" aria-label="关闭快捷面板" onClick={() => setOpen(false)}>
                  <i className="fas fa-xmark" />
                </button>
              </div>
            </header>
            <div className="service-status-summary">
              <span className={`service-status-chip${proxy && hasModel ? " is-online" : ""}`}>
                {proxy ? "API 在线" : "服务未启动"}
              </span>
              <span className="service-status-model-state">{modelStateText}</span>
              {proxy && <span className="service-status-owner">{`前门 :${proxyPort}`}</span>}
            </div>
            {hasModel && proxy && (
              <small className="service-status-endpoint" title={`http://127.0.0.1:${proxyPort}`}>
                {`http://127.0.0.1:${proxyPort}`}
              </small>
            )}
            {hasModel && proxy && modelState === "loaded" ? (
              <div className="service-status-monitor">
                <div className="service-status-trends">
                  <section>
                    <header>
                      <span>{speedTrend}</span>
                      <small>tok/s</small>
                    </header>
                    <Sparkline points={points} series={speedSeries} label={speedTrend} waiting="等待速度采样" />
                  </section>
                  <section>
                    <header>
                      <span>GPU 负载趋势</span>
                      <small>%</small>
                    </header>
                    <Sparkline points={points} series="gpu" label="GPU 负载趋势" waiting="等待 GPU 采样" />
                  </section>
                </div>
                <div className="service-status-resources">
                  <ResourceMeter label="显存" {...vram} />
                  <ResourceMeter label="内存" {...ram} />
                </div>
                {contextUsed !== null && contextTotal !== null && contextTotal > 0 && (
                  <ResourceMeter
                    label="最近请求上下文"
                    value={`${format(contextUsed)} / ${format(contextTotal)} tokens`}
                    percent={(contextUsed / contextTotal) * 100}
                  />
                )}
                <div className="service-status-telemetry-meta">
                  <span>近 3 分钟采样</span>
                  <span>{metricAt ? new Date(metricAt).toLocaleTimeString("zh-CN") : "等待监控"}</span>
                </div>
              </div>
            ) : (
              <div className="service-status-empty">
                {!hasModel
                  ? "选择模型后查看实时负载"
                  : !proxy
                    ? "启动前门后查看实时负载"
                    : modelState === "unloaded"
                      ? "API 在线，模型内存已释放；再次请求时会自动载入。"
                      : "连接服务后查看实时负载"}
              </div>
            )}
            <nav aria-label="快捷跳转">
              <button type="button" onClick={() => { setOpen(false); onNavigate("bench"); }}>
                <i className="fas fa-chart-line" />
                监控
              </button>
              <button type="button" onClick={() => { setOpen(false); onNavigate("models"); }}>
                <i className="fas fa-sliders" />
                模型管理
              </button>
              <button type="button" onClick={() => { setOpen(false); onNavigate("logs"); }}>
                <i className="fas fa-terminal" />
                任务与日志
              </button>
            </nav>
          </div>,
          document.body,
        )}
    </>
  );
}
