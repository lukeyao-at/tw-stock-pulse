/**
 * 上市（臺灣證券交易所）公開資料。
 *
 * openapi.twse.com.tw 一律回傳「物件陣列」且允許跨域，是最穩的一組來源。
 * 每個函式都獨立快取，任何一支掛掉不會影響其他分頁。
 */

import { TWSE, TTL } from '../config.js';
import { fetchJson, fetchText } from '../http.js';
import * as cache from '../cache.js';
import { pick, num, normalizeCode, twDateToISO, parseCsv, zipFieldsData } from '../parse.js';

const CODE_KEYS = ['Code', 'SecuritiesCompanyCode', '公司代號', '股票代號', '證券代號'];
const NAME_KEYS = ['Name', 'CompanyName', '公司名稱', '公司簡稱', '股票名稱', '證券名稱'];

const asArray = (payload) => {
  if (Array.isArray(payload)) return payload;
  // TWSE 舊格式：{ stat, fields:[...], data:[[...], ...] }（位置對應，非物件）
  const zipped = zipFieldsData(payload);
  if (zipped) return zipped;
  // 少數端點會包一層 { data: [...] } 或 { result: { data: [...] } }
  for (const path of [payload?.data, payload?.result?.data, payload?.aaData]) {
    if (Array.isArray(path)) return path;
  }
  return [];
};

/** 每日收盤行情（全部上市個股） */
export async function dailyQuotes() {
  return cache.through('twse:daily', TTL.daily, async () => {
    // response=open_data 回傳 CSV，不是 openapi 那種現成 JSON 陣列
    const rows = parseCsv(await fetchText(TWSE.dailyAll));
    const out = [];
    for (const row of rows) {
      const code = normalizeCode(pick(row, CODE_KEYS));
      if (!code) continue;

      const close = num(pick(row, ['ClosingPrice', '收盤價']));
      const change = num(pick(row, ['Change', '漲跌價差']));
      // 交易所的 Change 欄不帶正負號時，用「收盤 - 開盤」的方向補救不可靠，
      // 因此只有在拿得到明確數值時才算漲跌幅。
      const prevClose = close !== null && change !== null ? close - change : null;

      out.push({
        code,
        name: String(pick(row, NAME_KEYS) || '').trim(),
        market: '上市',
        open: num(pick(row, ['OpeningPrice', '開盤價'])),
        high: num(pick(row, ['HighestPrice', '最高價'])),
        low: num(pick(row, ['LowestPrice', '最低價'])),
        close,
        change,
        changePercent: prevClose && prevClose !== 0 ? +((change / prevClose) * 100).toFixed(2) : null,
        volume: num(pick(row, ['TradeVolume', '成交股數'])),
        turnover: num(pick(row, ['TradeValue', '成交金額'])),
        transactions: num(pick(row, ['Transaction', '成交筆數'])),
      });
    }
    return out;
  });
}

/** 個股本益比、殖利率、股價淨值比 */
export async function valuations() {
  return cache.through('twse:valuation', TTL.valuation, async () => {
    // response=open_data 回傳 CSV，不是 openapi 那種現成 JSON 陣列
    const rows = parseCsv(await fetchText(TWSE.valuation));
    const out = new Map();
    for (const row of rows) {
      const code = normalizeCode(pick(row, CODE_KEYS));
      if (!code) continue;
      out.set(code, {
        peRatio: num(pick(row, ['PEratio', 'PERatio', '本益比'])),
        dividendYield: num(pick(row, ['DividendYield', 'YieldRatio', '殖利率'])),
        pbRatio: num(pick(row, ['PBratio', 'PBRatio', '股價淨值比'])),
      });
    }
    return out;
  });
}

/** 上市公司基本資料 —— 我們只要產業別，用於推薦時的分散度計算 */
export async function profiles() {
  return cache.through('twse:profile', TTL.profile, async () => {
    const rows = asArray(await fetchJson(TWSE.profile));
    const out = new Map();
    for (const row of rows) {
      const code = normalizeCode(pick(row, CODE_KEYS));
      if (!code) continue;
      out.set(code, {
        industry: String(pick(row, ['產業別', 'IndustryName', 'Industry']) || '').trim() || null,
        chairman: String(pick(row, ['董事長', 'Chairman']) || '').trim() || null,
        capital: num(pick(row, ['實收資本額', 'PaidInCapital'])),
        listedOn: twDateToISO(pick(row, ['上市日期', 'ListingDate'])),
      });
    }
    return out;
  });
}

/**
 * 事件（除權息、法說會、月營收）。
 *
 * 這幾支端點的代號最容易改版，所以做成候選清單逐一嘗試：
 * 成功的收下、失敗的記在 failures 裡回給前端顯示，
 * 不讓單一端點失效變成整頁錯誤。
 */
export async function events() {
  return cache.through('twse:events', TTL.events, async () => {
    const collected = [];
    const failures = [];

    const settled = await Promise.allSettled(
      TWSE.eventCandidates.map(async ({ kind, url }) => ({
        kind,
        url,
        rows: asArray(await fetchJson(url)),
      })),
    );

    for (const result of settled) {
      if (result.status === 'rejected') {
        failures.push(String(result.reason?.message || result.reason));
        continue;
      }
      const { kind, rows } = result.value;
      for (const row of rows) {
        const code = normalizeCode(pick(row, CODE_KEYS));
        if (!code) continue;

        const date = twDateToISO(
          pick(row, ['除權除息日期', '除權息日期', '除息交易日', '開會日期', '法說會日期', '資料日期', 'Date', '出表日期']),
        );
        if (!date) continue;

        collected.push({
          code,
          name: String(pick(row, NAME_KEYS) || '').trim(),
          kind,
          date,
          detail: String(
            pick(row, ['權值+息值', '現金股利', '每股現金股利', '摘要', '事件內容', '說明']) || '',
          ).trim() || null,
        });
      }
    }

    return { events: collected, failures };
  });
}
