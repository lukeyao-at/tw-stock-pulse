/**
 * 欄位解析工具。
 *
 * 證交所與櫃買的 OpenAPI 欄位名稱在改版之間會變（同一份行情
 * 可能叫 Code、SecuritiesCompanyCode 或 公司代號），所以一律用
 * 「候選名稱清單」去挑，而不是硬綁單一欄位名。這樣端點改版時
 * 通常不用改程式。
 */

/** 從物件裡挑第一個有值的候選欄位。支援模糊比對（去空白、忽略大小寫）。 */
export function pick(row, candidates) {
  for (const key of candidates) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  // 退而求其次：正規化後再比一次，吃掉「殖利率(%)」這類帶單位的欄名差異
  const norm = (s) => String(s).toLowerCase().replace(/[\s_()%（）]/g, '');
  const map = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const key of candidates) {
    const hit = map.get(norm(key));
    if (hit && row[hit] !== undefined && row[hit] !== null && row[hit] !== '') return row[hit];
  }
  return undefined;
}

/**
 * 把交易所回傳的字串轉成數字。
 * 要處理：千分位逗號、"--" / "-" / "N/A" 等無資料標記、
 * 以及漲跌欄常見的 "X0.00"（X 表示除權息，非數值）與全形正負號。
 */
export function num(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  let s = String(value).trim();
  if (!s || /^(--?|N\/A|NA|null|不適用|無)$/i.test(s)) return null;

  s = s
    .replace(/,/g, '')
    .replace(/[＋﹢]/g, '+')
    .replace(/[－﹣—–]/g, '-')
    .replace(/^X/i, '')      // 除權息標記
    .replace(/\s/g, '');

  if (s === '' || s === '+' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 台股代號：四位數（少數 ETF/特別股為 4 位加英文，一律保留原樣） */
export function normalizeCode(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim().toUpperCase();
  return /^[0-9]{4}[0-9A-Z]?$/.test(s) ? s : null;
}

/**
 * 民國日期轉西元 ISO 日期。交易所的事件表常用 "1140908" 或
 * "114/09/08" 這種格式；已是西元的（2026-09-08 / 20260908）原樣處理。
 */
export function twDateToISO(value) {
  if (!value) return null;
  const s = String(value).trim().replace(/[/.]/g, '-');

  let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{2,3})-?(\d{2})-?(\d{2})$/);
  if (m) return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;

  return null;
}

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&'); // 最後才解 &amp;，否則 &amp;lt; 會被解成 <

/**
 * 去掉 HTML 標籤與 entity，用於新聞摘要。
 *
 * RSS 的 description 通常是「被 escape 過的 HTML」（&lt;p&gt;…），
 * 所以剝標籤要做兩趟：先剝真標籤 → 解 entity → 再剝解出來的標籤。
 * 只做一趟會讓 <p> 這種東西原封不動留在摘要裡。
 */
export function stripHtml(html) {
  if (!html) return '';
  const once = String(html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ');

  return decodeEntities(once)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tagText = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripHtml(m[1]) : '';
};

/**
 * 通吃 RSS 2.0 與 Atom 的極簡解析器。
 * 只取我們用得到的欄位，刻意不引入 XML 套件（此專案零執行期依賴）。
 */
export function parseFeed(xml, { sourceName = '' } = {}) {
  if (!xml) return [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];

  return blocks.map((block) => {
    const title = tagText(block, 'title');
    // Atom 的連結在屬性上；RSS 在標籤內文
    let link = tagText(block, 'link');
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = m ? m[1] : '';
    }
    const rawDate =
      tagText(block, 'pubDate') || tagText(block, 'updated') ||
      tagText(block, 'published') || tagText(block, 'dc:date');
    const parsed = rawDate ? new Date(rawDate) : null;

    return {
      title,
      link,
      summary: (tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content')).slice(0, 300),
      publishedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      source: sourceName,
    };
  }).filter((item) => item.title);
}
