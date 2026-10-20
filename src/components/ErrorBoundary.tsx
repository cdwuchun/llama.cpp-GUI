import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportFrontendError } from "../utils/frontendLog";

interface Props {
  children: ReactNode;
  /** 出错时展示的标题 */
  label?: string;
  /** 提供后，出错面板会带一个「关闭」按钮 */
  onClose?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * 渲染错误边界。
 *
 * 没有它时，任何渲染期异常都会让整个 React 树卸载 —— 表现为整窗白屏、按钮全部失效。
 * 这里把错误就地显示，并保留关闭/重试的出口。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = this.props.label ?? "app";
    reportFrontendError(
      "react",
      `${where}: ${error.message}\n${error.stack ?? ""}\n组件栈:${info.componentStack ?? ""}`,
    );
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="notice error">
          <strong>{this.props.label ?? "界面"}渲染出错</strong>
          <pre className="code-block mt-2">
            {error.message}
          </pre>
          <div className="row">
            <button type="button" onClick={() => this.setState({ error: null })}>重试</button>
            {this.props.onClose && <button type="button" onClick={this.props.onClose}>关闭</button>}
          </div>
          <div className="form-text mt-1">
            详情已写入「日志」页的 frontend 来源，可直接复制反馈。
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
