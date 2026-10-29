/**
 * 数学公式识别（照上游 `serve/web/math.js` 的 `split`，0.1.52）。
 *
 * 只做「哪一段是公式」的判断，渲染交给 KaTeX。跳过代码围栏、行内代码与转义字符；
 * 认 `\( \)` / `\[ \]` / `$$ $$` / `$…$`（`$` 后面是空白或数字的不认，免得把价格当公式）；
 * 没闭合的按普通文字处理（上游的 `incomplete`）。
 */

export interface MathSource {
  source: string;
  display: boolean;
}

export type MathPiece =
  | { kind: "text"; text: string }
  | { kind: "math"; source: string; display: boolean };

/** 代码段（围栏 / 行内）整段跳过，公式一律不进来 */
function skipCode(text: string, start: number): number {
  const run = /^`+/.exec(text.slice(start))?.[0].length ?? 0;
  if (run === 0) return start + 1;
  const close = text.indexOf("`".repeat(run), start + run);
  return close === -1 ? start + run : close + run;
}

export function splitMath(text: string): MathPiece[] {
  const out: MathPiece[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (buffer) out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "`") {
      const end = skipCode(text, index);
      buffer += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1] ?? "";
      if (next === "(" || next === "[") {
        const closeMark = next === "(" ? "\\)" : "\\]";
        const close = text.indexOf(closeMark, index + 2);
        if (close !== -1) {
          const source = text.slice(index + 2, close);
          if (source.trim()) {
            flush();
            out.push({ kind: "math", source, display: next === "[" });
            index = close + 2;
            continue;
          }
        }
      }
      buffer += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "$") {
      if (text[index + 1] === "$") {
        const close = text.indexOf("$$", index + 2);
        if (close !== -1) {
          const source = text.slice(index + 2, close).trim();
          if (source) {
            flush();
            out.push({ kind: "math", source, display: true });
            index = close + 2;
            continue;
          }
        }
      } else {
        const next = text[index + 1] ?? "";
        // `$5` 是价格不是公式：后面是空白 / 数字 / 结尾都不认
        if (next && !/\s/.test(next) && !/[0-9]/.test(next)) {
          const close = text.indexOf("$", index + 1);
          if (close !== -1) {
            const source = text.slice(index + 1, close);
            if (source.trim() && !source.includes("\n")) {
              flush();
              out.push({ kind: "math", source, display: false });
              index = close + 1;
              continue;
            }
          }
        }
      }
      buffer += char;
      index += 1;
      continue;
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

/**
 * 交给 Markdown 之前把公式换成行内代码占位符（`` `@@math-0@@` ``）：
 * 行内代码里的内容不会被别的 Markdown 规则改写，排版完再由 `code` 渲染器换回公式。
 */
export function protectMath(text: string, enabled: boolean): { prepared: string; sources: MathSource[] } {
  if (!enabled) return { prepared: text, sources: [] };
  const sources: MathSource[] = [];
  let prepared = "";
  for (const piece of splitMath(text)) {
    if (piece.kind === "text") {
      prepared += piece.text;
      continue;
    }
    sources.push({ source: piece.source, display: piece.display });
    prepared += `\`@@math-${sources.length - 1}@@\``;
  }
  return { prepared, sources };
}

/** `code` 渲染器用来认出占位符 */
export const MATH_TOKEN = /^@@math-(\d+)@@$/;
