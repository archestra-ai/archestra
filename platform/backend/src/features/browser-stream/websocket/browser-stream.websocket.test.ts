import { createServer } from "node:http";
import type { ClientWebSocketMessage } from "@archestra/shared";
import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import AgentModel from "@/models/agent";
import OrganizationModel from "@/models/organization";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import websocketService from "@/websocket";

const httpServer = createServer();

const service = websocketService as unknown as {
  handleMessage: (message: ClientWebSocketMessage, ws: WS) => Promise<void>;
  clientContexts: Map<WS, { userId: string; organizationId: string }>;
  browserStreamContext: {
    clearSubscriptions: () => void;
    unsubscribeBrowserStream: (ws: WS) => void;
  };
};

describe("websocket browser-stream screenshot handling", () => {
  beforeAll(() => {
    websocketService.start(httpServer);
  });

  afterAll(() => {
    websocketService.stop();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserStreamContext.clearSubscriptions();
    // Mock Playwright tools as assigned so browser stream tests can proceed
    vi.spyOn(AgentModel, "hasPlaywrightToolsAssigned").mockResolvedValue(true);
  });

  test("rejects browser subscriptions while policy is disabled", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await OrganizationModel.patch(org.id, { playwrightMcpEnabled: false });
    const ws = {
      readyState: WS.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as unknown as WS;
    service.clientContexts.set(ws, { userId: user.id, organizationId: org.id });
    const selectTab = vi.spyOn(browserStreamFeature, "selectOrCreateTab");
    await service.handleMessage(
      {
        type: "subscribe_browser_stream",
        payload: { conversationId: "disabled-conversation" },
      },
      ws,
    );
    expect(selectTab).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("disabled"));
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

    service.browserStreamContext.unsubscribeBrowserStream(ws);
  });

  test("click streams a quick frame, then a settled one", async ({
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
    });

    vi.spyOn(browserStreamFeature, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });
    const takeScreenshot = vi
      .spyOn(browserStreamFeature, "takeScreenshot")
      .mockImplementation(async (_agentId, _conversationId, _user, options) =>
        options?.fast
          ? { screenshot: "quick" }
          : { screenshot: "img", url: "http://example.com" },
      );
    vi.spyOn(browserStreamFeature, "click").mockResolvedValue({
      success: true,
    });

    await service.handleMessage(
      {
        type: "subscribe_browser_stream",
        payload: { conversationId: conversation.id },
      },
      ws,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    const sendMock = ws.send as unknown as { mockClear: () => void };
    sendMock.mockClear();

    await service.handleMessage(
      {
        type: "browser_click",
        payload: { conversationId: conversation.id, x: 10, y: 10 },
      },
      ws,
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "browser_click_result",
        payload: {
          conversationId: conversation.id,
          success: true,
          error: undefined,
        },
      }),
    );
    takeScreenshot.mockClear();
    // Quick frame shortly after the click, settled frame once input pauses
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(
      takeScreenshot.mock.calls.map(([, , , options]) => !!options?.fast),
    ).toEqual([true, false]);
    const frames = (
      ws.send as unknown as { mock: { calls: string[][] } }
    ).mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((m) => m.type === "browser_screenshot")
      .map((m) => m.payload);
    expect(frames).toEqual([
      { conversationId: conversation.id, screenshot: "quick" },
      {
        conversationId: conversation.id,
        screenshot: "img",
        url: "http://example.com",
        canGoBack: true,
      },
    ]);

    service.browserStreamContext.unsubscribeBrowserStream(ws);
  });
});
