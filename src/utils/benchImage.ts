/**
 * 把一次上下文档位压测的结果画成一张 PNG（上游 `contextBenchmarkImage.ts` 的移植）。
 *
 * 上游用弹窗展示图片让用户自己另存；这里生成 Blob 后直接写系统剪贴板，
 * 写不进去再退回预览对话框（见 `ContextBenchPanel` 的调用处）。
 *
 * 与上游的差别只因为本工程没有的东西：不做 identity / 条件核验（P4 监控采集层未落地，
 * 报告里没有测量身份字段），所以脚注里不提「条件匹配」，只说明口径。
 */

import type { ContextBenchmarkReport, ContextBenchmarkSample } from "./contextBenchmark";
import { contextTierLabel } from "./contextBenchmark";

interface ChartSnapshot {
  title: string;
  unit: string;
  svg: string;
  width: number;
  height: number;
}

interface Column {
  title: string;
  unit: string;
  weight: number;
  value: (sample: ContextBenchmarkSample) => string;
}

const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
/** 画布单边上限与总像素上限（浏览器对 canvas 有硬限制，超了会静默变白） */
const MAX_EDGE = 8192;
const MAX_PIXELS = 32 * 1024 * 1024;

/**
 * 允许从计算样式里搬进 SVG 的呈现属性。
 *
 * SVG 被序列化成 `<img>` 之后再绘制到 canvas 时读不到页面 CSS，
 * 颜色/字号必须内联进元素本身，否则导出的图是黑白的或字号丢失。
 */
const SVG_STYLES = [
  "color",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "visibility",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "vector-effect",
] as const;

/** 抓取三张图表的 SVG 快照（必须在任何 await 之前同步调用，否则用户切页就拿不到了） */
function captureCharts(root: HTMLElement): ChartSnapshot[] {
  const sections = Array.from(root.querySelectorAll<HTMLElement>(".st-chart"));
  if (sections.length !== 3) throw new Error("无法读取三张图表，请等图表显示后重试。");

  return sections.map((section) => {
    const svg = section.querySelector<SVGSVGElement>(".st-chart__box svg") ?? section.querySelector("svg");
    if (!svg) throw new Error("图表里没有 SVG，请刷新后重试。");
    if (svg.querySelector("foreignObject, image, use, script")) {
      throw new Error("图表不是可安全导出的 SVG，请刷新后重试。");
    }

    const box = svg.getBoundingClientRect();
    const width = svg.viewBox.baseVal.width || box.width;
    const height = svg.viewBox.baseVal.height || box.height;
    if (!(width > 0 && height > 0)) throw new Error("图表尚未完成布局，暂时无法导出。");

    // 克隆整张图，把计算样式内联进去；class 名在导出图里没有对应样式表，必须先剥掉
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const sources = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
    const targets = [copy, ...Array.from(copy.querySelectorAll<SVGElement>("*"))];
    sources.forEach((source, index) => {
      const target = targets[index];
      if (!target) return;
      const computed = getComputedStyle(source);
      target.removeAttribute("class");
      for (const property of SVG_STYLES) {
        const value = computed.getPropertyValue(property);
        if (!value || value === "none" && property === "fill") continue;
        const normalized = value === "currentcolor" ? computed.color : value;
        if (normalized) target.style.setProperty(property, normalized);
      }
      // SVG 图片加载不到页面字体，统一换成系统字体，字号/字重留着
      target.style.setProperty("font-family", FONT);
    });

    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(width));
    copy.setAttribute("height", String(height));

    const heading = section.querySelector(".st-chart__title");
    const title = (heading?.firstChild?.textContent ?? heading?.textContent ?? "图表").trim();
    const unit = heading?.querySelector("span")?.textContent?.trim() ?? "";

    return {
      title: title || "图表",
      unit,
      svg: new XMLSerializer().serializeToString(copy),
      width,
      height,
    };
  });
}

/** SVG 序列化 → Blob URL → Image；15 秒没 loaded 就当失败（不留悬挂的 Promise） */
function loadSvg(snapshot: ChartSnapshot): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([snapshot.svg], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    const timer = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error("图表转换失败，请重试。"));
    }, 15_000);
    image.onload = () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error("图表转换失败，请重试。"));
    };
    image.src = url;
  });
}

/** 按字符逐个量宽度断行（中文没有空格，按词断行会整段溢出去） */
function wrap(context: CanvasRenderingContext2D, value: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const char of paragraph) {
      const next = line + char;
      if (line && context.measureText(next).width > width) {
        lines.push(line);
        line = char;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

function readTheme(root: HTMLElement): Record<string, string> {
  const computed = getComputedStyle(root);
  const pick = (name: string, fallback: string): string => computed.getPropertyValue(name).trim() || fallback;
  return {
    bg: pick("--st-bg", "#f9fafb"),
    surface: pick("--st-surface", "#ffffff"),
    surface2: pick("--st-surface-2", "#f7f7f7"),
    ink: pick("--st-ink", "#221e1f"),
    muted: pick("--st-ink-muted", "#6f6f6f"),
    line: pick("--st-line", "#dee5ee"),
    danger: pick("--st-danger-text", "#b01a2e"),
    warn: pick("--st-warn-text", "#8a5a00"),
  };
}

const STATE_TEXT: Record<string, string> = { completed: "完成", failed: "失败", cancelled: "已停止" };

/**
 * 生成压测结果 PNG。
 *
 * `root` 是包住三张图表的那个节点（导出时既读它的 CSS 变量取主题色，也在其中找 `.st-chart`）。
 * 报告与图表快照都在第一个 await 之前取好，用户中途切页也不会画出半张图。
 */
export async function createBenchImage(report: ContextBenchmarkReport, root: HTMLElement): Promise<Blob> {
  if (report.samples.length === 0) throw new Error("没有可导出的测量结果，请先完成一次测试。");

  const charts = captureCharts(root);
  const theme = readTheme(root.closest(".page-fill") ?? root);
  const images = await Promise.all(charts.map(loadSvg));
  await document.fonts.ready;

  const number = (value: number | null, digits = 1): string =>
    value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
  const date = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) return "—";
    return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  };

  const width = 1600;
  const margin = 40;
  const innerWidth = width - margin * 2;
  const gap = 18;
  const chartWidth = (innerWidth - gap * 2) / 3;
  const plotWidth = chartWidth - 28;
  const chartHeight = Math.max(...charts.map((chart) => (plotWidth / chart.width) * chart.height)) + 66;

  const options = report.options;
  const rounds = options.rounds;
  const columns: Column[] = [
    { title: "档位", unit: "", weight: 1, value: (s) => contextTierLabel(s.targetTokens) },
    ...(rounds > 1
      ? [{ title: "轮次", unit: "", weight: 0.55, value: (s: ContextBenchmarkSample) => String(s.round + 1) }]
      : []),
    { title: "实际输入", unit: "token", weight: 1.15, value: (s) => number(s.promptTokens, 0) },
    { title: "实际输出", unit: "token", weight: 1, value: (s) => number(s.completionTokens, 0) },
    { title: "预填充", unit: "tok/s", weight: 1.1, value: (s) => number(s.prefillTokS) },
    { title: "解码", unit: "tok/s", weight: 1, value: (s) => number(s.decodeTokS) },
    {
      title: "草稿命中率",
      unit: "%",
      weight: 0.95,
      value: (s) => (s.draftAccept === null ? "—" : `${(s.draftAccept * 100).toFixed(1)}%`),
    },
    {
      title: "整卡显存峰值",
      unit: "MiB",
      weight: 1.4,
      value: (s) => (s.peakGpuMemory === null ? "—" : number(s.peakGpuMemory / 2 ** 20, 0)),
    },
    {
      title: "最低空闲显存",
      unit: "MiB",
      weight: 1.45,
      value: (s) => (s.minGpuMemoryFree === null ? "—" : number(s.minGpuMemoryFree / 2 ** 20, 0)),
    },
    { title: "RAM 峰值", unit: "GiB", weight: 1, value: (s) => (s.peakRam === null ? "—" : number(s.peakRam / 2 ** 30)) },
    { title: "总耗时", unit: "s", weight: 1, value: (s) => number(s.wallMs / 1000, 2) },
    { title: "状态", unit: "", weight: 1, value: (s) => STATE_TEXT[s.state] ?? s.state },
  ];
  const totalWeight = columns.reduce((sum, column) => sum + column.weight, 0);
  const columnWidths = columns.map((column) => (column.weight / totalWeight) * innerWidth);

  const meta: string[] = [
    `模型：${report.model}`,
    `配置：${options.configurationLabel || report.model}`,
    `时间：${date(report.startedAt)} · ${STATE_TEXT[report.state] ?? report.state} · 用时 ${(report.elapsedMs / 1000).toFixed(0)} 秒`,
    `上限 ${report.maxContext === null ? "未报告" : contextTierLabel(report.maxContext)} · 输出上限 ${options.maxTokens} token · 每档 ${rounds} 轮 · 单请求超时 ${(options.timeoutMs / 1000).toFixed(0)} 秒`,
  ];

  const chartTop = margin + 54 + meta.length * 27 + 25;
  const tableTop = chartTop + chartHeight + 58;

  const measure = document.createElement("canvas").getContext("2d");
  if (!measure) throw new Error("当前环境无法生成 PNG 图片。");
  measure.font = `15px ${FONT}`;

  const headerLines = columns.map((column, index) => wrap(measure, column.title, columnWidths[index] - 20));
  const headerHeight = Math.max(...headerLines.map((lines) => lines.length)) * 21 + 40;
  const rowCells = report.samples.map((sample) =>
    columns.map((column, index) => wrap(measure, column.value(sample), columnWidths[index] - 20)),
  );
  const rowHeights = rowCells.map((cells, index) => {
    const sample = report.samples[index];
    const extra = sample.error ? wrap(measure, sample.error, innerWidth - 20).length * 21 + 10 : 0;
    return Math.max(...cells.map((lines) => lines.length)) * 21 + 26 + extra;
  });

  const notes: string[] = [
    "图表是按档位取成功请求的均值；表格逐条保留每一次测量，缺失值记作「—」。",
    "显存/内存是整机读数，可能包含其它程序；吞吐取自引擎自报的 timings（纯计算时间），总耗时是端到端墙钟。",
    "输入量按字符估算、再用首轮 usage 的 prompt_tokens 回修，因此实际输入与目标档位可能差几个百分点。",
    ...report.skipped.map((tier) => `已跳过 ${contextTierLabel(tier.tier)} · ${tier.reason}`),
  ];

  const height = Math.ceil(
    tableTop + headerHeight + rowHeights.reduce((sum, value) => sum + value, 0) + 28 + notes.length * 23 + margin,
  );

  const scale = Math.min(2, MAX_EDGE / width, MAX_EDGE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  if (scale < 1) throw new Error("结果太大，单张图片放不下，请用表格里的数字另存。");

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(width * scale);
  canvas.height = Math.floor(height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前环境无法生成 PNG 图片。");

  try {
    context.scale(scale, scale);
    context.textBaseline = "top";
    context.fillStyle = theme.bg;
    context.fillRect(0, 0, width, height);

    context.fillStyle = theme.ink;
    context.font = `bold 30px ${FONT}`;
    context.fillText("llama.cpp GUI · 上下文档位实测", margin, margin);

    meta.forEach((line, index) => {
      context.fillStyle = index < 2 ? theme.ink : theme.muted;
      context.font = `${index < 2 ? "bold " : ""}17px ${FONT}`;
      context.fillText(line, margin, margin + 54 + index * 27);
    });

    charts.forEach((chart, index) => {
      const x = margin + index * (chartWidth + gap);
      context.fillStyle = theme.surface;
      context.fillRect(x, chartTop, chartWidth, chartHeight);
      context.strokeStyle = theme.line;
      context.lineWidth = 1;
      context.strokeRect(x + 0.5, chartTop + 0.5, chartWidth - 1, chartHeight - 1);

      context.fillStyle = theme.ink;
      context.font = `bold 18px ${FONT}`;
      context.fillText(chart.title, x + 14, chartTop + 18);
      context.fillStyle = theme.muted;
      context.font = `14px ${FONT}`;
      context.textAlign = "right";
      context.fillText(chart.unit, x + chartWidth - 14, chartTop + 22);
      context.textAlign = "left";

      const plotHeight = chartHeight - 66;
      context.drawImage(images[index], x + 14, chartTop + 54, plotWidth, plotHeight);
    });

    // 表头带
    context.fillStyle = theme.surface2;
    context.fillRect(margin, tableTop, innerWidth, headerHeight);
    let cursor = margin;
    headerLines.forEach((lines, index) => {
      context.fillStyle = theme.ink;
      context.font = `bold 15px ${FONT}`;
      context.fillText(lines[0] ?? "", cursor + 10, tableTop + 12);
      if (columns[index].unit) {
        context.fillStyle = theme.muted;
        context.font = `13px ${FONT}`;
        context.fillText(columns[index].unit, cursor + 10, tableTop + headerHeight - 25);
      }
      cursor += columnWidths[index];
    });

    let rowTop = tableTop + headerHeight;
    rowCells.forEach((cells, rowIndex) => {
      const sample = report.samples[rowIndex];
      const rowHeight = rowHeights[rowIndex];
      context.fillStyle = rowIndex % 2 === 1 ? theme.surface2 : theme.surface;
      context.fillRect(margin, rowTop, innerWidth, rowHeight);

      let left = margin;
      cells.forEach((lines, index) => {
        context.fillStyle =
          columns[index].title === "状态"
            ? sample.state === "failed"
              ? theme.danger
              : sample.state === "cancelled"
                ? theme.warn
                : theme.ink
            : theme.ink;
        context.font = `16px ${FONT}`;
        lines.forEach((line, lineIndex) => context.fillText(line, left + 10, rowTop + 12 + lineIndex * 21));
        left += columnWidths[index];
      });
      if (sample.error) {
        context.fillStyle = theme.danger;
        context.font = `14px ${FONT}`;
        wrap(context, sample.error, innerWidth - 20).forEach((line, lineIndex) =>
          context.fillText(line, margin + 10, rowTop + rowHeight - 10 - (lineIndex + 1) * 21 + 21),
        );
      }

      context.strokeStyle = theme.line;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(margin, rowTop + rowHeight - 0.5);
      context.lineTo(margin + innerWidth, rowTop + rowHeight - 0.5);
      context.stroke();
      rowTop += rowHeight;
    });

    context.fillStyle = theme.muted;
    context.font = `14px ${FONT}`;
    notes.forEach((line, index) => {
      context.fillText(line, margin, rowTop + 14 + index * 23);
    });

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG 编码失败，请重试。");
    return blob;
  } catch (error) {
    throw new Error("图片导出失败，请重试。", { cause: error });
  }
}
