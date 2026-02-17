import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import config from "@/config";
import logger from "@/logging";
import * as schema from "./schemas";
import {
  DATABASE_URL_VAULT_REF_ENV,
  getDatabaseUrlFromVault,
  isReadonlyVaultEnabled,
} from "./vault-database-url";

/** Type for database transactions */
export type Transaction = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

/**
 * Initialize the database connection pool.
 * This must be called before any database operations.
 *
 * The function:
 * 1. Checks if ARCHESTRA_DATABASE_URL_VAULT_REF is set AND READONLY_VAULT is enabled
 * 2. If so, reads database URL from Vault
 * 3. Otherwise falls back to ARCHESTRA_DATABASE_URL or DATABASE_URL env vars
 * 4. Creates the connection pool with keepalive settings
 *
 * @throws Error if database URL is not configured anywhere
 */
export async function initializeDatabase(): Promise<void> {
  if (db) {
    return; // Already initialized
  }

  let connectionString: string;

  const vaultRef = process.env[DATABASE_URL_VAULT_REF_ENV];
  if (vaultRef && isReadonlyVaultEnabled()) {
    // READONLY_VAULT is enabled and vault ref is set - read from Vault
    const vaultUrl = await getDatabaseUrlFromVault(vaultRef);
    if (vaultUrl) {
      logger.info(
        { connectionStringPrefix: vaultUrl.slice(0, 10) },
        "Database URL successfully loaded from Vault",
      );
      connectionString = vaultUrl;
    } else {
      logger.info("Database URL not found in Vault, falling back to env var");
      connectionString = config.database.url;
    }
  } else {
    // Use env var
    logger.info(
      "ARCHESTRA_DATABASE_URL_VAULT_REF is not set or READONLY_VAULT is not enabled, falling back to env var",
    );
    connectionString = config.database.url;
  }

  pool = createPool(connectionString);
  db = drizzle({
    client: pool,
    schema,
  });

  instrumentDrizzleClient(db, { dbSystem: "postgresql" });
  logger.info("Database connection pool initialized");
}

/**
 * Get the database instance.
 * @throws Error if database is not initialized
 */
export function getDb() {
  if (!db) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() first.",
    );
  }
  return db;
}

/**
 * Check if the database connection is healthy by executing a simple query.
 * Returns true if the database is reachable, false otherwise.
 *
 * Uses a 3-second timeout to prevent hanging probes under high load.
 * This is called every 10 seconds by K8s readiness probes (per Helm config).
 */
export async function isDatabaseHealthy(): Promise<boolean> {
  if (!pool) {
    return false;
  }

  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Health check timeout")), 3000),
      ),
    ]);
    return true;
  } catch (error) {
    logger.warn({ error }, "Database health check failed");
    return false;
  }
}

/**
 * Default export for backward compatibility.
 * Uses a Proxy to defer access until after initialization.
 */
export default new Proxy({} as ReturnType<typeof getDb>, {
  get(_, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export { schema };

/**
 * Set the database instance directly (for testing purposes only).
 * This bypasses the normal initialization flow.
 * @internal
 */
export function __setTestDb(
  testDb: ReturnType<typeof drizzle<typeof schema>>,
): void {
  db = testDb;
}

// ============================================================
// Internal implementation
// ============================================================

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

/**
 * Create a connection pool with proper keepalive settings to prevent
 * "Connection terminated unexpectedly" errors.
 *
 * This addresses an issue where connections were being
 * terminated by network infrastructure (load balancers, NAT gateways) due to
 * idle timeouts.
 *
 * Pool configuration:
 * - max: 20 connections (reasonable default for Node.js)
 * - idleTimeoutMillis: 30s (close idle connections after 30s)
 * - connectionTimeoutMillis: 10s (fail if can't get connection in 10s)
 *
 * Connection keepalive configuration:
 * - keepAlive: true (enable TCP keepalive probes)
 * - keepAliveInitialDelayMillis: 10s (start probes after 10s of idle)
 *
 * The keepalive settings help prevent load balancers and NAT gateways from
 * terminating idle connections, which is a common cause of the
 * "Connection terminated unexpectedly" error in cloud environments.
 */
function createPool(connectionString: string): pg.Pool {
  const newPool = new pg.Pool({
    connectionString,
    // Pool configuration
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Keepalive configuration to prevent "Connection terminated unexpectedly"
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  /**
   * Handle errors on idle clients in the pool.
   * Without this handler, connection errors on idle clients would cause
   * an unhandled 'error' event and crash the process.
   * The pool will automatically remove the errored client and create a new one.
   */
  newPool.on("error", (err) => {
    logger.error({ err }, "Unexpected error on idle database client");
  });

  return newPool;
}
