/**
 * 会话的 IndexedDB 存储（P1：localStorage 30 条的上限顶不住长期使用）。
 *
 * localStorage 只有 5 MB，还不敢存附件正文，聊上几十次就得丢最旧的；
 * 这里用原生 IndexedDB 存全量会话（单条会话独立记录，按 id 覆盖），
 * localStorage 那份降级保留：IDB 不可用（隐私模式 / 旧内核）时界面照常工作。
 *
 * 写入策略：`putConversations()` 在一个事务里 clear + 批量 put。
 * 会话条数是几百量级，全量重写比逐条 diff 简单，也避免删漏。
 */

import type { Conversation } from "./chat";

const DB_NAME = "llamacpp-gui-chat";
const DB_VERSION = 1;
const STORE = "conversations";

/** IndexedDB 里最多保留的会话数：比 localStorage 的 30 条宽得多，又不至于无限膨胀 */
export const STORE_CONVERSATION_LIMIT = 500;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // keyPath 用 id：同一会话重复保存是覆盖，不会产生副本
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      // 隐私模式 / 配额满时 open 可能直接抛，上面已经包住
    } catch {
      resolve(null);
    }
  });
}

/** 全量写入（按 updatedAt 倒序裁到上限）。返回是否写入成功，失败时调用方继续用 localStorage */
export async function putConversations(list: Conversation[]): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const kept = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, STORE_CONVERSATION_LIMIT);
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.clear();
      for (const item of kept) store.put(item);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

/** 读取全部会话；IDB 不可用或空库时返回 null（调用方保留 localStorage 里的那份） */
export async function allConversations(): Promise<Conversation[] | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => {
        const list = Array.isArray(request.result) ? (request.result as Conversation[]) : [];
        db.close();
        resolve(list.length ? list.sort((a, b) => b.updatedAt - a.updatedAt) : null);
      };
      request.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

/** 删掉一条会话记录（列表整体重写之外的单条删除，省一次全量事务） */
export async function deleteConversationRow(id: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      // 事务真正结束后再关库（审查 F4）：原来在 await 前就 db.close()，
      // 事务可能被中止，已删的会话重启后又冒出来。
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
