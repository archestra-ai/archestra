import { instrumentDrizzleClient } from "@kubiks/otel-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import config from "@/config";
import logger from "@/logging";
import * as schema from "./schemas";

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
const pool = new pg.Pool({
  connectionString: config.database.url,
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
pool.on("error", (err) => {
  logger.error({ err }, "Unexpected error on idle database client");
});

const db = drizzle({
  client: pool,
  schema,
});

instrumentDrizzleClient(db, { dbSystem: "postgresql" });

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export default db;
export { schema };
