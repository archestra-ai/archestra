import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentDeploymentBackend,
  AgentRunActorKind,
  AgentRunCompletionTarget,
} from "@/types/runner";
import a2aTasksTable from "./a2a-task";
import agentsTable from "./agent";
import usersTable from "./user";
import virtualApiKeysTable from "./virtual-api-key";

/**
 * The isolated runtime carrying one A2A task.
 *
 * Deliberately holds no state of its own: the task's own state machine is the
 * record of how the work is going, and a second one would only be a source of
 * disagreement. This row freezes which execution backend owns the task and
 * whose credentials it uses, so reconciliation never depends on mutable Agent
 * configuration.
 */
const agentRunsTable = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    /** One isolated execution per task. */
    taskId: uuid("task_id")
      .notNull()
      .references(() => a2aTasksTable.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /** Actor whose access and credentials the session uses. */
    actorKind: text("actor_kind").$type<AgentRunActorKind>().notNull(),
    actorId: text("actor_id").notNull(),
    /** User FK for personal sessions; null for team/org/system automation. */
    actorUserId: text("actor_user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),
    /** Concise, user-editable label shown beside foreground conversations. */
    title: text("title").notNull().default("Execution"),
    /** Frozen at creation so a rename can never orphan the workload. */
    deploymentName: text("deployment_name").notNull(),
    /** Frozen because a restart must re-adopt through the original backend. */
    backend: text("backend").$type<AgentDeploymentBackend>().notNull(),
    /** Backend-owned placement scope, intentionally not Kubernetes-specific. */
    runtimeScope: text("runtime_scope").notNull(),
    /** Revoked when the session ends; a live key outliving its runtime keeps billing. */
    virtualApiKeyId: uuid("virtual_api_key_id").references(
      () => virtualApiKeysTable.id,
      { onDelete: "set null" },
    ),
    /** Optional channel callback for a detached execution's terminal result. */
    completionTarget:
      jsonb("completion_target").$type<AgentRunCompletionTarget>(),
    /** Reclaimable delivery lease; a crashed sender cannot strand the reply. */
    completionNotificationClaimedAt: timestamp(
      "completion_notification_claimed_at",
      { mode: "date" },
    ),
    /** Set after the provider accepts the terminal reply. */
    completionNotifiedAt: timestamp("completion_notified_at", { mode: "date" }),
    /** Bounded tail of runtime output retained after the execution is removed. */
    logs: text("logs"),
    startedAt: timestamp("started_at", { mode: "date" }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { mode: "date" }),
  },
  (table) => [
    uniqueIndex("agent_runs_task_id_uidx").on(table.taskId),
    uniqueIndex("agent_runs_deployment_name_uidx").on(table.deploymentName),
    index("agent_runs_agent_id_idx").on(table.agentId),
    index("agent_runs_organization_id_idx").on(table.organizationId),
    index("agent_runs_actor_user_id_idx").on(table.actorUserId),
    index("agent_runs_actor_idx").on(table.actorKind, table.actorId),
  ],
);

export default agentRunsTable;
