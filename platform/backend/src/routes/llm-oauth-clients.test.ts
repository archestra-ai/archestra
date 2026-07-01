import { eq } from "drizzle-orm";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("llmOauthClientsRoutes", () => {
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

    const { default: llmOauthClientsRoutes } = await import(
      "./llm-oauth-clients"
    );
    await app.register(llmOauthClientsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates, lists, updates, rotates, and deletes an LLM OAuth client", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({
      organizationId,
      name: "Production Model Router",
      agentType: "llm_proxy",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Backend Service",
        allowedLlmProxyIds: [agent.id],
        providerApiKeys: [
          {
            provider: "openai",
            providerApiKeyId: apiKey.id,
          },
        ],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.clientId).toMatch(/^llm_oauth_/);
    expect(created.clientSecret).toMatch(/^llm_secret_/);
    expect(created.providerApiKeys).toMatchObject([
      {
        provider: "openai",
        providerApiKeyId: apiKey.id,
      },
    ]);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/llm-oauth-clients",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);
    expect(listResponse.json()[0].name).toBe("Backend Service");

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/llm-oauth-clients/${created.id}`,
      payload: {
        name: "Updated Backend Service",
        allowedLlmProxyIds: [agent.id],
        providerApiKeys: [
          {
            provider: "openai",
            providerApiKeyId: apiKey.id,
          },
        ],
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      name: "Updated Backend Service",
      allowedLlmProxyIds: [agent.id],
      providerApiKeys: [
        {
          provider: "openai",
          providerApiKeyId: apiKey.id,
        },
      ],
    });

    const rotateResponse = await app.inject({
      method: "POST",
      url: `/api/llm-oauth-clients/${created.id}/rotate-secret`,
    });
    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json().clientSecret).toMatch(/^llm_secret_/);
    expect(rotateResponse.json().clientSecret).not.toBe(created.clientSecret);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-oauth-clients/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });

  test("filters LLM OAuth clients by search and provider API key", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({
      organizationId,
      name: "Filter Proxy",
      agentType: "llm_proxy",
    });
    const firstSecret = await makeSecret({ secret: { apiKey: "sk-first" } });
    const secondSecret = await makeSecret({ secret: { apiKey: "sk-second" } });
    const firstKey = await makeLlmProviderApiKey(
      organizationId,
      firstSecret.id,
      { provider: "openai" },
    );
    const secondKey = await makeLlmProviderApiKey(
      organizationId,
      secondSecret.id,
      { provider: "anthropic" },
    );

    await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Searchable Service",
        allowedLlmProxyIds: [agent.id],
        providerApiKeys: [
          { provider: "openai", providerApiKeyId: firstKey.id },
        ],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Other Client",
        allowedLlmProxyIds: [agent.id],
        providerApiKeys: [
          { provider: "anthropic", providerApiKeyId: secondKey.id },
        ],
      },
    });

    const searchResponse = await app.inject({
      method: "GET",
      url: "/api/llm-oauth-clients?search=searchable",
    });
    expect(searchResponse.statusCode).toBe(200);
    expect(
      searchResponse.json().map((client: { name: string }) => client.name),
    ).toEqual(["Searchable Service"]);

    const providerKeyResponse = await app.inject({
      method: "GET",
      url: `/api/llm-oauth-clients?providerApiKeyId=${secondKey.id}`,
    });
    expect(providerKeyResponse.statusCode).toBe(200);
    expect(
      providerKeyResponse.json().map((client: { name: string }) => client.name),
    ).toEqual(["Other Client"]);
  });

  test("rejects duplicate provider mappings", async ({
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({
      organizationId,
      name: "Duplicate Mapping Proxy",
      agentType: "llm_proxy",
    });
    const firstSecret = await makeSecret({ secret: { apiKey: "sk-first" } });
    const secondSecret = await makeSecret({ secret: { apiKey: "sk-second" } });
    const firstKey = await makeLlmProviderApiKey(
      organizationId,
      firstSecret.id,
      { provider: "openai" },
    );
    const secondKey = await makeLlmProviderApiKey(
      organizationId,
      secondSecret.id,
      { provider: "openai" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Duplicate Mapping Client",
        allowedLlmProxyIds: [agent.id],
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

  test("creates an authorization_code client registered as a confidential, PKCE client", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Agentic Chat Server",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.clientId).toMatch(/^llm_oauth_/);
    expect(created.clientSecret).toMatch(/^llm_secret_/);
    expect(created.grantType).toBe("authorization_code");
    expect(created.redirectUris).toEqual([
      "https://chat.example.com/oauth/callback",
    ]);
    // authorization_code access + provider keys are governed by the acting user.
    expect(created.allowedLlmProxyIds).toEqual([]);
    expect(created.providerApiKeys).toEqual([]);

    // The underlying oauth_client row must be wired for better-auth's
    // authorize→token exchange (confidential, PKCE, llm:proxy + offline_access).
    const [row] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.id, created.id));
    expect(row.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    expect(row.responseTypes).toEqual(["code"]);
    expect(row.requirePKCE).toBe(true);
    expect(row.public).toBe(false);
    expect(row.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(row.scopes).toEqual(
      expect.arrayContaining(["llm:proxy", "offline_access"]),
    );
    // better-auth verifies the secret at the token endpoint by hashing the
    // presented value and comparing it to what is stored, so the stored secret
    // must be exactly this deterministic hash (not a bcrypt hash, which it could
    // never match). This is the contract that makes the real token exchange work.
    expect(row.clientSecret).toBe(hashOauthClientSecret(created.clientSecret));
  });

  test("requires at least one redirect URI for authorization_code clients", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: { name: "No Redirects", grantType: "authorization_code" },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects an invalid redirect URI", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Bad Redirect",
        grantType: "authorization_code",
        redirectUris: ["not-a-url"],
      },
    });

    expect(response.statusCode).toBe(400);
  });

  test("does not require proxies or provider keys for authorization_code clients", async () => {
    // No LLM proxy or provider key exists, yet an authorization_code client must
    // still be creatable — its access and keys come from the acting user.
    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
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
        url: "/api/llm-oauth-clients",
        payload: {
          name: "Chat Server",
          grantType: "authorization_code",
          redirectUris: ["https://chat.example.com/oauth/callback"],
        },
      })
    ).json();

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/llm-oauth-clients/${created.id}`,
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

  test("creates an authorization_code client with an additive proxy grant", async ({
    makeAgent,
  }) => {
    const proxy = await makeAgent({
      organizationId,
      name: "Chat Proxy",
      agentType: "llm_proxy",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Chat Interface",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
        allowedLlmProxyIds: [proxy.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().grantType).toBe("authorization_code");
    expect(response.json().allowedLlmProxyIds).toEqual([proxy.id]);
    // provider keys never apply to authorization_code clients.
    expect(response.json().providerApiKeys).toEqual([]);
  });

  test("validates the proxy grant on an authorization_code client", async ({
    makeAgent,
  }) => {
    // A non-llm_proxy agent in the grant list is rejected.
    const gateway = await makeAgent({
      organizationId,
      name: "Not A Proxy",
      agentType: "mcp_gateway",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Chat Interface",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
        allowedLlmProxyIds: [gateway.id],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("LLM proxy not found");
  });
});
