import config from "@/config";
import { ModelModel, ModelPoolModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import {
  applyAgentModelPool,
  listChatModelPools,
  resolveChatModelPool,
} from "./chat-model-pools";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

describe("chat model pools", () => {
  test("lists and anchors pools on a member the user can use, Bedrock last", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
    const bedrock = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "bedrock",
      userId: user.id,
    });
    const zai = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "zhipuai",
      userId: user.id,
    });
    const other = await makeUser();
    const othersKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "zhipuai",
      userId: other.id,
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: {
        name: "glm-5",
        members: [
          member(bedrock.id, "zai.glm-5", 1),
          member(zai.id, "glm-5", 2),
        ],
      },
    });
    await ModelPoolModel.create({
      organizationId: org.id,
      input: { name: "glm-4.6", members: [member(othersKey.id, "glm-4.6", 1)] },
    });

    const params = { organizationId: org.id, userId: user.id };
    expect(await listChatModelPools(params)).toEqual([
      {
        id: pool.id,
        name: "glm-5",
        providers: expect.arrayContaining(["bedrock", "zhipuai"]),
      },
    ]);

    const anchor = await resolveChatModelPool({
      ...params,
      modelPoolId: pool.id,
    });
    const model = await ModelModel.findByProviderAndModelId("zhipuai", "glm-5");
    expect(anchor).toEqual({
      modelPoolId: pool.id,
      chatApiKeyId: zai.id,
      modelId: model?.id,
    });

    // An agent set to the pool stores the same member; a key leaves the pool.
    const pooled: Parameters<typeof applyAgentModelPool>[0] = {
      modelPoolId: pool.id,
    };
    await applyAgentModelPool(pooled, params);
    expect(pooled).toEqual({
      modelPoolId: pool.id,
      llmApiKeyId: zai.id,
      modelId: model?.id,
    });
    const keyed: Parameters<typeof applyAgentModelPool>[0] = {
      llmApiKeyId: zai.id,
      modelId: model?.id,
    };
    await applyAgentModelPool(keyed, params);
    expect(keyed.modelPoolId).toBeNull();
  });

  test("refuses a pool with no member the user can use", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const secret = await makeSecret({ secret: { apiKey: "sk-test" } });
    const other = await makeUser();
    const othersKey = await makeLlmProviderApiKey(org.id, secret.id, {
      provider: "zhipuai",
      userId: other.id,
    });
    const pool = await ModelPoolModel.create({
      organizationId: org.id,
      input: { name: "glm-5", members: [member(othersKey.id, "glm-5", 1)] },
    });

    await expect(
      resolveChatModelPool({
        organizationId: org.id,
        userId: user.id,
        modelPoolId: pool.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

function member(providerApiKeyId: string, modelId: string, priority: number) {
  return { providerApiKeyId, modelId, priority, weight: 1, enabled: true };
}
