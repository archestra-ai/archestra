import { and, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { A2AArchestraApprovalRequest } from "@/agents/a2a/a2a-protocol";
import db, { schema } from "@/database";
import type {
  A2ATaskApprovalRequest,
  InsertA2ATaskApprovalRequest,
} from "@/types";

class A2ATaskApprovalRequestModel {
  static async bulkCreate(params: {
    taskId: string;
    approvalRequests: A2AArchestraApprovalRequest[];
  }): Promise<A2ATaskApprovalRequest[]> {
    const { taskId, approvalRequests } = params;
    // `toolInput` is carried on the in-memory approval request for live approval
    // prompts but is intentionally not persisted (no column), so drop it here.
    const records = approvalRequests.map(
      ({ approvalId, toolCallId, toolName, approved, resolved }) => ({
        taskId,
        approvalId,
        toolCallId,
        toolName,
        approved,
        resolved,
      }),
    );
    return await A2ATaskApprovalRequestModel.bulkCreateRaw(records);
  }

  static async bulkCreateRaw(
    reqs: InsertA2ATaskApprovalRequest[],
  ): Promise<A2ATaskApprovalRequest[]> {
    if (reqs.length === 0) {
      return [];
    }
    return await db
      .insert(schema.a2aTaskApprovalRequestsTable)
      .values(reqs)
      .returning();
  }

  static async findById(id: string): Promise<A2ATaskApprovalRequest | null> {
    const [req] = await db
      .select()
      .from(schema.a2aTaskApprovalRequestsTable)
      .where(eq(schema.a2aTaskApprovalRequestsTable.id, id))
      .limit(1);

    return req ?? null;
  }

  static async findByTaskId(taskId: string): Promise<A2ATaskApprovalRequest[]> {
    const reqs = await db
      .select()
      .from(schema.a2aTaskApprovalRequestsTable)
      .where(eq(schema.a2aTaskApprovalRequestsTable.taskId, taskId));

    return reqs;
  }

  /** Batch variant of findByTaskId (N+1 prevention for task listings). */
  static async findByTaskIds(
    taskIds: string[],
  ): Promise<Map<string, A2ATaskApprovalRequest[]>> {
    if (taskIds.length === 0) {
      return new Map();
    }
    const reqs = await db
      .select()
      .from(schema.a2aTaskApprovalRequestsTable)
      .where(inArray(schema.a2aTaskApprovalRequestsTable.taskId, taskIds));

    const byTask = new Map<string, A2ATaskApprovalRequest[]>();
    for (const req of reqs) {
      const list = byTask.get(req.taskId) ?? [];
      list.push(req);
      byTask.set(req.taskId, list);
    }
    return byTask;
  }

  static async findByTaskIdAndApprovalId(params: {
    taskId: string;
    approvalId: string;
  }): Promise<A2ATaskApprovalRequest | null> {
    const table = schema.a2aTaskApprovalRequestsTable;
    const [req] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.taskId, params.taskId),
          eq(table.approvalId, params.approvalId),
        ),
      )
      .limit(1);
    return req ?? null;
  }

  /** Links a paused `execute_remedy_plan` call to its OpenAPPA review. */
  static async attachOpenappaReview(params: {
    taskId: string;
    approvalId: string;
    offerId: string;
    reviewText: string;
    remedyArguments: Record<string, unknown>;
    reviewerUserId: string;
    slackChannelId: string;
    slackThreadTs: string | undefined;
    expiresAt: Date;
  }): Promise<A2ATaskApprovalRequest | null> {
    const table = schema.a2aTaskApprovalRequestsTable;
    const [req] = await db
      .update(table)
      .set({
        openappaOfferId: params.offerId,
        openappaReviewText: params.reviewText,
        remedyArguments: params.remedyArguments,
        reviewerUserId: params.reviewerUserId,
        slackChannelId: params.slackChannelId,
        slackThreadTs: params.slackThreadTs ?? null,
        expiresAt: params.expiresAt,
      })
      .where(
        and(
          eq(table.taskId, params.taskId),
          eq(table.approvalId, params.approvalId),
          eq(table.resolved, false),
        ),
      )
      .returning();
    return req ?? null;
  }

  /**
   * Records the reviewer's ruling once. Returns null when the review is
   * already decided, has expired, or belongs to another reviewer.
   */
  static async recordOpenappaRuling(params: {
    id: string;
    reviewerUserId: string;
    ruling: "approve" | "deny";
    now: Date;
  }): Promise<A2ATaskApprovalRequest | null> {
    const table = schema.a2aTaskApprovalRequestsTable;
    const [req] = await db
      .update(table)
      .set({ ruling: params.ruling, decidedAt: params.now })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.reviewerUserId, params.reviewerUserId),
          isNotNull(table.openappaOfferId),
          isNull(table.ruling),
          gt(table.expiresAt, params.now),
        ),
      )
      .returning();
    return req ?? null;
  }

  /**
   * Paused tasks whose OpenAPPA review expired. A row outlives its review only
   * while the task has not resumed, so a decided row here means the resume
   * never happened.
   */
  static async findTaskIdsWithExpiredOpenappaReviews(
    now: Date,
  ): Promise<string[]> {
    const table = schema.a2aTaskApprovalRequestsTable;
    const rows = await db
      .selectDistinct({ taskId: table.taskId })
      .from(table)
      .where(and(isNotNull(table.openappaOfferId), lte(table.expiresAt, now)));
    return rows.map((row) => row.taskId);
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aTaskApprovalRequestsTable)
      .where(eq(schema.a2aTaskApprovalRequestsTable.id, id));
  }
}

export default A2ATaskApprovalRequestModel;
