/**
 * 股票宇宙：把上市與上櫃的行情、估值、產業別合併成單一份查詢表。
 *
 * 每個來源都用 Promise.allSettled 獨立處理 —— 例如櫃買估值端點改版掛掉，
 * 上市的資料仍然完整可用，前端只會少掉上櫃的本益比欄位。
 * 完全抓不到（離線 / 全部被擋）時退回 data/sample-universe.json，
 * 讓 UI 永遠有東西可以顯示，並在回應裡標記 degraded。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as twse from './sources/twse.js';
import * as tpex from './sources/tpex.js';
import * as cache from './cache.js';
import { TTL, OFFLINE } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE_PATH = path.join(HERE, '..', 'data', 'sample-universe.json');

async function loadSample() {
  const raw = await readFile(SAMPLE_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * 證交所與櫃買中心公司基本資料的「產業別」是兩碼代碼（例如 24 = 半導體業），
 * 兩個市場共用同一套。換成名稱，畫面與產業統計才看得懂；認不得的代碼原樣保留。
 */
const INDUSTRY_NAMES = {
  '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械',
  '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業',
  '12': '汽車工業', '14': '建材營造業', '15': '航運業', '16': '觀光餐旅', '17': '金融保險業',
  '18': '貿易百貨業', '19': '綜合', '20': '其他業', '21': '化學工業', '22': '生技醫療業',
  '23': '油電燃氣業', '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業', '27': '通信網路業',
  '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業', '32': '文化創意業',
  '33': '農業科技業', '34': '電子商務業', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒',
  '38': '居家生活', '80': '管理股票', '91': '存託憑證',
};

export const industryName = (raw) => {
  if (raw === null || raw === undefined || raw === '') return null;
  const key = String(raw).trim().padStart(2, '0');
  return INDUSTRY_NAMES[key] ?? String(raw).trim();
};

/** 把 valuations / profiles 的 Map 疊到行情列上 */
function enrich(quotes, valuationMaps, profileMaps) {
  return quotes.map((q) => {
    const valuation = valuationMaps.map((m) => m?.get(q.code)).find(Boolean) ?? {};
    const profile = profileMaps.map((m) => m?.get(q.code)).find(Boolean) ?? {};
    return {
      ...q,
      peRatio: valuation.peRatio ?? null,
      dividendYield: valuation.dividendYield ?? null,
      pbRatio: valuation.pbRatio ?? null,
      industry: industryName(profile.industry),
    };
  });
}

/**
 * @returns {Promise<{stocks:Array, byCode:Map, degraded:boolean, notes:string[], updatedAt:string}>}
 */
export async function load() {
  const result = await cache.through('universe', TTL.daily, async () => {
    const notes = [];

    if (OFFLINE) {
      const sample = await loadSample();
      notes.push('離線模式：使用 data/sample-universe.json 的樣本資料');
      return { stocks: sample.stocks, degraded: true, notes, updatedAt: sample.updatedAt };
    }

    const [twseQuotes, tpexQuotes, twseVal, tpexVal, twseProf, tpexProf] = await Promise.allSettled([
      twse.dailyQuotes(),
      tpex.dailyQuotes(),
      twse.valuations(),
      tpex.valuations(),
      twse.profiles(),
      tpex.profiles(),
    ]);

    const take = (settled, label) => {
      if (settled.status === 'fulfilled') {
        if (settled.value.stale) notes.push(`${label}：使用快取中的舊資料（來源暫時失效）`);
        return settled.value.value;
      }
      notes.push(`${label}：${settled.reason?.message || settled.reason}`);
      return null;
    };

    const quotes = [
      ...(take(twseQuotes, '上市行情') ?? []),
      ...(take(tpexQuotes, '上櫃行情') ?? []),
    ];

    // 行情全掛就沒有骨幹可用，退回樣本資料而不是回空頁面
    if (!quotes.length) {
      const sample = await loadSample();
      notes.push('上市與上櫃行情都抓不到，暫時使用內建樣本資料');
      return { stocks: sample.stocks, degraded: true, notes, updatedAt: sample.updatedAt };
    }

    const stocks = enrich(
      quotes,
      [take(twseVal, '上市估值'), take(tpexVal, '上櫃估值')],
      [take(twseProf, '上市基本資料'), take(tpexProf, '上櫃基本資料')],
    );

    return { stocks, degraded: notes.length > 0, notes, updatedAt: new Date().toISOString() };
  });

  // 快取裡可能還是舊版存的產業代碼，取出時一律換成名稱（已經是名稱的不受影響）
  const value = { ...result.value, stocks: result.value.stocks.map((s) => ({ ...s, industry: industryName(s.industry) })) };
  return {
    ...value,
    byCode: new Map(value.stocks.map((s) => [s.code, s])),
    fromCache: result.source !== 'live',
  };
}

/** 依代號或名稱搜尋，給前端的自選股輸入框用 */
export function search(stocks, query, limit = 12) {
  const q = String(query || '').trim();
  if (!q) return [];

  const lower = q.toLowerCase();
  const scored = [];

  for (const s of stocks) {
    let score = 0;
    if (s.code === q) score = 100;                              // 代號完全相符
    else if (s.code.startsWith(q)) score = 80;                  // 代號開頭相符
    else if (s.name === q) score = 90;                          // 名稱完全相符
    else if (s.name.startsWith(q)) score = 70;                  // 名稱開頭相符
    else if (s.name.includes(q)) score = 50;                    // 名稱包含
    else if (s.name.toLowerCase().includes(lower)) score = 40;  // 英文名稱
    if (score) scored.push({ stock: s, score });
  }

  return scored
    // 同分時成交值大的排前面 —— 使用者要找的多半是熱門股
    .sort((a, b) => b.score - a.score || (b.stock.turnover || 0) - (a.stock.turnover || 0))
    .slice(0, limit)
    .map((x) => x.stock);
}
