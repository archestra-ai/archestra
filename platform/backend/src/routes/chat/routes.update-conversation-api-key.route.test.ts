import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import LlmProviderApiKeyModelLinkModel from "@/models/llm-provider-api-key-model";
import ModelModel from "@/models/model";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * A conversation may run through its agent's configured key without a grant
 * on that key: permission flows through the agent. When one PATCH switches the
 * agent and sends a key, that exemption belongs to the agent the conversation
 * is switching TO, not the one it is leaving.
 */
describe("PATCH /api/chat/conversations/:id API key when switching agent", () => {
  let app: FastifyInstanceWithZod;
  let member: User;
  let organizationId: string;
  let modelId: string;
  let leavingAgentId: string;
  let leavingAgentKeyId: string;
  let nextAgentId: string;
  let nextAgentKeyId: string;
  let conversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeLlmProviderApiKey,
      makeMember,
      makeOrganization,
      makeSecret,
      makeUser,
    }) => {
      organizationId = (await makeOrganization()).id;
      member = await makeUser();
      await makeMember(member.id, organizationId, { role: "member" });

      const secret = await makeSecret({ secret: { apiKey: "synthetic-key" } });
      // Neither key is shared with the member: each is reachable only through
      // the agent that pins it.
      const [leavingKey, nextKey] = await Promise.all(
        ["leaving", "next"].map((name) =>
          makeLlmProviderApiKey(organizationId, secret.id, {
            name: `${name} agent key`,
            provider: "openai",
            access: { users: [] },
          }),
        ),
      );
      leavingAgentKeyId = leavingKey.id;
      nextAgentKeyId = nextKey.id;
      const model = await ModelModel.create({
        externalId: "openai/agent-switch-model",
        provider: "openai",
        modelId: "agent-switch-model",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportsToolCalling: true,
        lastSyncedAt: new Date(),
      });
      modelId = model.id;
      await Promise.all(
        [leavingKey, nextKey].map((key) =>
          LlmProviderApiKeyModelLinkModel.linkModelsToApiKey(key.id, [
            model.id,
          ]),
        ),
      );

      const [leavingAgent, nextAgent] = await Promise.all(
        [leavingKey, nextKey].map((key) =>
          makeAgent({
            organizationId,
            agentType: "agent",
            modelId: model.id,
            llmApiKeyId: key.id,
          }),
        ),
      );
      leavingAgentId = leavingAgent.id;
      nextAgentId = nextAgent.id;
      conversationId = (
        await makeConversation(leavingAgentId, {
          userId: member.id,
          organizationId,
        })
      ).id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (request as typeof request & { user: User }).user = member;
        (
          request as typeof request & { organizationId: string }
        ).organizationId = organizationId;
      });
      const { default: chatRoutes } = await import("./routes");
      await app.register(chatRoutes);
    },
  );

  afterEach(async () => {
    await app.close();
  });

  const switchAgent = (agentId: string, chatApiKeyId: string) =>
    app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversationId}`,
      payload: { agentId, modelId, chatApiKeyId },
    });

  test("accepts the new agent's own key sent together with the switch", async () => {
    const response = await switchAgent(nextAgentId, nextAgentKeyId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: nextAgentId,
      modelId,
      chatApiKeyId: nextAgentKeyId,
    });
  });

  test("refuses the agent being left's key on the new agent", async () => {
    const response = await switchAgent(nextAgentId, leavingAgentKeyId);

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe(
      "You do not have access to this API key",
    );
  });

  test("still exempts the current agent's key when the agent is unchanged", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/chat/conversations/${conversationId}`,
      payload: { modelId, chatApiKeyId: leavingAgentKeyId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: leavingAgentId,
      chatApiKeyId: leavingAgentKeyId,
    });
  });
});
