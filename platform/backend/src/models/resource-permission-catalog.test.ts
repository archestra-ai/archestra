// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { describe, expect, test } from "@/test";
import McpCatalogTeamModel from "./mcp-catalog-team";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ServiceAccountModel from "./service-account";
import TeamModel from "./team";

describe("catalog grant filtering", () => {
  test("lists only the directly granted private catalog and revokes it immediately", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
    });
    const other = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
    });
    const key = {
      organizationId: org.id,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [{ subject: { type: "user", id: user.id }, actions: ["read"] }],
    });
    const ids = await McpCatalogTeamModel.getUserAccessibleCatalogIds(
      user.id,
      false,
      org.id,
    );
    expect(ids).toContain(catalog.id);
    expect(ids).not.toContain(other.id);
    expect(
      await McpCatalogTeamModel.userHasCatalogAccess({
        userId: user.id,
        catalogId: catalog.id,
        isAdmin: false,
        organizationId: org.id,
      }),
    ).toBe(true);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [],
    });
    expect(
      await McpCatalogTeamModel.userHasCatalogAccess({
        userId: user.id,
        catalogId: catalog.id,
        isAdmin: false,
        organizationId: org.id,
      }),
    ).toBe(false);
  });

  test("SQL filtering honors inherited team grants, immutable custom role IDs and service accounts", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const role = await makeCustomRole(org.id, {
      role: "catalog_reader",
      permission: {},
    });
    const parent = await TeamModel.create({
      name: "Engineering",
      organizationId: org.id,
      createdBy: owner.id,
      roles: [role.role],
    });
    const child = await TeamModel.create({
      name: "Frontend",
      organizationId: org.id,
      createdBy: owner.id,
      parentId: parent.id,
    });
    await TeamModel.addMember(child.id, user.id);
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: owner.id,
      scope: "personal",
    });
    const key = {
      organizationId: org.id,
      resource: "mcpRegistry" as const,
      scope: "*" as const,
    };
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [{ subject: { type: "role", id: role.id }, actions: ["read"] }],
    });
    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        user.id,
        false,
        org.id,
      ),
    ).toContain(catalog.id);
    await TeamModel.update(parent.id, { roles: [] });
    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        user.id,
        false,
        org.id,
      ),
    ).not.toContain(catalog.id);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [{ subject: { type: "team", id: parent.id }, actions: ["read"] }],
    });
    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        user.id,
        false,
        org.id,
      ),
    ).toContain(catalog.id);
    const account = await ServiceAccountModel.create({
      createdBy: null,
      organizationId: org.id,
      name: "Catalog automation",
      role: "member",
    });
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: (await ResourcePermissionPolicyModel.find(key))?.revision ?? 0,
      grants: [
        {
          subject: { type: "serviceAccount", id: account.id },
          actions: ["read"],
        },
      ],
    });
    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        `service-account:${account.id}`,
        false,
        org.id,
      ),
    ).toContain(catalog.id);
    await ServiceAccountModel.update(account.id, org.id, { disabled: true });
    expect(
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        `service-account:${account.id}`,
        false,
        org.id,
      ),
    ).not.toContain(catalog.id);
  });
});
