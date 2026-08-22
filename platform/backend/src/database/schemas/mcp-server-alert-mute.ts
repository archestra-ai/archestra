import { isNotNull, isNull, sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { McpServerDismissibleAlertKind } from "@/types";
import internalMcpCatalogTable from "./internal-mcp-catalog";
import mcpServerTable from "./mcp-server";
import usersTable from "./user";

/**
 * One viewer's dismissal of one catalog or connection alert. It changes only
 * that viewer's queue. `issue_fingerprint` pins it to one failure episode.
 */
const mcpServerAlertMutesTable = pgTable(
  "mcp_server_alert_mutes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    mcpServerId: uuid("mcp_server_id").references(() => mcpServerTable.id, {
      onDelete: "cascade",
    }),
    issueKind: text("issue_kind")
      .$type<McpServerDismissibleAlertKind>()
      .notNull(),
    issueFingerprint: text("issue_fingerprint").notNull(),
    /** Optional free-text note; empty string means no reason was supplied. */
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("mcp_server_alert_mutes_viewer_server_alert_uidx")
      .on(table.userId, table.mcpServerId, table.issueKind)
      .where(isNotNull(table.mcpServerId)),
    uniqueIndex("mcp_server_alert_mutes_viewer_catalog_alert_uidx")
      .on(table.userId, table.catalogId, table.issueKind)
      .where(isNull(table.mcpServerId)),
    index("mcp_server_alert_mutes_catalog_id_idx").on(table.catalogId),
    index("mcp_server_alert_mutes_mcp_server_id_idx").on(table.mcpServerId),
    check(
      "mcp_server_alert_mutes_issue_kind_check",
      sql`${table.issueKind} in ('failed-to-start', 'not-running', 'needs-reauth', 'reinstall-required', 'awaiting-approval', 'stuck-starting')`,
    ),
  ],
);

export default mcpServerAlertMutesTable;
