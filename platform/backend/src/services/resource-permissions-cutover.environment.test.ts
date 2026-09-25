// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type { ResourcePermissionGrant } from "@archestra/shared";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("repairs only the untouched original environment seed and preserves later revocation", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const key = {
    organizationId: org.id,
    resource: "environment" as const,
    scope: "*",
  };
  await db
    .insert(schema.resourcePermissionPoliciesTable)
    .values({ ...key, grants: originalSeed(), legacySharingMigrated: true });
  await runScopedResourcePermissionCutover();
  const repaired = await ResourcePermissionPolicyModel.find(key);
  for (const id of ["admin", "platform_admin"]) {
    expect(
      repaired?.grants.find((grant) => grant.subject.id === id)?.actions,
    ).toEqual(["delete", "manage-permissions", "read", "update", "use"]);
  }
  expect(repaired?.revision).toBe(2);
  await runScopedResourcePermissionCutover();
  expect(await ResourcePermissionPolicyModel.find(key)).toEqual(repaired);
  const revoked = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: repaired?.revision ?? 0,
    grants: originalSeed(),
  });
  await runScopedResourcePermissionCutover();
  expect(await ResourcePermissionPolicyModel.find(key)).toEqual(revoked);
});

test("does not repair customized revision-one or previously edited environment policies", async ({
  makeOrganization,
}) => {
  for (const customized of [false, true]) {
    const org = await makeOrganization({ legacyPermissions: true });
    const key = {
      organizationId: org.id,
      resource: "environment" as const,
      scope: "*",
    };
    const grants = originalSeed();
    if (customized) grants[0].actions = ["read"];
    await db.insert(schema.resourcePermissionPoliciesTable).values({
      ...key,
      grants,
      revision: customized ? 1 : 2,
      legacySharingMigrated: true,
    });
    const original = await ResourcePermissionPolicyModel.find(key);
    await runScopedResourcePermissionCutover();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(original);
  }
});

function originalSeed(): ResourcePermissionGrant[] {
  return ["admin", "editor", "platform_admin"].map((id) => ({
    subject: { type: "role", id },
    actions: ["read", "use"],
  }));
}
