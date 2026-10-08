import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import {
  attachmentOf,
  type BatteryAttachment,
  type BatteryInstall,
  type BatteryInstallRow,
  installIdentityKey,
} from "@/types/openappa-batteries";
import { isUniqueConstraintError } from "@/utils/db";

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
        // A recompose that derives what is stored touches nothing: most
        // recomposes change one row of many.
        if (current && carries(current, values)) {
          saved.push(current);
          continue;
        }
        const [written] = current
          ? await tx
              .update(table)
              .set(values)
              .where(eq(table.id, current.id))
              .returning()
          : [
              await insertOrAdopt(tx, {
                organizationId,
                batteryName: row.batteryName,
                ...values,
              }),
            ];
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

  /** Which of these detected servers already hold a row: the proxy asks per request. */
  static async detectedIdsPresent(params: {
    organizationId: string;
    detectedIds: readonly string[];
  }): Promise<ReadonlySet<string>> {
    if (params.detectedIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ detectedId: table.detectedId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.kind, "detected"),
          inArray(table.detectedId, [...params.detectedIds]),
        ),
      );
    return new Set(rows.flatMap((row) => row.detectedId ?? []));
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

/**
 * Insert a row, or, when a writer that does not take the organization's lock
 * (one from before the lock existed) put the same identity in first, take
 * that row over: the insert runs under a savepoint so the conflict leaves the
 * transaction usable, and the row is then updated like any surviving one.
 */
async function insertOrAdopt(
  tx: Transaction,
  values: typeof table.$inferInsert & {
    kind: BatteryAttachment["kind"];
    catalogId: string | null;
    detectedId: string | null;
  },
): Promise<BatteryInstall> {
  try {
    const [inserted] = await tx.transaction((savepoint) =>
      savepoint.insert(table).values(values).returning(),
    );
    return inserted;
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const [existing] = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, values.organizationId),
          eq(table.batteryName, values.batteryName),
          values.catalogId === null
            ? isNull(table.catalogId)
            : eq(table.catalogId, values.catalogId),
          values.detectedId === null
            ? isNull(table.detectedId)
            : eq(table.detectedId, values.detectedId),
        ),
      )
      .for("update");
    if (!existing) throw error;
    const [updated] = await tx
      .update(table)
      .set(values)
      .where(eq(table.id, existing.id))
      .returning();
    return updated;
  }
}

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

/** Whether a stored row already carries everything a planned row would write. */
function carries(
  current: BatteryInstall,
  values: Pick<
    BatteryInstall,
    | "status"
    | "packageHash"
    | "lastError"
    | "credentialBindings"
    | "enabled"
    | "kind"
    | "catalogId"
    | "detectedId"
  >,
): boolean {
  return (
    current.status === values.status &&
    current.packageHash === values.packageHash &&
    current.lastError === values.lastError &&
    current.enabled === values.enabled &&
    current.kind === values.kind &&
    current.catalogId === values.catalogId &&
    current.detectedId === values.detectedId &&
    isDeepStrictEqual(current.credentialBindings, values.credentialBindings)
  );
}

function identityOf(
  row: Pick<
    BatteryInstall,
    "batteryName" | "kind" | "catalogId" | "detectedId"
  >,
): string {
  return installIdentityKey(row.batteryName, attachmentOf(row));
}
