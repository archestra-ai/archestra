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
  path.join(__dirname, "0395_purge_ex_member_personal_mcp_credentials.sql"),
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

describe("0395 ex-member personal MCP credential purge", () => {
  test("purges an ex-member's personal install and its plain secret", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
    makeUser,
  }) => {
    const exMember = await makeUser();
    const org = await makeOrganization();
    // No member row for exMember in org — they left.
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
    });
    const secret = await SecretModel.create({
      name: "ex-member-cred",
      secret: { access_token: "at" },
    });
    const server = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
      secretId: secret.id,
    });

    await runMigration();

    expect(await McpServerModel.findById(server.id)).toBeNull();
    expect(await SecretModel.findById(secret.id)).toBeNull();
  });

  test("keeps a current member's install, vault secrets, and org-less catalogs", async ({
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
    // Current member: untouched.
    const memberSecret = await SecretModel.create({
      name: "member-cred",
      secret: { access_token: "m" },
    });
    const memberServer = await makeMcpServer({
      ownerId: member.id,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
      secretId: memberSecret.id,
    });
    // Ex-member with a Vault-backed secret: install goes, secret row stays.
    const vaultSecret = await SecretModel.create({
      name: "ex-member-vault",
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
    // Ex-member on an org-less catalog: unattributable, untouched.
    const orgLessCatalog = await InternalMcpCatalogModel.create({
      name: "org-less-catalog-0395",
      serverType: "remote",
    });
    const orgLessServer = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
      catalogId: orgLessCatalog.id,
    });

    await runMigration();

    expect(await McpServerModel.findById(memberServer.id)).not.toBeNull();
    expect(await SecretModel.findById(memberSecret.id)).not.toBeNull();
    expect(await McpServerModel.findById(vaultServer.id)).toBeNull();
    expect(await SecretModel.findById(vaultSecret.id)).not.toBeNull();
    expect(await McpServerModel.findById(orgLessServer.id)).not.toBeNull();
  });

  test("deletes an ex-member's personal app with its backing catalog and launch tool", async ({
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
    // The catalog's launch tool went down with it.
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

  test("is idempotent", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
    makeUser,
  }) => {
    const exMember = await makeUser();
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      serverType: "remote",
    });
    const server = await makeMcpServer({
      ownerId: exMember.id,
      scope: "personal",
      serverType: "remote",
      catalogId: catalog.id,
    });

    await runMigration();
    await runMigration();

    expect(await McpServerModel.findById(server.id)).toBeNull();
  });
});
