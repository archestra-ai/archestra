// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { expect, test } from "@/test";

for (const legacyPermissions of [false, true]) {
  test(`${legacyPermissions ? "migrated" : "new"} organizations let admins delegate log access without granting platform admins global logs`, async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions });
    const admin = await makeUser();
    const platformAdmin = await makeUser();
    const reader = await makeUser();
    const readerRole = await makeCustomRole(org.id, {
      permission: legacyPermissions
        ? { log: ["read", "admin"], auditLog: ["read", "admin"] }
        : {},
    });
    await makeMember(admin.id, org.id, { role: "admin" });
    await makeMember(platformAdmin.id, org.id, { role: "platform_admin" });
    await makeMember(reader.id, org.id, { role: readerRole.role });
    if (legacyPermissions) await runScopedResourcePermissionCutover();

    for (const resource of ["log", "auditLog"] as const) {
      const context = { organizationId: org.id, resource, scope: "*" };
      for (const action of ["read", "manage-permissions"] as const) {
        expect(
          await ResourcePermissions.allows({
            ...context,
            userId: admin.id,
            action,
          }),
        ).toBe(true);
        expect(
          await ResourcePermissions.allows({
            ...context,
            userId: platformAdmin.id,
            action,
          }),
        ).toBe(false);
      }
      expect(
        await ResourcePermissions.allows({
          ...context,
          userId: reader.id,
          action: "manage-permissions",
        }),
      ).toBe(false);
      if (legacyPermissions) {
        expect(
          await ResourcePermissions.allows({
            ...context,
            userId: reader.id,
            action: "read",
          }),
        ).toBe(true);
      }
      const policy = await ResourcePermissionPolicyModel.find(context);
      await ResourcePermissions.updatePolicy({
        ...context,
        userId: admin.id,
        revision: policy?.revision ?? 0,
        grants: [
          {
            subject: { type: "role", id: "admin" },
            actions: ["read", "manage-permissions"],
          },
          { subject: { type: "user", id: reader.id }, actions: ["read"] },
        ],
      });
      expect(
        await ResourcePermissions.allows({
          ...context,
          userId: reader.id,
          action: "read",
        }),
      ).toBe(true);
      const delegated = await ResourcePermissionPolicyModel.find(context);
      await ResourcePermissions.updatePolicy({
        ...context,
        userId: admin.id,
        revision: delegated?.revision ?? 0,
        grants: [{ subject: { type: "role", id: "admin" }, actions: ["read"] }],
      });
      await runScopedResourcePermissionCutover();
      expect(
        await ResourcePermissions.allows({
          ...context,
          userId: admin.id,
          action: "manage-permissions",
        }),
      ).toBe(false);
      expect(
        await ResourcePermissions.allows({
          ...context,
          userId: reader.id,
          action: "read",
        }),
      ).toBe(false);
    }
  });
}
