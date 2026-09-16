---
name: taiwan-stock-analysis
description: |
  台灣上市公司（一般業）財報快照分析。從 TWSE OpenAPI 官方資料抓取最新一季損益表與資產負債表，計算關鍵財務指標，生成互動式三分頁 HTML 儀表板（經營分析 / 獲利分析 / 財務健全度）並匯出為可分享的 HTML 檔案。

  當使用者提到以下情境時，一定要使用這個 skill：
  - 「幫我分析 XXXX（股票代碼）」、「財報分析」
  - 「管銷研發費用分析」、「獲利能力」、「財務健全度」
  - 提到台灣股票代碼（4位數字）並要求分析
  - 「經營/獲利/財務分析」、「幫我看這家公司」
  - 任何涉及台股財務數據視覺化的需求

  範圍限制：目前僅涵蓋「上市（TWSE）、一般業」公司之「最新一季」財報快照。不含上櫃（TPEx）公司、金融保險/證券期貨業，也不含歷史多季趨勢與現金流量表（官方 Open Data 未提供，詳見注意事項）。
---

# 台灣股票財報快照分析 Skill

## 概述

本 skill 從 TWSE（台灣證券交易所）官方 OpenAPI 抓取台灣上市公司「一般業」的最新一季真實財報數據，計算三大維度的財務指標，並生成一份互動式 HTML 儀表板及下載檔案。

**這是單季快照，不是多年趨勢分析**（見下方「注意事項」的資料範圍限制）。三大分析維度在單季視角下改為：

- 📊 **經營分析**：當季營收、毛利率、營業利益率
- 💰 **獲利分析**：當季淨利、EPS、ROE、ROA、三層利潤率
- 🏦 **財務健全度**：流動比率、負債比率

---

## 步驟一：抓取財報數據

使用 `scripts/fetch_twse.py <股票代碼>` 從 TWSE OpenAPI 抓取資料，或直接呼叫以下兩個官方 JSON 端點：

| 報表 | 端點 |
|------|------|
| 綜合損益表（一般業、上市） | `https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci` |
| 資產負債表（一般業、上市） | `https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci` |

這兩個端點各回傳「所有上市一般業公司、最新一季」的完整陣列，需自行用 `公司代號` 欄位過濾出目標股票。**不需要**任何 cookie/token 或反爬蟲繞過手段——這是公開的官方 Open Data。

**關鍵欄位（損益表 `t187ap06_L_ci`）：**

| 欄位名 | 用途 |
|--------|------|
| 營業收入 | 當季營收 |
| 營業毛利（毛損）淨額 | 毛利金額 |
| 營業利益（損失） | 營業利益 |
| 本期淨利（淨損） | 稅後淨利 |
| 基本每股盈餘（元） | EPS |

**關鍵欄位（資產負債表 `t187ap07_L_ci`）：**

| 欄位名 | 用途 |
|--------|------|
| 流動資產 | 流動資產 |
| 流動負債 | 流動負債 |
| 資產總計 | 總資產 |
| 負債總計 | 總負債 |
| 權益總計 | 股東權益 |

> ⚠️ 若在本 session 的雲端沙盒環境中執行，直接對 `openapi.twse.com.tw` 發送 HTTP 請求可能被其 WAF 依 IP 擋下（回傳 200 但內容是安全性提示頁，非 JSON）。這與資料來源本身無關，換一個網路環境（例如使用者本機）通常可正常存取。`fetch_twse.py` 已對這種情況做了清楚的錯誤訊息。

---

## 步驟二：計算衍生指標

```python
gross_margin     = gross_profit / revenue * 100
operating_margin = operating_profit / revenue * 100
net_margin       = net_income / revenue * 100

current_ratio = current_assets / current_liabilities * 100
debt_ratio    = total_liabilities / total_assets * 100

roe = net_income / total_equity * 100
roa = net_income / total_assets * 100
```

`scripts/fetch_twse.py` 已內建以上計算，並輸出 `{stock_id}_raw_data.json`（含 `metrics`、`metadata`、`verification`）。

---

## 步驟二點五：驗證機制

### A. 資料來源標注（Provenance）

`result['metadata']` 記錄資料血緣：`fetched_at`、`source`（TWSE OpenAPI）、`source_urls`（損益表/資產負債表端點）、`mops_url`（供使用者交叉核對官方申報原文）、`year`/`season`（本季度別）、`scope`（涵蓋範圍限制）。

### B. 合理性檢查（Sanity Check）

`fetch_twse.py` 的 `sanity_check()` 會檢查：毛利率是否超出 100% 或低於 -50%、流動比率是否為負、負債比率是否超過 100%、ROE 是否超過 100%，結果存入 `result['verification']`。

### C. MOPS 原始申報連結

`result['metadata']['mops_url']` 讓使用者可一鍵前往公開資訊觀測站核對原始申報內容。

---

## 步驟三：建立 HTML 儀表板

**直接由 Claude 手寫完整 HTML**，不使用 Python 模板生成。參考 `references/dashboard_template.md` 的 CSS 與 Chart.js 規格（模板本身仍可沿用，但圖表資料只有單一季度，多期比較圖表應省略或改為單期長條圖）。

### 儀表板架構（單季快照版）

```
header（公司名稱 + 股票代碼 + 資料來源標注 + 年度/季別）
verify-bar（抓取時間 | 合理性檢查徽章 | MOPS連結按鈕）
verify-warnings（若 sanity warnings 不為空才渲染）
├── Tab 1：經營分析
│   ├── KPI Cards：當季營收 / 毛利率 / 營業利益率
│   ├── Insight Box：🔍 經營亮點（本季數字 + 產業健康水準判讀）
│   └── Chart：營收與毛利率長條圖（單期）
├── Tab 2：獲利分析
│   ├── KPI Cards：當季淨利 / EPS / ROE / ROA
│   ├── Insight Box：🔍 獲利亮點
│   └── Chart：三層利潤率（毛利率/營業利益率/淨利率）長條圖
└── Tab 3：財務健全度
    ├── KPI Cards：流動比率 / 負債比率
    ├── Insight Box：🔍 財務健全度亮點
    └── Chart：資產負債結構圖（流動 vs 非流動資產/負債）
```

**重要：由於只有單季數據，嚴禁在 KPI card 或 insight box 中宣稱「年增」「三年趨勢」「CAGR」等需要歷史對比的說法**——這些數字目前抓不到，寫出來就是編造。改用**當季絕對數值 + 與常見產業健康門檻的比較**（例如「流動比率 182%，高於 150% 健康門檻」），語氣上明確標示「本季」「當季」。

### KPI Card 規格

```html
<!-- ✅ 正確：當季數字 + 門檻判讀，不宣稱趨勢 -->
<div class="kpi-change up">▲ 本季流動比率 182%，高於 150% 健康門檻</div>
<div class="kpi-change neutral">■ 本季毛利率 24.3%</div>
<div class="kpi-change down">▼ 本季負債比率 68%，超過 60% 警戒線</div>
```

**顏色規則：**
- 🟢 `green`（`border-left: 4px solid #38a169`）：正向指標
- 🔵 `blue`（`border-left: 4px solid #3182ce`）：中性指標
- 🟠 `orange`（`border-left: 4px solid #dd6b20`）：需關注
- 🔴 `red`（`border-left: 4px solid #e53e3e`）：警示

### Chart.js 設定

- CDN：`https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js`
- 所有圖表需設 `maintainAspectRatio: false`，container 高度固定 `240px`

---

## 步驟四：Insight Box 撰寫規範

每個分頁的 insight box 標題用 `🔍 {分頁名}亮點`，包含 3–4 條**基於當季數字**的觀察，**不得捏造歷史趨勢**。

```
❌ 不合格：「營收三年來持續成長」（沒有歷史數據支撐，禁止使用）
❌ 不合格：「毛利率有所改善」（無對比基準，且暗示趨勢）
✅ 合格：「本季營收 68,596 百萬元，毛利率 24.3%，營業利益率 15.1%」
✅ 合格：「本季流動比率 182%，優於一般 150% 的健康標準，短期償債能力無虞」
✅ 合格：「本季負債比率 68%，高於 60% 的一般警戒線，建議留意槓桿結構」
```

**每條觀察應包含：**
1. 明確標註「本季」/「{年度}年Q{季別}」
2. 具體數字
3. 與常見產業判讀門檻的比較（而非與歷史自身比較）

---

## 步驟五：輸出

1. 儲存 HTML 檔案至工作目錄，檔名格式：`{公司縮寫}_{股票代碼}_analysis.html`
2. 提供下載連結
3. 用 2–3 句話摘要三大維度的核心發現（含具體數字，且註明是單季快照）
4. 附上驗證狀態：
   - 若有合理性警示（`sanity_pass == False`）→ 明確提醒用戶檢查具體欄位
   - 一律附上 MOPS 連結，讓用戶可自行核對原始申報

---

## 注意事項（資料範圍限制）

- **僅涵蓋台灣上市（TWSE）公司、「一般業」分類**：不含上櫃（TPEx）公司，也不含金融保險/證券期貨業（這些行業財報格式不同，欄位對不上 `t187ap06_L_ci`/`t187ap07_L_ci`）
- **僅有「最新一季」快照，沒有歷史多季/多年資料**：TWSE OpenAPI 的這兩個資料集只回傳最新一次申報的內容，官方未開放歷史批次下載。因此本 skill 目前無法產生多年趨勢圖或 YoY 成長率
- **不含現金流量表**：TWSE OpenAPI 未提供現金流量表資料集，故不含營業/投資/籌資現金流、自由現金流等指標
- 若欄位在特定公司財報中缺失（顯示為 `-` 或空白），以 `null` 處理，不要填入 0
- 金額單位為**仟元**（TWSE OpenAPI 原始單位）

### 待辦：多季歷史與現金流量表（future work）

若未來需要多年趨勢分析或現金流量表，原本 `scripts/fetch_goodinfo.py`（Goodinfo.tw 版本）設計上可一次取得 3 年歷史，但該站目前有 Cloudflare 反爬蟲防護，直接以 `requests` 發送請求會被擋下（回傳 JS challenge 頁面，非實際資料）——此腳本目前**無法正常運作**，暫時保留在 repo 中作為未來繞道方案的參考起點，**尚未修復**。另一條路是改用 MOPS（`mops.twse.com.tw` / `mopsov.twse.com.tw`）逐季查詢介面，但同樣有 WAF/防護機制需要處理。這兩者都需要進一步評估合法、穩定的存取方式後再實作，目前不建議在生產環境中依賴。
