/**
 * Persistent store for schedule triggers.
 *
 * Uses a simple JSON file on disk so that triggers survive application
 * restarts without requiring an external database dependency.  The store
 * exposes a synchronous-looking API backed by an async file I/O layer so
 * callers can await individual operations.
 */

import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import {
  CreateScheduleTriggerInput,
  ScheduleTrigger,
  ScheduleTriggerStatus,
  UpdateScheduleTriggerInput,
} from "./types";
import { computeNextRunAt, validateSchedule } from "./utils";

const DATA_DIR =
  process.env.ARCHESTRA_DATA_DIR ??
  path.join(process.cwd(), ".archestra", "data");
const STORE_FILE = path.join(DATA_DIR, "schedule_triggers.json");

// ---------------------------------------------------------------------------
// Low-level persistence
// ---------------------------------------------------------------------------

async function readAll(): Promise<ScheduleTrigger[]> {
  try {
    const raw = await fs.readFile(STORE_FILE, "utf-8");
    return JSON.parse(raw) as ScheduleTrigger[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function writeAll(triggers: ScheduleTrigger[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(triggers, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public store API
// ---------------------------------------------------------------------------

export async function listScheduleTriggers(
  agentId?: string
): Promise<ScheduleTrigger[]> {
  const all = await readAll();
  return agentId ? all.filter((t) => t.agentId === agentId) : all;
}

export async function getScheduleTrigger(
  id: string
): Promise<ScheduleTrigger | undefined> {
  const all = await readAll();
  return all.find((t) => t.id === id);
}

export async function createScheduleTrigger(
  input: CreateScheduleTriggerInput
): Promise<ScheduleTrigger> {
  validateSchedule(input.schedule);

  const now = new Date().toISOString();
  const nextRun = computeNextRunAt(input.schedule, new Date());

  const trigger: ScheduleTrigger = {
    id: randomUUID(),
    agentId: input.agentId,
    name: input.name,
    description: input.description,
    schedule: input.schedule,
    status: "active",
    inputPayload: input.inputPayload ?? {},
    nextRunAt: nextRun?.toISOString(),
    createdAt: now,
    updatedAt: now,
  };

  const all = await readAll();
  all.push(trigger);
  await writeAll(all);
  return trigger;
}

export async function updateScheduleTrigger(
  id: string,
  input: UpdateScheduleTriggerInput
): Promise<ScheduleTrigger> {
  const all = await readAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) {
    throw new Error(`Schedule trigger "${id}" not found.`);
  }

  const existing = all[idx];

  if (input.schedule) {
    validateSchedule(input.schedule);
  }

  const updated: ScheduleTrigger = {
    ...existing,
    name: input.name ?? existing.name,
    description:
      input.description !== undefined
        ? input.description
        : existing.description,
    schedule: input.schedule ?? existing.schedule,
    status: input.status ?? existing.status,
    inputPayload: input.inputPayload ?? existing.inputPayload,
    updatedAt: new Date().toISOString(),
  };

  if (input.schedule || input.status === "active") {
    const nextRun = computeNextRunAt(
      updated.schedule,
      new Date(updated.lastRunAt ?? new Date())
    );
    updated.nextRunAt = nextRun?.toISOString();
  }

  all[idx] = updated;
  await writeAll(all);
  return updated;
}

export async function deleteScheduleTrigger(id: string): Promise<void> {
  const all = await readAll();
  const filtered = all.filter((t) => t.id !== id);
  if (filtered.length === all.length) {
    throw new Error(`Schedule trigger "${id}" not found.`);
  }
  await writeAll(filtered);
}

export async function recordTriggerRun(
  id: string,
  status: "success" | "failure",
  error?: string
): Promise<ScheduleTrigger> {
  const all = await readAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) {
    throw new Error(`Schedule trigger "${id}" not found.`);
  }

  const existing = all[idx];
  const now = new Date();

  let newStatus: ScheduleTriggerStatus = existing.status;
  let nextRunAt: string | undefined;

  if (existing.schedule.type === "once") {
    // One-shot triggers move to "completed" after they fire
    newStatus = "completed";
    nextRunAt = undefined;
  } else {
    const next = computeNextRunAt(existing.schedule, now);
    nextRunAt = next?.toISOString();
  }

  const updated: ScheduleTrigger = {
    ...existing,
    status: newStatus,
    lastRunAt: now.toISOString(),
    lastRunStatus: status,
    lastRunError: status === "failure" ? error : undefined,
    nextRunAt,
    updatedAt: now.toISOString(),
  };

  all[idx] = updated;
  await writeAll(all);
  return updated;
}
