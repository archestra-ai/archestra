import { type A2AAttachment, buildUserContent } from "../a2a-executor";
import type {
  A2AArchestraApprovalRequest,
  A2AArchestraTaskApprovalDecision,
  A2AProtocolMessage,
  A2AProtocolPart,
  A2AProtocolSendMessageRequest,
  A2AProtocolSendMessageResponse,
  A2AProtocolTask,
} from "./a2a-protocol";
import { A2AProtocolRole } from "./a2a-protocol";

export function buildSendMessageRequest(params: {
  messageId?: string;
  contextId?: string;
  taskId?: string;
  parts: A2AProtocolPart[];
}): A2AProtocolSendMessageRequest {
  return {
    message: {
      contextId: params.contextId,
      taskId: params.taskId,
      messageId: params.messageId || crypto.randomUUID(),
      role: A2AProtocolRole.User,
      parts: params.parts,
    },
  };
}

export function buildApprovalDecisionSendMessageRequest(params: {
  taskId: string;
  approvalDecisions: A2AArchestraTaskApprovalDecision[];
  parts?: A2AProtocolPart[];
}): A2AProtocolSendMessageRequest {
  return {
    message: {
      taskId: params.taskId,
      messageId: crypto.randomUUID(),
      role: A2AProtocolRole.User,
      parts: params.parts || [],
      metadata: {
        taskOps: {
          approvalDecisions: params.approvalDecisions,
        },
      },
    },
  };
}

export function buildAttachmentsMessageParts(
  attachments: A2AAttachment[],
): A2AProtocolPart[] {
  const parts = buildUserContent("", attachments).content;
  if (!Array.isArray(parts) || parts.length === 0) {
    return [];
  }

  const protocolParts: A2AProtocolPart[] = [];
  parts.forEach((part) => {
    if (part.type !== "file") {
      return;
    }
    if (part.data instanceof Uint8Array) {
      protocolParts.push({
        raw: part.data,
        mediaType: part.mediaType,
      });
      return;
    }
  });

  return protocolParts;
}

export function extractApprovalRequestsFromSendMessageResult(
  result: A2AProtocolSendMessageResponse,
): A2AArchestraApprovalRequest[] {
  if (!result?.task) {
    return [];
  }
  return extractApprovalRequestsFromTask(result.task);
}

function extractApprovalRequestsFromTask(
  task: A2AProtocolTask,
): A2AArchestraApprovalRequest[] {
  return task.metadata?.approvalRequests || [];
}

export function extractMessageFromSendMessageResult(
  result: A2AProtocolSendMessageResponse,
): A2AProtocolMessage {
  if (result?.message) {
    return result.message;
  }
  if (result?.task?.status?.message) {
    return result.task.status.message;
  }
  // This should never happen - if there are approval requests, there should be a message in the response
  // For safety in logic like ChatOps we return a dummy empty message.
  return {
    messageId: crypto.randomUUID(),
    role: A2AProtocolRole.Agent,
    parts: [],
  };
}
