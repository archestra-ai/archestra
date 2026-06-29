import { AgentToolModel, ToolModel, TrustedDataPolicyModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";
import type { Tool } from "@/types";
import { evaluateToolExecutionContextTrust } from "./context-trust";

describe("evaluateToolExecutionContextTrust", () => {
  let agentId: string;
  let organizationId: string;
  let toolId: string;

  beforeEach(async ({ makeAgent }) => {
    const agent = await makeAgent();
    agentId = agent.id;
    organizationId = agent.organizationId;

    await ToolModel.createToolIfNotExists({
      agentId,
      name: "read_email",
      parameters: {},
      description: "Read email",
    });

    const tool = await ToolModel.findByName("read_email");
    toolId = (tool as Tool).id;
    await AgentToolModel.create(agentId, toolId, {});
  });

  test("marks delegated tool execution context unsafe when prior tool results are untrusted", async () => {
    await TrustedDataPolicyModel.create({
      toolId,
      description: "Mark external mail as sensitive",
      conditions: [
        {
          key: "emails[*].from",
          operator: "contains",
          value: "@external.com",
        },
      ],
      action: "mark_as_untrusted",
    });

    const result = await evaluateToolExecutionContextTrust({
      agentId,
      organizationId,
      userId: "user-123",
      considerContextUntrusted: false,
      globalToolPolicy: "restrictive",
      policyContext: {
        externalAgentId: "chat",
      },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Summarize what the email said." }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-email-1",
              toolName: "read_email",
              output: {
                type: "json",
                value: {
                  emails: [{ from: "ceo@external.com", subject: "Urgent" }],
                },
              },
            },
          ],
        },
      ],
    });

    expect(result.contextIsTrusted).toBe(false);
    expect(result.unsafeContextBoundary).toEqual({
      kind: "tool_result",
      reason: "tool_result_marked_untrusted",
      toolCallId: "call-email-1",
      toolName: "read_email",
    });
  });

  test("keeps a preexisting unsafe context unsafe before delegation", async () => {
    const result = await evaluateToolExecutionContextTrust({
      agentId,
      organizationId,
      userId: "user-123",
      considerContextUntrusted: true,
      globalToolPolicy: "restrictive",
      policyContext: {
        externalAgentId: "chat",
      },
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Continue the workflow." }],
        },
      ],
    });

    expect(result.contextIsTrusted).toBe(false);
    expect(result.unsafeContextBoundary).toEqual({
      kind: "preexisting_untrusted",
      reason: "agent_configured_untrusted",
    });
  });
});
