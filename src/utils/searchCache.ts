/**
 * 跨轮查询缓存（方案 v2 第 1 项）。
 *
 * 照 Strata `web-search-ddg.mjs` 的 30 分钟 / 120 条思路，只在内存里放一份：
 * 同一轮对话里模型常把同一个词换个大写、加点空格再来一遍；匿名引擎（anysearch）
 * 的额度按分钟算，重复打一次就是一次浪费，还容易把自己打进冷却。
 *
 * 键 = 归一化后的查询 + limit + 时间范围。存整份 `SearchResponse`，
 * 命中时把 `cached` 置 true —— 工具卡片上显示的就是这个字段。
 */

import type { SearchResponse } from "../types";

/** 30 分钟：与 Strata 的 `CACHE_MS` 一致；模型换了话题，旧结果基本不会再命中 */
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
/** 120 条上限，超了丢最旧的一条（与 Strata 的 `CACHE_SIZE` 一致） */
const SEARCH_CACHE_MAX = 120;

interface CacheEntry {
  at: number;
  response: SearchResponse;
}

const entries = new Map<string, CacheEntry>();

/**
 * 查询归一化：小写、压缩空白、去掉首尾标点。
 * 比后端 `cache_key` 宽松一点 —— 那边只做 trim + 小写，这里顺手把「Qwen4-Flash 参数？」
 * 和「qwen4-flash 参数」当成同一个词。
 */
export function normalizeSearchQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .trim();
}

function keyOf(query: string, limit: number | undefined, timeRange: string | null | undefined): string {
  return `${normalizeSearchQuery(query)}|${limit ?? ""}|${timeRange ?? ""}`;
}

/** 命中就返回带 `cached: true` 的副本；过期或没有则返回 null */
export function searchCacheGet(
  query: string,
  limit: number | undefined,
  timeRange?: string | null,
): SearchResponse | null {
  const key = keyOf(query, limit, timeRange);
  const entry = entries.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SEARCH_CACHE_TTL_MS) {
    entries.delete(key);
    return null;
  }
  return { ...entry.response, cached: true };
}

/** 只在真拿到结果时写入：一条都没搜到的查询不占位置，下次还能再试 */
export function searchCachePut(
  query: string,
  limit: number | undefined,
  response: SearchResponse,
  timeRange?: string | null,
): void {
  if (response.hits.length === 0) return;
  const key = keyOf(query, limit, timeRange);
  if (entries.size >= SEARCH_CACHE_MAX) {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [itemKey, entry] of entries) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = itemKey;
      }
    }
    if (oldestKey !== null) entries.delete(oldestKey);
  }
  entries.set(key, { at: Date.now(), response: { ...response, cached: true } });
}
