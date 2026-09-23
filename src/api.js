/**
 * API 層。
 *
 * 個人化資料（自選股、持股、提醒規則）一律由前端在請求裡帶上來，
 * 後端不保存任何使用者資料 —— 沒有帳號、沒有資料庫、沒有 cookie。
 * 這讓部署變得零狀態，也避免我們去保管別人的持股明細。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as universe from './universe.js';
import * as quotesSource from './sources/quotes.js';
import * as newsSource from './sources/news.js';
import * as twse from './sources/twse.js';
import * as history from './sources/history.js';
import * as portfolio from './portfolio.js';
import * as alerts from './alerts.js';
import * as cache from './cache.js';
import { analyze, summarize } from './sentiment.js';
import { symbolsFor } from './match.js';
import { recommend } from './recommend.js';
import { report as technicalReport } from './technical.js';
import { sampleBars } from './sample-bars.js';
import { OFFLINE } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sampleNews = () =>
  readFile(path.join(HERE, '..', 'data', 'sample-news.json'), 'utf8').then(JSON.parse);

/** 把使用者傳來的自選股正規化成 [{code, name, market}] */
function normalizeWatchlist(input, byCode) {
  const seen = new Set();
  const out = [];
  for (const entry of input ?? []) {
    const code = String(typeof entry === 'string' ? entry : entry?.code || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const stock = byCode.get(code);
    out.push({ code, name: stock?.name || code, market: stock?.market || '上市' });
  }
  return out;
}

/** 為新聞加上情緒與相關個股 */
function decorateNews(items, watchlist, allNames) {
  return items.map((item) => {
    const sentiment = analyze(`${item.title} ${item.summary || ''}`);
    const matchedSymbols = symbolsFor(item, watchlist, { allNames });
    return { ...item, sentiment, matchedSymbols };
  });
}

/** 離線模式下合成幾筆未來事件，讓事件提醒也能被實際驗證 */
function sampleEvents(watchlist) {
  const today = new Date();
  const iso = (offsetDays) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };
  const kinds = ['法說會', '除權息', '月營收'];
  return watchlist.slice(0, 6).map((s, i) => ({
    code: s.code,
    name: s.name,
    kind: kinds[i % kinds.length],
    date: iso((i % 5) + 1),
    detail: null,
  }));
}

/**
 * 主要端點：一次算完整個畫面需要的資料。
 * @param {object} body { watchlist, holdings, rules, risk, goals, excludeIndustries, feeDiscount }
 */
export async function dashboard(body = {}) {
  const notes = [];
  const sourceErrors = [];

  const uni = await universe.load();
  notes.push(...uni.notes);

  const watchlist = normalizeWatchlist(body.watchlist, uni.byCode);
  const holdings = (body.holdings ?? []).filter((h) => h?.code);

  // 持股也要有報價，所以一起送去查即時價
  const quoteTargets = normalizeWatchlist(
    [...watchlist.map((w) => w.code), ...holdings.map((h) => h.code)],
    uni.byCode,
  );

  const allNames = uni.stocks.map((s) => s.name).filter(Boolean);

  const [quoteResult, generalNews, symbolNews, eventResult, avgVolResult] = await Promise.allSettled([
    OFFLINE ? Promise.resolve({ quotes: [], failures: ['離線模式：不查即時報價，改用收盤價'] })
            : quotesSource.realtime(quoteTargets),
    OFFLINE ? sampleNews().then((s) => ({ items: s.items, failures: ['離線模式：使用 data/sample-news.json'] }))
            : newsSource.general(),
    OFFLINE ? Promise.resolve({ items: [], failures: [] })
            : newsSource.forSymbols(watchlist),
    OFFLINE ? Promise.resolve({ value: { events: sampleEvents(watchlist), failures: [] } })
            : twse.events(),
    OFFLINE ? Promise.resolve({ avgVolumes: new Map(), failures: ['離線模式：不查歷史均量'] })
            : history.averageVolumes(watchlist.map((w) => w.code)),
  ]);

  const unwrap = (settled, label, fallback) => {
    if (settled.status === 'fulfilled') return settled.value;
    sourceErrors.push(`${label}：${settled.reason?.message || settled.reason}`);
    return fallback;
  };

  const quoteData = unwrap(quoteResult, '即時報價', { quotes: [], failures: [] });
  const generalData = unwrap(generalNews, '一般新聞', { items: [], failures: [] });
  const symbolData = unwrap(symbolNews, '個股新聞', { items: [], failures: [] });
  const eventsWrapped = unwrap(eventResult, '事件資料', { value: { events: [], failures: [] } });
  const eventData = eventsWrapped.value ?? eventsWrapped;
  const avgVolData = unwrap(avgVolResult, '歷史均量', { avgVolumes: new Map(), failures: [] });

  sourceErrors.push(...(quoteData.failures ?? []), ...(generalData.failures ?? []),
                    ...(symbolData.failures ?? []), ...(eventData.failures ?? []),
                    ...(avgVolData.failures ?? []));

  const quoteByCode = new Map(quoteData.quotes.map((q) => [q.code, q]));

  // 把均量疊進宇宙，讓量能提醒有基準
  const byCodeWithAvg = new Map(uni.byCode);
  for (const [code, avgVolume] of avgVolData.avgVolumes ?? []) {
    const stock = byCodeWithAvg.get(code);
    if (stock) byCodeWithAvg.set(code, { ...stock, avgVolume });
  }

  // ── 新聞：個股專屬的排前面，通用的補後面
  const decorated = decorateNews(
    [...(symbolData.items ?? []), ...(generalData.items ?? [])],
    watchlist,
    allNames,
  );
  const personalized = decorated.filter((n) => n.matchedSymbols.length > 0);
  const others = decorated.filter((n) => n.matchedSymbols.length === 0);

  // ── 自選股列表（收盤 + 盤中疊加）
  const watchRows = watchlist.map((w) => {
    const stock = uni.byCode.get(w.code);
    const live = quoteByCode.get(w.code);
    return {
      code: w.code,
      name: stock?.name || live?.name || w.code,
      market: stock?.market ?? null,
      industry: stock?.industry ?? null,
      price: live?.price ?? stock?.close ?? null,
      change: live?.change ?? stock?.change ?? null,
      changePercent: live?.changePercent ?? stock?.changePercent ?? null,
      volume: live?.volume ?? stock?.volume ?? null,
      peRatio: stock?.peRatio ?? null,
      dividendYield: stock?.dividendYield ?? null,
      pbRatio: stock?.pbRatio ?? null,
      priceSource: live ? (live.estimated ? '盤中推估' : '盤中') : '收盤',
      newsCount: personalized.filter((n) => n.matchedSymbols.some((m) => m.code === w.code)).length,
      unknown: !stock && !live,
    };
  });

  const positions = portfolio.evaluate(holdings, byCodeWithAvg, quoteByCode, {
    feeDiscount: body.feeDiscount,
    includeFees: body.includeFees !== false,
  });

  const recommendations = recommend(uni.stocks, {
    risk: body.risk,
    goals: body.goals,
    holdings,
    watchlist,
    excludeIndustries: body.excludeIndustries,
    limit: body.recommendLimit ?? 8,
  });

  const fired = alerts.evaluate(body.rules ?? [], {
    byCode: byCodeWithAvg,
    quoteByCode,
    news: personalized,
    events: eventData.events ?? [],
    now: new Date().toISOString(),
  });

  // 自選股與持股的近期事件（30 天內），給行事曆區塊用
  const watchCodes = new Set([...watchlist.map((w) => w.code), ...holdings.map((h) => h.code)]);
  const upcoming = (eventData.events ?? [])
    .filter((e) => watchCodes.has(e.code))
    .filter((e) => {
      const days = Math.round((new Date(e.date) - Date.now()) / 86400000);
      return days >= 0 && days <= 30;
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 20);

  return {
    updatedAt: new Date().toISOString(),
    watchlist: watchRows,
    portfolio: positions,
    news: {
      personalized: personalized.slice(0, 40),
      others: others.slice(0, 20),
      mood: summarize(personalized.length ? personalized : decorated.slice(0, 30)),
    },
    recommendations,
    alerts: fired,
    events: upcoming,
    market: {
      total: uni.stocks.length,
      gainers: uni.stocks.filter((s) => (s.changePercent ?? 0) > 0).length,
      losers: uni.stocks.filter((s) => (s.changePercent ?? 0) < 0).length,
      topGainers: [...uni.stocks].sort((a, b) => (b.changePercent ?? -99) - (a.changePercent ?? -99)).slice(0, 5),
      topLosers: [...uni.stocks].sort((a, b) => (a.changePercent ?? 99) - (b.changePercent ?? 99)).slice(0, 5),
      mostActive: [...uni.stocks].sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0)).slice(0, 5),
    },
    diagnostics: {
      offline: OFFLINE,
      degraded: uni.degraded || sourceErrors.length > 0,
      universeFromCache: uni.fromCache,
      universeUpdatedAt: uni.updatedAt,
      notes,
      sourceErrors: [...new Set(sourceErrors)],
    },
  };
}

/**
 * 單一個股的技術分析（通道 + 指標 + 歷史驗證）。
 *
 * 跟 dashboard 分開：一檔要抓兩年日 K，只在使用者打開技術分析分頁、
 * 選了某一檔時才算，不拖慢主畫面。
 * @param {{code:string, lookback?:number, capital?:number, riskPct?:number}} query
 */
export async function technical(query = {}) {
  const code = String(query.code || '').trim().toUpperCase();
  if (!code) return { ok: false, reason: '請指定股票代號' };

  const uni = await universe.load();
  const stock = uni.byCode.get(code);
  // 宇宙完整時查不到就是代號打錯，不必去連打十幾次交易所備援
  // 離線時只能替樣本裡有的股票產生模擬 K 線，否則等於憑空捏造走勢
  if (!stock && (!uni.degraded || OFFLINE)) return { ok: false, code, name: code, reason: `查無代號 ${code}` };

  const opts = {
    lookback: Number(query.lookback) || 120,
    capital: Number(query.capital) > 0 ? Number(query.capital) : undefined,
    riskPct: Number(query.riskPct) > 0 ? Math.min(Number(query.riskPct), 10) : undefined,
  };

  let daily;
  if (OFFLINE) {
    daily = {
      bars: sampleBars(code, { close: stock?.close ?? 100, volume: stock?.volume ?? 5e6 }),
      source: '模擬 K 線（離線模式）',
      failures: ['離線模式：K 線為依樣本收盤價產生的模擬走勢，非真實行情'],
      sample: true,
    };
  } else {
    try {
      daily = await history.dailyBars(code, stock?.market);
    } catch (err) {
      return { ok: false, code, name: stock?.name || code, reason: `抓不到 ${code} 的歷史 K 線：${err.message}` };
    }
  }

  const result = technicalReport(daily.bars, opts);
  return {
    code,
    name: stock?.name || daily.name || code,
    market: stock?.market ?? null,
    industry: stock?.industry ?? null,
    source: daily.source,
    sample: Boolean(daily.sample),
    notes: daily.failures ?? [],
    ...result,
  };
}

/** 個股搜尋（自選股輸入框用） */
export async function search(query) {
  const uni = await universe.load();
  return { query, results: universe.search(uni.stocks, query), degraded: uni.degraded };
}

/** 來源健康度 */
export async function health() {
  const uni = await universe.load().catch((err) => ({ stocks: [], notes: [err.message], degraded: true }));
  return {
    ok: true,
    offline: OFFLINE,
    stockCount: uni.stocks.length,
    degraded: uni.degraded,
    notes: uni.notes,
    cache: cache.stats(),
    now: new Date().toISOString(),
  };
}
