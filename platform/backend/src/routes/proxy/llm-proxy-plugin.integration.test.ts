import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { InteractionModel, ModelModel } from "@/models";
import {
  getLlmProxyPluginRegistry,
  registerLlmProxyPlugin,
} from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createAnthropicTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { anthropicAdapterFactory, openaiAdapterFactory } from "./adapters";
import { makeAnthropicOpenaiAdapterFactory } from "./adapters/anthropic-openai";
import { makeResponsesFromChatAdapterFactory } from "./adapters/openai-responses-from-chat";
import { handleLLMProxy } from "./llm-proxy-handler";
import openAiProxyRoutes from "./routes/openai";

describe("LLM proxy plugin lifecycle", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({
      // A failed lifecycle must release the request id so a later request can
      // reuse it without inheriting stale plugin state.
      genReqId: () => "plugin-test-request",
    }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient({}) as never,
    );
    await app.register(openAiProxyRoutes);
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
    vi.restoreAllMocks();
    await app.close();
  });

  async function assertBaselineProxyResponse(params: {
    agentId: string;
    stream: boolean;
  }) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${params.agentId}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        stream: params.stream,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
  }

  test("preserves the non-streaming proxy flow with no configured plugins", async ({
    makeAgent,
  }) => {
    expect(getLlmProxyPluginRegistry().hasPlugins()).toBe(false);
    const agent = await makeAgent({
      agentType: "llm_proxy",
      isDefault: true,
    });
    await assertBaselineProxyResponse({ agentId: agent.id, stream: false });
  });

  test("preserves the streaming proxy flow with no configured plugins", async ({
    makeAgent,
  }) => {
    expect(getLlmProxyPluginRegistry().hasPlugins()).toBe(false);
    const agent = await makeAgent({
      agentType: "llm_proxy",
      isDefault: true,
    });
    await assertBaselineProxyResponse({ agentId: agent.id, stream: true });
  });

  test("preserves proxy error handling with no configured plugins", async ({
    makeAgent,
  }) => {
    expect(getLlmProxyPluginRegistry().hasPlugins()).toBe(false);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(() => {
      throw new Error("provider unavailable");
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/chat/completions`,
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
      },
    });

    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
    expect(response.body).toContain("provider unavailable");
  });

  test.for([
    false,
    true,
  ])("buffers and replaces a routed Anthropic Responses answer in its native adapter domain (stream=%s)", async (stream, {
    makeAgent,
  }) => {
    const rawText = "RAW WRAPPED ANSWER";
    const admittedText = "ADMITTED WRAPPED ANSWER";
    const observedText: string[] = [];
    const unregister = registerLlmProxyPlugin({
      id: `test-buffered-wrapped-response-${crypto.randomUUID()}`,
      buffersModelResponse: () => true,
      async onBufferedModelResponse({ responseText }) {
        observedText.push(responseText);
        return { decision: "replace", responseText: admittedText };
      },
    });
    vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
      () => createAnthropicTestClient({ responseText: rawText }) as never,
    );
    const provider = makeResponsesFromChatAdapterFactory(
      makeAnthropicOpenaiAdapterFactory({
        chatcmplId: "chatcmpl-wrapped",
        createdUnix: 1,
        requestedModel: "routed-claude",
      }),
      {
        responseId: "resp-wrapped",
        createdUnix: 1,
        requestedModel: "routed-claude",
      },
    );
    app.post("/test/wrapped/:agentId", async (request, reply) =>
      handleLLMProxy(
        request.body as Parameters<typeof provider.createRequestAdapter>[0],
        request,
        reply,
        provider,
      ),
    );
    const agent = await makeAgent({ agentType: "llm_proxy" });
    await ModelModel.upsert({
      externalId: "anthropic/claude-wrapped",
      provider: "anthropic",
      modelId: "claude-wrapped",
      inputModalities: null,
      outputModalities: null,
      lastSyncedAt: new Date(),
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/test/wrapped/${agent.id}`,
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        payload: {
          model: "claude-wrapped",
          max_tokens: 128,
          messages: [{ role: "user", content: "hello" }],
          stream,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(observedText).toEqual([stream ? `Hello! ${rawText}` : rawText]);
      expect(response.body).toContain(admittedText);
      expect(response.body).not.toContain(rawText);
      expect(response.body).toContain(
        stream ? '"type":"response.completed"' : '"object":"response"',
      );
    } finally {
      unregister();
    }
  });

  test("runs generic request and response hooks for a non-APPA request", async ({
    makeAgent,
  }) => {
    const events: string[] = [];
    const unregister = registerLlmProxyPlugin({
      id: `test-observer-${crypto.randomUUID()}`,
      async onPrompt() {
        events.push("prompt");
      },
      async onBeforeModel() {
        events.push("before-model");
      },
      async onModelResponse({ response }) {
        events.push("response");
        return {
          response: {
            ...(response as Record<string, unknown>),
            model: "gpt-4o-plugin-rewrite",
          },
        };
      },
      async onComplete() {
        events.push("complete");
      },
      async onCleanup() {
        events.push("cleanup");
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        model: "gpt-4o-plugin-rewrite",
      });
      expect(events).toEqual([
        "prompt",
        "before-model",
        "response",
        "complete",
        "cleanup",
      ]);
    } finally {
      unregister();
    }
  });

  test("fails closed for invalid plugin response values and releases the request id", async ({
    makeAgent,
  }) => {
    const invalidResponseCases = [
      { label: "null", response: null, rawContent: "null" },
      {
        label: "a string",
        response: "plugin-secret-string",
        rawContent: "plugin-secret-string",
      },
      { label: "undefined", response: undefined, rawContent: "undefined" },
      {
        label: "an array",
        response: ["plugin-secret-array"],
        rawContent: "plugin-secret-array",
      },
      { label: "a number", response: 8675309, rawContent: "8675309" },
    ];
    const events: string[] = [];
    let returnInvalidResponse = false;
    let invalidResponse: unknown;
    const unregister = registerLlmProxyPlugin({
      id: `test-invalid-response-${crypto.randomUUID()}`,
      async onModelResponse({ response }) {
        events.push("response");
        if (returnInvalidResponse) {
          returnInvalidResponse = false;
          return { response: invalidResponse };
        }
        return {
          response: {
            ...(response as Record<string, unknown>),
            model: "gpt-4o-plugin-rewrite",
          },
        };
      },
      async onError() {
        events.push("error");
      },
      async onComplete() {
        events.push("complete");
      },
      async onCleanup() {
        events.push("cleanup");
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    try {
      for (const invalidCase of invalidResponseCases) {
        events.length = 0;
        invalidResponse = invalidCase.response;
        returnInvalidResponse = true;
        const failed = await app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/chat/completions`,
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
          },
          payload: {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hello" }],
          },
        });

        expect(failed.statusCode, `${invalidCase.label}: ${failed.body}`).toBe(
          500,
        );
        expect(failed.body).toContain(
          "LLM proxy plugin returned an invalid response",
        );
        expect(failed.body).not.toContain(invalidCase.rawContent);
        expect(events).toEqual(["response", "error", "cleanup"]);

        const retried = await app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/chat/completions`,
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
          },
          payload: {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hello" }],
          },
        });

        expect(retried.statusCode, retried.body).toBe(200);
        expect(retried.json()).toMatchObject({
          model: "gpt-4o-plugin-rewrite",
        });
        expect(events).toEqual([
          "response",
          "error",
          "cleanup",
          "response",
          "complete",
          "cleanup",
        ]);
      }
    } finally {
      unregister();
    }
  });

  test("streaming hooks observe the same completed response snapshot", async ({
    makeAgent,
  }) => {
    const responses: unknown[] = [];
    const unregister = registerLlmProxyPlugin({
      id: `test-stream-snapshot-${crypto.randomUUID()}`,
      async onModelResponse({ response }) {
        responses.push(response);
        return { response: { model: "ignored-streaming-replacement" } };
      },
      async onComplete({ response }) {
        responses.push(response);
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    try {
      await assertBaselineProxyResponse({ agentId: agent.id, stream: true });
      expect(responses).toHaveLength(2);
      expect(responses[0]).toMatchObject({ model: "gpt-4o" });
      expect(responses[1]).toBe(responses[0]);
    } finally {
      unregister();
    }
  });

  test("fails a streaming request closed and cleans plugins after a hook error", async ({
    makeAgent,
  }) => {
    const events: string[] = [];
    const unregister = registerLlmProxyPlugin({
      id: `test-stream-error-${crypto.randomUUID()}`,
      async onBeforeModel() {
        events.push("before-model");
        throw new Error("plugin stopped the request");
      },
      async onError() {
        events.push("error");
      },
      async onCleanup() {
        events.push("cleanup");
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        },
      });

      expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(events).toEqual(["before-model", "error", "cleanup"]);
    } finally {
      unregister();
    }
  });

  test("preserves a provider error when plugin error cleanup also fails", async ({
    makeAgent,
  }) => {
    const events: string[] = [];
    const unregister = registerLlmProxyPlugin({
      id: `test-error-cleanup-${crypto.randomUUID()}`,
      async onSessionInit() {
        events.push("init");
      },
      async onError() {
        events.push("error");
        throw new Error("plugin error cleanup failed");
      },
      async onCleanup() {
        events.push("cleanup");
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });
    const client = createOpenAiTestClient({});
    client.chat.completions.create = async () => {
      throw new Error("provider unavailable");
    };
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => client as never,
    );

    try {
      for (const stream of [false, true]) {
        events.length = 0;
        const response = await app.inject({
          method: "POST",
          url: `/v1/openai/${agent.id}/chat/completions`,
          headers: {
            authorization: "Bearer test-key",
            "content-type": "application/json",
          },
          payload: {
            model: "gpt-4o",
            messages: [{ role: "user", content: "hello" }],
            stream,
          },
        });

        expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
        expect(response.body).toContain("provider unavailable");
        expect(response.body).not.toContain("plugin error cleanup failed");
        expect(events).toEqual(["init", "error", "cleanup"]);
      }
    } finally {
      unregister();
    }
  });

  test("cleans an initialized tool-result hook failure before invoking the provider", async ({
    makeAgent,
  }) => {
    const events: string[] = [];
    let failOnce = true;
    const unregister = registerLlmProxyPlugin({
      id: `test-tool-result-error-${crypto.randomUUID()}`,
      async onSessionInit() {
        events.push("init");
      },
      async onToolResults() {
        events.push("tool-results");
        if (failOnce) {
          failOnce = false;
          throw new Error("tool results unavailable");
        }
      },
      async onError() {
        events.push("error");
      },
      async onCleanup() {
        events.push("cleanup");
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    try {
      const failed = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(failed.statusCode, failed.body).toBeGreaterThanOrEqual(400);
      expect(openaiAdapterFactory.createClient).not.toHaveBeenCalled();
      expect(events).toEqual(["init", "tool-results", "error", "cleanup"]);

      const retried = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
        },
      });

      expect(retried.statusCode, retried.body).toBe(200);
      expect(openaiAdapterFactory.createClient).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        "init",
        "tool-results",
        "error",
        "cleanup",
        "init",
        "tool-results",
        "cleanup",
      ]);
    } finally {
      unregister();
    }
  });

  test("uses the final plugin's rich refusal after an earlier rewrite", async ({
    makeAgent,
  }) => {
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          chat: {
            completions: {
              create: async () => ({
                id: "chatcmpl-plugin-test",
                object: "chat.completion",
                created: 1,
                model: "gpt-4o",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      refusal: null,
                      tool_calls: [
                        {
                          id: "call-1",
                          type: "function",
                          function: { name: "read_file", arguments: "{}" },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                    logprobs: null,
                  },
                ],
                usage: {
                  prompt_tokens: 1,
                  completion_tokens: 1,
                  total_tokens: 2,
                },
              }),
            },
          },
        }) as never,
    );
    const events: string[] = [];
    const unregisterFirst = registerLlmProxyPlugin({
      id: `test-rewrite-${crypto.randomUUID()}`,
      async onToolCalls({ toolCalls, resources }) {
        events.push(toolCalls[0]?.name ?? "missing");
        resources.set("archestra.appa.refusal", {
          refusalMessage: "STALE PRIVATE REFUSAL",
          contentMessage: "STALE PRIVATE REFUSAL",
          reason: "stale",
          blockedToolName: "stale",
          toolInput: {},
          allToolCallNames: ["stale"],
        });
        return {
          decision: "allow",
          toolCalls: toolCalls.map((toolCall) => ({
            ...toolCall,
            name: `reviewed_${toolCall.name}`,
          })),
        };
      },
    });
    const unregisterSecond = registerLlmProxyPlugin({
      id: `test-refusal-${crypto.randomUUID()}`,
      async onToolCalls({ toolCalls }) {
        events.push(toolCalls[0]?.name ?? "missing");
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: "PRIVATE GENERIC REFUSAL",
            contentMessage: "Plugin refused reviewed call",
            reason: "generic plugin denied reviewed call",
            blockedToolName: toolCalls[0]?.name ?? "missing",
            toolInput: { path: "/private" },
            allToolCallNames: [toolCalls[0]?.name ?? "missing"],
          },
        };
      },
    });
    const agent = await makeAgent({ agentType: "llm_proxy", isDefault: true });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "read a file" }],
          tools: [
            {
              type: "function",
              function: {
                name: "read_file",
                parameters: { type: "object", properties: {} },
              },
            },
          ],
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("Plugin refused reviewed call");
      expect(response.body).not.toContain("PRIVATE GENERIC REFUSAL");
      expect(response.body).not.toContain("STALE PRIVATE REFUSAL");
      expect(response.body).not.toContain("/private");
      expect(events).toEqual(["read_file", "reviewed_read_file"]);
      const [interaction] = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      expect(interaction.toolCallBlock).toEqual({
        reason: "generic plugin denied reviewed call",
        blockedToolCallCount: 1,
      });
    } finally {
      unregisterSecond();
      unregisterFirst();
    }
  });
});
