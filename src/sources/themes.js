/**
 * 題材新聞：用 Google 新聞搜尋 RSS 量每個題材最近 30 天的新聞量。
 * 一個題材一個請求，快取 3 小時。
 */

import { RADAR, TTL } from '../config.js';
import { fetchText } from '../http.js';
import * as cache from '../cache.js';
import { parseFeed } from '../parse.js';

/** Google 新聞標題是「標題 - 媒體」，拆開來 */
export function splitSource(title) {
  const m = String(title).match(/^(.*\S)\s+-\s+([^-]{2,30})$/);
  return m ? { title: m[1], source: m[2].trim() } : { title, source: '' };
}

export async function themeNews(query) {
  const url = RADAR.googleNews.replace('{q}', encodeURIComponent(query));
  const { value } = await cache.through(`themes:${query}`, TTL.themes, async () => {
    const xml = await fetchText(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, retries: 1 });
    return parseFeed(xml).map((i) => ({ ...i, ...splitSource(i.title), summary: undefined }));
  });
  return value;
}
