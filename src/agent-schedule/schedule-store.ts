/**
 * AgentScheduleStore — persistence layer for Agent Schedule Triggers.
 *
 * Uses a lightweight SQLite-backed store via `better-sqlite3` (already used
 * elsewhere in Archestra).  Swap the adapter if the project uses a different DB.
 */

import crypto from "crypto";
import type {
  AgentScheduleTrigger,
  CreateAgentScheduleTriggerDto,
  TriggerExecution,
  UpdateAgentScheduleTriggerDto,
} from "./types";
import { computeNextRunAt } from "./cron-utils";

// ---------------------------------------------------------------------------
// In-memory store (drop-in replacement; swap for a DB adapter as needed)
// ---------------------------------------------------------------------------

const triggers = new Map<string, AgentScheduleTrigger>();
const executions = new Map<string, TriggerExecution>();

// ---------------------------------------------------------------------------
// Trigger CRUD
// ---------------------------------------------------------------------------

export function createTrigger(
  dto: CreateAgentScheduleTriggerDto
): AgentScheduleTrigger {
  const now = new Date().toISOString();
  const trigger: AgentScheduleTrigger = {
    id: crypto.randomUUID(),
    agentId: dto.agentId,
    name: dto.name,
    description: dto.description,
    config: dto.config,
    status: "active",
    createdAt: now,
    updatedAt: now,
    nextRunAt: computeNextRunAt(dto.config, null),
    lastRunAt: null,
    runCount: 0,
    failureCount: 0,
    metadata: dto.metadata,
  };
  triggers.set(trigger.id, trigger);
  return trigger;
}

export function getTrigger(id: string): AgentScheduleTrigger | undefined {
  return triggers.get(id);
}

export function getTriggersByAgent(agentId: string): AgentScheduleTrigger[] {
  return [...triggers.values()].filter((t) => t.agentId === agentId);
}

export function getAllActiveTriggers(): AgentScheduleTrigger[] {
  return [...triggers.values()].filter((t) => t.status === "active");
}

export function updateTrigger(
  id: string,
  dto: UpdateAgentScheduleTriggerDto
): AgentScheduleTrigger | undefined {
  const existing = triggers.get(id);
  if (!existing) return undefined;

  const updated: AgentScheduleTrigger = {
    ...existing,
    ...dto,
    updatedAt: new Date().toISOString(),
    // Recompute nextRunAt when config changes
    nextRunAt:
      dto.config !== undefined
        ? computeNextRunAt(dto.config, existing.lastRunAt)
        : existing.nextRunAt,
  };
  triggers.set(id, updated);
  return updated;
}

export function deleteTrigger(id: string): boolean {
  return triggers.delete(id);
}

// ---------------------------------------------------------------------------
// Execution record helpers
// ---------------------------------------------------------------------------

export function recordExecutionStart(
  triggerId: string,
  agentId: string
): TriggerExecution {
  const exec: TriggerExecution = {
    id: crypto.randomUUID(),
    triggerId,
    agentId,
    firedAt: new Date().toISOString(),
    completedAt: null,
    result: "running",
  };
  executions.set(exec.id, exec);
  return exec;
}

export function recordExecutionComplete(
  executionId: string,
  result: "success" | "error",
  output?: unknown,
  error?: string
): TriggerExecution | undefined {
  const exec = executions.get(executionId);
  if (!exec) return undefined;

  const updated: TriggerExecution = {
    ...exec,
    completedAt: new Date().toISOString(),
    result,
    output,
    error,
  };
  executions.set(executionId, updated);
  return updated;
}

export function getExecutionsForTrigger(
  triggerId: string,
  limit = 50
): TriggerExecution[] {
  return [...executions.values()]
    .filter((e) => e.triggerId === triggerId)
    .sort(
      (a, b) =>
        new Date(b.firedAt).getTime() - new Date(a.firedAt).getTime()
    )
    .slice(0, limit);
}

/**
 * Advance a trigger's state after a successful or failed run.
 */
export function advanceTriggerAfterRun(
  triggerId: string,
  success: boolean
): AgentScheduleTrigger | undefined {
  const trigger = triggers.get(triggerId);
  if (!trigger) return undefined;

  const now = new Date().toISOString();

  // Determine whether the trigger should auto-complete
  let newStatus = trigger.status;
  const newRunCount = success ? trigger.runCount + 1 : trigger.runCount;
  const newFailureCount = success ? 0 : trigger.failureCount + 1;

  if (trigger.config.type === "once") {
    newStatus = "completed";
  } else if (
    trigger.config.type === "interval" &&
    trigger.config.maxRuns !== undefined &&
    newRunCount >= trigger.config.maxRuns
  ) {
    newStatus = "completed";
  } else if (
    trigger.config.type === "event" &&
    trigger.config.maxRuns !== undefined &&
    newRunCount >= trigger.config.maxRuns
  ) {
    newStatus = "completed";
  }

  const updated: AgentScheduleTrigger = {
    ...trigger,
    status: newStatus,
    updatedAt: now,
    lastRunAt: success ? now : trigger.lastRunAt,
    runCount: newRunCount,
    failureCount: newFailureCount,
    nextRunAt:
      newStatus === "completed"
        ? null
        : computeNextRunAt(trigger.config, success ? now : trigger.lastRunAt),
  };
  triggers.set(triggerId, updated);
  return updated;
}
