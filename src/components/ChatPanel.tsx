import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { useApp } from "../store";
import type { Conversation } from "../utils/chat";
import { mergeModels } from "../utils/models";
import { ChatHistoryItem } from "./ChatHistoryItem";
import { ChatIcon } from "./ChatIcons";
import { ChatMessageView, type ChatMessageActions } from "./ChatMessageView";
import { ChatSamplingSheet } from "./ChatSamplingSheet";

type Bucket = "today" | "yesterday" | "week" | "earlier";

/** 内容区宽度：可拖拽调整，记住上次的值（用户 m07390「用户可以调整宽度」） */
const CHAT_WIDTH_KEY = "llamacpp-gui-chat-width";
const CHAT_WIDTH_DEFAULT = 860;
const CHAT_WIDTH_MIN = 520;
const CHAT_WIDTH_MAX = 1600;

/** 滚动跟随（照 Strata `follow-scroll.ts`）：距底 ≤24 才算「在底部」，离底 >400 放手，
 *  读者自己滚动后 400ms 内不强行拉回 —— 一个滚轮约 100px，旧的 120px 阈值等于「刚滚上去就被拽回来」。 */
const FOLLOW_SLACK = 24;
const PILL_DISTANCE = 400;
const READER_INPUT_WINDOW = 400;
/** 右侧轮次跳转：点击后目标消息距滚动区顶部留这么多像素 */
const TURN_OFFSET = 12;
/** 选词引用最多带这么多字（照 Strata quotes 的 4000 上限砍到正文里够用的量，避免把整段贴进输入框） */
const QUOTE_CHARS = 400;

/** 空态示例（P1）：点一下填进输入框，不直接发送 —— 用户经常要改两个字再问 */
const CHAT_EXAMPLES = [
  "帮我把这段 JSON 改成 YAML",
  "解释一下大模型的 KV cache 是什么",
  "写一个 Python 脚本：按修改时间列出目录里最近的 10 个文件",
  "用一句话总结下面的报错，并给出修法",
];

/** 导出文件名：去掉 Windows 非法字符并截断（审查 F8：长标题会让下载失败或被截成怪名字） */
function exportName(title: string, extension: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "chat";
  return `${safe}${extension}`;
}

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

/** token 数的紧凑写法（12.3k / 980），dock 与上下文环共用 */
function fmtTokCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`;
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
  const strataStatus = useApp((s) => s.strataStatus);
  const strataEntries = useApp((s) => s.strataEntries);
  const sendChat = useApp((s) => s.sendChat);
  const stopChat = useApp((s) => s.stopChat);
  const newConversation = useApp((s) => s.newConversation);
  const selectConversation = useApp((s) => s.selectConversation);
  const renameConversation = useApp((s) => s.renameConversation);
  const deleteConversation = useApp((s) => s.deleteConversation);
  const restoreConversation = useApp((s) => s.restoreConversation);
  const setChatDraft = useApp((s) => s.setChatDraft);
  const addChatAttachments = useApp((s) => s.addChatAttachments);
  const removeChatAttachment = useApp((s) => s.removeChatAttachment);
  const setChatOptions = useApp((s) => s.setChatOptions);
  const dismissChatError = useApp((s) => s.dismissChatError);
  // 编辑回退（用户 m00232 的 A1）
  const regenerateReply = useApp((s) => s.regenerateReply);
  const editAnswerText = useApp((s) => s.editAnswerText);
  const editUserMessage = useApp((s) => s.editUserMessage);
  const rewindChat = useApp((s) => s.rewindChat);
  const undoChatHistory = useApp((s) => s.undoChatHistory);
  const dismissChatUndo = useApp((s) => s.dismissChatUndo);
  const clearPendingChat = useApp((s) => s.clearPendingChat);
  const refreshSearchAvailability = useApp((s) => s.refreshSearchAvailability);

  const [search, setSearch] = useState("");
  /** 聊天历史默认收起（用户 m00547），工具栏的「展开聊天历史」按钮可展开 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [samplingOpen, setSamplingOpen] = useState(false);
  /** 输入框里的模型下拉是否展开（用户 m07816 第 1 点） */
  const [modelOpen, setModelOpen] = useState(false);
  /** 刚删除的会话：底部 toast 给 6 秒撤销窗口 */
  const [deleted, setDeleted] = useState<Conversation | null>(null);

  /** 删除会话并留一份用于撤销（用户 m02858：一次删除，但可撤销） */
  const handleDelete = (id: string) => {
    const target = chat.conversations.find((item) => item.id === id);
    if (!target) return;
    deleteConversation(id);
    setDeleted(target);
  };

  useEffect(() => {
    if (!deleted) return;
    const timer = window.setTimeout(() => setDeleted(null), 10000);
    return () => window.clearTimeout(timer);
  }, [deleted]);

  const files = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const chatScroll = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  /** 是否「贴底跟随」：流式回答变长时每帧滚到底，只有距底 ≤24 才继续跟随 */
  const pinned = useRef(true);
  /** 上一次读者自己滚动/触摸的时间：400ms 内的滚动不强行拉回底部（Strata follow-scroll） */
  const readerInput = useRef(0);
  /** 中文输入法 compositionend 的时间：WKWebView 里回车选词会先触发 compositionend 再冒泡 keydown */
  const imeCommitAt = useRef(0);
  /** 输入 @ 打开了文件选择：选完要把草稿末尾那个 @ 去掉 */
  const atPending = useRef(false);
  const scrolledConversation = useRef("");
  /** 当前视口里最靠上的那一轮（右侧轮次跳转的高亮项） */
  const [activeTurn, setActiveTurn] = useState(0);
  /** 选中文字后的「引用」浮层（照 Strata 的选区引用，P1） */
  const [quote, setQuote] = useState<{ top: number; left: number; text: string } | null>(null);

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
      // 指针被系统取消（切窗口、触摸被滚动接管）时不会发 pointerup，监听器会一直挂着（审查发现）
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
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
   * 当前模型（用户 m00370 第 3 点 + m00437 + m01878 第 2 点）。
   *
   * 记住的选择还在列表里就用它（未加载的由发送时自动拉起，不能悄悄换成别的模型）；
   * 否则退回「已加载里按 id 排序的第一个」；
   * 一个都没加载时退回「上次聊天的模型」（最近一份会话绑定的模型，还在列表里）；
   * 再没有才显示「请选择模型」。
   *
   * 另外进聊天页时把「正在运行的模型」写进记住的选择（见下面的 effect）：有模型在跑就用它，
   * 没有在跑的才沿用上次的选择。
   */
  const remembered = allModels.find(
    (m) => m.section === chat.options.model || m.id === chat.options.model,
  );
  /**
   * 正在运行的模型（用户 m01878 第 2 点）：多个在跑时，先认记住的那个 / 当前会话绑定的那个，
   * 都不是在跑的才按 id 排序取第一个。
   */
  const runningModel = useMemo(() => {
    const running = allModels.filter((m) => m.status === "loaded");
    if (running.length === 0) return undefined;
    const convModel = conversation?.model;
    return (
      running.find((m) => m.section === chat.options.model || m.id === chat.options.model) ??
      (convModel ? running.find((m) => m.section === convModel) : undefined) ??
      [...running].sort((a, b) => a.id.localeCompare(b.id))[0]
    );
  }, [allModels, chat.options.model, conversation?.model]);
  /** 上次聊天的模型（用户 m00437）：取最近一份会话绑定的模型，且它仍在列表里 */
  const lastChatModel = useMemo(() => {
    const latest = [...chat.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!latest) return undefined;
    return allModels.find((m) => m.section === latest.model || m.id === latest.model);
  }, [chat.conversations, allModels]);
  const activeModel =
    remembered?.section ?? runningModel?.section ?? lastChatModel?.section ?? "";

  /**
   * 进聊天页时自动选中正在运行的模型（用户 m01878 第 2 点）：只跑一次，
   * 且只在模型列表已经就绪时判定——列表还空着说明扫描没回来，等下一轮再试。
   * 没有模型在跑就不动记住的选择（= 上次用的模型）。
   */
  const modelSynced = useRef(false);
  useEffect(() => {
    if (modelSynced.current || allModels.length === 0) return;
    modelSynced.current = true;
    if (!runningModel) return;
    if (chat.options.model !== runningModel.section) {
      setChatOptions({ model: runningModel.section });
    }
  }, [allModels.length, runningModel, chat.options.model, setChatOptions]);

  /** 联网搜索可用性：进页面先问一次，设置面板保存后也会重新判（灰字提示用） */
  useEffect(() => {
    void refreshSearchAvailability();
  }, [refreshSearchAvailability]);

  const groups = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("zh-CN");
    const recent = chat.conversations.filter(
      (item) =>
        !term ||
        item.title.toLocaleLowerCase("zh-CN").includes(term) ||
        // 搜索覆盖消息正文（方案 v2）：标题记不住、只记得聊过某个词时也能找回来
        item.messages.some((message) => message.content.toLocaleLowerCase("zh-CN").includes(term)),
    );
    return groupConversations(recent);
  }, [chat.conversations, search]);

  /**
   * dock / 上下文环的重算键（审查 Q4）：流式时 conversation 每来一个 token 就换一次引用，
   * 直接把它放进 useMemo 依赖会让 O(n) 统计每 token 重跑一遍。这里只取「会用到的字段」
   * 拼成字符串，流式中这些值不变（usage 要等一轮结束才写）。
   */
  const statsKey = useMemo(() => {
    const messages = conversation?.messages ?? [];
    const last = messages[messages.length - 1];
    return `${conversation?.id ?? ""}|${messages.length}|${last?.id ?? ""}|${last?.usage?.total_tokens ?? 0}|${last?.elapsedMs ?? 0}`;
  }, [conversation]);

  /** 右侧轮次跳转：每个用户提问一条（照 DSH 的右侧消息导航），点哪条滚到那轮的开头 */
  const turns = useMemo(() => {
    const list: { id: string; label: string }[] = [];
    for (const message of conversation?.messages ?? []) {
      if (message.role !== "user") continue;
      const text = message.content.replace(/\s+/g, " ").trim();
      list.push({ id: message.id, label: text.slice(0, 40) || "（空消息）" });
    }
    return list;
  }, [conversation]);

  /** 跳到某一轮：用消息元素的真实位置算滚动目标，避免 offsetParent 差异 */
  const jumpToTurn = useCallback((id: string) => {
    const scroll = chatScroll.current;
    const element = document.getElementById(`chat-msg-${id}`);
    if (!scroll || !element) return;
    pinned.current = false;
    const top =
      element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - TURN_OFFSET;
    scroll.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, []);

  /** 滚动时更新右侧导航的高亮：取「顶部已经越过视口上方 80px」的最后一轮 */
  const syncActiveTurn = useCallback(() => {
    const scroll = chatScroll.current;
    if (!scroll) return;
    const messages = conversation?.messages ?? [];
    const line = scroll.scrollTop + 80;
    let current = 0;
    let turnIndex = 0;
    for (const message of messages) {
      if (message.role !== "user") continue;
      const element = document.getElementById(`chat-msg-${message.id}`);
      if (element) {
        const top = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
        if (top <= line) current = turnIndex;
      }
      turnIndex += 1;
    }
    setActiveTurn(current);
  }, [conversation]);

  // 消息数/会话变化时同步一次高亮（渲染后 DOM 才就位）
  useEffect(() => {
    syncActiveTurn();
  }, [statsKey, syncActiveTurn]);

  /**
   * 输入框下方的一行统计（照 DSH 的 composer dock）：轮次、工具次数、速度、首 token、
   * token 合计与缓存命中。数据全是会话里已有的 execution/usage，不需要额外请求。
   */
  const dock = useMemo(() => {
    const messages = conversation?.messages ?? [];
    if (messages.length === 0) return null;
    const rounds = messages.filter((message) => message.role === "user").length;
    const tools = messages.reduce((sum, message) => sum + (message.tools?.length ?? 0), 0);
    const totals = { input: 0, output: 0, cached: 0 };
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      totals.input += message.usage?.prompt_tokens ?? 0;
      totals.output += message.usage?.completion_tokens ?? message.usage?.output_tokens ?? 0;
      totals.cached += message.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    }
    if (totals.input === 0 && totals.output === 0) return null;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const speed = lastAssistant?.speed?.decodeTokS;
    const ttft = lastAssistant?.firstTokenMs ?? lastAssistant?.execution?.firstTokenMs;
    const elapsed = lastAssistant?.elapsedMs;
    const fmtMs = (value?: number) =>
      value == null ? null : value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`;
    const fmtTok = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1)}k` : `${value}`);
    const parts = [`${rounds} 轮`, ...(tools > 0 ? [`${tools} 次工具`] : [])];
    if (speed) parts.push(`${speed.toFixed(1)} tok/s`);
    const firstToken = fmtMs(ttft);
    if (firstToken) parts.push(`首 token ${firstToken}`);
    const total = fmtMs(elapsed);
    if (total) parts.push(`耗时 ${total}`);
    parts.push(`输入 ${fmtTok(totals.input)} / 输出 ${fmtTok(totals.output)}`);
    if (totals.cached > 0 && totals.input > 0) {
      parts.push(`缓存 ${Math.round((totals.cached / totals.input) * 100)}%`);
    }
    if (chat.compacted > 0) parts.push(`早期 ${chat.compacted} 条已压缩`);
    return parts.join(" · ");
    // conversation 通过 statsKey 间接依赖：只在这些统计字段变化时重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey, chat.compacted]);

  /**
   * 上下文环（照 Strata 的 ContextRing）：用上一轮请求的 prompt + 输出 token 当「已占」，
   * 分母是当前模型的 max_context（config 优先，Strata 实例用 /health 报的值兜底）。
   * 全用会话里已有的 usage，不发额外请求。
   */
  const contextUse = useMemo(() => {
    const messages = conversation?.messages ?? [];
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const usage = lastAssistant?.usage;
    const used = usage
      ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? usage.output_tokens ?? 0)
      : 0;
    if (used <= 0) return null;
    const model = chat.options.model || activeModel;
    // 分母是「实际运行的这个模型」的上下文（用户 m02182 第 2 点）：
    // Strata 模型取 strataEntries 里启动参数写明的 max_context（与压测页同源），
    // llama.cpp 模型取 config 的 --ctx-size，都没有再用 /health 报的 live_max_context 兜底。
    const strataEntry = strataEntries.find((entry) => entry.model_name === model);
    const config = configs.find((item) => item.name === model);
    const raw = strataEntry?.max_context ?? config?.max_context ?? strataStatus.live_max_context ?? null;
    const max = typeof raw === "string" ? Number(raw) : raw;
    const limit = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : null;
    const pct = limit ? Math.min(100, Math.max(0, Math.round((used / limit) * 100))) : null;
    return { used, limit, pct };
    // 同 dock：conversation 通过 statsKey 间接依赖（审查 Q4）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsKey, configs, strataEntries, chat.options.model, activeModel, strataStatus.live_max_context]);

  // 换会话时强制贴底（上游同）；消息变高由下面的 ResizeObserver / rAF 跟随
  useEffect(() => {
    if (scrolledConversation.current === (conversation?.id ?? "")) return;
    scrolledConversation.current = conversation?.id ?? "";
    pinned.current = true;
    const scroll = chatScroll.current;
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  }, [conversation?.id]);

  // 高度变了就补一次贴底：图片、公式、代码块测量后变高，单次 scrollTop 追不上
  useEffect(() => {
    const scroll = chatScroll.current;
    if (!scroll) return;
    const inner = scroll.firstElementChild;
    const stick = () => {
      if (pinned.current) scroll.scrollTop = scroll.scrollHeight;
    };
    const observer = new ResizeObserver(stick);
    observer.observe(scroll);
    if (inner instanceof HTMLElement) observer.observe(inner);
    return () => observer.disconnect();
  }, [conversation?.id]);

  // 流式期间每帧跟进：内容一帧一帧变长，scroll 事件不够密
  useEffect(() => {
    const scroll = chatScroll.current;
    if (!scroll || !streaming) return;
    let frame = 0;
    const loop = () => {
      if (pinned.current) scroll.scrollTop = scroll.scrollHeight;
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [conversation?.id, streaming]);

  // 草稿清空后输入框回到两行高
  useEffect(() => {
    if (!chat.draft && input.current) input.current.style.height = "";
  }, [chat.draft]);

  const copy = useCallback((value: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        setNotice("已复制");
      } catch {
        setNotice("复制失败：浏览器拒绝了剪贴板权限");
      }
      setTimeout(() => setNotice(null), 1600);
    })();
  }, []);

  const exportConversation = useCallback((item: Conversation) => {
    const lines: string[] = [`# ${item.title}`, "", `模型：${item.model}`, ""];
    for (const message of item.messages) {
      // 工具消息不进 Markdown 导出（审查 F8：原来被写成「## 助手」，内容还是 tool 结果）
      if (message.role === "tool") continue;
      lines.push(message.role === "user" ? "## 你" : "## 助手");
      if (message.reasoning) lines.push(`> 思考：${message.reasoning.replace(/\n/g, "\n> ")}`, "");
      lines.push(message.content || "（空）", "");
    }
    download(
      new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" }),
      exportName(item.title, ".md"),
    );
  }, []);

  /** 触发一次浏览器下载（Markdown / JSON / PNG 共用） */
  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // 立即 revoke 在部分 WebView 里会把下载掐断（审查 F8）：等它开始下载再释放
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** 导出 JSON（P1）：比 Markdown 多带工具调用、来源、用量与执行信息，方便备份/排查 */
  const exportJson = useCallback((item: Conversation) => {
    const payload = {
      schema: "llamacpp-gui-chat/1",
      exportedAt: new Date().toISOString(),
      conversation: item,
    };
    download(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
      exportName(item.title, ".json"),
    );
  }, []);

  /** 导出整段对话为 PNG（P1）：html2canvas 动态加载，按 .chat 的完整高度渲染 */
  const exportImage = useCallback(async (item: Conversation) => {
    const node = chatScroll.current?.querySelector(".chat");
    if (!(node instanceof HTMLElement)) return;
    setNotice("正在生成长图…");
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(node, {
        backgroundColor: getComputedStyle(document.body).backgroundColor || "#ffffff",
        scale: Math.min(2, window.devicePixelRatio || 1),
        logging: false,
      });
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("画布为空");
      download(blob, exportName(item.title, ".png"));
      setNotice("长图已导出");
    } catch (error) {
      setNotice(`长图导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => setNotice(null), 2600);
  }, []);

  const submit = () => {
    if (!chat.draft.trim() && !chat.attachments.length) return;
    // 生成中：只有「等待」模式不发（那一轮结束后再发是排队 / 打断的活，sendChat 里处理）
    if (streaming && chat.options.busyMode === "wait") return;
    void sendChat();
  };

  /** 生成中：忙时锁住输入框与附件按钮的模式只有「等待」（排队 / 打断要能继续打字） */
  const composerLocked = streaming && chat.options.busyMode === "wait";

  /** 消息上的操作：必须 useMemo 包住 —— 每次渲染新建对象会让 ChatMessageView 的 memo 永远不命中，
   *  流式时每来一个 token 都把整屏消息重渲染一遍（方案 v2 第 6 项）。 */
  const messageActions = useMemo<ChatMessageActions | null>(
    () =>
      chat.options.chatEdit
        ? {
            editable: true,
            busy: streaming,
            onRewind: (at) => rewindChat(at, false),
            onBranch: (at) => rewindChat(at, true),
            onRegenerate: (at) => regenerateReply(at),
            onEditAnswer: (at, text) => editAnswerText(at, text),
            onEditUser: (at, text) => editUserMessage(at, text),
          }
        : null,
    [chat.options.chatEdit, streaming, rewindChat, regenerateReply, editAnswerText, editUserMessage],
  );

  /** 选中消息正文后浮出「引用」按钮：点一下把选中的文字以「…」追加到草稿（照 Strata 的选区引用） */
  useEffect(() => {
    const onSelection = () => {
      const selection = window.getSelection();
      const text = selection?.toString().trim() ?? "";
      const scroll = chatScroll.current;
      if (!selection || !scroll || selection.rangeCount === 0 || text.length < 2) {
        setQuote(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const node = range.commonAncestorContainer;
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      // 只认消息正文里的选区：工具栏、按钮、输入框里的文字不弹引用
      if (!element || !scroll.contains(element) || !element.closest(".st-msg")) {
        setQuote(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setQuote({
        top: Math.max(8, rect.top - 38),
        left: Math.min(window.innerWidth - 96, Math.max(8, rect.left + rect.width / 2 - 40)),
        text: text.slice(0, QUOTE_CHARS),
      });
    };
    const hide = (event: Event) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".chat-quote-btn")) return;
      setQuote(null);
    };
    document.addEventListener("selectionchange", onSelection);
    window.addEventListener("scroll", hide, true);
    document.addEventListener("pointerdown", hide);
    return () => {
      document.removeEventListener("selectionchange", onSelection);
      window.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerdown", hide);
    };
  }, []);

  const insertQuote = useCallback(
    (text: string) => {
      const quoted = `「${text}」`;
      setChatDraft(chat.draft ? `${chat.draft}\n\n${quoted}` : quoted);
      setQuote(null);
      window.getSelection()?.removeAllRanges();
      input.current?.focus();
    },
    [chat.draft, setChatDraft],
  );

  /** P1 快捷键：Ctrl/⌘+Shift+N 新建会话，Esc 收起采样设置 / 模型菜单 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (samplingOpen) {
          setSamplingOpen(false);
          return;
        }
        if (modelOpen) {
          setModelOpen(false);
          return;
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!streaming) newConversation();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [samplingOpen, modelOpen, streaming, newConversation]);

  /** 分支会话的「打开原会话」：原会话还在就切过去，被删了就给个提示 */
  const openParent = () => {
    const parent = conversation?.parent;
    if (!parent) return;
    if (chat.conversations.some((item) => item.id === parent.id)) {
      selectConversation(parent.id);
      return;
    }
    setNotice(`原会话「${parent.title}」已被删除`);
    setTimeout(() => setNotice(null), 2200);
  };

  return (
    <main className="main-area chat-page">
      <div className="top-bar">
        <h1 className="page-title">聊天</h1>
      </div>
    <section
      className={`chat-workspace chat-fs-${chat.options.chatFont}${historyOpen && chat.options.chatList ? "" : " chat-workspace--collapsed"}`}
    >
      {historyOpen && chat.options.chatList && <aside className="chat-history" aria-label="聊天历史">
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
                  <ChatHistoryItem
                    key={item.id}
                    item={item}
                    active={item.id === chat.activeId}
                    disabled={streaming}
                    onSelect={() => selectConversation(item.id)}
                    onRename={(title) => renameConversation(item.id, title)}
                    onDelete={() => handleDelete(item.id)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
        {deleted && (
          <div className="chat-toast" role="status">
            <span className="chat-toast__text">已删除「{deleted.title || "未命名会话"}」</span>
            <button
              type="button"
              className="chat-toast__undo"
              onClick={() => {
                restoreConversation(deleted);
                setDeleted(null);
              }}
            >
              撤销
            </button>
            <button
              type="button"
              className="chat-toast__close"
              aria-label="关闭提示"
              onClick={() => setDeleted(null)}
            >
              <i className="fas fa-xmark" />
            </button>
          </div>
        )}
      </aside>}

      <div className="chat-main" ref={mainRef}>
        <div className="chat-toolbar">
          {!historyOpen && chat.options.chatList && (
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
          {conversation?.parent && (
            <button type="button" className="chat-toolbar__parent" onClick={openParent} title="打开这条分支的原始会话">
              <ChatIcon name="branch" size={14} />
              分支自「{conversation.parent.title}」
            </button>
          )}
          {chat.error && (
            <button type="button" className="chat-toolbar__error" onClick={dismissChatError}>
              {chat.error}
              <i className="fas fa-xmark" />
            </button>
          )}
          {notice && <span className="chat-toolbar__notice">{notice}</span>}
        </div>

        {/* 撤销条（上游的 Undo 行）：编辑回退之后显示，撤销 / 关掉 */}
        {chat.undo && (
          <div className="chat-undo" role="status">
            <ChatIcon name="undo" size={14} />
            <span>{chat.undo.text}</span>
            <button
              type="button"
              className="st-btn st-btn--ghost"
              onClick={undoChatHistory}
              disabled={streaming}
            >
              撤销
            </button>
            <button
              type="button"
              className="st-btn st-btn--icon"
              title="关掉这条提示（不撤销）"
              aria-label="关掉撤销提示"
              onClick={dismissChatUndo}
            >
              <i className="fas fa-xmark" />
            </button>
          </div>
        )}

        <div
          className="chat-scroll"
          ref={chatScroll}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            const distance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
            const recent = Date.now() - readerInput.current < READER_INPUT_WINDOW;
            // 距底 ≤24 才算在底部；读者刚滚过（400ms 内）或离底 >400 就放手，不再每帧拽回来
            if (distance <= FOLLOW_SLACK) pinned.current = true;
            else if (recent || distance > PILL_DISTANCE) pinned.current = false;
            syncActiveTurn();
          }}
          onWheel={(event) => {
            if (event.deltaY < 0) readerInput.current = Date.now();
          }}
          onTouchMove={() => {
            readerInput.current = Date.now();
          }}
        >
          <div className="chat">
            {!conversation || conversation.messages.length === 0 ? (
              <div className="chat-empty">
                <div className="chat-empty__title">问点什么吧</div>
                <div className="chat-empty__sub">
                  {activeModel ? `当前模型 ${activeModel}` : "请选择模型"}
                </div>
                <div className="chat-empty__examples">
                  {CHAT_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className="st-btn st-btn--secondary st-btn--sm"
                      disabled={composerLocked}
                      onClick={() => {
                        setChatDraft(example);
                        input.current?.focus();
                      }}
                    >
                      {example}
                    </button>
                  ))}
                </div>
                <p className="chat-empty__hint">Ctrl/⌘+Shift+N 新建会话 · Esc 收起设置面板</p>
              </div>
            ) : (
              conversation.messages.map((message, index) => (
                <ChatMessageView
                  key={message.id}
                  message={message}
                  index={index}
                  showReasoning={chat.options.showReasoning}
                  showMath={chat.options.showMath}
                  processMode={chat.options.processMode}
                  streaming={streaming && index === conversation.messages.length - 1}
                  actions={messageActions}
                  onCopy={copy}
                />
              ))
            )}
          </div>
        </div>
        {turns.length > 1 && (
          <nav className="chat-turns" aria-label="轮次跳转">
            {turns.map((turn, turnIndex) => {
              const busy = streaming && turnIndex === turns.length - 1;
              return (
                <button
                  key={turn.id}
                  type="button"
                  className={`chat-turns__mark${turnIndex === activeTurn ? " is-on" : ""}${busy ? " is-busy" : ""}`}
                  title={`第 ${turnIndex + 1} 轮：${turn.label}`}
                  aria-label={`跳到第 ${turnIndex + 1} 轮：${turn.label}`}
                  aria-current={turnIndex === activeTurn ? "true" : undefined}
                  onClick={() => jumpToTurn(turn.id)}
                />
              );
            })}
          </nav>
        )}

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
          {chat.pending && (
            <div className="chat-pending" role="status">
              <i className="fas fa-hourglass-half" />
              <span className="chat-pending__text">
                {chat.options.busyMode === "interrupt" ? "打断后发送：" : "排队中："}
                {chat.pending.text.split("\n")[0].slice(0, 80) || `${chat.pending.attachments.length} 个附件`}
              </span>
              <button type="button" className="st-btn st-btn--ghost" onClick={clearPendingChat}>
                取消
              </button>
            </div>
          )}
          {chat.options.webSearch && !chat.searchAvailable && (
            <div className="chat-search-hint" role="status">
              联网搜索暂不可用：引擎都在冷却或没配 key，本条消息不会自动搜索。
            </div>
          )}
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
              if (!composerLocked) void addChatAttachments([...event.dataTransfer.files]);
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
                streaming && chat.options.busyMode !== "wait"
                  ? chat.options.busyMode === "queue"
                    ? "继续打字 · 这段会在当前回答结束后自动发送"
                    : "继续打字 · 发送会打断当前这轮回答"
                  : chat.options.enterSends
                    ? "问点什么吧 · Enter 发送，Shift+Enter 换行"
                    : "问点什么吧 · Ctrl+Enter 发送，Enter 换行"
              }
              value={chat.draft}
              disabled={composerLocked}
              onChange={(event) => {
                const value = event.target.value;
                setChatDraft(value);
                event.target.style.height = "";
                event.target.style.height = `${Math.min(event.target.scrollHeight, window.innerHeight * 0.4)}px`;
                // @ 引用文件（P1）：行首或空白后输入 @ 直接打开文件选择，与回形针按钮等价；
                // 选到文件后把那个 @ 去掉（取消选择时 input 不触发，@ 留着由用户自己删）
                if (!streaming && value.endsWith("@") && (value.length === 1 || /\s$/.test(value.slice(0, -1)))) {
                  atPending.current = true;
                  files.current?.click();
                }
              }}
              onKeyDown={(event) => {
                // 发送键可在采样设置里切换（用户 m07816 第 3 点）：默认 Enter 发送，
                // 关掉「Enter 直接发送」后改成 Ctrl+Enter 发送、Enter 换行
                const withCtrl = event.ctrlKey || event.metaKey;
                const hit = chat.options.enterSends
                  ? event.key === "Enter" && !event.shiftKey && !withCtrl
                  : event.key === "Enter" && withCtrl;
                // 中文/日文输入法：除了 isComposing，还要认 keyCode 229 与 compositionend 后 50ms 内的
                // 那个回车（WKWebView 的顺序不同），否则选词回车会被当成发送（照 Strata `ime-enter.ts`）
                const ime =
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229 ||
                  Date.now() - imeCommitAt.current < 50;
                if (hit && !ime) {
                  event.preventDefault();
                  submit();
                }
              }}
              onCompositionEnd={() => {
                imeCommitAt.current = Date.now();
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
                disabled={composerLocked}
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
                accept="image/*,text/*,.md,.json,.csv,.yaml,.yml,.py,.js,.ts,.tsx,.rs,.log,.sql,.pdf,.docx,.xlsx,.pptx"
                onChange={(event) => {
                  const picked = [...(event.target.files ?? [])];
                  event.target.value = "";
                  if (picked.length === 0) return;
                  void addChatAttachments(picked);
                  if (atPending.current) {
                    atPending.current = false;
                    if (chat.draft.endsWith("@")) setChatDraft(chat.draft.slice(0, -1));
                  }
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
                title="导出为 JSON（含工具调用、来源与用量）"
                aria-label="导出为 JSON"
                disabled={!conversation || !conversation.messages.length || streaming}
                onClick={() => conversation && exportJson(conversation)}
              >
                <i className="fas fa-file-code" />
              </button>
              <button
                type="button"
                className="st-btn st-btn--icon"
                title="导出整段对话长图（PNG）"
                aria-label="导出长图"
                disabled={!conversation || !conversation.messages.length || streaming}
                onClick={() => conversation && void exportImage(conversation)}
              >
                <i className="fas fa-image" />
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
                title={
                  streaming
                    ? chat.options.busyMode === "queue"
                      ? "排队：当前回答结束后自动发送"
                      : chat.options.busyMode === "interrupt"
                        ? "打断当前回答并发送"
                        : "正在生成（设置里可改成排队 / 打断）"
                    : "发送"
                }
                disabled={
                  (streaming && chat.options.busyMode === "wait") ||
                  (!chat.draft.trim() && !chat.attachments.length)
                }
              >
                <ChatIcon name="send" />
              </button>
            </div>
          </form>
          {contextUse && (
            <div
              className="chat-context"
              title="已用 = 上一轮 prompt + 输出 token；分母是这个模型实际运行的上下文（--ctx-size）"
            >
              <span>
                上下文 {fmtTokCount(contextUse.used)}
                {contextUse.limit
                  ? ` / ${fmtTokCount(contextUse.limit)}（${contextUse.pct ?? 0}%）`
                  : ""}
              </span>
            </div>
          )}
          {dock && (
            <div className="composer-dock" title="本次会话累计：轮次、工具次数、上一次回答的速度与首 token、token 与缓存">
              {dock}
            </div>
          )}
          {quote && (
            <button
              type="button"
              className="chat-quote-btn"
              // 位置是运行时量出来的（选区坐标），样式本身全在 components.css 里
              style={{ "--quote-top": `${quote.top}px`, "--quote-left": `${quote.left}px` } as CSSProperties}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => insertQuote(quote.text)}
              title="把选中的文字引用进输入框"
            >
              <i className="fas fa-quote-left" /> 引用
            </button>
          )}
        </div>
      </div>

      {samplingOpen && (
        <ChatSamplingSheet
          options={chat.options}
          models={modelNames}
          messages={conversation?.messages ?? []}
          strata={allModels.find((m) => m.section === chat.options.model)?.channel === "strata"}
          onApply={(next) => setChatOptions(next)}
          onClose={() => setSamplingOpen(false)}
        />
      )}
    </section>
    </main>
  );
}

/** 历史栏里的一条：点主体切换会话，行内改名，点按钮删除（实现在 ChatHistoryItem.tsx，审查 Q1 拆出） */