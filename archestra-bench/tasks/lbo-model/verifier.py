"""Verify the preliminary LBO (with FCF + cash sweep) against a recompute from the pinned assumptions.

Reads BENCH_RESULT (submitted JSON) and expected/assumptions.json (verifier-only -- the machine-readable
form of the staged deal_assumptions.txt the agent sees). The full 5-year model is RECOMPUTED here under
the prompt's pinned conventions, so nothing is read from a hard-coded answer:

- revenue[y] = base_rev * prod(1+growth); ebitda[y] = revenue[y] * margin[y].
- D&A = da_pct*revenue; EBIT = EBITDA - D&A; cash tax = max(0, tax_rate*EBIT).
- capex = capex_pct*revenue; dNWC = nwc_pct*(revenue[y] - revenue[y-1]) (year 1 vs the base).
- Interest on BEGINNING balances: TLB interest = tlb_rate*tlb_begin (cash every year). Second Lien at
  pik_rate: PIK (added to balance) for pik_years, then cash-pay (paid in cash, balance flat).
- FCF = EBITDA - cash tax - capex - dNWC - cash interest (D&A non-cash, not subtracted).
- TLB paydown = min(tlb_begin, max(mandatory_amort, FCF)); Second Lien never swept; no cash balance.
- exit_ev = exit_multiple*ebitda[-1]; exit_equity = exit_ev - (tlb_end[-1] + pik_end[-1]).
- moic = exit_equity / sponsor_equity_in; irr = moic**(1/5) - 1.

The simplifications are removed on purpose: a model that ignores taxes/sweep, taxes EBITDA instead of
EBIT, or mishandles the PIK->cash-pay switch lands on different fcf/tlb_ending/exit numbers and fails.
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

    tlb_begin = a["tlb_principal"]
    pik_begin = a["pik_principal"]
    prev_rev = a["base_rev_fy2025e"]
    fcf: list[float] = []
    tlb_end: list[float] = []
    pik_end: list[float] = []
    for i in range(5):
        year = i + 1
        da = rev[i] * a["da_pct"]
        ebit = ebitda[i] - da
        tax = max(0.0, ebit * a["tax_rate"])
        capex = rev[i] * a["capex_pct"]
        dnwc = (rev[i] - prev_rev) * a["nwc_pct"]
        tlb_int = tlb_begin * a["tlb_rate"]
        pik_int = pik_begin * a["pik_rate"]
        if year <= a["pik_years"]:
            pik_cash = 0.0
            pik_close = pik_begin + pik_int
        else:
            pik_cash = pik_int
            pik_close = pik_begin
        f = ebitda[i] - tax - capex - dnwc - (tlb_int + pik_cash)
        paydown = min(tlb_begin, max(a["tlb_mandatory_amort"], f))
        tlb_close = tlb_begin - paydown
        fcf.append(f)
        tlb_end.append(tlb_close)
        pik_end.append(pik_close)
        tlb_begin, pik_begin, prev_rev = tlb_close, pik_close, rev[i]

    exit_ev = a["exit_multiple"] * ebitda[-1]
    exit_equity = exit_ev - (tlb_end[-1] + pik_end[-1])
    moic = exit_equity / a["sponsor_equity_in"]
    irr = moic ** (1 / 5) - 1
    return {
        "revenue": rev,
        "ebitda": ebitda,
        "fcf": fcf,
        "tlb_ending": tlb_end,
        "pik_ending": pik_end,
        "exit_ev": exit_ev,
        "exit_equity": exit_equity,
        "moic": moic,
        "irr": irr,
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

    series_tol = {
        "revenue": (0.5, 0.005),
        "ebitda": (0.5, 0.005),
        "fcf": (0.75, 0.0),       # absolute $0.75M -- a method error (tax base, interest) blows past this
        "tlb_ending": (2.0, 0.0),  # sweep-sensitive; method errors are >10 off, rounding paths < 2
        "pik_ending": (1.0, 0.0),
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
        if not _close(got, expected[key], abs_tol=0.75, rel_tol=0.005):
            errors.append(f"{key}: {got} != {expected[key]:.2f}")

    moic = _num(res.get("moic"), "moic")
    if not _close(moic, expected["moic"], abs_tol=0.05, rel_tol=0.0):
        errors.append(f"moic: {moic} != {expected['moic']:.3f}")
    irr = _num(res.get("irr"), "irr")
    if not _close(irr, expected["irr"], abs_tol=0.006, rel_tol=0.0):
        errors.append(f"irr: {irr} != {expected['irr']:.4f}")

    assert not errors, "; ".join(errors)
