/**
 * AgentScheduler
 *
 * Polls the database for due schedules and fires the associated agents.
 * Designed to run as a singleton in the Electron main process.
 */

import { EventEmitter } from "events";
import type { AgentSchedule, AgentScheduleRun } from "./types";
import type { AgentScheduleStore } from "./store";

export interface SchedulerEvents {
  /** Emitted just before an agent is triggered by a schedule */
  scheduleTriggered: (schedule: AgentSchedule, run: AgentScheduleRun) => void;
  /** Emitted when the agent run completes successfully */
  runCompleted: (run: AgentScheduleRun) => void;
  /** Emitted when the agent run fails */
  runFailed: (run: AgentScheduleRun, error: Error) => void;
  /** Emitted on each tick (useful for testing / logging) */
  tick: (timestamp: Date) => void;
}

export type AgentRunner = (
  agentId: string,
  input?: Record<string, unknown>
) => Promise<void>;

export interface AgentSchedulerOptions {
  /** How often to poll for due schedules, in milliseconds. Default: 60_000 (1 min). */
  pollIntervalMs?: number;
  /** Callback that actually runs the agent. Must be provided by the host. */
  runAgent: AgentRunner;
}

/**
 * Type-safe event emitter wrapper.
 */
class TypedEmitter extends EventEmitter {
  emit<K extends keyof SchedulerEvents>(
    event: K,
    ...args: Parameters<SchedulerEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof SchedulerEvents>(
    event: K,
    listener: SchedulerEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof SchedulerEvents>(
    event: K,
    listener: SchedulerEvents[K]
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export class AgentScheduler {
  readonly events = new TypedEmitter();

  private store: AgentScheduleStore;
  private runAgent: AgentRunner;
  private pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Track in-flight runs to avoid double-triggering */
  private inFlight = new Set<string>();

  constructor(store: AgentScheduleStore, options: AgentSchedulerOptions) {
    this.store = store;
    this.runAgent = options.runAgent;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;

    // Fire immediately on start, then on each interval
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const now = new Date();
    this.events.emit("tick", now);

    const due = this.store.getDueSchedules(now);
    await Promise.allSettled(due.map((s) => this.executeSchedule(s)));
  }

  private async executeSchedule(schedule: AgentSchedule): Promise<void> {
    // Avoid concurrent executions of the same schedule
    if (this.inFlight.has(schedule.id)) return;
    this.inFlight.add(schedule.id);

    let run: AgentScheduleRun;
    try {
      run = this.store.recordRunStart(schedule.id);
      this.events.emit("scheduleTriggered", schedule, run);
    } catch (err) {
      this.inFlight.delete(schedule.id);
      console.error(`[AgentScheduler] Failed to record run start for schedule ${schedule.id}:`, err);
      return;
    }

    try {
      await this.runAgent(schedule.agentId, schedule.input);
      const completed = this.store.recordRunEnd(run.id, { status: "success" });
      if (completed) {
        this.events.emit("runCompleted", completed);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const failed = this.store.recordRunEnd(run.id, {
        status: "failed",
        error: error.message,
      });
      if (failed) {
        this.events.emit("runFailed", failed, error);
      }
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }
}
