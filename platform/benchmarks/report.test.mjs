import assert from "node:assert/strict";
import test from "node:test";
import { createSummary, renderSummary } from "./report.mjs";

const sha = "a".repeat(40);
function report() {
  return {
    metadata: {
      gitCommit: sha,
      scenarios: ["chat"],
      concurrencyLevels: [1, 10],
      repeats: 2,
      count: 2,
      streamCount: 2,
      logicalCpus: 4,
      totalMemoryBytes: 8 * 1024 ** 3,
    },
    blocks: [1, 10].flatMap((concurrency) =>
      [1, 2].flatMap((repeat) =>
        ["direct", "proxy"].map((target) => ({
          scenario: "chat",
          concurrency,
          repeat,
          target,
          attempted: 2,
          succeeded: 2,
          failed: 0,
          elapsedMs: repeat === 1 ? 100 : 900,
          samples: [1, 2].map((i) => ({
            ok: true,
            totalMs: target === "direct" ? i : repeat === 1 ? i * 10 : i * 100,
            firstContentMs: null,
          })),
        })),
      ),
    ),
  };
}

test("release summary pools samples and weights throughput by measured duration", () => {
  const summary = createSummary(report());
  assert.equal(summary.complete, true);
  assert.equal(summary.rows.length, 1);
  const row = summary.rows[0];
  assert.equal(row.concurrency, 10);
  assert.equal(row.p50Ms, 20);
  assert.equal(row.p99Ms, 200);
  assert.equal(row.requestsPerSecond, 4); // Not the average of 20 and 2.22 req/s.
  assert.equal(row.successPercent, 100);
  assert.equal(row.addedMedianMs, 19);
  assert.equal(row.firstContentP50Ms, null);
});

test("a failed or truncated run stays incomplete and includes unsuccessful requests", () => {
  const source = report();
  const last = source.blocks.at(-1);
  last.succeeded = 1;
  last.failed = 1;
  last.samples[1].ok = false;
  const summary = createSummary(source);
  assert.equal(summary.complete, false);
  assert.equal(summary.rows[0].successPercent, 75);
  assert.equal(summary.rows[0].p99Ms, 100);
  assert.match(renderSummary(summary), /Incomplete benchmark/);
  source.blocks.pop();
  assert.equal(createSummary(source).complete, false);
});

test("no completed requests produces no fabricated success or latency", () => {
  const source = report();
  source.blocks = [];
  source.error = "Warmup failed";
  const summary = createSummary(source);
  assert.equal(summary.complete, false);
  assert.equal(summary.rows[0].successPercent, null);
  assert.equal(summary.rows[0].p50Ms, null);
  assert.doesNotMatch(renderSummary(summary), /100\.00%/);
});

test("streaming time to first content remains separate from total response latency", () => {
  const source = report();
  source.metadata.scenarios = ["stream"];
  for (const block of source.blocks) {
    block.scenario = "stream";
    for (const sample of block.samples) sample.firstContentMs = 3;
  }
  const row = createSummary(source).rows[0];
  assert.equal(row.firstContentP50Ms, 3);
  assert.equal(row.p50Ms, 20);
});

test("untrusted artifact strings cannot become a result-table row", () => {
  const summary = createSummary(report());
  summary.rows[0].scenario = "chat | injected";
  assert.throws(() => renderSummary(summary), /Invalid benchmark workload/);
  summary.rows[0].scenario = "chat";
  summary.rows[0].p50Ms = "[link](https://example.com)";
  assert.throws(() => renderSummary(summary), /Invalid benchmark measurement/);
});

test("port offsets isolate a benchmark and reject values that could select unsafe ports", async () => {
  const { benchmarkPorts } = await import("./ports.mjs");
  const original = benchmarkPorts();
  const shifted = benchmarkPorts("400");
  for (const key of Object.keys(original))
    assert.equal(shifted[key] - original[key], 400);
  for (const value of ["-1", "0.5", "10000", "400;exit", "", "Infinity"])
    assert.throws(() => benchmarkPorts(value), /port offset/);
});
