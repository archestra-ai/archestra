---
title: Performance & Latency
description: LLM proxy throughput, response latency, and repeatable release benchmarks
order: 5
lastUpdated: 2026-10-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json.
Release benchmark CI updates only the marked results table. Do not hand-edit
its numbers or add run dates to this page's prose. Tested revisions, dates,
host settings and raw measurements belong in the release PR comment/artifact.
-->

Measure time inside Archestra separately from upstream model calls and client delivery. These results use the production backend, virtual-key authentication and request persistence against a local mock model.

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>

## Results

Release Please PRs regenerate this table from successful CI measurements. Each workload runs separately; its row pools measured requests at the highest tested concurrency.

<!-- proxy-benchmark-results:start -->
| Workload | Requests/sec | Success | Gateway ms P50 / P95 / P99 | Overhead ms P50 / P95 / P99 | Client ms P50 / P95 / P99 | First content P50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chat (c=50) | 322.3 | 100.00% | 141.80 / 154.27 / 158.68 | 129.35 / 141.45 / 146.67 | 153.21 / 165.59 / 169.56 | — |
| Tool definition (c=50) | 311.5 | 100.00% | 147.03 / 161.55 / 165.34 | 135.02 / 147.82 / 151.28 | 159.45 / 173.67 / 176.04 | — |
| Streaming (c=50) | 99.9 | 100.00% | — | — | 355.57 / 366.90 / 367.65 | 138.64 |
<!-- proxy-benchmark-results:end -->

Gateway latency spans server receipt through response serialization, including authentication and awaited persistence. Gateway overhead subtracts each request's upstream SDK-call duration before calculating percentiles. Client latency ends after complete body delivery; streaming reports time to first content, with complete-stream gateway timing unmeasured (`—`).

<span id="environment"></span>
<span id="method"></span>

## Test Setup

The benchmark uses one production web process, PostgreSQL and a deterministic OpenAI chat mock on a shared Linux CI runner. Authentication validates a passthrough virtual key paired with a synthetic provider key. Requests use a short prompt and an output limit of 32 tokens; tool definitions execute no tools, and streaming emits 20 content events 10 ms apart.

Response caching, configured key budgets and real inference are absent. Shared-runner results track release changes; compare only matching hardware, workloads, concurrency and enabled features. They are not a production capacity guarantee.

## Release Benchmarks

Each platform release PR runs the benchmark and updates one comment with every measured value's percentage change against the last published release on the same track. First runs, missing or failed release data, changed setups and unmeasured values are labeled explicitly.

A successful current-head run commits only the table above to the release PR. Failed, partial or superseded runs preserve the existing docs table. The comment retains compact metrics for future comparisons; detailed measurements and diagnostics remain in workflow artifacts for 14 days.

## Reproduction

Run from a clean checkout's `platform/` directory with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=300 --stream-requests=60 --repeats=2
```

The launcher creates and removes a disposable database. The [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) describes workload options and timing boundaries; the [benchmark workflow](https://github.com/archestra-ai/archestra/actions/workflows/llm-proxy-benchmark.yml) retains each run's measurements and tested revision.
