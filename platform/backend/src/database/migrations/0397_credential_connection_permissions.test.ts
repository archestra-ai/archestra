import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0397_credential_connection_permissions.sql"),
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

describe("0397_credential_connection_permissions custom-role backfill", () => {
  test("roles holding mcpServerInstallation:admin gain use — capability preserved", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-mcp-admin",
      roleName: "mcp_admin",
      permission: {
        mcpServerInstallation: ["read", "create", "admin"],
        agent: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("role-mcp-admin");
    expect(permission.credentialConnection).toEqual(["use"]);
    expect(permission.mcpServerInstallation).toEqual([
      "read",
      "create",
      "admin",
    ]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("roles without mcpServerInstallation:admin gain nothing — they never saw others' connections", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-installer",
      roleName: "installer",
      permission: { mcpServerInstallation: ["read", "create", "delete"] },
    });

    await runMigration();

    expect(
      (await getRolePermission("role-installer")).credentialConnection,
    ).toBeUndefined();
  });

  test("is idempotent and leaves an already-granted role alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-already",
      roleName: "already",
      permission: {
        mcpServerInstallation: ["admin"],
        credentialConnection: ["use"],
      },
    });

    await runMigration();
    await runMigration();

    // Left exactly as configured — no duplicate appended on a re-run.
    expect(
      (await getRolePermission("role-already")).credentialConnection,
    ).toEqual(["use"]);
  });
});
