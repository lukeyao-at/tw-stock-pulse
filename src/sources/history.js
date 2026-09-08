/**
 * 個股歷史日成交資料（證交所 STOCK_DAY）。
 *
 * 用途是算 20 日均量，讓「成交量放大倍數」的提醒有基準可比；
 * 沒有它的話那條規則永遠只能跳過。
 *
 * 這支端點是一檔一個請求，所以只對自選股抓，且快取一整天。
 */

import { TTL, USER_AGENT } from '../config.js';
import { fetchJson } from '../http.js';
import * as cache from '../cache.js';
import { num } from '../parse.js';

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
