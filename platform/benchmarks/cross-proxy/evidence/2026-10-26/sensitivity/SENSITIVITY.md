# Clean-database / larger-memory sensitivity check

[Successful CI run](https://github.com/archestra-ai/archestra/actions/runs/40407997195) · [Raw artifact](https://github.com/archestra-ai/archestra/actions/runs/40407997195/artifacts/12692532003)

This separate bounded check assessed the primary run’s shared persistent PostgreSQL/tmpfs history and near-limit memory confound. Each profile/repeat received a freshly created database, removed after that run, with PostgreSQL limited to the same 2 CPUs but **8 GiB RAM**. Proxy settings, image pins, model/payload, fixed user, content settings, auth, accounting checks and 200-request warmup stayed unchanged. Two reversed-order repeats measured 5,000 JSON and 1,000 SSE requests each. All **36,000 measured requests succeeded**.

Each matrix used one VM for all its profiles; the sensitivity VM was a separate job, with the same runner class and reported CPU model as the primary job. The smaller sample count, fresh database lifecycle, larger database limit and VM instance change together: do not treat differences between matrices as an isolated causal estimate of memory size. Samples are not pooled with the primary run.

## Results

| Profile | JSON added median / P95 / P99 ms | JSON req/s range | SSE first content median / P95 / P99 ms | SSE added median / P95 / P99 ms | SSE req/s range |
| --- | ---: | ---: | ---: | ---: | ---: |
| Archestra | 58.71 / 88.13 / 99.44 | 851.5–859.5 | 12.24 / 26.66 / 30.45 | 4.10 / 27.90 / 40.93 | 231.9–236.5 |
| LiteLLM, content storage enabled | 290.29 / 380.31 / 843.74 | 158.4–160.1 | 349.82 / 1015.00 / 1080.51 | 419.92 / 1053.34 / 1096.88 | 73.2–73.6 |
| LiteLLM, default content omission | 266.18 / 331.34 / 822.92 | 172.3–174.5 | 326.06 / 410.74 / 1027.51 | 392.58 / 1016.65 / 1083.14 | 76.2–76.4 |

JSON n=10,000 and SSE n=2,000 per profile, all error-free. Metric definitions and remaining feature/durability differences are the same as the [primary report](../RESULTS.md).

## Pressure and throttling evidence

All twelve proxy/database before→after windows showed:

- Zero increments in cgroup memory events, including high/max/oom/oom_kill.
- Zero memory PSI `some` and `full` total-stall increments.
- Zero swap bytes before and after.
- Zero CPU-quota throttled periods and zero throttled microseconds.
- PostgreSQL cgroup lifetime memory peak **540,225,536 bytes (~0.503 GiB)** against 8 GiB, rather than the primary run’s ~1.90 GiB sampled usage against 2 GiB.

CPU scheduling pressure was not zero: the database’s CPU `some` PSI window fraction reached 10.30% during an Archestra window; proxy CPU `some` fractions were at most 0.78%. This is distinct from quota throttling and reflects runnable-task scheduling within these assigned resources. We do not claim the experiment is free of all CPU contention. Snapshots encompass probe/warmup/load/validation windows, not an isolated per-request CPU attribution. Raw snapshots and computed deltas are retained.

## Interpretation

The large **configuration-scoped latency gap persisted with fresh, low-pressure databases and no observed cgroup memory/swap/quota-throttling events**. This argues against the primary run’s near-limit PostgreSQL memory being the sole or dominant explanation for the LiteLLM figures in this experiment. It does not retroactively prove the primary database experienced no pressure.

Archestra’s median changed from 39.76 ms in the primary matrix to 58.71 ms here; LiteLLM content changed 293.78→290.29 ms, and default omission 274.36→266.18 ms. Absolute values and any ratio remain dependent on lifecycle, runtime/configuration and runner conditions. Both matrices match process count (one worker) with four allocated logical CPUs; they do not compare each product’s best tuned four-core deployment or isolate pure gateway implementation cost from different persistence semantics.

## Repeat spread

| Profile | Workload | Repeat | Added median / P95 / P99 ms | req/s |
| --- | --- | ---: | ---: | ---: |
| archestra | JSON | 1 | 59.04 / 88.66 / 99.21 | 851.46 |
| archestra | JSON | 2 | 58.46 / 87.52 / 100.79 | 859.46 |
| archestra | SSE | 1 | 4.80 / 30.76 / 41.21 | 231.92 |
| archestra | SSE | 2 | 3.73 / 22.67 / 40.11 | 236.46 |
| litellm | JSON | 1 | 290.53 / 382.90 / 844.62 | 158.41 |
| litellm | JSON | 2 | 289.66 / 361.29 / 836.66 | 160.10 |
| litellm | SSE | 1 | 422.64 / 1067.50 / 1121.89 | 73.19 |
| litellm | SSE | 2 | 419.18 / 1047.60 / 1089.59 | 73.62 |
| litellm-default | JSON | 1 | 266.59 / 330.36 / 806.96 | 174.54 |
| litellm-default | JSON | 2 | 265.85 / 332.72 / 823.28 | 172.35 |
| litellm-default | SSE | 1 | 391.83 / 1008.04 / 1093.71 | 76.18 |
| litellm-default | SSE | 2 | 393.05 / 1026.17 / 1076.19 | 76.38 |

Measured harness commit `3a81c912e0adf44cae1f871b1d98a9d8ac9f3a6c`; application source and official LiteLLM image unchanged. See `provenance.json`, `summary.json`, `verification.json` and `cgroup-deltas.json`. The final verifier preserves strict primary checks and adds strict sensitivity sample/accounting/limit/cgroup checks.
