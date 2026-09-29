/**
 * FinMind 開放資料（https://finmindtrade.com）。
 *
 * 免費註冊等級只能一檔一檔查，所以只對自選股用；全市場的東西（類股成交、
 * 法人買賣超）改從證交所抓（見 sector.js）。
 */

import { FINMIND, TTL } from '../config.js';
import { fetchJson } from '../http.js';
import * as cache from '../cache.js';
import * as disk from '../disk-cache.js';

async function query(dataset, params = {}) {
  const qs = new URLSearchParams({ dataset, ...params });
  const payload = await fetchJson(`${FINMIND.base}?${qs}`, {
    headers: FINMIND.token ? { Authorization: `Bearer ${FINMIND.token}` } : {},
    retries: 1,
  });
  if (payload?.status !== 200) throw new Error(`FinMind ${dataset}：${payload?.msg || '未知錯誤'}`);
  return payload.data ?? [];
}

/** 全部上市櫃股票的產業分類（一天抓一次，存磁碟） */
export async function stockInfo() {
  const today = new Date().toISOString().slice(0, 10);
  const { value } = await disk.through(`finmind-stockinfo-${today}`, async () => {
    const rows = await query('TaiwanStockInfo');
    // 同一檔可能出現多列（歷史改分類），留最新的
    const latest = new Map();
    for (const r of rows) {
      const prev = latest.get(r.stock_id);
      if (!prev || String(r.date) > String(prev.date)) latest.set(r.stock_id, r);
    }
    return [...latest.values()].map((r) => ({ code: r.stock_id, name: r.stock_name, industry: r.industry_category, market: r.type }));
  });
  return new Map(value.map((r) => [r.code, r]));
}

const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n, 1);
  return d.toISOString().slice(0, 10);
};

/**
 * 單檔月營收（近 26 個月，算年增率需要去年同期）。
 * FinMind 的 date 是「公布月」，revenue_year/revenue_month 才是營收所屬月份。
 */
export async function monthRevenue(code) {
  const { value } = await cache.through(`finmind:rev:${code}`, TTL.revenue, async () => {
    const rows = await query('TaiwanStockMonthRevenue', { data_id: code, start_date: monthsAgo(26) });
    return rows.map((r) => ({ year: r.revenue_year, month: r.revenue_month, revenue: r.revenue }));
  });
  return value;
}

/** 單檔三大法人買賣超（股），依日期彙整 */
export async function institutional(code, days = 10) {
  const { value } = await cache.through(`finmind:inst:${code}`, TTL.revenue / 4, async () => {
    const start = new Date(Date.now() - (days * 2 + 7) * 86400000).toISOString().slice(0, 10);
    const rows = await query('TaiwanStockInstitutionalInvestorsBuySell', { data_id: code, start_date: start });
    const byDate = new Map();
    for (const r of rows) {
      const d = byDate.get(r.date) ?? { date: r.date, foreign: 0, trust: 0, dealer: 0 };
      const net = (r.buy ?? 0) - (r.sell ?? 0);
      if (r.name.startsWith('Foreign')) d.foreign += net;
      else if (r.name === 'Investment_Trust') d.trust += net;
      else if (r.name.startsWith('Dealer')) d.dealer += net;
      byDate.set(r.date, d);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
  });
  return value;
}
