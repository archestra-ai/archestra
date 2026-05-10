import { DEFAULT_THEME_ID, type OrganizationCustomFont } from "@shared";
import { and, eq } from "drizzle-orm";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
import logger from "@/logging";
import type { AppearanceSettings, Organization } from "@/types";

class OrganizationModel {
  /**
   * Get the first organization in the database (fallback for various operations)
   */
  static async getFirst(): Promise<Organization | null> {
    logger.debug("OrganizationModel.getFirst: fetching first organization");
    const [organization] = await db
      .select()
      .from(schema.organizationsTable)
      .where(notDeleted(schema.organizationsTable))
      .limit(1);
    logger.debug(
      { found: !!organization },
      "OrganizationModel.getFirst: completed",
    );
    return organization || null;
  }

  /**
   * Get or create the default organization
   */
  static async getOrCreateDefaultOrganization(): Promise<Organization> {
    logger.debug("OrganizationModel.getOrCreateDefaultOrganization: starting");
    const existingOrg = await OrganizationModel.getFirst();

    if (existingOrg) {
      logger.debug(
        { organizationId: existingOrg.id },
        "OrganizationModel.getOrCreateDefaultOrganization: found existing organization",
      );
      return existingOrg;
    }

    logger.debug(
      "OrganizationModel.getOrCreateDefaultOrganization: creating default organization",
    );
    const [createdOrg] = await db
      .insert(schema.organizationsTable)
      .values({
        id: "default-org",
        name: "Default Organization",
        slug: "default",
        createdAt: new Date(),
      })
      .returning();

    logger.debug(
      { organizationId: createdOrg.id },
      "OrganizationModel.getOrCreateDefaultOrganization: completed",
    );
    return createdOrg;
  }

  /**
   * Update an organization with partial data
   */
  static async patch(
    id: string,
    data: Partial<Organization>,
  ): Promise<Organization | null> {
    logger.debug(
      { id, dataKeys: Object.keys(data) },
      "OrganizationModel.patch: updating organization",
    );

    if (Object.keys(data).length === 0) {
      return OrganizationModel.getById(id);
    }

    const [updatedOrganization] = await db
      .update(schema.organizationsTable)
      .set(data)
      .where(
        and(
          eq(schema.organizationsTable.id, id),
          notDeleted(schema.organizationsTable),
        ),
      )
      .returning();

    logger.debug(
      { id, updated: !!updatedOrganization },
      "OrganizationModel.patch: completed",
    );
    await cacheManager.delete(getOrganizationSettingsCacheKey(id));
    return updatedOrganization || null;
  }

  /**
   * Get an organization by ID
   */
  static async getById(
    id: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<Organization | null> {
    logger.debug({ id }, "OrganizationModel.getById: fetching organization");
    const conditions = [eq(schema.organizationsTable.id, id)];
    if (!opts.includeDeleted) {
      conditions.push(notDeleted(schema.organizationsTable));
    }
    const [organization] = await db
      .select()
      .from(schema.organizationsTable)
      .where(and(...conditions))
      .limit(1);

    logger.debug(
      { id, found: !!organization },
      "OrganizationModel.getById: completed",
    );
    return organization || null;
  }

  /**
   * Get the slim chat error UI setting with a short-lived cache.
   */
  static async getSlimChatErrorUi(id: string): Promise<boolean> {
    const cacheKey = getOrganizationSettingsCacheKey(id);
    const cached = await cacheManager.get<boolean>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const [organization] = await db
      .select({
        slimChatErrorUi: schema.organizationsTable.slimChatErrorUi,
      })
      .from(schema.organizationsTable)
      .where(
        and(
          eq(schema.organizationsTable.id, id),
          notDeleted(schema.organizationsTable),
        ),
      )
      .limit(1);

    const slimChatErrorUi = organization?.slimChatErrorUi ?? false;
    try {
      await cacheManager.set(cacheKey, slimChatErrorUi);
    } catch {
      // Cache writes are best-effort; tests and early startup may not have
      // the distributed cache initialized yet.
    }
    return slimChatErrorUi;
  }

  /**
   * Get appearance settings
   * Returns default appearance settings if no organization exists.
   */
  static async getAppearanceSettings(): Promise<AppearanceSettings> {
    const [organization] = await db
      .select({
        theme: schema.organizationsTable.theme,
        customFont: schema.organizationsTable.customFont,
        logo: schema.organizationsTable.logo,
        logoDark: schema.organizationsTable.logoDark,
        favicon: schema.organizationsTable.favicon,
        iconLogo: schema.organizationsTable.iconLogo,
        appName: schema.organizationsTable.appName,
        ogDescription: schema.organizationsTable.ogDescription,
        footerText: schema.organizationsTable.footerText,
        chatLinks: schema.organizationsTable.chatLinks,
        onboardingWizard: schema.organizationsTable.onboardingWizard,
        chatErrorSupportMessage:
          schema.organizationsTable.chatErrorSupportMessage,
        slimChatErrorUi: schema.organizationsTable.slimChatErrorUi,
        animateChatPlaceholders:
          schema.organizationsTable.animateChatPlaceholders,
      })
      .from(schema.organizationsTable)
      .where(notDeleted(schema.organizationsTable))
      .limit(1);

    if (!organization) {
      return {
        theme: DEFAULT_THEME_ID,
        customFont: "lato" as OrganizationCustomFont,
        logo: null,
        logoDark: null,
        favicon: null,
        iconLogo: null,
        appName: null,
        ogDescription: null,
        footerText: null,
        chatLinks: null,
        onboardingWizard: null,
        chatErrorSupportMessage: null,
        slimChatErrorUi: false,
        animateChatPlaceholders: true,
      };
    }

    return organization;
  }

  /**
   * Soft-delete an organization. Tombstones the slug so it can be reused
   * after deletion without weakening the global uniqueness invariant.
   */
  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const dbOrTx = tx ?? db;
    const [current] = await dbOrTx
      .select({ slug: schema.organizationsTable.slug })
      .from(schema.organizationsTable)
      .where(
        and(
          eq(schema.organizationsTable.id, id),
          notDeleted(schema.organizationsTable),
        ),
      );
    if (!current) return false;

    await dbOrTx
      .update(schema.organizationsTable)
      .set({ slug: makeSlugTombstone(current.slug) })
      .where(eq(schema.organizationsTable.id, id));

    const count = await softDelete(
      dbOrTx,
      schema.organizationsTable,
      eq(schema.organizationsTable.id, id),
    );
    await cacheManager.delete(getOrganizationSettingsCacheKey(id));
    return count > 0;
  }

  /**
   * Physically remove an organization. Reserved for purge flows and test
   * cleanup — application code should call `delete` instead.
   */
  static async hardDelete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
      schema.organizationsTable,
      eq(schema.organizationsTable.id, id),
    );
    await cacheManager.delete(getOrganizationSettingsCacheKey(id));
    return count > 0;
  }
}
export default OrganizationModel;

function getOrganizationSettingsCacheKey(organizationId: string) {
  return `${CacheKey.OrganizationSettings}-${organizationId}` as const;
}

function makeSlugTombstone(originalSlug: string): string {
  return `deleted-${crypto.randomUUID().slice(0, 8)}-${originalSlug}`;
}
