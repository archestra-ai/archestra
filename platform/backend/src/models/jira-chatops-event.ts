import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { JiraChatOpsEvent } from "@/types/jira-chatops-event";
import TaskModel from "./task";

class JiraChatOpsEventModel {
  static async enqueue(params: {
    integrationId: string;
    botId: string;
    organizationId: string;
    eventKey: string;
    deliveryId?: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string; created: boolean }> {
    const table = schema.jiraChatOpsEventsTable;
    return db.transaction(async (tx) => {
      const [created] = await tx
        .insert(table)
        .values(params)
        .onConflictDoNothing()
        .returning({ id: table.id });
      if (created) {
        await TaskModel.create(
          {
            taskType: "jira_chatops_event",
            payload: { receiptId: created.id },
          },
          tx,
        );
        return { id: created.id, created: true };
      }
      const [existing] = await tx
        .select({ id: table.id })
        .from(table)
        .where(
          and(
            eq(table.integrationId, params.integrationId),
            eq(table.botId, params.botId),
            eq(table.eventKey, params.eventKey),
          ),
        );
      if (!existing) throw new Error("Jira event receipt unavailable");
      return { id: existing.id, created: false };
    });
  }

  static async findById(id: string): Promise<JiraChatOpsEvent | null> {
    const [row] = await db
      .select()
      .from(schema.jiraChatOpsEventsTable)
      .where(eq(schema.jiraChatOpsEventsTable.id, id));
    return row ?? null;
  }

  static async claim(id: string): Promise<JiraChatOpsEvent | null> {
    const table = schema.jiraChatOpsEventsTable;
    const [row] = await db
      .update(table)
      .set({
        state: "processing",
        claimId: randomUUID(),
        claimedAt: sql`now()`,
      })
      .where(
        and(
          eq(table.id, id),
          or(eq(table.state, "pending"), eq(table.state, "processing")),
          or(
            isNull(table.claimId),
            sql`${table.claimedAt} < now() - interval '5 minutes'`,
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async markDispatched(params: {
    id: string;
    claimId: string;
  }): Promise<void> {
    await JiraChatOpsEventModel.save(params, { dispatchedAt: new Date() });
  }

  /** Persisted at task creation, before an interrupted delivery could launch again. */
  static async attachTask(params: {
    receiptId: string;
    taskId: string;
  }): Promise<void> {
    const table = schema.jiraChatOpsEventsTable;
    const [updated] = await db
      .update(table)
      .set({ taskId: params.taskId })
      .where(
        and(
          eq(table.id, params.receiptId),
          or(isNull(table.taskId), eq(table.taskId, params.taskId)),
        ),
      )
      .returning({ id: table.id });
    if (!updated) throw new Error("Jira event task association conflict");
  }

  static async complete(params: {
    id: string;
    claimId: string;
  }): Promise<void> {
    await JiraChatOpsEventModel.save(params, {
      state: "completed",
      completedAt: new Date(),
      payload: {},
    });
  }

  static async hold(params: { id: string; claimId: string }): Promise<void> {
    await JiraChatOpsEventModel.save(params, { state: "held" });
  }

  static async release(params: { id: string; claimId: string }): Promise<void> {
    const table = schema.jiraChatOpsEventsTable;
    await db
      .update(table)
      .set({ claimId: null, claimedAt: null })
      .where(and(eq(table.id, params.id), eq(table.claimId, params.claimId)));
  }

  private static async save(
    params: { id: string; claimId: string },
    changes: Partial<
      Pick<
        JiraChatOpsEvent,
        "state" | "dispatchedAt" | "completedAt" | "payload"
      >
    >,
  ): Promise<void> {
    const table = schema.jiraChatOpsEventsTable;
    const [updated] = await db
      .update(table)
      .set(changes)
      .where(and(eq(table.id, params.id), eq(table.claimId, params.claimId)))
      .returning({ id: table.id });
    if (!updated) throw new Error("Jira event lease lost");
  }
}

export default JiraChatOpsEventModel;
