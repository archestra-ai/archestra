import type { FastifyRequest } from "fastify";
import { OrganizationModel, UserTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
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
    ).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();
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
});
