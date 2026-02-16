import { randomUUID } from "node:crypto";
import {
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
  isBrowserMcpTool,
  PLAYWRIGHT_MCP_CATALOG_ID,
  TimeInMs,
} from "@shared";
import { LRUCacheManager } from "@/cache-manager";
import { selectMCPGatewayToken } from "@/clients/chat-mcp-client";
import mcpClient from "@/clients/mcp-client";
import logger from "@/logging";
import { BrowserTabStateModel, ToolModel } from "@/models";
import { ApiError } from "@/types";
import {
  shouldLogBrowserStreamScreenshots,
  shouldLogBrowserStreamTabSync,
} from "./browser-stream.log-settings";
import {
  browserStateManager,
  type ConversationStateKey,
  toConversationStateKey,
} from "./browser-stream.state-manager";

/**
 * User context required for MCP client authentication
 */
export interface BrowserUserContext {
  userId: string;
  organizationId: string;
  userIsProfileAdmin: boolean;
}

export interface AvailabilityResult {
  available: boolean;
  tools?: string[];
  error?: string;
}

export interface NavigateResult {
  success: boolean;
  url?: string;
  error?: string;
}

export interface ScreenshotResult {
  screenshot?: string;
  url?: string;
  error?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface TabResult {
  success: boolean;
  tabIndex?: number;
  tabs?: Array<{ index: number; title?: string; url?: string }>;
  error?: string;
}

type BrowserTabsListData = {
  content: unknown;
  tabs: Array<{ index: number; title?: string; url?: string }>;
};

type BrowserTabsAction = "list" | "new" | "close" | "select";

export interface ClickResult {
  success: boolean;
  error?: string;
}

export interface TypeResult {
  success: boolean;
  error?: string;
}

export interface ScrollResult {
  success: boolean;
  error?: string;
}

export interface SnapshotResult {
  snapshot?: string;
  error?: string;
}

type LogContext = Record<string, unknown>;

const MAX_TABS_PER_USER = 10;

const logTabSyncInfo = (context: LogContext, message: string): void => {
  if (!shouldLogBrowserStreamTabSync()) {
    return;
  }
  logger.info(context, message);
};

const logScreenshotInfo = (context: LogContext, message: string): void => {
  if (!shouldLogBrowserStreamScreenshots()) {
    return;
  }
  logger.info(context, message);
};

/**
 * Cache for agent tools to avoid repeated database queries during browser streaming.
 * Uses LRU eviction with 30-second TTL. Shared across all BrowserStreamService instances.
 */
const toolsCache = new LRUCacheManager<
  { name: string; catalogId: string | null }[]
>({
  maxSize: 100,
  defaultTtl: 30 * TimeInMs.Second,
});

/**
 * Service for browser streaming via Playwright MCP
 * Calls Playwright MCP tools directly through the MCP Gateway
 */
export class BrowserStreamService {
  private readonly tabSelectionLocks = new Map<
    ConversationStateKey,
    Promise<TabResult>
  >();

  /**
   * Execute a Playwright MCP tool directly via mcpClient, bypassing the MCP Gateway.
   * This ensures the browser stream uses the same Playwright session (same connection key)
   * as the chat agent, so the preview shows the same page the agent sees.
   */
  private async executeTool(params: {
    toolName: string;
    args: Record<string, unknown>;
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
  }): Promise<{
    content: unknown;
    isError: boolean;
  }> {
    const { toolName, args, agentId, conversationId, userContext } = params;

    const mcpGwToken = await selectMCPGatewayToken(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
    );

    const tokenAuth = mcpGwToken
      ? {
          tokenId: mcpGwToken.tokenId,
          teamId: mcpGwToken.teamId,
          isOrganizationToken: mcpGwToken.isOrganizationToken,
          organizationId: userContext.organizationId,
          userId: userContext.userId,
        }
      : undefined;

    const toolCall = {
      id: randomUUID(),
      name: toolName,
      arguments: args,
    };

    const result = await mcpClient.executeToolCall(
      toolCall,
      agentId,
      tokenAuth,
      {
        conversationId,
      },
    );

    return {
      content: Array.isArray(result.content)
        ? result.content
        : [{ type: "text", text: JSON.stringify(result.content) }],
      isError: !!result.isError,
    };
  }

  /**
   * Get tools for an agent with caching to reduce database queries.
   * Tools are cached for 30 seconds with LRU eviction.
   */
  private async getToolsForAgent(
    agentId: string,
  ): Promise<{ name: string; catalogId: string | null }[]> {
    const cached = toolsCache.get(agentId);
    if (cached) {
      return cached;
    }

    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const toolData = tools.map((t) => ({
      name: t.name as string,
      catalogId: t.catalogId,
    }));

    toolsCache.set(agentId, toolData);

    return toolData;
  }

  private async findToolName(
    agentId: string,
    matches: (toolName: string) => boolean,
  ): Promise<string | null> {
    const tools = await this.getToolsForAgent(agentId);

    // Only consider tools from the builtin playwright-browser catalog
    for (const tool of tools) {
      if (tool.catalogId !== PLAYWRIGHT_MCP_CATALOG_ID) {
        continue;
      }
      const toolName = tool.name;
      if (typeof toolName === "string" && matches(toolName)) {
        return toolName;
      }
    }

    return null;
  }

  /**
   * Check if Playwright MCP browser tools are available for an agent.
   * Only considers tools from the builtin playwright-browser catalog (PLAYWRIGHT_MCP_CATALOG_ID).
   * @param agentId - The agent ID
   */
  async checkAvailability(agentId: string): Promise<AvailabilityResult> {
    const tools = await this.getToolsForAgent(agentId);

    // Only include tools from the builtin playwright-browser catalog
    const browserToolNames = tools
      .filter((tool) => tool.catalogId === PLAYWRIGHT_MCP_CATALOG_ID)
      .filter((tool) => isBrowserMcpTool(tool.name))
      .map((tool) => tool.name);

    return {
      available: browserToolNames.length > 0,
      tools: browserToolNames,
    };
  }

  /**
   * Find the Playwright browser navigate tool for an agent
   * Matches tools like "browser_navigate" or "playwright__browser_navigate"
   * but NOT "browser_navigate_back" or "browser_navigate_forward"
   */
  private async findNavigateTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) => {
      // Check if it ends with "browser_navigate" (to match both
      // "browser_navigate" and "prefix__browser_navigate")
      if (toolName.endsWith("browser_navigate")) return true;
      // Check for __navigate suffix (older naming convention)
      if (toolName.endsWith("__navigate")) return true;
      // As a fallback, check for playwright navigate but exclude back/forward
      if (
        toolName.includes("playwright") &&
        toolName.includes("navigate") &&
        !toolName.includes("_back") &&
        !toolName.includes("_forward")
      ) {
        return true;
      }
      return false;
    });
  }

  /**
   * Find the Playwright browser navigate back tool for an agent
   * Matches tools like "browser_navigate_back" or "playwright__browser_navigate_back"
   */
  private async findNavigateBackTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_navigate_back"),
    );
  }

  /**
   * Find the Playwright browser screenshot tool for an agent
   */
  private async findScreenshotTool(agentId: string): Promise<string | null> {
    // Prefer browser_take_screenshot or browser_screenshot
    return this.findToolName(
      agentId,
      (toolName) =>
        toolName.includes("browser_take_screenshot") ||
        toolName.includes("browser_screenshot"),
    );
  }

  /**
   * Find the Playwright browser tabs tool for an agent
   */
  private async findTabsTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_tabs"),
    );
  }

  private async getTabsList(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    tabsTool: string;
  }): Promise<BrowserTabsListData | null> {
    const { agentId, conversationId, userContext, tabsTool } = params;

    const listResult = await this.callTabsTool({
      agentId,
      conversationId,
      userContext,
      tabsTool,
      action: "list",
    });

    if (listResult.isError) {
      return null;
    }

    const tabs = this.parseTabsList(listResult.content);
    return { content: listResult.content, tabs };
  }

  private async callTabsTool(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    tabsTool: string;
    action: BrowserTabsAction;
    index?: number;
  }) {
    const { agentId, conversationId, userContext, tabsTool, action, index } =
      params;

    const logContext = {
      agentId,
      conversationId,
      userId: userContext.userId,
      tabsTool,
      action,
      index,
    };

    if (action === "list") {
      logger.debug(logContext, "[BrowserTabs] browser_tabs action");
    } else {
      logger.info(logContext, "[BrowserTabs] browser_tabs action");
    }

    return this.executeTool({
      toolName: tabsTool,
      args: index === undefined ? { action } : { action, index },
      agentId,
      conversationId,
      userContext,
    });
  }

  /**
   * Select or create a browser tab for a conversation
   * Uses Playwright MCP browser_tabs tool and persists state to database
   */
  async selectOrCreateTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    initialUrl?: string,
  ): Promise<TabResult> {
    const lockKey = toConversationStateKey(
      agentId,
      userContext.userId,
      conversationId,
    );
    const existingLock = this.tabSelectionLocks.get(lockKey);
    if (existingLock) {
      // Wait for the existing operation to complete
      // If it fails, we'll retry with a fresh attempt
      try {
        return await existingLock;
      } catch (error) {
        // The original request failed, but the lock should be cleaned up by now
        // Fall through to retry with a fresh attempt
        logger.warn(
          { agentId, conversationId, error },
          "Concurrent tab selection failed, retrying",
        );
      }
    }

    const task = this.selectOrCreateTabInternal(
      agentId,
      conversationId,
      userContext,
      initialUrl,
    );
    this.tabSelectionLocks.set(lockKey, task);

    try {
      return await task;
    } finally {
      if (this.tabSelectionLocks.get(lockKey) === task) {
        this.tabSelectionLocks.delete(lockKey);
      }
    }
  }

  /**
   * Select or create a browser tab for this conversation.
   *
   * Each conversation gets its own tab. When switching conversations:
   * - If conversation has a stored tabIndex and it still exists, select it
   * - Otherwise, create a new tab (close oldest if at limit)
   */
  private async selectOrCreateTabInternal(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    initialUrl?: string,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      logTabSyncInfo(
        { agentId, conversationId },
        "[BrowserTabs] No browser_tabs tool available, using default tab",
      );
      return { success: true, tabIndex: 0 };
    }

    try {
      // Load stored state for this agent+user+conversation
      const state = await browserStateManager.get(
        agentId,
        userContext.userId,
        conversationId,
      );
      const storedTabIndex = state?.tabIndex;
      const storedUrl = state?.url;

      // Get current browser tabs
      const listData = await this.getTabsList({
        agentId,
        conversationId,
        userContext,
        tabsTool,
      });
      const browserTabs = listData?.tabs ?? [];

      logTabSyncInfo(
        {
          agentId,
          conversationId,
          storedTabIndex,
          storedUrl,
          tabCount: browserTabs.length,
        },
        "[BrowserTabs] Checking for existing tab",
      );

      // If we have a stored tabIndex, check if it still exists
      if (storedTabIndex !== undefined) {
        const existingTab = browserTabs.find((t) => t.index === storedTabIndex);
        if (existingTab) {
          // Tab exists - select it
          await this.callTabsTool({
            agentId,
            conversationId,
            userContext,
            tabsTool,
            action: "select",
            index: storedTabIndex,
          });

          logTabSyncInfo(
            { agentId, conversationId, tabIndex: storedTabIndex },
            "[BrowserTabs] Selected existing tab for conversation",
          );

          // If the tab exists but is blank (common after browser process restart),
          // restore the persisted URL for this conversation.
          const shouldRestoreStoredUrl =
            this.isBlankUrl(existingTab.url) &&
            storedUrl &&
            !this.isBlankUrl(storedUrl);
          if (shouldRestoreStoredUrl) {
            const navigateTool = await this.findNavigateTool(agentId);
            if (navigateTool) {
              await this.executeTool({
                toolName: navigateTool,
                args: { url: storedUrl },
                agentId,
                conversationId,
                userContext,
              });
              await browserStateManager.updateUrl(
                agentId,
                userContext.userId,
                conversationId,
                storedUrl,
              );
            }
          }

          // If browser has a non-blank URL for this tab, persist it immediately.
          // This ensures URL restoration survives backend redeploys even when no
          // explicit browser_navigate happened in this session.
          if (
            !shouldRestoreStoredUrl &&
            existingTab.url &&
            !this.isBlankUrl(existingTab.url)
          ) {
            await browserStateManager.updateUrl(
              agentId,
              userContext.userId,
              conversationId,
              existingTab.url,
            );
          }

          return { success: true, tabIndex: storedTabIndex };
        }
        // Tab no longer exists (was closed externally), need to create new one
        logTabSyncInfo(
          { agentId, conversationId, storedTabIndex },
          "[BrowserTabs] Stored tab no longer exists, creating new one",
        );
      }

      // No existing tab - need to create one
      // First, check if we need to close oldest tab
      await this.closeOldestTabIfNeeded({
        agentId,
        conversationId,
        userContext,
        tabsTool,
        browserTabs,
      });

      // Check if there's an about:blank tab we can reuse
      const blankTab = browserTabs.find((t) => this.isBlankUrl(t.url));
      let newTabIndex: number;

      if (blankTab) {
        // Reuse the blank tab
        newTabIndex = blankTab.index;
        await this.callTabsTool({
          agentId,
          conversationId,
          userContext,
          tabsTool,
          action: "select",
          index: newTabIndex,
        });

        logTabSyncInfo(
          { agentId, conversationId, tabIndex: newTabIndex },
          "[BrowserTabs] Reusing blank tab",
        );
      } else {
        // Create a new tab
        await this.callTabsTool({
          agentId,
          conversationId,
          userContext,
          tabsTool,
          action: "new",
        });

        // Get updated tabs list to find the new tab's index
        const updatedListData = await this.getTabsList({
          agentId,
          conversationId,
          userContext,
          tabsTool,
        });
        const updatedTabs = updatedListData?.tabs ?? [];
        newTabIndex = this.getMaxTabIndex(updatedTabs);

        logTabSyncInfo(
          { agentId, conversationId, tabIndex: newTabIndex },
          "[BrowserTabs] Created new tab",
        );
      }

      // Navigate to stored URL if we have one
      const urlToLoad =
        storedUrl && !this.isBlankUrl(storedUrl) ? storedUrl : initialUrl;
      if (urlToLoad) {
        const navigateTool = await this.findNavigateTool(agentId);
        if (navigateTool) {
          await this.executeTool({
            toolName: navigateTool,
            args: { url: urlToLoad },
            agentId,
            conversationId,
            userContext,
          });

          logTabSyncInfo(
            { agentId, conversationId, url: urlToLoad },
            "[BrowserTabs] Navigated to URL",
          );
        }
      }

      // If we did not navigate explicitly, attempt to recover current URL from
      // browser state (current tab) and persist it when non-blank.
      const recoveredCurrentUrl = !urlToLoad
        ? await this.getCurrentUrl(agentId, conversationId, userContext)
        : undefined;
      const urlToPersist: string = !this.isBlankUrl(urlToLoad)
        ? (urlToLoad ?? "")
        : !this.isBlankUrl(recoveredCurrentUrl)
          ? (recoveredCurrentUrl ?? "")
          : !this.isBlankUrl(storedUrl)
            ? (storedUrl ?? "")
            : "";

      // Save state
      await browserStateManager.set(
        agentId,
        userContext.userId,
        conversationId,
        {
          url: urlToPersist,
          tabIndex: newTabIndex,
        },
      );

      return { success: true, tabIndex: newTabIndex };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { error, agentId, conversationId },
        "[BrowserTabs] selectOrCreateTab failed",
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Restore a conversation's URL when browser preview first connects.
   * This is now a no-op since selectOrCreateTab handles everything.
   * Kept for API compatibility.
   */
  async restoreConversationUrl(
    _agentId: string,
    _conversationId: string,
    _userContext: BrowserUserContext,
  ): Promise<void> {
    // No-op - selectOrCreateTab now handles tab selection and URL restoration
  }

  /**
   * Close the oldest tab if at the maximum tab limit.
   * Finds the oldest conversation with browser state and closes its tab.
   */
  private async closeOldestTabIfNeeded(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    tabsTool: string;
    browserTabs: Array<{ index: number; title?: string; url?: string }>;
  }): Promise<void> {
    const { agentId, conversationId, userContext, tabsTool, browserTabs } =
      params;

    if (browserTabs.length < MAX_TABS_PER_USER) {
      return;
    }

    // Get oldest tab state for this user across all agents
    const oldest = await BrowserTabStateModel.getOldestForUser(
      userContext.userId,
    );

    if (!oldest) {
      return;
    }

    if (oldest.tabIndex !== null && oldest.tabIndex > 0) {
      logger.info(
        {
          agentId: oldest.agentId,
          userId: userContext.userId,
          oldestIsolationKey: oldest.isolationKey,
          tabIndex: oldest.tabIndex,
        },
        "[BrowserTabs] Closing oldest tab to make room for new conversation",
      );

      await this.callTabsTool({
        agentId,
        conversationId,
        userContext,
        tabsTool,
        action: "close",
        index: oldest.tabIndex,
      });
    }

    // Clear state for the closed tab
    await browserStateManager.clear(
      oldest.agentId,
      userContext.userId,
      oldest.isolationKey,
    );
  }

  /**
   * Find the Playwright browser click tool for an agent
   */
  private async findClickTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_click"),
    );
  }

  private async findTypeTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_type"),
    );
  }

  private async findPressKeyTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_press_key"),
    );
  }

  private async findSnapshotTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_snapshot"),
    );
  }

  private async findResizeTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_resize"),
    );
  }

  /**
   * Resize browser window to ensure proper viewport dimensions
   * Called when creating a new tab to avoid small default viewport
   */
  private async resizeBrowser(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    width: number = DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
    height: number = DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
  ): Promise<void> {
    const resizeTool = await this.findResizeTool(agentId);
    if (!resizeTool) {
      logger.debug(
        { agentId },
        "No browser_resize tool available, using default viewport",
      );
      return;
    }

    try {
      logger.debug({ agentId, width, height }, "Resizing browser viewport");

      const result = await this.executeTool({
        toolName: resizeTool,
        args: { width, height },
        agentId,
        conversationId,
        userContext,
      });

      if (result.isError) {
        const errorText = this.extractTextContent(result.content);
        logger.warn(
          { agentId, error: errorText },
          "Failed to resize browser viewport",
        );
      }
    } catch (error) {
      logger.warn({ agentId, error }, "Error resizing browser viewport");
    }
  }

  /**
   * Navigate browser to a URL in a conversation's tab.
   * Updates history in persisted state.
   */
  async navigate(
    agentId: string,
    conversationId: string,
    url: string,
    userContext: BrowserUserContext,
  ): Promise<NavigateResult> {
    logger.debug(
      { agentId, conversationId, url },
      "[BrowserNavigate] Starting navigation",
    );

    const tabResult = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      logger.error(
        { agentId, conversationId, error: tabResult.error },
        "[BrowserNavigate] Failed to select/create tab",
      );
      throw new ApiError(
        500,
        tabResult.error ?? "Failed to select browser tab",
      );
    }

    logger.debug(
      { agentId, conversationId, tabIndex: tabResult.tabIndex },
      "[BrowserNavigate] Tab selected/created",
    );

    const toolName = await this.findNavigateTool(agentId);
    if (!toolName) {
      logger.error(
        { agentId, conversationId },
        "[BrowserNavigate] No navigate tool available",
      );
      throw new ApiError(
        400,
        "No browser navigate tool available for this agent",
      );
    }

    // Resize browser to ensure proper viewport dimensions before navigation
    // This ensures the page loads with the correct viewport from the start
    await this.resizeBrowser(agentId, conversationId, userContext);

    logger.debug(
      { agentId, conversationId, toolName, url },
      "[BrowserNavigate] Calling MCP navigate tool",
    );

    const result = await this.executeTool({
      toolName,
      args: { url },
      agentId,
      conversationId,
      userContext,
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      logger.error(
        { agentId, conversationId, url, errorText },
        "[BrowserNavigate] MCP navigate tool returned error",
      );
      throw new ApiError(500, errorText || "Navigation failed");
    }

    logger.debug(
      { agentId, conversationId, url },
      "[BrowserNavigate] MCP navigate tool succeeded",
    );

    const resolvedUrl =
      (await this.getCurrentUrl(agentId, conversationId, userContext)) ?? url;

    // Update URL in state
    await browserStateManager.updateUrl(
      agentId,
      userContext.userId,
      conversationId,
      resolvedUrl,
    );

    logTabSyncInfo(
      { agentId, conversationId, url: resolvedUrl },
      "[BrowserTabs] Updated current URL",
    );

    return {
      success: true,
      url: resolvedUrl,
    };
  }

  /**
   * Navigate browser back to the previous page
   * Uses browser's native back navigation - fails gracefully if no history
   */
  async navigateBack(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<NavigateResult> {
    logger.debug(
      { agentId, conversationId },
      "[BrowserNavigateBack] Starting back navigation",
    );

    // Ensure we have a tab selected
    const tabResult = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      logger.error(
        { agentId, conversationId, error: tabResult.error },
        "[BrowserNavigateBack] Failed to select/create tab",
      );
      throw new ApiError(
        500,
        tabResult.error ?? "Failed to select browser tab",
      );
    }

    // Find the browser_navigate_back tool
    const navigateBackTool = await this.findNavigateBackTool(agentId);
    if (!navigateBackTool) {
      logger.error(
        { agentId, conversationId },
        "[BrowserNavigateBack] No navigate back tool available",
      );
      throw new ApiError(400, "No browser navigate back tool available");
    }

    logger.debug(
      { agentId, conversationId, toolName: navigateBackTool },
      "[BrowserNavigateBack] Calling browser navigate back tool",
    );

    const result = await this.executeTool({
      toolName: navigateBackTool,
      args: {},
      agentId,
      conversationId,
      userContext,
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      logger.warn(
        { agentId, conversationId, errorText },
        "[BrowserNavigateBack] Navigate back tool returned error",
      );
      // Return error instead of throwing - back navigation failure is not fatal
      return {
        success: false,
        error: errorText || "No back history available",
      };
    }

    // Get the actual browser URL after navigation
    const actualUrl = await this.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    // Update the current URL in state (for page restoration when switching conversations)
    if (actualUrl && !this.isBlankUrl(actualUrl)) {
      await browserStateManager.updateUrl(
        agentId,
        userContext.userId,
        conversationId,
        actualUrl,
      );

      logTabSyncInfo(
        { agentId, conversationId, url: actualUrl },
        "[BrowserNavigateBack] Updated current URL after back navigation",
      );
    }

    return {
      success: true,
      url: actualUrl ?? undefined,
    };
  }

  /**
   * Activate a conversation's browser tab (create if doesn't exist, select if exists)
   * Called when user switches to a chat with browser panel open
   */
  async activateTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      throw new ApiError(400, "No browser tabs tool available for this agent");
    }

    const result = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!result.success) {
      throw new ApiError(500, result.error ?? "Failed to activate tab");
    }

    return result;
  }

  /**
   * List all browser tabs
   */
  async listTabs(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      throw new ApiError(400, "No browser tabs tool available");
    }

    const listData = await this.getTabsList({
      agentId,
      conversationId,
      userContext,
      tabsTool,
    });

    if (!listData) {
      throw new ApiError(500, "Failed to list tabs");
    }

    return {
      success: true,
      tabs: listData.tabs,
    };
  }

  /**
   * Close a conversation's browser tab.
   */
  async closeTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      await browserStateManager.clear(
        agentId,
        userContext.userId,
        conversationId,
      );
      return { success: true };
    }

    // Load state to get tab index
    const state = await browserStateManager.get(
      agentId,
      userContext.userId,
      conversationId,
    );
    const tabIndex = state?.tabIndex;

    if (tabIndex === undefined || tabIndex === 0) {
      logTabSyncInfo(
        { agentId, conversationId, tabIndex },
        "[BrowserTabs] No tab to close (undefined or tab 0)",
      );
      await browserStateManager.clear(
        agentId,
        userContext.userId,
        conversationId,
      );
      return { success: true };
    }

    logTabSyncInfo(
      { agentId, conversationId, closingTabIndex: tabIndex },
      "[BrowserTabs] Closing tab",
    );

    try {
      await this.callTabsTool({
        agentId,
        conversationId,
        userContext,
        tabsTool,
        action: "close",
        index: tabIndex,
      });

      // Clear the state for this conversation
      await browserStateManager.clear(
        agentId,
        userContext.userId,
        conversationId,
      );

      logTabSyncInfo(
        { agentId, conversationId, closedTabIndex: tabIndex },
        "[BrowserTabs] Closed tab and cleared state",
      );

      return { success: true };
    } catch (error) {
      logger.error({ error, agentId, conversationId }, "Failed to close tab");
      // Clear state anyway to prevent stale data, but report failure
      await browserStateManager.clear(
        agentId,
        userContext.userId,
        conversationId,
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to close tab",
      };
    }
  }

  /**
   * Sync browser state from AI-initiated browser_navigate tool calls.
   * Extracts the navigated URL from tool result and updates state.
   */
  async syncUrlFromNavigateToolCall(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    toolResultContent: unknown;
  }): Promise<void> {
    const { agentId, conversationId, userContext, toolResultContent } = params;

    // Extract URL from tool result
    // The Playwright MCP tool result contains the goto() call with the actual URL
    // Format: "await page.goto('https://example.com');" or similar
    const textContent = this.extractTextContent(toolResultContent);

    // Try to extract URL from goto() call first (most reliable for navigation)
    const gotoMatch = textContent.match(/page\.goto\(['"]([^'"]+)['"]\)/i);

    // Fallback to "Page URL:" if goto() not found
    const pageUrlMatch = textContent.match(/Page URL:\s*(\S+)/i);

    const navigatedUrl = gotoMatch?.[1] || pageUrlMatch?.[1];

    if (!navigatedUrl) {
      logger.debug(
        { conversationId },
        "[BrowserNavigate] Could not extract URL from navigate tool result",
      );
      return;
    }

    // Update URL in state
    await browserStateManager.updateUrl(
      agentId,
      userContext.userId,
      conversationId,
      navigatedUrl,
    );

    logger.info(
      { agentId, conversationId, url: navigatedUrl },
      "[BrowserNavigate] Updated current URL from AI navigate action",
    );
  }

  /**
   * Parse tabs list from tool response
   */
  private parseTabsList(
    content: unknown,
  ): Array<{ index: number; title?: string; url?: string }> {
    const textContent = this.extractTextContent(content);
    // This is a simplified parser - actual format depends on Playwright MCP
    const tabs: Array<{ index: number; title?: string; url?: string }> = [];

    const parseIndex = (value: unknown, fallback: number): number => {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          return parsed;
        }
      }
      return fallback;
    };

    // Try to parse JSON if content is JSON
    try {
      const parsed: unknown = JSON.parse(textContent);
      if (Array.isArray(parsed)) {
        return parsed.map((item, fallbackIndex) => {
          if (typeof item === "object" && item !== null) {
            const candidate = item as Record<string, unknown>;
            const rawTitle = candidate.title;
            const rawUrl = candidate.url;
            const rawIndex = candidate.index ?? candidate.id;
            const title = typeof rawTitle === "string" ? rawTitle : undefined;
            const url = typeof rawUrl === "string" ? rawUrl : undefined;
            return {
              index: parseIndex(rawIndex, fallbackIndex),
              title,
              url,
            };
          }
          if (typeof item === "string") {
            return { index: fallbackIndex, title: item };
          }
          return { index: fallbackIndex };
        });
      }
    } catch {
      // Not JSON, try line-by-line parsing
      const lines = textContent.split("\n");
      for (const line of lines) {
        const indexMatch = line.match(/(?:^|\s|-)(\d+)\s*:/);
        if (!indexMatch) continue;
        const index = Number.parseInt(indexMatch[1], 10);
        if (Number.isNaN(index)) continue;
        const titleMatch = line.match(/\[([^\]]+)\]/);
        const urlMatch = line.match(/\((https?:\/\/[^)]+|about:blank[^)]*)\)/);
        const title = titleMatch ? titleMatch[1] : undefined;
        const url = urlMatch ? urlMatch[1] : undefined;
        tabs.push({ index, title, url });
      }
    }

    return tabs;
  }

  private getMaxTabIndex(
    tabs: Array<{ index: number; title?: string; url?: string }>,
  ): number {
    let maxIndex = -1;
    for (const tab of tabs) {
      if (Number.isInteger(tab.index) && tab.index > maxIndex) {
        maxIndex = tab.index;
      }
    }
    return maxIndex;
  }

  /**
   * Take a screenshot of the current browser page.
   * Tab should already be selected via selectOrCreateTab when subscribing.
   * Does NOT select tab - just captures whatever is currently visible.
   * Uses fixed viewport dimensions for consistent rendering.
   */
  async takeScreenshot(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<ScreenshotResult> {
    // NOTE: We do NOT call selectOrCreateTab here.
    // Tab is selected once on subscription. After that, we just capture
    // whatever is current, so LLM navigation works correctly.

    const toolName = await this.findScreenshotTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser screenshot tool available for this agent",
      );
    }

    // Always use fixed viewport dimensions for consistent page rendering
    await this.resizeBrowser(agentId, conversationId, userContext);

    logScreenshotInfo(
      { agentId, conversationId, toolName },
      "Taking browser screenshot via MCP",
    );

    const result = await this.executeTool({
      toolName,
      args: {
        type: "jpeg",
        raw: true, // Return base64 data instead of saving to file
      },
      agentId,
      conversationId,
      userContext,
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Screenshot failed");
    }

    // Extract screenshot from MCP response
    // Playwright MCP returns screenshots as base64 images in content array
    const screenshot = this.extractScreenshot(result.content);

    if (!screenshot) {
      // Log content format for debugging
      logger.warn(
        {
          agentId,
          conversationId,
          contentType: typeof result.content,
          isArray: Array.isArray(result.content),
          contentLength: Array.isArray(result.content)
            ? result.content.length
            : 0,
          contentSample: Array.isArray(result.content)
            ? JSON.stringify(result.content.slice(0, 2)).slice(0, 500)
            : String(result.content).slice(0, 500),
        },
        "No screenshot data found in MCP response - unexpected content format",
      );
      return { error: "No screenshot returned from browser tool" };
    }

    // Log screenshot size for debugging token usage issues
    const base64Match = screenshot.match(/^data:([^;]+);base64,(.+)$/);
    if (base64Match) {
      const mimeType = base64Match[1];
      const base64Data = base64Match[2];
      const estimatedSizeKB = Math.round((base64Data.length * 3) / 4 / 1024);

      logScreenshotInfo(
        {
          agentId,
          conversationId,
          mimeType,
          base64Length: base64Data.length,
          estimatedSizeKB,
        },
        "[BrowserStream] Screenshot captured",
      );
    }

    // Get URL reliably using browser_evaluate instead of extracting from screenshot response
    // This ensures the URL matches the page content shown in the screenshot
    const url = await this.getCurrentUrl(agentId, conversationId, userContext);

    // NOTE: URL sync moved to websocket handler (sendScreenshot) to prevent race conditions
    // when user switches conversations while screenshot is in-flight.

    return {
      screenshot,
      url,
      viewportWidth: DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
      viewportHeight: DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
    };
  }

  /**
   * Extract text content from MCP response
   */
  private extractTextContent(content: unknown): string {
    if (!Array.isArray(content)) return "";

    return content
      .filter(
        (item): item is { type: string; text: string } =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item,
      )
      .map((item) => item.text)
      .join("\n");
  }

  /**
   * Extract screenshot (base64 image) from MCP response
   */
  private extractScreenshot(content: unknown): string | undefined {
    if (!Array.isArray(content)) return undefined;

    // Look for image content
    for (const item of content) {
      if (
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        item.type === "image" &&
        "data" in item
      ) {
        // Return as data URL
        const mimeType =
          "mimeType" in item ? (item.mimeType as string) : "image/png";
        return `data:${mimeType};base64,${item.data}`;
      }
    }

    // Some tools might return base64 in text content
    const textContent = this.extractTextContent(content);
    if (textContent.startsWith("data:image")) {
      return textContent;
    }

    return undefined;
  }

  /**
   * Get current page URL using browser_tabs
   * Parses the current tab's URL from the tabs list
   */
  private isBlankUrl(url: string | undefined): boolean {
    if (!url) {
      return true;
    }
    return url.toLowerCase().startsWith("about:blank");
  }

  private extractCurrentUrlFromTabsContent(
    content: unknown,
  ): string | undefined {
    const textContent = this.extractTextContent(content);

    const currentUrlFromJson = this.extractCurrentUrlFromTabsJson(textContent);
    if (currentUrlFromJson) {
      return currentUrlFromJson;
    }

    const currentTabMatch = textContent.match(
      /\(current\)[^()]*\(((?:https?|about):\/\/[^)]+)\)/,
    );
    return currentTabMatch?.[1];
  }

  private extractCurrentUrlFromTabsJson(
    textContent: string,
  ): string | undefined {
    if (textContent.trim() === "") return undefined;

    const parseTabIndexValue = (value: unknown): number | null => {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          return parsed;
        }
      }
      return null;
    };

    const isCurrentTabFlag = (
      flag: unknown,
      candidateIndex: number | null,
    ): boolean => {
      if (flag === true) return true;
      if (typeof flag === "string") {
        const normalized = flag.trim().toLowerCase();
        if (normalized === "true") return true;
        const numericFlag = parseTabIndexValue(flag);
        if (numericFlag === 1) return true;
        if (numericFlag === 0) return false;
        if (numericFlag !== null && candidateIndex !== null) {
          return numericFlag === candidateIndex;
        }
      }
      if (typeof flag === "number") {
        if (flag === 1) return true;
        if (flag === 0) return false;
        if (candidateIndex !== null) {
          return flag === candidateIndex;
        }
      }
      return false;
    };

    const findCurrentUrlInTabs = (
      tabs: unknown[],
      currentIndex: number | null,
    ): string | undefined => {
      if (currentIndex !== null) {
        for (const item of tabs) {
          if (typeof item !== "object" || item === null) continue;
          const candidate = item as Record<string, unknown>;
          const candidateIndex = parseTabIndexValue(
            candidate.index ?? candidate.id ?? candidate.tabIndex,
          );
          if (candidateIndex !== null && candidateIndex === currentIndex) {
            if (typeof candidate.url === "string") {
              return candidate.url;
            }
          }
        }

        if (currentIndex >= 0 && currentIndex < tabs.length) {
          const fallback = tabs[currentIndex];
          if (typeof fallback === "object" && fallback !== null) {
            const candidate = fallback as Record<string, unknown>;
            if (typeof candidate.url === "string") {
              return candidate.url;
            }
          }
        }
      }

      for (const item of tabs) {
        if (typeof item !== "object" || item === null) continue;
        const candidate = item as Record<string, unknown>;
        if (typeof candidate.url !== "string") continue;
        const candidateIndex = parseTabIndexValue(
          candidate.index ?? candidate.id ?? candidate.tabIndex,
        );
        const currentFlag =
          candidate.current ??
          candidate.isCurrent ??
          candidate.is_current ??
          candidate.active ??
          candidate.selected;
        if (isCurrentTabFlag(currentFlag, candidateIndex)) {
          return candidate.url;
        }
      }

      return undefined;
    };

    try {
      const parsed: unknown = JSON.parse(textContent);
      if (Array.isArray(parsed)) {
        return findCurrentUrlInTabs(parsed, null);
      }

      if (typeof parsed === "object" && parsed !== null) {
        const candidate = parsed as Record<string, unknown>;
        const currentIndex = parseTabIndexValue(
          candidate.currentIndex ??
            candidate.current_index ??
            candidate.selectedIndex ??
            candidate.selected_index,
        );
        const tabs = candidate.tabs;

        if (Array.isArray(tabs)) {
          return findCurrentUrlInTabs(tabs, currentIndex);
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  async getCurrentUrl(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<string | undefined> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      return undefined;
    }

    try {
      const listData = await this.getTabsList({
        agentId,
        conversationId,
        userContext,
        tabsTool,
      });
      if (!listData) {
        return undefined;
      }
      return this.extractCurrentUrlFromTabsContent(listData.content);
    } catch {
      return undefined;
    }
  }

  /**
   * Find the Playwright browser run_code tool for an agent
   * This tool allows running arbitrary Playwright code including mouse operations
   */
  private async findRunCodeTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_run_code"),
    );
  }

  /**
   * Click on an element using element ref from snapshot OR coordinates
   * For coordinates, uses browser_run_code to perform Playwright mouse.click()
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param userContext - User context for MCP authentication
   * @param element - Element reference (e.g., "e123") or selector
   * @param x - X coordinate for click (optional)
   * @param y - Y coordinate for click (optional)
   */
  async click(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    element?: string,
    x?: number,
    y?: number,
  ): Promise<ClickResult> {
    const tabResult = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      throw new ApiError(
        500,
        tabResult.error ?? "Failed to select browser tab",
      );
    }

    // Ensure viewport matches screenshot dimensions for accurate coordinate clicks
    if (x !== undefined && y !== undefined) {
      await this.resizeBrowser(agentId, conversationId, userContext);
    }

    if (x !== undefined && y !== undefined) {
      // Use browser_run_code for native Playwright mouse click
      const runCodeTool = await this.findRunCodeTool(agentId);
      if (runCodeTool) {
        // Validate coordinates to prevent code injection and ensure reasonable bounds
        const safeX = Math.round(x);
        const safeY = Math.round(y);
        if (
          !Number.isFinite(safeX) ||
          !Number.isFinite(safeY) ||
          safeX < 0 ||
          safeY < 0 ||
          safeX > 10000 ||
          safeY > 10000
        ) {
          throw new ApiError(
            400,
            `Invalid click coordinates: x=${x}, y=${y}. Must be finite numbers between 0 and 10000.`,
          );
        }

        logger.debug(
          { agentId, conversationId, x: safeX, y: safeY },
          "Clicking at coordinates via browser_run_code (Playwright mouse.click)",
        );

        // Native Playwright mouse click - async function with page argument
        const code = `async (page) => { await page.mouse.click(${safeX}, ${safeY}); }`;

        try {
          const result = await this.executeTool({
            toolName: runCodeTool,
            args: { code },
            agentId,
            conversationId,
            userContext,
          });

          if (!result.isError) {
            return { success: true };
          }

          const errorText = this.extractTextContent(result.content);
          logger.warn(
            { agentId, error: errorText },
            "browser_run_code click failed",
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          let errorDetails = "";
          if (error && typeof error === "object") {
            try {
              errorDetails = JSON.stringify(error);
            } catch {
              errorDetails = String(error);
            }
          }
          logger.warn(
            { agentId, error, errorMessage, errorDetails },
            "browser_run_code threw exception",
          );
        }
      }

      // No tool available or failed
      throw new ApiError(400, "browser_run_code failed for coordinate clicks");
    } else if (element) {
      // Element ref-based click using browser_click
      const toolName = await this.findClickTool(agentId);
      if (!toolName) {
        throw new ApiError(
          400,
          "No browser click tool available for this agent",
        );
      }

      logger.debug(
        { agentId, conversationId, element },
        "Clicking element via MCP",
      );

      const result = await this.executeTool({
        toolName,
        args: { element, ref: element },
        agentId,
        conversationId,
        userContext,
      });

      if (result.isError) {
        const errorText = this.extractTextContent(result.content);
        throw new ApiError(500, errorText || "Click failed");
      }

      return { success: true };
    } else {
      throw new ApiError(400, "Either element ref or coordinates required");
    }
  }

  /**
   * Type text into the currently focused element or specified element
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param userContext - User context for MCP authentication
   * @param text - Text to type
   * @param element - Optional element reference to focus first
   */
  async type(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    text: string,
    element?: string,
  ): Promise<TypeResult> {
    const tabResult = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      throw new ApiError(
        500,
        tabResult.error ?? "Failed to select browser tab",
      );
    }

    // If no element specified, use page.keyboard.type() to type into focused element
    if (!element) {
      const runCodeTool = await this.findRunCodeTool(agentId);
      if (runCodeTool) {
        logger.debug(
          { agentId, conversationId, textLength: text.length },
          "Typing text into focused element via browser_run_code",
        );

        // Use JSON.stringify for safe escaping of all special characters
        const safeText = JSON.stringify(text);
        // Native Playwright keyboard type - async function with page argument
        const playwrightCode = `async (page) => { await page.keyboard.type(${safeText}); }`;

        const result = await this.executeTool({
          toolName: runCodeTool,
          args: { code: playwrightCode },
          agentId,
          conversationId,
          userContext,
        });

        if (!result.isError) {
          return { success: true };
        }

        const errorText = this.extractTextContent(result.content);
        logger.warn(
          { agentId, error: errorText },
          "browser_run_code type failed, trying browser_type",
        );
      }
    }

    // Fall back to browser_type tool (requires element ref)
    const toolName = await this.findTypeTool(agentId);
    if (!toolName) {
      throw new ApiError(400, "No browser type tool available for this agent");
    }

    logger.debug(
      { agentId, conversationId, textLength: text.length, element },
      "Typing text via browser_type MCP tool",
    );

    const typeArgs: Record<string, string> = { text };
    if (element) {
      typeArgs.element = element;
      typeArgs.ref = element;
    }

    const result = await this.executeTool({
      toolName,
      args: typeArgs,
      agentId,
      conversationId,
      userContext,
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Type failed");
    }

    return { success: true };
  }

  /**
   * Press a key (for scrolling, enter, tab, etc.)
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param userContext - User context for MCP authentication
   * @param key - Key to press (e.g., "Enter", "Tab", "ArrowDown", "PageDown")
   */
  async pressKey(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    key: string,
  ): Promise<ScrollResult> {
    const tabResult = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      throw new ApiError(
        500,
        tabResult.error ?? "Failed to select browser tab",
      );
    }

    const toolName = await this.findPressKeyTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser press key tool available for this agent",
      );
    }

    logger.debug({ agentId, conversationId, key }, "Pressing key via MCP");

    const result = await this.executeTool({
      toolName,
      args: { key },
      agentId,
      conversationId,
      userContext,
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Key press failed");
    }

    return { success: true };
  }

  /**
   * Get accessibility snapshot of the page (shows clickable elements with refs)
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param userContext - User context for MCP authentication
   */
  async getSnapshot(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<SnapshotResult> {
    const tabResult = await this.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );
    if (!tabResult.success) {
      throw new ApiError(
        500,
        tabResult.error ?? "Failed to select browser tab",
      );
    }

    const toolName = await this.findSnapshotTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser snapshot tool available for this agent",
      );
    }

    logger.debug(
      { agentId, conversationId },
      "Getting browser snapshot via MCP",
    );

    const result = await this.executeTool({
      toolName,
      args: {},
      agentId,
      conversationId,
      userContext,
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Snapshot failed");
    }

    const snapshot = this.extractTextContent(result.content);
    return { snapshot };
  }
}
