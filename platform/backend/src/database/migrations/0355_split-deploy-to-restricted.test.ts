import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0355_split-deploy-to-restricted.sql"),
  "utf-8",
);

const DEPLOY_RESOURCES = [
  "agent",
  "llmProxy",
  "mcpGateway",
  "app",
  "skill",
  "knowledgeSource",
  "mcpRegistry",
] as const;

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    // Section-header chunks are comment-only; only execute real statements.
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

  return JSON.parse(role.permission);
}

describe("0355 migration: split deploy-to-restricted + environment admin -> CRUD", () => {
  test("a role with the legacy environment:deploy-to-restricted gains every per-resource action", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-legacy-deploy",
      roleName: "test_legacy_deploy",
      permission: {
        environment: ["deploy-to-restricted"],
        agent: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-legacy-deploy");
    // Pre-existing agent actions are preserved; the new action is appended.
    expect(permission.agent).toEqual(["read", "deploy-to-restricted"]);
    for (const resource of DEPLOY_RESOURCES) {
      expect(permission[resource]).toContain("deploy-to-restricted");
    }
    // The legacy action is stripped; the universal read grant remains.
    expect(permission.environment).toEqual(["read"]);
  });

  test("a role with environment:admin gains CRUD, read, and every deploy-to-restricted action", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-env-admin",
      roleName: "test_env_admin",
      permission: {
        environment: ["admin"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-env-admin");
    expect([...permission.environment].sort()).toEqual([
      "create",
      "delete",
      "read",
      "update",
    ]);
    expect(permission.environment).not.toContain("admin");
    // environment:admin used to imply deploy-to-restricted on everything.
    for (const resource of DEPLOY_RESOURCES) {
      expect(permission[resource]).toEqual(["deploy-to-restricted"]);
    }
  });

  test("a role with both admin and deploy-to-restricted gets no duplicate actions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-admin-and-deploy",
      roleName: "test_admin_and_deploy",
      permission: {
        environment: ["admin", "deploy-to-restricted"],
        mcpRegistry: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-admin-and-deploy");
    expect([...permission.environment].sort()).toEqual([
      "create",
      "delete",
      "read",
      "update",
    ]);
    expect(permission.mcpRegistry).toEqual(["read", "deploy-to-restricted"]);
    for (const resource of DEPLOY_RESOURCES) {
      expect(
        permission[resource].filter(
          (action) => action === "deploy-to-restricted",
        ),
      ).toHaveLength(1);
    }
  });

  test("a role without an environment entry only gains environment:read", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-no-env",
      roleName: "test_no_env",
      permission: {
        agent: ["read", "create"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-no-env");
    expect(permission.environment).toEqual(["read"]);
    expect(permission.agent).toEqual(["read", "create"]);
  });

  test("a role that already has environment:read is left without duplicates", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-already-read",
      roleName: "test_already_read",
      permission: {
        environment: ["read"],
        skill: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-already-read");
    expect(permission.environment).toEqual(["read"]);
    expect(permission.skill).toEqual(["read"]);
  });
});
