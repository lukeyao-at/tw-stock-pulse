import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, RULE_TYPES } from '../src/alerts.js';

const byCode = new Map([
  ['2330', { code: '2330', name: '台積電', close: 1085, changePercent: 1.4, volume: 38_000_000 }],
  ['2603', { code: '2603', name: '長榮', close: 215, changePercent: -2.93, volume: 40_000_000, avgVolume: 20_000_000 }],
]);

const NOW = '2026-09-08T00:00:00Z';
const run = (rules, extra = {}) => evaluate(rules, { byCode, now: NOW, ...extra });

test('價格門檻', () => {
  const above = run([{ id: 'a', code: '2330', type: 'price_above', value: 1000 }]);
  assert.equal(above.triggered.length, 1);
  assert.match(above.triggered[0].message, /高於設定的 1000 元/);

  assert.equal(run([{ id: 'a', code: '2330', type: 'price_above', value: 2000 }]).triggered.length, 0);
  assert.equal(run([{ id: 'b', code: '2330', type: 'price_below', value: 1200 }]).triggered.length, 1);
});

test('漲跌幅門檻，跌幅用絕對值比較', () => {
  const down = run([{ id: 'c', code: '2603', type: 'pct_below', value: 2 }]);
  assert.equal(down.triggered.length, 1, '填 2 代表跌超過 2%');
  assert.equal(down.triggered[0].severity, 'warning');

  assert.equal(run([{ id: 'c', code: '2603', type: 'pct_below', value: -2 }]).triggered.length, 1,
    '填負數也該正確處理');
  assert.equal(run([{ id: 'd', code: '2603', type: 'pct_above', value: 1 }]).triggered.length, 0);
  assert.equal(run([{ id: 'e', code: '2330', type: 'pct_above', value: 1 }]).triggered.length, 1);
});

test('停用的規則不評估', () => {
  const r = run([{ id: 'f', code: '2330', type: 'price_above', value: 1, enabled: false }]);
  assert.equal(r.triggered.length, 0);
});

test('缺少均量基準時明確跳過，不編造結果', () => {
  // 迴歸測試：沒有均量就拿當日量跟自己比，會得出恆為 1 倍的假結果
  const r = run([{ id: 'g', code: '2330', type: 'volume_spike', value: 2 }]);
  assert.equal(r.triggered.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /缺少均量基準/);
});

test('有均量基準時量能提醒可觸發', () => {
  const r = run([{ id: 'h', code: '2603', type: 'volume_spike', value: 1.5 }]);
  assert.equal(r.triggered.length, 1, '40M / 20M = 2 倍，超過 1.5');
  assert.match(r.triggered[0].message, /2\.0 倍/);
});

test('新聞情緒提醒只看已比對到該檔的新聞', () => {
  const news = [
    { title: '台積電外資買超', sentiment: { label: '利多' }, matchedSymbols: [{ code: '2330' }] },
    { title: '長榮遭賣超', sentiment: { label: '利空' }, matchedSymbols: [{ code: '2603' }] },
  ];
  const bullish = run([{ id: 'i', code: '2330', type: 'news_bullish' }], { news });
  assert.equal(bullish.triggered.length, 1);
  assert.match(bullish.triggered[0].message, /台積電外資買超/);

  assert.equal(run([{ id: 'j', code: '2330', type: 'news_bearish' }], { news }).triggered.length, 0,
    '台積電沒有利空新聞');
  assert.equal(run([{ id: 'k', code: '2603', type: 'news_bearish' }], { news }).triggered.length, 1);
});

test('事件提醒在時間窗內觸發，且為中性色', () => {
  const events = [
    { code: '2330', kind: '法說會', date: '2026-09-12' },
    { code: '2330', kind: '除權息', date: '2026-11-01' },
  ];
  const r = run([{ id: 'l', code: '2330', type: 'event_upcoming', value: 10 }], { events });
  assert.equal(r.triggered.length, 1, '只有 4 天後的法說會在 10 天窗內');
  assert.match(r.triggered[0].message, /4 天後有法說會/);
  assert.equal(r.triggered[0].severity, 'neutral', '除權息/法說會不帶多空方向');

  assert.equal(run([{ id: 'm', code: '2330', type: 'event_upcoming', value: 2 }], { events }).triggered.length, 0);
});

test('已過去的事件不觸發', () => {
  const events = [{ code: '2330', kind: '法說會', date: '2026-09-01' }];
  assert.equal(run([{ id: 'n', code: '2330', type: 'event_upcoming', value: 30 }], { events }).triggered.length, 0);
});

test('取不到價格時跳過而非觸發', () => {
  const r = run([{ id: 'o', code: '9999', type: 'price_above', value: 1 }]);
  assert.equal(r.triggered.length, 0);
  assert.match(r.skipped[0].reason, /取不到價格/);
});

test('未知規則類型被記錄為跳過', () => {
  const r = run([{ id: 'p', code: '2330', type: 'not_a_rule' }]);
  assert.match(r.skipped[0].reason, /未知的規則類型/);
});

test('盤中報價優先於收盤價', () => {
  const quoteByCode = new Map([['2330', { code: '2330', name: '台積電', price: 900, changePercent: -5 }]]);
  const r = evaluate([{ id: 'q', code: '2330', type: 'price_below', value: 1000 }],
    { byCode, quoteByCode, now: NOW });
  assert.equal(r.triggered.length, 1, '應使用盤中價 900 而非收盤 1085');
});

test('RULE_TYPES 是完整的表單定義', () => {
  for (const [key, meta] of Object.entries(RULE_TYPES)) {
    assert.equal(typeof meta.label, 'string', `${key} 缺 label`);
    assert.equal(typeof meta.needsValue, 'boolean', `${key} 缺 needsValue`);
  }
});
