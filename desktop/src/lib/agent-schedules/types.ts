/**
 * Agent Schedule Triggers
 *
 * Types and interfaces for scheduling agent runs on cron/interval expressions.
 */

export type ScheduleStatus = "active" | "paused" | "disabled";

export type ScheduleTriggerType = "cron" | "interval";

export interface CronTrigger {
  type: "cron";
  /** Standard 5-field cron expression, e.g. "0 9 * * 1-5" */
  expression: string;
  /** IANA timezone string, defaults to "UTC" */
  timezone?: string;
}

export interface IntervalTrigger {
  type: "interval";
  /** Interval value */
  value: number;
  /** Unit of the interval */
  unit: "minutes" | "hours" | "days";
}

export type ScheduleTrigger = CronTrigger | IntervalTrigger;

export interface AgentSchedule {
  id: string;
  agentId: string;
  /** Human-readable label */
  name: string;
  trigger: ScheduleTrigger;
  status: ScheduleStatus;
  /** Optional initial input passed to the agent on each run */
  input?: Record<string, unknown>;
  /** ISO date of the last execution */
  lastRunAt?: string;
  /** ISO date of the next scheduled execution */
  nextRunAt?: string;
  /** Total number of times this schedule has fired */
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export type CreateAgentSchedulePayload = Omit<
  AgentSchedule,
  "id" | "runCount" | "lastRunAt" | "nextRunAt" | "createdAt" | "updatedAt"
>;

export type UpdateAgentSchedulePayload = Partial<
  Omit<AgentSchedule, "id" | "agentId" | "runCount" | "createdAt" | "updatedAt">
>;

export interface AgentScheduleRun {
  id: string;
  scheduleId: string;
  agentId: string;
  /** ISO date the run was triggered */
  triggeredAt: string;
  /** ISO date the agent run completed (undefined if still running) */
  completedAt?: string;
  status: "pending" | "running" | "success" | "failed";
  error?: string;
}
