# LLM Proxy and MCP Gateway Benchmarks

Measure gateway latency, gateway overhead and client latency through the real production backend against a deterministic HTTP upstream. The upstream returns synthetic OpenAI chat completions and serves a one-tool MCP server at `/mcp`. No inference provider, provider key or real MCP server is required.

## Run Locally

Use a clean worktree with no `platform/.env`. The isolated backend refuses that file and supplies its own environment. Existing development or deployment credentials are not loaded.

Prerequisites: the repository's Node, pnpm and Rust versions, Docker with Compose, and Tilt. Run commands from `platform/`:

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

This builds, migrates, measures, and tears down the disposable stack. It refuses an existing benchmark stack or occupied ports. PostgreSQL uses tmpfs; teardown discards benchmark data. The default ports are 15432 (database), 19000 (backend), 19050 (metrics), and 19092 (mock). If they are occupied, use `bash benchmarks/ci.sh --port-offset=400` to shift all four ports and use a separate Compose project. The launcher never takes over an existing stack.

## Workloads

| Scenario | Request | Response |
| --- | --- | --- |
| `chat` | Short prompt | Fixed JSON completion, no artificial delay |
| `tools` | Short prompt and one function definition | Same JSON completion; no tool invocation |
| `stream` | Short prompt, streaming enabled | 20 content events with a requested 10 ms delay before each event |
| `mcp` | Stateless JSON-RPC `tools/call` through the MCP gateway | The mock tool's fixed text result |

The `chat`, `tools` and `stream` scenarios use the standard OpenAI chat proxy route. The isolated launcher signs in through the public API and creates a disposable passthrough virtual key, paired with a synthetic provider key. This exercises the existing backend and its interaction persistence. It exercises virtual-key validation but does not configure spend limits, security rules or MCP execution. The mock reports zero tokens. A tools definition exercises discovery and metadata handling, not a tool-call policy decision.

The `mcp` scenario calls `/v1/mcp/<gateway>` with a user token. The launcher creates a remote catalog entry for the mock's MCP server, installs it, assigns its tool to a new MCP gateway and reads the admin's user token. Each call authenticates, resolves and authorizes the tool, calls the mock over HTTP and persists the call log; the direct target is the mock's `/mcp` endpoint. It runs whenever `--mcp-url` and `--mcp-tool` are given, which `ci.sh` always does, and `ARCHESTRA_BENCHMARK_MCP_TOKEN` supplies the token.

Defaults: concurrency 1, 10, and 50; three repeats; 1,000 measured requests per non-streaming block; 100 per streaming block. Each block first warms its own keep-alive connection pool with `max(30, concurrency)` requests. Direct and proxy blocks alternate order between repeats.

```bash
# Short smoke run
node benchmarks/run.mjs --requests=100 --stream-requests=20 --repeats=2 --concurrency=1,10
# Streaming only
node benchmarks/run.mjs --scenarios=stream --stream-requests=500 --warmup=50
```

Additional flags: `--output=path`, `--proxy-url=URL`, and `--mock-url=URL`. URL flags take complete chat-completion endpoint URLs. An alternate deployment must already route this model to the same benchmark mock. The runner validates the direct mock's health marker and every response's exact content. It cannot verify an arbitrary proxy's routing configuration before sending requests. `ARCHESTRA_BENCHMARK_API_KEY` can supply an alternate bearer credential; `ARCHESTRA_BENCHMARK_VIRTUAL_KEY` supplies a passthrough virtual key when required. Credentials are sent only to the proxy, never the direct mock, and their values are excluded from results.

## Measurements

`results.json` contains every measured request, failures, block summaries, environment metadata, and the tested commit. `summary.md` contains a compact per-workload report at the highest tested concurrency. `report.json` is its machine-readable form; `details.md` retains every concurrency and repeat. Percentiles pool successful request samples across repeats; throughput divides their combined success count by combined measured duration. Results are ignored by Git. The [recorded local baseline](baselines/local-authenticated.json) retains block summaries and environment details without individual samples.

- Total latency ends when the complete validated response arrives.
- Gateway latency starts in the server's first request hook, before authentication and body parsing, and ends in `onSend`, after response serialization and before socket delivery. The MCP gateway writes its own response, so its window ends when the response head is written. It includes upstream time, authentication, routing, policy checks and persistence awaited before replying. It excludes client connection/upload time before the hook and socket delivery after it.
- Upstream duration times each awaited non-streaming provider SDK call, including transport and decoding. For an MCP tool call it times the call to the MCP server; waiting for a free slot on that server's connection remains gateway overhead. Gateway overhead is gateway latency minus that request's upstream durations. Retry backoff between calls remains gateway overhead. Background work after responding is outside this window. Overlapping calls deliberately omit timing rather than summing concurrent wall time.
- The non-streaming proxy returns these three durations in `Server-Timing` (`archestra_gateway`, `archestra_upstream`, `archestra_overhead`, in milliseconds). The runner requires complete, consistent timing on every successful non-streaming proxy response. Missing timing fails the run; it never becomes zero. P50/P95/P99 pool individual durations, not differences between percentiles.
- First-byte latency starts at request submission and ends at the first response body bytes.
- Streaming first-content latency excludes role-only and usage events.
- Streaming gaps measure decoded content events, including events combined in one network read. They are event-weighted, not token timings.
- P50/P95/P99 use nearest-rank quantiles of successful requests. Failures remain in raw output and counts.
- Throughput is successful requests divided by measured block duration. Warmup is excluded.

Streaming reports client time to first content and complete-response latency separately. Its headers precede stream completion, so it does not advertise complete gateway latency or overhead. Response timing for streaming is unmeasured, shown as `—` in the summary. Do not compare that row with a mixed streaming/non-streaming server-latency distribution.

The direct/mock P50 difference remains a diagnostic estimate in `details.md`, not the gateway-overhead metric. These are separate request populations. Local client timings include client scheduling, loopback transport, mock processing, backend work, and database access. Workloads use a short prompt (request bytes are recorded), `max_tokens: 32`, and separate chat/tool-definition/streaming blocks, not a mixed-traffic capacity test. Match those settings, auth, persistence, cache/budget settings, and timing boundaries before comparing deployments.

The runner stops scheduling after the first measured failure, lets in-flight requests settle, saves partial results, and exits unsuccessfully. Warmup failures also stop the run. This is a closed-loop concurrency sweep, not an arrival-rate test or a production capacity guarantee. Short streaming runs provide limited tail samples.

## CI

The `LLM Proxy Benchmark` workflow runs on benchmark changes, platform Release Please PR updates, and manual dispatch, on a 16 vCPU Ubicloud runner so the load client, mock and database do not compete with the measured web process. Ubicloud may place a run on either of its CPU models; each report records the model. It uses 300 requests per block for every workload, two repeats, and concurrency 1, 10, and 50. Streaming needs the same block size: a block of barely more than 50 concurrent streams starts nearly all of them in the same instant, so it measures that burst rather than steady streaming. It uploads raw measurements and stack logs for 14 days and publishes a job summary. Failures fail CI; latency has no absolute threshold on shared runners.

Release PRs get one sticky summary comment. When workload and host metadata match, each measured value shows its signed percentage change from the previous platform release: the newest release in the base branch's history, or on a `release/X.Y` branch its previous `X.Y` stable release. After measuring the release PR, the job checks out that previous release and runs its own `ci.sh` on the same runner (`benchmarks/remeasure-release.sh`), so both sides share hardware. If that run fails or does not match the release's commit, the publisher falls back to the compact metrics saved in the previous release PR's bot comment, checked against the revision they were measured on; those compare only when the CPU model matches. Manual runs can exercise the same step with `release_sha`. When no comparison is possible (first run, missing or failed record, changed setup) the comment says why once, above the table. Missing latest-release data never falls back silently to an older release.

A successful current-head release benchmark commits the marked MCP results table in `docs/pages/admin/performance-benchmarks.md`, including throughput, added latency, runner resources and sample counts. The Archestra–LiteLLM comparison is separately pinned and is not replaced by Archestra-only release measurements. Detailed gateway, upstream and client timings remain in the report and release comment. The writer runs trusted base-branch code, validates the source tree, targets only the same-repository Release Please bot's branch, and refuses non-fast-forward updates. Failed, partial or stale runs preserve the existing table. The GitHub App token already used for release screenshots lets the generated commit trigger ordinary PR validation.

Generated benchmark-table commits skip another load test and suppress a follow-up screenshot commit; this prevents volatile timings and screenshots from creating a commit loop. Later docs-only commits can retain a release's measured record only when ancestry and the released platform tree still match; source, workflow and configuration changes invalidate it. The measured SHA stays unchanged in the saved record. Run dates and detailed host settings belong in that record and its artifacts, not hand-maintained page prose.

The required Docs Link Check waits for a successful saved benchmark and verifies that the generated MCP table matches it before a platform release PR can enter the merge queue. Generated table and screenshot commits can follow that measurement; changes to execution inputs require another benchmark. A missing record, failed benchmark or unpublished table keeps the release blocked instead of allowing the queue to lock its branch before codegen finishes.

For an optimization comparison on one CI runner, manually run this workflow at the candidate revision with `baseline_sha` set to a full baseline commit SHA. It runs the ordinary release benchmark, then six alternating baseline/candidate trials per non-streaming workload at concurrency 50, with 1,000 measured requests per trial. Both production builds stay resident with separate disposable databases; only one receives proxy load at a time. Native-code, shared-code, build configuration and table-schema trees must match. Each revision installs its own pinned JavaScript dependencies without install scripts and migrates its own disposable database from its pinned source, so dependency patches and stored-function changes remain attributable. Raw results record both lockfile, workspace-configuration, patch, migration and table-schema tree hashes, plus the installed append-function hash and PostgreSQL version. Paired results and direct-mock controls are retained separately from the ordinary single-build release result. Manual runs do not publish release comments or docs commits.

For CPU diagnosis on that runner, manually select `cpu_profile` without `baseline_sha`. Locally, use `bash benchmarks/ci.sh --cpu-profile`. This starts the same production backend with Node's V8 CPU profiler, saves `results/profile/backend.cpuprofile` on graceful shutdown, and keeps diagnostic request measurements under `results/profile/`. The disposable database also enables `pg_stat_statements`; its query counts and execution times are saved after resetting seed/setup statistics. CPU profiling includes startup and shutdown. Timings include profiler overhead and cannot update release comments or docs. Always confirm improvements with an unprofiled benchmark.

For a manual scaling study, select `web_workers=4`. The candidate uses four real web processes behind one shared HTTP port, with five database connections per process (20 total). The paired baseline still uses one process with 20 connections. Both run within the same runner; process count is an explicit configuration difference, not an implementation-only comparison. All workers must finish initialization before load begins. Release runs keep the default single process. Locally, pass `--web-workers=4` to `ci.sh`, then `4` as the second argument to `compare.sh`.

## Historical GCP Scripts

`setup-gcp-benchmark.sh`, `cleanup-gcp-benchmark.sh`, and `.env.example` describe the older GCP/Apache Bench setup. They are retained for reference and were not used or revalidated for this baseline. The current runner no longer reads `benchmark-config.env`, `NUM_REQUESTS`, or `CONCURRENCY`. The old WireMock fixture does not implement the new runner's health and streaming contracts.

## Recorded Optimization Comparison

[2026-10-23-ci-followup.json](baselines/2026-10-23-ci-followup.json) records the final additional optimization pass after integrating the same `main` changes into both revisions. It retains all six alternating trials, direct controls, pooled results, raw-file digests and both single-build CI runs. The baseline already includes the earlier optimizations below. The public docs table uses the later single-build run; paired results have two builds resident and remain separate.

[2026-10-23-optimization.json](baselines/2026-10-23-optimization.json) records all final trial summaries, environment details, source revisions and SHA-256 digests of the per-request raw files. It includes the slower sequential runs; none were discarded. The individual request samples remain local diagnostic artifacts, following the existing summary-only baseline convention.

Baseline: `795f52fcd90fccf94c9ca210d5a8fdaa42c8c3d5`. Optimized backend: `cfe85dca1f464d825f24cff73d5369f9ff46c45f`. The benchmark harness is identical at both revisions.

The long confirmation runs used `--scenarios=chat,tools --concurrency=50 --requests=5000 --warmup=200 --repeats=3`, alternating complete baseline/optimized runs twice. The separate sweep used `--requests=1000 --stream-requests=50 --warmup=20 --repeats=3`.

For the paired check, build each revision in this isolated worktree, copy its complete `backend/dist` to `benchmarks/results/artifacts/baseline-final-dist` or `optimized-final-dist`, and save its `git rev-parse HEAD` output as `source-commit.txt` inside that directory. Link each copy’s `node_modules` to `backend/node_modules`; the native workspace packages and dependencies must already be built with the pinned lockfile. Return to the optimization branch and run:

```bash
node benchmarks/baselines/2026-10-23-interleaved.mjs
```

The saved runner refuses occupied ports or existing Compose projects, starts two separate disposable databases and identical mocks, alternates six 1,000-request blocks per workload and variant at concurrency 50, then removes its own stack. Only one variant receives proxy load at a time; both remain resident. This protocol reduces drift between long sequential runs and does not represent one production replica’s resource footprint.
