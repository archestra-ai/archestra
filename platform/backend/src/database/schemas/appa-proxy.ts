import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AppaCheckpointBindingState } from "@/types/appa-proxy";
import appaProxySessionsTable from "./appa-proxy-session";
import { appaProxyWireFramesTable } from "./appa-proxy-wire";

/**
 * Encrypted provider-history evidence for one runtime checkpoint. Runtime
 * receipts remain authoritative; this table only correlates them to client
 * history so a later root can be admitted as an exact fork.
 */
export const appaProxyCheckpointBindingsTable = pgTable(
  "appa_proxy_checkpoint_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceSessionId: uuid("source_session_id")
      .notNull()
      .references(() => appaProxySessionsTable.id, { onDelete: "cascade" }),
    sourceFrameId: uuid("source_frame_id")
      .notNull()
      .references(() => appaProxyWireFramesTable.id, { onDelete: "cascade" }),
    runtimeEventId: uuid("runtime_event_id").notNull(),
    checkpointId: text("checkpoint_id").notNull(),
    checkpointPosition: integer("checkpoint_position").notNull(),
    checkpointDigest: text("checkpoint_digest").notNull(),
    provider: text("provider").notNull(),
    protocol: text("protocol").notNull(),
    model: text("model").notNull(),
    bootstrapDigest: text("bootstrap_digest"),
    requestPrefixHash: text("request_prefix_hash").notNull(),
    inheritedPrefixHash: text("inherited_prefix_hash").notNull(),
    historyCiphertext: text("history_ciphertext").notNull(),
    historyHash: text("history_hash").notNull(),
    historyBytes: integer("history_bytes").notNull(),
    issuedItemsDigest: text("issued_items_digest").notNull(),
    actualResponseHash: text("actual_response_hash").notNull(),
    terminalOmission: boolean("terminal_omission").notNull().default(false),
    state: text("state")
      .$type<AppaCheckpointBindingState>()
      .notNull()
      .default("bound"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("appa_proxy_checkpoint_bindings_session_checkpoint_uidx").on(
      table.sourceSessionId,
      table.checkpointId,
    ),
    uniqueIndex("appa_proxy_checkpoint_bindings_frame_uidx").on(
      table.sourceFrameId,
    ),
    index("appa_proxy_checkpoint_bindings_lookup_idx").on(
      table.provider,
      table.protocol,
      table.model,
      table.bootstrapDigest,
    ),
  ],
);
