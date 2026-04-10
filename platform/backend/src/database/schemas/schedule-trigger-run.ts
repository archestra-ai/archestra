import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type {
  ScheduleTriggerRunKind,
  ScheduleTriggerRunStatus,
} from "@/types/schedule-trigger";
import scheduleTriggersTable from "./schedule-trigger";

const scheduleTriggerRunsTable = pgTable(
  "schedule_trigger_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => scheduleTriggersTable.id, { onDelete: "cascade" }),
    runKind: text("run_kind").$type<ScheduleTriggerRunKind>().notNull(),
    status: text("status")
      .$type<ScheduleTriggerRunStatus>()
      .notNull()
      .default("running"),
    initiatedByUserId: text("initiated_by_user_id"),
    agentIdSnapshot: uuid("agent_id_snapshot"),
    messageTemplateSnapshot: text("message_template_snapshot"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    error: text("error"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("schedule_trigger_runs_organization_id_idx").on(table.organizationId),
    index("schedule_trigger_runs_trigger_id_idx").on(table.triggerId),
    index("schedule_trigger_runs_status_idx").on(table.status),
  ],
);

export default scheduleTriggerRunsTable;
