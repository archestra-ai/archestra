import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { RunnerEventKind } from "@/types";
import runnersTable from "./runner";
import usersTable from "./user";

/**
 * Append-only history for one runner: state transitions, steer messages, and
 * lifecycle notices. Backs the UI timeline and gives steering an audit trail —
 * every message injected into a live agentic session is attributable to the
 * human (or agent) that sent it.
 */
const runnerEventsTable = pgTable(
  "runner_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runnersTable.id, { onDelete: "cascade" }),
    /** Total order within the runner, allocated via `runners.next_event_sequence`. */
    sequence: integer("sequence").notNull(),
    kind: text("kind").$type<RunnerEventKind>().notNull(),
    /** Short human-readable line rendered in the timeline. */
    message: text("message"),
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    /** Who caused the event; null for control-plane transitions. */
    actorUserId: text("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("runner_events_runner_id_idx").on(table.runnerId),
    uniqueIndex("runner_events_runner_id_sequence_uidx").on(
      table.runnerId,
      table.sequence,
    ),
  ],
);

export default runnerEventsTable;
