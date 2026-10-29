import type { ServerWebSocketMessage } from "@archestra/shared";
import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS } from "ws";
import { subagentRunTracker } from "@/agents/subagent-run-tracker";
import { browserStreamFeature } from "@/features/browser-stream/services/browser-stream.feature";
import type { BrowserUserContext } from "@/features/browser-stream/services/browser-stream.service";
import { browserStateManager } from "@/features/browser-stream/services/browser-stream.state-manager";
import logger from "@/logging";
import { AgentModel, ConversationModel } from "@/models";
import PlaywrightRuntimeModel from "@/models/playwright-runtime";

const SCREENSHOT_INTERVAL_MS = 2_000; // Stream at ~0.5 FPS (every 2 seconds)
// After an input is sent, wait this long before a quick frame so it shows the
// input's effect
const FAST_FRAME_DELAY_MS = 120;
// Quiet time after the latest input before a settled frame
const SETTLED_FRAME_DELAY_MS = 300;

type BrowserStreamSubscription = {
  conversationId: string;
  agentId: string;
  userContext: BrowserUserContext;
  intervalId: NodeJS.Timeout;
  isSending: boolean;
  /** An immediate screenshot was requested while one was in flight. */
  refreshPending?: boolean;
  /** Set when screenshots were skipped due to active subagents */
  wasBlockedBySubagent: boolean;
  /** Numbers each capture as it starts; see sendScreenshot. */
  frameSeq: number;
  lastSentFrameSeq: number;
  /** Quick frames during input: one in flight, at most one more pending. */
  fastFrameInFlight: boolean;
  fastFramePending: boolean;
  /** Settled frame (caret, URL) once input pauses. */
  settledFrameTimer?: NodeJS.Timeout;
  /** Bumped per input sent, so only the latest input's own frame is shown. */
  inputSeq: number;
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

    if (
      !this.isBrowserStreamEnabled() ||
      !(await PlaywrightRuntimeModel.isEnabled())
    ) {
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
          typeof payload?.initialUrl === "string"
            ? payload.initialUrl
            : undefined,
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

      case "browser_scroll":
        await this.handleBrowserScroll(ws, conversationId, {
          x: typeof payload?.x === "number" ? payload.x : 0,
          y: typeof payload?.y === "number" ? payload.y : 0,
          deltaX: typeof payload?.deltaX === "number" ? payload.deltaX : 0,
          deltaY: typeof payload?.deltaY === "number" ? payload.deltaY : 0,
        });
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
      clearTimeout(subscription.settledFrameTimer);
      this.browserSubscriptions.delete(ws);

      // NOTE: We intentionally do NOT close the MCP client connection here.
      // The browser stream shares the same MCP client (keyed by agentId:userId:conversationId)
      // as the chat agentic loop. Closing it here would kill in-flight tool calls
      // from the agentic loop, causing AI_MissingToolResultsError.
      // Idle conversation clients are reaped by the LRU TTL in chat-mcp-client.ts.

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
    },
    initialUrl?: string,
  ): Promise<void> {
    // Re-subscribing to the same conversation is a no-op: tearing down and
    // rebuilding would leave a gap where input fails as "not subscribed"
    const existing = this.browserSubscriptions.get(ws);
    if (existing?.conversationId === conversationId) {
      await this.sendImmediateScreenshot(ws, conversationId);
      return;
    }

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

    // Check if Playwright tools are assigned to this agent
    const hasPlaywrightTools =
      await AgentModel.hasPlaywrightToolsAssigned(agentId);
    if (!hasPlaywrightTools) {
      this.sendToClient(ws, {
        type: "browser_stream_error",
        payload: {
          conversationId,
          error: "Browser tools are not assigned to this agent",
        },
      });
      return;
    }

    // NOTE: Previously this code unsubscribed other conversations for the same agent
    // to prevent tab switching/flickering in a shared browser. This is no longer needed
    // because each conversation now has its own MCP client connection and browser instance,
    // providing proper per-conversation isolation.

    logger.info(
      { conversationId, agentId },
      "Browser stream client subscribed",
    );

    const userContext: BrowserUserContext = {
      userId: clientContext.userId,
      organizationId: clientContext.organizationId,
    };

    // Select or create the tab for this conversation
    // This also restores the conversation's URL if it had one. Not awaited:
    // restoring the URL waits for the page to load, and frames can stream
    // (showing it load) in the meantime.
    const tabSelection = browserStreamFeature
      .selectOrCreateTab(agentId, conversationId, userContext, initialUrl)
      .then((tabResult) => {
        if (!tabResult.success) {
          logger.warn(
            { conversationId, agentId, error: tabResult.error },
            "Failed to select/create browser tab",
          );
          // Continue anyway - screenshot will work on current tab
        }
      })
      .catch((error) => {
        logger.warn(
          { conversationId, agentId, error },
          "Failed to select/create browser tab",
        );
      });

    // Send initial screenshot
    const sendTick = async () => {
      const subscription = this.browserSubscriptions.get(ws);
      if (!subscription) return;
      if (subscription.isSending) return;
      if (!(await PlaywrightRuntimeModel.isEnabled())) {
        this.unsubscribeBrowserStream(ws);
        this.sendToClient(ws, {
          type: "browser_stream_error",
          payload: {
            conversationId,
            error: "The built-in browser MCP is disabled",
          },
        });
        return;
      }

      // Skip screenshot while subagents are using the browser to prevent
      // flickering — the preview holds the last good screenshot instead.
      if (subagentRunTracker.hasActiveSubagents(subscription.conversationId)) {
        subscription.wasBlockedBySubagent = true;
        return;
      }

      // After subagents finish, re-select the parent's tab before resuming
      // screenshots. The subagent may have switched to a different tab.
      if (subscription.wasBlockedBySubagent) {
        subscription.wasBlockedBySubagent = false;
        await browserStreamFeature.selectOrCreateTab(
          agentId,
          conversationId,
          userContext,
        );
      }

      subscription.isSending = true;
      try {
        await this.sendScreenshot(ws, agentId, conversationId, userContext);
      } finally {
        subscription.isSending = false;
      }
      if (subscription.refreshPending) {
        await this.sendImmediateScreenshot(ws, conversationId);
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
      wasBlockedBySubagent: false,
      frameSeq: 0,
      lastSentFrameSeq: 0,
      fastFrameInFlight: false,
      fastFramePending: false,
      inputSeq: 0,
    });

    // A quick first frame right away, then a settled one (caret, URL) once
    // the tab and its URL are restored
    void this.requestFastFrame(ws);
    void tabSelection.then(() =>
      this.sendImmediateScreenshot(ws, conversationId),
    );
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

    const inputSeq = this.beginInput(ws);
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
        this.finishInput(ws, conversationId, inputSeq, result.frame);
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

    const inputSeq = this.beginInput(ws);
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
        this.finishInput(ws, conversationId, inputSeq, result.frame);
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

    const inputSeq = this.beginInput(ws);
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
        this.finishInput(ws, conversationId, inputSeq, result.frame);
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

  async handleBrowserScroll(
    ws: WebSocket,
    conversationId: string,
    params: { x: number; y: number; deltaX: number; deltaY: number },
  ): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      this.sendToClient(ws, {
        type: "browser_scroll_result",
        payload: {
          conversationId,
          success: false,
          error: "Not subscribed to this conversation's browser stream",
        },
      });
      return;
    }

    const inputSeq = this.beginInput(ws);
    try {
      const result = await browserStreamFeature.scroll(
        subscription.agentId,
        conversationId,
        subscription.userContext,
        params,
      );
      this.sendToClient(ws, {
        type: "browser_scroll_result",
        payload: {
          conversationId,
          success: result.success,
          error: result.error,
        },
      });

      if (result.success) {
        this.finishInput(ws, conversationId, inputSeq, result.frame);
      }
    } catch (error) {
      logger.error({ error, conversationId }, "Browser scroll failed");
      this.sendToClient(ws, {
        type: "browser_scroll_result",
        payload: {
          conversationId,
          success: false,
          error: error instanceof Error ? error.message : "Scroll failed",
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
    options?: { fast?: boolean },
  ): Promise<void> {
    if (ws.readyState !== WS.OPEN) {
      return;
    }

    // Captures overlap (quick frames during input, slower settled frames), so
    // a frame that started before one already sent is stale: drop it
    const subscription = this.browserSubscriptions.get(ws);
    const frameSeq = subscription ? ++subscription.frameSeq : 0;

    try {
      const result = await browserStreamFeature.takeScreenshot(
        agentId,
        conversationId,
        userContext,
        options,
      );

      const current = this.browserSubscriptions.get(ws);
      if (current && current === subscription) {
        if (frameSeq < current.lastSentFrameSeq) return;
        current.lastSentFrameSeq = frameSeq;
      }

      if (result.screenshot) {
        // Sync URL to conversation state, but ONLY if subscription is still active
        // for the same conversation. This prevents race conditions where screenshot
        // completes after user switched conversations.
        const currentSubscription = this.browserSubscriptions.get(ws);
        if (
          currentSubscription &&
          currentSubscription.conversationId === conversationId &&
          result.url &&
          !this.isBlankUrl(result.url)
        ) {
          await browserStateManager.updateUrl(
            agentId,
            userContext.userId,
            conversationId,
            result.url,
          );
        }

        // Determine canGoBack based on current URL
        // If on about:blank, there's nowhere useful to go back to. A quick
        // frame carries no URL, so it leaves canGoBack as it was.
        const canGoBack = result.url ? !this.isBlankUrl(result.url) : undefined;

        this.sendToClient(ws, {
          type: "browser_screenshot",
          payload: {
            conversationId,
            screenshot: result.screenshot,
            url: result.url,
            viewportWidth: result.viewportWidth,
            viewportHeight: result.viewportHeight,
            canGoBack,
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

  private isBlankUrl(url: string): boolean {
    return url === "about:blank" || url === "about:newtab" || url === "";
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
    // A capture in flight may predate the action; take another right after it
    if (subscription.isSending) {
      subscription.refreshPending = true;
      return;
    }

    subscription.isSending = true;
    subscription.refreshPending = false;
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
    if (subscription.refreshPending) {
      await this.sendImmediateScreenshot(ws, conversationId);
    }
  }

  /**
   * An input is about to run: show its effect in quick frames as it lands.
   * Inputs run concurrently (the page keeps them in order), so the preview
   * keeps up with typing instead of waiting out each browser call.
   */
  private beginInput(ws: WebSocket): number {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription) return 0;
    subscription.inputSeq += 1;
    clearTimeout(subscription.settledFrameTimer);
    // Give the action a moment to reach the page before capturing
    setTimeout(() => void this.requestFastFrame(ws), FAST_FRAME_DELAY_MS);
    return subscription.inputSeq;
  }

  /**
   * An input finished. The latest one's own frame shows the caret; once input
   * pauses, a settled frame brings the caret, URL and any page updates.
   */
  private finishInput(
    ws: WebSocket,
    conversationId: string,
    inputSeq: number,
    frame: { screenshot: string; url: string } | undefined,
  ): void {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || subscription.conversationId !== conversationId) {
      return;
    }
    if (inputSeq !== subscription.inputSeq) return;

    if (frame) {
      // Newest content: anything captured before now is stale
      subscription.frameSeq += 1;
      subscription.lastSentFrameSeq = subscription.frameSeq;
      this.sendToClient(ws, {
        type: "browser_screenshot",
        payload: {
          conversationId,
          screenshot: frame.screenshot,
          url: frame.url || undefined,
          canGoBack: frame.url ? !this.isBlankUrl(frame.url) : undefined,
        },
      });
    }

    clearTimeout(subscription.settledFrameTimer);
    subscription.settledFrameTimer = setTimeout(() => {
      void this.sendImmediateScreenshot(ws, conversationId);
    }, SETTLED_FRAME_DELAY_MS);
  }

  /** Capture a quick frame; while one is in flight, queue a single follow-up. */
  private async requestFastFrame(ws: WebSocket): Promise<void> {
    const subscription = this.browserSubscriptions.get(ws);
    if (!subscription || ws.readyState !== WS.OPEN) return;
    if (subscription.fastFrameInFlight) {
      subscription.fastFramePending = true;
      return;
    }
    subscription.fastFrameInFlight = true;
    subscription.fastFramePending = false;
    try {
      await this.sendScreenshot(
        ws,
        subscription.agentId,
        subscription.conversationId,
        subscription.userContext,
        { fast: true },
      );
    } finally {
      subscription.fastFrameInFlight = false;
    }
    if (subscription.fastFramePending) {
      await this.requestFastFrame(ws);
    }
  }
}
