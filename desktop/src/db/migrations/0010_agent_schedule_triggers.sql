-- Migration: Agent Schedule Triggers
-- Creates tables for storing cron/interval-based schedule triggers for agents

CREATE TABLE IF NOT EXISTS agent_schedule_triggers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  -- Schedule type: 'cron' | 'interval' | 'once'
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
  -- For cron type: standard cron expression (e.g. "0 9 * * 1-5")
  cron_expression TEXT,
  -- For interval type: interval in seconds
  interval_seconds INTEGER,
  -- For once type: exact datetime to fire
  fire_at TEXT,
  -- Whether the trigger is currently active
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Optional input payload to send to the agent when triggered
  input_payload TEXT DEFAULT '{}',
  -- Timezone for cron evaluation (IANA timezone string)
  timezone TEXT NOT NULL DEFAULT 'UTC',
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Last time this trigger fired
  last_fired_at TEXT,
  -- Next scheduled fire time (computed and cached)
  next_fire_at TEXT,
  -- Number of times this trigger has fired
  fire_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedule_triggers_agent_id ON agent_schedule_triggers(agent_id);
CREATE INDEX IF NOT EXISTS idx_schedule_triggers_enabled ON agent_schedule_triggers(enabled);
CREATE INDEX IF NOT EXISTS idx_schedule_triggers_next_fire_at ON agent_schedule_triggers(next_fire_at);

CREATE TABLE IF NOT EXISTS agent_schedule_trigger_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  trigger_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- Status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  status TEXT NOT NULL DEFAULT 'pending',
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  -- The conversation/run ID that was created
  conversation_id TEXT,
  error_message TEXT,
  FOREIGN KEY (trigger_id) REFERENCES agent_schedule_triggers(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedule_trigger_runs_trigger_id ON agent_schedule_trigger_runs(trigger_id);
CREATE INDEX IF NOT EXISTS idx_schedule_trigger_runs_agent_id ON agent_schedule_trigger_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_schedule_trigger_runs_status ON agent_schedule_trigger_runs(status);
