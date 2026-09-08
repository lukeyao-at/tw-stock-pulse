/**
 * 盤中即時報價（證交所 MIS 端點）。
 *
 * 兩個實務上的關鍵：
 *  1. 一定要帶 Referer，否則會被擋。
 *  2. 成交價欄位 z 在「當下無成交」時是 "-"，此時要用最佳買賣價或昨收
 *     回推，不然開盤前整排都會顯示 0。
 */

import { MIS, TTL } from '../config.js';
import { fetchJson } from '../http.js';
import * as cache from '../cache.js';
import { num } from '../parse.js';

/** 把代號加上市場前綴。上櫃是 otc_、上市是 tse_。 */
function channelFor(code, market) {
  const prefix = market === '上櫃' ? 'otc' : 'tse';
  return `${prefix}_${code}.tw`;
}

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * 查一批個股的即時報價。
 * @param {Array<{code:string, market?:string}>} targets
 */
export async function realtime(targets) {
  const list = targets.filter((t) => t?.code);
  if (!list.length) return { quotes: [], failures: [] };

  const key = `mis:${list.map((t) => channelFor(t.code, t.market)).sort().join(',')}`;

  const result = await cache.through(key, TTL.quotes, async () => {
    const quotes = [];
    const failures = [];

    // 單次查太多檔會被截斷，所以分批；批次之間序列送出，避免被限流。
    for (const group of chunk(list, MIS.batchSize)) {
      const exCh = group.map((t) => channelFor(t.code, t.market)).join('|');
      const url = `${MIS.base}?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;

      try {
        const payload = await fetchJson(url, { headers: { Referer: MIS.referer } });
        for (const row of payload?.msgArray ?? []) {
          const prevClose = num(row.y);
          const bid = num(row.b?.split('_')[0]);
          const ask = num(row.a?.split('_')[0]);
          // 無成交時的合理替代價：最佳買賣中價 → 昨收
          const mid = bid !== null && ask !== null ? (bid + ask) / 2 : null;
          const price = num(row.z) ?? mid ?? bid ?? ask ?? prevClose;

          const change = price !== null && prevClose !== null ? +(price - prevClose).toFixed(2) : null;

          quotes.push({
            code: String(row.c || '').trim(),
            name: String(row.n || '').trim(),
            price,
            prevClose,
            open: num(row.o),
            high: num(row.h),
            low: num(row.l),
            volume: num(row.v),
            change,
            changePercent:
              change !== null && prevClose ? +((change / prevClose) * 100).toFixed(2) : null,
            // 有成交價才算即時，否則標記為推估，前端會加註
            estimated: num(row.z) === null,
            at: row.t || null,
          });
        }
      } catch (err) {
        failures.push(`${group.map((t) => t.code).join(',')} → ${err.message}`);
      }
    }

    return { quotes, failures };
  });

  return result.value;
}
