import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  RoutingDecisionFeatures,
  RoutingHistoryScoreStatus,
} from "@/types/auto-routing";
import routingHistorySessionsTable from "./routing-history-session";
import routingScorerVersionsTable from "./routing-scorer-version";

/**
 * A history session's reading by one scorer version; `features` only when
 * scored. `attempts` counts the paid calls taken for it, each committed
 * before its call, so a reading whose commit failed is not paid for unboundedly.
 */
const routingHistoryScoresTable = pgTable(
  "routing_history_scores",
  {
    historySessionId: uuid("history_session_id")
      .notNull()
      .references(() => routingHistorySessionsTable.id, {
        onDelete: "cascade",
      }),
    scorerVersionId: uuid("scorer_version_id")
      .notNull()
      .references(() => routingScorerVersionsTable.id),
    status: text("status").$type<RoutingHistoryScoreStatus>().notNull(),
    features: jsonb("features").$type<RoutingDecisionFeatures>(),
    attempts: integer("attempts").notNull().default(0),
    scorerCost: numeric("scorer_cost", { precision: 13, scale: 10 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.historySessionId, table.scorerVersionId] }),
    check(
      "routing_history_scores_status_check",
      sql`${table.status} IN ('pending', 'scored', 'no_text', 'failed')`,
    ),
    check(
      "routing_history_scores_features_check",
      sql`(${table.features} IS NOT NULL) = (${table.status} = 'scored')`,
    ),
  ],
);

export default routingHistoryScoresTable;
