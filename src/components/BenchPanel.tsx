import { useEffect, useMemo, useRef, useState } from "react";

import { ipc } from "../ipc";
import { useApp } from "../store";
import type { BenchRecord, BenchRow, BenchStats, Hardware, ModelView } from "../types";
import {
  computeStats,
  draftText,
  fmtNum,
  fmtSize,
  fmtTs,
  isStats,
  speedClass,
  statsCell,
  toCsv,
  toExportRows,
  toJson,
  toMarkdown,
} from "../utils/bench";
import { mergeModels, presetSections } from "../utils/models";

/**
 * 性能测试页 —— 结构、文案、交互照搬 hub 新版
 * （index-new.html 的 #page-bench + js/newui/benchmark.js），
 * 但**只保留 API 压测**：llama-bench 那套（版本下拉、参数弹层、命令行拼装、
 * 历史输出浏览）已整体移除。
 *
 * 与 hub 的实现差异（架构决定的，行为一致）：
 * API 压测在 **Rust 侧**并发发起，绕开 webview 对同一主机 6 条 HTTP/1.1 连接的限制；
 * hub 是浏览器直发它的服务端接口。
 */
export function BenchPanel() {
  const scanned = useApp((s) => s.scanned);
  const routerModels = useApp((s) => s.routerModels);
  const settings = useApp((s) => s.settings);
  const paths = useApp((s) => s.paths);
  const status = useApp((s) => s.status);
  const devices = useApp((s) => s.devices);
  const presetText = useApp((s) => s.presetText);
  const setNotice = useApp((s) => s.setNotice);
  const setError = useApp((s) => s.setError);

  const benchDir = paths ? paths.config_dir + "\\bench" : "";

  const models = useMemo(
    () =>
      mergeModels(
        scanned,
        routerModels,
        settings?.favourites ?? [],
        presetSections(presetText),
        // aliases 不能漏：模型改过别名时，段名只能从这张表里查出来
        settings?.aliases ?? {},
      ),
    [scanned, routerModels, settings?.favourites, settings?.aliases, presetText],
  );

  const strataEntries = useApp((s) => s.strataEntries);
  const strataStatus = useApp((s) => s.strataStatus);

  /**
   * Strata 通道的模型也进压测列表（用户要求：性能测试页要能压 Strata 的模型）。
   *
   * 压测本身走 `ipc.benchStrata` —— 端口 / 模型名 / api key 全由 Rust 侧从 config 读，
   * 密钥不下发 WebView。这里只把 config 变成列表能渲染的条目：
   * - `section` 用 config 的 `model_name`，Strata 的 `/v1/chat/completions` 认它；
   * - `inPreset` 置 true，绕开「不在 preset 里就不能压」那条 router 专属校验；
   * - `status` 只在「Strata 在跑且跑的就是这份 config」时算 loaded。
   */
  const strataViews = useMemo<ModelView[]>(() => {
    if (!settings?.strata_root) return [];
    return strataEntries.map((e) => {
      const configFile = e.config_path.split(/[\\/]/).pop() ?? e.config_path;
      const running =
        strataStatus.running &&
        !!e.model_name &&
        strataStatus.model_name != null &&
        strataStatus.model_name === e.model_name;
      return {
        id: "strata:" + configFile,
        section: e.model_name ?? configFile,
        name: e.model_name ?? configFile,
        quantization: e.quantization,
        sizeBytes: e.model_size_bytes,
        shards: 1,
        hasMmproj: e.vision,
        group: "strata",
        status: running ? "loaded" : "unloaded",
        port: running ? strataStatus.port : e.port,
        loadProgress: null,
        loadingStage: null,
        source: "preset",
        failed: false,
        exitCode: null,
        favourite: false,
        inPreset: true,
        scanned: null,
      } satisfies ModelView;
    });
  }, [
    settings?.strata_root,
    strataEntries,
    strataStatus.running,
    strataStatus.model_name,
    strataStatus.port,
  ]);

  /** 压测列表 = router 模型 + Strata 模型 */
  const allModels = useMemo(() => [...models, ...strataViews], [models, strataViews]);

  const [query, setQuery] = useState("");
  const [selId, setSelId] = useState<string | null>(null);

  // ---- API 压测 ----
  const [promptTokens, setPromptTokens] = useState(8192);
  const [maxTokens, setMaxTokens] = useState(256);
  const [concurrency, setConcurrency] = useState(1);
  const [svRunning, setSvRunning] = useState(false);
  const [svStatus, setSvStatus] = useState("");
  const [records, setRecords] = useState<BenchRecord[]>([]);
  const [stats, setStats] = useState<BenchStats | null>(null);
  /**
   * 统计行属于哪个模型（存选中的模型 id）。
   *
   * 原来 stats 只是"最后一次并发统计"，切了模型它照样插在新模型的表格顶部 ——
   * 数字是 A 的吞吐，下面的行全是 B 的记录。
   */
  const [statsFor, setStatsFor] = useState<string | null>(null);
  const [hw, setHw] = useState<Hardware | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const selected = allModels.find((m) => m.id === selId) ?? null;
  /** 选中的是 Strata 条目（id 前缀）—— 压测走 bench_strata，校验口径也不同 */
  const isStrata = !!selected && selected.id.startsWith("strata:");
  const strataConfigFile = isStrata ? selected!.id.slice("strata:".length) : "";
  /**
   * 请求体里的 model 必须是 **router 里的段名**（section），不是扫描 id。
   *
   * router 给子实例下发的是 --alias <段名>，改别名 = 改段名 = 改 router 认的模型名，
   * 拿扫描 id（Ornith-ai/xxx）去请求只会得到 HTTP 400：model '...' not found。
   */
  const apiModel = selected?.section ?? selId ?? "";
  const modelRecords = useMemo(
    // 旧记录里存的是当时的模型名（改名前后不一样），两种都认，历史记录才不会凭空消失
    () => (selId ? records.filter((r) => r.model === apiModel || r.model === selId) : []),
    [records, selId, apiModel],
  );

  /** 表格行：统计行（仅并发>1 的那一次）在最上面 */
  const rows: BenchRow[] = useMemo(
    () =>
      // 统计行只在"它压的就是当前这个模型"时才插到最上面
      stats && statsFor === selId
        ? [stats, ...[...modelRecords].reverse()]
        : [...modelRecords].reverse(),
    [stats, statsFor, selId, modelRecords],
  );

  const chartData = useMemo(
    () => modelRecords.filter((r) => !r.error && r.prompt_per_second > 0).slice(-30),
    [modelRecords],
  );

  // ---- 初始化 ----
  useEffect(() => {
    void ipc.benchHardware().then(setHw).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!benchDir) return;
    void ipc.benchRecords(benchDir).then(setRecords).catch(() => undefined);
  }, [benchDir]);

  // 默认选中第一个已加载的模型（留空会让人以为坏了）
  useEffect(() => {
    if (selId || models.length === 0) return;
    const first = models.find((m) => m.status === "loaded") ?? models[0];
    setSelId(first.id);
  }, [models, selId]);

  const selectModel = (id: string) => {
    // 压测进行中不切模型：结果要归到"开始时选中的那个"身上，中途换会把两次压测的
    // 数字拼进同一张表。列表项上也给了禁用态与说明，这里再兜一层（防止别的入口调进来）
    if (svRunning) return;
    setSelId(id);
    setSvStatus("");
    setStats(null);
    setStatsFor(null);
  };

  // ---- 图表（照搬 hub 的 canvas 手绘） ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = parent.getBoundingClientRect();
    const w = Math.max(0, rect.width - 4);
    const h = Math.max(0, rect.height - 4);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const textColor = css.getPropertyValue("--text-secondary").trim() || "#5f5f5f";
    const borderColor = css.getPropertyValue("--border-color").trim() || "#d9d9d9";

    const pad = { top: 10, bottom: 18, left: 40, right: 10 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    if (cw <= 0 || ch <= 0) return;

    const count = Math.max(1, Math.min(chartData.length, 30));
    const barW = Math.min((cw / count) * 0.35, 16);
    const gap = barW * 0.5;
    const gw = barW * 2 + gap;
    const value = (v: number) => {
      const n = Number(v) || 0;
      return n >= 100000 ? 0 : n;
    };
    let maxV = 10;
    for (const r of chartData) {
      maxV = Math.max(maxV, value(r.prompt_per_second), value(r.predicted_per_second));
    }
    maxV = Math.ceil(Math.max(maxV * 1.15, 10));

    // 坐标轴
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + ch);
    ctx.lineTo(pad.left + cw, pad.top + ch);
    ctx.stroke();

    // y 轴网格与刻度
    ctx.fillStyle = textColor;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i += 1) {
      const y = pad.top + ch - (ch / 4) * i;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + cw, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(fmtNum(maxV / 4 * i), pad.left - 5, y);
    }

    // 柱：紫=预填充，绿=生成
    const colors = ["rgba(99,102,241,0.85)", "rgba(16,185,129,0.85)"];
    chartData.forEach((r, i) => {
      const slot = cw / count;
      const x0 = pad.left + slot * i + (slot - gw) / 2;
      [value(r.prompt_per_second), value(r.predicted_per_second)].forEach((v, k) => {
        const bh = (v / maxV) * ch;
        ctx.fillStyle = colors[k];
        ctx.fillRect(x0 + k * (barW + gap), pad.top + ch - bh, barW, bh);
      });
    });
  }, [chartData]);

  // ---- 运行 API 压测 ----
  const runServer = async () => {
    if (svRunning) return;
    if (!selected) {
      setSvStatus("请选择模型");
      return;
    }
    // 没进 presets.ini 的模型 router 根本不认识，压测只会拿到 400，先给一句能看懂的话
    // （Strata 条目不走 router，没有 preset 这回事）
    if (!isStrata && !selected.inPreset) {
      setSvStatus("该模型还没保存进 presets.ini，请先在「模型列表」里保存配置");
      return;
    }
    if (!Number.isFinite(promptTokens) || promptTokens <= 0) {
      setSvStatus("提示词长度必须大于 0");
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      setSvStatus("输出长度必须大于 0");
      return;
    }
    if (!Number.isFinite(concurrency) || concurrency <= 0) {
      setSvStatus("并发数必须大于 0");
      return;
    }
    if (isStrata) {
      if (!strataStatus.running || !strataStatus.port) {
        setSvStatus("Strata 未运行");
        return;
      }
      if (strataStatus.model_name && strataStatus.model_name !== selected.section) {
        setSvStatus("Strata 当前运行的是「" + strataStatus.model_name + "」，请先在「Strata」页启动该模型");
        return;
      }
    } else if (!status.running || status.port == null) {
      setSvStatus("router 未运行");
      return;
    }

    // 记下这次压的是谁：跑完写 stats 时要带上它，中途状态被改也不会张冠李戴
    const runModelId = selId;
    setSvRunning(true);
    setStats(null);
    setStatsFor(null);
    setSvStatus(concurrency > 1 ? "并发压测中（" + concurrency + "）…" : "压测中…");
    try {
      const result = isStrata
        ? await ipc.benchStrata({
            root: settings?.strata_root ?? "",
            configFile: strataConfigFile,
            promptTokens,
            maxTokens,
            concurrency,
          })
        : await ipc.benchServer({
            host: "127.0.0.1",
            port: status.port,
            apiKey: settings?.api_key ?? null,
            model: apiModel,
            promptTokens,
            maxTokens,
            concurrency,
          });
      const ok = result.filter((r) => !r.error);
      if (ok.length > 0) {
        const saved = await ipc.benchRecordsAdd(benchDir, result);
        setRecords(saved);
        if (concurrency > 1 && ok.length > 1) {
          setStats(computeStats(ok));
          setStatsFor(runModelId);
        }
        setSvStatus(concurrency > 1 ? "完成 " + ok.length + "/" + result.length : "完成");
      } else {
        setSvStatus("全部失败：" + (result[0]?.error ?? "未知错误"));
      }
    } catch (err) {
      setSvStatus("测试失败：" + String(err));
    } finally {
      setSvRunning(false);
    }
  };

  const deleteRecord = async (r: BenchRecord) => {
    if (!confirm("确定删除该记录吗？")) return;
    try {
      setRecords(await ipc.benchRecordsDelete(benchDir, r.ts_ms));
      setStats(null);
      setStatsFor(null);
    } catch (err) {
      setError("删除失败：" + String(err));
    }
  };

  // ---- 导出记录 ----
  const saveText = async (defaultName: string, content: string, filterName: string) => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const ext = defaultName.split(".").pop() ?? "txt";
      const path = await save({
        title: "导出",
        defaultPath: defaultName,
        filters: [{ name: filterName, extensions: [ext] }],
      });
      if (!path) return;
      await ipc.saveTextFile(path, content);
    } catch (err) {
      setError("导出失败：" + String(err));
    }
  };

  const exportRecords = async (kind: "csv" | "json" | "md") => {
    const ok = modelRecords.filter((r) => !r.error);
    if (ok.length === 0) {
      setError("没有可导出的数据");
      return;
    }
    const payload = toExportRows(
      ok,
      hw ?? { cpu: "", ram_gb: null },
      devices.map((d) => d.name + ": " + d.description),
    );
    const text = kind === "csv" ? toCsv(payload) : kind === "json" ? toJson(payload) : toMarkdown(payload);
    await saveText(
      "benchmark_" + (apiModel || "server").replace(/[\\/]/g, "_") + "." + kind,
      text,
      { csv: "CSV", json: "JSON", md: "Markdown" }[kind],
    );
    setNotice("已导出 " + ok.length + " 条记录");
  };

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? allModels.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      : allModels;
    return [...list].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [allModels, query]);

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>性能测试</span>{" "}
          <span className="model-count-badge">{modelRecords.length} 条记录</span>
        </h1>
        <div className="top-actions">
          <span className="form-text" style={{ marginTop: 0 }}>
            {/* 选中 Strata 模型时顶栏显示 Strata 的状态，否则显示 router 的 */}
            {isStrata
              ? strataStatus.running
                ? "Strata :" + strataStatus.port
                : "Strata 未运行"
              : status.running
                ? "router :" + status.port
                : "router 未运行"}
          </span>
        </div>
      </div>

      <div className="page-fill">
        <div className="bench-split">
          {/* ============ 左栏：模型选择 ============ */}
          <div className="bench-models">
            <div className="search-wrap" style={{ maxWidth: "none", marginBottom: 8 }}>
              <i className="fas fa-search" />
              <input
                type="search"
                placeholder="搜索模型…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="bench-model-list">
              {filteredModels.length === 0 ? (
                <div className="bench-model-empty">
                  {allModels.length === 0 ? "暂无模型" : "没有匹配的模型"}
                </div>
              ) : (
                filteredModels.map((m) => (
                  <div
                    key={m.id}
                    className={m.id === selId ? "bm-item active" : "bm-item"}
                    /* 压测中禁止切换：见 selectModel 的注释 */
                    style={svRunning ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    title={svRunning ? "压测进行中：请等这次跑完再换模型（结果会归到开始时的模型上）" : undefined}
                    onClick={() => selectModel(m.id)}
                  >
                    <div className="bm-name">
                      {m.name}
                      {/* 两条通道的模型混在一个列表里，标出来源才不会压错对象 */}
                      {m.group === "strata" && (
                        <span
                          style={{
                            marginLeft: 6,
                            fontSize: "0.72rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          Strata
                        </span>
                      )}
                    </div>
                    <div className="bm-meta">
                      {m.status === "loaded" && (
                        <span className="bm-loaded">
                          <i className="fas fa-circle" />
                          运行中
                        </span>
                      )}
                      <span>
                        <i className="fas fa-hdd" />
                        {fmtSize(m.sizeBytes ?? 0)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ============ 右栏：API 压测 ============ */}
          <div className="bench-main">
            <div className="bench-pane">
              <div className="card">
                <div className="bench-run-row">
                  <div className="field">
                    <label>提示词长度</label>
                    <input
                      type="number"
                      className="form-control"
                      min={1}
                      value={promptTokens}
                      onChange={(e) => setPromptTokens(Number(e.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label>输出长度</label>
                    <input
                      type="number"
                      className="form-control"
                      min={1}
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(Number(e.target.value))}
                    />
                  </div>
                  <div className="field">
                    <label>并发数</label>
                    <input
                      type="number"
                      className="form-control"
                      min={1}
                      step={1}
                      value={concurrency}
                      onChange={(e) => setConcurrency(Number(e.target.value))}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={svRunning || !selected || selected.status !== "loaded"}
                    title={
                      svRunning
                        ? "压测进行中，需要跑完一轮（无法中途取消）"
                        : selected && selected.status !== "loaded"
                          ? "模型未运行，无法运行测试"
                          : ""
                    }
                    onClick={() => void runServer()}
                  >
                    <i className={"fas " + (svRunning ? "fa-spinner fa-spin" : "fa-play")} />
                    {svRunning ? "压测中…" : "运行"}
                  </button>
                </div>
                <div className="form-text" style={{ minHeight: 18 }}>
                  {svStatus}
                </div>
              </div>

              <div className="card">
                <div className="bench-card-head">
                  <h3>速度对比</h3>
                  <span className="form-text" style={{ marginTop: 0 }}>
                    最近 30 次 · 紫=预填充 绿=生成
                  </span>
                </div>
                <div className="bench-chart-wrap">
                  <canvas ref={canvasRef} />
                  {chartData.length === 0 && (
                    <div className="bench-chart-empty">
                      <i className="fas fa-chart-column" />
                      暂无数据
                    </div>
                  )}
                </div>
              </div>

              <div className="card bench-records">
                <div className="bench-card-head">
                  <h3>测试记录</h3>
                  <div className="row-gap">
                    <button type="button" className="btn mini" onClick={() => void exportRecords("csv")}>
                      <i className="fas fa-file-csv" /> CSV
                    </button>
                    <button type="button" className="btn mini" onClick={() => void exportRecords("json")}>
                      <i className="fas fa-file-code" /> JSON
                    </button>
                    <button type="button" className="btn mini" onClick={() => void exportRecords("md")}>
                      <i className="fas fa-file-lines" /> MD
                    </button>
                  </div>
                </div>
                <div className={rows.length === 0 ? "bench-table-wrap is-empty" : "bench-table-wrap"}>
                  <table className="bench-table data-table">
                    <thead>
                      <tr>
                        <th>时间</th>
                        <th className="num">提示词</th>
                        <th className="num">预填充 t/s</th>
                        <th className="num">输出</th>
                        <th className="num">生成 t/s</th>
                        <th>投机解码</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, idx) =>
                        isStats(row) ? (
                          <tr className="stats-row" key={"stats-" + row.timestamp}>
                            <td>并发×{row.count}</td>
                            <td className="num">{fmtNum(row.promptN.avg)}</td>
                            <td className="num">{statsCell(row.prefill)}</td>
                            <td className="num">{fmtNum(row.predictedN.avg)}</td>
                            <td className="num">{statsCell(row.decode)}</td>
                            <td />
                            <td />
                          </tr>
                        ) : (
                          <tr key={row.ts_ms + "-" + idx}>
                            <td>{fmtTs(row.ts_ms)}</td>
                            <td className="num">{row.error ? "—" : fmtNum(row.prompt_tokens)}</td>
                            <td className={"num " + speedClass("prefill", row.prompt_per_second)}>
                              {row.error ? "—" : fmtNum(row.prompt_per_second)}
                            </td>
                            <td className="num">{row.error ? "—" : fmtNum(row.predicted_tokens)}</td>
                            <td className={"num " + speedClass("decode", row.predicted_per_second)}>
                              {row.error ? "—" : fmtNum(row.predicted_per_second)}
                            </td>
                            <td>{row.error ? <span className="sp-slow">{row.error}</span> : draftText(row)}</td>
                            <td>
                              <button
                                type="button"
                                className="icon-btn"
                                title="删除记录"
                                onClick={() => void deleteRecord(row)}
                              >
                                <i className="fas fa-trash" />
                              </button>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                {rows.length === 0 && (
                  <div className="empty-state">
                    <div className="empty-state-icon">
                      <i className="fas fa-flask" />
                    </div>
                    <div className="empty-state-text">选择左侧模型开始测试</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
