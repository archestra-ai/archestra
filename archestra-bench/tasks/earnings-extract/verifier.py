"""Verify the submitted earnings extraction against verifier-only ground truth.

Reads BENCH_RESULT (submitted JSON) and expected/ground_truth.json (verifier-only -- the figures
hand-extracted from the staged quarterly_earnings.pdf, NEVER staged to the agent). The verifier does
NOT re-read the PDF: it grades the submitted JSON against ground truth (so deps=[]; no pdf libs).

Checks, with assert messages naming the exact field:
- income_statement: each of the 9 figures within tolerance (0.05 for $M/margins, 0.005 for eps).
- segments: rev_2026/rev_2025 match ground truth within 0.05; yoy_growth_pct matches BOTH the
  ground-truth recompute AND the recompute from the SUBMITTED rev values (internal consistency)
  within 0.1.
- segment_total_2026 within 0.05 of the ground-truth total AND equals the sum of submitted segment
  rev_2026 within 0.05 (reconciliation identity).
- kpis: each of the 8 within tolerance (exact for counts, 0.05 for pct/usd).
"""

from bench_verifier import read_fixture_json, result

MONEY_TOL = 0.05
EPS_TOL = 0.005
YOY_TOL = 0.05
EPS_KEYS = {"eps_diluted"}
EXACT_KPIS = {
    "total_customers",
    "net_revenue_retention_pct",
    "arr_usd_m",
    "customer_acquisition_cost_usd",
    "avg_revenue_per_customer_usd",
    "employees",
}


def _num(value: object, label: str) -> float:
    assert isinstance(value, (int, float)) and not isinstance(value, bool), (
        f"{label} must be a number, got {value!r}"
    )
    return float(value)


def _yoy(rev_2026: float, rev_2025: float) -> float:
    return (rev_2026 - rev_2025) / rev_2025 * 100


def test_income_statement() -> None:
    expected = read_fixture_json("expected", "ground_truth.json")["income_statement"]
    submitted = result().get("income_statement")
    assert isinstance(submitted, dict), (
        f"income_statement must be an object, got {type(submitted).__name__}"
    )
    assert set(submitted) == set(expected), (
        f"income_statement keys {sorted(submitted)} != expected {sorted(expected)}"
    )
    for key, exp in expected.items():
        got = _num(submitted[key], f"income_statement.{key}")
        tol = EPS_TOL if key in EPS_KEYS else MONEY_TOL
        assert abs(got - exp) <= tol, f"income_statement.{key} {got} != {exp} (tol {tol})"


def test_segments() -> None:
    gt = read_fixture_json("expected", "ground_truth.json")
    expected = gt["segments"]
    submitted = result().get("segments")
    assert isinstance(submitted, list), f"segments must be a list, got {type(submitted).__name__}"
    assert len(submitted) == len(expected), (
        f"segments must have {len(expected)} entries, got {len(submitted)}"
    )

    expected_names = [s["name"] for s in expected]
    submitted_names = [str(s.get("name", "")).strip() for s in submitted]
    assert submitted_names == expected_names, (
        f"segment order/names {submitted_names} != expected {expected_names}"
    )

    for exp, got in zip(expected, submitted):
        name = exp["name"]
        rev_2026 = _num(got.get("rev_2026"), f"segments[{name}].rev_2026")
        rev_2025 = _num(got.get("rev_2025"), f"segments[{name}].rev_2025")
        yoy = _num(got.get("yoy_growth_pct"), f"segments[{name}].yoy_growth_pct")

        assert abs(rev_2026 - exp["rev_2026"]) <= MONEY_TOL, (
            f"segments[{name}].rev_2026 {rev_2026} != {exp['rev_2026']}"
        )
        assert abs(rev_2025 - exp["rev_2025"]) <= MONEY_TOL, (
            f"segments[{name}].rev_2025 {rev_2025} != {exp['rev_2025']}"
        )

        # Prompt pins yoy to 1 decimal, so compare against the 1-dp rounded recompute (not the raw
        # float) -- otherwise a truncated 18.5 and the correct 18.6 would both fall inside tolerance.
        gt_yoy = round(_yoy(exp["rev_2026"], exp["rev_2025"]), 1)
        assert abs(yoy - gt_yoy) <= YOY_TOL, (
            f"segments[{name}].yoy_growth_pct {yoy} != ground-truth {gt_yoy}"
        )
        self_yoy = round(_yoy(rev_2026, rev_2025), 1)
        assert abs(yoy - self_yoy) <= YOY_TOL, (
            f"segments[{name}].yoy_growth_pct {yoy} inconsistent with submitted revs "
            f"(recompute {self_yoy})"
        )


def test_segment_total_reconciles() -> None:
    gt = read_fixture_json("expected", "ground_truth.json")
    expected_total = gt["segment_total_2026"]
    submitted = result()

    total = _num(submitted.get("segment_total_2026"), "segment_total_2026")
    assert abs(total - expected_total) <= MONEY_TOL, (
        f"segment_total_2026 {total} != expected {expected_total}"
    )

    segments = submitted.get("segments")
    assert isinstance(segments, list), "segments must be a list to reconcile segment_total_2026"
    sum_2026 = sum(_num(s.get("rev_2026"), "segments[].rev_2026") for s in segments)
    assert abs(total - sum_2026) <= MONEY_TOL, (
        f"segment_total_2026 {total} != sum of submitted rev_2026 {sum_2026} (reconciliation failed)"
    )


def test_kpis() -> None:
    expected = read_fixture_json("expected", "ground_truth.json")["kpis"]
    submitted = result().get("kpis")
    assert isinstance(submitted, dict), f"kpis must be an object, got {type(submitted).__name__}"
    assert set(submitted) == set(expected), (
        f"kpis keys {sorted(submitted)} != expected {sorted(expected)}"
    )
    for key, exp in expected.items():
        got = _num(submitted[key], f"kpis.{key}")
        if key in EXACT_KPIS:
            assert got == exp, f"kpis.{key} {got} != {exp} (exact match required)"
        else:
            assert abs(got - exp) <= MONEY_TOL, f"kpis.{key} {got} != {exp} (tol {MONEY_TOL})"
