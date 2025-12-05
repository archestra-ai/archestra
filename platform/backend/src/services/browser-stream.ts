import { getChatMcpClient } from "@/clients/chat-mcp-client";
import logger from "@/logging";
import { ToolModel } from "@/models";

interface AvailabilityResult {
  available: boolean;
  tools?: string[];
  error?: string;
}

interface NavigateResult {
  success: boolean;
  url?: string;
  error?: string;
}

interface ScreenshotResult {
  screenshot?: string;
  url?: string;
  error?: string;
}

interface TabResult {
  success: boolean;
  tabIndex?: number;
  tabs?: Array<{ index: number; title?: string; url?: string }>;
  error?: string;
}

interface ClickResult {
  success: boolean;
  error?: string;
}

interface TypeResult {
  success: boolean;
  error?: string;
}

interface ScrollResult {
  success: boolean;
  error?: string;
}

interface SnapshotResult {
  snapshot?: string;
  error?: string;
}

/**
 * Maps conversationId to browser tab index
 * Each conversation gets its own browser tab
 */
const conversationTabMap = new Map<string, number>();

/**
 * Service for browser streaming via Playwright MCP
 * Calls Playwright MCP tools directly through the MCP Gateway
 */
export class BrowserStreamService {
  /**
   * Check if Playwright MCP browser tools are available for an agent
   */
  async checkAvailability(agentId: string): Promise<AvailabilityResult> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const browserTools = tools.filter(
      (t: { name: string }) =>
        t.name.includes("playwright") || t.name.startsWith("browser_"),
    );

    return {
      available: browserTools.length > 0,
      tools: browserTools.map((t: { name: string }) => t.name),
    };
  }

  /**
   * Find the Playwright browser navigate tool for an agent
   */
  private async findNavigateTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const navigateTool = tools.find(
      (t: { name: string }) =>
        t.name.includes("browser_navigate") ||
        t.name.endsWith("__navigate") ||
        (t.name.includes("playwright") && t.name.includes("navigate")),
    );
    return navigateTool?.name ?? null;
  }

  /**
   * Find the Playwright browser screenshot tool for an agent
   */
  private async findScreenshotTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    // Prefer browser_take_screenshot, fallback to browser_snapshot
    const screenshotTool = tools.find(
      (t: { name: string }) =>
        t.name.includes("browser_take_screenshot") ||
        t.name.includes("browser_screenshot"),
    );
    if (screenshotTool) return screenshotTool.name;

    const snapshotTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_snapshot"),
    );
    return snapshotTool?.name ?? null;
  }

  /**
   * Find the Playwright browser tabs tool for an agent
   */
  private async findTabsTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const tabsTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_tabs"),
    );
    return tabsTool?.name ?? null;
  }

  /**
   * Select or create a browser tab by index
   * Uses Playwright MCP browser_tabs tool
   */
  async selectOrCreateTab(
    agentId: string,
    tabIndex: number,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      logger.info(
        { agentId, tabIndex },
        "No browser_tabs tool available, using shared browser page",
      );
      return { success: true, tabIndex: 0 };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      logger.info({ agentId, tabIndex }, "Selecting/creating browser tab");

      // First, list existing tabs (use "action" param like the old activateTab code)
      const listResult = await client.callTool({
        name: tabsTool,
        arguments: { action: "list" },
      });

      if (listResult.isError) {
        const errorText = this.extractTextContent(listResult.content);
        logger.warn(
          { agentId, error: errorText },
          "Failed to list tabs, using default page",
        );
        return { success: true, tabIndex: 0 };
      }

      const tabsList = this.parseTabsList(listResult.content);
      const existingCount = tabsList.length;

      logger.info({ agentId, existingCount, tabIndex }, "Current tabs count");

      // Create tabs until we have enough
      for (let i = existingCount; i <= tabIndex; i++) {
        logger.info(
          { agentId, creatingTabIndex: i },
          "Creating new browser tab",
        );
        const createResult = await client.callTool({
          name: tabsTool,
          arguments: { action: "new" },
        });
        if (createResult.isError) {
          logger.warn({ agentId, i }, "Failed to create tab, stopping");
          break;
        }
      }

      // Select the target tab
      const selectResult = await client.callTool({
        name: tabsTool,
        arguments: { action: "select", index: tabIndex },
      });

      if (selectResult.isError) {
        const errorText = this.extractTextContent(selectResult.content);
        logger.warn(
          { agentId, tabIndex, error: errorText },
          "Failed to select tab, using default",
        );
        // Don't fail - just use whatever tab is active
        return { success: true, tabIndex: 0 };
      }

      return { success: true, tabIndex };
    } catch (error) {
      logger.error({ error, agentId, tabIndex }, "Tab select/create failed");
      // Don't fail - just use whatever tab is active
      return { success: true, tabIndex: 0 };
    }
  }

  /**
   * Find the Playwright browser click tool for an agent
   */
  private async findClickTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const clickTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_click"),
    );
    return clickTool?.name ?? null;
  }

  /**
   * Find the Playwright browser type tool for an agent
   */
  private async findTypeTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const typeTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_type"),
    );
    return typeTool?.name ?? null;
  }

  /**
   * Find the Playwright browser press key tool for an agent
   */
  private async findPressKeyTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const pressKeyTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_press_key"),
    );
    return pressKeyTool?.name ?? null;
  }

  /**
   * Find the Playwright browser navigate back tool for an agent
   */
  private async findNavigateBackTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const navigateBackTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_navigate_back"),
    );
    return navigateBackTool?.name ?? null;
  }

  /**
   * Find the Playwright browser snapshot tool for an agent
   */
  private async findSnapshotTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const snapshotTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_snapshot"),
    );
    return snapshotTool?.name ?? null;
  }

  /**
   * Navigate browser to a URL in a conversation's tab
   */
  async navigate(
    agentId: string,
    _conversationId: string,
    url: string,
  ): Promise<NavigateResult> {
    // Note: Tab is already selected during subscription via selectOrCreateTab
    // Do NOT call activateTab here as it creates a new blank tab

    const toolName = await this.findNavigateTool(agentId);
    if (!toolName) {
      return {
        success: false,
        error: "No browser navigate tool available for this agent",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      logger.info({ agentId, toolName, url }, "Navigating browser via MCP");

      const result = await client.callTool({
        name: toolName,
        arguments: { url },
      });

      if (result.isError) {
        const errorText = this.extractTextContent(result.content);
        return {
          success: false,
          error: errorText || "Navigation failed",
        };
      }

      return {
        success: true,
        url,
      };
    } catch (error) {
      logger.error({ error, agentId, url }, "Browser navigation failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Navigation failed",
      };
    }
  }

  /**
   * Navigate browser back to the previous page
   */
  async navigateBack(
    agentId: string,
    _conversationId: string,
  ): Promise<NavigateResult> {
    // Note: Tab is already selected during subscription via selectOrCreateTab
    // Do NOT call activateTab here as it creates a new blank tab

    const toolName = await this.findNavigateBackTool(agentId);
    if (!toolName) {
      return {
        success: false,
        error: "No browser navigate back tool available for this agent",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      logger.info({ agentId, toolName }, "Navigating browser back via MCP");

      const result = await client.callTool({
        name: toolName,
        arguments: {},
      });

      if (result.isError) {
        const errorText = this.extractTextContent(result.content);
        return {
          success: false,
          error: errorText || "Navigate back failed",
        };
      }

      return {
        success: true,
      };
    } catch (error) {
      logger.error({ error, agentId }, "Browser navigate back failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Navigate back failed",
      };
    }
  }

  /**
   * Activate a conversation's browser tab (create if doesn't exist, select if exists)
   * Called when user switches to a chat with browser panel open
   */
  async activateTab(
    agentId: string,
    conversationId: string,
  ): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      return {
        success: false,
        error: "No browser tabs tool available for this agent",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      // Check if this conversation already has a tab
      const existingTabIndex = conversationTabMap.get(conversationId);

      if (existingTabIndex !== undefined) {
        // Select existing tab
        logger.info(
          { agentId, conversationId, tabIndex: existingTabIndex },
          "Selecting existing browser tab for conversation",
        );

        const result = await client.callTool({
          name: tabsTool,
          arguments: { action: "select", index: existingTabIndex },
        });

        if (result.isError) {
          // Tab might have been closed, create a new one
          logger.warn(
            { agentId, conversationId, tabIndex: existingTabIndex },
            "Failed to select tab, creating new one",
          );
          conversationTabMap.delete(conversationId);
          return this.createNewTab(client, tabsTool, agentId, conversationId);
        }

        return {
          success: true,
          tabIndex: existingTabIndex,
        };
      }

      // Create new tab for this conversation
      return this.createNewTab(client, tabsTool, agentId, conversationId);
    } catch (error) {
      logger.error({ error, agentId, conversationId }, "Tab activation failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Tab activation failed",
      };
    }
  }

  /**
   * Create a new browser tab for a conversation
   */
  private async createNewTab(
    client: Awaited<ReturnType<typeof getChatMcpClient>>,
    tabsTool: string,
    agentId: string,
    conversationId: string,
  ): Promise<TabResult> {
    if (!client) {
      return { success: false, error: "No MCP client" };
    }

    logger.info(
      { agentId, conversationId },
      "Creating new browser tab for conversation",
    );

    const result = await client.callTool({
      name: tabsTool,
      arguments: { action: "new" },
    });

    if (result.isError) {
      const errorText = this.extractTextContent(result.content);
      return {
        success: false,
        error: errorText || "Failed to create tab",
      };
    }

    // Parse the result to get the new tab index
    const textContent = this.extractTextContent(result.content);
    const tabIndex = this.parseTabIndex(textContent);

    if (tabIndex !== undefined) {
      conversationTabMap.set(conversationId, tabIndex);
    }

    return {
      success: true,
      tabIndex,
    };
  }

  /**
   * List all browser tabs
   */
  async listTabs(agentId: string): Promise<TabResult> {
    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      return {
        success: false,
        error: "No browser tabs tool available",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      const result = await client.callTool({
        name: tabsTool,
        arguments: { action: "list" },
      });

      if (result.isError) {
        const errorText = this.extractTextContent(result.content);
        return {
          success: false,
          error: errorText || "Failed to list tabs",
        };
      }

      return {
        success: true,
        tabs: this.parseTabsList(result.content),
      };
    } catch (error) {
      logger.error({ error, agentId }, "Failed to list tabs");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to list tabs",
      };
    }
  }

  /**
   * Close a conversation's browser tab
   */
  async closeTab(agentId: string, conversationId: string): Promise<TabResult> {
    const tabIndex = conversationTabMap.get(conversationId);
    if (tabIndex === undefined) {
      return { success: true }; // No tab to close
    }

    const tabsTool = await this.findTabsTool(agentId);
    if (!tabsTool) {
      conversationTabMap.delete(conversationId);
      return { success: true };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      conversationTabMap.delete(conversationId);
      return { success: true };
    }

    try {
      await client.callTool({
        name: tabsTool,
        arguments: { action: "close", index: tabIndex },
      });

      conversationTabMap.delete(conversationId);

      return { success: true };
    } catch (error) {
      logger.error({ error, agentId, conversationId }, "Failed to close tab");
      conversationTabMap.delete(conversationId);
      return { success: true }; // Consider success even if close fails
    }
  }

  /**
   * Parse tab index from tool response
   */
  private parseTabIndex(content: string): number | undefined {
    // Try to find tab index in response like "Tab 2 created" or "index: 2"
    const match = content.match(/(?:tab\s*|index[:\s]*)\s*(\d+)/i);
    return match ? Number.parseInt(match[1], 10) : undefined;
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

    // Try to parse JSON if content is JSON
    try {
      const parsed = JSON.parse(textContent);
      if (Array.isArray(parsed)) {
        return parsed;
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

  /**
   * Take a screenshot of a conversation's browser tab
   * Note: Tab should already be selected via selectOrCreateTab when subscribing
   */
  async takeScreenshot(
    agentId: string,
    conversationId: string,
  ): Promise<ScreenshotResult> {
    const toolName = await this.findScreenshotTool(agentId);
    if (!toolName) {
      return {
        error: "No browser screenshot tool available for this agent",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
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
        return {
          error: errorText || "Screenshot failed",
        };
      }

      // Extract screenshot from MCP response
      // Playwright MCP returns screenshots as base64 images in content array
      const screenshot = this.extractScreenshot(result.content);
      const url = this.extractUrl(result.content);

      return {
        screenshot,
        url,
      };
    } catch (error) {
      logger.error({ error, agentId }, "Browser screenshot failed");
      return {
        error: error instanceof Error ? error.message : "Screenshot failed",
      };
    }
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
   * Extract URL from MCP response (if available)
   */
  private extractUrl(content: unknown): string | undefined {
    const textContent = this.extractTextContent(content);
    // Try to find URL in the response - matches http://, https://, or about:
    const urlMatch = textContent.match(
      /(?:https?|about):\/\/[^\s)]+|about:[^\s)]+/,
    );
    return urlMatch?.[0];
  }

  /**
   * Get current page URL using browser_evaluate
   */
  async getCurrentUrl(agentId: string): Promise<string | undefined> {
    const evaluateTool = await this.findEvaluateTool(agentId);
    if (!evaluateTool) {
      return undefined;
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return undefined;
    }

    try {
      const result = await client.callTool({
        name: evaluateTool,
        arguments: { expression: "window.location.href" },
      });

      if (result.isError) {
        return undefined;
      }

      const textContent = this.extractTextContent(result.content);
      // The result might be quoted or contain extra text
      const urlMatch = textContent.match(
        /(?:https?|about):\/\/[^\s"')]+|about:[^\s"')]+/,
      );
      return urlMatch?.[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Find the Playwright browser run_code tool for an agent
   * This tool allows running arbitrary Playwright code including mouse operations
   */
  private async findRunCodeTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const runCodeTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_run_code"),
    );
    return runCodeTool?.name ?? null;
  }

  /**
   * Find the Playwright browser evaluate tool for an agent
   * This tool allows running JavaScript in the browser context
   */
  private async findEvaluateTool(agentId: string): Promise<string | null> {
    const tools = await ToolModel.getMcpToolsByAgent(agentId);
    const evaluateTool = tools.find((t: { name: string }) =>
      t.name.includes("browser_evaluate"),
    );
    return evaluateTool?.name ?? null;
  }

  /**
   * Click on an element using element ref from snapshot OR coordinates
   * For coordinates, uses browser_run_code to perform Playwright mouse.click()
   * Falls back to browser_evaluate for JavaScript-based click simulation
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param element - Element reference (e.g., "e123") or selector
   * @param x - X coordinate for click (optional)
   * @param y - Y coordinate for click (optional)
   */
  async click(
    agentId: string,
    conversationId: string,
    element?: string,
    x?: number,
    y?: number,
  ): Promise<ClickResult> {
    // Note: Tab is already selected during subscription via selectOrCreateTab
    // Do NOT call activateTab here as it creates a new blank tab

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      if (x !== undefined && y !== undefined) {
        // Try browser_run_code first (Playwright native mouse click)
        const runCodeTool = await this.findRunCodeTool(agentId);
        if (runCodeTool) {
          logger.info(
            { agentId, conversationId, x, y },
            "Clicking at coordinates via browser_run_code (Playwright mouse.click)",
          );

          // Use Playwright's page.mouse.click() for native coordinate click
          const playwrightCode = `await page.mouse.click(${Math.round(
            x,
          )}, ${Math.round(y)});`;

          const result = await client.callTool({
            name: runCodeTool,
            arguments: { code: playwrightCode },
          });

          if (!result.isError) {
            return { success: true };
          }

          // Log error but try fallback
          const errorText = this.extractTextContent(result.content);
          logger.warn(
            { agentId, error: errorText },
            "browser_run_code failed, trying browser_evaluate fallback",
          );
        }

        // Fallback: try browser_evaluate for JavaScript-based click
        const evaluateTool = await this.findEvaluateTool(agentId);
        if (evaluateTool) {
          logger.info(
            { agentId, conversationId, x, y },
            "Clicking at coordinates via browser_evaluate (JavaScript)",
          );

          // Use JavaScript to find and click the element at coordinates
          const script = `
            (function() {
              const x = ${Math.round(x)};
              const y = ${Math.round(y)};
              const element = document.elementFromPoint(x, y);
              if (element) {
                const events = ['mousedown', 'mouseup', 'click'];
                events.forEach(eventType => {
                  const event = new MouseEvent(eventType, {
                    view: window,
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y
                  });
                  element.dispatchEvent(event);
                });
                return { success: true, element: element.tagName };
              }
              return { success: false, error: 'No element at coordinates' };
            })()
          `;

          const result = await client.callTool({
            name: evaluateTool,
            arguments: { expression: script },
          });

          if (!result.isError) {
            return { success: true };
          }

          const errorText = this.extractTextContent(result.content);
          logger.warn(
            { agentId, error: errorText },
            "browser_evaluate also failed",
          );
        }

        // No tool available or both failed
        return {
          success: false,
          error:
            "No browser_run_code or browser_evaluate tool available for coordinate clicks",
        };
      } else if (element) {
        // Element ref-based click using browser_click
        const toolName = await this.findClickTool(agentId);
        if (!toolName) {
          return {
            success: false,
            error: "No browser click tool available for this agent",
          };
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
          return {
            success: false,
            error: errorText || "Click failed",
          };
        }

        return { success: true };
      } else {
        return {
          success: false,
          error: "Either element ref or coordinates required",
        };
      }
    } catch (error) {
      logger.error({ error, agentId, element, x, y }, "Browser click failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Click failed",
      };
    }
  }

  /**
   * Type text into the currently focused element or specified element
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param text - Text to type
   * @param element - Optional element reference to focus first
   */
  async type(
    agentId: string,
    conversationId: string,
    text: string,
    element?: string,
  ): Promise<TypeResult> {
    // Note: Tab is already selected during subscription via selectOrCreateTab
    // Do NOT call activateTab here as it creates a new blank tab

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
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
          const playwrightCode = `await page.keyboard.type(\`${escapedText}\`);`;

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
        return {
          success: false,
          error: "No browser type tool available for this agent",
        };
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
        return {
          success: false,
          error: errorText || "Type failed",
        };
      }

      return { success: true };
    } catch (error) {
      logger.error({ error, agentId }, "Browser type failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Type failed",
      };
    }
  }

  /**
   * Press a key (for scrolling, enter, tab, etc.)
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   * @param key - Key to press (e.g., "Enter", "Tab", "ArrowDown", "PageDown")
   */
  async pressKey(
    agentId: string,
    conversationId: string,
    key: string,
  ): Promise<ScrollResult> {
    // Note: Tab is already selected during subscription via selectOrCreateTab
    // Do NOT call activateTab here as it creates a new blank tab

    const toolName = await this.findPressKeyTool(agentId);
    if (!toolName) {
      return {
        success: false,
        error: "No browser press key tool available for this agent",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        success: false,
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
      logger.info({ agentId, conversationId, key }, "Pressing key via MCP");

      const result = await client.callTool({
        name: toolName,
        arguments: { key },
      });

      if (result.isError) {
        const errorText = this.extractTextContent(result.content);
        return {
          success: false,
          error: errorText || "Key press failed",
        };
      }

      return { success: true };
    } catch (error) {
      logger.error({ error, agentId, key }, "Browser key press failed");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Key press failed",
      };
    }
  }

  /**
   * Get accessibility snapshot of the page (shows clickable elements with refs)
   * @param agentId - Agent ID
   * @param conversationId - Conversation ID
   */
  async getSnapshot(
    agentId: string,
    conversationId: string,
  ): Promise<SnapshotResult> {
    // Note: Tab is already selected during subscription via selectOrCreateTab
    // Do NOT call activateTab here as it creates a new blank tab

    const toolName = await this.findSnapshotTool(agentId);
    if (!toolName) {
      return {
        error: "No browser snapshot tool available for this agent",
      };
    }

    const client = await getChatMcpClient(agentId);
    if (!client) {
      return {
        error: "Failed to connect to MCP Gateway",
      };
    }

    try {
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
        return {
          error: errorText || "Snapshot failed",
        };
      }

      const snapshot = this.extractTextContent(result.content);
      return { snapshot };
    } catch (error) {
      logger.error({ error, agentId }, "Browser snapshot failed");
      return {
        error: error instanceof Error ? error.message : "Snapshot failed",
      };
    }
  }
}
