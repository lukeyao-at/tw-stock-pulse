/**
 * 新聞抓取。
 *
 * 兩種取法並用：
 *  1. 大盤/類股的通用 RSS（config.NEWS_FEEDS）——鋪底用。
 *  2. 個股專屬 RSS（config.NEWS_SYMBOL_FEED）——自選股的精準新聞，
 *     這是「個人化標題」品質的主要來源。
 *
 * 每個 feed 獨立容錯：掛掉的只會出現在 failures，不影響其他來源。
 */

import { NEWS_FEEDS, NEWS_SYMBOL_FEED, TTL } from '../config.js';
import { fetchText } from '../http.js';
import * as cache from '../cache.js';
import { parseFeed } from '../parse.js';

/** 同一篇新聞常同時出現在多個 feed，用連結（無連結則用標題）去重。 */
function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = (item.link || item.title).replace(/[?#].*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

const byRecency = (a, b) =>
  new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime();

async function loadFeed(name, url, extra = {}) {
  const xml = await fetchText(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' } });
  return parseFeed(xml, { sourceName: name }).map((item) => ({ ...item, ...extra }));
}

/** 通用新聞（所有設定的 feed 合併） */
export async function general() {
  const result = await cache.through('news:general', TTL.news, async () => {
    const settled = await Promise.allSettled(
      NEWS_FEEDS.map((feed) => loadFeed(feed.name, feed.url)),
    );

    const items = [];
    const failures = [];
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') items.push(...res.value);
      else failures.push(`${NEWS_FEEDS[i].name} → ${res.reason?.message || res.reason}`);
    });

    return { items: dedupe(items).sort(byRecency), failures };
  });

  return result.value;
}

/**
 * 個股新聞。
 * @param {Array<{code:string,name?:string}>} targets 自選股
 */
export async function forSymbols(targets) {
  const list = targets.filter((t) => t?.code).slice(0, 20); // 保護：一次最多 20 檔
  if (!list.length) return { items: [], failures: [] };

  const key = `news:symbols:${list.map((t) => t.code).sort().join(',')}`;

  const result = await cache.through(key, TTL.news, async () => {
    const settled = await Promise.allSettled(
      list.map((t) =>
        loadFeed(
          `個股 ${t.code}`,
          NEWS_SYMBOL_FEED.replace('{code}', t.code),
          // 標記這篇是哪一檔的專屬新聞，前端據此顯示標籤，
          // 也讓比對階段不必再靠關鍵字猜。
          { symbols: [t.code] },
        ),
      ),
    );

    const items = [];
    const failures = [];
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled') items.push(...res.value);
      else failures.push(`${list[i].code} → ${res.reason?.message || res.reason}`);
    });

    return { items: dedupe(items).sort(byRecency), failures };
  });

  return result.value;
}
