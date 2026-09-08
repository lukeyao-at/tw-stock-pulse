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
 * openapi.twse.com.tw 回傳 JSON 陣列且允許跨域，是最穩的一組。
 */
export const TWSE = {
  /** 每日收盤行情（全部上市個股） */
  dailyAll: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  /** 個股本益比、殖利率及股價淨值比 */
  valuation: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',
  /** 上市公司基本資料（含產業別） */
  profile: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',
  /**
   * 事件類端點。這幾支的代號較容易改版，所以做成候選清單：
   * 逐一嘗試，成功的就用，失敗的略過（不會影響其他分頁）。
   */
  eventCandidates: [
    { kind: '除權息', url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT49U' },
    { kind: '除權息預告', url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U' },
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
  { name: '鉅亨網 台股', url: 'https://news.cnyes.com/rss/news/cat/tw_stock_news' },
  { name: '經濟日報 證券', url: 'https://money.udn.com/rssfeed/news/1001/5591?ch=money' },
  { name: '工商時報', url: 'https://ctee.com.tw/feed' },
];

/** 個股新聞樣板；{code} 會被代號取代（Yahoo 用 2330.TW 這種格式） */
export const NEWS_SYMBOL_FEED = 'https://tw.stock.yahoo.com/rss?s={code}.TW';
