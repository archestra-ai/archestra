---
title: Performance Benchmarks
description: Compare Archestra and LiteLLM latency and requests per second on the same hardware.
order: 10
lastUpdated: 2026-11-21
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json.
Release benchmark CI updates only the marked MCP table. The LLM comparison is
pinned to its published evidence; do not replace it with release measurements.
-->

<span id="local-baseline"></span>
<span id="complete-non-streaming-responses"></span>
<span id="streaming-first-content"></span>
<span id="results"></span>

## LLM Proxy Results

Archestra handled 279–287 requests per second versus LiteLLM’s 86–87 on the same machine.

| Proxy | Requests per Second | Median Added Latency | P95 Added Latency | P99 Added Latency |
| --- | ---: | ---: | ---: | ---: |
| Archestra | 279.3–286.5 | 169.24 ms | 258.42 ms | 321.36 ms |
| LiteLLM | 86.4–86.5 | 555.37 ms | 645.94 ms | 1173.05 ms |

- Each proxy: four logical CPUs of an AMD EPYC 7763, 8 GiB RAM, one worker; 50 concurrent requests with authentication and usage accounting.
- Per proxy: 10,000 non-streaming requests over two repeats after warmup, zero errors. RPS shows the repeat range, not maximum capacity.
- Added latency is client response time minus that request’s mock-provider duration. Archestra awaits log writes; LiteLLM writes asynchronously with default content storage.

[Full methodology and evidence](https://github.com/archestra-ai/archestra/blob/main/platform/benchmarks/cross-proxy/evidence/2026-11-21/sensitivity/SENSITIVITY.md): pinned versions, hardware, configuration, streaming results and raw measurements.

## MCP Gateway Results

Tool calls include authentication, access checks and call logging.

<!-- mcp-gateway-benchmark-results:start -->
| Gateway | Requests per Second | Median Added Latency | P95 Added Latency | P99 Added Latency |
| --- | ---: | ---: | ---: | ---: |
| Archestra | 263.2 | 175.92 ms | 242.97 ms | 285.70 ms |

Archestra 1.5.0-rc.44 on 4 logical CPUs, 8 GiB RAM; one worker, 50 concurrent calls, 600 measured calls and zero errors.
<!-- mcp-gateway-benchmark-results:end -->

Added latency uses the gateway’s internal timer minus the mock MCP server’s duration. It differs from the LLM comparison’s client timer.

<span id="environment"></span>
<span id="method"></span>
<span id="test-setup"></span>
<span id="automatic-updates"></span>

## Reproduction

Both tests use local mock servers, with no real inference or provider spend.

- LLM comparison: Archestra versus LiteLLM 1.106.4, using LiteLLM’s default content omission. Follow the [pinned harness](https://github.com/archestra-ai/archestra/tree/130fd487625ab1054f8954e6854684e09b9cc216/platform/benchmarks/cross-proxy) in clean-database sensitivity mode; select its `archestra` and `litellm-default` results.
- MCP gateway: the table updates with each Archestra release. The [benchmark workflow](https://github.com/archestra-ai/archestra/actions/workflows/llm-proxy-benchmark.yml) retains measurements; the [benchmark README](https://github.com/archestra-ai/archestra/tree/main/platform/benchmarks) covers local setup.

Run the MCP benchmark from `platform/` with Node.js, pnpm, Rust and Docker installed:

```bash
pnpm install --frozen-lockfile
bash benchmarks/ci.sh --requests=300 --stream-requests=300 --repeats=2
```
