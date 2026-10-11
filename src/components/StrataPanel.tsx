/**
 * Strata 页（第二运行时通道）。布局照搬模型列表页（界面改造 m01301 需求 4/5）：
 * 顶栏（搜索 / 刷新 / 排序 / 筛选 / 视图切换）+ 卡片列表 + 底部 Sheet。
 *
 * 与模型列表页的对应关系：preset 段 ↔ `strata-*.json`，「配置」按钮打开的 Sheet
 * 写回的是 config 的 `args`（不是 presets.ini）。
 *
 * 解耦规则（STRATA_INTEGRATION_PLAN.md §7 R1-R10）：
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
import type { StrataModelEntry } from "../types";
import { ParamForm } from "./ParamForm";
import type { ParamState } from "../utils/paramSchema";
import {
  configToState,
  installFactFlags,
  isFlagToken,
  stateToConfig,
  strataParamSchema,
  STRATA_INSTALL_FACT_FLAGS,
  validateStrataSampling,
} from "../utils/strataParams";
import { fmtSize } from "../utils/models";
import { getModelIcon } from "../utils/modelIcon";
import { Modal } from "./Sheet";

type SortKey = "name_asc" | "name_desc" | "ctx_desc" | "ctx_asc";
type Filter = "all" | "running" | "selected" | "missing";
type Pinned = "none" | "active";

const SORT_LABELS: Record<SortKey, string> = {
  name_asc: "名称 ↑",
  name_desc: "名称 ↓",
  ctx_desc: "上下文 ↓",
  ctx_asc: "上下文 ↑",
};

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

/** 只读信息卡 */
function InfoCard({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="info-card">
      <div className="info-card-label">{label}</div>
      <div className={`info-card-value ${mono ? "mono" : ""}`}>{value}</div>
    </div>
  );
}

/** 排序下拉（与模型列表页同一套：上半互斥排序，横杠下是可叠加的置顶开关） */
function SortMenu({
  sortKey,
  pinned,
  onSort,
  onPin,
}: {
  sortKey: SortKey;
  pinned: Pinned;
  onSort: (key: SortKey) => void;
  onPin: (next: Pinned) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={wrap}>
      <button
        type="button"
        className={`btn btn-secondary ${open ? "active" : ""}`}
        style={{ flexShrink: 0, whiteSpace: "nowrap" }}
        title="排序方式"
        onClick={() => setOpen((v) => !v)}
      >
        <i className="fas fa-arrow-down-wide-short" />
        <span>{SORT_LABELS[sortKey]}</span>
        <i className={`fas fa-chevron-${open ? "up" : "down"}`} style={{ marginLeft: 4, fontSize: "0.7rem" }} />
      </button>
      {open && (
        <div className="dropdown-menu">
          {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
            <button
              type="button"
              key={key}
              className="dropdown-item"
              onClick={() => {
                onSort(key);
                setOpen(false);
              }}
            >
              <i className={sortKey === key ? "fas fa-check" : ""} />
              <span>{SORT_LABELS[key]}</span>
            </button>
          ))}
          <div className="dropdown-sep" />
          <button
            type="button"
            className="dropdown-item"
            onClick={() => onPin(pinned === "active" ? "none" : "active")}
          >
            <i className={pinned === "active" ? "fas fa-check" : ""} />
            <span>运行中优先</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 一张 config 卡片（对应模型列表的 ModelCard） */
function ConfigCard({
  entry,
  isSelected,
  isRunning,
  isLoading,
  engineHere,
  runningElsewhere,
  mutex,
  grid,
  busy,
  onPick,
  onToggle,
  onWebui,
  onConfigure,
  onDetail,
}: {
  entry: StrataModelEntry;
  isSelected: boolean;
  isRunning: boolean;
  isLoading: boolean;
  /** 引擎进程在跑这个 config，但模型未加载（胶囊启了引擎、模型还没拉起） */
  engineHere: boolean;
  /** 同端口上正在跑的是**另一个** config 的模型：Strata 互斥，启动时会先停掉它 */
  runningElsewhere: string | null;
  mutex: boolean;
  grid: boolean;
  busy: boolean;
  onPick: () => void;
  onToggle: () => void;
  onWebui: () => void;
  onConfigure: () => void;
  onDetail: () => void;
}) {
  const name = nameOf(entry);
  const file = fileOf(entry);
  // 图标：模型名 / 文件名 / 引擎名都认不出时兜底用 qwen（Strata 的模型基本都是 Qwen 系）
  const icon = getModelIcon(name, file, entry.engine ?? undefined) ?? getModelIcon("qwen") ?? undefined;

  const fav = (
    <button
      type="button"
      className={`model-fav-btn ${isSelected ? "active" : ""}`}
      title={
        isSelected
          ? "默认 config：点侧栏的 Strata 胶囊就会启动它（多个模型只能有一个默认）"
          : "设为默认 config：点侧栏的 Strata 胶囊就会启动这个模型"
      }
      onClick={onPick}
    >
      <i className={isSelected ? "fas fa-star" : "far fa-star"} />
    </button>
  );

  const iconBox = (
    <div className="model-icon-wrapper">
      {icon ? <img src={icon} alt="" /> : <i className="fas fa-brain" />}
    </div>
  );

  // 名字旁的徽标：纯文字、跟在名字后，与模型列表一致。
  // 运行状态不在这里重复——卡片底部已有状态胶囊。
  const hasBadges = entry.vision || !entry.engine_exists || !!entry.kv_resident;
  const badges = (
    <span className="mc-badges">
      {entry.vision && <span>视觉</span>}
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
      {entry.port != null && (
        <span>
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

  // 状态胶囊三态（用户 m03855）：运行中 / 加载中 / 已停止。
  // 引擎在跑但模型已卸载也显示「已停止」—— 卡片管的是模型，不是引擎进程。
  const badge = (
    <div
      className={`model-status-badge ${
        isRunning ? "status-loaded" : isLoading ? "status-loading" : "status-stopped"
      }`}
    >
      <i
        className={`fas ${
          isRunning ? "fa-check-circle" : isLoading ? "fa-spinner fa-spin" : "fa-stop-circle"
        }`}
      />
      {isRunning ? "运行中" : isLoading ? "加载中" : "已停止"}
    </div>
  );

  const actions = (
    <div className="model-actions">
      <button
        type="button"
        className={`btn-icon soft ${isRunning ? "is-running" : ""}`}
        disabled={busy || isLoading}
        title={
          isLoading
            ? "模型正在加载（引擎已起，权重还没就绪）"
            : isRunning
              ? "卸载这个模型（引擎进程留着，显存释放）"
              : mutex
                ? "加载这个模型（显存互斥已开：会先卸载 router 正在运行的模型）"
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
      {isRunning && (
        <button
          type="button"
          className="btn-icon"
          title={`在浏览器里打开「${name}」的 WebUI（这个模型的引擎端口 :${entry.port}）`}
          onClick={onWebui}
        >
          <i className="fas fa-external-link-alt" />
        </button>
      )}
      <button type="button" className="btn-icon" title="参数配置" onClick={onConfigure}>
        <i className="fas fa-sliders" />
      </button>
      <button type="button" className="btn-icon" title="详情 / config 原文" onClick={onDetail}>
        <i className="fas fa-info-circle" />
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
function StrataConfigSheet({ entry, onClose }: { entry: StrataModelEntry; onClose: () => void }) {
  const busy = useApp((s) => s.busy);
  const status = useApp((s) => s.strataStatus);
  const startStrata = useApp((s) => s.startStrata);
  const stopStrata = useApp((s) => s.stopStrata);
  const writeStrataConfig = useApp((s) => s.writeStrataConfig);
  const strataRoot = useApp((s) => s.settings?.strata_root ?? null);

  const file = fileOf(entry);
  const running = !!status.running && !!status.config_path && basename(status.config_path) === file;

  const [formConfig, setFormConfig] = useState<Record<string, unknown> | null>(null);
  const [formState, setFormState] = useState<Record<string, ParamState>>({});
  /** 读进 config 那一刻的表单快照，关闭前询问用（见 M18：改了几十个参数误触就全丢） */
  const initialFormRef = useRef("");
  const [formError, setFormError] = useState("");
  const [mobileTab, setMobileTab] = useState<"basic" | "detail">("basic");

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
    // args 只改参数表认识的 flag（顺序不变、未收录的原样保留）；
    // 顶层只写 vision.mmproj / vision.model / vision.exe / vision.gpu / vision.max_tokens / open_browser
    // 以及 sampling.{temperature,top_p,top_k,min_p}，其余顶层键不动（R6）
    const next = stateToConfig(formConfig, formState, strataRoot);
    const ok = await writeStrataConfig(file, JSON.stringify(next, null, 1));
    setFormError(ok ? "" : "写回 config 失败，见右上角错误");
    // 写盘成功就把基线挪到当前表单，否则之后点「取消」还要被问一次
    if (ok) initialFormRef.current = JSON.stringify(formState);
    return ok;
  };

  const argsArr = Array.isArray(formConfig?.args) ? (formConfig.args as unknown[]).map(String) : [];
  // 安装事实类参数（上游安装器写下的路径），只读展示，写回时原样保留
  const installFacts = installFactFlags(argsArr);

  // args 逐行展开成「flag + 取值」，比原来的一整行 join 更好读
  const argRows: { flag: string; value?: string; fact: boolean }[] = [];
  for (let i = 0; i < argsArr.length; i++) {
    const token = argsArr[i];
    if (!token.startsWith("--")) {
      argRows.push({ flag: token, fact: false });
      continue;
    }
    const next = argsArr[i + 1];
    // 判据与 utils/strataParams.ts 的 isFlagToken 统一（以 `-` 开头就算 flag）。
    // 原来这里写的是 `!next.startsWith("--")`，和右栏表单的判据不同源：
    // 表单已经按「无值」处理了，左栏却仍把下一个 flag 显示成它的取值，看着像 bug。
    const hasValue = next != null && !isFlagToken(next);
    argRows.push({
      flag: token,
      value: hasValue ? next : undefined,
      fact: STRATA_INSTALL_FACT_FLAGS.includes(token.slice(2)),
    });
    if (hasValue) i++;
  }

  const ctxMismatch =
    running && entry.max_context != null && status.live_max_context != null && entry.max_context !== status.live_max_context;

  const left = (
    <div>
      <div className="form-group">
        <label className="form-label">这个 config（只读）</label>
        <div className="grid2">
          <InfoCard
            label="引擎版本"
            value={
              entry.engine_version || (entry.engine_exists ? "未知（缺 BUILD.json）" : "引擎缺失（升级可能中断）")
            }
          />
          <InfoCard label="config 文件" value={file} mono />
          <InfoCard label="run 脚本" value={entry.run_script ? basename(entry.run_script) : "无（用回退命令）"} mono />
        </div>
        {ctxMismatch && (
          <small className="form-text">
            上下文与运行时不一致（config {entry.max_context} / 运行时 {status.live_max_context}）：改了参数要<b>重启</b>才生效。
          </small>
        )}
      </div>

      <div className="form-group">
        <label className="form-label">启动参数现状</label>
        <div className="code-block">
          {argRows.length === 0 && <div>（args 为空）</div>}
          {argRows.map((row, i) => (
            <div
              key={i}
              title={row.fact ? "安装事实类参数：上游安装器写下，GUI 原样保留" : undefined}
              style={{ display: "flex", gap: "10px", opacity: row.fact ? 0.66 : 1 }}
            >
              <span style={{ minWidth: "190px" }}>
                {row.flag}
                {row.fact ? " *" : ""}
              </span>
              <span style={{ wordBreak: "break-all" }}>{row.value ?? ""}</span>
            </div>
          ))}
        </div>
        {installFacts.length > 0 && (
          <small className="form-text">
            带 * 的行是安装事实类参数（{installFacts.map((f) => `--${f}`).join(" ")}），由上游安装器写下，GUI 原样保留。
          </small>
        )}
      </div>
    </div>
  );

  const right = (
    <div>
      <ParamForm
        state={formState}
        onChange={setFormState}
        schema={strataParamSchema}
        persistKey={`strataParams:${file}`}
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
          <div className="form-group" style={{ color: "var(--danger-color)" }}>
            {formError}
          </div>
        )}
        <div className="load-model-layout" data-mobile-tab={mobileTab}>
          <div className="load-model-mobile-tabs">
            <button
              type="button"
              className={`load-model-mobile-tab ${mobileTab === "basic" ? "active" : ""}`}
              onClick={() => setMobileTab("basic")}
            >
              <i className="fas fa-sliders-h" /> 这个 config
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

/** 详情 Sheet：运行状态 + config 原文编辑（对应模型列表的 DetailSheet） */
function StrataDetailSheet({ entry, onClose }: { entry: StrataModelEntry; onClose: () => void }) {
  const busy = useApp((s) => s.busy);
  const status = useApp((s) => s.strataStatus);
  const writeStrataConfig = useApp((s) => s.writeStrataConfig);

  const file = fileOf(entry);
  const running = !!status.running && !!status.config_path && basename(status.config_path) === file;

  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await ipc.strataConfigRead(file);
        if (cancelled) return;
        const pretty = (() => {
          try {
            return JSON.stringify(JSON.parse(raw), null, 1);
          } catch {
            return raw;
          }
        })();
        setText(pretty);
        setOriginal(pretty);
        setError("");
      } catch (e) {
        if (!cancelled) setError(`${file} 读取失败：${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const save = async () => {
    try {
      JSON.parse(text);
    } catch (e) {
      setError(`JSON 语法错误，未写回：${String(e)}`);
      return;
    }
    const ok = await writeStrataConfig(file, text);
    setError(ok ? "" : "写回失败，见右上角错误");
    if (ok) setOriginal(text);
  };

  return (
    <Modal
      domId="loadModelModal"
      title={`详情 · ${nameOf(entry)}`}
      icon={getModelIcon(nameOf(entry), file) ?? undefined}
      onClose={onClose}
      confirmClose={() =>
        !text || text === original || confirm("config 原文有未保存的修改，确定关闭吗？")
      }
      bodyClass="model-detail"
      footer={
        <>
          <button type="button" className="btn btn-secondary btn-uniform" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn btn-primary btn-uniform"
            disabled={busy || !text || text === original}
            onClick={() => void save()}
          >
            <i className="fas fa-save" /> 写回 config
          </button>
        </>
      }
    >
      <div>
        <div className="form-group">
          <label className="form-label">运行状态</label>
          <div className="grid2">
            <InfoCard label="进程" value={running ? `运行中 · pid ${status.pid ?? "?"}` : "已停止"} />
            <InfoCard label="引擎版本" value={running && status.version ? status.version : "未运行（启动后从 /props 读）"} />
            <InfoCard
              label="生效上下文"
              value={running && status.live_max_context != null ? String(status.live_max_context) : "未知"}
            />
            <InfoCard
              label="prompt / 输出上限"
              value={
                running && status.prompt_tokens != null
                  ? `${status.prompt_tokens} / ${status.max_tokens ?? "?"}`
                  : "未知"
              }
            />
          </div>
          {running && status.busy && (
            <small className="form-text">队列忙（单序列 FIFO）：Strata 只有一个 slot，请求排队执行。</small>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">config 原文（{file}）</label>
          {error && (
            <div className="form-group" style={{ color: "var(--danger-color)" }}>
              {error}
            </div>
          )}
          <textarea
            className="form-control mono"
            rows={16}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <small className="form-text">
            原文编辑请谨慎：顶层字段与 <code>args</code> 顺序都会照写。改完点「写回 config」，
            运行中的实例要重启才生效。
          </small>
        </div>
      </div>
    </Modal>
  );
}

export function StrataPanel() {
  const settings = useApp((s) => s.settings);
  const entries = useApp((s) => s.strataEntries);
  const status = useApp((s) => s.strataStatus);
  const starting = useApp((s) => s.strataStarting);
  const busy = useApp((s) => s.busy);
  const refreshStrata = useApp((s) => s.refreshStrata);
  const pickStrata = useApp((s) => s.pickStrata);
  const probeStrata = useApp((s) => s.probeStrata);
  const startStrataModel = useApp((s) => s.startStrataModel);
  const stopStrataModel = useApp((s) => s.stopStrataModel);
  const startStrataProxy = useApp((s) => s.startStrataProxy);
  const stopStrataProxy = useApp((s) => s.stopStrataProxy);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  const [pinned, setPinned] = useState<Pinned>(() =>
    localStorage.getItem("strataPinned") === "none" ? "none" : "active",
  );
  const [grid, setGrid] = useState(() => localStorage.getItem("strataView") !== "list");
  const [configFile, setConfigFile] = useState<string | null>(null);
  const [detailFile, setDetailFile] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("strataView", grid ? "grid" : "list");
  }, [grid]);
  useEffect(() => {
    localStorage.setItem("strataPinned", pinned);
  }, [pinned]);

  const selected = settings?.strata_selected_config ?? null;
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
  // 多份 config 写同一个端口时，它们本来就只能有一个在跑（一个引擎 = 一份 config = 一个
  // 端口，用户 m00001）：底部提示里说清楚，免得用户以为两个模型能同时加载。
  const sharedPort = useMemo(() => {
    const count = new Map<number, number>();
    for (const e of entries) {
      if (e.port) count.set(e.port, (count.get(e.port) ?? 0) + 1);
    }
    return [...count.values()].some((n) => n > 1);
  }, [entries]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = entries.filter((e) => {
      if (q && !`${nameOf(e)} ${fileOf(e)}`.toLowerCase().includes(q)) return false;
      if (filter === "running") return runningFile === fileOf(e);
      if (filter === "selected") return selected === fileOf(e);
      if (filter === "missing") return !e.engine_exists;
      return true;
    });
    const sorted = [...list].sort((a, b) => {
      switch (sortKey) {
        case "name_desc":
          return nameOf(b).localeCompare(nameOf(a));
        case "ctx_desc":
          return (b.max_context ?? 0) - (a.max_context ?? 0);
        case "ctx_asc":
          return (a.max_context ?? 0) - (b.max_context ?? 0);
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
  }, [entries, query, filter, sortKey, pinned, runningFile, selected]);

  const toggleOne = useCallback(
    (file: string) => {
      // 卡片管模型（用户 m03572）：本 config 的模型已加载 → 卸载；否则加载。
      // 引擎进程由侧栏胶囊管，卡片不再停整个进程。
      if (runningFile === file && status.loaded) {
        void stopStrataModel(file);
        return;
      }
      void startStrataModel(file);
    },
    [runningFile, status.loaded, startStrataModel, stopStrataModel],
  );

  const selectedEntry = entries.find((e) => fileOf(e) === selected) ?? null;
  const ctxMismatch =
    status.running &&
    selectedEntry?.max_context != null &&
    status.live_max_context != null &&
    selectedEntry.max_context !== status.live_max_context;

  const configEntry = entries.find((e) => fileOf(e) === configFile) ?? null;
  const detailEntry = entries.find((e) => fileOf(e) === detailFile) ?? null;

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>Strata</span>{" "}
          <span className="model-count-badge">
            {runningFile ? 1 : 0}/{entries.length}
          </span>
        </h1>
        <div className="top-actions">
          <div className="search-box" style={{ flexShrink: 0, width: 220 }}>
            <i className="fas fa-search search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="搜索 config..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flexShrink: 0 }}
            title="重新扫描 strata-*.json（上游升级后点这个）"
            disabled={busy}
            onClick={() => void refreshStrata()}
          >
            <i className={`fas fa-sync-alt ${busy ? "fa-spin" : ""}`} />
          </button>
          <SortMenu sortKey={sortKey} pinned={pinned} onSort={setSortKey} onPin={setPinned} />
          <select
            className="form-control"
            style={{ padding: "4px 8px", width: "auto", fontSize: "0.875rem" }}
            title="筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value as Filter)}
          >
            <option value="all">全部模型</option>
            <option value="running">运行中</option>
            <option value="selected">已选中</option>
            <option value="missing">引擎缺失</option>
          </select>
          <button
            type="button"
            className="btn-icon"
            style={{ width: 36, height: 36, flexShrink: 0 }}
            title="切换卡片 / 列表视图"
            onClick={() => setGrid((v) => !v)}
          >
            <i className={`fas ${grid ? "fa-list" : "fa-th-large"}`} />
          </button>
          {/* 代理（前门）：DSH 等客户端连它，它按请求里的 model 自动切换引擎（用户 m00798 / m01151） */}
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flexShrink: 0 }}
            title={
              status.proxy
                ? `代理正在监听 :${status.proxy_port ?? 9090}（DSH 连这里）· 点击停止`
                : "启动代理（默认 :9090）：一个端口挂全部 config，按请求里的 model 自动切换引擎 —— DSH 连它"
            }
            disabled={busy}
            onClick={() => void (status.proxy ? stopStrataProxy() : startStrataProxy())}
          >
            <i className={`fas ${status.proxy ? "fa-door-open" : "fa-door-closed"}`} />
            <span style={{ marginLeft: "0.35rem" }}>
              {status.proxy ? `代理 :${status.proxy_port ?? 9090}` : "启动代理"}
            </span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flexShrink: 0 }}
            title="刷新运行状态（/health + /props + /status）"
            disabled={busy || !status.running}
            onClick={() => void probeStrata()}
          >
            <i className="fas fa-heart-pulse" />
          </button>
        </div>
      </div>

      <div className="content-scrollable">
        <div className="model-list-container">
          <div id="modelsList" className={grid ? "grid-view" : undefined}>
            {!settings?.strata_root ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-brain" />
                </div>
                <div className="empty-state-title">还没有设置 Strata 目录</div>
                <div className="empty-state-text">
                  到「设置 → 目录」里填 Strata 安装目录（其下含 serve\server.py 与 strata-*.json），保存后回到本页点刷新。
                </div>
              </div>
            ) : entries.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-box-open" />
                </div>
                <div className="empty-state-title">这个目录下没有 strata-*.json</div>
                <div className="empty-state-text">
                  在 Strata 目录跑 <code>python setup.py</code> 装一个模型后，回本页点刷新。
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
                  isSelected={selected === fileOf(e)}
                  isRunning={runningFile === fileOf(e) && !!status.loaded}
                  engineHere={runningFile === fileOf(e) && !status.loaded}
                  runningElsewhere={
                    runningFile && runningFile !== fileOf(e) ? status.model_name || runningFile : null
                  }
                  // 「加载中」有三来路：用户在本页点了启动（`strataStarting`，纯前端状态）、
                  // **前门**正拿着 DSH 的请求在起引擎/加载模型（`proxy_serving` + 尚未
                  // `loaded`，用户 m01266 第 2 点）、或**引擎已起但端口还没应答**（还在
                  // 加载权重，用户 m01031）。最后一种以前什么都不显示，卡片像没反应。
                  isLoading={
                    starting === fileOf(e) ||
                    (status.proxy_serving === fileOf(e) && !status.loaded) ||
                    (runningFile === fileOf(e) && !status.running)
                  }
                  mutex={!!settings?.strata_router_mutex}
                  grid={grid}
                  busy={busy}
                  onPick={() => void pickStrata(fileOf(e))}
                  onToggle={() => toggleOne(fileOf(e))}
                  // WebUI 是**引擎进程自己**在它的端口上提供的页面，所以这里必须用**这张卡片自己的**
                  // `entry.port`，不能用「当前在跑引擎的端口」：前者保证打开的就是这张卡片的模型，
                  // 后者在代理背后切换引擎时会开成**另一个模型**的页面（用户 m02028「About 里的
                  // 模型不对」就是这么来的：那次开出来的是当时在跑的 sc117 的页面）。
                  onWebui={() => void ipc.openLocalUrl(`http://127.0.0.1:${e.port}/`)}
                  onConfigure={() => {
                    setDetailFile(null);
                    setConfigFile(fileOf(e));
                  }}
                  onDetail={() => {
                    setConfigFile(null);
                    setDetailFile(fileOf(e));
                  }}
                />
              ))
            )}
          </div>
        </div>

        <div className="form-text" style={{ marginTop: "0.75rem" }}>
          {shown.length} 个 config
          {status.proxy ? ` · 代理 :${status.proxy_port ?? 9090}（DSH 连这里）` : ""}
          {status.running
            ? ` · 引擎运行中 ${status.model_name || ""} · :${status.port}${status.version ? ` · ${status.version}` : ""}`
            : runningEntry && !status.external
              ? ` · 引擎启动/加载中 ${status.model_name || runningFile || ""} · :${status.port}（端口暂无响应）`
              : status.proxy
                ? " · 引擎未起，首次请求时自动启动并加载模型"
                : " · Strata 未运行，用卡片上的启动按钮启动，或点上方「启动代理」让 DSH 直连"}
          {sharedPort && " · 多份 config 共用同一端口，同时只能跑一个（启动会先停掉正在跑的那个）"}
          {ctxMismatch && " · config 与运行时上下文不一致，重启才生效"}
        </div>
      </div>

      {configEntry && (
        <StrataConfigSheet
          entry={configEntry}
          onClose={() => {
            setConfigFile(null);
            void refreshStrata();
          }}
        />
      )}
      {detailEntry && (
        <StrataDetailSheet
          entry={detailEntry}
          onClose={() => {
            setDetailFile(null);
            void refreshStrata();
          }}
        />
      )}
    </main>
  );
}
