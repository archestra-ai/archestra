import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { SkillModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { manifestNamed, seedImportedSkill } from "./skill.test-helpers";

describe("POST /api/skills/bulk-restore", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

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

  const bulkRestore = (skillIds: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-restore",
      payload: { skillIds },
    });

  test("restores every named skill and leaves other deleted skills deleted", async () => {
    const first = await createDeletedSkill("bulk-res-a");
    const second = await createDeletedSkill("bulk-res-b");
    const left = await createDeletedSkill("bulk-res-left");

    const response = await bulkRestore([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-res-a" },
        { id: second.id, name: "bulk-res-b" },
      ],
      failed: [],
    });
    expect(await SkillModel.findById(first.id)).toBeTruthy();
    expect(await SkillModel.findById(second.id)).toBeTruthy();
    expect(await SkillModel.findById(left.id)).toBeNull();
  });

  test("reports a skill whose name was taken since, and restores the rest", async () => {
    const taken = await createDeletedSkill("bulk-res-taken");
    // Deleting freed the name; a new skill of the same author took it.
    await createSkill("bulk-res-taken");
    const free = await createDeletedSkill("bulk-res-free");

    const response = await bulkRestore([taken.id, free.id]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toEqual([{ id: free.id, name: "bulk-res-free" }]);
    expect(body.failed).toEqual([
      {
        id: taken.id,
        name: "bulk-res-taken",
        error:
          'Cannot restore: a skill named "bulk-res-taken" by the same author already exists.',
      },
    ]);
    expect(
      await SkillModel.findDeletedById(taken.id, organizationId),
    ).not.toBeNull();
  });

  test("restores one of two deleted skills that share a name and refuses the other", async () => {
    const older = await createDeletedSkill("bulk-res-twin");
    const newer = await createDeletedSkill("bulk-res-twin");

    const response = await bulkRestore([older.id, newer.id]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toEqual([{ id: older.id, name: "bulk-res-twin" }]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({
      id: newer.id,
      name: "bulk-res-twin",
    });
    expect(await SkillModel.findById(older.id)).toBeTruthy();
    expect(await SkillModel.findById(newer.id)).toBeNull();
  });

  test("counts a skill that is already active as restored", async () => {
    const active = await createSkill("bulk-res-active");
    const deleted = await createDeletedSkill("bulk-res-deleted");

    const response = await bulkRestore([active.id, deleted.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: active.id, name: "bulk-res-active" },
        { id: deleted.id, name: "bulk-res-deleted" },
      ],
      failed: [],
    });
  });

  test("reports an unknown id without failing the batch", async () => {
    const skill = await createDeletedSkill("bulk-res-with-ghost");
    const ghostId = "00000000-0000-4000-8000-000000000000";

    const response = await bulkRestore([skill.id, ghostId]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: skill.id, name: "bulk-res-with-ghost" }],
      failed: [{ id: ghostId, name: null, error: "Skill not found" }],
    });
  });

  test("rejects an empty selection", async () => {
    expect((await bulkRestore([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async () => {
    const skill = await createDeletedSkill("bulk-res-audited");

    expect((await bulkRestore([skill.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "skill.bulk_restored"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("skill");
    expect(rows[0].before).toMatchObject({
      skills: [{ id: skill.id, name: "bulk-res-audited", deleted: true }],
    });
    expect(rows[0].after).toMatchObject({
      skills: [{ id: skill.id, name: "bulk-res-audited", deleted: false }],
    });
  });
});

describe("POST /api/skills/bulk-restore authorization", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: EDITOR_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const bulkRestore = (skillIds: string[]) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-restore",
      payload: { skillIds },
    });

  test("refuses an org-scoped skill while restoring the caller's own", async () => {
    const orgWide = await seedImportedSkill({
      organizationId,
      name: "bulk-res-org-wide",
      sourceRef: "acme/skills@main:bulk-res-org-wide",
      access: "org",
    });
    const mine = await seedImportedSkill({
      organizationId,
      name: "bulk-res-mine",
      sourceRef: "acme/skills@main:bulk-res-mine",
      authorId: user.id,
    });
    await SkillModel.deleteMany([orgWide.id, mine.id]);

    const response = await bulkRestore([orgWide.id, mine.id]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toEqual([{ id: mine.id, name: "bulk-res-mine" }]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({
      id: orgWide.id,
      name: "bulk-res-org-wide",
    });
    expect(body.failed[0].error).toContain("permission");

    expect(await SkillModel.findById(orgWide.id)).toBeNull();
    expect(await SkillModel.findById(mine.id)).toBeTruthy();
  });

  test("someone else's deleted personal skill is not found, not merely refused", async ({
    makeUser,
  }) => {
    const stranger = await makeUser();
    const theirs = await seedImportedSkill({
      organizationId,
      name: "bulk-res-theirs",
      sourceRef: "acme/skills@main:bulk-res-theirs",
      authorId: stranger.id,
    });
    await SkillModel.deleteMany([theirs.id]);

    const response = await bulkRestore([theirs.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: theirs.id, name: null, error: "Skill not found" },
    ]);
    expect(await SkillModel.findById(theirs.id)).toBeNull();
  });
});
