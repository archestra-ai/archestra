import { LLM_PROXY_OAUTH_SCOPE } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import { LLM_OAUTH_CLIENT_METADATA_TYPE } from "@/types/llm-oauth-client";
import LlmOauthClientModel from "./llm-oauth-client";
import OAuthAccessTokenModel from "./oauth-access-token";

describe("LlmOauthClientModel", () => {
  test("creates and hydrates an LLM OAuth client with a one-time secret", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const organization = await makeOrganization();
    const secret = await makeSecret();
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      {
        name: "Primary Provider Key",
      },
    );

    const result = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Backend Service",
      allowedLlmProxyIds: [crypto.randomUUID()],
      providerApiKeys: [
        {
          provider: "anthropic",
          providerApiKeyId: providerKey.id,
        },
      ],
    });

    expect(result.clientSecret).toMatch(/^llm_secret_/);
    expect(result.oauthClient.clientId).toMatch(/^llm_oauth_/);
    expect(result.oauthClient.name).toBe("Backend Service");
    expect(result.oauthClient.organizationId).toBe(organization.id);
    expect(result.oauthClient.allowedLlmProxyIds).toHaveLength(1);
    expect(result.oauthClient.providerApiKeys).toEqual([
      {
        provider: "anthropic",
        providerApiKeyId: providerKey.id,
        providerApiKeyName: "Primary Provider Key",
      },
    ]);

    const found = await LlmOauthClientModel.findByClientId(
      result.oauthClient.clientId,
    );
    expect(found?.id).toBe(result.oauthClient.id);
  });

  test("verifies credentials and rejects invalid or disabled clients", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Worker",
      allowedLlmProxyIds: [],
      providerApiKeys: [],
    });

    const verified = await LlmOauthClientModel.findClientForCredentials({
      clientId: oauthClient.clientId,
      clientSecret,
    });
    expect(verified?.id).toBe(oauthClient.id);

    const rejected = await LlmOauthClientModel.findClientForCredentials({
      clientId: oauthClient.clientId,
      clientSecret: "wrong-secret",
    });
    expect(rejected).toBeNull();
  });

  test("scopes reads, updates, rotates, and deletes by organization", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const firstProxyId = crypto.randomUUID();
    const secondProxyId = crypto.randomUUID();
    const { oauthClient, clientSecret } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Original",
      allowedLlmProxyIds: [firstProxyId],
      providerApiKeys: [],
    });

    expect(
      await LlmOauthClientModel.findById({
        id: oauthClient.id,
        organizationId: otherOrganization.id,
      }),
    ).toBeNull();

    expect(
      await LlmOauthClientModel.update({
        id: oauthClient.id,
        organizationId: otherOrganization.id,
        name: "Wrong Org",
        allowedLlmProxyIds: [],
        providerApiKeys: [],
      }),
    ).toBeNull();

    const updated = await LlmOauthClientModel.update({
      id: oauthClient.id,
      organizationId: organization.id,
      name: "Updated",
      allowedLlmProxyIds: [secondProxyId],
      providerApiKeys: [],
    });
    expect(updated?.name).toBe("Updated");
    expect(updated?.allowedLlmProxyIds).toEqual([secondProxyId]);

    const rotated = await LlmOauthClientModel.rotateSecret({
      id: oauthClient.id,
      organizationId: organization.id,
    });
    expect(rotated?.clientSecret).toMatch(/^llm_secret_/);
    expect(rotated?.clientSecret).not.toBe(clientSecret);

    const oldSecretResult = await LlmOauthClientModel.findClientForCredentials({
      clientId: oauthClient.clientId,
      clientSecret,
    });
    expect(oldSecretResult).toBeNull();

    const newSecretResult = await LlmOauthClientModel.findClientForCredentials({
      clientId: oauthClient.clientId,
      clientSecret: rotated?.clientSecret ?? "",
    });
    expect(newSecretResult?.id).toBe(oauthClient.id);

    expect(
      await LlmOauthClientModel.delete({
        id: oauthClient.id,
        organizationId: otherOrganization.id,
      }),
    ).toBe(false);
    expect(
      await LlmOauthClientModel.delete({
        id: oauthClient.id,
        organizationId: organization.id,
      }),
    ).toBe(true);
    expect(
      await LlmOauthClientModel.findById({
        id: oauthClient.id,
        organizationId: organization.id,
      }),
    ).toBeNull();
  });

  test("deleting an LLM OAuth client cascades issued access tokens", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Service With Tokens",
      allowedLlmProxyIds: [crypto.randomUUID()],
      providerApiKeys: [],
    });
    const accessToken = "llm-client-delete-cascade-token";
    const tokenHash = OAuthAccessTokenModel.hashTokenForLookup(accessToken);
    await OAuthAccessTokenModel.createClientCredentialsToken({
      tokenHash,
      clientId: oauthClient.clientId,
      expiresAt: new Date(Date.now() + 60_000),
      scopes: [LLM_PROXY_OAUTH_SCOPE],
      referenceId: `llm-proxy:${oauthClient.id}`,
    });

    expect(await OAuthAccessTokenModel.getByTokenHash(tokenHash)).toBeTruthy();

    expect(
      await LlmOauthClientModel.delete({
        id: oauthClient.id,
        organizationId: organization.id,
      }),
    ).toBe(true);

    expect(await OAuthAccessTokenModel.getByTokenHash(tokenHash)).toBeFalsy();
  });

  test("ignores non-LLM OAuth clients and malformed LLM metadata", async ({
    makeOAuthClient,
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await makeOAuthClient({ name: "Regular OAuth Client" });
    await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "LLM OAuth Client",
      allowedLlmProxyIds: [],
      providerApiKeys: [],
    });

    const clients = await LlmOauthClientModel.findAllByOrganization({
      organizationId: organization.id,
    });

    expect(clients).toHaveLength(1);
    expect(clients[0].name).toBe("LLM OAuth Client");
  });

  test("treats OAuth client search wildcards as literal characters", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Client with % literal",
      allowedLlmProxyIds: [],
      providerApiKeys: [],
    });
    await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Client with _ literal",
      allowedLlmProxyIds: [],
      providerApiKeys: [],
    });
    await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Client with alpha literal",
      allowedLlmProxyIds: [],
      providerApiKeys: [],
    });

    const percentMatches = await LlmOauthClientModel.findAllByOrganization({
      organizationId: organization.id,
      search: "%",
    });
    const underscoreMatches = await LlmOauthClientModel.findAllByOrganization({
      organizationId: organization.id,
      search: "_",
    });

    expect(percentMatches.map((client) => client.name)).toEqual([
      "Client with % literal",
    ]);
    expect(underscoreMatches.map((client) => client.name)).toEqual([
      "Client with _ literal",
    ]);
  });

  test("filters OAuth clients by provider API key mapping", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const organization = await makeOrganization();
    const firstSecret = await makeSecret();
    const secondSecret = await makeSecret();
    const firstProviderKey = await makeLlmProviderApiKey(
      organization.id,
      firstSecret.id,
      { name: "First Provider Key", provider: "openai" },
    );
    const secondProviderKey = await makeLlmProviderApiKey(
      organization.id,
      secondSecret.id,
      { name: "Second Provider Key", provider: "anthropic" },
    );

    await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "First Client",
      allowedLlmProxyIds: [],
      providerApiKeys: [
        {
          provider: "openai",
          providerApiKeyId: firstProviderKey.id,
        },
      ],
    });
    await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Second Client",
      allowedLlmProxyIds: [],
      providerApiKeys: [
        {
          provider: "anthropic",
          providerApiKeyId: secondProviderKey.id,
        },
      ],
    });

    const clients = await LlmOauthClientModel.findAllByOrganization({
      organizationId: organization.id,
      providerApiKeyId: secondProviderKey.id,
    });

    expect(clients.map((client) => client.name)).toEqual(["Second Client"]);
    expect(clients[0].providerApiKeys).toEqual([
      {
        provider: "anthropic",
        providerApiKeyId: secondProviderKey.id,
        providerApiKeyName: "Second Provider Key",
      },
    ]);
  });

  test("stores the expected OAuth registration shape", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId: organization.id,
      name: "Shape Check",
      allowedLlmProxyIds: [],
      providerApiKeys: [],
    });

    const found = await LlmOauthClientModel.findByClientId(
      oauthClient.clientId,
    );
    const [stored] = await db
      .select()
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.clientId, oauthClient.clientId))
      .limit(1);

    expect(found).toMatchObject({
      id: oauthClient.id,
      name: "Shape Check",
      organizationId: organization.id,
      allowedLlmProxyIds: [],
      providerApiKeys: [],
      disabled: false,
    });

    expect(stored.grantTypes).toEqual(["client_credentials"]);
    expect(stored.responseTypes).toEqual([]);
    expect(stored.scopes).toEqual([LLM_PROXY_OAUTH_SCOPE]);
    expect(stored.tokenEndpointAuthMethod).toBe("client_secret_post");
    expect(stored.public).toBe(false);
    expect(stored.metadata).toMatchObject({
      type: LLM_OAUTH_CLIENT_METADATA_TYPE,
      organizationId: organization.id,
    });
  });
});
