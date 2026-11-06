import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schemas";

/**
 * The Drizzle table definitions, without the database client. Types and
 * schemas import them from here so they do not load the client, its
 * configuration and its instrumentation.
 */
export { schema };

/** Type for database transactions */
export type Transaction = Parameters<
  Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]
>[0];
