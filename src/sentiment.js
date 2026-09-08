/**
 * 中文財經新聞的利多/利空判讀。
 *
 * 刻意用「詞典 + 權重」而不是機器學習：台股新聞標題的用語高度固定
 * （「上調目標價」、「外資買超」、「財測下修」），詞典的準確度夠用，
 * 而且結果可解釋、可測試、不需要任何外部服務或 API key。
 *
 * 權重 3 = 強訊號（法人動作、財測），2 = 中，1 = 弱/情緒性。
 */

const BULLISH = [
  ['漲停', 3], ['創新高', 3], ['大漲', 3], ['飆', 3], ['上調目標價', 3], ['調升評等', 3],
  ['外資買超', 3], ['法人買超', 3], ['投信買超', 3], ['財測上修', 3], ['上修', 3],
  ['營收創高', 3], ['獲利創高', 3], ['擴產', 2], ['新訂單', 2], ['大單', 2], ['轉單', 2],
  ['營收成長', 2], ['獲利成長', 2], ['營收增', 2], ['接單', 2], ['進補', 2], ['題材', 2],
  ['除息填息', 2], ['填息', 2], ['配息', 2], ['現金股利', 2], ['股利', 1], ['殖利率', 1],
  ['買進', 2], ['加碼', 2], ['看好', 2], ['樂觀', 2], ['受惠', 2], ['優於預期', 3],
  ['旺季', 2], ['回升', 2], ['止跌', 1], ['反彈', 1], ['站上', 1], ['走揚', 1],
  ['成長', 1], ['突破', 1], ['強勢', 1], ['亮眼', 2], ['告捷', 2], ['奪', 1], ['得標', 2],
];

const BEARISH = [
  ['跌停', 3], ['崩', 3], ['重挫', 3], ['大跌', 3], ['創新低', 3], ['下修', 3],
  ['調降評等', 3], ['降評', 3], ['下調目標價', 3], ['外資賣超', 3], ['法人賣超', 3],
  ['投信賣超', 3], ['財測下修', 3], ['虧損', 3], ['認賠', 3], ['減資', 3], ['爆雷', 3],
  ['違約', 3], ['訴訟', 2], ['遭罰', 2], ['裁員', 3], ['停工', 3], ['關廠', 3], ['召回', 2],
  ['砍單', 3], ['庫存', 1], ['去化', 1], ['衰退', 3], ['營收衰退', 3], ['營收減', 2],
  ['不如預期', 3], ['低於預期', 3], ['遜於預期', 3], ['淡季', 2], ['疑慮', 2], ['觀望', 1],
  ['賣出', 2], ['減碼', 2], ['看壞', 2], ['保守', 1], ['壓力', 1], ['回檔', 2],
  ['摔', 2], ['失守', 2], ['走弱', 2], ['疲軟', 2], ['降價', 1], ['殺價', 2], ['虧', 2],
  ['警訊', 2], ['風險', 1], ['調查', 2], ['停牌', 3], ['處分', 2], ['列管', 2],
];

/**
 * 否定詞：出現在利多詞「前面」時要翻轉極性。
 * 例：「不看好」、「未能突破」、「無法填息」。
 */
const NEGATORS = ['不', '未', '無法', '難以', '沒有', '沒', '免', '非'];

/**
 * 推測語境：預測/傳聞不該和已實現的事實同權重。
 *
 * 一定要用詞組或正則，不能用單字。用單字 `傳` 會把「傳統封測」誤判成
 * 傳聞、用單字 `疑` 會把「產生疑慮」（本身是利空事實）誤判成推測，
 * 兩者都會讓分數被錯誤打折。
 */
const HEDGES = [
  // 「傳鴻海遭砍單」這種「傳＋公司名」是台股新聞最常見的傳聞句式，
  // 所以要保留單字 傳，但排除它的正常複合詞（傳統、傳產、傳媒…）。
  /傳(?!統|產|承|遞|達|播|送|輸|染|奇|真|記|媒|銷)/,
  /外傳/, /據傳/,
  /有望/, /有機會/, /可能/, /預估/, /預料/, /料將/, /上看/,
  // 「恐再降價」是推測，但「恐慌」「恐懼」是情緒詞，要排除
  /恐(?!慌|懼|嚇)/,
  /疑似/,
];

const NEG_WINDOW = 3; // 否定詞需緊鄰（3 字內）才算修飾該詞

function scanTerms(text, table, polarity) {
  const hits = [];
  for (const [term, weight] of table) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(term, from);
      if (at === -1) break;

      const before = text.slice(Math.max(0, at - NEG_WINDOW), at);
      const negated = NEGATORS.some((n) => before.includes(n));
      hits.push({ term, weight, negated, at, end: at + term.length, polarity });

      from = at + term.length;
    }
  }
  return hits;
}

/**
 * 去掉被更長的詞完全覆蓋的命中。
 *
 * 詞典裡有「財測下修」也有「下修」，同一段文字會兩個都命中，
 * 不處理的話同一件事被計分兩次（-3 + -3），分數與信心度都會虛胖。
 * 保留較長（較具體）的那個，因為它的權重才是為這個語境訂的。
 */
function dropOverlaps(hits) {
  const sorted = [...hits].sort((a, b) => b.end - b.at - (a.end - a.at));
  const kept = [];
  for (const hit of sorted) {
    const covered = kept.some((k) => hit.at >= k.at && hit.end <= k.end);
    if (!covered) kept.push(hit);
  }
  return kept;
}

/**
 * 判讀一則新聞的情緒。
 * @returns {{label:'利多'|'利空'|'中性', score:number, confidence:number, matched:string[]}}
 */
export function analyze(text) {
  const clean = String(text || '');
  if (!clean.trim()) return { label: '中性', score: 0, confidence: 0, matched: [] };

  const hits = dropOverlaps([
    ...scanTerms(clean, BULLISH, 1),
    ...scanTerms(clean, BEARISH, -1),
  ]);

  let score = 0;
  const matched = [];

  for (const hit of hits) {
    // 否定會翻轉極性：「不看好」算利空、「不虧損」算利多
    const direction = hit.negated ? -hit.polarity : hit.polarity;
    score += direction * hit.weight;
    matched.push(hit.negated ? `不${hit.term}` : hit.term);
  }

  // 傳聞/預測性語句打折，避免「傳砍單」和「確認砍單」同分
  const hedged = HEDGES.some((pattern) => pattern.test(clean));
  if (hedged) score *= 0.6;

  const magnitude = Math.abs(score);
  const label = score >= 2 ? '利多' : score <= -2 ? '利空' : '中性';

  return {
    label,
    score: +score.toFixed(2),
    // 信心度：命中越多越強，但封頂在 1
    confidence: +Math.min(1, magnitude / 6).toFixed(2),
    matched: [...new Set(matched)].slice(0, 6),
    hedged,
  };
}

/** 一批新聞的情緒統計，用於「今日氛圍」摘要 */
export function summarize(items) {
  const counts = { 利多: 0, 利空: 0, 中性: 0 };
  let total = 0;
  for (const item of items) {
    const label = item.sentiment?.label ?? analyze(`${item.title} ${item.summary || ''}`).label;
    counts[label] = (counts[label] || 0) + 1;
    total += item.sentiment?.score ?? 0;
  }
  const net = items.length ? +(total / items.length).toFixed(2) : 0;
  return {
    counts,
    net,
    mood: net >= 1 ? '偏多' : net <= -1 ? '偏空' : '中性',
  };
}
