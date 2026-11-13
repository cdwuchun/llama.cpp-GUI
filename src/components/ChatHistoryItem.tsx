import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import type { Conversation } from "../utils/chat";

/** 悬停多久才出提示（原生 title 的默认延迟也是这个量级，DSH 的 Tooltip 同样有短暂延迟） */
const TIP_DELAY_MS = 300;
const TIP_WIDTH = 280;

/**
 * 历史栏里的一条（从 ChatPanel 里拆出来的，审查 Q1）。
 * 点主体切换会话，行内改名。删除**一次点击就删**，撤销交给 ChatPanel 底部那条 10 秒 toast
 * （原来的「点两次才真删」已按用户要求去掉）。
 *
 * 标题溢出时的完整名称提示用自绘浮层（跟 DSH 的 Tooltip 一样 portal 到 body、
 * 深色小气泡），不用原生 title —— 原生那个是系统灰框、延迟和样式都不可控。
 */
export function ChatHistoryItem({
  item,
  active,
  disabled,
  onSelect,
  onRename,
  onDelete,
}: {
  item: Conversation;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [tip, setTip] = useState<{ top: number; left: number } | null>(null);
  const tipTimer = useRef<number | null>(null);

  useEffect(() => {
    setTitle(item.title);
  }, [item.title]);

  useEffect(
    () => () => {
      if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    },
    [],
  );

  const hideTip = () => {
    if (tipTimer.current !== null) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
    setTip(null);
  };

  const showTip = (element: HTMLElement) => {
    hideTip();
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null;
      const rect = element.getBoundingClientRect();
      // 提示放左边栏右侧（历史栏在左，右侧是消息区，空间足够）
      const left = Math.min(rect.right + 10, Math.max(12, window.innerWidth - TIP_WIDTH - 12));
      const top = Math.min(Math.max(rect.top, 12), Math.max(12, window.innerHeight - 120));
      setTip({ top, left });
    }, TIP_DELAY_MS);
  };

  if (renaming) {
    return (
      <div className={`chat-history-item${active ? " is-active" : ""}`}>
        <input
          className="st-input chat-history-rename"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            onRename(title);
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRename(title);
              setRenaming(false);
            }
            if (event.key === "Escape") {
              setTitle(item.title);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`chat-history-item${active ? " is-active" : ""}`}
      onMouseEnter={(event) => showTip(event.currentTarget)}
      onMouseLeave={hideTip}
      onFocus={(event) => showTip(event.currentTarget)}
      onBlur={hideTip}
    >
      <button
        type="button"
        className="chat-history-select"
        aria-current={active ? "true" : undefined}
        disabled={disabled}
        onClick={onSelect}
      >
        <span>{item.title || "未命名会话"}</span>
      </button>
      <div className="chat-history-actions">
        <button
          type="button"
          className="st-btn st-btn--icon"
          disabled={disabled}
          title="重命名"
          aria-label={`重命名：${item.title}`}
          onClick={() => setRenaming(true)}
        >
          <i className="fas fa-pen" />
        </button>
        <button
          type="button"
          className="st-btn st-btn--icon chat-history-delete"
          disabled={disabled}
          title="删除"
          aria-label={`删除：${item.title}`}
          onClick={onDelete}
        >
          <i className="fas fa-trash-can" />
        </button>
      </div>
      {tip &&
        createPortal(
          <div
            className="chat-history-tip"
            role="tooltip"
            style={
              {
                "--tip-top": `${tip.top}px`,
                "--tip-left": `${tip.left}px`,
              } as CSSProperties
            }
          >
            <strong>{item.title || "未命名会话"}</strong>
            <small>
              {new Date(item.updatedAt).toLocaleString("zh-CN", {
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              · {item.messages.length} 条消息
            </small>
          </div>,
          document.body,
        )}
    </div>
  );
}
