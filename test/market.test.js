import { test } from 'node:test';
import assert from 'node:assert/strict';

import { marketSummary } from '../src/market.js';

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
