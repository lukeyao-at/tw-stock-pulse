#!/usr/bin/env node
/**
 * 來源健康度診斷。
 *
 * 公開端點會改版、會限流、會搬家。這支腳本逐一實際打過去，
 * 印出每個來源的狀態、資料筆數與實際欄位名稱，讓你能一眼看出
 * 「哪個掛了」以及「欄位名稱是不是換了」，再回頭調整 src/config.js。
 *
 *   npm run check-sources
 */

import { TWSE, TPEX, MIS, NEWS_FEEDS, NEWS_SYMBOL_FEED, HTTP_TIMEOUT_MS } from '../src/config.js';
import { fetchJson, fetchText } from '../src/http.js';
import { parseFeed, pick, normalizeCode } from '../src/parse.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let ok = 0;
let failed = 0;

const shorten = (s, n = 88) => (s.length > n ? `${s.slice(0, n)}…` : s);

function pass(label, detail) {
  ok++;
  console.log(`${GREEN}✓${RESET} ${label}`);
  if (detail) console.log(`  ${DIM}${detail}${RESET}`);
}

function fail(label, error) {
  failed++;
  console.log(`${RED}✗${RESET} ${label}`);
  console.log(`  ${RED}${shorten(String(error))}${RESET}`);
}

/** 印出實際回傳的欄位名稱 —— 端點改版時最有用的線索 */
const fieldsOf = (row) => Object.keys(row || {}).join(', ');

async function checkJsonArray(label, url, { codeKeys } = {}) {
  try {
    const payload = await fetchJson(url);
    const rows = Array.isArray(payload) ? payload : payload?.data;

    if (!Array.isArray(rows)) {
      return fail(label, `回應不是陣列（頂層鍵：${fieldsOf(payload)}）`);
    }
    if (!rows.length) return fail(label, '回應是空陣列');

    let note = `${rows.length} 筆 · 欄位：${shorten(fieldsOf(rows[0]), 120)}`;

    if (codeKeys) {
      const sample = normalizeCode(pick(rows[0], codeKeys));
      note += sample
        ? ` · 代號範例：${sample}`
        : ` · ${YELLOW}⚠ 抓不到代號欄位，請檢查 src/parse.js 的候選名稱${RESET}`;
    }
    pass(label, note);
  } catch (err) {
    fail(label, err.message);
  }
}

async function checkFirstOk(label, urls, opts) {
  for (const [i, url] of urls.entries()) {
    const sub = `${label} [候選 ${i + 1}/${urls.length}]`;
    const before = failed;
    await checkJsonArray(sub, url, opts);
    if (failed === before) return; // 這個候選成功，不必再試
  }
  console.log(`  ${YELLOW}⚠ ${label} 的所有候選端點都失敗，該欄位在畫面上會顯示「—」${RESET}`);
}

async function checkMis() {
  const label = '盤中即時報價（MIS getStockInfo）';
  const url = `${MIS.base}?ex_ch=tse_2330.tw|otc_6488.tw&json=1&delay=0&_=${Date.now()}`;
  try {
    const payload = await fetchJson(url, { headers: { Referer: MIS.referer } });
    const rows = payload?.msgArray;
    if (!Array.isArray(rows) || !rows.length) {
      return fail(label, `msgArray 為空（rtcode=${payload?.rtcode ?? '無'}）—— 非交易時段可能正常`);
    }
    pass(label, `${rows.length} 筆 · ${rows.map((r) => `${r.c}=${r.z ?? '-'}`).join(' ')} · 欄位：${shorten(fieldsOf(rows[0]), 100)}`);
  } catch (err) {
    fail(label, err.message);
  }
}

async function checkFeed(label, url) {
  try {
    const xml = await fetchText(url, { headers: { Accept: 'application/rss+xml, application/xml, */*' } });
    const items = parseFeed(xml, { sourceName: label });
    if (!items.length) {
      return fail(label, `解析不到任何項目（回應前 80 字：${shorten(xml.replace(/\s+/g, ' '), 80)}）`);
    }
    pass(label, `${items.length} 則 · 最新：${shorten(items[0].title, 60)}`);
  } catch (err) {
    fail(label, err.message);
  }
}

// ── 主流程 ──────────────────────────────────────────

const TWSE_CODE_KEYS = ['Code', '公司代號', '證券代號'];
const TPEX_CODE_KEYS = ['SecuritiesCompanyCode', 'Code', '公司代號'];

console.log(`\n檢查台股資料來源（逾時 ${HTTP_TIMEOUT_MS}ms）\n`);

console.log('── 上市（證交所）');
await checkJsonArray('每日收盤行情 STOCK_DAY_ALL', TWSE.dailyAll, { codeKeys: TWSE_CODE_KEYS });
await checkJsonArray('本益比/殖利率/淨值比 BWIBBU_ALL', TWSE.valuation, { codeKeys: TWSE_CODE_KEYS });
await checkJsonArray('公司基本資料 t187ap03_L', TWSE.profile, { codeKeys: TWSE_CODE_KEYS });

console.log('\n── 上市事件（候選端點，允許部分失敗）');
for (const { kind, url } of TWSE.eventCandidates) {
  await checkJsonArray(`${kind}`, url, { codeKeys: TWSE_CODE_KEYS });
}

console.log('\n── 上櫃（櫃買中心）');
await checkJsonArray('上櫃行情 tpex_mainboard_quotes', TPEX.dailyAll, { codeKeys: TPEX_CODE_KEYS });
await checkFirstOk('上櫃估值', TPEX.valuationCandidates, { codeKeys: TPEX_CODE_KEYS });
await checkFirstOk('上櫃基本資料', TPEX.profileCandidates, { codeKeys: TPEX_CODE_KEYS });

console.log('\n── 盤中報價');
await checkMis();

console.log('\n── 歷史日成交（均量基準）');
await checkJsonArray(
  'STOCK_DAY 2330',
  `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${new Date().toISOString().slice(0, 10).replace(/-/g, '')}&stockNo=2330`,
);

console.log('\n── 新聞來源');
for (const feed of NEWS_FEEDS) await checkFeed(feed.name, feed.url);
await checkFeed('個股新聞樣板（2330）', NEWS_SYMBOL_FEED.replace('{code}', '2330'));

// ── 總結
const total = ok + failed;
console.log(`\n${'─'.repeat(52)}`);
console.log(`結果：${GREEN}${ok} 個可用${RESET} / ${failed ? RED : ''}${failed} 個失敗${RESET}（共 ${total}）`);

if (failed) {
  console.log(`
${YELLOW}怎麼處理失敗的來源：${RESET}
  · 行情類（STOCK_DAY_ALL / tpex_mainboard_quotes）失敗 → App 會退回內建樣本資料，
    請優先修好；到 https://openapi.twse.com.tw/ 查目前的端點代號。
  · 估值、基本資料、事件類失敗 → 該欄位顯示「—」，其他功能不受影響。
  · MIS 盤中報價在非交易時段本來就可能是空的，收盤後測到失敗不一定是壞了。
  · 新聞 RSS 失敗 → 直接在 src/config.js 的 NEWS_FEEDS 換掉網址即可。
`);
}

process.exit(failed && ok === 0 ? 1 : 0);
