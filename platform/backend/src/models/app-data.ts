import { and, asc, count, eq } from "drizzle-orm";
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
 * The App Data Store: per-app key→document persistence behind the `app_data_*`
 * tools. Enforces key-length, value-size, and per-app entry-count caps with a
 * clean fail (a typed `ApiError`, surfaced to the app), so a runaway app cannot
 * exhaust storage. The JSONB backing is an implementation detail.
 */
class AppDataModel {
  static async get(appId: string, key: string): Promise<unknown | null> {
    const [row] = await db
      .select({ value: schema.appDataTable.value })
      .from(schema.appDataTable)
      .where(
        and(
          eq(schema.appDataTable.appId, appId),
          eq(schema.appDataTable.key, key),
        ),
      );
    return row ? row.value : null;
  }

  /** Upsert a value. Enforces caps; a new key beyond the limit fails cleanly. */
  static async set(
    appId: string,
    key: string,
    value: unknown,
  ): Promise<AppDataEntry> {
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
        .where(
          and(
            eq(schema.appDataTable.appId, appId),
            eq(schema.appDataTable.key, key),
          ),
        )
        .limit(1);

      if (!existing) {
        const [{ value: entryCount }] = await tx
          .select({ value: count() })
          .from(schema.appDataTable)
          .where(eq(schema.appDataTable.appId, appId));
        if ((entryCount ?? 0) >= APP_DATA_MAX_ENTRIES) {
          throw new ApiError(
            409,
            `app data store is full (max ${APP_DATA_MAX_ENTRIES} entries)`,
          );
        }
      }

      const [row] = await tx
        .insert(schema.appDataTable)
        .values({ appId, key, value })
        .onConflictDoUpdate({
          target: [schema.appDataTable.appId, schema.appDataTable.key],
          set: { value, updatedAt: new Date() },
        })
        .returning({
          key: schema.appDataTable.key,
          value: schema.appDataTable.value,
        });
      if (!row) throw new Error("failed to upsert app data entry");
      return row;
    });
  }

  /** All entries for an app, ordered by key. */
  static async list(appId: string): Promise<AppDataEntry[]> {
    return await db
      .select({
        key: schema.appDataTable.key,
        value: schema.appDataTable.value,
      })
      .from(schema.appDataTable)
      .where(eq(schema.appDataTable.appId, appId))
      .orderBy(asc(schema.appDataTable.key));
  }

  /** Just the keys for an app, ordered. */
  static async keys(appId: string): Promise<string[]> {
    const rows = await db
      .select({ key: schema.appDataTable.key })
      .from(schema.appDataTable)
      .where(eq(schema.appDataTable.appId, appId))
      .orderBy(asc(schema.appDataTable.key));
    return rows.map((r) => r.key);
  }

  static async delete(appId: string, key: string): Promise<boolean> {
    const rows = await db
      .delete(schema.appDataTable)
      .where(
        and(
          eq(schema.appDataTable.appId, appId),
          eq(schema.appDataTable.key, key),
        ),
      )
      .returning({ id: schema.appDataTable.id });
    return rows.length > 0;
  }
}

export default AppDataModel;
