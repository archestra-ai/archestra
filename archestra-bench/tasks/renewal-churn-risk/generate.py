# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate the renewal-churn-risk fixtures (committed; the runner ignores this script).

Deterministic: a fixed account roster (no rng over the scored quantities, no now()), so re-running is
byte-identical. Produces the four input fixtures plus expected/scores.json (verifier-only ground
truth recomputed by the verifier at grade time).

The roster is hand-tuned so the 5th and 6th ranked accounts differ in score by a clear margin, so an
exact-ordered top-5 is fair to grade.

Run:  uv run generate.py
"""

from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

AS_OF = date(2026, 7, 1)
WEIGHTS = {"usage_decline": 0.40, "support_load": 0.25, "billing": 0.20, "renewal_timing": 0.15}
DRIVER_ORDER = ["usage_decline", "support_load", "billing", "renewal_timing"]


# Each account: id, name, arr, segment, renewal_date, prev/curr active users,
# (high&open tickets), (other tickets), overdue invoices, paid invoices.
# Designed so a handful are clearly high-risk and the rest tail off, with a gap at the cutoff.
ROSTER = [
    # account_id, name, arr_usd, segment, renewal_date, prev, curr, high_open, low_med_mix, overdue, paid
    ("ACC-01", "Northwind Retail", 320_000, "Enterprise", "2026-07-20", 200, 70, 3, 4, 2, 1),
    ("ACC-02", "Helios Manufacturing", 540_000, "Enterprise", "2026-07-10", 150, 90, 2, 3, 2, 2),
    ("ACC-03", "Cobalt Logistics", 180_000, "Mid", "2026-08-05", 120, 60, 3, 2, 1, 1),
    ("ACC-04", "Vertex Analytics", 95_000, "SMB", "2026-07-05", 80, 40, 2, 1, 2, 0),
    ("ACC-05", "Marigold Health", 410_000, "Enterprise", "2026-09-15", 300, 210, 2, 5, 1, 3),
    ("ACC-06", "Quartz Media", 60_000, "SMB", "2026-10-01", 50, 44, 1, 2, 1, 1),
    ("ACC-07", "Sterling Finance", 270_000, "Enterprise", "2026-11-20", 220, 205, 0, 3, 0, 4),
    ("ACC-08", "Beacon Education", 130_000, "Mid", "2026-08-25", 90, 86, 1, 1, 0, 2),
    ("ACC-09", "Ironwood Energy", 200_000, "Mid", "2027-01-10", 160, 158, 0, 2, 0, 3),
    ("ACC-10", "Lumen Software", 75_000, "SMB", "2026-12-05", 40, 39, 0, 1, 0, 1),
    ("ACC-11", "Falcon Aerospace", 350_000, "Enterprise", "2027-02-01", 280, 276, 1, 4, 0, 5),
    ("ACC-12", "Pebble Consumer", 50_000, "SMB", "2026-10-20", 30, 28, 0, 1, 1, 0),
    ("ACC-13", "Granite Construction", 160_000, "Mid", "2026-12-30", 110, 112, 0, 2, 0, 2),
    ("ACC-14", "Azure Travel", 90_000, "SMB", "2027-03-15", 70, 68, 0, 1, 0, 1),
    ("ACC-15", "Cedar Hospitality", 140_000, "Mid", "2026-11-05", 95, 90, 1, 2, 0, 2),
]

SEVERITIES_NON_HIGH = ["low", "med"]


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def usage_decline_norm(prev: int, curr: int) -> float:
    if prev == 0:
        return 0.0
    return clamp((prev - curr) / prev, 0.0, 1.0)


def support_load_norm(high_open: int) -> float:
    return min(high_open, 3) / 3


def billing_norm(overdue: int) -> float:
    return min(overdue, 2) / 2


def renewal_timing_norm(renewal: date) -> float:
    days_to_renewal = (renewal - AS_OF).days
    if days_to_renewal <= 0:
        return 1.0
    if days_to_renewal >= 90:
        return 0.0
    return (90 - days_to_renewal) / 90


def score_account(prev, curr, high_open, overdue, renewal) -> tuple[float, str]:
    norms = {
        "usage_decline": usage_decline_norm(prev, curr),
        "support_load": support_load_norm(high_open),
        "billing": billing_norm(overdue),
        "renewal_timing": renewal_timing_norm(renewal),
    }
    score = 100 * sum(WEIGHTS[d] * norms[d] for d in DRIVER_ORDER)
    contributions = [(WEIGHTS[d] * norms[d], DRIVER_ORDER.index(d), d) for d in DRIVER_ORDER]
    contributions.sort(key=lambda t: (-t[0], t[1]))
    return score, contributions[0][2]


def main() -> None:
    root = Path(__file__).resolve().parent
    inputs = root / "inputs"
    expected = root / "expected"
    inputs.mkdir(parents=True, exist_ok=True)
    expected.mkdir(parents=True, exist_ok=True)

    crm_rows = [["account_id", "name", "arr_usd", "segment", "renewal_date"]]
    usage_lines: list[dict] = []
    ticket_rows = [["ticket_id", "account_id", "severity", "status"]]
    invoice_rows = [["invoice_id", "account_id", "status", "days_late"]]
    scores: dict[str, dict] = {}

    ticket_seq = 1
    invoice_seq = 1
    for acc_id, name, arr, segment, renewal_str, prev, curr, high_open, mix, overdue, paid in ROSTER:
        renewal = date.fromisoformat(renewal_str)
        crm_rows.append([acc_id, name, arr, segment, renewal_str])

        usage_lines.append({"account_id": acc_id, "period": "prev", "active_users": prev})
        usage_lines.append({"account_id": acc_id, "period": "curr", "active_users": curr})

        # high & open tickets (these drive the score)
        for _ in range(high_open):
            ticket_rows.append([f"TCK-{ticket_seq:04d}", acc_id, "high", "open"])
            ticket_seq += 1
        # distractor tickets: closed high-sev and low/med tickets that must NOT count
        for k in range(mix):
            sev = SEVERITIES_NON_HIGH[k % len(SEVERITIES_NON_HIGH)]
            status = "closed" if k % 2 == 0 else "open"
            ticket_rows.append([f"TCK-{ticket_seq:04d}", acc_id, sev, status])
            ticket_seq += 1
        # one closed high-severity ticket for accounts with mix>=3, to tempt severity-only counting
        if mix >= 3:
            ticket_rows.append([f"TCK-{ticket_seq:04d}", acc_id, "high", "closed"])
            ticket_seq += 1

        for _ in range(overdue):
            invoice_rows.append([f"INV-{invoice_seq:04d}", acc_id, "overdue", 30])
            invoice_seq += 1
        for _ in range(paid):
            invoice_rows.append([f"INV-{invoice_seq:04d}", acc_id, "paid", 0])
            invoice_seq += 1

        score, top_driver = score_account(prev, curr, high_open, overdue, renewal)
        scores[acc_id] = {"score": round(score, 6), "top_driver": top_driver, "arr_usd": arr}

    with (inputs / "crm_accounts.csv").open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh, lineterminator="\n").writerows(crm_rows)

    with (inputs / "usage_logs.jsonl").open("w", encoding="utf-8") as fh:
        for line in usage_lines:
            fh.write(json.dumps(line, sort_keys=True) + "\n")

    with (inputs / "support_tickets.csv").open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh, lineterminator="\n").writerows(ticket_rows)

    with (inputs / "invoices.csv").open("w", newline="", encoding="utf-8") as fh:
        csv.writer(fh, lineterminator="\n").writerows(invoice_rows)

    with (expected / "scores.json").open("w", encoding="utf-8") as fh:
        json.dump(scores, fh, indent=2, sort_keys=True)
        fh.write("\n")

    ranked = sorted(
        scores.items(),
        key=lambda kv: (-kv[1]["score"], -kv[1]["arr_usd"], kv[0]),
    )
    print("Rank  account  score    top_driver")
    for i, (acc_id, info) in enumerate(ranked, 1):
        marker = " <- cutoff" if i in (5, 6) else ""
        print(f"{i:>4}  {acc_id}  {info['score']:7.3f}  {info['top_driver']}{marker}")
    top5 = ranked[:5]
    gap = top5[-1][1]["score"] - ranked[5][1]["score"]
    print(f"\ntop-5 ARR at risk: {sum(a[1]['arr_usd'] for a in top5)}")
    print(f"5th-vs-6th margin: {gap:.3f}")


if __name__ == "__main__":
    main()
