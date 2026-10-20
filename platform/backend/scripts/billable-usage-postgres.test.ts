import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { __setTestDb, schema } from "../src/database";
import InteractionBillingModel from "../src/models/interaction-billing";
import LimitModel from "../src/models/limit";
import type {
  BillingAttribution,
  PricedBillingUsage,
} from "../src/utils/billable-usage";

// Explicit opt-in: create an empty task-owned local database before running.
// ARCHESTRA_DATABASE_URL must also be set for application module initialization.
const connectionString = process.env.ARCHESTRA_BILLING_TEST_DATABASE_URL;
assert.ok(
  connectionString,
  "An empty, task-owned local PostgreSQL database is required",
);
const url = new URL(connectionString);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname) &&
    url.pathname.startsWith("/archestra_billing_test"),
  "Refusing a shared or non-local database",
);

test("PostgreSQL receipt concurrency, rollback, reset races and posting overhead", async () => {
  const pool = new Pool({ connectionString, max: 12 });
  __setTestDb(drizzle(pool, { schema }));
  try {
    // Minimal production table subset: independent connections exercise the
    // real receipt/posting/reset methods without unrelated extensions.
    await pool.query(`CREATE TABLE limits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type varchar NOT NULL,
      entity_id text NOT NULL, limit_type varchar NOT NULL, limit_value integer NOT NULL,
      mcp_server_name varchar(255), tool_name varchar(255), model jsonb,
      cleanup_interval varchar DEFAULT '1w' NOT NULL, last_cleanup timestamp,
      created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL);
      CREATE TABLE limit_model_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), limit_id uuid NOT NULL REFERENCES limits(id),
      model varchar(255) NOT NULL, current_usage_tokens_in bigint DEFAULT 0 NOT NULL,
      current_usage_tokens_out bigint DEFAULT 0 NOT NULL, created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL, UNIQUE(limit_id, model));`);
    await pool.query(
      await readFile(
        new URL(
          "../src/database/migrations/0582_loud_zeigeist.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const orgId = `org_${randomUUID()}`;
    const capId = randomUUID();
    await pool.query(
      "INSERT INTO limits(id, entity_type, entity_id, limit_type, limit_value) VALUES($1, 'organization', $2, 'token_cost', 100)",
      [capId, orgId],
    );
    const attribution: BillingAttribution = {
      organizationId: orgId,
      environmentId: null,
      entities: [{ entityType: "organization", entityId: orgId }],
    };
    const usage: PricedBillingUsage = {
      version: 1,
      mode: "enforce",
      status: "complete",
      issues: [],
      cost: "0.0002000000",
      components: [
        {
          id: "primary",
          model: "executor",
          provider: "anthropic",
          kind: "message",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          cost: "0.0002000000",
          prices: {
            input: "1",
            output: "5",
            cacheRead: "0.1",
            cacheWrite: "1.25",
            cacheWrite1h: "2",
            source: "custom",
          },
        },
      ],
    };
    let statements = 0;
    async function settle(id: string, quote = usage, fail = false) {
      const db = drizzle(pool, {
        schema,
        logger: {
          logQuery() {
            statements++;
          },
        },
      });
      return db.transaction(async (tx) => {
        const claimed = await InteractionBillingModel.claim({
          tx,
          interactionId: id,
          usage: quote,
          attribution,
          userId: null,
          billingTeamId: "team_billing_test",
          billingMode: "metered",
        });
        if (claimed)
          await LimitModel.settleBillableUsage({
            tx,
            attribution,
            usage: quote,
          });
        if (fail) throw new Error("injected transaction abort");
        return claimed;
      });
    }
    const id = randomUUID();
    const claims = await Promise.all(
      Array.from({ length: 32 }, () => settle(id)),
    );
    assert.equal(claims.filter(Boolean).length, 1);
    let total = (
      await pool.query(
        "SELECT cost, covered_tokens_in FROM limit_billing_usage",
      )
    ).rows[0];
    assert.equal(total.cost, "0.0002000000");
    assert.equal(total.covered_tokens_in, "100");
    const failedId = randomUUID();
    await assert.rejects(settle(failedId, usage, true));
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM interaction_billing WHERE interaction_id=$1",
          [failedId],
        )
      ).rowCount,
      0,
    );
    await settle(failedId);
    await LimitModel.resetLimitsUsage([capId]);
    assert.equal(await settle(id), false);
    assert.equal(
      (await pool.query("SELECT 1 FROM limit_billing_usage")).rowCount,
      0,
    );
    // Concurrent distinct writers and resets must never split covered tokens
    // from their corresponding legacy counters or deadlock.
    await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        index % 8 === 0
          ? LimitModel.resetLimitsUsage([capId])
          : settle(randomUUID()),
      ),
    );
    const rows = (
      await pool.query(
        `SELECT b.covered_tokens_in, b.cost, l.current_usage_tokens_in FROM limit_billing_usage b JOIN limit_model_usage l USING(limit_id, model)`,
      )
    ).rows;
    for (const row of rows) {
      assert.equal(row.covered_tokens_in, row.current_usage_tokens_in);
      assert.equal(Number(row.cost), Number(row.covered_tokens_in) * 0.000002);
    }
    const changed = structuredClone(usage);
    changed.components[0].inputTokens++;
    await assert.rejects(settle(id, changed), /billing identity/);
    // Warm-cache sequential samples include receipt and all budget writes.
    for (const components of [1, 10]) {
      const quote = structuredClone(usage);
      quote.components = Array.from({ length: components }, (_, index) => ({
        ...usage.components[0],
        id: `iteration:${index}`,
        model: `executor-${index}`,
      }));
      quote.cost = (0.0002 * components).toFixed(10);
      statements = 0;
      const start = performance.now();
      for (let index = 0; index < 40; index++)
        await settle(randomUUID(), quote);
      console.info(
        JSON.stringify({
          components,
          matchedLimits: 1,
          samples: 40,
          meanSettlementMs: (performance.now() - start) / 40,
          meanStatements: statements / 40,
        }),
      );
    }
    const requoted = structuredClone(usage);
    requoted.components[0].prices.input = "99";
    assert.equal(await settle(id, requoted), false);
    const legacyStart = performance.now();
    for (let index = 0; index < 40; index++)
      await LimitModel.recordInteractionTokenUsage({
        agentId: "",
        teamIds: [],
        entities: [],
        attribution,
        model: "executor",
        inputTokens: 100,
        outputTokens: 20,
      });
    console.info(
      JSON.stringify({
        legacyPostingOnlyMeanMs: (performance.now() - legacyStart) / 40,
        samples: 40,
      }),
    );
    total = (
      await pool.query(
        "SELECT count(*)::integer AS receipts FROM interaction_billing",
      )
    ).rows[0];
    console.info(
      JSON.stringify({
        postgres: (await pool.query("SHOW server_version")).rows[0]
          .server_version,
        receipts: total.receipts,
        concurrentReplayAttempts: 32,
        resetRaceOperations: 64,
      }),
    );
  } finally {
    __setTestDb(null);
    await pool.end();
  }
});
