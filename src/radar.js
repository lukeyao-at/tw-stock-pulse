/**
 * 產業雷達：資金輪動、法人流向、題材熱度、營收動能。
 *
 * 目的是「提早發現下一個族群」—— 股價大漲之前，通常會先看到：
 *  1. 成交比重開始上升（資金進場）
 *  2. 法人開始買超
 *  3. 相關題材的新聞變多（市場開始討論）
 *  4. 月營收年增率轉強（基本面跟上）
 * 四個都能量化，這個模組把它們算出來並交叉比對。全部是純函式，
 * 抓資料在 sources/sector.js、sources/finmind.js、sources/themes.js。
 *
 * 這是整理公開資訊的工具，不是投資建議；訊號提早出現不代表一定會發動。
 */

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n, d = 2) => (isNum(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * 產業名稱正規化：證交所叫「半導體類指數」、FinMind 叫「半導體業」，
 * 統一成「半導體」才能對得起來。
 */
export function sectorKey(name) {
  return String(name ?? '')
    .replace(/\s+/g, '')
    .replace(/類指數$|指數$/, '')
    .replace(/類$/, '')
    .replace(/工業$|業$/, '');
}

/** 不是產業的分類（ETF、存託憑證等），加總法人流向時排除，否則會蓋過真正的產業訊號 */
const NOT_INDUSTRY = /ETF|ETN|存託憑證|受益證券|指數投資證券/;

/** 成交金額統計裡的「母類別」，包含其他子類別，加總時要排除以免重複計算 */
const PARENT_SECTORS = new Set(['電子', '化學生技醫療']);

// ── 題材 ─────────────────────────────────────────────

/**
 * 追蹤的題材。query 是 Google 新聞搜尋字串；sectors 是題材主要落在哪些
 * 證交所類股，用來跟成交比重交叉比對。
 *
 * 想追新題材（例如下一波是什麼）直接在這裡加一行即可。
 */
export const THEMES = [
  { key: 'ai_server', label: 'AI 伺服器', query: 'AI伺服器 台股', sectors: ['電腦及週邊設備', '其他電子'] },
  { key: 'abf', label: 'ABF 載板', query: 'ABF載板', sectors: ['電子零組件'] },
  { key: 'pcb', label: 'PCB／銅箔基板', query: 'PCB OR 銅箔基板 OR CCL 台股', sectors: ['電子零組件'] },
  { key: 'memory', label: '記憶體／HBM', query: '記憶體 OR DRAM OR HBM 台股', sectors: ['半導體'] },
  { key: 'cowos', label: 'CoWoS／先進封裝', query: 'CoWoS OR 先進封裝', sectors: ['半導體'] },
  { key: 'cpo', label: 'CPO／矽光子', query: 'CPO OR 矽光子', sectors: ['光電', '通信網路'] },
  { key: 'optical', label: '光通訊', query: '光通訊 OR 光模組 台股', sectors: ['光電', '通信網路'] },
  { key: 'cooling', label: '液冷散熱', query: '液冷 OR 水冷 散熱 台股', sectors: ['其他電子', '電腦及週邊設備'] },
  { key: 'power', label: '重電／電力設備', query: '重電 OR 電網 台股', sectors: ['電機機械', '電器電纜'] },
  { key: 'robot', label: '機器人', query: '機器人 概念股', sectors: ['電機機械'] },
  { key: 'satellite', label: '低軌衛星', query: '低軌衛星 台股', sectors: ['通信網路'] },
];

/** 標題出現這些字就是「漲價／缺貨」訊號 —— 報價上漲是營收與毛利最直接的領先指標 */
const PRICE_HIKE = /漲價|調漲|報價(?:上揚|走高|續漲|上漲)|缺貨|供不應求|吃緊|短缺|喊漲/;

/**
 * 題材熱度：最近 7 天每天幾則，對比更早期間的每天幾則。
 *
 * Google 新聞一次最多回 100 則。熱門題材 30 天內超過 100 則時，最舊的
 * 那則不到 30 天前 —— 這時用「實際涵蓋的天數」算日均，比例才不會失真。
 *
 * @param {Array<{title:string, publishedAt:string}>} items
 * @param {Date} now
 */
export function themeHeat(items, now = new Date()) {
  const DAY = 86400000;
  const dated = items
    .map((i) => ({ ...i, ts: Date.parse(i.publishedAt) }))
    .filter((i) => isNum(i.ts) && i.ts <= now.getTime() + DAY)
    .sort((a, b) => b.ts - a.ts);

  const ageDays = (i) => (now.getTime() - i.ts) / DAY;
  const oldest = dated.length ? ageDays(dated[dated.length - 1]) : 0;
  const saturated = dated.length >= 100;
  const span = Math.min(30, saturated ? Math.max(oldest, 7.5) : 30);

  const recent = dated.filter((i) => ageDays(i) <= 7);
  const prior = dated.filter((i) => ageDays(i) > 7 && ageDays(i) <= span);
  const perDay7 = recent.length / 7;
  const perDayPrior = span > 7 ? prior.length / (span - 7) : null;
  // 前期幾乎沒新聞時不算比例（0 → 3 則會變成無限大），改用絕對數量判斷
  const ratio = perDayPrior && perDayPrior >= 0.2 ? perDay7 / perDayPrior : null;

  let trend = 'flat';
  if (ratio !== null) trend = ratio >= 1.5 ? 'heating' : ratio <= 0.6 ? 'cooling' : 'flat';
  else if (recent.length >= 5) trend = 'heating';

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((i) => {
      const k = i.title.replace(/\s*-\s*[^-]+$/, '').slice(0, 24);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    total: dated.length,
    count7: recent.length,
    perDay7: round(perDay7, 2),
    perDayPrior: round(perDayPrior, 2),
    ratio: round(ratio, 2),
    trend,
    saturated,
    spanDays: round(span, 1),
    headlines: dedupe(recent).slice(0, 5).map(({ title, link, publishedAt, source }) => ({ title, link, publishedAt, source })),
    priceHikes: dedupe(recent.filter((i) => PRICE_HIKE.test(i.title))).slice(0, 5)
      .map(({ title, link, publishedAt, source }) => ({ title, link, publishedAt, source })),
  };
}

// ── 資金輪動 ─────────────────────────────────────────

/**
 * 各類股成交比重的變化。
 * @param {Array<{date:string, rows:Record<string, number>}>} days 由舊到新，rows 是類股 → 成交金額
 * @param {{recent?:number}} opts recent 天的平均 vs 整段期間平均
 */
export function rotation(days, { recent = 5 } = {}) {
  const clean = days.filter((d) => d && d.rows && Object.keys(d.rows).length);
  if (!clean.length) return { days: 0, sectors: [], totals: [] };

  const shares = clean.map((d) => {
    const rows = Object.fromEntries(
      Object.entries(d.rows)
        .map(([k, v]) => [sectorKey(k), v])
        .filter(([k, v]) => !PARENT_SECTORS.has(k) && isNum(v)),
    );
    const total = Object.values(rows).reduce((a, b) => a + b, 0);
    return { date: d.date, total, share: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, total ? (v / total) * 100 : 0])) };
  });

  const names = [...new Set(shares.flatMap((s) => Object.keys(s.share)))];
  const r = Math.min(recent, shares.length);
  const sectors = names.map((name) => {
    const series = shares.map((s) => s.share[name] ?? 0);
    const shareAll = avg(series);
    const shareRecent = avg(series.slice(-r));
    const shareEarly = avg(series.slice(0, Math.max(1, series.length - r)));
    // 連續幾天高於整段平均：輪動剛開始時通常是「連續放大」而不是單日爆量
    let streak = 0;
    for (let i = series.length - 1; i >= 0 && series[i] > shareAll; i--) streak++;
    return {
      name,
      today: round(series[series.length - 1], 2),
      shareRecent: round(shareRecent, 2),
      shareEarly: round(shareEarly, 2),
      delta: round(shareRecent - shareEarly, 2),
      // 相對變化：小類股從 1% → 1.5% 的意義，比大類股 40% → 40.5% 大得多
      relChange: shareEarly > 0 ? round((shareRecent / shareEarly - 1) * 100, 1) : null,
      streak,
      series: series.map((v) => round(v, 2)),
    };
  }).sort((a, b) => b.shareRecent - a.shareRecent);

  return {
    days: shares.length,
    recent: r,
    from: shares[0].date,
    to: shares[shares.length - 1].date,
    totals: shares.map((s) => ({ date: s.date, total: s.total })),
    sectors,
  };
}

/**
 * 類股指數漲跌幅。
 * @param {Record<string, number>} latest 類股 → 收盤指數
 * @param {Record<string, Record<string, number>>} past { r5: {...}, r20: {...} }
 * @param {{only?: Set<string>}} opts 只保留這些類股
 */
export function sectorReturns(latest, past, { only } = {}) {
  const out = {};
  for (const [rawName, close] of Object.entries(latest ?? {})) {
    const name = sectorKey(rawName);
    // 類股指數表裡也有「未含金融電子」之類的其他指數家族，只留成交統計裡有的類股
    if (only && !only.has(name)) continue;
    out[name] = {};
    for (const [label, snapshot] of Object.entries(past ?? {})) {
      const base = Object.entries(snapshot ?? {}).find(([k]) => sectorKey(k) === name)?.[1];
      out[name][label] = isNum(base) && base > 0 ? round((close / base - 1) * 100, 2) : null;
    }
  }
  return out;
}

// ── 法人流向 ─────────────────────────────────────────

/**
 * 把個股的三大法人買賣超（股數）依產業加總成金額。
 *
 * 證交所 T86 只給股數，換算金額要乘上股價；歷史日的收盤價不在手上時用
 * 最新收盤近似 —— 看的是「方向與相對大小」，這個近似足夠。
 *
 * @param {Array<{code, foreign, trust, dealer}>} rows 單日個股買賣超（股）
 * @param {Map<string,string>} industryOf 代號 → 產業
 * @param {Map<string,number>} priceOf 代號 → 股價
 */
export function aggregateFlows(rows, industryOf, priceOf) {
  const out = {};
  for (const r of rows) {
    const industry = industryOf.get(r.code);
    const price = priceOf.get(r.code);
    if (!industry || NOT_INDUSTRY.test(industry) || !isNum(price)) continue;
    const key = sectorKey(industry);
    const bucket = (out[key] ??= { foreign: 0, trust: 0, dealer: 0 });
    bucket.foreign += (r.foreign ?? 0) * price;
    bucket.trust += (r.trust ?? 0) * price;
    bucket.dealer += (r.dealer ?? 0) * price;
  }
  return out;
}

/** 多日加總，並算出「外資與投信同步買超」的天數 */
export function combineFlows(daily) {
  const out = {};
  for (const { flows } of daily) {
    for (const [k, v] of Object.entries(flows)) {
      const b = (out[k] ??= { foreign: 0, trust: 0, dealer: 0, bothBuyDays: 0, days: 0 });
      b.foreign += v.foreign;
      b.trust += v.trust;
      b.dealer += v.dealer;
      b.days += 1;
      if (v.foreign > 0 && v.trust > 0) b.bothBuyDays += 1;
    }
  }
  return Object.entries(out)
    .map(([name, v]) => ({
      name,
      foreign: Math.round(v.foreign),
      trust: Math.round(v.trust),
      dealer: Math.round(v.dealer),
      total: Math.round(v.foreign + v.trust + v.dealer),
      bothBuyDays: v.bothBuyDays,
      days: v.days,
    }))
    .sort((a, b) => b.total - a.total);
}

// ── 營收動能 ─────────────────────────────────────────

/**
 * 月營收動能。台股月營收在每月 10 日前公布，是最即時的基本面數據。
 *
 * 看三件事：
 *  - 最新一月年增率（有沒有成長）
 *  - 近 3 月平均年增率 vs 前 3 月（成長在加速還是減速 —— 股價常跟著「加速度」走）
 *  - 累計年增率（整年的底氣）
 *
 * @param {Array<{year:number, month:number, revenue:number}>} rows
 */
export function revenueMetrics(rows) {
  const by = new Map(rows.filter((r) => isNum(r.revenue)).map((r) => [`${r.year}-${r.month}`, r.revenue]));
  const keys = rows.filter((r) => isNum(r.revenue)).map((r) => ({ y: r.year, m: r.month }))
    .sort((a, b) => a.y - b.y || a.m - b.m);
  if (!keys.length) return null;

  const get = (y, m) => by.get(`${y}-${m}`);
  const yoyOf = ({ y, m }) => {
    const cur = get(y, m);
    const prev = get(y - 1, m);
    return isNum(cur) && isNum(prev) && prev > 0 ? (cur / prev - 1) * 100 : null;
  };
  const back = ({ y, m }, n) => {
    let mm = m - n;
    let yy = y;
    while (mm <= 0) { mm += 12; yy -= 1; }
    return { y: yy, m: mm };
  };

  const latest = keys[keys.length - 1];
  const cur = get(latest.y, latest.m);
  const prevMonth = get(back(latest, 1).y, back(latest, 1).m);
  const yoy3 = [0, 1, 2].map((n) => yoyOf(back(latest, n))).filter(isNum);
  const yoyPrev3 = [3, 4, 5].map((n) => yoyOf(back(latest, n))).filter(isNum);

  const ytd = keys.filter((k) => k.y === latest.y).reduce((a, k) => a + get(k.y, k.m), 0);
  const ytdPrevKeys = keys.filter((k) => k.y === latest.y - 1 && k.m <= latest.m);
  const ytdPrev = ytdPrevKeys.reduce((a, k) => a + get(k.y, k.m), 0);

  const avg3 = yoy3.length === 3 ? avg(yoy3) : null;
  const avgPrev3 = yoyPrev3.length === 3 ? avg(yoyPrev3) : null;
  let momentum = null;
  if (avg3 !== null && avgPrev3 !== null) {
    const diff = avg3 - avgPrev3;
    momentum = diff > 10 ? 'accelerating' : diff < -10 ? 'decelerating' : 'steady';
  }

  // 近 12 個月是否創新高：營收創高常是股價創高的前兆
  const last12 = [...Array(12).keys()].map((n) => get(back(latest, n).y, back(latest, n).m)).filter(isNum);
  const record = last12.length === 12 && cur >= Math.max(...last12);

  return {
    month: `${latest.y}-${String(latest.m).padStart(2, '0')}`,
    revenue: cur,
    yoy: round(yoyOf(latest), 1),
    mom: isNum(prevMonth) && prevMonth > 0 ? round((cur / prevMonth - 1) * 100, 1) : null,
    yoy3: round(avg3, 1),
    yoyPrev3: round(avgPrev3, 1),
    ytdYoy: ytdPrevKeys.length === keys.filter((k) => k.y === latest.y).length && ytdPrev > 0
      ? round((ytd / ytdPrev - 1) * 100, 1) : null,
    momentum,
    record12: record,
    series: [...Array(12).keys()].reverse().map((n) => {
      const k = back(latest, n);
      return { month: `${k.y}-${String(k.m).padStart(2, '0')}`, yoy: round(yoyOf(k), 1) };
    }),
  };
}

// ── 綜合：早期訊號 ───────────────────────────────────

/**
 * 把四種訊號對到同一個產業上。每種訊號各 1 分，愈多種同時出現愈值得注意。
 *
 * @returns {Array<{sector, score, reasons:string[], themes:string[]}>}
 */
export function earlySignals({ rotation: rot, flows = [], themes = [], returns = {} }) {
  const bySector = new Map();
  const touch = (name) => {
    if (!bySector.has(name)) bySector.set(name, { sector: name, score: 0, reasons: [], themes: [], kinds: new Set() });
    return bySector.get(name);
  };
  const addOnce = (name, kind, text) => {
    const s = touch(name);
    if (s.kinds.has(kind)) { s.reasons.push(text); return; }
    s.kinds.add(kind);
    s.score += 1;
    s.reasons.push(text);
  };

  for (const s of rot?.sectors ?? []) {
    // 比重至少 1% 才看，否則零星成交的小類股比例會亂跳
    if (s.shareRecent >= 1 && s.relChange !== null && s.relChange >= 15 && s.streak >= 2) {
      addOnce(s.name, 'turnover', `成交比重 ${s.shareEarly}% → ${s.shareRecent}%（+${s.relChange}%），已連續 ${s.streak} 天高於期間平均`);
    }
  }
  for (const f of flows) {
    if (f.total > 0 && f.bothBuyDays >= Math.ceil(f.days / 2)) {
      addOnce(f.name, 'flow', `近 ${f.days} 日法人合計買超 ${(f.total / 1e8).toFixed(1)} 億，外資與投信同步買超 ${f.bothBuyDays} 天`);
    }
  }
  for (const t of themes) {
    if (t.heat?.trend !== 'heating') continue;
    for (const sector of t.sectors) {
      const s = touch(sector);
      s.themes.push(t.label);
      addOnce(sector, 'theme', `「${t.label}」新聞熱度升溫（近 7 日 ${t.heat.count7} 則${t.heat.ratio ? `，日均為前期的 ${t.heat.ratio} 倍` : ''}）`);
    }
  }
  for (const [name, r] of Object.entries(returns)) {
    if (isNum(r.r5) && isNum(r.r20) && r.r5 > 0 && r.r5 > r.r20 / 2 && r.r20 > 0 && bySector.has(name)) {
      addOnce(name, 'price', `類股指數近 5 日 +${r.r5}%、近 20 日 +${r.r20}%，價格開始反映`);
    }
  }

  return [...bySector.values()]
    .filter((s) => s.score > 0)
    .map(({ kinds, ...s }) => ({ ...s, themes: [...new Set(s.themes)], kinds: [...kinds] }))
    .sort((a, b) => b.score - a.score || b.reasons.length - a.reasons.length);
}
