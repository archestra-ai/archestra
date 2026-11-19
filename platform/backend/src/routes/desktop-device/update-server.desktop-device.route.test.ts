import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import DesktopMcpRequestModel from "@/models/desktop-mcp-request";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { connectTestDevice, type TestDevice } from "@/test/desktop-mcp";
import type { User } from "@/types";
import { buildDesktopDeviceTestApp } from "./desktop-device.test-helpers";

describe("PUT /api/desktop-devices/:id/servers/:catalogId", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let device: TestDevice;
  let catalogId: string;

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
      device = await connectTestDevice({ organizationId, userId: user.id });
      catalogId = (
        await makeInternalMcpCatalog({
          organizationId,
          name: "MATLAB",
          serverType: "desktop_mcp",
          desktopConfig: { command: "/Users/$USER/bins/matlab-mcp-server" },
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
    },
  );
  afterEach(async () => {
    await app.close();
  });

  function update(
    payload: object,
    ids?: { device?: string; catalog?: string },
  ) {
    return app.inject({
      method: "PUT",
      url: `/api/desktop-devices/${ids?.device ?? device.device.id}/servers/${ids?.catalog ?? catalogId}`,
      payload,
    });
  }

  function serverOf(response: { json: () => { servers: unknown[] } }) {
    return response.json().servers[0];
  }

  test("Stop is stored and Start starts it again; the command stays the catalog item's", async () => {
    const stopped = await update({ enabled: false });
    const started = await update({ enabled: true });

    expect(stopped.statusCode).toBe(200);
    expect(serverOf(stopped)).toMatchObject({
      catalogId,
      enabled: false,
      state: "stopped",
      command: "/Users/$USER/bins/matlab-mcp-server",
    });
    expect(serverOf(started)).toMatchObject({ enabled: true });
  });

  test("tells the tunnel client of the device to get its config again", async () => {
    await update({ enabled: false });

    const [queued] = await DesktopMcpRequestModel.claimPending({
      deviceId: device.device.id,
      limit: 10,
    });
    expect(queued).toMatchObject({
      channel: DESKTOP_BRIDGE_CHANNEL,
      payload: { jsonrpc: "2.0", method: "bridge/sync" },
    });
  });

  test("rejects a body with no Start or Stop", async () => {
    const response = await update({ command: "/opt/matlab/mcp" });

    expect(response.statusCode).toBe(400);
    expect(
      await DesktopDeviceServerModel.findByDeviceId(device.device.id),
    ).toEqual([]);
  });

  test("answers 404 for another user's device and for a catalog item that is not an MCP server of the device", async ({
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
    const otherOrganization = await makeInternalMcpCatalog({
      serverType: "desktop_mcp",
    });

    const responses = await Promise.all([
      update({ enabled: false }, { device: other.device.id }),
      update({ enabled: false }, { catalog: remote.id }),
      update({ enabled: false }, { catalog: otherOrganization.id }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([
      404, 404, 404,
    ]);
    expect(
      await DesktopDeviceServerModel.findByDeviceId(other.device.id),
    ).toEqual([]);
  });

  test("the audit record holds Stop before and after", async () => {
    await update({ enabled: false });

    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.resourceId, device.device.id),
            eq(schema.auditLogsTable.outcome, "success"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "desktopDevice.updated",
        before: { id: device.device.id, servers: [] },
        after: {
          servers: [{ catalogId, enabled: false }],
        },
      });
      expect(JSON.stringify(rows)).not.toContain(device.deviceKey);
    });
  });
});
