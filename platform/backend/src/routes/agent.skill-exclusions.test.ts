import { ADMIN_ROLE_NAME, type RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker, hasPermission } from "@/auth";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { SkillTeamModel } from "@/models";
import SkillModel from "@/models/skill";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type InsertSkill, type Skill, type User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;
const mockHasPermission = hasPermission as Mock;

describe("agent skill-exclusions routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let requireMock: Mock;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId);

    requireMock = vi.fn();
    mockGetAgentTypePermissionChecker.mockResolvedValue({
      require: requireMock,
      isAdmin: vi.fn().mockReturnValue(true),
      isTeamAdmin: vi.fn().mockReturnValue(true),
      hasAnyReadPermission: vi.fn().mockReturnValue(true),
      hasAnyAdminPermission: vi.fn().mockReturnValue(true),
    });

    mockHasPermission.mockResolvedValue({ success: true, error: null });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;

      // Replicates the middleware's gate against the real permission map, so
      // these tests exercise the route -> map wiring rather than assuming it.
      const routeId = request.routeOptions.schema?.operationId as
        | RouteId
        | undefined;
      const required = routeId
        ? requiredEndpointPermissionsMap[routeId]
        : undefined;
      if (required && Object.keys(required).length > 0) {
        const result = await hasPermission(required, request.headers);
        if (!result.success) throw new ApiError(403, "Forbidden");
      }
    });
    registerAuditLogHook(app);

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  async function makeSkill(
    overrides: Partial<InsertSkill> = {},
  ): Promise<Skill> {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        name: `skill-${crypto.randomUUID().slice(0, 8)}`,
        description: "A test skill",
        content: "# Instructions",
        scope: "org",
        latestVersion: 1,
        ...overrides,
      } as InsertSkill,
      files: [],
    });
    if (!skill) throw new Error("failed to create test skill");
    return skill;
  }

  /**
   * Promote the request user to the built-in admin role, which is what carries
   * `skill:admin`. The agent-type checker is mocked wide open in this file, so
   * this is the only thing that moves the skill-side permission.
   */
  async function promoteCallerToSkillAdmin(): Promise<void> {
    await db
      .update(schema.membersTable)
      .set({ role: ADMIN_ROLE_NAME })
      .where(
        and(
          eq(schema.membersTable.userId, user.id),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      );
  }

  test("GET returns an empty set and PUT round-trips a full replace", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const excluded = await makeSkill();

    const emptyResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skill-exclusions`,
    });
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toEqual({ excludedSkillIds: [], skills: [] });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [excluded.id] },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toMatchObject({
      excludedSkillIds: [excluded.id],
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skill-exclusions`,
    });
    expect(getResponse.json()).toMatchObject({
      excludedSkillIds: [excluded.id],
    });

    // Full replace with an empty set clears everything.
    const clearResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [] },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({ excludedSkillIds: [], skills: [] });
  });

  test("GET omits soft-deleted skills, so its result always round-trips through PUT", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const kept = await makeSkill();
    const deleted = await makeSkill();

    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [kept.id, deleted.id].sort() },
    });
    await SkillModel.delete(deleted.id);

    // The deleted id must not come back: `findByIds` filters deleted rows, so
    // a PUT echoing a GET that still contained it would 404.
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skill-exclusions`,
    });
    expect(getResponse.json()).toMatchObject({ excludedSkillIds: [kept.id] });

    const roundTrip = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: getResponse.json(),
    });
    expect(roundTrip.statusCode).toBe(200);
  });

  // The foreign-org 404, agent-type-permission 404, and skill-visibility 404
  // behaviors live in requireAgentSkillReadAccess/WriteAccess and
  // requireSkillsAccessible, which these routes share with /skills — their
  // internals are pinned once in agent.skills.test.ts. This suite only proves
  // the exclusions routes are wired through them (the 403 below, and the
  // unreadable-id 404 further down).
  test("returns 403 when the caller's role has no skill:read", async ({
    makeAgent,
  }) => {
    // Same floor as the assignments routes: the GET names the excluded skills,
    // and the PUT decides what an Auto-mode gateway stops publishing. Neither
    // is bought by gateway permission alone.
    const agent = await makeAgent({ organizationId });
    mockHasPermission.mockResolvedValue({
      success: false,
      error: "Forbidden",
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skill-exclusions`,
    });
    expect(getResponse.statusCode).toBe(403);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [] },
    });
    expect(putResponse.statusCode).toBe(403);
    expect(mockHasPermission).toHaveBeenCalledWith(
      { skill: ["read"] },
      expect.anything(),
    );
  });

  test("PUT refuses ids the caller cannot read, so the GET cannot be used as a lookup", async ({
    makeAgent,
    makeTeam,
    makeUser,
  }) => {
    // Every excluded id comes back from the GET as a full row — name,
    // description, scope, author. Accepting an id the caller cannot read would
    // turn this endpoint into a directory of other people's skills.
    const agent = await makeAgent({ organizationId, accessAllSkills: true });

    const team = await makeTeam(organizationId, user.id);
    const teamSkill = await makeSkill({ scope: "team" });
    await SkillTeamModel.syncSkillTeams(teamSkill.id, [team.id]);

    const colleague = await makeUser();
    const theirPersonalSkill = await makeSkill({
      scope: "personal",
      authorId: colleague.id,
    });

    for (const skillId of [teamSkill.id, theirPersonalSkill.id]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}/skill-exclusions`,
        payload: { excludedSkillIds: [skillId] },
      });
      // The same 404 a nonexistent id gets, above.
      expect(response.statusCode, skillId).toBe(404);
      expect(response.json().error.message).toBe(`Skill not found: ${skillId}`);
    }

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skill-exclusions`,
    });
    expect(getResponse.json()).toEqual({ excludedSkillIds: [], skills: [] });
  });

  test("PUT by another editor keeps a stored exclusion it cannot itself read", async ({
    makeAgent,
    makeTeam,
    makeTeamMember,
    makeUser,
    makeMember,
  }) => {
    // The access check judges ids being ADDED, never the echoed stored set —
    // otherwise a team member's exclusion would wedge every later save by an
    // editor outside that team.
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const team = await makeTeam(organizationId, user.id);
    const teamSkill = await makeSkill({ scope: "team" });
    await SkillTeamModel.syncSkillTeams(teamSkill.id, [team.id]);
    await makeTeamMember(team.id, user.id);

    const seeded = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [teamSkill.id] },
    });
    expect(seeded.statusCode).toBe(200);

    const editor = await makeUser();
    await makeMember(editor.id, organizationId);
    user = editor;

    const orgSkill = await makeSkill();
    const grow = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [teamSkill.id, orgSkill.id].sort() },
    });
    expect(grow.statusCode).toBe(200);
    expect(grow.json()).toMatchObject({
      excludedSkillIds: [teamSkill.id, orgSkill.id].sort(),
    });
  });

  test("PUT excludes a team skill for a team member, and for a skill admin", async ({
    makeAgent,
    makeTeam,
    makeTeamMember,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const team = await makeTeam(organizationId, user.id);
    const teamSkill = await makeSkill({ scope: "team" });
    await SkillTeamModel.syncSkillTeams(teamSkill.id, [team.id]);

    await makeTeamMember(team.id, user.id);
    const asMember = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [teamSkill.id] },
    });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json()).toMatchObject({
      excludedSkillIds: [teamSkill.id],
    });

    // A skill admin reaches the same skill without belonging to the team.
    const adminOnlySkill = await makeSkill({ scope: "team" });
    const otherTeam = await makeTeam(organizationId, user.id);
    await SkillTeamModel.syncSkillTeams(adminOnlySkill.id, [otherTeam.id]);
    await promoteCallerToSkillAdmin();

    const asAdmin = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [adminOnlySkill.id] },
    });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json()).toMatchObject({
      excludedSkillIds: [adminOnlySkill.id],
    });
  });

  test("an unrelated replace leaves a soft-deleted skill's exclusion alone", async ({
    makeAgent,
  }) => {
    // Auto mode publishes everything that is not excluded. The GET hides a
    // soft-deleted skill, so no PUT an admin can write carries its id — and if
    // an unrelated toggle dropped the row, restoring the skill from trash would
    // silently publish it to every holder of this gateway's token, with an
    // audit diff showing nothing.
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const kept = await makeSkill();
    const trashed = await makeSkill();

    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [kept.id, trashed.id].sort() },
    });
    await SkillModel.delete(trashed.id);

    const unrelated = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [] },
    });
    expect(unrelated.statusCode).toBe(200);
    expect(unrelated.json()).toMatchObject({ excludedSkillIds: [] });

    await SkillModel.restore(trashed.id);

    const restored = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skill-exclusions`,
    });
    expect(restored.json()).toMatchObject({
      excludedSkillIds: [trashed.id],
    });
  });

  test("PUT accepts a templated skill: excluding only ever narrows the surface", async ({
    makeAgent,
  }) => {
    // The publishability gates guard assignment, not exclusion — an admin may
    // exclude anything the organization owns.
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const templated = await makeSkill({ templated: true });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [templated.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      excludedSkillIds: [templated.id],
    });
  });

  test("PUT writes an agent.updated audit record capturing the exclusions", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, accessAllSkills: true });
    const excluded = await makeSkill();

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skill-exclusions`,
      payload: { excludedSkillIds: [excluded.id] },
    });
    expect(response.statusCode).toBe(200);

    const auditRows = await db
      .select({
        action: schema.auditLogsTable.action,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].before).toMatchObject({ excludedSkillIds: [] });
    expect(auditRows[0].after).toMatchObject({
      excludedSkillIds: [excluded.id],
    });
  });
});
