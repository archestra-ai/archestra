// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";
import { ROLE_RETIREMENT_STATEMENTS } from "./resource-permissions-cutover";

/** Only the role half, so the fixtures stay about roles. */
async function runMigration() {
  await db.transaction(async (tx) => {
    for (const statement of ROLE_RETIREMENT_STATEMENTS)
      await tx.execute(statement);
  });
}

describe("scoped RBAC final cutover", () => {
  test("merges Editor model authority without removing other grants, and replays without revision churn", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const key = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: "*",
    };
    const original = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: original?.revision ?? 0,
      grants: [
        {
          subject: { type: "role", id: "editor" },
          actions: ["read", "delete"],
        },
        { subject: { type: "user", id: user.id }, actions: ["use"] },
      ],
    });
    const unrelatedKey = {
      organizationId: org.id,
      resource: "agent" as const,
      scope: "*",
    };
    const unrelated = await ResourcePermissionPolicyModel.find(unrelatedKey);
    await runMigration();
    const result = await ResourcePermissionPolicyModel.find(key);
    expect(result?.grants).toEqual([
      {
        subject: { type: "role", id: "editor" },
        actions: ["delete", "manage-permissions", "read", "update", "use"],
      },
      { subject: { type: "user", id: user.id }, actions: ["use"] },
    ]);
    expect(await ResourcePermissionPolicyModel.find(unrelatedKey)).toEqual(
      unrelated,
    );
    await runMigration();
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(result);
  });

  test("retires only converted resource flags, preserving role identity, ordinary actions, and unrelated resource permissions", async ({
    makeOrganization,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      permission: {
        agent: ["read", "admin", "update", "team-admin"],
        mcpGateway: ["team-admin"],
        mcpRegistry: ["admin", "create"],
        skill: ["read", "team-admin"],
        app: ["admin", "delete"],
        // Converted alongside the six: its admin action became a grant.
        knowledgeSource: ["admin", "read", "team-admin"],
        project: ["admin", "read"],
        log: ["read", "admin"],
        // Never carried an admin action, so it must come through untouched.
        toolPolicy: ["read", "create", "update"],
      },
    });
    await runMigration();
    const [row] = await db
      .select()
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(row.id).toBe(role.id);
    expect(row.role).toBe(role.role);
    expect(JSON.parse(row.permission)).toEqual({
      agent: ["read", "update"],
      mcpGateway: [],
      mcpRegistry: ["create"],
      skill: ["read"],
      app: ["delete"],
      knowledgeSource: ["read"],
      project: ["read"],
      log: ["read"],
      toolPolicy: ["read", "create", "update"],
    });
    await runMigration();
    const [replayed] = await db
      .select()
      .from(schema.organizationRolesTable)
      .where(eq(schema.organizationRolesTable.id, role.id));
    expect(replayed).toEqual(row);
  });

  test("rolls back the Editor grant change when a later statement fails", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const key = {
      organizationId: org.id,
      resource: "llmModel" as const,
      scope: "*",
    };
    const initial = await ResourcePermissionPolicyModel.find(key);
    await ResourcePermissionPolicyModel.replace({
      ...key,
      revision: initial?.revision ?? 0,
      grants: [],
    });
    const before = await ResourcePermissionPolicyModel.find(key);
    await expect(
      db.transaction(async (tx) => {
        // The whole conversion runs in one transaction, so a later failure
        // must leave the earlier statements with nothing written.
        for (const statement of ROLE_RETIREMENT_STATEMENTS)
          await tx.execute(statement);
        throw new Error("simulated later cutover failure");
      }),
    ).rejects.toThrow("simulated later cutover failure");
    expect(await ResourcePermissionPolicyModel.find(key)).toEqual(before);
    await runMigration();
    expect((await ResourcePermissionPolicyModel.find(key))?.grants).toEqual([
      {
        subject: { type: "role", id: "editor" },
        actions: ["manage-permissions", "read", "update", "use"],
      },
    ]);
  });
});
