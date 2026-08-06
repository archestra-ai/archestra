import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { MANIFEST, manifestNamed } from "./skill.test-helpers";

// Restore mutates state and must produce an audit record, so this uses the
// full audit-hook harness (like agent.test.ts) rather than useRouteTestApp.
describe("POST /api/skills/:id/restore", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createSkill = async (content: string = MANIFEST) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content },
      })
    ).json();

  const del = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/skills/${id}` });

  test("restores a soft-deleted skill back into active reads and audits it", async () => {
    const created = await createSkill();
    expect((await del(created.id)).statusCode).toBe(200);
    // hidden from active reads while deleted
    expect(
      (await app.inject({ method: "GET", url: `/api/skills/${created.id}` }))
        .statusCode,
    ).toBe(404);

    const restore = await app.inject({
      method: "POST",
      url: `/api/skills/${created.id}/restore`,
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().id).toBe(created.id);
    expect(restore.json().deletedAt).toBeNull();

    // visible again through the normal detail path
    expect(
      (await app.inject({ method: "GET", url: `/api/skills/${created.id}` }))
        .statusCode,
    ).toBe(200);

    const auditRows = await db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "skill.restored"),
          eq(schema.auditLogsTable.resourceId, created.id),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "skill.restored",
      resourceType: "skill",
      resourceId: created.id,
    });
    // the before/after diff carries the un-delete
    expect(auditRows[0].before).toMatchObject({
      deletedAt: expect.any(String),
    });
    expect(auditRows[0].after).toMatchObject({ deletedAt: null });
  });

  test("404 for a skill that was never deleted or does not exist", async () => {
    const active = await createSkill();
    // active rows are invisible to the restore lookup (findDeletedById)
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/skills/${active.id}/restore`,
        })
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/skills/${crypto.randomUUID()}/restore`,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("409 when the freed name was reclaimed by a new active skill", async () => {
    const first = await createSkill(manifestNamed("reclaimed-name"));
    expect((await del(first.id)).statusCode).toBe(200);
    // deleting frees the name; a new skill takes it
    const second = await createSkill(manifestNamed("reclaimed-name"));
    expect(second.id).not.toBe(first.id);

    const restore = await app.inject({
      method: "POST",
      url: `/api/skills/${first.id}/restore`,
    });
    expect(restore.statusCode).toBe(409);
  });
});
