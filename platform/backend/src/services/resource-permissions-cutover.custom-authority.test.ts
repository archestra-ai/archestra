// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ProjectModel from "@/models/project";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("catalog admin scope preserves a read-only custom role without manufacturing mutation authority", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeInternalMcpCatalog,
  removeObjectPolicies,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const user = await makeUser();
  const role = await makeCustomRole(org.id, {
    permission: {
      mcpRegistry: ["read"],
      mcpServerInstallation: ["admin"],
    },
  });
  await makeMember(user.id, org.id, { role: role.role });
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    scope: "personal",
  });
  await removeObjectPolicies(org.id);
  const access = {
    organizationId: org.id,
    userId: user.id,
    resource: "mcpRegistry" as const,
    scope: catalog.id,
  };
  // Before the upgrade this role read every catalog item and wrote none;
  // the conversion has to land it in exactly that place.
  await runScopedResourcePermissionCutover();
  expect(
    await ResourcePermissions.require({ ...access, action: "read" }).then(
      () => true,
      () => false,
    ),
  ).toBe(true);
  for (const action of ["update", "delete", "manage-permissions"] as const) {
    expect(
      await ResourcePermissions.require({ ...access, action }).then(
        () => true,
        () => false,
      ),
      action,
    ).toBe(false);
  }
});

test("project admin scope preserves read-only custom authority", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  removeObjectPolicies,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const user = await makeUser();
  const owner = await makeUser();
  const role = await makeCustomRole(org.id, {
    permission: { project: ["read", "admin"] },
  });
  await makeMember(user.id, org.id, { role: role.role });
  await makeMember(owner.id, org.id);
  const project = await ProjectModel.create({
    organizationId: org.id,
    userId: owner.id,
    name: "Read-only oversight",
  });
  await removeObjectPolicies(org.id);
  const access = {
    organizationId: org.id,
    userId: user.id,
    resource: "project" as const,
    scope: project.id,
  };
  // Before the upgrade this role read every project and wrote none.
  await runScopedResourcePermissionCutover();
  await expect(
    ResourcePermissions.require({ ...access, action: "read" }),
  ).resolves.toBeUndefined();
  for (const action of ["update", "delete", "manage-permissions"] as const) {
    await expect(
      ResourcePermissions.require({ ...access, action }),
    ).rejects.toThrow();
  }
});

test("installation-only catalog administrators keep use, widened to the use preset, without gaining catalog writes", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeCustomRole,
  makeInternalMcpCatalog,
  removeObjectPolicies,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const user = await makeUser();
  const role = await makeCustomRole(org.id, {
    permission: { mcpServerInstallation: ["create", "admin"] },
  });
  await makeMember(user.id, org.id, { role: role.role });
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    scope: "personal",
  });
  await removeObjectPolicies(org.id);
  const access = {
    organizationId: org.id,
    userId: user.id,
    resource: "mcpRegistry" as const,
    scope: catalog.id,
  };
  // Before the upgrade this role could install (use) every catalog item and
  // could not read or write one.
  await runScopedResourcePermissionCutover();
  await expect(
    ResourcePermissions.require({ ...access, action: "use" }),
  ).resolves.toBeUndefined();
  // The converted `use` grant is widened to the `use` preset [read, use], so
  // after the upgrade this role can also read the catalog it could only use
  // before. That widening to the nearest preset is deliberate; the write
  // actions stay refused.
  await expect(
    ResourcePermissions.require({ ...access, action: "read" }),
  ).resolves.toBeUndefined();
  for (const action of ["update", "delete", "manage-permissions"] as const) {
    await expect(
      ResourcePermissions.require({ ...access, action }),
    ).rejects.toThrow();
  }
});
