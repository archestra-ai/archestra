/**
 * In-memory store for AgentScheduleTriggers with simple CRUD operations.
 *
 * In a production deployment this would be backed by a SQLite / Postgres
 * table.  The store is designed so that the persistence layer can be swapped
 * in transparently by replacing the private `_triggers` / `_executions` maps
 * with DB-backed implementations that expose the same interface.
 */

import { randomUUID } from "crypto";
import {
  AgentScheduleTrigger,
  CreateScheduleTriggerInput,
  ScheduleTriggerExecution,
  UpdateScheduleTriggerInput,
} from "./types";
import { getNextRunDate, getNextIntervalRunDate } from "./cron-utils";

function computeNextRunAt(trigger: AgentScheduleTrigger): string | undefined {
  const { schedule } = trigger;
  if (schedule.type === "cron") {
    const next = getNextRunDate(
      schedule.expression,
      schedule.timezone ?? "UTC"
    );
    return next?.toISOString();
  }
  if (schedule.type === "interval") {
    const lastRun = trigger.lastRunAt
      ? new Date(trigger.lastRunAt)
      : new Date();
    return getNextIntervalRunDate(schedule.intervalMs, lastRun).toISOString();
  }
  return undefined;
}

export class ScheduleStore {
  private triggers = new Map<string, AgentScheduleTrigger>();
  private executions = new Map<string, ScheduleTriggerExecution>();

  // ─── Trigger CRUD ─────────────────────────────────────────────────────────

  createTrigger(input: CreateScheduleTriggerInput): AgentScheduleTrigger {
    const now = new Date().toISOString();
    const trigger: AgentScheduleTrigger = {
      id: randomUUID(),
      name: input.name,
      agentId: input.agentId,
      schedule: input.schedule,
      status: input.status ?? "active",
      payload: input.payload,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };
    trigger.nextRunAt = computeNextRunAt(trigger);
    this.triggers.set(trigger.id, trigger);
    return trigger;
  }

  getTrigger(id: string): AgentScheduleTrigger | undefined {
    return this.triggers.get(id);
  }

  listTriggers(agentId?: string): AgentScheduleTrigger[] {
    const all = Array.from(this.triggers.values());
    if (agentId) return all.filter((t) => t.agentId === agentId);
    return all;
  }

  updateTrigger(
    id: string,
    input: UpdateScheduleTriggerInput
  ): AgentScheduleTrigger | undefined {
    const existing = this.triggers.get(id);
    if (!existing) return undefined;

    const updated: AgentScheduleTrigger = {
      ...existing,
      ...(input.name !== undefined && { name: input.name }),
      ...(input.schedule !== undefined && { schedule: input.schedule }),
      ...(input.payload !== undefined && { payload: input.payload }),
      ...(input.status !== undefined && { status: input.status }),
      updatedAt: new Date().toISOString(),
    };
    updated.nextRunAt = computeNextRunAt(updated);
    this.triggers.set(id, updated);
    return updated;
  }

  deleteTrigger(id: string): boolean {
    return this.triggers.delete(id);
  }

  // ─── Execution helpers ────────────────────────────────────────────────────

  /** Record the start of an execution; returns a new execution object. */
  startExecution(triggerId: string, agentId: string): ScheduleTriggerExecution {
    const exec: ScheduleTriggerExecution = {
      id: randomUUID(),
      triggerId,
      agentId,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.executions.set(exec.id, exec);
    return exec;
  }

  /** Mark an execution as succeeded and record the result. */
  completeExecution(
    executionId: string,
    result?: unknown
  ): ScheduleTriggerExecution | undefined {
    const exec = this.executions.get(executionId);
    if (!exec) return undefined;

    const completed: ScheduleTriggerExecution = {
      ...exec,
      finishedAt: new Date().toISOString(),
      status: "success",
      result,
    };
    this.executions.set(executionId, completed);

    // Update the parent trigger's lastRunAt, runCount, and nextRunAt
    const trigger = this.triggers.get(exec.triggerId);
    if (trigger) {
      const updatedTrigger: AgentScheduleTrigger = {
        ...trigger,
        lastRunAt: completed.finishedAt,
        runCount: trigger.runCount + 1,
        updatedAt: completed.finishedAt!,
      };
      updatedTrigger.nextRunAt = computeNextRunAt(updatedTrigger);
      this.triggers.set(trigger.id, updatedTrigger);
    }

    return completed;
  }

  /** Mark an execution as failed and record the error. */
  failExecution(
    executionId: string,
    error: string
  ): ScheduleTriggerExecution | undefined {
    const exec = this.executions.get(executionId);
    if (!exec) return undefined;

    const failed: ScheduleTriggerExecution = {
      ...exec,
      finishedAt: new Date().toISOString(),
      status: "failed",
      error,
    };
    this.executions.set(executionId, failed);

    // Still bump the trigger's runCount so we have an accurate audit trail
    const trigger = this.triggers.get(exec.triggerId);
    if (trigger) {
      const updatedTrigger: AgentScheduleTrigger = {
        ...trigger,
        lastRunAt: failed.finishedAt,
        runCount: trigger.runCount + 1,
        updatedAt: failed.finishedAt!,
      };
      updatedTrigger.nextRunAt = computeNextRunAt(updatedTrigger);
      this.triggers.set(trigger.id, updatedTrigger);
    }

    return failed;
  }

  /** List executions, optionally filtered by triggerId. */
  listExecutions(triggerId?: string): ScheduleTriggerExecution[] {
    const all = Array.from(this.executions.values());
    if (triggerId) return all.filter((e) => e.triggerId === triggerId);
    return all;
  }

  getExecution(id: string): ScheduleTriggerExecution | undefined {
    return this.executions.get(id);
  }
}

// Singleton export — replace with DI container binding if needed
export const scheduleStore = new ScheduleStore();
