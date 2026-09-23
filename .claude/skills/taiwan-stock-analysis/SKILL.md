---
name: taiwan-stock-analysis
description: |
  台灣上市櫃公司三維財務分析儀表板。從 FinMind API 抓取多季損益表、資產負債表、現金流量表，計算關鍵財務指標與歷史趨勢，生成互動式三分頁 HTML 儀表板（經營分析 / 獲利分析 / 財務健全度）並匯出為可分享的 HTML 檔案。

  當使用者提到以下情境時，一定要使用這個 skill：
  - 「幫我分析 XXXX（股票代碼）」、「財報分析」、「三維分析」
  - 「管銷研發費用分析」、「獲利能力」、「財務健全度」
  - 提到台灣股票代碼（4位數字）並要求分析
  - 「經營/獲利/財務分析」、「幫我看這家公司」
  - 任何涉及台股財務數據視覺化的需求

  需要環境變數 FINMIND_TOKEN，本 repo 已在 `.claude/settings.json` 的 `env` 設定好，session 會自動帶入。沒有 token 時可退回 `fetch_twse.py`（僅上市一般業、單季快照，見步驟一備援方案）。
---

# 台灣股票三維財務分析 Skill

## 概述

本 skill 從 [FinMind](https://finmind.github.io/) 開源 API 抓取台灣上市**及上櫃**公司的真實財報數據（多季歷史），計算三大維度的財務指標，並生成一份互動式 HTML 儀表板及下載檔案。

**三大分析維度：**
- 📊 **經營分析**：營收成長、毛利率、營業利益率趨勢
- 💰 **獲利分析**：淨利、EPS、ROE、ROA、三層利潤率
- 🏦 **財務健全度**：流動比率、負債比率、營業/投資/籌資現金流、自由現金流（FCF）

---

## 步驟一：抓取財報數據

### 主要方案：`scripts/fetch_finmind.py`（推薦，多季 + 現金流量表）

```bash
python scripts/fetch_finmind.py <股票代碼> [起始日期 YYYY-MM-DD]
# 例：python scripts/fetch_finmind.py 2317 2023-01-01
# FINMIND_TOKEN 由 .claude/settings.json 的 env 自動帶入，不需要手動指定
```

- Token 從環境變數 `FINMIND_TOKEN` 讀取。本 repo 為私人 repo，token 由擁有者決定放在 `.claude/settings.json` 的 `env`；換 token 時只改那裡。**不要把 token 寫進程式碼、SKILL.md 或任何輸出檔案**（HTML、JSON）。若 repo 將轉為公開或分享給他人，先到 FinMind 重新產生 token，並把它移出 `.claude/settings.json`。
- 匿名（無 token）請求額度很低，且是依 IP 計算的共用額度，在雲端沙盒環境中很容易被其他人的請求用完，回傳 `{"status":402,"msg":"Requests reach the upper limit"}`。這種情況下請使用者確認 token 是否有正確帶入。
- 涵蓋：上市（TWSE）**及**上櫃（TPEx）公司，資料集：
  - `TaiwanStockFinancialStatements`（綜合損益表）
  - `TaiwanStockBalanceSheet`（資產負債表）
  - `TaiwanStockCashFlowsStatement`（現金流量表）
- 輸出 `{stock_id}_raw_data.json`，內含 `quarters`（每季一筆，含 `date` 與 `metrics`）、`metadata`、`verification`。
- 預設抓最近 3 年（可用第二個參數指定起始日期）。
- 注意：`roe`/`roa`/各利潤率是**單季數字**，不是年化值；若要呈現年度趨勢，用同一年度四季加總或取第四季（累計）數字，不要把單季 ROE 乘以 4 冒充年化，須在圖表/文字上說清楚是「單季」。

### 備援方案：`scripts/fetch_twse.py`（不需要 token，但只有上市一般業、單季快照）

若使用者沒有 FinMind token 且不想申請，可退回這個純官方 Open Data 方案（`openapi.twse.com.tw`，不需 cookie/token）。限制：只有最新一季、不含上櫃/金融業、不含現金流量表。細節見腳本內註解。

> ⚠️ 這兩個腳本若在**本 session 的雲端沙盒環境**中直接對外送 HTTP 請求，可能遇到目標網站的 WAF 依出口 IP 擋下（回傳非預期內容而非錯誤碼）。若發生，請使用者換成本機或其他網路環境重試——這與程式邏輯或資料源本身無關。目前已驗證過 `api.finmindtrade.com` 在此環境可正常連線。

### 已知不可用：`scripts/fetch_goodinfo.py`（保留供參考，未修復）

原本設計從 Goodinfo.tw 抓取，但該站現有 Cloudflare 反爬蟲防護，直接 `requests` 會被擋下（回傳 JS challenge 頁面）。FinMind 方案已涵蓋 Goodinfo 版本原本想要的多季歷史與現金流量表，**不需要再修復這支腳本**，保留純粹是歷史參考。

---

## 步驟二：計算衍生指標

```python
gross_margin     = gross_profit / revenue * 100
operating_margin = operating_income / revenue * 100
net_margin       = net_income / revenue * 100

current_ratio = current_assets / current_liabilities * 100
debt_ratio    = total_liabilities / total_assets * 100

roe = net_income / total_equity * 100   # 單季，非年化
roa = net_income / total_assets * 100   # 單季，非年化

fcf = operating_cf + capex   # capex（PropertyAndPlantAndEquipment）取得/處分固定資產已為負值時代表現金流出
```

`scripts/fetch_finmind.py` 已內建以上計算，逐季輸出於 `quarters[].metrics`。

---

## 步驟二點五：驗證機制

### A. 資料來源標注（Provenance）

`result['metadata']` 記錄：`fetched_at`、`source`（FinMind）、`source_urls`（三張報表的實際查詢 URL）、`mops_url`/`mops_url_otc`（供交叉核對官方申報原文）、`quarters_covered`、`currency`。

### B. 合理性檢查（Sanity Check）

`fetch_finmind.py` 的 `sanity_check()` 逐季檢查：毛利率是否超出 100% 或低於 -50%、流動比率是否為負、負債比率是否超過 100%、ROE 是否超過 100%，結果存入 `result['verification']`。

### C. MOPS 原始申報連結

`metadata['mops_url']`（上市）/ `mops_url_otc`（上櫃）讓使用者可一鍵前往公開資訊觀測站核對原始申報內容。

---

## 步驟三：建立 HTML 儀表板

**直接由 Claude 手寫完整 HTML**，不使用 Python 模板生成。參考 `references/dashboard_template.md` 的 CSS 與 Chart.js 規格。

### 儀表板架構

```
header（公司名稱 + 股票代碼 + 資料來源標注）
verify-bar（抓取時間 | 合理性檢查徽章 | MOPS連結按鈕）
verify-warnings（若 sanity warnings 不為空才渲染）
├── Tab 1：經營分析
│   ├── KPI Cards：最新季營收 / 毛利率 / 營業利益率（含 QoQ 或 YoY 具體數字）
│   ├── Insight Box：🔍 經營亮點
│   ├── Charts：營收+毛利率（逐季）/ 三層利潤率趨勢
│   └── Data Table：損益表明細（含「趨勢評估」欄）
├── Tab 2：獲利分析
│   ├── KPI Cards：最新季淨利 / EPS / ROE / ROA
│   ├── Insight Box：🔍 獲利亮點
│   ├── Charts：淨利+淨利率（逐季）/ EPS 趨勢
│   └── Data Table：獲利能力彙總（含「趨勢評估」欄）
└── Tab 3：財務健全度
    ├── KPI Cards：流動比率 / 負債比率 / FCF
    ├── Insight Box：🔍 財務健全度亮點
    ├── Charts：流動+負債比率趨勢 / 現金流三表逐季長條圖
    └── Data Table：資產負債與現金流摘要（含「趨勢評估」欄）
```

**重要：** 只有幾季資料時（例如剛好 FinMind 對某公司/期間回傳的季數不足），不要硬湊「三年趨勢」的措辭——實際有幾季就講幾季，數字必須跟 `quarters` 陣列長度一致，不可外推或編造缺失季度。

### KPI Card 規格

`kpi-change` 必須包含具體數字，例如：

```html
<div class="kpi-change up">▲ +18.1% QoQ（2026Q2 25.3億 vs 2026Q1 21.2億），AI伺服器訂單驅動</div>
<div class="kpi-change neutral">■ 近4季毛利率 6.1%→6.4%→6.2%→6.1%，區間震盪</div>
<div class="kpi-change down">▼ 負債比率連續4季上升 55%→57%→61%→62%</div>
```

**顏色規則：**
- 🟢 `green`（正向）　🔵 `blue`（中性）　🟠 `orange`（需關注）　🔴 `red`（警示）

### Chart.js 設定

- CDN：`https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.min.js`
- 所有圖表需設 `maintainAspectRatio: false`，container 高度固定 `240px`
- 組合圖（bar + line）使用雙 Y 軸

---

## 步驟四：Insight Box 撰寫規範

每個分頁的 insight box 標題用 `🔍 {分頁名}亮點`，包含 3–5 條具體數字觀察，**只能引用 `quarters` 陣列裡實際存在的季度**。

```
❌ 不合格：「營收有所成長」（無數字、無幅度）
✅ 合格：「近4季營收 13,240 → 15,506 → 18,546 → 21,305 億元，QoQ 持續成長，2024Q4 創新高」
✅ 合格：「2024Q3 營業CF為 -186 億（異常轉負），2024Q4 回復至 1,660 億，現金轉換能力確認」
```

**每條觀察應包含：** 起點→終點數字（或完整季度數列）、幅度（QoQ/絕對變化）、原因推斷或意義。

---

## 步驟五：輸出

1. 儲存 HTML 檔案至工作目錄，檔名格式：`{公司縮寫}_{股票代碼}_analysis.html`
2. 提供下載連結
3. 用 2–3 句話摘要三大維度的核心發現（含具體數字）
4. 附上驗證狀態：若有合理性警示（`sanity_pass == False`）→ 明確提醒用戶檢查具體欄位；一律附上 MOPS 連結

---

## 注意事項

- **FINMIND_TOKEN 是敏感憑證**：唯一存放處是 `.claude/settings.json` 的 `env`；不要印出完整 token、不要另外寫進程式碼或其他 commit、不要放進生成的 HTML 或 JSON 輸出檔
- 若欄位缺失（`None`），圖表以 `null` 處理，不要填入 0
- 金額單位為 FinMind 原始單位（**元**，非億元/仟元），撰寫 insight 時請自行換算成「億元」等易讀單位並在文中註明
- ROE/ROA/各項利潤率為**單季**數字，非年化；如需年度數字，用該年度四季加總的損益項目重新計算，不要直接對單季數字做簡單換算
- 此 skill 適用台灣上市/上櫃公司（4 位數股票代碼）；金融保險/證券期貨業的財報科目與一般業不同，`fetch_finmind.py` 目前的欄位對照未做這類產業的特化處理，抓到的數字需人工複核
