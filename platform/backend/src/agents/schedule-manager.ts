import { Cron } from "croner";
import { executeA2AMessage } from "@/agents/a2a-executor";
import logger from "@/logging";
import { AgentScheduleTriggerModel } from "@/models";
import type { SelectAgentScheduleTrigger } from "@/types";

export class ScheduleManager {
  private static instance: ScheduleManager;
  private jobs = new Map<string, Cron>();
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): ScheduleManager {
    if (!ScheduleManager.instance) {
      ScheduleManager.instance = new ScheduleManager();
    }
    return ScheduleManager.instance;
  }

  /**
   * Initialize the scheduler on server startup.
   * Loads all enabled triggers from the database and schedules them.
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      const triggers = await AgentScheduleTriggerModel.findAllEnabled();
      for (const trigger of triggers) {
        this.scheduleTrigger(trigger);
      }
      this.isInitialized = true;
      logger.info(
        { triggerCount: triggers.length },
        "ScheduleManager initialized successfully",
      );
    } catch (error) {
      logger.error({ error }, "Failed to initialize ScheduleManager");
    }
  }

  /**
   * Schedule a trigger using croner.
   */
  public scheduleTrigger(trigger: SelectAgentScheduleTrigger): void {
    // If already scheduled, remove it first to avoid duplicates
    if (this.jobs.has(trigger.id)) {
      this.unscheduleTrigger(trigger.id);
    }

    if (!trigger.enabled) {
      return;
    }

    try {
      let cronArg: string | Date;

      if (trigger.triggerType === "cron" && trigger.cronExpression) {
        cronArg = trigger.cronExpression;
      } else if (
        trigger.triggerType === "interval" &&
        trigger.intervalSeconds
      ) {
        cronArg = `*/${trigger.intervalSeconds} * * * * *`; // Croner handles second precision
      } else if (trigger.triggerType === "once" && trigger.executeAt) {
        cronArg = trigger.executeAt;
      } else {
        logger.warn(
          { triggerId: trigger.id, triggerType: trigger.triggerType },
          "Invalid trigger configuration, skipping",
        );
        return;
      }

      // Schedule job using croner
      const job = new Cron(
        cronArg,
        {
          timezone: trigger.timezone,
          protect: true, // Only allow one execution to run at a time per trigger
          context: trigger,
        },
        async (self: Cron, ctx: unknown) => {
          await this.executeJob(ctx as SelectAgentScheduleTrigger, self);
        },
      );

      this.jobs.set(trigger.id, job);

      logger.debug(
        { triggerId: trigger.id, type: trigger.triggerType },
        "Scheduled agent trigger",
      );
    } catch (error) {
      logger.error(
        { triggerId: trigger.id, error },
        "Failed to schedule agent trigger",
      );
    }
  }

  /**
   * Stop and remove a scheduled trigger.
   */
  public unscheduleTrigger(triggerId: string): void {
    const job = this.jobs.get(triggerId);
    if (job) {
      job.stop();
      this.jobs.delete(triggerId);
      logger.debug({ triggerId }, "Unscheduled agent trigger");
    }
  }

  /**
   * Process an execution tick.
   */
  private async executeJob(
    trigger: SelectAgentScheduleTrigger,
    job: Cron,
  ): Promise<void> {
    const now = new Date();
    const scheduledTime = job.currentRun() || now;
    
    // For 'once' triggers, job.currentRun() might be null immediately after firing,
    // so we handle it gracefully. The exact schedule time for a 'once' trigger is trigger.executeAt.
    const expectedTime = trigger.triggerType === "once" && trigger.executeAt
      ? trigger.executeAt
      : scheduledTime;

    // Check misfire grace period
    const delaySeconds = (now.getTime() - expectedTime.getTime()) / 1000;
    if (delaySeconds > trigger.misfireGraceSeconds) {
      logger.warn(
        {
          triggerId: trigger.id,
          expectedTime,
          actualTime: now,
          delaySeconds,
          graceSeconds: trigger.misfireGraceSeconds,
        },
        "Skipping trigger execution due to misfire grace period exceeded",
      );
      
      // Still calculate the next execute time
      let nextRun = job.nextRun();
      if (trigger.triggerType === "once") {
         nextRun = null;
         // Disable one-time trigger
         await AgentScheduleTriggerModel.update(trigger.id, { enabled: false });
         this.unscheduleTrigger(trigger.id);
      }

      await AgentScheduleTriggerModel.recordExecution(trigger.id, {
        status: "error",
        error: `Misfire: execution delayed by ${delaySeconds} seconds (grace: ${trigger.misfireGraceSeconds})`,
        nextExecuteAt: nextRun,
      });
      return;
    }

    logger.info(
      { triggerId: trigger.id, agentId: trigger.agentId },
      "Executing scheduled agent trigger",
    );

    try {
      // Execute the A2A message
      await executeA2AMessage({
        agentId: trigger.agentId,
        message: trigger.inputMessage,
        organizationId: trigger.organizationId,
        userId: trigger.createdBy,
        source: "agent_schedule" as any, // casting to any here as 'agent_schedule' isn't explicitly in the shared type until added
      });

      // Handle 'once' triggers: disable after successful run
      let nextRun = job.nextRun();
      if (trigger.triggerType === "once") {
        nextRun = null;
        await AgentScheduleTriggerModel.update(trigger.id, { enabled: false });
        this.unscheduleTrigger(trigger.id);
      }

      // Record success
      await AgentScheduleTriggerModel.recordExecution(trigger.id, {
        status: "success",
        nextExecuteAt: nextRun,
      });
    } catch (error) {
      logger.error(
        { triggerId: trigger.id, error },
        "Error executing scheduled agent trigger",
      );

      // Handle 'once' triggers: disable even on failure to prevent infinite loops
      let nextRun = job.nextRun();
      if (trigger.triggerType === "once") {
        nextRun = null;
        await AgentScheduleTriggerModel.update(trigger.id, { enabled: false });
        this.unscheduleTrigger(trigger.id);
      }

      // Record failure
      await AgentScheduleTriggerModel.recordExecution(trigger.id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        nextExecuteAt: nextRun,
      });
    }
  }

  /**
   * Gracefully stop all scheduled jobs.
   */
  public shutdown(): void {
    for (const [id, job] of this.jobs.entries()) {
      job.stop();
      this.jobs.delete(id);
    }
    this.isInitialized = false;
    logger.info("ScheduleManager shutdown complete");
  }
}

export const scheduleManager = ScheduleManager.getInstance();
