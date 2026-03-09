import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

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
  "check_due_connectors",
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
