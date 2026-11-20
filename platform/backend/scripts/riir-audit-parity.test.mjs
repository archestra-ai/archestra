import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq, sql } from "drizzle-orm";
import "../src/server/composition.ts";
import { auth } from "../src/auth/better-auth.ts";
import { authPlugin } from "../src/auth/fastify-plugin/index.ts";
import config from "../src/config.ts";
import db, { initializeDatabase, schema } from "../src/database/index.ts";
import { createFastifyInstance } from "../src/fastify-instance.ts";
import { registerAuditLogHook } from "../src/middleware/audit-log-hook.ts";
import auditLogRoutes from "../src/routes/audit-log/audit-log.routes.ts";
import siteNotificationRoutes from "../src/routes/site-notification.ts";
import { drainBackgroundWork } from "../src/utils/background-work.ts";

test("Axum preserves audit read and mutation permissions and commits with its audit record", async () => {
  assert.equal(new URL(config.database.url).pathname, "/archestra_riir_test");
  const rustSocket = config.database.rustAuditLogSocket;
  assert.ok(rustSocket, "start archestra-api and set its test socket path");
  await initializeDatabase();
  const prefix = randomUUID();
  const org = `${prefix}-org`;
  const otherOrg = `${prefix}-other-org`;
  const now = new Date();
  const stamp = new Date("2025-01-15T12:00:00.000Z");
  await db.insert(schema.organizationsTable).values(
    [org, otherOrg].map((id) => ({ id, name: id, slug: id, createdAt: now })),
  );
  await db.insert(schema.organizationRolesTable).values({
    id: `${prefix}-role`,
    organizationId: org,
    role: "riir-reader",
    name: "Audit reader",
    permission: JSON.stringify({ auditLog: ["read"] }),
  });

  const identity = async (role) => {
    const email = `${prefix}-${role}@example.invalid`;
    const response = await auth.api.signUpEmail({
      body: { name: role, email, password: randomUUID() },
      asResponse: true,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const { user } = await response.json();
    await db.insert(schema.membersTable).values({
      id: randomUUID(),
      organizationId: org,
      userId: user.id,
      role,
      createdAt: now,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    return { id: user.id, cookie };
  };

  const admin = await identity("admin");
  const reader = await identity("riir-reader");
  const member = await identity("member");
  const rows = [
    [org, reader.id, "first"],
    [otherOrg, reader.id, "outside"],
    [org, admin.id, "administrator"],
    [org, reader.id, "last"],
  ].map(([organizationId, actorId, resourceId]) => ({
    organizationId,
    actorId,
    actorType: "user",
    action: "agent.created",
    outcome: "success",
    resourceType: "agent",
    resourceId,
    createdAt: stamp,
    occurredAt: stamp,
    sourceIp: "192.0.2.3",
    impersonatedBy: resourceId === "last" ? admin.id : null,
  }));
  await db.insert(schema.auditLogsTable).values(rows);

  const app = createFastifyInstance();
  const original = config.database.rustAuditLogEnabled;
  const originalNotification = config.database.rustSiteNotificationEnabled;
  try {
    await app.register(authPlugin);
    registerAuditLogHook(app);
    await app.register(auditLogRoutes);
    await app.register(siteNotificationRoutes);
    const check = async (identity, query, expectedStatus) => {
      const fetch = async (implementation) => {
        config.database.rustAuditLogEnabled = implementation === "napi";
        config.database.rustAuditLogSocket =
          implementation === "axum" ? rustSocket : undefined;
        const response = await app.inject({
          url: `/api/audit-logs?${query}`,
          headers: identity ? { cookie: identity.cookie } : {},
        });
        assert.equal(response.statusCode, expectedStatus, response.body);
        return response.json();
      };
      const expected = await fetch("drizzle");
      assert.deepEqual(await fetch("napi"), expected);
      const native = await fetch("axum");
      assert.deepEqual(native, expected);
      return native;
    };
    const query = `action=agent.created&resourceType=agent,tool&limit=1`;
    await check(undefined, query, 401);
    await check(member, query, 403);
    await check(admin, "limit=101", 400);
    const page1 = await check(
      reader,
      `${query}&actorId=${admin.id}&cursor=truncated&organizationId=${otherOrg}&visibility=organization`,
      200,
    );
    assert.equal(page1.data[0].resourceId, "last");
    assert.equal(
      page1.data[0].impersonatedByEmail,
      `${prefix}-admin@example.invalid`,
    );
    const page2 = await check(
      reader,
      `${query}&cursor=${page1.pagination.nextCursor}`,
      200,
    );
    assert.equal(page2.data[0].resourceId, "first");
    assert.equal(page2.pagination.nextCursor, null);
    const adminPage = await check(admin, query.replace("limit=1", "limit=10"), 200);
    assert.deepEqual(adminPage.data.map((row) => row.resourceId), [
      "last",
      "administrator",
      "first",
    ]);
    assert.deepEqual(await check(admin, "limit=10&action=agent.created&resourceType=", 200), adminPage);
    const filtered = await check(
      admin,
      new URLSearchParams({
        actorId: admin.id,
        startDate: stamp.toISOString(),
        endDate: stamp.toISOString(),
      }),
      200,
    );
    assert.deepEqual(filtered.data.map((row) => row.resourceId), ["administrator"]);
    const fractional = await check(
      admin,
      new URLSearchParams({
        startDate: stamp.toISOString().replace(".000Z", ".000999Z"),
        endDate: stamp.toISOString(),
        resourceType: " , agent , unknown, ",
      }),
      200,
    );
    assert.deepEqual(fractional.data.map((row) => row.resourceId), [
      "last",
      "administrator",
      "first",
    ]);
    const paddedCursor = Buffer.from(page1.pagination.nextCursor, "base64url")
      .toString("base64");
    const paddedPage = await check(reader, new URLSearchParams({
      limit: "1",
      cursor: ` \n${paddedCursor}`,
    }), 200);
    assert.deepEqual(paddedPage, page2);

    config.database.rustAuditLogEnabled = true;
    config.database.rustAuditLogSocket = `${rustSocket}.missing`;
    const denied = await app.inject({
      url: `/api/audit-logs?${query}`,
      headers: { cookie: member.cookie },
    });
    assert.equal(denied.statusCode, 403, "authorize before forwarding");
    const unavailable = await app.inject({
      url: `/api/audit-logs?${query}`,
      headers: { cookie: admin.cookie },
    });
    assert.equal(unavailable.statusCode, 500, "must not fall back to NAPI or Drizzle");

    config.database.rustAuditLogSocket = rustSocket;
    const replace = (identity, content, options = {}) =>
      app.inject({
        method: "POST",
        url: "/api/site-notification",
        headers: identity ? { cookie: identity.cookie } : {},
        payload: { content, ...options },
      });
    const notifications = () =>
      db
        .select()
        .from(schema.siteNotificationsTable)
        .where(eq(schema.siteNotificationsTable.organizationId, org))
        .orderBy(schema.siteNotificationsTable.id);
    const successAudits = async () =>
      (
        await db
          .select()
          .from(schema.auditLogsTable)
          .where(eq(schema.auditLogsTable.organizationId, org))
      ).filter(
        (row) => row.action === "organization.updated" && row.outcome === "success",
      );
    for (const useRust of [false, true]) {
      config.database.rustSiteNotificationEnabled = useRust;
      assert.equal((await replace(undefined, "Unauthorized")).statusCode, 401);
      assert.equal((await replace(member, "Forbidden")).statusCode, 403);
      assert.equal((await replace(admin, "")).statusCode, 400);
    }
    assert.equal((await notifications()).length, 0);

    config.database.rustSiteNotificationEnabled = false;
    const legacy = await replace(admin, "Legacy notification");
    assert.equal(legacy.statusCode, 200, legacy.body);
    await drainBackgroundWork();
    assert.equal((await successAudits()).length, 1);

    config.database.rustSiteNotificationEnabled = true;
    const native = await replace(admin, "Native notification");
    assert.equal(native.statusCode, 200, native.body);
    assert.deepEqual(Object.keys(native.json()).sort(), Object.keys(legacy.json()).sort());
    await drainBackgroundWork();
    const committed = await notifications();
    assert.equal(committed.find((item) => item.id === native.json().id).isActive, true);
    assert.equal(committed.find((item) => item.id === legacy.json().id).isActive, false);
    const audits = await successAudits();
    assert.equal(audits.length, 2, "exactly one success record per replacement");
    const nativeAudit = audits.find((row) => row.after?.id === native.json().id);
    assert.equal(nativeAudit.actorId, admin.id);
    assert.equal(nativeAudit.resourceId, org);
    assert.equal(nativeAudit.before.content, "Legacy notification");
    assert.equal(nativeAudit.after.content, "Native notification");
    assert.equal(nativeAudit.after.updatedAt, undefined);

    // A real Postgres constraint error at the audit INSERT, after the
    // notification INSERT and deactivation have already executed.
    await db.execute(sql`ALTER TABLE audit_logs ADD CONSTRAINT riir_reject_audit
      CHECK (after ->> 'content' IS DISTINCT FROM 'Reject audit insert') NOT VALID`);
    try {
      const rejected = await replace(admin, "Reject audit insert");
      assert.equal(rejected.statusCode, 500, rejected.body);
      await drainBackgroundWork();
      assert.deepEqual(await notifications(), committed);
      assert.equal((await successAudits()).length, 2);
    } finally {
      await db.execute(sql`ALTER TABLE audit_logs DROP CONSTRAINT riir_reject_audit`);
    }
    const expiration = "2030-01-02T03:04:05.123999Z";
    for (const useRust of [false, true]) {
      config.database.rustSiteNotificationEnabled = useRust;
      const inactive = await replace(admin, "Inactive notification", {
        expiresAt: expiration,
        isActive: false,
        organizationId: otherOrg,
        audit: { actorId: member.id },
      });
      assert.equal(inactive.statusCode, 200, inactive.body);
      const { id, isActive, expiresAt } = inactive.json();
      assert.equal(isActive, false);
      assert.equal(expiresAt, new Date(expiration).toISOString());
      assert.ok((await notifications()).some((row) => row.id === id));
      await drainBackgroundWork();
      const records = (await successAudits()).filter((row) => row.after?.id === id);
      assert.equal(records.length, 1);
      assert.equal(records[0].actorId, admin.id);
    }
  } finally {
    config.database.rustAuditLogEnabled = original;
    config.database.rustSiteNotificationEnabled = originalNotification;
    config.database.rustAuditLogSocket = rustSocket;
    await app.close();
  }
});
