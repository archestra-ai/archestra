# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate the pcap-soc-triage fixtures: inputs/flows.csv and expected/triage.json.

Deterministic (fixed seed, no wall-clock) so both committed files are byte-identical on every run.
The CSV is a pre-derived network flow table (no packet capture parsing) with exactly one planted
case of each behaviour plus a benign-but-noisy distractor and normal background traffic:

  - port_scan : one src hits one dst across > 20 distinct dst_port values.
  - dos       : one src has a single flow whose rate (packets / window) exceeds 1000 pkt/s.
  - beaconing : one src->dst pair has >= 5 flows with near-constant first_ts gaps (<= 5s spread).
  - distractor: one host pushes high bytes/packets but few dst_ports, no high-rate flow, and
                irregular intervals -- it must match NO rule.
  - spread    : one src touches many dsts with few ports each (many distinct ports overall, but few
                per (src, dst) pair) -- trips a naive per-src port count, but NOT the per-pair rule.
  - background: ordinary flows that trip nothing.

The exact detector thresholds live in verifier.py (the oracle); task.toml describes the patterns only
qualitatively (no numbers), so the agent must judge "wide spread / extreme rate / steady interval"
itself. That is only fair if every flow sits well clear of every threshold -- so this script plants
data in comfortable margins (port spread 25 vs <=4; rate 10000 vs <=240 pkt/s; the beacon at 6 steady
~60s flows vs every other multi-flow pair either <5 flows or visibly irregular). verifier.py's
test_no_borderline_cases enforces those margins so a future edit can't reintroduce an ambiguous case.

Run:  uv run generate.py
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

_BASE_TS = 1_700_000_000  # fixed epoch anchor; never time.now()

# Planted offenders (defensible by construction; recomputed independently by the verifier).
PORT_SCAN_SRC = "10.0.0.5"
PORT_SCAN_DST = "10.0.0.80"
DOS_SRC = "10.0.0.6"
DOS_DST = "10.0.0.81"
BEACON_SRC = "10.0.0.7"
BEACON_DST = "203.0.113.10"
DISTRACTOR_SRC = "10.0.0.8"
DISTRACTOR_DST = "10.0.0.82"
SPREAD_SRC = "10.0.0.9"


def _build_rows() -> list[list[str | int]]:
    rows: list[list[str | int]] = []

    # port_scan: 25 distinct dst_port flows from one src to one dst -- far above any sane "wide spread"
    # bar. Bursty, irregular first_ts gaps (min 1s, max 23s -> span 22s) so the pair reads as a rapid
    # sweep, never a steady beacon, under both the exact rule and a threshold-free human reading.
    scan_offsets = [0, 1, 1, 2, 1, 9, 1, 1, 4, 2, 1, 1, 5, 1, 2, 1, 1, 3, 1, 23, 1, 1, 2, 1, 1]
    ts = _BASE_TS
    for i, off in enumerate(scan_offsets):
        ts += off
        port = 1000 + i
        rows.append([PORT_SCAN_SRC, PORT_SCAN_DST, port, "tcp", 4, 240, ts, ts + 1])

    # dos: one flow at 10000 pkt/s (600000 packets over a 60s window), far above 1000.
    rows.append([DOS_SRC, DOS_DST, 53, "udp", 600_000, 84_000_000, _BASE_TS, _BASE_TS + 60])

    # beaconing: 6 flows, src->dst, first_ts ~60s apart with +-2s jitter (spread <= 5s).
    beacon_gaps = [60, 59, 61, 58, 62]  # max-min = 4 <= 5
    ts = _BASE_TS + 500
    for j, gap in enumerate([0, *beacon_gaps]):
        ts += gap
        rows.append([BEACON_SRC, BEACON_DST, 443, "tcp", 12, 1_400, ts, ts + 3])

    # distractor: high bytes/packets, only 3 distinct dst_ports, irregular gaps, no high-rate flow.
    # Top rate ~240 pkt/s -- well under the flood band and ~40x below the real flood (10000 pkt/s).
    distractor_flows = [
        (80, 60_000, 130_000_000, _BASE_TS + 1000, _BASE_TS + 1300),   # 200pkt/s
        (443, 120_000, 170_000_000, _BASE_TS + 1700, _BASE_TS + 2200),  # 240pkt/s
        (8080, 70_000, 95_000_000, _BASE_TS + 4000, _BASE_TS + 4500),  # 140pkt/s
        (80, 55_000, 80_000_000, _BASE_TS + 9000, _BASE_TS + 9400),    # ~137pkt/s
    ]
    for port, packets, byte_count, first_ts, last_ts in distractor_flows:
        rows.append([DISTRACTOR_SRC, DISTRACTOR_DST, port, "tcp", packets, byte_count, first_ts, last_ts])

    # spread distractor: one src touches 6 dsts with 4 distinct dst_ports each -- 24 distinct ports
    # for the src overall, but only 4 per (src, dst) pair. A naive "distinct ports per src" solver
    # flags it as scanning; scoped to the pair it is not a wide spread. The 4 flows per pair are spaced
    # at deliberately irregular gaps (3s, 35s, 8s -> span 32s) so the pair never reads as a steady
    # beacon under a threshold-free reading -- the only safe-margin concern once the rules are de-clued.
    spread_intra_gaps = [3, 35, 8]
    spread_ts = _BASE_TS + 1500
    for d in range(6):
        spread_dst = f"10.0.0.{120 + d}"
        t = spread_ts
        for p in range(4):
            rows.append([SPREAD_SRC, spread_dst, 2000 + d * 4 + p, "tcp", 20, 3_000, t, t + 2])
            if p < len(spread_intra_gaps):
                t += spread_intra_gaps[p]
        spread_ts += 90

    # background: ordinary low-volume flows across tcp/udp/icmp that trip nothing.
    background = [
        ("10.0.0.11", "10.0.0.90", 443, "tcp", 30, 4_000, _BASE_TS + 10, _BASE_TS + 25),
        ("10.0.0.12", "10.0.0.90", 80, "tcp", 18, 2_200, _BASE_TS + 40, _BASE_TS + 52),
        ("10.0.0.13", "8.8.8.8", 53, "udp", 6, 540, _BASE_TS + 70, _BASE_TS + 71),
        ("10.0.0.14", "8.8.4.4", 53, "udp", 4, 360, _BASE_TS + 90, _BASE_TS + 91),
        ("10.0.0.15", "10.0.0.91", 22, "tcp", 220, 40_000, _BASE_TS + 120, _BASE_TS + 480),
        ("10.0.0.16", "10.0.0.92", 0, "icmp", 8, 800, _BASE_TS + 130, _BASE_TS + 140),
        ("10.0.0.17", "10.0.0.92", 0, "icmp", 4, 400, _BASE_TS + 200, _BASE_TS + 205),
        ("10.0.0.18", "203.0.113.20", 443, "tcp", 95, 120_000, _BASE_TS + 210, _BASE_TS + 400),
        ("10.0.0.19", "203.0.113.21", 443, "tcp", 60, 70_000, _BASE_TS + 260, _BASE_TS + 350),
        ("10.0.0.20", "10.0.0.93", 3389, "tcp", 40, 5_000, _BASE_TS + 300, _BASE_TS + 360),
        ("10.0.0.21", "10.0.0.93", 445, "tcp", 25, 3_000, _BASE_TS + 320, _BASE_TS + 333),
        ("10.0.0.22", "8.8.8.8", 123, "udp", 2, 180, _BASE_TS + 360, _BASE_TS + 361),
        ("10.0.0.23", "10.0.0.94", 0, "icmp", 3, 300, _BASE_TS + 380, _BASE_TS + 384),
        ("10.0.0.24", "10.0.0.95", 8443, "tcp", 70, 90_000, _BASE_TS + 400, _BASE_TS + 600),
        ("10.0.0.25", "10.0.0.96", 5432, "tcp", 50, 7_000, _BASE_TS + 420, _BASE_TS + 470),
        ("10.0.0.26", "203.0.113.22", 80, "tcp", 33, 4_400, _BASE_TS + 440, _BASE_TS + 470),
        ("10.0.0.27", "8.8.4.4", 53, "udp", 5, 450, _BASE_TS + 460, _BASE_TS + 461),
        ("10.0.0.28", "10.0.0.97", 0, "icmp", 6, 600, _BASE_TS + 480, _BASE_TS + 486),
        ("10.0.0.29", "10.0.0.98", 443, "tcp", 44, 5_600, _BASE_TS + 150, _BASE_TS + 300),
        ("10.0.0.30", "10.0.0.98", 80, "tcp", 27, 3_300, _BASE_TS + 175, _BASE_TS + 240),
        ("10.0.0.31", "203.0.113.23", 443, "tcp", 80, 110_000, _BASE_TS + 220, _BASE_TS + 500),
        ("10.0.0.32", "8.8.8.8", 53, "udp", 3, 270, _BASE_TS + 240, _BASE_TS + 241),
        ("10.0.0.33", "10.0.0.99", 5432, "tcp", 38, 5_200, _BASE_TS + 280, _BASE_TS + 330),
        ("10.0.0.34", "10.0.0.99", 6379, "tcp", 22, 2_600, _BASE_TS + 300, _BASE_TS + 332),
        ("10.0.0.35", "203.0.113.24", 80, "tcp", 51, 66_000, _BASE_TS + 330, _BASE_TS + 470),
        ("10.0.0.36", "10.0.0.100", 22, "tcp", 140, 24_000, _BASE_TS + 360, _BASE_TS + 700),
        ("10.0.0.37", "8.8.4.4", 123, "udp", 2, 180, _BASE_TS + 400, _BASE_TS + 401),
        ("10.0.0.38", "10.0.0.101", 0, "icmp", 5, 500, _BASE_TS + 430, _BASE_TS + 436),
        ("10.0.0.39", "10.0.0.102", 8443, "tcp", 64, 88_000, _BASE_TS + 455, _BASE_TS + 640),
        ("10.0.0.40", "10.0.0.103", 3389, "tcp", 35, 4_600, _BASE_TS + 470, _BASE_TS + 520),
    ]
    for row in background:
        rows.append(list(row))

    return rows


def _recompute(rows: list[list[str | int]]) -> dict:
    """Ground truth, computed with the exact detector rules (mirrors verifier.py)."""
    from collections import defaultdict

    ports_by_pair: dict[tuple[str, str], set[int]] = defaultdict(set)
    flows_by_pair: dict[tuple[str, str], list[int]] = defaultdict(list)
    proto_counts: dict[str, int] = defaultdict(int)
    dos: set[str] = set()
    port_scan: set[str] = set()
    beaconing: set[str] = set()

    for src, dst, dst_port, proto, packets, _bytes, first_ts, last_ts in rows:
        pair = (src, dst)
        ports_by_pair[pair].add(int(dst_port))
        flows_by_pair[pair].append(int(first_ts))
        proto_counts[str(proto)] += 1
        rate = int(packets) / max(1, int(last_ts) - int(first_ts))
        if rate > 1000:
            dos.add(str(src))

    for (src, _dst), ports in ports_by_pair.items():
        if len(ports) > 20:
            port_scan.add(src)

    for (src, _dst), first_tss in flows_by_pair.items():
        if len(first_tss) >= 5:
            ordered = sorted(first_tss)
            gaps = [b - a for a, b in zip(ordered, ordered[1:])]
            if gaps and (max(gaps) - min(gaps)) <= 5:
                beaconing.add(src)

    return {
        "protocol_counts": dict(sorted(proto_counts.items())),
        "port_scan_src_ips": sorted(port_scan),
        "dos_src_ips": sorted(dos),
        "beaconing_src_ips": sorted(beaconing),
        "flags": {
            "port_scan": bool(port_scan),
            "dos": bool(dos),
            "beaconing": bool(beaconing),
        },
    }


def main() -> None:
    rows = _build_rows()
    root = Path(__file__).resolve().parent

    csv_path = root / "inputs" / "flows.csv"
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["src_ip", "dst_ip", "dst_port", "proto", "packets", "bytes", "first_ts", "last_ts"])
        writer.writerows(rows)

    truth = _recompute(rows)
    json_path = root / "expected" / "triage.json"
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(truth, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"wrote {csv_path} ({len(rows)} flows)")
    print(f"wrote {json_path}")
    print(json.dumps(truth, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
