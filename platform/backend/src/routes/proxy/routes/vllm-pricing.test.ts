import { AUTO_ROUTABLE_HEADER } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import { internalCallHeader } from "@/clients/internal-call";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import EnvironmentDefaultUserLimitModel from "@/models/environment-default-user-limit";
import InteractionModel from "@/models/interaction";
import InteractionBillingModel from "@/models/interaction-billing";
import LimitModel from "@/models/limit";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import ModelPoolModel from "@/models/model-pool";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { accessGrants, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { useMswServer } from "@/test/msw";
import modelRouterRoutes from "./model-router";
import vllmRoutes from "./vllm";

// biome-ignore lint/correctness/useHookAtTopLevel: per-test MSW lifecycle helper
const server = useMswServer();

for (const scenario of [
  { name: "unknown", budget: "agent", price: null, status: 422 },
  { name: "minute budget", budget: "minute", price: null, status: 422 },
  {
    name: "other model minute budget",
    budget: "minute-other",
    price: null,
    status: 200,
  },
  {
    name: "soft minute budget",
    budget: "minute-soft",
    price: null,
    status: 200,
  },
  {
    name: "auto routing fallback",
    budget: "agent",
    price: null,
    status: 422,
    auto: true,
  },
  {
    name: "unknown streaming",
    budget: "agent",
    price: null,
    status: 422,
    stream: true,
  },
  { name: "default user", budget: "default", price: null, status: 422 },
  { name: "explicit zero", budget: "agent", price: "0", status: 200 },
  { name: "priced", budget: "agent", price: "2", status: 200 },
  { name: "no budget", budget: "none", price: null, status: 200 },
  { name: "other model", budget: "other", price: null, status: 200 },
  { name: "soft budget", budget: "soft", price: null, status: 200 },
] as const) {
  test(`vLLM pricing: ${scenario.name}`, async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const baseUrl = "https://vllm-pricing.example.test/v1";
    config.autoRouting.enabled = true;
    config.llm.vllm.enabled = true;
    config.llm.vllm.baseUrl = baseUrl;
    const agent = await makeAgent({ agentType: "agent" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: user.id,
    });
    await ModelModel.create({
      externalId: "vllm/synthetic-model",
      provider: "vllm",
      modelId: "synthetic-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      customPricePerMillionInput: scenario.price,
      customPricePerMillionOutput: scenario.price,
    });
    if (scenario.budget === "default") {
      await EnvironmentDefaultUserLimitModel.create({
        organizationId: agent.organizationId,
        environmentId: null,
        limitValue: 100,
        cleanupInterval: "calendar_month",
      });
    } else if (scenario.budget !== "none") {
      await LimitModel.create({
        entityType: scenario.budget.startsWith("minute")
          ? "organization"
          : "agent",
        entityId: scenario.budget.startsWith("minute")
          ? agent.organizationId
          : agent.id,
        limitType: "token_cost",
        limitValue: 100,
        model: [
          scenario.budget.endsWith("other") ? "other-model" : "synthetic-model",
        ],
        cleanupInterval: scenario.budget.startsWith("minute")
          ? "minute"
          : "calendar_month",
        behavior: scenario.budget.endsWith("soft") ? "soft" : "hard",
        lastCleanup: new Date(),
      });
    }
    let calls = 0;
    server.use(
      http.post(`${baseUrl}/chat/completions`, () => {
        calls++;
        return HttpResponse.json({
          id: "synthetic",
          object: "chat.completion",
          created: 1,
          model: "synthetic-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 500,
            total_tokens: 1500,
          },
        });
      }),
    );
    const app = createFastifyInstance();
    await app.register(vllmRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/vllm/${agent.id}/chat/completions`,
        headers: {
          authorization: "Bearer synthetic-key",
          "x-archestra-virtual-key": token,
          ...("auto" in scenario
            ? { ...internalCallHeader(), [AUTO_ROUTABLE_HEADER]: "true" }
            : {}),
        },
        payload: {
          model: "synthetic-model",
          messages: [{ role: "user", content: "Hello" }],
          stream: "stream" in scenario && scenario.stream,
        },
      });
      expect(response.statusCode, response.body).toBe(scenario.status);
      expect(calls).toBe(scenario.status === 422 ? 0 : 1);
      if (scenario.status === 422)
        expect(response.json().error.message).toContain(
          "Configure input and output token prices",
        );
      else {
        const logged = await InteractionModel.findAllPaginated({
          limit: 1,
          offset: 0,
        });
        const [receipt] = await InteractionBillingModel.findMany([
          logged.data[0].id,
        ]);
        expect(receipt.usage.issues.includes("estimated_model_price")).toBe(
          scenario.price === null,
        );
        expect(Number(logged.data[0].cost)).toBeCloseTo(
          scenario.price === "2" ? 0.003 : 0,
          10,
        );
      }
    } finally {
      await app.close();
    }
  });
}

for (const pool of [false, true]) {
  test(`selected vLLM instance pricing is enforced (pool=${pool})`, async ({
    makeAgent,
    makeLlmProviderApiKey,
  }) => {
    config.llmProxy.modelPoolsEnabled = true;
    const agent = await makeAgent({ agentType: "agent" });
    const baseUrl = "https://vllm-instance.example.test/v1";
    const key = await makeLlmProviderApiKey(agent.organizationId, null, {
      provider: "vllm",
      baseUrl,
    });
    const model = await ModelModel.create({
      externalId: "vllm/synthetic-model",
      provider: "vllm",
      modelId: "synthetic-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      promptPricePerToken: "0.00001",
      completionPricePerToken: "0.00001",
    });
    const virtual = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Synthetic",
      ...accessGrants("org"),
      providerApiKeys: [{ provider: "vllm", providerApiKeyId: key.id }],
    });
    if (pool) {
      const created = await ModelPoolModel.create({
        organizationId: agent.organizationId,
        input: {
          name: "synthetic-pool",
          members: [
            {
              providerApiKeyId: key.id,
              modelId: model.modelId,
              priority: 1,
              weight: 1,
              enabled: true,
            },
          ],
        },
      });
      await ModelPoolModel.setPoolsForVirtualApiKey({
        organizationId: agent.organizationId,
        virtualApiKeyId: virtual.virtualKey.id,
        poolIds: [created.id],
      });
    }
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 100,
      model: [model.modelId],
      lastCleanup: new Date(),
    });
    let calls = 0;
    server.use(
      http.post(`${baseUrl}/chat/completions`, () => {
        calls++;
        return HttpResponse.json({
          id: "synthetic",
          object: "chat.completion",
          created: 1,
          model: model.modelId,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }),
    );
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    try {
      for (const output of [null, "0"]) {
        await LlmProviderApiKeyModelLinkModel.syncModelsForApiKey(
          key.id,
          [
            {
              id: model.id,
              modelId: model.modelId,
              providerPricing: {
                promptPricePerToken: "0",
                completionPricePerToken: output,
                cacheReadPricePerToken: null,
                cacheWritePricePerToken: null,
              },
            },
          ],
          "vllm",
        );
        const response = await app.inject({
          method: "POST",
          url: `/v1/model-router/${agent.id}/chat/completions`,
          headers: { authorization: `Bearer ${virtual.value}` },
          payload: {
            model: pool ? "synthetic-pool" : "vllm:synthetic-model",
            messages: [{ role: "user", content: "Hello" }],
          },
        });
        expect(response.statusCode, response.body).toBe(
          output === null ? 422 : 200,
        );
        expect(calls).toBe(output === null ? 0 : 1);
      }
    } finally {
      await app.close();
    }
  });
}
