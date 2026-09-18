/** Native decisions at the existing buffered proxy seam. The real native +
 * PostgreSQL engine is exercised separately by openappa-rs/smoke.test.cjs. */
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import * as database from "@/database";
import * as toolInvocation from "@/guardrails/tool-invocation";
import * as trustedData from "@/guardrails/trusted-data";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { buildExternalAppRenderResult } from "@/services/apps/app-render-result";
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
    config.openappa = parseOpenAppaConfig("true");
    // The server flag alone no longer enforces: the deployment-wide switch has
    // to be on too, and every case here is about APPA actually enforcing.
    await GuardrailsDeploymentModel.setEnabled(true);
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
    // Mirrors the real binding closely enough to be regression coverage: the
    // runtime remembers which call it denied, and answers that call's result
    // with its own ruling rather than with anything the client reported.
    const denied = new Set<string>();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "tool_call") {
        if (fail) throw new Error("private native database error");
        if (!block || event.tool === "allowed_first")
          return JSON.stringify({ decision: "allow_call" });
        denied.add(String(event.operation_id).replace(/^call:/, ""));
        return JSON.stringify({
          decision: "deny_call",
          feedback:
            "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
        });
      }
      if (event.event === "tool_result") {
        return JSON.stringify(
          denied.has(String(event.tool_call_id))
            ? {
                decision: "deny_call",
                feedback:
                  "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
                approved_output:
                  "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
                output_source: "runtime",
              }
            : {
                decision: "replace_output",
                approved_output: "APPROVED REPLACEMENT",
                output_source: "tool",
              },
        );
      }
      return JSON.stringify({ decision: "ack" });
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
      // A stock client declares both APPA tools through the platform's own MCP
      // endpoint; a session without them is refused before the provider is called.
      {
        name: "archestra__execute_remedy_plan",
        description: "Execute a remedy",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "archestra__get_remedy_plans",
        description: "Read a ruling",
        input_schema: { type: "object", properties: {} },
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

  const post = (
    payloadBody: unknown,
    extraHeaders: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), ...extraHeaders },
      payload: payloadBody as Record<string, unknown>,
    });

  /** The notice call the client received, arguments included. */
  const noticeFrom = (body: string, stream: boolean) => {
    if (!stream) {
      const call = (
        (JSON.parse(body).content ?? []) as Record<string, unknown>[]
      ).findLast((block) => block.type === "tool_use");
      return {
        name: call?.name as string,
        id: call?.id as string,
        input: call?.input as Record<string, unknown>,
      };
    }
    const events = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const start = events.findLast(
      (event) => event.type === "content_block_start",
    );
    // Only this block's deltas: a batch streams other calls' arguments too.
    const partial = events
      .filter(
        (event) =>
          event.delta?.type === "input_json_delta" &&
          event.index === start?.index,
      )
      .map((event) => event.delta.partial_json)
      .join("");
    return {
      name: start?.content_block?.name as string,
      id: start?.content_block?.id as string,
      input: (partial.length > 0
        ? JSON.parse(partial)
        : start?.content_block?.input) as Record<string, unknown>,
    };
  };

  test.each([
    true,
    false,
  ])("a denied call reaches the client as a denial notice, with no extra provider request (stream=%s)", async (stream) => {
    block = true;

    const response = await post(payload(stream));

    expect(response.statusCode, response.body).toBe(200);
    const notice = noticeFrom(response.body, stream);
    // Same position, same provider call id: the client runs the notice where
    // the model's own call stood, and the transcript shows what was blocked.
    expect(notice.name).toBe("archestra__get_remedy_plans");
    expect(notice.input.tool).toBe("get_weather");
    // The notice preserves the model argument bytes; the stub streams a fuller
    // argument set than it returns whole.
    expect(notice.input.arguments).toBe(
      stream
        ? JSON.stringify({ location: "San Francisco", unit: "fahrenheit" })
        : JSON.stringify({ location: "SF" }),
    );
    // The ruling travels in the clear, where a client-side judge can read it.
    expect(notice.input.ruling).toBe(
      "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
    );
    expect(notice.input.notice).toEqual({ v: 1, call_id: notice.id });
    // A denial costs no second call to the provider.
    expect(providerRequests).toHaveLength(1);
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      1,
    );
  });

  test("restores the denied call and its ruling on the client's next request", async () => {
    block = true;
    const first = await post(payload(false));
    const notice = noticeFrom(first.body, false);
    block = false;

    const second = await post(
      payload(false, [
        { role: "user", content: "Check the weather" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: notice.id,
              name: "archestra__get_remedy_plans",
              input: notice.input,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: notice.id,
              content: "rendered for the user",
            },
          ],
        },
      ]),
    );

    expect(second.statusCode, second.body).toBe(200);
    const sent = providerRequests.at(-1) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
      tools: { name: string }[];
    };
    // The provider is shown the call the model actually made, and APPA's ruling
    // as its result — never the proxy's own notice tool.
    expect(sent.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: notice.id,
      name: "get_weather",
      input: { location: "SF" },
    });
    expect(sent.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: notice.id,
      is_error: true,
      content:
        "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
    });
    expect(sent.tools.map((declared) => declared.name)).not.toContain(
      "archestra__get_remedy_plans",
    );
  });

  test.each([
    false,
    true,
  ])("stamps and restores the model's remedy call through the real adapter (stream=%s)", async (stream) => {
    const control = {
      name: "archestra__execute_remedy_plan",
      input: { offer_id: "test-offer" },
    };
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: control,
      streamingToolUse: control,
    };

    const response = await post(payload(stream));

    expect(response.statusCode, response.body).toBe(200);
    const released = noticeFrom(response.body, stream);
    // The client executes it against the gateway, which dispatches the one
    // control ToolCall. A second one here would vouch the offer twice.
    expect(released).toMatchObject({
      name: "archestra__execute_remedy_plan",
      input: {
        offer_id: "test-offer",
        execution: {
          v: 1,
          kind: "appa_remedy",
          call_id: released.id,
          tool_name: control.name,
          original_arguments: JSON.stringify(control.input),
        },
      },
    });
    expect(events.filter((event) => event.event === "tool_call")).toEqual([]);

    options = {};
    const followup = await post(
      payload(false, [
        { role: "user", content: "Apply the offered remedy" },
        {
          role: "assistant",
          content: [{ type: "tool_use", ...released }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: released.id,
              content: "Applied",
            },
          ],
        },
      ]),
    );
    expect(followup.statusCode, followup.body).toBe(200);
    expect(providerRequests.at(-1)).toMatchObject({
      messages: [
        expect.any(Object),
        {
          role: "assistant",
          content: [{ type: "tool_use", id: released.id, ...control }],
        },
        expect.any(Object),
      ],
    });
    expect(JSON.stringify(providerRequests.at(-1))).not.toContain(
      '"execution"',
    );
  });

  test.each([
    false,
    true,
  ])("re-emits an in-place rewrite so the client receives the policy-checked arguments (stream=%s)", async (stream) => {
    const unregister = registerLlmProxyPlugin({
      id: "test-in-place-rewriter",
      async onToolCalls({ toolCalls }) {
        toolCalls[0].arguments = { location: "approved" };
        return undefined;
      },
    });
    try {
      const tool = { name: "get_weather", input: { location: "original" } };
      options = {
        includeToolUse: true,
        streamStopReason: "tool_use",
        nonStreamingToolUse: tool,
        streamingToolUse: tool,
      };
      const response = await post(payload(stream));
      expect(response.statusCode, response.body).toBe(200);
      const released = noticeFrom(response.body, stream);
      expect(released.name).toBe("get_weather");
      expect(released.input).toEqual({ location: "approved" });
      expect(
        events.find((event) => event.event === "tool_call")?.arguments,
      ).toEqual({ location: "approved" });
    } finally {
      unregister();
    }
  });

  test("refuses a session that cannot show the model a denial, before calling the provider", async () => {
    const body = payload(false);
    body.tools = body.tools.filter(
      (declared) => declared.name !== "archestra__get_remedy_plans",
    );

    const response = await post(body);

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("does not declare get_remedy_plans");
    expect(providerRequests).toHaveLength(0);
    expect(events).toEqual([]);
  });

  test("passes a tool-less request without opening a root", async () => {
    const body = payload(false);
    // OpenCode's title generation and similar client-side questions declare no
    // tools: they proposed nothing, so there is nothing to govern.
    body.tools = [];
    options = { includeToolUse: false, streamStopReason: "end_turn" };

    const response = await post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toEqual([]);
    expect(providerRequests).toHaveLength(1);
  });

  test("still reports a result carried by a request that declares no tools", async () => {
    // A client that drops its tool list on the continuation must not thereby
    // keep the runtime from seeing the result of a call it released.
    const body = payload(false, [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_weather",
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
            tool_use_id: "toolu_weather",
            content: "RAW TOOL OUTPUT",
          },
        ],
      },
    ]);
    body.tools = [];
    options = { includeToolUse: false, streamStopReason: "end_turn" };

    const response = await post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(events.map((event) => event.event)).toContain("tool_result");
    const sent = providerRequests.at(-1) as {
      messages: { role: string; content: Record<string, unknown>[] }[];
    };
    expect(sent.messages[2].content[0].content).toBe("APPROVED REPLACEMENT");
  });

  test("reports one prompt and one turn end for a turn that runs no tool", async () => {
    options = { includeToolUse: false, streamStopReason: "end_turn" };

    await post(payload(false));

    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "turn_end",
    ]);
  });

  test("keeps the turn open while the client still owes a tool result", async () => {
    await post(payload(false));

    expect(events.map((event) => event.event)).toEqual([
      "session_start",
      "prompt",
      "tool_call",
    ]);
  });

  test("native failures release no tool call and leak no diagnostics", async () => {
    fail = true;

    const response = await post(payload(false));

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private native database error");
    expect(response.body).toContain("OpenAPPA could not safely complete");
  });

  test("does not trust a remote caller's delegation chain", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "203.0.113.20",
      headers: {
        ...headers(),
        "x-archestra-source": "a2a",
        "x-archestra-agent-id": `a637fb55-989b-4f01-a251-e7e277c65f05:${agent.id}`,
      },
      payload: payload(false),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(providerRequests).toHaveLength(0);
  });

  /** An external client: no APPA header, and not Chat's internal source. */
  const externalClientHeaders = () =>
    Object.fromEntries(
      Object.entries(headers()).filter(
        ([name]) =>
          name !== "x-appa-session-id" && name !== "x-archestra-source",
      ),
    );

  test("governs a client that sends no session header", async () => {
    // Every client the Connect page configures is one of these: it has no way
    // to know about OpenAPPA, and refusing it took the whole deployment down.
    // The wire adapter reads the session off the request instead.
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: externalClientHeaders(),
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toHaveLength(1);
    // Still governed, not waved through: the runtime saw the session open and
    // the call evaluated.
    expect(events).toContainEqual(
      expect.objectContaining({ event: "tool_call" }),
    );
  });

  test("binds a headerless Claude Code request to its own session", async () => {
    const claudeSession = "74582997-cc91-4cd5-baee-676e581ca028";
    await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": claudeSession,
      },
      payload: payload(false) as Record<string, unknown>,
    });

    // Scoped to the credential: the id is one another member of the
    // organization could learn and repeat, so the bare value binds nobody.
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${claudeSession}`,
      }),
    );
  });

  test("scopes an external client's explicit session to its credential", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    // Not loopback and not a platform header: a real external client with a
    // virtual key. The id it names is one another member of the organization
    // could learn and repeat, so it binds only under this credential.
    const secret = await makeSecret({ secret: { apiKey: "sk-ant-test" } });
    const providerKey = await makeLlmProviderApiKey(
      agent.organizationId,
      secret.id,
      { provider: "anthropic" },
    );
    const {
      value: virtualKey,
      virtualKey: { id: virtualKeyId },
    } = await VirtualApiKeyModel.create({
      name: "external-client",
      providerApiKeys: [
        { provider: providerKey.provider, providerApiKeyId: providerKey.id },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "203.0.113.20",
      headers: {
        authorization: `Bearer ${virtualKey}`,
        "anthropic-version": "2023-06-01",
        "x-appa-session-id": "external-session-1",
      },
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: expect.stringMatching(
          /^(virtual-key|user):[^|]+\|external-session-1$/,
        ),
      }),
    );

    // The frontend rewrites `/v1` to the backend over loopback, so the same
    // client can arrive on the loopback socket, and there it can write the
    // platform's own attribution header. Its credential still marks it as a
    // client, and the session is scoped to what the credential proves, not
    // to the user the header claims.
    events.length = 0;
    const viaFrontend = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: `Bearer ${virtualKey}`,
        "anthropic-version": "2023-06-01",
        "x-archestra-user-id": userId,
        "x-appa-session-id": "external-session-2",
      },
      payload: payload(false) as Record<string, unknown>,
    });
    expect(viaFrontend.statusCode, viaFrontend.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: expect.stringMatching(
          /^virtual-key:[^|]+\|external-session-2$/,
        ),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        session_id: expect.stringMatching(/^user:/),
      }),
    );

    // Naming a Chat source does not make it Chat: the credential proves an
    // organization key, not the platform, so the request is still a client's
    // and cannot bind to another member's conversation.
    events.length = 0;
    const asChat = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: `Bearer ${virtualKey}`,
        "anthropic-version": "2023-06-01",
        "x-archestra-source": "chat",
        "x-archestra-user-id": userId,
        "x-appa-session-id": sessionId,
      },
      payload: payload(false) as Record<string, unknown>,
    });
    expect(asChat.statusCode, asChat.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `virtual-key:${virtualKeyId}|${sessionId}`,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ session_id: sessionId }),
    );
  });

  test("refuses a Chat request that names no user, instead of binding it unchecked", async () => {
    const { "x-archestra-user-id": _user, ...noUser } = headers();
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: noUser,
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode).toBe(403);
    expect(events).toHaveLength(0);
  });

  test("binds a client whose reported session cannot be read to the credential's own root", async () => {
    // The client sent no header to be wrong about; a metadata value the
    // adapter cannot read as a session is no session, not a refusal.
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: externalClientHeaders(),
      payload: {
        ...(payload(false) as Record<string, unknown>),
        metadata: { user_id: "x".repeat(600) },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: expect.stringMatching(/^user:.*@/),
      }),
    );
  });

  test("still refuses a malformed session header", async () => {
    // A header that IS sent must be well-formed; silently deriving around a
    // broken one would hide a caller's bug and split its root in two.
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), "x-appa-session-id": "bad\u0007session" },
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode).toBe(400);
    expect(providerRequests).toHaveLength(0);
  });

  test("the proxy log follows an external client's explicit session header", async () => {
    // The runtime's ledger is keyed by this id; the interaction row follows
    // it, so the two records join on one id.
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-appa-session-id": "qa-session-1",
      },
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    const [interaction] = await database.default
      .select()
      .from(database.schema.interactionsTable)
      .where(eq(database.schema.interactionsTable.profileId, agent.id));
    expect(interaction.sessionId).toBe("qa-session-1");
    expect(interaction.sessionSource).toBe("appa_header");
  });

  test("keeps the ordinary provenance for a platform request that carries the same id in both headers", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-archestra-source": "chatops:slack",
        "x-archestra-session-id": "platform-thread-1",
        "x-appa-session-id": "platform-thread-1",
      },
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    const [interaction] = await database.default
      .select()
      .from(database.schema.interactionsTable)
      .where(eq(database.schema.interactionsTable.profileId, agent.id));
    expect(interaction.sessionId).toBe("platform-thread-1");
    expect(interaction.sessionSource).toBe("header");
  });

  test("releases an allowed streamed call through the existing adapter", async () => {
    const response = await post(payload());

    expect(response.statusCode, response.body).toBe(200);
    // The call the model made, in its own name: an allowed call is never
    // projected through the notice tool.
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain("toolu_test_weather");
    expect(response.body).not.toContain("get_remedy_plans");
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      1,
    );
  });

  test("a native failure releases no streamed tool delta and leaks no diagnostics", async () => {
    // The buffered seam must hold the deltas: a stream that has already shipped
    // a tool_use block cannot be taken back once the runtime fails to answer.
    fail = true;

    const response = await post(payload());

    expect(response.body).not.toContain('"type":"tool_use"');
    expect(response.body).not.toContain("input_json_delta");
    expect(response.body).not.toContain("private native database error");
    expect(events.some((event) => event.event === "tool_call")).toBe(true);
  });

  test("normalizes run_tool before APPA evaluates the target", async () => {
    // A gateway dispatch names its target inside the arguments. The runtime
    // must be shown that target, not the dispatcher, or every dispatched call
    // would be judged as one indistinguishable tool.
    options.nonStreamingToolUse = {
      name: "archestra__run_tool",
      input: { tool_name: "get_weather", tool_args: { location: "SF" } },
    };
    const body = payload(false);
    body.tools.push({
      name: "archestra__run_tool",
      description: "Run",
      input_schema: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          tool_args: { type: "object" },
        },
      },
    } as (typeof body.tools)[number]);

    const response = await post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_call",
        tool: "get_weather",
        arguments: { location: "SF" },
      }),
    );
  });

  test("reports an explicitly failed result as a failure and still substitutes its text", async () => {
    const response = await post(
      payload(false, [
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
    );

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
    // A result-carrying continuation is not a new user turn, and the model's
    // answer still carries a call, so neither boundary is reported.
    expect(
      events.some(
        (event) => event.event === "prompt" || event.event === "turn_end",
      ),
    ).toBe(false);
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
    // The client's own session id never becomes the root: the explicit header
    // does, and the call reaches the runtime under that client's namespace.
    const response = await post(payload(false), clientHeaders);

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
    const response = await post(payload(false), {
      "x-archestra-source": source,
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

    const response = await post(payload(false), {
      "x-appa-session-id": otherConversation.id,
    });

    expect(response.statusCode).toBe(403);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test("allows Chat compaction to retain its owner conversation root", async ({
    makeAgent,
  }) => {
    // Compaction runs against a summarizer profile, so the conversation's own
    // root would fail the profile check every other Chat request must pass.
    const compactionAgent = await makeAgent({
      organizationId: agent.organizationId,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/anthropic/${compactionAgent.id}/v1/messages`,
      remoteAddress: "127.0.0.1",
      headers: { ...headers(), "x-archestra-source": "chat:compaction" },
      payload: payload(false) as Record<string, unknown>,
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

  test.each([
    "chat",
    "chat:tool_call_repair",
    "chat:compaction",
    "chatops:slack",
  ])("does not authenticate a remote caller claiming %s", async (source) => {
    // A session id and a user-attribution header are claims, not credentials.
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "203.0.113.20",
      headers: { ...headers(), "x-archestra-source": source },
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(providerRequests).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  test.each([
    { stream: true, withUser: true },
    { stream: false, withUser: true },
    { stream: true, withUser: false },
    { stream: false, withUser: false },
  ])("checks internal Slack calls without requiring a user identity (stream=$stream, withUser=$withUser)", async ({
    stream,
    withUser,
  }) => {
    const { "x-archestra-user-id": _user, ...requestHeaders } = headers();
    const slackSessionId = "chatops:slack:shared-thread";

    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...requestHeaders,
        ...(withUser ? { "x-archestra-user-id": userId } : {}),
        "x-archestra-source": "chatops:slack",
        "x-appa-session-id": slackSessionId,
      },
      payload: payload(stream) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_call",
        organization_id: agent.organizationId,
        session_id: slackSessionId,
      }),
    );
    const start = events.find((event) => event.event === "session_start");
    expect(start?.caller_id).toBe(withUser ? `user:${userId}` : undefined);
  });

  test.each([
    { stream: true, enabled: true, denied: false },
    { stream: false, enabled: true, denied: false },
    { stream: true, enabled: true, denied: true },
    { stream: false, enabled: true, denied: true },
    { stream: true, enabled: false, denied: false },
    { stream: false, enabled: false, denied: false },
  ])("answers each call of a batch on its own (stream=$stream, enabled=$enabled, denied=$denied)", async ({
    stream,
    enabled,
    denied,
  }) => {
    // Two calls in one response: the runtime admits the first and denies the
    // second. The admitted call reaches the client untouched, arguments and all;
    // the denied one becomes its own notice. Nothing admitted is withdrawn, so
    // the runtime sees no cancellation.
    block = denied;
    if (!enabled) {
      config.openappa.enabled = false;
      config.llmProxy.plugins = [];
      unregisterAppaPlugin();
    }
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
    ).toEqual(enabled ? ["allowed_first", "get_weather"] : []);
    expect(events.map((event) => event.event)).not.toContain("cancel_call");
    expect(response.body).toContain('"type":"tool_use"');
    expect(response.body).toContain("allowed_first");
    expect(response.body).toContain("PRIVATE ALLOWED ARGUMENT");
    if (!enabled) {
      expect(events).toHaveLength(0);
      expect(response.body).toContain('"name":"get_weather"');
      return;
    }
    if (denied) {
      // The denied call is delivered as the notice call, under its own id.
      expect(response.body).toContain('"name":"archestra__get_remedy_plans"');
      expect(response.body).not.toContain('"name":"get_weather"');
      // The ruling travels in the clear, inside the notice call's arguments,
      // and never as text the client would show as the model's own words.
      expect(noticeFrom(response.body, stream).input.ruling).toContain(
        "NATIVE REFUSAL",
      );
      expect(response.body).not.toContain('"text":"NATIVE REFUSAL');
      return;
    }
    expect(response.body).toContain('"name":"get_weather"');
    expect(response.body).not.toContain("get_remedy_plans");
  });

  for (const stream of [true, false]) {
    test(`existing invocation policies remain enforced alongside APPA (stream=${stream})`, async ({
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

      const denied = await app.inject(request);
      expect(denied.statusCode, denied.body).toBe(200);
      expect(denied.body).toContain(
        "Platform weather policy refused this call",
      );
      expect(denied.body).not.toContain('"type":"tool_use"');
      expect(events.some((event) => event.event === "tool_call")).toBe(false);
      expect(evaluatePolicies).toHaveBeenCalledOnce();
      evaluatePolicies.mockClear();

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
        // A refusal is a terminal answer on both paths: the turn ends, so
        // the offers of this turn do not outlive it.
        expect(events).toContainEqual(
          expect.objectContaining({ event: "turn_end" }),
        );
      } finally {
        unregisterObserver();
      }
    });
  }

  for (const stream of [true, false]) {
    test(`deployment toggle off preserves existing enforcement without APPA headers (stream=${stream})`, async ({
      makeTool,
      makeToolPolicy,
    }) => {
      await GuardrailsDeploymentModel.setEnabled(false);
      const target = await makeTool({ name: "get_weather", agentId: agent.id });
      await makeToolPolicy(target.id, {
        action: "block_always",
        conditions: [],
        reason: "Existing guardrails still active",
      });
      const response = await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: { "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
        payload: payload(stream),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("Existing guardrails still active");
      expect(response.body).not.toContain('"type":"tool_use"');
      expect(events).toEqual([]);
    });

    test(`legacy policies check plugin rewrites before APPA reserves a call (stream=${stream})`, async ({
      makeTool,
      makeToolPolicy,
    }) => {
      const target = await makeTool({
        name: "get_weather",
        agentId: agent.id,
      });
      await makeToolPolicy(target.id, {
        action: "block_always",
        conditions: [{ key: "location", operator: "equal", value: "blocked" }],
        reason: "Rewritten target blocked",
      });
      const unregisterRewriter = registerLlmProxyPlugin({
        id: "test-rewriter",
        async onToolCalls({ toolCalls }) {
          return {
            decision: "allow",
            toolCalls: toolCalls.map((call) => ({
              ...call,
              arguments: JSON.stringify({ location: "blocked" }),
            })),
          };
        },
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: url(),
          remoteAddress: "127.0.0.1",
          headers: headers(),
          payload: payload(stream),
        });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body).toContain("Rewritten target blocked");
        expect(response.body).not.toContain('"type":"tool_use"');
        expect(events.some((event) => event.event === "tool_call")).toBe(false);
      } finally {
        unregisterRewriter();
      }
    });
  }

  test.each([
    true,
    false,
  ])("preserves seeded app renders while checking real results (stream=%s)", async (stream) => {
    const seeded = JSON.stringify(
      buildExternalAppRenderResult({
        mcpServerId: "test-server",
        resourceUri: "ui://test/board",
        label: "Test board",
      }),
    );
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (
        event.event === "tool_result" &&
        event.tool_call_id === "seeded-render"
      ) {
        throw new Error("No approved call for seeded render");
      }
      return dispatch?.(raw);
    });
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: headers(),
      payload: payload(stream, [
        { role: "user", content: "Open the board" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "seeded-render",
              name: "show_board",
              input: {},
            },
            {
              type: "tool_use",
              id: "real-call",
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
              tool_use_id: "seeded-render",
              content: seeded,
            },
            // A marker embedded in upstream text must still undergo approval.
            {
              type: "tool_result",
              tool_use_id: "real-call",
              content: JSON.stringify({ content: seeded }),
            },
            { type: "text", text: "What is on the board?" },
          ],
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(events.filter((event) => event.event === "tool_result")).toEqual([
      expect.objectContaining({ tool_call_id: "real-call" }),
    ]);
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.arrayContaining([
            expect.objectContaining({
              tool_use_id: "seeded-render",
              content: seeded,
            }),
            expect.objectContaining({
              tool_use_id: "real-call",
              content: "APPROVED REPLACEMENT",
            }),
          ]),
        }),
      ]),
    });
  });

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
    expect(evaluateTrustedData).toHaveBeenCalledTimes(2);
  });

  test("existing result blocking reaches APPA and stays untrusted for invocation checks", async ({
    makeTool,
    makeToolPolicy,
    makeTrustedDataPolicy,
  }) => {
    const target = await makeTool({ name: "get_weather", agentId: agent.id });
    await makeTrustedDataPolicy(target.id, {
      action: "block_always",
      conditions: [{ key: "secret", operator: "equal", value: "RAW SECRET" }],
      description: "Unsafe result",
    });
    await makeToolPolicy(target.id, {
      action: "block_when_context_is_untrusted",
      conditions: [],
      reason: "Existing untrusted-context policy",
    });
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
          {
            type: "tool_result",
            tool_use_id: "previous-call",
            content: JSON.stringify({ secret: "RAW SECRET" }),
          },
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
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_result",
        output: expect.stringContaining("Unsafe result"),
      }),
    );
    expect(events.some((event) => event.event === "tool_call")).toBe(false);
    expect(JSON.stringify(providerRequests)).toContain("APPROVED REPLACEMENT");
    expect(JSON.stringify(providerRequests)).not.toContain("RAW SECRET");
    expect(response.body).toContain("this session contains sensitive data");
    expect(response.body).not.toContain('"type":"tool_use"');
  });
});
