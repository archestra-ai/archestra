import { and, asc, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  BatteryPackage,
  BatteryPackageFile,
  BatteryPackageSummary,
} from "@/types/openappa-batteries";

const table = schema.openappaBatteryPackagesTable;

class OpenAppaBatteryPackageModel {
  /** Every package of the organization without its files, newest version of a name first. */
  static async list(organizationId: string): Promise<BatteryPackageSummary[]> {
    return db
      .select(summary)
      .from(table)
      .where(eq(table.organizationId, organizationId))
      .orderBy(asc(table.name), desc(table.createdAt));
  }

  /** The stored versions of one battery name, newest first. */
  static async listByName(params: {
    organizationId: string;
    name: string;
  }): Promise<BatteryPackageSummary[]> {
    return db
      .select(summary)
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.name, params.name),
        ),
      )
      .orderBy(desc(table.createdAt));
  }

  /** The row an include entry spells; the bytes under a hash never change. */
  static async findByHash(params: {
    organizationId: string;
    contentHash: string;
  }): Promise<BatteryPackage | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.contentHash, params.contentHash),
        ),
      );
    return row ?? null;
  }

  /** Store a version; the same bytes again answer the stored row untouched. */
  static async insert(params: {
    organizationId: string;
    name: string;
    description: string;
    contentHash: string;
    files: BatteryPackageFile[];
  }): Promise<BatteryPackage> {
    const [inserted] = await db
      .insert(table)
      .values(params)
      .onConflictDoNothing({
        target: [table.organizationId, table.contentHash],
      })
      .returning();
    if (inserted) return inserted;
    const existing = await OpenAppaBatteryPackageModel.findByHash(params);
    if (!existing)
      throw new Error("Battery package insert conflicted with no stored row");
    return existing;
  }

  static async delete(params: {
    organizationId: string;
    contentHash: string;
  }): Promise<boolean> {
    const rows = await db
      .delete(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.contentHash, params.contentHash),
        ),
      )
      .returning({ id: table.id });
    return rows.length > 0;
  }

  static async findByIdForAudit(
    contentHash: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await OpenAppaBatteryPackageModel.findByHash({
      organizationId,
      contentHash,
    });
    return row
      ? {
          id: row.id,
          name: row.name,
          description: row.description,
          contentHash: row.contentHash,
          fileCount: row.files.length,
        }
      : null;
  }
}

export default OpenAppaBatteryPackageModel;

/** The columns a summary carries: identity and content hash, never the files. */
const summary = {
  organizationId: table.organizationId,
  name: table.name,
  description: table.description,
  contentHash: table.contentHash,
  createdAt: table.createdAt,
};
