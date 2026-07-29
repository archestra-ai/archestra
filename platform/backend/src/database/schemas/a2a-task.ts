import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { A2ATaskState } from "@/types/a2a-task";
import a2aContextTable from "./a2a-context";
import agentsTable from "./agent";

const a2aTaskTable = pgTable(
  "a2a_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contextId: uuid("context_id")
      .notNull()
      .references(() => a2aContextTable.id, { onDelete: "cascade" }),
    /**
     * Agent the task was created against. Nullable for pre-existing rows and
     * for tasks whose agent was deleted (SET NULL keeps the task and its
     * context history intact); when set, task reads/cancels/subscribes must
     * match the route's agent, and NULL rows fall back to actor/context
     * ownership validation alone.
     */
    agentId: uuid("agent_id").references(() => agentsTable.id, {
      onDelete: "set null",
    }),
    state: text("state").$type<A2ATaskState>().notNull(),
    /** Human-readable reason for a FAILED or CANCELED terminal state. */
    statusReason: text("status_reason"),
    /**
     * When `state` last changed. This — not `updatedAt` — is the protocol's
     * `TaskStatus.timestamp` and the ListTasks ordering/cursor key, so
     * heartbeats and message appends can never reorder pagination.
     */
    stateChangedAt: timestamp("state_changed_at", { mode: "date" }),
    /**
     * Liveness signal of the run currently executing this task. Touched every
     * ~30s while a run is active; a task in an active state whose heartbeat
     * went stale is an orphan (its pod died) and gets reaped to FAILED.
     */
    lastHeartbeatAt: timestamp("last_heartbeat_at", { mode: "date" }),
    /**
     * Allocator for `a2a_task_event.seq`: incremented and read in the same
     * transaction that inserts the event, so sequences are gapless and
     * strictly ordered per task (mirrors `skill_sandboxes.next_replay_sequence`).
     */
    nextEventSeq: integer("next_event_seq").notNull().default(1),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("a2a_task_context_id_idx").on(table.contextId),
    index("a2a_task_updated_at_idx").on(table.updatedAt),
    // ListTasks scans an actor's contexts' tasks ordered by status change;
    // the cursor is (stateChangedAt, id).
    index("a2a_task_agent_state_changed_idx").on(
      table.agentId,
      table.stateChangedAt,
      table.id,
    ),
  ],
);

export default a2aTaskTable;
