import { Cron } from "croner";
import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import AgentScheduleTriggerModel from "@/models/agent-schedule-trigger";
import type { ScheduleTrigger } from "@/types/agent-schedule-trigger";
import {
  SCHEDULE_EXECUTION_TIMEOUT_MS,
  SCHEDULE_MAX_CONCURRENT_EXECUTIONS,
} from "./constants";

interface ActiveJob {
  cron: Cron;
  triggerId: string;
}

export class ScheduleManager {
  private activeJobs: Map<string, ActiveJob> = new Map();
  private intervalJobs: Map<string, ReturnType<typeof setInterval>> = new Map();
  private runningExecutions = 0;
  private isShuttingDown = false;

  async initialize(): Promise<void> {
    logger.info("[ScheduleManager] Initializing schedule triggers");

    try {
      const triggers = await AgentScheduleTriggerModel.findAllEnabled();
      logger.info(
        { count: triggers.length },
        "[ScheduleManager] Loading enabled schedule triggers",
      );

      for (const trigger of triggers) {
        this.scheduleTrigger(trigger);
      }

      logger.info("[ScheduleManager] Initialization complete");
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "[ScheduleManager] Failed to initialize",
      );
    }
  }

  scheduleTrigger(trigger: ScheduleTrigger): void {
    this.removeTrigger(trigger.id);

    if (!trigger.enabled) return;

    try {
      switch (trigger.triggerType) {
        case "cron":
          this.scheduleCronTrigger(trigger);
          break;
        case "interval":
          this.scheduleIntervalTrigger(trigger);
          break;
        case "once":
          this.scheduleOnceTrigger(trigger);
          break;
      }
    } catch (error) {
      logger.error(
        {
          triggerId: trigger.id,
          triggerType: trigger.triggerType,
          error: error instanceof Error ? error.message : String(error),
        },
        "[ScheduleManager] Failed to schedule trigger",
      );
    }
  }

  removeTrigger(triggerId: string): void {
    const activeJob = this.activeJobs.get(triggerId);
    if (activeJob) {
      activeJob.cron.stop();
      this.activeJobs.delete(triggerId);
    }

    const intervalJob = this.intervalJobs.get(triggerId);
    if (intervalJob) {
      clearInterval(intervalJob);
      this.intervalJobs.delete(triggerId);
    }
  }

  async executeTrigger(trigger: ScheduleTrigger): Promise<void> {
    if (this.isShuttingDown) return;

    if (this.runningExecutions >= SCHEDULE_MAX_CONCURRENT_EXECUTIONS) {
      logger.warn(
        {
          triggerId: trigger.id,
          currentExecutions: this.runningExecutions,
          max: SCHEDULE_MAX_CONCURRENT_EXECUTIONS,
        },
        "[ScheduleManager] Max concurrent executions reached, skipping",
      );
      return;
    }

    this.runningExecutions++;

    const nextExecuteAt = this.computeNextExecuteAt(trigger);

    logger.info(
      {
        triggerId: trigger.id,
        agentId: trigger.agentId,
        triggerType: trigger.triggerType,
        name: trigger.name,
      },
      "[ScheduleManager] Executing schedule trigger",
    );

    try {
      const abortController = new AbortController();
      const timeout = setTimeout(
        () => abortController.abort(),
        SCHEDULE_EXECUTION_TIMEOUT_MS,
      );

      const result = await executeA2AMessage({
        agentId: trigger.agentId,
        message: trigger.inputMessage,
        organizationId: trigger.organizationId,
        userId: trigger.createdBy,
        source: "schedule",
        sessionId: `schedule-${trigger.id}-${Date.now()}`,
        abortSignal: abortController.signal,
      });

      clearTimeout(timeout);

      await AgentScheduleTriggerModel.updateExecution({
        id: trigger.id,
        lastExecutedAt: new Date(),
        nextExecuteAt,
        lastStatus: "success",
        lastError: null,
      });

      logger.info(
        {
          triggerId: trigger.id,
          agentId: trigger.agentId,
          finishReason: result.finishReason,
          usage: result.usage,
        },
        "[ScheduleManager] Schedule trigger execution completed",
      );

      if (trigger.triggerType === "once") {
        await AgentScheduleTriggerModel.disableOnceTriggersAfterExecution(
          trigger.id,
        );
        this.removeTrigger(trigger.id);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await AgentScheduleTriggerModel.updateExecution({
        id: trigger.id,
        lastExecutedAt: new Date(),
        nextExecuteAt,
        lastStatus: "error",
        lastError: errorMessage,
      });

      logger.error(
        {
          triggerId: trigger.id,
          agentId: trigger.agentId,
          error: errorMessage,
        },
        "[ScheduleManager] Schedule trigger execution failed",
      );
    } finally {
      this.runningExecutions--;
    }
  }

  async executeManually(triggerId: string): Promise<void> {
    const trigger = await AgentScheduleTriggerModel.findById(triggerId);
    if (!trigger) {
      throw new Error(`Trigger ${triggerId} not found`);
    }
    await this.executeTrigger(trigger);
  }

  shutdown(): void {
    logger.info("[ScheduleManager] Shutting down schedule triggers");
    this.isShuttingDown = true;

    for (const [, job] of this.activeJobs) {
      job.cron.stop();
    }
    this.activeJobs.clear();

    for (const [, interval] of this.intervalJobs) {
      clearInterval(interval);
    }
    this.intervalJobs.clear();

    logger.info("[ScheduleManager] All schedule triggers stopped");
  }

  getActiveJobCount(): number {
    return this.activeJobs.size + this.intervalJobs.size;
  }

  getRunningExecutionCount(): number {
    return this.runningExecutions;
  }

  private scheduleCronTrigger(trigger: ScheduleTrigger): void {
    if (!trigger.cronExpression) return;

    const cron = new Cron(
      trigger.cronExpression,
      { timezone: trigger.timezone, protect: true },
      async () => {
        const current = await AgentScheduleTriggerModel.findById(trigger.id);
        if (current?.enabled) {
          await this.executeTrigger(current);
        }
      },
    );

    this.activeJobs.set(trigger.id, { cron, triggerId: trigger.id });

    const nextRun = cron.nextRun();
    if (nextRun) {
      AgentScheduleTriggerModel.update({
        id: trigger.id,
        organizationId: trigger.organizationId,
        data: { nextExecuteAt: nextRun },
      }).catch((error) => {
        logger.warn(
          { triggerId: trigger.id, error },
          "[ScheduleManager] Failed to update nextExecuteAt",
        );
      });
    }

    logger.info(
      {
        triggerId: trigger.id,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        nextRun: nextRun?.toISOString(),
      },
      "[ScheduleManager] Cron trigger scheduled",
    );
  }

  private scheduleIntervalTrigger(trigger: ScheduleTrigger): void {
    if (!trigger.intervalSeconds) return;

    const intervalMs = trigger.intervalSeconds * 1000;

    const interval = setInterval(async () => {
      const current = await AgentScheduleTriggerModel.findById(trigger.id);
      if (current?.enabled) {
        await this.executeTrigger(current);
      }
    }, intervalMs);

    this.intervalJobs.set(trigger.id, interval);

    const nextExecuteAt = new Date(Date.now() + intervalMs);
    AgentScheduleTriggerModel.update({
      id: trigger.id,
      organizationId: trigger.organizationId,
      data: { nextExecuteAt },
    }).catch((error) => {
      logger.warn(
        { triggerId: trigger.id, error },
        "[ScheduleManager] Failed to update nextExecuteAt",
      );
    });

    logger.info(
      {
        triggerId: trigger.id,
        intervalSeconds: trigger.intervalSeconds,
        nextExecuteAt: nextExecuteAt.toISOString(),
      },
      "[ScheduleManager] Interval trigger scheduled",
    );
  }

  private scheduleOnceTrigger(trigger: ScheduleTrigger): void {
    if (!trigger.executeAt) return;

    const now = new Date();
    const executeAt = new Date(trigger.executeAt);
    const delayMs = executeAt.getTime() - now.getTime();

    if (delayMs <= 0) {
      const graceMs = (trigger.misfireGraceSeconds ?? 60) * 1000;
      if (Math.abs(delayMs) <= graceMs) {
        logger.info(
          { triggerId: trigger.id, delayMs },
          "[ScheduleManager] Executing misfired once trigger within grace period",
        );
        this.executeTrigger(trigger);
      } else {
        logger.warn(
          { triggerId: trigger.id, delayMs, graceMs },
          "[ScheduleManager] Once trigger missed beyond grace period, disabling",
        );
        AgentScheduleTriggerModel.disableOnceTriggersAfterExecution(
          trigger.id,
        ).catch((error) => {
          logger.warn(
            { triggerId: trigger.id, error },
            "[ScheduleManager] Failed to disable misfired trigger",
          );
        });
      }
      return;
    }

    const cronDate = executeAt.toISOString();
    const cron = new Cron(
      executeAt,
      { timezone: trigger.timezone },
      async () => {
        const current = await AgentScheduleTriggerModel.findById(trigger.id);
        if (current?.enabled) {
          await this.executeTrigger(current);
        }
      },
    );

    this.activeJobs.set(trigger.id, { cron, triggerId: trigger.id });

    AgentScheduleTriggerModel.update({
      id: trigger.id,
      organizationId: trigger.organizationId,
      data: { nextExecuteAt: executeAt },
    }).catch((error) => {
      logger.warn(
        { triggerId: trigger.id, error },
        "[ScheduleManager] Failed to update nextExecuteAt for once trigger",
      );
    });

    logger.info(
      {
        triggerId: trigger.id,
        executeAt: executeAt.toISOString(),
        delayMs,
      },
      "[ScheduleManager] Once trigger scheduled",
    );
  }

  private computeNextExecuteAt(
    trigger: ScheduleTrigger,
  ): Date | null {
    switch (trigger.triggerType) {
      case "cron": {
        const job = this.activeJobs.get(trigger.id);
        return job?.cron.nextRun() ?? null;
      }
      case "interval": {
        return trigger.intervalSeconds
          ? new Date(Date.now() + trigger.intervalSeconds * 1000)
          : null;
      }
      case "once":
        return null;
      default:
        return null;
    }
  }
}

export const scheduleManager = new ScheduleManager();
