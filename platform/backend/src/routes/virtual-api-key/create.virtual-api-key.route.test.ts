import { hasArchestraTokenPrefix } from "@archestra/shared";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { ResourcePermissions } from "@/services/resource-permissions";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { userHasPermission } from "@/auth";
import { grantEverywhere } from "@/test/wildcard-grants";

const mockUserHasPermission = vi.mocked(userHasPermission);

describe("POST /api/llm-virtual-keys", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization({ legacyPermissions: true });
    organizationId = organization.id;
    user = await makeUser();
    // Grants resolve subjects through membership; a non-member reaches no
    // shared provider key.
    await makeMember(user.id, organizationId);
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

  test("per-user provider (github-copilot): allows a personal self-mapped virtual key", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "gho_self" } });
    const copilotKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
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
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("per-user provider: rejects a virtual key shared with the organization", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);
    const copilotSecret = await makeSecret({ secret: { apiKey: "gho_self" } });
    const copilotKey = await makeLlmProviderApiKey(
      organizationId,
      copilotSecret.id,
      { provider: "github-copilot", userId: user.id },
    );

    const orgScoped = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Shared Copilot VK",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: copilotKey.id },
        ],
        initialGrants: [
          { subject: { type: "organization", id: "*" }, actions: ["use"] },
        ],
      },
    });
    expect(orgScoped.statusCode).toBe(400);
    expect(orgScoped.json().error.message).toContain(
      "Personal account credentials cannot be shared",
    );
  });

  test("per-user provider: allows it alongside other providers in a personal model-router key", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    // An unshared key — not mapping count — is what keeps the token private, so
    // a Copilot key may ride in the owner's own multi-provider router key. That
    // is the point of the router: one endpoint reaching every provider.
    const copilotSecret = await makeSecret({ secret: { apiKey: "gho_self" } });
    const copilotKey = await makeLlmProviderApiKey(
      organizationId,
      copilotSecret.id,
      { provider: "github-copilot", userId: user.id },
    );
    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const openaiKey = await makeLlmProviderApiKey(
      organizationId,
      openaiSecret.id,
      { provider: "openai" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Router VK",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: copilotKey.id },
          { provider: "openai", providerApiKeyId: openaiKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("per-user provider: rejects another user's key in a personal model-router key", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
  }) => {
    // Ownership is the check that carries the weight once mapping count no
    // longer does: a personal router key may not wrap someone else's token.
    const otherUser = await makeUser({ email: "someone-else@test.com" });
    const copilotSecret = await makeSecret({ secret: { apiKey: "gho_other" } });
    const otherCopilotKey = await makeLlmProviderApiKey(
      organizationId,
      copilotSecret.id,
      { provider: "github-copilot", userId: otherUser.id },
    );
    const openaiSecret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const openaiKey = await makeLlmProviderApiKey(
      organizationId,
      openaiSecret.id,
      { provider: "openai" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Borrowed Copilot Router VK",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: otherCopilotKey.id },
          { provider: "openai", providerApiKeyId: openaiKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "your own personal github-copilot key",
    );
  });

  test("ChatGPT-subscription (Codex) openai key: rejected in a virtual key shared with the organization", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    // A codex credential lives on the `openai` provider but is one person's
    // ChatGPT account, so it must get the same per-user treatment as Copilot.
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);
    const codexSecret = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "rt_self",
          accountId: "acc_self",
        }),
      },
    });
    const codexKey = await makeLlmProviderApiKey(
      organizationId,
      codexSecret.id,
      { provider: "openai", userId: user.id },
    );

    const orgScoped = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Shared ChatGPT VK",
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: codexKey.id },
        ],
        initialGrants: [
          { subject: { type: "organization", id: "*" }, actions: ["use"] },
        ],
      },
    });
    expect(orgScoped.statusCode).toBe(400);
    expect(orgScoped.json().error.message).toContain(
      "Personal account credentials cannot be shared",
    );
  });

  test("POST /api/llm-virtual-keys lets llmVirtualKey admins share with any team", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeTeam,
    makeUser,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

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
        initialGrants: [
          {
            subject: { type: "team", id: otherTeam.id },
            actions: ["read", "use"],
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "llmVirtualKey",
      scope: response.json().id,
    });
    expect(policy?.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "team", id: otherTeam.id },
        }),
      ]),
    );
  });

  test("POST /api/llm-virtual-keys returns the full token value once", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

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
    grantEverywhere(["llmVirtualKey"]);

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
    grantEverywhere(["llmVirtualKey"]);

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
    grantEverywhere(["llmVirtualKey"]);

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
    grantEverywhere(["llmVirtualKey"]);

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
    grantEverywhere(["llmVirtualKey"]);

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

  test("POST /api/llm-virtual-keys supports keyless parent keys", async ({
    makeLlmProviderApiKey,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

    const parentKey = await makeLlmProviderApiKey(organizationId, null, {
      name: "Keyless Parent",
      provider: "ollama",
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
    grantEverywhere(["llmVirtualKey"]);

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

  test("admin can create a personal key on behalf of another member", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
    makeMember,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const target = await makeUser();
    await makeMember(target.id, organizationId);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Key for member",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        ownerId: target.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().authorId).toBe(target.id);
  });

  test("non-admins cannot create a key on behalf of another user", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
    makeMember,
  }) => {
    mockUserHasPermission.mockResolvedValue(false);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const target = await makeUser();
    await makeMember(target.id, organizationId);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Key for member",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        ownerId: target.id,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain(
      "llmVirtualKey:admin permission to create a virtual key for another user",
    );
  });

  test("admins cannot assign ownership to a non-member", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const outsider = await makeUser();

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Key for outsider",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        ownerId: outsider.id,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain(
      "User is not a member of this organization",
    );
  });

  test("defaults ownership to the creator when ownerId is omitted", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(false);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "My own key",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().authorId).toBe(user.id);
  });

  test("non-admins may pass their own id as ownerId", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    mockUserHasPermission.mockResolvedValue(false);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "My own key",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        ownerId: user.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().authorId).toBe(user.id);
  });

  test("admins cannot assign ownership to a member of another organization", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const otherOrg = await makeOrganization();
    const outsider = await makeUser();
    await makeMember(outsider.id, otherOrg.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Cross-org key",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        ownerId: outsider.id,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain(
      "User is not a member of this organization",
    );
  });

  test("passthrough: creates a personal key", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: { name: "PT empty", keyType: "passthrough" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.keyType).toBe("passthrough");
    expect(body.scope).toBe("personal");
    expect(body.authorId).toBe(user.id);
    expect(body.providerApiKeys).toEqual([]);
    expect(body.allowedLlmProxies).toBeUndefined();
    expect(hasArchestraTokenPrefix(body.value)).toBe(true);
  });

  test("passthrough: rejects mapping provider API keys", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "PT with provider",
        keyType: "passthrough",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("passthrough: admin can create on behalf of another user", async ({
    makeUser,
    makeMember,
  }) => {
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "PT for owner",
        keyType: "passthrough",
        ownerId: owner.id,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.keyType).toBe("passthrough");
    expect(body.authorId).toBe(owner.id);
  });
});

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
describe("scoped virtual key grants", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    mockUserHasPermission.mockReset();
    mockUserHasPermission.mockResolvedValue(true);
    grantEverywhere(["llmVirtualKey"]);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user });
    });
    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-key.routes"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("shares a virtual key with a named user at creation", async ({
    makeLlmProviderApiKey,
    makeMember,
    makeSecret,
    makeUser,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const recipient = await makeUser();
    await makeMember(recipient.id, organizationId);
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId);

    const grants = [
      {
        subject: { type: "user" as const, id: recipient.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Shared at creation",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;

    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId,
          resource: "llmVirtualKey",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      {
        subject: { type: "user", id: user.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);

    const scoped = {
      organizationId,
      resource: "llmVirtualKey" as const,
      scope: id,
    };
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: recipient.id,
        })
      ).grants.map((grant) => grant.action),
    ).toEqual(["read", "use"]);
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: outsider.id,
        })
      ).grants,
    ).toEqual([]);
    user = recipient;
    expect(
      (await app.inject({ method: "GET", url: `/api/llm-virtual-keys/${id}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/llm-virtual-keys/${id}/value`,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/llm-virtual-keys/${id}`,
          payload: {
            name: "Not allowed",
            providerApiKeys: [
              { provider: parentKey.provider, providerApiKeyId: parentKey.id },
            ],
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/llm-virtual-keys/${id}`,
        })
      ).statusCode,
    ).toBe(403);
    user = outsider;
    expect(
      (await app.inject({ method: "GET", url: `/api/llm-virtual-keys/${id}` }))
        .statusCode,
    ).toBe(404);
  });
  test("rejects private provider mapping and sharing a personal subscription or passthrough credential", async ({
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const recipient = await makeUser();
    await makeMember(recipient.id, organizationId);
    const grants = [
      { subject: { type: "user", id: recipient.id }, actions: ["read", "use"] },
    ];
    user = await makeUser();
    await makeMember(user.id, organizationId);
    const secret = await makeSecret({ secret: { apiKey: "gho_private" } });
    const privateKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      userId: recipient.id,
    });
    const privateMapping = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "Invalid private mapping",
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: privateKey.id },
        ],
      },
    });
    expect(privateMapping.statusCode).toBe(403);
    const subscription = await makeLlmProviderApiKey(
      organizationId,
      secret.id,
      { provider: "github-copilot", userId: user.id },
    );
    for (const body of [
      {
        keyType: "standard",
        providerApiKeys: [
          { provider: "github-copilot", providerApiKeyId: subscription.id },
        ],
      },
      { keyType: "passthrough", providerApiKeys: [] },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/llm-virtual-keys",
        payload: {
          name: "Invalid shared credential",
          initialGrants: grants,
          ...body,
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error.message).toContain("cannot be shared");
    }
  });
});
// SPDX-SnippetEnd
