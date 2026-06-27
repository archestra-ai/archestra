"""Verify the comparable-companies summary statistics + CAPM cost of equity against a recompute.

Reads BENCH_RESULT (submitted JSON) and the two STAGED fixtures the agent also sees:
inputs/competitor_metrics.csv (five public peers, multiples precomputed) and inputs/target_financials.csv
(CloudPeak's own financials, one metric per row across fiscal years). The full answer is RECOMPUTED
here from those fixtures -- the six-company peer set, CloudPeak's derived EV and multiples, the
five-number summaries per metric (numpy linear-interpolation percentiles), and the CAPM cost of equity
-- so nothing is read from a hard-coded answer. expected/stats.json (verifier-only) is cross-checked as
a consistency guard on the recompute.

THE EXACT RUBRIC (single source of truth; identical to the prompt):
- Peer set = the five rows of competitor_metrics.csv PLUS CloudPeak (target_financials.csv, FY2024A).
- For peers, metrics come straight from the row (ev_revenue, ev_ebitda, revenue_growth_yoy_pct,
  gross_margin_pct, ebitda_margin_pct).
- CloudPeak EV = current_stock_price * shares_diluted_m - (cash_and_equivalents - total_debt), all FY2024A.
  ev_revenue = EV / revenue; ev_ebitda = EV / ebitda_adj; the three margin/growth metrics from the row.
- Per metric (ev_revenue, ev_ebitda, revenue_growth_pct, gross_margin_pct, ebitda_margin_pct), report
  max / p75 / median / p25 / min via numpy.percentile (linear interpolation) over the six values.
- cost_of_equity_pct = risk_free_rate_10yr_treasury + beta_5yr_monthly * equity_risk_premium.
"""

import csv

import numpy as np

from bench_verifier import fixtures, read_fixture_json, result

METRICS = ["ev_revenue", "ev_ebitda", "revenue_growth_pct", "gross_margin_pct", "ebitda_margin_pct"]
STATS = ["max", "p75", "median", "p25", "min"]
PCT = {"max": 100, "p75": 75, "median": 50, "p25": 25, "min": 0}


def _peers() -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    with fixtures("inputs", "competitor_metrics.csv").open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            out[row["company"]] = {
                "ev_revenue": float(row["ev_revenue"]),
                "ev_ebitda": float(row["ev_ebitda"]),
                "revenue_growth_pct": float(row["revenue_growth_yoy_pct"]),
                "gross_margin_pct": float(row["gross_margin_pct"]),
                "ebitda_margin_pct": float(row["ebitda_margin_pct"]),
            }
    return out


def _target() -> dict[str, list[str]]:
    with fixtures("inputs", "target_financials.csv").open(encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    header = rows[0]
    fy24 = header.index("FY2024A")
    table = {r[0]: r for r in rows[1:]}
    return {"_fy24": [str(fy24)], **table}


def _recompute() -> dict:
    companies = _peers()
    t = _target()
    fy24 = int(t["_fy24"][0])

    def cell(metric: str, col: int) -> float:
        return float(t[metric][col])

    price = cell("current_stock_price", 1)
    shares = cell("shares_diluted_m", fy24)
    cash = cell("cash_and_equivalents", fy24)
    debt = cell("total_debt", fy24)
    revenue = cell("revenue", fy24)
    ebitda = cell("ebitda_adj", fy24)
    ev = price * shares - (cash - debt)
    companies["CloudPeak Technologies"] = {
        "ev_revenue": ev / revenue,
        "ev_ebitda": ev / ebitda,
        "revenue_growth_pct": cell("revenue_growth_yoy_pct", fy24),
        "gross_margin_pct": cell("gross_margin_pct", fy24),
        "ebitda_margin_pct": cell("ebitda_margin_pct", fy24),
    }
    assert len(companies) == 6, f"expected 6 companies, got {len(companies)}: {sorted(companies)}"

    comps: dict[str, dict[str, float]] = {}
    for metric in METRICS:
        values = np.array([companies[c][metric] for c in companies], dtype=float)
        comps[metric] = {stat: float(np.percentile(values, PCT[stat])) for stat in STATS}

    coe = cell("risk_free_rate_10yr_treasury", 1) + cell("beta_5yr_monthly", 1) * cell("equity_risk_premium", 1)
    return {"comps": comps, "cost_of_equity_pct": coe}


def _tol(expected: float) -> float:
    # Tight absolute floor (answers are reported to >=2 decimals, so rounding error <= 0.005), plus a
    # 0.5% relative band that only matters for the large EV/EBITDA multiples. A wrong EV method (e.g.
    # omitting net cash) shifts the affected stats by >0.2, well outside this.
    return max(0.02, abs(expected) * 0.005)


def test_recompute_matches_expected() -> None:
    # Consistency guard: committed verifier-only ground truth must agree with the live recompute.
    expected = read_fixture_json("expected", "stats.json")
    computed = _recompute()
    for metric in METRICS:
        for stat in STATS:
            e = expected["comps"][metric][stat]
            c = computed["comps"][metric][stat]
            assert abs(e - c) < 1e-6, f"expected/stats.json drift at {metric}.{stat}: {e} vs recompute {c}"
    assert abs(expected["cost_of_equity_pct"] - computed["cost_of_equity_pct"]) < 1e-6


def test_cost_of_equity() -> None:
    computed = _recompute()
    submitted = result().get("cost_of_equity_pct")
    assert isinstance(submitted, (int, float)) and not isinstance(submitted, bool), (
        f"cost_of_equity_pct must be a number, got {submitted!r}"
    )
    expected = computed["cost_of_equity_pct"]
    assert abs(submitted - expected) <= _tol(expected), f"cost_of_equity_pct {submitted} != {expected:.4f}"


def test_comps_stats() -> None:
    computed = _recompute()
    comps = result().get("comps")
    assert isinstance(comps, dict), f"comps must be an object, got {type(comps).__name__}"

    errors: list[str] = []
    for metric in METRICS:
        block = comps.get(metric)
        if not isinstance(block, dict):
            errors.append(f"{metric}: missing or not an object")
            continue
        for stat in STATS:
            got = block.get(stat)
            exp = computed["comps"][metric][stat]
            if not isinstance(got, (int, float)) or isinstance(got, bool):
                errors.append(f"{metric}.{stat}: not a number ({got!r})")
            elif abs(got - exp) > _tol(exp):
                errors.append(f"{metric}.{stat}: {got} != {exp:.4f}")
    assert not errors, "; ".join(errors)
