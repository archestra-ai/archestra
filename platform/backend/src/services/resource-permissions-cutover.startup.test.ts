// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { expect, test } from "@/test";
import {
  ensureScopedResourcePermissionCutover,
  widenGrantsToPresets,
} from "./resource-permissions-cutover";

test("startup converts legacy sharing and subsequent starts never access permission tables", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeAgent,
  removeObjectPolicies,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const owner = await makeUser();
  await makeMember(owner.id, org.id);
  const agent = await makeAgent({
    organizationId: org.id,
    authorId: owner.id,
    agentType: "agent",
    legacy: { scope: "personal" },
  });
  await removeObjectPolicies(org.id);
  await ensureScopedResourcePermissionCutover();
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "agent",
    scope: agent.id,
  });
  expect(policy?.legacySharingMigrated).toBe(true);
  expect(policy?.grants).toContainEqual({
    subject: { type: "user", id: owner.id },
    actions: ["delete", "manage-permissions", "read", "update", "use"],
  });

  // Renaming catches reads and LOCK TABLE too, unlike assertions on revisions.
  await db.execute(
    sql`ALTER TABLE resource_permission_policies RENAME TO upgraded_policies`,
  );
  try {
    await ensureScopedResourcePermissionCutover();
    await ensureScopedResourcePermissionCutover();
  } finally {
    await db.execute(
      sql`ALTER TABLE upgraded_policies RENAME TO resource_permission_policies`,
    );
  }
});

test("preset conversion crosses batch, resource, and organization boundaries without skipping policies", async ({
  makeOrganization,
}) => {
  for (let organization = 0; organization < 2; organization++) {
    const org = await makeOrganization({ legacyPermissions: true });
    await db.insert(schema.resourcePermissionPoliciesTable).values(
      (["agent", "skill", "app"] as const).flatMap((resource) =>
        Array.from({ length: 105 }, (_, index) => ({
          organizationId: org.id,
          resource,
          scope: `scope-${String(index).padStart(4, "0")}`,
          grants: [
            {
              subject: { type: "organization" as const, id: "*" as const },
              actions: ["use" as const],
            },
          ],
        })),
      ),
    );
  }
  await db.transaction(widenGrantsToPresets);
  const policies = await db
    .select()
    .from(schema.resourcePermissionPoliciesTable);
  expect(policies).toHaveLength(630);
  for (const policy of policies) {
    expect(policy.grants).toEqual([
      { subject: { type: "organization", id: "*" }, actions: ["read", "use"] },
    ]);
    expect(policy.revision).toBe(2);
  }
  await db.transaction(widenGrantsToPresets);
  expect(
    await db.select().from(schema.resourcePermissionPoliciesTable),
  ).toEqual(policies);
});
