import { useCallback, useEffect, useRef } from "react";

import { ErrorBoundary } from "./ErrorBoundary";

/**
 * 弹窗外壳 —— 与 hub 的 `#loadModelModal` 同构：
 * `.modal.show` > `.modal-content.load-model-modal` > header / body / footer。
 * 遮罩是 `.modal` 自身（点击空白处关闭），没有额外的 mask 元素。
 *
 * `domId` 很关键：hub 的 index.css 把参数表单、双栏布局、灰显规则全部写成
 * `#loadModelModal ...` 的形式，带上同一个 id 才能拿到这些样式。
 *
 * `confirmClose` 是给「有几十个参数、误触一次全丢」的表单用的：返回 false 就不关。
 * Esc / 点遮罩 / 右上角 × 三条关闭通路都走它。
 */
export function Modal({
  domId,
  title,
  icon,
  iconClass,
  onClose,
  confirmClose,
  bodyClass,
  footer,
  children,
}: {
  domId?: string;
  title: string;
  /** 有则用图片图标，否则用 `iconClass`（默认上传图标） */
  icon?: string | null;
  /** FontAwesome 图标类名，如 `fa-rotate-right`；不传沿用默认的上传图标 */
  iconClass?: string;
  onClose: () => void;
  /** 关闭前询问；返回 false 表示「不关」。异步也支持（留着给将来的界面库确认框） */
  confirmClose?: () => boolean | Promise<boolean>;
  bodyClass?: string;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  // onClose / confirmClose 用 ref 存：调用方几乎都传内联箭头函数，每次渲染都是新引用，
  // 直接进 useEffect 依赖会让键盘监听反复解绑重绑（滚动、输入时每帧都在重建监听）。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const confirmCloseRef = useRef(confirmClose);
  confirmCloseRef.current = confirmClose;

  const requestClose = useCallback(async () => {
    const confirm = confirmCloseRef.current;
    if (confirm && !(await confirm())) return;
    onCloseRef.current();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return (
    <div
      className="modal show"
      id={domId}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <div className={`modal-content ${bodyClass ?? ""}`}>
        <div className="modal-header">
          <h3 className="modal-title">
            {icon ? (
              <img src={icon} alt="" className="sheet-icon" />
            ) : (
              <i className={`fas ${iconClass ?? "fa-upload"}`} />
            )}
            <span>{title}</span>
          </h3>
          <button type="button" className="modal-close" onClick={() => void requestClose()} title="关闭">
            &times;
          </button>
        </div>
        <div className="modal-body">
          {/* 出错时的兜底关闭不拦：界面已经崩了，再弹确认框只是让人点不动 */}
          <ErrorBoundary label={title} onClose={onClose}>
            {children}
          </ErrorBoundary>
        </div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  );
}
