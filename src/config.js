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
  bars: 30 * 60,     // 技術分析日 K（盤後才會變，盤中半小時更新一次足夠）
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

/**
 * 技術分析用的日 K 歷史。
 *
 * Yahoo 的 chart 端點一個請求就給兩年的 OHLCV，是首選；證交所／櫃買的
 * 個股日成交一次只給一個月，要連打十幾次，只當備援。2026-09-23 實測：
 * Yahoo 與櫃買正常，證交所 STOCK_DAY 在雲端環境間歇性 connection reset。
 *
 * 注意 Yahoo 跟交易所相反：帶完整的 Chrome UA（上面的 USER_AGENT）會
 * 固定回 429，只帶「Mozilla/5.0」才正常 —— 所以它用自己的 yahooUserAgent。
 */
export const HISTORY = {
  /** {symbol} → 2330.TW（上市）／6488.TWO（上櫃） */
  yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=2y&interval=1d',
  yahooUserAgent: 'Mozilla/5.0',
  /** 上市個股月成交，date=YYYYMMDD（取該月） */
  twseMonth: 'https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date={date}&stockNo={code}',
  /** 上櫃個股月成交，date=YYYY/MM/DD（取該月），成交量單位是「張」 */
  tpexMonth: 'https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code={code}&date={date}&response=json',
  /** 備援來源往回抓幾個月（120 日通道 + 指標暖機約需 9 個月） */
  fallbackMonths: 12,
};

/** 個股新聞樣板；{code} 會被代號取代（Yahoo 用 2330.TW 這種格式） */
export const NEWS_SYMBOL_FEED = 'https://tw.stock.yahoo.com/rss?s={code}.TW';
