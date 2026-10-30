/**
 * Strata 页（第二运行时通道）。布局照搬模型列表页（界面改造 m01301 需求 4/5）：
 * 顶栏（搜索 / 刷新 / 排序 / 筛选 / 视图切换）+ 卡片列表 + 底部 Sheet。
 *
 * 与模型列表页的对应关系：preset 段 ↔ `strata-*.json`，「配置」按钮打开的 Sheet
 * 写回的是 config 的 `args`（不是 presets.ini）。
 *
 * 解耦规则（docs/archive/STRATA_INTEGRATION_PLAN.md §7 R1-R10）：
 * - 启动命令从 `run-<模型>.bat` 读，GUI 不自己拼（R1）
 * - 路径/端口/密钥全部从 config 现读，GUI 零硬编码（R2）
 * - 版本从运行时端点读，不缓存（R3）
 * - 能力探测不假设端点存在，读不到显示「未知/—」（R4）
 * - GUI 只写 config 的 `args` 与表单认识的顶层字段（`vision.*` / `open_browser` / `sampling.*`）；
 *   顺序与未收录参数原样保留（R6）
 * - 安装目录在「设置」页，本页不出现（m01301 需求 4）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import { ipc } from "../ipc";
import type { StrataLaunchPreset, StrataModelEntry, StrataTuneApplyRecord, StrataTuneSnapshot } from "../types";
import { ParamForm } from "./ParamForm";
import type { ParamState } from "../utils/paramSchema";
import {
  checkStrataParamEnable,
  configToState,
  stateToConfig,
  strataParamSchema,
  validateStrataParams,
  validateStrataSampling,
} from "../utils/strataParams";
import { fmtSize } from "../utils/models";
import { getModelIcon } from "../utils/modelIcon";
import { Modal } from "./Sheet";

// 排序与筛选的可选值由模型列表页的工具行给（用户 m03160 第 1 点、m03482 第 5 点：
// 两档共用同一条工具行、同一套排序选项），这里只留类型
type SortKey = "name_asc" | "name_desc" | "size_asc" | "size_desc";
type Filter = "all" | "running" | "favourite";
/** 置顶项与模型列表共用一套取值；Strata 这边只有「运行中优先」，favourite 传进来也等于没开 */
type Pinned = "none" | "active" | "favourite";

/** 排序与筛选的可选值由模型列表页的工具行给（用户 m03160 第 1 点），这里只留类型 */

/** 两栏滚动位置的记忆（与模型配置弹窗同一套做法） */
function scrollKey(file: string, pane: string) {
  return `strataConfig:${file}:${pane}`;
}
function loadScrollTop(key: string): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) ? v : 0;
}
function saveScrollTop(key: string, top: number) {
  localStorage.setItem(key, String(Math.round(top)));
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p;

/** IPC 一律用文件名（Rust 侧按 file_name 匹配 config） */
const fileOf = (e: StrataModelEntry) => basename(e.config_path);

const nameOf = (e: StrataModelEntry) => e.model_name || fileOf(e);

/** 一张 config 卡片（对应模型列表的 ModelCard） */
/** 目录比较：统一斜杠、去尾部反斜杠、忽略大小写（Windows 路径）。 */
function normFolder(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

function ConfigCard({
  entry,
  isFavourite,
  isRunning,
  isLoading,
  isStopping,
  engineHere,
  runningElsewhere,
  mutex,
  grid,
  busy,
  onToggleFavourite,
  onToggle,
  onWebui,
  onTune,
  onConfigure,

  launchPreset,
}: {
  entry: StrataModelEntry;
  isFavourite: boolean;
  isRunning: boolean;
  isLoading: boolean;
  /** 正在停止这个模型（卸模型 + 收引擎）：这段时间胶囊说「停止中」（用户 m04854） */
  isStopping: boolean;
  /** 引擎进程在跑这个 config，但模型未加载（胶囊启了引擎、模型还没拉起） */
  engineHere: boolean;
  /** 同端口上正在跑的是**另一个** config 的模型：Strata 互斥，启动时会先停掉它 */
  runningElsewhere: string | null;
  mutex: boolean;
  grid: boolean;
  busy: boolean;
  onToggleFavourite: () => void;
  onToggle: () => void;
  onWebui: () => void;
  onTune: () => void;
  onConfigure: () => void;

  /** 这份模型的 launch 预设：有就按它生成运行配置再启动（与 `strata launch` 一致） */
  launchPreset: StrataLaunchPreset | null;
}) {
  const name = nameOf(entry);
  const file = fileOf(entry);
  // 图标：模型名 / 文件名 / 引擎名都认不出时兜底用 qwen（Strata 的模型基本都是 Qwen 系）
  const icon = getModelIcon(name, file, entry.engine ?? undefined) ?? getModelIcon("qwen") ?? undefined;

  // 星标=收藏（用户 m03333 第 8 点）：和模型列表的卡片一样，只负责标记/取消标记，
  // 不再兼「默认 config」的职责 —— GUI 启动 Strata 模型不需要预先挑一个默认。
  const fav = (
    <button
      type="button"
      className={`model-fav-btn ${isFavourite ? "active" : ""}`}
      title={isFavourite ? "取消收藏" : "标记收藏"}
      onClick={onToggleFavourite}
    >
      <i className={isFavourite ? "fas fa-star" : "far fa-star"} />
    </button>
  );

  const iconBox = (
    <div className="model-icon-wrapper">
      {icon ? <img src={icon} alt="" /> : <i className="fas fa-brain" />}
    </div>
  );

  // 名字旁的徽标：纯文字、跟在名字后，与模型列表一致。
  // 运行状态不在这里重复——卡片底部已有状态胶囊。
  // MTP：config 的 args 里带 --mtp（安装事实）= 这个模型装了自带的 MTP 草稿头。
  // --spec 是 MTP 验证窗口，写 0 = 权重装上了但投机解码关着，徽标要说清「当前没启用」。
  const mtpDisabled = entry.mtp && entry.spec === "0";
  const mtpTitle = entry.mtp
    ? mtpDisabled
      ? "模型自带 MTP 草稿头（config 已装 --mtp 权重），但 MTP 验证窗口 --spec=0，当前未启用投机解码"
      : `模型自带 MTP 草稿头（config 已装 --mtp 权重），MTP 验证窗口 --spec=${entry.spec ?? "未设（引擎默认）"}`
    : undefined;
  const hasBadges = entry.vision || entry.mtp || !entry.engine_exists || !!entry.kv_resident || !!launchPreset;
  // launch 预设（用户 m02055）：启动时不直接用 install 那份 config，而是先按预设
  // 重新生成 `launch\<file>.json` —— 端口、context、kv、视觉、卡、extra 环境变量都按预设。
  const launchTitle = launchPreset
    ? `启动前会按 launch 预设「${launchPreset.name}」重新生成 launch\\${launchPreset.file}.json：` +
      `端口 ${launchPreset.port}、context ${launchPreset.context ?? "默认"}、kv ${launchPreset.kv ?? "默认"}` +
      `${launchPreset.vision ? `、视觉 ${launchPreset.vision}` : ""}，与 strata launch 起出来的一致`
    : undefined;
  const badges = (
    <span className="mc-badges">
      {launchPreset && <span title={launchTitle}>launch 预设</span>}
      {entry.vision && <span>视觉</span>}
      {entry.mtp && (
        <span title={mtpTitle} className={mtpDisabled ? "mc-badge-muted" : undefined}>
          {mtpDisabled ? "MTP 关" : "MTP"}
        </span>
      )}
      {!entry.engine_exists && <span>引擎缺失</span>}
      {entry.kv_resident ? <span>KV 池</span> : null}
    </span>
  );

  const nameEl = (
    <div className="model-name" title={`${name}\n${file}`}>
      {name}
      {hasBadges && badges}
    </div>
  );

  const metaEl = (
    <div className="model-meta">
      <span>
        <i className="fas fa-layer-group" /> {entry.architecture ?? "未知"}
      </span>
      {entry.quantization && (
        <span>
          <i className="fas fa-microchip" /> {entry.quantization}
        </span>
      )}
      <span title={entry.model_path ?? undefined}>
        <i className="fas fa-hdd" /> {fmtSize(entry.model_size_bytes)}
      </span>
      {/* 0 = 还没分配端口（自动分配从 9091 起，启动或刷新时补上），此时不显示这一项 */}
      {(entry.port ?? 0) > 0 && (
        <span title={`端口 ${entry.port}（run 脚本与 config 一致）`}>
          <i className="fas fa-network-wired" /> {entry.port}
        </span>
      )}
    </div>
  );

  const details = (
    <div className="model-details">
      {nameEl}
      {metaEl}
    </div>
  );

  // 状态胶囊四态（用户 m03855 / m04854）：运行中 / 停止中 / 加载中 / 已停止。
  // 「停止」= 卸模型 + 收掉 GUI 起的引擎（与 llama.cpp 侧一致，用户 m00373）；
  // 外部实例仍在跑、只是模型卸了，也照样显示「已停止」—— 卡片管的是模型。
  const busyState = isStopping || isLoading;
  const badge = (
    <div
      className={`model-status-badge ${
        isRunning ? "status-loaded" : busyState ? "status-loading" : "status-stopped"
      }`}
    >
      <i className={`fas ${isRunning ? "fa-check-circle" : busyState ? "fa-spinner fa-spin" : "fa-stop-circle"}`} />
      {isRunning ? "运行中" : isStopping ? "停止中" : isLoading ? "加载中" : "已停止"}
    </div>
  );

  const actions = (
    <div className="model-actions">
      <button
        type="button"
        className={`btn-icon soft ${isRunning ? "is-running" : ""}`}
        disabled={busy || isLoading || isStopping}
        title={
          isStopping
            ? "正在停止这个模型（卸载后引擎一并退出，显存随后释放）"
            : isLoading
              ? "模型正在加载（引擎已起，权重还没就绪）"
              : isRunning
                ? "停止这个模型（卸载后引擎一并退出，显存释放）"
                : mutex
                  ? "加载这个模型（显存互斥已开：会先卸载 llama.cpp 侧已加载的模型）"
                  : engineHere
                    ? "加载这个模型"
                    : runningElsewhere
                      ? `启动并加载这个模型（Strata 互斥：会先停止正在运行的 ${runningElsewhere}）`
                      : "启动引擎并加载这个模型"
        }
        onClick={onToggle}
      >
        <i className={`fas ${isRunning ? "fa-stop" : "fa-play"}`} />
      </button>
      {isRunning ? (
        <button
          type="button"
          className="btn-icon"
          title={`在浏览器里打开「${name}」的 WebUI（这个模型的引擎端口 :${entry.port}）`}
          onClick={onWebui}
        >
          <i className="fas fa-external-link-alt" />
        </button>
      ) : null}
      <button type="button" className="btn-icon" title="参数配置" onClick={onConfigure}>
        <i className="fas fa-sliders" />
      </button>
      <button
        type="button"
        className="btn-icon"
        disabled={busy}
        title="参数调优：用官方 strata tune 反复实测吞吐，把最快的那组参数直接写进 config（记录留在 Strata 目录的 tune-records 下，重启模型生效）"
        onClick={onTune}
      >
        <i className="fas fa-wand-magic-sparkles" />
      </button>
    </div>
  );

  if (grid) {
    return (
      <div className="model-item">
        {fav}
        <div className="model-card-top">
          {iconBox}
          {nameEl}
        </div>
        {metaEl}
        <div className="model-card-bottom">
          {badge}
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className="model-item">
      {fav}
      {iconBox}
      {details}
      {badge}
      {actions}
    </div>
  );
}

/** 参数配置 Sheet：双栏 + 写回 config 的 args（对应模型列表的 ConfigSheet） */
function StrataConfigSheet({
  entry,
  onClose,
  launchPreset,
}: {
  entry: StrataModelEntry;
  onClose: () => void;
  /** 这份模型的 launch 预设：启动会按它生成 `launch\<file>.json`（端口/context/kv/视觉会被覆盖） */
  launchPreset?: StrataLaunchPreset | null;
}) {
  const busy = useApp((s) => s.busy);
  const status = useApp((s) => s.strataStatus);
  const startStrata = useApp((s) => s.startStrata);
  const stopStrata = useApp((s) => s.stopStrata);
  const writeStrataConfig = useApp((s) => s.writeStrataConfig);
  /** 真实引擎可执行文件（用户 m02686：config 落盘直接写它，不留 `component:` 引用）。
   *  后端解析成功时 `engine` 才是绝对路径，解析失败会原样保留引用字符串。 */
  const engineExe =
    entry.engine_exists && entry.engine && !entry.engine.startsWith("component:")
      ? entry.engine
      : null;

  const file = fileOf(entry);
  const running = !!status.running && !!status.config_path && basename(status.config_path) === file;

  const [formConfig, setFormConfig] = useState<Record<string, unknown> | null>(null);
  const [formState, setFormState] = useState<Record<string, ParamState>>({});
  /** 读进 config 那一刻的表单快照，关闭前询问用（见 M18：改了几十个参数误触就全丢） */
  const initialFormRef = useRef("");
  const [formError, setFormError] = useState("");
  const [mobileTab, setMobileTab] = useState<"basic" | "detail">("basic");
  /** 左栏 config 原文（用户 m01644）：右栏改参数时按 stateToConfig 重算回写；也可以直接编辑，
   *  解析成功就重置右栏表单，解析失败只提示、不动表单。 */
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState("");


  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const scrollTimers = useRef<Record<string, number>>({});

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (leftRef.current) leftRef.current.scrollTop = loadScrollTop(scrollKey(file, "basic"));
      if (rightRef.current) rightRef.current.scrollTop = loadScrollTop(scrollKey(file, "detail"));
    });
    return () => cancelAnimationFrame(frame);
  }, [file]);

  const rememberScroll = (pane: "basic" | "detail") => {
    const el = pane === "basic" ? leftRef.current : rightRef.current;
    if (!el) return;
    const key = scrollKey(file, pane);
    const top = el.scrollTop;
    window.clearTimeout(scrollTimers.current[key]);
    scrollTimers.current[key] = window.setTimeout(() => saveScrollTop(key, top), 200);
  };

  useEffect(() => {
    const timers = scrollTimers.current;
    return () => {
      for (const key of Object.keys(timers)) window.clearTimeout(timers[key]);
    };
  }, []);

  // 打开时读一次 config 原文；之后不回灌，避免用户正在编辑的内容被静默重置
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const text = await ipc.strataConfigRead(file);
        if (cancelled) return;
        const obj = JSON.parse(text) as Record<string, unknown>;
        setFormConfig(obj);
        const nextState = configToState(obj);
        setFormState(nextState);
        // 读进来的这一刻就是"打开时"的内容，作为关闭前询问的基线
        initialFormRef.current = JSON.stringify(nextState);
        setRawText(JSON.stringify(obj, null, 1));
        setRawError("");
        setFormError("");
      } catch (e) {
        if (!cancelled) setFormError(`${file} 读取或解析失败：${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const save = async (): Promise<boolean> => {
    if (!formConfig) return false;
    // 左栏原文还在语法错误状态时，右栏表单是上一次解析成功的内容 —— 直接写回会覆盖用户刚打的文本，
    // 看起来像「改了没生效」，所以先拦住（用户 m01644）
    if (rawError) {
      setFormError(`config 原文有语法错误，修正后再写回：${rawError}`);
      return false;
    }
    // 勾选「多模态（视觉）」= args 带 --vision，上游会起 strata-vision 编码器；
    // 上游把 vision.exe / vision.mmproj / vision.model 三键都当必需键，缺一个就是写一份起不来的配置
    if (formState["vision"]?.enabled) {
      const prevVision =
        formConfig.vision && typeof formConfig.vision === "object"
          ? (formConfig.vision as Record<string, unknown>)
          : undefined;
      const mmproj =
        (formState["vision-mmproj"]?.value || "").trim() ||
        (prevVision?.mmproj ? String(prevVision.mmproj) : "");
      if (!mmproj) {
        setFormError("已勾选「多模态（视觉）」，必须选择多模态模型（vision.mmproj）文件");
        return false;
      }
    }
    // 采样默认值写的是 config 顶层 sampling 块，上游对坏值直接拒绝启动（server.py），
    // 所以在写盘前先拦一次（清空不算错：那等于删掉该键、回引擎默认）
    const samplingError = validateStrataSampling(formState);
    if (samplingError) {
      setFormError(samplingError);
      return false;
    }
    // 并发参数的依赖校验也要在写盘前再过一遍：左栏可以直接改 config 原文，
    // 绕过右栏的勾选拦截（用户 m03848「不满足开启要求要拒绝开启并提示」）
    const args = Array.isArray(formConfig.args) ? formConfig.args : [];
    const paramError = validateStrataParams(formState, args);
    if (paramError) {
      setFormError(paramError);
      return false;
    }
    // args 只改参数表认识的 flag（顺序不变、未收录的原样保留）；
    // 顶层只写 vision.mmproj / vision.model / vision.exe / vision.gpu / vision.max_tokens / open_browser
    // 以及 sampling.{temperature,top_p,top_k,min_p}，其余顶层键不动（R6）
    const next = stateToConfig(formConfig, formState, engineExe);
    const ok = await writeStrataConfig(file, JSON.stringify(next, null, 1));
    setFormError(ok ? "" : "写回 config 失败，见右上角错误");
    // 写盘成功就把基线挪到当前表单，否则之后点「取消」还要被问一次
    if (ok) {
      initialFormRef.current = JSON.stringify(formState);
      setRawText(JSON.stringify(next, null, 1));
      setRawError("");
    }
    return ok;
  };

  /** 右栏改参数 → 左栏原文跟着重算（用户 m01644）。formConfig 里表单不认识的键在 stateToConfig
   *  里原样保留，所以这样生成的原文与「写回 config」将要写的内容一致。 */
  const onFormChange = (next: Record<string, ParamState>) => {
    setFormState(next);
    if (!formConfig) return;
    setRawText(JSON.stringify(stateToConfig(formConfig, next, engineExe), null, 1));
    setRawError("");
  };

  /** 直接编辑原文 → 解析成功就重置右栏表单（右栏随即反映手改的参数）；解析失败只提示，不动表单 */
  const onRawChange = (text: string) => {
    setRawText(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setRawError(`JSON 解析失败：${String(e)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setRawError("config 原文必须是一个 JSON 对象");
      return;
    }
    setRawError("");
    const obj = parsed as Record<string, unknown>;
    setFormConfig(obj);
    setFormState(configToState(obj));
  };


  const left = (
    <div className="strata-raw-pane">
      <label className="form-label" htmlFor="strataRawConfig">
        config 原文（{file}）
      </label>
      <textarea
        id="strataRawConfig"
        className="form-control mono strata-raw"
        spellCheck={false}
        value={rawText}
        onChange={(e) => onRawChange(e.target.value)}
      />
      {rawError ? (
        <small className="form-text text-danger">{rawError}</small>
      ) : (
        <small className="form-text">
          右栏改参数时这里会跟着变；也可以直接改这里，解析成功后右栏跟着变（改动要点「写回 config」才落盘）。
        </small>
      )}
    </div>
  );

  const right = (
    <div>
<ParamForm
        state={formState}
        onChange={onFormChange}
        schema={strataParamSchema}
        persistKey={`strataParams:${file}`}
        onBeforeToggle={(key, state) =>
          checkStrataParamEnable(key, state, Array.isArray(formConfig?.args) ? formConfig.args : [])
        }
      />
    </div>
  );

  return (
    <Modal
      domId="loadModelModal"
      title={`配置 · ${nameOf(entry)}`}
      icon={getModelIcon(nameOf(entry), file) ?? undefined}
      onClose={onClose}
      confirmClose={() =>
        JSON.stringify(formState) === initialFormRef.current ||
        confirm("参数有未保存的修改，确定关闭吗？")
      }
      bodyClass="load-model-modal"
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-uniform" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-uniform"
            disabled={busy || !formConfig}
            onClick={() => void save()}
          >
            <i className="fas fa-save" /> 写回 config
          </button>
          {running ? (
            <button
              type="button"
              className="btn btn-primary btn-uniform"
              disabled={busy}
              title="参数写回后需要重启才生效"
              onClick={() => void stopStrata()}
            >
              <i className="fas fa-stop" /> 停止 Strata
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-uniform"
              disabled={busy || !formConfig}
              title="会先写回 config，再启动这个 config"
              onClick={async () => {
                const ok = await save();
                if (ok) await startStrata(file);
              }}
            >
              <i className="fas fa-play" /> 写回并启动
            </button>
          )}
        </>
      }
    >
      <form
        id="loadModelForm"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {formError && (
          <div className="form-group text-danger">
            {formError}
          </div>
        )}
        {launchPreset && (
          <div className="notice">
            <i className="fas fa-rocket" />
            <div>
              <div>
                <strong>启动按 launch 预设「{launchPreset.name}」生成配置</strong>
              </div>
              <div>
                启动前会用官方 <code>strata launch</code> 的同一套逻辑重新生成
                <code> launch\{launchPreset.file}.json</code> 再起引擎：端口 {launchPreset.port}
                （本页改的端口会被它覆盖）、context {launchPreset.context ?? "默认"}、kv{" "}
                {launchPreset.kv ?? "默认"}
                {launchPreset.vision ? `、视觉 ${launchPreset.vision}` : ""}；模型与引擎参数沿用这份
                config。
              </div>
            </div>
          </div>
        )}
        <div className="load-model-layout" data-mobile-tab={mobileTab}>
          <div className="load-model-mobile-tabs">
            <button
              type="button"
              className={`load-model-mobile-tab ${mobileTab === "basic" ? "active" : ""}`}
              onClick={() => setMobileTab("basic")}
            >
              <i className="fas fa-sliders-h" /> config 原文
            </button>
            <button
              type="button"
              className={`load-model-mobile-tab ${mobileTab === "detail" ? "active" : ""}`}
              onClick={() => setMobileTab("detail")}
            >
              <i className="fas fa-list" /> 参数表单
            </button>
          </div>
          <div id="basicParamsContainer" ref={leftRef} onScroll={() => rememberScroll("basic")}>
            {left}
          </div>
          <div
            className="right-param-area"
            id="dynamicParamsContainer"
            ref={rightRef}
            onScroll={() => rememberScroll("detail")}
          >
            {right}
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** 详情 Sheet：运行状态 + config 原文（**只读**，用户 m01689；要改参数走「配置」弹层） */
/**
 * 「参数调优」Sheet（用户 m01357）。
 *
 * 跑的是官方 `strata tune auto`：它自己起引擎、逐组改参数实测吞吐，把赢的那组写进
 * **预设**（`%APPDATA%\Strata\presets\*.json`），不改 config；下次启动时由
 * `serve\server.py` 的 `apply_saved_tuning` 叠加生效（在这里点「启动」也一样）。
 */
function StrataTuneSheet({ entry, onClose }: { entry: StrataModelEntry; onClose: () => void }) {
  const [mode, setMode] = useState("quick");
  const [snap, setSnap] = useState<StrataTuneSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 用户自己点了「停止」：硬杀后子进程退出码非 0，界面要说「已停止」而不是「失败」
  const [stopped, setStopped] = useState(false);
  /** 上一次调优写进 config 的记录（用户 m01543：调优完自动落盘，打开面板能回看） */
  const [record, setRecord] = useState<StrataTuneApplyRecord | null>(null);
  const [applying, setApplying] = useState(false);
  const appliedRef = useRef(false);
  const wasRunning = useRef(false);
  const file = fileOf(entry);

  // 打开面板时读上次的记录（没有就显示「还没写过」）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await ipc.strataTuneHistory(file);
        if (alive) setRecord(next);
      } catch {
        /* 没有记录 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [file]);

  // 每 1.5 秒读一次进度。后端在「没有任务」时返回 Err —— 忽略，当作未开始。
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      let next: StrataTuneSnapshot;
      try {
        next = await ipc.strataTuneStatus(file);
      } catch {
        return; /* 没有正在进行的调优 */
      }
      if (!alive) return;
      setSnap(next);
      if (next.running) {
        wasRunning.current = true;
        return;
      }
      // 刚跑完：自动把这次调优生效的参数写进 config，并把记录留在 tune-records 下。
      if (!wasRunning.current || appliedRef.current || next.state !== "done") return;
      appliedRef.current = true;
      setApplying(true);
      try {
        const applied = await ipc.strataTuneApply(file);
        if (alive) setRecord(applied);
      } catch (err) {
        if (alive) setError(String(err));
      } finally {
        if (alive) setApplying(false);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [file]);

  const running = snap?.running ?? false;

  const start = async () => {
    setBusy(true);
    setError(null);
    setStopped(false);
    appliedRef.current = false;
    wasRunning.current = false;
    try {
      await ipc.strataTuneStart(file, mode);
      setSnap(await ipc.strataTuneStatus(file));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    try {
      await ipc.strataTuneStop(file);
      setStopped(true);
    } catch (e) {
      setError(String(e));
    }
  };

  // 结果只在结束后有：outcome = improved / default_confirmed / cancelled
  const result = snap?.result ?? null;
  const outcome = typeof result?.["outcome"] === "string" ? (result["outcome"] as string) : null;
  const gain = typeof result?.["gain_pct"] === "number" ? (result["gain_pct"] as number) : null;
  const preset = (result?.["preset"] ?? null) as { name?: string } | null;
  const message = typeof result?.["message"] === "string" ? (result["message"] as string) : null;

  return (
    <Modal
      domId="strata-tune-modal"
      title={`参数调优 · ${nameOf(entry)}`}
      iconClass="fas fa-wand-magic-sparkles"
      onClose={onClose}
      bodyClass="strata-tune"
      footer={
        <>
          {running ? (
            <button type="button" className="btn btn-secondary btn-uniform" onClick={() => void stop()}>
              <i className="fas fa-stop" /> 停止调优
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-uniform"
              disabled={busy}
              onClick={() => void start()}
            >
              <i className={`fas ${busy ? "fa-spinner fa-spin" : "fa-play"}`} /> 开始调优
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-uniform" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label">调优方式</label>
        <select
          className="form-control"
          value={mode}
          disabled={running || busy}
          onChange={(e) => setMode(e.currentTarget.value)}
        >
          <option value="quick">快速：约 20 分钟，只试几组常用参数</option>
          <option value="thorough">彻底：最长约 2 小时，穷举更多组合（本机 IQ3 那次跑了约 80 分钟）</option>
        </select>
        <small className="form-text">
          调优要独占显存（反复起引擎加载模型）：Strata 正在运行时会被拦下，得先停止。
          跑完会把这次生效的参数直接写进 config（新增 / 删除了哪些记在 Strata 目录的
          <code>tune-records</code> 下），重启这个模型后生效。
        </small>
      </div>

      {error && <div className="form-group text-danger">{error}</div>}

      <div className="form-group">
        <label className="form-label">进度</label>
        {running ? (
          <div className="form-text">
            <i className="fas fa-spinner fa-spin" /> {snap?.message || snap?.text || "运行中"}
            {snap?.stage ? `（${snap.stage}）` : ""}
            {snap?.minutes_left != null ? `，预计还剩约 ${snap.minutes_left} 分钟` : ""}
          </div>
        ) : snap ? (
          <div className="form-text">
            {stopped ? (
              <>已停止（没有写预设）。</>
            ) : snap.state === "exited" || (snap.exit_code != null && snap.exit_code !== 0) ? (
              <>
                失败（退出码 {snap.exit_code ?? "?"}）
                {snap.log_tail.length > 0 ? `：${snap.log_tail[snap.log_tail.length - 1]}` : ""}
              </>
            ) : outcome === "improved" ? (
              <>
                完成：比默认快 <b>{gain != null ? `${gain.toFixed(1)}%` : "若干"}</b>
                {preset?.name ? `，已存为预设「${preset.name}」` : ""}。重启这个模型后生效。
              </>
            ) : outcome === "default_confirmed" ? (
              <>完成：默认参数已经是最快，没有改动。</>
            ) : outcome === "cancelled" ? (
              <>已取消（没有写预设）。</>
            ) : (
              <>完成：{message ?? "结果见 Strata 日志"}</>
            )}
          </div>
        ) : (
          <div className="form-text">还没开始。</div>
        )}
      </div>

      {(applying || record) && (
        <div className="form-group">
          <label className="form-label">写入 config 的记录</label>
          {applying ? (
            <div className="form-text">
              <i className="fas fa-spinner fa-spin" /> 正在把这次调优生效的参数写进 config…
            </div>
          ) : (
            record && (
              <>
                <div className="form-text">
                  {record.message}
                  {record.preset ? `（预设「${record.preset}」）` : ""}
                  {record.atMs > 0 ? ` · ${new Date(record.atMs).toLocaleString("zh-CN")}` : ""}
                </div>
                {(record.added.length > 0 || record.removed.length > 0) && (
                  <ul className="form-text">
                    {record.added.map((item) => (
                      <li key={`add-${item}`}>
                        新增 <code>{item}</code>
                      </li>
                    ))}
                    {record.removed.map((item) => (
                      <li key={`del-${item}`}>
                        删除 <code>{item}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * 只画卡片区（用户 m03160 第 1 点）：外层 `.main-area`、标题、工具行（搜索 / 刷新 / 排序 /
 * 筛选 / 视图切换）都由 ModelListPanel 提供，两档共用同一条工具行 —— 这里不再自带第二行。
 * 代理与「刷新运行状态」两个按钮也按同一条要求去掉：前门在侧栏胶囊里管，
 * 运行状态在每次启动/停止后都会自动探测。
 */
export function StrataPanel({
  tools,
}: {
  tools: {
    query: string;
    filter: Filter;
    sortKey: SortKey;
    pinned: Pinned;
    grid: boolean;
  };
}) {
  const settings = useApp((s) => s.settings);
  const entries = useApp((s) => s.strataEntries);
  const status = useApp((s) => s.strataStatus);
  const starting = useApp((s) => s.strataStarting);
  const stopping = useApp((s) => s.strataStopping);
  const busy = useApp((s) => s.busy);
  const refreshStrata = useApp((s) => s.refreshStrata);
  const toggleFavourite = useApp((s) => s.toggleFavourite);
  const startStrataModel = useApp((s) => s.startStrataModel);
  const stopStrataModel = useApp((s) => s.stopStrataModel);

  // 工具行的值由模型列表页统一持有（用户 m03160 第 1 点）：搜索词、置顶、视图是两档共用的，
  // 筛选与排序按通道换值域，所以那边各存一份。
  const { query, filter, sortKey, pinned, grid } = tools;
  const [configFile, setConfigFile] = useState<string | null>(null);

  // 参数调优的 Sheet：存的是 config 文件名（与 configFile 同一套键）
  const [tuneFile, setTuneFile] = useState<string | null>(null);

  // launch 预设（用户 m02055）：`%APPDATA%\Strata\launch-presets\*.json` 里按 model_path 认领。
  // 有预设的模型，启动时后端会先按预设重新生成 `launch\<file>.json` 再用它起 serve。
  const [launchPresets, setLaunchPresets] = useState<StrataLaunchPreset[]>([]);
  useEffect(() => {
    let alive = true;
    void ipc
      .strataLaunchPresets()
      .then((list) => {
        if (alive) setLaunchPresets(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // 预设是按模型目录匹配的：只盯条数，遇到「换了模型文件、条数没变」就不会刷新（审查发现）
  }, [entries.map((entry) => entry.model_path ?? "").join("|")]);
  const presetOf = (entry: StrataModelEntry): StrataLaunchPreset | null => {
    const folder = normFolder(entry.model_path ?? "");
    if (!folder) return null;
    return launchPresets.find((preset) => normFolder(preset.model_path) === folder) ?? null;
  };

  // 「在跑的是哪份 config」：优先按 config_path 认（GUI 槽位与探测都能给出），拿不到时
  // 退回按 `/health` 报的模型名认。引擎从启动到端口监听之间探测不到，单看 `running`
  // 会让卡片在这段空窗里一直显示「已停止」（用户 m01031：模型加载了卡片却没反应）。
  const runningEntry = useMemo(() => {
    const path = status.config_path;
    if (path) {
      const byPath = entries.find((e) => fileOf(e) === basename(path));
      if (byPath) return byPath;
    }
    const name = status.model_name;
    return name ? (entries.find((e) => e.model_name === name) ?? null) : null;
  }, [entries, status.config_path, status.model_name]);
  const runningFile = runningEntry ? fileOf(runningEntry) : null;

  // 收藏（用户 m03333 第 8 点）：和模型列表共用同一份 settings.favourites，键是 config 文件名。
  // 以前这里的星标是「默认 config」（点侧栏胶囊启动哪个），现在 GUI 启动 Strata 模型
  // 不需要先挑默认，星标只当收藏用。
  const favourites = settings?.favourites ?? [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((e) => {
      if (q && !`${nameOf(e)} ${fileOf(e)}`.toLowerCase().includes(q)) return false;
      if (filter === "running") return runningFile === fileOf(e);
      if (filter === "favourite") return favourites.includes(fileOf(e));
      return true;
    });
    // 排序选项与 llama.cpp 那档共用（用户 m03482 第 5 点）：名称/大小。
    // 大小取 config 的 `model_size_bytes`（分片已聚合），取不到按 -1 排到最后。
    const sizeOf = (e: { model_size_bytes: number | null }) => e.model_size_bytes ?? -1;
    const sorted = [...list].sort((a, b) => {
      switch (sortKey) {
        case "name_desc":
          return nameOf(b).localeCompare(nameOf(a));
        case "size_desc":
          return sizeOf(b) - sizeOf(a);
        case "size_asc":
          return sizeOf(a) - sizeOf(b);
        default:
          return nameOf(a).localeCompare(nameOf(b));
      }
    });
    // 置顶是叠在排序上的开关（Array.sort 稳定，运行中的排到最前）
    if (pinned === "active") {
      return [...sorted].sort(
        (a, b) => Number(runningFile === fileOf(b)) - Number(runningFile === fileOf(a)),
      );
    }
    return sorted;
  }, [entries, query, filter, sortKey, pinned, runningFile, favourites]);

  const toggleOne = useCallback(
    (file: string) => {
      // 卡片管模型（用户 m03572）：引擎正在跑这份 config **且模型还加载着** → 停止；否则加载。
      // 判据必须带上 `loaded`（用户 m03241）：`/unload` 与进程退出之间有一段窗口
      // （`running=true`、`config_path` 还是这份），只看 runningFile 会把「再点启动」当成又停止一次，
      // 于是卡片永远停在「已停止」。探测不明（`loaded === null`）时仍按停止走，
      // 那是 m04917 的场景（加载中点了停止，探测没跟上）。
      if (runningFile === file && status.loaded !== false) {
        void stopStrataModel(file);
        return;
      }
      void startStrataModel(file);
    },
    [runningFile, status.loaded, startStrataModel, stopStrataModel],
  );


  const configEntry = entries.find((e) => fileOf(e) === configFile) ?? null;

  const tuneEntry = entries.find((e) => fileOf(e) === tuneFile) ?? null;

  /**
   * WebUI 按钮：引擎没在跑时不显示（用户 m01795 要求取消常显）。
   *
   * WebUI 是**引擎进程自己**在它的端口上提供的页面，所以打开的是**这张卡片自己的**
   * `entry.port`，不能用「当前在跑引擎的端口」：后者在代理背后切换引擎时会开成
   * **另一个模型**的页面（用户 m02028「About 里的模型不对」就是这么来的）。
   * 审查发现这里曾写成 `status.port || entry.port`，与下面卡片处的注释正好相反。
   */
  const openWebui = useCallback(
    (entry: StrataModelEntry) => {
      void ipc.openLocalUrl(`http://127.0.0.1:${entry.port}/`);
    },
    [],
  );

  return (
    <>
      <div className="content-scrollable">
        <div className="model-list-container">
          <div id="modelsList" className={grid ? "grid-view" : undefined}>
            {entries.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-brain" />
                </div>
                <div className="empty-state-title">没有找到 Strata 模型</div>
                <div className="empty-state-text">
                  {settings?.strata_root
                    ? `${settings.strata_root} 下没有 strata-*.json。用 Strata 官方脚本装好模型后回到本页点刷新。`
                    : "还没指定 Strata 目录 —— 到「设置 → 通用 → Strata 目录」填上 Strata 的安装位置（没有默认路径），再回本页点刷新。"}
                </div>
              </div>
            ) : shown.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-filter" />
                </div>
                <div className="empty-state-text">没有匹配的 config</div>
              </div>
            ) : (
              shown.map((e) => (
                <ConfigCard
                  key={e.config_path}
                  entry={e}
                  isFavourite={favourites.includes(fileOf(e))}
                  isRunning={runningFile === fileOf(e) && !!status.loaded}
                  engineHere={runningFile === fileOf(e) && !status.loaded}
                  runningElsewhere={
                    runningFile && runningFile !== fileOf(e) ? status.model_name || runningFile : null
                  }
                  // 「加载中」只看两件事：用户在本页点了启动（`strataStarting`，纯前端状态）、
                  // 或**前门**正拿着 DSH 的请求在起引擎/加载模型（`proxy_serving` 且尚未
                  // `loaded`，用户 m01266 第 2 点）。
                  // 曾经还有第三条「引擎槽里记着这个 config 但探测不到」（用户 m01031）：切模型
                  // 与停止引擎时槽里的 `config_path` 还在、探测又刚好失败，被卸下来的那张卡就会
                  // 一直说「加载中」（用户 m05033 第 3 点），所以整条删掉 —— 启动过程本来就由
                  // `strataStarting` 覆盖。
                  isLoading={
                    starting === fileOf(e) ||
                    (status.proxy_serving === fileOf(e) && !status.loaded)
                  }
                  // 停止中（用户 m04854）：这段时间胶囊要说「停止中」，不能说「加载中」
                  isStopping={stopping === fileOf(e)}
                  mutex={!!settings?.strata_router_mutex}
                  grid={grid}
                  busy={busy}
                  onToggleFavourite={() => void toggleFavourite(fileOf(e))}
                  onToggle={() => toggleOne(fileOf(e))}
                  // WebUI 是**引擎进程自己**在它的端口上提供的页面，所以这里必须用**这张卡片自己的**
                  // `entry.port`，不能用「当前在跑引擎的端口」：前者保证打开的就是这张卡片的模型，
                  // 后者在代理背后切换引擎时会开成**另一个模型**的页面（用户 m02028「About 里的
                  // 模型不对」就是这么来的：那次开出来的是当时在跑的 sc117 的页面）。
                  onWebui={() => void openWebui(e)}
                  onTune={() => {
                    setConfigFile(null);
                    setTuneFile(fileOf(e));
                  }}
                  onConfigure={() => {
                    setConfigFile(fileOf(e));
                  }}
                  launchPreset={presetOf(e)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {configEntry && (
        <StrataConfigSheet
          entry={configEntry}
          launchPreset={presetOf(configEntry)}
          onClose={() => {
            setConfigFile(null);
            void refreshStrata();
          }}
        />
      )}
      {tuneEntry && (
        <StrataTuneSheet
          entry={tuneEntry}
          onClose={() => {
            setTuneFile(null);
            // 调优只写预设，不碰 config；刷新一次是为了让卡片上的「已装预设」类提示（若有）跟上
            void refreshStrata();
          }}
        />
      )}
    </>
  );
}
