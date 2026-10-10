import { useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../store";
import { boolText, paramSchema, type ParamDef, type ParamSchema, type ParamState } from "../utils/paramSchema";
import { Modal } from "./Sheet";

/** 路径候选（下拉里的一行） */
type PathOption = { value: string; label: string };

/** 值是「跑在哪张卡上」的参数：候选来自当前枚举到的设备（外加 `none`） */
const DEVICE_PARAMS = new Set(["mmproj-device", "spec-draft-device"]);

/**
 * 带下拉菜单的输入框 —— 照 hub 旧版的 `.ctx-cb-*` 实现。
 *
 * 为什么不用 `<datalist>`：WebView2（Chromium）里 `input[list]` 不显示下拉箭头，
 * 用户根本不知道有候选可点，看起来就是个普通输入框。hub 的做法是自绘下拉：
 * 输入框右侧一个 `▾` 按钮，展开后每项左边是名字、右边是取值（`8K` / `8192`）。
 * 输入框仍然可以直接打字 —— 常用档位只是方便，不把用户锁死在枚举里。
 */
function DropdownInput({
  id,
  numeric,
  def,
  state,
  options,
  onChange,
}: {
  id: string;
  numeric: boolean;
  def: ParamDef;
  state: ParamState;
  options: PathOption[];
  onChange: (next: ParamState) => void;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点别处或按 Esc 关掉菜单
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
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
    <div className="ctx-cb" ref={boxRef}>
      <div className="ctx-cb-input-row">
        <input
          id={id}
          type={numeric ? "number" : "text"}
          className="form-control ctx-cb-input"
          placeholder={def.default}
          value={state.value}
          onChange={(e) => onChange({ ...state, value: e.target.value })}
        />
        <button
          type="button"
          className="ctx-cb-btn"
          tabIndex={-1}
          title="选择预设"
          onClick={() => setOpen((v) => !v)}
        >
          ▾
        </button>
      </div>
      <div className={`ctx-cb-menu ${open ? "open" : ""}`}>
        {options.map((o) => (
          <div
            key={o.value}
            className="ctx-cb-opt"
            onClick={() => {
              onChange({ ...state, value: o.value });
              setOpen(false);
            }}
          >
            <span className="ctx-cb-opt-label">{o.label}</span>
            <span className="ctx-cb-opt-val">{o.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 需要"选路径"的参数（文件或目录）。
 *
 * 这些字段以前是纯文本框：desc 里写着"点击文件夹按钮选择"，按钮却根本不存在，
 * 用户只能手打完整路径。现在给候选下拉 + 「浏览…」按钮。
 */
const PATH_PARAMS: Record<
  string,
  {
    title: string;
    kinds: string[];
    modelsToo?: boolean;
    /** 选目录而不是文件 */ dir?: boolean;
    placeholder?: string;
  }
> = {
  mmproj: { title: "选择多模态投影文件", kinds: ["mmproj"] },
  // 草稿模型可以是专门的 draft 文件，也可以是另一个小模型（常见用法），所以候选里带上所有模型
  "spec-draft-model": { title: "选择草稿模型", kinds: ["draft"], modelsToo: true },
  // 视频抽帧用的 ffmpeg/ffprobe 所在目录（不是文件）
  "video-ffmpeg-dir": { title: "选择 ffmpeg 所在目录", kinds: [], dir: true },
  // Strata 的多模态模型：写 config 顶层 vision.mmproj，候选是扫描到的投影文件 + 名字含 mmproj 的模型
  "vision-mmproj": {
    title: "选择多模态模型",
    kinds: ["mmproj"],
    modelsToo: true,
    placeholder: "勾选「多模态（视觉）」后必填",
  },
};

/** 路径选择控件：可手输、可从扫描结果里挑、也可以打开系统对话框。 */
function PathControl({
  def,
  state,
  options,
  onChange,
}: {
  def: ParamDef;
  state: ParamState;
  options: { value: string; label: string }[];
  onChange: (next: ParamState) => void;
}) {
  const setError = useApp((s) => s.setError);
  const listId = `path-options-${def.key}`;
  const cfg = PATH_PARAMS[def.key];
  const isDir = Boolean(cfg?.dir);

  const browse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
        // 目录类参数（ffmpeg 所在目录）选目录，其余选 gguf 文件
        directory: isDir,
        title: cfg?.title ?? "选择文件",
        ...(isDir ? {} : { filters: [{ name: "GGUF 模型", extensions: ["gguf"] }] }),
      });
      if (typeof picked === "string") {
        // 统一成正斜杠：跟扫描结果、preset 里其它路径的写法保持一致
        onChange({ enabled: true, value: picked.replace(/\\/g, "/") });
      }
    } catch (err) {
      setError(`打开对话框失败：${String(err)}`);
    }
  };

  return (
    <div className="path-picker">
      <input
        type="text"
        list={listId}
        className="form-control mono"
        style={{ fontSize: 12 }}
        placeholder={
          cfg?.placeholder ?? (isDir ? "留空 = 在 PATH 中搜索" : "留空 = 自动检测同目录文件")
        }
        value={state.value}
        onChange={(e) => onChange({ ...state, value: e.target.value })}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </datalist>
      <button
        type="button"
        className="btn btn-secondary path-picker-browse"
        title="浏览文件…"
        onClick={() => void browse()}
      >
        <i className="fas fa-folder-open" />
      </button>
    </div>
  );
}

/**
 * 有序多选（`uiType: "ordered-multiselect"`）——沿用 hub 的 `.ordered-multiselect-*` 类名。
 *
 * 用于像 `--samplers` 这种**顺序有语义**的多值参数：采样器按列表顺序依次执行。
 * 值以 `delimiter`（默认 `;`）连接成一个字符串，正好就是 preset 中该键的写法。
 */
export function OrderedMultiSelect({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: string;
  onChange: (next: string) => void;
}) {
  const sep = def.delimiter || ";";
  const selected = value.split(sep).map((s) => s.trim()).filter(Boolean);
  const labels = new Map(def.values.map((v) => [v.value, v.label]));

  const commit = (next: string[]) => onChange(next.join(sep));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selected.length) return;
    const next = [...selected];
    const tmp = next[index];
    next[index] = next[target];
    next[target] = tmp;
    commit(next);
  };

  return (
    <div className="ordered-multiselect">
      <div className="ordered-multiselect-section ordered-multiselect-section-available">
        <div className="ordered-multiselect-heading">点击添加</div>
        <div className="ordered-multiselect-options">
          {def.values.map((v) => {
            const on = selected.includes(v.value);
            return (
              <button
                type="button"
                key={v.value}
                className={`ordered-multiselect-option ordered-multiselect-option-toggle ${
                  on ? "is-selected" : ""
                }`}
                disabled={on}
                onClick={() => commit([...selected, v.value])}
              >
                <span className="ordered-multiselect-option-text">{v.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="ordered-multiselect-section ordered-multiselect-section-selected">
        <div className="ordered-multiselect-heading">当前执行顺序</div>
        <div className="ordered-multiselect-selected-list">
          {selected.length === 0 && <div className="ordered-multiselect-empty">未选择</div>}
          {selected.map((name, index) => (
            <div className="ordered-multiselect-selected-item" key={`${name}-${index}`}>
              <span className="ordered-multiselect-selected-text">{labels.get(name) ?? name}</span>
              <div className="ordered-multiselect-selected-actions">
                <button
                  type="button"
                  className="ordered-multiselect-action"
                  title="上移"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ordered-multiselect-action"
                  title="下移"
                  disabled={index === selected.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ordered-multiselect-action danger"
                  title="移除"
                  onClick={() => commit(selected.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="ordered-multiselect-preview">
          最终值：{selected.length ? selected.join(sep) : "未选择"}
        </div>
      </div>
    </div>
  );
}

function ValueControl({
  def,
  state,
  options,
  deviceOptions,
  onEditJson,
  onChange,
}: {
  def: ParamDef;
  state: ParamState;
  /** 路径类参数（投影文件 / 草稿模型）的候选；其它参数传空数组 */
  options: { value: string; label: string }[];
  /** 设备类参数（mmproj / 草稿模型跑在哪张卡）的候选 */
  deviceOptions: PathOption[];
  /** JSON 类参数：交给上层打开编辑弹窗 */
  onEditJson: (def: ParamDef, state: ParamState) => void;
  onChange: (next: ParamState) => void;
}) {
  const set = (value: string) => onChange({ ...state, value });
  const numeric = def.type === "INTEGER" || def.type === "FLOAT";

  // 值是一个 gguf 路径的参数：给候选下拉 + 「浏览…」按钮
  if (PATH_PARAMS[def.key]) {
    return <PathControl def={def} state={state} options={options} onChange={onChange} />;
  }

  // 设备类参数：下拉枚举当前能用的后端/设备（CUDA0、Vulkan0…），也允许填 none 用 CPU
  if (DEVICE_PARAMS.has(def.key)) {
    return (
      <DropdownInput
        id={`param-devices-${def.key}`}
        numeric={false}
        def={def}
        state={state}
        options={deviceOptions}
        onChange={onChange}
      />
    );
  }

  // 逻辑型参数：与 hub 一致，用 true / false 下拉
  if (def.type === "LOGIC") {
    return (
      <select className="form-control" value={boolText(state.value)} onChange={(e) => set(e.target.value)}>
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  }

  // 有常用档位、但也允许自己填的参数（如 --ctx-size）：hub 式的下拉 + 手输
  if (def.uiType === "dropdown") {
    return (
      <DropdownInput
        id={`param-values-${def.key}`}
        numeric={numeric}
        def={def}
        state={state}
        options={def.values}
        onChange={onChange}
      />
    );
  }

  if (def.values.length > 0) {
    // 当前值不在候选项里时补一个占位项（hub 的 mmproj-device 就是这么做的）：
    // 否则 select 的 selectedIndex 是 -1，控件**显示成一片空白** ——
    // `chat-template` / `numa` 的默认值就是空串，之前打开配置只看得到空下拉。
    const known = def.values.some((v) => v.value === state.value);
    return (
      <select className="form-control" value={state.value} onChange={(e) => set(e.target.value)}>
        {!known && (
          <option value={state.value}>{state.value || "（未设置，用模型默认）"}</option>
        )}
        {def.values.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </select>
    );
  }

  // JSON 类参数（JSON Schema / 聊天模板额外参数）：与 hub 一致，
  // 输入框只读、显示当前值，点按钮打开弹窗编辑 —— 直接塞进一行小输入框没法看也没法改。
  if (def.type === "JSON") {
    return (
      <div className="path-picker">
        <input
          type="text"
          className="form-control json-param-input mono"
          style={{ fontSize: 13 }}
          value={state.value}
          readOnly
          placeholder="[JSON] 点击右侧按钮编辑"
          onClick={() => onEditJson(def, state)}
        />
        <button
          type="button"
          className="btn btn-secondary path-picker-browse"
          title="编辑 JSON"
          onClick={() => onEditJson(def, state)}
        >
          <i className="fas fa-code" />
        </button>
      </div>
    );
  }

  return (
    <input
      type={numeric ? "number" : "text"}
      step={def.type === "FLOAT" ? "0.01" : undefined}
      className="form-control"
      placeholder={def.default}
      value={state.value}
      onChange={(e) => set(e.target.value)}
    />
  );
}

/**
 * 参数分组折叠状态的记忆（localStorage）。
 *
 * 之前每次打开配置弹窗都按 schema 里的 `collapsed` 重置，用户折掉一堆组、重开又全展开。
 * 现在改成：**动过就记**，下次打开沿用；折叠状态按 `persistKey` 分键存放，
 * 不同用途的同名分组互不影响。
 */
const COLLAPSE_KEY_DEFAULT = "paramGroupCollapsed";

function loadCollapsed(storeKey: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(`${storeKey}:${COLLAPSE_KEY_DEFAULT}`);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") out[key] = value;
    }
    return out;
  } catch {
    return {}; // 存储不可用（隐私模式等）时退回默认折叠状态
  }
}

function saveCollapsed(storeKey: string, next: Record<string, boolean>): void {
  try {
    localStorage.setItem(`${storeKey}:${COLLAPSE_KEY_DEFAULT}`, JSON.stringify(next));
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

/**
 * 参数表单 —— 结构照搬 hub 旧版（`renderParamGroup` / `renderParamField`）：
 * `<details class="param-group">` 折叠分组，组内每行 `.form-group.param-field`，
 * label 行左侧是"悬停才出现"的启用勾选框，控件统一用 `.form-control`。
 */
export function ParamForm({
  state,
  onChange,
  schema = paramSchema,
  headerTools = true,
  persistKey = "modelParams",
}: {
  state: Record<string, ParamState>;
  onChange: (next: Record<string, ParamState>) => void;
  /** 参数表（模型启动参数，来自 src/assets/params.json） */
  schema?: ParamSchema;
  /** 是否显示"已启用 N / M + 全部取消"这一行（弹层把统计放到底部时为 false） */
  headerTools?: boolean;
  /** 分组折叠状态的 localStorage 键（不同用法各记一份，避免同名分组互相影响） */
  persistKey?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      schema.groups.map((g) => {
        // hub 的 renderParamGroup：含有序多选的组（如「采样器链」）默认展开
        const special = schema.params.some(
          (p) => p.group === g.id && p.uiType === "ordered-multiselect",
        );
        const fallback = special ? false : g.collapsed;
        // 用户手动折过的话以记忆为准（下次打开保持上次的折叠状态）
        const remembered = loadCollapsed(persistKey);
        return [g.id, g.id in remembered ? remembered[g.id] : fallback];
      }),
    ),
  );

  const toggleGroup = (id: string) => {
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] };
      saveCollapsed(persistKey, next);
      return next;
    });
  };

  const setOne = (key: string, next: ParamState) => onChange({ ...state, [key]: next });

  /**
   * 参数说明弹窗（与 hub 旧版的 `#paramDescModal` 同构）。
   *
   * 为什么不用原生 `title`：说明是整段中文，WebView2 的原生提示按内容撑宽，
   * 一撑就横出配置弹窗。hub 的做法是点问号开一个限宽弹窗，正文自动换行。
   */
  const [descParam, setDescParam] = useState<ParamDef | null>(null);

  /** JSON 类参数的编辑弹窗（与 hub 的 `openJsonEditor` 同构） */
  const [jsonEdit, setJsonEdit] = useState<{
    key: string;
    label: string;
    text: string;
    error: string | null;
  } | null>(null);

  const openJsonEditor = (def: ParamDef, s: ParamState) => {
    setJsonEdit({ key: def.key, label: def.label, text: s.value, error: null });
  };

  /**
   * 确认 JSON 编辑。
   *
   * 与 hub 一致：空值放行（等于"不设置"），非空必须能 `JSON.parse`；
   * 写回时**去掉换行** —— preset 是一行一个键，多行会把段结构撑坏。
   */
  const confirmJsonEditor = () => {
    if (!jsonEdit) return;
    const raw = jsonEdit.text.trim();
    if (raw) {
      try {
        JSON.parse(raw);
      } catch (err) {
        setJsonEdit({ ...jsonEdit, error: `JSON 格式错误：${String(err)}` });
        return;
      }
    }
    const current = state[jsonEdit.key] ?? { enabled: false, value: "" };
    const value = raw.replace(/[\r\n]+/g, "");
    // 点「确定」就是"我要用这个值"：只改 value 不置 enabled 的话，参数仍是关闭态，
    // 保存后不会写进 preset —— 输入框里明明有内容却什么都没提交，界面上还没有任何提示。
    // 清空内容则沿用原来的开关状态（清空通常是撤回，顺手把它打开反而多写一个键）。
    setOne(jsonEdit.key, { ...current, enabled: value ? true : current.enabled, value });
    setJsonEdit(null);
  };

  const clearAll = () => {
    const next: Record<string, ParamState> = {};
    for (const p of schema.params) {
      next[p.key] = { enabled: false, value: p.type === "LOGIC" ? boolText(p.default) : p.default };
    }
    onChange(next);
  };

  /**
   * 路径类参数的候选列表。
   *
   * `mmproj`：扫描到的全部投影文件（含放在作者目录那种"被忽略目录"里的）。
   * `spec-draft-model`：草稿模型文件 **加上**所有扫描到的模型 —— 推测解码常见的用法
   * 就是拿另一个小模型当草稿，只列 draft 文件的话用户根本选不到。
   */
  const scanned = useApp((s) => s.scanned);
  const auxFiles = useApp((s) => s.auxFiles);
  const pathOptions = useMemo(() => {
    const mmproj: PathOption[] = [];
    const draft: PathOption[] = [];
    for (const a of auxFiles) {
      if (a.kind === "mmproj") mmproj.push({ value: a.path, label: a.name });
      else if (a.kind === "draft") draft.push({ value: a.path, label: a.name });
    }
    for (const m of scanned) {
      if (m.mmproj) mmproj.push({ value: m.mmproj, label: m.mmproj.split("/").pop() ?? m.mmproj });
      draft.push({ value: m.path, label: `${m.name}（模型）` });
    }
    // 多模态模型候选 = 扫描识别出的投影文件 + **文件名里带 mmproj 的模型**。
    // 扫描器按「文件名以 mmproj 开头」识别投影文件，作者把名字写成
    // `xxx-mmproj-xxx.gguf` 这种就不在识别范围，但它确实是投影模型，得让用户选得到。
    const mmprojNamed: PathOption[] = scanned
      .filter((m) => /mmproj/i.test(m.name) || /mmproj/i.test(m.path))
      .map((m) => ({ value: m.path, label: `${m.name}（模型）` }));
    const dedupe = (items: PathOption[]): PathOption[] => {
      const seen = new Set<string>();
      return items.filter((i) => (i.value && !seen.has(i.value) ? (seen.add(i.value), true) : false));
    };
    return {
      mmproj: dedupe(mmproj),
      "spec-draft-model": dedupe(draft),
      "vision-mmproj": dedupe([...mmproj, ...mmprojNamed]),
    } as Record<string, PathOption[]>;
  }, [auxFiles, scanned]);

  /** 设备类参数的候选：当前枚举到的设备，外加 `none`（不用 GPU、用 CPU 跑） */
  const devices = useApp((s) => s.devices);
  const deviceOptions = useMemo<PathOption[]>(
    () => [
      { value: "none", label: "none（不用 GPU，用 CPU 跑）" },
      ...devices.map((d) => ({ value: d.name, label: d.description || d.name })),
    ],
    [devices],
  );

  const enabledCount = Object.values(state).filter((s) => s.enabled).length;
  if (schema.params.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <i className="fas fa-triangle-exclamation" />
        </div>
        <div className="empty-state-text">
          参数定义加载失败（params.json 形状异常），请看「系统日志」页的 frontend 来源。
        </div>
      </div>
    );
  }

  return (
    <div>
      {headerTools && (
        <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}>
          <span className="form-text" style={{ marginTop: 0 }}>
            已启用 {enabledCount} / {schema.params.length} 个参数
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.78rem" }}
            disabled={enabledCount === 0}
            onClick={clearAll}
          >
            <i className="fas fa-eraser" /> 全部取消
          </button>
        </div>
      )}

      <div className="param-groups">
        {schema.groups.map((group) => {
          const items = schema.params.filter((p) => p.group === group.id);
          if (items.length === 0) return null;
          const special = items.some((p) => p.uiType === "ordered-multiselect");
          const open = !collapsed[group.id];

          return (
            <details className={`param-group ${special ? "param-group-special" : ""}`} key={group.id} open={open}>
              <summary
                className="param-group-summary"
                onClick={(e) => {
                  // 展开/折叠完全由 state 驱动：若不 preventDefault，浏览器会先按原生
                  // 行为切一次 <details>，React 随后又按旧 state 覆盖回去，表现为
                  // "点了没反应"或"点一下弹两下"。
                  e.preventDefault();
                  toggleGroup(group.id);
                }}
              >
                <span className="param-group-title">{group.label}</span>
                <span className="param-group-count">{items.length}</span>
              </summary>

              <div className="param-group-body">
                <div
                  style={{
                    display: "grid",
                    // minmax(0,1fr)：默认的 `1fr` 下限是 min-content，长 option 文本
                    // （例如 --samplers 的候选值）会把两栏撑出弹窗宽度
                    gridTemplateColumns: special ? "minmax(0,1fr)" : "minmax(0,1fr) minmax(0,1fr)",
                    gap: "1rem",
                  }}
                >
                  {items.map((p) => {
                    const s = state[p.key] ?? {
                      enabled: false,
                      value: p.type === "LOGIC" ? boolText(p.default) : p.default,
                    };
                    return (
                      <div className="form-group param-field" key={p.key} style={{ minWidth: 0 }}>
                        <div
                          className="param-label-row"
                          style={{ display: "flex", alignItems: "center", gap: "0.4rem", lineHeight: 1.1 }}
                        >
                          <input
                            className="form-check-input param-enable-toggle"
                            type="checkbox"
                            checked={s.enabled}
                            title="勾选后写入该模型的 preset 段"
                            style={{
                              margin: 0,
                              width: 14,
                              height: 14,
                              flex: "0 0 auto",
                              transform: "translateY(1px)",
                            }}
                            onChange={(e) => setOne(p.key, { ...s, enabled: e.target.checked })}
                          />
                          <label
                            className="form-label"
                            style={{ margin: 0, fontSize: 15, lineHeight: 1.1 }}
                            title={p.flag}
                          >
                            {p.label}
                            {p.desc && (
                              <i
                                className="fas fa-question-circle param-desc-trigger"
                                style={{ cursor: "pointer", marginLeft: 4 }}
                                onClick={(e) => {
                                  // 与 hub 一致：点问号只开说明弹窗，不冒泡到 label
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setDescParam(p);
                                }}
                                data-param-name={p.label}
                                data-param-flag={p.flag}
                                data-param-desc={p.desc}
                              />
                            )}
                          </label>
                        </div>

                        {/*
                          有序多选（--samplers）与 hub 一致：label 行下面**直接**就是
                          `.ordered-multiselect` 组件本身，不再有"N 项已选"这类摘要行。
                          改动时顺带勾上启用勾选框 —— 我们的默认态是"未勾选"，而 hub 的
                          checkbox 初始恒为 checked，不自动勾选的话用户会以为没生效。
                        */}
                        {p.uiType === "ordered-multiselect" ? (
                          <OrderedMultiSelect
                            def={p}
                            value={s.value}
                            onChange={(value) => setOne(p.key, { ...s, value, enabled: true })}
                          />
                        ) : (
                          <ValueControl
                            def={p}
                            state={s}
                            options={pathOptions[p.key] ?? []}
                            deviceOptions={deviceOptions}
                            onEditJson={openJsonEditor}
                            onChange={(next) => setOne(p.key, next)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </details>
          );
        })}
      </div>

      {/* 参数说明弹窗（与 hub 的 #paramDescModal 同构）：点问号打开 */}
      {descParam && (
        <Modal
          domId="paramDescModal"
          title={descParam.label}
          iconClass="fa-circle-question"
          onClose={() => setDescParam(null)}
          footer={
            <button
              type="button"
              className="btn btn-secondary btn-uniform"
              onClick={() => setDescParam(null)}
            >
              关闭
            </button>
          }
        >
          <div className="param-desc-flag">{descParam.flag}</div>
          <div className="param-desc-modal-body">{descParam.desc}</div>
        </Modal>
      )}

      {/* JSON 参数编辑弹窗（与 hub 的 jsonEditorModal 同构） */}
      {jsonEdit && (
        <Modal
          domId="paramJsonModal"
          title={`编辑 JSON · ${jsonEdit.label}`}
          iconClass="fa-code"
          onClose={() => setJsonEdit(null)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary btn-uniform"
                onClick={() => setJsonEdit(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary btn-uniform"
                onClick={confirmJsonEditor}
              >
                <i className="fas fa-check" /> 确定
              </button>
            </>
          }
        >
          <textarea
            className="form-control mono"
            style={{ minHeight: 220, fontSize: 13, lineHeight: 1.5 }}
            value={jsonEdit.text}
            placeholder='例如：{"chat_template_kwargs": {"enable_thinking": false}}'
            onChange={(e) => setJsonEdit({ ...jsonEdit, text: e.target.value, error: null })}
          />
          {jsonEdit.error && (
            <div className="notice error" style={{ marginTop: "0.75rem" }}>
              {jsonEdit.error}
            </div>
          )}
          <small className="form-text">
            保存时会去掉换行（preset 一个键占一行）。留空表示不设置该参数。
          </small>
        </Modal>
      )}
    </div>
  );
}