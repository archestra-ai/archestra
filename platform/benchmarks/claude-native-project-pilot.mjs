import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withDeployment } from "./live-ab.mjs";
import { buildClientLaunch } from "./native-client.mjs";
import {
  claudeCoreModelResponses,
  LONG_MAIN_TASK,
  LONG_PARENT_TASK,
  LONG_WORKER_TASK,
  qualifyLongWork,
} from "./native-long-qualification.mjs";
import { createNativeMeasurementProxy } from "./native-measurement-proxy.mjs";
import { openProviderEvidence } from "./native-provider-evidence.mjs";
import { withProjectAttentionPolicy } from "./project-attention-policy.mjs";
import {
  INTERVENTION_RECOVERY_TASK,
  interventionRules,
  projectInterventionProfile,
  summarizeInterventions,
} from "./project-intervention-profile.mjs";
import { createProjectFixture } from "./project-workload-fixture.mjs";
import { RoundtripMeasurements } from "./roundtrip-measurements.mjs";
import { withDevelopmentKey } from "./stateful-codex-live.mjs";
import { cleanup, createAdminApi, setup } from "./stateful-gateway-setup.mjs";

const [namespace, arm, mode, workload = "short", profileName = "baseline"] =
  process.argv.slice(2);
const interventionProfile = projectInterventionProfile(profileName);
assert.match(namespace ?? "", /^[a-z][a-z0-9-]{7,30}$/);
assert.ok(["off", "on"].includes(arm));
assert.ok(mode === undefined || ["--full-task", "--main-task"].includes(mode));
const fullTask = mode !== undefined;
const requireChild = mode !== "--main-task";
assert.ok(["short", "sequential"].includes(workload));
const longWorkload = workload === "sequential";
assert.ok(!longWorkload || fullTask);
assert.ok(
  !interventionProfile || longWorkload,
  "interventions_require_long_workload",
);
const out = resolve("benchmarks/results", namespace);
await mkdir(out, { mode: 0o700 });
const h = (value) => createHash("sha256").update(String(value)).digest("hex");
await withDevelopmentKey(
  { "isolated-dev": true, "run-id": namespace, base: "http://127.0.0.1:9000" },
  async (options, env) => {
    const api = createAdminApi({
      base: options.base,
      auth: env.ARCHESTRA_BENCHMARK_API_AUTH,
    });
    const policy = await api("GET", "/api/guardrails-policy");
    assert.equal(typeof policy.contentHash, "string");
    const fixture = await createProjectFixture({ namespace, workload });
    await new Promise((resolve, reject) => {
      fixture.server.once("error", reject);
      fixture.server.listen(0, "127.0.0.1", resolve);
    });
    let resources;
    let edge;
    const measurements = new RoundtripMeasurements();
    const directory = await mkdtemp(
      join(tmpdir(), "appa-native-claude-project-"),
    );
    try {
      try {
        resources = await setup(api, {
          base: options.base,
          fixtureBase: `http://127.0.0.1:${fixture.server.address().port}`,
          namespace,
          rawToolNames: fixture.tools.map(({ name }) => name),
        });
      } catch (error) {
        if (error.proof) await cleanup(api, error.proof);
        throw error;
      }
      const { value: gatewayToken } = await api(
        "GET",
        "/api/user-tokens/me/value",
      );
      edge = createNativeMeasurementProxy({
        base: options.base,
        agent: resources.agentId,
        measurements,
        onPrivateFailure: async ({
          id,
          status,
          requestBody,
          responseBody,
          requestEncoding,
          responseEncoding,
        }) => {
          await Promise.all([
            writeFile(
              join(out, `private-error-${id}-request.bin`),
              requestBody,
              { mode: 0o600 },
            ),
            writeFile(
              join(out, `private-error-${id}-response.bin`),
              responseBody,
              { mode: 0o600 },
            ),
            writeFile(
              join(out, `private-error-${id}-encoding.json`),
              JSON.stringify({ status, requestEncoding, responseEncoding }),
              { mode: 0o600 },
            ),
          ]);
        },
      });
      await new Promise((resolve, reject) => {
        edge.server.once("error", reject);
        edge.server.listen(0, "127.0.0.1", resolve);
      });
      const nativeBase = `http://127.0.0.1:${edge.server.address().port}`;
      const mcpConfig = join(directory, "mcp.json");
      await writeFile(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            appa_benchmark: {
              type: "http",
              url: `${nativeBase}/v1/mcp/${resources.agentId}`,
              headers: { Authorization: `Bearer ${gatewayToken}` },
            },
          },
        }),
        { mode: 0o600 },
      );
      const agents = join(directory, "agents.json");
      await writeFile(
        agents,
        JSON.stringify({
          "benchmark-worker": {
            description: fullTask
              ? "Fix and verify the isolated multi-module ledger project using its MCP tools."
              : "Inspect the isolated project's ticket and reproduce its failing checks without editing or publishing.",
            prompt:
              `Benchmark namespace: ${namespace}.\n` +
              (longWorkload
                ? `${LONG_WORKER_TASK}${interventionProfile ? `\n${INTERVENTION_RECOVERY_TASK}` : ""}`
                : fullTask
                  ? "Use only the appa_benchmark MCP project tools. Read ticket.txt and the relevant files/checks, reproduce the failing checks before editing, fix the underlying issues in the source modules, and rerun checks until they pass. Do not modify the protected tests. Report changed modules and actual check results. Do not publish or create other agents; the parent must verify and publish."
                  : "This is a native delegation wiring pilot, not the bugfix run. Use only the appa_benchmark MCP project tools. Read ticket.txt, run project_check, and report which checks fail. Do not edit or publish. Do not create other agents."),
            tools: ["mcp__appa_benchmark__*"],
            ...(longWorkload ? { maxTurns: 150 } : {}),
          },
        }),
        { mode: 0o600 },
      );
      const launch = buildClientLaunch({
        client: "claude",
        base: nativeBase,
        agent: resources.agentId,
        session: randomUUID(),
        passthroughKey: env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
        gatewayToken,
        mcpConfig,
        env,
        args: [
          "--print",
          "--restricted",
          "--tools",
          requireChild ? "Agent,ToolSearch" : "ToolSearch",
          "--allowedTools",
          requireChild
            ? "Agent,ToolSearch,mcp__appa_benchmark__*"
            : "ToolSearch,mcp__appa_benchmark__*",
          "--permission-mode",
          "dontAsk",
          "--permission-prompts",
          "none",
          "--setting-sources",
          "",
          "--disable-slash-commands",
          "--no-chrome",
          "--model",
          "claude-sonnet-5-5",
          "--effort",
          "medium",
          "--max-turns",
          longWorkload ? "150" : "30",
          "--max-budget-usd",
          longWorkload ? "20" : fullTask ? "5" : "2",
          "--no-session-persistence",
          "--output-format",
          "stream-json",
          "--verbose",
          ...(requireChild
            ? ["--forward-subagent-text", "--agents", agents]
            : []),
        ],
      });
      // Let the actual SDK carry parent/child identity. A fixed shared session
      // header would overwrite native child sessions and invalidate this pilot.
      launch.env.ANTHROPIC_CUSTOM_HEADERS = `X-Archestra-Virtual-Key: ${env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY}`;
      launch.cwd = directory;
      launch.stdin = longWorkload
        ? requireChild
          ? LONG_PARENT_TASK
          : LONG_MAIN_TASK
        : !requireChild
          ? "Complete the ticket.txt bugfix task yourself using only the configured MCP project tools and ToolSearch. Read the ticket and relevant source, reproduce failing project_check checks before editing, fix the underlying bugs in multiple source modules, then rerun the immutable checks until all pass. Do not change tests. Receive a passing project_check result before project_publish; never batch those calls. If publication is blocked, use the real offered remedy workflow and retry exactly the authorized call. Do not invent results or stop before verified publication. No delegation, host commands/files, or web access."
          : fullTask
            ? "Use your real Agent tool exactly once to delegate the complete ticket.txt bugfix task in the isolated MCP project to benchmark-worker. The child must read the actual project, reproduce failing checks, edit the relevant modules, rerun immutable checks until they pass, and return its real result. Do not perform the child's edits yourself. After the child returns, independently run project_check and then project_publish with a summary of verified changes. If those MCP tools are deferred or not visible, use ToolSearch to load them; they are configured on appa_benchmark. Do not stop at a promise to verify or publish: complete both actual tool calls. Finish after publication. Use only Agent, ToolSearch, and the configured project MCP tools, no host commands/files or invented results."
            : "Use your real Agent tool exactly once to delegate to benchmark-worker. Ask that child to inspect ticket.txt in the isolated MCP project, reproduce the failures with project_check, and report them without edits or publication. Wait for the real result and summarize it. Do not perform the child's work yourself. Use only Agent and the configured MCP project tools, no host commands or files.";
      let native;
      let policyAudit = null;
      const finishProviderEvidence = await openProviderEvidence({
        base: "http://127.0.0.1:19095",
      });
      launch.stdin = `Benchmark namespace: ${namespace}.\n${launch.stdin}`;
      if (interventionProfile)
        launch.stdin += `\n${INTERVENTION_RECOVERY_TASK}`;
      const run = () =>
        withDeployment({
          api,
          work: async ({ set }) => {
            await set(arm === "on");
            measurements.startTask();
            native = await runPilotProcess({
              launch,
              out,
              timeoutMs: longWorkload ? 1200000 : fullTask ? 600000 : 180000,
            });
            measurements.finishTask({
              success:
                native.exitCode === 0 &&
                !native.resultIsError &&
                (!fullTask || fixture.isComplete()),
            });
          },
        });
      if (requireChild && !interventionProfile) await run();
      else {
        const result = await withProjectAttentionPolicy({
          api,
          target: resources.nameSchema.names.find((name) =>
            name.endsWith("__project_publish"),
          ),
          authorityUrl: `http://127.0.0.1:${fixture.server.address().port}/authority`,
          ...(interventionProfile
            ? {
                rules: interventionRules({
                  profile: interventionProfile,
                  names: resources.nameSchema.names,
                }),
              }
            : {}),
          work: run,
        });
        policyAudit = result.policy;
      }
      const state = await fixture.status();
      edge.assignClaudeRoles(native.events);
      await edge.close();
      const providerEvidence = await finishProviderEvidence({
        namespace,
        observations: edge.observations.filter(
          (entry) => entry.kind === "llm_client",
        ),
        measurements,
      });
      const timing = measurements.summary();
      const result = {
        kind: "actual_native_claude_project_pilot",
        fullTask,
        requireChild,
        workload,
        policyAudit,
        providerEvidence,
        measurementScope:
          "Client/proxy attempts only; independent provider capture is separate.",
        timing,
        modelObservations: edge.observations.filter(
          ({ kind }) => kind === "llm_client",
        ),
        arm,
        exitCode: native.exitCode,
        eventShapes: native.eventShapes,
        parentAgentCalls: native.parentAgentCalls,
        childFrames: native.childFrames,
        childMcpCalls: native.childMcpCalls,
        childProjectEdits: native.childProjectEdits,
        childProjectChecks: native.childProjectChecks,
        parentProjectEdits: native.parentProjectEdits,
        parentProjectChecks: native.parentProjectChecks,
        resultIsError: native.resultIsError,
        stdoutHash: native.stdoutHash,
        stderrHash: native.stderrHash,
        fixture: state,
        pilotCompleted:
          native.exitCode === 0 &&
          !native.resultIsError &&
          (requireChild
            ? native.parentAgentCalls === 1 &&
              native.childFrames > 0 &&
              native.childMcpCalls > 0
            : native.parentAgentCalls === 0 && native.childFrames === 0) &&
          state.calls.some((call) => call.name === "project_read" && call.ok) &&
          state.calls.some(
            (call) => call.name === "project_check" && call.ok,
          ) &&
          (fullTask
            ? state.modified.length >= 3 &&
              state.published &&
              state.lastCheck?.passed &&
              (!requireChild || native.childProjectEdits >= 3)
            : !state.modified.length && !state.published),
      };
      if (!requireChild && arm === "on") {
        result.pilotCompleted &&=
          state.authorityCalls.length > 0 &&
          ["get_remedy_plans", "execute_remedy_plan"].every((operation) =>
            edge.observations.some(
              (entry) =>
                entry.operation === operation &&
                entry.status === 200 &&
                !entry.logicalFailure,
            ),
          );
      }
      if (longWorkload) {
        if (interventionProfile) {
          result.interventions = summarizeInterventions({
            profile: interventionProfile,
            arm,
            fixture: state,
            helpers: Object.fromEntries(
              ["get_remedy_plans", "execute_remedy_plan"].map((operation) => [
                operation,
                edge.observations.filter(
                  (entry) =>
                    entry.operation === operation &&
                    entry.status === 200 &&
                    !entry.logicalFailure,
                ).length,
              ]),
            ),
          });
          result.pilotCompleted &&= result.interventions.qualified;
        }
        if (requireChild && arm === "on")
          result.pilotCompleted &&= [
            "get_remedy_plans",
            "execute_remedy_plan",
          ].every((operation) =>
            edge.observations.some(
              (entry) =>
                entry.operation === operation &&
                entry.status === 200 &&
                !entry.logicalFailure,
            ),
          );
        result.pilotCompleted &&=
          !requireChild || native.parentProjectChecks >= 1;
        result.pilotCompleted &&=
          !requireChild ||
          (native.parentProjectEdits === 0 &&
            native.childProjectEdits >= 14 &&
            native.childProjectChecks >= 28);
        result.qualification = qualifyLongWork({
          fixture: state,
          coreModelResponses: claudeCoreModelResponses({
            events: native.events,
            requireChild,
          }),
          providerEvidence,
          completed: result.pilotCompleted,
        });
        result.pilotCompleted &&= result.qualification.qualified;
      }
      result.clientMeasurementReady =
        timing.groups.llm_client.attempts > 0 &&
        timing.openRoundtrips === 0 &&
        result.modelObservations.every(
          (observation) =>
            observation.status >= 400 ||
            observation.modelFailed ||
            (!observation.observationError &&
              observation.role !== "unknown" &&
              observation.terminalObserved &&
              !observation.modelFailed &&
              observation.counterConflictFields.length === 0 &&
              observation.counters &&
              ["input", "output", "cacheRead", "cacheWrite"].every((key) =>
                Number.isFinite(observation.counters[key]),
              )),
        );
      result.unpricedClientAttempts = result.modelObservations.filter(
        (observation) =>
          !observation.counters ||
          observation.counters.input === null ||
          observation.counters.output === null,
      ).length;
      await writeFile(
        join(out, "pilot-summary.json"),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ kind: result.kind, arm, requireChild, completed: result.pilotCompleted, modelAttempts: timing.groups.llm_client.attempts, modelFailures: timing.groups.llm_client.failed, toolAttempts: timing.groups.mcp_tool.attempts, childProjectEdits: native.childProjectEdits, published: state.published, authorityCalls: state.authorityCalls.length, qualification: result.qualification })}\n`,
      );
      assert.ok(
        result.pilotCompleted && result.clientMeasurementReady,
        "native_claude_child_pilot_or_measurements_incomplete",
      );
    } finally {
      try {
        const cleaned = resources ? await cleanup(api, resources.proof) : null;
        const after = await api("GET", "/api/guardrails-policy");
        const deployment = await api("GET", "/api/guardrails-deployment");
        await writeFile(
          join(out, "restoration.json"),
          JSON.stringify({
            cleaned,
            policyContentRestored: after.contentHash === policy.contentHash,
            policyRevisionUnchanged: after.revision === policy.revision,
            deploymentOff: !deployment.active && !deployment.enabled,
          }),
        );
        assert.ok(
          after.contentHash === policy.contentHash &&
            !deployment.active &&
            !deployment.enabled,
        );
      } finally {
        try {
          if (edge) await edge.close();
          await fixture.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  },
);

async function runPilotProcess({ launch, out, timeoutMs }) {
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [],
    stderr = [];
  let bytes = 0,
    expired = false;
  const kill = (signal) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {}
  };
  const timer = setTimeout(() => {
    expired = true;
    kill("SIGTERM");
  }, timeoutMs);
  const force = setTimeout(() => kill("SIGKILL"), timeoutMs + 5000);
  const onInterrupt = () => kill("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  child.stdout.on("data", (part) => {
    bytes += part.length;
    if (bytes > 8 * 1024 * 1024) kill("SIGTERM");
    else stdout.push(part);
  });
  child.stderr.on("data", (part) => {
    if (stderr.reduce((n, p) => n + p.length, 0) < 1024 * 1024)
      stderr.push(part);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(launch.stdin);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const raw = Buffer.concat(stdout).toString("utf8");
    const err = Buffer.concat(stderr).toString("utf8");
    await writeFile(join(out, "private-native-stdout.jsonl"), raw, {
      mode: 0o600,
    });
    await writeFile(join(out, "private-native-stderr.txt"), err, {
      mode: 0o600,
    });
    const events = raw.split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const eventShapes = Object.fromEntries(
      [
        ...new Set(
          events.map(
            (event) =>
              `${event.type}:${event.subtype ?? ""}:${event.parent_tool_use_id ? "child" : "root"}`,
          ),
        ),
      ].map((key) => [
        key,
        events.filter(
          (event) =>
            `${event.type}:${event.subtype ?? ""}:${event.parent_tool_use_id ? "child" : "root"}` ===
            key,
        ).length,
      ]),
    );
    const toolUses = events.flatMap((event) =>
      (Array.isArray(event.message?.content) ? event.message.content : [])
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          child: !!event.parent_tool_use_id,
          name: block.name,
        })),
    );
    return {
      exitCode: expired ? "timeout" : exitCode,
      eventShapes,
      events,
      parentAgentCalls: toolUses.filter(
        ({ child, name }) => !child && ["Agent", "Task"].includes(name),
      ).length,
      childFrames: events.filter((event) => !!event.parent_tool_use_id).length,
      childMcpCalls: toolUses.filter(
        ({ child, name }) =>
          child && typeof name === "string" && name.startsWith("mcp__"),
      ).length,
      childProjectEdits: toolUses.filter(
        ({ child, name }) =>
          child && typeof name === "string" && name.includes("project_edit"),
      ).length,
      parentProjectChecks: toolUses.filter(
        ({ child, name }) =>
          !child && typeof name === "string" && name.endsWith("project_check"),
      ).length,
      childProjectChecks: toolUses.filter(
        ({ child, name }) =>
          child && typeof name === "string" && name.endsWith("project_check"),
      ).length,
      parentProjectEdits: toolUses.filter(
        ({ child, name }) =>
          !child && typeof name === "string" && name.endsWith("project_edit"),
      ).length,
      resultIsError: events.some(
        (event) => event.type === "result" && event.is_error,
      ),
      stdoutHash: h(raw),
      stderrHash: h(err),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
    kill("SIGKILL");
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}
