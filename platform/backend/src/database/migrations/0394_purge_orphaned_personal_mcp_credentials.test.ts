import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0394_purge_orphaned_personal_mcp_credentials.sql"),
  "utf-8",
);

async function runMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.includes("DELETE"));

  if (statements.length === 0) {
    throw new Error("Migration statements not found");
  }

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function serverExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.mcpServersTable.id })
    .from(schema.mcpServersTable)
    .where(eq(schema.mcpServersTable.id, id));
  return rows.length > 0;
}

async function secretExists(id: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.secretsTable.id })
    .from(schema.secretsTable)
    .where(eq(schema.secretsTable.id, id));
  return rows.length > 0;
}

describe("0394 orphaned personal MCP credential purge", () => {
  test("removes an ownerless personal install and its credential secret", async ({
    makeMcpServer,
  }) => {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ name: "orphaned-oauth", secret: { access_token: "at" } })
      .returning();
    // owner_id NULL is what a pre-fix user deletion left behind.
    const server = await makeMcpServer({
      scope: "personal",
      ownerId: null,
      secretId: secret.id,
    });

    await runMigration();

    expect(await serverExists(server.id)).toBe(false);
    expect(await secretExists(secret.id)).toBe(false);
  });

  test("removes soft-deleted orphans, whose secrets uninstall retained", async ({
    makeMcpServer,
  }) => {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ name: "retained", secret: { access_token: "at" } })
      .returning();
    const server = await makeMcpServer({
      scope: "personal",
      ownerId: null,
      secretId: secret.id,
      deletedAt: new Date(),
    });

    await runMigration();

    expect(await serverExists(server.id)).toBe(false);
    expect(await secretExists(secret.id)).toBe(false);
  });

  test("leaves owned personal installs alone", async ({
    makeUser,
    makeMcpServer,
  }) => {
    const user = await makeUser();
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ name: "still-owned", secret: { access_token: "at" } })
      .returning();
    const server = await makeMcpServer({
      scope: "personal",
      ownerId: user.id,
      secretId: secret.id,
    });

    await runMigration();

    expect(await serverExists(server.id)).toBe(true);
    expect(await secretExists(secret.id)).toBe(true);
  });

  test("leaves ownerless org- and team-scoped installs alone — owner_id alone is not the predicate", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeMcpServer,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);

    const [orgSecret] = await db
      .insert(schema.secretsTable)
      .values({ name: "org-cred", secret: { access_token: "at" } })
      .returning();
    const orgServer = await makeMcpServer({
      scope: "org",
      ownerId: null,
      secretId: orgSecret.id,
    });
    const [teamSecret] = await db
      .insert(schema.secretsTable)
      .values({ name: "team-cred", secret: { access_token: "at" } })
      .returning();
    const teamServer = await makeMcpServer({
      scope: "team",
      ownerId: null,
      teamId: team.id,
      secretId: teamSecret.id,
    });

    await runMigration();

    expect(await serverExists(orgServer.id)).toBe(true);
    expect(await secretExists(orgSecret.id)).toBe(true);
    expect(await serverExists(teamServer.id)).toBe(true);
    expect(await secretExists(teamSecret.id)).toBe(true);
  });

  test("drops the install but RETAINS a vault-backed secret row as the only pointer to the vault entry", async ({
    makeMcpServer,
  }) => {
    const [vaultSecret] = await db
      .insert(schema.secretsTable)
      .values({
        name: "vault-cred",
        secret: { access_token: "kv/path#token" },
        isVault: true,
      })
      .returning();
    const server = await makeMcpServer({
      scope: "personal",
      ownerId: null,
      secretId: vaultSecret.id,
    });

    await runMigration();

    expect(await serverExists(server.id)).toBe(false);
    expect(await secretExists(vaultSecret.id)).toBe(true);
  });

  test("is idempotent", async ({ makeMcpServer }) => {
    const [secret] = await db
      .insert(schema.secretsTable)
      .values({ name: "orphan", secret: { access_token: "at" } })
      .returning();
    await makeMcpServer({
      scope: "personal",
      ownerId: null,
      secretId: secret.id,
    });

    await runMigration();
    await runMigration();

    expect(await secretExists(secret.id)).toBe(false);
  });
});
