import { useApp } from "../store";

function Tag({ ok, warn, children, title }: { ok?: boolean; warn?: boolean; children: React.ReactNode; title?: string }) {
  const color = ok ? "var(--text-primary)" : warn ? "var(--warning-color)" : "var(--text-secondary)";
  return (
    <span className="tag" style={{ color }} title={title}>
      {children}
    </span>
  );
}

function mib(value: number | null): string {
  if (value == null) return "—";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GiB` : `${value} MiB`;
}

export function RuntimePanel() {
  const versions = useApp((s) => s.versions);
  const devices = useApp((s) => s.devices);
  const cudaReady = useApp((s) => s.cudaReady);
  const deviceError = useApp((s) => s.deviceError);
  const settings = useApp((s) => s.settings);
  const paths = useApp((s) => s.paths);
  const busy = useApp((s) => s.busy);
  const status = useApp((s) => s.status);
  const refreshVersions = useApp((s) => s.refreshVersions);
  const refreshDevices = useApp((s) => s.refreshDevices);
  const saveSettings = useApp((s) => s.saveSettings);
  const startRouter = useApp((s) => s.startRouter);
  const stopRouter = useApp((s) => s.stopRouter);

  const selected = settings?.selected_version ?? null;

  return (
    <main className="main-area">
      <div className="top-bar">
        <h1 className="page-title">
          <span>运行环境</span>{" "}
          <span className="model-count-badge">{versions.length} 个版本</span>
        </h1>
        <div className="top-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || !settings?.llama_cpp_dir}
            onClick={() => void refreshVersions(true)}
          >
            <i className="fas fa-radar" />
            <span>扫描版本</span>
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void refreshDevices()}>
            <i className="fas fa-microchip" />
            <span>重新枚举设备</span>
          </button>
          {status.running ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => void stopRouter()}
            >
              <i className="fas fa-stop" />
              <span>停止 router</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !settings?.llama_cpp_dir}
              onClick={() => void startRouter()}
            >
              <i className="fas fa-play" />
              <span>启动 router</span>
            </button>
          )}
        </div>
      </div>

      <div className="content-scrollable">
        {deviceError && (
          <div className="notice warn">
            <i className="fas fa-triangle-exclamation" /> {deviceError}
          </div>
        )}

        <div className="panel" style={{ marginTop: "1.5rem" }}>
          <div className="panel-head">
            <i className="fas fa-cubes" />
            <span>已发现的 llama.cpp 版本</span>
            <span className="grow" />
            <span className="form-text" style={{ marginTop: 0 }}>
              {versions.length} 个
            </span>
          </div>

          {versions.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <i className="fas fa-folder-open" />
              </div>
              <div className="empty-state-text">
                未发现版本。请在「设置」里指定 llama.cpp 安装目录（其下可含多个版本子目录）。
              </div>
            </div>
          ) : (
            <div className="panel-body">
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 50 }}>选择</th>
                      <th>版本</th>
                      <th>Router Mode</th>
                      <th>路径</th>
                      <th>共享 CUDA 运行时</th>
                      <th>fit-params</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr key={v.name}>
                        <td>
                          <input
                            type="radio"
                            name="version"
                            checked={selected === v.name}
                            onChange={() => void saveSettings({ selected_version: v.name })}
                          />
                        </td>
                        <td className="mono">{v.name}</td>
                        <td>
                          <Tag
                            ok={v.has_router_mode === true}
                            warn={v.has_router_mode === null}
                          >
                            {v.has_router_mode === true
                              ? "支持"
                              : v.has_router_mode === false
                                ? "不支持"
                                : "未探测"}
                          </Tag>
                        </td>
                        <td>
                          <Tag ok={v.ascii_safe} warn={!v.ascii_safe}>
                            {v.ascii_safe ? "纯 ASCII" : "含非 ASCII（自动用链接目录）"}
                          </Tag>
                        </td>
                        <td>
                          {v.shared_lib_dirs.length === 0 ? (
                            <Tag
                              warn
                              title="未匹配到直接包含 cudart64_/cublas64_ 的目录，GPU 将不可用"
                            >
                              未匹配
                            </Tag>
                          ) : (
                            v.shared_lib_dirs.map((d) => (
                              <div key={d} className="mono" style={{ fontSize: "0.78rem" }} title={d}>
                                {d.split(/[\\/]/).pop()}
                              </div>
                            ))
                          )}
                        </td>
                        <td>{v.fit_params_bin ? <i className="fas fa-check" /> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">
            <i className="fas fa-microchip" />
            <span>推理设备</span>
            <span className="grow" />
            <span className="form-text" style={{ marginTop: 0 }}>
              {devices.length} 个
            </span>
          </div>

          {devices.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <i className="fas fa-microchip" />
              </div>
              <div className="empty-state-text">
                {cudaReady
                  ? "枚举中…"
                  : "未枚举到设备（若已装 NVIDIA 显卡，通常是共享 CUDA 运行时未就绪）"}
              </div>
            </div>
          ) : (
            <div className="panel-body">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>设备</th>
                    <th>型号</th>
                    <th>总显存</th>
                    <th>空闲显存</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr key={d.name}>
                      <td className="mono">{d.name}</td>
                      <td>{d.description}</td>
                      <td>{mib(d.total_mib)}</td>
                      <td>{mib(d.free_mib)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="notice">
          <i className="fas fa-circle-info" style={{ marginTop: 2 }} />
          <div>
            <strong>多卡策略：</strong>只要不显式设置 GPU 层数与张量切分，llama.cpp 默认的 <code>--fit</code>{" "}
            会在每次加载模型时测量每张卡的空闲显存，自动把层分配到所有可见设备并生成 <code>--tensor-split</code>。
            <div className="row" style={{ marginTop: 8, gap: "0.5rem" }}>
              <span className="tag">
                设备：{settings?.gpu.devices.length ? settings.gpu.devices.join(", ") : "全部可见设备"}
              </span>
              <span className="tag">split-mode：{settings?.gpu.split_mode ?? "layer"}</span>
              <span className="tag">fit：{settings?.gpu.fit === false ? "off" : "on（默认）"}</span>
              <span className="tag">
                GPU 层数：{settings?.gpu.n_gpu_layers ? settings.gpu.n_gpu_layers : "auto（不传 -ngl）"}
              </span>
            </div>
          </div>
        </div>

        <div className="grid2">
          <div className="info-card">
            <div className="k">配置目录</div>
            <div className="mono" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
              {paths?.config_dir ?? "—"}
            </div>
          </div>
          <div className="info-card">
            <div className="k">presets.ini（交给 router 的原生预设）</div>
            <div className="mono" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
              {paths?.preset_path ?? "—"}
            </div>
          </div>
          <div className="info-card">
            <div className="k">ASCII 链接目录</div>
            <div className="mono" style={{ fontSize: "0.78rem", wordBreak: "break-all" }}>
              {paths?.link_root ?? "—"}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
