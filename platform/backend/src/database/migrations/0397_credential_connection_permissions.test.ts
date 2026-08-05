import fs from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0397_credential_connection_permissions.sql"),
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
  return JSON.parse(role.permission as unknown as string);
}

describe("0397_credential_connection_permissions custom-role cleanup", () => {
  test("converts every personal static pin to dynamic resolution", async ({
    makeAgent,
    makeApp,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeTool,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: organization.id,
      authorId: user.id,
      serverType: "local",
    });
    const connection = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "local",
    });
    const remoteConnection = await makeMcpServer({
      catalogId: catalog.id,
      ownerId: user.id,
      scope: "personal",
      serverType: "remote",
    });
    const tool = await makeTool({ catalogId: catalog.id });
    const agent = await makeAgent({
      organizationId: organization.id,
      authorId: user.id,
    });
    const app = await makeApp({
      organizationId: organization.id,
      authorId: user.id,
    });

    await db.insert(schema.agentToolsTable).values({
      agentId: agent.id,
      toolId: tool.id,
      mcpServerId: connection.id,
      credentialResolutionMode: "static",
    });
    await db.insert(schema.appToolsTable).values({
      appId: app.id,
      toolId: tool.id,
      mcpServerId: remoteConnection.id,
      credentialResolutionMode: "static",
    });
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ dynamicConnectionMcpServerId: connection.id })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    await runMigration();

    const [agentAssignment] = await db
      .select()
      .from(schema.agentToolsTable)
      .where(
        and(
          eq(schema.agentToolsTable.agentId, agent.id),
          eq(schema.agentToolsTable.toolId, tool.id),
        ),
      );
    const [appAssignment] = await db
      .select()
      .from(schema.appToolsTable)
      .where(
        and(
          eq(schema.appToolsTable.appId, app.id),
          eq(schema.appToolsTable.toolId, tool.id),
        ),
      );
    const [updatedCatalog] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    expect(agentAssignment).toMatchObject({
      mcpServerId: null,
      credentialResolutionMode: "dynamic",
    });
    expect(appAssignment).toMatchObject({
      mcpServerId: null,
      credentialResolutionMode: "dynamic",
    });
    expect(updatedCatalog.dynamicConnectionMcpServerId).toBeNull();
  });

  test("removes credentialConnection from custom roles", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-mcp-admin",
      roleName: "mcp_admin",
      permission: {
        mcpServerInstallation: ["read", "create", "admin"],
        agent: ["read"],
      },
    });

    await runMigration();

    const permission = await getRolePermission("role-mcp-admin");
    expect(permission.credentialConnection).toBeUndefined();
    expect(permission.mcpServerInstallation).toEqual([
      "read",
      "create",
      "admin",
    ]);
    expect(permission.agent).toEqual(["read"]);
  });

  test("leaves roles without credentialConnection unchanged", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-installer",
      roleName: "installer",
      permission: { mcpServerInstallation: ["read", "create", "delete"] },
    });

    await runMigration();

    expect(
      (await getRolePermission("role-installer")).credentialConnection,
    ).toBeUndefined();
  });

  test("is idempotent", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    await insertRole({
      organizationId: org.id,
      roleId: "role-already",
      roleName: "already",
      permission: {
        mcpServerInstallation: ["admin"],
        credentialConnection: ["use"],
      },
    });

    await runMigration();
    await runMigration();

    expect(
      (await getRolePermission("role-already")).credentialConnection,
    ).toBeUndefined();
  });
});
