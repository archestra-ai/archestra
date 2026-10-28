import { createHash } from "node:crypto";
import JiraChatOpsDeliveryModel from "@/models/jira-chatops-delivery";
import type { JiraChatOpsDeliveryMethod } from "@/types/jira-chatops-event";

/** A definitive server rejection: no comment was accepted for this attempt. */
export class JiraOutboundRejectedError extends Error {
  constructor(readonly status: 429) {
    super("Jira rejected comment delivery with HTTP 429");
    this.name = "JiraOutboundRejectedError";
  }
}

/** A lost POST response is reconciled by its comment property, never posted again. */
export async function executeJiraChatOpsOutbound(params: {
  operationKey: string;
  integrationId: string;
  botId: string;
  issueId: string;
  body: unknown;
  method?: JiraChatOpsDeliveryMethod;
  send: (operationId: string) => Promise<string>;
  reconcile: (operationId: string) => Promise<string | null>;
}): Promise<string> {
  const reservation = {
    operationKey: params.operationKey,
    integrationId: params.integrationId,
    botId: params.botId,
    issueId: params.issueId,
    bodyDigest: createHash("sha256")
      .update(stableJson(params.body))
      .digest("hex"),
    method: params.method ?? "create",
  };
  const existing = await JiraChatOpsDeliveryModel.reserve(reservation);
  if (existing.completedAt && existing.commentId) return existing.commentId;
  const operation = await JiraChatOpsDeliveryModel.claim(existing.id);
  if (!operation?.claimId) {
    const current = await JiraChatOpsDeliveryModel.reserve(reservation);
    if (current.completedAt && current.commentId) return current.commentId;
    throw new Error("Jira comment delivery is already in progress");
  }
  const claim = { id: operation.id, claimId: operation.claimId };
  try {
    let commentId: string | null = null;
    if (operation.postAttempted) {
      commentId = await params.reconcile(operation.id);
      if (!commentId && operation.method === "create") {
        throw new Error(
          "Jira comment delivery outcome is uncertain; reconciliation required",
        );
      }
    }
    if (!commentId) {
      await JiraChatOpsDeliveryModel.save({
        ...claim,
        changes: { postAttempted: true },
      });
      try {
        commentId = await params.send(operation.id);
      } catch (error) {
        if (error instanceof JiraOutboundRejectedError) {
          // An explicit write rejection can retry this same intent later. A
          // timeout, lost response or 5xx still requires reconciliation.
          await JiraChatOpsDeliveryModel.save({
            ...claim,
            changes: { postAttempted: false },
          });
        }
        throw error;
      }
    }
    await JiraChatOpsDeliveryModel.save({
      ...claim,
      changes: { commentId, completedAt: new Date() },
    });
    return commentId;
  } finally {
    await JiraChatOpsDeliveryModel.release(claim);
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
