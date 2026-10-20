/**
 * 监控页。
 *
 * 照搬上游 `E:\Code\strata-manager-main\apps\desktop\src\OfficialMonitoring.tsx`（180 行）
 * 与 `official\app.css:81-120` 的骨架（用户 m05241「监控 UI 原封原样照搬上游」）。
 *
 * 与上游的差异只在数据来源，布局/文案/分区顺序一致：
 * - 引擎指标来自 llama.cpp 的 `/metrics`（Rust 侧已把 Prometheus 文本解析成结构化字段），
 *   运行/排队因此是引擎自报的真值，不再是本地估算。
 * - PCIe 与磁盘两块 llama.cpp 不提供，卡片保留、值显示 `—`（不让版面缺一块）。
 * - 「近期请求」只留最近一次完成的请求（llama.cpp 没有逐请求接口）。
 */
import { Fragment, useMemo } from "react";
import type { MonitorEngine, MonitorSnapshot } from "../types";
import type { RecentTurn } from "../utils/telemetry";
import type { LiveMetric } from "../utils/telemetry";
import { bytesfmt, ctxfmt, fixed1, kfmt, normalizeSlots, sparkPaths } from "../utils/monitor";
import { SlotMonitor } from "./SlotMonitor";

/** 8 张指标卡（顺序同上游）。`max` 是折线封顶值，`tone` 决定折线颜色。 */
interface MetricCard {
  key: string;
  label: string;
  unit: string;
  value: string;
  sub: string;
  values: (number | null)[];
  icon: string;
  /** 第二个大数字（速度卡同时显示「最近生成」与「最近输入处理」）。 */
  alt?: { value: string; label: string };
  /** 速度卡的第二条折线（预填充速度历史），照上游 `history.prefill_tok_s_mean`。 */
  altValues?: (number | null)[];
  max?: number;
  tone?: "warn" | "info";
}

/** 取有限数字（`null`/非数字都当没有）。 */
const number2 = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** 千分位；空值 → `—`（上游 fmt 的口径）。 */
const frank = (value: unknown): string =>
  number2(value) === null ? "—" : number2(value)!.toLocaleString("zh-CN");

function Spark({
  values,
  max,
  tone,
  alt,
}: {
  values: (number | null)[];
  max?: number | null;
  /** 速度卡的第二条线（预填充速度历史）。 */
  altValues?: (number | null)[];
  tone?: "warn" | "info";
  /** 速度卡叠第二条线用（上游 `history.prefill_tok_s_mean`，见 OfficialMonitoring.tsx:146）。 */
  alt?: (number | null)[];
}) {
  const main = sparkPaths(values, max);
  const second = alt ? sparkPaths(alt, max) : null;
  if (main.count < 2) {
    return <svg className="st-metric__spark" viewBox="0 0 100 32" aria-hidden="true" />;
  }
  return (
    <svg
      className="st-metric__spark"
      viewBox="0 0 100 32"
      data-tone={tone}
      role="img"
      aria-label="走势"
      preserveAspectRatio="none"
    >
      {/* 照上游 SparkPaths：面积 opacity .12，线 1.6px 圆角且不随缩放变粗 */}
      {main.area && <path className="area" d={main.area} fill="currentColor" opacity={0.12} />}
      {second?.area && (
        <path className="area speed-prefill" d={second.area} fill="currentColor" opacity={0.12} />
      )}
      {main.line && (
        <path
          className="line"
          d={main.line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {second?.line && (
        <path
          className="line speed-prefill"
          d={second.line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
function MetricTile({ card }: { card: MetricCard }) {
  return (
    <div className="st-card metric-card">
      <div className="st-metric">
        <div className="st-metric__label">
          {/* 每张卡左侧一个图标，照上游 st-metric__label 里带 sprite 图标的做法（用户 m05810 第 4 点） */}
          <span className="st-metric__title">
            <i className={`fas ${card.icon}`} aria-hidden="true" />
            {card.label}
          </span>
        </div>
        {/* 上游把单位放在数字右边当小字（67.6 t/s），卡片右上角不放单位 —— 用户 m05986 给的截图 */}
        <div className="st-metric__values">
          <div className="st-metric__num">
            {card.value}
            {card.unit ? <small>{card.unit}</small> : null}
          </div>
          {card.alt && (
            <div className="st-metric__num">
              {card.alt.value}
              {card.unit ? <small>{card.unit}</small> : null}
            </div>
          )}
        </div>
        {card.alt ? (
          <div className="st-metric__sub st-metric__sub--pair">
            <span>{card.sub}</span>
            <span>{card.alt.label}</span>
          </div>
        ) : (
          <div className="st-metric__sub">{card.sub}</div>
        )}
        <Spark values={card.values} max={card.max} tone={card.tone} alt={card.altValues} />
      </div>
    </div>
  );
}


/** 一组数字的平均值（忽略空值）。 */
function meanOf(values: (number | null)[]): number | null {
  const valid = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}
export function MonitoringPage({
  live,
  snapshot,
  engine,
  engineError,
  engineNote,
  recentTurns: allTurns,
  model,
  models,
  onSelectModel,
  gpuName,
  sampledAt,
  speedSeries,
}: {
  live: LiveMetric | null;
  snapshot: MonitorSnapshot | null;
  engine: MonitorEngine | null;
  engineError: string | null;
  /** 引擎指标不可用的原因（不是故障），显示为灰色提示。 */
  engineNote: string | null;
  /** 最近若干次请求（上游 req-card 的表格数据）。 */
  recentTurns: RecentTurn[];
  /** 当前在看的模型；空串表示一个都没在跑。 */
  model: string;
  /** 所有已加载（正在跑）的模型，用户可能同时开了好几个。 */
  models: string[];
  onSelectModel: (name: string) => void;
  gpuName: string | null;
  sampledAt: number;
  /** 前端每秒累积的速度序列（llama.cpp 不报 history，只有 Strata 的 /metrics 有）。 */
  speedSeries: { tokS: (number | null)[]; prefillTokS: (number | null)[] };
}) {
  // 只显示当前模型自己的请求：换模型（或重启模型）后，别的模型的旧记录不该留在表里
  //（用户 m06949「更换模型启动后，监控中的最近请求没有清空」）。
  const recentTurns = useMemo(
    () => allTurns.filter((turn) => !turn.model || turn.model === model),
    [allTurns, model],
  );
  // Strata 的 /metrics 自带 `history.tok_s` / `history.prefill_tok_s_mean`（与上游同一来源）；
  // llama.cpp 不报，用前端每秒累积的 speedSeries 兜底。
  const engineHistory = (() => {
    const metrics = engine?.metrics as Record<string, unknown> | undefined;
    return (metrics?.history as Record<string, unknown> | undefined) ?? null;
  })();
  const numSeries = (key: string): (number | null)[] => {
    const raw = engineHistory?.[key];
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => (typeof item === "number" && Number.isFinite(item) ? item : null));
  };
  const engineTokS = numSeries("tok_s");
  const enginePrefill = numSeries("prefill_tok_s_mean");
  const history = snapshot?.history;
  const series = history?.series ?? {};
  const slots = normalizeSlots(engine?.slots);
  const metrics = engine?.metrics as Record<string, unknown> | null | undefined;
  // 引擎自报的实时状态块（Strata 的 /metrics.live：state/queued/tok_s/generated/max_tokens/
  // prompt_read/prompt_total/prefill_tok_s_mean）。状态卡与速度卡**直接用它的数据**，
  // 不再用 GUI 本地推导 —— 本地推导会把「上次请求的残留」当成当前值（用户 m06736）。
  const rawLive = (metrics?.live ?? null) as Record<string, unknown> | null;
  const deferred = typeof metrics?.requestsDeferred === "number" ? metrics.requestsDeferred : null;
  const kvTokens = typeof metrics?.kvCacheTokens === "number" ? metrics.kvCacheTokens : null;
  // 当前引擎是不是 Strata：它的 /metrics 带 requests 数组与 expert_slots，llama.cpp 的 Prometheus
  // 指标里没有这两样。用来决定「上游有、llama.cpp 没有」的列要不要渲染（用户 m06168）。
  const isStrata = Array.isArray((metrics as Record<string, unknown> | undefined)?.requests);
  // Strata 每个请求带 hit_rate（生成时专家命中显存里的份额）；llama.cpp 没有
  const strataRequests = isStrata
    ? ((metrics as Record<string, unknown>).requests as Record<string, unknown>[])
    : [];
  const rawCache = (metrics as Record<string, unknown> | undefined)?.conversation_cache as
    | Record<string, unknown>
    | undefined;
  // 会话缓存卡照上游 OfficialMonitoring.tsx:109-118 / 168：全部取引擎的 conversation_cache。
  // llama.cpp 的 /metrics 里没有这个键，卡片不渲染。
  const cacheShown = rawCache !== undefined && rawCache !== null && Object.keys(rawCache).length > 0;
  const cacheEnabled = rawCache?.enabled === true;
  const cacheRequests = number2(rawCache?.requests);
  const cacheReusedRequests = number2(rawCache?.requests_reused) ?? 0;
  const cacheReusedTokens = number2(rawCache?.reused_tokens);
  const cachePromptAll = number2(rawCache?.prompt_tokens);
  const cacheShare =
    cacheReusedTokens !== null && cachePromptAll !== null && cachePromptAll > 0
      ? (cacheReusedTokens / cachePromptAll) * 100
      : null;
  const cacheBudgetBytes = (() => {
    const mib = number2(rawCache?.budget_mib);
    return mib === null ? null : mib * 1048576;
  })();
  const cacheBytes = number2(rawCache?.bytes);
  const cacheSlots = number2(rawCache?.slots);
  const cacheParked = number2(rawCache?.parked);
  // 上游 fmt()：整数带千分位、不缩写成 k（用户 m06826 第 1 点）
  const num0 = (value: unknown) => {
    const n = number2(value);
    return n === null ? "–" : n.toLocaleString("zh-CN");
  };
  const cacheAgo = (value: unknown) => {
    const stamp = number2(value);
    if (stamp === null) return "";
    const secs = Math.max(0, Date.now() / 1000 - stamp);
    if (secs < 60) return "刚刚";
    if (secs < 3600) return `${Math.round(secs / 60)} 分钟前`;
    return `${(secs / 3600).toFixed(1)} 小时前`;
  };
  const cacheEvent =
    typeof rawCache?.last_event === "string"
      ? `${rawCache.last_event === "parked" ? "停放" : "恢复"} ${num0(number2(rawCache?.last_tokens))} tokens，${cacheAgo(rawCache?.last_at)}`
      : null;
  const cacheFacts: [string, string | null][] = [
    [
      "最近请求",
      number2(rawCache?.last_prompt) === null
        ? null
        : `${num0(number2(rawCache?.last_reused))} 复用 / 提示词 ${num0(number2(rawCache?.last_prompt))} 提示词 tokens 已复用`,
    ],
    [
      "启动以来复用",
      cacheRequests !== null && cacheRequests > 0
        ? `${num0(cacheReusedTokens)} tokens${cacheShare === null ? "" : `（${cacheShare.toFixed(0)}% 占全部提示词 tokens）`}`
        : null,
    ],
    [
      "停放 / 恢复",
      cacheEnabled
        ? `${num0(number2(rawCache?.parks))} / ${num0(number2(rawCache?.restores))}${
            (number2(rawCache?.evictions) ?? 0) > 0 ? ` · ${num0(number2(rawCache?.evictions))} 已淘汰` : ""
          }`
        : null,
    ],
    ["最近切换", cacheEnabled ? cacheEvent : null],
  ];
  const hitRateOf = (at: number): number | null => {
    if (strataRequests.length === 0) return null;
    const secs = at / 1000;
    let best: Record<string, unknown> | null = null;
    let gap = Number.POSITIVE_INFINITY;
    for (const item of strataRequests) {
      const time = typeof item.time === "number" ? item.time : null;
      if (time === null) continue;
      const delta = Math.abs(time - secs);
      if (delta < gap) {
        gap = delta;
        best = item;
      }
    }
    const hit = best && typeof best.hit_rate === "number" ? best.hit_rate : null;
    return hit === null ? null : hit * 100;
  };
  // 上游同一列还会追加「+1.3% PCIe」：经 PCIe 读或其它卡算的路由专家份额（request.pcie_share）
  const pcieShareOf = (at: number): number | null => {
    if (strataRequests.length === 0) return null;
    const secs = at / 1000;
    let gap = Number.POSITIVE_INFINITY;
    let share: number | null = null;
    for (const item of strataRequests) {
      const time = typeof item.time === "number" ? item.time : null;
      if (time === null) continue;
      const delta = Math.abs(time - secs);
      if (delta < gap) {
        gap = delta;
        share = typeof item.pcie_share === "number" ? item.pcie_share : null;
      }
    }
    return share;
  };
  // Strata 的 /metrics 会带 engine.expert_slots（MoE 已缓存专家数），llama.cpp 没有
  // 上游 is `eng.expert_slots`（raw.engine 下的对象），不是根级 —— 之前读错层级所以一直空（用户 m06197 第 1 点）
  const engineObj = (metrics as Record<string, unknown> | undefined)?.engine as
    | Record<string, unknown>
    | undefined;
  const expertSlots =
    typeof engineObj?.expert_slots === "number"
      ? (engineObj.expert_slots as number)
      : typeof (metrics as Record<string, unknown> | undefined)?.expert_slots === "number"
        ? ((metrics as Record<string, unknown>).expert_slots as number)
        : null;

  // 引擎自报的状态优先（Strata 的 /metrics.live.state：idle / reading / generating / unloaded）；
  // 没有引擎数据时才用本地活动状态兜底。
  const engineState = typeof rawLive?.state === "string" ? rawLive.state : null;
  const state: LiveMetric["state"] =
    engineState === "reading" || engineState === "generating"
      ? engineState
      : engineState === "idle" || engineState === "unloaded"
        ? "waiting"
        : (live?.state ?? "waiting");
  const queued = number2(rawLive?.queued) ?? deferred ?? live?.queued ?? null;

  const cards = useMemo<MetricCard[]>(() => {
    const mib = 1024 * 1024;
    const gpuMemUsed = series.gpuMemUsed ?? [];
    const gpuMemTotal = snapshot?.static.gpuName ? (snapshot.now.gpu?.memTotalMib ?? null) : null;
    const total = live?.gpuMemoryTotal ?? (gpuMemTotal === null ? null : gpuMemTotal * mib);
    return [
      {
        key: "speed",
        icon: "fa-gauge-high",
        label: "速度",
        unit: "t/s",
        // 数值优先取引擎 /metrics.live（生成中给 tok_s / prefill_tok_s_mean，空闲时上游回 null），
        // 引擎没报才用本地最近一次请求的口径（用户 m06736）。
        value: fixed1(number2(rawLive?.tok_s) ?? live?.decodeTokS),
        sub: "最近生成",
        alt: {
          value: fixed1(number2(rawLive?.prefill_tok_s_mean) ?? live?.prefillTokS),
          label: "最近输入处理",
        },
        // 上游用 engine 的 `history.tok_s`（每秒一点）；本工程由前端每次采样时推一个点（store.speedSeries）
    values: engineTokS.length > 0 ? engineTokS : speedSeries.tokS,
    altValues: enginePrefill.length > 0 ? enginePrefill : speedSeries.prefillTokS,
      },
      {
        key: "gpu",
        icon: "fa-microchip",
        label: "GPU 负载",
        unit: "%",
        value: fixed1(live?.gpuUtil),
        sub: gpuName ?? "无 GPU",
        values: series.gpuUtil ?? [],
        max: 100,
      },
      {
        key: "vram",
        icon: "fa-memory",
        label: "显存",
        // 上游把「/ 12 GB」当成数字右边的小字单位，副标题留给「N 个专家已缓存」
        unit: total == null ? "GB" : `/ ${(total / (1024 * 1024 * 1024)).toFixed(0)} GB`,
        value: live?.gpuMemoryUsed == null ? "—" : (live.gpuMemoryUsed / (1024 * 1024 * 1024)).toFixed(1),
        // llama.cpp 没有 MoE 专家指标，副标题换成 KV 缓存的真实占用
        // 上游这里写「N 个专家已缓存」，那是 MoE 的专家缓存指标：Strata 引擎会报，llama.cpp 不报。
        // 所以有值就显示，没值就留空 —— 不拿 KV 缓存去顶这个位置（用户 m06061 第 3 点）。
        sub: expertSlots == null ? "" : `${expertSlots.toLocaleString("zh-CN")} 个专家已缓存`,
        values: gpuMemUsed.map((value) => (value == null ? null : value / 1024)),
        max: total == null ? undefined : total / (1024 * 1024 * 1024),
      },
      {
        key: "temp",
        icon: "fa-temperature-half",
        label: "GPU 温度",
        unit: "°C",
        value: fixed1(live?.gpuTemperature),
        sub: live?.gpuTemperature != null && live.gpuTemperature >= 80 ? "接近降频" : "正常",
        values: series.gpuTemp ?? [],
        max: 90,
        tone: "warn",
      },
      {
        key: "power",
        icon: "fa-bolt",
        label: "功耗",
        unit: "W",
        value: fixed1(live?.gpuPower),
        sub: snapshot?.now.gpu?.powerLimitW == null ? "—" : `上限 ${fixed1(snapshot.now.gpu.powerLimitW)} W`,
        values: series.gpuPower ?? [],
        max: snapshot?.now.gpu?.powerLimitW ?? undefined,
      },
      {
        // 上游把链路规格（Gen4 x8）当主值，吞吐退成副标题 —— 链路是常量，吞吐一直在跳。
        key: "pcie",
        icon: "fa-network-wired",
        label: "PCIe",
        value: snapshot?.now.gpu?.pcieLinkGen == null ? "—" : `Gen${snapshot.now.gpu.pcieLinkGen}`,
        unit: snapshot?.now.gpu?.pcieLinkWidth == null ? "" : `x${snapshot.now.gpu.pcieLinkWidth}`,
        sub: live?.pcieRx == null ? "读不到链路吞吐" : `传至 GPU ${fixed1(live.pcieRx)} MB/s`,
        values: series.pcieRx ?? [],
        tone: "info",
      },
      {
        key: "cpu",
        icon: "fa-server",
        label: "CPU",
        unit: "%",
        value: fixed1(live?.cpuUtil),
        // 上游副标题是「16 核心 · 32 线程」，两个数都由 Rust 侧一次性问 PowerShell
        sub:
          snapshot?.static.cores != null && snapshot.static.threads != null
            ? `${snapshot.static.cores} 核心 · ${snapshot.static.threads} 线程`
            : snapshot?.static.threads != null
              ? `${snapshot.static.threads} 线程`
              : "",
        values: series.cpu ?? [],
        max: 100,
      },
      {
        key: "disk",
        icon: "fa-hard-drive",
        label: "磁盘读取",
        unit: "MB/s",
        value: fixed1(live?.diskRead),
        sub: live?.diskWrite == null ? "读不到磁盘计数器" : `写入 ${fixed1(live.diskWrite)} MB/s`,
        values: series.diskRead ?? [],
        tone: "info",
      },
    ];
  }, [series, live, snapshot, gpuName, kvTokens, expertSlots, speedSeries]);

  // 近期请求：Strata 直接用 `/metrics` 的 `requests`（引擎自己记的，含别的客户端与已断开的）、
  // llama.cpp 没有逐请求接口，退回 GUI 本地记录（用户 m06469 第 3 点）。
  const FINISH_STATE: Record<string, [string, string]> = {
    stop: ["", "完成"],
    length: ["", "达到 tokens 上限"],
    cancel: ["st-badge--queued", "已停止"],
    disconnect: ["st-badge--queued", "已断开"],
    error: ["st-badge--error", "错误"],
  };
  const requestRows = (() => {
    if (strataRequests.length > 0) {
      return strataRequests.map((item, index) => {
        const time = number2(item.time);
        const prompt = number2(item.prompt_tokens);
        const reused = number2(item.reused);
        const promptMs = number2(item.prompt_ms);
        const read = prompt !== null && reused !== null ? prompt - reused : null;
        const finish = typeof item.finish === "string" ? item.finish : "";
        const [badge, state] = FINISH_STATE[finish] ?? ["", finish || "—"];
        const hit = number2(item.hit_rate);
        const pcie = number2(item.pcie_share);
        const prefillTokS =
          read !== null && promptMs !== null && promptMs > 0 ? read / (promptMs / 1000) : null;
        return {
          key: `${time ?? "t"}-${index}`,
          time,
          badge,
          state,
          prompt: prompt === null ? "—" : prompt.toLocaleString("zh-CN"),
          reused: reused === null ? "—" : reused.toLocaleString("zh-CN"),
          output: frank(item.output_tokens),
          prefill: prefillTokS === null ? "—" : `${fixed1(prefillTokS)} tok/s`,
          decode:
            number2(item.decode_tok_s) === null ? "—" : `${fixed1(number2(item.decode_tok_s)!)} tok/s`,
          hit: hit === null ? "—" : `${(hit * 100).toFixed(1)}%`,
          pcie: pcie !== null && pcie > 0 ? ` +${(pcie * 100).toFixed(1)}% PCIe` : "",
          duration:
            number2(item.duration_s) === null ? "—" : `${fixed1(number2(item.duration_s)!)} s`,
        };
      });
    }
    return recentTurns.map((turn) => ({
      key: turn.id,
      time: turn.at / 1000,
      badge: turn.ok ? "st-badge--ok" : "st-badge--error",
      state: turn.ok ? "完成" : "失败",
      prompt: turn.promptTokens === null ? "—" : turn.promptTokens.toLocaleString("zh-CN"),
      reused: turn.cacheTokens == null ? "—" : turn.cacheTokens.toLocaleString("zh-CN"),
      output: frank(turn.outputTokens),
      prefill: turn.prefillTokS == null ? "—" : `${fixed1(turn.prefillTokS)} tok/s`,
      decode: turn.decodeTokS == null ? "—" : `${fixed1(turn.decodeTokS)} tok/s`,
      hit: hitRateOf(turn.at) == null ? "—" : `${hitRateOf(turn.at)!.toFixed(1)}%`,
      pcie:
        pcieShareOf(turn.at) != null && pcieShareOf(turn.at)! > 0
          ? ` +${(pcieShareOf(turn.at)! * 100).toFixed(1)}% PCIe`
          : "",
      duration: turn.elapsedMs == null ? "—" : `${(turn.elapsedMs / 1000).toFixed(1)} s`,
    }));
  })();
  const newestAt = requestRows[0]?.time ?? null;
  // 底部汇总照上游（OfficialMonitoring.tsx:118-126）：优先 `/metrics` 的 totals，没有就用本地累计
  const totalText = (() => {
    const totals = (metrics?.totals as Record<string, unknown> | undefined) ?? null;
    const requestsTotal = number2(totals?.requests);
    if (totals && requestsTotal !== null && requestsTotal > 0) {
      const sinceAt = number2(totals.since);
      const promptTotal = number2(totals.prompt_tokens);
      const reused = number2(totals.reused);
      const read = promptTotal !== null && reused !== null ? promptTotal - reused : null;
      const promptMs = number2(totals.prompt_ms);
      const decodeMs = number2(totals.decode_ms);
      const output = number2(totals.output_tokens);
      const time = sinceAt === null ? "—" : new Date(sinceAt * 1000).toLocaleString("zh-CN", { weekday: "short", hour: "2-digit", minute: "2-digit" });
      const pSpeed = promptMs !== null && promptMs > 0 && read !== null && read > 0 ? ` 速度 ${fixed1(read / (promptMs / 1000))} tok/s` : "";
      const oSpeed = decodeMs !== null && decodeMs > 0 && output !== null && output > 0 ? ` 速度 ${fixed1(output / (decodeMs / 1000))} tok/s` : "";
      return `自 ${time}: ${requestsTotal.toLocaleString("zh-CN")} 个请求 · ${frank(read)} 提示词 tokens 已读取${pSpeed} (${frank(reused)} 已复用) · ${frank(output)} 已输出${oSpeed}`;
    }
    if (recentTurns.length === 0) return "还没有请求。";
    const totalPrompt = recentTurns.reduce((sum, turn) => sum + (turn.promptTokens ?? 0), 0);
    const totalOutput = recentTurns.reduce((sum, turn) => sum + (turn.outputTokens ?? 0), 0);
    const cache = recentTurns.reduce((sum, turn) => sum + (turn.cacheTokens ?? 0), 0);
    return `自 ${new Date(recentTurns[recentTurns.length - 1].at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}：${recentTurns.length} 个请求 · ${frank(totalPrompt)} 提示词 tokens · 平均输入处理 ${fixed1(meanOf(recentTurns.map((turn) => turn.prefillTokS)))} tok/s · ${frank(totalOutput)} 已输出 速度 ${fixed1(meanOf(recentTurns.map((turn) => turn.decodeTokS)))} tok/s${cache > 0 ? ` · ${frank(cache)} 提示词 tokens 复用` : ""}`;
  })();
  // 状态行文案与进度条都照上游 OfficialMonitoring.tsx:73-84 / 137-138：
  // 读取中看 prompt_read/prompt_total，生成中看 generated/max_tokens。
  // 生成中的状态词再按 live.phase 细分（用户 m06864「生成回答、思考、调用XX工具」）：
  //   Strata 的 server.py:4147-4153 写的是 thinking / answering / "writing a tool call: <名字>"，
  //   上游所连的引擎写的是 reasoning / content，两套都认，认不出就原样显示。
  const phase = typeof rawLive?.phase === "string" && rawLive.phase ? rawLive.phase : null;
  const phaseLabel = (() => {
    if (!phase) return null;
    const fixed: Record<string, string> = {
      reasoning: "思考",
      thinking: "思考",
      content: "生成回答",
      answering: "生成回答",
      "reading the prompt": "读取提示词",
      "saving the session": "保存会话",
      "tool call complete": "工具调用完成",
    };
    if (fixed[phase]) return fixed[phase];
    const toolPrefix = "writing a tool call: ";
    if (phase.startsWith(toolPrefix)) return `调用 ${phase.slice(toolPrefix.length)} 工具`;
    return phase;
  })();
  const stateLabel =
    state === "reading"
      ? "处理输入"
      : state === "generating"
        ? (phaseLabel ?? "生成回答")
        : "等待请求";
  const lastRequest = strataRequests[0] ?? null;
  const readTokens = number2(rawLive?.prompt_read);
  const totalTokens = number2(rawLive?.prompt_total);
  const generatedTokens = number2(rawLive?.generated);
  const maxTokens = number2(rawLive?.max_tokens);
  const stateDetail = (() => {
    if (state === "reading") {
      if (readTokens !== null && totalTokens !== null && totalTokens > 0) {
        return `${num0(readTokens)} / ${num0(totalTokens)} tokens · ${((readTokens / totalTokens) * 100).toFixed(0)}%`;
      }
      const tokens = number2(rawLive?.prompt_tokens) ?? live?.promptTokens ?? null;
      return tokens === null ? "" : `${num0(tokens)} tokens`;
    }
    if (state === "generating") {
      const generated = generatedTokens ?? live?.outputTokens ?? null;
      const speed = number2(rawLive?.tok_s) ?? live?.decodeTokS ?? null;
      return `${generated === null ? "—" : num0(generated)} tokens${speed === null ? "" : ` · ${fixed1(speed)} tok/s`}`;
    }
    if (lastRequest) {
      const out = number2(lastRequest.output_tokens);
      const speed = number2(lastRequest.decode_tok_s);
      return `最近：${out === null ? "—" : num0(out)} tokens${speed === null ? "" : ` 速度 ${fixed1(speed)} tok/s`}`;
    }
    return "";
  })();
  const statePercent = (() => {
    if (state === "reading" && readTokens !== null && totalTokens !== null && totalTokens > 0) {
      return Math.min(100, (readTokens / totalTokens) * 100);
    }
    if (state === "generating" && generatedTokens !== null && maxTokens !== null && maxTokens > 0) {
      return Math.min(100, (generatedTokens / maxTokens) * 100);
    }
    return 0;
  })();
  const cacheTokens = recentTurns.reduce((sum, turn) => sum + (turn.cacheTokens ?? 0), 0);
  // 会话缓存卡的占比分母（本地累计的提示词 token）
  const promptTokensSeen = recentTurns.reduce((sum, turn) => sum + (turn.promptTokens ?? 0), 0);

  // 上下文占用照上游：prompt_read/prompt_total（读取中）或 generated/max_tokens（生成中），
  // 空闲时用引擎的 prompt_tokens / max_context。优先引擎自报，缺了再用本地兜底。
  const rawUsed =
    number2(rawLive?.prompt_read) ?? number2(rawLive?.prompt_tokens) ?? live?.promptTokens ?? null;
  const rawMax = number2(rawLive?.max_tokens) ?? live?.maxContext ?? null;
  const usedContext = rawUsed ?? 0;
  const maxContext = rawMax;
  const contextPct = maxContext && maxContext > 0 ? Math.min(100, (usedContext / maxContext) * 100) : 0;
  const mibBytes = 1024 * 1024;
  const gpuUsedBytes = snapshot?.now.gpu?.memUsedMib;
  const gpuTotalBytes = snapshot?.now.gpu?.memTotalMib;
  const gpuUsed = gpuUsedBytes == null ? null : gpuUsedBytes * mibBytes;
  const gpuTotal = gpuTotalBytes == null ? null : gpuTotalBytes * mibBytes;
  const vramPct = gpuUsed && gpuTotal ? Math.min(100, (gpuUsed / gpuTotal) * 100) : 0;
  const gpuTemp = snapshot?.now.gpu?.temperature ?? null;
  const ramPct =
    snapshot?.now.memTotal && snapshot.now.memTotal > 0
      ? ((snapshot.now.memUsed ?? 0) / snapshot.now.memTotal) * 100
      : 0;

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">监控</h1>
        <div className="top-actions">
          {models.length > 1 && (
            <select
              className="st-input monitor-model"
              value={model}
              onChange={(event) => onSelectModel(event.target.value)}
              title="监控目标：只列出正在运行的模型"
            >
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {models.length === 1 && <span className="st-badge st-badge--ok">{model}</span>}
          <span className="st-hint">
            {model ? `采样 ${new Date(sampledAt).toLocaleTimeString("zh-CN")}` : "还没有运行中的模型"}
          </span>
        </div>
      </div>

      <div className="page-fill page-fill--scroll">
        <div className="monitor">
          <section className="st-card state-card">
            {/* 采样时间行照上游 OfficialMonitoring.tsx:134（`subtle` / 过期时 `notice warning`） */}
            <p className={engineError ? "notice warning" : "subtle"} role="status">
              {sampledAt
                ? `上次成功采样：${new Date(sampledAt).toLocaleString("zh-CN")}`
                : "尚无成功采样时间"}
              {engineError ? ` · 下方数值为上次采样，不能代表当前实时状态。` : ""}
            </p>
            <div className="state-card__head">
              <span className="card-title">模型状态</span>
              <div className="badges">
                <span className={`st-badge ${state === "idle" ? "on" : ""}`}>空闲</span>
                <span className={`st-badge st-badge--reading ${state === "reading" ? "on" : ""}`}>读取中</span>
                <span className={`st-badge st-badge--generating ${state === "generating" ? "on" : ""}`}>生成中</span>
                <span className={`st-badge st-badge--queued ${state === "queued" ? "on" : ""}`}>排队中</span>
                <span className={`st-badge st-badge--error ${engineError ? "on" : ""}`}>错误</span>
              </div>
            </div>
            {/* 状态行照上游 OfficialMonitoring.tsx:73-84 / 137：左边一句状态词，右边灰色详情 */}
            <div className="state-card__row">
              <span>{stateLabel}</span>
              <span className="muted">{stateDetail}</span>
            </div>
            <div className="st-progress" data-tone={state === "reading" ? "info" : undefined}>
              <div className="st-progress__bar" style={{ width: `${statePercent}%` }} />
            </div>
            {engineNote && <p className="st-hint">{engineNote}</p>}
            {engineError && <p className="st-hint">{engineError}</p>}
          </section>

          <SlotMonitor slots={slots} parallel={slots.length} queued={queued ?? 0} />

          <div className="metrics">
            {cards.map((card) => (
              <MetricTile key={card.key} card={card} />
            ))}
          </div>

          <div className="monitor-row">
            <section className="st-card ctx-card">
              <h3 className="st-card__title">上下文占用</h3>
              <div className="ctx-gauge">
                <svg className="st-gauge" viewBox="0 0 120 120" role="img" aria-label="上下文占用">
                  <circle cx="60" cy="60" r="50" fill="none" stroke="var(--st-line)" strokeWidth="10" />
                  <circle
                    className="st-gauge__fill"
                    cx="60"
                    cy="60"
                    r="50"
                    fill="none"
                    stroke="var(--st-accent)"
                    strokeWidth="10"
                    strokeLinecap="round"
                    strokeDasharray={`${(235.6 * contextPct) / 100} 314.2`}
                    transform="rotate(135 60 60)"
                    opacity={contextPct < 3 ? 0 : 1}
                  />
                </svg>
                <div className="ctx-gauge__label">
                  <div className="ctx-gauge__pct">{Math.round(contextPct)}%</div>
                  <div>
                    {kfmt(usedContext)} / {ctxfmt(maxContext)}
                  </div>
                </div>
              </div>
              {/* 三条 bar 照上游 ctx-card：显存 / 系统内存 / GPU 温度（上游第一条是「显存中的专家」，
                  llama.cpp 没有 MoE 专家驻留指标，用它最接近的「GPU 显存」顶替）。
                  内存 > 92% 转 danger、温度 > 80°C 转 warn —— 上游同口径。 */}
              <div className="bar-row">
                <span>GPU 显存</span>
                <span>
                  {bytesfmt(gpuUsed)} / {bytesfmt(gpuTotal)}
                </span>
              </div>
              <progress
                className="st-progress"
                data-tone={vramPct > 92 ? "danger" : undefined}
                value={vramPct}
                max={100}
              />
              <div className="bar-row">
                <span>系统内存</span>
                <span>
                  {bytesfmt(snapshot?.now.memUsed)} / {bytesfmt(snapshot?.now.memTotal)}
                </span>
              </div>
              <progress
                className="st-progress"
                data-tone={ramPct > 92 ? "danger" : undefined}
                value={ramPct}
                max={100}
              />
              <div className="bar-row">
                <span>GPU 温度</span>
                <span>{gpuTemp == null ? "—" : `${gpuTemp} °C`}</span>
              </div>
              <progress
                className="st-progress"
                data-tone={gpuTemp != null && gpuTemp > 80 ? "warn" : undefined}
                value={gpuTemp ?? 0}
                max={100}
              />
            </section>

            <section className="st-card req-card">
              <div className="req-head">
                <h3 className="st-card__title">最近请求</h3>
                <span className="st-hint">
                  {newestAt == null ? "" : new Date(newestAt * 1000).toLocaleTimeString("zh-CN")}
                </span>
              </div>
              {requestRows.length === 0 ? (
                <p className="st-hint">
                  还没有完成的请求。llama.cpp 没有逐请求接口，这张表由 GUI 自己记录，发起一次对话后就会出现。
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="st-table st-table--nowrap">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th>状态</th>
                        <th>提示词</th>
                        <th>复用</th>
                        <th>输出</th>
                        <th>输入处理 T/S</th>
                        <th>生成 T/S</th>
                        {isStrata && (
                          <th className="num" data-tooltip="生成回答时，查找的专家中已在显存内的份额。">
                            显存命中率
                          </th>
                        )}
                        <th>耗时</th>
                      </tr>
                    </thead>
                    <tbody>
                      {requestRows.map((row) => (
                        <tr key={row.key}>
                          <td>
                            {row.time == null
                              ? "—"
                              : new Date(row.time * 1000).toLocaleTimeString("zh-CN")}
                          </td>
                          <td>
                            <span className={`st-badge ${row.badge}`}>
                              <span className="req-state-dot" aria-hidden="true" />
                              {row.state}
                            </span>
                          </td>
                          <td>{row.prompt}</td>
                          <td>{row.reused}</td>
                          <td>{row.output}</td>
                          <td>{row.prefill}</td>
                          <td>{row.decode}</td>
                          {isStrata && (
                            <td>
                              {row.hit}
                              {row.pcie}
                            </td>
                          )}
                          <td>{row.duration}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {/* 底部汇总照上游那句：自什么时间、几个请求、多少提示词/输出 token 与两侧速度（数据取 /metrics 的 totals） */}
              <p className="st-hint">{totalText}</p>
            </section>
          </div>

          {/* 会话缓存：整块照上游 OfficialMonitoring.tsx:168 —— 数据全部取引擎的
              conversation_cache（没有这个键就整张卡不渲染）。llama.cpp 的 /metrics 里没有
              这个对象，只有当 cache_n > 0 时才退化成展示前缀复用。 */}
          {(cacheShown || cacheTokens > 0) && (
            <section className="st-card cc-card">
              <div className="req-head">
                <span className="card-title">会话缓存</span>
                <span className="muted small">
                  {cacheRequests !== null && cacheRequests > 0
                    ? `${num0(cacheReusedRequests)} 个请求 / ${num0(cacheRequests)} 个请求复用了部分提示词`
                    : ""}
                </span>
              </div>
              {cacheEnabled && (
                <div className="cc-bars">
                  <div>
                    <div className="bar-row">
                      <span>停放会话</span>
                      <span className="muted">
                        {num0(cacheParked)} / {num0(cacheSlots)}
                      </span>
                    </div>
                    <div className="st-progress">
                      <div
                        className="st-progress__bar"
                        style={{
                          width: `${cacheSlots && cacheParked !== null ? Math.min(100, (cacheParked / cacheSlots) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div>
                    <div className="bar-row">
                      <span>会话内存（RAM）</span>
                      <span className="muted">
                        {cacheBytes === null ? "—" : `${(cacheBytes / 1073741824).toFixed(1)} GB`} /{" "}
                        {cacheBudgetBytes === null ? "—" : `${(cacheBudgetBytes / 1073741824).toFixed(1)} GB`}
                      </span>
                    </div>
                    <div className="st-progress">
                      <div
                        className="st-progress__bar"
                        style={{
                          width: `${cacheBudgetBytes && cacheBytes !== null ? Math.min(100, (cacheBytes / cacheBudgetBytes) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
              <dl className="facts">
                {cacheFacts
                  .filter(([, value]) => value !== null)
                  .map(([title, value]) => (
                    <Fragment key={title}>
                      <dt>{title}</dt>
                      <dd>{value}</dd>
                    </Fragment>
                  ))}
                {!cacheShown && (
                  <>
                    <dt>最近请求</dt>
                    <dd>{`${num0(recentTurns[0]?.cacheTokens ?? null)} 复用 / 提示词 ${num0(recentTurns[0]?.promptTokens ?? null)} tokens`}</dd>
                    <dt>启动以来复用</dt>
                    <dd>
                      {num0(cacheTokens)} tokens
                      {promptTokensSeen > 0
                        ? `（${((cacheTokens / promptTokensSeen) * 100).toFixed(0)}% 占全部提示词 tokens）`
                        : ""}
                    </dd>
                  </>
                )}
              </dl>
              <p className="muted small cc-note">
                {cacheEnabled
                  ? "继续停放会话的请求会恢复其状态，不再重新读取；槽位或内存满时移除最早的会话。"
                  : "引擎保留最近会话的状态，后续请求只读取新增内容。要保留多个会话（Agent 交替使用），请在运行配置的 args 中加入 \"--conversation-cache-mib\", \"8192\"。"}
              </p>
            </section>
          )}        </div>
      </div>
    </main>
  );
}