import { and, eq } from "drizzle-orm";
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
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { MANIFEST } from "./skill.test-helpers";

// Purge mutates state and must produce an audit record, so this uses the full
// audit-hook harness (like restore.skill.route.test.ts).
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
    await app.close();
  });

  const createSkill = async () =>
    (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();

  const del = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/skills/${id}` });

  const purge = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/skills/${id}/permanent` });

  test("permanently deletes a soft-deleted skill and audits identity-only", async () => {
    const created = await createSkill();
    expect((await del(created.id)).statusCode).toBe(200);

    const response = await purge(created.id);
    expect(response.statusCode).toBe(200);

    // Gone for good — the deleted view cannot see it, versions included.
    expect(
      await SkillModel.findDeletedById(created.id, organizationId),
    ).toBeNull();
    const versions = await db
      .select()
      .from(schema.skillVersionsTable)
      .where(eq(schema.skillVersionsTable.skillId, created.id));
    expect(versions).toEqual([]);

    await vi.waitFor(async () => {
      const rows = await db
        .select({
          action: schema.auditLogsTable.action,
          resourceType: schema.auditLogsTable.resourceType,
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "skill.purged"),
            eq(schema.auditLogsTable.resourceId, created.id),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "skill.purged",
        resourceType: "skill",
        after: null,
      });
      // Identity-only `before` — never a full copy of purged content.
      expect(rows[0].before).toMatchObject({
        id: created.id,
        deletedAt: expect.any(String),
      });
      expect(
        Object.keys(rows[0].before as Record<string, unknown>).sort(),
      ).toEqual(["deletedAt", "id", "name"]);
    });
  });

  test("404 for an active skill — purge is a trash action, never a shortcut", async () => {
    const active = await createSkill();
    expect((await purge(active.id)).statusCode).toBe(404);
    expect((await SkillModel.findById(active.id))?.id).toBe(active.id);

    expect((await purge(crypto.randomUUID())).statusCode).toBe(404);
  });

  test("409 while a sandbox mount pins one of the skill's versions", async () => {
    const created = await createSkill();
    const version = await SkillVersionModel.findBySkillAndVersion(
      created.id,
      created.latestVersion,
    );
    if (!version) throw new Error("skill has no version");
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId: user.id,
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
    expect((await del(created.id)).statusCode).toBe(200);

    const response = await purge(created.id);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("sandbox");

    // Nothing was deleted: the skill stays restorable in the trash.
    expect(
      await SkillModel.findDeletedById(created.id, organizationId),
    ).not.toBeNull();
    expect(
      await SkillVersionModel.findBySkillAndVersion(
        created.id,
        created.latestVersion,
      ),
    ).not.toBeNull();
  });
});
