import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "vitest";

const migration = (name: string) =>
  readFileSync(new URL(`./${name}.sql`, import.meta.url), "utf8");

const TIER_COLUMNS = [
  "fast_model_id",
  "smart_model_id",
  "auto_routing_fast_model_id",
  "auto_routing_normal_model_id",
  "auto_routing_smart_model_id",
];

const MODEL = {
  fast0: "00000000-0000-4000-8000-000000000010",
  normal0: "00000000-0000-4000-8000-000000000020",
  smart0: "00000000-0000-4000-8000-000000000030",
  fast1: "00000000-0000-4000-8000-000000000011",
  normal1: "00000000-0000-4000-8000-000000000021",
  smart1: "00000000-0000-4000-8000-000000000031",
};
const KEY = "00000000-0000-4000-8000-000000000100";

/** The tables 0613 and this migration read, as they stood before 0613. */
async function makeDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE TABLE models (id uuid PRIMARY KEY);
    CREATE TABLE chat_api_keys (
      id uuid PRIMARY KEY,
      organization_id text NOT NULL,
      user_id text,
      is_primary boolean NOT NULL DEFAULT false,
      created_at timestamp NOT NULL
    );
    CREATE TABLE api_key_models (api_key_id uuid NOT NULL, model_id uuid NOT NULL);
    CREATE TABLE organization (
      id text PRIMARY KEY,
      default_model_id uuid,
      default_llm_api_key_id uuid,
      default_fast_model_id uuid,
      default_smart_model_id uuid
    );
    CREATE TABLE conversations (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      agent_id text,
      model_id uuid,
      model_pool_id uuid,
      deleted_at timestamp
    );
    CREATE TABLE agents (
      id text PRIMARY KEY,
      organization_id text NOT NULL,
      agent_type text NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      deleted_at timestamp,
      auto_routing_enabled boolean NOT NULL DEFAULT false,
      auto_routing_budget_usd_per_day numeric,
      runtime jsonb,
      llm_api_key_id uuid,
      model_id uuid,
      model_pool_id uuid,
      ${TIER_COLUMNS.map(
        (column) =>
          `${column} uuid CONSTRAINT agents_${column}_models_id_fk REFERENCES models(id)`,
      ).join(",\n")}
    );
    ${TIER_COLUMNS.map(
      (column) => `CREATE INDEX agents_${column}_idx ON agents (${column});`,
    ).join("\n")}
    INSERT INTO models VALUES
      ${Object.values(MODEL)
        .map((id) => `('${id}')`)
        .join(", ")};
  `);
  return database;
}

test("an organization 0613 parked for the startup check routes again, on its tiers and the auto default", async () => {
  const database = await makeDatabase();
  try {
    await database.query(
      "INSERT INTO organization VALUES ('parked', $1, $2, $3, $4)",
      [MODEL.normal0, KEY, MODEL.fast0, MODEL.smart0],
    );
    await database.query(
      "INSERT INTO chat_api_keys VALUES ($1, 'parked', NULL, false, '2026-01-01')",
      [KEY],
    );
    for (const model of Object.values(MODEL)) {
      await database.query("INSERT INTO api_key_models VALUES ($1, $2)", [
        KEY,
        model,
      ]);
    }
    await database.query(
      `INSERT INTO agents (id, organization_id, agent_type, is_default, auto_routing_enabled, auto_routing_budget_usd_per_day, auto_routing_fast_model_id, auto_routing_normal_model_id, auto_routing_smart_model_id)
       VALUES ('proxy', 'parked', 'llm_proxy', true, true, 5, $1, $2, $3)`,
      [MODEL.fast1, MODEL.normal1, MODEL.smart1],
    );
    // An Agent Runtime agent inheriting the default parks the normal tier.
    await database.exec(
      `INSERT INTO agents (id, organization_id, agent_type, runtime) VALUES ('coder', 'parked', 'agent', '{"command":["codex"]}')`,
    );

    await database.exec(migration("0613_org_trio_auto_routed"));
    const parked = await database.query(
      "SELECT auto_routing_enabled AS enabled FROM agents WHERE id = 'proxy'",
    );
    expect(parked.rows).toEqual([{ enabled: false }]);

    await database.exec(migration("0627_keen_thanos"));

    const tiers = await database.query(
      "SELECT tier, model_id, provider_api_key_id AS key FROM auto_routing_tiers ORDER BY tier",
    );
    expect(tiers.rows).toEqual([
      { tier: "fast", model_id: MODEL.fast1, key: KEY },
      { tier: "normal", model_id: MODEL.normal1, key: KEY },
      { tier: "smart", model_id: MODEL.smart1, key: KEY },
    ]);
    const routing = await database.query(
      `SELECT a.auto_routing_enabled AS enabled, o.default_auto_model AS "defaultAuto"
       FROM agents a JOIN organization o ON o.id = a.organization_id
       WHERE a.id = 'proxy'`,
    );
    expect(routing.rows).toEqual([{ enabled: true, defaultAuto: true }]);
  } finally {
    await database.close();
  }
});

test("keeps eligible existing chats on Auto without opting other chats in", async () => {
  const database = await makeDatabase();
  try {
    await database.query(
      "INSERT INTO organization VALUES ('enabled', $1, $2, $3, $4), ('disabled', $1, $2, $3, $4)",
      [MODEL.normal0, KEY, MODEL.fast0, MODEL.smart0],
    );
    await database.query(
      "INSERT INTO chat_api_keys VALUES ($1, 'enabled', NULL, false, '2026-01-01')",
      [KEY],
    );
    for (const model of Object.values(MODEL)) {
      await database.query("INSERT INTO api_key_models VALUES ($1, $2)", [
        KEY,
        model,
      ]);
    }
    await database.query(
      `INSERT INTO agents (id, organization_id, agent_type, is_default, auto_routing_enabled, auto_routing_budget_usd_per_day, auto_routing_fast_model_id, auto_routing_normal_model_id, auto_routing_smart_model_id)
       VALUES ('proxy', 'enabled', 'llm_proxy', true, true, 5, $1, $2, $3)`,
      [MODEL.fast0, MODEL.normal0, MODEL.smart0],
    );
    await database.exec(`
      INSERT INTO agents (id, organization_id, agent_type) VALUES ('chat', 'enabled', 'agent'), ('off', 'disabled', 'agent');
      INSERT INTO agents (id, organization_id, agent_type, runtime, model_id)
        VALUES ('runtime', 'enabled', 'agent', '{"command":["codex"]}', '${MODEL.normal0}');
      INSERT INTO agents (id, organization_id, agent_type, model_id, llm_api_key_id, model_pool_id) VALUES
        ('pinned-model', 'enabled', 'agent', '${MODEL.normal0}', NULL, NULL),
        ('pinned-key', 'enabled', 'agent', NULL, '${KEY}', NULL),
        ('pinned-pool', 'enabled', 'agent', NULL, NULL, '${KEY}');
      INSERT INTO conversations (id, organization_id, agent_id, model_id, model_pool_id, deleted_at) VALUES
        ('pinned-model', 'enabled', 'pinned-model', '${MODEL.normal0}', NULL, NULL),
        ('pinned-key', 'enabled', 'pinned-key', '${MODEL.normal0}', NULL, NULL),
        ('pinned-pool', 'enabled', 'pinned-pool', '${MODEL.normal0}', NULL, NULL),
        ('eligible', 'enabled', 'chat', '${MODEL.normal0}', NULL, NULL),
        ('other-model', 'enabled', 'chat', '${MODEL.smart0}', NULL, NULL),
        ('pool', 'enabled', 'chat', '${MODEL.normal0}', '${KEY}', NULL),
        ('runtime', 'enabled', 'runtime', '${MODEL.normal0}', NULL, NULL),
        ('disabled', 'disabled', 'off', '${MODEL.normal0}', NULL, NULL),
        ('deleted', 'enabled', 'chat', '${MODEL.normal0}', NULL, now()),
        ('missing-agent', 'enabled', NULL, '${MODEL.normal0}', NULL, NULL);
    `);
    await database.exec(migration("0613_org_trio_auto_routed"));
    await database.exec(migration("0627_keen_thanos"));
    const chats = await database.query(
      "SELECT id FROM conversations WHERE auto_model ORDER BY id",
    );
    expect(chats.rows).toEqual([{ id: "eligible" }]);
  } finally {
    await database.close();
  }
});
