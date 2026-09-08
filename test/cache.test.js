import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cache from '../src/cache.js';

test('TTL 內回快取，過期回 null', async () => {
  cache.clear();
  cache.set('k', 'v', 10);
  assert.equal(cache.get('k').value, 'v');
  assert.equal(cache.get('k').stale, false);

  cache.set('short', 'v', 0.001);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cache.get('short'), null, '過期後不該回值');
  assert.equal(cache.get('short', { allowStale: true }).stale, true, '但陳舊資料仍可取用');
});

test('through 在重算失敗時退回陳舊資料', async () => {
  // 這是外部來源不穩時的關鍵行為：頁面退化成「資料稍舊」而不是整頁空白
  cache.clear();
  const first = await cache.through('key', 0.001, async () => 'good');
  assert.equal(first.value, 'good');
  assert.equal(first.source, 'live');

  await new Promise((r) => setTimeout(r, 20));

  const second = await cache.through('key', 0.001, async () => { throw new Error('來源掛了'); });
  assert.equal(second.value, 'good', '應回上一次成功的結果');
  assert.equal(second.source, 'stale');
  assert.equal(second.error, '來源掛了');
});

test('through 沒有任何快取時把錯誤丟出來', async () => {
  cache.clear();
  await assert.rejects(
    () => cache.through('missing', 10, async () => { throw new Error('第一次就失敗'); }),
    /第一次就失敗/,
  );
});

test('through 命中未過期快取時不呼叫 producer', async () => {
  cache.clear();
  let calls = 0;
  const producer = async () => { calls++; return calls; };

  await cache.through('once', 10, producer);
  const second = await cache.through('once', 10, producer);

  assert.equal(calls, 1);
  assert.equal(second.source, 'cache');
});

test('stats 回報每個鍵的年齡與是否過期', async () => {
  cache.clear();
  cache.set('a', 1, 10);
  const stats = cache.stats();
  assert.equal(stats.length, 1);
  assert.equal(stats[0].key, 'a');
  assert.equal(stats[0].stale, false);
});
