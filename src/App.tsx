import { Fragment, useEffect, useState } from "react";

import { BenchPanel } from "./components/BenchPanel";
import { LogPanel } from "./components/LogPanel";
import { ModelListPanel } from "./components/ModelListPanel";
import { RuntimePanel } from "./components/RuntimePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { StrataPanel } from "./components/StrataPanel";
import { onTrayCommand } from "./ipc";
import { useApp } from "./store";
import { appLogo } from "./utils/modelIcon";

type Tab = "models" | "bench" | "runtime" | "strata" | "logs" | "settings";

/**
 * 页面外壳照搬 hub 默认首页（index.html）的结构：
 * body 是 flex 容器 → `.sidebar` + 若干个同级 `<main class="main-area">`，
 * 页面切换＝切换哪个 main 可见。这里由 React 按 tab 只渲染一个 main。
 */
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "models", label: "模型列表", icon: "fas fa-cubes" },
  { id: "bench", label: "性能测试", icon: "fas fa-gauge-high" },
  { id: "runtime", label: "运行环境", icon: "fas fa-microchip" },
  { id: "strata", label: "Strata", icon: "fas fa-layer-group" },
  { id: "logs", label: "系统日志", icon: "fas fa-terminal" },
  { id: "settings", label: "设置", icon: "fas fa-cog" },
];

export default function App() {
  const init = useApp((s) => s.init);
  const initialized = useApp((s) => s.initialized);
  const resetInit = useApp((s) => s.resetInit);
  const error = useApp((s) => s.error);
  const notice = useApp((s) => s.notice);
  const setError = useApp((s) => s.setError);
  const setNotice = useApp((s) => s.setNotice);
  const status = useApp((s) => s.status);
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => s.busy);
  const startRouter = useApp((s) => s.startRouter);
  const stopRouter = useApp((s) => s.stopRouter);
  const openModelChat = useApp((s) => s.openModelChat);
  const strataStatus = useApp((s) => s.strataStatus);
  const startStrata = useApp((s) => s.startStrata);
  const stopStrata = useApp((s) => s.stopStrata);

  const [tab, setTab] = useState<Tab>("models");
  const [navOpen, setNavOpen] = useState(false);
  // 主题放在 store 里（设置页顶栏也要用它切换）
  const theme = useApp((s) => s.theme);

  useEffect(() => {
    void init();
  }, [init]);

  /**
   * 托盘菜单的「启动服务 / 停止服务」：后端把命令以事件发过来，这里交给 store，
   * 于是托盘按钮与界面按钮走同一条路径（含 preset 同步、错误提示、状态刷新）。
   */
  useEffect(() => {
    const pending = onTrayCommand((command) => {
      const store = useApp.getState();
      if (command === "start-router") void store.startRouter();
      else if (command === "stop-router") void store.stopRouter();
    });
    return () => {
      void pending.then((off) => off());
    };
  }, []);

  // 主题落到 <html data-theme>（hub 的深色变量挂在这个属性上）；
  // localStorage 由 store 的 setTheme 负责写，这里只保证首帧一致。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // 窄屏抽屉：hub 用 body.mobile-nav-open 控制侧栏与遮罩
  useEffect(() => {
    document.body.classList.toggle("mobile-nav-open", navOpen);
    return () => document.body.classList.remove("mobile-nav-open");
  }, [navOpen]);

  // 通知自动消失：之前提示一直挂在屏幕上（例如"已自动同步 17 个模型段"），
  // 需要手动点掉。提示类 5 秒、错误类 15 秒；点一下也能立刻关掉。
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 15000);
    return () => clearTimeout(timer);
  }, [error, setError]);

  const current = TABS.find((t) => t.id === tab);

  /**
   * 提示文字 → hub 旧版通知的结构（图标 + 标题 + 内容 + 关闭按钮）。
   *
   * hub 的 `showToast(title, msg, type)` 固定两段：标题是分类（如「错误」），内容是具体信息。
   * 我们沿用这个约定：文本里带换行时第一行当标题（`模型加载\n模型 xxx 加载成功`），
   * 单行时整句当内容；错误固定用「错误」当标题。
   */
  // 胶囊下方小字：与 router 的 version 行共用 .sidebar-foot-note，字号字体一致。
  // 只放版本号 —— 侧栏窄，附加文案会换行，用户要求取消。外部实例的说明留在 title 里。
  const strataFootText = strataStatus.version ?? "版本未知";
  const strataFootTitle = strataStatus.external
    ? `${strataFootText} · 非本 GUI 启动，无法启/停`
    : strataFootText;
  const toastText = error ?? notice ?? "";
  const toastLines = toastText.split("\n");
  const toastTitle = error ? "错误" : toastLines.length > 1 ? toastLines[0] : "";
  const toastMessage = toastTitle && toastLines.length > 1 ? toastLines.slice(1).join("\n") : toastText;

  const go = (next: Tab) => {
    setTab(next);
    setNavOpen(false);
  };

  /**
   * 「开始聊天」：打开 llama.cpp 自带聊天界面。
   *
   * 打开的是 **router 自己的** WebUI —— llama.cpp 的 WebUI 内置了 router 支持
   * （LIST=/v1/models、LOAD=/models/load、SSE=/models/sse），所以在这一个界面里
   * 就能看到全部模型、按需加载、切换着聊，不必按模型各开一个标签页。
   * 想直接进某个模型（跳过选择），用模型卡片上的 💬。
   */
  const openChat = async () => {
    setNavOpen(false);
    await openModelChat();
  };

  return (
    <>
      {/* 窄屏独立顶栏（汉堡 + 当前页标题） */}
      <div className="mobile-header">
        <button id="mobileNavToggle" type="button" aria-label="菜单" onClick={() => setNavOpen((v) => !v)}>
          <i className="fas fa-bars" />
        </button>
        <span className="mobile-header-title">{current?.label}</span>
      </div>
      <div className="mobile-nav-overlay" onClick={() => setNavOpen(false)} />

      <aside className="sidebar">
        <div className="sidebar-header">
          <a href="#" className="app-logo" onClick={(e) => e.preventDefault()}>
            {appLogo && <img src={appLogo} alt="llama.cpp GUI" className="app-logo-image" />}
            <span>llama.cpp GUI</span>
          </a>
        </div>

        <nav className="sidebar-nav">
          {TABS.map((t) => (
            <Fragment key={t.id}>
              <a
                href="#"
                className={`nav-item ${tab === t.id ? "active" : ""}`}
                onClick={(e) => {
                  e.preventDefault();
                  go(t.id);
                }}
              >
                <i className={t.icon} />
                <span>{t.label}</span>
              </a>
              {/* 与 hub 一致：这一项不是页面，而是打开 llama.cpp 自带的聊天界面。
                  位置紧跟在「性能测试」下面。 */}
              {t.id === "bench" && (
                <a
                  href="#"
                  className="nav-item"
                  title="打开 llama.cpp 自带的聊天界面（router 的 WebUI，可切换全部模型）"
                  onClick={(e) => {
                    e.preventDefault();
                    void openChat();
                  }}
                >
                  <i className="fas fa-comments" />
                  <span>开始聊天</span>
                </a>
              )}
            </Fragment>
          ))}
        </nav>

        <div className="sidebar-footer">
          {/* Strata 状态胶囊：与 router 胶囊同款，点击即启停（显存互斥，见 Strata 面板）。
              非 GUI 启动的实例（用户自己跑了 run-<model>.bat）按钮置灰 —— 我们停不了它。 */}
          {settings?.strata_root && (
            <Fragment>
              <button
                type="button"
                className={`router-pill ${strataStatus.running ? "is-running" : "is-stopped"}`}
                disabled={busy || (strataStatus.running && strataStatus.external)}
                style={{ marginBottom: "0.2rem" }}
                title={
                  strataStatus.running && strataStatus.external
                    ? `端口 :${strataStatus.port} 上的 Strata 不是本 GUI 启动的，请在它自己的控制台里停止`
                    : strataStatus.running
                      ? `点击停止 Strata（:${strataStatus.port}）`
                      : "点击启动 Strata（默认 config）"
                }
                onClick={() => void (strataStatus.running ? stopStrata() : startStrata())}
              >
                <span className={`status-dot ${strataStatus.running ? "online" : "offline"}`} style={{ marginTop: 0 }} />
                <span className="router-pill-text">
                  {strataStatus.running
                    ? `Strata 运行中 · :${strataStatus.port}`
                    : "Strata 未运行"}
                </span>
                <i className={`fas ${strataStatus.running && !strataStatus.external ? "fa-stop" : strataStatus.running ? "fa-lock" : "fa-play"}`} />
              </button>
              {strataStatus.running && (
                <span
                  className="sidebar-foot-note"
                  // 与上下两颗胶囊等距（CSS 的 margin-top 也是 0.45rem）
                  style={{ marginBottom: "0.45rem" }}
                  title={strataFootTitle}
                >
                  {strataFootText}
                </span>
              )}
            </Fragment>
          )}
          {/* router 状态 + 启停合成一颗胶囊（样式沿用 hub 模型卡的状态胶囊）：
              左边状态点、中间状态文字、右边是启动/停止图标 */}
          <button
            type="button"
            className={`router-pill ${status.running ? "is-running" : "is-stopped"}`}
            disabled={busy || (!status.running && !settings?.llama_cpp_dir)}
            title={
              status.running
                ? `点击停止 router（:${status.port}）`
                : settings?.llama_cpp_dir
                  ? "点击启动 router"
                  : "先到「设置」里指定 llama.cpp 目录"
            }
            onClick={() => void (status.running ? stopRouter() : startRouter())}
          >
            <span className={`status-dot ${status.running ? "online" : "offline"}`} style={{ marginTop: 0 }} />
            <span className="router-pill-text">
              {status.running ? `router 运行中 · :${status.port}` : "router 未运行"}
            </span>
            <i className={`fas ${status.running ? "fa-stop" : "fa-play"}`} />
          </button>
          {status.version && (
            <span className="sidebar-foot-note" title={status.version}>
              {status.version}
            </span>
          )}
        </div>
      </aside>

      {tab === "models" && <ModelListPanel />}
      {tab === "bench" && <BenchPanel />}
      {tab === "runtime" && <RuntimePanel />}
      {tab === "strata" && <StrataPanel />}
      {tab === "logs" && <LogPanel />}
      {tab === "settings" && <SettingsPanel />}

      {(error || notice) && (
        <div className="toast-container">
          <div
            className={`toast ${error ? "error" : "success"}`}
            onClick={() => (error ? setError(null) : setNotice(null))}
            title="点击关闭"
          >
            <div className="toast-icon">
              <i className={`fas ${error ? "fa-exclamation-circle" : "fa-check-circle"}`} />
            </div>
            <div className="toast-content">
              {toastTitle && <div className="toast-title">{toastTitle}</div>}
              <div className="toast-message">{toastMessage}</div>
            </div>
            {/* 初始化失败时给一个明确的「重试」入口。
                否则界面会停在空列表上，用户除了重启应用没有别的办法 ——
                重试是安全的：init 幂等（失败时 initialized 保持 false），
                事件订阅走模块级槽位去重，重复调用不会让同一事件被处理多次。 */}
            {error && !initialized && (
              <button
                type="button"
                className="toast-retry"
                title="重新初始化（重新拉取设置与状态、重新注册事件订阅）"
                onClick={(e) => {
                  e.stopPropagation();
                  // 先让 initialized 归位（失败路径下它本来就是 false，这里显式表达意图），
                  // 再完整走一遍 init —— 即便将来 init 的置位时机有变，语义也仍是「重来」。
                  resetInit();
                  void init();
                }}
              >
                重试
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              title="关闭"
              onClick={(e) => {
                e.stopPropagation();
                if (error) setError(null);
                else setNotice(null);
              }}
            >
              &times;
            </button>
          </div>
        </div>
      )}
    </>
  );
}
