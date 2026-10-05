// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { userHasPermission } from "@/auth";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { runScopedResourcePermissionCutover } from "@/services/resource-permissions-cutover";
import { expect, test } from "@/test";

for (const legacyPermissions of [false, true]) {
  test(`${legacyPermissions ? "migrated" : "new"} organizations use role actions for log visibility`, async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization({ legacyPermissions });
    for (const [role, expected] of [
      ["admin", true],
      ["platform_admin", false],
      ["editor", false],
      ["member", false],
    ] as const) {
      const actor = await makeUser();
      await makeMember(actor.id, org.id, { role });
      for (const resource of [
        "log",
        "auditLog",
        "openappaDiagnostics",
      ] as const) {
        expect(
          await userHasPermission(actor.id, org.id, resource, "admin"),
        ).toBe(expected);
      }
    }
    const actor = await makeUser();
    const custom = await makeCustomRole(org.id, {
      permission: { log: ["read", "admin"], auditLog: ["read", "admin"] },
    });
    await makeMember(actor.id, org.id, { role: custom.role });
    await runScopedResourcePermissionCutover();
    for (const resource of ["log", "auditLog"] as const) {
      expect(await userHasPermission(actor.id, org.id, resource, "admin")).toBe(
        true,
      );
      expect(
        await ResourcePermissionPolicyModel.find({
          organizationId: org.id,
          resource,
          scope: "*",
        }),
      ).toBeNull();
      await expect(
        ResourcePermissions.getPolicy({
          userId: actor.id,
          organizationId: org.id,
          resource,
          scope: "*",
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
  });
}
