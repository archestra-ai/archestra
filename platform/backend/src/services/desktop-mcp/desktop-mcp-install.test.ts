import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import McpServerModel from "@/models/mcp-server";
import ToolModel from "@/models/tool";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
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

  /**
   * A tunnel client whose MCP server on the channel offers these tools. With
   * `ready: false` its polls name no channel ready: only what the test does
   * itself can complete an installation.
   */
  function runServer(params: {
    device: TestDevice;
    channel: string;
    tools: ToolSpec[] | (() => never);
    asked?: string[];
    ready?: boolean;
  }) {
    return runTestTunnelClient({
      app: ctx.app,
      device: params.device,
      readyChannels: params.ready === false ? [] : [params.channel],
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

  /** The state report of the tunnel client for one MCP server. */
  async function report(
    device: TestDevice,
    channel: string,
    state: "starting" | "running" | "failed",
  ) {
    const response = await ctx.app.inject({
      method: "POST",
      url: `/v1/tunnels/${device.tunnelId}/response`,
      headers: device.headers,
      payload: {
        request_id: randomUUID(),
        channel: DESKTOP_BRIDGE_CHANNEL,
        resp_code: 200,
        resp_type: "jsonrpc_notify",
        resp_json: {
          jsonrpc: "2.0",
          method: "bridge/state",
          params: { servers: [{ channel, state, error: null }] },
        },
      },
    });
    expect(response.statusCode).toBe(200);
  }

  async function storedState(device: TestDevice, catalogId: string) {
    const rows = await DesktopDeviceServerModel.findByDeviceId(
      device.device.id,
    );
    return rows.find((row) => row.catalogId === catalogId)?.state ?? null;
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

  describe("the order of the poll and the state report of a first installation", () => {
    const tools = [{ name: "read_file", description: "Reads a file" }];

    async function waitingInstallation(
      makeInternalMcpCatalog: TestFixtures["makeInternalMcpCatalog"],
      makeMember: TestFixtures["makeMember"],
    ) {
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
      return { catalogItem, device, installation };
    }

    test("the report that the MCP server runs completes the installation, with no poll that names it ready", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      const { catalogItem, device, installation } = await waitingInstallation(
        makeInternalMcpCatalog,
        makeMember,
      );
      const tunnelClient = runServer({
        device,
        channel: catalogItem.id,
        tools,
        ready: false,
      });
      try {
        // The tools are read through the tunnel: the device must be online.
        await waitUntilOnline(device.device.id);
        await report(device, catalogItem.id, "starting");
        expect(await statusOf(installation.id)).toBe("pending");

        await report(device, catalogItem.id, "running");

        await expect
          .poll(() => statusOf(installation.id), { timeout: 10_000 })
          .toBe("success");
        expect(await gatewayTools(ctx.user.id, installation.id)).toEqual([
          { name: "files__read_file", description: "Reads a file" },
        ]);
      } finally {
        await tunnelClient.stop();
      }
    });

    test("a poll that names it ready before the report came waits for the report, and uses up no attempt", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      const { catalogItem, device, installation } = await waitingInstallation(
        makeInternalMcpCatalog,
        makeMember,
      );
      const asked: string[] = [];
      const tunnelClient = runServer({
        device,
        channel: catalogItem.id,
        tools,
        asked,
        ready: false,
      });
      try {
        // The tools are read through the tunnel: the device must be online.
        await waitUntilOnline(device.device.id);
        await report(device, catalogItem.id, "starting");
        // What a poll with the channel ready does.
        await desktopMcpInstallService.completeWaiting(device.device, [
          catalogItem.id,
        ]);
        expect(await statusOf(installation.id)).toBe("pending");
        expect(asked).toEqual([]);

        // Were the poll counted as an attempt, this one would wait a minute.
        await report(device, catalogItem.id, "running");

        await expect
          .poll(() => statusOf(installation.id), { timeout: 10_000 })
          .toBe("success");
      } finally {
        await tunnelClient.stop();
      }
    });

    test("a poll that names it ready completes the installation when no state is stored, and when the stored one is running", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      const { catalogItem, device, installation } = await waitingInstallation(
        makeInternalMcpCatalog,
        makeMember,
      );
      const tunnelClient = runServer({
        device,
        channel: catalogItem.id,
        tools,
        ready: false,
      });
      try {
        // The tools are read through the tunnel: the device must be online.
        await waitUntilOnline(device.device.id);
        expect(await storedState(device, catalogItem.id)).toBeNull();
        await desktopMcpInstallService.completeWaiting(device.device, [
          catalogItem.id,
        ]);
        expect(await statusOf(installation.id)).toBe("success");

        // The user disconnects it and connects it again: the state from
        // before is still stored.
        await McpServerModel.delete(installation.id);
        await report(device, catalogItem.id, "running");
        const again = await desktopMcpInstallService.install({
          catalogItem,
          userId: ctx.user.id,
        });
        expect(again.id).not.toBe(installation.id);
        await desktopMcpInstallService.completeWaiting(device.device, [
          catalogItem.id,
        ]);
        expect(await statusOf(again.id)).toBe("success");
      } finally {
        await tunnelClient.stop();
      }
    });

    test("a report that the MCP server failed, or that it starts, names no installation to complete", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      const { catalogItem, device, installation } = await waitingInstallation(
        makeInternalMcpCatalog,
        makeMember,
      );
      const completed = vi.spyOn(
        desktopMcpInstallService,
        "completeReadyChannels",
      );

      try {
        await report(device, catalogItem.id, "failed");
        await report(device, catalogItem.id, "starting");

        expect(completed.mock.calls.map(([, channels]) => channels)).toEqual([
          [],
          [],
        ]);
        expect(await statusOf(installation.id)).toBe("pending");
      } finally {
        completed.mockRestore();
      }
    });
  });

  describe("a change of the arguments", () => {
    async function completeInstallation(
      params: {
        makeInternalMcpCatalog: TestFixtures["makeInternalMcpCatalog"];
        makeMember: TestFixtures["makeMember"];
        programVersion?: string;
      },
      serverTools: ToolSpec[],
      asked: string[],
    ) {
      await params.makeMember(ctx.user.id, ctx.organizationId);
      const catalogItem = await makeFilesItem(params.makeInternalMcpCatalog);
      const device = await connectTestDevice({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        programVersion: params.programVersion,
      });
      const installation = await desktopMcpInstallService.install({
        catalogItem,
        userId: ctx.user.id,
      });
      // The device names the MCP server ready with each poll, as a device
      // does until it got its config and stopped the server.
      const tunnelClient = runServer({
        device,
        channel: catalogItem.id,
        tools: serverTools,
        asked,
      });
      await waitUntilOnline(device.device.id);
      await report(device, catalogItem.id, "running");
      await expect
        .poll(() => statusOf(installation.id), { timeout: 10_000 })
        .toBe("success");
      asked.length = 0;
      return { catalogItem, device, installation, tunnelClient };
    }

    test("the tools are read again when the device reports that the MCP server runs, not from the one that still runs with the arguments from before", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      const serverTools = [{ name: "read_file", description: "Reads a file" }];
      const asked: string[] = [];
      const { catalogItem, device, installation, tunnelClient } =
        await completeInstallation(
          { makeInternalMcpCatalog, makeMember, programVersion: "0.1.2" },
          serverTools,
          asked,
        );
      try {
        const updated = await desktopMcpInstallService.updateArguments({
          mcpServerId: installation.id,
          userId: ctx.user.id,
          desktopArguments: ["--with-list"],
        });

        expect(updated.changed).toBe(true);
        expect(updated.mcpServer.localInstallationStatus).toBe("pending");
        expect(await storedState(device, catalogItem.id)).toBe("starting");
        // The polls of the device still name the old MCP server ready.
        await desktopMcpInstallService.completeWaiting(device.device, [
          catalogItem.id,
        ]);
        expect(await statusOf(installation.id)).toBe("pending");
        expect(asked).not.toContain("tools/list");

        // The device got its config: it stops the MCP server, starts it with
        // the new arguments, and reports each step. The new one has one more
        // tool.
        serverTools.push({ name: "list_files", description: "Lists files" });
        await report(device, catalogItem.id, "starting");
        expect(await statusOf(installation.id)).toBe("pending");
        await report(device, catalogItem.id, "running");

        // At once, though the tools were read less than a minute ago.
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

    async function expectStoredAndNothingElse(
      fixtures: {
        makeInternalMcpCatalog: TestFixtures["makeInternalMcpCatalog"];
        makeMember: TestFixtures["makeMember"];
      },
      programVersion: string | undefined,
    ) {
      const asked: string[] = [];
      const { catalogItem, device, installation, tunnelClient } =
        await completeInstallation(
          { ...fixtures, programVersion },
          [{ name: "read_file", description: "Reads a file" }],
          asked,
        );
      try {
        const updated = await desktopMcpInstallService.updateArguments({
          mcpServerId: installation.id,
          userId: ctx.user.id,
          desktopArguments: ["--with-list"],
        });

        expect(updated.changed).toBe(true);
        expect(updated.mcpServer).toMatchObject({
          desktopArguments: ["--with-list"],
          localInstallationStatus: "success",
        });
        expect(await storedState(device, catalogItem.id)).toBe("running");
        expect(asked).not.toContain("tools/list");
      } finally {
        await tunnelClient.stop();
      }
    }

    test("a device whose program is from before the arguments starts nothing again: they are stored and the installation stays complete", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      await expectStoredAndNothingElse(
        { makeInternalMcpCatalog, makeMember },
        "0.1.0",
      );
    });

    test("so does a device that reported no version of its program", async ({
      makeInternalMcpCatalog,
      makeMember,
    }) => {
      await expectStoredAndNothingElse(
        { makeInternalMcpCatalog, makeMember },
        undefined,
      );
    });
  });
});
