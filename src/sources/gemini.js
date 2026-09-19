/**
 * Gemini Deep Research 用戶端。
 *
 * 這支 agent 只能透過 Interactions API 存取（不是一般的 generateContent），
 * 而且是非同步的：POST 建立任務後要靠 GET 輪詢狀態，一次研究可能跑
 * 好幾分鐘到最多一小時。研究結果存在 Google 那邊，我們的伺服器只是
 * 轉發 interaction id 與狀態，不落地保存任何報告內容 —— 跟本專案
 * 「後端零狀態」的原則一致。
 *
 * 刻意不套用 src/http.js 的重試機制：那支是為了免費、冪等的公開資料
 * 端點設計的；Deep Research 每次呼叫都會計費，自動重試等於可能重複
 * 扣款，所以這裡失敗就直接丟出錯誤，交給呼叫端決定要不要讓使用者
 * 手動重試。
 */

import { GEMINI_API_KEY, GEMINI_API_BASE, GEMINI_DEEP_RESEARCH_MODEL } from '../config.js';

const REQUEST_TIMEOUT_MS = 20000; // 只用來等「建立任務」或「查一次狀態」的回應，不是等研究完成

export function isConfigured() {
  return Boolean(GEMINI_API_KEY);
}

async function call(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${GEMINI_API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? `Gemini API 逾時（${REQUEST_TIMEOUT_MS}ms）` : `Gemini API 連線失敗：${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini API 錯誤 HTTP ${res.status}：${text.slice(0, 300).replace(/\s+/g, ' ')}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini API 回應不是合法 JSON（前 80 字：${text.slice(0, 80).replace(/\s+/g, ' ')}）`);
  }
}

/** 從 interaction 物件取出最後一段模型輸出的文字（研究報告本文） */
export function extractReportText(data) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type !== 'model_output') continue;
    const textPart = (step.content || []).find((c) => c?.type === 'text' && c.text);
    if (textPart) return textPart.text;
  }
  return '';
}

/** 把 Gemini 的 interaction 物件收斂成前端需要的形狀 */
export function normalizeInteraction(data) {
  const status = data.status || 'unknown';
  if (status !== 'completed') return { id: data.id, status };
  return { id: data.id, status, text: extractReportText(data) };
}

/**
 * 開始一份 Deep Research 任務。
 * @param {string} prompt 研究題目（繁體中文）
 * @returns {Promise<{id:string, status:string}>}
 */
export async function startResearch(prompt) {
  if (!isConfigured()) throw new Error('尚未設定 GEMINI_API_KEY，AI 市場報告功能未啟用');
  const data = await call('/interactions', {
    method: 'POST',
    body: {
      agent: GEMINI_DEEP_RESEARCH_MODEL,
      input: prompt,
      background: true,
      agent_config: { type: 'deep-research' },
    },
  });
  return { id: data.id, status: data.status || 'in_progress' };
}

/**
 * 查詢一份 Deep Research 任務的狀態／結果。
 * @param {string} id startResearch() 回傳的 interaction id
 */
export async function getResearch(id) {
  if (!isConfigured()) throw new Error('尚未設定 GEMINI_API_KEY，AI 市場報告功能未啟用');
  if (!id) throw new Error('缺少 interaction id');
  const data = await call(`/interactions/${encodeURIComponent(id)}`);
  return normalizeInteraction(data);
}
