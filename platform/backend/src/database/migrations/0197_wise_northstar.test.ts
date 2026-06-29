import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0197_wise_northstar.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = Array.from(
    migrationSql.matchAll(/UPDATE "organization_role"[\s\S]*?;/g),
    (match) => match[0].trim(),
  );

  for (const statement of statements) {
    await db.execute(sql.raw(`${statement};`));
  }
}

async function runScopeDataMigration() {
  const match = migrationSql.match(
    /UPDATE "chat_api_keys"[\s\S]*?WHERE "scope" = 'org_wide';/m,
  );

  if (!match) {
    throw new Error("chat_api_keys scope update statement not found in 0197");
  }

  await db.execute(sql.raw(match[0].trim()));
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

describe("0197 migration: split llmProvider RBAC resource", () => {
  test("seeds all three new resources from llmProvider and removes the legacy key", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-split-llm-provider",
      roleName: "test_split_llm_provider",
      permission: {
        llmProvider: ["read", "create", "update", "delete", "admin"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-split-llm-provider");
    expect(permission.llmProvider).toBeUndefined();
    expect(permission.llmProviderApiKey.sort()).toEqual([
      "admin",
      "create",
      "delete",
      "read",
      "update",
    ]);
    expect(permission.llmVirtualKey.sort()).toEqual([
      "admin",
      "create",
      "delete",
      "read",
      "update",
    ]);
    expect(permission.llmModel.sort()).toEqual(["read", "update"]);
  });

  test("grants llmVirtualKey:admin when legacy llmProvider:create was present", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-virtual-admin-from-create",
      roleName: "test_virtual_admin_from_create",
      permission: {
        llmProvider: ["create"],
      },
    });

    await runMigration();

    const permission = await getRolePermission(
      "test-virtual-admin-from-create",
    );
    expect(permission.llmProviderApiKey).toEqual(["create"]);
    expect(permission.llmVirtualKey.sort()).toEqual(["admin", "create"]);
    expect(permission.llmModel).toEqual([]);
  });

  test("unions into any already-present new resource permissions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-llm-provider-union",
      roleName: "test_llm_provider_union",
      permission: {
        llmProvider: ["read", "update"],
        llmProviderApiKey: ["delete"],
        llmVirtualKey: ["delete"],
        llmModel: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-llm-provider-union");
    expect(permission.llmProvider).toBeUndefined();
    expect(permission.llmProviderApiKey.sort()).toEqual([
      "delete",
      "read",
      "update",
    ]);
    expect(permission.llmVirtualKey.sort()).toEqual([
      "delete",
      "read",
      "update",
    ]);
    expect(permission.llmModel.sort()).toEqual(["read", "update"]);
  });

  test("updates legacy org_wide LLM provider API key scopes to org", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await db.execute(
      sql.raw(`
      INSERT INTO "chat_api_keys" (
        "id",
        "organization_id",
        "name",
        "provider",
        "scope",
        "is_primary",
        "created_at",
        "updated_at"
      ) VALUES (
        '00000000-0000-0000-0000-000000000197',
        '${org.id}',
        'Legacy Org Key',
        'anthropic',
        'org_wide',
        true,
        now(),
        now()
      );
    `),
    );

    await runScopeDataMigration();

    const [apiKey] = await db
      .select({ scope: schema.llmProviderApiKeysTable.scope })
      .from(schema.llmProviderApiKeysTable)
      .where(
        sql`${schema.llmProviderApiKeysTable.id} = '00000000-0000-0000-0000-000000000197'`,
      );

    expect(apiKey.scope).toBe("org");
  });
});
