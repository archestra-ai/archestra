import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse } from "msw";
import OpenAIProvider from "openai";
import { vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import db, * as database from "@/database";
import { InteractionModel, ModelModel, OpenAppaSessionModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import { openappaActor } from "@/openappa/actor";
import { buildNoticeArguments } from "@/openappa/notice";
import * as appaService from "@/openappa/service";
import { appendSessionReceipt } from "@/openappa/session-token";
import { parseTrajectoryStamp } from "@/openappa/trajectory-stamp";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { rewriteConnectionProxySetupUrl } from "@/services/connection-proxy-setup-context";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { native } from "@/test/openappa-native-mock";
import { latestLoggedResponse } from "@/test/openappa-proxy-harness";
import { type Agent, ApiError } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import { createOpenAiCodexClient } from "./adapters/openai-codex-client";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import openAiProxyRoutes from "./routes/openai";

vi.mock(
  "@archestra/openappa-rs",
  async () => (await import("@/test/openappa-native-mock")).native,
);
vi.mock("@/cache-manager");

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
  let platformCredential: string;
  let events: Array<Record<string, unknown>>;
  let providerCalls: number;
  let providerBodies: unknown[];
  let unregisterAppaPlugin: () => void;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    config.openappa = parseOpenAppaConfig();
    await GuardrailsDeploymentModel.setEnabled(true);
    config.llmProxy.plugins = parseLlmProxyPlugins(undefined);
    unregisterAppaPlugin = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    app = Fastify({
      rewriteUrl: rewriteConnectionProxySetupUrl,
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
    await app.register(openAiProxyRoutes);
    agent = await makeAgent({ name: "Native proxy OpenAI test" });
    userId = (await makeUser()).id;
    await makeMember(userId, agent.organizationId);
    platformCredential = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: userId,
    });
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
            parentId:
              typeof event.parent_id === "string" ? event.parent_id : null,
            forkedFrom:
              typeof event.fork_of === "string" ? event.fork_of : null,
            startDecision: { decision: "ack" },
          })
          .onConflictDoNothing();
      }
      if (event.event === "tool_call")
        return JSON.stringify({
          decision: "allow_call",
          ...(event.spawn ? { spawn_binding: "prepared-fork" } : {}),
        });
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
    "x-archestra-virtual-key": platformCredential,
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
    "x-archestra-virtual-key": platformCredential,
    "x-archestra-user-id": userId,
    "user-agent": "opencode/1.18.29",
  });

  test.each(
    ["opencode", "kilo"].flatMap((client) =>
      [false, true].map((multiple) => ({ client, multiple })),
    ),
  )("returns ordinary gateway question answers through the $client native form (multiple=$multiple)", async ({
    client,
    multiple,
  }) => {
    const labels = Array.from(
      { length: multiple ? 12 : 2 },
      (_, i) => `Format ${i + 1}`,
    );
    const questionText = "Which report format?";
    let calls = [
      {
        id: "call_format",
        name: "archestra__ask_user",
        arguments: JSON.stringify({
          question: questionText,
          options: labels.map((label) => ({ label })),
          allowMultiple: multiple,
        }),
      },
    ];
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const provider = createOpenAiTestClient({ nonStreamingToolCalls: calls });
      const create = provider.chat.completions.create;
      provider.chat.completions.create = async (params) => {
        providerBodies.push(structuredClone(params));
        return create(params);
      };
      return provider as never;
    });
    const body = openCodePayload();
    const tools = [
      ...body.tools,
      ...["archestra__ask_user", "question"].map((name) => ({
        type: "function",
        function: {
          name,
          description: name,
          parameters: { type: "object", properties: {} },
        },
      })),
    ];
    const headers = {
      ...internalCallHeader(),
      ...openCodeHeaders(),
      "user-agent": `${client}/1.18.29`,
      "x-session-id": OPENCODE_SESSION,
    };
    const messages = [{ role: "user", content: "Choose a report format." }];
    const asked = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers,
      payload: { ...body, stream: false, tools, messages },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const question = asked.json().choices[0].message.tool_calls[0];
    expect(question.function.name).toBe("question");
    expect(JSON.parse(question.function.arguments)).toEqual({
      questions: [
        {
          question: questionText,
          header: expect.any(String),
          options: labels.map((label) => ({ label, description: label })),
          multiple,
        },
      ],
    });
    const selected = multiple ? [labels[0], labels.at(-1)] : [labels.at(-1)];
    const answer = `User has answered your questions: "${questionText}"="${selected.join(", ")}". You can now continue with the user's answers in mind.`;
    calls = [];
    providerBodies.length = 0;
    const answered = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers,
      payload: {
        ...body,
        stream: false,
        tools,
        messages: [
          ...messages,
          { role: "assistant", content: null, tool_calls: [question] },
          { role: "tool", tool_call_id: question.id, content: answer },
        ],
      },
    });
    expect(answered.statusCode, answered.body).toBe(200);
    const sent = providerBodies.at(-1) as {
      messages: Array<{
        role: string;
        tool_call_id?: string;
        content: unknown;
      }>;
    };
    expect(
      sent.messages.find(
        (message) =>
          message.role === "tool" && message.tool_call_id === question.id,
      ),
    ).toMatchObject({ content: answer });
  });

  test.for(
    ["incomplete", "content_filter", "failed", "eof"].flatMap((terminal) =>
      [false, true].flatMap((stream) =>
        [false, true].map((child) => ({ terminal, stream, child })),
      ),
    ),
  )("fails the real subscription Chat client without ending the governed turn (terminal=$terminal, stream=$stream, child=$child)", async ({
    terminal,
    stream,
    child,
  }) => {
    const success = vi.fn(async () => undefined);
    const error = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const unregister = registerLlmProxyPlugin({
      id: "test-subscription-terminal",
      onPrepareToolCalls: success,
      onToolCalls: success,
      buffersModelResponse: () => child,
      onBufferedModelResponse: success,
      onModelResponse: success,
      onComplete: success,
      onError: error,
      onCleanup: cleanup,
    });
    let upstreamCalls = 0;
    const usage = {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
      total_tokens: 17,
    };
    const incomplete =
      terminal === "incomplete" || terminal === "content_filter";
    const nativeEvents = [
      {
        type: "response.created",
        response: {
          id: "resp_subscription_partial",
          status: "in_progress",
          output: [],
          usage,
        },
      },
      {
        type: "response.output_text.delta",
        delta: "Partial subscription answer",
      },
      {
        type: "response.output_item.added",
        item: {
          id: "fc_subscription_partial",
          type: "function_call",
          call_id: "call_subscription_partial",
          name: "get_weather",
          arguments: '{"location":',
        },
      },
      ...(terminal === "eof"
        ? []
        : [
            {
              type: incomplete ? "response.incomplete" : "response.failed",
              response: {
                id: "resp_subscription_partial",
                status: incomplete ? "incomplete" : "failed",
                output: [],
                incomplete_details: incomplete
                  ? {
                      reason:
                        terminal === "content_filter"
                          ? "content_filter"
                          : "max_messages",
                    }
                  : null,
                error: incomplete
                  ? null
                  : { code: "server_error", message: "Provider failed" },
                usage,
              },
            },
          ]),
    ];
    const respond = async (request: Request) => {
      expect(new URL(request.url).pathname).toMatch(/\/responses$/);
      upstreamCalls += 1;
      const body = (await request.json()) as {
        stream: boolean;
        input: unknown[];
      };
      expect(body.stream).toBe(true);
      return new HttpResponse(
        nativeEvents
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    };
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      (_key, options) =>
        createOpenAiCodexClient({
          options,
          innerFetch: async (input, init) => respond(new Request(input, init)),
          credential: {
            refreshToken: "test-refresh-token",
            accountId: "test-account",
            accessToken: "test-access-token",
            accessTokenExpiresAtMs: Date.now() + 60 * 60 * 1000,
          },
        }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        remoteAddress: "127.0.0.1",
        headers: {
          ...internalCallHeader(),
          ...openCodeHeaders(),
          "x-session-id": "subscription-parent",
          ...(child ? { "x-opencode-session": "subscription-child" } : {}),
        },
        payload: { ...openCodePayload(), stream },
      });
      expect(upstreamCalls, response.body).toBe(1);
      expect(response.statusCode, response.body).toBe(
        incomplete || stream ? 200 : 502,
      );
      expect(response.body).not.toContain("call_subscription_partial");
      expect(response.body).not.toContain("finished subagent");
      if (child)
        expect(response.body).not.toContain("Partial subscription answer");
      const frames =
        stream && response.statusCode === 200
          ? response.body
              .split("\n")
              .filter(
                (line) => line.startsWith("data: ") && line !== "data: [DONE]",
              )
              .map((line) => JSON.parse(line.slice(6)))
          : [];
      if (incomplete) {
        const reason =
          terminal === "content_filter" ? "content_filter" : "length";
        if (stream) {
          expect(
            frames.filter(
              (frame) => frame.choices?.[0]?.finish_reason === reason,
            ),
          ).toHaveLength(1);
          expect(frames.some((frame) => frame.error)).toBe(false);
          if (!child) {
            expect(
              frames
                .map((frame) => frame.choices?.[0]?.delta?.content ?? "")
                .join(""),
            ).toContain("Partial subscription answer");
          }
        } else {
          expect(response.json().choices[0]).toMatchObject({
            message: { content: child ? "" : "Partial subscription answer" },
            finish_reason: reason,
          });
        }
      } else if (frames.length > 0) {
        expect(frames.filter((frame) => frame.error)).toHaveLength(1);
        expect(frames.some((frame) => frame.choices?.[0]?.finish_reason)).toBe(
          false,
        );
      }
      expect(success).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(
        events.some((event) =>
          ["tool_call", "child_end", "turn_end"].includes(String(event.event)),
        ),
      ).toBe(false);
      expect(
        Boolean(
          events.find((event) => event.event === "session_start")?.parent_id,
        ),
      ).toBe(child);
      const records = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        inputTokens: 7,
        outputTokens: 7,
        cacheReadTokens: 3,
      });
      expect(records[0].response).toMatchObject({
        object: "chat.completion",
        provider_response_id: "resp_subscription_partial",
        status: terminal === "failed" ? "failed" : "incomplete",
        choices: [
          {
            message: { content: "Partial subscription answer" },
            finish_reason: incomplete
              ? terminal === "content_filter"
                ? "content_filter"
                : "length"
              : "error",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 7 },
      });
      if (terminal === "eof")
        expect(records[0].response).toMatchObject({
          incomplete_details: null,
          error: { code: "proxy_stream_incomplete" },
        });
    } finally {
      unregister();
    }
  });

  test.for(
    (["incomplete", "failed"] as const).flatMap((status) =>
      [false, true].flatMap((stream) =>
        [false, true].map((child) => ({ status, stream, child })),
      ),
    ),
  )("keeps a Responses $status generation failed (stream=$stream, child=$child)", async ({
    status,
    stream,
    child,
  }, { makeUser, makeMember }) => {
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "tool_call" && event.tool === "web_search") {
        events.push(event);
        return JSON.stringify({
          decision: "deny_call",
          feedback: "Search results are not admitted",
          offers: [],
          review: [],
        });
      }
      return dispatch?.(raw);
    });
    const prepareCalls = vi.fn(async () => undefined);
    const toolCalls = vi.fn(async () => undefined);
    const hostedCalls = vi.fn(async () => undefined);
    const bufferedResponse = vi.fn(async () => undefined);
    const modelResponse = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const error = vi.fn(async () => {
      if (status === "failed" && stream && !child) {
        throw new Error("Error hook failed");
      }
    });
    const unregister = registerLlmProxyPlugin({
      id: "test-terminal-failure",
      onPrepareToolCalls: prepareCalls,
      onToolCalls: toolCalls,
      onHostedToolCalls: hostedCalls,
      buffersModelResponse: () => child,
      onBufferedModelResponse: bufferedResponse,
      onModelResponse: modelResponse,
      onComplete: complete,
      onError: error,
      onCleanup: cleanup,
    });
    const reasoning = {
      id: "rs_partial",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "PARTIAL_REASONING_MARKER" }],
    };
    const message = {
      id: "msg_partial",
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [
        { type: "output_text", text: "Partial answer", annotations: [] },
      ],
    };
    const search = {
      id: "ws_partial",
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "UNADMITTED_RAW_SEARCH_MARKER" },
    };
    const dependentMessage = {
      ...message,
      id: "msg_after_search",
      content: [
        {
          type: "output_text",
          text: "UNADMITTED_SEARCH_DERIVED_MARKER",
          annotations: [],
        },
      ],
    };
    const call = {
      id: "fc_partial",
      type: "function_call",
      call_id: "call_partial",
      name: "exec_command",
      arguments: '{"cmd":',
      status: "incomplete",
    };
    const custom = {
      id: "ct_partial",
      type: "custom_tool_call",
      call_id: "custom_partial",
      name: "apply_patch",
      input: "*** Begin Patch",
      status: "incomplete",
    };
    const terminal = {
      id: "resp_failure",
      object: "response",
      created_at: 123,
      model: "gpt-5.5",
      status,
      // Streamed items must survive even when the final envelope omits them.
      output: stream
        ? []
        : [reasoning, message, search, dependentMessage, call, custom],
      incomplete_details:
        status === "incomplete" ? { reason: "max_messages" } : null,
      error:
        status === "failed"
          ? { code: "server_error", message: "Provider failed" }
          : null,
      usage:
        status === "failed"
          ? null
          : {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 3 },
              output_tokens: 7,
              output_tokens_details: { reasoning_tokens: 5 },
              total_tokens: 17,
            },
    };
    const respond = () => {
      if (!stream) return HttpResponse.json(terminal);
      const nativeEvents: unknown[] = [
        {
          type: "response.created",
          sequence_number: 0,
          response: { ...terminal, status: "in_progress", output: [] },
        },
      ];
      let sequence = 1;
      for (const [output_index, item] of [
        reasoning,
        message,
        search,
        dependentMessage,
        call,
        custom,
      ].entries()) {
        nativeEvents.push({
          type: "response.output_item.added",
          sequence_number: sequence++,
          output_index,
          item,
        });
        if (item === message || item === dependentMessage)
          nativeEvents.push({
            type: "response.output_text.delta",
            sequence_number: sequence++,
            output_index,
            content_index: 0,
            item_id: item.id,
            delta: item.content[0].text,
          });
        nativeEvents.push({
          type: "response.output_item.done",
          sequence_number: sequence++,
          output_index,
          item,
        });
      }
      nativeEvents.push({
        type: `response.${status}`,
        sequence_number: sequence++,
        response: terminal,
      });
      return new HttpResponse(
        nativeEvents
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        new OpenAIProvider({
          apiKey: "test-key",
          baseURL: "https://native-responses.test/v1",
          maxRetries: 0,
          fetch: async (input) => {
            expect(
              new URL(input instanceof Request ? input.url : String(input))
                .pathname,
            ).toBe("/v1/responses");
            return respond();
          },
        }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/responses`,
        remoteAddress: "127.0.0.1",
        headers: { ...internalCallHeader(), ...codexHeaders() },
        payload: {
          ...codexPayload({
            session_id: CODEX_SESSION,
            thread_id: child ? CODEX_FORK_THREAD : CODEX_THREAD,
            ...(child ? { parent_thread_id: CODEX_THREAD } : {}),
          }),
          stream,
          tools: [
            ...codexPayload({}).tools,
            { type: "custom", name: "apply_patch" },
            { type: "web_search" },
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      const frames = stream
        ? response.body
            .split("\n")
            .filter(
              (line) => line.startsWith("data: ") && line !== "data: [DONE]",
            )
            .map((line) => JSON.parse(line.slice("data: ".length)))
        : [];
      if (stream) {
        expect(
          frames.filter((frame) => frame.type === `response.${status}`),
        ).toHaveLength(1);
        expect(
          frames.some((frame) => frame.type === "response.completed"),
        ).toBe(false);
        expect(frames.some((frame) => frame.type === "error")).toBe(false);
        expect(
          frames.some(
            (frame) =>
              frame.item?.type === "function_call" ||
              frame.item?.type === "custom_tool_call" ||
              frame.type === "response.function_call_arguments.delta" ||
              frame.type === "response.custom_tool_call_input.delta",
          ),
        ).toBe(false);
        // The failed terminal ends the stream, as OpenAI's does: no `[DONE]`.
        expect(frames.at(-1)?.type).toBe(`response.${status}`);
        expect(response.body).not.toContain("[DONE]");
      }
      const released = stream
        ? frames.find((frame) => frame.type === `response.${status}`).response
        : response.json();
      const start = events.find((event) => event.event === "session_start");
      expect(start).toBeDefined();
      expect(Boolean(start?.parent_id)).toBe(child);
      let releasedMessage = message;
      if (stream && !child) {
        const session = await OpenAppaSessionModel.find({
          organizationId: agent.organizationId,
          sessionId: String(start?.session_id),
        });
        expect(session?.receiptToken).toBeTruthy();
        if (session?.receiptToken) {
          releasedMessage = {
            ...message,
            content: [
              {
                ...message.content[0],
                text: appendSessionReceipt(
                  message.content[0].text,
                  session.receiptToken,
                ),
              },
            ],
          };
        }
      }
      const persisted = {
        ...terminal,
        output: stream ? [reasoning, releasedMessage] : [],
      };
      // A buffered child's failed generation was never admitted, so its text
      // stays off the wire while the provider's partial is still recorded.
      const withheld = stream && child;
      expect(released).toMatchObject(
        withheld ? { ...persisted, output: [] } : persisted,
      );
      if (child) {
        expect(response.body).not.toContain("Partial answer");
        expect(response.body).not.toContain("PARTIAL_REASONING_MARKER");
      }
      expect(response.body).not.toContain("UNADMITTED_RAW_SEARCH_MARKER");
      expect(response.body).not.toContain("UNADMITTED_SEARCH_DERIVED_MARKER");
      expect(response.body).not.toContain("finished subagent");
      expect(error).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      for (const hook of [
        prepareCalls,
        toolCalls,
        hostedCalls,
        bufferedResponse,
        modelResponse,
        complete,
      ]) {
        expect(hook).not.toHaveBeenCalled();
      }
      expect(
        events.filter((event) =>
          ["tool_call", "child_end", "turn_end"].includes(String(event.event)),
        ),
      ).toEqual([]);
      const findInteractions = async () =>
        (
          await InteractionModel.findAllPaginated(
            { limit: 10, offset: 0 },
            undefined,
            undefined,
            undefined,
            { organizationId: agent.organizationId, profileId: agent.id },
          )
        ).data;
      await expect.poll(findInteractions).toHaveLength(1);
      const recorded = await findInteractions();
      expect(recorded).toHaveLength(1);
      if (withheld) expect(recorded[0].response).toMatchObject(persisted);
      else expect(recorded[0].response).toEqual(released);
      expect(JSON.stringify(recorded[0].response)).not.toContain("UNADMITTED_");
      expect(recorded[0].processedRequest).not.toBeNull();
      if (status === "incomplete") {
        expect(recorded[0]).toMatchObject({
          inputTokens: 7,
          outputTokens: 7,
          cacheReadTokens: 3,
        });
      }

      // Real API readback must retain the native envelope, including null usage.
      const reader = await makeUser();
      await makeMember(reader.id, agent.organizationId, { role: "admin" });
      const { createFastifyInstance } = await import("@/fastify-instance");
      const readApp = createFastifyInstance();
      readApp.addHook("onRequest", async (request) => {
        request.user = reader;
        request.organizationId = agent.organizationId;
      });
      const { default: interactionRoutes } = await import("../interaction");
      await readApp.register(interactionRoutes);
      try {
        const detail = await readApp.inject({
          method: "GET",
          url: `/api/interactions/${recorded[0].id}`,
          headers: internalCallHeader(),
        });
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json().response).toEqual(recorded[0].response);
        const list = await readApp.inject({
          method: "GET",
          url: `/api/interactions?profileId=${agent.id}`,
          headers: internalCallHeader(),
        });
        expect(list.statusCode, list.body).toBe(200);
        expect(list.json().data[0].response).toEqual(recorded[0].response);
      } finally {
        await readApp.close();
      }
      // The native policy boundary would hold this call on a completed turn;
      // failure must discard it without fabricating or invoking that verdict.
      const verdicts = await appaService.evaluateHostedToolCalls(
        {
          organization_id: agent.organizationId,
          session_id: String(start?.session_id),
          caller_id: `user:${userId}`,
          ...(start?.parent_id ? { parent_id: String(start.parent_id) } : {}),
        },
        [
          {
            id: search.id,
            name: "web_search",
            arguments: search.action,
            output: JSON.stringify([search, dependentMessage]),
          },
        ],
        { canonicalize: (name) => name },
      );
      expect(verdicts).toEqual([
        {
          kind: "hold",
          feedback: expect.stringContaining("Search results are not admitted"),
        },
      ]);
    } finally {
      unregister();
    }
  });

  test.for(
    (["incomplete", "failed"] as const).flatMap((status) =>
      [false, true].map((child) => ({ status, child })),
    ),
  )("withholds a buffered child's failed non-stream Responses text (status=$status, child=$child)", async ({
    status,
    child,
  }) => {
    const unadmitted = vi.fn(async () => undefined);
    const error = vi.fn(async () => undefined);
    const cleanup = vi.fn(async () => undefined);
    const unregister = registerLlmProxyPlugin({
      id: "test-non-stream-terminal-text",
      buffersModelResponse: () => child,
      onBufferedModelResponse: unadmitted,
      onModelResponse: unadmitted,
      onComplete: unadmitted,
      onError: error,
      onCleanup: cleanup,
    });
    const reasoning = {
      id: "rs_text_only",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "PARTIAL_REASONING_MARKER" }],
    };
    const message = {
      id: "msg_text_only",
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [
        {
          type: "output_text",
          text: "PARTIAL_TEXT_ONLY_MARKER",
          annotations: [],
        },
      ],
    };
    const usage = {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 17,
    };
    const terminal = {
      id: "resp_text_only",
      object: "response",
      created_at: 123,
      model: "gpt-5.5",
      status,
      output: [reasoning, message],
      incomplete_details:
        status === "incomplete" ? { reason: "max_output_tokens" } : null,
      error:
        status === "failed"
          ? { code: "server_error", message: "Provider failed" }
          : null,
      usage,
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        new OpenAIProvider({
          apiKey: "test-key",
          baseURL: "https://native-responses.test/v1",
          maxRetries: 0,
          fetch: async () => HttpResponse.json(terminal),
        }),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/responses`,
        remoteAddress: "127.0.0.1",
        headers: { ...internalCallHeader(), ...codexHeaders() },
        payload: {
          ...codexPayload({
            session_id: CODEX_SESSION,
            thread_id: child ? CODEX_FORK_THREAD : CODEX_THREAD,
            ...(child ? { parent_thread_id: CODEX_THREAD } : {}),
          }),
          stream: false,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        ...terminal,
        output: child ? [] : [reasoning, message],
      });
      if (child) {
        expect(response.body).not.toContain("PARTIAL_TEXT_ONLY_MARKER");
        expect(response.body).not.toContain("PARTIAL_REASONING_MARKER");
      }
      expect(error).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(unadmitted).not.toHaveBeenCalled();
      expect(
        events.filter((event) =>
          ["child_end", "turn_end"].includes(String(event.event)),
        ),
      ).toEqual([]);
      const recorded = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0].response).toMatchObject({
        ...terminal,
        output: [reasoning, message],
      });
      expect(recorded[0]).toMatchObject({
        inputTokens: 7,
        outputTokens: 7,
        cacheReadTokens: 3,
      });
    } finally {
      unregister();
    }
  });

  test.for(
    [false, true].flatMap((partial) =>
      [false, true].map((child) => ({ partial, child })),
    ),
  )("fails a Responses clean EOF before ending a governed turn (partial=$partial, child=$child)", async ({
    partial,
    child,
  }, { makeUser, makeMember }) => {
    const successfulResponse = vi.fn(async () => undefined);
    const prepareCalls = vi.fn(async () => undefined);
    const toolCalls = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const error = vi.fn(async () => {
      if (partial && !child) throw new Error("EOF error hook failed");
    });
    const cleanup = vi.fn(async () => undefined);
    const unregister = registerLlmProxyPlugin({
      id: "test-clean-eof",
      onPrepareToolCalls: prepareCalls,
      onToolCalls: toolCalls,
      buffersModelResponse: () => child,
      onBufferedModelResponse: successfulResponse,
      onModelResponse: successfulResponse,
      onComplete: complete,
      onError: error,
      onCleanup: cleanup,
    });
    const reasoning = { id: "rs_eof", type: "reasoning", summary: [] };
    const message = {
      id: "msg_eof",
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [
        { type: "output_text", text: "Partial answer", annotations: [] },
      ],
    };
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        if (!partial) return;
        yield {
          type: "response.created",
          sequence_number: 0,
          response: {
            id: "resp_eof",
            object: "response",
            created_at: 123,
            model: "gpt-5.5",
            status: "in_progress",
            output: [],
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          },
        };
        yield {
          type: "response.output_item.done",
          sequence_number: 1,
          output_index: 0,
          item: reasoning,
        };
        yield {
          type: "response.output_text.delta",
          sequence_number: 2,
          output_index: 1,
          content_index: 0,
          item_id: message.id,
          delta: "Partial answer",
        };
        yield {
          type: "response.output_item.done",
          sequence_number: 3,
          output_index: 1,
          item: message,
        };
        yield {
          type: "response.output_item.added",
          sequence_number: 4,
          output_index: 2,
          item: {
            id: "fc_eof",
            type: "function_call",
            call_id: "call_eof",
            name: "exec_command",
            arguments: '{"cmd":',
            status: "in_progress",
          },
        };
        yield {
          type: "response.output_item.added",
          sequence_number: 5,
          output_index: 3,
          item: {
            id: "ct_eof",
            type: "custom_tool_call",
            call_id: "custom_eof",
            name: "apply_patch",
            input: "*** Begin Patch",
            status: "in_progress",
          },
        };
      },
    }));
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockReturnValue({
      responses: { create },
    } as never);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/responses`,
        remoteAddress: "127.0.0.1",
        headers: { ...internalCallHeader(), ...codexHeaders() },
        payload: {
          ...codexPayload({
            session_id: CODEX_SESSION,
            thread_id: child ? CODEX_FORK_THREAD : CODEX_THREAD,
            ...(child ? { parent_thread_id: CODEX_THREAD } : {}),
          }),
          stream: true,
        },
      });
      expect(response.statusCode, response.body).toBe(partial ? 200 : 502);
      const frames = response.body
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice("data: ".length)));
      const failures = frames.filter((frame) => frame.type === "error");
      if (partial) {
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          sequence_number: expect.any(Number),
          error: { code: "proxy_stream_incomplete" },
        });
        expect(failures[0].error.message).toContain("without a terminal event");
      } else {
        expect(failures).toHaveLength(0);
        expect(response.json().error.message).toContain(
          "without a terminal event",
        );
      }
      expect(frames.some((frame) => frame.type === "response.completed")).toBe(
        false,
      );
      expect(frames.some((frame) => frame.type === "response.incomplete")).toBe(
        false,
      );
      expect(
        frames.some(
          (frame) =>
            frame.item?.type === "function_call" ||
            frame.item?.type === "custom_tool_call",
        ),
      ).toBe(false);
      expect(response.body).not.toContain("finished subagent");
      expect(create).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      for (const hook of [
        prepareCalls,
        toolCalls,
        successfulResponse,
        complete,
      ]) {
        expect(hook).not.toHaveBeenCalled();
      }
      expect(
        events.filter((event) =>
          ["tool_call", "child_end", "turn_end"].includes(String(event.event)),
        ),
      ).toEqual([]);
      expect(
        Boolean(
          events.find((event) => event.event === "session_start")?.parent_id,
        ),
      ).toBe(child);
      const findInteractions = async () =>
        (
          await InteractionModel.findAllPaginated(
            { limit: 10, offset: 0 },
            undefined,
            undefined,
            undefined,
            { organizationId: agent.organizationId, profileId: agent.id },
          )
        ).data;
      await expect.poll(findInteractions).toHaveLength(1);
      const recorded = await findInteractions();
      expect(recorded[0].response).toMatchObject({
        object: "response",
        model: "gpt-5.5",
        status: "incomplete",
        incomplete_details: null,
        error: {
          code: "proxy_stream_incomplete",
          message: expect.stringContaining("without a terminal event"),
        },
        output: partial
          ? [
              reasoning,
              expect.objectContaining({
                id: message.id,
                type: "message",
                content: [
                  expect.objectContaining({
                    text: expect.stringContaining("Partial answer"),
                  }),
                ],
              }),
            ]
          : [],
      });
      if (partial) {
        expect(recorded[0].response).toMatchObject({
          id: "resp_eof",
          model: "gpt-5.5",
          created_at: 123,
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        });
        expect(recorded[0]).toMatchObject({ inputTokens: 3, outputTokens: 2 });
      }
      // The recorded failure is built from an inert field subset only: no
      // executable-capable field from the observed stream (tool calls,
      // function_call items) survives into interaction history.
      const persisted = JSON.stringify(recorded[0].response);
      expect(persisted).not.toContain("call_eof");
      expect(persisted).not.toContain("custom_eof");
      expect(persisted).not.toContain("apply_patch");
      expect(
        Object.keys(recorded[0].response as Record<string, unknown>).sort(),
      ).toEqual(
        [
          "created_at",
          "error",
          "id",
          "incomplete_details",
          "model",
          "object",
          "output",
          "status",
          "usage",
        ].sort(),
      );
      const reader = await makeUser();
      await makeMember(reader.id, agent.organizationId, { role: "admin" });
      const { createFastifyInstance } = await import("@/fastify-instance");
      const readApp = createFastifyInstance();
      readApp.addHook("onRequest", async (request) => {
        request.user = reader;
        request.organizationId = agent.organizationId;
      });
      const { default: interactionRoutes } = await import("../interaction");
      await readApp.register(interactionRoutes);
      try {
        const detail = await readApp.inject({
          method: "GET",
          url: `/api/interactions/${recorded[0].id}`,
          headers: internalCallHeader(),
        });
        expect(detail.statusCode, detail.body).toBe(200);
        expect(detail.json().response).toEqual(recorded[0].response);
      } finally {
        await readApp.close();
      }
    } finally {
      unregister();
    }
  });

  test.each([
    ["allowed", false],
    ["blocked", true],
  ])("serves a proxy-only OpenCode client when a tool is %s", async (_label, blocked) => {
    const dispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      if (blocked && JSON.parse(raw).event === "tool_call")
        return JSON.stringify({
          decision: "deny_call",
          feedback: "[appa] This tool is blocked by policy",
          // A remedy only the MCP gateway's tools can carry out.
          offers: [{ offer_id: "offer-1" }],
        });
      return dispatch?.(raw);
    });
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      const client = createOpenAiTestClient({
        nonStreamingToolCalls: [
          { id: "call_weather", name: "get_weather", arguments: "{}" },
        ],
      });
      const create = client.chat.completions.create;
      client.chat.completions.create = async (params) => {
        providerBodies.push(structuredClone(params));
        return create(params);
      };
      return client as never;
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        ...openCodeHeaders(),
        "x-appa-session-id": `proxy-only-${blocked ? "blocked" : "allowed"}`,
      },
      payload: {
        ...openCodePayload(),
        stream: false,
        tools: openCodePayload().tools.slice(0, 1),
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const message = response.json().choices[0].message;
    if (blocked) {
      expect(message.content).toContain("This tool is blocked by policy");
      expect(message.content).toContain("MCP gateway");
      expect(message.tool_calls ?? []).toHaveLength(0);
    } else {
      expect(message.tool_calls[0].function.name).toBe("get_weather");
    }
    expect(JSON.stringify(providerBodies)).not.toContain("archestra__");
  });

  test("marks a fresh Codex root when its native session arrives in client metadata", async () => {
    config.openappa.offerSigningSecret =
      "test-context-secret-with-32-characters";
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async (params: unknown) => {
              providerBodies.push(params);
              return {
                id: "resp_codex_root",
                object: "response",
                created_at: 1,
                status: "completed",
                model: "gpt-5.5",
                output: [
                  {
                    type: "message",
                    id: "msg_codex_root",
                    role: "assistant",
                    status: "completed",
                    content: [
                      { type: "output_text", text: "Ready", annotations: [] },
                    ],
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              };
            },
          },
        }) as never,
    );
    const session = "48e172bf-5c59-4413-968f-128019a06cf5";
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...internalCallHeader(), ...codexHeaders() },
      payload: {
        ...codexPayload({ session_id: session, thread_id: session }),
        stream: false,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("protected session");
    expect(JSON.stringify(providerBodies)).not.toContain("protected session");
  });

  test("gates an OpenCode task fork without inventing a gateway notice tool", async () => {
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () => ({
              id: "resp_task",
              object: "response",
              created_at: 1,
              status: "completed",
              model: "gpt-4.1",
              output: [
                {
                  type: "function_call",
                  id: "fc_task",
                  call_id: "call_task",
                  name: "task",
                  arguments: JSON.stringify({
                    description: "Calculate",
                    prompt: "Determine 17 plus 25",
                    subagent_type: "general",
                  }),
                  status: "completed",
                },
              ],
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            }),
          },
        }) as never,
    );

    const send = (sessionId: string) =>
      app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/responses`,
        remoteAddress: "127.0.0.1",
        headers: {
          ...internalCallHeader(),
          ...openCodeHeaders(),
          "x-session-id": sessionId,
        },
        payload: {
          model: "gpt-4.1",
          stream: false,
          input: [{ role: "user", content: "Delegate the calculation" }],
          tools: [
            {
              type: "function",
              name: "task",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      });
    const response = await send(OPENCODE_SESSION);
    expect(response.statusCode, response.body).toBe(200);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_call",
        tool: "task",
        spawn: true,
      }),
    );

    const defaultDispatch = native.dispatchHook.getMockImplementation();
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const decision = await defaultDispatch?.(raw);
      if (JSON.parse(raw).event === "tool_call" && JSON.parse(raw).spawn)
        return JSON.stringify({ decision: "allow_call" });
      return decision;
    });
    events.length = 0;
    const unprepared = await send(OPENCODE_FORK_SESSION);
    expect(unprepared.statusCode, unprepared.body).toBe(200);
    expect(unprepared.body).toContain("context_control");
    expect(unprepared.json().output[0].type).toBe("message");
    // OpenCode loads its MCP servers before its first request, so a resend
    // would meet the same refusal: the hint names the sign-in at once.
    expect(unprepared.body).toContain("Run opencode mcp auth");
    expect(unprepared.body).not.toContain("Send your message again");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "cancel_call",
        tool_call_id: "call_task",
      }),
    );

    events.length = 0;
    const repeated = await send(OPENCODE_FORK_SESSION);
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.body).toContain("context_control");
    expect(repeated.json().output[0].type).toBe("message");
    expect(repeated.body).toContain("Run opencode mcp auth");
    expect(repeated.body).not.toContain("Send your message again");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "cancel_call",
        tool_call_id: "call_task",
      }),
    );
  });

  test("injects the APPA pair when a Codex session omits it", async () => {
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
      payload: payload as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
  });

  test("refuses a governed Responses request that continues a stored response", async () => {
    // The stored response keeps the conversation at the provider, so the
    // request in hand is a delta the ruling cannot read.
    const payload = codexPayload({
      session_id: CODEX_SESSION,
      thread_id: CODEX_THREAD,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...internalCallHeader(), ...codexHeaders() },
      payload: {
        ...payload,
        previous_response_id: "resp_stored",
      } as Record<string, unknown>,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("previous_response_id");
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
  const deniedCodexTurn = async (
    tools: unknown[],
    clientHeaders: Record<string, string> = codexHeaders(),
  ) => {
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
      headers: { ...internalCallHeader(), ...clientHeaders },
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

  // The ChatGPT desktop app's Work and Codex tabs run Codex's app server and
  // read Codex's config.toml: the same wire, under the desktop's originators.
  test.for([
    ["a Work thread", "codex_work_desktop"],
    ["the Codex tab", "Codex Desktop"],
  ] as const)("governs %s of the ChatGPT desktop app as a native Codex session", async ([
    ,
    originator,
  ], { makeAgent }) => {
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });

    const { output } = await deniedCodexTurn(
      [codexNamespace("mcp__my_gateway")],
      {
        ...codexHeaders(),
        "x-archestra-agent-id": "openai_codex",
        "user-agent": "Codex Desktop/0.163.0 (Windows 10.0.26200; x86_64)",
        originator,
      },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_call",
        tool: "exec_command",
        session_id: expect.stringContaining(CODEX_THREAD),
      }),
    );
    expect(output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: "call_shell",
        name: "archestra__get_remedy_plans",
        namespace: "mcp__my_gateway",
      }),
    ]);
  });

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

  test.each([
    false,
    true,
  ])("delivers an authorized Codex spawn retry through final validation (stream=%s)", async (stream) => {
    const dispatch = native.dispatchHook.getMockImplementation();
    if (!dispatch) throw new Error("missing native boundary fixture");
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      if (event.event === "tool_result") {
        events.push(event);
        return JSON.stringify({ decision: "ack" });
      }
      return dispatch(raw);
    });
    const authorized = {
      message: "Read the bounded report",
      task_name: "reader",
    };
    const retry = {
      type: "function_call",
      id: "fc_retry",
      call_id: "call_retry",
      name: "spawn_agent",
      arguments: JSON.stringify({ ...authorized, message: "A rewritten task" }),
      status: "completed",
    };
    const completed = {
      id: "resp_retry",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-5.5",
      output: [retry],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () =>
              stream
                ? {
                    async *[Symbol.asyncIterator]() {
                      yield {
                        type: "response.output_item.added",
                        output_index: 0,
                        sequence_number: 1,
                        item: {
                          ...retry,
                          arguments: "",
                          status: "in_progress",
                        },
                      };
                      yield {
                        type: "response.function_call_arguments.delta",
                        output_index: 0,
                        sequence_number: 2,
                        item_id: retry.id,
                        delta: retry.arguments,
                      };
                      yield {
                        type: "response.output_item.done",
                        output_index: 0,
                        sequence_number: 3,
                        item: retry,
                      };
                      yield {
                        type: "response.completed",
                        sequence_number: 4,
                        response: completed,
                      };
                    },
                  }
                : completed,
          },
        }) as never,
    );
    const payload = codexPayload({
      session_id: CODEX_SESSION,
      thread_id: CODEX_THREAD,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...internalCallHeader(), ...codexHeaders() },
      payload: {
        ...payload,
        stream,
        tools: [
          ...payload.tools,
          {
            type: "namespace",
            name: "collaboration",
            tools: [
              {
                type: "function",
                name: "spawn_agent",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
        input: [
          ...payload.input,
          {
            ...retry,
            call_id: "call_held",
            namespace: "collaboration",
            arguments: JSON.stringify(authorized),
          },
          {
            type: "function_call_output",
            call_id: "call_held",
            output: "Declare a return label before retrying this spawn.",
          },
          {
            type: "function_call",
            call_id: "call_remedy",
            name: "archestra__execute_remedy_plan",
            arguments:
              '{"offer_id":"spawn-offer","label":{"audience":["internal"]}}',
          },
          {
            type: "function_call_output",
            call_id: "call_remedy",
            output: `[appa] Authorized. Call the collaboration.spawn_agent tool again with exactly these arguments: ${JSON.stringify(authorized)}`,
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const frames = stream
      ? response.body
          .split("\n")
          .filter(
            (line) => line.startsWith("data: ") && line !== "data: [DONE]",
          )
          .map((line) => JSON.parse(line.slice("data: ".length)))
      : [];
    const output = stream
      ? frames.findLast((event) => event.type === "response.completed")
          ?.response.output
      : response.json().output;
    expect(output).toEqual([
      expect.objectContaining({
        name: "spawn_agent",
        namespace: "collaboration",
      }),
    ]);
    expect(JSON.parse(output[0].arguments)).toEqual(authorized);
    expect(
      events.filter((event) => event.event === "tool_call" && event.spawn),
    ).toEqual([expect.objectContaining({ arguments: authorized })]);
    if (stream) {
      const added = frames.filter(
        (event) => event.type === "response.output_item.added",
      );
      const done = frames.filter(
        (event) => event.type === "response.output_item.done",
      );
      expect(added).toHaveLength(1);
      expect(added[0].item).toMatchObject({
        name: "spawn_agent",
        namespace: "collaboration",
      });
      expect(done).toHaveLength(1);
      expect(done[0].item).toMatchObject(output[0]);
      expect(
        frames
          .filter(
            (event) => event.type === "response.function_call_arguments.delta",
          )
          .map((event) => event.delta)
          .join(""),
      ).toBe(output[0].arguments);
      expect(frames.at(-1)?.type).toBe("response.completed");
    }
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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

  test("keeps an invalid run_tool display-name target from aborting the completed stream", async ({
    makeAgent,
  }) => {
    await makeAgent({
      name: "My Gateway",
      agentType: "mcp_gateway",
      organizationId: agent.organizationId,
    });
    native.dispatchHook.mockImplementation(async (raw: string) => {
      const event = JSON.parse(raw);
      events.push(event);
      return JSON.stringify(
        event.event === "tool_call"
          ? {
              decision: "deny_call",
              feedback: "[appa] Invalid dispatch target",
            }
          : { decision: "ack" },
      );
    });
    const call = {
      id: "fc_invalid_dispatch",
      type: "function_call",
      status: "completed",
      call_id: "call_invalid_dispatch",
      namespace: "mcp__my_gateway",
      name: "archestra__run_tool",
      arguments: JSON.stringify({
        tool_name: "Agent Runtime Handoff",
        tool_args: { action: "spawn" },
      }),
    };
    const completed = {
      id: "resp_invalid_dispatch",
      object: "response",
      created_at: 1,
      status: "completed",
      model: "gpt-4.1",
      output: [call],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    };
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () => ({
              async *[Symbol.asyncIterator]() {
                yield {
                  type: "response.output_item.done",
                  sequence_number: 1,
                  output_index: 0,
                  item: call,
                };
                yield {
                  type: "response.completed",
                  sequence_number: 2,
                  response: completed,
                };
              },
            }),
          },
        }) as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...internalCallHeader(), ...codexHeaders() },
      payload: {
        ...codexPayload({ session_id: CODEX_SESSION, thread_id: CODEX_THREAD }),
        stream: true,
        tools: [codexNamespace("mcp__my_gateway")],
      } as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    const frames = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const completedFrames = frames.filter(
      (frame) => frame.type === "response.completed",
    );
    expect(completedFrames).toHaveLength(1);
    expect(completedFrames[0].response.output).toHaveLength(1);
    expect(completedFrames[0].response.output[0]).toMatchObject({
      name: "archestra__get_remedy_plans",
      namespace: "mcp__my_gateway",
    });
    // An invalid target is evaluated as the wrapper, never as the display name.
    expect(events.filter((event) => event.event === "tool_call")).toEqual([
      expect.objectContaining({
        tool: "archestra__run_tool",
        arguments: JSON.parse(call.arguments),
      }),
    ]);
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
      headers: {
        ...internalCallHeader(),
        ...codexHeaders(),
        "x-openai-subagent": "compact",
      },
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
      headers: {
        ...internalCallHeader(),
        ...codexHeaders(),
        "x-openai-subagent": "compact",
      },
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
        ...internalCallHeader(),
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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
        ...internalCallHeader(),
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
        ...internalCallHeader(),
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
        ...internalCallHeader(),
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

  test("a bare affinity header does not identify a supported client", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        authorization: "Bearer test-key",
        "x-archestra-virtual-key": platformCredential,
        "x-archestra-user-id": userId,
        "x-session-affinity": OPENCODE_SESSION,
      },
      payload: openCodePayload() as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events).toHaveLength(0);
  });

  test("delivers a child return contract when the child request declares no tools", async () => {
    const contract =
      "[appa] Your final message is checked when you stop, and sanitizer qa-summary rewrites it before the parent receives it.";
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
            parentId:
              typeof event.parent_id === "string" ? event.parent_id : null,
            forkedFrom:
              typeof event.fork_of === "string" ? event.fork_of : null,
            startDecision: { decision: "ack" },
          })
          .onConflictDoNothing();
        if (typeof event.parent_id === "string") {
          return JSON.stringify({ decision: "context", text: contract });
        }
      }
      return JSON.stringify({ decision: "ack" });
    });
    events.length = 0;
    providerBodies.length = 0;
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        ...codexHeaders(),
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: CODEX_FORK_THREAD,
          parent_thread_id: CODEX_THREAD,
        }),
      },
      payload: {
        model: "gpt-5.5",
        stream: true,
        input: [{ role: "user", content: "Finish the summary" }],
      },
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_start",
        parent_id: `user:${userId}|${CODEX_THREAD}`,
      }),
    );
    // The provider sees the contract before child-end. A first request with no
    // prepared spawn still cannot cross its final answer; that refusal is
    // after inference, not the missing contract.
    expect(providerBodies).toHaveLength(1);
    const sent = providerBodies[0] as { tools?: unknown };
    expect(sent.tools).toBeUndefined();
    expect(JSON.stringify(sent).split(contract).length - 1).toBe(1);
    expect(response.body).not.toContain(
      "the proxy cannot deliver before inference",
    );
  });

  test("Codex compaction stays on the thread and a new thread opens a fresh root with no parent id", async () => {
    const compact = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
        ...codexHeaders(),
        "x-openai-subagent": "compact",
      },
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
      headers: { ...internalCallHeader(), ...codexHeaders() },
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

  test("OpenCode compaction stays on the session and an explicit child binds under its parent", async () => {
    const compact = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: {
        ...internalCallHeader(),
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
        ...internalCallHeader(),
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
    expect(starts[0]).toMatchObject({
      session_id: `user:${userId}|${OPENCODE_SESSION}:${OPENCODE_FORK_SESSION}`,
      parent_id: `user:${userId}|${OPENCODE_SESSION}`,
    });
  });
});

/**
 * Evaluates parallel tool calls on OpenAI Chat Completions and Responses APIs.
 *
 * Each call in a batch is evaluated independently. Allowed calls pass through
 * unchanged. Denied calls return as notices with their original call IDs.
 */
describe("OpenAPPA parallel call matrix on the OpenAI families", () => {
  const CHAT_SESSION = "ses_01J8ZQ3V0R1Y8M0P4K0W3M7P9B";
  const RESPONSES_SESSION = "d12f967d-6fe1-4f92-a62f-0f6a2092fd2e";
  const RESPONSES_THREAD = "01a0859b-3029-78f3-a730-0edef60872cc";

  let app: FastifyInstance;
  let agent: Agent;
  let userId: string;
  let platformCredential: string;
  let events: Array<Record<string, unknown>>;
  let providerBodies: unknown[];
  let denyTools: Set<string>;
  let unregisterAppaPlugin: () => void;

  beforeEach(async ({ makeAgent, makeMember, makeUser }) => {
    config.openappa = parseOpenAppaConfig();
    await GuardrailsDeploymentModel.setEnabled(true);
    config.llmProxy.plugins = parseLlmProxyPlugins(undefined);
    unregisterAppaPlugin = registerLlmProxyPlugin(createAppaLlmProxyPlugin());
    vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
      "postgresql://test:test@localhost/test?schema=public",
    );
    app = Fastify({
      rewriteUrl: rewriteConnectionProxySetupUrl,
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
    await app.register(openAiProxyRoutes);
    agent = await makeAgent({ name: "Native proxy batch matrix" });
    userId = (await makeUser()).id;
    await makeMember(userId, agent.organizationId);
    platformCredential = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: userId,
    });
    events = [];
    providerBodies = [];
    denyTools = new Set();
    native.initializeOpenappa.mockResolvedValue(undefined);
    // Returns a ruling for each evaluated tool call.
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
            parentId:
              typeof event.parent_id === "string" ? event.parent_id : null,
            forkedFrom:
              typeof event.fork_of === "string" ? event.fork_of : null,
            startDecision: { decision: "ack" },
          })
          .onConflictDoNothing();
      }
      if (event.event === "tool_call")
        return JSON.stringify(
          denyTools.has(String(event.tool))
            ? {
                decision: "deny_call",
                feedback: `[appa] NATIVE REFUSAL of ${String(event.tool)}`,
              }
            : { decision: "allow_call" },
        );
      if (event.event === "tool_result")
        return JSON.stringify({
          decision: "replace_output",
          approved_output: "APPROVED REPLACEMENT",
          output_source: "tool",
        });
      return JSON.stringify({ decision: "ack" });
    });
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => chatBatchClient() as never,
    );
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () => responsesBatchClient() as never,
    );
    for (const modelId of ["gpt-4.1", "gpt-5.5"]) {
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

  /** The batch every provider turn answers with: one reader, one deleter. */
  const batchCalls = [
    { id: "call_read", name: "read_file", arguments: '{"path":"a.txt"}' },
    { id: "call_delete", name: "delete_file", arguments: '{"path":"b.txt"}' },
  ];

  const chatBatchClient = () => ({
    chat: {
      completions: {
        create: async (params: { stream?: boolean }) => {
          providerBodies.push(structuredClone(params));
          if (!params.stream)
            return {
              id: "chatcmpl_batch",
              object: "chat.completion",
              created: 1,
              model: "gpt-4.1",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    refusal: null,
                    tool_calls: batchCalls.map((call) => ({
                      id: call.id,
                      type: "function",
                      function: {
                        name: call.name,
                        arguments: call.arguments,
                      },
                    })),
                  },
                  finish_reason: "tool_calls",
                  logprobs: null,
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
            };
          return {
            async *[Symbol.asyncIterator]() {
              for (const [index, call] of batchCalls.entries()) {
                yield {
                  id: "chatcmpl_batch",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "gpt-4.1",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        ...(index === 0 ? { role: "assistant" } : {}),
                        tool_calls: [
                          {
                            index,
                            id: call.id,
                            type: "function",
                            function: { name: call.name, arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                      logprobs: null,
                    },
                  ],
                };
                yield {
                  id: "chatcmpl_batch",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "gpt-4.1",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          { index, function: { arguments: call.arguments } },
                        ],
                      },
                      finish_reason: null,
                      logprobs: null,
                    },
                  ],
                };
              }
              yield {
                id: "chatcmpl_batch",
                object: "chat.completion.chunk",
                created: 1,
                model: "gpt-4.1",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              };
            },
          };
        },
      },
    },
  });

  const responsesBatchClient = () => ({
    responses: {
      create: async (params: { stream?: boolean }) => {
        providerBodies.push(structuredClone(params));
        const completed = {
          id: "resp_batch",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.5",
          output: batchCalls.map((call) => ({
            type: "function_call",
            id: `fc_${call.id}`,
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: "completed",
          })),
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        };
        if (!params.stream) return completed;
        return {
          async *[Symbol.asyncIterator]() {
            for (const [index, call] of batchCalls.entries()) {
              const item = {
                type: "function_call",
                id: `fc_${call.id}`,
                call_id: call.id,
                name: call.name,
                arguments: call.arguments,
                status: "completed",
              };
              yield {
                type: "response.output_item.added",
                output_index: index,
                sequence_number: index * 3 + 1,
                item: { ...item, arguments: "", status: "in_progress" },
              };
              yield {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: index,
                sequence_number: index * 3 + 2,
                delta: call.arguments,
              };
              yield {
                type: "response.output_item.done",
                output_index: index,
                sequence_number: index * 3 + 3,
                item,
              };
            }
            yield {
              type: "response.completed",
              sequence_number: batchCalls.length * 3 + 1,
              response: completed,
            };
          },
        };
      },
    },
  });

  const appaPair = () =>
    ["archestra__execute_remedy_plan", "archestra__get_remedy_plans"].map(
      (name) => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {} } },
      }),
    );

  const chatPayload = (stream: boolean) => ({
    model: "gpt-4.1",
    stream,
    messages: [{ role: "user", content: "Read a.txt, then delete b.txt" }],
    tools: [
      ...batchCalls.map((call) => ({
        type: "function",
        function: {
          name: call.name,
          parameters: { type: "object", properties: {} },
        },
      })),
      ...appaPair(),
    ],
  });

  const chatHeaders = () => ({
    authorization: "Bearer test-key",
    "x-archestra-virtual-key": platformCredential,
    "x-archestra-user-id": userId,
    "user-agent": "opencode/1.18.29",
    "x-session-id": CHAT_SESSION,
  });

  const responsesPayload = (stream: boolean) => ({
    model: "gpt-5.5",
    stream,
    input: [{ role: "user", content: "Read a.txt, then delete b.txt" }],
    client_metadata: {
      session_id: RESPONSES_SESSION,
      thread_id: RESPONSES_THREAD,
    },
    tools: [
      ...batchCalls.map((call) => ({
        type: "function",
        name: call.name,
        parameters: { type: "object", properties: {} },
      })),
      ...appaPair().map((tool) => ({ type: "function", ...tool.function })),
    ],
  });

  const responsesHeaders = () => ({
    authorization: "Bearer test-key",
    "x-archestra-virtual-key": platformCredential,
    "x-archestra-user-id": userId,
    "user-agent": "codex_cli_rs/0.153.0 (Linux 6.6; x86_64)",
    originator: "codex_cli_rs",
  });

  /** The calls the client received, in wire order: id, name, raw arguments. */
  const chatCallsFrom = (body: string, stream: boolean) => {
    if (!stream)
      return (
        (JSON.parse(body).choices[0].message.tool_calls ?? []) as {
          id: string;
          function: { name: string; arguments: string };
        }[]
      ).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));
    const frames = body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const byIndex = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();
    for (const frame of frames)
      for (const call of frame.choices?.[0]?.delta?.tool_calls ?? []) {
        const entry = byIndex.get(call.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;
        entry.arguments += call.function?.arguments ?? "";
        byIndex.set(call.index, entry);
      }
    return [...byIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => entry);
  };

  const responsesCallsFrom = (body: string, stream: boolean) => {
    const output = (
      stream
        ? body
            .split("\n")
            .filter(
              (line) => line.startsWith("data: ") && line !== "data: [DONE]",
            )
            .map((line) => JSON.parse(line.slice("data: ".length)))
            .findLast((event) => event.type === "response.completed").response
            .output
        : JSON.parse(body).output
    ) as Record<string, unknown>[];
    return output
      .filter((item) => item.type === "function_call")
      .map((item) => ({
        id: item.call_id as string,
        name: item.name as string,
        arguments: item.arguments as string,
      }));
  };

  type MatrixMode = "all-allow" | "mixed" | "multi-deny";
  const deniedIn = (mode: MatrixMode) =>
    mode === "all-allow"
      ? []
      : mode === "mixed"
        ? ["delete_file"]
        : ["read_file", "delete_file"];

  /** Expected client calls for the given test mode. */
  const expectMatrix = (
    calls: { id: string; name: string; arguments: string }[],
    mode: MatrixMode,
  ) => {
    expect(calls).toHaveLength(2);
    for (const [index, expected] of batchCalls.entries()) {
      const received = calls[index];
      // Preserves the original call ID for every ruling.
      expect(received.id).toBe(expected.id);
      if (deniedIn(mode).includes(expected.name)) {
        // Denied calls return as notice calls with original arguments and ruling.
        expect(received.name).toBe("archestra__get_remedy_plans");
        const notice = JSON.parse(received.arguments) as Record<
          string,
          unknown
        >;
        expect(notice.tool).toBe(expected.name);
        expect(notice.ruling).toBe(`[appa] NATIVE REFUSAL of ${expected.name}`);
        expect(notice.arguments).toBe(expected.arguments);
        expect(notice.notice).toEqual({ v: 1, call_id: expected.id });
      } else {
        // Allowed calls reach the client unchanged.
        expect(received.name).toBe(expected.name);
        expect(received.arguments).toBe(expected.arguments);
      }
    }
  };

  test.each([
    { stream: true, mode: "all-allow" },
    { stream: false, mode: "all-allow" },
    { stream: true, mode: "mixed" },
    { stream: false, mode: "mixed" },
    { stream: true, mode: "multi-deny" },
    { stream: false, mode: "multi-deny" },
  ] as const)("answers a Chat Completions batch call by call (stream=$stream, mode=$mode)", async ({
    stream,
    mode,
  }) => {
    denyTools = new Set(deniedIn(mode));

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      remoteAddress: "127.0.0.1",
      headers: { ...internalCallHeader(), ...chatHeaders() },
      payload: chatPayload(stream) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    // Each batch uses exactly one provider request.
    expect(providerBodies).toHaveLength(1);
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.tool),
    ).toEqual(["read_file", "delete_file"]);
    // Admitted calls are not cancelled.
    expect(events.map((event) => event.event)).not.toContain("cancel_call");
    expectMatrix(chatCallsFrom(response.body, stream), mode);
  });

  test.each([
    { stream: true, mode: "all-allow" },
    { stream: false, mode: "all-allow" },
    { stream: true, mode: "mixed" },
    { stream: false, mode: "mixed" },
    { stream: true, mode: "multi-deny" },
    { stream: false, mode: "multi-deny" },
  ] as const)("answers a Responses batch call by call (stream=$stream, mode=$mode)", async ({
    stream,
    mode,
  }) => {
    denyTools = new Set(deniedIn(mode));

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      remoteAddress: "127.0.0.1",
      headers: { ...internalCallHeader(), ...responsesHeaders() },
      payload: responsesPayload(stream) as Record<string, unknown>,
    });

    expect(response.statusCode, response.body).toBe(200);
    // Each batch uses exactly one provider request.
    expect(providerBodies).toHaveLength(1);
    expect(
      events
        .filter((event) => event.event === "tool_call")
        .map((event) => event.tool),
    ).toEqual(["read_file", "delete_file"]);
    // Admitted calls are not cancelled.
    expect(events.map((event) => event.event)).not.toContain("cancel_call");
    expectMatrix(responsesCallsFrom(response.body, stream), mode);
  });
});
