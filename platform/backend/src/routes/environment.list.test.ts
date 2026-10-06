// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { PGlite } from "@electric-sql/pglite";
import { vi } from "vitest";
import EnvironmentModel from "@/models/environment";
import MemberModel from "@/models/member";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import ServiceAccountModel from "@/models/service-account";
import TeamModel from "@/models/team";
import environmentRoutes from "@/routes/environment";
import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";
import { grantEnvironmentUse } from "@/test/environments";
import { useRouteTestApp } from "@/test/route-test-app";

describe("environment listing", () => {
  const ctx = useRouteTestApp(environmentRoutes);

  test("listing more environments does not multiply authorization queries", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const first = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "First workspace",
      authorId: ctx.user.id,
    });
    const queries = vi.spyOn(PGlite.prototype, "query");
    const one = await ctx.app.inject("/api/environments");
    expect(one.statusCode).toBe(200);
    expect(one.json().environments).toMatchObject([
      { id: first.id, canDeploy: true },
    ]);
    const singleCount = queries.mock.calls.length;

    for (let index = 0; index < 6; index++) {
      await EnvironmentModel.create({
        organizationId: ctx.organizationId,
        name: `Additional workspace ${index}`,
        authorId: ctx.user.id,
      });
    }
    queries.mockClear();
    const many = await ctx.app.inject("/api/environments");
    expect(many.statusCode).toBe(200);
    expect(many.json().environments).toHaveLength(7);
    expect(
      many
        .json()
        .environments.every((row: { canDeploy: boolean }) => row.canDeploy),
    ).toBe(true);
    expect(queries.mock.calls.length).toBe(singleCount);
  });

  test("listing preserves exact grants and observes revocation on the next request", async ({
    makeMember,
    makeOrganization,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const otherOrg = await makeOrganization();
    const makeEnvironment = (
      name: string,
      organizationId = ctx.organizationId,
    ) => EnvironmentModel.create({ organizationId, name });
    const allowed = await makeEnvironment("Allowed workspace");
    const denied = await makeEnvironment("Read-only workspace");
    await makeEnvironment("Foreign workspace", otherOrg.id);
    // Remove system-create defaults so each environment needs an explicit grant.
    for (const environment of [allowed, denied]) {
      const key = {
        organizationId: ctx.organizationId,
        resource: "environment" as const,
        scope: environment.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy?.revision ?? 0,
        grants: [],
      });
    }
    await grantEnvironmentUse({
      organizationId: ctx.organizationId,
      environmentId: allowed.id,
      userId: ctx.user.id,
    });
    const list = () => ctx.app.inject("/api/environments");
    const before = await list();
    expect(before.statusCode).toBe(200);
    expect(before.json().environments).toMatchObject([
      { id: allowed.id, canDeploy: true },
      { id: denied.id, canDeploy: false },
    ]);
    expect(before.json().environments).toHaveLength(2);

    const key = {
      organizationId: ctx.organizationId,
      resource: "environment" as const,
      scope: allowed.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    const after = await list();
    expect(after.statusCode).toBe(200);
    expect(after.json().environments).toMatchObject([
      { id: allowed.id, canDeploy: false },
      { id: denied.id, canDeploy: false },
    ]);
  });

  test("listing honors inherited team grants and wildcard grants without caching membership", async ({
    makeMember,
    makeTeam,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const team = await makeTeam(ctx.organizationId, ctx.user.id);
    await TeamModel.addMember(team.id, ctx.user.id);
    const allowed = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Team workspace",
    });
    const denied = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Private workspace",
    });
    for (const environment of [allowed, denied]) {
      const key = {
        organizationId: ctx.organizationId,
        resource: "environment" as const,
        scope: environment.id,
      };
      const policy = await ResourcePermissionPolicyModel.find(key);
      await ResourcePermissionPolicyModel.replace({
        ...key,
        revision: policy?.revision ?? 0,
        grants:
          environment.id === allowed.id
            ? [{ subject: { type: "team", id: team.id }, actions: ["use"] }]
            : [],
      });
    }
    const list = async () => {
      const response = await ctx.app.inject("/api/environments");
      expect(response.statusCode).toBe(200);
      return response.json().environments;
    };
    expect(await list()).toMatchObject([
      { id: allowed.id, canDeploy: true },
      { id: denied.id, canDeploy: false },
    ]);
    const wildcard = {
      organizationId: ctx.organizationId,
      resource: "environment" as const,
      scope: "*",
    };
    const policy = await ResourcePermissionPolicyModel.find(wildcard);
    await ResourcePermissionPolicyModel.replace({
      ...wildcard,
      revision: policy?.revision ?? 0,
      grants: [
        { subject: { type: "organization", id: "*" }, actions: ["use"] },
      ],
    });
    expect(await list()).toMatchObject([
      { id: allowed.id, canDeploy: true },
      { id: denied.id, canDeploy: true },
    ]);
    await MemberModel.deleteAllByUserId(ctx.user.id);
    expect(await list()).toMatchObject([
      { id: allowed.id, canDeploy: false },
      { id: denied.id, canDeploy: false },
    ]);
  });

  test("batched deployment checks deny disabled and foreign service accounts", async ({
    makeOrganization,
  }) => {
    const account = await ServiceAccountModel.create({
      createdBy: null,
      organizationId: ctx.organizationId,
      name: "Workspace automation",
      role: "member",
    });
    const environment = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Automation workspace",
    });
    const params = {
      organizationId: ctx.organizationId,
      userId: `service-account:${account.id}`,
      environmentIds: [environment.id],
    };
    expect(await ResourcePermissions.getUsableEnvironmentIds(params)).toEqual(
      new Set([environment.id]),
    );
    const otherOrg = await makeOrganization();
    expect(
      await ResourcePermissions.getUsableEnvironmentIds({
        ...params,
        organizationId: otherOrg.id,
      }),
    ).toEqual(new Set());
    await ServiceAccountModel.update(account.id, ctx.organizationId, {
      disabled: true,
    });
    expect(await ResourcePermissions.getUsableEnvironmentIds(params)).toEqual(
      new Set(),
    );
    expect(
      await ResourcePermissions.getUsableEnvironmentIds({
        ...params,
        environmentIds: [],
      }),
    ).toEqual(new Set());
  });
});
