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
for (const t of ['overview', 'technical', 'radar', 'news', 'recommend', 'alerts', 'settings']) {
  await tab(p, t);
  check(`分頁：${t}`, await p.$eval(`#tab-${t}`, (e) => e.classList.contains('active')));
}
await tab(p, 'overview');

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

// 技術分析操作
await p.click('#ta-picker button:nth-child(2)'); await p.waitForTimeout(600);
const taName = await visibleText(p, '#ta-body .text-lg');
check('技術分析：切換標的', taName.length > 0, taName.slice(0, 20));
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
check('總覽沒有損益數字', !/損益|持股市值/.test(await visibleText(p, '#kpi-cards')), await visibleText(p, '#kpi-cards'));
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

// 提醒
await tab(p, 'alerts');
await p.selectOption('#a-type', 'price_above');
await p.fill('#a-value', ''); await p.click('#a-add'); await p.waitForTimeout(300);
check('提醒：漏填數值時看得到提示', /請填入/.test(await visibleText(p, '#toast')) && (await p.evaluate(() => profile.rules.length)) === 0);
await p.fill('#a-value', '1'); await p.click('#a-add'); await p.waitForTimeout(500);
const rules = await p.evaluate(() => profile.rules.length);
check('提醒：新增', rules === 1);
check('提醒：觸發顯示', (await visibleText(p, '#alerts-triggered')).includes('已高於'));
await p.click('[data-toggle-rule]'); await p.waitForTimeout(400);
check('提醒：停用', await p.evaluate(() => profile.rules[0]?.enabled === false));
await p.click('[data-remove-rule]'); await p.waitForTimeout(400);
check('提醒：刪除', (await p.evaluate(() => profile.rules.length)) === 0);

// 設定
await tab(p, 'settings');
await p.fill('#s-interval', '0'); await p.dispatchEvent('#s-interval', 'change');
check('設定：更新間隔', await p.evaluate(() => profile.refreshSeconds === 0));
const dl0 = await p.evaluate(() => window.__downloads);
await p.click('#export'); await p.waitForTimeout(300);
const exportVisible = /"watchlist"/.test(await p.inputValue('#export-text').catch(() => '')) && await p.isVisible('#export-panel');
check('設定：匯出（檢視器裡看得到結果）', exportVisible, (await p.evaluate(() => window.__downloads)) > dl0 ? '只走了下載連結（檢視器擋掉）' : '');
await p.click('#export-copy'); await p.waitForTimeout(300);
check('設定：複製有回應', (await visibleText(p, '#toast')).length > 0, await visibleText(p, '#toast'));
await p.fill('#export-text', JSON.stringify({ watchlist: ['2454'] }));
await p.click('#export-apply'); await p.waitForTimeout(600);
check('設定：貼上內容套用', await p.evaluate(() => JSON.stringify(profile.watchlist) === '["2454"]') && (await watchCount(p)) === 1);
await p.click('#export'); await p.fill('#export-text', '{壞掉的 json'); await p.click('#export-apply'); await p.waitForTimeout(300);
check('設定：貼上壞掉的內容有錯誤提示', /套用失敗/.test(await visibleText(p, '#toast')));
// 匯入
const json = JSON.stringify({ watchlist: ['2330', '2317'], holdings: [], rules: [] });
await p.setInputFiles('#import', { name: 'p.json', mimeType: 'application/json', buffer: Buffer.from(json) });
await p.waitForTimeout(800);
check('設定：匯入檔案', await p.evaluate(() => JSON.stringify(profile.watchlist) === '["2330","2317"]').catch(() => false));
// 清除
await p.click('#reset'); await p.waitForTimeout(300);
check('設定：清除第一次只是確認', (await visibleText(p, '#reset')).includes('再按一次') && (await p.evaluate(() => profile.watchlist.length)) === 2);
await p.click('#reset'); await p.waitForTimeout(800);
const afterReset = await p.evaluate(() => profile.watchlist.length).catch(() => -1);
check('設定：清除全部（不靠 confirm）', afterReset === await p.evaluate(() => DEFAULT_WATCHLIST.length) && (await watchCount(p)) === afterReset, `清除後自選 ${afterReset} 檔`);
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
  await t.tap('#ta-picker button:nth-child(3)'); await t.waitForTimeout(600);
  check('手機：技術分析點選標的', (await t.$eval('#ta-body', (e) => e.innerText)).includes(await t.evaluate(() => profile.taCode)));
  await t.locator('#ta-charts svg').first().scrollIntoViewIfNeeded();
  const box = await t.locator('#ta-charts svg').first().boundingBox();
  await t.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.5); await t.waitForTimeout(400);
  check('手機：點 K 線顯示數值', await t.isVisible('#ta-tip'));
  await t.tap('#mobile-menu'); await t.waitForTimeout(200); await t.tap('[data-tab=settings]');
  await t.tap('#reset'); await t.tap('#reset'); await t.waitForTimeout(600);
  check('手機：清除全部', (await t.isVisible('#toast')) && (await t.$eval('#toast', (e) => e.innerText)).includes('已清除'));
  await ctx.close();
}

for (const [s, n, d] of results) console.log(s, n, d ? `— ${d}` : '');
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed} 通過 / ${failed} 失敗`);
await b.close();
process.exit(failed ? 1 : 0);
