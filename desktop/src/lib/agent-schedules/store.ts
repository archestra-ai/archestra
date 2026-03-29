/**
 * Agent Schedule Triggers – persistent store (SQLite via better-sqlite3).
 *
 * All mutations return the updated record so callers never need a follow-up
 * SELECT.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { getNextRunDate } from "./cron-utils";
import type {
  AgentSchedule,
  AgentScheduleRun,
  CreateAgentSchedulePayload,
  UpdateAgentSchedulePayload,
} from "./types";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const CREATE_SCHEDULES_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_schedules (
    id          TEXT    PRIMARY KEY,
    agent_id    TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    trigger     TEXT    NOT NULL, -- JSON
    status      TEXT    NOT NULL DEFAULT 'active',
    input       TEXT,             -- JSON or NULL
    last_run_at TEXT,
    next_run_at TEXT,
    run_count   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
  )
`;

const CREATE_SCHEDULE_RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_schedule_runs (
    id           TEXT PRIMARY KEY,
    schedule_id  TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    triggered_at TEXT NOT NULL,
    completed_at TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    error        TEXT,
    FOREIGN KEY (schedule_id) REFERENCES agent_schedules(id) ON DELETE CASCADE
  )
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSchedule(row: Record<string, unknown>): AgentSchedule {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    name: row.name as string,
    trigger: JSON.parse(row.trigger as string),
    status: row.status as AgentSchedule["status"],
    input: row.input ? JSON.parse(row.input as string) : undefined,
    lastRunAt: (row.last_run_at as string) ?? undefined,
    nextRunAt: (row.next_run_at as string) ?? undefined,
    runCount: row.run_count as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToRun(row: Record<string, unknown>): AgentScheduleRun {
  return {
    id: row.id as string,
    scheduleId: row.schedule_id as string,
    agentId: row.agent_id as string,
    triggeredAt: row.triggered_at as string,
    completedAt: (row.completed_at as string) ?? undefined,
    status: row.status as AgentScheduleRun["status"],
    error: (row.error as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// AgentScheduleStore
// ---------------------------------------------------------------------------

export class AgentScheduleStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(CREATE_SCHEDULES_TABLE);
    this.db.exec(CREATE_SCHEDULE_RUNS_TABLE);
  }

  // -------------------------------------------------------------------------
  // Schedule CRUD
  // -------------------------------------------------------------------------

  createSchedule(payload: CreateAgentSchedulePayload): AgentSchedule {
    const now = new Date().toISOString();
    const id = randomUUID();
    const nextRunAt = getNextRunDate(payload.trigger).toISOString();

    this.db
      .prepare(
        `INSERT INTO agent_schedules
           (id, agent_id, name, trigger, status, input, next_run_at, run_count, created_at, updated_at)
         VALUES
           (@id, @agentId, @name, @trigger, @status, @input, @nextRunAt, 0, @now, @now)`
      )
      .run({
        id,
        agentId: payload.agentId,
        name: payload.name,
        trigger: JSON.stringify(payload.trigger),
        status: payload.status ?? "active",
        input: payload.input ? JSON.stringify(payload.input) : null,
        nextRunAt,
        now,
      });

    return this.getScheduleById(id)!;
  }

  getScheduleById(id: string): AgentSchedule | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_schedules WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToSchedule(row) : undefined;
  }

  listSchedulesForAgent(agentId: string): AgentSchedule[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_schedules WHERE agent_id = ? ORDER BY created_at DESC")
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }

  listAllActiveSchedules(): AgentSchedule[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_schedules WHERE status = 'active' ORDER BY next_run_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }

  updateSchedule(id: string, payload: UpdateAgentSchedulePayload): AgentSchedule | undefined {
    const existing = this.getScheduleById(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();

    // Recalculate nextRunAt when the trigger changes
    const trigger = payload.trigger ?? existing.trigger;
    const nextRunAt =
      payload.trigger
        ? getNextRunDate(trigger).toISOString()
        : existing.nextRunAt;

    this.db
      .prepare(
        `UPDATE agent_schedules SET
           name        = @name,
           trigger     = @trigger,
           status      = @status,
           input       = @input,
           next_run_at = @nextRunAt,
           updated_at  = @now
         WHERE id = @id`
      )
      .run({
        id,
        name: payload.name ?? existing.name,
        trigger: JSON.stringify(trigger),
        status: payload.status ?? existing.status,
        input:
          payload.input !== undefined
            ? JSON.stringify(payload.input)
            : existing.input
              ? JSON.stringify(existing.input)
              : null,
        nextRunAt: nextRunAt ?? null,
        now,
      });

    return this.getScheduleById(id)!;
  }

  deleteSchedule(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM agent_schedules WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Schedule execution tracking
  // -------------------------------------------------------------------------

  /** Called by the scheduler just before firing the agent. */
  recordRunStart(scheduleId: string): AgentScheduleRun {
    const schedule = this.getScheduleById(scheduleId);
    if (!schedule) throw new Error(`Schedule not found: ${scheduleId}`);

    const now = new Date().toISOString();
    const runId = randomUUID();

    this.db
      .prepare(
        `INSERT INTO agent_schedule_runs
           (id, schedule_id, agent_id, triggered_at, status)
         VALUES
           (@runId, @scheduleId, @agentId, @now, 'running')`
      )
      .run({ runId, scheduleId, agentId: schedule.agentId, now });

    // Update last_run_at, run_count and next_run_at on the schedule
    const nextRunAt = getNextRunDate(schedule.trigger).toISOString();
    this.db
      .prepare(
        `UPDATE agent_schedules SET
           last_run_at = @now,
           next_run_at = @nextRunAt,
           run_count   = run_count + 1,
           updated_at  = @now
         WHERE id = @scheduleId`
      )
      .run({ now, nextRunAt, scheduleId });

    return this.getRunById(runId)!;
  }

  /** Called when the agent run completes (success or failure). */
  recordRunEnd(
    runId: string,
    result: { status: "success" | "failed"; error?: string }
  ): AgentScheduleRun | undefined {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE agent_schedule_runs SET
           completed_at = @now,
           status       = @status,
           error        = @error
         WHERE id = @runId`
      )
      .run({
        runId,
        now,
        status: result.status,
        error: result.error ?? null,
      });
    return this.getRunById(runId);
  }

  getRunById(runId: string): AgentScheduleRun | undefined {
    const row = this.db
      .prepare("SELECT * FROM agent_schedule_runs WHERE id = ?")
      .get(runId) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRunsForSchedule(scheduleId: string, limit = 50): AgentScheduleRun[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_schedule_runs
         WHERE schedule_id = ?
         ORDER BY triggered_at DESC
         LIMIT ?`
      )
      .all(scheduleId, limit) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  /** Return schedules whose next_run_at is on or before `now`. */
  getDueSchedules(now: Date = new Date()): AgentSchedule[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_schedules
         WHERE status = 'active' AND next_run_at <= ?
         ORDER BY next_run_at ASC`
      )
      .all(now.toISOString()) as Record<string, unknown>[];
    return rows.map(rowToSchedule);
  }
}
