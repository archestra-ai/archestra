"""Verify the submitted churn-risk ranking against a recompute from the input fixtures.

Reads BENCH_RESULT (submitted JSON) and the four STAGED input fixtures the agent also sees:
inputs/crm_accounts.csv, inputs/usage_logs.jsonl, inputs/support_tickets.csv, inputs/invoices.csv.
The full rubric is RECOMPUTED here from those fixtures, so nothing is read from a hard-coded answer;
expected/scores.json (verifier-only) is cross-checked as a consistency guard on the recompute.

THE EXACT SCORING RUBRIC (single source of truth; identical to the prompt). Reference date 2026-07-01.
Per account, four normalized drivers in [0,1]:
- usage_decline_norm = clamp((prev - curr)/prev, 0, 1) using that account's prev/curr active_users;
  if prev==0 then 0.
- support_load_norm = min(count of tickets with severity=="high" AND status=="open" for the account,
  3) / 3.
- billing_norm = min(count of invoices with status=="overdue" for the account, 2) / 2.
- renewal_timing_norm: days_to_renewal = (renewal_date - 2026-07-01).days; if days_to_renewal <= 0
  then 1.0; elif days_to_renewal >= 90 then 0.0; else (90 - days_to_renewal)/90.
Weights: usage 0.40, support 0.25, billing 0.20, renewal 0.15.
score = 100 * (0.40*usage_decline_norm + 0.25*support_load_norm + 0.20*billing_norm
        + 0.15*renewal_timing_norm).
top driver = the driver with the LARGEST weighted contribution (weight_i * norm_i); codes are
"usage_decline","support_load","billing","renewal_timing"; tie-break by that listed order.
Ranking = top 5 accounts by score DESC; tie-break score desc, then arr_usd desc, then account_id asc.
arr_at_risk_usd = sum of arr_usd over the top 5.
"""

import csv
import json
from datetime import date

from bench_verifier import fixtures, read_fixture_json, result

AS_OF = date(2026, 7, 1)
WEIGHTS = {"usage_decline": 0.40, "support_load": 0.25, "billing": 0.20, "renewal_timing": 0.15}
DRIVER_ORDER = ["usage_decline", "support_load", "billing", "renewal_timing"]


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _read_csv(*rel: str) -> list[dict[str, str]]:
    with fixtures(*rel).open(encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def _read_usage() -> dict[str, dict[str, int]]:
    usage: dict[str, dict[str, int]] = {}
    with fixtures("inputs", "usage_logs.jsonl").open(encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            usage.setdefault(rec["account_id"], {})[rec["period"]] = int(rec["active_users"])
    return usage


def _recompute() -> dict[str, dict]:
    accounts = _read_csv("inputs", "crm_accounts.csv")
    usage = _read_usage()
    tickets = _read_csv("inputs", "support_tickets.csv")
    invoices = _read_csv("inputs", "invoices.csv")

    high_open: dict[str, int] = {}
    for t in tickets:
        if t["severity"] == "high" and t["status"] == "open":
            high_open[t["account_id"]] = high_open.get(t["account_id"], 0) + 1

    overdue: dict[str, int] = {}
    for inv in invoices:
        if inv["status"] == "overdue":
            overdue[inv["account_id"]] = overdue.get(inv["account_id"], 0) + 1

    computed: dict[str, dict] = {}
    for acc in accounts:
        acc_id = acc["account_id"]
        arr = int(acc["arr_usd"])
        prev = usage[acc_id]["prev"]
        curr = usage[acc_id]["curr"]

        usage_decline_norm = 0.0 if prev == 0 else _clamp((prev - curr) / prev, 0.0, 1.0)
        support_load_norm = min(high_open.get(acc_id, 0), 3) / 3
        billing_norm = min(overdue.get(acc_id, 0), 2) / 2

        renewal = date.fromisoformat(acc["renewal_date"])
        days_to_renewal = (renewal - AS_OF).days
        if days_to_renewal <= 0:
            renewal_timing_norm = 1.0
        elif days_to_renewal >= 90:
            renewal_timing_norm = 0.0
        else:
            renewal_timing_norm = (90 - days_to_renewal) / 90

        norms = {
            "usage_decline": usage_decline_norm,
            "support_load": support_load_norm,
            "billing": billing_norm,
            "renewal_timing": renewal_timing_norm,
        }
        score = 100 * sum(WEIGHTS[d] * norms[d] for d in DRIVER_ORDER)
        contributions = [(WEIGHTS[d] * norms[d], DRIVER_ORDER.index(d), d) for d in DRIVER_ORDER]
        contributions.sort(key=lambda c: (-c[0], c[1]))
        computed[acc_id] = {"score": score, "top_driver": contributions[0][2], "arr_usd": arr}
    return computed


def _ranked(computed: dict[str, dict]) -> list[str]:
    order = sorted(
        computed.items(),
        key=lambda kv: (-kv[1]["score"], -kv[1]["arr_usd"], kv[0]),
    )
    return [acc_id for acc_id, _ in order]


def test_expected_matches_recompute() -> None:
    # Consistency guard: the committed verifier-only ground truth must agree with the live recompute.
    computed = _recompute()
    expected = read_fixture_json("expected", "scores.json")
    assert set(expected) == set(computed), "expected/scores.json account set drifted from fixtures"
    for acc_id, info in expected.items():
        assert abs(info["score"] - computed[acc_id]["score"]) < 1e-6, f"{acc_id} score drift"
        assert info["top_driver"] == computed[acc_id]["top_driver"], f"{acc_id} driver drift"


def test_ranking_exact_order() -> None:
    computed = _recompute()
    expected_top5 = _ranked(computed)[:5]

    submitted = result().get("ranking")
    assert isinstance(submitted, list), f"ranking must be a list, got {type(submitted).__name__}"
    assert submitted == expected_top5, f"ranking {submitted} != expected {expected_top5}"


def test_arr_at_risk() -> None:
    computed = _recompute()
    top5 = _ranked(computed)[:5]
    expected_arr = sum(computed[acc_id]["arr_usd"] for acc_id in top5)

    submitted = result().get("arr_at_risk_usd")
    assert isinstance(submitted, (int, float)) and not isinstance(submitted, bool), (
        f"arr_at_risk_usd must be a number, got {submitted!r}"
    )
    assert abs(submitted - expected_arr) <= 0.01, f"arr_at_risk_usd {submitted} != {expected_arr}"


def test_top_drivers() -> None:
    computed = _recompute()
    top5 = _ranked(computed)[:5]
    expected_drivers = {acc_id: computed[acc_id]["top_driver"] for acc_id in top5}

    submitted = result().get("top_drivers")
    assert isinstance(submitted, dict), f"top_drivers must be an object, got {type(submitted).__name__}"
    assert set(submitted) == set(top5), (
        f"top_drivers keys {sorted(submitted)} != ranked accounts {sorted(top5)}"
    )
    errors = [
        f"{acc_id}: {submitted[acc_id]!r} != {driver!r}"
        for acc_id, driver in expected_drivers.items()
        if submitted[acc_id] != driver
    ]
    assert not errors, "; ".join(errors)
