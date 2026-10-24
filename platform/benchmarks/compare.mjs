import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { comparisonVariants } from "./comparison-options.mjs";
import { runBlock, summarize } from "./measure.mjs";
import { MOCK_CONTENT } from "./mock-upstream.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
if (fs.existsSync(".env")) throw Error("Isolated worktree must not have .env");
const output = path.join(root, "benchmarks/results/comparison");
fs.mkdirSync(output, { recursive: true });
const children = [],
  stacks = [];
const variants = comparisonVariants(process.argv.slice(2));
const [baselineSha, candidateSha] = variants.map((variant) => variant.commit);

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  metadata: {
    node: process.version,
    os: os.type(),
    osRelease: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    auth: "passthrough-virtual-key",
    concurrency: 50,
    count: 1000,
    warmup: 100,
    repeats: 6,
    scenarios: ["chat", "tools"],
    methodology:
      "Both compiled variants resident with separate disposable PostgreSQL databases and identical loopback mocks; one variant receives load at a time. Six paired trials alternate baseline/candidate and candidate/baseline order. Direct mock control before each pair. HTTP/1.1 closed loop keep-alive. Gateway overhead is measured per request. No production services, paid inference or shared data.",
  },
  variants: variants.map(({ target, offset, commit, dist }) => ({
    target,
    offset,
    commit,
    dist,
    dependencyInputs: fs.existsSync(path.join(dist, "dependency-inputs.json"))
      ? JSON.parse(
          fs.readFileSync(path.join(dist, "dependency-inputs.json"), "utf8"),
        )
      : null,
  })),
  blocks: [],
};
const interrupt = () => {
  report.error = "Comparison interrupted";
  process.exitCode = 1;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  }
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
function command(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    let out = "",
      err = "";
    const c = spawn(cmd, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(c);
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("error", reject);
    c.on("exit", (code) =>
      code === 0
        ? resolve(out)
        : reject(Error(`${cmd} exited ${code}: ${err.slice(-3000)}`)),
    );
  });
}
function start(cmd, args, env, label) {
  const fd = fs.openSync(path.join(output, `${label}.log`), "w");
  const c = spawn(cmd, args, { cwd: root, env, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);
  children.push(c);
  return c;
}
const save = () =>
  fs.writeFileSync(
    path.join(output, "results.json"),
    JSON.stringify(report, null, 2),
  );
async function unused(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(true));
  });
}
async function ready(url, child) {
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("Backend exited during startup");
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw Error("Backend readiness timeout");
}
async function stop(c) {
  if (c.exitCode !== null || c.signalCode !== null) return;
  c.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => c.once("exit", resolve)),
    sleep(10000),
  ]);
  if (c.exitCode === null && c.signalCode === null) {
    c.kill("SIGKILL");
    await new Promise((resolve) => c.once("exit", resolve));
  }
}
try {
  for (const v of variants) {
    if (report.error) throw Error(report.error);
    const commit = fs
      .readFileSync(path.join(v.dist, "source-commit.txt"), "utf8")
      .trim();
    if (commit !== v.commit) throw Error("Wrong compiled source commit");
    const { offset } = v;
    v.backend = 19000 + offset;
    v.mock = 19092 + offset;
    v.postgres = 15432 + offset;
    v.metrics = 19050 + offset;
    v.project = `archestra-benchmark-comparison-${v.target}`;
    for (const port of [v.backend, v.mock, v.postgres, v.metrics])
      if (!(await unused(port))) throw Error(`Port ${port} occupied`);
    const compose = [
      "compose",
      "-p",
      v.project,
      "-f",
      "benchmarks/compose.yaml",
    ];
    v.compose = compose;
    const dockerEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      BENCHMARK_POSTGRES_PORT: String(v.postgres),
    };
    v.dockerEnv = dockerEnv;
    if ((await command("docker", [...compose, "ps", "-aq"], dockerEnv)).trim())
      throw Error("Existing disposable project; refusing takeover");
    stacks.push(v);
    await command("docker", [...compose, "up", "-d", "--wait"], dockerEnv);
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      KUBECONFIG: "/dev/null",
      NODE_ENV: "production",
      ARCHESTRA_INTERNAL_API_BASE_URL: `http://127.0.0.1:${v.backend}`,
      ARCHESTRA_API_BASE_URL: `http://127.0.0.1:${v.backend}`,
      ARCHESTRA_FRONTEND_URL: "http://127.0.0.1:13000",
      ARCHESTRA_METRICS_PORT: String(v.metrics),
      ARCHESTRA_DATABASE_URL: `postgresql://benchmark:benchmark@127.0.0.1:${v.postgres}/benchmark`,
      ARCHESTRA_DATABASE_POOL_MAX: "20",
      ARCHESTRA_OPENAI_BASE_URL: `http://127.0.0.1:${v.mock}/v1`,
      ARCHESTRA_AUTH_SECRET: "local-benchmark-secret-at-least-32-characters",
      ARCHESTRA_AUTH_ADMIN_EMAIL: "admin@example.com",
      ARCHESTRA_AUTH_ADMIN_PASSWORD: "local-benchmark-password",
      ARCHESTRA_ANALYTICS: "disabled",
      ARCHESTRA_CODE_RUNTIME_ENABLED: "false",
      ARCHESTRA_PROCESS_TYPE: "web",
    };
    fs.writeFileSync(
      path.join(output, `${v.target}-migration.log`),
      await command("pnpm", ["--dir", "backend", "db:migrate"], env),
    );
    start(
      process.execPath,
      ["benchmarks/mock-upstream.mjs", String(offset)],
      env,
      `${v.target}-mock`,
    );
    const server = start(
      process.execPath,
      [path.join(v.dist, "server.mjs")],
      env,
      `${v.target}-backend`,
    );
    await ready(`http://127.0.0.1:${v.backend}/ready`, server);
    v.key = (
      await command(process.execPath, ["benchmarks/seed.mjs", String(offset)], {
        ...dockerEnv,
      })
    ).trim();
    if (!v.key) throw Error("No benchmark key");
    const health = await fetch(`http://127.0.0.1:${v.mock}/health`).then((r) =>
      r.json(),
    );
    if (health.benchmarkMock !== 1) throw Error("Invalid loopback mock");
    v.health = health;
  }
  report.metadata.mock = variants[0].health;
  if (JSON.stringify(variants[0].health) !== JSON.stringify(variants[1].health))
    throw Error("Different mock settings");
  for (const scenario of report.metadata.scenarios) {
    if (report.error) throw Error(report.error);
    const body = {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Reply with the benchmark marker." }],
      max_tokens: 32,
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
    for (let repeat = 1; repeat <= 6; repeat++) {
      if (report.error) throw Error(report.error);
      const order = repeat % 2 ? variants : [...variants].reverse();
      for (const v of [null, ...order]) {
        const target = v?.target ?? "direct";
        const result = await runBlock({
          url: v
            ? `http://127.0.0.1:${v.backend}/v1/openai/chat/completions`
            : `http://127.0.0.1:${variants[0].mock}/v1/chat/completions`,
          body,
          headers: v
            ? {
                authorization: "Bearer benchmark-no-inference",
                "x-archestra-virtual-key": v.key,
              }
            : {},
          requireGatewayTiming: Boolean(v),
          expectedContent: MOCK_CONTENT,
          count: 1000,
          concurrency: 50,
          warmup: 100,
        });
        report.blocks.push({ scenario, repeat, target, ...result });
        save();
        console.info(
          `${scenario} repeat=${repeat} ${target}: p50=${result.totalMs.p50.toFixed(2)} p99=${result.totalMs.p99.toFixed(2)} rps=${result.successfulRequestsPerSecond.toFixed(1)} errors=${result.failed}`,
        );
        if (result.failed) throw Error("Measured failure");
        await sleep(250);
      }
    }
  }
  report.complete = true;
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  for (const c of children.reverse()) await stop(c);
  for (const v of stacks.reverse()) {
    try {
      fs.writeFileSync(
        path.join(output, `${v.target}-postgres.log`),
        await command(
          "docker",
          [...v.compose, "logs", "--no-color"],
          v.dockerEnv,
        ),
      );
      await command("docker", [...v.compose, "down", "--volumes"], v.dockerEnv);
    } catch (e) {
      report.cleanupError = e.message;
      process.exitCode = 1;
    }
  }
  report.cleanupFinishedAt = new Date().toISOString();
  save();
}
process.removeListener("SIGINT", interrupt);
process.removeListener("SIGTERM", interrupt);

const aggregate = (scenario, target) => {
  const blocks = report.blocks.filter(
    (block) => block.scenario === scenario && block.target === target,
  );
  const samples = blocks
    .flatMap((block) => block.samples)
    .filter((sample) => sample.ok);
  return {
    scenario,
    target,
    requests: blocks.reduce((n, block) => n + block.attempted, 0),
    failures: blocks.reduce((n, block) => n + block.failed, 0),
    clientMs: summarize(samples.map((sample) => sample.totalMs)),
    overheadMs: summarize(
      samples
        .map((sample) => sample.gatewayTiming?.overheadMs)
        .filter(Number.isFinite),
    ),
    requestsPerSecond:
      (samples.length * 1000) /
      blocks.reduce((n, block) => n + block.elapsedMs, 0),
  };
};
const summary = {
  complete:
    report.complete === true &&
    !report.error &&
    !report.cleanupError &&
    Boolean(report.cleanupFinishedAt),
  metadata: report.metadata,
  variants: report.variants,
  rows: report.metadata.scenarios.flatMap((scenario) =>
    variants.map(({ target }) => aggregate(scenario, target)),
  ),
};
fs.writeFileSync(
  path.join(output, "report.json"),
  JSON.stringify(summary, null, 2),
);
const format = (n) => (Number.isFinite(n) ? n.toFixed(2) : "—");
const lines = [
  "## Paired proxy latency comparison",
  "",
  `Baseline: \`${baselineSha}\`; candidate: \`${candidateSha}\`.`,
  "",
  `Same runner: ${report.metadata.logicalCpus} logical CPUs, ${(report.metadata.totalMemoryBytes / 2 ** 30).toFixed(1)} GiB RAM. Two production builds resident; only one receives proxy load at a time. Authentication, persistence and pool size are identical. Six alternating 1,000-request trials per workload/variant at concurrency 50; warmup excluded.`,
  "",
  summary.complete
    ? "Completed successfully, including teardown."
    : "Incomplete comparison; do not promote partial results.",
  "",
  "| Workload | Revision | Requests | Failures | Added ms P50 / P95 / P99 | Client ms P50 / P95 / P99 | Requests/sec |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ...summary.rows.map(
    (row) =>
      `| ${row.scenario === "chat" ? "HTTP proxy request" : "HTTP request with tool definition"} | ${row.target} | ${row.requests} | ${row.failures} | ${["p50", "p95", "p99"].map((key) => format(row.overheadMs?.[key])).join(" / ")} | ${["p50", "p95", "p99"].map((key) => format(row.clientMs?.[key])).join(" / ")} | ${format(row.requestsPerSecond)} |`,
  ),
  "",
  "These paired results use two resident builds and remain separate from the ordinary single-build release benchmark. Raw trials and direct-mock controls are retained.",
];
fs.writeFileSync(path.join(output, "summary.md"), `${lines.join("\n")}\n`);
