import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { recommend } from '../src/recommend.js';

const { stocks } = JSON.parse(
  readFileSync(new URL('../data/sample-universe.json', import.meta.url), 'utf8'),
);

test('排除已持有與已在自選的標的', () => {
  const r = recommend(stocks, {
    holdings: [{ code: '2330' }],
    watchlist: [{ code: '2317' }],
  });
  const codes = r.items.map((i) => i.code);
  assert.ok(!codes.includes('2330'), '已持有不該被推薦');
  assert.ok(!codes.includes('2317'), '已在自選不該被推薦');
});

test('風險偏好會改變因子權重與排序', () => {
  const conservative = recommend(stocks, { risk: 'conservative' });
  const aggressive = recommend(stocks, { risk: 'aggressive' });

  assert.ok(conservative.weights.dividend > aggressive.weights.dividend);
  assert.ok(aggressive.weights.momentum > conservative.weights.momentum);
  assert.notDeepEqual(
    conservative.items.map((i) => i.code),
    aggressive.items.map((i) => i.code),
    '不同風險偏好應產出不同清單',
  );
});

test('權重加總為 1，投資目標加碼後仍正規化', () => {
  for (const goals of [[], ['dividend'], ['dividend', 'growth', 'value']]) {
    const { weights } = recommend(stocks, { goals });
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `權重加總應為 1，實際 ${total}`);
  }
});

test('殖利率是倒 U 型，過高會扣分', () => {
  // 迴歸測試：原本 8% 以上一律滿分，導致景氣循環股的
  // 不可持續高息（11%+）在保守型清單裡排第一。
  const base = {
    code: '9001', name: '測試', market: '上市', industry: '測試業',
    close: 100, changePercent: 0, turnover: 1e9, peRatio: 10, pbRatio: 1,
  };
  const universe = [
    { ...base, code: '9001', dividendYield: 7 },
    { ...base, code: '9002', dividendYield: 12 },
  ];
  const r = recommend(universe, { risk: 'conservative', minTurnover: 0 });
  const score = (code) => r.items.find((i) => i.code === code).factors.dividend;

  assert.ok(score('9001') > score('9002'), '7% 的股利分數要高於 12%');
  const suspicious = r.items.find((i) => i.code === '9002');
  assert.ok(suspicious.cautions.some((c) => c.includes('異常偏高')), '過高殖利率要有警示');
});

test('缺漏的財務資料以中性計分而非零分', () => {
  const noData = {
    code: '9003', name: '無資料', market: '上櫃', industry: '生技醫療業',
    close: 50, changePercent: 0, turnover: 1e9,
    peRatio: null, dividendYield: null, pbRatio: null,
  };
  const r = recommend([noData], { minTurnover: 0 });
  const item = r.items[0];
  assert.ok(item.factors.dividend > 0, '無股利資料不該被當成 0 分懲罰');
  assert.ok(item.factors.value > 0, '無估值資料不該被當成 0 分懲罰');
  assert.ok(item.reasons.some((x) => x.includes('無股利資料')), '應說明資料缺漏');
});

test('未知產業別的標的不受產業上限限制', () => {
  // 迴歸測試：若把「不知道產業別」的標的全部歸進同一個「未分類」桶
  // 再套上限，等於宣稱這些互不相干的公司是同一產業——上市公司基本
  // 資料來源被擋、industry 全部是 null 時（真實發生過的情況），
  // 會把整份推薦清單砍到只剩 perIndustryCap 檔，要 8 檔卻只給 3 檔。
  const noIndustry = Array.from({ length: 10 }, (_, i) => ({
    code: `900${i}`, name: `測試${i}`, market: '上市', industry: null,
    close: 100 + i, changePercent: 0, turnover: 1e9,
    peRatio: 15, dividendYield: 3, pbRatio: 1,
  }));
  const r = recommend(noIndustry, { limit: 8, minTurnover: 0 });
  assert.equal(r.items.length, 8, '未知產業別不該被產業上限砍量');
});

test('推薦清單有產業上限，不會全是同一產業', () => {
  const r = recommend(stocks, { limit: 9 });
  const counts = new Map();
  for (const item of r.items) {
    counts.set(item.industry, (counts.get(item.industry) || 0) + 1);
  }
  const cap = Math.max(2, Math.ceil(9 / 3));
  for (const [industry, n] of counts) {
    assert.ok(n <= cap, `${industry} 有 ${n} 檔，超過上限 ${cap}`);
  }
});

test('持股未涵蓋的產業會得到分散度加分與理由', () => {
  const r = recommend(stocks, {
    holdings: [{ code: '2330' }, { code: '2454' }, { code: '2303' }], // 全是半導體
    limit: 6,
  });
  assert.ok(
    r.items.some((i) => i.reasons.some((x) => x.includes('未涵蓋此產業'))),
    '應出現分散度理由',
  );
});

test('輸出是確定性的', () => {
  const a = recommend(stocks, { risk: 'balanced', goals: ['value'] });
  const b = recommend(stocks, { risk: 'balanced', goals: ['value'] });
  assert.deepEqual(a.items, b.items);
});

test('成交量過低的標的被濾掉', () => {
  const thin = {
    code: '9004', name: '冷門股', market: '上櫃', industry: '其他',
    close: 20, changePercent: 5, turnover: 1e6, peRatio: 5, dividendYield: 8, pbRatio: 0.5,
  };
  assert.equal(recommend([thin], {}).items.length, 0, '預設門檻應濾掉');
  assert.equal(recommend([thin], { minTurnover: 0 }).items.length, 1, '門檻歸零後應出現');
});
