#!/usr/bin/env python3
# 薄包裝：借用 mercury_cache_panel 的 build_panel_data()，只吐「清掉能省多少」的數字成 JSON。
# Cosmos Tree CLI 的 token 橫欄用這個，不需要整張 HTML 面板。
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mercury_cache_panel import build_panel_data, PRICING  # noqa: E402


def main():
    try:
        data = build_panel_data()
    except Exception as e:  # 讀不到 log 也不要讓 CLI 崩，回零
        print(json.dumps({"ok": False, "error": str(e)}))
        return

    by_vendor = data.get("by_vendor", {})
    total_saved = sum(v["cost"]["saved_usd"] for v in by_vendor.values())
    total_actual = sum(v["cost"]["actual_usd"] for v in by_vendor.values())
    total_wasted_usd = sum(v["waste_usd"] for v in by_vendor.values())

    # 浪費的 token 數（寫進 cache 卻在 TTL 內沒被讀回）。對齊面板 render 的估法。
    cw_price = PRICING.get("claude", {}).get("cache_write_1h", 6.00)
    wasted_tokens = int(total_wasted_usd / cw_price * 1e6) if cw_price else 0

    out = {
        "ok": True,
        "generated_at": data.get("generated_at"),
        "n_sessions": data.get("n_sessions", 0),
        "n_active": data.get("n_active", 0),
        "wasted_tokens": wasted_tokens,
        "wasted_usd": round(total_wasted_usd, 4),
        "clear_now_savings_usd": round(data.get("clear_now_savings", 0), 4),
        "saved_usd": round(total_saved, 2),
        "actual_usd": round(total_actual, 2),
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
