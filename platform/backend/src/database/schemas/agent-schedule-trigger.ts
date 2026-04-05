import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";

export const agentScheduleTriggersTable = pgTable(
  "agent_schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    payload: jsonb("payload").notNull().default({}),
    overlapPolicy: text("overlap_policy", {
      enum: ["skip", "allow_all", "buffer_one"],
    })
      .notNull()
      .default("skip"),
    status: text("status", { enum: ["active", "paused"] })
      .notNull()
      .default("active"),
    lastRunAt: timestamp("last_run_at", { mode: "date" }),
    nextRunAt: timestamp("next_run_at", { mode: "date" }),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_schedule_triggers_agent_id_idx").on(table.agentId),
    index("agent_schedule_triggers_next_run_at_idx").on(table.nextRunAt),
    index("agent_schedule_triggers_status_idx").on(table.status),
  ],
);

export const agentScheduleRunsTable = pgTable(
  "agent_schedule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => agentScheduleTriggersTable.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["success", "failure", "running"] })
      .notNull()
      .default("running"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { mode: "date" }),
    error: text("error"),
    output: jsonb("output"),
  },
  (table) => [
    index("agent_schedule_runs_trigger_id_idx").on(table.triggerId),
    index("agent_schedule_runs_status_idx").on(table.status),
  ],
);
