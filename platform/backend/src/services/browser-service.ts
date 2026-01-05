import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import logger from "@/logging";

export class BrowserService {
  private static instance: BrowserService;
  private browser: Browser | null = null;
  // Map conversationId -> BrowserContext
  private contexts: Map<string, BrowserContext> = new Map();
  // Map contextId -> Page (for simplicity, we assume one page per context for now, or active page)
  private activePages: Map<string, Page> = new Map();
  // Map conversationId -> Last Access Timestamp (for LRU eviction)
  private lastAccess: Map<string, number> = new Map();

  private readonly MAX_CONTEXTS = 10;
  private readonly CONTEXT_TIMEOUT_MS = 1000 * 60 * 60; // 1 hour

  private constructor() {
    // Periodically clean up stale contexts
    setInterval(() => this.cleanupStaleContexts(), 1000 * 60 * 5); // Check every 5 mins
  }

  public static getInstance(): BrowserService {
    if (!BrowserService.instance) {
      BrowserService.instance = new BrowserService();
    }
    return BrowserService.instance;
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      logger.info("Launching system browser (headless)...");
      this.browser = await chromium.launch({
        headless: true, // Explicitly ensure headless mode
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }
    return this.browser;
  }

  /**
   * Validate conversation ID format
   */
  private isValidConversationId(id: string): boolean {
    // Allow alphanumeric, dashes, underscores. Basic injection prevention.
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  /**
   * Manage context limits and eviction
   */
  private async ensureContextLimit(): Promise<void> {
    if (this.contexts.size < this.MAX_CONTEXTS) {
      return;
    }

    // Find oldest accessed context
    let oldestId: string | null = null;
    let oldestTime = Number.MAX_SAFE_INTEGER;

    for (const [id, time] of this.lastAccess.entries()) {
      if (time < oldestTime) {
        oldestTime = time;
        oldestId = id;
      }
    }

    if (oldestId) {
      logger.info(
        { conversationId: oldestId },
        "Evicting oldest browser context to free resources",
      );
      await this.closeSession(oldestId);
    }
  }

  private async cleanupStaleContexts(): Promise<void> {
    const now = Date.now();
    for (const [id, time] of this.lastAccess.entries()) {
      if (now - time > this.CONTEXT_TIMEOUT_MS) {
        logger.info(
          { conversationId: id },
          "Cleaning up stale browser context",
        );
        await this.closeSession(id);
      }
    }
  }

  /**
   * Get or create a browser context for a specific conversation.
   * This ensures isolation between conversations.
   */
  private async getContext(conversationId: string): Promise<BrowserContext> {
    if (!this.isValidConversationId(conversationId)) {
      throw new Error(`Invalid conversation ID: ${conversationId}`);
    }

    const browser = await this.getBrowser();

    if (!this.contexts.has(conversationId)) {
      await this.ensureContextLimit();

      logger.info({ conversationId }, "Creating new browser context");
      const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });

      // Setup cleanup
      context.on("close", () => {
        this.contexts.delete(conversationId);
        this.activePages.delete(conversationId);
        this.lastAccess.delete(conversationId);
      });

      this.contexts.set(conversationId, context);
    }

    // Update access time
    this.lastAccess.set(conversationId, Date.now());

    const context = this.contexts.get(conversationId);
    if (!context) {
      throw new Error(
        `Failed to retrieve browser context for conversation ${conversationId}`,
      );
    }
    return context;
  }

  /**
   * Get the active page for a conversation.
   * Creates a new page if none exists.
   */
  private async getPage(conversationId: string): Promise<Page> {
    const context = await this.getContext(conversationId);

    if (
      !this.activePages.has(conversationId) ||
      this.activePages.get(conversationId)?.isClosed()
    ) {
      const page = await context.newPage();
      this.activePages.set(conversationId, page);
      return page;
    }

    const page = this.activePages.get(conversationId);
    if (!page) {
      throw new Error(
        `Failed to retrieve active page for conversation ${conversationId}`,
      );
    }
    return page;
  }

  /**
   * Validate that a URL is well-formed and uses an allowed protocol.
   * Currently only http and https schemes are permitted.
   */
  private isAllowedUrl(url: string): boolean {
    if (!url) {
      return false;
    }
    const trimmed = url.trim();
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  /**
   * Navigate to a URL
   */
  public async navigate(conversationId: string, url: string): Promise<string> {
    try {
      if (!this.isAllowedUrl(url)) {
        logger.warn(
          { conversationId, url },
          "Blocked navigation to invalid or disallowed URL",
        );
        throw new Error(
          "Invalid or disallowed URL. Only http and https are supported.",
        );
      }

      const page = await this.getPage(conversationId);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return `Successfully navigated to ${url}`;
    } catch (error) {
      logger.error({ conversationId, url, err: error }, "Failed to navigate");
      throw new Error(
        `Failed to navigate to ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Take a screenshot
   */
  public async screenshot(conversationId: string): Promise<string> {
    try {
      const page = await this.getPage(conversationId);
      const buffer = await page.screenshot({ type: "jpeg", quality: 80 });
      return buffer.toString("base64");
    } catch (error) {
      logger.error({ conversationId, err: error }, "Failed to take screenshot");
      throw new Error("Failed to take screenshot");
    }
  }

  /**
   * Click an element
   */
  public async click(
    conversationId: string,
    selector: string,
  ): Promise<string> {
    try {
      if (!selector || typeof selector !== "string") {
        throw new Error("Invalid selector");
      }
      const page = await this.getPage(conversationId);
      await page.click(selector, { timeout: 5000 });
      return `Clicked element: ${selector}`;
    } catch (error) {
      logger.error({ conversationId, selector, err: error }, "Failed to click");
      throw new Error(
        `Failed to click ${selector}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Type into an element
   */
  public async type(
    conversationId: string,
    selector: string,
    text: string,
  ): Promise<string> {
    try {
      if (!selector || typeof selector !== "string") {
        throw new Error("Invalid selector");
      }
      const page = await this.getPage(conversationId);
      await page.fill(selector, text, { timeout: 5000 });
      return `Typed into ${selector}`;
    } catch (error) {
      logger.error({ conversationId, selector, err: error }, "Failed to type");
      throw new Error(
        `Failed to type into ${selector}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Scroll down
   */
  public async scroll(
    conversationId: string,
    direction: "up" | "down",
  ): Promise<string> {
    try {
      const page = await this.getPage(conversationId);
      if (direction === "down") {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      } else {
        await page.evaluate(() => window.scrollBy(0, -window.innerHeight));
      }
      return `Scrolled ${direction}`;
    } catch (error) {
      logger.error({ conversationId, err: error }, "Failed to scroll");
      throw new Error("Failed to scroll");
    }
  }

  /**
   * Get page content (text)
   */
  public async getContent(conversationId: string): Promise<string> {
    try {
      const page = await this.getPage(conversationId);
      return await page.evaluate(() => document.body.innerText);
    } catch (error) {
      logger.error({ conversationId, err: error }, "Failed to get content");
      throw new Error("Failed to get content");
    }
  }

  /**
   * Cleanup a conversation session
   */
  public async closeSession(conversationId: string): Promise<void> {
    if (this.contexts.has(conversationId)) {
      await this.contexts.get(conversationId)?.close();
      this.contexts.delete(conversationId);
      this.activePages.delete(conversationId);
      this.lastAccess.delete(conversationId);
    }
  }
}
