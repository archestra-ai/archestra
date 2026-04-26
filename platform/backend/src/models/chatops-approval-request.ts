import crypto from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import type { IncomingChatMessage } from "@/types";

/** How long (ms) a pending approval request stays valid before expiring. */
export const CHATOPS_APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 h

export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";

export interface ChatOpsApprovalExecutionContext {
  agentId: string;
  organizationId: string;
  sessionId: string;
  source: string;
  fullMessage: string;
  userId: string;
  attachments?: unknown[];
}

export interface ChatOpsApprovalRequest {
  id: string;
  token: string;
  provider: string;
  channelId: string;
  workspaceId: string | null;
  threadId: string | null;
  approvalMessageTs: string | null;
  agentId: string;
  userId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  executionContext: ChatOpsApprovalExecutionContext;
  originalMessage: IncomingChatMessage;
  status: ApprovalStatus;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
}

class ChatOpsApprovalRequestModel {
  /**
   * Create a new pending approval request.
   * Returns the generated token (a random UUID used as the button value).
   */
  static async create(params: {
    provider: string;
    channelId: string;
    workspaceId?: string | null;
    threadId?: string | null;
    agentId: string;
    userId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    executionContext: ChatOpsApprovalExecutionContext;
    originalMessage: IncomingChatMessage;
  }): Promise<ChatOpsApprovalRequest> {
    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + CHATOPS_APPROVAL_EXPIRY_MS);

    const [record] = await db
      .insert(schema.chatopsApprovalRequestsTable)
      .values({
        token,
        provider: params.provider,
        channelId: params.channelId,
        workspaceId: params.workspaceId ?? null,
        threadId: params.threadId ?? null,
        agentId: params.agentId,
        userId: params.userId,
        toolName: params.toolName,
        toolArgs: params.toolArgs,
        executionContext:
          params.executionContext as unknown as Record<string, unknown>,
        originalMessage:
          params.originalMessage as unknown as Record<string, unknown>,
        status: "pending",
        expiresAt,
      })
      .returning();

    return record as unknown as ChatOpsApprovalRequest;
  }

  /** Fetch a request by its token, or null if not found. */
  static async findByToken(
    token: string,
  ): Promise<ChatOpsApprovalRequest | null> {
    const [record] = await db
      .select()
      .from(schema.chatopsApprovalRequestsTable)
      .where(eq(schema.chatopsApprovalRequestsTable.token, token));

    return (record as unknown as ChatOpsApprovalRequest) ?? null;
  }

  /** Transition a pending request to approved or declined. */
  static async resolve(
    token: string,
    status: "approved" | "declined",
  ): Promise<ChatOpsApprovalRequest | null> {
    const [updated] = await db
      .update(schema.chatopsApprovalRequestsTable)
      .set({ status, resolvedAt: new Date() })
      .where(
        and(
          eq(schema.chatopsApprovalRequestsTable.token, token),
          eq(schema.chatopsApprovalRequestsTable.status, "pending"),
        ),
      )
      .returning();

    return (updated as unknown as ChatOpsApprovalRequest) ?? null;
  }

  /** Store the approval-card message timestamp after posting it. */
  static async setApprovalMessageTs(
    token: string,
    approvalMessageTs: string,
  ): Promise<void> {
    await db
      .update(schema.chatopsApprovalRequestsTable)
      .set({ approvalMessageTs })
      .where(eq(schema.chatopsApprovalRequestsTable.token, token));
  }

  /** Mark all expired pending requests as "expired". */
  static async expireOldRequests(): Promise<number> {
    const result = await db
      .update(schema.chatopsApprovalRequestsTable)
      .set({ status: "expired", resolvedAt: new Date() })
      .where(
        and(
          eq(schema.chatopsApprovalRequestsTable.status, "pending"),
          lt(schema.chatopsApprovalRequestsTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: schema.chatopsApprovalRequestsTable.id });

    return result.length;
  }
}

export default ChatOpsApprovalRequestModel;
