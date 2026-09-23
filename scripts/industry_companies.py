#!/usr/bin/env python3
"""
industry_companies.py
從 industry_fundflow.py 產生的 industry_fundflow_raw.json 裡，
列出某個產業裡有哪些公司（來自成交值前 N 大活躍股，不是該產業全部成分股）。

用法：
  python scripts/industry_companies.py <產業名稱> [raw json 路徑]
  範例：python scripts/industry_companies.py 半導體業
       python scripts/industry_companies.py 半導體業 /path/to/industry_fundflow_raw.json

先跑過 industry_fundflow.py 產生 industry_fundflow_raw.json，才有資料可以查。
產業名稱要跟排名結果印出來的字串完全一致（例如「半導體業」「電子零組件業」）。
"""

import json
import sys


def main():
    if len(sys.argv) < 2:
        raise SystemExit("用法：python scripts/industry_companies.py <產業名稱> [raw json 路徑]")

    industry = sys.argv[1]
    raw_path = sys.argv[2] if len(sys.argv) > 2 else "industry_fundflow_raw.json"

    with open(raw_path, encoding="utf-8") as f:
        data = json.load(f)

    matched = [r for r in data["stock_detail"] if r["industry"] == industry]
    if not matched:
        available = sorted({r["industry"] for r in data["stock_detail"]})
        raise SystemExit(
            f"找不到產業「{industry}」。這份資料（成交值前 {data['params']['top_stocks']} 大活躍股）"
            f"裡有的產業：\n" + "、".join(available)
        )

    matched.sort(key=lambda r: r["net_value"], reverse=True)

    total_value = sum(r["net_value"] for r in matched)
    print(f"\n=== {industry}（{data['params']['date']}，成交值前 {data['params']['top_stocks']} 大活躍股裡的 "
          f"{len(matched)} 檔）===")
    print(f"合計三大法人買賣超金額：{total_value:,.0f} 元\n")

    print(f"{'代碼':<8}{'名稱':<10}{'收盤價':>10}{'成交金額(億)':>14}{'三大法人買賣超(億)':>18}")
    for r in matched:
        sign = "" if r["net_value"] >= 0 else "-"
        print(f"{r['code']:<8}{r['name']:<10}{r['close']:>10,.2f}"
              f"{r['turnover']/1e8:>14,.2f}{sign}{abs(r['net_value'])/1e8:>17,.2f}")

    print(f"\n這只是「成交值前 N 大活躍股」裡屬於這個產業的清單，不是該產業全部成分股。")
    print(f"想針對某檔做基本面/現金流分析，可以直接說「幫我分析 {matched[0]['code']}」觸發 taiwan-stock-analysis skill。")


if __name__ == "__main__":
    main()
