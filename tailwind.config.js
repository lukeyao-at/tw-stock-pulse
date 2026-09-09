/**
 * Tailwind 設定。
 *
 * 顏色一律走語意 token（surface / ink / line / up / down…），不直接用
 * slate-200 這種調色盤數值 —— 這樣切換深色只要換 CSS 變數，不必去改
 * 散落在各處的 class。實際色值定義在 src/styles.css。
 *
 * token 用 `rgb(var(--x) / <alpha-value>)` 的形式，讓 bg-surface/80
 * 這類透明度修飾詞仍然可用。
 */

const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans TC"', '"PingFang TC"', '"Microsoft JhengHei"', '"Heiti TC"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // 品牌色在兩個主題共用
        brand: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 500: '#3b82f6',
          600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a',
        },
        // 側欄兩個主題都是深色，維持自己的固定色
        sidebar: token('sidebar'),

        // ── 版面層次
        canvas: token('canvas'),      // 頁面底色
        surface: token('surface'),    // 卡片
        raised: token('raised'),      // 表頭、hover、次要區塊
        track: token('track'),        // 進度條底、標籤底

        // ── 文字層次（由強到弱）
        ink: token('ink'),
        sub: token('sub'),
        muted: token('muted'),
        faint: token('faint'),
        dim: token('dim'),

        // ── 線條
        line: token('line'),
        'line-soft': token('line-soft'),

        // ── 台股慣例：紅漲綠跌，與歐美相反
        up: token('up'),
        'up-bg': token('up-bg'),
        'up-line': token('up-line'),
        down: token('down'),
        'down-bg': token('down-bg'),
        'down-line': token('down-line'),

        // ── 狀態（與漲跌分開，避免語意混淆）
        warn: token('warn'),
        'warn-strong': token('warn-strong'),
        'warn-bg': token('warn-bg'),
        'warn-line': token('warn-line'),
        danger: token('danger'),
        'danger-bg': token('danger-bg'),
        'danger-line': token('danger-line'),
        ok: token('ok'),

        // ── 強調（chip、次要按鈕）
        'accent-bg': token('accent-bg'),
        'accent-ink': token('accent-ink'),
        'accent-line': token('accent-line'),
      },
    },
  },
  plugins: [],
};
