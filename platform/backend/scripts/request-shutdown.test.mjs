import { createServer } from "node:http";
import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
// A local collector keeps telemetry shutdown real without external service calls.
const collector = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { "Content-Type": "application/x-protobuf" });
  response.end();
});
await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
const collectorUrl = `http://127.0.0.1:${collector.address().port}`;
const children = new Set();
const realTime = process.env.SHUTDOWN_REAL_TIME === "1";
const durations = realTime ? [90000, 180000] : [900, 1800];
const drainSeconds = realTime ? 200 : 2;
const scenarios = [
  ...durations.flatMap((durationMs) =>
    ["json", "stream", "mcp"].map((kind) => ({
      name: `${kind}-${durationMs}ms`,
      kind,
      durationMs,
      drainSeconds,
      expected: "completed",
    })),
  ),
  {
    name: "mixed-mcp-llm",
    kind: "mcp",
    durationMs: durations[1],
    drainSeconds,
    competingLlm: true,
    expected: "completed",
  },
  {
    name: "late-audit",
    kind: "audit",
    durationMs: 100,
    drainSeconds: 2,
    expected: "completed",
  },
  {
    name: "stream-persistence",
    kind: "stream",
    durationMs: 100,
    persistMs: 100,
    backgroundMs: 100,
    drainSeconds: 2,
    expected: "completed",
  },
  {
    name: "past-budget",
    kind: "stream",
    durationMs: 1800,
    drainSeconds: 1,
    expected: "terminated",
  },
];

async function run(opts) {
  const events = [];
  const child = fork(
    "./src/test/request-shutdown-child.ts",
    [JSON.stringify(opts)],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        TSX_TSCONFIG_PATH: "standalone-scripts.tsconfig.json",
        ARCHESTRA_DATABASE_URL:
          "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
        ARCHESTRA_ANALYTICS: "disabled",
        ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl,
        ARCHESTRA_SERVER_REQUEST_DRAIN_SECONDS: String(opts.drainSeconds),
      ARCHESTRA_SERVER_POD_GRACE_SECONDS: String(opts.drainSeconds + 45),
        ARCHESTRA_SERVER_SHUTDOWN_CLEANUP_SECONDS: "5",
        ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS: "1",
        OTEL_TRACES_EXPORTER: "none",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
      },
    },
  );
  const bootTimeout = setTimeout(() => child.kill("SIGKILL"), 30000);
  children.add(child);
  child.on("exit", () => children.delete(child));
  child.stdout.resume();
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let exited;
  const exitPromise = new Promise((resolve) =>
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    }),
  );
  const waitEvent = (predicate) =>
    new Promise((resolve, reject) => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      const check = (e) => {
        if (predicate(e)) {
          child.off("message", check);
          resolve(e);
        }
      };
      child.on("message", check);
      exitPromise.then(() =>
        reject(new Error(`child exited before event: ${stderr}`)),
      );
    });
  child.on("message", (e) => events.push(e));
  const ready = await waitEvent((e) => e.event === "ready");
  clearTimeout(bootTimeout);
  const path =
    opts.kind === "mcp"
      ? "/v1/mcp/test"
      : opts.kind === "audit"
        ? "/api/synthetic-mutation"
        : `/v1/openai/${opts.kind}`;
  const requestOptions =
    opts.kind === "mcp"
      ? {
          method: "POST",
          headers: {
            Connection: "close",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "slow", arguments: {} },
          }),
        }
      : {
          method: opts.kind === "audit" ? "POST" : "GET",
          headers: { Connection: "close" },
        };
  const request = fetch(ready.url + path, requestOptions)
    .then(
      async (r) => ({
        status: r.status,
        body: await r.text(),
        outcome: "completed",
      }),
      (e) => ({ outcome: "terminated", error: e.message }),
    )
    .catch((e) => ({ outcome: "terminated", error: e.message }));
  await waitEvent((e) => e.event === "admitted");
  let competing;
  if (opts.competingLlm) {
    competing = fetch(ready.url + "/v1/openai/stream").then((r) => r.text());
    await waitEvent((e) => e.event === "admitted" && e.route === "stream");
  }
  const signalAt = Date.now();
  child.kill("SIGTERM");
  const watchdog = setTimeout(
    () => child.kill("SIGKILL"),
    (opts.drainSeconds + 15) * 1000,
  );
  const result = await request;
  const responseAfterSignalMs = Date.now() - signalAt;
  const exit = await exitPromise;
  clearTimeout(watchdog);
  if (competing) assert.match(await competing, /data: done/);
  const summary = {
    name: opts.name,
    ...result,
    responseAfterSignalMs,
    exitAfterSignalMs: Date.now() - signalAt,
    exit,
    events,
    stderr,
  };
  console.log(JSON.stringify(summary));
  assert.equal(result.outcome, opts.expected, opts.name);
  if (opts.name === "stream-persistence") {
    assert.ok(
      events.some(
        (e) => e.event === "background-persisted" && !e.dependencyClosed,
      ),
    );
  }
  assert.equal(exit.code, 0, opts.name);
  assert.ok(
    events.findIndex((e) => e.event === "mcp-disconnected") >
      events.findIndex((e) => e.event === "dependency-closed"),
    opts.name,
  );
  assert.ok(
    events.findIndex((e) => e.event === "cache-closed") >
      events.findIndex((e) => e.event === "mcp-disconnected"),
    opts.name,
  );
  if (result.outcome === "completed") {
    assert.equal(result.status, 200);
    assert.match(result.body, /completed|data: done/);
  }
  assert.ok(
    events.findIndex((e) => e.event === "telemetry-flushed") >
      events.findIndex((e) => e.event === "cache-closed"),
    opts.name,
  );
  assert.ok(
    events.findIndex((e) => e.event === "telemetry-flushed") >
      events.findIndex((e) => e.event === "dependency-closed"),
    opts.name,
  );
  if (opts.name === "late-audit")
    assert.ok(
      events.findIndex((e) => e.event === "audit-persisted") <
        events.findIndex((e) => e.event === "dependency-closed"),
    );
  return summary;
}
try {
  const results = await Promise.all(scenarios.map(run));
  if (process.env.SHUTDOWN_RESULTS_PATH)
    writeFileSync(
      process.env.SHUTDOWN_RESULTS_PATH,
      JSON.stringify(results, null, 2),
    );
  console.log(`PASS: ${results.length} synthetic shutdown cases`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(resolve));
}
