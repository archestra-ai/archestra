/**
 * Agent Schedule Triggers — Type Definitions
 *
 * Supports two scheduling modes:
 *  - cron: standard cron expression (e.g. "0 * * * *")
 *  - interval: repeat every N milliseconds
 */

export type ScheduleType = "cron" | "interval";

export interface CronSchedule {
  type: "cron";
  /** Standard 5-field cron expression, e.g. "0 9 * * 1-5" */
  expression: string;
  /** Optional timezone (IANA), defaults to "UTC" */
  timezone?: string;
}

export interface IntervalSchedule {
  type: "interval";
  /** Interval in milliseconds */
  intervalMs: number;
}

export type Schedule = CronSchedule | IntervalSchedule;

export type ScheduleStatus = "active" | "paused" | "disabled";

export interface AgentScheduleTrigger {
  id: string;
  /** Human-readable name */
  name: string;
  /** ID of the agent to trigger */
  agentId: string;
  schedule: Schedule;
  status: ScheduleStatus;
  /** Optional payload passed to the agent on each trigger */
  payload?: Record<string, unknown>;
  /** ISO timestamp of when this trigger was created */
  createdAt: string;
  /** ISO timestamp of last update */
  updatedAt: string;
  /** ISO timestamp of the last successful execution */
  lastRunAt?: string;
  /** ISO timestamp of the next scheduled execution */
  nextRunAt?: string;
  /** Number of times this trigger has fired */
  runCount: number;
}

export interface CreateScheduleTriggerInput {
  name: string;
  agentId: string;
  schedule: Schedule;
  payload?: Record<string, unknown>;
  status?: ScheduleStatus;
}

export interface UpdateScheduleTriggerInput {
  name?: string;
  schedule?: Schedule;
  payload?: Record<string, unknown>;
  status?: ScheduleStatus;
}

export interface ScheduleTriggerExecution {
  id: string;
  triggerId: string;
  agentId: string;
  /** ISO timestamp when execution started */
  startedAt: string;
  /** ISO timestamp when execution finished */
  finishedAt?: string;
  status: "running" | "success" | "failed";
  /** Error message if status === "failed" */
  error?: string;
  /** Optional result returned by the agent */
  result?: unknown;
}
