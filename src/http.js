/**
 * 對外抓取的統一入口：逾時、重試、瀏覽器樣 UA。
 *
 * 每個來源都可能單獨掛掉，所以這裡只負責「盡力抓」與「明確失敗」，
 * 由呼叫端決定要不要降級（見 cache.through 的 stale 行為）。
 */

import { HTTP_TIMEOUT_MS, HTTP_RETRIES, USER_AGENT, OFFLINE } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FetchError extends Error {
  constructor(message, { url, status } = {}) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
  }
}

export async function fetchText(url, { headers = {}, timeoutMs = HTTP_TIMEOUT_MS, retries = HTTP_RETRIES } = {}) {
  if (OFFLINE) {
    throw new FetchError('離線模式（TSP_OFFLINE=1），不對外連線', { url });
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.6',
          ...headers,
        },
      });
      if (!res.ok) {
        // 4xx 多半是端點改版或被擋，重試沒意義；5xx 才值得重試。
        const err = new FetchError(`HTTP ${res.status}`, { url, status: res.status });
        if (res.status < 500) throw err;
        lastErr = err;
        continue;
      }
      return await res.text();
    } catch (err) {
      if (err instanceof FetchError && err.status && err.status < 500) throw err;
      lastErr = err.name === 'AbortError'
        ? new FetchError(`逾時 ${timeoutMs}ms`, { url })
        : new FetchError(err.message, { url });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const text = await fetchText(url, { headers: { Accept: 'application/json' }, ...opts });
  try {
    return JSON.parse(text);
  } catch {
    throw new FetchError(`回應不是合法 JSON（前 80 字：${text.slice(0, 80).replace(/\s+/g, ' ')}）`, { url });
  }
}
