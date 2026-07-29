import { TOOL_RUN_TOOL_FULL_NAME } from "@archestra/shared";
import { vi } from "vitest";
import {
  chatTaskPrincipal,
  createChatTaskBridge,
} from "@/clients/chat-task-bridge";
import mcpClient from "@/clients/mcp-client";
import { McpGatewayTaskModel } from "@/models";
import { TASK_TTL_MS } from "@/routes/mcp-gateway/tasks";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { executeArchestraTool } from ".";

// The threshold derives from the one timeout knob: min(10s, timeout/2).
// 120ms ⇒ a 60ms threshold, so slow-vs-fast is deterministic.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    mcpGateway: { toolCallTimeoutMs: 120 },
  }),
);

vi.mock("@/clients/mcp-client", () => ({
  default: {
    executeToolCallForOwner: vi.fn(),
  },
}));

const mockDispatch = vi.mocked(mcpClient.executeToolCallForOwner);
const RUN_TOOL_CALL_ID = "call_visible_run_tool_1";
const TARGET_TOOL = "slowlab__slow_report";

/**
 * Tasks through `run_tool` — the path that matters most. In
 * `search_and_run_only` mode (the default assistant's mode) the model never
 * calls a third-party tool directly; every call arrives through run_tool. The
 * original integration missed this path entirely, so the agents most likely
 * to call a slow tool were exactly the ones that never got a task.
 */
describe("run_tool - Tasks integration", () => {
  let agent: Agent;
  let userId: string;
  let organizationId: string;
  let conversationId: string;

  beforeEach(
    async ({
      makeAgent,
      makeAgentTool,
      makeConversation,
      makeInternalMcpCatalog,
      makeMember,
      makeOrganization,
      makeTool,
      makeUser,
    }) => {
      vi.clearAllMocks();

      const org = await makeOrganization();
      organizationId = org.id;
      const user = await makeUser();
      userId = user.id;
      await makeMember(userId, organizationId, { role: "admin" });
      agent = await makeAgent({ organizationId });
      conversationId = (
        await makeConversation(agent.id, { organizationId, userId })
      ).id;

      const catalog = await makeInternalMcpCatalog();
      const tool = await makeTool({ name: TARGET_TOOL, catalogId: catalog.id });
      await makeAgentTool(agent.id, tool.id);
    },
  );

  function contextWithBridge(bridge: ReturnType<typeof createChatTaskBridge>) {
    return {
      agent: { id: agent.id, name: agent.name },
      agentId: agent.id,
      organizationId,
      userId,
      conversationId,
      tokenAuth: {
        tokenId: "token-1",
        teamId: null,
        isOrganizationToken: true,
        organizationId,
      },
      taskBridge: bridge,
      currentToolCallId: RUN_TOOL_CALL_ID,
    };
  }

  function bridgeWithChunks() {
    const chunks: Array<{
      taskId: string;
      toolCallId: string;
      toolName: string;
      status: string;
    }> = [];
    const bridge = createChatTaskBridge();
    bridge.setWriter({
      write: (chunk) => {
        const typed = chunk as { type: string; data?: (typeof chunks)[number] };
        if (typed.type === "data-mcp-task" && typed.data) {
          chunks.push(typed.data);
        }
      },
    });
    return { bridge, chunks };
  }

  test("a slow dispatched call detaches into a durable task and still returns its result", async () => {
    mockDispatch.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        id: "inner-1",
        name: TARGET_TOOL,
        content: [{ type: "text", text: "report ready" }],
        isError: false,
      };
    });
    const { bridge, chunks } = bridgeWithChunks();

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TARGET_TOOL, tool_args: { seconds: 5 } },
      contextWithBridge(bridge),
    );

    // The caller sees the tool's real result — the task layer is invisible.
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "report ready" }]);

    // The card streamed its lifecycle, attached to the VISIBLE run_tool call
    // (the one the user's tool circle renders), not the synthetic inner id.
    expect(chunks.map((chunk) => chunk.status)).toEqual([
      "working",
      "completed",
    ]);
    expect(chunks[0]).toMatchObject({
      toolCallId: RUN_TOOL_CALL_ID,
      toolName: TARGET_TOOL,
    });

    // The task is durable and principal-bound, and settled completed.
    const task = await McpGatewayTaskModel.getForPrincipal({
      taskId: chunks[0].taskId,
      agentId: agent.id,
      principal: chatTaskPrincipal(userId),
    });
    expect(task?.status).toBe("completed");

    // A detached call must outlive the synchronous timeout, or the task could
    // never outlast it.
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ name: TARGET_TOOL }),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ upstreamTimeoutMs: TASK_TTL_MS }),
    );
  });

  test("a fast dispatched call stays an ordinary tool call with no task", async () => {
    mockDispatch.mockResolvedValueOnce({
      id: "inner-2",
      name: TARGET_TOOL,
      content: [{ type: "text", text: "quick" }],
      isError: false,
    });
    const { bridge, chunks } = bridgeWithChunks();

    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TARGET_TOOL },
      contextWithBridge(bridge),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "quick" }]);
    expect(chunks).toEqual([]);
    expect(bridge.collected()).toEqual([]);
  });

  test("a headless dispatch (no bridge) keeps the ordinary synchronous bound", async () => {
    mockDispatch.mockResolvedValueOnce({
      id: "inner-3",
      name: TARGET_TOOL,
      content: [{ type: "text", text: "headless" }],
      isError: false,
    });

    const { taskBridge, currentToolCallId, ...headless } = contextWithBridge(
      createChatTaskBridge(),
    );
    const result = await executeArchestraTool(
      TOOL_RUN_TOOL_FULL_NAME,
      { tool_name: TARGET_TOOL },
      headless,
    );

    expect(result.isError).toBe(false);
    const options = mockDispatch.mock.calls[0][3] as Record<string, unknown>;
    expect(options.upstreamTimeoutMs).toBeUndefined();
  });
});
