import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The newest interaction of every LLM-log session, so the session list can
 * read one page of sessions as an index-ordered scan instead of walking
 * `interactions` and probing each row for a newer sibling.
 *
 * Maintained by database triggers on `interactions` (migration
 * `interaction_session_heads`), not by application code: every writer,
 * including a pod still running the previous build during a rollout, keeps
 * it current. The insert trigger upserts with a `(created_at, id)` comparison,
 * so concurrent inserts into one session cannot regress the head; the delete
 * trigger moves a head back to the newest surviving row when retention
 * removes it. There is no update trigger: nothing updates an interaction
 * row after insert (`session_id`, `created_at` and `user_id` are written
 * once). If that ever changes, the head table needs an AFTER UPDATE trigger.
 *
 * A sessionless interaction is a session of its own, keyed by its id.
 * `sessionless` keeps that key apart from a client session id that happens to
 * spell the same uuid.
 *
 * No foreign keys: an FK to `interactions` would add a check to the LLM
 * proxy's hottest insert, and `user_id` is only an index hint — readers join
 * the head interaction and filter on its current row.
 */
export const interactionSessionHeadsTable = pgTable(
  "interaction_session_heads",
  {
    sessionless: boolean("sessionless").notNull(),
    sessionKey: varchar("session_key").notNull(),
    lastCreatedAt: timestamp("last_created_at", { mode: "date" }).notNull(),
    lastInteractionId: uuid("last_interaction_id").notNull(),
    userId: text("user_id"),
  },
  (table) => [
    primaryKey({ columns: [table.sessionless, table.sessionKey] }),
    index("interaction_session_heads_last_idx").on(
      table.lastCreatedAt.desc(),
      table.lastInteractionId.desc(),
    ),
    index("interaction_session_heads_user_last_idx").on(
      table.userId,
      table.lastCreatedAt.desc(),
      table.lastInteractionId.desc(),
    ),
  ],
);

/**
 * Present while interactions written before the head table existed have not
 * all been folded into it. Readers fall back to scanning `interactions` until
 * the backfill deletes this row; `after_id` lets an interrupted backfill
 * resume where it stopped.
 *
 * Absence means complete, so a fresh install (no history to backfill) and a
 * test database reset both start with a usable head table.
 */
export const interactionSessionHeadsBackfillTable = pgTable(
  "interaction_session_heads_backfill",
  {
    id: integer("id").primaryKey(),
    afterId: uuid("after_id"),
  },
);
