import * as chatMcpClient from "@/clients/chat-mcp-client";
import { beforeEach, describe, expect, test, vi } from "@/test";
import { BrowserStreamService } from "./browser-stream";

describe("BrowserStreamService URL handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("takeScreenshot calls getCurrentUrl to get reliable URL", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    // Mock selectOrCreateTab to succeed
    vi.spyOn(browserService, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });

    // Mock findScreenshotTool to return a tool name
    vi.spyOn(
      browserService as unknown as {
        findScreenshotTool: () => Promise<string>;
      },
      "findScreenshotTool",
    ).mockResolvedValue("browser_take_screenshot");

    // Mock getCurrentUrl to return a specific URL
    const getCurrentUrlSpy = vi
      .spyOn(browserService, "getCurrentUrl")
      .mockResolvedValue("https://correct-page.example.com/path");

    // Mock getChatMcpClient to return a mock client for screenshot
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [
          {
            type: "image",
            data: "base64screenshotdata",
            mimeType: "image/png",
          },
          // Screenshot response has no URL or wrong URL - doesn't matter
          // because we use getCurrentUrl instead
          { type: "text", text: "Screenshot captured" },
        ],
      }),
    };
    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue(
      mockClient as never,
    );

    // Call takeScreenshot
    const result = await browserService.takeScreenshot(
      agentId,
      conversationId,
      userContext,
    );

    // Verify getCurrentUrl was called with correct args
    expect(getCurrentUrlSpy).toHaveBeenCalledWith(agentId, userContext);

    // Verify the URL in result is from getCurrentUrl, not from screenshot response
    expect(result.url).toBe("https://correct-page.example.com/path");

    // Verify screenshot data is present (extractScreenshot adds data URL prefix)
    expect(result.screenshot).toContain("base64screenshotdata");
  });

  test("takeScreenshot returns undefined URL when getCurrentUrl fails", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    // Mock selectOrCreateTab to succeed
    vi.spyOn(browserService, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });

    // Mock findScreenshotTool to return a tool name
    vi.spyOn(
      browserService as unknown as {
        findScreenshotTool: () => Promise<string>;
      },
      "findScreenshotTool",
    ).mockResolvedValue("browser_take_screenshot");

    // Mock getCurrentUrl to return undefined (failed to get URL)
    vi.spyOn(browserService, "getCurrentUrl").mockResolvedValue(undefined);

    // Mock getChatMcpClient
    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [
          {
            type: "image",
            data: "base64screenshotdata",
            mimeType: "image/png",
          },
        ],
      }),
    };
    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue(
      mockClient as never,
    );

    // Call takeScreenshot
    const result = await browserService.takeScreenshot(
      agentId,
      conversationId,
      userContext,
    );

    // URL should be undefined when getCurrentUrl fails
    expect(result.url).toBeUndefined();

    // Screenshot should still be present (extractScreenshot adds data URL prefix)
    expect(result.screenshot).toContain("base64screenshotdata");
  });

  test("takeScreenshot returns an error when no image data is present", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    vi.spyOn(browserService, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });

    vi.spyOn(
      browserService as unknown as {
        findScreenshotTool: () => Promise<string>;
      },
      "findScreenshotTool",
    ).mockResolvedValue("browser_take_screenshot");

    const getCurrentUrlSpy = vi.spyOn(browserService, "getCurrentUrl");

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        isError: false,
        content: [{ type: "text", text: "No image content" }],
      }),
    };
    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue(
      mockClient as never,
    );

    const result = await browserService.takeScreenshot(
      agentId,
      conversationId,
      userContext,
    );

    expect(result.error).toBe("No screenshot returned from browser tool");
    expect(result.screenshot).toBeUndefined();
    expect(getCurrentUrlSpy).not.toHaveBeenCalled();
  });

  test("getCurrentUrl reads current tab URL from JSON tabs list", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const callTool = vi.fn().mockResolvedValue({
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              index: 0,
              title: "Home",
              url: "https://home.example.com",
              current: false,
            },
            {
              index: 1,
              title: "Current",
              url: "https://current.example.com",
              current: true,
            },
          ]),
        },
      ],
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.getCurrentUrl(agentId, userContext);

    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    expect(result).toBe("https://current.example.com");
  });

  test("getCurrentUrl reads current tab URL from numeric current flag", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const callTool = vi.fn().mockResolvedValue({
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              index: 0,
              title: "Home",
              url: "https://home.example.com",
              current: 0,
            },
            {
              index: 3,
              title: "Current",
              url: "https://numeric-current.example.com",
              current: 1,
            },
          ]),
        },
      ],
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.getCurrentUrl(agentId, userContext);

    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    expect(result).toBe("https://numeric-current.example.com");
  });

  test("getCurrentUrl reads current tab URL from top-level currentIndex", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const callTool = vi.fn().mockResolvedValue({
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            currentIndex: 2,
            tabs: [
              {
                index: 1,
                title: "One",
                url: "https://one.example.com",
              },
              {
                index: 2,
                title: "Two",
                url: "https://current-index.example.com",
              },
            ],
          }),
        },
      ],
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.getCurrentUrl(agentId, userContext);

    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    expect(result).toBe("https://current-index.example.com");
  });

  test("selectOrCreateTab uses MCP-provided tab indices", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-provided";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    vi.spyOn(
      browserService as unknown as {
        cleanupOrphanedTabs: () => Promise<void>;
      },
      "cleanupOrphanedTabs",
    ).mockResolvedValue();

    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { index: 1, title: "One" },
              { index: 4, title: "Four" },
            ]),
          },
        ],
      })
      .mockResolvedValueOnce({ isError: false, content: [] })
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { index: 1, title: "One" },
              { index: 4, title: "Four" },
              { index: 7, title: "Seven" },
            ]),
          },
        ],
      })
      .mockResolvedValueOnce({ isError: false, content: [] });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 7 });
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "select", index: 7 },
    });
  });

  test("selectOrCreateTab selects newly created tab even when index is reused", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-reused";
    const userContext = { userId: "test-user", userIsProfileAdmin: false };

    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    vi.spyOn(
      browserService as unknown as {
        cleanupOrphanedTabs: () => Promise<void>;
      },
      "cleanupOrphanedTabs",
    ).mockResolvedValue();

    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { index: 5, title: "Five" },
              { index: 7, title: "Seven" },
            ]),
          },
        ],
      })
      .mockResolvedValueOnce({ isError: false, content: [] })
      .mockResolvedValueOnce({
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify([
              { index: 5, title: "Five" },
              { index: 7, title: "Seven" },
              { index: 3, title: "Reused" },
            ]),
          },
        ],
      })
      .mockResolvedValueOnce({ isError: false, content: [] });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 3 });
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "select", index: 3 },
    });
  });
});
