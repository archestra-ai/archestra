/** Native decisions at the existing buffered proxy seam. The real native +
 * PostgreSQL engine is exercised separately by openappa-rs/smoke.test.cjs. */
import { DUAL_LLM_PROGRESS_CHANNEL_HEADER } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import type { ChatMcpElicitationBridge } from "@/clients/chat-mcp-elicitation";
import * as database from "@/database";
import { ModelModel } from "@/models";
import {
  APPA_CALLER_AUTH_HEADER,
  signChatIdentity,
} from "@/openappa/chat-identity";
import { registerChatReview } from "@/openappa/chat-review";
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
  let options: AnthropicStubOptions;
  let providerRequests: unknown[];
  let events: Array<Record<string, unknown>>;
  let block: boolean;
  let fail: boolean;

  beforeEach(async ({ makeAgent, makeUser, makeMember }) => {
    vi.stubEnv("ARCHESTRA_OPENAPPA_POLICY_PATH", "/test/policy.toml");
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
    "x-appa-session-id": "stable-session",
    [APPA_CALLER_AUTH_HEADER.toLowerCase()]: signChatIdentity({
      agentId: agent.id,
      userId,
      sessionId: "stable-session",
    }),
  });
  const url = () => `/v1/anthropic/${agent.id}/v1/messages`;

  test.each([
    true,
    false,
  ])("signed Chat opens review before releasing calls (stream=%s)", async (stream) => {
    let approved = false;
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "tool_call")
        return JSON.stringify({
          decision: "deny_call",
          review: [
            { offer_id: "review", text: "Review this exact weather request" },
          ],
        });
      if (event.event === "remedy_review")
        return JSON.stringify({
          decision: "review",
          review: [
            { offer_id: "review", text: "Review this exact weather request" },
          ],
        });
      if (event.event === "remedy") {
        approved = event.ruling === "approve";
        return JSON.stringify({
          decision: "mcp_result",
          result: { content: [] },
        });
      }
      if (event.event === "resume_tool_call")
        return JSON.stringify({
          decision: approved ? "allow_call" : "deny_call",
          reviewed: true,
        });
      return JSON.stringify({ decision: "ack" });
    });
    const elicit = vi
      .fn()
      .mockResolvedValue({ status: "answered", result: { action: "accept" } });
    const remove = registerChatReview(
      "review-turn",
      {
        organization_id: agent.organizationId,
        caller_id: `user:${userId}`,
        session_id: "stable-session",
      },
      { elicit } as unknown as ChatMcpElicitationBridge,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: {
          ...headers(),
          [DUAL_LLM_PROGRESS_CHANNEL_HEADER]: "review-turn",
        },
        payload: payload(stream),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(elicit).toHaveBeenCalledOnce();
      expect(response.body).toContain('"type":"tool_use"');
      expect(events.some((event) => event.event === "resume_tool_call")).toBe(
        true,
      );
    } finally {
      remove();
    }
  });

  for (const stream of [true, false]) {
    test(`returns denied calls to the authenticated Chat guard for a follow-up (${stream})`, async () => {
      block = true;
      const remove = registerChatReview(
        "blocked-turn",
        {
          organization_id: agent.organizationId,
          caller_id: `user:${userId}`,
          session_id: "stable-session",
        },
        { elicit: vi.fn() } as unknown as ChatMcpElicitationBridge,
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: url(),
          remoteAddress: "127.0.0.1",
          headers: {
            ...headers(),
            [DUAL_LLM_PROGRESS_CHANNEL_HEADER]: "blocked-turn",
          },
          payload: payload(stream),
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toContain('"type":"tool_use"');
        expect(response.body).toContain("toolu_test_weather");
        expect(response.body).not.toContain("NATIVE REFUSAL");
        expect(
          events.filter((event) => event.event === "tool_call"),
        ).toHaveLength(1);
      } finally {
        remove();
      }
    });
  }

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
        session_id: "stable-session",
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

  test("substitutes saved approved results before the provider sees resent history", async () => {
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
        outcome: "unknown",
      }),
      expect.objectContaining({
        tool_call_id: "previous-call",
        outcome: "unknown",
      }),
    ]);
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

  test("does not authenticate a remote caller from Chat attribution headers", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "203.0.113.20",
      headers: headers(),
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("does not authenticate forwarded attribution hints even from loopback", async () => {
    const unsigned = headers();
    delete unsigned[APPA_CALLER_AUTH_HEADER.toLowerCase()];
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: unsigned,
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("binds the authenticated Chat signature to its exact session", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), "x-appa-session-id": "another-session" },
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(providerRequests).toHaveLength(0);
  });
});
