import {
  generateText,
  jsonSchema,
  type ModelMessage,
  stepCountIs,
  tool,
} from "ai";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { createLLMModel } from "@/clients/llm-client";
import config from "@/config";
import {
  applyPromptCacheBreakpoints,
  applyStepPromptCacheBreakpoint,
  usesStepPromptCache,
} from "@/routes/chat/normalization/apply-prompt-cache";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import openrouterProxyRoutes from "./openrouter";

type WireMessage = {
  role: string;
  content?: unknown;
  cache_control?: unknown;
};
type WireRequest = { model: string; messages: WireMessage[] };

/** Where each breakpoint of an upstream request sits. */
function breakpoints(request: WireRequest) {
  const onParts: Array<{ role: string; partType: unknown }> = [];
  let onMessages = 0;
  for (const message of request.messages) {
    if (message.cache_control) onMessages++;
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part.cache_control) {
        onParts.push({ role: message.role, partType: part.type });
      }
    }
  }
  return { onParts, onMessages };
}

/** Local OpenRouter stand-in: one tool call, then a final answer. */
function createUpstream(upstreamBodies: WireRequest[]) {
  const upstream = Fastify();
  upstream.post("/chat/completions", (request) => {
    const body = request.body as WireRequest;
    upstreamBodies.push(body);
    const message =
      upstreamBodies.length === 1
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"orders"}' },
              },
            ],
          }
        : { role: "assistant", content: "There are 3 orders." };
    return {
      id: `chatcmpl-${upstreamBodies.length}`,
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: upstreamBodies.length === 1 ? "tool_calls" : "stop",
          logprobs: null,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  });
  return upstream;
}

describe("OpenRouter proxy prompt-cache breakpoints", () => {
  const upstreamBodies: WireRequest[] = [];
  let upstream: FastifyInstance;
  let app: FastifyInstance;
  const originalBaseUrl = config.llm.openrouter.baseUrl;
  const originalPort = config.api.port;

  beforeEach(async () => {
    upstreamBodies.length = 0;
    upstream = createUpstream(upstreamBodies);
    config.llm.openrouter.baseUrl = await upstream.listen({
      port: 0,
      host: "127.0.0.1",
    });
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app
      .withTypeProvider<ZodTypeProvider>()
      .register(openrouterProxyRoutes);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("proxy app has no TCP address");
    }
    config.api.port = address.port;
  });

  afterEach(async () => {
    await app.close();
    await upstream.close();
    config.llm.openrouter.baseUrl = originalBaseUrl;
    config.api.port = originalPort;
  });

  async function runToolLoop(agentId: string, modelName: string) {
    const provider = "openrouter";
    const history: ModelMessage[] = [
      { role: "user", content: "How many orders are open?" },
      { role: "assistant", content: "Let me check." },
      { role: "user", content: "Use the lookup tool." },
    ];
    await generateText({
      model: createLLMModel({
        provider,
        apiKey: "test-openrouter-key",
        agentId,
        modelName,
        baseUrl: null,
      }),
      system: "You answer questions about orders.",
      messages: applyPromptCacheBreakpoints({
        provider,
        model: modelName,
        messages: history,
      }),
      tools: {
        lookup: tool({
          inputSchema: jsonSchema<{ q: string }>({
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          }),
          execute: async () => "3 open orders",
        }),
      },
      stopWhen: stepCountIs(2),
      ...(usesStepPromptCache({ provider, anthropicNativeEndpoint: false }) && {
        prepareStep: ({ messages }) => ({
          messages: applyStepPromptCacheBreakpoint({
            provider,
            model: modelName,
            messages,
          }),
        }),
      }),
    });
    expect(upstreamBodies).toHaveLength(2);
    return upstreamBodies.map(breakpoints);
  }

  test("forwards Anthropic breakpoints on text parts within the 4-breakpoint cap", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const [initial, toolStep] = await runToolLoop(
      agent.id,
      "anthropic/claude-haiku-4.5",
    );

    // First and last history messages; the tool step adds its tool result.
    expect(initial).toEqual({
      onMessages: 0,
      onParts: [
        { role: "user", partType: "text" },
        { role: "user", partType: "text" },
      ],
    });
    expect(toolStep).toEqual({
      onMessages: 0,
      onParts: [
        { role: "user", partType: "text" },
        { role: "user", partType: "text" },
        { role: "tool", partType: "text" },
      ],
    });
  });

  test("sends no breakpoints for a non-Anthropic model", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const requests = await runToolLoop(agent.id, "openai/gpt-4o-mini");

    for (const request of requests) {
      expect(request).toEqual({ onMessages: 0, onParts: [] });
    }
  });
});
