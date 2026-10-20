import { Children, isValidElement, memo, useEffect, useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import type { ChatToolEvent, ChatTurn } from "../utils/chat";
import { ipc } from "../ipc";
import { describeToolCall, toolTitle } from "../utils/tools";
import { ChatIcon } from "./ChatIcons";
import { ChatExecutionStatus } from "./ChatExecutionStatus";

/** 代码块：右上角带语言名与复制按钮（照上游 `CodeBlock`） */
function CodeBlock({ children, onCopy }: { children?: ReactNode; onCopy: (value: string) => void }) {
  const child = Children.toArray(children)[0];
  const props = isValidElement<{ children?: ReactNode; className?: string }>(child) ? child.props : {};
  const text = String(props.children ?? "").replace(/\n$/, "");
  const language = props.className?.replace(/^language-/, "") ?? "";
  return (
    <div className="st-code">
      <div className="st-code__head">
        <span>{language}</span>
        <button
          type="button"
          className="st-btn st-btn--icon"
          title="复制代码"
          aria-label="复制代码"
          onClick={() => onCopy(text)}
        >
          <ChatIcon name="copy" size={16} />
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const Markdown = memo(function Markdown({ text, onCopy }: { text: string; onCopy: (value: string) => void }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => <CodeBlock onCopy={onCopy}>{children}</CodeBlock>,
        code: ({ className, children, ...props }) => (
          <code className={className ?? "inline"} {...props}>
            {children}
          </code>
        ),
        // 网页链接交给系统浏览器打开（用户 m07200 第 2 点）。
        // WebView2 里直接跳转会把整个界面替换成网页，且没有后退入口。
        a: ({ href, children }) => (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              if (href) void ipc.openExternal(href).catch(() => undefined);
            }}
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

const TOOL_BADGE: Record<string, string> = {
  writing: "st-badge--reading",
  running: "st-badge--generating",
  done: "st-badge--ok",
  completed: "st-badge--ok",
  error: "st-badge--error",
  skipped: "st-badge--queued",
};

const TOOL_STATE_TEXT: Record<string, string> = {
  writing: "准备中",
  running: "执行中",
  error: "失败",
  skipped: "已跳过",
  done: "完成",
  completed: "完成",
  limit: "超出轮次",
};

/** 一次工具调用（工具由 GUI 执行，见 `src/utils/tools.ts`） */
function ToolCall({ tool }: { tool: ChatToolEvent }) {
  const args = tool.arguments == null ? "" : JSON.stringify(tool.arguments, null, 2);
  // 摘要行始终显示「搜什么」：结果的正文以 `<untrusted-web-content>` 开头，
  // 拿它当预览等于把边界标签怼到脸上（用户 m07347 截图），结果放展开里看
  const preview =
    tool.arguments && typeof tool.arguments === "object"
      ? describeToolCall(tool.name, tool.arguments as Record<string, unknown>)
      : (tool.result ?? args.replace(/\s+/g, " "));
  const badge = TOOL_BADGE[tool.status] ?? "";
  const ms = typeof tool.raw?.ms === "number" ? tool.raw.ms : null;
  return (
    <details className="st-collapse tool-call" data-state={tool.status}>
      <summary>
        <ChatIcon name="tool" size={16} />
        <span className="tool-call__name">{toolTitle(tool.name)}</span>
        <span className="tool-call__preview muted">{preview.slice(0, 200)}</span>
        <span className={`st-badge ${badge}`}>{TOOL_STATE_TEXT[tool.status] ?? tool.status}</span>
        {ms !== null && tool.status !== "skipped" && (
          <span className="muted small">{(ms / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} s</span>
        )}
        <ChatIcon name="chevron" size={16} className="st-chev" />
      </summary>
      <div className="st-collapse__body">
        {tool.note && <p className="st-hint">{tool.note}</p>}
        <div className="tool-call__label">参数</div>
        <pre className="tool-call__pre">{args || "（还没写）"}</pre>
        {tool.result != null && (
          <>
            <div className="tool-call__label">结果</div>
            <pre className="tool-call__pre">{tool.result}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/**
 * 一条消息（照上游 `ChatMessageView.tsx`）。
 *
 * 用户消息就是气泡 + 时间；助手消息按顺序排：执行状态条 → 思考折叠块 → 正文，
 * 正文里的工具调用按 `tool.at`（字符下标）切开插入，最后一行是元信息与复制按钮。
 */
export const ChatMessageView = memo(function ChatMessageView({
  message,
  showReasoning,
  streaming,
  onCopy,
}: {
  message: ChatTurn;
  showReasoning: boolean;
  streaming: boolean;
  onCopy: (value: string) => void;
}) {
  const reasoning = useRef<HTMLDetailsElement>(null);
  const touched = useRef(false);
  const thinkingNow = streaming && !message.content;

  // 思考块自动开合：用户手动点过之后就不再托管（上游同）
  useEffect(() => {
    if (reasoning.current && !touched.current) reasoning.current.open = thinkingNow && showReasoning;
  }, [thinkingNow, showReasoning]);

  const fmt = (value: number, digits = 1) =>
    value.toLocaleString("zh-CN", { maximumFractionDigits: digits });

  if (message.role === "user") {
    return (
      <div className="st-msg st-msg--user">
        {Boolean(message.attachments?.length) && (
          <div className="msg-images">
            {message.attachments!.map((file) =>
              file.type === "image" && file.content ? (
                <img src={file.content} alt={file.name} key={file.id} />
              ) : (
                <span className="chip" key={file.id}>
                  <ChatIcon name="attach" size={14} />
                  {file.name}
                </span>
              ),
            )}
          </div>
        )}
        <div className="st-bubble">{message.content}</div>
        <div className="st-msg__meta">
          你 ·{" "}
          {new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
    );
  }

  const completion =
    typeof message.usage?.completion_tokens === "number"
      ? message.usage.completion_tokens
      : typeof message.usage?.output_tokens === "number"
        ? message.usage.output_tokens
        : null;
  const elapsed =
    message.elapsedMs != null ? Math.max(0, (message.elapsedMs - (message.firstTokenMs ?? 0)) / 1000) : null;
  const ran = message.tools?.filter((tool) => ["done", "error", "completed"].includes(tool.status)).length ?? 0;
  // token 后面接着报预填充 / 解码 / 草稿命中率（用户 m06312 第 1 点）。
  // 三个数都来自 llama.cpp 流末尾的 `timings`，没开投机解码时草稿命中率是 null，整项不显示。
  const speed = message.speed;
  const segments: string[] = [];
  if (completion) segments.push(`${completion} token`);
  if (speed?.prefillTokS !== undefined) segments.push(`预填充 ${fmt(speed.prefillTokS)} tok/s`);
  if (speed?.decodeTokS !== undefined) segments.push(`解码 ${fmt(speed.decodeTokS)} tok/s`);
  if (speed?.draftAccept != null) segments.push(`草稿命中 ${(speed.draftAccept * 100).toFixed(1)}%`);
  if (!speed && !message.execution && completion && elapsed != null && elapsed > 0.25) {
    segments.push(`${fmt(completion / elapsed)} tok/s`);
  }
  if (message.stopped) segments.push("已停止");
  if (ran) segments.push(`${ran} 次工具调用`);
  const meta = streaming ? "" : segments.join(" · ");

  // 正文按工具调用位置切开：文字 → 工具 → 文字 → …
  const answer: ReactNode[] = [];
  let position = 0;
  for (const [index, tool] of (message.tools ?? []).entries()) {
    const at = Math.min(Math.max(tool.at ?? 0, position), message.content.length);
    if (at > position) {
      answer.push(<Markdown key={`text-${index}`} text={message.content.slice(position, at)} onCopy={onCopy} />);
    }
    answer.push(<ToolCall key={tool.id ?? index} tool={tool} />);
    position = at;
  }
  if (position < message.content.length) {
    answer.push(<Markdown key="tail" text={message.content.slice(position)} onCopy={onCopy} />);
  }

  return (
    <div className="st-msg st-msg--assistant">
      {message.execution && <ChatExecutionStatus execution={message.execution} streaming={streaming} />}
      <details ref={reasoning} className="st-collapse think" hidden={!message.reasoning}>
        <summary
          onClick={() => {
            touched.current = true;
          }}
        >
          <ChatIcon name="think" size={16} />
          <span className="think-title">
            {thinkingNow
              ? "正在思考…"
              : message.reasoningMs != null
                ? `思考了 ${fmt(message.reasoningMs / 1000)} 秒`
                : "思考过程"}
          </span>
          <ChatIcon name="chevron" size={16} className="st-chev" />
        </summary>
        <div className="st-collapse__body thinking">{message.reasoning}</div>
      </details>
      <div className={`st-bubble ${streaming && message.content ? "cursor" : ""}`}>
        {message.error && (
          <div className="msg-error" role="alert">
            {message.error}
          </div>
        )}
        {!message.content && streaming && !message.tools?.length ? (
          message.reasoning ? (
            <span className="muted cursor">正在写答案…</span>
          ) : (
            <span className="cursor" />
          )
        ) : (
          <>{answer}</>
        )}
      </div>
      <div className="st-msg__meta">
        <span className="meta-text">{meta}</span>
        {!streaming && message.content && (
          <button
            type="button"
            className="st-btn st-btn--icon"
            title="复制回答"
            aria-label="复制回答"
            onClick={() => onCopy(message.content)}
          >
            <ChatIcon name="copy" size={16} />
          </button>
        )}
      </div>
    </div>
  );
});
