// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import AgentTeamModel from "@/models/agent-team";
import AgentUserModel from "@/models/agent-user";
import AppAccessModel from "@/models/app-access";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import OrganizationModel from "@/models/organization";
import SkillTeamModel from "@/models/skill-team";
import SkillUserModel from "@/models/skill-user";
import {
  assertCanAssignEnvironment,
  createEnvironment,
} from "@/services/environments/environment";
import { describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";
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
    makeServiceAccount,
  }) => {
    // Seed the world as it stands before the upgrade. Nothing has converted
    // this deployment yet, so `createInitial` writes no policy and every
    // check below answers from the visibility columns, exactly as it does on
    // a deployment that has not taken the upgrade.
    let converted = false;
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

    // Service accounts have no audience of their own: who reaches one was
    // decided by the caller's role actions alone. Two of them, so the matrix
    // cannot pass by accident on a single row.
    const serviceAccounts = {
      first: await makeServiceAccount(org.id, { createdBy: creator.id }),
      second: await makeServiceAccount(org.id, { createdBy: null }),
    };

    // Two environments and a restricted org default, so the deploy rows below
    // cover all three shapes the gate has: an open environment, a restricted
    // one, and the implicit Default.
    const openEnvironment = await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox" },
    });
    const restrictedEnvironment = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", restricted: true },
    });
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentRestricted: true,
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
          gate: "read" | "none" = "read",
        ) =>
          allowed &&
          (gate === "none" ||
            converted ||
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
              // Finding an agent went through a route that asked for the read
              // action. Working with one did not: chatting asked for chat
              // permissions, so a role built for chat and nothing else could
              // use an organization-wide agent it could not list.
              action === "use" ? "none" : "read",
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
        for (const [what, account] of Object.entries(serviceAccounts)) {
          for (const action of ["read", "update", "delete"] as const) {
            // Before the conversion the role action IS the answer — there is
            // no per-account model to ask. Afterwards the grant is, so the
            // two passes ask the two real authorization paths in turn.
            rows[`serviceAccount:${what}:${who}:${action}`] = converted
              ? await ResourcePermissions.allows({
                  organizationId: org.id,
                  userId: principal.id,
                  resource: "serviceAccount",
                  scope: account.id,
                  action,
                })
              : await userHasPermission(
                  principal.id,
                  org.id,
                  "serviceAccount",
                  action,
                );
          }
        }
        // Deploying into a restricted environment. The same call answers on
        // both passes — from the retired role action before the conversion and
        // from the environment grant after it — so a mismatch here is somebody
        // who gained or lost the ability to deploy.
        for (const [what, environmentId] of [
          ["open", openEnvironment.id],
          ["restricted", restrictedEnvironment.id],
          ["default", null],
        ] as const) {
          rows[`deploy:${what}:${who}`] = await assertCanAssignEnvironment({
            environmentId,
            organizationId: org.id,
            userId: principal.id,
          }).then(
            () => true,
            () => false,
          );
        }
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
    // Only the admin tiers carry any service-account action today.
    expect(before["serviceAccount:first:admin:delete"]).toBe(true);
    expect(before["serviceAccount:first:teammate:read"]).toBe(false);
    expect(before["serviceAccount:second:restricted:update"]).toBe(false);
    // Deploy authority before the conversion: only the admin tier held any
    // `deploy-to-restricted` action, and an open environment is open to all.
    expect(before["deploy:open:loner"]).toBe(true);
    expect(before["deploy:restricted:admin"]).toBe(true);
    expect(before["deploy:restricted:loner"]).toBe(false);
    expect(before["deploy:default:admin"]).toBe(true);
    expect(before["deploy:default:loner"]).toBe(false);

    await runScopedResourcePermissionCutover();
    converted = true;

    const after = await snapshot();
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed.map((k) => `${k}: ${before[k]} -> ${after[k]}`)).toEqual([]);

    // A second run must be a no-op down to the byte. `revision` is the token
    // the permissions editor holds while somebody is editing, so a statement
    // that rewrites an unchanged policy fails their save on every restart.
    const policiesBefore = await readPolicies();
    await runScopedResourcePermissionCutover();
    expect(await readPolicies()).toEqual(policiesBefore);
    expect(await snapshot()).toEqual(after);
  });

  /**
   * What the six-way split cost, stated in full.
   *
   * `deploy-to-restricted` was one action per kind of thing deployed, so a
   * role could be allowed to put an agent in a restricted environment and
   * refused an MCP server in the same one. `environment:use` asks about the
   * environment instead, and a policy key holds one resource and one scope —
   * there is no room for both axes. So the split does not survive.
   *
   * The consequences are asserted here rather than left to be discovered:
   *
   * - A holder of ALL six converts exactly. It could reach every restricted
   *   environment before and it still can.
   * - A holder of a STRICT SUBSET widens to the kinds it was refused. This is
   *   intended. The split is being retired deliberately, and in exchange an
   *   administrator can now say WHICH restricted environment a subject may
   *   deploy to, which the retired actions could never express.
   *
   * If this test fails because a partial holder no longer widens, do not
   * "fix" the assertion — someone has changed the upgrade rule, and the docs
   * and the conversion have to change with it.
   */
  test("the six-way split retires: a full holder converts exactly, a partial holder widens", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const restricted = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", restricted: true },
    });

    // Holds every one of the six, like the built-in Admin and Editor roles.
    const full = await makeUser();
    await makeMember(full.id, org.id, { role: "admin" });

    // Holds exactly one. Nothing built-in is shaped like this; it has to be
    // written by hand, which is why the widening is narrow in practice.
    const partial = await makeUser();
    const partialRole = await makeCustomRole(org.id, {
      permission: { agent: ["read", "deploy-to-restricted"] },
    });
    await makeMember(partial.id, org.id, { role: partialRole.role });

    // The historical rule, asked the way the old call sites asked it.
    const couldDeploy = (userId: string, resource: "agent" | "mcpRegistry") =>
      userHasPermission(userId, org.id, resource, "deploy-to-restricted");
    expect(await couldDeploy(full.id, "agent")).toBe(true);
    expect(await couldDeploy(full.id, "mcpRegistry")).toBe(true);
    expect(await couldDeploy(partial.id, "agent")).toBe(true);
    // The refusal that does not survive.
    expect(await couldDeploy(partial.id, "mcpRegistry")).toBe(false);

    await runScopedResourcePermissionCutover();

    const canDeploy = (userId: string) =>
      assertCanAssignEnvironment({
        environmentId: restricted.id,
        organizationId: org.id,
        userId,
      }).then(
        () => true,
        () => false,
      );
    // Exact for the full holder.
    expect(await canDeploy(full.id)).toBe(true);
    // Widened for the partial one, deliberately: it may now deploy an MCP
    // server into this restricted environment, which it could not before.
    expect(await canDeploy(partial.id)).toBe(true);

    // And nobody who held none of the six gains anything.
    const outsider = await makeUser();
    await makeMember(outsider.id, org.id, { role: "member" });
    expect(await canDeploy(outsider.id)).toBe(false);
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

/** Every stored policy verbatim, `revision` included. */
async function readPolicies() {
  const rows = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable)
    .orderBy(
      schema.resourcePermissionPoliciesTable.resource,
      schema.resourcePermissionPoliciesTable.scope,
    );
  return rows.map(({ updatedAt: _updatedAt, ...policy }) => policy);
}
