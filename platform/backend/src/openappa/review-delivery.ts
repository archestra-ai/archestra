import {
  extractApprovalRequestsFromSendMessageResult,
  extractMessageFromSendMessageResult,
} from "@/agents/a2a/a2a-helper";
import type { A2AProtocolSendMessageResponse } from "@/agents/a2a/a2a-protocol";
import { AgentModel } from "@/models";
import { ApiError } from "@/types";
import { stripThinkingBlocks } from "@/utils/strip-thinking-blocks";
import {
  formatChatOpsReviewUrl,
  isExecuteRemedyPlanTool,
  OPENAPPA_REVIEW_NOTICE,
} from "./chatops-review";
import {
  authorizeEmailReply,
  completeAuthorizedSend,
  type TransportSession,
} from "./native-transport";
import { type ReviewOrigin, reviewEmailMessage } from "./review-origin";

/** Deliver only to the host-stamped origin, using its original security session. */
export async function deliverReviewContinuation(params: {
  origin: ReviewOrigin;
  session: TransportSession;
  agentId: string;
  reviewId: string;
  result: A2AProtocolSendMessageResponse;
  beforeSend?: (eventId?: string) => Promise<void>;
}): Promise<void> {
  if (params.origin.type === "chatops") {
    const { chatOpsManager } = await import("@/agents/chatops/chatops-manager");
    await chatOpsManager.deliverReviewContinuation({
      ...params,
      origin: params.origin,
    });
    return;
  }
  const { getEmailProvider } = await import("@/agents/incoming-email");
  const provider = getEmailProvider();
  const agent = await AgentModel.findById(params.agentId);
  if (
    !provider ||
    provider.providerId !== params.origin.provider ||
    !agent ||
    agent.organizationId !== params.session.organizationId
  ) {
    throw new ApiError(
      503,
      "The original review destination is unavailable",
      "native_delivery_lookup",
    );
  }
  const originalEmail = reviewEmailMessage(params.origin);
  const approvals = extractApprovalRequestsFromSendMessageResult(
    params.result,
  ).filter((approval) => !approval.resolved);
  const message = extractMessageFromSendMessageResult(params.result);
  const body =
    approvals.length > 0
      ? [
          OPENAPPA_REVIEW_NOTICE,
          ...approvals
            .filter((approval) => isExecuteRemedyPlanTool(approval.toolName))
            .map((approval) =>
              formatChatOpsReviewUrl({
                taskId: params.result.task?.id ?? "",
                approvalId: approval.approvalId,
              }),
            ),
        ].join("\n")
      : stripThinkingBlocks(
          (message.parts ?? []).map((part) => part.text ?? "").join("\n"),
        );
  if (!body) return;
  const decision = await authorizeEmailReply({
    session: params.session,
    messageId: originalEmail.messageId,
    deliveryId: params.reviewId,
    mailbox: originalEmail.toAddress,
    threadId: originalEmail.conversationId?.trim() || originalEmail.messageId,
    content: body,
    strictDelivery: true,
    resolveRecipients: async () => {
      if (!provider.getReplyRecipients)
        throw new Error("Reply recipients unavailable");
      return provider.getReplyRecipients(originalEmail);
    },
  });
  if (decision.decision === "already_delivered") {
    await params.beforeSend?.(decision.eventId);
    return;
  }
  if (decision.decision === "refused") {
    throw new ApiError(
      403,
      "Native review delivery was refused",
      "native_delivery_denied",
    );
  }
  await params.beforeSend?.(
    decision.decision === "allowed" ? decision.eventId : undefined,
  );
  await completeAuthorizedSend(decision, () =>
    provider.sendReply({
      originalEmail,
      body,
      agentName: agent.name,
      ...(decision.recipients
        ? { recipientAddresses: decision.recipients }
        : {}),
    }),
  );
}
