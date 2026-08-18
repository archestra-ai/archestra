import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { SkillModel, SkillTeamModel, SkillUserModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { manifestNamed, seedImportedSkill } from "./skill.test-helpers";

describe("POST /api/skills/bulk-visibility", () => {
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

  const bulkVisibility = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-visibility",
      payload,
    });

  test("moves several personal skills to a team in one request", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const first = await createSkill("bulk-team-a");
    const second = await createSkill("bulk-team-b");

    const response = await bulkVisibility({
      skillIds: [first.id, second.id],
      scope: "team",
      teamIds: [team.id],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-team-a" },
        { id: second.id, name: "bulk-team-b" },
      ],
      failed: [],
    });
    for (const id of [first.id, second.id]) {
      expect((await SkillModel.findById(id))?.scope).toBe("team");
      expect(await SkillTeamModel.getTeamsForSkill(id)).toEqual([team.id]);
    }
  });

  test("does not fork a version — visibility is not versioned content", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const skill = await createSkill("bulk-no-fork");
    expect(skill.latestVersion).toBe(1);

    expect(
      (
        await bulkVisibility({
          skillIds: [skill.id],
          scope: "team",
          teamIds: [team.id],
        })
      ).statusCode,
    ).toBe(200);

    expect((await SkillModel.findById(skill.id))?.latestVersion).toBe(1);
  });

  test("moving to org clears team assignments and personal grants", async ({
    makeTeam,
    makeUser,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const grantee = await makeUser();
    const teamScoped = await seedImportedSkill({
      organizationId,
      name: "bulk-was-team",
      sourceRef: "acme/skills@main:bulk-was-team",
      scope: "team",
      teamIds: [team.id],
    });
    const shared = await createSkill("bulk-was-shared");
    await SkillUserModel.syncSkillUsers(shared.id, [grantee.id]);

    const response = await bulkVisibility({
      skillIds: [teamScoped.id, shared.id],
      scope: "org",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([]);
    expect(await SkillTeamModel.getTeamsForSkill(teamScoped.id)).toEqual([]);
    expect(
      (await SkillUserModel.getUserDetailsForSkills([shared.id])).get(
        shared.id,
      ),
    ).toEqual([]);
  });

  test("shares a batch with named people while keeping them personal", async ({
    makeUser,
  }) => {
    const grantee = await makeUser();
    const skill = await createSkill("bulk-share-by-name");

    const response = await bulkVisibility({
      skillIds: [skill.id],
      scope: "personal",
      userIds: [grantee.id],
    });

    expect(response.statusCode).toBe(200);
    expect((await SkillModel.findById(skill.id))?.scope).toBe("personal");
    expect(
      (await SkillUserModel.getUserDetailsForSkills([skill.id]))
        .get(skill.id)
        ?.map((entry) => entry.id),
    ).toEqual([grantee.id]);
  });

  test("reports a name collision per skill and still applies the rest", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    // A shared skill already owns the name, so the personal one cannot take it
    // when it widens into the same namespace.
    const blocker = await seedImportedSkill({
      organizationId,
      name: "bulk-contested",
      sourceRef: "acme/skills@main:bulk-contested",
      scope: "org",
    });
    const contested = await createSkill("bulk-contested");
    const fine = await createSkill("bulk-uncontested");

    const response = await bulkVisibility({
      skillIds: [contested.id, fine.id],
      scope: "team",
      teamIds: [team.id],
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.succeeded).toEqual([{ id: fine.id, name: "bulk-uncontested" }]);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({
      id: contested.id,
      name: "bulk-contested",
    });
    expect(body.failed[0].error).toContain("already exists");

    // the collision left its own skill untouched, and the blocker alone
    expect((await SkillModel.findById(contested.id))?.scope).toBe("personal");
    expect((await SkillModel.findById(blocker.id))?.scope).toBe("org");
    expect((await SkillModel.findById(fine.id))?.scope).toBe("team");
  });

  test("rejects the whole request when the target teams are unusable", async () => {
    const skill = await createSkill("bulk-bad-target");

    const noTeams = await bulkVisibility({
      skillIds: [skill.id],
      scope: "team",
      teamIds: [],
    });
    expect(noTeams.statusCode).toBe(400);

    const unknownTeam = await bulkVisibility({
      skillIds: [skill.id],
      scope: "team",
      teamIds: [crypto.randomUUID()],
    });
    expect(unknownTeam.statusCode).toBe(400);

    // nothing moved
    expect((await SkillModel.findById(skill.id))?.scope).toBe("personal");
  });

  test("reports an unknown id without stranding the rest of the batch", async () => {
    const skill = await createSkill("bulk-with-ghost");
    const ghostId = crypto.randomUUID();

    const response = await bulkVisibility({
      skillIds: [ghostId, skill.id],
      scope: "org",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: skill.id, name: "bulk-with-ghost" }],
      failed: [{ id: ghostId, name: null, error: "Skill not found" }],
    });
  });

  test("a skill already in the requested state succeeds without a rewrite", async () => {
    const skill = await createSkill("bulk-already-org");
    expect(
      (await bulkVisibility({ skillIds: [skill.id], scope: "org" })).statusCode,
    ).toBe(200);
    const afterFirst = await SkillModel.findById(skill.id);

    const repeat = await bulkVisibility({ skillIds: [skill.id], scope: "org" });

    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().succeeded).toEqual([
      { id: skill.id, name: "bulk-already-org" },
    ]);
    expect((await SkillModel.findById(skill.id))?.updatedAt).toEqual(
      afterFirst?.updatedAt,
    );
  });

  test("writes one audit record naming every skill in the batch", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const skill = await createSkill("bulk-audited");

    expect(
      (
        await bulkVisibility({
          skillIds: [skill.id],
          scope: "team",
          teamIds: [team.id],
        })
      ).statusCode,
    ).toBe(200);

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
          eq(schema.auditLogsTable.action, "skill.bulk_updated"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].before).toEqual({
      skills: [
        {
          id: skill.id,
          name: "bulk-audited",
          scope: "personal",
          deleted: false,
          teamIds: [],
          userIds: [],
        },
      ],
    });
    expect(rows[0].after).toEqual({
      skills: [
        {
          id: skill.id,
          name: "bulk-audited",
          scope: "team",
          deleted: false,
          teamIds: [team.id],
          userIds: [],
        },
      ],
    });
  });
});

describe("POST /api/skills/bulk-visibility authorization", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    // editor holds skill:team-admin but not skill:admin — may manage its own
    // personal skills and team-scoped skills in its own teams, nothing wider.
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

  const bulkVisibility = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/skills/bulk-visibility",
      payload,
    });

  test("refuses to widen a skill to org without skill:admin", async () => {
    const mine = await seedImportedSkill({
      organizationId,
      name: "bulk-mine",
      sourceRef: "acme/skills@main:bulk-mine",
      scope: "personal",
      authorId: user.id,
    });

    const response = await bulkVisibility({
      skillIds: [mine.id],
      scope: "org",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([]);
    expect(response.json().failed).toHaveLength(1);
    expect(response.json().failed[0].error).toContain("Only admins");
    expect((await SkillModel.findById(mine.id))?.scope).toBe("personal");
  });

  test("someone else's personal skill is not found, not merely refused", async ({
    makeUser,
    makeTeam,
    makeTeamMember,
  }) => {
    const stranger = await makeUser();
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);
    const theirs = await seedImportedSkill({
      organizationId,
      name: "bulk-theirs",
      sourceRef: "acme/skills@main:bulk-theirs",
      scope: "personal",
      authorId: stranger.id,
    });

    const response = await bulkVisibility({
      skillIds: [theirs.id],
      scope: "team",
      teamIds: [team.id],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: theirs.id, name: null, error: "Skill not found" },
    ]);
    expect((await SkillModel.findById(theirs.id))?.scope).toBe("personal");
  });

  test("a skill in another organization is not found", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreign = await seedImportedSkill({
      organizationId: otherOrg.id,
      name: "bulk-foreign",
      sourceRef: "acme/skills@main:bulk-foreign",
      scope: "org",
    });

    const response = await bulkVisibility({
      skillIds: [foreign.id],
      scope: "personal",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: foreign.id, name: null, error: "Skill not found" },
    ]);
    expect((await SkillModel.findById(foreign.id))?.scope).toBe("org");
  });
});
