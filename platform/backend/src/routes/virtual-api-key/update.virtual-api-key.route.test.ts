import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ModelPoolModel, VirtualApiKeyModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { grantEverywhere } from "@/test/wildcard-grants";
import type { User } from "@/types";

describe("PATCH /api/llm-virtual-keys/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });

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

    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-key.routes"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("owners can replace their own personal Copilot mapping", async ({
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: "member" });
    const secret = await makeSecret({ secret: { apiKey: "gho_own" } });
    const original = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
      userId: user.id,
    });
    const replacement = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
      userId: user.id,
    });
    const key = await makeVirtualApiKey(organizationId, {
      authorId: user.id,
      access: "personal",
      providerApiKeys: [
        { provider: original.provider, providerApiKeyId: original.id },
      ],
    });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${key.id}`,
      payload: {
        name: "Own replacement",
        providerApiKeys: [
          { provider: replacement.provider, providerApiKeyId: replacement.id },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ authorId: user.id });
    expect(await VirtualApiKeyModel.getProviderApiKeys(key.id)).toEqual([
      expect.objectContaining({ providerApiKeyId: replacement.id }),
    ]);
  });

  test("human administrators cannot retain another owner's personal Copilot mapping", async ({
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
    makeVirtualApiKey,
  }) => {
    const owner = await makeUser();
    await makeMember(owner.id, organizationId);
    const secret = await makeSecret({ secret: { apiKey: "gho_owner" } });
    const credential = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "github-copilot",
      userId: owner.id,
    });
    const key = await makeVirtualApiKey(organizationId, {
      authorId: owner.id,
      access: "personal",
      providerApiKeys: [
        { provider: credential.provider, providerApiKeyId: credential.id },
      ],
    });
    const before = await VirtualApiKeyModel.findByIdForAudit(
      key.id,
      organizationId,
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${key.id}`,
      payload: {
        name: "Not authorized",
        providerApiKeys: [
          { provider: credential.provider, providerApiKeyId: credential.id },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(
      await VirtualApiKeyModel.findByIdForAudit(key.id, organizationId),
    ).toEqual(before);
  });

  test("sets the key's model pools, and keeps them when an edit omits them", async ({
    makeLlmProviderApiKey,
  }) => {
    grantEverywhere(["llmVirtualKey"]);
    config.llmProxy.modelPoolsEnabled = true;
    try {
      const zai = await makeLlmProviderApiKey(organizationId, null, {
        provider: "zhipuai",
      });
      const openai = await makeLlmProviderApiKey(organizationId, null, {
        provider: "openai",
      });
      const pool = await ModelPoolModel.create({
        organizationId,
        input: {
          name: "glm-5",
          members: [
            {
              providerApiKeyId: zai.id,
              modelId: "glm-5",
              priority: 1,
              weight: 1,
              enabled: true,
            },
          ],
        },
      });
      const providerApiKeys = [
        { provider: "openai", providerApiKeyId: openai.id },
      ];
      const created = await app.inject({
        method: "POST",
        url: "/api/llm-virtual-keys",
        payload: { name: "pool key", providerApiKeys, modelPoolIds: [pool.id] },
      });
      expect(created.statusCode, created.body).toBe(200);
      const id = created.json().id;
      const grantedKeys = async () =>
        (await ModelPoolModel.findById({ organizationId, id: pool.id }))
          ?.virtualApiKeyIds;
      expect(await grantedKeys()).toEqual([id]);

      const update = (payload: Record<string, unknown>) =>
        app.inject({
          method: "PATCH",
          url: `/api/llm-virtual-keys/${id}`,
          payload: { name: "pool key", providerApiKeys, ...payload },
        });
      expect((await update({})).statusCode).toBe(200);
      expect(await grantedKeys()).toEqual([id]);
      expect(
        (await update({ modelPoolIds: [crypto.randomUUID()] })).statusCode,
      ).toBe(400);
      expect((await update({ modelPoolIds: [] })).statusCode).toBe(200);
      expect(await grantedKeys()).toEqual([]);
    } finally {
      config.llmProxy.modelPoolsEnabled = false;
    }
  });

  test("PATCH /api/llm-virtual-keys/:id updates the name and provider mappings without re-exposing the token", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
      name: "OpenAI Parent",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "before-rename",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const id = createResponse.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${id}`,
      payload: {
        name: "after-rename",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.id).toBe(id);
    expect(body.name).toBe("after-rename");
    expect(body.value).toBeUndefined();
    expect(body.providerApiKeys).toEqual([
      {
        provider: "openai",
        providerApiKeyId: parentKey.id,
        providerApiKeyName: "OpenAI Parent",
      },
    ]);
  });

  test("PATCH /api/llm-virtual-keys/:id adds and removes endpoints of a self-hosted provider", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    grantEverywhere(["llmVirtualKey"]);
    const endpoints = [];
    for (const name of ["GLM gateway", "DeepSeek gateway"]) {
      endpoints.push(
        await makeLlmProviderApiKey(
          organizationId,
          (await makeSecret({ secret: { apiKey: `sk-${name}` } })).id,
          { provider: "vllm", name },
        ),
      );
    }
    const mapping = (key: { id: string }) => ({
      provider: "vllm",
      providerApiKeyId: key.id,
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "endpoint-key",
        providerApiKeys: [mapping(endpoints[0])],
      },
    });
    const id = createResponse.json().id;
    const patch = (keys: Array<{ id: string }>) =>
      app.inject({
        method: "PATCH",
        url: `/api/llm-virtual-keys/${id}`,
        payload: { name: "endpoint-key", providerApiKeys: keys.map(mapping) },
      });
    const mappedNames = (response: { json: () => unknown }) =>
      (
        response.json() as {
          providerApiKeys: Array<{ providerApiKeyName: string }>;
        }
      ).providerApiKeys.map((key) => key.providerApiKeyName);

    const added = await patch(endpoints);
    expect(added.statusCode).toBe(200);
    expect(mappedNames(added)).toEqual(["GLM gateway", "DeepSeek gateway"]);

    const removed = await patch([endpoints[1]]);
    expect(removed.statusCode).toBe(200);
    expect(mappedNames(removed)).toEqual(["DeepSeek gateway"]);
  });

  test("PATCH /api/llm-virtual-keys/:id returns 404 for an unknown key", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/llm-virtual-keys/00000000-0000-0000-0000-000000000000",
      payload: {
        name: "ghost",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { message: "Virtual API key not found" },
    });
  });

  test("PATCH /api/llm-virtual-keys/:id rejects past expiration dates", async ({
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "expiry-target",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });
    expect(createResponse.statusCode).toBe(200);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${createResponse.json().id}`,
      payload: {
        name: "expiry-target",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { message: "Expiration date must be in the future" },
    });
  });

  test("PATCH preserves the owner when an admin edits a key minted for another user", async ({
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
    makeMember,
  }) => {
    grantEverywhere(["llmVirtualKey"]);

    const secret = await makeSecret({ secret: { apiKey: "sk-real" } });
    const parentKey = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });
    const target = await makeUser();
    await makeMember(target.id, organizationId);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: {
        name: "owned-by-target",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
        ownerId: target.id,
      },
    });
    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json().authorId).toBe(target.id);
    const id = createResponse.json().id;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${id}`,
      payload: {
        name: "renamed-by-admin",
        scope: "personal",
        providerApiKeys: [
          { provider: parentKey.provider, providerApiKeyId: parentKey.id },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().name).toBe("renamed-by-admin");
    expect(response.json().authorId).toBe(target.id);
  });
});
