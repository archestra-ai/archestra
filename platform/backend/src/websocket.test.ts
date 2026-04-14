import type { IncomingMessage } from "node:http";
import type { PassThrough } from "node:stream";
import type { ClientWebSocketMessage, McpDeploymentStatusEntry } from "@shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import { betterAuth } from "@/auth";
import type * as originalConfigModule from "@/config";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
    },
  };
});

const { browserStreamFeature } = await import(
  "@/features/browser-stream/services/browser-stream.feature"
);
const { default: websocketService } = await import("@/websocket");
const { default: McpServerRuntimeManager } = await import(
  "@/k8s/mcp-server-runtime/manager"
);

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

interface McpDeploymentStatusSubscription {
  interval: NodeJS.Timeout;
  lastStatuses: Record<string, McpDeploymentStatusEntry>;
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
  mcpDeploymentStatusSubscriptions: Map<WS, McpDeploymentStatusSubscription>;
  initBrowserStreamContextForTesting: () => void;
};

// Initialize browser stream context once for all tests (config mock is already applied)
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
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    const mcpServer2 = await makeMcpServer({
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
    for (const subscription of service.mcpDeploymentStatusSubscriptions.values()) {
      clearInterval(subscription.interval);
    }
    service.mcpDeploymentStatusSubscriptions.clear();
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
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer1 = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    const mcpServer2 = await makeMcpServer({
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
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });

    // Create a local server using the fixture (defaults to serverType: "local")
    const localServer = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });

    // Create a remote server by first creating via fixture then updating serverType
    const remoteServer = await makeMcpServer({
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
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    const mcpServer = await makeMcpServer({
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

  test("unsubscribes and clears interval on unsubscribe message", async ({
    makeOrganization,
    makeUser,
    makeMcpServer,
    makeInternalMcpCatalog,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    await makeMcpServer({
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
    const subscription = service.mcpDeploymentStatusSubscriptions.get(ws);
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    // Now unsubscribe
    await service.handleMessage(
      {
        type: "unsubscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    expect(service.mcpDeploymentStatusSubscriptions.has(ws)).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledWith(subscription?.interval);
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
    const catalog = await makeInternalMcpCatalog({ serverType: "local" });
    await makeMcpServer({
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
    const firstInterval = firstSubscription?.interval;
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    // Subscribe again - should clean up the first subscription
    await service.handleMessage(
      {
        type: "subscribe_mcp_deployment_statuses",
        payload: {},
      },
      ws,
    );

    // First interval should have been cleared
    expect(clearIntervalSpy).toHaveBeenCalledWith(firstInterval);

    // A new subscription should exist
    const secondSubscription = service.mcpDeploymentStatusSubscriptions.get(ws);
    expect(secondSubscription).toBeDefined();
    expect(secondSubscription?.interval).not.toBe(firstInterval);
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
      catalogId: catalog.id,
      ownerId: user.id,
      teamId: team.id,
    });
    const mcpServer2 = await makeMcpServer({
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
