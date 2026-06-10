import { and, asc, count, eq, isNull, type SQL } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { ApiError } from "@/types";
import {
  APP_DATA_KEY_MAX_LENGTH,
  APP_DATA_MAX_ENTRIES,
  APP_DATA_MAX_VALUE_BYTES,
} from "@/types/app";

/** A single App Data Store entry as surfaced to callers. */
interface AppDataEntry {
  key: string;
  value: unknown;
}

/**
 * Addresses one storage partition of one app: a viewer's private partition
 * (`userId` set) or the app-wide shared partition (`userId: null`).
 */
interface AppDataPartition {
  appId: string;
  userId: string | null;
}

/**
 * The App Data Store: partitioned key→document persistence behind the
 * `app_data_*` tools. Every method addresses exactly one partition — per-user
 * or shared — and the entry-count cap applies per partition. Enforces
 * key-length, value-size, and entry-count caps with a clean fail (a typed
 * `ApiError`, surfaced to the app), so a runaway app cannot exhaust storage.
 * The JSONB backing is an implementation detail.
 */
class AppDataModel {
  static async get(
    params: AppDataPartition & { key: string },
  ): Promise<unknown | null> {
    const [row] = await db
      .select({ value: schema.appDataTable.value })
      .from(schema.appDataTable)
      .where(
        and(partitionFilter(params), eq(schema.appDataTable.key, params.key)),
      );
    return row ? row.value : null;
  }

  /** Upsert a value. Enforces caps; a new key beyond the limit fails cleanly. */
  static async set(
    params: AppDataPartition & { key: string; value: unknown },
  ): Promise<AppDataEntry> {
    const { appId, userId, key, value } = params;
    if (key.length === 0 || key.length > APP_DATA_KEY_MAX_LENGTH) {
      throw new ApiError(
        400,
        `key must be 1-${APP_DATA_KEY_MAX_LENGTH} characters`,
      );
    }
    // JSON.stringify returns undefined for top-level undefined and throws on
    // circular/BigInt values; both mean the value is not a JSON document.
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new ApiError(400, "value must be JSON-serializable");
    }
    if (serialized === undefined) {
      throw new ApiError(400, "value must be JSON-serializable");
    }
    if (Buffer.byteLength(serialized, "utf8") > APP_DATA_MAX_VALUE_BYTES) {
      throw new ApiError(
        413,
        `value exceeds the ${APP_DATA_MAX_VALUE_BYTES}-byte limit`,
      );
    }

    return await withDbTransaction(async (tx) => {
      // Serialize concurrent writes for this app so the entry-count cap holds
      // exactly (the existence + count read below would otherwise race). Also
      // surfaces a stale/unknown appId as a clean error rather than an FK fault.
      const [appRow] = await tx
        .select({ id: schema.appsTable.id })
        .from(schema.appsTable)
        .where(eq(schema.appsTable.id, appId))
        .for("update");
      if (!appRow) {
        throw new ApiError(404, "app not found");
      }

      const [existing] = await tx
        .select({ id: schema.appDataTable.id })
        .from(schema.appDataTable)
        .where(and(partitionFilter(params), eq(schema.appDataTable.key, key)))
        .limit(1);

      // Update-else-insert instead of ON CONFLICT: the partition uniqueness
      // lives in two partial indexes, which upsert conflict targets cannot
      // address; writers are already serialized by the app-row lock above.
      if (existing) {
        const [row] = await tx
          .update(schema.appDataTable)
          .set({ value, updatedAt: new Date() })
          .where(eq(schema.appDataTable.id, existing.id))
          .returning({
            key: schema.appDataTable.key,
            value: schema.appDataTable.value,
          });
        if (!row) throw new Error("failed to update app data entry");
        return row;
      }

      const [{ value: entryCount }] = await tx
        .select({ value: count() })
        .from(schema.appDataTable)
        .where(partitionFilter(params));
      if ((entryCount ?? 0) >= APP_DATA_MAX_ENTRIES) {
        throw new ApiError(
          409,
          `app data store is full (max ${APP_DATA_MAX_ENTRIES} entries)`,
        );
      }

      const [row] = await tx
        .insert(schema.appDataTable)
        .values({ appId, userId, key, value })
        .returning({
          key: schema.appDataTable.key,
          value: schema.appDataTable.value,
        });
      if (!row) throw new Error("failed to insert app data entry");
      return row;
    });
  }

  /** All entries in a partition, ordered by key. */
  static async list(params: AppDataPartition): Promise<AppDataEntry[]> {
    return await db
      .select({
        key: schema.appDataTable.key,
        value: schema.appDataTable.value,
      })
      .from(schema.appDataTable)
      .where(partitionFilter(params))
      .orderBy(asc(schema.appDataTable.key));
  }

  /** Just the keys in a partition, ordered. */
  static async keys(params: AppDataPartition): Promise<string[]> {
    const rows = await db
      .select({ key: schema.appDataTable.key })
      .from(schema.appDataTable)
      .where(partitionFilter(params))
      .orderBy(asc(schema.appDataTable.key));
    return rows.map((r) => r.key);
  }

  static async delete(
    params: AppDataPartition & { key: string },
  ): Promise<boolean> {
    return await withDbTransaction(async (tx) => {
      // take the same app-row lock as set(): its update-else-insert reads
      // existence first, and an unserialized concurrent delete would turn the
      // follow-up update into a hard failure
      await tx
        .select({ id: schema.appsTable.id })
        .from(schema.appsTable)
        .where(eq(schema.appsTable.id, params.appId))
        .for("update");
      const rows = await tx
        .delete(schema.appDataTable)
        .where(
          and(partitionFilter(params), eq(schema.appDataTable.key, params.key)),
        )
        .returning({ id: schema.appDataTable.id });
      return rows.length > 0;
    });
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

// `eq(column, null)` compiles to `= NULL`, which matches nothing — the shared
// partition must be addressed with IS NULL.
function partitionFilter(partition: AppDataPartition): SQL | undefined {
  return and(
    eq(schema.appDataTable.appId, partition.appId),
    partition.userId === null
      ? isNull(schema.appDataTable.userId)
      : eq(schema.appDataTable.userId, partition.userId),
  );
}

export default AppDataModel;
