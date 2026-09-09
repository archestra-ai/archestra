import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentRunActorKind,
  AgentRuntimeBackend,
  AgentWorkspaceState,
} from "@/types/agent-runtime";

/** Workspace lifetime is independent of the terminal state of any A2A task.
 * Identity is retained after agent/user deletion so the reaper can still
 * remove the infrastructure; it must never disappear via a cascading FK.
 */
const agentWorkspacesTable = pgTable(
  "agent_workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    actorKind: text("actor_kind").$type<AgentRunActorKind>().notNull(),
    actorId: text("actor_id").notNull(),
    backend: text("backend").$type<AgentRuntimeBackend>().notNull(),
    runtimeScope: text("runtime_scope").notNull(),
    workloadName: text("workload_name").notNull(),
    state: text("state")
      .$type<AgentWorkspaceState>()
      .notNull()
      .default("active"),
    /** Compare-and-set ownership prevents concurrent turns in the same filesystem. */
    activeTaskId: uuid("active_task_id"),
    lastTaskId: uuid("last_task_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    lastActivityAt: timestamp("last_activity_at", { mode: "date" })
      .notNull()
      .defaultNow(),
    idleAt: timestamp("idle_at", { mode: "date" }),
    expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("agent_workspaces_workload_name_uidx").on(table.workloadName),
    index("agent_workspaces_owner_idx").on(
      table.organizationId,
      table.actorKind,
      table.actorId,
    ),
    index("agent_workspaces_expiry_idx").on(table.expiresAt),
  ],
);

export default agentWorkspacesTable;
