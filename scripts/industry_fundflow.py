#!/usr/bin/env python3
"""
industry_fundflow.py
全市場（上市+上櫃）當日三大法人（外資/投信/自營商）買賣超金額，依產業別加總排名。

用法：
  FINMIND_TOKEN=xxx python scripts/industry_fundflow.py [日期 YYYYMMDD] [成交值前N大] [列出前幾名產業]
  範例：FINMIND_TOKEN=xxx python scripts/industry_fundflow.py 20260923 300 3

資料來源（全部是官方公開資料，全市場「一次查詢」，不需要逐股迴圈打 API）：
- TWSE 每日收盤行情（全部上市個股，含成交金額/收盤價）：
  https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data
- TWSE 三大法人買賣超日報表（全部上市個股）：
  https://www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALL&response=json
- TPEx 上櫃行情（全部上櫃個股）：
  https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes
- TPEx 三大法人買賣超（全部上櫃個股）：
  https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading
- FinMind TaiwanStockInfo（產業別對照表，上市+上櫃+興櫃）：
  需要 FINMIND_TOKEN（免費註冊：https://finmindtrade.com/），這是唯一用到 FinMind 的地方，
  且只查一次（不逐股查），不會受免費額度限制影響。

方法：
1. 抓全市場當日收盤價、成交金額、三大法人買賣超股數（TWSE/TPEx 各一次官方查詢，不經 FinMind）
2. 用 FinMind 的產業別對照表把每檔股票分類
3. 依當日「成交金額」排序，取前 N 大活躍股（預設 300 檔）——排除興櫃/極冷門股的雜訊，
   同時控制運算範圍；活躍股本來就是資金流向觀察的重點
4. 前 N 檔的「三大法人買賣超金額」= 收盤價 × 三大法人合計買賣超股數，依產業加總、排名

注意：
- 買賣超金額是「股數 × 收盤價」概估，跟正式盤中逐筆成交精算的金額可能有些微差異
- 台股當天的三大法人買賣超數據，TWSE/TPEx 通常要到約 15:00~15:30 後才公布，
  太早查詢當日日期會拿到空資料或前一交易日尚未更新的狀態，此時可改查前一個交易日
- 這是「成交值前 N 大活躍股」的資金流向，不是嚴格意義的全市場（但已涵蓋絕大多數資金）

已知限制（2026-09-23 實測）：
`TWSE_INSTITUTIONAL`（T86）這個端點在本 session 的雲端沙盒環境中，**查「今天」的日期可正常回傳，
查前一個交易日等歷史日期卻會被 WAF 擋下**（回傳安全性提示頁而非 JSON），兩者參數只差 date 值。
懷疑是 TWSE 只讓自家前端常用的「當日」查詢通過某種快取/白名單，對歷史日期查詢較嚴格。
這代表本腳本目前只能可靠地查「當天」，還沒辦法穩定回補過去日期；若要做歷史趨勢，
需要另外評估（例如換一個網路環境測試看歷史日期是否也一樣被擋）。
"""

import csv
import io
import os
import sys
import json
from collections import defaultdict
from datetime import date, timedelta

import requests

FINMIND_URL = "https://api.finmindtrade.com/api/v4/data"
TWSE_DAILY_ALL = "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL?response=open_data"
TWSE_INSTITUTIONAL = "https://www.twse.com.tw/rwd/zh/fund/T86"
TPEX_DAILY_ALL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
TPEX_INSTITUTIONAL = "https://www.tpex.org.tw/openapi/v1/tpex_3insti_daily_trading"

HEADERS = {"User-Agent": "Mozilla/5.0"}


def get_token():
    token = os.environ.get("FINMIND_TOKEN")
    if not token:
        raise SystemExit("缺少 FINMIND_TOKEN 環境變數，請先 export 或用 FINMIND_TOKEN=xxx 執行。")
    return token


def to_num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    if s in ("", "--", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def fetch_twse_quotes():
    """{code: {close, turnover}}，全部上市個股"""
    r = requests.get(TWSE_DAILY_ALL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    reader = csv.DictReader(io.StringIO(r.text))
    out = {}
    for row in reader:
        code = row.get("證券代號")
        if not code:
            continue
        out[code] = {
            "close": to_num(row.get("收盤價")),
            "turnover": to_num(row.get("成交金額")),
        }
    return out


def fetch_twse_institutional(target_date):
    """{code: net_shares}，全部上市個股，三大法人合計買賣超股數"""
    params = {"date": target_date, "selectType": "ALL", "response": "json"}
    r = requests.get(TWSE_INSTITUTIONAL, headers=HEADERS, params=params, timeout=30)
    r.raise_for_status()
    body = r.json()
    if body.get("stat") != "OK":
        return {}
    fields = body["fields"]
    idx_code = fields.index("證券代號")
    idx_total = fields.index("三大法人買賣超股數")
    out = {}
    for row in body.get("data", []):
        code = row[idx_code].strip()
        out[code] = to_num(row[idx_total])
    return out


def fetch_tpex_quotes():
    """{code: {close, turnover}}，全部上櫃個股"""
    r = requests.get(TPEX_DAILY_ALL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    out = {}
    for row in r.json():
        code = row.get("SecuritiesCompanyCode")
        if not code:
            continue
        out[code] = {
            "close": to_num(row.get("Close")),
            "turnover": to_num(row.get("TransactionAmount")),
        }
    return out


def fetch_tpex_institutional():
    """{code: net_shares}，全部上櫃個股"""
    r = requests.get(TPEX_INSTITUTIONAL, headers=HEADERS, timeout=30)
    r.raise_for_status()
    out = {}
    for row in r.json():
        code = row.get("SecuritiesCompanyCode")
        if not code:
            continue
        out[code] = to_num(row.get("TotalDifference"))
    return out


def fetch_industry_map(token):
    """{code: industry_category}，取每檔股票最新一筆分類（同代碼可能有多筆歷史紀錄）"""
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "Mozilla/5.0"}
    r = requests.get(FINMIND_URL, headers=headers, params={"dataset": "TaiwanStockInfo"}, timeout=30)
    r.raise_for_status()
    body = r.json()
    if body.get("status") != 200:
        raise SystemExit(f"FinMind 回傳錯誤（TaiwanStockInfo）：{body.get('msg')}")

    latest = {}
    for row in body.get("data", []):
        code = row["stock_id"]
        d = row.get("date", "")
        if code not in latest or d > latest[code][0]:
            latest[code] = (d, row.get("industry_category"))
    return {code: v[1] for code, v in latest.items()}


def main():
    target_date = sys.argv[1] if len(sys.argv) > 1 else date.today().strftime("%Y%m%d")
    top_stocks = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    top_industries = int(sys.argv[3]) if len(sys.argv) > 3 else 3

    token = get_token()

    print("正在抓取 TWSE 全市場行情...")
    twse_quotes = fetch_twse_quotes()
    print("正在抓取 TWSE 全市場三大法人買賣超...")
    twse_inst = fetch_twse_institutional(target_date)
    print("正在抓取 TPEx 全市場行情...")
    tpex_quotes = fetch_tpex_quotes()
    print("正在抓取 TPEx 全市場三大法人買賣超...")
    tpex_inst = fetch_tpex_institutional()
    print("正在抓取 FinMind 產業別對照表...")
    industry_map = fetch_industry_map(token)

    all_quotes = {**twse_quotes, **{k: v for k, v in tpex_quotes.items() if k not in twse_quotes}}
    all_inst = {**twse_inst, **{k: v for k, v in tpex_inst.items() if k not in twse_inst}}

    records = []
    for code, q in all_quotes.items():
        turnover = q.get("turnover")
        close = q.get("close")
        if turnover is None or close is None:
            continue
        records.append({"code": code, "close": close, "turnover": turnover})

    if not records:
        raise SystemExit(
            f"抓不到任何行情資料。若查詢的是今天（{target_date}），"
            "台股當天資料通常要收盤後才會更新，請改查前一個交易日。"
        )

    records.sort(key=lambda r: r["turnover"], reverse=True)
    top = records[:top_stocks]

    industry_total = defaultdict(float)
    industry_stock_count = defaultdict(int)
    stock_detail = []
    unmapped_industry = 0
    missing_institutional = 0

    for r in top:
        code = r["code"]
        net_shares = all_inst.get(code)
        industry = industry_map.get(code)

        if net_shares is None:
            missing_institutional += 1
            continue
        if industry is None:
            unmapped_industry += 1
            industry = "（未分類）"

        net_value = net_shares * r["close"]
        industry_total[industry] += net_value
        industry_stock_count[industry] += 1
        stock_detail.append({
            "code": code, "industry": industry, "close": r["close"],
            "turnover": r["turnover"], "net_shares": net_shares, "net_value": net_value,
        })

    ranked = sorted(industry_total.items(), key=lambda kv: kv[1], reverse=True)

    print(f"\n=== {target_date} 成交值前 {len(top)} 大活躍股，三大法人買賣超金額 by 產業"
          f"（{len(ranked)} 個產業，{len(stock_detail)} 檔納入計算）===\n")
    for i, (industry, value) in enumerate(ranked[:top_industries], 1):
        sign = "流入" if value >= 0 else "流出"
        print(f"{i}. {industry}：淨{sign} {abs(value):,.0f} 元（{industry_stock_count[industry]} 檔納入）")

    if missing_institutional:
        print(f"\n⚠️  {missing_institutional} 檔在前 {top_stocks} 大活躍股中查無三大法人資料（可能是興櫃/當日未公布）")
    if unmapped_industry:
        print(f"⚠️  {unmapped_industry} 檔查無產業別分類，歸入「（未分類）」")

    print(f"\n（完整 {len(ranked)} 個產業排名與逐股明細已存至 industry_fundflow_raw.json）")

    out = {
        "params": {"date": target_date, "top_stocks": top_stocks, "universe_size_scanned": len(all_quotes)},
        "industry_ranking": [{"industry": i, "net_value": v, "stock_count": industry_stock_count[i]} for i, v in ranked],
        "stock_detail": stock_detail,
        "caveats": [
            "範圍為成交值前 N 大活躍股，非嚴格全市場",
            "買賣超金額為概估（收盤價 x 三大法人合計買賣超股數），非逐筆成交精算金額",
            "台股當日資料需收盤後（約15:00~15:30後）才會公布",
        ],
    }
    with open("industry_fundflow_raw.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
