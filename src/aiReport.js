/**
 * AI 市場報告：把當下的大盤快照丟給 Gemini Deep Research，
 * 請它做外部研究並產出一份台股市場與產業總覽報告。
 *
 * 只做「市場/產業總覽」，不是個股報告 —— 不去計算或建議個股買賣，
 * 避免跟 src/recommend.js 的可解釋、確定性設計混在一起。
 */

import * as universe from './universe.js';
import * as gemini from './sources/gemini.js';

export const isConfigured = gemini.isConfigured;

/** 前 N 檔的簡短列表，供提示詞引用 */
function topList(stocks, n = 10) {
  return stocks
    .slice(0, n)
    .map((s) => `${s.name}(${s.code}) ${s.changePercent > 0 ? '+' : ''}${s.changePercent?.toFixed(2)}%`)
    .join('、') || '（無資料）';
}

/** 把股票宇宙收斂成一段可以放進提示詞的市場快照文字 */
export function buildPrompt(stocks) {
  const withChange = stocks.filter((s) => typeof s.changePercent === 'number');
  const gainers = [...withChange].sort((a, b) => b.changePercent - a.changePercent);
  const losers = [...withChange].sort((a, b) => a.changePercent - b.changePercent);
  const active = [...stocks].sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0));
  const up = withChange.filter((s) => s.changePercent > 0).length;
  const down = withChange.filter((s) => s.changePercent < 0).length;

  return `你是一位專門研究台灣股市的分析師。以下是台股（上市＋上櫃）今天收盤的行情快照，
做為你研究的起點（不是全部依據，請另外查證最新的總體經濟與產業新聞）：

- 上漲家數：${up}，下跌家數：${down}
- 漲幅前十：${topList(gainers)}
- 跌幅前十：${topList(losers)}
- 成交金額前十：${topList(active, 10)}

請針對台股目前的市場與產業狀況做深度研究，並撰寫一份繁體中文的「台股市場與產業總覽報告」，需包含：

1. 今日大盤表現與資金流向摘要
2. 表現突出與落後的產業別，並說明可能原因（可引用近期新聞、總體經濟數據、國際情勢或產業趨勢）
3. 值得留意的類股輪動、資金流向或風險因子
4. 報告最後附上引用來源

請只做客觀的市場與產業分析，不要對任何個股給出買進或賣出建議。`;
}

/** 啟動一份市場總覽的 Deep Research 任務 */
export async function startMarketReport() {
  const uni = await universe.load();
  return gemini.startResearch(buildPrompt(uni.stocks));
}

/** 查詢先前啟動的市場報告任務 */
export const getMarketReport = gemini.getResearch;
