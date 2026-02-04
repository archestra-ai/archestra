import type { ServerWebSocketMessage } from "@shared";
import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS } from "ws";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import type { BrowserUserContext } from "@/features/browser-stream/services/browser-stream.service";
import { browserStateManager } from "@/features/browser-stream/services/browser-stream.state-manager";
import logger from "@/logging";
import { ConversationModel } from "@/models";

const SCREENSHOT_INTERVAL_MS = 2_000; // Stream at ~0.5 FPS (every 2 seconds)

/**
 * Debounce interval for orphan tab cleanup.
 * Only run cleanup once per minute per agent to avoid excessive overhead.
 */
const ORPHAN_CLEANUP_DEBOUNCE_MS = 60_000;

/**
 * Maximum number of entries in the lastOrphanCleanupTime map.
 * When exceeded, oldest entries are removed.
 */
const MAX_CLEANUP_TIME_ENTRIES = 100;

export type BrowserStreamSubscription = {
  conversationId: string;
  agentId: string;
  userContext: BrowserUserContext;
  intervalId: NodeJS.Timeout;
  isSending: boolean;
};

type BrowserStreamClientContextParams = {
  wss: WebSocketServer | null;
  sendToClient: (ws: WebSocket, message: ServerWebSocketMessage) => void;
};

export class BrowserStreamSocketClientContext {
  private wss: WebSocketServer | null;
  private browserSubscriptions = new Map<
    WebSocket,
    BrowserStreamSubscription
  >();
  private sendToClient: BrowserStreamClientContextParams["sendToClient"];
  private screenshotIntervalMs = SCREENSHOT_INTERVAL_MS;
  /** Track last orphan cleanup time per agent to debounce cleanup calls */
  private lastOrphanCleanupTime = new Map<string, number>();

  constructor(params: BrowserStreamClientContextParams) {
    this.wss = params.wss;
    this.sendToClient = params.sendToClient;
  }

  setServer(wss: WebSocketServer | null) {
    this.wss = wss;
  }

  static isBrowserStreamEnabled(): boolean {
    return browserStreamFeature.isEnabled();
  }

  isBrowserStreamEnabled(): boolean {
    return BrowserStreamSocketClientContext.isBrowserStreamEnabled();
  }

  static isBrowserWebSocketMessage(messageType: string): boolean {
    return browserStreamFeature.isBrowserWebSocketMessage(messageType);
  }

  isBrowserWebSocketMessage(messageType: string): boolean {
    return BrowserStreamSocketClientContext.isBrowserWebSocketMessage(
      messageType,
    );
  }

  /**
   * Handle browser WebSocket messages
   * Returns true if message was handled, false otherwise
   */
  async handleMessage(
    message: { type: string; payload?: unknown },
    ws: WebSocket,
    clientContext: {
      userId: string;
      organizationId: string;
      userIsProfileAdmin: boolean;
    },
  ): Promise<boolean> {
    if (!this.isBrowserWebSocketMessage(message.type)) {
      return false;
    }

    const payload = message.payload as Record<string, unknown> | undefined;
    const conversationId =
      payload && typeof payload.conversationId === "string"
        ? payload.conversationId
        : "";

    if (!this.isBrowserStreamEnabled()) {
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId,
          error: "Browser streaming feature is disabled",
        },
      });
      return true;
    }

    switch (message.type) {
      case "subscribe_browser_stream":
        await this.handleSubscribeBrowserStream(
          ws,
          conversationId,
          clientContext,
        );
        return true;

      case "unsubscribe_browser_stream":
        this.unsubscribeBrowserStream(ws);
        return true;

      case "browser_navigate":
        await this.handleBrowserNavigate(
          ws,
          conversationId,
          typeof payload?.url === "string" ? payload.url : "",
        );
        return true;

      case "browser_navigate_back":
        await this.handleBrowserNavigateBack(ws, conversationId);
        return true;

      case "browser_navigate_forward":
        await this.handleBrowserNavigateForward(ws, conversationId);
        return true;

      case "browser_click":
        await this.handleBrowserClick(
          ws,
          conversationId,
          typeof payload?.element === "string" ? payload.element : undefined,
          typeof payload?.x === "number" ? payload.x : undefined,
          typeof payload?.y === "number" ? payload.y : undefined,
        );
        return true;

      case "browser_type":
        await this.handleBrowserType(
          ws,
          conversationId,
          typeof payload?.text === "string" ? payload.text : "",
          typeof payload?.element === "string" ? payload.element : undefined,
        );
        return true;

      case "browser_press_key":
        await this.handleBrowserPressKey(
          ws,
          conversationId,
          typeof payload?.key === "string" ? payload.key : "",
        );
        return true;

      case "browser_get_snapshot":
        await this.handleBrowserGetSnapshot(ws, conversationId);
        return true;

      default:
        logger.warn({ message }, "Unknown browser WebSocket message type");
        return false;
    }
  }

  hasSubscription(ws: WebSocket): boolean {
    return this.browserSubscriptions.has(ws);
  }

  getSubscription(ws: WebSocket): BrowserStreamSubscription | undefined {
    return this.browserSubscriptions.get(ws);
  }

  clearSubscriptions(): void {
    for (const ws of this.browserSubscriptions.keys()) {
      this.unsubscribeBrowserStream(ws);
    }
  }

  stop(): void {
    if (this.wss) {
      for (const ws of this.wss.clients) {
        this.unsubscribeBrowserStream(ws);
      }
      return;
    }

    this.clearSubscriptions();
  }

  unsubscribeBrowserStream(ws: WebSocket): void {
    const subscription = this.browserSubscriptions.get(ws);
    if (subscription) {
      clearInterval(subscription.intervalId);
      this.browserSubscriptions.delete(ws);
      logger.info(
        {
          conversationId: subscription.conversationId,
          agentId: subscription.agentId,
        },
        "Browser stream client unsubscribed",
      );
    }
  }

  async handleSubscribeBrowserStream(
    ws: WebSocket,
    conversationId: string,
    clientContext: {
      userId: string;
      organizationId: string;
      userIsProfileAdmin: boolean;
    },
  ): Promise<void> {
    // Unsubscribe from any existing stream first (for this WebSocket)
    this.unsubscribeBrowserStream(ws);

    // Get agentId from conversation with user/org scoping
    const agentId = await ConversationModel.getAgentIdForUser(
      conversationId,
      clientContext.userId,
      clientContext.organizationId,
    );
    if (!agentId) {
      logger.warn(
        {
          conversationId,
          userId: clientContext.userId,
          organizationId: clientContext.organizationId,
        },
        "Unauthorized or missing conversation for browser stream",
      );
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId,
          error: "Conversation not found",
        },
      });
      return;
    }

    // Unsubscribe any OTHER WebSocket that's subscribed to a DIFFERENT conversation for this agent
    // This prevents multiple conversations competing for the same browser (tab switching/flickering)
    // Same conversation can have multiple viewers (e.g., side panel + new tab) - those are fine
    const subscriptionsToUnsubscribe: WebSocket[] = [];
    for (const [
      existingWs,
      existingSub,
    ] of this.browserSubscriptions.entries()) {
      if (
        existingSub.agentId === agentId &&
        existingSub.conversationId !== conversationId &&
        existingWs !== ws
      ) {
        subscriptionsToUnsubscribe.push(existingWs);
      }
    }
    for (const existingWs of subscriptionsToUnsubscribe) {
      const existingSub = this.browserSubscriptions.get(existingWs);
      logger.info(
        {
          agentId,
          oldConversationId: existingSub?.conversationId,
          newConversationId: conversationId,
        },
        "Unsubscribing previous browser stream for agent (new conversation taking over)",
      );
      this.unsubscribeBrowserStream(existingWs);
    }

    logger.info(
      { conversationId, agentId },
      "Browser stream client subscribed",
    );

    const userContext: BrowserUserContext = {
      userId: clientContext.userId,
      userIsProfileAdmin: clientContext.userIsProfileAdmin,
    };

    // Select or create the tab for this conversation
    const tabResult = await browserStreamFeature.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      logger.warn(
        { conversationId, agentId, error: tabResult.error },
        "Failed to select/create browser tab",
      );
      // Continue anyway - screenshot will work on current tab
    }

    // Send initial screenshot
    const sendTick = async () => {
      const subscription = this.browserSubscriptions.get(ws);
      if (!subscription) return;
      if (subscription.isSending) return;

      subscription.isSending = true;
      try {
        await this.sendScreenshot(ws, agentId, conversationId, userContext);
      } finally {
        subscription.isSending = false;
      }
    };

    // Set up interval for continuous streaming
    const intervalId = setInterval(() => {
      if (ws.readyState === WS.OPEN) {
        void sendTick();
      } else {
        this.unsubscribeBrowserStream(ws);
      }
    }, this.screenshotIntervalMs);

    // Store subscription
    this.browserSubscriptions.set(ws, {
      conversationId,
      agentId,
      userContext,
      intervalId,
      isSending: false,
    });

    void sendTick();

    // Trigger background orphan cleanup (debounced, fire-and-forget)
    this.maybeCleanupOrphanedTabs(agentId, userContext);
  }

  /**
   * Trigger orphan tab cleanup if enough time has passed since last cleanup.
   * This is fire-and-forget - errors are logged but don't affect the caller.
   */
  private maybeCleanupOrphanedTabs(
    agentId: string,
    userContext: BrowserUserContext,
  ): void {
    const lastCleanup = this.lastOrphanCleanupTime.get(agentId) ?? 0;
    const now = Date.now();

    if (now - lastCleanup < ORPHAN_CLEANUP_DEBOUNCE_MS) {
      // Skip - cleaned up recently
      return;
    }

    // Limit map size to prevent unbounded growth
    if (this.lastOrphanCleanupTime.size >= MAX_CLEANUP_TIME_ENTRIES) {
      // Remove oldest entries (first entries in map iteration order)
      const entriesToRemove = Math.ceil(MAX_CLEANUP_TIME_ENTRIES / 4);
      let removed = 0;
      for (const key of this.lastOrphanCleanupTime.keys()) {
        if (removed >= entriesToRemove) break;
        this.lastOrphanCleanupTime.delete(key);
        removed++;
      }
    }

    this.lastOrphanCleanupTime.set(agentId, now);

    // Fire and forget - don't await
    void browserStreamFeature
      .cleanupOrphanedTabs(agentId, userContext)
      .catch((error) => {
        logger.warn(
          { agentId, error },
          "Background orphan tab cleanup failed (non-fatal)",
        );
      });
  }

  async handleBrowserNavigate(
    ws: WebSocket,
    conversationId: string,
    url: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_navigate_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.navigate(
        subscription.agentId,
        conversationId,
        url,
        subscription.userContext,
      );

      this.sendToClient(ws, {
        type: "browser_navigate_result",
        payload: {
          conversationId,
          success: result.success,
          url: result.url,
          error: result.error,
        },
      });

      if (result.success) {
        await this.sendImmediateScreenshot(ws, conversationId);
      }
    } catch (error) {
      logger.error({ error, conversationId, url }, "Browser navigation failed");
      this.sendToClient(ws, {
        type: "browser_navigate_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Navigation failed",
        },
      });
    }
  }

  async handleBrowserNavigateBack(
    ws: WebSocket,
    conversationId: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_navigate_back_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.navigateBack(
        subscription.agentId,
        conversationId,
        subscription.userContext,
      );

      this.sendToClient(ws, {
        type: "browser_navigate_back_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });

      if (result.success) {
        await this.sendImmediateScreenshot(ws, conversationId);
      }
    } catch (error) {
      logger.error({ error, conversationId }, "Browser navigate back failed");
      this.sendToClient(ws, {
        type: "browser_navigate_back_result",
        payload: {
          conversationId,
          success: false,
          error:
            error instanceof Error ? error.message : "Navigate back failed",
        },
      });
    }
  }

  async handleBrowserNavigateForward(
    ws: WebSocket,
    conversationId: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_navigate_forward_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.navigateForward(
        subscription.agentId,
        conversationId,
        subscription.userContext,
      );

      this.sendToClient(ws, {
        type: "browser_navigate_forward_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });

      if (result.success) {
        await this.sendImmediateScreenshot(ws, conversationId);
      }
    } catch (error) {
      logger.error(
        { error, conversationId },
        "Browser navigate forward failed",
      );
      this.sendToClient(ws, {
        type: "browser_navigate_forward_result",
        payload: {
          conversationId,
          success: false,
          error:
            error instanceof Error ? error.message : "Navigate forward failed",
        },
      });
    }
  }

  async handleBrowserClick(
    ws: WebSocket,
    conversationId: string,
    element?: string,
    x?: number,
    y?: number,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_click_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.click(
        subscription.agentId,
        conversationId,
        subscription.userContext,
        element,
        x,
        y,
      );
      this.sendToClient(ws, {
        type: "browser_click_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });

      if (result.success) {
        await this.sendImmediateScreenshot(ws, conversationId);
      }
    } catch (error) {
      logger.error(
        { error, conversationId, element, x, y },
        "Browser click failed",
      );
      this.sendToClient(ws, {
        type: "browser_click_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Click failed",
        },
      });
    }
  }

  async handleBrowserType(
    ws: WebSocket,
    conversationId: string,
    text: string,
    element?: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_type_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.type(
        subscription.agentId,
        conversationId,
        subscription.userContext,
        text,
        element,
      );
      this.sendToClient(ws, {
        type: "browser_type_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });

      if (result.success) {
        await this.sendImmediateScreenshot(ws, conversationId);
      }
    } catch (error) {
      logger.error({ error, conversationId }, "Browser type failed");
      this.sendToClient(ws, {
        type: "browser_type_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Type failed",
        },
      });
    }
  }

  async handleBrowserPressKey(
    ws: WebSocket,
    conversationId: string,
    key: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_press_key_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.pressKey(
        subscription.agentId,
        conversationId,
        subscription.userContext,
        key,
      );
      this.sendToClient(ws, {
        type: "browser_press_key_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });

      if (result.success) {
        await this.sendImmediateScreenshot(ws, conversationId);
      }
    } catch (error) {
      logger.error({ error, conversationId, key }, "Browser press key failed");
      this.sendToClient(ws, {
        type: "browser_press_key_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Press key failed",
        },
      });
    }
  }

  async handleBrowserGetSnapshot(
    ws: WebSocket,
    conversationId: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_snapshot",
        payload: {
          conversationId,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    try {
      const result = await browserStreamFeature.getSnapshot(
        subscription.agentId,
        conversationId,
        subscription.userContext,
      );
      this.sendToClient(ws, {
        type: "browser_snapshot",
        payload: {
          conversationId,
          snapshot: result.snapshot,
          error: result.error,
        },
      });
    } catch (error) {
      logger.error({ error, conversationId }, "Browser get snapshot failed");
      this.sendToClient(ws, {
        type: "browser_snapshot",
        payload: {
          conversationId,
          error: error instanceof Error ? error.message : "Snapshot failed",
        },
      });
    }
  }

  private async sendScreenshot(
    ws: WebSocket,
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<void> {
    if (ws.readyState !== WS.OPEN) {
      return;
    }

    try {
      const result = await browserStreamFeature.takeScreenshot(
        agentId,
        conversationId,
        userContext,
      );

      if (result.screenshot) {
        // Get navigation state for back/forward buttons
        let canGoBack = false;
        let canGoForward = false;

        const stateResult = await browserStateManager.getOrLoad({
          agentId,
          userId: userContext.userId,
          conversationId,
        });

        if (stateResult.tag === "Ok" && stateResult.value) {
          const state = stateResult.value;
          const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
          if (activeTab) {
            canGoBack = activeTab.historyCursor > 0;
            canGoForward =
              activeTab.historyCursor < activeTab.history.length - 1;
          }
        }

        this.sendToClient(ws, {
          type: "browser_screenshot",
          payload: {
            conversationId,
            screenshot: result.screenshot,
            url: result.url,
            viewportWidth: result.viewportWidth,
            viewportHeight: result.viewportHeight,
            canGoBack,
            canGoForward,
          },
        });
      } else {
        this.sendToClient(ws, {
          type: "browser_stream_error",
          payload: {
            conversationId,
            error: result.error ?? "No screenshot returned from browser tool",
          },
        });
      }
    } catch (error) {
      logger.error(
        { error, conversationId },
        "Error taking screenshot for stream",
      );
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId,
          error:
            error instanceof Error
              ? error.message
              : "Screenshot capture failed",
        },
      });
    }
  }

  private async sendImmediateScreenshot(
    ws: WebSocket,
    conversationId: string,
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      return;
    }
    if (ws.readyState !== WS.OPEN) {
      return;
    }
    if (subscription.isSending) {
      return;
    }

    subscription.isSending = true;
    try {
      await this.sendScreenshot(
        ws,
        subscription.agentId,
        conversationId,
        subscription.userContext,
      );
    } finally {
      subscription.isSending = false;
    }
  }
}
