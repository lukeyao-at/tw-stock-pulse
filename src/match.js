/**
 * 把新聞和個股對起來 —— 「個人化標題」的核心。
 *
 * 三種比對強度：
 *  1. 來自個股專屬 feed（news.forSymbols）→ 直接採信，不需猜。
 *  2. 標題/摘要出現四位數代號 → 高信心。
 *  3. 標題/摘要出現公司名稱或別名 → 中信心。
 */

/** 常見的簡稱／別名，補足官方名稱在新聞裡不會出現的情況 */
const ALIASES = new Map([
  ['2330', ['台積電', '台積', 'TSMC']],
  ['2317', ['鴻海', '富士康']],
  ['2454', ['聯發科']],
  ['2308', ['台達電']],
  ['2412', ['中華電']],
  ['2882', ['國泰金']],
  ['2881', ['富邦金']],
  ['2603', ['長榮海運', '長榮']],
  ['2609', ['陽明海運', '陽明']],
  ['3711', ['日月光']],
  ['2303', ['聯電']],
  ['1301', ['台塑']],
  ['1303', ['南亞']],
  ['2002', ['中鋼']],
  ['0050', ['元大台灣50', '台灣50']],
  ['0056', ['元大高股息', '高股息']],
  ['00878', ['國泰永續高股息']],
]);

/**
 * 緊接在數字後面代表「這是數量而不是股票代號」的單位。
 * 少了這道防線，「台股 2026 年展望」會被判成榮科(2026)的新聞。
 */
const QUANTITY_SUFFIX = /^\s*(年|月|日|點|元|億|萬|股|人|家|%|％)/;

function codeHit(text, code) {
  // 用非數字邊界包住，避免 2330 命中「12330」這種數字串
  const re = new RegExp(`(?<![0-9])${code}(?![0-9])`, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const after = text.slice(m.index + code.length);
    if (!QUANTITY_SUFFIX.test(after)) return true;
  }
  return false;
}

/**
 * 判斷 name 是否真的出現在 text 裡，且該次出現不是屬於另一家
 * 名字更長的公司。
 *
 * 中文沒有詞界，所以「這次命中的前後是不是中文字」完全不可用來判斷
 * ——「中鋼盤後大單」的中鋼是真命中，後面就是中文字。真正要排除的是
 * 「中鋼構漲停」這種：命中的位置其實是另一家公司（中鋼構）的開頭。
 * 因此改成比對 competitors：只要有任何一次出現不被更長的公司名覆蓋，
 * 就算命中。這也讓「長榮航空與長榮海運雙漲」能正確歸給長榮海運。
 */
function nameHit(text, name, competitors) {
  if (!name) return false;
  const longer = competitors.filter((c) => c.length > name.length && c.includes(name));

  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at === -1) return false;

    // 這次出現是否落在某個更長公司名的範圍內？
    const shadowed = longer.some((c) => {
      const start = at - c.indexOf(name);
      return start >= 0 && text.startsWith(c, start);
    });
    if (!shadowed) return true;

    from = at + name.length;
  }
}

/**
 * 為一則新聞標出相關個股。
 * @param {{title:string, summary?:string, symbols?:string[]}} item
 * @param {Array<{code:string,name:string}>} watchlist 使用者的自選股
 * @param {{allNames?:string[]}} opts allNames 傳入整個市場的公司名稱，
 *        用來判斷短名稱是否其實屬於別家公司（中鋼 vs 中鋼構）。
 *        不傳則只用自選股的名稱比對，誤判率會高一些。
 */
export function symbolsFor(item, watchlist, { allNames = [] } = {}) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const found = new Map();

  // 1. 個股專屬 feed 的標記最可信
  for (const code of item.symbols ?? []) {
    found.set(code, { code, confidence: 'high', via: '個股新聞源' });
  }

  const watchNames = watchlist.flatMap((s) => [s.name, ...(ALIASES.get(s.code) ?? [])]).filter(Boolean);
  const competitors = [...new Set([...allNames, ...watchNames])];

  for (const stock of watchlist) {
    if (found.has(stock.code)) continue;

    // 2. 代號
    if (codeHit(text, stock.code)) {
      found.set(stock.code, { code: stock.code, confidence: 'high', via: '代號' });
      continue;
    }

    // 3. 名稱與別名。自己的名字與別名不能算自己的 competitor，
    //    否則「長榮海運」會把「長榮」遮蔽掉。
    const own = new Set([stock.name, ...(ALIASES.get(stock.code) ?? [])].filter(Boolean));
    const others = competitors.filter((c) => !own.has(c));

    const hit = [...own]
      // 長的名稱先試，命中的資訊比較精確
      .sort((a, b) => b.length - a.length)
      .find((n) => nameHit(text, n, others));

    if (hit) {
      found.set(stock.code, { code: stock.code, confidence: 'medium', via: `名稱「${hit}」` });
    }
  }

  return [...found.values()];
}
