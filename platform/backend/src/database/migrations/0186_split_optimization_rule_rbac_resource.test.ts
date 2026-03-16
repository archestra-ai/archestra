import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0186_split_optimization_rule_rbac_resource.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("UPDATE"));

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

describe("0186 migration: split optimization rule RBAC resource", () => {
  test("removes stale securitySettings permission key", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-security-settings",
      roleName: "test_security_settings",
      permission: {
        securitySettings: ["read", "update"],
        llmLimit: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-security-settings");
    expect(permission.securitySettings).toBeUndefined();
    expect(permission.llmLimit).toEqual(["read"]);
  });

  test("seeds optimizationRule from llmLimit and llmProxy when missing", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-seed-optimization-rule",
      roleName: "test_seed_optimization_rule",
      permission: {
        llmLimit: ["read", "update"],
        llmProxy: ["read", "create"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-seed-optimization-rule");
    expect(permission.optimizationRule.sort()).toEqual([
      "create",
      "read",
      "update",
    ]);
    expect(permission.llmLimit).toEqual(["read", "update"]);
    expect(permission.llmProxy).toEqual(["read", "create"]);
  });

  test("unions llmLimit into existing optimizationRule", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-union-llm-limit",
      roleName: "test_union_llm_limit",
      permission: {
        optimizationRule: ["read"],
        llmLimit: ["read", "update", "delete"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-union-llm-limit");
    expect(permission.optimizationRule.sort()).toEqual([
      "delete",
      "read",
      "update",
    ]);
  });

  test("unions llmProxy into existing optimizationRule", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-union-llm-proxy",
      roleName: "test_union_llm_proxy",
      permission: {
        optimizationRule: ["read"],
        llmProxy: ["create", "read", "update"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-union-llm-proxy");
    expect(permission.optimizationRule.sort()).toEqual([
      "create",
      "read",
      "update",
    ]);
  });
});
