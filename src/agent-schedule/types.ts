/**
 * Agent Schedule Triggers — Type Definitions
 *
 * Supports cron-based, interval-based, one-shot, and event-driven triggers
 * for autonomous agent scheduling within Archestra.
 */

export type TriggerType = "cron" | "interval" | "once" | "event";

export type TriggerStatus = "active" | "paused" | "completed" | "failed";

/** A cron-expression trigger (e.g. "0 9 * * 1" = every Monday at 09:00 UTC) */
export interface CronTriggerConfig {
  type: "cron";
  /** Standard 5-field cron expression (minute hour dom month dow) */
  expression: string;
  /** IANA timezone string, defaults to "UTC" */
  timezone?: string;
}

/** A repeating interval trigger (fires every N milliseconds) */
export interface IntervalTriggerConfig {
  type: "interval";
  /** Interval duration in milliseconds */
  intervalMs: number;
  /** Maximum number of times to fire; undefined = unlimited */
  maxRuns?: number;
}

/** A one-shot trigger that fires at a specific UTC datetime */
export interface OnceTriggerConfig {
  type: "once";
  /** ISO-8601 UTC datetime string */
  runAt: string;
}

/** An event-driven trigger that fires when a named event is emitted */
export interface EventTriggerConfig {
  type: "event";
  /** The event name to listen for (e.g. "tool:completed", "memory:updated") */
  eventName: string;
  /** Optional JSON-path filter that must match the event payload */
  filter?: Record<string, unknown>;
  /** Maximum number of times to fire; undefined = unlimited */
  maxRuns?: number;
}

export type TriggerConfig =
  | CronTriggerConfig
  | IntervalTriggerConfig
  | OnceTriggerConfig
  | EventTriggerConfig;

/** A fully-resolved agent schedule trigger stored in the database */
export interface AgentScheduleTrigger {
  id: string;
  /** The agent this trigger belongs to */
  agentId: string;
  /** Human-readable label */
  name: string;
  /** Optional description */
  description?: string;
  /** Polymorphic trigger configuration */
  config: TriggerConfig;
  /** Current lifecycle status */
  status: TriggerStatus;
  /** ISO-8601 creation timestamp */
  createdAt: string;
  /** ISO-8601 last-updated timestamp */
  updatedAt: string;
  /** ISO-8601 timestamp of the next scheduled run (null for event triggers) */
  nextRunAt: string | null;
  /** ISO-8601 timestamp of the last successful run */
  lastRunAt: string | null;
  /** Count of total successful runs */
  runCount: number;
  /** Count of consecutive failures */
  failureCount: number;
  /** User-supplied metadata */
  metadata?: Record<string, unknown>;
}

/** Lightweight DTO for creating a new trigger */
export type CreateAgentScheduleTriggerDto = Omit<
  AgentScheduleTrigger,
  | "id"
  | "createdAt"
  | "updatedAt"
  | "nextRunAt"
  | "lastRunAt"
  | "runCount"
  | "failureCount"
  | "status"
>;

/** Lightweight DTO for updating an existing trigger */
export type UpdateAgentScheduleTriggerDto = Partial<
  Pick<
    AgentScheduleTrigger,
    "name" | "description" | "config" | "status" | "metadata"
  >
>;

/** Execution record produced after a trigger fires */
export interface TriggerExecution {
  id: string;
  triggerId: string;
  agentId: string;
  /** ISO-8601 timestamp when the trigger fired */
  firedAt: string;
  /** ISO-8601 timestamp when the agent run completed */
  completedAt: string | null;
  /** "success" | "error" | "running" */
  result: "success" | "error" | "running";
  /** Error message if result === "error" */
  error?: string;
  /** Any output payload produced by the agent run */
  output?: unknown;
}
