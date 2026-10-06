import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { a2aTaskEventNotifier } from "@/agents/a2a/a2a-task-event-notifier";
import { buildTaskCompletionNotification } from "@/agents/task-completion-notification";
import logger from "@/logging";
import { A2AArtifactModel, A2ATaskModel, AgentRunModel } from "@/models";
import { reportAgentRunCompletionDelivery } from "@/observability/metrics/agent-runtime";
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
            target: execution?.completionTarget ?? params.target,
            callback: () =>
              deliver({
                target: execution?.completionTarget ?? params.target,
                taskId: params.taskId,
                agentName: params.agentName,
                text: notification,
              }),
          });
          reportAgentRunCompletionDelivery(params.target.type, "success");
          if (claimedExecution) {
            await AgentRunModel.markCompletionNotified(claimedExecution.id);
          }
        } catch (error) {
          reportAgentRunCompletionDelivery(params.target.type, "failed");
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
  taskId: string;
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
      deliveryId: `task:${params.taskId}:completion`,
      ...(params.target.deliveryOrigin
        ? { deliveryOrigin: params.target.deliveryOrigin }
        : {}),
      ...(params.target.appaSession
        ? { guardrailsSession: params.target.appaSession }
        : {}),
    });
    return;
  }

  const { authorizeEmailReply, backgroundSessionRequired } = await import(
    "@/openappa/native-transport"
  );
  const producing = params.target.appaSession;
  if ((await backgroundSessionRequired()) && !producing) {
    logger.warn(
      { providerId: params.target.providerId },
      "Email completion has no producing session; not sending the result",
    );
    return;
  }

  const { getEmailProvider } = await import("@/agents/incoming-email");
  const provider = getEmailProvider();
  if (!provider || provider.providerId !== params.target.providerId) {
    throw new Error(
      `Email provider ${params.target.providerId} is not configured`,
    );
  }
  const originalEmail = toIncomingEmail(params.target);
  if (!producing) {
    await provider.sendReply({
      originalEmail,
      body: params.text,
      agentName: params.agentName,
    });
    return;
  }
  const egress = await authorizeEmailReply({
    session: {
      organizationId: producing.organizationId,
      sessionId: producing.sessionId,
      ...(producing.callerId ? { callerId: producing.callerId } : {}),
    },
    messageId: params.target.originalMessageId,
    mailbox: params.target.toAddress,
    threadId: params.target.originalMessageId,
    content: params.text,
    resolveRecipients: () => {
      if (!provider.getReplyRecipients) {
        throw new Error("Reply recipients are not available");
      }
      return provider.getReplyRecipients(originalEmail);
    },
  });
  if (egress.decision === "already_delivered") return;
  if (egress.decision === "refused") {
    logger.warn(
      { messageId: params.target.originalMessageId },
      "Email completion reply was refused",
    );
    return;
  }
  try {
    await provider.sendReply({
      originalEmail,
      body: params.text,
      agentName: params.agentName,
      ...(egress.recipients ? { recipientAddresses: egress.recipients } : {}),
    });
  } catch (error) {
    if (egress.decision === "allowed") await egress.complete("failure");
    throw error;
  }
  if (egress.decision === "allowed") await egress.complete("success");
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
