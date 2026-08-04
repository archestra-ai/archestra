import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import AppModel from "@/models/app";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import SecretModel from "@/models/secret";
import { describe, expect, mustExist, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(
    __dirname,
    "0396_purge_membershipless_personal_mcp_credentials.sql",
  ),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.includes("UPDATE") || statement.includes("DELETE"),
    );

  if (statements.length !== 4) {
    throw new Error("Migration statements not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe("0396 membership-less personal MCP credential purge", () => {
  test("purges a membership-less owner's install even on an org-less catalog", async ({
    makeMcpServer,
    makeUser,
  }) => {
    const exMember = await makeUser();
    // Catalog created without an organization context — the shape of seeded
    // system catalogs and pre-stamping legacy rows the previous sweep skipped.
    const orgLessCatalog = await InternalMcpCatalogModel.create({
      name: "org-less-catalog-0396",
      serverType: "remote",
    });
    const secret = await SecretModel.create({
      name: "ex-member-cred-0396",
      secret: { access_token: "at" },
    });
    const server = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
      catalogId: orgLessCatalog.id,
      secretId: secret.id,
    });

    await runMigration();

    expect(await McpServerModel.findById(server.id)).toBeNull();
    expect(await SecretModel.findById(secret.id)).toBeNull();
    // The shared catalog itself survives — only the install rows go.
    expect(
      await InternalMcpCatalogModel.findById(orgLessCatalog.id),
    ).not.toBeNull();
    // The user row stays: without memberships or credentials it holds nothing.
    const [userRow] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, exMember.id));
    expect(userRow).toBeDefined();
  });

  test("keeps installs whose owner holds any membership, and vault secret rows", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const exMember = await makeUser();

    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
    });
    const memberSecret = await SecretModel.create({
      name: "member-cred-0396",
      secret: { access_token: "m" },
    });
    const memberServer = await makeMcpServer({
      ownerId: member.id,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
      secretId: memberSecret.id,
    });
    const vaultSecret = await SecretModel.create({
      name: "ex-member-vault-0396",
      secret: { vaultPath: "kv/data/creds" },
      isVault: true,
    });
    const vaultServer = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
      secretId: vaultSecret.id,
    });

    await runMigration();

    expect(await McpServerModel.findById(memberServer.id)).not.toBeNull();
    expect(await SecretModel.findById(memberSecret.id)).not.toBeNull();
    expect(await McpServerModel.findById(vaultServer.id)).toBeNull();
    expect(await SecretModel.findById(vaultSecret.id)).not.toBeNull();
  });

  test("deletes a membership-less owner's personal app with its backing catalog and launch tool", async ({
    makeApp,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const exMember = await makeUser();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });

    const exMemberApp = await makeApp({
      scope: "personal",
      authorId: exMember.id,
      organizationId: org.id,
    });
    const memberApp = await makeApp({
      scope: "personal",
      authorId: member.id,
      organizationId: org.id,
    });
    const backingServerId = mustExist(exMemberApp.mcpServerId);
    const backingCatalogId = mustExist(
      (await McpServerModel.findById(backingServerId))?.catalogId,
    );

    await runMigration();

    expect(await AppModel.findById(exMemberApp.id)).toBeNull();
    expect(await McpServerModel.findById(backingServerId)).toBeNull();
    expect(await InternalMcpCatalogModel.findById(backingCatalogId)).toBeNull();
    const launchTools = await db
      .select()
      .from(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, backingCatalogId));
    expect(launchTools.length).toBeGreaterThan(0);
    for (const tool of launchTools) {
      expect(tool.deletedAt).not.toBeNull();
    }
    expect(await AppModel.findById(memberApp.id)).not.toBeNull();
  });

  test("shared-scope installs and BYOS-vault secret rows survive a membership-less owner", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeTeam,
    makeOrganization,
    makeUser,
  }) => {
    const exMember = await makeUser();
    const org = await makeOrganization();
    const team = await makeTeam(org.id, exMember.id, { name: "Shared Team" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
    });
    // Org- and team-scoped installs outlive their installer — the
    // scope = 'personal' boundary is what keeps them out of the sweep.
    const orgServer = await makeMcpServer({
      ownerId: exMember.id,
      scope: "org",
      serverType: "remote",
      catalogId: catalog.id,
    });
    const teamServer = await makeMcpServer({
      ownerId: exMember.id,
      scope: "team",
      teamId: team.id,
      serverType: "remote",
      catalogId: catalog.id,
    });
    const byosSecret = await SecretModel.create({
      name: "ex-member-byos-0396",
      secret: { vaultPath: "byos/creds" },
      isByosVault: true,
    });
    const byosServer = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
      secretId: byosSecret.id,
    });

    await runMigration();

    expect(await McpServerModel.findById(orgServer.id)).not.toBeNull();
    expect(await McpServerModel.findById(teamServer.id)).not.toBeNull();
    // The personal install goes, but the BYOS-vault secret row is retained.
    expect(await McpServerModel.findById(byosServer.id)).toBeNull();
    expect(await SecretModel.findById(byosSecret.id)).not.toBeNull();
  });

  test("is idempotent", async ({ makeMcpServer, makeUser }) => {
    const exMember = await makeUser();
    const server = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
    });

    await runMigration();
    await runMigration();

    expect(await McpServerModel.findById(server.id)).toBeNull();
  });
});
