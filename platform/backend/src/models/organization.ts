import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertOrganization,
  Organization,
  UpdateOrganization,
} from "@/types";

class OrganizationModel {
  static async getOrCreateDefaultOrganization(): Promise<Organization> {
    // Try to get existing default organization
    const [existingOrg] = await db
      .select()
      .from(schema.organizationsTable)
      .limit(1);

    if (existingOrg) {
      return existingOrg;
    }

    // Create default organization if none exists
    const defaultOrgData: InsertOrganization = {
      id: "default-org",
      name: "Default Organization",
      slug: "default",
      createdAt: new Date(),
      hasSeededMcpCatalog: false,
    };

    const [createdOrg] = await db
      .insert(schema.organizationsTable)
      .values(defaultOrgData)
      .returning();

    return createdOrg;
  }

  static async update(
    id: string,
    organization: Partial<UpdateOrganization>,
  ): Promise<Organization | null> {
    const [updatedOrganization] = await db
      .update(schema.organizationsTable)
      .set(organization)
      .where(eq(schema.organizationsTable.id, id))
      .returning();

    return updatedOrganization || null;
  }

  static async updateSeededMcpCatalogFlag(
    id: string,
    hasSeeded: boolean,
  ): Promise<Organization | null> {
    return OrganizationModel.update(id, { hasSeededMcpCatalog: hasSeeded });
  }
}

export default OrganizationModel;
