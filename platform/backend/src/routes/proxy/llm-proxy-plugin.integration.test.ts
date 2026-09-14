import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { InteractionModel, ModelModel } from "@/models";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

describe("LLM proxy plugin lifecycle", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
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
          response: { ...(response as Record<string, unknown>), plugin: true },
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
