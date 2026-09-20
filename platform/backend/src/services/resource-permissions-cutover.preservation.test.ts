// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth/utils";
import config from "@/config";
import AgentTeamModel from "@/models/agent-team";
import AgentUserModel from "@/models/agent-user";
import AppAccessModel from "@/models/app-access";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import SkillTeamModel from "@/models/skill-team";
import SkillUserModel from "@/models/skill-user";
import { afterEach, describe, expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

/**
 * What the upgrade owes: nobody gains or loses access.
 *
 * The conversion is judged the only way that means anything — by asking the
 * real authorization paths, for every principal against every resource, once
 * while the deployment still answers from visibility fields and again after
 * the conversion has run. The two answers have to match exactly. A single
 * differing cell is a person who woke up able to read something they could
 * not read yesterday, or locked out of something they own.
 *
 * The fixtures are deliberately awkward: resources shared with nobody, with
 * one team, with two teams, with named people, and with the whole
 * organization; a creator, a teammate, someone in a different team, someone in
 * none, an organization admin, and a role that withholds the read action
 * entirely. The last one is the case a grant to "everyone" would have broken.
 */
describe("upgrade access preservation", () => {
  afterEach(() => {
    config.resourcePermissions.enabled = true;
  });

  test("every principal keeps exactly the access it had", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeTeam,
    makeTeamMember,
    makeCustomRole,
    makeAgent,
    makeApp,
    makeInternalMcpCatalog,
  }) => {
    // Seed the world as it stands before the upgrade.
    config.resourcePermissions.enabled = false;
    const org = await makeOrganization({ legacyPermissions: true });

    const creator = await makeUser();
    const teammate = await makeUser();
    const otherTeamMember = await makeUser();
    const loner = await makeUser();
    const admin = await makeUser();
    const restricted = await makeUser();
    await makeMember(creator.id, org.id);
    await makeMember(teammate.id, org.id);
    await makeMember(otherTeamMember.id, org.id);
    await makeMember(loner.id, org.id);
    await makeMember(admin.id, org.id, { role: "admin" });
    // A role that withholds every read action: invisible to it before the
    // upgrade, and it must stay invisible afterwards.
    const blindRole = await makeCustomRole(org.id, { permission: {} });
    await makeMember(restricted.id, org.id, { role: blindRole.role });

    const teamA = await makeTeam(org.id, creator.id);
    const teamB = await makeTeam(org.id, creator.id);
    await makeTeamMember(teamA.id, teammate.id);
    await makeTeamMember(teamB.id, otherTeamMember.id);

    const agents = {
      personal: await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        scope: "personal",
        authorId: creator.id,
      }),
      shared: await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        scope: "personal",
        authorId: creator.id,
      }),
      oneTeam: await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        scope: "team",
        authorId: creator.id,
      }),
      twoTeams: await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        scope: "team",
        authorId: creator.id,
      }),
      orgWide: await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        scope: "org",
        authorId: creator.id,
      }),
      // Shared with nobody at all: a team scope with an empty team list.
      strandedTeam: await makeAgent({
        organizationId: org.id,
        agentType: "agent",
        scope: "team",
        authorId: creator.id,
      }),
    };
    await AgentUserModel.syncAgentUsers(agents.shared.id, [
      { id: loner.id, level: "use" },
    ]);
    await AgentTeamModel.syncAgentTeams(agents.oneTeam.id, [teamA.id]);
    await AgentTeamModel.syncAgentTeams(agents.twoTeams.id, [
      teamA.id,
      teamB.id,
    ]);

    const skills = {
      personal: await seedSkill(org.id, creator.id, "personal"),
      shared: await seedSkill(org.id, creator.id, "personal"),
      team: await seedSkill(org.id, creator.id, "team"),
      orgWide: await seedSkill(org.id, creator.id, "org"),
    };
    await SkillUserModel.syncSkillUsers(skills.shared.id, [loner.id]);
    await SkillTeamModel.syncSkillTeams(skills.team.id, [teamA.id]);

    const catalogs = {
      personal: await makeInternalMcpCatalog({
        organizationId: org.id,
        authorId: creator.id,
        scope: "personal",
      }),
      team: await makeInternalMcpCatalog({
        organizationId: org.id,
        authorId: creator.id,
        scope: "team",
      }),
      orgWide: await makeInternalMcpCatalog({
        organizationId: org.id,
        authorId: creator.id,
        scope: "org",
      }),
    };
    await McpCatalogTeamModel.syncCatalogTeams(catalogs.team.id, [
      { id: teamA.id, level: "write" },
    ]);

    const app = await makeApp({
      organizationId: org.id,
      authorId: creator.id,
      scope: "org",
      enabled: true,
    });

    const principals = {
      creator,
      teammate,
      otherTeamMember,
      loner,
      admin,
      restricted,
    };

    const snapshot = async () => {
      const rows: Record<string, boolean> = {};
      for (const [who, principal] of Object.entries(principals)) {
        // Callers compute this from the principal's own permissions, and the
        // conversion retires the action it reads, so it has to be recomputed
        // on each pass rather than pinned.
        const isAdminFor = async (resource: "agent" | "skill" | "app") =>
          userHasPermission(principal.id, org.id, resource, "admin");
        // Reaching a resource takes two gates, and only one of them lives in
        // these models. The route asks for the resource-wide read action while
        // the deployment still answers from visibility fields, and stops
        // asking once an object grant decides instead — see
        // `legacyEndpointPermissionsMap`. Folding it in here is what makes the
        // two passes comparable: otherwise a role that was refused at the door
        // looks like a role that lost access.
        const reachable = async (
          resource: "agent" | "skill" | "app" | "mcpRegistry",
          allowed: boolean,
        ) =>
          allowed &&
          (config.resourcePermissions.enabled ||
            (await userHasPermission(principal.id, org.id, resource, "read")));
        for (const [what, agent] of Object.entries(agents)) {
          for (const action of ["read", "use"] as const) {
            rows[`agent:${what}:${who}:${action}`] = await reachable(
              "agent",
              await AgentTeamModel.userHasAgentAccess({
                userId: principal.id,
                agentId: agent.id,
                isAgentAdmin: await isAdminFor("agent"),
                action,
              }),
            );
          }
        }
        for (const [what, skill] of Object.entries(skills)) {
          rows[`skill:${what}:${who}`] = await reachable(
            "skill",
            await SkillTeamModel.userHasSkillAccess({
              organizationId: org.id,
              userId: principal.id,
              skill,
              isSkillAdmin: await isAdminFor("skill"),
            }),
          );
        }
        for (const [what, catalog] of Object.entries(catalogs)) {
          rows[`catalog:${what}:${who}`] = await reachable(
            "mcpRegistry",
            await McpCatalogTeamModel.userHasCatalogAccess({
              userId: principal.id,
              catalogId: catalog.id,
              isAdmin: await userHasPermission(
                principal.id,
                org.id,
                "mcpServerInstallation",
                "admin",
              ),
              organizationId: org.id,
            }),
          );
        }
        rows[`app:${who}`] = await reachable(
          "app",
          await AppAccessModel.userHasAppAccess({
            organizationId: org.id,
            userId: principal.id,
            app,
            isAppAdmin: await isAdminFor("app"),
          }),
        );
        // List filtering has its own query, so a matching single check is not
        // enough: a resource missing from the list is just as inaccessible.
        const listed = await AgentTeamModel.getUserAccessibleAgentIds(
          principal.id,
          await isAdminFor("agent"),
        );
        for (const [what, agent] of Object.entries(agents)) {
          rows[`agentList:${what}:${who}`] = await reachable(
            "agent",
            listed.includes(agent.id),
          );
        }
      }
      return rows;
    };

    const before = await snapshot();
    // The seeded world is not uniformly permissive, or the comparison below
    // would prove nothing.
    expect(Object.values(before).filter(Boolean).length).toBeGreaterThan(0);
    expect(
      Object.values(before).filter((value) => !value).length,
    ).toBeGreaterThan(0);
    expect(before["agent:personal:loner:read"]).toBe(false);
    expect(before["agent:oneTeam:teammate:read"]).toBe(true);
    expect(before["agent:strandedTeam:teammate:read"]).toBe(false);
    expect(before["skill:personal:teammate"]).toBe(false);
    expect(before["catalog:personal:loner"]).toBe(false);

    config.resourcePermissions.enabled = true;
    await runScopedResourcePermissionCutover();

    const after = await snapshot();
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed.map((k) => `${k}: ${before[k]} -> ${after[k]}`)).toEqual([]);
  });
});

async function seedSkill(
  organizationId: string,
  authorId: string,
  scope: "personal" | "team" | "org",
) {
  const { default: SkillModel } = await import("@/models/skill");
  const skill = await SkillModel.createWithFiles({
    skill: {
      organizationId,
      authorId,
      name: `preserve-${crypto.randomUUID().slice(0, 8)}`,
      description: "Seeded for the preservation matrix",
      content: "# Instructions",
      sourceType: "manual",
      scope,
    },
    files: [],
  });
  if (!skill) throw new Error("failed to seed skill");
  return skill;
}
