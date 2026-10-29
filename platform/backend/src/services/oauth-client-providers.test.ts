import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { createFastifyInstance } from "@/fastify-instance";
import AgentModel from "@/models/agent";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ManagedOauthClientModel from "@/models/managed-oauth-client";
import ModelModel from "@/models/model";
import ServiceAccountModel from "@/models/service-account";
import { validateLlmOAuthAccessToken } from "@/routes/proxy/llm-proxy-auth";
import modelRouterRoutes from "@/routes/proxy/routes/model-router";
import { describe, expect, test } from "@/test";
import { issueManagedOauthClientAccessToken } from "./oauth-client-credentials";
import { resolveOauthClientProviderMappings } from "./oauth-client-providers";
import { encodeOpenAiCodexCredential } from "./openai-codex-credentials";

describe("OAuth client provider access", () => {
  test("one token follows new providers and primary changes in both proxy auth and model-router while preserving overrides", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const proxy = await makeAgent({
      organizationId: org.id,
      agentType: "llm_proxy",
    });
    const secret = await makeSecret({ secret: { apiKey: "sk-shared" } });
    const primary = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    const override = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: false,
    });
    const { oauthClient, clientSecret } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: owner.id,
      name: "Automatic provider access",
      scopes: ["llm:proxy"],
      includeFutureProviders: true,
      providerApiKeys: [{ provider: "openai", providerApiKeyId: override.id }],
    });
    const issued = await issueManagedOauthClientAccessToken({
      clientId: oauthClient.clientId,
      clientSecret,
    });
    expect(issued.ok).toBe(true);
    const token = String(issued.body.access_token);
    expect(
      (await resolveOauthClientProviderMappings(oauthClient)).map(
        (key) => key.providerApiKeyId,
      ),
    ).toEqual([override.id]);

    const later = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    expect(
      await validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: "gemini",
        agent: proxy,
      }),
    ).toMatchObject({ chatApiKeyId: later.id });
    const model = await ModelModel.upsert({
      externalId: "gemini/automatic-model",
      provider: "gemini",
      modelId: "automatic-model",
      inputModalities: ["text"],
      outputModalities: ["text"],
      lastSyncedAt: new Date(),
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(later.id, [
      model.id,
    ]);
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    try {
      const models = async () =>
        app.inject({
          method: "GET",
          url: `/v1/model-router/${proxy.id}/models`,
          headers: { authorization: `Bearer ${token}` },
        });
      const first = await models();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().data).toContainEqual(
        expect.objectContaining({ id: "gemini:automatic-model" }),
      );
      await LlmProviderApiKeyModel.update(later.id, { isPrimary: false });
      const replacement = await makeLlmProviderApiKey(org.id, secret.id, {
        provider: "gemini",
        isPrimary: true,
      });
      expect(
        await validateLlmOAuthAccessToken({
          tokenValue: token,
          expectedProvider: "gemini",
          agent: proxy,
        }),
      ).toMatchObject({ chatApiKeyId: replacement.id });
      expect((await models()).json().data).toEqual([]);
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(replacement.id, [
        model.id,
      ]);
      expect((await models()).json().data).toContainEqual(
        expect.objectContaining({ id: "gemini:automatic-model" }),
      );
      const effective = await resolveOauthClientProviderMappings(oauthClient);
      expect(effective.map((key) => key.providerApiKeyId)).toEqual([
        override.id,
        replacement.id,
      ]);
      expect(effective.some((key) => key.providerApiKeyId === primary.id)).toBe(
        false,
      );
      const persisted = await ManagedOauthClientModel.findById({
        id: oauthClient.id,
        organizationId: org.id,
      });
      expect(
        persisted?.providerApiKeys.map((key) => key.providerApiKeyId),
      ).toEqual([override.id]);
    } finally {
      await app.close();
    }
  });

  test("automatic keys exclude foreign, personal, subscription, non-primary and unusable credentials; selected mode stays fixed", async ({
    makeOrganization,
    makeUser,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const foreignOrg = await makeOrganization();
    const owner = await makeUser();
    const secret = await makeSecret({ secret: { apiKey: "sk-shared" } });
    const subscription = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "refresh-test",
          accountId: "account-test",
        }),
      },
    });
    const shared = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(foreignOrg.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      userId: owner.id,
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, subscription.id, {
      provider: "openai",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "github-copilot",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "groq",
      isPrimary: false,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      isPrimary: true,
    });
    const expired = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "mistral",
      isPrimary: true,
    });
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: expired.id,
      requiresReauthentication: true,
    });
    const { oauthClient } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: owner.id,
      name: "Automatic",
      includeFutureProviders: true,
      providerApiKeys: [],
    });
    expect(
      (await resolveOauthClientProviderMappings(oauthClient)).map(
        (key) => key.providerApiKeyId,
      ),
    ).toEqual([shared.id]);
    const fixed = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: owner.id,
      name: "Selected",
      providerApiKeys: [],
    });
    expect(fixed.oauthClient.includeFutureProviders).toBe(false);
    expect(await resolveOauthClientProviderMappings(fixed.oauthClient)).toEqual(
      [],
    );
    // Legacy metadata without the field must retain selected-only access.
    await db
      .update(schema.oauthClientsTable)
      .set({
        metadata: sql`${schema.oauthClientsTable.metadata} - 'includeFutureProviders'`,
      })
      .where(eq(schema.oauthClientsTable.id, fixed.oauthClient.id));
    const legacy = await ManagedOauthClientModel.findById({
      id: fixed.oauthClient.id,
      organizationId: org.id,
    });
    expect(legacy?.includeFutureProviders).toBe(false);
  });

  test("dynamic clients keep live service-account checks in both authorization paths", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeServiceAccount,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const privateProxy = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
      access: "personal",
    });
    const proxy = await AgentModel.getOrgLlmProxy(org.id);
    const account = await makeServiceAccount(org.id);
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    const { oauthClient, clientSecret } = await ManagedOauthClientModel.create({
      organizationId: org.id,
      authorId: owner.id,
      name: "Bound automatic",
      serviceAccountId: account.id,
      includeFutureProviders: true,
      providerApiKeys: [],
    });
    const issued = await issueManagedOauthClientAccessToken({
      clientId: oauthClient.clientId,
      clientSecret,
    });
    const token = String(issued.body.access_token);
    await expect(
      validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: "openai",
        agent: privateProxy,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(
      await validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: "openai",
        agent: proxy,
      }),
    ).toMatchObject({ chatApiKeyId: key.id, serviceAccountId: account.id });
    await ServiceAccountModel.update(account.id, org.id, { disabled: true });
    await expect(
      validateLlmOAuthAccessToken({
        tokenValue: token,
        expectedProvider: "openai",
        agent: proxy,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    const app = createFastifyInstance();
    await app.register(modelRouterRoutes);
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/model-router/${proxy.id}/models`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
