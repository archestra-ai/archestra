import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0281_remove_team_admin_rbac_action.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length === 0) {
    throw new Error("Migration statement not found");
  }

  for (const statement of statements) {
    if (
      statement.startsWith(
        'CREATE UNIQUE INDEX "team_member_team_id_user_id_unique_idx"',
      )
    ) {
      continue;
    }

    await db.execute(sql.raw(statement));
  }
}

async function insertRole(params: {
  organizationId: string;
  roleId: string;
  roleName: string;
  permission: Record<string, string[]>;
}) {
  await db.insert(schema.organizationRolesTable).values({
    id: params.roleId,
    organizationId: params.organizationId,
    role: params.roleName,
    name: params.roleName,
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

  return JSON.parse(role.permission);
}

describe("0281 migration: remove team admin RBAC action", () => {
  test("removes team:admin while preserving other team actions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-remove-team-admin",
      roleName: "test_remove_team_admin",
      permission: {
        team: ["read", "update", "admin"],
        agent: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-remove-team-admin");
    expect(permission.team).toEqual(["read", "update"]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("removes the team key when admin was the only team action", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-remove-empty-team",
      roleName: "test_remove_empty_team",
      permission: {
        team: ["admin"],
        mcpGateway: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-remove-empty-team");
    expect(permission.team).toBeUndefined();
    expect(permission.mcpGateway).toEqual(["read"]);
  });

  test("leaves roles without team:admin unchanged", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-preserve-without-team-admin",
      roleName: "test_preserve_without_team_admin",
      permission: {
        team: ["read", "update"],
        tool: ["admin"],
      },
    });

    await runMigration();

    const permission = await getRolePermission(
      "test-preserve-without-team-admin",
    );
    expect(permission.team).toEqual(["read", "update"]);
    expect(permission.tool).toEqual(["admin"]);
  });
});
