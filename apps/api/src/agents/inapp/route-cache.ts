import type { RouteResult } from "./router.js";

/**
 * Route 快取（優化 D）：把「這句話的 intent+spec」快取起來，重複問免再打 14B。
 *
 * 為何安全：route 只表達「這句話什麼意思」（intent + 查詢參數），與「誰問、DB 現在有什麼」
 * 完全無關——真正的資料查詢仍每次走 RLS 讀 DB。因此 cache key 只需正規化問句，
 * 不含 workspace / member（無跨租戶洩漏風險：route 不含任何使用者資料）。
 *
 * 只快取 via='agent' / 'agent+backstop'（真的打了 14B 的結果）；'rules-fallback'
 * 是 LLM 不可用時的降級，不快取（避免把降級結果黏住，LLM 恢復後仍回舊答）。
 *
 * TTL 短（預設 5 分鐘）+ LRU 上限，避免記憶體無限成長；純進程內（多實例各自持有，
 * 語意仍正確，因 route 與實例無關）。
 */

const TTL_MS = Number(process.env.INAPP_ROUTE_CACHE_TTL_MS ?? 5 * 60_000);
const MAX_ENTRIES = Number(process.env.INAPP_ROUTE_CACHE_MAX ?? 500);

interface Entry {
  value: RouteResult;
  expires: number;
}

const store = new Map<string, Entry>();

/**
 * 正規化問句成 cache key：trim、壓多重空白、小寫（英數）。中文保留原樣。
 * `scope` 用來把「會影響路由判斷的 workspace 條件」（目前是群組名稱指紋）併入 key，
 * 避免 A workspace 的群組讓 B workspace 誤命中同一句話的路由結果。
 */
export function normalizeKey(text: string, scope = ""): string {
  const base = text.trim().replace(/\s+/g, " ").toLowerCase();
  return scope ? `${scope}\u0000${base}` : base;
}

export function getCachedRoute(text: string, scope = ""): RouteResult | null {
  const key = normalizeKey(text, scope);
  const e = store.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    store.delete(key);
    return null;
  }
  // LRU touch：重新插入到尾端
  store.delete(key);
  store.set(key, e);
  return e.value;
}

export function setCachedRoute(text: string, value: RouteResult, scope = ""): void {
  // 只快取真的打過 14B 的結果，不黏住降級路徑
  if (value.via === "rules-fallback") return;
  const key = normalizeKey(text, scope);
  store.delete(key);
  store.set(key, { value, expires: Date.now() + TTL_MS });
  // LRU 逐出最舊
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** 測試用：清空快取。 */
export function clearRouteCache(): void {
  store.clear();
}
