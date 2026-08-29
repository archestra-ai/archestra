import { A2AManager } from "@/agents/a2a/a2a-manager";
import { watchTaskCompletion } from "@/agents/task-completion-watcher";
import config from "@/config";
import logger from "@/logging";
import {
  A2ATaskModel,
  AgentExecutionInputModel,
  AgentModel,
  AgentRunModel,
} from "@/models";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import { isAnyRunnerBackendEnabled, resolveRunnerBackend } from "./backends";
import { cleanupBackgroundTask } from "./pod-execution";

/**
 * Re-adopts executions whose launching control-plane process disappeared.
 * Agent runs and A2A tasks are durable; this is the bridge that reconnects
 * them after a rolling deploy or local hot reload.
 */
class AgentExecutionReconciler {
  private readonly a2aManager = new A2AManager({ taskMode: "full" });
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private isReconciling = false;

  start(): void {
    if (this.timer || !isAnyRunnerBackendEnabled()) return;
    this.runReconcile();
    this.timer = setInterval(
      () => this.runReconcile(),
      config.agentBackgroundExecution.reconcileIntervalSeconds * 1_000,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async reconcile(): Promise<void> {
    if (this.isReconciling) return;
    this.isReconciling = true;
    try {
      const sessions = await AgentRunModel.listOpen();
      for (const session of sessions) {
        if (this.inFlight.has(session.id)) continue;
        void this.reconcileSession(session);
      }
      const pendingNotifications =
        await AgentRunModel.listPendingCompletionNotifications();
      for (const session of pendingNotifications) {
        if (this.inFlight.has(session.id)) continue;
        void this.notifySettledSession(session);
      }
    } finally {
      this.isReconciling = false;
    }
  }

  // =========================================================================
  // Internal
  // =========================================================================

  private runReconcile(): void {
    void this.reconcile().catch((error) => {
      logger.warn(
        { error },
        "Agent background execution reconciliation failed",
      );
    });
  }

  private async reconcileSession(
    session: Awaited<ReturnType<typeof AgentRunModel.listOpen>>[number],
  ): Promise<void> {
    this.inFlight.add(session.id);
    try {
      const task = await A2ATaskModel.findById(session.taskId);
      if (!task || isTerminalA2ATaskState(task.state)) {
        await this.finalizeTerminalSession(session);
        return;
      }

      // A healthy owner heartbeats every 30 seconds. Give it several missed
      // beats before adopting so a slow query or event-loop pause cannot make
      // two processes stream the same execution concurrently.
      const heartbeatAt = task.lastHeartbeatAt?.getTime() ?? 0;
      if (Date.now() - heartbeatAt < ADOPTION_DELAY_MS) return;

      const backend = resolveRunnerBackend(session.backend);
      await backend.withSessionLease(session, async () => {
        const refreshed = await A2ATaskModel.findById(session.taskId);
        if (!refreshed || isTerminalA2ATaskState(refreshed.state)) {
          await this.finalizeTerminalSession(session);
          return;
        }
        const refreshedHeartbeatAt = refreshed.lastHeartbeatAt?.getTime() ?? 0;
        if (Date.now() - refreshedHeartbeatAt < ADOPTION_DELAY_MS) return;

        logger.info(
          { sessionId: session.id, taskId: session.taskId },
          "Re-adopting Agent background execution after owner restart",
        );
        try {
          await backend.stageInputs({
            session,
            inputs: await AgentExecutionInputModel.findByTaskId(session.taskId),
          });
          await this.a2aManager.adoptBackgroundTask({
            taskId: session.taskId,
            session,
          });
        } catch (error) {
          // The A2A lifecycle persists its own terminal failure. Keep this
          // loop alive so notification and cleanup still run below.
          logger.warn(
            { error, sessionId: session.id, taskId: session.taskId },
            "Re-adopted Agent background execution ended with an error",
          );
        }
        await this.notifyCompletionTarget(session);
      });
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id, taskId: session.taskId },
        "Agent background execution reconciliation failed",
      );
    } finally {
      this.inFlight.delete(session.id);
    }
  }

  private async finalizeTerminalSession(
    session: Awaited<ReturnType<typeof AgentRunModel.listOpen>>[number],
  ): Promise<void> {
    const backend = resolveRunnerBackend(session.backend);
    await backend.withSessionLease(session, async () => {
      await cleanupBackgroundTask(session);
      await this.notifyCompletionTarget(session);
    });
  }

  private async notifyCompletionTarget(
    session: Awaited<ReturnType<typeof AgentRunModel.listOpen>>[number],
  ): Promise<void> {
    if (!session.completionTarget) return;
    const agent = await AgentModel.findById(session.agentId);
    await watchTaskCompletion({
      taskId: session.taskId,
      target: session.completionTarget,
      agentName: agent?.name ?? "Agent",
    });
  }

  private async notifySettledSession(
    session: Awaited<ReturnType<typeof AgentRunModel.listOpen>>[number],
  ): Promise<void> {
    this.inFlight.add(session.id);
    try {
      await this.notifyCompletionTarget(session);
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id, taskId: session.taskId },
        "Agent execution completion notification reconciliation failed",
      );
    } finally {
      this.inFlight.delete(session.id);
    }
  }
}

export const agentExecutionReconciler = new AgentExecutionReconciler();

const ADOPTION_DELAY_MS = 2 * 60 * 1_000;
