import { eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";

const pending = schema.orgTrioPendingNormalTierTable;

export type PendingNormalTier = typeof pending.$inferSelect;

/** Normal tiers the org-trio migration stashed for the startup step. */
class OrgTrioPendingNormalTierModel {
  static async findAll(): Promise<PendingNormalTier[]> {
    return db.select().from(pending);
  }

  /**
   * Locks the organization's row until `tx` ends. Null when it is gone, or
   * another replica holds it.
   */
  static async claim(
    organizationId: string,
    tx: Transaction,
  ): Promise<PendingNormalTier | null> {
    const [row] = await tx
      .select()
      .from(pending)
      .where(eq(pending.organizationId, organizationId))
      .for("update", { skipLocked: true });
    return row ?? null;
  }

  static async markMoved(
    organizationId: string,
    tx: Transaction,
  ): Promise<void> {
    await tx
      .update(pending)
      .set({ moved: true })
      .where(eq(pending.organizationId, organizationId));
  }

  static async delete(organizationId: string, tx?: Transaction): Promise<void> {
    await (tx ?? db)
      .delete(pending)
      .where(eq(pending.organizationId, organizationId));
  }
}

export default OrgTrioPendingNormalTierModel;
