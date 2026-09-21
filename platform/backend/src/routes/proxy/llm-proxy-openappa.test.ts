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
import db, * as database from "@/database";
import * as toolInvocation from "@/guardrails/tool-invocation";
import * as trustedData from "@/guardrails/trusted-data";
import { InteractionModel, ModelModel, VirtualApiKeyModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { openappaActor } from "@/openappa/actor";
import { stageHitlReview } from "@/openappa/hitl-review";
import { buildNoticeArguments } from "@/openappa/notice";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import { appendSessionReceipt } from "@/openappa/session-token";
import { parseTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { buildExternalAppRenderResult } from "@/services/apps/app-render-result";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { type Agent, ApiError } from "@/types";
import { drainBackgroundWork } from "@/utils/background-work";
import { anthropicAdapterFactory, openaiAdapterFactory } from "./adapters";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import anthropicProxyRoutes from "./routes/anthropic";
import openAiProxyRoutes from "./routes/openai";

const native = vi.hoisted(() => ({
  initializeOpenappa: vi.fn(),
  dispatchHook: vi.fn(),
  // No batteries installed: the composed policy is the root alone.
  listBundledOpenappaBatteries: vi.fn(async () => []),
  composeOpenappaPolicy: vi.fn(async (input: { root: string }) => ({
    content: input.root,
    errors: [],
  })),
}));
vi.mock("@archestra/openappa-rs", () => native);
vi.mock("@/cache-manager");

describe("OpenAPPA on the existing LLM proxy", () => {
  let app: FastifyInstance;
  let agent: Agent;
  let userId: string;
  let sessionId: string;
  let options: AnthropicStubOptions;
  let providerRequests: unknown[];
  let providerResponses: unknown[];
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
    providerResponses = [];
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
      if (event.event === "session_start") {
        const runtimeSessionId = String(event.session_id);
        await db
          .insert(database.schema.openappaSessionsTable)
          .values({
            actor: openappaActor(runtimeSessionId),
            root: openappaActor(runtimeSessionId),
            organizationId: String(event.organization_id),
            callerId:
              typeof event.caller_id === "string" ? event.caller_id : null,
            sessionId: runtimeSessionId,
            forkedFrom:
              typeof event.fork_of === "string" ? event.fork_of : null,
            startDecision: { decision: "ack" },
          })
          .onConflictDoNothing();
      }
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
        const response = await create(params);
        providerResponses.push(response);
        return response;
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
    expect(notice.id).toBe("toolu_test_weather");
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
    expect(notice.input.notice).toEqual({
      v: 1,
      call_id: notice.id,
    });
    // A denial costs no second call to the provider.
    expect(providerRequests).toHaveLength(1);
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      1,
    );
  });

  /** A session that declares the run_tool dispatch surface beside the APPA pair. */
  const dispatchPayload = (
    stream: boolean,
    messages: unknown[] = [{ role: "user", content: "List my meetings" }],
  ) => {
    const body = payload(stream, messages);
    body.tools.push({
      name: "archestra__run_tool",
      description: "Dispatch a tool by name",
      input_schema: { type: "object", properties: {} },
    });
    return body;
  };
  const dispatchCall = {
    name: "archestra__run_tool",
    input: { tool_name: "grain__list_meetings", tool_args: { limit: 5 } },
  };

  test.each([
    true,
    false,
  ])("a denied run_tool dispatch reaches the client as a notice naming the target tool (stream=%s)", async (stream) => {
    block = true;
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };

    const response = await post(dispatchPayload(stream));

    expect(response.statusCode, response.body).toBe(200);
    // The runtime ruled on the dispatch's target — exact name and the target's
    // own arguments — so named rules, annotator bindings, and the wildcard
    // catch-all all apply to the tool that will actually execute.
    expect(events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({
        tool: "grain__list_meetings",
        arguments: { limit: 5 },
      }),
    ]);
    const notice = noticeFrom(response.body, stream);
    expect(notice.name).toBe("archestra__get_remedy_plans");
    // The model reads the ruling against the tool it asked for, not the
    // wrapper the call was transported in.
    expect(notice.input.tool).toBe("grain__list_meetings");
    expect(notice.input.arguments).toBe(JSON.stringify({ limit: 5 }));
    expect(notice.input.ruling).toBe(
      "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
    );
    expect(notice.input.notice).toEqual({
      v: 1,
      call_id: notice.id,
    });
    expect(providerRequests).toHaveLength(1);
  });

  test("restores a denied dispatch as the target call and its ruling on the next request", async () => {
    block = true;
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };
    const first = await post(dispatchPayload(false));
    const notice = noticeFrom(first.body, false);
    block = false;

    const second = await post(
      dispatchPayload(false, [
        { role: "user", content: "List my meetings" },
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
    };
    // History shows a direct call to the target with APPA's ruling as its
    // result — the wrapper never enters the transcript the model reads.
    expect(sent.messages[1].content[0]).toEqual({
      type: "tool_use",
      id: notice.id,
      name: "grain__list_meetings",
      input: { limit: 5 },
    });
    expect(sent.messages[2].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: notice.id,
      is_error: true,
      content:
        "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
    });
  });

  test("releases the retried dispatch as the wrapper after the remedy, still ruled on as the target", async () => {
    block = true;
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };
    const first = await post(dispatchPayload(false));
    const notice = noticeFrom(first.body, false);
    block = false;

    // The model spends the offer through the control tool.
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
    const remedyResponse = await post(
      dispatchPayload(false, [
        { role: "user", content: "List my meetings" },
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
    const remedy = noticeFrom(remedyResponse.body, false);
    expect(remedy.name).toBe("archestra__execute_remedy_plan");

    // The model retries the same envelope; the acceptance has narrowed the
    // session, so the runtime releases it this time.
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: dispatchCall,
      streamingToolUse: dispatchCall,
    };
    const retry = await post(
      dispatchPayload(false, [
        { role: "user", content: "List my meetings" },
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
        {
          role: "assistant",
          content: [{ type: "tool_use", ...remedy }],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: remedy.id,
              content: "Applied",
            },
          ],
        },
      ]),
    );

    expect(retry.statusCode, retry.body).toBe(200);
    const released = noticeFrom(retry.body, false);
    // The client receives the wrapper it can execute — never the unwrapped
    // target, which it may not even have declared.
    expect(released.name).toBe("archestra__run_tool");
    expect(released.input).toEqual(dispatchCall.input);
    // Both evaluations named the target to the runtime: the denial and the
    // release after the remedy.
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.tool),
    ).toEqual(["grain__list_meetings", "grain__list_meetings"]);
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

  test("signs the dispatch tool into the offer of a denied run_tool call", async () => {
    // The retry hint the runtime renders after the offer is accepted names
    // the tool the client called; a run_tool caller holds no tool by the
    // target's own name.
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "tool_call")
        return JSON.stringify({
          decision: "deny_call",
          feedback: "[appa] Blocked",
          offers: [{ offer_id: "offer-1" }],
        });
      return JSON.stringify({ decision: "ack" });
    });
    const body = payload(false);
    body.tools.push({
      name: "archestra__run_tool",
      description: "Run a tool",
      input_schema: { type: "object", properties: {} },
    } as (typeof body.tools)[number]);
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: {
        name: "archestra__run_tool",
        input: { tool_name: "archestra__whoami", tool_args: {} },
      },
    };

    const response = await post(body);

    expect(response.statusCode, response.body).toBe(200);
    const [offer] = noticeFrom(response.body, false).input.offers as {
      payload: string;
    }[];
    expect(JSON.parse(offer.payload)).toMatchObject({
      tool: "archestra__whoami",
      dispatch: "archestra__run_tool",
    });
  });

  test("admits a session that has not yet declared the APPA pair", async () => {
    const body = payload(false);
    body.tools = body.tools.filter(
      (declared) => declared.name !== "archestra__get_remedy_plans",
    );
    options = { includeToolUse: false, streamStopReason: "end_turn" };

    const response = await post(body);

    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests.length).toBeGreaterThan(0);
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

  test("governs an external ask_user result instead of trusting its name", async () => {
    const answer = "The user picked: Accept for this session.";
    const body = payload(false, [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_ask",
            name: "archestra__ask_user",
            input: {
              question: "Accept for this session?",
              options: [
                { label: "Accept for this session" },
                { label: "Do not accept" },
              ],
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ask", content: answer },
        ],
      },
    ]);
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

  test.each([
    true,
    false,
  ])("Claude Code presents ask_user as AskUserQuestion with the staged HITL review (stream=%s)", async (stream) => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    const claudeSession = "a3f81c2e-4b17-4d9a-9c08-7e2f1b6a4d90";
    const runtimeSession = `user:${userId}|${claudeSession}`;
    const offerId = "offer-hitl";
    const modelCopy = "Model-authored copy must not appear.";
    const offer = signOfferClaims(
      unsignedOfferClaims({
        organizationId: agent.organizationId,
        callerId: `user:${userId}`,
        sessionId: runtimeSession,
        offerId,
      }),
      config.openappa.offerSigningSecret,
    );
    await stageHitlReview({
      session: {
        organization_id: agent.organizationId,
        caller_id: `user:${userId}`,
        session_id: runtimeSession,
      },
      review: { offerId, text: "Canonical HITL review." },
    });
    const noticeId = "toolu_denied_weather";
    const noticeInput = buildNoticeArguments({
      id: noticeId,
      tool: "get_weather",
      arguments: { location: "SF" },
      result: "[appa] Blocked",
      offers: [offer],
    });
    const askUser = {
      name: "archestra__ask_user",
      input: {
        question: modelCopy,
        header: "Wrong",
        options: [{ label: "Yes" }, { label: "No" }],
        remedy_offer_ids: [offerId],
      },
    };
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: askUser,
      streamingToolUse: askUser,
    };
    const body = payload(stream, [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: noticeId,
            name: "archestra__get_remedy_plans",
            input: noticeInput,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: noticeId,
            content: "rendered for the user",
          },
        ],
      },
    ]);
    body.tools.push(
      {
        name: "archestra__ask_user",
        description: "Ask the user",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "AskUserQuestion",
        description: "Ask the user a question",
        input_schema: { type: "object", properties: {} },
      },
    );

    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "user-agent": "claude-code/2.1.258",
        "x-claude-code-session-id": claudeSession,
      },
      payload: body as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    const question = noticeFrom(response.body, stream);
    // Claude Code runs its own question tool, not the gateway ask_user.
    expect(question.name).toBe("AskUserQuestion");
    const stamp = parseTrajectoryStamp(question.id);
    expect(stamp?.callId).toMatch(
      /^toolu_aq1_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{22}$/,
    );
    expect(question.input).toEqual({
      questions: [
        {
          question: "Canonical HITL review.",
          header: "Approval",
          options: [
            {
              label: "Approve",
              description: "Allow this exact tool call.",
            },
            {
              label: "Deny",
              description: "Keep this tool call blocked.",
            },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(JSON.stringify(question.input)).not.toContain(modelCopy);
  });

  test.each([
    true,
    false,
  ])("a summarizer run in a session of its own opens as a fork of the session its stamped history came from (stream=%s)", async (stream) => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    const parent = "0d3990dc-ace0-4952-8ac5-2d5281e7261b";
    const summarizer = "65337062-8b5e-4bd0-9d8e-6f1c2a3b4c5d";
    const claudeCode = (session: string) => ({
      ...externalClientHeaders(),
      "user-agent": "claude-cli/2.1.278 (external, cli)",
      "x-claude-code-session-id": session,
    });

    // The parent's turn: the client is given a stamped id for the call.
    const first = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: claudeCode(parent),
      payload: payload(stream) as Record<string, unknown>,
    });
    expect(first.statusCode, first.body).toBe(200);
    const given = noticeFrom(first.body, stream);
    expect(parseTrajectoryStamp(given.id)).toMatchObject({
      sessionId: parent,
      callId: "toolu_test_weather",
    });
    // The log keeps the provider's id, which the history the next request
    // logs answers the call by.
    const logged = await latestLoggedResponse(agent.id);
    expect(logged).toContain("toolu_test_weather");
    expect(logged).not.toContain(given.id);

    // The client hands that context to a summarizer under a new session id,
    // as an out-of-band compaction does.
    const history = [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: given.id,
            name: given.name,
            input: given.input,
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: given.id, content: "Sunny" },
          { type: "text", text: "Summarize this conversation." },
        ],
      },
    ];
    events.length = 0;
    providerRequests.length = 0;
    const compaction = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: claudeCode(summarizer),
      payload: payload(false, history) as Record<string, unknown>,
    });

    expect(compaction.statusCode, compaction.body).toBe(200);
    // A root of its own, seeded from the parent's labels: the summarizer's
    // session forks the parent's, and nothing it does reaches the parent.
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: `user:${userId}|${summarizer}`,
        fork_of: `user:${userId}|${parent}`,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ session_id: `user:${userId}|${parent}` }),
    );
    // The provider only ever sees the id it minted.
    const sent = JSON.stringify(providerRequests);
    expect(sent).toContain("toolu_test_weather");
    expect(sent).not.toContain(given.id);
  });

  test("refuses unrelated signed receipts before a provider sees the request", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-context-secret-with-32-characters",
    };
    const callerId = `user:${userId}`;
    const first = "0d3990dc-ace0-4952-8ac5-2d5281e7261b";
    const second = "65337062-8b5e-4bd0-9d8e-6f1c2a3b4c5d";
    const tokens = ["AAA-AAAA", "BBB-BBBB"] as const;
    for (const [index, sessionId] of [first, second].entries()) {
      const scoped = `${callerId}|${sessionId}`;
      await db.insert(database.schema.openappaSessionsTable).values({
        actor: openappaActor(scoped),
        root: openappaActor(scoped),
        organizationId: agent.organizationId,
        callerId,
        sessionId: scoped,
        receiptToken: tokens[index],
        startDecision: { decision: "ack" },
      });
    }
    providerRequests.length = 0;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      },
      payload: payload(false, [
        {
          role: "user",
          content: `${appendSessionReceipt("first summary", tokens[0])}\n${appendSessionReceipt("second summary", tokens[1])}`,
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("unrelated sessions");
    expect(providerRequests).toHaveLength(0);
  });

  test("strips a valid receipt before forwarding and forks its started source", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-context-secret-with-32-characters",
    };
    const callerId = `user:${userId}`;
    const parent = "0d3990dc-ace0-4952-8ac5-2d5281e7261b";
    const replaying = "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6";
    const scopedParent = `${callerId}|${parent}`;
    const parentToken = "AAA-AAAA";
    await db.insert(database.schema.openappaSessionsTable).values({
      actor: openappaActor(scopedParent),
      root: openappaActor(scopedParent),
      organizationId: agent.organizationId,
      callerId,
      sessionId: scopedParent,
      receiptToken: parentToken,
      startDecision: { decision: "ack" },
    });
    providerRequests.length = 0;
    events.length = 0;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": replaying,
      },
      payload: payload(false, [
        {
          role: "user",
          content: appendSessionReceipt("compacted summary", parentToken),
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(providerRequests)).not.toContain("protected session");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: `${callerId}|${replaying}`,
        fork_of: scopedParent,
      }),
    );
  });

  test("strips receipts even with OpenAPPA off: providers and logs never see the mark", async () => {
    await GuardrailsDeploymentModel.setEnabled(false);
    providerRequests.length = 0;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      },
      payload: payload(false, [
        {
          role: "user",
          content: appendSessionReceipt(
            "summary from a protected session",
            "AAA-AAAA",
          ),
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toHaveLength(1);
    const forwarded = JSON.stringify(providerRequests);
    expect(forwarded).toContain("summary from a protected session");
    expect(forwarded).not.toContain("protected session  AAA-AAAA");
    expect(forwarded).not.toContain("▄█▄▄▄█▄");
    const logged = await db
      .select()
      .from(database.schema.interactionsTable)
      .where(
        eq(
          database.schema.interactionsTable.sessionId,
          "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
        ),
      );
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain("▄█▄▄▄█▄");
  });

  test("Archestra Chat never receives the session mark, even on a first turn", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-context-secret-with-32-characters",
    };
    // The default post() goes through Chat's internal path: loopback,
    // x-archestra-source: chat, x-appa-session-id. Fresh conversation, so the
    // session has issued no receipt yet — emission must still not trigger.
    const response = await post(payload(false));

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("protected session");
    expect(response.body).not.toContain("▄█▄▄▄█▄");
    const streamed = await post(payload(true));
    expect(streamed.statusCode, streamed.body).toBe(200);
    expect(streamed.body).not.toContain("protected session");
  });

  test("carries a started source through two tool-less summaries", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-context-secret-with-32-characters",
    };
    const callerId = `user:${userId}`;
    const parent = "0d3990dc-ace0-4952-8ac5-2d5281e7261b";
    const scopedParent = `${callerId}|${parent}`;
    const parentToken = "AAA-AAAA";
    await db.insert(database.schema.openappaSessionsTable).values({
      actor: openappaActor(scopedParent),
      root: openappaActor(scopedParent),
      organizationId: agent.organizationId,
      callerId,
      sessionId: scopedParent,
      receiptToken: parentToken,
      startDecision: { decision: "ack" },
    });
    options = { includeToolUse: false, streamStopReason: "end_turn" };
    const summarize = async (session: string, content: string) => {
      const body = payload(false, [{ role: "user", content }]);
      body.tools = [];
      return await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: {
          ...externalClientHeaders(),
          "user-agent": "claude-cli/2.1.278 (external, cli)",
          "x-claude-code-session-id": session,
        },
        payload: body,
      });
    };

    const first = await summarize(
      "65337062-8b5e-4bd0-9d8e-6f1c2a3b4c5d",
      appendSessionReceipt("first compacted summary", parentToken),
    );
    expect(first.statusCode, first.body).toBe(200);
    const firstText = (first.json().content as Array<{ text: string }>)[0].text;
    expect(JSON.stringify(providerRequests.at(-1))).not.toContain(
      "protected session",
    );
    expect(JSON.stringify(providerRequests.at(-1))).toContain(
      "first compacted summary",
    );
    expect(JSON.stringify(providerResponses.at(-1))).not.toContain(
      "protected session",
    );
    expect(await latestLoggedResponse(agent.id)).not.toContain(
      "protected session",
    );

    const second = await summarize(
      "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      firstText,
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(JSON.stringify(providerRequests.at(-1))).not.toContain(
      "protected session",
    );
  });

  test("does not append a context envelope to an Anthropic structured JSON response", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-context-secret-with-32-characters",
    };
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "user-agent": "claude-cli/2.1.278 (external, cli)",
        "x-claude-code-session-id": "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      },
      payload: {
        ...payload(false),
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: {} },
          },
        },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("protected session");
  });

  test("appends a session receipt to a Claude compaction summary", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-context-secret-with-32-characters",
    };
    options = { includeToolUse: false, streamStopReason: "end_turn" };
    const headers = {
      ...externalClientHeaders(),
      "user-agent": "claude-cli/2.1.278 (external, cli)",
      "x-claude-code-session-id": "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
    };
    const postSession = (messages: unknown[]) =>
      app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers,
        payload: payload(false, messages),
      });

    const first = await postSession([
      { role: "user", content: "Check the weather" },
    ]);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body).toContain("protected session");
    await drainBackgroundWork();

    const followUp = await postSession([
      { role: "user", content: "and tomorrow?" },
    ]);
    expect(followUp.statusCode, followUp.body).toBe(200);
    expect(followUp.body).not.toContain("protected session");

    const compact = await postSession([
      { role: "assistant", content: "Earlier answer" },
      {
        role: "user",
        content:
          "CRITICAL: Respond with TEXT ONLY. Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests.",
      },
    ]);
    expect(compact.statusCode, compact.body).toBe(200);
    expect(compact.body).toContain("protected session");

    const toolEcho = await postSession([
      { role: "user", content: "continue" },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content:
              "Your task is to create a detailed summary of the conversation so far",
          },
        ],
      },
    ]);
    expect(toolEcho.statusCode, toolEcho.body).toBe(200);
    expect(toolEcho.body).not.toContain("protected session");
  });

  test("treats a broken or old-format marker as inert text", async () => {
    providerRequests.length = 0;
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      },
      payload: payload(false, [
        {
          role: "user",
          content: "summary\n\n<!-- appa-context-v1:broken -->",
        },
      ]),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(providerRequests).toHaveLength(1);
    expect(JSON.stringify(providerRequests[0])).toContain(
      "appa-context-v1:broken",
    );
  });

  test("a history stamped for another member, or with a forged stamp, opens the replaying session's own root", async ({
    makeUser,
    makeMember,
  }) => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    const parent = "0d3990dc-ace0-4952-8ac5-2d5281e7261b";
    const replaying = "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6";
    const first = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": parent,
      },
      payload: payload(false) as Record<string, unknown>,
    });
    const stamped = noticeFrom(first.body, false).id;
    const genuine = parseTrajectoryStamp(stamped);
    expect(genuine?.sessionId).toBe(parent);
    // The same call claimed for another session, under the parent's tag.
    const forged = `appat1${Buffer.from(`${replaying}-other\u0000toolu_test_weather`).toString("base64url")}${genuine?.tag}`;
    const historyWith = (id: string) => [
      { role: "user", content: "Check the weather" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id,
            name: "get_weather",
            input: { location: "SF" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: "Sunny" }],
      },
    ];
    const stranger = (await makeUser()).id;
    await makeMember(stranger, agent.organizationId);

    for (const [caller, id] of [
      [stranger, stamped],
      [userId, forged],
    ]) {
      events.length = 0;
      providerRequests.length = 0;
      const response = await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: {
          ...externalClientHeaders(),
          "x-archestra-user-id": caller,
          "x-claude-code-session-id": replaying,
        },
        payload: payload(false, historyWith(id)) as Record<string, unknown>,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(events).toContainEqual(
        expect.objectContaining({ session_id: `user:${caller}|${replaying}` }),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ fork_of: expect.anything() }),
      );
      // Unverified or not, a stamp never reaches the provider.
      const sent = JSON.stringify(providerRequests);
      expect(sent).toContain("toolu_test_weather");
      expect(sent).not.toContain("appat1");
    }
  });

  test("a history mixing two unrelated sessions of the caller is refused before the provider", async () => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    const ids: string[] = [];
    for (const session of [
      "0d3990dc-ace0-4952-8ac5-2d5281e7261b",
      "65337062-8b5e-4bd0-9d8e-6f1c2a3b4c5d",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: url(),
        remoteAddress: "127.0.0.1",
        headers: {
          ...externalClientHeaders(),
          "x-claude-code-session-id": session,
        },
        payload: payload(false) as Record<string, unknown>,
      });
      ids.push(noticeFrom(response.body, false).id);
    }
    providerRequests.length = 0;
    const merged = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": "68c625e3-1b2c-4d3e-8f90-a1b2c3d4e5f6",
      },
      payload: payload(
        false,
        ids.flatMap((id) => [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id,
                name: "get_weather",
                input: { location: "SF" },
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
          },
        ]),
      ) as Record<string, unknown>,
    });

    expect(merged.statusCode, merged.body).toBe(400);
    expect(merged.body).toContain("unrelated sessions");
    expect(providerRequests).toHaveLength(0);
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

  test("refuses an invalid Claude Code session ID before deriving a fallback root", async () => {
    const response = await app.inject({
      method: "POST",
      url: url(),
      remoteAddress: "127.0.0.1",
      headers: {
        ...externalClientHeaders(),
        "x-claude-code-session-id": "x".repeat(513),
      },
      payload: payload(false) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("valid client-native session ID");
    expect(events).toHaveLength(0);
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
      "get_weather",
    ],
    ["Codex", { originator: "codex" }, "get_weather"],
    [
      "OpenCode",
      { "x-opencode-session": "native-client-session" },
      "get_weather",
    ],
  ])("binds the explicit APPA root exactly once for authenticated %s calls", async (_client, clientHeaders, expectedTool) => {
    // The client's own session id never becomes the root: the explicit header
    // does, and local client decorations are normalized before runtime dispatch.
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

  test.for([
    ["my_gateway_archestra__whoami", "archestra__whoami"],
    ["lookalike_archestra__whoami", "lookalike_archestra__whoami"],
  ] as const)("rules OpenCode's %s by whether its label is one of our gateways", async ([
    called,
    expectedTool,
  ], { makeAgent }) => {
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });
    const body = payload(false);
    // OpenCode joins an MCP server's label to each tool name with one `_`.
    for (const name of [
      "my_gateway_archestra__whoami",
      "lookalike_archestra__whoami",
    ])
      body.tools.push({
        name,
        description: name,
        input_schema: { type: "object", properties: {} },
      } as (typeof body.tools)[number]);
    options = {
      includeToolUse: true,
      streamStopReason: "tool_use",
      nonStreamingToolUse: { name: called, input: {} },
    };

    const response = await post(body, {
      "user-agent": "opencode/1.18.31",
      "x-session-id": "ses_opencode_labels",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({ tool: expectedTool }),
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

  test("Claude Code compact stays on the root and a new session opens a fresh root with no parent id", async () => {
    const parent = "claude-label-parent";
    const child = "claude-label-child";
    const compactBody = payload(false);
    compactBody.messages = [
      { role: "user", content: "<command-name>/compact</command-name>" },
    ];
    expect(
      (
        await post(compactBody, {
          "user-agent": "claude-code/2.1.258",
          "x-claude-code-session-id": parent,
          "x-appa-session-id": parent,
          "x-archestra-source": "api",
        })
      ).statusCode,
    ).toBe(200);
    events.length = 0;
    const response = await post(payload(false), {
      "user-agent": "claude-code/2.1.258",
      "x-claude-code-session-id": child,
      "x-appa-session-id": child,
      "x-archestra-source": "api",
    });
    expect(response.statusCode, response.body).toBe(200);
    // The runtime opens children only on a spawn the parent prepared; a bare
    // parent id would refuse the forked session outright. A client fork opens
    // a fresh root: same label state as a stranger, nothing smeared.
    const starts = events.filter((event) => event.event === "session_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].session_id).toContain(child);
    expect(starts[0].parent_id).toBeUndefined();
  });

  test("Chat compaction stays on the conversation root and a new conversation opens a fresh root", async ({
    makeConversation,
  }) => {
    const compact = await post(payload(false), {
      "x-archestra-source": "chat:compaction",
    });
    expect(compact.statusCode, compact.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: expect.stringContaining(sessionId),
      }),
    );
    events.length = 0;
    const childConversation = await makeConversation(agent.id, {
      userId,
      organizationId: agent.organizationId,
    });
    const response = await post(payload(false), {
      "x-appa-session-id": childConversation.id,
      "x-archestra-source": "chat",
    });
    expect(response.statusCode, response.body).toBe(200);
    const starts = events.filter((event) => event.event === "session_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].session_id).toContain(childConversation.id);
    expect(starts[0].parent_id).toBeUndefined();
  });
});

/** Client-native trajectory binding: the adapter-read ids reach the runtime. */
describe("OpenAPPA client trajectory binding on the OpenAI families", () => {
  const CODEX_SESSION = "d12f967d-6fe1-4f92-a62f-0f6a2092fd2f";
  const CODEX_RESUMED_SESSION = "f5be22fa-3d3a-44ce-8d37-d0073acd5174";
  const CODEX_THREAD = "01a0859b-3029-78f3-a730-0edef60872cb";
  const CODEX_FORK_THREAD = "01a085a0-ca43-7671-9450-8508eddef38d";
  const OPENCODE_SESSION = "ses_01J8ZQ3V0R1Y8M0P4K0W3M7P9A";
  const OPENCODE_FORK_SESSION = "ses_01J8ZQ7K2M4N6P8R0T2W4Y6A8C";

  let app: FastifyInstance;
  let agent: Agent;
  let userId: string;
  let events: Array<Record<string, unknown>>;
  let providerCalls: number;
  let providerBodies: unknown[];
  let unregisterAppaPlugin: () => void;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    config.openappa = parseOpenAppaConfig("true");
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
    await app.register(openAiProxyRoutes);
    agent = await makeAgent({ name: "Native proxy OpenAI test" });
    userId = (await makeUser()).id;
    await makeMember(userId, agent.organizationId);
    events = [];
    providerCalls = 0;
    providerBodies = [];
    native.initializeOpenappa.mockResolvedValue(undefined);
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "session_start") {
        const runtimeSessionId = String(event.session_id);
        await db
          .insert(database.schema.openappaSessionsTable)
          .values({
            actor: openappaActor(runtimeSessionId),
            root: openappaActor(runtimeSessionId),
            organizationId: String(event.organization_id),
            callerId:
              typeof event.caller_id === "string" ? event.caller_id : null,
            sessionId: runtimeSessionId,
            forkedFrom:
              typeof event.fork_of === "string" ? event.fork_of : null,
            startDecision: { decision: "ack" },
          })
          .onConflictDoNothing();
      }
      if (event.event === "tool_call")
        return JSON.stringify({ decision: "allow_call" });
      if (event.event === "tool_result")
        return JSON.stringify({
          decision: "replace_output",
          approved_output: "APPROVED REPLACEMENT",
          output_source: "tool",
        });
      return JSON.stringify({ decision: "ack" });
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: unknown) => {
              providerCalls += 1;
              providerBodies.push(params);
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    type: "response.completed",
                    sequence_number: 1,
                    response: {
                      id: "resp_1",
                      object: "response",
                      status: "completed",
                      output: [],
                      usage: {
                        input_tokens: 3,
                        output_tokens: 2,
                        total_tokens: 5,
                      },
                    },
                  };
                },
              };
            },
          },
        }) as never,
    );
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
    for (const modelId of ["gpt-5.5", "gpt-4.1"]) {
      await ModelModel.upsert({
        externalId: `openai/${modelId}`,
        provider: "openai",
        modelId,
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
    }
  });

  afterEach(async () => {
    unregisterAppaPlugin();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app.close();
  });

  const codexPayload = (clientMetadata: Record<string, unknown>) => ({
    model: "gpt-5.5",
    stream: true,
    input: [{ role: "user", content: "Check the weather" }],
    client_metadata: clientMetadata,
    tools: [
      {
        type: "function",
        name: "get_weather",
        description: "Weather",
        parameters: {
          type: "object",
          properties: { location: { type: "string" } },
        },
      },
      {
        type: "function",
        name: "archestra__execute_remedy_plan",
        description: "Execute a remedy",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "archestra__get_remedy_plans",
        description: "Read a ruling",
        parameters: { type: "object", properties: {} },
      },
    ],
  });

  const codexHeaders = () => ({
    authorization: "Bearer test-key",
    "x-archestra-user-id": userId,
    "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
    originator: "codex_cli_rs",
  });

  const openCodePayload = () => ({
    model: "gpt-4.1",
    messages: [{ role: "user", content: "Check the weather" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
      },
      {
        type: "function",
        function: {
          name: "archestra__execute_remedy_plan",
          description: "Execute a remedy",
          parameters: { type: "object", properties: {} },
        },
      },
      {
        type: "function",
        function: {
          name: "archestra__get_remedy_plans",
          description: "Read a ruling",
          parameters: { type: "object", properties: {} },
        },
      },
    ],
  });

  const openCodeHeaders = () => ({
    authorization: "Bearer test-key",
    "x-archestra-user-id": userId,
    "user-agent": "opencode/1.18.29",
  });

  test("injects a missing APPA pair in the flat Responses tool shape", async () => {
    const payload = codexPayload({
      session_id: CODEX_SESSION,
      thread_id: CODEX_THREAD,
    });
    payload.tools = payload.tools.filter(
      (declared) => !declared.name.startsWith("archestra__"),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: payload as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    // The notice tool never reaches the model; the injected control tool must
    // use the declaration shape the Responses API accepts.
    const sent = providerBodies.at(-1) as { tools: Record<string, unknown>[] };
    expect(sent.tools.map((tool) => tool.name)).toEqual([
      "get_weather",
      "archestra__execute_remedy_plan",
    ]);
    expect(sent.tools[1]).toEqual({
      type: "function",
      name: "archestra__execute_remedy_plan",
      parameters: { type: "object", properties: {} },
    });
  });

  /** Codex declares an MCP server's tools as members of one namespace. */
  const codexNamespace = (name: string) => ({
    type: "namespace",
    name,
    tools: [
      "archestra__execute_remedy_plan",
      "archestra__get_remedy_plans",
    ].map((member) => ({
      type: "function",
      name: member,
      parameters: { type: "object", properties: {} },
    })),
  });

  /**
   * A non-streamed Codex turn whose one call the runtime denies, under the
   * given declarations: what the client receives, and what the provider was
   * sent.
   */
  const deniedCodexTurn = async (tools: unknown[]) => {
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "tool_call")
        return JSON.stringify({
          decision: "deny_call",
          feedback: "[appa] NATIVE REFUSAL",
        });
      return JSON.stringify({ decision: "ack" });
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: unknown) => {
              providerBodies.push(structuredClone(params));
              return {
                id: "resp_denied",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.5",
                output: [
                  {
                    type: "function_call",
                    id: "fc_shell",
                    call_id: "call_shell",
                    name: "exec_command",
                    arguments: '{"cmd":"echo hi"}',
                    status: "completed",
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              };
            },
          },
        }) as never,
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: {
        ...codexPayload({ session_id: CODEX_SESSION, thread_id: CODEX_THREAD }),
        stream: false,
        tools: [
          {
            type: "function",
            name: "exec_command",
            parameters: { type: "object", properties: {} },
          },
          ...tools,
        ],
      } as Record<string, unknown>,
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      output: response.json().output as Record<string, unknown>[],
      sent: providerBodies.at(-1) as { tools: Record<string, unknown>[] },
    };
  };

  test("delivers a Codex denial notice under the namespace Codex declared it in", async ({
    makeAgent,
  }) => {
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });

    const { output } = await deniedCodexTurn([
      codexNamespace("mcp__my_gateway"),
    ]);

    expect(output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "call_shell",
        name: "archestra__get_remedy_plans",
        namespace: "mcp__my_gateway",
      }),
    ]);
  });

  test("never delivers a Codex denial notice to a lookalike's namespace declared before the gateway's", async ({
    makeAgent,
  }) => {
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });

    // The notice carries the denied call's arguments: in the lookalike's
    // namespace, Codex would hand them to that server.
    const { output } = await deniedCodexTurn([
      codexNamespace("mcp__lookalike"),
      codexNamespace("mcp__my_gateway"),
    ]);

    expect(output).toEqual([
      expect.objectContaining({
        call_id: "call_shell",
        name: "archestra__get_remedy_plans",
        namespace: "mcp__my_gateway",
      }),
    ]);
  });

  test("a Codex session without its gateway gets the injected pair, never a lookalike's", async () => {
    const { output, sent } = await deniedCodexTurn([
      codexNamespace("mcp__lookalike"),
    ]);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      call_id: "call_shell",
      name: "archestra__get_remedy_plans",
    });
    expect(output[0].namespace).toBeUndefined();
    expect(sent.tools).toContainEqual({
      type: "function",
      name: "archestra__execute_remedy_plan",
      parameters: { type: "object", properties: {} },
    });
  });

  test.for([
    false,
    true,
  ])("delivers a held web search's notice under the gateway's namespace, with a stamped id (stream=%s)", async (stream, {
    makeAgent,
  }) => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      if (event.event === "tool_call")
        return JSON.stringify({
          decision: "deny_call",
          feedback: "[appa] NATIVE REFUSAL",
        });
      return JSON.stringify({ decision: "ack" });
    });
    const search = {
      id: "ws_1",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "latest release" },
    };
    const answer = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Found it", annotations: [] }],
    };
    const completed = {
      id: "resp_search",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.5",
      output: [search, answer],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: { stream?: boolean }) => {
              if (!params.stream) return completed;
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    type: "response.output_item.added",
                    sequence_number: 1,
                    output_index: 0,
                    item: { ...search, status: "in_progress" },
                  };
                  yield {
                    type: "response.output_item.done",
                    sequence_number: 2,
                    output_index: 0,
                    item: search,
                  };
                  yield {
                    type: "response.output_item.done",
                    sequence_number: 3,
                    output_index: 1,
                    item: answer,
                  };
                  yield {
                    type: "response.completed",
                    sequence_number: 4,
                    response: completed,
                  };
                },
              };
            },
          },
        }) as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: {
        ...codexPayload({ session_id: CODEX_SESSION, thread_id: CODEX_THREAD }),
        stream,
        tools: [{ type: "web_search" }, codexNamespace("mcp__my_gateway")],
      } as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    // What Codex keeps: the last completed envelope, or the whole response.
    const output: Record<string, unknown>[] = stream
      ? response.body
          .split("\n")
          .filter(
            (line) => line.startsWith("data: ") && line !== "data: [DONE]",
          )
          .map((line) => JSON.parse(line.slice("data: ".length)))
          .findLast((event) => event.type === "response.completed").response
          .output
      : response.json().output;
    const notice = output.find((item) => item.type === "function_call");
    expect(notice).toMatchObject({
      name: "archestra__get_remedy_plans",
      namespace: "mcp__my_gateway",
    });
    expect(parseTrajectoryStamp(String(notice?.call_id))).toMatchObject({
      sessionId: CODEX_THREAD,
      callId: "ws_1",
    });
    expect(JSON.stringify(output)).not.toContain("Found it");
  });

  test("rules a Codex call by the namespace it names: the gateway's is ours, a lookalike's stays foreign", async ({
    makeAgent,
  }) => {
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });
    const whoami = (namespace: string, callId: string) => ({
      type: "function_call",
      id: `fc_${callId}`,
      call_id: callId,
      name: "archestra__whoami",
      namespace,
      arguments: "{}",
      status: "completed",
    });
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () => ({
              id: "resp_ns",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "gpt-5.5",
              output: [
                whoami("mcp__my_gateway", "call_gateway"),
                whoami("mcp__lookalike", "call_lookalike"),
              ],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            }),
          },
        }) as never,
    );
    const member = (name: string) => ({
      type: "function",
      name,
      parameters: { type: "object", properties: {} },
    });
    const payload = {
      ...codexPayload({ session_id: CODEX_SESSION, thread_id: CODEX_THREAD }),
      stream: false,
      tools: [
        member("exec_command"),
        {
          type: "namespace",
          name: "mcp__my_gateway",
          tools: [
            member("archestra__execute_remedy_plan"),
            member("archestra__get_remedy_plans"),
            member("archestra__whoami"),
          ],
        },
        {
          type: "namespace",
          name: "mcp__lookalike",
          tools: [member("archestra__whoami")],
        },
      ],
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: payload as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.tool),
    ).toEqual(["archestra__whoami", "mcp__lookalike__archestra__whoami"]);
  });

  test("a Codex resume reopens the thread's root; a fork opens a fresh one", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: codexPayload({
        session_id: CODEX_SESSION,
        thread_id: CODEX_THREAD,
      }) as Record<string, unknown>,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );

    // A resume replays the durable thread under a fresh per-run session id.
    events.length = 0;
    const resumed = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: codexPayload({
        session_id: CODEX_RESUMED_SESSION,
        thread_id: CODEX_THREAD,
      }) as Record<string, unknown>,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );

    // A fork mints a new thread id and therefore binds a fresh root.
    events.length = 0;
    const forked = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: codexPayload({
        session_id: CODEX_RESUMED_SESSION,
        thread_id: CODEX_FORK_THREAD,
        forked_from_thread_id: CODEX_THREAD,
      }) as Record<string, unknown>,
    });
    expect(forked.statusCode, forked.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_FORK_THREAD}`,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );
  });

  test("a Codex compaction turn stays on the thread's root", async () => {
    const compaction = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...codexHeaders(), "x-openai-subagent": "compact" },
      payload: codexPayload({
        session_id: CODEX_SESSION,
        thread_id: CODEX_THREAD,
        request_kind: "compaction",
      }) as Record<string, unknown>,
    });

    expect(compaction.statusCode, compaction.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );
  });

  test("an out-of-band compaction whose history carries no trajectory stamp binds its own root and still restores notices", async () => {
    // A notice's session field is unsigned lineage evidence: a summarizer
    // that compresses thread A's denied history under a new thread id, with
    // no stamp the proxy signed for this caller, must not attach to A's root
    // on that claim alone. It still restores the notices, so the provider
    // sees the original call and the ruling, never the envelope.
    const noticeArguments = buildNoticeArguments({
      id: "call_1",
      tool: "shell",
      arguments: { command: "rm -rf build" },
      result: "[appa] Blocked: this call cannot run yet.",
    });
    const payload = {
      ...codexPayload({
        session_id: CODEX_RESUMED_SESSION,
        thread_id: CODEX_FORK_THREAD,
        request_kind: "compaction",
      }),
      input: [
        { role: "user", content: "clean the build dir" },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "archestra__get_remedy_plans",
          status: "completed",
          arguments: JSON.stringify({
            ...noticeArguments,
            notice: { ...noticeArguments.notice, session: CODEX_THREAD },
          }),
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "client text",
        },
      ],
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...codexHeaders(), "x-openai-subagent": "compact" },
      payload: payload as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_FORK_THREAD}`,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );
    const sent = JSON.stringify(providerBodies);
    expect(sent).toContain('"name":"shell"');
    expect(sent).toContain("APPROVED REPLACEMENT");
    expect(sent).not.toContain("client text");
    expect(sent).not.toContain("archestra__get_remedy_plans");
  });

  test.each([
    true,
    false,
  ])("a Codex summarizer under a new thread opens as a fork of the thread its stamped history came from (stream=%s)", async (stream) => {
    config.openappa = {
      ...config.openappa,
      offerSigningSecret: "test-offer-signing-secret-32chars",
    };
    const call = {
      type: "function_call",
      id: "fc_weather",
      call_id: "call_weather",
      name: "get_weather",
      arguments: '{"location":"SF"}',
      status: "completed",
    };
    const completed = {
      id: "resp_weather",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.5",
      output: [call],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: { stream?: boolean }) => {
              providerBodies.push(structuredClone(params));
              if (!params.stream) return completed;
              return {
                async *[Symbol.asyncIterator]() {
                  yield {
                    type: "response.output_item.added",
                    sequence_number: 1,
                    output_index: 0,
                    item: { ...call, arguments: "", status: "in_progress" },
                  };
                  yield {
                    type: "response.function_call_arguments.delta",
                    sequence_number: 2,
                    output_index: 0,
                    item_id: call.id,
                    delta: call.arguments,
                  };
                  yield {
                    type: "response.output_item.done",
                    sequence_number: 3,
                    output_index: 0,
                    item: call,
                  };
                  yield {
                    type: "response.completed",
                    sequence_number: 4,
                    response: completed,
                  };
                },
              };
            },
          },
        }) as never,
    );

    const first = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: {
        ...codexPayload({ session_id: CODEX_SESSION, thread_id: CODEX_THREAD }),
        stream,
      } as Record<string, unknown>,
    });
    expect(first.statusCode, first.body).toBe(200);
    // What Codex keeps: the final output item, streamed or returned whole.
    const given: { call_id: string } = stream
      ? first.body
          .split("\n")
          .filter(
            (line) => line.startsWith("data: ") && line !== "data: [DONE]",
          )
          .map((line) => JSON.parse(line.slice("data: ".length)))
          .findLast(
            (event) =>
              event.type === "response.output_item.done" &&
              event.item?.type === "function_call",
          ).item
      : first.json().output[0];
    expect(parseTrajectoryStamp(given.call_id)).toMatchObject({
      sessionId: CODEX_THREAD,
      callId: "call_weather",
    });
    // The log keeps the provider's id, which the history the next request
    // logs answers the call by.
    const logged = await latestLoggedResponse(agent.id);
    expect(logged).toContain('"call_id":"call_weather"');
    expect(logged).not.toContain(given.call_id);
    if (stream) {
      // A client that keeps the last completed envelope holds the same id.
      const envelope = first.body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice("data: ".length)))
        .findLast((event) => event.type === "response.completed");
      expect(envelope.response.output).toContainEqual(
        expect.objectContaining({ call_id: given.call_id }),
      );
    }

    events.length = 0;
    providerBodies.length = 0;
    const compaction = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: {
        ...codexPayload({
          session_id: CODEX_RESUMED_SESSION,
          thread_id: CODEX_FORK_THREAD,
        }),
        stream: false,
        input: [
          { role: "user", content: "Check the weather" },
          { ...call, call_id: given.call_id },
          {
            type: "function_call_output",
            call_id: given.call_id,
            output: "Sunny",
          },
          { role: "user", content: "Summarize this conversation." },
        ],
      } as Record<string, unknown>,
    });

    expect(compaction.statusCode, compaction.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: `user:${userId}|${CODEX_FORK_THREAD}`,
        fork_of: `user:${userId}|${CODEX_THREAD}`,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );
    const sent = JSON.stringify(providerBodies);
    expect(sent).toContain('"call_id":"call_weather"');
    expect(sent).not.toContain(given.call_id);
  });

  test("contradictory Codex trajectory metadata is refused before the provider", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...codexHeaders(),
        "x-codex-turn-metadata": JSON.stringify({
          session_id: CODEX_SESSION,
          thread_id: CODEX_FORK_THREAD,
        }),
      },
      payload: codexPayload({
        session_id: CODEX_SESSION,
        thread_id: CODEX_THREAD,
      }) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("contradictory Codex trajectory metadata");
    expect(events).toHaveLength(0);
    expect(providerCalls).toBe(0);
  });

  test("refuses an invalid Codex thread ID before deriving a fallback root", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: codexPayload({
        session_id: CODEX_SESSION,
        thread_id: "x".repeat(513),
      }) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("valid client-native session ID");
    expect(events).toHaveLength(0);
    expect(providerCalls).toBe(0);
  });

  test("an OpenCode resume reopens the session's root; a fork opens a fresh one", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...openCodeHeaders(),
        "x-session-id": OPENCODE_SESSION,
        "x-session-affinity": OPENCODE_SESSION,
      },
      payload: openCodePayload() as Record<string, unknown>,
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${OPENCODE_SESSION}`,
      }),
    );

    events.length = 0;
    const forked = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...openCodeHeaders(),
        "x-session-id": OPENCODE_FORK_SESSION,
      },
      payload: openCodePayload() as Record<string, unknown>,
    });
    expect(forked.statusCode, forked.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${OPENCODE_FORK_SESSION}`,
      }),
    );
  });

  test("contradictory OpenCode session headers are refused before the provider", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...openCodeHeaders(),
        "x-session-id": OPENCODE_SESSION,
        "x-session-affinity": OPENCODE_FORK_SESSION,
      },
      payload: openCodePayload() as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("contradictory OpenCode session headers");
    expect(events).toHaveLength(0);
  });

  test("a bare affinity header leaves a generic client on its fallback root", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-user-id": userId,
        "x-session-affinity": OPENCODE_SESSION,
      },
      payload: openCodePayload() as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}@${agent.id}`,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        session_id: `user:${userId}|${OPENCODE_SESSION}`,
      }),
    );
  });

  test("Codex compaction stays on the thread and a new thread opens a fresh root with no parent id", async () => {
    const compact = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...codexHeaders(), "x-openai-subagent": "compact" },
      payload: codexPayload({
        session_id: CODEX_SESSION,
        thread_id: CODEX_THREAD,
        request_kind: "compaction",
      }) as Record<string, unknown>,
    });
    expect(compact.statusCode, compact.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: expect.stringContaining(CODEX_THREAD),
      }),
    );
    events.length = 0;
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: codexHeaders(),
      payload: codexPayload({
        session_id: CODEX_RESUMED_SESSION,
        thread_id: CODEX_FORK_THREAD,
        forked_from_thread_id: CODEX_THREAD,
      }) as Record<string, unknown>,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: expect.stringContaining(CODEX_FORK_THREAD),
      }),
    );
    const starts = events.filter((event) => event.event === "session_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].parent_id).toBeUndefined();
  });

  test("OpenCode compaction stays on the session and a new session opens a fresh root with no parent id", async () => {
    const compact = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...openCodeHeaders(),
        "x-session-id": OPENCODE_SESSION,
      },
      payload: {
        ...openCodePayload(),
        messages: [
          {
            role: "user",
            content: "[Old tool result content cleared]",
          },
        ],
      } as Record<string, unknown>,
    });
    expect(compact.statusCode, compact.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: expect.stringContaining(OPENCODE_SESSION),
      }),
    );
    events.length = 0;
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...openCodeHeaders(),
        "x-session-id": OPENCODE_FORK_SESSION,
        "x-parent-session-id": OPENCODE_SESSION,
      },
      payload: openCodePayload() as Record<string, unknown>,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        session_id: expect.stringContaining(OPENCODE_FORK_SESSION),
      }),
    );
    const starts = events.filter((event) => event.event === "session_start");
    expect(starts).toHaveLength(1);
    expect(starts[0].parent_id).toBeUndefined();
  });
});

/** The response the interaction log recorded for the profile's latest turn. */
async function latestLoggedResponse(profileId: string): Promise<string> {
  // A streamed turn is logged once the client's response has ended.
  return await vi.waitFor(async () => {
    const latest = (
      await InteractionModel.getAllInteractionsForProfile(profileId)
    ).at(-1);
    if (!latest) throw new Error("nothing logged yet");
    return JSON.stringify(latest.response);
  });
}
