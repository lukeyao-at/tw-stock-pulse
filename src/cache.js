/**
 * 極簡 TTL 記憶體快取，附「陳舊但可用」語意。
 *
 * 外部公開端點常常不穩（限流、維護、改版），所以除了正常的 TTL
 * 之外還保留過期資料：抓取失敗時 get(key, {allowStale:true})
 * 會回上一次成功的結果，讓頁面退化成「資料稍舊」而不是整頁空白。
 */

const store = new Map();

/** @returns {{value:any, stale:boolean, ageMs:number}|null} */
export function get(key, { allowStale = false } = {}) {
  const hit = store.get(key);
  if (!hit) return null;
  const ageMs = Date.now() - hit.at;
  const stale = ageMs > hit.ttlMs;
  if (stale && !allowStale) return null;
  return { value: hit.value, stale, ageMs };
}

export function set(key, value, ttlSeconds) {
  store.set(key, { value, at: Date.now(), ttlMs: ttlSeconds * 1000 });
  return value;
}

/**
 * 讀取或重算。重算失敗時若有陳舊資料就回陳舊資料，
 * 兩者都沒有才把錯誤丟出去。
 */
export async function through(key, ttlSeconds, producer) {
  const fresh = get(key);
  if (fresh) return { ...fresh, source: 'cache' };

  try {
    const value = await producer();
    set(key, value, ttlSeconds);
    return { value, stale: false, ageMs: 0, source: 'live' };
  } catch (err) {
    const stale = get(key, { allowStale: true });
    if (stale) return { ...stale, source: 'stale', error: err.message };
    throw err;
  }
}

export function clear() {
  store.clear();
}

export function stats() {
  const now = Date.now();
  return [...store.entries()].map(([key, hit]) => ({
    key,
    ageSeconds: Math.round((now - hit.at) / 1000),
    ttlSeconds: Math.round(hit.ttlMs / 1000),
    stale: now - hit.at > hit.ttlMs,
  }));
}
