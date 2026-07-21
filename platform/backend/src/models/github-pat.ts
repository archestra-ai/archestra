import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { GithubPat, InsertGithubPat, UpdateGithubPat } from "@/types";

class GithubPatModel {
  static async findByOrganization(
    organizationId: string,
  ): Promise<GithubPat[]> {
    return await db
      .select()
      .from(schema.githubPatsTable)
      .where(eq(schema.githubPatsTable.organizationId, organizationId))
      .orderBy(desc(schema.githubPatsTable.createdAt));
  }

  static async findByIdForOrganization(params: {
    id: string;
    organizationId: string;
  }): Promise<GithubPat | null> {
    const [result] = await db
      .select()
      .from(schema.githubPatsTable)
      .where(
        and(
          eq(schema.githubPatsTable.id, params.id),
          eq(schema.githubPatsTable.organizationId, params.organizationId),
        ),
      );

    return result ?? null;
  }

  static async create(data: InsertGithubPat): Promise<GithubPat> {
    const [result] = await db
      .insert(schema.githubPatsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateGithubPat>,
  ): Promise<GithubPat | null> {
    const [result] = await db
      .update(schema.githubPatsTable)
      .set(data)
      .where(eq(schema.githubPatsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const pat = await GithubPatModel.findByIdForOrganization({
      id,
      organizationId,
    });
    if (!pat) {
      return null;
    }
    // the token's secret handle must never land in audit snapshots
    const { secretId: _secretId, ...sanitized } = pat;
    return sanitized;
  }

  static async delete(id: string): Promise<boolean> {
    const rows = await db
      .delete(schema.githubPatsTable)
      .where(eq(schema.githubPatsTable.id, id))
      .returning({ id: schema.githubPatsTable.id });

    return rows.length > 0;
  }
}

export default GithubPatModel;
