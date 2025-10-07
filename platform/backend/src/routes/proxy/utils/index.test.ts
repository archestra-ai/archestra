import { randomUUID } from "node:crypto";
import { AgentModel, ChatModel } from "@/models";
import type { ChatCompletionRequestMessages } from "../types";
import { getAgentAndChatIdFromRequest } from "./index";

describe("getAgentAndChatIdFromRequest", () => {
  let agentId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent" });
    agentId = agent.id;
  });

  describe("with x-archestra-chat-id header", () => {
    test("returns existing chat and agent when valid chat ID is provided", async () => {
      // Create a test chat
      const chat = await ChatModel.create({ agentId });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        "x-archestra-chat-id": chat.id,
        authorization: "Bearer test-key",
      });

      expect(result).toEqual({
        chatId: chat.id,
        agentId,
      });
    });

    test("returns error when chat ID does not exist", async () => {
      const nonExistentChatId = randomUUID();
      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        "x-archestra-chat-id": nonExistentChatId,
        authorization: "Bearer test-key",
      });

      expect(result).toEqual({
        error: {
          message: `Specified chat ID ${nonExistentChatId} not found`,
          type: "not_found",
        },
      });
    });
  });

  describe("without x-archestra-chat-id header", () => {
    test("creates new chat and prepends system message with chat ID when no system message exists", async () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("chatId");
      expect(result).toHaveProperty("agentId");

      // Check that system message was prepended
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("<archestra_chat_id>");
      expect(messages[0].content).toContain("</archestra_chat_id>");

      // Verify the chat was created in the database
      if ("chatId" in result) {
        const chat = await ChatModel.findById(result.chatId);
        expect(chat).not.toBeNull();
        expect(chat?.id).toBe(result.chatId);
      }
    });

    test("embeds chat ID in existing system message when system message exists without tag", async () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("chatId");

      // Check that system message was modified
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("system");
      expect(messages[0].content).toContain("You are a helpful assistant");
      expect(messages[0].content).toContain("<archestra_chat_id>");
      expect(messages[0].content).toContain("</archestra_chat_id>");
    });

    test("extracts chat ID from existing system message when tag is present", async () => {
      const existingChatId = randomUUID();
      // Note: ensureDefaultAgentExists will create/get the default agent, not our test agent
      const defaultAgent = await AgentModel.ensureDefaultAgentExists(undefined);
      await ChatModel.create({ id: existingChatId, agentId: defaultAgent.id });

      const messages: ChatCompletionRequestMessages = [
        {
          role: "system",
          content: `You are a helpful assistant\n\n<archestra_chat_id>${existingChatId}</archestra_chat_id>`,
        },
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result).toEqual({
        chatId: existingChatId,
        agentId: defaultAgent.id,
      });

      // System message should remain unchanged
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toContain(existingChatId);
    });

    test("creates chat when chat ID in system message doesn't exist in database", async () => {
      const chatIdInMessage = randomUUID();
      const defaultAgent = await AgentModel.ensureDefaultAgentExists(undefined);

      const messages: ChatCompletionRequestMessages = [
        {
          role: "system",
          content: `<archestra_chat_id>${chatIdInMessage}</archestra_chat_id>`,
        },
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result).toEqual({
        chatId: chatIdInMessage,
        agentId: defaultAgent.id,
      });

      // Verify the chat was created
      const chat = await ChatModel.findById(chatIdInMessage);
      expect(chat).not.toBeNull();
      expect(chat?.id).toBe(chatIdInMessage);
    });

    test("handles system message with array content (text parts)", async () => {
      const messages: ChatCompletionRequestMessages = [
        {
          role: "system",
          content: [{ type: "text", text: "You are a helpful assistant" }],
        },
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("chatId");

      // Check that system message was modified
      const systemMessageContent = messages[0].content;
      expect(Array.isArray(systemMessageContent)).toBe(true);
      if (Array.isArray(systemMessageContent)) {
        const textPart = systemMessageContent.find((c) => c.type === "text");
        expect(textPart?.text).toContain("You are a helpful assistant");
        expect(textPart?.text).toContain("<archestra_chat_id>");
      }
    });

    test("extracts chat ID from system message with array content", async () => {
      const existingChatId = randomUUID();
      const defaultAgent = await AgentModel.ensureDefaultAgentExists(undefined);
      await ChatModel.create({ id: existingChatId, agentId: defaultAgent.id });

      const messages: ChatCompletionRequestMessages = [
        {
          role: "system",
          content: [
            {
              type: "text",
              text: `You are a helpful assistant\n\n<archestra_chat_id>${existingChatId}</archestra_chat_id>`,
            },
          ],
        },
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result).toEqual({
        chatId: existingChatId,
        agentId: defaultAgent.id,
      });
    });

    test("uses user-agent header when creating default agent", async () => {
      const userAgent = "Test Client v1.0";
      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
      ];

      const result = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
        "user-agent": userAgent,
      });

      expect(result).not.toHaveProperty("error");
      expect(result).toHaveProperty("agentId");

      // The agent should exist (created by ensureDefaultAgentExists)
      if ("agentId" in result) {
        const agent = await AgentModel.findById(result.agentId);
        expect(agent).not.toBeNull();
      }
    });

    test("maintains idempotency - same system message returns same chat ID", async () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ];

      // First request
      const result1 = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      expect(result1).toHaveProperty("chatId");

      // Second request with same modified messages
      const result2 = await getAgentAndChatIdFromRequest(messages, {
        authorization: "Bearer test-key",
      });

      // Should return the same chat ID
      if ("chatId" in result1 && "chatId" in result2) {
        expect(result2.chatId).toBe(result1.chatId);
      }
    });
  });
});
