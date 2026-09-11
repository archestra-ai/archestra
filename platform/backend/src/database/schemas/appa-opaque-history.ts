import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import appaProxySessionsTable from "./appa-proxy-session";

/**
 * A provider context window is a durable frame in one APPA session. Parent
 * links, not client array positions, define which prior opaque items remain
 * valid after a provider compacts or shifts its input.
 */
const appaOpaqueHistoryWindowsTable = pgTable(
  "appa_opaque_history_windows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    protocol: text("protocol").notNull(),
    model: text("model").notNull(),
    providerWindowId: text("provider_window_id").notNull(),
    frameVersion: integer("frame_version").notNull(),
    sourceTurnId: text("source_turn_id").notNull(),
    parentWindowId: uuid("parent_window_id").references(
      (): AnyPgColumn => appaOpaqueHistoryWindowsTable.id,
      { onDelete: "restrict" },
    ),
    /** Server-issued item identity that authorized this successor binding. */
    boundByServerIdentity: text("bound_by_server_identity"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("appa_opaque_history_windows_scope_window_uidx").on(
      table.sessionId,
      table.provider,
      table.protocol,
      table.model,
      table.providerWindowId,
    ),
    uniqueIndex("appa_opaque_history_windows_session_frame_uidx").on(
      table.sessionId,
      table.frameVersion,
    ),
    index("appa_opaque_history_windows_session_turn_idx").on(
      table.sessionId,
      table.sourceTurnId,
    ),
    uniqueIndex("appa_opaque_history_windows_bound_item_uidx")
      .on(table.sessionId, table.boundByServerIdentity)
      .where(sql`${table.boundByServerIdentity} is not null`),
    check(
      "appa_opaque_history_windows_frame_version_check",
      sql`${table.frameVersion} >= 0`,
    ),
  ],
);

/**
 * Provider-issued opaque items. The encrypted payload is the complete
 * canonical provider object, while identityHash is a domain-keyed lookup key.
 */
export const appaOpaqueHistoryItemsTable = pgTable(
  "appa_opaque_history_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    windowId: uuid("window_id")
      .notNull()
      .references(() => appaOpaqueHistoryWindowsTable.id, {
        onDelete: "restrict",
      }),
    provider: text("provider").notNull(),
    protocol: text("protocol").notNull(),
    model: text("model").notNull(),
    /** The provider's original ID, when it actually supplied one. */
    providerItemId: text("provider_item_id"),
    /** Opaque server identity; never presented as a provider-supplied ID. */
    serverIdentity: text("server_identity").notNull(),
    itemType: text("item_type").notNull(),
    sourceTurnId: text("source_turn_id").notNull(),
    identityHash: text("identity_hash").notNull(),
    canonicalPayloadEncrypted: text("canonical_payload_encrypted").notNull(),
    canonicalPayloadBytes: integer("canonical_payload_bytes").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("appa_opaque_history_items_scope_provider_item_uidx")
      .on(
        table.sessionId,
        table.provider,
        table.protocol,
        table.model,
        table.providerItemId,
      )
      .where(sql`${table.providerItemId} is not null`),
    uniqueIndex("appa_opaque_history_items_scope_identity_uidx").on(
      table.sessionId,
      table.provider,
      table.protocol,
      table.model,
      table.identityHash,
    ),
    index("appa_opaque_history_items_window_idx").on(table.windowId),
    index("appa_opaque_history_items_session_turn_idx").on(
      table.sessionId,
      table.sourceTurnId,
    ),
    uniqueIndex("appa_opaque_history_items_server_identity_uidx").on(
      table.serverIdentity,
    ),
    check(
      "appa_opaque_history_items_payload_bytes_check",
      sql`${table.canonicalPayloadBytes} >= 0`,
    ),
  ],
);

export default appaOpaqueHistoryWindowsTable;
