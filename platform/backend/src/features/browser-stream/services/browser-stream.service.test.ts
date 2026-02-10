import { beforeEach, describe, expect, test, vi } from "@/test";
import { BrowserStreamService } from "./browser-stream.service";
import { Ok } from "./browser-stream.state.types";
import { browserStateManager } from "./browser-stream.state-manager";

/**
 * Helper to mock the private executeTool method on BrowserStreamService.
 * Since executeTool now calls mcpClient.executeToolCall directly (bypassing
 * the MCP Gateway), tests need to mock it at the service level.
 */
function mockExecuteTool(
  service: BrowserStreamService,
  handler: (params: {
    toolName: string;
    args: Record<string, unknown>;
  }) => Promise<{ content: unknown; isError: boolean }>,
) {
  return vi
    .spyOn(
      service as unknown as {
        executeTool: typeof handler;
      },
      "executeTool",
    )
    .mockImplementation(handler);
}

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

    // Mock executeTool for screenshot
    mockExecuteTool(browserService, async () => ({
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
    }));

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

    // Mock executeTool for screenshot
    mockExecuteTool(browserService, async () => ({
      isError: false,
      content: [
        {
          type: "image",
          data: "base64screenshotdata",
          mimeType: "image/png",
        },
      ],
    }));

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

    // Mock executeTool for screenshot - no image content
    mockExecuteTool(browserService, async () => ({
      isError: false,
      content: [{ type: "text", text: "No image content" }],
    }));

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

    const executeToolSpy = mockExecuteTool(browserService, async () => ({
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
    }));

    const conversationId = "test-conversation";
    const result = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "list" },
      }),
    );
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

    const executeToolSpy = mockExecuteTool(browserService, async () => ({
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
    }));

    const result = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "list" },
      }),
    );
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

    const executeToolSpy = mockExecuteTool(browserService, async () => ({
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
    }));

    const result = await browserService.getCurrentUrl(
      agentId,
      conversationId,
      userContext,
    );

    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "list" },
      }),
    );
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

    const executeToolSpy = mockExecuteTool(browserService, async () => ({
      isError: false,
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { index: 0, url: "https://example.com", current: true },
          ]),
        },
      ],
    }));

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
    expect(executeToolSpy).toHaveBeenCalledTimes(2);
  });

  test("selectOrCreateTab selects existing tab when stored tabIndex exists", async () => {
    const updateUrlSpy = vi
      .spyOn(browserStateManager, "updateUrl")
      .mockResolvedValue();

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

    const executeToolSpy = mockExecuteTool(browserService, async ({ args }) => {
      if (args?.action === "list") {
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

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 2 });
    // Should have selected the existing tab
    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "select", index: 2 },
      }),
    );
    expect(updateUrlSpy).toHaveBeenCalledWith(
      agentId,
      userContext.userId,
      conversationId,
      "https://stored.example.com",
    );
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
    const executeToolSpy = mockExecuteTool(browserService, async ({ args }) => {
      if (args?.action === "list") {
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

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 1 });
    // Should have created a new tab
    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "new" },
      }),
    );
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
    const setStateSpy = vi
      .spyOn(browserStateManager, "set")
      .mockResolvedValue(Ok(undefined));

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
    const executeToolSpy = mockExecuteTool(browserService, async ({ args }) => {
      if (args?.action === "list") {
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

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 1 });
    // Should have navigated to stored URL
    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_navigate",
        args: { url: "https://stored.example.com" },
      }),
    );
    expect(setStateSpy).toHaveBeenCalledWith(
      agentId,
      userContext.userId,
      conversationId,
      expect.objectContaining({
        url: "https://stored.example.com",
        tabIndex: 1,
      }),
    );
  });

  test("selectOrCreateTab restores stored URL when existing tab is blank", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    vi.spyOn(browserStateManager, "get").mockResolvedValue({
      url: "https://stored.example.com",
      tabIndex: 0,
    });
    const updateUrlSpy = vi
      .spyOn(browserStateManager, "updateUrl")
      .mockResolvedValue();

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

    const executeToolSpy = mockExecuteTool(browserService, async ({ args }) => {
      if (args?.action === "list") {
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify([{ index: 0, url: "about:blank" }]),
            },
          ],
        };
      }
      return { isError: false, content: [] };
    });

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 0 });
    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_navigate",
        args: { url: "https://stored.example.com" },
      }),
    );
    expect(updateUrlSpy).toHaveBeenCalledWith(
      agentId,
      userContext.userId,
      conversationId,
      "https://stored.example.com",
    );
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
    vi.spyOn(browserStateManager, "updateUrl").mockResolvedValue();

    // Mock findTabsTool
    vi.spyOn(
      browserService as unknown as {
        findTabsTool: () => Promise<string | null>;
      },
      "findTabsTool",
    ).mockResolvedValue("browser_tabs");

    const executeToolSpy = mockExecuteTool(browserService, async ({ args }) => {
      if (args?.action === "list") {
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

    const [firstResult, secondResult] = await Promise.all([
      browserService.selectOrCreateTab(agentId, conversationId, userContext),
      browserService.selectOrCreateTab(agentId, conversationId, userContext),
    ]);

    expect(firstResult).toEqual({ success: true, tabIndex: 1 });
    expect(secondResult).toEqual({ success: true, tabIndex: 1 });

    // Should only have called select once (deduplication)
    const selectCalls = executeToolSpy.mock.calls.filter(
      (call) => call[0].args?.action === "select",
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

    const executeToolSpy = mockExecuteTool(browserService, async ({ args }) => {
      if (args?.action === "list") {
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

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 1 });
    // Should have selected the blank tab, NOT created a new one
    expect(executeToolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "select", index: 1 },
      }),
    );
    expect(executeToolSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "browser_tabs",
        args: { action: "new" },
      }),
    );
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
      "test-agent",
      "test-user",
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
      "test-agent",
      "test-user",
      conversationId,
      "https://page-url.example.com",
    );
  });
});
