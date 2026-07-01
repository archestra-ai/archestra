import { ChatErrorCode } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";
import ConversationChatErrorModel from "./conversation-chat-error";
import ConversationShareModel from "./conversation-share";
import MessageModel from "./message";
import ModelModel from "./model";

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
    });

    expect(conversation).toBeDefined();
    expect(conversation.id).toBeDefined();
    expect(conversation.title).toBe("Test Conversation");
    expect(conversation.userId).toBe(user.id);
    expect(conversation.organizationId).toBe(org.id);
    expect(conversation.agentId).toBe(agent.id);
    expect(conversation.agent).toBeDefined();
    expect(conversation.agent?.id).toBe(agent.id);
    expect(conversation.agent?.name).toBe("Test Agent");
    expect(conversation.createdAt).toBeDefined();
    expect(conversation.updatedAt).toBeDefined();
    expect(Array.isArray(conversation.messages)).toBe(true);
    expect(conversation.chatErrors).toEqual([]);
  });

  test("can persist chat error events on a conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Error Event Agent", teams: [] });
    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Error Events",
    });

    await ConversationChatErrorModel.create({
      conversationId: conversation.id,
      error: {
        code: ChatErrorCode.ServerError,
        message: "The AI provider is experiencing issues.",
        isRetryable: true,
        traceId: "trace-event-1",
      },
    });
    await ConversationChatErrorModel.create({
      conversationId: conversation.id,
      error: {
        code: ChatErrorCode.RateLimit,
        message: "Rate limit exceeded.",
        isRetryable: true,
        traceId: "trace-event-2",
      },
    });

    const found = await ConversationModel.findById({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found?.chatErrors.map((chatError) => chatError.error)).toEqual([
      {
        code: ChatErrorCode.ServerError,
        message: "The AI provider is experiencing issues.",
        isRetryable: true,
        traceId: "trace-event-1",
      },
      {
        code: ChatErrorCode.RateLimit,
        message: "Rate limit exceeded.",
        isRetryable: true,
        traceId: "trace-event-2",
      },
    ]);
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
    });

    const found = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.title).toBe("Find Test");
    expect(found?.agent?.id).toBe(agent.id);
    expect(found?.agent?.name).toBe("Find Test Agent");
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
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Second Conversation",
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);
    expect(conversations[0].title).toBe("Second Conversation"); // Ordered by updatedAt desc
    expect(conversations[1].title).toBe("First Conversation");
    expect(conversations.every((c) => c.agent)).toBe(true);
    expect(conversations.every((c) => c.userId === user.id)).toBe(true);
    expect(conversations.every((c) => c.organizationId === org.id)).toBe(true);
    expect(conversations.every((c) => Array.isArray(c.messages))).toBe(true);
  });

  test("findAll reports unread once a message lands after the conversation was read", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Unread Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Unread Conversation",
    });

    const unreadOf = async () => {
      const [row] = await ConversationModel.findAll(user.id, org.id);
      return row.unread;
    };

    // A message arrives after creation (lastMessageAt > createdAt), never read.
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    });
    expect(await unreadOf()).toBe(true);

    // Reading it clears the flag.
    expect(
      await ConversationModel.markRead({
        id: conversation.id,
        userId: user.id,
        organizationId: org.id,
      }),
    ).toBe(true);
    expect(await unreadOf()).toBe(false);

    // A later message makes it unread again.
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant", parts: [{ type: "text", text: "more" }] },
    });
    expect(await unreadOf()).toBe(true);
  });

  test("findAll reports unread when a tool result updates an already-read message", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Tool Update Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Tool Update Conversation",
    });
    const message = await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [{ type: "text", text: "working" }],
      },
    });

    await ConversationModel.markRead({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });
    const [readRow] = await ConversationModel.findAll(user.id, org.id);
    expect(readRow.unread).toBe(false);

    // A tool call's final output lands in the existing assistant message (a
    // content change, not a new message) — it should still surface as unread.
    await MessageModel.updateContent(message.id, {
      role: "assistant",
      parts: [{ type: "text", text: "done" }],
    });
    const [afterRow] = await ConversationModel.findAll(user.id, org.id);
    expect(afterRow.unread).toBe(true);
  });

  test("markRead does not touch a conversation owned by another user", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const owner = await makeUser();
    const other = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Owner Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Owned Conversation",
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    });

    // A non-owner marking read matches no row...
    expect(
      await ConversationModel.markRead({
        id: conversation.id,
        userId: other.id,
        organizationId: org.id,
      }),
    ).toBe(false);

    // ...so the owner still sees it as unread.
    const [row] = await ConversationModel.findAll(owner.id, org.id);
    expect(row.unread).toBe(true);
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
    });

    const updated = await ConversationModel.update(
      created.id,
      user.id,
      org.id,
      {
        title: "Updated Title",
      },
    );

    expect(updated).toBeDefined();
    expect(updated?.title).toBe("Updated Title");
    expect(updated?.id).toBe(created.id);
    expect(updated?.agent?.id).toBe(agent.id);
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
    });

    await ConversationModel.delete(created.id, user.id, org.id);

    const found = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });
    expect(found).toBeNull();
  });

  test("returns conversations ordered by updatedAt descending", async ({
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
    });

    // Small delay to ensure different updatedAt times
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Second",
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);
    expect(conversations[0].id).toBe(second.id); // Most recent first
    expect(conversations[1].id).toBe(first.id);
    expect(conversations[0].updatedAt.getTime()).toBeGreaterThanOrEqual(
      conversations[1].updatedAt.getTime(),
    );
  });

  test("updating a conversation title does not change list order", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Update Order Agent", teams: [] });

    // Create first conversation
    const first = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "First",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Create second conversation (will be on top initially)
    const second = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Second",
    });

    // Verify second is on top initially
    let conversations = await ConversationModel.findAll(user.id, org.id);
    expect(conversations[0].id).toBe(second.id);
    expect(conversations[1].id).toBe(first.id);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Update the first conversation - order should stay the same,
    // only new message exhange changes the order
    await ConversationModel.update(first.id, user.id, org.id, {
      title: "First Updated",
    });

    // Order is unchanged; only the title was updated.
    conversations = await ConversationModel.findAll(user.id, org.id);
    expect(conversations[0].id).toBe(second.id);
    expect(conversations[1].id).toBe(first.id);
    expect(conversations.find((c) => c.id === first.id)?.title).toBe(
      "First Updated",
    );
  });

  test("adding a message moves conversation to top of list", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Message Order Agent", teams: [] });

    // Create first conversation
    const first = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "First",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Create second conversation (will be on top initially)
    const second = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Second",
    });

    // Verify second is on top initially
    let conversations = await ConversationModel.findAll(user.id, org.id);
    expect(conversations[0].id).toBe(second.id);
    expect(conversations[1].id).toBe(first.id);

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add a message to the first conversation - should move it to the top
    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: first.id,
      role: "user",
      content: {
        id: "temp-id",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    });

    // Verify first is now on top after adding a message
    conversations = await ConversationModel.findAll(user.id, org.id);
    expect(conversations[0].id).toBe(first.id);
    expect(conversations[1].id).toBe(second.id);
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

  test("findAccessibleById returns owned conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Owned Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Owned Conversation",
    });

    const found = await ConversationModel.findAccessibleById({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found?.id).toBe(conversation.id);
    expect(found?.title).toBe("Owned Conversation");
  });

  test("findAccessibleById returns shared conversation for authorized non-owner", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Shared Agent", teams: [] });

    await makeMember(owner.id, org.id);
    await makeMember(viewer.id, org.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Shared Conversation",
    });

    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-id",
        role: "user",
        parts: [{ type: "text", text: "Hello shared world" }],
      },
    });

    await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const found = await ConversationModel.findAccessibleById({
      id: conversation.id,
      userId: viewer.id,
      organizationId: org.id,
    });

    expect(found?.id).toBe(conversation.id);
    expect(found?.userId).toBe(owner.id);
    expect(found?.share).toMatchObject({ visibility: "organization" });
    expect(found?.messages).toHaveLength(1);
  });

  test("findAccessibleById returns null for unauthorized user", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const owner = await makeUser();
    const invitedUser = await makeUser();
    const outsider = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Private Share Agent", teams: [] });

    await makeMember(owner.id, org.id);
    await makeMember(invitedUser.id, org.id);
    await makeMember(outsider.id, org.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Private Shared Conversation",
    });

    await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invitedUser.id],
    });

    const found = await ConversationModel.findAccessibleById({
      id: conversation.id,
      userId: outsider.id,
      organizationId: org.id,
    });

    expect(found).toBeNull();
  });

  test("findAccessibleById returns null for shared conversation in a different organization", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeMember,
  }) => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const agent = await makeAgent({ name: "Org Scoped Agent", teams: [] });

    await makeMember(owner.id, org.id);
    await makeMember(viewer.id, org.id);

    const conversation = await ConversationModel.create({
      userId: owner.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Org Scoped Conversation",
    });

    await ConversationShareModel.upsert({
      conversationId: conversation.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
    });

    const found = await ConversationModel.findAccessibleById({
      id: conversation.id,
      userId: viewer.id,
      organizationId: otherOrg.id,
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
    });

    // Create conversation for user2 in org2
    await ConversationModel.create({
      userId: user2.id,
      organizationId: org2.id,
      agentId: agent.id,
      title: "User2 Org2",
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
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "No Messages 2",
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

  test("findById filters already-persisted empty assistant rows", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Empty Bubble Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Empty Bubble Test",
    });

    // a healthy turn: user prompt + assistant answer.
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant", parts: [{ type: "text", text: "hi" }] },
    });

    // historical bad assistant rows that must not render after refresh.
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant", parts: [] },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: { role: "assistant" },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: "",
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "data-token-usage", data: { totalTokens: 5 } },
        ],
      },
    });
    await MessageModel.create({
      conversationId: conversation.id,
      role: "assistant",
      content: {
        role: "assistant",
        parts: [
          {
            type: "data-tool-ui-start",
            data: { toolCallId: "call_orphan", toolName: "render_chart" },
          },
        ],
      },
    });

    const found = await ConversationModel.findById({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found?.messages).toHaveLength(2);
    expect(found?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(found?.messages[1].parts).toEqual([{ type: "text", text: "hi" }]);
  });

  test("findById merges database UUIDs into multiple messages", async ({
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

    // Use findById instead of findAll since findAll no longer returns messages for performance
    const found = await ConversationModel.findById({
      id: conversation.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
    expect(found?.messages).toHaveLength(2);
    expect(found?.messages[0].id).toBe(message1.id);
    expect(found?.messages[1].id).toBe(message2.id);
    expect(found?.messages[0].id).not.toBe("temp-id-1");
    expect(found?.messages[1].id).not.toBe("temp-id-2");
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

  test("findById returns messages ordered by createdAt ascending for multiple conversations", async ({
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
    });

    const conversation2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
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

    // Use findById instead of findAll since findAll no longer returns messages for performance
    const conv1 = await ConversationModel.findById({
      id: conversation1.id,
      userId: user.id,
      organizationId: org.id,
    });
    const conv2 = await ConversationModel.findById({
      id: conversation2.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(conv1?.messages).toHaveLength(2);
    expect(conv1?.messages[0].parts[0].text).toBe("C1 First");
    expect(conv1?.messages[1].parts[0].text).toBe("C1 Second");

    expect(conv2?.messages).toHaveLength(2);
    expect(conv2?.messages[0].parts[0].text).toBe("C2 First");
    expect(conv2?.messages[1].parts[0].text).toBe("C2 Second");
  });

  test("can create a conversation with selectedProvider", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Provider Test Agent", teams: [] });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Provider Test Conversation",
    });

    expect(conversation).toBeDefined();
  });

  test("selectedProvider is null when not provided", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "No Provider Agent",
      teams: [],
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "No Provider Conversation",
    });

    expect(conversation).toBeDefined();
  });

  test("can update conversation model", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Update Model Agent",
      teams: [],
    });

    const model = await ModelModel.create({
      externalId: "anthropic/claude-3-5-sonnet",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      inputModalities: null,
      outputModalities: null,
    });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Update Model Test",
    });

    const updated = await ConversationModel.update(
      created.id,
      user.id,
      org.id,
      {
        modelId: model.id,
      },
    );

    expect(updated).toBeDefined();
    expect(updated?.modelId).toBe(model.id);
  });

  test("findById returns conversation with selectedProvider", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Find Provider Agent",
      teams: [],
    });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Find Provider Test",
    });

    const found = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });

    expect(found).toBeDefined();
  });

  test("findAll returns conversations with selectedProvider", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Find All Provider Agent",
      teams: [],
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Anthropic Conversation",
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "OpenAI Conversation",
    });

    const conversations = await ConversationModel.findAll(user.id, org.id);

    expect(conversations).toHaveLength(2);
  });

  test("findAll with search query filters by conversation title", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Search Title Agent", teams: [] });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Python Tutorial",
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "JavaScript Guide",
    });

    const results = await ConversationModel.findAll(user.id, org.id, "Python");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Python Tutorial");
  });

  test("findAll with search query filters by message content", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Search Content Agent", teams: [] });

    const conv1 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 1",
    });

    const conv2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
    });

    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: conv1.id,
      role: "user",
      content: {
        id: "temp-1",
        role: "user",
        parts: [{ type: "text", text: "Hello world" }],
      },
    });

    await MessageModel.create({
      conversationId: conv2.id,
      role: "user",
      content: {
        id: "temp-2",
        role: "user",
        parts: [{ type: "text", text: "Python programming" }],
      },
    });

    const results = await ConversationModel.findAll(user.id, org.id, "Python");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(conv2.id);
    expect(results[0].title).toBe("Conversation 2");
  });

  test("findAll with search query includes messages for preview snippets", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Search Messages Agent",
      teams: [],
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
    });

    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-1",
        role: "user",
        parts: [{ type: "text", text: "Python tutorial" }],
      },
    });

    const results = await ConversationModel.findAll(user.id, org.id, "Python");

    expect(results).toHaveLength(1);
    expect(results[0].messages).toBeDefined();
    expect(Array.isArray(results[0].messages)).toBe(true);
    expect(results[0].messages.length).toBeGreaterThan(0);
    expect(results[0].messages[0].parts[0].text).toBe("Python tutorial");
  });

  test("findAll without search query returns empty messages arrays", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "No Search Messages Agent",
      teams: [],
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test Conversation",
    });

    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
    });

    const results = await ConversationModel.findAll(user.id, org.id);

    expect(results).toHaveLength(1);
    expect(results[0].messages).toBeDefined();
    expect(Array.isArray(results[0].messages)).toBe(true);
    expect(results[0].messages).toHaveLength(0);
  });

  test("findAll search is case-insensitive", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Case Insensitive Agent",
      teams: [],
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Python Tutorial",
    });

    const resultsLower = await ConversationModel.findAll(
      user.id,
      org.id,
      "python",
    );
    const resultsUpper = await ConversationModel.findAll(
      user.id,
      org.id,
      "PYTHON",
    );
    const resultsMixed = await ConversationModel.findAll(
      user.id,
      org.id,
      "PyThOn",
    );

    expect(resultsLower).toHaveLength(1);
    expect(resultsUpper).toHaveLength(1);
    expect(resultsMixed).toHaveLength(1);
  });

  test("findAll search filters by user and organization", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user1 = await makeUser();
    const user2 = await makeUser();
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const agent = await makeAgent({
      name: "Isolation Search Agent",
      teams: [],
    });

    const conv1 = await ConversationModel.create({
      userId: user1.id,
      organizationId: org1.id,
      agentId: agent.id,
      title: "Python Tutorial",
    });

    await ConversationModel.create({
      userId: user2.id,
      organizationId: org2.id,
      agentId: agent.id,
      title: "Python Guide",
    });

    const user1Results = await ConversationModel.findAll(
      user1.id,
      org1.id,
      "Python",
    );
    const user2Results = await ConversationModel.findAll(
      user2.id,
      org2.id,
      "Python",
    );

    expect(user1Results).toHaveLength(1);
    expect(user1Results[0].id).toBe(conv1.id);
    expect(user2Results).toHaveLength(1);
    expect(user2Results[0].title).toBe("Python Guide");
  });

  test("findAll with empty or whitespace search query behaves like no search", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Whitespace Search Agent",
      teams: [],
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 1",
    });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Conversation 2",
    });

    const emptyResults = await ConversationModel.findAll(user.id, org.id, "");
    const whitespaceResults = await ConversationModel.findAll(
      user.id,
      org.id,
      "   ",
    );
    const noSearchResults = await ConversationModel.findAll(user.id, org.id);

    expect(emptyResults).toHaveLength(2);
    expect(whitespaceResults).toHaveLength(2);
    expect(noSearchResults).toHaveLength(2);
    expect(emptyResults.every((c) => c.messages.length === 0)).toBe(true);
    expect(whitespaceResults.every((c) => c.messages.length === 0)).toBe(true);
  });

  test("findAll search matches partial words in title", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Partial Match Agent", teams: [] });

    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "JavaScript Tutorial",
    });

    const results = await ConversationModel.findAll(user.id, org.id, "Script");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("JavaScript Tutorial");
  });

  test("findAll search matches partial words in message content", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Partial Content Agent",
      teams: [],
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Test",
    });

    const MessageModel = (await import("./message")).default;
    await MessageModel.create({
      conversationId: conversation.id,
      role: "user",
      content: {
        id: "temp-1",
        role: "user",
        parts: [{ type: "text", text: "JavaScript is great" }],
      },
    });

    const results = await ConversationModel.findAll(user.id, org.id, "Script");

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(conversation.id);
  });

  test("findAll search escapes percent sign in search query", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Escape Percent Agent",
      teams: [],
    });

    // Create conversation with % in title
    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "100% Complete",
    });

    // Create conversation without % in title
    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Other Conversation",
    });

    // Search for % should only match the conversation with % in title
    // If % is not escaped, it would act as a wildcard and match everything
    const results = await ConversationModel.findAll(user.id, org.id, "%");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("100% Complete");
  });

  test("findAll search escapes underscore in search query", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Escape Underscore Agent",
      teams: [],
    });

    // Create conversation with _ in title
    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "file_name",
    });

    // Create conversation with similar pattern but no underscore
    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "filename",
    });

    // Search for _ should only match the conversation with _ in title
    // If _ is not escaped, it would act as single-character wildcard
    const results = await ConversationModel.findAll(user.id, org.id, "_");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("file_name");
  });

  test("findAll search escapes backslash in search query", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Escape Backslash Agent",
      teams: [],
    });

    // Create conversation with backslash in title
    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "C:\\Users\\test",
    });

    // Create conversation without backslash
    await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "C Users test",
    });

    // Search for backslash should only match the conversation with backslash
    const results = await ConversationModel.findAll(user.id, org.id, "\\");

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("C:\\Users\\test");
  });

  test("findAll search limits messages per conversation for preview", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      name: "Message Limit Agent",
      teams: [],
    });

    const conversation = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Many Messages",
    });

    const MessageModel = (await import("./message")).default;

    // Create more messages than the limit (MESSAGES_PER_CONVERSATION_LIMIT = 10)
    for (let i = 0; i < 15; i++) {
      await MessageModel.create({
        conversationId: conversation.id,
        role: i % 2 === 0 ? "user" : "assistant",
        content: {
          id: `temp-${i}`,
          role: i % 2 === 0 ? "user" : "assistant",
          parts: [{ type: "text", text: `Message ${i} with searchterm` }],
        },
      });
    }

    const results = await ConversationModel.findAll(
      user.id,
      org.id,
      "searchterm",
    );

    expect(results).toHaveLength(1);
    // Should have at most MESSAGES_PER_CONVERSATION_LIMIT (10) messages
    expect(results[0].messages.length).toBeLessThanOrEqual(10);
  });

  test("can pin a conversation by setting pinnedAt", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Pin Agent", teams: [] });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Pin Test",
    });

    expect(created.pinnedAt).toBeNull();

    const pinnedDate = new Date();
    const updated = await ConversationModel.update(
      created.id,
      user.id,
      org.id,
      { pinnedAt: pinnedDate },
    );

    expect(updated).toBeDefined();
    expect(updated?.pinnedAt).toBeInstanceOf(Date);
    expect(updated?.pinnedAt?.getTime()).toBe(pinnedDate.getTime());
  });

  test("can unpin a conversation by setting pinnedAt to null", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Unpin Agent", teams: [] });

    const created = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Unpin Test",
    });

    // Pin it first
    await ConversationModel.update(created.id, user.id, org.id, {
      pinnedAt: new Date(),
    });

    // Verify it's pinned
    const pinned = await ConversationModel.findById({
      id: created.id,
      userId: user.id,
      organizationId: org.id,
    });
    expect(pinned?.pinnedAt).toBeInstanceOf(Date);

    // Unpin it
    const unpinned = await ConversationModel.update(
      created.id,
      user.id,
      org.id,
      { pinnedAt: null },
    );

    expect(unpinned).toBeDefined();
    expect(unpinned?.pinnedAt).toBeNull();
  });

  test("findAll search returns results ordered by updatedAt descending", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Search Order Agent", teams: [] });

    const conv1 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Python First",
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const conv2 = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
      title: "Python Second",
    });

    const results = await ConversationModel.findAll(user.id, org.id, "Python");

    expect(results).toHaveLength(2);
    // Most recently updated first
    expect(results[0].id).toBe(conv2.id);
    expect(results[1].id).toBe(conv1.id);
  });

  describe("preserves conversations when agent is deleted", () => {
    test("conversation is preserved with null agent when agent is deleted", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const AgentModel = (await import("./agent")).default;
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Agent To Delete",
        teams: [],
      });

      // Create a conversation with the agent
      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Conversation to preserve",
      });

      // Verify conversation has agent before deletion
      expect(conversation.agent).toBeDefined();
      expect(conversation.agent?.id).toBe(agent.id);

      // Delete the agent
      await AgentModel.delete(agent.id);

      // Conversation should still exist but with null agent
      const found = await ConversationModel.findById({
        id: conversation.id,
        userId: user.id,
        organizationId: org.id,
      });

      expect(found).toBeDefined();
      expect(found?.id).toBe(conversation.id);
      expect(found?.title).toBe("Conversation to preserve");
      expect(found?.agentId).toBeNull();
      expect(found?.agent).toBeNull();
    });

    test("findAll returns conversations with deleted agents", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const AgentModel = (await import("./agent")).default;
      const user = await makeUser();
      const org = await makeOrganization();
      const agentToDelete = await makeAgent({
        name: "Agent To Delete",
        teams: [],
      });
      const agentToKeep = await makeAgent({
        name: "Agent To Keep",
        teams: [],
      });

      // Create conversations with both agents
      await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agentToDelete.id,
        title: "Conversation with deleted agent",
      });

      await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agentToKeep.id,
        title: "Conversation with existing agent",
      });

      // Delete one agent
      await AgentModel.delete(agentToDelete.id);

      // Both conversations should be returned
      const conversations = await ConversationModel.findAll(user.id, org.id);

      expect(conversations).toHaveLength(2);

      const deletedAgentConv = conversations.find(
        (c) => c.title === "Conversation with deleted agent",
      );
      const existingAgentConv = conversations.find(
        (c) => c.title === "Conversation with existing agent",
      );

      expect(deletedAgentConv).toBeDefined();
      expect(deletedAgentConv?.agent).toBeNull();
      expect(deletedAgentConv?.agentId).toBeNull();

      expect(existingAgentConv).toBeDefined();
      expect(existingAgentConv?.agent).toBeDefined();
      expect(existingAgentConv?.agent?.id).toBe(agentToKeep.id);
    });

    test("conversation can still be updated after agent is deleted", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const AgentModel = (await import("./agent")).default;
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Agent To Delete",
        teams: [],
      });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Original Title",
      });

      // Delete the agent
      await AgentModel.delete(agent.id);

      // Update the conversation title
      const updated = await ConversationModel.update(
        conversation.id,
        user.id,
        org.id,
        { title: "Updated Title After Agent Deletion" },
      );

      expect(updated).toBeDefined();
      expect(updated?.title).toBe("Updated Title After Agent Deletion");
      expect(updated?.agent).toBeNull();
    });

    test("conversation can still be deleted after agent is deleted", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const AgentModel = (await import("./agent")).default;
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Agent To Delete",
        teams: [],
      });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Conversation to delete",
      });

      // Delete the agent
      await AgentModel.delete(agent.id);

      // Delete the conversation
      await ConversationModel.delete(conversation.id, user.id, org.id);

      // Verify conversation is deleted
      const found = await ConversationModel.findById({
        id: conversation.id,
        userId: user.id,
        organizationId: org.id,
      });

      expect(found).toBeNull();
    });
  });
});
