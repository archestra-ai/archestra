import { and, eq, inArray } from "drizzle-orm";
import type {
  A2AArchestraApprovalRequest,
  A2AArchestraTaskApprovalDecision,
} from "@/agents/a2a/a2a-protocol";
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

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aTaskApprovalRequestsTable)
      .where(eq(schema.a2aTaskApprovalRequestsTable.id, id));
  }
}

export default A2ATaskApprovalRequestModel;
