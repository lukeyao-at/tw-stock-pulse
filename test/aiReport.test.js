import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/aiReport.js';
import { isConfigured, extractReportText, normalizeInteraction, startResearch, getResearch } from '../src/sources/gemini.js';

const stocks = [
  { code: '2330', name: '台積電', changePercent: 2.5, turnover: 3e10 },
  { code: '2317', name: '鴻海', changePercent: -1.2, turnover: 1e10 },
  { code: '9999', name: '無漲跌資料', changePercent: null, turnover: 0 },
];

test('buildPrompt 帶入漲跌家數與前幾名個股，並且不建議個股買賣', () => {
  const prompt = buildPrompt(stocks);
  assert.match(prompt, /上漲家數：1，下跌家數：1/);
  assert.match(prompt, /台積電\(2330\)/);
  assert.match(prompt, /鴻海\(2317\)/);
  assert.match(prompt, /不要對任何個股給出買進或賣出建議/);
});

test('buildPrompt 對空清單不會噴例外', () => {
  const prompt = buildPrompt([]);
  assert.match(prompt, /（無資料）/);
});

test('extractReportText 取最後一段 model_output 的文字', () => {
  const data = {
    steps: [
      { type: 'plan', content: [] },
      { type: 'model_output', content: [{ type: 'text', text: '第一版草稿' }] },
      { type: 'tool_call', content: [] },
      { type: 'model_output', content: [{ type: 'text', text: '最終報告內容' }] },
    ],
  };
  assert.equal(extractReportText(data), '最終報告內容');
});

test('extractReportText 沒有 model_output 時回空字串', () => {
  assert.equal(extractReportText({ steps: [] }), '');
  assert.equal(extractReportText({}), '');
});

test('normalizeInteraction 未完成時不帶 text 欄位', () => {
  const result = normalizeInteraction({ id: 'abc', status: 'in_progress', steps: [] });
  assert.deepEqual(result, { id: 'abc', status: 'in_progress' });
});

test('normalizeInteraction 完成時帶出報告文字', () => {
  const result = normalizeInteraction({
    id: 'abc',
    status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '報告' }] }],
  });
  assert.deepEqual(result, { id: 'abc', status: 'completed', text: '報告' });
});

test('沒有設定 GEMINI_API_KEY 時，isConfigured 為 false 且呼叫會明確報錯', async () => {
  if (process.env.GEMINI_API_KEY) return; // 本機若真的設了金鑰就跳過，避免誤打真實 API
  assert.equal(isConfigured(), false);
  await assert.rejects(() => startResearch('測試'), /GEMINI_API_KEY/);
  await assert.rejects(() => getResearch('some-id'), /GEMINI_API_KEY/);
});
