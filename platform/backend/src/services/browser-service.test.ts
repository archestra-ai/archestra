import { describe, it, expect, beforeEach, afterEach } from "@/test";
import { vi } from "vitest";
import { BrowserService } from "./browser-service";
import { chromium } from "playwright";

// Mock playwright
vi.mock("playwright", () => ({
    chromium: {
        launch: vi.fn(),
    },
}));

describe("BrowserService", () => {
    let browserService: BrowserService;
    let mockBrowser: any;
    let mockContext: any;
    let mockPage: any;

    beforeEach(() => {
        // Reset singleton instance (this is a bit hacky for a singleton, but necessary)
        // We can't easily reset private static instance without exposing it or reloading module
        // For this test, we assume we call getInstance() and it reuses the same instance, but we reset the browser state if possible 
        // OR we just test the flow assuming clean state if we mock implementation

        // Access private static instance to reset it for testing
        // @ts-ignore
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
        expect(mockBrowser.newContext).toHaveBeenCalled();
        expect(mockContext.newPage).toHaveBeenCalled();
        expect(mockPage.goto).toHaveBeenCalledWith(url, expect.anything());
        expect(result).toContain("Successfully navigated");
    });

    it("should reuse context for the same conversation", async () => {
        const conversationId = "conv-123";

        await browserService.navigate(conversationId, "https://example.com");
        await browserService.click(conversationId, "#btn");

        expect(chromium.launch).toHaveBeenCalledTimes(1);
        expect(mockBrowser.newContext).toHaveBeenCalledTimes(1);
        expect(mockContext.newPage).toHaveBeenCalledTimes(1); // One page per context in our implementation
    });

    it("should isolate conversations", async () => {
        const conv1 = "conv-1";
        const conv2 = "conv-2";

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
        expect(mockPage.fill).toHaveBeenCalledWith("#input", "hello", expect.anything());
    });

    it("should cleanup session", async () => {
        const conversationId = "conv-123";
        await browserService.navigate(conversationId, "https://example.com");

        await browserService.closeSession(conversationId);
        expect(mockContext.close).toHaveBeenCalled();
    });
});
