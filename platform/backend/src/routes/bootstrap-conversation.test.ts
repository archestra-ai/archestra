import { RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import {
  AgentModel,
  ConversationModel,
  MemberModel,
  MessageModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import { uuidv7 } from "@/utils/uuid";

describe("conversation bootstrap route", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organization.id, { role: "member" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      const req = request as typeof request & {
        user: User;
        organizationId: string;
      };
      req.user = user;
      req.organizationId = organization.id;
    });

    const [bootstrap, chat, agent, agentTool, keys, models] = await Promise.all(
      [
        import("./bootstrap"),
        import("./chat/routes"),
        import("./agent"),
        import("./agent-tool"),
        import("./llm-provider-api-keys"),
        import("./llm-provider-models"),
      ],
    );
    await app.register(bootstrap.default);
    await app.register(chat.default);
    await app.register(agent.default);
    await app.register(agentTool.default);
    await app.register(keys.default);
    await app.register(models.default);
  });

  afterEach(async () => {
    await app.close();
  });

  // The frontend seeds the conversation into the conversation query and the
  // composer into the new-chat queries, so each must be what those return.
  test("returns the conversation's end and the composer for its agent", async ({
    makeAgent,
  }) => {
    const [conversationAgent, memberDefault] = await Promise.all([
      makeAgent({ organizationId, agentType: "agent" }),
      makeAgent({ organizationId, agentType: "agent" }),
    ]);
    await MemberModel.setDefaultAgent(
      user.id,
      organizationId,
      memberDefault.id,
    );
    const conversation = await ConversationModel.create({
      organizationId,
      userId: user.id,
      agentId: conversationAgent.id,
    });
    await seedMessages(conversation.id, 40);

    const bootstrap = await get(
      `/api/bootstrap/conversation/${conversation.id}`,
    );
    const newChat = await get("/api/bootstrap/new-chat");

    expect(bootstrap.conversation).toEqual(
      await get(`/api/chat/conversations/${conversation.id}?tail=30`),
    );
    expect(bootstrap.conversation.messages).toHaveLength(30);
    expect(bootstrap.conversation.olderMessageCount).toBe(10);
    expect(bootstrap.composer).toEqual({
      ...newChat,
      agent: {
        id: conversationAgent.id,
        detail: await get(`/api/agents/${conversationAgent.id}`),
        delegations: await get(
          `/api/agents/${conversationAgent.id}/delegations`,
        ),
        credentialReadiness: await get(
          `/api/agents/credential-readiness?ids=${conversationAgent.id}`,
        ),
        browserTools: expect.any(Array),
        // Only an empty chat shows the platform's prompts.
        defaultSuggestedPrompts: null,
        keyModels: null,
      },
    });
  });

  test("leaves the agent part empty when the conversation's agent is deleted", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    const conversation = await ConversationModel.create({
      organizationId,
      userId: user.id,
      agentId: agent.id,
    });
    await AgentModel.delete(agent.id);

    const bootstrap = await get(
      `/api/bootstrap/conversation/${conversation.id}`,
    );

    expect(bootstrap.conversation.agent).toBeNull();
    expect(bootstrap.composer.agent).toBeNull();
  });

  test("refuses a conversation the caller cannot read, as the conversation read does", async ({
    makeAgent,
    makeUser,
  }) => {
    expect(
      requiredEndpointPermissionsMap[RouteId.GetConversationBootstrap],
    ).toEqual(requiredEndpointPermissionsMap[RouteId.GetNewChatBootstrap]);
    const other = await makeUser();
    const agent = await makeAgent({ organizationId, agentType: "agent" });
    const conversation = await ConversationModel.create({
      organizationId,
      userId: other.id,
      agentId: agent.id,
    });

    for (const url of [
      `/api/bootstrap/conversation/${conversation.id}`,
      `/api/chat/conversations/${conversation.id}`,
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(404);
    }
  });

  async function seedMessages(conversationId: string, count: number) {
    const start = Date.parse("2026-01-01T00:00:00Z");
    await MessageModel.bulkCreate(
      Array.from({ length: count }, (_, index) => {
        const id = uuidv7();
        const role = index % 2 === 0 ? "user" : "assistant";
        return {
          id,
          conversationId,
          role,
          content: {
            id,
            role,
            parts: [{ type: "text", text: `turn ${index}` }],
          },
          createdAt: new Date(start + index * 1000),
        };
      }),
    );
  }

  async function get(url: string) {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
});
