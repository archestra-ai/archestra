import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import JiraProvider from "@/agents/chatops/jira-provider";
import logger from "@/logging";
import ChatOpsConfigModel from "@/models/chatops-config";
import JiraChatOpsEventModel from "@/models/jira-chatops-event";
import { getHiddenMessagingChannels } from "@/services/integration-overrides";

// Store identifiers only. Canonical issue/comment content is fetched with the
// selected bot's permissions at dispatch; request headers never enter storage.
const eventSchema = z.object({
  webhookEvent: z.enum(["comment_created", "comment_updated"]),
  issue: z.object({ id: z.string().regex(/^\d+$/).max(32) }),
  comment: z.object({
    id: z.string().regex(/^\d+$/).max(32),
    updated: z
      .string()
      .max(64)
      .refine((value) => Number.isFinite(Date.parse(value))),
  }),
});

export async function enqueueJiraChatOpsEvent(params: {
  integrationId: string;
  botId: string;
  organizationId: string;
  eventId?: string;
  payload: unknown;
  headers?: Record<string, string | string[] | undefined>;
}): Promise<{ id: string; created: boolean } | null> {
  const event = eventSchema.safeParse(params.payload);
  if (!event.success) return null;
  const deliveryId =
    params.eventId ?? params.headers?.["x-atlassian-webhook-identifier"];
  return JiraChatOpsEventModel.enqueue({
    integrationId: params.integrationId,
    botId: params.botId,
    organizationId: params.organizationId,
    eventKey: `${event.data.issue.id}:${event.data.comment.id}:${new Date(event.data.comment.updated).toISOString()}`,
    deliveryId:
      typeof deliveryId === "string" ? deliveryId.slice(0, 256) : undefined,
    payload: event.data,
  });
}

export async function handleJiraChatOpsEvent(
  payload: Record<string, unknown>,
): Promise<void> {
  if (typeof payload.receiptId !== "string")
    throw new Error("Missing Jira receiptId");
  const receipt = await JiraChatOpsEventModel.claim(payload.receiptId);
  if (!receipt?.claimId) {
    const current = await JiraChatOpsEventModel.findById(payload.receiptId);
    if (current?.state === "pending" || current?.state === "processing")
      throw new Error("Jira event is already processing");
    return;
  }
  const claim = { id: receipt.id, claimId: receipt.claimId };
  try {
    // The A2A task, once attached, owns completion delivery. Never create a
    // second run after a worker dies between dispatch and queue acknowledgement.
    if (receipt.taskId) {
      await JiraChatOpsEventModel.complete(claim);
      return;
    }
    if (receipt.dispatchedAt) {
      await JiraChatOpsEventModel.hold(claim);
      logger.warn(
        { receiptId: receipt.id },
        "Jira event dispatch outcome is uncertain; receipt held for reconciliation",
      );
      return;
    }
    const config = await ChatOpsConfigModel.getJiraConfig();
    const bot = config?.bots.find(
      (candidate) => candidate.id === receipt.botId,
    );
    if (
      !config?.enabled ||
      config.id !== receipt.integrationId ||
      config.organizationId !== receipt.organizationId ||
      !bot?.enabled
    ) {
      await JiraChatOpsEventModel.complete(claim);
      return;
    }
    const provider = new JiraProvider(config, bot);
    if ((await getHiddenMessagingChannels(config.organizationId)).has("jira")) {
      await JiraChatOpsEventModel.complete(claim);
      return;
    }
    const message = await provider.parseWebhookNotification(receipt.payload);
    if (!message) {
      await JiraChatOpsEventModel.complete(claim);
      return;
    }
    message.metadata = { ...message.metadata, jiraReceiptId: receipt.id };
    await JiraChatOpsEventModel.markDispatched(claim);
    try {
      await chatOpsManager.processJiraMessage(provider, message);
      await JiraChatOpsEventModel.complete(claim);
    } catch {
      // No blind replay after a possible agent/tool side effect. An attached
      // task can continue; otherwise this receipt needs operator reconciliation.
      const current = await JiraChatOpsEventModel.findById(receipt.id);
      if (current?.taskId) await JiraChatOpsEventModel.complete(claim);
      else {
        await JiraChatOpsEventModel.hold(claim);
        logger.warn(
          { receiptId: receipt.id },
          "Jira event dispatch interrupted without an attached task; receipt held for reconciliation",
        );
      }
    }
  } finally {
    await JiraChatOpsEventModel.release(claim);
  }
}
