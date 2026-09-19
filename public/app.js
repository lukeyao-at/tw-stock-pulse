/* 台股脈動 — 前端邏輯
 *
 * 設計要點：
 *  - 個人化設定全部存 localStorage，每次查詢隨請求送出。後端零狀態。
 *  - 只有一支主要 API（POST /api/dashboard），畫面所有區塊都由它的
 *    回應渲染，避免多支端點之間的資料不一致。
 *  - 台股慣例紅漲綠跌，與歐美相反，全站配色一致遵守。
 */

const STORAGE_KEY = 'tw-stock-pulse/profile/v1';

const DEFAULT_PROFILE = {
  watchlist: ['2330', '2317', '2454', '2881', '2603'],
  holdings: [],
  rules: [],
  risk: 'balanced',
  goals: ['dividend'],
  includeFees: true,
  feeDiscount: 0.6,
  refreshSeconds: 60,
  newsFilter: 'all',
  theme: 'system',
};

/**
 * 主題三段循環：跟隨系統 → 深色 → 淺色。
 *
 * 「跟隨系統」不在 root 上留任何標記，交給 CSS 的 prefers-color-scheme
 * 決定；選了明確的深或淺才寫 data-theme，讓它蓋過系統設定。
 */
const THEMES = [
  ['system', '跟隨系統', 'auto'],
  ['dark', '深色', 'moon'],
  ['light', '淺色', 'sun'],
];

const RISKS = [
  ['conservative', '保守', '重視股利與流動性'],
  ['balanced', '穩健', '兼顧價值與動能'],
  ['aggressive', '積極', '重視短線動能'],
];

const GOALS = [
  ['dividend', '存股領息'],
  ['value', '價值低估'],
  ['growth', '成長動能'],
];

const RULE_TYPES = {
  price_above: { label: '股價高於', unit: '元', needsValue: true },
  price_below: { label: '股價低於', unit: '元', needsValue: true },
  pct_above: { label: '單日漲幅超過', unit: '%', needsValue: true },
  pct_below: { label: '單日跌幅超過', unit: '%', needsValue: true },
  volume_spike: { label: '成交量放大倍數超過', unit: '倍', needsValue: true },
  news_bullish: { label: '出現利多新聞', unit: '', needsValue: false },
  news_bearish: { label: '出現利空新聞', unit: '', needsValue: false },
  event_upcoming: { label: '天內有除權息或法說會', unit: '天', needsValue: true },
};

const TABS = [
  ['overview', '總覽', 'gauge'],
  ['holdings', '持股損益', 'wallet'],
  ['news', '個人化新聞', 'newspaper'],
  ['recommend', '推薦標的', 'lightbulb'],
  ['ai-report', 'AI 市場報告', 'chart-pie'],
  ['alerts', '提醒', 'bell'],
  ['settings', '設定', 'gear'],
];

const FACTOR_LABELS = {
  dividend: '股利', value: '價值', momentum: '動能',
  liquidity: '流動性', diversify: '分散度',
};

// ── 狀態 ─────────────────────────────────────────────

function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PROFILE };
    // 合併預設值，讓舊版存檔在新增欄位後仍可用
    return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

let profile = loadProfile();
let latest = null;
let refreshTimer = null;
let inFlight = false;

/** AI 市場報告的狀態機：idle → in_progress → completed / failed */
let aiReportState = { status: 'idle' };
let aiReportPollTimer = null;
const AI_REPORT_POLL_MS = 10000; // 跟 Gemini 官方文件建議的輪詢間隔一致

function saveProfile() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.warn('無法寫入 localStorage：', err.message);
  }
}

// ── 小工具 ───────────────────────────────────────────

/**
 * 套用主題。
 *
 * 「跟隨系統」刻意不在 root 上留任何標記，讓 CSS 的 prefers-color-scheme
 * 決定；只有明確選深或淺才寫 data-theme，蓋過系統設定。
 */
function applyTheme(mode) {
  const [, label, icon] = THEMES.find(([key]) => key === mode) || THEMES[0];

  if (mode === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;

  const use = document.getElementById('theme-icon');
  if (use) use.setAttribute('href', `#i-${icon}`);

  const button = document.getElementById('theme-toggle');
  if (button) button.title = `主題：${label}（點擊切換）`;
}

const $ = (id) => document.getElementById(id);

/** 一律escape，新聞標題與公司名稱都來自外部來源 */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = (n, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';

const fmtInt = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('zh-TW') : '—';

/** 金額轉「億／萬」，台股習慣的讀法 */
function fmtMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)} 億`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)} 萬`;
  return fmtInt(n);
}

/** 紅漲綠跌 */
const trendClass = (n) =>
  typeof n !== 'number' || !Number.isFinite(n) || n === 0
    ? 'text-muted'
    : n > 0 ? 'text-up' : 'text-down';

const signed = (n, digits = 2) =>
  typeof n === 'number' && Number.isFinite(n) ? `${n > 0 ? '+' : ''}${fmt(n, digits)}` : '—';

const timeAgo = (iso) => {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.round(hours / 24)} 天前`;
};

const SENTIMENT_STYLE = {
  利多: 'bg-up-bg text-up border-up-line',
  利空: 'bg-down-bg text-down border-down-line',
  中性: 'bg-raised text-muted border-line',
};

function emptyState(text, icon = 'inbox') {
  return `<div class="py-8 text-center text-faint text-sm">
    <svg class="w-7 h-7 mb-2 mx-auto block opacity-50" aria-hidden="true"><use href="#i-${icon}"/></svg>${esc(text)}</div>`;
}

// ── 資料取得 ─────────────────────────────────────────

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  $('refresh').classList.add('opacity-60', 'pointer-events-none');

  try {
    const res = await fetch('/api/dashboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        watchlist: profile.watchlist,
        holdings: profile.holdings,
        rules: profile.rules,
        risk: profile.risk,
        goals: profile.goals,
        includeFees: profile.includeFees,
        feeDiscount: profile.feeDiscount,
      }),
    });
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`);

    latest = await res.json();
    renderAll();
  } catch (err) {
    showBanner('error', `更新失敗：${err.message}`);
  } finally {
    inFlight = false;
    $('refresh').classList.remove('opacity-60', 'pointer-events-none');
  }
}

function showBanner(kind, message, notes = []) {
  const styles = {
    error: 'bg-danger-bg border-danger-line text-danger',
    warn: 'bg-warn-bg border-warn-line text-warn',
  };
  $('banner').innerHTML = `
    <div class="rounded-lg border px-4 py-3 text-sm ${styles[kind] || styles.warn}">
      <div class="font-medium"><svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1.5" aria-hidden="true"><use href="#i-warning"/></svg>${esc(message)}</div>
      ${notes.length ? `<ul class="mt-1.5 space-y-0.5 text-xs opacity-90 list-disc list-inside">
        ${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>`;
  $('banner').classList.remove('hidden');
}

// ── 渲染 ─────────────────────────────────────────────

function renderAll() {
  if (!latest) return;

  const d = latest.diagnostics;
  if (d.offline) {
    showBanner('warn', '離線模式：畫面上的數字來自內建樣本資料，非真實行情', d.notes);
  } else if (d.degraded) {
    showBanner('warn', '部分資料來源暫時失效，畫面上的數字可能不完整或稍舊', [...d.notes, ...d.sourceErrors]);
  } else {
    $('banner').classList.add('hidden');
  }

  $('updated').textContent = `更新於 ${new Date(latest.updatedAt).toLocaleTimeString('zh-TW')}`;
  $('side-status').innerHTML = d.offline
    ? '<span class="text-amber-400">離線樣本資料</span>'
    : d.degraded
      ? '<span class="text-amber-400">部分來源異常</span>'
      : '<span class="text-emerald-400">資料正常</span>';

  renderOverview();
  renderHoldings();
  renderNews();
  renderRecommend();
  renderAiReport();
  renderAlerts();
  renderDiagnostics();
}

function renderOverview() {
  const { portfolio: pf, alerts, events, market, news } = latest;

  const cards = [
    { label: '持股市值', value: fmtMoney(pf.summary.totalValue), sub: `${pf.summary.positionCount} 檔`, icon: 'wallet' },
    {
      label: '未實現損益',
      value: fmtMoney(pf.summary.totalProfit),
      sub: pf.summary.totalProfitPercent !== null ? `${signed(pf.summary.totalProfitPercent)}%` : '—',
      icon: 'trend-up',
      trend: pf.summary.totalProfit,
    },
    { label: '觸發中的提醒', value: fmtInt(alerts.triggered.length), sub: `共 ${profile.rules.length} 條規則`, icon: 'bell' },
    { label: '自選股新聞氛圍', value: news.mood.mood, sub: `利多 ${news.mood.counts.利多} / 利空 ${news.mood.counts.利空}`, icon: 'newspaper' },
  ];

  $('kpi-cards').innerHTML = cards.map((c) => `
    <div class="bg-surface rounded-xl border border-line p-4">
      <div class="flex items-start justify-between">
        <span class="text-xs text-muted">${esc(c.label)}</span>
        <svg class="w-4 h-4 text-dim shrink-0" aria-hidden="true"><use href="#i-${c.icon}"/></svg>
      </div>
      <div class="mt-2 text-xl font-semibold num ${c.trend !== undefined ? trendClass(c.trend) : ''}">${esc(c.value)}</div>
      <div class="text-xs text-muted mt-0.5 num">${esc(c.sub)}</div>
    </div>`).join('');

  // ── 自選股表格
  $('watch-count').textContent = `${latest.watchlist.length} 檔`;
  $('watch-table').innerHTML = latest.watchlist.length === 0
    ? emptyState('還沒有自選股，用上方搜尋框加入', 'star')
    : `<table class="w-full text-sm">
        <thead class="bg-raised text-muted text-xs">
          <tr>
            <th class="whitespace-nowrap text-left font-medium px-5 py-2.5">標的</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">股價</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">漲跌</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5 hidden sm:table-cell">本益比</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5 hidden sm:table-cell">殖利率</th>
            <th class="whitespace-nowrap text-center font-medium px-3 py-2.5">新聞</th>
            <th class="px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line-soft">
          ${latest.watchlist.map((s) => `
            <tr class="hover:bg-raised">
              <td class="px-5 py-3">
                <div class="font-medium">${esc(s.name)}</div>
                <div class="text-xs text-muted num">${esc(s.code)}
                  ${s.industry ? `<span class="ml-1 text-faint">${esc(s.industry)}</span>` : ''}
                  ${s.unknown ? '<span class="ml-1 text-warn">查無資料</span>' : ''}
                </div>
              </td>
              <td class="px-3 py-3 text-right num font-medium">${fmt(s.price)}
                ${s.priceSource === '盤中推估' ? '<div class="text-[10px] text-faint">推估</div>' : ''}
              </td>
              <td class="px-3 py-3 text-right num ${trendClass(s.changePercent)}">
                ${signed(s.change)}<div class="text-xs">${signed(s.changePercent)}%</div>
              </td>
              <td class="px-3 py-3 text-right num hidden sm:table-cell text-sub">${fmt(s.peRatio, 1)}</td>
              <td class="px-3 py-3 text-right num hidden sm:table-cell text-sub">${s.dividendYield !== null ? fmt(s.dividendYield) + '%' : '—'}</td>
              <td class="px-3 py-3 text-center">
                ${s.newsCount > 0 ? `<span class="inline-block px-2 py-0.5 rounded-full bg-accent-bg text-accent-ink text-xs num">${s.newsCount}</span>` : '<span class="text-dim">—</span>'}
              </td>
              <td class="px-3 py-3 text-right">
                <button data-remove-watch="${esc(s.code)}" class="text-faint hover:text-danger px-1" title="移除">
                  <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0" aria-hidden="true"><use href="#i-xmark"/></svg>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

  // ── 提醒 / 事件
  $('overview-alerts').innerHTML = alerts.triggered.length === 0
    ? emptyState('目前沒有觸發的提醒', 'bell-slash')
    : alerts.triggered.slice(0, 6).map(alertRow).join('');

  $('overview-events').innerHTML = events.length === 0
    ? emptyState('30 天內沒有相關事件', 'calendar')
    : events.slice(0, 6).map((e) => `
        <div class="flex items-start gap-2.5 text-sm">
          <span class="mt-0.5 px-1.5 py-0.5 rounded bg-track text-sub text-[11px] shrink-0">${esc(e.kind)}</span>
          <div class="min-w-0">
            <div class="truncate">${esc(e.name || e.code)}</div>
            <div class="text-xs text-muted num">${esc(e.date)}${e.detail ? ` · ${esc(e.detail)}` : ''}</div>
          </div>
        </div>`).join('');

  // ── 市場動態
  const movers = [
    ['漲幅前五', market.topGainers, 'arrow-up text-up'],
    ['跌幅前五', market.topLosers, 'arrow-down text-down'],
    ['成交值前五', market.mostActive, 'fire text-warn-strong'],
  ];
  $('market-movers').innerHTML = movers.map(([title, rows, icon]) => {
    const [iconName, ...iconRest] = icon.split(' ');
    const iconClass = iconRest.join(' ');
    return `
    <div class="bg-surface rounded-xl border border-line">
      <div class="px-5 py-3.5 border-b border-line-soft flex items-center gap-2">
        <svg class="w-4 h-4 shrink-0 ${iconClass}" aria-hidden="true"><use href="#i-${iconName}"/></svg><h2 class="font-semibold text-sm">${esc(title)}</h2>
      </div>
      <div class="divide-y divide-line-soft">
        ${rows.map((s) => `
          <div class="px-5 py-2.5 flex items-center justify-between text-sm">
            <div class="min-w-0">
              <div class="truncate font-medium">${esc(s.name)}</div>
              <div class="text-xs text-muted num">${esc(s.code)}</div>
            </div>
            <div class="text-right shrink-0 ml-2">
              <div class="num">${fmt(s.close)}</div>
              <div class="text-xs num ${trendClass(s.changePercent)}">${signed(s.changePercent)}%</div>
            </div>
            <button data-add-watch="${esc(s.code)}" class="ml-3 text-dim hover:text-brand-600" title="加入自選">
              <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0" aria-hidden="true"><use href="#i-plus"/></svg>
            </button>
          </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function alertRow(a) {
  // 台股紅漲綠跌：warning（下跌/利空）走綠、info（上漲/利多）走紅，
  // neutral（除權息、法說會等無方向性事件）走灰。
  const tone = {
    warning: 'bg-down-bg border-down-line',
    neutral: 'bg-raised border-line',
  }[a.severity] || 'bg-up-bg border-up-line';
  return `<div class="rounded-lg border ${tone} px-3 py-2.5 text-sm">
    <div>${esc(a.message)}</div>
    ${a.news ? a.news.map((n) => `<a href="${esc(n.link)}" target="_blank" rel="noopener"
        class="block mt-1 text-xs text-accent-ink hover:underline truncate">${esc(n.title)}</a>`).join('') : ''}
  </div>`;
}

function renderHoldings() {
  const pf = latest.portfolio;

  $('portfolio-kpi').innerHTML = [
    ['投入成本', fmtMoney(pf.summary.totalCost), null],
    ['目前市值', fmtMoney(pf.summary.totalValue), null],
    ['未實現損益', fmtMoney(pf.summary.totalProfit), pf.summary.totalProfit],
    ['報酬率', pf.summary.totalProfitPercent !== null ? `${signed(pf.summary.totalProfitPercent)}%` : '—', pf.summary.totalProfit],
  ].map(([label, value, trend]) => `
    <div class="bg-surface rounded-xl border border-line p-4">
      <div class="text-xs text-muted">${esc(label)}</div>
      <div class="mt-1.5 text-xl font-semibold num ${trend !== null ? trendClass(trend) : ''}">${esc(value)}</div>
    </div>`).join('');

  $('fee-note').textContent = pf.feeNote;

  $('holdings-table').innerHTML = pf.positions.length === 0
    ? emptyState('還沒有持股，用上方欄位新增', 'wallet')
    : `<table class="w-full text-sm">
        <thead class="bg-raised text-muted text-xs">
          <tr>
            <th class="whitespace-nowrap text-left font-medium px-5 py-2.5">標的</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">股數</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">成本</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">現價</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">市值</th>
            <th class="whitespace-nowrap text-right font-medium px-3 py-2.5">損益</th>
            <th class="px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-line-soft">
          ${pf.positions.map((p) => `
            <tr class="hover:bg-raised ${p.unknown ? 'opacity-60' : ''}">
              <td class="px-5 py-3">
                <div class="font-medium">${esc(p.name)}</div>
                <div class="text-xs text-muted num">${esc(p.code)}
                  ${p.unknown ? '<span class="ml-1 text-warn">查無此代號</span>'
                              : p.priceSource ? `<span class="ml-1 text-faint">${esc(p.priceSource)}</span>` : ''}
                </div>
              </td>
              <td class="px-3 py-3 text-right num">${fmtInt(p.shares)}</td>
              <td class="px-3 py-3 text-right num">${fmt(p.cost)}</td>
              <td class="px-3 py-3 text-right num">${fmt(p.price)}</td>
              <td class="px-3 py-3 text-right num">${fmtMoney(p.marketValue)}</td>
              <td class="px-3 py-3 text-right num ${trendClass(p.profit)}">
                ${fmtMoney(p.profit)}
                <div class="text-xs">${p.profitPercent !== null ? signed(p.profitPercent) + '%' : ''}</div>
              </td>
              <td class="px-3 py-3 text-right">
                <button data-remove-holding="${esc(p.code)}" class="text-faint hover:text-danger px-1" title="移除">
                  <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0" aria-hidden="true"><use href="#i-xmark"/></svg>
                </button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;

  const conc = pf.concentration;
  $('concentration').innerHTML = conc.length === 0
    ? emptyState('尚無持股資料', 'chart-pie')
    : conc.map((c) => `
        <div>
          <div class="flex justify-between text-sm mb-1">
            <span>${esc(c.industry)}</span>
            <span class="num ${c.percent > 40 ? 'text-warn font-medium' : 'text-sub'}">${fmt(c.percent, 1)}%</span>
          </div>
          <div class="h-2 bg-track rounded-full overflow-hidden">
            <div class="h-full ${c.percent > 40 ? 'bg-warn-strong' : 'bg-brand-500'}" style="width:${Math.min(100, c.percent)}%"></div>
          </div>
        </div>`).join('')
      + (pf.topConcentration && pf.topConcentration.percent > 40
        ? `<p class="text-xs text-warn bg-warn-bg border border-warn-line rounded-lg px-3 py-2 mt-3">
             <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1" aria-hidden="true"><use href="#i-warning"/></svg>
             ${esc(pf.topConcentration.industry)}占比 ${fmt(pf.topConcentration.percent, 1)}%，產業集中度偏高。
             「推薦標的」分頁會優先推你尚未持有的產業。</p>`
        : '');
}

function renderNews() {
  const { personalized, others, mood } = latest.news;

  const moodStyle = mood.mood === '偏多' ? 'text-up' : mood.mood === '偏空' ? 'text-down' : 'text-muted';
  $('news-mood').innerHTML = `
    <span class="text-muted">自選股新聞氛圍</span>
    <span class="ml-2 font-semibold ${moodStyle}">${esc(mood.mood)}</span>
    <span class="ml-2 text-xs text-muted num">（利多 ${mood.counts.利多} · 利空 ${mood.counts.利空} · 中性 ${mood.counts.中性}）</span>`;

  const filters = [['all', '全部'], ['利多', '利多'], ['利空', '利空']];
  $('news-filters').innerHTML = filters.map(([key, label]) => `
    <button data-news-filter="${key}" class="px-3 py-1.5 text-xs rounded-lg border ${
      profile.newsFilter === key ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface border-line text-sub'
    }">${esc(label)}</button>`).join('');

  const shown = profile.newsFilter === 'all'
    ? personalized
    : personalized.filter((n) => n.sentiment.label === profile.newsFilter);

  $('news-personalized').innerHTML = shown.length === 0
    ? emptyState(personalized.length === 0
        ? '目前沒有跟你自選股相關的新聞'
        : `沒有${profile.newsFilter}新聞`, 'newspaper')
    : shown.map(newsCard).join('');

  $('news-others').innerHTML = others.length === 0
    ? emptyState('沒有其他新聞', 'newspaper')
    : others.map(newsCard).join('');
}

function newsCard(n) {
  const s = n.sentiment;
  return `<article class="bg-surface rounded-xl border border-line p-4">
    <div class="flex items-start gap-3">
      <span class="shrink-0 px-2 py-0.5 rounded border text-xs ${SENTIMENT_STYLE[s.label]}">${esc(s.label)}</span>
      <div class="min-w-0 flex-1">
        <h3 class="font-medium leading-snug">
          ${n.link ? `<a href="${esc(n.link)}" target="_blank" rel="noopener" class="hover:text-brand-700">${esc(n.title)}</a>`
                   : esc(n.title)}
        </h3>
        ${n.summary ? `<p class="text-sm text-sub mt-1 leading-relaxed line-clamp-2">${esc(n.summary)}</p>` : ''}
        <div class="flex flex-wrap items-center gap-1.5 mt-2 text-xs">
          ${n.matchedSymbols.map((m) => `
            <span class="px-1.5 py-0.5 rounded bg-accent-bg text-accent-ink num" title="比對方式：${esc(m.via)}">
              ${esc(m.code)}
            </span>`).join('')}
          <span class="text-faint">${esc(n.source || '')}</span>
          <span class="text-faint">${esc(timeAgo(n.publishedAt))}</span>
          ${s.hedged ? '<span class="text-warn" title="標題含「傳」「可能」等推測語氣，情緒分數已打折">推測語氣</span>' : ''}
          ${s.matched.length ? `<span class="text-faint">關鍵詞：${esc(s.matched.join('、'))}</span>` : ''}
        </div>
      </div>
    </div>
  </article>`;
}

function renderRecommend() {
  const r = latest.recommendations;

  $('risk-picker').innerHTML = RISKS.map(([key, label, hint]) => `
    <button data-risk="${key}" title="${esc(hint)}" class="px-3.5 py-2 text-sm rounded-lg border ${
      profile.risk === key ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface border-line text-sub hover:bg-raised'
    }">${esc(label)}</button>`).join('');

  $('goal-picker').innerHTML = GOALS.map(([key, label]) => `
    <button data-goal="${key}" class="px-3.5 py-2 text-sm rounded-lg border ${
      profile.goals.includes(key) ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface border-line text-sub hover:bg-raised'
    }">${esc(label)}</button>`).join('');

  $('weights').innerHTML = Object.entries(r.weights)
    .sort((a, b) => b[1] - a[1])
    .map(([factor, weight]) => `
      <span class="px-2.5 py-1 rounded-lg bg-track text-xs num">
        ${esc(FACTOR_LABELS[factor] || factor)} ${(weight * 100).toFixed(0)}%
      </span>`).join('');

  $('recommend-list').innerHTML = r.items.length === 0
    ? emptyState('沒有符合條件的標的', 'lightbulb')
    : r.items.map((item) => `
        <div class="bg-surface rounded-xl border border-line p-4">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <div class="font-semibold">${esc(item.name)}
                <span class="text-sm text-muted num ml-1">${esc(item.code)}</span>
              </div>
              <div class="text-xs text-muted mt-0.5">
                ${esc(item.market || '')}${item.industry ? ` · ${esc(item.industry)}` : ''}
                ${item.topFactor ? ` · 主因：${esc(FACTOR_LABELS[item.topFactor] || item.topFactor)}` : ''}
              </div>
            </div>
            <div class="text-right shrink-0">
              <div class="num font-medium">${fmt(item.close)}</div>
              <div class="text-xs num ${trendClass(item.changePercent)}">${signed(item.changePercent)}%</div>
            </div>
          </div>

          <div class="mt-3 flex items-center gap-2">
            <div class="flex-1 h-1.5 bg-track rounded-full overflow-hidden">
              <div class="h-full score-bar" style="width:${Math.round(item.score * 100)}%"></div>
            </div>
            <span class="text-xs text-muted num">${(item.score * 100).toFixed(0)} 分</span>
          </div>

          <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-sub num">
            <span>本益比 ${fmt(item.peRatio, 1)}</span>
            <span>殖利率 ${item.dividendYield !== null ? fmt(item.dividendYield) + '%' : '—'}</span>
            <span>淨值比 ${fmt(item.pbRatio)}</span>
          </div>

          ${item.reasons.length ? `<ul class="mt-3 space-y-1">
            ${item.reasons.map((reason) => `<li class="text-sm text-ink flex gap-1.5">
              <svg class="w-3 h-3 inline-block align-[-0.15em] shrink-0 text-brand-500 mt-1" aria-hidden="true"><use href="#i-check"/></svg><span>${esc(reason)}</span></li>`).join('')}
          </ul>` : ''}

          ${item.cautions.length ? `<ul class="mt-2 space-y-1">
            ${item.cautions.map((c) => `<li class="text-sm text-warn flex gap-1.5">
              <svg class="w-3 h-3 inline-block align-[-0.15em] shrink-0 mt-1" aria-hidden="true"><use href="#i-warning"/></svg><span>${esc(c)}</span></li>`).join('')}
          </ul>` : ''}

          <button data-add-watch="${esc(item.code)}"
                  class="mt-3 w-full py-2 text-sm rounded-lg border border-accent-line text-accent-ink hover:bg-accent-bg">
            <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1" aria-hidden="true"><use href="#i-star"/></svg>加入自選
          </button>
        </div>`).join('');

  $('recommend-disclaimer').innerHTML = `<svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1" aria-hidden="true"><use href="#i-info"/></svg>${esc(r.disclaimer)}
    　候選池 ${r.candidateCount} 檔（已排除已持有、已在自選、成交量過低者）。`;
}

// ── AI 市場報告（選用，需伺服器設定 GEMINI_API_KEY） ──────

function renderAiReport() {
  const button = $('ai-report-start');
  const panel = $('ai-report-panel');
  if (!button || !panel) return;

  const available = latest?.aiReportAvailable ?? true; // 還沒拿到第一次 dashboard 回應前，先假設可用，避免閃爍
  button.disabled = !available || aiReportState.status === 'in_progress';

  if (!available) {
    panel.innerHTML = emptyState('伺服器尚未設定 GEMINI_API_KEY，這個功能目前未啟用', 'gear');
    return;
  }

  if (aiReportState.status === 'idle') {
    panel.innerHTML = emptyState('按上面的按鈕開始產生今天的市場報告', 'lightbulb');
    return;
  }

  if (aiReportState.status === 'in_progress') {
    const elapsed = Math.round((Date.now() - aiReportState.startedAt) / 1000);
    panel.innerHTML = `
      <div class="flex items-center gap-2.5 text-sm text-sub">
        <svg class="w-4 h-4 animate-spin shrink-0" aria-hidden="true"><use href="#i-rotate"/></svg>
        研究中，已等待 ${elapsed} 秒（Deep Research 通常要數分鐘，最多可能到一小時，可以先切去別的分頁）
      </div>`;
    return;
  }

  if (aiReportState.status === 'failed') {
    panel.innerHTML = `<div class="rounded-lg border border-danger-line bg-danger-bg text-danger px-4 py-3 text-sm">
      產生失敗：${esc(aiReportState.error || '未知錯誤')}
    </div>`;
    return;
  }

  // completed —— 原樣保留換行，內容一律 escape（外部 AI 產出，跟新聞來源同等看待）
  panel.innerHTML = `<div class="text-sm leading-relaxed whitespace-pre-wrap">${esc(aiReportState.text || '（沒有內容）')}</div>`;
}

function stopAiReportPoll() {
  clearTimeout(aiReportPollTimer);
  aiReportPollTimer = null;
}

async function pollAiReport() {
  try {
    const res = await fetch(`/api/ai-report/${encodeURIComponent(aiReportState.id)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `伺服器回應 ${res.status}`);

    if (data.status === 'completed') {
      aiReportState = { status: 'completed', id: aiReportState.id, text: data.text };
    } else if (data.status === 'failed') {
      aiReportState = { status: 'failed', id: aiReportState.id, error: '研究任務失敗' };
    } else {
      renderAiReport(); // 先更新等待秒數，再排下一次輪詢
      aiReportPollTimer = setTimeout(pollAiReport, AI_REPORT_POLL_MS);
      return;
    }
  } catch (err) {
    aiReportState = { status: 'failed', id: aiReportState.id, error: err.message };
  }
  renderAiReport();
}

async function startAiReport() {
  if (aiReportState.status === 'in_progress') return;
  if (!confirm('這會呼叫你自己付費的 Gemini Deep Research，單次費用約 1～7 美元，且可能要等數分鐘到一小時才會完成，確定要繼續嗎？')) {
    return;
  }

  stopAiReportPoll();
  aiReportState = { status: 'in_progress', startedAt: Date.now() };
  renderAiReport();

  try {
    const res = await fetch('/api/ai-report', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `伺服器回應 ${res.status}`);

    aiReportState = { status: 'in_progress', id: data.id, startedAt: aiReportState.startedAt };
    aiReportPollTimer = setTimeout(pollAiReport, AI_REPORT_POLL_MS);
  } catch (err) {
    aiReportState = { status: 'failed', error: err.message };
  }
  renderAiReport();
}

function renderAlerts() {
  const watch = latest.watchlist;
  const holdingCodes = latest.portfolio.positions.map((p) => ({ code: p.code, name: p.name }));
  const options = [...watch, ...holdingCodes]
    .filter((s, i, arr) => arr.findIndex((x) => x.code === s.code) === i);

  const prevCode = $('a-code').value;
  $('a-code').innerHTML = options.length === 0
    ? '<option value="">請先加入自選股</option>'
    : options.map((s) => `<option value="${esc(s.code)}">${esc(s.code)} ${esc(s.name)}</option>`).join('');
  if (prevCode && options.some((o) => o.code === prevCode)) $('a-code').value = prevCode;

  if (!$('a-type').options.length) {
    $('a-type').innerHTML = Object.entries(RULE_TYPES)
      .map(([key, t]) => `<option value="${key}">${esc(t.label)}</option>`).join('');
    syncRuleValueField();
  }

  $('alerts-triggered').innerHTML = latest.alerts.triggered.length === 0
    ? emptyState('目前沒有觸發的提醒', 'bell-slash')
    : latest.alerts.triggered.map(alertRow).join('');

  const skipped = new Map(latest.alerts.skipped.map((s) => [s.ruleId, s.reason]));
  $('alerts-rules').innerHTML = profile.rules.length === 0
    ? emptyState('還沒有設定提醒規則', 'bell')
    : profile.rules.map((rule) => {
        const t = RULE_TYPES[rule.type] || { label: rule.type, unit: '' };
        const stock = latest.watchlist.find((s) => s.code === rule.code);
        const isSkipped = skipped.has(rule.id);
        return `<div class="flex items-center gap-2 text-sm py-1.5">
          <input type="checkbox" data-toggle-rule="${esc(rule.id)}" ${rule.enabled === false ? '' : 'checked'}
                 class="w-4 h-4 accent-brand-600 shrink-0">
          <div class="min-w-0 flex-1 ${rule.enabled === false ? 'opacity-50' : ''}">
            <span class="num">${esc(rule.code)}</span>
            <span class="text-sub">${esc(stock ? stock.name : '')}</span>
            <span class="text-muted">${esc(t.label)}</span>
            ${t.needsValue ? `<span class="num font-medium">${esc(rule.value)}${esc(t.unit)}</span>` : ''}
            ${isSkipped ? `<div class="text-xs text-warn">無法評估：${esc(skipped.get(rule.id))}</div>` : ''}
          </div>
          <button data-remove-rule="${esc(rule.id)}" class="text-faint hover:text-danger px-1 shrink-0">
            <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0" aria-hidden="true"><use href="#i-xmark"/></svg>
          </button>
        </div>`;
      }).join('');
}

function renderDiagnostics() {
  const d = latest.diagnostics;
  const rows = [
    ['模式', d.offline ? '離線（樣本資料）' : '線上'],
    ['股票宇宙', `${latest.market.total} 檔 · ${d.universeFromCache ? '來自快取' : '即時抓取'}`],
    ['更新時間', new Date(d.universeUpdatedAt).toLocaleString('zh-TW')],
  ];

  $('diagnostics').innerHTML = rows.map(([k, v]) => `
      <div class="flex justify-between gap-3">
        <span class="text-muted">${esc(k)}</span><span class="num text-right">${esc(v)}</span>
      </div>`).join('')
    + (d.sourceErrors.length
      ? `<div class="pt-2 mt-2 border-t border-line-soft">
           <div class="text-muted mb-1">來源訊息</div>
           <ul class="space-y-1 text-xs text-warn list-disc list-inside">
             ${d.sourceErrors.map((e) => `<li>${esc(e)}</li>`).join('')}
           </ul>
         </div>`
      : '<div class="pt-2 mt-2 border-t border-line-soft text-xs text-ok">所有來源正常</div>');
}

// ── 互動 ─────────────────────────────────────────────

function syncRuleValueField() {
  const type = RULE_TYPES[$('a-type').value];
  const needs = type?.needsValue !== false;
  $('a-value-wrap').style.display = needs ? '' : 'none';
  $('a-unit').textContent = needs && type?.unit ? `(${type.unit})` : '';
}

function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  $(`tab-${name}`)?.classList.add('active');

  document.querySelectorAll('[data-tab]').forEach((el) => {
    const active = el.dataset.tab === name;
    el.className = `w-full flex items-center gap-2.5 px-5 py-2.5 text-sm transition ${
      active ? 'bg-brand-600/15 text-white border-r-2 border-brand-500' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
    }`;
  });

  location.hash = name;

  // 手機上選完分頁就把浮層選單收起來，否則會一直蓋住內容
  if (window.matchMedia('(max-width: 767px)').matches) closeMobileMenu();
}

function setMobileMenu(open) {
  const aside = document.querySelector('aside');
  aside.classList.toggle('hidden', !open);
  aside.classList.toggle('flex', open);
  $('backdrop').classList.toggle('hidden', !open);
}

const closeMobileMenu = () => setMobileMenu(false);

function addToWatchlist(code) {
  if (!code || profile.watchlist.includes(code)) return;
  profile.watchlist.push(code);
  saveProfile();
  refresh();
}

let searchTimer = null;

function initEvents() {
  $('nav').innerHTML = TABS.map(([key, label, icon]) => `
    <button data-tab="${key}" class="w-full flex items-center gap-2.5 px-5 py-2.5 text-sm text-slate-400">
      <svg class="w-4 h-4 shrink-0" aria-hidden="true"><use href="#i-${icon}"/></svg>${esc(label)}
    </button>`).join('');

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-tab], [data-add-watch], [data-remove-watch], [data-remove-holding], [data-risk], [data-goal], [data-news-filter], [data-remove-rule]');
    if (!target) return;

    const d = target.dataset;

    if (d.tab) return switchTab(d.tab);

    if (d.addWatch) return addToWatchlist(d.addWatch);

    if (d.removeWatch) {
      profile.watchlist = profile.watchlist.filter((c) => c !== d.removeWatch);
      saveProfile();
      return refresh();
    }

    if (d.removeHolding) {
      profile.holdings = profile.holdings.filter((h) => h.code !== d.removeHolding);
      saveProfile();
      return refresh();
    }

    if (d.risk) {
      profile.risk = d.risk;
      saveProfile();
      return refresh();
    }

    if (d.goal) {
      profile.goals = profile.goals.includes(d.goal)
        ? profile.goals.filter((g) => g !== d.goal)
        : [...profile.goals, d.goal];
      saveProfile();
      return refresh();
    }

    if (d.newsFilter) {
      profile.newsFilter = d.newsFilter;
      saveProfile();
      return renderNews();
    }

    if (d.removeRule) {
      profile.rules = profile.rules.filter((r) => r.id !== d.removeRule);
      saveProfile();
      return refresh();
    }
  });

  document.addEventListener('change', (event) => {
    const id = event.target.dataset.toggleRule;
    if (!id) return;
    const rule = profile.rules.find((r) => r.id === id);
    if (rule) {
      rule.enabled = event.target.checked;
      saveProfile();
      refresh();
    }
  });

  $('refresh').addEventListener('click', refresh);

  $('ai-report-start').addEventListener('click', startAiReport);

  $('theme-toggle').addEventListener('click', () => {
    const at = THEMES.findIndex(([key]) => key === profile.theme);
    profile.theme = THEMES[(at + 1) % THEMES.length][0];
    saveProfile();
    applyTheme(profile.theme);
  });
  $('mobile-menu').addEventListener('click', () => {
    setMobileMenu(document.querySelector('aside').classList.contains('hidden'));
  });
  $('backdrop').addEventListener('click', closeMobileMenu);

  // ── 搜尋
  $('search').addEventListener('input', (event) => {
    const query = event.target.value.trim();
    clearTimeout(searchTimer);

    if (query.length < 1) return $('search-results').classList.add('hidden');

    // debounce：避免每個按鍵都打一次 API
    searchTimer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const { results } = await res.json();

        $('search-results').innerHTML = results.length === 0
          ? '<div class="px-3 py-3 text-sm text-muted">查無符合的標的</div>'
          : results.map((s) => `
              <button data-add-watch="${esc(s.code)}"
                      class="w-full text-left px-3 py-2.5 hover:bg-raised flex items-center justify-between gap-2">
                <span class="min-w-0">
                  <span class="font-medium">${esc(s.name)}</span>
                  <span class="text-xs text-muted num ml-1.5">${esc(s.code)}</span>
                  <span class="text-xs text-faint ml-1">${esc(s.industry || s.market || '')}</span>
                </span>
                <span class="text-xs num shrink-0 ${trendClass(s.changePercent)}">${signed(s.changePercent)}%</span>
              </button>`).join('');

        $('search-results').classList.remove('hidden');
      } catch {
        $('search-results').classList.add('hidden');
      }
    }, 250);
  });

  $('search').addEventListener('blur', () => setTimeout(() => $('search-results').classList.add('hidden'), 150));

  // ── 持股新增
  $('h-add').addEventListener('click', () => {
    const code = $('h-code').value.trim();
    const shares = Number($('h-shares').value);
    const cost = Number($('h-cost').value);

    if (!code || !(shares > 0) || !(cost >= 0)) {
      alert('請填入代號、股數與每股成本');
      return;
    }

    const existing = profile.holdings.find((h) => h.code === code);
    if (existing) {
      // 同一檔再買進：改成加權平均成本，而不是覆蓋
      const totalShares = existing.shares + shares;
      existing.cost = +(((existing.cost * existing.shares) + (cost * shares)) / totalShares).toFixed(4);
      existing.shares = totalShares;
    } else {
      profile.holdings.push({ code, shares, cost });
    }

    if (!profile.watchlist.includes(code)) profile.watchlist.push(code);
    saveProfile();

    $('h-code').value = $('h-shares').value = $('h-cost').value = '';
    refresh();
  });

  // ── 提醒新增
  $('a-type').addEventListener('change', syncRuleValueField);
  $('a-add').addEventListener('click', () => {
    const code = $('a-code').value;
    const type = $('a-type').value;
    const meta = RULE_TYPES[type];

    if (!code) { alert('請先加入自選股'); return; }

    const value = meta.needsValue ? Number($('a-value').value) : null;
    if (meta.needsValue && !Number.isFinite(value)) { alert(`請填入數值（${meta.unit}）`); return; }

    profile.rules.push({
      id: `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      code, type, value, enabled: true,
    });
    saveProfile();
    $('a-value').value = '';
    refresh();
  });

  // ── 設定
  $('s-fees').checked = profile.includeFees;
  $('s-discount').value = profile.feeDiscount;
  $('s-interval').value = profile.refreshSeconds;

  $('s-fees').addEventListener('change', (e) => {
    profile.includeFees = e.target.checked; saveProfile(); refresh();
  });
  $('s-discount').addEventListener('change', (e) => {
    profile.feeDiscount = Math.max(0.1, Math.min(1, Number(e.target.value) || 0.6));
    e.target.value = profile.feeDiscount; saveProfile(); refresh();
  });
  $('s-interval').addEventListener('change', (e) => {
    profile.refreshSeconds = Math.max(0, Number(e.target.value) || 0);
    saveProfile(); scheduleRefresh();
  });

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tw-stock-pulse-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      profile = { ...DEFAULT_PROFILE, ...incoming };
      saveProfile();
      location.reload();
    } catch (err) {
      alert(`匯入失敗：${err.message}`);
    }
  });

  $('reset').addEventListener('click', () => {
    if (!confirm('確定要清除所有自選股、持股與提醒規則嗎？此動作無法復原。')) return;
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  if (profile.refreshSeconds > 0) {
    refreshTimer = setInterval(refresh, profile.refreshSeconds * 1000);
  }
}

// ── 啟動 ─────────────────────────────────────────────

applyTheme(profile.theme);
initEvents();
applyTheme(profile.theme);   // 按鈕是 initEvents 之後才存在，圖示要再同步一次
switchTab(location.hash.replace('#', '') || 'overview');
renderAiReport();            // 第一次 dashboard 回應回來前，先顯示初始狀態
refresh();
scheduleRefresh();
