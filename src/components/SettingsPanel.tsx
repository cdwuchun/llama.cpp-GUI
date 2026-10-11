import { useEffect, useRef, useState } from "react";

import { errText, ipc } from "../ipc";
import { useApp } from "../store";
import { Modal } from "./Sheet";

export function SettingsPanel() {
  const settings = useApp((s) => s.settings);
  const busy = useApp((s) => s.busy);
  const saveSettings = useApp((s) => s.saveSettings);
  const refreshVersions = useApp((s) => s.refreshVersions);
  const refreshDevices = useApp((s) => s.refreshDevices);
  const refreshModels = useApp((s) => s.refreshModels);
  const setStrataRoot = useApp((s) => s.setStrataRoot);
  const strataStatus = useApp((s) => s.strataStatus);
  const startStrataProxy = useApp((s) => s.startStrataProxy);
  const stopStrataProxy = useApp((s) => s.stopStrataProxy);
  const writeStrataConfig = useApp((s) => s.writeStrataConfig);
  const setError = useApp((s) => s.setError);
  const setNotice = useApp((s) => s.setNotice);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);

  const [llamaDir, setLlamaDir] = useState("");
  const [port, setPort] = useState("8080");
  const [modelsMax, setModelsMax] = useState("4");
  /** 空闲释放模型的秒数（-1 = 关闭） */
  const [sleepIdle, setSleepIdle] = useState("-1");
  const [apiKey, setApiKey] = useState("");
  const [roots, setRoots] = useState<string[]>([]);
  const [strataDir, setStrataDir] = useState("");
  /** Strata 的 host / 端口 / 密钥覆盖项（留空 = 用 config 与 run 脚本的原值） */
  const [strataHost, setStrataHost] = useState("");
  const [strataPort, setStrataPort] = useState("");
  const [strataKey, setStrataKey] = useState("");
  /** 空闲多少秒后卸载模型（写 config 顶层 idle_unload_s） */
  const [strataIdle, setStrataIdle] = useState("");
  /** 空闲显存低于此 MiB 就不加载模型（写 config 顶层 min_free_vram_mib） */
  const [strataMinFree, setStrataMinFree] = useState("");
  /** 加载模型前执行的命令（写 config 顶层 before_load） */
  const [strataBefore, setStrataBefore] = useState("");
  const [strataAutoStart, setStrataAutoStart] = useState(false);
  /** 「服务」分组正在把 host/端口/密钥写进各 config */
  const [strataSaving, setStrataSaving] = useState(false);
  /** 注册表里的真实自启动状态（可能与设置文件不同步：用户手动删过注册表项） */
  const [autostart, setAutostart] = useState<boolean | null>(null);
  /** 服务卡里改了"必须重启 router 才生效"的项时，先弹窗问一句；这里存变化清单与待保存的值 */
  const [restartAsk, setRestartAsk] = useState<{
    changed: string[];
    key: string;
    port: number;
    max: number;
    sleep: number;
  } | null>(null);

  useEffect(() => {
    void ipc
      .autostartGet()
      .then(setAutostart)
      .catch(() => setAutostart(null));
  }, []);

  // 只在**首次拿到设置**时把值灌进表单。
  //
  // 之前依赖 `[settings]`：settings 对象一换（勾个开关、保存一次、刷新版本都会换）
  // 就把用户没保存的编辑（目录、端口、models_max、API Key）整体回滚成磁盘上的值。
  const primed = useRef(false);
  useEffect(() => {
    if (!settings || primed.current) return;
    primed.current = true;
    setLlamaDir(settings.llama_cpp_dir ?? "");
    setPort(String(settings.port));
    setModelsMax(String(settings.models_max));
    setSleepIdle(String(settings.sleep_idle_seconds ?? -1));
    setApiKey(settings.api_key ?? "");
    setRoots(settings.model_roots ?? []);
    setStrataDir(settings.strata_root ?? "");
    setStrataHost(settings.strata_host ?? "");
    setStrataPort(settings.strata_port != null ? String(settings.strata_port) : "");
    setStrataKey(settings.strata_api_key ?? "");
    setStrataIdle(settings.strata_idle_unload_s != null ? String(settings.strata_idle_unload_s) : "");
    setStrataMinFree(
      settings.strata_min_free_vram_mib != null ? String(settings.strata_min_free_vram_mib) : "",
    );
    setStrataBefore(settings.strata_before_load ?? "");
    setStrataAutoStart(!!settings.auto_start_strata);
  }, [settings]);

  if (!settings) {
    return (
      <main className="main-area">
        <div className="content-scrollable">
          <div className="notice" style={{ marginTop: "1.5rem" }}>
            加载设置中…
          </div>
        </div>
      </main>
    );
  }

  const pickDirectory = async (): Promise<string | null> => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "选择目录" });
      return typeof selected === "string" ? selected : null;
    } catch (err) {
      useApp.getState().setError(String(err));
      return null;
    }
  };

  /** 服务卡里改动过、且必须重启 router 才生效的项（没改就是空数组）。 */
  const coreChanges = (
    key: string,
    nextPort: number,
    nextMax: number,
    nextSleep: number,
  ): string[] => {
    const changed: string[] = [];
    if (nextPort !== settings.port) changed.push(`端口 ${settings.port} → ${nextPort}`);
    if (nextMax !== settings.models_max) changed.push(`上限 ${settings.models_max} → ${nextMax}`);
    const prevSleep = settings.sleep_idle_seconds ?? -1;
    if (nextSleep !== prevSleep) changed.push(`空闲释放 ${prevSleep} → ${nextSleep}`);
    if (key !== (settings.api_key ?? "")) changed.push("API Key");
    return changed;
  };

  /** 落盘（弹窗里选"保存并重启"时接着重启 router） */
  const commitCore = async (restart: boolean) => {
    const pending = restartAsk;
    if (!pending) return;
    setRestartAsk(null);
    const saved = await saveSettings({
      // 空串表示"清空"：JSON null 会被后端当成"此字段不改"，清不掉旧值
      llama_cpp_dir: llamaDir.trim(),
      port: pending.port,
      models_max: pending.max,
      sleep_idle_seconds: pending.sleep,
      api_key: pending.key,
    });
    if (!saved) return;
    if (restart) {
      await useApp.getState().restartRouter();
    } else if (pending.changed.length > 0) {
      setNotice("已保存，重启 router 后生效");
    }
  };

  const saveCore = async () => {
    const key = apiKey.trim();
    const nextPort = Number(port) || 8080;
    const nextMax = Number(modelsMax) || 4;
    // 空闲释放：llama.cpp 只在 > 0 时生效，其余（-1 / 0 / 空）都表示关闭
    const parsedSleep = Math.trunc(Number(sleepIdle));
    const nextSleep = Number.isFinite(parsedSleep) ? parsedSleep : -1;
    // HTTP 请求头只装得下 ASCII：中文/全角字符会让浏览器直接拒绝发送该请求
    if (key && !/^[\x20-\x7e]+$/.test(key)) {
      setError("API Key 只能用英文、数字和常见符号（HTTP 请求头不支持中文）");
      return;
    }

    // 端口 / 上限 / 空闲释放 / API Key 都是 router 的**启动参数**：router 正在跑的时候
    // 只写盘不生效，而界面已经按新值去请求 —— 端口对不上就整个连不上，key 对不上就全是 401。
    // 所以这里先问一句要不要立刻重启，别让用户以为"点了保存却没反应"。
    const running = useApp.getState().status.running;
    const changed = coreChanges(key, nextPort, nextMax, nextSleep);
    if (changed.length > 0 && running) {
      setRestartAsk({ changed, key, port: nextPort, max: nextMax, sleep: nextSleep });
      return;
    }

    await saveSettings({
      llama_cpp_dir: llamaDir.trim(),
      port: nextPort,
      models_max: nextMax,
      sleep_idle_seconds: nextSleep,
      api_key: key,
    });
  };

  /** 保存 llama.cpp 目录：顺手重新扫描版本与设备，省得再点一次「保存并扫描」。 */
  const saveLlamaDir = async () => {
    await saveSettings({ llama_cpp_dir: llamaDir.trim() });
    await refreshVersions(false);
    await refreshDevices();
  };

  /** 保存模型根目录：保存完自动扫描（用户不必再点「保存并扫描模型」）。 */
  const saveModelRoots = async () => {
    await saveSettings({ model_roots: roots.map((r) => r.trim()).filter(Boolean) });
    await refreshModels(true);
  };

  /**
   * 保存 Strata 的服务项（用户 m01623）。
   *
   * `host` / `port` 现在是**前门代理**的监听地址与端口（用户 m00798），只存进 GUI 设置，
   * **不再写进各 config**：每个模型的引擎端口属于它自己的 config 与 `run-<模型>.bat`，
   * 前门按请求里的 `model` 自动停旧引擎、起新引擎。
   * 其余项仍然直接写进所有 `strata-*.json` 的顶层字段（`api_key` / `idle_unload_s` /
   * `min_free_vram_mib` / `before_load`），不碰 `args`（R6），也不往启动命令里追加参数（R1）
   * —— 上游 setup.py 自己也是这么写 config 的。序列化用 indent=1，与上游
   * `json.dumps(cfg, indent=1)` 一致。config 的改动在下一次启动引擎时生效。
   */
  const saveStrataService = async () => {
    const host = strataHost.trim();
    const key = strataKey.trim();
    if (key && !/^[\x20-\x7e]+$/.test(key)) {
      setError("API Key 只能用英文、数字和常见符号（HTTP 请求头不支持中文）");
      return;
    }
    const parsed = Math.trunc(Number(strataPort));
    const port = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    const idleParsed = Math.trunc(Number(strataIdle));
    const idle = Number.isFinite(idleParsed) && idleParsed > 0 ? idleParsed : null;
    const freeParsed = Math.trunc(Number(strataMinFree));
    const minFree = Number.isFinite(freeParsed) && freeParsed > 0 ? freeParsed : null;
    const before = strataBefore.trim();
    // 代理地址/端口只进 GUI 设置（代理监听它们，跟各 config 的引擎端口是两回事）
    await saveSettings({ strata_host: host || null, strata_port: port });
    if (!key && idle === null && minFree === null && !before) {
      setNotice(
        `Strata 代理监听地址/端口已保存（${host || "127.0.0.1"}:${port ?? 9090}）${
          strataStatus.proxy ? "；代理正在运行，重启代理后生效" : ""
        }`,
      );
      return;
    }
    setStrataSaving(true);
    try {
      const files = await ipc.strataScan();
      if (!files.length) {
        setError("没有扫描到 strata-*.json，请先在「目录」里填 Strata 安装目录");
        return;
      }
      const written: string[] = [];
      const failed: string[] = [];
      for (const entry of files) {
        const file = entry.config_path.split(/[\\/]/).pop() ?? "";
        try {
          const cfg = JSON.parse(await ipc.strataConfigRead(file)) as Record<string, unknown>;
          // 不再写 host / port：它们是前门的设置（上面已存进 GUI 设置），写进 config 会把
          // 各模型自己的引擎端口覆盖成前门端口
          if (key) cfg.api_key = key;
          // 空闲卸载 / 显存门槛 / 加载前命令：留空 = 不动 config 里的原值
          if (idle !== null) cfg.idle_unload_s = idle;
          if (minFree !== null) cfg.min_free_vram_mib = minFree;
          if (before) cfg.before_load = before;
          if (await writeStrataConfig(file, JSON.stringify(cfg, null, 1))) written.push(file);
          else failed.push(file);
        } catch (err) {
          failed.push(`${file}：${errText(err)}`);
        }
      }
      if (written.length) {
        await saveSettings({
          strata_api_key: key || null,
          strata_idle_unload_s: idle,
          strata_min_free_vram_mib: minFree,
          strata_before_load: before || null,
        });
      }
      const fields = [
        key && "API Key",
        idle !== null && "空闲卸载",
        minFree !== null && "显存门槛",
        before && "加载前命令",
      ]
        .filter(Boolean)
        .join("、");
      if (failed.length) {
        setError(`已写入 ${written.length} 个 config；未写入：${failed.join("；")}`);
      } else if (written.length) {
        setNotice(
          `已把${fields}写入 ${written.length} 个 config${
            strataStatus.running ? "；正在运行的 Strata 仍连着旧值，停止后再启动才生效" : "，启动 Strata 后生效"
          }`,
        );
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setStrataSaving(false);
    }
  };

  /** 自启动走官方插件：先改注册表，成功后再同步设置文件与界面状态。 */
  const toggleAutostart = async (enabled: boolean) => {
    try {
      const actual = await ipc.autostartSet(enabled);
      setAutostart(actual);
      await saveSettings({ autostart: actual });
      setNotice(actual ? "已开启开机自启动" : "已关闭开机自启动");
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>设置</span>
        </h1>
        <div className="top-actions">
          <button
            type="button"
            className="btn btn-secondary btn-uniform"
            title="切换浅色 / 深色主题"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <i className={`fas ${theme === "dark" ? "fa-sun" : "fa-moon"}`} />
            <span>{theme === "dark" ? "浅色" : "深色"}</span>
          </button>
        </div>
      </div>

      <div className="content-scrollable">
        <div className="panel" style={{ marginTop: "1.5rem" }}>
          <div className="panel-head">
            <i className="fas fa-folder-tree" />
            <span>目录</span>
          </div>
          <div className="panel-body">
            <div className="form-group">
              <label className="form-label">llama.cpp 安装目录（其下可含多个版本子目录）</label>
              <div className="row" style={{ gap: "0.5rem", flexWrap: "nowrap" }}>
                <input
                  className="form-control"
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                  value={llamaDir}
                  onChange={(e) => setLlamaDir(e.target.value)}
                  placeholder="E:\AI\llama.cpp-hub\llamacpp"
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-uniform"
                  onClick={async () => {
                    const picked = await pickDirectory();
                    if (picked) setLlamaDir(picked);
                  }}
                >
                  <i className="fas fa-folder-open" /> 浏览
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-uniform"
                  onClick={() => void saveLlamaDir()}
                  disabled={busy}
                >
                  <i className="fas fa-save" /> 保存
                </button>
              </div>
              <small className="form-text">
                保存时会一起重新扫描版本与 GPU 设备。版本扫描会为每个版本匹配同级的共享 CUDA 运行时目录（
                <code>cudart-*-cuda-&lt;X.Y&gt;-*</code>）；路径含中文时，启动会自动改用 ASCII 链接目录。
              </small>
            </div>

            <div className="form-group">
              <label className="form-label">模型根目录（递归扫描 .gguf，为每个模型生成 presets.ini 段）</label>
              {roots.map((root, i) => (
                <div
                  className="row"
                  // key 里**不能**放被编辑的值：那会让 React 每输入一个字符就
                  // 卸载/重建这个 div，输入框随之失焦（点进去敲一个字光标就没了）。
                  key={i}
                  style={{ marginBottom: "0.5rem", gap: "0.5rem", flexWrap: "nowrap" }}
                >
                  <input
                    className="form-control"
                    style={{ flex: "1 1 auto", minWidth: 0 }}
                    value={root}
                    placeholder="E:\AI\models"
                    onChange={(e) => setRoots(roots.map((r, j) => (j === i ? e.target.value : r)))}
                  />
                  <button
                    type="button"
                    className="btn-icon"
                    style={{ flexShrink: 0 }}
                    title="移除"
                    onClick={() => setRoots(roots.filter((_, j) => j !== i))}
                  >
                    <i className="fas fa-times" />
                  </button>
                </div>
              ))}
              <div className="row" style={{ gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-uniform"
                  onClick={async () => {
                    const picked = await pickDirectory();
                    if (picked) setRoots([...roots, picked]);
                  }}
                >
                  <i className="fas fa-plus" /> 添加目录
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-uniform"
                  disabled={busy}
                  onClick={() => void saveModelRoots()}
                >
                  <i className="fas fa-save" /> 保存
                </button>
              </div>
              <small className="form-text">
                点「保存」即自动重新扫描模型。不使用 router 的 <code>--models-dir</code>
                ：实测它只扫描一层，两级目录（作者/模型）会得到 0 个模型；因此由应用递归扫描后写入 preset 文件。
              </small>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Strata 安装目录（其下含 serve\server.py、.venv 与 strata-*.json）</label>
              <div className="row" style={{ gap: "0.5rem", flexWrap: "nowrap" }}>
                <input
                  className="form-control"
                  style={{ flex: "1 1 auto", minWidth: 0 }}
                  value={strataDir}
                  onChange={(e) => setStrataDir(e.target.value)}
                  placeholder="E:\AI\Strata"
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-uniform"
                  onClick={async () => {
                    const picked = await pickDirectory();
                    if (picked) setStrataDir(picked);
                  }}
                >
                  <i className="fas fa-folder-open" /> 浏览
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-uniform"
                  disabled={busy}
                  onClick={() => void setStrataRoot(strataDir.trim())}
                >
                  <i className="fas fa-save" /> 保存
                </button>
              </div>
              <small className="form-text">
                GUI 只记这一个路径，模型列表、启动命令与安装事实全部从 <code>strata-*.json</code> 与
                <code>run-&lt;模型&gt;.bat</code> 现读 —— 上游升级把代码目录整体换新也不影响这里。
                Strata 与 router <b>共用显存</b>，两边同时启动可能加载失败。
              </small>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <i className="fas fa-server" />
            <span>服务</span>
          </div>
          <div className="panel-body">
            <div className="row" style={{ gap: "0.75rem", alignItems: "flex-end" }}>
              <div style={{ width: 140 }}>
                <label className="form-label" style={{ fontSize: "0.8rem" }}>
                  router 端口
                </label>
                <input className="form-control" value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
              <div style={{ width: 200 }}>
                <label className="form-label" style={{ fontSize: "0.8rem" }}>
                  同时加载模型上限
                </label>
                <input
                  className="form-control"
                  value={modelsMax}
                  onChange={(e) => setModelsMax(e.target.value)}
                />
              </div>
              <div style={{ width: 170 }}>
                <label className="form-label" style={{ fontSize: "0.8rem" }}>
                  空闲释放模型（秒）
                </label>
                <input
                  className="form-control"
                  value={sleepIdle}
                  title="空闲超过这个秒数就释放模型与显存，下次请求自动重新加载；休眠后应用会自动卸载该实例，把残留的显存也放掉；-1 = 关闭"
                  onChange={(e) => setSleepIdle(e.target.value)}
                />
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                <label className="form-label" style={{ fontSize: "0.8rem" }}>
                  API Key（可选，留空则不鉴权）
                </label>
                <input className="form-control" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              </div>
              <button
                type="button"
                className="btn btn-primary btn-uniform"
                onClick={() => void saveCore()}
                disabled={busy}
              >
                <i className="fas fa-save" /> 保存
              </button>
            </div>
            <small className="form-text">
              这几项都是 router 的启动参数，改动在下一次启动 router 时生效。
              空闲释放：模型空闲超过设定秒数就释放模型与显存（连投影文件、草稿模型一起放掉），
              下次请求自动重新加载，对**所有**模型生效，-1 表示关闭。
              原生 sleep 只是把权重放掉，子进程与 CUDA 上下文还会占着一两百 MB；
              界面检测到模型进入休眠后会立刻把它彻底卸载（显存归零），下次请求照样自动加载回来。
              GPU 与多卡相关参数不在本页 ——
              默认不限制设备即可让所有显卡参与（原生 <code>--fit</code> 自动分层），需要按模型覆盖时在
              模型配置面板里改。
            </small>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Strata 代理 / 服务项（填了才写，留空的项保留各 config 原值）</label>
              {/* 代理（前门）：一个端口挂全部 config，按请求里的 model 自动切换引擎（用户 m00798 / m01151）。
                  DSH 等客户端连的就是这里，各模型的引擎端口在它们自己的 config / run-<模型>.bat 里。 */}
              <div className="row" style={{ gap: "0.5rem", alignItems: "center", marginBottom: "0.4rem" }}>
                <span className="form-text" style={{ margin: 0 }}>
                  代理{strataStatus.proxy ? `运行中 · :${strataStatus.proxy_port ?? 9090}` : "未运行"}
                  {strataStatus.proxy && strataStatus.running ? `（当前引擎 :${strataStatus.port}）` : ""}
                  {" —— "}客户端连代理，代理按请求里的 <code>model</code> 自动切换引擎
                </span>
                <button
                  type="button"
                  className={`btn btn-sm ${strataStatus.proxy ? "btn-danger" : "btn-primary"}`}
                  disabled={busy}
                  onClick={() => void (strataStatus.proxy ? stopStrataProxy() : startStrataProxy())}
                >
                  <i className={`fas ${strataStatus.proxy ? "fa-stop" : "fa-play"}`} />{" "}
                  {strataStatus.proxy ? "停止代理" : "启动代理"}
                </button>
              </div>
              <div className="row" style={{ gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
                <div style={{ width: 130 }}>
                  <label className="form-label" style={{ fontSize: "0.8rem" }}>
                    代理监听地址
                  </label>
                  <input
                    className="form-control"
                    style={{ width: 130 }}
                    value={strataHost}
                    placeholder="127.0.0.1"
                    onChange={(e) => setStrataHost(e.target.value)}
                  />
                </div>
                <div style={{ width: 130 }}>
                  <label className="form-label" style={{ fontSize: "0.8rem" }}>
                    代理端口
                  </label>
                  <input
                    className="form-control"
                    style={{ width: 130 }}
                    value={strataPort}
                    placeholder="9090"
                    onChange={(e) => setStrataPort(e.target.value)}
                  />
                </div>
                <div style={{ width: 130 }}>
                  <label className="form-label" style={{ fontSize: "0.8rem" }}>
                    空闲卸载（秒）
                  </label>
                  <input
                    className="form-control"
                    style={{ width: 130 }}
                    value={strataIdle}
                    placeholder="留空 = 不启用"
                    onChange={(e) => setStrataIdle(e.target.value)}
                  />
                </div>
                <div style={{ width: 130 }}>
                  <label className="form-label" style={{ fontSize: "0.8rem" }}>
                    显存门槛（MiB）
                  </label>
                  <input
                    className="form-control"
                    style={{ width: 130 }}
                    value={strataMinFree}
                    placeholder="留空 = 不启用"
                    onChange={(e) => setStrataMinFree(e.target.value)}
                  />
                </div>
                <div style={{ width: 130 }}>
                  <label className="form-label" style={{ fontSize: "0.8rem" }}>
                    加载前命令
                  </label>
                  <input
                    className="form-control"
                    style={{ width: 130 }}
                    value={strataBefore}
                    placeholder="留空 = 不启用"
                    onChange={(e) => setStrataBefore(e.target.value)}
                  />
                </div>
                <div style={{ flex: 1, minWidth: "24ch" }}>
                  <label className="form-label" style={{ fontSize: "0.8rem" }}>
                    API Key（留空 = 用 config 的 api_key）
                  </label>
                  <input
                    className="form-control"
                    style={{ minWidth: "24ch" }}
                    value={strataKey}
                    onChange={(e) => setStrataKey(e.target.value)}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-uniform"
                  onClick={() => void saveStrataService()}
                  disabled={busy || strataSaving}
                >
                  <i className={`fas ${strataSaving ? "fa-spinner fa-spin" : "fa-floppy-disk"}`} /> 保存
                </button>
              </div>
              <small className="form-text">
                <b>代理监听地址 / 代理端口</b>是 GUI 自己起的代理（默认 <code>127.0.0.1:9090</code>），
                只存进 GUI 设置、<b>不写 config</b>；DSH 等客户端连它，它按请求里的 <code>model</code>{" "}
                自动停掉旧引擎、起目标引擎。每个模型的<b>引擎端口在各自的 <code>strata-*.json</code> 与{" "}
                <code>run-&lt;模型&gt;.bat</code></b> 里（两处必须一致，否则启动时 GUI 直接报错）。
              </small>
              <small className="form-text">
                其余保存项写进所有 <code>strata-*.json</code> 的顶层字段（<code>api_key</code> /{" "}
                <code>idle_unload_s</code> / <code>min_free_vram_mib</code> / <code>before_load</code>），
                不碰 <code>args</code>，也不改上游生成的 <code>run-&lt;模型&gt;.bat</code>；
                改动在<b>下一次启动引擎</b>时生效。Strata 的端口不像 router 会自动顺延，占用时启动会直接报错。
              </small>
              <small className="form-text">
                <b>空闲卸载</b>（上游 <code>idle_unload_s</code>）：多少秒没有请求就自动卸载模型释放显存，
                下一个请求自动加载回来，给游戏和其他程序让路。<b>显存门槛</b>（<code>min_free_vram_mib</code>）：
                空闲显存不足时不加载模型并回 503。<b>加载前命令</b>（<code>before_load</code>）：
                每次要把模型加载回显存之前先跑这条命令，上游就是用它来给别的模型服务器让路。
                三项都留空 = 不启用。GUI 启动引擎时会强制写入 <code>lazy_load: true</code>，
                让侧栏胶囊只拉起引擎、不占用显存。
              </small>
              <div className="form-group" style={{ marginTop: "0.85rem" }}>
                <label className="form-check">
                  <input
                    type="checkbox"
                    className="form-check-input"
                    checked={settings.strata_router_mutex}
                    disabled={busy}
                    onChange={(e) => void saveSettings({ strata_router_mutex: e.target.checked })}
                  />
                  <span className="form-check-label">Strata 与 router 显存互斥</span>
                </label>
                <small className="form-text">
                  两个引擎抢同一块显存，同时加载会爆显存。开启后：
                  <b>启动 Strata 前自动卸载 router 里正在运行的模型</b>；
                  <b>在模型列表加载模型前自动停止 Strata</b>。
                  自动卸载会打断对方正在进行的会话，所以默认关闭。
                </small>
              </div>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <i className="fas fa-window-restore" />
            <span>启动与托盘</span>
          </div>
          <div className="panel-body">
            <div className="form-group">
              <label className="form-check">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={settings.auto_start_router}
                  disabled={busy}
                  onChange={(e) => void saveSettings({ auto_start_router: e.target.checked })}
                />
                <span className="form-check-label">打开程序就自动启动 router</span>
              </label>
              <small className="form-text">
                启动前会先确认 preset 里已有模型段（没有就自动同步一次），失败时在右下角提示原因。
              </small>
            </div>

            <div className="form-group">
              <label className="form-check">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={strataAutoStart}
                  disabled={busy}
                  onChange={(e) => {
                    setStrataAutoStart(e.target.checked);
                    void saveSettings({ auto_start_strata: e.target.checked });
                  }}
                />
                <span className="form-check-label">打开程序就自动启动 strata</span>
              </label>
              <small className="form-text">
                只拉起 Strata 引擎（会强制 <code>lazy_load: true</code>），不加载模型、不占显存；
                与 router 抢显存时请配合「服务」里的显存互斥使用。
              </small>
            </div>

            <div className="form-group">
              <label className="form-check">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={autostart ?? settings.autostart}
                  disabled={busy}
                  onChange={(e) => void toggleAutostart(e.target.checked)}
                />
                <span className="form-check-label">开机自启动（登录后启动并直接驻留托盘）</span>
              </label>
              <small className="form-text">
                写入 <code>HKCU\Software\Microsoft\Windows\CurrentVersion\Run</code>
                ；每次开启都用当前程序路径重写该项，因此移动安装目录后也不会失效。
              </small>
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-check">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={settings.minimize_to_tray}
                  disabled={busy}
                  onChange={(e) => void saveSettings({ minimize_to_tray: e.target.checked })}
                />
                <span className="form-check-label">关闭窗口时最小化到托盘（不退出应用）</span>
              </label>
              <small className="form-text">
                托盘图标：左键显示窗口；右键菜单可启动/停止 router、退出应用；悬停显示 router
                当前状态与端口。router 是独立进程，隐藏窗口不影响正在进行的推理。
              </small>
            </div>
          </div>
        </div>
      </div>

      {restartAsk && (
        <Modal
          domId="restartRouterModal"
          title="警告"
          iconClass="fa-triangle-exclamation"
          onClose={() => setRestartAsk(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary btn-uniform"
                disabled={busy}
                onClick={() => void commitCore(false)}
              >
                暂不重启
              </button>
              <button
                type="button"
                className="btn btn-primary btn-uniform"
                disabled={busy}
                onClick={() => void commitCore(true)}
              >
                <i className="fas fa-rotate-right" /> 立即重启
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>服务参数发生了变化，需要重启 router 才能生效。</p>
        </Modal>
      )}
    </main>
  );
}
