/**
 * 文档附件抽文本（P1）：聊天请求只能带文本，PDF / Word / Excel / PPT 先在本地解析。
 *
 * 解析库全部动态 import：只在真的附加这类文件时才下载对应 chunk，
 * 平时聊天页不为它们付包体代价。
 * 解析失败（扫描件 PDF、加密文件、损坏包）返回 null，由调用方给出可读的提示。
 */

/** 从 PDF 里抽文本（逐页 getTextContent） */
async function pdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  // worker 用 Vite 的 ?url 资源：Tauri 的 WebView 里没有 CDN，必须本地打包
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  try {
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) pages.push(line);
      page.cleanup();
    }
  } finally {
    // 各版本 pdfjs 的 destroy 类型声明不一致（运行时都有），按可选方法调用
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  }
  return pages.join("\n\n");
}

/** zip 包里的 XML → 纯文本：只认调用方给的标签，标签间换行由 `paragraph` 决定 */
function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function officeText(file: File): Promise<string> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(".docx")) {
    const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
    // 段内 <w:t> 是文字片段，段间用换行
    return xml
      .split("</w:p>")
      .map((paragraph) =>
        [...paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((match) => decodeXml(match[1])).join(""),
      )
      .filter((line) => line.trim())
      .join("\n");
  }
  if (name.endsWith(".pptx")) {
    const slides = Object.keys(zip.files)
      .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
    const blocks: string[] = [];
    for (const path of slides) {
      const xml = (await zip.file(path)?.async("string")) ?? "";
      const text = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)]
        .map((match) => decodeXml(match[1]))
        .join(" ")
        .trim();
      if (text) blocks.push(text);
    }
    return blocks.join("\n\n");
  }
  if (name.endsWith(".xlsx")) {
    const sharedXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
    const shared = [...sharedXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((match) => decodeXml(match[1]));
    const sheets = Object.keys(zip.files)
      .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
      .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0));
    const blocks: string[] = [];
    for (const path of sheets) {
      const xml = (await zip.file(path)?.async("string")) ?? "";
      const lines = xml
        .split("</row>")
        .map((row) => {
          const cells: string[] = [];
          for (const cell of row.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
            const attrs = cell[1];
            const value = /<v>([^<]*)<\/v>/.exec(cell[2])?.[1];
            if (value === undefined) continue;
            cells.push(/t="s"/.test(attrs) ? (shared[Number(value)] ?? "") : decodeXml(value));
          }
          return cells.join(" | ");
        })
        .filter((line) => line.trim());
      if (lines.length) blocks.push(lines.join("\n"));
    }
    return blocks.join("\n\n");
  }
  return "";
}

/** 文件是不是能抽文本的文档格式（按扩展名与 MIME 双判） */
export function isDocumentFile(file: File): boolean {
  return (
    /\.(pdf|docx|xlsx|pptx)$/i.test(file.name) ||
    file.type === "application/pdf" ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
}

/** 抽取文本；类型不认识或解析失败返回 null */
export async function extractDocumentText(file: File): Promise<string | null> {
  const text = /\.pdf$/i.test(file.name) || file.type === "application/pdf"
    ? await pdfText(file)
    : await officeText(file);
  const clean = text.replace(/\u0000/g, "").trim();
  return clean ? clean : null;
}

/**
 * 在 Web Worker 里抽文本（审查 F6）：解析放主线程会把界面卡住几秒。
 * Worker 不可用（旧内核 / 被 CSP 拦）或超时（120s）时退回主线程解析。
 */
export function extractDocumentTextAsync(file: File): Promise<string | null> {
  if (typeof Worker === "undefined") return extractDocumentText(file);
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./chatDocs.worker.ts", import.meta.url), { type: "module" });
    } catch {
      void extractDocumentText(file).then(resolve, reject);
      return;
    }
    const timer = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("解析超时（文档太大或格式异常）"));
    }, 120_000);
    worker.onmessage = (event: MessageEvent<{ text?: string | null; error?: string }>) => {
      window.clearTimeout(timer);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.text ?? null);
    };
    worker.onerror = (event) => {
      window.clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message || "文档解析失败"));
    };
    worker.postMessage({ file });
  });
}
