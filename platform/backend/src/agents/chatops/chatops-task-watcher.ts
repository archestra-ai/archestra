import { a2aTaskEventNotifier } from "@/agents/a2a/a2a-task-event-notifier";
import { buildChatOpsTaskNotification } from "@/archestra-mcp-server/chatops-task-notification";
import logger from "@/logging";
import { A2AArtifactModel, A2ATaskModel, AgentRunModel } from "@/models";

export async function watchChatOpsTask(params: {
  taskId: string;
  bindingId: string;
  threadId: string;
  agentName: string;
}): Promise<void> {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      const task = await A2ATaskModel.findById(params.taskId);
      if (!task) return;

      const artifacts = await A2AArtifactModel.findByTaskId(params.taskId);
      const text = artifacts
        .flatMap((artifact) =>
          Array.isArray(artifact.parts) ? artifact.parts : [],
        )
        .map((part) =>
          typeof (part as { text?: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .join("")
        .trim();
      const notification = buildChatOpsTaskNotification({
        taskId: params.taskId,
        state: task.state,
        statusReason: task.statusReason,
        output: text,
      });
      if (notification) {
        const execution = await AgentRunModel.findByTaskId(params.taskId);
        const claimedExecution = execution
          ? await AgentRunModel.claimCompletionNotification(params.taskId)
          : null;
        if (execution && !claimedExecution) {
          return;
        }
        const { chatOpsManager } = await import("./chatops-manager");
        try {
          await chatOpsManager.notifyBindingThread({
            bindingId: params.bindingId,
            threadId: params.threadId,
            agentName: params.agentName,
            text: notification,
          });
          if (claimedExecution) {
            await AgentRunModel.markCompletionNotified(claimedExecution.id);
          }
        } catch (error) {
          if (claimedExecution) {
            await AgentRunModel.releaseCompletionNotification(
              claimedExecution.id,
            );
          }
          throw error;
        }
        return;
      }

      await a2aTaskEventNotifier.wait({
        key: params.taskId,
        timeoutMs: TASK_WATCH_FALLBACK_MS,
      });
    }
  } catch (error) {
    logger.warn(
      { error, taskId: params.taskId },
      "ChatOps task completion watcher did not deliver",
    );
  }
}

const TASK_WATCH_FALLBACK_MS = 30_000;
