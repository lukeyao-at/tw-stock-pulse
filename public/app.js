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
  taCode: null,
  taLookback: 120,
  taCapital: 1000000,
  taRiskPct: 1,
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
  ['technical', '技術分析', 'chart-line'],
  ['news', '個人化新聞', 'newspaper'],
  ['recommend', '推薦標的', 'lightbulb'],
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
  renderAlerts();
  renderDiagnostics();
  // 自選股名稱要等 dashboard 回來才有，技術分析的標的清單跟著更新
  if ($('tab-technical').classList.contains('active')) renderTechnicalControls();
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
              <td class="px-3 py-3 text-right whitespace-nowrap">
                <button data-ta-open="${esc(s.code)}" class="text-faint hover:text-accent-ink px-1" title="技術分析">
                  <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0" aria-hidden="true"><use href="#i-chart-line"/></svg>
                </button>
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

// ── 技術分析 ─────────────────────────────────────────
//
// 跟其他分頁不同，這裡的資料不在 dashboard 回應裡：一檔要抓兩年日 K，
// 所以只在打開這個分頁、選了某一檔時才另外打 /api/technical。

const TA_LOOKBACKS = [
  [60, '60 日', '約一季，適合波段短線'],
  [120, '120 日', '約半年，預設'],
  [240, '240 日', '約一年，看大趨勢'],
];

const ZONE_LABEL = {
  lower: '觸下緣', upper: '觸上緣', middle: '通道中段', breakout: '突破上緣', breakdown: '跌破下緣',
};

const TONE_STYLE = {
  up: 'bg-up-bg text-up border-up-line',
  down: 'bg-down-bg text-down border-down-line',
  neutral: 'bg-raised text-sub border-line',
};

const taCache = new Map();
let taLatest = null;
let taLoading = null;

/** 可選的標的：自選股 + 持股（去重） */
function taOptions() {
  const rows = [
    ...(latest?.watchlist ?? []).map((s) => ({ code: s.code, name: s.name })),
    ...(latest?.portfolio?.positions ?? []).map((p) => ({ code: p.code, name: p.name })),
  ];
  const fallback = [...profile.watchlist, ...profile.holdings.map((h) => h.code)].map((code) => ({ code, name: code }));
  return [...rows, ...fallback].filter((s, i, arr) => arr.findIndex((x) => x.code === s.code) === i);
}

function taKey() {
  return [profile.taCode, profile.taLookback, profile.taCapital, profile.taRiskPct].join('|');
}

async function loadTechnical({ force = false } = {}) {
  if (!profile.taCode) profile.taCode = taOptions()[0]?.code || '2330';
  renderTechnicalControls();

  const key = taKey();
  if (!force && taCache.has(key)) {
    taLatest = taCache.get(key);
    return renderTechnical();
  }
  if (taLoading === key) return;
  taLoading = key;
  $('ta-body').innerHTML = `<div class="bg-surface rounded-xl border border-line py-16 text-center text-sm text-muted">
    正在抓取 ${esc(profile.taCode)} 的兩年日 K 並計算通道與指標…</div>`;

  try {
    const params = new URLSearchParams({
      code: profile.taCode, lookback: profile.taLookback,
      capital: profile.taCapital, riskPct: profile.taRiskPct,
    });
    const res = await fetch(`/api/technical?${params}`);
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`);
    const data = await res.json();
    taCache.set(key, data);
    if (taKey() === key) { taLatest = data; renderTechnical(); }
  } catch (err) {
    $('ta-body').innerHTML = `<div class="rounded-lg border px-4 py-3 text-sm bg-danger-bg border-danger-line text-danger">技術分析載入失敗：${esc(err.message)}</div>`;
  } finally {
    if (taLoading === key) taLoading = null;
  }
}

function renderTechnicalControls() {
  const chip = (active) => `px-3 py-1.5 text-sm rounded-lg border ${
    active ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface border-line text-sub hover:bg-raised'}`;

  const options = taOptions();
  $('ta-picker').innerHTML = options.length === 0
    ? '<span class="text-sm text-faint">還沒有自選股，右側直接輸入代號</span>'
    : options.map((s) => `<button data-ta-code="${esc(s.code)}" class="${chip(s.code === profile.taCode)}">
        <span class="num">${esc(s.code)}</span>${s.name !== s.code ? ` ${esc(s.name)}` : ''}</button>`).join('');

  $('ta-lookback').innerHTML = TA_LOOKBACKS.map(([n, label, hint]) =>
    `<button data-ta-lookback="${n}" title="${esc(hint)}" class="${chip(n === profile.taLookback)} num">${esc(label)}</button>`).join('');
}

const pctText = (n) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${fmt(n)}%` : '—');

function renderTechnical() {
  const t = taLatest;
  if (!t) return;
  renderTechnicalControls();

  if (!t.ok) {
    $('ta-body').innerHTML = `<div class="bg-surface rounded-xl border border-line">${emptyState(t.reason || '無法分析', 'chart-line')}</div>`;
    return;
  }

  const a = t.analysis;
  const ch = a.channel;
  const notes = [...(t.notes ?? [])];

  $('ta-body').innerHTML = `
    ${notes.length ? `<div class="rounded-lg border px-4 py-3 text-sm bg-warn-bg border-warn-line text-warn mb-6">
      <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1.5" aria-hidden="true"><use href="#i-warning"/></svg>${notes.map(esc).join('；')}</div>` : ''}

    <div class="grid lg:grid-cols-3 gap-6">
      ${verdictCard(t)}
      <div class="lg:col-span-2 bg-surface rounded-xl border border-line">
        <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center gap-x-4 gap-y-1">
          <h2 class="font-semibold">K 線與${esc(ch.label)}</h2>
          <span class="text-xs text-muted num">${esc(ch.startDate)} 起 ${ch.lookback} 日 · 資料至 ${esc(t.asOf)} · ${esc(t.source)}</span>
        </div>
        <div class="p-3 sm:p-4">
          ${chartLegend()}
          <!-- 手機上圖不縮到看不清楚，改成在卡片內左右捲動 -->
          <div class="overflow-x-auto -mx-1 px-1"><div id="ta-charts" class="relative min-w-[600px]">
            ${priceChartSvg(t.chart)}
            ${oscChartSvg(t.chart, 'rsi')}
            ${oscChartSvg(t.chart, 'kd')}
            <div id="ta-tip" class="hidden absolute z-10 pointer-events-none bg-surface border border-line rounded-lg shadow-lg px-3 py-2 text-xs num min-w-[10rem]"></div>
          </div></div>
        </div>
      </div>
    </div>

    <div class="grid lg:grid-cols-3 gap-6 mt-6">
      <div class="lg:col-span-2 bg-surface rounded-xl border border-line">
        <div class="px-5 py-3.5 border-b border-line-soft flex items-center justify-between">
          <h2 class="font-semibold">判讀依據</h2>
          <span class="text-xs text-muted">每一項都附實際數字，加總即為綜合分數</span>
        </div>
        <ul class="p-5 space-y-2.5">${signalRows(a)}</ul>
      </div>
      ${timeframeCard(a)}
    </div>

    <div class="grid lg:grid-cols-3 gap-6 mt-6">
      ${indicatorCard(a)}
      ${planCard(t.plan)}
    </div>

    ${backtestCard(t.backtest)}

    <p class="text-xs text-muted mt-6 leading-relaxed">
      <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1" aria-hidden="true"><use href="#i-info"/></svg>${esc(t.disclaimer)}
    </p>`;

  bindChartHover(t.chart);
}

function verdictCard(t) {
  const a = t.analysis;
  const ch = a.channel;
  // 分數條從中間往左右長：偏多往右（紅），偏空往左（綠），台股慣例
  const half = Math.min(50, Math.abs(a.score) / 2);
  const bar = a.score >= 0
    ? `left:50%;width:${half}%` : `left:${50 - half}%;width:${half}%`;

  return `<div class="bg-surface rounded-xl border border-line p-5 flex flex-col">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold text-lg">${esc(t.name)} <span class="text-sm text-muted num">${esc(t.code)}</span></div>
        <div class="text-xs text-muted">${esc(t.market || '')}${t.industry ? ` · ${esc(t.industry)}` : ''}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="num text-xl font-semibold">${fmt(a.close)}</div>
        <div class="text-xs num ${trendClass(a.change)}">${signed(a.change)}（${signed(a.changePercent)}%）</div>
      </div>
    </div>

    <div class="mt-5">
      <div class="text-xs text-muted mb-1.5">綜合判讀</div>
      <span class="inline-block px-3 py-1.5 rounded-lg border text-base font-semibold ${TONE_STYLE[a.verdict.tone]}">${esc(a.verdict.label)}</span>
      <span class="ml-2 text-sm text-sub num">${a.score > 0 ? '+' : ''}${a.score} 分</span>
    </div>

    <div class="mt-4" aria-label="綜合分數 ${a.score}，範圍 −100 到 +100">
      <div class="relative h-2 bg-track rounded-full overflow-hidden">
        <div class="absolute inset-y-0 rounded-full ${a.score >= 0 ? 'bg-up' : 'bg-down'}" style="${bar}"></div>
        <div class="absolute inset-y-0 left-1/2 w-px bg-faint"></div>
      </div>
      <div class="flex justify-between text-[11px] text-faint mt-1 num"><span>−100 偏空</span><span>0</span><span>偏多 +100</span></div>
    </div>

    ${a.capped ? `<p class="mt-3 text-xs text-warn leading-relaxed">指標加總 +${a.rawScore} 分，但股價在通道中段、沒有碰到邊緣，依通道操作原則只給「觀望」：中段進場的停損遠、目標近，風險報酬比通常不划算。</p>` : ''}

    <dl class="mt-5 pt-4 border-t border-line-soft grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
      <div><dt class="text-xs text-muted">通道型態</dt><dd class="font-medium">${esc(ch.label)}</dd></div>
      <div><dt class="text-xs text-muted">目前位置</dt><dd class="font-medium">${esc(ZONE_LABEL[a.location.zone])} <span class="text-muted num text-xs">${Math.round(a.location.position * 100)}%</span></dd></div>
      <div><dt class="text-xs text-muted">上緣（壓力）</dt><dd class="num">${fmt(ch.upper)}</dd></div>
      <div><dt class="text-xs text-muted">下緣（支撐）</dt><dd class="num">${fmt(ch.lower)}</dd></div>
      <div><dt class="text-xs text-muted">通道斜率</dt><dd class="num">${pctText(ch.slopePctPerMonth)} / 月</dd></div>
      <div><dt class="text-xs text-muted">通道寬度</dt><dd class="num">${fmt(ch.widthPct)}%</dd></div>
      <div><dt class="text-xs text-muted">觸碰次數</dt><dd class="num">上 ${ch.touches.upper} · 下 ${ch.touches.lower}</dd></div>
      <div><dt class="text-xs text-muted" title="線性迴歸的 R²，越接近 1 通道越規律">趨勢規律度</dt><dd class="num">R² ${fmt(ch.r2)}</dd></div>
    </dl>
    ${ch.touches.upper < 2 || ch.touches.lower < 2
      ? '<p class="mt-3 text-xs text-warn">上下緣至少各碰過 2 次，通道才算成立；目前的通道參考價值較低，可換個通道長度比對。</p>' : ''}
  </div>`;
}

function signalRows(a) {
  const kindLabel = { channel: '通道', trend: '均線', volume: '量價', indicator: '指標' };
  return [...a.signals]
    .sort((x, y) => (x.kind === 'channel' ? -1 : y.kind === 'channel' ? 1 : Math.abs(y.points) - Math.abs(x.points)))
    .map((s) => {
      const tone = s.points > 0 ? 'text-up' : s.points < 0 ? 'text-down' : 'text-muted';
      return `<li class="flex gap-3 text-sm">
        <span class="shrink-0 w-11 text-right num font-medium ${tone}">${s.points > 0 ? '+' : ''}${s.points}</span>
        <span class="shrink-0 px-1.5 py-0.5 h-fit rounded bg-track text-[11px] text-muted">${esc(kindLabel[s.kind] || s.kind)}</span>
        <span class="text-ink">${esc(s.text)}</span>
      </li>`;
    }).join('')
    + `<li class="pt-3 mt-1 border-t border-line-soft text-xs text-muted leading-relaxed">
        買進確認（${a.buyConfirmations.length} 項）：${a.buyConfirmations.length ? esc(a.buyConfirmations.join('、')) : '無'}
        <br>賣出確認（${a.sellConfirmations.length} 項）：${a.sellConfirmations.length ? esc(a.sellConfirmations.join('、')) : '無'}
      </li>`;
}

function timeframeCard(a) {
  const tfLabel = { 60: '短（60 日）', 120: '中（120 日）', 240: '長（240 日）' };
  const rows = a.timeframes.map((tf) => {
    if (!tf.available) return `<li class="flex justify-between text-sm"><span class="text-muted">${tfLabel[tf.lookback]}</span><span class="text-faint">資料不足</span></li>`;
    const tone = tf.trend === 'up' ? 'text-up' : tf.trend === 'down' ? 'text-down' : 'text-sub';
    return `<li class="flex items-start justify-between gap-3 text-sm">
      <span class="text-muted shrink-0">${tfLabel[tf.lookback]}</span>
      <span class="text-right"><span class="${tone} font-medium">${esc(tf.label.replace('（箱型整理）', ''))}</span>
        <span class="block text-xs text-muted">${esc(ZONE_LABEL[tf.zone])} · 位置 ${Math.round(tf.position * 100)}%</span></span>
    </li>`;
  }).join('');

  const trends = a.timeframes.filter((tf) => tf.available).map((tf) => tf.trend);
  const aligned = trends.length >= 2 && trends.every((x) => x === trends[0]);
  const summary = !trends.length ? ''
    : aligned
      ? `三個週期方向一致（${trends[0] === 'up' ? '都向上' : trends[0] === 'down' ? '都向下' : '都是盤整'}），訊號可信度較高。`
      : '長短週期方向不一致：短線訊號可能只是大趨勢裡的一段反向波動，部位宜縮小。';

  return `<div class="bg-surface rounded-xl border border-line">
    <div class="px-5 py-3.5 border-b border-line-soft"><h2 class="font-semibold">多週期通道</h2></div>
    <ul class="p-5 space-y-3">${rows}</ul>
    ${summary ? `<p class="px-5 pb-5 text-xs text-sub leading-relaxed">${esc(summary)}</p>` : ''}
  </div>`;
}

function indicatorCard(a) {
  const x = a.indicators;
  const tile = (label, value, hint = '') => `<div class="rounded-lg bg-raised px-3 py-2.5">
    <div class="text-[11px] text-muted">${esc(label)}</div>
    <div class="num font-medium mt-0.5">${value}</div>
    ${hint ? `<div class="text-[11px] text-faint mt-0.5">${esc(hint)}</div>` : ''}</div>`;
  const rsiHint = x.rsi === null ? '' : x.rsi < 30 ? '超賣' : x.rsi > 70 ? '超買' : '中性';
  const kdHint = x.k === null ? '' : x.k < 20 ? '低檔' : x.k > 80 ? '高檔' : x.k > x.d ? 'K 在 D 之上' : 'K 在 D 之下';

  return `<div class="lg:col-span-2 bg-surface rounded-xl border border-line">
    <div class="px-5 py-3.5 border-b border-line-soft"><h2 class="font-semibold">指標數值</h2></div>
    <div class="p-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
      ${tile('RSI(14)', fmt(x.rsi, 1), rsiHint)}
      ${tile('KD(9)', `${fmt(x.k, 1)} / ${fmt(x.d, 1)}`, kdHint)}
      ${tile('MACD DIF / 訊號', `${fmt(x.dif)} / ${fmt(x.macd)}`, x.osc === null ? '' : `OSC ${signed(x.osc)}`)}
      ${tile('量比（對 20 日均量）', x.volumeRatio === null ? '—' : `${fmt(x.volumeRatio)} 倍`, x.volumeRatio >= 1.5 ? '爆量' : x.volumeRatio < 0.8 ? '量縮' : '')}
      ${tile('MA5 / MA20', `${fmt(x.ma5)} / ${fmt(x.ma20)}`)}
      ${tile('MA60（季線）', fmt(x.ma60), a.close > x.ma60 ? '股價在季線上' : '股價在季線下')}
      ${tile('布林上 / 下軌', `${fmt(x.bollUpper)} / ${fmt(x.bollLower)}`)}
      ${tile('ATR(14)', fmt(x.atr), `日均波動 ${fmt(x.atr / a.close * 100)}%`)}
    </div>
  </div>`;
}

function planCard(plan) {
  if (!plan) return `<div class="bg-surface rounded-xl border border-line">${emptyState('資料不足，無法計算交易計畫')}</div>`;
  const row = (label, value, sub = '', tone = '') => `<div class="flex justify-between items-baseline gap-3 py-1.5">
    <span class="text-sm text-muted">${esc(label)}</span>
    <span class="text-right num ${tone}">${value}${sub ? `<span class="text-xs text-muted ml-1.5">${sub}</span>` : ''}</span></div>`;

  return `<div class="bg-surface rounded-xl border border-line">
    <div class="px-5 py-3.5 border-b border-line-soft flex items-center justify-between gap-2">
      <h2 class="font-semibold">交易計畫</h2>
      <span class="text-xs px-2 py-0.5 rounded border ${plan.actionable ? TONE_STYLE.up : TONE_STYLE.neutral}">${plan.actionable ? '符合進場條件' : '僅供持股者參考'}</span>
    </div>
    <div class="px-5 py-3 divide-y divide-line-soft">
      ${row('參考進場', fmt(plan.entry))}
      ${row('停損', fmt(plan.stop), `${fmt(plan.stopPct)}%`, 'text-down')}
      ${row('第一目標（中軌）', fmt(plan.target1))}
      ${row('第二目標（上緣）', fmt(plan.target2), pctText(plan.target2Pct), 'text-up')}
      ${row('風險報酬比', plan.riskReward === null ? '—' : `1 : ${fmt(plan.riskReward)}`, '', plan.riskReward >= 1.5 ? 'text-ok' : 'text-warn')}
    </div>
    <div class="px-5 pb-5 pt-2">
      <div class="text-xs text-muted mb-2">部位大小（虧損上限 ÷ 每股停損距離）</div>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <label class="flex items-center gap-1.5">資金
          <input id="ta-capital" type="number" min="10000" step="10000" value="${esc(plan.sizing.capital)}" class="w-28 px-2 py-1 text-sm rounded border border-line num"></label>
        <label class="flex items-center gap-1.5">單筆風險
          <input id="ta-risk" type="number" min="0.1" max="10" step="0.5" value="${esc(plan.sizing.riskPct)}" class="w-16 px-2 py-1 text-sm rounded border border-line num">%</label>
      </div>
      <div class="mt-2 text-sm">最多 <span class="num font-semibold">${fmtInt(plan.sizing.maxLots)}</span> 張
        <span class="text-xs text-muted">（停損時虧損約 ${fmtMoney(plan.sizing.capital * plan.sizing.riskPct / 100)}）</span></div>
      ${plan.notes.length ? `<ul class="mt-3 space-y-1">${plan.notes.map((n) => `<li class="text-xs text-warn flex gap-1.5">
        <svg class="w-3 h-3 inline-block shrink-0 mt-0.5" aria-hidden="true"><use href="#i-warning"/></svg><span>${esc(n)}</span></li>`).join('')}</ul>` : ''}
    </div>
  </div>`;
}

function backtestCard(bt) {
  const strategies = Object.entries(bt.strategies);
  const cell = (n, suffix = '%') => (n === null ? '—' : `${n > 0 && suffix === '%' ? '+' : ''}${fmt(n)}${suffix}`);
  const rows = strategies.map(([, s]) => `<tr>
      <td class="px-5 py-2.5 whitespace-nowrap">${esc(s.label)}</td>
      <td class="px-3 py-2.5 text-right num">${s.count}</td>
      <td class="px-3 py-2.5 text-right num">${s.winRate === null ? '—' : `${fmt(s.winRate, 1)}%`}</td>
      <td class="px-3 py-2.5 text-right num ${trendClass(s.avgReturnPct)}">${cell(s.avgReturnPct)}</td>
      <td class="px-3 py-2.5 text-right num ${trendClass(s.totalReturnPct)}">${cell(s.totalReturnPct)}</td>
      <td class="px-3 py-2.5 text-right num hidden sm:table-cell text-sub">${cell(s.worstPct)}</td>
    </tr>`).join('');

  const pure = bt.strategies.channel;
  const conf = bt.strategies.confirmed;
  const insights = [];
  if (pure.winRate !== null && conf.winRate !== null && conf.closedCount >= 3) {
    const diff = conf.winRate - pure.winRate;
    insights.push(Math.abs(diff) < 5
      ? `加上指標確認後勝率差不多（${fmt(pure.winRate, 1)}% → ${fmt(conf.winRate, 1)}%），在這檔股票上指標過濾的效果有限。`
      : diff > 0
        ? `加上指標確認後，勝率從 ${fmt(pure.winRate, 1)}% 提高到 ${fmt(conf.winRate, 1)}%，交易次數從 ${pure.count} 次減到 ${conf.count} 次——少做、做對。`
        : `加上指標確認反而讓勝率從 ${fmt(pure.winRate, 1)}% 降到 ${fmt(conf.winRate, 1)}%，這檔股票可能不適合用指標過濾。`);
  }
  const best = Math.max(pure.totalReturnPct ?? -Infinity, conf.totalReturnPct ?? -Infinity);
  if (bt.buyHoldPct !== null && Number.isFinite(best) && bt.buyHoldPct > best + 10) {
    insights.push(`同期間買進持有報酬 ${pctText(bt.buyHoldPct)}，遠高於通道波段操作——強勢多頭中「碰上緣就賣」會錯過主升段，持股可以改用「跌破下緣才出場」。`);
  }
  if ((pure.count ?? 0) < 4) insights.push('交易次數太少，統計上不足以下結論，只能當參考。');

  const recent = (conf.trades.length ? conf : pure).trades;
  return `<div class="bg-surface rounded-xl border border-line mt-6">
    <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">歷史驗證：你的通道規則在這檔股票上管不管用？</h2>
      <span class="text-xs text-muted num">${esc(bt.from)} ～ ${esc(bt.to)} · 已扣來回成本 ${fmt(bt.costPct, 3)}%</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-raised text-muted text-xs"><tr>
          <th class="text-left font-medium whitespace-nowrap px-5 py-2.5">策略</th>
          <th class="text-right font-medium whitespace-nowrap px-3 py-2.5">交易次數</th>
          <th class="text-right font-medium whitespace-nowrap px-3 py-2.5">勝率</th>
          <th class="text-right font-medium whitespace-nowrap px-3 py-2.5">平均每筆</th>
          <th class="text-right font-medium whitespace-nowrap px-3 py-2.5">累積報酬</th>
          <th class="text-right font-medium whitespace-nowrap px-3 py-2.5 hidden sm:table-cell">最差一筆</th>
        </tr></thead>
        <tbody class="divide-y divide-line-soft">
          ${rows}
          <tr class="text-sub"><td class="px-5 py-2.5 whitespace-nowrap">對照：同期間買進持有</td><td></td><td></td><td></td>
            <td class="px-3 py-2.5 text-right num ${trendClass(bt.buyHoldPct)}">${cell(bt.buyHoldPct)}</td><td class="hidden sm:table-cell"></td></tr>
        </tbody>
      </table>
    </div>
    ${insights.length ? `<ul class="px-5 pt-4 space-y-1.5">${insights.map((s) => `<li class="text-sm text-ink flex gap-1.5">
      <svg class="w-4 h-4 inline-block shrink-0 text-brand-500 mt-0.5" aria-hidden="true"><use href="#i-lightbulb"/></svg><span>${esc(s)}</span></li>`).join('')}</ul>` : ''}
    <details class="px-5 py-4">
      <summary class="text-sm text-accent-ink cursor-pointer">最近 ${recent.length} 筆交易明細</summary>
      ${recent.length === 0 ? '<p class="text-sm text-faint mt-2">期間內沒有觸發交易</p>' : `
      <div class="overflow-x-auto mt-2"><table class="w-full text-xs num">
        <thead class="text-muted"><tr><th class="text-left py-1.5 font-medium">進場</th><th class="text-left font-medium">出場</th>
          <th class="text-right font-medium">進價</th><th class="text-right font-medium">出價</th><th class="text-right font-medium">天數</th>
          <th class="text-right font-medium">報酬</th><th class="text-right font-medium">原因</th></tr></thead>
        <tbody class="divide-y divide-line-soft">${recent.map((tr) => `<tr>
          <td class="py-1.5">${esc(tr.entryDate)}</td><td>${esc(tr.exitDate)}</td>
          <td class="text-right">${fmt(tr.entry)}</td><td class="text-right">${fmt(tr.exit)}</td>
          <td class="text-right">${tr.days}</td><td class="text-right ${trendClass(tr.returnPct)}">${signed(tr.returnPct)}%</td>
          <td class="text-right text-sub">${esc(tr.reason)}</td></tr>`).join('')}</tbody>
      </table></div>`}
    </details>
  </div>`;
}

// ── 技術分析圖（手刻 SVG，不依賴任何圖表函式庫）

const CHART_W = 800;
const PAD = { left: 52, right: 88 };
const series = (n) => `rgb(var(--c-${n}))`;

function chartLegend() {
  const line = (color, label, dash = '') => `<span class="inline-flex items-center gap-1.5">
    <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="${color}" stroke-width="2" ${dash ? `stroke-dasharray="${dash}"` : ''}/></svg>${esc(label)}</span>`;
  const mark = (shape, color, label, stroke = false) => `<span class="inline-flex items-center gap-1.5">
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="${shape}" ${stroke ? `fill="none" stroke="${color}" stroke-width="2"` : `fill="${color}"`}/></svg>${esc(label)}</span>`;
  return `<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-sub mb-2 px-1">
    ${line(series('s1'), '通道上下緣')}
    ${line(series('s1'), '通道中軌', '4 3')}
    ${line(series('s2'), 'MA20 月線')}
    ${line(series('s3'), 'MA60 季線', '6 3')}
    ${mark('M5 1L9 9H1z', series('up'), '指標確認的下緣買點')}
    ${mark('M5 9L9 1H1z', series('down'), '上緣賣訊')}
    ${mark('M1 1L9 9M9 1L1 9', series('warn'), '跌破通道', true)}
  </div>`;
}

function xScale(count) {
  const step = (CHART_W - PAD.left - PAD.right) / count;
  return { step, x: (i) => PAD.left + step * (i + 0.5) };
}

function yScale(min, max, top, bottom) {
  return (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
}

/** 讓格線落在整齊的數字上 */
function niceTicks(min, max, count = 4) {
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(+v.toFixed(6));
  return out;
}

const pathOf = (values, x, y) => {
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
};

function priceChartSvg(c) {
  const H = 320;
  const top = 12;
  const bottom = H - 26;
  const n = c.bars.length;
  const { step, x } = xScale(n);
  const idx = new Map(c.bars.map((b, i) => [b.date, i]));

  const chan = c.channel.map((p) => ({ ...p, i: idx.get(p.date) })).filter((p) => p.i !== undefined);
  const lows = [...c.bars.map((b) => b.low), ...chan.map((p) => p.lower)];
  const highs = [...c.bars.map((b) => b.high), ...chan.map((p) => p.upper)];
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const pad = (max - min) * 0.04;
  min -= pad; max += pad;
  const y = yScale(min, max, top, bottom);

  const grid = niceTicks(min, max, 5).map((v) => `
    <line x1="${PAD.left}" x2="${CHART_W - PAD.right}" y1="${y(v)}" y2="${y(v)}" stroke="rgb(var(--c-line))" stroke-width="1"/>
    <text x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="rgb(var(--c-muted))">${v >= 1000 ? Math.round(v).toLocaleString('zh-TW') : v}</text>`).join('');

  // 月份刻度：每個月第一根 K 線
  const months = c.bars.map((b, i) => ({ i, m: b.date.slice(0, 7) }))
    .filter((p, k, arr) => k === 0 || p.m !== arr[k - 1].m).slice(1);
  const xTicks = months.map((p) => `<text x="${x(p.i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="rgb(var(--c-muted))">${Number(p.m.slice(5))}月</text>`).join('');

  const band = chan.length ? `
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.upper).toFixed(1)}`).join('')}${[...chan].reverse().map((p) => `L${x(p.i).toFixed(1)},${y(p.lower).toFixed(1)}`).join('')}Z"
          fill="${series('s1')}" fill-opacity="0.07"/>
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.upper).toFixed(1)}`).join('')}" fill="none" stroke="${series('s1')}" stroke-width="2"/>
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.lower).toFixed(1)}`).join('')}" fill="none" stroke="${series('s1')}" stroke-width="2"/>
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.mid).toFixed(1)}`).join('')}" fill="none" stroke="${series('s1')}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.8"/>` : '';

  const bodyW = Math.max(1, step * 0.62);
  const candles = c.bars.map((b, i) => {
    const color = b.close >= b.open ? series('up') : series('down');
    const yo = y(b.open);
    const yc = y(b.close);
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${color}" stroke-width="1"/>
      <rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, Math.abs(yo - yc)).toFixed(1)}" fill="${color}"/>`;
  }).join('');

  const markers = c.markers.map((m) => {
    const i = idx.get(m.date);
    if (i === undefined) return '';
    const cx = x(i);
    if (m.kind === 'buy') { const cy = y(m.price) + 10; return `<path d="M${cx},${cy - 5}L${cx + 5},${cy + 4}L${cx - 5},${cy + 4}Z" fill="${series('up')}" stroke="rgb(var(--c-surface))" stroke-width="1.5"><title>${m.date} 下緣買點</title></path>`; }
    if (m.kind === 'sell') { const cy = y(m.price) - 10; return `<path d="M${cx},${cy + 5}L${cx + 5},${cy - 4}L${cx - 5},${cy - 4}Z" fill="${series('down')}" stroke="rgb(var(--c-surface))" stroke-width="1.5"><title>${m.date} 上緣賣訊</title></path>`; }
    const cy = y(m.price) + 11;
    return `<path d="M${cx - 4},${cy - 4}L${cx + 4},${cy + 4}M${cx + 4},${cy - 4}L${cx - 4},${cy + 4}" stroke="${series('warn')}" stroke-width="2"><title>${m.date} 跌破通道</title></path>`;
  }).join('');

  // 右側直接標註：最後一根的通道上下緣與均線值，顏色靠線條，文字維持文字色
  const last = chan[chan.length - 1];
  const labels = [];
  if (last) {
    labels.push({ v: last.upper, text: `上緣 ${fmt(last.upper)}`, color: series('s1') });
    labels.push({ v: last.lower, text: `下緣 ${fmt(last.lower)}`, color: series('s1') });
  }
  const ma20 = c.ma20[n - 1];
  const ma60 = c.ma60[n - 1];
  if (ma20 !== null) labels.push({ v: ma20, text: 'MA20', color: series('s2') });
  if (ma60 !== null) labels.push({ v: ma60, text: 'MA60', color: series('s3') });
  labels.sort((a, b) => y(a.v) - y(b.v));
  let prevY = -Infinity;
  const endLabels = labels.map((l) => {
    const ly = Math.max(y(l.v) + 4, prevY + 13);
    prevY = ly;
    return `<rect x="${CHART_W - PAD.right + 4}" y="${ly - 7}" width="3" height="8" fill="${l.color}"/>
      <text x="${CHART_W - PAD.right + 10}" y="${ly}" font-size="10.5" fill="rgb(var(--c-sub))">${esc(l.text)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${CHART_W} ${H}" class="w-full h-auto block select-none" role="img"
      aria-label="${esc(`近 ${n} 個交易日 K 線、趨勢通道與均線`)}" data-panel="price" data-top="${top}" data-bottom="${bottom}">
    ${grid}${xTicks}${band}
    <path d="${pathOf(c.ma60, x, y)}" fill="none" stroke="${series('s3')}" stroke-width="1.5" stroke-dasharray="6 3"/>
    <path d="${pathOf(c.ma20, x, y)}" fill="none" stroke="${series('s2')}" stroke-width="1.5"/>
    ${candles}${markers}${endLabels}
    <line class="ta-cross" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="rgb(var(--c-faint))" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>
    <rect x="${PAD.left}" y="0" width="${CHART_W - PAD.left - PAD.right}" height="${H}" fill="transparent" class="ta-hit"/>
  </svg>`;
}

function oscChartSvg(c, kind) {
  const H = 96;
  const top = 16;
  const bottom = H - 8;
  const n = c.bars.length;
  const { x } = xScale(n);
  const y = yScale(0, 100, top, bottom);
  const refs = kind === 'rsi' ? [30, 70] : [20, 80];
  const title = kind === 'rsi' ? 'RSI(14)' : 'KD(9,3,3)';
  const lines = kind === 'rsi'
    ? `<path d="${pathOf(c.rsi, x, y)}" fill="none" stroke="${series('s1')}" stroke-width="1.5"/>`
    : `<path d="${pathOf(c.k, x, y)}" fill="none" stroke="${series('s1')}" stroke-width="1.5"/>
       <path d="${pathOf(c.d, x, y)}" fill="none" stroke="${series('s2')}" stroke-width="1.5"/>`;
  const lastVals = kind === 'rsi'
    ? [{ v: c.rsi[n - 1], t: 'RSI', color: series('s1') }]
    : [{ v: c.k[n - 1], t: 'K', color: series('s1') }, { v: c.d[n - 1], t: 'D', color: series('s2') }];
  let prevY = -Infinity;
  const endLabels = lastVals.filter((l) => l.v !== null).sort((a, b) => y(a.v) - y(b.v)).map((l) => {
    const ly = Math.max(y(l.v) + 4, prevY + 12);
    prevY = ly;
    return `<rect x="${CHART_W - PAD.right + 4}" y="${ly - 7}" width="3" height="8" fill="${l.color}"/>
      <text x="${CHART_W - PAD.right + 10}" y="${ly}" font-size="10.5" fill="rgb(var(--c-sub))">${l.t} ${fmt(l.v, 1)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${CHART_W} ${H}" class="w-full h-auto block select-none mt-1" role="img" aria-label="${title}" data-panel="${kind}" data-top="${top}" data-bottom="${bottom}">
    <text x="${PAD.left}" y="11" font-size="11" fill="rgb(var(--c-muted))">${title}</text>
    <rect x="${PAD.left}" y="${y(refs[1])}" width="${CHART_W - PAD.left - PAD.right}" height="${y(refs[0]) - y(refs[1])}" fill="rgb(var(--c-track))" opacity="0.6"/>
    ${refs.map((r) => `<text x="${PAD.left - 6}" y="${y(r) + 4}" text-anchor="end" font-size="10.5" fill="rgb(var(--c-muted))">${r}</text>`).join('')}
    ${lines}${endLabels}
    <line class="ta-cross" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="rgb(var(--c-faint))" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>
    <rect x="${PAD.left}" y="0" width="${CHART_W - PAD.left - PAD.right}" height="${H}" fill="transparent" class="ta-hit"/>
  </svg>`;
}

/** 三張圖共用一條十字線與一個 tooltip */
function bindChartHover(c) {
  const wrap = $('ta-charts');
  const tip = $('ta-tip');
  if (!wrap || !tip) return;
  const n = c.bars.length;
  const { x } = xScale(n);
  const chanByDate = new Map(c.channel.map((p) => [p.date, p]));

  const hide = () => {
    tip.classList.add('hidden');
    wrap.querySelectorAll('.ta-cross').forEach((l) => l.setAttribute('visibility', 'hidden'));
  };

  const show = (event) => {
    const svg = event.target.closest('svg');
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vx = ((event.clientX - rect.left) / rect.width) * CHART_W;
    const i = Math.max(0, Math.min(n - 1, Math.round((vx - PAD.left) / ((CHART_W - PAD.left - PAD.right) / n) - 0.5)));
    const b = c.bars[i];
    const prev = c.bars[i - 1];
    const chg = prev ? (b.close / prev.close - 1) * 100 : null;
    const ch = chanByDate.get(b.date);

    wrap.querySelectorAll('.ta-cross').forEach((l) => {
      l.setAttribute('x1', x(i)); l.setAttribute('x2', x(i)); l.setAttribute('visibility', 'visible');
    });

    const line = (k, v, cls = '') => `<div class="flex justify-between gap-4"><span class="text-muted">${k}</span><span class="${cls}">${v}</span></div>`;
    tip.innerHTML = `<div class="font-medium mb-1">${esc(b.date)}</div>
      ${line('開 / 收', `${fmt(b.open)} / ${fmt(b.close)}`)}
      ${line('高 / 低', `${fmt(b.high)} / ${fmt(b.low)}`)}
      ${line('漲跌', chg === null ? '—' : `${signed(chg)}%`, trendClass(chg))}
      ${line('成交量', `${fmtInt(b.volume / 1000)} 張`)}
      ${ch ? line('通道上 / 下', `${fmt(ch.upper)} / ${fmt(ch.lower)}`) : ''}
      ${line('MA20 / MA60', `${fmt(c.ma20[i])} / ${fmt(c.ma60[i])}`)}
      ${line('RSI', fmt(c.rsi[i], 1))}
      ${line('K / D', `${fmt(c.k[i], 1)} / ${fmt(c.d[i], 1)}`)}`;
    tip.classList.remove('hidden');

    const wrapRect = wrap.getBoundingClientRect();
    const px = rect.left - wrapRect.left + (x(i) / CHART_W) * rect.width;
    const tipW = tip.offsetWidth;
    const left = px + 14 + tipW > wrapRect.width ? px - 14 - tipW : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, event.clientY - wrapRect.top - tip.offsetHeight / 2)}px`;
  };

  wrap.querySelectorAll('.ta-hit').forEach((hit) => {
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide);
  });
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

  if (name === 'technical') loadTechnical();

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
    const target = event.target.closest('[data-tab], [data-add-watch], [data-remove-watch], [data-remove-holding], [data-risk], [data-goal], [data-news-filter], [data-remove-rule], [data-ta-code], [data-ta-lookback], [data-ta-open]');
    if (!target) return;

    const d = target.dataset;

    if (d.tab) return switchTab(d.tab);

    if (d.addWatch) return addToWatchlist(d.addWatch);

    if (d.taOpen) {
      profile.taCode = d.taOpen;
      saveProfile();
      return switchTab('technical');
    }

    if (d.taCode) {
      profile.taCode = d.taCode;
      saveProfile();
      return loadTechnical();
    }

    if (d.taLookback) {
      profile.taLookback = Number(d.taLookback);
      saveProfile();
      return loadTechnical();
    }

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

  // ── 技術分析：自訂代號、資金與風險（輸入框在每次渲染時重建，所以用事件委派）
  const goTechnical = () => {
    const code = $('ta-code').value.trim().toUpperCase();
    if (!code) return;
    profile.taCode = code;
    saveProfile();
    $('ta-code').value = '';
    loadTechnical();
  };
  $('ta-go').addEventListener('click', goTechnical);
  $('ta-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') goTechnical(); });
  document.addEventListener('change', (event) => {
    if (event.target.id === 'ta-capital') {
      profile.taCapital = Math.max(10000, Number(event.target.value) || 1000000);
    } else if (event.target.id === 'ta-risk') {
      profile.taRiskPct = Math.max(0.1, Math.min(10, Number(event.target.value) || 1));
    } else return;
    saveProfile();
    loadTechnical();
  });

  $('refresh').addEventListener('click', () => {
    refresh();
    if ($('tab-technical').classList.contains('active')) {
      taCache.clear();
      loadTechnical({ force: true });
    }
  });

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
refresh();
scheduleRefresh();
