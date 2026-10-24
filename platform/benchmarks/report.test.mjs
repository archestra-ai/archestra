import assert from "node:assert/strict";
import test from "node:test";
import { createSummary, renderSummary } from "./report.mjs";

const sha = "a".repeat(40);
function report() {
  return {
    metadata: {
      gitCommit: sha,
      workloadVersion: "test-v1",
      node: "v24.21.0",
      os: "Linux",
      arch: "x64",
      cpu: "Test CPU",
      auth: "passthrough-virtual-key",
      warmup: 30,
      mock: { benchmarkMock: 1, chunks: 20, intervalMs: 10 },
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
            gatewayTiming:
              target === "proxy"
                ? {
                    gatewayMs: i * 9,
                    upstreamMs: i === 1 ? 8 : 1,
                    overheadMs: i === 1 ? 1 : 17,
                  }
                : null,
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
  assert.equal(row.gatewayMs.p50, 9);
  assert.equal(row.overheadMs.p50, 1); // Not gateway P50 - upstream P50 (8).
  assert.equal(row.overheadMs.p99, 17);
  assert.match(renderSummary(summary), /HTTP proxy request \(c=10\)/);
  assert.doesNotMatch(renderSummary(summary), /Chat|chat block/);
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

test("CPU profiling stays labeled diagnostic and cannot report release deltas", () => {
  const source = report();
  source.metadata.diagnostic = "cpu-profile";
  const summary = createSummary(source);
  assert.equal(summary.complete, true);
  assert.equal(summary.diagnostic, "cpu-profile");
  const rendered = renderSummary(summary, comparison(summary));
  assert.match(rendered, /timings include profiler overhead/);
  assert.match(rendered, /N\/A: setup changed/);
  assert.doesNotMatch(rendered, /\(0\.0%\)/);
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

test("successful non-streaming responses without gateway timing cannot produce a complete report", () => {
  const source = report();
  source.blocks.find((b) => b.target === "proxy").samples[0].gatewayTiming =
    null;
  assert.equal(createSummary(source).complete, false);
});

test("streaming time to first content remains separate from total response latency", () => {
  const source = report();
  source.metadata.scenarios = ["stream"];
  for (const block of source.blocks) {
    block.scenario = "stream";
    for (const sample of block.samples) {
      sample.firstContentMs = 3;
      sample.gatewayTiming = null;
    }
  }
  const row = createSummary(source).rows[0];
  assert.equal(row.firstContentP50Ms, 3);
  assert.equal(row.p50Ms, 20);
  assert.equal(row.gatewayMs, null);
  assert.equal(row.overheadMs, null);
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

function comparison(summary) {
  return {
    state: "available",
    tag: "platform-v1.0.0",
    summary: structuredClone(summary),
  };
}

test("each metric reports first-run and missing-baseline states", () => {
  const summary = createSummary(report());
  const first = renderSummary(summary, {
    state: "first-run",
    reason: "First release benchmark.",
  });
  assert.match(first, /4.0 \(first run\)/);
  assert.match(first, /20.00 \(first run\)/);
  const missing = renderSummary(summary, {
    state: "missing",
    reason: "Previous metrics expired.",
  });
  assert.match(missing, /4.0 \(N\/A: baseline missing\)/);
  assert.match(missing, /Previous metrics expired/);
});

test("zero, absent and newly added metrics never fabricate percentages", () => {
  const summary = createSummary(report());
  const baseline = comparison(summary);
  baseline.summary.rows[0].requestsPerSecond = 0;
  baseline.summary.rows[0].gatewayMs.p50 = 0;
  summary.rows[0].gatewayMs.p50 = 0;
  baseline.summary.rows[0].overheadMs = null;
  let rendered = renderSummary(summary, baseline);
  assert.match(rendered, /4.0 \(N\/A: baseline zero\)/);
  assert.match(rendered, /0.00 \(0.0%\)/);
  assert.match(rendered, /1.00 \(N\/A: unmeasured baseline\)/);
  baseline.summary.rows = [];
  rendered = renderSummary(summary, baseline);
  assert.match(rendered, /4.0 \(N\/A: new workload\)/);
  assert.doesNotMatch(rendered, /Infinity|NaN/);
});

test("changed or missing setup and incomplete runs suppress comparisons", () => {
  const summary = createSummary(report());
  const baseline = comparison(summary);
  baseline.summary.comparison.auth = "synthetic-provider-key";
  assert.match(renderSummary(summary, baseline), /N\/A: setup changed/);
  delete baseline.summary.comparison;
  assert.match(renderSummary(summary, baseline), /N\/A: setup changed/);
  summary.complete = false;
  assert.match(renderSummary(summary, baseline), /N\/A: incomplete run/);
});

test("streaming first content gets its own release delta while server timing stays unmeasured", () => {
  const summary = createSummary(report());
  summary.rows[0].scenario = "stream";
  summary.rows[0].firstContentP50Ms = 10;
  summary.rows[0].gatewayMs = null;
  summary.rows[0].overheadMs = null;
  const baseline = comparison(summary);
  baseline.summary.rows[0].firstContentP50Ms = 20;
  assert.match(renderSummary(summary, baseline), /10.00 \(-50.0%\)/);
  assert.match(renderSummary(summary, baseline), /— \(unmeasured\)/);
});
