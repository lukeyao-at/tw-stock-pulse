/**
 * 離線模式與展示版用的模擬日 K。
 *
 * 不是亂數走勢：刻意做出「趨勢段 + 通道內來回擺盪 + 雜訊」的結構，
 * 讓通道、指標、歷史驗證在沒有網路時也能被實際操作到。同一個代號
 * 永遠產生同一組 K 線（以代號當亂數種子），最後一根收盤對齊樣本
 * 宇宙裡的收盤價，畫面上的數字才會前後一致。
 *
 * 純函式、零依賴，build-demo 會把它原封不動嵌進展示版。
 */

function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 往回推 count 個工作日（不處理國定假日，模擬資料不需要） */
function tradingDates(count, endDate) {
  const dates = [];
  const d = new Date(`${endDate}T00:00:00Z`);
  while (dates.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates.reverse();
}

/**
 * @param {string} code
 * @param {{close?:number, volume?:number, count?:number, endDate?:string}} opts
 */
export function sampleBars(code, { close = 100, volume = 5_000_000, count = 480, endDate } = {}) {
  const rand = seededRandom(String(code));
  const end = endDate || new Date().toISOString().slice(0, 10);
  const dates = tradingDates(count, end);

  // 3～5 段走勢，每段各自的方向（每日漂移，對數尺度）
  const regimes = [];
  let remaining = count;
  while (remaining > 0) {
    const len = Math.min(remaining, 80 + Math.floor(rand() * 90));
    const kind = rand();
    const drift = kind < 0.45 ? 0.0012 + rand() * 0.0015 : kind < 0.75 ? -(0.0008 + rand() * 0.0012) : 0;
    regimes.push({ len, drift, period: 18 + rand() * 20, amp: 0.035 + rand() * 0.04 });
    remaining -= len;
  }

  const logs = [];
  let base = 0;
  for (const r of regimes) {
    const phase = rand() * Math.PI * 2;
    for (let i = 0; i < r.len; i++) {
      base += r.drift;
      const swing = r.amp * Math.sin(phase + (2 * Math.PI * i) / r.period);
      logs.push({ trend: base, value: base + swing + (rand() - 0.5) * 0.02 });
    }
  }

  // 平移到最後一根收盤等於指定價位
  const shift = Math.log(close) - logs[logs.length - 1].value;
  const tick = (p) => (p >= 1000 ? 5 : p >= 500 ? 1 : p >= 100 ? 0.5 : p >= 50 ? 0.1 : p >= 10 ? 0.05 : 0.01);
  const snap = (p) => { const t = tick(p); return +(Math.round(p / t) * t).toFixed(2); };

  const bars = [];
  let prevClose = null;
  logs.forEach((l, i) => {
    const c = Math.exp(l.value + shift);
    const o = prevClose === null ? c : prevClose * (1 + (rand() - 0.5) * 0.012);
    const hi = Math.max(o, c) * (1 + rand() * 0.012);
    const lo = Math.min(o, c) * (1 - rand() * 0.012);
    // 量價：急跌與急漲放量，擺盪到兩端時縮量
    const move = prevClose === null ? 0 : Math.abs(c / prevClose - 1);
    const v = volume * (0.6 + rand() * 0.5 + move * 25);
    const bar = { date: dates[i], open: snap(o), high: snap(hi), low: snap(lo), close: snap(c), volume: Math.round(v) };
    bar.high = Math.max(bar.high, bar.open, bar.close);
    bar.low = Math.min(bar.low, bar.open, bar.close);
    bars.push(bar);
    prevClose = bar.close;
  });
  // 最後一根要精準對上樣本收盤價
  const last = bars[bars.length - 1];
  last.close = close;
  last.high = Math.max(last.high, close);
  last.low = Math.min(last.low, close);
  return bars;
}
