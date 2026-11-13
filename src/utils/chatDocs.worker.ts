/**
 * 文档解析的 Web Worker（审查 F6）：PDF/Office 抽文本是纯 CPU 活，20 MB 的 PDF 在
 * 渲染线程里解析会把输入框卡住几秒；放进 worker 后界面照常响应。
 *
 * 只做「解析并回传文本」，错误原样回传，由主线程决定怎么提示。
 */

import { extractDocumentText } from "./chatDocs";

// Worker 全局对象：tsconfig 的 lib 是 DOM（没有 DedicatedWorkerGlobalScope），
// 这里用结构化类型绕开 lib 冲突，运行期就是 worker 的 self。
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ file: File }>) => void) | null;
  postMessage: (message: unknown) => void;
};

scope.onmessage = (event) => {
  void (async () => {
    try {
      const text = await extractDocumentText(event.data.file);
      scope.postMessage({ text });
    } catch (error) {
      scope.postMessage({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
