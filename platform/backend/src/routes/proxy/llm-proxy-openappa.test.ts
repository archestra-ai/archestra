import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs, streamText, tool } from "ai";
/** Native decisions at the existing buffered proxy seam. The real native +
 * PostgreSQL engine is exercised separately by openappa-rs/smoke.test.cjs. */
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { z } from "zod";
import { executeArchestraTool } from "@/archestra-mcp-server";
import { withOpenAppaChat } from "@/clients/chat-openappa";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import * as toolInvocation from "@/guardrails/tool-invocation";
import * as trustedData from "@/guardrails/trusted-data";
import { ModelModel } from "@/models";
import { APPA_CHAT_BLOCK_HEADER, decodeChatBlock } from "@/openappa/chat-block";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
} from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { anthropicAdapterFactory } from "./adapters";
import anthropicProxyRoutes from "./routes/anthropic";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
}));
vi.mock("@archestra/openappa-rs", () => native);

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
    config.openappa = parseOpenAppaConfig("true", "/test/policy.toml");
    config.llmProxy.plugins = parseLlmProxyPlugins(
      undefined,
      config.openappa.enabled,
    );
    unregisterAppaPlugin = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    app = Fastify().withTypeProvider<ZodTypeProvider>();
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
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "tool_call") {
        if (fail) throw new Error("private native database error");
        return JSON.stringify(
          block
            ? {
                decision: "deny_call",
                feedback:
                  "NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
              }
            : { decision: "allow_call" },
        );
      }
      return JSON.stringify(
        event.event === "tool_result"
          ? {
              decision: "replace_output",
              approved_output: "APPROVED REPLACEMENT",
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
  ])("Chat continues from a blocked attempt, with model-selected remedy (stream=%s)", async (stream) => {
    block = true;
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (
        event.event === "tool_call" &&
        event.tool === "appa/execute_remedy_plan"
      ) {
        events.push(event);
        return JSON.stringify({ decision: "pass_control" });
      }
      return dispatch?.(raw);
    });
    const weather = vi.fn(async () => ({
      content: [{ type: "text", text: "Sunny" }],
    }));
    const remedy = vi.fn(async () => {
      block = false;
      return { content: [{ type: "text", text: "Restriction accepted" }] };
    });
    const session = {
      organization_id: agent.organizationId,
      caller_id: `user:${userId}`,
      session_id: sessionId,
    };
    let inference = 0;
    vi.mocked(anthropicAdapterFactory.createClient).mockImplementation(() => {
      const turn = inference++;
      const selected =
        turn === 1
          ? {
              name: "archestra__execute_remedy_plan",
              input: { offer_id: "test-offer" },
            }
          : { name: "get_weather", input: { location: "SF" } };
      const client = createAnthropicTestClient({
        includeToolUse: turn < 3,
        nonStreamingToolUse: turn < 3 ? selected : undefined,
        streamStopReason: turn < 3 ? "tool_use" : "end_turn",
      });
      const create = client.messages.create;
      client.messages.create = (async (
        params: Parameters<typeof create>[0],
      ) => {
        providerRequests.push(structuredClone(params));
        if (turn === 1) {
          expect(JSON.stringify(params)).toContain("NATIVE REFUSAL");
          expect(weather).not.toHaveBeenCalled();
          expect(remedy).not.toHaveBeenCalled();
        }
        const response = await create(params);
        // Preserve the boundary stub, giving each attempt a distinct provider ID.
        if (!(Symbol.asyncIterator in response))
          return {
            ...response,
            content:
              turn < 3
                ? [{ type: "tool_use", id: `attempt_${turn}`, ...selected }]
                : [{ type: "text", text: "Finished" }],
          };
        return (async function* () {
          let argumentsSent = false;
          for await (const event of response) {
            if (!event) continue;
            if (
              event?.type === "content_block_start" &&
              event.content_block.type === "tool_use"
            ) {
              yield {
                ...event,
                content_block: {
                  ...event.content_block,
                  id: `attempt_${turn}`,
                  name: selected.name,
                },
              };
            } else if (
              event?.type === "content_block_delta" &&
              event.delta.type === "input_json_delta"
            ) {
              if (argumentsSent) continue;
              argumentsSent = true;
              yield {
                ...event,
                delta: {
                  ...event.delta,
                  partial_json: JSON.stringify(selected.input),
                },
              };
            } else yield event;
          }
          return undefined;
        })();
      }) as typeof create;
      return client as never;
    });
    const sdk = createAnthropic({
      apiKey: "test-key",
      baseURL: `http://localhost/v1/anthropic/${agent.id}/v1`,
      headers: headers(),
      fetch: async (input, init) => {
        const response = await app.inject({
          method: "POST",
          url: new URL(String(input)).pathname,
          remoteAddress: "127.0.0.1",
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          payload: JSON.parse(String(init?.body)),
        });
        return new Response(response.body, {
          status: response.statusCode,
          headers: response.headers as Record<string, string>,
        });
      },
    });
    const bridge = withOpenAppaChat({
      model: sdk("claude-3-5-sonnet-20241022"),
      session,
      tools: {
        get_weather: tool({
          inputSchema: z.object({ location: z.string() }),
          execute: weather,
        }),
        archestra__execute_remedy_plan: tool({
          inputSchema: z.object({ offer_id: z.string() }),
          execute: remedy,
        }),
      },
    });
    const params = {
      ...bridge,
      prompt: "Check the weather",
      stopWhen: stepCountIs(4),
      maxRetries: 0,
    };
    const result = stream ? streamText(params) : await generateText(params);
    const steps = await result.steps;
    expect(steps).toHaveLength(4);
    expect(steps[0].toolResults[0].output).toMatchObject({
      isError: true,
      _meta: { archestraError: { type: "policy_denied" } },
    });
    expect(weather).toHaveBeenCalledTimes(1);
    expect(remedy).toHaveBeenCalledTimes(1);
    expect(
      events
        .filter((event) => event.event === "tool_result")
        .some((event) => event.tool_call_id === "attempt_0"),
    ).toBe(false);
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.tool),
    ).toEqual(["get_weather", "appa/execute_remedy_plan", "get_weather"]);
  });

  test.each([
    true,
    false,
  ])("only opted-in internal Chat receives a signed blocked attempt (stream=%s)", async (stream) => {
    block = true;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...headers(),
        [APPA_CHAT_BLOCK_HEADER]: "v1:2edfbd9f-ab24-4b4f-a1c0-346bb5c385a9",
      },
      payload: payload(stream),
    });
    expect(response.statusCode, response.body).toBe(200);
    const session = {
      organization_id: agent.organizationId,
      caller_id: `user:${userId}`,
      session_id: sessionId,
    };
    const blockResult = decodeChatBlock(response.body, session);
    expect(blockResult?.calls[0].name).toBe("get_weather");
    expect(blockResult?.feedback).toContain("test-offer");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(
      decodeChatBlock(response.body, {
        ...session,
        session_id: "another-chat",
      }),
    ).toBeNull();
  });

  test.each([
    true,
    false,
  ])("human-approval offers remain refusals without automatic remedies (stream=%s)", async (stream) => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      return JSON.stringify(
        event.event === "tool_call"
          ? {
              decision: "deny_call",
              feedback: "APPA: human approval required",
              review: [
                { offer_id: "review", text: "Review this weather request" },
              ],
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
    expect(response.body).toContain("APPA: human approval required");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "tool_call",
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
      const refusal =
        "NATIVE REFUSAL: archestra__execute_remedy_plan(offer_id: test-offer)";
      expect(response.body).toContain(refusal);
      if (stream) {
        expect(response.body).toContain(`"text":"${refusal}"`);
      } else {
        expect(response.json().content).toEqual([
          {
            type: "text",
            text: refusal,
            citations: [],
          },
        ]);
      }
      expect(response.body).not.toContain("tool call policy violated");
      expect(
        events.filter((event) => event.event === "tool_call"),
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
      const event = JSON.parse(raw);
      if (event.tool === "allowed_first") {
        events.push(event);
        return JSON.stringify({ decision: "allow_call" });
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
        .filter((event) => event.event === "tool_call")
        .map((event) => event.tool),
    ).toEqual(["allowed_first", "get_weather"]);
    expect(response.body).toContain(
      "NATIVE REFUSAL: archestra__execute_remedy_plan(offer_id: test-offer)",
    );
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
    expect(response.body).toContain("NATIVE REFUSAL");
    expect(response.body).toContain("archestra__execute_remedy_plan");
    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(events.filter((e) => e.event === "tool_call")).toEqual([
      expect.objectContaining({
        organization_id: agent.organizationId,
        caller_id: `user:${userId}`,
        session_id: sessionId,
        operation_id: "call:toolu_test_weather",
        tool: "get_weather",
        arguments: { location: "San Francisco", unit: "fahrenheit" },
      }),
    ]);
    expect(events.map((e) => e.event)).not.toContain("turn_end");
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
    expect(events.filter((e) => e.event === "tool_call")).toHaveLength(1);
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
        text: expect.stringContaining("NATIVE REFUSAL"),
      }),
    ]);
  });

  for (const stream of [true, false]) {
    test(`APPA owns invocation policy only while enabled (stream=${stream})`, async ({
      makeTool,
      makeToolPolicy,
    }) => {
      const tool = await makeTool({ name: "get_weather", agentId: agent.id });
      await makeToolPolicy(tool.id, {
        action: "block_always",
        conditions: [],
        reason: "Platform weather policy refused this call",
      });
      const evaluatePolicies = vi.spyOn(toolInvocation, "evaluatePolicies");
      const request = {
        method: "POST" as const,
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: payload(stream),
      };

      const allowed = await app.inject(request);
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.body).not.toContain(
        "Platform weather policy refused this call",
      );
      expect(allowed.body).toContain('"type":"tool_use"');
      expect(events).toContainEqual(
        expect.objectContaining({ event: "tool_call", tool: "get_weather" }),
      );
      expect(evaluatePolicies).not.toHaveBeenCalled();

      config.openappa.enabled = false;
      config.llmProxy.plugins = parseLlmProxyPlugins("appa", false);
      unregisterAppaPlugin();
      // Other plugins allowing a call must still run the ordinary policy check.
      const unregisterObserver = registerLlmProxyPlugin({
        id: "test-allow",
        async onToolCalls({ toolCalls }) {
          return { decision: "allow", toolCalls };
        },
      });
      const nativeCalls = events.length;
      try {
        const blocked = await app.inject(request);
        expect(blocked.statusCode, blocked.body).toBe(200);
        expect(blocked.body).toContain(
          "Platform weather policy refused this call",
        );
        expect(blocked.body).not.toContain('"type":"tool_use"');
        expect(evaluatePolicies).toHaveBeenCalledOnce();
        expect(events).toHaveLength(nativeCalls);
      } finally {
        unregisterObserver();
      }
    });
  }

  test("substitutes saved approved results before the provider sees resent history", async () => {
    const evaluateTrustedData = vi.spyOn(
      trustedData,
      "evaluateIfContextIsTrusted",
    );
    for (const raw of ["RAW SECRET", "ALTERED RAW SECRET"]) {
      const messages = [
        { role: "user", content: "Weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "previous-call",
              name: "get_weather",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "previous-call", content: raw },
          ],
        },
      ];
      const response = await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: headers(),
        payload: payload(false, messages),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.stringify(providerRequests.at(-1))).toContain(
        "APPROVED REPLACEMENT",
      );
      expect(JSON.stringify(providerRequests.at(-1))).not.toContain(
        "RAW SECRET",
      );
    }
    expect(events.filter((e) => e.event === "tool_result")).toEqual([
      expect.objectContaining({
        tool_call_id: "previous-call",
        outcome: "success",
      }),
      expect.objectContaining({
        tool_call_id: "previous-call",
        outcome: "success",
      }),
    ]);
    expect(evaluateTrustedData).not.toHaveBeenCalled();
  });

  test("executes an explicit remedy, then accepts a separate retry on the same APPA root", async () => {
    block = true;
    const denied = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false),
    });

    expect(denied.statusCode, denied.body).toBe(200);
    expect(denied.body).toContain("NATIVE REFUSAL");
    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "tool_call",
    ]);

    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      return JSON.stringify(
        event.event === "remedy"
          ? {
              decision: "mcp_result",
              result: { content: [{ type: "text", text: "Remedy applied" }] },
            }
          : event.event === "session_start"
            ? { decision: "ack" }
            : { decision: "allow_call" },
      );
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
    expect(retried.body).toContain('"type":"tool_use"');
    expect(events.filter((event) => event.event === "remedy")).toEqual([
      expect.objectContaining({
        session_id: sessionId,
        operation_id: "remedy:remedy-call",
      }),
    ]);
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.session_id),
    ).toEqual([sessionId, sessionId]);
  });

  test.each([
    ["Chat", {}, "get_weather"],
    [
      "Claude Code",
      {
        "user-agent": "Claude-Code/1",
        "x-claude-code-session-id": "native-client-session",
      },
      "host/claude-code/get_weather",
    ],
    ["Codex", { originator: "codex" }, "builtin:get_weather"],
    [
      "OpenCode",
      { "x-opencode-session": "native-client-session" },
      "builtin:get_weather",
    ],
  ])("binds the explicit APPA root exactly once for authenticated %s calls", async (_client, clientHeaders, expectedTool) => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), ...clientHeaders },
      payload: payload(false),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events.filter((event) => event.event === "session_start")).toEqual([
      expect.objectContaining({
        organization_id: agent.organizationId,
        caller_id: `user:${userId}`,
        session_id: sessionId,
      }),
    ]);
    expect(events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({ tool: expectedTool, session_id: sessionId }),
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
        event: "tool_call",
        session_id: sessionId,
        tool: "get_weather",
      }),
    );
  });

  test("rejects a Chat APPA root bound to another profile", async ({
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

    expect(response.statusCode, response.body).toBe(403);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
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
      expect.objectContaining({
        event: "session_start",
        session_id: sessionId,
        caller_id: `user:${userId}`,
      }),
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
    expect(events.some((e) => e.event === "tool_call")).toBe(true);
  });

  test.each([
    true,
    false,
  ])("disabled APPA uses existing evaluators without APPA metadata (stream=%s)", async (stream) => {
    config.openappa.enabled = false;
    config.llmProxy.plugins = [];
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

  test("reports explicit protocol failures and keeps APPA replacement text", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(false, [
        { role: "user", content: "Weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "failed-call",
              name: "get_weather",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "failed-call",
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
        tool_call_id: "failed-call",
        outcome: "failure",
      }),
    );
    expect(JSON.stringify(providerRequests[0])).toContain(
      "APPROVED REPLACEMENT",
    );
    expect(
      events.some(
        (event) => event.event === "prompt" || event.event === "turn_end",
      ),
    ).toBe(false);
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
        event: "tool_call",
        tool: "get_weather",
        arguments: { location: "SF" },
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
  ])("does not authenticate a remote caller claiming %s", async (source) => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "203.0.113.20",
      headers: { ...headers(), "x-archestra-source": source },
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
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
      expect.objectContaining({
        event: "session_start",
        organization_id: agent.organizationId,
        caller_id: `user:${userId}`,
        session_id: sessionId,
      }),
    );
  });
});
