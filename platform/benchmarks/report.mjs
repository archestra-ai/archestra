import { summarize } from "./measure.mjs";

const names = {
  chat: "Chat",
  tools: "Tool definition",
  stream: "Streaming",
};

export function createSummary(report) {
  const rows = [];
  for (const scenario of report.metadata.scenarios) {
    const concurrency = Math.max(...report.metadata.concurrencyLevels);
    const blocks = report.blocks.filter(
      (b) => b.scenario === scenario && b.concurrency === concurrency,
    );
    const proxy = blocks.filter((b) => b.target === "proxy");
    const direct = blocks.filter((b) => b.target === "direct");
    const samples = proxy.flatMap((b) => b.samples).filter((s) => s.ok);
    const directSamples = direct.flatMap((b) => b.samples).filter((s) => s.ok);
    const attempted = proxy.reduce((n, b) => n + b.attempted, 0);
    const succeeded = proxy.reduce((n, b) => n + b.succeeded, 0);
    const elapsedMs = proxy.reduce((n, b) => n + b.elapsedMs, 0);
    const latency = summarize(samples.map((s) => s.totalMs));
    const directLatency = summarize(directSamples.map((s) => s.totalMs));
    rows.push({
      scenario,
      concurrency,
      attempted,
      succeeded,
      requestsPerSecond: elapsedMs ? succeeded / (elapsedMs / 1000) : null,
      successPercent: attempted ? (100 * succeeded) / attempted : null,
      p50Ms: latency?.p50 ?? null,
      p95Ms: latency?.p95 ?? null,
      p99Ms: latency?.p99 ?? null,
      addedMedianMs:
        latency && directLatency ? latency.p50 - directLatency.p50 : null,
      gatewayMs: summarize(
        samples.map((s) => s.gatewayTiming?.gatewayMs).filter((v) => v != null),
      ),
      upstreamMs: summarize(
        samples
          .map((s) => s.gatewayTiming?.upstreamMs)
          .filter((v) => v != null),
      ),
      overheadMs: summarize(
        samples
          .map((s) => s.gatewayTiming?.overheadMs)
          .filter((v) => v != null),
      ),
      firstContentP50Ms:
        summarize(
          samples.map((s) => s.firstContentMs).filter((v) => v !== null),
        )?.p50 ?? null,
    });
  }
  const expectedBlocks =
    report.metadata.scenarios.length *
    report.metadata.concurrencyLevels.length *
    report.metadata.repeats *
    2;
  const complete =
    !report.error &&
    report.blocks.length === expectedBlocks &&
    report.blocks.every(
      (b) =>
        b.failed === 0 &&
        (b.target !== "proxy" ||
          b.scenario === "stream" ||
          b.samples.every((s) => s.gatewayTiming != null)) &&
        b.attempted ===
          (b.scenario === "stream"
            ? report.metadata.streamCount
            : report.metadata.count),
    );
  return {
    schemaVersion: 1,
    complete,
    gitCommit: report.metadata.gitCommit,
    logicalCpus: report.metadata.logicalCpus,
    memoryGiB: report.metadata.totalMemoryBytes / 1024 ** 3,
    repeats: report.metadata.repeats,
    requestsPerBlock: report.metadata.count,
    streamingRequestsPerBlock: report.metadata.streamCount,
    rows,
  };
}

export function renderSummary(summary) {
  if (
    summary.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(summary.gitCommit) ||
    typeof summary.complete !== "boolean" ||
    !Array.isArray(summary.rows) ||
    summary.rows.length < 1 ||
    summary.rows.length > 3
  )
    throw new Error("Invalid benchmark summary");
  const number = (value, digits = 2) => {
    if (value === null) return "—";
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid benchmark measurement");
    return value.toFixed(digits);
  };
  const lines = [
    "## LLM Proxy Benchmark",
    "",
    summary.complete
      ? "Completed successfully."
      : "Incomplete benchmark; these are partial results.",
    "",
    "| Workload | Requests/sec | Success | Gateway ms P50 / P95 / P99 | Overhead ms P50 / P95 / P99 | Client ms P50 / P95 / P99 | First content P50 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of summary.rows) {
    if (!Object.hasOwn(names, row.scenario))
      throw new Error("Invalid benchmark workload");
    const percentiles = (value) =>
      value == null
        ? "—"
        : [value.p50, value.p95, value.p99].map((v) => number(v)).join(" / ");
    lines.push(
      `| ${names[row.scenario]} (c=${number(row.concurrency, 0)}) | ${number(row.requestsPerSecond, 1)} | ${row.successPercent === null ? "—" : `${number(row.successPercent)}%`} | ${percentiles(row.gatewayMs)} | ${percentiles(row.overheadMs)} | ${percentiles({ p50: row.p50Ms, p95: row.p95Ms, p99: row.p99Ms })} | ${number(row.firstContentP50Ms)} |`,
    );
  }
  lines.push(
    "",
    `One production web process; PostgreSQL; local mock upstream. Host: ${number(summary.logicalCpus, 0)} logical CPUs, ${number(summary.memoryGiB, 1)} GiB RAM.`,
    `Each row pools ${number(summary.repeats, 0)} repeats at the highest tested concurrency; ${number(summary.requestsPerBlock, 0)} requests per chat block and ${number(summary.streamingRequestsPerBlock, 0)} per streaming block. Warmup is excluded.`,
    "Gateway latency measures server request receipt through response serialization, before socket delivery. Overhead subtracts each request's upstream SDK-call duration before calculating percentiles; it includes authentication, routing, policies and persistence. Client latency ends at the complete response body. Streaming reports client latency and first content only (— means unmeasured).",
    "The isolated launcher validates a passthrough virtual key and persists requests; no real inference requests. Workloads run separately, with a short prompt and max_tokens=32; streaming uses 20 content events, 10 ms apart. Response caching and configured key budgets are not enabled.",
    "Shared-runner measurements track release changes; they are not a production capacity rating. Compare the same hardware, workload, concurrency, authentication and logging settings.",
  );
  return `${lines.join("\n")}\n`;
}
