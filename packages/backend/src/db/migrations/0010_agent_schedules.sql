-- Migration: Agent Schedule Triggers
-- Adds tables for storing cron/interval-based schedule triggers for agents

CREATE TABLE IF NOT EXISTS agent_schedules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,

  -- Trigger type: 'cron' | 'interval'
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron', 'interval')),

  -- For cron triggers: a standard 5-field cron expression (e.g. "0 9 * * 1-5")
  cron_expression TEXT,

  -- For interval triggers: number of milliseconds between runs
  interval_ms INTEGER,

  -- Optional input payload to pass to the agent on each scheduled run (JSON)
  input_payload TEXT DEFAULT '{}',

  -- Whether this schedule is active
  enabled INTEGER NOT NULL DEFAULT 1,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Last/next run tracking
  last_run_at TEXT,
  next_run_at TEXT,
  last_run_status TEXT CHECK (last_run_status IN ('success', 'failure', 'running', NULL)),
  last_run_error TEXT,

  -- Run count
  run_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,

  -- Max consecutive failures before auto-disabling (NULL = no limit)
  max_consecutive_failures INTEGER DEFAULT 5,

  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_schedules_agent_id ON agent_schedules(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_enabled ON agent_schedules(enabled);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_next_run_at ON agent_schedules(next_run_at);

-- Audit log for schedule executions
CREATE TABLE IF NOT EXISTS agent_schedule_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  schedule_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,

  -- The agent run that was triggered (NULL if agent run failed to start)
  agent_run_id TEXT,

  status TEXT NOT NULL CHECK (status IN ('success', 'failure', 'skipped')),
  error TEXT,

  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,

  FOREIGN KEY (schedule_id) REFERENCES agent_schedules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON agent_schedule_runs(schedule_id);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_agent_id ON agent_schedule_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_schedule_runs_started_at ON agent_schedule_runs(started_at);
