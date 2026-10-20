import { useCallback, useEffect, useState } from "react";

import { ipc } from "../ipc";
import type { SearchConfigView } from "../types";

/** 引擎名 → 展示名（后端 ENGINES 的固定顺序见 `src-tauri/src/search.rs`） */
const ENGINE_LABEL: Record<string, string> = {
  anysearch: "AnySearch",
  tavily: "Tavily",
  firecrawl: "Firecrawl",
  keenable: "Keenable",
  exa: "Exa",
};

const TIME_RANGES: { value: string; label: string }[] = [
  { value: "", label: "不限时间" },
  { value: "day", label: "最近一天" },
  { value: "week", label: "最近一周" },
  { value: "month", label: "最近一月" },
  { value: "year", label: "最近一年" },
];

const errText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "操作失败";

/**
 * 联网搜索的设置（`WEB_SEARCH_PLAN.md` 的配置块）。
 *
 * 后端把配置落在 `<配置目录>\search.json`：引擎顺序、各家 key、时间范围、屏蔽域名、
 * 结果条数。这里只负责编辑；引擎的可用性与冷却状态由后端在每次读取时现算，
 * 所以「测试」之后要重新拉一次配置，才能看到冷却标记。
 */
export function ChatSearchSettings() {
  const [config, setConfig] = useState<SearchConfigView | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [blocked, setBlocked] = useState("");
  const [timeRange, setTimeRange] = useState("");
  const [maxResults, setMaxResults] = useState(6);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 用后端返回的配置重填表单（会丢弃未保存的 key 输入，只在读取/保存后用） */
  const reset = useCallback((next: SearchConfigView) => {
    setConfig(next);
    setOrder(next.order);
    setBlocked(next.blockedDomains.join("\n"));
    setTimeRange(next.timeRange ?? "");
    setMaxResults(next.maxResults);
    setKeys({});
  }, []);

  useEffect(() => {
    let alive = true;
    ipc
      .searchConfig()
      .then((next) => {
        if (alive) reset(next);
      })
      .catch((err) => {
        if (alive) setError(errText(err));
      });
    return () => {
      alive = false;
    };
  }, [reset]);

  const move = (name: string, delta: number) => {
    setOrder((list) => {
      const at = list.indexOf(name);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= list.length) return list;
      const next = [...list];
      next[at] = next[to];
      next[to] = name;
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await ipc.searchSaveConfig({
        order,
        keys,
        blockedDomains: blocked
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        timeRange: timeRange || null,
        maxResults,
      });
      reset(next);
      setNotice("已保存");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async (name: string) => {
    setTesting(name);
    setError(null);
    setNotice(null);
    const label = ENGINE_LABEL[name] ?? name;
    try {
      // 「测试」打的是后端磁盘上的配置：刚粘进来的 key 还没保存，
      // 直接测会报「需要先配 API key」（用户 m07055 第 1 点）。先补一次保存。
      if ((keys[name] ?? "").trim()) {
        const saved = await ipc.searchSaveConfig({
          order,
          keys,
          blockedDomains: blocked
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
          timeRange: timeRange || null,
          maxResults,
        });
        reset(saved);
      }
      const result = await ipc.searchTestEngine(name);
      setNotice(
        result.ok
          ? `${label}：${result.count} 条 · ${result.ms} ms`
          : `${label}：${result.message ?? "失败"}`,
      );
      // 只刷新状态（冷却/是否已配 key），不动用户正在输入的 key
      setConfig(await ipc.searchConfig());
    } catch (err) {
      setError(errText(err));
    } finally {
      setTesting(null);
    }
  };

  if (!config) {
    return <p className="st-hint">{error ?? "正在读取搜索配置…"}</p>;
  }

  return (
    <div className="search-settings">
      <div className="search-settings__row">
        <div className="st-field">
          <label className="st-label" htmlFor="chat-search-time">
            时间范围
          </label>
          <select
            id="chat-search-time"
            className="st-input"
            value={timeRange}
            onChange={(event) => setTimeRange(event.target.value)}
          >
            {TIME_RANGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="st-field">
          <label className="st-label" htmlFor="chat-search-count">
            结果条数
          </label>
          <input
            id="chat-search-count"
            className="st-input"
            type="number"
            min={1}
            max={50}
            value={maxResults}
            onChange={(event) => setMaxResults(Math.min(50, Math.max(1, Number(event.target.value) || 6)))}
          />
        </div>
      </div>

      <p className="st-hint">
        按下面顺序逐个试，前一个失败（额度用完 / 鉴权失败 / 被拦）就换下一个。不配 key 也能用的是
        AnySearch、Tavily、Firecrawl。每条结果给模型的正文最多 4 千字符、整轮 2.4 万字符，
        条数给多了后面的会被截掉。
      </p>

      <div className="search-settings__engines">
        {/* 必须按保存的顺序渲染：上下箭头改的是 order，列表要是按后端固定顺序画，
            点了按钮界面不会变，看起来就是「按钮无效」（用户 m07055 第 3 点）。
            没启用的引擎排到后面，内部保持后端给的顺序。 */}
        {[...config.engines]
          .sort((a, b) => {
            const ai = order.indexOf(a.name);
            const bi = order.indexOf(b.name);
            if (ai < 0 && bi < 0) {
              return config.engines.indexOf(a) - config.engines.indexOf(b);
            }
            if (ai < 0) return 1;
            if (bi < 0) return -1;
            return ai - bi;
          })
          .map((engine) => {
          const label = ENGINE_LABEL[engine.name] ?? engine.name;
          const at = order.indexOf(engine.name);
          const enabled = at >= 0;
          return (
            <div className={`search-engine${enabled ? " is-on" : ""}`} key={engine.name}>
              <div className="search-engine__head">
                <label className="bench-switch search-engine__toggle">
                  <input
                    type="checkbox"
                    className="switch-input"
                    checked={enabled}
                    onChange={() =>
                      setOrder((list) =>
                        enabled ? list.filter((name) => name !== engine.name) : [...list, engine.name],
                      )
                    }
                  />
                  <span>{label}</span>
                </label>
                {engine.keyless ? <span className="st-badge st-badge--ok">免key</span> : null}
                {engine.cooling ? <span className="st-badge st-badge--queued">冷却</span> : null}
                <span className="spacer" />
                <button
                  type="button"
                  className="st-btn st-btn--icon"
                  title="往前一位"
                  aria-label={`${label} 往前一位`}
                  disabled={!enabled || at === 0}
                  onClick={() => move(engine.name, -1)}
                >
                  <i className="fas fa-arrow-up" />
                </button>
                <button
                  type="button"
                  className="st-btn st-btn--icon"
                  title="往后一位"
                  aria-label={`${label} 往后一位`}
                  disabled={!enabled || at === order.length - 1}
                  onClick={() => move(engine.name, 1)}
                >
                  <i className="fas fa-arrow-down" />
                </button>
              </div>
              <div className="search-engine__key">
                <input
                  type="password"
                  className="st-input"
                  autoComplete="off"
                  placeholder={engine.hasKey ? "已保存，留空表示不改" : "粘贴 API key（可留空）"}
                  value={keys[engine.name] ?? ""}
                  onChange={(event) =>
                    setKeys((old) => ({ ...old, [engine.name]: event.target.value }))
                  }
                />
                <button
                  type="button"
                  className="st-btn st-btn--secondary st-btn--sm"
                  disabled={testing !== null}
                  onClick={() => void test(engine.name)}
                >
                  {testing === engine.name ? "测试中…" : "测试"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="st-field">
        <label className="st-label" htmlFor="chat-search-blocked">
          屏蔽域名
        </label>
        <textarea
          id="chat-search-blocked"
          className="st-input"
          rows={3}
          placeholder={"一行一个，例如\nexample.com\n*.spam.net"}
          value={blocked}
          onChange={(event) => setBlocked(event.target.value)}
        />
        <p className="st-hint">命中的结果会被丢掉（按域名后缀匹配，子域一起屏蔽）</p>
      </div>

      {error ? <p className="msg-error">{error}</p> : null}
      {notice ? <p className="st-hint">{notice}</p> : null}

      <button
        type="button"
        className="st-btn st-btn--secondary"
        disabled={busy}
        onClick={() => void save()}
      >
        {busy ? "保存中…" : "保存搜索配置"}
      </button>
    </div>
  );
}
