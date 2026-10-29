import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RoutingApiShape } from "@/types/auto-routing";
import organizationsTable from "./organization";
import routingBackfillsTable from "./routing-backfill";

/**
 * A past session found by a backfill scan: scalars only, frozen at the scan
 * that first found it. `session_key` is the interactions' session id, scoped
 * to the organization; `sample_rank` orders the deterministic sample.
 */
const routingHistorySessionsTable = pgTable(
  "routing_history_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    backfillId: uuid("backfill_id")
      .notNull()
      .references(() => routingBackfillsTable.id, { onDelete: "cascade" }),
    sessionKey: text("session_key").notNull(),
    sessionSource: text("session_source").notNull(),
    apiShape: text("api_shape").$type<RoutingApiShape>().notNull(),
    client: text("client").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    lastActivityAt: timestamp("last_activity_at", {
      withTimezone: true,
    }).notNull(),
    interactions: integer("interactions").notNull(),
    totalTokens: bigint("total_tokens", { mode: "number" }).notNull(),
    sampleRank: bigint("sample_rank", { mode: "bigint" }).notNull(),
    firstInteractionId: uuid("first_interaction_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("routing_history_sessions_org_session_uidx").on(
      table.organizationId,
      table.sessionKey,
    ),
    index("routing_history_sessions_org_rank_idx").on(
      table.organizationId,
      table.sampleRank,
    ),
    index("routing_history_sessions_backfill_idx").on(table.backfillId),
  ],
);

export default routingHistorySessionsTable;
