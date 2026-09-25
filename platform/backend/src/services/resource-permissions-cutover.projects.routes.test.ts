// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { TestAPI } from "vitest";
import ProjectModel from "@/models/project";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import projectRoutes from "@/routes/project/project.routes";
import resourcePermissionRoutes from "@/routes/resource-permission/resource-permission.routes";
import { describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import { seedLegacyShareForTest } from "@/test/sharing";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

type Fixtures = Pick<
  typeof test extends TestAPI<infer Context> ? Context : never,
  | "makeOrganization"
  | "makeUser"
  | "makeMember"
  | "makeCustomRole"
  | "makeTeam"
  | "makeTeamMember"
  | "removeObjectPolicies"
>;

/**
 * Projects after the upgrade, through the real HTTP routes. The world is
 * seeded as it stood before the upgrade: sharing in the retired project share
 * rows, and no object policy. It is converted once.
 *
 * The rules before the upgrade:
 * - The owner, the people a project was shared with, and `project:admin`
 *   holders could open it. Anybody else got 404.
 * - Only the owner and `project:admin` holders could edit, share or delete it.
 * - A share to or from the whole organization, and deleting an organization
 *   project, also needed `project:share-org`. The Member and Editor roles held
 *   it, so every owner below passes that gate.
 * - A role without `project:read` was stopped at every route.
 *
 * The sharing route itself is replaced by the permissions API, so a refused
 * save now reads 403 where the old share route read 404. The decision is the
 * same.
 */
describe("project routes after the upgrade", () => {
  test("reads, edits and permission saves match the rules before the upgrade", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    removeObjectPolicies,
  }) => {
    const world = await seedLegacyProjects({
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeTeam,
      makeTeamMember,
      removeObjectPolicies,
    });
    const app = await routesAs(world.organizationId);

    // [read, edit, save permissions] for each principal.
    const expected: Record<ProjectName, Record<PrincipalName, Statuses>> = {
      personal: {
        admin: [200, 200, 200],
        owner: [200, 200, 200],
        teammate: [404, 404, 403],
        outsider: [404, 404, 403],
        named: [404, 404, 403],
        blind: [403, 403, 403],
      },
      team: {
        admin: [200, 200, 200],
        owner: [200, 200, 200],
        teammate: [200, 404, 403],
        outsider: [404, 404, 403],
        named: [404, 404, 403],
        blind: [403, 403, 403],
      },
      organization: {
        admin: [200, 200, 200],
        owner: [200, 200, 200],
        teammate: [200, 404, 403],
        outsider: [200, 404, 403],
        named: [200, 404, 403],
        blind: [403, 403, 403],
      },
      named: {
        admin: [200, 200, 200],
        owner: [200, 200, 200],
        teammate: [404, 404, 403],
        outsider: [404, 404, 403],
        named: [200, 404, 403],
        blind: [403, 403, 403],
      },
    };

    const actual: Record<string, Record<string, Statuses>> = {};
    for (const [name, projectId] of Object.entries(world.projects)) {
      actual[name] = {};
      for (const [who, user] of Object.entries(world.principals)) {
        actual[name][who] = await readEditSave({
          app,
          userId: user.id,
          organizationId: world.organizationId,
          projectId,
        });
      }
    }
    await app.close();
    expect(actual).toEqual(expected);
  });

  test("deletes match the rules before the upgrade", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeTeam,
    makeTeamMember,
    removeObjectPolicies,
  }) => {
    const fixtures = {
      makeOrganization,
      makeUser,
      makeMember,
      makeCustomRole,
      makeTeam,
      makeTeamMember,
      removeObjectPolicies,
    };
    const expected: Record<PrincipalName, Record<ProjectName, number>> = {
      admin: { personal: 200, team: 200, organization: 200, named: 200 },
      owner: { personal: 200, team: 200, organization: 200, named: 200 },
      teammate: { personal: 404, team: 404, organization: 404, named: 404 },
      outsider: { personal: 404, team: 404, organization: 404, named: 404 },
      named: { personal: 404, team: 404, organization: 404, named: 404 },
      blind: { personal: 403, team: 403, organization: 403, named: 403 },
    };

    // A delete that succeeds removes the project, so each principal gets a
    // world of its own.
    const actual: Record<string, Record<string, number>> = {};
    for (const who of Object.keys(expected) as PrincipalName[]) {
      const world = await seedLegacyProjects(fixtures);
      const app = await routesAs(world.organizationId);
      actual[who] = {};
      for (const [name, projectId] of Object.entries(world.projects)) {
        const response = await app.inject({
          method: "DELETE",
          url: `/api/projects/${projectId}`,
          headers: { [USER_HEADER]: world.principals[who].id },
        });
        actual[who][name] = response.statusCode;
      }
      await app.close();
    }
    expect(actual).toEqual(expected);
  });
});

// ===

type Statuses = [read: number, edit: number, savePermissions: number];
type World = Awaited<ReturnType<typeof seedLegacyProjects>>;
type ProjectName = keyof World["projects"];
type PrincipalName = keyof World["principals"];

/**
 * Four projects of one owner: unshared, shared with the owner's team, shared
 * with the organization, and shared with one named person. The owner is in
 * the team, so re-sharing with it passed the old team check.
 */
async function seedLegacyProjects(fx: Fixtures) {
  const org = await fx.makeOrganization({ legacyPermissions: true });
  const principals = {
    admin: await fx.makeUser(),
    owner: await fx.makeUser(),
    teammate: await fx.makeUser(),
    outsider: await fx.makeUser(),
    named: await fx.makeUser(),
    blind: await fx.makeUser(),
  };
  await fx.makeMember(principals.admin.id, org.id, { role: "admin" });
  for (const user of [
    principals.owner,
    principals.teammate,
    principals.outsider,
    principals.named,
  ]) {
    await fx.makeMember(user.id, org.id);
  }
  const blindRole = await fx.makeCustomRole(org.id, { permission: {} });
  await fx.makeMember(principals.blind.id, org.id, { role: blindRole.role });
  const team = await fx.makeTeam(org.id, principals.admin.id);
  const otherTeam = await fx.makeTeam(org.id, principals.admin.id);
  await fx.makeTeamMember(team.id, principals.owner.id);
  await fx.makeTeamMember(team.id, principals.teammate.id);
  await fx.makeTeamMember(otherTeam.id, principals.outsider.id);

  const create = (name: string) =>
    ProjectModel.create({
      organizationId: org.id,
      userId: principals.owner.id,
      name,
    });
  const personal = await create("Personal");
  const teamProject = await create("Team");
  const organization = await create("Organization");
  const named = await create("Named");
  const share = {
    organizationId: org.id,
    resource: "project" as const,
    createdByUserId: principals.owner.id,
  };
  await seedLegacyShareForTest({
    ...share,
    scope: teamProject.id,
    visibility: "team",
    teamIds: [team.id],
  });
  await seedLegacyShareForTest({
    ...share,
    scope: organization.id,
    visibility: "organization",
  });
  await seedLegacyShareForTest({
    ...share,
    scope: named.id,
    visibility: "user",
    userIds: [principals.named.id],
  });
  await fx.removeObjectPolicies(org.id);

  await runScopedResourcePermissionCutover();

  return {
    organizationId: org.id,
    principals,
    projects: {
      personal: personal.id,
      team: teamProject.id,
      organization: organization.id,
      named: named.id,
    },
  };
}

function routesAs(organizationId: string) {
  return authenticatedRouteApp({
    organizationId,
    routes: [projectRoutes, resourcePermissionRoutes],
  });
}

/**
 * Read the project, rename it, and save its permissions unchanged. The save
 * sends the grants the project already has, so it changes nothing, and it
 * still needs `manage-permissions`.
 */
async function readEditSave(params: {
  app: Awaited<ReturnType<typeof routesAs>>;
  userId: string;
  organizationId: string;
  projectId: string;
}) {
  const headers = { [USER_HEADER]: params.userId };
  const url = `/api/projects/${params.projectId}`;
  const read = await params.app.inject({ method: "GET", url, headers });
  const edit = await params.app.inject({
    method: "PATCH",
    url,
    headers,
    payload: { description: "Edited" },
  });
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: params.organizationId,
    resource: "project",
    scope: params.projectId,
  });
  const share = await params.app.inject({
    method: "PUT",
    url: `/api/resource-permissions/project/${params.projectId}`,
    headers,
    payload: { revision: policy?.revision ?? 0, grants: policy?.grants ?? [] },
  });
  return [read.statusCode, edit.statusCode, share.statusCode] as Statuses;
}
