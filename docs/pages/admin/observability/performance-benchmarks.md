---
title: Performance & Latency
description: Latency added by the LLM proxy, measured with external HTTP requests
order: 5
lastUpdated: 2026-10-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json.
Release benchmark CI updates only the marked results table. Do not hand-edit
its numbers or add run dates to this page's prose. Tested revisions, dates,
host settings and raw measurements belong in the benchmark artifacts.
-->

See how much latency Archestra adds to an external HTTP request. The benchmark calls the LLM proxy directly using a production backend, virtual-key authentication and request persistence against a local mock provider.

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>

## Results

Added latency is the time spent in Archestra, excluding that request's upstream provider call. The median, P95 and P99 pool successful requests at the stated concurrency after warmup.

<!-- proxy-benchmark-results:start -->
| Runner resources | Concurrent HTTP requests | Median added latency | P95 added latency | P99 added latency |
| --- | ---: | ---: | ---: | ---: |
| 4 vCPU / ~16 GiB RAM | 50 | 150.78 ms | 166.21 ms | 174.88 ms |
<!-- proxy-benchmark-results:end -->

The measurement includes authentication, routing and awaited request persistence. It subtracts the upstream call duration within each request before calculating percentiles; it does not subtract separate percentile values.

<span id="environment"></span>
<span id="method"></span>

## Test Setup

An external HTTP client sends ordinary API requests to an OpenAI-compatible endpoint and receives non-streaming JSON responses. The test uses one production web process, PostgreSQL and a deterministic mock provider on a shared Linux runner with the resources shown in the table. Each request carries a short prompt and an output limit of 32 tokens, authenticated with a passthrough virtual key and a synthetic provider key.

Response caching, configured key budgets and real inference are absent. Shared-runner results track release changes; compare only matching hardware, workloads, concurrency and enabled features. They are not a production capacity guarantee.

## Automatic Updates

Archestra automatically reruns these benchmarks and updates the results with every new release.

## Reproduction

Run from a clean checkout's `platform/` directory with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=300 --stream-requests=60 --repeats=2
```

The launcher creates and removes a disposable database. The [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) describes workload options and timing boundaries; the [benchmark workflow](https://github.com/archestra-ai/archestra/actions/workflows/llm-proxy-benchmark.yml) retains each run's measurements and tested revision.
