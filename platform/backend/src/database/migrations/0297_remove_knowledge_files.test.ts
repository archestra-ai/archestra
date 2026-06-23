import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0297_remove_knowledge_files.sql"),
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
    // The test database already has every migration applied, so the destructive
    // DROP TABLE has already run — re-running it would error. We only exercise
    // the RBAC cleanup (and the idempotent connector DELETE) here.
    if (statement.startsWith('DROP TABLE "kb_uploaded_files"')) {
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

describe("0297 migration: remove knowledgeFile RBAC resource", () => {
  test("removes the knowledgeFile resource while preserving others", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-remove-knowledge-file",
      roleName: "test_remove_knowledge_file",
      permission: {
        knowledgeFile: ["read", "create", "update", "delete"],
        knowledgeSource: ["read", "query"],
        agent: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-remove-knowledge-file");
    expect(permission.knowledgeFile).toBeUndefined();
    expect(permission.knowledgeSource).toEqual(["read", "query"]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("removes the knowledgeFile key when it was the only resource", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-remove-only-knowledge-file",
      roleName: "test_remove_only_knowledge_file",
      permission: {
        knowledgeFile: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission(
      "test-remove-only-knowledge-file",
    );
    expect(permission.knowledgeFile).toBeUndefined();
    expect(permission).toEqual({});
  });

  test("leaves roles without knowledgeFile unchanged", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-preserve-without-knowledge-file",
      roleName: "test_preserve_without_knowledge_file",
      permission: {
        knowledgeSource: ["read", "create"],
        tool: ["admin"],
      },
    });

    await runMigration();

    const permission = await getRolePermission(
      "test-preserve-without-knowledge-file",
    );
    expect(permission.knowledgeSource).toEqual(["read", "create"]);
    expect(permission.tool).toEqual(["admin"]);
  });
});
