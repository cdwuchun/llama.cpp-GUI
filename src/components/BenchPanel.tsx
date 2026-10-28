import { useMemo, useState } from "react";
import { ContextBenchPanel } from "./ContextBenchPanel";
import { Modal } from "./Sheet";
import { ScenarioBenchPanel } from "./ScenarioBenchPanel";
import { useApp } from "../store";
import { fmtTs } from "../utils/bench";
import { contextTierLabel } from "../utils/contextBenchmark";

/** 性能测试的两个标签（照模型列表页的 `.st-tabs` 实现，用户 m02216） */
type BenchTab = "context" | "scenario";

const BENCH_LABELS: Record<BenchTab, string> = {
  context: "上下文挡位",
  scenario: "场景测试",
};

/**
 * 性能测试页。
 *
 * 原来的「速度测试」已按用户 m10993 的要求删掉，后端的速度测试命令
 * （`bench_server` / `bench_strata` / `bench_records*`）暂时留着没删。
 * 现在两个内容都留着（上下文档位 + 场景测试），所以顶部用标签切换，和模型列表页一致。
 * 标签状态不持久化：和模型列表一样，切页面回来回到第一个。
 *
 * 「记录管理」（用户 m03137 / m03319）：压测历史按**模型名**存在 localStorage，
 * 模型删掉之后面板里再也选不到它，记录就成了没人能清的残留。这里按条列出，
 * 可勾选多条一起删、也可以单条删 —— 各面板里的「清除记录」按钮已按 m03319 取消。
 */
export function BenchPanel() {
  const [tab, setTab] = useState<BenchTab>("context");
  const [manageOpen, setManageOpen] = useState(false);
  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">性能测试</h1>
        {/* 标签紧贴标题右侧（app.css 的 `.top-bar > .st-tabs` 用 margin-right:auto 推过来），
            放进 .top-actions 会被 space-between 顶到最右边（用户 m02461） */}
        <div className="st-tabs" role="tablist" aria-label="性能测试内容">
          {(Object.keys(BENCH_LABELS) as BenchTab[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              className={`st-tab${tab === key ? " is-active" : ""}`}
              onClick={() => setTab(key)}
            >
              {BENCH_LABELS[key]}
            </button>
          ))}
        </div>
        <div className="top-actions">
          <button
            type="button"
            className="st-btn st-btn--secondary st-btn--sm"
            title="管理本机保存的压测记录（可按条删，模型删掉后留下的记录也在这里清）"
            onClick={() => setManageOpen(true)}
          >
            <i className="fas fa-broom" />
            记录管理
          </button>
        </div>
      </div>
      {tab === "context" ? <ContextBenchPanel /> : <ScenarioBenchPanel />}
      {manageOpen && <BenchHistorySheet onClose={() => setManageOpen(false)} />}
    </main>
  );
}

/** 记录管理里的一行：一条保存下来的报告 */
interface RecordRow {
  key: string;
  kind: "context" | "scenario";
  id: string;
  model: string;
  finishedAt: number;
  summary: string;
  /** 当前配置里已经没有这个模型了，记录只是残留 */
  missing: boolean;
}

/**
 * 压测记录管理（用户 m03137、m03319）。
 *
 * 只读 localStorage 里的两份历史（`llamacpp-gui-bench-history` /
 * `llamacpp-gui-scenario-bench-history`），删的也是那两份，不碰正在跑的结果。
 */
function BenchHistorySheet({ onClose }: { onClose: () => void }) {
  const contextHistory = useApp((s) => s.contextBench.history);
  const scenarioHistory = useApp((s) => s.scenarioBench.history);
  const configs = useApp((s) => s.configs);
  const strataEntries = useApp((s) => s.strataEntries);
  const forgetRecords = useApp((s) => s.forgetBenchRecords);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  // 按模型分组的折叠状态：默认全折叠（用户 m03660 第 2 点），每个模型展开自己那一组
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const rows = useMemo(() => {
    const known = new Set<string>();
    for (const c of configs) known.add(c.name);
    for (const entry of strataEntries) if (entry.model_name) known.add(entry.model_name);
    const list: RecordRow[] = [];
    for (const r of contextHistory) {
      const tiers = r.samples.map((s) => s.tier);
      const top = tiers.length ? Math.max(...tiers) : null;
      list.push({
        key: `context:${r.id}`,
        kind: "context",
        id: r.id,
        model: r.model,
        finishedAt: r.finishedAt,
        summary: `${top === null ? "无完成档位" : `最高 ${contextTierLabel(top)}`} · ${STATE_TEXT[r.state] ?? r.state}`,
        missing: !known.has(r.model),
      });
    }
    for (const r of scenarioHistory) {
      list.push({
        key: `scenario:${r.id}`,
        kind: "scenario",
        id: r.id,
        model: r.model,
        finishedAt: r.finishedAt,
        summary: `${r.samples.length} 条样本 · ${STATE_TEXT[r.state] ?? r.state}`,
        missing: !known.has(r.model),
      });
    }
    // 模型已删除的排最前：那才是用户来这里要找的东西；同组按时间新→旧
    return list.sort((a, b) => Number(b.missing) - Number(a.missing) || b.finishedAt - a.finishedAt);
  }, [contextHistory, scenarioHistory, configs, strataEntries]);

  const total = rows.length;
  const pickedRows = rows.filter((row) => picked[row.key]);
  const allPicked = total > 0 && pickedRows.length === total;

  // 按模型分组（用户 m03660 第 2 点）：组头显示份数，展开才看得到这一组里的每一条
  const groups = useMemo(() => {
    const map = new Map<string, RecordRow[]>();
    for (const row of rows) {
      const list = map.get(row.model);
      if (list) list.push(row);
      else map.set(row.model, [row]);
    }
    return Array.from(map, ([model, list]) => ({ model, rows: list, missing: Boolean(list[0]?.missing) }));
  }, [rows]);

  const pickAll = (on: boolean): void => {
    if (!on) {
      setPicked({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const row of rows) next[row.key] = true;
    setPicked(next);
  };

  const pickGroup = (list: RecordRow[], on: boolean): void => {
    setPicked((prev) => {
      const next = { ...prev };
      for (const row of list) {
        if (on) next[row.key] = true;
        else delete next[row.key];
      }
      return next;
    });
  };


  const removeRows = (targets: RecordRow[]): void => {
    if (targets.length === 0) return;
    for (const kind of ["context", "scenario"] as const) {
      const ids = targets.filter((row) => row.kind === kind).map((row) => row.id);
      if (ids.length) forgetRecords(kind, ids);
    }
    setPicked({});
  };

  return (
    <Modal
      domId="bench-history-modal"
      title="压测记录"
      iconClass="fas fa-broom"
      onClose={onClose}
      bodyClass="bench-history"
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary btn-uniform"
            disabled={pickedRows.length === 0}
            title="删除勾选的记录"
            onClick={() => removeRows(pickedRows)}
          >
            <i className="fas fa-trash-can" />
            删除选中（{pickedRows.length}）
          </button>
          <button type="button" className="btn btn-primary btn-uniform" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {total === 0 ? (
        <p className="st-hint">还没有保存过压测记录。</p>
      ) : (
        <>
          <div className="bench-head">
            <label className="bench-history__pick">
              <input type="checkbox" checked={allPicked} onChange={(e) => pickAll(e.target.checked)} />
              全选
            </label>
            <span className="st-hint">共 {total} 份{pickedRows.length > 0 ? `，已选 ${pickedRows.length} 份` : ""}</span>
          </div>
          <div className="st-scroll">
            {groups.map((group) => {
              const expanded = Boolean(open[group.model]);
              const groupPicked = group.rows.filter((row) => picked[row.key]).length;
              return (
                <div className="bench-group" key={group.model}>
                  <div
                    className="bench-group__head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => setOpen((prev) => ({ ...prev, [group.model]: !expanded }))}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      setOpen((prev) => ({ ...prev, [group.model]: !expanded }));
                    }}
                  >
                    <i className={`fas fa-chevron-${expanded ? "down" : "right"} bench-group__chev`} />
                    <input
                      type="checkbox"
                      checked={groupPicked === group.rows.length}
                      title="选中 / 取消这一组的全部记录"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        e.stopPropagation();
                        pickGroup(group.rows, e.target.checked);
                      }}
                    />
                    <span className="mono bench-group__name">{group.model}</span>
                    {group.missing && (
                      <span className="st-badge st-badge--warn" title="当前配置里已经没有这个模型，记录只是残留">
                        模型已删除
                      </span>
                    )}
                    <span className="st-spacer" />
                    <span className="st-hint">{group.rows.length} 份</span>
                  </div>
                  {expanded && (
                    <table className="st-table">
                      <thead>
                        <tr>
                          <th className="bench-history__col-pick">选择</th>
                          <th>类型</th>
                          <th>时间</th>
                          <th>内容</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.rows.map((row) => (
                          <tr key={row.key}>
                            <td className="bench-history__col-pick">
                              <input
                                type="checkbox"
                                checked={Boolean(picked[row.key])}
                                onChange={(e) =>
                                  setPicked((prev) => {
                                    const next = { ...prev };
                                    if (e.target.checked) next[row.key] = true;
                                    else delete next[row.key];
                                    return next;
                                  })
                                }
                              />
                            </td>
                            <td>{row.kind === "context" ? "上下文挡位" : "场景测试"}</td>
                            <td className="mono">{fmtTs(row.finishedAt)}</td>
                            <td className="bench-history__summary" title={row.summary}>
                              {row.summary}
                            </td>
                            <td>
                              <button
                                type="button"
                                className="st-btn st-btn--secondary st-btn--sm"
                                title="只删这一条"
                                onClick={() => {
                                  if (!confirm(`删掉这条「${row.model}」的压测记录？`)) return;
                                  removeRows([row]);
                                }}
                              >
                                <i className="fas fa-trash-can" />
                                删除
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
      {rows.some((row) => row.missing) && (
        <p className="st-hint">标「模型已删除」的那些记录已经没有对应的配置，只占本机存储，可以放心删。</p>
      )}
    </Modal>
  );
}

const STATE_TEXT: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "被停止",
};
