import { beforeEach, describe, expect, test } from "vitest";
import {
  AgentModel,
  ChatModel,
  InteractionModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "../../../models";
import type { Tool } from "../../../types";
import type { ChatCompletionRequestMessages } from "../types";
import { evaluatePolicies, redactBlockedToolResultData } from "./trusted-data";

describe("trusted-data utils", () => {
  let agentId: string;
  let chatId: string;
  let toolId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({ name: "Test Agent" });
    agentId = agent.id;

    // Create test chat
    const chat = await ChatModel.create({ agentId });
    chatId = chat.id;

    // Create test tool
    await ToolModel.createToolIfNotExists({
      agentId,
      name: "get_emails",
      parameters: {},
      description: "Get emails",
      allowUsageWhenUntrustedDataIsPresent: false,
      dataIsTrustedByDefault: false,
    });

    const tool = await ToolModel.findByName("get_emails");
    toolId = (tool as Tool).id;
  });

  describe("evaluatePolicies", () => {
    test("creates trusted interaction for tool messages matching allow policies", async () => {
      // Create an allow policy
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "endsWith",
        value: "@trusted.com",
        action: "mark_as_trusted",
        description: "Allow trusted emails",
      });

      // First, persist an assistant message with tool call
      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        trusted: true,
        blocked: false,
      });

      // Tool message with trusted data
      const messages: ChatCompletionRequestMessages = [
        {
          role: "tool",
          tool_call_id: "call_123",
          content: JSON.stringify({
            emails: [
              { from: "user@trusted.com", subject: "Hello" },
              { from: "admin@trusted.com", subject: "Update" },
            ],
          }),
        },
      ];

      await evaluatePolicies(messages, chatId);

      // Check that interaction was created with trusted=true
      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      const toolInteraction = interactions.find(
        (i) =>
          i.content.role === "tool" && i.content.tool_call_id === "call_123",
      );

      expect(toolInteraction).toBeDefined();
      expect(toolInteraction?.trusted).toBe(true);
      expect(toolInteraction?.blocked).toBe(false);
      expect(toolInteraction?.reason).toContain("Allow trusted emails");
    });

    test("creates blocked interaction for tool messages matching block_always policies", async () => {
      // Create a block policy
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "contains",
        value: "hacker",
        action: "block_always",
        description: "Block hacker emails",
      });

      // First, persist an assistant message with tool call
      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_456",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        trusted: true,
        blocked: false,
      });

      // Tool message with blocked data
      const messages: ChatCompletionRequestMessages = [
        {
          role: "tool",
          tool_call_id: "call_456",
          content: JSON.stringify({
            emails: [
              { from: "user@company.com", subject: "Normal" },
              { from: "hacker@evil.com", subject: "Malicious" },
            ],
          }),
        },
      ];

      await evaluatePolicies(messages, chatId);

      // Check that interaction was created with blocked=true
      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      const toolInteraction = interactions.find(
        (i) =>
          i.content.role === "tool" && i.content.tool_call_id === "call_456",
      );

      expect(toolInteraction).toBeDefined();
      expect(toolInteraction?.trusted).toBe(false);
      expect(toolInteraction?.blocked).toBe(true);
      expect(toolInteraction?.reason).toContain("Block hacker emails");
    });

    test("creates untrusted interaction when no policies match", async () => {
      // Create a policy that won't match
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "endsWith",
        value: "@trusted.com",
        action: "mark_as_trusted",
        description: "Allow trusted emails",
      });

      // First, persist an assistant message with tool call
      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_789",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        trusted: true,
        blocked: false,
      });

      // Tool message with untrusted data
      const messages: ChatCompletionRequestMessages = [
        {
          role: "tool",
          tool_call_id: "call_789",
          content: JSON.stringify({
            emails: [{ from: "user@untrusted.com", subject: "Hello" }],
          }),
        },
      ];

      await evaluatePolicies(messages, chatId);

      // Check that interaction was created with trusted=false, blocked=false
      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      const toolInteraction = interactions.find(
        (i) =>
          i.content.role === "tool" && i.content.tool_call_id === "call_789",
      );

      expect(toolInteraction).toBeDefined();
      expect(toolInteraction?.trusted).toBe(false);
      expect(toolInteraction?.blocked).toBe(false);
      expect(toolInteraction?.reason).toContain(
        "does not match any trust policies",
      );
    });

    test("handles multiple tool messages in sequence", async () => {
      // Create policies
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "source",
        operator: "equal",
        value: "trusted",
        action: "mark_as_trusted",
        description: "Allow trusted source",
      });

      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "source",
        operator: "equal",
        value: "malicious",
        action: "block_always",
        description: "Block malicious source",
      });

      // Persist assistant messages with tool calls
      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_001",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_002",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        trusted: true,
        blocked: false,
      });

      // Multiple tool messages
      const messages: ChatCompletionRequestMessages = [
        {
          role: "tool",
          tool_call_id: "call_001",
          content: JSON.stringify({ source: "trusted", data: "good data" }),
        },
        {
          role: "tool",
          tool_call_id: "call_002",
          content: JSON.stringify({ source: "malicious", data: "bad data" }),
        },
      ];

      await evaluatePolicies(messages, chatId);

      // Check interactions
      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);

      const trustedInteraction = interactions.find(
        (i) =>
          i.content.role === "tool" && i.content.tool_call_id === "call_001",
      );
      expect(trustedInteraction?.trusted).toBe(true);
      expect(trustedInteraction?.blocked).toBe(false);

      const blockedInteraction = interactions.find(
        (i) =>
          i.content.role === "tool" && i.content.tool_call_id === "call_002",
      );
      expect(blockedInteraction?.trusted).toBe(false);
      expect(blockedInteraction?.blocked).toBe(true);
    });

    test("ignores non-tool messages", async () => {
      const messages: ChatCompletionRequestMessages = [
        {
          role: "user",
          content: "Hello",
        },
        {
          role: "assistant",
          content: "Hi there!",
        },
      ];

      // Should not throw and not create any interactions
      await evaluatePolicies(messages, chatId);

      const interactions =
        await InteractionModel.getAllInteractionsForChat(chatId);
      expect(interactions.length).toBe(0);
    });
  });

  describe("redactBlockedToolResultData", () => {
    test("redacts blocked tool messages", async () => {
      // Create some interactions, including blocked ones
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call",
          content: "blocked data",
        },
        trusted: false,
        blocked: true,
        reason: "Blocked by policy",
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "trusted_call",
          content: "trusted data",
        },
        trusted: true,
        blocked: false,
        reason: "Trusted by policy",
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Get emails" },
        { role: "assistant", content: "Getting emails..." },
        { role: "tool", tool_call_id: "blocked_call", content: "blocked data" },
        { role: "tool", tool_call_id: "trusted_call", content: "trusted data" },
        { role: "assistant", content: "Here are your emails" },
      ];

      const redacted = await redactBlockedToolResultData(chatId, messages);

      // Should have all messages, but blocked tool message content is redacted
      expect(redacted.length).toBe(5);
      expect(redacted).toContainEqual({
        role: "tool",
        tool_call_id: "blocked_call",
        content: "[REDACTED: Data blocked by policy: Blocked by policy]",
      });
      expect(redacted).toContainEqual({
        role: "tool",
        tool_call_id: "trusted_call",
        content: "trusted data",
      });
    });

    test("returns messages unchanged when no blocked interactions", async () => {
      // Create only trusted interactions
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_1",
          content: "data 1",
        },
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_2",
          content: "data 2",
        },
        trusted: false,
        blocked: false,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
        { role: "tool", tool_call_id: "call_1", content: "data 1" },
        { role: "tool", tool_call_id: "call_2", content: "data 2" },
      ];

      const redacted = await redactBlockedToolResultData(chatId, messages);

      // Should return all messages unchanged
      expect(redacted).toEqual(messages);
      expect(redacted.length).toBe(3);
    });

    test("handles empty messages array", async () => {
      const messages: ChatCompletionRequestMessages = [];
      const redacted = await redactBlockedToolResultData(chatId, messages);
      expect(redacted).toEqual([]);
    });

    test("handles chat with no interactions", async () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ];

      const redacted = await redactBlockedToolResultData(chatId, messages);
      expect(redacted).toEqual(messages);
    });

    test("redacts multiple blocked tool messages", async () => {
      // Create multiple blocked interactions
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_1",
          content: "blocked data 1",
        },
        trusted: false,
        blocked: true,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_2",
          content: "blocked data 2",
        },
        trusted: false,
        blocked: true,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Get data" },
        { role: "tool", tool_call_id: "blocked_1", content: "blocked data 1" },
        { role: "tool", tool_call_id: "blocked_2", content: "blocked data 2" },
        { role: "tool", tool_call_id: "allowed", content: "allowed data" },
      ];

      const redacted = await redactBlockedToolResultData(chatId, messages);

      // Should redact both blocked messages but keep all messages
      expect(redacted.length).toBe(4);
      expect(redacted).toEqual([
        { role: "user", content: "Get data" },
        {
          role: "tool",
          tool_call_id: "blocked_1",
          content: "[REDACTED: Data blocked by policy: null]",
        },
        {
          role: "tool",
          tool_call_id: "blocked_2",
          content: "[REDACTED: Data blocked by policy: null]",
        },
        { role: "tool", tool_call_id: "allowed", content: "allowed data" },
      ]);
    });

    test("preserves all messages but redacts blocked tool messages", async () => {
      // Create a blocked interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "blocked_call",
          content: "blocked",
        },
        trusted: false,
        blocked: true,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Processing..." },
        { role: "tool", tool_call_id: "blocked_call", content: "blocked" },
        { role: "assistant", content: "Done" },
        { role: "user", content: "Thanks" },
      ];

      const redacted = await redactBlockedToolResultData(chatId, messages);

      // Should keep all messages but redact blocked tool message
      expect(redacted.length).toBe(5);
      expect(redacted).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Processing..." },
        {
          role: "tool",
          tool_call_id: "blocked_call",
          content: "[REDACTED: Data blocked by policy: null]",
        },
        { role: "assistant", content: "Done" },
        { role: "user", content: "Thanks" },
      ]);
    });
  });
});
