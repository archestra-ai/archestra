import type { SupportedProvider } from "@archestra/shared";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import { ModelModel } from "@/models";
import { expect, test } from "@/test";
import { enrichDiscoveredModel } from "./discovered-model-enrichment";

/** `ensureModelExists` reports null for a model already present; these tests
 * always create a fresh one, so a null here is a broken fixture. */
async function discover(modelId: string, provider: SupportedProvider) {
  const model = await ModelModel.ensureModelExists(modelId, provider);
  if (!model) {
    throw new Error(`expected ${provider}/${modelId} to be newly created`);
  }
  return model;
}

const MODELS_DEV: ModelsDevApiResponse = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        limit: { context: 128000, output: 16384 },
        tool_call: true,
      },
    },
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    models: {
      "amazon.nova-pro-v1:0": {
        id: "amazon.nova-pro-v1:0",
        name: "Nova Pro",
        cost: { input: 0.8, output: 3.2 },
        limit: { context: 300000, output: 8192 },
      },
    },
  },
};

/** A registry that carries the model but sets no price, as models.dev does for
 * vendors that publish no per-token rate. */
const PRICELESS_REGISTRY: ModelsDevApiResponse = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5.1-codex": {
        id: "gpt-5.1-codex",
        name: "GPT-5.1 Codex",
        cost: {},
        limit: { context: 400000, output: 128000 },
      },
    },
  },
};

test("prices a model recorded under the endpoint's provider, not its own", async () => {
  // A client sent an OpenAI model name to a Bedrock endpoint, so the row was
  // written with provider "bedrock".
  const created = await discover("gpt-4o", "bedrock");

  const enriched = await enrichDiscoveredModel({
    model: created,
    modelsDevData: MODELS_DEV,
  });

  expect(enriched).toBe(true);
  const model = await ModelModel.findByProviderAndModelId("bedrock", "gpt-4o");
  expect(Number(model?.promptPricePerToken)).toBe(0.0000025);
  expect(Number(model?.completionPricePerToken)).toBe(0.00001);
  expect(model?.contextLength).toBe(128000);
  expect(model?.supportsToolCalling).toBe(true);
  // The row is still what it is: discovered through the proxy.
  expect(model?.discoveredViaLlmProxy).toBe(true);
});

test("the enriched model no longer reports the fabricated default price", async () => {
  const created = await discover("gpt-4o", "bedrock");
  await enrichDiscoveredModel({ model: created, modelsDevData: MODELS_DEV });

  const model = await ModelModel.findByProviderAndModelId("bedrock", "gpt-4o");
  const pricing = ModelModel.getEffectivePricing(model ?? null, "gpt-4o");

  expect(pricing.pricePerMillionInput).toBe("2.50");
  expect(pricing.pricePerMillionOutput).toBe("10.00");
  expect(pricing.source).not.toBe("default");
});

test("still resolves through the provider-scoped path when it matches", async () => {
  const created = await discover("us.amazon.nova-pro-v1:0", "bedrock");

  expect(
    await enrichDiscoveredModel({ model: created, modelsDevData: MODELS_DEV }),
  ).toBe(true);
  const model = await ModelModel.findByProviderAndModelId(
    "bedrock",
    "us.amazon.nova-pro-v1:0",
  );
  expect(Number(model?.promptPricePerToken)).toBe(0.0000008);
  expect(model?.contextLength).toBe(300000);
});

test("leaves a model the registry cannot place untouched", async () => {
  const created = await discover(
    "us.anthropic.claude-notarealmodel-v1:0",
    "bedrock",
  );

  expect(
    await enrichDiscoveredModel({ model: created, modelsDevData: MODELS_DEV }),
  ).toBe(false);
  const model = await ModelModel.findByProviderAndModelId(
    "bedrock",
    "us.anthropic.claude-notarealmodel-v1:0",
  );
  expect(model?.promptPricePerToken).toBeNull();
});

test("prices a Codex model no registry provider carries", async () => {
  // models.dev never backfilled the pre-5.3 Codex models, so the first-party
  // fallback finds nothing and the row would otherwise keep the estimate.
  const created = await discover("gpt-5.1-codex", "bedrock");

  expect(
    await enrichDiscoveredModel({ model: created, modelsDevData: MODELS_DEV }),
  ).toBe(true);
  const model = await ModelModel.findByProviderAndModelId(
    "bedrock",
    "gpt-5.1-codex",
  );
  expect(Number(model?.promptPricePerToken)).toBe(0.00000125);
  expect(Number(model?.completionPricePerToken)).toBe(0.00001);
  expect(
    ModelModel.getEffectivePricing(model ?? null, "gpt-5.1-codex").source,
  ).not.toBe("default");
});

test("a registry entry still outranks the published map", async () => {
  const created = await discover("gpt-4o", "bedrock");

  await enrichDiscoveredModel({ model: created, modelsDevData: MODELS_DEV });

  const model = await ModelModel.findByProviderAndModelId("bedrock", "gpt-4o");
  expect(Number(model?.promptPricePerToken)).toBe(0.0000025);
});

test("fills a price the registry omits from a model it does carry", async () => {
  // models.dev publishes entries whose `cost` is an empty object -- the vendor
  // sets no per-token rate. The entry resolves, so the row was enriched with
  // everything except the price and kept the estimate.
  const created = await discover("gpt-5.1-codex", "bedrock");

  expect(
    await enrichDiscoveredModel({
      model: created,
      modelsDevData: PRICELESS_REGISTRY,
    }),
  ).toBe(true);
  const model = await ModelModel.findByProviderAndModelId(
    "bedrock",
    "gpt-5.1-codex",
  );
  expect(Number(model?.promptPricePerToken)).toBe(0.00000125);
  expect(Number(model?.completionPricePerToken)).toBe(0.00001);
  // The metadata the priceless entry did carry is still applied.
  expect(model?.contextLength).toBe(400000);
});

test("a second sighting reports no insert, so enrichment does not re-run", async () => {
  await discover("gpt-4o", "bedrock");

  expect(await ModelModel.ensureModelExists("gpt-4o", "bedrock")).toBeNull();
});
