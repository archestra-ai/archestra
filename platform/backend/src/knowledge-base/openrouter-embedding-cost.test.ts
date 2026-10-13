import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { modelsDevClient } from "@/clients/models-dev-client";
import db, { schema } from "@/database";
import { modelSyncService } from "@/services/model-sync";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { callEmbedding } from "./embedding-clients";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";

// Covers the whole path an OpenRouter embedding's cost takes: the catalog sync
// that stores its price, the embedding call, and the recorded interaction.
// Only HTTP is stubbed.

const BASE = "https://openrouter.test/api/v1";
let reportCost = true;

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle helper, not a React hook
useMswServer(
  http.get("https://models.dev/api.json", () => HttpResponse.json({})),
  http.get(`${BASE}/models`, () =>
    HttpResponse.json({ data: [{ id: "openai/gpt-4o" }] }),
  ),
  http.get(`${BASE}/embeddings/models`, () =>
    HttpResponse.json({
      data: [
        {
          id: "openai/text-embedding-3-large",
          name: "OpenAI: Text Embedding 3 Large",
          context_length: 8192,
          architecture: {
            input_modalities: ["text"],
            output_modalities: ["embeddings"],
          },
          pricing: { prompt: "0.00000013", completion: "0" },
          supported_parameters: [],
        },
      ],
    }),
  ),
  http.post(`${BASE}/embeddings`, () =>
    HttpResponse.json({
      object: "list",
      data: [
        {
          object: "embedding",
          embedding: Buffer.from(
            new Float32Array([0.1, 0.2, 0.3]).buffer,
          ).toString("base64"),
          index: 0,
        },
      ],
      model: "openai/text-embedding-3-large",
      usage: {
        prompt_tokens: 1_000_000,
        total_tokens: 1_000_000,
        ...(reportCost ? { cost: 0.12 } : {}),
      },
    }),
  ),
);

// 1M tokens: the synced list price is $0.13/MTok; OpenRouter reports $0.12.
test.for([
  ["the synced list price when OpenRouter reports no cost", false, 0.13],
  ["the cost OpenRouter reports", true, 0.12],
] as const)("an OpenRouter embedding records %s", async ([
  ,
  withCost,
  expected,
], { makeOrganization, makeSecret, makeLlmProviderApiKey }) => {
  reportCost = withCost;
  modelsDevClient.clearFetchCache();
  const org = await makeOrganization();
  const secret = await makeSecret({ secret: { apiKey: "or-key" } });
  const key = await makeLlmProviderApiKey(org.id, secret.id, {
    provider: "openrouter",
  });
  await modelSyncService.syncModelsForApiKey({
    apiKeyId: key.id,
    provider: "openrouter",
    apiKeyValue: "or-key",
    baseUrl: BASE,
  });

  const model = "openai/text-embedding-3-large";
  await withKbObservability({
    operationName: "embedding",
    provider: "openrouter",
    model,
    source: "knowledge:embedding",
    type: "openai:embeddings",
    callback: () =>
      callEmbedding({
        inputs: ["hello"],
        model,
        apiKey: "or-key",
        baseUrl: BASE,
        dimensions: 3,
        provider: "openrouter",
      }),
    buildInteraction: (response) =>
      buildEmbeddingInteraction({
        model,
        input: "hello",
        dimensions: 3,
        response,
      }),
  });

  await expect
    .poll(async () => {
      const [row] = await db
        .select()
        .from(schema.interactionsTable)
        .where(eq(schema.interactionsTable.source, "knowledge:embedding"));
      return row ? Number(row.cost) : null;
    })
    .toBeCloseTo(expected, 6);
});
