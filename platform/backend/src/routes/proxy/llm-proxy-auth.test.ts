import type { FastifyRequest } from "fastify";
import { vi } from "vitest";
import { VirtualApiKeyModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  assertAuthenticatedForKeylessProvider,
  attemptJwksAuth,
  resolveAgent,
  VirtualKeyRateLimiter,
  validateVirtualApiKey,
} from "./llm-proxy-auth";

// =========================================================================
// resolveAgent
// =========================================================================

describe("resolveAgent", () => {
  test("returns agent when found by ID", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "test-agent" });

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

  test("falls back to default profile when no agentId provided", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    await makeAgent({
      organizationId: org.id,
      name: "default-profile",
      agentType: "profile",
      isDefault: true,
    });

    const result = await resolveAgent(undefined);
    expect(result.name).toBe("default-profile");
    expect(result.isDefault).toBe(true);
  });

  test("throws 400 when no agentId and no default profile", async () => {
    await expect(resolveAgent(undefined)).rejects.toThrow(
      "Please specify an LLMProxy ID in the URL path.",
    );
  });
});

// =========================================================================
// validateVirtualApiKey
// =========================================================================

describe("validateVirtualApiKey", () => {
  test("throws 401 for invalid/non-existent token", async () => {
    await expect(
      validateVirtualApiKey("archestra_nonexistent", "openai"),
    ).rejects.toThrow("Invalid virtual API key");
  });

  test("throws 401 for expired key", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-provider-key" },
    });
    const chatApiKey = await makeChatApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "expired-key",
      expiresAt: new Date("2020-01-01"),
    });

    await expect(validateVirtualApiKey(value, "openai")).rejects.toThrow(
      "Virtual API key expired",
    );
  });

  test("throws 400 for provider mismatch", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-provider-key" },
    });
    const chatApiKey = await makeChatApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "openai-key",
    });

    await expect(validateVirtualApiKey(value, "anthropic")).rejects.toThrow(
      'Virtual API key is for provider "openai", but request is for "anthropic"',
    );
  });

  test("returns resolved API key and baseUrl on success", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-provider-key" },
    });
    const chatApiKey = await makeChatApiKey(org.id, secret.id, {
      provider: "openai",
    });

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "valid-key",
    });

    const result = await validateVirtualApiKey(value, "openai");
    expect(result.apiKey).toBe("sk-real-provider-key");
    expect(result.baseUrl).toBeUndefined();
  });

  test("returns baseUrl when chat API key has one configured", async ({
    makeOrganization,
    makeSecret,
    makeChatApiKey,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret({
      secret: { apiKey: "sk-real-key" },
    });
    const chatApiKey = await makeChatApiKey(org.id, secret.id, {
      provider: "openai",
    });

    // Update the chat API key with a baseUrl
    const { ChatApiKeyModel } = await import("@/models");
    await ChatApiKeyModel.update(chatApiKey.id, {
      baseUrl: "https://custom-openai.example.com/v1",
    });

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: chatApiKey.id,
      name: "key-with-base-url",
    });

    const result = await validateVirtualApiKey(value, "openai");
    expect(result.apiKey).toBe("sk-real-key");
    expect(result.baseUrl).toBe("https://custom-openai.example.com/v1");
  });

  test("returns undefined apiKey when chat API key has no secretId", async () => {
    const spy = vi
      .spyOn(VirtualApiKeyModel, "validateToken")
      .mockResolvedValue({
        virtualKey: {
          id: "vk-1",
          chatApiKeyId: "ck-1",
          name: "test",
          tokenStart: "archestra_",
          secretId: "secret-1",
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
        },
        chatApiKey: {
          id: "ck-1",
          provider: "openai",
          secretId: null,
          baseUrl: null,
        },
      } as never);

    const result = await validateVirtualApiKey(
      "archestra_test_token",
      "openai",
    );
    expect(result.apiKey).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();

    spy.mockRestore();
  });

  test("returns undefined apiKey for system key (no secret) without throwing", async ({
    makeOrganization,
  }) => {
    const { ChatApiKeyModel } = await import("@/models");
    const org = await makeOrganization();

    const systemKey = await ChatApiKeyModel.createSystemKey({
      organizationId: org.id,
      name: "Vertex AI",
      provider: "gemini",
    });

    const { value } = await VirtualApiKeyModel.create({
      chatApiKeyId: systemKey.id,
      name: "virtual-for-system-key",
    });

    const result = await validateVirtualApiKey(value, "gemini");
    expect(result.apiKey).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
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

  test("returns null when bearer token is a virtual key", async ({
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
      makeFakeRequest("Bearer archestra_abc123def456"),
      agent,
      "openai",
    );
    expect(result).toBeNull();
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
    const gatewayUtils = await import("@/routes/mcp-gateway.utils");
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

    const gatewayUtils = await import("@/routes/mcp-gateway.utils");
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
    makeChatApiKey,
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
    await makeChatApiKey(org.id, secret.id, { provider: "openai" });

    // Mock successful JWKS validation
    const gatewayUtils = await import("@/routes/mcp-gateway.utils");
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

    const gatewayUtils = await import("@/routes/mcp-gateway.utils");
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
  test("allows request when apiKey is present", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        "sk-real-key",
        false,
        false,
        "1.2.3.4",
      ),
    ).not.toThrow();
  });

  test("allows request when virtual key was resolved", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, true, false, "1.2.3.4"),
    ).not.toThrow();
  });

  test("allows request when JWKS authenticated", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, false, true, "1.2.3.4"),
    ).not.toThrow();
  });

  test("allows localhost IPv4 without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        undefined,
        false,
        false,
        "127.0.0.1",
      ),
    ).not.toThrow();
  });

  test("allows localhost IPv6 without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, false, false, "::1"),
    ).not.toThrow();
  });

  test("allows localhost IPv4-mapped IPv6 without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        undefined,
        false,
        false,
        "::ffff:127.0.0.1",
      ),
    ).not.toThrow();
  });

  test("rejects external request without any auth", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(undefined, false, false, "1.2.3.4"),
    ).toThrow("Authentication required");
  });

  test("rejects external request with empty apiKey", () => {
    expect(() =>
      assertAuthenticatedForKeylessProvider(
        undefined,
        false,
        false,
        "10.0.0.5",
      ),
    ).toThrow("Authentication required");
  });
});

// =========================================================================
// VirtualKeyRateLimiter
// =========================================================================

/** Create a VirtualKeyRateLimiter backed by a simple in-memory Map (no DB needed). */
function createTestLimiter() {
  const store = new Map<string, unknown>();
  const mockCache = {
    get: vi.fn(async <T>(key: string) => store.get(key) as T | undefined),
    set: vi.fn(async <T>(key: string, value: T, _ttl?: number) => {
      store.set(key, value);
      return value;
    }),
  };
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test mock doesn't need strict AllowedCacheKey typing
    limiter: new VirtualKeyRateLimiter(mockCache as any),
    store,
    mockCache,
  };
}

describe("VirtualKeyRateLimiter", () => {
  test("allows requests under the failure threshold", async () => {
    const { limiter } = createTestLimiter();
    for (let i = 0; i < 9; i++) {
      await limiter.recordFailure("1.2.3.4");
    }
    await expect(limiter.check("1.2.3.4")).resolves.toBeUndefined();
  });

  test("blocks requests at the failure threshold", async () => {
    const { limiter } = createTestLimiter();
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure("1.2.3.4");
    }
    await expect(limiter.check("1.2.3.4")).rejects.toThrow(
      "Too many failed virtual API key attempts",
    );
  });

  test("does not block unrelated IPs", async () => {
    const { limiter } = createTestLimiter();
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure("1.2.3.4");
    }
    await expect(limiter.check("5.6.7.8")).resolves.toBeUndefined();
  });

  test("increments failure count correctly", async () => {
    const { limiter, mockCache } = createTestLimiter();
    await limiter.recordFailure("1.2.3.4");
    await limiter.recordFailure("1.2.3.4");
    await limiter.recordFailure("1.2.3.4");

    // Verify cache.set was called with incrementing counts
    const setCalls = mockCache.set.mock.calls;
    const counts = setCalls.map((call) => (call[1] as { count: number }).count);
    expect(counts).toEqual([1, 2, 3]);
  });

  test("passes TTL to cache set", async () => {
    const { limiter, mockCache } = createTestLimiter();
    await limiter.recordFailure("1.2.3.4");

    // Verify TTL (60_000 ms) is passed
    expect(mockCache.set).toHaveBeenCalledWith(
      expect.any(String),
      { count: 1 },
      60_000,
    );
  });

  test("allows requests when cache returns undefined (entry expired)", async () => {
    const { limiter, store } = createTestLimiter();
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure("1.2.3.4");
    }
    // Simulate TTL expiration by clearing the store
    store.clear();
    await expect(limiter.check("1.2.3.4")).resolves.toBeUndefined();
  });

  test("resets counter when cache entry expires and new failure recorded", async () => {
    const { limiter, store } = createTestLimiter();
    for (let i = 0; i < 10; i++) {
      await limiter.recordFailure("1.2.3.4");
    }
    // Simulate TTL expiration
    store.clear();
    // New failure starts fresh
    await limiter.recordFailure("1.2.3.4");
    await expect(limiter.check("1.2.3.4")).resolves.toBeUndefined();
  });
});
