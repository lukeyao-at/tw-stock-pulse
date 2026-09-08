import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze, summarize } from '../src/sentiment.js';

test('基本的利多利空判讀', () => {
  assert.equal(analyze('台積電法說會優於預期 外資買超上調目標價').label, '利多');
  assert.equal(analyze('面板雙虎遭砍單 財測下修 法人賣超').label, '利空');
  assert.equal(analyze('台股今日收盤持平').label, '中性');
  assert.equal(analyze('').label, '中性');
  assert.equal(analyze(null).label, '中性');
});

test('重疊詞不重複計分', () => {
  // 迴歸測試：詞典同時有「財測下修」(-3) 與「下修」(-3)，
  // 不去重會變 -6，讓分數與信心度虛胖。
  const specific = analyze('財測下修');
  const generic = analyze('下修');
  assert.equal(specific.score, -3, '「財測下修」只能算一次');
  assert.equal(generic.score, -3);

  const both = analyze('除息填息');
  assert.equal(both.score, 2, '「除息填息」不該再加一次「填息」');
});

test('否定詞會翻轉極性', () => {
  assert.ok(analyze('市場不看好該檔後市').score < 0, '不看好 = 利空');
  assert.ok(analyze('公司不虧損').score > 0, '不虧損 = 利多');
  // 否定詞需緊鄰才生效
  assert.ok(analyze('看好').score > 0);
});

test('推測語氣要打折，且不可誤判', () => {
  const rumour = analyze('傳鴻海遭砍單');
  const fact = analyze('鴻海確認砍單');
  assert.ok(rumour.hedged, '「傳…」是推測');
  assert.equal(fact.hedged, false, '「確認…」不是推測');
  assert.ok(Math.abs(rumour.score) < Math.abs(fact.score), '推測的分數要比事實小');

  // 迴歸測試：單字 hedge 造成的兩個誤判
  assert.equal(analyze('市場對旺季不如預期產生疑慮').hedged, false,
    '「疑慮」是利空事實，不是推測語氣');
  assert.equal(analyze('先進封裝需求外溢至傳統封測').hedged, false,
    '「傳統」不是「傳聞」');

  assert.ok(analyze('第四季報價恐再降價').hedged, '「恐再…」是推測');
  assert.equal(analyze('市場恐慌性賣壓湧現').hedged, false, '「恐慌」是情緒詞，不是推測');
  assert.ok(analyze('填息有望').hedged);
});

test('信心度隨命中強度上升且封頂於 1', () => {
  assert.equal(analyze('台股持平').confidence, 0);
  assert.ok(analyze('漲停').confidence > 0);
  assert.equal(analyze('漲停 創新高 大漲 外資買超 營收創高 獲利創高').confidence, 1);
});

test('summarize 統計整批新聞的氛圍', () => {
  const items = [
    { title: '', sentiment: { label: '利多', score: 6 } },
    { title: '', sentiment: { label: '利多', score: 4 } },
    { title: '', sentiment: { label: '利空', score: -2 } },
  ];
  const s = summarize(items);
  assert.equal(s.counts.利多, 2);
  assert.equal(s.counts.利空, 1);
  assert.equal(s.mood, '偏多');

  assert.equal(summarize([]).mood, '中性');
  assert.equal(summarize([{ title: '', sentiment: { label: '利空', score: -8 } }]).mood, '偏空');
});
