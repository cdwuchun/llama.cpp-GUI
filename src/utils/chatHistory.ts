/**
 * 聊天历史的纯逻辑：编辑回退（重新生成 / 改写回答 / 回到某条消息 / 分支）与附件丢失判定。
 *
 * 照上游 `serve/web/history.js` 移植（0.1.52）：那边是纯函数 + `chats-ui.js` 画界面，
 * 本工程把纯函数放这里、状态变更放 `store.ts` 的聊天区、界面在 `ChatPanel` / `ChatMessageView`。
 *
 * 与上游的字段对照：
 * - 上游 `m.text` → 本工程 `ChatTurn.content`
 * - 上游 `m.images` / `m.files`（带 url / text 才算有内容）→ 本工程 `ChatTurn.attachments[].content`
 *   （落盘时被 `trimConversation` 清空，所以「回到历史点」时读不到的附件只剩名字）
 */

import type { ChatAttachment, ChatTurn, Conversation } from "./chat";
import { newId } from "./chat";

/** 撤销上一次「编辑回退」用的快照（上游的 Undo 条） */
export interface ChatUndo {
  /** 动作之前的整份消息列表，撤销时原样放回 */
  messages: ChatTurn[];
  /** 撤销条上的说明（「已回到这条消息，后面 2 条已隐藏」之类） */
  text: string;
  /** 放回输入框的那段文字；撤销时若草稿仍是它（没动过），才把原草稿还回去 */
  inserted?: string;
  /** 动作把输入框内容换掉之前的原草稿 */
  draftBefore?: { text: string; attachments: ChatAttachment[] };
}

/** 一条用户消息回填到输入框时，还有内容的附件与丢了几份（只有名字） */
export interface ChatDraft {
  text: string;
  attachments: ChatAttachment[];
  /** 只有名字、读不到内容的附件数；> 0 时界面要提示重新添加 */
  lost: number;
}

/** 附件内容是否还在（历史会话落盘时把 content 清空了） */
export function lostAttachmentCount(turn: ChatTurn): number {
  return (turn.attachments ?? []).filter((file) => !file.content).length;
}

/** 用户消息 → 输入框草稿：保留还有内容的附件，丢掉只剩名字的（上游 `draftOf`） */
export function draftOfTurn(turn: ChatTurn): ChatDraft {
  const kept = (turn.attachments ?? []).filter((file) => Boolean(file.content));
  return {
    text: turn.content,
    attachments: kept.map((file) => ({ ...file })),
    lost: (turn.attachments ?? []).length - kept.length,
  };
}

export interface ChatHistoryPlan {
  /** 改动后留下的消息 */
  keep: ChatTurn[];
  /** 用户消息回填输入框（助手消息不需要） */
  draft: ChatDraft | null;
  /** 被隐藏（从列表里拿掉、可由撤销恢复）的消息数 */
  hidden: number;
}

/**
 * 「回到这里」：用户消息回填输入框并退出列表；助手消息留下，后面的全部拿掉（上游 `rewind`）。
 * 拿掉的消息不删数据，交给撤销条恢复。
 */
export function rewindPlan(messages: ChatTurn[], index: number): ChatHistoryPlan | null {
  const message = messages[index];
  if (!message) return null;
  if (message.role === "user") {
    return {
      keep: messages.slice(0, index),
      draft: draftOfTurn(message),
      hidden: messages.length - index,
    };
  }
  return { keep: messages.slice(0, index + 1), draft: null, hidden: messages.length - index - 1 };
}

/** 「重新生成」：从 index 往前找到那条用户消息，保留到它为止，后面的回答由新请求覆盖（上游 `regenerate`） */
export function regeneratePlan(
  messages: ChatTurn[],
  index: number,
): { keep: ChatTurn[]; hidden: number } | null {
  let user = Math.min(index, messages.length - 1);
  while (user >= 0 && messages[user]?.role !== "user") user -= 1;
  if (user < 0) return null;
  return { keep: messages.slice(0, user + 1), hidden: messages.length - user - 1 };
}

/**
 * 「改写回答」：只替换这条助手消息的文字，旧的思考 / 工具调用 / 用量全部丢掉，
 * 后面的消息隐藏（上游 `editAnswer`，`meta` 是界面上「已编辑」的小标记）。
 */
export function editAnswerPlan(
  messages: ChatTurn[],
  index: number,
  text: string,
  meta = "已编辑",
): { keep: ChatTurn[]; hidden: number } | null {
  const message = messages[index];
  if (!message || message.role !== "assistant") return null;
  const edited: ChatTurn = {
    id: message.id,
    role: "assistant",
    content: text,
    createdAt: message.createdAt,
    meta,
  };
  return { keep: [...messages.slice(0, index), edited], hidden: messages.length - index - 1 };
}

/** 「从这里开分支」：新建一份会话，带上到 `end` 为止的消息副本；原会话不动（上游 `branch`） */
export function branchConversation(
  conversation: Conversation,
  keep: ChatTurn[],
  title: string,
  now = Date.now(),
): Conversation {
  const copy: ChatTurn[] = JSON.parse(JSON.stringify(keep)) as ChatTurn[];
  return {
    id: newId(),
    model: conversation.model,
    title,
    messages: copy,
    createdAt: now,
    updatedAt: now,
    parent: { id: conversation.id, title: conversation.title },
  };
}
