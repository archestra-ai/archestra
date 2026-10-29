import type { SupportedProvider } from "@archestra/shared";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import {
  assertModelTrioTiers,
  availableSubagentTiers,
  type ConversationLlmSelection,
  resolveForkParentSelection,
  resolveSubagentTierSelection,
} from "./llm-resolution";

describe("resolveSubagentTierSelection", () => {
  async function setup(
    fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeUser: () => Promise<{ id: string }>;
      makeMember: (userId: string, organizationId: string) => Promise<unknown>;
      makeLlmProviderApiKey: (
        organizationId: string,
        secretId: string | null,
        overrides: { provider: SupportedProvider; userId?: string },
      ) => Promise<{ id: string }>;
    },
    modelIds: string[],
  ) {
    const org = await fixtures.makeOrganization();
    const user = await fixtures.makeUser();
    await fixtures.makeMember(user.id, org.id);
    const key = await fixtures.makeLlmProviderApiKey(org.id, null, {
      provider: "anthropic",
    });
    const models = await Promise.all(
      modelIds.map((modelId) => createModel("anthropic", modelId)),
    );
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(
      key.id,
      models.map((m) => m.id),
    );
    const byName = Object.fromEntries(models.map((m) => [m.modelId, m.id]));
    const selection = (modelId: string): ConversationLlmSelection => ({
      modelId: byName[modelId],
      chatApiKeyId: key.id,
      selectedModel: modelId,
      selectedProvider: "anthropic",
    });
    const scope = { organizationId: org.id, userId: user.id };
    return { org, scope, byName, selection };
  }

  test("normal keeps the parent's model", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const { scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({ tier: "normal", parent, ...scope }),
    ).toEqual(parent);
  });

  test("without an organization trio, fast and smart pick the provider's default tiers on the parent's key", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const { scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({ tier: "fast", parent, ...scope }),
    ).toEqual(selection("claude-haiku-5-5"));
    expect(
      await resolveSubagentTierSelection({ tier: "smart", parent, ...scope }),
    ).toEqual(selection("claude-opus-5-5"));
  });

  test("the organization trio wins over the provider default", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const { org, scope, byName, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5"],
    );
    await OrganizationModel.patch(org.id, {
      defaultFastModelId: byName["claude-sonnet-5"],
    });

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: selection("claude-sonnet-5-5"),
        ...scope,
      }),
    ).toEqual(selection("claude-sonnet-5"));
  });

  test("a trio tier on another provider runs on a key of that provider the user may use", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { org, scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    const openaiKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "openai" },
    );
    const mini = await createModel("openai", "gpt-6-mini");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(openaiKey.id, [
      mini.id,
    ]);
    await OrganizationModel.patch(org.id, { defaultFastModelId: mini.id });

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: selection("claude-sonnet-5-5"),
        ...scope,
      }),
    ).toEqual({
      modelId: mini.id,
      chatApiKeyId: openaiKey.id,
      selectedModel: "gpt-6-mini",
      selectedProvider: "openai",
    });
  });

  test("a trio tier no key of the user serves falls back to the provider default", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const { org, scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    const unserved = await createModel("openai", "gpt-6-mini");
    await OrganizationModel.patch(org.id, { defaultFastModelId: unserved.id });

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: selection("claude-sonnet-5-5"),
        ...scope,
      }),
    ).toEqual(selection("claude-haiku-5-5"));
  });

  test("a per-user provider trio tier needs the user's own account, else falls back", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { org, scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    const copilot = await createModel("github-copilot", "gpt-6-luna");
    await OrganizationModel.patch(org.id, { defaultFastModelId: copilot.id });
    const fast = () =>
      resolveSubagentTierSelection({
        tier: "fast",
        parent: selection("claude-sonnet-5-5"),
        ...scope,
      });

    expect(await fast()).toEqual(selection("claude-haiku-5-5"));

    await makeLlmProviderApiKey(org.id, (await makeSecret()).id, {
      provider: "github-copilot",
      userId: scope.userId,
    });

    expect(await fast()).toEqual({
      modelId: copilot.id,
      chatApiKeyId: null,
      selectedModel: "gpt-6-luna",
      selectedProvider: "github-copilot",
    });
  });

  test("falls back to the parent's model when no tier model is reachable", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const { scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({ tier: "fast", parent, ...scope }),
    ).toEqual(parent);
  });

  test("a per-user provider picks its tier from the provider catalog", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const [sonnet, luna] = await Promise.all([
      createModel("github-copilot", "claude-sonnet-5.5"),
      createModel("github-copilot", "gpt-6-luna"),
    ]);

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: {
          modelId: sonnet.id,
          chatApiKeyId: null,
          selectedModel: sonnet.modelId,
          selectedProvider: "github-copilot",
        },
        organizationId: org.id,
        userId: user.id,
      }),
    ).toEqual({
      modelId: luna.id,
      chatApiKeyId: null,
      selectedModel: "gpt-6-luna",
      selectedProvider: "github-copilot",
    });
  });

  test("a tier resolving to the parent's own model is still available", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const { scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    );
    const tiers = (modelId: string) =>
      availableSubagentTiers({ parent: selection(modelId), ...scope });

    expect(await tiers("claude-sonnet-5-5")).toEqual(["fast", "smart"]);
    expect(await tiers("claude-opus-5-5")).toEqual(["fast", "smart"]);
  });

  test("a trio tier on another provider is available though the parent's key serves no tier", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const { org, scope, selection } = await setup(
      { makeOrganization, makeUser, makeMember, makeLlmProviderApiKey },
      ["claude-sonnet-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");
    expect(await availableSubagentTiers({ parent, ...scope })).toEqual([]);

    const openaiKey = await makeLlmProviderApiKey(
      org.id,
      (await makeSecret()).id,
      { provider: "openai" },
    );
    const big = await createModel("openai", "gpt-6");
    await LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(openaiKey.id, [
      big.id,
    ]);
    await OrganizationModel.patch(org.id, { defaultSmartModelId: big.id });

    expect(await availableSubagentTiers({ parent, ...scope })).toEqual([
      "smart",
    ]);
  });
});

describe("resolveForkParentSelection", () => {
  test("a fork keeps its parent's key only while the user can still use it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    await makeMember(user.id, org.id);
    const [orgKey, othersKey] = await Promise.all([
      makeLlmProviderApiKey(org.id, null, { provider: "anthropic" }),
      makeLlmProviderApiKey(org.id, null, {
        provider: "anthropic",
        userId: other.id,
      }),
    ]);
    const model = await createModel("anthropic", "claude-sonnet-5-5");
    await Promise.all(
      [orgKey, othersKey].map((key) =>
        LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [model.id]),
      ),
    );
    const forkOn = (apiKeyId: string) =>
      resolveForkParentSelection({
        agent: { llmApiKeyId: null, modelId: null },
        organizationId: org.id,
        userId: user.id,
        parentLlm: { modelId: model.id, apiKeyId },
      });

    expect(await forkOn(orgKey.id)).toMatchObject({
      modelId: model.id,
      chatApiKeyId: orgKey.id,
    });
    // The parent's model stays; its key is left for the fork to re-resolve.
    expect(await forkOn(othersKey.id)).toMatchObject({
      modelId: model.id,
      chatApiKeyId: null,
    });
  });
});

describe("assertModelTrioTiers", () => {
  test("tiers may be on different providers, with no key named", async () => {
    const [fast, smart] = await Promise.all([
      createModel("openai", "gpt-6-mini"),
      createModel("anthropic", "claude-opus-5-5"),
    ]);

    await expect(
      assertModelTrioTiers({ fastModelId: fast.id, smartModelId: smart.id }),
    ).resolves.toBeUndefined();
  });

  test("a tier must be a tool-capable chat model", async () => {
    const noTools = await ModelModel.create({
      externalId: "openai/no-tools",
      provider: "openai",
      modelId: "no-tools",
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      lastSyncedAt: new Date(),
    });

    await expect(
      assertModelTrioTiers({ fastModelId: null, smartModelId: noTools.id }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      assertModelTrioTiers({ fastModelId: null, smartModelId: noTools.id }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

function createModel(provider: SupportedProvider, modelId: string) {
  return ModelModel.create({
    externalId: `${provider}/${modelId}`,
    provider,
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
}
