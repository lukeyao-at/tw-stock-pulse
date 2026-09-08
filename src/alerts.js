/**
 * 提醒規則的評估。
 *
 * 規則是純資料（前端存在 localStorage，後端不保存任何個人資料），
 * 這支模組只負責「拿規則和當下行情算出哪些被觸發」，
 * 因此完全可測、無副作用。
 */

/** 支援的規則類型與說明，前端用它產生表單選項 */
export const RULE_TYPES = {
  price_above:   { label: '股價高於', unit: '元', needsValue: true },
  price_below:   { label: '股價低於', unit: '元', needsValue: true },
  pct_above:     { label: '單日漲幅超過', unit: '%', needsValue: true },
  pct_below:     { label: '單日跌幅超過', unit: '%', needsValue: true },
  volume_spike:  { label: '成交量放大倍數超過', unit: '倍', needsValue: true },
  news_bullish:  { label: '出現利多新聞', unit: '', needsValue: false },
  news_bearish:  { label: '出現利空新聞', unit: '', needsValue: false },
  event_upcoming:{ label: '天內有除權息或法說會', unit: '天', needsValue: true },
};

const daysBetween = (fromISO, toISO) =>
  Math.round((new Date(toISO).getTime() - new Date(fromISO).getTime()) / 86400000);

/**
 * @param {Array} rules [{id, code, type, value, enabled}]
 * @param {object} ctx { byCode, quoteByCode, news, events, now }
 */
export function evaluate(rules, ctx = {}) {
  const {
    byCode = new Map(),
    quoteByCode = new Map(),
    news = [],
    events = [],
    now = new Date().toISOString(),
  } = ctx;

  const triggered = [];
  const skipped = [];

  for (const rule of rules) {
    if (rule.enabled === false) continue;

    const stock = byCode.get(rule.code);
    const live = quoteByCode.get(rule.code);
    const price = live?.price ?? stock?.close ?? null;
    const pct = live?.changePercent ?? stock?.changePercent ?? null;
    const name = stock?.name || live?.name || rule.code;
    const value = Number(rule.value);

    const fire = (message, extra = {}) =>
      triggered.push({ ruleId: rule.id, code: rule.code, name, type: rule.type, message, ...extra });

    switch (rule.type) {
      case 'price_above':
        if (price === null) { skipped.push({ ruleId: rule.id, reason: '取不到價格' }); break; }
        if (price > value) fire(`${name} 現價 ${price} 元，已高於設定的 ${value} 元`, { severity: 'info', price });
        break;

      case 'price_below':
        if (price === null) { skipped.push({ ruleId: rule.id, reason: '取不到價格' }); break; }
        if (price < value) fire(`${name} 現價 ${price} 元，已低於設定的 ${value} 元`, { severity: 'warning', price });
        break;

      case 'pct_above':
        if (pct === null) { skipped.push({ ruleId: rule.id, reason: '取不到漲跌幅' }); break; }
        if (pct >= value) fire(`${name} 今日上漲 ${pct.toFixed(2)}%，超過設定的 ${value}%`, { severity: 'info', pct });
        break;

      case 'pct_below':
        if (pct === null) { skipped.push({ ruleId: rule.id, reason: '取不到漲跌幅' }); break; }
        // 跌幅用絕對值比較，使用者填 3 代表「跌超過 3%」
        if (pct <= -Math.abs(value)) fire(`${name} 今日下跌 ${Math.abs(pct).toFixed(2)}%，超過設定的 ${value}%`, { severity: 'warning', pct });
        break;

      case 'volume_spike': {
        const volume = live?.volume ?? stock?.volume ?? null;
        const baseline = stock?.avgVolume ?? null;
        if (volume === null || !baseline) {
          // 沒有均量基準時明確跳過，而不是拿當日量跟自己比得出假結果
          skipped.push({ ruleId: rule.id, reason: '缺少均量基準，無法計算放大倍數' });
          break;
        }
        const ratio = volume / baseline;
        if (ratio >= value) fire(`${name} 成交量為均量的 ${ratio.toFixed(1)} 倍`, { severity: 'info', ratio });
        break;
      }

      case 'news_bullish':
      case 'news_bearish': {
        const want = rule.type === 'news_bullish' ? '利多' : '利空';
        const hits = news.filter(
          (item) =>
            item.sentiment?.label === want &&
            (item.matchedSymbols || []).some((m) => m.code === rule.code),
        );
        if (hits.length) {
          fire(`${name} 出現 ${hits.length} 則${want}新聞：${hits[0].title}`, {
            severity: want === '利多' ? 'info' : 'warning',
            news: hits.slice(0, 3).map((h) => ({ title: h.title, link: h.link })),
          });
        }
        break;
      }

      case 'event_upcoming': {
        const window = Number.isFinite(value) && value > 0 ? value : 7;
        const upcoming = events
          .filter((e) => e.code === rule.code)
          .map((e) => ({ ...e, inDays: daysBetween(now, e.date) }))
          .filter((e) => e.inDays >= 0 && e.inDays <= window)
          .sort((a, b) => a.inDays - b.inDays);

        if (upcoming.length) {
          const next = upcoming[0];
          fire(
            `${name} ${next.inDays === 0 ? '今日' : `${next.inDays} 天後`}有${next.kind}（${next.date}）`,
            // 事件本身不帶多空方向，用中性色，不要顯示成利多
            { severity: 'neutral', event: next },
          );
        }
        break;
      }

      default:
        skipped.push({ ruleId: rule.id, reason: `未知的規則類型 ${rule.type}` });
    }
  }

  return { triggered, skipped, evaluatedAt: now };
}
