import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { BatteryPackageFile } from "@/types/openappa-batteries";

const table = schema.openappaBatteryPackagesTable;

class OpenAppaBatteryPackageModel {
  static async list(organizationId: string) {
    return db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId))
      .orderBy(table.name);
  }

  static async find(params: { organizationId: string; name: string }) {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.name, params.name),
        ),
      );
    return row ?? null;
  }

  static async upsert(params: {
    organizationId: string;
    name: string;
    description: string;
    contentHash: string;
    files: BatteryPackageFile[];
  }) {
    const { organizationId, name, ...values } = params;
    const [row] = await db
      .insert(table)
      .values({ organizationId, name, ...values })
      .onConflictDoUpdate({
        target: [table.organizationId, table.name],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  static async delete(params: { organizationId: string; name: string }) {
    const rows = await db
      .delete(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.name, params.name),
        ),
      )
      .returning({ id: table.id });
    return rows.length > 0;
  }

  static async findByIdForAudit(
    name: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await OpenAppaBatteryPackageModel.find({
      organizationId,
      name,
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
