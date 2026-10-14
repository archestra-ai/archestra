import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0534_lying_the_anarchist.sql"),
  "utf-8",
);

describe("0534 per-client connection provider keys", () => {
  test("copies the old defaults to each client, limited to its providers", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const untouched = await makeOrganization();
    const anthropicKey = crypto.randomUUID();
    const openAiKey = crypto.randomUUID();
    const geminiKey = crypto.randomUUID();

    await restoreOldColumn();
    await db.execute(sql`
      UPDATE "organization"
      SET "connection_default_provider_keys" = ${JSON.stringify({
        anthropic: anthropicKey,
        openai: openAiKey,
        gemini: geminiKey,
      })}::jsonb
      WHERE "id" = ${organization.id}
    `);
    await runDataMigration();

    const [migrated] = await db
      .select({
        keys: schema.organizationsTable.connectionClientProviderKeys,
      })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organization.id));
    const anthropic = { provider: "anthropic", providerApiKeyId: anthropicKey };
    const gemini = { provider: "gemini", providerApiKeyId: geminiKey };
    const openai = { provider: "openai", providerApiKeyId: openAiKey };
    expect(migrated.keys).toEqual({
      "claude-code": [anthropic],
      "claude-desktop": [anthropic],
      codex: [openai],
      "copilot-cli": [openai],
      cursor: [anthropic, gemini, openai],
      opencode: [anthropic, gemini, openai],
    });

    const [other] = await db
      .select({
        keys: schema.organizationsTable.connectionClientProviderKeys,
      })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, untouched.id));
    expect(other.keys).toBeNull();
  });
});

/** The old column predates this branch's test schema, so recreate it if missing. */
async function restoreOldColumn() {
  await db.execute(
    sql.raw(
      `ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "connection_default_provider_keys" jsonb`,
    ),
  );
}

/** Every statement but the first, which adds a column that already exists. */
async function runDataMigration() {
  for (const statement of migrationSql
    .split("--> statement-breakpoint")
    .slice(1)) {
    await db.execute(sql.raw(statement));
  }
}
