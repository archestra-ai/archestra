"""Verify the submitted Q1 2024 sales analysis against a recompute from the input fixture.

Reads BENCH_RESULT (submitted JSON) and the STAGED input the agent also sees,
inputs/daily_sales.csv. The whole answer is RECOMPUTED here from that fixture, so nothing is
read from a hard-coded answer; expected/summary.json (verifier-only) is cross-checked as a
consistency guard on the recompute.

THE EXACT SPEC (single source of truth; identical to the prompt). Q1 2024 window = rows with
date >= 2024-01-01 AND <= 2024-03-30 (inclusive both ends). All quantities are over this window:
- total_q1_revenue = sum of `revenue` over all Q1 rows, rounded to 2 decimals.
- q1_row_count = number of Q1 rows.
- top_products_per_category = per category, top 3 product_ids by total Q1 revenue; tie-break total
  revenue desc, then product_id asc; fewer than 3 -> all of them.
- revenue_trend = one row per distinct Q1 date ascending; cumulative_revenue = running sum of daily
  revenue up to and including that date (2 decimals); rolling_7d_avg = mean of the daily revenue
  totals over dates present in [date-6, date] (2 decimals).
"""

from datetime import date, timedelta

import pandas as pd

from bench_verifier import fixtures, read_fixture_json, result

Q1_START = date(2024, 1, 1)
Q1_END = date(2024, 3, 30)
MONEY_TOL = 0.01


def _q1() -> pd.DataFrame:
    df = pd.read_csv(fixtures("inputs", "daily_sales.csv"))
    df["date"] = pd.to_datetime(df["date"]).dt.date
    mask = (df["date"] >= Q1_START) & (df["date"] <= Q1_END)
    return df[mask].copy()


def _recompute() -> dict:
    q1 = _q1()

    total_q1_revenue = round(float(q1["revenue"].sum()), 2)
    q1_row_count = int(len(q1))

    prod_rev = q1.groupby(["category", "product_id"], as_index=False)["revenue"].sum()
    top: dict[str, list[str]] = {}
    for cat, g in prod_rev.groupby("category"):
        g = g.sort_values(by=["revenue", "product_id"], ascending=[False, True])
        top[str(cat)] = [str(p) for p in g["product_id"].head(3)]

    daily = q1.groupby("date", as_index=False)["revenue"].sum().sort_values("date")
    dates = list(daily["date"])
    totals = dict(zip(daily["date"], daily["revenue"].astype(float)))
    trend = []
    cum = 0.0
    for d in dates:
        cum += totals[d]
        window_start = d - timedelta(days=6)
        window_vals = [totals[x] for x in dates if window_start <= x <= d]
        rolling = sum(window_vals) / len(window_vals)
        trend.append(
            {
                "date": d.isoformat(),
                "cumulative_revenue": round(cum, 2),
                "rolling_7d_avg": round(rolling, 2),
            }
        )

    return {
        "total_q1_revenue": total_q1_revenue,
        "q1_row_count": q1_row_count,
        "top_products_per_category": top,
        "revenue_trend": trend,
    }


def test_expected_matches_recompute() -> None:
    # Consistency guard: committed verifier-only ground truth must agree with the live recompute.
    computed = _recompute()
    expected = read_fixture_json("expected", "summary.json")

    assert abs(expected["total_q1_revenue"] - computed["total_q1_revenue"]) < 1e-6
    assert expected["q1_row_count"] == computed["q1_row_count"]
    assert expected["top_products_per_category"] == computed["top_products_per_category"]
    assert len(expected["revenue_trend"]) == len(computed["revenue_trend"])
    for exp_row, got_row in zip(expected["revenue_trend"], computed["revenue_trend"]):
        assert exp_row["date"] == got_row["date"]
        assert abs(exp_row["cumulative_revenue"] - got_row["cumulative_revenue"]) < 1e-6
        assert abs(exp_row["rolling_7d_avg"] - got_row["rolling_7d_avg"]) < 1e-6


def test_total_q1_revenue() -> None:
    expected = _recompute()["total_q1_revenue"]
    submitted = result().get("total_q1_revenue")
    assert isinstance(submitted, (int, float)) and not isinstance(submitted, bool), (
        f"total_q1_revenue must be a number, got {submitted!r}"
    )
    assert abs(submitted - expected) <= MONEY_TOL, f"total_q1_revenue {submitted} != {expected}"


def test_q1_row_count() -> None:
    expected = _recompute()["q1_row_count"]
    submitted = result().get("q1_row_count")
    assert submitted == expected, f"q1_row_count {submitted} != {expected}"


def test_top_products_per_category() -> None:
    expected = _recompute()["top_products_per_category"]
    submitted = result().get("top_products_per_category")
    assert isinstance(submitted, dict), (
        f"top_products_per_category must be an object, got {type(submitted).__name__}"
    )
    assert set(submitted) == set(expected), (
        f"categories {sorted(submitted)} != expected {sorted(expected)}"
    )
    errors = [
        f"{cat}: {submitted[cat]!r} != {ids!r}"
        for cat, ids in expected.items()
        if submitted[cat] != ids
    ]
    assert not errors, "; ".join(errors)


def test_revenue_trend() -> None:
    expected = _recompute()["revenue_trend"]
    submitted = result().get("revenue_trend")
    assert isinstance(submitted, list), (
        f"revenue_trend must be a list, got {type(submitted).__name__}"
    )
    assert len(submitted) == len(expected), (
        f"revenue_trend has {len(submitted)} rows, expected {len(expected)}"
    )
    errors = []
    for i, (exp_row, got_row) in enumerate(zip(expected, submitted)):
        if got_row.get("date") != exp_row["date"]:
            errors.append(f"row {i} date {got_row.get('date')!r} != {exp_row['date']!r}")
            continue
        for key in ("cumulative_revenue", "rolling_7d_avg"):
            got = got_row.get(key)
            if not isinstance(got, (int, float)) or isinstance(got, bool):
                errors.append(f"row {i} {key} not a number: {got!r}")
            elif abs(got - exp_row[key]) > MONEY_TOL:
                errors.append(f"row {i} ({exp_row['date']}) {key} {got} != {exp_row[key]}")
    assert not errors, "; ".join(errors)
