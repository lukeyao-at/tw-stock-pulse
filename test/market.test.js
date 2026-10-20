import { test } from 'node:test';
import assert from 'node:assert/strict';

import { marketSummary, sectorStocks } from '../src/market.js';

test('盤勢摘要：漲跌家數、成交值、產業依成交值加權', () => {
  const m = marketSummary([
    { industry: '半導體', changePercent: 2, turnover: 900 },
    { industry: '半導體', changePercent: -1, turnover: 100 },
    { industry: '航運', changePercent: -3, turnover: 1000 },
    { industry: '航運', changePercent: 0, turnover: 0 },
    { industry: '冷門', changePercent: 9, turnover: 1 },
    { industry: null, changePercent: 1, turnover: 50 },
    { changePercent: null },
  ]);
  assert.deepEqual([m.up, m.down, m.flat, m.total], [3, 2, 1, 6]);
  assert.equal(m.turnover, 2051);
  const semi = m.sectors.find((s) => s.name === '半導體');
  assert.equal(semi.changePercent, 1.7, '(2×900 − 1×100) ÷ 1000');
  assert.ok(!m.sectors.some((s) => s.name === '冷門'), '成交比重太低的產業不列入');
  assert.deepEqual(m.sectors.map((s) => s.name), ['半導體', '航運'], '由漲到跌排序');
});

test('產業成分股：依成交值排序，只列該產業', () => {
  const r = sectorStocks([
    { code: 'A', name: '甲', industry: '半導體業', changePercent: 1, turnover: 10 },
    { code: 'B', name: '乙', industry: '半導體業', changePercent: -2, turnover: 90 },
    { code: 'C', name: '丙', industry: '航運業', changePercent: 3, turnover: 50 },
    { code: 'D', name: '丁', industry: '半導體業', changePercent: null, turnover: 99 },
  ], '半導體業');
  assert.equal(r.count, 2);
  assert.deepEqual(r.stocks.map((s) => s.code), ['B', 'A']);
});
