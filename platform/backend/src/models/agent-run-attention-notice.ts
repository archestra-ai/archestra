import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { AgentRunAttentionNotice } from "@/types/agent-run-attention-notice";
import type { AgentRunRecord } from "@/types/agent-runtime";
import TaskModel from "./task";

class AgentRunAttentionNoticeModel {
  /** Called under the run row lock, in the same transaction as its attention change. */
  static async recordTransition(
    run: AgentRunRecord,
    tx: Transaction,
  ): Promise<void> {
    const table = schema.agentRunAttentionNoticesTable;
    if (run.attentionState !== "input_required") {
      const notices = await tx
        .update(table)
        .set({ resolved: true })
        .where(and(eq(table.taskId, run.taskId), eq(table.resolved, false)))
        .returning();
      for (const notice of notices) {
        await TaskModel.create(
          {
            taskType: "agent_run_attention_notice",
            payload: { noticeId: notice.id },
          },
          tx,
        );
      }
      return;
    }
    const target = run.completionTarget;
    if (target?.type !== "chatops" || !/^\d+\.\d+$/.test(target.threadId))
      return;
    const [binding] = await tx
      .select()
      .from(schema.chatopsChannelBindingsTable)
      .where(
        and(
          eq(schema.chatopsChannelBindingsTable.id, target.bindingId),
          eq(
            schema.chatopsChannelBindingsTable.organizationId,
            run.organizationId,
          ),
          eq(schema.chatopsChannelBindingsTable.provider, "slack"),
        ),
      );
    if (!binding?.workspaceId || !/^[CDG][A-Z0-9]+$/.test(binding.channelId))
      return;
    const [notice] = await tx
      .insert(table)
      .values({
        taskId: run.taskId,
        channelId: binding.channelId,
        workspaceId: binding.workspaceId,
      })
      .returning();
    await TaskModel.create(
      {
        taskType: "agent_run_attention_notice",
        payload: { noticeId: notice.id },
      },
      tx,
    );
  }

  static async find(id: string): Promise<AgentRunAttentionNotice | null> {
    const [notice] = await db
      .select()
      .from(schema.agentRunAttentionNoticesTable)
      .where(eq(schema.agentRunAttentionNoticesTable.id, id));
    return notice ?? null;
  }

  /** A fenced, reclaimable lease serializes duplicate queue deliveries across replicas. */
  static async claim(id: string): Promise<AgentRunAttentionNotice | null> {
    const table = schema.agentRunAttentionNoticesTable;
    const [notice] = await db
      .update(table)
      .set({ claimId: randomUUID(), claimedAt: sql`now()` })
      .where(
        and(
          eq(table.id, id),
          or(
            isNull(table.claimId),
            sql`${table.claimedAt} < now() - interval '5 minutes'`,
          ),
        ),
      )
      .returning();
    return notice ?? null;
  }

  static async save(params: {
    id: string;
    claimId: string;
    changes: Partial<
      Pick<
        AgentRunAttentionNotice,
        "postAttempted" | "messageTs" | "resolvedNotified"
      >
    >;
  }): Promise<void> {
    const table = schema.agentRunAttentionNoticesTable;
    const updated = await db
      .update(table)
      .set(params.changes)
      .where(and(eq(table.id, params.id), eq(table.claimId, params.claimId)))
      .returning({ id: table.id });
    if (!updated.length) throw new Error("Runtime attention notice lease lost");
  }

  static async release(id: string, claimId: string): Promise<void> {
    const table = schema.agentRunAttentionNoticesTable;
    await db
      .update(table)
      .set({ claimId: null, claimedAt: null })
      .where(and(eq(table.id, id), eq(table.claimId, claimId)));
  }
}

export default AgentRunAttentionNoticeModel;
