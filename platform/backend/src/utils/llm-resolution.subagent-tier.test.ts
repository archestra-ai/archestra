import type { SupportedProvider } from "@archestra/shared";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import {
  assertModelTrioTiers,
  availableSubagentTiers,
  type ConversationLlmSelection,
  resolveForkParentSelection,
  resolveSubagentTierSelection,
} from "./llm-resolution";

const NO_TRIO = { fastModelId: null, smartModelId: null };

describe("resolveSubagentTierSelection", () => {
  async function setup(
    fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeLlmProviderApiKey: (
        organizationId: string,
        secretId: null,
        overrides: { provider: SupportedProvider },
      ) => Promise<{ id: string }>;
    },
    modelIds: string[],
  ) {
    const org = await fixtures.makeOrganization();
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
    return { org, byName, selection };
  }

  test("normal keeps the parent's model", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({
        tier: "normal",
        parent,
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual(parent);
  });

  test("fast and smart pick the default trio on the parent's key", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent,
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual(selection("claude-haiku-5-5"));
    expect(
      await resolveSubagentTierSelection({
        tier: "smart",
        parent,
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual(selection("claude-opus-5-5"));
  });

  test("the agent's trio wins over the organization's, which wins over the default", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, byName, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      [
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-sonnet-5",
        "claude-opus-5",
      ],
    );
    await OrganizationModel.patch(org.id, {
      defaultFastModelId: byName["claude-sonnet-5"],
    });
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent,
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual(selection("claude-sonnet-5"));
    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent,
        agentTrio: { fastModelId: byName["claude-opus-5"], smartModelId: null },
        organizationId: org.id,
      }),
    ).toEqual(selection("claude-opus-5"));
  });

  test("a trio model the parent's key does not serve falls back to the default", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5"],
    );
    const unlinked = await createModel("anthropic", "claude-haiku-4-5");

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: selection("claude-sonnet-5-5"),
        agentTrio: { fastModelId: unlinked.id, smartModelId: null },
        organizationId: org.id,
      }),
    ).toEqual(selection("claude-haiku-5-5"));
  });

  test("falls back to the parent's model when the key serves no tier model", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5-5"],
    );
    const parent = selection("claude-sonnet-5-5");

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent,
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual(parent);
  });

  test("a per-user provider picks its tier from the provider catalog", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
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
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual({
      modelId: luna.id,
      chatApiKeyId: null,
      selectedModel: "gpt-6-luna",
      selectedProvider: "github-copilot",
    });
  });

  test("only tiers that move off the parent's model are available", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    );
    const tiers = (modelId: string) =>
      availableSubagentTiers({
        parent: selection(modelId),
        agentTrio: NO_TRIO,
        organizationId: org.id,
      });

    expect(await tiers("claude-sonnet-5-5")).toEqual(["fast", "smart"]);
    expect(await tiers("claude-opus-5-5")).toEqual(["fast"]);
  });

  test("no tier is available when the parent's key serves no tier model", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, selection } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5-5"],
    );

    expect(
      await availableSubagentTiers({
        parent: selection("claude-sonnet-5-5"),
        agentTrio: NO_TRIO,
        organizationId: org.id,
      }),
    ).toEqual([]);
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
  test("a per-user provider accepts its catalog's models, as forks pick them", async ({
    makeOrganization,
    makeUser,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const key = await makeLlmProviderApiKey(org.id, null, {
      provider: "github-copilot",
      userId: user.id,
    });
    const unlinked = await createModel("github-copilot", "gpt-6-luna");

    await expect(
      assertModelTrioTiers({
        apiKeyId: key.id,
        fastModelId: unlinked.id,
        smartModelId: null,
      }),
    ).resolves.toBeUndefined();
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
