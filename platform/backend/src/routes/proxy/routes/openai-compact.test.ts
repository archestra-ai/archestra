import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { InteractionModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { openAiResponsesCompactAdapterFactory } from "../adapters";
import openAiProxyRoutes from "./openai";

const COMPACTED_RESPONSE = {
  id: "resp_compact_test",
  object: "response.compaction" as const,
  created_at: 1,
  output: [
    {
      id: "cmp_test",
      type: "compaction" as const,
      encrypted_content: "opaque-ciphertext",
    },
  ],
  usage: {
    input_tokens: 20,
    output_tokens: 4,
    total_tokens: 24,
  },
};

describe("OpenAI Responses compact proxy", () => {
  const compact = vi.fn();

  beforeEach(() => {
    compact.mockResolvedValue(structuredClone(COMPACTED_RESPONSE));
    vi.spyOn(
      openAiResponsesCompactAdapterFactory,
      "createClient",
    ).mockReturnValue({ responses: { compact } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    compact.mockReset();
  });

  test("routes an agent compact request through the governed handler", async ({
    makeAgent,
  }) => {
    const app = createApp();
    await app.register(openAiProxyRoutes);
    const agent = await makeAgent({ name: "Compact route agent" });
    const before = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses/compact`,
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-5.6-sol",
        input: [{ role: "user", content: "history" }],
        instructions: "Compact the conversation.",
        prompt_cache_key: "compact-cache",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(COMPACTED_RESPONSE);
    expect(compact).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "history" }],
      instructions: "Compact the conversation.",
      previous_response_id: undefined,
      prompt_cache_key: "compact-cache",
    });
    const after = await InteractionModel.getAllInteractionsForProfile(agent.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      type: "openai:responses",
      model: "gpt-5.6-sol",
      inputTokens: 20,
      outputTokens: 4,
    });
    await app.close();
  });

  test("routes the default compact endpoint and drops create-only fields", async ({
    makeAgent,
  }) => {
    const app = createApp();
    await app.register(openAiProxyRoutes);
    await makeAgent({
      name: "Default compact proxy",
      agentType: "llm_proxy",
      isDefault: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/openai/responses/compact",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      payload: {
        model: "gpt-5.6-sol",
        input: "history",
        previous_response_id: "resp_previous",
        stream: true,
        tools: [{ type: "function", name: "must-not-leak" }],
        metadata: { must_not: "leak" },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(COMPACTED_RESPONSE);
    expect(compact).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      input: "history",
      instructions: undefined,
      previous_response_id: "resp_previous",
      prompt_cache_key: undefined,
    });
    await app.close();
  });
});

function createApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({
        error: { message: error.message, type: error.type },
      });
    }
    throw error;
  });
  return app;
}
