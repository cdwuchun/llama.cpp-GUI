/**
 * 日志页的纯函数（组件文件只导出组件，工具放这里）。
 *
 * 上游「任务与日志」页的服务日志卡片是「时间 / 级别 / 内容」三列排版，级别来自
 * 后端结构化字段；我们的日志是子实例与 GUI 自己拼出来的纯文本，没有级别字段，
 * 只能按关键字推断 —— 只用于第二列的显示与配色，不参与过滤。
 */

import type { LogLine } from "../types";

export type LogLevel = "error" | "warn" | "info";

/** llama.cpp / Strata 常见写法：error、ERR、fatal、exception、failed、panic */
const ERROR_RE = /\b(?:error|err|fatal|panic|exception|failed|failure)\b/i;
const WARN_RE = /\b(?:warn|warning|timeout|timed out)\b/i;

/** 从一行日志文本推断级别（默认 info）。中文关键词单独判，`\b` 对中文不生效。 */
export function logLevelOf(text: string): LogLevel {
  if (ERROR_RE.test(text) || /失败|错误|异常|崩溃/.test(text)) return "error";
  if (WARN_RE.test(text) || /警告|超时/.test(text)) return "warn";
  return "info";
}

/** 时间列：只到秒，与上游 `toLocaleTimeString` 的默认口径一致。 */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 搜索框的匹配：只匹配正文（时间列不参与），query 传进来前已 trim + 小写。 */
export function matchesQuery(line: LogLine, query: string): boolean {
  return query.length > 0 && line.text.toLowerCase().includes(query);
}
