import { useEffect, useRef, useState } from "react";
import { errText, ipc } from "../ipc";
import type { StrataEngine } from "../types";
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
  const setStrataRoot = useApp((s) => s.setStrataRoot);
  const refreshStrata = useApp((s) => s.refreshStrata);
  const strataStatus = useApp((s) => s.strataStatus);
  const writeStrataConfig = useApp((s) => s.writeStrataConfig);
  const setError = useApp((s) => s.setError);
  const setNotice = useApp((s) => s.setNotice);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const versions = useApp((s) => s.versions);
  const deviceError = useApp((s) => s.deviceError);
  /** `engine-bundle` 下可选的 Strata 引擎版本（用户 m03027：「通用」里选引擎） */
  const [strataEngines, setStrataEngines] = useState<StrataEngine[]>([]);
  const [tab, setTab] = useState<Tab>("service");
  const [llamaDir, setLlamaDir] = useState("");
  const [modelsMax, setModelsMax] = useState("4"); /** 空闲释放模型的秒数（-1 = 关闭） */
  const [sleepIdle, setSleepIdle] = useState("-1"); /** 引擎的 API Key：保存时写进每个引擎的 config，llama.cpp 与 Strata 共用（用户 m06341） */
  const [apiKey, setApiKey] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
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
    return; primed.current = true; setLlamaDir(settings.llama_cpp_dir ?? ""); setModelsMax(String(settings.models_max)); setSleepIdle(String(settings.sleep_idle_seconds ?? -1)); setApiKey(settings.api_key ?? ""); setRoots(settings.model_roots ?? []); setStrataDir(settings.strata_root ?? ""); setStrataHost(settings.strata_host ?? ""); setStrataPort(settings.strata_port != null ? String(settings.strata_port) : ""); setStrataIdle(settings.strata_idle_unload_s != null ? String(settings.strata_idle_unload_s) : ""); setStrataMinFree(settings.strata_min_free_vram_mib != null ? String(settings.strata_min_free_vram_mib) : ""); setStrataBefore(settings.strata_before_load ?? ""); void loadStrataEngines(settings.strata_root ?? null); }, [settings]);
  if (!settings) {
    return (<main className="main-area">        <div className="content-scrollable">          <div className="panel">            <div className="notice">加载设置中…</div>          </div>        </div>      </main>);
  }
  /** 列 `engine-bundle` 下的引擎版本，供「通用 → Strata 引擎」选择 */
  async function loadStrataEngines(root: string | null) {
    if (!root) {
      setStrataEngines([]);
      return;
    }
    try {
      setStrataEngines(await ipc.strataEngines(root));
    } catch (err) {
      setStrataEngines([]);
      setError(`读取 Strata 引擎列表失败：${errText(err)}`);
    }
  }

  /** 选中某个引擎：写进全部 `strata-*.json` 的 `exe`，再记进设置（全局默认） */
  async function pickStrataEngine(exe: string) {
    if (!settings || settings.strata_engine === exe) return;
    try {
      const changed = await ipc.strataApplyEngine(exe);
      await saveSettings({ strata_engine: exe });
      setNotice(`已把 ${changed.length} 份 config 的引擎切到 ${exe}（重启引擎后生效）`);
      await refreshStrata();
    } catch (err) {
      setError(`切换 Strata 引擎失败：${errText(err)}`);
    }
  }

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
      const nextPort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : null;
      const nextMax = Number(modelsMax) || 4;
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
          if (key)
            cfg.api_key = key;
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
      if (strataWritten > 0) {
        notes.push(`Strata ${strataWritten} 份`);
        await saveSettings({ strata_idle_unload_s: idle, strata_min_free_vram_mib: minFree, strata_before_load: before || null, });
      }
      if (proxyRunning && (hostChanged || portChanged)) {
        useApp.getState().stopStrataProxy();
        useApp.getState().startStrataProxy();
        notes.push("前门已按新地址/端口重启");
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
  return (<main className="main-area">      <div className="top-bar">        <h1 className="page-title">设置</h1>        <div className="st-tabs" role="tablist" aria-label="分组">          {TABS.map((t) => (<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`st-tab${tab === t.id ? " is-active" : ""}`} onClick={() => setTab(t.id)}>              {t.label}            </button>))}        </div>        <div className="top-actions">          <button type="button" className="st-btn st-btn--secondary st-btn--sm" title="切换明暗主题" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>            <i className={`fas ${theme === "dark" ? "fa-sun" : "fa-moon"}`}/>            {theme === "dark" ? "浅色" : "深色"}          </button>        </div>      </div>      <div className="content-scrollable">        <div className="st-settings">          {tab === "service" && (<>              <div className="st-cards">                <section className="st-card st-card--wide">                  <div className="st-card__head">                    <i className="fas fa-server"/>                    <h2 className="st-card__title">前门与服务</h2>                    <span className="st-spacer"/>                    <span className="st-sub">                      {strataStatus.proxy ? `运行中 · :${strataStatus.proxy_port ?? 9090}${strataStatus.running ? `（当前引擎 :${strataStatus.port}）` : ""}` : "未运行"}                    </span>                  </div>                  <div className="st-card__body">                    <div className="st-grid">                      <label className="st-field">                        <span className="st-label">前门监听地址</span>                        <input className="st-input" value={strataHost} placeholder="127.0.0.1" onChange={(e) => setStrataHost(e.target.value)}/>                      </label>                      <label className="st-field">                        <span className="st-label">前门端口</span>                        <input className="st-input" value={strataPort} placeholder="9090" onChange={(e) => setStrataPort(e.target.value)}/>                      </label>                      <label className="st-field">                        <span className="st-label">同时加载模型上限</span>                        <input className="st-input" value={modelsMax} placeholder="4" onChange={(e) => setModelsMax(e.target.value)}/>                      </label>                      <label className="st-field">                        <span className="st-label">空闲释放模型（秒）</span>                        <input className="st-input" value={sleepIdle} placeholder="-1" title="-1 = 关闭" onChange={(e) => setSleepIdle(e.target.value)}/>                      </label>                    </div>                    <label className="st-field">                      <span className="st-label">API Key</span>                      <input className="st-input st-input--mono" value={apiKey} placeholder="sk-…" onChange={(e) => setApiKey(e.target.value)}/>                    </label>                    <div className="st-row st-row--end">                      <button type="button" className="st-btn st-btn--primary" disabled={busy || strataSaving} onClick={() => void saveService()}>                        <i className={`fas ${strataSaving ? "fa-spinner fa-spin" : "fa-floppy-disk"}`}/>                        保存                      </button>                    </div>                  </div>                </section>                <section className="st-card">                  <div className="st-card__head">                    <i className="fas fa-layer-group"/>                    <h2 className="st-card__title">Strata 引擎</h2>                  </div>                  <div className="st-card__body">                    <div className="st-grid">                      <label className="st-field">                        <span className="st-label">引擎空闲卸载（秒）</span>                        <input className="st-input" value={strataIdle} placeholder="留空 = 不启用" onChange={(e) => setStrataIdle(e.target.value)}/>                      </label>                      <label className="st-field">                        <span className="st-label">显存门槛（MiB）</span>                        <input className="st-input" value={strataMinFree} placeholder="留空 = 不启用" onChange={(e) => setStrataMinFree(e.target.value)}/>                      </label>                    </div>                    <label className="st-field">                      <span className="st-label">加载前命令</span>                      <input className="st-input st-input--mono" value={strataBefore} placeholder="留空 = 不启用" onChange={(e) => setStrataBefore(e.target.value)}/>                    </label>                    <div className="st-switch-row">                      <div className="st-switch-row__text">                        <span className="st-switch-row__label">Strata 与 llama.cpp 显存互斥</span>                      </div>                      <input type="checkbox" className="switch-input" checked={settings.strata_router_mutex} disabled={busy} onChange={(e) => void saveSettings({ strata_router_mutex: e.target.checked })}/>                    </div>                    <div className="st-row st-row--end">                      <button type="button" className="st-btn st-btn--primary" disabled={busy || strataSaving} onClick={() => void saveService()}>                        <i className={`fas ${strataSaving ? "fa-spinner fa-spin" : "fa-floppy-disk"}`}/>                        保存                      </button>                    </div>                  </div>                </section>                <section className="st-card">                  <div className="st-card__head">                    <i className="fas fa-window-restore"/>                    <h2 className="st-card__title">启动与托盘</h2>                  </div>                  <div className="st-card__body">                    <div className="st-switch-row">                      <div className="st-switch-row__text">                        <span className="st-switch-row__label">开机自启动</span>                      </div>                      <input type="checkbox" className="switch-input" checked={autostart ?? settings.autostart} disabled={busy} onChange={(e) => void toggleAutostart(e.target.checked)}/>                    </div>                    <div className="st-switch-row">                      <div className="st-switch-row__text">                        <span className="st-switch-row__label">关闭窗口时最小化到托盘</span>                      </div>                      <input type="checkbox" className="switch-input" checked={settings.minimize_to_tray} disabled={busy} onChange={(e) => void saveSettings({ minimize_to_tray: e.target.checked })}/>                    </div>                  </div>                </section>              </div>            </>)}          {tab === "paths" && (<>              
                <div className="st-cards">
                <section className="st-card st-card--wide">
                  <div className="st-card__head">
                    <i className="fas fa-microchip"/>
                    <h2 className="st-card__title">Strata 引擎</h2>
                    <span className="st-badge">{strataEngines.length} 个版本</span>
                    <span className="st-spacer"/>
                    <button type="button" className="st-btn st-btn--secondary st-btn--sm" disabled={busy || !settings.strata_root} title="重新扫描 Strata 安装目录下的 engine-bundle" onClick={() => void loadStrataEngines(settings.strata_root ?? null)}>
                      <i className="fas fa-radar"/>
                      扫描引擎
                    </button>
                  </div>
                  <div className="st-card__body">
                    {strataEngines.length === 0 ? (<div className="st-hint">未发现引擎：先在下面指定 Strata 安装目录，引擎在 engine-bundle 下。</div>) : (<div className="st-scroll">
                        <table className="st-table">
                          <thead>
                            <tr>
                              <th>选择</th>
                              <th>版本</th>
                              <th>后端</th>
                              <th>架构</th>
                              <th>路径</th>
                            </tr>
                          </thead>
                          <tbody>
                            {strataEngines.map((item) => (<tr key={item.exe}>
                                <td>
                                  <input type="radio" name="st-strata-engine" checked={(settings.strata_engine ?? "") === item.exe} onChange={() => void pickStrataEngine(item.exe)}/>
                                </td>
                                <td className="mono">{item.version ?? "未知"}</td>
                                <td>{item.backend ?? "—"}</td>
                                <td>{item.archs.length ? item.archs.join(" / ") : "—"}</td>
                                <td className="mono break-all" title={item.exe}>{item.exe}</td>
                              </tr>))}
                          </tbody>
                        </table>
                      </div>)}
                    <div className="st-hint">选中后立即把全部 strata-*.json 的 exe 改成该版本（重启引擎生效）。</div>
                  </div>
                </section>                <section className="st-card st-card--wide">                  <div className="st-card__head">                    <i className="fas fa-cubes"/>                    <h2 className="st-card__title">llama.cpp 引擎版本</h2>                    <span className="st-badge">{versions.length} 个版本</span>                    <span className="st-spacer"/>                    <button type="button" className="st-btn st-btn--secondary st-btn--sm" disabled={busy || !settings.llama_cpp_dir} title="重新扫描 llama.cpp 安装目录下的版本" onClick={() => void refreshVersions(true)}>                      <i className="fas fa-radar"/>                      扫描版本                    </button>                  </div>                  <div className="st-card__body">                    {deviceError && (<div className="notice warn">                        <i className="fas fa-triangle-exclamation"/>                        {deviceError}                      </div>)}                    {versions.length === 0 ? (<div className="st-hint">未发现版本，请先在「通用」里指定 llama.cpp 安装目录。</div>) : (<div className="st-scroll">                        <table className="st-table">                          <thead>                            <tr>                              <th>选择</th>                              <th>版本</th>                              <th>路径</th>                              <th>共享 CUDA 运行时</th>                              <th>fit-params</th>                            </tr>                          </thead>                          <tbody>                            {versions.map((v) => (<tr key={v.name}>                                <td>                                  <input type="radio" name="st-version" checked={selectedVersion === v.name} onChange={() => void saveSettings({ selected_version: v.name })}/>                                </td>                                <td className="mono">{v.name}</td>                                <td>                                  {v.ascii_safe ? (<span className="st-badge st-badge--ok">纯 ASCII</span>) : (<span className="st-badge st-badge--warn" title="安装目录含非 ASCII 字符，启动时会自动改用 ASCII 链接目录">                                      含非 ASCII                                    </span>)}                                </td>                                <td>                                  {v.shared_lib_dirs.length === 0 ? (<span className="st-badge st-badge--warn" title="未匹配到直接包含 cudart64_/cublas64_ 的目录，GPU 将不可用">                                      未匹配                                    </span>) : (<details className="st-collapse">                                      <summary>                                        <span className="st-badge st-badge--ok">已就绪</span>                                        {v.shared_lib_dirs.length} 个目录                                        <i className="fas fa-chevron-down st-chev"/>                                      </summary>                                      <div className="st-collapse__body">                                        <ul>                                          {v.shared_lib_dirs.map((d) => (<li className="mono break-all" key={d} title={d}>                                              {d}                                            </li>))}                                        </ul>                                      </div>                                    </details>)}                                </td>                                <td>{v.fit_params_bin ? <i className="fas fa-check"/> : "—"}</td>                              </tr>))}                          </tbody>                        </table>                      </div>)}                  </div>                </section>                <section className="st-card">                  <div className="st-card__head">                    <i className="fas fa-folder-tree"/>                    <h2 className="st-card__title">llama.cpp 安装目录</h2>                  </div>                  <div className="st-card__body">                    <div className="st-row">                      <input className="st-input" value={llamaDir} placeholder="E:\AI\llama.cpp-hub\llamacpp" onChange={(e) => setLlamaDir(e.target.value)}/>                      <button type="button" className="st-btn st-btn--secondary" onClick={() => void pickDirectory().then((p) => { if (p)
    setLlamaDir(p); })}>                        <i className="fas fa-folder-open"/>                        浏览                      </button>                      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void saveLlamaDir()}>                        <i className="fas fa-floppy-disk"/>                        保存                      </button>                    </div>                  </div>                </section>                <section className="st-card">                  <div className="st-card__head">                    <i className="fas fa-folder-tree"/>                    <h2 className="st-card__title">Strata 安装目录</h2>                  </div>                  <div className="st-card__body">                    <div className="st-row">                      <input className="st-input" value={strataDir} placeholder="E:\AI\Strata" onChange={(e) => setStrataDir(e.target.value)}/>                      <button type="button" className="st-btn st-btn--secondary" onClick={() => void pickDirectory().then((p) => { if (p)
    setStrataDir(p); })}>                        <i className="fas fa-folder-open"/>                        浏览                      </button>                      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void setStrataRoot(strataDir.trim())}>                        <i className="fas fa-floppy-disk"/>                        保存                      </button>                    </div>                  </div>                </section>                <section className="st-card st-card--wide">                  <div className="st-card__head">                    <i className="fas fa-list"/>                    <h2 className="st-card__title">模型根目录</h2>                    <span className="st-spacer"/>                    <button type="button" className="st-btn st-btn--secondary st-btn--sm" disabled={busy} onClick={() => setRoots([...roots, ""])}>                      <i className="fas fa-plus"/>                      添加目录                    </button>                  </div>                  <div className="st-card__body">                    {roots.length === 0 ? (<div className="st-hint">还没有添加模型目录。</div>) : ( /* key 不能用被编辑的值：每敲一个字就会重建 div，输入框会丢焦点 */roots.map((r, i) => (<div className="st-row" key={i}>                          <input className="st-input" value={r} placeholder="E:\AI\models" onChange={(e) => setRoots(roots.map((x, j) => (j === i ? e.target.value : x)))}/>                          <button type="button" className="st-btn st-btn--icon" title="移除" disabled={busy} onClick={() => setRoots(roots.filter((_, j) => j !== i))}>                            <i className="fas fa-times"/>                          </button>                        </div>)))}                    <div className="st-row st-row--end">                      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void saveModelRoots()}>                        <i className="fas fa-floppy-disk"/>                        保存                      </button>                    </div>                  </div>                </section>              </div>            </>)}        </div>      </div>    </main>);
}
