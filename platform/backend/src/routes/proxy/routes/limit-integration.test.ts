/**
 * Integration tests for end-to-end LLM proxy limit enforcement.
 *
 * Verifies that real LimitModel limits are checked and enforced during LLM
 * proxy requests — NO mocking of LimitValidationService or the database.
 * Only the upstream LLM client is mocked via createHarness.
 */
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import type OpenAI from "openai";
import { vi } from "vitest";
import { ModelModel } from "@/models";
import LimitModel from "@/models/limit";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { openaiAdapterFactory } from "../adapters/openai";
import * as proxyUtils from "../utils";
import openAiProxyRoutes from "./openai";

const DEFAULT_USAGE = { inputTokens: 100, outputTokens: 20 };

function createFastifyApp() {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

function createOpenAiHarness(options: { usage?: typeof DEFAULT_USAGE } = {}) {
  const usage = options.usage ?? DEFAULT_USAGE;

  return {
    client: {
      chat: {
        completions: {
          create: async (
            request: OpenAI.Chat.Completions.ChatCompletionCreateParams,
          ) => ({
            id: "chatcmpl-limit-test",
            object: "chat.completion",
            created: 1,
            model: request.model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant" as const,
                  content: "Mocked response",
                  refusal: null,
                },
                finish_reason: "stop" as const,
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
            },
          }),
        },
      },
    },
  };
}

const OPENAI_ENDPOINT = (agentId: string) =>
  `/v1/openai/${agentId}/chat/completions`;

const OPENAI_HEADERS = (authToken = "Bearer test-key") => ({
  Authorization: authToken,
  "Content-Type": "application/json",
});

const SIMPLE_PAYLOAD = (model = "gpt-4o") => ({
  model,
  messages: [{ role: "user", content: "Hello" }],
});

describe("LLM proxy limit enforcement (integration)", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) {
      await app.close();
    }
  });

  async function setupRoute(harnessOptions?: { usage?: typeof DEFAULT_USAGE }) {
    app = createFastifyApp();
    const harness = createOpenAiHarness(harnessOptions);
    vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
      () => harness.client as never,
    );
    // Suppress cost optimization to avoid DB lookups for models without pricing
    vi.spyOn(
      proxyUtils.costOptimization,
      "getOptimizedModel",
    ).mockResolvedValue(null);
    await app.register(openAiProxyRoutes);
    return harness;
  }

  test("blocks request with 429 when virtual_key limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "VK Limit Agent",
    });

    // Create a real virtual key with an OpenAI parent key
    const secret = await makeSecret({ secret: { apiKey: "sk-test-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { virtualKey, value: tokenValue } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Test VK for limit",
    });

    // Create virtual_key limit with threshold of 1
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKey.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(`Bearer ${tokenValue}`),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
      },
    });
  });

  test("blocks request with 429 when user limit is exceeded", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "User Limit Agent",
    });

    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "user",
      user.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({
      error: {
        code: "token_cost_limit_exceeded",
      },
    });
  });

  test("allows request when limits are not exceeded", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Under Limit Agent" });

    // Create agent limit with a very high threshold (1B tokens)
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: ["gpt-4o"],
    });

    // Ensure model exists for cost tracking
    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);
  });

  test("records usage in limit after successful request", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Usage Record Agent" });

    // Create agent limit with high threshold
    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: ["gpt-4o"],
    });

    // Ensure model exists for cost tracking
    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute({
      usage: { inputTokens: 500, outputTokens: 100 },
    });

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);

    // Verify usage was recorded in the limit
    const breakdown = await LimitModel.getModelUsageBreakdown(limit.id);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].model).toBe("gpt-4o");
    // Usage should be > 0 (exact amount depends on cost calculation,
    // but tokens should match what the mock returned)
    expect(breakdown[0].tokensIn).toBeGreaterThan(0);
    expect(breakdown[0].tokensOut).toBeGreaterThan(0);
  });

  test("blocks with most specific limit when multiple exist", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Multi-Limit Agent",
    });

    // Create a real virtual key
    const secret = await makeSecret({ secret: { apiKey: "sk-test-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { virtualKey, value: tokenValue } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "Multi-Limit VK",
    });

    // Create limits at all three levels — all exceeded
    // Virtual key limit (most specific)
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKey.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    // User limit
    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });
    await LimitModel.updateTokenLimitUsage(
      "user",
      user.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    // Agent limit
    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: {
        ...OPENAI_HEADERS(`Bearer ${tokenValue}`),
        "X-Archestra-User-Id": user.id,
      },
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    // virtual_key is checked first (most specific), so error should mention it
    expect(body.error.message).toContain("virtual_key-level");
  });
});
