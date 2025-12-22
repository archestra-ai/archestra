import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";

describe("ConversationModel", () => {
  test("can create a conversation", async ({
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
      title: "Test Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    expect(conversation).toBeDefined();
    expect(conversation.id).toBeDefined();
    expect(conversation.title).toBe("Test Conversation");
    expect(conversation.selectedModel).toBe("claude-3-haiku-20240307");
    expect(conversation.userId).toBe(user.id);
    expect(conversation.organizationId).toBe(org.id);
    expect(conversation.agentId).toBe(agent.id);
    expect(conversation.agent).toBeDefined();
    expect(conversation.agent.id).toBe(agent.id);
    expect(conversation.agent.name).toBe("Test Agent");
    expect(conversation.createdAt).toBeDefined();
    expect(conversation.updatedAt).toBeDefined();
    expect(Array.isArray(conversation.messages)).toBe(true);
  });

  test("can find conversation by id", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Find Test Agent", teams: [] });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Find Test",
      selectedModel: "claude-3-opus-20240229",
    });

    const found = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.title).toBe("Find Test");
    expect(found?.selectedModel).toBe("claude-3-opus-20240229");
    expect(found?.agent.id).toBe(agent.id);
    expect(found?.agent.name).toBe("Find Test Agent");
    expect(Array.isArray(found?.messages)).toBe(true);
  });

  test("can find all conversations for a user", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "List Agent", teams: [] });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "First Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Second Conversation",
      selectedModel: "claude-3-opus-20240229",
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);
    expect(conversations[0].title).toBe("Second Conversation"); // Ordered by createdAt desc
    expect(conversations[1].title).toBe("First Conversation");
    expect(conversations.every((c) => c.agent)).toBe(true);
    expect(conversations.every((c) => c.userId === user.id)).toBe(true);
    expect(conversations.every((c) => c.organizationId === org.id)).toBe(true);
    expect(conversations.every((c) => Array.isArray(c.messages))).toBe(true);
  });

  test("can update a conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Update Agent", teams: [] });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Original Title",
      selectedModel: "claude-3-haiku-20240307",
    });

    const updated = await ConversationModel.update(
      created.id,
      user.id,
      org.id,
      {
        title: "Updated Title",
        selectedModel: "claude-3-opus-20240229",
      },
    );

    expect(updated).toBeDefined();
    expect(updated?.title).toBe("Updated Title");
    expect(updated?.selectedModel).toBe("claude-3-opus-20240229");
    expect(updated?.id).toBe(created.id);
    expect(updated?.agent.id).toBe(agent.id);
    expect(Array.isArray(updated?.messages)).toBe(true);
  });

  test("can delete a conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Delete Agent", teams: [] });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "To Be Deleted",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationModel.delete(created.id, user.id, org.id);

    const found = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });
    expect(found).toBeNull();
  });

  test("returns conversations ordered by createdAt descending", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Order Agent", teams: [] });

    // Create conversations with slight delays to ensure different timestamps
    const first = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "First",
      selectedModel: "claude-3-haiku-20240307",
    });

    // Small delay to ensure different createdAt times
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Second",
      selectedModel: "claude-3-haiku-20240307",
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);
    expect(conversations[0].id).toBe(second.id); // Most recent first
    expect(conversations[1].id).toBe(first.id);
    expect(conversations[0].createdAt.getTime()).toBeGreaterThanOrEqual(
      conversations[1].createdAt.getTime(),
    );
  });

  test("returns null when conversation not found", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    const found = await ConversationModel.findById({
      id: "550e8400-e29b-41d4-a716-446655440000",
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeNull();
  });

  test("returns null when updating non-existent conversation", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();

    const result = await ConversationModel.update(
      "550e8400-e29b-41d4-a716-446655440000",
      user.id,
      org.id,
      { title: "Updated" },
    );

    expect(result).toBeNull();
  });

  test("isolates conversations by user and organization", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user1 = await makeUser();
    const user2 = await makeUser();
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const agent = await makeAgent({ name: "Isolation Agent", teams: [] });

    // Create conversation for user1 in org1
    await ConversationModel.create({
      userId: user1.id,
      organizationId: org1.id,
      agentId: agent.id,
      title: "User1 Org1",
      selectedModel: "claude-3-haiku-20240307",
    });

    // Create conversation for user2 in org2
    await ConversationModel.create({
      userId: user2.id,
      organizationId: org2.id,
      agentId: agent.id,
      title: "User2 Org2",
      selectedModel: "claude-3-haiku-20240307",
    });

    // User1 should only see their conversation in org1
    const user1Conversations = await ConversationModel.findAll(
      user1.id,
      org1.id,
    );
    expect(user1Conversations).toHaveLength(1);
    expect(user1Conversations[0].title).toBe("User1 Org1");

    // User2 should only see their conversation in org2
    const user2Conversations = await ConversationModel.findAll(
      user2.id,
      org2.id,
    );
    expect(user2Conversations).toHaveLength(1);
    expect(user2Conversations[0].title).toBe("User2 Org2");

    // User1 should see no conversations in org2
    const user1InOrg2 = await ConversationModel.findAll(user1.id, org2.id);
    expect(user1InOrg2).toHaveLength(0);
  });

  test("create returns conversation with empty messages array", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Empty Messages Agent",
      teams: [],
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "New Conversation",
      selectedModel: "claude-3-haiku-20240307",
    });

    expect(conversation.messages).toBeDefined();
    expect(Array.isArray(conversation.messages)).toBe(true);
    expect(conversation.messages).toHaveLength(0);
  });

  test("findById returns conversation with empty messages array when no messages exist", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "No Messages Agent", teams: [] });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "No Messages",
      selectedModel: "claude-3-haiku-20240307",
    });

    const found = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found?.messages).toBeDefined();
    expect(Array.isArray(found?.messages)).toBe(true);
    expect(found?.messages).toHaveLength(0);
  });

  test("findAll returns conversations with empty messages arrays when no messages exist", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "No Messages Agent", teams: [] });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "No Messages 1",
      selectedModel: "claude-3-haiku-20240307",
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "No Messages 2",
      selectedModel: "claude-3-haiku-20240307",
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);
    for (const conversation of conversations) {
      expect(conversation.messages).toBeDefined();
      expect(Array.isArray(conversation.messages)).toBe(true);
      expect(conversation.messages).toHaveLength(0);
    }
  });

  test("findById merges database UUIDs into message content", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "ID Merge Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "ID Merge Test",
      selectedModel: "claude-3-haiku-20240307",
    });

    const MessageModel = (await import("./message")).default;
    const message = await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-ai-sdk-id",
        role: "user",
        parts: [{ type: "text", text: "Test message" }],
      },
    });

    const found = await ConversationModel.findById({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
    expect(found?.messages).toHaveLength(1);
    expect(found?.messages[0].id).toBe(message.id);
    expect(found?.messages[0].id).not.toBe("temp-ai-sdk-id");
  });

  test("findAll merges database UUIDs into message content", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "ID Merge All Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "ID Merge All Test",
      selectedModel: "claude-3-haiku-20240307",
    });

    const MessageModel = (await import("./message")).default;
    const message1 = await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-id-1",
        role: "user",
        parts: [{ type: "text", text: "Message 1" }],
      },
    });

    const message2 = await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "temp-id-2",
        role: "assistant",
        parts: [{ type: "text", text: "Message 2" }],
      },
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(1);
    const found = conversations[0];
    expect(found.messages).toHaveLength(2);
    expect(found.messages[0].id).toBe(message1.id);
    expect(found.messages[1].id).toBe(message2.id);
    expect(found.messages[0].id).not.toBe("temp-id-1");
    expect(found.messages[1].id).not.toBe("temp-id-2");
  });

  test("findById returns messages ordered by createdAt ascending", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Order Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Message Order Test",
      selectedModel: "claude-3-haiku-20240307",
    });

    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-1",
        role: "user",
        parts: [{ type: "text", text: "First" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        id: "temp-2",
        role: "assistant",
        parts: [{ type: "text", text: "Second" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-3",
        role: "user",
        parts: [{ type: "text", text: "Third" }],
      },
    });

    const found = await ConversationModel.findById({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
    expect(found?.messages).toHaveLength(3);
    expect(found?.messages[0].parts[0].text).toBe("First");
    expect(found?.messages[1].parts[0].text).toBe("Second");
    expect(found?.messages[2].parts[0].text).toBe("Third");
  });

  test("findAll returns messages ordered by createdAt ascending within each conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Order All Agent", teams: [] });

    const conversation1 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 1",
      selectedModel: "claude-3-haiku-20240307",
    });

    const conversation2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
      selectedModel: "claude-3-haiku-20240307",
    });

    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: conversation1.id,
      role: "user",
      content: {
        id: "temp-1-1",
        role: "user",
        parts: [{ type: "text", text: "C1 First" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await MessageModel.create({
      conversationId: conversation1.id,
      role: "assistant",
      content: {
        id: "temp-1-2",
        role: "assistant",
        parts: [{ type: "text", text: "C1 Second" }],
      },
    });

    await MessageModel.create({
      conversationId: conversation2.id,
      role: "user",
      content: {
        id: "temp-2-1",
        role: "user",
        parts: [{ type: "text", text: "C2 First" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    await MessageModel.create({
      conversationId: conversation2.id,
      role: "assistant",
      content: {
        id: "temp-2-2",
        role: "assistant",
        parts: [{ type: "text", text: "C2 Second" }],
      },
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);

    const conv1 = conversations.find((c) => c.id === conversation1.id);
    const conv2 = conversations.find((c) => c.id === conversation2.id);

    expect(conv1?.messages).toHaveLength(2);
    expect(conv1?.messages[0].parts[0].text).toBe("C1 First");
    expect(conv1?.messages[1].parts[0].text).toBe("C1 Second");

    expect(conv2?.messages).toHaveLength(2);
    expect(conv2?.messages[0].parts[0].text).toBe("C2 First");
    expect(conv2?.messages[1].parts[0].text).toBe("C2 Second");
  });
});
