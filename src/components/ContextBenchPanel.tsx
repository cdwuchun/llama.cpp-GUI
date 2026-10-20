import { useEffect, useMemo, useRef, useState } from "react";
import { fetchModelContext } from "../api/chat";
import { useApp } from "../store";
import { fmtNum, fmtTs } from "../utils/bench";
import { compareBenchReports } from "../utils/benchCompare";
import { createBenchImage } from "../utils/benchImage";
import {
  CONTEXT_BENCHMARK_HEADROOM,
  CONTEXT_BENCHMARK_TIERS,
  contextTierLabel,
} from "../utils/contextBenchmark";
import { ContextBenchCharts } from "./ContextBenchCharts";

const STATE_TEXT: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "已停止",
};

/** 各列的单位（表头第二行，与上游一致）。 */
const UNITS: Record<string, string> = {
  实际输入: "token",
  实际输出: "token",
  草稿命中率: "%",
  预填充: "tok/s",
  解码: "tok/s",
  整卡显存峰值: "MiB",
  最低空闲显存: "MiB",
  "RAM 峰值": "GiB",
  总耗时: "s",
};

/** 上下文上限统一成数字：Strata 的 config 里写的是字符串（Rust 侧是 Option<String>），
 *  llama.cpp 那边是数字。字符串直接交给 `Number.isSafeInteger` 会被判成无效上限，
 *  压测就以「模型没报告有效的 max_context」失败（用户 m12533）。 */
function toLimit(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/**
 * 上下文档位实测（P1 上文档位）。
 *
 * 版面照上游 strata-manager 的 `ContextBenchmarkPage`：测试计划 / 进度 / 各档实测图表 / 逐次测量表格；
 * 唯一改名是上游的「测试配置名称」→「模型名称」（用户 m10976）。
 * 与上游唯一的实现差异：llama.cpp 没有 `/v1/messages/count_tokens`，
 * 输入长度先按每行约 28 token 估算，再用第一趟 usage 里的 prompt_tokens 校正一次并重发
 * （见 STRATA_MANAGER_PORT_ASSESSMENT.md §6 P1）。
 * 过程与结果都放在 store 里，切页面不丢（HANDOVER §8 第 1 项）。
 */
export function ContextBenchPanel() {
  const configs = useApp((s) => s.configs);
  const bench = useApp((s) => s.contextBench);
  const run = useApp((s) => s.runContextBench);
  const cancel = useApp((s) => s.cancelContextBench);
  const clear = useApp((s) => s.clearContextBench);
  const select = useApp((s) => s.selectContextBench);
  const port = useApp((s) => s.strataStatus.proxy_port ?? 9090);
  const strataEntries = useApp((s) => s.strataEntries);
  const routerModels = useApp((s) => s.routerModels);

  // 压测目标是「前门能路由到的所有模型」：llama.cpp 的 config + Strata 的常驻模型
  // （用户 m12318 第 1 点：下拉里原先只有 llama.cpp 的）。
  const models = useMemo(() => {
    const list = configs
      .filter((c) => c.has_model)
      .map((c) => ({ id: c.id, name: c.name, maxContext: toLimit(c.max_context) }));
    for (const entry of strataEntries) {
      if (!entry.model_name) continue;
      list.push({
        id: entry.config_path,
        name: entry.model_name,
        maxContext: toLimit(entry.max_context),
      });
    }
    return list;
  }, [configs, strataEntries]);

  const [picked, setPicked] = useState("");
  const [remoteContext, setRemoteContext] = useState<number | null>(null);
// 初始不勾任何档位：等上限到手再按上限勾（用户 m11934 的模型只有 128K，
  // 却因为默认勾了前 5 档而带上 256K）
  const [tiers, setTiers] = useState<number[]>([]);
  const [maxTokens, setMaxTokens] = useState(512);
  const [rounds, setRounds] = useState(1);
  const [timeoutSec, setTimeoutSec] = useState(600);
  const [stopOnError, setStopOnError] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  /** 自绘的模型下拉是否展开（原生 select 的选项没法上色，用户 m12106 第 2 点） */
  const [pickerOpen, setPickerOpen] = useState(false);
  // 读上限的 effect 只依赖 [port, model]，输出上限的最新值从这里取
  const maxTokensRef = useRef(maxTokens);
  maxTokensRef.current = maxTokens;

  // 复制图片：图表节点用于抓 SVG 快照；导出的 PNG 写不进剪贴板时退回预览
  const chartsRef = useRef<HTMLDivElement | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  /** A/B 对照选中的另一份记录 id（空串＝不对照） */
  const [compareId, setCompareId] = useState("");
  /** 对照下拉是否展开（原生 select 的列表没法控制展开方向，只能自绘） */
  const [compareOpen, setCompareOpen] = useState(false);
  /** 历史下拉是否展开（和对照下拉一样自绘，箭头与选中态才统一，用户 m14447） */
  const [historyOpen, setHistoryOpen] = useState(false);
  /** A/B 卡片里「对照模型」下拉：所选模型与展开态 */
  const [compareModel, setCompareModel] = useState("");
  const [compareModelOpen, setCompareModelOpen] = useState(false);
  /** 停止中：照上游，点了停止先把文案改成「正在停止」，等这次请求收尾（用户 m01745 第 2 点） */
  const [stopping, setStopping] = useState(false);
  const setNotice = useApp((s) => s.setNotice);

  // 默认选中正在运行的模型；有多个就取 id 靠前的那个（用户 m11748 第 1 点）。
  // 运行状态来自前门合成的列表（`status.value === "loaded"`），只读、不加载模型。
  const defaultModel = useMemo(() => {
    const running = routerModels
      .filter((m) => m.status.value === "loaded")
      .map((m) => m.id)
      .sort((a, b) => a.localeCompare(b));
    return running[0] ?? "";
  }, [routerModels]);

  const model = picked || defaultModel || models[0]?.name || "";
  // 上限优先取本地 config 里的 `--ctx-size`（扫描模型时就已经解析好，前门在不在跑都能用，
  // 用户 m11820）；本地拿不到才去问前门的 `/v1/models`（被动读，不会加载模型）。
  const configContext = models.find((c) => c.name === model)?.maxContext ?? null;
  const maxContext = configContext ?? remoteContext;
  const modelStatus = routerModels.find((m) => m.id === model)?.status.value ?? null;
  // 徽章显示的是模型状态，不是压测状态（上游也是模型状态，用户 m11820）
  const statusText: Record<string, string> = {
    loaded: "已就绪",
    loading: "加载中",
    unloaded: "未启动",
    sleeping: "已休眠",
    downloading: "下载中",
    failed: "加载失败",
  };

  // 本地 config 给不出上限（老配置没写 `--ctx-size`）时才去问前门；前门没起就当未知。
  // `/v1/models` 是被动端点：前门只把 config 与调度器状态拼成列表，不会加载模型
  //（用户 m11407「选择模型不应该启动模型」）。
  useEffect(() => {
    if (configContext !== null || !model) {
      setRemoteContext(null);
      return;
    }
    let alive = true;
    void fetchModelContext(port, model)
      .then((value) => {
        if (alive) setRemoteContext(value);
      })
      .catch(() => {
        if (alive) setRemoteContext(null);
      });
    return () => {
      alive = false;
    };
  }, [port, model, configContext]);

  // 上限到手（不管是本地还是前门给的）就重算勾选：不超过上限，也不小到留不出输出余量
  //（用户 m11748 第 2 点），并在末尾补上「模型上限」那一档（用户 m11542 第 2 点）。
  useEffect(() => {
    if (maxContext === null) {
      // 上限拿不到就别乱勾：宁可空着让用户自己选（用户 m11934）
      setTiers([]);
      return;
    }
    const min = maxTokensRef.current + CONTEXT_BENCHMARK_HEADROOM;
    const list = [...CONTEXT_BENCHMARK_TIERS];
    if (maxContext > min && !list.includes(maxContext)) list.push(maxContext);
    setTiers(list.filter((tier) => tier > min && tier <= maxContext).sort((a, b) => a - b));
  }, [maxContext]);

  // 跑动中显示用时（500ms 心跳，与上游同频）
  useEffect(() => {
    if (!bench.running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [bench.running]);

  // 固定档位 + 模型上限那一档（插到它该在的位置，去重后升序）
  const available = useMemo(() => {
    const list = [...CONTEXT_BENCHMARK_TIERS];
    if (maxContext !== null && !list.includes(maxContext)) list.push(maxContext);
    return list.sort((a, b) => a - b);
  }, [maxContext]);

  // 只认当前模型的历史：切模型后显示该模型最近一次的结果，历史下拉也只列它的
  // （用户 m11748 第 6 点）。
  const modelHistory = useMemo(
    () => bench.history.filter((r) => r.model === model),
    [bench.history, model],
  );
  // 有 selectedId 就显示那一份，否则回落到这个模型最近的一份（清空会删记录而不是留空哨兵）
  const selected =
    modelHistory.find((r) => r.id === bench.selectedId) ?? modelHistory[0] ?? null;
  const resultSamples = bench.running ? bench.samples : selected?.samples ?? [];
  const finished = bench.completed + bench.failed + bench.cancelled;
  const elapsedMs = bench.startedAt ? Math.max(0, now - bench.startedAt) : 0;

  // A/B 对比卡片的两个下拉（用户 m01745 第 1 点）：先选模型，再选该模型的一条记录，默认最近那份。
  // 有历史的模型按出现顺序去重（history 本身是新的在前）。
  const historyModels = useMemo(() => {
    const seen: string[] = [];
    for (const r of bench.history) if (!seen.includes(r.model)) seen.push(r.model);
    return seen;
  }, [bench.history]);
  // 没手动选就默认「另一个有记录的模型」—— 对照不同模型才是这个功能的意义（用户 m14163）；
  // 只有一个模型有记录时退回当前模型。
  const compareModelName = compareModel || historyModels.find((m) => m !== model) || model;
  // 默认「该模型最近一份」，但排除 A 自己（否则表格两行一模一样）
  const compareCandidates = useMemo(() => {
    const list = bench.history.filter((r) => r.model === compareModelName);
    const rest = list.filter((r) => r.id !== selected?.id);
    return rest.length > 0 ? rest : list;
  }, [bench.history, compareModelName, selected]);
  const compareReport = useMemo(
    () => compareCandidates.find((r) => r.id === compareId) ?? compareCandidates[0] ?? null,
    [compareCandidates, compareId],
  );
  const compareRows = useMemo(
    () => (selected && compareReport ? compareBenchReports(selected, compareReport) : []),
    [selected, compareReport],
  );

  // 跑完（或没在跑）就把「正在停止」复位；点停止后 bench.running 很快会变 false
  useEffect(() => {
    if (!bench.running) setStopping(false);
  }, [bench.running]);

  // 换模型回到该模型最近一次的结果（用户 m11748 第 6 点）。
  useEffect(() => {
    select(null);
  }, [model, select]);

  const blocked = !model ? "先选一个模型" : tiers.length === 0 ? "至少勾一个档位" : null;

  const toggleTier = (tier: number) => {
    setTiers((prev) =>
      prev.includes(tier) ? prev.filter((v) => v !== tier) : [...prev, tier].sort((a, b) => a - b),
    );
  };

  const changeMaxTokens = (value: number) => {
    setMaxTokens(value);
    setTiers((prev) => prev.filter((tier) => tier > value + CONTEXT_BENCHMARK_HEADROOM));
  };

  // 把报告与图表画成 PNG。先试系统剪贴板，写不进去（WebView2 没给权限、或不是安全上下文）
  // 就打开预览让用户自己右键另存 —— 按钮承诺的是「有图能拿走」，不是「一定进了剪贴板」。
  const copyImage = async () => {
    if (!selected || !chartsRef.current || imageBusy) return;
    setImageBusy(true);
    try {
      const blob = await createBenchImage(selected, chartsRef.current);
      let copied = false;
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (copied) {
        setNotice("图片已复制到剪贴板");
      } else {
        setImageUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return URL.createObjectURL(blob);
        });
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setImageBusy(false);
    }
  };

  const closeImage = () => {
    setImageUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  };

  const start = () => {
    if (blocked) return;
    // 把已经读到的上限一起带下去：Strata 引擎没有 /props 端点，store 不该再去问
    // （用户 m12533 第 2 点）。
    void run(
      model,
      {
        tiers,
        maxTokens,
        rounds,
        timeoutMs: Math.round(timeoutSec * 1000),
        stopOnError,
        configurationLabel: model,
      },
      maxContext,
    );
  };

  // 上限优先用 config / 前门给的值；万一都拿不到，再用跑过那次实测的值兜底
  const measuredLimit =
    maxContext ?? (selected && selected.model === model ? selected.maxContext : null);

  return (
    <div className="page-fill page-fill--scroll">
      <div className="panel">
        <div className="bench-head">
          <h2 className="panel-title">测试计划</h2>
          <div className="bench-head__right">
            <span className="bench-model">{model || "没选模型"}</span>
            <span
              className={`st-badge${modelStatus === "loaded" ? " st-badge--ok" : ""}`}
              title="模型运行状态（来自前门；前门没起就取不到）"
            >
              {modelStatus ? statusText[modelStatus] ?? modelStatus : "前门未运行"}
            </span>
            {bench.running && <span className="st-badge st-badge--warn">压测中</span>}
          </div>
        </div>

        <div className="bench-top">
          <p className="bench-limit">
            当前模型上限
            {measuredLimit === null ? (
              <span>开始测试时读取</span>
            ) : (
              <strong>{contextTierLabel(measuredLimit)}</strong>
            )}
          </p>
          {bench.running ? (
            // 照上游：跑起来后按钮换成一串状态（转圈 + 已用时）加一个危险色的停止按钮，
            // 停止先变「正在停止」，等这次请求收尾（用户 m01745 第 2 点）
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
            <button
              type="button"
              className="st-btn st-btn--primary"
              disabled={blocked !== null}
              title={blocked ?? "按勾选的档位逐档跑"}
              onClick={start}
            >
              <i className="fas fa-play" />
              开始测试
            </button>
          )}
        </div>

        {maxContext === null && model !== "" && (
          <p className="st-hint st-hint--warn">
            读不到这个模型的上下文上限（配置里是 --ctx-size 0，模型文件里也没读到），档位请自己勾。
          </p>
        )}

        <div className="st-tiers">
          {available.length === 0 && <span className="st-hint">先选一个模型</span>}
          {available.map((tier) => {
            const on = tiers.includes(tier);
            const tooSmall = tier <= maxTokens + CONTEXT_BENCHMARK_HEADROOM;
            const tooBig = maxContext !== null && tier > maxContext;
            const off = bench.running || tooSmall || tooBig;
            return (
              <label
                key={tier}
                className={`st-tier${on ? " is-on" : ""}`}
                title={tooBig ? "超过模型的上下文上限" : tooSmall ? "留给输出与模板的余量不够" : ""}
              >
                <input type="checkbox" checked={on} disabled={off} onChange={() => toggleTier(tier)} />
                <span className="st-tier__box">{on && <i className="fas fa-check" />}</span>
                <span>{contextTierLabel(tier)}</span>
              </label>
            );
          })}
        </div>


        <div className="bench-fields">
          <div className="st-field">
            <span className="st-label">模型名称</span>
            {/* 原生 <select> 的选项由系统画，没法给某一项上色，所以自绘一个下拉，
                运行中的模型名用绿色（用户 m12106 第 2 点）。 */}
            <div className="bench-picker">
              <button
                type="button"
                className={`st-input bench-picker__button${
                  modelStatus === "loaded" || modelStatus === "loading" ? " is-running" : ""
                }`}
                disabled={bench.running}
                title="压测目标：走前门，按 config 里的 name 找模型"
                onClick={() => setPickerOpen((open) => !open)}
              >
                <span className="bench-picker__name">{model || "没有已配置的模型"}</span>
                <i className="fas fa-chevron-down" />
              </button>
              {pickerOpen && (
                <>
                  <div className="bench-picker__mask" onClick={() => setPickerOpen(false)} />
                  <div className="bench-picker__menu" role="listbox">
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

          <label className="st-field">
            <span className="st-label">每档轮数</span>
            <input
              id="cb-rounds"
              className="st-input"
              type="number"
              min={1}
              max={10}
              value={rounds}
              disabled={bench.running}
              title="每档重复次数"
              onChange={(e) => setRounds(Number(e.target.value))}
            />
          </label>

          <label className="st-field">
            <span className="st-label">最大输出 token</span>
            <input
              id="cb-max"
              className="st-input"
              type="number"
              min={16}
              max={4096}
              step={16}
              value={maxTokens}
              disabled={bench.running}
              title="每档的输出 token 上限"
              onChange={(e) => changeMaxTokens(Number(e.target.value))}
            />
          </label>

          <label className="st-field">
            <span className="st-label">每次超时（秒）</span>
            <input
              id="cb-timeout"
              className="st-input"
              type="number"
              min={1}
              max={600}
              value={timeoutSec}
              disabled={bench.running}
              title="单个请求的超时时间"
              onChange={(e) => setTimeoutSec(Number(e.target.value))}
            />
          </label>
        </div>

        {/* 开关紧跟文字（上游在左侧），档位统计靠右 —— 原来 .st-switch-row 把它们推到两头 */}
        <div className="bench-switch-row">
          <label className="bench-switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={stopOnError}
              disabled={bench.running}
              onChange={(e) => setStopOnError(e.target.checked)}
            />
            <span>出错即停</span>
          </label>
          <span className="st-hint">{tiers.length} 个档位</span>
        </div>

        {bench.error && <p className="st-hint st-hint--warn">{bench.error}</p>}
      </div>

      {bench.running && (
        // 照上游「实时测试进度」：大字的当前档位 + 完成/失败/已停止三个计数 + 一条细进度条。
        // 已完成用时挪到按钮旁边（用户 m01745 第 3 点）。
        <div className="panel">
          <div className="bench-head">
            <h2 className="panel-title">实时测试进度</h2>
          </div>
          <div className="bench-live">
            <strong>
              {bench.currentTier === null ? "正在核验服务与输入" : contextTierLabel(bench.currentTier)}
            </strong>
            <span>
              完成 {bench.completed} / {bench.total}
            </span>
            <span>失败 {bench.failed}</span>
            <span>已停止 {bench.cancelled}</span>
          </div>
          <progress
            className="st-progress"
            aria-label="档位测试进度"
            value={finished}
            max={bench.total || 1}
          />
        </div>
      )}

      <div className="panel">
        <div className="bench-head">
          <h2 className="panel-title">各上下文档位实测</h2>
          {/* 复制图片 + 历史记录 + 清除记录 放在同一行，照上游把控件都挂在标题行右侧（用户 m01993 第 1 点） */}
          <div className="bench-head__right">
            <button
              type="button"
              className="st-btn st-btn--secondary"
              disabled={bench.running || imageBusy || !selected || selected.samples.length === 0}
              title="把报告与三张图表画成一张 PNG（先试剪贴板，写不进去就弹出预览让你另存）"
              onClick={() => void copyImage()}
            >
              {imageBusy ? "生成中…" : "复制图片"}
            </button>
            {modelHistory.length > 1 && (
              // 原生 <select> 的箭头由系统画、列表方向也改不了，和右边自绘的对照下拉放一起
              // 会一个三角一个箭头、一个右扩一个系统默认。这里一并自绘（用户 m14447）。
              <div className="bench-picker st-input--history">
                <button
                  type="button"
                  className="st-input bench-picker__button"
                  title="这份模型的测量记录，选一份就显示在下面"
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
              disabled={bench.running || resultSamples.length === 0}
              // 删掉正在看的这份记录（用户 m13216 第 3 点），删完自动显示这个模型剩下的最近一份
              onClick={() => clear(selected?.id)}
            >
              清除记录
            </button>
          </div>
        </div>
        <div ref={chartsRef}>
          <ContextBenchCharts samples={resultSamples} />
        </div>

        <div className="bench-head bench-head--sec">
          <h2 className="panel-title">逐次测量</h2>
          <div className="bench-head__right">
            <span className="st-hint">图表：成功请求的档位均值</span>
          </div>
        </div>

        <div className="st-scroll">
          <table className="st-table st-table--nowrap">
            <thead>
              <tr className="st-table__head">
                <th>档位</th>
                <th>实际输入</th>
                <th>实际输出</th>
                <th>预填充</th>
                <th>解码</th>
                <th>草稿命中率</th>
                <th>整卡显存峰值</th>
                <th>最低空闲显存</th>
                <th>RAM 峰值</th>
                <th>总耗时</th>
                <th>状态</th>
              </tr>
              <tr className="st-table__units">
                <th />
                {["实际输入", "实际输出", "预填充", "解码", "草稿命中率", "整卡显存峰值", "最低空闲显存", "RAM 峰值", "总耗时"].map(
                  (name) => (
                    <th key={name}>{UNITS[name]}</th>
                  ),
                )}
                <th />
              </tr>
            </thead>
            <tbody>
              {resultSamples.length === 0 && (
                <tr>
                  <td colSpan={11} className="st-table__empty">
                    选择档位并开始测试，结果会按此表逐项记录
                  </td>
                </tr>
              )}
              {resultSamples.map((s) => (
                <tr key={s.index}>
                  <td>{contextTierLabel(s.targetTokens)}</td>
                  <td className="num">{fmtNum(s.promptTokens)}</td>
                  <td className="num">{fmtNum(s.completionTokens)}</td>
                  <td className="num">{fmtNum(s.prefillTokS)}</td>
                  <td className="num">{fmtNum(s.decodeTokS)}</td>
                  <td className="num">
                    {s.draftAccept === null ? "—" : `${(s.draftAccept * 100).toFixed(1)}%`}
                  </td>
                  <td className="num">{s.peakGpuMemory === null ? "—" : fmtNum(s.peakGpuMemory / 2 ** 20)}</td>
                  <td className="num">{s.minGpuMemoryFree === null ? "—" : fmtNum(s.minGpuMemoryFree / 2 ** 20)}</td>
                  <td className="num">{s.peakRam === null ? "—" : fmtNum(s.peakRam / 2 ** 30)}</td>
                  <td className="num">{fmtNum(s.wallMs / 1000)}</td>
                  <td>
                    {s.error ? `${STATE_TEXT[s.state] ?? s.state}：${s.error}` : STATE_TEXT[s.state] ?? s.state}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selected && selected.skipped.length > 0 && (
          <p className="st-hint">
            跳过的档位：
            {selected.skipped.map((s) => `${contextTierLabel(s.tier)}（${s.reason}）`).join("；")}
          </p>
        )}
        {selected?.stopReason === "cancelled" && (
          <p className="st-hint">这次是中途停的，已经跑完的档位留在表里。</p>
        )}
        {selected?.stopReason === "error" && <p className="st-hint st-hint--warn">遇到错误提前结束了。</p>}
      </div>

      {/* A/B 对比单独成卡：先选模型、再选这个模型的一条记录（用户 m01745 第 1 点）。
          默认挑「另一个有记录的模型」的最近一份，跨模型对照才看得出该选谁（用户 m14163）。 */}
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
                  title="选另一个模型，用它下面的记录做 B 侧"
                  onClick={() => setCompareModelOpen((open) => !open)}
                >
                  <span className="bench-picker__name">{compareModelName || "还没有别的记录"}</span>
                  <i className="fas fa-chevron-down" />
                </button>
                {compareModelOpen && (
                  <>
                    <div
                      className="bench-picker__mask"
                      onClick={() => setCompareModelOpen(false)}
                    />
                    <div className="bench-picker__menu bench-picker__menu--right" role="listbox">
                      {historyModels.map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="option"
                          aria-selected={m === compareModelName}
                          className={`bench-picker__item${m === compareModelName ? " is-on" : ""}`}
                          onClick={() => {
                            setCompareModel(m);
                            // 换模型后旧的记录 id 就悬空了，清掉让它回到该模型最近一份
                            setCompareId("");
                            setCompareModelOpen(false);
                          }}
                        >
                          <span className="bench-picker__name">{m}</span>
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
                  title="这个模型的测量记录，默认最近一份"
                  onClick={() => setCompareOpen((open) => !open)}
                >
                  <span className="bench-picker__name">
                    {compareReport
                      ? `${fmtTs(compareReport.finishedAt)} · ${
                          STATE_TEXT[compareReport.state] ?? compareReport.state
                        }`
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
                          className={`bench-picker__item${
                            compareReport?.id === r.id ? " is-on" : ""
                          }`}
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
          {compareRows.length > 0 ? (
            <div className="st-scroll">
              <table className="st-table st-table--nowrap st-table--compare">
                <thead>
                  <tr className="st-table__head">
                    <th>档位</th>
                    <th>模型</th>
                    <th>实际输入</th>
                    <th>预填充</th>
                    <th>解码</th>
                    <th>草稿命中率</th>
                    <th>总耗时</th>
                    <th>成功次数</th>
                  </tr>
                  <tr className="st-table__units">
                    <th />
                    <th />
                    <th>token</th>
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
                        { side: "A", data: row.left, model: selected?.model ?? "" },
                        { side: "B", data: row.right, model: compareReport.model },
                      ] as const
                    ).map(({ side, data, model }, index) => (
                      <tr key={`${row.tier}-${side}`}>
                        {index === 0 && <td rowSpan={2}>{contextTierLabel(row.tier)}</td>}
                        <td className="bench-compare__model">{`${side} · ${model}`}</td>
                        <td className="num">{fmtNum(data?.promptTokens ?? null)}</td>
                        <td className="num">{fmtNum(data?.prefillTokS ?? null)}</td>
                        <td className="num">{fmtNum(data?.decodeTokS ?? null)}</td>
                        <td className="num">
                          {data?.draftAccept === null || data?.draftAccept === undefined
                            ? "—"
                            : `${(data.draftAccept * 100).toFixed(1)}%`}
                        </td>
                        <td className="num">
                          {data && data.wallMs !== null ? fmtNum(data.wallMs / 1000) : "—"}
                        </td>
                        <td className="num">{data ? `${data.samples} 次` : "—"}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="st-hint">这两份记录没有共同的档位，换个对照看看。</p>
          )}
        </div>
      )}

      {imageUrl && (
        <div className="bench-image" role="dialog" aria-label="导出的图片">
          <button type="button" className="bench-image__mask" aria-label="关闭" onClick={closeImage} />
          <figure className="bench-image__box">
            <img src={imageUrl} alt="上下文档位实测报告" />
            <figcaption className="st-hint">右键图片可另存为 PNG；关掉后重新点「复制图片」会再生成一次</figcaption>
          </figure>
        </div>
      )}
    </div>
  );
}
