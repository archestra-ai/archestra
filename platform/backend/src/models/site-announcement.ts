import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";

class SiteAnnouncementModel {
  static async getForOrganization(organizationId: string) {
    const [row] = await db
      .select()
      .from(schema.siteAnnouncementsTable)
      .where(eq(schema.siteAnnouncementsTable.organizationId, organizationId))
      .limit(1);

    return row ?? null;
  }

  static async getActiveForOrganization(organizationId: string) {
    const now = new Date();
    const [row] = await db
      .select()
      .from(schema.siteAnnouncementsTable)
      .where(
        and(
          eq(schema.siteAnnouncementsTable.organizationId, organizationId),
          or(
            isNull(schema.siteAnnouncementsTable.expiresAt),
            gt(schema.siteAnnouncementsTable.expiresAt, now),
          ),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  static async upsert(params: {
    organizationId: string;
    markdown: string;
    expiresAt: Date | null;
    userId: string;
  }) {
    const [row] = await db
      .insert(schema.siteAnnouncementsTable)
      .values({
        organizationId: params.organizationId,
        markdown: params.markdown,
        expiresAt: params.expiresAt,
        createdByUserId: params.userId,
        updatedByUserId: params.userId,
      })
      .onConflictDoUpdate({
        target: schema.siteAnnouncementsTable.organizationId,
        set: {
          markdown: params.markdown,
          expiresAt: params.expiresAt,
          updatedByUserId: params.userId,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    return row;
  }

  static async delete(organizationId: string): Promise<boolean> {
    const deleted = await db
      .delete(schema.siteAnnouncementsTable)
      .where(eq(schema.siteAnnouncementsTable.organizationId, organizationId))
      .returning({ id: schema.siteAnnouncementsTable.id });

    return deleted.length > 0;
  }
}

export default SiteAnnouncementModel;
