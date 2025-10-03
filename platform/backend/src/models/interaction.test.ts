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

  describe("getBlockedToolCallIds", () => {
    test("returns empty set when no interactions exist", async () => {
      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      expect(blockedIds.size).toBe(0);
    });

    test("returns empty set when no blocked interactions exist", async () => {
      // Create some non-blocked interactions
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_123",
          content: "some data",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: "Hello",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      expect(blockedIds.size).toBe(0);
    });

    test("returns tool_call_ids for blocked tool interactions", async () => {
      // Create blocked tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call_1",
          content: "blocked data",
        } as InteractionContent,
        trusted: false,
        blocked: true,
        reason: "Blocked by policy",
      });

      // Create another blocked tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call_2",
          content: "more blocked data",
        } as InteractionContent,
        trusted: false,
        blocked: true,
        reason: "Also blocked",
      });

      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      expect(blockedIds.size).toBe(2);
      expect(blockedIds.has("blocked_call_1")).toBe(true);
      expect(blockedIds.has("blocked_call_2")).toBe(true);
    });

    test("excludes non-tool blocked interactions", async () => {
      // Create blocked assistant interaction (should be ignored)
      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: "This is blocked but not a tool",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      // Create blocked user interaction (should be ignored)
      await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "User message",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      expect(blockedIds.size).toBe(0);
    });

    test("only returns blocked tool interactions, not trusted ones", async () => {
      // Create blocked tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call",
          content: "blocked",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      // Create trusted tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "trusted_call",
          content: "trusted",
        } as InteractionContent,
        trusted: true,
        blocked: false,
      });

      // Create untrusted but not blocked tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "untrusted_call",
          content: "untrusted",
        } as InteractionContent,
        trusted: false,
        blocked: false,
      });

      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      expect(blockedIds.size).toBe(1);
      expect(blockedIds.has("blocked_call")).toBe(true);
      expect(blockedIds.has("trusted_call")).toBe(false);
      expect(blockedIds.has("untrusted_call")).toBe(false);
    });

    test("handles tool interactions without tool_call_id", async () => {
      // Create blocked tool interaction without tool_call_id
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          content: "no tool call id",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      expect(blockedIds.size).toBe(0);
    });

    test("returns empty set for different chatId", async () => {
      // Create blocked interaction for original chat
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call",
          content: "blocked",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      // Create a different chat
      const otherChat = await ChatModel.create({ agentId });

      // Should return empty for the other chat
      const blockedIds = await InteractionModel.getBlockedToolCallIds(
        otherChat.id,
      );
      expect(blockedIds.size).toBe(0);

      // Should still return the blocked ID for original chat
      const originalBlockedIds =
        await InteractionModel.getBlockedToolCallIds(chatId);
      expect(originalBlockedIds.size).toBe(1);
      expect(originalBlockedIds.has("blocked_call")).toBe(true);
    });

    test("handles multiple blocked interactions with same tool_call_id", async () => {
      // Create multiple blocked interactions with same tool_call_id
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "duplicate_call",
          content: "first",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "duplicate_call",
          content: "second",
        } as InteractionContent,
        trusted: false,
        blocked: true,
      });

      const blockedIds = await InteractionModel.getBlockedToolCallIds(chatId);
      // Should only have one entry in the Set despite duplicates
      expect(blockedIds.size).toBe(1);
      expect(blockedIds.has("duplicate_call")).toBe(true);
    });
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

  describe("findByChatId", () => {
    test("returns interactions in chronological order", async () => {
      // Create interactions with slight delays to ensure ordering
      const _interaction1 = await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "First",
        } as InteractionContent,
        trusted: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const _interaction2 = await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: "Second",
        } as InteractionContent,
        trusted: true,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const _interaction3 = await InteractionModel.create({
        chatId,
        content: {
          role: "user",
          content: "Third",
        } as InteractionContent,
        trusted: true,
      });

      const interactions = await InteractionModel.findByChatId(chatId);
      expect(interactions.length).toBe(3);
      expect(interactions[0].content.content).toBe("First");
      expect(interactions[1].content.content).toBe("Second");
      expect(interactions[2].content.content).toBe("Third");
    });

    test("returns empty array for chat with no interactions", async () => {
      const interactions = await InteractionModel.findByChatId(chatId);
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

      const interactions = await InteractionModel.findByChatId(chatId);
      expect(interactions.length).toBe(1);
      expect(interactions[0].content.content).toBe("Original chat");
    });
  });
});
