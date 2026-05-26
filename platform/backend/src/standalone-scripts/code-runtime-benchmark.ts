import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { RunCodeParams, RunCodeResult } from "@/code-runtime/types";
import logger from "@/logging";

type BenchmarkWorkloadName = "trivial" | "warmed-imports" | "requirements";

type BenchmarkOutcome =
  | "ok"
  | "script_error"
  | "timeout"
  | "capacity_error"
  | "runtime_error"
  | "validation_error";

interface CodeRuntimeBenchmarkOptions {
  readonly runs: number;
  readonly warmupRuns: number;
  readonly timeoutSeconds: number;
  readonly concurrency: readonly number[];
  readonly workloads: readonly BenchmarkWorkloadName[];
  readonly requirements: readonly string[];
}

type CodeRuntimeBenchmarkParseResult =
  | { readonly kind: "help" }
  | {
      readonly kind: "run";
      readonly options: CodeRuntimeBenchmarkOptions;
    };

interface BenchmarkRunSample {
  readonly outcome: BenchmarkOutcome;
  readonly durationMs: number;
  readonly exitCode?: number;
  readonly errorMessage?: string;
}

interface LatencyStats {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly average: number;
}

interface BenchmarkScenarioSummary {
  readonly workload: BenchmarkWorkloadName;
  readonly concurrency: number;
  readonly requestedRuns: number;
  readonly wallMs: number;
  readonly throughputPerSecond: number;
  readonly okThroughputPerSecond: number;
  readonly outcomes: Record<BenchmarkOutcome, number>;
  readonly latencyMs: LatencyStats | null;
  readonly okLatencyMs: LatencyStats | null;
}

interface CodeRuntimeBenchmarkReport {
  readonly initDurationMs: number;
  readonly scenarios: readonly BenchmarkScenarioSummary[];
}

const DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS = {
  runs: 100,
  warmupRuns: 5,
  timeoutSeconds: 30,
  concurrency: [1, 5, 10, 25, 50, 100],
  workloads: ["trivial"],
  requirements: ["requests"],
} satisfies CodeRuntimeBenchmarkOptions;

const CODE_RUNTIME_BENCHMARK_HELP = `Usage: pnpm --filter @backend code-runtime:bench -- [options]

Runs a direct CodeRuntimeService benchmark with unique Python code per run.

Options:
  --runs <count>              measured runs per scenario (default: 100)
  --warmup <count>            excluded warmup runs per scenario (default: 5)
  --timeout <seconds>         per-run timeout passed to the runtime (default: 30)
  --concurrency <csv>         concurrency levels (default: 1,5,10,25,50,100)
  --workload <csv|all>        trivial, warmed-imports, requirements, or all (default: trivial)
  --requirements <csv>        requirements for the requirements workload (default: requests)
  --requirement <value>       add one requirement; repeatable
  --help                      show this help

Examples:
  pnpm --filter @backend code-runtime:bench -- --runs 500 --concurrency 1,10,50
  pnpm --filter @backend code-runtime:bench -- --workload all --runs 100 --warmup 10
`;

function parseCodeRuntimeBenchmarkArgs(
  args: readonly string[],
): CodeRuntimeBenchmarkParseResult {
  const options: {
    runs: number;
    warmupRuns: number;
    timeoutSeconds: number;
    concurrency: number[];
    workloads: BenchmarkWorkloadName[];
    requirements: string[];
  } = {
    runs: DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS.runs,
    warmupRuns: DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS.warmupRuns,
    timeoutSeconds: DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS.timeoutSeconds,
    concurrency: [...DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS.concurrency],
    workloads: [...DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS.workloads],
    requirements: [...DEFAULT_CODE_RUNTIME_BENCHMARK_OPTIONS.requirements],
  };

  let index = 0;
  while (index < args.length) {
    const parsed = splitOption(args[index]);
    switch (parsed.name) {
      case "--":
        index += 1;
        break;
      case "--help":
      case "-h":
        return { kind: "help" };
      case "--runs": {
        const value = readOptionValue({ args, index, option: parsed });
        options.runs = parsePositiveInteger(value.value, parsed.name);
        index = value.nextIndex;
        break;
      }
      case "--warmup": {
        const value = readOptionValue({ args, index, option: parsed });
        options.warmupRuns = parseNonNegativeInteger(value.value, parsed.name);
        index = value.nextIndex;
        break;
      }
      case "--timeout": {
        const value = readOptionValue({ args, index, option: parsed });
        options.timeoutSeconds = parsePositiveInteger(value.value, parsed.name);
        index = value.nextIndex;
        break;
      }
      case "--concurrency": {
        const value = readOptionValue({ args, index, option: parsed });
        options.concurrency = parsePositiveIntegerList(
          value.value,
          parsed.name,
        );
        index = value.nextIndex;
        break;
      }
      case "--workload": {
        const value = readOptionValue({ args, index, option: parsed });
        options.workloads = parseWorkloadList(value.value);
        index = value.nextIndex;
        break;
      }
      case "--requirements": {
        const value = readOptionValue({ args, index, option: parsed });
        options.requirements = parseRequirementList(value.value, parsed.name);
        index = value.nextIndex;
        break;
      }
      case "--requirement": {
        const value = readOptionValue({ args, index, option: parsed });
        options.requirements.push(parseRequirement(value.value, parsed.name));
        index = value.nextIndex;
        break;
      }
      default:
        throw new Error(`unknown argument: ${parsed.name}`);
    }
  }

  return { kind: "run", options };
}

async function runCodeRuntimeBenchmark(
  options: CodeRuntimeBenchmarkOptions,
): Promise<CodeRuntimeBenchmarkReport> {
  applyBenchmarkEnvDefaults();
  const service = await loadCodeRuntimeService();

  try {
    if (!service.isEnabled) {
      throw new Error(
        "code runtime is disabled; set ARCHESTRA_CODE_RUNTIME_ENABLED=true or omit it when running this benchmark",
      );
    }

    const initStartedAt = performance.now();
    await service.init();
    const initDurationMs = roundMs(performance.now() - initStartedAt);

    if (!service.isReady) {
      throw new Error("code runtime did not become ready");
    }

    logger.info(
      { initDurationMs, options },
      "[CodeRuntimeBench] initialized runtime",
    );

    const scenarios: BenchmarkScenarioSummary[] = [];
    for (const workload of options.workloads) {
      for (const concurrency of options.concurrency) {
        scenarios.push(
          await runScenario({ service, options, workload, concurrency }),
        );
      }
    }

    return { initDurationMs, scenarios };
  } finally {
    await service.shutdown();
  }
}

function buildBenchmarkPythonCode({
  workload,
  nonce,
}: {
  readonly workload: BenchmarkWorkloadName;
  readonly nonce: string;
}): string {
  const encodedNonce = JSON.stringify(nonce);
  switch (workload) {
    case "trivial":
      return `nonce = ${encodedNonce}\nprint(nonce)\n`;
    case "warmed-imports":
      return [
        "import httpx",
        "import numpy",
        "import pandas",
        `nonce = ${encodedNonce}`,
        "print(nonce)",
        "",
      ].join("\n");
    case "requirements":
      return `nonce = ${encodedNonce}\nprint(nonce)\n`;
  }
}

function summarizeBenchmarkSamples({
  workload,
  concurrency,
  requestedRuns,
  samples,
  wallMs,
}: {
  readonly workload: BenchmarkWorkloadName;
  readonly concurrency: number;
  readonly requestedRuns: number;
  readonly samples: readonly BenchmarkRunSample[];
  readonly wallMs: number;
}): BenchmarkScenarioSummary {
  const outcomes = createOutcomeCounts();
  for (const sample of samples) {
    outcomes[sample.outcome] += 1;
  }

  return {
    workload,
    concurrency,
    requestedRuns,
    wallMs: roundMs(wallMs),
    throughputPerSecond: roundRate((samples.length / wallMs) * 1000),
    okThroughputPerSecond: roundRate((outcomes.ok / wallMs) * 1000),
    outcomes,
    latencyMs: summarizeLatencies(samples.map((sample) => sample.durationMs)),
    okLatencyMs: summarizeLatencies(
      samples
        .filter((sample) => sample.outcome === "ok")
        .map((sample) => sample.durationMs),
    ),
  };
}

async function runCodeRuntimeBenchmarkCli(
  args: readonly string[],
): Promise<void> {
  const parsed = parseCodeRuntimeBenchmarkArgs(args);
  switch (parsed.kind) {
    case "help":
      process.stdout.write(CODE_RUNTIME_BENCHMARK_HELP);
      return;
    case "run": {
      const report = await runCodeRuntimeBenchmark(parsed.options);
      process.stdout.write(formatBenchmarkReport(report));
      logger.info({ report }, "[CodeRuntimeBench] benchmark complete");
      return;
    }
  }
}

type CodeRuntimeRunner = {
  readonly isEnabled: boolean;
  readonly isReady: boolean;
  init(): Promise<void>;
  run(params: RunCodeParams): Promise<RunCodeResult>;
  shutdown(): Promise<void>;
};

type ParsedOption = {
  readonly name: string;
  readonly inlineValue: string | null;
};

const ALL_WORKLOADS = [
  "trivial",
  "warmed-imports",
  "requirements",
] satisfies readonly BenchmarkWorkloadName[];

async function runScenario({
  service,
  options,
  workload,
  concurrency,
}: {
  readonly service: CodeRuntimeRunner;
  readonly options: CodeRuntimeBenchmarkOptions;
  readonly workload: BenchmarkWorkloadName;
  readonly concurrency: number;
}): Promise<BenchmarkScenarioSummary> {
  logger.info(
    {
      workload,
      concurrency,
      runs: options.runs,
      warmupRuns: options.warmupRuns,
    },
    "[CodeRuntimeBench] starting scenario",
  );

  if (options.warmupRuns > 0) {
    const warmupSamples = await runSamples({
      service,
      options,
      workload,
      runs: options.warmupRuns,
      concurrency: Math.min(concurrency, options.warmupRuns),
      phase: "warmup",
    });
    const failedWarmup = warmupSamples.find(
      (sample) => sample.outcome !== "ok",
    );
    if (failedWarmup) {
      throw new Error(
        `warmup failed for workload=${workload}, concurrency=${concurrency}: ${failedWarmup.outcome}${failedWarmup.errorMessage ? ` (${failedWarmup.errorMessage})` : ""}`,
      );
    }
  }

  const startedAt = performance.now();
  const samples = await runSamples({
    service,
    options,
    workload,
    runs: options.runs,
    concurrency,
    phase: "measured",
  });
  const summary = summarizeBenchmarkSamples({
    workload,
    concurrency,
    requestedRuns: options.runs,
    samples,
    wallMs: performance.now() - startedAt,
  });

  logger.info({ summary }, "[CodeRuntimeBench] scenario complete");
  return summary;
}

async function runSamples({
  service,
  options,
  workload,
  runs,
  concurrency,
  phase,
}: {
  readonly service: CodeRuntimeRunner;
  readonly options: CodeRuntimeBenchmarkOptions;
  readonly workload: BenchmarkWorkloadName;
  readonly runs: number;
  readonly concurrency: number;
  readonly phase: "warmup" | "measured";
}): Promise<BenchmarkRunSample[]> {
  const samples = new Array<BenchmarkRunSample>(runs);
  let nextRunIndex = 0;
  const workerCount = Math.min(concurrency, runs);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const runIndex = nextRunIndex;
      nextRunIndex += 1;
      if (runIndex >= runs) return;
      samples[runIndex] = await runOneSample({
        service,
        options,
        workload,
        runIndex,
        phase,
      });
    }
  });

  await Promise.all(workers);
  return samples;
}

async function runOneSample({
  service,
  options,
  workload,
  runIndex,
  phase,
}: {
  readonly service: CodeRuntimeRunner;
  readonly options: CodeRuntimeBenchmarkOptions;
  readonly workload: BenchmarkWorkloadName;
  readonly runIndex: number;
  readonly phase: "warmup" | "measured";
}): Promise<BenchmarkRunSample> {
  const nonce = `${phase}-${workload}-${runIndex}-${randomUUID()}`;
  const startedAt = performance.now();
  try {
    const result = await service.run({
      code: buildBenchmarkPythonCode({ workload, nonce }),
      timeoutSeconds: options.timeoutSeconds,
      requirements:
        workload === "requirements" ? [...options.requirements] : [],
    });
    return {
      outcome: resolveOutcome(result, nonce),
      durationMs: roundMs(performance.now() - startedAt),
      exitCode: result.exitCode,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    return {
      outcome: errorMessage.includes("at capacity")
        ? "capacity_error"
        : "runtime_error",
      durationMs: roundMs(performance.now() - startedAt),
      errorMessage,
    };
  }
}

async function loadCodeRuntimeService(): Promise<CodeRuntimeRunner> {
  const { codeRuntimeService } = await import(
    "@/code-runtime/code-runtime-service"
  );
  return codeRuntimeService;
}

function resolveOutcome(
  result: RunCodeResult,
  expectedNonce: string,
): BenchmarkOutcome {
  if (result.timedOut) return "timeout";
  if (result.exitCode !== 0) return "script_error";
  if (!result.stdout.includes(expectedNonce)) return "validation_error";
  return "ok";
}

function summarizeLatencies(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    min: roundMs(sorted[0]),
    p50: roundMs(percentile(sorted, 50)),
    p90: roundMs(percentile(sorted, 90)),
    p95: roundMs(percentile(sorted, 95)),
    p99: roundMs(percentile(sorted, 99)),
    max: roundMs(sorted[sorted.length - 1]),
    average: roundMs(sum / sorted.length),
  };
}

function percentile(
  sortedValues: readonly number[],
  percentileValue: number,
): number {
  if (sortedValues.length === 1) return sortedValues[0];

  const rank = (percentileValue / 100) * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  return lower + (upper - lower) * (rank - lowerIndex);
}

function createOutcomeCounts(): Record<BenchmarkOutcome, number> {
  return {
    ok: 0,
    script_error: 0,
    timeout: 0,
    capacity_error: 0,
    runtime_error: 0,
    validation_error: 0,
  };
}

function splitOption(raw: string | undefined): ParsedOption {
  if (!raw) throw new Error("missing argument");
  const equalsIndex = raw.indexOf("=");
  if (equalsIndex === -1) return { name: raw, inlineValue: null };
  return {
    name: raw.slice(0, equalsIndex),
    inlineValue: raw.slice(equalsIndex + 1),
  };
}

function readOptionValue({
  args,
  index,
  option,
}: {
  readonly args: readonly string[];
  readonly index: number;
  readonly option: ParsedOption;
}): { readonly value: string; readonly nextIndex: number } {
  if (option.inlineValue !== null) {
    if (!option.inlineValue) throw new Error(`${option.name} requires a value`);
    return { value: option.inlineValue, nextIndex: index + 1 };
  }

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option.name} requires a value`);
  }
  return { value, nextIndex: index + 2 };
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${optionName} must be a non-negative integer`);
  }
  return parsed;
}

function parsePositiveIntegerList(value: string, optionName: string): number[] {
  const values = value.split(",");
  if (values.length === 0) {
    throw new Error(`${optionName} must include at least one value`);
  }
  return values.map((item) => parsePositiveInteger(item.trim(), optionName));
}

function parseWorkloadList(value: string): BenchmarkWorkloadName[] {
  const normalized = value.trim();
  if (normalized === "all") return [...ALL_WORKLOADS];
  return dedupe(
    normalized.split(",").map((item) => parseWorkload(item.trim())),
  );
}

function parseWorkload(value: string): BenchmarkWorkloadName {
  switch (value) {
    case "trivial":
    case "warmed-imports":
    case "requirements":
      return value;
    default:
      throw new Error(
        `unknown workload: ${value}; expected trivial, warmed-imports, requirements, or all`,
      );
  }
}

function parseRequirementList(value: string, optionName: string): string[] {
  const requirements = value
    .split(",")
    .map((item) => parseRequirement(item, optionName));
  if (requirements.length === 0) {
    throw new Error(`${optionName} must include at least one requirement`);
  }
  return requirements;
}

function parseRequirement(value: string, optionName: string): string {
  const requirement = value.trim();
  if (!requirement) throw new Error(`${optionName} includes an empty value`);
  return requirement;
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function applyBenchmarkEnvDefaults(): void {
  process.env.ARCHESTRA_CODE_RUNTIME_ENABLED ??= "true";
  process.env.ARCHESTRA_DATABASE_URL ??=
    "postgres://benchmark:benchmark@localhost:5432/benchmark";
}

function formatBenchmarkReport(report: CodeRuntimeBenchmarkReport): string {
  const rows = report.scenarios.map((scenario) => [
    scenario.workload,
    String(scenario.concurrency),
    String(scenario.requestedRuns),
    String(scenario.outcomes.ok),
    String(scenario.outcomes.script_error),
    String(scenario.outcomes.timeout),
    String(scenario.outcomes.capacity_error),
    String(scenario.outcomes.runtime_error),
    String(scenario.outcomes.validation_error),
    String(scenario.throughputPerSecond),
    String(scenario.okThroughputPerSecond),
    formatStatsCell(scenario.okLatencyMs, "p50"),
    formatStatsCell(scenario.okLatencyMs, "p95"),
    formatStatsCell(scenario.okLatencyMs, "p99"),
    formatStatsCell(scenario.okLatencyMs, "max"),
  ]);
  return [
    `\nCode runtime benchmark initialized in ${report.initDurationMs} ms`,
    formatTable(
      [
        "workload",
        "concurrency",
        "runs",
        "ok",
        "script_error",
        "timeout",
        "capacity_error",
        "runtime_error",
        "validation_error",
        "attempts/s",
        "ok/s",
        "ok p50 ms",
        "ok p95 ms",
        "ok p99 ms",
        "ok max ms",
      ],
      rows,
    ),
    "",
  ].join("\n");
}

function formatTable(
  headers: readonly string[],
  rows: readonly string[][],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const formatRow = (row: readonly string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
  ].join("\n");
}

function formatStatsCell(
  stats: LatencyStats | null,
  key: "p50" | "p95" | "p99" | "max",
): string {
  return stats ? String(stats[key]) : "n/a";
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return (
    entrypoint !== undefined &&
    import.meta.url === pathToFileURL(entrypoint).href
  );
}

function flushLogger(): void {
  (logger as typeof logger & { flush?: () => void }).flush?.();
}

if (isMainModule()) {
  runCodeRuntimeBenchmarkCli(process.argv.slice(2))
    .catch((error) => {
      logger.error({ err: error }, "[CodeRuntimeBench] benchmark failed");
      process.exitCode = 1;
    })
    .finally(() => {
      flushLogger();
    });
}
