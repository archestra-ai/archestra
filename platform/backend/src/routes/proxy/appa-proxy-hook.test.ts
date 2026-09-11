import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createAnthropicTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { useMswServer } from "@/test/msw";
import { ApiError } from "@/types";
import {
  anthropicAdapterFactory,
  kimiAdapterFactory,
  openAiResponsesAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import {
  type AppaProxyHookConfig,
  AppaProxyHookSession,
  canonicalJsonObject,
  deriveAppaOwnerScope,
} from "./appa-proxy-hook";
import anthropicProxyRoutes from "./routes/anthropic";
import kimiProxyRoutes from "./routes/kimi";
import openAiProxyRoutes from "./routes/openai";

const runtimeUrl = "http://appa-runtime.openappa.svc.cluster.local:18787";
const hookUrl = `${runtimeUrl}/hook`;
const hookConfig: AppaProxyHookConfig = {
  url: runtimeUrl,
  timeoutMs: 100,
  sessionHmacSecret: "a".repeat(32),
};
const profileId = "00000000-0000-4000-8000-000000000001";

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper, not React
const server = useMswServer();

function acknowledge(event: { event: string }) {
  return { decision: event.event === "tool_call" ? "allow_call" : "ack" };
}

function open(params: {
  config?: AppaProxyHookConfig;
  sessionId?: string;
  ownerScopeHash?: string;
  toolResults?: Parameters<typeof AppaProxyHookSession.open>[0]["toolResults"];
  nativeCodexExecution?: boolean;
  prepareInboundResults?: Parameters<
    typeof AppaProxyHookSession.open
  >[0]["prepareInboundResults"];
}) {
  return AppaProxyHookSession.open({
    config: params.config ?? hookConfig,
    profileId,
    ownerScopeHash: params.ownerScopeHash ?? "owner-a",
    clientSessionId: params.sessionId ?? "conversation-a",
    modelInput: {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    },
    toolResults: params.toolResults ?? [],
    prepareInboundResults: params.prepareInboundResults,
    nativeCodexExecution: params.nativeCodexExecution,
  });
}

function outbound(id = "call_1") {
  const emittedArguments = '{"city":"SF"}';
  return {
    id,
    emittedName: "get_weather",
    emittedArguments,
    emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
    targetName: "get_weather",
    targetArguments: { city: "SF" },
  };
}

function nativeOutbound(params: {
  id: string;
  name: "functions.exec_command" | "functions.write_stdin";
  arguments: string;
}) {
  return {
    id: params.id,
    emittedName: params.name,
    emittedArguments: params.arguments,
    emittedArgumentsCanonical: canonicalJsonObject(params.arguments),
    targetName: params.name,
    targetArguments: JSON.parse(params.arguments) as Record<string, unknown>,
  };
}

describe("OpenAPPA durable proxy correlation", () => {
  beforeEach(() => {
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as { event: string };
        return HttpResponse.json(acknowledge(event));
      }),
    );
  });

  test("enforces the owner budget atomically without blocking existing roots", async () => {
    const limited = { ...hookConfig, maxSessionsPerOwner: 1 };
    const ids = ["quota-a", "quota-b"];
    const attempts = await Promise.allSettled(
      ids.map((sessionId) => open({ config: limited, sessionId })),
    );
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected" && rejected.reason.message,
    ).toContain("session limit exceeded");
    const winnerIndex = attempts.findIndex(
      (result) => result.status === "fulfilled",
    );
    const winner = attempts[winnerIndex];
    if (winner.status !== "fulfilled") throw new Error("Expected one winner");
    await winner.value.finish();
    const resumed = await open({
      config: limited,
      sessionId: ids[winnerIndex],
    });
    expect(resumed.rootId).toBe(winner.value.rootId);
    await resumed.finish();
    const separateOwner = await open({
      config: limited,
      ownerScopeHash: "owner-b",
      sessionId: "quota-c",
    });
    await separateOwner.finish();
  });

  test("enforces call budgets before remote authorization without resetting the root", async () => {
    const limited = { ...hookConfig, maxCallsPerSession: 1 };
    let proposals = 0;
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as { event: string };
        if (event.event === "tool_call") proposals++;
        return HttpResponse.json(acknowledge(event));
      }),
    );
    const first = await open({ config: limited });
    await first.authorizeOutboundToolCalls([outbound()]);
    await first.finish();
    const second = await open({
      config: limited,
      toolResults: [{ id: "call_1", content: "synthetic", isError: false }],
    });
    await expect(
      second.authorizeOutboundToolCalls([outbound("call_2")]),
    ).rejects.toThrow("call limit exceeded");
    expect(proposals).toBe(1);
    await second.finish();
    const third = await open({ config: limited });
    expect(third.rootId).toBe(first.rootId);
    await third.finish();
  });

  test("quarantines an authorized call when the response closes after turn release", async () => {
    const session = await open({ sessionId: "undelivered-after-release" });
    await session.authorizeOutboundToolCalls([outbound()]);
    await session.finish();

    await session.quarantineUndeliveredCalls();

    await expect(
      open({ sessionId: "undelivered-after-release" }),
    ).rejects.toThrow("quarantined");
  });

  test("admits a legacy acknowledged result without a V1 receipt exactly once", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );

    const first = await open({});
    await first.authorizeOutboundToolCalls([outbound()]);
    await first.finish();
    const second = await open({
      toolResults: [
        {
          id: "call_1",
          content: { temperature: 70 },
          isError: false,
          claimedCall: { name: "get_weather", rawArguments: '{"city":"SF"}' },
        },
      ],
    });
    await second.finish();
    const third = await open({
      toolResults: [
        {
          id: "call_1",
          content: { temperature: 70 },
          isError: false,
          claimedCall: { name: "get_weather", rawArguments: '{"city":"SF"}' },
        },
      ],
    });
    await third.finish();

    expect(first.rootId).toBe(second.rootId);
    expect(second.rootId).toBe(third.rootId);
    expect(
      events.filter((event) => event.event === "session_start"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.event === "tool_result"),
    ).toHaveLength(1);
  });

  test("runs a trusted inbound adapter before APPA admits the result", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );
    const first = await open({ sessionId: "pre-admit" });
    await first.authorizeOutboundToolCalls([outbound()]);
    await first.finish();

    const prepared: string[] = [];
    const second = await open({
      sessionId: "pre-admit",
      toolResults: [{ id: "call_1", content: "wire payload" }],
      prepareInboundResults: async (results) => {
        prepared.push(String(results[0]?.content));
        return [{ id: "call_1", content: "trusted presentation" }];
      },
    });
    await second.finish();

    expect(prepared).toEqual(["wire payload"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        outcome: { status: "success", body: "trusted presentation" },
      }),
    );
  });

  test("replays an admitted failure without requiring outcome metadata again", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );
    const first = await open({ sessionId: "failure-replay" });
    await first.authorizeOutboundToolCalls([outbound("call_failure")]);
    await first.finish();

    const admitted = await open({
      sessionId: "failure-replay",
      toolResults: [
        {
          id: "call_failure",
          content: { error: "unavailable" },
          status: "failure",
          message: "Service unavailable.",
        },
      ],
    });
    await admitted.finish();

    const replay = await open({
      sessionId: "failure-replay",
      toolResults: [{ id: "call_failure", content: { error: "unavailable" } }],
    });
    await replay.finish();

    const results = events.filter((event) => event.event === "tool_result");
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toEqual({
      status: "failure",
      message: "Service unavailable.",
    });
  });

  test("keeps APPA open for one emitted call, then posts its result before the next prompt", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );
    const first = await open({ sessionId: "single-open" });
    await first.authorizeOutboundToolCalls([outbound("call_open")]);
    await first.finish();
    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "tool_call",
    ]);

    const second = await open({
      sessionId: "single-open",
      toolResults: [{ id: "call_open", content: "done", isError: false }],
    });
    await second.finish();
    expect(events.slice(3).map((event) => event.event)).toEqual([
      "tool_result",
      "prompt",
      "turn_end",
    ]);
  });

  test("routes native process results durably and rejects a handle after terminal closure", async () => {
    const nativeConfig = { ...hookConfig, nativeCodexEnabled: true };
    config.llmProxy.appaHook = nativeConfig;
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );
    const sessionId = "native-process-route";
    const execArguments = '{"cmd":"sleep 1"}';
    const localArguments = '{"session_id":1234,"chars":"","yield_time_ms":250}';
    const localRunningOutput =
      "Wall time: 0.0500 seconds\nProcess running with session ID 1234\nOutput:\nworking\n";
    const localExitOutput =
      "Wall time: 0.0500 seconds\nProcess exited with code 0\nOutput:\ndone\n";

    const initial = await open({ config: nativeConfig, sessionId });
    await initial.authorizeOutboundToolCalls([
      nativeOutbound({
        id: "call_exec",
        name: "functions.exec_command",
        arguments: execArguments,
      }),
    ]);
    await initial.finish();

    const afterExec = await open({
      config: nativeConfig,
      sessionId,
      toolResults: [
        {
          id: "call_exec",
          content: localRunningOutput,
          claimedCall: {
            name: "functions.exec_command",
            rawArguments: execArguments,
          },
        },
      ],
    });
    const execResult = events.findLast(
      (event) => event.event === "tool_result",
    );
    const routedExecOutput = String(
      (execResult?.outcome as { body?: unknown } | undefined)?.body,
    );
    const proxySessionId = Number(
      /Process running with session ID (-\d+)/.exec(routedExecOutput)?.[1],
    );
    expect(proxySessionId).toBeLessThan(0);
    const proxyArguments = JSON.stringify({
      session_id: proxySessionId,
      chars: "",
      yield_time_ms: 250,
    });
    await afterExec.authorizeOutboundToolCalls([
      nativeOutbound({
        id: "call_write_live",
        name: "functions.write_stdin",
        arguments: proxyArguments,
      }),
    ]);
    await afterExec.finish();

    const afterLiveWrite = await open({
      config: nativeConfig,
      sessionId,
      toolResults: [
        {
          id: "call_write_live",
          content: localRunningOutput,
          claimedCall: {
            name: "functions.write_stdin",
            rawArguments: localArguments,
          },
        },
      ],
    });
    const liveResult = events.findLast(
      (event) => event.event === "tool_result",
    );
    expect(
      (liveResult?.outcome as { body?: unknown } | undefined)?.body,
    ).toContain(`Process running with session ID ${proxySessionId}`);
    await afterLiveWrite.authorizeOutboundToolCalls([
      nativeOutbound({
        id: "call_write_close",
        name: "functions.write_stdin",
        arguments: proxyArguments,
      }),
    ]);
    await afterLiveWrite.finish();

    const afterClose = await open({
      config: nativeConfig,
      sessionId,
      toolResults: [
        {
          id: "call_write_close",
          content: localExitOutput,
          claimedCall: {
            name: "functions.write_stdin",
            rawArguments: localArguments,
          },
        },
      ],
    });
    await afterClose.finish();

    const terminalReplay = await open({
      config: nativeConfig,
      sessionId,
      toolResults: [
        {
          id: "call_write_close",
          content: localExitOutput,
          claimedCall: {
            name: "functions.write_stdin",
            rawArguments: localArguments,
          },
        },
      ],
    });
    await terminalReplay.finish();

    const staleIssuer = await open({ config: nativeConfig, sessionId });
    await staleIssuer.authorizeOutboundToolCalls([
      nativeOutbound({
        id: "call_write_stale",
        name: "functions.write_stdin",
        arguments: proxyArguments,
      }),
    ]);
    await staleIssuer.finish();
    await expect(
      open({
        config: nativeConfig,
        sessionId,
        toolResults: [
          {
            id: "call_write_stale",
            content: localRunningOutput,
            claimedCall: {
              name: "functions.write_stdin",
              rawArguments: localArguments,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ kind: "unavailable", stage: "input" });
    await expect(open({ config: nativeConfig, sessionId })).rejects.toThrow(
      "quarantined",
    );
  });

  test("rejects a multi-call batch before it creates a runtime dispatch", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );
    const session = await open({ sessionId: "one-dispatch" });
    await expect(
      session.authorizeOutboundToolCalls([
        outbound("call_a"),
        outbound("call_b"),
      ]),
    ).rejects.toMatchObject({ kind: "denied", stage: "outbound" });
    await session.finish();
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      0,
    );
  });

  test("isolates the same locator by authenticated owner scope", async () => {
    const first = await open({
      sessionId: "shared",
      ownerScopeHash: "owner-a",
    });
    await first.finish();
    const second = await open({
      sessionId: "shared",
      ownerScopeHash: "owner-b",
    });
    await second.finish();
    expect(first.rootId).not.toBe(second.rootId);
  });

  test("correlates a dispatch rewrite by emitted bytes and APPA target", async () => {
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as Record<string, unknown>;
        events.push(event);
        return HttpResponse.json(acknowledge(event as { event: string }));
      }),
    );
    const emittedArguments =
      '{"tool_name":"calendar_lookup","tool_args":{"date":"2026-09-08"}}';
    const first = await open({ sessionId: "dispatch" });
    await first.authorizeOutboundToolCalls([
      {
        id: "call_dispatch",
        emittedName: "mcp__gateway__archestra__run_tool",
        emittedArguments,
        emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
        targetName: "mcp/gateway/calendar_lookup",
        targetArguments: { date: "2026-09-08" },
      },
    ]);
    await first.finish();
    const second = await open({
      sessionId: "dispatch",
      toolResults: [
        {
          id: "call_dispatch",
          content: "available",
          isError: false,
          claimedCall: {
            name: "mcp__gateway__archestra__run_tool",
            rawArguments: emittedArguments,
          },
        },
      ],
    });
    await second.finish();
    expect(
      events.filter((event) => event.event === "tool_call")[0],
    ).toMatchObject({
      tool: "mcp/gateway/calendar_lookup",
      arguments: { date: "2026-09-08" },
    });
    expect(
      events.filter((event) => event.event === "tool_result")[0],
    ).toMatchObject({
      tool: "mcp/gateway/calendar_lookup",
      arguments: { date: "2026-09-08" },
    });
  });

  test("rejects unknown, mutated, duplicate, and pending-omitting results before APPA", async () => {
    const first = await open({});
    await first.authorizeOutboundToolCalls([outbound()]);
    await first.finish();

    await expect(
      open({ toolResults: [{ id: "unknown", content: "x", isError: false }] }),
    ).rejects.toThrow("does not match");
    await expect(
      open({
        toolResults: [
          {
            id: "call_1",
            content: "x",
            isError: false,
            claimedCall: {
              name: "get_weather",
              rawArguments: '{"city":"NYC"}',
            },
          },
        ],
      }),
    ).rejects.toThrow("contradicts");
    await expect(open({ toolResults: [] })).rejects.toThrow("pending");
  });

  test("rejects a changed body for an already admitted result", async () => {
    const first = await open({});
    await first.authorizeOutboundToolCalls([outbound()]);
    await first.finish();
    const admitted = await open({
      toolResults: [{ id: "call_1", content: "first", isError: false }],
    });
    await admitted.finish();
    await expect(
      open({
        toolResults: [{ id: "call_1", content: "changed", isError: false }],
      }),
    ).rejects.toThrow("different content");
  });

  test("allows pruned admitted history but retains pending restrictions", async () => {
    const first = await open({});
    await first.authorizeOutboundToolCalls([outbound()]);
    await first.finish();
    const admitted = await open({
      toolResults: [{ id: "call_1", content: "done", isError: false }],
    });
    await admitted.finish();
    const pruned = await open({ toolResults: [] });
    await pruned.finish();
  });

  test("admits only one concurrent turn", async () => {
    const settled = await Promise.allSettled([open({}), open({})]);
    expect(
      settled.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      settled.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const winner = settled.find(
      (result): result is PromiseFulfilledResult<AppaProxyHookSession> =>
        result.status === "fulfilled",
    );
    await winner?.value.finish();
  });

  test("runs trusted pre-release persistence while the local turn remains occupied", async () => {
    const session = await open({ sessionId: "pre-release-lease" });
    let persisted = false;
    await session.finish({
      beforeRelease: async () => {
        await expect(
          AppaProxyHookSession.acquire({
            config: hookConfig,
            profileId,
            ownerScopeHash: "owner-a",
            clientSessionId: "pre-release-lease",
            toolResults: [],
          }),
        ).rejects.toThrow("active turn");
        persisted = true;
      },
    });
    expect(persisted).toBe(true);
    const next = await open({ sessionId: "pre-release-lease" });
    await next.finish();
  });

  test("quarantines when trusted pre-release persistence fails", async () => {
    const session = await open({ sessionId: "pre-release-failure" });
    await expect(
      session.finish({
        beforeRelease: async () => {
          throw new Error("opaque persistence failed");
        },
      }),
    ).rejects.toMatchObject({ kind: "unavailable", stage: "turn_end" });
    await expect(open({ sessionId: "pre-release-failure" })).rejects.toThrow(
      "quarantined",
    );
  });

  test("commits a held batch with runtime-released arguments and no client-supplied calls", async () => {
    const runtimeConfig = { ...hookConfig, runtimeToken: "runtime-token" };
    const events: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          approval_grants: false,
          held_batches: true,
          position_bound_batch_offers: true,
          batch_commit: true,
          input_rewrite_holds_dispatch: true,
          dispatch_call_mapping: true,
          sanitized_results: true,
          child_workflows: false,
          child_actor_targeting: false,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        const raw = await request.text();
        const envelope = JSON.parse(raw) as {
          event_id: string;
          event: Record<string, unknown>;
        };
        events.push(envelope.event);
        const batchId = String(envelope.event.batch_id ?? "");
        const decision =
          envelope.event.event === "prepare_batch"
            ? {
                decision: "batch_prepared",
                batch_id: batchId,
                root_id: envelope.event.root_id,
                next: "resolve_batch_offer or commit_batch",
                positions: [
                  {
                    position: 0,
                    call_id: "held-call",
                    state: "held",
                    tool: "mcp/gateway/calendar_lookup",
                    arguments_sha256: sha256({ date: "2026-09-08" }),
                  },
                ],
              }
            : envelope.event.event === "commit_batch"
              ? {
                  decision: "batch_committed",
                  batch_id: batchId,
                  calls: [
                    {
                      position: 0,
                      call_id: "held-call",
                      dispatch_id: "runtime-dispatch-held-call",
                      tool: "mcp/gateway/calendar_lookup",
                      arguments_sha256: sha256({ date: "2026-09-09" }),
                      arguments: { date: "2026-09-09" },
                      spawn_binding: null,
                    },
                  ],
                }
              : { decision: "ack" };
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(raw).digest("hex"),
          decision,
        });
      }),
    );
    const session = await open({
      config: runtimeConfig,
      sessionId: "held-runtime-contract",
    });
    const emittedArguments =
      '{"tool_name":"calendar_lookup","tool_args":{"date":"2026-09-08"}}';
    const call = {
      id: "held-call",
      emittedName: "mcp__gateway__archestra__run_tool",
      emittedArguments,
      emittedArgumentsCanonical: canonicalJsonObject(emittedArguments),
      targetName: "mcp/gateway/calendar_lookup",
      targetArguments: { date: "2026-09-08" },
    };
    const batchId = crypto.randomUUID();
    await session.prepareRuntimeBatch({ batchId, calls: [call] });
    const released = await session.commitRuntimeBatch({
      batchId,
      calls: [call],
    });

    expect(events.find((event) => event.event === "commit_batch")).toEqual({
      event: "commit_batch",
      root_id: session.rootId,
      batch_id: batchId,
    });
    expect(released).toEqual([
      expect.objectContaining({
        targetArguments: { date: "2026-09-09" },
        emittedArguments:
          '{"tool_name":"calendar_lookup","tool_args":{"date":"2026-09-09"}}',
      }),
    ]);
    await session.finish();
  });

  test("quarantines an uncertain hook send and never replays it", async () => {
    let attempts = 0;
    server.use(
      http.post(hookUrl, () => {
        attempts++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    await expect(open({ sessionId: "outage" })).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(open({ sessionId: "outage" })).rejects.toThrow("quarantined");
    expect(attempts).toBe(1);
  });

  test("binds raw provider credentials without persisting their value", () => {
    const owner = deriveAppaOwnerScope({
      secret: hookConfig.sessionHmacSecret,
      profileId,
      rawProviderCredential: "Bearer provider-secret",
    });
    expect(owner).toMatch(/^[a-f0-9]{64}$/);
    expect(owner).not.toContain("provider-secret");
  });
});

function sha256(value: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJsonObject(JSON.stringify(value)))
    .digest("hex");
}

describe("OpenAPPA proxy route contract", () => {
  let app: FastifyInstance;
  const originalHookConfig = config.llmProxy.appaHook;

  beforeEach(async () => {
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as { event: string };
        return HttpResponse.json(acknowledge(event));
      }),
    );
    config.llmProxy.appaHook = hookConfig;
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      return reply.status(500).send({ error: { message: String(error) } });
    });
    await app.register(openAiProxyRoutes);
    await app.register(anthropicProxyRoutes);
    await app.register(kimiProxyRoutes);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient({ includeToolCalls: true }) as never,
    );
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () => ({
              id: "resp_1",
              object: "response",
              created_at: 1,
              model: "gpt-4o",
              status: "completed",
              output: [
                {
                  id: "fc_1",
                  type: "function_call",
                  call_id: "call_response_1",
                  name: "get_weather",
                  arguments: '{"city":"SF"}',
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
          },
        }) as never,
    );
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () =>
        createAnthropicTestClient({
          includeToolUse: true,
        }) as never,
    );
    vi.spyOn(kimiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient({ includeToolCalls: true }) as never,
    );
    await ModelModel.upsert({
      externalId: "openai/gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      inputModalities: null,
      outputModalities: null,
      customPricePerMillionInput: "2.50",
      customPricePerMillionOutput: "10.00",
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    config.llmProxy.appaHook = originalHookConfig;
    vi.restoreAllMocks();
    await app.close();
  });

  test("requires the explicit session header before provider execution", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA header contract" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "weather" }],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("stable thread id");
  });

  test("correlates normal Chat and Responses emitted call ids", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA route ids" });
    for (const api of ["chat/completions", "responses"]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/${api}`,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-key",
          "x-archestra-session-id": `route-${api.replace("/", "-")}`,
        },
        payload:
          api === "responses"
            ? { model: "gpt-4o", input: "weather" }
            : {
                model: "gpt-4o",
                messages: [{ role: "user", content: "weather" }],
              },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain(
        api === "responses" ? "call_response_1" : "call_list_files",
      );
    }
  });

  test("binds completed Claude responses before release then forks an exact new thread without session reset in both stream modes", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    config.llmProxy.appaHook = {
      ...hookConfig,
      runtimeToken: "checkpoint-runtime-token",
    };
    const checkpointOperations: Array<Record<string, unknown>> = [];
    const runtimeEvents: Array<Record<string, unknown>> = [];
    const providerRequests: Array<Record<string, unknown>> = [];
    const providerResponses: Array<Record<string, unknown>> = [];
    let checkpointNumber = 0;
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          child_workflows: false,
          sanitized_results: true,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        const raw = await request.text();
        const envelope = JSON.parse(raw) as {
          event_id: string;
          event: Record<string, unknown>;
        };
        runtimeEvents.push(envelope.event);
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(raw).digest("hex"),
          decision: { decision: "ack" },
        });
      }),
      http.post(`${runtimeUrl}/proxy/v1/checkpoints`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        checkpointOperations.push(body);
        if (body.operation === "fork") {
          return HttpResponse.json({ root_id: body.root_id });
        }
        checkpointNumber++;
        return HttpResponse.json({
          checkpoint_id: `checkpoint-${checkpointNumber}`,
          source_scope: { root_id: body.root_id },
          position: checkpointNumber,
          digest: `digest-${checkpointNumber}`,
        });
      }),
    );
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(() => {
      const client = createAnthropicTestClient();
      const create = client.messages.create;
      return {
        messages: {
          ...client.messages,
          create: async (...args: Parameters<typeof create>) => {
            providerRequests.push(
              structuredClone(args[0]) as unknown as Record<string, unknown>,
            );
            const response = await create(...args);
            providerResponses.push(
              structuredClone(response) as Record<string, unknown>,
            );
            return response;
          },
        },
      } as never;
    });
    const agent = await makeAgent({ name: "APPA response checkpoint route" });
    const user = await makeUser();
    await makeMember(user.id as never, agent.organizationId as never);
    const firstIdentity = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "APPA checkpoint owner",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });
    const secondIdentity = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "APPA checkpoint other owner",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });

    for (const stream of [false, true]) {
      const sourceThread = `claude-checkpoint-source-${stream}`;
      const forkThread = `claude-checkpoint-fork-${stream}`;
      const source = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "checkpoint-owner",
          "x-archestra-virtual-key": firstIdentity.value,
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-code/2.1.258",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 64,
          stream,
          metadata: { user_id: JSON.stringify({ session_id: sourceThread }) },
          system: "source restriction",
          messages: [{ role: "user", content: "source" }],
        },
      });
      expect(source.statusCode, source.body).toBe(200);

      if (stream) continue;
      const sourceResponse = source.json() as Record<string, unknown>;
      const sourceContent = sourceResponse.content;
      expect(sourceContent).toEqual(providerResponses[0]?.content);
      if (!Array.isArray(sourceContent))
        throw new Error("missing source client content");
      const fork = await app.inject({
        method: "POST",
        url: `/v1/anthropic/${agent.id}/v1/messages`,
        headers: {
          "content-type": "application/json",
          "x-api-key": "checkpoint-owner",
          "x-archestra-virtual-key": firstIdentity.value,
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-code/2.1.258",
        },
        payload: {
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 64,
          stream,
          metadata: { user_id: JSON.stringify({ session_id: forkThread }) },
          system: "source restriction",
          messages: [
            { role: "user", content: "source" },
            {
              role: "assistant",
              content: sourceContent,
            },
            { role: "user", content: "fork" },
          ],
        },
      });
      expect(fork.statusCode, fork.body).toBe(200);
      const [forkSession] = await db
        .select({
          rootId: schema.appaProxySessionsTable.rootId,
          rootInitializedAt: schema.appaProxySessionsTable.rootInitializedAt,
        })
        .from(schema.appaProxySessionsTable)
        .where(eq(schema.appaProxySessionsTable.clientSessionId, forkThread));
      expect(forkSession?.rootInitializedAt).not.toBeNull();
      expect(
        runtimeEvents.filter(
          (event) =>
            event.event === "session_start" &&
            event.root_id === forkSession?.rootId,
        ),
      ).toHaveLength(0);
      const forkProviderRequest = providerRequests.find(
        (request) =>
          Array.isArray(request.messages) &&
          request.messages.some(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as Record<string, unknown>).content === "fork",
          ),
      );
      expect(forkProviderRequest?.system).toBe("source restriction");
    }
    const sameRootCompaction = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": "checkpoint-owner",
        "x-archestra-virtual-key": firstIdentity.value,
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/2.1.258",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        metadata: {
          user_id: JSON.stringify({
            session_id: "claude-checkpoint-source-false",
          }),
        },
        context_management: { mode: "auto" },
        messages: [
          { role: "user", content: "source" },
          {
            role: "assistant",
            content: "Hello! How can I help you today?",
          },
          { role: "user", content: "compact in place" },
        ],
      },
    });
    expect(sameRootCompaction.statusCode, sameRootCompaction.body).toBe(200);
    const [sameRootSession] = await db
      .select({ rootId: schema.appaProxySessionsTable.rootId })
      .from(schema.appaProxySessionsTable)
      .where(
        eq(
          schema.appaProxySessionsTable.clientSessionId,
          "claude-checkpoint-source-false",
        ),
      );
    expect(
      checkpointOperations.filter(
        (body) =>
          body.operation === "fork" && body.root_id === sameRootSession?.rootId,
      ),
    ).toHaveLength(0);
    const checkpointOperationsBeforeMismatch = checkpointOperations.length;
    const runtimeEventsBeforeMismatch = runtimeEvents.length;
    const scopedMiss = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": "different-checkpoint-owner",
        "x-archestra-virtual-key": secondIdentity.value,
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/2.1.258",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        metadata: {
          user_id: JSON.stringify({
            session_id: "claude-checkpoint-other-owner",
          }),
        },
        system: "source restriction",
        messages: [
          { role: "user", content: "source" },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Hello! How can I help you today?",
                citations: [],
              },
            ],
          },
          { role: "user", content: "fork" },
        ],
      },
    });
    expect(scopedMiss.statusCode, scopedMiss.body).toBe(400);
    expect(scopedMiss.body).toContain("does not match an issued response");
    expect(checkpointOperations).toHaveLength(
      checkpointOperationsBeforeMismatch,
    );
    expect(runtimeEvents).toHaveLength(runtimeEventsBeforeMismatch);
    const mismatchedSessions = await db
      .select({ id: schema.appaProxySessionsTable.id })
      .from(schema.appaProxySessionsTable)
      .where(
        eq(
          schema.appaProxySessionsTable.clientSessionId,
          "claude-checkpoint-other-owner",
        ),
      );
    expect(mismatchedSessions).toHaveLength(0);
    expect(
      checkpointOperations.filter((body) => body.operation === "create"),
    ).toHaveLength(4);
    expect(
      checkpointOperations.filter((body) => body.operation === "fork"),
    ).toHaveLength(2);
  });

  test("quarantines a route session when checkpoint creation is uncertain and refuses its retry", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = {
      ...hookConfig,
      runtimeToken: "checkpoint-runtime-token",
    };
    let checkpointAttempts = 0;
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          child_workflows: false,
          sanitized_results: true,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        const raw = await request.text();
        const envelope = JSON.parse(raw) as {
          event_id: string;
          event: Record<string, unknown>;
        };
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(raw).digest("hex"),
          decision: { decision: "ack" },
        });
      }),
      http.post(`${runtimeUrl}/proxy/v1/checkpoints`, () => {
        checkpointAttempts++;
        return HttpResponse.json(
          { error: { code: "event_uncertain" } },
          { status: 503 },
        );
      }),
    );
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient() as never,
    );
    const agent = await makeAgent({ name: "APPA checkpoint retry quarantine" });
    const request = {
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 64,
      messages: [{ role: "user", content: "source" }],
    };
    const headers = {
      "content-type": "application/json",
      "x-api-key": "checkpoint-owner",
      "anthropic-version": "2023-06-01",
      "thread-id": "checkpoint-retry-thread",
    };
    const first = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers,
      payload: request,
    });
    expect(first.statusCode, first.body).toBe(503);
    const retry = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers,
      payload: request,
    });
    expect(retry.statusCode, retry.body).toBe(409);
    expect(checkpointAttempts).toBe(1);
  });

  test("enforces a native Codex V1 Responses turn using its thread metadata", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = {
      ...hookConfig,
      runtimeToken: "native-codex-runtime-token",
    };
    const runtimeEvents: Array<Record<string, unknown>> = [];
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          child_workflows: false,
          sanitized_results: true,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          "Bearer native-codex-runtime-token",
        );
        const raw = await request.text();
        const envelope = JSON.parse(raw) as {
          event_id: string;
          event: Record<string, unknown>;
        };
        runtimeEvents.push(envelope.event);
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(raw).digest("hex"),
          decision:
            envelope.event.event === "tool_calls"
              ? {
                  decision: "allow_calls",
                  calls: (
                    envelope.event.calls as Array<{ call_id: string }>
                  ).map((call) => ({
                    call_id: call.call_id,
                    dispatch_id: `native-codex-${call.call_id}`,
                  })),
                }
              : { decision: "ack" },
        });
      }),
    );
    const agent = await makeAgent({ name: "APPA native Codex V1 route" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        originator: "codex_cli_rs",
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        input: "inspect",
        client_metadata: {
          session_id: "codex-v1-session",
          thread_id: "codex-v1-thread",
          root_turn_id: "codex-v1-root-turn",
          "x-codex-turn-metadata": { thread_id: "codex-v1-thread" },
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("call_response_1");
    expect(runtimeEvents.map((event) => event.event)).toContain("tool_calls");
    const [session] = await db
      .select()
      .from(schema.appaProxySessionsTable)
      .where(
        eq(schema.appaProxySessionsTable.clientSessionId, "codex-v1-root-turn"),
      )
      .limit(1);
    expect(session?.clientSessionId).toBe("codex-v1-root-turn");
  });

  test("admits a native Claude Code Messages stream without changing its wire protocol", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA native Claude route" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/2.1.258",
      },
      payload: {
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 64,
        stream: true,
        metadata: { user_id: '{"session_id":"claude-native-route"}' },
        system:
          "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=claude-code;",
        messages: [{ role: "user", content: "inspect" }],
        tools: [
          {
            name: "get_weather",
            description: "Gets weather",
            input_schema: { type: "object", properties: {} },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("toolu_test_weather");
  });

  test("uses Claude metadata sessions for fresh roots and rejects conflicting aliases", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA native Claude correlation" });
    let providerCalls = 0;
    let starts = 0;
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as { event: string };
        if (event.event === "session_start") starts++;
        if (event.event === "prompt" && starts === 1) {
          return new HttpResponse(null, { status: 500 });
        }
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(anthropicAdapterFactory.createClient).mockImplementation(() => {
      const client = createAnthropicTestClient();
      const create = client.messages.create;
      return {
        messages: {
          ...client.messages,
          create: async (...args: Parameters<typeof create>) => {
            providerCalls++;
            return await create(...args);
          },
        },
      } as never;
    });

    const request = (sessionId: string) => ({
      method: "POST" as const,
      url: `/v1/anthropic/${agent.id}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-code/2.1.258",
        "x-claude-code-session-id": sessionId,
      },
      payload: {
        model: "claude-3-5-haiku-20241022",
        max_tokens: 64,
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
        system:
          "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=claude-code;",
        messages: [{ role: "user", content: "synthetic native turn" }],
      },
    });

    const quarantined = await app.inject(request("native-session-anon-a"));
    expect(quarantined.statusCode, quarantined.body).toBe(503);

    const fresh = await app.inject(request("native-session-anon-b"));
    expect(fresh.statusCode, fresh.body).toBe(200);
    const continued = await app.inject(request("native-session-anon-b"));
    expect(continued.statusCode, continued.body).toBe(200);
    const rejectedRetry = await app.inject(request("native-session-anon-a"));
    expect(rejectedRetry.statusCode, rejectedRetry.body).toBe(409);

    const [quarantinedRoot] = await db
      .select({ rootId: schema.appaProxySessionsTable.rootId })
      .from(schema.appaProxySessionsTable)
      .where(
        eq(
          schema.appaProxySessionsTable.clientSessionId,
          "native-session-anon-a",
        ),
      );
    const rows = await db
      .select({
        clientSessionId: schema.appaProxySessionsTable.clientSessionId,
        rootId: schema.appaProxySessionsTable.rootId,
      })
      .from(schema.appaProxySessionsTable)
      .where(
        eq(
          schema.appaProxySessionsTable.clientSessionId,
          "native-session-anon-b",
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rootId).not.toBe(quarantinedRoot?.rootId);
    expect(providerCalls).toBe(2);

    const conflicting = request("native-session-anon-b");
    const conflict = await app.inject({
      ...conflicting,
      headers: {
        ...conflicting.headers,
        "x-archestra-session-id": "different-session-alias",
      },
    });
    expect(conflict.statusCode, conflict.body).toBe(400);
    expect(conflict.body).toContain(
      "conflicts with a native or client session alias",
    );
    expect(providerCalls).toBe(2);
  });

  test("withholds a denied native OpenCode Kimi streamed call before the client can execute it", async ({
    makeAgent,
  }) => {
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as { event: string };
        return HttpResponse.json(
          event.event === "tool_call"
            ? { decision: "block", reason: "policy" }
            : acknowledge(event),
        );
      }),
    );
    const agent = await makeAgent({ name: "APPA native OpenCode Kimi route" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/kimi/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "user-agent": "opencode/1.18.29",
        "x-opencode-session": "opencode-native-route",
      },
      payload: {
        model: "kimi-k2-0711-preview",
        stream: true,
        messages: [{ role: "user", content: "inspect" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("OpenAPPA remote hook denied the call");
    expect(response.body).not.toContain("call_test_weather");
  });

  test("delivers an authorized spawn binding and accepts it on child attach", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = {
      ...hookConfig,
      runtimeToken: "runtime".repeat(8),
    };
    const events: Array<Record<string, unknown>> = [];
    let checkpointNumber = 0;
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          child_workflows: true,
          child_actor_targeting: true,
          sanitized_results: true,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        const raw = await request.text();
        const envelope = JSON.parse(raw) as {
          event_id: string;
          event: Record<string, unknown>;
        };
        events.push(envelope.event);
        const decision =
          envelope.event.event === "tool_calls"
            ? {
                decision: "allow_calls",
                calls: (
                  envelope.event.calls as Array<{
                    call_id: string;
                    spawn: boolean;
                  }>
                ).map((call) => ({
                  call_id: call.call_id,
                  dispatch_id: `dispatch_${call.call_id}`,
                  ...(call.spawn
                    ? { spawn_binding: `binding_${call.call_id}` }
                    : {}),
                })),
              }
            : envelope.event.event === "tool_result"
              ? {
                  decision: "ack",
                  call_id: envelope.event.call_id,
                  presentation: "safe child result",
                }
              : { decision: "ack" };
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256").update(raw).digest("hex"),
          decision,
        });
      }),
      http.post(`${runtimeUrl}/proxy/v1/checkpoints`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          body.operation === "fork"
            ? { root_id: body.root_id }
            : {
                checkpoint_id: `checkpoint-${++checkpointNumber}`,
                source_scope: { root_id: body.root_id },
                position: 1,
                digest: "spawn-checkpoint",
              },
        );
      }),
    );
    const agent = await makeAgent({ name: "APPA spawn extension" });
    let calls = 0;
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () => {
                calls++;
                return calls === 1
                  ? {
                      id: "chatcmpl-spawn",
                      object: "chat.completion",
                      created: 1,
                      model: "gpt-4o",
                      choices: [
                        {
                          index: 0,
                          finish_reason: "tool_calls",
                          message: {
                            role: "assistant",
                            content: null,
                            tool_calls: [
                              {
                                id: "call_spawn",
                                type: "function",
                                function: {
                                  name: "spawn_agent",
                                  arguments: "{}",
                                },
                              },
                            ],
                          },
                        },
                      ],
                      usage: {
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        total_tokens: 2,
                      },
                    }
                  : calls === 2
                    ? {
                        id: "chatcmpl-child-tool",
                        object: "chat.completion",
                        created: 1,
                        model: "gpt-4o",
                        choices: [
                          {
                            index: 0,
                            finish_reason: "tool_calls",
                            message: {
                              role: "assistant",
                              content: null,
                              tool_calls: [
                                {
                                  id: "call_child_read",
                                  type: "function",
                                  function: {
                                    name: "get_weather",
                                    arguments: '{"city":"SF"}',
                                  },
                                },
                              ],
                            },
                          },
                        ],
                        usage: {
                          prompt_tokens: 1,
                          completion_tokens: 1,
                          total_tokens: 2,
                        },
                      }
                    : {
                        id: "chatcmpl-child",
                        object: "chat.completion",
                        created: 1,
                        model: "gpt-4o",
                        choices: [
                          {
                            index: 0,
                            finish_reason: "stop",
                            message: { role: "assistant", content: "done" },
                          },
                        ],
                        usage: {
                          prompt_tokens: 1,
                          completion_tokens: 1,
                          total_tokens: 2,
                        },
                      };
              },
            },
          },
        }) as never,
    );
    const parent = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "thread-id": "parent-thread",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "delegate" }],
      },
    });
    expect(parent.statusCode, parent.body).toBe(200);
    const bindings = JSON.parse(
      String(parent.headers["x-archestra-appa-spawn-bindings"]),
    ) as Record<string, string>;
    expect(bindings).toEqual({ call_spawn: "binding_call_spawn" });
    const child = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        "x-archestra-appa-spawn-binding": bindings.call_spawn,
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "child" }],
      },
    });
    expect(child.statusCode, child.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "child_start",
        child_id: "child-thread",
        spawn_binding: "binding_call_spawn",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "prompt",
        child_id: "child-thread",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_calls",
        child_id: "child-thread",
      }),
    );
    const childResult = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "thread-id": "child-thread",
        "x-codex-parent-thread-id": "parent-thread",
        "x-archestra-appa-spawn-binding": bindings.call_spawn,
      },
      payload: {
        model: "gpt-4o",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_child_read",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"SF"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_child_read", content: "sunny" },
        ],
      },
    });
    expect(childResult.statusCode, childResult.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        child_id: "child-thread",
        call_id: "call_child_read",
      }),
    );
  });
});
