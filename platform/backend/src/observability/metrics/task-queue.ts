/**
 * Prometheus metrics for the database-backed task queue / worker system.
 *
 * Task throughput:
 * rate(task_queue_tasks_enqueued_total[5m])
 *
 * Average task processing time:
 * rate(task_queue_task_duration_seconds_sum[5m]) / rate(task_queue_task_duration_seconds_count[5m])
 */

import client from "prom-client";
import logger from "@/logging";

let taskQueueEnqueuedTotal: client.Counter<string>;
let taskQueueCompletedTotal: client.Counter<string>;
let taskQueueFailedTotal: client.Counter<string>;
let taskQueueDeadTotal: client.Counter<string>;
let taskQueueTaskDuration: client.Histogram<string>;
let taskQueueActiveTasks: client.Gauge<string>;
let taskQueueStuckResetsTotal: client.Counter<string>;

let initialized = false;

export function initializeTaskQueueMetrics(): void {
  if (initialized) return;
  initialized = true;

  taskQueueEnqueuedTotal = new client.Counter({
    name: "task_queue_tasks_enqueued_total",
    help: "Total tasks enqueued",
    labelNames: ["task_type"],
  });

  taskQueueCompletedTotal = new client.Counter({
    name: "task_queue_tasks_completed_total",
    help: "Total tasks completed successfully",
    labelNames: ["task_type"],
  });

  taskQueueFailedTotal = new client.Counter({
    name: "task_queue_tasks_failed_total",
    help: "Total task processing failures (may be retried)",
    labelNames: ["task_type"],
  });

  taskQueueDeadTotal = new client.Counter({
    name: "task_queue_tasks_dead_total",
    help: "Total tasks moved to dead-letter (max retries exceeded)",
    labelNames: ["task_type"],
  });

  taskQueueTaskDuration = new client.Histogram({
    name: "task_queue_task_duration_seconds",
    help: "Task processing duration in seconds",
    labelNames: ["task_type"],
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600],
  });

  taskQueueActiveTasks = new client.Gauge({
    name: "task_queue_active_tasks",
    help: "Currently active (in-flight) tasks",
    labelNames: ["task_type"],
  });

  taskQueueStuckResetsTotal = new client.Counter({
    name: "task_queue_stuck_tasks_reset_total",
    help: "Total stuck tasks reset back to pending",
  });

  logger.info("Task queue metrics initialized");
}

export function reportTaskEnqueued(taskType: string): void {
  if (!taskQueueEnqueuedTotal) return;
  taskQueueEnqueuedTotal.inc({ task_type: taskType });
}

export function reportTaskCompleted(
  taskType: string,
  durationSeconds: number,
): void {
  if (!taskQueueCompletedTotal) return;
  taskQueueCompletedTotal.inc({ task_type: taskType });
  taskQueueTaskDuration.observe({ task_type: taskType }, durationSeconds);
}

export function reportTaskFailed(taskType: string): void {
  if (!taskQueueFailedTotal) return;
  taskQueueFailedTotal.inc({ task_type: taskType });
}

export function reportTaskDead(taskType: string): void {
  if (!taskQueueDeadTotal) return;
  taskQueueDeadTotal.inc({ task_type: taskType });
}

export function reportActiveTaskChange(taskType: string, delta: 1 | -1): void {
  if (!taskQueueActiveTasks) return;
  taskQueueActiveTasks.inc({ task_type: taskType }, delta);
}

export function reportStuckTasksReset(count: number): void {
  if (!taskQueueStuckResetsTotal || count <= 0) return;
  taskQueueStuckResetsTotal.inc(count);
}
