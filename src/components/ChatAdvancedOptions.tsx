import { useEffect, useMemo, useState } from "react";

import { readSharedSampling, saveSharedSampling } from "../api/strata";
import { useApp } from "../store";
import {
  DEFAULT_CHAT_OPTIONS,
  buildSharedDefaults,
  parseChatLogitBias,
  type ChatAdvanced,
  type ChatOptions,
  type ChatTurn,
} from "../utils/chat";

/**
 * 高级回答设置（照上游 `ChatAdvancedOptions.tsx`）。
 *
 * 这些字段只有 **Strata 通道**的模型认（llama.cpp 的 `/v1/chat/completions` 没有
 * `response_format` / `logit_bias` / `strata_prefix` 这些扩展）。所以整块照常显示，
 * 但 `buildChatRequest` 只在模型走 Strata 通道时才把它们发出去 —— 用户 m00232 的 B1。
 */
export function ChatAdvancedOptions({
  options,
  messages,
  strata,
  onChange,
}: {
  options: ChatOptions;
  messages: ChatTurn[];
  strata: boolean;
  onChange: (next: ChatOptions) => void;
}) {
  const advanced = options.advanced;
  const setAdvanced = (patch: Partial<ChatAdvanced>) =>
    onChange({ ...options, advanced: { ...advanced, ...patch } });

  const docs = useMemo(
    () => messages.filter((message) => message.role === "user" && message.content.trim().length > 0),
    [messages],
  );
  const enginePort = useApp((state) => state.strataStatus.port);
  const [shared, setShared] = useState(false);
  const [sharedError, setSharedError] = useState("");
  const [sharedBusy, setSharedBusy] = useState(false);

  useEffect(() => {
    if (!strata || !enginePort) return;
    let alive = true;
    readSharedSampling(enginePort)
      .then((on) => {
        if (alive) setShared(on);
      })
      .catch(() => {
        // 旧版服务端没有这个端点：开关就保持关着，不打扰
        if (alive) setShared(false);
      });
    return () => {
      alive = false;
    };
  }, [strata, enginePort]);

  const toggleShared = async (on: boolean) => {
    if (!enginePort) return;
    setSharedBusy(true);
    setSharedError("");
    const defaults = on
      ? { ...buildSharedDefaults(options), experimental_speed_projection: options.esp }
      : null;
    try {
      setShared(await saveSharedSampling(enginePort, defaults));
    } catch (error) {
      setSharedError(error instanceof Error ? error.message : String(error));
    } finally {
      setSharedBusy(false);
    }
  };

  const biasError = useMemo(() => {
    if (!advanced.logitBiasText.trim()) return "";
    try {
      parseChatLogitBias(advanced.logitBiasText);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, [advanced.logitBiasText]);

  const schemaError = useMemo(() => {
    if (advanced.responseFormat !== "json_schema" || !advanced.schemaText.trim()) return "";
    try {
      const value: unknown = JSON.parse(advanced.schemaText);
      if (!value || typeof value !== "object" || Array.isArray(value)) return "JSON Schema 根节点需为对象";
      if ((value as Record<string, unknown>).type !== "object") return "JSON Schema 根类型必须只接受对象";
      return "";
    } catch {
      return "Schema 不是有效 JSON";
    }
  }, [advanced.responseFormat, advanced.schemaText]);

  return (
    <>
      <p className="st-hint">
        {strata
          ? "下面这些会随请求发给 Strata 引擎；llama.cpp 通道不支持，切过去会自动忽略。"
          : "当前模型走 llama.cpp 通道，下面这些字段不会发送 —— 换成 Strata 通道的模型才生效。"}
      </p>

      <div className="st-field">
        <label className="st-label" htmlFor="chat-a-format">
          输出格式
        </label>
        <select
          id="chat-a-format"
          className="st-input"
          value={advanced.responseFormat}
          onChange={(event) =>
            setAdvanced({ responseFormat: event.target.value as ChatAdvanced["responseFormat"] })
          }
        >
          <option value="text">普通文本</option>
          <option value="json_object">JSON 对象</option>
          <option value="json_schema">JSON Schema（约束字段）</option>
        </select>
        {advanced.responseFormat !== "text" ? (
          <p className="st-hint">JSON 输出和工具调用互斥 —— 开着联网搜索 / MCP 发不出去。</p>
        ) : null}
      </div>

      {advanced.responseFormat === "json_schema" ? (
        <>
          <div className="st-field">
            <label className="st-label" htmlFor="chat-a-schema-name">
              格式名称
              <output>1–64 位字母、数字、_ 或 -</output>
            </label>
            <input
              id="chat-a-schema-name"
              className="st-input"
              value={advanced.schemaName}
              onChange={(event) => setAdvanced({ schemaName: event.target.value })}
            />
          </div>
          <div className="st-field">
            <label className="st-label" htmlFor="chat-a-schema">
              JSON Schema
            </label>
            <textarea
              id="chat-a-schema"
              className="st-input chat-advanced__code"
              rows={8}
              spellCheck={false}
              value={advanced.schemaText}
              onChange={(event) => setAdvanced({ schemaText: event.target.value })}
            />
            {schemaError ? <p className="chat-advanced__error">{schemaError}</p> : null}
          </div>
        </>
      ) : null}

      <label className="bench-switch chat-sampling__switch">
        <input
          type="checkbox"
          className="switch-input"
          checked={options.fixedPrefix !== null}
          onChange={(event) => {
            if (!event.target.checked) {
              onChange({ ...options, fixedPrefix: null });
              return;
            }
            const first = docs[0];
            if (!first) return;
            onChange({ ...options, fixedPrefix: { messageId: first.id } });
          }}
        />
        <span>
          复用长文
          <br />
          <span className="muted small">
            把一段长文档放在固定位置，让服务端复用它的缓存；文档之后还要有一条提问
          </span>
        </span>
      </label>

      {options.fixedPrefix ? (
        <div className="st-field">
          <label className="st-label" htmlFor="chat-a-prefix">
            选哪条消息当文档
          </label>
          <select
            id="chat-a-prefix"
            className="st-input"
            value={options.fixedPrefix.messageId}
            onChange={(event) =>
              onChange({ ...options, fixedPrefix: { ...options.fixedPrefix, messageId: event.target.value } })
            }
          >
            {docs.length === 0 ? <option value="">（当前会话还没有用户消息）</option> : null}
            {docs.map((message) => (
              <option key={message.id} value={message.id}>
                {message.content.trim().split("\n")[0].slice(0, 60)}
              </option>
            ))}
          </select>
          <div className="chat-advanced__row">
            <span className="st-hint">字符边界（留空 = 整条消息当文档）</span>
            <input
              className="st-input chat-advanced__chars"
              type="number"
              min={1}
              step={1}
              placeholder="整条"
              value={options.fixedPrefix.chars ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                const chars = raw === "" ? undefined : Math.max(1, Math.floor(Number(raw)));
                onChange({
                  ...options,
                  fixedPrefix:
                    chars === undefined
                      ? { messageId: options.fixedPrefix!.messageId }
                      : { messageId: options.fixedPrefix!.messageId, chars },
                });
              }}
            />
          </div>
        </div>
      ) : null}

      <details className="st-collapse search-settings__fold">
        <summary>
          <i className="fas fa-sliders-h" />
          <span>生成参数</span>
          <i className="fas fa-chevron-down st-chev" />
        </summary>
        <div className="st-collapse__body">
          <NumberField
            id="chat-a-minp"
            label="min-p"
            hint="0–1，越小越放开"
            value={advanced.minP}
            step={0.01}
            onChange={(value) => setAdvanced({ minP: value })}
          />
          <NumberField
            id="chat-a-rep"
            label="重复惩罚"
            hint="1 = 不惩罚"
            value={advanced.repetitionPenalty}
            step={0.01}
            onChange={(value) => setAdvanced({ repetitionPenalty: value })}
          />
          <NumberField
            id="chat-a-presence"
            label="新话题惩罚"
            hint="presence_penalty"
            value={advanced.presencePenalty}
            step={0.1}
            onChange={(value) => setAdvanced({ presencePenalty: value })}
          />
          <NumberField
            id="chat-a-frequency"
            label="重复词惩罚"
            hint="frequency_penalty"
            value={advanced.frequencyPenalty}
            step={0.1}
            onChange={(value) => setAdvanced({ frequencyPenalty: value })}
          />
          <NumberField
            id="chat-a-lastn"
            label="惩罚窗口"
            hint="penalty_last_n，0 = 不限制"
            value={advanced.penaltyLastN}
            step={1}
            onChange={(value) => setAdvanced({ penaltyLastN: value })}
          />
        </div>
      </details>

      <details className="st-collapse search-settings__fold">
        <summary>
          <i className="fas fa-terminal" />
          <span>停止串与 token 偏好</span>
          <i className="fas fa-chevron-down st-chev" />
        </summary>
        <div className="st-collapse__body">
          <div className="st-field">
            <label className="st-label" htmlFor="chat-a-stop">
              停止串
              <output>最多 4 条，每行一条</output>
            </label>
            <textarea
              id="chat-a-stop"
              className="st-input chat-advanced__code"
              rows={3}
              spellCheck={false}
              value={advanced.stop.join("\n")}
              onChange={(event) =>
                setAdvanced({
                  stop: event.target.value
                    .split("\n")
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, 4),
                })
              }
            />
          </div>
          <div className="st-field">
            <label className="st-label" htmlFor="chat-a-bias">
              logit_bias
              <output>
                对象 {"{"}"9419": -100{"}"} 或 [[9419, -100]]
              </output>
            </label>
            <textarea
              id="chat-a-bias"
              className="st-input chat-advanced__code"
              rows={3}
              spellCheck={false}
              placeholder='{"9419": -100}'
              value={advanced.logitBiasText}
              onChange={(event) => setAdvanced({ logitBiasText: event.target.value })}
            />
            {biasError ? <p className="chat-advanced__error">{biasError}</p> : null}
          </div>
          <label className="bench-switch chat-sampling__switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={options.esp}
              onChange={(event) => onChange({ ...options, esp: event.target.checked })}
            />
            <span>
              速度预测
              <br />
              <span className="muted small">答应回答前先估一个每秒 token 数的预测（实测值回来即替换）</span>
            </span>
          </label>
          <label className="bench-switch chat-sampling__switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={shared}
              disabled={!strata || !enginePort || sharedBusy}
              onChange={(event) => void toggleShared(event.target.checked)}
            />
            <span>
              共享给其它应用
              <br />
              <span className="muted small">
                把上面这份采样写成引擎默认值，其它客户端（omp、API 调用）也照这个走
                {!enginePort ? "（Strata 引擎没在运行）" : ""}
              </span>
            </span>
          </label>
          {sharedError ? <p className="chat-advanced__error">{sharedError}</p> : null}
          <label className="bench-switch chat-sampling__switch">
            <input
              type="checkbox"
              className="switch-input"
              checked={options.mcpServer}
              onChange={(event) => onChange({ ...options, mcpServer: event.target.checked })}
            />
            <span>
              MCP 交给引擎执行
              <br />
              <span className="muted small">
                引擎按它自己的 MCP 配置跑工具（`strata_mcp`），别再开上面的「MCP 工具」
              </span>
            </span>
          </label>
          <button
            type="button"
            className="st-btn st-btn--secondary"
            onClick={() =>
              onChange({
                ...options,
                advanced: { ...DEFAULT_CHAT_OPTIONS.advanced },
                fixedPrefix: null,
                esp: DEFAULT_CHAT_OPTIONS.esp,
                mcpServer: DEFAULT_CHAT_OPTIONS.mcpServer,
              })
            }
          >
            恢复默认
          </button>
        </div>
      </details>
    </>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  step,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number | null;
  step: number;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="st-field">
      <label className="st-label" htmlFor={id}>
        {label}
        <output>{hint}</output>
      </label>
      <input
        id={id}
        className="st-input"
        type="number"
        step={step}
        placeholder="默认"
        value={value ?? ""}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === "") return onChange(null);
          const next = Number(raw);
          onChange(Number.isFinite(next) ? next : null);
        }}
      />
    </div>
  );
}
