import { and, asc, eq, notInArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  BatteryCredentialBindings,
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

  static async organizationIdsForCatalog(catalogId: string) {
    const rows = await db
      .selectDistinct({ organizationId: table.organizationId })
      .from(table)
      .where(eq(table.catalogId, catalogId));
    return rows.map((row) => row.organizationId);
  }

  static async existsForBattery(params: {
    organizationId: string;
    batteryName: string;
  }) {
    const [row] = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.batteryName, params.batteryName),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Insert unless the (organization, catalog, battery) install already exists. */
  static async createIfAbsent(params: {
    organizationId: string;
    batteryName: string;
    catalogId: string;
    enabled: boolean;
    credentialBindings: BatteryCredentialBindings;
  }): Promise<BatteryInstall | null> {
    const [row] = await db
      .insert(table)
      .values(params)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  static async update(params: {
    id: string;
    organizationId: string;
    enabled?: boolean;
    credentialBindings?: BatteryCredentialBindings;
  }): Promise<BatteryInstall | null> {
    const { id, organizationId, ...changes } = params;
    const [row] = await db
      .update(table)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(eq(table.id, id), eq(table.organizationId, organizationId)))
      .returning();
    return row ?? null;
  }

  static async delete(params: { id: string; organizationId: string }) {
    const rows = await db
      .delete(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
        ),
      )
      .returning({ id: table.id });
    return rows.length > 0;
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
