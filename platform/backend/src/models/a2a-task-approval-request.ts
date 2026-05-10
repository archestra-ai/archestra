import { and, eq } from "drizzle-orm";
import type {
  A2AArchestraApprovalRequest,
  A2AArchestraTaskApprovalDecision,
} from "@/agents/a2a/a2a-protocol";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
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
    const records = approvalRequests.map((req) => ({
      ...req,
      taskId,
    }));
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
      .where(
        and(
          eq(schema.a2aTaskApprovalRequestsTable.id, id),
          notDeleted(schema.a2aTaskApprovalRequestsTable),
        ),
      )
      .limit(1);

    return req ?? null;
  }

  static async findByTaskId(taskId: string): Promise<A2ATaskApprovalRequest[]> {
    const reqs = await db
      .select()
      .from(schema.a2aTaskApprovalRequestsTable)
      .where(
        and(
          eq(schema.a2aTaskApprovalRequestsTable.taskId, taskId),
          notDeleted(schema.a2aTaskApprovalRequestsTable),
        ),
      );

    return reqs;
  }

  static async updateDecision(params: {
    taskId: string;
    approvalId: string;
    approved: boolean;
  }): Promise<void> {
    const { taskId, approvalId, approved } = params;
    await db
      .update(schema.a2aTaskApprovalRequestsTable)
      .set({ approved, resolved: true, updatedAt: new Date() })
      .where(
        and(
          eq(schema.a2aTaskApprovalRequestsTable.taskId, taskId),
          eq(schema.a2aTaskApprovalRequestsTable.approvalId, approvalId),
          notDeleted(schema.a2aTaskApprovalRequestsTable),
        ),
      );
  }

  static async updateTaskApprovalDecisions(params: {
    taskId: string;
    approvalDecisions: A2AArchestraTaskApprovalDecision[];
  }): Promise<void> {
    const { taskId, approvalDecisions } = params;
    await Promise.all(
      approvalDecisions.map(async ({ approvalId, approved }) => {
        await A2ATaskApprovalRequestModel.updateDecision({
          taskId,
          approvalId,
          approved,
        });
      }),
    );
  }

  static async delete(id: string, tx?: Transaction): Promise<void> {
    await softDelete(
      tx ?? db,
      schema.a2aTaskApprovalRequestsTable,
      eq(schema.a2aTaskApprovalRequestsTable.id, id),
    );
  }

  static async hardDelete(id: string, tx?: Transaction): Promise<void> {
    await hardDelete(
      tx ?? db,
      schema.a2aTaskApprovalRequestsTable,
      eq(schema.a2aTaskApprovalRequestsTable.id, id),
    );
  }

  static async deleteByTaskId(taskId: string, tx?: Transaction): Promise<void> {
    await softDelete(
      tx ?? db,
      schema.a2aTaskApprovalRequestsTable,
      eq(schema.a2aTaskApprovalRequestsTable.taskId, taskId),
    );
  }
}

export default A2ATaskApprovalRequestModel;
