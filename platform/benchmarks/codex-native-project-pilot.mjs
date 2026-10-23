import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withDeployment } from "./live-ab.mjs";
import {
  isSubstantiveProjectCall,
  LONG_MAIN_TASK,
  LONG_PARENT_TASK,
  qualifyLongWork,
} from "./native-long-qualification.mjs";
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
import { runStatefulCodexNativeDelegation } from "./stateful-codex-native-delegation.mjs";
import { cleanup, createAdminApi, setup } from "./stateful-gateway-setup.mjs";

const [
  namespace,
  arm,
  mode = "delegation",
  workload = "short",
  profileName = "baseline",
] = process.argv.slice(2);
const interventionProfile = projectInterventionProfile(profileName);
assert.match(namespace ?? "", /^[a-z][a-z0-9-]{7,30}$/);
assert.ok(["off", "on"].includes(arm) && ["delegation", "main"].includes(mode));
const requireChild = mode === "delegation";
assert.ok(["short", "sequential"].includes(workload));
const longWorkload = workload === "sequential";
assert.ok(
  !interventionProfile || longWorkload,
  "interventions_require_long_workload",
);
const out = resolve("benchmarks/results", namespace);
await mkdir(out, { mode: 0o700 });
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
    const measurements = new RoundtripMeasurements();
    const executed = { parent: {}, child: {} };
    const eventRows = [];
    const coreResponses = new Set();
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
      const operation = (name) => name.split("__").at(-1);
      const prefix = `Benchmark namespace: ${namespace}.\nUse only advertised MCP project tools and genuine native collaboration tools. Never use host shell/files/web or invent results. Read ticket.txt and relevant files, reproduce failures before editing, fix the underlying bugs in multiple modules, and rerun immutable project_check checks until all pass. Do not change tests.\n`;
      let prompt = longWorkload
        ? `Benchmark namespace: ${namespace}.\n${requireChild ? LONG_PARENT_TASK : LONG_MAIN_TASK}`
        : requireChild
          ? `${prefix}Use actual spawn_agent exactly once. Give the child the complete project task, with this benchmark namespace. The child must use project MCP tools to read the ticket, reproduce failures, edit source modules, pass checks, and return its actual result without publishing or creating another child. Do not override models or permissions. Do not perform the child's edits yourself. Use actual wait_agent until its genuine final result arrives. Then independently run project_check. Receive its passing result before project_publish; do not batch these calls. Publish a verified summary and finish. Native acknowledgment and task identities must come from your executor, not fabricated messages.`
          : `${prefix}Do the task yourself without a child. Receive a passing project_check result before project_publish; do not batch these calls. Publish a verified summary and finish.`;
      if (interventionProfile) prompt += `\n${INTERVENTION_RECOVERY_TASK}`;
      let native;
      let policyAudit = null;
      const finishProviderEvidence = await openProviderEvidence({
        base: "http://127.0.0.1:19095",
      });
      const run = () =>
        withDeployment({
          api,
          work: async ({ set }) => {
            await set(arm === "on");
            const runOptions = {
              namespace,
              agent: resources.agentId,
              arm,
              mode: "full",
              proxyBase: options.base,
              captureBase: "http://127.0.0.1:19095",
              gatewayToken,
              passthroughKey: env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
              env,
              fixtureNames: resources.nameSchema.names,
              helperNames: [
                "archestra__get_remedy_plans",
                "archestra__execute_remedy_plan",
                "archestra__ask_user",
              ],
              measurements,
              rawHistoryPath: join(out, "private-native-history.jsonl"),
              emit: async (event) => {
                eventRows.push(event);
              },
              workload: {
                longWorkload,
                requireChild,
                prompt,
                onModelOutput: ({ role, responseMessageHash, calls }) => {
                  if (
                    role === (requireChild ? "child" : "parent") &&
                    responseMessageHash &&
                    calls.some(isSubstantiveProjectCall)
                  )
                    coreResponses.add(responseMessageHash);
                },
                allowCall: ({ role, name, childReturned }) => {
                  const op = operation(name);
                  if (!requireChild) return role === "parent";
                  if (role === "child") return op !== "project_publish";
                  if (op === "project_edit") return false;
                  return (
                    op !== "project_publish" ||
                    (childReturned && (executed.parent.project_check ?? 0) > 0)
                  );
                },
                onToolResult: ({ role, name, ok }) => {
                  if (ok) {
                    const op = operation(name);
                    executed[role][op] = (executed[role][op] ?? 0) + 1;
                  }
                },
                isComplete: () =>
                  fixture.isComplete() &&
                  (requireChild
                    ? (executed.child.project_edit ?? 0) >=
                        (longWorkload ? 14 : 3) &&
                      (executed.child.project_check ?? 0) >=
                        (longWorkload ? 28 : 2) &&
                      (executed.parent.project_check ?? 0) >= 1
                    : (executed.parent.project_edit ?? 0) >= 3 &&
                      (executed.parent.project_check ?? 0) >= 2),
              },
            };
            const probe = await runStatefulCodexNativeDelegation({
              ...runOptions,
              measurements: null,
              inventoryOnly: true,
              rawHistoryPath: join(out, "private-inventory-probe.jsonl"),
            });
            assert.ok(
              probe.inventoryProbeOnly &&
                probe.providerRequestAttempts === 0 &&
                !probe.cleanupFailure &&
                probe.nativeFixtureNames.length === 6 &&
                probe.nativeFixtureNames.every(
                  (name) => typeof name === "string",
                ),
            );
            native = await runStatefulCodexNativeDelegation({
              ...runOptions,
              nativeFixtureNames: probe.nativeFixtureNames,
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
      const providerEvidence = await finishProviderEvidence({
        namespace,
        observations: eventRows.filter(
          (event) => event.kind === "native_model_response",
        ),
        measurements,
      });
      const timing = measurements.summary();
      const summary = {
        kind: "actual_native_codex_project_pilot",
        arm,
        requireChild,
        workload,
        policyAudit,
        providerEvidence,
        pilotCompleted:
          native.completed &&
          state.published &&
          state.lastCheck?.passed === true &&
          (requireChild ||
            arm === "off" ||
            (state.authorityCalls.length > 0 &&
              (executed.parent.get_remedy_plans ?? 0) > 0 &&
              (executed.parent.execute_remedy_plan ?? 0) > 0)),
        failure: native.lastFailure,
        nativeExecutionSource: native.nativeExecutionSource,
        nativeExitCode: native.nativeExitCode,
        timing,
        taskCalls: executed,
        parent: native.parent,
        child: native.child,
        spawnCalls: native.spawnCalls,
        waitCalls: native.waitCalls,
        returnEvidence: {
          observed: native.terminalReturnObserved,
          admitted: native.terminalReturnAdmitted,
          exactValueMatched: native.returnEvidence.exactValueMatched,
        },
        fixture: state,
        measurementScope:
          "Native ingress attempts; independent provider capture is separate.",
      };
      if (longWorkload) {
        if (interventionProfile) {
          summary.interventions = summarizeInterventions({
            profile: interventionProfile,
            arm,
            fixture: state,
            helpers: Object.fromEntries(
              ["get_remedy_plans", "execute_remedy_plan"].map((operation) => [
                operation,
                (executed.parent[operation] ?? 0) +
                  (executed.child[operation] ?? 0),
              ]),
            ),
          });
          summary.pilotCompleted &&= summary.interventions.qualified;
        }
        summary.qualification = qualifyLongWork({
          fixture: state,
          coreModelResponses: coreResponses.size,
          providerEvidence,
          completed: summary.pilotCompleted,
        });
        summary.pilotCompleted &&= summary.qualification.qualified;
      }
      await writeFile(
        join(out, "private-native-summary.json"),
        JSON.stringify(native, null, 2),
        { mode: 0o600 },
      );
      await writeFile(
        join(out, "private-events.jsonl"),
        eventRows.map((event) => JSON.stringify(event)).join("\n"),
        { mode: 0o600 },
      );
      await writeFile(
        join(out, "pilot-summary.json"),
        JSON.stringify(summary, null, 2),
      );
      process.stdout.write(
        `${JSON.stringify({ kind: summary.kind, arm, completed: summary.pilotCompleted, failure: summary.failure, parentRequests: native.parent.modelRequests, childRequests: native.child.modelRequests, taskCalls: executed, modified: state.modified, published: state.published, modelAttempts: timing.groups.llm_client.attempts, toolAttempts: timing.groups.mcp_tool.attempts, qualification: summary.qualification })}\n`,
      );
      assert.ok(
        summary.pilotCompleted,
        "native_codex_project_pilot_incomplete",
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
        await fixture.close();
      }
    }
  },
);
