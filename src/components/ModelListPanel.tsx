import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../store";
import type { ModelView } from "../types";
import { getModelIcon } from "../utils/modelIcon";
import {
  fmtSize,
  mergeModels,
  selectModels,
} from "../utils/models";
import { ConfigSheet, DetailSheet } from "./ModelSheets";
import { StrataPanel } from "./StrataPanel";

type SortKey = "name_asc" | "name_desc" | "size_asc" | "size_desc";

/** 排序下拉的显示文案 */
const SORT_LABELS: Record<SortKey, string> = {
  name_asc: "名称 ↑",
  name_desc: "名称 ↓",
  size_asc: "大小 ↑",
  size_desc: "大小 ↓",
};
type Filter = "all" | "loaded" | "favourite" | "missing";

/**
 * 通道标签（用户 m02352 第 1 点）：llama.cpp 的子实例和 Strata 引擎是两套进程、两套配置，
 * 混在一列里看不出哪个归谁，按标签分开看。
 */
type ChannelTab = "llamacpp" | "strata";

/**
 * 通道标签的显示文案。
 *
 * 标签上不带数量（用户 m02992 第 1 点）：一档有多少模型看标题后的统计，
 * 那个数字跟着当前标签走。
 */
const CHANNEL_LABELS: Record<ChannelTab, string> = {
  llamacpp: "llama.cpp",
  strata: "Strata",
};

/**
 * Strata 那档的筛选值域：搜索、刷新、视图切换是两档共用的
 * （用户 m03160 第 1 点：两档共用同一条工具行）。
 *
 * 排序不再单列一套（用户 m03482 第 5 点：排序选项两档统一）—— 用 llama.cpp 那套
 * 名称/大小，Strata 的 config 也有 `model_size_bytes`，大小排得出来。
 * 「已选中（默认 config）」换成「收藏」（用户 m03333 第 8 点：GUI 启动 Strata 模型不需要
 * 先挑一个默认模型，星标就和 llama.cpp 那边一样只当收藏用）；
 * 「引擎缺失」这一档去掉（用户 m03333 第 7 点）。
 */
type StrataFilter = "all" | "running" | "favourite";

const STRATA_FILTERS: StrataFilter[] = ["all", "running", "favourite"];

const STRATA_FILTER_LABELS: Record<StrataFilter, string> = {
  all: "全部模型",
  running: "运行中",
  favourite: "收藏",
};

/** 置顶项：叠在名称/大小排序之上，两项互斥 */
type Pinned = "none" | "active" | "favourite";

/** 状态徽标：对应 hub 的 `.model-status-badge` + `.status-*` 四态。 */
type StatusBadge = { cls: string; icon: string; text: string };

function statusOf(model: ModelView): StatusBadge {
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
  onConfigure,
  onDetail,
}: {
  model: ModelView;
  grid: boolean;
  /** 这个模型的段是否关掉了自带 webui（父组件扫一次 preset 算好传下来） */
  onConfigure: (id: string) => void;
  onDetail: (id: string) => void;
}) {
  const busy = useApp((s) => s.busy);
  // 加载/卸载都走前门（统一入口 :9090），所以按钮的可用性看**前门在不在跑**，
  // 不再看 router —— router 正在退役。
  const running = useApp((s) => s.strataStatus.proxy);
  const startModel = useApp((s) => s.startModel);
  const stopModel = useApp((s) => s.stopModel);
  const toggleFavourite = useApp((s) => s.toggleFavourite);
  // 显存互斥（用户 m03160 第 2 点）：开启且 Strata 在跑时，启动按钮要说清会先卸掉 Strata 的模型
  const mutex = useApp((s) => s.settings?.strata_router_mutex ?? false);
  const strataRunning = useApp((s) => s.strataStatus.running);
  // Strata 通道的模型（用户 m02048 第 4 点）：启停不走前门，改调 Strata 接口，
  // 用的是配置文件全名（`strataFile`），所以跟 `section` 分开取。
  const startStrataModel = useApp((s) => s.startStrataModel);
  const stopStrataModel = useApp((s) => s.stopStrataModel);
  const isStrata = model.channel === "strata";
  const strataFile = model.strataFile ?? null;
  // 这一步是不是正在被启停（用户 m03482 第 3 点）：startModel/stopModel 在发请求**之前**
  // 就把 id 记进 store，卡片据此立刻转圈，不用等第一次轮询（前门那条 await 要几十秒）。
  // 各取一个布尔值，别取 modelPending 整个对象 —— 对象每次 set 都是新引用，
  // 会让所有卡片跟着重渲染。
  const isPending = useApp((s) => s.modelPending?.id === model.section);
  const pendingStop = useApp((s) =>
    s.modelPending?.id === model.section ? s.modelPending.stop : false,
  );

  const active = model.status === "loaded" || model.status === "loading" || model.status === "sleeping";
  // 运行中且已分配到子实例端口时，才提供"打开聊天界面"入口（ModelView.port 已由 mergeModels 解析出来）；
  // 段落里关掉了自带 WebUI 的模型没有界面，按钮给禁用态
  // 不在这里扫整份 presets.ini：父组件用 webuiDisabledSections 一次算成集合，
  // 每张卡只做一次 Set.has（原来每张卡每次渲染都要 split 全文重扫一遍）
  // 待启停期间直接给「加载中 / 卸载中」，判据与 Strata 卡片的「停止中」是同一套（用户 m04854
  // 当时叫「卸载中」，Strata 侧后来改成「停止中」——那边连引擎一起停，这边只卸模型）。
  // 判据是「这件事还没落地」：加载等前门报 loaded，卸载等前门报 unloaded。中间态也算进行中——前门把
  // stopping 也报成 loading，只认 loaded 的话卸载途中会掉回 statusOf，显示成「加载中」（用户 m05592）。
  // 一旦状态落地就以前门状态为准：`modelPending` 是前端乐观标记，它的收尾可能比状态轮询晚——提示都
  // 弹了「加载成功」、显存也上去了，卡片仍停在「加载中」，连按钮都被禁用点不动，切一次 Strata 才自愈。
  const pendingVisible =
    isPending &&
    (pendingStop ? model.status !== "unloaded" : model.status !== "loaded");
  const status: StatusBadge = pendingVisible
    ? { cls: "status-loading", icon: "fa-spinner fa-spin", text: pendingStop ? "卸载中" : "加载中" }
    : statusOf(model);
  // hub 的 getModelIcon(architecture)：优先按 GGUF 架构匹配，名字/id 兜底
  const icon = getModelIcon(model.scanned?.architecture, model.name, model.id);
  const hasMtp = /mtp/i.test(model.name) || /mtp/i.test(model.id);

  /** 启动/停止：灰底图标按钮，放在配置按钮左边（原先藏在状态徽标里的那个 ▶ 已去掉，
      徽标只负责显示状态）。
      运行中时加 `is-running` 类 —— 仍是灰底，但图标转红（停止）。 */
  const startStop = (
    <button
      type="button"
      className={`btn-icon soft${active ? " is-running" : ""}${pendingVisible ? " is-pending" : ""}`}
      title={
        isStrata
          ? !strataFile
            ? "找不到这个 Strata 模型的配置文件（刷新一次试试）"
            : active
              ? "停止（停掉引擎进程，显存立即释放）"
              : mutex && running
                ? "启动（显存互斥已开：会先卸掉 llama.cpp 侧已加载的模型）"
                : "启动（先卸掉正在跑的模型，再起这个）"
          : !running
            ? "前门未运行，无法启动"
            : active
              ? "停止"
              : mutex && strataRunning
                ? "启动（显存互斥已开：会先卸掉 Strata 的模型）"
                : "启动"
      }
      disabled={busy || pendingVisible || (isStrata ? !strataFile : !running)}
      onClick={() =>
        void (isStrata
          ? active
            ? stopStrataModel(strataFile ?? "")
            : startStrataModel(strataFile ?? "")
          : active
            ? stopModel(model.section)
            : startModel(model.section))
      }
    >
      <i className={`fas ${pendingVisible ? "fa-spinner fa-spin" : active ? "fa-stop" : "fa-play"}`} />
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

  // 徽标与 hub 新版一致：跟在模型名后面（inline），不再是独立一行。
  // 引擎标识已去掉（用户 m03333 第 1 点）：模型列表按引擎分标签了，llama.cpp 档里
  // 每张卡都再标一遍「llama.cpp」是重复信息。
  // 「未同步」徽标已去掉（用户 m08378 第 2 点）：那是 router 时代「先点同步才能启动」
  // 的痕迹，现在点启用会自动补配置文件，不再需要这个提示。
  const badges = (
    <span className="mc-badges">
      {model.hasMmproj && <span>视觉</span>}
      {hasMtp && <span>MTP</span>}
    </span>
  );
  const hasBadges = model.hasMmproj || hasMtp;

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
const DEFAULT_PINS: { key: Pinned; label: string }[] = [
  { key: "active", label: "运行中优先" },
  { key: "favourite", label: "收藏优先" },
];

function SortMenu<T extends string>({
  sortKey,
  labels,
  pinned,
  pins = DEFAULT_PINS,
  onSort,
  onPin,
}: {
  sortKey: T;
  /** 这一档可选的排序方式（模型列表按名称/大小，Strata 按名称/上下文长度） */
  labels: Record<T, string>;
  pinned: Pinned;
  /** 可叠加的置顶项；Strata 那档没有收藏，只给「运行中优先」 */
  pins?: { key: Pinned; label: string }[];
  onSort: (key: T) => void;
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
        className={`btn btn-secondary no-shrink nowrap ${open ? "active" : ""}`}
        title="排序方式"
        onClick={() => setOpen((v) => !v)}
      >
        <i className="fas fa-arrow-down-wide-short" />
        <span>{labels[sortKey]}</span>
        <i className={`fas fa-chevron-${open ? "up" : "down"} sort-chevron`} />
      </button>
      {open && (
        <div className="dropdown-menu">
          {(Object.keys(labels) as T[]).map((key) => (
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
              <span>{labels[key]}</span>
            </button>
          ))}
          {/* 横杠：上面是互斥的排序方式，下面是可以**叠加**在排序之上的置顶项。
              置顶项之间互斥（选一个会取消另一个），都用同一个 ✓ 标记。 */}
          <div className="dropdown-sep" />
          {pins.map((pin) => (
            <button
              type="button"
              key={pin.key}
              className="dropdown-item"
              onClick={() => onPin(pinned === pin.key ? "none" : pin.key)}
            >
              <i className={pinned === pin.key ? "fas fa-check" : ""} />
              <span>{pin.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ModelListPanel() {
  const scanned = useApp((s) => s.scanned);
  const routerModels = useApp((s) => s.routerModels);
  const strataEntries = useApp((s) => s.strataEntries);
  // 原生 config 清单（第三刀：不再解析 presets.ini 文本）
  const configs = useApp((s) => s.configs);
  const settings = useApp((s) => s.settings);
  // Strata 那档的标题统计要用引擎状态（用户 m02992 第 1 点）
  const strataStatus = useApp((s) => s.strataStatus);
  const busy = useApp((s) => s.busy);
  const refreshModels = useApp((s) => s.refreshModels);
  // Strata 那档的刷新按钮重扫 strata-*.json（用户 m03160 第 1 点：两档共用一条工具行）
  const refreshStrata = useApp((s) => s.refreshStrata);

  const [query, setQuery] = useState("");
  // 筛选与排序各记一份（用户 m03333 第 6 点：切档回来还是上次选的那档）
  const [filter, setFilter] = useState<Filter>(() => {
    const saved = localStorage.getItem("modelFilter");
    return saved === "all" || saved === "loaded" || saved === "favourite" || saved === "missing"
      ? saved
      : "all";
  });
  const [sortKey, setSortKey] = useState<SortKey>(() => {
    const saved = localStorage.getItem("modelSort");
    return saved === "name_asc" || saved === "name_desc" || saved === "size_asc" || saved === "size_desc"
      ? saved
      : "name_asc";
  });
  // 置顶项是叠在排序之上的开关（不是排序的一种），单独记一个偏好。
  // 兼容旧键 modelRunningFirst（那时只有"运行中优先"）。
  const [pinned, setPinned] = useState<Pinned>(() => {
    const saved = localStorage.getItem("modelPinned");
    if (saved === "active" || saved === "favourite") return saved;
    return localStorage.getItem("modelRunningFirst") === "0" ? "none" : "active";
  });
  // hub 的默认视图是列表；这里默认卡片，和用户当前在 hub 里看到的保持一致
  const [grid, setGrid] = useState(() => localStorage.getItem("modelView") !== "list");
  // 通道标签的记忆：没有「全部」这一档了（用户 m02992 第 1 点），默认落在 llama.cpp
  const [channel, setChannel] = useState<ChannelTab>(() => {
    const saved = localStorage.getItem("modelChannel");
    return saved === "strata" ? "strata" : "llamacpp";
  });
  // Strata 那档的筛选/排序各记一份 —— 值域和模型列表不同（引擎侧 config 没有收藏、
  // 排序按上下文长度）；搜索词、刷新按钮、视图切换是两档共用的（用户 m03160 第 1 点）。
  const [strataFilter, setStrataFilter] = useState<StrataFilter>(() => {
    const saved = localStorage.getItem("strataFilter") as StrataFilter | null;
    return saved && STRATA_FILTERS.includes(saved) ? saved : "all";
  });
  const [configId, setConfigId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("modelView", grid ? "grid" : "list");
  }, [grid]);
  useEffect(() => {
    localStorage.setItem("modelChannel", channel);
  }, [channel]);
  useEffect(() => {
    localStorage.setItem("modelPinned", pinned);
    localStorage.setItem("modelRunningFirst", pinned === "active" ? "1" : "0");
  }, [pinned]);
  useEffect(() => {
    localStorage.setItem("modelFilter", filter);
  }, [filter]);
  useEffect(() => {
    localStorage.setItem("modelSort", sortKey);
  }, [sortKey]);
  useEffect(() => {
    localStorage.setItem("strataFilter", strataFilter);
  }, [strataFilter]);

  const sections = useMemo(() => new Set(configs.map((c) => c.name)), [configs]);

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
        strataEntries,
      ),
    [scanned, routerModels, settings?.favourites, sections, settings?.aliases, strataEntries],
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

  // 通道过滤（用户 m02352 第 1 点）：`channel` 是前门给的字段；本地扫描出来的项没有它，
  // 按 llama.cpp 算 —— 没有通道标记的就是 llama.cpp 子实例。
  const channelShown = useMemo(
    () => shown.filter((m) => (m.channel ?? "llamacpp") === channel),
    [shown, channel],
  );

  // 标题后的统计跟着当前标签走（用户 m02992 第 1 点）。Strata 那档画的是引擎侧 config
  // （strataEntries，本地扫描出来的，不看前门），数字也从它数，免得和标签下的内容对不上。
  const channelTotal = channel === "strata" ? strataEntries.length : channelShown.length;
  const channelLoaded =
    channel === "strata"
      ? strataStatus.running && strataStatus.loaded
        ? 1
        : 0
      : channelShown.filter((m) => m.status === "loaded").length;
  const configModel = merged.find((m) => m.id === configId) ?? null;
  const detailModel = merged.find((m) => m.id === detailId) ?? null;

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>模型</span> <span className="model-count-badge">{channelLoaded}/{channelTotal}</span>
        </h1>
        <div className="st-tabs" role="tablist" aria-label="引擎通道">
          {(Object.keys(CHANNEL_LABELS) as ChannelTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={channel === key}
              className={`st-tab${channel === key ? " is-active" : ""}`}
              onClick={() => setChannel(key)}
            >
              {CHANNEL_LABELS[key]}
            </button>
          ))}
        </div>
        {/* 一条工具行两档共用（用户 m03160 第 1 点）：搜索词、刷新、视图切换两档都管用；
            排序与筛选按通道换值域 —— Strata 那档排的是引擎侧 config（没有收藏、按上下文长度），
            刷新按钮改成重扫 strata-*.json；preset 下拉是 llama.cpp 侧的事，只在那一档显示。 */}
        <div className="top-actions">
          <div className="search-box search-box--fixed">
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
            className="btn btn-secondary no-shrink"
            title={
              channel === "strata"
                ? "重新扫描 strata-*.json（上游升级后点这个）"
                : "刷新模型（重新扫描磁盘）"
            }
            disabled={busy}
            onClick={() => void (channel === "strata" ? refreshStrata() : refreshModels(true))}
          >
            <i className={`fas fa-sync-alt ${busy ? "fa-spin" : ""}`} />
          </button>
          {/* 排序选项两档统一（用户 m03482 第 5 点）：名称/大小，置顶开关也是同一套 */}
          <SortMenu
            sortKey={sortKey}
            labels={SORT_LABELS}
            pinned={pinned}
            onSort={setSortKey}
            onPin={setPinned}
          />
          <select
            className="form-control filter-select"
            title="筛选"
            value={channel === "strata" ? strataFilter : filter}
            onChange={(e) =>
              channel === "strata"
                ? setStrataFilter(e.target.value as StrataFilter)
                : setFilter(e.target.value as Filter)
            }
          >
            {channel === "strata" ? (
              STRATA_FILTERS.map((key) => (
                <option key={key} value={key}>
                  {STRATA_FILTER_LABELS[key]}
                </option>
              ))
            ) : (
              <>
                <option value="all">全部模型</option>
                <option value="loaded">运行中</option>
                <option value="favourite">收藏</option>
                {/* 以前只存不显示：localStorage 里记着 missing 时下拉没有对应项，
                    select 显示「全部模型」但列表其实还在按「未建配置」筛（审查发现） */}
                <option value="missing">未建配置</option>
              </>
            )}
          </select>
          <button
            type="button"
            className="btn-icon btn-icon--lg"
            title="切换卡片 / 列表视图"
            onClick={() => setGrid((v) => !v)}
          >
            <i className={`fas ${grid ? "fa-list" : "fa-th-large"}`} />
          </button>
        </div>
      </div>

      {/* Strata 那档直接画 Strata 管理页（用户 m02992 第 2 点）：工具行在上面的顶栏里两档共用，
          这里只画卡片区；代理与探测那两个按钮已按用户 m03160 第 1 点去掉（前门在侧栏管）。 */}
      {channel === "strata" ? (
        <StrataPanel tools={{ query, filter: strataFilter, sortKey, pinned, grid }} />
      ) : (
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
              ) : channelShown.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">
                    <i className="fas fa-filter" />
                  </div>
                  <div className="empty-state-text">没有匹配的模型</div>
                </div>
              ) : (
                channelShown.map((m) => (
                  <ModelCard
                    key={m.id}
                    model={m}
                    grid={grid}
                    onConfigure={openConfig}
                    onDetail={openDetail}
                  />
                ))
              )}
            </div>
          </div>
        </div>
      )}

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
    </main>
  );
}