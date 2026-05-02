import { vi } from "vitest";
import { createFastifyInstance } from "@/server";
import { ApiError } from "@/types";
import { describe, expect, test } from "@/test";
import chatopsGenericRoutes from "./chatops-generic";

const {
  getCatalogEntryMock,
  getSummaryMock,
  handleIncomingMessageMock,
  handleInteractiveSelectionMock,
  isRateLimitedMock,
  getAccessibleChatopsAgentsMock,
} = vi.hoisted(() => ({
  getCatalogEntryMock: vi.fn(),
  getSummaryMock: vi.fn(),
  handleIncomingMessageMock: vi.fn(),
  handleInteractiveSelectionMock: vi.fn(),
  isRateLimitedMock: vi.fn().mockResolvedValue(false),
  getAccessibleChatopsAgentsMock: vi.fn().mockResolvedValue([]),
}));

vi.mock(
  "@/agents/chatops/bundled-generic-adapter-runtime-manager",
  () => ({
    bundledGenericAdapterRuntimeManager: {
      initialize: vi.fn(),
      cleanup: vi.fn(),
      getCatalogEntry: getCatalogEntryMock,
      getSummary: getSummaryMock,
    },
  }),
);

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    handleIncomingMessage: handleIncomingMessageMock.mockResolvedValue(
      undefined,
    ),
    handleInteractiveSelection: handleInteractiveSelectionMock.mockResolvedValue(
      undefined,
    ),
    getAccessibleChatopsAgents: getAccessibleChatopsAgentsMock,
  },
}));

vi.mock("@/agents/utils", () => ({
  isRateLimited: isRateLimitedMock,
}));

function setupRunningAdapter(adapterId = "whatsapp") {
  getCatalogEntryMock.mockReturnValue({
    adapterId,
    displayName: "WhatsApp",
    connectionPage: { port: 3100 },
  });
  getSummaryMock.mockReturnValue({ status: "running" });
}

function setupStoppedAdapter(adapterId = "whatsapp") {
  getCatalogEntryMock.mockReturnValue({
    adapterId,
    displayName: "WhatsApp",
  });
  getSummaryMock.mockReturnValue({ status: "stopped" });
}

function setupUnknownAdapter() {
  getCatalogEntryMock.mockImplementation(() => {
    throw new ApiError(404, "Unknown bundled adapter unknown-adapter");
  });
  getSummaryMock.mockImplementation(() => {
    throw new ApiError(404, "Unknown bundled adapter unknown-adapter");
  });
}

const validMessagePayload = {
  schemaVersion: "v1",
  messageId: "msg-001",
  sender: {
    externalId: "user-42",
    name: "Alice",
    email: "alice@example.com",
  },
  channel: {
    externalId: "ch-99",
    name: "general",
    kind: "channel",
  },
  workspace: {
    externalId: "ws-1",
    name: "Acme",
  },
  text: "Hello bot",
  rawText: "Hello bot",
  timestamp: new Date().toISOString(),
  isThreadReply: false,
  replyContext: null,
};

const validInteractivePayload = {
  schemaVersion: "v1",
  eventId: "evt-001",
  action: "select-agent",
  agentId: "00000000-0000-0000-0000-000000000000",
  sender: {
    externalId: "user-42",
    name: "Alice",
  },
  channel: {
    externalId: "ch-99",
    kind: "channel",
  },
  timestamp: new Date().toISOString(),
  replyContext: null,
};

const validChannelSyncPayload = {
  schemaVersion: "v1",
  syncMode: "full",
  workspace: {
    externalId: "ws-1",
    name: "Acme",
  },
  channels: [
    { externalId: "ch-a", name: "Alpha", kind: "channel" },
    { externalId: "ch-b", kind: "dm" },
  ],
};

describe("ChatOps generic webhook routes", () => {
  test("POST /messages returns 202 with valid payload", async () => {
    setupRunningAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/messages",
      payload: validMessagePayload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, asynchronous: true });
    expect(handleIncomingMessageMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  test("POST /messages returns 404 for unknown adapterId", async () => {
    setupUnknownAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/unknown-adapter/messages",
      payload: validMessagePayload,
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  test("POST /messages returns 503 for stopped adapter", async () => {
    setupStoppedAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/messages",
      payload: validMessagePayload,
    });

    expect(response.statusCode).toBe(503);

    await app.close();
  });

  test("POST /messages returns 400 for invalid payload", async () => {
    setupRunningAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/messages",
      payload: { schemaVersion: "invalid" },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  test("POST /interactive returns 202 with valid payload", async () => {
    setupRunningAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/interactive",
      payload: validInteractivePayload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true, asynchronous: true });
    expect(handleInteractiveSelectionMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  test("POST /interactive returns 404 for unknown adapterId", async () => {
    setupUnknownAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/unknown-adapter/interactive",
      payload: validInteractivePayload,
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  test("POST /interactive returns 503 for stopped adapter", async () => {
    setupStoppedAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/interactive",
      payload: validInteractivePayload,
    });

    expect(response.statusCode).toBe(503);

    await app.close();
  });

  test("POST /interactive returns 400 for invalid payload", async () => {
    setupRunningAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/interactive",
      payload: { action: "bad" },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  test("POST /channels/sync returns 200 and syncs channels", async () => {
    setupRunningAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/channels/sync",
      payload: validChannelSyncPayload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.upserted).toBe(2);
    expect(body.deleted).toBe(0);

    await app.close();
  });

  test("POST /channels/sync returns 404 for unknown adapterId", async () => {
    setupUnknownAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/unknown-adapter/channels/sync",
      payload: validChannelSyncPayload,
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  test("POST /channels/sync returns 503 for stopped adapter", async () => {
    setupStoppedAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/channels/sync",
      payload: validChannelSyncPayload,
    });

    expect(response.statusCode).toBe(503);

    await app.close();
  });

  test("POST /channels/sync returns 400 for invalid payload", async () => {
    setupRunningAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/channels/sync",
      payload: { channels: "not-an-array" },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  test("POST /messages returns 429 when rate limited", async () => {
    setupRunningAdapter();
    isRateLimitedMock.mockResolvedValueOnce(true);

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/chatops/generic/whatsapp/messages",
      payload: validMessagePayload,
    });

    expect(response.statusCode).toBe(429);

    await app.close();
  });

  test("GET /agents returns 200 with agents list", async () => {
    setupRunningAdapter();
    getAccessibleChatopsAgentsMock.mockResolvedValueOnce([
      { id: "agent-1", name: "Agent Alpha" },
      { id: "agent-2", name: "Agent Beta" },
    ]);

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/webhooks/chatops/generic/whatsapp/agents",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [
        { id: "agent-1", name: "Agent Alpha" },
        { id: "agent-2", name: "Agent Beta" },
      ],
    });

    await app.close();
  });

  test("GET /agents returns 404 for unknown adapterId", async () => {
    setupUnknownAdapter();

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/webhooks/chatops/generic/unknown-adapter/agents",
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  test("GET /agents passes senderEmail and isDm to getAccessibleChatopsAgents", async () => {
    setupRunningAdapter();
    getAccessibleChatopsAgentsMock.mockResolvedValueOnce([]);

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/webhooks/chatops/generic/whatsapp/agents?senderEmail=test@example.com&isDm=true",
    });

    expect(response.statusCode).toBe(200);
    expect(getAccessibleChatopsAgentsMock).toHaveBeenCalledWith({
      senderEmail: "test@example.com",
      isDm: true,
    });

    await app.close();
  });

  test("GET /agents returns 429 when rate limited", async () => {
    setupRunningAdapter();
    isRateLimitedMock.mockResolvedValueOnce(true);

    const app = createFastifyInstance();
    await app.register(chatopsGenericRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/webhooks/chatops/generic/whatsapp/agents",
    });

    expect(response.statusCode).toBe(429);

    await app.close();
  });
});
