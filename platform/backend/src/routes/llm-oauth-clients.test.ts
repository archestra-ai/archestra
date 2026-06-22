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
});
