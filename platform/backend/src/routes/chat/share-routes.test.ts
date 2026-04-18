import ConversationModel from "@/models/conversation";
import ConversationShareModel from "@/models/conversation-share";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("chat share routes", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    currentUser = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: typeof currentUser }).user =
        currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: chatRoutes } = await import("./routes");
    await app.register(chatRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("shares a conversation with selected teams", async ({
    makeAgent,
    makeMember,
    makeTeam,
  }) => {
    await makeMember(currentUser.id, organizationId);
    const agent = await makeAgent({
      organizationId,
      teams: [],
    });
    const team = await makeTeam(organizationId, currentUser.id, {
      name: "Engineering",
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/share`,
      payload: {
        visibility: "team",
        teamIds: [team.id],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversationId: conversation.id,
      visibility: "team",
      teamIds: [team.id],
      userIds: [],
    });
  });

  test("rejects users outside the organization", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    await makeMember(currentUser.id, organizationId);
    const outsider = await makeUser();
    const agent = await makeAgent({
      organizationId,
      teams: [],
    });
    const conversation = await ConversationModel.create({
      userId: currentUser.id,
      organizationId,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/conversations/${conversation.id}/share`,
      payload: {
        visibility: "user",
        userIds: [outsider.id],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toBe(
      "One or more selected users are invalid",
    );
  });

  test("blocks users who are outside the share scope", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = currentUser;
    const invitedUser = await makeUser();
    const outsider = await makeUser();

    await makeMember(owner.id, organizationId);
    await makeMember(invitedUser.id, organizationId);
    await makeMember(outsider.id, organizationId);

    const agent = await makeAgent({
      organizationId,
      teams: [],
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invitedUser.id],
    });

    currentUser = outsider;

    const response = await app.inject({
      method: "GET",
      url: `/api/chat/shared/${share.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Shared conversation not found");
  });

  test("forks a shared conversation with the original accessible agent", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    const owner = currentUser;
    const viewer = await makeUser();

    await makeMember(owner.id, organizationId);
    await makeMember(viewer.id, organizationId);

    const sharedAgent = await makeAgent({
      organizationId,
      teams: [],
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: sharedAgent.id,
      selectedModel: "gpt-4o",
    });
    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    currentUser = viewer;

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/shared/${share.id}/fork`,
      payload: {
        agentId: sharedAgent.id,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      agentId: sharedAgent.id,
      selectedModel: "gpt-4o",
      userId: viewer.id,
    });
  });

  test("does not fork a shared conversation with an inaccessible agent", async ({
    makeAgent,
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    const owner = currentUser;
    const viewer = await makeUser();

    await makeMember(owner.id, organizationId);
    await makeMember(viewer.id, organizationId);

    const ownerOnlyTeam = await makeTeam(organizationId, owner.id, {
      name: "Owner Only",
    });
    const sharedAgent = await makeAgent({
      organizationId,
      teams: [],
    });
    const restrictedAgent = await makeAgent({
      organizationId,
      scope: "team",
      teams: [ownerOnlyTeam.id],
    });
    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId,
      agentId: sharedAgent.id,
      selectedModel: "gpt-4o",
    });
    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    currentUser = viewer;

    const response = await app.inject({
      method: "POST",
      url: `/api/chat/shared/${share.id}/fork`,
      payload: {
        agentId: restrictedAgent.id,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe("Agent not found");
  });
});
