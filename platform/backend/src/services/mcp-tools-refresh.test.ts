import { eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import McpServerModel from "@/models/mcp-server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { mcpToolsRefreshManager } from "./mcp-tools-refresh";

describe("mcpToolsRefreshManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    mcpToolsRefreshManager.stop();
    vi.useRealTimers();
  });

  test("start() is a no-op when the interval is unset (opt-in)", () => {
    vi.useFakeTimers();
    // Pristine config default is 0 = disabled.
    mcpToolsRefreshManager.start();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("start() schedules the sweep when an interval is configured", () => {
    vi.useFakeTimers();
    config.mcpServer.toolsRefreshIntervalMinutes = 5;
    mcpToolsRefreshManager.start();
    expect(vi.getTimerCount()).toBe(1);
  });

  test("a sweep re-syncs each catalog and a failing server does not abort it", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const badCatalog = await makeInternalMcpCatalog({
      name: "refresh-bad-catalog",
      serverType: "remote",
    });
    await makeMcpServer({ catalogId: badCatalog.id, name: "bad-server" });

    const goodCatalog = await makeInternalMcpCatalog({
      name: "refresh-good-catalog",
      serverType: "remote",
    });
    await makeMcpServer({ catalogId: goodCatalog.id, name: "good-server" });

    vi.spyOn(McpServerModel, "getToolsFromServer").mockImplementation(
      async (server) => {
        if (server.catalogId === badCatalog.id) {
          throw new Error("upstream unreachable");
        }
        return [
          {
            name: "fresh_tool",
            description: "added upstream",
            inputSchema: { type: "object" },
          },
        ];
      },
    );

    await mcpToolsRefreshManager.refreshAll();

    // The reachable catalog was re-synced despite the failing one.
    const goodTools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, goodCatalog.id));
    expect(goodTools.map((t) => t.rawName)).toEqual(["fresh_tool"]);

    const badTools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, badCatalog.id));
    expect(badTools).toEqual([]);
  });

  test("refreshes one install per catalog, not one per server", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      name: "refresh-shared-catalog",
      serverType: "remote",
    });
    await makeMcpServer({ catalogId: catalog.id, name: "install-a" });
    await makeMcpServer({ catalogId: catalog.id, name: "install-b" });

    const getTools = vi
      .spyOn(McpServerModel, "getToolsFromServer")
      .mockResolvedValue([
        { name: "t", description: "", inputSchema: { type: "object" } },
      ]);

    await mcpToolsRefreshManager.refreshAll();

    expect(getTools).toHaveBeenCalledTimes(1);
  });
});
