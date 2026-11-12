import { and, eq } from "drizzle-orm";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import McpServerModel from "@/models/mcp-server";
import ToolModel from "@/models/tool";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { reloadToolsForServer } from "@/services/mcp-reinstall";
import { describe, expect, type TestFixtures, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  connectTestDevice,
  runTestTunnelClient,
  type TestDevice,
  waitUntilOnline,
} from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import { desktopMcpInstallService } from "./desktop-mcp-install";

/**
 * A desktop MCP installation waits until the tunnel client of its owner
 * reports the MCP server ready; then its tools are read through the tunnel.
 */
describe("desktopMcpInstallService", () => {
  setupTestCacheManager();
  const ctx = useRouteTestApp(desktopTunnelRoutes);

  type ToolSpec = { name: string; description: string };

  /** A tunnel client whose MCP server on the channel offers these tools. */
  function runServer(params: {
    device: TestDevice;
    channel: string;
    tools: ToolSpec[] | (() => never);
    asked?: string[];
  }) {
    return runTestTunnelClient({
      app: ctx.app,
      device: params.device,
      readyChannels: [params.channel],
      answer: ({ channel, method }) => {
        if (channel === params.channel) params.asked?.push(method);
        if (method === "initialize") {
          return {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "files", version: "1.0.0" },
          };
        }
        if (method === "tools/list") {
          const tools =
            typeof params.tools === "function" ? params.tools() : params.tools;
          return {
            tools: tools.map((tool) => ({
              ...tool,
              inputSchema: { type: "object", properties: {} },
            })),
          };
        }
        return {};
      },
    });
  }

  async function makeFilesItem(
    makeInternalMcpCatalog: TestFixtures["makeInternalMcpCatalog"],
  ) {
    return makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "files",
      serverType: "desktop_mcp",
      desktopConfig: { command: "/opt/files/mcp" },
    });
  }

  async function statusOf(mcpServerId: string) {
    return (await McpServerModel.findById(mcpServerId))
      ?.localInstallationStatus;
  }

  /** The tools on the user's personal MCP gateway, bound to the installation. */
  async function gatewayTools(userId: string, mcpServerId: string) {
    const gateway = await AgentModel.ensurePersonalMcpGateway({
      userId,
      organizationId: ctx.organizationId,
    });
    const rows = await db
      .select({
        name: schema.toolsTable.name,
        description: schema.toolsTable.description,
      })
      .from(schema.agentToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.agentToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.agentToolsTable.agentId, gateway.id),
          eq(schema.agentToolsTable.mcpServerId, mcpServerId),
        ),
      );
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  test("a waiting installation completes when the device reports its MCP server ready, with the tools on the owner's personal gateway", async ({
    makeInternalMcpCatalog,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const catalogItem = await makeFilesItem(makeInternalMcpCatalog);
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const installation = await desktopMcpInstallService.install({
      catalogItem,
      userId: ctx.user.id,
    });
    expect(installation.localInstallationStatus).toBe("pending");

    const tunnelClient = runServer({
      device,
      channel: catalogItem.id,
      tools: [
        { name: "write_file", description: "Writes a file" },
        { name: "read_file", description: "Reads a file" },
      ],
    });
    try {
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");

      expect(await gatewayTools(ctx.user.id, installation.id)).toEqual([
        { name: "files__read_file", description: "Reads a file" },
        { name: "files__write_file", description: "Writes a file" },
      ]);
      expect(await McpServerModel.findByCatalogIds([catalogItem.id])).toEqual([
        expect.objectContaining({ id: installation.id }),
      ]);
    } finally {
      await tunnelClient.stop();
    }
  });

  test("a cloned catalog item shows the tools its server confirms, and drops the copied ones it does not report", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeTool,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const source = await makeFilesItem(makeInternalMcpCatalog);
    await makeTool({ name: "files__read_file", catalogId: source.id });
    await makeTool({ name: "files__gone_tool", catalogId: source.id });
    const clone = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "files copy",
      serverType: "desktop_mcp",
      desktopConfig: { command: "/opt/files/mcp" },
    });
    // What cloning a catalog item does: the tools of the source, hidden until
    // an installation confirms them.
    await ToolModel.cloneToolsFromCatalog({
      sourceCatalogId: source.id,
      targetCatalogId: clone.id,
      targetCatalogName: clone.name,
    });
    const visibleTools = async () =>
      (
        await ToolModel.findByCatalogId(clone.id, {
          kind: "internal",
          purpose: "install",
        })
      )
        .map((tool) => tool.name)
        .sort();
    expect(await visibleTools()).toEqual([]);

    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const installation = await desktopMcpInstallService.install({
      catalogItem: clone,
      userId: ctx.user.id,
    });
    const tunnelClient = runServer({
      device,
      channel: clone.id,
      tools: [{ name: "read_file", description: "Reads a file" }],
    });
    try {
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");

      expect(await visibleTools()).toEqual(["files_copy__read_file"]);
      expect(
        (await gatewayTools(ctx.user.id, installation.id)).map(
          (tool) => tool.name,
        ),
      ).toEqual(["files_copy__read_file"]);
    } finally {
      await tunnelClient.stop();
    }
  });

  test("reloading the tools from one computer adds what is new, and does not change or delete a stored tool", async ({
    makeInternalMcpCatalog,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const catalogItem = await makeFilesItem(makeInternalMcpCatalog);
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const installation = await desktopMcpInstallService.install({
      catalogItem,
      userId: ctx.user.id,
    });
    const serverTools = [
      { name: "write_file", description: "Writes a file" },
      { name: "read_file", description: "Reads a file" },
    ];
    const tunnelClient = runServer({
      device,
      channel: catalogItem.id,
      tools: serverTools,
    });
    const storedTools = async () =>
      (
        await ToolModel.findByCatalogId(catalogItem.id, {
          kind: "internal",
          purpose: "install",
        })
      )
        .map((tool) => `${tool.name}: ${tool.description}`)
        .sort();
    try {
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");

      // This computer now runs another version of the server: one tool is
      // gone, one has a new description, one is new.
      serverTools.splice(
        0,
        serverTools.length,
        { name: "read_file", description: "Reads a file, version 2" },
        { name: "list_files", description: "Lists files" },
      );
      const result = await reloadToolsForServer(installation);

      expect(result).toEqual({
        created: 1,
        updated: 0,
        unchanged: 1,
        deleted: 0,
      });
      expect(await storedTools()).toEqual([
        "files__list_files: Lists files",
        "files__read_file: Reads a file",
        "files__write_file: Writes a file",
      ]);
    } finally {
      await tunnelClient.stop();
    }
  });

  test("a ready MCP server that the user did not install gets no installation", async ({
    makeInternalMcpCatalog,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const catalogItem = await makeFilesItem(makeInternalMcpCatalog);
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const asked: string[] = [];
    const tunnelClient = runServer({
      device,
      channel: catalogItem.id,
      tools: [{ name: "read_file", description: "Reads a file" }],
      asked,
    });
    try {
      await waitUntilOnline(device.device.id);
      await desktopMcpInstallService.completeWaiting(device.device, [
        catalogItem.id,
      ]);

      expect(await McpServerModel.findByCatalogIds([catalogItem.id])).toEqual(
        [],
      );
      expect(asked).toEqual([]);
    } finally {
      await tunnelClient.stop();
    }
  });

  test("an installation stays waiting when the tool list cannot be read", async ({
    makeInternalMcpCatalog,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const catalogItem = await makeFilesItem(makeInternalMcpCatalog);
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const installation = await desktopMcpInstallService.install({
      catalogItem,
      userId: ctx.user.id,
    });
    const asked: string[] = [];
    const tunnelClient = runServer({
      device,
      channel: catalogItem.id,
      tools: () => {
        throw new Error("MATLAB is not running");
      },
      asked,
    });
    try {
      await expect
        .poll(() => asked.includes("tools/list"), { timeout: 10_000 })
        .toBe(true);
      await expect.poll(() => statusOf(installation.id)).toBe("pending");

      expect(await gatewayTools(ctx.user.id, installation.id)).toEqual([]);
    } finally {
      await tunnelClient.stop();
    }
  });

  test("a second user's installation gets the stored tools and adds the missing ones; a stored tool does not change", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const second = await makeUser();
    await makeMember(second.id, ctx.organizationId);
    const catalogItem = await makeFilesItem(makeInternalMcpCatalog);

    // The first user's installation stores the tool list.
    const firstDevice = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const first = await desktopMcpInstallService.install({
      catalogItem,
      userId: ctx.user.id,
    });
    const firstClient = runServer({
      device: firstDevice,
      channel: catalogItem.id,
      tools: [{ name: "read_file", description: "Reads a file" }],
    });
    try {
      await expect
        .poll(() => statusOf(first.id), { timeout: 10_000 })
        .toBe("success");
    } finally {
      await firstClient.stop();
    }

    // The second user's MCP server is a newer version: it describes the same
    // tool differently and has one more.
    const secondDevice = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: second.id,
    });
    const installation = await desktopMcpInstallService.install({
      catalogItem,
      userId: second.id,
    });
    const secondClient = runServer({
      device: secondDevice,
      channel: catalogItem.id,
      tools: [
        { name: "read_file", description: "Reads a file, newer version" },
        { name: "list_files", description: "Lists files" },
      ],
    });
    try {
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");

      expect(await gatewayTools(second.id, installation.id)).toEqual([
        { name: "files__list_files", description: "Lists files" },
        { name: "files__read_file", description: "Reads a file" },
      ]);
      // The first user's gateway keeps its own installation's tools.
      expect(await gatewayTools(ctx.user.id, first.id)).toEqual([
        { name: "files__read_file", description: "Reads a file" },
      ]);
    } finally {
      await secondClient.stop();
    }
  });

  test("after the owner changes the arguments, the tools are read again, and not from the MCP server that still runs with the arguments from before", async ({
    makeInternalMcpCatalog,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const catalogItem = await makeFilesItem(makeInternalMcpCatalog);
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const installation = await desktopMcpInstallService.install({
      catalogItem,
      userId: ctx.user.id,
    });
    const serverTools = [{ name: "read_file", description: "Reads a file" }];
    const asked: string[] = [];
    // The device reports the MCP server ready the whole time, as a device
    // does until it got its config and stopped the server.
    const tunnelClient = runServer({
      device,
      channel: catalogItem.id,
      tools: serverTools,
      asked,
    });
    try {
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");
      asked.length = 0;

      const updated = await desktopMcpInstallService.updateArguments({
        mcpServerId: installation.id,
        userId: ctx.user.id,
        desktopArguments: ["--with-list"],
      });

      expect(updated.localInstallationStatus).toBe("pending");
      await desktopMcpInstallService.completeWaiting(device.device, [
        catalogItem.id,
      ]);
      expect(await statusOf(installation.id)).toBe("pending");
      expect(asked).not.toContain("tools/list");

      // The time the device has to stop that MCP server is over; the one it
      // started with the new arguments has one more tool.
      serverTools.push({ name: "list_files", description: "Lists files" });
      await cacheManager.delete(
        `${CacheKey.DesktopMcpInstallAttempt}-${installation.id}`,
      );
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");
      expect(await gatewayTools(ctx.user.id, installation.id)).toEqual([
        { name: "files__list_files", description: "Lists files" },
        { name: "files__read_file", description: "Reads a file" },
      ]);
    } finally {
      await tunnelClient.stop();
    }
  });
});
