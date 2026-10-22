import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/model-pools", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: modelPoolRoutes } = await import("./model-pool.routes");
    await app.register(modelPoolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates a pool of shared keys and lists it", async ({
    makeLlmProviderApiKey,
  }) => {
    const first = await makeLlmProviderApiKey(organizationId, null);
    const second = await makeLlmProviderApiKey(organizationId, null);

    const created = await app.inject({
      method: "POST",
      url: "/api/model-pools",
      payload: {
        name: "haiku",
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
        members: [
          { providerApiKeyId: first.id },
          { providerApiKeyId: second.id, priority: 2, weight: 3 },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(200);

    const listed = await app.inject({ method: "GET", url: "/api/model-pools" });
    expect(listed.json()).toMatchObject([
      {
        name: "haiku",
        members: [
          { providerApiKeyId: first.id, priority: 1, weight: 1, enabled: true },
          {
            providerApiKeyId: second.id,
            priority: 2,
            weight: 3,
            enabled: true,
          },
        ],
      },
    ]);
  });

  test("rejects a personal key and a key for another provider", async ({
    makeLlmProviderApiKey,
  }) => {
    const shared = await makeLlmProviderApiKey(organizationId, null);
    const personal = await makeLlmProviderApiKey(organizationId, null, {
      userId: user.id,
    });
    const openai = await makeLlmProviderApiKey(organizationId, null, {
      provider: "openai",
    });

    for (const member of [personal, openai]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/model-pools",
        payload: {
          name: "haiku",
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          members: [
            { providerApiKeyId: shared.id },
            { providerApiKeyId: member.id },
          ],
        },
      });
      expect(response.statusCode, response.body).toBe(400);
    }
  });
});
