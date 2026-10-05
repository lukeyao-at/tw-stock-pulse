#!/usr/bin/env node
/**
 * 產生 demo/index.html —— 用 data/ 底下樣本資料的離線展示版。
 * 組頁的邏輯在 page-builder.js（盤後快照 build-snapshot.js 也用同一套）。
 *
 *   npm run build:demo
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import { buildPage, read, ROOT } from './page-builder.js';

const universe = JSON.parse(read('data/sample-universe.json'));
const news = JSON.parse(read('data/sample-news.json'));

/**
 * 產業雷達需要全市場 20 個交易日的資料，展示版無法現場算，改放一份真實資料快照
 * （重新產生：npm start 後 POST /api/radar，把回應存成 data/sample-radar.json）。
 */
const radar = existsSync(path.join(ROOT, 'data/sample-radar.json'))
  ? JSON.parse(read('data/sample-radar.json'))
  : null;

/**
 * 前端的預設自選股是使用者的真實清單，但樣本宇宙只有 50 檔；展示版只留樣本裡
 * 有的，否則畫面一半是「查無資料」。
 */
const sampleCodes = new Set(universe.stocks.map((s) => s.code));
function onlySampleCodes(appJs) {
  const re = /const DEFAULT_WATCHLIST = \[([\s\S]*?)\];/;
  const m = appJs.match(re);
  if (!m) throw new Error('在 public/app.js 找不到 DEFAULT_WATCHLIST');
  const codes = [...m[1].matchAll(/'([0-9A-Z]+)'/g)].map((x) => x[1]).filter((c) => sampleCodes.has(c));
  return appJs.replace(re, () => `const DEFAULT_WATCHLIST = ${JSON.stringify(codes)};`);
}

const html = buildPage({
  mode: 'demo',
  stocks: universe.stocks,
  news: news.items,
  radar,
  transformAppJs: onlySampleCodes,
  title: '台股脈動 — 介面展示',
});

mkdirSync(path.join(ROOT, 'demo'), { recursive: true });
writeFileSync(path.join(ROOT, 'demo/index.html'), html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`demo/index.html 已產生 · ${kb} KB · ${universe.stocks.length} 檔個股 · ${news.items.length} 則新聞`);
console.log('✓ 無任何外部檔案參照');
