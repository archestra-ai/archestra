import { eq } from "drizzle-orm";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("mcpOauthClientsRoutes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();

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

    const { default: mcpOauthClientsRoutes } = await import(
      "./mcp-oauth-clients"
    );
    await app.register(mcpOauthClientsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates, lists, updates, rotates, and deletes an MCP OAuth client", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      name: "Support Gateway",
      agentType: "mcp_gateway",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Backend Service",
        allowedGatewayIds: [gateway.id],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.clientId).toMatch(/^mcp_oauth_/);
    expect(created.clientSecret).toMatch(/^mcp_secret_/);
    expect(created.allowedGatewayIds).toEqual([gateway.id]);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/mcp-oauth-clients",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);
    expect(listResponse.json()[0].name).toBe("Backend Service");
    // The hashed secret must never be returned on reads.
    expect(listResponse.json()[0].clientSecret).toBeUndefined();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/mcp-oauth-clients/${created.id}`,
      payload: {
        name: "Updated Backend Service",
        allowedGatewayIds: [gateway.id],
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      name: "Updated Backend Service",
      allowedGatewayIds: [gateway.id],
    });

    const rotateResponse = await app.inject({
      method: "POST",
      url: `/api/mcp-oauth-clients/${created.id}/rotate-secret`,
    });
    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json().clientSecret).toMatch(/^mcp_secret_/);
    expect(rotateResponse.json().clientSecret).not.toBe(created.clientSecret);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/mcp-oauth-clients/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });

  test("filters MCP OAuth clients by search", async ({ makeAgent }) => {
    const gateway = await makeAgent({
      organizationId,
      name: "Filter Gateway",
      agentType: "mcp_gateway",
    });

    await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: { name: "Searchable Service", allowedGatewayIds: [gateway.id] },
    });
    await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: { name: "Other Client", allowedGatewayIds: [gateway.id] },
    });

    const searchResponse = await app.inject({
      method: "GET",
      url: "/api/mcp-oauth-clients?search=searchable",
    });
    expect(searchResponse.statusCode).toBe(200);
    expect(
      searchResponse.json().map((client: { name: string }) => client.name),
    ).toEqual(["Searchable Service"]);
  });

  test("rejects a non-gateway agent as an allowed gateway", async ({
    makeAgent,
  }) => {
    const llmProxy = await makeAgent({
      organizationId,
      name: "Not A Gateway",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Misconfigured Client",
        allowedGatewayIds: [llmProxy.id],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("MCP gateway not found");
  });

  test("rejects a gateway from another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const otherGateway = await makeAgent({
      organizationId: otherOrg.id,
      name: "Other Org Gateway",
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Cross Org Client",
        allowedGatewayIds: [otherGateway.id],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("MCP gateway not found");
  });

  test("creates an authorization_code client registered as a confidential, PKCE client", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Agentic Chat Server",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.clientId).toMatch(/^mcp_oauth_/);
    expect(created.clientSecret).toMatch(/^mcp_secret_/);
    expect(created.grantType).toBe("authorization_code");
    expect(created.redirectUris).toEqual([
      "https://chat.example.com/oauth/callback",
    ]);
    // authorization_code access is governed by the acting user, not a gateway list.
    expect(created.allowedGatewayIds).toEqual([]);

    // The underlying oauth_client row must be wired for better-auth's
    // authorize→token exchange (confidential client, PKCE, mcp + offline_access).
    const [row] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.id, created.id));
    expect(row.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    expect(row.responseTypes).toEqual(["code"]);
    expect(row.requirePKCE).toBe(true);
    expect(row.public).toBe(false);
    expect(row.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(row.redirectUris).toEqual([
      "https://chat.example.com/oauth/callback",
    ]);
    expect(row.scopes).toEqual(
      expect.arrayContaining(["mcp", "offline_access"]),
    );
    // better-auth verifies the secret at the token endpoint by hashing the
    // presented value and comparing it to what is stored, so the stored secret
    // must be exactly this deterministic hash (not a bcrypt hash, which it could
    // never match). This is the contract that makes the real authorize→token
    // exchange succeed.
    expect(row.clientSecret).toBe(hashOauthClientSecret(created.clientSecret));
  });

  test("requires at least one redirect URI for authorization_code clients", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: { name: "No Redirects", grantType: "authorization_code" },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects an invalid redirect URI", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Bad Redirect",
        grantType: "authorization_code",
        redirectUris: ["not-a-url"],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("does not require allowed gateways for authorization_code clients", async () => {
    // No gateway exists, yet an authorization_code client must still be creatable —
    // it is not scoped to a gateway list.
    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Gatewayless",
        grantType: "authorization_code",
        redirectUris: ["https://app.example.com/callback"],
      },
    });

    expect(response.statusCode).toBe(200);
  });

  test("updates redirect URIs for an authorization_code client", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/mcp-oauth-clients",
        payload: {
          name: "Chat Server",
          grantType: "authorization_code",
          redirectUris: ["https://chat.example.com/oauth/callback"],
        },
      })
    ).json();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/mcp-oauth-clients/${created.id}`,
      payload: {
        name: "Chat Server",
        grantType: "authorization_code",
        redirectUris: [
          "https://chat.example.com/oauth/callback",
          "https://chat.example.com/oauth/callback2",
        ],
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().redirectUris).toEqual([
      "https://chat.example.com/oauth/callback",
      "https://chat.example.com/oauth/callback2",
    ]);
  });

  test("creates an authorization_code client with an additive gateway grant", async ({
    makeAgent,
  }) => {
    const gateway = await makeAgent({
      organizationId,
      name: "Chat Gateway",
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Chat Interface",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
        allowedGatewayIds: [gateway.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().grantType).toBe("authorization_code");
    expect(response.json().allowedGatewayIds).toEqual([gateway.id]);
  });

  test("validates the gateway grant on an authorization_code client", async ({
    makeAgent,
  }) => {
    // A non-gateway agent in the grant list is rejected, just like for
    // client_credentials clients.
    const llmProxy = await makeAgent({
      organizationId,
      name: "Not A Gateway",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/mcp-oauth-clients",
      payload: {
        name: "Chat Interface",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
        allowedGatewayIds: [llmProxy.id],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("MCP gateway not found");
  });
});
