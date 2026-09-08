/**
 * Tailwind 設定。
 *
 * 樣式在建置期產生成 public/tailwind.css 並提交進版控，
 * 執行期不依賴任何 CDN —— 這樣離線模式才名副其實，
 * 也讓 npm start 不需要 npm install 就能跑。
 */
export default {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans TC"', '"PingFang TC"', '"Microsoft JhengHei"', '"Heiti TC"', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 500: '#3b82f6',
          600: '#2563eb', 700: '#1d4ed8', 800: '#1e40af', 900: '#1e3a8a',
        },
        sidebar: '#0f172a',
        // 台股慣例：紅漲綠跌，與歐美相反
        up: '#dc2626',
        down: '#16a34a',
      },
    },
  },
  plugins: [],
};
