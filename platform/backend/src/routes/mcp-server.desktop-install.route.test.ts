import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import McpServerModel from "@/models/mcp-server";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { connectTestDevice, type TestDevice } from "@/test/desktop-mcp";
import type { User } from "@/types";

/**
 * Install, uninstall and restore of a desktop MCP catalog item through the MCP
 * server routes. An installation is one entry in the config of the owner's
 * tunnel client, so each change tells the owner's device to sync.
 */
describe("desktop MCP installations", () => {
  setupTestCacheManager();
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
      registerAuditLogHook(app);
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
      catalog_items: Array<{
        id: string;
        enabled: boolean;
        command: string | null;
        arguments: string[];
      }>;
    }>().catalog_items;
  }

  function setArguments(id: string, desktopArguments: unknown) {
    return app.inject({
      method: "PUT",
      url: `/api/mcp_server/${id}/desktop-arguments`,
      payload: { desktopArguments },
    });
  }

  async function stored(id: string) {
    const [row] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));
    return row;
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

  describe("the arguments a user adds to the command", () => {
    test("Install stores them, and the device gets them next to the command, not joined into it", async () => {
      const device = await connect();

      const response = await install({
        desktopArguments: ["--root", "$HOME/My Models", "--verbose"],
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().desktopArguments).toEqual([
        "--root",
        "$HOME/My Models",
        "--verbose",
      ]);
      expect(await syncedConfig(device)).toEqual([
        {
          id: catalogId,
          name: "MATLAB",
          command: "/opt/matlab/mcp",
          arguments: ["--root", "$HOME/My Models", "--verbose"],
          url: null,
          enabled: true,
        },
      ]);
    });

    test("Install with none stores none, and the device gets an empty list", async () => {
      const device = await connect();

      const none = await install();
      expect(none.json().desktopArguments).toBeNull();
      expect((await syncedConfig(device))[0].arguments).toEqual([]);

      // An empty list is no arguments too.
      await app.inject({
        method: "DELETE",
        url: `/api/mcp_server/${none.json().id}`,
      });
      const empty = await install({ desktopArguments: [] });
      expect(empty.statusCode).toBe(200);
      expect(empty.json().desktopArguments).toBeNull();
    });

    test("a second Install with other arguments changes them; one with none given keeps them", async () => {
      const first = await install({ desktopArguments: ["--verbose"] });

      const kept = await install();
      expect(kept.json()).toMatchObject({
        id: first.json().id,
        desktopArguments: ["--verbose"],
      });

      const changed = await install({ desktopArguments: ["--quiet"] });
      expect(changed.json()).toMatchObject({
        id: first.json().id,
        desktopArguments: ["--quiet"],
      });
    });

    test("refuses arguments that are not one argument each, and too many of them", async () => {
      for (const desktopArguments of [
        [""],
        ["two\nlines"],
        ["carriage\rreturn"],
        ["nul\u0000byte"],
        ["a".repeat(4097)],
        Array.from({ length: 65 }, (_, index) => `--flag-${index}`),
        Array.from({ length: 5 }, () => "a".repeat(4000)),
        "--verbose",
        [1],
      ]) {
        const response = await install({ desktopArguments });
        expect(response.statusCode, JSON.stringify(desktopArguments)).toBe(400);
      }
      expect(await McpServerModel.findByCatalogIds([catalogId])).toEqual([]);
    });

    test("refuses arguments for a catalog item that is stored with a URL, and for a server of another type", async ({
      makeInternalMcpCatalog,
    }) => {
      const withUrl = await makeInternalMcpCatalog({
        organizationId,
        name: "Notes",
        serverType: "desktop_mcp",
        desktopConfig: { url: "http://127.0.0.1:8080/mcp" },
      });
      const remote = await makeInternalMcpCatalog({
        organizationId,
        name: "Remote",
        serverType: "remote",
        serverUrl: "https://mcp.example.com/mcp",
      });

      const forUrl = await install({
        catalogId: withUrl.id,
        desktopArguments: ["--verbose"],
      });
      const forRemote = await install({
        catalogId: remote.id,
        desktopArguments: ["--verbose"],
      });

      expect(forUrl.statusCode).toBe(400);
      expect(forUrl.json().error.message).toMatch(/has no command/);
      expect(forRemote.statusCode).toBe(400);
      expect(forRemote.json().error.message).toMatch(
        /Only a desktop MCP server takes arguments/,
      );
      expect(
        await McpServerModel.findByCatalogIds([withUrl.id, remote.id]),
      ).toEqual([]);
    });

    test("the owner changes them later: the installation waits again and the device is told to sync", async () => {
      const device = await connect();
      const installation = (
        await install({ desktopArguments: ["--a"] })
      ).json();
      await McpServerModel.update(installation.id, {
        localInstallationStatus: "success",
      });
      await DesktopDeviceServerModel.recordStates({
        deviceId: device.device.id,
        states: [{ catalogId, state: "running", lastError: null }],
      });
      await bridgeMethods(device);

      const response = await setArguments(installation.id, [
        "--b",
        "two words",
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: installation.id,
        desktopArguments: ["--b", "two words"],
        localInstallationStatus: "pending",
      });
      expect(await bridgeMethods(device)).toEqual(["bridge/sync"]);
      expect((await syncedConfig(device))[0].arguments).toEqual([
        "--b",
        "two words",
      ]);
      // The state the device reported was of the MCP server it stops now.
      expect(
        await DesktopDeviceServerModel.findByDeviceId(device.device.id),
      ).toEqual([expect.objectContaining({ catalogId, state: null })]);
    });

    test("the owner removes them with null or an empty list", async () => {
      const installation = (
        await install({ desktopArguments: ["--a"] })
      ).json();

      const emptied = await setArguments(installation.id, []);
      expect(emptied.statusCode).toBe(200);
      expect(emptied.json().desktopArguments).toBeNull();

      await setArguments(installation.id, ["--a"]);
      const cleared = await setArguments(installation.id, null);
      expect(cleared.statusCode).toBe(200);
      expect((await stored(installation.id)).desktopArguments).toBeNull();
    });

    test("the same arguments change nothing: the installation stays complete and the device is not told to sync", async () => {
      const device = await connect();
      const installation = (
        await install({ desktopArguments: ["--a"] })
      ).json();
      await McpServerModel.update(installation.id, {
        localInstallationStatus: "success",
      });
      await bridgeMethods(device);

      const response = await setArguments(installation.id, ["--a"]);

      expect(response.statusCode).toBe(200);
      expect(response.json().localInstallationStatus).toBe("success");
      expect(await bridgeMethods(device)).toEqual([]);
    });

    test("works with no device: a device linked later gets the arguments", async () => {
      const installation = (await install()).json();

      const response = await setArguments(installation.id, ["--verbose"]);

      expect(response.statusCode).toBe(200);
      const device = await connect();
      expect((await syncedConfig(device))[0].arguments).toEqual(["--verbose"]);
    });

    test("nobody changes the arguments of another user's installation, also not an installation admin", async ({
      makeUser,
      makeMember,
    }) => {
      const installation = (
        await install({ desktopArguments: ["--a"] })
      ).json();
      const admin = await makeUser();
      await makeMember(admin.id, organizationId, { role: "admin" });
      user = admin;

      const response = await setArguments(installation.id, ["--evil"]);

      expect(response.statusCode).toBe(404);
      expect((await stored(installation.id)).desktopArguments).toEqual(["--a"]);
    });

    test("refuses an installation of another server type, and one that does not exist", async ({
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      const remote = await makeInternalMcpCatalog({
        organizationId,
        name: "Remote",
        serverType: "remote",
        serverUrl: "https://mcp.example.com/mcp",
      });
      const remoteInstallation = await makeMcpServer({
        catalogId: remote.id,
        serverType: "remote",
        scope: "personal",
        ownerId: user.id,
      });

      const forRemote = await setArguments(remoteInstallation.id, ["--a"]);
      const missing = await setArguments(crypto.randomUUID(), ["--a"]);

      expect(forRemote.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect((await stored(remoteInstallation.id)).desktopArguments).toBeNull();
    });

    test("refuses arguments for an installation of a catalog item that is stored with a URL", async ({
      makeInternalMcpCatalog,
    }) => {
      const withUrl = await makeInternalMcpCatalog({
        organizationId,
        name: "Notes",
        serverType: "desktop_mcp",
        desktopConfig: { url: "http://127.0.0.1:8080/mcp" },
      });
      const installation = (await install({ catalogId: withUrl.id })).json();

      const response = await setArguments(installation.id, ["--verbose"]);

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toMatch(/has no command/);
      expect((await stored(installation.id)).desktopArguments).toBeNull();
    });

    test("refuses arguments that are not valid", async () => {
      const installation = (
        await install({ desktopArguments: ["--a"] })
      ).json();

      for (const desktopArguments of [[""], ["two\nlines"], "--verbose"]) {
        const response = await setArguments(installation.id, desktopArguments);
        expect(response.statusCode, JSON.stringify(desktopArguments)).toBe(400);
      }
      expect((await stored(installation.id)).desktopArguments).toEqual(["--a"]);
    });

    test("the audit record shows that the arguments changed, and does not hold them", async () => {
      const installation = (
        await install({ desktopArguments: ["--token", "secret-of-the-user"] })
      ).json();

      await setArguments(installation.id, ["--token", "another-secret"]);
      // The stored arguments again: nothing is updated, no record.
      await setArguments(installation.id, ["--token", "another-secret"]);
      await setArguments(installation.id, []);

      const hash = (values: string[]) =>
        createHash("sha256").update(JSON.stringify(values)).digest("hex");
      await vi.waitFor(async () => {
        const rows = await db
          .select()
          .from(schema.auditLogsTable)
          .where(
            and(
              eq(schema.auditLogsTable.resourceId, installation.id),
              eq(schema.auditLogsTable.action, "mcpServer.updated"),
            ),
          )
          .orderBy(schema.auditLogsTable.occurredAt);
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({
          outcome: "success",
          resourceType: "mcpServer",
          before: {
            id: installation.id,
            desktopArgumentCount: 2,
            desktopArgumentsHash: hash(["--token", "secret-of-the-user"]),
          },
          after: {
            id: installation.id,
            desktopArgumentCount: 2,
            desktopArgumentsHash: hash(["--token", "another-secret"]),
          },
        });
        expect(rows[1]).toMatchObject({
          after: { desktopArgumentCount: 0, desktopArgumentsHash: null },
        });
        expect(JSON.stringify(rows)).not.toContain("secret");
      });
    });
  });
});
