import { and, eq, sql } from "drizzle-orm";
import type { A2AExecuteResult } from "@/agents/a2a-executor";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ScheduleTriggerModel,
  ScheduleTriggerRunModel,
  UserModel,
} from "@/models";
import { metrics } from "@/observability";
import { appendLinkedScheduleRunMessagesToConversation } from "@/schedule-triggers/append-linked-run-messages";
import { scheduleTriggerConverterService } from "@/schedule-triggers/converter";
import { getReplyChannelDeliveryContext } from "@/schedule-triggers/reply-channels";
import { resolvePlaceholders } from "@/schedule-triggers/resolve-placeholders";
import type { ScheduleTriggerReplyChannel } from "@/types";
import { resolveConversationLlmSelectionForAgent } from "@/utils/llm-resolution";
import websocketService from "@/websocket";

const LINKED_CONVERSATION_AUTO_HEAL_WARNING =
  "Linked chat agent changed; task was unlinked from the chat and will continue as standalone runs.";

export async function handleScheduleTriggerRunExecution(
  payload: Record<string, unknown>,
): Promise<void> {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (!runId) {
    throw new Error("Missing runId in schedule trigger execution payload");
  }

  const triggerId =
    typeof payload.triggerId === "string" ? payload.triggerId : null;

  logger.info({ runId, triggerId }, "Schedule trigger run picked up");

  const run = await ScheduleTriggerRunModel.findById(runId);
  if (!run || run.status !== "running") {
    logger.warn(
      { runId, found: !!run, status: run?.status ?? null },
      "Schedule trigger run skipped, not in running state",
    );
    return;
  }

  const trigger = await ScheduleTriggerModel.findById(run.triggerId);
  if (!trigger) {
    logger.warn(
      { runId: run.id, triggerId: run.triggerId },
      "Schedule trigger run failed, trigger no longer exists",
    );
    await ScheduleTriggerRunModel.markCompleted({
      runId: run.id,
      status: "failed",
      error: "Trigger no longer exists",
    });
    metrics.scheduleTrigger.reportScheduleTriggerRun("unknown", "failed");
    return;
  }

  const triggerAgent = await AgentModel.findById(trigger.agentId);
  const agentName = triggerAgent?.name ?? "unknown";

  let status: "success" | "failed" = "success";
  let errorMessage: string | null = null;

  try {
    const actor = await UserModel.getById(trigger.actorUserId);
    if (!actor) {
      throw new Error("Scheduled trigger actor no longer exists");
    }

    const userIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
      userId: actor.id,
      organizationId: trigger.organizationId,
    });

    const hasAgentAccess = await AgentTeamModel.userHasAgentAccess(
      actor.id,
      trigger.agentId,
      userIsAgentAdmin,
    );
    if (!hasAgentAccess) {
      throw new Error(
        "Scheduled trigger actor no longer has access to the target agent",
      );
    }

    if (!triggerAgent) {
      throw new Error("Scheduled trigger target agent no longer exists");
    }

    if (triggerAgent.agentType !== "agent") {
      throw new Error("Scheduled trigger target must be an internal agent");
    }

    let linkedConversationId = trigger.linkedConversationId;
    const sessionId = linkedConversationId ?? `scheduled-${run.id}`;

    const resolvedMessage = resolvePlaceholders(
      trigger.messageTemplate,
      trigger.timezone,
    );

    const result = await executeA2AMessage({
      agentId: trigger.agentId,
      message: resolvedMessage,
      organizationId: trigger.organizationId,
      userId: actor.id,
      sessionId,
      conversationId: linkedConversationId ?? undefined,
      source: "schedule-trigger",
      scheduleTriggerRunId: run.id,
    });

    const deliveredTo = await deliverScheduleTriggerResult({
      runId: run.id,
      trigger: {
        id: trigger.id,
        agentId: trigger.agentId,
        name: trigger.name,
        replyChannel: trigger.replyChannel as
          | ScheduleTriggerReplyChannel
          | undefined,
      },
      actor: { id: actor.id, email: actor.email },
      resolvedMessage,
      result,
    });

    if (deliveredTo === "chat") {
      linkedConversationId =
        await ensureLinkedConversationForKeepResultsInSameChat({
          runStatus: status,
          trigger,
          triggerAgent,
          actor,
          linkedConversationId,
        });

      if (linkedConversationId) {
        const { healWarning } =
          await syncScheduleTriggerRunToLinkedConversation({
            run,
            trigger,
            actorUserId: actor.id,
            linkedConversationId,
            resolvedMessage,
            result,
          });
        if (healWarning) {
          errorMessage = healWarning;
        }
      }
    }
  } catch (error) {
    status = "failed";
    errorMessage = formatScheduleTriggerExecutionError(
      error instanceof Error ? error.message : String(error),
    );
    logger.warn(
      { runId: run.id, triggerId: run.triggerId, error: errorMessage },
      "Scheduled trigger run failed",
    );
  }

  await ScheduleTriggerRunModel.markCompleted({
    runId: run.id,
    status,
    error: errorMessage,
  });

  websocketService.notifyScheduleTriggerRunUpdated({
    organizationId: trigger.organizationId,
    triggerId: run.triggerId,
    runId: run.id,
    notifyUserId: trigger.actorUserId,
  });

  metrics.scheduleTrigger.reportScheduleTriggerRun(agentName, status);

  logger.info(
    { runId: run.id, triggerId: run.triggerId, status, error: errorMessage },
    "Schedule trigger run completed",
  );
}

function formatScheduleTriggerExecutionError(errorMessage: string): string {
  if (!errorMessage.includes("only supports Interactions API")) {
    return errorMessage;
  }

  return `${errorMessage} Scheduled triggers need a different chat-capable model for this agent. Pick a model that supports standard text and tool execution for scheduled runs, then try again.`;
}

interface ITriggerAgentLlmFields {
  llmApiKeyId: string | null;
  llmModel: string | null;
}

async function deliverScheduleTriggerResult(params: {
  runId: string;
  trigger: {
    id: string;
    agentId: string;
    name: string | null;
    replyChannel?: ScheduleTriggerReplyChannel;
  };
  actor: { id: string; email: string | null };
  resolvedMessage: string;
  result: A2AExecuteResult;
}): Promise<ScheduleTriggerReplyChannel> {
  const desiredChannel = params.trigger.replyChannel ?? "chat";

  const { availableChannels, slackDmBinding } =
    await getReplyChannelDeliveryContext({
      actorEmail: params.actor.email,
    });

  const effectiveChannel = availableChannels.includes(desiredChannel)
    ? desiredChannel
    : "chat";

  if (effectiveChannel !== desiredChannel) {
    logger.warn(
      {
        triggerId: params.trigger.id,
        runId: params.runId,
        agentId: params.trigger.agentId,
        desiredChannel,
        effectiveChannel,
        availableChannels,
      },
      "Schedule trigger reply channel unavailable; falling back to chat",
    );
  }

  if (effectiveChannel === "slack_dm" && slackDmBinding) {
    const provider = chatOpsManager.getSlackProvider();
    if (!provider) {
      logger.warn(
        {
          triggerId: params.trigger.id,
          runId: params.runId,
          desiredChannel: effectiveChannel,
        },
        "Slack provider unavailable; schedule trigger result not sent to Slack",
      );
      logger.info(
        { triggerId: params.trigger.id, runId: params.runId, channel: "chat" },
        "Schedule trigger delivered to chat",
      );
      return "chat";
    }

    await provider.sendReply({
      text: params.result.text,
      footer: `Scheduled task: ${params.trigger.name ?? params.trigger.id}`,
      originalMessage: {
        messageId: `schedule-trigger-run:${params.runId}`,
        channelId: slackDmBinding.channelId,
        workspaceId: slackDmBinding.workspaceId ?? null,
        threadId: undefined,
        senderId: params.actor.id,
        senderName: params.actor.email ?? params.actor.id,
        text: "",
        rawText: "",
        timestamp: new Date(),
        isThreadReply: false,
        metadata: {},
      },
    });

    logger.info(
      {
        triggerId: params.trigger.id,
        runId: params.runId,
        channel: "slack_dm",
        channelId: slackDmBinding.channelId,
      },
      "Schedule trigger delivered",
    );
    return "slack_dm";
  }

  logger.info(
    { triggerId: params.trigger.id, runId: params.runId, channel: "chat" },
    "Schedule trigger delivered",
  );
  return "chat";
}

/** Narrow trigger shape used by linked-conversation helpers (avoids importing `@/types` in this module). */
interface IScheduleTriggerLinkedConversationContext {
  id: string;
  organizationId: string;
  name: string | null;
  agentId: string;
  keepResultsInSameChat: boolean;
}

interface IScheduleTriggerRunRef {
  id: string;
  triggerId: string;
}

interface IEnsureLinkedConversationForKeepResultsInSameChatParams {
  runStatus: "success" | "failed";
  trigger: IScheduleTriggerLinkedConversationContext;
  triggerAgent: ITriggerAgentLlmFields;
  actor: { id: string };
  linkedConversationId: string | null;
}

async function ensureLinkedConversationForKeepResultsInSameChat(
  params: IEnsureLinkedConversationForKeepResultsInSameChatParams,
): Promise<string | null> {
  const { runStatus, trigger, triggerAgent, actor, linkedConversationId } =
    params;

  if (
    runStatus !== "success" ||
    !trigger.keepResultsInSameChat ||
    linkedConversationId
  ) {
    return linkedConversationId;
  }

  const llmSelection = await resolveConversationLlmSelectionForAgent({
    agent: {
      llmApiKeyId: triggerAgent.llmApiKeyId ?? null,
      llmModel: triggerAgent.llmModel ?? null,
    },
    organizationId: trigger.organizationId,
    userId: actor.id,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${trigger.id}, 0))`,
    );

    const [fresh] = await tx
      .select({
        linkedConversationId: schema.scheduleTriggersTable.linkedConversationId,
      })
      .from(schema.scheduleTriggersTable)
      .where(
        and(
          eq(schema.scheduleTriggersTable.id, trigger.id),
          eq(
            schema.scheduleTriggersTable.organizationId,
            trigger.organizationId,
          ),
        ),
      )
      .limit(1);

    if (fresh?.linkedConversationId) {
      return fresh.linkedConversationId;
    }

    const titleBase = trigger.name?.trim() || "Scheduled task";
    const title =
      titleBase.length > 80
        ? `${titleBase.slice(0, 77).trimEnd()}...`
        : titleBase;

    const [conversation] = await tx
      .insert(schema.conversationsTable)
      .values({
        userId: actor.id,
        organizationId: trigger.organizationId,
        agentId: trigger.agentId,
        title,
        selectedModel: llmSelection.selectedModel,
        selectedProvider: llmSelection.selectedProvider,
        chatApiKeyId: llmSelection.chatApiKeyId,
      })
      .returning({ id: schema.conversationsTable.id });

    if (!conversation?.id) {
      throw new Error(
        "Failed to create linked conversation for schedule trigger",
      );
    }

    await tx
      .update(schema.scheduleTriggersTable)
      .set({ linkedConversationId: conversation.id })
      .where(eq(schema.scheduleTriggersTable.id, trigger.id));

    return conversation.id;
  });
}

interface ISyncScheduleTriggerRunToLinkedConversationParams {
  run: IScheduleTriggerRunRef;
  trigger: IScheduleTriggerLinkedConversationContext;
  actorUserId: string;
  linkedConversationId: string;
  resolvedMessage: string;
  result: A2AExecuteResult;
}

interface ISyncScheduleTriggerRunToLinkedConversationResult {
  healWarning?: string;
}

async function syncScheduleTriggerRunToLinkedConversation(
  params: ISyncScheduleTriggerRunToLinkedConversationParams,
): Promise<ISyncScheduleTriggerRunToLinkedConversationResult> {
  const {
    run,
    trigger,
    actorUserId,
    linkedConversationId,
    resolvedMessage,
    result,
  } = params;

  const linkedAgentValid =
    await scheduleTriggerConverterService.isAgentValidForLinkedConversation({
      linkedConversationId,
      agentId: trigger.agentId,
      actorUserId,
      organizationId: trigger.organizationId,
    });

  if (!linkedAgentValid) {
    logger.warn(
      {
        runId: run.id,
        triggerId: run.triggerId,
        linkedConversationId,
        agentId: trigger.agentId,
      },
      "Schedule trigger linked conversation no longer accepts the trigger agent; auto-healing by clearing linkedConversationId",
    );

    try {
      await ScheduleTriggerModel.update(trigger.id, {
        linkedConversationId: null,
      });
    } catch (healError) {
      logger.error(
        {
          runId: run.id,
          triggerId: run.triggerId,
          error:
            healError instanceof Error ? healError.message : String(healError),
        },
        "Failed to auto-heal schedule trigger linked conversation binding",
      );
    }

    return { healWarning: LINKED_CONVERSATION_AUTO_HEAL_WARNING };
  }

  try {
    await appendLinkedScheduleRunMessagesToConversation({
      conversationId: linkedConversationId,
      messageTemplate: resolvedMessage,
      assistantText: result.text,
    });
    await ScheduleTriggerRunModel.setChatConversationId(
      run.id,
      linkedConversationId,
    );
    await websocketService.notifyConversationMessagesUpdated({
      conversationId: linkedConversationId,
    });
  } catch (syncError) {
    logger.error(
      {
        runId: run.id,
        triggerId: run.triggerId,
        linkedConversationId,
        error:
          syncError instanceof Error ? syncError.message : String(syncError),
      },
      "Schedule trigger run succeeded but failed to sync messages to linked conversation",
    );
  }

  return {};
}
