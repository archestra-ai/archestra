import { jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Secrets table - stores sensitive credentials for MCP servers
 *
 * The secret column stores authentication data in flexible JSON format:
 * - For OAuth: { "access_token": "...", "refresh_token": "...", "expires_in": ..., "token_type": "Bearer" }
 * - For Personal Access Tokens: { "access_token": "token_value" }
 *
 * Note: We use "access_token" consistently for both OAuth and PAT tokens to simplify the code
 */
const secretTable = pgTable("secret", {
  id: uuid("id").primaryKey().defaultRandom(),
  secret: jsonb("secret").notNull().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default secretTable;
