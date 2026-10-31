import type { FastifyRequest } from "fastify";
import {
  OrganizationModel,
  UserTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import { accessGrants, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { createPassthroughAuthenticator } from "./llm-proxy-auth";

/**
 * The platform check every catch-all route runs before its upstream sees the
 * request. Driven with a minimal request, since the catch-all hands the
 * authenticator the raw request before any route schema applies.
 */
describe("createPassthroughAuthenticator", () => {
  // The credential rate limiter keeps its counters in the cache.
  setupTestCacheManager();
  const authenticate = createPassthroughAuthenticator("openai");

  function requestWith(headers: Record<string, string>): FastifyRequest {
    return {
      headers,
      raw: { headers },
      ip: "203.0.113.9",
      body: undefined,
    } as unknown as FastifyRequest;
  }

  test("rejects a request with no credential", async ({ makeAgent }) => {
    const agent = await makeAgent();
    await expect(
      authenticate({ request: requestWith({}), agentId: agent.id }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("rejects a bare provider key", async ({ makeAgent }) => {
    const agent = await makeAgent();
    await expect(
      authenticate({
        request: requestWith({ authorization: "Bearer sk-provider-key" }),
        agentId: agent.id,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("forwards an anonymous request once the organization allows unauthenticated requests", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    await OrganizationModel.patch(agent.organizationId, {
      allowUnauthenticatedLlmProxyRequests: true,
    });
    await expect(
      authenticate({ request: requestWith({}), agentId: agent.id }),
    ).resolves.toMatchObject({ authMethod: "unknown" });
  });

  // Resolving the agent before the credential check would answer 404 for an
  // unknown id, telling an anonymous caller which agent ids exist.
  test("answers 401, not 404, for an unknown agent id without a credential", async () => {
    await expect(
      authenticate({
        request: requestWith({}),
        agentId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("accepts a passthrough key", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const token = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    await expect(
      authenticate({
        request: requestWith({
          authorization: "Bearer sk-provider-key",
          "x-archestra-virtual-key": token,
        }),
        agentId: agent.id,
      }),
    ).resolves.toMatchObject({ authMethod: "passthrough_virtual_key" });
  });

  test("accepts a personal platform token of a member of the proxy's organization", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      agent.organizationId,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);
    await expect(
      authenticate({
        request: requestWith({ authorization: `Bearer ${tokenValue}` }),
        agentId: agent.id,
      }),
    ).resolves.toMatchObject({ authMethod: "personal_token" });
  });

  test("rejects a personal platform token issued for another organization", async ({
    makeAgent,
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, otherOrg.id);
    const userToken = await UserTokenModel.ensureUserToken(
      user.id,
      otherOrg.id,
    );
    const tokenValue = await UserTokenModel.getTokenValue(userToken.id);
    await expect(
      authenticate({
        request: requestWith({ authorization: `Bearer ${tokenValue}` }),
        agentId: agent.id,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  describe("a standard virtual key", () => {
    async function virtualKeyFor(params: {
      organizationId: string;
      provider: "openai" | "anthropic";
      baseUrl?: string;
      makeSecret: (overrides: {
        secret: Record<string, unknown>;
      }) => Promise<{ id: string }>;
      makeLlmProviderApiKey: (
        organizationId: string,
        secretId: string,
        overrides: { provider: "openai" | "anthropic"; baseUrl?: string },
      ) => Promise<{ id: string }>;
    }) {
      const secret = await params.makeSecret({
        secret: { apiKey: `sk-${params.provider}-mapped` },
      });
      const providerKey = await params.makeLlmProviderApiKey(
        params.organizationId,
        secret.id,
        {
          provider: params.provider,
          ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
        },
      );
      const key = await VirtualApiKeyModel.create({
        organizationId: params.organizationId,
        name: "pass-through",
        ...accessGrants("org"),
        providerApiKeys: [
          { provider: params.provider, providerApiKeyId: providerKey.id },
        ],
      });
      return key.value;
    }

    test("forwards the provider key it maps, in place of itself", async ({
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const agent = await makeAgent();
      const token = await virtualKeyFor({
        organizationId: agent.organizationId,
        provider: "openai",
        makeSecret,
        makeLlmProviderApiKey,
      });
      const request = requestWith({ authorization: `Bearer ${token}` });
      await authenticate({ request, agentId: agent.id });
      expect(request.headers.authorization).toBe("Bearer sk-openai-mapped");
      expect(request.raw.headers.authorization).toBe("Bearer sk-openai-mapped");
    });

    test("forwards nothing when the mapped key belongs to another endpoint", async ({
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const agent = await makeAgent();
      const token = await virtualKeyFor({
        organizationId: agent.organizationId,
        provider: "openai",
        baseUrl: "https://openai-compatible.example/v1",
        makeSecret,
        makeLlmProviderApiKey,
      });
      const request = requestWith({ authorization: `Bearer ${token}` });
      await authenticate({ request, agentId: agent.id });
      expect(request.headers.authorization).toBeUndefined();
    });

    test("still passes, forwarding nothing, when it maps no key of the provider", async ({
      makeAgent,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const agent = await makeAgent();
      const token = await virtualKeyFor({
        organizationId: agent.organizationId,
        provider: "anthropic",
        makeSecret,
        makeLlmProviderApiKey,
      });
      const request = requestWith({ authorization: `Bearer ${token}` });
      await expect(
        authenticate({ request, agentId: agent.id }),
      ).resolves.toMatchObject({ authMethod: "virtual_key" });
      expect(request.headers.authorization).toBeUndefined();
    });
  });
});
