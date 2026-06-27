"""Verify the preliminary LBO (average-balance circular interest + revolver waterfall) against a recompute.

Reads BENCH_RESULT (submitted JSON) and expected/assumptions.json (verifier-only -- the machine-readable
form of the staged deal_assumptions.txt). The full 5-year model is RECOMPUTED here under the prompt's
pinned conventions, so nothing is read from a hard-coded answer.

Per year, cash interest is charged on the AVERAGE of each debt's beginning and ending balance, so the
ending balances and interest form a fixed point that this verifier solves by iteration -- the same
thing the agent must do:
- operating cash flow = EBITDA - max(0, tax_rate*(EBITDA - da_pct*rev)) - capex_pct*rev - nwc_pct*dRev.
- TLB cash interest = tlb_rate * avg(TLB); revolver cash interest = revolver_rate * avg(revolver).
- Second Lien PIKs on its BEGINNING balance for pik_years (ending = beginning*(1+pik_rate)), then is
  cash-pay (interest = pik_rate*balance, balance flat) -- so its average equals its balance.
- fcf = operating cash flow - total cash interest.
- waterfall: TLB always takes the mandatory amort; net = fcf - amort. net<0 draws the revolver by the
  shortfall (no sweep); net>=0 repays the revolver first, then sweeps the remainder 100% to the TLB.

The schedule columns (fcf, tlb_ending, revolver_ending) are graded tightly: a beginning-balance
interest shortcut, no iteration, or a missing year-1 revolver draw shifts them past tolerance. MOIC/IRR
move very little between methods (offsetting errors) so they are only loose sanity checks.
"""

from bench_verifier import read_fixture_json, result


def _recompute() -> dict:
    a = read_fixture_json("expected", "assumptions.json")
    rev: list[float] = []
    r = a["base_rev_fy2025e"]
    for g in a["revenue_growth"]:
        r *= 1 + g
        rev.append(r)
    ebitda = [rev[i] * a["ebitda_margin"][i] for i in range(5)]

    tlb_b, revolver_b, pik_b = a["tlb_principal"], 0.0, a["pik_principal"]
    prev_rev = a["base_rev_fy2025e"]
    amort = a["tlb_mandatory_amort"]
    fcf: list[float] = []
    tlb_end: list[float] = []
    revolver_end: list[float] = []
    pik_end: list[float] = []
    for i in range(5):
        year = i + 1
        ebit = ebitda[i] - rev[i] * a["da_pct"]
        tax = max(0.0, ebit * a["tax_rate"])
        ocf = ebitda[i] - tax - rev[i] * a["capex_pct"] - (rev[i] - prev_rev) * a["nwc_pct"]

        if year <= a["pik_years"]:
            pik_close = pik_b * (1 + a["pik_rate"])
            pik_cash = 0.0
        else:
            pik_close = pik_b
            pik_cash = a["pik_rate"] * pik_b

        # Fixed point over (tlb_close, revolver_close): average-balance interest <-> waterfall.
        tlb_close, revolver_close = tlb_b, revolver_b
        for _ in range(500):
            tlb_int = a["tlb_rate"] * (tlb_b + tlb_close) / 2
            revolver_int = a["revolver_rate"] * (revolver_b + revolver_close) / 2
            year_fcf = ocf - (tlb_int + revolver_int + pik_cash)
            new_tlb = tlb_b - amort
            net = year_fcf - amort
            if net < 0:
                new_revolver = revolver_b + (-net)
            else:
                repay = min(revolver_b, net)
                new_revolver = revolver_b - repay
                new_tlb = max(0.0, new_tlb - (net - repay))
            if abs(new_tlb - tlb_close) < 1e-9 and abs(new_revolver - revolver_close) < 1e-9:
                tlb_close, revolver_close = new_tlb, new_revolver
                break
            tlb_close, revolver_close = new_tlb, new_revolver

        fcf.append(year_fcf)
        tlb_end.append(tlb_close)
        revolver_end.append(revolver_close)
        pik_end.append(pik_close)
        tlb_b, revolver_b, pik_b, prev_rev = tlb_close, revolver_close, pik_close, rev[i]

    exit_ev = a["exit_multiple"] * ebitda[-1]
    exit_equity = exit_ev - (tlb_end[-1] + revolver_end[-1] + pik_end[-1])
    moic = exit_equity / a["sponsor_equity_in"]
    return {
        "revenue": rev,
        "ebitda": ebitda,
        "fcf": fcf,
        "tlb_ending": tlb_end,
        "revolver_ending": revolver_end,
        "pik_ending": pik_end,
        "exit_ev": exit_ev,
        "exit_equity": exit_equity,
        "moic": moic,
        "irr": moic ** (1 / 5) - 1,
    }


def _num(value, label: str) -> float:
    assert isinstance(value, (int, float)) and not isinstance(value, bool), f"{label} must be a number, got {value!r}"
    return float(value)


def _close(got: float, exp: float, *, abs_tol: float, rel_tol: float) -> bool:
    return abs(got - exp) <= max(abs_tol, abs(exp) * rel_tol)


def test_lbo_outputs() -> None:
    expected = _recompute()
    res = result()
    errors: list[str] = []

    # Schedule columns are the discriminators -- tight enough to catch a beginning-balance interest
    # shortcut (fcf off ~1.2, tlb off ~2.7) or a missing revolver draw (revolver 11.5 vs 0, tlb off ~16).
    series_tol = {
        "revenue": (0.5, 0.005),
        "ebitda": (0.5, 0.005),
        "fcf": (0.3, 0.0),
        "tlb_ending": (1.0, 0.0),
        "revolver_ending": (0.5, 0.0),
        "pik_ending": (0.5, 0.0),
    }
    for key, (abs_tol, rel_tol) in series_tol.items():
        series = res.get(key)
        if not isinstance(series, list) or len(series) != 5:
            errors.append(f"{key}: must be a list of 5 numbers, got {series!r}")
            continue
        for i, (g, e) in enumerate(zip(series, expected[key])):
            got = _num(g, f"{key}[{i}]")
            if not _close(got, e, abs_tol=abs_tol, rel_tol=rel_tol):
                errors.append(f"{key}[{i}]: {got} != {e:.2f}")

    for key in ("exit_ev", "exit_equity"):
        got = _num(res.get(key), key)
        if not _close(got, expected[key], abs_tol=1.0, rel_tol=0.005):
            errors.append(f"{key}: {got} != {expected[key]:.2f}")

    # MOIC/IRR barely move between correct and shortcut methods, so they are loose sanity checks only.
    moic = _num(res.get("moic"), "moic")
    if not _close(moic, expected["moic"], abs_tol=0.05, rel_tol=0.0):
        errors.append(f"moic: {moic} != {expected['moic']:.3f}")
    irr = _num(res.get("irr"), "irr")
    if not _close(irr, expected["irr"], abs_tol=0.006, rel_tol=0.0):
        errors.append(f"irr: {irr} != {expected['irr']:.4f}")

    assert not errors, "; ".join(errors)
