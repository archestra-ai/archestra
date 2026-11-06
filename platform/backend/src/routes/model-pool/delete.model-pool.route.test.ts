import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { LlmOauthClientModel, ModelPoolModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Model pools are a beta feature; these tests run with it on.
beforeEach(() => {
  config.llmProxy.modelPoolsEnabled = true;
});

describe("DELETE /api/model-pools/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: modelPoolRoutes } = await import("./model-pool.routes");
    await app.register(modelPoolRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("removes the deleted pool from OAuth clients it was added to", async ({
    makeLlmProviderApiKey,
  }) => {
    const zai = await makeLlmProviderApiKey(organizationId, null, {
      provider: "zhipuai",
    });
    const makePool = (name: string) =>
      ModelPoolModel.create({
        organizationId,
        input: {
          name,
          members: [
            {
              providerApiKeyId: zai.id,
              modelId: name,
              priority: 1,
              weight: 1,
              enabled: true,
            },
          ],
        },
      });
    const deletedPool = await makePool("glm-5");
    const keptPool = await makePool("glm-4.7");
    const { oauthClient } = await LlmOauthClientModel.create({
      organizationId,
      authorId: user.id,
      name: "Pool client",
      providerApiKeys: [{ provider: "zhipuai", providerApiKeyId: zai.id }],
      modelPoolIds: [deletedPool.id, keptPool.id],
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/model-pools/${deletedPool.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const client = await LlmOauthClientModel.findById({
      id: oauthClient.id,
      organizationId,
    });
    expect(client?.modelPoolIds).toEqual([keptPool.id]);
  });
});
