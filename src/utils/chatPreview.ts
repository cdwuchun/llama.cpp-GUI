/**
 * HTML / SVG 围栏的沙箱预览（照上游 `preview.js`，0.1.52）。
 *
 * 用 `iframe srcDoc` + `sandbox=""`（不给任何能力）：脚本、表单、跳转全禁；
 * 文档里再套一层 `Content-Security-Policy`，外链资源一律取不到 —— 只渲染内联样式与 data: 图片。
 * 上游允许一次性放开 html 脚本，本工程不放开（界面里也没有「信任这段代码」的入口）。
 */

export type PreviewKind = "html" | "svg";

export function canPreview(language: string, code: string): PreviewKind | null {
  if (!code.trim()) return null;
  const lang = language.toLowerCase();
  if (lang === "svg") return "svg";
  if (lang === "html" || lang === "htm") return "html";
  return null;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** 去掉 meta refresh：沙箱里跳转会整页替换，预览框变空白 */
function stripMetaRefresh(code: string): string {
  return code.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
}

export function previewFrameDoc(kind: PreviewKind, code: string): string {
  const body = stripMetaRefresh(code);
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (kind === "svg") {
    return `<!doctype html><html><head>${head}<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#fff}svg{max-width:100%;max-height:100%}</style></head><body>${body}</body></html>`;
  }
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}
