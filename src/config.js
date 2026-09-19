/**
 * 全站設定。所有外部來源都集中在這裡，方便你在本機用
 * `npm run check-sources` 驗證後直接增刪，不必動到抓取邏輯。
 */

export const PORT = Number(process.env.PORT || 8420);

/** 設 TSP_OFFLINE=1 完全不連外，改用 data/sample-*.json 的樣本資料。 */
export const OFFLINE = process.env.TSP_OFFLINE === '1';

/** 對外請求的逾時與重試 */
export const HTTP_TIMEOUT_MS = Number(process.env.TSP_HTTP_TIMEOUT || 12000);
export const HTTP_RETRIES = Number(process.env.TSP_HTTP_RETRIES || 2);

/**
 * 瀏覽器樣的 UA。證交所與櫃買的公開端點對預設的 node/curl UA
 * 偶爾會回 403，帶上一般 UA 比較穩。
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 各類資料的快取秒數。盤中報價短、基本面長。 */
export const TTL = {
  quotes: 30,        // 即時報價
  daily: 10 * 60,    // 每日收盤行情
  valuation: 60 * 60,// 本益比/殖利率/股價淨值比
  profile: 12 * 3600,// 公司基本資料（產業別）
  events: 3600,      // 除權息、法說會等事件
  news: 5 * 60,      // 新聞
};

/**
 * 上市（TWSE）公開端點。
 *
 * 實測發現：openapi.twse.com.tw（新版 API 網域）的 WAF 會擋掉雲端機房
 * IP（見 2026-09-15 的診斷記錄），但舊版 www.twse.com.tw 網域＋
 * response=open_data／response=json 參數不會被擋 —— 這是政府開放資料
 * 平台登記的正式格式，不是繞防護的取巧做法。dailyAll/valuation 因此
 * 改回傳 CSV（response=open_data），事件端點回傳 { fields, data }
 * 的陣列格式（response=json），兩者都改在 src/sources/twse.js 解析，
 * 不是 openapi 那種現成物件陣列。
 *
 * 公司基本資料（profile）與盤中即時報價（見 MIS 設定）目前找不到
 * 未被擋的替代端點，維持原網址；抓不到時該欄位顯示「—」，
 * 不影響其他功能（見 src/universe.js 的容錯設計）。
 */
export const TWSE = {
  /** 每日收盤行情（全部上市個股）—— CSV 格式 */
  dailyAll: 'https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data',
  /** 個股本益比、殖利率及股價淨值比 —— CSV 格式 */
  valuation: 'https://www.twse.com.tw/exchangeReport/BWIBBU_ALL?response=open_data',
  /** 上市公司基本資料（含產業別）—— 目前無替代來源，多半會失敗 */
  profile: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  /**
   * 事件類端點。這幾支的代號較容易改版，所以做成候選清單：
   * 逐一嘗試，成功的就用，失敗的略過（不會影響其他分頁）。
   * 前兩支已驗證可用（response=json，{fields, data} 陣列格式）；
   * 後兩支源自 MOPS，目前找不到未被擋的路徑，保留候選讓它自然失敗。
   */
  eventCandidates: [
    { kind: '除權息', url: 'https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json' },
    { kind: '除權息預告', url: 'https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json' },
    { kind: '法說會', url: 'https://openapi.twse.com.tw/v1/opendata/t187ap38_L' },
    { kind: '月營收', url: 'https://openapi.twse.com.tw/v1/opendata/t187ap05_L' },
  ],
};

/** 上櫃（TPEx）公開端點 */
export const TPEX = {
  /** 上櫃股票行情 */
  dailyAll: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes',
  /** 上櫃本益比等 */
  valuationCandidates: [
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_peratio_analysis',
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap14_O',
  ],
  /** 上櫃公司基本資料 */
  profileCandidates: [
    'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O',
    'https://www.tpex.org.tw/openapi/v1/opendata_t187ap03_O',
  ],
};

/**
 * 盤中即時報價。mis 端點需要帶 Referer，否則會被擋。
 * ex_ch 格式：tse_2330.tw（上市）/ otc_6488.tw（上櫃），用 | 串接。
 */
export const MIS = {
  base: 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp',
  referer: 'https://mis.twse.com.tw/stock/fibest.jsp',
  /** 單次查詢的檔數上限，超過會被截斷 */
  batchSize: 40,
};

/**
 * 新聞來源（RSS/Atom 皆可）。
 * `symbolFeed` 是可帶入個股代號的樣板，用於自選股的精準新聞。
 */
export const NEWS_FEEDS = [
  { name: 'Yahoo 股市', url: 'https://tw.stock.yahoo.com/rss?category=news' },
  { name: '經濟日報 證券', url: 'https://money.udn.com/rssfeed/news/1001/5591?ch=money' },
  { name: 'ETtoday 財經', url: 'https://feeds.feedburner.com/ettoday/finance' },
  // 鉅亨網（404）與工商時報（403）的舊網址已失效，實測日期見 README「已知限制」；
  // 留言在此，若之後找到新網址直接換掉即可，抓取邏輯不用動。
];

/** 個股新聞樣板；{code} 會被代號取代（Yahoo 用 2330.TW 這種格式） */
export const NEWS_SYMBOL_FEED = 'https://tw.stock.yahoo.com/rss?s={code}.TW';

/**
 * Gemini Deep Research（AI 市場報告，選用功能）。
 *
 * 不設 GEMINI_API_KEY 時這個功能整個不啟用（前端按鈕會停用並說明原因），
 * 不影響其他功能 —— 跟其他來源失敗時的降級邏輯一致。這是本專案
 * 唯一需要 API key 的功能，金鑰只透過環境變數帶入，不寫進任何檔案。
 *
 * 費用由你自己的 Gemini 帳號計費，每次研究約 1~7 美元（依模型與
 * 研究深度而定），且是非同步任務，可能要等數分鐘到最多一小時。
 */
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
/** deep-research-preview-04-2026（快，適合網頁等待）或 deep-research-max-preview-04-2026（更完整但更慢更貴） */
export const GEMINI_DEEP_RESEARCH_MODEL =
  process.env.GEMINI_DEEP_RESEARCH_MODEL || 'deep-research-preview-04-2026';
