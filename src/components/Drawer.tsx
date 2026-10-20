import { useEffect, useRef, useState } from "react";

import { ErrorBoundary } from "./ErrorBoundary";

/**
 * 右侧抽屉外壳 —— 照上游 `.st-drawer`：固定贴右、宽 360px、左border、
 * 从右滑入（`translateX(100%)` → `none`，220ms）。
 *
 * 用户 m06312 第 4 点：聊天设置要照上游用抽屉，不要弹窗。上游那个是
 * `Dialog drawer`，本工程原本只有居中 `Modal`（Sheet.tsx），所以补这一个。
 *
 * 遮罩点一下关闭；Esc 也关（与 Modal 一致）。挂载后下一帧才置 `data-open`，
 * 否则初始就是 `transform:none`，滑入动画不会触发。
 */
export function Drawer({
  title,
  iconClass,
  onClose,
  footer,
  children,
}: {
  title: string;
  /** FontAwesome 图标类名，如 `fa-gear` */
  iconClass?: string;
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  // 调用方几乎都传内联箭头函数，进依赖会让监听反复解绑重绑
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const [open, setOpen] = useState(false);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <div className="st-drawer-mask" onMouseDown={() => onCloseRef.current()} />
      <aside
        className="st-drawer"
        data-open={open}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="st-drawer__head">
          <h3 className="st-drawer__title">
            <i className={`fas ${iconClass ?? "fa-gear"}`} />
            <span>{title}</span>
          </h3>
          <button
            type="button"
            className="st-drawer__close"
            onClick={() => onCloseRef.current()}
            title="关闭"
          >
            &times;
          </button>
        </div>
        <div className="st-drawer__body">
          {/* 出错时的兜底关闭不拦：界面已经崩了，再弹确认框只是让人点不动 */}
          <ErrorBoundary label={title} onClose={onClose}>
            {children}
          </ErrorBoundary>
        </div>
        {footer && <div className="st-drawer__foot">{footer}</div>}
      </aside>
    </>
  );
}
