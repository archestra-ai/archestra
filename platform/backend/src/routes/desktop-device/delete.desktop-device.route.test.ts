import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import DesktopDeviceModel from "@/models/desktop-device";
import { desktopTunnelService } from "@/services/desktop-mcp/desktop-tunnel";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { connectTestDevice } from "@/test/desktop-mcp";
import type { User } from "@/types";
import { buildDesktopDeviceTestApp } from "./desktop-device.test-helpers";

describe("DELETE /api/desktop-devices/:id", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId);
    app = await buildDesktopDeviceTestApp({ user, organizationId });
  });
  afterEach(async () => {
    await app.close();
  });

  test("removes the user's device, so its key stops working", async () => {
    const { device, deviceKey, tunnelId } = await connectTestDevice({
      organizationId,
      userId: user.id,
      name: "MBP-0142",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/desktop-devices/${device.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(await DesktopDeviceModel.findById(device.id)).toBeNull();
    await expect(
      desktopTunnelService.authenticate({ tunnelId, deviceKey }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.resourceId, device.id),
            eq(schema.auditLogsTable.outcome, "success"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "desktopDevice.deleted",
        before: { id: device.id, name: "MBP-0142", userId: user.id },
      });
      expect(JSON.stringify(rows)).not.toContain(deviceKey);
    });
  });

  test("does not remove another user's device", async ({ makeUser }) => {
    const other = await connectTestDevice({
      organizationId,
      userId: (await makeUser()).id,
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/desktop-devices/${other.device.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(await DesktopDeviceModel.findById(other.device.id)).not.toBeNull();
  });
});
