/**
 * Provider-specific embeddings proxy route tests.
 *
 * Complements the model-router embeddings tests: these exercise the
 * per-provider `/embeddings` endpoints (e.g. POST /v1/mistral/embeddings,
 * POST /v1/gemini/embeddings) that mirror the OpenAI provider-specific route.
 */

import { vi } from "vitest";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, ModelModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createGeminiTestClient,
  createOpenAiTestClient,
} from "@/test/llm-provider-stubs";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import {
  geminiEmbeddingsAdapterFactory,
  openaiAdapterFactory,
} from "../adapters";
import geminiProxyRoutes from "./gemini";
import mistralProxyRoutes from "./mistral";

/** A passthrough virtual key owned by a fresh member of `organizationId`. */
async function makePassthroughFor(
  organizationId: string,
  fixtures: {
    makeUser: () => Promise<{ id: string }>;
    makeMember: (userId: string, organizationId: string) => Promise<unknown>;
  },
): Promise<string> {
  const owner = await fixtures.makeUser();
  await fixtures.makeMember(owner.id, organizationId);
  return await makePassthroughCredential({ organizationId, ownerId: owner.id });
}

function createRouteTestApp() {
  return createFastifyInstance();
}

async function upsertEmbeddingModel(params: {
  provider: "mistral" | "gemini";
  modelId: string;
  embeddingDimensions: 768 | 1536 | 3072;
}) {
  await ModelModel.upsert({
    externalId: `${params.provider}/${params.modelId}`,
    provider: params.provider,
    modelId: params.modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    embeddingDimensions: params.embeddingDimensions,
    customPricePerMillionInput: "0.02",
    customPricePerMillionOutput: "0.00",
    lastSyncedAt: new Date(),
  });
}

describe("provider-specific embeddings routes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => createOpenAiTestClient() as never,
    );
  });

  test("creates embeddings through the Mistral provider route", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const app = createRouteTestApp();
    await app.register(mistralProxyRoutes);
    await upsertEmbeddingModel({
      provider: "mistral",
      modelId: "mistral-embed",
      embeddingDimensions: 1536,
    });
    const agent = await makeAgent({
      name: "Mistral Embedding Agent",
      agentType: "llm_proxy",
      isDefault: true,
    });
    const passthroughToken = await makePassthroughFor(agent.organizationId, {
      makeUser,
      makeMember,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/mistral/${agent.id}/embeddings`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-mistral-key",
        "x-archestra-virtual-key": passthroughToken,
        "user-agent": "test-client",
      },
      payload: { model: "mistral-embed", input: ["first", "second"] },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: "mistral-embed",
      data: [
        { object: "embedding", index: 0 },
        { object: "embedding", index: 1 },
      ],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions[interactions.length - 1]).toMatchObject({
      type: "openai:embeddings",
      model: "mistral-embed",
      inputTokens: 2,
      outputTokens: 0,
    });
  });

  test("creates embeddings through the Gemini provider route", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const app = createRouteTestApp();
    await app.register(geminiProxyRoutes);
    await upsertEmbeddingModel({
      provider: "gemini",
      modelId: "gemini-embedding-001",
      embeddingDimensions: 3072,
    });
    const agent = await makeAgent({
      name: "Gemini Embedding Agent",
      agentType: "llm_proxy",
      isDefault: true,
    });
    const passthroughToken = await makePassthroughFor(agent.organizationId, {
      makeUser,
      makeMember,
    });

    vi.spyOn(geminiEmbeddingsAdapterFactory, "createClient").mockImplementation(
      () => createGeminiTestClient() as never,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/gemini/${agent.id}/embeddings`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-gemini-key",
        "x-archestra-virtual-key": passthroughToken,
        "user-agent": "test-client",
      },
      payload: { model: "gemini-embedding-001", input: ["first", "second"] },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: "gemini-embedding-001",
      data: [
        { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
        { object: "embedding", index: 1, embedding: [0.1, 0.2, 0.3] },
      ],
    });

    const interactions = await InteractionModel.getAllInteractionsForProfile(
      agent.id,
    );
    expect(interactions[interactions.length - 1]).toMatchObject({
      type: "gemini:embeddings",
      model: "gemini-embedding-001",
    });
  });
});
