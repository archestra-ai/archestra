import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import McpServerModel from "@/models/mcp-server";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { connectTestDevice, type TestDevice } from "@/test/desktop-mcp";
import type { User } from "@/types";

/**
 * Install, uninstall and restore of a desktop MCP catalog item through the MCP
 * server routes. An installation is one entry in the config of the owner's
 * tunnel client, so each change tells the owner's device to sync.
 */
describe("desktop MCP installations", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let catalogId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
    }) => {
      vi.spyOn(betterAuth.api, "getSession").mockImplementation(
        async () => ({ user: { id: user.id } }) as never,
      );
      user = await makeUser();
      organizationId = (await makeOrganization()).id;
      await makeMember(user.id, organizationId, { role: "member" });
      catalogId = (
        await makeInternalMcpCatalog({
          organizationId,
          name: "MATLAB",
          serverType: "desktop_mcp",
          desktopConfig: { command: "/opt/matlab/mcp" },
        })
      ).id;

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        Object.assign(request, { user, organizationId });
      });
      const { default: mcpServerRoutes } = await import("./mcp-server");
      await app.register(mcpServerRoutes);
      await app.register(desktopTunnelRoutes);
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function install(payload: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/mcp_server",
      // `name` is overwritten from the catalog row; the schema still requires it.
      payload: { name: "install", catalogId, ...payload },
    });
  }

  function connect(userId = user.id) {
    return connectTestDevice({ organizationId, userId });
  }

  /** What the device takes from its queue for the tunnel client itself. */
  async function bridgeMethods(device: TestDevice): Promise<string[]> {
    const poll = await app.inject({
      url: `/v1/tunnels/${device.tunnelId}/poll?timeout_ms=0`,
      headers: device.headers,
    });
    if (poll.statusCode === 204) return [];
    return poll
      .json<{
        commands: Array<{ channel: string; jsonrpc: { method: string } }>;
      }>()
      .commands.filter((command) => command.channel === DESKTOP_BRIDGE_CHANNEL)
      .map((command) => command.jsonrpc.method);
  }

  /** The entries the tunnel client gets at its next sync. */
  async function syncedConfig(device: TestDevice) {
    const response = await app.inject({
      url: `/v1/tunnels/${device.tunnelId}`,
      headers: device.headers,
    });
    return response.json<{
      catalog_items: Array<{ id: string; enabled: boolean }>;
    }>().catalog_items;
  }

  test("Install creates a waiting personal installation and tells the user's device to sync", async () => {
    const device = await connect();

    const response = await install();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      catalogId,
      name: "MATLAB",
      serverType: "desktop_mcp",
      scope: "personal",
      ownerId: user.id,
      localInstallationStatus: "pending",
    });
    expect(await bridgeMethods(device)).toEqual(["bridge/sync"]);
    expect(await syncedConfig(device)).toEqual([
      expect.objectContaining({ id: catalogId, enabled: true }),
    ]);
  });

  test("Install works for a user with no device; a device connected later gets the entry", async () => {
    const response = await install();

    expect(response.statusCode).toBe(200);
    expect(response.json().localInstallationStatus).toBe("pending");
    const device = await connect();
    expect(await syncedConfig(device)).toEqual([
      expect.objectContaining({ id: catalogId }),
    ]);
  });

  test("a second Install returns the same installation and binds no agent of the request", async ({
    makeAgent,
    makeTool,
  }) => {
    // Another user's installation already stored the tool list.
    const tool = await makeTool({ name: "matlab__run", catalogId });
    const agent = await makeAgent({ organizationId });
    const first = await install();

    const second = await install({ agentIds: [agent.id] });

    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    expect(await McpServerModel.findByCatalogIds([catalogId])).toHaveLength(1);
    const agentTools = await db
      .select()
      .from(schema.agentToolsTable)
      .where(eq(schema.agentToolsTable.toolId, tool.id));
    expect(agentTools.map((row) => row.agentId)).not.toContain(agent.id);
  });

  test("Install after a Stop on the Devices tab starts the MCP server again", async () => {
    const device = await connect();
    const installation = (await install()).json();
    await DesktopDeviceServerModel.saveEnabled({
      deviceId: device.device.id,
      catalogId,
      enabled: false,
    });
    await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${installation.id}`,
    });

    const again = await install();

    expect(again.statusCode).toBe(200);
    expect(again.json().id).not.toBe(installation.id);
    expect(await syncedConfig(device)).toEqual([
      expect.objectContaining({ id: catalogId, enabled: true }),
    ]);
  });

  test("refuses a team or an organization installation", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, user.id);

    const forTeam = await install({ scope: "team", teamId: team.id });
    const forOrganization = await install({ scope: "org" });

    for (const response of [forTeam, forOrganization]) {
      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(
        /can only be installed as a personal installation/,
      );
    }
    expect(await McpServerModel.findByCatalogIds([catalogId])).toEqual([]);
  });

  test("refuses an installation for another user, also from an installation admin", async ({
    makeUser,
    makeMember,
  }) => {
    await db
      .update(schema.membersTable)
      .set({ role: "admin" })
      .where(eq(schema.membersTable.userId, user.id));
    const other = await makeUser();
    await makeMember(other.id, organizationId);

    const response = await install({ scope: "personal", userId: other.id });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(
      /each user installs it for themselves/,
    );
    expect(await McpServerModel.findByCatalogIds([catalogId])).toEqual([]);
  });

  test("refuses a catalog item with no command and no URL", async ({
    makeInternalMcpCatalog,
  }) => {
    const empty = await makeInternalMcpCatalog({
      organizationId,
      name: "Notes",
      serverType: "desktop_mcp",
    });

    const response = await install({ catalogId: empty.id });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/no command and no URL/);
    expect(await McpServerModel.findByCatalogIds([empty.id])).toEqual([]);
  });

  test("Uninstall removes the entry and tells the device to sync; Restore brings it back", async () => {
    const device = await connect();
    const installation = (await install()).json();
    await bridgeMethods(device);

    const uninstall = await app.inject({
      method: "DELETE",
      url: `/api/mcp_server/${installation.id}`,
    });

    expect(uninstall.statusCode).toBe(200);
    expect(await bridgeMethods(device)).toEqual(["bridge/sync"]);
    expect(await syncedConfig(device)).toEqual([]);

    const restore = await app.inject({
      method: "POST",
      url: `/api/mcp_server/${installation.id}/restore`,
    });

    expect(restore.statusCode).toBe(200);
    // Nothing to reinstall: the device starts the MCP server at its sync.
    expect(restore.json()).toMatchObject({
      id: installation.id,
      reinstallRequired: false,
    });
    expect(await bridgeMethods(device)).toEqual(["bridge/sync"]);
    expect(await syncedConfig(device)).toEqual([
      expect.objectContaining({ id: catalogId }),
    ]);
  });

  test("bulk Uninstall tells the device to sync", async () => {
    const device = await connect();
    const installation = (await install()).json();
    await bridgeMethods(device);

    const response = await app.inject({
      method: "DELETE",
      url: "/api/mcp_server/bulk",
      payload: { ids: [installation.id] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      expect.objectContaining({ id: installation.id }),
    ]);
    expect(await bridgeMethods(device)).toEqual(["bridge/sync"]);
    expect(await syncedConfig(device)).toEqual([]);
  });
});
