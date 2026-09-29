/**
 * 證交所全市場資料：類股成交金額、類股指數、三大法人買賣超。
 *
 * 證交所的 WAF 對密集請求很敏感，所以：
 *  - 交易日清單從 Yahoo 的加權指數 K 線取（不必逐日試探哪天有開盤）
 *  - 依序抓、每支之間停 RADAR.twseDelayMs
 *  - 過去交易日寫磁碟永久快取；只有當天的資料會重抓
 */

import { RADAR, HISTORY, USER_AGENT } from '../config.js';
import { fetchJson } from '../http.js';
import * as disk from '../disk-cache.js';
import { num, normalizeCode } from '../parse.js';
import { parseYahooChart } from './history.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compact = (iso) => iso.replace(/-/g, '');
const taipeiToday = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

/** 被 WAF 擋時回的是 HTML，fetchJson 會丟「不是合法 JSON」 */
const isBlocked = (err) => /不是合法 JSON/.test(err?.message || '');

/** 307 是證交所的暫時限流（幾秒到幾十秒後解除），等一下再試一次 */
const THROTTLE_WAIT_MS = 20000;

/** 被擋之後這段時間內不再送請求（繼續打只會讓封鎖更久），但磁碟快取照常可用 */
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;
let blockedUntil = 0;
const BLOCKED_MSG = '證交所暫時封鎖了密集請求（限流或安全性頁面），稍後再試；已抓到的日子都存在磁碟快取，下次會接著補';

let lastTwseCall = 0;
async function twse(url, { retried = false } = {}) {
  if (Date.now() < blockedUntil) throw new Error(BLOCKED_MSG);
  const wait = lastTwseCall + RADAR.twseDelayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastTwseCall = Date.now();
  try {
    return await fetchJson(url, { headers: { Referer: 'https://www.twse.com.tw/', 'User-Agent': USER_AGENT }, retries: 2 });
  } catch (err) {
    if (err?.status === 307 && !retried) {
      await sleep(THROTTLE_WAIT_MS);
      return twse(url, { retried: true });
    }
    if (isBlocked(err) || err?.status === 307) {
      blockedUntil = Date.now() + BLOCK_COOLDOWN_MS;
      throw new Error(BLOCKED_MSG);
    }
    throw err;
  }
}

/** 最近 n 個交易日（由舊到新），用加權指數的日 K 判斷 */
export async function tradingDays(n) {
  const url = HISTORY.yahooChart.replace('{symbol}', encodeURIComponent('^TWII')).replace('range=2y', 'range=3mo');
  const payload = await fetchJson(url, { headers: { 'User-Agent': HISTORY.yahooUserAgent } });
  return parseYahooChart(payload).bars.map((b) => b.date).slice(-n);
}

/** 當天的資料可能還沒定稿（盤中、或剛收盤未公布），給 30 分鐘 TTL；過去的日子永久 */
const ttlFor = (date) => (date >= taipeiToday() ? 1800 : undefined);

async function daily(kind, date, producer) {
  const { value } = await disk.through(`twse-${kind}-${date}`, producer, { ttlSeconds: ttlFor(date) });
  return value;
}

/** 類股成交金額：{ 類股名稱: 成交金額(元) } */
export function sectorTurnover(date) {
  return daily('bfiamu', date, async () => {
    const d = await twse(RADAR.sectorTurnover.replace('{date}', compact(date)));
    if (d?.stat !== 'OK' || !Array.isArray(d.data)) throw new Error(`${date} 類股成交：${d?.stat || '無資料'}`);
    return Object.fromEntries(d.data.map((row) => [String(row[0]).trim(), num(row[2])]));
  });
}

/** 類股指數收盤：{ 類股名稱: 收盤指數 } */
export function sectorIndex(date) {
  return daily('index', date, async () => {
    const d = await twse(RADAR.sectorIndex.replace('{date}', compact(date)));
    const tables = d?.tables ?? [];
    const out = {};
    for (const t of tables) {
      for (const row of t.data ?? []) {
        const name = String(row[0]).trim();
        if (/類指數$/.test(name)) out[name] = num(row[1]);
      }
    }
    if (!Object.keys(out).length) throw new Error(`${date} 類股指數：${d?.stat || '無資料'}`);
    return out;
  });
}

/**
 * 三大法人個股買賣超（股）。原始檔 2MB+，只留需要的四個欄位再存。
 * 欄位名稱用關鍵字找，避免證交所改欄位順序。
 */
export function institutional(date) {
  return daily('t86', date, async () => {
    const d = await twse(RADAR.institutional.replace('{date}', compact(date)));
    if (d?.stat !== 'OK' || !Array.isArray(d.data)) throw new Error(`${date} 三大法人：${d?.stat || '無資料'}`);
    const f = d.fields.map((x) => String(x));
    const col = (re) => f.findIndex((x) => re.test(x));
    const iCode = col(/證券代號/);
    const iForeign = col(/^外陸資買賣超股數/);
    const iTrust = col(/^投信買賣超股數/);
    const iDealer = col(/^自營商買賣超股數$/);
    return d.data.map((row) => ({
      code: normalizeCode(row[iCode]),
      foreign: num(row[iForeign]) ?? 0,
      trust: num(row[iTrust]) ?? 0,
      dealer: iDealer >= 0 ? num(row[iDealer]) ?? 0 : 0,
    })).filter((r) => r.code);
  });
}

/**
 * 批次抓多天。單日失敗（被擋、還沒公布）只少那一天；被擋之後 twse() 會
 * 直接拒絕送出請求，所以後面的日子只會用到磁碟快取，不會再打證交所。
 * 同樣原因的失敗合併成一則訊息。
 */
export async function collect(fetcher, dates) {
  const out = [];
  const byReason = new Map();
  for (const date of dates) {
    try {
      out.push({ date, value: await fetcher(date) });
    } catch (err) {
      byReason.set(err.message, [...(byReason.get(err.message) ?? []), date]);
    }
  }
  const failures = [...byReason].map(([reason, ds]) =>
    `${ds.length === 1 ? ds[0] : `${ds[0]} 等 ${ds.length} 天`} → ${reason}`);
  return { out, failures };
}
