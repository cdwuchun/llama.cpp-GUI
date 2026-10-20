import React from "react";
import ReactDOM from "react-dom/client";

// 样式基座（S1，docs/archive/UI_STYLE_BASELINE.md §3）：--st-* token + 旧变量兼容别名层，
// 必须排在所有样式之前。S2（2026-10-16）已把 legacy/index.css 顶部的旧变量定义块删掉，
// 别名层自此真正接管。
import "./styles/tokens.css";

// hub 的样式体系，随后是本项目补充的少量样式。
// 注意：用的是 hub **默认首页**（index.html）那一套 —— css/index.css（= legacy/index.css），
// 不是 index-new.html 的 newui.css。用户看的是前者。
// S3（2026-10-15）：css2.css 已删除 —— 它那 19 条 @font-face（Orbitron / Press Start 2P /
// Roboto Mono）全站零引用，且 4 条 url 指向 woff2/ 里不存在的文件。
import "./styles/css/all.min.css";
import "./styles/legacy/index.css";
// 组件层（S7，2026-10-16）：类名与语义取自上游 Strata UI kit（serve/web/components.css），
// 数值换成本项目的 token。排在 legacy 之后（.st-* 与 473 个 hub 旧类名零冲突）、
// app.css 之前（页面级覆盖仍最后生效）。
import "./styles/components.css";
import "./styles/app.css";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { reportFrontendError } from "./utils/frontendLog";

// 全局错误上报：未捕获异常写入后端日志（日志页 frontend 来源）
window.addEventListener("error", (event) => {
  reportFrontendError(
    "window",
    `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportFrontendError(
    "promise",
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason),
  );
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="应用">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
