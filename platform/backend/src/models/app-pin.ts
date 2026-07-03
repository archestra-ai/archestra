import { and, eq, inArray, isNotNull } from "drizzle-orm";
import db, { schema } from "@/database";

/** The listing identity of an external app: one UI resource of one install. */
interface ExternalAppPinRef {
  mcpServerId: string;
  resourceUri: string;
}

/** Map key for an external pin, matching the Apps page's React key shape. */
function externalKey(ref: ExternalAppPinRef): string {
  return `${ref.mcpServerId}:${ref.resourceUri}`;
}

/**
 * Per-user pins on the unified Apps surface, the apps analogue of
 * ProjectPinModel. Pinning is personal — it never affects other members — so
 * reads and writes are always scoped to the user plus one app reference:
 * owned apps by `appId`, external apps by `(mcpServerId, resourceUri)`.
 */
class AppPinModel {
  /** Pin an owned app for a user; idempotent (re-pin refreshes `pinnedAt`). */
  static async pinOwned(params: {
    userId: string;
    appId: string;
  }): Promise<void> {
    await db
      .insert(schema.appPinsTable)
      .values({ userId: params.userId, appId: params.appId })
      .onConflictDoUpdate({
        target: [schema.appPinsTable.userId, schema.appPinsTable.appId],
        targetWhere: isNotNull(schema.appPinsTable.appId),
        set: { pinnedAt: new Date() },
      });
  }

  /** Pin an external app for a user; idempotent (re-pin refreshes `pinnedAt`). */
  static async pinExternal(
    params: { userId: string } & ExternalAppPinRef,
  ): Promise<void> {
    await db
      .insert(schema.appPinsTable)
      .values({
        userId: params.userId,
        mcpServerId: params.mcpServerId,
        resourceUri: params.resourceUri,
      })
      .onConflictDoUpdate({
        target: [
          schema.appPinsTable.userId,
          schema.appPinsTable.mcpServerId,
          schema.appPinsTable.resourceUri,
        ],
        targetWhere: isNotNull(schema.appPinsTable.mcpServerId),
        set: { pinnedAt: new Date() },
      });
  }

  /** Remove a user's pin on an owned app; idempotent (no-op when not pinned). */
  static async unpinOwned(params: {
    userId: string;
    appId: string;
  }): Promise<void> {
    await db
      .delete(schema.appPinsTable)
      .where(
        and(
          eq(schema.appPinsTable.userId, params.userId),
          eq(schema.appPinsTable.appId, params.appId),
        ),
      );
  }

  /** Remove a user's pin on an external app; idempotent. */
  static async unpinExternal(
    params: { userId: string } & ExternalAppPinRef,
  ): Promise<void> {
    await db
      .delete(schema.appPinsTable)
      .where(
        and(
          eq(schema.appPinsTable.userId, params.userId),
          eq(schema.appPinsTable.mcpServerId, params.mcpServerId),
          eq(schema.appPinsTable.resourceUri, params.resourceUri),
        ),
      );
  }

  /** `pinnedAt` per owned app for one user, in a single query (no N+1). */
  static async getPinnedAtForApps(params: {
    userId: string;
    appIds: string[];
  }): Promise<Map<string, Date>> {
    if (params.appIds.length === 0) return new Map();
    const rows = await db
      .select({
        appId: schema.appPinsTable.appId,
        pinnedAt: schema.appPinsTable.pinnedAt,
      })
      .from(schema.appPinsTable)
      .where(
        and(
          eq(schema.appPinsTable.userId, params.userId),
          inArray(schema.appPinsTable.appId, params.appIds),
        ),
      );
    const map = new Map<string, Date>();
    for (const r of rows) if (r.appId) map.set(r.appId, r.pinnedAt);
    return map;
  }

  /**
   * `pinnedAt` per external app for one user, keyed
   * `"<mcpServerId>:<resourceUri>"` (use {@link AppPinModel.externalPinKey}).
   * One query over the user's external pins, filtered to the requested refs.
   */
  static async getPinnedAtForExternalApps(params: {
    userId: string;
    refs: ExternalAppPinRef[];
  }): Promise<Map<string, Date>> {
    if (params.refs.length === 0) return new Map();
    const rows = await db
      .select({
        mcpServerId: schema.appPinsTable.mcpServerId,
        resourceUri: schema.appPinsTable.resourceUri,
        pinnedAt: schema.appPinsTable.pinnedAt,
      })
      .from(schema.appPinsTable)
      .where(
        and(
          eq(schema.appPinsTable.userId, params.userId),
          isNotNull(schema.appPinsTable.mcpServerId),
        ),
      );
    const wanted = new Set(params.refs.map(externalKey));
    const map = new Map<string, Date>();
    for (const r of rows) {
      if (r.mcpServerId === null || r.resourceUri === null) continue;
      const key = externalKey({
        mcpServerId: r.mcpServerId,
        resourceUri: r.resourceUri,
      });
      if (wanted.has(key)) map.set(key, r.pinnedAt);
    }
    return map;
  }

  /** The map key {@link AppPinModel.getPinnedAtForExternalApps} uses. */
  static externalPinKey(ref: ExternalAppPinRef): string {
    return externalKey(ref);
  }
}

export default AppPinModel;
