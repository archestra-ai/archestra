import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import type * as originalConfigModule from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import type { WebSocketMessage } from "@/types";

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
  "@/services/browser-stream-feature"
);
const { default: websocketService } = await import("@/websocket");

const service = websocketService as unknown as {
  handleMessage: (message: WebSocketMessage, ws: WS) => Promise<void>;
  clientContexts: Map<
    WS,
    { userId: string; organizationId: string; userIsProfileAdmin: boolean }
  >;
  browserSubscriptions: Map<WS, { intervalId: NodeJS.Timeout }>;
};

describe("websocket browser-stream screenshot handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
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

    const subscription = service.browserSubscriptions.get(ws);
    if (subscription) {
      clearInterval(subscription.intervalId);
    }
  });
});
