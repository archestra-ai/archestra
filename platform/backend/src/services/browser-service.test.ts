import { chromium } from "playwright";
import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "@/test";
import { BrowserService } from "./browser-service";

// Mock playwright
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

// Define strict types for mocks
interface MockPage {
  goto: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  isClosed: ReturnType<typeof vi.fn>;
}

interface MockContext {
  newPage: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockBrowser {
  newContext: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

describe("BrowserService", () => {
  let browserService: BrowserService;
  let mockBrowser: MockBrowser;
  let mockContext: MockContext;
  let mockPage: MockPage;

  beforeEach(() => {
    // Reset singleton instance (accessing private static property via casting)
    // @ts-expect-error accessing private property for test isolation
    BrowserService.instance = null;
    browserService = BrowserService.getInstance();

    mockPage = {
      goto: vi.fn(),
      screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-screenshot")),
      click: vi.fn(),
      fill: vi.fn(),
      evaluate: vi.fn(),
      isClosed: vi.fn().mockReturnValue(false),
    };

    mockContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      on: vi.fn(),
      close: vi.fn(),
    };

    mockBrowser = {
      newContext: vi.fn().mockResolvedValue(mockContext),
      close: vi.fn(),
    };

    // biome-ignore lint/suspicious/noExplicitAny: Mocking playwright launch requires casting
    (chromium.launch as any).mockResolvedValue(mockBrowser);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should be a singleton", () => {
    const instance1 = BrowserService.getInstance();
    const instance2 = BrowserService.getInstance();
    expect(instance1).toBe(instance2);
  });

  it("should navigate to a valid url", async () => {
    const conversationId = "conv-123";
    const url = "https://example.com";

    const result = await browserService.navigate(conversationId, url);

    expect(chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true }),
    );
    expect(mockBrowser.newContext).toHaveBeenCalled();
    expect(mockContext.newPage).toHaveBeenCalled();
    expect(mockPage.goto).toHaveBeenCalledWith(url, expect.anything());
    expect(result).toContain("Successfully navigated");
  });

  it("should throw error for invalid url", async () => {
    const conversationId = "conv-123";
    const url = "ftp://example.com"; // Invalid protocol

    await expect(browserService.navigate(conversationId, url)).rejects.toThrow(
      "Invalid or disallowed URL",
    );
  });

  it("should throw error for invalid conversation id", async () => {
    const conversationId = "conv/123"; // Invalid char
    const url = "https://example.com";

    await expect(browserService.navigate(conversationId, url)).rejects.toThrow(
      "Invalid conversation ID",
    );
  });

  it("should reuse context for the same conversation", async () => {
    const conversationId = "conv-123";

    await browserService.navigate(conversationId, "https://example.com");
    await browserService.click(conversationId, "#btn");

    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);
    expect(mockContext.newPage).toHaveBeenCalledTimes(1);
  });

  it("should isolate conversations", async () => {
    const conv1 = "conv_1";
    const conv2 = "conv_2";

    await browserService.navigate(conv1, "https://example.com");
    await browserService.navigate(conv2, "https://other.com");

    expect(mockBrowser.newContext).toHaveBeenCalledTimes(2);
  });

  it("should check screenshots", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");
    const screenshot = await browserService.screenshot(conversationId);

    expect(mockPage.screenshot).toHaveBeenCalled();
    expect(screenshot).toBe(Buffer.from("fake-screenshot").toString("base64"));
  });

  it("should interact with elements", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");

    await browserService.click(conversationId, "#btn");
    expect(mockPage.click).toHaveBeenCalledWith("#btn", expect.anything());

    await browserService.type(conversationId, "#input", "hello");
    expect(mockPage.fill).toHaveBeenCalledWith(
      "#input",
      "hello",
      expect.anything(),
    );
  });

  it("should throw error for invalid selector", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");

    // @ts-expect-error testing runtime check
    await expect(browserService.click(conversationId, null)).rejects.toThrow(
      "Invalid selector",
    );
  });

  it("should scroll the page", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");

    await browserService.scroll(conversationId, "down");
    expect(mockPage.evaluate).toHaveBeenCalled();

    await browserService.scroll(conversationId, "up");
    expect(mockPage.evaluate).toHaveBeenCalledTimes(2); // 2 scrolls
  });

  it("should get page content", async () => {
    const conversationId = "conv-123";
    mockPage.evaluate.mockResolvedValueOnce("Page Content");

    await browserService.navigate(conversationId, "https://example.com");
    const content = await browserService.getContent(conversationId);

    expect(content).toBe("Page Content");
  });

  it("should cleanup session", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");

    await browserService.closeSession(conversationId);
    expect(mockContext.close).toHaveBeenCalled();
  });
});
