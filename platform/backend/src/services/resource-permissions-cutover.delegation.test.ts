// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { describe, expect, test } from "@/test";
import { ResourcePermissions } from "./resource-permissions";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

describe("scoped role assignment after conversion", () => {
  test("an Admin can assign Editor after restricted-environment access is converted", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization({ legacyPermissions: true });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });

    await runScopedResourcePermissionCutover();

    await expect(
      ResourcePermissions.validateSubjectAssignment({
        organizationId: org.id,
        userId: admin.id,
        subjects: [{ type: "role", id: "editor" }],
      }),
    ).resolves.toBeUndefined();
  });
});
