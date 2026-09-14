# LLM Proxy Benchmarks

Measure client latency through the real production backend against a deterministic HTTP upstream. The upstream returns synthetic OpenAI chat completions. No inference provider or provider key is required.

## Run Locally

Use a clean worktree with no `platform/.env`. The isolated backend refuses that file and supplies its own environment. Existing development or deployment credentials are not loaded.

Prerequisites: the repository's Node and pnpm versions, Docker with Compose, and Tilt. Run commands from `platform/`:

```bash
pnpm install --frozen-lockfile
# Development: build the backend, migrate a disposable database, start the stack.
tilt up -f benchmarks/Tiltfile --port 10450
```

In another terminal, from the same `platform/` directory:

```bash
node --test benchmarks/measure.test.mjs
bash benchmarks/run-benchmark.sh
```

Keep stack configuration unchanged while measuring. Tilt can rebuild or recreate resources when files change. Stop Tilt, then run `tilt down -f benchmarks/Tiltfile` to remove the stack.

For a single run without file watching, use the same launcher as CI:

```bash
bash benchmarks/ci.sh
```

This builds, migrates, measures, and tears down the disposable stack. It refuses an existing benchmark stack or occupied ports. PostgreSQL uses tmpfs; teardown discards benchmark data. The reserved ports are 15432 (database), 19000 (backend), 19050 (metrics), and 19092 (mock).

## Workloads

| Scenario | Request | Response |
| --- | --- | --- |
| `chat` | Short prompt | Fixed JSON completion, no artificial delay |
| `tools` | Short prompt and one function definition | Same JSON completion; no tool invocation |
| `stream` | Short prompt, streaming enabled | 20 content events with a requested 10 ms delay before each event |

All scenarios use the standard OpenAI chat proxy route and synthetic provider-key passthrough. This exercises the existing backend and its interaction persistence. It does not exercise virtual-key validation, configured security rules, dual-LLM quarantine, or MCP execution. The mock reports zero tokens. A tools definition exercises discovery and metadata handling, not a tool-call policy decision.

Defaults: concurrency 1, 10, and 50; three repeats; 1,000 measured requests per non-streaming block; 100 per streaming block. Each block first warms its own keep-alive connection pool with `max(30, concurrency)` requests. Direct and proxy blocks alternate order between repeats.

```bash
# Short smoke run
node benchmarks/run.mjs --requests=100 --stream-requests=20 --repeats=2 --concurrency=1,10
# Streaming only
node benchmarks/run.mjs --scenarios=stream --stream-requests=500 --warmup=50
```

Additional flags: `--output=path`, `--proxy-url=URL`, and `--mock-url=URL`. URL flags take complete chat-completion endpoint URLs. An alternate deployment must already route this model to the same benchmark mock. The runner validates the direct mock's health marker and every response's exact content. It cannot verify an arbitrary proxy's routing configuration before sending requests. `ARCHESTRA_BENCHMARK_API_KEY` can supply an alternate credential; results never contain its value.

## Measurements

`results.json` contains every measured request, failures, block summaries, environment metadata, and the tested commit. `summary.md` contains comparison tables. Results are ignored by Git. The [recorded local baseline](baselines/2026-09-12-local.json) retains block summaries and environment details without individual samples.

- Total latency ends when the complete validated response arrives.
- First-byte latency starts at request submission and ends at the first response body bytes.
- Streaming first-content latency excludes role-only and usage events.
- Streaming gaps measure decoded content events, including events combined in one network read. They are event-weighted, not token timings.
- P50/P95/P99 use nearest-rank quantiles of successful requests. Failures remain in raw output and counts.
- Throughput is successful requests divided by measured block duration. Warmup is excluded.

The difference between proxy and direct P50 estimates added median latency. These are separate request populations, not paired per-request measurements. Subtracting P99s does not give the P99 of overhead. Local loopback timings include client scheduling, mock processing, backend work, and database access.

The runner stops scheduling after the first measured failure, lets in-flight requests settle, saves partial results, and exits unsuccessfully. Warmup failures also stop the run. This is a closed-loop concurrency sweep, not an arrival-rate test or a production capacity guarantee. Short streaming runs provide limited tail samples.

## CI

The `LLM Proxy Benchmark` workflow runs on benchmark changes and supports manual dispatch. It uses 300 non-streaming and 60 streaming requests per block, two repeats, and concurrency 1, 10, and 50. It uploads raw measurements and stack logs for 14 days and publishes a job summary. Failures fail CI; latency has no absolute threshold on shared runners. Compare equivalent runner types and workload settings.

## Historical GCP Scripts

`setup-gcp-benchmark.sh`, `cleanup-gcp-benchmark.sh`, and `.env.example` describe the older GCP/Apache Bench setup. They are retained for reference and were not used or revalidated for this baseline. The current runner no longer reads `benchmark-config.env`, `NUM_REQUESTS`, or `CONCURRENCY`. The old WireMock fixture does not implement the new runner's health and streaming contracts.
