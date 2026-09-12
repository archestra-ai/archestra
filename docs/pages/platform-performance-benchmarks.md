---
title: Performance & Latency
category: Archestra Platform
order: 5
description: Reproducible LLM proxy latency measurements with a mock inference upstream
lastUpdated: 2026-09-12
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The LLM proxy benchmark measures client latency against a local mock upstream. It makes no real inference requests. Results cover the OpenAI chat-completions route.

## Local Baseline

The September 12, 2026 run uses backend commit `2973854af23bbcddc5152de071aa9a8653c0059c`. All measured requests return the expected response.

Percentiles pool samples across all three repeats. Throughput uses their combined measured duration. The run completes 37,800 measured requests with zero failures, excluding warmup.

### Complete Non-Streaming Responses

| Workload | Concurrency | Direct P50 ms | Proxy P50 ms | Added P50 ms | Proxy P99 ms | Proxy req/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Chat | 1 | 0.06 | 7.22 | 7.16 | 10.73 | 134.7 |
| Chat | 10 | 0.32 | 25.89 | 25.57 | 37.31 | 381.1 |
| Chat | 50 | 1.56 | 119.62 | 118.07 | 170.70 | 413.0 |
| Tools | 1 | 0.05 | 7.26 | 7.21 | 11.24 | 131.3 |
| Tools | 10 | 0.25 | 25.79 | 25.54 | 40.47 | 379.9 |
| Tools | 50 | 1.45 | 121.91 | 120.46 | 167.04 | 405.3 |

### Streaming First Content

| Concurrency | Direct P50 ms | Proxy P50 ms | Added P50 ms | Proxy P99 ms | Direct Gap P99 ms | Proxy Gap P99 ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 12.64 | 29.91 | 17.27 | 36.70 | 12.43 | 12.94 |
| 10 | 11.88 | 40.33 | 28.45 | 50.99 | 13.05 | 15.46 |
| 50 | 12.75 | 113.87 | 101.12 | 129.54 | 13.06 | 15.84 |

Added P50 is the proxy median minus the direct mock median. It estimates added latency across separate request populations. Proxy P99 uses observed latencies for each table's metric. It is not the P99 of added overhead.

### Environment

| Component | Configuration |
| --- | --- |
| Host | Apple M5 Pro, 18 logical CPUs, 64 GiB RAM |
| Runtime | Node.js 24.19.0, macOS Darwin 25.6, arm64 |
| Backend | One production web process, default info logging, no trace exporter |
| Database | PostgreSQL 17.11 with pgvector, Docker, tmpfs storage, pool size 20 |
| Network | Client, backend, and mock on local loopback; database through Docker |
| Data | Disposable database, default configuration, synthetic requests |
| Authentication | Synthetic provider-key passthrough |

The backend uses the standard request path, including interaction persistence. Streaming persistence can finish after the client receives the response. The run excludes virtual-key validation, configured policy decisions, quarantine inference, and MCP execution.

## Method

Each workload runs at concurrency 1, 10, and 50. Each concurrency has three repeats. Non-streaming blocks contain 1,000 measured requests; streaming blocks contain 100. Each block warms its keep-alive pool with at least 30 requests. At concurrency 50, warmup contains 50 requests.

Direct and proxy blocks alternate order between repeats. Each client starts its next request after the previous response completes. This measures fixed concurrency, not a fixed request arrival rate.

The chat workload returns a fixed JSON completion without artificial delay. The tools workload adds one fictional `benchmark_lookup` function definition. Its response contains no tool call.

Streaming returns 20 content events, each after a requested 10 ms delay. Actual timing depends on timer scheduling. First-content latency excludes role-only and usage events. Content events can contain multiple tokens.

Results include validated responses, failure counts, throughput, and latency percentiles. The runner stops scheduling new requests after a failure. In-flight requests finish before it saves partial results.

## Reproduction

The [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) contains setup instructions and workload options. The [baseline record](https://github.com/archestra-ai/archestra/blob/main/platform/benchmarks/baselines/2026-09-12-local.json) contains per-repeat summaries and environment details.

From a clean worktree's `platform/` directory:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh
```

The launcher builds the backend and creates a disposable database. It removes the stack after measurement. The benchmark workflow also uploads raw samples and logs as CI artifacts.

## Use Case: Evaluating a Runtime Change

A team considers replacing Fastify or rewriting its proxy in Rust. It first measures synthetic chat requests using this benchmark. It then repeats the same workloads with the proposed implementation.

A useful comparison keeps hardware, database, authentication, logging, and security behavior equivalent. Traces can separate database waits from request processing; see [Observability](/docs/platform-observability).

[LiteLLM's Rust launch benchmark](https://docs.litellm.ai/blog/litellm-rust-launch) reports results from a different forwarding harness. Its hardware and request path differ from this baseline. These published numbers do not establish a runtime speed ratio for Archestra.

## Limits

This local run does not measure `frontend.archestra.dev` or production network latency. The client, mock, and backend share host resources. The small database uses memory-backed storage. Results do not establish production capacity or hardware requirements.

Higher concurrency includes queueing in the measured latency. These timings alone do not identify Fastify as the bottleneck. CI uses fewer samples on different hardware; compare its results separately. Streaming tail estimates are based on only 300 requests per target and concurrency.
