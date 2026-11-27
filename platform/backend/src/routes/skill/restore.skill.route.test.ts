import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
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

  test("a repeated restore returns the active skill instead of a 404", async () => {
    const created = await createSkill();
    expect((await del(created.id)).statusCode).toBe(200);
    const restore = () =>
      app.inject({ method: "POST", url: `/api/skills/${created.id}/restore` });
    expect((await restore()).statusCode).toBe(200);

    // The second click of a double click, or a retry after a lost response.
    const repeated = await restore();
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ id: created.id, deletedAt: null });

    // Nothing changed the second time, so nothing more is audited.
    const auditRows = await db
      .select({ id: schema.auditLogsTable.id })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "skill.restored"),
          eq(schema.auditLogsTable.resourceId, created.id),
        ),
      );
    expect(auditRows).toHaveLength(1);
  });

  test("404 for an id that names no skill", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/skills/${crypto.randomUUID()}/restore`,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("a repeated restore is authorized like the restore itself", async ({
    makeUser,
    makeMember,
  }) => {
    const created = await createSkill();
    // Another member cannot see the admin's personal skill, so the id is a
    // 404 for them whether it is deleted or active.
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId, { role: "member" });
    user = outsider;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/skills/${created.id}/restore`,
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
