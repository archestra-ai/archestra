import type { SupportedProvider } from "@archestra/shared";
import {
  LlmProviderApiKeyModelLinkModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { describe, expect, test } from "@/test";
import { resolveSubagentTierSelection } from "./llm-resolution";

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
    return { org, key, byName };
  }

  test("normal keeps the parent's model", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, key, byName } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5", "claude-haiku-4-5"],
    );
    const parent = { modelId: byName["claude-sonnet-5"], apiKeyId: key.id };

    expect(
      await resolveSubagentTierSelection({
        tier: "normal",
        parent,
        organizationId: org.id,
      }),
    ).toEqual(parent);
  });

  test("fast and smart pick the provider defaults on the parent's key", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, key, byName } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-4-8"],
    );
    const parent = { modelId: byName["claude-sonnet-5"], apiKeyId: key.id };

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent,
        organizationId: org.id,
      }),
    ).toEqual({ modelId: byName["claude-haiku-4-5"], apiKeyId: key.id });
    expect(
      await resolveSubagentTierSelection({
        tier: "smart",
        parent,
        organizationId: org.id,
      }),
    ).toEqual({ modelId: byName["claude-opus-4-8"], apiKeyId: key.id });
  });

  test("the organization override wins over the default", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, key, byName } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5", "claude-haiku-4-5", "claude-haiku-5"],
    );
    await OrganizationModel.patch(org.id, {
      subagentModelTiers: { anthropic: { fast: byName["claude-haiku-4-5"] } },
    });

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: { modelId: byName["claude-sonnet-5"], apiKeyId: key.id },
        organizationId: org.id,
      }),
    ).toEqual({ modelId: byName["claude-haiku-4-5"], apiKeyId: key.id });
  });

  test("an override the parent's key does not serve falls back to the default", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, key, byName } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5", "claude-haiku-4-5"],
    );
    const unlinked = await createModel("anthropic", "claude-haiku-5");
    await OrganizationModel.patch(org.id, {
      subagentModelTiers: { anthropic: { fast: unlinked.id } },
    });

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent: { modelId: byName["claude-sonnet-5"], apiKeyId: key.id },
        organizationId: org.id,
      }),
    ).toEqual({ modelId: byName["claude-haiku-4-5"], apiKeyId: key.id });
  });

  test("falls back to the parent's model when the key serves no tier model", async ({
    makeOrganization,
    makeLlmProviderApiKey,
  }) => {
    const { org, key, byName } = await setup(
      { makeOrganization, makeLlmProviderApiKey },
      ["claude-sonnet-5"],
    );
    const parent = { modelId: byName["claude-sonnet-5"], apiKeyId: key.id };

    expect(
      await resolveSubagentTierSelection({
        tier: "fast",
        parent,
        organizationId: org.id,
      }),
    ).toEqual(parent);
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
