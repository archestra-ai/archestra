export type ScheduleType = 'cron' | 'interval' | 'once';
export type TriggerRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface AgentScheduleTrigger {
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  schedule_type: ScheduleType;
  cron_expression?: string;
  interval_seconds?: number;
  fire_at?: string;
  enabled: boolean;
  input_payload: Record<string, unknown>;
  timezone: string;
  created_at: string;
  updated_at: string;
  last_fired_at?: string;
  next_fire_at?: string;
  fire_count: number;
}

export interface AgentScheduleTriggerRun {
  id: string;
  trigger_id: string;
  agent_id: string;
  status: TriggerRunStatus;
  fired_at: string;
  completed_at?: string;
  conversation_id?: string;
  error_message?: string;
}

export interface CreateScheduleTriggerInput {
  agent_id: string;
  name: string;
  description?: string;
  schedule_type: ScheduleType;
  cron_expression?: string;
  interval_seconds?: number;
  fire_at?: string;
  enabled?: boolean;
  input_payload?: Record<string, unknown>;
  timezone?: string;
}

export interface UpdateScheduleTriggerInput {
  name?: string;
  description?: string;
  schedule_type?: ScheduleType;
  cron_expression?: string;
  interval_seconds?: number;
  fire_at?: string;
  enabled?: boolean;
  input_payload?: Record<string, unknown>;
  timezone?: string;
}

// Common interval presets for the UI
export const INTERVAL_PRESETS = [
  { label: 'Every minute', seconds: 60 },
  { label: 'Every 5 minutes', seconds: 300 },
  { label: 'Every 15 minutes', seconds: 900 },
  { label: 'Every 30 minutes', seconds: 1800 },
  { label: 'Every hour', seconds: 3600 },
  { label: 'Every 6 hours', seconds: 21600 },
  { label: 'Every 12 hours', seconds: 43200 },
  { label: 'Every day', seconds: 86400 },
  { label: 'Every week', seconds: 604800 },
] as const;

// Common cron presets
export const CRON_PRESETS = [
  { label: 'Every minute', expression: '* * * * *' },
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Every day at midnight', expression: '0 0 * * *' },
  { label: 'Every day at 9am', expression: '0 9 * * *' },
  { label: 'Every weekday at 9am', expression: '0 9 * * 1-5' },
  { label: 'Every Monday at 9am', expression: '0 9 * * 1' },
  { label: 'Every Sunday at midnight', expression: '0 0 * * 0' },
  { label: 'First day of month', expression: '0 0 1 * *' },
] as const;
