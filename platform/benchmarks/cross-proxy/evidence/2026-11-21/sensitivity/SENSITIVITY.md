# Clean-database comparison, 2026-11-21

[CI run](https://github.com/archestra-ai/archestra/actions/runs/44938071529) · [Raw artifact](https://github.com/archestra-ai/archestra/actions/runs/44938071529/artifacts/14721001555) (expires 2026-12-05; checksums of every raw file are in `RAW-SHA256SUMS`)

Archestra 1.5.0-rc.42 with pull request #11106 (commit `130fd487625ab1054f8954e6854684e09b9cc216`) against LiteLLM 1.106.4 with its default content omission, in the harness's clean-database sensitivity mode:

- Each proxy: 4 logical CPUs, 8 GiB RAM, one worker. PostgreSQL: 2 CPUs, 8 GiB RAM, a fresh database for each profile and repeat.
- 50 concurrent requests, 200-request warmup, then two repeats of 5,000 JSON and 1,000 SSE requests each, in reversed order.
- GitHub `ubuntu-24.04-16core` runner, AMD EPYC 7763. The October run used a faster AMD Ryzen 9 7950X3D, so absolute numbers between the two runs are not comparable. Compare the proxies within one run.

All 24,000 measured requests succeeded, and `verify.py` passed with its strict sample, accounting, limit and cgroup checks.

## Results

| Profile | JSON added median / P95 / P99 ms | JSON req/s range | SSE first content median / P95 / P99 ms | SSE added median / P95 / P99 ms | SSE req/s range |
| --- | ---: | ---: | ---: | ---: | ---: |
| Archestra | 169.24 / 258.42 / 321.36 | 279.3–286.5 | 20.73 / 58.13 / 69.30 | 40.96 / 139.72 / 181.47 | 185.1–192.0 |
| LiteLLM, default content omission | 555.37 / 645.94 / 1173.05 | 86.4–86.5 | 849.03 / 1520.64 / 1660.53 | 1038.12 / 1745.01 / 1801.78 | 37.9–38.3 |

JSON n=10,000 and SSE n=2,000 per profile. Metric definitions are the same as the [October report](../../2026-10-26/RESULTS.md).

## Pressure and Throttling

All eight proxy and database before→after windows showed:

- Zero memory events, zero memory pressure stalls and zero swap.
- Zero CPU-quota throttled periods.
- A PostgreSQL lifetime memory peak of 524,283,904 bytes (~0.49 GiB) against 8 GiB.

The highest CPU `some` pressure fraction in any window was 8.3%. That is runnable-task scheduling pressure within the assigned CPUs, not quota throttling. PostgreSQL used 16.4–16.7 CPU seconds per Archestra run and 2.8–2.9 per LiteLLM run (`cgroup-deltas.json`).

## Repeat Spread

| Profile | Workload | Repeat | Added median / P95 / P99 ms | req/s |
| --- | --- | ---: | ---: | ---: |
| archestra | JSON | 1 | 168.69 / 253.85 / 320.97 | 286.53 |
| archestra | JSON | 2 | 170.11 / 262.43 / 321.36 | 279.35 |
| archestra | SSE | 1 | 46.91 / 144.09 / 181.47 | 185.09 |
| archestra | SSE | 2 | 34.95 / 134.34 / 181.14 | 192.02 |
| litellm-default | JSON | 1 | 558.74 / 645.82 / 1184.82 | 86.39 |
| litellm-default | JSON | 2 | 554.12 / 649.21 / 1170.19 | 86.55 |
| litellm-default | SSE | 1 | 1026.39 / 1763.21 / 1811.32 | 38.32 |
| litellm-default | SSE | 2 | 1046.37 / 1741.69 / 1788.87 | 37.89 |

See `provenance.json`, `summary.json`, `verification.json` and `cgroup-deltas.json`.
