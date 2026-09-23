#!/usr/bin/env python3
"""
fetch_twse.py
從 TWSE OpenAPI 官方資料抓取台灣上市公司（一般業）最新一季財報快照
用法：python fetch_twse.py <股票代碼>
範例：python fetch_twse.py 2330

資料來源：
- 綜合損益表: https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci
- 資產負債表: https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci

限制（官方 Open Data 本身的限制，非本腳本 bug）：
- 僅涵蓋「上市、一般業」公司，不含上櫃（TPEx）公司，不含金融保險/證券期貨業
  （這些行業的財報格式不同，欄位對不上）
- 每個資料集只回傳「最新一季」快照，官方未開放歷史多季批次下載，
  故本腳本無法產生多年趨勢圖
- 官方 Open API 未提供現金流量表資料集，故不含現金流量／FCF 指標
"""

import json
import sys
import time

import requests

IS_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci"
BS_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap07_L_ci"

HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}


def fetch_json(url):
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()
    try:
        return r.json()
    except ValueError as e:
        raise SystemExit(
            f"抓取 {url} 失敗：伺服器回傳的不是 JSON（可能是防護頁面或暫時性錯誤）。\n"
            f"若在雲端沙盒環境執行，這個 host 可能被其 WAF 依 IP 擋下；"
            f"請改在本機或其他網路環境重試。原始錯誤：{e}"
        )


def find_company(records, stock_id):
    for rec in records:
        if rec.get("公司代號") == str(stock_id):
            return rec
    return None


def to_float(v):
    if v in (None, "", "-"):
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def safe_div(a, b):
    if a is None or b in (None, 0):
        return None
    return a / b * 100


def build_metadata(stock_id, is_rec, bs_rec):
    year = is_rec.get("年度") or bs_rec.get("年度")
    season = is_rec.get("季別") or bs_rec.get("季別")
    return {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S+08:00"),
        "source": "TWSE OpenAPI (openapi.twse.com.tw)",
        "source_urls": {
            "income_statement": IS_URL,
            "balance_sheet": BS_URL,
        },
        "mops_url": f"https://mops.twse.com.tw/mops/web/t05st01?step=1&co_id={stock_id}&TYPEK=sii",
        "year": year,
        "season": season,
        "currency": "TWD 仟元",
        "scope": "上市、一般業（不含金融保險/證券期貨業，不含上櫃公司）",
        "note": "TWSE OpenAPI 僅提供最新一季財報快照；官方未開放現金流量表資料集，本結果不含現金流量指標",
    }


def sanity_check(m):
    warnings = []

    gm = m.get("gross_margin")
    if gm is not None:
        if gm > 100:
            warnings.append({"level": "error", "field": "毛利率",
                "msg": f"{gm:.1f}% 超過 100%，數據可能有誤"})
        elif gm < -50:
            warnings.append({"level": "error", "field": "毛利率",
                "msg": f"{gm:.1f}% 低於 -50%，請確認是否為特殊損失季度"})

    cr = m.get("current_ratio")
    if cr is not None and cr < 0:
        warnings.append({"level": "error", "field": "流動比率",
            "msg": f"{cr:.1f}% 為負值，請檢查資產負債表數據"})

    dr = m.get("debt_ratio")
    if dr is not None and dr > 100:
        warnings.append({"level": "warn", "field": "負債比率",
            "msg": f"{dr:.1f}% 超過 100%，若非金融業則為警示訊號"})

    roe = m.get("roe")
    if roe is not None and roe > 100:
        warnings.append({"level": "warn", "field": "ROE",
            "msg": f"{roe:.1f}% 超過 100%，可能為高槓桿，請確認股東權益是否偏低"})

    return warnings


def fetch_all(stock_id):
    stock_id = str(stock_id)

    print("正在抓取 TWSE 綜合損益表...")
    is_records = fetch_json(IS_URL)
    is_rec = find_company(is_records, stock_id)

    print("正在抓取 TWSE 資產負債表...")
    bs_records = fetch_json(BS_URL)
    bs_rec = find_company(bs_records, stock_id)

    if is_rec is None or bs_rec is None:
        raise SystemExit(
            f"找不到股票代碼 {stock_id} 的資料。\n"
            "可能原因：(1) 非上市公司或屬上櫃(TPEx)公司 "
            "(2) 屬金融保險/證券期貨業，非「一般業」報表格式 "
            "(3) 本季財報尚未申報。"
        )

    revenue = to_float(is_rec.get("營業收入"))
    gross_profit = to_float(is_rec.get("營業毛利（毛損）淨額"))
    op_profit = to_float(is_rec.get("營業利益（損失）"))
    net_income = to_float(is_rec.get("本期淨利（淨損）"))
    eps = to_float(is_rec.get("基本每股盈餘（元）"))

    current_assets = to_float(bs_rec.get("流動資產"))
    current_liabilities = to_float(bs_rec.get("流動負債"))
    total_assets = to_float(bs_rec.get("資產總計"))
    total_liabilities = to_float(bs_rec.get("負債總計"))
    total_equity = to_float(bs_rec.get("權益總計"))

    metrics = {
        "revenue": revenue,
        "gross_profit": gross_profit,
        "operating_profit": op_profit,
        "net_income": net_income,
        "eps": eps,
        "gross_margin": safe_div(gross_profit, revenue),
        "operating_margin": safe_div(op_profit, revenue),
        "net_margin": safe_div(net_income, revenue),
        "current_ratio": safe_div(current_assets, current_liabilities),
        "debt_ratio": safe_div(total_liabilities, total_assets),
        "roe": safe_div(net_income, total_equity),
        "roa": safe_div(net_income, total_assets),
    }

    warnings = sanity_check(metrics)
    sanity_pass = all(w["level"] != "error" for w in warnings)

    return {
        "stock_id": stock_id,
        "company_name": is_rec.get("公司名稱"),
        "income_statement": is_rec,
        "balance_sheet": bs_rec,
        "metrics": metrics,
        "metadata": build_metadata(stock_id, is_rec, bs_rec),
        "verification": {"sanity": warnings, "sanity_pass": sanity_pass},
    }


def _fmt(v, suffix=""):
    return f"{v:,.2f}{suffix}" if v is not None else "N/A"


if __name__ == "__main__":
    stock_id = sys.argv[1] if len(sys.argv) > 1 else "2330"
    data = fetch_all(stock_id)
    m = data["metrics"]
    meta = data["metadata"]

    print(f"\n=== {stock_id} {data['company_name']} 財報摘要 "
          f"（{meta['year']} 年 Q{meta['season']}）===")
    print(f"  營收：{_fmt(m['revenue'])} 仟元")
    print(f"  EPS：{_fmt(m['eps'])}")
    print(f"  毛利率：{_fmt(m['gross_margin'], '%')}")
    print(f"  營業利益率：{_fmt(m['operating_margin'], '%')}")
    print(f"  淨利率：{_fmt(m['net_margin'], '%')}")
    print(f"  流動比率：{_fmt(m['current_ratio'], '%')}")
    print(f"  負債比率：{_fmt(m['debt_ratio'], '%')}")
    print(f"  ROE：{_fmt(m['roe'], '%')}")
    print(f"  ROA：{_fmt(m['roa'], '%')}")

    if data["verification"]["sanity"]:
        print(f"\n⚠️  合理性檢查發現 {len(data['verification']['sanity'])} 項警示：")
        for w in data["verification"]["sanity"]:
            icon = "❌" if w["level"] == "error" else "⚠️ "
            print(f"  {icon} [{w['field']}] {w['msg']}")
    else:
        print("\n✅ 合理性檢查通過，所有指標在合理範圍內")

    print(f"\n📋 MOPS 官方申報：{meta['mops_url']}")

    out_file = f"{stock_id}_raw_data.json"
    with open(out_file, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n資料（含驗證結果）已存至 {out_file}")
