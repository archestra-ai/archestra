import { AgentToolModel, ToolModel, TrustedDataPolicyModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { CommonMessage, Tool } from "@/types";
import { evaluateIfContextIsTrusted } from "./trusted-data";

describe("trusted-data evaluation (provider-agnostic)", () => {
  let agentId: string;
  let toolId: string;

  beforeEach(async ({ makeAgent }) => {
    // Create test agent
    const agent = await makeAgent();
    agentId = agent.id;

    // Create test tool
    await ToolModel.createToolIfNotExists({
      agentId,
      name: "get_emails",
      parameters: {},
      description: "Get emails",
    });

    const tool = await ToolModel.findByName("get_emails");
    toolId = (tool as Tool).id;

    // Create agent-tool relationship (untrusted by default when no policies)
    await AgentToolModel.create(agentId, toolId, {});
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
        false,
        "restrictive",
        { teamIds: [] },
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("marks context as untrusted and blocks tool result when matching block policy", async () => {
      // Create a block policy
      await TrustedDataPolicyModel.create({
        toolId,
        conditions: [
          { key: "emails[*].from", operator: "contains", value: "hacker" },
        ],
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
              content: {
                emails: [
                  { from: "hacker@company.com", subject: "Suspicious" },
                  { from: "hacker@evil.com", subject: "Malicious" },
                ],
              },
              isError: false,
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
        false,
        "restrictive",
        { teamIds: [] },
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
        conditions: [
          {
            key: "emails[*].from",
            operator: "endsWith",
            value: "@trusted.com",
          },
        ],
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
              content: {
                emails: [
                  { from: "user@trusted.com", subject: "Hello" },
                  { from: "admin@trusted.com", subject: "Update" },
                ],
              },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("marks context as untrusted when no policies match", async () => {
      // Create a policy that won't match
      await TrustedDataPolicyModel.create({
        toolId,
        conditions: [
          {
            key: "emails[*].from",
            operator: "endsWith",
            value: "@trusted.com",
          },
        ],
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
              content: {
                emails: [{ from: "user@untrusted.com", subject: "Hello" }],
              },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
      );

      // Context should be untrusted when no policies match
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("handles multiple tool calls with mixed trust", async () => {
      // Create policies
      await TrustedDataPolicyModel.create({
        toolId,
        conditions: [{ key: "source", operator: "equal", value: "trusted" }],
        action: "mark_as_trusted",
        description: "Allow trusted source",
      });

      await TrustedDataPolicyModel.create({
        toolId,
        conditions: [{ key: "source", operator: "equal", value: "malicious" }],
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
              content: { source: "trusted", data: "good data" },
              isError: false,
            },
            {
              id: "call_002",
              name: "get_emails",
              content: { source: "malicious", data: "bad data" },
              isError: false,
            },
            {
              id: "call_003",
              name: "get_emails",
              content: { source: "unknown", data: "some data" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
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
              content: { data: "some data" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
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
              content: "plain text result",
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
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
        false,
        "restrictive",
        { teamIds: [] },
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("marks context as trusted when tool has trusted default policy", async () => {
      // Create a tool with trusted default policy
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "trusted_tool",
        parameters: {},
        description: "Tool that trusts data by default",
      });

      const trustedTool = await ToolModel.findByName("trusted_tool");
      const trustedToolId = (trustedTool as Tool).id;

      // Create agent-tool relationship
      await AgentToolModel.create(agentId, trustedToolId, {});

      // Delete auto-created default policy and create trusted policy
      await TrustedDataPolicyModel.deleteByToolId(trustedToolId);
      await TrustedDataPolicyModel.create({
        toolId: trustedToolId,
        conditions: [],
        action: "mark_as_trusted",
      });

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_trusted",
              name: "trusted_tool",
              content: { data: "any data" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
      );

      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("block policies override trusted default policy", async () => {
      // Create a tool with trusted default policy
      await ToolModel.createToolIfNotExists({
        agentId,
        name: "default_trusted_tool",
        parameters: {},
        description: "Tool that trusts data by default",
      });

      const tool = await ToolModel.findByName("default_trusted_tool");
      const trustedToolId = (tool as Tool).id;

      // Create agent-tool relationship
      await AgentToolModel.create(agentId, trustedToolId, {});

      // Create default trusted policy
      await TrustedDataPolicyModel.create({
        toolId: trustedToolId,
        conditions: [],
        action: "mark_as_trusted",
      });

      // Create a block policy
      await TrustedDataPolicyModel.create({
        toolId: trustedToolId,
        conditions: [{ key: "dangerous", operator: "equal", value: "true" }],
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
              content: { dangerous: "true", other: "data" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
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
              content: { from: "user1@example.com" },
              isError: false,
            },
            {
              id: "call_2",
              name: "get_emails",
              content: { from: "user2@example.com" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive",
        { teamIds: [] },
      );

      // Both should be untrusted (no policies match)
      expect(result.contextIsTrusted).toBe(false);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("YOLO mode: trusts all data when globalToolPolicy is permissive", async () => {
      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_yolo",
              name: "get_emails",
              content: { from: "untrusted@example.com", data: "anything" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "permissive", // YOLO mode
        { teamIds: [] },
      );

      // In permissive mode, all data is trusted regardless of policies
      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("YOLO mode: ignores block policies in permissive mode", async () => {
      // Create a block policy - should be ignored in YOLO mode
      await TrustedDataPolicyModel.create({
        toolId,
        conditions: [{ key: "from", operator: "contains", value: "hacker" }],
        action: "block_always",
        description: "Block hacker emails",
      });

      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_allowed",
              name: "get_emails",
              content: { from: "hacker@evil.com" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "permissive", // YOLO mode
        { teamIds: [] },
      );

      // YOLO mode trusts everything, ignores block policies
      expect(result.contextIsTrusted).toBe(true);
      expect(result.toolResultUpdates).toEqual({});
    });

    test("restrictive mode: marks data as untrusted when no policies exist", async () => {
      const commonMessages: CommonMessage[] = [
        { role: "assistant" },
        {
          role: "tool",
          toolCalls: [
            {
              id: "call_untrusted",
              name: "get_emails",
              content: { from: "user@example.com" },
              isError: false,
            },
          ],
        },
      ];

      const result = await evaluateIfContextIsTrusted(
        commonMessages,
        agentId,
        "test-api-key",
        "openai",
        false,
        "restrictive", // Default restrictive mode
        { teamIds: [] },
      );

      // In restrictive mode with no policies, data should be untrusted
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
        false,
        "restrictive",
        { teamIds: [] },
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
        false,
        "restrictive",
        { teamIds: [] },
      );
      const updated = applyUpdates(anthropicMessages, result.toolResultUpdates);

      // Should preserve original structure
      expect(updated).toHaveLength(3);
      expect(updated[0]).toEqual(anthropicMessages[0]);
      expect(updated[1]).toEqual(anthropicMessages[1]);
    });
  });
});
