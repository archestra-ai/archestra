import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0393_drop_mcp_server_installation_request.sql"),
  "utf-8",
);

/**
 * Only the custom-role permission cleanup is exercised here. The `DROP TABLE`
 * runs against the real database at migrate time; replaying it inside the test
 * database would remove a table the shared PGlite snapshot still carries for
 * other tests in the same worker.
 */
async function runPermissionCleanup() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("UPDATE"));

  if (statements.length === 0) {
    throw new Error("Migration UPDATE statement not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
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

describe("0393 drop mcp_server_installation_request", () => {
  test("strips the removed resource from a custom role, leaving its other permissions intact", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-with-requests",
      permission: {
        mcpServerInstallationRequest: ["read", "create", "admin"],
        mcpServerInstallation: ["read", "create"],
        agent: ["read"],
      },
    });

    await runPermissionCleanup();

    const permission = await getRolePermission("role-with-requests");
    expect(permission.mcpServerInstallationRequest).toBeUndefined();
    expect(permission.mcpServerInstallation).toEqual(["read", "create"]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("leaves roles without the resource untouched, and is idempotent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-without-requests",
      permission: { agent: ["read"], mcpRegistry: ["read"] },
    });

    await runPermissionCleanup();
    await runPermissionCleanup();

    const permission = await getRolePermission("role-without-requests");
    expect(permission).toEqual({ agent: ["read"], mcpRegistry: ["read"] });
  });
});
