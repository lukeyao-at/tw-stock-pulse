import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sectorKey, rotation, sectorReturns, aggregateFlows, combineFlows, revenueMetrics, themeHeat, earlySignals,
} from '../src/radar.js';
import { splitSource } from '../src/sources/themes.js';

test('產業名稱正規化：證交所與 FinMind 的寫法對得起來', () => {
  assert.equal(sectorKey('半導體類指數        '), '半導體');
  assert.equal(sectorKey('半導體業'), '半導體');
  assert.equal(sectorKey('塑膠工業'), '塑膠');
  assert.equal(sectorKey('電腦及週邊設備業'), sectorKey('電腦及週邊設備類指數'));
  assert.equal(sectorKey('光電業'), '光電');
});

/** 造 n 天資料：A 類股從 10% 漸增，B 類股固定 */
function days(n, grow) {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, '0')}`,
    rows: { 'A類指數': 100 + (i >= n - 5 ? grow : 0), 'B類指數': 900, '電子類指數': 999999 },
  }));
}

test('資金輪動：近 5 日比重上升被抓到，母類別（電子）不重複計算', () => {
  const r = rotation(days(20, 100));
  const a = r.sectors.find((s) => s.name === 'A');
  assert.ok(!r.sectors.some((s) => s.name === '電子'), '電子是母類別，應排除');
  assert.equal(a.shareEarly, 10);             // 100 / (100 + 900)
  assert.ok(near(a.shareRecent, 200 / 11, 0.01)); // 200 / 1100
  assert.ok(a.relChange > 80);
  assert.equal(a.streak, 5);
  assert.equal(r.days, 20);
});

test('資金輪動：沒有資料時回傳空結果而不是丟錯', () => {
  assert.deepEqual(rotation([]).sectors, []);
  assert.equal(rotation([{ date: 'x', rows: {} }]).days, 0);
});

test('類股漲跌幅，並可限定只看成交統計裡有的類股', () => {
  const r = sectorReturns(
    { '半導體類指數': 110, '水泥窯製類指數': 50 },
    { r5: { '半導體類指數': 100 }, r20: { '半導體類指數': 88 } },
    { only: new Set(['半導體']) },
  );
  assert.deepEqual(Object.keys(r), ['半導體']);
  assert.equal(r['半導體'].r5, 10);
  assert.equal(r['半導體'].r20, 25);
});

test('法人流向：股數 × 股價加總到產業，ETF 與查不到產業的排除', () => {
  const rows = [
    { code: '2330', foreign: 1000, trust: 10, dealer: 0 },
    { code: '2303', foreign: -500, trust: 0, dealer: 0 },
    { code: '0050', foreign: 99999, trust: 0, dealer: 0 },
    { code: '9999', foreign: 1, trust: 0, dealer: 0 },
  ];
  const industryOf = new Map([['2330', '半導體業'], ['2303', '半導體業'], ['0050', 'ETF']]);
  const priceOf = new Map([['2330', 100], ['2303', 50], ['0050', 10], ['9999', 1]]);
  const f = aggregateFlows(rows, industryOf, priceOf);
  assert.deepEqual(Object.keys(f), ['半導體']);
  assert.equal(f['半導體'].foreign, 1000 * 100 - 500 * 50);
  assert.equal(f['半導體'].trust, 1000);
});

test('多日合計：算出外資與投信同步買超的天數', () => {
  const out = combineFlows([
    { flows: { 半導體: { foreign: 10, trust: 5, dealer: 0 } } },
    { flows: { 半導體: { foreign: 10, trust: -1, dealer: 0 } } },
    { flows: { 半導體: { foreign: 5, trust: 5, dealer: 1 } } },
  ]);
  assert.equal(out[0].total, 35); // 外資 25 + 投信 9 + 自營 1
  assert.equal(out[0].bothBuyDays, 2);
  assert.equal(out[0].days, 3);
});

/** 26 個月營收：去年每月 100，今年逐月成長 */
function revRows(growth) {
  const rows = [];
  for (let m = 7; m <= 12; m++) rows.push({ year: 2024, month: m, revenue: 90 });
  for (let m = 1; m <= 12; m++) rows.push({ year: 2025, month: m, revenue: 100 });
  for (let m = 1; m <= 8; m++) rows.push({ year: 2026, month: m, revenue: 100 * (1 + growth(m)) });
  return rows;
}

test('營收動能：年增率、月增率、累計年增率', () => {
  const r = revenueMetrics(revRows(() => 0.2));
  assert.equal(r.month, '2026-08');
  assert.equal(r.yoy, 20);
  assert.equal(r.mom, 0);
  assert.equal(r.ytdYoy, 20);
  assert.equal(r.series.length, 12);
  assert.equal(r.series[11].month, '2026-08');
});

test('營收動能：近 3 月年增率比前 3 月高 10 個百分點以上算加速', () => {
  const r = revenueMetrics(revRows((m) => (m >= 6 ? 0.5 : 0.1)));
  assert.equal(r.yoy3, 50);
  assert.equal(r.yoyPrev3, 10);
  assert.equal(r.momentum, 'accelerating');
  assert.equal(revenueMetrics(revRows((m) => (m >= 6 ? 0.05 : 0.4))).momentum, 'decelerating');
});

test('營收動能：跨年往回推月份正確（1 月的前一個月是去年 12 月）', () => {
  const rows = [
    { year: 2025, month: 1, revenue: 100 }, { year: 2025, month: 12, revenue: 200 },
    { year: 2026, month: 1, revenue: 150 },
  ];
  const r = revenueMetrics(rows);
  assert.equal(r.yoy, 50);
  assert.equal(r.mom, -25);
});

test('營收動能：沒資料回 null；少了去年同期不算年增率', () => {
  assert.equal(revenueMetrics([]), null);
  const r = revenueMetrics([{ year: 2026, month: 8, revenue: 100 }]);
  assert.equal(r.yoy, null);
  assert.equal(r.momentum, null);
});

const now = new Date('2026-09-30T00:00:00Z');
const ago = (days, title = 'x') => ({ title, publishedAt: new Date(now.getTime() - days * 86400000).toISOString() });

test('題材熱度：最近 7 天新聞密度明顯高於前期 → 升溫', () => {
  const items = [
    ...Array.from({ length: 21 }, (_, i) => ago(0.3 * i + 0.1, `熱門 ${i}`)),
    ...Array.from({ length: 10 }, (_, i) => ago(8 + i * 2, `舊聞 ${i}`)),
  ];
  const h = themeHeat(items, now);
  assert.equal(h.count7, 21);
  assert.equal(h.trend, 'heating');
  assert.ok(h.ratio > 2);
});

test('題材熱度：新聞量滿 100 則時，用實際涵蓋天數計算，不會誤判', () => {
  // 100 則平均分布在最近 10 天：日均一樣，不該被當成升溫
  const items = Array.from({ length: 100 }, (_, i) => ago(i / 10, `n${i}`));
  const h = themeHeat(items, now);
  assert.equal(h.saturated, true);
  assert.ok(h.spanDays < 11);
  assert.equal(h.trend, 'flat', `ratio ${h.ratio}`);
});

test('題材熱度：抓出漲價／缺貨標題，但「漲價」以外的一般標題不算', () => {
  const items = [ago(1, 'ABF載板供不應求 報價續漲'), ago(2, 'ABF載板廠法說會'), ago(3, '記憶體喊漲 DRAM 缺貨')];
  const h = themeHeat(items, now);
  assert.deepEqual(h.priceHikes.map((x) => x.title), ['ABF載板供不應求 報價續漲', '記憶體喊漲 DRAM 缺貨']);
});

test('Google 新聞標題拆出媒體名稱', () => {
  assert.deepEqual(splitSource('台光電營收創高 - 經濟日報'), { title: '台光電營收創高', source: '經濟日報' });
  assert.deepEqual(splitSource('沒有來源的標題'), { title: '沒有來源的標題', source: '' });
});

test('早期訊號：同一產業同時出現多種訊號時分數累加、排在前面', () => {
  const rot = { sectors: [
    { name: '光電', shareEarly: 7, shareRecent: 9, relChange: 28, streak: 4 },
    { name: '水泥', shareEarly: 0.2, shareRecent: 0.5, relChange: 150, streak: 5 }, // 比重太小不算
  ] };
  const flows = [{ name: '光電', total: 5e9, bothBuyDays: 3, days: 5 }];
  const themes = [{ label: 'CPO／矽光子', sectors: ['光電'], heat: { trend: 'heating', count7: 30, ratio: 2 } }];
  const s = earlySignals({ rotation: rot, flows, themes, returns: { 光電: { r5: 3, r20: 4 } } });
  assert.equal(s[0].sector, '光電');
  assert.equal(s[0].score, 4);
  assert.deepEqual(s[0].kinds.sort(), ['flow', 'price', 'theme', 'turnover']);
  assert.ok(!s.some((x) => x.sector === '水泥'));
});

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

test('每日報告的清單（data/watchlist.json）與前端預設自選股一致', async () => {
  const { readFileSync } = await import('node:fs');
  const list = JSON.parse(readFileSync(new URL('../data/watchlist.json', import.meta.url), 'utf8'));
  const fromJson = [...list.holdings, ...Object.values(list.groups).flat()];
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const block = app.match(/const DEFAULT_WATCHLIST = \[([\s\S]*?)\];/)[1];
  const fromApp = [...block.matchAll(/'([0-9A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(fromApp, fromJson);
});
