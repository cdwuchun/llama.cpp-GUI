/**
 * 底部服务状态栏（胶囊）。
 *
 * 照搬上游 `E:\Code\strata-manager-main\apps\desktop\src\layouts\ServiceTelemetryStatusBar.tsx`
 * 的结构与文案顺序（用户 m05241：监控 UI 原封原样照搬上游）：
 * 状态点 + 状态词 + [生成/读取 速度 · 运行 · 排队 · GPU · CPU · 温度 · 功耗]。
 */
import type { LiveMetric } from "../utils/telemetry";

export interface ServiceTelemetryStatusBarProps {
  hasModel: boolean;
  proxy: boolean;
  modelState: "loaded" | "loading" | "unloaded" | "unknown";
  metric: LiveMetric | null;
  metricAt: number;
  /** 左侧那颗状态胶囊（ServiceStatusPopover 的触发器）；它自己就带状态文字。 */
  trigger?: React.ReactNode;
}


const validNumber = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const LABELS: Record<string, string> = {
  none: "选择模型",
  connecting: "正在连接",
  disconnected: "服务已离线",
  stopped: "服务未启动",
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

export function ServiceTelemetryStatusBar({
  hasModel,
  proxy,
  modelState,
  metric,
  metricAt,
  trigger,
}: ServiceTelemetryStatusBarProps) {
  const state: string = !hasModel
    ? "none"
    : !proxy
      ? "stopped"
      : modelState === "loading"
        ? "loading"
        : modelState === "unloaded"
          ? "unloading"
          : metric === null
            ? "unavailable"
            : metric.state === "waiting"
              ? "waiting"
              : metric.state;
  const status = LABELS[state] ?? state;
  const transitioning = state === "loading" || state === "unloading";
  const showMetrics =
    hasModel && proxy && modelState === "loaded" && metric !== null && !["error", "disconnected"].includes(state);
  const reading = state === "reading" || state === "prefill";
  const speed = showMetrics && metric
    ? state === "generating"
      ? metric.decodeTokS
      : reading
        ? metric.prefillTokS
        : state === "idle"
          ? metric.decodeTokS
          : null
    : null;
  const speedLabel = reading ? "读取" : state === "idle" ? "最近生成" : "生成";
  const format = (value: number, digits = 0) =>
    value.toLocaleString("zh-CN", { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const number = (value: number | null | undefined, suffix = "", digits = 0) =>
    validNumber(value) ? `${format(value, digits)}${suffix}` : "–";
  const percent = (value: number | null | undefined) =>
    validNumber(value) && value <= 100 ? number(value, "%") : "–";

  return (
    <footer
      className="workspace-statusbar service-telemetry-statusbar"
      aria-label="服务监控"
      data-state={state}
      aria-busy={transitioning}
      title={metricAt ? `最近采样 ${new Date(metricAt).toLocaleTimeString("zh-CN")}` : undefined}
    >
      {/* trigger 自带状态点与文案，这里再画一个点就是重复（用户 m05810 第 3 点）。 */}
      <span className="workspace-statusbar-state service-telemetry-state" role="status" aria-live="polite">
        {trigger ?? (
          <>
            {transitioning ? (
              <i className="fas fa-circle-notch fa-spin" aria-hidden="true" />
            ) : (
              <span className="service-telemetry-dot" aria-hidden="true" />
            )}
            {status}
          </>
        )}
      </span>
      {showMetrics && metric && (
        <div className="service-telemetry-values" aria-label="服务监控指标" tabIndex={0}>
          {!transitioning && (
            <span className="service-telemetry-value service-telemetry-speed">
              <span>{speedLabel}</span>
              <strong>{number(speed, "", 1)}</strong>
              <span>tok/s</span>
            </span>
          )}
          <span className="service-telemetry-value">
            <span>运行</span>
            <strong>{number(metric.running)}</strong>
          </span>
          <span className="service-telemetry-value" data-busy={validNumber(metric.queued) && metric.queued > 0}>
            <span>排队</span>
            <strong>{number(metric.queued)}</strong>
          </span>
          <span className="service-telemetry-value service-telemetry-gpu">
            <span>GPU</span>
            <strong>{percent(metric.gpuUtil)}</strong>
          </span>
          <span className="service-telemetry-value service-telemetry-cpu">
            <span>CPU</span>
            <strong>{percent(metric.cpuUtil)}</strong>
          </span>
          <span className="service-telemetry-value service-telemetry-temperature" title="GPU 温度">
            <span>温度</span>
            <strong>{number(metric.gpuTemperature, "°C")}</strong>
          </span>
          <span className="service-telemetry-value service-telemetry-power" title="GPU 功耗">
            <span>功耗</span>
            <strong>{number(metric.gpuPower, " W")}</strong>
          </span>
        </div>
      )}
    </footer>
  );
}
