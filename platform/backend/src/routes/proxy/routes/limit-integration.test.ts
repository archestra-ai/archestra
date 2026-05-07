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
      organizationId: org.id,
      name: "Test VK for limit",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
      ],
    });

    // Create virtual_key limit with threshold of 1
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
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
      lastCleanup: new Date(),
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
      organizationId: org.id,
      name: "Multi-Limit VK",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
      ],
    });

    // Create limits at all three levels — all exceeded
    // Virtual key limit (most specific)
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
      lastCleanup: new Date(),
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
      lastCleanup: new Date(),
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
      lastCleanup: new Date(),
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

  test("records usage in team all-models limit after successful request", async ({
    makeAgent,
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Team All-Models Agent",
      teams: [team.id],
      scope: "team",
    });

    // Create team-level all-models limit (model: null)
    const teamLimit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: null,
    });

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

    // Tick to let background update run
    // TODO: if calls to InteractionModel.updateUsageAfterInteraction change might want to change the test as well
    await new Promise((resolve) => setTimeout(resolve, 200));

    // BUG REPRODUCTION: team all-models limit usage should be updated
    const teamUsage = await LimitModel.getModelUsageBreakdown(teamLimit.id);
    expect(teamUsage).toHaveLength(1);
    expect(teamUsage[0].model).toBe("gpt-4o");
    expect(teamUsage[0].tokensIn).toBe(500);
    expect(teamUsage[0].tokensOut).toBe(100);
  });

  test("records usage in team all-models limit when agent has multiple teams", async ({
    makeAgent,
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
    const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Multi-Team All-Models Agent",
      teams: [team1.id, team2.id],
      scope: "team",
    });

    // Create all-models limit on team1 ONLY
    const team1Limit = await LimitModel.create({
      entityType: "team",
      entityId: team1.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: null,
    });

    // Create specific-model limit on team2
    const team2Limit = await LimitModel.create({
      entityType: "team",
      entityId: team2.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: ["gpt-4o"],
    });

    // Also create org and user limits to verify they update (control group)
    const orgLimit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1_000_000_000,
      model: null,
    });

    await ModelModel.ensureModelExists("gpt-4o", "openai");

    await setupRoute({
      usage: { inputTokens: 300, outputTokens: 60 },
    });

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(200);

    // Tick to let background update run
    // TODO: if calls to InteractionModel.updateUsageAfterInteraction change might want to change the test as well
    await new Promise((resolve) => setTimeout(resolve, 200));

    // BUG REPRODUCTION: team1 all-models limit usage must be updated
    const team1Usage = await LimitModel.getModelUsageBreakdown(team1Limit.id);
    expect(team1Usage).toHaveLength(1);
    expect(team1Usage[0].model).toBe("gpt-4o");
    expect(team1Usage[0].tokensIn).toBe(300);
    expect(team1Usage[0].tokensOut).toBe(60);

    // team2 specific-model limit should also be updated
    const team2Usage = await LimitModel.getModelUsageBreakdown(team2Limit.id);
    expect(team2Usage).toHaveLength(1);
    expect(team2Usage[0].tokensIn).toBe(300);
    expect(team2Usage[0].tokensOut).toBe(60);

    // org all-models limit should be updated (control — user confirmed this works)
    const orgUsage = await LimitModel.getModelUsageBreakdown(orgLimit.id);
    expect(orgUsage).toHaveLength(1);
    expect(orgUsage[0].model).toBe("gpt-4o");
    expect(orgUsage[0].tokensIn).toBe(300);
    expect(orgUsage[0].tokensOut).toBe(60);
  });

  test("blocks request with 429 when team all-models limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeAdmin,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeAdmin();
    await makeMember(admin.id, org.id, { role: "admin" });
    const team = await makeTeam(org.id, admin.id);
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Team All-Models Blocked Agent",
      teams: [team.id],
      scope: "team",
    });

    // Create team all-models limit with threshold of 1
    await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "team",
      team.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    expect(body.error.message).toContain("team-level");
  });

  test("blocks request with 429 when user all-models limit is exceeded", async ({
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
      name: "User All-Models Limit Agent",
    });

    // Create user all-models limit (model: null) with threshold of 1
    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "user",
      user.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
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
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    expect(body.error.message).toContain("user-level");
  });

  test("blocks request with 429 when virtual_key all-models limit is exceeded", async ({
    makeAgent,
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      name: "VK All-Models Limit Agent",
    });

    // Create a real virtual key with an OpenAI parent key
    const secret = await makeSecret({ secret: { apiKey: "sk-test-key" } });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { virtualKey, value: tokenValue } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "Test VK for all-models limit",
      providerApiKeys: [
        { provider: "openai", providerApiKeyId: chatApiKey.id },
      ],
    });

    // Create virtual_key all-models limit (model: null) with threshold of 1
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: virtualKey.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
      lastCleanup: new Date(),
    });

    // Pre-populate usage to exceed limit
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      virtualKey.id,
      "gpt-4o",
      1_000_000,
      1_000_000,
    );

    await setupRoute();

    const response = await app.inject({
      method: "POST",
      url: OPENAI_ENDPOINT(agent.id),
      headers: OPENAI_HEADERS(`Bearer ${tokenValue}`),
      payload: SIMPLE_PAYLOAD(),
    });

    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.error.code).toBe("token_cost_limit_exceeded");
    expect(body.error.message).toContain("virtual_key-level");
  });
});
