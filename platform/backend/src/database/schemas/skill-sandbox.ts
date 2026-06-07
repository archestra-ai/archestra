import { sql } from "drizzle-orm";
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
import conversationsTable from "./conversation";
import usersTable from "./user";

/**
 * Code execution sandbox: durable recipe for a Dagger-materialized container
 * that replays an ordered log of commands, uploads, and skill mounts.
 *
 * Postgres is the source of truth for the recipe (this row + replay log +
 * payload tables). Dagger owns filesystem state and has no retention
 * guarantees — sandboxes are replayed from the log when the cache is cold.
 *
 * Each conversation has at most one `isDefault` sandbox, created lazily on the
 * first command/upload/skill activation; explicit `{fresh}` sandboxes have
 * `isDefault = false`.
 */
const skillSandboxesTable = pgTable(
  "skill_sandboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Conversation the sandbox was created from, when known. */
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "set null" },
    ),
    /**
     * The conversation's implicit default sandbox. At most one per
     * (org, user, conversation) — enforced by the partial unique index below so
     * concurrent first calls cannot create two defaults.
     */
    isDefault: boolean("is_default").notNull().default(false),
    /** Working directory used when a command does not provide an explicit cwd. */
    defaultCwd: text("default_cwd").notNull(),
    /**
     * Next replay sequence to allocate for this sandbox. Bumped atomically when
     * a command, upload, or skill-mount event is appended, giving every replay
     * event a stable total order independent of clock skew or insert timing.
     */
    nextReplaySequence: integer("next_replay_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("skill_sandboxes_organization_id_idx").on(table.organizationId),
    index("skill_sandboxes_user_id_idx").on(table.userId),
    index("skill_sandboxes_conversation_id_idx").on(table.conversationId),
    uniqueIndex("skill_sandboxes_default_uidx")
      .on(table.organizationId, table.userId, table.conversationId)
      .where(sql`${table.isDefault}`),
  ],
);

export default skillSandboxesTable;
