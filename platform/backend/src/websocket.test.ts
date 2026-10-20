import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import {
  type ClientWebSocketMessage,
  EDITOR_ROLE_NAME,
  type McpDeploymentStatusEntry,
  MEMBER_ROLE_NAME,
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
import { agentRuntimeManager } from "@/k8s/agent-runtime";
import McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import {
  A2AContextModel,
  A2ATaskModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import AgentModel from "@/models/agent";
import { agentRunTranscriptStore } from "@/services/agent-runtime/transcript-store";
import { type PgClient, PostgresNotifyHub } from "@/services/pg-notify-hub";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { shareForTest } from "@/test/sharing";
import { grantRoleEverywhere } from "@/test/wildcard-grants";
import websocketService, { WebSocketService } from "@/websocket";

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
      workloadName: `agent-run-${task.id}`,
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
          error: "You do not have access to this run's output",
        },
      }),
    );
    expect(service.agentRunLogsSubscriptions.has(ws)).toBe(false);
  });

  test("streams retained logs to a viewer the run is shared with", async ({
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
      workloadName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await AgentRunModel.close({
      id: run.id,
      logs: "checked repository\nopened pull request\n",
    });
    // The owner shares the run organization-wide.
    await shareForTest({
      resource: "agentRun",
      scope: task.id,
      organizationId: organization.id,
      visibility: "organization",
      teamIds: [],
      userIds: [],
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
        payload: {
          runId: task.id,
          source: "tail",
          truncated: false,
        },
      }),
    );
  });

  test("streams retained logs through a shared project to a read-all member", async ({
    makeAgent,
    makeCustomRole,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });
    const role = await makeCustomRole(organization.id, {
      permission: { project: ["read"] },
    });
    // `read` on every chat, the grant the retired project:read-all became.
    await grantRoleEverywhere({
      organizationId: organization.id,
      resource: "conversation",
      roleId: role.id,
      actions: ["read"],
    });
    const viewer = await makeUser();
    await makeMember(viewer.id, organization.id, { role: role.role });
    const project = await projectService.create({
      organizationId: organization.id,
      userId: owner.id,
      name: "Shared execution project",
      description: null,
    });
    await shareForTest({
      resource: "project",
      scope: project.id,
      organizationId: organization.id,
      visibility: "organization",
      teamIds: [],
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
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
      projectId: project.id,
      workloadName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await AgentRunModel.close({ id: run.id, logs: "project result\n" });
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

    expect(ws.send).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({
        type: "agent_run_logs",
        payload: { runId: task.id, logs: "project result\n" },
      }),
    );
    expect(ws.send).toHaveBeenNthCalledWith(
      2,
      JSON.stringify({
        type: "agent_run_logs_ended",
        payload: {
          runId: task.id,
          source: "tail",
          truncated: false,
        },
      }),
    );
  });

  test("returns retained logs after an Agent run pod is removed", async ({
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
      workloadName: `agent-run-${task.id}`,
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
        payload: {
          runId: task.id,
          source: "tail",
          truncated: false,
        },
      }),
    );
    expect(service.agentRunLogsSubscriptions.has(ws)).toBe(false);
  });

  test("streams a complete compressed transcript instead of the retained tail", async ({
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
      workloadName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await AgentRunModel.close({ id: run.id, logs: "final tail\n" });
    const completeTranscript = `${"earlier output\n".repeat(30_000)}done ✓\n`;
    const readableTranscript = JSON.stringify({
      version: 1,
      provider: "claude-code",
      entries: [
        { type: "message", role: "user", text: "Build it" },
        { type: "message", role: "assistant", text: "Done" },
      ],
    });
    await agentRunTranscriptStore.persist({
      runId: run.id,
      transcript: completeTranscript,
      observedBytes: Buffer.byteLength(completeTranscript),
      readableTranscript,
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

    // A remount can unsubscribe while the first database read is in flight.
    // Only the replacement subscription may deliver the retained JSON stream.
    const firstSubscription = service.handleMessage(
      {
        type: "subscribe_agent_run_logs",
        payload: { runId: task.id, lines: 100 },
      },
      ws,
    );
    await service.handleMessage(
      { type: "unsubscribe_agent_run_logs", payload: { runId: task.id } },
      ws,
    );
    await Promise.all([
      firstSubscription,
      service.handleMessage(
        {
          type: "subscribe_agent_run_logs",
          payload: { runId: task.id, lines: 100 },
        },
        ws,
      ),
    ]);

    const sent = vi
      .mocked(ws.send)
      .mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(sent.at(-1)).toEqual({
      type: "agent_run_logs_ended",
      payload: {
        runId: task.id,
        source: "full",
        truncated: false,
        totalBytes: Buffer.byteLength(completeTranscript),
        readable: {
          provider: "claude-code",
          version: 1,
          totalBytes: Buffer.byteLength(readableTranscript),
        },
      },
    });
    expect(
      sent
        .filter(
          (message) =>
            message.type === "agent_run_logs" &&
            message.payload.channel !== "readable",
        )
        .map((message) => message.payload.logs)
        .join(""),
    ).toBe(completeTranscript);
    expect(
      sent
        .filter(
          (message) =>
            message.type === "agent_run_logs" &&
            message.payload.channel === "readable",
        )
        .map((message) => message.payload.logs)
        .join(""),
    ).toBe(readableTranscript);
  });

  test("sends the end of a complete recording at its terminal size and counts what it left out", async ({
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
      workloadName: `agent-run-${task.id}`,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await AgentRunModel.close({ id: run.id, logs: "final tail\n" });
    // Two stored chunks (256 KiB each); the size is set in the first.
    const marker = "\u001b]777;archestra-terminal-size=100x30\u0007";
    const recording = `${marker}${"earlier output\n".repeat(30_000)}done ✓\n`;
    await agentRunTranscriptStore.persist({
      runId: run.id,
      transcript: recording,
      observedBytes: Buffer.byteLength(recording),
      readableTranscript: JSON.stringify({
        version: 1,
        provider: "claude-code",
        entries: [{ type: "message", role: "user", text: "Build it" }],
      }),
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
        payload: { runId: task.id, tailBytes: 64 * 1024 },
      },
      ws,
    );

    const sent = vi
      .mocked(ws.send)
      .mock.calls.map(([message]) => JSON.parse(String(message)));
    const logs = sent
      .filter((message) => message.type === "agent_run_logs")
      .map((message) => message.payload.logs)
      .join("");
    const total = Buffer.byteLength(recording);
    const tail = logs.slice(marker.length);
    expect(logs.startsWith(marker)).toBe(true);
    // Whole lines from the second chunk on, ending with the recording's end.
    expect(tail.startsWith("earlier output\n")).toBe(true);
    expect(recording.endsWith(tail)).toBe(true);
    expect(Buffer.byteLength(tail)).toBeLessThan(total - 256 * 1024 + 1);
    expect(sent.at(-1)).toEqual({
      type: "agent_run_logs_ended",
      payload: {
        runId: task.id,
        source: "full",
        truncated: false,
        totalBytes: total,
        omittedBytes: total - Buffer.byteLength(tail),
      },
    });
    // The readable transcript has no reader on the page; a tail leaves it out.
    expect(sent.some((message) => message.payload.channel === "readable")).toBe(
      false,
    );
  });

  test("a tail read that fails after output was sent ends in an error, not the full recording", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const { ws, task, recording } = await makeEndedRunWithRecording({
      makeOrganization,
      makeUser,
      makeAgent,
    });
    const streamTail = vi
      .spyOn(agentRunTranscriptStore, "streamTail")
      .mockImplementation(async (params) => {
        params.onChunk(Buffer.from("partial tail\n"));
        throw new Error("chunk 3 is corrupt");
      });
    try {
      await service.handleMessage(
        {
          type: "subscribe_agent_run_logs",
          payload: { runId: task.id, tailBytes: 64 * 1024 },
        },
        ws,
      );
    } finally {
      streamTail.mockRestore();
    }
    const sent = vi
      .mocked(ws.send)
      .mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(
      sent
        .filter((message) => message.type === "agent_run_logs")
        .map((message) => message.payload.logs),
    ).toEqual(["partial tail\n"]);
    expect(sent.at(-1)).toEqual({
      type: "agent_run_logs_error",
      payload: {
        runId: task.id,
        error: "Could not read the end of the recording",
      },
    });
    expect(
      sent.some((message) => message.type === "agent_run_logs_ended"),
    ).toBe(false);
    expect(JSON.stringify(sent)).not.toContain(recording.slice(0, 40));
  });

  test("a tail read that fails before any output falls back to the full recording", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const { ws, task, recording } = await makeEndedRunWithRecording({
      makeOrganization,
      makeUser,
      makeAgent,
    });
    const streamTail = vi
      .spyOn(agentRunTranscriptStore, "streamTail")
      .mockRejectedValue(new Error("sizes query failed"));
    try {
      await service.handleMessage(
        {
          type: "subscribe_agent_run_logs",
          payload: { runId: task.id, tailBytes: 64 * 1024 },
        },
        ws,
      );
    } finally {
      streamTail.mockRestore();
    }
    const sent = vi
      .mocked(ws.send)
      .mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(
      sent
        .filter((message) => message.type === "agent_run_logs")
        .map((message) => message.payload.logs)
        .join(""),
    ).toBe(recording);
    expect(sent.at(-1).type).toBe("agent_run_logs_ended");
  });

  test("a session history that cannot be counted ends the tail in an error", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const { ws, task } = await makeEndedRunWithRecording({
      makeOrganization,
      makeUser,
      makeAgent,
    });
    const listPreviousTurns = vi
      .spyOn(AgentRunModel, "listPreviousTurns")
      .mockRejectedValue(new Error("connection reset"));
    try {
      await service.handleMessage(
        {
          type: "subscribe_agent_run_logs",
          payload: {
            runId: task.id,
            includeSessionHistory: true,
            tailBytes: 64 * 1024,
          },
        },
        ws,
      );
    } finally {
      listPreviousTurns.mockRestore();
    }
    const sent = vi
      .mocked(ws.send)
      .mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(sent.at(-1)).toEqual({
      type: "agent_run_logs_error",
      payload: { runId: task.id, error: "Could not read session history" },
    });
    expect(
      sent.some((message) => message.type === "agent_run_logs_ended"),
    ).toBe(false);
  });

  test("owner session history includes earlier turns while shared access remains per turn", async ({
    makeOrganization,
    makeUser,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const other = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const turns = [];
    const workloadName = `history-${crypto.randomUUID()}`;
    for (const text of ["first turn ✓", "second turn ✓"]) {
      const task = await A2ATaskModel.create({
        contextId: context.id,
        agentId: agent.id,
        state: "TASK_STATE_COMPLETED",
      });
      const run = await AgentRunModel.create({
        organizationId: org.id,
        taskId: task.id,
        agentId: agent.id,
        actorKind: "user",
        actorId: owner.id,
        actorUserId: owner.id,
        workloadName,
        backend: "kubernetes",
        runtimeScope: "test",
        virtualApiKeyId: null,
      });
      await AgentRunModel.close({ id: run.id });
      await agentRunTranscriptStore.persist({
        runId: run.id,
        transcript: text,
        observedBytes: Buffer.byteLength(text),
      });
      turns.push(task);
    }
    await AgentWorkspaceModel.create({
      id: turns[0].id,
      organizationId: org.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      workloadName,
      backend: "kubernetes",
      runtimeScope: "test",
      state: "idle",
      lastTaskId: turns[1].id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(ws, {
      userId: owner.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });
    await service.handleMessage(
      {
        type: "subscribe_agent_run_logs",
        payload: { runId: turns[0].id, includeSessionHistory: true },
      },
      ws,
    );
    const messages = vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(
      messages
        .filter(
          (message) =>
            message.type === "agent_run_logs" && !message.payload.channel,
        )
        .map((message) => message.payload.logs)
        .join(""),
    ).toBe("first turn ✓\r\n\u001b[0msecond turn ✓");
    expect(
      messages.find((message) => message.type === "agent_run_logs_ended")
        .payload.truncated,
    ).toBe(false);
    // Asked for the end only, the session sends its last turn and counts the
    // earlier one as left out.
    vi.mocked(ws.send).mockClear();
    await service.handleMessage(
      {
        type: "subscribe_agent_run_logs",
        payload: {
          runId: turns[0].id,
          includeSessionHistory: true,
          tailBytes: 64 * 1024,
        },
      },
      ws,
    );
    const tailMessages = vi
      .mocked(ws.send)
      .mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(
      tailMessages
        .filter((message) => message.type === "agent_run_logs")
        .map((message) => message.payload.logs)
        .join(""),
    ).toBe("second turn ✓");
    expect(tailMessages.at(-1).payload).toMatchObject({
      omittedBytes: Buffer.byteLength("first turn ✓"),
      totalBytes: Buffer.byteLength("first turn ✓second turn ✓"),
    });
    vi.mocked(ws.send).mockClear();
    // Requesting the same session ID never grants another user the owner's accumulated history.
    service.clientContexts.set(ws, {
      userId: other.id,
      organizationId: org.id,
      userIsMcpServerAdmin: false,
    });
    await service.handleMessage(
      {
        type: "subscribe_agent_run_logs",
        payload: { runId: turns[0].id, includeSessionHistory: true },
      },
      ws,
    );
    expect(
      vi
        .mocked(ws.send)
        .mock.calls.map(([value]) => JSON.parse(String(value)))
        .map((message) => message.type),
    ).toEqual(["agent_run_logs_error"]);
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
      workloadName: `agent-run-${task.id}`,
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

  test("attaches only the Project run starter from the stable session URL to the current turn", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });
    const project = await projectService.create({
      organizationId: organization.id,
      userId: owner.id,
      name: "Project run",
      description: null,
    });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "agent",
    });
    const context = await A2AContextModel.create({
      actorKind: "user",
      actorId: owner.id,
    });
    const firstTask = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_COMPLETED",
    });
    const currentTask = await A2ATaskModel.create({
      contextId: context.id,
      agentId: agent.id,
      state: "TASK_STATE_WORKING",
    });
    const workloadName = `project-run-${crypto.randomUUID()}`;
    await AgentRunModel.create({
      organizationId: organization.id,
      taskId: firstTask.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      projectId: project.id,
      workloadName,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    const currentRun = await AgentRunModel.create({
      organizationId: organization.id,
      taskId: currentTask.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      actorUserId: owner.id,
      projectId: project.id,
      workloadName,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      virtualApiKeyId: null,
    });
    await AgentWorkspaceModel.create({
      id: firstTask.id,
      organizationId: organization.id,
      agentId: agent.id,
      actorKind: "user",
      actorId: owner.id,
      workloadName,
      backend: "kubernetes",
      runtimeScope: "archestra-dev",
      state: "active",
      lastTaskId: currentTask.id,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const socket = {
      readyState: WS.OPEN,
      close: vi.fn(),
      on: vi.fn(),
      send: vi.fn(),
    };
    vi.spyOn(agentRuntimeManager, "isEnabled", "get").mockReturnValue(true);
    const attach = vi.spyOn(agentRuntimeManager, "attach").mockResolvedValue({
      podName: "project-run-pod",
      command: "tmux attach",
      socket: socket as never,
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
        type: "subscribe_agent_run_attach",
        payload: { runId: firstTask.id },
      },
      ws,
    );

    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ id: currentRun.id }),
      }),
    );
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "agent_run_attach_started",
        payload: {
          runId: firstTask.id,
          command: "tmux attach",
          resourceName: "project-run-pod",
        },
      }),
    );

    const viewer = await makeUser();
    await makeMember(viewer.id, organization.id, { role: "admin" });
    await shareForTest({
      resource: "project",
      scope: project.id,
      organizationId: organization.id,
      visibility: "organization",
      teamIds: [],
    });
    const viewerWs = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(viewerWs, {
      userId: viewer.id,
      organizationId: organization.id,
      userIsMcpServerAdmin: true,
    });
    attach.mockClear();

    for (const taskId of [firstTask.id, currentTask.id]) {
      await service.handleMessage(
        {
          type: "subscribe_agent_run_attach",
          payload: { runId: taskId },
        },
        viewerWs,
      );

      expect(viewerWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: "agent_run_attach_error",
          payload: {
            runId: taskId,
            error: "Only the person who started this run can attach to it",
          },
        }),
      );
    }
    expect(attach).not.toHaveBeenCalled();
    expect(service.agentRunAttachSubscriptions.has(viewerWs)).toBe(false);
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
    service.lastMcpDeploymentRefreshAt = 0;
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
    await flushDeferredRefresh();

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

  for (const status of ["initializing", "error"] as const)
    test(`sends no statuses while the runtime is ${status}, as the server's attention order assumes`, async ({
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
      vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue(
        { status, mcpServers: {} } as never,
      );
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
        { type: "subscribe_mcp_deployment_statuses", payload: {} },
        ws,
      );
      await flushDeferredRefresh();

      // A "not created" for every install would flag every healthy one.
      const sent = (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([raw]) => JSON.parse(raw as string),
      );
      expect(sent.length).toBeGreaterThan(0);
      for (const message of sent) {
        expect(message.payload.statuses).toEqual({});
      }
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
    await flushDeferredRefresh();

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
    await flushDeferredRefresh();

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
    await flushDeferredRefresh();

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
    await flushDeferredRefresh();

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
    await flushDeferredRefresh();

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
    service.lastMcpDeploymentRefreshAt = 0;
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

  const subscribe = async (ws: WS) => {
    await service.handleMessage(
      { type: "subscribe_mcp_deployment_statuses", payload: {} },
      ws,
    );
    await flushDeferredRefresh();
  };

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

  test("an installation status change reaches a subscriber after the deployment state it was decided on", async ({
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
    // The reinstall stopped the old deployment: the subscriber's last push
    // is the restart gap.
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
    const previousWss = service.wss;
    service.wss = { clients: new Set([ws]) };
    await subscribe(ws);
    const sent = () =>
      (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
        ([raw]) => JSON.parse(raw) as { type: string; payload: never },
      );
    expect(sent()).toHaveLength(1);

    try {
      // The new pod is ready and the reinstall reports success before any
      // watch event has pushed the running state.
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
      websocketService.broadcastMcpInstallationStatus(
        mcpServer.id,
        "success",
        null,
      );

      const [, deployment, installation] = sent();
      expect(deployment).toMatchObject({
        type: "mcp_deployment_statuses",
        payload: { statuses: { [mcpServer.id]: { state: "running" } } },
      });
      expect(installation).toMatchObject({
        type: "mcp_installation_status",
        payload: { serverId: mcpServer.id, status: "success" },
      });
    } finally {
      service.wss = previousWss;
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

  describe("a new subscriber", () => {
    const setup = async (fixtures: {
      makeOrganization: () => Promise<{ id: string }>;
      makeUser: () => Promise<{ id: string }>;
      makeTeam: (orgId: string, userId: string) => Promise<{ id: string }>;
      makeInternalMcpCatalog: (
        overrides: Record<string, unknown>,
      ) => Promise<{ id: string }>;
      makeMcpServer: (
        overrides: Record<string, unknown>,
      ) => Promise<{ id: string }>;
    }) => {
      const org = await fixtures.makeOrganization();
      const user = await fixtures.makeUser();
      const team = await fixtures.makeTeam(org.id, user.id);
      const catalog = await fixtures.makeInternalMcpCatalog({
        serverType: "local",
        organizationId: org.id,
      });
      await fixtures.makeMcpServer({
        scope: "team",
        catalogId: catalog.id,
        ownerId: user.id,
        teamId: team.id,
      });
      const refreshSpy = vi
        .spyOn(McpServerRuntimeManager, "refreshAllStates")
        .mockResolvedValue(undefined);
      vi.spyOn(McpServerRuntimeManager, "statusSummary", "get").mockReturnValue(
        { status: "running", mcpServers: {} },
      );
      const ws = makeWs();
      service.clientContexts.set(ws, {
        userId: user.id,
        organizationId: org.id,
        userIsMcpServerAdmin: true,
      });
      const handle = () =>
        service.handleMessage(
          { type: "subscribe_mcp_deployment_statuses", payload: {} },
          ws,
        );
      return { ws, refreshSpy, handle };
    };

    test("is answered from the summary with no refresh while the watchers keep it current", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const fixtures = {
        makeOrganization,
        makeUser,
        makeTeam,
        makeInternalMcpCatalog,
        makeMcpServer,
      } as unknown as Parameters<typeof setup>[0];
      const { ws, refreshSpy, handle } = await setup(fixtures);
      vi.spyOn(
        McpServerRuntimeManager,
        "deploymentStateWatchersActive",
        "get",
      ).mockReturnValue(true);
      service.lastMcpDeploymentRefreshAt = Date.now();

      await handle();
      await flushDeferredRefresh();

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(refreshSpy).not.toHaveBeenCalled();
    });

    test("is answered from the summary first and refreshed after the handler when the summary may be stale", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const fixtures = {
        makeOrganization,
        makeUser,
        makeTeam,
        makeInternalMcpCatalog,
        makeMcpServer,
      } as unknown as Parameters<typeof setup>[0];
      const { ws, refreshSpy, handle } = await setup(fixtures);
      vi.spyOn(
        McpServerRuntimeManager,
        "deploymentStateWatchersActive",
        "get",
      ).mockReturnValue(false);
      service.lastMcpDeploymentRefreshAt = Date.now() - 5 * 60_000;

      await handle();

      // The handler answered without running the refresh itself.
      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(refreshSpy).not.toHaveBeenCalled();

      await flushDeferredRefresh();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      // Nothing changed, so the push after the refresh sends nothing more.
      expect(ws.send).toHaveBeenCalledTimes(1);
    });

    test("waits for the first refresh when there is no summary yet, and gets it pushed", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const fixtures = {
        makeOrganization,
        makeUser,
        makeTeam,
        makeInternalMcpCatalog,
        makeMcpServer,
      } as unknown as Parameters<typeof setup>[0];
      const { ws, refreshSpy, handle } = await setup(fixtures);
      service.lastMcpDeploymentRefreshAt = 0;

      await handle();

      expect(ws.send).not.toHaveBeenCalled();
      expect(refreshSpy).not.toHaveBeenCalled();

      await flushDeferredRefresh();

      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(ws.send).toHaveBeenCalledTimes(1);
    });
  });

  test("a socket closed before the first refresh answers is dropped and the poller stops", async ({
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

    // No earlier refresh, so there is no cached summary to answer with first.
    service.lastMcpDeploymentRefreshAt = 0;

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    const subscribePromise = subscribe(ws);
    // setTimeout is real in this describe, so waitFor can poll
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalled());

    // The socket closes while the first refresh (after the handler) runs.
    await subscribePromise;
    (ws as { readyState: number }).readyState = WS.CLOSED;
    resolveRefresh?.();
    await flushDeferredRefresh();

    expect(ws.send).not.toHaveBeenCalled();
    expect(service.mcpDeploymentStatusSubscriptions.has(ws)).toBe(false);
    expect(service.mcpDeploymentStatusPollInterval).toBeNull();
  });

  test("answers a re-subscribe from the cached summary without waiting for a slow refresh", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      organizationId: org.id,
    });
    const server = await makeMcpServer({
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
    // An earlier subscriber already filled the summary.
    service.lastMcpDeploymentRefreshAt = Date.now();

    const ws = makeWs();
    service.clientContexts.set(ws, {
      userId: user.id,
      organizationId: org.id,
      userIsMcpServerAdmin: true,
    });

    const subscribePromise = subscribe(ws);
    await vi.waitFor(() => expect(refreshSpy).toHaveBeenCalled());

    // The refresh is still running, yet the client already has statuses.
    expect(ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0],
    );
    expect(sent.type).toBe("mcp_deployment_statuses");
    expect(sent.payload.statuses[server.id]).toBeDefined();

    resolveRefresh?.();
    await subscribePromise;

    // Nothing changed during the refresh, so no duplicate is sent.
    expect(ws.send).toHaveBeenCalledTimes(1);
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

  test("refuses a shell to a member and opens one for an editor", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeMcpServer,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: MEMBER_ROLE_NAME });
    const editor = await makeUser();
    await makeMember(editor.id, org.id, { role: EDITOR_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    // Both can see these installations; only the right to manage
    // installations opens a shell in one.
    const memberServer = await makeMcpServer({
      scope: "org",
      catalogId: catalog.id,
      ownerId: member.id,
    });
    const editorServer = await makeMcpServer({
      scope: "org",
      catalogId: catalog.id,
      ownerId: editor.id,
    });
    const execIntoMcpServer = vi
      .spyOn(McpServerRuntimeManager, "execIntoMcpServer")
      .mockResolvedValue({
        k8sWs: makeMockK8sWs(),
        podName: "mcp-test-pod-abc123",
      });
    vi.spyOn(McpServerRuntimeManager, "getExecCommand").mockReturnValue(
      "kubectl exec -it ...",
    );
    const connect = (userId: string) => {
      const ws = {
        readyState: WS.OPEN,
        send: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      } as unknown as WS;
      service.clientContexts.set(ws, {
        userId,
        organizationId: org.id,
        userIsMcpServerAdmin: false,
      });
      return ws;
    };
    const sent = (ws: WS) =>
      (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
        JSON.parse(call[0] as string),
      );

    const memberWs = connect(member.id);
    await service.handleMessage(
      { type: "subscribe_mcp_exec", payload: { serverId: memberServer.id } },
      memberWs,
    );
    expect(sent(memberWs)).toEqual([
      {
        type: "mcp_exec_error",
        payload: {
          serverId: memberServer.id,
          error: "Opening a shell needs permission to manage MCP servers.",
        },
      },
    ]);
    expect(service.mcpExecSubscriptions.has(memberWs)).toBe(false);
    expect(execIntoMcpServer).not.toHaveBeenCalled();

    const editorWs = connect(editor.id);
    await service.handleMessage(
      { type: "subscribe_mcp_exec", payload: { serverId: editorServer.id } },
      editorWs,
    );
    expect(sent(editorWs)).toContainEqual(
      expect.objectContaining({ type: "mcp_exec_started" }),
    );
    expect(service.mcpExecSubscriptions.has(editorWs)).toBe(true);
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

describe("cross-replica MCP status delivery", () => {
  /**
   * Postgres is the process boundary: each replica's listener connection is a
   * fake that routes `pg_notify` to every connection LISTENing on the
   * channel, including the sender's own, as the real server does.
   */
  class FakePostgres {
    private readonly listeners = new Map<string, Set<FakeConnection>>();

    connect(): PgClient {
      return new FakeConnection(this);
    }

    listen(channel: string, connection: FakeConnection) {
      const set = this.listeners.get(channel) ?? new Set();
      set.add(connection);
      this.listeners.set(channel, set);
    }

    listenerCount(channel: string) {
      return this.listeners.get(channel)?.size ?? 0;
    }

    notify(channel: string, payload: string) {
      for (const connection of this.listeners.get(channel) ?? []) {
        queueMicrotask(() =>
          connection.emit("notification", { channel, payload }),
        );
      }
    }
  }

  class FakeConnection implements PgClient {
    private readonly handlers = new Map<
      string,
      ((...args: unknown[]) => void)[]
    >();

    constructor(private readonly server: FakePostgres) {}

    async connect() {}

    async end() {
      this.emit("end");
    }

    async query(text: string, values?: unknown[]) {
      const listen = text.match(/^LISTEN "(.+)"$/);
      if (listen) {
        this.server.listen(listen[1], this);
      } else if (values) {
        this.server.notify(String(values[0]), String(values[1]));
      }
      return undefined;
    }

    on(event: string, listener: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.handlers.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  type ReplicaInternals = {
    wss: { clients: Set<WS> } | null;
    clientContexts: Map<WS, WebSocketClientContext>;
  };

  async function startReplicas() {
    const postgres = new FakePostgres();
    const replicas = [new WebSocketService(), new WebSocketService()].map(
      (replica) => {
        const send = vi.fn();
        const client = { readyState: WS.OPEN, send } as unknown as WS;
        const internals = replica as unknown as ReplicaInternals;
        internals.wss = { clients: new Set([client]) };
        internals.clientContexts.set(client, {
          userId: "user-1",
          organizationId: "org-1",
          userIsMcpServerAdmin: false,
        });
        replica.enableCrossReplicaDelivery(
          new PostgresNotifyHub("postgres://test", () => postgres.connect()),
        );
        return { replica, internals, send };
      },
    );
    await vi.waitFor(() =>
      expect(postgres.listenerCount("websocket_mcp_events")).toBe(2),
    );
    return replicas;
  }

  function stopReplicas(
    replicas: { replica: WebSocketService; internals: ReplicaInternals }[],
  ) {
    for (const { replica, internals } of replicas) {
      // The fake server has no real sockets to close.
      internals.wss = null;
      replica.stop();
    }
  }

  const sentMessages = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.map(([raw]) => JSON.parse(raw as string));

  test("an install status from one replica reaches clients on every replica exactly once", async () => {
    const replicas = await startReplicas();
    const [origin, other] = replicas;

    try {
      origin.replica.broadcastMcpInstallationStatus(
        "server-1",
        "error",
        "pod failed",
      );

      const expected = {
        type: "mcp_installation_status",
        payload: { serverId: "server-1", status: "error", error: "pod failed" },
      };
      // The installing replica's own clients do not wait on the round trip.
      expect(sentMessages(origin.send)).toEqual([expected]);
      await vi.waitFor(() =>
        expect(sentMessages(other.send)).toEqual([expected]),
      );
      // Let the origin's own echo arrive; it must not deliver a duplicate.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(sentMessages(origin.send)).toEqual([expected]);
    } finally {
      stopReplicas(replicas);
    }
  });

  test("an uninstall from one replica reaches only the affected organization on another", async () => {
    const replicas = await startReplicas();
    const [origin, other] = replicas;
    const foreignSend = vi.fn();
    const foreignClient = {
      readyState: WS.OPEN,
      send: foreignSend,
    } as unknown as WS;
    other.internals.wss?.clients.add(foreignClient);
    other.internals.clientContexts.set(foreignClient, {
      userId: "user-2",
      organizationId: "org-2",
      userIsMcpServerAdmin: false,
    });

    try {
      origin.replica.broadcastMcpServersChanged({
        organizationId: "org-1",
        serverIds: ["server-1"],
      });

      await vi.waitFor(() =>
        expect(sentMessages(other.send)).toEqual([
          {
            type: "mcp_servers_changed",
            payload: {
              change: "uninstalled",
              serverIds: ["server-1"],
              catalogIds: [],
            },
          },
        ]),
      );
      expect(foreignSend).not.toHaveBeenCalled();
    } finally {
      stopReplicas(replicas);
    }
  });

  test("a large validation progress event reaches only its user on another replica, keeping the failing step", async () => {
    const replicas = await startReplicas();
    const [origin, other] = replicas;
    const colleagueSend = vi.fn();
    const colleague = {
      readyState: WS.OPEN,
      send: colleagueSend,
    } as unknown as WS;
    other.internals.wss?.clients.add(colleague);
    other.internals.clientContexts.set(colleague, {
      userId: "user-2",
      organizationId: "org-1",
      userIsMcpServerAdmin: false,
    });
    const steps = Array.from({ length: 300 }, (_, index) => ({
      line: index + 1,
      tool: "mcp/files/read",
      expected: "allow",
      actual: index === 299 ? "deny" : "allow",
      status: index === 299 ? ("failed" as const) : ("passed" as const),
      error: index === 299 ? "x".repeat(10_000) : null,
    }));

    try {
      origin.replica.sendOpenAppaValidationProgress({
        userId: "user-1",
        organizationId: "org-1",
        payload: {
          token: "token-1",
          phase: "file_finished",
          path: "traces/long.appa",
          status: "failed",
          assertionCount: 300,
          durationMs: 12,
          error: null,
          steps,
        },
      });

      await vi.waitFor(() => expect(other.send).toHaveBeenCalledTimes(1));
      const [message] = sentMessages(other.send);
      expect(message).toMatchObject({
        type: "openappa_validation_progress",
        payload: {
          token: "token-1",
          phase: "file_finished",
          assertionCount: 300,
        },
      });
      const relayed = message.payload.steps as typeof steps;
      expect(relayed.length).toBeGreaterThan(0);
      expect(relayed.length).toBeLessThan(steps.length);
      expect(relayed.at(-1)).toMatchObject({ line: 300, status: "failed" });
      expect(relayed.at(-1)?.error?.length).toBeLessThanOrEqual(500);
      expect(relayed.map((step) => step.line)).toEqual(
        relayed.map((step) => step.line).toSorted((a, b) => a - b),
      );
      expect(colleagueSend).not.toHaveBeenCalled();
    } finally {
      stopReplicas(replicas);
    }
  });
});

/**
 * A new deployment-status subscriber's refresh runs after the subscribe
 * handler returns (setImmediate), then pushes; let both finish.
 */
async function flushDeferredRefresh() {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** An ended run with a small complete recording, and a client subscribed as its owner. */
async function makeEndedRunWithRecording(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  makeAgent: (params: { organizationId: string }) => Promise<{ id: string }>;
}) {
  const organization = await fixtures.makeOrganization();
  const owner = await fixtures.makeUser();
  const agent = await fixtures.makeAgent({ organizationId: organization.id });
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
    workloadName: `agent-run-${task.id}`,
    backend: "kubernetes",
    runtimeScope: "archestra-dev",
    virtualApiKeyId: null,
  });
  await AgentRunModel.close({ id: run.id, logs: "final tail\n" });
  const recording = `${"recorded line\n".repeat(200)}done ✓\n`;
  await agentRunTranscriptStore.persist({
    runId: run.id,
    transcript: recording,
    observedBytes: Buffer.byteLength(recording),
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
  return { ws, task, run, owner, organization, recording };
}
