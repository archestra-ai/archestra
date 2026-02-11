import { createServer } from "node:http";
import type { ClientWebSocketMessage } from "@shared";
import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import type * as originalConfigModule from "@/config";
import AgentModel from "@/models/agent";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      features: {
        ...actual.default.features,
        browserStreamingEnabled: true,
      },
    },
  };
});

const { browserStreamFeature } = await import(
  "@/features/browser-stream/services/browser-stream.feature"
);
const { default: websocketService } = await import("@/websocket");

const httpServer = createServer();

const service = websocketService as unknown as {
  handleMessage: (message: ClientWebSocketMessage, ws: WS) => Promise<void>;
  clientContexts: Map<
    WS,
    { userId: string; organizationId: string; userIsProfileAdmin: boolean }
  >;
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
      userIsProfileAdmin: false,
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

  test("click sends an immediate screenshot update", async ({
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
      userIsProfileAdmin: false,
    });

    vi.spyOn(browserStreamFeature, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });
    vi.spyOn(browserStreamFeature, "takeScreenshot").mockResolvedValue({
      screenshot: "img",
      url: "http://example.com",
    });
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
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "browser_screenshot",
        payload: {
          conversationId: conversation.id,
          screenshot: "img",
          url: "http://example.com",
          canGoBack: true,
        },
      }),
    );

    service.browserStreamContext.unsubscribeBrowserStream(ws);
  });
});
