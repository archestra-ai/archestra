import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("PATCH /api/llm-virtual-keys/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(false);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-key.routes"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("PATCH /api/llm-virtual-keys/:id updates the name and provider mappings without re-exposing the token", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI Parent",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "before-rename",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const id = createResponse.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${id}`,
      payload: {
        name: "after-rename",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(id);
    expect(body.name).toBe("after-rename");
    expect(body.value).toBeUndefined();
    expect(body.providerApiKeys).toEqual([
      {
        provider: "openai",
        providerApiKeyId: parentKey.id,
        providerApiKeyName: "OpenAI Parent",
      },
    ]);
  });

  test("PATCH /api/llm-virtual-keys/:id returns 404 for an unknown key", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/llm-virtual-keys/00000000-0000-0000-0000-000000000000",
      payload: {
        name: "ghost",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { message: "Virtual API key not found" },
    });
  });

  test("PATCH /api/llm-virtual-keys/:id rejects past expiration dates", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "expiry-target",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${createResponse.json().id}`,
      payload: {
        name: "expiry-target",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { message: "Expiration date must be in the future" },
    });
  });
});
