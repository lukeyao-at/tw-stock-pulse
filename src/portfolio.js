/**
 * 持股損益與組合分析。
 *
 * 費用預設用台股實務值：手續費 0.1425%（買賣各收，多數券商有折扣）、
 * 賣出證交稅 0.3%。這些是預設值而非定論，前端可覆寫。
 */

const FEE_RATE = 0.001425;
const TAX_RATE = 0.003;
const MIN_FEE = 20; // 多數券商的最低手續費

const feeFor = (amount, discount) => Math.max(MIN_FEE, Math.round(amount * FEE_RATE * discount));

/**
 * @param {Array<{code:string, shares:number, cost:number}>} holdings 成本為每股價格
 * @param {Map} byCode 股票宇宙
 * @param {Map} quoteByCode 盤中即時報價（可選，有則優先於收盤價）
 * @param {{feeDiscount?:number, includeFees?:boolean}} opts
 */
export function evaluate(holdings, byCode, quoteByCode = new Map(), opts = {}) {
  const { feeDiscount = 0.6, includeFees = true } = opts;

  const positions = [];
  let totalCost = 0;
  let totalValue = 0;

  for (const h of holdings) {
    const shares = Number(h.shares) || 0;
    const cost = Number(h.cost) || 0;
    const stock = byCode.get(h.code);
    const live = quoteByCode.get(h.code);
    const price = live?.price ?? stock?.close ?? null;

    if (!stock && !live) {
      // 查無此代號（下市、輸入錯誤、或今日無資料）。
      // 欄位一律補 null 而不是留空，前端才不會顯示 undefined。
      positions.push({
        code: h.code,
        name: h.name || h.code,
        shares, cost,
        price: null, marketValue: null, costAmount: shares * cost,
        fees: 0, profit: null, profitPercent: null,
        industry: null, market: null, changePercent: null, priceSource: null,
        unknown: true,
      });
      continue;
    }

    const costAmount = shares * cost;
    const marketValue = price !== null ? shares * price : null;

    // 買進手續費 + 賣出手續費 + 證交稅，反映真正落袋的損益
    const buyFee = includeFees ? feeFor(costAmount, feeDiscount) : 0;
    const sellFee = includeFees && marketValue !== null ? feeFor(marketValue, feeDiscount) : 0;
    const tax = includeFees && marketValue !== null ? Math.round(marketValue * TAX_RATE) : 0;
    const fees = buyFee + sellFee + tax;

    const profit = marketValue !== null ? marketValue - costAmount - fees : null;

    totalCost += costAmount + buyFee;
    if (marketValue !== null) totalValue += marketValue - sellFee - tax;

    positions.push({
      code: h.code,
      name: stock?.name || live?.name || h.code,
      industry: stock?.industry ?? null,
      market: stock?.market ?? null,
      shares,
      cost,
      price,
      priceSource: live ? (live.estimated ? '盤中推估' : '盤中') : '收盤',
      changePercent: live?.changePercent ?? stock?.changePercent ?? null,
      costAmount,
      marketValue,
      fees,
      profit,
      profitPercent: profit !== null && costAmount > 0 ? +((profit / costAmount) * 100).toFixed(2) : null,
    });
  }

  positions.sort((a, b) => (b.marketValue || 0) - (a.marketValue || 0));

  // 產業集中度：最大單一產業占比，超過 40% 在畫面上提示
  const byIndustry = new Map();
  for (const p of positions) {
    if (!p.marketValue) continue;
    const key = p.industry || '未分類';
    byIndustry.set(key, (byIndustry.get(key) || 0) + p.marketValue);
  }
  const valueSum = [...byIndustry.values()].reduce((a, b) => a + b, 0);
  const concentration = [...byIndustry.entries()]
    .map(([industry, value]) => ({
      industry,
      value,
      percent: valueSum > 0 ? +((value / valueSum) * 100).toFixed(1) : 0,
    }))
    .sort((a, b) => b.value - a.value);

  const totalProfit = totalValue - totalCost;

  return {
    positions,
    summary: {
      totalCost: Math.round(totalCost),
      totalValue: Math.round(totalValue),
      totalProfit: Math.round(totalProfit),
      totalProfitPercent: totalCost > 0 ? +((totalProfit / totalCost) * 100).toFixed(2) : null,
      positionCount: positions.filter((p) => !p.unknown).length,
    },
    concentration,
    topConcentration: concentration[0] ?? null,
    feeNote: includeFees
      ? `損益已內含手續費 ${(FEE_RATE * feeDiscount * 100).toFixed(4)}%（買賣各一次，最低 ${MIN_FEE} 元）與賣出證交稅 ${(TAX_RATE * 100).toFixed(1)}%`
      : '損益未計入手續費與證交稅',
  };
}
