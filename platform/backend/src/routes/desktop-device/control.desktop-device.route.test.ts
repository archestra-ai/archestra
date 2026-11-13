import type { FastifyInstanceWithZod } from "@/fastify-instance";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  connectTestDevice,
  runTestTunnelClient,
  type TestDevice,
  waitUntilOnline,
} from "@/test/desktop-mcp";
import type { User } from "@/types";
import { buildDesktopDeviceTestApp } from "./desktop-device.test-helpers";

/**
 * The actions of the Devices page that the tunnel client carries out: they go
 * through the queue to a stand-in tunnel client and come back.
 */
describe("actions on one MCP server of a device", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let device: TestDevice;
  let catalogId: string;
  let client: { stop: () => Promise<void> } | null;

  beforeEach(
    async ({
      makeUser,
      makeOrganization,
      makeMember,
      makeInternalMcpCatalog,
      makeMcpServer,
    }) => {
      user = await makeUser();
      organizationId = (await makeOrganization()).id;
      await makeMember(user.id, organizationId);
      app = await buildDesktopDeviceTestApp({ user, organizationId });
      await app.register(desktopTunnelRoutes);
      device = await connectTestDevice({
        organizationId,
        userId: user.id,
        name: "MBP-0142",
      });
      catalogId = (
        await makeInternalMcpCatalog({
          organizationId,
          name: "MATLAB",
          serverType: "desktop_mcp",
          desktopConfig: { command: "/opt/matlab/mcp" },
        })
      ).id;
      // The user installed it: only an installed item runs on the device.
      await makeMcpServer({
        catalogId,
        serverType: "desktop_mcp",
        scope: "personal",
        ownerId: user.id,
        localInstallationStatus: "success",
      });
      client = null;
    },
  );
  afterEach(async () => {
    await client?.stop();
    await app.close();
  });

  /** Starts the stand-in tunnel client and records what it is asked. */
  async function tunnelClient(
    answer: (message: { method: string; params?: unknown }) => unknown,
  ) {
    const asked: Array<{ channel: string; method: string; params?: unknown }> =
      [];
    client = runTestTunnelClient({
      app,
      device,
      readyChannels: [catalogId],
      answer: (message) => {
        asked.push(message);
        return answer(message);
      },
    });
    await waitUntilOnline(device.device.id);
    return asked;
  }

  const serverUrl = () =>
    `/api/desktop-devices/${device.device.id}/servers/${catalogId}`;

  test("POST …/restart asks the tunnel client to restart that MCP server", async () => {
    const asked = await tunnelClient(() => ({}));

    const response = await app.inject({
      method: "POST",
      url: `${serverUrl()}/restart`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(asked).toEqual([
      {
        channel: DESKTOP_BRIDGE_CHANNEL,
        method: "bridge/server/restart",
        params: { channel: catalogId },
      },
    ]);
  });

  test("POST …/restart gives the error of the tunnel client", async () => {
    await tunnelClient(() => {
      throw new Error("This MCP server has no command.");
    });

    const response = await app.inject({
      method: "POST",
      url: `${serverUrl()}/restart`,
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().error.message).toBe(
      "This MCP server has no command.",
    );
  });

  test("POST …/test counts the tools of the MCP server over every page, and stores nothing", async () => {
    const asked = await tunnelClient(({ params }) =>
      (params as { cursor?: string }).cursor
        ? { tools: [{ name: "c" }] }
        : { tools: [{ name: "a" }, { name: "b" }], nextCursor: "page-2" },
    );

    const response = await app.inject({
      method: "POST",
      url: `${serverUrl()}/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ toolCount: 3 });
    expect(response.json().durationMs).toBeGreaterThanOrEqual(0);
    // The request goes to the MCP server itself, on the channel of its
    // catalog item.
    expect(asked).toEqual([
      { channel: catalogId, method: "tools/list", params: {} },
      {
        channel: catalogId,
        method: "tools/list",
        params: { cursor: "page-2" },
      },
    ]);
    expect(
      await DesktopDeviceServerModel.findByDeviceId(device.device.id),
    ).toEqual([]);
  });

  test("GET …/log gives the lines the tunnel client kept", async () => {
    const asked = await tunnelClient(() => ({
      lines: ["starting", "listening on stdio"],
    }));

    const response = await app.inject({ url: `${serverUrl()}/log` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      lines: ["starting", "listening on stdio"],
    });
    expect(asked).toEqual([
      {
        channel: DESKTOP_BRIDGE_CHANNEL,
        method: "bridge/server/log",
        params: { channel: catalogId },
      },
    ]);
  });

  test("a device that does not poll gets an error that names it, and nothing waits in its queue", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${serverUrl()}/restart`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe(
      'Device "MBP-0142" is offline. Start the MCP bridge on that device and try again.',
    );
  });

  test("answers 404 for another user's device and for a catalog item that is not on the device", async ({
    makeUser,
    makeInternalMcpCatalog,
  }) => {
    const other = await connectTestDevice({
      organizationId,
      userId: (await makeUser()).id,
    });
    const remote = await makeInternalMcpCatalog({
      organizationId,
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
    });

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/desktop-devices/${other.device.id}/servers/${catalogId}/restart`,
      }),
      app.inject({
        method: "POST",
        url: `/api/desktop-devices/${device.device.id}/servers/${remote.id}/test`,
      }),
      app.inject({
        url: `/api/desktop-devices/${other.device.id}/servers/${catalogId}/log`,
      }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      404, 404, 404,
    ]);
  });
});
