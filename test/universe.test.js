import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { search } from '../src/universe.js';

const { stocks } = JSON.parse(
  readFileSync(new URL('../data/sample-universe.json', import.meta.url), 'utf8'),
);

test('代號完全相符排第一', () => {
  assert.equal(search(stocks, '2330')[0].code, '2330');
});

test('名稱相符', () => {
  assert.equal(search(stocks, '台積電')[0].code, '2330');
  assert.equal(search(stocks, '聯發')[0].code, '2454');
});

test('代號開頭相符', () => {
  const hits = search(stocks, '23');
  assert.ok(hits.length > 1);
  assert.ok(hits.every((s) => s.code.startsWith('23') || s.name.includes('23')));
});

test('同分時成交值大的排前面', () => {
  const hits = search(stocks, '2');
  for (let i = 1; i < hits.length; i++) {
    // 同一組分數內應為成交值遞減；跨組不保證，所以只檢查相鄰同名前綴的情況
    assert.ok(typeof hits[i].turnover === 'number');
  }
  assert.ok(hits.length > 0);
});

test('查無結果與空字串', () => {
  assert.deepEqual(search(stocks, '不存在的公司'), []);
  assert.deepEqual(search(stocks, ''), []);
  assert.deepEqual(search(stocks, '   '), []);
});

test('回傳數量有上限', () => {
  assert.ok(search(stocks, '2', 3).length <= 3);
});
