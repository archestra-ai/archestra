---
title: Performance Benchmarks
description: Compare Archestra and LiteLLM latency and requests per second on the same hardware.
order: 9
lastUpdated: 2026-10-27
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json.
Release benchmark CI updates only the marked MCP table. The LLM comparison is
pinned to its published evidence; do not replace it with release measurements.
-->

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>
<span id="results"></span>

## LLM Proxy Results

Archestra handled 851–859 requests per second versus LiteLLM’s 172–175 on the same machine.

| Proxy | Requests per Second | Median Added Latency | P95 Added Latency | P99 Added Latency |
| --- | ---: | ---: | ---: | ---: |
| Archestra | 851.5–859.5 | 58.71 ms | 88.13 ms | 99.44 ms |
| LiteLLM | 172.3–174.5 | 266.18 ms | 331.34 ms | 822.92 ms |

- Each proxy: four logical CPUs, 8 GiB RAM, one worker; 50 concurrent requests with authentication and usage accounting.
- Per proxy: 10,000 non-streaming requests over two repeats after warmup, zero errors. RPS shows the repeat range, not maximum capacity.
- Added latency is client response time minus that request’s mock-provider duration. Archestra awaits log writes; LiteLLM writes asynchronously with default content storage.

[Full methodology and evidence](https://github.com/archestra-ai/archestra/blob/6d7e1a53d34a19984d661f8a68b2c691bad530a3/platform/benchmarks/cross-proxy/evidence/2026-10-26/sensitivity/SENSITIVITY.md): pinned versions, hardware, configuration, streaming results and raw measurements.

## MCP Gateway Results

Tool calls include authentication, access checks and call logging.

<!-- mcp-gateway-benchmark-results:start -->
| Gateway | Requests per Second | Median Added Latency | P95 Added Latency | P99 Added Latency |
| --- | ---: | ---: | ---: | ---: |
| Archestra | 639.2 | 76.34 ms | 78.21 ms | 88.48 ms |

16 vCPU / ~63 GiB RAM; one worker, 50 concurrent calls, 600 measured calls and zero errors.
<!-- mcp-gateway-benchmark-results:end -->

Added latency uses the gateway’s internal timer minus the mock MCP server’s duration. It differs from the LLM comparison’s client timer.

<span id="environment"></span>
<span id="method"></span>
<span id="test-setup"></span>
<span id="automatic-updates"></span>

## Reproduction

Both tests use local mock servers, with no real inference or provider spend.

- LLM comparison: Archestra 1.5.0-rc.10 versus LiteLLM 1.106.4, using LiteLLM’s default content omission. Follow the [pinned harness](https://github.com/archestra-ai/archestra/tree/3a81c912e0adf44cae1f871b1d98a9d8ac9f3a6c/platform/benchmarks/cross-proxy) in clean-database sensitivity mode; select its `archestra` and `litellm-default` results.
- MCP gateway: the table updates with each Archestra release. The [benchmark workflow](https://github.com/archestra-ai/archestra/actions/workflows/llm-proxy-benchmark.yml) retains measurements; the [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) covers local setup.

Run the MCP benchmark from `platform/` with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=300 --stream-requests=300 --repeats=2
```
