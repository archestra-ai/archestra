import * as chatMcpClient from "@/clients/chat-mcp-client";
import logger from "@/logging";
import { beforeEach, describe, expect, test, vi } from "@/test";
import { BrowserStreamService } from "./browser-stream.service";
import {
  type BrowserState,
  None,
  Ok,
  Some,
} from "./browser-stream.state.types";
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

  test("getCurrentUrl caches browser_tabs list for 3 seconds and resets on invalidation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));

    try {
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
              { index: 0, url: "https://cached.example.com", current: true },
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

      expect(first).toBe("https://cached.example.com");
      expect(second).toBe("https://cached.example.com");
      expect(callTool).toHaveBeenCalledTimes(1);

      const invalidateTabsListCache = (
        browserService as unknown as {
          invalidateTabsListCache: (params: {
            agentId: string;
            userContext: { userId: string; userIsProfileAdmin: boolean };
            tabsTool: string;
          }) => void;
        }
      ).invalidateTabsListCache.bind(browserService);

      invalidateTabsListCache({
        agentId,
        userContext,
        tabsTool: "browser_tabs",
      });

      const third = await browserService.getCurrentUrl(
        agentId,
        conversationId,
        userContext,
      );

      expect(third).toBe("https://cached.example.com");
      expect(callTool).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("selectOrCreateTab uses MCP-provided tab indices", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-provided";
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

    // Also mock findToolName to avoid database call from findNavigateTool
    vi.spyOn(
      browserService as unknown as {
        findToolName: () => Promise<string | null>;
      },
      "findToolName",
    ).mockResolvedValue("browser_navigate");

    let listCallCount = 0;
    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          listCallCount += 1;
          const tabs =
            listCallCount < 3
              ? [
                  { index: 1, title: "One" },
                  { index: 4, title: "Four" },
                ]
              : [
                  { index: 1, title: "One" },
                  { index: 4, title: "Four" },
                  { index: 7, title: "Seven" },
                ];
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify(tabs),
              },
            ],
          };
        }
        return { isError: false, content: [] };
      },
    );

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

    // Also mock findToolName to avoid database call from findNavigateTool
    vi.spyOn(
      browserService as unknown as {
        findToolName: () => Promise<string | null>;
      },
      "findToolName",
    ).mockResolvedValue("browser_navigate");

    let listCallCount = 0;
    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          listCallCount += 1;
          const tabs =
            listCallCount < 3
              ? [
                  { index: 5, title: "Five" },
                  { index: 7, title: "Seven" },
                ]
              : [
                  { index: 5, title: "Five" },
                  { index: 7, title: "Seven" },
                  { index: 3, title: "Reused" },
                ];
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify(tabs),
              },
            ],
          };
        }
        return { isError: false, content: [] };
      },
    );

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

  test("selectOrCreateTab deduplicates concurrent tab creation", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-concurrent";
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

    // Also mock findToolName to avoid database call from findNavigateTool
    vi.spyOn(
      browserService as unknown as {
        findToolName: () => Promise<string | null>;
      },
      "findToolName",
    ).mockResolvedValue("browser_navigate");

    vi.spyOn(browserStateManager, "getOrLoad").mockResolvedValue(Ok(null));

    let listCallCount = 0;
    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          listCallCount += 1;
          const tabs = listCallCount < 3 ? [] : [{ index: 0, title: "New" }];
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify(tabs),
              },
            ],
          };
        }
        if (action === "new" || action === "select") {
          return { isError: false, content: [] };
        }
        return { isError: false, content: [] };
      },
    );

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const [firstResult, secondResult] = await Promise.all([
      browserService.selectOrCreateTab(agentId, conversationId, userContext),
      browserService.selectOrCreateTab(agentId, conversationId, userContext),
    ]);

    expect(firstResult).toEqual({ success: true, tabIndex: 0 });
    expect(secondResult).toEqual({ success: true, tabIndex: 0 });

    const newCalls = callTool.mock.calls.filter(
      ([request]) => request.arguments?.action === "new",
    );
    expect(newCalls).toHaveLength(1);
  });

  test("selectOrCreateTab logs browser_tabs new action", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-log";
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

    // Also mock findToolName to avoid database call from findNavigateTool
    vi.spyOn(
      browserService as unknown as {
        findToolName: () => Promise<string | null>;
      },
      "findToolName",
    ).mockResolvedValue("browser_navigate");

    vi.spyOn(browserStateManager, "getOrLoad").mockResolvedValue(Ok(null));
    vi.spyOn(browserStateManager, "set").mockImplementation(async (params) =>
      Ok(params.state),
    );

    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify([]),
              },
            ],
          };
        }
        return { isError: false, content: [] };
      },
    );

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const infoSpy = vi
      .spyOn(logger, "info")
      .mockImplementation(() => undefined);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 0 });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId,
        conversationId,
        userId: userContext.userId,
        action: "new",
      }),
      "[BrowserTabs] browser_tabs action",
    );
  });

  test("syncTabMappingFromTabsToolCall uses current tab index from list", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-current";
    const userContext = {
      userId: "test-user",
      organizationId: "test-org",
      userIsProfileAdmin: false,
    };

    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1", "tab-2"],
      tabs: [
        {
          id: "tab-1",
          index: None,
          current: "about:blank",
        },
        {
          id: "tab-2",
          index: None,
          current: "about:blank",
        },
      ],
    };

    vi.spyOn(browserStateManager, "getOrLoad").mockResolvedValue(Ok(state));
    const setSpy = vi
      .spyOn(browserStateManager, "set")
      .mockImplementation(async (params) => Ok(params.state));

    const toolResultContent = [
      {
        type: "text",
        text: JSON.stringify([
          { index: 0, title: "One", current: false },
          { index: 1, title: "Two", current: true },
        ]),
      },
    ];

    await browserService.syncTabMappingFromTabsToolCall({
      agentId,
      conversationId,
      userContext,
      toolArguments: { action: "list" },
      toolResultContent,
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const updatedState = setSpy.mock.calls[0][0].state;
    expect(updatedState.activeTabId).toBe("tab-2");
  });

  test("selectOrCreateTab reuses about:blank tab when list count mismatches", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-blank-reuse";
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

    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        {
          id: "tab-1",
          index: None,
          current: "about:blank",
        },
      ],
    };

    vi.spyOn(browserStateManager, "getOrLoad").mockResolvedValue(Ok(state));
    const setSpy = vi
      .spyOn(browserStateManager, "set")
      .mockImplementation(async (params) => Ok(params.state));

    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify([
                  {
                    index: 0,
                    title: "Blank",
                    url: "about:blank",
                    current: true,
                  },
                  {
                    index: 2,
                    title: "Other",
                    url: "https://other.example.com",
                  },
                ]),
              },
            ],
          };
        }
        return { isError: false, content: [] };
      },
    );

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 0 });
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "select", index: 0 },
    });
    expect(callTool).not.toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "new" },
    });
    const updatedState = setSpy.mock.calls[0]?.[0]?.state;
    const activeTab = updatedState?.tabs.find((tab) => tab.id === "tab-1");
    expect(activeTab?.index).toEqual(Some(0));
  });

  test("selectOrCreateTab restores URL after reusing about:blank tab", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-restore-url";
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
    vi.spyOn(
      browserService as unknown as {
        findNavigateTool: () => Promise<string | null>;
      },
      "findNavigateTool",
    ).mockResolvedValue("browser_navigate");

    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        {
          id: "tab-1",
          index: None,
          current: "https://stored.example.com",
        },
      ],
    };

    vi.spyOn(browserStateManager, "getOrLoad").mockResolvedValue(Ok(state));
    vi.spyOn(browserStateManager, "set").mockImplementation(async (params) =>
      Ok(params.state),
    );

    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify([
                  {
                    index: 0,
                    title: "Blank",
                    url: "about:blank",
                    current: true,
                  },
                  {
                    index: 1,
                    title: "Other",
                    url: "https://other.example.com",
                  },
                ]),
              },
            ],
          };
        }
        return { isError: false, content: [] };
      },
    );

    vi.spyOn(chatMcpClient, "getChatMcpClient").mockResolvedValue({
      callTool,
    } as never);

    const result = await browserService.selectOrCreateTab(
      agentId,
      conversationId,
      userContext,
    );

    expect(result).toEqual({ success: true, tabIndex: 0 });
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_tabs",
      arguments: { action: "select", index: 0 },
    });
    expect(callTool).toHaveBeenCalledWith({
      name: "browser_navigate",
      arguments: { url: "https://stored.example.com" },
    });
  });

  test("selectOrCreateTab matches tab by URL when stored index is stale", async () => {
    const browserService = new BrowserStreamService();
    const agentId = "test-agent";
    const conversationId = "test-conversation-stale";
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
    vi.spyOn(
      browserService as unknown as {
        findNavigateTool: () => Promise<string | null>;
      },
      "findNavigateTool",
    ).mockResolvedValue(null);

    const state: BrowserState = {
      activeTabId: "tab-1",
      tabOrder: ["tab-1"],
      tabs: [
        {
          id: "tab-1",
          index: Some(1),
          current: "https://stored.example.com",
        },
      ],
    };

    vi.spyOn(browserStateManager, "getOrLoad").mockResolvedValue(Ok(state));
    const setSpy = vi
      .spyOn(browserStateManager, "set")
      .mockImplementation(async (params) => Ok(params.state));

    const callTool = vi.fn(
      async (request: { arguments?: Record<string, unknown> }) => {
        const action = request.arguments?.action;
        if (action === "list") {
          return {
            isError: false,
            content: [
              {
                type: "text",
                text: JSON.stringify([
                  {
                    index: 0,
                    title: "Start",
                    url: "https://start.example.com",
                    current: true,
                  },
                  {
                    index: 1,
                    title: "Wrong",
                    url: "https://wrong.example.com",
                  },
                  {
                    index: 3,
                    title: "Stored",
                    url: "https://stored.example.com",
                  },
                ]),
              },
            ],
          };
        }
        return { isError: false, content: [] };
      },
    );

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
    const updatedState = setSpy.mock.calls[0]?.[0]?.state;
    const activeTab = updatedState?.tabs.find((tab) => tab.id === "tab-1");
    expect(activeTab?.index).toEqual(Some(3));
  });
});

describe("BrowserStreamService extractCurrentTabIndexFromTabsContent", () => {
  test("parses current tab index from Playwright MCP format", () => {
    const browserService = new BrowserStreamService();

    // Access private method for testing
    const extractCurrentTabIndex = (
      browserService as unknown as {
        extractCurrentTabIndexFromTabsContent: (
          content: unknown,
        ) => number | undefined;
      }
    ).extractCurrentTabIndexFromTabsContent.bind(browserService);

    // Test format: "- 0: (current) [Title] (URL)"
    const content = [
      {
        type: "text",
        text: "### Open tabs\n- 0: (current) [Google] (https://www.google.com/)\n",
      },
    ];

    const result = extractCurrentTabIndex(content);
    expect(result).toBe(0);
  });

  test("parses current tab index when not first tab", () => {
    const browserService = new BrowserStreamService();

    const extractCurrentTabIndex = (
      browserService as unknown as {
        extractCurrentTabIndexFromTabsContent: (
          content: unknown,
        ) => number | undefined;
      }
    ).extractCurrentTabIndexFromTabsContent.bind(browserService);

    // Test with tab 2 as current
    const content = [
      {
        type: "text",
        text: "### Open tabs\n- 0: [Tab1] (https://a.com)\n- 1: [Tab2] (https://b.com)\n- 2: (current) [Tab3] (https://c.com)\n",
      },
    ];

    const result = extractCurrentTabIndex(content);
    expect(result).toBe(2);
  });

  test("returns undefined when no current tab marker", () => {
    const browserService = new BrowserStreamService();

    const extractCurrentTabIndex = (
      browserService as unknown as {
        extractCurrentTabIndexFromTabsContent: (
          content: unknown,
        ) => number | undefined;
      }
    ).extractCurrentTabIndexFromTabsContent.bind(browserService);

    const content = [
      {
        type: "text",
        text: "### Open tabs\n- 0: [Tab1] (https://a.com)\n",
      },
    ];

    const result = extractCurrentTabIndex(content);
    expect(result).toBeUndefined();
  });
});
