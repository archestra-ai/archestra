import type { TaskType } from "@/types";

type PeriodicTaskDefinition = {
  taskType: TaskType;
  intervalSeconds: number;
  payload: Record<string, unknown>;
};

const PERIODIC_TASK_DEFINITIONS: PeriodicTaskDefinition[] = [
  { taskType: "check_due_connectors", intervalSeconds: 60, payload: {} },
  {
    taskType: "check_due_schedule_triggers",
    intervalSeconds: 60,
    payload: {},
  },
];

export default PERIODIC_TASK_DEFINITIONS;
