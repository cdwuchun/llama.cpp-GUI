/**
 * 场景测试页（照上游 `ScenarioBenchmarkPage.tsx` 的版面移植）。
 *
 * 与上游的差别只有三处（都是用户要求）：
 * 1. 模型下拉放进「测试计划」卡里 —— 上游靠外部选中的 profile，本工程没这个概念；
 * 2. 上游的「历史与升级对照」换成上下文档位页那套 A/B 对比；
 * 3. 去掉压测（stress）模式，只留一次性串行套件。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import {
  MAX_SCENARIOS,
  SCENARIOS,
  DEFAULT_SCENARIO_BENCH_OPTIONS,
  estimateScenarioRequests,
  formatDuration,
  scenarioCsv,
  scenarioJson,
  scenarioLabel,
  summarizeByScenario,
  summarizeOverall,
  compareScenarioReports,
  type ScenarioBenchOptions,
  type ScenarioId,
  type ScenarioSample,
} from "../utils/scenarioBench";
import { RequestDotPlot, ScenarioColumns } from "./ScenarioBenchCharts";
import { ConcurrencyLadder } from "./ConcurrencyLadder";

/** 时间显示成 `2026-10-17 09:13` */
function fmtTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fmtNum = (value: number | null, digits = 1): string =>
  value === null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });

const STATE_TEXT: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "已停止",
};

/** 模型加载状态 → 文案（和上下文挡位页同一个口径，用户 m02426 第 3 点） */
const MODEL_STATE_TEXT: Record<string, string> = {
  loaded: "已就绪",
  loading: "加载中",
  unloaded: "未启动",
  sleeping: "已休眠",
  downloading: "下载中",
  failed: "加载失败",
};

/** 一次请求的简短说明，样本表与图共用 */
function sampleLabel(sample: ScenarioSample): string {
  return scenarioLabel(sample.scenario);
}

export function ScenarioBenchPanel() {
  const configs = useApp((s) => s.configs);
  const strataEntries = useApp((s) => s.strataEntries);
  const routerModels = useApp((s) => s.routerModels);
  const bench = useApp((s) => s.scenarioBench);
  const run = useApp((s) => s.runScenarioBench);
  const cancel = useApp((s) => s.cancelScenarioBench);
  const clear = useApp((s) => s.clearScenarioBench);
  const select = useApp((s) => s.selectScenarioBench);
  const setNotice = useApp((s) => s.setNotice);

  /** 能压测的模型：前门能路由到的都算（llama.cpp 配置 + Strata 常驻模型） */
  const models = useMemo(
    () => [
      ...configs.filter((c) => c.has_model).map((c) => ({ id: c.id, name: c.name })),
      ...strataEntries
        .filter((e) => e.model_name)
        .map((e) => ({ id: e.config_path, name: e.model_name as string })),
    ],
    [configs, strataEntries],
  );

  /** 默认选正在跑的模型（多个时取 id 靠前的），不用选模型就触发加载 */
  const defaultModel =
    routerModels
      .filter((m) => m.status.value === "loaded")
      .map((m) => m.id)
      .sort((a, b) => a.localeCompare(b))[0] ?? "";
  const [picked, setPicked] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const model = picked || defaultModel || models[0]?.name || "";
  /** 当前模型在前门的加载状态（只读前门合成的列表，不会去加载模型） */
  const modelStatus = routerModels.find((m) => m.id === model)?.status.value ?? null;

  const [scenarios, setScenarios] = useState<ScenarioId[]>(
    DEFAULT_SCENARIO_BENCH_OPTIONS.scenarios,
  );
  const [prompt, setPrompt] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.prompt);
  const [rounds, setRounds] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.rounds);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.maxTokens);
  const [inputChars, setInputChars] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.inputChars);
  const [conversationTurns, setConversationTurns] = useState(
    DEFAULT_SCENARIO_BENCH_OPTIONS.conversationTurns,
  );
  const [timeoutSec, setTimeoutSec] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.timeoutMs / 1000);
  const [mode, setMode] = useState<ScenarioBenchOptions["mode"]>(
    DEFAULT_SCENARIO_BENCH_OPTIONS.mode,
  );
  const [warmup, setWarmup] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.warmup);
  const [stopOnError, setStopOnError] = useState(DEFAULT_SCENARIO_BENCH_OPTIONS.stopOnError);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const [historyOpen, setHistoryOpen] = useState(false);
  const [compareModel, setCompareModel] = useState("");
  const [compareModelOpen, setCompareModelOpen] = useState(false);
  const [compareId, setCompareId] = useState("");
  const [compareOpen, setCompareOpen] = useState(false);
  const [includeContent, setIncludeContent] = useState(false);

  const options: ScenarioBenchOptions = {
    scenarios,
    prompt,
    rounds,
    maxTokens,
    inputChars,
    conversationTurns,
    timeoutMs: Math.round(timeoutSec * 1000),
    mode,
    warmup,
    stopOnError,
  };
  const planned = scenarios.length === 0 ? 0 : estimateScenarioRequests(options);

  useEffect(() => {
    if (!bench.running) setStopping(false);
  }, [bench.running]);

  useEffect(() => {
    if (!bench.running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => {
      clearInterval(timer);
    };
  }, [bench.running]);

  /** 当前模型的记录（历史下拉只列这个模型的，跟上下文档位页一致） */
  const modelHistory = useMemo(
    () => bench.history.filter((r) => r.model === model),
    [bench.history, model],
  );
  const selected = modelHistory.find((r) => r.id === bench.selectedId) ?? modelHistory[0] ?? null;
  const samples = bench.running ? bench.samples : selected?.samples ?? [];

  /** 跨模型对照（用户 m14163：A/B 就是用来比不同模型的） */
  const historyModels = useMemo(() => {
    const seen: string[] = [];
    for (const r of bench.history) if (!seen.includes(r.model)) seen.push(r.model);
    return seen;
  }, [bench.history]);
  const compareModelName = compareModel || historyModels.find((m) => m !== model) || model;
  const compareCandidates = useMemo(() => {
    const own = bench.history.filter((r) => r.model === compareModelName && r.id !== selected?.id);
    return own.length > 0 ? own : bench.history.filter((r) => r.model === compareModelName);
  }, [bench.history, compareModelName, selected]);
  const compareReport =
    compareCandidates.find((r) => r.id === compareId) ?? compareCandidates[0] ?? null;

  const elapsedMs = bench.startedAt ? Math.max(0, now - bench.startedAt) : 0;
  const finished = bench.completed + bench.failed + bench.cancelled;
  const overall = useMemo(() => summarizeOverall(samples), [samples]);
  const byScenario = useMemo(() => summarizeByScenario(samples), [samples]);
  const compareRows =
    selected && compareReport ? compareScenarioReports(selected, compareReport) : [];

  /** 逐次请求点图：按顺序摊平，带上场景名 */
  const points = useMemo(
    () =>
      samples
        .filter((s) => !s.warmup)
        .map((s, index) => ({
          order: index + 1,
          label: sampleLabel(s),
          value: s.decodeTokS,
          failed: s.state !== "completed",
          current: index === samples.filter((x) => !x.warmup).length - 1,
        })),
    [samples],
  );
  const ttftPoints = useMemo(
    () =>
      samples
        .filter((s) => !s.warmup)
        .map((s, index) => ({
          order: index + 1,
          label: sampleLabel(s),
          value: s.ttftMs,
          failed: s.state !== "completed",
          current: false,
        })),
    [samples],
  );

  const toggleScenario = (id: ScenarioId): void => {
    setScenarios((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  };

  const start = (): void => {
    if (bench.running || !model) return;
    void run(model, options);
  };

  const download = (name: string, data: string, type: string): void => {
    const blob = new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
    setNotice(`已导出 ${name}`);
  };

  const rowsRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="page-fill page-fill--scroll">
      {/* ---- 测试计划 ---- */}
      <div className="panel">
        <div className="bench-head">
          <h2 className="panel-title">测试计划</h2>
          {/* 宽度要和上下文挡位页的「模型名称」下拉一致：那边在 .bench-fields 的 1.6fr 列里，
              这里用同一套算式（4 列 + 3 个 --st-s-4 间隔）算出来（用户 m02593 第 1 点）。
              下拉本身还是同一个 .bench-picker（用户 m02426 第 3 点）。 */}
          <div className="bench-field-model">
            <div className="bench-picker">
              <button
                type="button"
                className="st-input bench-picker__button"
                title="场景测试的目标模型：走前门，按 config 里的 name 找"
                disabled={bench.running}
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span className="bench-picker__name">{model || "没有已配置的模型"}</span>
                <i className="fas fa-chevron-down" />
              </button>
              {pickerOpen && (
                <>
                  <div className="bench-picker__mask" onClick={() => setPickerOpen(false)} />
                  <div className="bench-picker__menu bench-picker__menu--right" role="listbox">
                    {models.map((c) => {
                      const state = routerModels.find((m) => m.id === c.name)?.status.value;
                      const running = state === "loaded" || state === "loading";
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role="option"
                          aria-selected={c.name === model}
                          className={`bench-picker__item${c.name === model ? " is-on" : ""}${
                            running ? " is-running" : ""
                          }`}
                          onClick={() => {
                            setPicked(c.name);
                            setPickerOpen(false);
                          }}
                        >
                          <span className="bench-picker__name">{c.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
          <span className={`st-badge${modelStatus === "loaded" ? " st-badge--ok" : ""}`}>
            {modelStatus ? MODEL_STATE_TEXT[modelStatus] ?? modelStatus : "前门未运行"}
          </span>
        </div>

        <div className="scenario-scenario-head">
          <span className="scenario-scenario-title">测试场景</span>
          <span className="st-hint">
            {scenarios.length} / {MAX_SCENARIOS} 已选
          </span>
        </div>

        <div className="scenario-scenarios">
          {SCENARIOS.map((scenario) => {
            const on = scenarios.includes(scenario.id);
            return (
              <label
                key={scenario.id}
                className="scenario-scenario"
                title={scenario.hint}
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={bench.running}
                  onChange={() => toggleScenario(scenario.id)}
                />
                <span className="scenario-scenario__check" aria-hidden="true" />
                <span>{scenario.name}</span>
              </label>
            );
          })}
        </div>

        <div className="bench-fields scenario-fields">
          <div className="st-field">
            <span className="st-label">测试轮数</span>
            <input
              className="st-input"
              type="number"
              min={1}
              max={20}
              value={rounds}
              disabled={bench.running}
              onChange={(e) => setRounds(Number(e.target.value) || 1)}
            />
          </div>
          <div className="st-field">
            <span className="st-label">每轮最大输出 token</span>
            <input
              className="st-input"
              type="number"
              min={16}
              max={4096}
              step={16}
              value={maxTokens}
              disabled={bench.running}
              onChange={(e) => setMaxTokens(Number(e.target.value) || 256)}
            />
          </div>
          <div className="st-field">
            <span className="st-label">长输入字符数</span>
            <input
              className="st-input"
              type="number"
              min={1024}
              max={131072}
              step={1024}
              value={inputChars}
              disabled={bench.running}
              onChange={(e) => setInputChars(Number(e.target.value) || 8192)}
            />
          </div>
          <div className="st-field">
            <span className="st-label">连续对话轮数</span>
            <input
              className="st-input"
              type="number"
              min={2}
              max={10}
              value={conversationTurns}
              disabled={bench.running}
              onChange={(e) => setConversationTurns(Number(e.target.value) || 3)}
            />
          </div>
          <div className="st-field">
            <span className="st-label">每轮超时（秒）</span>
            <input
              className="st-input"
              type="number"
              min={1}
              max={600}
              value={timeoutSec}
              disabled={bench.running}
              onChange={(e) => setTimeoutSec(Number(e.target.value) || 120)}
            />
          </div>
          <div className="st-field">
            <span className="st-label">输入模式</span>
            <select
              className="st-input"
              value={mode}
              disabled={bench.running}
              onChange={(e) => setMode(e.target.value as ScenarioBenchOptions["mode"])}
            >
              <option value="unique">变化输入</option>
              <option value="repeat">重复输入 · 测前缀缓存</option>
            </select>
          </div>
        </div>

        {scenarios.includes("custom") && (
          <div className="st-field">
            <span className="st-label">自定义提示词</span>
            <textarea
              className="st-input"
              rows={4}
              value={prompt}
              disabled={bench.running}
              placeholder="自定义场景会原样发这段文字"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        )}

        <div className="scenario-plan-footer">
          <div className="scenario-plan-hints">
            <div className="scenario-plan-toggles">
              <label className="bench-switch">
                <input
                  type="checkbox"
                  className="switch-input"
                  checked={warmup}
                  disabled={bench.running}
                  onChange={(e) => setWarmup(e.target.checked)}
                />
                <span>每个场景先预热一次</span>
              </label>
              <label className="bench-switch">
                <input
                  type="checkbox"
                  className="switch-input"
                  checked={stopOnError}
                  disabled={bench.running}
                  onChange={(e) => setStopOnError(e.target.checked)}
                />
                <span>发生错误后停止</span>
              </label>
            </div>
            <p className="st-hint">超时或模型变化总会停止整组测试</p>
            {modelStatus !== "loaded" && (
              <p className="st-hint">请先启用服务并等待模型就绪</p>
            )}
          </div>
          <div className="scenario-start">
            {bench.running ? (
              <div className="bench-run">
                <span className="bench-status" role="status">
                  <i className="fas fa-spinner fa-spin" />
                  {(elapsedMs / 1000).toFixed(1)} s
                </span>
                <button
                  type="button"
                  className="st-btn st-btn--secondary bench-stop"
                  disabled={stopping}
                  onClick={() => {
                    setStopping(true);
                    cancel();
                  }}
                >
                  <i className="fas fa-stop" />
                  {stopping ? "正在停止" : "停止测试"}
                </button>
              </div>
            ) : (
              <>
                <strong className="scenario-budget">{planned} 个测量请求</strong>
                <button
                  type="button"
                  className="st-btn st-btn--primary"
                  onClick={start}
                  disabled={!model}
                >
                  <i className="fas fa-play" />
                  开始测试
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ---- 实时进度 ---- */}
      {bench.running && (
        <div className="panel">
          <div className="bench-head">
            <h2 className="panel-title">实时测试进度</h2>
          </div>
          <div className="scenario-live-head">
            <div className="scenario-live-now">
              <strong>{bench.current ? scenarioLabel(bench.current.scenario as ScenarioId) : "正在核验服务与输入"}</strong>
              {bench.current && <span>第 {bench.current.round} 轮</span>}
            </div>
            <div className="bench-live">
              <span>
                完成 {bench.completed} / {bench.total}
              </span>
              <span>失败 {bench.failed}</span>
              <span>已停止 {bench.cancelled}</span>
            </div>
          </div>
          <progress
            className="st-progress"
            aria-label="场景测试进度"
            value={finished}
            max={bench.total || 1}
          />
        </div>
      )}

      {/* ---- 结果 ---- */}
      <div className="panel" ref={rowsRef}>
        <div className="bench-head">
          <h2 className="panel-title">测试结果</h2>
          <div className="bench-head__right">
            <button
              type="button"
              className="st-btn st-btn--secondary"
              disabled={bench.running || !selected || selected.samples.length === 0}
              onClick={() => {
                if (!selected) return;
                download(
                  `scenario-${selected.id}.csv`,
                  scenarioCsv(selected, includeContent),
                  "text/csv;charset=utf-8",
                );
              }}
            >
              导出 CSV
            </button>
            <button
              type="button"
              className="st-btn st-btn--secondary"
              disabled={bench.running || !selected || selected.samples.length === 0}
              onClick={() => {
                if (!selected) return;
                download(
                  `scenario-${selected.id}.json`,
                  scenarioJson(selected, includeContent),
                  "application/json",
                );
              }}
            >
              导出 JSON
            </button>
            {modelHistory.length > 0 && (
              <div className="bench-picker st-input--history">
                <button
                  type="button"
                  className="st-input bench-picker__button"
                  title="这个模型的场景测试记录"
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <span className="bench-picker__name">
                    {selected
                      ? `${fmtTs(selected.finishedAt)} · ${STATE_TEXT[selected.state] ?? selected.state}`
                      : "没有记录"}
                  </span>
                  <i className="fas fa-chevron-down" />
                </button>
                {historyOpen && (
                  <>
                    <div className="bench-picker__mask" onClick={() => setHistoryOpen(false)} />
                    <div className="bench-picker__menu bench-picker__menu--right" role="listbox">
                      {modelHistory.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          role="option"
                          aria-selected={selected?.id === r.id}
                          className={`bench-picker__item${selected?.id === r.id ? " is-on" : ""}`}
                          onClick={() => {
                            select(r.id);
                            setHistoryOpen(false);
                          }}
                        >
                          <span className="bench-picker__name">
                            {fmtTs(r.finishedAt)} · {STATE_TEXT[r.state] ?? r.state}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              type="button"
              className="st-btn st-btn--secondary bench-clear"
              disabled={bench.running || !selected}
              onClick={() => clear(selected?.id)}
            >
              清除记录
            </button>
          </div>
        </div>

        {selected === null ? (
          <p className="st-hint">选几个场景，点「开始测试」，结果会按场景记录在这里。</p>
        ) : (
          <>
            <p className="st-hint">
              {selected.model} · 用时 {formatDuration(selected.elapsedMs)} · 每场景 {selected.options.rounds} 轮
            </p>
            <div className="scenario-summary">
              <div className="scenario-metric">
                <span>首 token P50</span>
                <strong>{fmtNum(overall.ttftMs)}</strong>
                <span>ms</span>
              </div>
              <div className="scenario-metric">
                <span>首 token P95</span>
                <strong>{fmtNum(overall.ttftP95)}</strong>
                <span>ms</span>
              </div>
              <div className="scenario-metric">
                <span>解码速度</span>
                <strong>{fmtNum(overall.decodeTokS)}</strong>
                <span>tok/s</span>
              </div>
              <div className="scenario-metric">
                <span>预填充速度</span>
                <strong>{fmtNum(overall.prefillTokS)}</strong>
                <span>tok/s</span>
              </div>
              <div className="scenario-metric">
                <span>缓存命中</span>
                <strong>{overall.cacheHitRate === null ? "—" : (overall.cacheHitRate * 100).toFixed(1)}</strong>
                <span>%</span>
              </div>
            </div>

            <div className="scenario-plots">
              <ScenarioColumns
                rows={byScenario.map((s) => ({ label: scenarioLabel(s.scenario), value: s.decodeTokS }))}
                title="各场景解码速度"
                unit="tok/s"
                emptyText="跑完第一轮后显示"
              />
              <ScenarioColumns
                rows={byScenario.map((s) => ({ label: scenarioLabel(s.scenario), value: s.ttftMs }))}
                title="各场景首 token 延迟"
                unit="ms"
                emptyText="跑完第一轮后显示"
              />
              <RequestDotPlot
                points={points}
                title="逐次请求的解码速度"
                unit="tok/s"
                emptyText="跑完第一条请求后显示"
                mean={overall.decodeTokS}
              />
              <RequestDotPlot
                points={ttftPoints}
                title="逐次请求的首 token 延迟"
                unit="ms"
                emptyText="跑完第一条请求后显示"
                mean={overall.ttftMs}
              />
            </div>

            <div className="bench-head bench-head--sec">
              <h2 className="panel-title">按场景</h2>
            </div>
            <div className="st-scroll">
              <table className="st-table st-table--nowrap">
                <thead>
                  <tr>
                    <th>场景</th>
                    <th>请求数</th>
                    <th>首 token</th>
                    <th>总耗时</th>
                    <th>预填充</th>
                    <th>解码</th>
                    <th>缓存命中</th>
                    <th>输出 token</th>
                  </tr>
                  <tr className="st-table__units">
                    <th />
                    <th>次</th>
                    <th>ms</th>
                    <th>s</th>
                    <th>tok/s</th>
                    <th>tok/s</th>
                    <th>%</th>
                    <th>token</th>
                  </tr>
                </thead>
                <tbody>
                  {byScenario.length === 0 ? (
                    <tr>
                      <td className="st-table__empty" colSpan={8}>
                        还没有跑完的请求
                      </td>
                    </tr>
                  ) : (
                    byScenario.map((row) => (
                      <tr key={row.scenario}>
                        <td>{scenarioLabel(row.scenario)}</td>
                        <td>{row.completed}</td>
                        <td>{fmtNum(row.ttftMs)}</td>
                        <td>{fmtNum(row.wallMs === null ? null : row.wallMs / 1000)}</td>
                        <td>{fmtNum(row.prefillTokS)}</td>
                        <td>{fmtNum(row.decodeTokS)}</td>
                        <td>
                          {row.cacheHitRate === null ? "—" : `${(row.cacheHitRate * 100).toFixed(1)}%`}
                        </td>
                        <td>{fmtNum(row.outputTokens, 0)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="bench-head bench-head--sec">
              <h2 className="panel-title">逐条请求</h2>
              <div className="bench-head__right">
                <label className="bench-switch">
                  <input
                    type="checkbox"
                    checked={includeContent}
                    onChange={(e) => setIncludeContent(e.target.checked)}
                  />
                  <span>导出时带输出内容</span>
                </label>
              </div>
            </div>
            <div className="st-scroll scenario-sample-scroll">
              <table className="st-table st-table--nowrap">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>场景</th>
                    <th>轮</th>
                    <th>状态</th>
                    <th>首 token</th>
                    <th>总耗时</th>
                    <th>预填充</th>
                    <th>解码</th>
                    <th>输出</th>
                  </tr>
                  <tr className="st-table__units">
                    <th />
                    <th />
                    <th />
                    <th />
                    <th>ms</th>
                    <th>s</th>
                    <th>tok/s</th>
                    <th>tok/s</th>
                    <th>token</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.length === 0 ? (
                    <tr>
                      <td className="st-table__empty" colSpan={9}>
                        还没有请求
                      </td>
                    </tr>
                  ) : (
                    samples.slice(-100).map((s) => (
                      <tr key={s.index}>
                        <td>{s.index + 1}</td>
                        <td>{scenarioLabel(s.scenario)}</td>
                        <td>{s.turn}</td>
                        <td>
                          {s.error
                            ? `${STATE_TEXT[s.state] ?? s.state}：${s.error}`
                            : STATE_TEXT[s.state] ?? s.state}
                        </td>
                        <td>{fmtNum(s.ttftMs)}</td>
                        <td>{fmtNum(s.wallMs / 1000)}</td>
                        <td>{fmtNum(s.prefillTokS)}</td>
                        <td>{fmtNum(s.decodeTokS)}</td>
                        <td>{fmtNum(s.completionTokens, 0)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {samples.length > 100 && (
              <p className="st-hint">表格只显示最近 100 条，导出会带全部 {samples.length} 条。</p>
            )}
          </>
        )}
      </div>

      {/* ---- A/B 对比（取代上游的「历史与升级对照」） ---- */}
      {!bench.running && selected && compareReport && compareReport.id !== selected.id && (
        <div className="panel">
          <div className="bench-head">
            <h2 className="panel-title">A/B 对比</h2>
          </div>
          <div className="bench-fields">
            <div className="st-field">
              <span className="st-label">对照模型</span>
              <div className="bench-picker">
                <button
                  type="button"
                  className="st-input bench-picker__button"
                  title="选另一个模型的记录来对照"
                  onClick={() => setCompareModelOpen((open) => !open)}
                >
                  <span className="bench-picker__name">{compareModelName || "还没有别的记录"}</span>
                  <i className="fas fa-chevron-down" />
                </button>
                {compareModelOpen && (
                  <>
                    <div className="bench-picker__mask" onClick={() => setCompareModelOpen(false)} />
                    <div className="bench-picker__menu bench-picker__menu--right" role="listbox">
                      {historyModels.map((name) => (
                        <button
                          key={name}
                          type="button"
                          role="option"
                          aria-selected={name === compareModelName}
                          className={`bench-picker__item${name === compareModelName ? " is-on" : ""}`}
                          onClick={() => {
                            setCompareModel(name);
                            // 换模型后旧记录 id 就悬空了，清掉让它回到该模型最近一份
                            setCompareId("");
                            setCompareModelOpen(false);
                          }}
                        >
                          <span className="bench-picker__name">{name}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            <div className="st-field">
              <span className="st-label">对照记录</span>
              <div className="bench-picker">
                <button
                  type="button"
                  className="st-input bench-picker__button"
                  title={
                    compareReport
                      ? `当前对照：${compareReport.model} · ${fmtTs(compareReport.finishedAt)}`
                      : "选一份记录来对照"
                  }
                  onClick={() => setCompareOpen((open) => !open)}
                >
                  <span className="bench-picker__name">
                    {compareReport
                      ? `${fmtTs(compareReport.finishedAt)} · ${STATE_TEXT[compareReport.state] ?? compareReport.state}`
                      : "没有记录"}
                  </span>
                  <i className="fas fa-chevron-down" />
                </button>
                {compareOpen && (
                  <>
                    <div className="bench-picker__mask" onClick={() => setCompareOpen(false)} />
                    <div className="bench-picker__menu bench-picker__menu--right" role="listbox">
                      {compareCandidates.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          role="option"
                          aria-selected={compareReport?.id === r.id}
                          className={`bench-picker__item${compareReport?.id === r.id ? " is-on" : ""}`}
                          onClick={() => {
                            setCompareId(r.id);
                            setCompareOpen(false);
                          }}
                        >
                          <span className="bench-picker__name">
                            {fmtTs(r.finishedAt)} · {STATE_TEXT[r.state] ?? r.state}
                          </span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {compareRows.length === 0 ? (
            <p className="st-hint">这两份记录没有共同的场景，换个对照看看。</p>
          ) : (
            <div className="st-scroll">
              <table className="st-table st-table--nowrap">
                <thead>
                  <tr>
                    <th>场景</th>
                    <th>模型</th>
                    <th>首 token</th>
                    <th>预填充</th>
                    <th>解码</th>
                    <th>缓存命中</th>
                    <th>总耗时</th>
                    <th>请求数</th>
                  </tr>
                  <tr className="st-table__units">
                    <th />
                    <th />
                    <th>ms</th>
                    <th>tok/s</th>
                    <th>tok/s</th>
                    <th>%</th>
                    <th>s</th>
                    <th>次</th>
                  </tr>
                </thead>
                <tbody>
                  {compareRows.flatMap((row) =>
                    (
                      [
                        { side: "A", data: row.left, model: selected.model },
                        { side: "B", data: row.right, model: compareReport.model },
                      ] as const
                    ).map(({ side, data, model: rowModel }, index) => (
                      <tr key={`${row.scenario}-${side}`}>
                        {index === 0 && (
                          <td rowSpan={2}>{scenarioLabel(row.scenario)}</td>
                        )}
                        <td>{`${side} · ${rowModel}`}</td>
                        <td>{fmtNum(data?.ttftMs ?? null)}</td>
                        <td>{fmtNum(data?.prefillTokS ?? null)}</td>
                        <td>{fmtNum(data?.decodeTokS ?? null)}</td>
                        <td>
                          {data && data.cacheHitRate !== null
                            ? `${(data.cacheHitRate * 100).toFixed(1)}%`
                            : "—"}
                        </td>
                        <td>{data && data.wallMs !== null ? fmtNum(data.wallMs / 1000) : "—"}</td>
                        <td>{data ? `${data.completed} 次` : "—"}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
          <p className="st-hint">
            两边都只取成功请求的均值；某场景没跑过或全部失败时显示「—」。
          </p>
        </div>
      )}

      {/* ---- 并发阶梯（照上游 ConcurrencyLadder 移植） ---- */}
      <ConcurrencyLadder model={model} />
    </div>
  );
}
