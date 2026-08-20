import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { McpServerMutableAlertKind } from "@/types";
import mcpServerTable from "./mcp-server";
import usersTable from "./user";

/**
 * One viewer's decision to stop seeing a connection's "needs re-authentication"
 * alert. A mute is deliberately per-user: it hides the alert from whoever asked
 * for it and from nobody else, so a connection owner can never silence a fault
 * an administrator still has to see.
 *
 * `oauth_refresh_failed_at` pins the mute to the exact failure it was taken
 * against. A later refresh failure rewrites `mcp_server.oauth_refresh_failed_at`,
 * the two values stop matching, and the mute stops applying — a fresh fault is
 * always surfaced, even to the person who silenced the previous one. Rows are
 * never deleted on read; applicability is computed, and the next mute replaces
 * the row through the unique index below.
 */
const mcpServerAlertMutesTable = pgTable(
  "mcp_server_alert_mutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServerTable.id, { onDelete: "cascade" }),
    /** Only "needs-reauth" is mutable; the route rejects every other kind. */
    issueKind: text("issue_kind").$type<McpServerMutableAlertKind>().notNull(),
    /** Required free-text justification, shown wherever the mute is listed. */
    reason: text("reason").notNull(),
    /**
     * The `mcp_server.oauth_refresh_failed_at` value this mute was taken
     * against. Not null: a mute is only accepted while the alert is live, and
     * the alert's timestamp is written with `oauth_refresh_error`.
     */
    oauthRefreshFailedAt: timestamp("oauth_refresh_failed_at", {
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // One mute per viewer per alert; also the upsert target that lets a
    // re-mute after a fresh failure replace the stale row.
    uniqueIndex("mcp_server_alert_mutes_viewer_alert_uidx").on(
      table.userId,
      table.mcpServerId,
      table.issueKind,
    ),
    // Backs the FK cascade from `mcp_server`.
    index("mcp_server_alert_mutes_mcp_server_id_idx").on(table.mcpServerId),
    // Only a mutable kind may be stored. Widening the set is a deliberate act:
    // it means deciding that hiding that alert from one viewer is acceptable,
    // so it takes a migration alongside the `McpServerMutableAlertKindSchema`
    // edit rather than happening by accident through a stray write.
    check(
      "mcp_server_alert_mutes_issue_kind_check",
      sql`${table.issueKind} in ('needs-reauth')`,
    ),
  ],
);

export default mcpServerAlertMutesTable;
