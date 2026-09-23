/**
 * 個股歷史日成交資料。
 *
 * 兩個用途：
 *  1. averageVolumes —— 算 20 日均量，讓「成交量放大倍數」的提醒有基準
 *     可比（證交所 STOCK_DAY，一檔一個請求，只對自選股抓，快取一整天）
 *  2. dailyBars —— 技術分析用的兩年日 K（Yahoo 為主、證交所／櫃買為備援）
 */

import { TTL, USER_AGENT, HISTORY } from '../config.js';
import { fetchJson } from '../http.js';
import * as cache from '../cache.js';
import { num, twDateToISO } from '../parse.js';

const TWSE_STOCK_DAY = 'https://www.twse.com.tw/exchangeReport/STOCK_DAY';

/** 均量基準的取樣天數 */
const AVG_WINDOW = 20;

const yyyymmdd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * 取單一個股的近月日成交量並算均量。
 * STOCK_DAY 回傳 { stat:'OK', data:[[日期, 成交股數, 成交金額, 開, 高, 低, 收, 漲跌, 筆數], ...] }
 */
async function avgVolumeFor(code) {
  const url = `${TWSE_STOCK_DAY}?response=json&date=${yyyymmdd(new Date())}&stockNo=${encodeURIComponent(code)}`;
  const payload = await fetchJson(url, { headers: { Referer: 'https://www.twse.com.tw/', 'User-Agent': USER_AGENT } });

  if (payload?.stat !== 'OK' || !Array.isArray(payload.data)) {
    throw new Error(`STOCK_DAY 回應異常：${payload?.stat || '無 stat 欄位'}`);
  }

  const volumes = payload.data
    .map((row) => num(row[1]))
    .filter((v) => typeof v === 'number' && v > 0)
    .slice(-AVG_WINDOW);

  if (!volumes.length) throw new Error('無有效成交量資料');

  return {
    avgVolume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
    days: volumes.length,
  };
}

/**
 * 批次取均量。單檔失敗只影響該檔（該檔的量能提醒會標為跳過）。
 * @param {string[]} codes
 * @returns {Promise<{avgVolumes:Map<string,number>, failures:string[]}>}
 */
export async function averageVolumes(codes) {
  const list = [...new Set(codes)].slice(0, 20); // 一檔一請求，設上限避免打爆來源
  if (!list.length) return { avgVolumes: new Map(), failures: [] };

  const avgVolumes = new Map();
  const failures = [];

  const settled = await Promise.allSettled(
    list.map(async (code) => {
      const result = await cache.through(`history:avgvol:${code}`, TTL.profile, () => avgVolumeFor(code));
      return { code, ...result.value };
    }),
  );

  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') avgVolumes.set(res.value.code, res.value.avgVolume);
    else failures.push(`${list[i]} → ${res.reason?.message || res.reason}`);
  });

  return { avgVolumes, failures };
}

// ── 技術分析用日 K ────────────────────────────────────

const fill = (template, values) =>
  Object.entries(values).reduce((url, [k, v]) => url.replace(`{${k}}`, encodeURIComponent(v)), template);

/** Yahoo 的 timestamp 是 UTC 秒數，台股收盤日要用台北時間取日期 */
const taipeiDate = (seconds) => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10);

/**
 * 解析 Yahoo chart 回應。
 *
 * 最新一根 K 線常常只有收盤是 null（收盤後也一樣，實測 2026-09-23），
 * 但 meta.regularMarketPrice 就是同一天的收盤價 —— 日期對得上才拿來補，
 * 否則整個分析會落後一天。其餘任何欄位缺值的 K 線一律捨棄，不要用 0 補，
 * 0 會讓 RSI 與通道全部失真。
 */
export function parseYahooChart(payload) {
  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) {
    throw new Error(payload?.chart?.error?.description || 'Yahoo 回應缺少 K 線資料');
  }
  const meta = result.meta ?? {};
  const metaDate = meta.regularMarketTime ? taipeiDate(meta.regularMarketTime) : null;
  const bars = [];
  result.timestamp.forEach((t, i) => {
    const bar = {
      date: taipeiDate(t),
      open: quote.open?.[i], high: quote.high?.[i], low: quote.low?.[i], close: quote.close?.[i],
      volume: quote.volume?.[i] ?? 0,
    };
    if (bar.close == null && bar.date === metaDate && typeof meta.regularMarketPrice === 'number') {
      bar.close = meta.regularMarketPrice;
      bar.high = Math.max(bar.high ?? -Infinity, meta.regularMarketDayHigh ?? -Infinity, bar.close);
      bar.low = Math.min(bar.low ?? Infinity, meta.regularMarketDayLow ?? Infinity, bar.close);
      bar.volume = bar.volume || meta.regularMarketVolume || 0;
    }
    if ([bar.open, bar.high, bar.low, bar.close].every((v) => typeof v === 'number' && v > 0)) {
      bars.push({ ...bar, open: +bar.open.toFixed(2), high: +bar.high.toFixed(2), low: +bar.low.toFixed(2), close: +bar.close.toFixed(2) });
    }
  });
  return { bars, name: result.meta?.shortName || result.meta?.longName || null };
}

/**
 * 解析證交所 STOCK_DAY／櫃買 tradingStock 的月資料列：
 * [日期(民國), 成交量, 成交金額, 開, 高, 低, 收, 漲跌, 筆數]
 * @param {number} volumeUnit 櫃買的成交量單位是「張」，要乘 1000 換成股
 */
export function parseMonthRows(rows, volumeUnit = 1) {
  const bars = [];
  for (const row of rows ?? []) {
    const date = twDateToISO(String(row[0]).replace(/\s|＊|\*/g, ''));
    const [open, high, low, close] = [row[3], row[4], row[5], row[6]].map(num);
    if (!date || ![open, high, low, close].every((v) => typeof v === 'number' && v > 0)) continue;
    bars.push({ date, open, high, low, close, volume: (num(row[1]) ?? 0) * volumeUnit });
  }
  return bars;
}

async function fromYahoo(code, market) {
  // 市場別不確定時兩個後綴都試：先試最可能的那個
  const suffixes = market === '上櫃' ? ['TWO', 'TW'] : ['TW', 'TWO'];
  let lastErr;
  for (const suffix of suffixes) {
    try {
      const payload = await fetchJson(fill(HISTORY.yahooChart, { symbol: `${code}.${suffix}` }), {
        headers: { 'User-Agent': HISTORY.yahooUserAgent },
      });
      const parsed = parseYahooChart(payload);
      if (parsed.bars.length) return { ...parsed, source: `Yahoo（${code}.${suffix}）` };
      lastErr = new Error(`${code}.${suffix} 沒有 K 線`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fromExchange(code, market) {
  const months = [];
  const now = new Date();
  for (let m = HISTORY.fallbackMonths - 1; m >= 0; m--) {
    months.push(new Date(now.getFullYear(), now.getMonth() - m, 1));
  }
  const otc = market === '上櫃';
  const bars = [];
  // 依序抓，避免同時十幾個請求觸發交易所限流
  for (const d of months) {
    const y = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    try {
      if (otc) {
        const payload = await fetchJson(fill(HISTORY.tpexMonth, { code, date: `${y}/${mm}/01` }));
        bars.push(...parseMonthRows(payload?.tables?.[0]?.data, 1000));
      } else {
        const payload = await fetchJson(fill(HISTORY.twseMonth, { code, date: `${y}${mm}01` }), {
          headers: { Referer: 'https://www.twse.com.tw/', 'User-Agent': USER_AGENT },
        });
        if (payload?.stat === 'OK') bars.push(...parseMonthRows(payload.data, 1));
      }
    } catch {
      // 單月失敗就少一個月，資料不夠時由技術分析那端明確回報根數不足
    }
  }
  if (!bars.length) throw new Error(`${otc ? '櫃買' : '證交所'}月成交資料全部抓取失敗`);
  return { bars, name: null, source: otc ? '櫃買中心' : '證交所' };
}

/**
 * 取單一個股約兩年的日 K（由舊到新）。
 * @returns {Promise<{bars, name, source, stale, failures:string[]}>}
 */
export async function dailyBars(code, market) {
  const failures = [];
  const result = await cache.through(`history:bars:${code}`, TTL.bars, async () => {
    try {
      return await fromYahoo(code, market);
    } catch (err) {
      failures.push(`Yahoo 日K → ${err.message}，改用交易所月資料`);
      return fromExchange(code, market);
    }
  });
  if (result.source === 'stale') failures.push(`日K 抓取失敗，使用 ${Math.round(result.ageMs / 60000)} 分鐘前的快取：${result.error}`);

  // 去重（備援來源跨月可能重疊）並排序
  const byDate = new Map(result.value.bars.map((b) => [b.date, b]));
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { ...result.value, bars, stale: result.stale, failures };
}
