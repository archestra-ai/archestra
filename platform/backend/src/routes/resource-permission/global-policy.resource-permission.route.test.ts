// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import TeamModel from "@/models/team";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import resourcePermissionRoutes from "./resource-permission.routes";

describe("access policy role controls", () => {
  const ctx = useRouteTestApp(resourcePermissionRoutes);
  const url = "/api/resource-permissions/agent/*";

  const cases: Record<string, string[]>[] = [
    { agent: ["read", "create", "update", "delete"] },
    { accessPolicies: ["read"] },
    { accessPolicies: ["update"] },
  ];
  for (const permission of cases) {
    test(`enforces policy access independently of resource CRUD: ${JSON.stringify(permission)}`, async ({
      makeCustomRole,
      makeMember,
    }) => {
      const role = await makeCustomRole(ctx.organizationId, { permission });
      await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: ctx.organizationId,
        resource: "agent",
        scope: "*",
      });
      // Even a wildcard scoped manager must have the global role action.
      await ResourcePermissionPolicyModel.replace({
        organizationId: ctx.organizationId,
        resource: "agent",
        scope: "*",
        revision: policy?.revision ?? 0,
        grants: [
          {
            subject: { type: "role", id: role.id },
            actions: ["read", "use", "update", "delete", "manage-permissions"],
          },
        ],
      });
      const policyActions = permission.accessPolicies ?? [];
      const read = await ctx.app.inject({ method: "GET", url });
      expect(read.statusCode).toBe(policyActions.length ? 200 : 403);
      const saved = await ctx.app.inject({
        method: "PUT",
        url,
        // Keeps a Full access recipient: a save leaving none is refused.
        payload: {
          revision: (policy?.revision ?? 0) + 1,
          grants: [
            {
              subject: { type: "role", id: role.id },
              actions: [
                "read",
                "use",
                "update",
                "delete",
                "manage-permissions",
              ],
            },
          ],
        },
      });
      expect(saved.statusCode).toBe(
        policyActions.includes("update") ? 200 : 403,
      );
      const subjects = await ctx.app.inject({
        method: "GET",
        url: `${url}/subjects`,
      });
      expect(subjects.statusCode).toBe(
        policyActions.includes("update") ? 200 : 403,
      );
    });
  }

  test("access policy managers can grant access they do not personally hold without gaining resource access", async ({
    makeCustomRole,
    makeMember,
    makeUser,
  }) => {
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { accessPolicies: ["read", "update"] },
    });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    const recipient = await makeUser();
    await makeMember(recipient.id, ctx.organizationId);
    for (const resource of ["agent", "mcpRegistry"] as const) {
      const policy = await ResourcePermissionPolicyModel.find({
        organizationId: ctx.organizationId,
        resource,
        scope: "*",
      });
      const saved = await ctx.app.inject({
        method: "PUT",
        url: `/api/resource-permissions/${resource}/*`,
        payload: {
          revision: policy?.revision ?? 0,
          grants: [
            {
              subject: { type: "user", id: recipient.id },
              actions: [
                "read",
                "use",
                "update",
                "delete",
                "manage-permissions",
              ],
            },
          ],
        },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(
        await userHasPermission(
          ctx.user.id,
          ctx.organizationId,
          resource,
          "read",
        ),
      ).toBe(false);
    }
    // DB-fresh authorization notices a revoked assignment immediately.
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, "member");
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(403);
  });

  test("inherited team roles grant global management only within their organization", async ({
    makeCustomRole,
    makeMember,
    makeTeam,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const parent = await makeTeam(ctx.organizationId, ctx.user.id);
    const child = await makeTeam(ctx.organizationId, ctx.user.id, {
      parentId: parent.id,
    });
    const role = await makeCustomRole(ctx.organizationId, {
      permission: { accessPolicies: ["update"] },
    });
    await TeamModel.update(parent.id, { roles: [role.role] });
    await TeamModel.addMember(child.id, ctx.user.id);
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(200);
    ctx.organizationId = (await makeOrganization()).id;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    expect((await ctx.app.inject({ method: "GET", url })).statusCode).toBe(403);
  });

  test("log policy endpoints are retired even for administrators", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    for (const resource of ["log", "auditLog"]) {
      expect(
        (
          await ctx.app.inject({
            method: "GET",
            url: `/api/resource-permissions/${resource}/*`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await ctx.app.inject({
            method: "PUT",
            url: `/api/resource-permissions/${resource}/*`,
            payload: { revision: 0, grants: [] },
          })
        ).statusCode,
      ).toBe(400);
    }
  });
});
