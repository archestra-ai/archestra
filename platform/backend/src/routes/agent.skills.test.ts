import { ADMIN_ROLE_NAME, type RouteId } from "@archestra/shared";
import { requiredEndpointPermissionsMap } from "@archestra/shared/access-control";
import { and, eq } from "drizzle-orm";
import { type Mock, vi } from "vitest";
import { getAgentTypePermissionChecker, hasPermission } from "@/auth";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { EnvironmentModel, SkillTeamModel } from "@/models";
import SkillModel from "@/models/skill";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type InsertSkill, type Skill, type User } from "@/types";

vi.mock("@/auth");

const mockGetAgentTypePermissionChecker = getAgentTypePermissionChecker as Mock;
const mockHasPermission = hasPermission as Mock;

describe("agent skills routes", () => {
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
    environmentIds: string[] = [],
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
      environmentIds,
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

  test("GET returns the defaults and PUT round-trips a full replace", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const first = await makeSkill();
    const second = await makeSkill();
    const skillIds = [first.id, second.id].sort();

    const emptyResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(emptyResponse.statusCode).toBe(200);
    expect(emptyResponse.json()).toEqual({
      accessAllSkills: false,
      skillIds: [],
      skills: [],
    });

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds },
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toMatchObject({
      accessAllSkills: false,
      skillIds,
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(getResponse.json()).toMatchObject({
      accessAllSkills: false,
      skillIds,
    });

    // Full replace: flipping to Auto mode with an empty set clears assignments.
    const clearResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: true, skillIds: [] },
    });
    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toEqual({
      accessAllSkills: true,
      skillIds: [],
      skills: [],
    });
  });

  test("returns 404 for an agent belonging to another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignAgent = await makeAgent({ organizationId: otherOrg.id });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${foreignAgent.id}/skills`,
    });
    expect(getResponse.statusCode).toBe(404);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${foreignAgent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [] },
    });
    expect(putResponse.statusCode).toBe(404);
  });

  test("returns 404 when the caller lacks the agent-type permission", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    requireMock.mockImplementation(() => {
      throw new Error("missing permission");
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(getResponse.statusCode).toBe(404);
    expect(requireMock).toHaveBeenCalledWith(agent.agentType, "read");

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [] },
    });
    expect(putResponse.statusCode).toBe(404);
    expect(requireMock).toHaveBeenCalledWith(agent.agentType, "update");
  });

  test("returns 403 when the caller's role has no skill:read", async ({
    makeAgent,
  }) => {
    // Gateway permission is not enough on its own. `mcpGateway:update` is a
    // default member permission, and publishing hands a skill's whole body to
    // every holder of the gateway's token — so a role deliberately stripped of
    // the skill resource must not reach these routes, in either direction: the
    // GET discloses skill names and scopes, the PUT decides what is served.
    const agent = await makeAgent({ organizationId });
    mockHasPermission.mockResolvedValue({
      success: false,
      error: "Forbidden",
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(getResponse.statusCode).toBe(403);

    const putResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [] },
    });
    expect(putResponse.statusCode).toBe(403);
    expect(mockHasPermission).toHaveBeenCalledWith(
      { skill: ["read"] },
      expect.anything(),
    );
  });

  test("PUT rejects skills that are not visible in this organization with a 404", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const agent = await makeAgent({ organizationId });
    const otherOrg = await makeOrganization();
    const foreignSkill = await makeSkill({ organizationId: otherOrg.id });

    // A foreign-org skill and a nonexistent id answer identically, so the
    // endpoint cannot be used to probe which skill ids exist elsewhere.
    for (const skillId of [foreignSkill.id, crypto.randomUUID()]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/agents/${agent.id}/skills`,
        payload: { accessAllSkills: false, skillIds: [skillId] },
      });
      expect(response.statusCode, skillId).toBe(404);
    }
  });

  test("PUT refuses to publish a team skill the caller cannot read", async ({
    makeAgent,
    makeTeam,
  }) => {
    // `mcpGateway:update` is a default member permission, so gateway access
    // alone must not let someone publish — and thereby read, through the
    // gateway's token, forever — a team skill they were never given.
    const agent = await makeAgent({ organizationId });
    const team = await makeTeam(organizationId, user.id);
    const teamSkill = await makeSkill({ scope: "team" });
    await SkillTeamModel.syncSkillTeams(teamSkill.id, [team.id]);

    const denied = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [teamSkill.id] },
    });
    // Byte-identical to the nonexistent-id answer, so the endpoint cannot be
    // used to discover which skill ids the organization holds.
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.message).toBe(
      `Skill not found: ${teamSkill.id}`,
    );

    const assignments = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(assignments.json()).toMatchObject({ skillIds: [] });
  });

  test("PUT publishes a team skill for a member of that team", async ({
    makeAgent,
    makeTeam,
    makeTeamMember,
  }) => {
    const agent = await makeAgent({ organizationId });
    const team = await makeTeam(organizationId, user.id);
    const teamSkill = await makeSkill({ scope: "team" });
    await SkillTeamModel.syncSkillTeams(teamSkill.id, [team.id]);
    await makeTeamMember(team.id, user.id);

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [teamSkill.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ skillIds: [teamSkill.id] });
  });

  test("PUT publishes a team skill for a skill admin who is not on the team", async ({
    makeAgent,
    makeTeam,
  }) => {
    // `skill:admin` bypasses scope restrictions here exactly as it does on the
    // skill routes themselves.
    const agent = await makeAgent({ organizationId });
    const team = await makeTeam(organizationId, user.id);
    const teamSkill = await makeSkill({ scope: "team" });
    await SkillTeamModel.syncSkillTeams(teamSkill.id, [team.id]);
    await promoteCallerToSkillAdmin();

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [teamSkill.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ skillIds: [teamSkill.id] });
  });

  test("PUT answers 404, not the publishability 422, for someone else's personal skill", async ({
    makeAgent,
    makeUser,
  }) => {
    // The scope rejection would confirm the id names a real personal skill and
    // name its author; the access check runs first and refuses to say so.
    const agent = await makeAgent({ organizationId });
    const colleague = await makeUser();
    const theirs = await makeSkill({
      scope: "personal",
      authorId: colleague.id,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [theirs.id] },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe(`Skill not found: ${theirs.id}`);
  });

  test("PUT publishes the caller's own personal skill on a shared gateway", async ({
    makeAgent,
  }) => {
    // Publication is the author's call: their personal skill can go on any
    // gateway they can edit, not only the auto-provisioned personal one.
    const agent = await makeAgent({ organizationId });
    const mine = await makeSkill({ scope: "personal", authorId: user.id });

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [mine.id] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ skillIds: [mine.id] });
  });

  test("PUT answers 422 for someone else's personal skill a skill admin can read", async ({
    makeAgent,
    makeUser,
  }) => {
    // `skill:admin` widens reading, not publishing: the access check passes,
    // and the publishability check still insists the publisher be the author.
    const agent = await makeAgent({ organizationId });
    const colleague = await makeUser();
    const theirs = await makeSkill({
      scope: "personal",
      authorId: colleague.id,
    });
    await promoteCallerToSkillAdmin();

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [theirs.id] },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toMatch(/by its author/i);
  });

  test("PUT surfaces unpublishable skills as a 422 with the reason", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const templated = await makeSkill({ templated: true });
    const badName = await makeSkill({ name: "My Skill" });

    const templatedResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [templated.id] },
    });
    expect(templatedResponse.statusCode).toBe(422);
    expect(templatedResponse.json().error.message).toMatch(/templated/i);

    const badNameResponse = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [badName.id] },
    });
    expect(badNameResponse.statusCode).toBe(422);
    expect(badNameResponse.json().error.message).toMatch(/Agent Skills/);
  });

  // Skills are published as `skill://` resources to the client holding a
  // gateway's token, so MCP gateways are the only publishing surface: an LLM
  // proxy has no MCP surface at all, and an internal agent reaches skills
  // through `load_skill` in its own runtime. Rejected rather than stored, so
  // the editor and the API agree on where the section exists.
  for (const agentType of ["llm_proxy", "agent"] as const) {
    test(`PUT rejects a ${agentType}, which is not a publishing surface`, async ({
      makeAgent,
    }) => {
      const nonGateway = await makeAgent({ organizationId, agentType });
      const skill = await makeSkill();

      const assignments = await app.inject({
        method: "PUT",
        url: `/api/agents/${nonGateway.id}/skills`,
        payload: { accessAllSkills: false, skillIds: [skill.id] },
      });
      expect(assignments.statusCode).toBe(400);
      expect(assignments.json().error.message).toMatch(/MCP gateways only/i);

      const exclusions = await app.inject({
        method: "PUT",
        url: `/api/agents/${nonGateway.id}/skill-exclusions`,
        payload: { excludedSkillIds: [skill.id] },
      });
      expect(exclusions.statusCode).toBe(400);
    });
  }

  test("GET omits soft-deleted skills, so its result always round-trips through PUT", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const kept = await makeSkill();
    const deleted = await makeSkill();

    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: {
        accessAllSkills: false,
        skillIds: [kept.id, deleted.id].sort(),
      },
    });
    await SkillModel.delete(deleted.id);

    // The deleted id must not come back: `findByIds` filters deleted rows, so
    // a PUT echoing a GET that still contained it would 404.
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(getResponse.json()).toMatchObject({
      accessAllSkills: false,
      skillIds: [kept.id],
      skills: [{ id: kept.id, name: kept.name }],
    });

    const roundTrip = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: getResponse.json(),
    });
    expect(roundTrip.statusCode).toBe(200);
  });

  test("an unrelated replace leaves a soft-deleted skill's assignment alone", async ({
    makeAgent,
  }) => {
    // The GET hides a soft-deleted skill, so no PUT an admin can write carries
    // its id. If the replace deleted by agent alone it would drop that row too,
    // and restoring the skill from trash would silently UN-publish it — a
    // change no audit diff records, because the row is in neither snapshot.
    const agent = await makeAgent({ organizationId });
    const kept = await makeSkill();
    const trashed = await makeSkill();

    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: {
        accessAllSkills: false,
        skillIds: [kept.id, trashed.id].sort(),
      },
    });
    await SkillModel.delete(trashed.id);

    // An unrelated edit: the admin drops the one assignment they can still see.
    const unrelated = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [] },
    });
    expect(unrelated.statusCode).toBe(200);
    expect(unrelated.json()).toMatchObject({ skillIds: [] });

    await SkillModel.restore(trashed.id);

    const restored = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(restored.json()).toMatchObject({ skillIds: [trashed.id] });
  });

  test("GET keeps an assignment whose skill later left the environment", async ({
    makeAgent,
  }) => {
    // The gateway stops SERVING such a skill, but the assignment is still
    // configuration the admin chose. Dropping it from the GET would be
    // destructive rather than cosmetic: the response is the PUT body, and PUT
    // is a full replace, so the next save would delete an assignment nobody
    // touched.
    const production = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const staging = await EnvironmentModel.create({
      organizationId,
      name: "staging",
    });
    const agent = await makeAgent({
      organizationId,
      environmentId: production.id,
    });
    const skill = await makeSkill({}, [production.id]);

    const assigned = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [skill.id] },
    });
    expect(assigned.statusCode).toBe(200);

    // The skill is rebound to another environment out from under the gateway.
    await SkillModel.updateWithFiles({
      id: skill.id,
      skill: { description: skill.description },
      environmentIds: [staging.id],
    });

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    expect(getResponse.json()).toMatchObject({
      skillIds: [skill.id],
      skills: [{ id: skill.id, name: skill.name }],
    });
  });

  test("PUT rejects a skill outside the gateway's environment with a 422", async ({
    makeAgent,
  }) => {
    const production = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const staging = await EnvironmentModel.create({
      organizationId,
      name: "staging",
    });
    const agent = await makeAgent({
      organizationId,
      environmentId: production.id,
    });
    const stagingSkill = await makeSkill({}, [staging.id]);
    const productionSkill = await makeSkill({}, [production.id]);

    const rejected = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [stagingSkill.id] },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.message).toMatch(/environment/i);

    const accepted = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [productionSkill.id] },
    });
    expect(accepted.statusCode).toBe(200);
  });

  test("PUT keeps a stored assignment whose skill left the environment, gating only new adds", async ({
    makeAgent,
  }) => {
    // The publishability gates judge ids being ADDED, never the echoed stored
    // set — otherwise this drifted entry would wedge every later save until
    // someone hunted it down and removed it.
    const production = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const staging = await EnvironmentModel.create({
      organizationId,
      name: "staging",
    });
    const agent = await makeAgent({
      organizationId,
      environmentId: production.id,
    });
    const rebound = await makeSkill({}, [production.id]);

    await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [rebound.id] },
    });
    await SkillModel.updateWithFiles({
      id: rebound.id,
      skill: { description: rebound.description },
      environmentIds: [staging.id],
    });

    // The GET body stays a valid PUT body after the drift.
    const getResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${agent.id}/skills`,
    });
    const roundTrip = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: getResponse.json(),
    });
    expect(roundTrip.statusCode).toBe(200);

    // Unrelated edits keep working alongside the drifted entry.
    const added = await makeSkill({}, [production.id]);
    const grow = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: {
        accessAllSkills: false,
        skillIds: [rebound.id, added.id].sort(),
      },
    });
    expect(grow.statusCode).toBe(200);
    expect(grow.json()).toMatchObject({
      skillIds: [rebound.id, added.id].sort(),
    });

    // Only stored entries are exempt: a NEW out-of-environment skill still 422s.
    const fresh = await makeSkill({}, [staging.id]);
    const rejected = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: {
        accessAllSkills: false,
        skillIds: [rebound.id, added.id, fresh.id].sort(),
      },
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error.message).toMatch(/environment/i);
  });

  test("PUT by another editor keeps a stored personal skill it could not itself publish", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    // Author A publishes their personal skill; editor B later grows the set.
    // B could never ADD A's skill — 404 unreadable, or 422 as a skill admin —
    // but re-echoing it must not wedge B's otherwise-valid save into silently
    // unpublishing A's skill.
    const agent = await makeAgent({ organizationId });
    const theirs = await makeSkill({ scope: "personal", authorId: user.id });
    const seeded = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [theirs.id] },
    });
    expect(seeded.statusCode).toBe(200);

    const editor = await makeUser();
    await makeMember(editor.id, organizationId);
    user = editor;

    const orgSkill = await makeSkill();
    const grow = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: {
        accessAllSkills: false,
        skillIds: [theirs.id, orgSkill.id].sort(),
      },
    });
    expect(grow.statusCode).toBe(200);
    expect(grow.json()).toMatchObject({
      skillIds: [theirs.id, orgSkill.id].sort(),
    });

    // Same for a skill admin, whom the author-only gate would otherwise 422.
    await promoteCallerToSkillAdmin();
    const another = await makeSkill();
    const adminGrow = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: {
        accessAllSkills: false,
        skillIds: [theirs.id, orgSkill.id, another.id].sort(),
      },
    });
    expect(adminGrow.statusCode).toBe(200);
  });

  test("PUT writes an agent.updated audit record capturing the published set", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const skill = await makeSkill();

    const response = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}/skills`,
      payload: { accessAllSkills: false, skillIds: [skill.id] },
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

    // Publishing a skill to every holder of this gateway's token is exactly
    // the admin action the audit log must show — a skillIds-only change must
    // never diff as empty.
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].before).toMatchObject({ skillIds: [] });
    expect(auditRows[0].after).toMatchObject({ skillIds: [skill.id] });
  });
});
