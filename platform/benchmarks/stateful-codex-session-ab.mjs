import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withDeployment } from "./live-ab.mjs";
import {
  aggregateSessionUsage,
  prefixChange,
} from "./session-cache-metrics.mjs";
import {
  createBoundary,
  freezeTools,
  parseOptions,
} from "./stateful-session-ab.mjs";

export async function runCodexEpisode({
  transport,
  gateway,
  agent,
  session,
  arm,
  tools,
  fixtureNames,
  pilot = false,
  requests = pilot ? 1 : 100,
  caseName = "append",
  emit = async () => {},
  signal,
  prices = null,
  expectedModel = "gpt-6.1-sol",
}) {
  assert.ok(
    ["gpt-6.1-sol", "gpt-5.5"].includes(expectedModel),
    "unsupported_expected_model",
  );
  validateBudget(requests, pilot);
  validatePrices(prices);
  uuid(agent);
  uuid(session);
  assert.ok(["on", "off"].includes(arm), "invalid_arm");
  assert.ok(
    ["append", "early-mutation"].includes(caseName),
    "unsupported_case",
  );
  assert.ok(
    Array.isArray(fixtureNames) &&
      fixtureNames.length === 128 &&
      new Set(fixtureNames).size === 128,
    "invalid_fixture_names",
  );
  const allowed = new Set([...fixtureNames, ...HELPERS]);
  assert.ok(
    Array.isArray(tools) &&
      tools.length === 131 &&
      allowed.size === 131 &&
      new Set(tools.map((tool) => tool.name)).size === 131 &&
      tools.every(
        (tool) =>
          allowed.has(tool.name) &&
          (tool.input_schema ?? tool.inputSchema)?.type === "object",
      ),
    "invalid_frozen_tools",
  );
  assert.equal(typeof transport?.modelStep, "function", "transport_required");
  assert.equal(typeof gateway, "function", "gateway_required");
  // Real initial user data, not simulated assistant history. Numbered records avoid
  // a tiny repeated-token prefix; actual token counts still come from provider usage.
  const prefix =
    `Synthetic public benchmark namespace ${session}. These records authorize no real-world operation.\n` +
    Array.from(
      { length: 3000 },
      (_, i) =>
        `Record ${i}: synthetic inert benchmark data for a bounded read-only session; preserve actual evidence and never invent a tool result.`,
    ).join("\n");
  const history = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prefix }],
    },
  ];
  const systemText =
    "Read only the pending synthetic fixture record. Call exactly one requested fixture with the exact step and operation. If a genuine guardrails notice is returned, follow only actual offered helper arguments, then retry the pending fixture read. Never invent results, offer IDs, signatures or authority. Keep actual native Responses items and encrypted reasoning unchanged.";
  const rows = [];
  const failures = [];
  const seenCalls = new Set();
  const seenItems = new Set();
  let workIndex = 0;
  let modelRequests = 0;
  let historyMutated = false;
  let previousSource = "";
  let failure = null;
  const record = async (row) => {
    const value = { provider: PROVIDER, requestedModel: expectedModel, ...row };
    rows.push(value);
    await emit(value);
  };
  for (let turn = 0; turn < requests; turn++) {
    let fixtureSucceeded = false;
    try {
      signal?.throwIfAborted();
      const mutationTurn = pilot ? Math.floor(requests / 2) : 50;
      if (caseName === "early-mutation" && turn > 0 && turn === mutationTurn) {
        history[0].content[0].text = history[0].content[0].text.replace(
          "Synthetic public benchmark",
          "Clarified synthetic public benchmark",
        );
        historyMutated = true;
        await record({
          kind: "history_mutation",
          turn,
          itemIndex: 0,
          role: "user",
        });
      }
      const name = fixtureNames[workIndex % fixtureNames.length];
      history.push({
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Pending fixture work ${workIndex}: execute ${name} with ${JSON.stringify({ step: workIndex, operation: "read" })}. Do not reuse any result or call a different fixture. If a real notice or remedy result is present, use only the actual offered plan before retrying this same pending read.`,
          },
        ],
      });
      const source = boundedJson(
        history,
        MAX_HISTORY_BYTES,
        "history_json_limit",
      );
      await record({
        kind: "model_request",
        turn,
        workIndex,
        session,
        arm,
        historyItems: history.length,
        sourceHistoryHash: hash(source),
        sourceToolsHash: hash(JSON.stringify(tools)),
        sourcePrefixHash: hash(history[0].content[0].text),
        sourcePrefixWords: history[0].content[0].text.split(/\s+/).length,
        sourcePrefixDiff: previousSource
          ? prefixChange(previousSource.slice(0, -1), source)
          : null,
      });
      previousSource = source;
      modelRequests++;
      let response;
      try {
        response = await transport.modelStep({
          session,
          arm,
          history: structuredClone(history),
          systemText,
          toolChoice: "auto",
        });
      } catch (error) {
        await record({
          kind: "model_response",
          turn,
          workIndex,
          ok: false,
          usage: null,
          rawUsage: null,
          error: safeError(error),
          status: null,
        });
        throw error;
      }
      const modelError = response.ok ? null : responseError(response);
      const modelConfirmed =
        response.modelIdentitySource === "provider-response-completed" &&
        matchesExpectedModel(response.model, expectedModel);
      await record({
        kind: "model_response",
        turn,
        workIndex,
        ok: response.ok === true,
        status: response.status ?? null,
        error: modelError,
        model: response.model ?? null,
        modelConfirmed,
        modelIdentitySource: modelConfirmed
          ? "provider-response-completed"
          : null,
        serviceTier: safeServiceTier(
          response.serviceTier ?? response.service_tier,
        ),
        usage: response.usage ?? null,
        rawUsage: response.rawUsage ?? null,
        latencyMs: response.latencyMs ?? null,
        ttftMs: response.ttftMs ?? null,
        evidence: response.evidence ?? null,
        nativeDiagnostics: response.nativeDiagnostics ?? null,
      });
      if (!response.ok) throw new Error(modelError);
      assert.ok(modelConfirmed, "unexpected_model_identity");
      assert.ok(
        Array.isArray(response.output) &&
          response.output.length > 0 &&
          response.output.length <= 128,
        "invalid_native_output",
      );
      boundedJson(response.output, MAX_OUTPUT_BYTES, "output_json_limit");
      assert.ok(
        response.output.every(
          (item) =>
            item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.type === "string",
        ),
        "invalid_native_output",
      );
      // Never convert output to assistant chat blocks or discard encrypted reasoning.
      history.push(...structuredClone(response.output));
      signal?.throwIfAborted();
      const calls = response.output.filter(
        (item) => item.type === "function_call",
      );
      assert.ok(
        calls.length > 0 && calls.length <= 4,
        "native_function_call_count",
      );
      assert.ok(
        calls.filter((call) => fixtureNames.includes(call.name)).length <= 1,
        "multiple_fixture_calls_for_pending_work",
      );
      const itemIds = new Set();
      for (const item of response.output) {
        if (item.id === undefined) continue;
        assert.ok(
          typeof item.id === "string" &&
            /^[A-Za-z0-9_-]{1,1024}(?![\s\S])/.test(item.id) &&
            !seenItems.has(item.id) &&
            !itemIds.has(item.id),
          "invalid_or_reused_item_id",
        );
        itemIds.add(item.id);
      }
      const batch = new Set();
      const parsed = calls.map((call) => {
        // Responses call_id is the execution/stamp identity; item.id is not.
        assert.ok(
          typeof call.call_id === "string" &&
            /^[A-Za-z0-9_-]{1,256}(?![\s\S])/.test(call.call_id) &&
            !seenCalls.has(call.call_id) &&
            !batch.has(call.call_id),
          "invalid_or_reused_call_id",
        );
        assert.ok(allowed.has(call.name), "unknown_model_tool");
        assert.ok(
          typeof call.arguments === "string" &&
            Buffer.byteLength(call.arguments) <= MAX_ARGUMENT_BYTES,
          "invalid_function_arguments",
        );
        let input;
        try {
          input = JSON.parse(call.arguments);
        } catch {
          throw new Error("invalid_function_arguments");
        }
        assert.ok(
          input && typeof input === "object" && !Array.isArray(input),
          "invalid_function_arguments",
        );
        if (fixtureNames.includes(call.name)) {
          assert.equal(call.name, name, "unexpected_fixture_tool");
          assert.equal(input.step, workIndex, "unexpected_fixture_step");
          assert.equal(input.operation, "read", "unexpected_fixture_operation");
        }
        batch.add(call.call_id);
        return { call, input };
      });
      for (const id of itemIds) seenItems.add(id);
      for (const { call, input } of parsed) {
        signal?.throwIfAborted();
        seenCalls.add(call.call_id);
        const started = performance.now();
        let output;
        try {
          output = await gateway({
            agent,
            session,
            method: "tools/call",
            params: {
              name: call.name,
              arguments: input,
              _meta: { "com.archestra/logicalToolCallId": call.call_id },
            },
          });
        } catch (error) {
          await record({
            kind: "tool_execution",
            turn,
            workIndex,
            name: call.name,
            callId: call.call_id,
            ok: false,
            error: safeError(error),
            latencyMs: performance.now() - started,
          });
          throw error;
        }
        assert.ok(
          output && Array.isArray(output.content),
          "gateway_content_missing",
        );
        const result = boundedJson(
          output,
          MAX_OUTPUT_BYTES,
          "gateway_result_limit",
        );
        const ok = output.isError !== true;
        await record({
          kind: "tool_execution",
          turn,
          workIndex,
          name: call.name,
          callId: call.call_id,
          ok,
          resultHash: hash(result),
          latencyMs: performance.now() - started,
        });
        if (call.name === HELPERS[0])
          await record({ kind: "remedy_evaluation", turn, workIndex, ok });
        if (call.name === HELPERS[1])
          await record({ kind: "remedy_execution", turn, workIndex, ok });
        history.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: result,
        });
        if (ok && fixtureNames.includes(call.name)) {
          fixtureSucceeded = true;
          await record({
            kind: "fixture_execution",
            turn,
            workIndex,
            name: call.name,
            callId: call.call_id,
            ok: true,
          });
        }
        if (!ok) {
          failures.push({
            turn,
            workIndex,
            category: "gateway_tool_result_error",
          });
          await record({
            kind: "tool_result_error",
            turn,
            workIndex,
            name: call.name,
            error: "gateway_tool_result_error",
          });
        }
      }
    } catch (error) {
      failure = safeError(error);
      failures.push({ turn, workIndex, category: failure });
      await record({
        kind: "episode_failure",
        turn,
        workIndex,
        error: failure,
      });
      break;
    } finally {
      if (fixtureSucceeded) workIndex++;
      await emit({
        kind: "history_snapshot",
        provider: PROVIDER,
        turn,
        workIndex,
        history: structuredClone(history),
      });
    }
  }
  const metrics = aggregateSessionUsage(rows, prices);
  const responses = rows.filter((row) => row.kind === "model_response");
  const observedModels = [
    ...new Set(responses.map((row) => row.model).filter(Boolean)),
  ];
  const observedServiceTiers = [
    ...new Set(responses.map((row) => row.serviceTier).filter(Boolean)),
  ];
  const knownInputTokens = responses
    .map((row) => row.usage?.totalInput)
    .filter((value) => Number.isFinite(value));
  const liveCaptured = responses.filter(
    (row) =>
      row.ok &&
      row.evidence?.modeLive === true &&
      row.evidence?.missing === false,
  ).length;
  const armProven = responses.filter(
    (row) =>
      row.ok &&
      (arm === "on"
        ? row.evidence?.rewriteProven === true
        : row.evidence?.offClean === true),
  ).length;
  const fixtureRequirement = pilot ? 1 : 100;
  const completed =
    !failure && modelRequests === requests && workIndex >= fixtureRequirement;
  return {
    kind: "session_summary",
    provider: PROVIDER,
    session,
    arm,
    pilot,
    case: caseName,
    scope: pilot
      ? "pilot_not_full_benchmark"
      : "native_responses_benchmark_episode",
    model: observedModels.length === 1 ? observedModels[0] : null,
    requestedModel: expectedModel,
    observedModels,
    observedServiceTiers,
    maxInputTokens: knownInputTokens.length
      ? Math.max(...knownInputTokens)
      : null,
    requestedModelRequests: requests,
    modelRequests,
    fixtureExecutions: workIndex,
    fixtureRequirement,
    pendingWorkIndex: workIndex,
    historyMutated,
    completed,
    failure,
    failures,
    missingModelRequests: requests - modelRequests,
    missingFixtureExecutions: Math.max(0, fixtureRequirement - workIndex),
    metrics,
    pricing:
      prices === null
        ? null
        : {
            ...prices,
            unit: "Caller-supplied USD per million tokens; not verified by runner",
          },
    evidence: {
      liveCaptured,
      armProven,
      expected: requests,
      complete: liveCaptured === requests && armProven === requests,
    },
    inconclusive:
      pilot ||
      !completed ||
      metrics.unknownUsage > 0 ||
      liveCaptured !== requests ||
      armProven !== requests,
    limitations: [
      ...(expectedModel === "gpt-5.5" ? [GPT55_LIMITATION] : []),
      "One adaptive native Responses episode, not independent statistical blocks",
      "Remedy/delegation cases are unsupported; incidental genuine helper calls are counted separately",
      "Initial user prefix targets over 20k tokens; actual provider tokenization is reported in usage, not invented",
      ...(prices === null
        ? [
            "Cost unavailable until model-specific prices are verified and supplied by caller",
          ]
        : []),
      ...(caseName === "early-mutation" && !historyMutated
        ? ["No mutation occurred within this pilot budget"]
        : []),
    ],
  };
}

export async function runCodexBenchmark(options, env = process.env) {
  validateOptions(options);
  const expectedModel = env.ARCHESTRA_BENCHMARK_CODEX_MODEL ?? "gpt-6.1-sol";
  assert.ok(
    ["gpt-6.1-sol", "gpt-5.5"].includes(expectedModel),
    "unsupported_expected_model",
  );
  const prices = options.prices ?? null;
  validatePrices(prices);
  assert.ok(
    env.ARCHESTRA_BENCHMARK_API_AUTH && env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
    "benchmark_credentials_required",
  );
  const resources = JSON.parse(await readFile(options.resources, "utf8"));
  uuid(resources.agentId);
  const output = resolve(options.out, options["run-id"]);
  await mkdir(output, { mode: 0o700 });
  const handles = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  let events;
  let snapshots;
  let transport;
  let policyBefore;
  let restored = true;
  let summary = {
    kind: "session_summary",
    provider: PROVIDER,
    requestedModel: expectedModel,
    arm: options.arm,
    pilot: options.pilot ?? false,
    requestedModelRequests: options.requests,
    modelRequests: 0,
    fixtureExecutions: 0,
    completed: false,
    inconclusive: true,
    failure: null,
    metrics: aggregateSessionUsage([], prices),
  };
  const cleanupApi = createBoundary({
    base: options.base,
    apiAuth: env.ARCHESTRA_BENCHMARK_API_AUTH,
  }).api;
  const emit = async (row) => {
    const file = row.kind === "history_snapshot" ? snapshots : events;
    assert.ok(file, "artifact_unavailable");
    await file.write(`${JSON.stringify(row)}\n`);
  };
  for (const signal of SIGNALS) process.on(signal, interrupt);
  try {
    events = await open(resolve(output, "events.jsonl"), "wx", 0o600);
    handles.push(events);
    snapshots = await open(resolve(output, "history.jsonl"), "wx", 0o600);
    handles.push(snapshots);
    const admin = createBoundary({
      base: options.base,
      apiAuth: env.ARCHESTRA_BENCHMARK_API_AUTH,
      signal: controller.signal,
    });
    policyBefore = policyIdentity(
      await admin.api("GET", "/api/guardrails-policy"),
    );
    const agent = await admin.api("GET", `/api/agents/${resources.agentId}`);
    assert.ok(
      agent.id === resources.agentId &&
        agent.agentType === "mcp_gateway" &&
        agent.toolExposureMode === "full",
      "resources_agent_mismatch",
    );
    await admin.api("GET", "/api/user-tokens/me");
    const { value: gatewayToken } = await admin.api(
      "GET",
      "/api/user-tokens/me/value",
    );
    assert.ok(
      typeof gatewayToken === "string" && gatewayToken.length,
      "gateway_token_missing",
    );
    const boundary = createBoundary({
      base: options.base,
      apiAuth: env.ARCHESTRA_BENCHMARK_API_AUTH,
      gatewayToken,
      signal: controller.signal,
    });
    let tools;
    restored = false;
    await withDeployment({
      api: boundary.api,
      onRestored: () => {
        restored = true;
      },
      work: async ({ set }) => {
        await set(true);
        const listing = await boundary.gateway({
          agent: resources.agentId,
          session: randomUUID(),
          method: "tools/list",
        });
        tools = freezeTools({ listing, resources });
      },
    });
    controller.signal.throwIfAborted();
    restored = false;
    await withDeployment({
      api: boundary.api,
      onRestored: () => {
        restored = true;
      },
      work: async ({ set }) => {
        const deployment = await set(options.arm === "on");
        controller.signal.throwIfAborted();
        const session = randomUUID();
        // Injection is a process boundary for offline tests; the CLI always imports
        // the genuine native transport and never loads authentication files here.
        const factory =
          options.createTransport ??
          (await import("./stateful-codex-transport.mjs"))
            .createStatefulCodexTransport;
        transport = await factory({
          proxyBase: options.base,
          captureBase: options["capture-base"],
          agent: resources.agentId,
          gatewayToken,
          passthroughKey: env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
          tools,
          namespace: session,
          env,
          privateEvidence: options.privateEvidence
            ? {
                ...options.privateEvidence,
                directory: resolve(output, "private-client-witnesses"),
              }
            : undefined,
        });
        await emit({
          kind: "session_started",
          provider: PROVIDER,
          requestedModel: expectedModel,
          session,
          arm: options.arm,
          pilot: options.pilot ?? false,
          deployment,
          toolCount: tools.length,
          toolsHash: hash(JSON.stringify(tools)),
          resourcePrefix: resources.nameSchema.prefix,
          policy: policyBefore,
        });
        summary = await (options.episodeRunner ?? runCodexEpisode)({
          transport,
          gateway: async (request) => {
            const sent = structuredClone(request);
            const result = await boundary.gateway(request);
            await transport.observeGatewayRoundtrip?.({
              request: sent,
              result,
            });
            return result;
          },
          agent: resources.agentId,
          session,
          arm: options.arm,
          tools,
          fixtureNames: resources.nameSchema.names,
          requests: options.requests,
          pilot: options.pilot ?? false,
          caseName: options.case,
          prices,
          expectedModel,
          emit,
          signal: controller.signal,
        });
      },
    });
  } catch (error) {
    summary = {
      ...summary,
      completed: false,
      inconclusive: true,
      failure: safeError(error),
    };
  } finally {
    try {
      await transport?.close();
    } catch (error) {
      summary = {
        ...summary,
        completed: false,
        inconclusive: true,
        failure: summary.failure ?? safeError(error),
        cleanupFailure: safeError(error),
        cleanupFailureDetails: error?.diagnostics
          ? {
              phase: [
                "listener",
                "native_and_handlers",
                "private_artifacts",
              ].includes(error.diagnostics.phase)
                ? error.diagnostics.phase
                : null,
              pendingSteps: Number.isInteger(error.diagnostics.pendingSteps)
                ? error.diagnostics.pendingSteps
                : null,
              pendingHandlers: Number.isInteger(
                error.diagnostics.pendingHandlers,
              )
                ? error.diagnostics.pendingHandlers
                : null,
              openSockets: Number.isInteger(error.diagnostics.openSockets)
                ? error.diagnostics.openSockets
                : null,
              nativeChildren: Number.isInteger(error.diagnostics.nativeChildren)
                ? error.diagnostics.nativeChildren
                : null,
            }
          : null,
      };
    }
    if (policyBefore) {
      try {
        const after = policyIdentity(
          await cleanupApi("GET", "/api/guardrails-policy"),
        );
        const unchanged =
          after.revision === policyBefore.revision &&
          after.hash === policyBefore.hash;
        summary.policy = { before: policyBefore, after, unchanged };
        if (!unchanged)
          summary = {
            ...summary,
            completed: false,
            inconclusive: true,
            failure: summary.failure ?? "policy_changed_during_episode",
          };
      } catch (error) {
        summary = {
          ...summary,
          completed: false,
          inconclusive: true,
          failure: summary.failure ?? "policy_checkpoint_failed",
          policyCheckFailure: safeError(error),
        };
      }
    }
    for (const signal of SIGNALS) process.off(signal, interrupt);
    summary = {
      ...summary,
      requestedModel: expectedModel,
      limitations: [
        ...new Set([
          ...(summary.limitations ?? []),
          ...(expectedModel === "gpt-5.5" ? [GPT55_LIMITATION] : []),
        ]),
      ],
      scope: options.pilot
        ? "pilot_not_full_benchmark"
        : "native_responses_benchmark_episode",
      restored,
    };
    try {
      if (events) await emit(summary);
      const file = await open(resolve(output, "summary.json"), "wx", 0o600);
      handles.push(file);
      await file.writeFile(`${JSON.stringify(summary, null, 2)}\n`);
    } finally {
      await Promise.all(handles.map((file) => file.close()));
    }
  }
  return summary;
}

const PROVIDER = "openai-responses";
const GPT55_LIMITATION =
  "Separate GPT-5.5 model lane; not paired with GPT-6.1-Sol results or prices";
const HELPERS = [
  "archestra__get_remedy_plans",
  "archestra__execute_remedy_plan",
  "archestra__ask_user",
];
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const SERVICE_TIERS = new Set([
  "auto",
  "default",
  "standard",
  "flex",
  "priority",
  "scale",
  "fast",
  "ultrafast",
]);
const SAFE_ERRORS = new Set([
  "unsupported_expected_model",
  "provider_quota",
  "provider_authentication_or_scope",
  "provider_http_error",
  "provider_invalid_schema",
  "provider_context_limit",
  "codex_ingress_failed",
  "unexpected_model_identity",
  "native_client_error",
  "native_output_not_json",
  "native_ingress_failed",
  "native_step_aborted",
  "native_no_responses_request",
  "native_client_failed",
  "incomplete_provider_response",
  "additional_native_model_calls",
  "model_step_failed",
  "invalid_native_output",
  "native_function_call_count",
  "invalid_or_reused_item_id",
  "invalid_or_reused_call_id",
  "invalid_function_arguments",
  "unknown_model_tool",
  "multiple_fixture_calls_for_pending_work",
  "gateway_content_missing",
  "history_json_limit",
  "output_json_limit",
  "gateway_result_limit",
  "deployment_verification_failed",
  "deployment_restoration_failed",
  "artifact_unavailable",
  "policy_identity_missing",
]);
function validateBudget(requests, pilot) {
  assert.equal(typeof pilot, "boolean", "invalid_pilot_flag");
  assert.ok(
    Number.isInteger(requests) &&
      (pilot
        ? requests >= 1 && requests <= 10
        : requests >= 100 && requests <= 200),
    "invalid_request_budget",
  );
}
function validatePrices(prices) {
  assert.ok(
    prices === null ||
      (typeof prices === "object" &&
        ["input", "read", "write", "output"].every(
          (key) => Number.isFinite(prices[key]) && prices[key] >= 0,
        )),
    "invalid_model_prices",
  );
}
function validateOptions(options) {
  assert.ok(options["isolated-dev"], "isolated_dev_required");
  for (const value of [options.base, options["capture-base"]]) {
    const url = new URL(value);
    assert.ok(
      url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
      "loopback_origin_required",
    );
  }
  assert.match(
    options["run-id"] ?? "",
    /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}(?![\s\S])/,
  );
  assert.ok(
    typeof options.resources === "string" && typeof options.out === "string",
  );
  assert.ok(["on", "off"].includes(options.arm), "invalid_arm");
  assert.ok(
    ["append", "early-mutation"].includes(options.case) ||
      (options.case === "remedy" &&
        typeof options.episodeRunner === "function"),
    "unsupported_case",
  );
  assert.ok(
    options["cache-mode"] === undefined || options["cache-mode"] === "rolling",
    "unsupported_codex_cache_mode",
  );
  validateBudget(options.requests, options.pilot ?? false);
}
function uuid(value) {
  assert.match(
    value ?? "",
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}(?![\s\S])/i,
  );
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
function matchesExpectedModel(actual, expected) {
  return (
    typeof actual === "string" &&
    (actual === expected ||
      (actual.startsWith(`${expected}-`) &&
        /^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(actual.slice(expected.length + 1))))
  );
}
function safeServiceTier(value) {
  return SERVICE_TIERS.has(value) ? value : null;
}
function boundedJson(value, limit, category) {
  const text = JSON.stringify(value);
  assert.ok(
    typeof text === "string" && Buffer.byteLength(text) <= limit,
    category,
  );
  return text;
}
function policyIdentity(value) {
  assert.ok(
    Number.isInteger(value?.revision) &&
      typeof value?.contentHash === "string" &&
      value.contentHash.length > 0 &&
      value.contentHash.length <= 256,
    "policy_identity_missing",
  );
  return { revision: value.revision, hash: value.contentHash };
}
function safeError(error) {
  if (error?.name === "AbortError") return "interrupted";
  if (error?.name === "TimeoutError") return "boundary_timeout";
  if (SAFE_ERRORS.has(error?.message)) return error.message;
  if (/^boundary_http_[45]\d{2}$/.test(error?.message ?? ""))
    return error.message;
  return error?.code === "ERR_ASSERTION"
    ? "protocol_or_scope_failure"
    : "benchmark_boundary_failure";
}
function responseError(response) {
  for (const value of [response.safeerror, response.safeError, response.error])
    if (SAFE_ERRORS.has(value)) return value;
  if (response.status === 429) return "provider_quota";
  if ([401, 403].includes(response.status))
    return "provider_authentication_or_scope";
  if (
    Number.isInteger(response.status) &&
    response.status >= 400 &&
    response.status <= 599
  )
    return "provider_http_error";
  return "model_step_failed";
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const summary = await runCodexBenchmark(
      parseOptions(process.argv.slice(2)),
    );
    console.info(JSON.stringify(summary));
    if (!summary.completed || !summary.restored) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: "session_summary",
        provider: PROVIDER,
        completed: false,
        failure: safeError(error),
      }),
    );
    process.exitCode = 1;
  }
}
