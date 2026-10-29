import { memo, useEffect, useState } from "react";

import { loadKatex, renderMath } from "../utils/katex";

/**
 * 一段公式（用户 m00232 的 A3）。
 *
 * KaTeX 是页面里按需注入的脚本（见 `utils/katex.ts`），第一次渲染时它还没到，
 * 这里先显示原文，脚本就绪后触发一次重渲染换成排版结果。
 * `dangerouslySetInnerHTML` 的 HTML 只来自 KaTeX 的 `renderToString`，不含模型原文。
 */
export const MathTex = memo(function MathTex({ source, display }: { source: string; display: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!ready) {
      void loadKatex().then((ok) => {
        if (alive && ok) setReady(true);
      });
    }
    return () => {
      alive = false;
    };
  }, [ready]);
  const html = renderMath(source, display);
  const className = display ? "chat-math chat-math--display" : "chat-math";
  if (!html) {
    return (
      <span className={`${className} chat-math--raw`} title="公式渲染不可用，显示原文">
        {display ? `$$${source}$$` : `$${source}$`}
      </span>
    );
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});
