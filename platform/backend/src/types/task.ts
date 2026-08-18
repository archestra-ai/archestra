import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export type TaskHandlerContext = { taskId: string };
export type TaskHandler = (
  payload: Record<string, unknown>,
  context: TaskHandlerContext,
) => Promise<void>;

export const TaskStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "dead",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskTypeSchema = z.enum([
  "connector_sync",
  "batch_embedding",
  "permission_sync",
  "check_due_connectors",
  "check_due_permission_syncs",
  "check_due_schedule_triggers",
  "schedule_trigger_run_execute",
  "audit_log_cleanup",
  "content_retention_cleanup",
  "content_encryption_backfill",
  "check_due_skill_github_syncs",
  "skill_github_sync",
  "skill_publication_backfill",
  "p4_shim_reconcile",
  "batch_analysis_row",
]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export type ConnectorSyncPayload = {
  connectorId: string;
  continuationCount?: number;
};
export type BatchEmbeddingPayload = {
  documentIds: string[];
  connectorRunId: string;
};
export type PermissionSyncPayload = {
  connectorId: string;
};
export type SkillGithubSyncPayload = {
  skillId: string;
};
/**
 * One row of a batch analysis: resolve the row's source once, then answer every
 * not-yet-`done` column against it. The unit of work is a row rather than a cell
 * so a row's source text is fetched and paid for once per pass, no matter how
 * many columns it carries.
 */
export type BatchAnalysisRowPayload = {
  runId: string;
  rowId: string;
};

// ===== Queue lanes (runtime isolation) =====

/**
 * Execution lanes derived statically from task type (no `tasks` schema change).
 * Each lane has its own dequeue filter and concurrency cap in the worker, so a
 * saturated lane can neither consume another lane's slots nor head-of-line-block
 * its dequeue. `permission_sync` runs wholly in its own lane, isolated from
 * content ingestion and from live queries.
 */
export const TASK_LANES = {
  content: ["connector_sync", "batch_embedding"],
  permission: ["permission_sync"],
  // Batch analysis gets its own lane because a run is user-initiated and
  // interactive — someone is watching cells fill in — while the content lane is
  // sized for background embedding (default cap of 2). Sharing a lane would let
  // a large sync stall a review, and a large review stall ingestion.
  analysis: ["batch_analysis_row"],
  system: [
    "check_due_connectors",
    "check_due_permission_syncs",
    "check_due_schedule_triggers",
    "schedule_trigger_run_execute",
    "audit_log_cleanup",
    "content_retention_cleanup",
    "content_encryption_backfill",
    "check_due_skill_github_syncs",
    "skill_github_sync",
    "skill_publication_backfill",
    "p4_shim_reconcile",
  ],
} as const satisfies Record<string, TaskType[]>;

export type TaskLane = keyof typeof TASK_LANES;

export const SelectTaskSchema = createSelectSchema(schema.tasksTable, {
  taskType: TaskTypeSchema,
  status: TaskStatusSchema,
});
export const InsertTaskSchema = createInsertSchema(schema.tasksTable, {
  taskType: TaskTypeSchema,
  status: TaskStatusSchema.optional(),
}).omit({ id: true, createdAt: true });
export const UpdateTaskSchema = createUpdateSchema(schema.tasksTable, {
  status: TaskStatusSchema.optional(),
}).pick({
  status: true,
  startedAt: true,
  completedAt: true,
  lastError: true,
  scheduledFor: true,
});

export type Task = z.infer<typeof SelectTaskSchema>;
export type InsertTask = z.infer<typeof InsertTaskSchema>;
export type UpdateTask = z.infer<typeof UpdateTaskSchema>;
