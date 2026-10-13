import {
  ARCHESTRA_TOKEN_PREFIX,
  LEGACY_ARCHESTRA_TOKEN_PREFIXES,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { vi } from "vitest";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import db from "@/database";
import {
  AgentLabelModel,
  AgentModel,
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  VirtualApiKeyModel,
} from "@/models";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
import { accessGrants, afterEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { ApiError } from "@/types";
import {
  assertAuthenticatedForKeylessProvider,
  assertConsistentUserCredentials,
  attemptJwksAuth,
  resolveAgent,
  VirtualKeyRateLimiter,
  validatePassthroughVirtualKey,
  validateVirtualApiKey,
} from "./llm-proxy-auth";

// =========================================================================
// resolveAgent
// =========================================================================

describe("resolveAgent", () => {
  test("returns a non-proxy agent unchanged (chat/app attribution)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "test-agent", agentType: "agent" });

    const result = await resolveAgent(agent.id);
    expect(result.id).toBe(agent.id);
    expect(result.name).toBe("test-agent");
  });

  test("throws 404 when agent ID does not exist", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(resolveAgent(fakeId)).rejects.toThrow(
      `Agent with ID ${fakeId} not found`,
    );
  });

  test("collapses an llm_proxy id to the organization's LLM Proxy", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const proxy = await AgentModel.getOrgLlmProxy(org.id);
    const legacy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      name: "old-proxy",
    });

    const result = await resolveAgent(legacy.id);
    expect(result.id).toBe(proxy.id);
    expect(result.agentType).toBe("llm_proxy");
  });

  test("collapses a legacy profile id to the organization's LLM Proxy", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const profile = await makeAgent({
      organizationId: org.id,
      agentType: "profile",
      isDefault: true,
    });

    const result = await resolveAgent(profile.id);
    expect(result.agentType).toBe("llm_proxy");
    expect(result.organizationId).toBe(org.id);
    expect(result.isDefault).toBe(true);
  });

  test("no agent id resolves THE LLM Proxy, creating it on demand", async ({
    makeOrganization,
  }) => {
    await makeOrganization();

    const result = await resolveAgent(undefined);
    expect(result.agentType).toBe("llm_proxy");
    expect(result.isDefault).toBe(true);
    expect(result.name).toBe("LLM Proxy");
  });

  // The proxy resolves a lean GatewayAgent (agents row + labels): labels feed
  // metric/span label values, so they must survive the lean lookup.
  test("resolved agent carries its labels", async ({ makeAgent }) => {
    const agent = await makeAgent();
    await AgentLabelModel.syncAgentLabels(agent.id, [
      { key: "environment", value: "production", keyId: "", valueId: "" },
    ]);

    const result = await resolveAgent(agent.id);
    expect(result.labels).toEqual([
      expect.objectContaining({ key: "environment", value: "production" }),
    ]);
  });
});

// =========================================================================
// validateVirtualApiKey
// =========================================================================

describe("validateVirtualApiKey", () => {
  test("throws 401 for invalid/non-existent token", async () => {
    await expect(
      validateVirtualApiKey({
        tokenValue: `${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}nonexistent`,
        expectedProvider: "openai",
        expectedOrganizationId: null,
      }),
    ).rejects.toThrow("Invalid virtual API key");
  });

  test("throws 400 when a passthrough key is used in the Authorization header", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "pt",
      keyType: "passthrough",
      authorId: owner.id,
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "openai",
        expectedOrganizationId: null,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  test("throws 401 for expired key", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-provider-key" },
    });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "expired-key",
      expiresAt: new Date("2020-01-01"),
      ...accessGrants("org"),
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "openai",
        expectedOrganizationId: null,
      }),
    ).rejects.toThrow("Virtual API key expired");
  });

  test("throws 400 for provider mismatch", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-provider-key" },
    });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "openai-key",
      ...accessGrants("org"),
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "anthropic",
        expectedOrganizationId: null,
      }),
    ).rejects.toThrow('Virtual API key is not mapped to provider "anthropic".');
  });

  test("rejects a foreign subscription marker immediately after virtual-key resolution", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: {
        apiKey: encodeXaiSubscriptionCredential({
          refreshToken: "rt-never-forward",
          userId: "x-user",
        }),
      },
    });
    const openaiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [{ provider: "openai", providerApiKeyId: openaiKey.id }],
      name: "out-of-band-swapped-marker",
      ...accessGrants("org"),
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "openai",
        expectedOrganizationId: null,
      }),
    ).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  test("rejects a Bearer-wrapped subscription in a legacy shared virtual key", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({
      secret: {
        apiKey: `bEaReR ${encodeXaiSubscriptionCredential({
          refreshToken: "rt-never-share",
          userId: "x-user",
        })}`,
      },
    });
    const xaiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "xai",
      userId: owner.id,
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      providerApiKeys: [{ provider: "xai", providerApiKeyId: xaiKey.id }],
      name: "legacy-shared-x-premium",
      authorId: owner.id,
      ...accessGrants("org"),
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "xai",
        expectedOrganizationId: null,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  test("returns resolved API key and baseUrl on success", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-provider-key" },
    });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "valid-key",
      ...accessGrants("org"),
    });

    const result = await validateVirtualApiKey({
      tokenValue: value,
      expectedProvider: "openai",
      expectedOrganizationId: null,
    });
    expect(result.apiKey).toBe("sk-real-provider-key");
    expect(result.baseUrl).toBeUndefined();
  });

  test("per-user provider: allows a personal virtual key self-mapped to the owner's own key", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "gho_owner" } });
    const copilotKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "github-copilot",
      userId: user.id,
    });

    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "my-copilot-vk",
      authorId: user.id,
      providerApiKeys: [
        { provider: "github-copilot", providerApiKeyId: copilotKey.id },
      ],
    });

    const result = await validateVirtualApiKey({
      tokenValue: value,
      expectedProvider: "github-copilot",
      expectedOrganizationId: null,
    });
    expect(result.apiKey).toBe("gho_owner");
  });

  test("per-user provider: rejects an org-scoped (legacy/shared) virtual key at runtime", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "gho_owner" } });
    const copilotKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "github-copilot",
      userId: user.id,
    });

    // Simulate a virtual key created before enforcement: org scope wrapping a
    // per-user key. The runtime guard must refuse to hand out the token.
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "legacy-shared-copilot-vk",
      authorId: user.id,
      providerApiKeys: [
        { provider: "github-copilot", providerApiKeyId: copilotKey.id },
      ],
      ...accessGrants("org"),
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "github-copilot",
        expectedOrganizationId: null,
      }),
    ).rejects.toThrow(/per-user/);
  });

  test("returns baseUrl when chat API key has one configured", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-key" },
    });
    const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });

    // Update the chat API key with a baseUrl
    const { LlmProviderApiKeyModel } = await import("@/models");
    await LlmProviderApiKeyModel.update(chatApiKey.id, {
      baseUrl: "https://custom-openai.example.com/v1",
    });

    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      name: "key-with-base-url",
      ...accessGrants("org"),
    });

    const result = await validateVirtualApiKey({
      tokenValue: value,
      expectedProvider: "openai",
      expectedOrganizationId: null,
    });
    expect(result.apiKey).toBe("sk-real-key");
    expect(result.baseUrl).toBe("https://custom-openai.example.com/v1");
  });

  test("returns undefined apiKey when provider key has no secretId", async ({
    makeOrganization,
  }) => {
    const { LlmProviderApiKeyModel } = await import("@/models");
    const org = await makeOrganization();
    const systemKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "OpenAI system key",
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: systemKey.provider, providerApiKeyId: systemKey.id },
      ],
      name: "virtual-for-system-openai-key",
      ...accessGrants("org"),
    });

    const result = await validateVirtualApiKey({
      tokenValue: value,
      expectedProvider: "openai",
      expectedOrganizationId: null,
    });
    expect(result.apiKey).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
  });

  test("returns undefined apiKey for system key (no secret) without throwing", async ({
    makeOrganization,
  }) => {
    const { LlmProviderApiKeyModel } = await import("@/models");
    const org = await makeOrganization();

    const systemKey = await LlmProviderApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "Vertex AI",
      provider: "gemini",
    });

    const { value } = await VirtualApiKeyModel.create({
      providerApiKeys: [
        { provider: systemKey.provider, providerApiKeyId: systemKey.id },
      ],
      name: "virtual-for-system-key",
      ...accessGrants("org"),
    });

    const result = await validateVirtualApiKey({
      tokenValue: value,
      expectedProvider: "gemini",
      expectedOrganizationId: null,
    });
    expect(result.apiKey).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
  });

  test("throws 403 when the key belongs to another organization", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const keyOrg = await makeOrganization();
    const otherOrg = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-org-guard" } });
    const chatApiKey = await makeLlmProviderApiKey(keyOrg.id, secret.id, {
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: keyOrg.id,
      name: "org-guard-vk",
      providerApiKeys: [
        { provider: chatApiKey.provider, providerApiKeyId: chatApiKey.id },
      ],
      ...accessGrants("org"),
    });

    await expect(
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "openai",
        expectedOrganizationId: otherOrg.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("picks the mapped endpoint that serves the requested model", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const endpoints = [];
    // Sequential: the fallback below is the oldest key, so creation order
    // matters.
    for (const { modelId, apiKey, baseUrl } of [
      { modelId: "glm-5.3", apiKey: "sk-glm", baseUrl: "https://glm.test" },
      {
        modelId: "deepseek-v4.1-flash",
        apiKey: "sk-deepseek",
        baseUrl: "https://deepseek.test",
      },
    ]) {
      const model = await ModelModel.upsert({
        externalId: `vllm/${modelId}`,
        provider: "vllm",
        modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
        lastSyncedAt: new Date(),
      });
      const secret = await makeSecret({ secret: { apiKey } });
      const key = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "vllm",
        baseUrl,
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);
      endpoints.push(key);
    }
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "two-endpoint-vk",
      providerApiKeys: endpoints.map((key) => ({
        provider: "vllm" as const,
        providerApiKeyId: key.id,
      })),
      ...accessGrants("org"),
    });
    const validate = (requestedModel: string | null) =>
      validateVirtualApiKey({
        tokenValue: value,
        expectedProvider: "vllm",
        expectedOrganizationId: org.id,
        requestedModel,
      });

    expect(await validate("deepseek-v4.1-flash")).toMatchObject({
      apiKey: "sk-deepseek",
      baseUrl: "https://deepseek.test",
      chatApiKeyId: endpoints[1].id,
    });
    expect(await validate("glm-5.3")).toMatchObject({
      apiKey: "sk-glm",
      baseUrl: "https://glm.test",
      chatApiKeyId: endpoints[0].id,
    });
    // No model to go by (model listing) or a model no mapped endpoint is
    // known to serve: the first mapping answers, deterministically.
    for (const requestedModel of [null, "never-synced-model"]) {
      expect((await validate(requestedModel)).chatApiKeyId).toBe(
        endpoints[0].id,
      );
    }
  });
});

// =========================================================================
// attemptJwksAuth
// =========================================================================

describe("attemptJwksAuth", () => {
  function makeFakeRequest(authorizationHeader?: string): FastifyRequest {
    return {
      headers: {
        authorization: authorizationHeader,
      },
      raw: {
        headers: {
          authorization: authorizationHeader,
        },
      },
    } as FastifyRequest;
  }

  test("returns null when agent has no identityProviderId", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();

    const result = await attemptJwksAuth(
      makeFakeRequest("Bearer some-jwt"),
      agent,
      "openai",
    );
    expect(result).toBeNull();
  });

  test("returns null when no authorization header present", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const result = await attemptJwksAuth(
      makeFakeRequest(undefined),
      agent,
      "openai",
    );
    expect(result).toBeNull();
  });

  test("returns null when bearer token uses a legacy virtual-key prefix", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const result = await attemptJwksAuth(
      makeFakeRequest(
        `Bearer ${LEGACY_ARCHESTRA_TOKEN_PREFIXES[0]}abc123def456`,
      ),
      agent,
      "openai",
    );
    expect(result).toBeNull();
  });

  test("returns null when bearer token uses the current virtual-key prefix", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const result = await attemptJwksAuth(
      makeFakeRequest(`Bearer ${ARCHESTRA_TOKEN_PREFIX}abc123def456`),
      agent,
      "openai",
    );
    expect(result).toBeNull();
  });

  test("returns null when bearer token is a provider API key rather than a JWT", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const gatewayUtils = await import("@/routes/mcp-gateway/utils");
    const spy = vi.spyOn(gatewayUtils, "validateExternalIdpToken");

    const result = await attemptJwksAuth(
      makeFakeRequest("Bearer sk-provider-key"),
      agent,
      "openai",
    );

    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test("throws 401 when JWT validation throws an error", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    // Mock validateExternalIdpToken to throw an error
    const gatewayUtils = await import("@/routes/mcp-gateway/utils");
    const spy = vi
      .spyOn(gatewayUtils, "validateExternalIdpToken")
      .mockRejectedValue(new Error("OIDC discovery failed"));

    await expect(
      attemptJwksAuth(
        makeFakeRequest("Bearer invalid.jwt.token"),
        agent,
        "openai",
      ),
    ).rejects.toThrow(
      "JWT validation failed for the configured identity provider.",
    );

    spy.mockRestore();
  });

  test("throws 401 when JWKS validation returns null", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const gatewayUtils = await import("@/routes/mcp-gateway/utils");
    const spy = vi
      .spyOn(gatewayUtils, "validateExternalIdpToken")
      .mockResolvedValue(null);

    await expect(
      attemptJwksAuth(
        makeFakeRequest("Bearer some.jwt.token"),
        agent,
        "openai",
      ),
    ).rejects.toThrow(
      "Invalid JWT token for the configured identity provider.",
    );

    spy.mockRestore();
  });

  test("returns auth result with resolved API key on successful JWKS auth", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
    makeSecret,
    makeLlmProviderApiKey,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    // Create an org-wide API key for the provider
    const secret = await makeSecret({
      secret: { apiKey: "sk-provider-key" },
    });
    await makeLlmProviderApiKey(org.id, secret.id, { provider: "openai" });

    // Mock successful JWKS validation
    const gatewayUtils = await import("@/routes/mcp-gateway/utils");
    const spy = vi
      .spyOn(gatewayUtils, "validateExternalIdpToken")
      .mockResolvedValue({
        tokenId: "mock-token-id",
        teamId: null,
        isOrganizationToken: false,
        organizationId: org.id,
        userId: user.id,
      });

    const result = await attemptJwksAuth(
      makeFakeRequest("Bearer valid.jwt.token"),
      agent,
      "openai",
    );

    expect(result).not.toBeNull();
    expect(result?.userId).toBe(user.id);
    expect(result?.organizationId).toBe(org.id);
    expect(result?.apiKey).toBe("sk-provider-key");

    spy.mockRestore();
  });

  test("returns undefined apiKey for unsupported provider", async ({
    makeOrganization,
    makeAgent,
    makeIdentityProvider,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const idp = await makeIdentityProvider(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      identityProviderId: idp.id,
    });

    const gatewayUtils = await import("@/routes/mcp-gateway/utils");
    const spy = vi
      .spyOn(gatewayUtils, "validateExternalIdpToken")
      .mockResolvedValue({
        tokenId: "mock-token-id",
        teamId: null,
        isOrganizationToken: false,
        organizationId: org.id,
        userId: user.id,
      });

    const result = await attemptJwksAuth(
      makeFakeRequest("Bearer valid.jwt.token"),
      agent,
      "not-a-real-provider",
    );

    expect(result).not.toBeNull();
    expect(result?.apiKey).toBeUndefined();
    expect(result?.baseUrl).toBeUndefined();
    expect(result?.userId).toBe(user.id);
    expect(result?.organizationId).toBe(org.id);

    spy.mockRestore();
  });
});

// =========================================================================
// assertAuthenticatedForKeylessProvider
// =========================================================================

describe("assertAuthenticatedForKeylessProvider", () => {
  const keylessArgs = {
    apiKey: undefined,
    wasVirtualKeyResolved: false,
    wasJwksAuthenticated: false,
    isLoopbackCaller: false,
  };

  test("allows request when apiKey is present", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        apiKey: "sk-real-key",
      }),
    ).not.toThrow();
  });

  test("allows request when virtual key was resolved", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        wasVirtualKeyResolved: true,
      }),
    ).not.toThrow();
  });

  test("allows request when JWKS authenticated", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        wasJwksAuthenticated: true,
      }),
    ).not.toThrow();
  });

  // Which addresses count as loopback is isLoopbackRequest's contract, covered
  // in utils/network.test.ts. This function only consumes the verdict.
  test("allows a loopback caller without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        isLoopbackCaller: true,
      }),
    ).not.toThrow();
  });

  test("rejects external request without any auth", () => {
    expect(() => assertAuthenticatedForKeylessProvider(keylessArgs)).toThrow(
      "Authentication required",
    );
  });

  // When the backend authenticates upstream with its own credentials (Gemini on
  // Vertex AI), the caller's Authorization value is discarded before it reaches
  // the provider. Nothing ever validates it, so it cannot authenticate anyone.
  test("rejects an arbitrary bearer value when the server supplies the credential", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        apiKey: "Bearer anything",
        providerSuppliesServerCredential: true,
      }),
    ).toThrow("Authentication required");
  });

  test("still allows a resolved virtual key when the server supplies the credential", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        apiKey: "Bearer anything",
        wasVirtualKeyResolved: true,
        providerSuppliesServerCredential: true,
      }),
    ).not.toThrow();
  });

  test("still allows JWKS auth when the server supplies the credential", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        wasJwksAuthenticated: true,
        providerSuppliesServerCredential: true,
      }),
    ).not.toThrow();
  });

  test("still allows loopback when the server supplies the credential", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider({
        ...keylessArgs,
        apiKey: "Bearer anything",
        isLoopbackCaller: true,
        providerSuppliesServerCredential: true,
      }),
    ).not.toThrow();
  });
});

// =========================================================================
// VirtualKeyRateLimiter
// =========================================================================

const KEY_A = "arch_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B = "arch_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("VirtualKeyRateLimiter", () => {
  setupTestCacheManager();
  const limiter = new VirtualKeyRateLimiter(cacheManager);

  afterEach(() => {
    vi.useRealTimers();
  });

  test("allows requests under the failure threshold", async () => {
    for (let i = 0; i < 9; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).resolves.toBeUndefined();
  });

  test("blocks requests at the failure threshold", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
  });

  test("does not block unrelated IPs", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    await expect(
      limiter.check({ ip: "5.6.7.8", credential: KEY_A }),
    ).resolves.toBeUndefined();
  });

  // The collateral-lockout fix: clients sharing an origin (a load balancer, or
  // loopback for frontend-rewritten requests) must not lock each other out.
  test("does not block a different credential from the same IP", async () => {
    for (let i = 0; i < 20; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_B }),
    ).resolves.toBeUndefined();
  });

  // ...but per-credential scoping must not hand an enumerator a fresh bucket
  // per guess, so the IP-wide backstop still closes.
  test("blocks an IP that cycles through many distinct credentials", async () => {
    for (let i = 0; i < 100; i++) {
      await limiter.recordFailure({
        ip: "1.2.3.4",
        credential: `arch_guess_${i}`,
      });
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: "arch_guess_fresh" }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
  });

  test("never writes the credential into the cache key", async () => {
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    const keys = (await storedEntries()).map((entry) => entry.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(KEY_A);
    }
  });

  test("counts requests that present no credential in a shared bucket", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4" });
    }
    await expect(limiter.check({ ip: "1.2.3.4" })).rejects.toThrow(
      "Too many failed virtual API key attempts",
    );
  });

  test("increments failure count correctly", async () => {
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
      counts.push((await credentialBucket()).count);
    }
    expect(counts).toEqual([1, 2, 3]);
    // The IP-wide bucket counts the same failures.
    expect((await ipBucket("1.2.3.4")).count).toBe(3);
  });

  test("opens a window of the full length that expires with it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });

    const stored = await storedEntries();
    expect(stored).toHaveLength(2);
    for (const entry of stored) {
      expect(entry.value).toEqual({
        value: { count: 1, windowEndsAt: 1_060_000 },
        expires: 1_060_000,
      });
    }
  });

  test("allows requests once the window has ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    vi.setSystemTime(1_060_000);
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).resolves.toBeUndefined();
  });

  test("resets counter when the window has ended and a new failure is recorded", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    vi.setSystemTime(1_060_000);
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    expect(await credentialBucket()).toEqual({
      count: 1,
      windowEndsAt: 1_120_000,
    });
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).resolves.toBeUndefined();
  });

  // The window is FIXED, not "60s since the last failure". Under the old
  // refresh-on-write TTL these 15 failures blocked, even though no 60s stretch
  // held more than 5 — the count simply never reset while failures kept
  // arriving, which is what made a busy origin lock itself out.
  test("does not accumulate failures across separate windows", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 5; i++) {
        await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
      }
      vi.setSystemTime(Date.now() + 40_000);
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).resolves.toBeUndefined();
  });

  test("a failure inside an open window does not push the window's end out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    vi.setSystemTime(1_025_000);
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });

    for (const entry of await storedEntries()) {
      expect(entry.value).toEqual({
        value: { count: 2, windowEndsAt: 1_060_000 },
        expires: 1_060_000,
      });
    }
  });

  // Concurrent failures on several replicas must all count: a read-then-write
  // increment let them overwrite each other.
  test("counts concurrent failures without losing any", async () => {
    await Promise.all(
      Array.from({ length: 25 }, () =>
        limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A }),
      ),
    );
    expect((await credentialBucket()).count).toBe(25);
    expect((await ipBucket("1.2.3.4")).count).toBe(25);
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
  });

  // Rolling deploys read entries written before windowEndsAt existed. Forgiving
  // them (rather than treating them as an open window of unknown length) is the
  // direction that cannot strand a caller.
  test("treats a legacy entry with no window end as expired", async () => {
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    const key = (await storedEntries()).find(
      (entry) => !entry.key.includes("-ip-"),
    )?.key;
    if (!key) throw new Error("expected a credential bucket");
    await cacheManager.set(
      key.slice("keyv:".length) as AllowedCacheKey,
      { count: 999 },
      60_000,
    );

    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).resolves.toBeUndefined();
    // ...and the next failure opens a fresh window instead of adding to it.
    await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    expect((await credentialBucket()).count).toBe(1);
  });

  test("reports how long to wait, bounded by the window", async () => {
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    const error = await limiter
      .check({ ip: "1.2.3.4", credential: KEY_A })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.statusCode).toBe(429);
    expect(apiError.retryAfterSeconds).toBeGreaterThan(0);
    expect(apiError.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(apiError.message).toMatch(/retry in \d+ seconds/);
  });

  // The collateral-lockout fix for shared origins: behind an ingress every
  // caller shares one `ip`, so the anti-enumeration backstop must not throttle
  // a credential that is demonstrably working.
  test("exempts a recently validated credential from the IP-wide backstop", async () => {
    for (let i = 0; i < 100; i++) {
      await limiter.recordFailure({
        ip: "1.2.3.4",
        credential: `arch_guess_${i}`,
      });
    }
    await limiter.recordSuccess({ credential: KEY_A });

    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).resolves.toBeUndefined();
    // ...while a credential that has not proven itself stays throttled.
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_B }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
  });

  test("the exemption lapses with its mark", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    await limiter.recordSuccess({ credential: KEY_A });
    vi.setSystemTime(1_300_001);
    for (let i = 0; i < 100; i++) {
      await limiter.recordFailure({
        ip: "1.2.3.4",
        credential: `arch_guess_${i}`,
      });
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
  });

  // The exemption is scoped to the IP backstop only: a credential of its own
  // failing repeatedly must still be throttled even if it once worked.
  test("does not exempt a validated credential from its own bucket", async () => {
    await limiter.recordSuccess({ credential: KEY_A });
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure({ ip: "1.2.3.4", credential: KEY_A });
    }
    await expect(
      limiter.check({ ip: "1.2.3.4", credential: KEY_A }),
    ).rejects.toThrow("Too many failed virtual API key attempts");
  });

  test("never writes the credential into the recently-validated cache key", async () => {
    await limiter.recordSuccess({ credential: KEY_A });
    const keys = (await storedEntries()).map((entry) => entry.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(KEY_A);
    }
  });

  test("a failed exemption write does not fail the request", async () => {
    vi.spyOn(cacheManager, "set").mockRejectedValueOnce(
      new Error("cache down"),
    );
    await expect(
      limiter.recordSuccess({ credential: KEY_A }),
    ).resolves.toBeUndefined();
  });
});

async function storedEntries(): Promise<
  Array<{
    key: string;
    value: { value: unknown; expires: number };
  }>
> {
  const result = await db.execute<{ key: string; value: string }>(
    sql`SELECT key, value FROM keyv_cache ORDER BY key`,
  );
  return result.rows.map((row) => ({
    key: row.key,
    value: JSON.parse(row.value),
  }));
}

/** The (IP, credential) bucket of the only credential that failed, read through the cache API. */
async function credentialBucket(): Promise<{
  count: number;
  windowEndsAt: number;
}> {
  const key = (await storedEntries()).find(
    (entry) => !entry.key.includes("-ip-") && !entry.key.includes("-ok-"),
  )?.key;
  if (!key) throw new Error("expected a credential bucket");
  return mustRead(key);
}

async function ipBucket(
  ip: string,
): Promise<{ count: number; windowEndsAt: number }> {
  return mustRead(`keyv:${CacheKey.VirtualKeyRateLimit}-ip-${ip}`);
}

async function mustRead(
  key: string,
): Promise<{ count: number; windowEndsAt: number }> {
  const value = await cacheManager.get<{ count: number; windowEndsAt: number }>(
    key.slice("keyv:".length) as AllowedCacheKey,
  );
  if (!value) throw new Error(`expected a cached bucket at ${key}`);
  return value;
}

// =========================================================================
// validatePassthroughVirtualKey
// =========================================================================

describe("validatePassthroughVirtualKey", () => {
  test("returns owner + key id when the owner can access the proxy", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, org.id, { role: "member" });
    // The organization's proxy, which every member reaches.
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      isDefault: true,
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "pt",
      keyType: "passthrough",
      authorId: owner.id,
    });

    const result = await validatePassthroughVirtualKey({
      tokenValue: value,
      agent: proxy,
    });
    expect(result.userId).toBe(owner.id);
  });

  test("403 when the owner cannot access the proxy", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const personalProxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      access: "personal",
      authorId: otherUser.id,
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "pt",
      keyType: "passthrough",
      authorId: owner.id,
    });

    await expect(
      validatePassthroughVirtualKey({
        tokenValue: value,
        agent: personalProxy,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("401 for an expired key", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "pt",
      keyType: "passthrough",
      authorId: owner.id,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(
      validatePassthroughVirtualKey({ tokenValue: value, agent: proxy }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("400 when a standard key is sent as a passthrough key", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
    });
    const { value } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      name: "std",
      keyType: "standard",
      authorId: owner.id,
      providerApiKeys: [
        { provider: parentKey.provider, providerApiKeyId: parentKey.id },
      ],
    });

    await expect(
      validatePassthroughVirtualKey({ tokenValue: value, agent: proxy }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

// =========================================================================
// assertConsistentUserCredentials
// =========================================================================

describe("assertConsistentUserCredentials", () => {
  test("passes for a single user, repeats, and empties", () => {
    expect(() => assertConsistentUserCredentials([])).not.toThrow();
    expect(() =>
      assertConsistentUserCredentials([undefined, null, "user-a"]),
    ).not.toThrow();
    expect(() =>
      assertConsistentUserCredentials(["user-a", "user-a", undefined]),
    ).not.toThrow();
  });

  test("throws 401 when two credentials identify different users", () => {
    try {
      assertConsistentUserCredentials(["user-a", "user-b"]);
      throw new Error("expected a conflict error");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(401);
    }
  });
});
