import { AgentModel, ToolModel, TrustedDataPolicyModel } from "@/models";
import type { OpenAi, Tool } from "@/types";
import { evaluateIfContextIsTrusted } from "./openai";

type Messages = OpenAi.Types.ChatCompletionsRequest["messages"];

describe("trusted-data openai utils", () => {
  let agentId: string;
  let toolId: string;

  beforeEach(async () => {
    // Create test agent
    const agent = await AgentModel.create({
      name: "Test Agent",
      usersWithAccess: [],
    });
    agentId = agent.id;

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

  describe("evaluateIfContextIsTrusted", () => {
    test("returns trusted context when no tool messages exist", async () => {
      const messages: Messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("marks context as untrusted and filters messages when tool message matches block policy", async () => {
      // Create a block policy
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "contains",
        value: "hacker",
        action: "block_always",
        description: "Block hacker emails",
      });

      const messages: Messages = [
        { role: "user", content: "Get emails" },
        {
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
        { role: "assistant", content: "Here are your emails" },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      // Context should be untrusted and blocked tool message should be filtered
      expect(result.contextIsTrusted).toBe(false);
      expect(result.filteredMessages).toEqual([
        { role: "user", content: "Get emails" },
        {
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
        {
          role: "tool",
          tool_call_id: "call_456",
          content:
            "[Content blocked by policy: Data blocked by policy: Block hacker emails]",
        },
        { role: "assistant", content: "Here are your emails" },
      ]);
    });

    test("marks context as trusted when tool message matches allow policy", async () => {
      // Create an allow policy
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "endsWith",
        value: "@trusted.com",
        action: "mark_as_trusted",
        description: "Allow trusted emails",
      });

      const messages: Messages = [
        {
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

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("marks context as untrusted when no policies match", async () => {
      // Create a policy that won't match
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "endsWith",
        value: "@trusted.com",
        action: "mark_as_trusted",
        description: "Allow trusted emails",
      });

      const messages: Messages = [
        {
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
        {
          role: "tool",
          tool_call_id: "call_789",
          content: JSON.stringify({
            emails: [{ from: "user@untrusted.com", subject: "Hello" }],
          }),
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      // Context should be untrusted when no policies match
      expect(result.contextIsTrusted).toBe(false);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("handles multiple tool messages with mixed trust", async () => {
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

      const messages: Messages = [
        {
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
            {
              id: "call_002",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
            {
              id: "call_003",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
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
        {
          role: "tool",
          tool_call_id: "call_003",
          content: JSON.stringify({ source: "unknown", data: "some data" }),
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      // Context should be untrusted if any tool message is blocked or untrusted
      expect(result.contextIsTrusted).toBe(false);
      expect(result.filteredMessages).toEqual([
        {
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
            {
              id: "call_002",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
            {
              id: "call_003",
              type: "function",
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_001",
          content: JSON.stringify({ source: "trusted", data: "good data" }),
        },
        {
          role: "tool",
          tool_call_id: "call_002",
          content:
            "[Content blocked by policy: Data blocked by policy: Block malicious source]",
        },
        {
          role: "tool",
          tool_call_id: "call_003",
          content: JSON.stringify({ source: "unknown", data: "some data" }),
        },
      ]);
    });

    test("handles tool messages without matching tool definition", async () => {
      const messages: Messages = [
        {
          role: "tool",
          tool_call_id: "call_unknown",
          content: JSON.stringify({ data: "some data" }),
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      // Should mark as untrusted when tool is not found
      expect(result.contextIsTrusted).toBe(false);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("handles invalid JSON in tool message content", async () => {
      const messages: Messages = [
        {
          role: "tool",
          tool_call_id: "call_123",
          content: "not json",
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      // Should handle gracefully and mark as untrusted
      expect(result.contextIsTrusted).toBe(false);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("preserves non-tool messages unchanged", async () => {
      const messages: Messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "system", content: "You are helpful" },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("marks context as trusted when tool has dataIsTrustedByDefault", async () => {
      // Create a tool with dataIsTrustedByDefault
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "trusted_tool",
        parameters: {},
        description: "Tool that trusts data by default",
        allowUsageWhenUntrustedDataIsPresent: false,
        dataIsTrustedByDefault: true,
      });

      const messages: Messages = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_trusted",
              type: "function",
              function: {
                name: "trusted_tool",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_trusted",
          content: JSON.stringify({ data: "any data" }),
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.filteredMessages).toEqual(messages);
    });

    test("block policies override dataIsTrustedByDefault", async () => {
      // Create a tool with dataIsTrustedByDefault
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "default_trusted_tool",
        parameters: {},
        description: "Tool that trusts data by default",
        allowUsageWhenUntrustedDataIsPresent: false,
        dataIsTrustedByDefault: true,
      });

      const tool = await ToolModel.findByName("default_trusted_tool");
      const trustedToolId = (tool as Tool).id;

      // Create a block policy
      await TrustedDataPolicyModel.create({
        toolId: trustedToolId,
        attributePath: "dangerous",
        operator: "equal",
        value: "true",
        action: "block_always",
        description: "Block dangerous data",
      });

      const messages: Messages = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_blocked",
              type: "function",
              function: {
                name: "default_trusted_tool",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_blocked",
          content: JSON.stringify({ dangerous: "true", other: "data" }),
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        messages,
        agentId,
        "test-api-key",
      );

      expect(result.contextIsTrusted).toBe(false);
      expect(result.filteredMessages[1].content).toContain("[Content blocked");
    });
  });
});
