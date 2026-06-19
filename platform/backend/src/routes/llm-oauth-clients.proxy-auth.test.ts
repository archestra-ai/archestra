import { randomBytes } from "node:crypto";
import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared";
import { LlmOauthClientModel, OAuthAccessTokenModel } from "@/models";
import { describe, expect, test } from "@/test";
import { validateLlmOAuthAccessToken } from "./proxy/llm-proxy-auth";

/**
 * End-to-end authorization tests for LLM OAuth client (authorization_code)
 * tokens at the LLM proxy boundary. An authorization_code client mints
 * USER-BOUND tokens via better-auth's standard authorize→token exchange. These
 * carry an acting user but no provider keys of their own, so the proxy must
 * resolve the user's identity on the user-token path and pick the user's own
 * provider key — that is what makes a pre-registered client act on behalf of
 * the signed-in user (the LLM analog of per-user resolution).
 */
describe("LLM OAuth authorization_code proxy authorization", () => {
  async function mintUserToken(params: { clientId: string; userId: string }) {
    const accessToken = randomBytes(32).toString("base64url");
    await OAuthAccessTokenModel.create({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(accessToken),
      clientId: params.clientId,
      userId: params.userId,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      // No referenceId → user-identity path (not the client_credentials branch).
      referenceId: null,
    });
    return accessToken;
  }

  test("resolves the acting user and their own provider key", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    // The user's own (org-scoped) provider key — NOT a key stored on the client.
    const secret = await makeSecret({ secret: { apiKey: "sk-user-openai" } });
    await makeLlmProviderApiKey(org.id, secret.id, { provider: "openai" });

    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: org.id,
      name: "Agentic Chat Server",
      grantType: "authorization_code",
      redirectUris: ["https://chat.example.com/oauth/callback"],
    });
    // The authorization_code client carries no provider keys of its own.
    expect(oauthClient.providerApiKeys).toEqual([]);

    const token = await mintUserToken({
      clientId: oauthClient.clientId,
      userId: user.id,
    });

    const result = await validateLlmOAuthAccessToken({
      tokenValue: token,
      expectedProvider: "openai",
      agent: proxy,
    });

    expect(result).not.toBeNull();
    expect(result?.authMethod).toBe("oauth_user");
    expect(result?.userId).toBe(user.id);
    // Resolved from the USER's own key, not the client.
    expect(result?.apiKey).toBe("sk-user-openai");
    expect(result?.authenticatedApp?.clientId).toBe(oauthClient.clientId);
  });

  test("rejects a token whose user cannot access the proxy", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    // A user with no membership in the proxy's organization.
    const outsider = await makeUser();
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: org.id,
      name: "Agentic Chat Server",
      grantType: "authorization_code",
      redirectUris: ["https://chat.example.com/oauth/callback"],
    });

    const token = await mintUserToken({
      clientId: oauthClient.clientId,
      userId: outsider.id,
    });

    await expect(
      validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: "openai",
        agent: proxy,
      }),
    ).rejects.toThrow();
  });

  /**
   * Additive client grant: an authorization_code client's allowedLlmProxyIds
   * grants its users access to a proxy they could NOT reach through their own
   * RBAC — admin-controlled and additive (it never removes access). The user's
   * own provider key still resolves at call time.
   */
  test("grants proxy access via the client's allowedLlmProxyIds even when the user has no RBAC access", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeTeam,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    // A restricted (team-scoped) proxy the user is NOT a member of.
    const owningTeam = await makeTeam(org.id, user.id, { name: "Owners" });
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      scope: "team",
      teams: [owningTeam.id],
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-user-openai" } });
    await makeLlmProviderApiKey(org.id, secret.id, { provider: "openai" });

    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: org.id,
      name: "Chat Interface",
      grantType: "authorization_code",
      redirectUris: ["https://chat.example.com/oauth/callback"],
      allowedLlmProxyIds: [proxy.id],
    });

    const token = await mintUserToken({
      clientId: oauthClient.clientId,
      userId: user.id,
    });

    const result = await validateLlmOAuthAccessToken({
      tokenValue: token,
      expectedProvider: "openai",
      agent: proxy,
    });

    expect(result).not.toBeNull();
    expect(result?.authMethod).toBe("oauth_user");
    expect(result?.userId).toBe(user.id);
    expect(result?.apiKey).toBe("sk-user-openai");
  });

  test("does not grant access for a proxy outside the client's allowedLlmProxyIds", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const owningTeam = await makeTeam(org.id, user.id, { name: "Owners" });
    const grantedProxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      scope: "team",
      teams: [owningTeam.id],
    });
    const otherProxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
      scope: "team",
      teams: [owningTeam.id],
    });
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: org.id,
      name: "Chat Interface",
      grantType: "authorization_code",
      redirectUris: ["https://chat.example.com/oauth/callback"],
      allowedLlmProxyIds: [grantedProxy.id],
    });

    const token = await mintUserToken({
      clientId: oauthClient.clientId,
      userId: user.id,
    });

    await expect(
      validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: "openai",
        agent: otherProxy,
      }),
    ).rejects.toThrow();
  });
});
