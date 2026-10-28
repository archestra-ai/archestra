import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { summarize } from "../measure.mjs";

import { comparisonProfile } from "./profile.mjs";

const profile = comparisonProfile(process.argv[2]);
const dir = profile.output;
// Original archives predate the selected two-profile comparison.
const settings = JSON.parse(
  await readFile(`${dir}/profile.json`).catch(() => "{}"),
);
const targets = settings.targets ?? ["archestra", "litellm", "litellm-default"];
assert.ok(
  JSON.stringify(targets) === JSON.stringify(profile.targets) ||
    JSON.stringify(targets) ===
      JSON.stringify(["archestra", "litellm", "litellm-default"]),
  "Unknown comparison targets",
);
const files = (await readdir(dir)).filter((f) =>
  /^(archestra|litellm|litellm-default)-[1-4]\.json$/.test(f),
);
assert.equal(
  files.length,
  targets.length * profile.repeats,
  "All selected isolated runs must complete",
);
const blocks = (
  await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(`${dir}/${f}`))),
  )
).flatMap((r) => r.blocks);
assert.equal(blocks.length, 2 * targets.length * profile.repeats);
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
for (const target of targets)
  for (const streaming of [false, true]) {
    const runs = blocks.filter(
      (b) => b.target === target && b.streaming === streaming,
    );
    assert.equal(runs.length, profile.repeats);
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
  `Mode ${profile.mode}: ${profile.repeats} fresh process runs per profile, alternating ${targets.join("→")} / ${[...targets].reverse().join("→")}. Each proxy: 4 pinned logical CPUs (2–5), 8 GiB memory, one worker. Database: CPUs 6–7 and ${profile.databaseMemoryGiB} GiB; fresh per run=${profile.freshDatabasePerRun}. Client/mock: CPUs 0–1. Concurrency 50 with HTTP/1.1 keep-alive; ${profile.warmup} warmup per workload, ${profile.requests} chat / ${profile.streamRequests} streaming requests per run. Synthetic 12 input / 20 output tokens, 20 content events at nominal 10 ms cadence.`,
  "",
  "Client added = each client complete-body duration minus its correlated stub request duration (stub receipt through res.end). Includes transport, serialization and gateway processing; differs from internal gateway-only overhead. TTFT here means first decoded content event, not first response byte. No percentile subtraction. Archestra internal timing is retained separately in JSON; no equivalent LiteLLM timer is asserted.",
  "",
  `Virtual-key auth, PostgreSQL token accounting and expected response-content storage validated. ${targets.includes("litellm") ? "LiteLLM uses default asynchronous spend persistence; litellm enables full-content logs while litellm-default retains default content omission" : "LiteLLM retains default content omission and asynchronous spend persistence"}; Archestra retains awaited request persistence. This is a representative authenticated logging comparison with different durability semantics, not strict feature/durability parity. Expected interaction/spend-log rows are checked before each shutdown; aggregate billing queues are not independently asserted drained. No configured budgets or cache; upstream evidence rejects duplicate attempts. No real inference or MCP requests. Throughput is observed closed-loop completion rate at c=50, not a saturation capacity claim; it excludes the later asynchronous persistence drain.`,
  "",
  "Raw per-request samples, per-repeat distributions, resource traces, image inspections, exact commits, runtime versions, accounting checks and run order accompany this summary. See benchmarks/cross-proxy/README.md for reproduction.",
);
await writeFile(`${dir}/summary.md`, lines.join("\n") + "\n");
await writeFile(`${dir}/summary.json`, JSON.stringify(metrics, null, 2));
console.info(lines.join("\n"));
