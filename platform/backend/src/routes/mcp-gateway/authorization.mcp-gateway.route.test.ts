import { createHash, randomUUID } from "node:crypto";
import { MCP_OAUTH_CLIENT_REFERENCE_PREFIX } from "@archestra/shared";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createFastifyInstance } from "@/fastify-instance";
import {
  McpOauthClientModel,
  MemberModel,
  OAuthAccessTokenModel,
  ServiceAccountModel,
  TeamModel,
  UserTokenModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { MCP_RESOURCE_REFERENCE_PREFIX } from "@/services/identity-providers/enterprise-managed/authorization";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import mcpGatewayRoutes from "./index";

setupTestCacheManager();

describe("MCP Gateway authorization failures", () => {
  let app: ReturnType<typeof createFastifyInstance>;

  beforeEach(async () => {
    app = createFastifyInstance();
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("distinguishes denied OAuth access from invalid credentials on every transport endpoint", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeOAuthClient,
    makeOAuthAccessToken,
    makeOAuthRefreshToken,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "mcp_gateway",
      access: "personal",
    });
    const client = await makeOAuthClient({ userId: user.id });
    const revoked = await makeOAuthRefreshToken(client.clientId, user.id, {
      revoked: new Date(),
    });

    for (const scenario of [
      "denied",
      "invalid",
      "expired",
      "revoked",
      "wrong-gateway",
      "removed-member",
    ] as const) {
      const token = `test-oauth-${randomUUID()}`;
      const removedUser =
        scenario === "removed-member" ? await makeUser() : null;
      const removedMembership = removedUser
        ? await makeMember(removedUser.id, org.id, { role: "member" })
        : null;
      if (scenario !== "invalid") {
        await makeOAuthAccessToken(
          client.clientId,
          removedUser?.id ?? user.id,
          {
            token: createHash("sha256").update(token).digest("base64url"),
            referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${scenario === "wrong-gateway" ? randomUUID() : agent.id}`,
            ...(scenario === "expired" && {
              expiresAt: new Date(Date.now() - 60_000),
            }),
            ...(scenario === "revoked" && { refreshId: revoked.id }),
          },
        );
      }

      if (removedMembership) {
        await MemberModel.deleteByIdInOrganization(
          removedMembership.id,
          org.id,
        );
      }
      for (const endpoint of ["post", "get", "sse", "delete"] as const) {
        const response = await app.inject({
          method:
            endpoint === "get"
              ? "GET"
              : endpoint === "delete"
                ? "DELETE"
                : "POST",
          url: `/v1/mcp/${agent.slug}${endpoint === "sse" ? `/messages?sessionId=${randomUUID()}` : ""}`,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
          },
          ...((endpoint === "post" || endpoint === "sse") && {
            payload: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {},
            },
          }),
        });
        const label = `${scenario}/${endpoint}`;
        expect(response.statusCode, label).toBe(
          scenario === "denied" ? 403 : 401,
        );
        if (scenario === "denied") {
          expect(response.headers["www-authenticate"], label).toBeUndefined();
          expect(response.body, label).toContain(
            "does not have access to this gateway",
          );
        } else {
          expect(response.headers["www-authenticate"], label).toContain(
            "resource_metadata=",
          );
        }
      }
    }
  });

  test("distinguishes platform-token grant loss from invalid credentials on every transport", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeAgent,
    makeServiceAccountToken,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const owner = await makeUser();
    const user = await makeUser();
    const member = await makeMember(user.id, org.id, { role: "member" });
    // Membership in both organizations must not let an org-scoped token cross over.
    await makeMember(user.id, otherOrg.id, { role: "member" });
    const team = await makeTeam(org.id, owner.id);
    await makeTeamMember(team.id, user.id);
    const gateway = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "mcp_gateway",
      access: { teams: [team.id] },
    });
    const otherGateway = await makeAgent({
      organizationId: otherOrg.id,
      agentType: "mcp_gateway",
    });
    const userToken = await UserTokenModel.create(user.id, org.id);
    const accountToken = await makeServiceAccountToken({
      organizationId: org.id,
      teamId: team.id,
    });
    const request = (credential: string, gatewayId = gateway.id) => ({
      method: "GET" as const,
      url: `/v1/mcp/${gatewayId}`,
      headers: { authorization: `Bearer ${credential}` },
    });
    for (const credential of [userToken.value, accountToken.value]) {
      expect((await app.inject(request(credential))).statusCode).toBe(405);
    }
    await TeamModel.removeMember(team.id, user.id);
    await ServiceAccountModel.update(accountToken.serviceAccount.id, org.id, {
      teamId: null,
    });
    for (const credential of [userToken.value, accountToken.value]) {
      for (const endpoint of ["post", "get", "sse", "delete"] as const) {
        const response = await app.inject({
          method:
            endpoint === "get"
              ? "GET"
              : endpoint === "delete"
                ? "DELETE"
                : "POST",
          url: `/v1/mcp/${gateway.id}${endpoint === "sse" ? `/messages?sessionId=${randomUUID()}` : ""}`,
          headers: {
            authorization: `Bearer ${credential}`,
            accept: "application/json, text/event-stream",
          },
          ...((endpoint === "post" || endpoint === "sse") && {
            payload: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/list",
              params: {},
            },
          }),
        });
        expect(response.statusCode, endpoint).toBe(403);
        expect(response.headers["www-authenticate"]).toBeUndefined();
      }
    }
    for (const credential of [userToken.value, accountToken.value])
      expect(
        (await app.inject(request(credential, otherGateway.id))).statusCode,
      ).toBe(401);
    await MemberModel.deleteByIdInOrganization(member.id, org.id);
    await ServiceAccountModel.update(accountToken.serviceAccount.id, org.id, {
      disabled: true,
    });
    for (const credential of [
      userToken.value,
      accountToken.value,
      "archestra_invalid",
    ]) {
      const response = await app.inject(request(credential));
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    }
    await ServiceAccountModel.update(accountToken.serviceAccount.id, org.id, {
      disabled: false,
    });
    const tokenKey = {
      serviceAccountId: accountToken.serviceAccount.id,
      tokenId: accountToken.tokenId,
      organizationId: org.id,
    };
    for (const data of [
      { disabled: true },
      { disabled: false, expiresAt: new Date(Date.now() - 60_000) },
    ]) {
      await ServiceAccountModel.updateToken({ ...tokenKey, data });
      const invalid = await app.inject(request(accountToken.value));
      expect(invalid.statusCode).toBe(401);
      expect(invalid.headers["www-authenticate"]).toContain(
        "resource_metadata",
      );
    }
    await ServiceAccountModel.deleteToken(tokenKey);
    expect((await app.inject(request(accountToken.value))).statusCode).toBe(
      401,
    );
  });

  test("returns 403 when an application token loses its gateway grant", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const { oauthClient } = await McpOauthClientModel.create({
      organizationId: org.id,
      authorId: randomUUID(),
      name: "gateway-worker",
      allowedGatewayIds: [agent.id],
    });
    const token = `test-oauth-${randomUUID()}`;
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(token),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["mcp"],
      referenceId: `${MCP_OAUTH_CLIENT_REFERENCE_PREFIX}${oauthClient.id}`,
    });
    const request = {
      method: "POST" as const,
      url: `/v1/mcp/${agent.slug}`,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json, text/event-stream",
      },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    };
    expect((await app.inject(request)).statusCode).toBe(200);
    await McpOauthClientModel.update({
      id: oauthClient.id,
      organizationId: org.id,
      name: oauthClient.name,
      allowedGatewayIds: [],
    });
    const denied = await app.inject(request);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["www-authenticate"]).toBeUndefined();
    expect(denied.body).toContain("does not have access to this gateway");
  });

  test("SDK surfaces denied access without OAuth discovery or reauthentication, including after a grant is revoked", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeOAuthClient,
    makeOAuthAccessToken,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const owner = await makeUser();
    await makeMember(user.id, org.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: owner.id,
      agentType: "mcp_gateway",
      access: { users: [user.id] },
    });
    const oauthClient = await makeOAuthClient({ userId: user.id });
    const token = `test-oauth-${randomUUID()}`;
    await makeOAuthAccessToken(oauthClient.clientId, user.id, {
      token: createHash("sha256").update(token).digest("base64url"),
      referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${agent.id}`,
    });
    const requests: string[] = [];
    app.addHook("onRequest", async (request) => {
      requests.push(`${request.method} ${request.url}`);
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    let redirects = 0;
    const authProvider: OAuthClientProvider = {
      redirectUrl: "http://localhost/callback",
      clientMetadata: { redirect_uris: ["http://localhost/callback"] },
      clientInformation: () => ({ client_id: oauthClient.clientId }),
      tokens: () => ({ access_token: token, token_type: "Bearer" }),
      saveTokens: () => {
        throw new Error("Unexpected token refresh");
      },
      redirectToAuthorization: () => {
        redirects += 1;
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => "test-verifier",
    };
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`/v1/mcp/${agent.slug}`, origin),
          { authProvider },
        ),
      );
      await client.listTools();
      const key = {
        organizationId: org.id,
        resource: "mcpGateway" as const,
        scope: agent.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(key);
      expect(policy).not.toBeNull();
      if (!policy) throw new Error("Expected gateway policy");
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy.revision,
        grants: [],
      });
      await expect(client.listTools()).rejects.toMatchObject({
        code: 403,
        message: expect.stringContaining(
          "does not have access to this gateway",
        ),
      });
    } finally {
      await client.close();
    }

    const deniedClient = new Client({
      name: "gateway-test-denied",
      version: "1.0.0",
    });
    try {
      await expect(
        deniedClient.connect(
          new StreamableHTTPClientTransport(
            new URL(`/v1/mcp/${agent.slug}`, origin),
            { authProvider },
          ),
        ),
      ).rejects.toMatchObject({ code: 403 });
    } finally {
      await deniedClient.close();
    }
    expect(redirects).toBe(0);
    expect(
      requests.some((request) => !request.endsWith(` /v1/mcp/${agent.slug}`)),
    ).toBe(false);
  });
});
