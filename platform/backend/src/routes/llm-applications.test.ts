import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("llmApplicationsRoutes", () => {
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

    const { default: llmApplicationsRoutes } = await import(
      "./llm-applications"
    );
    await app.register(llmApplicationsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates, lists, updates, rotates, and deletes an LLM application", async ({
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
      url: "/api/llm-applications",
      payload: {
        name: "Backend Service",
        allowedLlmProxyIds: [agent.id],
        modelRouterProviderApiKeys: [
          {
            provider: "openai",
            chatApiKeyId: apiKey.id,
          },
        ],
      },
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.clientId).toMatch(/^llm_app_/);
    expect(created.clientSecret).toMatch(/^llm_secret_/);
    expect(created.modelRouterProviderApiKeys).toMatchObject([
      {
        provider: "openai",
        chatApiKeyId: apiKey.id,
      },
    ]);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/llm-applications",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toHaveLength(1);
    expect(listResponse.json()[0].name).toBe("Backend Service");

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/llm-applications/${created.id}`,
      payload: {
        name: "Updated Backend Service",
        allowedLlmProxyIds: [agent.id],
        modelRouterProviderApiKeys: [
          {
            provider: "openai",
            chatApiKeyId: apiKey.id,
          },
        ],
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: created.id,
      name: "Updated Backend Service",
      allowedLlmProxyIds: [agent.id],
      modelRouterProviderApiKeys: [
        {
          provider: "openai",
          chatApiKeyId: apiKey.id,
        },
      ],
    });

    const rotateResponse = await app.inject({
      method: "POST",
      url: `/api/llm-applications/${created.id}/rotate-secret`,
    });
    expect(rotateResponse.statusCode).toBe(200);
    expect(rotateResponse.json().clientSecret).toMatch(/^llm_secret_/);
    expect(rotateResponse.json().clientSecret).not.toBe(created.clientSecret);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/llm-applications/${created.id}`,
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });
  });
});
