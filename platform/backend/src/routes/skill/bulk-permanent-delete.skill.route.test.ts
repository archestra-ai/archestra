import { and, eq, inArray } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { SkillModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { manifestNamed, seedBuiltInSkill } from "./skill.test-helpers";

describe("POST /api/skills/bulk-permanent-delete", () => {
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

  const createSkill = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: manifestNamed(name) },
      })
    ).json();

  const createDeletedSkill = async (name: string) => {
    const skill = await createSkill(name);
    await app.inject({ method: "DELETE", url: `/api/skills/${skill.id}` });
    return skill;
  };

  const bulkPurge = (skillIds: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-permanent-delete",
      payload: { skillIds },
    });

  const rowsOf = (ids: string[]) =>
    db
      .select({ id: schema.skillsTable.id })
      .from(schema.skillsTable)
      .where(inArray(schema.skillsTable.id, ids));

  test("destroys every named deleted skill and leaves the other deleted skills", async () => {
    const first = await createDeletedSkill("bulk-purge-a");
    const second = await createDeletedSkill("bulk-purge-b");
    const left = await createDeletedSkill("bulk-purge-left");

    const response = await bulkPurge([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-purge-a" },
        { id: second.id, name: "bulk-purge-b" },
      ],
      failed: [],
    });
    expect(await rowsOf([first.id, second.id])).toEqual([]);
    expect(
      await SkillModel.findDeletedById(left.id, organizationId),
    ).not.toBeNull();
  });

  test("refuses a live skill, a built-in and an unknown id, and destroys the rest", async () => {
    const live = await createSkill("bulk-purge-live");
    const builtIn = await seedBuiltInSkill({
      organizationId,
      name: "bulk-purge-shipped",
      builtInSkillId: "bulk-purge-shipped",
    });
    await app.inject({ method: "DELETE", url: `/api/skills/${builtIn.id}` });
    const deleted = await createDeletedSkill("bulk-purge-gone");
    const ghostId = "00000000-0000-4000-8000-000000000000";

    const response = await bulkPurge([
      live.id,
      builtIn.id,
      deleted.id,
      ghostId,
    ]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toEqual([
      { id: deleted.id, name: "bulk-purge-gone" },
    ]);
    expect(body.failed).toEqual([
      // A live skill is not in the trash, so it is not this route's to find.
      { id: live.id, name: null, error: "Skill not found" },
      {
        id: builtIn.id,
        name: "bulk-purge-shipped",
        error: expect.stringContaining(
          "Built-in skills cannot be permanently deleted",
        ),
      },
      { id: ghostId, name: null, error: "Skill not found" },
    ]);
    expect(await SkillModel.findById(live.id)).toBeTruthy();
    // The built-in's deleted row is what stops the seeder bringing it back.
    expect(
      await SkillModel.findDeletedById(builtIn.id, organizationId),
    ).not.toBeNull();
  });

  test("404s for a custom role holding every skill permission, and destroys nothing", async ({
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const deleted = await createDeletedSkill("bulk-purge-guarded");
    const role = await makeCustomRole(organizationId, {
      permission: {
        skill: ["read", "create", "update", "delete", "team-admin", "admin"],
      },
    });
    const deleter = await makeUser({ email: "bulk-skill-deleter@test.com" });
    await makeMember(deleter.id, organizationId, { role: role.role });
    user = deleter;

    const response = await bulkPurge([deleted.id]);

    expect(response.statusCode).toBe(404);
    expect(await rowsOf([deleted.id])).toHaveLength(1);
  });

  test("rejects an empty selection", async () => {
    expect((await bulkPurge([])).statusCode).toBe(400);
  });

  test("writes one audit record that names what was destroyed, with no content", async () => {
    const skill = await createDeletedSkill("bulk-purge-audited");

    expect((await bulkPurge([skill.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "skill.bulk_purged"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("skill");
    expect(rows[0].before).toMatchObject({
      skills: [{ id: skill.id, name: "bulk-purge-audited", deleted: true }],
    });
    // Gone, so there is nothing left to describe.
    expect(rows[0].after).toEqual({ skills: [] });
    expect(JSON.stringify(rows[0].before)).not.toContain("content");
  });
});
