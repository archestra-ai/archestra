import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0390_log_admin_split.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("UPDATE"));

  if (statements.length === 0) {
    throw new Error("Migration statements not found");
  }

  for (const statement of statements) {
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
  return JSON.parse(role.permission as unknown as string);
}

describe("0390_log_admin_split custom-role backfill", () => {
  test("roles holding log:read / auditLog:read gain the matching :admin — behavior preserved", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-log-reader",
      roleName: "log_reader",
      permission: { log: ["read"], auditLog: ["read"], agent: ["read"] },
    });

    await runMigration();

    const permission = await getRolePermission("role-log-reader");
    expect(permission.log).toEqual(["read", "admin"]);
    expect(permission.auditLog).toEqual(["read", "admin"]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("roles without the read actions — and already-admin roles — are untouched; the backfill is idempotent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-no-logs",
      roleName: "no_logs",
      permission: { agent: ["read"] },
    });
    await insertRole({
      organizationId: org.id,
      roleId: "role-already-admin",
      roleName: "already_admin",
      permission: { log: ["read", "admin"] },
    });

    await runMigration();
    await runMigration();

    expect((await getRolePermission("role-no-logs")).log).toBeUndefined();
    expect((await getRolePermission("role-already-admin")).log).toEqual([
      "read",
      "admin",
    ]);
  });
});
