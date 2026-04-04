import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";
import ConversationShareModel from "./conversation-share";
import MessageModel from "./message";
import TeamModel from "./team";

describe("ConversationShareModel", () => {
  test("can share a conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    expect(share.id).toBeDefined();
    expect(share.conversationId).toBe(conversation.id);
    expect(share.organizationId).toBe(org.id);
    expect(share.createdByUserId).toBe(user.id);
    expect(share.visibility).toBe("organization");
    expect(share.teamIds).toEqual([]);
    expect(share.userIds).toEqual([]);
  });

  test("can find share by conversation id", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const found = await ConversationShareModel.findByConversationId({
      conversationId: conversation.id,
      organizationId: org.id,
    });

    expect(found?.conversationId).toBe(conversation.id);
  });

  test("returns null when no share exists", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const found = await ConversationShareModel.findByConversationId({
      conversationId: conversation.id,
      organizationId: org.id,
    });

    expect(found).toBeNull();
  });

  test("can delete a share", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const deleted = await ConversationShareModel.delete({
      conversationId: conversation.id,
      organizationId: org.id,
      userId: user.id,
    });

    expect(deleted).toBe(true);

    const found = await ConversationShareModel.findByConversationId({
      conversationId: conversation.id,
      organizationId: org.id,
    });

    expect(found).toBeNull();
  });

  test("can get shared conversation with messages", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: { role: "user", parts: [{ type: "text", text: "Hello" }] },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "Hi there!" }],
      },
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const sharedConversation =
      await ConversationShareModel.getSharedConversation({
        shareId: share.id,
        organizationId: org.id,
        userId: user.id,
      });

    expect(sharedConversation?.id).toBe(conversation.id);
    expect(sharedConversation?.agent?.name).toBe("Test Agent");
    expect(sharedConversation?.messages).toHaveLength(2);
    expect(sharedConversation?.sharedByUserId).toBe(user.id);
  });

  test("does not allow accessing shared conversation from different org", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const result = await ConversationShareModel.getSharedConversation({
      shareId: share.id,
      organizationId: "different-org-id",
      userId: user.id,
    });

    expect(result).toBeNull();
  });

  test("share is deleted when conversation is deleted (cascade)", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(user.id, org.id);

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    await ConversationModel.delete(conversation.id, user.id, org.id);

    const found = await ConversationShareModel.findByShareId({
      shareId: share.id,
      organizationId: org.id,
    });

    expect(found).toBeNull();
  });

  test("updates an existing share and replaces its targets", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTeam,
    makeMember,
  }) => {
    const owner = await makeUser();
    const teammate = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });
    const team = await makeTeam(org.id, owner.id, { name: "Engineering" });

    await makeMember(owner.id, org.id);
    await makeMember(teammate.id, org.id);
    await TeamModel.addMember(team.id, teammate.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const firstShare = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const updatedShare = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "team",
      teamIds: [team.id],
      userIds: [],
    });

    expect(updatedShare.id).toBe(firstShare.id);
    expect(updatedShare.visibility).toBe("team");
    expect(updatedShare.teamIds).toEqual([team.id]);
    expect(updatedShare.userIds).toEqual([]);
  });

  test("allows team-scoped access only to matching team members", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeTeam,
    makeMember,
  }) => {
    const owner = await makeUser();
    const teammate = await makeUser();
    const outsider = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });
    const team = await makeTeam(org.id, owner.id, { name: "Engineering" });

    await makeMember(owner.id, org.id);
    await makeMember(teammate.id, org.id);
    await makeMember(outsider.id, org.id);
    await TeamModel.addMember(team.id, teammate.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: { role: "user", parts: [{ type: "text", text: "Hello" }] },
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "team",
      teamIds: [team.id],
      userIds: [],
    });

    expect(
      await ConversationShareModel.userCanAccessShare({
        share,
        userId: teammate.id,
      }),
    ).toBe(true);
    expect(
      await ConversationShareModel.userCanAccessShare({
        share,
        userId: outsider.id,
      }),
    ).toBe(false);

    const accessibleConversation =
      await ConversationShareModel.getSharedConversation({
        shareId: share.id,
        organizationId: org.id,
        userId: teammate.id,
      });
    const blockedConversation =
      await ConversationShareModel.getSharedConversation({
        shareId: share.id,
        organizationId: org.id,
        userId: outsider.id,
      });

    expect(accessibleConversation?.id).toBe(conversation.id);
    expect(blockedConversation).toBeNull();
  });

  test("allows user-scoped access only to selected users", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const owner = await makeUser();
    const invitedUser = await makeUser();
    const outsider = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(owner.id, org.id);
    await makeMember(invitedUser.id, org.id);
    await makeMember(outsider.id, org.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invitedUser.id],
    });

    expect(
      await ConversationShareModel.userCanAccessShare({
        share,
        userId: invitedUser.id,
      }),
    ).toBe(true);
    expect(
      await ConversationShareModel.userCanAccessShare({
        share,
        userId: outsider.id,
      }),
    ).toBe(false);
  });

  test("findAccessibleByConversationId returns share for organization access", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(owner.id, org.id);
    await makeMember(viewer.id, org.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const accessibleShare =
      await ConversationShareModel.findAccessibleByConversationId({
        conversationId: conversation.id,
        organizationId: org.id,
        userId: viewer.id,
      });

    expect(accessibleShare).toMatchObject({
      id: share.id,
      conversationId: conversation.id,
      visibility: "organization",
    });
  });

  test("findAccessibleByConversationId returns null for unauthorized user", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const owner = await makeUser();
    const invitedUser = await makeUser();
    const outsider = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Test Agent",
      teams: [],
      organizationId: org.id,
    });

    await makeMember(owner.id, org.id);
    await makeMember(invitedUser.id, org.id);
    await makeMember(outsider.id, org.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invitedUser.id],
    });

    const accessibleShare =
      await ConversationShareModel.findAccessibleByConversationId({
        conversationId: conversation.id,
        organizationId: org.id,
        userId: outsider.id,
      });

    expect(accessibleShare).toBeNull();
  });
});
