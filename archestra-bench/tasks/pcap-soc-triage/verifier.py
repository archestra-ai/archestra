"""Verify the submitted SOC triage against a recompute from the same flow table.

Reads BENCH_RESULT (submitted JSON) and BENCH_FIXTURES/inputs/flows.csv (the same CSV staged to the
agent). The detector rules are applied here verbatim from the prompt; the committed
expected/triage.json is cross-checked against the recompute so the two never silently diverge.

Clean-or-fail: the submitted lists are compared as sets (order-insensitive) but the values must be
exactly the offending IPs -- no salvage of stringified or wrapped results.
"""

import csv
from collections import defaultdict

from bench_verifier import fixtures, read_fixture_json, result


def _recompute() -> dict:
    ports_by_pair: dict[tuple[str, str], set[int]] = defaultdict(set)
    first_ts_by_pair: dict[tuple[str, str], list[int]] = defaultdict(list)
    protocol_counts: dict[str, int] = defaultdict(int)
    dos: set[str] = set()
    port_scan: set[str] = set()
    beaconing: set[str] = set()

    with fixtures("inputs", "flows.csv").open(encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            src = row["src_ip"]
            dst = row["dst_ip"]
            pair = (src, dst)
            ports_by_pair[pair].add(int(row["dst_port"]))
            first_ts_by_pair[pair].append(int(row["first_ts"]))
            protocol_counts[row["proto"]] += 1
            # dos: any single flow with rate > 1000, rate = packets / max(1, last_ts - first_ts).
            rate = int(row["packets"]) / max(1, int(row["last_ts"]) - int(row["first_ts"]))
            if rate > 1000:
                dos.add(src)

    # port_scan: (src, dst) pair with > 20 distinct dst_port values.
    for (src, _dst), ports in ports_by_pair.items():
        if len(ports) > 20:
            port_scan.add(src)

    # beaconing: (src, dst) pair with >= 5 flows whose sorted first_ts gaps span <= 5s.
    for (src, _dst), first_tss in first_ts_by_pair.items():
        if len(first_tss) >= 5:
            ordered = sorted(first_tss)
            gaps = [b - a for a, b in zip(ordered, ordered[1:])]
            if gaps and (max(gaps) - min(gaps)) <= 5:
                beaconing.add(src)

    return {
        "protocol_counts": dict(protocol_counts),
        "port_scan_src_ips": port_scan,
        "dos_src_ips": dos,
        "beaconing_src_ips": beaconing,
        "flags": {
            "port_scan": bool(port_scan),
            "dos": bool(dos),
            "beaconing": bool(beaconing),
        },
    }


def test_expected_matches_recompute() -> None:
    """The committed ground truth must agree with the recompute from the live CSV."""
    truth = _recompute()
    expected = read_fixture_json("expected", "triage.json")
    assert expected["protocol_counts"] == truth["protocol_counts"]
    assert set(expected["port_scan_src_ips"]) == truth["port_scan_src_ips"]
    assert set(expected["dos_src_ips"]) == truth["dos_src_ips"]
    assert set(expected["beaconing_src_ips"]) == truth["beaconing_src_ips"]
    assert expected["flags"] == truth["flags"]


def test_protocol_counts_match() -> None:
    truth = _recompute()
    submitted = result()["protocol_counts"]
    assert submitted == truth["protocol_counts"], (
        f"submitted protocol_counts {submitted!r} != expected {truth['protocol_counts']!r}"
    )


def test_port_scan_src_ips_match() -> None:
    truth = _recompute()
    submitted = set(result()["port_scan_src_ips"])
    assert submitted == truth["port_scan_src_ips"], (
        f"submitted port_scan_src_ips {submitted!r} != expected {truth['port_scan_src_ips']!r}"
    )


def test_dos_src_ips_match() -> None:
    truth = _recompute()
    submitted = set(result()["dos_src_ips"])
    assert submitted == truth["dos_src_ips"], (
        f"submitted dos_src_ips {submitted!r} != expected {truth['dos_src_ips']!r}"
    )


def test_beaconing_src_ips_match() -> None:
    truth = _recompute()
    submitted = set(result()["beaconing_src_ips"])
    assert submitted == truth["beaconing_src_ips"], (
        f"submitted beaconing_src_ips {submitted!r} != expected {truth['beaconing_src_ips']!r}"
    )


def test_flags_match() -> None:
    truth = _recompute()
    submitted = result()["flags"]
    assert submitted == truth["flags"], f"submitted flags {submitted!r} != expected {truth['flags']!r}"


def test_no_borderline_cases() -> None:
    """The prompt describes the patterns qualitatively (no numeric thresholds), so the agent must judge
    "wide spread / extreme rate / steady interval" itself. That is only fair if the staged data keeps
    every flow well clear of every oracle threshold -- otherwise a reasonable analyst could land on a
    different answer than the exact-rule recompute. Enforce comfortable margins so a future fixture
    edit can't silently reintroduce an ambiguous case.
    """
    ports_by_pair: dict[tuple[str, str], set[int]] = defaultdict(set)
    first_ts_by_pair: dict[tuple[str, str], list[int]] = defaultdict(list)
    with fixtures("inputs", "flows.csv").open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            pair = (row["src_ip"], row["dst_ip"])
            ports_by_pair[pair].add(int(row["dst_port"]))
            first_ts_by_pair[pair].append(int(row["first_ts"]))
            rate = int(row["packets"]) / max(1, int(row["last_ts"]) - int(row["first_ts"]))
            assert rate < 500 or rate > 5000, f"flow rate {rate:.1f} pkt/s sits in the ambiguous flood band"

    for pair, ports in ports_by_pair.items():
        count = len(ports)
        assert count <= 10 or count >= 22, f"pair {pair} has {count} distinct ports -- ambiguous port-scan band"

    for pair, first_tss in first_ts_by_pair.items():
        if len(first_tss) >= 4:
            ordered = sorted(first_tss)
            gaps = [b - a for a, b in zip(ordered, ordered[1:])]
            span = max(gaps) - min(gaps)
            assert (len(first_tss) >= 6 and span <= 5) or span >= 20, (
                f"pair {pair} ({len(first_tss)} flows, gap span {span}s) is beacon-ambiguous"
            )
