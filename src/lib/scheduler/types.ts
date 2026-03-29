/**
 * Agent Schedule Trigger Types
 *
 * Defines the data models for scheduled triggers that can automatically
 * invoke agents at configurable times/intervals.
 */

export type ScheduleTriggerType = "cron" | "interval" | "once";

export interface CronSchedule {
  type: "cron";
  /** Standard cron expression, e.g. "0 9 * * 1-5" */
  expression: string;
  /** IANA timezone string, e.g. "America/New_York". Defaults to "UTC". */
  timezone?: string;
}

export interface IntervalSchedule {
  type: "interval";
  /** Interval value (must be >= 1) */
  value: number;
  unit: "seconds" | "minutes" | "hours" | "days";
}

export interface OnceSchedule {
  type: "once";
  /** ISO-8601 datetime string */
  runAt: string;
}

export type Schedule = CronSchedule | IntervalSchedule | OnceSchedule;

export type ScheduleTriggerStatus =
  | "active"
  | "paused"
  | "completed"
  | "error";

export interface ScheduleTrigger {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  schedule: Schedule;
  status: ScheduleTriggerStatus;
  /** Static input payload forwarded to the agent on each invocation */
  inputPayload?: Record<string, unknown>;
  /** ISO-8601 datetime of the next planned execution */
  nextRunAt?: string;
  /** ISO-8601 datetime of the last execution */
  lastRunAt?: string;
  lastRunStatus?: "success" | "failure";
  lastRunError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleTriggerInput {
  agentId: string;
  name: string;
  description?: string;
  schedule: Schedule;
  inputPayload?: Record<string, unknown>;
}

export interface UpdateScheduleTriggerInput {
  name?: string;
  description?: string;
  schedule?: Schedule;
  status?: ScheduleTriggerStatus;
  inputPayload?: Record<string, unknown>;
}
