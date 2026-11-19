import type { SupportedProvider } from "@archestra/shared";
import { LlmProviderApiKeyModelLinkModel, ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import { resolveForkParentSelection } from "./llm-resolution";

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
