/**
 * Types for Agent Schedule Triggers
 */

export type TriggerType = 'cron' | 'interval';
export type ScheduleRunStatus = 'success' | 'failure' | 'running' | 'skipped';

/**
 * Stored in the database as-is
 */
export interface AgentScheduleRow {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  trigger_type: TriggerType;
  cron_expression: string | null;
  interval_ms: number | null;
  input_payload: string; // JSON string
  enabled: number; // SQLite boolean (0|1)
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  next_run_at: string | null;
  last_run_status: ScheduleRunStatus | null;
  last_run_error: string | null;
  run_count: number;
  failure_count: number;
  max_consecutive_failures: number | null;
}

/**
 * Hydrated/serialized shape for API responses
 */
export interface AgentSchedule {
  id: string;
  agentId: string;
  name: string;
  description: string | null;
  triggerType: TriggerType;
  cronExpression: string | null;
  intervalMs: number | null;
  inputPayload: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: ScheduleRunStatus | null;
  lastRunError: string | null;
  runCount: number;
  failureCount: number;
  maxConsecutiveFailures: number | null;
}

export interface AgentScheduleRun {
  id: string;
  scheduleId: string;
  agentId: string;
  agentRunId: string | null;
  status: ScheduleRunStatus;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

/**
 * Request bodies
 */
export interface CreateScheduleRequest {
  agentId: string;
  name: string;
  description?: string;
  triggerType: TriggerType;
  /** Required when triggerType === 'cron' */
  cronExpression?: string;
  /** Required when triggerType === 'interval'; minimum 60_000 ms (1 min) */
  intervalMs?: number;
  inputPayload?: Record<string, unknown>;
  enabled?: boolean;
  maxConsecutiveFailures?: number | null;
}

export interface UpdateScheduleRequest {
  name?: string;
  description?: string;
  cronExpression?: string;
  intervalMs?: number;
  inputPayload?: Record<string, unknown>;
  enabled?: boolean;
  maxConsecutiveFailures?: number | null;
}
