import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";
import MessageModel from "./message";

// These cases need fresh transactions between writes: PostgreSQL's now()
// stays fixed throughout a rollback test's outer transaction.
describe("ConversationModel timestamp behavior", () => {
  test("can find all conversations for a user", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "List Agent" });

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
    const agent = await makeAgent({ name: "Unread Agent" });

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

  test("markRead does not touch a conversation owned by another user", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const owner = await makeUser();
    const other = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Owner Agent" });

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

  test("returns conversations ordered by updatedAt descending", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Order Agent" });

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
    const agent = await makeAgent({ name: "Update Order Agent" });

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
    const agent = await makeAgent({ name: "Message Order Agent" });

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

  test("findAll search returns results ordered by updatedAt descending", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ name: "Search Order Agent" });

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
});
