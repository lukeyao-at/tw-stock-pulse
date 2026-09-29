#!/usr/bin/env python3
"""
fetch_finmind.py
從 FinMind API 抓取台灣股票（上市/上櫃皆可）多季財報數據，含現金流量表
用法：FINMIND_TOKEN=xxx python fetch_finmind.py <股票代碼> [起始日期 YYYY-MM-DD]
範例：FINMIND_TOKEN=xxx python fetch_finmind.py 2317 2023-01-01

資料來源（https://finmind.github.io/）：
- 綜合損益表: dataset=TaiwanStockFinancialStatements
- 資產負債表: dataset=TaiwanStockBalanceSheet
- 現金流量表: dataset=TaiwanStockCashFlowsStatement

需要 FINMIND_TOKEN（免費註冊取得，https://finmindtrade.com/ ）：
匿名請求額度很低，容易被同網段其他使用者用完；帶 token 可提升到 600 次/小時。
**不要把 token 寫死在程式碼或 commit 進 repo，一律用環境變數帶入。**
"""

import json
import os
import sys
import time
from datetime import date, timedelta

import requests

API_URL = "https://api.finmindtrade.com/api/v4/data"

DATASETS = {
    "income_statement": "TaiwanStockFinancialStatements",
    "balance_sheet": "TaiwanStockBalanceSheet",
    "cash_flow": "TaiwanStockCashFlowsStatement",
}


def get_token():
    token = os.environ.get("FINMIND_TOKEN")
    if not token:
        raise SystemExit(
            "缺少 FINMIND_TOKEN 環境變數。請至 https://finmindtrade.com/ 免費註冊取得 token，"
            "再用 `FINMIND_TOKEN=xxx python fetch_finmind.py <股票代碼>` 執行。"
        )
    return token


def fetch_dataset(dataset, stock_id, start_date, token):
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "Mozilla/5.0"}
    params = {"dataset": dataset, "data_id": stock_id, "start_date": start_date}
    r = requests.get(API_URL, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    body = r.json()
    if body.get("status") != 200:
        raise SystemExit(f"FinMind 回傳錯誤（{dataset}）：{body.get('msg')}")
    return body.get("data", [])


def pivot_by_date(rows):
    """{date: {type: value}}，忽略 `_per`（佔比）欄位"""
    out = {}
    for r in rows:
        if r["type"].endswith("_per"):
            continue
        out.setdefault(r["date"], {})[r["type"]] = r["value"]
    return out


def safe_div(a, b):
    if a is None or b in (None, 0):
        return None
    return a / b * 100


def sanity_check(m, label):
    warnings = []
    gm = m.get("gross_margin")
    if gm is not None:
        if gm > 100:
            warnings.append({"level": "error", "field": f"{label} 毛利率",
                "msg": f"{gm:.1f}% 超過 100%，數據可能有誤"})
        elif gm < -50:
            warnings.append({"level": "error", "field": f"{label} 毛利率",
                "msg": f"{gm:.1f}% 低於 -50%，請確認是否為特殊損失季度"})

    cr = m.get("current_ratio")
    if cr is not None and cr < 0:
        warnings.append({"level": "error", "field": f"{label} 流動比率",
            "msg": f"{cr:.1f}% 為負值，請檢查資產負債表數據"})

    dr = m.get("debt_ratio")
    if dr is not None and dr > 100:
        warnings.append({"level": "warn", "field": f"{label} 負債比率",
            "msg": f"{dr:.1f}% 超過 100%，若非金融業則為警示訊號"})

    roe = m.get("roe")
    if roe is not None and roe > 100:
        warnings.append({"level": "warn", "field": f"{label} ROE",
            "msg": f"{roe:.1f}% 超過 100%，可能為高槓桿，請確認股東權益是否偏低"})

    return warnings


def build_metadata(stock_id, start_date, quarters):
    return {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "source": "FinMind (https://finmindtrade.com/)",
        "source_urls": {
            k: f"{API_URL}?dataset={v}&data_id={stock_id}&start_date={start_date}"
            for k, v in DATASETS.items()
        },
        "mops_url": f"https://mops.twse.com.tw/mops/web/t05st01?step=1&co_id={stock_id}&TYPEK=sii",
        "mops_url_otc": f"https://mops.twse.com.tw/mops/web/t05st01?step=1&co_id={stock_id}&TYPEK=otc",
        "quarters_covered": quarters,
        "currency": "TWD 元",
    }


def fetch_all(stock_id, start_date):
    token = get_token()
    stock_id = str(stock_id)

    print("正在抓取 FinMind 綜合損益表...")
    is_rows = fetch_dataset(DATASETS["income_statement"], stock_id, start_date, token)
    is_by_date = pivot_by_date(is_rows)

    print("正在抓取 FinMind 資產負債表...")
    bs_rows = fetch_dataset(DATASETS["balance_sheet"], stock_id, start_date, token)
    bs_by_date = pivot_by_date(bs_rows)

    print("正在抓取 FinMind 現金流量表...")
    cf_rows = fetch_dataset(DATASETS["cash_flow"], stock_id, start_date, token)
    cf_by_date = pivot_by_date(cf_rows)

    if not is_by_date or not bs_by_date:
        raise SystemExit(
            f"找不到股票代碼 {stock_id} 的資料，請確認代碼正確且 FinMind 有涵蓋此公司。"
        )

    quarters = sorted(set(is_by_date) & set(bs_by_date))
    if not quarters:
        raise SystemExit("損益表與資產負債表的季度日期對不上，請檢查 start_date 範圍。")

    all_warnings = []
    quarterly = []

    for q in quarters:
        inc = is_by_date.get(q, {})
        bs = bs_by_date.get(q, {})
        cf = cf_by_date.get(q, {})

        revenue = inc.get("Revenue")
        gross_profit = inc.get("GrossProfit")
        operating_income = inc.get("OperatingIncome")
        net_income = inc.get("IncomeAfterTaxes")
        eps = inc.get("EPS")

        current_assets = bs.get("CurrentAssets")
        current_liabilities = bs.get("CurrentLiabilities")
        total_assets = bs.get("TotalAssets")
        total_liabilities = bs.get("Liabilities")
        total_equity = bs.get("Equity")

        operating_cf = cf.get("CashFlowsFromOperatingActivities")
        investing_cf = cf.get("CashProvidedByInvestingActivities")
        financing_cf = cf.get("CashFlowsProvidedFromFinancingActivities")
        capex = cf.get("PropertyAndPlantAndEquipment")
        cash_end = cf.get("CashBalancesEndOfPeriod")
        fcf = (operating_cf + capex) if (operating_cf is not None and capex is not None) else None

        metrics = {
            "revenue": revenue,
            "gross_profit": gross_profit,
            "operating_income": operating_income,
            "net_income": net_income,
            "eps": eps,
            "gross_margin": safe_div(gross_profit, revenue),
            "operating_margin": safe_div(operating_income, revenue),
            "net_margin": safe_div(net_income, revenue),
            "current_ratio": safe_div(current_assets, current_liabilities),
            "debt_ratio": safe_div(total_liabilities, total_assets),
            "roe": safe_div(net_income, total_equity),
            "roa": safe_div(net_income, total_assets),
            "operating_cf": operating_cf,
            "investing_cf": investing_cf,
            "financing_cf": financing_cf,
            "capex": capex,
            "fcf": fcf,
            "cash_end": cash_end,
        }

        warnings = sanity_check(metrics, q)
        all_warnings.extend(warnings)

        quarterly.append({"date": q, "metrics": metrics})

    sanity_pass = all(w["level"] != "error" for w in all_warnings)

    return {
        "stock_id": stock_id,
        "quarters": quarterly,
        "metadata": build_metadata(stock_id, start_date, quarters),
        "verification": {"sanity": all_warnings, "sanity_pass": sanity_pass},
    }


def _fmt(v, suffix=""):
    return f"{v:,.2f}{suffix}" if v is not None else "N/A"


if __name__ == "__main__":
    stock_id = sys.argv[1] if len(sys.argv) > 1 else "2330"
    start_date = sys.argv[2] if len(sys.argv) > 2 else (date.today() - timedelta(days=3 * 365)).isoformat()

    data = fetch_all(stock_id, start_date)

    print(f"\n=== {stock_id} 財報摘要（{len(data['quarters'])} 季，"
          f"{data['quarters'][0]['date']} ~ {data['quarters'][-1]['date']}）===")
    for q in data["quarters"]:
        m = q["metrics"]
        print(f"\n[{q['date']}]")
        print(f"  營收：{_fmt(m['revenue'])}  EPS：{_fmt(m['eps'])}")
        print(f"  毛利率：{_fmt(m['gross_margin'], '%')}  營業利益率：{_fmt(m['operating_margin'], '%')}  "
              f"淨利率：{_fmt(m['net_margin'], '%')}")
        print(f"  流動比率：{_fmt(m['current_ratio'], '%')}  負債比率：{_fmt(m['debt_ratio'], '%')}  "
              f"ROE：{_fmt(m['roe'], '%')}  ROA：{_fmt(m['roa'], '%')}")
        print(f"  營業CF：{_fmt(m['operating_cf'])}  投資CF：{_fmt(m['investing_cf'])}  "
              f"籌資CF：{_fmt(m['financing_cf'])}  FCF：{_fmt(m['fcf'])}")

    if data["verification"]["sanity"]:
        print(f"\n⚠️  合理性檢查發現 {len(data['verification']['sanity'])} 項警示：")
        for w in data["verification"]["sanity"]:
            icon = "❌" if w["level"] == "error" else "⚠️ "
            print(f"  {icon} [{w['field']}] {w['msg']}")
    else:
        print("\n✅ 合理性檢查通過，所有指標在合理範圍內")

    print(f"\n📋 MOPS 官方申報：{data['metadata']['mops_url']}")

    out_file = f"{stock_id}_raw_data.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n資料（含驗證結果）已存至 {out_file}")
