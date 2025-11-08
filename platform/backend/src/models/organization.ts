import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { Organization, UpdateOrganization } from "@/types";

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
    const [createdOrg] = await db
      .insert(schema.organizationsTable)
      .values({
        id: "default-org",
        name: "Default Organization",
        slug: "default",
        createdAt: new Date(),
      })
      .returning();

    return createdOrg;
  }

  static async patch(
    id: string,
    data: Partial<UpdateOrganization>,
  ): Promise<Organization | null> {
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

    return updatedOrganization || null;
  }

  static async getById(id: string): Promise<Organization | null> {
    const [organization] = await db
      .select()
      .from(schema.organizationsTable)
      .where(eq(schema.organizationsTable.id, id))
      .limit(1);

    return organization || null;
  }
}

export default OrganizationModel;
