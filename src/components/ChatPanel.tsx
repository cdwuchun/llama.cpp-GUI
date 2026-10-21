import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../store";
import type { Conversation } from "../utils/chat";
import { mergeModels } from "../utils/models";
import { ChatIcon } from "./ChatIcons";
import { ChatMessageView } from "./ChatMessageView";
import { ChatSamplingSheet } from "./ChatSamplingSheet";

type Bucket = "today" | "yesterday" | "week" | "earlier";

/** 内容区宽度：可拖拽调整，记住上次的值（用户 m07390「用户可以调整宽度」） */
const CHAT_WIDTH_KEY = "llamacpp-gui-chat-width";
const CHAT_WIDTH_DEFAULT = 860;
const CHAT_WIDTH_MIN = 520;
const CHAT_WIDTH_MAX = 1600;

const BUCKET_LABEL: Record<Bucket, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "最近 7 天",
  earlier: "更早",
};

function groupConversations(list: Conversation[]): [Bucket, Conversation[]][] {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const yesterday = new Date(midnight);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(midnight);
  week.setDate(week.getDate() - 7);
  const byDate = new Map<Bucket, Conversation[]>();
  for (const item of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const bucket: Bucket =
      item.updatedAt >= midnight.getTime()
        ? "today"
        : item.updatedAt >= yesterday.getTime()
          ? "yesterday"
          : item.updatedAt >= week.getTime()
            ? "week"
            : "earlier";
    const bucketList = byDate.get(bucket) ?? [];
    bucketList.push(item);
    byDate.set(bucket, bucketList);
  }
  return [...byDate.entries()];
}

/**
 * 原生聊天页（照上游 `pages/ChatPage.tsx` 搬）。
 *
 * 三块：左侧聊天历史（搜索 + 按日期分组 + 重命名/删除），中间消息滚动区，
 * 底部 composer（附件、新建、导出、采样设置、停止、发送）。
 *
 * 与上游的差异都是环境差异，不是设计取舍：
 * - 上游按「服务 profile」分会话，本工程只有模型 → 会话与模型绑定，历史栏列全部会话；
 * - 上游重命名/删除走 Dialog，本工程用行内编辑与二次确认，少一层弹窗；
 * - 图标用 FontAwesome（本工程统一），不用上游的 `OfficialIcon`。
 */
export function ChatPanel() {
  const chat = useApp((s) => s.chat);
  const routerModels = useApp((s) => s.routerModels);
  // 下拉要列出「所有模型」，所以扫描结果、config 清单与 Strata config 也要取（用户 m00082 第 2 点）
  const scanned = useApp((s) => s.scanned);
  const configs = useApp((s) => s.configs);
  const settings = useApp((s) => s.settings);
  const strataEntries = useApp((s) => s.strataEntries);
  const sendChat = useApp((s) => s.sendChat);
  const stopChat = useApp((s) => s.stopChat);
  const newConversation = useApp((s) => s.newConversation);
  const selectConversation = useApp((s) => s.selectConversation);
  const renameConversation = useApp((s) => s.renameConversation);
  const deleteConversation = useApp((s) => s.deleteConversation);
  const setChatDraft = useApp((s) => s.setChatDraft);
  const addChatAttachments = useApp((s) => s.addChatAttachments);
  const removeChatAttachment = useApp((s) => s.removeChatAttachment);
  const setChatOptions = useApp((s) => s.setChatOptions);
  const dismissChatError = useApp((s) => s.dismissChatError);

  const [search, setSearch] = useState("");
  /** 聊天历史默认收起（用户 m00547），工具栏的「展开聊天历史」按钮可展开 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [samplingOpen, setSamplingOpen] = useState(false);
  /** 输入框里的模型下拉是否展开（用户 m07816 第 1 点） */
  const [modelOpen, setModelOpen] = useState(false);

  const files = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const scrolledConversation = useRef("");

  /** 内容区/输入框的宽度：居中显示，拖右侧手柄可调，记住上次的值（用户 m07390） */
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem(CHAT_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= CHAT_WIDTH_MIN ? saved : CHAT_WIDTH_DEFAULT;
  });

  useEffect(() => {
    // 用 CSS 变量传给样式表，避免在 JSX 里写内联尺寸（铁律 8）
    mainRef.current?.style.setProperty("--chat-width", `${chatWidth}px`);
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(Math.round(chatWidth)));
    } catch {
      // 配额满/隐私模式下存不了就算了，不影响本次使用
    }
  }, [chatWidth]);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const originX = event.clientX;
    const originWidth = chatWidth;
    const limit = mainRef.current?.clientWidth ?? CHAT_WIDTH_MAX;
    const move = (moveEvent: PointerEvent) => {
      // 内容居中，右侧手柄拖动 1px 等于宽度变化 2px
      const next = originWidth + (moveEvent.clientX - originX) * 2;
      setChatWidth(Math.min(Math.max(next, CHAT_WIDTH_MIN), Math.min(limit, CHAT_WIDTH_MAX)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }, [chatWidth]);

  const conversation = chat.conversations.find((item) => item.id === chat.activeId) ?? null;
  const streaming = chat.streaming;

  /** 模型下拉列出**所有**模型（用户 m00082 第 2 点）：没加载的也要能选，选中后发送时自动拉起。
   *  顺序沿用 mergeModels 的原始顺序，不把已加载的排到最前（用户 m00370 第 2 点）。 */
  const allModels = useMemo(() => {
    const sections = new Set(configs.map((c) => c.name));
    return mergeModels(
      scanned,
      routerModels,
      settings?.favourites ?? [],
      sections,
      settings?.aliases ?? {},
      strataEntries,
    );
  }, [scanned, routerModels, configs, settings?.favourites, settings?.aliases, strataEntries]);

  /** 采样面板与下拉共用的值域：全部模型的请求名 */
  const modelNames = useMemo(() => allModels.map((m) => m.section), [allModels]);

  /**
   * 当前模型（用户 m00370 第 3 点 + m00437）。
   *
   * 记住的选择还在列表里就用它（未加载的由发送时自动拉起，不能悄悄换成别的模型）；
   * 否则退回「已加载里按 id 排序的第一个」；
   * 一个都没加载时退回「上次聊天的模型」（最近一份会话绑定的模型，还在列表里）；
   * 再没有才显示「请选择模型」。
   */
  const remembered = allModels.find(
    (m) => m.section === chat.options.model || m.id === chat.options.model,
  );
  const defaultLoaded = allModels
    .filter((m) => m.status === "loaded")
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  /** 上次聊天的模型（用户 m00437）：取最近一份会话绑定的模型，且它仍在列表里 */
  const lastChatModel = useMemo(() => {
    const latest = [...chat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return undefined;
    return allModels.find((m) => m.section === latest.model || m.id === latest.model);
  }, [chat.conversations, allModels]);
  const activeModel =
    remembered?.section ?? defaultLoaded?.section ?? lastChatModel?.section ?? "";

  const groups = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-CN");
    const recent = chat.conversations.filter(
      (item) => !term || item.title.toLocaleLowerCase("zh-CN").includes(term),
    );
    return groupConversations(recent);
  }, [chat.conversations, search]);

  // 消息变化时贴底；换会话时强制贴底（上游同）
  useEffect(() => {
    const scroll = chatScroll.current;
    if (!scroll) return;
    if (scrolledConversation.current !== conversation?.id || nearBottom.current) {
      scroll.scrollTop = scroll.scrollHeight;
      nearBottom.current = true;
    }
    scrolledConversation.current = conversation?.id ?? "";
  }, [conversation?.messages, conversation?.id, streaming]);

  // 草稿清空后输入框回到两行高
  useEffect(() => {
    if (!chat.draft && input.current) input.current.style.height = "";
  }, [chat.draft]);

  const copy = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("已复制");
    } catch {
      setNotice("复制失败：浏览器拒绝了剪贴板权限");
    }
    setTimeout(() => setNotice(null), 1600);
  }, []);

  const exportConversation = useCallback((item: Conversation) => {
    const lines: string[] = [`# ${item.title}`, "", `模型：${item.model}`, ""];
    for (const message of item.messages) {
      lines.push(message.role === "user" ? "## 你" : "## 助手");
      if (message.reasoning) lines.push(`> 思考：${message.reasoning.replace(/\n/g, "\n> ")}`, "");
      lines.push(message.content || "（空）", "");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${item.title.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const submit = () => {
    if (streaming || (!chat.draft.trim() && !chat.attachments.length)) return;
    void sendChat();
  };

  return (
    <main className="main-area chat-page">
      <div className="top-bar">
        <h1 className="page-title">聊天</h1>
      </div>
    <section className={`chat-workspace${historyOpen ? "" : " chat-workspace--collapsed"}`}>
      {historyOpen && <aside className="chat-history" aria-label="聊天历史">
        <div className="chat-history-heading">
          <strong>聊天历史</strong>
          <button
            type="button"
            className="st-btn st-btn--icon"
            title="收起聊天历史"
            aria-label="收起聊天历史"
            onClick={() => setHistoryOpen(false)}
          >
            <i className="fas fa-angles-left" />
          </button>
        </div>
        <button
          type="button"
          className="st-btn st-btn--primary chat-history-new"
          disabled={streaming}
          onClick={newConversation}
        >
          <i className="fas fa-plus" />
          新建会话
        </button>
        <label className="chat-history-search">
          <i className="fas fa-magnifying-glass" />
          <input
            type="search"
            value={search}
            aria-label="搜索聊天"
            placeholder="搜索聊天"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="chat-history-list">
          {groups.length === 0 ? (
            <p className="chat-history-empty">{search.trim() ? "没有匹配的聊天" : "还没有聊天记录"}</p>
          ) : (
            groups.map(([bucket, items]) => (
              <div className="chat-history-group" key={bucket}>
                <h2>{BUCKET_LABEL[bucket]}</h2>
                {items.map((item) => (
                  <HistoryItem
                    key={item.id}
                    item={item}
                    active={item.id === chat.activeId}
                    disabled={streaming}
                    onSelect={() => selectConversation(item.id)}
                    onRename={(title) => renameConversation(item.id, title)}
                    onDelete={() => deleteConversation(item.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      </aside>}

      <div className="chat-main" ref={mainRef}>
        <div className="chat-toolbar">
          {!historyOpen && (
            <button
              type="button"
              className="st-btn st-btn--icon"
              title="展开聊天历史"
              aria-label="展开聊天历史"
              onClick={() => setHistoryOpen(true)}
            >
              <i className="fas fa-comments" />
            </button>
          )}
          <span className="chat-toolbar__title">{conversation?.title ?? "新聊天"}</span>
          {chat.error && (
            <button type="button" className="chat-toolbar__error" onClick={dismissChatError}>
              {chat.error}
              <i className="fas fa-xmark" />
            </button>
          )}
          {notice && <span className="chat-toolbar__notice">{notice}</span>}
        </div>

        <div
          className="chat-scroll"
          ref={chatScroll}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            nearBottom.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
          }}
        >
          <div className="chat">
            {!conversation || conversation.messages.length === 0 ? (
              <div className="chat-empty">
                <div className="chat-empty__title">问点什么吧</div>
                <div className="chat-empty__sub">
                  {activeModel ? `当前模型 ${activeModel}` : "请选择模型"}
                </div>
              </div>
            ) : (
              conversation.messages.map((message, index) => (
                <ChatMessageView
                  key={message.id}
                  message={message}
                  showReasoning={chat.options.showReasoning}
                  streaming={streaming && index === conversation.messages.length - 1}
                  onCopy={(value) => void copy(value)}
                />
              ))
            )}
          </div>
        </div>

        {/* 内容宽度的拖拽手柄：贴在内容区右边缘，居中（用户 m07390） */}
        <div
          className="chat-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整内容宽度"
          title="拖动调整内容宽度（双击恢复默认）"
          onPointerDown={startResize}
          onDoubleClick={() => setChatWidth(CHAT_WIDTH_DEFAULT)}
        />

        <div className="composer-wrap">
          <form
            className={`st-composer${dragging ? " dragging" : ""}`}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              if (!streaming) void addChatAttachments([...event.dataTransfer.files]);
            }}
          >
            {chat.attachments.length > 0 && (
              <div className="attachments">
                {chat.attachments.map((file) => (
                  <span className="chip" key={file.id}>
                    <i className={`fas ${file.type === "image" ? "fa-image" : "fa-paperclip"}`} />
                    {file.name}
                    <button
                      type="button"
                      className="st-btn st-btn--icon"
                      disabled={streaming}
                      aria-label={`移除 ${file.name}`}
                      onClick={() => removeChatAttachment(file.id)}
                    >
                      <i className="fas fa-xmark" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              rows={2}
              aria-label="消息"
              placeholder={
                chat.options.enterSends
                  ? "问点什么吧 · Enter 发送，Shift+Enter 换行"
                  : "问点什么吧 · Ctrl+Enter 发送，Enter 换行"
              }
              value={chat.draft}
              disabled={streaming}
              onChange={(event) => {
                setChatDraft(event.target.value);
                event.target.style.height = "";
                event.target.style.height = `${Math.min(event.target.scrollHeight, window.innerHeight * 0.4)}px`;
              }}
              onKeyDown={(event) => {
                // 发送键可在采样设置里切换（用户 m07816 第 3 点）：默认 Enter 发送，
                // 关掉「Enter 直接发送」后改成 Ctrl+Enter 发送、Enter 换行
                const withCtrl = event.ctrlKey || event.metaKey;
                const hit = chat.options.enterSends
                  ? event.key === "Enter" && !event.shiftKey && !withCtrl
                  : event.key === "Enter" && withCtrl;
                if (hit && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit();
                }
              }}
              onPaste={(event) => {
                const list = [...event.clipboardData.files];
                if (list.length) {
                  event.preventDefault();
                  void addChatAttachments(list);
                }
              }}
            />
            <div className="st-composer__bar">
              <button
                type="button"
                className="st-btn st-btn--icon"
                title="添加附件"
                aria-label="添加附件"
                disabled={streaming}
                onClick={() => files.current?.click()}
              >
                <ChatIcon name="attach" />
              </button>
              <input
                ref={files}
                type="file"
                multiple
                hidden
                aria-label="附件"
                accept="image/*,text/*,.md,.json,.csv,.yaml,.yml,.py,.js,.ts,.tsx,.rs,.log,.sql"
                onChange={(event) => {
                  void addChatAttachments([...(event.target.files ?? [])]);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="st-btn st-btn--icon"
                title="新建会话"
                aria-label="新建会话"
                disabled={streaming}
                onClick={newConversation}
              >
                <ChatIcon name="new-chat" />
              </button>
              <button
                type="button"
                className="st-btn st-btn--icon"
                title="导出为 Markdown"
                aria-label="导出为 Markdown"
                disabled={!conversation || !conversation.messages.length || streaming}
                onClick={() => conversation && exportConversation(conversation)}
              >
                <ChatIcon name="download" />
              </button>
              <button
                type="button"
                className="st-btn st-btn--icon"
                title="采样设置"
                aria-label="采样设置"
                onClick={() => setSamplingOpen(true)}
              >
                <ChatIcon name="settings" />
              </button>
              <span className="spacer" />
              {/* 输入框右侧直接切模型（用户 m00082 第 2 点）：列出所有模型，不排序（用户 m00370 第 2 点）；
                  已加载的模型名显示为绿色、不做圆点等其它标记（用户 m00370 第 1 点 + m00422）。
                  没加载的选中后由发送时自动拉起 */}
              <div className="composer-model">
                <button
                  type="button"
                  className="composer-model__btn"
                  disabled={streaming}
                  title="选择这次对话用哪个模型（未加载的会在发送时自动拉起）"
                  aria-haspopup="listbox"
                  aria-expanded={modelOpen}
                  onClick={() => setModelOpen((open) => !open)}
                >
                  <span className="composer-model__name">{activeModel || "请选择模型"}</span>
                  <ChatIcon name="chevron" size={14} className={`st-chev${modelOpen ? " is-open" : ""}`} />
                </button>
                {modelOpen && (
                  <>
                    <div className="composer-model__mask" onClick={() => setModelOpen(false)} />
                    <div className="composer-model__menu" role="listbox">
                      {allModels.length === 0 && <p className="st-hint">还没扫描到模型</p>}
                      {allModels.map((model) => {
                        const loaded = model.status === "loaded";
                        const selected = model.section === activeModel;
                        return (
                          <button
                            key={model.section}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            title={model.section}
                            className={`composer-model__item${selected ? " is-on" : ""}${loaded ? " is-loaded" : ""}`}
                            onClick={() => {
                              setChatOptions({ ...chat.options, model: model.section });
                              setModelOpen(false);
                            }}
                          >
                            <span className="composer-model__label">{model.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {streaming && (
                <button type="button" className="st-btn st-btn--secondary" onClick={stopChat}>
                  <ChatIcon name="stop" size={16} />
                  停止
                </button>
              )}
              <button
                type="submit"
                className="st-btn st-btn--primary st-btn--send"
                aria-label="发送"
                disabled={streaming || (!chat.draft.trim() && !chat.attachments.length)}
              >
                <ChatIcon name="send" />
              </button>
            </div>
          </form>
        </div>
      </div>

      {samplingOpen && (
        <ChatSamplingSheet
          options={chat.options}
          models={modelNames}
          onApply={(next) => setChatOptions(next)}
          onClose={() => setSamplingOpen(false)}
        />
      )}
    </section>
    </main>
  );
}

/** 历史栏里的一条：点主体切换会话，行内改名，点两次删除 */
function HistoryItem({
  item,
  active,
  disabled,
  onSelect,
  onRename,
  onDelete,
}: {
  item: Conversation;
  active: boolean;
  disabled: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(item.title);

  useEffect(() => {
    setTitle(item.title);
  }, [item.title]);

  if (renaming) {
    return (
      <div className={`chat-history-item${active ? " is-active" : ""}`}>
        <input
          className="st-input chat-history-rename"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => {
            onRename(title);
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRename(title);
              setRenaming(false);
            }
            if (event.key === "Escape") {
              setTitle(item.title);
              setRenaming(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div className={`chat-history-item${active ? " is-active" : ""}`}>
      <button
        type="button"
        className="chat-history-select"
        aria-current={active ? "true" : undefined}
        title={item.title}
        disabled={disabled}
        onClick={onSelect}
      >
        <span>{item.title || "未命名会话"}</span>
        <small>
          {new Date(item.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} ·{" "}
          {item.messages.length} 条消息
        </small>
      </button>
      <div className="chat-history-actions">
        <button
          type="button"
          className="st-btn st-btn--icon"
          disabled={disabled}
          title="重命名"
          aria-label={`重命名：${item.title}`}
          onClick={() => setRenaming(true)}
        >
          <i className="fas fa-pen" />
        </button>
        <button
          type="button"
          className="st-btn st-btn--icon chat-history-delete"
          disabled={disabled}
          title="删除"
          aria-label={`删除：${item.title}`}
          onClick={onDelete}
        >
          <i className="fas fa-trash-can" />
        </button>
      </div>
    </div>
  );
}