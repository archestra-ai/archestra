import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export type TaskHandler = (payload: Record<string, unknown>) => Promise<void>;

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
  "check_due_skill_github_syncs",
  "skill_github_sync",
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
  system: [
    "check_due_connectors",
    "check_due_permission_syncs",
    "check_due_schedule_triggers",
    "schedule_trigger_run_execute",
    "audit_log_cleanup",
    "check_due_skill_github_syncs",
    "skill_github_sync",
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
