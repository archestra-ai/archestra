import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0167_merge_mcp_tool_call_into_log.sql"),
  "utf-8",
);

/**
 * PGlite doesn't support multiple statements in a single db.execute().
 * Split on semicolons, filter out comments and empty lines, and run each statement.
 */
async function runMigration() {
  const statements = migrationSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.includes("UPDATE"));

  for (const statement of statements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

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

describe("0167 migration: rename RBAC resources", () => {
  // Step 1
  test("renames interaction to log", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-interaction", "test_interaction", {
      interaction: ["read", "create"],
    });

    await runMigration();

    const perm = await getRolePermission("test-interaction");
    expect(perm.log).toEqual(["read", "create"]);
    expect(perm.interaction).toBeUndefined();
  });

  // Step 2
  test("renames internalMcpCatalog to mcpRegistry", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-catalog", "test_catalog", {
      internalMcpCatalog: ["read", "create", "update", "delete"],
    });

    await runMigration();

    const perm = await getRolePermission("test-catalog");
    expect(perm.mcpRegistry).toEqual(["read", "create", "update", "delete"]);
    expect(perm.internalMcpCatalog).toBeUndefined();
  });

  // Step 3
  test("renames conversation to chat", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-conversation", "test_conversation", {
      conversation: ["read", "create", "update", "delete"],
    });

    await runMigration();

    const perm = await getRolePermission("test-conversation");
    expect(perm.chat).toEqual(["read", "create", "update", "delete"]);
    expect(perm.conversation).toBeUndefined();
  });

  // Step 4
  test("merges mcpToolCall into log when log absent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-toolcall-only", "test_toolcall_only", {
      mcpToolCall: ["read"],
    });

    await runMigration();

    const perm = await getRolePermission("test-toolcall-only");
    expect(perm.log).toEqual(["read"]);
    expect(perm.mcpToolCall).toBeUndefined();
  });

  test("unions mcpToolCall actions into log when log already exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-toolcall-log", "test_toolcall_log", {
      mcpToolCall: ["read"],
      interaction: ["read", "create"],
    });

    await runMigration();

    // interaction was renamed to log in step 1, then mcpToolCall unioned in step 4b
    const perm = await getRolePermission("test-toolcall-log");
    expect(perm.log.sort()).toEqual(["create", "read"]);
    expect(perm.mcpToolCall).toBeUndefined();
    expect(perm.interaction).toBeUndefined();
  });

  // Step 5
  test("renames chatSettings to llmProvider", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-chatsettings", "test_chatsettings", {
      chatSettings: ["read", "update"],
    });

    await runMigration();

    const perm = await getRolePermission("test-chatsettings");
    expect(perm.llmProvider).toEqual(["read", "update"]);
    expect(perm.chatSettings).toBeUndefined();
  });

  // Steps 6-7
  test("renames llmModels to llmProvider when chatSettings absent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-llmmodels", "test_llmmodels", {
      llmModels: ["read", "create"],
    });

    await runMigration();

    const perm = await getRolePermission("test-llmmodels");
    expect(perm.llmProvider).toEqual(["read", "create"]);
    expect(perm.llmModels).toBeUndefined();
  });

  test("unions llmModels into llmProvider when chatSettings already renamed", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-both-llm", "test_both_llm", {
      chatSettings: ["read", "update"],
      llmModels: ["read", "create"],
    });

    await runMigration();

    // chatSettings renamed to llmProvider in step 5, llmModels unioned in step 7
    const perm = await getRolePermission("test-both-llm");
    expect(perm.llmProvider.sort()).toEqual(["create", "read", "update"]);
    expect(perm.llmModels).toBeUndefined();
    expect(perm.chatSettings).toBeUndefined();
  });

  // Step 8
  test("renames mcpServer to mcpServerInstallation", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-mcpserver", "test_mcpserver", {
      mcpServer: ["read", "create", "delete"],
    });

    await runMigration();

    const perm = await getRolePermission("test-mcpserver");
    expect(perm.mcpServerInstallation).toEqual(["read", "create", "delete"]);
    expect(perm.mcpServer).toBeUndefined();
  });

  test("does not overwrite existing mcpServerInstallation", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole(
      org.id,
      "test-mcpserver-existing",
      "test_mcpserver_existing",
      {
        mcpServer: ["read"],
        mcpServerInstallation: ["read", "create", "delete"],
      },
    );

    await runMigration();

    const perm = await getRolePermission("test-mcpserver-existing");
    // Should keep existing mcpServerInstallation, not overwrite
    expect(perm.mcpServerInstallation).toEqual(["read", "create", "delete"]);
    // mcpServer should still be present since the guard prevented the rename
    // (it will be cleaned up by schema validation on next role update)
  });

  // Step 9
  test("renames limit to llmLimit", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    await insertRole(org.id, "test-limit", "test_limit", {
      limit: ["read", "create"],
    });

    await runMigration();

    const perm = await getRolePermission("test-limit");
    expect(perm.llmLimit).toEqual(["read", "create"]);
    expect(perm.limit).toBeUndefined();
  });

  test("unions limit and llmLimits into llmLimit", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    // Role has both limit and llmLimits — limit should rename to llmLimit (step 9),
    // then llmLimits should union into llmLimit (step 13b)
    await insertRole(org.id, "test-limit-vs-limits", "test_limit_vs_limits", {
      limit: ["read"],
      llmLimits: ["read", "update"],
    });

    await runMigration();

    const perm = await getRolePermission("test-limit-vs-limits");
    // Step 9: limit -> llmLimit with ["read"]
    // Step 13b: llmLimits unioned into llmLimit -> ["read", "update"]
    expect(perm.llmLimit.sort()).toEqual(["read", "update"]);
    expect(perm.limit).toBeUndefined();
    expect(perm.llmLimits).toBeUndefined();
  });

  // Step 10: tool + policy -> toolPolicy (UNION of action arrays)
  test("merges tool + policy into toolPolicy with union of actions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-merge-union", "test_merge_union", {
      tool: ["read", "create"],
      policy: ["read", "update", "delete"],
    });

    await runMigration();

    const perm = await getRolePermission("test-merge-union");
    // Should be the union of both: read, create, update, delete
    expect(perm.toolPolicy).toBeDefined();
    expect(perm.toolPolicy.sort()).toEqual([
      "create",
      "delete",
      "read",
      "update",
    ]);
    expect(perm.tool).toBeUndefined();
    expect(perm.policy).toBeUndefined();
  });

  // Step 10b: tool only -> toolPolicy
  test("renames tool to toolPolicy when no policy key exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-tool-only", "test_tool_only", {
      tool: ["read", "create"],
    });

    await runMigration();

    const perm = await getRolePermission("test-tool-only");
    expect(perm.toolPolicy).toEqual(["read", "create"]);
    expect(perm.tool).toBeUndefined();
  });

  // Step 11
  test("renames policy to toolPolicy when no tool key exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-policy-only", "test_policy_only", {
      policy: ["read"],
    });

    await runMigration();

    const perm = await getRolePermission("test-policy-only");
    expect(perm.toolPolicy).toEqual(["read"]);
    expect(perm.policy).toBeUndefined();
  });

  // Step 12
  test("renames llmCosts to llmCost", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-costs", "test_costs", {
      llmCosts: ["read"],
    });

    await runMigration();

    const perm = await getRolePermission("test-costs");
    expect(perm.llmCost).toEqual(["read"]);
    expect(perm.llmCosts).toBeUndefined();
  });

  // Step 13
  test("renames llmLimits to llmLimit", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-limits", "test_limits", {
      llmLimits: ["read"],
    });

    await runMigration();

    const perm = await getRolePermission("test-limits");
    expect(perm.llmLimit).toEqual(["read"]);
    expect(perm.llmLimits).toBeUndefined();
  });

  // Step 14
  test("renames llmProviders to llmProvider", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-providers", "test_providers", {
      llmProviders: ["read", "create"],
    });

    await runMigration();

    const perm = await getRolePermission("test-providers");
    expect(perm.llmProvider).toEqual(["read", "create"]);
    expect(perm.llmProviders).toBeUndefined();
  });

  test("unions llmProviders into llmProvider when llmProvider already exists", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    // chatSettings renames to llmProvider in step 5, llmProviders should union in step 14b
    await insertRole(
      org.id,
      "test-providers-conflict",
      "test_providers_conflict",
      {
        chatSettings: ["read"],
        llmProviders: ["read", "create", "update"],
      },
    );

    await runMigration();

    const perm = await getRolePermission("test-providers-conflict");
    expect(perm.llmProvider.sort()).toEqual(["create", "read", "update"]);
    expect(perm.llmProviders).toBeUndefined();
    expect(perm.chatSettings).toBeUndefined();
  });

  // Step 15
  test("renames secrets to secret", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-secrets", "test_secrets", {
      secrets: ["read", "update"],
    });

    await runMigration();

    const perm = await getRolePermission("test-secrets");
    expect(perm.secret).toEqual(["read", "update"]);
    expect(perm.secrets).toBeUndefined();
  });

  // Step 16
  test("renames agentTriggers to agentTrigger", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-triggers", "test_triggers", {
      agentTriggers: ["read", "create"],
    });

    await runMigration();

    const perm = await getRolePermission("test-triggers");
    expect(perm.agentTrigger).toEqual(["read", "create"]);
    expect(perm.agentTriggers).toBeUndefined();
  });

  // Step 17
  test("removes organization key", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-org", "test_org", {
      organization: ["read"],
      agent: ["read"],
    });

    await runMigration();

    const perm = await getRolePermission("test-org");
    expect(perm.organization).toBeUndefined();
    expect(perm.agent).toEqual(["read"]);
  });

  // Integration: multiple renames at once
  test("handles role with multiple renames at once", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await insertRole(org.id, "test-multi", "test_multi", {
      interaction: ["read"],
      internalMcpCatalog: ["read", "create"],
      conversation: ["read", "create", "update", "delete"],
      mcpToolCall: ["read"],
      chatSettings: ["read"],
      mcpServer: ["read", "create", "delete"],
      limit: ["read", "create"],
      tool: ["read", "create"],
      policy: ["read", "update", "delete"],
      llmCosts: ["read"],
      secrets: ["read", "update"],
      agentTriggers: ["read"],
      organization: ["read"],
    });

    await runMigration();

    const perm = await getRolePermission("test-multi");
    // Renamed resources
    expect(perm.log).toEqual(["read"]);
    expect(perm.mcpRegistry).toEqual(["read", "create"]);
    expect(perm.chat).toEqual(["read", "create", "update", "delete"]);
    expect(perm.llmProvider).toEqual(["read"]);
    expect(perm.mcpServerInstallation).toEqual(["read", "create", "delete"]);
    expect(perm.llmLimit).toEqual(["read", "create"]);
    expect(perm.toolPolicy).toBeDefined();
    expect(perm.toolPolicy.sort()).toEqual([
      "create",
      "delete",
      "read",
      "update",
    ]);
    expect(perm.llmCost).toEqual(["read"]);
    expect(perm.secret).toEqual(["read", "update"]);
    expect(perm.agentTrigger).toEqual(["read"]);
    // Old keys removed
    expect(perm.interaction).toBeUndefined();
    expect(perm.internalMcpCatalog).toBeUndefined();
    expect(perm.conversation).toBeUndefined();
    expect(perm.mcpToolCall).toBeUndefined();
    expect(perm.chatSettings).toBeUndefined();
    expect(perm.mcpServer).toBeUndefined();
    expect(perm.limit).toBeUndefined();
    expect(perm.tool).toBeUndefined();
    expect(perm.policy).toBeUndefined();
    expect(perm.llmCosts).toBeUndefined();
    expect(perm.secrets).toBeUndefined();
    expect(perm.agentTriggers).toBeUndefined();
    expect(perm.organization).toBeUndefined();
  });
});
