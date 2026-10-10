/**
 * 显存预估结果的缓存（localStorage，**按模型各记一份**）。
 *
 * llama-fit-params 跑一次要几秒，而结果是「这个模型在这套参数、这套设备上要占多少显存」，
 * 所以在同一台机器上重复打开同一个模型时没必要重算。
 *
 * 注意两点：
 * - 结果**不当作实时值**：条目里记着估算时的参数指纹、llama.cpp 版本与设备集合，
 *   任一变化都只提示「可能要重算」，由用户点「重新估算」，不会自动跑。
 * - 只留最近 MAX_ENTRIES 个模型，超出丢最旧的，避免 localStorage 无限膨胀。
 */
import type { FitRow } from "../types";

export interface FitCacheEntry {
  /** 估算的是哪个模型（gguf 路径），也是这份缓存的键 */
  path: string;
  rows: FitRow[];
  /** 估算时刻（ms），用于显示「上次估算」 */
  at: number;
  /** 估算时用的 llama.cpp 版本名 */
  version: string;
  /** 估算时可见的设备名（逗号拼接） */
  devices: string;
  /** 估算时的参数指纹（只含与显存相关的参数） */
  params: string;
}

const KEY = "fitPreviewCache";
const MAX_ENTRIES = 30;

type CacheMap = Record<string, FitCacheEntry>;

function loadAll(): CacheMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CacheMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveAll(map: CacheMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* 配额满之类，存不下就算了：只是下次要重算 */
  }
}

/** 取某个模型上次的估算结果；没算过或数据损坏都返回 null。 */
export function getFitEntry(path: string): FitCacheEntry | null {
  if (!path) return null;
  const entry = loadAll()[path];
  if (!entry || !Array.isArray(entry.rows)) return null;
  return entry;
}

/** 写入某个模型的结果；超出上限时先丢最旧的。 */
export function putFitEntry(path: string, entry: FitCacheEntry): void {
  const map = loadAll();
  map[path] = entry;
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => {
        delete map[k];
      });
  }
  saveAll(map);
}
