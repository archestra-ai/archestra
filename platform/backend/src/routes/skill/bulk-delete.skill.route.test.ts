import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { SkillModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { manifestNamed, seedImportedSkill } from "./skill.test-helpers";

describe("POST /api/skills/bulk-delete", () => {
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

  const bulkDelete = (skillIds: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-delete",
      payload: { skillIds },
    });

  test("soft-deletes every named skill and hides them from the list", async () => {
    const first = await createSkill("bulk-del-a");
    const second = await createSkill("bulk-del-b");
    const kept = await createSkill("bulk-del-kept");

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-del-a" },
        { id: second.id, name: "bulk-del-b" },
      ],
      failed: [],
    });

    const list = (
      await app.inject({ method: "GET", url: "/api/skills" })
    ).json();
    const listedIds = list.data.map((skill: { id: string }) => skill.id);
    expect(listedIds).not.toContain(first.id);
    expect(listedIds).not.toContain(second.id);
    expect(listedIds).toContain(kept.id);

    // soft, not hard: both rows are restorable from the trash
    for (const id of [first.id, second.id]) {
      expect(await SkillModel.findDeletedById(id, organizationId)).toBeTruthy();
    }
  });

  test("collapses duplicate ids into a single outcome", async () => {
    const skill = await createSkill("bulk-del-dupe");

    const response = await bulkDelete([skill.id, skill.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: skill.id, name: "bulk-del-dupe" },
    ]);
  });

  test("reports an unknown id without stranding the rest of the batch", async () => {
    const skill = await createSkill("bulk-del-with-ghost");
    const ghostId = crypto.randomUUID();

    const response = await bulkDelete([ghostId, skill.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: skill.id, name: "bulk-del-with-ghost" }],
      failed: [{ id: ghostId, name: null, error: "Skill not found" }],
    });
    expect(await SkillModel.findById(skill.id)).toBeNull();
  });

  test("rejects an empty selection", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async () => {
    const skill = await createSkill("bulk-del-audited");

    expect((await bulkDelete([skill.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "skill.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("skill");
    expect(rows[0].before).toMatchObject({
      skills: [{ id: skill.id, name: "bulk-del-audited", deleted: false }],
    });
    // the "after" side still names the skill it removed
    expect(rows[0].after).toMatchObject({
      skills: [{ id: skill.id, name: "bulk-del-audited", deleted: true }],
    });
  });
});

describe("POST /api/skills/bulk-delete authorization", () => {
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

  const bulkDelete = (skillIds: string[]) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-delete",
      payload: { skillIds },
    });

  test("refuses an org-scoped skill while deleting the caller's own", async () => {
    const orgWide = await seedImportedSkill({
      organizationId,
      name: "bulk-del-org-wide",
      sourceRef: "acme/skills@main:bulk-del-org-wide",
      scope: "org",
    });
    const mine = await seedImportedSkill({
      organizationId,
      name: "bulk-del-mine",
      sourceRef: "acme/skills@main:bulk-del-mine",
      scope: "personal",
      authorId: user.id,
    });

    const response = await bulkDelete([orgWide.id, mine.id]);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toEqual([{ id: mine.id, name: "bulk-del-mine" }]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({
      id: orgWide.id,
      name: "bulk-del-org-wide",
    });
    expect(body.failed[0].error).toContain("Only admins");

    expect(await SkillModel.findById(orgWide.id)).toBeTruthy();
    expect(await SkillModel.findById(mine.id)).toBeNull();
  });

  test("someone else's personal skill is not found, not merely refused", async ({
    makeUser,
  }) => {
    const stranger = await makeUser();
    const theirs = await seedImportedSkill({
      organizationId,
      name: "bulk-del-theirs",
      sourceRef: "acme/skills@main:bulk-del-theirs",
      scope: "personal",
      authorId: stranger.id,
    });

    const response = await bulkDelete([theirs.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: theirs.id, name: null, error: "Skill not found" },
    ]);
    expect(await SkillModel.findById(theirs.id)).toBeTruthy();
  });
});
