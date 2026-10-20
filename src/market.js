/**
 * 盤勢摘要：從全市場個股的當日行情算出漲跌家數、成交值，與各產業的當日漲跌。
 *
 * 純函式，伺服器（src/api.js）與單頁快照（scripts/page-builder.js）共用。
 * 產業漲跌用成交值加權 —— 大型權值股的走勢才是那個產業當天真正的方向，
 * 簡單平均會被一堆冷門小股拉偏。
 */

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n, digits = 2) => (isNum(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null);

/**
 * @param {Array<{industry?:string, changePercent?:number, turnover?:number}>} stocks
 * @param {{minShare?:number}} opts 成交比重低於 minShare（%）的產業不列入，避免零星成交的雜訊
 */
export function marketSummary(stocks, { minShare = 0.5 } = {}) {
  const rows = (stocks ?? []).filter((s) => isNum(s.changePercent));
  const up = rows.filter((s) => s.changePercent > 0).length;
  const down = rows.filter((s) => s.changePercent < 0).length;
  const turnover = rows.reduce((a, s) => a + (isNum(s.turnover) ? s.turnover : 0), 0);

  const groups = new Map();
  for (const s of rows) {
    if (!s.industry || !isNum(s.turnover) || s.turnover <= 0) continue;
    const g = groups.get(s.industry) ?? { name: s.industry, turnover: 0, weighted: 0, count: 0 };
    g.turnover += s.turnover;
    g.weighted += s.changePercent * s.turnover;
    g.count += 1;
    groups.set(s.industry, g);
  }
  const sectors = [...groups.values()]
    .map((g) => ({
      name: g.name,
      changePercent: round(g.weighted / g.turnover, 2),
      turnover: g.turnover,
      share: turnover ? round((g.turnover / turnover) * 100, 2) : null,
      count: g.count,
    }))
    .filter((g) => g.share === null || g.share >= minShare)
    .sort((a, b) => b.changePercent - a.changePercent);

  return { up, down, flat: rows.length - up - down, total: rows.length, turnover, sectors };
}

/**
 * 某個產業今天的個股，依成交值由大到小（成交值大的才是撐起產業漲跌的股票）。
 * @returns {{name:string, count:number, stocks:Array}}
 */
export function sectorStocks(stocks, name) {
  const list = (stocks ?? [])
    .filter((s) => s.industry === name && isNum(s.changePercent))
    .sort((a, b) => (b.turnover ?? 0) - (a.turnover ?? 0))
    .map((s) => ({
      code: s.code, name: s.name, close: s.close ?? null, change: s.change ?? null,
      changePercent: s.changePercent, turnover: s.turnover ?? null,
    }));
  return { name, count: list.length, stocks: list };
}
