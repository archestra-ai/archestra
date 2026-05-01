import { vi } from "vitest";
import { createFastifyInstance } from "@/server";
import { describe, expect, test } from "@/test";
import chatopsRoutes from "./chatops";

const {
  listSummariesMock,
  startAdapterMock,
  stopAdapterMock,
  getSummaryMock,
  getConnectionPageConfigMock,
} = vi.hoisted(() => ({
  listSummariesMock: vi.fn(),
  startAdapterMock: vi.fn(),
  stopAdapterMock: vi.fn(),
  getSummaryMock: vi.fn(),
  getConnectionPageConfigMock: vi.fn(),
}));

vi.mock("@/agents/chatops/bundled-generic-adapter-runtime-manager", () => ({
  bundledGenericAdapterRuntimeManager: {
    initialize: vi.fn(),
    cleanup: vi.fn(),
    listSummaries: listSummariesMock,
    startAdapter: startAdapterMock,
    stopAdapter: stopAdapterMock,
    getSummary: getSummaryMock,
    getConnectionPageConfig: getConnectionPageConfigMock,
  },
}));

vi.mock("@/agents/chatops/chatops-manager", () => ({
  chatOpsManager: {
    reinitialize: vi.fn(),
    getMSTeamsProvider: vi.fn(() => null),
    getSlackProvider: vi.fn(() => null),
    getChatOpsProvider: vi.fn(() => null),
    processMessage: vi.fn(),
    getAccessibleChatopsAgents: vi.fn(() => []),
    discoverChannels: vi.fn(),
  },
}));

vi.mock("botframework-connector", () => ({
  MicrosoftAppCredentials: class {
    getToken() {
      return Promise.resolve("mock-token");
    }
  },
}));

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    auth = { test: () => Promise.resolve({ ok: true }) };
    apps = {
      connections: { open: () => Promise.resolve({ ok: true }) },
    };
  },
}));

const baseAdapterSummary = {
  adapterId: "whatsapp",
  displayName: "WhatsApp",
  description: "Run the bundled WhatsApp ChatOps adapter process.",
  status: "stopped",
  pid: null,
  lastStartedAt: null,
  lastExitAt: null,
  errorMessage: null,
  hasConnectionPage: true,
};

describe("bundled ChatOps adapter routes", () => {
  test("GET /api/chatops/generic/builtin-adapters returns bundled adapter summaries", async () => {
    listSummariesMock.mockReturnValueOnce([baseAdapterSummary]);

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/chatops/generic/builtin-adapters",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      adapters: [baseAdapterSummary],
    });

    await app.close();
  });

  test("POST /api/chatops/generic/builtin-adapters/:adapterId/start starts the adapter", async () => {
    startAdapterMock.mockResolvedValueOnce({
      ...baseAdapterSummary,
      status: "running",
      pid: 4242,
      lastStartedAt: "2026-05-01T12:00:00.000Z",
    });

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/generic/builtin-adapters/whatsapp/start",
    });

    expect(response.statusCode).toBe(200);
    expect(startAdapterMock).toHaveBeenCalledWith("whatsapp");
    expect(response.json()).toEqual({
      ...baseAdapterSummary,
      status: "running",
      pid: 4242,
      lastStartedAt: "2026-05-01T12:00:00.000Z",
    });

    await app.close();
  });

  test("POST /api/chatops/generic/builtin-adapters/:adapterId/stop stops the adapter", async () => {
    stopAdapterMock.mockResolvedValueOnce({
      ...baseAdapterSummary,
      status: "stopped",
    });

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/chatops/generic/builtin-adapters/whatsapp/stop",
    });

    expect(response.statusCode).toBe(200);
    expect(stopAdapterMock).toHaveBeenCalledWith("whatsapp");
    expect(response.json()).toEqual({
      ...baseAdapterSummary,
      status: "stopped",
    });

    await app.close();
  });

  test("GET connection-page returns 503 when adapter is not running", async () => {
    getConnectionPageConfigMock.mockReturnValueOnce({ port: 3100 });
    getSummaryMock.mockReturnValueOnce({
      ...baseAdapterSummary,
      status: "stopped",
    });

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/chatops/generic/builtin-adapters/whatsapp/connection-page",
    });

    expect(response.statusCode).toBe(503);

    await app.close();
  });

  test("GET connection-page returns 404 when adapter has no connection page config", async () => {
    getConnectionPageConfigMock.mockReturnValueOnce(null);

    const app = createFastifyInstance();
    await app.register(chatopsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/chatops/generic/builtin-adapters/whatsapp/connection-page",
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
