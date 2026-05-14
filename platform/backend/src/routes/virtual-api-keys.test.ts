import { hasArchestraTokenPrefix } from "@shared";
import { vi } from "vitest";
import { LlmProviderApiKeyModel } from "@/models";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("virtualApiKeysRoutes", () => {
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
      "./virtual-api-keys"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("GET /api/llm-virtual-keys returns only virtual keys visible to the current user", async ({
    makeLlmProviderApiKey,
    makeOrganization,
    makeSecret,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const owner = user;
    const outsider = await makeUser();
    const outsiderOrg = await makeOrganization();
    const team = await makeTeam(organizationId, owner.id, {
      name: "Platform Team",
    });
    const outsiderTeam = await makeTeam(organizationId, outsider.id, {
      name: "Other Team",
    });
    await makeTeamMember(team.id, owner.id);
    await makeTeamMember(outsiderTeam.id, outsider.id);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const outsiderSecret = await makeSecret({ secret: { apiKey: "sk-other" } });
    const outsiderOrgKey = await makeLlmProviderApiKey(
      outsiderOrg.id,
      outsiderSecret.id,
    );

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "Org Visible",
      scope: "org",
      authorId: owner.id,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "My Personal",
      scope: "personal",
      authorId: owner.id,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "Other Personal",
      scope: "personal",
      authorId: outsider.id,
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "Team Visible",
      scope: "team",
      authorId: owner.id,
      teamIds: [team.id],
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "Other Team Key",
      scope: "team",
      authorId: outsider.id,
      teamIds: [outsiderTeam.id],
    });
    await VirtualApiKeyModel.create({
      providerApiKeys: [
        {
          provider: outsiderOrgKey.provider,
          providerApiKeyId: outsiderOrgKey.id,
        },
      ],
      name: "Different Org Key",
      scope: "org",
      authorId: outsider.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys",
    });

    expect(response.statusCode).toBe(200);
    const responseBody = response.json();
    const names = responseBody.data.map((item: { name: string }) => item.name);
    expect(names).toEqual(
      expect.arrayContaining(["Org Visible", "My Personal", "Team Visible"]),
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "Other Personal",
        "Other Team Key",
        "Different Org Key",
      ]),
    );
  });

  test("GET /api/llm-virtual-keys includes org-scoped keys for llmVirtualKey admins", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
      name: "Admin Visible",
      scope: "org",
      authorId: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Admin Visible", scope: "org" }),
      ]),
    );
  });

  test("POST /api/llm-virtual-keys rejects org scope without llmVirtualKey admin", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Org Key",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        scope: "org",
        teams: [],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        message:
          "You need llmVirtualKey:admin permission to create org-scoped virtual keys",
      },
    });
  });

  test("POST /api/llm-virtual-keys allows llmVirtualKey admins to assign any team", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeTeam,
    makeUser,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const otherOwner = await makeUser();
    const otherTeam = await makeTeam(organizationId, otherOwner.id, {
      name: "Other Team",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Team Key",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        scope: "team",
        teams: [otherTeam.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Team Key",
      scope: "team",
      teams: [expect.objectContaining({ id: otherTeam.id })],
    });
  });

  test("POST /api/llm-virtual-keys returns the full token value once", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "my-test-key",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(hasArchestraTokenPrefix(body.value)).toBe(true);
    expect(body.id).toBeTruthy();
    expect(body.name).toBe("my-test-key");
    expect(body.tokenStart).toBe(body.value.substring(0, 14));
    expect(body.createdAt).toBeTruthy();
    expect(body.expiresAt).toBeNull();
    expect(body.lastUsedAt).toBeNull();
  });

  test("POST /api/llm-virtual-keys stores model router provider mappings", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const anthropicSecret = await makeSecret({
      secret: { apiKey: "sk-anthropic" },
    });
    const openaiKey = await makeLlmProviderApiKey(
      organizationId,
      openaiSecret.id,
      { provider: "openai", name: "OpenAI Parent" },
    );
    const anthropicKey = await makeLlmProviderApiKey(
      organizationId,
      anthropicSecret.id,
      { provider: "anthropic", name: "Anthropic Parent" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "router-key",
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: openaiKey.id },
          { provider: "anthropic", providerApiKeyId: anthropicKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerApiKeys: expect.arrayContaining([
        {
          provider: "openai",
          providerApiKeyId: openaiKey.id,
          providerApiKeyName: "OpenAI Parent",
        },
        {
          provider: "anthropic",
          providerApiKeyId: anthropicKey.id,
          providerApiKeyName: "Anthropic Parent",
        },
      ]),
    });
  });

  test("POST /api/llm-virtual-keys creates a key with provider mappings", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const openaiKey = await makeLlmProviderApiKey(
      organizationId,
      openaiSecret.id,
      { provider: "openai", name: "OpenAI Router Key" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "parentless-router-key",
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: openaiKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "parentless-router-key",
      organizationId,
      providerApiKeys: [
        {
          provider: "openai",
          providerApiKeyId: openaiKey.id,
          providerApiKeyName: "OpenAI Router Key",
        },
      ],
    });
  });

  test("POST /api/llm-virtual-keys rejects keys without provider mappings", async () => {
    mockUserHasPermission.mockResolvedValue(true);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "missing-parent",
        providerApiKeys: [],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      "At least one provider API key is required",
    );
  });

  test("POST /api/llm-virtual-keys rejects duplicate model router provider mappings", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const firstSecret = await makeSecret({ secret: { apiKey: "sk-first" } });
    const secondSecret = await makeSecret({ secret: { apiKey: "sk-second" } });
    const firstKey = await makeLlmProviderApiKey(
      organizationId,
      firstSecret.id,
      { provider: "openai", name: "First OpenAI" },
    );
    const secondKey = await makeLlmProviderApiKey(
      organizationId,
      secondSecret.id,
      { provider: "openai", name: "Second OpenAI" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "router-key",
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: firstKey.id },
          { provider: "openai", providerApiKeyId: secondKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      'Only one provider API key can be mapped for provider "openai"',
    );
  });

  test("POST /api/llm-virtual-keys rejects provider mismatches in model router mappings", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const openaiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI Parent",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "router-key",
        providerApiKeys: [
          { provider: "anthropic", providerApiKeyId: openaiKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain(
      'is for provider "openai", not "anthropic"',
    );
  });

  test("GET /api/llm-virtual-keys?providerApiKeyId lists keys without exposing token values", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });
    const otherParentKey = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      {
        provider: "anthropic",
      },
    );

    const firstResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "key-alpha",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });
    const secondResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "key-beta",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    const otherResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "key-gamma",
        providerApiKeys: [
          {
            provider: otherParentKey.provider,
            providerApiKeyId: otherParentKey.id,
          },
        ],
      },
    });
    expect(otherResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys?providerApiKeyId=${parentKey.id}`,
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.pagination.total).toBe(2);
    const body = json.data as Array<{
      id: string;
      name: string;
      tokenStart: string;
      value?: string;
    }>;
    expect(body).toHaveLength(2);
    expect(body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: firstResponse.json().id,
          name: "key-alpha",
        }),
        expect.objectContaining({
          id: secondResponse.json().id,
          name: "key-beta",
        }),
      ]),
    );
    expect(body).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: otherResponse.json().id,
          name: "key-gamma",
        }),
      ]),
    );
    for (const key of body) {
      expect(key.value).toBeUndefined();
      expect(key.tokenStart).toBeTruthy();
    }
  });

  test("GET /api/llm-virtual-keys returns paginated provider key metadata", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      name: "Org Listing Parent",
      provider: "openai",
    });

    await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "org-list-key-1",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "org-list-key-2",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys?limit=50&offset=0",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{
        name: string;
        providerApiKeys: Array<{
          provider: string;
          providerApiKeyId: string;
          providerApiKeyName: string;
        }>;
      }>;
      pagination: {
        total: number;
        currentPage: number;
        totalPages: number;
        limit: number;
        hasNext: boolean;
        hasPrev: boolean;
      };
    };
    const listedKeys = body.data.filter((key) =>
      key.providerApiKeys.some(
        (mapping) => mapping.providerApiKeyName === "Org Listing Parent",
      ),
    );
    expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    expect(listedKeys).toHaveLength(2);
    for (const key of listedKeys) {
      expect(key.providerApiKeys).toEqual([
        {
          provider: "openai",
          providerApiKeyId: parentKey.id,
          providerApiKeyName: "Org Listing Parent",
        },
      ]);
    }
  });

  test("GET /api/llm-virtual-keys lists mapped provider keys", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const openaiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI Router Key",
    });

    await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "router-only-list-key",
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: openaiKey.id },
        ],
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/llm-virtual-keys?limit=50&offset=0",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "router-only-list-key",
          providerApiKeys: [
            {
              provider: "openai",
              providerApiKeyId: openaiKey.id,
              providerApiKeyName: "OpenAI Router Key",
            },
          ],
        }),
      ]),
    );
  });

  test("DELETE /api/llm-virtual-keys/:id removes the key", async ({
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
        name: "delete-me",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(createResponse.statusCode).toBe(200);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-virtual-keys/${createResponse.json().id}`,
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/llm-virtual-keys?providerApiKeyId=${parentKey.id}`,
    });

    expect(listResponse.statusCode).toBe(200);
    expect(
      listResponse
        .json()
        .data.map((key: { id: string }) => key.id)
        .includes(createResponse.json().id),
    ).toBe(false);
  });

  test("POST /api/llm-virtual-keys supports keyless parent keys", async () => {
    mockUserHasPermission.mockResolvedValue(true);

    const parentKey = await LlmProviderApiKeyModel.create({
      organizationId,
      secretId: null,
      name: "Keyless Parent",
      provider: "ollama",
      scope: "org",
      userId: null,
      teamId: null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "vk-for-keyless",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(hasArchestraTokenPrefix(body.value)).toBe(true);
    expect(body.name).toBe("vk-for-keyless");
  });

  test("POST /api/llm-virtual-keys rejects past expiration dates", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "expired-from-the-start",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        message: "Expiration date must be in the future",
      },
    });
  });
});
