// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import type { Resource } from "@archestra/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { userHasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import AgentTeamModel from "@/models/agent-team";
import AgentUserModel from "@/models/agent-user";
import AppAccessModel from "@/models/app-access";
import McpCatalogTeamModel from "@/models/mcp-catalog-team";
import MemberModel from "@/models/member";
import OrganizationModel from "@/models/organization";
import SkillTeamModel from "@/models/skill-team";
import SkillUserModel from "@/models/skill-user";
import TeamModel from "@/models/team";
import {
  assertCanAssignEnvironment,
  createEnvironment,
} from "@/services/environments/environment";
import { describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

/**
 * What the upgrade owes: nobody loses access, and nobody gains any beyond the
 * one deliberate widening named below.
 *
 * The conversion is judged by asking, for every principal against every
 * resource, once what the visibility fields answered before the upgrade and
 * again what the real authorization paths answer after it. The runtime no
 * longer reads visibility fields for single-object checks, so the "before"
 * answer comes from `legacyVisible`, a frozen copy of the rules those checks
 * applied: a role `admin` action saw everything, an org-scoped object was
 * everyone's, a personal one its author's and the people it was shared with
 * by name, and a team-scoped one belonged to members of its assigned teams. The two answers have to match exactly, save for
 * that widening. Any other differing cell is a person who woke up able to
 * read something they could not read yesterday, or locked out of something
 * they own.
 *
 * The fixtures are deliberately awkward: resources shared with nobody, with
 * one team, with two teams, with named people, and with the whole
 * organization; a creator, a teammate, someone in a different team, someone in
 * none, an organization admin, and a role that withholds the read action
 * entirely. The last one is the case a grant to "everyone" breaks: every
 * stored grant is widened to the nearest preset, so the organization-wide
 * `use` on an organization-wide agent becomes the `use` preset [read, use],
 * and that role now finds the agent it could only chat with before. That is
 * the one deliberate widening this matrix allows.
 */
describe("upgrade access preservation", () => {
  test("every principal keeps exactly the access it had, save the widening to the use preset", async ({
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
    removeObjectPolicies,
  }) => {
    // Seed the world as it stands before the upgrade. Nothing has converted
    // this deployment yet: once seeding is done the policies creation wrote
    // are removed, so every check below answers from the visibility columns,
    // exactly as it does on a deployment that has not taken the upgrade.
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
    // A role that withholds every read action: everything is invisible to it
    // before the upgrade, and it stays invisible afterwards except for the
    // organization-wide agent, which the widening to the `use` preset lets it
    // read.
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
    await removeObjectPolicies(org.id);

    const principals = {
      creator,
      teammate,
      otherTeamMember,
      loner,
      admin,
      restricted,
    };

    const heldDeployToRestricted = async (userId: string) => {
      for (const resource of [
        "agent",
        "skill",
        "app",
        "mcpGateway",
        "mcpRegistry",
        "knowledgeSource",
      ] as const)
        if (
          await heldBeforeRetirement({
            userId,
            organizationId: org.id,
            resource,
            action: "deploy-to-restricted",
          })
        )
          return true;
      return false;
    };

    const snapshot = async () => {
      const rows: Record<string, boolean> = {};
      for (const [who, principal] of Object.entries(principals)) {
        // Callers compute this from the principal's own permissions, and the
        // conversion retires the action it reads, so it has to be recomputed
        // on each pass rather than pinned.
        const isAdminFor = async (resource: "agent" | "skill" | "app") =>
          heldBeforeRetirement({
            userId: principal.id,
            organizationId: org.id,
            resource,
            action: "admin",
          });
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
              converted
                ? await AgentTeamModel.userHasAgentAccess({
                    userId: principal.id,
                    agentId: agent.id,
                    isAgentAdmin: false,
                    action,
                  })
                : await legacyVisible({
                    isAdmin: await isAdminFor("agent"),
                    object: agent,
                    userId: principal.id,
                    teamIds: await junctionIds(
                      schema.agentTeamsTable,
                      "agentId",
                      "teamId",
                      agent.id,
                    ),
                    userIds: await junctionIds(
                      schema.agentUsersTable,
                      "agentId",
                      "userId",
                      agent.id,
                    ),
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
            converted
              ? await SkillTeamModel.userHasSkillAccess({
                  organizationId: org.id,
                  userId: principal.id,
                  skill,
                })
              : await legacyVisible({
                  isAdmin: await isAdminFor("skill"),
                  object: skill,
                  userId: principal.id,
                  teamIds: await junctionIds(
                    schema.skillTeamsTable,
                    "skillId",
                    "teamId",
                    skill.id,
                  ),
                  userIds: await junctionIds(
                    schema.skillUsersTable,
                    "skillId",
                    "userId",
                    skill.id,
                  ),
                }),
          );
        }
        for (const [what, catalog] of Object.entries(catalogs)) {
          rows[`catalog:${what}:${who}`] = await reachable(
            "mcpRegistry",
            converted
              ? await McpCatalogTeamModel.userHasCatalogAccess({
                  userId: principal.id,
                  catalogId: catalog.id,
                  organizationId: org.id,
                })
              : await legacyVisible({
                  isAdmin: await heldBeforeRetirement({
                    userId: principal.id,
                    organizationId: org.id,
                    resource: "mcpServerInstallation",
                    action: "admin",
                  }),
                  object: catalog,
                  userId: principal.id,
                  teamIds: await junctionIds(
                    schema.mcpCatalogTeamsTable,
                    "catalogId",
                    "teamId",
                    catalog.id,
                  ),
                  userIds: [],
                }),
          );
        }
        rows[`app:${who}`] = await reachable(
          "app",
          converted
            ? await AppAccessModel.userHasAppAccess({
                organizationId: org.id,
                userId: principal.id,
                app,
              })
            : await legacyVisible({
                isAdmin: await isAdminFor("app"),
                object: app,
                userId: principal.id,
                teamIds: [],
                userIds: [],
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
        // Deploying into a restricted environment. Before the conversion the
        // retired `deploy-to-restricted` role action IS the answer — holding
        // it on any one of the six kinds of deployable object was enough, and
        // an open environment was open to all. Afterwards the environment
        // grant is, asked through the real gate. A mismatch here is somebody
        // who gained or lost the ability to deploy.
        for (const [what, environmentId, restricted] of [
          ["open", openEnvironment.id, false],
          ["restricted", restrictedEnvironment.id, true],
          ["default", null, true],
        ] as const) {
          rows[`deploy:${what}:${who}`] = converted
            ? await assertCanAssignEnvironment({
                environmentId,
                organizationId: org.id,
                userId: principal.id,
              }).then(
                () => true,
                () => false,
              )
            : !restricted || (await heldDeployToRestricted(principal.id));
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
    // The deliberate widening to the nearest preset: the organization's `use`
    // on the organization-wide agent becomes [read, use], so the role that
    // withholds every read action now reads and lists that one agent.
    // Nothing else may move.
    expect(changed.map((k) => `${k}: ${before[k]} -> ${after[k]}`)).toEqual([
      "agent:orgWide:restricted:read: false -> true",
      "agentList:orgWide:restricted: false -> true",
    ]);

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
      heldBeforeRetirement({
        userId,
        organizationId: org.id,
        resource,
        action: "deploy-to-restricted",
      });
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

/**
 * The single-object visibility rules the runtime applied before the upgrade,
 * frozen here so the "before" pass does not depend on code the upgrade
 * removed.
 */
async function legacyVisible(params: {
  isAdmin: boolean;
  object: { scope: string; authorId: string | null };
  userId: string;
  teamIds: string[];
  userIds: string[];
}): Promise<boolean> {
  if (params.isAdmin) return true;
  switch (params.object.scope) {
    case "org":
      return true;
    case "personal":
      return (
        params.object.authorId === params.userId ||
        params.userIds.includes(params.userId)
      );
    case "team": {
      const userTeamIds = await TeamModel.getUserTeamIds(params.userId);
      return params.teamIds.some((teamId) => userTeamIds.includes(teamId));
    }
    default:
      return false;
  }
}

/** One side of a junction table, for the object on the other side. */
async function junctionIds<
  T extends
    | typeof schema.agentTeamsTable
    | typeof schema.agentUsersTable
    | typeof schema.skillTeamsTable
    | typeof schema.skillUsersTable
    | typeof schema.mcpCatalogTeamsTable,
>(
  table: T,
  objectColumn: string,
  valueColumn: string,
  objectId: string,
): Promise<string[]> {
  const columns = table as unknown as Record<string, AnyPgColumn>;
  const rows = await db
    .select({ value: columns[valueColumn] })
    .from(table as unknown as typeof schema.agentTeamsTable)
    .where(eq(columns[objectColumn], objectId));
  return rows.map((row) => String(row.value));
}

/**
 * Whether a principal held a now-retired role action before the upgrade, the
 * way the old call sites asked. A custom role still stores it until the
 * conversion strips it; a built-in role held it in code, which no longer
 * carries it, so the built-ins' historical sets are written out here.
 */
async function heldBeforeRetirement(params: {
  userId: string;
  organizationId: string;
  resource: Resource;
  action: "admin" | "deploy-to-restricted";
}): Promise<boolean> {
  const member = await MemberModel.getByUserId(
    params.userId,
    params.organizationId,
  );
  const roles = member?.role.split(",") ?? [];
  const DEPLOYABLE = [
    "agent",
    "skill",
    "app",
    "mcpGateway",
    "mcpRegistry",
    "knowledgeSource",
  ];
  const builtIn = roles.some((role) => {
    if (role === "admin") return true;
    if (role === "platform_admin")
      return !(
        params.action === "admin" &&
        (params.resource === "log" || params.resource === "auditLog")
      );
    if (role === "editor")
      return (
        params.action === "deploy-to-restricted" &&
        DEPLOYABLE.includes(params.resource)
      );
    return false;
  });
  if (builtIn) return true;
  // A custom role's stored JSON, read as stored: the current vocabulary
  // filters a retired action out, which is the point of retiring it.
  const custom = await db
    .select({ permission: schema.organizationRolesTable.permission })
    .from(schema.organizationRolesTable)
    .where(
      and(
        eq(schema.organizationRolesTable.organizationId, params.organizationId),
        inArray(schema.organizationRolesTable.role, roles),
      ),
    );
  return custom.some((row) =>
    (
      (JSON.parse(row.permission) as Record<string, string[]>)[
        params.resource
      ] ?? []
    ).includes(params.action),
  );
}
