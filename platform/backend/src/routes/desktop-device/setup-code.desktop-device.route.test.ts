import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import DesktopDeviceModel from "@/models/desktop-device";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { User } from "@/types";
import { buildDesktopDeviceTestApp } from "./desktop-device.test-helpers";

describe("setup codes: the setup dialog approves the sign-in of its command", () => {
  setupTestCacheManager();
  let app: FastifyInstanceWithZod;
  let otherApp: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId);
    app = await buildDesktopDeviceTestApp({ user, organizationId });
    const other = await makeUser();
    await makeMember(other.id, organizationId);
    otherApp = await buildDesktopDeviceTestApp({ user: other, organizationId });
  });
  afterEach(async () => {
    await app.close();
    await otherApp.close();
  });

  async function setupCode(on = app) {
    const response = await on.inject({
      method: "POST",
      url: "/api/desktop-devices/setup-codes",
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ setupCode: string; expiresAt: string }>().setupCode;
  }

  async function start(params: { setupCode?: string; deviceName?: string }) {
    const response = await app.inject({
      method: "POST",
      url: "/api/desktop-devices/sign-in",
      payload: {
        deviceName: params.deviceName ?? "MBP-0142",
        platform: "macos",
        ...(params.setupCode ? { setupCode: params.setupCode } : {}),
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{
      id: string;
      deviceCode: string;
      userCode: string;
      approveInArchestra: boolean;
    }>();
  }

  async function pending(code: string, on = app) {
    const response = await on.inject({
      url: `/api/desktop-devices/setup-codes/${code}/sign-in`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{
      id: string;
      deviceName: string;
      userCode: string;
    } | null>();
  }

  test("the dialog finds the sign-in of its command and approves it in place", async () => {
    const code = await setupCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // Before the command runs, there is nothing to approve.
    expect(await pending(code)).toBeNull();

    const signIn = await start({ setupCode: code });
    expect(signIn.approveInArchestra).toBe(true);

    const request = await pending(code);
    expect(request).toEqual({
      id: signIn.id,
      deviceName: "MBP-0142",
      platform: "macos",
      userCode: signIn.userCode,
      expiresAt: expect.any(String),
    });
    // Never the secret of the device.
    expect(JSON.stringify(request)).not.toContain(signIn.deviceCode);

    const approved = await app.inject({
      method: "POST",
      url: `/api/desktop-devices/sign-in/${signIn.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(await DesktopDeviceModel.findByUserId(user.id)).toMatchObject({
      name: "MBP-0142",
    });
    // Answered: the dialog has nothing more to show.
    expect(await pending(code)).toBeNull();
  });

  test("only the user who got the code sees the sign-in", async () => {
    const code = await setupCode();
    await start({ setupCode: code });

    expect(await pending(code, otherApp)).toBeNull();
    expect(await pending(code)).not.toBeNull();
  });

  test("running the command again shows the newer sign-in", async () => {
    const code = await setupCode();
    await start({ setupCode: code, deviceName: "first" });
    const second = await start({ setupCode: code, deviceName: "second" });

    expect(await pending(code)).toMatchObject({
      id: second.id,
      deviceName: "second",
    });
  });

  test("a command with an unknown code, or none, gets the approval page", async () => {
    expect((await start({})).approveInArchestra).toBe(false);
    const unknown = "A".repeat(22);
    expect((await start({ setupCode: unknown })).approveInArchestra).toBe(
      false,
    );
    expect(await pending(unknown)).toBeNull();
  });

  test("a code that is not 22 base64url characters is refused", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/desktop-devices/sign-in",
      payload: {
        deviceName: "MBP-0142",
        platform: "macos",
        setupCode: "not a code",
      },
    });
    expect(response.statusCode).toBe(400);
  });

  test("getting a setup code writes no audit record", async () => {
    await setupCode();
    // The audit hook writes in the background after the response.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await vi.waitFor(async () => {
      const rows = await db.select().from(schema.auditLogsTable);
      expect(
        rows.filter((row) => row.httpPath?.includes("setup-codes")),
      ).toHaveLength(0);
    });
  });
});
