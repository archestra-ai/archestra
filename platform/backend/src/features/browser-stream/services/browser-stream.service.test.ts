import * as chatMcpClient from "@/clients/chat-mcp-client";
import { beforeEach, describe, expect, test, vi } from "@/test";
import { BrowserStreamService } from "./browser-stream.service";
import { Ok } from "./browser-stream.state.types";
import { browserStateManager } from "./browser-stream.state-manager";

describe("BrowserStreamService URL handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("takeScreenshot calls getCurrentUrl to get reliable URL", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock selectOrCreateTab to succeed
    vi.spyOn(browserService, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });

    // Mock resizeBrowser to avoid database call
    vi.spyOn(
      browserService as unknown as {
        resizeBrowser: () => Promise<void>;
      },
      "resizeBrowser",
    ).mockResolvedValue();

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
    expect(getCurrentUrlSpy).toHaveBeenCalledWith(
      agentId,
      conversationId,
      userContext,
    );

    // Verify the URL in result is from getCurrentUrl, not from screenshot response
    expect(result.url).toBe("https://correct-page.example.com/path");

    // Verify screenshot data is present (extractScreenshot adds data URL prefix)
    expect(result.screenshot).toContain("base64screenshotdata");
  });

  test("takeScreenshot returns undefined URL when getCurrentUrl fails", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock selectOrCreateTab to succeed
    vi.spyOn(browserService, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });

    // Mock resizeBrowser to avoid database call
    vi.spyOn(
      browserService as unknown as {
        resizeBrowser: () => Promise<void>;
      },
      "resizeBrowser",
    ).mockResolvedValue();

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
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    vi.spyOn(browserService, "selectOrCreateTab").mockResolvedValue({
      success: true,
      tabIndex: 0,
    });

    // Mock resizeBrowser to avoid database call
    vi.spyOn(
      browserService as unknown as {
        resizeBrowser: () => Promise<void>;
      },
      "resizeBrowser",
    ).mockResolvedValue();

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
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

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

    const conversationId = "test-conversation";
    const result = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    expect(result).toBe("https://current.example.com");
  });

  test("getCurrentUrl reads current tab URL from numeric current flag", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

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

    const result = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    expect(result).toBe("https://numeric-current.example.com");
  });

  test("getCurrentUrl reads current tab URL from top-level currentIndex", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

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

    const result = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "list" },
    });
    expect(result).toBe("https://current-index.example.com");
  });

  test("getCurrentUrl fetches fresh data on each call (no caching)", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

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
            { index: 0, url: "https://example.com", current: true },
          ]),
        },
      ],
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const first = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );
    const second = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(first).toBe("https://example.com");
    expect(second).toBe("https://example.com");
    // Each call should fetch fresh data, no caching
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  test("selectOrCreateTab selects existing tab when stored tabIndex exists", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock state manager to return stored tabIndex
    vi.spyOn(browserStateManager, "get").mockResolvedValue({
      url: "https://stored.example.com",
      tabIndex: 2,
    });

    // Mock findTabsTool
    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const callTool = vi.fn().mockImplementation(async (request) => {
      if (request.arguments?.action === "list") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { index: 0, url: "https://a.example.com" },
                { index: 1, url: "https://b.example.com" },
                { index: 2, url: "https://stored.example.com" },
              ]),
            },
          ],
        };
      }
      return { isError: false, content: [] };
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 2 });
    // Should have selected the existing tab
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "select", index: 2 },
    });
  });

  test("selectOrCreateTab creates new tab when no stored tabIndex", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock state manager to return no stored state
    vi.spyOn(browserStateManager, "get").mockResolvedValue(null);
    vi.spyOn(browserStateManager, "set").mockResolvedValue(Ok(undefined));

    // Mock findTabsTool
    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    let listCallCount = 0;
    const callTool = vi.fn().mockImplementation(async (request) => {
      if (request.arguments?.action === "list") {
        listCallCount++;
        // After "new" action, return updated list with new tab
        const tabs =
          listCallCount === 1
            ? [{ index: 0, url: "https://existing.example.com" }]
            : [
                { index: 0, url: "https://existing.example.com" },
                { index: 1, url: "about:blank" },
              ];
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(tabs) }],
        };
      }
      return { isError: false, content: [] };
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 1 });
    // Should have created a new tab
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "new" },
    });
  });

  test("selectOrCreateTab creates new tab and navigates to stored URL", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock state manager to return stored URL but no tabIndex (tab was closed)
    vi.spyOn(browserStateManager, "get").mockResolvedValue({
      url: "https://stored.example.com",
    });
    vi.spyOn(browserStateManager, "set").mockResolvedValue(Ok(undefined));

    // Mock findTabsTool and findNavigateTool
    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    vi.spyOn(
      browserService as unknown as {
        findNavigateTool: () => Promise<string | null>;
      },
      "findNavigateTool",
    ).mockResolvedValue("browser_navigate");

    let listCallCount = 0;
    const callTool = vi.fn().mockImplementation(async (request) => {
      if (request.arguments?.action === "list") {
        listCallCount++;
        const tabs =
          listCallCount === 1
            ? [{ index: 0, url: "https://other.example.com" }]
            : [
                { index: 0, url: "https://other.example.com" },
                { index: 1, url: "about:blank" },
              ];
        return {
          isError: false,
          content: [{ type: "text", text: JSON.stringify(tabs) }],
        };
      }
      return { isError: false, content: [] };
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 1 });
    // Should have navigated to stored URL
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_navigate",
      arguments: { url: "https://stored.example.com" },
    });
  });

  test("selectOrCreateTab deduplicates concurrent calls", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-concurrent";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock state manager
    vi.spyOn(browserStateManager, "get").mockResolvedValue({
      url: "https://stored.example.com",
      tabIndex: 1,
    });

    // Mock findTabsTool
    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const callTool = vi.fn().mockImplementation(async (request) => {
      if (request.arguments?.action === "list") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { index: 0, url: "https://a.example.com" },
                { index: 1, url: "https://stored.example.com" },
              ]),
            },
          ],
        };
      }
      return { isError: false, content: [] };
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const [firstResult, secondResult] = await Promise.all([
      browserService.selectOrCreateTab(agentId, conversationId, userContext),
      browserService.selectOrCreateTab(agentId, conversationId, userContext),
    ]);

    expect(firstResult).toEqual({ success: true, tabIndex: 1 });
    expect(secondResult).toEqual({ success: true, tabIndex: 1 });

    // Should only have called select once (deduplication)
    const selectCalls = callTool.mock.calls.filter(
      (call) => call[0].arguments?.action === "select",
    );
    expect(selectCalls).toHaveLength(1);
  });

  test("selectOrCreateTab reuses blank tab instead of creating new", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    // Mock state manager to return no stored state
    vi.spyOn(browserStateManager, "get").mockResolvedValue(null);
    vi.spyOn(browserStateManager, "set").mockResolvedValue(Ok(undefined));

    // Mock findTabsTool
    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const callTool = vi.fn().mockImplementation(async (request) => {
      if (request.arguments?.action === "list") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify([
                { index: 0, url: "https://existing.example.com" },
                { index: 1, url: "about:blank" }, // Blank tab to reuse
              ]),
            },
          ],
        };
      }
      return { isError: false, content: [] };
    });

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 1 });
    // Should have selected the blank tab, NOT created a new one
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "select", index: 1 },
    });
    expect(callTool).not.toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "new" },
    });
  });

  test("syncUrlFromNavigateToolCall extracts URL from goto call", async () => {
    const browserService = new BrowserStreamService();
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    const updateUrlSpy = vi
      .spyOn(browserStateManager, "updateUrl")
      .mockResolvedValue();

    const toolResultContent = [
      {
        type: "text",
        text: "Navigation completed. await page.goto('https://navigated.example.com');",
      },
    ];

    await browserService.syncUrlFromNavigateToolCall({
      agentId: "test-agent",
      conversationId,
      userContext,
      toolResultContent,
    });

    expect(updateUrlSpy).toHaveBeenCalledWith(
      conversationId,
      "https://navigated.example.com",
    );
  });

  test("syncUrlFromNavigateToolCall extracts URL from Page URL format", async () => {
    const browserService = new BrowserStreamService();
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    const updateUrlSpy = vi
      .spyOn(browserStateManager, "updateUrl")
      .mockResolvedValue();

    const toolResultContent = [
      {
        type: "text",
        text: "Navigation successful.\nPage URL: https://page-url.example.com\n",
      },
    ];

    await browserService.syncUrlFromNavigateToolCall({
      agentId: "test-agent",
      conversationId,
      userContext,
      toolResultContent,
    });

    expect(updateUrlSpy).toHaveBeenCalledWith(
      conversationId,
      "https://page-url.example.com",
    );
  });
});
