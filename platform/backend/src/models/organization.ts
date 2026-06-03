import {
  DEFAULT_THEME_ID,
  type OrganizationCustomFont,
} from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, softDelete } from "@/database/soft-delete";
import logger from "@/logging";
import type {
  AppearanceSettings,
  Organization,
  OrganizationAnalyticsState,
} from "@/types";

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
   * Get the id of the first organization in the database.
   */
  static async findFirstId(): Promise<string | null> {
    const [row] = await db
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable)
      .where(notDeleted(schema.organizationsTable))
      .limit(1);
    return row?.id ?? null;
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
   * Get persistent analytics identity and event timestamps for this installation.
   */
  static async getAnalyticsState(): Promise<OrganizationAnalyticsState> {
    const organization =
      await OrganizationModel.getOrCreateDefaultOrganization();
    const [state] = await db
      .select({
        id: schema.organizationsTable.id,
        analyticsInstanceId: schema.organizationsTable.analyticsInstanceId,
        analyticsInstanceStartedAt:
          schema.organizationsTable.analyticsInstanceStartedAt,
        analyticsInstanceLastHeartbeatAt:
          schema.organizationsTable.analyticsInstanceLastHeartbeatAt,
      })
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, organization.id))
      .limit(1);

    if (!state) {
      throw new Error("Organization analytics state not found");
    }
    return state;
  }

  /**
   * Update installation analytics timestamps after successful event capture.
   */
  static async updateAnalyticsState({
    id,
    analyticsInstanceStartedAt,
    analyticsInstanceLastHeartbeatAt,
  }: {
    id: string;
    analyticsInstanceStartedAt?: Date;
    analyticsInstanceLastHeartbeatAt?: Date;
  }): Promise<void> {
    const values: Partial<
      Pick<
        OrganizationAnalyticsState,
        "analyticsInstanceStartedAt" | "analyticsInstanceLastHeartbeatAt"
      >
    > = {};

    if (analyticsInstanceStartedAt) {
      values.analyticsInstanceStartedAt = analyticsInstanceStartedAt;
    }
    if (analyticsInstanceLastHeartbeatAt) {
      values.analyticsInstanceLastHeartbeatAt =
        analyticsInstanceLastHeartbeatAt;
    }

    if (Object.keys(values).length === 0) return;

    await db
      .update(schema.organizationsTable)
      .set(values)
      .where(eq(schema.organizationsTable.id, id));
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
   * Turn on the Agent Skill tools for every organization that hasn't already
   * opted in. Run at startup when the skills feature flag is enabled so the
   * model-facing skill tools are on by default — newly created agents then
   * inherit them via `ToolModel.assignSkillToolsToAgent`, and the
   * slash-command toggle unlocks. Pre-existing agents are not retrofitted;
   * admins add skill tools to them via the agent tools editor if needed.
   * Idempotent; returns the number of orgs flipped on.
   */
  static async enableSkillToolsForAllOrgs(): Promise<number> {
    const rows = await db
      .update(schema.organizationsTable)
      .set({ skillToolsEnabled: true })
      .where(eq(schema.organizationsTable.skillToolsEnabled, false))
      .returning({ id: schema.organizationsTable.id });
    for (const { id } of rows) {
      await cacheManager.delete(getOrganizationSettingsCacheKey(id));
    }
    return rows.length;
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
   * List every organization id. Used to backfill globally-enabled built-in
   * tools (e.g. the MCP App tools, gated by `ARCHESTRA_APPS_ENABLED` rather
   * than a per-org opt-in).
   */
  static async findAllIds(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.organizationsTable.id })
      .from(schema.organizationsTable);
    return rows.map((row) => row.id);
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
      allowToolAutoAssignment: org.allowToolAutoAssignment,
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
