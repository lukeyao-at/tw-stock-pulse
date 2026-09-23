/**
 * 技術分析引擎：趨勢通道 + 常用指標 + 綜合判讀 + 歷史驗證。
 *
 * 核心是「通道」：很多人手繪上升／下降通道，碰下緣買、碰上緣賣。這裡把
 * 同一件事做成可計算、可測試的版本，再用指標去「確認」通道訊號 ——
 * 單看通道最大的風險是把「跌破通道」誤認成「回測下緣」，指標與量能
 * 是用來分辨這兩者的。
 *
 * 設計原則（與 recommend.js 一致）：
 *  - 純函式、確定性：同樣的 K 線永遠得到同樣的結論，方便測試
 *  - 可解釋：每一分都附上實際數字的理由，不做黑箱評分
 *  - 沒有未來資料：通道只用「今天以前」的 K 線擬合，再延伸到今天判斷
 *    觸碰或突破 —— 跟手繪通道一樣。歷史驗證也逐日重算，不偷看未來
 *
 * K 線格式：{ date:'YYYY-MM-DD', open, high, low, close, volume }，由舊到新。
 * 這是整理歷史訊號的工具，不是投資建議。
 */

// ── 基本工具 ──────────────────────────────────────────

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const round = (n, digits = 2) => (isNum(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ── 指標 ─────────────────────────────────────────────
// 全部回傳與輸入等長的陣列，資料不足的前段為 null，方便跟 K 線逐根對齊。

/** 簡單移動平均 */
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指數移動平均，以前 period 根的 SMA 起算 */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI（Wilder 平滑，與看盤軟體一致） */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gain += diff; else loss -= diff;
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = value();
  }
  return out;
}

/**
 * KD 隨機指標，台股慣用的 (9,3,3)：
 *   RSV = (收盤 − 9 日最低) ÷ (9 日最高 − 9 日最低) × 100
 *   K = ⅔ × 前 K + ⅓ × RSV；D = ⅔ × 前 D + ⅓ × K；起始值 50
 */
export function kd(bars, period = 9) {
  const k = new Array(bars.length).fill(null);
  const d = new Array(bars.length).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = period - 1; i < bars.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    const rsv = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    prevK = (2 / 3) * prevK + rsv / 3;
    prevD = (2 / 3) * prevD + prevK / 3;
    k[i] = prevK;
    d[i] = prevD;
  }
  return { k, d };
}

/** MACD (12,26,9)。台股軟體習慣稱 DIF、MACD（訊號線）與 OSC（柱狀體） */
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = closes.map((_, i) => (emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null));

  const start = dif.findIndex((v) => v !== null);
  const sig = new Array(closes.length).fill(null);
  if (start !== -1) {
    const tail = ema(dif.slice(start), signal);
    tail.forEach((v, i) => { sig[start + i] = v; });
  }
  const hist = dif.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i] : null));
  return { dif, signal: sig, hist };
}

/** 布林通道 (20, 2σ) */
export function bollinger(closes, period = 20, width = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const sd = Math.sqrt(slice.reduce((a, v) => a + (v - mid[i]) ** 2, 0) / period);
    upper[i] = mid[i] + width * sd;
    lower[i] = mid[i] - width * sd;
  }
  return { mid, upper, lower };
}

/** 平均真實波幅 ATR（Wilder），拿來設停損距離 */
export function atr(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  const tr = bars.map((b, i) => (i === 0
    ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** 一次算完所有指標 */
export function indicators(bars) {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume ?? 0);
  return {
    ma5: sma(closes, 5),
    ma20: sma(closes, 20),
    ma60: sma(closes, 60),
    rsi: rsi(closes, 14),
    kd: kd(bars, 9),
    macd: macd(closes),
    boll: bollinger(closes),
    atr: atr(bars, 14),
    volMa20: sma(volumes, 20),
  };
}

// ── 通道 ─────────────────────────────────────────────

/** 趨勢判定門檻：通道期間的總漂移 ÷ 通道寬度 */
const TREND_RATIO = 0.6;
/** 觸碰判定：距離上下緣在通道寬度的這個比例內 */
const TOUCH_ZONE = 0.12;

const TREND_LABEL = { up: '上升通道', down: '下降通道', range: '水平通道（箱型整理）' };

/**
 * 在 bars[end - lookback, end) 擬合平行通道，並延伸到 bars[end]。
 *
 * 作法跟手繪通道同一個概念，只是把「目測」換成可重現的規則：
 *  1. 收盤價線性迴歸 → 通道的斜率（中軌）
 *  2. 上緣 = 中軌 + 高點殘差的 95 百分位；下緣 = 中軌 + 低點殘差的 5 百分位
 *     用百分位而不是極值，避免一根暴衝的長上影線把整條通道拉歪
 *  3. 期間漂移相對於通道寬度夠大才算上升／下降，否則是箱型
 *
 * @returns {null | {trend, slope, upper, mid, lower, width, r2, touches, line(i)}}
 */
export function fitChannel(bars, lookback = 120, end = bars.length - 1) {
  const start = end - lookback;
  if (start < 0 || lookback < 20) return null;

  const seg = bars.slice(start, end);
  const n = seg.length;
  const xMean = (n - 1) / 2;
  const yMean = seg.reduce((a, b) => a + b.close, 0) / n;
  let sxy = 0;
  let sxx = 0;
  seg.forEach((b, i) => {
    sxy += (i - xMean) * (b.close - yMean);
    sxx += (i - xMean) ** 2;
  });
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const fit = (i) => intercept + slope * i;

  let ssRes = 0;
  let ssTot = 0;
  seg.forEach((b, i) => {
    ssRes += (b.close - fit(i)) ** 2;
    ssTot += (b.close - yMean) ** 2;
  });
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  const upOffset = quantile(seg.map((b, i) => b.high - fit(i)), 0.95);
  const lowOffset = quantile(seg.map((b, i) => b.low - fit(i)), 0.05);
  const width = upOffset - lowOffset;
  if (!(width > 0)) return null;

  const drift = slope * (n - 1);
  const ratio = drift / width;
  const trend = ratio > TREND_RATIO ? 'up' : ratio < -TREND_RATIO ? 'down' : 'range';

  // 觸碰次數：連續幾天都貼著邊緣只算一次（間隔 5 根以上才算新的一次）
  const countTouches = (test) => {
    let count = 0;
    let last = -Infinity;
    seg.forEach((b, i) => {
      if (test(b, i) && i - last > 5) count++;
      if (test(b, i)) last = i;
    });
    return count;
  };
  const zone = width * TOUCH_ZONE;
  const touches = {
    upper: countTouches((b, i) => b.high >= fit(i) + upOffset - zone),
    lower: countTouches((b, i) => b.low <= fit(i) + lowOffset + zone),
  };

  // 以 bars 的絕對索引表示的通道線，方便畫圖與延伸
  const line = (absIndex) => {
    const mid = fit(absIndex - start);
    return { upper: mid + upOffset, mid, lower: mid + lowOffset };
  };
  const today = line(end);

  return {
    trend,
    label: TREND_LABEL[trend],
    lookback,
    start,
    end,
    slope,
    // 通道期間的斜率，換算成「每 20 個交易日（約一個月）漲跌幾 %」比較直覺
    slopePctPerMonth: round((slope * 20 / yMean) * 100, 2),
    r2: round(r2, 3),
    width,
    widthPct: round((width / today.mid) * 100, 2),
    touches,
    upper: today.upper,
    mid: today.mid,
    lower: today.lower,
    line,
  };
}

/** 當日 K 線相對通道的位置 */
export function locate(bar, ch) {
  const w = ch.upper - ch.lower;
  const position = (bar.close - ch.lower) / w;
  let zone = 'middle';
  if (bar.close > ch.upper) zone = 'breakout';
  else if (bar.close < ch.lower) zone = 'breakdown';
  else if (bar.low <= ch.lower + w * TOUCH_ZONE) zone = 'lower';
  else if (bar.high >= ch.upper - w * TOUCH_ZONE) zone = 'upper';
  return { zone, position: round(position, 3) };
}

// ── 背離 ─────────────────────────────────────────────

/**
 * 背離偵測（價格創新低但 RSI 沒有 → 底背離；反之頂背離）。
 * 比較「最近 5 根的極值」與「8～40 根前的轉折點」。
 */
export function divergence(bars, rsiSeries, i) {
  if (i < 45) return null;
  const recent = [];
  for (let j = i - 4; j <= i; j++) recent.push(j);
  const lowIdx = recent.reduce((a, b) => (bars[b].low < bars[a].low ? b : a));
  const highIdx = recent.reduce((a, b) => (bars[b].high > bars[a].high ? b : a));

  const isPivot = (j, cmp) => {
    for (let k = j - 3; k <= j + 3; k++) if (k !== j && !cmp(bars[j], bars[k])) return false;
    return true;
  };

  for (let j = i - 8; j >= i - 40; j--) {
    if (isPivot(j, (a, b) => a.low <= b.low) && rsiSeries[j] !== null && rsiSeries[lowIdx] !== null) {
      if (bars[lowIdx].low < bars[j].low && rsiSeries[lowIdx] > rsiSeries[j] + 3) {
        return { kind: 'bullish', priorDate: bars[j].date, priorRsi: round(rsiSeries[j], 1), rsi: round(rsiSeries[lowIdx], 1) };
      }
      break;
    }
  }
  for (let j = i - 8; j >= i - 40; j--) {
    if (isPivot(j, (a, b) => a.high >= b.high) && rsiSeries[j] !== null && rsiSeries[highIdx] !== null) {
      if (bars[highIdx].high > bars[j].high && rsiSeries[highIdx] < rsiSeries[j] - 3) {
        return { kind: 'bearish', priorDate: bars[j].date, priorRsi: round(rsiSeries[j], 1), rsi: round(rsiSeries[highIdx], 1) };
      }
      break;
    }
  }
  return null;
}

// ── 綜合判讀 ─────────────────────────────────────────

const crossedUp = (a, b, i) => a[i] !== null && b[i] !== null && a[i - 1] !== null && b[i - 1] !== null
  && a[i] > b[i] && a[i - 1] <= b[i - 1];
const crossedDown = (a, b, i) => crossedUp(b, a, i);

/** 最近 n 根內是否發生交叉 */
const crossedWithin = (fn, a, b, i, n = 2) => {
  for (let j = i; j > i - n; j--) if (fn(a, b, j)) return true;
  return false;
};

/**
 * 通道「買進確認」條件 —— 回測與即時判讀共用同一份，確保驗證的
 * 就是畫面上顯示的規則。回傳符合的項目名稱。
 */
export function buyConfirmations(bars, ind, i) {
  const out = [];
  const bar = bars[i];
  if (ind.rsi[i] !== null && ind.rsi[i] < 40) out.push('RSI 低檔');
  if (ind.kd.k[i] !== null && ind.kd.k[i] < 30 && crossedWithin(crossedUp, ind.kd.k, ind.kd.d, i, 3)) out.push('KD 低檔黃金交叉');
  const h = ind.macd.hist;
  if (h[i] !== null && h[i - 1] !== null && h[i] > h[i - 1] && h[i] < 0) out.push('MACD 空方動能收斂');
  if (ind.volMa20[i] && bar.volume < ind.volMa20[i] * 0.8) out.push('量縮回檔');
  if (bar.close > bar.open && bar.close > bars[i - 1].close) out.push('收紅K止跌');
  return out;
}

export function sellConfirmations(bars, ind, i) {
  const out = [];
  const bar = bars[i];
  if (ind.rsi[i] !== null && ind.rsi[i] > 65) out.push('RSI 高檔');
  if (ind.kd.k[i] !== null && ind.kd.k[i] > 70 && crossedWithin(crossedDown, ind.kd.k, ind.kd.d, i, 3)) out.push('KD 高檔死亡交叉');
  const h = ind.macd.hist;
  if (h[i] !== null && h[i - 1] !== null && h[i] < h[i - 1] && h[i] > 0) out.push('MACD 多方動能減弱');
  if (bar.close < bar.open && bar.close < bars[i - 1].close) out.push('收黑K');
  return out;
}

/** 偏多判定的分數門檻 */
const BUY_FLOOR = 18;

const VERDICTS = [
  { min: 40, key: 'strong_buy', label: '買進訊號', tone: 'up' },
  { min: BUY_FLOOR, key: 'buy', label: '偏多・可分批布局', tone: 'up' },
  { min: -18, key: 'hold', label: '觀望', tone: 'neutral' },
  { min: -40, key: 'reduce', label: '偏空・減碼', tone: 'down' },
  { min: -Infinity, key: 'sell', label: '賣出／避開', tone: 'down' },
];

/**
 * 在第 i 根 K 線做一次完整判讀。
 * @returns {{score, verdict, signals:[{points, text, kind}], ...}}
 */
export function evaluateAt(bars, ind, i, lookback = 120) {
  const ch = fitChannel(bars, lookback, i);
  if (!ch) return null;

  const bar = bars[i];
  const prev = bars[i - 1];
  const loc = locate(bar, ch);
  const signals = [];
  const add = (points, text, kind = 'indicator') => signals.push({ points, text, kind });

  const volRatio = ind.volMa20[i] ? bar.volume / ind.volMa20[i] : null;
  const heavy = volRatio !== null && volRatio >= 1.5;
  const volText = volRatio !== null ? `量為 20 日均量的 ${volRatio.toFixed(1)} 倍` : '';

  // ── 1. 通道位置（核心）
  const pctFromLower = ((bar.close - ch.lower) / ch.lower) * 100;
  const pctToUpper = ((ch.upper - bar.close) / bar.close) * 100;
  const { trend } = ch;

  if (loc.zone === 'breakdown') {
    if (trend === 'up') add(heavy ? -40 : -28, `跌破上升通道下緣（${fmtP(ch.lower)}）${heavy ? `，且帶量（${volText}）` : ''}，通道可能失效，不是回測買點`, 'channel');
    else if (trend === 'down') add(-18, `跌破下降通道下緣，呈加速下跌，先別接刀`, 'channel');
    else add(heavy ? -32 : -22, `跌破箱型下緣（${fmtP(ch.lower)}），箱型支撐失守`, 'channel');
  } else if (loc.zone === 'breakout') {
    if (trend === 'down') add(heavy ? 25 : 8, `突破下降通道上緣（${fmtP(ch.upper)}）${heavy ? `並帶量（${volText}），趨勢可能反轉；較穩健的做法是等回測不破再進` : '，但量能不足，小心假突破'}`, 'channel');
    else if (trend === 'range') add(heavy ? 22 : 6, `突破箱型上緣（${fmtP(ch.upper)}）${heavy ? `並帶量（${volText}），可能展開新一段走勢` : '，量能不足，突破有待確認'}`, 'channel');
    else add(-8, `已衝出上升通道上緣，短線乖離過大，追價風險高`, 'channel');
  } else if (loc.zone === 'lower') {
    if (trend === 'up') add(32, `回測上升通道下緣（${fmtP(ch.lower)}，距離 ${pctFromLower.toFixed(1)}%），這是你慣用的通道買點`, 'channel');
    else if (trend === 'range') add(24, `來到箱型下緣（${fmtP(ch.lower)}）附近，箱型區間的低接位置`, 'channel');
    else add(4, `觸及下降通道下緣：主趨勢仍向下，只適合小量短線搶反彈，目標看中軌 ${fmtP(ch.mid)}`, 'channel');
  } else if (loc.zone === 'upper') {
    if (trend === 'up') add(-16, `接近上升通道上緣（${fmtP(ch.upper)}，剩 ${pctToUpper.toFixed(1)}%），上檔有壓，不宜追高；持股可考慮部分停利`, 'channel');
    else if (trend === 'range') add(-22, `來到箱型上緣（${fmtP(ch.upper)}）附近，區間操作的賣點`, 'channel');
    else add(-32, `反彈至下降通道上緣（${fmtP(ch.upper)}）遇壓，下降趨勢中的反彈賣點`, 'channel');
  } else {
    const where = loc.position < 0.5 ? '中軌下方' : '中軌上方';
    const pts = trend === 'up' ? 6 : trend === 'down' ? -6 : 0;
    add(pts, `位於${ch.label}${where}（通道位置 ${(loc.position * 100).toFixed(0)}%），沒有觸碰邊緣，不是理想的進出點`, 'channel');
  }

  // 通道要上下緣各被碰過至少 2 次才算成立，只碰 1 次的線是「畫出來的」不是「被驗證的」
  const weakSide = Math.min(ch.touches.upper, ch.touches.lower);
  if (weakSide < 2 && loc.zone !== 'middle') {
    add(-8, `通道${ch.touches.upper < 2 ? '上緣' : '下緣'}只被碰過 ${weakSide} 次，通道本身的可靠度不足`, 'channel');
  }

  // ── 2. 均線結構
  const { ma20, ma60 } = ind;
  if (ma20[i] !== null && ma60[i] !== null) {
    if (bar.close > ma60[i] && ma20[i] > ma60[i]) add(10, `股價站上季線（MA60 ${fmtP(ma60[i])}），月線在季線之上，中期多頭結構`, 'trend');
    else if (bar.close < ma60[i] && ma20[i] < ma60[i]) add(-10, `股價在季線（MA60 ${fmtP(ma60[i])}）之下，月線低於季線，中期空頭結構`, 'trend');
    else add(0, `股價與月線、季線糾結，中期方向未明`, 'trend');
  }

  // ── 3. RSI
  const r = ind.rsi[i];
  if (r !== null) {
    if (r < 30) add(14, `RSI ${r.toFixed(1)} 進入超賣區（< 30）`);
    else if (r < 40) add(7, `RSI ${r.toFixed(1)} 偏低`);
    else if (r > 75) add(-14, `RSI ${r.toFixed(1)} 進入超買區（> 75）`);
    else if (r > 65) add(-6, `RSI ${r.toFixed(1)} 偏高`);
  }

  // ── 4. KD
  const { k, d } = ind.kd;
  if (k[i] !== null) {
    if (crossedWithin(crossedUp, k, d, i, 3) && k[i] < 30) add(14, `KD 低檔黃金交叉（K ${k[i].toFixed(1)} / D ${d[i].toFixed(1)}）`);
    else if (crossedWithin(crossedDown, k, d, i, 3) && k[i] > 70) add(-14, `KD 高檔死亡交叉（K ${k[i].toFixed(1)} / D ${d[i].toFixed(1)}）`);
    else if (k[i] < 20) add(5, `KD 低檔（K ${k[i].toFixed(1)}），但尚未黃金交叉；低檔鈍化時不要急著抄底`);
    else if (k[i] > 80) add(-5, `KD 高檔（K ${k[i].toFixed(1)}）；強勢股可能高檔鈍化，搭配通道位置判斷`);
  }

  // ── 5. MACD
  const { dif, signal, hist } = ind.macd;
  if (hist[i] !== null && hist[i - 1] !== null) {
    if (crossedWithin(crossedUp, dif, signal, i, 3)) add(10, `MACD 黃金交叉（DIF ${dif[i].toFixed(2)} 上穿訊號線）`);
    else if (crossedWithin(crossedDown, dif, signal, i, 3)) add(-10, `MACD 死亡交叉（DIF ${dif[i].toFixed(2)} 下穿訊號線）`);
    else if (hist[i] < 0 && hist[i] > hist[i - 1]) add(5, `MACD 柱狀體負值收斂，空方力道減弱`);
    else if (hist[i] > 0 && hist[i] < hist[i - 1]) add(-5, `MACD 柱狀體正值縮小，多方力道減弱`);
  }

  // ── 6. 量價
  if (volRatio !== null) {
    const falling = bar.close < prev.close;
    if (loc.zone === 'lower' && volRatio < 0.8) add(8, `回測時量縮（${volText}），賣壓不重`, 'volume');
    else if ((loc.zone === 'lower' || loc.zone === 'breakdown') && falling && heavy) add(-10, `下跌帶量（${volText}），有人在倒貨`, 'volume');
    else if (loc.zone === 'upper' && !falling && heavy) add(4, `上攻帶量（${volText}），留意是否挑戰突破`, 'volume');
  }

  // ── 7. 布林
  const { boll } = ind;
  if (boll.lower[i] !== null) {
    if (bar.close < boll.lower[i]) add(4, `收盤跌出布林下軌（${fmtP(boll.lower[i])}），短線超跌`);
    else if (bar.close > boll.upper[i]) add(-4, `收盤突破布林上軌（${fmtP(boll.upper[i])}），短線過熱`);
  }

  // ── 8. 背離
  const div = divergence(bars, ind.rsi, i);
  if (div?.kind === 'bullish') add(12, `RSI 底背離：股價創新低，但 RSI（${div.rsi}）高於 ${div.priorDate} 的 ${div.priorRsi}，跌勢動能衰退`);
  if (div?.kind === 'bearish') add(-12, `RSI 頂背離：股價創新高，但 RSI（${div.rsi}）低於 ${div.priorDate} 的 ${div.priorRsi}，漲勢動能衰退`);

  // 通道是這套方法的主軸：沒有碰到邊緣、也沒有突破時，指標再好看也只給「觀望」
  // —— 在通道中段買進，停損遠、目標近，風險報酬比通常不划算。
  // 偏空則不設限，指標轉弱對持股者本身就是有用的警訊。
  const raw = signals.reduce((a, s) => a + s.points, 0);
  const hasSetup = loc.zone !== 'middle';
  const capped = !hasSetup && raw > BUY_FLOOR - 1;
  const score = clamp(capped ? BUY_FLOOR - 1 : raw, -100, 100);
  const verdict = VERDICTS.find((v) => score >= v.min);

  return {
    date: bar.date,
    close: bar.close,
    score,
    rawScore: raw,
    capped,
    verdict: { key: verdict.key, label: verdict.label, tone: verdict.tone },
    channel: ch,
    location: loc,
    volumeRatio: round(volRatio, 2),
    divergence: div,
    buyConfirmations: buyConfirmations(bars, ind, i),
    sellConfirmations: sellConfirmations(bars, ind, i),
    signals,
  };
}

function fmtP(n) {
  if (!isNum(n)) return '—';
  return n >= 100 ? n.toFixed(1) : n.toFixed(2);
}

// ── 交易計畫 ─────────────────────────────────────────

/**
 * 依通道給出進場、停損、目標價與風險報酬比。
 * 停損設在通道下緣再往下 1 個 ATR —— 通道線本身是「大家都看得到」的位置，
 * 停損剛好放在線上很容易被洗掉。
 */
export function tradePlan(evaluation, atrValue, { capital = 1_000_000, riskPct = 1 } = {}) {
  const { channel: ch, close, location } = evaluation;
  if (!isNum(atrValue)) return null;

  const bullishSetup = ['strong_buy', 'buy'].includes(evaluation.verdict.key);
  const stopBase = location.zone === 'breakout' ? ch.upper : ch.lower;
  const stop = Math.min(stopBase - atrValue, close - atrValue);
  const target1 = location.zone === 'breakout' ? close + (ch.upper - ch.lower) * 0.5 : Math.max(ch.mid, close + atrValue);
  const target2 = location.zone === 'breakout' ? close + (ch.upper - ch.lower) : Math.max(ch.upper, target1);
  const risk = close - stop;
  const reward = target2 - close;
  const rr = risk > 0 ? reward / risk : null;

  const riskBudget = capital * (riskPct / 100);
  const maxShares = risk > 0 ? Math.floor(riskBudget / risk / 1000) * 1000 : 0;

  const notes = [];
  if (rr !== null && rr < 1.5) notes.push(`風險報酬比只有 ${rr.toFixed(2)}，低於 1.5，勝算不夠時不值得進場`);
  if (!bullishSetup) notes.push('目前不是多方訊號，以下價位供持股者設停損／停利參考，不建議新進場');
  if (maxShares < 1000 && risk > 0) {
    const odd = Math.floor(riskBudget / risk);
    notes.push(`以 ${fmtCapital(capital)} 資金、單筆風險 ${riskPct}% 計算，停損距離太大，只能買 ${odd} 股零股`);
  }

  return {
    entry: round(close, 2),
    stop: round(stop, 2),
    stopPct: round((-risk / close) * 100, 2),
    target1: round(target1, 2),
    target2: round(target2, 2),
    target2Pct: round((reward / close) * 100, 2),
    riskReward: round(rr, 2),
    atr: round(atrValue, 2),
    sizing: { capital, riskPct, maxShares, maxLots: maxShares / 1000 },
    actionable: bullishSetup && rr !== null && rr >= 1.5,
    notes,
  };
}

const fmtCapital = (n) => (n >= 1e4 ? `${(n / 1e4).toFixed(0)} 萬` : String(n));

// ── 歷史驗證 ─────────────────────────────────────────

/** 一買一賣的來回成本：手續費 0.1425% × 2（不打折，保守估計）+ 證交稅 0.3% */
export const ROUND_TRIP_COST = 0.001425 * 2 + 0.003;

const STRATEGIES = {
  channel: {
    label: '純通道：觸下緣就買',
    entry: (ev) => ev.location.zone === 'lower' && ev.channel.trend !== 'down',
  },
  confirmed: {
    label: '通道＋指標確認（≥ 2 項）',
    entry: (ev, bars, ind, i) => ev.location.zone === 'lower' && ev.channel.trend !== 'down'
      && buyConfirmations(bars, ind, i).length >= 2,
  },
};

/**
 * 逐日回測。每一天都只用當天以前的資料重擬通道（沒有未來資料），
 * 訊號出現在收盤後，所以隔天開盤才進場。
 *
 * 出場：跌破停損（下緣 − 1 ATR）、碰到進場時的通道上緣、或持有滿 maxHold 天。
 * 停損與目標同一天都碰到時，保守地當作先停損。
 */
export function backtest(bars, { lookback = 120, maxHold = 40, tradeLimit = 12, ind = indicators(bars) } = {}) {
  const warmup = Math.max(lookback + 1, 61);
  const results = {};

  for (const [key, strat] of Object.entries(STRATEGIES)) {
    const trades = [];
    let i = warmup;
    while (i < bars.length - 1) {
      const ev = quickEval(bars, ind, i, lookback);
      if (!ev || !strat.entry(ev, bars, ind, i) || !isNum(ind.atr[i])) { i++; continue; }

      const entryIdx = i + 1;
      const entry = bars[entryIdx].open;
      const stop = Math.min(ev.channel.lower - ind.atr[i], entry - ind.atr[i]);
      const target = ev.channel.upper;
      if (!(target > entry)) { i++; continue; }

      let exitIdx = entryIdx;
      let exit = null;
      let reason = null;
      for (let j = entryIdx; j < bars.length && j <= entryIdx + maxHold; j++) {
        const b = bars[j];
        exitIdx = j;
        if (b.low <= stop) { exit = Math.min(stop, b.open); reason = '停損'; break; }
        if (b.high >= target) { exit = Math.max(target, b.open); reason = '達標'; break; }
        if (j === entryIdx + maxHold) { exit = b.close; reason = '到期'; break; }
      }
      if (exit === null) { exit = bars[exitIdx].close; reason = '持有中'; }

      const ret = exit / entry - 1 - ROUND_TRIP_COST;
      trades.push({
        entryDate: bars[entryIdx].date,
        exitDate: bars[exitIdx].date,
        entry: round(entry, 2),
        exit: round(exit, 2),
        returnPct: round(ret * 100, 2),
        days: exitIdx - entryIdx,
        reason,
      });
      i = exitIdx + 1;
    }
    results[key] = { label: strat.label, ...summarizeTrades(trades, tradeLimit) };
  }

  const first = bars[warmup]?.close;
  const last = bars[bars.length - 1]?.close;
  return {
    from: bars[warmup]?.date ?? null,
    to: bars[bars.length - 1]?.date ?? null,
    lookback,
    maxHold,
    costPct: round(ROUND_TRIP_COST * 100, 3),
    buyHoldPct: first && last ? round((last / first - 1) * 100, 2) : null,
    strategies: results,
  };
}

/** 回測用的輕量判讀：只需要通道與位置，不必產生整套文字理由 */
function quickEval(bars, ind, i, lookback) {
  const channel = fitChannel(bars, lookback, i);
  if (!channel) return null;
  return { channel, location: locate(bars[i], channel) };
}

function summarizeTrades(trades, limit) {
  const closed = trades.filter((t) => t.reason !== '持有中');
  const wins = closed.filter((t) => t.returnPct > 0);
  const compounded = trades.reduce((acc, t) => acc * (1 + t.returnPct / 100), 1);
  return {
    trades: trades.slice(-limit).reverse(),
    count: trades.length,
    closedCount: closed.length,
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    avgReturnPct: trades.length ? round(trades.reduce((a, t) => a + t.returnPct, 0) / trades.length, 2) : null,
    totalReturnPct: trades.length ? round((compounded - 1) * 100, 2) : null,
    worstPct: trades.length ? Math.min(...trades.map((t) => t.returnPct)) : null,
    bestPct: trades.length ? Math.max(...trades.map((t) => t.returnPct)) : null,
  };
}

// ── 對外：完整報告 ────────────────────────────────────

/** 多週期比較用的通道長度（約一季、半年、一年） */
const TIMEFRAMES = [60, 120, 240];

/** 圖表在通道之前再多畫幾根，看得出通道是從哪裡開始的 */
const CHART_LEAD = 30;

/**
 * 產生完整技術分析報告（API 與展示版共用）。
 * @param {Array} bars 由舊到新的日 K
 * @param {{lookback?:number, capital?:number, riskPct?:number}} opts
 */
export function report(bars, { lookback = 120, capital, riskPct } = {}) {
  const clean = (bars ?? []).filter((b) => b && [b.open, b.high, b.low, b.close].every(isNum) && b.close > 0);
  const lb = clamp(Math.round(Number(lookback) || 120), 30, 240);

  if (clean.length < lb + 2) {
    return {
      ok: false,
      reason: `歷史資料只有 ${clean.length} 根 K 線，${lb} 日通道至少需要 ${lb + 2} 根`,
      barCount: clean.length,
    };
  }

  const ind = indicators(clean);
  const i = clean.length - 1;
  const ev = evaluateAt(clean, ind, i, lb);
  const plan = tradePlan(ev, ind.atr[i], { capital, riskPct });
  const bt = backtest(clean, { lookback: lb, ind });

  const from = Math.max(0, clean.length - Math.max(lb + CHART_LEAD, 100));
  const pick = (arr) => arr.slice(from).map((v) => round(v, 2));
  const ch = ev.channel;

  // 歷史的觸碰點（在圖上標示），同樣逐日重擬通道、不偷看未來
  const markers = [];
  for (let j = Math.max(from, lb + 1); j <= i; j++) {
    const q = quickEval(clean, ind, j, lb);
    if (!q) continue;
    if (q.location.zone === 'lower' && q.channel.trend !== 'down' && buyConfirmations(clean, ind, j).length >= 2) {
      markers.push({ date: clean[j].date, kind: 'buy', price: clean[j].low });
    } else if (q.location.zone === 'upper' && sellConfirmations(clean, ind, j).length >= 2) {
      markers.push({ date: clean[j].date, kind: 'sell', price: clean[j].high });
    } else if (q.location.zone === 'breakdown' && q.channel.trend !== 'down') {
      markers.push({ date: clean[j].date, kind: 'breakdown', price: clean[j].low });
    }
  }
  // 連續幾天的同向訊號只留第一個，圖才不會糊成一片
  const thinned = markers.filter((m, idx) => {
    const prev = markers[idx - 1];
    if (!prev || prev.kind !== m.kind) return true;
    const gap = clean.findIndex((b) => b.date === m.date) - clean.findIndex((b) => b.date === prev.date);
    return gap > 5;
  });

  const channelFrom = Math.max(from, ch.start);
  const channelLine = [];
  for (let j = channelFrom; j <= i; j++) {
    const v = ch.line(j);
    channelLine.push({ date: clean[j].date, upper: round(v.upper, 2), mid: round(v.mid, 2), lower: round(v.lower, 2) });
  }

  const { line, ...channelOut } = ch;
  channelOut.upper = round(ch.upper, 2);
  channelOut.mid = round(ch.mid, 2);
  channelOut.lower = round(ch.lower, 2);
  channelOut.width = round(ch.width, 2);
  channelOut.slope = round(ch.slope, 4);
  channelOut.startDate = clean[ch.start].date;

  // 多週期：短中長三種通道各自的方向與位置，方向一致時訊號比較可靠
  const timeframes = TIMEFRAMES.map((n) => {
    const c = fitChannel(clean, n, i);
    if (!c) return { lookback: n, available: false };
    const l = locate(clean[i], c);
    return { lookback: n, available: true, trend: c.trend, label: c.label, zone: l.zone, position: l.position, r2: round(c.r2, 3) };
  });

  return {
    ok: true,
    asOf: clean[i].date,
    barCount: clean.length,
    lookback: lb,
    analysis: {
      score: ev.score,
      rawScore: ev.rawScore,
      capped: ev.capped,
      verdict: ev.verdict,
      timeframes,
      close: ev.close,
      change: round(clean[i].close - clean[i - 1].close, 2),
      changePercent: round((clean[i].close / clean[i - 1].close - 1) * 100, 2),
      channel: channelOut,
      location: ev.location,
      signals: ev.signals,
      buyConfirmations: ev.buyConfirmations,
      sellConfirmations: ev.sellConfirmations,
      divergence: ev.divergence,
      indicators: {
        ma5: round(ind.ma5[i]), ma20: round(ind.ma20[i]), ma60: round(ind.ma60[i]),
        rsi: round(ind.rsi[i], 1),
        k: round(ind.kd.k[i], 1), d: round(ind.kd.d[i], 1),
        dif: round(ind.macd.dif[i], 2), macd: round(ind.macd.signal[i], 2), osc: round(ind.macd.hist[i], 2),
        bollUpper: round(ind.boll.upper[i]), bollLower: round(ind.boll.lower[i]),
        atr: round(ind.atr[i]), volumeRatio: ev.volumeRatio,
      },
    },
    plan,
    backtest: bt,
    chart: {
      bars: clean.slice(from).map((b) => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
      ma20: pick(ind.ma20),
      ma60: pick(ind.ma60),
      rsi: pick(ind.rsi),
      k: pick(ind.kd.k),
      d: pick(ind.kd.d),
      channel: channelLine,
      markers: thinned,
    },
    disclaimer: '技術分析是根據歷史價量的機率判斷，不保證未來走勢；歷史驗證不代表未來績效。本工具不構成投資建議。',
  };
}
