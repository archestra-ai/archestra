// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("wildcard service account role revocation survives restart", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const role = await makeCustomRole(org.id, {
    permission: { serviceAccount: ["read"] },
  });
  const key = {
    organizationId: org.id,
    resource: "serviceAccount" as const,
    scope: "*",
  };
  await runScopedResourcePermissionCutover();
  const converted = await ResourcePermissionPolicyModel.find(key);
  expect(converted?.grants.some((grant) => grant.subject.id === role.id)).toBe(
    true,
  );
  const revoked = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: converted?.revision ?? 0,
    grants:
      converted?.grants.filter((grant) => grant.subject.id !== role.id) ?? [],
  });
  expect(revoked?.grants.some((grant) => grant.subject.id === role.id)).toBe(
    false,
  );
  await runScopedResourcePermissionCutover();
  const restarted = await ResourcePermissionPolicyModel.find(key);
  expect(restarted?.grants.some((grant) => grant.subject.id === role.id)).toBe(
    false,
  );
});

test("model wildcard revocation survives despite a retained custom role update action", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const role = await makeCustomRole(org.id, {
    permission: { llmModel: ["read", "update"] },
  });
  const key = {
    organizationId: org.id,
    resource: "llmModel" as const,
    scope: "*",
  };
  await runScopedResourcePermissionCutover();
  const converted = await ResourcePermissionPolicyModel.find(key);
  expect(converted?.grants.some((grant) => grant.subject.id === role.id)).toBe(
    true,
  );
  await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: converted?.revision ?? 0,
    grants:
      converted?.grants.filter((grant) => grant.subject.id !== role.id) ?? [],
  });
  await runScopedResourcePermissionCutover();
  expect(
    (await ResourcePermissionPolicyModel.find(key))?.grants.some(
      (grant) => grant.subject.id === role.id,
    ),
  ).toBe(false);
});

test("built-in relative and deployment grants stay revoked after restart", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  await runScopedResourcePermissionCutover();
  for (const key of [
    { organizationId: org.id, resource: "agent" as const, scope: "teams:*" },
    { organizationId: org.id, resource: "environment" as const, scope: "*" },
  ]) {
    const converted = await ResourcePermissionPolicyModel.find(key);
    expect(
      converted?.grants.some((grant) => grant.subject.id === "editor"),
    ).toBe(true);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: converted?.revision ?? 0,
      grants:
        converted?.grants.filter((grant) => grant.subject.id !== "editor") ??
        [],
    });
  }
  await runScopedResourcePermissionCutover();
  for (const key of [
    { organizationId: org.id, resource: "agent" as const, scope: "teams:*" },
    { organizationId: org.id, resource: "environment" as const, scope: "*" },
  ]) {
    expect(
      (await ResourcePermissionPolicyModel.find(key))?.grants.some(
        (grant) => grant.subject.id === "editor",
      ),
    ).toBe(false);
  }
});
