import { beforeEach, describe, expect, test } from "vitest";
import type { InteractionContent } from "../types";
import AgentModel from "./agent";
import ChatModel from "./chat";
import InteractionModel from "./interaction";

describe("InteractionModel", () => {
  let agentId: string;
  let chatId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent" });
    agentId = agent.id;

    // Create test chat
    const chat = await ChatModel.create({ agentId });
    chatId = chat.id;
  });

  describe("checkIfChatIsTrusted", () => {
    test("returns true when all interactions are trusted", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "Hello",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: "Hi there",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      const isTrusted = await InteractionModel.checkIfChatIsTrusted(chatId);
      expect(isTrusted).toBe(true);
    });

    test("returns false when any interaction is untrusted", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "Hello",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_123",
          content: "untrusted data",
        } as InteractionContent,
        trusted: false,
        blocked: false,
      });

      const isTrusted = await InteractionModel.checkIfChatIsTrusted(chatId);
      expect(isTrusted).toBe(false);
    });

    test("returns true when chat has no interactions", async () => {
      const isTrusted = await InteractionModel.checkIfChatIsTrusted(chatId);
      expect(isTrusted).toBe(true);
    });

    test("blocked interactions count as untrusted", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call",
          content: "blocked data",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const isTrusted = await InteractionModel.checkIfChatIsTrusted(chatId);
      expect(isTrusted).toBe(false);
    });
  });

  describe("getAllInteractionsForChat", () => {
    test("returns interactions in chronological order", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "First",
        } as InteractionContent,
        trusted: true,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: "Second",
        } as InteractionContent,
        trusted: true,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "Third",
        } as InteractionContent,
        trusted: true,
      });

      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      expect(interactions.length).toBe(3);
      expect(interactions[0].content.content).toBe("First");
      expect(interactions[1].content.content).toBe("Second");
      expect(interactions[2].content.content).toBe("Third");
    });

    test("returns empty array for chat with no interactions", async () => {
      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      expect(interactions).toEqual([]);
    });

    test("only returns interactions for specified chat", async () => {
      // Create interaction for original chat
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "Original chat",
        } as InteractionContent,
        trusted: true,
      });

      // Create another chat and interaction
      const otherChat = await ChatModel.create({ agentId });
      await InteractionModel.create({
        chatId: otherChat.id,
        content: {
          role: "user",
          content: "Other chat",
        } as InteractionContent,
        trusted: true,
      });

      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      expect(interactions.length).toBe(1);
      expect(interactions[0].content.content).toBe("Original chat");
    });
  });

  describe("getBlockedToolCalls", () => {
    test("returns empty array when no blocked tool calls exist", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "Hello",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      const blockedToolCalls =
        await InteractionModel.getBlockedToolCalls(chatId);
      expect(blockedToolCalls.length).toBe(0);
    });

    test("returns blocked tool calls", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_blocked_1",
          content: "blocked data",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_blocked_2",
          content: "also blocked",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedToolCalls =
        await InteractionModel.getBlockedToolCalls(chatId);
      expect(blockedToolCalls.length).toBe(2);
      expect(
        blockedToolCalls.find((call) => call.toolCallId === "call_blocked_1"),
      ).toBeDefined();
      expect(
        blockedToolCalls.find((call) => call.toolCallId === "call_blocked_2"),
      ).toBeDefined();
    });

    test("only returns blocked tool calls, not other blocked interactions", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "blocked user message",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_blocked_1",
          content: "blocked tool result",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedToolCalls =
        await InteractionModel.getBlockedToolCalls(chatId);
      expect(blockedToolCalls.length).toBe(1);
      expect(
        blockedToolCalls.find((call) => call.toolCallId === "call_blocked_1"),
      ).toBeDefined();
    });

    test("does not include unblocked tool calls", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_allowed",
          content: "allowed data",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_blocked",
          content: "blocked data",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedToolCalls =
        await InteractionModel.getBlockedToolCalls(chatId);
      expect(blockedToolCalls.length).toBe(1);
      expect(
        blockedToolCalls.find((call) => call.toolCallId === "call_blocked"),
      ).toBeDefined();
      expect(
        blockedToolCalls.find((call) => call.toolCallId === "call_allowed"),
      ).toBeUndefined();
    });

    test("only returns blocked tool calls for specified chat", async () => {
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_chat1_blocked",
          content: "blocked in chat 1",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const otherChat = await ChatModel.create({ agentId });
      await InteractionModel.create({
        chatId: otherChat.id,
        content: {
          role: "tool",
          tool_call_id: "call_chat2_blocked",
          content: "blocked in chat 2",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedToolCalls =
        await InteractionModel.getBlockedToolCalls(chatId);
      expect(blockedToolCalls.length).toBe(1);
      expect(
        blockedToolCalls.find(
          (call) => call.toolCallId === "call_chat1_blocked",
        ),
      ).toBeDefined();
      expect(
        blockedToolCalls.find(
          (call) => call.toolCallId === "call_chat2_blocked",
        ),
      ).toBeUndefined();
    });
  });
});
