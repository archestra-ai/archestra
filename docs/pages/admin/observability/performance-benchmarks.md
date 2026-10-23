---
title: Performance & Latency
description: LLM proxy throughput, response latency, and repeatable release benchmarks
order: 5
lastUpdated: 2026-10-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Measure time inside Archestra separately from upstream model calls and client delivery. This benchmark uses the production backend, virtual-key authentication and request persistence with a local mock model.

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>

## Results

The 2026-10-23 local comparison handled 549 chat requests per second with 50 requests in flight and 100% successful responses. These results pool six alternating trials of 1,000 requests on the optimized revision.

| Non-Streaming Chat Latency | P50 | P95 | P99 |
| --- | ---: | ---: | ---: |
| Gateway request latency | 83 ms | 111 ms | 152 ms |
| Gateway overhead | 77 ms | 103 ms | 128 ms |
| Complete client response | 87 ms | 117 ms | 159 ms |

Two longer sequential runs pooled 30,000 proxied chat requests on the optimized revision, measuring 124 ms client P50 and 286 ms P99. Those measurements use a different trial length and remain separate from the alternating results above.

A separate concurrency sweep measured complete chat responses at 21 ms P50 and 36 ms P99 with 10 requests in flight. At concurrency 50, streaming time to first content was 91 ms P50, based on 150 proxy requests; the mock sends 20 content events, spaced 10 ms apart.

## What the Timings Mean

Compare the same metric when evaluating gateway performance.

- **Gateway request latency:** server receipt through response serialization, including authentication, routing, upstream calls and awaited persistence. Client networking and response delivery are outside this window.
- **Gateway overhead:** gateway latency minus that request's upstream SDK-call duration, including transport and decoding. Percentiles come from individual overhead measurements, not subtraction between percentiles.
- **Client latency:** request submission through complete response delivery. Streaming time to first content measures when the client receives its first content event; complete-stream gateway timing is not collected.

<span id="environment"></span>
<span id="method"></span>

## Test Setup

These results come from an Apple M5 Pro with 64 GiB RAM, Node.js 24.21.0 and PostgreSQL 17.11. The paired comparison keeps two production builds resident with separate disposable databases and identical local mocks; one web process receives load at a time. Authentication validates a passthrough virtual key paired with a synthetic provider key; no real inference provider is called.

The test runs OpenAI chat completions, tool definitions and streaming as separate workloads, using a short prompt and an output limit of 32 tokens. It uses fixed concurrency and measures successful responses after warmup. Response caching and configured virtual-key budgets are not enabled.

Compare throughput only when hardware, prompt size, streaming mix, concurrency and enabled features match. The host was shared with development work, and longer sequential runs had wide latency ranges. A local result is not a production capacity guarantee or a sub-50 ms claim at concurrency 50.

## Release Benchmarks

Each platform release PR runs the same mock workloads and updates one comment with throughput, success rate, gateway latency, overhead and client latency. Each measured value includes its percentage increase or decrease against the last published release on that release track, when the setup matches. The comment identifies a first recorded run, missing or failed release data, changed setups and unmeasured values instead of inventing a percentage.

The comment saves compact metrics for future release comparisons; detailed workflow measurements and diagnostics expire after 14 days. Shared-runner timing can vary; failed requests fail the benchmark rather than disappearing from its report.

## Reproduction

Run the benchmark from a clean checkout's `platform/` directory with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=1000 --stream-requests=50 --warmup=20 --repeats=3
```

The launcher creates a disposable database, measures the proxy and removes the stack. See the [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) for workload options and the [recorded comparison](https://github.com/archestra-ai/archestra/blob/main/platform/benchmarks/baselines/2026-10-23-optimization.json) for all trial summaries and the [separate concurrency sweep](https://github.com/archestra-ai/archestra/blob/main/platform/benchmarks/baselines/local-authenticated.json). The README also gives the alternating-build reproduction steps; the command above reproduces the sweep.
