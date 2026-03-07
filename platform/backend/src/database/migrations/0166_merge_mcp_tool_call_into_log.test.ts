import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0166_merge_mcp_tool_call_into_log.sql"),
  "utf-8",
);

async function insertRole(
  organizationId: string,
  roleId: string,
  roleName: string,
  permission: Record<string, string[]>,
) {
  await db.insert(schema.organizationRolesTable).values({
    id: roleId,
    organizationId,
    role: roleName,
    name: roleName,
    permission: JSON.stringify(permission),
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

describe("0166 migration: rename RBAC resources", () => {
  test("merges tool + policy into toolPolicy", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-merge-1", "test_merge_1", {
      tool: ["read", "create"],
      policy: ["read", "update", "delete"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-merge-1");
    expect(perm.toolPolicy).toBeDefined();
    expect(perm.tool).toBeUndefined();
    expect(perm.policy).toBeUndefined();
  });

  test("renames policy to toolPolicy when no tool key exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-policy-only", "test_policy_only", {
      policy: ["read"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-policy-only");
    expect(perm.toolPolicy).toEqual(["read"]);
    expect(perm.policy).toBeUndefined();
  });

  test("renames llmCosts to llmCost", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-costs", "test_costs", {
      llmCosts: ["read"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-costs");
    expect(perm.llmCost).toEqual(["read"]);
    expect(perm.llmCosts).toBeUndefined();
  });

  test("renames secrets to secret", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-secrets", "test_secrets", {
      secrets: ["read", "update"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-secrets");
    expect(perm.secret).toEqual(["read", "update"]);
    expect(perm.secrets).toBeUndefined();
  });

  test("renames agentTriggers to agentTrigger", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-triggers", "test_triggers", {
      agentTriggers: ["read", "create"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-triggers");
    expect(perm.agentTrigger).toEqual(["read", "create"]);
    expect(perm.agentTriggers).toBeUndefined();
  });

  test("removes organization key", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-org", "test_org", {
      organization: ["read"],
      agent: ["read"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-org");
    expect(perm.organization).toBeUndefined();
    expect(perm.agent).toEqual(["read"]);
  });

  test("renames llmLimits to llmLimit", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-limits", "test_limits", {
      llmLimits: ["read"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-limits");
    expect(perm.llmLimit).toEqual(["read"]);
    expect(perm.llmLimits).toBeUndefined();
  });

  test("renames llmProviders to llmProvider", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-providers", "test_providers", {
      llmProviders: ["read", "create"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-providers");
    expect(perm.llmProvider).toEqual(["read", "create"]);
    expect(perm.llmProviders).toBeUndefined();
  });

  test("handles role with multiple renames at once", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-multi", "test_multi", {
      tool: ["read", "create"],
      policy: ["read"],
      llmCosts: ["read"],
      secrets: ["read", "update"],
      agentTriggers: ["read"],
      organization: ["read"],
      llmProviders: ["read"],
    });

    await db.execute(sql.raw(migrationSql));

    const perm = await getRolePermission("test-multi");
    expect(perm.toolPolicy).toBeDefined();
    expect(perm.llmCost).toEqual(["read"]);
    expect(perm.secret).toEqual(["read", "update"]);
    expect(perm.agentTrigger).toEqual(["read"]);
    expect(perm.llmProvider).toEqual(["read"]);
    // Old keys removed
    expect(perm.tool).toBeUndefined();
    expect(perm.policy).toBeUndefined();
    expect(perm.llmCosts).toBeUndefined();
    expect(perm.secrets).toBeUndefined();
    expect(perm.agentTriggers).toBeUndefined();
    expect(perm.organization).toBeUndefined();
    expect(perm.llmProviders).toBeUndefined();
  });
});
