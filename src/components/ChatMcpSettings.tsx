import { useCallback, useEffect, useState } from "react";

import { ipc } from "../ipc";
import type { McpServerConfig, McpToolsView } from "../types";

const errText = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "操作失败";

/** 面板里的编辑态：args / env 用多行文本，保存时再拆 */
interface Draft {
  name: string;
  command: string;
  argsText: string;
  envText: string;
  enabled: boolean;
}

const toDraft = (server: McpServerConfig): Draft => ({
  name: server.name,
  command: server.command,
  argsText: server.args.join("\n"),
  envText: Object.entries(server.env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n"),
  enabled: server.enabled,
});

const fromDraft = (draft: Draft): McpServerConfig => ({
  name: draft.name.trim(),
  command: draft.command.trim(),
  args: draft.argsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
  env: Object.fromEntries(
    draft.envText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      // 只按第一个 `=` 切：值里带 `=` 的（base64、URL 参数）不能被截断
      .map((line) => {
        const at = line.indexOf("=");
        return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : null;
      })
      .filter((pair): pair is [string, string] => pair !== null && pair[0] !== ""),
  ),
  enabled: draft.enabled,
});

const blank = (): Draft => ({ name: "", command: "", argsText: "", envText: "", enabled: true });

/**
 * MCP 工具的设置（跟「联网搜索」并列，都在采样设置抽屉里）。
 *
 * 服务器是**本机 stdio 子进程**：命令 + 参数 + 环境变量，和 Cursor 的 `mcpServers`
 * 一个形状（`npx -y @modelcontextprotocol/server-filesystem D:\dir` 这种写法直接能用）。
 * 后端把它们存在 `<配置目录>\mcp.json`，拉起进程、拉工具、执行调用都在
 * `src-tauri/src/mcp.rs`；这里只管编辑。
 *
 * 保存时后端会停掉所有已启动的进程（命令改了必须重连才生效），所以保存完要重新检测一次，
 * 才能看到新的工具表与逐台状态。
 */
export function ChatMcpSettings() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [view, setView] = useState<McpToolsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 读磁盘上的配置，并把启用的服务器连一遍（没有启用的服务器就不连，省得白等超时） */
  const load = useCallback(async () => {
    // 连接可能等超时：置 busy 让按钮显示「检测中…」，也挡住连点重复发起（审查发现）
    setBusy(true);
    setError(null);
    try {
      const servers = await ipc.mcpServers();
      setDrafts(servers.map(toDraft));
      setView(
        servers.some((server) => server.enabled)
          ? await ipc.mcpTools()
          : { tools: [], servers: [] },
      );
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const servers = await ipc.mcpServers();
        if (!alive) return;
        setDrafts(servers.map(toDraft));
        if (servers.some((server) => server.enabled)) {
          const tools = await ipc.mcpTools();
          if (alive) setView(tools);
        } else {
          setView({ tools: [], servers: [] });
        }
      } catch (err) {
        if (alive) setError(errText(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const update = (index: number, patch: Partial<Draft>) =>
    setDrafts((list) => list.map((item, at) => (at === index ? { ...item, ...patch } : item)));

  const save = async () => {
    // 名称是工具归属的索引、命令是必填项：空着保存只会让后端连不上还不知道为什么（审查发现）
    if (drafts.some((draft) => !draft.name.trim() || !draft.command.trim())) {
      setError("每个 MCP 服务器都要填名称和启动命令");
      return;
    }
    const names = drafts.map((draft) => draft.name.trim());
    if (new Set(names).size !== names.length) {
      setError("服务器名称不能重复（后端按名字索引工具归属）");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await ipc.mcpSaveServers(drafts.map(fromDraft));
      setNotice("已保存，正在重新连接…");
      await load();
      setNotice("已保存并重新检测");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const statusOf = (name: string) => view?.servers.find((item) => item.name === name) ?? null;
  const toolCount = view?.tools.length ?? 0;

  return (
    <div className="search-settings mcp-settings">
      <p className="st-hint">
        MCP 服务器是本机子进程（stdio），命令与参数照 Cursor 的 <code>mcpServers</code> 填。
        模型需要时会自己调用，工具由 GUI 执行；GUI 退出时这些进程一并停掉。
      </p>

      <div className="search-settings__engines">
        {drafts.length === 0 ? (
          <p className="st-hint">还没有服务器。点下面的「添加服务器」，例如：</p>
        ) : null}
        {drafts.map((draft, index) => {
          const status = statusOf(draft.name.trim());
          return (
            <div className={`search-engine${draft.enabled ? " is-on" : ""}`} key={index}>
              <div className="search-engine__head">
                <label className="bench-switch search-engine__toggle">
                  <input
                    type="checkbox"
                    className="switch-input"
                    checked={draft.enabled}
                    onChange={(event) => update(index, { enabled: event.target.checked })}
                  />
                  <span>{draft.name.trim() || "未命名服务器"}</span>
                </label>
                {status?.ok ? <span className="st-badge st-badge--ok">{status.count} 个工具</span> : null}
                {status && !status.ok ? <span className="st-badge st-badge--error">连不上</span> : null}
                <span className="spacer" />
                <button
                  type="button"
                  className="st-btn st-btn--icon"
                  title="删除这台服务器"
                  aria-label={`删除 ${draft.name || "服务器"}`}
                  onClick={() => setDrafts((list) => list.filter((_, at) => at !== index))}
                >
                  <i className="fas fa-trash-can" />
                </button>
              </div>

              <div className="search-settings__row">
                <div className="st-field">
                  <label className="st-label" htmlFor={`mcp-name-${index}`}>
                    名称
                  </label>
                  <input
                    id={`mcp-name-${index}`}
                    className="st-input"
                    placeholder="files"
                    value={draft.name}
                    onChange={(event) => update(index, { name: event.target.value })}
                  />
                </div>
                <div className="st-field">
                  <label className="st-label" htmlFor={`mcp-command-${index}`}>
                    命令
                  </label>
                  <input
                    id={`mcp-command-${index}`}
                    className="st-input"
                    placeholder="npx.cmd"
                    value={draft.command}
                    onChange={(event) => update(index, { command: event.target.value })}
                  />
                </div>
              </div>

              <div className="st-field">
                <label className="st-label" htmlFor={`mcp-args-${index}`}>
                  参数
                </label>
                <textarea
                  id={`mcp-args-${index}`}
                  className="st-input"
                  rows={2}
                  placeholder={"一行一个参数，例如\n-y\n@modelcontextprotocol/server-filesystem\nD:\\docs"}
                  value={draft.argsText}
                  onChange={(event) => update(index, { argsText: event.target.value })}
                />
              </div>

              <div className="st-field">
                <label className="st-label" htmlFor={`mcp-env-${index}`}>
                  环境变量
                </label>
                <textarea
                  id={`mcp-env-${index}`}
                  className="st-input"
                  rows={2}
                  placeholder={"一行一个 KEY=VALUE（可留空）"}
                  value={draft.envText}
                  onChange={(event) => update(index, { envText: event.target.value })}
                />
              </div>

              {status && !status.ok ? <p className="msg-error">{status.error ?? "连接失败"}</p> : null}
            </div>
          );
        })}
      </div>

      <div className="search-settings__row">
        <button
          type="button"
          className="st-btn st-btn--secondary"
          onClick={() => setDrafts((list) => [...list, blank()])}
        >
          <i className="fas fa-plus" /> 添加服务器
        </button>
        <button
          type="button"
          className="st-btn st-btn--secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "检测中…" : "重新检测"}
        </button>
      </div>

      <p className="st-hint">
        {toolCount > 0 ? `当前可用 ${toolCount} 个工具。` : "当前没有可用工具。"}
        {" "}
        「重新检测」会丢弃未保存的改动。
      </p>

      {error ? <p className="msg-error">{error}</p> : null}
      {notice ? <p className="st-hint">{notice}</p> : null}

      <button type="button" className="st-btn st-btn--primary" disabled={busy} onClick={() => void save()}>
        {busy ? "保存中…" : "保存 MCP 配置"}
      </button>
    </div>
  );
}
