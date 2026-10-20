/* 台股脈動 — 前端邏輯
 *
 * 設計要點：
 *  - 個人化設定全部存 localStorage，每次查詢隨請求送出。後端零狀態。
 *  - 只有一支主要 API（POST /api/dashboard），畫面所有區塊都由它的
 *    回應渲染，避免多支端點之間的資料不一致。
 *  - 台股慣例紅漲綠跌，與歐美相反，全站配色一致遵守。
 */

const STORAGE_KEY = 'tw-stock-pulse/profile/v1';

/**
 * 預設自選股（與 data/watchlist.json 同步，那份給每日報告用）：依使用者券商 App 的分組排列（持股放最前面，技術分析分頁
 * 預設就會先打開第一檔）。這是策略分析工具，不記錄股數、成本或損益。
 */
const DEFAULT_WATCHLIST = [
  // 目前持股
  '5880', '00919', '00931B',
  // 製程・材料
  '2338', '1711', '3532', '6488', '5347', '2303', '2330',
  // 散熱・封裝測試・伺服器
  '2382', '2449', '3017', '6805', '3324', '6275', '6669',
  // 記憶體・PCB
  '3323', '8358', '2383', '6274', '3037', '8046', '5289', '3260', '2344', '2408',
];

/**
 * 預設持股（與 data/watchlist.json 的 holdings 同步）。總覽把持股與其他自選股分兩個區塊顯示；
 * 持股一定也在自選股裡，所以每日盤後更新讀雲端的 watchlist 就涵蓋了持股。
 * 只取確實在預設自選股裡的，展示版（樣本只有部分個股）才不會出現查無資料的持股。
 */
const DEFAULT_HOLDINGS = ['5880', '00919', '00931B'];

/** 舊版的預設清單。存檔若還是一字不差的舊預設，代表沒被改過，可以安全換成新預設 */
const LEGACY_DEFAULT_WATCHLIST = ['2330', '2317', '2454', '2881', '2603'];

const DEFAULT_PROFILE = {
  watchlist: DEFAULT_WATCHLIST,
  holdings: [],
  rules: [],
  risk: 'balanced',
  goals: ['dividend'],
  refreshSeconds: 60,
  newsFilter: 'all',
  theme: 'system',
  taCode: null,
  taLookback: 120,
  // K 線圖顯示幾根（0 = 全部）；各裝置螢幕不同，不跟雲端同步
  taBars: 120,
  // 側欄收合、自選股排序：各裝置的瀏覽習慣，不跟雲端同步
  sidebarCollapsed: false,
  watchSort: 'list',
  watchSortDir: 'desc',
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

const TABS = [
  ['overview', '總覽', 'gauge'],
  ['technical', '技術分析', 'chart-line'],
  ['radar', '產業雷達', 'fire'],
  ['news', '個人化新聞', 'newspaper'],
  ['recommend', '推薦標的', 'lightbulb'],
];

const FACTOR_LABELS = {
  dividend: '股利', value: '價值', momentum: '動能',
  liquidity: '流動性', diversify: '分散度',
};

// ── 狀態 ─────────────────────────────────────────────

/** 每次都給新的陣列：直接展開 DEFAULT_PROFILE 會共用陣列，push 自選股時會改到預設值本身 */
const freshDefaults = () => ({
  ...DEFAULT_PROFILE,
  watchlist: [...DEFAULT_WATCHLIST],
  holdings: DEFAULT_HOLDINGS.filter((c) => DEFAULT_WATCHLIST.includes(c)),
  rules: [],
  goals: [...DEFAULT_PROFILE.goals],
});

/** 持股必須在自選股裡（自選股被移除或雲端清單沒有時，持股跟著拿掉），並去除重複 */
function pruneHoldings(p) {
  p.holdings = [...new Set(Array.isArray(p.holdings) ? p.holdings : [])].filter((c) => p.watchlist.includes(c));
  return p;
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshDefaults();
    // 合併預設值，讓舊版存檔在新增欄位後仍可用
    const saved = { ...freshDefaults(), ...JSON.parse(raw) };
    // 只換掉「從沒動過的舊預設」；使用者自己改過的清單一律保留
    if (JSON.stringify(saved.watchlist) === JSON.stringify(LEGACY_DEFAULT_WATCHLIST)) {
      saved.watchlist = [...DEFAULT_WATCHLIST];
    }
    return pruneHoldings(saved);
  } catch {
    return freshDefaults();
  }
}

let profile = loadProfile();
let latest = null;
let refreshTimer = null;
let inFlight = false;

function saveLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch (err) {
    console.warn('無法寫入 localStorage：', err.message);
  }
}

function saveProfile() {
  saveLocal();
  scheduleCloudPush();
}

// ── 雲端同步 ─────────────────────────────────────────
//
// 發布成 Claude artifact 時，頁面有一個專屬的小資料庫（db 能力）。自選股、
// 提醒規則與偏好存在那裡，手機、電腦打開都是同一份；每日盤後更新也從那裡讀
// 自選股清單，決定要抓哪些股票的資料。用 npm start 跑或直接開檔案時沒有這個
// 能力，就照舊只存在這台瀏覽器的 localStorage。
//
// 主題與「目前看哪一檔」刻意不同步：每台裝置各自的瀏覽習慣。

const SYNC_KEYS = ['watchlist', 'holdings', 'rules', 'risk', 'goals', 'newsFilter', 'taLookback', 'taCapital', 'taRiskPct', 'refreshSeconds'];
const PROFILE_DOC = 'profile/main';
const cloud = { ref: null, state: 'local', lastJson: null, timer: null, readOnly: false, writing: Promise.resolve() };

const syncedPart = (p) => Object.fromEntries(SYNC_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

const SYNC_TEXT = {
  local: ['只存在這台瀏覽器', '自選股與提醒只存在這台瀏覽器，換裝置不會跟著走。'],
  connecting: ['連線雲端中…', '正在讀取雲端的自選股與提醒…'],
  synced: ['已雲端同步', '自選股、提醒規則與偏好已同步到雲端：手機、電腦打開都是同一份；每日盤後更新也會依這份清單抓資料。'],
  readonly: ['唯讀', '這份自選股由擁有者維護，你可以瀏覽，但變更不會儲存到雲端。'],
  error: ['同步暫時失敗', '雲端同步暫時失敗，變更先存在這台瀏覽器，恢復後會再同步。'],
};

function setSyncState(state) {
  cloud.state = state;
  const [short, long] = SYNC_TEXT[state] || SYNC_TEXT.local;
  if ($('sync-status')) $('sync-status').textContent = long;
  if ($('sync-badge')) {
    $('sync-badge').textContent = short;
    $('sync-badge').className = `text-[11px] ${state === 'synced' ? 'text-emerald-400' : state === 'error' ? 'text-amber-400' : 'text-slate-500'}`;
  }
}

async function initCloudSync() {
  const c = window.claude;
  if (!c?.use) return setSyncState('local');
  setSyncState('connecting');
  let db = null;
  let user = null;
  try {
    [db, user] = await Promise.all([c.use('db'), c.use('user')]);
  } catch {
    db = null;
  }
  if (!db) return setSyncState('local');

  try {
    cloud.readOnly = (await user?.can('data.write')) === false;
  } catch {
    cloud.readOnly = false;
  }
  cloud.ref = db.doc(PROFILE_DOC);

  cloud.ref.onSnapshot((snap) => {
    if (!snap.exists) {
      // 雲端還沒有設定：由這台裝置建立第一份
      setSyncState(cloud.readOnly ? 'readonly' : 'synced');
      if (!cloud.readOnly) scheduleCloudPush(true);
      return;
    }
    const remote = syncedPart(snap.data());
    const json = JSON.stringify(remote);
    setSyncState(cloud.readOnly ? 'readonly' : 'synced');
    if (json === cloud.lastJson) return; // 自己剛寫上去的回音
    cloud.lastJson = json;
    if (json === JSON.stringify(syncedPart(profile))) return;
    profile = pruneHoldings({ ...profile, ...remote });
    saveLocal();
    applyRemoteProfile();
  }, () => setSyncState('error'));
}

/** 寫入合併成一次：連續操作（例如一直點）只在停下來後寫一次 */
function scheduleCloudPush(immediate = false) {
  if (!cloud.ref || cloud.readOnly) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(pushCloud, immediate ? 0 : 600);
}

function pushCloud() {
  const body = syncedPart(profile);
  const json = JSON.stringify(body);
  if (json === cloud.lastJson) return;
  cloud.lastJson = json;
  // 同一份文件一次只寫一筆：排在前一筆後面
  cloud.writing = cloud.writing.then(() => cloud.ref.set({ ...body, updatedAt: new Date().toISOString() }))
    .then(() => setSyncState('synced'))
    .catch((err) => {
      cloud.lastJson = null;
      if (err?.code === 'invalid_argument' || err?.code === 'not_granted') {
        cloud.readOnly = true;
        setSyncState('readonly');
      } else {
        setSyncState('error');
      }
    });
}

/** 別台裝置改了設定：重畫目前的畫面 */
function applyRemoteProfile() {
  scheduleRefresh();
  taCache.clear();
  refresh();
  const active = document.querySelector('.tab-content.active')?.id?.replace('tab-', '');
  if (active === 'technical') {
    if (!profile.watchlist.includes(profile.taCode)) profile.taCode = null;
    loadTechnical();
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

/**
 * 操作結果與錯誤訊息。刻意不用 alert()：嵌入式預覽（例如 Claude 的 artifact
 * 檢視器）會直接吞掉 alert／confirm，使用者只會覺得按鈕壞了。
 */
let toastTimer = null;
function notify(message, kind = 'ok') {
  const el = $('toast');
  if (!el) return;
  const styles = {
    ok: 'bg-ink text-canvas',
    error: 'bg-danger-bg text-danger border border-danger-line',
  };
  el.className = `fixed left-1/2 -translate-x-1/2 z-50 max-w-[calc(100vw-2rem)] px-4 py-2.5 rounded-lg shadow-lg text-sm ${styles[kind] || styles.ok}`;
  el.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), kind === 'error' ? 5000 : 3000);
}

/** 欄位驗證失敗：提示並把游標帶到該欄 */
function invalid(id, message) {
  notify(message, 'error');
  const field = $(id);
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

/** 空白欄位不能當成 0 —— Number('') 是 0，會讓「沒填」被當成有效的 0 */
const numberFrom = (id) => {
  const raw = $(id).value.trim();
  return raw === '' ? NaN : Number(raw);
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
        // 總覽每檔的通道判讀，用跟技術分析分頁相同的通道長度
        lookback: profile.taLookback,
        rules: profile.rules,
        risk: profile.risk,
        goals: profile.goals,
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
    info: 'bg-accent-bg border-accent-line text-accent-ink',
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
  if (d.snapshot) {
    showBanner('info', d.snapshot.note);
  } else if (d.offline) {
    showBanner('warn', '離線模式：畫面上的數字來自內建樣本資料，非真實行情', d.notes);
  } else if (d.degraded) {
    showBanner('warn', '部分資料來源暫時失效，畫面上的數字可能不完整或稍舊', [...d.notes, ...d.sourceErrors]);
  } else {
    $('banner').classList.add('hidden');
  }

  $('updated').textContent = d.snapshot
    ? `資料至 ${d.snapshot.asOf}`
    : `更新於 ${new Date(latest.updatedAt).toLocaleTimeString('zh-TW')}`;
  $('side-status').innerHTML = d.snapshot
    ? `<span class="text-emerald-400">盤後快照 · ${esc(d.snapshot.asOf)}</span>`
    : d.offline
      ? '<span class="text-amber-400">離線樣本資料</span>'
      : d.degraded
        ? '<span class="text-amber-400">部分來源異常</span>'
        : '<span class="text-emerald-400">資料正常</span>';

  renderOverview();
  renderNews();
  renderRecommend();
  // 自選股名稱要等 dashboard 回來才有，技術分析的標的清單跟著更新
  if ($('tab-technical').classList.contains('active')) renderTechnicalControls();
}

// ── 總覽 ─────────────────────────────────────────────
//
// 一眼看完三件事：市場今天怎樣、持股現在在通道與箱型的哪裡、自選股裡誰出現訊號。
// 圖依容器實際寬度畫（不是固定 viewBox 縮放），字和線在任何螢幕上都是原本的大小。

function renderOverview() {
  renderMarket();
  renderHoldings();
  renderWatchlist();
}

const fmtTurnover = (n) => (!Number.isFinite(n) ? '—'
  : n >= 1e12 ? `${(n / 1e12).toFixed(2)} 兆` : `${Math.round(n / 1e8).toLocaleString('zh-TW')} 億`);

/** 圖例：線用短線、區塊用方塊，與圖上的記號一致 */
function legendHtml(items) {
  return `<div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-sub">${items.map(([label, color, kind = 'line']) => `
    <span class="inline-flex items-center gap-1.5">${kind === 'box'
      ? `<span class="inline-block w-2.5 h-2.5 rounded-sm" style="background:${color}"></span>`
      : `<svg width="16" height="8" aria-hidden="true"><line x1="0" y1="4" x2="16" y2="4" stroke="${color}" stroke-width="2" ${kind === 'dash' ? 'stroke-dasharray="4 3"' : ''}/></svg>`}${esc(label)}</span>`).join('')}</div>`;
}

function renderMarket() {
  const m = latest.market;
  const idx = m.index;
  $('ov-asof').textContent = idx ? `資料至 ${idx.date}` : '';

  $('ov-index').innerHTML = idx ? `
    <div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div>
        <div class="text-sm text-muted">加權指數</div>
        <div class="flex flex-wrap items-baseline gap-x-3 mt-0.5">
          <span class="text-3xl font-semibold">${esc(Math.round(idx.close).toLocaleString('zh-TW'))}</span>
          <span class="text-base font-medium num ${trendClass(idx.change)}">${signed(idx.change)}（${signed(idx.changePercent)}%）</span>
        </div>
      </div>
      ${legendHtml([['收盤', series('s1')], ['MA20 月線', series('s2')], ['MA60 季線', series('s3'), 'dash']])}
    </div>
    <div id="ov-index-chart" class="relative mt-3"></div>`
    : `<div class="text-sm text-muted">加權指數</div>${emptyState('這次沒有抓到加權指數', 'chart-line')}`;
  if (idx) {
    drawLineChart($('ov-index-chart'), {
      dates: idx.series.map((p) => p.date),
      height: 240,
      series: [
        { label: '收盤', values: idx.series.map((p) => p.close), color: series('s1'), width: 2, area: true, endLabel: true },
        { label: 'MA20', values: idx.series.map((p) => p.ma20), color: series('s2'), width: 1.5 },
        { label: 'MA60', values: idx.series.map((p) => p.ma60), color: series('s3'), width: 1.5, dash: '5 3' },
      ],
      format: (v) => Math.round(v).toLocaleString('zh-TW'),
    });
  }

  renderBreadth(m.summary);
  renderSectors(m.summary);
  renderFlowsOverview();
  // 類股成交與法人資料在產業雷達的回應裡；總覽也要用，背景載入一次就好
  if (!radarLatest && !radarLoading) loadRadar({ quiet: true });
}

function renderBreadth(sum) {
  if (!sum || !sum.total) {
    $('ov-breadth').innerHTML = `<div class="text-sm text-muted">漲跌家數</div>${emptyState('沒有全市場行情', 'chart-pie')}`;
    return;
  }
  const seg = [
    ['上漲', sum.up, 'bg-up'],
    ['平盤', sum.flat, 'bg-faint'],
    ['下跌', sum.down, 'bg-down'],
  ];
  const totals = radarLatest?.ok ? radarLatest.rotation?.totals ?? [] : [];
  const avg20 = totals.length ? totals.reduce((a, t) => a + t.total, 0) / totals.length : null;
  const lastTwse = totals.at(-1)?.total ?? null;

  $('ov-breadth').innerHTML = `
    <div class="text-sm text-muted">漲跌家數</div>
    <div class="flex items-baseline gap-2 mt-0.5">
      <span class="text-3xl font-semibold">${esc(((sum.up / sum.total) * 100).toFixed(0))}%</span>
      <span class="text-sm text-sub">上漲占比（共 ${esc(sum.total.toLocaleString('zh-TW'))} 檔）</span>
    </div>
    <div class="flex h-3 mt-3 gap-[2px]" role="img" aria-label="上漲 ${sum.up}、平盤 ${sum.flat}、下跌 ${sum.down} 檔">
      ${seg.filter(([, n]) => n > 0).map(([label, n, cls], k, arr) => `<div class="${cls} ${k === 0 ? 'rounded-l' : ''} ${k === arr.length - 1 ? 'rounded-r' : ''}"
        style="width:${((n / sum.total) * 100).toFixed(2)}%" title="${label} ${n} 檔"></div>`).join('')}
    </div>
    <div class="flex justify-between mt-2 text-sm">
      ${seg.map(([label, n, cls]) => `<span class="inline-flex items-center gap-1.5"><span class="inline-block w-2.5 h-2.5 rounded-sm ${cls}"></span>${label} <span class="num font-medium">${n.toLocaleString('zh-TW')}</span></span>`).join('')}
    </div>

    <div class="mt-6 pt-4 border-t border-line-soft">
      <div class="text-sm text-muted">全市場成交值</div>
      <div class="flex flex-wrap items-baseline gap-x-2 mt-0.5">
        <span class="text-2xl font-semibold">${esc(fmtTurnover(sum.turnover))}</span>
        ${avg20 && lastTwse ? `<span class="text-sm text-sub">上市較 20 日均 <span class="num ${trendClass(lastTwse - avg20)}">${signed((lastTwse / avg20 - 1) * 100)}%</span></span>` : ''}
      </div>
      ${totals.length ? `<div id="ov-turnover-chart" class="mt-2"></div><div class="text-xs text-muted mt-1">上市成交值・近 ${totals.length} 個交易日（最後一根是最新一天）</div>`
        : `<div class="text-xs text-faint mt-2">${radarLoading ? '近 20 日成交值載入中…' : ''}</div>`}
    </div>`;
  if (totals.length) {
    drawColumns($('ov-turnover-chart'), {
      values: totals.map((t) => t.total),
      labels: totals.map((t) => `${t.date}　${fmtTurnover(t.total)}`),
      height: 72,
    });
  }
}

/**
 * 正負對稱的水平長條（台股慣例：漲／買超紅色往右，跌／賣超綠色往左）。
 * 數值另外寫在條尾並帶正負號，不只靠顏色分辨方向。
 */
function divergingRows(rows, { format, unit = '', expand = null }) {
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1e-9);
  return `<ul class="space-y-0.5">${rows.map((r) => {
    const w = (Math.abs(r.value) / max) * 100;
    const bar = `<div class="h-3.5 ${r.value >= 0 ? 'bg-up rounded-r' : 'bg-down rounded-l'}" style="width:${w.toFixed(1)}%"></div>`;
    const open = expand && expand.open === r.name;
    const inner = `
      <span class="w-28 shrink-0 break-words leading-tight text-sub">${expand ? `<span class="inline-block w-3 text-faint">${open ? '▾' : '▸'}</span>` : ''}${esc(r.name)}</span>
      <div class="flex-1 flex items-center min-w-0">
        <div class="w-1/2 flex justify-end">${r.value < 0 ? bar : ''}</div>
        <div class="w-px h-5 bg-line shrink-0"></div>
        <div class="w-1/2 flex">${r.value >= 0 ? bar : ''}</div>
      </div>
      <span class="w-20 shrink-0 text-right num font-medium">${esc(format(r.value))}${esc(unit)}</span>`;
    return `<li title="${esc(r.title || '')}">${expand
      ? `<button data-ov-expand="${expand.kind}" data-name="${esc(r.name)}" aria-expanded="${open}"
           class="w-full flex items-center gap-3 text-sm text-left rounded-md px-1.5 py-1 hover:bg-raised ${open ? 'bg-raised' : ''}">${inner}</button>
         ${open ? `<div class="px-1.5 pt-1 pb-3">${expand.detail(r.name)}</div>` : ''}`
      : `<div class="flex items-center gap-3 text-sm px-1.5 py-1">${inner}</div>`}</li>`;
  }).join('')}</ul>`;
}

/** 總覽裡點開的產業（每張卡各自只開一個） */
const ovOpen = { sector: null, flow: null };
const ovShowAll = { sector: false };
const sectorCache = new Map();

async function loadSectorStocks(name) {
  if (sectorCache.has(name)) return;
  sectorCache.set(name, null); // 載入中
  try {
    const res = await fetch(`/api/sector?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`);
    sectorCache.set(name, await res.json());
  } catch (err) {
    sectorCache.set(name, { error: err.message });
  }
  if (ovOpen.sector === name && latest) renderSectors(latest.market.summary);
}

/** 個股列：名稱點下去看技術分析；不在自選的可以直接加入 */
function stockLine(s, right) {
  const watching = profile.watchlist.includes(s.code);
  return `<li class="flex items-start gap-2 py-1.5 text-sm">
    <button data-ta-open="${esc(s.code)}" class="min-w-0 flex-1 text-left break-words leading-snug hover:text-accent-ink hover:underline" title="${esc(s.name)} ${esc(s.code)}・看技術分析">
      <span class="font-medium">${esc(s.name)}</span> <span class="text-xs text-muted num whitespace-nowrap">${esc(s.code)}</span></button>
    ${right}
    ${watching
      ? '<span class="w-12 shrink-0 text-right text-[11px] text-faint">已在自選</span>'
      : `<button data-add-watch="${esc(s.code)}" class="w-12 shrink-0 text-right text-xs text-accent-ink hover:underline" title="加入自選">＋自選</button>`}
  </li>`;
}

function sectorDetail(name) {
  const r = sectorCache.get(name);
  if (r === undefined || r === null) return '<p class="text-xs text-muted py-2">載入中…</p>';
  if (r.error) return `<p class="text-xs text-danger py-2">載入失敗：${esc(r.error)}</p>`;
  if (!r.stocks.length) return '<p class="text-xs text-muted py-2">這個產業今天沒有成交資料</p>';
  const limit = 12;
  const list = ovShowAll.sector ? r.stocks : r.stocks.slice(0, limit);
  return `<div class="text-[11px] text-muted mb-1">${r.count} 檔，依今日成交值排序</div>
    <ul class="divide-y divide-line-soft">${list.map((s) => stockLine(s, `
      <span class="w-16 shrink-0 text-right num">${fmt(s.close)}</span>
      <span class="w-16 shrink-0 text-right num ${trendClass(s.changePercent)}">${signed(s.changePercent)}%</span>
      <span class="w-16 shrink-0 text-right num text-xs text-muted hidden sm:inline">${esc(fmtTurnover(s.turnover))}</span>`)).join('')}</ul>
    ${r.stocks.length > limit ? `<button data-ov-showall="sector" class="mt-1 text-xs text-accent-ink hover:underline">${ovShowAll.sector ? '只看前 12 檔' : `顯示全部 ${r.stocks.length} 檔`}</button>` : ''}`;
}

function flowDetail(name) {
  const st = radarLatest?.flows?.stocks;
  const buys = st?.bySector?.[name] ?? [];
  const sells = st?.sellBySector?.[name] ?? [];
  if (!buys.length && !sells.length) return '<p class="text-xs text-muted py-2">沒有這個產業的個股明細</p>';
  const col = (title, list) => `<div class="min-w-0">
    <div class="text-[11px] text-muted mb-0.5">${title}</div>
    ${list.length ? `<ul class="divide-y divide-line-soft">${list.map((s) => stockLine(s, `
      <span class="w-20 shrink-0 text-right num ${trendClass(s.total)}">${esc(yi(s.total))}</span>`)).join('')}</ul>`
      : '<p class="text-xs text-faint py-1.5">無</p>'}</div>`;
  return `<div class="space-y-3">${col(`買超前 ${buys.length} 檔`, buys)}${col(`賣超前 ${sells.length} 檔`, sells)}</div>
    <div class="text-[11px] text-faint mt-1">近 ${st.days} 日三大法人合計；金額以最新收盤價換算</div>`;
}

function renderSectors(sum) {
  const list = sum?.sectors ?? [];
  $('ov-sectors').innerHTML = `
    <div class="flex flex-wrap items-baseline justify-between gap-2 mb-3">
      <h3 class="font-semibold">產業今日漲跌</h3>
      <span class="text-xs text-muted">成交值加權・只列成交比重 ≥ 0.5% 的產業・點產業看個股</span>
    </div>
    ${list.length ? divergingRows(list.map((s) => ({
      name: s.name, value: s.changePercent,
      title: `${s.name}：${signed(s.changePercent)}%，成交比重 ${fmt(s.share)}%，${s.count} 檔（點開看個股）`,
    })), { format: (v) => `${signed(v)}%`, expand: { kind: 'sector', open: ovOpen.sector, detail: sectorDetail } }) : emptyState('沒有產業資料', 'chart-pie')}`;
}

function renderFlowsOverview() {
  const r = radarLatest;
  const head = (note) => `<div class="flex flex-wrap items-baseline justify-between gap-2 mb-3">
      <h3 class="font-semibold">三大法人買賣超</h3><span class="text-xs text-muted">${esc(note)}</span></div>`;
  if (!r) {
    $('ov-flows').innerHTML = head('') + `<p class="text-sm text-muted py-6 text-center">${radarLoading ? '法人資料載入中…' : '尚未載入'}</p>`;
    return;
  }
  const f = r.ok ? r.flows : null;
  if (!f?.sectors?.length) {
    $('ov-flows').innerHTML = head('') + emptyState(r.reason || '這次沒有法人資料', 'chart-pie');
    return;
  }
  const sorted = [...f.sectors].sort((a, b) => b.total - a.total);
  const buy = sorted.filter((s) => s.total > 0).slice(0, 6);
  const sell = sorted.filter((s) => s.total < 0).slice(-6);
  $('ov-flows').innerHTML = head(`${f.market}・近 ${f.days} 日合計・單位億元・點產業看個股`)
    + divergingRows([...buy, ...sell].map((s) => ({
      name: s.name, value: s.total / 1e8,
      title: `${s.name}：外資 ${fmt(s.foreign / 1e8, 1)} 億、投信 ${fmt(s.trust / 1e8, 1)} 億、自營 ${fmt(s.dealer / 1e8, 1)} 億（點開看個股）`,
    })), { format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`, expand: { kind: 'flow', open: ovOpen.flow, detail: flowDetail } });
}

// ── 持股：每檔一張卡

function renderHoldings() {
  const byCode = new Map(latest.watchlist.map((w) => [w.code, w]));
  const rows = profile.holdings.map((c) => byCode.get(c)).filter(Boolean);
  $('holding-count').textContent = `${rows.length} 檔`;
  $('holding-cards').innerHTML = rows.length === 0
    ? `<div class="md:col-span-2 xl:col-span-3 bg-surface rounded-xl border border-line">${emptyState('還沒有持股：在下方自選股點錢包圖示，就會移到這裡', 'wallet')}</div>`
    : rows.map(holdingCard).join('');
  for (const s of rows) {
    const el = document.querySelector(`[data-mini="${CSS.escape(s.code)}"]`);
    if (el && s.ta) drawMiniChart(el, s.ta, { height: 130 });
  }
}

const verdictChip = (v) => (v ? `<span class="shrink-0 text-xs px-2 py-0.5 rounded border ${TONE_STYLE[v.tone] || TONE_STYLE.neutral}">${esc(v.label)}</span>` : '');

function boxText(box) {
  if (!box) return '目前沒有箱型';
  const when = box.daysAgo === 0 ? '今天' : `${box.daysAgo} 天前`;
  if (box.status === 'open') return `整理中 ${fmt(box.bottom)}～${fmt(box.top)}`;
  if (box.status === 'breakout') return `${when}突破箱頂 ${fmt(box.top)}${box.volumeConfirmed ? '（放量）' : '（量不足）'}`;
  return `${when}跌破箱底 ${fmt(box.bottom)}`;
}

/** 通道位置：0% = 下緣、100% = 上緣；超出通道的釘在兩端並標出來 */
function channelMeter(t, { compact = false } = {}) {
  const pos = Math.max(0, Math.min(1, t.position));
  const out = t.position < 0 ? '跌破' : t.position > 1 ? '突破' : '';
  return `<div class="${compact ? 'w-28' : ''}">
    <div class="relative h-2 rounded-full bg-track mt-1.5" role="img" aria-label="通道位置 ${Math.round(t.position * 100)}%">
      <div class="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 ${t.position < 0 ? 'bg-down' : t.position > 1 ? 'bg-up' : 'bg-brand-600'}"
           style="left:${(pos * 100).toFixed(1)}%;border-color:rgb(var(--c-surface))"></div>
    </div>
    ${compact ? `<div class="text-[11px] text-muted num mt-1">${out || `位置 ${Math.round(t.position * 100)}%`}</div>`
      : `<div class="flex justify-between text-xs text-muted num mt-1"><span>下緣 ${fmt(t.lower)}</span><span>${out || `${Math.round(t.position * 100)}%`}</span><span>上緣 ${fmt(t.upper)}</span></div>`}
  </div>`;
}

function flagList(flags) {
  if (!flags?.length) return '';
  const icon = { up: 'arrow-up', down: 'warning', neutral: 'info' };
  return `<ul class="mt-3 space-y-1">${flags.map((f) => `<li class="flex items-center gap-1.5 text-sm ${f.tone === 'up' ? 'text-up' : f.tone === 'down' ? 'text-down' : 'text-sub'}">
    <svg class="w-4 h-4 shrink-0" aria-hidden="true"><use href="#i-${icon[f.tone] || 'info'}"/></svg><span class="text-ink">${esc(f.text)}</span></li>`).join('')}</ul>`;
}

function holdingCard(s) {
  const t = s.ta;
  return `<div class="bg-surface rounded-xl border border-line p-4 flex flex-col" data-holding-card="${esc(s.code)}">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="font-semibold truncate">${esc(s.name)}</div>
        <div class="text-xs text-muted num">${esc(s.code)}${s.industry ? ` · ${esc(s.industry)}` : ''}</div>
      </div>
      ${t ? verdictChip(t.verdict) : ''}
    </div>
    <div class="flex flex-wrap items-baseline gap-x-2 mt-2">
      <span class="text-2xl font-semibold">${fmt(s.price)}</span>
      <span class="text-sm num ${trendClass(s.changePercent)}">${signed(s.change)}（${signed(s.changePercent)}%）</span>
    </div>
    ${t ? `
      <div class="mt-2 -mx-1 relative" data-mini="${esc(s.code)}"></div>
      <div class="mt-3 text-sm"><span class="text-muted">通道</span> <span class="font-medium">${esc(t.trendLabel.replace('（箱型整理）', ''))}</span> · ${esc(ZONE_LABEL[t.zone] || '')}</div>
      ${channelMeter(t)}
      <div class="mt-3 text-sm"><span class="text-muted">箱型</span> ${esc(boxText(t.box))}</div>
      <div class="grid grid-cols-2 gap-2 mt-3 text-sm">
        <div class="rounded-lg bg-raised px-3 py-2"><div class="text-[11px] text-muted">停損參考</div><div class="num font-medium">${fmt(t.stop)}</div></div>
        <div class="rounded-lg bg-raised px-3 py-2"><div class="text-[11px] text-muted">目標（通道上緣）</div><div class="num font-medium">${fmt(t.target)}</div></div>
      </div>
      ${flagList(t.flags)}`
    : '<p class="text-sm text-muted mt-3">這一版沒有它的日 K，無法判讀通道與箱型</p>'}
    <div class="mt-auto pt-3 flex items-center gap-1 border-t border-line-soft mt-4">
      <button data-ta-open="${esc(s.code)}" class="text-sm text-accent-ink hover:underline">看技術分析</button>
      <span class="flex-1"></span>
      <button data-toggle-holding="${esc(s.code)}" class="text-accent-ink px-1.5 py-1" title="移回自選股" aria-pressed="true">
        <svg class="w-4 h-4" aria-hidden="true"><use href="#i-wallet"/></svg></button>
      <button data-remove-watch="${esc(s.code)}" class="text-faint hover:text-danger px-1.5 py-1" title="移除">
        <svg class="w-4 h-4" aria-hidden="true"><use href="#i-xmark"/></svg></button>
    </div>
  </div>`;
}

// ── 自選股：一列一檔，走勢、通道位置、箱型、判讀並排

/**
 * 自選股的排序方式。再按一次同一個會反轉方向。
 * 判讀：綜合分數高（偏多）在前；通道位置：靠下緣（買點區）在前。沒有判讀資料的一律排最後。
 */
const WATCH_SORTS = [
  ['list', '清單順序', null],
  ['verdict', '判讀', (s) => s.ta?.score],
  ['change', '今日漲跌', (s) => s.changePercent],
  ['position', '通道位置', (s) => (s.ta ? -s.ta.position : null)],
];

function sortWatch(rows) {
  const [, , key] = WATCH_SORTS.find(([k]) => k === profile.watchSort) || WATCH_SORTS[0];
  if (!key) return rows;
  const dir = profile.watchSortDir === 'asc' ? -1 : 1;
  const val = (s) => { const v = key(s); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (vb - va) * dir;
  });
}

function renderWatchSort() {
  const hint = { verdict: ['偏多在前', '偏空在前'], change: ['漲幅大在前', '跌幅大在前'], position: ['靠下緣在前', '靠上緣在前'] };
  $('watch-sort').innerHTML = `<span class="text-xs text-muted mr-1">排序</span>${WATCH_SORTS.map(([k, label]) => {
    const active = profile.watchSort === k;
    const arrow = active && k !== 'list' ? (profile.watchSortDir === 'asc' ? ' ↑' : ' ↓') : '';
    const title = hint[k] ? hint[k][active && profile.watchSortDir !== 'asc' ? 1 : 0] : '';
    return `<button data-watch-sort="${k}" class="px-2.5 py-1 text-xs rounded-md border ${active ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface border-line text-sub hover:bg-raised'}"
      ${title ? `title="再按一次：${esc(title)}"` : ''} aria-pressed="${active}">${esc(label)}${arrow}</button>`;
  }).join('')}`;
}

function renderWatchlist() {
  const holdingSet = new Set(profile.holdings);
  const rows = sortWatch(latest.watchlist.filter((w) => !holdingSet.has(w.code)));
  renderWatchSort();
  $('watch-count').textContent = `${rows.length} 檔`;
  if (rows.length === 0) {
    $('watch-table').innerHTML = emptyState(latest.watchlist.length === 0 ? '還沒有自選股，用上方搜尋框加入' : '所有自選股都已設為持股', 'star');
    return;
  }
  const th = (label, cls = '') => `<th class="whitespace-nowrap font-medium px-3 py-2.5 ${cls}">${label}</th>`;
  $('watch-table').innerHTML = `<table class="w-full text-sm">
    <thead class="bg-raised text-muted text-xs"><tr>
      ${th('標的', 'text-left pl-5')}${th('收盤', 'text-right')}${th('漲跌', 'text-right')}
      ${th('近 60 日', 'text-left hidden md:table-cell')}${th('通道位置', 'text-left')}${th('箱型', 'text-left hidden lg:table-cell')}
      ${th('判讀與提示', 'text-left')}<th class="px-3 py-2.5"></th>
    </tr></thead>
    <tbody class="divide-y divide-line-soft">${rows.map((s) => {
      const t = s.ta;
      return `<tr class="hover:bg-raised align-top">
        <td class="pl-5 pr-3 py-3 whitespace-nowrap">
          <div class="font-medium">${esc(s.name)}</div>
          <div class="text-xs text-muted num">${esc(s.code)}${s.industry ? `<span class="ml-1 text-faint hidden sm:inline">${esc(s.industry)}</span>` : ''}${s.unknown ? '<span class="ml-1 text-warn">查無資料</span>' : ''}</div>
        </td>
        <td class="px-3 py-3 text-right num font-medium whitespace-nowrap">${fmt(s.price)}</td>
        <td class="px-3 py-3 text-right num whitespace-nowrap ${trendClass(s.changePercent)}">${signed(s.changePercent)}%</td>
        <td class="px-3 py-2 hidden md:table-cell">${t ? sparkSvg(t, 132, 36) : '<span class="text-dim">—</span>'}</td>
        <td class="px-3 py-3 whitespace-nowrap">${t ? `<div class="text-xs text-sub">${esc(t.trendLabel.replace('（箱型整理）', ''))}・${esc(ZONE_LABEL[t.zone] || '')}</div>${channelMeter(t, { compact: true })}` : '<span class="text-dim">—</span>'}</td>
        <td class="px-3 py-3 text-xs text-sub hidden lg:table-cell min-w-[10rem]">${t ? esc(boxText(t.box)) : '—'}</td>
        <td class="px-3 py-3 min-w-[12rem]">${t ? `${verdictChip(t.verdict)}${t.flags.length ? `<div class="mt-1.5 space-y-0.5">${t.flags.map((f) => `<div class="text-xs ${f.tone === 'up' ? 'text-up' : f.tone === 'down' ? 'text-down' : 'text-sub'}">● <span class="text-ink">${esc(f.text)}</span></div>`).join('')}</div>` : ''}` : '<span class="text-dim">—</span>'}</td>
        <td class="px-3 py-3 text-right whitespace-nowrap">
          <button data-ta-open="${esc(s.code)}" class="text-faint hover:text-accent-ink px-1" title="技術分析"><svg class="w-4 h-4 inline-block" aria-hidden="true"><use href="#i-chart-line"/></svg></button>
          <button data-toggle-holding="${esc(s.code)}" class="text-faint hover:text-accent-ink px-1" title="設為持股" aria-pressed="false"><svg class="w-4 h-4 inline-block" aria-hidden="true"><use href="#i-wallet"/></svg></button>
          <button data-remove-watch="${esc(s.code)}" class="text-faint hover:text-danger px-1" title="移除"><svg class="w-4 h-4 inline-block" aria-hidden="true"><use href="#i-xmark"/></svg></button>
        </td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

// ── 總覽用的小圖（手刻 SVG）

const BOX_STYLE = {
  open: { color: 'warn', fill: 0.12, dash: '' },
  breakout: { color: 'up', fill: 0.08, dash: '5 3' },
  failed: { color: 'faint', fill: 0.08, dash: '2 3' },
};

/** 表格裡的走勢小圖：收盤線＋通道帶＋箱型，只表達形狀；數字在旁邊的欄位 */
function sparkSvg(t, W, H) {
  const { closes, upper, lower } = t.spark;
  const n = closes.length;
  const vals = [...closes, ...upper.filter((v) => v !== null), ...lower.filter((v) => v !== null)];
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const x = (i) => 2 + (i / Math.max(1, n - 1)) * (W - 6);
  const y = (v) => H - 2 - ((v - min) / (max - min || 1)) * (H - 4);
  const line = (arr) => pathOf(arr, x, y);
  const band = upper.some((v) => v !== null) ? `<path d="${line(upper)}${[...lower].map((v, i) => [v, i]).reverse().filter(([v]) => v !== null).map(([v, i]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}Z" fill="${series('s1')}" fill-opacity="0.1"/>` : '';
  const up = closes[n - 1] >= closes[0];
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
    ${band}<path d="${line(closes)}" fill="none" stroke="${series(up ? 'up' : 'down')}" stroke-width="1.75" stroke-linejoin="round"/>
    <circle cx="${x(n - 1)}" cy="${y(closes[n - 1])}" r="2.5" fill="${series(up ? 'up' : 'down')}"/></svg>`;
}

/** 持股卡的走勢圖：收盤線、通道上下緣、箱型，滑過顯示日期與收盤 */
function drawMiniChart(el, t, { height = 130 } = {}) {
  const W = Math.max(240, el.clientWidth || 320);
  const H = height;
  const pad = { l: 4, r: 52, t: 8, b: 8 };
  const { dates, closes, upper, lower } = t.spark;
  const n = closes.length;
  const box = t.box;
  const vals = [...closes, ...upper.filter((v) => v !== null), ...lower.filter((v) => v !== null), ...(box ? [box.top, box.bottom] : [])];
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  const padV = (max - min) * 0.05 || 1;
  min -= padV; max += padV;
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - ((v - min) / (max - min)) * (H - pad.t - pad.b);
  const st = box ? BOX_STYLE[box.status] || BOX_STYLE.open : null;
  const boxRect = box ? `<rect x="${x(box.start).toFixed(1)}" y="${y(box.top).toFixed(1)}" width="${Math.max(3, x(box.end) - x(box.start)).toFixed(1)}" height="${Math.max(1, y(box.bottom) - y(box.top)).toFixed(1)}"
      fill="${series(st.color)}" fill-opacity="${st.fill}" stroke="${series(st.color)}" stroke-width="1.5" ${st.dash ? `stroke-dasharray="${st.dash}"` : ''}/>` : '';
  const last = closes[n - 1];
  const lastU = upper[n - 1];
  const lastL = lower[n - 1];
  const labels = [
    lastU !== null ? { v: lastU, text: `上 ${fmt(lastU)}` } : null,
    lastL !== null ? { v: lastL, text: `下 ${fmt(lastL)}` } : null,
  ].filter(Boolean).sort((a, b) => y(a.v) - y(b.v));
  let prevY = -Infinity;
  const endLabels = labels.map((l) => {
    const ly = Math.max(y(l.v) + 4, prevY + 13);
    prevY = ly;
    return `<text x="${W - pad.r + 6}" y="${ly}" font-size="11" fill="rgb(var(--c-muted))">${esc(l.text)}</text>`;
  }).join('');

  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="block select-none" role="img" aria-label="近 ${n} 個交易日收盤與通道">
    ${boxRect}
    ${lastU !== null ? `<path d="${pathOf(upper, x, y)}" fill="none" stroke="${series('s1')}" stroke-width="1.5"/>` : ''}
    ${lastL !== null ? `<path d="${pathOf(lower, x, y)}" fill="none" stroke="${series('s1')}" stroke-width="1.5"/>` : ''}
    <path d="${pathOf(closes, x, y)}" fill="none" stroke="rgb(var(--c-ink))" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(n - 1)}" cy="${y(last)}" r="4" fill="rgb(var(--c-ink))" stroke="rgb(var(--c-surface))" stroke-width="2"/>
    ${endLabels}
    <line class="mini-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" stroke="rgb(var(--c-faint))" stroke-width="1" visibility="hidden"/>
    <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" class="mini-hit"/>
  </svg>
  <div class="mini-tip hidden absolute z-10 pointer-events-none bg-surface border border-line rounded-md shadow-lg px-2 py-1 text-xs num whitespace-nowrap"></div>`;
  bindSimpleHover(el, { n, x, W, pad, row: (i) => `<span class="font-medium">${fmt(closes[i])}</span> <span class="text-muted">${esc(dates[i])}</span>`, cross: '.mini-cross', hit: '.mini-hit', tip: '.mini-tip' });
}

/**
 * 依寬度畫的折線圖（單一 y 軸），附十字線 tooltip：一次列出同一天所有線的數值。
 * @param {{dates:string[], series:Array<{label,values,color,width?,dash?,area?,endLabel?}>, height?:number, format?:Function}} o
 */
function drawLineChart(el, { dates, series: lines, height = 240, format = fmt }) {
  const W = Math.max(280, el.clientWidth || 600);
  const H = height;
  const pad = { l: 56, r: 64, t: 8, b: 24 };
  const n = dates.length;
  const all = lines.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined);
  let min = Math.min(...all);
  let max = Math.max(...all);
  const padV = (max - min) * 0.06 || 1;
  min -= padV; max += padV;
  const x = (i) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - ((v - min) / (max - min)) * (H - pad.t - pad.b);

  const grid = niceTicks(min, max, 4).map((v) => `
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="rgb(var(--c-line))" stroke-width="1"/>
    <text x="${pad.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="rgb(var(--c-muted))">${esc(format(v))}</text>`).join('');
  const months = dates.map((d, i) => ({ i, m: d.slice(0, 7) })).filter((p, k, arr) => k > 0 && p.m !== arr[k - 1].m);
  const xTicks = months.map((p) => `<text x="${x(p.i)}" y="${H - 6}" text-anchor="middle" font-size="12" fill="rgb(var(--c-muted))">${Number(p.m.slice(5))}月</text>`).join('');
  const paths = lines.map((s) => {
    const d = pathOf(s.values, x, y);
    const firstIdx = s.values.findIndex((v) => v !== null && v !== undefined);
    const area = s.area && firstIdx !== -1 ? `<path d="${d}L${x(n - 1).toFixed(1)},${H - pad.b}L${x(firstIdx).toFixed(1)},${H - pad.b}Z" fill="${s.color}" fill-opacity="0.08"/>` : '';
    return `${area}<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
  }).join('');
  const main = lines.find((s) => s.endLabel);
  const lastV = main?.values[n - 1];
  const end = main && lastV !== null ? `<circle cx="${x(n - 1)}" cy="${y(lastV)}" r="4" fill="${main.color}" stroke="rgb(var(--c-surface))" stroke-width="2"/>
    <text x="${x(n - 1) + 8}" y="${y(lastV) + 4}" font-size="12" font-weight="600" fill="rgb(var(--c-ink))">${esc(format(lastV))}</text>` : '';

  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="block select-none" role="img" aria-label="${esc(lines.map((s) => s.label).join('、'))}走勢">
    ${grid}${xTicks}${paths}${end}
    <line class="lc-cross" x1="0" x2="0" y1="${pad.t}" y2="${H - pad.b}" stroke="rgb(var(--c-faint))" stroke-width="1" visibility="hidden"/>
    <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" class="lc-hit"/>
  </svg>
  <div class="lc-tip hidden absolute z-10 pointer-events-none bg-surface border border-line rounded-lg shadow-lg px-3 py-2 text-xs num min-w-[9rem]"></div>`;

  bindSimpleHover(el, {
    n, x, W, pad, cross: '.lc-cross', hit: '.lc-hit', tip: '.lc-tip',
    row: (i) => `<div class="text-muted mb-1">${esc(dates[i])}</div>${lines.map((s) => `
      <div class="flex items-center justify-between gap-4"><span class="inline-flex items-center gap-1.5 text-muted">
        <svg width="12" height="6" aria-hidden="true"><line x1="0" y1="3" x2="12" y2="3" stroke="${s.color}" stroke-width="2"/></svg>${esc(s.label)}</span>
        <span class="font-medium text-ink">${s.values[i] === null || s.values[i] === undefined ? '—' : esc(format(s.values[i]))}</span></div>`).join('')}`,
  });
}

/** 直條圖：最新一根用強調色，其餘灰色（重點是「今天」相對最近的位置） */
function drawColumns(el, { values, labels, height = 72 }) {
  const W = Math.max(200, el.clientWidth || 300);
  const H = height;
  const n = values.length;
  const max = Math.max(...values, 1);
  const slot = W / n;
  const bw = Math.min(24, Math.max(2, slot - 2));
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="block" role="img" aria-label="近 ${n} 日成交值">
    ${values.map((v, i) => {
      const h = Math.max(1, (v / max) * (H - 2));
      const xx = i * slot + (slot - bw) / 2;
      const yy = H - h;
      const r = Math.min(4, bw / 2, h);
      // 只有頂端圓角、底部貼齊基線
      return `<path d="M${xx},${H}V${yy + r}Q${xx},${yy} ${xx + r},${yy}H${xx + bw - r}Q${xx + bw},${yy} ${xx + bw},${yy + r}V${H}Z"
        fill="${i === n - 1 ? series('s1') : 'rgb(var(--c-dim))'}"><title>${esc(labels[i])}</title></path>`;
    }).join('')}
  </svg>`;
}

/** 十字線＋tooltip 的共用綁定：依指標的 x 找最近的一天 */
function bindSimpleHover(el, { n, x, W, pad, row, cross, hit, tip }) {
  const svg = el.querySelector('svg');
  const line = el.querySelector(cross);
  const box = el.querySelector(tip);
  const area = el.querySelector(hit);
  if (!svg || !line || !box || !area) return;
  const show = (e) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((vx - pad.l) / (W - pad.l - pad.r)) * (n - 1))));
    line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); line.setAttribute('visibility', 'visible');
    box.innerHTML = row(i);
    box.classList.remove('hidden');
    const px = (x(i) / W) * rect.width;
    const left = px + 12 + box.offsetWidth > rect.width ? px - 12 - box.offsetWidth : px + 12;
    box.style.left = `${Math.max(0, left)}px`;
    box.style.top = '4px';
  };
  const hide = () => { line.setAttribute('visibility', 'hidden'); box.classList.add('hidden'); };
  area.style.touchAction = 'pan-y';
  area.addEventListener('pointermove', show);
  area.addEventListener('pointerdown', show);
  area.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
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
    　候選池 ${r.candidateCount} 檔（已排除已在自選、成交量過低者）。`;
}

// ── 技術分析 ─────────────────────────────────────────
//
// 跟其他分頁不同，這裡的資料不在 dashboard 回應裡：一檔要抓兩年日 K，
// 所以只在打開這個分頁、選了某一檔時才另外打 /api/technical。

const TA_LOOKBACKS = [
  [30, '30 日', '約一個半月，短線進出；通道短、觸碰次數少，可靠度較低'],
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

/** 可選的標的：自選股（dashboard 還沒回來時先用代號） */
function taOptions() {
  const rows = (latest?.watchlist ?? []).map((s) => ({ code: s.code, name: s.name }));
  const fallback = profile.watchlist.map((code) => ({ code, name: code }));
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

/** 選項按鈕的樣式（標的、通道長度、顯示區間共用） */
const chip = (active) => `px-3 py-1.5 text-sm rounded-lg border ${
  active ? 'bg-brand-600 text-white border-brand-600' : 'bg-surface border-line text-sub hover:bg-raised'}`;

function renderTechnicalControls() {

  const options = taOptions();
  const holdingSet = new Set(profile.holdings);
  const opt = (s) => `<option value="${esc(s.code)}" ${s.code === profile.taCode ? 'selected' : ''}>${esc(s.code)}${s.name !== s.code ? `　${esc(s.name)}` : ''}</option>`;
  const held = options.filter((s) => holdingSet.has(s.code));
  const rest = options.filter((s) => !holdingSet.has(s.code));
  // 從「其他代號」或產業列表點進來的標的不在清單裡，也要選得到、看得出是哪一檔
  const extra = profile.taCode && !options.some((s) => s.code === profile.taCode)
    ? `<option value="${esc(profile.taCode)}" selected>${esc(profile.taCode)}（不在自選）</option>` : '';
  $('ta-picker').innerHTML = options.length === 0 && !extra
    ? '<span class="text-sm text-faint">還沒有自選股，右側直接輸入代號</span>'
    : `<select id="ta-select" aria-label="選擇標的" class="w-full sm:w-80 px-3 py-2 text-sm rounded-lg border border-line bg-surface text-ink num">
        ${extra}
        ${held.length ? `<optgroup label="持股">${held.map(opt).join('')}</optgroup>` : ''}
        ${rest.length ? `<optgroup label="自選股">${rest.map(opt).join('')}</optgroup>` : ''}
      </select>`;

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
  const { chart, narrow } = sizeChart(t.chart);

  $('ta-body').innerHTML = `
    ${notes.length ? `<div class="rounded-lg border px-4 py-3 text-sm bg-warn-bg border-warn-line text-warn mb-6">
      <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1.5" aria-hidden="true"><use href="#i-warning"/></svg>${notes.map(esc).join('；')}</div>` : ''}

    <div class="bg-surface rounded-xl border border-line">
      <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 class="text-lg font-semibold">${esc(t.name)} <span class="num text-muted font-normal">${esc(t.code)}</span></h2>
        <span class="text-sm text-sub">K 線與${esc(ch.label)}</span>
        <span class="text-xs text-muted num">${esc(ch.startDate)} 起 ${ch.lookback} 日 · 資料至 ${esc(t.asOf)}</span>
        <div class="ml-auto flex gap-1.5" role="group" aria-label="顯示區間">
          ${TA_RANGES.map(([n, label]) => `<button data-ta-bars="${n}" class="${chip(n === (profile.taBars ?? 120))}">${esc(label)}</button>`).join('')}
        </div>
      </div>
      <div class="p-3 sm:p-5">
        ${chartLegend()}
        ${chart.bars.length < t.chart.bars.length ? `<p class="text-xs text-faint px-1 mb-1">顯示近 ${chart.bars.length} 個交易日；通道、箱型與指標仍以完整資料計算</p>` : ''}
        <div id="ta-charts" class="relative">
          ${priceChartSvg(chart)}
          ${oscChartSvg(chart, 'rsi')}
          ${oscChartSvg(chart, 'kd')}
          <div id="ta-tip" class="hidden absolute z-10 pointer-events-none bg-surface border border-line rounded-lg shadow-lg px-3 py-2 text-xs num min-w-[10rem]"></div>
        </div>
      </div>
    </div>

    <div class="grid lg:grid-cols-3 gap-6 mt-6">
      ${verdictCard(t)}
      ${planCard(t.plan)}
      ${timeframeCard(a)}
    </div>

    <div class="grid lg:grid-cols-2 gap-6 mt-6">
      <div class="bg-surface rounded-xl border border-line">
        <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
          <h2 class="font-semibold">判讀依據</h2>
          <span class="text-xs text-muted">每一項都附實際數字，加總即為綜合分數</span>
        </div>
        <ul class="p-5 space-y-2.5">${signalRows(a)}</ul>
      </div>
      ${indicatorCard(a)}
    </div>

    ${backtestCard(t.backtest)}

    <p class="text-xs text-muted mt-6 leading-relaxed">
      <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1" aria-hidden="true"><use href="#i-info"/></svg>${esc(t.disclaimer)}
    </p>`;

  bindChartHover(chart);
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
  const tfLabel = { 30: '超短（30 日）', 60: '短（60 日）', 120: '中（120 日）', 240: '長（240 日）' };
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
      ? `${['', '', '兩', '三', '四'][trends.length]}個週期方向一致（${trends[0] === 'up' ? '都向上' : trends[0] === 'down' ? '都向下' : '都是盤整'}），訊號可信度較高。`
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

  return `<div class="bg-surface rounded-xl border border-line">
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

// 桌機用固定 800 寬的 viewBox 讓它等比縮放；手機改成依實際寬度畫，字才不會縮到看不見
// （見 renderTechnical 的 sizeChart）。
let CHART_W = 800;
let PAD = { left: 52, right: 88 };

/** 手機寬度：只畫近 n 根，否則 150 根 K 線擠在 300px 裡每根不到 2px */
const NARROW_BARS = 60;

/** K 線圖的顯示區間（根數，0 = 全部）。根數少，每根 K 線才夠寬看得清楚 */
const TA_RANGES = [[60, '3 個月'], [120, '6 個月'], [0, '全部']];

function lastBars(c, n) {
  if (c.bars.length <= n) return c;
  const start = c.bars.length - n;
  const cut = (arr) => arr.slice(start);
  const first = c.bars[start].date;
  return {
    ...c,
    bars: cut(c.bars), ma20: cut(c.ma20), ma60: cut(c.ma60), rsi: cut(c.rsi), k: cut(c.k), d: cut(c.d),
    channel: c.channel.filter((p) => p.date >= first),
    markers: c.markers.filter((m) => m.date >= first),
    boxes: (c.boxes ?? []).filter((b) => b.endDate >= first).map((b) => (b.startDate < first ? { ...b, startDate: first } : b)),
  };
}

/**
 * 依容器的實際寬度畫圖（viewBox 寬 = 像素寬），字與線在任何螢幕上都是設定的大小，
 * 不會因為縮放變細變小。回傳要畫的那段資料。
 */
function sizeChart(chart) {
  const narrow = window.matchMedia('(max-width: 639px)').matches;
  // 卡片左右 padding（p-3 / sm:p-5）與邊框
  const inner = ($('ta-body').clientWidth || 800) - (narrow ? 26 : 42);
  CHART_W = Math.max(300, Math.round(inner));
  PAD = narrow ? { left: 44, right: 72 } : { left: 64, right: 104 };
  const want = narrow ? Math.min(NARROW_BARS, profile.taBars || NARROW_BARS) : profile.taBars ?? 120;
  return { chart: want > 0 ? lastBars(chart, want) : chart, narrow };
}
const series = (n) => `rgb(var(--c-${n}))`;

function chartLegend() {
  const line = (color, label, dash = '') => `<span class="inline-flex items-center gap-1.5">
    <svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5" stroke="${color}" stroke-width="2.5" ${dash ? `stroke-dasharray="${dash}"` : ''}/></svg>${esc(label)}</span>`;
  const mark = (shape, color, label, stroke = false) => `<span class="inline-flex items-center gap-1.5">
    <svg width="12" height="12" viewBox="0 0 10 10" aria-hidden="true"><path d="${shape}" ${stroke ? `fill="none" stroke="${color}" stroke-width="2"` : `fill="${color}"`}/></svg>${esc(label)}</span>`;
  return `<div class="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-sub mb-3 px-1">
    ${line(series('s1'), '通道上下緣')}
    ${line(series('s1'), '通道中軌', '4 3')}
    ${line(series('s2'), 'MA20 月線')}
    ${line(series('s3'), 'MA60 季線', '6 3')}
    ${mark('M1 2H9V8H1z', series('warn'), '箱型（整理中）', true)}
    ${mark('M1 2H9V8H1z', series('up'), '已突破', true)}
    ${mark('M1 2H9V8H1z', series('faint'), '已跌破', true)}
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
  // 寬螢幕給到 480px 高；手機 360px，搭配較少的根數
  const H = CHART_W < 640 ? 360 : 480;
  const top = 12;
  const bottom = H - 26;
  const n = c.bars.length;
  const { step, x } = xScale(n);
  const idx = new Map(c.bars.map((b, i) => [b.date, i]));

  const chan = c.channel.map((p) => ({ ...p, i: idx.get(p.date) })).filter((p) => p.i !== undefined);
  const boxes = (c.boxes ?? []).map((b) => ({ ...b, i0: idx.get(b.startDate), i1: idx.get(b.endDate) }))
    .filter((b) => b.i0 !== undefined && b.i1 !== undefined);
  const lows = [...c.bars.map((b) => b.low), ...chan.map((p) => p.lower), ...boxes.map((b) => b.bottom)];
  const highs = [...c.bars.map((b) => b.high), ...chan.map((p) => p.upper), ...boxes.map((b) => b.top)];
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const pad = (max - min) * 0.04;
  min -= pad; max += pad;
  const y = yScale(min, max, top, bottom);

  const grid = niceTicks(min, max, 5).map((v) => `
    <line x1="${PAD.left}" x2="${CHART_W - PAD.right}" y1="${y(v)}" y2="${y(v)}" stroke="rgb(var(--c-line))" stroke-width="1"/>
    <text x="${PAD.left - 6}" y="${y(v) + 4}" text-anchor="end" font-size="12" fill="rgb(var(--c-muted))">${v >= 1000 ? Math.round(v).toLocaleString('zh-TW') : v}</text>`).join('');

  // 月份刻度：每個月第一根 K 線
  const months = c.bars.map((b, i) => ({ i, m: b.date.slice(0, 7) }))
    .filter((p, k, arr) => k === 0 || p.m !== arr[k - 1].m).slice(1);
  const xTicks = months.map((p) => `<text x="${x(p.i)}" y="${H - 8}" text-anchor="middle" font-size="12" fill="rgb(var(--c-muted))">${Number(p.m.slice(5))}月</text>`).join('');

  const band = chan.length ? `
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.upper).toFixed(1)}`).join('')}${[...chan].reverse().map((p) => `L${x(p.i).toFixed(1)},${y(p.lower).toFixed(1)}`).join('')}Z"
          fill="${series('s1')}" fill-opacity="0.08"/>
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.upper).toFixed(1)}`).join('')}" fill="none" stroke="${series('s1')}" stroke-width="2.5"/>
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.lower).toFixed(1)}`).join('')}" fill="none" stroke="${series('s1')}" stroke-width="2.5"/>
    <path d="${chan.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.mid).toFixed(1)}`).join('')}" fill="none" stroke="${series('s1')}" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.85"/>` : '';

  // 箱型：整理中（橘）、已向上突破（紅虛線，放量的標「放量」）、已跌破箱底（灰）
  const boxStyle = {
    open: { color: series('warn'), fill: 0.1, dash: '', width: 2.2 },
    breakout: { color: series('up'), fill: 0.06, dash: '6 4', width: 2 },
    failed: { color: series('faint'), fill: 0.06, dash: '2 4', width: 1.8 },
  };
  const boxLabel = { open: '整理中', breakout: '已突破', failed: '已跌破' };
  const boxSvg = boxes.map((b) => {
    const st = boxStyle[b.status] ?? boxStyle.open;
    const x0 = x(b.i0) - step / 2;
    const w = Math.max(step, x(b.i1) + step / 2 - x0);
    const detail = `${b.startDate} ～ ${b.endDate}　箱頂 ${fmt(b.top)}／箱底 ${fmt(b.bottom)}`;
    const tag = b.status === 'breakout'
      ? `<text x="${(x0 + w).toFixed(1)}" y="${(y(b.top) - 4).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="${st.color}" stroke="rgb(var(--c-surface))" stroke-width="3" paint-order="stroke">突破${b.volumeConfirmed ? '放量' : '（量不足）'}</text>`
      : '';
    return `<g><title>箱型（${boxLabel[b.status] ?? ''}）${detail}</title>
      <rect x="${x0.toFixed(1)}" y="${y(b.top).toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(1, y(b.bottom) - y(b.top)).toFixed(1)}"
            fill="${st.color}" fill-opacity="${st.fill}" stroke="${st.color}" stroke-width="${st.width}" ${st.dash ? `stroke-dasharray="${st.dash}"` : ''}/>
      ${tag}</g>`;
  }).join('');

  const bodyW = Math.max(1.5, step * 0.7);
  const candles = c.bars.map((b, i) => {
    const color = b.close >= b.open ? series('up') : series('down');
    const yo = y(b.open);
    const yc = y(b.close);
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${color}" stroke-width="1.25"/>
      <rect x="${(x(i) - bodyW / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(1, Math.abs(yo - yc)).toFixed(1)}" fill="${color}"/>`;
  }).join('');

  const markers = c.markers.map((m) => {
    const i = idx.get(m.date);
    if (i === undefined) return '';
    const cx = x(i);
    if (m.kind === 'buy') { const cy = y(m.price) + 13; return `<path d="M${cx},${cy - 7}L${cx + 7},${cy + 6}L${cx - 7},${cy + 6}Z" fill="${series('up')}" stroke="rgb(var(--c-surface))" stroke-width="1.5"><title>${m.date} 下緣買點</title></path>`; }
    if (m.kind === 'sell') { const cy = y(m.price) - 13; return `<path d="M${cx},${cy + 7}L${cx + 7},${cy - 6}L${cx - 7},${cy - 6}Z" fill="${series('down')}" stroke="rgb(var(--c-surface))" stroke-width="1.5"><title>${m.date} 上緣賣訊</title></path>`; }
    const cy = y(m.price) + 14;
    return `<path d="M${cx - 5},${cy - 5}L${cx + 5},${cy + 5}M${cx + 5},${cy - 5}L${cx - 5},${cy + 5}" stroke="${series('warn')}" stroke-width="2.5"><title>${m.date} 跌破通道</title></path>`;
  }).join('');

  // 右側直接標註：最後一根的通道上下緣與均線值，顏色靠線條，文字維持文字色
  const last = chan[chan.length - 1];
  const labels = [];
  if (last) {
    labels.push({ v: last.upper, text: `上緣 ${fmt(last.upper)}`, color: series('s1') });
    labels.push({ v: last.lower, text: `下緣 ${fmt(last.lower)}`, color: series('s1') });
  }
  const openBox = boxes.find((b) => b.status === 'open');
  if (openBox) {
    labels.push({ v: openBox.top, text: `箱頂 ${fmt(openBox.top)}`, color: series('warn') });
    labels.push({ v: openBox.bottom, text: `箱底 ${fmt(openBox.bottom)}`, color: series('warn') });
  }
  const ma20 = c.ma20[n - 1];
  const ma60 = c.ma60[n - 1];
  if (ma20 !== null) labels.push({ v: ma20, text: 'MA20', color: series('s2') });
  if (ma60 !== null) labels.push({ v: ma60, text: 'MA60', color: series('s3') });
  labels.sort((a, b) => y(a.v) - y(b.v));
  let prevY = -Infinity;
  const endLabels = labels.map((l) => {
    const ly = Math.max(y(l.v) + 4, prevY + 16);
    prevY = ly;
    return `<rect x="${CHART_W - PAD.right + 4}" y="${ly - 9}" width="4" height="10" rx="1" fill="${l.color}"/>
      <text x="${CHART_W - PAD.right + 12}" y="${ly}" font-size="12" fill="rgb(var(--c-sub))">${esc(l.text)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${CHART_W} ${H}" class="w-full h-auto block select-none" role="img"
      aria-label="${esc(`近 ${n} 個交易日 K 線、趨勢通道、箱型與均線`)}" data-panel="price" data-top="${top}" data-bottom="${bottom}">
    ${grid}${xTicks}${boxSvg}${band}
    <path d="${pathOf(c.ma60, x, y)}" fill="none" stroke="${series('s3')}" stroke-width="2" stroke-dasharray="7 4"/>
    <path d="${pathOf(c.ma20, x, y)}" fill="none" stroke="${series('s2')}" stroke-width="2"/>
    ${candles}${markers}${endLabels}
    <line class="ta-cross" x1="0" x2="0" y1="${top}" y2="${bottom}" stroke="rgb(var(--c-faint))" stroke-width="1" stroke-dasharray="3 3" visibility="hidden"/>
    <rect x="${PAD.left}" y="0" width="${CHART_W - PAD.left - PAD.right}" height="${H}" fill="transparent" class="ta-hit"/>
  </svg>`;
}

function oscChartSvg(c, kind) {
  const H = CHART_W < 640 ? 100 : 128;
  const top = 20;
  const bottom = H - 8;
  const n = c.bars.length;
  const { x } = xScale(n);
  const y = yScale(0, 100, top, bottom);
  const refs = kind === 'rsi' ? [30, 70] : [20, 80];
  const title = kind === 'rsi' ? 'RSI(14)' : 'KD(9,3,3)';
  const lines = kind === 'rsi'
    ? `<path d="${pathOf(c.rsi, x, y)}" fill="none" stroke="${series('s1')}" stroke-width="2"/>`
    : `<path d="${pathOf(c.k, x, y)}" fill="none" stroke="${series('s1')}" stroke-width="2"/>
       <path d="${pathOf(c.d, x, y)}" fill="none" stroke="${series('s2')}" stroke-width="2"/>`;
  const lastVals = kind === 'rsi'
    ? [{ v: c.rsi[n - 1], t: 'RSI', color: series('s1') }]
    : [{ v: c.k[n - 1], t: 'K', color: series('s1') }, { v: c.d[n - 1], t: 'D', color: series('s2') }];
  let prevY = -Infinity;
  const endLabels = lastVals.filter((l) => l.v !== null).sort((a, b) => y(a.v) - y(b.v)).map((l) => {
    const ly = Math.max(y(l.v) + 4, prevY + 15);
    prevY = ly;
    return `<rect x="${CHART_W - PAD.right + 4}" y="${ly - 9}" width="4" height="10" rx="1" fill="${l.color}"/>
      <text x="${CHART_W - PAD.right + 10}" y="${ly}" font-size="12" fill="rgb(var(--c-sub))">${l.t} ${fmt(l.v, 1)}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${CHART_W} ${H}" class="w-full h-auto block select-none mt-1" role="img" aria-label="${title}" data-panel="${kind}" data-top="${top}" data-bottom="${bottom}">
    <text x="${PAD.left}" y="14" font-size="12" font-weight="600" fill="rgb(var(--c-muted))">${title}</text>
    <rect x="${PAD.left}" y="${y(refs[1])}" width="${CHART_W - PAD.left - PAD.right}" height="${y(refs[0]) - y(refs[1])}" fill="rgb(var(--c-track))" opacity="0.6"/>
    ${refs.map((r) => `<text x="${PAD.left - 6}" y="${y(r) + 4}" text-anchor="end" font-size="12" fill="rgb(var(--c-muted))">${r}</text>`).join('')}
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
    // 左右拖曳可以逐日看數值，上下滑仍然捲動頁面
    hit.style.touchAction = 'pan-y';
    hit.addEventListener('pointermove', show);
    hit.addEventListener('pointerdown', show);
    // 觸控在手指離開時就會觸發 pointerleave，若照樣隱藏，tooltip 會一閃即逝；
    // 觸控改成點圖以外的地方才收起
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
  });
  const outside = (e) => {
    if (!document.body.contains(wrap)) return document.removeEventListener('pointerdown', outside);
    if (!wrap.contains(e.target)) hide();
  };
  document.addEventListener('pointerdown', outside);
}

// ── 產業雷達 ─────────────────────────────────────────
//
// 資料量大（全市場 20 個交易日 + 每檔自選股的營收與法人），所以跟技術分析
// 一樣只在打開分頁時才抓，結果留在記憶體，按「重新整理」才重抓。

let radarLatest = null;
let radarLoading = false;

const KIND_LABEL = { turnover: '資金', flow: '法人', theme: '題材', price: '股價' };
const TREND_STYLE = {
  heating: ['升溫', 'bg-up-bg text-up border-up-line'],
  cooling: ['降溫', 'bg-down-bg text-down border-down-line'],
  flat: ['持平', 'bg-raised text-sub border-line'],
};
const MOMENTUM_STYLE = {
  accelerating: ['加速', 'bg-up-bg text-up border-up-line'],
  decelerating: ['減速', 'bg-down-bg text-down border-down-line'],
  steady: ['持平', 'bg-raised text-sub border-line'],
};

const chipHtml = ([label, cls]) => `<span class="inline-block px-2 py-0.5 rounded border text-xs ${cls}">${esc(label)}</span>`;
const yi = (n) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${(n / 1e8).toFixed(1)} 億` : '—');
const lots = (n) => (typeof n === 'number' ? `${n > 0 ? '+' : ''}${fmtInt(n / 1000)} 張` : '—');

/** quiet：總覽在背景載入時不動產業雷達分頁的畫面 */
async function loadRadar({ force = false, quiet = false } = {}) {
  if (radarLoading) return;
  if (radarLatest && !force) return quiet ? undefined : renderRadar();
  radarLoading = true;
  if (!quiet) $('radar-body').innerHTML = `<div class="bg-surface rounded-xl border border-line py-16 text-center text-sm text-muted leading-relaxed">
    正在整理全市場類股成交、法人買賣超、題材新聞與 ${profile.watchlist.length} 檔自選股的月營收…<br>
    <span class="text-faint">第一次約需 1 分鐘（證交所要慢慢抓，避免被擋）；之後歷史資料都有快取，會快很多。</span></div>`;
  try {
    const res = await fetch('/api/radar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist: profile.watchlist }),
    });
    if (!res.ok) throw new Error(`伺服器回應 ${res.status}`);
    radarLatest = await res.json();
    if (!quiet || $('tab-radar').classList.contains('active')) renderRadar();
  } catch (err) {
    if (quiet) return;
    $('radar-body').innerHTML = `<div class="rounded-lg border px-4 py-3 text-sm bg-danger-bg border-danger-line text-danger">產業雷達載入失敗：${esc(err.message)}</div>`;
  } finally {
    radarLoading = false;
    // 總覽的成交值、法人兩張卡要等這份資料
    if (latest && $('tab-overview').classList.contains('active')) renderMarket();
  }
}

/** 迷你走勢線：只表達形狀，數值看旁邊的欄位與 tooltip */
function sparkline(values, { width = 96, height = 24, zero = false } = {}) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => typeof v === 'number');
  if (pts.length < 2) return '<span class="text-faint text-xs">—</span>';
  const ys = pts.map(([, v]) => v);
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  if (zero) { min = Math.min(min, 0); max = Math.max(max, 0); }
  if (max === min) { max += 1; min -= 1; }
  const x = (i) => 2 + (i / (values.length - 1)) * (width - 4);
  const y = (v) => height - 2 - ((v - min) / (max - min)) * (height - 4);
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const [li, lv] = pts[pts.length - 1];
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true" class="inline-block align-middle">
    ${zero ? `<line x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}" stroke="rgb(var(--c-line))" stroke-dasharray="2 2"/>` : ''}
    <path d="${d}" fill="none" stroke="${series('s1')}" stroke-width="1.5"/>
    <circle cx="${x(li)}" cy="${y(lv)}" r="2.5" fill="${series('s1')}"/></svg>`;
}

/** 以零為中心的橫條：正值往右（紅、流入），負值往左（綠、流出），台股慣例 */
function divergingBar(value, maxAbs) {
  if (typeof value !== 'number' || !maxAbs) return '';
  const w = Math.min(50, (Math.abs(value) / maxAbs) * 50);
  const pos = value >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  return `<div class="relative h-2 bg-track rounded-full overflow-hidden min-w-[80px]">
    <div class="absolute inset-y-0 rounded-full ${value >= 0 ? 'bg-up' : 'bg-down'}" style="${pos}"></div>
    <div class="absolute inset-y-0 left-1/2 w-px bg-faint"></div></div>`;
}

function renderRadar() {
  const r = radarLatest;
  if (!r) return;
  if (!r.ok) {
    $('radar-body').innerHTML = `<div class="bg-surface rounded-xl border border-line">${emptyState(r.reason || '無法載入', 'fire')}</div>`;
    return;
  }
  $('radar-updated').textContent = `更新於 ${new Date(r.updatedAt).toLocaleString('zh-TW')}`;

  $('radar-body').innerHTML = `
    ${r.notes.length ? `<div class="rounded-lg border px-4 py-3 text-sm bg-warn-bg border-warn-line text-warn mb-6">
      <div class="font-medium"><svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1.5" aria-hidden="true"><use href="#i-warning"/></svg>部分資料暫時抓不到，以下結果以已取得的資料計算</div>
      <ul class="mt-1 text-xs list-disc list-inside space-y-0.5">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}
    ${signalsCard(r)}
    <div class="grid lg:grid-cols-5 gap-6 mt-6">
      ${rotationCard(r)}
      ${flowsCard(r)}
    </div>
    ${themesCard(r)}
    ${revenueCard(r)}
    <p class="text-xs text-muted mt-6 leading-relaxed">
      <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0 mr-1" aria-hidden="true"><use href="#i-info"/></svg>${esc(r.disclaimer)}
    </p>`;
}

function signalsCard(r) {
  const list = r.signals.slice(0, 8);
  return `<div class="bg-surface rounded-xl border border-line">
    <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">早期訊號</h2>
      <span class="text-xs text-muted">資金、法人、題材、股價四種訊號，同一產業出現愈多種愈值得注意</span>
    </div>
    ${list.length === 0 ? emptyState('目前沒有產業同時出現明顯的資金或題材訊號', 'fire') : `
    <ul class="divide-y divide-line-soft">${list.map((s) => `
      <li class="px-5 py-3.5 flex flex-col sm:flex-row gap-2 sm:gap-4">
        <div class="sm:w-44 shrink-0">
          <div class="font-medium">${esc(s.sector)}</div>
          <div class="mt-1 flex items-center gap-1" aria-label="${s.score} 種訊號">
            ${['turnover', 'flow', 'theme', 'price'].map((k) => `<span class="px-1.5 py-0.5 rounded text-[11px] border ${
              s.kinds.includes(k) ? 'bg-accent-bg text-accent-ink border-accent-line' : 'text-dim border-line-soft'}">${KIND_LABEL[k]}</span>`).join('')}
          </div>
        </div>
        <ul class="text-sm space-y-1 min-w-0">${s.reasons.map((x) => `<li class="text-ink">${esc(x)}</li>`).join('')}</ul>
      </li>`).join('')}</ul>`}
  </div>`;
}

function rotationCard(r) {
  const rot = r.rotation;
  if (!rot || !rot.sectors.length) {
    return `<div class="min-w-0 lg:col-span-3 bg-surface rounded-xl border border-line">${emptyState('類股成交資料暫時抓不到', 'chart-pie')}</div>`;
  }
  const rows = rot.sectors.filter((s) => s.shareRecent >= 0.5).slice(0, 14);
  const maxRel = Math.max(...rows.map((s) => Math.abs(s.relChange ?? 0)), 1);
  return `<div class="min-w-0 lg:col-span-3 bg-surface rounded-xl border border-line">
    <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">資金輪動：類股成交比重</h2>
      <span class="text-xs text-muted num">${esc(rot.from)} ～ ${esc(rot.to)} · ${rot.days} 個交易日 · 近 ${rot.recent} 日 vs 之前</span>
    </div>
    <div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="bg-raised text-muted text-xs"><tr>
        <th class="text-left font-medium px-5 py-2.5 whitespace-nowrap">類股</th>
        <th class="text-right font-medium px-3 py-2.5 whitespace-nowrap">比重（之前 → 近期）</th>
        <th class="font-medium px-3 py-2.5 whitespace-nowrap">相對變化</th>
        <th class="font-medium px-3 py-2.5 whitespace-nowrap hidden sm:table-cell">每日比重</th>
        <th class="text-right font-medium px-3 py-2.5 whitespace-nowrap">類股漲跌 5 日／20 日</th>
      </tr></thead>
      <tbody class="divide-y divide-line-soft">${rows.map((s) => {
        const ret = r.returns[s.name] || {};
        return `<tr>
          <td class="px-5 py-2.5 whitespace-nowrap">${esc(s.name)}${s.streak >= 3 && (s.relChange ?? 0) > 0 ? ' <span class="text-[11px] text-up">連 ' + s.streak + ' 日放大</span>' : ''}</td>
          <td class="px-3 py-2.5 text-right num whitespace-nowrap">${fmt(s.shareEarly)}% → <strong>${fmt(s.shareRecent)}%</strong></td>
          <td class="px-3 py-2.5"><div class="flex items-center gap-2">${divergingBar(s.relChange, maxRel)}
            <span class="num text-xs w-14 text-right ${trendClass(s.relChange)}">${s.relChange === null ? '—' : signed(s.relChange, 1) + '%'}</span></div></td>
          <td class="px-3 py-2.5 hidden sm:table-cell" title="${esc(s.series.map((v) => fmt(v)).join('%, '))}%">${sparkline(s.series)}</td>
          <td class="px-3 py-2.5 text-right num whitespace-nowrap"><span class="${trendClass(ret.r5)}">${ret.r5 == null ? '—' : signed(ret.r5) + '%'}</span>
            <span class="text-faint">／</span><span class="${trendClass(ret.r20)}">${ret.r20 == null ? '—' : signed(ret.r20) + '%'}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

const FLOW_VIEWS = [['sector', '依產業'], ['buy', '買超個股'], ['sell', '賣超個股']];

function flowsCard(r) {
  const view = FLOW_VIEWS.some(([k]) => k === profile.flowView) ? profile.flowView : 'sector';
  const st = r.flows.stocks;
  const range = r.flows.from && r.flows.to
    ? (r.flows.from === r.flows.to ? r.flows.to.slice(5) : `${r.flows.from.slice(5)}～${r.flows.to.slice(5)}`)
    : '';
  const tabs = FLOW_VIEWS.map(([k, label]) => `<button data-flow-view="${k}" class="px-2.5 py-1 text-xs rounded-md ${
    k === view ? 'bg-brand-600 text-white' : 'text-sub hover:bg-raised'}">${label}</button>`).join('');

  let body;
  if (view === 'sector') {
    const f = r.flows.sectors.filter((x) => x.total !== 0);
    if (!f.length) {
      body = emptyState('法人資料暫時抓不到', 'wallet');
    } else {
      const top = [...f.slice(0, 6), ...f.slice(-6).filter((x) => !f.slice(0, 6).includes(x))];
      const maxAbs = Math.max(...top.map((x) => Math.abs(x.total)));
      // 每個產業附上「是誰在撐／是誰在拖」：買超產業列買超最多的個股，賣超產業列賣超最多的
      const leaders = (x) => ((x.total > 0 ? st?.bySector?.[x.name] : st?.sellBySector?.[x.name]) ?? []).slice(0, 3);
      body = `<ul class="p-5 space-y-3">${top.map((x) => `
        <li class="text-sm" title="外資 ${yi(x.foreign)}、投信 ${yi(x.trust)}、自營商 ${yi(x.dealer)}">
          <div class="flex justify-between gap-2"><span>${esc(x.name)}${x.bothBuyDays >= Math.ceil(x.days / 2) ? ' <span class="text-[11px] text-up">外資投信同買 ' + x.bothBuyDays + ' 天</span>' : ''}</span>
            <span class="num ${trendClass(x.total)}">${yi(x.total)}</span></div>
          <div class="mt-1">${divergingBar(x.total, maxAbs)}</div>
          ${leaders(x).length ? `<div class="mt-1 text-[11px] text-muted leading-snug">${x.total > 0 ? '主要買超' : '主要賣超'}：${
            leaders(x).map((s) => `<button data-ta-open="${esc(s.code)}" class="hover:text-accent-ink hover:underline">${esc(s.name)} <span class="num">${yi(s.total)}</span></button>`).join('、')}</div>` : ''}
        </li>`).join('')}</ul>`;
    }
  } else {
    const list = (view === 'buy' ? st?.buys : st?.sells) ?? [];
    const watching = new Set(profile.watchlist);
    body = list.length === 0 ? emptyState('法人資料暫時抓不到', 'wallet') : `<ol class="divide-y divide-line-soft">${list.map((s, i) => `
      <li class="px-5 py-2.5 flex items-start gap-3 text-sm">
        <span class="w-5 shrink-0 text-right text-xs text-faint num pt-0.5">${i + 1}</span>
        <div class="min-w-0 flex-1">
          <div class="flex justify-between gap-2">
            <span class="truncate"><span class="font-medium">${esc(s.name)}</span> <span class="text-xs text-muted num">${esc(s.code)}</span></span>
            <span class="num shrink-0 ${trendClass(s.total)}">${yi(s.total)}</span>
          </div>
          <div class="text-[11px] text-muted num mt-0.5 flex flex-wrap gap-x-2">
            <span>${esc(s.sector)}</span>
            <span>外資 ${lots(s.foreignLots * 1000)}</span>
            <span>投信 ${lots(s.trustLots * 1000)}</span>
            ${Math.abs(s.streak) >= 2 ? `<span class="${s.streak > 0 ? 'text-up' : 'text-down'}">連 ${Math.abs(s.streak)} 日${s.streak > 0 ? '買' : '賣'}</span>` : ''}
          </div>
        </div>
        <div class="shrink-0 flex items-center">
          ${watching.has(s.code)
            ? '<span class="text-[11px] text-accent-ink px-1" title="已在自選">自選</span>'
            : `<button data-add-watch="${esc(s.code)}" class="text-faint hover:text-accent-ink px-1" title="加入自選"><svg class="w-4 h-4 inline-block align-[-0.15em]" aria-hidden="true"><use href="#i-star"/></svg></button>`}
          <button data-ta-open="${esc(s.code)}" class="text-faint hover:text-accent-ink px-1" title="技術分析"><svg class="w-4 h-4 inline-block align-[-0.15em]" aria-hidden="true"><use href="#i-chart-line"/></svg></button>
        </div>
      </li>`).join('')}</ol>`;
  }

  return `<div class="min-w-0 lg:col-span-2 bg-surface rounded-xl border border-line">
    <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">法人流向（${esc(r.flows.market)}）</h2>
      <span class="text-xs text-muted num">${range ? `${range} · ` : ''}近 ${r.flows.days} 日三大法人合計</span>
      <div class="w-full flex gap-1">${tabs}</div>
    </div>
    ${body}
    ${view !== 'sector' ? '<p class="px-5 pb-4 text-[11px] text-faint">金額為買賣超股數 × 最新收盤的近似值；不含 ETF。</p>' : ''}
  </div>`;
}

function themesCard(r) {
  const themes = [...r.themes].sort((a, b) => (b.heat?.ratio ?? 0) - (a.heat?.ratio ?? 0));
  return `<div class="bg-surface rounded-xl border border-line mt-6">
    <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">題材熱度</h2>
      <span class="text-xs text-muted">Google 新聞：最近 7 天日均則數 vs 前期</span>
    </div>
    <ul class="divide-y divide-line-soft">${themes.map((t) => {
      const h = t.heat;
      if (!h) return `<li class="px-5 py-3 text-sm flex justify-between"><span>${esc(t.label)}</span><span class="text-faint">抓不到新聞</span></li>`;
      return `<li class="px-5 py-3">
        <details>
          <summary class="flex flex-wrap items-center gap-x-4 gap-y-1 cursor-pointer text-sm">
            <span class="font-medium w-36">${esc(t.label)}</span>
            ${chipHtml(TREND_STYLE[h.trend])}
            <span class="num text-sub">近 7 日 ${h.count7} 則 · 日均 ${fmt(h.perDay7, 1)}${h.perDayPrior !== null ? `（前期 ${fmt(h.perDayPrior, 1)}）` : ''}</span>
            ${h.priceHikes.length ? `<span class="text-xs px-2 py-0.5 rounded bg-warn-bg text-warn border border-warn-line">漲價／缺貨 ${h.priceHikes.length} 則</span>` : ''}
            <span class="text-xs text-faint ml-auto">${esc(t.sectors.join('、'))}</span>
          </summary>
          <ul class="mt-2 pl-1 space-y-1.5 text-sm">
            ${[...h.priceHikes, ...h.headlines.filter((x) => !h.priceHikes.some((p) => p.title === x.title))].slice(0, 6).map((n) => `
              <li class="flex gap-2"><span class="text-xs text-muted num shrink-0 w-12">${esc(timeAgo(n.publishedAt))}</span>
                <a href="${esc(n.link)}" target="_blank" rel="noopener" class="hover:underline ${h.priceHikes.includes(n) ? 'text-warn' : 'text-ink'}">${esc(n.title)}</a>
                ${n.source ? `<span class="text-xs text-faint shrink-0">${esc(n.source)}</span>` : ''}</li>`).join('')}
          </ul>
        </details>
      </li>`;
    }).join('')}</ul>
  </div>`;
}

function revenueCard(r) {
  const rows = [...r.watchlist].sort((a, b) => (b.revenue?.yoy3 ?? -Infinity) - (a.revenue?.yoy3 ?? -Infinity));
  return `<div class="bg-surface rounded-xl border border-line mt-6">
    <div class="px-5 py-3.5 border-b border-line-soft flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-semibold">自選股營收動能與法人</h2>
      <span class="text-xs text-muted">依近 3 月平均年增率排序 · 法人為近 5 日</span>
    </div>
    <div class="overflow-x-auto"><table class="w-full text-sm">
      <thead class="bg-raised text-muted text-xs"><tr>
        <th class="text-left font-medium px-5 py-2.5 whitespace-nowrap">標的</th>
        <th class="text-right font-medium px-3 py-2.5 whitespace-nowrap">最新月營收年增</th>
        <th class="text-right font-medium px-3 py-2.5 whitespace-nowrap">近 3 月 vs 前 3 月</th>
        <th class="font-medium px-3 py-2.5 whitespace-nowrap">動能</th>
        <th class="font-medium px-3 py-2.5 whitespace-nowrap hidden md:table-cell">12 個月年增率</th>
        <th class="text-right font-medium px-3 py-2.5 whitespace-nowrap">外資</th>
        <th class="text-right font-medium px-3 py-2.5 whitespace-nowrap">投信</th>
        <th class="px-3 py-2.5"></th>
      </tr></thead>
      <tbody class="divide-y divide-line-soft">${rows.map((w) => {
        const v = w.revenue;
        return `<tr class="hover:bg-raised">
          <td class="px-5 py-2.5 whitespace-nowrap"><div class="font-medium">${esc(w.name)} <span class="text-xs text-muted num">${esc(w.code)}</span></div>
            <div class="text-xs text-faint">${esc(w.industry || '')}${w.sectorTurnover && w.sectorTurnover.relChange !== null ? ` · 類股資金 <span class="${trendClass(w.sectorTurnover.relChange)}">${signed(w.sectorTurnover.relChange, 1)}%</span>` : ''}</div></td>
          ${v ? `
          <td class="px-3 py-2.5 text-right num whitespace-nowrap"><span class="${trendClass(v.yoy)}">${v.yoy === null ? '—' : signed(v.yoy, 1) + '%'}</span>
            <div class="text-[11px] text-faint">${esc(v.month)}${v.record12 ? ' · <span class="text-up">12 月新高</span>' : ''}</div></td>
          <td class="px-3 py-2.5 text-right num whitespace-nowrap">${v.yoy3 === null ? '—' : signed(v.yoy3, 1) + '%'} <span class="text-faint">vs</span> ${v.yoyPrev3 === null ? '—' : signed(v.yoyPrev3, 1) + '%'}</td>
          <td class="px-3 py-2.5">${v.momentum ? chipHtml(MOMENTUM_STYLE[v.momentum]) : '<span class="text-faint">—</span>'}</td>
          <td class="px-3 py-2.5 hidden md:table-cell" title="${esc(v.series.map((p) => `${p.month} ${p.yoy ?? '—'}%`).join('、'))}">${sparkline(v.series.map((p) => p.yoy), { zero: true })}</td>`
          : `<td colspan="4" class="px-3 py-2.5 text-xs text-faint">${w.revenueError ? esc(w.revenueError) : 'ETF 或無月營收資料'}</td><td class="hidden md:table-cell"></td>`}
          <td class="px-3 py-2.5 text-right num whitespace-nowrap ${trendClass(w.inst5?.foreign)}">${lots(w.inst5?.foreign)}</td>
          <td class="px-3 py-2.5 text-right num whitespace-nowrap ${trendClass(w.inst5?.trust)}">${lots(w.inst5?.trust)}</td>
          <td class="px-3 py-2.5 text-right"><button data-ta-open="${esc(w.code)}" class="text-faint hover:text-accent-ink px-1" title="技術分析">
            <svg class="w-4 h-4 inline-block align-[-0.15em] shrink-0" aria-hidden="true"><use href="#i-chart-line"/></svg></button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

// ── 互動 ─────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  $(`tab-${name}`)?.classList.add('active');

  document.querySelectorAll('[data-tab]').forEach((el) => { el.className = navClass(el.dataset.tab === name); });

  location.hash = name;

  if (name === 'technical') loadTechnical();
  if (name === 'radar') loadRadar();
  // 隱藏時量不到寬度，圖要在切回來時依實際寬度重畫
  if (name === 'overview' && latest) renderOverview();

  // 手機上選完分頁就把浮層選單收起來，否則會一直蓋住內容
  if (window.matchMedia('(max-width: 767px)').matches) closeMobileMenu();
}

/** 導覽按鈕的樣式；桌機收合時只留圖示並置中 */
function navClass(active) {
  const collapsed = profile.sidebarCollapsed;
  return `w-full flex items-center gap-2.5 px-5 ${collapsed ? 'md:px-0 md:justify-center' : ''} py-2.5 text-sm transition ${
    active ? 'bg-brand-600/15 text-white border-r-2 border-brand-500' : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
  }`;
}

/** 桌機側欄收合：寬度縮成只放圖示，文字藏起來（手機的浮層選單不受影響） */
function applySidebar() {
  const aside = document.querySelector('aside');
  const c = Boolean(profile.sidebarCollapsed);
  aside.classList.toggle('md:w-60', !c);
  aside.classList.toggle('md:w-16', c);
  document.querySelectorAll('.side-label').forEach((el) => el.classList.toggle('md:hidden', c));
  document.querySelectorAll('.side-pad').forEach((el) => el.classList.toggle('md:px-3', c));
  const active = document.querySelector('.tab-content.active')?.id?.replace('tab-', '');
  document.querySelectorAll('[data-tab]').forEach((el) => { el.className = navClass(el.dataset.tab === active); });
  const btn = $('sidebar-toggle');
  btn.classList.toggle('md:justify-center', c);
  btn.setAttribute('aria-expanded', String(!c));
  btn.title = c ? '展開側欄' : '收合側欄';
  btn.querySelector('use').setAttribute('href', c ? '#i-chevron-right' : '#i-chevron-left');
  $('sidebar-toggle-label').textContent = c ? '' : '收合側欄';
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
  notify(`已加入自選 ${code}`);
  refresh();
  if (latest && ovOpen.sector) renderSectors(latest.market.summary);
  if (latest && ovOpen.flow) renderFlowsOverview();
  // 從產業雷達的法人排行加入時，列表上的「自選」標記要立刻更新
  if ($('tab-radar').classList.contains('active') && radarLatest) renderRadar();
}

let searchTimer = null;

function initEvents() {
  $('nav').innerHTML = TABS.map(([key, label, icon]) => `
    <button data-tab="${key}" class="${navClass(false)}" title="${esc(label)}">
      <svg class="w-4 h-4 shrink-0" aria-hidden="true"><use href="#i-${icon}"/></svg><span class="side-label">${esc(label)}</span>
    </button>`).join('');
  applySidebar();

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-tab], [data-add-watch], [data-remove-watch], [data-toggle-holding], [data-risk], [data-goal], [data-news-filter], [data-ta-code], [data-ta-lookback], [data-ta-bars], [data-ta-open], [data-watch-sort], [data-ov-expand], [data-ov-showall], [data-sidebar-toggle], [data-flow-view]');
    if (!target) return;

    const d = target.dataset;

    if (d.tab) return switchTab(d.tab);

    if (d.addWatch) return addToWatchlist(d.addWatch);

    if (d.flowView) {
      profile.flowView = d.flowView;
      saveLocal(); // 檢視方式是每台裝置各自的習慣，不同步
      return renderRadar();
    }

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
      refresh(); // 總覽的通道判讀用同一個通道長度
      return loadTechnical();
    }

    if (d.sidebarToggle !== undefined) {
      profile.sidebarCollapsed = !profile.sidebarCollapsed;
      saveLocal();
      applySidebar();
      // 側欄寬度變了，圖要依新的寬度重畫
      setTimeout(() => {
        if (latest && $('tab-overview').classList.contains('active')) renderOverview();
        if (taLatest && $('tab-technical').classList.contains('active')) renderTechnical();
      }, 0);
      return;
    }

    if (d.watchSort) {
      if (profile.watchSort === d.watchSort) profile.watchSortDir = profile.watchSortDir === 'asc' ? 'desc' : 'asc';
      else { profile.watchSort = d.watchSort; profile.watchSortDir = 'desc'; }
      saveLocal();
      return renderWatchlist();
    }

    if (d.ovExpand) {
      const kind = d.ovExpand;
      ovOpen[kind] = ovOpen[kind] === d.name ? null : d.name;
      if (kind === 'sector') {
        ovShowAll.sector = false;
        if (ovOpen.sector) loadSectorStocks(ovOpen.sector);
        return renderSectors(latest.market.summary);
      }
      return renderFlowsOverview();
    }

    if (d.ovShowall) {
      ovShowAll.sector = !ovShowAll.sector;
      return renderSectors(latest.market.summary);
    }

    if (d.taBars) {
      profile.taBars = Number(d.taBars);
      saveLocal();
      return renderTechnical();
    }

    if (d.toggleHolding) {
      const code = d.toggleHolding;
      profile.holdings = profile.holdings.includes(code)
        ? profile.holdings.filter((c) => c !== code)
        : [...profile.holdings, code];
      saveProfile();
      return renderOverview();
    }

    if (d.removeWatch) {
      profile.watchlist = profile.watchlist.filter((c) => c !== d.removeWatch);
      pruneHoldings(profile);
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
  $('radar-refresh').addEventListener('click', () => loadRadar({ force: true }));

  // 手機轉向、桌機縮放視窗時，技術分析圖要依新寬度重畫
  let resizeTimer = null;
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return; // 手機捲動時網址列伸縮只改高度，不必重畫
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (taLatest && $('tab-technical').classList.contains('active')) renderTechnical();
      if (latest && $('tab-overview').classList.contains('active')) renderOverview();
    }, 200);
  });
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

  // 技術分析標的的下拉選單（每次渲染都重建，所以用事件委派）
  document.addEventListener('change', (event) => {
    if (event.target.id !== 'ta-select') return;
    profile.taCode = event.target.value;
    saveProfile();
    loadTechnical();
  });

  // 使用者開始修正欄位就拿掉錯誤標記
  document.addEventListener('input', (e) => e.target.removeAttribute?.('aria-invalid'));
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
initCloudSync();
