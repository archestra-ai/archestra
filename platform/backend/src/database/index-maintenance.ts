import { sql } from "drizzle-orm";
import pg from "pg";
// biome-ignore lint/style/noRestrictedImports: dual-licensed; no-ops when the feature is off
import { isContentEncryptionEnabled } from "@/content-encryption/index.ee";
import db, { getDatabaseConnectionString } from "@/database";
import logger from "@/logging";

/**
 * Drop the legacy pg_trgm GIN indexes over interactions' request/response
 * payloads on deployments that created them before migration 0116 stopped
 * doing so. The free-text search they served no longer exists (the LLM logs
 * UI filters by dropdowns + exact session id), while every hot-path
 * interactions insert paid GIN maintenance over a multi-hundred-KB payload.
 *
 * This runs from worker startup rather than a Drizzle migration because
 * migrations execute inside a transaction, where only the blocking,
 * non-concurrent DROP INDEX is possible — an ACCESS EXCLUSIVE lock on the LLM
 * proxy's hottest table (see the archestra-dev-interactions-migrations rules).
 * DROP INDEX CONCURRENTLY must run outside a transaction, which is exactly
 * what a standalone autocommit statement gives us.
 *
 * Idempotent and race-tolerant: IF EXISTS makes reruns no-ops, and a failure
 * (e.g. two workers racing, or a lock wait aborted) is logged and retried on
 * the next boot.
 */
export async function dropLegacyPayloadTrgmIndexes(
  options: {
    /**
     * Tests set this to false: PGlite's single-backend WASM build rejects
     * DROP INDEX CONCURRENTLY ("tuple concurrently updated"). Production
     * callers always use the concurrent, non-write-blocking form.
     */
    concurrently?: boolean;
  } = {},
): Promise<void> {
  const concurrently = options.concurrently ?? true;
  for (const indexName of LEGACY_PAYLOAD_TRGM_INDEXES) {
    try {
      const existing = await db.execute(
        sql`select to_regclass(${indexName}) as index_oid`,
      );
      if (!existing.rows[0]?.index_oid) {
        continue;
      }

      logger.info({ indexName }, "Dropping legacy payload trgm index");
      await db.execute(
        sql.raw(
          `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS "${indexName}"`,
        ),
      );
      logger.info({ indexName }, "Dropped legacy payload trgm index");
    } catch (error) {
      // Non-fatal: the index keeps working (it is just dead weight), and the
      // next worker boot retries.
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          indexName,
        },
        "Failed to drop legacy payload trgm index; will retry on next boot",
      );
    }
  }
}

/**
 * Build the two partial indexes behind "which agents use this MCP server"
 * (`AgentToolModel.getAssignedAgentDetailsForMcpServers`), the reads behind
 * the MCP server pages and the uninstall confirmation. Without them, both
 * halves of that read scan the whole agent_tools table:
 *
 * - Pinned assignments, `(mcp_server_id, agent_id)`. This index also serves
 *   the ON DELETE SET NULL lookup when an MCP server is removed.
 * - Unpinned (dynamic) assignments, `(tool_id, agent_id)`. The read reaches
 *   them through the tools of the server's catalog.
 *
 * agent_id is in both keys so each DISTINCT read is an index-only scan.
 *
 * Built here rather than in a Drizzle migration for the same reason as the
 * drops above: a migration can only use the blocking CREATE INDEX.
 *
 * Production uses its own connection, not the shared pool. The pool's
 * statement timeout would cancel a long build and leave an invalid index, and
 * the advisory lock below is held by the session. That lock is only sound on a
 * dedicated connection; through a transaction-mode pooler it could be released
 * on another backend.
 *
 * An index with one of our names is checked, not trusted. A valid one with the
 * expected definition is left as is. An invalid one (an interrupted build) is
 * dropped and built again. Any other definition is logged and left alone.
 * Each index is handled on its own, so one failure does not stop the other.
 * Failures are logged and retried on the next boot.
 */
export async function createAgentToolsIndexes(
  options: IndexMaintenanceOptions = {},
): Promise<Record<string, MaintainedIndexResult>> {
  return ensureMaintainedIndexes({
    indexes: AGENT_TOOLS_INDEXES,
    lockKey: AGENT_TOOLS_INDEX_LOCK,
    options,
  });
}

/**
 * Build the partial index behind "the installs of these catalog items":
 * `mcp_server (catalog_id) WHERE deleted_at IS NULL`. The MCP registry's
 * count and its "has an install you can act on" filter test that per catalog
 * row; without the index each test scans every live install, so the count
 * grows with catalog items × installs.
 *
 * Built the same way as {@link createAgentToolsIndexes}: concurrently, on a
 * dedicated connection, under its own advisory lock, checked rather than
 * trusted, and retried on the next boot after a failure.
 */
export async function createMcpServerIndexes(
  options: IndexMaintenanceOptions = {},
): Promise<Record<string, MaintainedIndexResult>> {
  return ensureMaintainedIndexes({
    indexes: MCP_SERVER_INDEXES,
    lockKey: MCP_SERVER_INDEX_LOCK,
    options,
  });
}

/**
 * Build the partial index of interactions that still have no session preview:
 * `interactions (created_at, id) WHERE session_preview IS NULL AND
 * encrypted_chat_conversation_id IS NULL`. The session-preview backfill walks
 * it newest first (`InteractionModel.findRowsMissingSessionPreview`).
 *
 * Every new row is written with a preview, so the index only ever shrinks. Once
 * the backfill is done it is empty, and the backfill's periodic check costs one
 * empty index read instead of a scan of the whole table.
 *
 * Built the same way as {@link createAgentToolsIndexes}: concurrently, so
 * proxy writes to interactions are never blocked.
 */
export async function createInteractionsIndexes(
  options: IndexMaintenanceOptions = {},
): Promise<Record<string, MaintainedIndexResult>> {
  return ensureMaintainedIndexes({
    indexes: INTERACTIONS_INDEXES,
    lockKey: INTERACTIONS_INDEX_LOCK,
    options,
  });
}

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Under enterprise content encryption, `messages.content` and
 * `mcp_tool_calls.tool_result` store ciphertext: the trigram indexes cannot
 * serve searches anymore (conversation search degrades to titles, tool-call
 * search to server name + method) and would pay GIN maintenance on every
 * backfill rewrite. Dropped out-of-band for the same lock-safety reasons as
 * the legacy payload indexes above; the backfill additionally verifies the
 * indexes are gone before rewriting rows, because this drop is best-effort.
 */
export async function dropContentTrgmIndexesUnderEncryption(
  options: { concurrently?: boolean } = {},
): Promise<void> {
  if (!isContentEncryptionEnabled()) return;
  const concurrently = options.concurrently ?? true;
  for (const indexName of ENCRYPTED_CONTENT_TRGM_INDEXES) {
    try {
      const existing = await db.execute(
        sql`select to_regclass(${indexName}) as index_oid`,
      );
      if (!existing.rows[0]?.index_oid) continue;

      logger.info({ indexName }, "Dropping encrypted-content trgm index");
      await db.execute(
        sql.raw(
          `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS "${indexName}"`,
        ),
      );
      logger.info({ indexName }, "Dropped encrypted-content trgm index");
    } catch (error) {
      logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          indexName,
        },
        "Failed to drop encrypted-content trgm index; will retry on next boot",
      );
    }
  }
}
// SPDX-SnippetEnd

// ============================================================
// Internal implementation
// ============================================================

type MaintainedIndexResult =
  | "created"
  | "rebuilt_invalid"
  | "already_valid"
  | "unexpected_definition"
  | "locked"
  | "failed";

interface IndexMaintenanceClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

interface IndexMaintenanceOptions {
  /**
   * Tests set this to false: PGlite rejects the concurrent forms.
   * Production callers always build concurrently.
   */
  concurrently?: boolean;
  /**
   * Tests pass the test database client. Production opens a dedicated
   * connection and closes it when done.
   */
  client?: IndexMaintenanceClient;
}

interface MaintainedIndex {
  table: string;
  name: string;
  columns: readonly string[];
  /** As pg_get_expr prints it, so an existing index can be compared. */
  predicate: string;
}

const AGENT_TOOLS_INDEXES: readonly MaintainedIndex[] = [
  {
    table: "agent_tools",
    name: "agent_tools_mcp_server_id_agent_id_idx",
    columns: ["mcp_server_id", "agent_id"],
    predicate: "(mcp_server_id IS NOT NULL)",
  },
  {
    table: "agent_tools",
    name: "agent_tools_tool_id_agent_id_idx",
    columns: ["tool_id", "agent_id"],
    predicate: "(mcp_server_id IS NULL)",
  },
];
const AGENT_TOOLS_INDEX_LOCK = "index-maintenance:agent_tools";
const MCP_SERVER_INDEXES: readonly MaintainedIndex[] = [
  {
    table: "mcp_server",
    name: "mcp_server_catalog_id_live_idx",
    columns: ["catalog_id"],
    predicate: "(deleted_at IS NULL)",
  },
];
const MCP_SERVER_INDEX_LOCK = "index-maintenance:mcp_server";
const INTERACTIONS_INDEXES: readonly MaintainedIndex[] = [
  {
    table: "interactions",
    name: "interactions_session_preview_missing_idx",
    columns: ["created_at", "id"],
    predicate:
      "((session_preview IS NULL) AND (encrypted_chat_conversation_id IS NULL))",
  },
];
const INTERACTIONS_INDEX_LOCK = "index-maintenance:interactions";
// The concurrent build and drop wait for every older transaction to finish,
// and lock_timeout bounds those waits too. A short bound fails the build
// behind any long transaction and leaves an invalid index that every write
// still updates. The wait does not block reads or writes of the table, but
// it does block VACUUM and DDL on it, so it stays well under the statement
// timeout.
const MAINTENANCE_LOCK_TIMEOUT = "20min";
const MAINTENANCE_STATEMENT_TIMEOUT = "30min";

/**
 * Checks, repairs or builds each index of one table on a dedicated connection
 * under a session advisory lock. Never throws: failures are logged, reported
 * per index and retried on the next boot.
 */
async function ensureMaintainedIndexes(params: {
  indexes: readonly MaintainedIndex[];
  lockKey: string;
  options: IndexMaintenanceOptions;
}): Promise<Record<string, MaintainedIndexResult>> {
  const { indexes, lockKey, options } = params;
  const concurrently = options.concurrently ?? true;
  const indexNames = indexes.map((index) => index.name);
  const results: Record<string, MaintainedIndexResult> = {};
  let connection: pg.Client | null = null;
  try {
    let client = options.client;
    if (!client) {
      connection = await openMaintenanceConnection();
      client = connection;
    }
    // One process builds at a time. The others skip and check again next boot.
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
      [lockKey],
    );
    if (!lock.rows[0]?.acquired) {
      logger.info(
        { indexNames },
        "Another process is building these indexes; skipping",
      );
      for (const name of indexNames) results[name] = "locked";
      return results;
    }
    try {
      for (const index of indexes) {
        results[index.name] = await ensureMaintainedIndex({
          client,
          index,
          concurrently,
        });
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        lockKey,
      ]);
    }
    return results;
  } catch (error) {
    // Opening the connection or taking the lock failed.
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        indexNames,
      },
      "Failed to build indexes; will retry on next boot",
    );
    for (const name of indexNames) results[name] ??= "failed";
    return results;
  } finally {
    await connection?.end().catch(() => {});
  }
}

async function openMaintenanceConnection(): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: getDatabaseConnectionString(),
    connectionTimeoutMillis: 10_000,
    application_name: "archestra-index-maintenance",
  });
  // Without a listener, a dropped connection would crash the process.
  client.on("error", (error) => {
    logger.warn(
      { error: error.message },
      "Index maintenance connection failed",
    );
  });
  try {
    await client.connect();
    // Set after connecting, so options in the connection string cannot remove
    // these bounds.
    await client.query(`SET lock_timeout = '${MAINTENANCE_LOCK_TIMEOUT}'`);
    await client.query(
      `SET statement_timeout = '${MAINTENANCE_STATEMENT_TIMEOUT}'`,
    );
  } catch (error) {
    // The caller only closes a connection it received.
    await client.end().catch(() => {});
    throw error;
  }
  return client;
}

/** Checks, repairs or builds one index and logs the outcome. Never throws. */
async function ensureMaintainedIndex(params: {
  client: IndexMaintenanceClient;
  index: MaintainedIndex;
  concurrently: boolean;
}): Promise<MaintainedIndexResult> {
  const { index } = params;
  const started = performance.now();
  try {
    const result = await buildMaintainedIndex(params);
    const context = {
      table: index.table,
      indexName: index.name,
      result,
      elapsedMs: Math.round(performance.now() - started),
    };
    if (result === "created" || result === "rebuilt_invalid") {
      logger.info(context, "Built index");
    } else if (result === "unexpected_definition") {
      logger.warn(
        context,
        "Index name is taken by an unexpected definition; leaving it alone",
      );
    } else {
      logger.debug(context, "Index is already valid");
    }
    return result;
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        table: index.table,
        indexName: index.name,
      },
      "Failed to build index; will retry on next boot",
    );
    return "failed";
  }
}

async function buildMaintainedIndex(params: {
  client: IndexMaintenanceClient;
  index: MaintainedIndex;
  concurrently: boolean;
}): Promise<MaintainedIndexResult> {
  const { client, index, concurrently } = params;
  const existing = await inspectIndex({
    client,
    name: index.name,
    table: index.table,
  });
  if (existing) {
    if (!hasExpectedDefinition({ existing, index })) {
      return "unexpected_definition";
    }
    if (existing.indisvalid && existing.indisready) return "already_valid";
    // An interrupted concurrent build leaves an invalid index. IF NOT EXISTS
    // would keep it forever, so drop it and build again.
    logger.info(
      { table: index.table, indexName: index.name },
      "Dropping invalid index",
    );
    await client.query(
      `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS "${index.name}"`,
    );
  }

  logger.info({ table: index.table, indexName: index.name }, "Building index");
  await client.query(
    `CREATE INDEX ${concurrently ? "CONCURRENTLY " : ""}"${index.name}" ` +
      `ON "${index.table}" (${index.columns.map((column) => `"${column}"`).join(", ")}) ` +
      `WHERE ${index.predicate}`,
  );
  return existing ? "rebuilt_invalid" : "created";
}

async function inspectIndex(params: {
  client: IndexMaintenanceClient;
  name: string;
  table: string;
}): Promise<Record<string, unknown> | undefined> {
  const { client, name, table } = params;
  const result = await client.query(
    `SELECT c.relkind::text AS relkind, am.amname::text AS amname,
            i.indisvalid, i.indisready, i.indisunique, i.indnkeyatts, i.indnatts,
            i.indrelid = to_regclass($2) AS on_table,
            i.indexprs IS NULL AS plain_columns,
            pg_get_expr(i.indpred, i.indrelid) AS predicate,
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
    [name, table],
  );
  return result.rows[0];
}

function hasExpectedDefinition(params: {
  existing: Record<string, unknown>;
  index: MaintainedIndex;
}): boolean {
  const { existing, index } = params;
  return (
    existing.relkind === "i" &&
    existing.amname === "btree" &&
    existing.on_table === true &&
    existing.plain_columns === true &&
    existing.indisunique === false &&
    // Both counts: (a) INCLUDE (b) lists the same columns as (a, b).
    existing.indnkeyatts === index.columns.length &&
    existing.indnatts === index.columns.length &&
    existing.predicate === index.predicate &&
    Array.isArray(existing.columns) &&
    existing.columns.join(",") === index.columns.join(",")
  );
}

const LEGACY_PAYLOAD_TRGM_INDEXES = [
  "interactions_request_trgm_idx",
  "interactions_response_trgm_idx",
];

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
const ENCRYPTED_CONTENT_TRGM_INDEXES = [
  "messages_content_trgm_idx",
  "mcp_tool_calls_tool_result_trgm_idx",
];
// SPDX-SnippetEnd
