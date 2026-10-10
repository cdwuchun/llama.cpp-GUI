import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../store";
import type { ModelView } from "../types";
import { getModelIcon } from "../utils/modelIcon";
import {
  fmtSize,
  mergeModels,
  presetSections,
  selectModels,
  webuiDisabledSections,
} from "../utils/models";
import { ConfigSheet, DetailSheet } from "./ModelSheets";
import { PresetEditor } from "./PresetEditor";

type SortKey = "name_asc" | "name_desc" | "size_asc" | "size_desc";

/** 排序下拉的显示文案 */
const SORT_LABELS: Record<SortKey, string> = {
  name_asc: "名称 ↑",
  name_desc: "名称 ↓",
  size_asc: "大小 ↑",
  size_desc: "大小 ↓",
};
type Filter = "all" | "loaded" | "favourite" | "missing";

/** 置顶项：叠在名称/大小排序之上，两项互斥 */
type Pinned = "none" | "active" | "favourite";

/** 状态徽标：对应 hub 的 `.model-status-badge` + `.status-*` 四态。 */
function statusOf(model: ModelView) {
  if (model.failed) {
    return { cls: "status-stopped", icon: "fa-exclamation-triangle", text: "加载失败" };
  }
  switch (model.status) {
    case "loaded":
      return { cls: "status-loaded", icon: "fa-check-circle", text: "运行中" };
    case "loading":
      return { cls: "status-loading", icon: "fa-spinner fa-spin", text: "加载中" };
    case "sleeping":
      return { cls: "status-stopped", icon: "fa-moon", text: "休眠" };
    case "downloading":
      return { cls: "status-loading", icon: "fa-download", text: "下载中" };
    default:
      return { cls: "status-stopped", icon: "fa-stop-circle", text: "已停止" };
  }
}

/**
 * 一张模型卡。
 *
 * 外面包 `memo`：父组件每次渲染都重建内联回调，几百个模型时会整列表重渲染。
 * 回调改成"接收 id"的固定引用（`useCallback`）之后，memo 才真的能挡住。
 * 订阅 store 仍然是卡片内部逐个字段取（zustand 按字段浅比较），这样别处的状态
 * 变化也不会把全部卡片拉起来。
 */
const ModelCard = memo(function ModelCard({
  model,
  grid,
  webuiOff,
  onConfigure,
  onDetail,
}: {
  model: ModelView;
  grid: boolean;
  /** 这个模型的段是否关掉了自带 webui（父组件扫一次 preset 算好传下来） */
  webuiOff: boolean;
  onConfigure: (id: string) => void;
  onDetail: (id: string) => void;
}) {
  const busy = useApp((s) => s.busy);
  const running = useApp((s) => s.status.running);
  const startModel = useApp((s) => s.startModel);
  const stopModel = useApp((s) => s.stopModel);
  const toggleFavourite = useApp((s) => s.toggleFavourite);
  const openModelChat = useApp((s) => s.openModelChat);
  // 显存互斥（用户 m03342）：开启且 Strata 在跑时，启动按钮要说清会先停掉 Strata
  const mutex = useApp((s) => s.settings?.strata_router_mutex ?? false);
  const strataRunning = useApp((s) => s.strataStatus.running);

  const active = model.status === "loaded" || model.status === "loading" || model.status === "sleeping";
  // 运行中且已分配到子实例端口时，才提供"打开聊天界面"入口（ModelView.port 已由 mergeModels 解析出来）；
  // 段落里关掉了自带 WebUI 的模型没有界面，按钮给禁用态
  const chatPort = model.status === "loaded" ? model.port : null;
  // 不在这里扫整份 presets.ini：父组件用 webuiDisabledSections 一次算成集合，
  // 每张卡只做一次 Set.has（原来每张卡每次渲染都要 split 全文重扫一遍）
  const chatDisabled = webuiOff;
  const status = statusOf(model);
  // hub 的 getModelIcon(architecture)：优先按 GGUF 架构匹配，名字/id 兜底
  const icon = getModelIcon(model.scanned?.architecture, model.name, model.id);
  const hasMtp = /mtp/i.test(model.name) || /mtp/i.test(model.id);

  /** 启动/停止：灰底图标按钮，放在配置按钮左边（原先藏在状态徽标里的那个 ▶ 已去掉，
      徽标只负责显示状态）。
      运行中时加 `is-running` 类 —— 仍是灰底，但图标转红（停止）。 */
  const startStop = (
    <button
      type="button"
      className={`btn-icon soft${active ? " is-running" : ""}`}
      title={
        !running
          ? "router 未运行，无法启动"
          : active
            ? "停止"
            : model.inPreset
              ? mutex && strataRunning
                ? "启动（显存互斥已开：会先停止 Strata）"
                : "启动"
              : "请先在「配置」里保存，写入 presets.ini 后即可启动"
      }
      disabled={!running || busy || (!active && !model.inPreset)}
      onClick={() => void (active ? stopModel(model.section) : startModel(model.section))}
    >
      <i className={`fas ${active ? "fa-stop" : "fa-play"}`} />
    </button>
  );

  const badge = (
    <div className={`model-status-badge ${status.cls}`}>
      <i className={`fas ${status.icon}`} /> <span>{status.text}</span>
    </div>
  );

  const fav = (
    <button
      type="button"
      className={`model-fav-btn ${model.favourite ? "active" : ""}`}
      title={model.favourite ? "取消喜好" : "标记喜好"}
      onClick={() => void toggleFavourite(model.id)}
    >
      <i className={`${model.favourite ? "fas" : "far"} fa-star`} />
    </button>
  );

  const iconBox = (
    <div className="model-icon-wrapper">
      {icon ? <img src={icon} alt="" loading="lazy" decoding="async" /> : <i className="fas fa-brain" />}
    </div>
  );

  // 徽标与 hub 新版一致：跟在模型名后面（inline），不再是独立一行
  const badges = (
    <span className="mc-badges">
      {model.hasMmproj && <span>视觉</span>}
      {hasMtp && <span>MTP</span>}
      {!model.inPreset && <span>未同步</span>}
    </span>
  );
  const hasBadges = model.hasMmproj || hasMtp || !model.inPreset;

  const nameEl = (
    <div className="model-name" title={`${model.name}\n${model.id}`}>
      {model.name}
      {hasBadges && badges}
    </div>
  );

  const metaEl = (
    <div className="model-meta">
      {/* hub 的第一项是 GGUF 架构名（如 bert / qwen35moe），不是模型名 */}
      <span>
        <i className="fas fa-layer-group" /> {model.scanned?.architecture ?? "未知"}
      </span>
      {model.quantization && (
        <span>
          <i className="fas fa-microchip" /> {model.quantization}
        </span>
      )}
      <span>
        <i className="fas fa-hdd" /> {fmtSize(model.sizeBytes)}
      </span>
      {model.port != null && (
        <span>
          <i className="fas fa-network-wired" /> {model.port}
        </span>
      )}
    </div>
  );

  /** 列表视图：图标 + （名字 + meta）在同一行里平铺 */
  const details = (
    <div className="model-details">
      {nameEl}
      {metaEl}
    </div>
  );

  const actions = (
    <div className="model-actions">
      {startStop}
      {/* 运行中才给聊天入口：每个模型是独立子实例，各自一个 llama.cpp 自带界面。
          段落里写了 webui = 0 的模型没有界面，这里给禁用态并说明去哪聊。 */}
      {active && chatPort != null && (
        <button
          type="button"
          className="btn-icon"
          disabled={chatDisabled}
          title={
            chatDisabled
              ? `${model.section} 已关闭自带 webui（配置里的「禁用webui」为 true）——请从侧栏「开始聊天」进入，在里面选模型`
              : `打开 ${model.id} 的聊天界面（仅该模型，:${chatPort}）`
          }
          onClick={() => void openModelChat(model.section)}
        >
          <i className="fas fa-comments" />
        </button>
      )}
      {/* 这个按钮一律打开配置弹窗（弹窗里再「保存并加载」），所以固定用配置图标，
          之前未加载时会显示成播放图标，容易误认成直接启动。
          样式上不加 primary —— 与 hub 新版一致：配置是普通按钮。 */}
      <button type="button" className="btn-icon" title="配置" onClick={() => onConfigure(model.id)}>
        <i className="fas fa-sliders" />
      </button>
      <button type="button" className="btn-icon" title="详情" onClick={() => onDetail(model.id)}>
        <i className="fas fa-info-circle" />
      </button>
    </div>
  );

  if (grid) {
    return (
      <div className="model-item">
        {fav}
        {/* 图标与模型名同一行、垂直居中对齐；meta 另起一行平铺（同 hub 新版的 .mc-head / .mc-meta） */}
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
});

/**
 * 排序下拉：上半部分是互斥的排序方式，横杠下面「运行中优先」是可以**叠加**在
 * 任意排序之上的开关（勾选后不关闭菜单，方便连着设）。
 */
function SortMenu({
  sortKey,
  pinned,
  onSort,
  onPin,
}: {
  sortKey: SortKey;
  pinned: Pinned;
  onSort: (key: SortKey) => void;
  /** 置顶项互斥：点已选中的那个等于取消 */
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
              {/* 左侧固定 14px 的勾选位：选中项打勾，未选中留空（对齐不跳动） */}
              <i className={sortKey === key ? "fas fa-check" : ""} />
              <span>{SORT_LABELS[key]}</span>
            </button>
          ))}
          {/* 横杠：上面是互斥的排序方式，下面是可以**叠加**在排序之上的置顶项。
              两个置顶项之间互斥（选一个会取消另一个），都用同一个 ✓ 标记。 */}
          <div className="dropdown-sep" />
          <button
            type="button"
            className="dropdown-item"
            onClick={() => onPin(pinned === "active" ? "none" : "active")}
          >
            <i className={pinned === "active" ? "fas fa-check" : ""} />
            <span>运行中优先</span>
          </button>
          <button
            type="button"
            className="dropdown-item"
            onClick={() => onPin(pinned === "favourite" ? "none" : "favourite")}
          >
            <i className={pinned === "favourite" ? "fas fa-check" : ""} />
            <span>收藏优先</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 顶栏的 preset 下拉：把「同步到 presets.ini」和「编辑 preset 文件」这两件事收在一个按钮里，
 * 顶栏只留搜索 / 刷新 / 排序 / 筛选 / 视图切换。
 */
function PresetMenu({
  busy,
  canSync,
  onSyncPreset,
  onEditPreset,
}: {
  busy: boolean;
  canSync: boolean;
  onSyncPreset: () => void;
  onEditPreset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // 点空白处 / 按 Esc 关闭
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

  const item = (icon: string, label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      className="dropdown-item"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
    >
      <i className={icon} />
      <span>{label}</span>
    </button>
  );

  return (
    <div className="dropdown" ref={wrap}>
      <button
        type="button"
        className={`btn btn-secondary ${open ? "active" : ""}`}
        style={{ flexShrink: 0 }}
        title="presets.ini 相关操作"
        onClick={() => setOpen((v) => !v)}
      >
        <i className="fas fa-file-lines" />
        <span>preset</span>
        <i className={`fas fa-chevron-${open ? "up" : "down"}`} style={{ marginLeft: 4, fontSize: "0.7rem" }} />
      </button>
      {open && (
        <div className="dropdown-menu">
          {item(
            "fas fa-file-import",
            "同步到 presets.ini",
            onSyncPreset,
            busy || !canSync,
          )}
          {item("fas fa-file-pen", "编辑 preset 文件", onEditPreset, busy)}
        </div>
      )}
    </div>
  );
}

export function ModelListPanel() {
  const scanned = useApp((s) => s.scanned);
  const routerModels = useApp((s) => s.routerModels);
  const presetText = useApp((s) => s.presetText);
  const settings = useApp((s) => s.settings);
  const status = useApp((s) => s.status);
  const busy = useApp((s) => s.busy);
  const refreshModels = useApp((s) => s.refreshModels);
  const syncPreset = useApp((s) => s.syncPreset);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name_asc");
  // 置顶项是叠在排序之上的开关（不是排序的一种），单独记一个偏好。
  // 兼容旧键 modelRunningFirst（那时只有"运行中优先"）。
  const [pinned, setPinned] = useState<Pinned>(() => {
    const saved = localStorage.getItem("modelPinned");
    if (saved === "active" || saved === "favourite") return saved;
    return localStorage.getItem("modelRunningFirst") === "0" ? "none" : "active";
  });
  // hub 的默认视图是列表；这里默认卡片，和用户当前在 hub 里看到的保持一致
  const [grid, setGrid] = useState(() => localStorage.getItem("modelView") !== "list");
  const [configId, setConfigId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState(false);

  useEffect(() => {
    localStorage.setItem("modelView", grid ? "grid" : "list");
  }, [grid]);
  useEffect(() => {
    localStorage.setItem("modelPinned", pinned);
    localStorage.setItem("modelRunningFirst", pinned === "active" ? "1" : "0");
  }, [pinned]);

  const sections = useMemo(() => presetSections(presetText), [presetText]);
  /**
   * 关掉了自带 webui 的段名集合：整份 preset 只扫这一次。
   *
   * 原来是每张卡片各自调 `webuiDisabled(presetText, section)`（内部就是
   * `presetValue` → `split(/\r?\n/)` 扫全文），开销是「卡片数 × 文件行数」，
   * 而且每次渲染都重算。
   */
  const webuiOff = useMemo(() => webuiDisabledSections(presetText), [presetText]);

  // 固定引用（配合卡片的 memo）：id 由卡片回传，父组件不用为每个模型各建一个闭包
  const openConfig = useCallback((id: string) => {
    setDetailId(null);
    setConfigId(id);
  }, []);
  const openDetail = useCallback((id: string) => setDetailId(id), []);
  const merged = useMemo(
    () =>
      mergeModels(
        scanned,
        routerModels,
        settings?.favourites ?? [],
        sections,
        settings?.aliases ?? {},
      ),
    [scanned, routerModels, settings?.favourites, sections, settings?.aliases],
  );

  const shown = useMemo(() => {
    const sort = sortKey.startsWith("size") ? "size" : "name";
    const desc = sortKey.endsWith("desc");
    return selectModels(merged, {
      query,
      filter,
      sort,
      desc,
      pinned: pinned === "none" ? undefined : pinned,
    });
  }, [merged, query, filter, sortKey, pinned]);

  const loadedCount = merged.filter((m) => m.status === "loaded").length;
  const totalMiB = shown.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
  const configModel = merged.find((m) => m.id === configId) ?? null;
  const detailModel = merged.find((m) => m.id === detailId) ?? null;

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>模型列表</span> <span className="model-count-badge">{loadedCount}/{merged.length}</span>
        </h1>
        <div className="top-actions">
          <div className="search-box" style={{ flexShrink: 0, width: 220 }}>
            <i className="fas fa-search search-icon" />
            <input
              type="text"
              className="search-input"
              placeholder="搜索模型..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flexShrink: 0 }}
            title="刷新模型列表（重新扫描磁盘）"
            disabled={busy}
            onClick={() => void refreshModels(true)}
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
            <option value="loaded">运行中</option>
            <option value="favourite">收藏</option>
            <option value="missing">未同步 preset</option>
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
          <PresetMenu
            busy={busy}
            canSync={scanned.length > 0}
            onSyncPreset={() => void syncPreset()}
            onEditPreset={() => setEditingPreset(true)}
          />
        </div>
      </div>

      <div className="content-scrollable">
        <div className="model-list-container">
          <div id="modelsList" className={grid ? "grid-view" : undefined}>
            {merged.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-box-open" />
                </div>
                <div className="empty-state-title">还没有扫描到模型</div>
                <div className="empty-state-text">
                  到「设置」里添加模型根目录（例如 E:\AI\models），保存后回到本页点刷新。
                </div>
              </div>
            ) : shown.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">
                  <i className="fas fa-filter" />
                </div>
                <div className="empty-state-text">没有匹配的模型</div>
              </div>
            ) : (
              shown.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  grid={grid}
                  webuiOff={webuiOff.has(m.section)}
                  onConfigure={openConfig}
                  onDetail={openDetail}
                />
              ))
            )}
          </div>
        </div>

        <div className="form-text" style={{ marginTop: "0.75rem" }}>
          {shown.length} 个模型 · 合计 {(totalMiB / 1024 ** 3).toFixed(1)} GB
          {!status.running && " · router 未运行，用左下角的启动按钮启动"}
        </div>
      </div>

      {configModel && (
        <ConfigSheet
          model={configModel}
          onClose={() => {
            setConfigId(null);
            void refreshModels(false);
          }}
        />
      )}
      {detailModel && <DetailSheet model={detailModel} onClose={() => setDetailId(null)} />}
      {editingPreset && <PresetEditor onClose={() => setEditingPreset(false)} />}
    </main>
  );
}
