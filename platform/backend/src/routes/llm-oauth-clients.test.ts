import { eq } from "drizzle-orm";
import { hashOauthClientSecret } from "@/auth/oauth-client-secret";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { encodeXaiSubscriptionCredential } from "@/services/xai-subscription-credentials";
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
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-openai" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Backend Service",
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
    expect(listResponse.json().data).toHaveLength(1);
    expect(listResponse.json().data[0].name).toBe("Backend Service");
    expect(listResponse.json().pagination.total).toBe(1);

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/llm-oauth-clients/${created.id}`,
      payload: {
        name: "Updated Backend Service",
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
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
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
      searchResponse.json().data.map((client: { name: string }) => client.name),
    ).toEqual(["Searchable Service"]);

    const providerKeyResponse = await app.inject({
      method: "GET",
      url: `/api/llm-oauth-clients?providerApiKeyId=${secondKey.id}`,
    });
    expect(providerKeyResponse.statusCode).toBe(200);
    expect(
      providerKeyResponse
        .json()
        .data.map((client: { name: string }) => client.name),
    ).toEqual(["Other Client"]);
  });

  test("rejects duplicate provider mappings", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
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

  test("rejects a credential-level subscription mapping for client credentials", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({
      secret: {
        apiKey: `bearer ${encodeXaiSubscriptionCredential({
          refreshToken: "rt-personal",
          userId: "x-user",
        })}`,
      },
    });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "xai",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Unsafe Subscription Client",
        providerApiKeys: [{ provider: "xai", providerApiKeyId: apiKey.id }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("SuperGrok is per-user");
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
    // authorization_code provider keys are governed by the acting user.
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

  test("does not require provider keys for authorization_code clients", async () => {
    // No provider key exists, yet an authorization_code client must still be
    // creatable — its keys come from the acting user.
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

  test("filters LLM OAuth clients by grant type", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "sk-grant" } });
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Service Credential",
        providerApiKeys: [{ provider: "openai", providerApiKeyId: apiKey.id }],
      },
    });
    await app.inject({
      method: "POST",
      url: "/api/llm-oauth-clients",
      payload: {
        name: "Chat Login",
        grantType: "authorization_code",
        redirectUris: ["https://chat.example.com/oauth/callback"],
      },
    });

    const clientCredentials = await app.inject({
      method: "GET",
      url: "/api/llm-oauth-clients?grantType=client_credentials",
    });
    expect(clientCredentials.statusCode).toBe(200);
    expect(
      clientCredentials
        .json()
        .data.map((client: { name: string }) => client.name),
    ).toEqual(["Service Credential"]);
    expect(clientCredentials.json().pagination.total).toBe(1);

    const authorizationCode = await app.inject({
      method: "GET",
      url: "/api/llm-oauth-clients?grantType=authorization_code",
    });
    expect(authorizationCode.statusCode).toBe(200);
    expect(
      authorizationCode
        .json()
        .data.map((client: { name: string }) => client.name),
    ).toEqual(["Chat Login"]);
  });

  test("paginates LLM OAuth clients", async () => {
    for (const name of ["page-a", "page-b", "page-c"]) {
      await app.inject({
        method: "POST",
        url: "/api/llm-oauth-clients",
        payload: {
          name,
          grantType: "authorization_code",
          redirectUris: ["https://chat.example.com/oauth/callback"],
        },
      });
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/llm-oauth-clients?limit=2&offset=0",
    });
    expect(firstPage.statusCode).toBe(200);
    const firstBody = firstPage.json();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.pagination).toMatchObject({
      total: 3,
      limit: 2,
      totalPages: 2,
      hasNext: true,
      hasPrev: false,
    });

    const secondPage = await app.inject({
      method: "GET",
      url: "/api/llm-oauth-clients?limit=2&offset=2",
    });
    expect(secondPage.statusCode).toBe(200);
    const secondBody = secondPage.json();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.pagination).toMatchObject({
      hasNext: false,
      hasPrev: true,
    });

    const seen = [...firstBody.data, ...secondBody.data].map(
      (client: { name: string }) => client.name,
    );
    expect([...seen].sort()).toEqual(["page-a", "page-b", "page-c"]);
  });
});
