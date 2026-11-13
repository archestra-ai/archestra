import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import { desktopTunnelService } from "@/services/desktop-mcp/desktop-tunnel";
import { describe, expect, test } from "@/test";
import { connectTestDevice } from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import desktopTunnelRoutes from "./desktop-tunnel.routes";

describe("DELETE /v1/tunnels/:tunnelId", () => {
  const ctx = useRouteTestApp(desktopTunnelRoutes);

  test("removes the device, so its key stops working", async () => {
    const { device, tunnelId, headers } = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tunnels/${tunnelId}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(await DesktopDeviceModel.findById(device.id)).toBeNull();
    const later = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}`,
      headers,
    });
    expect(later.statusCode).toBe(401);
  });

  test("writes the audit record of the removal, by the user who owns the device", async ({
    makeInternalMcpCatalog,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    // Not the user and the organization the test app puts on every request:
    // the record names the owner of the device key, read from the device.
    const owner = await makeUser();
    const organizationId = (await makeOrganization()).id;
    await makeMember(owner.id, organizationId);
    const { device, deviceKey, tunnelId, headers } = await connectTestDevice({
      organizationId,
      userId: owner.id,
      name: "MBP-0142",
    });
    const stopped = await makeInternalMcpCatalog({
      organizationId,
      serverType: "desktop_mcp",
    });
    await DesktopDeviceServerModel.saveEnabled({
      deviceId: device.id,
      catalogId: stopped.id,
      enabled: false,
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tunnels/${tunnelId}?reason=uninstall`,
      headers: { ...headers, "user-agent": "archestra/1.2.3" },
    });

    expect(response.statusCode).toBe(200);
    const records = await auditRecordsOf(device.id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      organizationId,
      actorId: owner.id,
      actorType: "user",
      actorName: owner.name,
      actorEmail: owner.email,
      action: "desktopDevice.deleted",
      outcome: "success",
      resourceType: "desktopDevice",
      resourceId: device.id,
      resourceName: "MBP-0142",
      before: {
        id: device.id,
        name: "MBP-0142",
        platform: "macos",
        userId: owner.id,
        servers: [{ catalogId: stopped.id, enabled: false }],
      },
      after: null,
      httpMethod: "DELETE",
      httpPath: `/v1/tunnels/${tunnelId}`,
      httpRoute: "/v1/tunnels/:tunnelId",
      httpStatus: 200,
      userAgent: "archestra/1.2.3",
    });
    expect(records[0].requestId).toEqual(expect.any(String));
    expect(records[0].sourceIp).toEqual(expect.any(String));
    const stored = JSON.stringify(records);
    expect(stored).not.toContain(deviceKey);
    expect(stored).not.toContain(desktopTunnelService.hashDeviceKey(deviceKey));
  });

  test("does not read a body larger than the tunnel client sends, and keeps the device", async () => {
    const { device, tunnelId, headers } = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tunnels/${tunnelId}`,
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify({ pad: "x".repeat(4096) }),
    });

    expect(response.statusCode).toBe(413);
    expect(await DesktopDeviceModel.findById(device.id)).not.toBeNull();
  });

  test("rejects a wrong device key and keeps the device", async ({
    makeUser,
  }) => {
    const mine = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const other = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: (await makeUser()).id,
    });

    const responses = await Promise.all(
      [
        // No key, a key no device has, and the key of another device.
        {},
        { authorization: "Bearer archestra_dev_not-the-key-of-a-device" },
        other.headers,
      ].map((headers) =>
        ctx.app.inject({
          method: "DELETE",
          url: `/v1/tunnels/${mine.tunnelId}`,
          headers,
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 401, 403,
    ]);
    expect(await DesktopDeviceModel.findById(mine.device.id)).not.toBeNull();
    expect(await DesktopDeviceModel.findById(other.device.id)).not.toBeNull();
    expect(await auditRecordsOf(mine.device.id)).toEqual([]);
  });

  test("leaves the device of another user as it is", async ({ makeUser }) => {
    const mine = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const other = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: (await makeUser()).id,
    });

    const response = await ctx.app.inject({
      method: "DELETE",
      url: `/v1/tunnels/${mine.tunnelId}`,
      headers: mine.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(await DesktopDeviceModel.findById(other.device.id)).not.toBeNull();
    const stillWorks = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${other.tunnelId}`,
      headers: other.headers,
    });
    expect(stillWorks.statusCode).toBe(200);
    expect(await auditRecordsOf(other.device.id)).toEqual([]);
  });
});

function auditRecordsOf(deviceId: string) {
  return db
    .select()
    .from(schema.auditLogsTable)
    .where(eq(schema.auditLogsTable.resourceId, deviceId));
}
