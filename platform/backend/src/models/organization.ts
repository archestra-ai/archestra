import { DEFAULT_THEME_ID, type OrganizationCustomFont } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  Organization,
  PublicAppearance,
  UpdateOrganization,
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
    data: Partial<UpdateOrganization>,
  ): Promise<Organization | null> {
    logger.debug(
      { id, dataKeys: Object.keys(data) },
      "OrganizationModel.patch: updating organization",
    );
    if ("logo" in data && data.logo) {
      const logo = data.logo;

      if (!logo.startsWith("data:image/png;base64,")) {
        throw new Error("Logo must be a PNG image in base64 format");
      }

      // Check size (rough estimate: base64 is ~1.33x original size)
      // 2MB * 1.33 = ~2.66MB in base64
      const maxSize = 2.66 * 1024 * 1024;
      if (logo.length > maxSize) {
        // ~2.66MB
        throw new Error("Logo must be less than 2MB");
      }
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
    return updatedOrganization || null;
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
   * Get public appearance settings (theme, logo, font) for unauthenticated pages.
   * Returns the default organization's appearance settings.
   */
  static async getPublicAppearance(): Promise<PublicAppearance> {
    const [organization] = await db
      .select({
        theme: schema.organizationsTable.theme,
        customFont: schema.organizationsTable.customFont,
        logo: schema.organizationsTable.logo,
      })
      .from(schema.organizationsTable)
      .limit(1);

    // Return defaults if no organization exists
    if (!organization) {
      return {
        theme: DEFAULT_THEME_ID,
        customFont: "lato" as OrganizationCustomFont,
        logo: null,
      };
    }

    return organization;
  }
}
export default OrganizationModel;
