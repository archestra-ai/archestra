// Characterization tests for getChatMcpTools composition: the per-kind AI SDK
// wrappers (MCP gateway tools vs agent delegation tools), their approval and
// hook pipelines, error handling, metric emission, and tool-cache gating.
// Mocks sit only at process boundaries: the MCP SDK client (gateway transport),
// mcpClient.executeToolCallForOwner (gateway network call), executeA2AMessage
// (child-agent execution), hookDispatcherService.fire (hook scripts run in
// Dagger sandbox containers), the browser-stream feature (browser pods), and
// the external-IdP session token resolver (IdP network call).
import {
  getArchestraToolFullName,
  TOOL_GET_AGENT_SHORT_NAME,
  TOOL_INVOCATION_APPROVAL_REQUIRED_AUTONOMOUS_REASON,
} from "@archestra/shared";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "ai";
import { afterEach, vi } from "vitest";
import { getArchestraToolInputSchema } from "@/archestra-mcp-server";
import { hookDispatcherService } from "@/hooks/hook-dispatcher-service";
import { ToolModel } from "@/models";
import { metrics } from "@/observability";
import { resolveSessionExternalIdpToken } from "@/services/identity-providers/session-token";
import { beforeEach, describe, expect, test } from "@/test";
import * as chatClient from "./chat-mcp-client";
import mcpClient from "./mcp-client";
import {
  MAX_IDENTICAL_TOOL_CALLS,
  REPEAT_CALL_TERMINATION_CEILING,
  ToolCallRepeatTracker,
} from "./tool-call-repeat-tracker";

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
    executeToolCallForOwner: vi.fn(),
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

const externalTool = (
  name: string,
  description = "",
  meta?: Record<string, unknown>,
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
  ...(meta ? { _meta: meta } : {}),
});

// A UI-providing launch tool as the gateway lists it: the `_meta.ui.resourceUri`
// it carries top-level (mcp-gateway.utils.ts sets `_meta` on every listed tool)
// is what marks it directly dispatchable while unassigned.
const uiLaunchTool = (name: string) =>
  externalTool(name, "", { ui: { resourceUri: `ui://app/${name}` } });

interface Fixtures {
  makeOrganization: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeMember: (
    userId: string,
    organizationId: string,
    overrides: { role: string },
  ) => Promise<unknown>;
  makeAgent: (
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string; name: string }>;
  makeConversation: (
    agentId: string,
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  makeAgentTool: (agentId: string, toolId: string) => Promise<unknown>;
  makeInternalMcpCatalog: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  makeTool: (
    overrides: Record<string, unknown>,
  ) => Promise<{ id: string; name: string }>;
  makeToolPolicy: (
    toolId: string,
    overrides: Record<string, unknown>,
  ) => Promise<unknown>;
  makeApp: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string; name: string }>;
  makeMcpServer: (
    overrides?: Record<string, unknown>,
  ) => Promise<{ id: string }>;
  seedAndAssignArchestraTools: (agentId: string) => Promise<void>;
}

// Test-context fixtures, captured once per test (vitest only hands fixtures to
// destructuring callbacks, so the file-level beforeEach collects them for the
// setup helper and the test bodies).
let f: Fixtures;
// The client and tool caches are module-level and outlive each test's
// truncated DB rows, so setup tracks agents for the afterEach cache reset.
let cleanupAgentIds: string[] = [];

beforeEach(
  ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeConversation,
    makeAgentTool,
    makeInternalMcpCatalog,
    makeTool,
    makeToolPolicy,
    makeApp,
    makeMcpServer,
    seedAndAssignArchestraTools,
  }) => {
    f = {
      makeOrganization,
      makeUser,
      makeMember,
      makeAgent,
      makeConversation,
      makeAgentTool,
      makeInternalMcpCatalog,
      makeTool,
      makeToolPolicy,
      makeApp,
      makeMcpServer,
      seedAndAssignArchestraTools,
    };
    vi.restoreAllMocks();
    vi.mocked(mcpClient.executeToolCallForOwner).mockReset();
    mockExecuteA2AMessage.mockReset();
    vi.mocked(resolveSessionExternalIdpToken).mockResolvedValue(null);
  },
);

afterEach(async () => {
  for (const agentId of cleanupAgentIds) {
    chatClient.clearChatMcpClient(agentId);
  }
  cleanupAgentIds = [];
  await chatClient.__test.clearToolCache();
});

/**
 * Creates the org/admin-user/agent backdrop every wrapper test needs, resets
 * the per-agent client and tool caches, and seeds the gateway client cache for
 * the test's scope (a conversation by default, an isolationKey when given).
 * Returns the matching base getChatMcpTools params.
 */
async function setupChatToolEnv(
  options: {
    gatewayTools?: Array<Record<string, unknown>>;
    gatewayClient?: Client;
    orgOverrides?: Record<string, unknown>;
    isolationKey?: string;
  } = {},
) {
  const org = await f.makeOrganization(options.orgOverrides);
  const user = await f.makeUser();
  await f.makeMember(user.id, org.id, { role: "admin" });
  const agent = await f.makeAgent({
    organizationId: org.id,
    name: "Test Agent",
  });

  let conversation: { id: string } | undefined;
  let scopeKey: string;
  if (options.isolationKey) {
    scopeKey = options.isolationKey;
  } else {
    conversation = await f.makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    scopeKey = conversation.id;
  }

  chatClient.clearChatMcpClient(agent.id);
  await chatClient.__test.clearToolCache();
  cleanupAgentIds.push(agent.id);

  const gatewayClient =
    options.gatewayClient ?? buildMockGatewayClient(options.gatewayTools ?? []);
  chatClient.__test.setCachedClient(
    chatClient.__test.getCacheKey(agent.id, user.id, scopeKey),
    gatewayClient,
  );

  return {
    org,
    user,
    agent,
    conversation,
    gatewayClient,
    baseParams: {
      agentName: agent.name,
      agentId: agent.id,
      userId: user.id,
      organizationId: org.id,
      ...(options.isolationKey
        ? { isolationKey: options.isolationKey }
        : { conversationId: scopeKey }),
    },
  };
}

/** A delegation tool for a fresh child agent, assigned to `agentId`. */
async function makeAssignedDelegationTool(params: {
  agentId: string;
  organizationId: string;
  childName: string;
  childDescription?: string;
}) {
  const targetAgent = await f.makeAgent({
    organizationId: params.organizationId,
    name: params.childName,
    ...(params.childDescription && { description: params.childDescription }),
  });
  const delegationTool = await ToolModel.findOrCreateDelegationTool(
    targetAgent.id,
  );
  await f.makeAgentTool(params.agentId, delegationTool.id);
  return { targetAgent, delegationTool };
}

describe("getChatMcpTools per-kind tool shape", () => {
  test("pins schema normalization, description fallback, and toModelOutput per kind", async () => {
    const { agent, org, baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });
    const { delegationTool } = await makeAssignedDelegationTool({
      agentId: agent.id,
      organizationId: org.id,
      childName: "Research Helper",
      childDescription: "Researches things",
    });

    const tools = await chatClient.getChatMcpTools(baseParams);

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
  });
});

describe("getChatMcpTools MCP tool execute pipeline", () => {
  test("executes an external tool through pre-hook, gateway call, post-hook in order", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

    const callOrder: string[] = [];
    const fireSpy = vi
      .spyOn(hookDispatcherService, "fire")
      .mockImplementation(async ({ event }) => {
        callOrder.push(event);
        return { decision: "proceed", runs: [] };
      });
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");
    vi.mocked(mcpClient.executeToolCallForOwner).mockImplementation(
      async () => {
        callOrder.push("gateway");
        return {
          content: [{ type: "text", text: "external result" }],
          isError: false,
        } as never;
      },
    );

    const tools = await chatClient.getChatMcpTools(baseParams);
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
  });

  test("does not count a mid-call abort as a tool error metric", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");

    const controller = new AbortController();
    // The gateway call is cancelled mid-flight when the run is stopped: the
    // signal aborts and the upstream request rejects (mcp-client rethrows it).
    vi.mocked(mcpClient.executeToolCallForOwner).mockImplementation(
      async () => {
        controller.abort();
        throw new Error("MCP error -32001: The operation was aborted");
      },
    );

    const tools = await chatClient.getChatMcpTools({
      ...baseParams,
      abortSignal: controller.signal,
    });

    await expect(
      tools.extsrv__fetch_data.execute?.(
        { query: "q" },
        execOptions("call-abort"),
      ),
    ).rejects.toThrow();

    const errorMetricCalls = metricsSpy.mock.calls.filter(
      ([arg]) => (arg as { isError?: boolean }).isError === true,
    );
    expect(errorMetricCalls).toEqual([]);
  });

  test("a run already stopped before the tool fires skips the gateway call and reports no metric", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });
    const fireSpy = vi.spyOn(hookDispatcherService, "fire");
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");

    const controller = new AbortController();
    controller.abort();

    const tools = await chatClient.getChatMcpTools({
      ...baseParams,
      abortSignal: controller.signal,
    });

    await expect(
      tools.extsrv__fetch_data.execute?.(
        { query: "q" },
        execOptions("call-pre-abort"),
      ),
    ).rejects.toThrow();

    // The pre-call abort check fires before the PreToolUse hook and the gateway
    // call, and an already-stopped run is not a tool failure.
    expect(fireSpy).not.toHaveBeenCalled();
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    expect(metricsSpy).not.toHaveBeenCalled();
  });

  test("a non-abort gateway tool-error result still reports an error metric", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "upstream failed" }],
      isError: true,
    } as never);

    const tools = await chatClient.getChatMcpTools(baseParams);
    const result = await tools.extsrv__fetch_data.execute?.(
      { query: "q" },
      execOptions("call-err"),
    );

    // A real (non-cancellation) failure must still count as a tool error — the
    // abort suppression is specific to stopped runs.
    expect(toolResultContent(result)).toContain("upstream failed");
    expect(metricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true }),
    );
  });

  test("a PreToolUse block short-circuits the gateway call and reports an error metric", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

    const fireSpy = vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "block",
      reason: "policy says no",
      runs: [],
    });
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");

    const tools = await chatClient.getChatMcpTools(baseParams);
    const result = await tools.extsrv__fetch_data.execute?.(
      { query: "q" },
      execOptions("call-2"),
    );

    expect(toolResultContent(result)).toContain(
      "Tool call blocked by a PreToolUse hook",
    );
    expect(toolResultContent(result)).toContain("policy says no");
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
    expect(fireSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledTimes(1);
    expect(metricsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ isError: true }),
    );
  });

  test("appends PostToolUse feedback to the tool result", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

    vi.spyOn(hookDispatcherService, "fire").mockImplementation(
      async ({ event }) =>
        event === "post_tool_use"
          ? { decision: "block", reason: "be careful", runs: [] }
          : { decision: "proceed", runs: [] },
    );
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "external result" }],
      isError: false,
    } as never);

    const tools = await chatClient.getChatMcpTools(baseParams);
    const result = await tools.extsrv__fetch_data.execute?.(
      { query: "q" },
      execOptions("call-3"),
    );

    expect(toolResultContent(result)).toContain("external result");
    expect(toolResultContent(result)).toContain("[hook feedback] be careful");
  });
});

describe("getChatMcpTools dynamic UI tool dispatch (all-tools agents)", () => {
  async function setupAllToolsAgent() {
    const org = await f.makeOrganization();
    const user = await f.makeUser();
    await f.makeMember(user.id, org.id, { role: "admin" });
    const agent = await f.makeAgent({
      organizationId: org.id,
      name: "All Tools Agent",
      accessAllTools: true,
    });
    const conversation = await f.makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    chatClient.clearChatMcpClient(agent.id);
    await chatClient.__test.clearToolCache();
    cleanupAgentIds.push(agent.id);
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as never);
    const wireGateway = (gatewayTools: Array<Record<string, unknown>>) =>
      chatClient.__test.setCachedClient(
        chatClient.__test.getCacheKey(agent.id, user.id, conversation.id),
        buildMockGatewayClient(gatewayTools),
      );
    return {
      org,
      user,
      agent,
      wireGateway,
      baseParams: {
        agentName: agent.name,
        agentId: agent.id,
        userId: user.id,
        organizationId: org.id,
        conversationId: conversation.id,
      },
    };
  }

  const lastAvailableTool = () => {
    const calls = vi.mocked(mcpClient.executeToolCallForOwner).mock.calls;
    const options = calls.at(-1)?.[3] as
      | { availableTool?: { name: string } }
      | undefined;
    return options?.availableTool;
  };

  test("passes a resolved availableTool for a direct call to an unassigned owned-app launch tool", async () => {
    const { org, user, wireGateway, baseParams } = await setupAllToolsAgent();
    // The owned app's __open launch tool is advertised top-level (a UI host
    // renders from the definition) but has no agent_tools row for this agent.
    await f.makeApp({ organizationId: org.id, authorId: user.id });
    const [launchTool] = await ToolModel.getMcpToolsAccessibleToUser({
      userId: user.id,
      organizationId: org.id,
      isAdmin: true,
      environmentId: null,
      requireUiResource: true,
    });
    expect(launchTool?.name).toBeDefined();

    wireGateway([uiLaunchTool(launchTool.name)]);
    const tools = await chatClient.getChatMcpTools(baseParams);
    await tools[launchTool.name].execute?.({}, execOptions("call-open"));

    // Without the pre-resolution the dispatch layer rejects the unassigned tool
    // as unknown_tool; with it the launch tool is handed through as availableTool.
    expect(lastAvailableTool()?.name).toBe(launchTool.name);
  });

  test("does not pass availableTool for a direct call to an unassigned NON-UI tool", async () => {
    // Security guard: only UI-providing tools are advertised top-level, so only
    // they become directly callable. A plain accessible-but-unassigned tool must
    // stay behind search_tools/run_tool — resolving it here would make every
    // hidden tool name directly executable.
    const { org, user, wireGateway, baseParams } = await setupAllToolsAgent();
    const catalog = await f.makeInternalMcpCatalog({ organizationId: org.id });
    await f.makeMcpServer({
      catalogId: catalog.id,
      scope: "org",
      ownerId: user.id,
    });
    await f.makeTool({
      catalogId: catalog.id,
      name: "plainsrv__do_thing",
      parameters: { type: "object", properties: {} },
    });

    wireGateway([externalTool("plainsrv__do_thing")]);
    const tools = await chatClient.getChatMcpTools(baseParams);
    await tools.plainsrv__do_thing.execute?.({}, execOptions("call-plain"));

    expect(lastAvailableTool()).toBeUndefined();
  });
});

describe("getChatMcpTools agent delegation execute pipeline", () => {
  test("executes a delegation tool via the child-agent boundary without firing hooks", async () => {
    const { agent, org, baseParams, conversation } = await setupChatToolEnv();
    const { targetAgent, delegationTool } = await makeAssignedDelegationTool({
      agentId: agent.id,
      organizationId: org.id,
      childName: "Child Worker",
    });

    const fireSpy = vi.spyOn(hookDispatcherService, "fire");
    const metricsSpy = vi.spyOn(metrics.mcp, "reportMcpToolCall");
    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "child-msg-1",
      text: "child says hi",
      finishReason: "stop",
    });

    const tools = await chatClient.getChatMcpTools({
      ...baseParams,
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
        conversationId: conversation?.id,
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
  });
});

describe("getChatMcpTools approval gating", () => {
  test("blockOnApprovalRequired removes needsApproval and blocks approval-required execution", async () => {
    const { agent, org, baseParams } = await setupChatToolEnv({
      isolationKey: "headless-exec-1",
      gatewayTools: [externalTool("extsrv__restricted_export")],
    });
    const catalog = await f.makeInternalMcpCatalog({ organizationId: org.id });
    const restrictedTool = await f.makeTool({
      name: "extsrv__restricted_export",
      catalogId: catalog.id,
    });
    await f.makeAgentTool(agent.id, restrictedTool.id);
    await f.makeToolPolicy(restrictedTool.id, {
      action: "require_approval",
      conditions: [],
    });
    const { delegationTool } = await makeAssignedDelegationTool({
      agentId: agent.id,
      organizationId: org.id,
      childName: "Autonomy Child",
    });

    const tools = await chatClient.getChatMcpTools({
      ...baseParams,
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
    expect(mcpClient.executeToolCallForOwner).not.toHaveBeenCalled();
  });

  test("run_tool needsApproval reflects only invocation policy, never proposes a grant", async () => {
    const { agent, org, baseParams } = await setupChatToolEnv({
      gatewayTools: [
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
      ],
    });
    const catalog = await f.makeInternalMcpCatalog({ organizationId: org.id });
    const unassignedTool = await f.makeTool({
      name: "github__search_repositories",
      catalogId: catalog.id,
    });
    const assignedTool = await f.makeTool({
      name: "workspace__list_projects",
      catalogId: catalog.id,
    });
    await f.makeAgentTool(agent.id, assignedTool.id);

    const tools = await chatClient.getChatMcpTools(baseParams);

    const needsApproval = callableNeedsApproval(
      tools[getArchestraToolFullName("run_tool")],
    );
    // Dynamic tool access replaced the grant-on-first-use flow: an
    // accessible-but-unassigned target no longer triggers an approval
    // proposal — needsApproval is driven solely by the invocation policy,
    // which neither tool here requires.
    await expect(
      needsApproval(
        { tool_name: unassignedTool.name, tool_args: {} },
        execOptions(),
      ),
    ).resolves.toBe(false);
    await expect(
      needsApproval(
        { tool_name: assignedTool.name, tool_args: {} },
        execOptions(),
      ),
    ).resolves.toBe(false);
  });

  test("delegation needsApproval targets the delegation tool itself, not a tool_name in args", async () => {
    const { agent, org, baseParams } = await setupChatToolEnv();
    const catalog = await f.makeInternalMcpCatalog({ organizationId: org.id });
    const guardedTool = await f.makeTool({
      name: "extsrv__guarded_export",
      catalogId: catalog.id,
    });
    await f.makeToolPolicy(guardedTool.id, {
      action: "require_approval",
      conditions: [],
    });
    const { delegationTool } = await makeAssignedDelegationTool({
      agentId: agent.id,
      organizationId: org.id,
      childName: "Retarget Child",
    });

    const tools = await chatClient.getChatMcpTools(baseParams);

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
  });
});

describe("getChatMcpTools repeated-call circuit breaker", () => {
  test("nudges instead of executing once an identical call repeats past the threshold", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "external result" }],
      isError: false,
    } as never);

    const tools = await chatClient.getChatMcpTools(baseParams);

    for (let i = 0; i < MAX_IDENTICAL_TOOL_CALLS; i++) {
      const result = await tools.extsrv__fetch_data.execute?.(
        { query: "stuck" },
        execOptions(`call-${i}`),
      );
      expect(toolResultContent(result)).toContain("external result");
    }
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledTimes(
      MAX_IDENTICAL_TOOL_CALLS,
    );

    const nudged = await tools.extsrv__fetch_data.execute?.(
      { query: "stuck" },
      execOptions("call-over"),
    );
    expect(toolResultContent(nudged)).toContain("identical arguments");
    // The nudge reports the consecutive count.
    expect(toolResultContent(nudged)).toContain(
      String(MAX_IDENTICAL_TOOL_CALLS + 1),
    );
    // The over-threshold call is not forwarded to the gateway.
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledTimes(
      MAX_IDENTICAL_TOOL_CALLS,
    );
  });

  test("an empty-args call repeating a validation error is fast-nudged on the third issue", async () => {
    // An Archestra tool's validation error is args-deterministic, so the
    // breaker nudges a step sooner than the generic threshold: the first two
    // {} calls execute (each returning the actionable Zod error naming the
    // missing fields), the third identical call is nudged without executing.
    const toolName = getArchestraToolFullName(TOOL_GET_AGENT_SHORT_NAME);
    const { agent, baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool(toolName)],
    });
    await f.seedAndAssignArchestraTools(agent.id);

    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });

    const tools = await chatClient.getChatMcpTools(baseParams);

    const first = await tools[toolName].execute?.({}, execOptions("empty-1"));
    expect(toolResultContent(first)).toContain("Validation error");
    const second = await tools[toolName].execute?.({}, execOptions("empty-2"));
    expect(toolResultContent(second)).toContain("Validation error");

    const third = await tools[toolName].execute?.({}, execOptions("empty-3"));
    expect(toolResultContent(third)).toContain("identical arguments");
    expect(toolResultContent(third)).not.toContain("Validation error");
  });

  test("a different call resets the streak so a repeated call executes again", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__a"), externalTool("extsrv__b")],
    });

    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as never);

    const tools = await chatClient.getChatMcpTools(baseParams);

    for (let i = 0; i < MAX_IDENTICAL_TOOL_CALLS; i++) {
      await tools.extsrv__a.execute?.({ query: "x" }, execOptions(`a-${i}`));
    }
    // A different tool resets the consecutive counter.
    await tools.extsrv__b.execute?.({ query: "y" }, execOptions("b-1"));

    const afterReset = await tools.extsrv__a.execute?.(
      { query: "x" },
      execOptions("a-after"),
    );
    expect(toolResultContent(afterReset)).toContain("ok");
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledTimes(
      MAX_IDENTICAL_TOOL_CALLS + 2,
    );
  });

  test("a cached tool set (no abortSignal) resets the tracker per run, so counts do not leak", async () => {
    const { baseParams, gatewayClient } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    } as never);

    // No abortSignal: this is the A2A/scheduled/email path that reuses the
    // 30s tool cache. The second run on the same scope hits the cache (the
    // gateway is listed once) but must still get a fresh tracker.
    const runOne = await chatClient.getChatMcpTools(baseParams);
    for (let i = 0; i <= MAX_IDENTICAL_TOOL_CALLS; i++) {
      await runOne.extsrv__fetch_data.execute?.(
        { query: "stuck" },
        execOptions(`one-${i}`),
      );
    }

    vi.mocked(mcpClient.executeToolCallForOwner).mockClear();
    const runTwo = await chatClient.getChatMcpTools(baseParams);
    const fresh = await runTwo.extsrv__fetch_data.execute?.(
      { query: "stuck" },
      execOptions("two-0"),
    );

    expect(gatewayClient.listTools).toHaveBeenCalledTimes(1);
    // A fresh run executes the same call rather than carrying over the nudge.
    expect(toolResultContent(fresh)).toContain("ok");
    expect(mcpClient.executeToolCallForOwner).toHaveBeenCalledTimes(1);
  });

  test("at the termination ceiling the breaker emits a terminal message and the caller's tracker reports termination", async () => {
    const { baseParams } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    vi.mocked(mcpClient.executeToolCallForOwner).mockResolvedValue({
      content: [{ type: "text", text: "external result" }],
      isError: false,
    } as never);

    // The run owns the tracker so the breaker records into the same instance the
    // run's stop condition reads.
    const repeatTracker = new ToolCallRepeatTracker();
    const tools = await chatClient.getChatMcpTools({
      ...baseParams,
      repeatTracker,
    });

    for (let i = 1; i < REPEAT_CALL_TERMINATION_CEILING; i++) {
      await tools.extsrv__fetch_data.execute?.(
        { query: "stuck" },
        execOptions(`call-${i}`),
      );
      expect(repeatTracker.hasReachedTerminationCeiling()).toBe(false);
    }

    const terminal = await tools.extsrv__fetch_data.execute?.(
      { query: "stuck" },
      execOptions("call-ceiling"),
    );
    expect(toolResultContent(terminal)).toContain("run is being stopped");
    expect(repeatTracker.hasReachedTerminationCeiling()).toBe(true);
  });

  test("breaks repeated identical delegation calls without spawning more child agents", async () => {
    const { agent, org, baseParams } = await setupChatToolEnv();
    const { delegationTool } = await makeAssignedDelegationTool({
      agentId: agent.id,
      organizationId: org.id,
      childName: "Loop Child",
    });

    mockExecuteA2AMessage.mockResolvedValue({
      messageId: "child-1",
      text: "child result",
      finishReason: "stop",
    });

    const tools = await chatClient.getChatMcpTools({
      ...baseParams,
      delegationChain: agent.id,
    });

    for (let i = 0; i < MAX_IDENTICAL_TOOL_CALLS; i++) {
      await tools[delegationTool.name].execute?.(
        { message: "do it" },
        execOptions(`d-${i}`),
      );
    }
    const nudged = await tools[delegationTool.name].execute?.(
      { message: "do it" },
      execOptions("d-over"),
    );

    expect(toolResultContent(nudged)).toContain("identical arguments");
    // The over-threshold call does not spawn another child-agent run.
    expect(mockExecuteA2AMessage).toHaveBeenCalledTimes(
      MAX_IDENTICAL_TOOL_CALLS,
    );
  });
});

describe("getChatMcpTools validation-error parameter skeleton", () => {
  const runToolName = getArchestraToolFullName("run_tool");
  const editAppName = getArchestraToolFullName("edit_app");
  const runToolGatewayDef = {
    name: runToolName,
    description: "Run tool",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        tool_args: { type: "object" },
      },
      required: ["tool_name"],
    },
  };

  /** edit_app args that fail validation (non-numeric baseVersion). */
  const invalidEditArgs = () => ({
    appId: crypto.randomUUID(),
    baseVersion: "one",
    edits: [{ old_str: "x", new_str: "y" }],
  });

  /**
   * The skeleton is schema-derived, so the behavioral pin is that the error
   * result surfaces every top-level parameter key of the TARGET tool's
   * published schema — not any particular wording around them.
   */
  const expectEditAppSkeleton = (result: unknown) => {
    const text = toolResultContent(result);
    const editAppSchema = getArchestraToolInputSchema(editAppName);
    expect(editAppSchema).toBeDefined();
    for (const key of Object.keys(
      editAppSchema?.properties as Record<string, unknown>,
    )) {
      expect(text).toContain(`"${key}"`);
    }
  };

  async function setupSkeletonEnv(
    gatewayTools: Array<Record<string, unknown>>,
  ) {
    const { agent, baseParams } = await setupChatToolEnv({ gatewayTools });
    await f.seedAndAssignArchestraTools(agent.id);
    vi.spyOn(hookDispatcherService, "fire").mockResolvedValue({
      decision: "proceed",
      runs: [],
    });
    return chatClient.getChatMcpTools(baseParams);
  }

  test("a run_tool-wrapped edit_app failure carries the TARGET's parameter skeleton on the first failure", async () => {
    const tools = await setupSkeletonEnv([runToolGatewayDef]);
    const result = await tools[runToolName].execute?.(
      { tool_name: "edit_app", tool_args: invalidEditArgs() },
      execOptions("wrapped-1"),
    );
    expectEditAppSkeleton(result);
  });

  test("a directly-called archestra tool failure carries its own skeleton on the first failure", async () => {
    const tools = await setupSkeletonEnv([
      {
        name: editAppName,
        description: "Edit app",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const result = await tools[editAppName].execute?.(
      invalidEditArgs(),
      execOptions("direct-1"),
    );
    expectEditAppSkeleton(result);
  });
});

describe("getChatMcpTools failure and cache gating", () => {
  test("throws and evicts the failing client when the gateway listing fails", async () => {
    const failingClient = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockRejectedValue(new Error("gateway down")),
      callTool: vi.fn(),
      close: vi.fn(),
    };
    const { baseParams } = await setupChatToolEnv({
      gatewayClient: failingClient as unknown as Client,
    });

    // A failed listing must surface as an error, not an empty tool set that
    // would let the model stream against a tool-demanding system prompt.
    await expect(chatClient.getChatMcpTools(baseParams)).rejects.toBeInstanceOf(
      chatClient.McpToolsUnavailableError,
    );

    // The failing session is evicted (closed) so the next turn rebuilds it
    // rather than reusing a sticky failure until the idle TTL.
    expect(failingClient.close).toHaveBeenCalledTimes(1);
  });

  test("abortSignal bypasses the tool cache; calls without it reuse the entry", async () => {
    const { baseParams, gatewayClient } = await setupChatToolEnv({
      gatewayTools: [externalTool("extsrv__fetch_data")],
    });

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
  });

  test("tool cache entries are scoped per conversation", async () => {
    const { agent, user, org, baseParams, gatewayClient } =
      await setupChatToolEnv({
        gatewayTools: [externalTool("extsrv__a")],
      });
    const conversationB = await f.makeConversation(agent.id, {
      organizationId: org.id,
      userId: user.id,
    });
    const clientB = buildMockGatewayClient([externalTool("extsrv__b")]);
    chatClient.__test.setCachedClient(
      chatClient.__test.getCacheKey(agent.id, user.id, conversationB.id),
      clientB,
    );

    const toolsA = await chatClient.getChatMcpTools(baseParams);
    const toolsB = await chatClient.getChatMcpTools({
      ...baseParams,
      conversationId: conversationB.id,
    });

    expect(gatewayClient.listTools).toHaveBeenCalledTimes(1);
    expect(clientB.listTools).toHaveBeenCalledTimes(1);
    expect(Object.keys(toolsA)).toEqual(["extsrv__a"]);
    expect(Object.keys(toolsB)).toEqual(["extsrv__b"]);
  });
});
