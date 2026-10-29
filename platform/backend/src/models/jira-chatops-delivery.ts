import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  JiraChatOpsDelivery,
  JiraChatOpsDeliveryMethod,
} from "@/types/jira-chatops-event";

class JiraChatOpsDeliveryModel {
  static async findByOperationKey(params: {
    integrationId: string;
    botId: string;
    operationKey: string;
  }): Promise<JiraChatOpsDelivery | null> {
    const table = schema.jiraChatOpsDeliveriesTable;
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.integrationId, params.integrationId),
          eq(table.botId, params.botId),
          eq(table.operationKey, params.operationKey),
        ),
      );
    return row ?? null;
  }

  static async findApprovalPrompt(params: {
    integrationId: string;
    botId: string;
    approvalId: string;
  }): Promise<JiraChatOpsDelivery | null> {
    const table = schema.jiraChatOpsDeliveriesTable;
    const suffix = `:${params.approvalId}`;
    const rows = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.integrationId, params.integrationId),
          eq(table.botId, params.botId),
          isNotNull(table.completedAt),
          isNotNull(table.commentId),
          sql`left(${table.operationKey}, 9) = 'approval:'`,
          sql`right(${table.operationKey}, ${suffix.length}) = ${suffix}`,
        ),
      )
      .limit(2);
    return rows.length === 1 ? rows[0] : null;
  }

  static async reserve(params: {
    integrationId: string;
    botId: string;
    issueId: string;
    operationKey: string;
    bodyDigest: string;
    method: JiraChatOpsDeliveryMethod;
  }): Promise<JiraChatOpsDelivery> {
    const table = schema.jiraChatOpsDeliveriesTable;
    await db.insert(table).values(params).onConflictDoNothing();
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.integrationId, params.integrationId),
          eq(table.botId, params.botId),
          eq(table.operationKey, params.operationKey),
        ),
      );
    if (
      !row ||
      row.issueId !== params.issueId ||
      row.bodyDigest !== params.bodyDigest ||
      row.method !== params.method
    )
      throw new Error("Jira delivery operation identity conflict");
    return row;
  }

  static async claim(id: string): Promise<JiraChatOpsDelivery | null> {
    const table = schema.jiraChatOpsDeliveriesTable;
    const [row] = await db
      .update(table)
      .set({ claimId: randomUUID(), claimedAt: sql`now()` })
      .where(
        and(
          eq(table.id, id),
          isNull(table.completedAt),
          or(
            isNull(table.claimId),
            sql`${table.claimedAt} < now() - interval '5 minutes'`,
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async save(params: {
    id: string;
    claimId: string;
    changes: Partial<
      Pick<JiraChatOpsDelivery, "postAttempted" | "commentId" | "completedAt">
    >;
  }): Promise<void> {
    const table = schema.jiraChatOpsDeliveriesTable;
    const [updated] = await db
      .update(table)
      .set(params.changes)
      .where(and(eq(table.id, params.id), eq(table.claimId, params.claimId)))
      .returning({ id: table.id });
    if (!updated) throw new Error("Jira delivery lease lost");
  }

  static async release(params: { id: string; claimId: string }): Promise<void> {
    const table = schema.jiraChatOpsDeliveriesTable;
    await db
      .update(table)
      .set({ claimId: null, claimedAt: null })
      .where(and(eq(table.id, params.id), eq(table.claimId, params.claimId)));
  }
}

export default JiraChatOpsDeliveryModel;
