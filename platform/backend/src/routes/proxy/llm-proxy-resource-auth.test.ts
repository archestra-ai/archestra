import { LLM_PROXY_OAUTH_SCOPE } from "@archestra/shared";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import {
  LlmProviderApiKeyModel,
  ManagedOauthClientModel,
  MemberModel,
  OAuthAccessTokenModel,
  OrganizationModel,
  UserTokenModel,
  VirtualApiKeyModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import {
  type ProxyResourceCredential,
  resolveProxyResourceCredential,
} from "./llm-proxy-resource-auth";

describe("provider resource authentication", () => {
  setupTestCacheManager();
  let app: ReturnType<typeof createFastifyInstance>;
  let organizationId: string;
  let agentId: string;
  let keyId: string;
  let token: string;
  let virtualKeyId: string;
  let resolved: ProxyResourceCredential | undefined;

  beforeEach(async ({ makeAgent, makeSecret, makeLlmProviderApiKey }) => {
    config.llm.azure.entraIdEnabled = false;
    const agent = await makeAgent({
      agentType: "llm_proxy",
      isDefault: true,
      access: "org",
    });
    organizationId = agent.organizationId;
    agentId = agent.id;
    const secret = await makeSecret({
      secret: { apiKey: "synthetic-managed-provider-key" },
    });
    const key = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "azure",
      baseUrl: "https://resource.example/openai/deployments/sdk",
      access: "org",
    });
    keyId = key.id;
    const created = await VirtualApiKeyModel.create({
      organizationId,
      name: "File test",
      providerApiKeys: [{ provider: "azure", providerApiKeyId: keyId }],
    });
    token = created.value;
    virtualKeyId = created.virtualKey.id;
    resolved = undefined;
    app = createFastifyInstance();
    app.get("/v1/azure/:agentId/files", async (request) => {
      resolved = await resolveProxyResourceCredential({
        request,
        provider: "azure",
        agentId: (request.params as { agentId: string }).agentId,
      });
      return {
        principal: resolved.principal,
        account: resolved.providerAccount,
      };
    });
  });
  afterEach(async () => {
    await app.close();
  });
  const call = (
    credential = token,
    headers: Record<string, string> = {},
    targetAgent = agentId,
  ) =>
    app.inject({
      method: "GET",
      url: `/v1/azure/${targetAgent}/openai/files`,
      headers: { "api-key": credential, ...headers },
    });

  test("resolves a managed key to a nonsecret stable account binding", async () => {
    const response = await call();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      principal: { kind: "virtual_key", id: virtualKeyId },
      account: {
        providerApiKeyId: keyId,
        baseUrl: "https://resource.example/openai",
      },
    });
    expect(resolved?.apiKey).toBe("synthetic-managed-provider-key");
    const first = response.json().account.credentialBinding;
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(response.json())).not.toContain(token);
    expect(JSON.stringify(response.json())).not.toContain(
      "synthetic-managed-provider-key",
    );
    expect((await call()).json().account.credentialBinding).toBe(first);
  });

  test("no anonymous access even when unauthenticated inference is enabled", async () => {
    await OrganizationModel.patch(organizationId, {
      allowUnauthenticatedLlmProxyRequests: true,
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/azure/${agentId}/openai/files`,
    });
    expect(response.statusCode).toBe(401);
    expect((await call("untrusted-provider-key")).statusCode).toBe(401);
    expect(resolved).toBeUndefined();
  });

  test("multiple mapped accounts require a validated explicit selector", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({
      secret: { apiKey: "second-account-key" },
    });
    const other = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "azure",
      baseUrl: "https://second.example/openai/v1",
    });
    const mapped = await VirtualApiKeyModel.create({
      organizationId,
      name: "Two accounts",
      providerApiKeys: [
        { provider: "azure", providerApiKeyId: keyId },
        { provider: "azure", providerApiKeyId: other.id },
      ],
    });
    expect((await call(mapped.value)).statusCode).toBe(400);
    const response = await call(mapped.value, {
      "provider-api-key-id": other.id,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().account.providerApiKeyId).toBe(other.id);
    expect(resolved?.apiKey).toBe("second-account-key");
  });

  test("a selector does not grant another tenant or unmapped account", async ({
    makeOrganization,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const otherOrg = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "other-org-secret" } });
    const other = await makeLlmProviderApiKey(otherOrg.id, secret.id, {
      provider: "azure",
      baseUrl: "https://other.example/openai",
    });
    expect(
      (await call(token, { "provider-api-key-id": other.id })).statusCode,
    ).toBe(403);
    expect(resolved).toBeUndefined();
  });

  test("a key from another organization cannot use this agent", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const other = await makeAgent({
      organizationId: org.id,
      agentType: "agent",
    });
    expect((await call(token, {}, other.id)).statusCode).toBe(403);
    expect(resolved).toBeUndefined();
  });

  test("a different provider mapping cannot access Azure files", async ({
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const secret = await makeSecret({ secret: { apiKey: "openai-account" } });
    const other = await makeLlmProviderApiKey(organizationId, secret.id, {
      provider: "openai",
    });
    const mapped = await VirtualApiKeyModel.create({
      organizationId,
      name: "Different provider",
      providerApiKeys: [{ provider: "openai", providerApiKeyId: other.id }],
    });
    expect((await call(mapped.value)).statusCode).toBe(400);
    expect(resolved).toBeUndefined();
  });

  test("changing resource endpoint or account headers changes the ledger binding", async () => {
    const first = (await call()).json().account.credentialBinding;
    await LlmProviderApiKeyModel.update(keyId, {
      extraHeaders: { "openai-project": "synthetic-project" },
    });
    const second = (await call()).json().account.credentialBinding;
    await LlmProviderApiKeyModel.update(keyId, {
      baseUrl: "https://second.example/openai",
    });
    const third = (await call()).json().account.credentialBinding;
    expect(new Set([first, second, third]).size).toBe(3);
  });

  test("credential replacement changes the binding without exposing either key", async ({
    makeSecret,
  }) => {
    const first = (await call()).json().account.credentialBinding;
    const secret = await makeSecret({
      secret: { apiKey: "replacement-provider-key" },
    });
    await LlmProviderApiKeyModel.update(keyId, { secretId: secret.id });
    const response = await call();
    expect(response.json().account.credentialBinding).not.toBe(first);
    expect(response.body).not.toContain("replacement-provider-key");
  });

  test("passthrough keys preserve caller credentials and isolate provider accounts", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const passthrough = await makePassthroughCredential({
      organizationId,
      ownerId: user.id,
    });
    const headers = { "x-archestra-virtual-key": passthrough };
    const first = await call("first-provider-key", headers);
    expect(first.statusCode, first.body).toBe(200);
    expect(resolved?.apiKey).toBe("first-provider-key");
    const second = await call("second-provider-key", headers);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().principal).toEqual({ kind: "user", id: user.id });
    expect(second.json().account.credentialBinding).not.toBe(
      first.json().account.credentialBinding,
    );
  });

  test("personal platform tokens resolve unique granted account and current membership", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    await makeMember(user.id, organizationId);
    const row = await UserTokenModel.ensureUserToken(user.id, organizationId);
    const value = await UserTokenModel.getTokenValue(row.id);
    if (!value) throw new Error("Fixture did not create a platform token");
    const response = await call(value);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().principal).toEqual({ kind: "user", id: user.id });
    await MemberModel.deleteByMemberOrUserId(user.id, organizationId);
    expect((await call(value)).statusCode).toBe(403);
  });

  test("keyless configured Azure accounts keep a stable binding across refresh", async () => {
    config.llm.azure.entraIdEnabled = true;
    await LlmProviderApiKeyModel.update(keyId, { secretId: null });
    const first = await call();
    expect(first.statusCode, first.body).toBe(200);
    expect(resolved?.apiKey).toBeUndefined();
    expect((await call()).json().account.credentialBinding).toBe(
      first.json().account.credentialBinding,
    );
  });

  test("missing stored credential never falls back to an environment key", async () => {
    await LlmProviderApiKeyModel.update(keyId, { secretId: null });
    expect((await call()).statusCode).toBe(401);
    expect(resolved).toBeUndefined();
  });

  test("OAuth client credentials retain strict mapped-account selection", async () => {
    const { oauthClient } = await ManagedOauthClientModel.create({
      organizationId,
      authorId: crypto.randomUUID(),
      name: "Resource client",
      providerApiKeys: [{ provider: "azure", providerApiKeyId: keyId }],
    });
    const raw = "synthetic-resource-oauth-token";
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash: OAuthAccessTokenModel.hashTokenForLookup(raw),
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });
    const response = await call(raw);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().principal).toEqual({
      kind: "oauth_client",
      id: oauthClient.id,
    });
    expect(response.json().account.providerApiKeyId).toBe(keyId);
  });
});
