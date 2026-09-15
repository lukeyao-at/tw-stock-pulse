#!/bin/bash
set -euo pipefail

# 只有 tailwindcss 這個開發期依賴需要裝——app 本身零執行期依賴，
# npm start / npm test 不裝 node_modules 也能跑；這支只是讓
# npm run build:css / build:demo（調整 UI 樣式時會用到）一開始就能用。
npm install
