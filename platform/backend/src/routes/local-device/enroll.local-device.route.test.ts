import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import LocalDeviceModel from "@/models/local-device";
import OrganizationModel from "@/models/organization";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import localDeviceRoutes from "./local-device.routes";

/** Real persistence and authorization: enrollment never depends on a catalog entry. */
describe("personal local device enrollment", () => {
  const ctx = useRouteTestApp(localDeviceRoutes);
  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
  });
  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: Record<string, unknown>,
    token?: string,
  ) =>
    ctx.app.inject({
      method,
      url: `/api/local-devices${path}`,
      payload,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
  async function enroll(name = "My Mac") {
    const response = await request("POST", "/enroll", { name });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; code: string; expiresAt: string }>();
  }
  async function redeem(code: string) {
    const response = await request("POST", "/redeem", {
      code,
      platform: "darwin",
      arch: "arm64",
      appVersion: "1.5.0-rc.19",
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      deviceId: string;
      token: string;
      expiresAt: string;
    }>();
  }
  async function session(token: string) {
    const response = await request("POST", "/session", {}, token);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ sessionId: string }>();
  }
  test("connects multiple computers, reports presence and renames without replacing another device", async () => {
    const first = await enroll();
    const second = await enroll("My Windows computer");
    expect(second.id).not.toBe(first.id);
    const inspection = await request("POST", "/inspect", { code: first.code });
    expect(inspection.json()).toMatchObject({
      deviceId: first.id,
      name: "My Mac",
      capabilities: ["local_mcp"],
    });
    const credential = await redeem(first.code);
    const opened = await session(credential.token);
    const heartbeat = await request(
      "POST",
      "/heartbeat",
      opened,
      credential.token,
    );
    expect(heartbeat.json()).toEqual({ success: true, name: "My Mac" });
    const renamed = await request("PATCH", `/${first.id}`, {
      name: "Work Mac",
    });
    expect(renamed.json()).toMatchObject({
      name: "Work Mac",
      platform: "darwin",
      arch: "arm64",
      status: "online",
    });
    const list = (await request("GET", "")).json();
    expect(list).toHaveLength(2);
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, status: "online" }),
        expect.objectContaining({ id: second.id, status: "pending" }),
      ]),
    );
    expect(JSON.stringify(list)).not.toContain(credential.token);
    expect(JSON.stringify(list)).not.toContain(first.code);
    expect(JSON.stringify(list)).not.toContain("Hash");
    const [stored] = await db
      .select()
      .from(schema.localDevicesTable)
      .where(eq(schema.localDevicesTable.id, first.id));
    expect(stored.tokenHash).toHaveLength(64);
    expect(stored.tokenHash).not.toBe(credential.token);
    expect(stored.pairingHash).toBeNull();
    const snapshot = await LocalDeviceModel.findByIdForAudit(
      first.id,
      ctx.organizationId,
    );
    expect(snapshot).toMatchObject({ id: first.id, name: "Work Mac" });
    expect(snapshot).not.toHaveProperty("pairingHash");
    expect(snapshot).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(snapshot)).not.toContain(credential.token);

    expect(
      (await request("POST", "/inspect", { code: first.code })).statusCode,
    ).toBe(401);
  });
  test("disconnects without revoking and prevents stale session heartbeats after reconnect", async () => {
    const credential = await redeem((await enroll()).code);
    const old = await session(credential.token);
    expect(
      (await request("POST", "/disconnect", old, credential.token)).statusCode,
    ).toBe(200);
    expect((await request("GET", "")).json()[0].status).toBe("offline");
    const fresh = await session(credential.token);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect(
      (await request("POST", "/heartbeat", old, credential.token)).statusCode,
    ).toBe(409);
    expect(
      (await request("POST", "/disconnect", old, credential.token)).statusCode,
    ).toBe(409);
    expect(
      (await request("POST", "/heartbeat", fresh, credential.token)).statusCode,
    ).toBe(200);
  });
  test("a browser session cannot stand in for a device token and malformed device proofs fail", async () => {
    const credential = await redeem((await enroll()).code);
    const opened = await session(credential.token);
    expect((await request("POST", "/heartbeat", opened)).statusCode).toBe(401);
    expect(
      (await request("POST", "/session", {}, "invalid-proof")).statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/redeem", { code: "invalid" })).statusCode,
    ).toBe(400);
  });
  test("isolates two human owners and two organizations even when the same person is in both", async ({
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    const originalUser = ctx.user;
    const originalOrganization = ctx.organizationId;
    const first = await enroll();
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, originalOrganization);
    expect((await request("GET", "")).json()).toEqual([]);
    expect(
      (await request("PATCH", `/${first.id}`, { name: "Stolen" })).statusCode,
    ).toBe(404);
    expect((await request("DELETE", `/${first.id}`)).statusCode).toBe(404);
    const own = await enroll("Second person's computer");
    expect(
      (await request("GET", "")).json().map((d: { id: string }) => d.id),
    ).toEqual([own.id]);
    const otherOrg = await makeOrganization();
    ctx.organizationId = otherOrg.id;
    ctx.user = originalUser;
    await makeMember(originalUser.id, otherOrg.id);
    await OrganizationModel.patch(otherOrg.id, { deviceMcpEnabled: true });
    expect((await request("GET", "")).json()).toEqual([]);
    expect(
      (await request("PATCH", `/${first.id}`, { name: "Foreign" })).statusCode,
    ).toBe(404);
    expect((await request("DELETE", `/${first.id}`)).statusCode).toBe(404);
  });
  test("revocation is idempotent and invalidates credentials, sessions and pending enrollment immediately", async () => {
    const pending = await enroll("Pending");
    const enrolled = await enroll();
    const credential = await redeem(enrolled.code);
    const opened = await session(credential.token);
    for (const id of [pending.id, enrolled.id]) {
      expect((await request("DELETE", `/${id}`)).statusCode).toBe(200);
      expect((await request("DELETE", `/${id}`)).statusCode).toBe(200);
    }
    expect(
      (await request("POST", "/heartbeat", opened, credential.token))
        .statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/session", {}, credential.token)).statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/inspect", { code: pending.code })).statusCode,
    ).toBe(401);
    expect((await request("GET", "")).json()).toEqual([]);
  });
  test("disabling the opt-in revokes all devices and enabling it cannot resurrect access", async () => {
    const pending = await enroll();
    const credential = await redeem((await enroll()).code);
    const opened = await session(credential.token);
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: false,
    });
    expect((await request("GET", "")).statusCode).toBe(403);
    expect(
      (await request("POST", "/enroll", { name: "Another" })).statusCode,
    ).toBe(403);
    expect(
      (await request("POST", "/heartbeat", opened, credential.token))
        .statusCode,
    ).toBe(401);
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    expect(
      (await request("POST", "/session", {}, credential.token)).statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/inspect", { code: pending.code })).statusCode,
    ).toBe(401);
    expect((await request("GET", "")).json()).toEqual([]);
  });
  test("membership loss and a banned owner invalidate active device proofs", async () => {
    const credential = await redeem((await enroll()).code);
    const opened = await session(credential.token);
    await db
      .update(schema.usersTable)
      .set({ banned: true })
      .where(eq(schema.usersTable.id, ctx.user.id));
    expect(
      (await request("POST", "/heartbeat", opened, credential.token))
        .statusCode,
    ).toBe(401);
    await db
      .update(schema.usersTable)
      .set({ banned: false })
      .where(eq(schema.usersTable.id, ctx.user.id));
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, ctx.user.id));
    expect(
      (await request("POST", "/session", {}, credential.token)).statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/enroll", { name: "Other" })).statusCode,
    ).toBe(403);
  });
  test("expired pairing is hidden and expired credentials cannot open a session", async () => {
    const pending = await enroll("Expired setup");
    const enrolled = await enroll("Expired credential");
    const credential = await redeem(enrolled.code);
    await db
      .update(schema.localDevicesTable)
      .set({ pairingExpiresAt: new Date(0) })
      .where(eq(schema.localDevicesTable.id, pending.id));
    await db
      .update(schema.localDevicesTable)
      .set({ tokenExpiresAt: new Date(0) })
      .where(eq(schema.localDevicesTable.id, enrolled.id));
    expect(
      (await request("POST", "/inspect", { code: pending.code })).statusCode,
    ).toBe(401);
    expect(
      (await request("POST", "/session", {}, credential.token)).statusCode,
    ).toBe(401);
    expect((await request("GET", "")).json()).toEqual([
      expect.objectContaining({ id: enrolled.id, status: "offline" }),
    ]);
  });
  test("refuses service accounts rather than borrowing a human's device", async () => {
    ctx.user = {
      ...ctx.user,
      id: "service-account:00000000-0000-4000-8000-000000000001",
    };
    expect((await request("GET", "")).statusCode).toBe(403);
    expect(
      (await request("POST", "/enroll", { name: "Service computer" }))
        .statusCode,
    ).toBe(403);
  });
});
