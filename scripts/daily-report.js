#!/usr/bin/env node
/**
 * 每日盤後報告：產業雷達 + 持股與自選股的通道訊號，輸出成 Markdown。
 *
 *   npm run report                 # 印到畫面，並存到 reports/YYYY-MM-DD.md
 *   npm run report -- --stdout     # 只印不存
 *   npm run report -- --watchlist-file profile.json   # 用頁面同步到雲端的自選股
 *
 * 清單來自 data/watchlist.json。報告只列「有事的」標的（碰到通道邊緣、突破、
 * 跌破、營收轉折），沒事的不佔版面 —— 每天要看的是變化，不是全部。
 *
 * 這支腳本只整理數據；排程執行時，由 Claude 再補上新聞題材的解讀。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as api from '../src/api.js';
import { HISTORY } from '../src/config.js';
import { fetchJson } from '../src/http.js';
import { parseYahooChart } from '../src/sources/history.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = JSON.parse(readFileSync(path.join(ROOT, 'data/watchlist.json'), 'utf8'));
const holdings = list.holdings;
const groups = { ...list.groups };

// --watchlist-file：頁面同步到雲端的自選股（{ "watchlist": [...] }）。
// 使用者在手機或電腦上新加的、不在原本分組裡的，歸到「其他自選」；刪掉的就不再列出。
const fileArg = process.argv.indexOf('--watchlist-file');
if (fileArg !== -1) {
  try {
    const synced = JSON.parse(readFileSync(process.argv[fileArg + 1], 'utf8')).watchlist;
    if (Array.isArray(synced) && synced.length) {
      const keep = new Set(synced.map((c) => String(c).toUpperCase()));
      for (const g of Object.keys(groups)) groups[g] = groups[g].filter((c) => keep.has(c));
      const grouped = new Set([...holdings, ...Object.values(groups).flat()]);
      const extra = [...keep].filter((c) => !grouped.has(c));
      if (extra.length) groups['其他自選'] = extra;
    }
  } catch (err) {
    console.error(`⚠ 讀不到 ${process.argv[fileArg + 1]}（${err.message}），改用 data/watchlist.json`);
  }
}
const allCodes = [...new Set([...holdings, ...Object.values(groups).flat()])];

const pct = (n, d = 1) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${n.toFixed(d)}%` : '—');
const yi = (n) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${(n / 1e8).toFixed(1)} 億` : '—');
const lots = (n) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${Math.round(n / 1000).toLocaleString('zh-TW')} 張` : '—');
const price = (n) => (typeof n === 'number' ? (n >= 100 ? n.toFixed(1) : n.toFixed(2)) : '—');
const ZONE = { lower: '觸下緣', upper: '觸上緣', middle: '中段', breakout: '突破上緣', breakdown: '跌破下緣' };

const out = [];
const w = (s = '') => out.push(s);

// ── 大盤
const taipeiToday = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
let index = null;
try {
  const url = HISTORY.yahooChart.replace('{symbol}', encodeURIComponent('^TWII')).replace('range=2y', 'range=1mo');
  const { bars } = parseYahooChart(await fetchJson(url, { headers: { 'User-Agent': HISTORY.yahooUserAgent } }));
  const last = bars.at(-1);
  const prev = bars.at(-2);
  index = { date: last.date, close: last.close, change: last.close - prev.close, pct: (last.close / prev.close - 1) * 100 };
} catch (err) {
  index = { error: err.message };
}

const tradedToday = index?.date === taipeiToday;
w(`# 台股盤後報告 ${taipeiToday}`);
w();
if (index?.error) w(`> 加權指數抓取失敗：${index.error}`);
else if (!tradedToday) w(`> 今天（${taipeiToday}）沒有交易資料，可能休市；以下為最近交易日 ${index.date} 的資料。`);
if (!index?.error) w(`**加權指數** ${index.close.toLocaleString('zh-TW')}（${index.change > 0 ? '+' : ''}${index.change.toFixed(2)}，${pct(index.pct, 2)}）`);
w();

// ── 產業雷達
const radar = await api.radar({ watchlist: allCodes });

w('## 一、產業雷達：早期訊號');
w();
if (!radar.ok) {
  w(`> ${radar.reason}`);
} else {
  const strong = radar.signals.filter((s) => s.score >= 2);
  if (!radar.signals.length) w('目前沒有產業同時出現明顯的資金或題材訊號。');
  for (const s of (strong.length ? strong : radar.signals).slice(0, 6)) {
    w(`- **${s.sector}**（${s.score} 種訊號：${s.kinds.map((k) => ({ turnover: '資金', flow: '法人', theme: '題材', price: '股價' })[k]).join('、')}）`);
    for (const r of s.reasons) w(`  - ${r}`);
  }
  w();

  const rot = radar.rotation;
  if (rot?.sectors?.length) {
    const movers = rot.sectors.filter((s) => s.shareRecent >= 1 && s.relChange !== null);
    const up = [...movers].sort((a, b) => b.relChange - a.relChange).slice(0, 4);
    const down = [...movers].sort((a, b) => a.relChange - b.relChange).slice(0, 3);
    w(`### 資金輪動（${rot.from} ～ ${rot.to}，${rot.days} 個交易日，近 ${rot.recent} 日 vs 之前）`);
    w();
    w('| 類股 | 成交比重 | 相對變化 | 類股 5 日／20 日 |');
    w('|---|---|---|---|');
    for (const s of [...up, ...down]) {
      const r = radar.returns[s.name] || {};
      w(`| ${s.name} | ${s.shareEarly}% → ${s.shareRecent}% | ${pct(s.relChange)} | ${pct(r.r5)}／${pct(r.r20)} |`);
    }
    w();
  }

  const flows = radar.flows.sectors;
  if (flows.length) {
    w(`### 法人流向（上市，近 ${radar.flows.days} 日）`);
    w();
    w(`- 買超：${flows.slice(0, 4).filter((f) => f.total > 0).map((f) => `${f.name} ${yi(f.total)}`).join('、') || '—'}`);
    w(`- 賣超：${flows.slice(-4).reverse().filter((f) => f.total < 0).map((f) => `${f.name} ${yi(f.total)}`).join('、') || '—'}`);
    w();
  }

  w('### 題材熱度');
  w();
  const themes = [...radar.themes].filter((t) => t.heat).sort((a, b) => (b.heat.ratio ?? 0) - (a.heat.ratio ?? 0));
  w('| 題材 | 趨勢 | 近 7 日 | 日均（前期） |');
  w('|---|---|---|---|');
  for (const t of themes) {
    const trend = { heating: '🔺 升溫', cooling: '🔻 降溫', flat: '持平' }[t.heat.trend];
    w(`| ${t.label} | ${trend} | ${t.heat.count7} 則 | ${t.heat.perDay7}（${t.heat.perDayPrior ?? '—'}） |`);
  }
  w();
  const hikes = themes.flatMap((t) => t.heat.priceHikes.map((h) => ({ ...h, theme: t.label })));
  const seen = new Set();
  const uniqueHikes = hikes.filter((h) => (seen.has(h.title) ? false : seen.add(h.title)));
  if (uniqueHikes.length) {
    w('**漲價／缺貨相關標題（近 7 日）**');
    w();
    for (const h of uniqueHikes.slice(0, 8)) w(`- [${h.theme}] [${h.title}](${h.link})${h.source ? `（${h.source}）` : ''}`);
    w();
  }
  if (radar.notes.length) {
    w(`<sub>資料備註：${radar.notes.join('；')}</sub>`);
    w();
  }
}

// ── 個股通道訊號
const tech = new Map();
for (const code of allCodes) {
  const byLb = {};
  for (const lookback of [60, 120]) {
    try {
      byLb[lookback] = await api.technical({ code, lookback });
    } catch (err) {
      byLb[lookback] = { ok: false, reason: err.message };
    }
  }
  tech.set(code, byLb);
}
const revenueOf = new Map((radar.watchlist ?? []).map((x) => [x.code, x]));

function line(code) {
  const t = tech.get(code);
  const a60 = t[60]?.ok ? t[60] : null;
  const a120 = t[120]?.ok ? t[120] : null;
  const base = a60 || a120;
  if (!base) return { code, name: t[60]?.name || code, text: `資料不足：${t[60]?.reason || t[120]?.reason}`, notable: false };
  const a = base.analysis;
  const part = (r, lb) => (r ? `${lb} 日${r.analysis.channel.label.replace('（箱型整理）', '')}${ZONE[r.analysis.location.zone]}（${r.analysis.verdict.label}）` : null);
  const notableZone = (r) => r && r.analysis.location.zone !== 'middle';
  const rev = revenueOf.get(code)?.revenue;
  const revText = rev ? `營收 ${rev.month} 年增 ${pct(rev.yoy)}${rev.momentum === 'accelerating' ? '，加速' : rev.momentum === 'decelerating' ? '，減速' : ''}${rev.record12 ? '，創 12 月新高' : ''}` : null;
  const plan = (a60?.plan?.actionable ? a60 : a120?.plan?.actionable ? a120 : null)?.plan;
  return {
    code,
    name: base.name,
    close: a.close,
    change: a.changePercent,
    notable: notableZone(a60) || notableZone(a120) || rev?.momentum === 'decelerating',
    text: [part(a60, 60), part(a120, 120)].filter(Boolean).join('；')
      + (plan ? `。參考停損 ${price(plan.stop)}、目標 ${price(plan.target2)}、風險報酬 1:${plan.riskReward}` : '')
      + (revText ? `。${revText}` : ''),
  };
}

w('## 二、持股');
w();
for (const code of holdings) {
  const l = line(code);
  const inst = revenueOf.get(code)?.inst5;
  w(`- **${l.name} ${code}** ${price(l.close)}（${pct(l.change, 2)}）：${l.text}${inst ? `。近 5 日外資 ${lots(inst.foreign)}、投信 ${lots(inst.trust)}` : ''}`);
}
w();

w('## 三、自選股：有訊號的標的');
w();
w('只列碰到通道邊緣、突破、跌破或營收減速的標的；其餘在通道中段、沒有進出點。');
w();
for (const [group, codes] of Object.entries(groups)) {
  const lines = codes.map(line).filter((l) => l.notable);
  w(`**${group}**`);
  w();
  if (!lines.length) w('- 沒有訊號');
  for (const l of lines) w(`- ${l.name} ${l.code} ${price(l.close)}（${pct(l.change, 2)}）：${l.text}`);
  w();
}

w('---');
w('*整理公開資訊與歷史數據的機率判斷，不構成投資建議。*');

const report = out.join('\n');
console.log(report);

if (!process.argv.includes('--stdout')) {
  const dir = path.join(ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${taipeiToday}.md`);
  writeFileSync(file, report);
  console.error(`\n已存到 ${path.relative(ROOT, file)}`);
}
