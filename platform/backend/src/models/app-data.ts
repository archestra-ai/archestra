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
  revision: number;
  /** Owner of a shared-partition key; null = collaborative / user partition. */
  owner: string | null;
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
 * Who is performing a write, for shared-partition ownership enforcement.
 * `callerCanOverrideOwner` is the caller's *policy decision* (e.g. app author
 * or admin) handed to the model; the model only enforces the mechanism.
 */
interface AppDataCaller {
  callerUserId: string;
  callerCanOverrideOwner: boolean;
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
  ): Promise<AppDataEntry | null> {
    const [row] = await db
      .select({
        key: schema.appDataTable.key,
        value: schema.appDataTable.value,
        revision: schema.appDataTable.revision,
        owner: schema.appDataTable.ownerUserId,
      })
      .from(schema.appDataTable)
      .where(
        and(partitionFilter(params), eq(schema.appDataTable.key, params.key)),
      );
    return row ?? null;
  }

  /**
   * Upsert a value. Enforces caps; a new key beyond the limit fails cleanly.
   *
   * Optimistic concurrency via `expectedRevision` (opt-in):
   *   - omitted    → last-writer-wins (unchanged); revision is still bumped.
   *   - `=== 0`    → insert-if-absent; an existing key throws `ApiError(409)`.
   *   - `> 0`      → key must exist with `revision === expectedRevision`, else
   *                  `ApiError(409)`.
   * Shared-partition ownership: a new key with `claimOwner` is owned by the
   * caller; overwriting an owned key requires being the owner or holding
   * override. All checks run under the per-app `FOR UPDATE` lock.
   */
  static async set(
    params: AppDataPartition &
      AppDataCaller & {
        key: string;
        value: unknown;
        expectedRevision?: number;
        claimOwner?: boolean;
      },
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
    // JSON null is reserved: get() returns null for an absent key, and the
    // driver layer cannot bind it anyway. Checked on the serialized form so
    // NaN/Infinity (which stringify to "null") cannot smuggle it in.
    if (serialized === "null") {
      throw new ApiError(
        400,
        "value must not be JSON null (null, NaN, and Infinity all serialize to it); delete the key to clear it",
      );
    }
    if (Buffer.byteLength(serialized, "utf8") > APP_DATA_MAX_VALUE_BYTES) {
      throw new ApiError(
        413,
        `value exceeds the ${APP_DATA_MAX_VALUE_BYTES}-byte limit`,
      );
    }
    // persist the validated snapshot: the column's toDriver would otherwise
    // re-stringify the live value, and a stateful toJSON() could store
    // something other than what the guards above saw
    const normalizedValue: unknown = JSON.parse(serialized);

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
        .select({
          id: schema.appDataTable.id,
          revision: schema.appDataTable.revision,
          owner: schema.appDataTable.ownerUserId,
        })
        .from(schema.appDataTable)
        .where(and(partitionFilter(params), eq(schema.appDataTable.key, key)))
        .limit(1);

      // Update-else-insert instead of ON CONFLICT: the partition uniqueness
      // lives in two partial indexes, which upsert conflict targets cannot
      // address; writers are already serialized by the app-row lock above.
      if (existing) {
        // insert-if-absent contract: a present key is a conflict.
        if (params.expectedRevision === 0) {
          throw new ApiError(409, `key "${key}" already exists`);
        }
        if (
          params.expectedRevision !== undefined &&
          existing.revision !== params.expectedRevision
        ) {
          throw new ApiError(
            409,
            `key "${key}" is at revision ${existing.revision}, not ${params.expectedRevision}; re-read and retry`,
          );
        }
        assertMayWriteOwnedKey({ params, owner: existing.owner, key });

        const [row] = await tx
          .update(schema.appDataTable)
          .set({
            value: normalizedValue,
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.appDataTable.id, existing.id))
          .returning(returningEntry);
        if (!row) throw new Error("failed to update app data entry");
        return row;
      }

      // key absent: a positive expectedRevision targeted a row that isn't there.
      if (
        params.expectedRevision !== undefined &&
        params.expectedRevision > 0
      ) {
        throw new ApiError(
          409,
          `key "${key}" does not exist (expected revision ${params.expectedRevision})`,
        );
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

      // Ownership is a shared-partition concept; a claimed user-partition key
      // would be redundant (already private), so never stamp an owner there.
      const ownerUserId =
        userId === null && params.claimOwner === true
          ? params.callerUserId
          : null;

      const [row] = await tx
        .insert(schema.appDataTable)
        .values({ appId, userId, key, value: normalizedValue, ownerUserId })
        .returning(returningEntry);
      if (!row) throw new Error("failed to insert app data entry");
      return row;
    });
  }

  /** All entries in a partition, ordered by key. */
  static async list(params: AppDataPartition): Promise<AppDataEntry[]> {
    return await db
      .select(returningEntry)
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
    params: AppDataPartition & AppDataCaller & { key: string },
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

      const [existing] = await tx
        .select({
          id: schema.appDataTable.id,
          owner: schema.appDataTable.ownerUserId,
        })
        .from(schema.appDataTable)
        .where(
          and(partitionFilter(params), eq(schema.appDataTable.key, params.key)),
        )
        .limit(1);
      if (!existing) return false;
      assertMayWriteOwnedKey({
        params,
        owner: existing.owner,
        key: params.key,
      });

      const rows = await tx
        .delete(schema.appDataTable)
        .where(eq(schema.appDataTable.id, existing.id))
        .returning({ id: schema.appDataTable.id });
      return rows.length > 0;
    });
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

// The column projection every read/write returns, so the AppDataEntry shape
// (key/value/revision/owner) is defined once.
const returningEntry = {
  key: schema.appDataTable.key,
  value: schema.appDataTable.value,
  revision: schema.appDataTable.revision,
  owner: schema.appDataTable.ownerUserId,
};

// Shared-partition ownership gate. An unowned key (owner null — including all
// pre-migration rows) is collaborative and writable by anyone; an owned one is
// writable only by its owner or a caller granted override. User-partition keys
// never carry an owner, so this is a no-op there.
function assertMayWriteOwnedKey(args: {
  params: AppDataCaller;
  owner: string | null;
  key: string;
}): void {
  const { owner, params, key } = args;
  if (
    owner !== null &&
    owner !== params.callerUserId &&
    !params.callerCanOverrideOwner
  ) {
    throw new ApiError(403, `key "${key}" is owned by another user`);
  }
}

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
