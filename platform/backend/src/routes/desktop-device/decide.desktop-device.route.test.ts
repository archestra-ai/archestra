import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import DesktopDeviceModel from "@/models/desktop-device";
import {
  DESKTOP_DEVICE_KEY_PREFIX,
  desktopTunnelService,
} from "@/services/desktop-mcp/desktop-tunnel";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { User } from "@/types";
import { buildDesktopDeviceTestApp } from "./desktop-device.test-helpers";

describe("POST /api/desktop-devices/sign-in/:id/decision", () => {
  setupTestCacheManager();
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

  async function start(
    deviceName = "MBP-0142",
    platform: "macos" | "windows" | "linux" = "macos",
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/desktop-devices/sign-in",
      payload: { deviceName, platform },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{
      id: string;
      deviceCode: string;
      userCode: string;
      verificationPath: string;
    }>();
  }

  async function poll(deviceCode: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/desktop-devices/sign-in/poll",
      payload: { deviceCode },
    });
    return response.json<{ status: string; tunnelId?: string }>();
  }

  function decide(id: string, decision: "approve" | "deny") {
    return app.inject({
      method: "POST",
      url: `/api/desktop-devices/sign-in/${id}/decision`,
      payload: { decision },
    });
  }

  test("a Windows or Linux computer signs in with the platform that the tunnel client sends", async () => {
    // The tunnel client sends Rust's std::env::consts::OS.
    for (const [deviceName, platform] of [
      ["LAB-PC-07", "windows"],
      ["build-box", "linux"],
    ] as const) {
      const signIn = await start(deviceName, platform);
      const details = await app.inject({
        url: `/api/desktop-devices/sign-in/${signIn.id}`,
      });
      expect(details.json()).toMatchObject({ deviceName, platform });

      expect((await decide(signIn.id, "approve")).statusCode).toBe(200);
      expect(await DesktopDeviceModel.findByUserId(user.id)).toMatchObject({
        name: deviceName,
        platform,
      });
    }
  });

  test("an approved sign-in registers the device and gives the tunnel client a working key", async () => {
    const signIn = await start();
    expect(signIn.verificationPath).toBe(
      `/devices/approve?request=${signIn.id}`,
    );
    expect(await poll(signIn.deviceCode)).toEqual({ status: "pending" });

    // The approval page shows the code and the computer, never the secret.
    const details = await app.inject({
      url: `/api/desktop-devices/sign-in/${signIn.id}`,
    });
    expect(details.json()).toMatchObject({
      deviceName: "MBP-0142",
      platform: "macos",
      userCode: signIn.userCode,
    });
    expect(details.body).not.toContain(signIn.deviceCode);

    const approved = await decide(signIn.id, "approve");

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toEqual({ status: "approved" });
    const device = await DesktopDeviceModel.findByUserId(user.id);
    expect(device).toMatchObject({ name: "MBP-0142", organizationId });
    const tunnelId = desktopTunnelService.tunnelIdForDevice(device?.id ?? "");
    expect(await poll(signIn.deviceCode)).toEqual({
      status: "approved",
      tunnelId,
    });
    // The tunnel client derives its key from the device code it already has.
    await expect(
      desktopTunnelService.authenticate({
        tunnelId,
        deviceKey: `${DESKTOP_DEVICE_KEY_PREFIX}${signIn.deviceCode}`,
      }),
    ).resolves.toMatchObject({ id: device?.id });
    // An answered request cannot be answered again.
    expect((await decide(signIn.id, "approve")).statusCode).toBe(410);

    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.resourceId, signIn.id),
            eq(schema.auditLogsTable.outcome, "success"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "desktopDeviceSignIn.updated",
        before: { status: "pending" },
        after: { status: "approved", deviceName: "MBP-0142" },
      });
      expect(JSON.stringify(rows)).not.toContain(signIn.deviceCode);
    });
  });

  test("a denied sign-in registers nothing", async () => {
    const signIn = await start();

    const denied = await decide(signIn.id, "deny");

    expect(denied.json()).toEqual({ status: "denied" });
    expect(await poll(signIn.deviceCode)).toEqual({ status: "denied" });
    expect(await DesktopDeviceModel.findByUserId(user.id)).toBeNull();
  });

  test("a second approved sign-in replaces the user's first device", async () => {
    const first = await start("Old laptop");
    await decide(first.id, "approve");
    const firstDevice = await DesktopDeviceModel.findByUserId(user.id);
    const second = await start("New laptop");

    await decide(second.id, "approve");

    const device = await DesktopDeviceModel.findByUserId(user.id);
    expect(device?.name).toBe("New laptop");
    await expect(
      desktopTunnelService.authenticate({
        tunnelId: desktopTunnelService.tunnelIdForDevice(firstDevice?.id ?? ""),
        deviceKey: `${DESKTOP_DEVICE_KEY_PREFIX}${first.deviceCode}`,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("an unknown device code is expired, and an unknown request is gone", async () => {
    const unknownCode = "A".repeat(43);
    const unknownRequest = "a".repeat(48);

    expect(await poll(unknownCode)).toEqual({ status: "expired" });
    expect((await decide(unknownRequest, "approve")).statusCode).toBe(410);
    expect(
      (
        await app.inject({
          url: `/api/desktop-devices/sign-in/${unknownRequest}`,
        })
      ).statusCode,
    ).toBe(410);
  });
});
