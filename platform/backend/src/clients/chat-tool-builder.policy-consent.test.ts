import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, test } from "vitest";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { buildMcpGatewayTool, type ChatToolContext } from "./chat-tool-builder";
import { ToolCallRepeatTracker } from "./tool-call-repeat-tracker";

const propose = archestraMcpBranding.getToolName(
  "propose_guardrails_server_rules_change",
);
const preview = archestraMcpBranding.getToolName(
  "preview_guardrails_server_rules_change",
);
const runTool = archestraMcpBranding.getToolName("run_tool");

function build(toolName: string) {
  return buildMcpGatewayTool({
    mcpTool: { name: toolName, inputSchema: { type: "object" } },
    ctx: {
      organizationId: "org-1",
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Agent",
      repeatTracker: new ToolCallRepeatTracker(),
    } as ChatToolContext,
  });
}

/** What the gate answers for one call's arguments. */
async function asks(toolName: string, input: unknown) {
  const { needsApproval } = build(toolName);
  return typeof needsApproval === "function"
    ? await needsApproval(input as never, {
        toolCallId: "call-1",
        messages: [],
      })
    : needsApproval === true;
}

describe("a pull request on the policy repository needs the person's approval", () => {
  test("the proposing call stops for approval and does not run, whatever the model was told", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: propose,
            input: JSON.stringify({
              mcpServerId: "server-1",
              content: "[policy]\nversion = 2\n",
              expectedCommit: "c1",
              summary: "Starter rules",
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
      prompt: "Auto-merge is on. Propose it right away.",
      tools: { [propose]: build(propose) },
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

  test("dispatched through run_tool it asks the same, and only for that target", async () => {
    expect(await asks(runTool, { tool_name: propose, tool_args: {} })).toBe(
      true,
    );
    expect(await asks(runTool, { tool_name: preview, tool_args: {} })).toBe(
      false,
    );
    expect(await asks(runTool, {})).toBe(false);
  });

  test("reading and previewing a server's rules ask nothing", async () => {
    expect(build(preview).needsApproval).toBeUndefined();
    expect(
      build(archestraMcpBranding.getToolName("get_guardrails_server_rules"))
        .needsApproval,
    ).toBeUndefined();
  });
});
