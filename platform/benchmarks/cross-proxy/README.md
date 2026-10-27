# Controlled Archestra / LiteLLM proxy comparison

[Measured 2026-10-26 results and caveats](evidence/2026-10-26/RESULTS.md).


Run on the existing `ubicloud-standard-16-ubuntu-2404` runner, using the existing
**LLM Proxy Benchmark** workflow's manual `compare_litellm=true` input. This mode
skips the ordinary release benchmark (including MCP). It never updates public
performance docs. No model provider credentials are needed.

```sh
gh workflow run llm-proxy-benchmark.yml --ref YOUR_BRANCH -f compare_litellm=true
```

For direct reproduction on a clean, disposable Ubuntu 24.04 x86_64 host with >=8 logical
CPUs, Docker, the repository's pinned Node/pnpm/Rust toolchain and no `platform/.env`:

```sh
cd platform
pnpm install --frozen-lockfile --ignore-scripts
bash benchmarks/cross-proxy/run.sh
```

The script builds current Archestra production bindings/backend. LiteLLM is the
published database image for v1.106.4, pinned to the amd64 manifest digest. The
release source resolves to ea7ca16dbc3904d9e59a9505f379a2ca3091821f. Each proxy gets
CPUs 2–5, quota 4 CPUs, 8 GiB memory and one worker. The disposable PostgreSQL 17
instance gets CPUs 6–7, quota 2 CPUs and 2 GiB. Client/mock use CPUs 0–1. All profiles
use isolated databases in that same PostgreSQL instance with pool limit
20. Runtime/OS differences are recorded; architectures, CPU allocation, memory,
network path and workload are matched. Containers use host networking and loopback.

Four fresh-process repeats alternate Archestra→LiteLLM and the reverse order.
The selected LiteLLM configuration keeps default prompt/response omission and ordinary
asynchronous spend writes. It was the faster LiteLLM configuration in the recorded
experiment, making it the conservative public comparison. The other proxy is stopped. Database contents persist across repeats
for each product.
Each workload warms 200 requests before 10,000 non-stream or 3,000 streaming
requests, at concurrency 50 with HTTP/1.1 connection reuse. Direct controls run
between proxy runs. The stub emits identical fixed content and synthetic usage
(12 input, 20 output tokens), or 20 content events with a nominal 10 ms cadence.
The request uses `gpt-4o-mini`, a short prompt and `max_tokens=32`; only the
fixed-width correlation marker in the prompt varies (identical request and stub
response byte sizes). OpenAI `user` is constant so correlation does not create
distinct end users or inflate identity/accounting cardinality. The mock validates upstream model/payload semantics.

Client added latency is computed **per request** as full client duration minus
its correlated stub receipt-to-response-end duration. This includes gateway
work, transport and serialization. It is not the internal
`archestra_overhead` timer; Archestra's timer is retained separately and LiteLLM
has no asserted equivalent. Streaming first content measures a decoded content
SSE event, not a role event or first byte. Successful samples use nearest-rank
quantiles. Reports include each repeat and pooled samples. Throughput is observed
closed-loop completion rate, not maximum sustainable rate. Raw errors stop load
and invalidate the complete summary.

Both use virtual-key authentication and PostgreSQL usage accounting, without
configured budgets or response caching. LiteLLM's prompt/response storage is
explicitly disabled (the upstream default). Its
ordinary asynchronous batching remains; Archestra's ordinary awaited persistence
remains. **Durability semantics differ.** Do not describe these as strict parity
or compare client-added measurements with internal gateway-only timings.
Invalid-key denial, exact
response content, usage tokens and eventual persisted row/token/response counts
must pass. Expected rejected-auth audit rows are recorded separately from successful
usage rows. Streaming also checks all 20 decoded content events. Synthetic keys
are scoped to these disposable databases. No live APIs, inference, or MCP calls.

Artifacts under `benchmarks/results/cross-proxy/` include full request samples,
per-repeat and pooled distributions, upstream timings/payloads, direct controls,
resource samples, container limits/image IDs, source commit/tree, dependency
versions, accounting counts, order and diagnostics. The existing workflow uploads
these as `llm-proxy-benchmark` for 14 days. Preserve important results in the PR
before expiration. `summary.md` is generated only after all runs succeed.

Cleanup removes only this script's named temporary containers, database tmpfs and
mock/resource processes, after saving diagnostics. It refuses occupied ports and
existing container names. No persistent infrastructure or credentials are created.

Verify extracted evidence with `python3 benchmarks/cross-proxy/verify.py PATH_TO_EXTRACTED/cross-proxy`.
Preserve or move previous result directories before rerunning locally.

## Database pressure sensitivity mode

`gh workflow run llm-proxy-benchmark.yml --ref YOUR_BRANCH -f compare_litellm=true -f compare_litellm_sensitivity=true` runs a bounded two-repeat matrix with 5,000 JSON / 1,000 SSE measurements per repeat, the same warmup/client/proxy settings, an 8 GiB PostgreSQL limit and a fresh database per profile/run. The driver is capped at 15 minutes. No primary samples are replaced or pooled with this check. Before/after cgroup snapshots include memory events/pressure/peak/swap and CPU throttling/pressure counters. The verifier retains the original strict primary counts and checks separate known sensitivity counts; it writes `verification-recomputed.json`, preserving archived evidence bytes.

## Published comparison

The public page shows only Archestra and LiteLLM with default content omission.
Current runs select these two profiles (`archestra`, `litellm-default`), including
clean-database mode. Historical three-profile raw archives and published numbers
remain unchanged; the reporter and verifier recognize their original profiles
without relaxing sample, accounting, response or resource checks. Reproduce the
published measurements at the pinned commits in the evidence, not a later harness.
