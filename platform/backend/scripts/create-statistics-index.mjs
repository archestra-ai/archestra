import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const INDEX_NAME = "interactions_statistics_v2_idx";
const LOCK_KEY = "42816120972513";
const COLUMNS = [
  "created_at",
  "profile_id",
  "connector_id",
  "app_id",
  "user_id",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cost",
  "baseline_cost",
  "cache_savings",
  "billing_mode",
];

/**
 * Operator-run, outside Drizzle's migration transaction and application startup.
 * The dedicated connection must connect directly to PostgreSQL, or use session
 * pooling: both the advisory lock and concurrent DDL span multiple transactions.
 */
export async function createStatisticsIndex(
  client,
  // PGlite tests use the non-concurrent form; the CLI always builds concurrently.
  { concurrently = true } = {},
) {
  // Apply these after connecting: a DSN's options parameter overrides pg's
  // constructor options and must not remove the maintenance safety bounds.
  await client.query("SET lock_timeout = '5s'");
  await client.query("SET statement_timeout = '30min'");
  const lock = await client.query(
    "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
    [LOCK_KEY],
  );
  if (!lock.rows[0].acquired) {
    throw new Error("Another statistics index build is running; retry later.");
  }

  try {
    const existing = await inspectIndex(client);
    if (existing) {
      assertDefinition(existing);
      if (existing.indisvalid && existing.indisready) return "already_valid";
      // An interrupted concurrent build can leave an invalid index. IF NOT
      // EXISTS alone would silently keep it, so remove only our matching index.
      await client.query(
        `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}"public"."${INDEX_NAME}"`,
      );
    }
    await client.query(
      `CREATE INDEX ${concurrently ? "CONCURRENTLY " : ""}"${INDEX_NAME}" ` +
        `ON "public"."interactions" ("created_at") INCLUDE (` +
        COLUMNS.slice(1)
          .map((column) => `"${column}"`)
          .join(", ") +
        ")",
    );
    const built = await inspectIndex(client);
    assertDefinition(built);
    if (!built.indisvalid || !built.indisready) {
      throw new Error("Statistics index build did not produce a valid index.");
    }
    return existing ? "rebuilt_invalid" : "created";
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
  }
}

async function inspectIndex(client) {
  const result = await client.query(
    `SELECT c.relkind, am.amname, i.indisvalid, i.indisready,
            i.indisunique, i.indnkeyatts,
            i.indrelid = 'public.interactions'::regclass AS correct_table,
            i.indpred IS NULL AND i.indexprs IS NULL AS plain_columns,
            ARRAY(
              SELECT a.attname::text
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, position)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              ORDER BY k.position
            ) AS columns
     FROM pg_class c
     LEFT JOIN pg_index i ON i.indexrelid = c.oid
     LEFT JOIN pg_am am ON am.oid = c.relam
     WHERE c.oid = to_regclass($1)`,
    [`public.${INDEX_NAME}`],
  );
  return result.rows[0];
}

function assertDefinition(index) {
  if (
    !index ||
    index.relkind !== "i" ||
    index.amname !== "btree" ||
    !index.correct_table ||
    !index.plain_columns ||
    index.indisunique ||
    index.indnkeyatts !== 1 ||
    index.columns.join(",") !== COLUMNS.join(",")
  ) {
    throw new Error(
      `Unexpected definition for ${INDEX_NAME}; inspect it before retrying.`,
    );
  }
}

async function main() {
  dotenv.config({
    path: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../.env",
    ),
    quiet: true,
  });
  const databaseUrl =
    process.env.ARCHESTRA_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("Set ARCHESTRA_DATABASE_URL or DATABASE_URL.");
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    application_name: "archestra-statistics-index-maintenance",
  });
  await client.connect();
  try {
    const started = performance.now();
    const status = await createStatisticsIndex(client);
    console.log(
      JSON.stringify({
        index: INDEX_NAME,
        status,
        elapsedMs: Math.round(performance.now() - started),
      }),
    );
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error("Statistics index maintenance failed:", error.message);
    process.exitCode = 1;
  });
}
