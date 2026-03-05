import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";
import ConversationShareModel from "./conversation-share";
import MessageModel from "./message";

describe("ConversationShareModel", () => {
  test("can share a conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.create({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
    });

    expect(share).toBeDefined();
    expect(share.id).toBeDefined();
    expect(share.conversationId).toBe(conversation.id);
    expect(share.organizationId).toBe(org.id);
    expect(share.createdByUserId).toBe(user.id);
    expect(share.visibility).toBe("organization");
  });

  test("can find share by conversation id", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await ConversationShareModel.create({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
    });

    const found = await ConversationShareModel.findByConversationId({
      conversationId: conversation.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
    expect(found?.conversationId).toBe(conversation.id);
  });

  test("returns null when no share exists", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

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
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    await ConversationShareModel.create({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
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
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    // Add messages
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

    const share = await ConversationShareModel.create({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
    });

    const sharedConversation =
      await ConversationShareModel.getSharedConversation({
        shareId: share.id,
        organizationId: org.id,
      });

    expect(sharedConversation).toBeDefined();
    expect(sharedConversation?.id).toBe(conversation.id);
    expect(sharedConversation?.agent?.name).toBe("Test Agent");
    expect(sharedConversation?.messages).toHaveLength(2);
    expect(sharedConversation?.sharedByUserId).toBe(user.id);
  });

  test("does not allow accessing shared conversation from different org", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.create({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
    });

    const result = await ConversationShareModel.getSharedConversation({
      shareId: share.id,
      organizationId: "different-org-id",
    });

    expect(result).toBeNull();
  });

  test("share is deleted when conversation is deleted (cascade)", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      selectedModel: "gpt-4o",
    });

    const share = await ConversationShareModel.create({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: user.id,
      visibility: "organization",
    });

    // Delete the conversation
    await ConversationModel.delete(conversation.id, user.id, org.id);

    // Share should be cascaded
    const found = await ConversationShareModel.findByShareId({
      shareId: share.id,
      organizationId: org.id,
    });

    expect(found).toBeNull();
  });
});
