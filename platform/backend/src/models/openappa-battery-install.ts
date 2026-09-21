import { and, asc, eq, notInArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  BatteryInstall,
  BatteryInstallRow,
} from "@/types/openappa-batteries";

const table = schema.openappaBatteryInstallsTable;

class OpenAppaBatteryInstallModel {
  /**
   * Rewrite the organization's derived installs: every row upserted by
   * (organization, catalog, battery) so its id survives, every other row deleted.
   */
  static async replaceAll(params: {
    organizationId: string;
    rows: readonly BatteryInstallRow[];
  }): Promise<BatteryInstall[]> {
    const { organizationId, rows } = params;
    return db.transaction(async (tx) => {
      const now = new Date();
      const saved: BatteryInstall[] = [];
      for (const row of rows) {
        const [upserted] = await tx
          .insert(table)
          // `enabled` is true for every declared battery; absence is how one is off.
          .values({ organizationId, enabled: true, ...row })
          .onConflictDoUpdate({
            target: [table.organizationId, table.catalogId, table.batteryName],
            set: {
              status: row.status,
              packageHash: row.packageHash,
              lastError: row.lastError,
              credentialBindings: row.credentialBindings,
              enabled: true,
              updatedAt: now,
            },
          })
          .returning();
        saved.push(upserted);
      }
      await tx.delete(table).where(
        saved.length === 0
          ? eq(table.organizationId, organizationId)
          : and(
              eq(table.organizationId, organizationId),
              notInArray(
                table.id,
                saved.map((install) => install.id),
              ),
            ),
      );
      return saved;
    });
  }

  /**
   * A composition the runtime refused governs nothing, so every row of the
   * organization carries the refusal until a composition succeeds.
   */
  static async markRefused(params: {
    organizationId: string;
    lastError: string;
  }): Promise<void> {
    await db
      .update(table)
      .set({
        status: "refused",
        lastError: params.lastError,
        updatedAt: new Date(),
      })
      .where(eq(table.organizationId, params.organizationId));
  }

  /** Every organization holding rows, for the step that declares the legacy ones. */
  static async listOrganizationIds(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ organizationId: table.organizationId })
      .from(table)
      .orderBy(asc(table.organizationId));
    return rows.map((row) => row.organizationId);
  }

  static async list(organizationId: string): Promise<BatteryInstall[]> {
    return db
      .select()
      .from(table)
      .where(eq(table.organizationId, organizationId))
      .orderBy(asc(table.createdAt), asc(table.id));
  }

  static async find(params: {
    id: string;
    organizationId: string;
  }): Promise<BatteryInstall | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  /** Lookup by the unguessable id a composed policy's helper URL carries. */
  static async findById(id: string): Promise<BatteryInstall | null> {
    const [row] = await db.select().from(table).where(eq(table.id, id));
    return row ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await OpenAppaBatteryInstallModel.find({ id, organizationId });
    return row
      ? {
          id: row.id,
          name: row.batteryName,
          catalogId: row.catalogId,
          enabled: row.enabled,
          credentialBindings: row.credentialBindings,
        }
      : null;
  }
}

export default OpenAppaBatteryInstallModel;
