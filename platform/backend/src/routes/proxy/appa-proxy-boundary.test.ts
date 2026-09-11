import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config, { parseAppaProxyHookConfig } from "@/config";
import db, { schema } from "@/database";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import { AppaHeldResponseController } from "@/services/appa-held-response-controller";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { useMswServer } from "@/test/msw";
import { ApiError } from "@/types";
import {
  openAiResponsesAdapterFactory,
  openAiResponsesCompactAdapterFactory,
  openaiAdapterFactory,
} from "./adapters";
import {
  type AppaProxyHookConfig,
  AppaProxyHookSession,
} from "./appa-proxy-hook";
import openAiProxyRoutes from "./routes/openai";
import * as proxyUtils from "./utils";

const runtimeUrl = "http://appa-runtime.openappa.svc.cluster.local:18787";
const hookUrl = `${runtimeUrl}/hook`;
const hookConfig: AppaProxyHookConfig = {
  url: runtimeUrl,
  timeoutMs: 25,
  sessionHmacSecret: "a".repeat(32),
};

// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper, not React
const server = useMswServer();

type AppaEvent = Record<string, unknown>;

function createRouteApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: error.type },
      });
    }
    const nonApiError = error as Error & { statusCode?: number };
    return reply.status(nonApiError.statusCode ?? 500).send({
      error: {
        message: error instanceof Error ? error.message : String(nonApiError),
        type: "api_internal_server_error",
      },
    });
  });
  return app;
}

function acknowledge(event: AppaEvent) {
  return { decision: event.event === "tool_call" ? "allow_call" : "ack" };
}

function chatResponse(
  calls: Array<{ id: string; name?: string; arguments: string }>,
) {
  return {
    id: "chatcmpl-appa-boundary",
    object: "chat.completion",
    created: 1,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name ?? "get_weather",
              arguments: call.arguments,
            },
          })),
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function responsesFunctionCall(params: {
  id: string;
  name?: string;
  arguments: string;
  type?: string;
}) {
  return {
    id: "resp-appa-boundary",
    object: "response",
    created_at: 1,
    model: "gpt-4o",
    status: "completed",
    output: [
      {
        id: "fc-appa-boundary",
        type: params.type ?? "function_call",
        call_id: params.id,
        name: params.name ?? "get_weather",
        arguments: params.arguments,
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function chatStream(chunks: unknown[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* chunks;
    },
  };
}

describe("OpenAPPA proxy boundary", () => {
  let app: FastifyInstance;
  const originalHookConfig = config.llmProxy.appaHook;

  test("preserves admitted results through providers, including historical replay", async ({
    makeAgent,
  }) => {
    for (const api of ["chat/completions", "responses"]) {
      const agent = await makeAgent({ name: `APPA outcome ${api}` });
      const seen: unknown[] = [];
      const client =
        api === "responses"
          ? {
              responses: {
                create: async (body: unknown) => {
                  seen.push(body);
                  return {
                    id: "resp_outcome",
                    object: "response",
                    created_at: 1,
                    status: "completed",
                    model: "gpt-4o",
                    output:
                      seen.length === 1
                        ? [
                            {
                              id: "fc_outcome",
                              type: "function_call",
                              call_id: "call_outcome",
                              name: "get_weather",
                              arguments: '{"city":"SF"}',
                            },
                          ]
                        : [
                            {
                              id: "msg_outcome",
                              type: "message",
                              role: "assistant",
                              status: "completed",
                              content: [
                                {
                                  type: "output_text",
                                  text: "done",
                                  annotations: [],
                                },
                              ],
                            },
                          ],
                    usage: {
                      input_tokens: 1,
                      output_tokens: 1,
                      total_tokens: 2,
                    },
                  };
                },
              },
            }
          : {
              chat: {
                completions: {
                  create: async (body: unknown) => {
                    seen.push(body);
                    return {
                      id: "chatcmpl-outcome",
                      object: "chat.completion",
                      created: 1,
                      model: "gpt-4o",
                      choices: [
                        {
                          index: 0,
                          finish_reason:
                            seen.length === 1 ? "tool_calls" : "stop",
                          message: {
                            role: "assistant",
                            content: seen.length === 1 ? null : "done",
                            ...(seen.length === 1
                              ? {
                                  tool_calls: [
                                    {
                                      id: "call_outcome",
                                      type: "function",
                                      function: {
                                        name: "get_weather",
                                        arguments: '{"city":"SF"}',
                                      },
                                    },
                                  ],
                                }
                              : {}),
                          },
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
            };
      if (api === "responses")
        vi.mocked(openAiResponsesAdapterFactory.createClient).mockReturnValue(
          client as never,
        );
      else
        vi.mocked(openaiAdapterFactory.createClient).mockReturnValue(
          client as never,
        );
      const user = { role: "user", content: "Read the weather" };
      const headers = {
        authorization: "Bearer test-key",
        "x-archestra-session-id": `outcome-${api}`.replaceAll("/", "-"),
      };
      const invoke = (payload: Record<string, unknown>) =>
        app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/${api}`,
          headers,
          payload: { model: "gpt-4o", ...payload },
        });
      const issued = await invoke(
        api === "responses" ? { input: [user] } : { messages: [user] },
      );
      expect(issued.statusCode, issued.body).toBe(200);
      const history =
        api === "responses"
          ? [
              user,
              ...issued.json().output,
              {
                type: "function_call_output",
                call_id: "call_outcome",
                output: "RAW_FAILED_BODY_MARKER",
              },
            ]
          : [
              user,
              issued.json().choices[0].message,
              {
                role: "tool",
                tool_call_id: "call_outcome",
                content: "RAW_FAILED_BODY_MARKER",
              },
            ];
      const input =
        api === "responses" ? { input: history } : { messages: history };
      const failed = await invoke(input);
      expect(failed.statusCode, failed.body).toBe(200);
      expect(JSON.stringify(seen[1])).toContain("RAW_FAILED_BODY_MARKER");
      const replay = await invoke(input);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(JSON.stringify(seen[2])).toContain("RAW_FAILED_BODY_MARKER");
    }
  });

  test("rejects unknown results before trusted-data classifiers can read them", async ({
    makeAgent,
  }) => {
    const classifier = vi.spyOn(
      proxyUtils.trustedData,
      "evaluateIfContextIsTrusted",
    );
    const agent = await makeAgent({ name: "APPA pre-classifier boundary" });
    const payload = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "Read the weather" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_unissued",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"SF"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_unissued",
          content: "SYNTHETIC_UNADMITTED_CLASSIFIER_INPUT",
        },
      ],
    };
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "classifier-rejection",
      },
      payload,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(classifier).not.toHaveBeenCalled();
    expect(openaiAdapterFactory.createClient).not.toHaveBeenCalled();

    config.llmProxy.appaHook = undefined;
    await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: { authorization: "Bearer test-key" },
      payload,
    });
    expect(classifier).toHaveBeenCalled();
  });

  beforeEach(async () => {
    config.llmProxy.appaHook = hookConfig;
    app = createRouteApp();
    await app.register(openAiProxyRoutes);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient({ includeToolCalls: true }) as never,
    );
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () =>
              responsesFunctionCall({
                id: "call_response_default",
                arguments: '{"city":"SF"}',
              }),
          },
        }) as never,
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
    server.use(
      http.post(hookUrl, async ({ request }) =>
        HttpResponse.json(acknowledge((await request.json()) as AppaEvent)),
      ),
    );
  });

  afterEach(async () => {
    config.llmProxy.appaHook = originalHookConfig;
    vi.restoreAllMocks();
    await app.close();
  });

  test("requires a 32-character HMAC secret and a stable header session id", async ({
    makeAgent,
  }) => {
    expect(() =>
      parseAppaProxyHookConfig({
        url: runtimeUrl,
        timeoutMs: "100",
        sessionHmacSecret: "short",
      }),
    ).toThrow("at least 32 characters");

    const agent = await makeAgent({ name: "APPA stable session boundary" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: { authorization: "Bearer test-key" },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "weather" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__gateway__archestra__run_tool",
              parameters: { type: "object" },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("stable thread id");
    expect(openaiAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("rejects provider-hosted MCP tools before provider execution", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA provider MCP rejection" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "provider-mcp-rejected",
      },
      payload: {
        model: "gpt-4o",
        input: "do not delegate provider MCP",
        tools: [
          {
            type: "mcp",
            server_label: "fixture",
            allowed_tools: ["read_source"],
          },
          { type: "function", name: "exec_command", parameters: {} },
          { type: "function", name: "write_stdin", parameters: {} },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.body).toContain("provider-hosted MCP");
    expect(openAiResponsesAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("allows and denies non-streaming tool calls without leaking denied calls", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA nonstream boundary" });
    const events: AppaEvent[] = [];
    let deny = false;
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(
          event.event === "tool_call" && deny
            ? { decision: "block", reason: "no" }
            : acknowledge(event),
        );
      }),
    );

    for (const [sessionId, expectedAllowed] of [
      ["nonstream-allow", true],
      ["nonstream-deny", false],
    ] as const) {
      deny = !expectedAllowed;
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-session-id": sessionId,
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "weather" }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body.includes("call_list_files")).toBe(expectedAllowed);
      expect(response.body.includes("OpenAPPA remote hook denied")).toBe(
        !expectedAllowed,
      );
    }
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      2,
    );
  });

  test("sends a registered gateway wrapper to APPA by canonical target without changing client wire", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({
      name: "APPA MCP target boundary",
      organizationId: organization.id,
    });
    const gateway = await makeAgent({
      name: "APPA Gateway",
      organizationId: organization.id,
      agentType: "mcp_gateway",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "APPA native live fixture",
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "appa_native_live_fixture__read_source",
    });
    await makeAgentTool(gateway.id, tool.id);
    const events: AppaEvent[] = [];
    const emittedArguments =
      '{ "tool_name": "appa_native_live_fixture__read_source", "tool_args": { "run_id": "run-fixture", "request_key": "request-fixture", "kind": "public" } }';
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openaiAdapterFactory.createClient).mockReturnValue({
      chat: {
        completions: {
          create: async () => ({
            id: "chatcmpl-mcp-target",
            object: "chat.completion",
            created: 1,
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_mcp_target",
                      type: "function",
                      function: {
                        name: "mcp__appa_gateway__archestra__run_tool",
                        arguments: emittedArguments,
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      },
    } as never);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "mcp-target-boundary",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "read the public source" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__appa_gateway__archestra__run_tool",
              parameters: { type: "object" },
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const clientFunction =
      response.json().choices[0].message.tool_calls[0].function;
    expect(clientFunction.name).toBe("mcp__appa_gateway__archestra__run_tool");
    expect(JSON.parse(clientFunction.arguments)).toEqual(
      JSON.parse(emittedArguments),
    );
    expect(events.find((event) => event.event === "tool_call")).toMatchObject({
      tool: "mcp/appa_gateway/appa_native_live_fixture__read_source",
      arguments: {
        run_id: "run-fixture",
        request_key: "request-fixture",
        kind: "public",
      },
    });
  });

  test("denies an unknown gateway alias before APPA execution", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA MCP target spoof boundary" });
    const events: AppaEvent[] = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openaiAdapterFactory.createClient).mockReturnValue({
      chat: {
        completions: {
          create: async () =>
            chatResponse([
              {
                id: "call_spoof",
                name: "mcp__unknown_alias__archestra__run_tool",
                arguments:
                  '{"tool_name":"appa_native_live_fixture__read_source","tool_args":{}}',
              },
            ]),
        },
      },
    } as never);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "mcp-target-spoof-boundary",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "do not invent tools" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__unknown_alias__archestra__run_tool",
              parameters: {},
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      0,
    );
  });

  test("denies a wrapper target absent from its gateway profile before APPA execution", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({ organizationId: organization.id });
    const gateway = await makeAgent({
      organizationId: organization.id,
      agentType: "mcp_gateway",
      name: "APPA Gateway",
    });
    const otherGateway = await makeAgent({
      organizationId: organization.id,
      agentType: "mcp_gateway",
      name: "Other Gateway",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "APPA native live fixture",
    });
    const publicTool = await makeTool({
      catalogId: catalog.id,
      name: "appa_native_live_fixture__read_source",
    });
    const privateTool = await makeTool({
      catalogId: catalog.id,
      name: "appa_native_live_fixture__protected_publish",
    });
    await makeAgentTool(gateway.id, publicTool.id);
    // The second profile proves that an existing tool cannot be borrowed across
    // gateway identities by nesting its name below another gateway's wrapper.
    await makeAgentTool(otherGateway.id, privateTool.id);
    const events: AppaEvent[] = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openaiAdapterFactory.createClient).mockReturnValue({
      chat: {
        completions: {
          create: async () =>
            chatResponse([
              {
                id: "call_cross_gateway",
                name: "mcp__appa_gateway__archestra__run_tool",
                arguments:
                  '{"tool_name":"appa_native_live_fixture__protected_publish","tool_args":{"kind":"private"}}',
              },
            ]),
        },
      },
    } as never);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "mcp-target-cross-gateway",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "do not invent tools" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__appa_gateway__archestra__run_tool",
              parameters: {},
            },
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      0,
    );
  });

  test("holds streaming text and tool frames until APPA allows the call", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA stream boundary" });
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () =>
                chatStream([
                  {
                    id: "chatcmpl-stream",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "classified preamble" },
                        finish_reason: null,
                      },
                    ],
                  },
                  {
                    id: "chatcmpl-stream",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: "call_stream_boundary",
                              type: "function",
                              function: {
                                name: "get_weather",
                                arguments: '{"city":"SF"}',
                              },
                            },
                          ],
                        },
                        finish_reason: "tool_calls",
                      },
                    ],
                    usage: {
                      prompt_tokens: 1,
                      completion_tokens: 1,
                      total_tokens: 2,
                    },
                  },
                ]) as never,
            },
          },
        }) as never,
    );

    for (const [sessionId, allow] of [
      ["stream-allow", true],
      ["stream-deny", false],
    ] as const) {
      server.use(
        http.post(hookUrl, async ({ request }) => {
          const event = (await request.json()) as AppaEvent;
          return HttpResponse.json(
            event.event === "tool_call" && !allow
              ? { decision: "block", reason: "no" }
              : acknowledge(event),
          );
        }),
      );
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-session-id": sessionId,
        },
        payload: {
          model: "gpt-4o",
          stream: true,
          messages: [{ role: "user", content: "weather" }],
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body.includes("call_stream_boundary")).toBe(allow);
      expect(response.body.includes("classified preamble")).toBe(allow);
      expect(response.body.includes("OpenAPPA remote hook denied")).toBe(
        !allow,
      );
    }
  });

  test("does not echo a denied Responses terminal function call", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA Responses terminal boundary" });
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        return HttpResponse.json(
          event.event === "tool_call"
            ? { decision: "block", reason: "no" }
            : acknowledge(event),
        );
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "responses-terminal-deny",
      },
      payload: { model: "gpt-4o", input: "weather" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("call_response_default");
    expect(response.body).not.toContain('"function_call"');
    expect(response.body).toContain("OpenAPPA remote hook denied");
  });

  test("rejects malformed provider function arguments rather than authorizing an empty object", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA malformed arguments" });
    const events: AppaEvent[] = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );

    for (const [index, [api, argumentsValue]] of [
      ["chat/completions", "not-json"],
      ["chat/completions", "[]"],
      ["responses", "not-json"],
      ["responses", "[]"],
    ].entries()) {
      if (api === "chat/completions") {
        vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
          () =>
            ({
              chat: {
                completions: {
                  create: async () =>
                    chatResponse([
                      {
                        id: `call-${argumentsValue}`,
                        arguments: argumentsValue,
                      },
                    ]),
                },
              },
            }) as never,
        );
      } else {
        vi.mocked(
          openAiResponsesAdapterFactory.createClient,
        ).mockImplementation(
          () =>
            ({
              responses: {
                create: async () =>
                  responsesFunctionCall({
                    id: `call-${argumentsValue}`,
                    arguments: argumentsValue,
                  }),
              },
            }) as never,
        );
      }
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/${api}`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-session-id": `malformed-${index}`,
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
        `${archestraMcpBranding.appName} LLM Proxy blocked an unsupported tool call`,
      );
      expect(response.body).not.toContain(`call-${argumentsValue}`);
    }
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      0,
    );
  });

  test("rejects unsupported declaration, hosted tool, and hidden context before the provider", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA request boundary" });
    const openAiClient = vi.mocked(openaiAdapterFactory.createClient);
    const responsesClient = vi.mocked(
      openAiResponsesAdapterFactory.createClient,
    );
    const requests = [
      {
        api: "chat/completions",
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "weather" }],
          tools: [{ type: "custom", custom: { name: "shell" } }],
        },
      },
      {
        api: "responses",
        payload: {
          model: "gpt-4o",
          input: "weather",
          tools: [{ type: "web_search_preview" }],
        },
      },
      {
        api: "responses",
        payload: {
          model: "gpt-4o",
          input: "weather",
          previous_response_id: "resp_hidden",
        },
      },
    ];

    for (const [index, request] of requests.entries()) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/${request.api}`,
        headers: {
          authorization: "Bearer test-key",
          "x-archestra-session-id": `unsupported-request-${index}`,
        },
        payload: request.payload,
      });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(openAiClient).not.toHaveBeenCalled();
    expect(responsesClient).not.toHaveBeenCalled();
  });

  test("rejects custom provider calls without emitting them to the client or APPA", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA custom output boundary" });
    const events: AppaEvent[] = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openAiResponsesAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          responses: {
            create: async () =>
              responsesFunctionCall({
                id: "custom_call_1",
                type: "custom_tool_call",
                arguments: "opaque command",
              }),
          },
        }) as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "custom-output",
      },
      payload: { model: "gpt-4o", input: "weather" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("custom_call_1");
    expect(response.body).not.toContain("opaque command");
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      0,
    );
  });

  test("projects a legacy Codex Code Mode request through the APPA tool gate", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = { ...hookConfig, nativeCodexEnabled: true };
    const events: AppaEvent[] = [];
    let providerRequest: Record<string, unknown> | undefined;
    let nativeProviderCalls = 0;
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openAiResponsesAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          responses: {
            create: async (request: Record<string, unknown>) => {
              providerRequest = request;
              nativeProviderCalls++;
              return {
                id: "resp-native-codex",
                object: "response",
                created_at: 1,
                model: "gpt-4o",
                status: "completed",
                output:
                  nativeProviderCalls > 1
                    ? []
                    : [
                        {
                          id: "item-native-codex",
                          type: "function_call",
                          call_id: "call-native-codex",
                          namespace: "functions",
                          name: "exec_command",
                          arguments: '{"cmd":"pwd"}',
                        },
                      ],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              };
            },
          },
        }) as never,
    );
    const agent = await makeAgent({ name: "APPA native Codex boundary" });

    const codeModeInput = [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              { type: "custom", name: "exec" },
              { type: "function", name: "wait" },
            ],
          },
        ],
      },
      { type: "message", role: "user", content: "show the directory" },
    ];
    const bootstrap = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "native-codex-boundary",
      },
      payload: {
        model: "gpt-4o",
        input: codeModeInput,
      },
    });

    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(providerRequest).toBeUndefined();
    const bootstrapCall = bootstrap.json().output[0];
    expect(bootstrapCall).toMatchObject({
      type: "custom_tool_call",
      namespace: "functions",
      name: "exec",
      input: "text(JSON.stringify(Object.keys(tools)));",
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "native-codex-boundary",
      },
      payload: {
        model: "gpt-4o",
        input: [
          ...codeModeInput,
          {
            type: "custom_tool_call_output",
            call_id: bootstrapCall.call_id,
            output: [
              { type: "input_text", text: "Script completed\nOutput:\n" },
              {
                type: "input_text",
                text: '["apply_patch","exec_command","view_image","write_stdin"]',
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.stringify(providerRequest)).not.toContain('"name":"exec"');
    expect(JSON.stringify(providerRequest)).toContain('"name":"exec_command"');
    expect(JSON.stringify(providerRequest)).not.toContain(
      bootstrapCall.call_id,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "tool_call",
        tool: "functions.exec_command",
        arguments: { cmd: "pwd" },
      }),
    );
    const issued = response
      .json()
      .output.find((item: { type: string }) => item.type === "function_call");
    expect(issued.call_id).toMatch(/^call_appa_[0-9a-f]{32}$/);
    expect(issued.namespace).toBe("functions");
    expect(issued.name).toBe("exec_command");
    const continuation = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "native-codex-boundary",
      },
      payload: {
        model: "gpt-4o",
        input: [
          ...codeModeInput,
          {
            type: "custom_tool_call_output",
            call_id: bootstrapCall.call_id,
            output: [
              {
                type: "input_text",
                text: '["apply_patch","exec_command","view_image","write_stdin"]',
              },
            ],
          },
          issued,
          {
            type: "function_call_output",
            call_id: issued.call_id,
            output:
              "Wall time: 0.0100 seconds\nProcess exited with code 0\nOutput:\nSYNTHETIC_OK",
          },
        ],
      },
    });
    expect(continuation.statusCode, continuation.body).toBe(200);
    expect(JSON.stringify(providerRequest)).toContain(
      '"call_id":"call-native-codex"',
    );
    expect(JSON.stringify(providerRequest)).not.toContain(issued.call_id);
  });

  test("removes verified historical controls without repeated gateway declarations", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    config.llmProxy.appaHook = { ...hookConfig, nativeCodexEnabled: true };
    const user = await makeUser();
    const agent = await makeAgent({
      name: "APPA native historical control boundary",
    });
    await makeMember(user.id as never, agent.organizationId as never);
    const { value: passthroughToken } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "native historical control identity",
      keyType: "passthrough",
      scope: "personal",
      authorId: user.id,
    });
    const controlCallId = "call_appa_control_history";
    const acquire = vi.spyOn(AppaProxyHookSession, "acquire");
    const continuation = vi
      .spyOn(AppaHeldResponseController.prototype, "continueBeforeAcquire")
      .mockImplementation(async ({ results }) =>
        results.some((result) => result.id === controlCallId)
          ? { state: "historical", controlCallIds: [controlCallId] }
          : { state: "not_control" },
      );
    let providerRequest: Record<string, unknown> | undefined;
    vi.mocked(openAiResponsesAdapterFactory.createClient).mockReturnValue({
      responses: {
        create: async (body: Record<string, unknown>) => {
          providerRequest = body;
          return {
            id: "resp-native-historical",
            object: "response",
            created_at: 1,
            model: "gpt-4o",
            status: "completed",
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          };
        },
      },
    } as never);
    const codeModeInput = [
      {
        type: "additional_tools",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [{ type: "custom", name: "exec" }],
          },
        ],
      },
      { type: "message", role: "user", content: "continue safely" },
    ];
    const headers = {
      authorization: "Bearer test-key",
      "x-archestra-virtual-key": passthroughToken,
      "x-archestra-session-id": "native-historical-control",
      "x-archestra-user-id": "untrusted-attribution-user",
    };
    const bootstrap = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers,
      payload: { model: "gpt-4o", input: codeModeInput },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    const bootstrapCall = bootstrap.json().output[0];

    const historical = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers,
      payload: {
        model: "gpt-4o",
        input: [
          ...codeModeInput,
          {
            type: "custom_tool_call_output",
            call_id: bootstrapCall.call_id,
            output: [
              {
                type: "input_text",
                text: JSON.stringify([
                  "apply_patch",
                  "exec_command",
                  "mcp__gateway__archestra__appa_execute_remedy",
                ]),
              },
            ],
          },
          {
            id: `fc_${controlCallId}`,
            type: "function_call",
            call_id: controlCallId,
            namespace: "mcp__gateway",
            name: "archestra__appa_execute_remedy",
            arguments: JSON.stringify({
              intent_id: "client-control-text",
              wire_context: {
                call_id: controlCallId,
                thread_id: "native-historical-control",
              },
            }),
          },
          {
            type: "function_call_output",
            call_id: controlCallId,
            output: "CLIENT_CONTROL_RESULT_MUST_NOT_ESCAPE",
          },
        ],
      },
    });

    expect(historical.statusCode, historical.body).toBe(200);
    expect(continuation).toHaveBeenLastCalledWith(
      expect.objectContaining({ authenticatedUserId: user.id }),
    );
    expect(acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ toolResults: [] }),
    );
    expect(JSON.stringify(providerRequest)).not.toContain(controlCallId);
    expect(JSON.stringify(providerRequest)).not.toContain(
      "CLIENT_CONTROL_RESULT_MUST_NOT_ESCAPE",
    );
  });

  test("rejects unknown opaque history from the legacy compact route before provider admission", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = { ...hookConfig, nativeCodexEnabled: true };
    const compact = vi.fn();
    vi.spyOn(
      openAiResponsesCompactAdapterFactory,
      "createClient",
    ).mockReturnValue({ responses: { compact } } as never);
    const agent = await makeAgent({ name: "APPA legacy compact boundary" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses/compact`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "native-legacy-compact-boundary",
        "x-codex-window-id": "window-0",
        "x-codex-turn-metadata": JSON.stringify({
          window_number: 0,
          turn_id: "turn-0",
          compaction: { trigger: "manual" },
        }),
      },
      payload: {
        model: "gpt-4o",
        input: [
          {
            type: "reasoning",
            id: "unissued-reasoning",
            encrypted_content: "unissued-ciphertext",
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(compact).not.toHaveBeenCalled();
  });

  test("streams a persisted native bootstrap without calling the provider", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = { ...hookConfig, nativeCodexEnabled: true };
    const agent = await makeAgent({
      name: "APPA native Codex stream boundary",
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "native-codex-stream-boundary",
      },
      payload: {
        model: "gpt-4o",
        stream: true,
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [{ type: "custom", name: "exec" }],
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const chunks = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "response.created",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(chunks[1].item).toMatchObject({
      type: "custom_tool_call",
      namespace: "functions",
      name: "exec",
      input: "text(JSON.stringify(Object.keys(tools)));",
    });
    expect(chunks[1].item.call_id).toMatch(/^call_appa_[0-9a-f]{32}$/);
    expect(chunks[2].response.output[0].call_id).toBe(chunks[1].item.call_id);
    expect(openAiResponsesAdapterFactory.createClient).not.toHaveBeenCalled();
  });

  test("caps a hook-enabled provider stream at 16 MiB before client release", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA stream cap boundary" });
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () =>
                chatStream([
                  {
                    id: "chatcmpl-over-limit",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: "gpt-4o",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "x".repeat(16 * 1024 * 1024) },
                        finish_reason: null,
                      },
                    ],
                  },
                ]) as never,
            },
          },
        }) as never,
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "stream-over-limit",
      },
      payload: {
        model: "gpt-4o",
        stream: true,
        messages: [{ role: "user", content: "weather" }],
      },
    });

    expect(response.body).toContain("16 MiB prototype limit");
    expect(response.body).not.toContain("x".repeat(100));
  });

  test("quarantines invalid, timed-out, unknown, and unavailable APPA responses without replay", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA quarantine boundary" });
    const outcomes: Array<[string, () => Promise<Response> | Response]> = [
      ["invalid-json", () => new HttpResponse("not-json")],
      ["http-500", () => new HttpResponse(null, { status: 500 })],
      ["unknown", () => HttpResponse.json({ decision: "unexpected" })],
      [
        "spawn-binding",
        () => HttpResponse.json({ decision: "ack", spawn: false }),
      ],
      [
        "timeout",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return HttpResponse.json({ decision: "ack" });
        },
      ],
    ];

    for (const [name, outcome] of outcomes) {
      let attempts = 0;
      server.use(
        http.post(hookUrl, () => {
          attempts++;
          return outcome();
        }),
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/chat/completions`,
          headers: {
            authorization: "Bearer test-key",
            "x-archestra-session-id": `quarantine-${name}`,
          },
          payload: {
            model: "gpt-4o",
            messages: [{ role: "user", content: "weather" }],
          },
        });
        expect(response.statusCode, response.body).toBe(
          attempt === 0 ? 503 : 409,
        );
      }
      expect(attempts).toBe(1);
    }
  });

  test("persists unwrapped APPA target arguments before emitting one unique client call", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeOrganization,
    makeTool,
  }) => {
    const organization = await makeOrganization();
    const agent = await makeAgent({
      name: "APPA dispatch persistence boundary",
      organizationId: organization.id,
    });
    const gateway = await makeAgent({
      name: "Gateway",
      organizationId: organization.id,
      agentType: "mcp_gateway",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      name: "Weather fixture",
    });
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "get_weather",
    });
    await makeAgentTool(gateway.id, tool.id);
    let persistedBeforeRemote = false;
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        if (event.event === "tool_call") {
          const [call] = await db
            .select()
            .from(schema.appaProxyCallsTable)
            .where(
              eq(schema.appaProxyCallsTable.callId, "call_wrapped_dispatch"),
            );
          persistedBeforeRemote =
            call?.state === "authorization_intent" &&
            call.emittedArguments ===
              '{"tool_name":"get_weather","tool_args":{"city":"SF"}}' &&
            call.appaTargetName === "mcp/gateway/get_weather" &&
            JSON.stringify(call.appaTargetArguments) === '{"city":"SF"}';
        }
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () =>
                ({
                  ...chatResponse([
                    {
                      id: "call_wrapped_dispatch",
                      arguments:
                        '{"tool_name":"get_weather","tool_args":{"city":"SF"}}',
                    },
                  ]),
                  choices: [
                    {
                      ...chatResponse([]).choices[0],
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: "call_wrapped_dispatch",
                            type: "function",
                            function: {
                              name: "mcp__gateway__archestra__run_tool",
                              arguments:
                                '{"tool_name":"get_weather","tool_args":{"city":"SF"}}',
                            },
                          },
                        ],
                      },
                    },
                  ],
                }) as never,
            },
          },
        }) as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "dispatch-persistence",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "weather" }],
        tools: [
          {
            type: "function",
            function: {
              name: "mcp__gateway__archestra__run_tool",
              parameters: {},
            },
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(persistedBeforeRemote).toBe(true);
    expect(response.body.match(/call_wrapped_dispatch/g)).toHaveLength(1);
  });

  test("quarantines authorized calls when a spawn header cannot be built before delivery", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA undelivered grant boundary" });
    vi.spyOn(
      AppaProxyHookSession.prototype,
      "getSpawnBindingsHeaderValue",
    ).mockImplementation(() => {
      throw new Error(
        "authorized spawn bindings exceed the response header limit",
      );
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "undelivered-grant",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "weather" }],
      },
    });

    expect(response.statusCode).toBe(503);
    const [session] = await db
      .select()
      .from(schema.appaProxySessionsTable)
      .where(
        eq(schema.appaProxySessionsTable.clientSessionId, "undelivered-grant"),
      );
    expect(session?.state).toBe("quarantined");
    expect(
      await db
        .select()
        .from(schema.appaProxyCallsTable)
        .where(eq(schema.appaProxyCallsTable.sessionId, session?.id ?? "")),
    ).toEqual([expect.objectContaining({ state: "open" })]);
  });

  test("rejects a multi-call proposal before any APPA call or client emission", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "APPA multi proposal boundary" });
    const events: AppaEvent[] = [];
    server.use(
      http.post(hookUrl, async ({ request }) => {
        const event = (await request.json()) as AppaEvent;
        events.push(event);
        return HttpResponse.json(acknowledge(event));
      }),
    );
    vi.mocked(openaiAdapterFactory.createClient).mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () =>
                chatResponse([
                  { id: "call_batch_a", arguments: '{"city":"SF"}' },
                  { id: "call_batch_b", arguments: '{"city":"NYC"}' },
                ]) as never,
            },
          },
        }) as never,
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "x-archestra-session-id": "multi-proposal",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "weather" }],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain("call_batch_a");
    expect(response.body).not.toContain("call_batch_b");
    expect(events.filter((event) => event.event === "tool_call")).toHaveLength(
      0,
    );
  });
});
