import { A2AManager } from "@/agents/a2a/a2a-manager";
import { watchTaskCompletion } from "@/agents/task-completion-watcher";
import config from "@/config";
import logger from "@/logging";
import {
  A2ATaskModel,
  AgentModel,
  AgentRunModel,
  AgentWorkspaceModel,
} from "@/models";
import { isTerminalA2ATaskState } from "@/types/a2a-task";
import type { AgentWorkspace } from "@/types/agent-workspace";
import {
  isAnyAgentRuntimeBackendDriverEnabled,
  resolveAgentRuntimeBackendDriver,
} from "./backends";
import { cleanupAgentRun } from "./pod-run";

/**
 * Re-adopts runs whose launching control-plane process disappeared.
 * Agent runs and A2A tasks are durable; this is the bridge that reconnects
 * them after a rolling deploy or local hot reload.
 */
class AgentRunReconciler {
  private readonly a2aManager = new A2AManager({ taskMode: "full" });
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private isReconciling = false;

  start(): void {
    if (this.timer || !isAnyAgentRuntimeBackendDriverEnabled()) return;
    this.runReconcile();
    this.timer = setInterval(
      () => this.runReconcile(),
      config.agentRuntime.reconcileIntervalSeconds * 1_000,
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
      const workspaces = await AgentWorkspaceModel.listForReaping(
        config.agentRuntime.defaultIdleTimeoutMinutes,
      );
      for (const workspace of workspaces)
        await this.reconcileWorkspace(workspace);
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
      logger.warn({ error }, "Agent Runtime reconciliation failed");
    });
  }

  private async reconcileWorkspace(workspace: AgentWorkspace): Promise<void> {
    const backend = resolveAgentRuntimeBackendDriver(workspace.backend);
    const expired = workspace.expiresAt.getTime() <= Date.now();
    if (workspace.state === "idle" && !expired) {
      try {
        const run = await AgentRunModel.findByTaskId(workspace.lastTaskId);
        const activityAt = run
          ? await backend.getLastWorkspaceActivity(run)
          : null;
        if (activityAt && activityAt > workspace.lastActivityAt) {
          await AgentWorkspaceModel.recordActivity(workspace.id, activityAt);
          return;
        }
      } catch (error) {
        logger.warn(
          { error, workspaceId: workspace.id },
          "Could not verify workspace activity; idle suspension will retry",
        );
        return;
      }
    }
    if (workspace.state === "resuming" && !expired) {
      try {
        const run = await AgentRunModel.findByTaskId(workspace.lastTaskId);
        if (!run) throw new Error("Workspace run not found");
        await backend.resumeWorkspace(run);
        await AgentWorkspaceModel.finishResume(workspace.id);
      } catch (error) {
        logger.warn(
          { error, workspaceId: workspace.id },
          "Workspace resume will retry",
        );
      }
      return;
    }
    const target =
      expired || workspace.state === "deleting" ? "deleting" : "suspending";
    if (
      workspace.state !== target &&
      !(await AgentWorkspaceModel.transition({
        id: workspace.id,
        from: workspace.state,
        to: target,
        expectedLastActivityAt:
          target === "suspending" ? workspace.lastActivityAt : undefined,
      }))
    )
      return;
    try {
      if (target === "deleting") {
        const run = await AgentRunModel.findByTaskId(workspace.lastTaskId);
        if (run) {
          const task = await A2ATaskModel.findById(run.taskId);
          if (task && !isTerminalA2ATaskState(task.state)) {
            await this.a2aManager.cancelTask({
              actor: {
                kind: workspace.actorKind,
                id: workspace.actorId,
                organizationId: workspace.organizationId,
              },
              agentId: workspace.agentId,
              request: { id: run.taskId },
            });
          }
          // Capture the supervisor's final output while its volume still exists.
          // A failed capture/cleanup leaves the deleting intent for retry.
          if (!run.endedAt) {
            await cleanupAgentRun(run, { requireTranscript: true });
          } else {
            await backend.releaseRun(run);
          }
        }
        await backend.deleteWorkspace(workspace);
        await AgentWorkspaceModel.transition({
          id: workspace.id,
          from: "deleting",
          to: "deleted",
        });
      } else {
        await backend.suspendWorkspace(workspace);
        await AgentWorkspaceModel.transition({
          id: workspace.id,
          from: "suspending",
          to: "suspended",
        });
      }
    } catch (error) {
      logger.warn(
        { error, workspaceId: workspace.id },
        "Workspace reconciliation will retry",
      );
    }
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
      // two processes stream the same run concurrently.
      const heartbeatAt = task.lastHeartbeatAt?.getTime() ?? 0;
      if (Date.now() - heartbeatAt < ADOPTION_DELAY_MS) return;

      const backend = resolveAgentRuntimeBackendDriver(session.backend);
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
          "Re-adopting Agent Runtime run after owner restart",
        );
        try {
          await this.a2aManager.adoptAgentRun({
            taskId: session.taskId,
            session,
          });
        } catch (error) {
          // The A2A lifecycle persists its own terminal failure. Keep this
          // loop alive so notification and cleanup still run below.
          logger.warn(
            { error, sessionId: session.id, taskId: session.taskId },
            "Re-adopted Agent Runtime run ended with an error",
          );
        }
        await this.notifyCompletionTarget(session);
      });
    } catch (error) {
      logger.warn(
        { error, sessionId: session.id, taskId: session.taskId },
        "Agent Runtime reconciliation failed",
      );
    } finally {
      this.inFlight.delete(session.id);
    }
  }

  private async finalizeTerminalSession(
    session: Awaited<ReturnType<typeof AgentRunModel.listOpen>>[number],
  ): Promise<void> {
    const backend = resolveAgentRuntimeBackendDriver(session.backend);
    await backend.withSessionLease(session, async () => {
      await cleanupAgentRun(session);
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
        "Agent run completion notification reconciliation failed",
      );
    } finally {
      this.inFlight.delete(session.id);
    }
  }
}

export const agentRunReconciler = new AgentRunReconciler();

const ADOPTION_DELAY_MS = 2 * 60 * 1_000;
