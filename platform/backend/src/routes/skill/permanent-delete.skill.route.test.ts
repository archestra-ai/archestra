import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  SkillModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
  SkillVersionModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AuditEventName, User } from "@/types";
import skillRoutes from "./skill.routes";
import {
  MANIFEST,
  manifestNamed,
  seedBuiltInSkill,
} from "./skill.test-helpers";

describe("DELETE /api/skills/:id/permanent", () => {
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

  const softDelete = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/skills/${id}` });

  const purge = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/skills/${id}/permanent` });

  const versionsOf = (skillId: string) =>
    db
      .select({ id: schema.skillVersionsTable.id })
      .from(schema.skillVersionsTable)
      .where(eq(schema.skillVersionsTable.skillId, skillId));

  test("destroys the skill, its versions, and their file contents", async () => {
    const created = await createSkill();
    const versions = await versionsOf(created.id);
    expect(versions).not.toHaveLength(0);
    const versionId = versions[0].id;

    expect((await softDelete(created.id)).statusCode).toBe(200);
    const response = await purge(created.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });

    // The row is physically gone, not merely stamped.
    const rows = await db
      .select({ id: schema.skillsTable.id })
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, created.id));
    expect(rows).toHaveLength(0);

    // Versions must be DELETED, not orphaned. `skill_versions.skill_id` is
    // ON DELETE SET NULL, so a purge that only dropped the skill row would
    // leave these rows behind with a null skill_id — and with them the skill's
    // actual bytes, unreachable and undeletable.
    expect(await versionsOf(created.id)).toHaveLength(0);
    const orphans = await db
      .select({ id: schema.skillVersionsTable.id })
      .from(schema.skillVersionsTable)
      .where(eq(schema.skillVersionsTable.id, versionId));
    expect(orphans).toHaveLength(0);

    // ...and the version's file contents go with it (cascade).
    const versionFiles = await db
      .select({ id: schema.skillVersionFilesTable.id })
      .from(schema.skillVersionFilesTable)
      .where(eq(schema.skillVersionFilesTable.versionId, versionId));
    expect(versionFiles).toHaveLength(0);
  });

  test("404s for a skill that is still live", async () => {
    const created = await createSkill();

    const response = await purge(created.id);
    expect(response.statusCode).toBe(404);
    expect(await SkillModel.findById(created.id)).not.toBeNull();
  });

  test("404s for an unknown id", async () => {
    const response = await purge(crypto.randomUUID());
    expect(response.statusCode).toBe(404);
  });

  test("404s for a custom role holding every skill permission", async ({
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const created = await createSkill();
    expect((await softDelete(created.id)).statusCode).toBe(200);

    // `skill:admin` is the oversight grant — it gets you as far as the trash
    // and no further, because permanent deletion takes a built-in admin role
    // rather than any permission. The refusal is a 404 so it cannot be used to
    // probe for a trashed skill's existence.
    const role = await makeCustomRole(organizationId, {
      permission: {
        skill: ["read", "create", "update", "delete", "team-admin", "admin"],
      },
    });
    const deleter = await makeUser({ email: "skill-deleter@test.com" });
    await makeMember(deleter.id, organizationId, { role: role.role });
    user = deleter;

    const response = await purge(created.id);
    expect(response.statusCode).toBe(404);

    const rows = await db
      .select({ id: schema.skillsTable.id })
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, created.id));
    expect(rows).toHaveLength(1);
  });

  test("404s across organizations", async ({
    makeOrganization,
    makeMember,
  }) => {
    const created = await createSkill();
    expect((await softDelete(created.id)).statusCode).toBe(200);

    // A global admin of the OTHER org: the refusal has to come from org
    // scoping, not from the caller having lost their admin role along the way.
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });

    const response = await purge(created.id);
    expect(response.statusCode).toBe(404);
  });

  test("409s while a sandbox still mounts one of its versions", async ({
    makeUser,
  }) => {
    const created = await createSkill(manifestNamed("mounted-skill"));
    const version = await SkillVersionModel.findBySkillAndVersion(
      created.id,
      created.latestVersion,
    );
    if (!version) throw new Error("skill has no version");

    const sandboxUser = await makeUser({ email: "sandbox-user@test.com" });
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId: sandboxUser.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await SkillSandboxReplayEventModel.appendSkillMount({
      sandboxId: sandbox.id,
      organizationId,
      mount: {
        skillId: created.id,
        skillName: created.name,
        skillVersionId: version.id,
      },
    });

    expect((await softDelete(created.id)).statusCode).toBe(200);

    const response = await purge(created.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/mounted in a code sandbox/i);

    // Refused, and refused WITHOUT partial damage: the mount pins these version
    // rows via ON DELETE RESTRICT, and the whole purge shares one transaction,
    // so the skill and its versions are exactly as they were.
    const rows = await db
      .select({ id: schema.skillsTable.id })
      .from(schema.skillsTable)
      .where(eq(schema.skillsTable.id, created.id));
    expect(rows).toHaveLength(1);
    expect(await versionsOf(created.id)).not.toHaveLength(0);
  });

  test("403s for a built-in skill, whose deleted row is what stops the seeder", async () => {
    const builtIn = await seedBuiltInSkill({
      organizationId,
      name: "shipped-skill",
      builtInSkillId: "shipped-skill",
    });
    expect((await softDelete(builtIn.id)).statusCode).toBe(200);

    const response = await purge(builtIn.id);
    expect(response.statusCode).toBe(403);

    // The retained row must survive: `SkillModel.findBuiltIn` includes
    // soft-deleted rows precisely so startup sync sees this one and skips it.
    // Destroying it would hand the skill back on the next boot.
    const stillOptedOut = await SkillModel.findDeletedById(
      builtIn.id,
      organizationId,
    );
    expect(stillOptedOut).not.toBeNull();
  });

  test("is audited by identity only, with no copy of the content", async () => {
    const created = await createSkill(manifestNamed("audited-purge"));
    expect((await softDelete(created.id)).statusCode).toBe(200);
    expect((await purge(created.id)).statusCode).toBe(200);

    const rows = await auditRowsFor(created.id, "skill.purged");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "skill.purged",
      resourceType: "skill",
      resourceId: created.id,
      resourceName: "audited-purge",
    });
    // Identity and nothing more. The point of the action is to destroy the
    // content, so an audit row carrying a snapshot of it would defeat the
    // request — and a missing registry entry would produce exactly that, by
    // inheriting `/api/skills/:id`'s full-snapshot fetcher through walk-up.
    // `deletedAt` rides along as lifecycle metadata, not content: it is how
    // long the skill sat in the trash, which is what the retention sweep acts on.
    expect(rows[0].before).toEqual({
      id: created.id,
      name: "audited-purge",
      deletedAt: expect.any(String),
    });
    expect(rows[0].after).toBeNull();
  });

  const selectAuditRows = (resourceId: string) =>
    db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
        resourceId: schema.auditLogsTable.resourceId,
        resourceName: schema.auditLogsTable.resourceName,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(eq(schema.auditLogsTable.resourceId, resourceId));

  /** Audit rows are written fire-and-forget, so poll rather than assert once. */
  const auditRowsFor = async (resourceId: string, action: AuditEventName) => {
    await vi.waitFor(async () => {
      const rows = await selectAuditRows(resourceId);
      expect(rows.some((row) => row.action === action)).toBe(true);
    });
    return (await selectAuditRows(resourceId)).filter(
      (row) => row.action === action,
    );
  };
});
