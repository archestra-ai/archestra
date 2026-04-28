import { LlmProviderApiKeyModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PATCH /api/organization/memory-settings", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("updates memory settings for organization", async ({ makeSecret }) => {
    const secret = await makeSecret({ secret: { apiKey: "test-key" } });
    const apiKey = await LlmProviderApiKeyModel.create({
      organizationId,
      secretId: secret.id,
      name: "Memory extractor key",
      provider: "openai",
      scope: "personal",
      userId: user.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/memory-settings",
      payload: {
        memoryExtractionEnabled: true,
        memoryInjectionEnabled: true,
        memoryInjectionTopK: 12,
        memoryExtractorChatApiKeyId: apiKey.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      memoryExtractionEnabled: true,
      memoryInjectionEnabled: true,
      memoryInjectionTopK: 12,
      memoryExtractorChatApiKeyId: apiKey.id,
    });
  });

  test("returns 404 when extractor API key does not belong to org", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/memory-settings",
      payload: {
        memoryExtractorChatApiKeyId: "5d6f06bc-8488-45d1-adf5-0555f6c22f10",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("API key not found");
  });

  test("returns 400 on invalid payload constraints", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/memory-settings",
      payload: {
        memoryInjectionTopK: 1.5,
      },
    });

    expect(response.statusCode).toBe(400);
  });
});
