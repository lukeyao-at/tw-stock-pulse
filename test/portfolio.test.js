import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate } from '../src/portfolio.js';

const byCode = new Map([
  ['2330', { code: '2330', name: '台積電', industry: '半導體業', market: '上市', close: 1000, changePercent: 1 }],
  ['2603', { code: '2603', name: '長榮', industry: '航運業', market: '上市', close: 200, changePercent: -2 }],
]);

test('獲利與虧損的計算', () => {
  const r = evaluate([{ code: '2330', shares: 1000, cost: 900 }], byCode, new Map(), { includeFees: false });
  const p = r.positions[0];
  assert.equal(p.costAmount, 900_000);
  assert.equal(p.marketValue, 1_000_000);
  assert.equal(p.profit, 100_000);
  assert.equal(p.profitPercent, 11.11);
});

test('費用會壓低損益', () => {
  const withFees = evaluate([{ code: '2330', shares: 1000, cost: 900 }], byCode, new Map(), { includeFees: true });
  const without = evaluate([{ code: '2330', shares: 1000, cost: 900 }], byCode, new Map(), { includeFees: false });

  assert.ok(withFees.positions[0].profit < without.positions[0].profit);
  assert.ok(withFees.positions[0].fees > 0);
  assert.match(withFees.feeNote, /證交稅/);
  assert.match(without.feeNote, /未計入/);
});

test('查無代號的持股不會產生 undefined 欄位', () => {
  // 迴歸測試：早期版本沒補齊欄位，畫面會直接顯示 undefined
  const r = evaluate([{ code: '9999', shares: 100, cost: 10 }], byCode);
  const p = r.positions[0];
  assert.equal(p.unknown, true);
  for (const key of ['price', 'marketValue', 'profit', 'profitPercent', 'industry']) {
    assert.equal(p[key], null, `${key} 應為 null 而非 undefined`);
  }
  assert.equal(r.summary.positionCount, 0, '查無資料的不計入持股檔數');
});

test('盤中報價優先於收盤價', () => {
  const quotes = new Map([['2330', { code: '2330', price: 1100, estimated: false }]]);
  const r = evaluate([{ code: '2330', shares: 1000, cost: 900 }], byCode, quotes, { includeFees: false });
  assert.equal(r.positions[0].price, 1100);
  assert.equal(r.positions[0].priceSource, '盤中');
});

test('無成交的盤中價標記為推估', () => {
  const quotes = new Map([['2330', { code: '2330', price: 1050, estimated: true }]]);
  const r = evaluate([{ code: '2330', shares: 1000, cost: 900 }], byCode, quotes);
  assert.equal(r.positions[0].priceSource, '盤中推估');
});

test('產業集中度計算', () => {
  const r = evaluate([
    { code: '2330', shares: 1000, cost: 900 },   // 100 萬，半導體
    { code: '2603', shares: 1000, cost: 200 },   // 20 萬，航運
  ], byCode, new Map(), { includeFees: false });

  assert.equal(r.concentration.length, 2);
  assert.equal(r.concentration[0].industry, '半導體業');
  assert.equal(r.concentration[0].percent, 83.3);
  assert.equal(r.topConcentration.industry, '半導體業');

  const total = r.concentration.reduce((a, c) => a + c.percent, 0);
  assert.ok(Math.abs(total - 100) < 0.2, '占比加總應接近 100%');
});

test('空持股不會爆掉', () => {
  const r = evaluate([], byCode);
  assert.deepEqual(r.positions, []);
  assert.equal(r.summary.totalValue, 0);
  assert.equal(r.summary.totalProfitPercent, null);
  assert.equal(r.topConcentration, null);
});

test('持股依市值排序', () => {
  const r = evaluate([
    { code: '2603', shares: 1000, cost: 200 },
    { code: '2330', shares: 1000, cost: 900 },
  ], byCode, new Map(), { includeFees: false });
  assert.equal(r.positions[0].code, '2330', '市值大的排前面');
});
