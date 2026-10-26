import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { withDeployment } from "./live-ab.mjs";
import {
  aggregateSessionUsage,
  prefixChange,
} from "./session-cache-metrics.mjs";
import { createStatefulClaudeTransport } from "./stateful-claude-transport.mjs";
import { captureNativeToolDeclarations } from "./stateful-native-tool-declarations.mjs";

export function parseOptions(args) {
  const { values } = parseArgs({
    args,
    options: {
      "isolated-dev": { type: "boolean", default: false },
      "run-id": { type: "string" },
      resources: { type: "string" },
      requests: { type: "string" },
      pilot: { type: "boolean", default: false },
      arm: { type: "string" },
      case: { type: "string", default: "append" },
      base: { type: "string", default: "http://127.0.0.1:9000" },
      "capture-base": { type: "string", default: "http://127.0.0.1:19092" },
      "cache-mode": { type: "string", default: "rolling" },
      out: { type: "string", default: "benchmarks/results" },
    },
  });
  assert.ok(values["isolated-dev"], "isolated_dev_required");
  assert.match(values["run-id"] ?? "", /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$/);
  assert.ok(values.resources, "resources_required");
  assert.ok(["on", "off"].includes(values.arm), "invalid_arm");
  assert.ok(
    ["append", "early-mutation"].includes(values.case),
    "unsupported_case: remedy/delegation require real policy/child orchestration",
  );
  const requests = Number(values.requests ?? (values.pilot ? "1" : "100"));
  validateRequests({ requests, pilot: values.pilot });
  assert.ok(["rolling", "system-only"].includes(values["cache-mode"]));
  loopback(values.base);
  loopback(values["capture-base"]);
  return { ...values, requests };
}

// Only these HTTP boundaries receive credentials. No arbitrary URL/method dispatch.
export function createBoundary({ base, apiAuth, gatewayToken, signal }) {
  const origin = loopback(base);
  let sequence = 0;
  const request = async ({
    path,
    method,
    body,
    token,
    session,
    restoration,
  }) => {
    if (!restoration) signal?.throwIfAborted();
    const response = await fetch(new URL(path, origin), {
      method,
      redirect: "error",
      signal: restoration
        ? AbortSignal.timeout(30000)
        : signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
      headers: {
        authorization: token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session
          ? {
              "X-Appa-Session-ID": session,
              "MCP-Protocol-Version": "2025-11-25",
            }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.ok(response.ok, `boundary_http_${response.status}`);
    const text = await response.text();
    assert.ok(
      Buffer.byteLength(text) <= 16 * 1024 * 1024,
      "boundary_response_limit",
    );
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      const messages = text.split(/\r?\n\r?\n/).flatMap((frame) => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        return data && data !== "[DONE]" ? [JSON.parse(data)] : [];
      });
      const result = messages.find((item) => item.id === body.id);
      assert.ok(result, "gateway_missing_response");
      return result;
    }
    return JSON.parse(text);
  };
  return {
    async api(method, path, body) {
      const deployment = path === "/api/guardrails-deployment";
      assert.ok(
        (deployment && ["GET", "PUT"].includes(method)) ||
          (method === "GET" &&
            (/^\/api\/agents\/[a-f0-9-]{36}$/.test(path) ||
              [
                "/api/user-tokens/me",
                "/api/user-tokens/me/value",
                "/api/guardrails-policy",
              ].includes(path))),
        "admin_scope_refused",
      );
      assert.ok(apiAuth, "api_auth_required");
      // Deployment restoration must remain possible after interruption.
      return request({
        path,
        method,
        body,
        token: apiAuth,
        restoration: deployment,
      });
    },
    async gateway({ agent, session, method, params = {} }) {
      uuid(agent);
      assert.match(
        session,
        /^[a-z0-9][a-z0-9._:-]{0,239}(?![\s\S])/i,
        "invalid_platform_session",
      );
      assert.ok(
        ["tools/list", "tools/call"].includes(method),
        "gateway_method_refused",
      );
      assert.ok(gatewayToken, "gateway_token_required");
      const id = ++sequence;
      const response = await request({
        path: `/v1/mcp/${agent}`,
        method: "POST",
        token: `Bearer ${gatewayToken}`,
        session,
        body: { jsonrpc: "2.0", id, method, params },
      });
      assert.ok(
        response.jsonrpc === "2.0" && response.id === id && !response.error,
        "gateway_protocol_error",
      );
      assert.ok(
        response.result && typeof response.result === "object",
        "gateway_result_missing",
      );
      return response.result;
    },
  };
}

export function freezeTools({ listing, resources }) {
  const expected = resources.nameSchema?.names;
  assert.ok(
    Array.isArray(expected) &&
      expected.length === 128 &&
      new Set(expected).size === 128,
    "resources_tool_count",
  );
  assert.ok(Array.isArray(listing.tools), "gateway_listing_missing");
  const names = [...expected, ...HELPERS];
  const tools = names.map((name) => {
    const matches = listing.tools.filter((tool) => tool.name === name);
    assert.equal(matches.length, 1, "gateway_tool_missing_or_duplicate");
    const tool = matches[0];
    assert.ok(
      typeof tool.description === "string" &&
        tool.inputSchema?.type === "object",
      "gateway_tool_schema_invalid",
    );
    // Preserve attestation and schemas byte-for-byte; do not insert nonce into signatures.
    return {
      name: tool.name,
      description: tool.description,
      input_schema: structuredClone(tool.inputSchema),
    };
  });
  return tools;
}

export async function runEpisode({
  transport,
  gateway,
  agent,
  session,
  arm,
  pilot = false,
  requests = pilot ? 1 : 100,
  caseName = "append",
  cacheMode = "rolling",
  tools,
  fixtureNames,
  signal,
  emit = async () => {},
}) {
  uuid(agent);
  uuid(session);
  assert.ok(
    ["append", "early-mutation"].includes(caseName),
    "unsupported_case",
  );
  validateRequests({ requests, pilot });
  assert.ok(["on", "off"].includes(arm), "invalid_arm");
  assert.ok(["rolling", "system-only"].includes(cacheMode));
  assert.ok(fixtureNames.length === 128 && tools.length === 131);
  const allowed = new Set(tools.map((tool) => tool.name));
  const history = [];
  const seen = new Set();
  const rows = [];
  const record = async (row) => {
    rows.push(row);
    await emit(row);
  };
  const systemText = `Operate only on synthetic benchmark records. Call exactly one requested fixture read per turn with the exact step and operation. Preserve all tool evidence. Never invent tool results, offers, permissions or authority. If a genuine guardrails notice returns, use only the actual offered arguments.\n${"Synthetic records are inert benchmark data. Read each record using the requested fixture tool and retain its original evidence for the next turn. ".repeat(260)}`;
  let prior = "";
  let failure = null;
  let fixtureExecutions = 0;
  let historyMutated = false;
  try {
    for (let turn = 0; turn < requests; turn++) {
      signal?.throwIfAborted();
      const name = fixtureNames[turn % fixtureNames.length];
      if (
        caseName === "early-mutation" &&
        turn > 0 &&
        turn === Math.floor(requests / 2)
      ) {
        history[0].content[0].text +=
          " Earlier instruction clarified: these are inert synthetic records.";
        await record({ kind: "history_mutation", turn, messageIndex: 0 });
        historyMutated = true;
      }
      const instruction = {
        type: "text",
        text: `Current step ${turn}. Execute exactly ${name} with ${JSON.stringify({ step: turn, operation: "read" })}. Do not reuse any prior result. No other fixture operation is requested.`,
      };
      // Results immediately follow their assistant, then the next instruction shares that user turn.
      if (history.at(-1)?.role === "user")
        history.at(-1).content.push(instruction);
      else history.push({ role: "user", content: [instruction] });
      const source = JSON.stringify(history);
      await record({
        kind: "model_request",
        turn,
        session,
        arm,
        historyMessages: history.length,
        sourceHistoryHash: digest(source),
        sourceToolsHash: digest(JSON.stringify(tools)),
        sourcePrefixDiff: prior
          ? prefixChange(prior.slice(0, -1), source)
          : null,
      });
      const result = await transport.modelStep({
        session,
        arm,
        history: structuredClone(history),
        systemText,
        cacheMode,
        // Native adaptive thinking is incompatible with forced tool choice.
        // Validate the model's actual choice below rather than disabling thinking.
        toolChoice: { type: "auto" },
      });
      const modelError = result.ok ? null : transportError(result);
      await record({
        kind: "model_response",
        turn,
        ok: result.ok,
        status: result.status ?? null,
        error: modelError,
        usage: result.usage ?? null,
        rawUsage: result.rawUsage ?? null,
        model: result.model ?? null,
        providerErrorType: result.providerErrorType ?? null,
        providerErrorCategory: result.providerErrorCategory ?? null,
        nativeSettings: result.nativeSettings ?? null,
        startUnixMs: result.startUnixMs ?? null,
        latencyMs: result.latencyMs ?? null,
        ttftMs: result.ttftMs ?? null,
        evidence: result.evidence ?? null,
        additionalNativeCalls: result.additionalNativeCalls ?? null,
      });
      if (!result.ok) throw new Error(modelError);
      assert.ok(
        Array.isArray(result.content) && result.content.length,
        "model_content_missing",
      );
      const calls = result.content.filter((block) => block.type === "tool_use");
      assert.ok(calls.length > 0 && calls.length <= 4, "model_tool_call_count");
      for (const call of calls) {
        assert.ok(
          typeof call.id === "string" &&
            /^[A-Za-z0-9_-]{1,4096}$/.test(call.id) &&
            !seen.has(call.id),
          "invalid_or_reused_tool_id",
        );
        // The gateway ignores logical metadata above 256 bytes; never truncate signed IDs.
        assert.ok(
          Buffer.byteLength(call.id, "utf8") <= 256,
          "logical_tool_call_id_too_long",
        );
        assert.ok(allowed.has(call.name), "unknown_model_tool");
        assert.ok(
          call.input &&
            typeof call.input === "object" &&
            !Array.isArray(call.input),
          "invalid_tool_input",
        );
        // Native notices may carry private signed fields. Never reconstruct or strip them.
        if (fixtureNames.includes(call.name)) {
          assert.equal(call.name, name, "unexpected_fixture_tool");
          assert.equal(call.input.step, turn, "unexpected_fixture_step");
          assert.equal(
            call.input.operation,
            "read",
            "unexpected_fixture_operation",
          );
        }
        seen.add(call.id);
      }
      history.push({
        role: "assistant",
        content: structuredClone(result.content),
      });
      const results = [];
      for (const call of calls) {
        signal?.throwIfAborted();
        const started = performance.now();
        let output;
        try {
          output = await gateway({
            agent,
            session,
            method: "tools/call",
            params: {
              name: call.name,
              arguments: structuredClone(call.input),
              _meta: { "com.archestra/logicalToolCallId": call.id },
            },
          });
        } catch (error) {
          await record({
            kind: "tool_execution",
            turn,
            ok: false,
            name: call.name,
            callId: call.id,
            error: publicError(error),
          });
          throw error;
        }
        assert.ok(Array.isArray(output.content), "gateway_content_missing");
        const ok = output.isError !== true;
        await record({
          kind: "tool_execution",
          turn,
          ok,
          name: call.name,
          callId: call.id,
          latencyMs: performance.now() - started,
          resultHash: digest(JSON.stringify(output)),
        });
        if (call.name === HELPERS[0])
          await record({ kind: "remedy_evaluation", turn, ok });
        if (call.name === HELPERS[1])
          await record({ kind: "remedy_execution", turn, ok });
        if (ok && fixtureNames.includes(call.name)) fixtureExecutions++;
        // The complete MCP envelope preserves _meta/structuredContent receipts in history.
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(output),
          ...(ok ? {} : { is_error: true }),
        });
      }
      history.push({ role: "user", content: results });
      prior = source;
      await emit({
        kind: "history_snapshot",
        turn,
        history: structuredClone(history),
      });
    }
  } catch (error) {
    failure = publicError(error);
    await record({ kind: "episode_failure", error: failure });
  }
  const responses = rows.filter((row) => row.kind === "model_response");
  const hasOneHourWrites = responses.some((row) => row.usage?.cacheWrite1h > 0);
  const metrics = aggregateSessionUsage(
    rows,
    hasOneHourWrites
      ? null
      : {
          input: 2,
          read: 0.1,
          write: 2.5,
          output: 10,
        },
  );
  const liveCaptured = responses.filter(
    (row) => row.evidence?.modeLive === true && row.evidence?.missing === false,
  ).length;
  const armProven = responses.filter((row) =>
    arm === "on"
      ? row.evidence?.rewriteProven === true
      : row.evidence?.offClean === true,
  ).length;
  return {
    kind: "session_summary",
    session,
    arm,
    pilot,
    scope: pilot ? "pilot_not_full_benchmark" : "full_benchmark_episode",
    case: caseName,
    historyMutated,
    requestedModelRequests: requests,
    completed:
      !failure &&
      metrics.attempts === requests &&
      fixtureExecutions >= requests,
    failure,
    fixtureExecutions,
    missingModelRequests: requests - metrics.attempts,
    missingFixtureExecutions: Math.max(0, requests - fixtureExecutions),
    evidence: {
      liveCaptured,
      armProven,
      expected: requests,
      complete: liveCaptured === requests && armProven === requests,
    },
    inconclusive:
      pilot ||
      Boolean(failure) ||
      fixtureExecutions < requests ||
      liveCaptured !== requests ||
      armProven !== requests,
    metrics,
    pricing: {
      input: 2,
      read: 0.1,
      write5m: 2.5,
      output: 10,
      unit: "USD per million tokens, 5m API-equivalent estimate only",
    },
    limitations: [
      ...(pilot ? ["Bounded pilot only; not a full benchmark"] : []),
      ...(caseName === "early-mutation" && !historyMutated
        ? ["No early mutation occurred: at least two requests are required"]
        : []),
      "One adaptive episode, not independent statistical blocks",
      "Remedy/delegation scenarios not implemented; incidental actual remedy calls counted only",
      "Resource namespaces must differ between arms to isolate the earlier tool cache prefix",
      ...(hasOneHourWrites
        ? ["Cost unavailable: observed 1h writes have no supplied price"]
        : []),
    ],
  };
}

export async function runBenchmark(options, env = process.env) {
  // Validate all outbound origins before reading credentials or resource artifacts.
  loopback(options.base);
  loopback(options["capture-base"]);
  assert.ok(options["isolated-dev"]);
  validateRequests({
    requests: options.requests,
    pilot: options.pilot ?? false,
  });
  assert.ok(
    env.ARCHESTRA_BENCHMARK_API_AUTH && env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
    "benchmark_credentials_required",
  );
  const resources = JSON.parse(await readFile(options.resources, "utf8"));
  uuid(resources.agentId);
  const output = resolve(options.out, options["run-id"]);
  await mkdir(output, { mode: 0o700 }); // Existing run IDs are refused, never overwritten.
  const events = await open(resolve(output, "events.jsonl"), "wx", 0o600);
  const snapshots = await open(resolve(output, "history.jsonl"), "wx", 0o600);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const signal of SIGNALS) process.on(signal, interrupt);
  const emit = (row) =>
    (row.kind === "history_snapshot" ? snapshots : events).write(
      `${JSON.stringify(row)}\n`,
    );
  let transport;
  let summary;
  let restored = false;
  try {
    const admin = createBoundary({
      base: options.base,
      apiAuth: env.ARCHESTRA_BENCHMARK_API_AUTH,
      signal: controller.signal,
    });
    const policyBefore = await admin.api("GET", "/api/guardrails-policy");
    assert.ok(
      Number.isInteger(policyBefore.revision) &&
        typeof policyBefore.contentHash === "string",
      "policy_identity_missing",
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
    await withDeployment({
      api: boundary.api,
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
    await withDeployment({
      api: boundary.api,
      onRestored: () => {
        restored = true;
      },
      work: async ({ set }) => {
        const deployment = await set(options.arm === "on");
        // Never seed an episode/root under the wrong deployment arm.
        const session = randomUUID();
        if (options.nativeToolNames) {
          assert.deepEqual(
            options.nativeToolNames,
            ["Agent"],
            "only_native_agent_discovery_supported",
          );
          const discovery = await captureNativeToolDeclarations({
            agent: resources.agentId,
            session,
            gatewayToken,
            passthroughKey: env.ARCHESTRA_BENCHMARK_PASSTHROUGH_KEY,
            env,
            names: options.nativeToolNames,
          });
          tools = [...tools, ...discovery.tools];
          await emit({
            kind: "native_declaration_discovery",
            requestedNames: discovery.requestedNames,
            providerRequests: discovery.providerRequests,
            admittedMessages: discovery.admittedMessages,
            additionalMessages: discovery.additionalMessages,
          });
        }
        transport = await createStatefulClaudeTransport({
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
          session,
          arm: options.arm,
          pilot: options.pilot ?? false,
          deployment,
          toolCount: tools.length,
          toolsHash: digest(JSON.stringify(tools)),
          resourcePrefix: resources.nameSchema.prefix,
          policy: {
            revision: policyBefore.revision,
            hash: policyBefore.contentHash,
          },
        });
        summary = await (options.episodeRunner ?? runEpisode)({
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
          requests: options.requests,
          pilot: options.pilot ?? false,
          caseName: options.case,
          cacheMode: options["cache-mode"],
          tools,
          fixtureNames: resources.nameSchema.names,
          signal: controller.signal,
          emit,
        });
        const policyAfter = await admin.api("GET", "/api/guardrails-policy");
        summary.policy = {
          revision: policyBefore.revision,
          hash: policyBefore.contentHash,
          unchanged:
            policyAfter.revision === policyBefore.revision &&
            policyAfter.contentHash === policyBefore.contentHash,
        };
        if (!summary.policy.unchanged) {
          summary.completed = false;
          summary.inconclusive = true;
          summary.failure = "policy_changed_during_episode";
        }
      },
    });
  } catch (error) {
    summary = {
      ...summary,
      kind: "session_summary",
      completed: false,
      failure: publicError(error),
    };
  } finally {
    try {
      await transport?.close();
    } catch (error) {
      summary = { ...summary, completed: false, failure: publicError(error) };
    } finally {
      for (const signal of SIGNALS) process.off(signal, interrupt);
      summary = {
        ...summary,
        pilot: options.pilot ?? false,
        scope: options.pilot
          ? "pilot_not_full_benchmark"
          : "full_benchmark_episode",
        restored,
      };
      await emit(summary);
      const file = await open(resolve(output, "summary.json"), "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(summary, null, 2)}\n`);
      } finally {
        await file.close();
        await events.close();
        await snapshots.close();
      }
    }
  }
  return summary;
}

const HELPERS = [
  "archestra__get_remedy_plans",
  "archestra__execute_remedy_plan",
  "archestra__ask_user",
];
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const SAFE_ERRORS = new Set([
  "provider_quota",
  "provider_authentication_or_scope",
  "provider_http_error",
  "native_client_error",
  "native_output_not_json",
  "native_ingress_failed",
  "native_step_aborted",
  "native_no_messages_request",
  "native_client_failed",
  "incomplete_provider_message",
  "additional_native_model_calls",
  "model_step_failed",
  "logical_tool_call_id_too_long",
  "deployment_verification_failed",
  "deployment_restoration_failed",
]);
function validateRequests({ requests, pilot }) {
  assert.equal(typeof pilot, "boolean", "invalid_pilot_flag");
  assert.ok(
    Number.isInteger(requests) &&
      (pilot
        ? requests >= 1 && requests <= 10
        : requests >= 100 && requests <= 200),
    pilot ? "pilot_requests_must_be_1_to_10" : "requests_must_be_100_to_200",
  );
}
function transportError(result) {
  if (SAFE_ERRORS.has(result.error)) return result.error;
  if (result.status === 429) return "provider_quota";
  if ([401, 403].includes(result.status))
    return "provider_authentication_or_scope";
  if (
    Number.isInteger(result.status) &&
    result.status >= 400 &&
    result.status <= 599
  )
    return "provider_http_error";
  return "model_step_failed";
}
function uuid(value) {
  assert.match(
    value ?? "",
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i,
  );
}
function loopback(value) {
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
  return url;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function publicError(error) {
  if (error?.name === "AbortError") return "interrupted";
  if (error?.name === "TimeoutError") return "boundary_timeout";
  if (SAFE_ERRORS.has(error?.message)) return error.message;
  if (
    new Set([
      "native_declaration_names_invalid",
      "native_declaration_options_invalid",
      "native_declaration_body_too_large",
      "native_declaration_body_invalid",
      "native_declarations_not_captured",
      "native_declarations_missing",
      "native_declarations_ambiguous",
      "native_declaration_schema_invalid",
      "native_declaration_interrupted",
      "native_declaration_timeout",
      "native_declaration_listener_failed",
      "native_declaration_client_failed",
      "native_declaration_capture_failed",
      "native_declaration_cleanup_failed",
    ]).has(error?.code)
  )
    return error.code;
  if (
    new Set([
      "policy_identity_missing",
      "resources_agent_mismatch",
      "gateway_tool_missing_or_duplicate",
      "gateway_listing_missing",
      "gateway_tool_schema_missing",
      "invalid_frozen_tools",
      "invalid_fixture_names",
      "gateway_token_missing",
    ]).has(error?.message)
  )
    return error.message;
  if (/^boundary_http_[45]\d{2}$/.test(error?.message ?? ""))
    return error.message;
  if (error?.code === "ERR_ASSERTION") return "protocol_or_scope_failure";
  return "benchmark_boundary_failure";
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runBenchmark(parseOptions(process.argv.slice(2)));
    console.info(JSON.stringify(result));
    if (!result.completed || !result.restored) process.exitCode = 1;
  } catch (error) {
    console.error(
      JSON.stringify({
        kind: "session_summary",
        completed: false,
        failure: publicError(error),
      }),
    );
    process.exitCode = 1;
  }
}
