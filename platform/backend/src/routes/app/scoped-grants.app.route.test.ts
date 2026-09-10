// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AppModel from "@/models/app";
import AuditLogModel from "@/models/audit-log";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import { ResourcePermissions } from "@/services/resource-permissions";
import { beforeEach, describe, expect, test, useRouteTestApp } from "@/test";
import appRoutes from "./app.routes";

describe("scoped app grants", () => {
  const ctx = useRouteTestApp(appRoutes);
  beforeEach(async ({ makeMember, makeCustomRole }) => {
    const role = await makeCustomRole(ctx.organizationId, { permission: {} });
    await makeMember(ctx.user.id, ctx.organizationId, { role: role.role });
    registerAuditLogHook(ctx.app);
  });

  test("creates and audits service-account grants with the app", async () => {
    await MemberModel.updateRole(ctx.user.id, ctx.organizationId, "admin");
    const account = await ServiceAccountModel.create({
      organizationId: ctx.organizationId,
      name: "App automation",
      role: "member",
      createdBy: ctx.user.id,
    });
    const grants = [
      {
        subject: { type: "serviceAccount" as const, id: account.id },
        actions: ["read" as const, "use" as const],
      },
    ];
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Shared at creation",
        html: "<html><body>Example app</body></html>",
        initialGrants: grants,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json().id;
    expect(
      (
        await ResourcePermissionPolicyModel.find({
          organizationId: ctx.organizationId,
          resource: "app",
          scope: id,
        })
      )?.grants,
    ).toEqual([
      ...grants,
      {
        subject: { type: "user", id: ctx.user.id },
        actions: ["read", "use", "update", "delete", "manage-permissions"],
      },
    ]);
    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceId: id,
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({
            resourcePermissions: [
              ...grants,
              {
                subject: { type: "user", id: ctx.user.id },
                actions: [
                  "read",
                  "use",
                  "update",
                  "delete",
                  "manage-permissions",
                ],
              },
            ],
          }),
        }),
      ]),
    );
  });

  test("a shared app can be edited without exposing other apps, granting execution, or granting sharing", async ({
    makeApp,
    makeUser,
  }) => {
    const owner = await makeUser();
    const target = await makeApp({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      scope: "personal",
      enabled: true,
      name: "Shared app",
    });
    const other = await makeApp({
      organizationId: ctx.organizationId,
      authorId: owner.id,
      scope: "personal",
      enabled: true,
      name: "Other app",
    });
    const key = {
      organizationId: ctx.organizationId,
      resource: "app" as const,
      scope: target.id,
    };
    const grants = [
      {
        subject: { type: "user" as const, id: ctx.user.id },
        actions: ["read" as const, "update" as const],
      },
    ];
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants,
    });
    const listed = await ctx.app.inject({ method: "GET", url: "/api/apps" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().data.map((app: { id: string }) => app.id)).toEqual([
      target.id,
    ]);
    expect(
      (await ctx.app.inject({ method: "GET", url: `/api/apps/${other.id}` }))
        .statusCode,
    ).toBe(404);
    const changed = await ctx.app.inject({
      method: "PATCH",
      url: `/api/apps/${target.id}`,
      payload: { name: "Scoped edit" },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const audit = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceId: target.id,
      offset: 0,
      limit: 10,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          after: expect.objectContaining({ name: "Scoped edit" }),
        }),
      ]),
    );
    expect(
      (
        await ctx.app.inject({
          method: "PATCH",
          url: `/api/apps/${target.id}`,
          payload: { scope: "org" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/apps/${target.id}`,
        })
      ).statusCode,
    ).toBe(403);
    await expect(
      ResourcePermissions.require({
        ...key,
        userId: ctx.user.id,
        action: "use",
      }),
    ).rejects.toThrow("permission");
    await AppModel.setEnabled(target.id, false);
    expect(
      (await ctx.app.inject({ method: "GET", url: `/api/apps/${target.id}` }))
        .statusCode,
    ).toBe(404);
    await AppModel.setEnabled(target.id, true);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [],
    });
    expect(
      (await ctx.app.inject({ method: "GET", url: `/api/apps/${target.id}` }))
        .statusCode,
    ).toBe(404);
  });
});
