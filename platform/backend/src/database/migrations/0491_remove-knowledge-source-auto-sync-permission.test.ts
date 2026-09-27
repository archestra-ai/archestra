import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0491_remove-knowledge-source-auto-sync-permission.sql"),
  "utf-8",
);

async function runPermissionCleanup() {
  await db.execute(sql.raw(migrationSql));
}

async function insertRole(params: {
  organizationId: string;
  roleId: string;
  permission: Record<string, string[]>;
}) {
  await db.insert(schema.organizationRolesTable).values({
    id: params.roleId,
    organizationId: params.organizationId,
    role: params.roleId,
    name: params.roleId,
    permission: JSON.stringify(params.permission),
  });
}

async function getRolePermission(
  roleId: string,
): Promise<Record<string, string[]>> {
  const [role] = await db
    .select({ permission: schema.organizationRolesTable.permission })
    .from(schema.organizationRolesTable)
    .where(sql`${schema.organizationRolesTable.id} = ${roleId}`);
  return JSON.parse(role.permission as unknown as string);
}

describe("0491 remove knowledge source auto-sync permission", () => {
  test("removes the old resource while preserving connector and other permissions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-with-auto-sync-permission",
      permission: {
        knowledgeSourceAutoSync: ["read", "create", "update", "delete"],
        knowledgeSource: ["read", "create", "update"],
        agent: ["read"],
      },
    });

    await runPermissionCleanup();
    await runPermissionCleanup();

    expect(await getRolePermission("role-with-auto-sync-permission")).toEqual({
      knowledgeSource: ["read", "create", "update"],
      agent: ["read"],
    });
  });

  test("keeps roles without the old resource unchanged", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-without-auto-sync-permission",
      permission: { knowledgeSource: ["read"] },
    });

    await runPermissionCleanup();

    expect(
      await getRolePermission("role-without-auto-sync-permission"),
    ).toEqual({ knowledgeSource: ["read"] });
  });
});
