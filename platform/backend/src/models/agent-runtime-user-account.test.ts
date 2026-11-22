import { AgentModel, LlmProviderApiKeyModel, ModelModel } from "@/models";
import { describe, expect, test } from "@/test";
import AgentRuntimeUserAccountModel from "./agent-runtime-user-account";

describe("AgentRuntimeUserAccountModel", () => {
  test("keeps one choice per person and agent, replaced on save", async ({
    makeAgent,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const [first, second] = [await makeUser(), await makeUser()];

    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: first.id,
      authentication: "subscription",
      modelId: null,
    });
    expect(
      await AgentRuntimeUserAccountModel.find({
        agentId: agent.id,
        userId: second.id,
      }),
    ).toBeNull();

    const model = await makeModel();
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: first.id,
      authentication: "subscription",
      modelId: model.id,
    });
    expect(
      await AgentRuntimeUserAccountModel.find({
        agentId: agent.id,
        userId: first.id,
      }),
    ).toMatchObject({ authentication: "subscription", modelId: model.id });

    expect(
      await AgentRuntimeUserAccountModel.delete({
        agentId: agent.id,
        userId: first.id,
      }),
    ).toBe(true);
    expect(
      await AgentRuntimeUserAccountModel.delete({
        agentId: agent.id,
        userId: first.id,
      }),
    ).toBe(false);
  });

  test("goes with its agent, and loses only a removed model or connection", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
    makeUser,
  }) => {
    const agent = await makeAgent();
    const user = await makeUser();
    const model = await makeModel();
    const find = () =>
      AgentRuntimeUserAccountModel.find({ agentId: agent.id, userId: user.id });

    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: user.id,
      authentication: "subscription",
      modelId: model.id,
    });
    await ModelModel.delete("anthropic", model.modelId);
    expect(await find()).toMatchObject({
      authentication: "subscription",
      modelId: null,
    });

    // The company API key with nothing picked: the row names neither part.
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: user.id,
      authentication: "provider",
      modelId: null,
    });
    expect(await find()).toMatchObject({
      authentication: "provider",
      llmApiKeyId: null,
      modelId: null,
    });

    // A connection the person picked, with one of its models: a removed
    // connection leaves the row and its model, so the choice reads as
    // broken instead of as never made.
    const secret = await makeSecret();
    const key = await makeLlmProviderApiKey(agent.organizationId, secret.id);
    const picked = await makeModel();
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: user.id,
      authentication: "provider",
      llmApiKeyId: key.id,
      modelId: picked.id,
    });
    expect(await find()).toMatchObject({
      llmApiKeyId: key.id,
      modelId: picked.id,
    });
    await LlmProviderApiKeyModel.delete(key.id);
    expect(await find()).toMatchObject({
      authentication: "provider",
      llmApiKeyId: null,
      modelId: picked.id,
    });
    // A new choice replaces the whole row, the connection included.
    await AgentRuntimeUserAccountModel.upsert({
      agentId: agent.id,
      userId: user.id,
      authentication: "subscription",
      modelId: null,
    });
    expect(await find()).toMatchObject({
      authentication: "subscription",
      llmApiKeyId: null,
      modelId: null,
    });
    // A trashed agent can come back with its people's choices.
    await AgentModel.delete(agent.id);
    expect(await find()).not.toBeNull();
    await AgentModel.hardDelete(agent.id);
    expect(await find()).toBeNull();
  });
});

function makeModel() {
  const modelId = `claude-${crypto.randomUUID().slice(0, 8)}`;
  return ModelModel.create({
    externalId: `anthropic/${modelId}`,
    provider: "anthropic",
    modelId,
    inputModalities: ["text"],
    outputModalities: ["text"],
    outputLength: 16_384,
    supportsToolCalling: true,
    lastSyncedAt: new Date(),
  });
}
