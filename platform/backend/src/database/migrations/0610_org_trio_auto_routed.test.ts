import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migration = readFileSync(
  new URL("./0610_org_trio_auto_routed.sql", import.meta.url),
  "utf8",
);

const TIER_COLUMNS = [
  "fast_model_id",
  "smart_model_id",
  "auto_routing_fast_model_id",
  "auto_routing_normal_model_id",
  "auto_routing_smart_model_id",
];

async function makeDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE models (id text PRIMARY KEY);
    CREATE TABLE chat_api_keys (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      user_id text,
      is_primary boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL
    );
    CREATE TABLE api_key_models (api_key_id text NOT NULL, model_id text NOT NULL);
    CREATE TABLE organization (
      id text PRIMARY KEY,
      default_model_id text,
      default_llm_api_key_id text,
      default_fast_model_id text,
      default_smart_model_id text
    );
    CREATE TABLE agents (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      agent_type text NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      deleted_at timestamp,
      model_pool_id text,
      ${TIER_COLUMNS.map(
        (column) =>
          `${column} text CONSTRAINT agents_${column}_models_id_fk REFERENCES models(id)`,
      ).join(",\n")}
    );
    ${TIER_COLUMNS.map(
      (column) => `CREATE INDEX agents_${column}_idx ON agents (${column});`,
    ).join("\n")}
    CREATE TABLE conversations (id text PRIMARY KEY, model_pool_id text);
    INSERT INTO models VALUES
      ('fast-0'), ('normal-0'), ('smart-0'), ('fast-1'), ('normal-1'), ('smart-1');
  `);
  return database;
}

async function addKey(
  database: PGlite,
  key: {
    id: string;
    organizationId: string;
    userId?: string;
    isPrimary?: boolean;
    createdAt: string;
    models: string[];
  },
) {
  await database.query(
    "INSERT INTO chat_api_keys VALUES ($1, $2, $3, $4, $5)",
    [
      key.id,
      key.organizationId,
      key.userId ?? null,
      key.isPrimary ?? false,
      key.createdAt,
    ],
  );
  for (const model of key.models) {
    await database.query("INSERT INTO api_key_models VALUES ($1, $2)", [
      key.id,
      model,
    ]);
  }
}

async function addOrganization(
  database: PGlite,
  org: {
    id: string;
    trio: [string | null, string | null, string | null];
    defaultKey: string | null;
    autoTiers: [string | null, string | null, string | null];
  },
) {
  const [fast, normal, smart] = org.trio;
  await database.query("INSERT INTO organization VALUES ($1, $2, $3, $4, $5)", [
    org.id,
    normal,
    org.defaultKey,
    fast,
    smart,
  ]);
  const [autoFast, autoNormal, autoSmart] = org.autoTiers;
  await database.query(
    `INSERT INTO agents (id, organization_id, agent_type, is_default, auto_routing_fast_model_id, auto_routing_normal_model_id, auto_routing_smart_model_id)
     VALUES ($1, $2, 'llm_proxy', true, $3, $4, $5)`,
    [`proxy-${org.id}`, org.id, autoFast, autoNormal, autoSmart],
  );
}

async function trioOf(database: PGlite, organizationId: string) {
  const { rows } = await database.query(
    `SELECT default_fast_model_id AS fast, default_model_id AS normal,
            default_smart_model_id AS smart, default_llm_api_key_id AS key
     FROM organization WHERE id = $1`,
    [organizationId],
  );
  return rows[0];
}

test("auto-routing tiers move into the organization trio, the normal tier only with a shared key", async () => {
  const database = await makeDatabase();
  try {
    // Tiers everywhere; the normal tier is served by two shared keys and a
    // personal one: the primary shared key wins.
    await addOrganization(database, {
      id: "primary",
      trio: ["fast-0", "normal-0", null],
      defaultKey: "primary-default",
      autoTiers: ["fast-1", "normal-1", "smart-1"],
    });
    await addKey(database, {
      id: "primary-default",
      organizationId: "primary",
      createdAt: "2026-01-01",
      models: ["normal-0"],
    });
    await addKey(database, {
      id: "primary-older",
      organizationId: "primary",
      createdAt: "2026-01-02",
      models: ["normal-1"],
    });
    await addKey(database, {
      id: "primary-primary",
      organizationId: "primary",
      isPrimary: true,
      createdAt: "2026-01-03",
      models: ["normal-1"],
    });
    await addKey(database, {
      id: "primary-personal",
      organizationId: "primary",
      userId: "someone",
      isPrimary: true,
      createdAt: "2025-12-01",
      models: ["normal-1"],
    });
    // The current default key serves the new normal tier, so it stays; an
    // unset auto tier keeps the organization's own.
    await addOrganization(database, {
      id: "keeps-key",
      trio: ["fast-0", "normal-0", "smart-0"],
      defaultKey: "keeps-key-default",
      autoTiers: [null, "normal-1", "smart-1"],
    });
    await addKey(database, {
      id: "keeps-key-primary",
      organizationId: "keeps-key",
      isPrimary: true,
      createdAt: "2026-01-01",
      models: ["normal-1"],
    });
    await addKey(database, {
      id: "keeps-key-default",
      organizationId: "keeps-key",
      createdAt: "2026-01-02",
      models: ["normal-0", "normal-1"],
    });
    // Only a personal key serves the normal tier: the default stays.
    await addOrganization(database, {
      id: "personal-only",
      trio: [null, "normal-0", null],
      defaultKey: "personal-only-default",
      autoTiers: ["fast-1", "normal-1", "smart-1"],
    });
    await addKey(database, {
      id: "personal-only-default",
      organizationId: "personal-only",
      createdAt: "2026-01-01",
      models: ["normal-0"],
    });
    await addKey(database, {
      id: "personal-only-personal",
      organizationId: "personal-only",
      userId: "someone",
      createdAt: "2026-01-01",
      models: ["normal-1"],
    });
    // Another organization's shared key does not count.
    await addKey(database, {
      id: "elsewhere",
      organizationId: "another",
      isPrimary: true,
      createdAt: "2025-01-01",
      models: ["normal-1"],
    });

    await database.exec(migration);

    expect(await trioOf(database, "primary")).toEqual({
      fast: "fast-1",
      normal: "normal-1",
      smart: "smart-1",
      key: "primary-primary",
    });
    expect(await trioOf(database, "keeps-key")).toEqual({
      fast: "fast-0",
      normal: "normal-1",
      smart: "smart-1",
      key: "keeps-key-default",
    });
    expect(await trioOf(database, "personal-only")).toEqual({
      fast: "fast-1",
      normal: "normal-0",
      smart: "smart-1",
      key: "personal-only-default",
    });
    const { rows: columns } = await database.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_name = 'agents' AND column_name LIKE '%model_id' ORDER BY 1`,
    );
    expect(columns).toEqual([]);
  } finally {
    await database.close();
  }
});

test("an Auto agent or conversation cannot also name a model pool", async () => {
  const database = await makeDatabase();
  try {
    await database.exec(migration);
    for (const table of ["agents", "conversations"]) {
      await expect(
        database.exec(
          table === "agents"
            ? "INSERT INTO agents (id, organization_id, agent_type, auto_routed, model_pool_id) VALUES ('a', 'o', 'agent', true, 'pool')"
            : "INSERT INTO conversations (id, auto_routed, model_pool_id) VALUES ('c', true, 'pool')",
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
  } finally {
    await database.close();
  }
});
