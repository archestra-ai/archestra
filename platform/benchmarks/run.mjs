import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runBlock } from "./measure.mjs";
import { MOCK_CONTENT } from "./mock-upstream.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    if (!/^--[a-z-]+=.+$/.test(arg))
      throw new Error(`Expected --name=value: ${arg}`);
    const index = arg.indexOf("=");
    return [arg.slice(2, index), arg.slice(index + 1)];
  }),
);
const allowed = new Set([
  "requests",
  "stream-requests",
  "warmup",
  "repeats",
  "concurrency",
  "scenarios",
  "proxy-url",
  "mock-url",
  "output",
]);
for (const key of Object.keys(options))
  if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
const integer = (key, fallback) => {
  const value = Number(options[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${key} must be a positive integer`);
  return value;
};
const count = integer("requests", 1000);
const streamCount = integer("stream-requests", 100);
const warmup = integer("warmup", 30);
const repeats = integer("repeats", 3);
const concurrencyLevels = (options.concurrency ?? "1,10,50")
  .split(",")
  .map(Number);
if (concurrencyLevels.some((c) => !Number.isSafeInteger(c) || c < 1 || c > 500))
  throw new Error("Concurrency must be between 1 and 500");
const scenarios = (options.scenarios ?? "chat,tools,stream").split(",");
if (scenarios.some((s) => !["chat", "tools", "stream"].includes(s)))
  throw new Error("Unknown scenario");
const maxConcurrency = Math.max(...concurrencyLevels);
if (
  (scenarios.includes("stream") && streamCount < maxConcurrency) ||
  (scenarios.some((s) => s !== "stream") && count < maxConcurrency)
)
  throw new Error(
    "Request counts must be at least the highest requested concurrency",
  );
const proxyUrl =
  options["proxy-url"] ?? "http://127.0.0.1:19000/v1/openai/chat/completions";
const mockUrl =
  options["mock-url"] ?? "http://127.0.0.1:19092/v1/chat/completions";
const output = path.resolve(
  options.output ??
    path.join(
      root,
      "benchmarks/results",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
await mkdir(output, { recursive: true });

const mockHealth = await fetch(new URL("/health", mockUrl), {
  signal: AbortSignal.timeout(5000),
}).then((r) => r.json());
if (
  mockHealth.benchmarkMock !== 1 ||
  !Number.isInteger(mockHealth.chunks) ||
  mockHealth.chunks < 1
)
  throw new Error("Direct upstream is not the benchmark mock");
const headers = {
  authorization: `Bearer ${process.env.ARCHESTRA_BENCHMARK_API_KEY ?? "benchmark-no-inference"}`,
};
const getGit = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  metadata: {
    gitCommit: getGit(["rev-parse", "HEAD"]),
    platformTree: getGit(["rev-parse", "HEAD:platform"]),
    node: process.version,
    os: os.type(),
    osRelease: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    proxyUrl,
    mockUrl,
    auth: process.env.ARCHESTRA_BENCHMARK_API_KEY
      ? "supplied-key"
      : "synthetic-provider-key",
    count,
    streamCount,
    warmup,
    repeats,
    concurrencyLevels,
    scenarios,
    mock: mockHealth,
    methodology:
      "Closed-loop HTTP/1.1 keep-alive; direct and proxy blocks alternate order. Median difference is an estimate, not a per-request overhead distribution. Streaming first content excludes non-content SSE events.",
  },
  blocks: [],
};
let failed = false;
try {
  for (const scenario of scenarios) {
    const body = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Reply with the benchmark marker." }],
      max_tokens: 32,
      ...(scenario === "stream"
        ? { stream: true, stream_options: { include_usage: true } }
        : {}),
      ...(scenario === "tools"
        ? {
            tools: [
              {
                type: "function",
                function: {
                  name: "benchmark_lookup",
                  description: "Look up a fictional item.",
                  parameters: {
                    type: "object",
                    properties: { name: { type: "string" } },
                    required: ["name"],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const expectedContent =
      scenario === "stream"
        ? MOCK_CONTENT + ".".repeat(mockHealth.chunks - 1)
        : MOCK_CONTENT;
    for (const concurrency of concurrencyLevels) {
      for (let repeat = 1; repeat <= repeats; repeat++) {
        for (const target of repeat % 2
          ? ["direct", "proxy"]
          : ["proxy", "direct"]) {
          const result = await runBlock({
            url: target === "direct" ? mockUrl : proxyUrl,
            body,
            headers,
            expectedContent,
            count: scenario === "stream" ? streamCount : count,
            concurrency,
            warmup,
          });
          report.blocks.push({
            scenario,
            concurrency,
            repeat,
            target,
            requestBytes: Buffer.byteLength(JSON.stringify(body)),
            ...result,
          });
          await writeFile(
            path.join(output, "results.json"),
            JSON.stringify(report, null, 2),
          );
          console.info(
            `${scenario} c=${concurrency} repeat=${repeat} ${target}: p50=${result.totalMs?.p50.toFixed(2)}ms p99=${result.totalMs?.p99.toFixed(2)}ms ${result.successfulRequestsPerSecond.toFixed(1)}req/s errors=${result.failed}`,
          );
          if (result.failed)
            throw new Error(
              "Stopping load after a failed measured block; partial results saved",
            );
          await sleep(250);
        }
      }
    }
  }
} catch (error) {
  report.error = error.message;
  failed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
  const lines = [
    "# LLM Proxy Benchmark",
    "",
    `Commit: \`${report.metadata.gitCommit}\``,
    "",
    report.metadata.methodology,
    "",
    "| Scenario | Concurrency | Repeat | Direct P50 ms | Proxy P50 ms | P50 difference ms | Proxy P95 ms | Proxy P99 ms | Proxy req/s | Errors |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const proxy of report.blocks.filter((b) => b.target === "proxy")) {
    const direct = report.blocks.find(
      (b) =>
        b.target === "direct" &&
        b.scenario === proxy.scenario &&
        b.concurrency === proxy.concurrency &&
        b.repeat === proxy.repeat,
    );
    if (!direct?.totalMs || !proxy.totalMs) continue;
    const f = (n) => n.toFixed(2);
    lines.push(
      `| ${proxy.scenario} | ${proxy.concurrency} | ${proxy.repeat} | ${f(direct.totalMs.p50)} | ${f(proxy.totalMs.p50)} | ${f(proxy.totalMs.p50 - direct.totalMs.p50)} | ${f(proxy.totalMs.p95)} | ${f(proxy.totalMs.p99)} | ${f(proxy.successfulRequestsPerSecond)} | ${proxy.failed} |`,
    );
  }
  lines.push(
    "",
    "## Streaming",
    "",
    "First content excludes role-only and usage events. Gaps are measured between decoded content events, not TCP reads.",
    "",
    "| Concurrency | Repeat | Direct first content P50 ms | Proxy first content P50 ms | P50 difference ms | Proxy first content P99 ms | Direct gap P99 ms | Proxy gap P99 ms |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const proxy of report.blocks.filter(
    (b) => b.target === "proxy" && b.scenario === "stream",
  )) {
    const direct = report.blocks.find(
      (b) =>
        b.target === "direct" &&
        b.scenario === "stream" &&
        b.concurrency === proxy.concurrency &&
        b.repeat === proxy.repeat,
    );
    if (!direct?.firstContentMs || !proxy.firstContentMs) continue;
    const f = (n) => n.toFixed(2);
    lines.push(
      `| ${proxy.concurrency} | ${proxy.repeat} | ${f(direct.firstContentMs.p50)} | ${f(proxy.firstContentMs.p50)} | ${f(proxy.firstContentMs.p50 - direct.firstContentMs.p50)} | ${f(proxy.firstContentMs.p99)} | ${f(direct.gapsMs?.p99 ?? 0)} | ${f(proxy.gapsMs?.p99 ?? 0)} |`,
    );
  }
  if (report.error) lines.push("", `Run incomplete: ${report.error}`);
  await writeFile(path.join(output, "summary.md"), `${lines.join("\n")}\n`);
  console.info(`Results: ${output}`);
}
if (failed) process.exitCode = 1;
