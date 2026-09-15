/** Native decisions at the existing buffered proxy seam. The real native +
 * PostgreSQL engine is exercised separately by openappa-rs/smoke.test.cjs. */

import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import * as database from "@/database";
import * as toolInvocation from "@/guardrails/tool-invocation";
import * as trustedData from "@/guardrails/trusted-data";
import { ModelModel } from "@/models";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { getLlmProxyPluginRegistry } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
} from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { anthropicAdapterFactory } from "./adapters";
import anthropicProxyRoutes from "./routes/anthropic";
import openAiProxyRoutes from "./routes/openai";

const native = vi.hoisted(() => {
  const dispatchHook = vi.fn();
  return {
    initializeOpenappa: vi.fn(),
    dispatchHook,
    dispatchOpenappaProxyEvent: dispatchHook,
    dispatchOpenappaCheckpoint: vi.fn(),
    openappaProxyCapabilities: vi.fn(),
  };
});
vi.mock("@archestra/openappa-rs", () => native);

const NATIVE_V1_CAPABILITIES = {
  protocol_version: 1,
  legacy_hooks: false,
  completed_event_replay: true,
  typed_offers: true,
  restriction_acceptance: true,
  human_approval: false,
  approval_grants: false,
  sanitized_results: true,
  child_workflows: false,
  child_actor_targeting: false,
  spawn_result: false,
};

function nativeV1Receipt(
  raw: string,
  decision: Record<string, unknown>,
): string {
  const envelope = JSON.parse(raw) as {
    event_id?: string;
    request_sha256?: string;
  };
  return JSON.stringify({
    protocol_version: 1,
    event_id: envelope.event_id,
    request_sha256: createHash("sha256").update(raw).digest("hex"),
    decision,
  });
}

describe("OpenAPPA on the existing LLM proxy", () => {
  let app: FastifyInstance;
  let agent: Agent;
  let userId: string;
  let sessionId: string;
  let options: AnthropicStubOptions;
  let providerRequests: unknown[];
  let events: Array<Record<string, unknown>>;
  let block: boolean;
  let fail: boolean;
  let unregisterAppaPlugin: () => void;

  beforeEach(async ({ makeAgent, makeConversation, makeMember, makeUser }) => {
    config.llmProxy.plugins = ["appa"];
    config.openappa = {
      enabled: true,
      policyPath: "/test/policy.toml",
      sessionHmacSecret: "s".repeat(32),
    };
    config.llmProxy.appaHook = { sessionHmacSecret: "s".repeat(32) };
    unregisterAppaPlugin = getLlmProxyPluginRegistry().register(
      createAppaLlmProxyPlugin(),
    );
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    app = Fastify({
      genReqId: () => "openappa-proxy-request",
    }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) =>
      reply.status(error instanceof ApiError ? error.statusCode : 500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      }),
    );
    await app.register(anthropicProxyRoutes);
    await app.register(openAiProxyRoutes);
    agent = await makeAgent({ name: "Native proxy test" });
    userId = (await makeUser()).id;
    await makeMember(userId, agent.organizationId);
    sessionId = (
      await makeConversation(agent.id, {
        userId,
        organizationId: agent.organizationId,
      })
    ).id;
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: { name: "get_weather", input: { location: "SF" } },
    };
    providerRequests = [];
    events = [];
    block = false;
    fail = false;
    native.initializeOpenappa.mockResolvedValue(undefined);
    native.openappaProxyCapabilities.mockResolvedValue(
      JSON.stringify(NATIVE_V1_CAPABILITIES),
    );
    native.dispatchOpenappaCheckpoint.mockImplementation(
      async (raw: string) => {
        const request = JSON.parse(raw) as {
          operation: string;
          root_id: string;
        };
        return JSON.stringify(
          request.operation === "create"
            ? {
                checkpoint_id: "checkpoint-test",
                source_scope: {},
                position: 1,
                digest: "test-digest",
              }
            : { root_id: request.root_id },
        );
      },
    );
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const envelope = JSON.parse(raw) as { event?: Record<string, unknown> };
      const event = (envelope.event ?? envelope) as Record<string, unknown>;
      events.push(event);
      if (event.event === "tool_calls") {
        if (fail) throw new Error("private native database error");
        return nativeV1Receipt(
          raw,
          block
            ? {
                decision: "deny_calls",
                calls: (event.calls as Array<{ call_id: string }>).map(
                  (call) => ({
                    call_id: call.call_id,
                    decision: "deny_call",
                    feedback: "NATIVE REFUSAL",
                    offers: [],
                    review: [],
                  }),
                ),
              }
            : {
                decision: "allow_calls",
                calls: (event.calls as Array<{ call_id: string }>).map(
                  (call) => ({
                    call_id: call.call_id,
                    dispatch_id: `dispatch:${call.call_id}`,
                  }),
                ),
              },
        );
      }
      return nativeV1Receipt(
        raw,
        event.event === "tool_result"
          ? {
              decision: "ack",
              call_id: event.call_id,
              presentation: "APPROVED REPLACEMENT",
              offers: [],
            }
          : { decision: "ack" },
      );
    });
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(() => {
      const client = createAnthropicTestClient(options);
      const create = client.messages.create;
      client.messages.create = async (params) => {
        providerRequests.push(structuredClone(params));
        return create(params);
      };
      return client as never;
    });
    await ModelModel.upsert({
      externalId: "anthropic/claude-3-5-sonnet-20241022",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
  });

  afterEach(async () => {
    unregisterAppaPlugin();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app.close();
  });

  const payload = (
    stream = true,
    messages: unknown[] = [{ role: "user", content: "Check the weather" }],
  ) => ({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 1024,
    stream,
    messages,
    tools: [
      {
        name: "get_weather",
        description: "Weather",
        input_schema: {
          type: "object",
          properties: { location: { type: "string" } },
        },
      },
    ],
  });
  const headers = () => ({
    "x-api-key": "test-key",
    "anthropic-version": "2023-06-01",
    "x-archestra-source": "chat",
    "x-archestra-user-id": userId,
    "x-appa-session-id": sessionId,
  });
  const url = () => `/v1/anthropic/${agent.id}/v1/messages`;

  test.each([
    true,
    false,
  ])("human-approval offers remain refusals without automatic remedies (stream=%s)", async (stream) => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const envelope = JSON.parse(raw) as {
        event?: Record<string, unknown>;
      };
      const event = (envelope.event ?? envelope) as Record<string, unknown>;
      events.push(event);
      return nativeV1Receipt(
        raw,
        event.event === "tool_calls"
          ? {
              decision: "deny_calls",
              calls: (event.calls as Array<{ call_id: string }>).map(
                (call) => ({
                  call_id: call.call_id,
                  decision: "deny_call",
                  feedback: "APPA: human approval required",
                  offers: [
                    {
                      offer_id: "review",
                      kind: "human_approval",
                      root_id: event.root_id,
                      tool: "get_weather",
                      arguments_sha256: "test",
                    },
                  ],
                  review: [],
                }),
              ),
            }
          : { decision: "ack" },
      );
    });
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(stream),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("OpenAPPA policy denied the call");
    expect(response.body).not.toContain("APPA: human approval required");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "tool_calls",
      "turn_end",
    ]);
  });

  for (const stream of [true, false]) {
    test(`returns APPA refusal text to authenticated Chat without executable calls (${stream})`, async () => {
      block = true;
      const response = await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: payload(stream),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('"type":"tool_use"');
      expect(response.body).not.toContain("input_json_delta");
      const refusal = "OpenAPPA policy denied the call";
      expect(response.body).toContain(refusal);
      if (stream) {
        expect(response.body).toContain(refusal);
      } else {
        expect(response.json().content).toEqual([
          {
            type: "text",
            text: expect.stringContaining(refusal),
            citations: null,
          },
        ]);
      }
      expect(response.body).not.toContain("tool call policy violated");
      expect(
        events.filter((event) => event.event === "tool_calls"),
      ).toHaveLength(1);
    });
  }

  test.each([
    true,
    false,
  ])("withholds the allowed sibling when another call is denied (stream=%s)", async (stream) => {
    block = true;
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event =
        (JSON.parse(raw) as { event?: Record<string, unknown> }).event ??
        JSON.parse(raw);
      if (
        event.event === "tool_calls" &&
        (event.calls as Array<{ tool: string }>).some(
          (call) => call.tool === "allowed_first",
        )
      ) {
        events.push(event);
        return nativeV1Receipt(raw, {
          decision: "deny_calls",
          calls: (event.calls as Array<{ call_id: string }>).map((call) => ({
            call_id: call.call_id,
            decision: "deny_call",
            feedback: "NATIVE REFUSAL",
            offers: [],
            review: [],
          })),
        });
      }
      return dispatch?.(raw);
    });
    vi.mocked(anthropicAdapterFactory.createClient).mockImplementation(() => {
      const client = createAnthropicTestClient(options);
      const create = client.messages.create;
      client.messages.create = async (params) => {
        const response = await create(params);
        const allowed = {
          type: "tool_use" as const,
          id: "allowed-first",
          caller: { type: "direct" as const },
          name: "allowed_first",
          input: { location: "PRIVATE ALLOWED ARGUMENT" },
        };
        if (!(Symbol.asyncIterator in response))
          return { ...response, content: [allowed, ...response.content] };
        const stream = (async function* () {
          for await (const event of response) {
            if (!event) continue;
            if (event.type === "message_start") {
              yield event;
              yield {
                type: "content_block_start" as const,
                index: 0,
                content_block: { ...allowed, input: {} },
              };
              yield {
                type: "content_block_delta" as const,
                index: 0,
                delta: {
                  type: "input_json_delta" as const,
                  partial_json: JSON.stringify(allowed.input),
                },
              };
              yield { type: "content_block_stop" as const, index: 0 };
            } else {
              yield "index" in event
                ? { ...event, index: event.index + 1 }
                : event;
            }
          }
          return undefined;
        })();
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const next = await stream.next();
                return next.done
                  ? { done: true, value: undefined }
                  : { done: false, value: next.value };
              },
            };
          },
        };
      };
      return client as never;
    });
    const body = payload(stream);
    body.tools.push({ ...body.tools[0], name: "allowed_first" });
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      events
        .filter((event) => event.event === "tool_calls")
        .flatMap((event) =>
          (event.calls as Array<{ tool: string }>).map((call) => call.tool),
        ),
    ).toEqual(["allowed_first", "get_weather"]);
    expect(response.body).toContain("OpenAPPA policy denied the call");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(response.body).not.toContain("PRIVATE ALLOWED ARGUMENT");
  });

  test("withholds every streamed tool delta until the completed native call is allowed", async () => {
    block = true;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("OpenAPPA policy denied the call");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(events.filter((e) => e.event === "tool_calls")).toEqual([
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            call_id: "toolu_test_weather",
            tool: "get_weather",
            arguments: { location: "San Francisco", unit: "fahrenheit" },
          }),
        ],
      }),
    ]);
    expect(events.map((e) => e.event)).toContain("turn_end");
  });

  test("releases an allowed streamed call through the existing adapter", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain("toolu_test_weather");
    expect(events.filter((e) => e.event === "tool_calls")).toHaveLength(1);
  });

  test("blocks non-streamed calls at the same native gate", async () => {
    block = true;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("OpenAPPA policy denied the call"),
      }),
    ]);
  });

  test("keeps platform tool policies additive after APPA allows a call", async ({
    makeTool,
    makeToolPolicy,
  }) => {
    const tool = await makeTool({ name: "get_weather", agentId: agent.id });
    await makeToolPolicy(tool.id, {
      action: "block_always",
      conditions: [],
      reason: "Platform weather policy refused this call",
    });

    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain(
      "Platform weather policy refused this call",
    );
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "turn_end",
    ]);
  });

  test("substitutes the runtime-approved result before the provider sees resent history", async () => {
    const evaluateTrustedData = vi.spyOn(
      trustedData,
      "evaluateIfContextIsTrusted",
    );
    const issued = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });
    expect(issued.statusCode, issued.body).toBe(200);
    options.includeToolUse = false;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false, [
        { role: "user", content: "Check the weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_test_weather",
              name: "get_weather",
              input: { location: "SF" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_test_weather",
              content: "RAW SECRET",
            },
          ],
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(providerRequests.at(-1))).toContain(
      "APPROVED REPLACEMENT",
    );
    expect(JSON.stringify(providerRequests.at(-1))).not.toContain("RAW SECRET");
    expect(events.filter((e) => e.event === "tool_result")).toEqual([
      expect.objectContaining({
        call_id: "toolu_test_weather",
        outcome: { status: "success", body: "RAW SECRET" },
      }),
    ]);
    expect(evaluateTrustedData).toHaveBeenCalledTimes(2);
  });

  test("keeps an explicit remedy separate from a denied root without auto-retrying", async () => {
    block = true;
    const denied = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });

    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.body).toContain("OpenAPPA policy denied the call");
    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "tool_calls",
      "turn_end",
    ]);

    const defaultDispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      if (!("event_id" in (JSON.parse(raw) as Record<string, unknown>))) {
        return JSON.stringify({
          decision: "mcp_result",
          result: { content: [{ type: "text", text: "Remedy applied" }] },
        });
      }
      const event =
        (JSON.parse(raw) as { event?: Record<string, unknown> }).event ??
        JSON.parse(raw);
      events.push(event);
      return defaultDispatch?.(raw);
    });
    await expect(
      executeArchestraTool(
        "archestra__execute_remedy_plan",
        { offer_id: "test-offer" },
        {
          agent: { id: agent.id, name: agent.name },
          agentId: agent.id,
          organizationId: agent.organizationId,
          userId,
          sessionId,
          currentToolCallId: "remedy-call",
        },
      ),
    ).resolves.toEqual({
      content: [{ type: "text", text: "Remedy applied" }],
    });

    const retried = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });

    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.body).toContain("OpenAPPA policy denied the call");
    expect(events.filter((event) => event.event === "tool_calls")).toHaveLength(
      1,
    );
  });

  test.each([
    ["Chat", {}, "get_weather"],
    [
      "Claude Code",
      {
        "user-agent": "Claude-Code/1",
        "x-claude-code-session-id": "native-client-session",
      },
      "get_weather",
    ],
    ["Codex", { originator: "codex" }, "get_weather"],
    [
      "OpenCode",
      { "x-opencode-session": "native-client-session" },
      "get_weather",
    ],
  ])("binds the explicit APPA root exactly once for authenticated %s calls", async (client, clientHeaders, expectedTool) => {
    const requestHeaders: Record<string, string> = {
      ...headers(),
      ...clientHeaders,
    };
    if (client === "Claude Code") {
      delete requestHeaders["x-claude-code-session-id"];
    }
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: requestHeaders,
      payload: payload(false),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      events.filter((event) => event.event === "session_start"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.event === "tool_calls")).toEqual([
      expect.objectContaining({
        calls: [expect.objectContaining({ tool: expectedTool })],
      }),
    ]);
  });

  test.each([
    "chat:tool_call_repair",
    "chat:compaction",
  ])("binds authenticated Chat %s calls to the conversation root", async (source) => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), "x-archestra-source": source },
      payload: payload(false),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_calls",
        calls: [expect.objectContaining({ tool: "get_weather" })],
      }),
    );
  });

  test("does not treat an untrusted Chat session hint as a profile identity", async ({
    makeAgent,
    makeConversation,
  }) => {
    const otherAgent = await makeAgent({
      organizationId: agent.organizationId,
    });
    const otherConversation = await makeConversation(otherAgent.id, {
      userId,
      organizationId: agent.organizationId,
    });
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...headers(),
        "x-appa-session-id": otherConversation.id,
      },
      payload: payload(false),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "tool_calls" }),
    );
  });

  test("allows Chat compaction to retain its owner conversation root", async ({
    makeAgent,
  }) => {
    const compactionAgent = await makeAgent({
      organizationId: agent.organizationId,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${compactionAgent.id}/v1/messages`,
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), "x-archestra-source": "chat:compaction" },
      payload: payload(false),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "session_start" }),
    );
  });

  test("native failures do not release tool deltas or private diagnostics", async () => {
    fail = true;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(),
    });
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(response.body).not.toContain("private native database error");
    expect(events.some((e) => e.event === "tool_calls")).toBe(true);
  });

  test.each([
    true,
    false,
  ])("empty plugin list uses existing evaluators without APPA metadata (stream=%s)", async (stream) => {
    config.llmProxy.plugins = [];
    config.llmProxy.appaHook = undefined;
    unregisterAppaPlugin();
    // A configured path and unavailable native runtime must not affect old guardrails.
    native.initializeOpenappa.mockRejectedValue(
      new Error("native unavailable"),
    );
    const initializeCalls = native.initializeOpenappa.mock.calls.length;
    const read = vi
      .spyOn(trustedData, "evaluateIfContextIsTrusted")
      .mockResolvedValue({
        toolResultUpdates: {},
        contextIsTrusted: true,
        dualLlmAnalyses: [],
        unsafeContextBoundary: undefined,
      });
    const write = vi
      .spyOn(toolInvocation, "evaluatePolicies")
      .mockResolvedValue({
        refusalMessage: "EXISTING GUARDRAIL REFUSAL",
        contentMessage: "EXISTING GUARDRAIL REFUSAL",
        reason: "existing policy",
        blockedToolName: "get_weather",
        toolInput: {},
        allToolCallNames: ["get_weather"],
      });
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
      payload: payload(stream),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("EXISTING GUARDRAIL REFUSAL");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(read).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(events).toHaveLength(0);
    expect(native.initializeOpenappa.mock.calls.length).toBe(initializeCalls);
  });

  test("reports a native failure and keeps the runtime-approved presentation", async () => {
    const issued = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });
    expect(issued.statusCode, issued.body).toBe(200);
    options.includeToolUse = false;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false, [
        { role: "user", content: "Check the weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_test_weather",
              name: "get_weather",
              input: { location: "SF" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_test_weather",
              content: "Service unavailable",
              is_error: true,
            },
          ],
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        call_id: "toolu_test_weather",
        outcome: {
          status: "failure",
          message: "Native client reported a tool error.",
        },
      }),
    );
    expect(JSON.stringify(providerRequests.at(-1))).toContain(
      "APPROVED REPLACEMENT",
    );
    expect(
      events.filter((event) => event.event === "tool_result"),
    ).toHaveLength(1);
  });

  test("normalizes run_tool before APPA evaluates the target", async () => {
    options.nonStreamingToolUse = {
      name: "archestra__run_tool",
      input: {
        tool_name: "get_weather",
        tool_args: { location: "SF" },
      },
    };
    const body = payload(false);
    body.tools.push({
      name: "archestra__run_tool",
      description: "Run",
      input_schema: {
        type: "object",
        properties: {
          location: { type: "string" },
          tool_name: { type: "string" },
          tool_args: { type: "object" },
        },
      },
    } as (typeof body.tools)[number]);
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_calls",
        calls: [
          expect.objectContaining({
            tool: "get_weather",
            arguments: { location: "SF" },
          }),
        ],
      }),
    );
  });

  test("requires the explicit session header", async () => {
    const { "x-appa-session-id": _session, ...missing } = headers();
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: missing,
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test.each([
    "chat",
    "chat:tool_call_repair",
    "chat:compaction",
  ])("does not bind a remote caller claiming %s to a local Chat root", async (source) => {
    const local = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });
    expect(local.statusCode, local.body).toBe(200);
    const localRoot = events.find(
      (event) => event.event === "session_start",
    )?.root_id;
    events = [];
    providerRequests = [];
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "203.0.113.20",
      headers: { ...headers(), "x-archestra-source": source },
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(localRoot).toBeDefined();
  });

  test("uses the existing local Chat identity without an APPA signature", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "session_start" }),
    );
  });

  test("releases the bootstrap request lifecycle before the next request reuses its id", async () => {
    config.llmProxy.appaHook = {
      sessionHmacSecret: "s".repeat(32),
      nativeCodexEnabled: true,
    };
    await ModelModel.upsert({
      externalId: "openai/gpt-5.5-codex",
      provider: "openai",
      modelId: "gpt-5.5-codex",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });
    const payload = {
      model: "gpt-5.5-codex",
      input: [
        {
          type: "additional_tools",
          tools: [{ type: "custom", name: "exec" }],
        },
      ],
    };

    for (const attempt of [1, 2]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/responses`,
        remoteAddress: "127.0.0.1",
        headers: { ...headers(), authorization: "Bearer test-key" },
        payload,
      });

      expect(response.statusCode, `${attempt}: ${response.body}`).toBe(200);
      expect(response.json()).toMatchObject({
        status: "completed",
        output: [expect.objectContaining({ name: "exec" })],
      });
    }
    expect(events.some((event) => event.event === "abort")).toBe(false);
  });
});
