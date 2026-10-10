import { memo, useEffect, useMemo, useRef, useState } from "react";

import { portFromArgs } from "../api/router";
import { useApp } from "../store";

/**
 * 系统日志页 —— 结构照搬 hub 新版（`index-new.html` 的 `#page-logs` + `js/newui/logs.js`）：
 * 左侧 `.log-sources` 竖排日志源（窄屏换成 `.log-src-select` 下拉），
 * 右侧 `.log-main` 里是深色 `.log-view`（内含 `<pre>` 纯文本）与底部 `.log-status`。
 *
 * 与 hub 的差异只在数据来源：hub 用「控制台快照 + WS 推送行」，我们用后端的
 * 环形缓冲（`logs_snapshot` + 批量事件），仍然按日志源过滤后拼成一段文本。
 */

/** 一块日志的行数：10000 行上限时约 50 块，新行只会让最后一块重新渲染 */
const LOG_CHUNK = 200;

function fmtClock(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 一块日志（最多 LOG_CHUNK 行）。
 *
 * memo + 字符串 props：已封口的块引用不变就跳过重渲染。原来是
 * `shown.map(...).join("\n")` 塞进同一个 `<pre>` —— 每来一批新行都要把整份文本
 * （上限 10000 行）重新拼一遍、再让浏览器重排整段文本节点；改成块之后，
 * 一次推送只重建最后一块的那 200 行。`pre` 直接挂在 `.log-view` 下（没有包裹
 * 元素），css 里 `.log-view pre { margin: 0 }`，块与块之间不会多出空隙。
 */
const LogChunk = memo(function LogChunk({ text }: { text: string }) {
  return <pre>{text}</pre>;
});

interface SourceItem {
  filter: string;
  name: string;
  /** 固定项（全部 / 系统）：不显示"未加载" */
  fixed?: boolean;
  /** 模型是否在运行（决定绿点与"未加载"后缀） */
  loaded?: boolean;
}

export function LogPanel() {
  const logs = useApp((s) => s.logs);
  const filter = useApp((s) => s.logFilter);
  const setFilter = useApp((s) => s.setLogFilter);
  const clearLogs = useApp((s) => s.clearLogs);
  const routerModels = useApp((s) => s.routerModels);
  const strataStatus = useApp((s) => s.strataStatus);

  const boxRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);

  /** 端口 → 正在该端口上的模型（用于把 `model:<port>` 显示成模型名） */
  const runningByPort = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of routerModels) {
      const port = portFromArgs(r.status?.args);
      if (port != null) map.set(String(port), r.id);
    }
    return map;
  }, [routerModels]);

  /** 日志里出现过的所有来源，顺序固定：全部 / 系统 / Strata / 前端 / 各模型实例 */
  const items = useMemo<SourceItem[]>(() => {
    const ports = new Set<string>();
    let hasFrontend = false;
    let hasStrata = false;
    for (const line of logs) {
      if (line.source === "frontend") hasFrontend = true;
      else if (line.source === "strata") hasStrata = true;
      else if (line.source.startsWith("model:")) ports.add(line.source.slice(6));
    }
    // 正在运行但还没有日志的模型也列出来（hub 同样会列出未加载的模型）
    for (const port of runningByPort.keys()) ports.add(port);

    const list: SourceItem[] = [
      { filter: "all", name: "全部日志", fixed: true },
      { filter: "system", name: "系统（router 自身）", fixed: true },
    ];
    // Strata 通道单独一路：Rust 侧 spawn_strata_reader 把整条流固定标成 source="strata"，
    // 不再和 router 的 "system" 混在一起。
    if (hasStrata) {
      list.push({
        filter: "strata",
        name: strataStatus.model_name ? "Strata · " + strataStatus.model_name : "Strata",
        fixed: true,
      });
    }
    if (hasFrontend) list.push({ filter: "frontend", name: "前端（错误上报）" });

    const modelItems = [...ports]
      .sort((a, b) => Number(a) - Number(b))
      .map((port) => ({
        filter: `model:${port}`,
        name: runningByPort.get(port) ?? `端口 ${port}`,
        loaded: runningByPort.has(port),
      }));
    // 已加载的排在前面，和 hub 一致
    modelItems.sort((a, b) => Number(Boolean(b.loaded)) - Number(Boolean(a.loaded)));
    return list.concat(modelItems);
  }, [logs, runningByPort, strataStatus.model_name]);

  // 过滤项失效（例如模型卸载后该来源消失）就回落到"全部日志"
  const active = items.some((i) => i.filter === filter) ? filter : "all";
  useEffect(() => {
    if (active !== filter) setFilter(active);
  }, [active, filter, setFilter]);

  const shown = useMemo(
    () => (active === "all" ? logs : logs.filter((l) => l.source === active)),
    [logs, active],
  );

  /**
   * 行文本与块的缓存。
   *
   * 日志是**尾部追加**的（环形缓冲只在超过上限时从头部淘汰），所以"上一批 shown 是
   * 当前 shown 的前缀"时可以把已算好的行文本与已封口的块整段复用 —— 复用靠对象
   * 引用比较（`shown[i] !== prev[i]`），不做字符串比较。
   * 切换来源、清空、淘汰头部都会让前缀判定失败，此时整份重算，行为与旧实现一致。
   */
  const cacheRef = useRef<{
    lines: typeof logs;
    texts: string[];
    chunks: string[];
  }>({ lines: [], texts: [], chunks: [] });

  const chunks = useMemo(() => {
    const cache = cacheRef.current;
    const prev = cache.lines;
    let appended = shown.length >= prev.length;
    for (let i = 0; appended && i < prev.length; i += 1) {
      if (shown[i] !== prev[i]) appended = false;
    }

    let texts: string[];
    if (appended) {
      texts = cache.texts.slice();
      for (let i = texts.length; i < shown.length; i += 1) {
        const l = shown[i];
        texts.push(`${fmtClock(l.ts_ms)} ${l.text.replace(/\r?\n$/, "")}`);
      }
    } else {
      texts = shown.map((l) => `${fmtClock(l.ts_ms)} ${l.text.replace(/\r?\n$/, "")}`);
    }

    const chunks: string[] = [];
    const full = Math.floor(texts.length / LOG_CHUNK);
    for (let b = 0; b < full; b += 1) {
      // 已封口的块：前缀没变时它的内容必然没变，直接复用同一个字符串（引用稳定 → memo 命中）
      chunks.push(
        appended && cache.chunks[b] !== undefined
          ? cache.chunks[b]
          : texts.slice(b * LOG_CHUNK, (b + 1) * LOG_CHUNK).join("\n"),
      );
    }
    // 尾块还在长，每批都重拼一次（最多 LOG_CHUNK 行）
    if (full * LOG_CHUNK < texts.length) chunks.push(texts.slice(full * LOG_CHUNK).join("\n"));

    // 缓存里**只放已封口的块**。尾块下一批还会变长：把它也缓存进来，等它的下标 b 进入
    // `b < full` 时就会被当成"已封口"复用 —— 界面上那一段会停在旧内容（本该 200 行却只剩
    // 当初那几行），后续块还会和它重复。判断"是否封口"只能靠 full，不能靠下标是否越界。
    cacheRef.current = { lines: shown, texts, chunks: chunks.slice(0, full) };
    return chunks;
  }, [shown]);

  const bytes = useMemo(() => shown.reduce((sum, l) => sum + l.text.length, 0), [shown]);
  const lastTs = shown.length ? shown[shown.length - 1].ts_ms : null;

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
    // 依赖是"行数 + 最后一行时间"而不是整份文本：新行到达、以及环形缓冲淘汰头部
    // （行数不变但最后一行换了）这两种情况都要跟上。等 DOM 提交后再量 scrollHeight。
    // 还要带上 active：切换日志来源后行数可能恰好没变，但列表已经整个换了一份。
  }, [shown.length, lastTs, follow, active]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 50);
  };

  const activeItem = items.find((i) => i.filter === active);
  const status = `${activeItem?.name ?? "全部日志"} · 行 ${shown.length}/${logs.length} · 快照 ${fmtSize(
    bytes,
  )} · 更新于 ${lastTs ? fmtClock(lastTs) : "—"}`;

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>系统日志</span> <span className="model-count-badge">{logs.length} 行</span>
        </h1>
        <div className="top-actions">
          <label className="form-check" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              className="form-check-input"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            <span className="form-check-label">自动滚底</span>
          </label>
          <button type="button" className="btn btn-secondary" onClick={() => void clearLogs()}>
            <i className="fas fa-eraser" />
            <span>清空</span>
          </button>
        </div>
      </div>

      <div className="page-fill">
        <div className="logs-wrap">
          <div className="log-sources">
            {items.map((item) => (
              <div
                key={item.filter}
                className={`log-src-item ${item.filter === active ? "active" : ""} ${
                  item.loaded === false ? "offline" : ""
                }`}
                onClick={() => setFilter(item.filter)}
              >
                {item.loaded && <span className="ls-dot" />}
                <span className="ls-name">
                  {item.name}
                  {item.fixed || item.loaded === undefined || item.loaded ? "" : "（未加载）"}
                </span>
              </div>
            ))}
          </div>

          <div className="log-main">
            <select
              className="log-src-select"
              value={active}
              onChange={(e) => setFilter(e.target.value)}
            >
              {items.map((item) => (
                <option key={item.filter} value={item.filter}>
                  {item.name}
                  {item.fixed || item.loaded === undefined || item.loaded ? "" : "（未加载）"}
                </option>
              ))}
            </select>

            <div className="log-view" ref={boxRef} onScroll={onScroll}>
              {chunks.length === 0 ? (
                <pre>
                  暂无日志。启动 router 后，模型子实例的输出会带 [端口] 前缀合并进来，可在左侧按来源过滤。
                </pre>
              ) : (
                chunks.map((text, i) => <LogChunk key={i} text={text} />)
              )}
            </div>

            <div className="log-status">{status}</div>
          </div>
        </div>
      </div>
    </main>
  );
}
