import { and, desc, eq, gt } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
import type {
  InsertIncomingEmailSubscription,
  SelectIncomingEmailSubscription,
} from "@/types";

class IncomingEmailSubscriptionModel {
  /**
   * Get the currently active (non-expired) subscription
   */
  static async getActiveSubscription(): Promise<SelectIncomingEmailSubscription> {
    const [subscription] = await db
      .select()
      .from(schema.incomingEmailSubscriptionsTable)
      .where(
        and(
          gt(schema.incomingEmailSubscriptionsTable.expiresAt, new Date()),
          notDeleted(schema.incomingEmailSubscriptionsTable),
        ),
      )
      .orderBy(desc(schema.incomingEmailSubscriptionsTable.createdAt))
      .limit(1);

    return subscription;
  }

  /**
   * Get the most recent subscription regardless of expiration
   */
  static async getMostRecent(): Promise<SelectIncomingEmailSubscription> {
    const [subscription] = await db
      .select()
      .from(schema.incomingEmailSubscriptionsTable)
      .where(notDeleted(schema.incomingEmailSubscriptionsTable))
      .orderBy(desc(schema.incomingEmailSubscriptionsTable.createdAt))
      .limit(1);

    return subscription;
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
  }): Promise<SelectIncomingEmailSubscription> {
    const [updated] = await db
      .update(schema.incomingEmailSubscriptionsTable)
      .set({ expiresAt: params.expiresAt })
      .where(
        and(
          eq(schema.incomingEmailSubscriptionsTable.id, params.id),
          notDeleted(schema.incomingEmailSubscriptionsTable),
        ),
      )
      .returning();

    return updated;
  }

  /**
   * Soft-delete a subscription by ID
   */
  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.incomingEmailSubscriptionsTable,
      eq(schema.incomingEmailSubscriptionsTable.id, id),
    );
    return count > 0;
  }

  /**
   * Hard-delete a subscription. Reserved for purge flows.
   */
  static async hardDelete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      schema.incomingEmailSubscriptionsTable,
      eq(schema.incomingEmailSubscriptionsTable.id, id),
    );
    return count > 0;
  }

  /**
   * Soft-delete subscription by Graph subscription ID
   */
  static async deleteBySubscriptionId(
    subscriptionId: string,
    tx?: Transaction,
  ): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.incomingEmailSubscriptionsTable,
      eq(schema.incomingEmailSubscriptionsTable.subscriptionId, subscriptionId),
    );
    return count > 0;
  }

  /**
   * Find subscription by Graph subscription ID
   */
  static async findBySubscriptionId(
    subscriptionId: string,
  ): Promise<SelectIncomingEmailSubscription> {
    const [subscription] = await db
      .select()
      .from(schema.incomingEmailSubscriptionsTable)
      .where(
        and(
          eq(
            schema.incomingEmailSubscriptionsTable.subscriptionId,
            subscriptionId,
          ),
          notDeleted(schema.incomingEmailSubscriptionsTable),
        ),
      );

    return subscription;
  }
}

export default IncomingEmailSubscriptionModel;
