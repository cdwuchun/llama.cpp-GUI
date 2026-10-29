/**
 * KaTeX 懒加载（照上游 0.1.52 的自托管做法：`vendor/katex/` 整份随包发，不引 CDN）。
 *
 * 为什么不用 npm 包：本工程的样式规范禁止新增 `@font-face`，而 katex 的 CSS 自带 20 个字体声明；
 * 整份放在 `public/vendor/katex/` 由页面按需加载，既离线可用，又不把第三方样式混进 `tokens.css` 那套。
 * 加载失败就退回原文（渲染器返回 null，界面显示 `$…$` 原样），不影响正文。
 *
 * 运行时由 `ChatMath.tsx` 自己调，不阻塞首屏。
 */

const BASE = "/vendor/katex";
const SCRIPT = `${BASE}/katex.min.js`;
const STYLE = `${BASE}/katex.min.css`;

interface KatexGlobal {
  renderToString: (source: string, options: Record<string, unknown>) => string;
}

let loading: Promise<boolean> | null = null;
const cache = new Map<string, string>();

export function loadKatex(): Promise<boolean> {
  if (loading) return loading;
  loading = new Promise<boolean>((resolve) => {
    if (typeof document === "undefined") {
      resolve(false);
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = STYLE;
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.onload = () => resolve(Boolean((window as unknown as { katex?: KatexGlobal }).katex));
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return loading;
}

/** 渲染一段 TeX；KaTeX 还没加载 / 语法错时返回 null（界面退回原文） */
export function renderMath(source: string, display: boolean): string | null {
  const katex = (window as unknown as { katex?: KatexGlobal }).katex;
  if (!katex) return null;
  const key = `${display ? "1" : "0"}:${source}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const html = katex.renderToString(source, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      output: "html",
    });
    if (cache.size > 512) cache.clear();
    cache.set(key, html);
    return html;
  } catch {
    return null;
  }
}
