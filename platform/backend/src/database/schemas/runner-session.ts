import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import a2aTasksTable from "./a2a-task";
import runnersTable from "./runner";
import usersTable from "./user";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * The pod carrying one A2A task.
 *
 * Deliberately holds no state of its own: the task's own state machine is the
 * record of how the work is going, and a second one would only be a source of
 * disagreement. This row answers "which Kubernetes objects belong to this
 * task, and whose credentials are in them" — nothing else.
 */
const runnerSessionsTable = pgTable(
  "runner_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** One pod per task. */
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTasksTable.id, { onDelete: "cascade" }),
    runnerId: uuid("runner_id")
      .notNull()
      .references(() => runnersTable.id, { onDelete: "cascade" }),
    /** The person the session acts as; its credentials are the ones injected. */
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** Frozen at creation so a rename can never orphan the workload. */
    deploymentName: text("deployment_name").notNull(),
    namespace: text("namespace").notNull(),
    secretName: text("secret_name"),
    /** Revoked when the session ends; a live key outliving its pod keeps billing. */
    virtualApiKeyId: uuid("virtual_api_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("runner_sessions_task_id_uidx").on(table.taskId),
    uniqueIndex("runner_sessions_deployment_name_uidx").on(table.deploymentName),
    index("runner_sessions_runner_id_idx").on(table.runnerId),
    index("runner_sessions_organization_id_idx").on(table.organizationId),
  ],
);

export default runnerSessionsTable;
