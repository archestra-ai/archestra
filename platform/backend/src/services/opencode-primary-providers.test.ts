import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { describe, expect, test } from "@/test";
import { encodeOpenAiCodexCredential } from "./openai-codex-credentials";
import {
  ensureOpenCodePrimaryKey,
  getOpenCodeVirtualKeyCatalog,
} from "./opencode-primary-providers";

describe("OpenCode primary providers", () => {
  test("includes the user's primary ChatGPT subscription and excludes other users' subscriptions", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const other = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({
      secret: {
        apiKey: encodeOpenAiCodexCredential({
          refreshToken: "test-refresh",
          accountId: "test-account",
        }),
      },
    });
    const own = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      userId: user.id,
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      userId: other.id,
      isPrimary: true,
      access: "org",
    });
    const params = { organizationId: org.id, userId: user.id, userTeamIds: [] };
    const { virtualApiKeyId } = await ensureOpenCodePrimaryKey(params);
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: own.id })]);
    await LlmProviderApiKeyModel.update(own.id, { isPrimary: false });
    await expect(ensureOpenCodePrimaryKey(params)).rejects.toThrow(
      "No usable primary",
    );
  });
  test("selects usable accessible primaries, includes custom endpoints, and refreshes the key", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const other = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret();
    const params = { organizationId: org.id, userId: user.id, userTeamIds: [] };
    const anthropic = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      isPrimary: true,
    });
    const custom = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      isPrimary: true,
      baseUrl: "https://models.example/v1",
      name: "Custom inference",
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: false,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "gemini",
      isPrimary: true,
      userId: other.id,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "voyage",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "azure",
      isPrimary: true,
    });
    const expired = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "groq",
      isPrimary: true,
    });
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: expired.id,
      requiresReauthentication: true,
    });
    const [first, concurrent] = await Promise.all([
      ensureOpenCodePrimaryKey(params),
      ensureOpenCodePrimaryKey(params),
    ]);
    expect(concurrent.virtualApiKeyId).toBe(first.virtualApiKeyId);
    expect(
      (await VirtualApiKeyModel.getProviderApiKeys(first.virtualApiKeyId))
        .map((key) => key.provider)
        .sort(),
    ).toEqual(["anthropic", "vllm"]);
    expect(
      await VirtualApiKeyModel.findById(first.virtualApiKeyId),
    ).toMatchObject({ authorId: user.id, scope: "personal" });
    const model = await ModelModel.create({
      provider: "vllm",
      modelId: "accounts/example/models/coder",
      externalId: "custom-coder",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    const embedding = await ModelModel.create({
      provider: "vllm",
      modelId: "embedding",
      externalId: "embedding",
      inputModalities: ["text"],
      outputModalities: null,
      embeddingDimensions: 768,
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(custom.id, [
      model.id,
      embedding.id,
    ]);
    const catalog = await getOpenCodeVirtualKeyCatalog({
      ...params,
      virtualApiKeyId: first.virtualApiKeyId,
    });
    expect(catalog.find((entry) => entry.provider === "vllm")).toMatchObject({
      name: "Custom inference",
      models: [{ id: model.modelId }],
    });
    await LlmProviderApiKeyModel.update(anthropic.id, { isPrimary: false });
    await expect(
      getOpenCodeVirtualKeyCatalog({
        ...params,
        virtualApiKeyId: first.virtualApiKeyId,
      }),
    ).rejects.toThrow("Generate a new");
    const second = await ensureOpenCodePrimaryKey(params);
    expect(second.virtualApiKeyId).toBe(first.virtualApiKeyId);
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(second.virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: custom.id })]);
  });

  test("does not let a personal non-primary displace an accessible shared primary", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret();
    const primary = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      userId: user.id,
      isPrimary: false,
    });
    const { virtualApiKeyId } = await ensureOpenCodePrimaryKey({
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    });
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: primary.id })]);
  });

  test("keeps primary endpoint catalogs together and refuses a passthrough name collision", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret();
    const shared = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      isPrimary: true,
      baseUrl: "https://shared.example/v1",
    });
    const personal = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "vllm",
      userId: user.id,
      isPrimary: true,
      baseUrl: "https://personal.example/v1",
    });
    for (const [key, modelId] of [
      [shared, "shared-coder"],
      [personal, "personal-coder"],
    ] as const) {
      const model = await ModelModel.create({
        provider: "vllm",
        modelId,
        externalId: modelId,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);
    }
    const params = { organizationId: org.id, userId: user.id, userTeamIds: [] };
    const collision = await VirtualApiKeyModel.create({
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
      keyType: "passthrough",
      name: "OpenCode primary providers",
    });
    await expect(ensureOpenCodePrimaryKey(params)).rejects.toThrow(
      "passthrough key",
    );
    expect(
      await VirtualApiKeyModel.findById(collision.virtualKey.id),
    ).toMatchObject({ keyType: "passthrough" });
    await VirtualApiKeyModel.delete(collision.virtualKey.id);
    const { virtualApiKeyId } = await ensureOpenCodePrimaryKey(params);
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toHaveLength(2);
    const catalog = await getOpenCodeVirtualKeyCatalog({
      ...params,
      virtualApiKeyId,
    });
    expect(catalog).toHaveLength(1);
    expect(catalog[0].models.map((model) => model.id).sort()).toEqual([
      "personal-coder",
      "shared-coder",
    ]);
  });

  test("single-provider catalogs require an accessible usable mapping, but not primary status", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const key = await makeLlmProviderApiKey(org.id, (await makeSecret()).id, {
      provider: "bedrock",
      isPrimary: false,
    });
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
      name: "Connection",
      providerApiKeys: [{ provider: "bedrock", providerApiKeyId: key.id }],
    });
    const params = {
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
      virtualApiKeyId: virtualKey.id,
    };
    expect(
      await getOpenCodeVirtualKeyCatalog({ ...params, provider: "bedrock" }),
    ).toEqual([expect.objectContaining({ provider: "bedrock" })]);
    await expect(
      getOpenCodeVirtualKeyCatalog({ ...params, provider: "azure" }),
    ).rejects.toThrow("Model provider access changed");
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: key.id,
      requiresReauthentication: true,
    });
    await expect(
      getOpenCodeVirtualKeyCatalog({ ...params, provider: "bedrock" }),
    ).rejects.toThrow("Model provider access changed");
  });
});
