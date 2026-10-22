---
title: Performance & Latency
description: LLM proxy throughput, response latency, and repeatable release benchmarks
order: 5
lastUpdated: 2026-10-22
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Measure time inside Archestra separately from upstream model calls and client delivery. This benchmark uses the production backend, virtual-key authentication and request persistence with a local mock model.

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>

## Results

The reference local run handled 143 chat requests per second with 50 requests in flight and 100% successful responses.

| Non-Streaming Chat Latency | P50 | P95 | P99 |
| --- | ---: | ---: | ---: |
| Gateway request latency | 333 ms | 396 ms | 407 ms |
| Gateway overhead | 316 ms | 378 ms | 394 ms |
| Complete client response | 342 ms | 406 ms | 417 ms |

Streaming time to first content was 445 ms at P50, measured separately. The mock sends 20 content events, spaced 10 ms apart.

## What the Timings Mean

Compare the same metric when evaluating gateway performance.

- **Gateway request latency:** server receipt through response serialization, including authentication, routing, upstream calls and awaited persistence. Client networking and response delivery are outside this window.
- **Gateway overhead:** gateway latency minus that request's upstream SDK-call duration, including transport and decoding. Percentiles come from individual overhead measurements, not subtraction between percentiles.
- **Client latency:** request submission through complete response delivery. Streaming time to first content measures when the client receives its first content event; complete-stream gateway timing is not collected.

<span id="environment"></span>
<span id="method"></span>

## Test Setup

These results come from one production web process on an Apple M5 Pro with 64 GiB RAM, Node.js 24 and PostgreSQL 17. The client, proxy and mock run locally. Authentication validates a passthrough virtual key paired with a synthetic provider key; no real inference provider is called.

The test runs OpenAI chat completions, tool definitions and streaming as separate workloads, using a short prompt and an output limit of 32 tokens. It uses fixed concurrency and measures successful responses after warmup. Response caching and configured virtual-key budgets are not enabled.

Compare throughput only when hardware, prompt size, streaming mix, concurrency and enabled features match. A local result is not a production capacity guarantee.

## Release Benchmarks

Each platform release PR runs the same mock workloads and updates one comment with throughput, success rate, gateway latency, overhead and client latency. The linked workflow retains the detailed measurements and diagnostics for 14 days.

Use those results to compare release candidates on the same runner configuration. Shared-runner timing can vary; failed requests fail the benchmark rather than disappearing from its report.

## Reproduction

Run the benchmark from a clean checkout's `platform/` directory with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=300 --stream-requests=60 --repeats=2
```

The launcher creates a disposable database, measures the proxy and removes the stack. See the [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) for workload options and the [reference measurements](https://github.com/archestra-ai/archestra/blob/main/platform/benchmarks/baselines/local-authenticated.json) for the local results above.
