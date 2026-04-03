import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0203_last_killmonger.sql"),
  "utf-8",
);

async function runPermissionMigrationStatements() {
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

describe("0203 migration: knowledgeBase RBAC normalization", () => {
  test("renames knowledgeBases to knowledgeBase", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-knowledge-bases-rename",
      roleName: "test_knowledge_bases_rename",
      permission: {
        knowledgeBases: ["read", "create", "update"],
        agent: ["read"],
      },
    });

    await runPermissionMigrationStatements();

    const permission = await getRolePermission("test-knowledge-bases-rename");
    expect(permission.knowledgeBases).toBeUndefined();
    expect(permission.knowledgeBase.sort()).toEqual([
      "create",
      "read",
      "update",
    ]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("renames knowledgeSources to knowledgeBase", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-knowledge-sources-rename",
      roleName: "test_knowledge_sources_rename",
      permission: {
        knowledgeSources: ["read", "query"],
        log: ["read"],
      },
    });

    await runPermissionMigrationStatements();

    const permission = await getRolePermission("test-knowledge-sources-rename");
    expect(permission.knowledgeSources).toBeUndefined();
    expect(permission.knowledgeBase.sort()).toEqual(["query", "read"]);
    expect(permission.log).toEqual(["read"]);
  });

  test("unions legacy knowledge keys into existing knowledgeBase", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-knowledge-union",
      roleName: "test_knowledge_union",
      permission: {
        knowledgeBases: ["create", "delete"],
        knowledgeSources: ["query", "read"],
        knowledgeBase: ["admin", "update"],
      },
    });

    await runPermissionMigrationStatements();

    const permission = await getRolePermission("test-knowledge-union");
    expect(permission.knowledgeBases).toBeUndefined();
    expect(permission.knowledgeSources).toBeUndefined();
    expect(permission.knowledgeBase.sort()).toEqual([
      "admin",
      "create",
      "delete",
      "query",
      "read",
      "update",
    ]);
  });
});
