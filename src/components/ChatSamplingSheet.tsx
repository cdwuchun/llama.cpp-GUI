import { useState } from "react";

import { DEFAULT_CHAT_OPTIONS, normalizeChatOptions, type ChatOptions, type ReasoningEffort } from "../utils/chat";
import { useApp } from "../store";
import { ChatMcpSettings } from "./ChatMcpSettings";
import { ChatSearchSettings } from "./ChatSearchSettings";
import { Drawer } from "./Drawer";

const EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "off", label: "关" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
];

const EFFORT_HINT: Record<ReasoningEffort, string> = {
  off: "直接回答，不写思考过程",
  low: "想得很短，速度优先",
  medium: "适中",
  high: "想得最久，质量优先",
};

/**
 * 采样设置（照上游 `ChatSettings.tsx` 的 `SamplingDrawer`）。
 *
 * 保留的是通用采样：思考强度、temperature、top-p、top-k、输出上限、随机种子、
 * 显示思考、系统提示；工具两项（联网搜索、MCP）由 GUI 执行，见 `src/utils/tools.ts`。
 * 上游那版还有共享默认值、速度预测、高级选项（JSON Schema / logit_bias / 固定前缀）——
 * 这些依赖 Strata 引擎能力，llama.cpp 没有对应端点，整块不显示。
 */
export function ChatSamplingSheet({
  options,
  models,
  onApply,
  onClose,
}: {
  options: ChatOptions;
  models: string[];
  onApply: (next: ChatOptions) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ChatOptions>(() => ({ ...options }));
  const update = <K extends keyof ChatOptions>(key: K, value: ChatOptions[K]) =>
    setDraft((old) => ({ ...old, [key]: value }));

  return (
    <Drawer
      title="采样设置"
      iconClass="fa-gear"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="st-btn st-btn--secondary"
            onClick={() =>
              setDraft({ ...DEFAULT_CHAT_OPTIONS, model: draft.model, systemPrompt: draft.systemPrompt })
            }
          >
            重置
          </button>
          <button
            type="button"
            className="st-btn st-btn--primary"
            onClick={() => {
              onApply(normalizeChatOptions(draft));
              onClose();
            }}
          >
            应用
          </button>
        </>
      }
    >
      <div className="chat-sampling">
        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-model">
            模型
          </label>
          <select
            id="chat-s-model"
            className="st-input"
            value={draft.model}
            onChange={(event) => update("model", event.target.value)}
          >
            <option value="">（用当前已加载的模型）</option>
            {models.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <p className="st-hint">
            只列正在运行的模型；要换模型先去模型页加载（发送时也按这份列表校验，避免「显示一个、
            请求另一个」）
          </p>
        </div>

        <div className="st-field">
          <label className="st-label">
            思考强度
            <output>{EFFORT_HINT[draft.reasoningEffort]}</output>
          </label>
          <div className="chat-segmented" role="group" aria-label="思考强度">
            {EFFORTS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`chat-segmented__item${draft.reasoningEffort === item.value ? " is-on" : ""}`}
                aria-pressed={draft.reasoningEffort === item.value}
                onClick={() => update("reasoningEffort", item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-temp">
            temperature
            <output>{draft.temperature === 0 ? "贪心" : draft.temperature.toFixed(2)}</output>
          </label>
          <input
            id="chat-s-temp"
            type="range"
            className="chat-slider"
            min={0}
            max={1.5}
            step={0.05}
            value={draft.temperature}
            onChange={(event) => update("temperature", Number(event.target.value))}
          />
          <span className="st-hint">0 表示每次都取概率最高的词（贪心），此时 top-p / top-k 不起作用</span>
        </div>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-topp">
            top-p<output>{draft.topP.toFixed(2)}</output>
          </label>
          <input
            id="chat-s-topp"
            type="range"
            className="chat-slider"
            min={0.05}
            max={1}
            step={0.05}
            value={draft.topP}
            disabled={draft.temperature === 0}
            onChange={(event) => update("topP", Number(event.target.value))}
          />
        </div>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-topk">
            top-k<output>{draft.topK}</output>
          </label>
          <input
            id="chat-s-topk"
            type="range"
            className="chat-slider"
            min={1}
            max={64}
            step={1}
            value={draft.topK}
            disabled={draft.temperature === 0}
            onChange={(event) => update("topK", Number(event.target.value))}
          />
        </div>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-max">
            输出上限 token
            <output>留空 = 直到写完</output>
          </label>
          <input
            id="chat-s-max"
            type="number"
            className="st-input"
            min={1}
            step={1}
            placeholder="直到写完"
            value={draft.maxTokens || ""}
            onChange={(event) =>
              update(
                "maxTokens",
                event.target.value === "" ? 0 : Math.max(1, Math.floor(Number(event.target.value))),
              )
            }
          />
        </div>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-seed">
            随机种子
            <output>留空 = 每次随机</output>
          </label>
          <input
            id="chat-s-seed"
            type="number"
            className="st-input"
            min={1}
            step={1}
            placeholder="随机"
            value={draft.seed ?? ""}
            onChange={(event) =>
              update("seed", event.target.value === "" ? null : Math.max(1, Math.floor(Number(event.target.value))))
            }
          />
        </div>

        <label className="bench-switch chat-sampling__switch">
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.webSearch}
            onChange={(event) => update("webSearch", event.target.checked)}
          />
          <span>
            联网搜索
            <br />
            <span className="muted small">
              模型需要查资料时会自己调用（搜索 + 读网页正文），执行由 GUI 完成（llama.cpp 自己不联网）
            </span>
          </span>
        </label>

        {draft.webSearch ? (
          <details className="st-collapse search-settings__fold">
            <summary>
              <i className="fas fa-globe" />
              <span>搜索引擎与 key</span>
              <i className="fas fa-chevron-down st-chev" />
            </summary>
            <div className="st-collapse__body">
              <ChatSearchSettings />
            </div>
          </details>
        ) : null}

        <label className="bench-switch chat-sampling__switch">
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.mcpTools}
            onChange={(event) => {
              const on = event.target.checked;
              update("mcpTools", on);
              // 打开时顺手连一遍：开关关着的时候不启动任何子进程
              if (on) void useApp.getState().refreshMcpTools();
            }}
          />
          <span>
            MCP 工具
            <br />
            <span className="muted small">
              把下面配的 MCP 服务器的工具交给模型调用（由 GUI 执行，与联网搜索同一条链路）
            </span>
          </span>
        </label>

        {draft.mcpTools ? (
          <details className="st-collapse search-settings__fold">
            <summary>
              <i className="fas fa-plug" />
              <span>MCP 服务器</span>
              <i className="fas fa-chevron-down st-chev" />
            </summary>
            <div className="st-collapse__body">
              <ChatMcpSettings />
            </div>
          </details>
        ) : null}

        {/* 发送快捷键从输入框挪到这里（用户 m07816 第 3 点）：让用户自己选 */}
        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-enter">
            发送键
          </label>
          <select
            id="chat-s-enter"
            className="st-input"
            value={draft.enterSends ? "enter" : "ctrl"}
            onChange={(event) => update("enterSends", event.target.value === "enter")}
          >
            <option value="enter">Enter 发送，Shift+Enter 换行</option>
            <option value="ctrl">Ctrl+Enter 发送，Enter 换行</option>
          </select>
        </div>

        <label className="bench-switch chat-sampling__switch">
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.showReasoning}
            onChange={(event) => update("showReasoning", event.target.checked)}
          />
          <span>
            显示思考过程
            <br />
            <span className="muted small">关掉只是不展开显示，模型照样在思考</span>
          </span>
        </label>

        <label className="bench-switch chat-sampling__switch">
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.showMath}
            onChange={(event) => update("showMath", event.target.checked)}
          />
          <span>
            渲染数学公式
            <br />
            <span className="muted small">
              $…$ / $$…$$ / \( \) / \[ \] 用内置 KaTeX 排成公式，关掉就显示源码
            </span>
          </span>
        </label>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-busy">
            生成中发送
          </label>
          <select
            id="chat-s-busy"
            className="st-input"
            value={draft.busyMode}
            onChange={(event) => update("busyMode", event.target.value as ChatOptions["busyMode"])}
          >
            <option value="wait">等待（这一轮结束后自己点发送）</option>
            <option value="queue">排队（这段在当前回答结束后自动发送）</option>
            <option value="interrupt">打断（立刻中止当前回答，再发这段）</option>
          </select>
          <p className="st-hint">模型正在回答时你在输入框里按下发送键会发生什么</p>
        </div>

        <label className="bench-switch chat-sampling__switch">
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.chatList}
            onChange={(event) => update("chatList", event.target.checked)}
          />
          <span>
            显示会话列表
            <br />
            <span className="muted small">关掉后左侧历史栏整块收起，只留当前会话</span>
          </span>
        </label>

        <label className="bench-switch chat-sampling__switch">
          <input
            type="checkbox"
            className="switch-input"
            checked={draft.chatEdit}
            onChange={(event) => update("chatEdit", event.target.checked)}
          />
          <span>
            允许编辑与回退
            <br />
            <span className="muted small">
              打开后每条消息下面有「回到这里 / 开分支 / 重新生成 / 改写」，改错了可以撤销
            </span>
          </span>
        </label>

        <div className="st-field">
          <label className="st-label" htmlFor="chat-s-system">
            系统提示
          </label>
          <textarea
            id="chat-s-system"
            className="st-input"
            rows={4}
            value={draft.systemPrompt}
            onChange={(event) => update("systemPrompt", event.target.value)}
          />
        </div>
      </div>
    </Drawer>
  );
}
