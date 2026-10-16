import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import logger from "@/logging";

class SiteNotificationModel {
  static async getById(id: string) {
    logger.debug(
      { id },
      "SiteNotificationModel.getById: fetching notification",
    );
    const [notification] = await db
      .select()
      .from(schema.siteNotificationsTable)
      .where(eq(schema.siteNotificationsTable.id, id))
      .limit(1);
    return notification;
  }

  static async getActive(organizationId: string) {
    logger.debug(
      { organizationId },
      "SiteNotificationModel.getActive: fetching active notification",
    );
    const now = new Date();
    const [notification] = await db
      .select()
      .from(schema.siteNotificationsTable)
      .where(
        and(
          eq(schema.siteNotificationsTable.organizationId, organizationId),
          eq(schema.siteNotificationsTable.isActive, true),
          or(
            isNull(schema.siteNotificationsTable.expiresAt),
            gt(schema.siteNotificationsTable.expiresAt, now),
          ),
        ),
      )
      .limit(1);
    return notification;
  }

  static async getLatest(organizationId: string) {
    logger.debug(
      { organizationId },
      "SiteNotificationModel.getLatest: fetching latest notification",
    );
    const [notification] = await db
      .select()
      .from(schema.siteNotificationsTable)
      .where(eq(schema.siteNotificationsTable.organizationId, organizationId))
      .orderBy(
        desc(schema.siteNotificationsTable.updatedAt),
        desc(schema.siteNotificationsTable.createdAt),
      )
      .limit(1);
    return notification;
  }

  static async replaceCurrent(
    data: Parameters<typeof SiteNotificationModel.create>[0],
  ) {
    return withDbTransaction(async (tx) => {
      // Serialize replacements even when the organization has no active row.
      await tx
        .select({ id: schema.organizationsTable.id })
        .from(schema.organizationsTable)
        .where(eq(schema.organizationsTable.id, data.organizationId))
        .for("update");
      await SiteNotificationModel.deactivateAll(data.organizationId, tx);
      return SiteNotificationModel.create(data, tx);
    });
  }

  static async create(
    data: {
      organizationId: string;
      content: string;
      expiresAt?: Date;
      isActive?: boolean;
    },
    tx?: Transaction,
  ) {
    logger.debug(
      { data },
      "SiteNotificationModel.create: creating notification",
    );
    const id = crypto.randomUUID();
    const now = new Date();
    const [notification] = await (tx ?? db)
      .insert(schema.siteNotificationsTable)
      .values({
        id,
        organizationId: data.organizationId,
        content: data.content,
        expiresAt: data.expiresAt ?? null,
        isActive: data.isActive ?? true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return notification;
  }

  static async update(
    id: string,
    data: {
      content?: string;
      expiresAt?: Date | null;
      isActive?: boolean;
    },
  ) {
    logger.debug(
      { id, data },
      "SiteNotificationModel.update: updating notification",
    );
    const now = new Date();
    const [notification] = await db
      .update(schema.siteNotificationsTable)
      .set({
        ...data,
        updatedAt: now,
      })
      .where(eq(schema.siteNotificationsTable.id, id))
      .returning();
    return notification;
  }

  static async delete(id: string) {
    logger.debug({ id }, "SiteNotificationModel.delete: deleting notification");
    const result = await db
      .delete(schema.siteNotificationsTable)
      .where(eq(schema.siteNotificationsTable.id, id));
    return result;
  }

  static async deactivateAll(organizationId: string, tx?: Transaction) {
    logger.debug(
      { organizationId },
      "SiteNotificationModel.deactivateAll: deactivating all notifications",
    );
    const now = new Date();
    await (tx ?? db)
      .update(schema.siteNotificationsTable)
      .set({ isActive: false, updatedAt: now })
      .where(
        and(
          eq(schema.siteNotificationsTable.organizationId, organizationId),
          eq(schema.siteNotificationsTable.isActive, true),
        ),
      );
  }
}

export default SiteNotificationModel;
