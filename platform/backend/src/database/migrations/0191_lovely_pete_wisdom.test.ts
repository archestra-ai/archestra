import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0191_lovely_pete_wisdom.sql"),
  "utf-8",
);

async function runPermissionCleanupStatements() {
  const statements = migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.includes('UPDATE "organization_role"') &&
        statement.includes('"permission"'),
    );

  for (const statement of statements) {
    await db.execute(sql.raw(`${statement};`));
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

describe("0191 migration: dual LLM built-in agent cleanup", () => {
  test("removes stale dualLlmConfig permission key", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-dual-llm-config",
      roleName: "test_dual_llm_config",
      permission: {
        dualLlmConfig: ["read", "update"],
        llmSettings: ["read"],
      },
    });

    await runPermissionCleanupStatements();

    const permission = await getRolePermission("test-dual-llm-config");
    expect(permission.dualLlmConfig).toBeUndefined();
    expect(permission.llmSettings).toEqual(["read"]);
  });

  test("removes stale dualLlmResult permission key", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-dual-llm-result",
      roleName: "test_dual_llm_result",
      permission: {
        dualLlmResult: ["read"],
        log: ["read"],
      },
    });

    await runPermissionCleanupStatements();

    const permission = await getRolePermission("test-dual-llm-result");
    expect(permission.dualLlmResult).toBeUndefined();
    expect(permission.log).toEqual(["read"]);
  });

  test("removes both stale dual LLM permission keys in one role", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-dual-llm-both",
      roleName: "test_dual_llm_both",
      permission: {
        dualLlmConfig: ["read"],
        dualLlmResult: ["read"],
        agent: ["read", "update"],
      },
    });

    await runPermissionCleanupStatements();

    const permission = await getRolePermission("test-dual-llm-both");
    expect(permission.dualLlmConfig).toBeUndefined();
    expect(permission.dualLlmResult).toBeUndefined();
    expect(permission.agent).toEqual(["read", "update"]);
  });
});
