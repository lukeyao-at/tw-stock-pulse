#!/usr/bin/env node
/**
 * 展示版的端對端測試：模擬嵌入式預覽（Claude artifact 檢視器）的限制 ——
 * alert／confirm／prompt 不會出現、confirm 永遠回「取消」、下載連結無效 ——
 * 然後逐一操作每個分頁的每個控制項，含手機觸控。
 *
 *   npm run build:demo && npm run test:e2e
 *
 * 需要 playwright（不是專案依賴，避免 npm install 變重）：
 *   npm i --no-save playwright   （有現成 Chromium 時可設 CHROMIUM_PATH）
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('需要 playwright：npm i --no-save playwright');
  process.exit(2);
}
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || path.join(ROOT, 'demo/index.html');
const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const b = await chromium.launch({ executablePath });
const results = [];
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); };

async function fresh(width = 1280) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(() => {
    window.__dialogs = [];
    window.alert = (m) => { window.__dialogs.push(['alert', m]); };
    window.confirm = (m) => { window.__dialogs.push(['confirm', m]); return false; };
    window.prompt = () => null;
    window.open = () => null;
    window.__downloads = 0;
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute('download')) { window.__downloads++; return; } return orig.call(this); };
  });
  const p = await ctx.newPage();
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await p.goto('file://' + file);
  await p.waitForFunction(() => document.querySelectorAll('#watch-table tbody tr').length > 0);
  return p;
}
const tab = (p, t) => p.click(`[data-tab=${t}]`);
const watchCount = (p) => p.$$eval('#watch-table tbody tr', (r) => r.length);
const visibleText = (p, sel) => p.$eval(sel, (e) => e.innerText).catch(() => '');

const p = await fresh();

// 導覽
for (const t of ['overview', 'technical', 'radar', 'news', 'recommend']) {
  await tab(p, t);
  check(`分頁：${t}`, await p.$eval(`#tab-${t}`, (e) => e.classList.contains('active')));
}
await tab(p, 'overview');
check('沒有提醒與設定分頁', !(await p.$('[data-tab=alerts], [data-tab=settings], #tab-alerts, #tab-settings')));

// 總覽：市場狀況（加權指數、漲跌家數、產業、法人）→ 持股卡 → 自選股表
await p.waitForTimeout(600);
check('總覽依序是市場狀況、持股、自選股',
  (await p.$$eval('#tab-overview > div > h2', (h) => h.map((e) => e.textContent.trim()))).join('|') === '市場狀況|持股|自選股');
check('總覽：加權指數走勢圖', await p.isVisible('#ov-index-chart svg path'));
check('總覽：漲跌家數', /上漲[\s\S]*下跌/.test(await visibleText(p, '#ov-breadth')));
check('總覽：產業今日漲跌', (await p.$$eval('#ov-sectors li', (l) => l.length)) > 0);
check('總覽：法人買賣超', (await p.$$eval('#ov-flows li', (l) => l.length)) > 0, await visibleText(p, '#ov-flows'));
check('總覽：持股卡有走勢圖', (await p.$$eval('#holding-cards [data-mini] svg', (s) => s.length)) === (await p.$$eval('#holding-cards [data-holding-card]', (c) => c.length)));
check('總覽：自選股列有走勢與通道位置', (await p.$$eval('#watch-table tbody tr svg', (s) => s.length)) > 0
  && /通道|下緣|中段|上緣/.test(await visibleText(p, '#watch-table')));
await p.hover('#ov-index-chart .lc-hit', { position: { x: 120, y: 60 } }); await p.waitForTimeout(150);
check('總覽：滑過指數圖顯示數值', await p.isVisible('#ov-index-chart .lc-tip'));

// 自選股排序：判讀（偏多在前），再按一次反過來
const rowCodes = () => p.$$eval('#watch-table tbody tr [data-ta-open]', (b) => b.map((x) => x.dataset.taOpen));
const listOrder = await rowCodes();
await p.click('[data-watch-sort=verdict]'); await p.waitForTimeout(200);
const byVerdict = await rowCodes();
const scores = await p.evaluate((codes) => codes.map((c) => latest.watchlist.find((w) => w.code === c)?.ta?.score ?? null), byVerdict);
const known = scores.filter((v) => v !== null);
check('自選股依判讀排序（偏多在前）', known.every((v, i) => i === 0 || known[i - 1] >= v) && scores.indexOf(null) === -1 || scores.slice(scores.indexOf(null)).every((v) => v === null), JSON.stringify(scores));
await p.click('[data-watch-sort=verdict]'); await p.waitForTimeout(200);
const rev = await p.evaluate((codes) => codes.map((c) => latest.watchlist.find((w) => w.code === c)?.ta?.score ?? null).filter((v) => v !== null), await rowCodes());
check('再按一次判讀排序會反轉', rev.every((v, i) => i === 0 || rev[i - 1] <= v), JSON.stringify(rev));
await p.click('[data-watch-sort=list]'); await p.waitForTimeout(200);
check('回到清單順序', JSON.stringify(await rowCodes()) === JSON.stringify(listOrder));

// 產業今日漲跌、法人買賣超：點產業看個股
await p.click('#ov-sectors [data-ov-expand]'); await p.waitForTimeout(400);
const sectorStocks = await p.$$eval('#ov-sectors li li', (l) => l.length);
check('產業今日漲跌：點開看個股', sectorStocks > 0 && (await p.$eval('#ov-sectors [data-ov-expand]', (b) => b.getAttribute('aria-expanded'))) === 'true', `${sectorStocks} 檔`);
const addBtn = await p.$('#ov-sectors li li [data-add-watch]');
if (addBtn) {
  const nw = await p.evaluate(() => profile.watchlist.length);
  await addBtn.click(); await p.waitForTimeout(500);
  check('產業個股可加入自選', (await p.evaluate(() => profile.watchlist.length)) === nw + 1);
  await p.evaluate(() => { profile.watchlist.pop(); saveLocal(); }); await p.click('#refresh'); await p.waitForTimeout(500);
}
await p.click('#ov-sectors [data-ov-expand][aria-expanded=true]'); await p.waitForTimeout(200);
check('產業今日漲跌：再點一次收起', (await p.$$eval('#ov-sectors li li', (l) => l.length)) === 0);
await p.click('#ov-flows [data-ov-expand]'); await p.waitForTimeout(300);
check('法人買賣超：點開看個股', /買超前|賣超前/.test(await visibleText(p, '#ov-flows')) && (await p.$$eval('#ov-flows li li', (l) => l.length)) > 0, (await visibleText(p, '#ov-flows')).slice(0, 80));

// 側欄收合：只剩圖示，圖跟著新寬度重畫；再按一次展開
const asideW = () => p.$eval('aside', (a) => a.getBoundingClientRect().width);
const chartW0 = await p.$eval('#ov-index-chart svg', (s) => s.getBoundingClientRect().width);
await p.click('#sidebar-toggle'); await p.waitForTimeout(300);
const collapsedW = await asideW();
const chartW1 = await p.$eval('#ov-index-chart svg', (s) => s.getBoundingClientRect().width);
check('側欄收合', collapsedW < 80 && !(await p.isVisible('[data-tab=overview] .side-label')) && chartW1 > chartW0, `側欄 ${collapsedW}px、指數圖 ${chartW0} → ${chartW1}px`);
await p.click('#sidebar-toggle'); await p.waitForTimeout(300);
check('側欄展開', (await asideW()) > 200 && await p.isVisible('[data-tab=overview] .side-label'));

// 主題
const th0 = await p.evaluate(() => document.documentElement.dataset.theme || 'system');
await p.click('#theme-toggle');
const th1 = await p.evaluate(() => document.documentElement.dataset.theme || 'system');
check('主題切換', th0 !== th1, `${th0} → ${th1}`);

// 更新
await p.click('#refresh'); await p.waitForTimeout(300);
check('更新按鈕', /更新於|資料至/.test(await visibleText(p, '#updated')));

// 搜尋加入
const n0 = await watchCount(p);
await p.fill('#search', '2603'); await p.waitForTimeout(500);
const hasResult = await p.isVisible('#search-results [data-add-watch]');
if (hasResult) { await p.click('#search-results [data-add-watch]'); await p.waitForTimeout(400); }
check('搜尋並加入自選', hasResult && (await watchCount(p)) === n0 + 1, `${n0} → ${await watchCount(p)}`);

// 移除自選
await p.click('#watch-table [data-remove-watch]'); await p.waitForTimeout(400);
check('移除自選', (await watchCount(p)) === n0, `→ ${await watchCount(p)}`);

// 從自選跳技術分析
await p.click('#watch-table [data-ta-open]'); await p.waitForTimeout(800);
check('自選 → 技術分析', await p.$eval('#tab-technical', (e) => e.classList.contains('active')) && await p.isVisible('#ta-charts svg'));
check('K 線圖圖例有箱型', (await visibleText(p, '#ta-body')).includes('箱型（整理中）'));
let boxesSeen = 0;
for (const k of [1, 2, 3]) {
  await p.selectOption('#ta-select', { index: k - 1 }); await p.waitForTimeout(500);
  boxesSeen += await p.$$eval('#ta-charts svg[data-panel=price] g title', (t) => t.filter((e) => e.textContent.startsWith('箱型')).length);
}
check('K 線圖上畫得出箱型', boxesSeen > 0, `前 3 檔共 ${boxesSeen} 個箱型`);
const sized = await p.$eval('#ta-charts svg[data-panel=price]', (s) => ({ vb: s.viewBox.baseVal.width, px: s.getBoundingClientRect().width, h: s.getBoundingClientRect().height }));
check('K 線圖依實際寬度畫、夠大', Math.abs(sized.vb - sized.px) < 2 && sized.h >= 440, JSON.stringify(sized));
// 每根 K 線一條影線（箱型的方框也是 rect，所以不數 rect）
const bars6m = await p.$$eval('#ta-charts svg[data-panel=price] line[stroke-width="1.25"]', (r) => r.length);
await p.click('[data-ta-bars="60"]'); await p.waitForTimeout(400);
const bars3m = await p.$$eval('#ta-charts svg[data-panel=price] line[stroke-width="1.25"]', (r) => r.length);
check('K 線圖切換顯示區間', bars3m === 60 && bars6m > bars3m, `${bars6m} → ${bars3m} 根`);

// 技術分析操作
await p.selectOption('#ta-select', { index: 1 }); await p.waitForTimeout(600);
const taName = await visibleText(p, '#ta-body .text-lg');
check('技術分析：切換標的', taName.length > 0, taName.slice(0, 20));
check('技術分析：標的是下拉選單（持股、自選股分組）', (await p.$$eval('#ta-select optgroup', (g) => g.map((x) => x.label))).join('|') === '持股|自選股'
  && (await p.$$('#ta-picker button')).length === 0);
await p.click('[data-ta-lookback="60"]'); await p.waitForTimeout(600);
check('技術分析：切換通道長度', (await visibleText(p, '#ta-body')).includes('60 日'));
await p.fill('#ta-code', '2330'); await p.click('#ta-go'); await p.waitForTimeout(600);
check('技術分析：輸入代號分析', (await visibleText(p, '#ta-body .text-lg')).includes('2330'));
const lots0 = await visibleText(p, '#ta-body');
await p.fill('#ta-capital', '50000000'); await p.dispatchEvent('#ta-capital', 'change'); await p.waitForTimeout(700);
check('技術分析：改資金重算張數', (await visibleText(p, '#ta-body')) !== lots0);
await p.fill('#ta-code', '9999'); await p.click('#ta-go'); await p.waitForTimeout(500);
check('技術分析：查無代號有提示', (await visibleText(p, '#ta-body')).includes('9999'));

// 產業雷達
await tab(p, 'radar'); await p.waitForTimeout(800);
check('產業雷達載入', (await visibleText(p, '#radar-body')).includes('早期訊號'));
await p.click('#radar-refresh'); await p.waitForTimeout(800);
check('產業雷達重新整理', (await visibleText(p, '#radar-body')).includes('早期訊號'));
// 法人流向：產業／買超個股／賣超個股切換（展示版的雷達快照若沒有個股資料，就只驗證切換本身）
await p.click('[data-flow-view=buy]'); await p.waitForTimeout(300);
const hasStocks = await p.evaluate(() => Boolean(radarLatest?.flows?.stocks?.buys?.length));
check('法人流向：切到買超個股', await p.evaluate(() => profile.flowView === 'buy')
  && (!hasStocks || (await p.$$('#radar-body ol li')).length > 0));
if (hasStocks) {
  const before = await p.evaluate(() => profile.watchlist.length);
  const addBtn = await p.$('#radar-body ol [data-add-watch]');
  if (addBtn) {
    await addBtn.click(); await p.waitForTimeout(500);
    check('法人流向：從排行加入自選', (await p.evaluate(() => profile.watchlist.length)) === before + 1);
  }
}
await p.click('[data-flow-view=sell]'); await p.waitForTimeout(300);
check('法人流向：切到賣超個股', await p.evaluate(() => profile.flowView === 'sell'));
await p.click('[data-flow-view=sector]'); await p.waitForTimeout(300);

// 策略分析工具不該出現任何損益欄位
check('沒有持股損益分頁', !(await p.$('#tab-holdings')) && !(await p.$('[data-tab=holdings]')));
await tab(p, 'overview');
const overviewText = await visibleText(p, '#tab-overview');
check('總覽沒有損益數字', !/損益|持股市值/.test(overviewText), overviewText.slice(0, 60));

// 持股：自選股點錢包圖示移到持股，再點一次移回
const holdingCount = () => p.$$eval('#holding-cards [data-holding-card]', (r) => r.length);
const h0 = await holdingCount();
const w0n = await watchCount(p);
await p.click('#watch-table [data-toggle-holding]'); await p.waitForTimeout(300);
check('自選股設為持股', (await holdingCount()) === h0 + 1 && (await watchCount(p)) === w0n - 1,
  `持股 ${h0} → ${await holdingCount()}、自選 ${w0n} → ${await watchCount(p)}`);
await p.click('#holding-cards [data-holding-card]:last-child [data-toggle-holding]'); await p.waitForTimeout(300);
check('持股移回自選股', (await holdingCount()) === h0 && (await watchCount(p)) === w0n);
check('持股設定會存起來', await p.evaluate(() => Array.isArray(profile.holdings)));
check('設定沒有手續費選項', !(await p.$('#s-fees')) && !(await p.$('#s-discount')));

// 推薦
await tab(p, 'recommend');
const w0 = await visibleText(p, '#weights');
await p.click('[data-risk=aggressive]'); await p.waitForTimeout(400);
check('推薦：風險偏好', (await visibleText(p, '#weights')) !== w0);
const w1 = await visibleText(p, '#weights');
await p.click('[data-goal=growth]'); await p.waitForTimeout(400);
check('推薦：投資目標', (await visibleText(p, '#weights')) !== w1);
const n1 = await p.evaluate(() => profile.watchlist.length);
await p.click('#recommend-list [data-add-watch]'); await p.waitForTimeout(400);
check('推薦：加入自選', (await p.evaluate(() => profile.watchlist.length)) === n1 + 1);

// 新聞
await tab(p, 'news');
const nf = await p.$$eval('#news-filters [data-news-filter]', (x) => x.map((e) => e.dataset.newsFilter));
let filterOk = nf.length > 0;
for (const f of nf) {
  await p.click(`#news-filters [data-news-filter="${f}"]`); await p.waitForTimeout(150);
  filterOk = filterOk && await p.evaluate((f) => profile.newsFilter === f, f);
}
check('新聞：篩選按鈕', filterOk, `${nf.length} 個`);

check('沒有呼叫任何 alert/confirm', (await p.evaluate(() => window.__dialogs.length)) === 0, JSON.stringify(await p.evaluate(() => window.__dialogs)));
check('沒有 JS 錯誤', p.errs.length === 0, p.errs.join(' | '));

// 手機選單
const m = await fresh(390);
await m.click('#mobile-menu'); await m.waitForTimeout(200);
const opened = await m.isVisible('aside');
await m.click('[data-tab=radar]'); await m.waitForTimeout(300);
check('手機選單開關與切換分頁', opened && !(await m.isVisible('aside')) && await m.$eval('#tab-radar', (e) => e.classList.contains('active')));
await m.click('#mobile-menu'); await m.waitForTimeout(200); await m.mouse.click(380, 400); await m.waitForTimeout(200);
check('手機選單點背景關閉', !(await m.isVisible('aside')));

// 手機觸控：用 tap 而不是滑鼠 click
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const t = await ctx.newPage();
  await t.goto('file://' + file);
  await t.waitForFunction(() => document.querySelectorAll('#watch-table tbody tr').length > 0);
  const before = await t.$$eval('#watch-table tbody tr', (r) => r.length);
  await t.tap('#search'); await t.keyboard.type('2603'); await t.waitForTimeout(500);
  await t.tap('#search-results [data-add-watch]'); await t.waitForTimeout(500);
  check('手機：點搜尋結果加入自選', (await t.$$eval('#watch-table tbody tr', (r) => r.length)) === before + 1);
  await t.tap('#mobile-menu'); await t.waitForTimeout(200); await t.tap('[data-tab=technical]'); await t.waitForTimeout(800);
  await t.selectOption('#ta-select', { index: 2 }); await t.waitForTimeout(600);
  check('手機：技術分析點選標的', (await t.$eval('#ta-body', (e) => e.innerText)).includes(await t.evaluate(() => profile.taCode)));
  await t.locator('#ta-charts svg').first().scrollIntoViewIfNeeded();
  const box = await t.locator('#ta-charts svg').first().boundingBox();
  await t.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.5); await t.waitForTimeout(400);
  check('手機：點 K 線顯示數值', await t.isVisible('#ta-tip'));
  await ctx.close();
}

for (const [s, n, d] of results) console.log(s, n, d ? `— ${d}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} 通過 / ${failed} 失敗`);
await b.close();
process.exit(failed ? 1 : 0);
