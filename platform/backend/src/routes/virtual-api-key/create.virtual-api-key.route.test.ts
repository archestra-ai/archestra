import { hasArchestraTokenPrefix } from "@archestra/shared";
import { vi } from "vitest";
import { LlmProviderApiKeyModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  userHasPermission: vi.fn(),
}));

import { userHasPermission } from "@/auth";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("POST /api/llm-virtual-keys", () => {
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

  test("per-user provider (github-copilot): allows a personal self-mapped virtual key", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "gho_self" } });
    const copilotKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
      scope: "personal",
      userId: user.id,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "My Copilot VK",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: copilotKey.id },
        ],
        scope: "personal",
        teams: [],
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("per-user provider: rejects org-scoped or model-router virtual keys containing it", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true); // allow org scope past the admin check
    const copilotSecret = await makeSecret({ secret: { apiKey: "gho_self" } });
    const copilotKey = await makeLlmProviderApiKey(
      organizationId,
      copilotSecret.id,
      { provider: "github-copilot", scope: "personal", userId: user.id },
    );
    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const openaiKey = await makeLlmProviderApiKey(
      organizationId,
      openaiSecret.id,
      { provider: "openai", scope: "org" },
    );

    // Org-scoped (shared) virtual key wrapping the per-user key → rejected
    const orgScoped = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Shared Copilot VK",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: copilotKey.id },
        ],
        scope: "org",
        teams: [],
      },
    });
    expect(orgScoped.statusCode).toBe(400);
    expect(orgScoped.json().error.message).toContain("per-user");

    // Multi-provider (model-router) bundle containing the per-user key → rejected
    const bundle = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Router VK",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: copilotKey.id },
          { provider: "openai", providerApiKeyId: openaiKey.id },
        ],
        scope: "personal",
        teams: [],
      },
    });
    expect(bundle.statusCode).toBe(400);
    expect(bundle.json().error.message).toContain("per-user");
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
