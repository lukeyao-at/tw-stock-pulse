#!/usr/bin/env node
/**
 * 產生盤後快照 snapshot/index.html：把當天收盤後的真實資料（股票宇宙、
 * 自選股兩年日 K、產業雷達、新聞、事件）打包成一個自包含頁面，發布到固定
 * 網址後，任何裝置都能看。每日盤後排程會重建並重新發布。
 *
 *   npm run build:snapshot
 *   npm run build:snapshot -- --watchlist-file /path/profile.json
 *
 * --watchlist-file 可以是頁面同步到雲端的設定（{ "watchlist": [...] }），
 * 也可以是 data/watchlist.json 的格式（{ holdings, groups }）。沒給就用
 * data/watchlist.json。持股（data/watchlist.json 的 holdings）一律併入。
 *
 * 資料抓不到時寧可失敗也不發布：股票宇宙退回樣本、或多數自選股抓不到日 K，
 * 就以非 0 結束，避免把樣本或殘缺的數字當成真實行情發出去。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { buildPage, read, ROOT } from './page-builder.js';
import * as universe from '../src/universe.js';
import * as api from '../src/api.js';
import * as history from '../src/sources/history.js';
import * as newsSource from '../src/sources/news.js';
import * as twse from '../src/sources/twse.js';

const log = (...a) => console.error(...a);

// ── 清單
const base = JSON.parse(read('data/watchlist.json'));
const listFromFile = (json) => (Array.isArray(json.watchlist)
  ? json.watchlist
  : [...(json.holdings ?? []), ...Object.values(json.groups ?? {}).flat()]);

const fileArg = process.argv.indexOf('--watchlist-file');
let codes = listFromFile(base);
if (fileArg !== -1) {
  const file = process.argv[fileArg + 1];
  try {
    const fromFile = listFromFile(JSON.parse(readFileSync(file, 'utf8')));
    if (fromFile.length) codes = fromFile;
    else log(`⚠ ${file} 沒有自選股，改用 data/watchlist.json`);
  } catch (err) {
    log(`⚠ 讀不到 ${file}（${err.message}），改用 data/watchlist.json`);
  }
}
codes = [...new Set([...base.holdings, ...codes].map((c) => String(c).trim().toUpperCase()).filter(Boolean))].slice(0, 60);
log(`自選股 ${codes.length} 檔`);

// ── 股票宇宙
const uni = await universe.load();
// 宇宙完整時有兩千多檔；只剩幾十檔代表退回了內建樣本，不能當真實行情發布
if (uni.stocks.length < 500) {
  log(`✗ 股票宇宙只有 ${uni.stocks.length} 檔（退回樣本資料），不產生快照。${uni.notes.join('；')}`);
  process.exit(1);
}
const targets = codes.map((code) => {
  const s = uni.byCode.get(code);
  return { code, name: s?.name || code, market: s?.market || '上市' };
});

// ── 日 K（一次 4 檔，避免一口氣打太多請求）
const barsByCode = {};
const barFailures = [];
for (let i = 0; i < targets.length; i += 4) {
  await Promise.all(targets.slice(i, i + 4).map(async (t) => {
    try {
      const daily = await history.dailyBars(t.code, uni.byCode.get(t.code)?.market);
      if (daily.bars.length) barsByCode[t.code] = daily.bars;
      else barFailures.push(`${t.code} 沒有日 K`);
    } catch (err) {
      barFailures.push(`${t.code} ${err.message}`);
    }
  }));
}
log(`日 K ${Object.keys(barsByCode).length}/${targets.length} 檔${barFailures.length ? `；失敗：${barFailures.join('、')}` : ''}`);
if (Object.keys(barsByCode).length < Math.ceil(targets.length / 2)) {
  log('✗ 超過一半的自選股抓不到日 K，不產生快照');
  process.exit(1);
}

// ── 新聞（個股新聞一次最多 20 檔）
const news = [];
for (let i = 0; i < targets.length; i += 20) {
  try {
    news.push(...(await newsSource.forSymbols(targets.slice(i, i + 20))).items);
  } catch (err) {
    log(`⚠ 個股新聞：${err.message}`);
  }
}
try {
  news.push(...(await newsSource.general()).items);
} catch (err) {
  log(`⚠ 一般新聞：${err.message}`);
}
const seenLinks = new Set();
const uniqueNews = news.filter((n) => (seenLinks.has(n.link) ? false : seenLinks.add(n.link))).slice(0, 200);

// ── 事件
let events = [];
try {
  const r = await twse.events();
  events = (r.value ?? r).events ?? [];
} catch (err) {
  log(`⚠ 事件：${err.message}`);
}

// ── 產業雷達
let radar = null;
try {
  radar = await api.radar({ watchlist: codes });
} catch (err) {
  log(`⚠ 產業雷達：${err.message}`);
}

// ── 資料日期：自選股最新一根 K 線的日期（多數決，個別停牌的不影響）
const lastDates = Object.values(barsByCode).map((b) => b[b.length - 1].date);
const counts = lastDates.reduce((m, d) => m.set(d, (m.get(d) ?? 0) + 1), new Map());
const asOf = [...counts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];

/** 前端的預設自選股換成這次快照的清單：新裝置第一次打開、雲端設定還沒載入前就是對的 */
function useSnapshotWatchlist(appJs) {
  const re = /const DEFAULT_WATCHLIST = \[([\s\S]*?)\];/;
  if (!re.test(appJs)) throw new Error('在 public/app.js 找不到 DEFAULT_WATCHLIST');
  return appJs.replace(re, () => `const DEFAULT_WATCHLIST = ${JSON.stringify(codes)};`);
}

const html = buildPage({
  mode: 'snapshot',
  stocks: uni.stocks,
  news: uniqueNews,
  events,
  barsByCode,
  radar,
  meta: { asOf, generatedAt: new Date().toISOString(), watchlist: codes },
  transformAppJs: useSnapshotWatchlist,
  title: '台股脈動',
});

mkdirSync(path.join(ROOT, 'snapshot'), { recursive: true });
const out = path.join(ROOT, 'snapshot/index.html');
writeFileSync(out, html);
const mb = (Buffer.byteLength(html) / 1024 / 1024).toFixed(2);
console.log(`snapshot/index.html 已產生 · ${mb} MB · 資料至 ${asOf} · ${uni.stocks.length} 檔個股 · 日 K ${Object.keys(barsByCode).length} 檔 · 新聞 ${uniqueNews.length} 則 · 事件 ${events.length} 筆 · 產業雷達 ${radar?.ok ? '有' : '無'}`);
