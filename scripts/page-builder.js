/**
 * 把前端組成單一自包含 HTML 檔 —— 不需要伺服器就能開。
 *
 * 重點是「同一份程式碼」：計分引擎、情緒判讀、新聞比對、技術分析全部
 * 從 src/ 直接取用，前端 public/app.js 也原封不動內嵌，只用一層 fetch 攔截
 * 把 /api/* 換成瀏覽器端的本地運算。所以畫面行為和 npm start 一致。
 *
 * 兩種用途，只差在資料：
 *  - 展示版（build-demo.js）：data/ 底下的樣本資料、模擬 K 線
 *  - 盤後快照（build-snapshot.js）：當天收盤後抓的真實資料，打包成一頁，
 *    發布到固定網址，任何裝置都能看
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

/** 拿掉 import 敘述（單檔，沒有模組系統） */
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
 * 必須逐一包起來，否則各模組的同名函式攤平後會撞名。
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

/** 日 K 壓成陣列列（[日期, 開, 高, 低, 收, 量]），27 檔兩年的資料從約 3MB 降到 1MB */
const packBars = (bars) => bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume]);

/** 打包時用不到的欄位拿掉，全市場兩千多檔，省下來的量很可觀 */
const slimStock = ({ transactions, ...s }) => s;

/**
 * @param {object} o
 * @param {'demo'|'snapshot'} o.mode
 * @param {Array} o.stocks 股票宇宙
 * @param {Array} o.news 新聞（未判讀的原始項目）
 * @param {Array|null} o.events 事件；null 時用以今天為基準的樣本事件
 * @param {Record<string, Array>|null} o.barsByCode 日 K；null 時用模擬 K 線
 * @param {object|null} o.radar 產業雷達的回應
 * @param {{asOf?:string, generatedAt?:string}} [o.meta] 快照的資料日期與產生時間
 * @param {(appJs:string)=>string} [o.transformAppJs] 調整內嵌的 app.js（展示版用來縮減預設自選股）
 * @param {string} [o.title]
 */
export function buildPage({ mode, stocks, news, events = null, barsByCode = null, radar = null, meta = {}, transformAppJs = (s) => s, title }) {
  const modules = [
    wrapModule('Sentiment', read('src/sentiment.js')),
    wrapModule('Match', read('src/match.js')),
    wrapModule('Recommend', read('src/recommend.js')),
    wrapModule('Alerts', read('src/alerts.js')),
    wrapModule('Technical', read('src/technical.js')),
    wrapModule('SampleBars', read('src/sample-bars.js')),
    extractSearch(),
  ].join('\n\n');

  const bars = barsByCode
    ? Object.fromEntries(Object.entries(barsByCode).map(([code, list]) => [code, packBars(list)]))
    : null;

  /**
   * 瀏覽器端的 dashboard 組裝，對應 src/api.js 的 dashboard()：後端要處理多個
   * 外部來源的容錯與快取，這裡資料已經備好，只保留組裝邏輯，計算全部交給
   * 上面那些真正的引擎。
   */
  const glue = `
const MODE = ${JSON.stringify(mode)};
const META = ${JSON.stringify(meta)};
const STOCKS = ${JSON.stringify(stocks.map(slimStock))};
const NEWS = ${JSON.stringify(news)};
const EVENTS = ${JSON.stringify(events)};
const BARS = ${JSON.stringify(bars)};
const RADAR_SNAPSHOT = ${JSON.stringify(radar)};
const BY_CODE = new Map(STOCKS.map((s) => [s.code, s]));
const ALL_NAMES = STOCKS.map((s) => s.name).filter(Boolean);

/** 樣本事件（展示版）：以今天為基準往後排，讓事件提醒也能實際觸發 */
function sampleEvents(watchlist) {
  const kinds = ['法說會', '除權息', '月營收'];
  return watchlist.slice(0, 6).map((s, i) => {
    const d = new Date();
    d.setDate(d.getDate() + (i % 5) + 1);
    return { code: s.code, name: s.name, kind: kinds[i % kinds.length], date: d.toISOString().slice(0, 10), detail: null };
  });
}

const snapshotNote = () => \`盤後快照：資料至 \${META.asOf}（\${new Date(META.generatedAt).toLocaleString('zh-TW', { hour12: false })} 產生，自選股依\${META.watchlistSource || '預設清單'} \${(META.watchlist || []).length} 檔），每個交易日 16:30 後自動更新\`;

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

  const decorated = NEWS.map((item) => ({
    ...item,
    sentiment: Sentiment.analyze(\`\${item.title} \${item.summary || ''}\`),
    matchedSymbols: Match.symbolsFor(item, watchlist, { allNames: ALL_NAMES }),
  }));
  const personalized = decorated.filter((n) => n.matchedSymbols.length > 0);
  const others = decorated.filter((n) => n.matchedSymbols.length === 0);

  const events = EVENTS ?? sampleEvents(watchlist);

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

  const recommendations = Recommend.recommend(STOCKS, {
    risk: body.risk, goals: body.goals, watchlist,
    excludeIndustries: body.excludeIndustries, limit: body.recommendLimit ?? 8,
  });

  const alerts = Alerts.evaluate(body.rules ?? [], {
    byCode: BY_CODE, quoteByCode: new Map(), news: personalized, events,
    now: new Date().toISOString(),
  });

  const watchCodes = new Set(watchlist.map((w) => w.code));
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events
    .filter((e) => watchCodes.has(e.code) && e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 20);

  return {
    updatedAt: MODE === 'snapshot' ? META.generatedAt : new Date().toISOString(),
    watchlist: watchRows,
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
    diagnostics: MODE === 'snapshot'
      ? {
          offline: false, degraded: false, universeFromCache: false,
          universeUpdatedAt: META.generatedAt,
          snapshot: { asOf: META.asOf, generatedAt: META.generatedAt, note: snapshotNote() },
          notes: [], sourceErrors: [],
        }
      : {
          offline: true, degraded: true, universeFromCache: false,
          universeUpdatedAt: new Date().toISOString(),
          notes: ['這是離線展示版：所有數字來自內建樣本資料，非真實行情'],
          sourceErrors: [],
        },
  };
}

/** 對應 src/api.js 的 technical()：快照用打包好的真實日 K，展示版用模擬產生器 */
function buildTechnical(params) {
  const code = String(params.get('code') || '').trim().toUpperCase();
  const stock = BY_CODE.get(code);
  const opts = {
    lookback: Number(params.get('lookback')) || 120,
    capital: Number(params.get('capital')) || undefined,
    riskPct: Number(params.get('riskPct')) || undefined,
  };
  const base = { code, name: stock?.name || code, market: stock?.market ?? null, industry: stock?.industry ?? null };

  if (BARS) {
    const rows = BARS[code];
    if (!rows) {
      return {
        ...base, ok: false,
        reason: stock
          ? \`\${stock.name}（\${code}）不在這次快照裡。快照只含自選股的日 K；把它加入自選後，下一次盤後更新（交易日 16:30 後）就會有資料。\`
          : \`查無代號 \${code}\`,
      };
    }
    const bars = rows.map(([date, open, high, low, close, volume]) => ({ date, open, high, low, close, volume }));
    return { ...base, source: \`Yahoo 日 K（\${snapshotNote()}）\`, sample: false, notes: [], ...Technical.report(bars, opts) };
  }

  if (!stock) return { ...base, ok: false, reason: \`展示版只有樣本裡的 \${STOCKS.length} 檔，查無 \${code}\` };
  const bars = SampleBars.sampleBars(code, { close: stock.close, volume: stock.volume });
  return {
    ...base, source: '模擬 K 線（展示版）', sample: true,
    notes: ['展示版：K 線為依樣本收盤價產生的模擬走勢，非真實行情'],
    ...Technical.report(bars, opts),
  };
}

/** 攔截 fetch，把 /api/* 導到本地運算；public/app.js 因此可以原封不動使用 */
const passthrough = window.fetch.bind(window);
const asJson = (data) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

window.fetch = async (url, opts) => {
  const href = String(url);
  if (href === '/api/dashboard') return asJson(buildDashboard(JSON.parse(opts?.body || '{}')));
  if (href === '/api/radar') {
    if (!RADAR_SNAPSHOT) return asJson({ ok: false, reason: '這一版沒有附產業雷達資料；請用 npm start 跑完整版本' });
    if (MODE === 'snapshot') return asJson(RADAR_SNAPSHOT);
    const asOf = RADAR_SNAPSHOT.rotation?.to || RADAR_SNAPSHOT.updatedAt?.slice(0, 10);
    return asJson({ ...RADAR_SNAPSHOT, notes: [\`展示版：這是 \${asOf} 的真實資料快照，不會更新\`, ...(RADAR_SNAPSHOT.notes || [])] });
  }
  if (href.startsWith('/api/technical')) {
    return asJson(buildTechnical(new URLSearchParams(href.split('?')[1] || '')));
  }
  if (href.startsWith('/api/search')) {
    const q = new URLSearchParams(href.split('?')[1] || '').get('q') || '';
    return asJson({ query: q, results: Universe.search(STOCKS, q), degraded: MODE !== 'snapshot' });
  }
  return passthrough(url, opts);
};
`;

  let html = read('public/index.html');

  // 外部 CSS 連結換成內嵌樣式
  html = html.replace(
    /    <!-- 樣式與圖示都自帶[\s\S]*?<link rel="stylesheet" href="\/tailwind\.css">/,
    `    <style>\n${read('public/tailwind.css')}\n    </style>`,
  );

  // app.js 前面插入引擎與 fetch 攔截。資料裡可能有 </script>（新聞標題），先跳脫
  const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
  html = html.replace(
    '<script src="/app.js"></script>',
    () => `<script>\n(function () {\n${safe(modules)}\n${safe(glue)}\n})();\n</script>\n<script>\n${safe(transformAppJs(read('public/app.js')))}\n</script>`,
  );

  // 多半在嵌入式預覽裡開（不允許下載檔案），拿掉「下載成檔案」，只留複製／貼上
  html = html.replace(/\s*<button id="export-download"[^>]*>[^<]*<\/button>/, '');
  if (html.includes('id="export-download"')) throw new Error('沒能拿掉 export-download 按鈕');

  if (title) html = html.replace('<title>台股脈動 — 個人化追蹤</title>', `<title>${title}</title>`);

  if (html.includes('/tailwind.css') || html.includes('src="/app.js"')) {
    throw new Error('仍有外部檔案參照，頁面不是自包含的');
  }
  return html;
}
