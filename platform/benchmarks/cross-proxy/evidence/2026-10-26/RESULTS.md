# Controlled LLM proxy comparison — 2026-10-26

[Successful CI run](https://github.com/archestra-ai/archestra/actions/runs/40402009733) · [Raw GitHub artifact](https://github.com/archestra-ai/archestra/actions/runs/40402009733/artifacts/12691596491) · [Pinned harness](https://github.com/archestra-ai/archestra/tree/d026094df64fb4fb1027ff8579b067388f8b9d8b/platform/benchmarks/cross-proxy)

This is a measured comparison of these configurations, not a public marketing or capacity claim. All 156,000 measured requests completed successfully. Earlier diagnostic attempts are excluded.

## Headline: non-streaming, concurrency 50

The closest shared metric to the public performance row is **client-added latency**: each full client response duration minus that same request’s stub receipt-to-response-end duration. It includes transport, SDK scheduling and serialization. It is not the docs’ internal gateway-only timer. Percentiles below pool 40,000 successful requests per profile; no separate percentile subtraction is used.

| Proxy configuration | Median added ms | P95 added ms | P99 added ms | Observed req/s, repeat range | Errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| Archestra | 39.76 | 65.61 | 87.29 | 994.1–1230.8 | 0 / 40,000 |
| LiteLLM, content storage enabled | 293.78 | 385.32 | 838.38 | 155.3–159.0 | 0 / 40,000 |
| LiteLLM, default content omission | 274.36 | 342.93 | 805.53 | 167.1–170.8 | 0 / 40,000 |

## Separate timing boundaries

| Proxy configuration | JSON client E2E P50 / P95 / P99 ms | Streaming first content P50 / P95 / P99 ms | Streaming client-added P50 / P95 / P99 ms | Streaming req/s range |
| --- | ---: | ---: | ---: | ---: |
| Archestra | 39.79 / 65.65 / 87.43 | 11.34 / 15.58 / 28.74 | 2.78 / 8.97 / 30.97 | 237.2–240.2 |
| LiteLLM, content storage enabled | 293.83 / 385.36 / 838.41 | 348.37 / 959.20 / 1045.26 | 420.46 / 1032.08 / 1110.83 | 71.5–73.4 |
| LiteLLM, default content omission | 274.40 / 342.95 / 805.55 | 330.94 / 971.64 / 1056.89 | 392.88 / 1013.39 / 1087.70 | 74.7–78.1 |

Archestra’s separate internal gateway overhead was **22.625 / 46.523 / 64.601 ms** (median / P95 / P99). LiteLLM has no asserted equivalent timer here; do not compare this value with LiteLLM client-added latency or derive a ratio between them.

Streaming first content (TTFT) means the first decoded nonempty content SSE event, excluding role-only, usage and comment events. There are 12,000 streaming samples per profile, all successful. The stub emits 20 content events at nominal 10 ms intervals. Per-request stub-adjusted TTFT and full client response durations are retained in `summary.json` and raw samples.

## Matched conditions and provenance

- One `ubicloud-standard-16-ubuntu-2404` VM for the entire matrix: 16 logical CPUs, approximately 62.8 GiB RAM, reported AMD Ryzen 9 7950X3D, Linux amd64. Each proxy: **4 pinned logical CPUs (2–5), 8 GiB limit, one worker**. PostgreSQL: CPUs 6–7, 2 GiB limit, disposable tmpfs, separate databases for each profile. Client/stub: CPUs 0–1. These are pinned CPU sets, not an exclusive-host reservation.
- Archestra package `1.5.0-rc.10`, application source base `f53d5db5a65e3c324939d1fb8455c32bb4f52d59`; measured harness commit `d026094df64fb4fb1027ff8579b067388f8b9d8b`. Production backend build / `NODE_ENV=production`, Node `v24.22.1`. NAPI bindings use the existing benchmark launcher’s optimized `release-fast` profile, not the published release image.
- LiteLLM `v1.106.4`, official database image source label `ea7ca16dbc3904d9e59a9505f379a2ca3091821f`, amd64 manifest `sha256:496cc6cb0295414585790b86467566fb4c93d8e12d7f0e889f18fcfc54cbdd5e`. Installed dependency versions and image inspections accompany the raw artifact.
- PostgreSQL image `pgvector/pgvector:pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f`. All application database pools explicitly limited to 20; LiteLLM startup logs confirm the effective setting.
- Four fresh-process repeats per profile. Order A→L→LD, LD→L→A, A→L→LD, LD→L→A; inactive proxies stopped. Separate databases retain accumulated records across repeats. Each repeat warms 200 requests per workload, then measures 10,000 JSON and 3,000 SSE requests. Fixed concurrency 50; HTTP/1.1 keep-alive and 50 client sockets.
- Identical model mapping `gpt-4o-mini`, short prompt, `max_tokens=32`, synthetic usage 12 input + 20 output tokens. OpenAI `user` is constant (`benchmark-user`); fixed-width timing correlation is embedded in the prompt, avoiding artificial end-user-accounting cardinality. Stub response bodies are exactly **358 bytes JSON / 5,714 bytes SSE** across profiles. No inference provider spend, real provider credentials, or MCP requests.

## Feature differences and practical limits

- Archestra uses its ordinary passthrough virtual key, request/response storage and awaited interaction persistence. LiteLLM uses generated virtual keys and ordinary asynchronous spend logging. Its content-storage profile explicitly enables `store_prompts_in_spend_logs`; the other profile retains default content omission. Both retain token/spend accounting. No configured budgets or response cache. **This is not strict durability or feature parity.**
- Each profile’s response content and nonzero token usage were checked before measurement; persisted token/response counts were checked after every repeat. LiteLLM’s legacy `messages` column is intentionally empty for chat in this version; its request-body storage uses `proxy_server_request` ([pinned implementation](https://github.com/BerriAI/litellm/blob/ea7ca16dbc3904d9e59a9505f379a2ca3091821f/litellm/proxy/spend_tracking/spend_tracking_utils.py#L1583)). The SQL assertions directly verify token fields and response content, not prompt-body retention. Default-content omission correctly yields zero stored response markers.
- All 53,604 successful interactions/spend-log rows per profile (including warmups/probes) were verified. Each LiteLLM database also has the four deliberately rejected authentication probes as failed audit rows; these are excluded from measured error rates. Expected request records are persisted before shutdown; all background aggregate billing queues are not independently asserted drained.
- Rates are observed closed-loop completions at concurrency 50 and exclude later asynchronous persistence draining. They are not maximum sustainable capacity or multiworker tuning results. Do not extrapolate these numbers to other releases, real inference, network/storage systems or production workloads.
- LiteLLM emitted spend-queue aggregation warnings (57–72 per repeat with content storage, 67–74 with default omission); no LiteLLM request traceback/error was logged. Its single-worker CPU/runtime behavior remains part of these default accounting configurations; no tuning was applied to suppress those warnings.
- Resource samples show no proxy/database OOM. Peak sampled container memory across the whole process lifetime: Archestra ~1.52 GiB, LiteLLM content ~0.85 GiB, LiteLLM default ~0.80 GiB; PostgreSQL reached ~1.90 GiB of its 2 GiB limit as tmpfs data accumulated. Repeat medians are reported below rather than hiding the first-run difference. Direct JSON controls sustained 14,504–16,822 req/s with client median 2.62–3.03 ms, substantially above tested proxy completion rates. VM neighbors and kernel scheduling are not controlled.

## Checks on the large difference

- Container commands and environments contain no debug/verbose flags; all eight LiteLLM repeat logs contain zero DEBUG lines and zero tracebacks. Ordinary Uvicorn INFO access logging remains enabled. Archestra retains its ordinary production logging behavior; log pipelines are not forced identical.
- The complete stub observation contains exactly 321,624 unique request IDs for the expected probes, warmups, measured requests and direct controls, with one upstream attempt per ID. No retries occurred. LiteLLM is configured for zero SDK retries; Archestra retains its ordinary SDK retry policy, which was not exercised by successful fixture responses.
- The same client runs 50 independent async loops with a keep-alive agent allowing 50 sockets. No mutex, serial client loop or imposed request-rate delay is present. Product-internal scheduling remains part of the measurement. Direct controls provide substantial client/mock throughput headroom.
- Both pool settings are 20; all LiteLLM startup logs explicitly report effective pool 20. Both storage configurations are measured separately. No budget, cache, guardrail callback, or external logging callback was added to LiteLLM. The full-content flag is the sole intentional difference between its two configurations.
- Peak sampled container CPU was 135.69% for Archestra, 125.35% for LiteLLM content, 127.95% for LiteLLM default and 103.75% for PostgreSQL (100% = one logical CPU). Proxy quotas were 400% and the database quota 200%; this gives no evidence of sustained CPU-quota saturation. Exact cgroup throttling-event and swap counters were not captured, so zero throttling cannot be asserted. PostgreSQL's high sampled memory usage is retained as a limit on interpretation.
- One worker can bottleneck on its event loop/interpreter/native dependencies despite four allocated CPUs. This experiment matches the existing headline's one-process configuration; it does not compare each product's best tuned four-worker capacity. No supported accounting defaults were disabled to improve performance, and the spend-queue warnings remain in the evidence.

## Database lifecycle sensitivity

The primary instance retained separate profile databases across repeats, accumulating tmpfs data to about 95% of its 2 GiB limit. Docker stats alone cannot establish whether that was cache or pressure. A [completed bounded sensitivity check](sensitivity/SENSITIVITY.md) used fresh per-profile/run databases, an equal 8 GiB database limit, two repeats and direct cgroup memory/PSI/swap/quota counters.

Its JSON added medians were **58.71 ms Archestra / 290.29 ms LiteLLM content / 266.18 ms LiteLLM default**, with all 36,000 measured requests successful. PostgreSQL cgroup peak stayed below 0.51 GiB; memory-event and memory-PSI deltas, swap, CPU throttled periods and throttled time were zero in every before/after window. CPU scheduling pressure remained (database CPU `some` PSI up to 10.30%), separate from quota throttling.

The gap persisted under fresh low-pressure database conditions, so near-limit database memory does not appear to be the sole or dominant explanation for the observed LiteLLM figures. Archestra’s absolute median changed materially, and lifecycle, sample counts and VM instance also changed; do not pool these datasets or call the original result a fully isolated causal estimate of implementation cost. Both remain one-worker, process-count-matched configuration comparisons with different logging/durability semantics.

## Repeat spread

Each row reports one complete measured block; JSON n=10,000, SSE n=3,000.

| Profile | Workload | Repeat | Added P50 / P95 / P99 ms | req/s | Duration s |
| --- | --- | ---: | ---: | ---: | ---: |
| archestra | JSON | 1 | 44.26 / 79.83 / 102.67 | 994.11 | 10.06 |
| archestra | JSON | 2 | 38.80 / 57.31 / 71.54 | 1225.06 | 8.16 |
| archestra | JSON | 3 | 38.52 / 56.40 / 71.34 | 1230.80 | 8.12 |
| archestra | JSON | 4 | 38.88 / 56.24 / 71.11 | 1224.54 | 8.17 |
| archestra | SSE | 1 | 3.11 / 14.01 / 30.97 | 238.95 | 12.55 |
| archestra | SSE | 2 | 2.52 / 7.77 / 29.17 | 240.20 | 12.49 |
| archestra | SSE | 3 | 2.82 / 7.55 / 29.84 | 237.21 | 12.65 |
| archestra | SSE | 4 | 2.71 / 7.58 / 32.67 | 237.99 | 12.61 |
| litellm | JSON | 1 | 296.63 / 394.77 / 829.88 | 155.32 | 64.38 |
| litellm | JSON | 2 | 294.10 / 385.52 / 834.79 | 155.32 | 64.38 |
| litellm | JSON | 3 | 295.19 / 385.03 / 841.09 | 156.08 | 64.07 |
| litellm | JSON | 4 | 287.52 / 381.98 / 845.66 | 158.98 | 62.90 |
| litellm | SSE | 1 | 422.31 / 1012.31 / 1105.92 | 72.73 | 41.25 |
| litellm | SSE | 2 | 418.05 / 1019.29 / 1107.83 | 72.75 | 41.24 |
| litellm | SSE | 3 | 411.36 / 1051.85 / 1109.62 | 73.35 | 40.90 |
| litellm | SSE | 4 | 430.32 / 1053.53 / 1125.45 | 71.49 | 41.97 |
| litellm-default | JSON | 1 | 276.46 / 346.36 / 805.68 | 167.06 | 59.86 |
| litellm-default | JSON | 2 | 272.44 / 338.51 / 829.40 | 170.51 | 58.65 |
| litellm-default | JSON | 3 | 276.12 / 342.79 / 799.19 | 168.91 | 59.20 |
| litellm-default | JSON | 4 | 271.35 / 347.78 / 800.18 | 170.82 | 58.54 |
| litellm-default | SSE | 1 | 401.18 / 1031.32 / 1104.13 | 75.55 | 39.71 |
| litellm-default | SSE | 2 | 380.63 / 1011.89 / 1056.37 | 78.10 | 38.41 |
| litellm-default | SSE | 3 | 403.33 / 1012.97 / 1077.62 | 74.66 | 40.18 |
| litellm-default | SSE | 4 | 389.59 / 1000.70 / 1087.36 | 76.38 | 39.28 |

## Reproduce and verify

See [the harness README](../../README.md) for the existing workflow dispatch and clean Ubuntu reproduction commands. Retrieve the raw artifact and run:

```sh
python3 benchmarks/cross-proxy/verify.py PATH_TO_EXTRACTED/cross-proxy
```

The verifier checks sample counts, byte sizes, identity/correlation, token totals, stored response markers, effective limits, OOM state and resource coverage. `summary.json`, `verification.json` and `provenance.json` here retain compact evidence; raw samples, client controls, complete upstream observations, resource traces, logs and image inspections are in the linked artifact. GitHub artifact expiry is 2026-11-09; a separate local compressed archive and checksums preserve the evidence beyond that retention window.

Local archive `controlled-proxy-40402009733.tar.gz`: 60,923,023 bytes; SHA-256 `8d239dc5d413352511bcbc16f6fc5dcef6eca10f1f0ff136a86f66c5e769f5aa`. The checked-in `RAW-SHA256SUMS` applies to the archived raw filenames, rather than whitespace-formatted compact JSON copies.
