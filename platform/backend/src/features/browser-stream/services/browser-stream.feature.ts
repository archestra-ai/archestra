import config from "@/config";
import {
  BrowserStreamService,
  type BrowserUserContext,
} from "./browser-stream.service";

/**
 * Browser WebSocket message types that should be guarded by the feature flag
 */
const BROWSER_WS_MESSAGE_TYPES = [
  "subscribe_browser_stream",
  "unsubscribe_browser_stream",
  "browser_navigate",
  "browser_navigate_back",
  "browser_click",
  "browser_type",
  "browser_press_key",
  "browser_get_snapshot",
  "browser_set_zoom",
] as const;

/**
 * Feature gate for browser streaming functionality.
 * Provides a single point of control for the browser streaming feature flag.
 * All browser streaming functionality should go through this feature gate.
 */
class BrowserStreamFeature {
  private service: BrowserStreamService | null = null;

  private getService(): BrowserStreamService {
    if (!this.service) {
      this.service = new BrowserStreamService();
    }
    return this.service;
  }

  /**
   * Check if browser streaming feature is enabled
   */
  isEnabled(): boolean {
    return config.features.browserStreamingEnabled;
  }

  /**
   * Check if a WebSocket message type is browser-related
   */
  isBrowserWebSocketMessage(messageType: string): boolean {
    return BROWSER_WS_MESSAGE_TYPES.includes(
      messageType as (typeof BROWSER_WS_MESSAGE_TYPES)[number],
    );
  }

  // Delegate all service methods

  checkAvailability(agentId: string) {
    return this.getService().checkAvailability(agentId);
  }

  selectOrCreateTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    initialUrl?: string,
  ) {
    return this.getService().selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
      initialUrl,
    );
  }

  restoreConversationUrl(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().restoreConversationUrl(
      agentId,
      conversationId,
      userContext,
    );
  }

  navigate(
    agentId: string,
    conversationId: string,
    url: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().navigate(
      agentId,
      conversationId,
      url,
      userContext,
    );
  }

  navigateBack(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().navigateBack(agentId, conversationId, userContext);
  }

  activateTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().activateTab(agentId, conversationId, userContext);
  }

  listTabs(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().listTabs(agentId, conversationId, userContext);
  }

  closeTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().closeTab(agentId, conversationId, userContext);
  }

  syncUrlFromNavigateToolCall(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    toolResultContent: unknown;
  }) {
    return this.getService().syncUrlFromNavigateToolCall(params);
  }

  takeScreenshot(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().takeScreenshot(
      agentId,
      conversationId,
      userContext,
    );
  }

  getCurrentUrl(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );
  }

  click(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    element?: string,
    x?: number,
    y?: number,
  ) {
    return this.getService().click(
      agentId,
      conversationId,
      userContext,
      element,
      x,
      y,
    );
  }

  type(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    text: string,
    element?: string,
  ) {
    return this.getService().type(
      agentId,
      conversationId,
      userContext,
      text,
      element,
    );
  }

  pressKey(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    key: string,
  ) {
    return this.getService().pressKey(
      agentId,
      conversationId,
      userContext,
      key,
    );
  }

  getSnapshot(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ) {
    return this.getService().getSnapshot(agentId, conversationId, userContext);
  }
}

export const browserStreamFeature = new BrowserStreamFeature();
