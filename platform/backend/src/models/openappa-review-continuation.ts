import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ReviewContinuation } from "@/types/openappa-review-continuation";
import { ReviewContinuationSchema } from "@/types/openappa-review-continuation";

const table = schema.openappaReviewContinuationsTable;
class OpenAppaReviewContinuationModel {
  static async auditSubmissions(taskId: string) {
    return db
      .select({
        approvalId: table.approvalId,
        approved: table.approved,
        state: table.state,
      })
      .from(table)
      .where(eq(table.taskId, taskId));
  }
  static async find(
    taskId: string,
    approvalId: string,
  ): Promise<ReviewContinuation | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(and(eq(table.taskId, taskId), eq(table.approvalId, approvalId)))
      .limit(1);
    return row ? ReviewContinuationSchema.parse(row) : null;
  }
  static async enqueue(
    params: Pick<
      ReviewContinuation,
      | "organizationId"
      | "actorUserId"
      | "taskId"
      | "approvalId"
      | "approved"
      | "agentId"
      | "sessionId"
      | "origin"
    >,
  ): Promise<ReviewContinuation> {
    const [row] = await db
      .insert(table)
      .values(params)
      .onConflictDoNothing()
      .returning();
    const existing =
      row ??
      (await OpenAppaReviewContinuationModel.find(
        params.taskId,
        params.approvalId,
      ));
    if (!existing) throw new Error("Review continuation was not persisted");
    return ReviewContinuationSchema.parse(existing);
  }
  static async work(): Promise<ReviewContinuation[]> {
    const rows = await db
      .select()
      .from(table)
      .where(
        or(
          inArray(table.state, ["queued", "ready"]),
          and(
            inArray(table.state, ["resuming", "delivering"]),
            lt(table.updatedAt, new Date(Date.now() - 30_000)),
          ),
        ),
      )
      .orderBy(table.createdAt)
      .limit(10);
    return rows.map((row) => ReviewContinuationSchema.parse(row));
  }
  static async transition(params: {
    id: string;
    state: ReviewContinuation["state"];
    claimId: string | null;
    next: ReviewContinuation["state"];
    nextClaimId?: string | null;
    result?: ReviewContinuation["result"];
    failureReason?: string | null;
    deliveryEventId?: string | null;
  }): Promise<ReviewContinuation | null> {
    const [row] = await db
      .update(table)
      .set({
        state: params.next,
        updatedAt: new Date(),
        ...(params.nextClaimId !== undefined
          ? { claimId: params.nextClaimId }
          : {}),
        ...(params.next === "resuming" && params.state === "queued"
          ? { startedAt: new Date() }
          : {}),
        ...(params.next === "failed" || params.next === "delivered"
          ? { result: null }
          : params.result !== undefined
            ? { result: params.result }
            : {}),
        ...(params.failureReason
          ? { failureReason: params.failureReason }
          : {}),
        ...(params.deliveryEventId !== undefined
          ? { deliveryEventId: params.deliveryEventId }
          : {}),
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.state, params.state),
          params.claimId
            ? eq(table.claimId, params.claimId)
            : isNull(table.claimId),
        ),
      )
      .returning();
    return row ? ReviewContinuationSchema.parse(row) : null;
  }
}
export default OpenAppaReviewContinuationModel;
