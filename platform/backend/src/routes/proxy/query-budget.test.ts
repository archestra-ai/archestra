import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { LimitModel, ModelModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { recordQueries } from "@/test/query-counter";
import { ApiError } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import openAiProxyRoutes from "./routes/openai";

describe("LLM proxy query budget", () => {
  setupTestCacheManager();
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) =>
      reply.status(error instanceof ApiError ? error.statusCode : 500).send({
        error: {
          message: error instanceof Error ? error.message : String(error),
          type:
            error instanceof ApiError
              ? error.type
              : "api_internal_server_error",
        },
      }),
    );
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

  test("virtual-key chat completion with token limits", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const team = await makeTeam(org.id, user.id);
    await makeTeamMember(team.id, user.id);
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: { teams: [team.id], level: "use" },
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-budget" } });
    const providerKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { value: virtualKey, virtualKey: keyRow } =
      await VirtualApiKeyModel.create({
        organizationId: org.id,
        name: "budget-vk",
        scope: "personal",
        authorId: user.id,
        providerApiKeys: [
          { provider: providerKey.provider, providerApiKeyId: providerKey.id },
        ],
      });
    for (const [entityType, entityId] of [
      ["organization", org.id],
      ["team", team.id],
      ["agent", agent.id],
      ["user", user.id],
      ["virtual_key", keyRow.id],
    ] as const) {
      await LimitModel.create({
        entityType,
        entityId,
        limitType: "token_cost",
        limitValue: 1_000_000,
        model: null,
        cleanupInterval: "1w",
      });
    }

    const call = () =>
      app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        remoteAddress: "203.0.113.5",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${virtualKey}`,
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
        },
      });
    const warm = await call();
    expect(warm.statusCode, warm.body).toBe(200);
    const { result: response, statements } = await recordQueries(call);
    expect(response.statusCode, response.body).toBe(200);
    // Was 54 before the per-request lookups, set-based usage recording and
    // single-read rate-limit check.
    expect(statements.length).toBeLessThanOrEqual(45);
  });

  test("rejected virtual key under the rate limiter", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    const call = () =>
      app.inject({
        method: "POST",
        url: `/v1/openai/${agent.id}/chat/completions`,
        remoteAddress: "203.0.113.6",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer archestra_00000000000000000000000000000000",
        },
        payload: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
        },
      });
    const first = await call();
    expect(first.statusCode, first.body).toBe(401);
    const { result: response, statements } = await recordQueries(call);
    expect(response.statusCode).toBe(401);
    // One read and one atomic upsert; was two reads and two read-modify-writes.
    expect(
      statements.filter((statement) => statement.includes("keyv_cache")),
    ).toHaveLength(2);
  });
});
