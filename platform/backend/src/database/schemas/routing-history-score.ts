import { sql } from "drizzle-orm";
import {
  check,
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

/** A history session's reading by one scorer version; `features` only when scored. */
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
    scorerCost: numeric("scorer_cost", { precision: 13, scale: 10 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.historySessionId, table.scorerVersionId] }),
    check(
      "routing_history_scores_status_check",
      sql`${table.status} IN ('scored', 'no_text', 'failed')`,
    ),
    check(
      "routing_history_scores_features_check",
      sql`(${table.features} IS NOT NULL) = (${table.status} = 'scored')`,
    ),
  ],
);

export default routingHistoryScoresTable;
