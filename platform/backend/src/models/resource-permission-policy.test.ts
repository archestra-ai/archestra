// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import OrganizationModel from "./organization";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

describe("resource permission policy persistence", () => {
  test("new organizations initialize scoped role grants without restoring later revocations", async ({
    makeUser,
    makeMember,
  }) => {
    const org = await OrganizationModel.getOrCreateDefaultOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const context = {
      organizationId: org.id,
      userId: admin.id,
      resource: "agent" as const,
      scope: "*",
    };
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(true);
    const policy = await ResourcePermissionPolicyModel.find(context);
    await ResourcePermissionPolicyModel.replace({
      ...context,
      revision: policy?.revision ?? 0,
      grants: [],
    });
    await OrganizationModel.getOrCreateDefaultOrganization();
    expect(
      await ResourcePermissions.allows({ ...context, action: "update" }),
    ).toBe(false);
  });
  test("permanent deletion removes object grants without removing wildcard access", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeInternalMcpCatalog,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({
      organizationId: organization.id,
      agentType: "agent",
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
    });
    for (const target of [
      { resource: "agent" as const, id: agent.id },
      { resource: "mcpRegistry" as const, id: catalog.id },
    ]) {
      const key = {
        organizationId: organization.id,
        resource: target.resource,
      };
      const grants = [
        {
          subject: { type: "user" as const, id: user.id },
          actions: ["read" as const],
        },
      ];
      await ResourcePermissionPolicyModel.replace({
        ...key,
        scope: target.id,
        revision:
          (
            await ResourcePermissionPolicyModel.find({
              ...key,
              scope: target.id,
            })
          )?.revision ?? 0,
        grants,
      });
      await ResourcePermissionPolicyModel.replace({
        ...key,
        scope: "*",
        revision:
          (await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }))
            ?.revision ?? 0,
        grants,
      });
      if (target.resource === "agent") await AgentModel.hardDelete(target.id);
      else await InternalMcpCatalogModel.hardDelete(target.id);
      expect(
        await ResourcePermissionPolicyModel.find({ ...key, scope: target.id }),
      ).toBeNull();
      expect(
        (await ResourcePermissionPolicyModel.find({ ...key, scope: "*" }))
          ?.grants,
      ).toEqual(grants);
    }
  });

  test("a stale editor cannot restore a revoked grant", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    const grants = [
      {
        subject: { type: "user" as const, id: user.id },
        actions: ["read" as const],
      },
    ];
    const initial = await ResourcePermissionPolicyModel.replace({
      ...key,
      grants,
      revision: 0,
    });
    expect(initial?.revision).toBe(1);
    expect(
      await ResourcePermissionPolicyModel.replace({
        ...key,
        grants,
        revision: 0,
      }),
    ).toBeNull();
    const revoked = await ResourcePermissionPolicyModel.replace({
      ...key,
      grants: [],
      revision: 1,
    });
    expect(revoked?.revision).toBe(2);
    expect(
      await ResourcePermissionPolicyModel.replace({
        ...key,
        grants,
        revision: 1,
      }),
    ).toBeNull();
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual([]);
  });

  test("applicable policies include the object, wildcard, and relative team scope within the organization", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const foreignOrganization = await makeOrganization();
    const key = {
      organizationId: organization.id,
      resource: "agent" as const,
      scope: "00000000-0000-4000-8000-000000000001",
    };
    for (const policy of [
      key,
      { ...key, scope: "*" as const },
      { ...key, organizationId: foreignOrganization.id },
      { ...key, resource: "skill" as const },
      { ...key, scope: "00000000-0000-4000-8000-000000000002" },
    ]) {
      await ResourcePermissionPolicyModel.replace({
        ...policy,
        revision: 0,
        grants: [],
      });
    }
    const policies = await ResourcePermissionPolicyModel.findApplicable(key);
    expect(policies.map((policy) => policy.scope).sort()).toEqual(
      ["*", "teams:*", key.scope].sort(),
    );
    expect(
      policies.every(
        (policy) =>
          policy.organizationId === organization.id &&
          policy.resource === "agent",
      ),
    ).toBe(true);
  });
});
