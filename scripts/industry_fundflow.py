#!/usr/bin/env python3
"""
industry_fundflow.py
試算「近 N 個交易日，三大法人（外資/投信/自營商）淨買超金額」依產業別加總，
找出金額淨流入最多的前幾個產業。

用法：
  FINMIND_TOKEN=xxx python scripts/industry_fundflow.py [天數] [top N]
  範例：FINMIND_TOKEN=xxx python scripts/industry_fundflow.py 5 3

股票範圍：讀取 data/sample-universe.json 裡的股票代碼與產業別（目前 50 檔、18 個產業）。
這個清單的股價/財務欄位是模擬值，但股票代碼與產業別是真實的，這裡只用到代碼和產業別。

資料來源（FinMind，需要 FINMIND_TOKEN，免費註冊：https://finmindtrade.com/）：
- TaiwanStockInstitutionalInvestorsBuySell：三大法人每日買賣「股數」
- TaiwanStockPrice：每日收盤價，用來把股數換算成金額

限制（先說在前面，避免誤讀結果）：
- 免費/註冊層級的 FinMind 不能一次查全市場，只能逐檔查，所以範圍限縮在
  sample-universe.json 的 50 檔，不是台股全市場的資金流向
- 買賣超金額 = (外資+投信+自營商+自營商避險 買進股數 - 賣出股數之合計) × 當日收盤價，
  是概估金額，跟正式的「買賣超金額統計表」可能有些微差異（例如零股、盤後交易未必完全對齊）
- 這是「這 50 檔 × 這 N 天」的資金流向，不是全市場、也不是長期趨勢
"""

import os
import sys
import json
import time
from collections import defaultdict
from datetime import date, timedelta

import requests

API_URL = "https://api.finmindtrade.com/api/v4/data"
UNIVERSE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "sample-universe.json",
)


def get_token():
    token = os.environ.get("FINMIND_TOKEN")
    if not token:
        raise SystemExit("缺少 FINMIND_TOKEN 環境變數，請先 export 或用 FINMIND_TOKEN=xxx 執行。")
    return token


def load_universe():
    with open(UNIVERSE_PATH, encoding="utf-8") as f:
        d = json.load(f)
    return [(s["code"], s["industry"]) for s in d["stocks"]]


def fetch_dataset(dataset, stock_id, start_date, end_date, token):
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "Mozilla/5.0"}
    params = {"dataset": dataset, "data_id": stock_id, "start_date": start_date, "end_date": end_date}
    r = requests.get(API_URL, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    body = r.json()
    if body.get("status") != 200:
        raise SystemExit(f"FinMind 回傳錯誤（{dataset}, {stock_id}）：{body.get('msg')}")
    return body.get("data", [])


def net_shares_by_date(inst_rows):
    """三大法人（含自營商避險）每日淨買超股數：{date: net_shares}"""
    out = defaultdict(float)
    for r in inst_rows:
        out[r["date"]] += r["buy"] - r["sell"]
    return out


def close_by_date(price_rows):
    return {r["date"]: r["close"] for r in price_rows}


def stock_net_inflow(stock_id, start_date, end_date, token):
    inst_rows = fetch_dataset("TaiwanStockInstitutionalInvestorsBuySell", stock_id, start_date, end_date, token)
    price_rows = fetch_dataset("TaiwanStockPrice", stock_id, start_date, end_date, token)

    net_shares = net_shares_by_date(inst_rows)
    close = close_by_date(price_rows)

    total_value = 0.0
    days_used = 0
    for d, shares in net_shares.items():
        px = close.get(d)
        if px is None:
            continue
        total_value += shares * px
        days_used += 1
    return total_value, days_used


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    top_n = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    token = get_token()
    universe = load_universe()

    end_date = date.today().isoformat()
    start_date = (date.today() - timedelta(days=days * 2)).isoformat()  # 抓寬一點，排除假日

    industry_total = defaultdict(float)
    stock_results = []

    for code, industry in universe:
        try:
            value, days_used = stock_net_inflow(code, start_date, end_date, token)
        except SystemExit as e:
            print(f"⚠️  {code}（{industry}）抓取失敗：{e}", file=sys.stderr)
            continue
        industry_total[industry] += value
        stock_results.append({"code": code, "industry": industry, "net_inflow": value, "days_used": days_used})
        time.sleep(0.05)  # 禮貌性節流，避免瞬間打爆 rate limit

    ranked = sorted(industry_total.items(), key=lambda kv: kv[1], reverse=True)

    print(f"\n=== 近 {days} 個交易日（範圍 {start_date} ~ {end_date}）"
          f"三大法人淨買超金額 by 產業（{len(universe)} 檔股票，{len(industry_total)} 個產業）===\n")
    for i, (industry, value) in enumerate(ranked[:top_n], 1):
        print(f"{i}. {industry}：{value:,.0f} 元")

    print(f"\n（完整 {len(ranked)} 個產業排名與逐股明細已存至 industry_fundflow_raw.json）")

    out = {
        "params": {"days": days, "start_date": start_date, "end_date": end_date, "universe_size": len(universe)},
        "industry_ranking": [{"industry": i, "net_inflow": v} for i, v in ranked],
        "stock_detail": stock_results,
        "caveats": [
            "股票範圍僅 data/sample-universe.json 的 50 檔，非全市場",
            "金額為概估（股數 x 收盤價加總），非官方買賣超金額統計表",
            "免費 FinMind 額度限制，故逐股查詢而非全市場一次查詢",
        ],
    }
    with open("industry_fundflow_raw.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
