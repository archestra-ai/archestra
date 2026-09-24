import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import EnvironmentModel from "@/models/environment";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { describe, expect, test } from "@/test";

const migrationSql = fs.readFileSync(
  path.join(__dirname, "0488_scoped_resource_permissions.sql"),
  "utf-8",
);

/**
 * The one migration of the scoped-permissions change. The shared test schema
 * already holds its DDL (every test run migrates an empty PGlite database from
 * the first migration, this one included), so the schema block reads the
 * catalog and the other blocks replay the data statements only. Each data
 * statement is idempotent: every test replays them twice.
 */
const dataStatements = migrationSql
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => /^(UPDATE|INSERT|DELETE)\b/.test(codeOf(statement)));

/**
 * Replay the data statements. The migration drops the environment
 * `restricted` column after it reads it, so the column is put back for the
 * replay and removed again; `prepare` sets the values a test needs in it.
 */
async function runDataMigration(prepare?: () => Promise<void>) {
  await db.execute(
    sql`ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "restricted" boolean DEFAULT false NOT NULL`,
  );
  try {
    await prepare?.();
    for (const statement of dataStatements) {
      await db.execute(sql.raw(statement));
    }
  } finally {
    await db.execute(
      sql`ALTER TABLE "environments" DROP COLUMN IF EXISTS "restricted"`,
    );
  }
}

/** The statement without its leading comment lines. */
function codeOf(statement: string) {
  return statement
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
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

describe("0488 schema", () => {
  test("creates the permission policy table, keyed per object and removed with its organization", async () => {
    const columns = await db.execute<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'resource_permission_policies'
      ORDER BY ordinal_position`);
    expect(
      columns.rows.map((column) => [
        column.column_name,
        column.data_type,
        column.is_nullable,
      ]),
    ).toEqual([
      ["organization_id", "text", "NO"],
      ["resource", "text", "NO"],
      ["scope", "text", "NO"],
      ["grants", "jsonb", "NO"],
      ["legacy_sharing_migrated", "boolean", "NO"],
      ["legacy_organization_audience", "boolean", "NO"],
      ["revision", "integer", "NO"],
      ["updated_at", "timestamp without time zone", "NO"],
    ]);

    const constraints = await db.execute<{ definition: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'resource_permission_policies'::regclass
      ORDER BY contype`);
    expect(constraints.rows.map((row) => row.definition).sort()).toEqual(
      [
        "FOREIGN KEY (organization_id) REFERENCES organization(id) ON DELETE CASCADE",
        "PRIMARY KEY (organization_id, resource, scope)",
      ].sort(),
    );
  });

  test("gives connectors a permission-sync switch that is off by default", async () => {
    const [column] = (
      await db.execute<{
        data_type: string;
        is_nullable: string;
        column_default: string;
      }>(sql`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'knowledge_base_connectors'
          AND column_name = 'sync_permissions_from_source'`)
    ).rows;
    expect(column).toEqual({
      data_type: "boolean",
      is_nullable: "NO",
      column_default: "false",
    });
  });

  test("swaps the scope partitions of primary keys and skill names for owner and author partitions", async () => {
    const indexes = await db.execute<{ indexname: string; indexdef: string }>(
      sql`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename IN ('chat_api_keys', 'skills')`,
    );
    const byName = new Map(
      indexes.rows.map((row) => [row.indexname, row.indexdef]),
    );
    for (const retired of [
      "chat_api_keys_primary_personal_unique",
      "chat_api_keys_primary_team_unique",
      "chat_api_keys_primary_org_unique",
      "skills_org_personal_name_idx",
      "skills_org_shared_name_idx",
    ]) {
      expect(byName.has(retired)).toBe(false);
    }
    expect(byName.get("chat_api_keys_primary_owner_unique")).toMatch(
      /UNIQUE INDEX .* \(organization_id, provider, user_id\) WHERE \(\(is_primary = true\) AND \(user_id IS NOT NULL\)\)/,
    );
    expect(byName.get("chat_api_keys_primary_shared_unique")).toMatch(
      /UNIQUE INDEX .* \(organization_id, provider\) WHERE \(\(is_primary = true\) AND \(user_id IS NULL\)\)/,
    );
    expect(byName.get("skills_org_author_name_idx")).toMatch(
      /UNIQUE INDEX .* \(organization_id, COALESCE\(author_id, \(created_by_service_account_id\)::text\), name\) WHERE \(deleted_at IS NULL\)/,
    );
  });

  test("the blocks below cover every data statement, in this order", () => {
    // A new data statement needs a test here; this list says which one.
    expect(
      dataStatements.map((statement) =>
        codeOf(statement).split("\n")[0].trim(),
      ),
    ).toEqual([
      'UPDATE "chat_api_keys" api_key', // primary provider keys by owner
      'UPDATE "skills" skill', // skill names unique per author
      'UPDATE "knowledge_base_connectors"', // connector sync switch
      'UPDATE "connection_setups" setup', // retire non-default LLM proxy rows
      'INSERT INTO "virtual_api_key_llm_proxy" ("virtual_api_key_id", "llm_proxy_id", "created_at")',
      'UPDATE "interactions" interaction',
      'UPDATE "organization" org',
      'DELETE FROM "resource_permission_policies" policy',
      'DELETE FROM "agents" agent',
      'UPDATE "mcp_server" backing_server', // app backing install scope
      'INSERT INTO "resource_permission_policies"', // environment grants
    ]);
  });
});

describe("0488 connector sync switch", () => {
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

describe("0488 retire non-default LLM proxy rows", () => {
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

    // Permission policies of the old rows go with them; the default keeps its.
    await db.insert(schema.resourcePermissionPoliciesTable).values(
      [defaultProxy, oldLive, oldDeleted].map((proxy) => ({
        organizationId: org.id,
        resource: "agent" as const,
        scope: proxy.id,
      })),
    );

    await runDataMigration();
    await runDataMigration();

    const policies = await db
      .select({ scope: schema.resourcePermissionPoliciesTable.scope })
      .from(schema.resourcePermissionPoliciesTable)
      .where(
        sql`${schema.resourcePermissionPoliciesTable.organizationId} = ${org.id} AND ${schema.resourcePermissionPoliciesTable.resource} = 'agent'`,
      );
    expect(
      policies
        .map((row) => row.scope)
        .filter((scope) =>
          [defaultProxy.id, oldLive.id, oldDeleted.id].includes(scope),
        ),
    ).toEqual([defaultProxy.id]);

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
    await runDataMigration();

    const [setupRow] = await db
      .select({ llmProxyId: schema.connectionSetupsTable.llmProxyId })
      .from(schema.connectionSetupsTable)
      .where(eq(schema.connectionSetupsTable.id, setup.id));
    expect(setupRow.llmProxyId).toBe(defaultB.id);
    expect(setupRow.llmProxyId).not.toBe(defaultA.id);
  });
});

describe("0488 primary provider keys by owner", () => {
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

describe("0488 app backing install scope", () => {
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

describe("0488 app backing install scope before the startup conversion", () => {
  test("an app with no policy yet takes the audience the conversion will grant it", async ({
    makeApp,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    // On the first upgrade this migration runs before the startup conversion
    // writes any grant. Read from grants alone, every app would get per-user
    // installs; the old audience of its backing catalog decides instead.
    const org = await makeOrganization();
    const author = await makeUser();
    const team = await makeTeam(org.id, author.id);
    const orgApp = await makeApp({
      authorId: author.id,
      organizationId: org.id,
      legacy: { scope: "org" },
    });
    const teamApp = await makeApp({
      authorId: author.id,
      organizationId: org.id,
      legacy: { scope: "team", teams: [team.id] },
    });
    const personalApp = await makeApp({
      authorId: author.id,
      organizationId: org.id,
      legacy: { scope: "personal" },
    });
    const apps = [orgApp, teamApp, personalApp];
    await db.delete(schema.resourcePermissionPoliciesTable).where(
      sql`${schema.resourcePermissionPoliciesTable.resource} = 'app' AND ${schema.resourcePermissionPoliciesTable.scope} IN (${sql.join(
        apps.map((app) => sql`${app.id}`),
        sql`, `,
      )})`,
    );
    // Invert what the migration should write, so each row must move.
    await db
      .update(schema.mcpServersTable)
      .set({ scope: "personal", teamId: null })
      .where(eq(schema.mcpServersTable.id, orgApp.mcpServerId as string));
    await db
      .update(schema.mcpServersTable)
      .set({ scope: "team", teamId: team.id })
      .where(eq(schema.mcpServersTable.id, teamApp.mcpServerId as string));
    await db
      .update(schema.mcpServersTable)
      .set({ scope: "org", teamId: null })
      .where(eq(schema.mcpServersTable.id, personalApp.mcpServerId as string));

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

describe("0488 skill names unique per author", () => {
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

describe("0488 environment grants", () => {
  const organizationWide = {
    subject: { type: "organization", id: "*" },
    actions: ["read", "use"],
  };

  test("grants each open environment to its organization and leaves a restricted one closed", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const other = await makeOrganization();
    const open = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Sandbox",
    });
    const restricted = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Prod",
    });
    const elsewhere = await EnvironmentModel.create({
      organizationId: other.id,
      name: "Sandbox",
    });
    const restrict = () =>
      db
        .execute(
          sql`UPDATE "environments" SET "restricted" = true WHERE "id" = ${restricted.id}`,
        )
        .then(() => undefined);

    await runDataMigration(restrict);
    await runDataMigration(restrict);

    const policyOf = (organizationId: string, scope: string) =>
      ResourcePermissionPolicyModel.find({
        organizationId,
        resource: "environment",
        scope,
      });
    const openPolicy = await policyOf(org.id, open.id);
    expect(openPolicy?.grants).toEqual([organizationWide]);
    // Written once: the second replay changes nothing.
    expect(openPolicy?.revision).toBe(1);
    expect(await policyOf(org.id, restricted.id)).toBeNull();
    // Each environment is granted to its own organization only.
    expect((await policyOf(other.id, elsewhere.id))?.grants).toEqual([
      organizationWide,
    ]);
    expect(await policyOf(org.id, elsewhere.id)).toBeNull();
  });

  test("adds the organization grant to an open environment's existing grants", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const team = await makeTeam(org.id, owner.id);
    const open = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Staging",
    });
    const teamGrant = {
      subject: { type: "team" as const, id: team.id },
      actions: ["read" as const, "use" as const, "update" as const],
    };
    await ResourcePermissionPolicyModel.replace({
      organizationId: org.id,
      resource: "environment",
      scope: open.id,
      revision: 0,
      grants: [teamGrant],
    });

    await runDataMigration();
    await runDataMigration();

    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "environment",
      scope: open.id,
    });
    expect(policy?.grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining(teamGrant),
        organizationWide,
      ]),
    );
    expect(policy?.grants).toHaveLength(2);
  });
});
