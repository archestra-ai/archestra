import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import llmProviderApiKeyRoutes from "./llm-provider-api-keys";

describe("deleting an LLM provider API key that other credentials map to", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(llmProviderApiKeyRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("single delete removes the virtual-key mapping and keeps the virtual key", async ({
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const virtualKey = await makeVirtualApiKey(organizationId, {
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId: apiKey.id }],
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${apiKey.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await LlmProviderApiKeyModel.findById(apiKey.id)).toBeNull();
    expect(await VirtualApiKeyModel.findById(virtualKey.id)).not.toBeNull();
    expect(await VirtualApiKeyModel.getProviderApiKeys(virtualKey.id)).toEqual(
      [],
    );
  });

  test("bulk delete removes the virtual-key mapping and keeps the virtual key", async ({
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      name: "mapped-key",
    });
    const virtualKey = await makeVirtualApiKey(organizationId, {
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId: apiKey.id }],
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/llm-provider-api-keys/bulk",
      payload: { ids: [apiKey.id] },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: apiKey.id, name: "mapped-key" }],
      failed: [],
    });
    expect(await VirtualApiKeyModel.findById(virtualKey.id)).not.toBeNull();
    expect(await VirtualApiKeyModel.getProviderApiKeys(virtualKey.id)).toEqual(
      [],
    );
  });

  test("an OAuth-client mapping still blocks deletion", async ({
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const virtualKey = await makeVirtualApiKey(organizationId, {
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId: apiKey.id }],
    });
    await LlmOauthClientModel.create({
      organizationId,
      authorId: user.id,
      name: "Backend Service",
      providerApiKeys: [{ provider: "anthropic", providerApiKeyId: apiKey.id }],
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/llm-provider-api-keys/${apiKey.id}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "This API key is mapped to one or more OAuth clients. Remove those mappings before deleting it.",
    );
    expect(await LlmProviderApiKeyModel.findById(apiKey.id)).not.toBeNull();
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualKey.id),
    ).toHaveLength(1);
  });
});
