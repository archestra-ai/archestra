import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  GithubAppConfig,
  InsertGithubAppConfig,
  UpdateGithubAppConfig,
} from "@/types";

class GithubAppConfigModel {
  static async findByOrganization(
    organizationId: string,
  ): Promise<GithubAppConfig[]> {
    return await db
      .select()
      .from(schema.githubAppConfigsTable)
      .where(eq(schema.githubAppConfigsTable.organizationId, organizationId))
      .orderBy(desc(schema.githubAppConfigsTable.createdAt));
  }

  static async findByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<GithubAppConfig | null> {
    const [result] = await db
      .select()
      .from(schema.githubAppConfigsTable)
      .where(
        and(
          eq(schema.githubAppConfigsTable.id, params.id),
          eq(
            schema.githubAppConfigsTable.organizationId,
            params.organizationId,
          ),
        ),
      );

    return result ?? null;
  }

  static async create(data: InsertGithubAppConfig): Promise<GithubAppConfig> {
    const [result] = await db
      .insert(schema.githubAppConfigsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateGithubAppConfig>,
  ): Promise<GithubAppConfig | null> {
    const [result] = await db
      .update(schema.githubAppConfigsTable)
      .set(data)
      .where(eq(schema.githubAppConfigsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const config = await GithubAppConfigModel.findByIdForOrganization({
      id,
      organizationId,
    });
    if (!config) {
      return null;
    }
    // the private-key secret handle must never land in audit snapshots
    const { secretId: _secretId, ...sanitized } = config;
    return sanitized;
  }

  static async delete(id: string): Promise<boolean> {
    const rows = await db
      .delete(schema.githubAppConfigsTable)
      .where(eq(schema.githubAppConfigsTable.id, id))
      .returning({ id: schema.githubAppConfigsTable.id });

    return rows.length > 0;
  }
}

export default GithubAppConfigModel;
