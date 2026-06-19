import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { AppUiPermissions, AppVersion } from "@/types/app";
import type { AppSpec } from "@/types/app-spec";

/** The canonical, hashable payload of an app version. */
export interface VersionPayload {
  html: string;
  uiPermissions: AppUiPermissions | null;
}

/**
 * Deterministic JSON for hashing: object keys sorted recursively so two
 * equivalent CSP/permission objects serialize identically regardless of key
 * order. Arrays keep their order (it is author-meaningful and round-trips).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Owns immutable app version snapshots (`app_versions`). A version is forked by
 * `AppModel` whenever an edit changes the canonical payload (html +
 * permissions); this model handles the writes and the head/specific lookups
 * that resolve which artifact a runtime should serve.
 */
class AppVersionModel {
  /**
   * sha256 over the canonical payload (html + permissions). Two edits that
   * produce identical artifacts hash equal, which is how `AppModel` suppresses
   * no-op version forks.
   */
  static computeContentHash(payload: VersionPayload): string {
    const hash = createHash("sha256");
    hash.update("html\0");
    hash.update(payload.html);
    hash.update("\0permissions\0");
    hash.update(stableStringify(payload.uiPermissions ?? null));
    return hash.digest("hex");
  }

  /** Insert a version row in the caller's transaction. */
  static async insertVersion(
    tx: Transaction,
    params: {
      appId: string;
      version: number;
      payload: VersionPayload;
      contentHash: string;
      /** Spec snapshot for provenance; not hashed into `contentHash`. */
      spec?: AppSpec | null;
    },
  ): Promise<AppVersion> {
    const [version] = await tx
      .insert(schema.appVersionsTable)
      .values({
        appId: params.appId,
        version: params.version,
        html: params.payload.html,
        uiPermissions: params.payload.uiPermissions,
        contentHash: params.contentHash,
        spec: params.spec ?? null,
      })
      .returning();
    if (!version) {
      throw new Error("failed to insert app version");
    }
    return version;
  }

  static async findById(id: string): Promise<AppVersion | null> {
    const [row] = await db
      .select()
      .from(schema.appVersionsTable)
      .where(eq(schema.appVersionsTable.id, id));
    return row ?? null;
  }

  /** Resolve a specific `(app, version)` pair, e.g. the app's head version. */
  static async findByAppAndVersion(
    appId: string,
    version: number,
    tx?: Transaction,
  ): Promise<AppVersion | null> {
    const conn = tx ?? db;
    const [row] = await conn
      .select()
      .from(schema.appVersionsTable)
      .where(
        and(
          eq(schema.appVersionsTable.appId, appId),
          eq(schema.appVersionsTable.version, version),
        ),
      );
    return row ?? null;
  }

  /** All versions of an app, newest first. */
  static async listForApp(appId: string): Promise<AppVersion[]> {
    return await db
      .select()
      .from(schema.appVersionsTable)
      .where(eq(schema.appVersionsTable.appId, appId))
      .orderBy(desc(schema.appVersionsTable.version));
  }
}

export default AppVersionModel;
