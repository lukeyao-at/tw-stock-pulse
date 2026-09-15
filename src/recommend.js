/**
 * 個人化推薦引擎。
 *
 * 設計原則：
 *  - 可解釋。每個分數都由具名因子加權而成，且每檔推薦都附上用實際
 *    數字跟市場中位數比較的理由。不做黑箱評分。
 *  - 確定性。同樣的輸入永遠得到同樣的輸出，方便測試與比對。
 *  - 誠實面對缺漏。生技股常沒有本益比（虧損中），這種情況該因子
 *    以中性計分並在理由裡註明，而不是當成 0 分懲罰它。
 *
 * 這是「條件篩選 + 分散度」的排序工具，不是投資建議。
 */

/** 各因子在不同風險偏好下的權重（每組加總為 1） */
const WEIGHTS = {
  conservative: { dividend: 0.32, value: 0.24, liquidity: 0.22, momentum: 0.04, diversify: 0.18 },
  balanced:     { dividend: 0.20, value: 0.24, liquidity: 0.14, momentum: 0.20, diversify: 0.22 },
  aggressive:   { dividend: 0.06, value: 0.14, liquidity: 0.10, momentum: 0.44, diversify: 0.26 },
};

/** 投資目標會再往對應因子加碼（加碼後重新正規化） */
const GOAL_BOOST = {
  dividend: { dividend: 0.15 },
  value:    { value: 0.15 },
  growth:   { momentum: 0.15 },
};

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/** 殖利率的「甜蜜點」與「可疑門檻」（%） */
const YIELD_SWEET_SPOT = 7;
const YIELD_SUSPICIOUS = 9;

/**
 * 殖利率計分：0 → YIELD_SWEET_SPOT 線性上升到滿分，
 * 之後遞減（但保留 0.35 的底），反映「過高的殖利率通常不可持續」。
 */
function dividendScore(yieldPercent) {
  if (yieldPercent <= 0) return 0;
  if (yieldPercent <= YIELD_SWEET_SPOT) return clamp01(yieldPercent / YIELD_SWEET_SPOT);
  return Math.max(0.35, 1 - (yieldPercent - YIELD_SWEET_SPOT) / 8);
}

function median(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function resolveWeights(risk, goals = []) {
  const base = { ...(WEIGHTS[risk] || WEIGHTS.balanced) };
  for (const goal of goals) {
    for (const [factor, boost] of Object.entries(GOAL_BOOST[goal] || {})) {
      base[factor] = (base[factor] || 0) + boost;
    }
  }
  const total = Object.values(base).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v / total]));
}

/**
 * 產生推薦。
 * @param {Array} stocks 股票宇宙
 * @param {object} profile 使用者設定
 * @returns {{items:Array, weights:object, market:object, disclaimer:string}}
 */
export function recommend(stocks, profile = {}) {
  const {
    risk = 'balanced',
    goals = [],
    holdings = [],
    watchlist = [],
    excludeIndustries = [],
    minTurnover = 5e7,   // 預設濾掉日成交金額不足 5000 萬的冷門股
    limit = 8,
  } = profile;

  const weights = resolveWeights(risk, goals);

  // 已持有與已在自選清單的不重複推薦；產業分散度以「現有持股」為基準
  const holdingCodes = new Set(holdings.map((h) => h.code));
  const watchCodes = new Set(watchlist.map((w) => (typeof w === 'string' ? w : w.code)));
  const byCode = new Map(stocks.map((s) => [s.code, s]));

  const heldIndustries = new Map();
  for (const code of holdingCodes) {
    const industry = byCode.get(code)?.industry;
    if (industry) heldIndustries.set(industry, (heldIndustries.get(industry) || 0) + 1);
  }

  // 市場中位數：理由裡拿來當比較基準，讓「殖利率高」變成可驗證的敘述
  const market = {
    dividendYield: median(stocks.map((s) => s.dividendYield)),
    peRatio: median(stocks.map((s) => s.peRatio)),
    pbRatio: median(stocks.map((s) => s.pbRatio)),
  };
  const maxTurnover = Math.max(...stocks.map((s) => s.turnover || 0), 1);

  const candidates = stocks.filter((s) => {
    if (holdingCodes.has(s.code) || watchCodes.has(s.code)) return false;
    if (excludeIndustries.includes(s.industry)) return false;
    if ((s.turnover || 0) < minTurnover) return false;
    return typeof s.close === 'number' && s.close > 0;
  });

  const scored = candidates.map((stock) => {
    const factors = {};
    // 理由帶上來源因子，之後才能按「貢獻度」排序，
    // 讓畫面上的第一條理由和標示的主因一致。
    const tagged = [];
    const cautions = [];
    const push = (factor, text) => tagged.push({ factor, text });

    // ── 殖利率：倒 U 型，不是越高越好。
    //    景氣循環股在獲利高點常出現 10%+ 的殖利率，隔年就大幅縮水，
    //    對保守型投資人是風險而非優點，所以超過 SWEET_SPOT 後遞減計分。
    if (typeof stock.dividendYield === 'number') {
      factors.dividend = dividendScore(stock.dividendYield);
      if (market.dividendYield !== null && stock.dividendYield > market.dividendYield * 1.2) {
        push('dividend', `殖利率 ${stock.dividendYield.toFixed(2)}%，高於市場中位數 ${market.dividendYield.toFixed(2)}%`);
      }
      if (stock.dividendYield > YIELD_SUSPICIOUS) {
        cautions.push(`殖利率 ${stock.dividendYield.toFixed(2)}% 異常偏高，須確認是否為一次性配息或獲利已在高點，評分已因此打折`);
      }
    } else {
      factors.dividend = 0.3; // 無股利資料：中性偏低，不當成 0 分懲罰
      push('dividend', '無股利資料（可能尚未配息或處於虧損）');
    }

    // ── 價值：本益比與股價淨值比各半，低者得分高
    const peScore = typeof stock.peRatio === 'number' && stock.peRatio > 0
      ? clamp01(1 - stock.peRatio / 40)
      : 0.4; // 虧損或無資料：中性
    const pbScore = typeof stock.pbRatio === 'number' && stock.pbRatio > 0
      ? clamp01(1 - stock.pbRatio / 6)
      : 0.4;
    factors.value = (peScore + pbScore) / 2;

    if (typeof stock.peRatio === 'number' && market.peRatio !== null && stock.peRatio > 0 && stock.peRatio < market.peRatio * 0.8) {
      push('value', `本益比 ${stock.peRatio.toFixed(1)} 倍，低於市場中位數 ${market.peRatio.toFixed(1)} 倍`);
    }
    if (typeof stock.pbRatio === 'number' && stock.pbRatio < 1) {
      push('value', `股價淨值比 ${stock.pbRatio.toFixed(2)}，低於每股淨值`);
    }
    if (typeof stock.peRatio === 'number' && stock.peRatio > 40) {
      cautions.push(`本益比 ${stock.peRatio.toFixed(1)} 倍偏高，對獲利不如預期較敏感`);
    }

    // ── 動能：當日漲跌幅，±5% 為飽和
    const pct = typeof stock.changePercent === 'number' ? stock.changePercent : 0;
    factors.momentum = clamp01((pct + 5) / 10);
    if (pct >= 2) push('momentum', `今日上漲 ${pct.toFixed(2)}%，短線動能偏強`);
    if (pct <= -2) push('momentum', `今日下跌 ${Math.abs(pct).toFixed(2)}%，屬回檔中的標的`);

    // ── 流動性：成交金額取對數，避免權值股一枝獨秀壓垮其他人
    const turnover = stock.turnover || 0;
    factors.liquidity = clamp01(Math.log10(turnover + 1) / Math.log10(maxTurnover + 1));
    if (turnover >= 1e9) push('liquidity', `日成交金額約 ${(turnover / 1e8).toFixed(1)} 億元，流動性充足`);
    if (turnover < 2e8) cautions.push('成交量偏低，進出可能有滑價');

    // ── 分散度：持股裡沒有的產業給滿分，已重壓的產業遞減
    const heldCount = heldIndustries.get(stock.industry) || 0;
    factors.diversify = heldCount === 0 ? 1 : clamp01(1 / (heldCount + 1));
    if (heldCount === 0 && stock.industry && holdingCodes.size > 0) {
      push('diversify', `${stock.industry}｜你目前持股未涵蓋此產業，可分散集中度`);
    } else if (heldCount >= 2) {
      cautions.push(`你已持有 ${heldCount} 檔${stock.industry}，再加碼會提高產業集中度`);
    }

    const score = Object.entries(weights).reduce(
      (sum, [factor, weight]) => sum + weight * (factors[factor] ?? 0),
      0,
    );

    return {
      code: stock.code,
      name: stock.name,
      market: stock.market,
      industry: stock.industry,
      close: stock.close,
      changePercent: stock.changePercent,
      peRatio: stock.peRatio,
      dividendYield: stock.dividendYield,
      pbRatio: stock.pbRatio,
      score: +score.toFixed(4),
      factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, +v.toFixed(3)])),
      tagged,
      cautions: cautions.slice(0, 2),
    };
  });

  // 主因與理由排序：用「相對候選池平均的突出程度」而不是絕對分數。
  // 持股少時幾乎每檔的 diversify 都是滿分，該因子不具區辨力，
  // 用絕對分數會讓每檔的主因都變成 diversify，資訊量為零。
  const factorNames = Object.keys(weights);
  const means = {};
  for (const name of factorNames) {
    const values = scored.map((s) => s.factors[name] ?? 0);
    means[name] = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  }

  const standout = (item, factor) => (weights[factor] ?? 0) * ((item.factors[factor] ?? 0) - means[factor]);

  for (const item of scored) {
    const ranked = factorNames
      .map((f) => [f, standout(item, f)])
      .sort((a, b) => b[1] - a[1]);

    item.topFactor = ranked[0]?.[1] > 0 ? ranked[0][0] : null;

    const order = new Map(ranked.map(([f], i) => [f, i]));
    item.reasons = item.tagged
      .sort((a, b) => (order.get(a.factor) ?? 99) - (order.get(b.factor) ?? 99))
      .map((t) => t.text)
      .slice(0, 3);
    delete item.tagged;
  }

  // 同分時代號小的在前，確保輸出穩定可測
  scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  // 產業上限：避免整份推薦清單都是同一個產業。
  //
  // 迴歸測試：只對「已知產業」的標的設上限。若把不知道產業別的標的
  // 全部歸進同一個「未分類」桶再套上限，會等於宣稱「這些互不相干的
  // 公司都是同一個產業」——來源被擋、industry 全部是 null 時
  // （見 src/sources/twse.js 的 profiles()），這個桶會裝下候選池
  // 裡幾乎所有標的，上限機制會把整份推薦清單砍到只剩 perIndustryCap
  // 檔（例如要 8 檔卻只給 3 檔），跟「避免集中在同一產業」的本意相反。
  const perIndustryCap = Math.max(2, Math.ceil(limit / 3));
  const picked = [];
  const industryCount = new Map();

  for (const item of scored) {
    const key = item.industry;
    if (key) {
      if ((industryCount.get(key) || 0) >= perIndustryCap) continue;
      industryCount.set(key, (industryCount.get(key) || 0) + 1);
    }
    picked.push(item);
    if (picked.length >= limit) break;
  }

  return {
    items: picked,
    weights,
    market,
    candidateCount: candidates.length,
    disclaimer: '本清單為依你設定的條件所做的排序與分散度計算，不構成投資建議。數據來自公開資訊，請自行核實後再做決策。',
  };
}
