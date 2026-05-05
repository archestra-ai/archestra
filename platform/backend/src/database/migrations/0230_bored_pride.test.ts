import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0230_bored_pride.sql"),
  "utf-8",
);

async function runDataMigrationStatements() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement.startsWith(
          'INSERT INTO "virtual_api_key_provider_api_key"',
        ) || statement.startsWith('UPDATE "oauth_client"'),
    );

  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

describe("0230 migration: proxy auth provider key mappings", () => {
  test("migrates virtual key parent keys and OAuth client metadata", async ({
    makeOrganization,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const organization = await makeOrganization();
    const secret = await makeSecret({ secret: { apiKey: "sk-provider" } });
    const providerKey = await makeLlmProviderApiKey(
      organization.id,
      secret.id,
      {
        name: "Primary Provider",
        provider: "openai",
      },
    );
    const [virtualKey] = await db
      .insert(schema.virtualApiKeysTable)
      .values({
        organizationId: organization.id,
        name: "Migrated Virtual Key",
        secretId: secret.id,
        tokenStart: "archestra_12345",
        scope: "org",
      })
      .returning();
    const oauthClientId = crypto.randomUUID();

    await db.execute(sql`
      ALTER TABLE "virtual_api_keys"
      ADD COLUMN IF NOT EXISTS "chat_api_key_id" uuid
    `);
    await db.execute(sql`
      UPDATE "virtual_api_keys"
      SET "chat_api_key_id" = ${providerKey.id}
      WHERE "id" = ${virtualKey.id}
    `);
    await db.insert(schema.oauthClientsTable).values({
      id: oauthClientId,
      clientId: "llm_oauth_migration_test",
      clientSecret: "hashed-secret",
      name: "Migration OAuth Client",
      redirectUris: [],
      tokenEndpointAuthMethod: "client_secret_post",
      grantTypes: ["client_credentials"],
      responseTypes: [],
      public: false,
      type: "service",
      scopes: ["llm:proxy"],
      metadata: {
        type: "llm_oauth_client",
        organizationId: organization.id,
        chatApiKeyId: providerKey.id,
        allowedLlmProxyIds: [],
        modelRouterProviderApiKeys: [],
      },
    });

    await runDataMigrationStatements();

    const [mapping] = await db
      .select()
      .from(schema.virtualApiKeyProviderApiKeysTable)
      .where(
        eq(
          schema.virtualApiKeyProviderApiKeysTable.virtualApiKeyId,
          virtualKey.id,
        ),
      );
    expect(mapping).toMatchObject({
      virtualApiKeyId: virtualKey.id,
      provider: "openai",
      providerApiKeyId: providerKey.id,
    });

    const [oauthClient] = await db
      .select({ metadata: schema.oauthClientsTable.metadata })
      .from(schema.oauthClientsTable)
      .where(eq(schema.oauthClientsTable.id, oauthClientId));
    expect(oauthClient.metadata).toMatchObject({
      type: "llm_oauth_client",
      organizationId: organization.id,
      allowedLlmProxyIds: [],
      providerApiKeys: [
        {
          provider: "openai",
          providerApiKeyId: providerKey.id,
        },
      ],
    });
    expect(oauthClient.metadata).not.toHaveProperty("chatApiKeyId");
    expect(oauthClient.metadata).not.toHaveProperty(
      "modelRouterProviderApiKeys",
    );
  });
});
