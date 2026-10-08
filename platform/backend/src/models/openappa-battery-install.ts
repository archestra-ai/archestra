import { and, asc, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  attachmentKey,
  attachmentOf,
  type BatteryAttachment,
  type BatteryInstall,
  type BatteryInstallRow,
} from "@/types/openappa-batteries";

const table = schema.openappaBatteryInstallsTable;

class OpenAppaBatteryInstallModel {
  /**
   * Rewrite the organization's derived installs: a row whose (battery,
   * attachment) is still derived keeps its id, a new one is inserted, the rest
   * go. The organization's rows are locked for the transaction so two
   * recomposes cannot both insert the same identity; the writer infers no
   * unique constraint, so the next contract migration can replace it.
   */
  static async replaceAll(params: {
    organizationId: string;
    rows: readonly BatteryInstallRow[];
  }): Promise<BatteryInstall[]> {
    const { organizationId, rows } = params;
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${LOCK_SCOPE}), hashtext(${organizationId}))`,
      );
      const now = new Date();
      const existing = await tx
        .select()
        .from(table)
        .where(eq(table.organizationId, organizationId))
        .for("update");
      const byIdentity = new Map(existing.map((row) => [identityOf(row), row]));
      const saved: BatteryInstall[] = [];
      for (const row of rows) {
        const columns = attachmentColumns(row.attachment);
        const values = {
          status: row.status,
          packageHash: row.packageHash,
          lastError: row.lastError,
          credentialBindings: row.credentialBindings,
          // `enabled` is true for every declared battery; absence is how one is off.
          enabled: true,
          updatedAt: now,
          ...columns,
        };
        const current = byIdentity.get(
          identityOf({ batteryName: row.batteryName, ...columns }),
        );
        const [written] = current
          ? await tx
              .update(table)
              .set(values)
              .where(eq(table.id, current.id))
              .returning()
          : await tx
              .insert(table)
              .values({
                organizationId,
                batteryName: row.batteryName,
                ...values,
              })
              .returning();
        saved.push(written);
      }
      const kept = new Set(saved.map((row) => row.id));
      const stale = existing.filter((row) => !kept.has(row.id));
      if (stale.length > 0)
        await tx.delete(table).where(
          inArray(
            table.id,
            stale.map((row) => row.id),
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
          attachment: attachmentOf(row),
          enabled: row.enabled,
          credentialBindings: row.credentialBindings,
        }
      : null;
  }
}

export default OpenAppaBatteryInstallModel;

// === Internal helpers ===

/** Keys the per-organization advisory lock apart from any other use of `hashtext`. */
const LOCK_SCOPE = "openappa_battery_installs";

function attachmentColumns(attachment: BatteryAttachment): {
  kind: BatteryAttachment["kind"];
  catalogId: string | null;
  detectedId: string | null;
} {
  switch (attachment.kind) {
    case "catalog":
      return {
        kind: "catalog",
        catalogId: attachment.catalogId,
        detectedId: null,
      };
    case "detected":
      return {
        kind: "detected",
        catalogId: null,
        detectedId: attachment.detectedId,
      };
    case "organization":
      return { kind: "organization", catalogId: null, detectedId: null };
  }
}

function identityOf(
  row: Pick<
    BatteryInstall,
    "batteryName" | "kind" | "catalogId" | "detectedId"
  >,
): string {
  return `${row.batteryName}\u0000${attachmentKey(attachmentOf(row))}`;
}
