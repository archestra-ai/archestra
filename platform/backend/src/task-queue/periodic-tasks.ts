import type { TaskType } from "@/types";

type PeriodicTaskDefinition = {
  taskType: TaskType;
  intervalSeconds: number;
  payload: Record<string, unknown>;
};

const PERIODIC_TASK_DEFINITIONS: PeriodicTaskDefinition[] = [
  // Runs every 30s (not 60): besides enqueuing due syncs, this task drives
  // connector-run recovery — reaping expired leases, reconciling statuses, and
  // sweeping stalled embeddings — so its cadence is the quantization on how fast
  // a crashed or stalled sync is picked back up.
  { taskType: "check_due_connectors", intervalSeconds: 30, payload: {} },
  // Drives the runtime-isolated permission-sync family: enqueues due
  // permission_sync tasks per the global schedule and reaps expired permission
  // runs. Kept separate from check_due_connectors so content-run recovery is
  // never overloaded with permission concerns.
  {
    taskType: "check_due_permission_syncs",
    intervalSeconds: 30,
    payload: {},
  },
  {
    taskType: "check_due_schedule_triggers",
    intervalSeconds: 60,
    payload: {},
  },
  { taskType: "audit_log_cleanup", intervalSeconds: 86400, payload: {} },
];

export default PERIODIC_TASK_DEFINITIONS;
