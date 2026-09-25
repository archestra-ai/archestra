// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import projectRoutes from "./project.routes";

const AUTHOR_ACTIONS = [
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
];

describe("scoped project grants", () => {
  const ctx = useRouteTestApp(projectRoutes);

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("shares a project with a team at creation", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const member = await makeUser();
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await makeTeamMember(team.id, member.id);
    const outsider = await makeUser();
    await makeMember(outsider.id, ctx.organizationId);

    const grants = [
      {
        subject: { type: "team" as const, id: team.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Shared at creation", initialGrants: grants },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;

    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: ctx.organizationId,
          resource: "project",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      { subject: { type: "user", id: ctx.user.id }, actions: AUTHOR_ACTIONS },
    ]);

    const scoped = {
      organizationId: ctx.organizationId,
      resource: "project" as const,
      scope: id,
    };
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: member.id,
        })
      ).grants.map((grant) => grant.action),
    ).toEqual(["read", "use"]);
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: outsider.id,
        })
      ).grants,
    ).toEqual([]);
  });

  test("a project created without grants reaches its owner alone", async ({
    makeMember,
    makeUser,
  }) => {
    const outsider = await makeUser();
    await makeMember(outsider.id, ctx.organizationId);

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Mine alone" },
    });
    expect(response.statusCode, response.body).toBe(200);
    const scoped = {
      organizationId: ctx.organizationId,
      resource: "project" as const,
      scope: response.json().id,
    };
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: ctx.user.id,
        })
      ).grants.map((grant) => grant.action),
    ).toEqual(expect.arrayContaining(AUTHOR_ACTIONS));
    expect(
      (
        await ResourcePermissions.getEffective({
          ...scoped,
          userId: outsider.id,
        })
      ).grants,
    ).toEqual([]);
  });
});
