import { AgentModel, ToolModel, TrustedDataPolicyModel } from "@/models";
import type { Tool } from "@/types";
import { evaluateIfContextIsTrusted } from "./trusted-data";
import type { CommonMessage } from "./types";

describe("trusted-data evaluation (provider-agnostic)", () => {
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
      toolResultTreatment: "untrusted",
    });

    const tool = await ToolModel.findByName("get_emails");
    toolId = (tool as Tool).id;
  });

  describe("evaluateIfContextIsTrusted", () => {
    test("returns trusted context when no tool calls exist", async () => {
      const commonMessages: CommonMessage[] = [
        { role: "user" },
        { role: "assistant" },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("marks context as untrusted and blocks tool result when matching block policy", async () => {
      // Create a block policy
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "contains",
        value: "hacker",
        action: "block_always",
        description: "Block hacker emails",
      });

      const commonMessages: CommonMessage[] = [
        { role: "user" },
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_456",
              name: "get_emails",
              result: {
                emails: [
                  { from: "user@company.com", subject: "Normal" },
                  { from: "hacker@evil.com", subject: "Malicious" },
                ],
              },
            },
          ],
        },
        { role: "assistant" },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      // Context should be untrusted and tool result should be blocked
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({
        call_456:
          "[Content blocked by policy: Data blocked by policy: Block hacker emails]",
      });
    });

    test("marks context as trusted when tool result matches allow policy", async () => {
      // Create an allow policy
      await TrustedDataPolicyModel.create({
        toolId,
        attributePath: "emails[*].from",
        operator: "endsWith",
        value: "@trusted.com",
        action: "mark_as_trusted",
        description: "Allow trusted emails",
      });

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_123",
              name: "get_emails",
              result: {
                emails: [
                  { from: "user@trusted.com", subject: "Hello" },
                  { from: "admin@trusted.com", subject: "Update" },
                ],
              },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
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

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_789",
              name: "get_emails",
              result: {
                emails: [{ from: "user@untrusted.com", subject: "Hello" }],
              },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      // Context should be untrusted when no policies match
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("handles multiple tool calls with mixed trust", async () => {
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

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_001",
              name: "get_emails",
              result: { source: "trusted", data: "good data" },
            },
            {
              id: "call_002",
              name: "get_emails",
              result: { source: "malicious", data: "bad data" },
            },
            {
              id: "call_003",
              name: "get_emails",
              result: { source: "unknown", data: "some data" },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      // Context should be untrusted if any tool result is blocked or untrusted
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({
        call_002:
          "[Content blocked by policy: Data blocked by policy: Block malicious source]",
      });
    });

    test("handles tool calls without matching tool definition", async () => {
      const commonMessages: CommonMessage[] = [
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_unknown",
              name: "unknown_tool",
              result: { data: "some data" },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      // Should mark as untrusted when tool is not found
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("handles non-JSON tool result gracefully", async () => {
      const commonMessages: CommonMessage[] = [
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_123",
              name: "get_emails",
              result: "plain text result",
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      // Should handle gracefully and mark as untrusted
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("preserves non-tool messages unchanged", async () => {
      const commonMessages: CommonMessage[] = [
        { role: "user" },
        { role: "assistant" },
        { role: "system" },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("marks context as trusted when tool has trusted treatment", async () => {
      // Create a tool with trusted treatment
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "trusted_tool",
        parameters: {},
        description: "Tool that trusts data by default",
        allowUsageWhenUntrustedDataIsPresent: false,
        toolResultTreatment: "trusted",
      });

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_trusted",
              name: "trusted_tool",
              result: { data: "any data" },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("block policies override trusted treatment", async () => {
      // Create a tool with trusted treatment
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "default_trusted_tool",
        parameters: {},
        description: "Tool that trusts data by default",
        allowUsageWhenUntrustedDataIsPresent: false,
        toolResultTreatment: "trusted",
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

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_blocked",
              name: "default_trusted_tool",
              result: { dangerous: "true", other: "data" },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({
        call_blocked:
          "[Content blocked by policy: Data blocked by policy: Block dangerous data]",
      });
    });

    test("handles messages with multiple tool calls in same message", async () => {
      const commonMessages: CommonMessage[] = [
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_1",
              name: "get_emails",
              result: { from: "user1@example.com" },
            },
            {
              id: "call_2",
              name: "get_emails",
              result: { from: "user2@example.com" },
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );

      // Both should be untrusted (no policies match)
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({});
    });
  });

  describe("adapter integration tests", () => {
    test("OpenAI adapter roundtrip", async () => {
      const { toCommonFormat, applyUpdates } = await import(
        "./adapters/openai"
      );

      const openAiMessages = [
        { role: "user" as const, content: "Get emails" },
        {
          role: "assistant" as const,
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function" as const,
              function: {
                name: "get_emails",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool" as const,
          tool_call_id: "call_123",
          content: JSON.stringify({ data: "test" }),
        },
      ];

      const commonMessages = toCommonFormat(openAiMessages);
      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
      );
      const updated = applyUpdates(openAiMessages, result.toolResultUpdates);

      // Should preserve original structure
      expect(updated).toHaveLength(3);
      expect(updated[0]).toEqual(openAiMessages[0]);
      expect(updated[1]).toEqual(openAiMessages[1]);
    });

    test("Anthropic adapter roundtrip", async () => {
      const { toCommonFormat, applyUpdates } = await import(
        "./adapters/anthropic"
      );

      const anthropicMessages = [
        { role: "user" as const, content: "Get emails" },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "tool_123",
              name: "get_emails",
              input: {},
            },
          ],
        },
        {
          role: "user" as const,
          content: [
            {
              type: "tool_result" as const,
              tool_use_id: "tool_123",
              content: JSON.stringify({ data: "test" }),
            },
          ],
        },
      ];

      const commonMessages = toCommonFormat(anthropicMessages);
      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "anthropic",
      );
      const updated = applyUpdates(anthropicMessages, result.toolResultUpdates);

      // Should preserve original structure
      expect(updated).toHaveLength(3);
      expect(updated[0]).toEqual(anthropicMessages[0]);
      expect(updated[1]).toEqual(anthropicMessages[1]);
    });
  });
});
