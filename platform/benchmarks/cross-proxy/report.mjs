import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { summarize } from "../measure.mjs";

const dir = "benchmarks/results/cross-proxy";
const files = (await readdir(dir)).filter((f) =>
  /^(archestra|litellm|litellm-default)-[1-4]\.json$/.test(f),
);
assert.equal(files.length, 12, "All twelve isolated runs must complete");
const blocks = (
  await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(`${dir}/${f}`))),
  )
).flatMap((r) => r.blocks);
assert.equal(blocks.length, 24);
for (const b of blocks) {
  assert.equal(b.errors, 0);
  assert.equal(b.samples.length, b.count);
  assert.ok(b.samples.every((s) => s.ok && Number.isFinite(s.clientAddedMs)));
}
const metrics = [];
const lines = [
  "# Controlled LLM proxy comparison",
  "",
  "| Proxy | Workload | Client added P50 / P95 / P99 ms | Client E2E P50 / P95 / P99 ms | First content P50 / P95 / P99 ms | req/s range | errors |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];
const fmt = (s) =>
  s ? [s.p50, s.p95, s.p99].map((n) => n.toFixed(2)).join(" / ") : "—";
for (const target of ["archestra", "litellm", "litellm-default"])
  for (const streaming of [false, true]) {
    const runs = blocks.filter(
      (b) => b.target === target && b.streaming === streaming,
    );
    assert.equal(runs.length, 4);
    const samples = runs.flatMap((b) => b.samples);
    const result = {
      target,
      streaming,
      samples: samples.length,
      errors: runs.reduce((s, b) => s + b.errors, 0),
      clientAddedMs: summarize(samples.map((s) => s.clientAddedMs)),
      totalMs: summarize(samples.map((s) => s.totalMs)),
      firstContentMs: streaming
        ? summarize(samples.map((s) => s.firstContentMs))
        : null,
      firstContentAddedMs: streaming
        ? summarize(samples.map((s) => s.firstContentAddedMs))
        : null,
      gatewayOverheadMs:
        !streaming && target === "archestra"
          ? summarize(samples.map((s) => s.gatewayTiming.overheadMs))
          : null,
      repeats: runs.map(({ samples, ...b }) => b),
    };
    metrics.push(result);
    const rates = runs.map((b) => b.requestsPerSecond);
    lines.push(
      `| ${target} | ${streaming ? "stream" : "chat"} | ${fmt(result.clientAddedMs)} | ${fmt(result.totalMs)} | ${fmt(result.firstContentMs)} | ${Math.min(...rates).toFixed(1)}–${Math.max(...rates).toFixed(1)} | ${result.errors}/${samples.length} |`,
    );
  }
lines.push(
  "",
  "Four fresh process runs each, alternating A→L→LD / LD→L→A (L: full-content logs; LD: default content omission). Each proxy: 4 pinned logical CPUs (2–5), 8 GiB memory limit, one web worker; database: CPUs 6–7 and 2 GiB; client and mock: CPUs 0–1. 50 concurrent HTTP/1.1 keep-alive requests, 200 warmup per workload per run. 10,000 chat and 3,000 streaming requests per run. Stream: 20 content events at nominal 10 ms intervals, nonzero synthetic 12 input + 20 output tokens.",
  "",
  "Client added = each client complete-body duration minus its correlated stub request duration (stub receipt through res.end). Includes transport, serialization and gateway processing; differs from the existing docs’ internal gateway-only overhead. TTFT here means first decoded content event, not first response byte. No percentile subtraction. Archestra internal timing is retained separately in JSON; no equivalent LiteLLM timer is asserted.",
  "",
  "Virtual-key auth, PostgreSQL token accounting and stored response content validated. LiteLLM uses default asynchronous spend persistence; litellm enables full-content logs while litellm-default retains default content omission; Archestra retains awaited request persistence. This is a representative authenticated logging comparison with different durability semantics, not strict feature/durability parity. Persistence is drained and checked before each shutdown. No configured budgets or cache; upstream evidence rejects duplicate attempts. No real inference or MCP requests. Throughput is observed closed-loop completion rate at c=50, not a saturation capacity claim; it excludes the later asynchronous persistence drain.",
  "",
  "Raw per-request samples, per-repeat distributions, resource traces, image inspections, exact commits, runtime versions, accounting checks and run order accompany this summary. See benchmarks/cross-proxy/README.md for reproduction.",
);
await writeFile(`${dir}/summary.md`, lines.join("\n") + "\n");
await writeFile(`${dir}/summary.json`, JSON.stringify(metrics, null, 2));
console.info(lines.join("\n"));
