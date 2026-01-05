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

describe("BrowserService", () => {
  let browserService: BrowserService;
  // Use unknown for mocks to avoid 'any' lint errors, casting when necessary for specific mock properties
  let mockBrowser: Record<string, unknown>;
  let mockContext: Record<string, unknown>;
  let mockPage: Record<string, unknown>;

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

  it("should navigate to a url", async () => {
    const conversationId = "conv-123";
    const url = "https://example.com";

    const result = await browserService.navigate(conversationId, url);

    expect(chromium.launch).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockBrowser as any).newContext).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockContext as any).newPage).toHaveBeenCalled();
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockPage as any).goto).toHaveBeenCalledWith(url, expect.anything());
    expect(result).toContain("Successfully navigated");
  });

  it("should reuse context for the same conversation", async () => {
    const conversationId = "conv-123";

    await browserService.navigate(conversationId, "https://example.com");
    await browserService.click(conversationId, "#btn");

    expect(chromium.launch).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockBrowser as any).newContext).toHaveBeenCalledTimes(1);
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockContext as any).newPage).toHaveBeenCalledTimes(1);
  });

  it("should isolate conversations", async () => {
    const conv1 = "conv-1";
    const conv2 = "conv-2";

    await browserService.navigate(conv1, "https://example.com");
    await browserService.navigate(conv2, "https://other.com");

    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockBrowser as any).newContext).toHaveBeenCalledTimes(2);
  });

  it("should check screenshots", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");
    const screenshot = await browserService.screenshot(conversationId);

    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockPage as any).screenshot).toHaveBeenCalled();
    expect(screenshot).toBe(Buffer.from("fake-screenshot").toString("base64"));
  });

  it("should interact with elements", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");

    await browserService.click(conversationId, "#btn");
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockPage as any).click).toHaveBeenCalledWith(
      "#btn",
      expect.anything(),
    );

    await browserService.type(conversationId, "#input", "hello");
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockPage as any).fill).toHaveBeenCalledWith(
      "#input",
      "hello",
      expect.anything(),
    );
  });

  it("should cleanup session", async () => {
    const conversationId = "conv-123";
    await browserService.navigate(conversationId, "https://example.com");

    await browserService.closeSession(conversationId);
    // biome-ignore lint/suspicious/noExplicitAny: checking mock function call
    expect((mockContext as any).close).toHaveBeenCalled();
  });
});
