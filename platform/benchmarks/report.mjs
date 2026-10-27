import { summarize } from "./measure.mjs";

const names = {
  chat: "HTTP proxy request",
  tools: "HTTP request with tool definition",
  stream: "Streaming HTTP request",
  mcp: "MCP tool call",
};

function hasComparisonSetup(setup) {
  return (
    setup &&
    ["workloadVersion", "node", "os", "arch", "cpu", "auth"].every(
      (key) =>
        typeof setup[key] === "string" &&
        setup[key].length > 0 &&
        setup[key].length <= 256,
    ) &&
    [
      "logicalCpus",
      "memoryGiB",
      "count",
      "streamCount",
      "warmup",
      "repeats",
    ].every((key) => Number.isFinite(setup[key]) && setup[key] > 0) &&
    Array.isArray(setup.concurrencyLevels) &&
    setup.concurrencyLevels.length > 0 &&
    Array.isArray(setup.scenarios) &&
    setup.scenarios.length > 0 &&
    setup.mock?.benchmarkMock === 1
  );
}

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
    ...(report.metadata.diagnostic
      ? { diagnostic: report.metadata.diagnostic }
      : {}),
    gitCommit: report.metadata.gitCommit,
    platformTree: report.metadata.platformTree,
    ...(report.metadata.webWorkers
      ? { webWorkers: report.metadata.webWorkers }
      : {}),
    comparison: {
      workloadVersion: report.metadata.workloadVersion,
      ...(report.metadata.webWorkers
        ? { webWorkers: report.metadata.webWorkers }
        : {}),
      node: report.metadata.node,
      os: report.metadata.os,
      arch: report.metadata.arch,
      cpu: report.metadata.cpu,
      logicalCpus: report.metadata.logicalCpus,
      memoryGiB: Math.round(report.metadata.totalMemoryBytes / 1024 ** 3),
      auth: report.metadata.auth,
      count: report.metadata.count,
      streamCount: report.metadata.streamCount,
      warmup: report.metadata.warmup,
      repeats: report.metadata.repeats,
      concurrencyLevels: report.metadata.concurrencyLevels,
      scenarios: report.metadata.scenarios,
      mock: report.metadata.mock,
    },
    logicalCpus: report.metadata.logicalCpus,
    memoryGiB: report.metadata.totalMemoryBytes / 1024 ** 3,
    repeats: report.metadata.repeats,
    requestsPerBlock: report.metadata.count,
    streamingRequestsPerBlock: report.metadata.streamCount,
    rows,
  };
}

export function renderSummary(summary, baseline = null) {
  if (
    summary.schemaVersion !== 1 ||
    !/^[a-f0-9]{40}$/.test(summary.gitCommit) ||
    typeof summary.complete !== "boolean" ||
    !Array.isArray(summary.rows) ||
    summary.rows.length < 1 ||
    summary.rows.length > Object.keys(names).length
  )
    throw new Error("Invalid benchmark summary");
  const number = (value, digits = 2) => {
    if (value === null) return "—";
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      throw new Error("Invalid benchmark measurement");
    return value.toFixed(digits);
  };
  // Workloads are matched row by row, so adding one keeps the others
  // comparable; a row missing from the baseline is marked new.
  const setupMatches =
    hasComparisonSetup(summary.comparison) &&
    JSON.stringify(withoutScenarios(summary.comparison)) ===
      JSON.stringify(withoutScenarios(baseline?.summary?.comparison));
  // One reason for the whole table, instead of a label in every cell.
  const noComparison = !baseline
    ? null
    : summary.diagnostic
      ? "No release comparison for a diagnostic run."
      : !summary.complete
        ? "No release comparison for an incomplete run."
        : baseline.state !== "available"
          ? baseline.reason
          : !setupMatches
            ? `No release comparison: the benchmark setup differs from \`${baseline.tag}\`.`
            : null;
  const comparing = Boolean(baseline) && !noComparison;
  // Runner metadata is untrusted artifact text; keep it plain.
  const cpu = String(summary.comparison?.cpu ?? "")
    .replace(/[^\w ().@-]/g, "")
    .slice(0, 80);
  const lines = [
    "## LLM Proxy Benchmark",
    "",
    [
      summary.complete
        ? "Completed successfully."
        : "Incomplete benchmark; these are partial results.",
      ...(summary.diagnostic
        ? ["Diagnostic CPU profile: timings include profiler overhead."]
        : []),
      comparing
        ? `Percentages compare with \`${baseline.tag}\`${baseline.sameRunner ? ", measured again on this runner" : ""}; lower latency and higher throughput are better.`
        : (noComparison ?? ""),
    ]
      .filter(Boolean)
      .join(" "),
    "",
    "| Workload | Requests/sec | Success | Gateway ms P50 / P95 / P99 | Overhead ms P50 / P95 / P99 | Client ms P50 / P95 / P99 | First content P50 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of summary.rows) {
    if (!Object.hasOwn(names, row.scenario))
      throw new Error("Invalid benchmark workload");
    const previous = comparing
      ? baseline.summary.rows.find(
          (candidate) =>
            candidate.scenario === row.scenario &&
            candidate.concurrency === row.concurrency,
        )
      : undefined;
    const measurement = (value, prior, digits = 2, unit = "") => {
      const rendered = `${number(value, digits)}${value === null ? "" : unit}`;
      // No change for an unmeasured value, an unmeasured or zero baseline,
      // or a workload the baseline does not have.
      if (value == null || !previous || prior == null) return rendered;
      if (!Number.isFinite(prior) || prior < 0)
        throw new Error("Invalid baseline measurement");
      if (prior === 0) return rendered;
      const delta = (100 * (value - prior)) / prior;
      return `${rendered} (${delta > 0 ? "+" : ""}${delta.toFixed(1)}%)`;
    };
    const percentiles = (value, prior) =>
      value == null
        ? "—"
        : ["p50", "p95", "p99"]
            .map((key) => measurement(value[key], prior?.[key]))
            .join(" / ");
    const workload = `${names[row.scenario]} (c=${number(row.concurrency, 0)}${comparing && !previous ? ", new" : ""})`;
    lines.push(
      `| ${workload} | ${measurement(row.requestsPerSecond, previous?.requestsPerSecond, 1)} | ${measurement(row.successPercent, previous?.successPercent, 2, "%")} | ${percentiles(row.gatewayMs, previous?.gatewayMs)} | ${percentiles(row.overheadMs, previous?.overheadMs)} | ${percentiles({ p50: row.p50Ms, p95: row.p95Ms, p99: row.p99Ms }, previous && { p50: previous.p50Ms, p95: previous.p95Ms, p99: previous.p99Ms })} | ${measurement(row.firstContentP50Ms, previous?.firstContentP50Ms)} |`,
    );
  }
  lines.push(
    "",
    `${cpu ? `${cpu}, ` : ""}${number(summary.logicalCpus, 0)} vCPU / ${number(summary.memoryGiB, 1)} GiB runner · ${summary.webWorkers ?? 1} web process, database pool 20 · mock upstream · ${number(summary.repeats, 0)} repeats of ${number(summary.requestsPerBlock, 0)} requests (${number(summary.streamingRequestsPerBlock, 0)} streaming), warmup excluded. Overhead is gateway time minus the upstream call. [Method](https://archestra.ai/docs/admin/performance-benchmarks)`,
  );
  return `${lines.join("\n")}\n`;
}

function withoutScenarios(setup) {
  const { scenarios: _scenarios, ...rest } = setup ?? {};
  return rest;
}
