import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClaudeIngress } from "./claude-parity-ingress.mjs";
import { withDeployment } from "./live-ab.mjs";
import { SCENARIOS, sessionId } from "./live-ab-scenarios.mjs";
import { buildClientLaunch } from "./native-client.mjs";

export function parityPlan(suite = "full") {
  const names =
    suite === "pilot"
      ? ["long-stream"]
      : suite === "sentinel"
        ? ["long-stream"]
        : suite === "variability"
          ? [
              "long-many-tools",
              "long-history-replay",
              "long-mcp-qualified",
              "base-t16-long-h4-stream-c4",
            ]
          : [
              "long-stream",
              "long-many-tools",
              "long-history-replay",
              "long-mcp-qualified",
              "base-t16-long-h4-stream-c4",
            ];
  assert.ok(["full", "pilot", "sentinel", "variability"].includes(suite));
  return names.map((name) => ({
    scenario: SCENARIOS.find((s) => s.id === name),
    blocks: suite === "pilot" ? 2 : name === "long-stream" ? 8 : 2,
    priming: 2,
    samples: suite === "pilot" ? 1 : name === "long-stream" ? 6 : 3,
  }));
}

export async function runNativeClaude(
  launch,
  { signal, timeoutMs = 120000 } = {},
) {
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    truncated = false,
    timer;
  const stop = () => {
    child.kill("SIGTERM");
    timer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
  };
  const deadline = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
  child.stdout.on("data", (part) => {
    if (stdout.length + part.length <= 4 * 1024 * 1024) stdout += part;
    else {
      truncated = true;
      stop();
    }
  });
  // Never expose native diagnostics, authentication details or complete result text.
  child.stderr.resume();
  try {
    const exit = await new Promise((resolveExit, reject) => {
      child.once("error", () => reject(new Error("native_client_unavailable")));
      child.once("exit", (code, termination) =>
        resolveExit({ code, termination }),
      );
    });
    let value;
    try {
      value = JSON.parse(stdout);
    } catch {
      return {
        ok: false,
        error: "native_output_not_json",
        nativeExitCode: exit.code,
        nativeOutputBytes: stdout.length,
      };
    }
    const message = String(value.result ?? "");
    const category = value.is_error
      ? /session limit|usage limit|quota/i.test(message)
        ? "provider_quota"
        : /OAuth|scope|authentication/i.test(message)
          ? "provider_authentication_or_scope"
          : "native_client_error"
      : null;
    const numeric = (object) =>
      Object.fromEntries(
        Object.entries(object ?? {}).filter(([, v]) => typeof v === "number"),
      );
    return {
      ok:
        exit.code === 0 &&
        !truncated &&
        !value.is_error &&
        message.trim() === "BENCH_OK",
      error: category,
      nativeUsage: numeric(value.usage),
      nativeModelUsage: Object.fromEntries(
        Object.entries(value.modelUsage ?? {})
          .filter(([model]) => /^claude-[a-z0-9-]{1,100}$/i.test(model))
          .map(([model, usage]) => [model, numeric(usage)]),
      ),
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      "isolated-dev": { type: "boolean" },
      "run-id": { type: "string" },
      suite: { type: "string", default: "full" },
      model: { type: "string", default: "sonnet" },
      "prefix-words": { type: "string", default: "6000" },
    },
  });
  assert.ok(
    values["isolated-dev"] &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(values["run-id"] ?? ""),
  );
  const prefixWords = Number(values["prefix-words"]);
  assert.ok(
    Number.isInteger(prefixWords) && prefixWords > 0 && prefixWords <= 20000,
  );
  const base = process.env.ARCHESTRA_BENCHMARK_BASE ?? "http://127.0.0.1:9000";
  const captureBase =
    process.env.ARCHESTRA_BENCHMARK_CAPTURE_BASE ?? "http://127.0.0.1:19095";
  const agent = process.env.ARCHESTRA_BENCHMARK_AGENT;
  assert.ok(
    process.env.ARCHESTRA_BENCHMARK_API_AUTH &&
      process.env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
  );
  const plan = parityPlan(values.suite);
  const requested = plan.reduce(
    (n, p) =>
      n +
      p.blocks * 2 * (p.priming + p.samples) * (p.scenario.concurrency ?? 1),
    0,
  );
  const output = resolve("benchmarks/results", values["run-id"]);
  await mkdir(output, { mode: 0o700 });
  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        authorization: process.env.ARCHESTRA_BENCHMARK_API_AUTH,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.ok, `admin_http_${response.status}`);
    return response.json();
  };
  await api("GET", "/api/user-tokens/me");
  const { value: gatewayToken } = await api("GET", "/api/user-tokens/me/value");
  const fixture = JSON.parse(
    await readFile("benchmarks/results/gateway-tools.json", "utf8"),
  );
  const gatewayTools = fixture.tools;
  const ingress = await createClaudeIngress({
    proxyBase: base,
    captureBase,
    agent,
    gatewayTools,
    prefixWords,
  });
  const directory = await mkdtemp(join(tmpdir(), "appa-claude-parity-"));
  const interrupted = new AbortController();
  const interrupt = () => interrupted.abort();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(name, interrupt);
  let failureKind = null,
    failureLocation = null;
  let restored = false,
    failure = null,
    completed = 0;
  const rows = [],
    deployments = [];
  try {
    await withDeployment({
      api,
      onRestored: () => {
        restored = true;
      },
      work: async ({ set }) => {
        for (const cell of plan)
          for (let block = 0; block < cell.blocks; block++) {
            const arms = block % 2 ? ["off", "on"] : ["on", "off"];
            for (const arm of arms) {
              interrupted.signal.throwIfAborted();
              deployments.push({
                scenario: cell.scenario.id,
                block,
                arm,
                state: await set(arm === "on"),
              });
              const width = cell.scenario.concurrency ?? 1;
              for (const phase of ["priming", "sample"])
                for (
                  let sample = 0;
                  sample < (phase === "priming" ? cell.priming : cell.samples);
                  sample++
                ) {
                  interrupted.signal.throwIfAborted();
                  const outcomes = await Promise.allSettled(
                    Array.from({ length: width }, async (_, lane) => {
                      const session = sessionId({
                        runId: values["run-id"],
                        seed: 1605,
                        provider: "anthropic",
                        scenario: `${cell.scenario.id}/lane${lane}`,
                        block,
                        arm,
                      });
                      const job = ingress.register({
                        session,
                        scenario: cell.scenario,
                        arm,
                      });
                      const mcpConfig = join(directory, `${session}.json`);
                      await writeFile(
                        mcpConfig,
                        JSON.stringify({
                          mcpServers: {
                            appa_benchmark: {
                              type: "http",
                              url: `${base}/v1/mcp/${agent}`,
                              headers: {
                                Authorization: `Bearer ${gatewayToken}`,
                                "X-Appa-Session-ID": session,
                              },
                            },
                          },
                        }),
                        { mode: 0o600 },
                      );
                      const launch = buildClientLaunch({
                        client: "claude",
                        base,
                        agent,
                        session,
                        passthroughKey:
                          process.env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
                        gatewayToken,
                        mcpConfig,
                        env: process.env,
                        args: [
                          "--print",
                          "--model",
                          values.model,
                          "--tools",
                          "",
                          "--session-id",
                          session,
                          "--no-session-persistence",
                          "--max-turns",
                          "1",
                          "--output-format",
                          "json",
                          "Reply exactly BENCH_OK. Do not use tools.",
                        ],
                      });
                      launch.env.ANTHROPIC_BASE_URL = `${ingress.base}/v1/anthropic/${agent}`;
                      let native, measured;
                      try {
                        native = await runNativeClaude(launch, {
                          signal: interrupted.signal,
                        });
                        if (native.ok)
                          measured = await Promise.race([
                            job.done,
                            new Promise((_, reject) => {
                              const timer = setTimeout(
                                () =>
                                  reject(
                                    new Error("ingress_measurement_timeout"),
                                  ),
                                10000,
                              );
                              timer.unref();
                            }),
                          ]);
                        else
                          measured = {
                            ok: false,
                            error: native.error ?? "native_client_failed",
                            usage: null,
                            evidence: { missing: true },
                          };
                      } finally {
                        job.dispose();
                      }
                      const row = {
                        runId: values["run-id"],
                        provider: "anthropic",
                        scenario: cell.scenario.id,
                        model:
                          measured.model ??
                          Object.keys(native?.nativeModelUsage ?? {})[0] ??
                          "claude-unverified",
                        arm,
                        block,
                        lane,
                        phase,
                        sample,
                        ...measured,
                        native,
                        logicalWorkloadCount: 1,
                        additionalNativeCalls: job.additionalCalls,
                      };
                      if (job.additionalCalls) {
                        row.ok = false;
                        row.error = "additional_native_model_calls";
                      }
                      rows.push(row);
                      completed++;
                      await appendFile(
                        join(output, "measurements.jsonl"),
                        `${JSON.stringify(row)}\n`,
                        { mode: 0o600 },
                      );
                      if (
                        !row.ok &&
                        [
                          "provider_quota",
                          "provider_authentication_or_scope",
                        ].includes(row.error)
                      )
                        throw new Error(row.error);
                    }),
                  );
                  const rejected = outcomes.find(
                    (result) => result.status === "rejected",
                  );
                  if (rejected) throw rejected.reason;
                }
            }
          }
      },
    });
  } catch (error) {
    failureKind = /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
    failureLocation =
      error.stack?.match(/(claude-parity-[a-z-]+\.mjs:\d+:\d+)/)?.[1] ?? null;
    failure = /^[a-z0-9_]+$/.test(error.message) ? error.message : "run_failed";
  } finally {
    await ingress.close();
    await rm(directory, { recursive: true, force: true });
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.removeListener(name, interrupt);
    const summary = {
      version: 1,
      runId: values["run-id"],
      requestedCalls: requested,
      completedCalls: completed,
      errors: rows.filter((r) => !r.ok).length,
      restored,
      failure,
      failureKind,
      failureLocation,
      plan,
      deployments,
      modelAlias: values.model,
      prefixWords,
      transportLane: "genuine-claude-code-controlled-ingress",
      nativeAuthentication: "native-client-owned",
      inputHistory: "controlled synthetic protocol transcript before Archestra",
      nativeSystem: "genuine client context retained",
      callerStreaming: true,
      parityCaveat:
        "Native CLI streams all calls; fixed-transcript input overlay is not an unmodified CLI task or tool execution",
      shimHash: createHash("sha256")
        .update(
          await readFile(
            fileURLToPath(
              new URL("./claude-parity-ingress.mjs", import.meta.url),
            ),
          ),
        )
        .digest("hex"),
    };
    await writeFile(
      join(output, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      { mode: 0o600 },
    );
    console.info(
      JSON.stringify({
        runId: values["run-id"],
        requested,
        completed,
        restored,
        failure,
        errors: summary.errors,
      }),
    );
    process.exitCode = failure || !restored ? 2 : 0;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
)
  main().catch(() => {
    console.error(
      "Claude parity configuration refused; no credentials or native diagnostics are logged.",
    );
    process.exitCode = 1;
  });
