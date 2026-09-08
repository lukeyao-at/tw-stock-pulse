import { test } from 'node:test';
import assert from 'node:assert/strict';

import { symbolsFor } from '../src/match.js';

const watchlist = [
  { code: '2330', name: '台積電' },
  { code: '2002', name: '中鋼' },
  { code: '2026', name: '榮科' },
  { code: '2603', name: '長榮' },
];
// 整個市場的名稱，用來判斷短名稱是否其實屬於別家公司
const allNames = ['台積電', '中鋼', '中鋼構', '榮科', '長榮', '長榮航', '長榮鋼'];

const codesOf = (title) => symbolsFor({ title }, watchlist, { allNames }).map((m) => m.code);

test('個股新聞源的標記最優先', () => {
  const hits = symbolsFor({ title: '無關標題', symbols: ['2603'] }, watchlist, { allNames });
  assert.deepEqual(hits, [{ code: '2603', confidence: 'high', via: '個股新聞源' }]);
});

test('代號比對', () => {
  assert.deepEqual(codesOf('2330 外資買超'), ['2330']);
  assert.deepEqual(codesOf('榮科 2026 今日走勢'), ['2026']);
});

test('年份與數量不可被當成代號', () => {
  // 迴歸測試：只擋數字邊界不夠，「台股 2026 年展望」會誤判成榮科(2026)
  assert.deepEqual(codesOf('台股 2026 年展望 分析師看好'), []);
  assert.deepEqual(codesOf('台股攻上 2330 點'), []);
  assert.deepEqual(codesOf('股價漲到 2330 元'), []);
  assert.deepEqual(codesOf('營收 2330 萬'), []);
});

test('名稱比對，且不可被更長的公司名搶走', () => {
  // 迴歸測試：原本用「前後是否為中文字」判斷詞界，
  // 中文沒有空格，那條規則會把正常命中全部殺掉。
  assert.deepEqual(codesOf('中鋼盤後大單敲進'), ['2002'], '中鋼要命中');
  assert.deepEqual(codesOf('中鋼構今日漲停 工程訂單挹注'), [], '中鋼構是另一家公司');
  assert.deepEqual(codesOf('台積電法說會優於預期'), ['2330']);
});

test('同一段文字有多家同前綴公司時歸屬正確', () => {
  assert.deepEqual(codesOf('長榮航空與長榮海運雙漲'), ['2603'],
    '長榮海運要歸長榮(2603)');
  assert.deepEqual(codesOf('長榮航今日領漲'), [],
    '只提長榮航時不可算成長榮(2603)');
});

test('別名比對', () => {
  assert.deepEqual(codesOf('台積衝上千元'), ['2330'], '「台積」是台積電的別名');
  assert.deepEqual(codesOf('TSMC 法說會'), ['2330']);
});

test('一則新聞可對到多檔', () => {
  const hits = codesOf('台積電與中鋼同步走揚');
  assert.deepEqual(hits.sort(), ['2002', '2330']);
});

test('沒有 allNames 時仍可運作（誤判率較高）', () => {
  const hits = symbolsFor({ title: '中鋼盤後大單' }, watchlist).map((m) => m.code);
  assert.deepEqual(hits, ['2002']);
});
