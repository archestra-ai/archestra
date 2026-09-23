import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0489_military_colossus.sql"),
  "utf-8",
);

/**
 * Replays the data statements only. The DDL already exists in the shared test
 * schema (migrations run once when the PGlite snapshot is built), so replaying
 * it would fail. Each data statement is written to be idempotent, which the
 * tests below also pin by running the replay twice.
 */
async function runDataMigration() {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => {
      const body = statement
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();
      return /^(UPDATE|INSERT|DELETE)\b/.test(body);
    });
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function insertProxy(params: {
  organizationId: string;
  isDefault: boolean;
  deletedAt?: Date;
}) {
  const [row] = await db
    .insert(schema.agentsTable)
    .values({
      organizationId: params.organizationId,
      name: `Proxy ${crypto.randomUUID().substring(0, 8)}`,
      agentType: "llm_proxy",
      scope: "org",
      isDefault: params.isDefault,
      deletedAt: params.deletedAt ?? null,
    })
    .returning();
  return row;
}

async function insertConnectionSetup(params: {
  organizationId: string;
  userId: string;
  llmProxyId: string;
}) {
  const token = crypto.randomUUID();
  const [row] = await db
    .insert(schema.connectionSetupsTable)
    .values({
      organizationId: params.organizationId,
      userId: params.userId,
      clientId: "claude-code",
      baseUrl: "http://localhost:9000/v1",
      llmProxyId: params.llmProxyId,
      provider: "anthropic",
      tokenHash: token,
      tokenStart: token.slice(0, 22),
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning();
  return row;
}

async function findAgent(id: string) {
  const [row] = await db
    .select()
    .from(schema.agentsTable)
    .where(eq(schema.agentsTable.id, id));
  return row ?? null;
}

describe("0489 connector sync switch", () => {
  test("turns the switch on exactly for auto-sync connectors", async ({
    makeOrganization,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    const org = await makeOrganization();
    const kb = await makeKnowledgeBase(org.id);
    const autoSync = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "auto-sync-permissions",
    });
    const orgWide = await makeKnowledgeBaseConnector(kb.id, org.id, {
      visibility: "org-wide",
    });
    // Rows written before the column existed carry the default.
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ syncPermissionsFromSource: false })
      .where(eq(schema.knowledgeBaseConnectorsTable.id, autoSync.id));

    await runDataMigration();
    await runDataMigration();

    const rows = await db
      .select({
        id: schema.knowledgeBaseConnectorsTable.id,
        sync: schema.knowledgeBaseConnectorsTable.syncPermissionsFromSource,
      })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.organizationId, org.id));
    const byId = new Map(rows.map((row) => [row.id, row.sync]));
    expect(byId.get(autoSync.id)).toBe(true);
    expect(byId.get(orgWide.id)).toBe(false);
  });
});

describe("0489 retire non-default LLM proxy rows", () => {
  test("repoints every reference to the organization's default proxy, then deletes the old rows", async ({
    makeOrganization,
    makeUser,
    makeVirtualApiKey,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const defaultProxy = await insertProxy({
      organizationId: org.id,
      isDefault: true,
    });
    const oldLive = await insertProxy({
      organizationId: org.id,
      isDefault: false,
    });
    const oldDeleted = await insertProxy({
      organizationId: org.id,
      isDefault: false,
      deletedAt: new Date(),
    });

    const setupOnOld = await insertConnectionSetup({
      organizationId: org.id,
      userId: user.id,
      llmProxyId: oldLive.id,
    });
    const setupOnDeleted = await insertConnectionSetup({
      organizationId: org.id,
      userId: user.id,
      llmProxyId: oldDeleted.id,
    });

    // One key bound to an old row only; one bound to an old row AND the
    // default, whose default binding must not be duplicated.
    const keyOnOld = await makeVirtualApiKey(org.id);
    const keyOnBoth = await makeVirtualApiKey(org.id);
    await db.insert(schema.virtualApiKeyLlmProxiesTable).values([
      { virtualApiKeyId: keyOnOld.id, llmProxyId: oldLive.id },
      { virtualApiKeyId: keyOnBoth.id, llmProxyId: oldLive.id },
      { virtualApiKeyId: keyOnBoth.id, llmProxyId: oldDeleted.id },
      { virtualApiKeyId: keyOnBoth.id, llmProxyId: defaultProxy.id },
    ]);

    const interactionOnOld = await makeInteraction(oldLive.id);
    const interactionOnDeleted = await makeInteraction(oldDeleted.id);

    await db
      .update(schema.organizationsTable)
      .set({ connectionDefaultLlmProxyId: oldLive.id })
      .where(eq(schema.organizationsTable.id, org.id));

    await runDataMigration();
    await runDataMigration();

    expect(await findAgent(oldLive.id)).toBeNull();
    expect(await findAgent(oldDeleted.id)).toBeNull();
    expect(await findAgent(defaultProxy.id)).not.toBeNull();

    const setups = await db
      .select({
        id: schema.connectionSetupsTable.id,
        llmProxyId: schema.connectionSetupsTable.llmProxyId,
      })
      .from(schema.connectionSetupsTable)
      .where(eq(schema.connectionSetupsTable.organizationId, org.id));
    expect(new Map(setups.map((row) => [row.id, row.llmProxyId]))).toEqual(
      new Map([
        [setupOnOld.id, defaultProxy.id],
        [setupOnDeleted.id, defaultProxy.id],
      ]),
    );

    const bindings = await db
      .select()
      .from(schema.virtualApiKeyLlmProxiesTable)
      .where(
        sql`${schema.virtualApiKeyLlmProxiesTable.virtualApiKeyId} IN (${keyOnOld.id}, ${keyOnBoth.id})`,
      );
    expect(
      bindings.map((row) => `${row.virtualApiKeyId}:${row.llmProxyId}`).sort(),
    ).toEqual(
      [
        `${keyOnOld.id}:${defaultProxy.id}`,
        `${keyOnBoth.id}:${defaultProxy.id}`,
      ].sort(),
    );

    const interactions = await db
      .select({
        id: schema.interactionsTable.id,
        profileId: schema.interactionsTable.profileId,
      })
      .from(schema.interactionsTable)
      .where(
        sql`${schema.interactionsTable.id} IN (${interactionOnOld.id}, ${interactionOnDeleted.id})`,
      );
    expect(interactions.map((row) => row.profileId)).toEqual([
      defaultProxy.id,
      defaultProxy.id,
    ]);

    const [orgRow] = await db
      .select({
        connectionDefault:
          schema.organizationsTable.connectionDefaultLlmProxyId,
      })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, org.id));
    expect(orgRow.connectionDefault).toBe(defaultProxy.id);
  });

  test("leaves an organization without a live default proxy untouched", async ({
    makeOrganization,
    makeUser,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const oldRow = await insertProxy({
      organizationId: org.id,
      isDefault: false,
    });
    const setup = await insertConnectionSetup({
      organizationId: org.id,
      userId: user.id,
      llmProxyId: oldRow.id,
    });
    const interaction = await makeInteraction(oldRow.id);

    await runDataMigration();

    expect(await findAgent(oldRow.id)).not.toBeNull();
    const [setupRow] = await db
      .select({ llmProxyId: schema.connectionSetupsTable.llmProxyId })
      .from(schema.connectionSetupsTable)
      .where(eq(schema.connectionSetupsTable.id, setup.id));
    expect(setupRow.llmProxyId).toBe(oldRow.id);
    const [interactionRow] = await db
      .select({ profileId: schema.interactionsTable.profileId })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, interaction.id));
    expect(interactionRow.profileId).toBe(oldRow.id);
  });

  test("never repoints across organizations", async ({
    makeOrganization,
    makeUser,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const user = await makeUser();
    const defaultA = await insertProxy({
      organizationId: orgA.id,
      isDefault: true,
    });
    const defaultB = await insertProxy({
      organizationId: orgB.id,
      isDefault: true,
    });
    const oldB = await insertProxy({
      organizationId: orgB.id,
      isDefault: false,
    });
    const setup = await insertConnectionSetup({
      organizationId: orgB.id,
      userId: user.id,
      llmProxyId: oldB.id,
    });

    await runDataMigration();

    const [setupRow] = await db
      .select({ llmProxyId: schema.connectionSetupsTable.llmProxyId })
      .from(schema.connectionSetupsTable)
      .where(eq(schema.connectionSetupsTable.id, setup.id));
    expect(setupRow.llmProxyId).toBe(defaultB.id);
    expect(setupRow.llmProxyId).not.toBe(defaultA.id);
  });
});
