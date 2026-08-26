import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { EvalRunStatus } from "@/types/eval";
import agentsTable from "./agent";
import evalSuitesTable from "./eval-suite";
import usersTable from "./user";

/**
 * Eval runs: one enqueued execution of a suite against an agent. Case
 * inputs/assertions are snapshotted into `eval_run_results` at creation, so a
 * run grades a fixed set even if the suite is edited mid-flight.
 */
const evalRunsTable = pgTable(
  "eval_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    suiteId: uuid("suite_id")
      .notNull()
      .references(() => evalSuitesTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /**
     * Runs started together (one "Run" against several agents) share a group
     * id; the UI renders such a group as a side-by-side comparison. A run
     * started alone is simply the only member of its group.
     */
    groupId: uuid("group_id").notNull().defaultRandom(),
    /** Optional user-supplied label (e.g. a CI build identifier). */
    name: text("name"),
    /**
     * User the run executes as (agent access + LLM credentials). Nulled if the
     * user is removed; the worker then fails the run cleanly.
     */
    createdBy: text("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<EvalRunStatus>().notNull().default("pending"),
    /** Why the run failed (validation, worker crash, enqueue compensation). */
    error: text("error"),
    /** Display snapshots; the full agent config is not versioned in the alpha. */
    agentNameSnapshot: text("agent_name_snapshot").notNull(),
    modelSnapshot: text("model_snapshot"),
    // Denormalized result counts, written at finalize.
    totalCases: integer("total_cases").notNull().default(0),
    passedCases: integer("passed_cases").notNull().default(0),
    failedCases: integer("failed_cases").notNull().default(0),
    erroredCases: integer("errored_cases").notNull().default(0),
    canceledCases: integer("canceled_cases").notNull().default(0),
    startedAt: timestamp("started_at", { mode: "date" }),
    completedAt: timestamp("completed_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("eval_runs_organization_id_created_at_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    index("eval_runs_suite_id_idx").on(table.suiteId),
    index("eval_runs_agent_id_idx").on(table.agentId),
    index("eval_runs_group_id_idx").on(table.groupId),
  ],
);

export default evalRunsTable;
