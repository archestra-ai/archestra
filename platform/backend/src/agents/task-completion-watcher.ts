import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { a2aTaskEventNotifier } from "@/agents/a2a/a2a-task-event-notifier";
import { buildTaskCompletionNotification } from "@/agents/task-completion-notification";
import logger from "@/logging";
import { A2AArtifactModel, A2ATaskModel, AgentRunModel } from "@/models";
import { reportRunnerCompletionDelivery } from "@/observability/metrics/runner";
import { setSpanError } from "@/observability/tracing";
import type { AgentRunCompletionTarget, IncomingEmail } from "@/types";

export async function watchTaskCompletion(params: {
  taskId: string;
  target: AgentRunCompletionTarget;
  agentName: string;
}): Promise<void> {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      const task = await A2ATaskModel.findById(params.taskId);
      if (!task) return;

      const notification = buildTaskCompletionNotification({
        state: task.state,
        statusReason: task.statusReason,
        output: await artifactText(params.taskId),
      });
      if (notification) {
        const execution = await AgentRunModel.findByTaskId(params.taskId);
        const claimedExecution = execution
          ? await AgentRunModel.claimCompletionNotification(params.taskId)
          : null;
        if (execution && !claimedExecution) return;
        try {
          await traceCompletionDelivery({
            taskId: params.taskId,
            target: params.target,
            callback: () =>
              deliver({
                target: params.target,
                agentName: params.agentName,
                text: notification,
              }),
          });
          reportRunnerCompletionDelivery(params.target.type, "success");
          if (claimedExecution) {
            await AgentRunModel.markCompletionNotified(claimedExecution.id);
          }
        } catch (error) {
          reportRunnerCompletionDelivery(params.target.type, "failed");
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
      { error, taskId: params.taskId, targetType: params.target.type },
      "Agent task completion watcher did not deliver",
    );
  }
}

// === Internal helpers ===

async function artifactText(taskId: string): Promise<string> {
  const artifacts = await A2AArtifactModel.findByTaskId(taskId);
  return artifacts
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
}

async function deliver(params: {
  target: AgentRunCompletionTarget;
  agentName: string;
  text: string;
}): Promise<void> {
  if (params.target.type === "chatops") {
    const { chatOpsManager } = await import("@/agents/chatops/chatops-manager");
    await chatOpsManager.notifyBindingThread({
      bindingId: params.target.bindingId,
      threadId: params.target.threadId,
      agentName: params.agentName,
      text: params.text,
    });
    return;
  }

  const { getEmailProvider } = await import("@/agents/incoming-email");
  const provider = getEmailProvider();
  if (!provider || provider.providerId !== params.target.providerId) {
    throw new Error(
      `Email provider ${params.target.providerId} is not configured`,
    );
  }
  await provider.sendReply({
    originalEmail: toIncomingEmail(params.target),
    body: params.text,
    agentName: params.agentName,
  });
}

async function traceCompletionDelivery(params: {
  taskId: string;
  target: AgentRunCompletionTarget;
  callback: () => Promise<void>;
}): Promise<void> {
  const messagingSystem =
    params.target.type === "email" ? params.target.providerId : "chatops";
  return trace.getTracer("archestra").startActiveSpan(
    `send_completion ${messagingSystem}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": messagingSystem,
        "messaging.operation.name": "send_completion",
        "messaging.operation.type": "send",
        "messaging.message.id": params.taskId,
      },
    },
    async (span) => {
      try {
        await params.callback();
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        setSpanError(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

function toIncomingEmail(
  target: Extract<AgentRunCompletionTarget, { type: "email" }>,
): IncomingEmail {
  return {
    messageId: target.originalMessageId,
    fromAddress: target.fromAddress,
    toAddress: target.toAddress,
    subject: target.subject ?? "",
    body: "",
    receivedAt: new Date(),
  };
}

const TASK_WATCH_FALLBACK_MS = 30_000;
