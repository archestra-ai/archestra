import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

// the migration's schema DDL is already applied by the test DB setup, so we run
// only the trailing data-backfill statement (the DO block after the last break).
const migrationSql = fs
  .readFileSync(path.join(__dirname, "0275_breezy_lord_hawal.sql"), "utf-8")
  .split("--> statement-breakpoint")
  .at(-1) as string;

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";

test("backfills GitHub App connectors into github_app_configs", async ({
  makeOrganization,
}) => {
  const org = await makeOrganization();

  const [appSecret] = await db
    .insert(schema.secretsTable)
    .values({ name: "connector-app", secret: { apiToken: PEM } })
    .returning();

  const [appConnector] = await db
    .insert(schema.knowledgeBaseConnectorsTable)
    .values({
      organizationId: org.id,
      name: "App Connector",
      connectorType: "github",
      secretId: appSecret.id,
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "github_app",
        githubAppId: "12345",
        githubAppInstallationId: "67890",
      } as never,
    })
    .returning();

  // a PAT connector must be left untouched
  const [patSecret] = await db
    .insert(schema.secretsTable)
    .values({ name: "connector-pat", secret: { apiToken: "ghp_token" } })
    .returning();

  const [patConnector] = await db
    .insert(schema.knowledgeBaseConnectorsTable)
    .values({
      organizationId: org.id,
      name: "PAT Connector",
      connectorType: "github",
      secretId: patSecret.id,
      config: {
        type: "github",
        githubUrl: "https://api.github.com",
        owner: "test-org",
        authMethod: "pat",
      } as never,
    })
    .returning();

  await db.execute(sql.raw(migrationSql));

  // a github_app_configs row was minted, reusing the connector's secret
  const appConfigs = await db
    .select()
    .from(schema.githubAppConfigsTable)
    .where(eq(schema.githubAppConfigsTable.organizationId, org.id));
  expect(appConfigs).toHaveLength(1);
  expect(appConfigs[0]).toMatchObject({
    appId: "12345",
    installationId: "67890",
    githubUrl: "https://api.github.com",
    secretId: appSecret.id,
  });

  // the connector now references the row and released ownership of the secret
  const [updatedApp] = await db
    .select()
    .from(schema.knowledgeBaseConnectorsTable)
    .where(eq(schema.knowledgeBaseConnectorsTable.id, appConnector.id));
  expect(updatedApp.secretId).toBeNull();
  expect(updatedApp.config).toMatchObject({
    authMethod: "github_app",
    githubAppConfigId: appConfigs[0].id,
  });
  expect(updatedApp.config).not.toHaveProperty("githubAppId");
  expect(updatedApp.config).not.toHaveProperty("githubAppInstallationId");

  // the PAT connector keeps its own secret and gains no reference
  const [updatedPat] = await db
    .select()
    .from(schema.knowledgeBaseConnectorsTable)
    .where(eq(schema.knowledgeBaseConnectorsTable.id, patConnector.id));
  expect(updatedPat.secretId).toBe(patSecret.id);
  expect(updatedPat.config).not.toHaveProperty("githubAppConfigId");
});
