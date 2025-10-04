import {
  AgentModel,
  ChatModel,
  InteractionModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "@models";
import type { Tool } from "@types";
import type { ChatCompletionRequestMessages } from "../types";
import {
  evaluatePolicies,
  modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData,
  prepareContextForLLM,
  redactBlockedToolResultData,
  substituteUntrustedDataWithVariables,
} from "./trusted-data";

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

  describe("modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData", () => {
    test("appends instructions to existing system prompt", () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ];

      const modified =
        modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData(
          messages,
        );

      expect(modified.length).toBe(2);
      expect(modified[0].role).toBe("system");
      expect(modified[0].content).toContain("You are a helpful assistant.");
      expect(modified[0].content).toContain("$ARCHESTRA_");
      expect(modified[0].content).toContain("marked as untrusted");
      expect(modified[1]).toEqual({ role: "user", content: "Hello" });
    });

    test("creates new system prompt when none exists", () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];

      const modified =
        modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData(
          messages,
        );

      expect(modified.length).toBe(3);
      expect(modified[0].role).toBe("system");
      expect(modified[0].content).toContain("$ARCHESTRA_");
      expect(modified[0].content).toContain("marked as untrusted");
      expect(modified[1]).toEqual({ role: "user", content: "Hello" });
      expect(modified[2]).toEqual({ role: "assistant", content: "Hi there!" });
    });

    test("handles empty messages array", () => {
      const messages: ChatCompletionRequestMessages = [];

      const modified =
        modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData(
          messages,
        );

      expect(modified.length).toBe(1);
      expect(modified[0].role).toBe("system");
      expect(modified[0].content).toContain("$ARCHESTRA_");
    });

    test("preserves non-system messages unchanged", () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
        { role: "tool", tool_call_id: "call_123", content: "data" },
      ];

      const modified =
        modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData(
          messages,
        );

      // Should add system prompt at beginning
      expect(modified.length).toBe(4);
      expect(modified[0].role).toBe("system");
      expect(modified[1]).toEqual({ role: "user", content: "Hello" });
      expect(modified[2]).toEqual({ role: "assistant", content: "Hi!" });
      expect(modified[3]).toEqual({
        role: "tool",
        tool_call_id: "call_123",
        content: "data",
      });
    });

    test("only modifies first system prompt when multiple exist", () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "system", content: "First system prompt." },
        { role: "user", content: "Hello" },
        { role: "system", content: "Second system prompt." },
        { role: "assistant", content: "Hi!" },
      ];

      const modified =
        modifySystemPromptToIncludeInstructionsAboutHowToUseUntrustedData(
          messages,
        );

      expect(modified.length).toBe(4);
      expect(modified[0].role).toBe("system");
      expect(modified[0].content).toContain("First system prompt.");
      expect(modified[0].content).toContain("$ARCHESTRA_");
      expect(modified[1]).toEqual({ role: "user", content: "Hello" });
      expect(modified[2].role).toBe("system");
      expect(modified[2].content).toBe("Second system prompt.");
      expect(modified[3]).toEqual({ role: "assistant", content: "Hi!" });
    });
  });

  describe("substituteUntrustedDataWithVariables", () => {
    test("substitutes untrusted tool messages with variables", async () => {
      // Create untrusted tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "sensitive data",
        },
        trusted: false,
        blocked: false,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Get data" },
        {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "sensitive data",
        },
        { role: "assistant", content: "Here is the data" },
      ];

      const substituted = await substituteUntrustedDataWithVariables(
        chatId,
        messages,
      );

      expect(substituted.length).toBe(3);
      expect(substituted[0]).toEqual({ role: "user", content: "Get data" });
      expect(substituted[1]).toEqual({
        role: "tool",
        tool_call_id: "call_untrusted",
        content: "$ARCHESTRA_call_untrusted",
      });
      expect(substituted[2]).toEqual({
        role: "assistant",
        content: "Here is the data",
      });
    });

    test("returns messages unchanged when no untrusted interactions", async () => {
      // Create trusted tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_trusted",
          content: "trusted data",
        },
        trusted: true,
        blocked: false,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Get data" },
        { role: "tool", tool_call_id: "call_trusted", content: "trusted data" },
      ];

      const substituted = await substituteUntrustedDataWithVariables(
        chatId,
        messages,
      );

      expect(substituted).toEqual(messages);
    });

    test("handles empty messages array", async () => {
      const messages: ChatCompletionRequestMessages = [];
      const substituted = await substituteUntrustedDataWithVariables(
        chatId,
        messages,
      );
      expect(substituted).toEqual([]);
    });

    test("only substitutes untrusted tool messages, not other roles", async () => {
      // Create untrusted tool interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "untrusted data",
        },
        trusted: false,
        blocked: false,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "untrusted data" },
        { role: "assistant", content: "untrusted data" },
        {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "untrusted data",
        },
      ];

      const substituted = await substituteUntrustedDataWithVariables(
        chatId,
        messages,
      );

      expect(substituted.length).toBe(3);
      // User and assistant messages unchanged
      expect(substituted[0]).toEqual({
        role: "user",
        content: "untrusted data",
      });
      expect(substituted[1]).toEqual({
        role: "assistant",
        content: "untrusted data",
      });
      // Tool message substituted
      expect(substituted[2]).toEqual({
        role: "tool",
        tool_call_id: "call_untrusted",
        content: "$ARCHESTRA_call_untrusted",
      });
    });

    test("handles multiple untrusted tool messages", async () => {
      // Create multiple untrusted tool interactions
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_1",
          content: "data 1",
        },
        trusted: false,
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
        { role: "tool", tool_call_id: "call_1", content: "data 1" },
        { role: "tool", tool_call_id: "call_2", content: "data 2" },
      ];

      const substituted = await substituteUntrustedDataWithVariables(
        chatId,
        messages,
      );

      expect(substituted.length).toBe(2);
      expect(substituted[0]).toEqual({
        role: "tool",
        tool_call_id: "call_1",
        content: "$ARCHESTRA_call_1",
      });
      expect(substituted[1]).toEqual({
        role: "tool",
        tool_call_id: "call_2",
        content: "$ARCHESTRA_call_2",
      });
    });

    test("substitutes untrusted but not trusted tool messages", async () => {
      // Create both trusted and untrusted tool interactions
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_trusted",
          content: "trusted data",
        },
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "untrusted data",
        },
        trusted: false,
        blocked: false,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "tool", tool_call_id: "call_trusted", content: "trusted data" },
        {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "untrusted data",
        },
      ];

      const substituted = await substituteUntrustedDataWithVariables(
        chatId,
        messages,
      );

      expect(substituted.length).toBe(2);
      expect(substituted[0]).toEqual({
        role: "tool",
        tool_call_id: "call_trusted",
        content: "trusted data",
      });
      expect(substituted[1]).toEqual({
        role: "tool",
        tool_call_id: "call_untrusted",
        content: "$ARCHESTRA_call_untrusted",
      });
    });
  });

  describe("prepareContextForLLM", () => {
    test("applies all three transformations in correct order", async () => {
      // Create untrusted and blocked tool interactions
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "untrusted data",
        },
        trusted: false,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_blocked",
          content: "blocked data",
        },
        trusted: false,
        blocked: true,
        reason: "Blocked by policy",
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Get data" },
        {
          role: "tool",
          tool_call_id: "call_untrusted",
          content: "untrusted data",
        },
        { role: "tool", tool_call_id: "call_blocked", content: "blocked data" },
      ];

      const prepared = await prepareContextForLLM(chatId, messages);

      // Should have system prompt added
      expect(prepared.length).toBe(4);
      expect(prepared[0].role).toBe("system");
      expect(prepared[0].content).toContain("$ARCHESTRA_");

      // Should have untrusted data substituted
      expect(prepared[2]).toEqual({
        role: "tool",
        tool_call_id: "call_untrusted",
        content: "$ARCHESTRA_call_untrusted",
      });

      // Should have blocked data redacted
      expect(prepared[3]).toEqual({
        role: "tool",
        tool_call_id: "call_blocked",
        content: "[REDACTED: Data blocked by policy: Blocked by policy]",
      });
    });

    test("handles empty messages array", async () => {
      const messages: ChatCompletionRequestMessages = [];
      const prepared = await prepareContextForLLM(chatId, messages);

      // Should only have system prompt
      expect(prepared.length).toBe(1);
      expect(prepared[0].role).toBe("system");
      expect(prepared[0].content).toContain("$ARCHESTRA_");
    });

    test("handles messages with no untrusted or blocked data", async () => {
      // Create trusted interaction
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_trusted",
          content: "trusted data",
        },
        trusted: true,
        blocked: false,
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Hello" },
        { role: "tool", tool_call_id: "call_trusted", content: "trusted data" },
        { role: "assistant", content: "Here is the data" },
      ];

      const prepared = await prepareContextForLLM(chatId, messages);

      // Should have system prompt added and other messages unchanged
      expect(prepared.length).toBe(4);
      expect(prepared[0].role).toBe("system");
      expect(prepared[1]).toEqual({ role: "user", content: "Hello" });
      expect(prepared[2]).toEqual({
        role: "tool",
        tool_call_id: "call_trusted",
        content: "trusted data",
      });
      expect(prepared[3]).toEqual({
        role: "assistant",
        content: "Here is the data",
      });
    });

    test("appends to existing system prompt", async () => {
      const messages: ChatCompletionRequestMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ];

      const prepared = await prepareContextForLLM(chatId, messages);

      expect(prepared.length).toBe(2);
      expect(prepared[0].role).toBe("system");
      expect(prepared[0].content).toContain("You are a helpful assistant.");
      expect(prepared[0].content).toContain("$ARCHESTRA_");
      expect(prepared[1]).toEqual({ role: "user", content: "Hello" });
    });

    test("handles complex scenario with multiple types of data", async () => {
      // Create multiple interactions with different trust levels
      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_trusted",
          content: "trusted data",
        },
        trusted: true,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_untrusted_1",
          content: "untrusted data 1",
        },
        trusted: false,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_untrusted_2",
          content: "untrusted data 2",
        },
        trusted: false,
        blocked: false,
      });

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_blocked",
          content: "blocked data",
        },
        trusted: false,
        blocked: true,
        reason: "Contains malicious content",
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "user", content: "Get all data" },
        { role: "tool", tool_call_id: "call_trusted", content: "trusted data" },
        {
          role: "tool",
          tool_call_id: "call_untrusted_1",
          content: "untrusted data 1",
        },
        {
          role: "tool",
          tool_call_id: "call_untrusted_2",
          content: "untrusted data 2",
        },
        { role: "tool", tool_call_id: "call_blocked", content: "blocked data" },
        { role: "assistant", content: "Here are all results" },
      ];

      const prepared = await prepareContextForLLM(chatId, messages);

      // Should have system prompt + original messages
      expect(prepared.length).toBe(7);

      // System prompt should be added
      expect(prepared[0].role).toBe("system");
      expect(prepared[0].content).toContain("$ARCHESTRA_");

      // User message unchanged
      expect(prepared[1]).toEqual({ role: "user", content: "Get all data" });

      // Trusted data unchanged
      expect(prepared[2]).toEqual({
        role: "tool",
        tool_call_id: "call_trusted",
        content: "trusted data",
      });

      // Untrusted data substituted with variables
      expect(prepared[3]).toEqual({
        role: "tool",
        tool_call_id: "call_untrusted_1",
        content: "$ARCHESTRA_call_untrusted_1",
      });
      expect(prepared[4]).toEqual({
        role: "tool",
        tool_call_id: "call_untrusted_2",
        content: "$ARCHESTRA_call_untrusted_2",
      });

      // Blocked data redacted
      expect(prepared[5]).toEqual({
        role: "tool",
        tool_call_id: "call_blocked",
        content:
          "[REDACTED: Data blocked by policy: Contains malicious content]",
      });

      // Assistant message unchanged
      expect(prepared[6]).toEqual({
        role: "assistant",
        content: "Here are all results",
      });
    });

    test("applies transformations in correct order: system prompt, substitution, redaction", async () => {
      // This test verifies the order matters - we should:
      // 1. Add system prompt instructions
      // 2. Substitute untrusted data with variables
      // 3. Redact blocked data
      // The order ensures the LLM gets proper instructions before seeing substituted/redacted data

      await InteractionModel.create({
        chatId,
        content: {
          role: "tool",
          tool_call_id: "call_data",
          content: "some data",
        },
        trusted: false,
        blocked: true,
        reason: "Test reason",
      });

      const messages: ChatCompletionRequestMessages = [
        { role: "tool", tool_call_id: "call_data", content: "some data" },
      ];

      const prepared = await prepareContextForLLM(chatId, messages);

      // System prompt should be first
      expect(prepared[0].role).toBe("system");

      // Data should be both untrusted (normally substituted) BUT also blocked (so redacted instead)
      // Since redaction happens last, blocked data should be redacted, not substituted
      expect(prepared[1]).toEqual({
        role: "tool",
        tool_call_id: "call_data",
        content: "[REDACTED: Data blocked by policy: Test reason]",
      });
    });
  });
});
