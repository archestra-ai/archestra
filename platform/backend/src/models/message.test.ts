import { describe, expect, test } from "@/test";
import ConversationModel from "./conversation";
import MessageModel from "./message";

describe("MessageModel", () => {
  describe("findById", () => {
    test("returns message by ID", async ({
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

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-id",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
      });

      const found = await MessageModel.findById(message.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(message.id);
      expect(found?.conversationId).toBe(conversation.id);
      expect(found?.role).toBe("user");
      expect(found?.content).toEqual(message.content);
    });

    test("returns null for non-existent ID", async () => {
      const found = await MessageModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );

      expect(found).toBeNull();
    });

    test("returns message with complex content structure", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Complex Content Agent",
        teams: [],
      });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Complex Content Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const complexContent = {
        id: "temp-id-complex",
        role: "assistant",
        parts: [
          { type: "text", text: "Here's the result:" },
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "calculator",
            args: { operation: "add", a: 1, b: 2 },
          },
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "calculator",
            result: { answer: 3 },
          },
        ],
      };

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: complexContent,
      });

      const found = await MessageModel.findById(message.id);

      expect(found).toBeDefined();
      expect(found?.content).toEqual(complexContent);
      expect(found?.content.parts).toHaveLength(3);
    });
  });

  describe("updateTextPart", () => {
    test("updates text at valid part index", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Update Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Update Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-id",
          role: "user",
          parts: [{ type: "text", text: "original" }],
        },
      });

      const updated = await MessageModel.updateTextPart(
        message.id,
        0,
        "updated",
      );

      expect(updated.content.parts[0].text).toBe("updated");
      expect(updated.updatedAt).toBeDefined();
      expect(updated.id).toBe(message.id);
      expect(updated.conversationId).toBe(conversation.id);
      expect(updated.role).toBe(message.role);
    });

    test("updates text in multi-part message", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Multi-part Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Multi-part Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: {
          id: "temp-id",
          role: "assistant",
          parts: [
            { type: "text", text: "first" },
            { type: "tool-call", toolCallId: "call-1", toolName: "test" },
            { type: "text", text: "third" },
          ],
        },
      });

      const updated = await MessageModel.updateTextPart(
        message.id,
        2,
        "updated third",
      );

      expect(updated.content.parts[0].text).toBe("first");
      expect(updated.content.parts[1].type).toBe("tool-call");
      expect(updated.content.parts[2].text).toBe("updated third");
    });

    test("throws error for invalid part index (too high)", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Invalid Index Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Invalid Index Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-id",
          role: "user",
          parts: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      });

      await expect(
        MessageModel.updateTextPart(message.id, 10, "text"),
      ).rejects.toThrow("Invalid part index");
    });

    test("throws error for negative part index", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Negative Index Agent",
        teams: [],
      });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Negative Index Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-id",
          role: "user",
          parts: [{ type: "text", text: "text" }],
        },
      });

      await expect(
        MessageModel.updateTextPart(message.id, -1, "text"),
      ).rejects.toThrow("Invalid part index");
    });

    test("throws error for non-existent message", async () => {
      await expect(
        MessageModel.updateTextPart(
          "00000000-0000-0000-0000-000000000000",
          0,
          "text",
        ),
      ).rejects.toThrow("Message not found");
    });

    test("preserves message metadata", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Metadata Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Metadata Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-id",
          role: "user",
          parts: [{ type: "text", text: "original" }],
        },
      });

      const originalCreatedAt = message.createdAt;

      const updated = await MessageModel.updateTextPart(
        message.id,
        0,
        "updated",
      );

      expect(updated.id).toBe(message.id);
      expect(updated.conversationId).toBe(message.conversationId);
      expect(updated.role).toBe(message.role);
      expect(updated.createdAt).toEqual(originalCreatedAt);
      expect(updated.updatedAt).toBeDefined();
      expect(updated.content.parts[0].text).toBe("updated");
    });

    test("handles empty string update", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Empty String Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Empty String Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-id",
          role: "user",
          parts: [{ type: "text", text: "original" }],
        },
      });

      const updated = await MessageModel.updateTextPart(message.id, 0, "");

      expect(updated.content.parts[0].text).toBe("");
    });

    test("throws error when attempting to update non-text part", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Non-text Part Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Non-text Part Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message = await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: {
          id: "temp-id",
          role: "assistant",
          parts: [
            { type: "text", text: "Here's the result:" },
            {
              type: "tool-call",
              toolCallId: "call-123",
              toolName: "calculator",
              args: { operation: "add", a: 1, b: 2 },
            },
            { type: "text", text: "The answer is 3" },
          ],
        },
      });

      // Attempt to update the tool-call part (index 1) should throw
      await expect(
        MessageModel.updateTextPart(message.id, 1, "corrupted text"),
      ).rejects.toThrow(
        'Cannot update non-text part: part at index 1 is of type "tool-call"',
      );

      // Verify the message was not corrupted
      const unchanged = await MessageModel.findById(message.id);
      expect(unchanged?.content.parts[1].type).toBe("tool-call");
      expect(unchanged?.content.parts[1]).not.toHaveProperty("text");
    });
  });

  describe("deleteAfterMessage", () => {
    test("deletes messages created after target message", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Delete After Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Delete After Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message1 = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-1",
          role: "user",
          parts: [{ type: "text", text: "Message 1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const message2 = await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: {
          id: "temp-2",
          role: "assistant",
          parts: [{ type: "text", text: "Message 2" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const message3 = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-3",
          role: "user",
          parts: [{ type: "text", text: "Message 3" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: {
          id: "temp-4",
          role: "assistant",
          parts: [{ type: "text", text: "Message 4" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-5",
          role: "user",
          parts: [{ type: "text", text: "Message 5" }],
        },
      });

      await MessageModel.deleteAfterMessage(conversation.id, message3.id);

      const remaining = await MessageModel.findByConversation(conversation.id);
      expect(remaining).toHaveLength(3);
      expect(remaining.map((m) => m.id)).toEqual([
        message1.id,
        message2.id,
        message3.id,
      ]);
    });

    test("deletes no messages when target is most recent", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Most Recent Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Most Recent Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-1",
          role: "user",
          parts: [{ type: "text", text: "Message 1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: {
          id: "temp-2",
          role: "assistant",
          parts: [{ type: "text", text: "Message 2" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const message3 = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-3",
          role: "user",
          parts: [{ type: "text", text: "Message 3" }],
        },
      });

      await MessageModel.deleteAfterMessage(conversation.id, message3.id);

      const remaining = await MessageModel.findByConversation(conversation.id);
      expect(remaining).toHaveLength(3);
    });

    test("throws error for non-existent message", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Non-existent Message Agent",
        teams: [],
      });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Non-existent Message Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      await expect(
        MessageModel.deleteAfterMessage(
          conversation.id,
          "00000000-0000-0000-0000-000000000000",
        ),
      ).rejects.toThrow("Message not found");
    });

    test("only deletes from specified conversation", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Isolation Agent", teams: [] });

      const conversationA = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Conversation A",
        selectedModel: "claude-3-haiku-20240307",
      });

      const conversationB = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Conversation B",
        selectedModel: "claude-3-haiku-20240307",
      });

      const messageA1 = await MessageModel.create({
        conversationId: conversationA.id,
        role: "user",
        content: {
          id: "temp-a1",
          role: "user",
          parts: [{ type: "text", text: "A1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversationA.id,
        role: "assistant",
        content: {
          id: "temp-a2",
          role: "assistant",
          parts: [{ type: "text", text: "A2" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversationA.id,
        role: "user",
        content: {
          id: "temp-a3",
          role: "user",
          parts: [{ type: "text", text: "A3" }],
        },
      });

      await MessageModel.create({
        conversationId: conversationB.id,
        role: "user",
        content: {
          id: "temp-b1",
          role: "user",
          parts: [{ type: "text", text: "B1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversationB.id,
        role: "assistant",
        content: {
          id: "temp-b2",
          role: "assistant",
          parts: [{ type: "text", text: "B2" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversationB.id,
        role: "user",
        content: {
          id: "temp-b3",
          role: "user",
          parts: [{ type: "text", text: "B3" }],
        },
      });

      await MessageModel.deleteAfterMessage(conversationA.id, messageA1.id);

      const remainingA = await MessageModel.findByConversation(
        conversationA.id,
      );
      expect(remainingA).toHaveLength(1);

      const remainingB = await MessageModel.findByConversation(
        conversationB.id,
      );
      expect(remainingB).toHaveLength(3);
    });

    test("uses gt() operator for timestamp comparison", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({ name: "Timestamp Agent", teams: [] });

      const conversation = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Timestamp Test",
        selectedModel: "claude-3-haiku-20240307",
      });

      const message1 = await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-1",
          role: "user",
          parts: [{ type: "text", text: "Message 1" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversation.id,
        role: "assistant",
        content: {
          id: "temp-2",
          role: "assistant",
          parts: [{ type: "text", text: "Message 2" }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      await MessageModel.create({
        conversationId: conversation.id,
        role: "user",
        content: {
          id: "temp-3",
          role: "user",
          parts: [{ type: "text", text: "Message 3" }],
        },
      });

      await MessageModel.deleteAfterMessage(conversation.id, message1.id);

      const remaining = await MessageModel.findByConversation(conversation.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(message1.id);
    });

    test("throws error when message belongs to different conversation", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Cross-conversation Agent",
        teams: [],
      });

      // Create two separate conversations
      const conversationA = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Conversation A",
        selectedModel: "claude-3-haiku-20240307",
      });

      const conversationB = await ConversationModel.create({
        userId: user.id,
        organizationId: org.id,
        agentId: agent.id,
        title: "Conversation B",
        selectedModel: "claude-3-haiku-20240307",
      });

      // Create a message in conversation B
      const messageInB = await MessageModel.create({
        conversationId: conversationB.id,
        role: "user",
        content: {
          id: "temp-b1",
          role: "user",
          parts: [{ type: "text", text: "Message in B" }],
        },
      });

      // Attempt to delete after messageInB but specifying conversationA
      // This should throw an error because the message doesn't belong to conversationA
      await expect(
        MessageModel.deleteAfterMessage(conversationA.id, messageInB.id),
      ).rejects.toThrow(
        "Message does not belong to the specified conversation",
      );
    });
  });
});
