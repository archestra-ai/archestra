/**
 * AgentScheduler — polls the database for due triggers and fires them.
 *
 * Designed to be a singleton that runs in the main Electron process.
 * Calls into the existing agent run infrastructure to actually execute agents.
 */

import Database from "better-sqlite3";
import {
  getDueScheduleTriggers,
  markTriggerFired,
  createRunLog,
  updateRunLog,
  migrateScheduleTriggerTables,
} from "./db";
import { AgentScheduleTrigger } from "./types";

export type AgentRunFn = (params: {
  agentId: string;
  prompt: string;
  conversationId?: string;
}) => Promise<{ runId: string }>;

export interface AgentSchedulerOptions {
  /** How often to check for due triggers (ms). Default: 30_000 (30 s) */
  pollIntervalMs?: number;
  /** Called when a trigger fires — implementations should start an agent run */
  onTriggerFire: AgentRunFn;
  /** Optional callback for observability */
  onTriggerError?: (trigger: AgentScheduleTrigger, err: Error) => void;
}

export class AgentScheduler {
  private db: Database.Database;
  private options: Required<AgentSchedulerOptions>;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Tracks in-flight trigger IDs to avoid double-firing */
  private inflight = new Set<string>();

  constructor(db: Database.Database, options: AgentSchedulerOptions) {
    this.db = db;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 30_000,
      onTriggerFire: options.onTriggerFire,
      onTriggerError: options.onTriggerError ?? (() => {}),
    };
    migrateScheduleTriggerTables(db);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Fire immediately, then on interval
    void this.tick();
    this.timerId = setInterval(() => void this.tick(), this.options.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Exposed for testing / manual invocation */
  async tick(): Promise<void> {
    let dueTriggers: AgentScheduleTrigger[];
    try {
      dueTriggers = getDueScheduleTriggers(this.db);
    } catch (err) {
      console.error("[AgentScheduler] Failed to fetch due triggers:", err);
      return;
    }

    await Promise.allSettled(
      dueTriggers.map((trigger) => this.fireTrigger(trigger))
    );
  }

  private async fireTrigger(trigger: AgentScheduleTrigger): Promise<void> {
    if (this.inflight.has(trigger.id)) return;
    this.inflight.add(trigger.id);

    const runLog = createRunLog(this.db, trigger.id, trigger.agentId);

    try {
      const { runId } = await this.options.onTriggerFire({
        agentId: trigger.agentId,
        prompt: trigger.prompt,
        conversationId: trigger.conversationId,
      });

      updateRunLog(this.db, runLog.id, { result: "success", runId });
      markTriggerFired(this.db, trigger.id);
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(String(err));
      console.error(
        `[AgentScheduler] Trigger ${trigger.id} ("${trigger.name}") failed:`,
        error
      );
      updateRunLog(this.db, runLog.id, {
        result: "error",
        errorMessage: error.message,
      });
      this.options.onTriggerError(trigger, error);
      // Still advance the schedule so it retries next cycle
      markTriggerFired(this.db, trigger.id);
    } finally {
      this.inflight.delete(trigger.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton helper (for use in the main process)
// ---------------------------------------------------------------------------

let schedulerInstance: AgentScheduler | null = null;

export function getScheduler(): AgentScheduler | null {
  return schedulerInstance;
}

export function initScheduler(
  db: Database.Database,
  options: AgentSchedulerOptions
): AgentScheduler {
  if (schedulerInstance) {
    schedulerInstance.stop();
  }
  schedulerInstance = new AgentScheduler(db, options);
  schedulerInstance.start();
  return schedulerInstance;
}

export function destroyScheduler(): void {
  schedulerInstance?.stop();
  schedulerInstance = null;
}
