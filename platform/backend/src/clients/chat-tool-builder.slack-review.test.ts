import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test, vi } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import * as openappaService from "@/openappa/service";
import { buildMcpGatewayTool, type ChatToolContext } from "./chat-tool-builder";
import { ToolCallRepeatTracker } from "./tool-call-repeat-tracker";

const remedyTool = archestraMcpBranding.getToolName("execute_remedy_plan");

function build(toolName: string, openappaSlackReview: boolean) {
  return buildMcpGatewayTool({
    mcpTool: { name: toolName, inputSchema: { type: "object" } },
    ctx: {
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Agent",
      repeatTracker: new ToolCallRepeatTracker(),
      openappaSlackReview,
    } as ChatToolContext,
  });
}

describe("Slack OpenAPPA review gate", () => {
  test("a reviewed remedy call in a Slack run pauses for approval instead of running", async () => {
    vi.spyOn(openappaService, "loadOfferReview").mockResolvedValue({
      offer_id: "offer-1",
      text: "Approve this call?",
      session_id: "chatops:slack:C1:1",
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: remedyTool,
            input: JSON.stringify({
              offer_id: "offer-1",
              trajectory: { v: 1, session_id: "chatops:slack:C1:1" },
            }),
          },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    });

    const result = await generateText({
      model,
      prompt: "Send it.",
      tools: { [remedyTool]: build(remedyTool, true) },
      stopWhen: stepCountIs(2),
    });

    expect(result.steps).toHaveLength(1);
    expect(result.toolResults).toEqual([]);
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "tool-approval-request",
        toolCall: expect.objectContaining({ toolCallId: "call-1" }),
      }),
    );
  });

  test("only Slack runs, and only the remedy tool, get the gate", () => {
    expect(build(remedyTool, false).needsApproval).toBeUndefined();
    expect(
      build(archestraMcpBranding.getToolName("whoami"), true).needsApproval,
    ).toBeUndefined();
    expect(build(remedyTool, true).needsApproval).toBeTypeOf("function");
  });
});
