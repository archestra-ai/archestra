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
    // The migration reads the retired visibility column.
    const autoSync = await makeKnowledgeBaseConnector(kb.id, org.id, {
      legacy: { visibility: "auto-sync-permissions" },
    });
    const orgWide = await makeKnowledgeBaseConnector(kb.id, org.id, {
      legacy: { visibility: "org-wide" },
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

describe("0489 primary provider keys by owner", () => {
  test("keeps one primary per owner and one per shared provider, preferring the organization primary", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const alice = await makeUser();
    // Under the old scope partitions each of these was a legal primary.
    const insertKey = async (values: {
      name: string;
      scope: "personal" | "team" | "org";
      userId?: string;
      createdAt: Date;
    }) => {
      const [row] = await db
        .insert(schema.llmProviderApiKeysTable)
        .values({
          organizationId: org.id,
          provider: "openai",
          isPrimary: false,
          ...values,
        })
        .returning();
      return row;
    };
    const oldPersonalNoOwner = await insertKey({
      name: "personal without owner",
      scope: "personal",
      createdAt: new Date("2024-01-01"),
    });
    const orgPrimary = await insertKey({
      name: "org",
      scope: "org",
      createdAt: new Date("2024-02-01"),
    });
    const teamPrimary = await insertKey({
      name: "team",
      scope: "team",
      createdAt: new Date("2024-03-01"),
    });
    const alicePrimary = await insertKey({
      name: "alice",
      scope: "personal",
      userId: alice.id,
      createdAt: new Date("2024-04-01"),
    });
    // The new indexes forbid the old states, so the test sets the flags
    // one partition at a time on rows the indexes cannot see yet.
    await db.execute(
      sql`DROP INDEX IF EXISTS "chat_api_keys_primary_shared_unique"`,
    );
    try {
      await db
        .update(schema.llmProviderApiKeysTable)
        .set({ isPrimary: true })
        .where(
          sql`${schema.llmProviderApiKeysTable.id} IN (${oldPersonalNoOwner.id}, ${orgPrimary.id}, ${teamPrimary.id}, ${alicePrimary.id})`,
        );

      await runDataMigration();
      await runDataMigration();
    } finally {
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "chat_api_keys_primary_shared_unique" ON "chat_api_keys" ("organization_id", "provider") WHERE "is_primary" = true AND "user_id" IS NULL`,
      );
    }

    const rows = await db
      .select({
        id: schema.llmProviderApiKeysTable.id,
        isPrimary: schema.llmProviderApiKeysTable.isPrimary,
      })
      .from(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.organizationId, org.id));
    const primary = new Map(rows.map((row) => [row.id, row.isPrimary]));
    expect(primary.get(orgPrimary.id)).toBe(true);
    expect(primary.get(oldPersonalNoOwner.id)).toBe(false);
    expect(primary.get(teamPrimary.id)).toBe(false);
    expect(primary.get(alicePrimary.id)).toBe(true);
  });
});

describe("0489 app backing install scope", () => {
  test("re-derives the install scope of every app backing server from the app's grants", async ({
    makeApp,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const team = await makeTeam(org.id, author.id);
    const orgApp = await makeApp({ organizationId: org.id });
    const teamApp = await makeApp({
      access: { teams: [team.id] },
      authorId: author.id,
      organizationId: org.id,
    });
    const personalApp = await makeApp({
      access: "personal",
      authorId: author.id,
      organizationId: org.id,
    });
    // The copies of the retired app scope that the servers held before.
    const setServer = async (
      serverId: string | null,
      values: { scope: "personal" | "team" | "org"; teamId: string | null },
    ) => {
      if (!serverId) throw new Error("app has no backing server");
      await db
        .update(schema.mcpServersTable)
        .set(values)
        .where(eq(schema.mcpServersTable.id, serverId));
    };
    await setServer(orgApp.mcpServerId, { scope: "personal", teamId: null });
    await setServer(teamApp.mcpServerId, { scope: "team", teamId: team.id });
    await setServer(personalApp.mcpServerId, { scope: "org", teamId: null });

    await runDataMigration();
    await runDataMigration();

    const servers = await db
      .select({
        id: schema.mcpServersTable.id,
        scope: schema.mcpServersTable.scope,
        teamId: schema.mcpServersTable.teamId,
      })
      .from(schema.mcpServersTable)
      .where(
        sql`${schema.mcpServersTable.id} IN (${orgApp.mcpServerId}, ${teamApp.mcpServerId}, ${personalApp.mcpServerId})`,
      );
    const byId = new Map(servers.map((row) => [row.id, row]));
    expect(byId.get(orgApp.mcpServerId as string)).toMatchObject({
      scope: "org",
      teamId: null,
    });
    expect(byId.get(teamApp.mcpServerId as string)).toMatchObject({
      scope: "personal",
      teamId: null,
    });
    expect(byId.get(personalApp.mcpServerId as string)).toMatchObject({
      scope: "personal",
      teamId: null,
    });
  });
});

describe("0489 skill names unique per author", () => {
  test("renames the personal skill that clashes with the author's shared skill of the same name", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    const other = await makeUser();
    const insertSkill = async (values: {
      name: string;
      scope: "personal" | "org";
      authorId: string;
    }) => {
      const [row] = await db
        .insert(schema.skillsTable)
        .values({
          organizationId: org.id,
          description: "d",
          content: "c",
          latestVersion: 1,
          ...values,
        })
        .returning();
      return row;
    };
    const shared = await insertSkill({
      name: "refunds",
      scope: "org",
      authorId: author.id,
    });
    const otherAuthors = await insertSkill({
      name: "refunds",
      scope: "personal",
      authorId: other.id,
    });
    // The old indexes allowed this pair: one personal, one shared name space.
    await db.execute(sql`DROP INDEX IF EXISTS "skills_org_author_name_idx"`);
    let personal: typeof shared;
    try {
      personal = await insertSkill({
        name: "refunds",
        scope: "personal",
        authorId: author.id,
      });
      await runDataMigration();
      await runDataMigration();
    } finally {
      await db.execute(
        sql`CREATE UNIQUE INDEX IF NOT EXISTS "skills_org_author_name_idx" ON "skills" ("organization_id", coalesce("author_id", "created_by_service_account_id"::text), "name") WHERE "deleted_at" IS NULL`,
      );
    }

    const names = new Map(
      (
        await db
          .select({
            id: schema.skillsTable.id,
            name: schema.skillsTable.name,
          })
          .from(schema.skillsTable)
          .where(eq(schema.skillsTable.organizationId, org.id))
      ).map((row) => [row.id, row.name]),
    );
    expect(names.get(shared.id)).toBe("refunds");
    expect(names.get(otherAuthors.id)).toBe("refunds");
    expect(names.get(personal.id)).toBe(`refunds-${personal.id.slice(0, 8)}`);
  });
});
