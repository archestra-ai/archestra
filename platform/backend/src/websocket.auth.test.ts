import type { IncomingMessage } from "node:http";
import { vi } from "vitest";
import { WebSocket as WS } from "ws";
import { betterAuth } from "@/auth";
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
  authenticateConnection: (
    request: IncomingMessage,
  ) => Promise<{ userId: string; organizationId: string } | null>;
  handleMessage: (message: WebSocketMessage, ws: WS) => Promise<void>;
  clientContexts: Map<WS, { userId: string; organizationId: string }>;
  browserSubscriptions: Map<WS, unknown>;
};

describe("websocket browser-stream authorization", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();
    service.browserSubscriptions.clear();
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
