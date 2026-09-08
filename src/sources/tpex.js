/**
 * 上櫃（證券櫃檯買賣中心）公開資料。
 *
 * 櫃買的 OpenAPI 欄位名稱改版比證交所更頻繁（Code / SecuritiesCompanyCode
 * 都出現過），所以估值與基本資料都用候選 URL + 候選欄位雙重容錯。
 */

import { TPEX, TTL } from '../config.js';
import { fetchJson } from '../http.js';
import * as cache from '../cache.js';
import { pick, num, normalizeCode } from '../parse.js';

const CODE_KEYS = ['SecuritiesCompanyCode', 'Code', 'CompanyCode', '公司代號', '股票代號', '證券代號'];
const NAME_KEYS = ['CompanyName', 'Name', '公司名稱', '公司簡稱', '股票名稱', '證券名稱'];

const asArray = (payload) => (Array.isArray(payload) ? payload : payload?.data ?? []);

/** 依序嘗試候選 URL，回第一個成功的；全失敗才丟錯。 */
async function firstOk(urls) {
  const errors = [];
  for (const url of urls) {
    try {
      const rows = asArray(await fetchJson(url));
      if (rows.length) return rows;
      errors.push(`${url} → 回應為空陣列`);
    } catch (err) {
      errors.push(`${url} → ${err.message}`);
    }
  }
  throw new Error(`所有候選端點皆失敗：${errors.join('；')}`);
}

/** 上櫃行情 */
export async function dailyQuotes() {
  return cache.through('tpex:daily', TTL.daily, async () => {
    const rows = asArray(await fetchJson(TPEX.dailyAll));
    const out = [];
    for (const row of rows) {
      const code = normalizeCode(pick(row, CODE_KEYS));
      if (!code) continue;

      const close = num(pick(row, ['Close', 'ClosingPrice', '收盤價', '收盤']));
      const change = num(pick(row, ['Change', '漲跌', '漲跌價差']));
      const prevClose = close !== null && change !== null ? close - change : null;

      out.push({
        code,
        name: String(pick(row, NAME_KEYS) || '').trim(),
        market: '上櫃',
        open: num(pick(row, ['Open', 'OpeningPrice', '開盤價'])),
        high: num(pick(row, ['High', 'HighestPrice', '最高價'])),
        low: num(pick(row, ['Low', 'LowestPrice', '最低價'])),
        close,
        change,
        changePercent: prevClose && prevClose !== 0 ? +((change / prevClose) * 100).toFixed(2) : null,
        // 櫃買的成交量單位是「股」，欄名用過 TradingShares 與 成交股數
        volume: num(pick(row, ['TradingShares', 'TradeVolume', '成交股數'])),
        turnover: num(pick(row, ['TransactionAmount', 'TradeValue', '成交金額'])),
        transactions: num(pick(row, ['TransactionNumber', 'Transaction', '成交筆數'])),
      });
    }
    return out;
  });
}

/** 上櫃估值（本益比 / 殖利率 / 股價淨值比） */
export async function valuations() {
  return cache.through('tpex:valuation', TTL.valuation, async () => {
    const rows = await firstOk(TPEX.valuationCandidates);
    const out = new Map();
    for (const row of rows) {
      const code = normalizeCode(pick(row, CODE_KEYS));
      if (!code) continue;
      out.set(code, {
        peRatio: num(pick(row, ['PriceEarningRatio', 'PEratio', 'PERatio', '本益比'])),
        dividendYield: num(pick(row, ['DividendYield', 'YieldRatio', '殖利率'])),
        pbRatio: num(pick(row, ['PriceBookRatio', 'PBratio', 'PBRatio', '股價淨值比'])),
      });
    }
    return out;
  });
}

/** 上櫃公司基本資料（產業別） */
export async function profiles() {
  return cache.through('tpex:profile', TTL.profile, async () => {
    const rows = await firstOk(TPEX.profileCandidates);
    const out = new Map();
    for (const row of rows) {
      const code = normalizeCode(pick(row, CODE_KEYS));
      if (!code) continue;
      out.set(code, {
        industry: String(pick(row, ['產業別', 'IndustryName', 'Industry', 'SecuritiesIndustryCode']) || '').trim() || null,
        capital: num(pick(row, ['實收資本額', 'PaidInCapital'])),
      });
    }
    return out;
  });
}
