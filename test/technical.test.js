import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sma, ema, rsi, kd, macd, atr, indicators,
  fitChannel, locate, evaluateAt, tradePlan, backtest, report, ROUND_TRIP_COST,
} from '../src/technical.js';
import { sampleBars } from '../src/sample-bars.js';
import { parseYahooChart, parseMonthRows } from '../src/sources/history.js';

/** 造一段規律的通道走勢：趨勢 + 正弦擺盪（週期 20 根） */
function channelBars(count, { slope = 0.3, amp = 6, base = 100, period = 20 } = {}) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = base + slope * i + amp * Math.sin((2 * Math.PI * i) / period);
    const prev = bars[i - 1]?.close ?? close;
    bars.push({
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      open: prev, high: Math.max(prev, close) + 0.5, low: Math.min(prev, close) - 0.5, close, volume: 1000,
    });
  }
  return bars;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ── 指標

test('SMA / EMA：前段資料不足為 null，數值正確', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[1], null);
  assert.equal(e[2], 2);          // 以 SMA 起算
  assert.equal(e[3], 3);          // 4*0.5 + 2*0.5
  assert.equal(e[4], 4);
});

test('RSI：一路上漲為 100、一路下跌為 0、範圍在 0～100', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(rsi(up).at(-1), 100);
  assert.equal(rsi(down).at(-1), 0);
  const mixed = rsi(channelBars(100).map((b) => b.close));
  assert.equal(mixed[13], null);
  assert.ok(mixed.slice(14).every((v) => v >= 0 && v <= 100));
});

test('KD 介於 0～100，收在區間最高時 K 往 100 靠', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({ high: 10 + i, low: 9 + i, close: 10 + i }));
  const { k, d } = kd(bars);
  assert.equal(k[7], null);
  assert.ok(k.slice(8).every((v) => v >= 0 && v <= 100));
  assert.ok(k.at(-1) > 95 && d.at(-1) > 90);
});

test('MACD：DIF = EMA12 − EMA26，柱狀體 = DIF − 訊號線', () => {
  const closes = channelBars(80).map((b) => b.close);
  const m = macd(closes);
  const i = 60;
  assert.ok(near(m.dif[i], ema(closes, 12)[i] - ema(closes, 26)[i], 1e-9));
  assert.ok(near(m.hist[i], m.dif[i] - m.signal[i], 1e-9));
  assert.equal(m.signal[20], null);
});

test('ATR 至少等於當日高低差的平均水準', () => {
  const bars = channelBars(60);
  const a = atr(bars).at(-1);
  assert.ok(a > 0.9, `ATR ${a} 應 ≥ 單日高低差 1 附近`);
});

// ── 通道

test('規律上升走勢判定為上升通道，上下緣包住價格', () => {
  const bars = channelBars(200, { slope: 0.3, amp: 6 });
  const ch = fitChannel(bars, 120);
  assert.equal(ch.trend, 'up');
  assert.ok(ch.r2 > 0.8, `R² ${ch.r2}`);
  assert.ok(near(ch.slope, 0.3, 0.05));
  // 寬度約為兩倍振幅 + 影線
  assert.ok(near(ch.upper - ch.lower, 13, 2), `寬度 ${ch.upper - ch.lower}`);
  assert.ok(ch.touches.upper >= 4 && ch.touches.lower >= 4, JSON.stringify(ch.touches));
});

test('下降與箱型走勢分類正確', () => {
  assert.equal(fitChannel(channelBars(200, { slope: -0.3, base: 200 }), 120).trend, 'down');
  assert.equal(fitChannel(channelBars(200, { slope: 0 }), 120).trend, 'range');
});

test('通道只用今天以前的資料：改掉今天的 K 線，通道不變', () => {
  const bars = channelBars(200);
  const a = fitChannel(bars, 120);
  const crashed = bars.map((b, i) => (i === bars.length - 1 ? { ...b, low: 1, close: 2 } : b));
  const b = fitChannel(crashed, 120);
  assert.equal(a.upper, b.upper);
  assert.equal(a.lower, b.lower);
});

test('locate：區分觸下緣、觸上緣、跌破、突破', () => {
  const ch = { upper: 110, lower: 90 };
  assert.equal(locate({ high: 95, low: 90.5, close: 93 }, ch).zone, 'lower');
  assert.equal(locate({ high: 109.5, low: 105, close: 108 }, ch).zone, 'upper');
  assert.equal(locate({ high: 102, low: 98, close: 100 }, ch).zone, 'middle');
  assert.equal(locate({ high: 92, low: 85, close: 88 }, ch).zone, 'breakdown');
  assert.equal(locate({ high: 115, low: 108, close: 112 }, ch).zone, 'breakout');
});

// ── 綜合判讀

/** 找出規律上升通道裡「碰下緣」的那一天 */
function firstLowerTouch(bars, ind, lookback = 120) {
  for (let i = lookback + 1; i < bars.length; i++) {
    const ev = evaluateAt(bars, ind, i, lookback);
    if (ev?.location.zone === 'lower') return ev;
  }
  return null;
}

test('上升通道碰下緣給正分，而且通道理由排在最前面', () => {
  const bars = channelBars(220);
  const ev = firstLowerTouch(bars, indicators(bars));
  assert.ok(ev, '應該找得到碰下緣的日子');
  const channelSignal = ev.signals.find((s) => s.kind === 'channel');
  assert.ok(channelSignal.points >= 30, channelSignal.text);
  assert.match(channelSignal.text, /上升通道下緣/);
  assert.ok(ev.score > 0);
});

test('帶量跌破上升通道給大幅負分，不會被當成回測買點', () => {
  const bars = channelBars(200);
  const last = bars.at(-1);
  bars.push({ date: '2099-01-01', open: last.close, high: last.close, low: last.close - 30, close: last.close - 28, volume: 5000 });
  const ind = indicators(bars);
  const ev = evaluateAt(bars, ind, bars.length - 1, 120);
  assert.equal(ev.location.zone, 'breakdown');
  const channelSignal = ev.signals.find((s) => s.kind === 'channel');
  assert.ok(channelSignal.points <= -40, `${channelSignal.points} ${channelSignal.text}`);
  assert.match(channelSignal.text, /帶量/);
  assert.ok(['reduce', 'sell'].includes(ev.verdict.key));
});

test('通道中段時指標再好也只給觀望（不在中段追價）', () => {
  const bars = channelBars(220);
  const ind = indicators(bars);
  for (let i = 125; i < bars.length; i++) {
    const ev = evaluateAt(bars, ind, i, 120);
    if (ev.location.zone === 'middle') {
      assert.ok(!['buy', 'strong_buy'].includes(ev.verdict.key), `${ev.date} 在中段卻給 ${ev.verdict.label}`);
      if (ev.rawScore >= 18) assert.equal(ev.capped, true);
    }
  }
});

test('交易計畫：停損在下緣之下、目標在上緣，部位大小依風險反推', () => {
  const bars = channelBars(220);
  const ind = indicators(bars);
  const ev = firstLowerTouch(bars, ind);
  const i = bars.findIndex((b) => b.date === ev.date);
  const plan = tradePlan(ev, ind.atr[i], { capital: 1_000_000, riskPct: 2 });
  assert.ok(plan.stop < ev.channel.lower);
  assert.ok(near(plan.target2, ev.channel.upper, 0.01));
  assert.ok(plan.riskReward > 0);
  // 虧損上限 2 萬 ÷ 每股停損距離，無條件捨去到整張
  const perShare = plan.entry - plan.stop;
  assert.equal(plan.sizing.maxShares, Math.floor(20000 / perShare / 1000) * 1000);
});

// ── 歷史驗證

test('回測：隔天開盤進場、扣除交易成本、結果確定', () => {
  const bars = channelBars(400);
  const a = backtest(bars, { lookback: 120 });
  const b = backtest(bars, { lookback: 120 });
  assert.deepEqual(a, b, '同樣輸入應得到同樣結果');

  const pure = a.strategies.channel;
  assert.ok(pure.count > 3, `規律通道應該有多筆交易，實際 ${pure.count}`);
  // 規律的上升通道裡，碰下緣買、碰上緣賣應該大多賺錢
  assert.ok(pure.winRate >= 70, `勝率 ${pure.winRate}`);
  for (const t of pure.trades) {
    const entryBar = bars.find((x) => x.date === t.entryDate);
    assert.equal(t.entry, Math.round(entryBar.open * 100) / 100, '應以進場日開盤價成交');
    const gross = t.exit / t.entry - 1;
    assert.ok(near(t.returnPct / 100, gross - ROUND_TRIP_COST, 0.0002), '報酬要扣掉來回成本');
  }
});

test('回測沒有未來資料：只改最後一段的 K 線，之前的交易完全不變', () => {
  const bars = channelBars(400);
  const opts = { lookback: 120, tradeLimit: Infinity };
  const base = backtest(bars.slice(0, 330), opts).strategies.channel.trades;
  const full = backtest(bars, opts).strategies.channel.trades;
  const cutoff = bars[300].date;
  const early = (list) => list.filter((t) => t.exitDate < cutoff && t.reason !== '持有中');
  assert.ok(early(full).length >= 3, '要有足夠的交易才有比較意義');
  assert.deepEqual(
    early(full).map((t) => [t.entryDate, t.exitDate, t.returnPct]),
    early(base).map((t) => [t.entryDate, t.exitDate, t.returnPct]),
  );
});

// ── 完整報告

test('報告：K 線不足時明確回報，而不是回傳假結論', () => {
  const r = report(channelBars(50), { lookback: 120 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /50 根/);
});

test('報告：髒資料（null、0）會被濾掉，欄位齊全', () => {
  const bars = channelBars(300);
  bars.splice(100, 0, { date: 'x', open: null, high: null, low: null, close: null, volume: 0 });
  bars.push({ date: 'y', open: 0, high: 0, low: 0, close: 0, volume: 0 });
  const r = report(bars, { lookback: 120 });
  assert.equal(r.ok, true);
  assert.equal(r.barCount, 300);
  assert.ok(r.analysis.verdict.label);
  assert.equal(r.analysis.timeframes.length, 3);
  assert.equal(r.chart.bars.length, r.chart.ma20.length);
  assert.ok(r.chart.channel.length > 0 && r.chart.channel.length <= 121);
  assert.equal(typeof r.analysis.channel.line, 'undefined', '函式不該出現在 JSON 回應裡');
});

test('通道長度會被限制在 30～240', () => {
  const bars = channelBars(400);
  assert.equal(report(bars, { lookback: 5 }).lookback, 30);
  assert.equal(report(bars, { lookback: 9999 }).lookback, 240);
});

// ── 模擬資料與來源解析

test('模擬 K 線：同代號結果相同、最後收盤對齊、K 線合理', () => {
  const a = sampleBars('2330', { close: 1085, endDate: '2026-09-18' });
  const b = sampleBars('2330', { close: 1085, endDate: '2026-09-18' });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.map((x) => x.close), sampleBars('2317', { close: 1085, endDate: '2026-09-18' }).map((x) => x.close));
  assert.equal(a.at(-1).close, 1085);
  assert.equal(a.at(-1).date, '2026-09-18');
  assert.ok(a.every((x) => x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close) && x.low > 0));
  assert.equal(report(a).ok, true);
});

test('Yahoo 解析：盤中未完成（null）的 K 線被捨棄，日期用台北時間', () => {
  const payload = {
    chart: { result: [{
      meta: { shortName: 'TSMC' },
      // 台北時間 09:00 = 當天 01:00 UTC
      timestamp: [Date.UTC(2026, 8, 21, 1) / 1000, Date.UTC(2026, 8, 22, 1) / 1000],
      indicators: { quote: [{ open: [10, 11], high: [12, null], low: [9, null], close: [11, null], volume: [100, null] }] },
    }] },
  };
  const { bars, name } = parseYahooChart(payload);
  assert.equal(name, 'TSMC');
  assert.equal(bars.length, 1);
  assert.equal(bars[0].date, '2026-09-21');
});

test('Yahoo 解析：只缺收盤的最新一根，用同一天的 meta.regularMarketPrice 補上', () => {
  const t = Date.UTC(2026, 8, 23, 1) / 1000;
  const payload = {
    chart: { result: [{
      meta: { regularMarketTime: t + 16200, regularMarketPrice: 2500, regularMarketDayHigh: 2505, regularMarketDayLow: 2475 },
      timestamp: [t],
      indicators: { quote: [{ open: [2475], high: [2505], low: [2475], close: [null], volume: [21978873] }] },
    }] },
  };
  const { bars } = parseYahooChart(payload);
  assert.deepEqual(bars, [{ date: '2026-09-23', open: 2475, high: 2505, low: 2475, close: 2500, volume: 21978873 }]);

  // meta 是別天的價格就不能拿來補
  payload.chart.result[0].meta.regularMarketTime = t + 86400;
  assert.equal(parseYahooChart(payload).bars.length, 0);
});

test('交易所月資料解析：民國日期、千分位、櫃買成交量換算成股', () => {
  const rows = [
    ['115/09/01', '12,770', '12,430,205', '908.00', '998.00', '908.00', '994.00', '82.00', '31,831'],
    ['115/09/02', '0', '0', '--', '--', '--', '--', '0.00', '0'],
  ];
  const bars = parseMonthRows(rows, 1000);
  assert.equal(bars.length, 1, '無成交的日子要略過');
  assert.deepEqual(bars[0], { date: '2026-09-01', open: 908, high: 998, low: 908, close: 994, volume: 12_770_000 });
});
