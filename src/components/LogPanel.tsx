import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { portFromArgs } from "../api/router";
import { ipc } from "../ipc";
import { useApp } from "../store";
import type { LogFileInfo, LogLine, RouterModel } from "../types";
import { reportFrontendError } from "../utils/frontendLog";
import { fmtClock, logLevelOf } from "../utils/logView";

/**
 * 系统日志页 —— 版式照搬上游 strata-manager「任务与日志」页的服务日志卡片
 * （`apps/desktop/src/App.tsx` 的 TasksPage）：等宽小字号、可滚动的日志区，
 * 每行是「时间 / 级别 / 内容」三列。
 *
 * 与上游的差异：
 * - 上游的「日志来源」下拉框换成页面顶部的一排标签（用户 m00001）；
 * - 搜索框从卡片头部移到页面工具栏（用户 m00001）；
 * - 上游有结构化的 `level` 字段，我们的日志是纯文本流，级别由 `logLevelOf` 按关键字推断。
 */

/** 一块日志的行数：10000 行上限时约 50 块，新行只会让最后一块重新渲染 */
const LOG_CHUNK = 200;

/**
 * 一块日志（最多 LOG_CHUNK 行）。
 *
 * memo + 数组引用：已封口的块引用不变就跳过重渲染。整份 10000 行逐行渲染会让每批
 * 新行都重排全部 DOM 节点；按块切分后，一次推送只重建最后那 200 行。
 */
const LogChunk = memo(function LogChunk({ lines }: { lines: LogLine[] }) {
  return (
    <>
      {lines.map((line) => {
        const level = logLevelOf(line.text);
        return (
          <div className="log-line" key={line.seq}>
            <time>{fmtClock(line.ts_ms)}</time>
            <span className={`log-level ${level}`}>{level.toUpperCase()}</span>
            <span className="log-msg">{line.text.replace(/\r?\n$/, "")}</span>
          </div>
        );
      })}
    </>
  );
});

interface SourceItem {
  filter: string;
  name: string;
  /** 固定项（系统 / Strata / 前端 / 历史模型）：不显示"未加载" */
  fixed?: boolean;
  /** 模型是否在运行（决定绿点与"未加载"提示） */
  loaded?: boolean;
}

export function LogPanel() {
  const logs = useApp((s) => s.logs);
  const filter = useApp((s) => s.logFilter);
  const setFilter = useApp((s) => s.setLogFilter);
  const clearLogs = useApp((s) => s.clearLogs);
  const routerModels = useApp((s) => s.routerModels);
  const strataStatus = useApp((s) => s.strataStatus);

  // 这一轮的日志文件落在哪：挂载时问后端一次。文件名在程序启动时就定下了，运行期不会换。
  // 排查时用户要把文件发出来，所以路径要能看见、目录要能一键打开（用户 m05885）。
  const [logInfo, setLogInfo] = useState<LogFileInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void ipc
      .logsInfo()
      .then((info) => {
        if (alive) setLogInfo(info);
      })
      .catch(() => {
        /* 拿不到就不显示路径，不影响日志页本身 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const openLogDir = async () => {
    try {
      await ipc.logsOpenDir();
    } catch (err) {
      reportFrontendError("warn", `打开日志目录失败：${String(err)}`);
    }
  };

  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  /** 搜索词（工具栏内，只匹配正文；日志来源由下方标签切换） */
  const [query, setQuery] = useState("");

  /** 端口 → 正在该端口上的模型（router 时代的来源格式 `model:<端口>` 用） */
  const runningByPort = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of routerModels) {
      const port = r.port ?? portFromArgs(r.status?.args);
      if (port != null) map.set(String(port), r.id);
    }
    return map;
  }, [routerModels]);

  /**
   * 模型名 → 模型（前门时代的来源格式 `model:<模型名>` 用）。
   *
   * 前门的日志来源是调度器给的 `model:{模型名}`（`scheduler.rs`），router 时代是
   * `model:{端口}`。两种都得认：先按端口反查，查不到就当成模型名。之前只按端口处理，
   * 模型名被当成端口号，来源列表里显示成「端口 OpenBMB/Sharp-MiniCPM5-2B-Q6_K_XL
   * （未加载）」（用户 m02105 报的）。
   */
  const runningById = useMemo(() => {
    const map = new Map<string, RouterModel>();
    for (const r of routerModels) map.set(r.id, r);
    return map;
  }, [routerModels]);

  /** 日志里出现过的所有来源，顺序固定：系统 / Strata / 前端 / 各模型实例 */
  const items = useMemo<SourceItem[]>(() => {
    const ports = new Set<string>();
    const strataNames = new Set<string>();
    let hasFrontend = false;
    let hasStrata = false;
    for (const line of logs) {
      if (line.source === "frontend") hasFrontend = true;
      else if (line.source === "strata") hasStrata = true;
      else if (line.source.startsWith("strata:")) strataNames.add(line.source.slice(7));
      else if (line.source.startsWith("model:")) ports.add(line.source.slice(6));
    }
    // 来源只来自两处：日志里真实出现过的、以及**当前已加载**的模型。
    // 未加载的模型不再凭空列出来（用户 m02258 第 3 点：没有加载的不要显示）。
    for (const [id, model] of runningById) {
      // Strata 通道的模型按 `strata:<模型名>` 单列（见下面 strataItems），这里不用再补。
      if (model.channel === "strata") continue;
      if ((model.status?.value ?? "unloaded") === "loaded") ports.add(id);
    }
    // 当前引擎加载的模型即使还没吐出日志也要有入口，否则刚启动时点不到它。
    const currentStrata = strataStatus.model_name ?? "";
    if (currentStrata) strataNames.add(currentStrata);

    const list: SourceItem[] = [{ filter: "system", name: "系统", fixed: true }];
    // 裸的 "strata" 只留给引擎之外的 Strata 工具输出（Orca 任务流），模型输出都带模型名。
    if (hasStrata) list.push({ filter: "strata", name: "Strata", fixed: true });
    // Rust 侧 spawn_strata_reader 按 `strata:<模型名>` 标来源（用户 m00545），
    // 换过模型之后每个模型各占一枚标签，历史行也留在各自的模型下。
    const strataItems = [...strataNames].map((name) => ({
      filter: `strata:${name}`,
      name,
      fixed: true,
      loaded: name === currentStrata,
    }));
    strataItems.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name));
    list.push(...strataItems);
    if (hasFrontend) list.push({ filter: "frontend", name: "前端（错误上报）" });

    const modelItems = [...ports].map((key) => {
      const byPort = runningByPort.get(key);
      const model = byPort ? runningById.get(byPort) : runningById.get(key);
      const raw = model?.id ?? byPort ?? key;
      return {
        filter: `model:${key}`,
        // 名字去掉作者前缀（用户 m02258 第 3 点）：`OpenBMB/Sharp-x` → `Sharp-x`
        name: raw.split("/").pop() || raw,
        loaded: (model?.status?.value ?? "unloaded") === "loaded",
      };
    });
    // 已加载的排在前面，和 hub 一致；同组按名字排（前门时代的键是模型名，不是端口号）
    modelItems.sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.name.localeCompare(b.name));
    return list.concat(modelItems);
  }, [logs, runningByPort, runningById, strataStatus.model_name]);

  // 过滤项失效（例如模型卸载后该来源消失）就回落到第一个来源；
  // 「全部日志」这一项已按用户 m09910 去掉，"all" 只留作兜底。
  const active = items.some((i) => i.filter === filter) ? filter : items[0]?.filter ?? "all";
  useEffect(() => {
    if (active !== filter) setFilter(active);
  }, [active, filter, setFilter]);

  /**
   * 来源标签条：标签多了要能左右移动（用户 m00301）。
   *
   * 只在真的溢出时才显示两侧箭头，箭头不可再滚时置灰；`scrollable` 由容器与内容的
   * 实际宽度算出来，所以窗口拉伸、来源增减都会自动跟着变。
   */
  const srcRef = useRef<HTMLDivElement>(null);
  const [srcNav, setSrcNav] = useState({ scrollable: false, atStart: true, atEnd: true });

  const syncSrcNav = useCallback(() => {
    const el = srcRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = {
      scrollable: max > 1,
      atStart: el.scrollLeft <= 1,
      atEnd: el.scrollLeft >= max - 1,
    };
    setSrcNav((prev) =>
      prev.scrollable === next.scrollable && prev.atStart === next.atStart && prev.atEnd === next.atEnd
        ? prev
        : next,
    );
  }, []);

  // 来源增减、窗口尺寸变化都可能改变是否溢出
  useEffect(() => {
    syncSrcNav();
    window.addEventListener("resize", syncSrcNav);
    return () => window.removeEventListener("resize", syncSrcNav);
  }, [syncSrcNav, items.length]);

  // 当前来源被切走（例如模型卸载回落到「系统」）时，把它滚回视野内。
  // 这里只动标签条自己的 scrollLeft：scrollIntoView 会连带滚动整页。
  useEffect(() => {
    const el = srcRef.current;
    const current = el?.querySelector<HTMLElement>(".is-active");
    if (!el || !current) return;
    const box = el.getBoundingClientRect();
    const tab = current.getBoundingClientRect();
    if (tab.left < box.left) el.scrollLeft -= box.left - tab.left + 4;
    else if (tab.right > box.right) el.scrollLeft += tab.right - box.right + 4;
  }, [active]);

  const scrollSources = (dir: number) => {
    const el = srcRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: "smooth" });
  };

  const shown = useMemo(() => {
    const bySource = active === "all" ? logs : logs.filter((l) => l.source === active);
    const q = query.trim().toLowerCase();
    return q ? bySource.filter((l) => l.text.toLowerCase().includes(q)) : bySource;
  }, [logs, active, query]);

  /**
   * 块的缓存。
   *
   * 日志是**尾部追加**的（环形缓冲只在超过上限时从头部淘汰），所以"上一批 shown 是
   * 当前 shown 的前缀"时可以把已封口的块整段复用 —— 复用靠对象引用比较
   * （`shown[i] !== prev[i]`），不做字符串比较。
   * 切换来源、清空、淘汰头部、输入搜索词都会让前缀判定失败，此时整份重算。
   */
  const cacheRef = useRef<{
    lines: LogLine[];
    chunks: LogLine[][];
  }>({ lines: [], chunks: [] });

  const chunks = useMemo(() => {
    const cache = cacheRef.current;
    const prev = cache.lines;
    let appended = shown.length >= prev.length;
    for (let i = 0; appended && i < prev.length; i += 1) {
      if (shown[i] !== prev[i]) appended = false;
    }

    const chunks: LogLine[][] = [];
    const full = Math.floor(shown.length / LOG_CHUNK);
    for (let b = 0; b < full; b += 1) {
      // 已封口的块：前缀没变时它的内容必然没变，直接复用同一个数组（引用稳定 → memo 命中）
      chunks.push(
        appended && cache.chunks[b] !== undefined
          ? cache.chunks[b]
          : shown.slice(b * LOG_CHUNK, (b + 1) * LOG_CHUNK),
      );
    }
    // 尾块还在长，每批都重切一次（最多 LOG_CHUNK 行）
    if (full * LOG_CHUNK < shown.length) chunks.push(shown.slice(full * LOG_CHUNK));

    // 缓存里**只放已封口的块**。尾块下一批还会变长：把它也缓存进来，等它的下标 b 进入
    // `b < full` 时就会被当成"已封口"复用 —— 界面上那一段会停在旧内容（本该 200 行却只剩
    // 当初那几行），后续块还会和它重复。判断"是否封口"只能靠 full，不能靠下标是否越界。
    cacheRef.current = { lines: shown, chunks: chunks.slice(0, full) };
    return chunks;
  }, [shown]);

  const lastTs = shown.length ? shown[shown.length - 1].ts_ms : null;

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !follow) return;
    // 搜索期间不跟随：边看匹配结果边被拽到末尾很难受
    if (query.trim()) return;
    el.scrollTop = el.scrollHeight;
    // 依赖是"行数 + 最后一行时间"而不是整份文本：新行到达、以及环形缓冲淘汰头部
    // （行数不变但最后一行换了）这两种情况都要跟上。等 DOM 提交后再量 scrollHeight。
    // 还要带上 active：切换日志来源后行数可能恰好没变，但列表已经整个换了一份。
  }, [shown.length, lastTs, follow, active, query]);

  // 换搜索词后从顶部看结果（上面的跟随 effect 在搜索时会跳过，这里再归零一次兜底）
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = 0;
  }, [query]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
  };

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>系统日志</span> <span className="model-count-badge">{shown.length} 行</span>
        </h1>
        <div className="top-actions">
          <div className="search-box search-box--fixed">
            <i className="fas fa-search search-icon" aria-hidden="true" />
            <input
              type="text"
              className="search-input"
              placeholder="搜索日志..."
              aria-label="搜索日志"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <label className="form-check mb-0">
            <input
              type="checkbox"
              className="form-check-input"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            <span className="form-check-label">自动滚底</span>
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void openLogDir()}
            title={logInfo?.file ?? "打开日志目录"}
          >
            <i className="fas fa-folder-open" />
            <span>日志目录</span>
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              // 清空不可撤销（日志缓冲与当前筛选结果一起没），先问一句（审查发现）
              if (!confirm("清空当前筛选出的日志？清掉后无法恢复。")) return;
              void clearLogs();
            }}
          >
            <i className="fas fa-eraser" />
            <span>清空</span>
          </button>
        </div>
      </div>

      <div className="page-fill">
        <div className="log-source-bar" role="group" aria-label="日志来源">
          {srcNav.scrollable && (
            <button
              type="button"
              className="log-source-nav"
              disabled={srcNav.atStart}
              aria-label="向左查看更多日志来源"
              onClick={() => scrollSources(-1)}
            >
              <i className="fas fa-chevron-left" aria-hidden="true" />
            </button>
          )}
          <div className="log-source-scroll" ref={srcRef} onScroll={syncSrcNav}>
            {items.map((item) => (
              <button
                key={item.filter}
                type="button"
                className={`log-source-tab${item.filter === active ? " is-active" : ""}${
                  item.loaded === false ? " is-offline" : ""
                }`}
                title={
                  item.fixed || item.loaded === undefined || item.loaded
                    ? item.name
                    : `${item.name}（未加载）`
                }
                onClick={() => setFilter(item.filter)}
              >
                {item.loaded && <span className="ls-dot" />}
                <span>{item.name}</span>
              </button>
            ))}
          </div>
          {srcNav.scrollable && (
            <button
              type="button"
              className="log-source-nav"
              disabled={srcNav.atEnd}
              aria-label="向右查看更多日志来源"
              onClick={() => scrollSources(1)}
            >
              <i className="fas fa-chevron-right" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="log-view" ref={boxRef} onScroll={onScroll} role="log">
          {chunks.length === 0 ? (
            <div className="log-empty">
              {query.trim()
                ? "没有匹配的日志行。"
                : "暂无日志。模型子实例的输出会按模型名合并进来（日志来源标成 model:名字），可用上方标签按来源查看。"}
            </div>
          ) : (
            chunks.map((lines, i) => <LogChunk key={i} lines={lines} />)
          )}
        </div>
      </div>
    </main>
  );
}
