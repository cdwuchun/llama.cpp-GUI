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
import { ipc } from "./ipc";
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

// 窗口是「隐藏创建」的（tauri.conf.json 的 `visible: false`）：WebView2 从创建到画出第一帧
// 有几百毫秒，那期间显示的是窗口底色，用户看到的就是「界面显示不全、一块一块黑」
// （用户 m03477）。等 React 把首屏挂上去（两帧之后，确保样式与首渲染都落到屏上）再让
// 后端 show。`--minimized` 自启动时后端会忽略这个调用，窗口继续留在托盘。
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void ipc.appBootFinished().catch((err) => {
      reportFrontendError("window", `显示主窗口失败：${String(err)}`);
    });
  });
});
