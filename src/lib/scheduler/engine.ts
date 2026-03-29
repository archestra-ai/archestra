/**
 * Schedule Trigger Engine
 *
 * Runs in-process and polls the store for triggers that are due.
 * On each tick it finds all active triggers whose `nextRunAt` is in the past,
 * invokes the corresponding agent, and updates the trigger's run metadata.
 *
 * Usage:
 *   const engine = ScheduleEngine.getInstance();
 *   await engine.start();
 *   // …
 *   await engine.stop();
 */

import { listScheduleTriggers, recordTriggerRun } from "./store";
import { ScheduleTrigger } from "./types";

export type AgentInvoker = (
  agentId: string,
  payload: Record<string, unknown>
) => Promise<void>;

const DEFAULT_POLL_INTERVAL_MS = 15_000; // 15 seconds

export class ScheduleEngine {
  private static _instance: ScheduleEngine | null = null;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _invoker: AgentInvoker | null = null;
  private _pollIntervalMs: number;

  private constructor(pollIntervalMs = DEFAULT_POLL_INTERVAL_MS) {
    this._pollIntervalMs = pollIntervalMs;
  }

  static getInstance(): ScheduleEngine {
    if (!ScheduleEngine._instance) {
      ScheduleEngine._instance = new ScheduleEngine();
    }
    return ScheduleEngine._instance;
  }

  /** Register the callback that will be used to invoke agents. */
  setInvoker(invoker: AgentInvoker): void {
    this._invoker = invoker;
  }

  /** Override the polling interval (useful for tests). */
  setPollInterval(ms: number): void {
    this._pollIntervalMs = ms;
  }

  isRunning(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;

    // Run an immediate tick so the engine responds without waiting for the
    // first full interval to elapse.
    await this._tick();

    this._timer = setInterval(async () => {
      await this._tick();
    }, this._pollIntervalMs);

    // Allow Node.js to exit even when the timer is still running.
    if (this._timer.unref) {
      this._timer.unref();
    }

    console.log(
      `[ScheduleEngine] Started (poll interval: ${this._pollIntervalMs}ms)`
    );
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    console.log("[ScheduleEngine] Stopped");
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async _tick(): Promise<void> {
    if (!this._invoker) {
      console.warn(
        "[ScheduleEngine] No invoker registered; skipping tick. Call setInvoker() before start()."
      );
      return;
    }

    let due: ScheduleTrigger[];
    try {
      const all = await listScheduleTriggers();
      const now = Date.now();
      due = all.filter(
        (t) =>
          t.status === "active" &&
          t.nextRunAt != null &&
          new Date(t.nextRunAt).getTime() <= now
      );
    } catch (err) {
      console.error("[ScheduleEngine] Failed to load triggers:", err);
      return;
    }

    await Promise.all(due.map((trigger) => this._executeTrigger(trigger)));
  }

  private async _executeTrigger(trigger: ScheduleTrigger): Promise<void> {
    console.log(
      `[ScheduleEngine] Firing trigger "${trigger.name}" (id=${trigger.id}) for agent ${trigger.agentId}`
    );

    try {
      await this._invoker!(trigger.agentId, trigger.inputPayload ?? {});
      await recordTriggerRun(trigger.id, "success");
      console.log(
        `[ScheduleEngine] Trigger "${trigger.name}" completed successfully.`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[ScheduleEngine] Trigger "${trigger.name}" failed: ${message}`
      );
      try {
        await recordTriggerRun(trigger.id, "failure", message);
      } catch (storeErr) {
        console.error(
          "[ScheduleEngine] Failed to record trigger failure:",
          storeErr
        );
      }
    }
  }
}
