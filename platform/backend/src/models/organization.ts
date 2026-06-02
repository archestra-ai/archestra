import { DEFAULT_THEME_ID, type OrganizationCustomFont } from "@shared";
import { eq } from "drizzle-orm";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
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
    // Try to get existing default organization
    const existingOrg = await OrganizationModel.getFirst();

    if (existingOrg) {
      logger.debug(
        { organizationId: existingOrg.id },
        "OrganizationModel.getOrCreateDefaultOrganization: found existing organization",
      );
      return existingOrg;
    }

    // Create default organization if none exists
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

    // Guard against empty updates - Drizzle throws "No values to set" on empty objects
    if (Object.keys(data).length === 0) {
      return OrganizationModel.getById(id);
    }

    const [updatedOrganization] = await db
      .update(schema.organizationsTable)
      .set(data)
      .where(eq(schema.organizationsTable.id, id))
      .returning();

    logger.debug(
      { id, updated: !!updatedOrganization },
      "OrganizationModel.patch: completed",
    );
    await cacheManager.delete(getOrganizationSettingsCacheKey(id));
    return updatedOrganization || null;
  }

  /**
   * List ids of organizations that have opted into the Agent Skill tools
   * (`skillToolsEnabled`). Used to backfill newly introduced skill tools.
   */
  static async findIdsWithSkillToolsEnabled(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.skillToolsEnabled, true));
    return rows.map((row) => row.id);
  }

  /**
   * Get an organization by ID
   */
  static async getById(id: string): Promise<Organization | null> {
    logger.debug({ id }, "OrganizationModel.getById: fetching organization");
    const [organization] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, id))
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
      .where(eq(schema.organizationsTable.id, id))
      .limit(1);

    const slimChatErrorUi = organization?.slimChatErrorUi ?? false;
    try {
      await cacheManager.set(cacheKey, slimChatErrorUi);
    } catch {
      // Cache writes are best-effort here; tests and early startup may not
      // have the distributed cache initialized yet.
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
        iconLogoDark: schema.organizationsTable.iconLogoDark,
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
      .limit(1);

    // Return defaults if no organization exists
    if (!organization) {
      return {
        theme: DEFAULT_THEME_ID,
        customFont: "lato" as OrganizationCustomFont,
        logo: null,
        logoDark: null,
        favicon: null,
        iconLogo: null,
        iconLogoDark: null,
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
   * Compact org-wide snapshot for audit logs (large/binary branding fields omitted).
   */
  // `id` here is always the caller's own organizationId: all registry entries
  // for this fetcher use resourceIdSource="organizationContext", so id equals
  // organizationId at call time. The second parameter is unused by design —
  // the resource being audited IS the organization.
  static async findByIdForAudit(
    id: string,
    _organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const org = await OrganizationModel.getById(id);
    if (!org) return null;

    const media = (v: string | null | undefined) =>
      v && v.length > 0 ? "(set)" : null;

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      theme: org.theme,
      customFont: org.customFont,
      logo: media(org.logo),
      logoDark: media(org.logoDark),
      favicon: media(org.favicon),
      iconLogo: media(org.iconLogo),
      appName: org.appName ?? null,
      ogDescription: org.ogDescription ?? null,
      footerText: org.footerText ?? null,
      defaultUserLimitCleanupInterval:
        org.defaultUserLimitCleanupInterval ?? null,
      onboardingComplete: org.onboardingComplete,
      globalToolPolicy: org.globalToolPolicy,
      compressionScope: org.compressionScope,
      convertToolResultsToToon: org.convertToolResultsToToon,
      allowChatFileUploads: org.allowChatFileUploads,
      embeddingModel: org.embeddingModel ?? null,
      defaultLlmModel: org.defaultLlmModel ?? null,
      defaultLlmProvider: org.defaultLlmProvider ?? null,
      defaultAgentId: org.defaultAgentId ?? null,
      rerankerModel: org.rerankerModel ?? null,
      showTwoFactor: org.showTwoFactor,
      slimChatErrorUi: org.slimChatErrorUi,
      oauthAccessTokenLifetimeSeconds: org.oauthAccessTokenLifetimeSeconds,
      connectionDefaultMcpGatewayId: org.connectionDefaultMcpGatewayId ?? null,
      connectionDefaultLlmProxyId: org.connectionDefaultLlmProxyId ?? null,
      connectionDefaultClientId: org.connectionDefaultClientId ?? null,
      metadata: org.metadata ?? null,
      createdAt: org.createdAt.toISOString(),
    };
  }
}
export default OrganizationModel;

function getOrganizationSettingsCacheKey(organizationId: string) {
  return `${CacheKey.OrganizationSettings}-${organizationId}` as const;
}
