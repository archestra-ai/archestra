---
title: Performance & Latency
description: LLM proxy throughput, response latency, and repeatable release benchmarks
order: 5
lastUpdated: 2026-10-22
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra's LLM proxy benchmark separates gateway performance from model inference. It sends requests through the production backend to a local mock model, with request persistence enabled.

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>

## Results

The reference local run handled 128 chat requests per second with 50 requests in flight.

| Metric | Result |
| --- | ---: |
| Successful requests | 100% |
| Chat requests per second | 128 |
| Complete response latency, P50 | 371 ms |
| Complete response latency, P99 | 492 ms |
| Streaming first content, P50 | 309 ms |

Streaming first content is measured separately from complete responses. The mock sends 20 content events, spaced 10 ms apart.

<span id="environment"></span>
<span id="method"></span>

## Test Setup

These results come from one production web process on an Apple M5 Pro with 64 GiB RAM, Node.js 24 and PostgreSQL 17. The client, proxy and mock run locally. Authentication validates a passthrough virtual key, paired with a synthetic provider key. No real inference provider is called.

The test covers OpenAI chat completions, with and without a tool definition, plus streaming. It uses fixed concurrency and measures successful responses after warmup. It does not measure model generation time or virtual-key budget enforcement.

Compare throughput only when hardware, prompt size, streaming mix, concurrency and enabled features match. A local result is not a production capacity guarantee.

## Release Benchmarks

Each platform release PR runs the same mock workloads and updates one benchmark comment with throughput, success rate and latency. The linked workflow retains the detailed measurements and diagnostics for 14 days.

Use those results to compare release candidates on the same runner configuration. Shared-runner timing can vary; failed requests fail the benchmark rather than disappearing from its report.

## Reproduction

Run the benchmark from a clean checkout's `platform/` directory with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=300 --stream-requests=60 --repeats=2
```

The launcher creates a disposable database, measures the proxy and removes the stack. See the [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) for workload options and the [reference measurements](https://github.com/archestra-ai/archestra/blob/main/platform/benchmarks/baselines/local-authenticated.json) for the local results above.
