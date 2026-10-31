import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migration = readFileSync(
  new URL("./0613_org_trio_auto_routed.sql", import.meta.url),
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
      auto_routing_enabled boolean NOT NULL DEFAULT false,
      runtime jsonb,
      llm_api_key_id text,
      model_id text,
      ${TIER_COLUMNS.map(
        (column) =>
          `${column} text CONSTRAINT agents_${column}_models_id_fk REFERENCES models(id)`,
      ).join(",\n")}
    );
    ${TIER_COLUMNS.map(
      (column) => `CREATE INDEX agents_${column}_idx ON agents (${column});`,
    ).join("\n")}
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
    enabled?: boolean;
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
    `INSERT INTO agents (id, organization_id, agent_type, is_default, auto_routing_enabled, auto_routing_fast_model_id, auto_routing_normal_model_id, auto_routing_smart_model_id)
     VALUES ($1, $2, 'llm_proxy', true, $3, $4, $5, $6)`,
    [
      `proxy-${org.id}`,
      org.id,
      org.enabled ?? false,
      autoFast,
      autoNormal,
      autoSmart,
    ],
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

async function pendingNormalTiers(database: PGlite) {
  const { rows } = await database.query(
    "SELECT * FROM org_trio_pending_normal_tier ORDER BY organization_id",
  );
  return rows;
}

test("auto-routing tiers move into the organization trio, the normal tier only with a shared key, and routing left without its trio is disabled", async () => {
  const database = await makeDatabase();
  try {
    // Tiers everywhere; the normal tier is served by two shared keys and a
    // personal one: the primary shared key wins.
    await addOrganization(database, {
      id: "primary",
      trio: ["fast-0", "normal-0", null],
      defaultKey: "primary-default",
      autoTiers: ["fast-1", "normal-1", "smart-1"],
      enabled: true,
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
      enabled: true,
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
       WHERE table_name = 'agents' AND column_name = ANY($1) ORDER BY 1`,
      [TIER_COLUMNS],
    );
    expect(columns).toEqual([]);
    expect(await pendingNormalTiers(database)).toEqual([]);
    // Routing stays on only where the trio is exactly the tiers it routed.
    const { rows: enabled } = await database.query(
      "SELECT organization_id, auto_routing_enabled AS enabled FROM agents ORDER BY 1",
    );
    expect(enabled).toEqual([
      { organization_id: "keeps-key", enabled: false },
      { organization_id: "personal-only", enabled: false },
      { organization_id: "primary", enabled: true },
    ]);
  } finally {
    await database.close();
  }
});

test("an enabled organization missing a tier is disabled", async () => {
  const database = await makeDatabase();
  try {
    await addOrganization(database, {
      id: "missing",
      trio: [null, "normal-0", null],
      defaultKey: null,
      autoTiers: [null, null, null],
      enabled: true,
    });

    await database.exec(migration);

    const { rows } = await database.query(
      "SELECT auto_routing_enabled AS enabled FROM agents",
    );
    expect(rows).toEqual([{ enabled: false }]);
  } finally {
    await database.close();
  }
});

test("the normal tier waits for the startup check while an Agent Runtime agent inherits the default model", async () => {
  const database = await makeDatabase();
  try {
    await addOrganization(database, {
      id: "runtime",
      trio: ["fast-0", "normal-0", "smart-0"],
      defaultKey: "runtime-default",
      autoTiers: ["fast-1", "normal-1", "smart-1"],
      enabled: true,
    });
    await addKey(database, {
      id: "runtime-default",
      organizationId: "runtime",
      createdAt: "2026-01-01",
      models: ["normal-0", "normal-1"],
    });
    await database.exec(
      `INSERT INTO agents (id, organization_id, agent_type, runtime) VALUES ('coder', 'runtime', 'agent', '{"command":["codex"]}')`,
    );

    await database.exec(migration);

    expect(await trioOf(database, "runtime")).toEqual({
      fast: "fast-1",
      normal: "normal-0",
      smart: "smart-1",
      key: "runtime-default",
    });
    const { rows } = await database.query(
      "SELECT auto_routing_enabled AS enabled FROM agents WHERE id = 'proxy-runtime'",
    );
    expect(rows).toEqual([{ enabled: false }]);
    expect(await pendingNormalTiers(database)).toEqual([
      {
        organization_id: "runtime",
        normal_model_id: "normal-1",
        api_key_id: "runtime-default",
        auto_routing_was_enabled: true,
        expected_default_model_id: "normal-0",
        expected_default_llm_api_key_id: "runtime-default",
        moved: false,
      },
    ]);
  } finally {
    await database.close();
  }
});
