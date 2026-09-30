// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import {
  PredefinedRoleNameSchema,
  type ResourcePermissionGrant,
} from "@archestra/shared";
import { sql } from "drizzle-orm";
import db from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0498_cleanup-orphaned-role-grants.sql"),
  "utf-8",
);

describe("orphaned role grant cleanup", () => {
  test("repairs direct and inherited recipients without changing live grants, ordering, or migration markers", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeCustomRole,
    makeTeam,
    makeServiceAccount,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const role = await makeCustomRole(org.id, {
      role: "live_role",
      permission: {},
    });
    const foreignRole = await makeCustomRole(otherOrg.id, {
      role: "foreign_role",
      permission: {},
    });
    const team = await makeTeam(org.id, user.id);
    const account = await makeServiceAccount(org.id);
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: user.id,
      agentType: "mcp_gateway",
      access: "personal",
    });
    const context = {
      organizationId: org.id,
      userId: user.id,
      resource: "mcpGateway" as const,
      scope: agent.id,
    };
    const preserved: ResourcePermissionGrant[] = [
      { subject: { type: "user", id: user.id }, actions: ["read"] },
      ...PredefinedRoleNameSchema.options.map((id) => ({
        subject: { type: "role" as const, id },
        actions: ["read" as const],
      })),
      { subject: { type: "role", id: role.id }, actions: ["read"] },
      { subject: { type: "team", id: team.id }, actions: ["read"] },
      {
        subject: { type: "serviceAccount", id: account.id },
        actions: ["read"],
      },
      { subject: { type: "organization", id: "*" }, actions: ["read"] },
    ];
    // Seed the historical state: a deleted role's grant survived its deletion.
    // Model writes bypass recipient validation intentionally for this upgrade test.
    const orphan: ResourcePermissionGrant = {
      subject: { type: "role", id: "deleted-custom-role" },
      actions: ["read"],
    };
    const before = await ResourcePermissionPolicyModel.find(context);
    await ResourcePermissionPolicyModel.replace({
      ...context,
      revision: before?.revision ?? 0,
      grants: [
        orphan,
        ...preserved,
        { ...orphan, subject: { type: "role", id: foreignRole.id } },
      ],
    });
    const wildcard = { ...context, scope: "*" };
    const inherited = await ResourcePermissionPolicyModel.find(wildcard);
    await ResourcePermissionPolicyModel.replace({
      ...wildcard,
      revision: inherited?.revision ?? 0,
      grants: [...(inherited?.grants ?? []), orphan],
    });
    const dirty = await ResourcePermissionPolicyModel.find(context);
    const dirtyWildcard = await ResourcePermissionPolicyModel.find(wildcard);
    const visibleBefore = await ResourcePermissions.getPolicy(context);
    expect(
      visibleBefore.grants.some(
        (grant) => grant.name === "Unavailable recipient",
      ),
    ).toBe(true);
    expect(
      visibleBefore.inheritedGrants.some(
        (grant) => grant.name === "Unavailable recipient",
      ),
    ).toBe(true);

    await db.execute(sql.raw(migrationSql));

    const cleaned = await ResourcePermissionPolicyModel.find(context);
    expect(cleaned).toMatchObject({
      ...dirty,
      grants: preserved,
      revision: (dirty?.revision ?? 0) + 1,
      updatedAt: expect.any(Date),
    });
    const cleanedWildcard = await ResourcePermissionPolicyModel.find(wildcard);
    expect(cleanedWildcard?.grants).toEqual(inherited?.grants);
    expect(cleanedWildcard?.revision).toBe((dirtyWildcard?.revision ?? 0) + 1);
    const visibleAfter = await ResourcePermissions.getPolicy(context);
    expect(
      [...visibleAfter.grants, ...visibleAfter.inheritedGrants].some(
        (grant) => grant.name === "Unavailable recipient",
      ),
    ).toBe(false);
    expect(
      visibleAfter.grants.find((grant) => grant.subject.id === role.id)?.name,
    ).toBe(role.name);
    // An editor opened before cleanup cannot overwrite the repaired policy.
    expect(
      await ResourcePermissionPolicyModel.replace({
        ...context,
        revision: dirty?.revision ?? 0,
        grants: preserved,
      }),
    ).toBeNull();

    await db.execute(sql.raw(migrationSql));
    expect(await ResourcePermissionPolicyModel.find(context)).toEqual(cleaned);
    expect(await ResourcePermissionPolicyModel.find(wildcard)).toEqual(
      cleanedWildcard,
    );
  });

  test("keeps empty policies and leaves unaffected policies untouched", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = {
      organizationId: org.id,
      resource: "knowledgeConnector" as const,
      scope: "historical-connector",
    };
    const onlyOrphan = await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: 0,
      grants: [
        {
          subject: { type: "role", id: "deleted-role" },
          actions: ["read", "use"],
        },
      ],
    });
    const untouchedKey = { ...key, scope: "live-connector" };
    const untouched = await ResourcePermissionPolicyModel.replace({
      ...untouchedKey,
      revision: 0,
      grants: [{ subject: { type: "role", id: "admin" }, actions: ["read"] }],
    });
    await db.execute(sql.raw(migrationSql));
    const empty = await ResourcePermissionPolicyModel.find(key);
    expect(empty).toMatchObject({
      grants: [],
      revision: (onlyOrphan?.revision ?? 0) + 1,
    });
    expect(await ResourcePermissionPolicyModel.find(untouchedKey)).toEqual(
      untouched,
    );
    await db.execute(sql.raw(migrationSql));
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(empty);
  });
});
