import React from "react";
import ReactDOM from "react-dom/client";

// hub 的样式体系（含 FontAwesome 图标字体与字体文件），随后是本项目补充的少量样式。
// 注意：用的是 hub **默认首页**（index.html）那一套 —— css/index.css + css/css2.css，
// 不是 index-new.html 的 newui.css。用户看的是前者。
import "./styles/css/all.min.css";
import "./styles/legacy/css2.css";
import "./styles/legacy/index.css";
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
