/**
 * SchedulerService
 *
 * Manages active cron / interval jobs for all "active" AgentScheduleTriggers.
 * On startup it hydrates jobs from the store; any CRUD changes to triggers
 * must be reflected by calling the corresponding public methods so the
 * in-process job registry stays in sync.
 *
 * Agent invocation is delegated to an `AgentRunner` callback so this module
 * remains decoupled from the agent execution details.
 */

import Croner from "croner";
import {
  AgentScheduleTrigger,
  CreateScheduleTriggerInput,
  UpdateScheduleTriggerInput,
} from "./types";
import { ScheduleStore, scheduleStore } from "./schedule-store";
import { isValidCronExpression } from "./cron-utils";

/** Minimal interface for running an agent — inject your real implementation. */
export interface AgentRunner {
  run(
    agentId: string,
    payload?: Record<string, unknown>
  ): Promise<unknown>;
}

export class SchedulerService {
  private jobs = new Map<string, Croner | NodeJS.Timeout>();

  constructor(
    private readonly store: ScheduleStore,
    private readonly runner: AgentRunner
  ) {}

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  /** Start all active triggers from the store. Call once at application boot. */
  start(): void {
    const triggers = this.store.listTriggers();
    for (const trigger of triggers) {
      if (trigger.status === "active") {
        this.scheduleJob(trigger);
      }
    }
  }

  /** Stop all in-process jobs. Call during graceful shutdown. */
  stop(): void {
    for (const [id, job] of this.jobs.entries()) {
      this.clearJob(id, job);
    }
    this.jobs.clear();
  }

  // ─── Trigger Management ──────────────────────────────────────────────────

  /** Create a new trigger and, if active, immediately schedule its job. */
  createTrigger(input: CreateScheduleTriggerInput): AgentScheduleTrigger {
    this.validateSchedule(input);
    const trigger = this.store.createTrigger(input);
    if (trigger.status === "active") {
      this.scheduleJob(trigger);
    }
    return trigger;
  }

  /** Update an existing trigger, rescheduling its job as needed. */
  updateTrigger(
    id: string,
    input: UpdateScheduleTriggerInput
  ): AgentScheduleTrigger | undefined {
    if (input.schedule) {
      this.validateSchedule({ schedule: input.schedule } as CreateScheduleTriggerInput);
    }

    const updated = this.store.updateTrigger(id, input);
    if (!updated) return undefined;

    // Always cancel the old job first
    this.cancelJob(id);

    if (updated.status === "active") {
      this.scheduleJob(updated);
    }
    return updated;
  }

  /** Delete a trigger and cancel its job. */
  deleteTrigger(id: string): boolean {
    this.cancelJob(id);
    return this.store.deleteTrigger(id);
  }

  /** Pause a running trigger without deleting it. */
  pauseTrigger(id: string): AgentScheduleTrigger | undefined {
    return this.updateTrigger(id, { status: "paused" });
  }

  /** Resume a paused / disabled trigger. */
  resumeTrigger(id: string): AgentScheduleTrigger | undefined {
    return this.updateTrigger(id, { status: "active" });
  }

  /** Manually fire a trigger immediately, regardless of its schedule. */
  async runNow(id: string): Promise<void> {
    const trigger = this.store.getTrigger(id);
    if (!trigger) throw new Error(`Trigger not found: ${id}`);
    await this.executeTrigger(trigger);
  }

  // ─── Read-only helpers ────────────────────────────────────────────────────

  listTriggers(agentId?: string): AgentScheduleTrigger[] {
    return this.store.listTriggers(agentId);
  }

  getTrigger(id: string): AgentScheduleTrigger | undefined {
    return this.store.getTrigger(id);
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private scheduleJob(trigger: AgentScheduleTrigger): void {
    const { schedule } = trigger;

    if (schedule.type === "cron") {
      const job = new Croner(
        schedule.expression,
        {
          timezone: schedule.timezone ?? "UTC",
          protect: true,   // prevent overlapping runs
        },
        () => void this.executeTrigger(trigger)
      );
      this.jobs.set(trigger.id, job);
    } else if (schedule.type === "interval") {
      const timer = setInterval(
        () => void this.executeTrigger(trigger),
        schedule.intervalMs
      );
      this.jobs.set(trigger.id, timer);
    }
  }

  private cancelJob(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      this.clearJob(id, job);
      this.jobs.delete(id);
    }
  }

  private clearJob(id: string, job: Croner | NodeJS.Timeout): void {
    if (job instanceof Croner) {
      job.stop();
    } else {
      clearInterval(job as NodeJS.Timeout);
    }
  }

  private async executeTrigger(trigger: AgentScheduleTrigger): Promise<void> {
    // Re-fetch to ensure we respect live status changes (e.g. pause during run)
    const current = this.store.getTrigger(trigger.id);
    if (!current || current.status !== "active") return;

    const execution = this.store.startExecution(current.id, current.agentId);

    try {
      const result = await this.runner.run(current.agentId, current.payload);
      this.store.completeExecution(execution.id, result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      this.store.failExecution(execution.id, message);
    }
  }

  private validateSchedule(input: Pick<CreateScheduleTriggerInput, "schedule">): void {
    const { schedule } = input;
    if (schedule.type === "cron") {
      if (!isValidCronExpression(schedule.expression)) {
        throw new Error(
          `Invalid cron expression: "${schedule.expression}"`
        );
      }
    } else if (schedule.type === "interval") {
      if (schedule.intervalMs <= 0) {
        throw new Error(
          `intervalMs must be a positive number, got ${schedule.intervalMs}`
        );
      }
    }
  }
}

/**
 * Factory helper — pass your AgentRunner implementation to create the service.
 *
 * Example:
 *   const scheduler = createSchedulerService({ run: myAgentRunner });
 *   scheduler.start();
 */
export function createSchedulerService(runner: AgentRunner): SchedulerService {
  return new SchedulerService(scheduleStore, runner);
}
