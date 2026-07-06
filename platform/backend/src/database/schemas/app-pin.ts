import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import mcpServerTable from "./mcp-server";
import usersTable from "./user";

/**
 * A user's personal pin on an item of the unified Apps surface, mirroring
 * `project_pins`: pinning is per-user — an org-visible app pinned by one member
 * is not pinned for others — and `pinned_at` is both the marker and the sort
 * key for the pinned grouping.
 *
 * The Apps surface lists two kinds of items (types/app.ts AppListItemSchema),
 * so a pin row carries exactly one of two references:
 * - owned app  → `app_id`
 * - external app → `(mcp_server_id, resource_uri)` — one UI resource of one
 *   installed MCP server, the same identity the listing uses.
 * The shape (exactly one reference set) is enforced by AppPinModel, the single
 * writer, rather than a CHECK — matching how app_data enforces its caps.
 */
const appPinsTable = pgTable(
  "app_pins",
  {
    // Surrogate key: the natural keys are the two partial unique indexes below,
    // which can't form a composite PK because each reference column is nullable.
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Owned-app pin target; null for external pins. */
    appId: uuid("app_id").references(() => appsTable.id, {
      onDelete: "cascade",
    }),
    /** External-app pin target (with `resourceUri`); null for owned pins. */
    mcpServerId: uuid("mcp_server_id").references(() => mcpServerTable.id, {
      onDelete: "cascade",
    }),
    resourceUri: text("resource_uri"),
    pinnedAt: timestamp("pinned_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // One pin per (user, owned app) / per (user, install, resource).
    uniqueIndex("app_pins_user_app_uidx")
      .on(table.userId, table.appId)
      .where(sql`${table.appId} IS NOT NULL`),
    uniqueIndex("app_pins_user_external_uidx")
      .on(table.userId, table.mcpServerId, table.resourceUri)
      .where(sql`${table.mcpServerId} IS NOT NULL`),
    // back the FK cascade deletes from `apps` / `mcp_server`
    index("app_pins_app_id_idx").on(table.appId),
    index("app_pins_mcp_server_id_idx").on(table.mcpServerId),
  ],
);

export default appPinsTable;
