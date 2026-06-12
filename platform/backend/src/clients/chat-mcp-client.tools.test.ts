// Characterization tests for getChatMcpTools composition: the per-kind AI SDK
// wrappers (MCP gateway tools vs agent delegation tools), their approval and
// hook pipelines, error handling, metric emission, and tool-cache gating.
// Mocks sit only at process boundaries: the MCP SDK client (gateway transport),
// mcpClient.executeToolCall (gateway network call), executeA2AMessage
// (child-agent execution), hookDispatcherService.fire (hook scripts run in
// Dagger sandbox containers), the browser-stream feature (browser pods), and
// the external-IdP session token resolver (IdP network call).
import {
  getArchestraToolFullName,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
} from "@archestra/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "ai";
import { beforeEach, vi } from "vitest";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import { ToolModel } from "@/models";
import { metrics } from "@/observability";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import { describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";
import mcpClient from "./mcp-client";

const mockExecuteA2AMessage = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  // biome-ignore lint/complexity/useArrowFunction: mock constructor to satisfy Vitest class warning
  Client: vi.fn(function () {
    return { connect: vi.fn(), close: vi.fn(), ping: vi.fn() };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock("@/clients/mcp-client", () => ({
  default: {
    executeToolCall: vi.fn(),
  },
}));

vi.mock("@/features/browser-stream/services/browser-stream.feature", () => ({
  browserStreamFeature: {
    isEnabled: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("@/services/identity-providers/session-token", () => ({
  resolveSessionExternalIdpToken: vi.fn(),
}));

vi.mock("@/agents/a2a-executor", () => ({
  executeA2AMessage: (...args: unknown[]) => mockExecuteA2AMessage(...args),
}));

/** Minimal AI SDK execution options accepted by the tool wrappers under test. */
const execOptions = (toolCallId?: string) =>
  ({ toolCallId, messages: [] }) as unknown as Parameters<
    NonNullable<Tool["execute"]>
  >[1];

const callableNeedsApproval = (tool: Tool) => {
  expect(typeof tool.needsApproval).toBe("function");
  return tool.needsApproval as Exclude<
    NonNullable<Tool["needsApproval"]>,
    boolean
  >;
};

const toolResultContent = (result: unknown): string =>
  typeof result === "string" ? result : (result as { content: string }).content;

const buildMockGatewayClient = (
  tools: Array<Record<string, unknown>>,
): Client => {
  return {
    ping: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({ tools }),
    callTool: vi.fn(),
    close: vi.fn(),
  } as unknown as Client;
};

const externalTool = (name: string, description = "") => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(mcpClient.executeToolCall).mockReset();
  mockExecuteA2AMessage.mockReset();
  vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue(null);
});

describe("getChatMcpTools per-kind tool shape", () => {
  test("pins schema normalization, description fallback, and toModelOutput per kind", async ({
    makeAgent,
    makeAgentTool,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Shape Agent",
    });
    const targetAgent = await makeAgent({
      organizationId: org.id,
      name: "Research Helper",
      description: "Researches things",
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(agent.id, delegationTool.id);

    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([externalTool("extsrv__fetch_data")]),
    );

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    const mcpTool = tools.extsrv__fetch_data;
    expect(mcpTool).toBeDefined();
    expect(mcpTool.description).toBe("Tool: extsrv__fetch_data");
    expect(typeof mcpTool.toModelOutput).toBe("function");
    expect(typeof mcpTool.needsApproval).toBe("function");
    expect(
      (
        mcpTool.inputSchema as unknown as {
          jsonSchema: Record<string, unknown>;
        }
      ).jsonSchema,
    ).toMatchObject({ type: "object", additionalProperties: false });

    const agentTool = tools[delegationTool.name];
    expect(agentTool).toBeDefined();
    expect(agentTool.description).toBe(
      "Delegate task to agent: Research Helper. Researches things",
    );
    expect(agentTool.toModelOutput).toBeUndefined();
    expect(typeof agentTool.needsApproval).toBe("function");

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });
});

describe("getChatMcpTools MCP tool execute pipeline", () => {
  test("executes an external tool through pre-hook, gateway call, post-hook in order", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Pipeline Agent",
    });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([externalTool("extsrv__fetch_data")]),
    );

    const callOrder: string[] = [];
    const fireSpy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockImplementation(async ({ event }) => {
        callOrder.push(event);
        return { decision: "proceed", runs: [] };
      });
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");
    vi.mocked(mcpClient.executeToolCall).mockImplementation(async () => {
      callOrder.push("gateway");
      return {
        content: [{ type: "text", text: "external result" }],
        isError: false,
      } as never;
    });

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    const result = await tools.extsrv__fetch_data.execute?.(
      { query: "q" },
      execOptions("call-1"),
    );

    expect(callOrder).toEqual(["pre_tool_use", "gateway", "post_tool_use"]);
    expect(toolResultContent(result)).toContain("external result");
    expect(fireSpy).toHaveBeenCalledTimes(2);
    expect(metricsSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "extsrv__fetch_data",
        isError: false,
      }),
    );

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("a PreToolUse block short-circuits the gateway call and reports an error metric", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Blocked Agent",
    });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([externalTool("extsrv__fetch_data")]),
    );

    const fireSpy = vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "block",
      reason: "policy says no",
      runs: [],
    });
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    const result = await tools.extsrv__fetch_data.execute?.(
      { query: "q" },
      execOptions("call-2"),
    );

    expect(toolResultContent(result)).toContain(
      "Tool call blocked by a PreToolUse hook",
    );
    expect(toolResultContent(result)).toContain("policy says no");
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true }),
    );

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("appends PostToolUse feedback to the tool result", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Feedback Agent",
    });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([externalTool("extsrv__fetch_data")]),
    );

    vi.spyOn(hookDispatcherService, "fire").mockImplementation(
      async ({ event }) =>
        event === "post_tool_use"
          ? { decision: "block", reason: "be careful", runs: [] }
          : { decision: "proceed", runs: [] },
    );
    vi.mocked(mcpClient.executeToolCall).mockResolvedValue({
      content: [{ type: "text", text: "external result" }],
      isError: false,
    } as never);

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    const result = await tools.extsrv__fetch_data.execute?.(
      { query: "q" },
      execOptions("call-3"),
    );

    expect(toolResultContent(result)).toContain("external result");
    expect(toolResultContent(result)).toContain("[hook feedback] be careful");

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });
});

describe("getChatMcpTools agent delegation execute pipeline", () => {
  test("executes a delegation tool via the child-agent boundary without firing hooks", async ({
    makeAgent,
    makeAgentTool,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Delegating Agent",
    });
    const targetAgent = await makeAgent({
      organizationId: org.id,
      name: "Child Worker",
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(agent.id, delegationTool.id);
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([]),
    );

    const fireSpy = vi.spyOn(hookDispatcherService, "fire");
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "child-msg-1",
      text: "child says hi",
      finishReason: "stop",
    });

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
      delegationChain: agent.id,
    });

    const result = await tools[delegationTool.name].execute?.(
      { message: "do the work" },
      execOptions("call-4"),
    );

    expect(result).toBe("child says hi");
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(1);
    expect(mockExecuteA2AMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: targetAgent.id,
        message: "do the work",
        conversationId: conversation.id,
        parentDelegationChain: agent.id,
      }),
    );
    expect(fireSpy).not.toHaveBeenCalled();
    expect(metricsSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: delegationTool.name,
        isError: false,
      }),
    );

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });
});

describe("getChatMcpTools approval gating", () => {
  test("blockOnApprovalRequired removes needsApproval and blocks approval-required execution", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
    makeToolPolicy,
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Autonomous Agent",
    });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const restrictedTool = await makeTool({
      name: "extsrv__restricted_export",
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, restrictedTool.id);
    await makeToolPolicy(restrictedTool.id, {
      action: "require_approval",
      conditions: [],
    });
    const targetAgent = await makeAgent({
      organizationId: org.id,
      name: "Autonomy Child",
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(agent.id, delegationTool.id);

    const isolationKey = "headless-exec-1";
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, isolationKey),
      buildMockGatewayClient([externalTool("extsrv__restricted_export")]),
    );

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      isolationKey,
      blockOnApprovalRequired: true,
    });

    expect(tools.extsrv__restricted_export.needsApproval).toBeUndefined();
    expect(tools[delegationTool.name].needsApproval).toBeUndefined();

    await expect(
      tools.extsrv__restricted_export.execute?.(
        { query: "q" },
        execOptions("call-5"),
      ),
    ).rejects.toThrow(TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON);
    expect(mcpClient.executeToolCall).not.toHaveBeenCalled();

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("run_tool proposes a grant approval only for an accessible-but-unassigned target", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Grant Agent",
    });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const unassignedTool = await makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    const assignedTool = await makeTool({
      name: "workspace__list_projects",
      catalogId: catalog.id,
    });
    await makeAgentTool(agent.id, assignedTool.id);

    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([
        {
          name: getArchestraToolFullName("run_tool"),
          description: "Run tool",
          inputSchema: {
            type: "object",
            properties: {
              tool_name: { type: "string" },
              tool_args: { type: "object" },
            },
            required: ["tool_name"],
          },
        },
      ]),
    );

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    const needsApproval = callableNeedsApproval(
      tools[getArchestraToolFullName("run_tool")],
    );
    await expect(
      needsApproval(
        { tool_name: unassignedTool.name, tool_args: {} },
        execOptions(),
      ),
    ).resolves.toBe(true);
    await expect(
      needsApproval(
        { tool_name: assignedTool.name, tool_args: {} },
        execOptions(),
      ),
    ).resolves.toBe(false);

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("delegation needsApproval targets the delegation tool itself, not a tool_name in args", async ({
    makeAgent,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
    makeToolPolicy,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization({ globalToolPolicy: "restrictive" });
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Retarget Agent",
    });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const guardedTool = await makeTool({
      name: "extsrv__guarded_export",
      catalogId: catalog.id,
    });
    await makeToolPolicy(guardedTool.id, {
      action: "require_approval",
      conditions: [],
    });
    const targetAgent = await makeAgent({
      organizationId: org.id,
      name: "Retarget Child",
    });
    const delegationTool = await ToolModel.findOrCreateDelegationTool(
      targetAgent.id,
    );
    await makeAgentTool(agent.id, delegationTool.id);

    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      buildMockGatewayClient([]),
    );

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    const needsApproval = callableNeedsApproval(tools[delegationTool.name]);
    await expect(
      needsApproval(
        {
          message: "do the work",
          tool_name: guardedTool.name,
          tool_args: {},
        },
        execOptions(),
      ),
    ).resolves.toBe(false);

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });
});

describe("getChatMcpTools failure and cache gating", () => {
  test("returns no tools when the gateway listing fails", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Failing Gateway Agent",
    });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      {
        ping: vi.fn().mockResolvedValue({}),
        listTools: vi.fn().mockRejectedValue(new Error("gateway down")),
        callTool: vi.fn(),
        close: vi.fn(),
      } as unknown as Client,
    );

    const tools = await chatClient.getChatMcpTools({
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    });

    expect(tools).toEqual({});

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("abortSignal bypasses the tool cache; calls without it reuse the entry", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Cache Gate Agent",
    });
    const conversation = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    const gatewayClient = buildMockGatewayClient([
      externalTool("extsrv__fetch_data"),
    ]);
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
      gatewayClient,
    );

    const baseParams = {
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      conversationId: conversation.id,
    };

    const abortController = new AbortController();
    await chatClient.getChatMcpTools({
      ...baseParams,
      abortSignal: abortController.signal,
    });
    await chatClient.getChatMcpTools({
      ...baseParams,
      abortSignal: abortController.signal,
    });
    expect(gatewayClient.listTools).toHaveBeenCalledTimes(2);

    vi.mocked(gatewayClient.listTools).mockClear();
    const first = await chatClient.getChatMcpTools(baseParams);
    const second = await chatClient.getChatMcpTools(baseParams);
    expect(gatewayClient.listTools).toHaveBeenCalledTimes(1);
    expect(Object.keys(second)).toEqual(Object.keys(first));

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });

  test("tool cache entries are scoped per conversation", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeMember,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: org.id,
      name: "Scoped Cache Agent",
    });
    const conversationA = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const conversationB = await makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    const clientA = buildMockGatewayClient([externalTool("extsrv__a")]);
    const clientB = buildMockGatewayClient([externalTool("extsrv__b")]);
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversationA.id),
      clientA,
    );
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversationB.id),
      clientB,
    );

    const baseParams = {
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
    };

    const toolsA = await chatClient.getChatMcpTools({
      ...baseParams,
      conversationId: conversationA.id,
    });
    const toolsB = await chatClient.getChatMcpTools({
      ...baseParams,
      conversationId: conversationB.id,
    });

    expect(clientA.listTools).toHaveBeenCalledTimes(1);
    expect(clientB.listTools).toHaveBeenCalledTimes(1);
    expect(Object.keys(toolsA)).toEqual(["extsrv__a"]);
    expect(Object.keys(toolsB)).toEqual(["extsrv__b"]);

    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
  });
});
