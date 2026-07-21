import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import skillsTable from "./skill";

/**
 * Append-only log of skill activations, one row per activation counted by
 * `SkillModel.recordUsage` (which also bumps the aggregate `skills.usage_count`).
 * Backs per-skill usage analytics: who activated a skill, and when.
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
