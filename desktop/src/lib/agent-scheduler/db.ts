/**
 * Database layer for agent schedule triggers.
 * Uses the same better-sqlite3 database instance used by the rest of the app.
 */

import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  AgentScheduleTrigger,
  CreateAgentScheduleTriggerInput,
  UpdateAgentScheduleTriggerInput,
  ScheduleTriggerRunLog,
} from "./types";
import { getNextCronDate, getNextIntervalDate } from "./cron-utils";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export function migrateScheduleTriggerTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_schedule_triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      trigger_config TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      last_run_at TEXT,
      next_run_at TEXT,
      run_count INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL,
      conversation_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ast_agent_id ON agent_schedule_triggers(agent_id);
    CREATE INDEX IF NOT EXISTS idx_ast_status ON agent_schedule_triggers(status);
    CREATE INDEX IF NOT EXISTS idx_ast_next_run ON agent_schedule_triggers(next_run_at);

    CREATE TABLE IF NOT EXISTS agent_schedule_trigger_runs (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      result TEXT NOT NULL DEFAULT 'running',
      error_message TEXT,
      run_id TEXT,
      FOREIGN KEY (trigger_id) REFERENCES agent_schedule_triggers(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_astr_trigger_id ON agent_schedule_trigger_runs(trigger_id);
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToTrigger(row: Record<string, unknown>): AgentScheduleTrigger {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? undefined,
    triggerConfig: JSON.parse(row.trigger_config as string),
    status: row.status as AgentScheduleTrigger["status"],
    lastRunAt: (row.last_run_at as string | null) ?? undefined,
    nextRunAt: (row.next_run_at as string | null) ?? undefined,
    runCount: row.run_count as number,
    prompt: row.prompt as string,
    conversationId: (row.conversation_id as string | null) ?? undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToRunLog(row: Record<string, unknown>): ScheduleTriggerRunLog {
  return {
    id: row.id as string,
    triggerId: row.trigger_id as string,
    agentId: row.agent_id as string,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? undefined,
    result: row.result as ScheduleTriggerRunLog["result"],
    errorMessage: (row.error_message as string | null) ?? undefined,
    runId: (row.run_id as string | null) ?? undefined,
  };
}

function computeNextRunAt(
  config: AgentScheduleTrigger["triggerConfig"],
  lastRunAt?: string
): string | undefined {
  const now = new Date();
  if (config.type === "cron") {
    const next = getNextCronDate(config.expression, now);
    return next?.toISOString();
  }
  if (config.type === "interval") {
    const base = lastRunAt ? new Date(lastRunAt) : null;
    return getNextIntervalDate(config.intervalMs, base).toISOString();
  }
  if (config.type === "once") {
    return config.runAt;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createScheduleTrigger(
  db: Database.Database,
  input: CreateAgentScheduleTriggerInput
): AgentScheduleTrigger {
  const now = new Date().toISOString();
  const id = uuidv4();
  const nextRunAt = computeNextRunAt(input.triggerConfig);

  const stmt = db.prepare(`
    INSERT INTO agent_schedule_triggers
      (id, agent_id, name, description, trigger_config, status, next_run_at, run_count, prompt, conversation_id, created_at, updated_at)
    VALUES
      (@id, @agentId, @name, @description, @triggerConfig, 'active', @nextRunAt, 0, @prompt, @conversationId, @now, @now)
  `);

  stmt.run({
    id,
    agentId: input.agentId,
    name: input.name,
    description: input.description ?? null,
    triggerConfig: JSON.stringify(input.triggerConfig),
    nextRunAt: nextRunAt ?? null,
    prompt: input.prompt,
    conversationId: input.conversationId ?? null,
    now,
  });

  return getScheduleTriggerById(db, id)!;
}

export function getScheduleTriggerById(
  db: Database.Database,
  id: string
): AgentScheduleTrigger | null {
  const row = db
    .prepare("SELECT * FROM agent_schedule_triggers WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToTrigger(row) : null;
}

export function getScheduleTriggersByAgentId(
  db: Database.Database,
  agentId: string
): AgentScheduleTrigger[] {
  const rows = db
    .prepare(
      "SELECT * FROM agent_schedule_triggers WHERE agent_id = ? ORDER BY created_at DESC"
    )
    .all(agentId) as Record<string, unknown>[];
  return rows.map(rowToTrigger);
}

export function getAllActiveScheduleTriggers(
  db: Database.Database
): AgentScheduleTrigger[] {
  const rows = db
    .prepare(
      "SELECT * FROM agent_schedule_triggers WHERE status = 'active' ORDER BY next_run_at ASC"
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToTrigger);
}

export function getDueScheduleTriggers(
  db: Database.Database
): AgentScheduleTrigger[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM agent_schedule_triggers
       WHERE status = 'active'
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?
       ORDER BY next_run_at ASC`
    )
    .all(now) as Record<string, unknown>[];
  return rows.map(rowToTrigger);
}

export function updateScheduleTrigger(
  db: Database.Database,
  id: string,
  input: UpdateAgentScheduleTriggerInput
): AgentScheduleTrigger | null {
  const existing = getScheduleTriggerById(db, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const newConfig = input.triggerConfig ?? existing.triggerConfig;
  const newNextRunAt =
    input.triggerConfig
      ? computeNextRunAt(newConfig)
      : existing.nextRunAt;

  const updates: Record<string, unknown> = {
    id,
    now,
    name: input.name ?? existing.name,
    description: input.description ?? existing.description ?? null,
    triggerConfig: JSON.stringify(newConfig),
    status: input.status ?? existing.status,
    nextRunAt: newNextRunAt ?? null,
    prompt: input.prompt ?? existing.prompt,
    conversationId: input.conversationId ?? existing.conversationId ?? null,
  };

  db.prepare(`
    UPDATE agent_schedule_triggers SET
      name = @name,
      description = @description,
      trigger_config = @triggerConfig,
      status = @status,
      next_run_at = @nextRunAt,
      prompt = @prompt,
      conversation_id = @conversationId,
      updated_at = @now
    WHERE id = @id
  `).run(updates);

  return getScheduleTriggerById(db, id);
}

export function markTriggerFired(
  db: Database.Database,
  id: string
): AgentScheduleTrigger | null {
  const existing = getScheduleTriggerById(db, id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const newRunCount = existing.runCount + 1;

  // For "once" triggers, mark as completed after firing
  const newStatus =
    existing.triggerConfig.type === "once" ? "completed" : existing.status;

  const newNextRunAt =
    newStatus === "completed"
      ? null
      : computeNextRunAt(existing.triggerConfig, now) ?? null;

  db.prepare(`
    UPDATE agent_schedule_triggers SET
      last_run_at = @now,
      next_run_at = @nextRunAt,
      run_count = @runCount,
      status = @status,
      updated_at = @now
    WHERE id = @id
  `).run({
    id,
    now,
    nextRunAt: newNextRunAt,
    runCount: newRunCount,
    status: newStatus,
  });

  return getScheduleTriggerById(db, id);
}

export function deleteScheduleTrigger(
  db: Database.Database,
  id: string
): boolean {
  const result = db
    .prepare("DELETE FROM agent_schedule_triggers WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Run Logs
// ---------------------------------------------------------------------------

export function createRunLog(
  db: Database.Database,
  triggerId: string,
  agentId: string
): ScheduleTriggerRunLog {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO agent_schedule_trigger_runs
      (id, trigger_id, agent_id, started_at, result)
    VALUES
      (@id, @triggerId, @agentId, @now, 'running')
  `).run({ id, triggerId, agentId, now });
  return getRunLogById(db, id)!;
}

export function updateRunLog(
  db: Database.Database,
  id: string,
  update: { result: "success" | "error"; errorMessage?: string; runId?: string }
): ScheduleTriggerRunLog | null {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE agent_schedule_trigger_runs SET
      finished_at = @now,
      result = @result,
      error_message = @errorMessage,
      run_id = @runId
    WHERE id = @id
  `).run({
    id,
    now,
    result: update.result,
    errorMessage: update.errorMessage ?? null,
    runId: update.runId ?? null,
  });
  return getRunLogById(db, id);
}

export function getRunLogById(
  db: Database.Database,
  id: string
): ScheduleTriggerRunLog | null {
  const row = db
    .prepare("SELECT * FROM agent_schedule_trigger_runs WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowToRunLog(row) : null;
}

export function getRunLogsByTriggerId(
  db: Database.Database,
  triggerId: string,
  limit = 50
): ScheduleTriggerRunLog[] {
  const rows = db
    .prepare(
      "SELECT * FROM agent_schedule_trigger_runs WHERE trigger_id = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(triggerId, limit) as Record<string, unknown>[];
  return rows.map(rowToRunLog);
}
