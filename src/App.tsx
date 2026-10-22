import { Fragment, useEffect, useState } from "react";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { BenchPanel } from "./components/BenchPanel";
import { ChatPanel } from "./components/ChatPanel";
import { LogPanel } from "./components/LogPanel";
import { ModelListPanel } from "./components/ModelListPanel";
import { MonitoringPage } from "./components/MonitoringPage";
import { ServiceStatusPopover } from "./components/ServiceStatusPopover";
import { ServiceTelemetryStatusBar } from "./components/ServiceTelemetryStatusBar";
import { SettingsPanel } from "./components/SettingsPanel";
import { monitorEngine, onTrayCommand } from "./ipc";
import type { MonitorEngine } from "./types";
import { useApp } from "./store";
import { appLogo } from "./utils/modelIcon";
import { buildLiveMetric } from "./utils/telemetry";

// S7（2026-10-16）：「运行环境」页并入设置页的第一张卡（运行时版本），
// tab 由 5 个减为 4 个。tab 状态不落 localStorage（只硬编码初值），
// 所以没有旧值残留导致白屏的问题。
type Tab = "models" | "chat" | "monitor" | "bench" | "logs" | "settings";

/**
 * 页面外壳照搬 hub 默认首页（index.html）的结构：
 * body 是 flex 容器 → `.sidebar` + 若干个同级 `<main class="main-area">`，
 * 页面切换＝切换哪个 main 可见。这里由 React 按 tab 只渲染一个 main。
 */
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "models", label: "模型", icon: "fas fa-cubes" },
  { id: "chat", label: "聊天", icon: "fas fa-comments" },
  { id: "monitor", label: "监控", icon: "fas fa-chart-line" },
  { id: "bench", label: "性能测试", icon: "fas fa-gauge-high" },
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
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => s.busy);
  const strataStatus = useApp((s) => s.strataStatus);
  const strataEntries = useApp((s) => s.strataEntries);
  const startStrataProxy = useApp((s) => s.startStrataProxy);
  const stopStrataProxy = useApp((s) => s.stopStrataProxy);

  const [tab, setTab] = useState<Tab>("models");
  const [navOpen, setNavOpen] = useState(false);
  // 主题放在 store 里（设置页顶栏也要用它切换）
  const theme = useApp((s) => s.theme);

  // ---------------------------------------------------------------- 底部服务状态栏
  // 数据来自 P4 采集层（monitor_sample，Rust 侧 1 秒一采的环形缓冲）。
  const monitor = useApp((s) => s.monitor);
  const monitorAt = useApp((s) => s.monitorAt);
  const recentTurns = useApp((s) => s.recentTurns);
  const lastTurn = useApp((s) => s.lastTurn);
  const refreshMonitor = useApp((s) => s.refreshMonitor);
  const routerModels = useApp((s) => s.routerModels);
  const configs = useApp((s) => s.configs);
  const chat = useApp((s) => s.chat);
  const contextBench = useApp((s) => s.contextBench);
  const scenarioBench = useApp((s) => s.scenarioBench);

  /**
   * 1 秒一采。窗口不可见时跳过 —— WebView 最小化后定时器仍在跑，
   * 每秒一次 NVML + CIM 调用没有意义。
   */
  useEffect(() => {
    void refreshMonitor();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshMonitor();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [refreshMonitor]);

  // 所有「正在跑」的模型：用户可以同时开好几个（用户 m05740）。
  const loadedModels = routerModels
    .filter((m) => m.status.value === "loaded")
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));
  // 状态栏 / 监控页看的是「正在跑的那个模型」，不是聊天里选的那个：
  // 聊天可以选一个还没加载的模型，监控要是跟着它就会盯错对象（用户 m05740）。
  // 同时跑多个时让用户自己切，选中项掉了就退回列表第一个。
  const [monitorModel, setMonitorModel] = useState("");
  const activeModel = loadedModels.includes(monitorModel) ? monitorModel : loadedModels[0] ?? "";
  const routeState = routerModels.find((m) => m.id === activeModel)?.status.value;
  const modelState: "loaded" | "loading" | "unloaded" | "unknown" =
    routeState === "loaded" ? "loaded" : routeState === "loading" ? "loading" : activeModel ? "unloaded" : "unknown";
  // 监控页的引擎指标（/metrics、/slots）：只在监控页且模型已加载时轮询。
  // **不能对未加载的模型调 /metrics?model=**，否则前门会把模型拉起来。
  const [engine, setEngine] = useState<MonitorEngine | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  /** 引擎指标拿不到但不该报红时的说明（例如实例没开 --metrics）。 */
  const [engineNote, setEngineNote] = useState<string | null>(null);
  // 换模型（或模型重启）时先清空，否则新模型第一次采样返回前，监控页还在显示旧模型的
  // 槽位与近期请求（用户 m06949「更换模型启动后，最近请求没有清空」）。
  useEffect(() => {
    setEngine(null);
    setEngineError(null);
    setEngineNote(null);
  }, [activeModel]);
  useEffect(() => {
    if (tab !== "monitor" || !activeModel || modelState !== "loaded") {
      setEngine(null);
      setEngineError(null);
      setEngineNote(null);
      return;
    }
    let alive = true;
    const pull = async () => {
      try {
        // Strata 模型直连引擎自己的端口：上游就是这么拿的（用户 m06557）。
        // 直连拿不到时回退走前门 —— Strata 配了 api_key 的话，密钥只在 Rust 侧，
        // 前端拿不到（只有 has_api_key 布尔），直连会 401；前门会替我们加上鉴权头。
        const strataEntry = strataEntries.find((item) => item.model_name === activeModel) ?? null;
        const proxyPort = strataStatus.proxy_port ?? 9090;
        let next = await monitorEngine(
          strataEntry?.port ?? proxyPort,
          strataEntry ? null : activeModel,
          settings?.api_key || null,
          strataEntry?.config_path ?? null,
        );
        if (strataEntry && next.error && proxyPort !== strataEntry.port) {
          next = await monitorEngine(proxyPort, activeModel, settings?.api_key || null, strataEntry.config_path ?? null);
        }
        if (!alive) return;
        setEngine(next);
        // 501 = 实例没开 --metrics。这是配置状态，不是故障，别拿红色错误吓用户
        // （用户 m05810 第 1 点）。重启模型后新实例会自动带上 --metrics。
        const raw = next.error ?? null;
        const metricsOff = raw !== null && /does not support metrics endpoint|metrics endpoint/i.test(raw);
        setEngineError(metricsOff ? null : raw);
        setEngineNote(
          metricsOff ? "这个实例没开 --metrics，引擎指标不可用；重启模型后新实例会默认带上。" : null,
        );
      } catch (err) {
        if (alive) setEngineError(err instanceof Error ? err.message : String(err));
      }
    };
    void pull();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab, activeModel, modelState, strataStatus.proxy_port, settings?.api_key]);

  const busyNow = chat.streaming || contextBench.running || scenarioBench.running;
  // 上下文上限取 config 里的值（`--ctx-size 0` 时后端已回退到 GGUF 的 <arch>.context_length）。
  // Strata 模型不在 `configs` 里（那是 llama.cpp 侧），用运行中实例的 `/health.max_context` 兜底，
  // 否则状态栏弹层的「最近请求上下文」在 Strata 下显示「—」（用户 m05790）。
  const configContext =
    configs.find((c) => c.name === activeModel)?.max_context ?? strataStatus.live_max_context ?? null;
  // 「读取中」= 请求已发出、首个 token 还没到（预填充阶段），照上游 live.state 的分法（用户 m06282）。
  const activeConversation = chat.conversations.find((item) => item.id === chat.activeId) ?? null;
  const lastAssistantPhase = (() => {
    const messages = activeConversation?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === "assistant") return message.execution?.phase ?? null;
    }
    return null;
  })();
  const reading = chat.streaming && lastAssistantPhase === "waiting";
  const speedSeries = useApp((state) => state.speedSeries);
  // 引擎自报的实时输入速度（只有 Strata 的 /metrics 有 live.prefill_tok_s_mean）。
  const livePrefillTokS = (() => {
    const metrics = engine?.metrics as Record<string, unknown> | undefined;
    const live = metrics?.live as Record<string, unknown> | undefined;
    const value = live?.prefill_tok_s_mean;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  })();
  const liveMetric = buildLiveMetric({
    snapshot: monitor,
    busy: busyNow,
    reading,
    queued: 0,
    lastTurn,
    maxContext: configContext,
    livePrefillTokS,
  });
  const statusBar = (
    <ServiceTelemetryStatusBar
      hasModel={Boolean(activeModel)}
      proxy={strataStatus.proxy}
      modelState={modelState}
      metric={liveMetric}
      metricAt={monitorAt}
      trigger={
        <ServiceStatusPopover
          hasModel={Boolean(activeModel)}
          model={activeModel}
          proxy={strataStatus.proxy}
          proxyPort={strataStatus.proxy_port ?? 9090}
          modelState={modelState}
          metric={liveMetric}
          metricAt={monitorAt}
          onRefresh={() => void refreshMonitor()}
          onNavigate={(page) => setTab(page)}
        />
      }
    />
  );

  /**
   * GUI 自己的版本号：取自 `tauri.conf.json` 的 `version`（打包时的权威值 —— 安装包文件名
   * 与 exe 的文件版本属性都源自它），所以显示的就是用户手上这一版。取不到就整行不渲染，
   * 不用「版本未知」占位 —— 侧栏窄，多一行文案就换行。
   */
  const [guiVersion, setGuiVersion] = useState("");

  useEffect(() => {
    void getVersion()
      .then(setGuiVersion)
      .catch(() => {});
  }, []);

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
      // 「服务」= 前门（:9090）：llama.cpp 子实例与 Strata 引擎都从这一个端口进。
      // router 已从界面退场（后端模块最后一步再删）。
      if (command === "start-service") void store.startStrataProxy();
      else if (command === "stop-service") void store.stopStrataProxy();
    });
    return () => {
      void pending.then((off) => off());
    };
  }, []);

  // 主题落到 <html data-theme>（hub 的深色变量挂在这个属性上）；
  // localStorage 由 store 的 setTheme 负责写，这里只保证首帧一致。
  //
  // 顺带把**系统标题栏**的明暗也跟上（用户 m10631 选的方案 B：不去掉标题栏，
  // 只让它不再刺眼）。Tauri 在 Windows 上走 DWM 的 immersive dark mode，
  // 只影响标题栏与原生滚动条；界面配色走的是 [data-theme]，跟这里无关 ——
  // 全项目没有 prefers-color-scheme 媒体查询，所以不会互相打架。
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    void getCurrentWindow()
      .setTheme(theme === "dark" ? "dark" : "light")
      .catch(() => {
        /* 浏览器里跑（npm run dev 无 Tauri）时会失败，忽略即可 */
      });
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
  // 这里**一直放引擎版本号**（用户 m01151）；代理端口写在胶囊文字与 title 里。
  // 版本号有两个来源、口径不同（用户 m01636）：引擎在跑时是 `/props.build_info`（本来就带
  // 前缀，`Strata 0.1.41`），引擎没起时回落到扫描到的 `engine_version`（引擎目录 BUILD.json，
  // 只有 `0.1.41`）——所以统一补 `Strata ` 前缀，别让同一行一会儿有前缀一会儿没有。
  // 回落时挑**正在跑/前门正在服务/选中**的那份 config，而不是按 mtime 排第一的那份。
  const strataProxyPort = strataStatus.proxy_port ?? 9090;
  const strataVersionFile =
    strataStatus.proxy_serving ??
    strataStatus.config_path?.split(/[\\/]/).pop() ??
    settings?.strata_selected_config ??
    null;
  const strataVersionEntry =
    strataEntries.find((e) => strataVersionFile !== null && e.config_path.endsWith(strataVersionFile)) ??
    strataEntries[0];
  const strataVersionRaw = strataStatus.version ?? strataVersionEntry?.engine_version ?? null;
  const strataFootText = !strataVersionRaw
    ? "版本未知"
    : /^strata\b/i.test(strataVersionRaw)
      ? strataVersionRaw
      : `Strata ${strataVersionRaw}`;
  // llama.cpp 引擎版本（用户 m03333 第 4 点）：左下角除了 Strata 版本，也要能一眼看到
  // llama.cpp 用的是哪份引擎。`selected_version` 是版本目录名（`llama-b11482-bin-win-cuda-13.4-x64`），
  // 太长，只取 build 号那一段；取不到就原样显示。
  const llamaVersion = settings?.selected_version ?? null;
  const llamaBuild = llamaVersion?.match(/llama-(b\d+)/i)?.[1] ?? null;
  const llamaFootText = llamaVersion ? `llama.cpp ${llamaBuild ?? llamaVersion}` : "llama.cpp 未选版本";
  const llamaFootTitle = llamaVersion
    ? `llama.cpp 引擎：${llamaVersion}`
    : "还没在「设置」里选 llama.cpp 版本目录";
  const strataFootTitle = strataStatus.proxy
    ? `代理 :${strataProxyPort} · DSH 等客户端连这里${
        strataStatus.running ? `（引擎 :${strataStatus.port}）` : "（引擎按首次请求自动启动）"
      } · 引擎版本 ${strataFootText}`
    : strataStatus.external
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
          {/* GUI 自己的版本（取自 tauri.conf.json —— exe 属性与安装包文件名都源自它）。
              取不到就不渲染，不用「版本未知」占位；样式见 app.css 的 .app-version。 */}
          {guiVersion && (
            <span className="app-version" title={`llama.cpp GUI ${guiVersion}`}>
              v{guiVersion}
            </span>
          )}
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
            </Fragment>
          ))}
        </nav>

        <div className="sidebar-footer">
          {/* 前门胶囊（用户 m00798 + 决策 A3）：统一入口只留 :9090，llama.cpp 子实例与
              Strata 引擎都从这一个端口进，所以启停合并成一颗 —— 原来那颗 router 胶囊
              随 router 退役一起删掉了（托盘菜单里仍有 router 的启停，直到后端退役）。
              前门是懒的：启动它不会加载任何模型，首次请求才按 `model` 起实例。
              非 GUI 启动的引擎（用户自己跑 run-<model>.bat）停不了，见下方小字的 title。 */}
          <button
            type="button"
            className={`router-pill mb-1 ${strataStatus.proxy ? "is-running" : "is-stopped"}`}
            disabled={busy}
            title={
              strataStatus.proxy
                ? `点击停止前门（:${strataProxyPort} · llama.cpp 与 Strata 两通道都走这里）`
                : `点击启动前门（默认 :${strataProxyPort} · DSH 等客户端连这里，按请求里的 model 自动切换引擎）`
            }
            onClick={() => void (strataStatus.proxy ? stopStrataProxy() : startStrataProxy())}
          >
            <span
              className={`status-dot mt-0 ${strataStatus.proxy ? "online" : "offline"}`}
            />
            <span className="router-pill-text">
              {strataStatus.proxy ? `前门 :${strataProxyPort}` : "前门未启动"}
            </span>
            <i className={`fas ${strataStatus.proxy ? "fa-stop" : "fa-play"}`} />
          </button>
          <span className="sidebar-foot-note" title={strataFootTitle}>
            {strataFootText}
          </span>
          <span className="sidebar-foot-note" title={llamaFootTitle}>
            {llamaFootText}
          </span>
        </div>
      </aside>

      {tab === "models" && <ModelListPanel />}
      {tab === "monitor" && (
        <MonitoringPage
          live={liveMetric}
          snapshot={monitor}
          engine={engine}
          engineError={engineError}
          engineNote={engineNote}
          recentTurns={recentTurns}
          model={activeModel}
          models={loadedModels}
          onSelectModel={setMonitorModel}
          gpuName={monitor?.static.gpuName ?? null}
          speedSeries={speedSeries}
          sampledAt={monitorAt}
        />
      )}
      {tab === "chat" && <ChatPanel />}
      {tab === "bench" && <BenchPanel />}
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
      {statusBar}
    </>
  );
}