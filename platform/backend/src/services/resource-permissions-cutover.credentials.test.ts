// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { expect, test } from "@/test";
import { runScopedResourcePermissionCutover } from "./resource-permissions-cutover";

test("credential role actions become grants on every credential and leave the roles", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const manager = await makeCustomRole(org.id, {
    permission: { credential: ["read", "update", "delete"] },
  });
  const viewer = await makeCustomRole(org.id, {
    permission: { credential: ["read"], agent: ["read"] },
  });
  const unrelated = await makeCustomRole(org.id, {
    permission: { agent: ["read"] },
  });

  await runScopedResourcePermissionCutover();

  const key = {
    organizationId: org.id,
    resource: "credential" as const,
    scope: "*",
  };
  const policy = await ResourcePermissionPolicyModel.find(key);
  const actionsOf = (id: string) =>
    policy?.grants.find(
      (grant) => grant.subject.type === "role" && grant.subject.id === id,
    )?.actions;
  const everything = ["delete", "manage-permissions", "read", "update", "use"];
  // Every role keeps exactly the reach its role actions gave it. Reading
  // carried connecting a personal value, which is `use` now.
  expect(actionsOf("admin")).toEqual(everything);
  expect(actionsOf("platform_admin")).toEqual(everything);
  expect(actionsOf("editor")).toEqual(everything);
  expect(actionsOf("member")).toEqual(["read", "use"]);
  expect(actionsOf(manager.id)).toEqual(everything);
  expect(actionsOf(viewer.id)).toEqual(["read", "use"]);
  expect(actionsOf(unrelated.id)).toBeUndefined();

  // The retired actions leave the stored roles; everything else stays.
  const stored = async (id: string) =>
    JSON.parse(
      (
        await db
          .select({ permission: schema.organizationRolesTable.permission })
          .from(schema.organizationRolesTable)
          .where(eq(schema.organizationRolesTable.id, id))
      )[0].permission,
    );
  expect((await stored(manager.id)).credential).toEqual(["read"]);
  expect(await stored(viewer.id)).toEqual({
    credential: ["read"],
    agent: ["read"],
  });

  // A restart neither re-derives nor bumps the revision an open editor holds.
  await runScopedResourcePermissionCutover();
  expect(await ResourcePermissionPolicyModel.find(key)).toEqual(policy);

  // A revocation made in the editor afterwards survives the next start.
  const revoked = await ResourcePermissionPolicyModel.replace({
    ...key,
    revision: policy?.revision ?? 0,
    grants: (policy?.grants ?? []).filter(
      (grant) => grant.subject.id !== "member",
    ),
  });
  await runScopedResourcePermissionCutover();
  expect(await ResourcePermissionPolicyModel.find(key)).toEqual(revoked);
});
