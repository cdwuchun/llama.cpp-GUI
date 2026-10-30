import { useEffect, useRef, useState } from "react";
import { errText, ipc } from "../ipc";
import type {
  StrataController,
  StrataEngine,
  StrataEngineState,
  StrataUpgradeSnapshot,
} from "../types";
import { useApp } from "../store"; /** 设置页的分组标签（S7 改版 2026-10-16：左侧导航换成顶部标签，样式与模型列表的引擎标签一致） */
type Tab = "service" | "paths";
const TABS: {
  id: Tab;
  label: string;
}[] = [{ id: "service", label: "服务" }, { id: "paths", label: "通用" },];
export function SettingsPanel() {
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => s.busy);
  const saveSettings = useApp((s) => s.saveSettings);
  const refreshVersions = useApp((s) => s.refreshVersions);
  const refreshDevices = useApp((s) => s.refreshDevices);
  const refreshModels = useApp((s) => s.refreshModels);
  const refreshStrata = useApp((s) => s.refreshStrata);
  const refreshSettings = useApp((s) => s.refreshSettings);
  const strataStatus = useApp((s) => s.strataStatus);
  const writeStrataConfig = useApp((s) => s.writeStrataConfig);
  const setError = useApp((s) => s.setError);
  const setNotice = useApp((s) => s.setNotice);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const versions = useApp((s) => s.versions);
  const deviceError = useApp((s) => s.deviceError);
  /** 控制器跟踪的引擎版本（`strata components engine`）：只用来提示当前跟踪哪一版；引擎版本直接在下面的表格里选，不再提供回退按钮（用户 m02946） */
  const [engineState, setEngineState] = useState<StrataEngineState | null>(null);
  /** 根目录下并存的引擎版本（手动解压布局是 `<根>\engine\<版本>-…`） */
  const [engines, setEngines] = useState<StrataEngine[]>([]);
  /** 根目录下并存的控制器版本（`<根>\control\<版本>`） */
  const [controllers, setControllers] = useState<StrataController[]>([]);
  /** 切换控制器 / 引擎在跑：禁用表格里的 radio，避免连点 */
  const [strataBusy, setStrataBusy] = useState(false);
  /** 一键升级（`strata.py update`）：只有这一个升级按钮（用户 m02946），scope 固定 `all` = 控制器与引擎一起检查；每秒轮询进度 */
  const [upgrading, setUpgrading] = useState<{
    scope: "all" | "engine" | "control";
    snap: StrataUpgradeSnapshot;
  } | null>(null);
  const [tab, setTab] = useState<Tab>("service");
  const [llamaDir, setLlamaDir] = useState("");
  const [modelsMax, setModelsMax] = useState("4"); /** 空闲释放模型的秒数（-1 = 关闭） */
  const [sleepIdle, setSleepIdle] = useState("-1"); /** 引擎的 API Key：保存时写进每个引擎的 config，llama.cpp 与 Strata 共用（用户 m06341） */
  const [apiKey, setApiKey] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  /** Strata 根目录（`control\` / `engine\` / config 所在处）—— 必须由用户指定，没有兜底默认值 */
  const [strataDir, setStrataDir] = useState(""); /** 留空 = 127.0.0.1:9090 */
  const [strataHost, setStrataHost] = useState("");
  const [strataPort, setStrataPort] = useState(""); /** 写进 strata-*.json 顶层的 idle_unload_s */
  const [strataIdle, setStrataIdle] = useState(""); /** 写进 strata-*.json 顶层的 min_free_vram_mib */
  const [strataMinFree, setStrataMinFree] = useState(""); /** 写进 strata-*.json 顶层的 before_load */
  const [strataBefore, setStrataBefore] = useState(""); /** 「服务」分组正在保存 */
  const [strataSaving, setStrataSaving] = useState(false); /** 注册表里的真实自启动状态，可能与 settings 文件里的值不一致 */
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => { void ipc.autostartGet().then(setAutostart).catch(() => setAutostart(null)); }, []); /**
     * 只在**首次**拿到 settings 时填表单。
     * 
     * 2026-10-16（S7 整理时保留原注释）：早先这个 effect 依赖 `[settings]`，
     * 于是任何一次 settings 对象更换（拨一下开关、保存一次、刷新版本）都会把
     * 用户还没保存的改动（目录、端口、models_max、API Key）回滚成盘上的值。   */
  const primed = useRef(false);
  useEffect(() => { if (!settings || primed.current)
    return; primed.current = true; setLlamaDir(settings.llama_cpp_dir ?? ""); setModelsMax(String(settings.models_max)); setSleepIdle(String(settings.sleep_idle_seconds ?? -1)); setApiKey(settings.api_key ?? ""); setRoots(settings.model_roots ?? []); setStrataHost(settings.strata_host ?? ""); setStrataPort(settings.strata_port != null ? String(settings.strata_port) : ""); setStrataIdle(settings.strata_idle_unload_s != null ? String(settings.strata_idle_unload_s) : ""); setStrataMinFree(settings.strata_min_free_vram_mib != null ? String(settings.strata_min_free_vram_mib) : ""); setStrataBefore(settings.strata_before_load ?? ""); setStrataDir(settings.strata_root ?? ""); void loadEngineState(); void loadStrataLists(); }, [settings]);
  if (!settings) {
    return (<main className="main-area">        <div className="content-scrollable">          <div className="panel">            <div className="notice">加载设置中…</div>          </div>        </div>      </main>);
  }
  /** 当前生效的控制器版本：就是设置里记的那个（「自动跟随最新版本」开着时由后端写进去） */
  const chosenController = settings.strata_controller ?? "";
  /**
   * 兼容 API 的 base URL：跟「前门与服务」里那条配置一致（留空 = 127.0.0.1:9090）。
   *
   * 用**已保存**的值拼：输入框里还没保存的端口对应的服务并不存在，复制出去只会指向空端口（审查发现）。
   */
  const frontHost = (settings.strata_host ?? "").trim() || "127.0.0.1";
  const frontPort =
    settings.strata_port != null ? String(settings.strata_port) : String(strataStatus.proxy_port ?? 9090);
  const openAiBase = `http://${frontHost}:${frontPort}/v1`;
  const anthropicBase = `http://${frontHost}:${frontPort}`;
  const copyEndpoint = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("已复制");
    } catch {
      setNotice("复制失败：浏览器拒绝了剪贴板权限");
    }
    setTimeout(() => setNotice(null), 1600);
  };
  /** 当前生效的引擎 exe：同上，由 `strata_engines` 在自动模式下写入 */
  const chosenEngine = settings.strata_engine ?? "";
  /** 「自动跟随最新」只有一个开关（用户 m03170）：两个字段都开才算开，免得历史数据不一致时显示错 */
  const autoLatest = settings.strata_auto_controller && settings.strata_auto_engine;
  /** 读控制器跟踪的引擎版本（只读，不提供手选；用户 m02756 第 2 条） */
  async function loadEngineState() {
    try {
      setEngineState(await ipc.strataEngineState());
    } catch (err) {
      setEngineState(null);
      setError(`读取 Strata 引擎版本失败：${errText(err)}`);
    }
  }

  /** 扫根目录下的引擎版本与控制器版本（两张表格的数据源） */
  async function loadStrataLists() {
    try {
      // 串行而不是 Promise.all：两个命令在「自动跟随最新版本」开着时都会 apply 并重写 config /
      // 扫描缓存，并发跑会互相覆盖缓存（先控制器的 cwd 再引擎的 exe，顺序与依赖一致）
      const nextControllers = await ipc.strataControllers();
      const nextEngines = await ipc.strataEngines();
      setEngines(nextEngines);
      setControllers(nextControllers);
      // 这两个命令在「自动跟随最新版本」开着时会写入选中的版本，重读一次设置才勾得对
      await refreshSettings();
    } catch (err) {
      setEngines([]);
      setControllers([]);
      setError(`扫描 Strata 引擎 / 控制器失败：${errText(err)}`);
    }
  }

  /** 合并后的「自动跟随最新」开关：控制器与引擎一起开 / 一起关（用户 m03170） */
  async function toggleAuto(on: boolean) {
    if (!(await saveSettings({ strata_auto_controller: on, strata_auto_engine: on }))) return;
    await loadStrataLists();
  }

  /** 保存 Strata 根目录：后端会立刻让全局解析切过去，这里把两张表重扫一遍 */
  async function saveStrataDir() {
    const path = strataDir.trim();
    try {
      if (!(await saveSettings({ strata_root: path || null }))) return;
      setStrataDir(path);
      await loadStrataLists();
      await refreshStrata();
      setNotice(
        path
          ? `Strata 目录已切到 ${path}`
          : "已清空 Strata 目录：没有兜底位置，重新填一个才能扫描 / 启动 Strata",
      );
    } catch (err) {
      setError(`保存 Strata 目录失败：${errText(err)}`);
    }
  }

  /** 切控制器版本：重写全部 `run-*.bat` 与 `strata-*.json` 的控制器相关参数 */
  async function pickController(version: string) {
    if (strataBusy) return;
    if (!version) {
      setError("先在上面选中一个控制器版本");
      return;
    }
    if (version === (settings?.strata_controller ?? "")) return;
    setStrataBusy(true);
    try {
      const result = await ipc.strataApplyController(version);
      // 手动挑版本 = 明确要固定在它上面：顺手关掉「自动跟随最新」（开关是合并的一个，两个字段
      // 一起关）。否则下次进设置页 / 重启后又被拽回最新版，这一选等于白选（用户 m00194）。
      if (settings?.strata_auto_controller || settings?.strata_auto_engine) {
        await saveSettings({ strata_auto_controller: false, strata_auto_engine: false });
      }
      setNotice(
        `已切到控制器 ${result.version}：改写 ${result.scripts.length} 个启动脚本、${result.configs.length} 份 config`,
      );
      await loadStrataLists();
      await refreshStrata();
    } catch (err) {
      setError(`切换控制器版本失败：${errText(err)}`);
    } finally {
      setStrataBusy(false);
    }
  }

  /** 切引擎版本：把选定的 exe 写进全部 config 的 `exe`（`vision.exe` 同目录联动） */
  async function pickEngine(exe: string) {
    if (strataBusy) return;
    if (exe === (settings?.strata_engine ?? "")) return;
    setStrataBusy(true);
    try {
      const changed = await ipc.strataApplyEngine(exe);
      if (!(await saveSettings({ strata_engine: exe }))) return;
      // 同上：手选引擎就是「固定用它」，把「自动跟随最新」关掉，别让下次进页面把它换走
      if (settings?.strata_auto_controller || settings?.strata_auto_engine) {
        await saveSettings({ strata_auto_controller: false, strata_auto_engine: false });
      }
      setNotice(`已切到该引擎：改写 ${changed.length} 份 config`);
      await refreshStrata();
    } catch (err) {
      setError(`切换引擎版本失败：${errText(err)}`);
    } finally {
      setStrataBusy(false);
    }
  }

  /**
   * 一键升级：交给控制端自己跑（`strata.py update`）。
   *
   * 它读签名 feed、按显卡挑包、下载校验、**试启动**，通过了才切换，失败保留旧版 ——
   * GUI 不碰下载协议，只把它的 jsonl 进度翻译成界面文字。
   *
   * 后端会先跑一次 `--check`：已是最新就直接回报，不白拉几百 MB。
   */
  async function startUpgrade(scope: "all" | "engine" | "control") {
    if (upgrading?.snap.running || strataBusy) return;
    setStrataBusy(true);
    try {
      const result = await ipc.strataUpgradeStart(scope);
      if (!result.started) {
        setUpgrading(null);
        setNotice(result.message);
        return;
      }
      setUpgrading({ scope, snap: await ipc.strataUpgradeStatus() });
    } catch (err) {
      setError(`升级失败：${errText(err)}`);
    } finally {
      setStrataBusy(false);
    }
  }

  /** 升级中每秒拉一次进度；结束时重扫版本表（引擎 / 控制器目录已经被换掉了）。 */
  useEffect(() => {
    if (!upgrading || !upgrading.snap.running) return;
    let alive = true;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const snap = await ipc.strataUpgradeStatus();
          if (!alive) return;
          setUpgrading((current) => (current ? { ...current, snap } : current));
          if (snap.running) return;
          window.clearInterval(timer);
          const cancelled = snap.message.startsWith("已取消");
          if (snap.ok === false && !cancelled) setError(snap.message || "升级失败");
          else setNotice(snap.message || "升级完成");
          await loadStrataLists();
          await refreshStrata();
        } catch {
          // 轮询偶发失败不打断升级，下一秒再试
        }
      })();
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [upgrading?.scope, upgrading?.snap.running]);

  async function pickDirectory(): Promise<string | null> { try {    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title: "选择目录" });
    return typeof picked === "string" ? picked : null;
  }
  catch (err) {
    useApp.getState().setError(String(err));
    return null;
  } } /**
     * 保存「服务」分组（用户 m06341：改完点「保存」才生效）。
     * 
     * 1. 前门监听地址 / 端口只进 GUI 设置 —— 前门自己监听它，与每个 config 里的引擎端口不是一回事；
     * 2. **API Key 落进每个引擎的 config**：llama.cpp 子实例按各自 config 的 `api_key` 加
     *    `--api-key`（见 `scheduler::build_model_args`），Strata 引擎读顶层 `api_key`；
     * 3. Strata 的空闲卸载 / 显存门槛 / 加载前命令写进所有 `strata-*.json` 顶层，
     *    不碰 `args`（R6）、不往启动命令里追加（R1），与上游 setup.py 一致；
     *    序列化用 `indent=1`，对齐上游 `json.dumps(cfg, indent=1)`；
     * 4. 改了前门端口 / 地址且前门在跑 → 保存后自动重启。   */
  async function saveService() {
    setStrataSaving(true);
    try { // 闭包里 TS 收不到外层 `if (!settings)` 的收窄，这里再挡一次
      if (!settings)
        return;
      const host = strataHost.trim();
      const key = apiKey.trim();
      if (key && !/^[\x20-\x7e]+$/.test(key)) {
        setError("API Key 只能用英文、数字和常见符号（HTTP 请求头不支持中文）");
        return;
      }
      const parsedPort = Math.trunc(Number(strataPort));
      // 端口得能在 u16 里：只判 > 0 时 70000 存进去，后端监听才失败（审查发现）
      const nextPort =
        Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null;
      const parsedMax = Math.trunc(Number(modelsMax));
      // 0 / 负数 / 非数字都会让调度器行为不可预期，夹到 1..=64
      const nextMax = Number.isFinite(parsedMax) ? Math.min(64, Math.max(1, parsedMax)) : 4;
      const parsedSleep = Math.trunc(Number(sleepIdle)); // llama.cpp 只在 > 0 时启用；-1 / 0 / 空都表示关闭
      const nextSleep = Number.isFinite(parsedSleep) ? parsedSleep : -1;
      const idleParsed = Math.trunc(Number(strataIdle));
      const idle = Number.isFinite(idleParsed) && idleParsed > 0 ? idleParsed : null;
      const freeParsed = Math.trunc(Number(strataMinFree));
      const minFree = Number.isFinite(freeParsed) && freeParsed > 0 ? freeParsed : null;
      const before = strataBefore.trim();
      const hostChanged = (host || "127.0.0.1") !== (settings.strata_host || "127.0.0.1");
      const portChanged = (nextPort ?? 9090) !== (settings.strata_port ?? 9090);
      const proxyRunning = useApp.getState().strataStatus.proxy; // 空串 = 清除：JSON 的 null 会被后端当成「这个字段不变」，清不掉旧值
      const saved = await saveSettings({ llama_cpp_dir: llamaDir.trim(), strata_host: host || null, strata_port: nextPort, models_max: nextMax, sleep_idle_seconds: nextSleep, api_key: key, });
      if (!saved)
        return;
      const notes: string[] = [];
      const llamaWritten = await ipc.configSetApiKey(key);
      if (llamaWritten > 0)
        notes.push(`llama.cpp ${llamaWritten} 份`);
      let strataWritten = 0;
      const failed: string[] = [];
      const files = await ipc.strataScan();
      for (const entry of files) {
        const file = entry.config_path.split(/[\\/]/).pop() ?? "";
        try {
          const cfg = JSON.parse(await ipc.strataConfigRead(file)) as Record<string, unknown>; // 不写 host / port：那是前门的事，写进去会把每个模型自己的引擎端口覆盖掉
          if (idle !== null)
            cfg.idle_unload_s = idle;
          if (minFree !== null)
            cfg.min_free_vram_mib = minFree;
          if (before)
            cfg.before_load = before;
          if (await writeStrataConfig(file, JSON.stringify(cfg, null, 1)))
            strataWritten += 1;
          else
            failed.push(file);
        }
        catch (err) {
          failed.push(`${file}：${errText(err)}`);
        }
      }
      // API Key 单独走一条命令：它在后端按原文改顶层 `api_key`（清空写 null），
      // 免得前端整份重写 config 时把键序与缩进改掉（用户 m01543）。
      try {
        const result = await ipc.strataSetApiKey(key);
        if (result.written.length > 0)
          notes.push(`API Key ${result.written.length} 份 config`);
        if (result.failed.length > 0)
          failed.push(`API Key：${result.failed.join("、")}`);
      }
      catch (err) {
        failed.push(`API Key：${errText(err)}`);
      }
      if (strataWritten > 0) {
        notes.push(`Strata ${strataWritten} 份`);
        await saveSettings({ strata_idle_unload_s: idle, strata_min_free_vram_mib: minFree, strata_before_load: before || null, });
      }
      if (proxyRunning && (hostChanged || portChanged)) {
        useApp.getState().stopStrataProxy();
        useApp.getState().startStrataProxy();
        notes.push("前门已按新地址/端口重启");
      }
      // launch 预设里的 key 会盖掉 config 的（GUI 有预设时按它生成配置再启动），所以一并写：
      // 否则 GUI 前门用 A、`strata launch` 用 B（用户 m02313）。留空 = 不动预设，与上面
      // 「空 key 不写 config」保持一致，免得一次保存把 launch 那边辛苦设的 key 清掉。
      if (key) {
        try {
          const presetKeys = await ipc.strataSyncLaunchKeys(key);
          if (presetKeys > 0)
            notes.push(`launch 预设 ${presetKeys} 份`);
        }
        catch (err) {
          failed.push(`launch 预设：${errText(err)}`);
        }
      }
      if (failed.length) {
        setError(`已写入 ${notes.join("、") || "0 份"}；未写入：${failed.join("；")}`);
      }
      else if (notes.length) {
        setNotice(`已保存：${notes.join("、")}${strataStatus.running ? "；正在运行的 Strata 在下次启动引擎时用上新值" : ""}`);
      }
      else {
        setNotice("已保存");
      }
    }
    catch (err) {
      setError(errText(err));
    }
    finally {
      setStrataSaving(false);
    }
  } /** 保存 llama.cpp 目录，顺手重新扫描版本与设备 */
  async function saveLlamaDir() { await saveSettings({ llama_cpp_dir: llamaDir.trim() }); await refreshVersions(false); await refreshDevices(); }
  async function saveModelRoots() { await saveSettings({ model_roots: roots.map((r) => r.trim()).filter(Boolean) }); await refreshModels(true); }
  async function toggleAutostart(enabled: boolean) { try {
    const actual = await ipc.autostartSet(enabled);
    setAutostart(actual);
    await saveSettings({ autostart: actual });
    setNotice(actual ? "已开启开机自启动" : "已关闭开机自启动");
  }
  catch (err) {
    setError(errText(err));
  } }
  const selectedVersion = settings.selected_version ?? null;
  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">设置</h1>
        {/* 标签紧贴标题右侧（app.css 的 `.top-bar > .st-tabs` 用 margin-right:auto 推过来） */}
        <div className="st-tabs" role="tablist" aria-label="分组">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`st-tab${tab === t.id ? " is-active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="st-btn st-btn--secondary st-btn--sm"
            title="切换明暗主题"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <i className={`fas ${theme === "dark" ? "fa-sun" : "fa-moon"}`} />
            {theme === "dark" ? "浅色" : "深色"}
          </button>
        </div>
      </div>
      <div className="content-scrollable">
        <div className="st-settings">
          {tab === "service" && (
            <>
              {/* 两张卡各占满一行（用户 m03514 第 1 条：之前的并列太窄） */}
              <div className="st-cards">
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-server" />
                    <h2 className="st-card__title">前门与服务</h2>
                    <span className="st-spacer" />
                    <span className="st-sub">
                      {strataStatus.proxy
                        ? `运行中 · :${strataStatus.proxy_port ?? 9090}${strataStatus.running ? `（当前引擎 :${strataStatus.port}）` : ""}`
                        : "未运行"}
                    </span>
                  </div>
                  <div className="st-card__body">
                    <div className="st-grid">
                      <label className="st-field">
                        <span className="st-label">前门监听地址</span>
                        <input
                          className="st-input"
                          value={strataHost}
                          placeholder="127.0.0.1"
                          onChange={(e) => setStrataHost(e.target.value)}
                        />
                      </label>
                      <label className="st-field">
                        <span className="st-label">前门端口</span>
                        <input
                          className="st-input"
                          value={strataPort}
                          placeholder="9090"
                          onChange={(e) => setStrataPort(e.target.value)}
                        />
                      </label>
                      <label className="st-field">
                        <span className="st-label">同时加载模型上限</span>
                        <input
                          className="st-input"
                          value={modelsMax}
                          placeholder="4"
                          onChange={(e) => setModelsMax(e.target.value)}
                        />
                      </label>
                      <label className="st-field">
                        <span className="st-label">空闲释放模型（秒）</span>
                        <input
                          className="st-input"
                          value={sleepIdle}
                          placeholder="-1"
                          title="-1 = 关闭"
                          onChange={(e) => setSleepIdle(e.target.value)}
                        />
                      </label>
                    </div>
                    <label className="st-field">
                      <span className="st-label">API Key</span>
                      <input
                        className="st-input st-input--mono"
                        value={apiKey}
                        placeholder="sk-…"
                        onChange={(e) => setApiKey(e.target.value)}
                      />
                    </label>
                    <div className="st-row st-row--end">
                      <button
                        type="button"
                        className="st-btn st-btn--primary"
                        disabled={busy || strataSaving}
                        onClick={() => void saveService()}
                      >
                        <i className={`fas ${strataSaving ? "fa-spinner fa-spin" : "fa-floppy-disk"}`} />
                        保存
                      </button>
                    </div>
                  </div>
                </section>
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-plug" />
                    <h2 className="st-card__title">接口地址（兼容 API）</h2>
                    <span className="st-spacer" />
                    <span className="st-sub">
                      {strataStatus.proxy ? `运行中 · :${strataStatus.proxy_port ?? 9090}` : "前门未运行"}
                    </span>
                  </div>
                  <div className="st-card__body">
                    <p className="st-hint">
                      其它客户端（OpenAI / Anthropic SDK、omp 等）把 base URL 指向这里即可；支持
                      `/v1/chat/completions` 与 `/v1/responses` 两套 OpenAI 接口。
                    </p>
                    <dl className="facts">
                      <dt>OpenAI base URL</dt>
                      <dd>
                        <code>{openAiBase}</code>{" "}
                        <button type="button" className="st-btn st-btn--icon" title="复制" onClick={() => void copyEndpoint(openAiBase)}>
                          <i className="fas fa-copy" />
                        </button>
                      </dd>
                      <dt>Anthropic base URL</dt>
                      <dd>
                        <code>{anthropicBase}</code>{" "}
                        <button type="button" className="st-btn st-btn--icon" title="复制" onClick={() => void copyEndpoint(anthropicBase)}>
                          <i className="fas fa-copy" />
                        </button>
                      </dd>
                      <dt>鉴权</dt>
                      <dd>{apiKey.trim() ? "Bearer / x-api-key（用上面设置的 API Key）" : "未设 API Key，前门不校验"}</dd>
                    </dl>
                  </div>
                </section>
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-window-restore" />
                    <h2 className="st-card__title">启动与托盘</h2>
                  </div>
                  <div className="st-card__body">
                    <div className="st-switch-row">
                      <div className="st-switch-row__text">
                        <span className="st-switch-row__label">Strata 与 llama.cpp 显存互斥</span>
                      </div>
                      <input
                        type="checkbox"
                        className="switch-input"
                        checked={settings.strata_router_mutex}
                        disabled={busy}
                        onChange={(e) => void saveSettings({ strata_router_mutex: e.target.checked })}
                      />
                    </div>
                    <div className="st-switch-row">
                      <div className="st-switch-row__text">
                        <span className="st-switch-row__label">开机自启动</span>
                      </div>
                      <input
                        type="checkbox"
                        className="switch-input"
                        checked={autostart ?? settings.autostart}
                        disabled={busy}
                        onChange={(e) => void toggleAutostart(e.target.checked)}
                      />
                    </div>
                    <div className="st-switch-row">
                      <div className="st-switch-row__text">
                        <span className="st-switch-row__label">关闭窗口时最小化到托盘</span>
                      </div>
                      <input
                        type="checkbox"
                        className="switch-input"
                        checked={settings.minimize_to_tray}
                        disabled={busy}
                        onChange={(e) => void saveSettings({ minimize_to_tray: e.target.checked })}
                      />
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
          {tab === "paths" && (
            <>
              <div className="st-cards">
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-folder-tree" />
                    <h2 className="st-card__title">Strata 目录</h2>
                  </div>
                  <div className="st-card__body">
                    <div className="st-row">
                      <input
                        className="st-input"
                        value={strataDir}
                        placeholder="例如 E:\AI\Strata"
                        onChange={(e) => setStrataDir(e.target.value)}
                      />
                      <button
                        type="button"
                        className="st-btn st-btn--secondary"
                        onClick={() =>
                          void pickDirectory().then((p) => {
                            if (p) setStrataDir(p);
                          })
                        }
                      >
                        <i className="fas fa-folder-open" />
                        浏览
                      </button>
                      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void saveStrataDir()}>
                        <i className="fas fa-floppy-disk" />
                        保存
                      </button>
                    </div>
                  </div>
                </section>
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-layer-group" />
                    <h2 className="st-card__title">Strata 版本</h2>
                    <label
                      className="st-head-switch"
                      title="开着时：没选过、或选中的版本已被删掉，就把控制器与引擎都自动落到最新可用版本并改写 run-*.bat / config；关掉则完全按下面两张表里的手动选择走"
                    >
                      <input
                        type="checkbox"
                        className="switch-input"
                        checked={autoLatest}
                        disabled={busy || strataBusy}
                        onChange={(e) => void toggleAuto(e.target.checked)}
                      />
                      自动跟随最新
                    </label>
                    <span className="st-spacer" />
                    <button
                      type="button"
                      className="st-btn st-btn--secondary st-btn--sm"
                      disabled={busy || strataBusy}
                      title="重新扫描 Strata 目录下的控制器与引擎版本"
                      onClick={() => void loadStrataLists()}
                    >
                      <i className="fas fa-radar" />
                      扫描版本
                    </button>
                    <button
                      type="button"
                      className="st-btn st-btn--secondary st-btn--sm"
                      disabled={busy || strataBusy || !!upgrading?.snap.running}
                      title="从官网 feed 检查并安装最新的控制器与引擎（官方签名校验 + 试启动，失败保留旧版）"
                      onClick={() => void startUpgrade("all")}
                    >
                      <i className={`fas ${upgrading?.snap.running ? "fa-spinner fa-spin" : "fa-cloud-arrow-down"}`} />
                      升级
                    </button>
                  </div>
                  <div className="st-card__body">
                    {upgrading && (
                      <div className="st-upgrade">
                        <div className="st-hint">
                          <i className={`fas ${upgrading.snap.running ? "fa-spinner fa-spin" : "fa-circle-info"}`} />{" "}
                          {upgrading.snap.message}
                        </div>
                        {upgrading.snap.running && upgrading.snap.phase === "download" && (
                          <div className="st-progress">
                            <div
                              className="st-progress__bar"
                              style={{ width: `${Math.max(2, upgrading.snap.percent)}%` }}
                            />
                          </div>
                        )}
                        {upgrading.snap.running && (
                          <button
                            type="button"
                            className="st-btn st-btn--danger st-btn--sm"
                            onClick={() => void ipc.strataUpgradeStop()}
                          >
                            取消升级
                          </button>
                        )}
                      </div>
                    )}
                    <div className="st-row st-subhead">
                      <span className="st-card__title">控制器</span>
                      <span className="st-badge">{controllers.length} 个版本</span>
                    </div>
                    {controllers.length === 0 ? (
                      <div className="st-hint">
                        未发现控制器版本，请先在「Strata 目录」里指定根目录（<span className="mono">control\&lt;版本&gt;</span>）。
                      </div>
                    ) : (
                      <div className="st-scroll">
                        <table className="st-table">
                          <thead>
                            <tr>
                              <th>选择</th>
                              <th>版本</th>
                              <th>状态</th>
                              <th>路径</th>
                            </tr>
                          </thead>
                          <tbody>
                            {controllers.map((c) => (
                              <tr key={c.version}>
                                <td>
                                  <input
                                    type="radio"
                                    name="st-strata-controller"
                                    checked={chosenController === c.version}
                                    disabled={!c.usable || strataBusy}
                                    onChange={() => void pickController(c.version)}
                                  />
                                </td>
                                <td className="mono" title={c.version}>
                                  {c.version}
                                  {c.active && (
                                    <span className="st-badge st-badge--ok" title="control\active.json 记的当前版本">
                                      active
                                    </span>
                                  )}
                                </td>
                                <td>
                                  {c.usable ? (
                                    <span className="st-badge st-badge--ok">可用</span>
                                  ) : (
                                    <span
                                      className="st-badge st-badge--warn"
                                      title={c.python ? "缺 serve\\server.py" : "缺 python\\python.exe"}
                                    >
                                      缺{c.python ? " serve" : " python"}
                                    </span>
                                  )}
                                </td>
                                <td className="mono break-all" title={c.folder}>
                                  {c.folder}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="st-row st-subhead">
                      <span className="st-card__title">引擎</span>
                      <span className="st-badge">{engines.length} 个版本</span>
                    </div>
                    {engines.length === 0 ? (
                      <div className="st-hint">
                        未发现引擎版本，请先在「Strata 目录」里指定根目录（<span className="mono">engine\&lt;版本&gt;-&lt;平台&gt;-&lt;后端&gt;</span>）。
                      </div>
                    ) : (
                      <div className="st-scroll">
                        <table className="st-table">
                          <thead>
                            <tr>
                              <th>选择</th>
                              <th>版本</th>
                              <th>平台</th>
                              <th>后端</th>
                              <th>路径</th>
                            </tr>
                          </thead>
                          <tbody>
                            {engines.map((e) => (
                              <tr key={e.exe}>
                                <td>
                                  <input
                                    type="radio"
                                    name="st-strata-engine"
                                    checked={chosenEngine === e.exe}
                                    disabled={strataBusy}
                                    onChange={() => void pickEngine(e.exe)}
                                  />
                                </td>
                                <td className="mono" title={e.version ?? e.exe}>
                                  {e.version ?? "—"}
                                  {e.build && <span className="st-badge">{e.build}</span>}
                                </td>
                                <td>{e.platform ?? "—"}</td>
                                <td>{e.backend ?? "—"}</td>
                                <td className="mono break-all" title={e.exe}>
                                  {dirOf(e.exe)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {engineState && !engineState.usable && (
                      <div className="notice warn">
                        <i className="fas fa-triangle-exclamation" />
                        控制器报告的引擎不可用{engineState.update_notice ? `：${engineState.update_notice}` : ""}。
                      </div>
                    )}
                  </div>
                </section>
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-cubes" />
                    <h2 className="st-card__title">llama.cpp 版本</h2>
                    <span className="st-badge">{versions.length} 个版本</span>
                    <span className="st-spacer" />
                    <button
                      type="button"
                      className="st-btn st-btn--secondary st-btn--sm"
                      disabled={busy || !settings.llama_cpp_dir}
                      title="重新扫描 llama.cpp 安装目录下的版本"
                      onClick={() => void refreshVersions(true)}
                    >
                      <i className="fas fa-radar" />
                      扫描版本
                    </button>
                  </div>
                  <div className="st-card__body">
                    {deviceError && (
                      <div className="notice warn">
                        <i className="fas fa-triangle-exclamation" />
                        {deviceError}
                      </div>
                    )}
                    {versions.length === 0 ? (
                      <div className="st-hint">未发现版本，请先在「通用」里指定 llama.cpp 安装目录。</div>
                    ) : (
                      <div className="st-scroll">
                        <table className="st-table">
                          <thead>
                            <tr>
                              <th>选择</th>
                              <th>版本</th>
                              <th>后端</th>
                              <th>共享运行时版本</th>
                              <th>路径</th>
                            </tr>
                          </thead>
                          <tbody>
                            {versions.map((v) => (
                              <tr key={v.name}>
                                <td>
                                  <input
                                    type="radio"
                                    name="st-version"
                                    checked={selectedVersion === v.name}
                                    onChange={() => void saveSettings({ selected_version: v.name })}
                                  />
                                </td>
                                <td className="mono" title={v.name}>
                                  {v.name.match(/llama-(b\d+)/i)?.[1] ?? v.name}
                                  {!v.ascii_safe && (
                                    <span className="st-badge st-badge--warn" title="安装目录含非 ASCII 字符，启动时会自动改用 ASCII 链接目录">
                                      含非 ASCII
                                    </span>
                                  )}
                                  {v.fit_params_bin && (
                                    <span className="st-badge st-badge--ok" title="该版本带 llama-fit-params（原生 --fit 的 GPU 分配）">
                                      fit
                                    </span>
                                  )}
                                </td>
                                <td>{v.backend ?? "—"}</td>
                                <td>
                                  {v.runtime_version ?? (
                                    <span className="st-badge st-badge--warn" title="未匹配到直接包含 cudart64_/cublas64_ 的目录，GPU 将不可用">
                                      未匹配
                                    </span>
                                  )}
                                </td>
                                <td className="mono break-all" title={v.dir}>
                                  {v.dir}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </section>
                {/* llama.cpp 安装目录与模型目录并列（用户 m03319 第 2 条） */}
                <section className="st-card">
                  <div className="st-card__head">
                    <i className="fas fa-folder-tree" />
                    <h2 className="st-card__title">llama.cpp 安装目录</h2>
                  </div>
                  <div className="st-card__body">
                    <div className="st-row">
                      <input
                        className="st-input"
                        value={llamaDir}
                        placeholder="E:\AI\llama.cpp-hub\llamacpp"
                        onChange={(e) => setLlamaDir(e.target.value)}
                      />
                      <button
                        type="button"
                        className="st-btn st-btn--secondary"
                        onClick={() =>
                          void pickDirectory().then((p) => {
                            if (p) setLlamaDir(p);
                          })
                        }
                      >
                        <i className="fas fa-folder-open" />
                        浏览
                      </button>
                      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void saveLlamaDir()}>
                        <i className="fas fa-floppy-disk" />
                        保存
                      </button>
                    </div>
                  </div>
                </section>
                <section className="st-card">
                  <div className="st-card__head">
                    <i className="fas fa-list" />
                    <h2 className="st-card__title">llama.cpp 模型目录</h2>
                    <span className="st-spacer" />
                    <button
                      type="button"
                      className="st-btn st-btn--secondary st-btn--sm"
                      disabled={busy}
                      onClick={() => setRoots([...roots, ""])}
                    >
                      <i className="fas fa-plus" />
                      添加目录
                    </button>
                  </div>
                  <div className="st-card__body">
                    {roots.length === 0 ? (
                      <div className="st-hint">还没有添加模型目录。</div>
                    ) : (
                      /* key 不能用被编辑的值：每敲一个字就会重建 div，输入框会丢焦点 */
                      roots.map((r, i) => (
                        <div className="st-row" key={i}>
                          <input
                            className="st-input"
                            value={r}
                            placeholder="E:\AI\models"
                            onChange={(e) => setRoots(roots.map((x, j) => (j === i ? e.target.value : x)))}
                          />
                          <button
                            type="button"
                            className="st-btn st-btn--icon"
                            title="移除"
                            disabled={busy}
                            onClick={() => setRoots(roots.filter((_, j) => j !== i))}
                          >
                            <i className="fas fa-times" />
                          </button>
                        </div>
                      ))
                    )}
                    <div className="st-row st-row--end">
                      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void saveModelRoots()}>
                        <i className="fas fa-floppy-disk" />
                        保存
                      </button>
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** 取路径所在目录（表格里的「路径」列只显示目录，exe 文件名放 title） */
function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}

