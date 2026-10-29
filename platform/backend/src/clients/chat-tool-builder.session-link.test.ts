/**
 * Contract: a tool call the chat engine executes is persisted with the run's
 * LLM session id and the model's own id for the call, so the session view can
 * pair each model tool call with its execution. The row's `tool_call.id` stays
 * the platform's own.
 */

import McpToolCallModel from "@/models/mcp-tool-call";
import { describe, expect, mustExist, test } from "@/test";
import { buildMcpGatewayTool, type ChatToolContext } from "./chat-tool-builder";
import { ToolCallRepeatTracker } from "./tool-call-repeat-tracker";

describe("chat tool calls", () => {
  test("record the run's LLM session and the model's tool call id", async ({
    makeAgent,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: organization.id });
    const ctx: ChatToolContext = {
      agentId: agent.id,
      agentName: agent.name,
      userId: user.id,
      organizationId: organization.id,
      sessionId: "conversation-1",
      mcpGwToken: {
        tokenValue: null,
        tokenId: "user-token",
        teamId: null,
        isOrganizationToken: false,
        isUserToken: true,
      },
      repeatTracker: new ToolCallRepeatTracker(),
      modelAcceptsImageToolResults: true,
    };
    // The agent has no such tool, so mcpClient records a refusal without
    // reaching any server — the same row path as an executed call.
    const tool = buildMcpGatewayTool({
      mcpTool: {
        name: "missing_server__do_thing",
        description: "",
        inputSchema: { type: "object", properties: {} },
      },
      ctx,
    });

    await mustExist(tool.execute)(
      {},
      { toolCallId: "toolu_model_1", messages: [] },
    );

    const page = await McpToolCallModel.findAllCursorPaginated(
      { limit: 10 },
      undefined,
      undefined,
      { agentId: agent.id },
    );
    const row = mustExist(page.data[0]);
    expect(row).toMatchObject({
      method: "tools/call",
      sessionId: "conversation-1",
      llmToolCallId: "toolu_model_1",
      userId: user.id,
    });
    expect(row.toolCall).not.toMatchObject({ id: "toolu_model_1" });
  });
});
