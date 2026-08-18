import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import conversationsTable from "./conversation";
import projectsTable from "./project";
import usersTable from "./user";

const scheduleTriggersTable = pgTable(
  "schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /**
     * Owning project (projects feature). Required at the API layer when the
     * projects flag is on; null for legacy/flag-off triggers. CASCADE on
     * project delete: the project's scheduled tasks (and their runs) go with
     * it, rather than surviving as unscoped triggers that keep firing but no
     * longer surface in any project once the projects flag is on.
     */
    projectId: uuid("project_id").references(() => projectsTable.id, {
      onDelete: "cascade",
    }),
    messageTemplate: text("message_template").notNull(),
    /**
     * Recurrence: exactly one of `cronExpression` (recurring) or `runAt`
     * (one-shot) is set — enforced by the CHECK below.
     */
    cronExpression: text("cron_expression"),
    /** One-shot wakeup time. Fires once (`lastExecutedAt` null = not yet). */
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }),
    /**
     * Chat conversation the run is delivered back into as a wake (created by
     * the `schedule_wakeup` tool). Null = classic trigger: each run gets its
     * own conversation. CASCADE: a deleted conversation takes its wakeups.
     */
    conversationId: uuid("conversation_id").references(
      () => conversationsTable.id,
      { onDelete: "cascade" },
    ),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    lastExecutedAt: timestamp("last_executed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("schedule_triggers_agent_id_idx").on(table.agentId),
    index("schedule_triggers_project_id_idx").on(table.projectId),
    index("schedule_triggers_actor_user_id_idx").on(table.actorUserId),
    index("schedule_triggers_enabled_last_executed_at_idx").on(
      table.enabled,
      table.lastExecutedAt,
    ),
    index("schedule_triggers_conversation_id_idx").on(table.conversationId),
    check(
      "schedule_triggers_cron_or_run_at_chk",
      sql`(cron_expression IS NOT NULL) <> (run_at IS NOT NULL)`,
    ),
  ],
);

export default scheduleTriggersTable;
