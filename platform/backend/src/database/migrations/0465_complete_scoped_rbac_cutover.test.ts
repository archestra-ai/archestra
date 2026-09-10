// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0465_complete_scoped_rbac_cutover.sql"),
  "utf8",
);

async function runMigration() {
  await db.transaction(async (tx) => {
    for (const statement of migration.split("--> statement-breakpoint")) {
      await tx.execute(sql.raw(statement));
    }
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
        knowledgeSource: ["admin", "read", "team-admin"],
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
      knowledgeSource: ["admin", "read", "team-admin"],
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
        await tx.execute(
          sql.raw(migration.split("--> statement-breakpoint")[0]),
        );
        throw new Error("simulated later migration failure");
      }),
    ).rejects.toThrow("simulated later migration failure");
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
