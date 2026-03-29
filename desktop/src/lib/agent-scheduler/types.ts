/**
 * Agent Schedule Triggers
 * Types and interfaces for scheduled agent execution
 */

export type ScheduleTriggerType = "cron" | "interval" | "once";

export type ScheduleTriggerStatus = "active" | "paused" | "completed" | "error";

export interface CronTriggerConfig {
  type: "cron";
  /** Standard cron expression, e.g. "0 9 * * 1-5" */
  expression: string;
  /** Optional human-readable label computed from expression */
  label?: string;
}

export interface IntervalTriggerConfig {
  type: "interval";
  /** Interval in milliseconds */
  intervalMs: number;
}

export interface OnceTriggerConfig {
  type: "once";
  /** ISO 8601 datetime string for the single execution */
  runAt: string;
}

export type ScheduleTriggerConfig =
  | CronTriggerConfig
  | IntervalTriggerConfig
  | OnceTriggerConfig;

export interface AgentScheduleTrigger {
  id: string;
  agentId: string;
  /** Display name for the schedule */
  name: string;
  /** Optional description */
  description?: string;
  triggerConfig: ScheduleTriggerConfig;
  status: ScheduleTriggerStatus;
  /** ISO 8601 datetime of last execution */
  lastRunAt?: string;
  /** ISO 8601 datetime of next scheduled execution */
  nextRunAt?: string;
  /** Number of times this trigger has fired */
  runCount: number;
  /** Initial prompt / message to send to the agent when triggered */
  prompt: string;
  /** Optional conversation/thread ID to continue */
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentScheduleTriggerInput {
  agentId: string;
  name: string;
  description?: string;
  triggerConfig: ScheduleTriggerConfig;
  prompt: string;
  conversationId?: string;
}

export interface UpdateAgentScheduleTriggerInput {
  name?: string;
  description?: string;
  triggerConfig?: ScheduleTriggerConfig;
  status?: ScheduleTriggerStatus;
  prompt?: string;
  conversationId?: string;
}

export interface ScheduleTriggerRunLog {
  id: string;
  triggerId: string;
  agentId: string;
  startedAt: string;
  finishedAt?: string;
  /** "success" | "error" | "running" */
  result: "success" | "error" | "running";
  errorMessage?: string;
  /** ID of the conversation/run that was started */
  runId?: string;
}
