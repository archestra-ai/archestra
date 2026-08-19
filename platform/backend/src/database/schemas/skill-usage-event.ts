import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import skillsTable from "./skill";

/**
 * Append-only log of skill activations, one row per activation counted by
 * `SkillModel.recordUsage` (which also bumps the aggregate `skills.usage_count`).
 * Backs per-skill usage analytics: who activated a skill, when — and, via
 * `sessionId`/`contextTokens`, what it cost.
 */
const skillUsageEventsTable = pgTable(
  "skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    /**
     * Who activated the skill. Deliberately NOT a foreign key: activations can
     * come from token contexts whose synthetic user ids (e.g.
     * `service-account:<id>`) have no `users` row, and usage history must
     * survive user deletion. Display names are resolved at read time; ids
     * without a `users` row render with a fallback label.
     */
    userId: text("user_id"),
    /**
     * The LLM session this activation happened in, as
     * `interactions.session_id` records it. This is the cost link: a skill works
     * by injecting content into the model's context, so its spend is the spend of
     * the turns that ran with that content — the interactions in this session at
     * or after `createdAt`.
     *
     * Deliberately the interaction session id rather than a conversation FK, for
     * the same reason as `apps.authoring_session_id`: activations happen in
     * headless executions too, and the value exists to join to a varchar session
     * column. Null when the activation carried no session (an activation whose
     * caller has neither a conversation nor an execution key), which simply
     * reports no attributable spend.
     */
    sessionId: text("session_id"),
    /**
     * Tokens the activation block added to the model's context, measured at
     * injection time on the same yardstick as the Context Window Visualizer (the
     * provider tokenizer for the resolved model, the provider default when the
     * activation path has no model in hand).
     *
     * This is the skill's *direct* context footprint, as opposed to the
     * session-attributed spend above: the one number that is entirely the
     * skill's own, since injecting this text is the whole mechanism. Null on
     * rows written before the measurement existed, and on any activation whose
     * block could not be measured.
     */
    contextTokens: integer("context_tokens"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // usage-statistics reads are always "one skill, recent window".
    index("skill_usage_events_skill_created_idx").on(
      table.skillId,
      table.createdAt,
    ),
  ],
);

export default skillUsageEventsTable;
