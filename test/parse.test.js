import { test } from 'node:test';
import assert from 'node:assert/strict';

import { num, pick, normalizeCode, twDateToISO, stripHtml, parseFeed } from '../src/parse.js';

test('num 處理交易所回傳的各種字串', () => {
  assert.equal(num('1,234.5'), 1234.5);
  assert.equal(num(42), 42);
  assert.equal(num('0'), 0, '0 是有效數值，不可被當成空值');
  assert.equal(num('X0.00'), 0, '除權息標記 X 要剝掉');
  assert.equal(num('－1.5'), -1.5, '全形負號要正規化');
  assert.equal(num('＋2.5'), 2.5, '全形正號要正規化');

  for (const empty of ['--', '-', '', '  ', 'N/A', '不適用', null, undefined]) {
    assert.equal(num(empty), null, `${JSON.stringify(empty)} 應為 null`);
  }
});

test('pick 能吃掉欄位名稱的改版差異', () => {
  assert.equal(pick({ Code: '2330' }, ['Code', '公司代號']), '2330');
  assert.equal(pick({ 公司代號: '2330' }, ['Code', '公司代號']), '2330');
  // 模糊比對：帶單位的欄名
  assert.equal(pick({ '殖利率(%)': '3.21' }, ['DividendYield', '殖利率']), '3.21');
  assert.equal(pick({ Other: 1 }, ['Code']), undefined);
  assert.equal(pick({ Code: '' }, ['Code']), undefined, '空字串視為沒有值');
});

test('normalizeCode 只接受合法台股代號', () => {
  assert.equal(normalizeCode(' 2330 '), '2330');
  assert.equal(normalizeCode('00878'), '00878', '五碼 ETF 也要接受');
  assert.equal(normalizeCode('2330A'), '2330A', '特別股結尾帶英文');
  assert.equal(normalizeCode('00400A'), '00400A',
    '迴歸測試：主動式 ETF 用五碼數字+一碼字母，實測發現漏接會讓 11% 的' +
    '上市證券（152/1379 檔，2026-09-15 資料）整批消失');
  assert.equal(normalizeCode('abc'), null);
  assert.equal(normalizeCode('123'), null);
  assert.equal(normalizeCode('1234567'), null, '過長的數字不該被接受');
});

test('twDateToISO 處理民國與西元', () => {
  assert.equal(twDateToISO('1140908'), '2025-09-08');
  assert.equal(twDateToISO('114/09/08'), '2025-09-08');
  assert.equal(twDateToISO('2026-09-08'), '2026-09-08');
  assert.equal(twDateToISO('20260908'), '2026-09-08');
  assert.equal(twDateToISO(''), null);
  assert.equal(twDateToISO('不是日期'), null);
});

test('stripHtml 要能剝掉被 escape 過的 HTML', () => {
  // 迴歸測試：RSS 的 description 幾乎都是 escape 過的 HTML，
  // 只剝一趟標籤會讓 <p> 原封不動留在摘要裡。
  assert.equal(stripHtml('&lt;p&gt;台積電&lt;/p&gt; 內文'), '台積電 內文');
  assert.equal(stripHtml('<p>直接的標籤</p>'), '直接的標籤');
  assert.equal(stripHtml('<![CDATA[包在 CDATA 裡]]>'), '包在 CDATA 裡');
  assert.equal(stripHtml('&amp;amp; 只解一層'), '&amp; 只解一層');
  assert.equal(stripHtml(''), '');
});

test('parseFeed 通吃 RSS 與 Atom', () => {
  const rss = parseFeed(`<rss><channel>
    <item><title>台積電<![CDATA[ 創新高]]></title><link>https://x.test/a</link>
    <pubDate>Mon, 08 Sep 2026 01:00:00 GMT</pubDate>
    <description>&lt;p&gt;摘要內容&lt;/p&gt;</description></item>
  </channel></rss>`, { sourceName: '測試來源' });

  assert.equal(rss.length, 1);
  assert.equal(rss[0].title, '台積電 創新高');
  assert.equal(rss[0].link, 'https://x.test/a');
  assert.equal(rss[0].summary, '摘要內容');
  assert.equal(rss[0].source, '測試來源');
  assert.equal(rss[0].publishedAt, '2026-09-08T01:00:00.000Z');

  const atom = parseFeed(`<feed><entry><title>標題</title>
    <link rel="alternate" href="https://y.test/b"/>
    <updated>2026-09-08T02:00:00Z</updated>
    <summary>摘要</summary></entry></feed>`);

  assert.equal(atom[0].link, 'https://y.test/b', 'Atom 的連結在 href 屬性上');
  assert.equal(atom[0].publishedAt, '2026-09-08T02:00:00.000Z');

  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<rss></rss>'), []);
});
