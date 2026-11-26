import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { secretManager } from "@/secrets-manager";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import { describe, expect, test } from "@/test";
import LlmProviderApiKeyModel from "./llm-provider-api-key";
import SecretModel from "./secret";

const subscriptionValue = () =>
  encodeOpenAiCodexCredential({
    refreshToken: "synthetic-refresh",
    accountId: "synthetic-account",
  });

describe("LLM provider key credential kind", () => {
  async function sharedKey(params: {
    organizationId: string;
    apiKeyValue: string;
    /** Omitted: a row written before the kind was recorded. */
    recordKind?: boolean;
  }) {
    const secret = await SecretModel.create({
      name: "test-key",
      secret: { apiKey: params.apiKeyValue },
    });
    return LlmProviderApiKeyModel.create(
      {
        organizationId: params.organizationId,
        name: "Shared OpenAI",
        provider: "openai",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      {
        publishToOrganization: true,
        ...(params.recordKind === false
          ? {}
          : { apiKeyValue: params.apiKeyValue }),
      },
    );
  }

  async function storedKind(id: string) {
    const [row] = await db
      .select({ kind: schema.llmProviderApiKeysTable.credentialKind })
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.id, id));
    return row?.kind;
  }

  test("listing decides from the recorded kind without reading the secret", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const apiKey = await sharedKey({
      organizationId: org.id,
      apiKeyValue: "sk-shared-metered",
    });
    const subscription = await sharedKey({
      organizationId: org.id,
      apiKeyValue: subscriptionValue(),
    });
    expect(await storedKind(apiKey.id)).toBe("api_key");
    expect(await storedKind(subscription.id)).toBe("chatgpt");
    const getSecret = vi.spyOn(secretManager(), "getSecret");

    const visible = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );

    // A subscription is somebody's account, so a shared reader never gets it.
    expect(visible.map((key) => key.id)).toEqual([apiKey.id]);
    expect(getSecret).not.toHaveBeenCalled();

    // The recorded kind is what decides: a row whose value says otherwise is
    // still listed by its record, which shows the value was not consulted.
    await db
      .update(schema.secretsTable)
      .set({ secret: { apiKey: "sk-now-a-plain-key" } })
      .where(eq(schema.secretsTable.id, subscription.secretId as string));
    const again = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );
    expect(again.map((key) => key.id)).toEqual([apiKey.id]);
  });

  test("a row from before the kind was recorded is classified once and stored", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const legacy = await sharedKey({
      organizationId: org.id,
      apiKeyValue: subscriptionValue(),
      recordKind: false,
    });
    expect(await storedKind(legacy.id)).toBeNull();

    const visible = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );

    expect(visible).toEqual([]);
    expect(await storedKind(legacy.id)).toBe("chatgpt");
  });

  test("a legacy shared key whose secret cannot be read stays with its creator until it can be", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    const member = await makeUser();
    await makeMember(creator.id, org.id, { role: "admin" });
    await makeMember(member.id, org.id, { role: "member" });
    const secret = await SecretModel.create({
      name: "vault-backed",
      secret: { apiKey: "sk-in-vault" },
      isVault: true,
    });
    const legacy = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        createdBy: creator.id,
        name: "Shared from Vault",
        provider: "openai",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { publishToOrganization: true },
    );
    const vaultDown = vi
      .spyOn(secretManager(), "getSecret")
      .mockRejectedValue(new Error("vault unreachable"));
    const listFor = async (userId: string) =>
      (
        await LlmProviderApiKeyModel.getAvailableKeysForUser(org.id, userId, [])
      ).map((key) => key.id);

    // Unknown kind: maybe somebody's subscription, so only its creator sees it.
    expect(await listFor(creator.id)).toEqual([legacy.id]);
    expect(await listFor(member.id)).toEqual([]);
    expect(await storedKind(legacy.id)).toBeNull();

    // Once the secret can be read, the next read classifies and stores it.
    vaultDown.mockRestore();
    expect(await listFor(member.id)).toEqual([legacy.id]);
    expect(await storedKind(legacy.id)).toBe("api_key");
  });

  test("a legacy key whose secret no longer decrypts is not stored as an API key", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    const member = await makeUser();
    await makeMember(creator.id, org.id, { role: "admin" });
    await makeMember(member.id, org.id, { role: "member" });
    const legacy = await sharedKey({
      organizationId: org.id,
      apiKeyValue: subscriptionValue(),
      recordKind: false,
    });
    // Encrypted under a key the server no longer has (e.g. after rotation).
    await db
      .update(schema.secretsTable)
      .set({ secret: { __encrypted: "v1:not-decryptable" } })
      .where(eq(schema.secretsTable.id, legacy.secretId as string));

    const listed = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );

    expect(listed.map((key) => key.id)).toEqual([]);
    expect(await storedKind(legacy.id)).toBeNull();
  });

  test("reading one key while Vault is down returns it without a subscription kind", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await SecretModel.create({
      name: "vault-backed",
      secret: { apiKey: "sk-in-vault" },
      isVault: true,
    });
    const legacy = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        name: "Shared from Vault",
        provider: "openai",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { publishToOrganization: true },
    );
    const vaultDown = vi
      .spyOn(secretManager(), "getSecret")
      .mockRejectedValue(new Error("vault unreachable"));

    const key = await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(
      legacy.id,
    );
    vaultDown.mockRestore();

    expect(key).toMatchObject({ id: legacy.id, subscriptionKind: null });
    expect(await storedKind(legacy.id)).toBeNull();
  });

  test("a key whose secret read fails uses the kind a concurrent read just stored", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    const member = await makeUser();
    await makeMember(creator.id, org.id, { role: "admin" });
    await makeMember(member.id, org.id, { role: "member" });
    const secret = await SecretModel.create({
      name: "vault-backed",
      secret: { apiKey: "sk-in-vault" },
      isVault: true,
    });
    const legacy = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        createdBy: creator.id,
        name: "Shared from Vault",
        provider: "openai",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { publishToOrganization: true },
    );
    // While this read waits on Vault, another request classifies the key.
    const vaultDown = vi
      .spyOn(secretManager(), "getSecret")
      .mockImplementation(async () => {
        await db
          .update(schema.llmProviderApiKeysTable)
          .set({ credentialKind: "api_key" })
          .where(eq(schema.llmProviderApiKeysTable.id, legacy.id));
        throw new Error("vault unreachable");
      });

    const listed = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );
    vaultDown.mockRestore();

    expect(listed.map((key) => key.id)).toEqual([legacy.id]);
  });

  test("pointing a key at another secret clears the recorded kind", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = await sharedKey({
      organizationId: org.id,
      apiKeyValue: "sk-metered",
    });
    const replacement = await SecretModel.create({
      name: "replacement",
      secret: { apiKey: subscriptionValue() },
    });

    await LlmProviderApiKeyModel.update(key.id, { secretId: replacement.id });

    expect(await storedKind(key.id)).toBeNull();
  });

  test("recording a new value updates the kind", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = await sharedKey({
      organizationId: org.id,
      apiKeyValue: "sk-metered",
    });

    await LlmProviderApiKeyModel.recordCredentialKind({
      id: key.id,
      apiKeyValue: subscriptionValue(),
    });

    expect(await storedKind(key.id)).toBe("chatgpt");
  });
  test("a key whose kind cannot be told counts as personal", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const company = await sharedKey({
      organizationId: org.id,
      apiKeyValue: "sk-metered",
    });
    const subscription = await sharedKey({
      organizationId: org.id,
      apiKeyValue: subscriptionValue(),
    });
    const vaultSecret = await SecretModel.create({
      name: "vault-backed",
      secret: { apiKey: "sk-in-vault" },
      isVault: true,
    });
    const legacy = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        name: "Shared from Vault",
        provider: "openai",
        secretId: vaultSecret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { publishToOrganization: true },
    );

    expect(await LlmProviderApiKeyModel.isPersonalCredential(company)).toBe(
      false,
    );
    expect(
      await LlmProviderApiKeyModel.isPersonalCredential(subscription),
    ).toBe(true);
    const vaultDown = vi
      .spyOn(secretManager(), "getSecret")
      .mockRejectedValue(new Error("vault unreachable"));
    expect(await LlmProviderApiKeyModel.isPersonalCredential(legacy)).toBe(
      true,
    );
    vaultDown.mockRestore();
    expect(await LlmProviderApiKeyModel.isPersonalCredential(legacy)).toBe(
      false,
    );
  });

  test("skips reading Anthropic secrets when includeSubscriptionInfo is not requested", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const secret = await SecretModel.create({
      name: "anthropic-vault-key",
      secret: { apiKey: "sk-ant-oat01-stored-in-vault" },
      isVault: true,
    });
    const key = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        name: "Vault Anthropic",
        provider: "anthropic",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      {
        publishToOrganization: true,
        apiKeyValue: "sk-ant-oat01-stored-in-vault",
      },
    );
    const getSecret = vi.spyOn(secretManager(), "getSecret");

    const internalList = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
    );
    expect(internalList.map((k) => k.id)).toEqual([key.id]);
    expect(getSecret).not.toHaveBeenCalled();

    const uiList = await LlmProviderApiKeyModel.getAvailableKeysForUser(
      org.id,
      member.id,
      [],
      undefined,
      { includeSubscriptionInfo: true },
    );
    expect(uiList.find((k) => k.id === key.id)?.plan).toBe("personal");
    expect(getSecret).toHaveBeenCalledTimes(1);
    getSecret.mockRestore();
  });

  test("classifies an unreadable key as the same plan across findPlan and list endpoints", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    await makeMember(creator.id, org.id, { role: "admin" });
    const secret = await SecretModel.create({
      name: "unreadable-vault-openai",
      secret: { apiKey: "sk-in-vault" },
      isVault: true,
    });
    const legacy = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        createdBy: creator.id,
        name: "Unclassified OpenAI",
        provider: "openai",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { publishToOrganization: true },
    );
    const vaultDown = vi
      .spyOn(secretManager(), "getSecret")
      .mockRejectedValue(new Error("vault unreachable"));

    try {
      const fromFindPlan = await LlmProviderApiKeyModel.findPlan(legacy);
      const fromGetById =
        await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(legacy.id);
      const fromList = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        org.id,
        creator.id,
        [],
        undefined,
        { includeSubscriptionInfo: true },
      );

      expect(fromFindPlan).toBe("personal");
      expect(fromGetById?.plan).toBe("personal");
      expect(fromList.find((k) => k.id === legacy.id)?.plan).toBe("personal");
    } finally {
      vaultDown.mockRestore();
    }
  });

  test("resolves BYOS Vault secrets when classifying Anthropic OAuth keys in lists and get-by-id", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "admin" });
    const secret = await SecretModel.create({
      name: "byos-anthropic-oauth",
      // DB row stores the Vault reference ("path#key"), not the resolved token.
      secret: { apiKey: "secret/data/llm#anthropic_oauth" },
      isVault: false,
      isByosVault: true,
    });
    const key = await LlmProviderApiKeyModel.create(
      {
        organizationId: org.id,
        name: "BYOS Anthropic OAuth",
        provider: "anthropic",
        secretId: secret.id,
        scope: "org",
        userId: null,
        teamId: null,
      },
      { publishToOrganization: true, apiKeyValue: "sk-ant-oat01-from-byos" },
    );
    const getSecret = vi.spyOn(secretManager(), "getSecret").mockResolvedValue({
      ...secret,
      secret: { apiKey: "sk-ant-oat01-from-byos" },
    });

    try {
      expect(await LlmProviderApiKeyModel.findPlan(key)).toBe("personal");
      expect(
        (await LlmProviderApiKeyModel.findByIdWithSubscriptionInfo(key.id))
          ?.plan,
      ).toBe("personal");
      const visible = await LlmProviderApiKeyModel.getVisibleKeys(
        org.id,
        member.id,
        [],
        true,
        undefined,
        { includeSubscriptionInfo: true },
      );
      expect(visible.find((k) => k.id === key.id)?.plan).toBe("personal");
      const available = await LlmProviderApiKeyModel.getAvailableKeysForUser(
        org.id,
        member.id,
        [],
        undefined,
        { includeSubscriptionInfo: true },
      );
      expect(available.find((k) => k.id === key.id)?.plan).toBe("personal");
    } finally {
      getSecret.mockRestore();
    }
  });
});
