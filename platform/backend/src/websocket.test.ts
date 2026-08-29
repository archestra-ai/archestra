import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type {
  ClientWebSocketMessage,
  McpDeploymentStatusEntry,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import client from "prom-client";
// SPDX-SnippetEnd
import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import { betterAuth } from "@/auth";
import db, { schema } from "@/database";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import { A2AContextModel, A2ATaskModel, AgentRunModel } from "@/models";
import AgentModel from "@/models/agent";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import websocketService from "@/websocket";

interface WebSocketClientContext {
  userId: string;
  organizationId: string;
  userIsMcpServerAdmin: boolean;
}

interface McpLogsSubscription {
  serverId: string;
  stream: PassThrough;
  abortController: AbortController;
}

interface McpExecSubscription {
  serverId: string;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  k8sWs: {
    readyState: number;
    close: () => void;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    send: (data: Buffer | string) => void;
  };
}

interface AgentRunAttachSubscription {
  runId: string;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  inputPaused: boolean;
  socket: {
    readyState: number;
    close: () => void;
    send: (data: Buffer) => void;
  };
}

interface AgentRunLogsSubscription {
  runId: string;
  stream: PassThrough;
  abortController: AbortController;
}

interface McpDeploymentStatusSubscription {
  buildStatuses: (
    summary: typeof McpServerRuntimeManager.statusSummary,
  ) => Record<string, McpDeploymentStatusEntry>;
  lastStatusesJson: string;
}

const service = websocketService as unknown as {
  authenticateConnection: (
    request: IncomingMessage,
  ) => Promise<WebSocketClientContext | null>;
  handleMessage: (message: ClientWebSocketMessage, ws: WS) => Promise<void>;
  clientContexts: Map<WS, WebSocketClientContext>;
  browserSubscriptions: {
    clear: () => void;
    has: (ws: WS) => boolean;
    get: (ws: WS) => { intervalId: NodeJS.Timeout } | undefined;
  };
  mcpLogsSubscriptions: Map<WS, McpLogsSubscription>;
  mcpExecSubscriptions: Map<WS, McpExecSubscription>;
  agentRunAttachSubscriptions: Map<WS, AgentRunAttachSubscription>;
  agentRunLogsSubscriptions: Map<WS, AgentRunLogsSubscription>;
  cleanupAgentRunSubscriptions: (ws: WS) => void;
  mcpDeploymentStatusSubscriptions: Map<WS, McpDeploymentStatusSubscription>;
  mcpDeploymentStatusPollInterval: NodeJS.Timeout | null;
  lastMcpDeploymentRefreshAt: number;
  unsubscribeMcpDeploymentStatuses: (ws: WS) => void;
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  startDeploymentMetricsPolling: () => void;
  deploymentMetricsInterval: NodeJS.Timeout | null;
  deploymentMetricsRefreshUnsubscribe: (() => void) | null;
  // SPDX-SnippetEnd
  initBrowserStreamContextForTesting: () => void;
  wss: { clients: Set<WS> } | null;
};

// Initialize browser stream context once for all tests
service.initBrowserStreamContextForTesting();

describe("websocket authentication", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
    service.mcpLogsSubscriptions.clear();
    service.mcpExecSubscriptions.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
  });

  test("authenticateConnection rejects unauthenticated requests", async () => {
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue(null);
    vi.spyOn(betterAuth.api, "verifyApiKey").mockResolvedValue({
      valid: false,
      error: null,
      key: null,
    });

    const request = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as IncomingMessage;

    const result = await service.authenticateConnection(request);

    expect(result).toBeNull();
  });
});

describe("websocket MCP server lifecycle", () => {
  test("scopes uninstall events to clients in the affected organization", () => {
    const matchingSend = vi.fn();
    const foreignSend = vi.fn();
    const matchingClient = {
      readyState: WS.OPEN,
      send: matchingSend,
    } as unknown as WS;
    const foreignClient = {
      readyState: WS.OPEN,
      send: foreignSend,
    } as unknown as WS;
    const previousWss = service.wss;
    service.wss = { clients: new Set([matchingClient, foreignClient]) };
    service.clientContexts.set(matchingClient, {
      userId: "user-1",
      organizationId: "org-1",
      userIsMcpServerAdmin: false,
    });
    service.clientContexts.set(foreignClient, {
      userId: "user-2",
      organizationId: "org-2",
      userIsMcpServerAdmin: false,
    });

    try {
      websocketService.broadcastMcpServersChanged({
        organizationId: "org-1",
        serverIds: ["server-1"],
        catalogIds: ["catalog-1"],
      });

      expect(matchingSend).toHaveBeenCalledWith(
        JSON.stringify({
          type: "mcp_servers_changed",
          payload: {
            change: "uninstalled",
            serverIds: ["server-1"],
            catalogIds: ["catalog-1"],
          },
        }),
      );
      expect(foreignSend).not.toHaveBeenCalled();

      matchingSend.mockClear();
      foreignSend.mockClear();
      websocketService.broadcastMcpServersChanged({
        organizationId: null,
        catalogIds: ["global-catalog"],
      });
      const globalMessage = JSON.stringify({
        type: "mcp_servers_changed",
        payload: {
          change: "uninstalled",
          serverIds: [],
          catalogIds: ["global-catalog"],
        },
      });
      expect(matchingSend).toHaveBeenCalledWith(globalMessage);
      expect(foreignSend).toHaveBeenCalledWith(globalMessage);
    } finally {
      service.wss = previousWss;
      service.clientContexts.delete(matchingClient);
      service.clientContexts.delete(foreignClient);
    }
  });
});

describe("websocket browser-stream authorization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
    service.mcpLogsSubscriptions.clear();
    service.mcpExecSubscriptions.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
  });

  test("rejects browser stream subscription for conversations the user does not own", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      userId: owner.id,
      organizationId: org.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: otherUser.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });

    const selectSpy = vi
      .spyOn(browserStreamFeature, "selectOrCreateTab")
      .mockResolvedValue({ success: true, tabIndex: 0 });
    const screenshotSpy = vi
      .spyOn(browserStreamFeature, "takeScreenshot")
      .mockResolvedValue({ screenshot: "img", url: "http://example.com" });

    await service.handleMessage(
      {
        type: "subscribe_browser_stream",
        payload: { conversationId: conversation.id },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "browser_stream_error",
        payload: {
          conversationId: conversation.id,
          error: "Conversation not found",
        },
      }),
    );
    expect(service.browserSubscriptions.has(ws)).toBe(false);
    expect(selectSpy).not.toHaveBeenCalled();
    expect(screenshotSpy).not.toHaveBeenCalled();
  });
});

describe("websocket Agent run authorization and cleanup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.agentRunAttachSubscriptions.clear();
    service.agentRunLogsSubscriptions.clear();
  });

  test("rejects a log subscription from a user who does not control the run", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const viewer = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(viewer.id, organization.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "org",
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_SUBMITTED",
    });
    await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      deploymentName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: viewer.id,
      organizationId: organization.id,
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_agent_run_logs",
        payload: { runId: task.id, lines: 100 },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "agent_run_logs_error",
        payload: {
          runId: task.id,
          error: "Only the person who started this run can view its logs",
        },
      }),
    );
    expect(service.agentRunLogsSubscriptions.has(ws)).toBe(false);
  });

  test("returns retained logs after an Agent execution pod is removed", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "org",
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    const run = await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      deploymentName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await AgentRunModel.close({
      id: run.id,
      logs: "checked repository\nopened pull request\n",
    });
    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: owner.id,
      organizationId: organization.id,
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_agent_run_logs",
        payload: { runId: task.id, lines: 100 },
      },
      ws,
    );

    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "agent_run_logs",
        payload: {
          runId: task.id,
          logs: "checked repository\nopened pull request\n",
        },
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: "agent_run_logs_ended",
        payload: { runId: task.id },
      }),
    );
    expect(service.agentRunLogsSubscriptions.has(ws)).toBe(false);
  });

  test("does not let an Agent administrator attach to another user's run", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const administrator = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(administrator.id, organization.id, { role: "admin" });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
      scope: "org",
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const task = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_SUBMITTED",
    });
    await AgentRunModel.create({
      organizationId: organization.id,
      taskId: task.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      deploymentName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: administrator.id,
      organizationId: organization.id,
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_agent_run_attach",
        payload: { runId: task.id },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "agent_run_attach_error",
        payload: {
          runId: task.id,
          error: "Only the person who started this run can attach to it",
        },
      }),
    );
    expect(service.agentRunAttachSubscriptions.has(ws)).toBe(false);
  });

  test("destroys Agent run streams and detaches the exec socket on disconnect", () => {
    const ws = {} as WS;
    const attach = {
      runId: crypto.randomUUID(),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      inputPaused: false,
      socket: { readyState: WS.OPEN, close: vi.fn(), send: vi.fn() },
    };
    const logs = {
      runId: attach.runId,
      stream: new PassThrough(),
      abortController: new AbortController(),
    };
    service.agentRunAttachSubscriptions.set(ws, attach);
    service.agentRunLogsSubscriptions.set(ws, logs);

    service.cleanupAgentRunSubscriptions(ws);

    expect(attach.stdin.destroyed).toBe(true);
    expect(attach.stdout.destroyed).toBe(true);
    expect(attach.stderr.destroyed).toBe(true);
    expect(attach.socket.close).toHaveBeenCalledOnce();
    expect(logs.abortController.signal.aborted).toBe(true);
    expect(logs.stream.destroyed).toBe(true);
    expect(service.agentRunAttachSubscriptions.has(ws)).toBe(false);
    expect(service.agentRunLogsSubscriptions.has(ws)).toBe(false);
  });

  test("pauses Agent terminal input when stdin applies backpressure", async () => {
    const stdin = new PassThrough();
    vi.spyOn(stdin, "write").mockReturnValue(false);
    const pause = vi.fn();
    const resume = vi.fn();
    const runId = crypto.randomUUID();
    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      _socket: { pause, resume },
    } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: "user-1",
      organizationId: "org-1",
      userIsMcpServerAdmin: false,
    });
    const subscription: AgentRunAttachSubscription = {
      runId,
      stdin,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      inputPaused: false,
      socket: { readyState: WS.OPEN, close: vi.fn(), send: vi.fn() },
    };
    service.agentRunAttachSubscriptions.set(ws, subscription);

    await service.handleMessage(
      {
        type: "agent_run_attach_input",
        payload: { runId, data: "large terminal input" },
      },
      ws,
    );

    expect(pause).toHaveBeenCalledOnce();
    expect(subscription.inputPaused).toBe(true);

    stdin.emit("drain");
    expect(resume).toHaveBeenCalledOnce();
    expect(subscription.inputPaused).toBe(false);
  });
});

describe("websocket browser-stream screenshot handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
    service.mcpLogsSubscriptions.clear();
    service.mcpExecSubscriptions.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
    // Mock Playwright tools as assigned so browser stream tests can proceed
    vi.spyOn(AgentModel, "hasPlaywrightToolsAssigned").mockResolvedValue(true);
  });

  test("sends an error when screenshot data is missing", async ({
    makeAgent,
    makeConversation,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent();
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });

    vi.spyOn(browserStreamFeature, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });
    vi.spyOn(browserStreamFeature, "takeScreenshot").mockResolvedValue({});

    await service.handleMessage(
      {
        type: "subscribe_browser_stream",
        payload: { conversationId: conversation.id },
      },
      ws,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "browser_stream_error",
        payload: {
          conversationId: conversation.id,
          error: "No screenshot returned from browser tool",
        },
      }),
    );

    const subscription = service.browserSubscriptions.get(ws);
    if (subscription) {
      clearInterval(subscription.intervalId);
    }
  });
});

describe("websocket MCP logs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
    service.mcpLogsSubscriptions.clear();
    service.mcpExecSubscriptions.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
  });

  afterEach(() => {
    for (const subscription of service.mcpLogsSubscriptions.values()) {
      subscription.abortController.abort();
      subscription.stream.destroy();
    }
    service.mcpLogsSubscriptions.clear();
  });

  test("rejects logs subscription for MCP server the user does not have access to", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: team.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    // otherUser is not in the team, so they shouldn't have access
    service.clientContexts.set(ws, {
      userId: otherUser.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_logs",
        payload: { serverId: mcpServer.id, lines: 100 },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "mcp_logs_error",
        payload: {
          serverId: mcpServer.id,
          error: "MCP server not found",
        },
      }),
    );
    expect(service.mcpLogsSubscriptions.has(ws)).toBe(false);
  });

  test("allows MCP server admin to access any MCP server logs", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const adminUser = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: team.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    // adminUser is not in the team, but has MCP server admin permission
    service.clientContexts.set(ws, {
      userId: adminUser.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    // Mock the runtime manager methods
    vi.spyOn(
      McpServerRuntimeManager,
      "getAppropriateCommand",
    ).mockResolvedValue(
      "kubectl logs -n test -l mcp-server-id=test --tail=100 -f",
    );
    vi.spyOn(McpServerRuntimeManager, "streamMcpServerLogs").mockResolvedValue(
      undefined,
    );

    await service.handleMessage(
      {
        type: "subscribe_mcp_logs",
        payload: { serverId: mcpServer.id, lines: 100 },
      },
      ws,
    );

    // Should NOT have sent an error - subscription should be created
    const errorCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => {
        const msg = JSON.parse(call[0] as string);
        return msg.type === "mcp_logs_error";
      },
    );
    expect(errorCalls).toHaveLength(0);
    expect(service.mcpLogsSubscriptions.has(ws)).toBe(true);
  });

  test("allows team member to access MCP server logs", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const teamMember = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    // Add teamMember to the team
    await makeTeamMember(team.id, teamMember.id);

    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: team.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    // teamMember is in the team, so they should have access
    service.clientContexts.set(ws, {
      userId: teamMember.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });

    // Mock the runtime manager methods
    vi.spyOn(
      McpServerRuntimeManager,
      "getAppropriateCommand",
    ).mockResolvedValue(
      "kubectl logs -n test -l mcp-server-id=test --tail=100 -f",
    );
    vi.spyOn(McpServerRuntimeManager, "streamMcpServerLogs").mockResolvedValue(
      undefined,
    );

    await service.handleMessage(
      {
        type: "subscribe_mcp_logs",
        payload: { serverId: mcpServer.id, lines: 100 },
      },
      ws,
    );

    // Should NOT have sent an error - subscription should be created
    const errorCalls = (ws.send as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => {
        const msg = JSON.parse(call[0] as string);
        return msg.type === "mcp_logs_error";
      },
    );
    expect(errorCalls).toHaveLength(0);
    expect(service.mcpLogsSubscriptions.has(ws)).toBe(true);
  });

  test("returns error for non-existent MCP server", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true, // Even admin can't access non-existent server
    });

    const nonExistentServerId = "00000000-0000-0000-0000-000000000000";

    await service.handleMessage(
      {
        type: "subscribe_mcp_logs",
        payload: { serverId: nonExistentServerId, lines: 100 },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "mcp_logs_error",
        payload: {
          serverId: nonExistentServerId,
          error: "MCP server not found",
        },
      }),
    );
    expect(service.mcpLogsSubscriptions.has(ws)).toBe(false);
  });

  test("unsubscribes from previous logs stream when subscribing to new one", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer1 = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    const mcpServer2 = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    // Mock the runtime manager methods
    vi.spyOn(
      McpServerRuntimeManager,
      "getAppropriateCommand",
    ).mockResolvedValue(
      "kubectl logs -n test -l mcp-server-id=test --tail=100 -f",
    );
    vi.spyOn(McpServerRuntimeManager, "streamMcpServerLogs").mockResolvedValue(
      undefined,
    );

    // Subscribe to first server
    await service.handleMessage(
      {
        type: "subscribe_mcp_logs",
        payload: { serverId: mcpServer1.id, lines: 100 },
      },
      ws,
    );

    const firstSubscription = service.mcpLogsSubscriptions.get(ws);
    expect(firstSubscription).toBeDefined();
    expect(firstSubscription?.serverId).toBe(mcpServer1.id);

    const firstAbortController = firstSubscription?.abortController;
    expect(firstAbortController).toBeDefined();
    const abortSpy = vi.spyOn(firstAbortController as AbortController, "abort");

    // Subscribe to second server - should unsubscribe from first
    await service.handleMessage(
      {
        type: "subscribe_mcp_logs",
        payload: { serverId: mcpServer2.id, lines: 100 },
      },
      ws,
    );

    // First subscription should have been aborted
    expect(abortSpy).toHaveBeenCalled();

    // New subscription should be for second server
    const secondSubscription = service.mcpLogsSubscriptions.get(ws);
    expect(secondSubscription).toBeDefined();
    expect(secondSubscription?.serverId).toBe(mcpServer2.id);
  });
});

describe("websocket MCP deployment statuses", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
    service.mcpLogsSubscriptions.clear();
    service.mcpExecSubscriptions.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
  });

  afterEach(() => {
    service.mcpDeploymentStatusSubscriptions.clear();
    if (service.mcpDeploymentStatusPollInterval) {
      clearInterval(service.mcpDeploymentStatusPollInterval);
      service.mcpDeploymentStatusPollInterval = null;
    }
  });

  test("sends initial deployment statuses for accessible local servers", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    const mcpServer1 = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    const mcpServer2 = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    // Mock statusSummary: server1 is running, server2 is not in the summary
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {
        [mcpServer1.id]: {
          state: "running",
          message: "Deployment is running",
          error: null,
          serverName: "test-server-1",
          deploymentName: `mcp-${mcpServer1.id}`,
          namespace: "default",
        },
      },
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledTimes(1);
    const sentMessage = JSON.parse(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(sentMessage).toEqual({
      type: "mcp_deployment_statuses",
      payload: {
        statuses: {
          [mcpServer1.id]: {
            state: "running",
            message: "Deployment is running",
            error: null,
            deploymentName: `mcp-${mcpServer1.id}`,
          },
          [mcpServer2.id]: {
            state: "not_created",
            message: "Deployment not created",
            error: null,
          },
        },
      },
    });
    expect(service.mcpDeploymentStatusSubscriptions.has(ws)).toBe(true);
  });

  test("filters out remote servers from deployment statuses", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });

    // Create a local server using the fixture (defaults to serverType: "local")
    const localServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    // Create a remote server by first creating via fixture then updating serverType
    const remoteServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    await db
      .update(schema.mcpServersTable)
      .set({ serverType: "remote" })
      .where(eq(schema.mcpServersTable.id, remoteServer.id));

    // Mock statusSummary with both servers
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {
        [localServer.id]: {
          state: "running",
          message: "Deployment is running",
          error: null,
          serverName: "local-server",
          deploymentName: `mcp-${localServer.id}`,
          namespace: "default",
        },
        [remoteServer.id]: {
          state: "running",
          message: "Deployment is running",
          error: null,
          serverName: "remote-server",
          deploymentName: `mcp-${remoteServer.id}`,
          namespace: "default",
        },
      },
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    const sentMessage = JSON.parse(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(sentMessage.type).toBe("mcp_deployment_statuses");
    // Only local server should be in statuses
    expect(sentMessage.payload.statuses).toHaveProperty(localServer.id);
    expect(sentMessage.payload.statuses).not.toHaveProperty(remoteServer.id);
  });

  test("returns not_created for servers not in runtime summary", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    // Mock statusSummary with an empty mcpServers map
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "mcp_deployment_statuses",
        payload: {
          statuses: {
            [mcpServer.id]: {
              state: "not_created",
              message: "Deployment not created",
              error: null,
            },
          },
        },
      }),
    );
  });

  test("unsubscribes and stops the shared poller on unsubscribe message", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    // Subscribe first
    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    expect(service.mcpDeploymentStatusSubscriptions.has(ws)).toBe(true);
    expect(service.mcpDeploymentStatusPollInterval).not.toBeNull();

    // Now unsubscribe
    await service.handleMessage(
      {
        type: "unsubscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    expect(service.mcpDeploymentStatusSubscriptions.has(ws)).toBe(false);
    // Last subscriber gone: the shared poller must be stopped
    expect(service.mcpDeploymentStatusPollInterval).toBeNull();
  });

  test("cleans up previous subscription when subscribing again", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    // Subscribe first time
    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    const firstSubscription = service.mcpDeploymentStatusSubscriptions.get(ws);
    expect(firstSubscription).toBeDefined();

    // Subscribe again - should replace the first subscription
    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    const secondSubscription = service.mcpDeploymentStatusSubscriptions.get(ws);
    expect(secondSubscription).toBeDefined();
    expect(secondSubscription).not.toBe(firstSubscription);
    expect(service.mcpDeploymentStatusSubscriptions.size).toBe(1);
    expect(service.mcpDeploymentStatusPollInterval).not.toBeNull();
  });
});

describe("websocket MCP deployment statuses shared poller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Only fake interval timers: real timeouts stay real so DB access keeps working
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    service.clientContexts.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
  });

  afterEach(() => {
    service.mcpDeploymentStatusSubscriptions.clear();
    if (service.mcpDeploymentStatusPollInterval) {
      clearInterval(service.mcpDeploymentStatusPollInterval);
      service.mcpDeploymentStatusPollInterval = null;
    }
    vi.useRealTimers();
  });

  const makeWs = () =>
    ({
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    }) as unknown as WS;

  const subscribe = (ws: WS) =>
    service.handleMessage(
      { type: "subscribe_mcp_deployment_statuses", payload: {} },
      ws,
    );

  test("one tick triggers a single shared refresh for multiple subscribers", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const refreshSpy = vi
      .spyOn(McpServerRuntimeManager, "refreshAllStates")
      .mockResolvedValue(undefined);
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws1 = makeWs();
    const ws2 = makeWs();
    const context = {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    };
    service.clientContexts.set(ws1, context);
    service.clientContexts.set(ws2, context);

    await subscribe(ws1);
    await subscribe(ws2);
    expect(service.mcpDeploymentStatusSubscriptions.size).toBe(2);

    refreshSpy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  test("a watch-triggered manager refresh pushes fresh statuses without waiting for the poll tick", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    vi.spyOn(McpServerRuntimeManager, "refreshAllStates").mockResolvedValue(
      undefined,
    );
    let summary: typeof McpServerRuntimeManager.statusSummary = {
      status: "running",
      mcpServers: {},
    };
    vi.spyOn(
      McpServerRuntimeManager,
      "statusSummary",
      "get",
    ).mockImplementation(() => summary);

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });
    await subscribe(ws);
    expect(ws.send).toHaveBeenCalledTimes(1);

    try {
      // The cluster changes; the manager's watch layer refreshes and
      // notifies. No poll tick elapses (interval timers stay frozen), yet
      // the subscriber receives the update.
      summary = {
        status: "running",
        mcpServers: {
          [mcpServer.id]: {
            state: "running",
            message: "Deployment is running",
            error: null,
            serverName: "test-server",
            deploymentName: `mcp-${mcpServer.id}`,
            namespace: "default",
          },
        },
      };
      (
        McpServerRuntimeManager as unknown as {
          scheduleWatchTriggeredRefresh: () => void;
        }
      ).scheduleWatchTriggeredRefresh();

      await vi.waitFor(() => expect(ws.send).toHaveBeenCalledTimes(2), {
        timeout: 5_000,
      });
      const pushed = JSON.parse(
        (ws.send as ReturnType<typeof vi.fn>).mock.calls[1][0],
      );
      expect(pushed.type).toBe("mcp_deployment_statuses");
      expect(pushed.payload.statuses[mcpServer.id].state).toBe("running");
    } finally {
      service.unsubscribeMcpDeploymentStatuses(ws);
    }
  });

  test("poll ticks skip the K8s refresh while watch streams are healthy and state is fresh", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const refreshSpy = vi
      .spyOn(McpServerRuntimeManager, "refreshAllStates")
      .mockResolvedValue(undefined);
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });
    vi.spyOn(
      McpServerRuntimeManager,
      "deploymentStateWatchersActive",
      "get",
    ).mockReturnValue(true);

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });
    await subscribe(ws);

    try {
      refreshSpy.mockClear();
      service.lastMcpDeploymentRefreshAt = Date.now();
      await vi.advanceTimersByTimeAsync(10_000);
      // Watchers healthy + fresh state: the tick is a no-op resync check.
      expect(refreshSpy).not.toHaveBeenCalled();

      // Stale state (past the resync window): the tick re-polls as a
      // safety net against missed watch events.
      service.lastMcpDeploymentRefreshAt = Date.now() - 61_000;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    } finally {
      service.unsubscribeMcpDeploymentStatuses(ws);
    }
  });

  test("sends per-subscriber updates scoped to each subscriber's accessible servers", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
    makeTeamMember,
  }) => {
    const org = await makeOrganization();
    const userA = await makeUser();
    const userB = await makeUser();
    const teamA = await makeTeam(org.id, userA.id);
    const teamB = await makeTeam(org.id, userB.id);
    await makeTeamMember(teamA.id, userA.id);
    await makeTeamMember(teamB.id, userB.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    const serverA = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: userA.id,
      teamId: teamA.id,
    });
    const serverB = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: userB.id,
      teamId: teamB.id,
    });

    vi.spyOn(McpServerRuntimeManager, "refreshAllStates").mockResolvedValue(
      undefined,
    );
    let summary: typeof McpServerRuntimeManager.statusSummary = {
      status: "running",
      mcpServers: {},
    };
    vi.spyOn(
      McpServerRuntimeManager,
      "statusSummary",
      "get",
    ).mockImplementation(() => summary);

    const wsA = makeWs();
    const wsB = makeWs();
    service.clientContexts.set(wsA, {
      userId: userA.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });
    service.clientContexts.set(wsB, {
      userId: userB.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });

    await subscribe(wsA);
    await subscribe(wsB);
    (wsA.send as ReturnType<typeof vi.fn>).mockClear();
    (wsB.send as ReturnType<typeof vi.fn>).mockClear();

    // Both deployments transition to running
    summary = {
      status: "running",
      mcpServers: {
        [serverA.id]: {
          state: "running",
          message: "Deployment is running",
          error: null,
          serverName: "server-a",
          deploymentName: `mcp-${serverA.id}`,
          namespace: "default",
        },
        [serverB.id]: {
          state: "running",
          message: "Deployment is running",
          error: null,
          serverName: "server-b",
          deploymentName: `mcp-${serverB.id}`,
          namespace: "default",
        },
      },
    };
    await vi.advanceTimersByTimeAsync(10_000);

    expect(wsA.send).toHaveBeenCalledTimes(1);
    const messageA = JSON.parse(
      (wsA.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(messageA.type).toBe("mcp_deployment_statuses");
    expect(Object.keys(messageA.payload.statuses)).toEqual([serverA.id]);
    expect(messageA.payload.statuses[serverA.id].state).toBe("running");

    expect(wsB.send).toHaveBeenCalledTimes(1);
    const messageB = JSON.parse(
      (wsB.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    );
    expect(messageB.type).toBe("mcp_deployment_statuses");
    expect(Object.keys(messageB.payload.statuses)).toEqual([serverB.id]);
    expect(messageB.payload.statuses[serverB.id].state).toBe("running");
  });

  test("does not resend when statuses are unchanged", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    vi.spyOn(McpServerRuntimeManager, "refreshAllStates").mockResolvedValue(
      undefined,
    );
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await subscribe(ws);
    (ws.send as ReturnType<typeof vi.fn>).mockClear();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(ws.send).not.toHaveBeenCalled();
  });

  test("unsubscribing the last subscriber stops polling", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const refreshSpy = vi
      .spyOn(McpServerRuntimeManager, "refreshAllStates")
      .mockResolvedValue(undefined);
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await subscribe(ws);
    await service.handleMessage(
      { type: "unsubscribe_mcp_deployment_statuses", payload: {} },
      ws,
    );

    refreshSpy.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(service.mcpDeploymentStatusPollInterval).toBeNull();
  });

  test("a hung refresh does not freeze the poller past the refresh bound", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    // The refresh bound uses setTimeout: fake it too, for this test only
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });

    // Second call (first tick) hangs forever; all others resolve
    let refreshCalls = 0;
    const refreshSpy = vi
      .spyOn(McpServerRuntimeManager, "refreshAllStates")
      .mockImplementation(() => {
        refreshCalls++;
        return refreshCalls === 2
          ? new Promise<void>(() => {})
          : Promise.resolve();
      });
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await subscribe(ws);
    expect(refreshSpy).toHaveBeenCalledTimes(1);

    // First tick starts the hung refresh
    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshSpy).toHaveBeenCalledTimes(2);

    // Advance well past the refresh bound: the guard must be released and a
    // later tick must run a fresh refresh instead of being frozen forever
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshSpy.mock.calls.length).toBeGreaterThan(2);
  });

  test("a failed send is retried on the next tick", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    vi.spyOn(McpServerRuntimeManager, "refreshAllStates").mockResolvedValue(
      undefined,
    );
    let summary: typeof McpServerRuntimeManager.statusSummary = {
      status: "running",
      mcpServers: {},
    };
    vi.spyOn(
      McpServerRuntimeManager,
      "statusSummary",
      "get",
    ).mockImplementation(() => summary);

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await subscribe(ws);
    const sendMock = ws.send as ReturnType<typeof vi.fn>;
    sendMock.mockClear();

    summary = {
      status: "running",
      mcpServers: {
        [mcpServer.id]: {
          state: "running",
          message: "Deployment is running",
          error: null,
          serverName: "test-server",
          deploymentName: `mcp-${mcpServer.id}`,
          namespace: "default",
        },
      },
    };

    // Tick N: send blows up — the update must not be marked as delivered
    sendMock.mockImplementationOnce(() => {
      throw new Error("socket write failed");
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Tick N+1: the same (still-changed) payload is retried and delivered
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const retried = JSON.parse(sendMock.mock.calls[1][0] as string);
    expect(retried.type).toBe("mcp_deployment_statuses");
    expect(retried.payload.statuses[mcpServer.id].state).toBe("running");
  });

  test("socket closed during subscribe awaits is not registered and poller stays off", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    let resolveRefresh: (() => void) | undefined;
    const refreshSpy = vi
      .spyOn(McpServerRuntimeManager, "refreshAllStates")
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
    vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue({
      status: "running",
      mcpServers: {},
    });

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    const subscribePromise = subscribe(ws);
    // setTimeout is real in this describe, so waitFor can poll
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalled());

    // Socket closes while subscribe is still awaiting the refresh
    (ws as { readyState: number }).readyState = WS.CLOSED;
    resolveRefresh?.();
    await subscribePromise;

    expect(ws.send).not.toHaveBeenCalled();
    expect(service.mcpDeploymentStatusSubscriptions.has(ws)).toBe(false);
    expect(service.mcpDeploymentStatusPollInterval).toBeNull();
  });
});

describe("websocket MCP exec", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
    service.mcpLogsSubscriptions.clear();
    service.mcpExecSubscriptions.clear();
    service.mcpDeploymentStatusSubscriptions.clear();
  });

  afterEach(() => {
    for (const sub of service.mcpExecSubscriptions.values()) {
      sub.stdin.destroy();
      sub.stdout.destroy();
      sub.stderr.destroy();
      if (sub.k8sWs.readyState <= 1) {
        sub.k8sWs.close();
      }
    }
    service.mcpExecSubscriptions.clear();
  });

  function makeMockK8sWs() {
    let readyState = 1;
    const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    return {
      get readyState() {
        return readyState;
      },
      close: vi.fn(() => {
        readyState = 3;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)?.push(listener);
      }),
      send: vi.fn(),
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) {
          listener(...args);
        }
      },
    } as unknown as WS & {
      send: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      emit: (event: string, ...args: unknown[]) => void;
    };
  }

  test("rejects exec subscription for MCP server the user does not have access to", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const otherUser = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: team.id,
    });

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: otherUser.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "mcp_exec_error",
        payload: {
          serverId: mcpServer.id,
          error: "MCP server not found",
        },
      }),
    );
    expect(service.mcpExecSubscriptions.has(ws)).toBe(false);
  });

  test("returns error for non-existent MCP server", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    const nonExistentServerId = "00000000-0000-0000-0000-000000000000";

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: nonExistentServerId },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "mcp_exec_error",
        payload: {
          serverId: nonExistentServerId,
          error: "MCP server not found",
        },
      }),
    );
    expect(service.mcpExecSubscriptions.has(ws)).toBe(false);
  });

  test("allows MCP server admin to exec and creates subscription", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const adminUser = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: owner.id,
      teamId: team.id,
    });

    const mockK8sWs = makeMockK8sWs();

    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockResolvedValue({
      k8sWs: mockK8sWs,
      podName: "mcp-test-pod-abc123",
    });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec -it ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: adminUser.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    // Should have sent exec_started
    const sentMessages = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => JSON.parse(call[0] as string),
    );
    expect(sentMessages).toContainEqual({
      type: "mcp_exec_started",
      payload: {
        serverId: mcpServer.id,
        command: "kubectl exec -it ...",
        podName: "mcp-test-pod-abc123",
      },
    });
    expect(service.mcpExecSubscriptions.has(ws)).toBe(true);
  });

  test("sends exec error when runtime manager throws", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockRejectedValue(
      new Error("No running pod found for this deployment"),
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "mcp_exec_error",
        payload: {
          serverId: mcpServer.id,
          error: "No running pod found for this deployment",
        },
      }),
    );
    expect(service.mcpExecSubscriptions.has(ws)).toBe(false);
  });

  test("forwards stdout data to client as exec_output", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const mockK8sWs = makeMockK8sWs();

    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockResolvedValue({
      k8sWs: mockK8sWs,
      podName: "mcp-test-pod",
    });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    // Write to the stdout stream that was passed to execIntoMcpServer
    const sub = service.mcpExecSubscriptions.get(ws);
    expect(sub).toBeDefined();
    sub?.stdout.write(Buffer.from("hello world"));

    // Wait for stream data event to propagate
    await new Promise((resolve) => setTimeout(resolve, 10));

    const sentMessages = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => JSON.parse(call[0] as string),
    );
    expect(sentMessages).toContainEqual({
      type: "mcp_exec_output",
      payload: { serverId: mcpServer.id, data: "hello world" },
    });
  });

  // Shared harness for the close-reason tests: wires a mock K8s exec that lets
  // the test drive both exec channels (status + output) and then close.
  async function startExecSession(ctx: {
    org: { id: string };
    user: { id: string };
    serverId: string;
  }) {
    const mockK8sWs = makeMockK8sWs();
    let capturedOnStatus:
      | ((status: { status?: string; message?: string }) => void)
      | undefined;
    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockImplementation(
      async (_id, _stdin, _stdout, _stderr, onStatus) => {
        capturedOnStatus = onStatus;
        return { k8sWs: mockK8sWs, podName: "mcp-test-pod" };
      },
    );
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: ctx.user.id,
      organizationId: ctx.org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      { type: "subscribe_mcp_exec", payload: { serverId: ctx.serverId } },
      ws,
    );

    const writeOutput = async (data: string) => {
      service.mcpExecSubscriptions.get(ws)?.stdout.write(Buffer.from(data));
      await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const closedReason = (): unknown => {
      const closed = (ws.send as ReturnType<typeof vi.fn>).mock.calls
        .map((call) => JSON.parse(call[0] as string))
        .find((m) => m.type === "mcp_exec_closed");
      return closed?.payload?.reason;
    };
    return {
      mockK8sWs,
      setStatus: () => capturedOnStatus,
      writeOutput,
      closedReason,
    };
  }

  test("surfaces the no-shell reason when the OCI error arrives on the output stream", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const session = await startExecSession({
      org,
      user,
      serverId: mcpServer.id,
    });

    // The runtime here puts a generic exit code on the status channel and the
    // real detail on stderr (the distroless repro on docker-desktop).
    await session.writeOutput(
      'OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory',
    );
    session.setStatus()?.({
      status: "Failure",
      message: "command terminated with non-zero exit code: exit code 127",
    });
    session.mockK8sWs.emit("close");

    expect(session.closedReason()).toEqual(
      expect.stringContaining("No shell found"),
    );
  });

  test("surfaces the no-shell reason when it arrives on the status channel", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const session = await startExecSession({
      org,
      user,
      serverId: mcpServer.id,
    });

    session.setStatus()?.({
      status: "Failure",
      message:
        'OCI runtime exec failed: exec: "/bin/sh": stat /bin/sh: no such file or directory',
    });
    session.mockK8sWs.emit("close");

    expect(session.closedReason()).toEqual(
      expect.stringContaining("No shell found"),
    );
  });

  test("keeps the generic closed message on a clean exit", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const session = await startExecSession({
      org,
      user,
      serverId: mcpServer.id,
    });

    session.setStatus()?.({ status: "Success" });
    session.mockK8sWs.emit("close");

    expect(session.closedReason()).toBeUndefined();
  });

  test("does not misread ordinary shell 'no such file' output as a missing shell", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const session = await startExecSession({
      org,
      user,
      serverId: mcpServer.id,
    });

    // A working shell where a command happens to fail — must NOT be mistaken
    // for a missing shell.
    await session.writeOutput("cat: /nope: No such file or directory\n");
    session.setStatus()?.({ status: "Success" });
    session.mockK8sWs.emit("close");

    expect(session.closedReason()).toBeUndefined();
  });

  test("forwards input from client to stdin", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const mockK8sWs = makeMockK8sWs();

    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockResolvedValue({
      k8sWs: mockK8sWs,
      podName: "mcp-test-pod",
    });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    const sub = service.mcpExecSubscriptions.get(ws);
    expect(sub).toBeDefined();

    // Collect data written to stdin
    const stdinData: string[] = [];
    sub?.stdin.on("data", (chunk: Buffer) => {
      stdinData.push(chunk.toString());
    });

    // Send input from client
    await service.handleMessage(
      {
        type: "mcp_exec_input",
        payload: { serverId: mcpServer.id, data: "ls -la\n" },
      },
      ws,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stdinData).toContain("ls -la\n");
  });

  test("sends resize command to K8s WebSocket", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const mockK8sWs = makeMockK8sWs();

    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockResolvedValue({
      k8sWs: mockK8sWs,
      podName: "mcp-test-pod",
    });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    // Send resize from client
    await service.handleMessage(
      {
        type: "mcp_exec_resize",
        payload: { serverId: mcpServer.id, cols: 120, rows: 40 },
      },
      ws,
    );

    // Verify resize was sent to K8s WS with SPDY channel 4 prefix
    expect(mockK8sWs.send).toHaveBeenCalled();
    const sentBuf = mockK8sWs.send.mock.calls[0][0] as Buffer;
    expect(sentBuf[0]).toBe(4); // SPDY channel 4 = resize
    const resizeJson = sentBuf.subarray(1).toString();
    expect(JSON.parse(resizeJson)).toEqual({ Width: 120, Height: 40 });
  });

  test("cleans up on unsubscribe", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const mockK8sWs = makeMockK8sWs();

    vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer").mockResolvedValue({
      k8sWs: mockK8sWs,
      podName: "mcp-test-pod",
    });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    expect(service.mcpExecSubscriptions.has(ws)).toBe(true);

    // Unsubscribe
    await service.handleMessage(
      {
        type: "unsubscribe_mcp_exec",
        payload: { serverId: mcpServer.id },
      },
      ws,
    );

    expect(service.mcpExecSubscriptions.has(ws)).toBe(false);
    expect(mockK8sWs.close).toHaveBeenCalled();
  });

  test("unsubscribes previous exec when subscribing to new server", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog();
    const mcpServer1 = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    const mcpServer2 = await makeMcpServer({
      scope: "team",
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    const mockK8sWs1 = makeMockK8sWs();
    const mockK8sWs2 = makeMockK8sWs();

    const execSpy = vi.spyOn(McpServerRuntimeManager, "execIntoMcpServer");
    execSpy.mockResolvedValueOnce({
      k8sWs: mockK8sWs1,
      podName: "pod-1",
    });
    execSpy.mockResolvedValueOnce({
      k8sWs: mockK8sWs2,
      podName: "pod-2",
    });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec ...",
    );

    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
    } as unknown as WS;

    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    // Subscribe to first server
    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer1.id },
      },
      ws,
    );

    expect(service.mcpExecSubscriptions.get(ws)?.serverId).toBe(mcpServer1.id);

    // Subscribe to second server - should close first
    await service.handleMessage(
      {
        type: "subscribe_mcp_exec",
        payload: { serverId: mcpServer2.id },
      },
      ws,
    );

    expect(mockK8sWs1.close).toHaveBeenCalled();
    expect(service.mcpExecSubscriptions.get(ws)?.serverId).toBe(mcpServer2.id);
  });
});

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
describe("websocket deployment metrics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Only fake interval timers: real timeouts stay real so DB access keeps working
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    if (service.deploymentMetricsInterval) {
      clearInterval(service.deploymentMetricsInterval);
      service.deploymentMetricsInterval = null;
    }
    service.deploymentMetricsRefreshUnsubscribe?.();
    service.deploymentMetricsRefreshUnsubscribe = null;
    vi.useRealTimers();
  });

  const gaugeValue = async (state: string) => {
    const metric = client.register.getSingleMetric(
      "mcp_server_deployment_status",
    ) as client.Gauge<string> | undefined;
    const data = await metric?.get();
    return data?.values.find(
      (v) =>
        v.labels.server_name === "metrics-test-server" &&
        v.labels.state === state,
    )?.value;
  };

  test("a manager state refresh rewrites the deployment gauge immediately", async () => {
    let state: "hibernated" | "waking" = "hibernated";
    vi.spyOn(
      McpServerRuntimeManager,
      "statusSummary",
      "get",
    ).mockImplementation(() => ({
      status: "running",
      mcpServers: {
        "server-1": {
          state,
          message: "Deployment status for the metrics test",
          error: null,
          serverName: "metrics-test-server",
          deploymentName: "mcp-server-1",
          namespace: "default",
        },
      },
    }));
    const captured: { refreshListener: (() => void) | null } = {
      refreshListener: null,
    };
    vi.spyOn(
      McpServerRuntimeManager,
      "onDeploymentStatesRefreshed",
    ).mockImplementation((listener: () => void) => {
      captured.refreshListener = listener;
      return () => {
        captured.refreshListener = null;
      };
    });

    service.startDeploymentMetricsPolling();

    // The immediate report reflects the current state.
    expect(await gaugeValue("hibernated")).toBe(1);
    expect(await gaugeValue("waking")).toBe(0);

    // A waking deployment lives for a couple of seconds — far less than the
    // reconciler interval. The manager's refresh notification alone, with no
    // timer advance, must land it in the gauge.
    state = "waking";
    expect(captured.refreshListener).not.toBeNull();
    captured.refreshListener?.();

    expect(await gaugeValue("waking")).toBe(1);
    expect(await gaugeValue("hibernated")).toBe(0);
  });
});
// SPDX-SnippetEnd
