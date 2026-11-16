// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { sql } from "drizzle-orm";
import db from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import StartupMigrationModel from "@/models/startup-migration";
import { ResourcePermissions } from "@/services/resource-permissions";
import { expect, test } from "@/test";
import {
  ensureScopedResourcePermissionCutover,
  runScopedResourcePermissionCutover,
} from "./resource-permissions-cutover";

test("an object shared before the upgrade gives its author full access, like one created since", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  makeAgent,
  removeObjectPolicies,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const author = await makeUser();
  const colleague = await makeUser();
  await makeMember(author.id, org.id);
  await makeMember(colleague.id, org.id);
  const catalog = await makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: author.id,
    legacy: { scope: "org" },
  });
  const agent = await makeAgent({
    organizationId: org.id,
    authorId: author.id,
    agentType: "agent",
    legacy: { scope: "org" },
  });
  await removeObjectPolicies(org.id);

  await ensureScopedResourcePermissionCutover();

  for (const target of [
    { resource: "mcpRegistry" as const, scope: catalog.id },
    { resource: "agent" as const, scope: agent.id },
  ]) {
    for (const action of ["update", "delete", "manage-permissions"] as const) {
      expect(
        await allows({ org: org.id, user: author.id, ...target, action }),
        `${target.resource} ${action}`,
      ).toBe(true);
      // The audience the organization-wide sharing became is unchanged.
      expect(
        await allows({ org: org.id, user: colleague.id, ...target, action }),
        `${target.resource} ${action} for a colleague`,
      ).toBe(false);
    }
  }
});

test("a deployment converted before the fix gains its authors once, and an author removed since stays removed", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeInternalMcpCatalog,
  removeObjectPolicies,
}) => {
  const org = await makeOrganization({ legacyPermissions: true });
  const author = await makeUser();
  await makeMember(author.id, org.id);
  const untouched = await makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: author.id,
    legacy: { scope: "org" },
  });
  const edited = await makeInternalMcpCatalog({
    organizationId: org.id,
    authorId: author.id,
    legacy: { scope: "org" },
  });
  await removeObjectPolicies(org.id);

  // The earlier release converted this deployment a day ago.
  await StartupMigrationModel.tryRun({
    id: "scoped-resource-permissions-v1",
    migrate: runScopedResourcePermissionCutover,
  });
  await db.execute(
    sql`UPDATE startup_migrations SET completed_at = now() - interval '1 day' WHERE id = 'scoped-resource-permissions-v1'`,
  );
  await db.execute(
    sql`UPDATE resource_permission_policies SET updated_at = updated_at - interval '1 day' WHERE organization_id = ${org.id}`,
  );
  // Since then, an administrator saved one item's permissions as they are.
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "mcpRegistry",
    scope: edited.id,
  });
  if (!policy) throw new Error("conversion wrote no policy");
  await ResourcePermissionPolicyModel.replace({
    organizationId: org.id,
    resource: "mcpRegistry",
    scope: edited.id,
    revision: policy.revision,
    grants: policy.grants,
  });

  await ensureScopedResourcePermissionCutover();

  const untouchedAccess = {
    org: org.id,
    user: author.id,
    resource: "mcpRegistry" as const,
    scope: untouched.id,
    action: "update" as const,
  };
  expect(await allows(untouchedAccess)).toBe(true);
  expect(await allows({ ...untouchedAccess, scope: edited.id })).toBe(false);

  // Once done, a later start leaves a revocation alone.
  const restored = await ResourcePermissionPolicyModel.find({
    organizationId: org.id,
    resource: "mcpRegistry",
    scope: untouched.id,
  });
  if (!restored) throw new Error("policy disappeared");
  await ResourcePermissionPolicyModel.replace({
    organizationId: org.id,
    resource: "mcpRegistry",
    scope: untouched.id,
    revision: restored.revision,
    grants: restored.grants.filter(
      (grant) =>
        grant.subject.type !== "user" || grant.subject.id !== author.id,
    ),
  });
  await db.execute(
    sql`UPDATE startup_migrations SET completed_at = now() WHERE id = 'scoped-resource-permissions-v1'`,
  );
  await ensureScopedResourcePermissionCutover();
  expect(await allows(untouchedAccess)).toBe(false);
});

async function allows(params: {
  org: string;
  user: string;
  resource: "mcpRegistry" | "agent";
  scope: string;
  action: "update" | "delete" | "manage-permissions";
}): Promise<boolean> {
  return ResourcePermissions.require({
    organizationId: params.org,
    userId: params.user,
    resource: params.resource,
    scope: params.scope,
    action: params.action,
  }).then(
    () => true,
    () => false,
  );
}
