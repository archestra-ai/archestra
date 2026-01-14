import { desc, eq, gt } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertIncomingEmailSubscription,
  SelectIncomingEmailSubscription,
} from "@/types";

class IncomingEmailSubscriptionModel {
  /**
   * Get the currently active (non-expired) subscription
   */
  static async getActiveSubscription(): Promise<SelectIncomingEmailSubscription | null> {
    const [subscription] = await db
      .select()
      .from(schema.incomingEmailSubscriptionsTable)
      .where(gt(schema.incomingEmailSubscriptionsTable.expiresAt, new Date()))
      .orderBy(desc(schema.incomingEmailSubscriptionsTable.createdAt))
      .limit(1);

    return subscription ?? null;
  }

  /**
   * Get the most recent subscription regardless of expiration
   */
  static async getMostRecent(): Promise<SelectIncomingEmailSubscription | null> {
    const [subscription] = await db
      .select()
      .from(schema.incomingEmailSubscriptionsTable)
      .orderBy(desc(schema.incomingEmailSubscriptionsTable.createdAt))
      .limit(1);

    return subscription ?? null;
  }

  /**
   * Create a new subscription record
   */
  static async create(
    data: InsertIncomingEmailSubscription,
  ): Promise<SelectIncomingEmailSubscription> {
    const [subscription] = await db
      .insert(schema.incomingEmailSubscriptionsTable)
      .values(data)
      .returning();

    return subscription;
  }

  /**
   * Update subscription expiration (after renewal)
   */
  static async updateExpiry(params: {
    id: string;
    expiresAt: Date;
  }): Promise<SelectIncomingEmailSubscription | null> {
    const [updated] = await db
      .update(schema.incomingEmailSubscriptionsTable)
      .set({ expiresAt: params.expiresAt })
      .where(eq(schema.incomingEmailSubscriptionsTable.id, params.id))
      .returning();

    return updated ?? null;
  }

  /**
   * Delete a subscription by ID
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.incomingEmailSubscriptionsTable)
      .where(eq(schema.incomingEmailSubscriptionsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Delete subscription by Graph subscription ID
   */
  static async deleteBySubscriptionId(
    subscriptionId: string,
  ): Promise<boolean> {
    const result = await db
      .delete(schema.incomingEmailSubscriptionsTable)
      .where(
        eq(
          schema.incomingEmailSubscriptionsTable.subscriptionId,
          subscriptionId,
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Find subscription by Graph subscription ID
   */
  static async findBySubscriptionId(
    subscriptionId: string,
  ): Promise<SelectIncomingEmailSubscription | null> {
    const [subscription] = await db
      .select()
      .from(schema.incomingEmailSubscriptionsTable)
      .where(
        eq(
          schema.incomingEmailSubscriptionsTable.subscriptionId,
          subscriptionId,
        ),
      );

    return subscription ?? null;
  }
}

export default IncomingEmailSubscriptionModel;
