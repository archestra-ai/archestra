import {
  DEFAULT_BROWSER_PREVIEW_URL,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_HEIGHT,
  DEFAULT_BROWSER_PREVIEW_VIEWPORT_WIDTH,
  isBrowserMcpTool,
  TimeInMs,
} from "@shared";
import { LRUCacheManager } from "@/cache-manager";
import { getChatMcpClient } from "@/clients/chat-mcp-client";
import logger from "@/logging";
import {
  ConversationModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { ApiError } from "@/types";
import {
  shouldLogBrowserStreamScreenshots,
  shouldLogBrowserStreamTabSync,
} from "./browser-stream.log-settings";
import {
  applyTabsClose,
  applyTabsCreate,
  applyTabsList,
  applyUpdateCurrentUrl,
  resolveIndexForTab,
} from "./browser-stream.state";
import {
  createInitialState,
  generateTabId,
} from "./browser-stream.state.conversion";
import { isErr, isOk, isSome } from "./browser-stream.state.helpers";
import {
  type BrowserState,
  type BrowserTabsListEntry,
  None,
  Some,
} from "./browser-stream.state.types";
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

const TABS_LIST_CACHE_TTL_MS = 3000;

type BrowserTabsListData = {
  content: unknown;
  tabs: Array<{ index: number; title?: string; url?: string }>;
};

type TabsListCacheEntry = {
  expiresAt: number;
  value: BrowserTabsListData;
};

type BrowserTabsAction = "list" | "new" | "close" | "select";

type CreatedTabResult =
  | { success: true; tabIndex: number; initialUrl: string }
  | { success: false; error: string };

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

// NOTE: Aggressive orphaned tab cleanup was removed in favor of state/browser mismatch handling.
// The mismatch handler creates new tabs and restores URLs as needed, making cleanup unnecessary.
// This avoids race conditions and prevents destroying tabs for other conversations.

/**
 * Cache for agent tools to avoid repeated database queries during browser streaming.
 * Uses LRU eviction with 30-second TTL. Shared across all BrowserStreamService instances.
 */
const toolsCache = new LRUCacheManager<{ name: string }[]>({
  maxSize: 100,
  defaultTtl: 30 * TimeInMs.Second,
});

/**
 * Service for browser streaming via Playwright MCP
 * Calls Playwright MCP tools directly through the MCP Gateway
 */
export class BrowserStreamService {
  private readonly tabsListCache = new Map<string, TabsListCacheEntry>();
  private readonly tabSelectionLocks = new Map<
    ConversationStateKey,
    Promise<TabResult>
  >();

  /**
   * Get tools for an agent with caching to reduce database queries.
   * Tools are cached for 30 seconds with LRU eviction.
   * When userId is provided, also includes tools from globally available catalogs.
   */
  private async getToolsForAgent(
    agentId: string,
    userId?: string,
  ): Promise<{ name: string }[]> {
    // Include userId in cache key when provided
    const cacheKey = userId ? `${agentId}:${userId}` : agentId;
    const cached = toolsCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const toolNames = tools.map((t) => ({ name: t.name as string }));

    // If userId is provided, also include global catalog tools
    if (userId) {
      const globalTools = await this.getGlobalCatalogToolsForUser(userId);
      for (const tool of globalTools) {
        // Avoid duplicates
        if (!toolNames.some((t) => t.name === tool.name)) {
          toolNames.push(tool);
        }
      }
    }

    toolsCache.set(cacheKey, toolNames);

    return toolNames;
  }

  /**
   * Get tools from globally available catalogs for a user.
   * These are catalogs marked as `isGloballyAvailable` where the user has a personal server.
   */
  private async getGlobalCatalogToolsForUser(
    userId: string,
  ): Promise<{ name: string }[]> {
    const globalCatalogs =
      await InternalMcpCatalogModel.getGloballyAvailableCatalogs();

    if (globalCatalogs.length === 0) {
      return [];
    }

    const tools: { name: string }[] = [];

    for (const catalog of globalCatalogs) {
      // Check if user has a personal server for this catalog
      const userServer = await McpServerModel.getUserPersonalServerForCatalog(
        userId,
        catalog.id,
      );

      if (!userServer) {
        continue;
      }

      // Get tools from this catalog
      const catalogTools = await ToolModel.findByCatalogId(catalog.id);
      for (const tool of catalogTools) {
        tools.push({ name: tool.name });
      }
    }

    return tools;
  }

  private async findToolName(
    agentId: string,
    matches: (toolName: string) => boolean,
    userId?: string,
  ): Promise<string | null> {
    const tools = await this.getToolsForAgent(agentId, userId);

    for (const tool of tools) {
      const toolName = tool.name;
      if (typeof toolName === "string" && matches(toolName)) {
        return toolName;
      }
    }

    return null;
  }

  /**
   * Check if Playwright MCP browser tools are available for an agent
   * @param agentId - The agent ID
   * @param userId - Optional user ID to check global catalog tools
   */
  async checkAvailability(
    agentId: string,
    userId?: string,
  ): Promise<AvailabilityResult> {
    const tools = await this.getToolsForAgent(agentId, userId);
    const browserToolNames = tools.flatMap((tool) => {
      const toolName = tool.name;
      if (typeof toolName !== "string") return [];
      if (isBrowserMcpTool(toolName)) {
        return [toolName];
      }
      return [];
    });

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
  private async findNavigateTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => {
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
      },
      userId,
    );
  }

  /**
   * Find the Playwright browser navigate back tool for an agent
   * Matches tools like "browser_navigate_back" or "playwright__browser_navigate_back"
   */
  private async findNavigateBackTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_navigate_back"),
      userId,
    );
  }

  /**
   * Find the Playwright browser screenshot tool for an agent
   */
  private async findScreenshotTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    // Prefer browser_take_screenshot or browser_screenshot
    return this.findToolName(
      agentId,
      (toolName) =>
        toolName.includes("browser_take_screenshot") ||
        toolName.includes("browser_screenshot"),
      userId,
    );
  }

  /**
   * Find the Playwright browser tabs tool for an agent
   */
  private async findTabsTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_tabs"),
      userId,
    );
  }

  private getTabsListCacheKey(params: {
    agentId: string;
    userId: string;
    tabsTool: string;
  }): string {
    const { agentId, userId, tabsTool } = params;
    return `${agentId}:${userId}:${tabsTool}`;
  }

  private invalidateTabsListCache(params: {
    agentId: string;
    userContext: BrowserUserContext;
    tabsTool: string;
  }): void {
    const key = this.getTabsListCacheKey({
      agentId: params.agentId,
      userId: params.userContext.userId,
      tabsTool: params.tabsTool,
    });
    this.tabsListCache.delete(key);
  }

  private async getTabsList(params: {
    agentId: string;
    userContext: BrowserUserContext;
    client: NonNullable<Awaited<ReturnType<typeof getChatMcpClient>>>;
    tabsTool: string;
    forceRefresh?: boolean;
  }): Promise<BrowserTabsListData | null> {
    const { agentId, userContext, client, tabsTool, forceRefresh } = params;
    const cacheKey = this.getTabsListCacheKey({
      agentId,
      userId: userContext.userId,
      tabsTool,
    });
    const now = Date.now();
    const cached = this.tabsListCache.get(cacheKey);

    if (!forceRefresh && cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached && cached.expiresAt <= now) {
      this.tabsListCache.delete(cacheKey);
    }

    const listResult = await this.callTabsTool({
      agentId,
      userContext,
      client,
      tabsTool,
      action: "list",
    });

    if (listResult.isError) {
      return null;
    }

    const tabs = this.parseTabsList(listResult.content);
    const value = { content: listResult.content, tabs };

    this.tabsListCache.set(cacheKey, {
      expiresAt: now + TABS_LIST_CACHE_TTL_MS,
      value,
    });

    return value;
  }

  private async callTabsTool(params: {
    agentId: string;
    conversationId?: string;
    userContext: BrowserUserContext;
    client: NonNullable<Awaited<ReturnType<typeof getChatMcpClient>>>;
    tabsTool: string;
    action: BrowserTabsAction;
    index?: number;
  }) {
    const {
      agentId,
      conversationId,
      userContext,
      client,
      tabsTool,
      action,
      index,
    } = params;

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

    return client.callTool({
      name: tabsTool,
      arguments: index === undefined ? { action } : { action, index },
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

  private async selectOrCreateTabInternal(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    initialUrl?: string,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId, userContext.userId);
    if (!tabsTool) {
      logTabSyncInfo(
        { agentId, conversationId },
        "No browser_tabs tool available, using shared browser page",
      );
      return { success: true, tabIndex: 0 };
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      return { success: false, error: "Failed to connect to MCP Gateway" };
    }

    const stateKey = toConversationStateKey(
      agentId,
      userContext.userId,
      conversationId,
    );

    logTabSyncInfo(
      {
        stateKey,
        agentId,
        userId: userContext.userId,
        conversationId,
      },
      "selectOrCreateTab called",
    );

    try {
      // Load existing state from cache or database
      const loadResult = await browserStateManager.getOrLoad({
        agentId,
        userId: userContext.userId,
        conversationId,
      });

      if (isErr(loadResult)) {
        logger.warn(
          { agentId, conversationId, error: loadResult.error },
          "Failed to load browser state, will create new",
        );
      }

      const existingState = isOk(loadResult) ? loadResult.value : null;

      // If we have existing state with a tab, try to resolve its index
      if (existingState && existingState.tabs.length > 0) {
        const activeTab = existingState.tabs.find(
          (t) => t.id === existingState.activeTabId,
        );
        const storedUrl = activeTab?.current ?? "about:blank";
        const restoreUrl = this.isBlankUrl(storedUrl) ? null : storedUrl;
        let forceMismatch = false;
        let cachedList: BrowserTabsListData | null = null;

        const loadTabsList = async (): Promise<BrowserTabsListData | null> => {
          if (cachedList) {
            return cachedList;
          }
          const listData = await this.getTabsList({
            agentId,
            userContext,
            client,
            tabsTool,
          });
          if (!listData) {
            return null;
          }
          cachedList = listData;
          return cachedList;
        };

        // Check if we have a resolved index
        if (activeTab && isSome(activeTab.index)) {
          const existingTabIndex = activeTab.index.value;
          try {
            const selectExistingResult = await this.callTabsTool({
              agentId,
              conversationId,
              userContext,
              client,
              tabsTool,
              action: "select",
              index: existingTabIndex,
            });

            if (selectExistingResult.isError) {
              const errorText = this.extractTextContent(
                selectExistingResult.content,
              );
              logger.warn(
                {
                  agentId,
                  conversationId,
                  tabIndex: existingTabIndex,
                  error: errorText,
                },
                "Failed to select existing conversation tab, will sync indices",
              );
            } else {
              this.invalidateTabsListCache({ agentId, userContext, tabsTool });
              // Verify we actually selected the right tab by checking current tab index
              // browser_tabs select might not error when selecting non-existent index
              const verifyListData = await this.getTabsList({
                agentId,
                userContext,
                client,
                tabsTool,
                forceRefresh: true,
              });

              if (verifyListData) {
                cachedList = verifyListData;
                const verifyTabs = verifyListData.tabs;
                const currentTabIndex =
                  this.extractCurrentTabIndexFromTabsContent(
                    verifyListData.content,
                  );
                const currentUrl = this.extractCurrentUrlFromTabsContent(
                  verifyListData.content,
                );

                // Only treat as stale if we can positively confirm mismatch
                const indexMismatch =
                  currentTabIndex !== undefined &&
                  currentTabIndex !== existingTabIndex;

                if (indexMismatch) {
                  forceMismatch = true;
                  logger.warn(
                    {
                      agentId,
                      conversationId,
                      expectedIndex: existingTabIndex,
                      actualIndex: currentTabIndex,
                      storedUrl,
                      currentUrl,
                      tabCount: verifyTabs.length,
                    },
                    "[BrowserTabs] Stale tab selection detected, triggering mismatch handling",
                  );
                } else {
                  await this.restoreUrlIfNeeded({
                    agentId,
                    conversationId,
                    userId: userContext.userId,
                    storedUrl,
                    currentUrl,
                    client,
                  });

                  logTabSyncInfo(
                    {
                      agentId,
                      conversationId,
                      tabIndex: existingTabIndex,
                      action: "switch_to_existing_tab",
                    },
                    "[BrowserTabs] Switched to existing tab for conversation",
                  );
                  return { success: true, tabIndex: existingTabIndex };
                }
              }
            }
          } catch (selectError) {
            logger.warn(
              {
                agentId,
                conversationId,
                tabIndex: existingTabIndex,
                error:
                  selectError instanceof Error
                    ? selectError.message
                    : String(selectError),
              },
              "Exception selecting existing tab, will sync indices",
            );
          }
        }

        if (!forceMismatch) {
          // If index unavailable or selection failed, sync with browser_tabs.list
          const listData = await loadTabsList();

          if (listData) {
            const listEntries = this.toBrowserTabsListEntries(
              listData.tabs,
              listData.content,
            );

            // Check if tab counts match - if so, sync indices
            if (listEntries.length === existingState.tabs.length) {
              const syncResult = applyTabsList({
                state: existingState,
                list: listEntries,
              });

              if (isOk(syncResult)) {
                const updatedState = syncResult.value;
                await browserStateManager.set({
                  agentId,
                  userId: userContext.userId,
                  conversationId,
                  state: updatedState,
                });

                const indexResult = resolveIndexForTab({
                  state: updatedState,
                  tabId: updatedState.activeTabId,
                });

                if (isOk(indexResult)) {
                  await this.callTabsTool({
                    agentId,
                    conversationId,
                    userContext,
                    client,
                    tabsTool,
                    action: "select",
                    index: indexResult.value,
                  });
                  this.invalidateTabsListCache({
                    agentId,
                    userContext,
                    tabsTool,
                  });

                  const currentUrl = this.extractCurrentUrlFromTabsContent(
                    listData.content,
                  );
                  await this.restoreUrlIfNeeded({
                    agentId,
                    conversationId,
                    userId: userContext.userId,
                    storedUrl,
                    currentUrl,
                    client,
                  });

                  logTabSyncInfo(
                    {
                      agentId,
                      conversationId,
                      tabIndex: indexResult.value,
                      action: "synced_and_selected",
                    },
                    "[BrowserTabs] Synced indices and selected active tab",
                  );
                  return { success: true, tabIndex: indexResult.value };
                }
              }
            }
          }
        }

        const listData = await loadTabsList();
        const listTabs = listData?.tabs ?? [];
        const matchedIndex =
          restoreUrl !== null
            ? this.findTabIndexByUrl(listTabs, storedUrl)
            : null;

        if (matchedIndex !== null) {
          await this.callTabsTool({
            agentId,
            conversationId,
            userContext,
            client,
            tabsTool,
            action: "select",
            index: matchedIndex,
          });
          this.invalidateTabsListCache({ agentId, userContext, tabsTool });
          const updatedState = this.resetIndicesWithActive(
            existingState,
            matchedIndex,
          );
          await browserStateManager.set({
            agentId,
            userId: userContext.userId,
            conversationId,
            state: updatedState,
          });

          logTabSyncInfo(
            {
              agentId,
              conversationId,
              tabIndex: matchedIndex,
              action: "matched_by_url",
            },
            "[BrowserTabs] Matched stored URL to existing tab",
          );
          return { success: true, tabIndex: matchedIndex };
        }

        const blankIndex = this.findBlankTabIndex(listTabs);
        if (blankIndex !== null) {
          await this.callTabsTool({
            agentId,
            conversationId,
            userContext,
            client,
            tabsTool,
            action: "select",
            index: blankIndex,
          });
          this.invalidateTabsListCache({ agentId, userContext, tabsTool });
          const updatedState = this.resetIndicesWithActive(
            existingState,
            blankIndex,
          );
          await browserStateManager.set({
            agentId,
            userId: userContext.userId,
            conversationId,
            state: updatedState,
          });

          await this.restoreUrlIfNeeded({
            agentId,
            conversationId,
            userId: userContext.userId,
            storedUrl,
            currentUrl: "about:blank",
            client,
          });

          logTabSyncInfo(
            {
              agentId,
              conversationId,
              tabIndex: blankIndex,
              action: "reused_blank_tab",
            },
            "[BrowserTabs] Reused about:blank tab for conversation",
          );
          return { success: true, tabIndex: blankIndex };
        }

        const createdResult = await this.createNewTabIndex({
          agentId,
          conversationId,
          userContext,
          client,
          tabsTool,
          restoreUrl,
        });

        if (!createdResult.success) {
          return { success: false, error: createdResult.error };
        }

        const updatedState = this.resetIndicesWithActive(
          existingState,
          createdResult.tabIndex,
        );
        await browserStateManager.set({
          agentId,
          userId: userContext.userId,
          conversationId,
          state: updatedState,
        });

        logger.warn(
          {
            agentId,
            conversationId,
            tabIndex: createdResult.tabIndex,
            action: "created_new_tab",
          },
          "[BrowserTabs] Created new tab after mismatch",
        );

        return { success: true, tabIndex: createdResult.tabIndex };
      }

      // No existing state - reuse about:blank tab when possible
      const listData = await this.getTabsList({
        agentId,
        userContext,
        client,
        tabsTool,
      });

      if (listData) {
        const blankIndex = this.findBlankTabIndex(listData.tabs);
        if (blankIndex !== null) {
          await this.callTabsTool({
            agentId,
            conversationId,
            userContext,
            client,
            tabsTool,
            action: "select",
            index: blankIndex,
          });
          this.invalidateTabsListCache({ agentId, userContext, tabsTool });

          // Navigate to initial URL (or default) for new conversations
          const targetUrl = initialUrl || DEFAULT_BROWSER_PREVIEW_URL;

          const tabId = generateTabId();
          const initialState = createInitialState(tabId, targetUrl);
          const stateWithIndex: BrowserState = {
            ...initialState,
            tabs: initialState.tabs.map((t) =>
              t.id === tabId ? { ...t, index: Some(blankIndex) } : t,
            ),
          };

          await browserStateManager.set({
            agentId,
            userId: userContext.userId,
            conversationId,
            state: stateWithIndex,
          });

          logTabSyncInfo(
            {
              agentId,
              conversationId,
              tabIndex: blankIndex,
              action: "reused_blank_tab",
            },
            "[BrowserTabs] Reused about:blank tab for new conversation",
          );

          return { success: true, tabIndex: blankIndex };
        }
      }

      // No existing state and no reusable tab - create new
      return this.createNewTabWithUrl(
        agentId,
        conversationId,
        userContext,
        client,
        tabsTool,
        initialUrl || null, // Use initial URL if provided
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { error, agentId, conversationId },
        "Tab select/create failed",
      );
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Create a new browser tab and optionally navigate to a URL.
   * Used both for new conversations and for restoring after state/browser mismatch.
   */
  private async createNewTabIndex(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    client: NonNullable<Awaited<ReturnType<typeof getChatMcpClient>>>;
    tabsTool: string;
    restoreUrl: string | null;
  }): Promise<CreatedTabResult> {
    const {
      agentId,
      conversationId,
      userContext,
      client,
      tabsTool,
      restoreUrl,
    } = params;
    const listData = await this.getTabsList({
      agentId,
      userContext,
      client,
      tabsTool,
      forceRefresh: true,
    });

    if (!listData) {
      return { success: false, error: "Failed to list tabs" };
    }

    const existingTabs = listData.tabs;
    const expectedNewTabIndex = this.getMaxTabIndex(existingTabs) + 1;

    const createResult = await this.callTabsTool({
      agentId,
      conversationId,
      userContext,
      client,
      tabsTool,
      action: "new",
    });

    if (createResult.isError) {
      const errorText = this.extractTextContent(createResult.content);
      return { success: false, error: errorText || "Failed to create tab" };
    }

    this.invalidateTabsListCache({ agentId, userContext, tabsTool });
    const postCreateList = await this.getTabsList({
      agentId,
      userContext,
      client,
      tabsTool,
      forceRefresh: true,
    });

    const postCreateTabs = postCreateList?.tabs ?? [];
    const existingIndexSet = new Set(existingTabs.map((tab) => tab.index));

    let resolvedTabIndex: number | null = null;
    if (postCreateList) {
      const newIndices = postCreateTabs
        .map((tab) => tab.index)
        .filter(
          (index) => Number.isInteger(index) && !existingIndexSet.has(index),
        );
      const uniqueNewIndices = Array.from(new Set(newIndices));

      if (uniqueNewIndices.length === 1) {
        resolvedTabIndex = uniqueNewIndices[0];
      } else if (uniqueNewIndices.length > 1) {
        resolvedTabIndex = uniqueNewIndices.includes(expectedNewTabIndex)
          ? expectedNewTabIndex
          : Math.max(...uniqueNewIndices);
      }
    }

    if (resolvedTabIndex === null) {
      resolvedTabIndex =
        postCreateTabs.length > 0
          ? this.getMaxTabIndex(postCreateTabs)
          : expectedNewTabIndex;
    }

    const selectNewResult = await this.callTabsTool({
      agentId,
      conversationId,
      userContext,
      client,
      tabsTool,
      action: "select",
      index: resolvedTabIndex,
    });

    if (selectNewResult.isError) {
      const errorText = this.extractTextContent(selectNewResult.content);
      return { success: false, error: errorText || "Failed to select tab" };
    }
    this.invalidateTabsListCache({ agentId, userContext, tabsTool });

    // Navigate to restore URL or default URL for new conversations
    const initialUrl = restoreUrl || DEFAULT_BROWSER_PREVIEW_URL;

    return { success: true, tabIndex: resolvedTabIndex, initialUrl };
  }

  private async createNewTabWithUrl(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
    client: NonNullable<Awaited<ReturnType<typeof getChatMcpClient>>>,
    tabsTool: string,
    restoreUrl: string | null,
  ): Promise<TabResult> {
    const createdResult = await this.createNewTabIndex({
      agentId,
      conversationId,
      userContext,
      client,
      tabsTool,
      restoreUrl,
    });

    if (!createdResult.success) {
      return { success: false, error: createdResult.error };
    }

    const { tabIndex, initialUrl } = createdResult;

    // Create initial state with the new tab
    const tabId = generateTabId();
    const initialState = createInitialState(tabId, initialUrl);
    // Update the tab with the resolved index
    const stateWithIndex: BrowserState = {
      ...initialState,
      tabs: initialState.tabs.map((t) =>
        t.id === tabId ? { ...t, index: Some(tabIndex as number) } : t,
      ),
    };

    await browserStateManager.set({
      agentId,
      userId: userContext.userId,
      conversationId,
      state: stateWithIndex,
    });

    logTabSyncInfo(
      {
        agentId,
        conversationId,
        tabIndex,
        tabId,
        initialUrl,
        action: "created_new_tab",
      },
      "[BrowserTabs] Created new tab for conversation",
    );
    return { success: true, tabIndex };
  }

  private resetIndicesWithActive(
    state: BrowserState,
    activeIndex: number,
  ): BrowserState {
    return {
      ...state,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        index: tab.id === state.activeTabId ? Some(activeIndex) : None,
      })),
    };
  }

  private findTabIndexByUrl(
    tabs: Array<{ index: number; title?: string; url?: string }>,
    targetUrl: string,
  ): number | null {
    for (const tab of tabs) {
      if (tab.url === targetUrl) {
        return tab.index;
      }
    }
    return null;
  }

  private findBlankTabIndex(
    tabs: Array<{ index: number; title?: string; url?: string }>,
  ): number | null {
    for (const tab of tabs) {
      if (this.isBlankUrl(tab.url)) {
        return tab.index;
      }
    }
    return null;
  }

  private async restoreUrlIfNeeded(params: {
    agentId: string;
    conversationId: string;
    userId: string;
    storedUrl: string;
    currentUrl?: string;
    client: NonNullable<Awaited<ReturnType<typeof getChatMcpClient>>>;
  }): Promise<void> {
    const { agentId, conversationId, userId, storedUrl, currentUrl, client } =
      params;
    if (this.isBlankUrl(storedUrl)) {
      return;
    }
    if (currentUrl !== undefined && !this.isBlankUrl(currentUrl)) {
      return;
    }

    const navigateTool = await this.findNavigateTool(agentId, userId);
    if (!navigateTool) {
      return;
    }

    logTabSyncInfo(
      { agentId, conversationId, storedUrl, currentUrl },
      "[BrowserTabs] Restoring URL after restart",
    );

    try {
      await client.callTool({
        name: navigateTool,
        arguments: { url: storedUrl },
      });
    } catch (error) {
      // URL restoration is non-critical - log and continue
      // The tab is still usable, just won't have the previous URL restored
      logger.warn(
        {
          agentId,
          conversationId,
          storedUrl,
          error: error instanceof Error ? error.message : String(error),
        },
        "[BrowserTabs] Failed to restore URL after restart",
      );
    }
  }

  /**
   * Convert parsed tabs list to BrowserTabsListEntry format
   * Uses the actual current tab from the tool response, not hardcoded index 0
   */
  private toBrowserTabsListEntries(
    tabs: Array<{ index: number; title?: string; url?: string }>,
    toolResponseContent: unknown,
  ): BrowserTabsListEntry[] {
    // Extract actual current tab index from tool response
    const currentIndex =
      this.extractCurrentTabIndexFromTabsContent(toolResponseContent) ?? 0;
    return tabs.map((t) => ({
      index: t.index,
      isCurrent: t.index === currentIndex,
    }));
  }

  /**
   * Find the Playwright browser click tool for an agent
   */
  private async findClickTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_click"),
      userId,
    );
  }

  /**
   * Find the Playwright browser type tool for an agent
   */
  private async findTypeTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_type"),
      userId,
    );
  }

  /**
   * Find the Playwright browser press key tool for an agent
   */
  private async findPressKeyTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_press_key"),
      userId,
    );
  }

  /**
   * Find the Playwright browser snapshot tool for an agent
   */
  private async findSnapshotTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_snapshot"),
      userId,
    );
  }

  /**
   * Find the Playwright browser resize tool for an agent
   */
  private async findResizeTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_resize"),
      userId,
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
    const resizeTool = await this.findResizeTool(agentId, userContext.userId);
    if (!resizeTool) {
      logger.debug(
        { agentId },
        "No browser_resize tool available, using default viewport",
      );
      return;
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      return;
    }

    try {
      logger.debug({ agentId, width, height }, "Resizing browser viewport");

      const result = await client.callTool({
        name: resizeTool,
        arguments: { width, height },
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

    const toolName = await this.findNavigateTool(agentId, userContext.userId);
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

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      logger.error(
        { agentId, conversationId },
        "[BrowserNavigate] Failed to get MCP client",
      );
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    // Resize browser to ensure proper viewport dimensions before navigation
    // This ensures the page loads with the correct viewport from the start
    await this.resizeBrowser(agentId, conversationId, userContext);

    logger.debug(
      { agentId, conversationId, toolName, url },
      "[BrowserNavigate] Calling MCP navigate tool",
    );

    const result = await client.callTool({
      name: toolName,
      arguments: { url },
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

    // Update current URL in state for page restoration when switching conversations
    const loadResult = await browserStateManager.getOrLoad({
      agentId,
      userId: userContext.userId,
      conversationId,
    });

    if (isOk(loadResult) && loadResult.value) {
      const state = loadResult.value;
      const updateResult = applyUpdateCurrentUrl({
        state,
        tabId: state.activeTabId,
        url: resolvedUrl,
      });

      if (isOk(updateResult)) {
        await browserStateManager.set({
          agentId,
          userId: userContext.userId,
          conversationId,
          state: updateResult.value,
        });
        logTabSyncInfo(
          {
            agentId,
            conversationId,
            url: resolvedUrl,
            tabId: state.activeTabId,
          },
          "[BrowserTabs] Updated current URL",
        );
      }
    }

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
    const navigateBackTool = await this.findNavigateBackTool(
      agentId,
      userContext.userId,
    );
    if (!navigateBackTool) {
      logger.error(
        { agentId, conversationId },
        "[BrowserNavigateBack] No navigate back tool available",
      );
      throw new ApiError(400, "No browser navigate back tool available");
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      logger.error(
        { agentId, conversationId },
        "[BrowserNavigateBack] Failed to get MCP client",
      );
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.debug(
      { agentId, conversationId, toolName: navigateBackTool },
      "[BrowserNavigateBack] Calling browser navigate back tool",
    );

    const result = await client.callTool({
      name: navigateBackTool,
      arguments: {},
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
      const loadResult = await browserStateManager.getOrLoad({
        agentId,
        userId: userContext.userId,
        conversationId,
      });

      if (isOk(loadResult) && loadResult.value) {
        const state = loadResult.value;
        const updateResult = applyUpdateCurrentUrl({
          state,
          tabId: state.activeTabId,
          url: actualUrl,
        });

        if (isOk(updateResult)) {
          await browserStateManager.set({
            agentId,
            userId: userContext.userId,
            conversationId,
            state: updateResult.value,
          });
          logTabSyncInfo(
            { agentId, conversationId, url: actualUrl },
            "[BrowserNavigateBack] Updated current URL after back navigation",
          );
        }
      }
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
    const tabsTool = await this.findTabsTool(agentId, userContext.userId);
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
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId, userContext.userId);
    if (!tabsTool) {
      throw new ApiError(400, "No browser tabs tool available");
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
    );

    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    const listData = await this.getTabsList({
      agentId,
      userContext,
      client,
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
   * Uses persisted browser state to track tab indices.
   */
  async closeTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId, userContext.userId);
    if (!tabsTool) {
      await browserStateManager.clear({
        agentId,
        userId: userContext.userId,
        conversationId,
      });
      return { success: true };
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      await browserStateManager.clear({
        agentId,
        userId: userContext.userId,
        conversationId,
      });
      return { success: true };
    }

    // Load state to get tab index
    const loadResult = await browserStateManager.getOrLoad({
      agentId,
      userId: userContext.userId,
      conversationId,
    });

    let tabIndex: number | undefined;
    if (isOk(loadResult) && loadResult.value) {
      const state = loadResult.value;
      const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
      if (activeTab && isSome(activeTab.index)) {
        tabIndex = activeTab.index.value;
      }
    }

    // If we don't have the tab index, try to find it from browser
    if (tabIndex === undefined) {
      logTabSyncInfo(
        { agentId, conversationId },
        "Tab index not in state, checking browser tabs",
      );

      try {
        const listData = await this.getTabsList({
          agentId,
          userContext,
          client,
          tabsTool,
          forceRefresh: true,
        });

        if (listData) {
          const tabs = listData.tabs;
          if (tabs.length <= 1) {
            await browserStateManager.clear({
              agentId,
              userId: userContext.userId,
              conversationId,
            });
            return { success: true };
          }

          // Close the highest-indexed tab as best-effort
          const maxTab = tabs.reduce((max, tab) =>
            tab.index > max.index ? tab : max,
          );
          if (maxTab.index > 0) {
            tabIndex = maxTab.index;
            logTabSyncInfo(
              { agentId, conversationId, tabIndex },
              "Closing most recent tab as best-effort cleanup",
            );
          }
        }
      } catch (error) {
        logger.warn(
          { error, agentId, conversationId },
          "Failed to list tabs for cleanup",
        );
        await browserStateManager.clear({
          agentId,
          userId: userContext.userId,
          conversationId,
        });
        return { success: true };
      }
    }

    if (tabIndex === undefined || tabIndex === 0) {
      logTabSyncInfo(
        { agentId, conversationId, tabIndex },
        "[BrowserTabs] No tab to close (undefined or tab 0)",
      );
      await browserStateManager.clear({
        agentId,
        userId: userContext.userId,
        conversationId,
      });
      return { success: true };
    }

    logTabSyncInfo(
      {
        agentId,
        conversationId,
        closingTabIndex: tabIndex,
      },
      "[BrowserTabs] Closing tab",
    );

    try {
      await this.callTabsTool({
        agentId,
        conversationId,
        userContext,
        client,
        tabsTool,
        action: "close",
        index: tabIndex,
      });
      this.invalidateTabsListCache({ agentId, userContext, tabsTool });

      // Clear the state for this conversation
      await browserStateManager.clear({
        agentId,
        userId: userContext.userId,
        conversationId,
      });

      logTabSyncInfo(
        {
          agentId,
          conversationId,
          closedTabIndex: tabIndex,
        },
        "[BrowserTabs] Closed tab and cleared state",
      );

      return { success: true };
    } catch (error) {
      logger.error({ error, agentId, conversationId }, "Failed to close tab");
      // Clear state anyway to prevent stale data, but report failure
      await browserStateManager.clear({
        agentId,
        userId: userContext.userId,
        conversationId,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to close tab",
      };
    }
  }

  /**
   * Clean up orphaned browser tabs that don't belong to any active conversation.
   * This is called in the background after subscribing to prevent tab accumulation.
   *
   * An orphaned tab is a tab in the browser that doesn't match any conversation's
   * stored browser state. This can happen when:
   * - Server restarts and state is stale
   * - Conversations are deleted but tabs weren't closed
   * - State/browser mismatches create extra tabs during recovery
   *
   * @returns Number of tabs closed
   */
  async cleanupOrphanedTabs(
    agentId: string,
    userContext: BrowserUserContext,
  ): Promise<number> {
    const tabsTool = await this.findTabsTool(agentId, userContext.userId);
    if (!tabsTool) {
      return 0;
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      return 0;
    }

    try {
      // Get current browser tabs
      const listData = await this.getTabsList({
        agentId,
        userContext,
        client,
        tabsTool,
        forceRefresh: true,
      });

      if (!listData || listData.tabs.length <= 1) {
        // Only 0 or 1 tab - nothing to clean up (keep at least one tab)
        return 0;
      }

      // Get all conversations that have browser state for this agent/user
      const conversationIds =
        await ConversationModel.getConversationIdsWithBrowserStateByAgent(
          agentId,
          userContext.userId,
        );

      // Build set of tab indices owned by active conversations
      const ownedTabIndices = new Set<number>();

      for (const conversationId of conversationIds) {
        const loadResult = await browserStateManager.getOrLoad({
          agentId,
          userId: userContext.userId,
          conversationId,
        });

        if (isOk(loadResult) && loadResult.value) {
          const state = loadResult.value;
          for (const tab of state.tabs) {
            if (isSome(tab.index)) {
              ownedTabIndices.add(tab.index.value);
            }
          }
        }
      }

      // Find orphaned tabs (not owned by any conversation, and not tab 0 which we always keep)
      const orphanedTabIndices = listData.tabs
        .filter((tab) => tab.index > 0 && !ownedTabIndices.has(tab.index))
        .map((tab) => tab.index)
        .sort((a, b) => b - a); // Sort descending to close from highest index first

      if (orphanedTabIndices.length === 0) {
        return 0;
      }

      logger.info(
        {
          agentId,
          userId: userContext.userId,
          orphanedTabIndices,
          totalTabs: listData.tabs.length,
          ownedTabCount: ownedTabIndices.size,
        },
        "Cleaning up orphaned browser tabs",
      );

      // Close orphaned tabs (from highest to lowest to avoid index shifting issues)
      let closedCount = 0;
      for (const tabIndex of orphanedTabIndices) {
        try {
          await this.callTabsTool({
            agentId,
            conversationId: "orphan-cleanup", // Placeholder - not tied to a conversation
            userContext,
            client,
            tabsTool,
            action: "close",
            index: tabIndex,
          });
          closedCount++;
        } catch (error) {
          logger.warn(
            { agentId, tabIndex, error },
            "Failed to close orphaned tab",
          );
        }
      }

      // Invalidate cache after cleanup
      this.invalidateTabsListCache({ agentId, userContext, tabsTool });

      logger.info(
        {
          agentId,
          userId: userContext.userId,
          closedCount,
          attemptedCount: orphanedTabIndices.length,
        },
        "Completed orphan tab cleanup",
      );

      return closedCount;
    } catch (error) {
      logger.warn(
        { agentId, userId: userContext.userId, error },
        "Orphan tab cleanup failed",
      );
      return 0;
    }
  }

  /**
   * Sync browser state from AI-initiated browser_tabs tool calls.
   * Updates state manager based on the tool action and result.
   */
  async syncTabMappingFromTabsToolCall(params: {
    agentId: string;
    conversationId: string;
    userContext: BrowserUserContext;
    toolArguments?: Record<string, unknown>;
    toolResultContent: unknown;
    tabsToolName?: string;
  }): Promise<void> {
    const {
      agentId,
      conversationId,
      userContext,
      toolArguments,
      toolResultContent,
      tabsToolName,
    } = params;

    const actionValue = toolArguments?.action;
    if (typeof actionValue !== "string") {
      return;
    }

    const action = actionValue.trim().toLowerCase();
    if (action !== "list") {
      if (tabsToolName) {
        this.invalidateTabsListCache({
          agentId,
          userContext,
          tabsTool: tabsToolName,
        });
      } else {
        this.tabsListCache.clear();
      }
    }

    // Load existing state
    const loadResult = await browserStateManager.getOrLoad({
      agentId,
      userId: userContext.userId,
      conversationId,
    });

    const existingState = isOk(loadResult) ? loadResult.value : null;

    if (action === "list") {
      // On list, sync indices with current browser state
      if (!existingState) return;

      const browserTabs = this.parseTabsList(toolResultContent);
      const listEntries = this.toBrowserTabsListEntries(
        browserTabs,
        toolResultContent,
      );

      if (listEntries.length === existingState.tabs.length) {
        const syncResult = applyTabsList({
          state: existingState,
          list: listEntries,
        });

        if (isOk(syncResult)) {
          await browserStateManager.set({
            agentId,
            userId: userContext.userId,
            conversationId,
            state: syncResult.value,
          });
          logTabSyncInfo(
            { agentId, conversationId, action },
            "[BrowserTabs] Synced indices from AI list action",
          );
        }
      }
      return;
    }

    if (action === "new") {
      // On new tab, create a new tab in state
      const currentIndex =
        this.extractCurrentTabIndexFromTabsContent(toolResultContent);
      if (currentIndex === undefined) return;

      const tabId = generateTabId();

      if (existingState) {
        const createResult = applyTabsCreate({
          state: existingState,
          tabId,
          index: currentIndex,
          initialUrl: "about:blank",
        });

        if (isOk(createResult)) {
          await browserStateManager.set({
            agentId,
            userId: userContext.userId,
            conversationId,
            state: createResult.value,
          });
          logTabSyncInfo(
            { agentId, conversationId, action, tabId, index: currentIndex },
            "[BrowserTabs] Created new tab in state from AI action",
          );
        }
      } else {
        // No existing state - create initial state
        const initialState = createInitialState(tabId, "about:blank");
        const stateWithIndex: BrowserState = {
          ...initialState,
          tabs: initialState.tabs.map((t) =>
            t.id === tabId ? { ...t, index: Some(currentIndex) } : t,
          ),
        };

        await browserStateManager.set({
          agentId,
          userId: userContext.userId,
          conversationId,
          state: stateWithIndex,
        });
        logTabSyncInfo(
          { agentId, conversationId, action, tabId, index: currentIndex },
          "[BrowserTabs] Created initial state from AI new action",
        );
      }
      return;
    }

    if (action === "select") {
      // On select, update active tab ID based on index
      if (!existingState) return;

      const selectedIndex = this.parseTabIndexValue(toolArguments?.index);
      if (selectedIndex === null) return;

      // Find tab with this index and set as active
      const selectedTab = existingState.tabs.find(
        (t) => isSome(t.index) && t.index.value === selectedIndex,
      );

      if (selectedTab) {
        const updatedState: BrowserState = {
          ...existingState,
          activeTabId: selectedTab.id,
        };

        await browserStateManager.set({
          agentId,
          userId: userContext.userId,
          conversationId,
          state: updatedState,
        });
        logTabSyncInfo(
          {
            agentId,
            conversationId,
            action,
            selectedIndex,
            activeTabId: selectedTab.id,
          },
          "[BrowserTabs] Updated active tab from AI select action",
        );
      }
      return;
    }

    if (action === "close") {
      // On close, remove tab from state
      if (!existingState) return;

      const closedIndex = this.parseTabIndexValue(toolArguments?.index);
      if (closedIndex === null) return;

      const closeResult = applyTabsClose({
        state: existingState,
        index: closedIndex,
      });

      if (isOk(closeResult)) {
        await browserStateManager.set({
          agentId,
          userId: userContext.userId,
          conversationId,
          state: closeResult.value,
        });
        logTabSyncInfo(
          { agentId, conversationId, action, closedIndex },
          "[BrowserTabs] Removed tab from state after AI close action",
        );
      } else if (closeResult.error.kind === "CannotCloseLastTab") {
        // Clear state if trying to close last tab
        await browserStateManager.clear({
          agentId,
          userId: userContext.userId,
          conversationId,
        });
        logTabSyncInfo(
          { agentId, conversationId, action },
          "[BrowserTabs] Cleared state after closing last tab",
        );
      }
    }
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
   * Take a screenshot of a conversation's browser tab
   * Note: Tab should already be selected via selectOrCreateTab when subscribing
   * Uses fixed viewport dimensions for consistent rendering
   */
  async takeScreenshot(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<ScreenshotResult> {
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

    const toolName = await this.findScreenshotTool(agentId, userContext.userId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser screenshot tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );

    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    // Always use fixed viewport dimensions for consistent page rendering
    await this.resizeBrowser(agentId, conversationId, userContext);

    logScreenshotInfo(
      { agentId, conversationId, toolName },
      "Taking browser screenshot via MCP",
    );

    const result = await client.callTool({
      name: toolName,
      arguments: {
        type: "jpeg",
        raw: true, // Return base64 data instead of saving to file
      },
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
      return false;
    }
    return url.toLowerCase().startsWith("about:blank");
  }

  private parseTabIndexValue(value: unknown): number | null {
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
  }

  private isCurrentTabFlag(
    flag: unknown,
    candidateIndex: number | null,
  ): boolean {
    if (flag === true) return true;
    if (typeof flag === "string") {
      const normalized = flag.trim().toLowerCase();
      if (normalized === "true") return true;
      const numericFlag = this.parseTabIndexValue(flag);
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
  }

  private extractCurrentTabIndexFromTabsJson(
    textContent: string,
  ): number | undefined {
    if (textContent.trim() === "") return undefined;

    const findCurrentIndex = (
      tabs: unknown[],
      currentIndex: number | null,
    ): number | undefined => {
      if (currentIndex !== null) {
        return currentIndex;
      }

      for (const item of tabs) {
        if (typeof item !== "object" || item === null) continue;
        const candidate = item as Record<string, unknown>;
        const candidateIndex = this.parseTabIndexValue(
          candidate.index ?? candidate.id ?? candidate.tabIndex,
        );
        const currentFlag =
          candidate.current ??
          candidate.isCurrent ??
          candidate.is_current ??
          candidate.active ??
          candidate.selected;

        if (this.isCurrentTabFlag(currentFlag, candidateIndex)) {
          if (candidateIndex !== null) {
            return candidateIndex;
          }
        }
      }

      return undefined;
    };

    try {
      const parsed: unknown = JSON.parse(textContent);
      if (Array.isArray(parsed)) {
        return findCurrentIndex(parsed, null);
      }

      if (typeof parsed === "object" && parsed !== null) {
        const candidate = parsed as Record<string, unknown>;
        const currentIndex = this.parseTabIndexValue(
          candidate.currentIndex ??
            candidate.current_index ??
            candidate.selectedIndex ??
            candidate.selected_index,
        );
        const tabs = candidate.tabs;

        if (Array.isArray(tabs)) {
          return findCurrentIndex(tabs, currentIndex);
        }

        if (currentIndex !== null) {
          return currentIndex;
        }
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  private extractCurrentTabIndexFromTabsContent(
    content: unknown,
  ): number | undefined {
    const textContent = this.extractTextContent(content);

    const indexFromJson = this.extractCurrentTabIndexFromTabsJson(textContent);
    if (indexFromJson !== undefined) {
      return indexFromJson;
    }

    const lines = textContent.split("\n");
    for (const line of lines) {
      if (!line.includes("(current)")) continue;
      // Match patterns like "- 0: (current)" or "0: (current)"
      // Note: Use single backslash in regex literals, not double
      const match = line.match(/(?:^|\s|-)(\d+)\s*:/);
      if (!match) continue;
      const parsed = Number.parseInt(match[1], 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        return parsed;
      }
    }

    return undefined;
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

    const findCurrentUrlInTabs = (
      tabs: unknown[],
      currentIndex: number | null,
    ): string | undefined => {
      if (currentIndex !== null) {
        for (const item of tabs) {
          if (typeof item !== "object" || item === null) continue;
          const candidate = item as Record<string, unknown>;
          const candidateIndex = this.parseTabIndexValue(
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
        const candidateIndex = this.parseTabIndexValue(
          candidate.index ?? candidate.id ?? candidate.tabIndex,
        );
        const currentFlag =
          candidate.current ??
          candidate.isCurrent ??
          candidate.is_current ??
          candidate.active ??
          candidate.selected;
        if (this.isCurrentTabFlag(currentFlag, candidateIndex)) {
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
        const currentIndex = this.parseTabIndexValue(
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
    const tabsTool = await this.findTabsTool(agentId, userContext.userId);
    if (!tabsTool) {
      return undefined;
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      return undefined;
    }

    try {
      const listData = await this.getTabsList({
        agentId,
        userContext,
        client,
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
  private async findRunCodeTool(
    agentId: string,
    userId?: string,
  ): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) => toolName.includes("browser_run_code"),
      userId,
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

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    if (x !== undefined && y !== undefined) {
      // Use browser_run_code for native Playwright mouse click
      const runCodeTool = await this.findRunCodeTool(
        agentId,
        userContext.userId,
      );
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
          const result = await client.callTool({
            name: runCodeTool,
            arguments: { code },
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
      const toolName = await this.findClickTool(agentId, userContext.userId);
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

      const result = await client.callTool({
        name: toolName,
        arguments: { element, ref: element },
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

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    // If no element specified, use page.keyboard.type() to type into focused element
    if (!element) {
      const runCodeTool = await this.findRunCodeTool(
        agentId,
        userContext.userId,
      );
      if (runCodeTool) {
        logger.debug(
          { agentId, conversationId, textLength: text.length },
          "Typing text into focused element via browser_run_code",
        );

        // Use JSON.stringify for safe escaping of all special characters
        const safeText = JSON.stringify(text);
        // Native Playwright keyboard type - async function with page argument
        const playwrightCode = `async (page) => { await page.keyboard.type(${safeText}); }`;

        const result = await client.callTool({
          name: runCodeTool,
          arguments: { code: playwrightCode },
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
    const toolName = await this.findTypeTool(agentId, userContext.userId);
    if (!toolName) {
      throw new ApiError(400, "No browser type tool available for this agent");
    }

    logger.debug(
      { agentId, conversationId, textLength: text.length, element },
      "Typing text via browser_type MCP tool",
    );

    const args: Record<string, string> = { text };
    if (element) {
      args.element = element;
      args.ref = element;
    }

    const result = await client.callTool({
      name: toolName,
      arguments: args,
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

    const toolName = await this.findPressKeyTool(agentId, userContext.userId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser press key tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.debug({ agentId, conversationId, key }, "Pressing key via MCP");

    const result = await client.callTool({
      name: toolName,
      arguments: { key },
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

    const toolName = await this.findSnapshotTool(agentId, userContext.userId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser snapshot tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.organizationId,
      userContext.userIsProfileAdmin,
      conversationId,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.debug(
      { agentId, conversationId },
      "Getting browser snapshot via MCP",
    );

    const result = await client.callTool({
      name: toolName,
      arguments: {},
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Snapshot failed");
    }

    const snapshot = this.extractTextContent(result.content);
    return { snapshot };
  }
}
