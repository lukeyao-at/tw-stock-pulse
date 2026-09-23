#!/usr/bin/env node
/**
 * 產生 demo/index.html —— 單一自包含檔案，不需要伺服器就能開。
 *
 * 重點是「同一份程式碼」：計分引擎、情緒判讀、新聞比對、損益計算、技術分析全部
 * 從 src/ 直接取用，前端 public/app.js 也是原封不動內嵌，只用一層
 * fetch 攔截把 /api/* 換成瀏覽器端的本地運算。所以 demo 看到的行為
 * 和真的跑 npm start 一致，只有資料是 data/ 底下的樣本。
 *
 *   npm run build:demo
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

/** 拿掉 import 敘述（demo 是單檔，沒有模組系統） */
const stripImports = (src) => src.replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '');

/** 找出模組匯出的名稱 */
function exportedNames(src) {
  const names = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.push(m[1]);
  for (const m of src.matchAll(/^export\s+const\s+(\w+)/gm)) names.push(m[1]);
  return [...new Set(names)];
}

/**
 * 把一個模組包成 IIFE，回傳它的匯出。
 * 必須逐一包起來，因為 portfolio.js 和 alerts.js 都匯出 evaluate，
 * 全部攤平會撞名。
 */
function wrapModule(alias, src) {
  const body = stripImports(src).replace(/^export\s+/gm, '');
  const names = exportedNames(src);
  return `const ${alias} = (function () {\n${body}\nreturn { ${names.join(', ')} };\n})();`;
}

/** universe.js 有 node:fs 依賴，只取純函式 search */
function extractSearch() {
  const src = read('src/universe.js');
  const at = src.indexOf('/** 依代號或名稱搜尋');
  if (at === -1) throw new Error('在 src/universe.js 找不到 search 的起始標記');
  return wrapModule('Universe', src.slice(at));
}

const modules = [
  wrapModule('Sentiment', read('src/sentiment.js')),
  wrapModule('Match', read('src/match.js')),
  wrapModule('Recommend', read('src/recommend.js')),
  wrapModule('Portfolio', read('src/portfolio.js')),
  wrapModule('Alerts', read('src/alerts.js')),
  wrapModule('Technical', read('src/technical.js')),
  wrapModule('SampleBars', read('src/sample-bars.js')),
  extractSearch(),
].join('\n\n');

const universe = JSON.parse(read('data/sample-universe.json'));
const news = JSON.parse(read('data/sample-news.json'));

/**
 * 瀏覽器端的 dashboard 組裝。
 *
 * 這是 demo 專屬的接線，對應 src/api.js 的 dashboard()：後端版本要處理
 * 多個外部來源的容錯與快取，demo 沒有外部來源，所以只保留組裝邏輯，
 * 實際計算仍然全部交給上面那些真正的引擎。
 */
const glue = `
const STOCKS = ${JSON.stringify(universe.stocks)};
const NEWS = ${JSON.stringify(news.items)};
const BY_CODE = new Map(STOCKS.map((s) => [s.code, s]));
const ALL_NAMES = STOCKS.map((s) => s.name).filter(Boolean);

/** 樣本事件：以今天為基準往後排，讓事件提醒也能實際觸發 */
function sampleEvents(watchlist) {
  const kinds = ['法說會', '除權息', '月營收'];
  return watchlist.slice(0, 6).map((s, i) => {
    const d = new Date();
    d.setDate(d.getDate() + (i % 5) + 1);
    return { code: s.code, name: s.name, kind: kinds[i % kinds.length], date: d.toISOString().slice(0, 10), detail: null };
  });
}

function buildDashboard(body) {
  const watchlist = [];
  const seen = new Set();
  for (const entry of body.watchlist ?? []) {
    const code = String(typeof entry === 'string' ? entry : entry?.code || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const stock = BY_CODE.get(code);
    watchlist.push({ code, name: stock?.name || code, market: stock?.market || '上市' });
  }
  const holdings = (body.holdings ?? []).filter((h) => h?.code);

  const decorated = NEWS.map((item) => ({
    ...item,
    sentiment: Sentiment.analyze(\`\${item.title} \${item.summary || ''}\`),
    matchedSymbols: Match.symbolsFor(item, watchlist, { allNames: ALL_NAMES }),
  }));
  const personalized = decorated.filter((n) => n.matchedSymbols.length > 0);
  const others = decorated.filter((n) => n.matchedSymbols.length === 0);

  const events = sampleEvents(watchlist);

  const watchRows = watchlist.map((w) => {
    const s = BY_CODE.get(w.code);
    return {
      code: w.code, name: s?.name || w.code, market: s?.market ?? null, industry: s?.industry ?? null,
      price: s?.close ?? null, change: s?.change ?? null, changePercent: s?.changePercent ?? null,
      volume: s?.volume ?? null, peRatio: s?.peRatio ?? null, dividendYield: s?.dividendYield ?? null,
      pbRatio: s?.pbRatio ?? null, priceSource: '收盤',
      newsCount: personalized.filter((n) => n.matchedSymbols.some((m) => m.code === w.code)).length,
      unknown: !s,
    };
  });

  const portfolio = Portfolio.evaluate(holdings, BY_CODE, new Map(), {
    feeDiscount: body.feeDiscount, includeFees: body.includeFees !== false,
  });

  const recommendations = Recommend.recommend(STOCKS, {
    risk: body.risk, goals: body.goals, holdings, watchlist,
    excludeIndustries: body.excludeIndustries, limit: body.recommendLimit ?? 8,
  });

  const alerts = Alerts.evaluate(body.rules ?? [], {
    byCode: BY_CODE, quoteByCode: new Map(), news: personalized, events,
    now: new Date().toISOString(),
  });

  const watchCodes = new Set([...watchlist.map((w) => w.code), ...holdings.map((h) => h.code)]);
  const upcoming = events.filter((e) => watchCodes.has(e.code)).sort((a, b) => a.date.localeCompare(b.date));

  return {
    updatedAt: new Date().toISOString(),
    watchlist: watchRows,
    portfolio,
    news: {
      personalized: personalized.slice(0, 40),
      others: others.slice(0, 20),
      mood: Sentiment.summarize(personalized.length ? personalized : decorated.slice(0, 30)),
    },
    recommendations,
    alerts,
    events: upcoming,
    market: {
      total: STOCKS.length,
      gainers: STOCKS.filter((s) => (s.changePercent ?? 0) > 0).length,
      losers: STOCKS.filter((s) => (s.changePercent ?? 0) < 0).length,
      topGainers: [...STOCKS].sort((a, b) => (b.changePercent ?? -99) - (a.changePercent ?? -99)).slice(0, 5),
      topLosers: [...STOCKS].sort((a, b) => (a.changePercent ?? 99) - (b.changePercent ?? 99)).slice(0, 5),
      mostActive: [...STOCKS].sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0)).slice(0, 5),
    },
    diagnostics: {
      offline: true, degraded: true, universeFromCache: false,
      universeUpdatedAt: new Date().toISOString(),
      notes: ['這是離線展示版：所有數字來自內建樣本資料，非真實行情'],
      sourceErrors: [],
    },
  };
}

/** 對應 src/api.js 的 technical()：展示版沒有真實日 K，用同一支模擬產生器 */
function buildTechnical(params) {
  const code = String(params.get('code') || '').trim().toUpperCase();
  const stock = BY_CODE.get(code);
  if (!stock) return { ok: false, code, name: code, reason: \`展示版只有樣本裡的 \${STOCKS.length} 檔，查無 \${code}\` };
  const bars = SampleBars.sampleBars(code, { close: stock.close, volume: stock.volume });
  return {
    code, name: stock.name, market: stock.market, industry: stock.industry,
    source: '模擬 K 線（展示版）', sample: true,
    notes: ['展示版：K 線為依樣本收盤價產生的模擬走勢，非真實行情'],
    ...Technical.report(bars, {
      lookback: Number(params.get('lookback')) || 120,
      capital: Number(params.get('capital')) || undefined,
      riskPct: Number(params.get('riskPct')) || undefined,
    }),
  };
}

/**
 * 攔截 fetch，把 /api/* 導到本地運算。
 * 這樣 public/app.js 可以原封不動使用，畫面行為與真實版本完全一致。
 */
const passthrough = window.fetch.bind(window);
const asJson = (data) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

window.fetch = async (url, opts) => {
  const href = String(url);
  if (href === '/api/dashboard') return asJson(buildDashboard(JSON.parse(opts?.body || '{}')));
  if (href.startsWith('/api/technical')) {
    return asJson(buildTechnical(new URLSearchParams(href.split('?')[1] || '')));
  }
  if (href.startsWith('/api/search')) {
    const q = new URLSearchParams(href.split('?')[1] || '').get('q') || '';
    return asJson({ query: q, results: Universe.search(STOCKS, q), degraded: true });
  }
  return passthrough(url, opts);
};
`;

// ── 組裝 HTML
let html = read('public/index.html');

// 外部 CSS 連結換成內嵌樣式
html = html.replace(
  /    <!-- 樣式與圖示都自帶[\s\S]*?<link rel="stylesheet" href="\/tailwind\.css">/,
  `    <style>\n${read('public/tailwind.css')}\n    </style>`,
);

// app.js 前面插入引擎與 fetch 攔截
html = html.replace(
  '<script src="/app.js"></script>',
  `<script>\n(function () {\n${modules}\n${glue}\n})();\n</script>\n<script>\n${read('public/app.js')}\n</script>`,
);

// 展示版的標題與說明
html = html.replace('<title>台股脈動 — 個人化追蹤</title>', '<title>台股脈動 — 介面展示</title>');

mkdirSync(path.join(ROOT, 'demo'), { recursive: true });
writeFileSync(path.join(ROOT, 'demo/index.html'), html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`demo/index.html 已產生 · ${kb} KB · ${universe.stocks.length} 檔個股 · ${news.items.length} 則新聞`);
if (html.includes('/tailwind.css') || html.includes('src="/app.js"')) {
  console.error('✗ 仍有外部檔案參照，demo 不是自包含的');
  process.exit(1);
}
console.log('✓ 無任何外部檔案參照');
