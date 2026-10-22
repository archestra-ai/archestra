import type { SupportedProvider } from "@archestra/shared";
import { OPENCODE_PRIMARY_PROVIDERS } from "@archestra/shared/opencode-provider-routes";
import LlmProviderApiKeyModel from "@/models/llm-provider-api-key";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import OrganizationModel from "@/models/organization";
import VirtualApiKeyModel from "@/models/virtual-api-key";
import { describe, expect, test } from "@/test";
import { encodeOpenAiCodexCredential } from "../../openai-codex-credentials";
import {
  ensurePrimaryProviderKey,
  getVirtualKeyProviderCatalog,
} from "./primary-providers";

const setupOptions = {
  keyName: "Agent primary providers",
  supportedProviders: [
    "openai",
    "anthropic",
    "vllm",
    "gemini",
    "groq",
    "azure",
    "bedrock",
  ] as SupportedProvider[],
};

describe("Connection setup primary providers", () => {
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
    const params = {
      ...setupOptions,
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    };
    const { virtualApiKeyId } = await ensurePrimaryProviderKey(params);
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: own.id })]);
    await LlmProviderApiKeyModel.update(own.id, { isPrimary: false });
    await expect(ensurePrimaryProviderKey(params)).rejects.toThrow(
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
    const params = {
      ...setupOptions,
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    };
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
      ensurePrimaryProviderKey(params),
      ensurePrimaryProviderKey(params),
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
    const catalog = await getVirtualKeyProviderCatalog({
      ...params,
      virtualApiKeyId: first.virtualApiKeyId,
    });
    expect(catalog.find((entry) => entry.provider === "vllm")).toMatchObject({
      name: "Custom inference",
      models: [{ id: model.modelId }],
    });
    await LlmProviderApiKeyModel.update(anthropic.id, { isPrimary: false });
    await expect(
      getVirtualKeyProviderCatalog({
        ...params,
        virtualApiKeyId: first.virtualApiKeyId,
      }),
    ).rejects.toThrow("Generate a new");
    const second = await ensurePrimaryProviderKey(params);
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
    const { virtualApiKeyId } = await ensurePrimaryProviderKey({
      ...setupOptions,
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
    const params = {
      ...setupOptions,
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    };
    const collision = await VirtualApiKeyModel.create({
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
      keyType: "passthrough",
      name: setupOptions.keyName,
    });
    await expect(ensurePrimaryProviderKey(params)).rejects.toThrow(
      "passthrough key",
    );
    expect(
      await VirtualApiKeyModel.findById(collision.virtualKey.id),
    ).toMatchObject({ keyType: "passthrough" });
    await VirtualApiKeyModel.delete(collision.virtualKey.id);
    const { virtualApiKeyId } = await ensurePrimaryProviderKey(params);
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toHaveLength(2);
    const catalog = await getVirtualKeyProviderCatalog({
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
    const bedrockModel = await ModelModel.create({
      provider: "bedrock",
      modelId: "bedrock-chat",
      externalId: "bedrock-chat",
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
      bedrockModel.id,
    ]);
    const { virtualKey } = await VirtualApiKeyModel.create({
      organizationId: org.id,
      authorId: user.id,
      scope: "personal",
      name: "Connection",
      providerApiKeys: [{ provider: "bedrock", providerApiKeyId: key.id }],
    });
    const params = {
      ...setupOptions,
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
      virtualApiKeyId: virtualKey.id,
    };
    expect(
      await getVirtualKeyProviderCatalog({ ...params, provider: "bedrock" }),
    ).toEqual([expect.objectContaining({ provider: "bedrock" })]);
    await expect(
      getVirtualKeyProviderCatalog({ ...params, provider: "azure" }),
    ).rejects.toThrow("Model provider access changed");
    await LlmProviderApiKeyModel.setRequiresReauthentication({
      id: key.id,
      requiresReauthentication: true,
    });
    await expect(
      getVirtualKeyProviderCatalog({ ...params, provider: "bedrock" }),
    ).rejects.toThrow("Model provider access changed");
  });

  test("never offers Microsoft 365 Copilot, whose proxy rejects every tool-carrying request", async ({
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
    const anthropic = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "anthropic",
      isPrimary: true,
    });
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "microsoft-365-copilot",
      isPrimary: true,
    });
    const { virtualApiKeyId } = await ensurePrimaryProviderKey({
      keyName: setupOptions.keyName,
      supportedProviders: OPENCODE_PRIMARY_PROVIDERS,
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    });
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(virtualApiKeyId),
    ).toEqual([expect.objectContaining({ providerApiKeyId: anthropic.id })]);
  });

  describe("catalog contents and order", () => {
    async function seed(fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeUser: () => Promise<{ id: string }>;
      makeMember: (userId: string, organizationId: string) => Promise<unknown>;
      makeSecret: () => Promise<{ id: string }>;
      makeLlmProviderApiKey: (
        organizationId: string,
        secretId: string,
        overrides: { provider: SupportedProvider; isPrimary: boolean },
      ) => Promise<{ id: string }>;
    }) {
      const org = await fixtures.makeOrganization();
      const user = await fixtures.makeUser();
      await fixtures.makeMember(user.id, org.id);
      const secret = await fixtures.makeSecret();
      const keys = new Map<string, { id: string }>();
      const models = new Map<string, { id: string }>();
      for (const [provider, modelId, supportsToolCalling] of [
        ["anthropic", "claude-tools", true],
        ["anthropic", "claude-no-tools", false],
        ["openai", "gpt-unknown", null],
        ["groq", "groq-no-tools", false],
      ] as const) {
        if (!keys.has(provider)) {
          keys.set(
            provider,
            await fixtures.makeLlmProviderApiKey(org.id, secret.id, {
              provider,
              isPrimary: true,
            }),
          );
        }
        const model = await ModelModel.create({
          provider,
          modelId,
          externalId: modelId,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalling,
        });
        models.set(modelId, model);
        await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
          (keys.get(provider) as { id: string }).id,
          [model.id],
        );
      }
      const params = {
        ...setupOptions,
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      };
      const { virtualApiKeyId } = await ensurePrimaryProviderKey(params);
      return {
        org,
        user,
        models,
        catalog: () =>
          getVirtualKeyProviderCatalog({ ...params, virtualApiKeyId }),
      };
    }

    test("drops models that cannot call tools, keeps unknown ones, and omits providers left empty", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const { catalog } = await seed({
        makeOrganization,
        makeUser,
        makeMember,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const entries = await catalog();
      expect(entries.map((entry) => entry.provider).sort()).toEqual([
        "anthropic",
        "openai",
      ]);
      expect(
        entries.find((entry) => entry.provider === "anthropic")?.models,
      ).toEqual([expect.objectContaining({ id: "claude-tools" })]);
      expect(
        entries.find((entry) => entry.provider === "openai")?.models,
      ).toEqual([expect.objectContaining({ id: "gpt-unknown" })]);
    });

    test("fails clearly when no selected provider has a tool-capable model", async ({
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
        provider: "groq",
        isPrimary: true,
      });
      const model = await ModelModel.create({
        provider: "groq",
        modelId: "groq-no-tools",
        externalId: "groq-no-tools",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: false,
      });
      await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
        model.id,
      ]);
      const params = {
        ...setupOptions,
        organizationId: org.id,
        userId: user.id,
        userTeamIds: [],
      };
      const { virtualApiKeyId } = await ensurePrimaryProviderKey(params);
      await expect(
        getVirtualKeyProviderCatalog({ ...params, virtualApiKeyId }),
      ).rejects.toThrow(
        "No model from the selected providers can run in OpenCode",
      );
    });

    test("leads with the organization's default model provider, then key order", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const { org, user, models, catalog } = await seed({
        makeOrganization,
        makeUser,
        makeMember,
        makeSecret,
        makeLlmProviderApiKey,
      });
      const order = async () =>
        (await catalog()).map((entry) => entry.provider);
      const initial = await order();
      expect(initial).toHaveLength(2);

      await OrganizationModel.patch(org.id, {
        defaultModelId: (models.get("gpt-unknown") as { id: string }).id,
      });
      expect((await order())[0]).toBe("openai");

      await OrganizationModel.patch(org.id, {
        defaultModelId: (models.get("claude-tools") as { id: string }).id,
      });
      expect((await order())[0]).toBe("anthropic");

      // A default whose model was filtered out (no tool calling) does not
      // lead, even though its provider is in the catalog.
      await OrganizationModel.patch(org.id, {
        defaultModelId: (models.get("claude-no-tools") as { id: string }).id,
      });
      expect(await order()).toEqual(initial);

      // A default outside the catalog falls through to key order.
      await OrganizationModel.patch(org.id, {
        defaultModelId: (models.get("groq-no-tools") as { id: string }).id,
      });
      expect(await order()).toEqual(initial);
    });
  });
  test("Connect defaults apply to new keys and never switch the mode of an existing token", async ({
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
    await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "openai",
      isPrimary: true,
    });
    const params = {
      ...setupOptions,
      organizationId: org.id,
      userId: user.id,
      userTeamIds: [],
    };
    const fixed = await ensurePrimaryProviderKey(params);
    const reused = await ensurePrimaryProviderKey({
      ...params,
      includeFutureProviders: true,
    });
    expect(reused.virtualApiKeyId).toBe(fixed.virtualApiKeyId);
    expect(
      await VirtualApiKeyModel.findById(fixed.virtualApiKeyId),
    ).toMatchObject({ includeFutureProviders: false });
    const automatic = await ensurePrimaryProviderKey({
      ...params,
      keyName: "Automatic Connect",
      includeFutureProviders: true,
    });
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(automatic.virtualApiKeyId),
    ).toEqual([]);
    expect(
      await VirtualApiKeyModel.findById(automatic.virtualApiKeyId),
    ).toMatchObject({ includeFutureProviders: true });
    await ensurePrimaryProviderKey({
      ...params,
      keyName: "Automatic Connect",
      includeFutureProviders: false,
    });
    expect(
      await VirtualApiKeyModel.findById(automatic.virtualApiKeyId),
    ).toMatchObject({ includeFutureProviders: true });
    expect(
      await VirtualApiKeyModel.getProviderApiKeys(automatic.virtualApiKeyId),
    ).toEqual([]);
  });
});
