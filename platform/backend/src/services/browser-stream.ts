import { isBrowserMcpTool } from "@shared";
import { getChatMcpClient } from "@/clients/chat-mcp-client";
import logger from "@/logging";
import { ToolModel } from "@/models";
import { ApiError } from "@/types";

/**
 * User context required for MCP client authentication
 */
export interface BrowserUserContext {
  userId: string;
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
}

export interface TabResult {
  success: boolean;
  tabIndex?: number;
  tabs?: Array<{ index: number; title?: string; url?: string }>;
  error?: string;
}

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

/**
 * Maps conversationId to browser tab index
 * Each conversation gets its own browser tab
 */
type ConversationTabKey = `${string}:${string}:${string}`;

const conversationTabMap = new Map<ConversationTabKey, number>();

/**
 * Tracks which agent+user combos have been cleaned up after server restart.
 * On first browser panel open after restart, we close all orphaned tabs.
 */
type AgentUserKey = `${string}:${string}`;
const cleanedUpAgents = new Set<AgentUserKey>();

const toConversationTabKey = (
  agentId: string,
  userId: string,
  conversationId: string,
): ConversationTabKey => `${agentId}:${userId}:${conversationId}`;

const toAgentUserKey = (agentId: string, userId: string): AgentUserKey =>
  `${agentId}:${userId}`;

/**
 * Service for browser streaming via Playwright MCP
 * Calls Playwright MCP tools directly through the MCP Gateway
 */
export class BrowserStreamService {
  private async findToolName(
    agentId: string,
    matches: (toolName: string) => boolean,
  ): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);

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
   */
  async checkAvailability(agentId: string): Promise<AvailabilityResult> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
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
   */
  private async findNavigateTool(agentId: string): Promise<string | null> {
    return this.findToolName(
      agentId,
      (toolName) =>
        toolName.includes("browser_navigate") ||
        toolName.endsWith("__navigate") ||
        (toolName.includes("playwright") && toolName.includes("navigate")),
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

  /**
   * Clean up orphaned browser tabs after server restart.
   * Closes all tabs except tab 0 (default tab) to start fresh.
   * Called once per agent+user combination after restart.
   */
  private async cleanupOrphanedTabs(
    agentId: string,
    userContext: BrowserUserContext,
    tabsTool: string,
    client: NonNullable<Awaited<ReturnType<typeof getChatMcpClient>>>,
  ): Promise<void> {
    const agentUserKey = toAgentUserKey(agentId, userContext.userId);

    // Skip if already cleaned up
    if (cleanedUpAgents.has(agentUserKey)) {
      return;
    }

    // Mark as cleaned up immediately to prevent concurrent cleanup attempts
    cleanedUpAgents.add(agentUserKey);

    try {
      // List all existing tabs
      const listResult = await client.callTool({
        name: tabsTool,
        arguments: { action: "list" },
      });

      if (listResult.isError) {
        logger.warn(
          { agentId, userId: userContext.userId },
          "Failed to list tabs for cleanup",
        );
        return;
      }

      const tabs = this.parseTabsList(listResult.content);

      // Close all tabs except tab 0 (close in reverse order to avoid index shifts)
      if (tabs.length > 1) {
        logger.info(
          { agentId, userId: userContext.userId, tabCount: tabs.length },
          "Cleaning up orphaned browser tabs after restart",
        );

        const closableTabs = tabs
          .filter((tab) => tab.index !== 0)
          .sort((a, b) => b.index - a.index);

        for (const tab of closableTabs) {
          try {
            await client.callTool({
              name: tabsTool,
              arguments: { action: "close", index: tab.index },
            });
          } catch (error) {
            logger.warn(
              {
                agentId,
                userId: userContext.userId,
                tabIndex: tab.index,
                error,
              },
              "Failed to close orphaned tab",
            );
          }
        }

        logger.info(
          { agentId, userId: userContext.userId },
          "Finished cleaning up orphaned browser tabs",
        );
      }
    } catch (error) {
      logger.error(
        { agentId, userId: userContext.userId, error },
        "Error during orphaned tabs cleanup",
      );
    }
  }

  /**
   * Select or create a browser tab for a conversation
   * Uses Playwright MCP browser_tabs tool
   */
  async selectOrCreateTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      logger.info(
        { agentId, conversationId },
        "No browser_tabs tool available, using shared browser page",
      );
      return { success: true, tabIndex: 0 };
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      return { success: false, error: "Failed to connect to MCP Gateway" };
    }

    // Clean up orphaned tabs on first access after server restart
    await this.cleanupOrphanedTabs(agentId, userContext, tabsTool, client);

    const tabKey = toConversationTabKey(
      agentId,
      userContext.userId,
      conversationId,
    );

    logger.info(
      {
        tabKey,
        agentId,
        userId: userContext.userId,
        conversationId,
        existingTabIndex: conversationTabMap.get(tabKey),
        allTabKeys: Array.from(conversationTabMap.keys()),
      },
      "selectOrCreateTab called",
    );

    try {
      const existingTabIndex = conversationTabMap.get(tabKey);

      if (existingTabIndex !== undefined) {
        try {
          const selectExistingResult = await client.callTool({
            name: tabsTool,
            arguments: { action: "select", index: existingTabIndex },
          });

          if (!selectExistingResult.isError) {
            return { success: true, tabIndex: existingTabIndex };
          }

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
            "Failed to select existing conversation tab, creating a new one",
          );
        } catch (selectError) {
          // MCP tool call threw exception (e.g., tab no longer exists)
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
            "Exception selecting existing tab, clearing stale entry and creating new one",
          );
        }
        // Clear stale entry and fall through to create new tab
        conversationTabMap.delete(tabKey);
      }

      const listResult = await client.callTool({
        name: tabsTool,
        arguments: { action: "list" },
      });

      if (listResult.isError) {
        const errorText = this.extractTextContent(listResult.content);
        return { success: false, error: errorText || "Failed to list tabs" };
      }

      const existingTabs = this.parseTabsList(listResult.content);
      const expectedNewTabIndex = this.getMaxTabIndex(existingTabs) + 1;

      const createResult = await client.callTool({
        name: tabsTool,
        arguments: { action: "new" },
      });

      if (createResult.isError) {
        const errorText = this.extractTextContent(createResult.content);
        return { success: false, error: errorText || "Failed to create tab" };
      }

      const postCreateList = await client.callTool({
        name: tabsTool,
        arguments: { action: "list" },
      });

      const postCreateTabs = postCreateList.isError
        ? []
        : this.parseTabsList(postCreateList.content);
      const existingIndexSet = new Set(existingTabs.map((tab) => tab.index));

      let resolvedTabIndex: number | null = null;
      if (!postCreateList.isError) {
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

      const selectNewResult = await client.callTool({
        name: tabsTool,
        arguments: { action: "select", index: resolvedTabIndex },
      });

      if (selectNewResult.isError) {
        const errorText = this.extractTextContent(selectNewResult.content);
        return { success: false, error: errorText || "Failed to select tab" };
      }

      conversationTabMap.set(tabKey, resolvedTabIndex);
      return { success: true, tabIndex: resolvedTabIndex };
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
   * Find the Playwright browser click tool for an agent
   */
  private async findClickTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_click"),
    );
  }

  /**
   * Find the Playwright browser type tool for an agent
   */
  private async findTypeTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_type"),
    );
  }

  /**
   * Find the Playwright browser press key tool for an agent
   */
  private async findPressKeyTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_press_key"),
    );
  }

  /**
   * Find the Playwright browser navigate back tool for an agent
   */
  private async findNavigateBackTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_navigate_back"),
    );
  }

  /**
   * Find the Playwright browser snapshot tool for an agent
   */
  private async findSnapshotTool(agentId: string): Promise<string | null> {
    return this.findToolName(agentId, (toolName) =>
      toolName.includes("browser_snapshot"),
    );
  }

  /**
   * Navigate browser to a URL in a conversation's tab
   */
  async navigate(
    agentId: string,
    conversationId: string,
    url: string,
    userContext: BrowserUserContext,
  ): Promise<NavigateResult> {
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

    const toolName = await this.findNavigateTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser navigate tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.info({ agentId, toolName, url }, "Navigating browser via MCP");

    const result = await client.callTool({
      name: toolName,
      arguments: { url },
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Navigation failed");
    }

    return {
      success: true,
      url,
    };
  }

  /**
   * Navigate browser back to the previous page
   */
  async navigateBack(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<NavigateResult> {
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

    const toolName = await this.findNavigateBackTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser navigate back tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.info({ agentId, toolName }, "Navigating browser back via MCP");

    const result = await client.callTool({
      name: toolName,
      arguments: {},
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Navigate back failed");
    }

    return {
      success: true,
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
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      throw new ApiError(400, "No browser tabs tool available");
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );

    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    const result = await client.callTool({
      name: tabsTool,
      arguments: { action: "list" },
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      throw new ApiError(500, errorText || "Failed to list tabs");
    }

    return {
      success: true,
      tabs: this.parseTabsList(result.content),
    };
  }

  /**
   * Close a conversation's browser tab.
   *
   * Note: The conversation-to-tab mapping is stored in-memory only.
   * After server restart, the mapping is lost but browser tabs persist.
   * When the tab index is not in memory, we do best-effort cleanup by
   * listing tabs and closing the most recently created one (highest index).
   */
  async closeTab(
    agentId: string,
    conversationId: string,
    userContext: BrowserUserContext,
  ): Promise<TabResult> {
    const tabKey = toConversationTabKey(
      agentId,
      userContext.userId,
      conversationId,
    );
    let tabIndex = conversationTabMap.get(tabKey);

    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      conversationTabMap.delete(tabKey);
      return { success: true };
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      conversationTabMap.delete(tabKey);
      return { success: true };
    }

    // If we don't have the tab index in memory (e.g., after server restart),
    // try to find it by listing all tabs and looking for one with matching URL pattern
    // or just close all non-zero tabs since we can't identify which is which
    if (tabIndex === undefined) {
      logger.info(
        { agentId, conversationId },
        "Tab index not in memory, checking browser tabs",
      );

      try {
        const listResult = await client.callTool({
          name: tabsTool,
          arguments: { action: "list" },
        });

        if (!listResult.isError) {
          const tabs = this.parseTabsList(listResult.content);
          // If there's only one tab (index 0), nothing to close
          if (tabs.length <= 1) {
            return { success: true };
          }

          // Since we can't identify which tab belongs to which conversation,
          // we'll close the highest-indexed tab (most recently created)
          // This is a best-effort cleanup
          const maxTab = tabs.reduce((max, tab) =>
            tab.index > max.index ? tab : max,
          );
          if (maxTab.index > 0) {
            tabIndex = maxTab.index;
            logger.info(
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
        return { success: true };
      }
    }

    if (tabIndex === undefined || tabIndex === 0) {
      return { success: true }; // No tab to close or can't close tab 0
    }

    try {
      await client.callTool({
        name: tabsTool,
        arguments: { action: "close", index: tabIndex },
      });

      conversationTabMap.delete(tabKey);

      // Update indices for all conversations with higher tab indices
      // When a tab is closed, all tabs with higher indices shift down by one
      const closedIndex = tabIndex;
      for (const [key, index] of conversationTabMap.entries()) {
        if (index > closedIndex) {
          conversationTabMap.set(key, index - 1);
          logger.debug(
            { key, oldIndex: index, newIndex: index - 1 },
            "Shifted tab index after tab close",
          );
        }
      }

      return { success: true };
    } catch (error) {
      logger.error({ error, agentId, conversationId }, "Failed to close tab");
      conversationTabMap.delete(tabKey);
      return { success: true }; // Consider success even if close fails
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
        const match = line.match(/(\d+)[:\s]+(.+)/);
        if (match) {
          tabs.push({
            index: Number.parseInt(match[1], 10),
            title: match[2].trim(),
          });
        }
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

    const toolName = await this.findScreenshotTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser screenshot tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );

    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.info(
      { agentId, conversationId, toolName },
      "Taking browser screenshot via MCP",
    );

    const result = await client.callTool({
      name: toolName,
      arguments: {
        type: "jpeg",
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
      return { error: "No screenshot returned from browser tool" };
    }

    // Log screenshot size for debugging token usage issues
    const base64Match = screenshot.match(/^data:([^;]+);base64,(.+)$/);
    if (base64Match) {
      const mimeType = base64Match[1];
      const base64Data = base64Match[2];
      const estimatedSizeKB = Math.round((base64Data.length * 3) / 4 / 1024);

      logger.info(
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
    const url = await this.getCurrentUrl(agentId, userContext);

    return {
      screenshot,
      url,
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
  private extractCurrentUrlFromTabsJson(
    textContent: string,
  ): string | undefined {
    if (textContent.trim() === "") return undefined;

    const parseTabIndex = (value: unknown): number | null => {
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
        const numericFlag = parseTabIndex(flag);
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
          const candidateIndex = parseTabIndex(
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
        const candidateIndex = parseTabIndex(
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
        const currentIndex = parseTabIndex(
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
    userContext: BrowserUserContext,
  ): Promise<string | undefined> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      return undefined;
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      return undefined;
    }

    try {
      const result = await client.callTool({
        name: tabsTool,
        arguments: { action: "list" },
      });

      if (result.isError) {
        return undefined;
      }

      const textContent = this.extractTextContent(result.content);
      const currentUrlFromJson =
        this.extractCurrentUrlFromTabsJson(textContent);
      if (currentUrlFromJson) {
        return currentUrlFromJson;
      }
      // Parse the current tab's URL from format like:
      // "- 1: (current) [Title] (https://example.com)"
      const currentTabMatch = textContent.match(
        /\(current\)[^()]*\(((?:https?|about):\/\/[^)]+)\)/,
      );
      return currentTabMatch?.[1];
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

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    if (x !== undefined && y !== undefined) {
      // Use browser_run_code for native Playwright mouse click
      const runCodeTool = await this.findRunCodeTool(agentId);
      if (runCodeTool) {
        logger.info(
          { agentId, conversationId, x, y },
          "Clicking at coordinates via browser_run_code (Playwright mouse.click)",
        );

        // Native Playwright mouse click - async function with page argument
        const code = `async (page) => { await page.mouse.click(${Math.round(
          x,
        )}, ${Math.round(y)}); }`;

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
      const toolName = await this.findClickTool(agentId);
      if (!toolName) {
        throw new ApiError(
          400,
          "No browser click tool available for this agent",
        );
      }

      logger.info(
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
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    // If no element specified, use page.keyboard.type() to type into focused element
    if (!element) {
      const runCodeTool = await this.findRunCodeTool(agentId);
      if (runCodeTool) {
        logger.info(
          { agentId, conversationId, textLength: text.length },
          "Typing text into focused element via browser_run_code",
        );

        // Escape text for JavaScript string
        const escapedText = text
          .replace(/\\/g, "\\\\")
          .replace(/`/g, "\\`")
          .replace(/\$/g, "\\$");
        // Native Playwright keyboard type - async function with page argument
        const playwrightCode = `async (page) => { await page.keyboard.type(\`${escapedText}\`); }`;

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
    const toolName = await this.findTypeTool(agentId);
    if (!toolName) {
      throw new ApiError(400, "No browser type tool available for this agent");
    }

    logger.info(
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

    const toolName = await this.findPressKeyTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser press key tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.info({ agentId, conversationId, key }, "Pressing key via MCP");

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

    const toolName = await this.findSnapshotTool(agentId);
    if (!toolName) {
      throw new ApiError(
        400,
        "No browser snapshot tool available for this agent",
      );
    }

    const client = await getChatMcpClient(
      agentId,
      userContext.userId,
      userContext.userIsProfileAdmin,
    );
    if (!client) {
      throw new ApiError(500, "Failed to connect to MCP Gateway");
    }

    logger.info(
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
