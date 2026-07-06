import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

/**
 * Per-user record of onboarding nav items (red-dot nudges) already visited.
 * Marking is append-only and idempotent — a dot, once cleared, never returns.
 */
class UserOnboardingSeenItemModel {
  /** Mark items as seen; idempotent (keeps the original `seenAt`). */
  static async markSeen(params: {
    userId: string;
    items: string[];
  }): Promise<void> {
    if (params.items.length === 0) return;
    await db
      .insert(schema.userOnboardingSeenItemsTable)
      .values(params.items.map((item) => ({ userId: params.userId, item })))
      .onConflictDoNothing();
  }

  /** All item keys the user has seen. */
  static async getSeenItems(userId: string): Promise<string[]> {
    const rows = await db
      .select({ item: schema.userOnboardingSeenItemsTable.item })
      .from(schema.userOnboardingSeenItemsTable)
      .where(eq(schema.userOnboardingSeenItemsTable.userId, userId));
    return rows.map((row) => row.item);
  }
}

export default UserOnboardingSeenItemModel;
