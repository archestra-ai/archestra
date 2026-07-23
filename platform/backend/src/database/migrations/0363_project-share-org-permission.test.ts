import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0363_project-share-org-permission.sql"),
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

  return JSON.parse(role.permission);
}

describe("0363 migration: backfill project:share-org onto custom roles", () => {
  test("a role with project:update gains share-org, preserving other actions", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-project-update",
      roleName: "test_project_update",
      permission: {
        project: ["read", "create", "update"],
        agent: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-project-update");
    expect(permission.project).toEqual([
      "read",
      "create",
      "update",
      "share-org",
    ]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("a role with only project:delete gains share-org", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-project-delete",
      roleName: "test_project_delete",
      permission: {
        project: ["read", "delete"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-project-delete");
    expect(permission.project).toEqual(["read", "delete", "share-org"]);
  });

  test("a role with read-only project access is unchanged", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-project-read",
      roleName: "test_project_read",
      permission: {
        project: ["read"],
        chat: ["read", "update", "delete"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-project-read");
    expect(permission.project).toEqual(["read"]);
    expect(permission.chat).toEqual(["read", "update", "delete"]);
  });

  test("a role without a project entry is unchanged", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-no-project",
      roleName: "test_no_project",
      permission: {
        agent: ["read", "update", "delete"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-no-project");
    expect(permission.project).toBeUndefined();
    expect(permission.agent).toEqual(["read", "update", "delete"]);
  });

  test("a role that already has share-org gets no duplicate", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "test-already-share-org",
      roleName: "test_already_share_org",
      permission: {
        project: ["read", "update", "share-org"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("test-already-share-org");
    expect(
      permission.project.filter((action) => action === "share-org"),
    ).toHaveLength(1);
  });
});
